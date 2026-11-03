import { Prisma } from '@prisma/client'
import { hashToken, issueGrant, rotateGrant } from '@/services/auth/refreshGrant.service'
import * as successorCrypto from '@/services/auth/successorCrypto'
import { cifrarSucesor, descifrarSucesor } from '@/services/auth/successorCrypto'
import * as sessionService from '@/services/auth/session.service'
import * as sessionCache from '@/services/auth/sessionCache'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    refreshGrant: { create: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('@/services/auth/session.service')
jest.mock('@/services/auth/sessionCache')

const tx = { $queryRaw: jest.fn(), refreshGrant: { create: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() } }
const prismaMock = prisma as unknown as {
  refreshGrant: { create: jest.Mock; updateMany: jest.Mock; findUnique: jest.Mock }
  $transaction: jest.Mock
}

const MIN = 60_000
const EN_UN_DIA = 24 * 60 * MIN

beforeEach(() => {
  // `mockReset` (no `clearAllMocks`): las colas de `mockResolvedValueOnce` de una prueba no deben llegar a la siguiente.
  for (const m of [tx.$queryRaw, ...Object.values(tx.refreshGrant), ...Object.values(prismaMock.refreshGrant), prismaMock.$transaction]) {
    m.mockReset()
  }
  jest.clearAllMocks()
  prismaMock.$transaction.mockImplementation(async (fn: any) => fn(tx))
  tx.refreshGrant.updateMany.mockResolvedValue({ count: 1 })
})

/** Un grant vigente, sin consumir: el caso de cada renovación normal. */
function grantVigente(over: Record<string, unknown> = {}) {
  return {
    id: 'g1',
    sessionId: 's1',
    familyId: 'f1',
    tokenHash: hashToken('tok-viejo'),
    consumedAt: null,
    revokedAt: null,
    rotatedToId: null,
    successorEnc: null,
    successorEncExpiresAt: null,
    expiresAt: new Date(Date.now() + EN_UN_DIA),
    ...over,
  }
}

/** La misma fila en la lectura SIN candado y en la relectura CON candado. */
function primeGrant(grant: Record<string, unknown>) {
  prismaMock.refreshGrant.findUnique.mockResolvedValue(grant)
  tx.refreshGrant.findUnique.mockResolvedValue(grant)
}

describe('hashToken', () => {
  it('es SHA-256 en hex y NUNCA devuelve el token', () => {
    const h = hashToken('tok-secreto')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).not.toContain('tok-secreto')
  })

  it('es determinista: el mismo token da el mismo hash', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'))
  })
})

describe('rotateGrant', () => {
  it('consume el grant y crea el sucesor en UNA sola transaccion', async () => {
    primeGrant(grantVigente())
    tx.refreshGrant.create.mockResolvedValue({ id: 'g2' })

    const r = await rotateGrant('tok-viejo', 'tok-nuevo', new Date(Date.now() + 86_400_000))

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ sucesor: 'tok-nuevo', sessionId: 's1', familyId: 'f1' })
    // el sucesor hereda la familia: es lo que permite revocarla entera despues
    expect(tx.refreshGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ familyId: 'f1', sessionId: 's1' }) }),
    )
  })

  it('el consumo es CONDICIONAL: el where exige consumedAt null', async () => {
    primeGrant(grantVigente())
    tx.refreshGrant.create.mockResolvedValue({ id: 'g2' })

    await rotateGrant('tok-viejo', 'tok-nuevo', new Date(Date.now() + 86_400_000))

    expect(tx.refreshGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tokenHash: hashToken('tok-viejo'), consumedAt: null, revokedAt: null }),
      }),
    )
  })

  it('dos refresh concurrentes: solo UNO consume (el segundo ve count 0)', async () => {
    primeGrant(grantVigente())
    tx.refreshGrant.updateMany.mockResolvedValue({ count: 0 }) // otro gano la carrera

    const r = await rotateGrant('tok-viejo', 'tok-nuevo', new Date(Date.now() + 86_400_000))

    expect(r).toEqual({ reutilizado: true })
    expect(tx.refreshGrant.create).not.toHaveBeenCalled() // no se acuna sucesor
  })

  it('un grant ya consumido se reporta como reutilizado', async () => {
    primeGrant(grantVigente({ consumedAt: new Date() }))
    await expect(rotateGrant('tok-viejo', 'tok-nuevo', new Date())).resolves.toEqual({ reutilizado: true })
  })

  it('un grant que no existe se reporta como reutilizado, no revienta', async () => {
    prismaMock.refreshGrant.findUnique.mockResolvedValue(null)
    tx.refreshGrant.findUnique.mockResolvedValue(null)
    await expect(rotateGrant('inventado', 'tok-nuevo', new Date())).resolves.toEqual({ reutilizado: true })
  })

  it('un grant vencido NO rota', async () => {
    primeGrant(grantVigente({ expiresAt: new Date(Date.now() - 1000) }))
    await expect(rotateGrant('tok-viejo', 'tok-nuevo', new Date())).resolves.toEqual({ reutilizado: true })
    expect(tx.refreshGrant.create).not.toHaveBeenCalled()
  })
})

describe('issueGrant', () => {
  it('guarda el HASH, jamas el token', async () => {
    prismaMock.refreshGrant.create.mockResolvedValue({ id: 'g1' })
    await issueGrant('s1', 'f1', 'tok-secreto', new Date())
    const data = prismaMock.refreshGrant.create.mock.calls[0][0].data
    expect(data.tokenHash).toBe(hashToken('tok-secreto'))
    expect(JSON.stringify(data)).not.toContain('tok-secreto')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// D19 (3-nov-2026) · la respuesta de una renovación se perdió y el aparato vuelve con R0 minutos u horas después.
// Diseño auditado por Codex en 3 rondas: Avoqado/docs/audit/2026-11-03-d19-sesion-respuesta-perdida/ (promesa.md).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** La cadena de la Sunmi: R0 rotó a S hace `minutos` y su eco de 60 s ya venció; S nunca llegó al aparato. */
function cadena(minutos: number, overR0: Record<string, unknown> = {}, overS: Record<string, unknown> = {}) {
  const consumedAt = new Date(Date.now() - minutos * MIN)
  const r0 = grantVigente({
    id: 'r0',
    consumedAt,
    rotatedToId: 's',
    successorEnc: null, // el job horario ya lo borró
    successorEncExpiresAt: null,
    ...overR0,
  })
  const s = grantVigente({ id: 's', tokenHash: hashToken('tok-s'), ...overS })
  prismaMock.refreshGrant.findUnique.mockResolvedValue(r0)
  tx.refreshGrant.findUnique.mockImplementation(async ({ where }: any) => (where.tokenHash ? r0 : where.id === 's' ? s : null))
  tx.refreshGrant.create.mockResolvedValue({ id: 'n' })
  return { r0, s }
}

/** El SQL del candado que se tomó (plantilla + valores del `$queryRaw` etiquetado). */
function candadoTomado(i = 0) {
  const [plantilla, ...valores] = tx.$queryRaw.mock.calls[i] as [TemplateStringsArray, ...unknown[]]
  return { sql: plantilla.join('?'), valores }
}

/** Orden de invocación de la primera llamada a cada escritura/lectura dentro de la transacción. */
function primeraLlamada(m: jest.Mock): number {
  return m.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
}

function esperaRevocacion() {
  expect(tx.refreshGrant.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ familyId: 'f1', revokedAt: null }) }),
  )
  expect(sessionService.revokeSession).toHaveBeenCalledWith('s1', 'refresh_reuse_detected', tx)
  expect(sessionCache.invalidateSession).toHaveBeenCalledWith('s1')
}

describe('D19 · candado por familia antes de cualquier escritura', () => {
  it('la rotación normal toma pg_advisory_xact_lock de la familia ANTES de releer o escribir', async () => {
    primeGrant(grantVigente())
    tx.refreshGrant.create.mockResolvedValue({ id: 'g2' })

    await rotateGrant('tok-viejo', 'tok-nuevo', new Date(Date.now() + EN_UN_DIA))

    const { sql, valores } = candadoTomado()
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\('refreshGrant:' \|\| \?, 0\)\)/)
    expect(valores).toEqual(['f1'])
    const candado = primeraLlamada(tx.$queryRaw)
    expect(candado).toBeLessThan(primeraLlamada(tx.refreshGrant.findUnique))
    expect(candado).toBeLessThan(primeraLlamada(tx.refreshGrant.updateMany))
    expect(candado).toBeLessThan(primeraLlamada(tx.refreshGrant.create))
  })

  it('el eco tardío toma el candado de la familia ANTES de releer o escribir', async () => {
    cadena(5)

    await rotateGrant('tok-viejo', 'tok-N', new Date(Date.now() + EN_UN_DIA))

    expect(candadoTomado().valores).toEqual(['f1'])
    const candado = primeraLlamada(tx.$queryRaw)
    expect(candado).toBeLessThan(primeraLlamada(tx.refreshGrant.findUnique))
    expect(candado).toBeLessThan(primeraLlamada(tx.refreshGrant.updateMany))
    expect(candado).toBeLessThan(primeraLlamada(tx.refreshGrant.create))
  })

  it('la revocación por reuso toma el candado de la familia ANTES de revocar', async () => {
    cadena(25 * 60) // fuera del tope de 24 h

    await rotateGrant('tok-viejo', 'tok-N', new Date(Date.now() + EN_UN_DIA))

    expect(candadoTomado().valores).toEqual(['f1'])
    const candado = primeraLlamada(tx.$queryRaw)
    expect(candado).toBeLessThan(primeraLlamada(tx.refreshGrant.updateMany))
    expect(candado).toBeLessThan((sessionService.revokeSession as jest.Mock).mock.invocationCallOrder[0])
  })
})

describe('D19 · eco tardío: R0 fuera de los 60 s con S sin usar', () => {
  it('consume S SIN sucesor (anulado), crea N y re-enlaza R0 → N con su eco de 60 s; no revoca nada', async () => {
    cadena(5)
    const vence = new Date(Date.now() + EN_UN_DIA)

    const r = await rotateGrant('tok-viejo', 'tok-N', vence)

    expect(r).toEqual({ sucesor: 'tok-N', sessionId: 's1', familyId: 'f1', ecoTardio: { minutosDesdeElConsumo: 5 } })

    // 1. S se consume con un updateMany CONDICIONAL y sin sucesor: queda «anulado».
    const [consumoS, reenlace] = tx.refreshGrant.updateMany.mock.calls.map(c => c[0])
    expect(consumoS.where).toEqual({ id: 's', consumedAt: null, revokedAt: null })
    expect(consumoS.data.consumedAt).toBeInstanceOf(Date)
    expect(consumoS.data).not.toHaveProperty('rotatedToId')
    expect(consumoS.data).not.toHaveProperty('successorEnc')

    // 2. N nace en la MISMA familia y sesión, guardado por su hash.
    expect(tx.refreshGrant.create).toHaveBeenCalledWith({
      data: { sessionId: 's1', familyId: 'f1', tokenHash: hashToken('tok-N'), expiresAt: vence },
    })

    // 3. R0 se re-enlaza a N sólo si seguía apuntando a S, con N cifrado y atado a la fila de R0.
    expect(reenlace.where).toEqual({ id: 'r0', rotatedToId: 's' })
    expect(reenlace.data.rotatedToId).toBe('n')
    expect(descifrarSucesor(reenlace.data.successorEnc, { grantId: 'r0', familyId: 'f1', sessionId: 's1' })).toBe('tok-N')
    const restante = reenlace.data.successorEncExpiresAt.getTime() - Date.now()
    expect(restante).toBeGreaterThan(55_000)
    expect(restante).toBeLessThanOrEqual(60_000)

    expect(sessionService.revokeSession).not.toHaveBeenCalled()
    expect(sessionCache.invalidateSession).not.toHaveBeenCalled()
  })

  it('también con el cifrado de R0 vencido pero aún sin borrar (el job de las :00 no ha pasado)', async () => {
    cadena(3, {
      successorEnc: cifrarSucesor('tok-s', { grantId: 'r0', familyId: 'f1', sessionId: 's1' }),
      successorEncExpiresAt: new Date(Date.now() - 2 * MIN),
    })

    const r = await rotateGrant('tok-viejo', 'tok-N', new Date(Date.now() + EN_UN_DIA))

    expect(r).toMatchObject({ sucesor: 'tok-N', ecoTardio: { minutosDesdeElConsumo: 3 } })
  })

  it('a las 23 h todavía aplica', async () => {
    cadena(23 * 60)
    await expect(rotateGrant('tok-viejo', 'tok-N', new Date(Date.now() + EN_UN_DIA))).resolves.toMatchObject({ sucesor: 'tok-N' })
  })

  it('pasadas 24 h desde el consumo de R0 revoca familia y sesión, como hoy', async () => {
    cadena(24 * 60 + 1)

    await expect(rotateGrant('tok-viejo', 'tok-N', new Date())).resolves.toEqual({ reutilizado: true })

    expect(tx.refreshGrant.create).not.toHaveBeenCalled()
    esperaRevocacion()
  })

  it.each([
    ['S ya se usó (el aparato sí recibió S)', { consumedAt: new Date(Date.now() - MIN), rotatedToId: 't' }],
    ['S ya estaba revocado', { revokedAt: new Date(Date.now() - MIN) }],
    ['S ya venció', { expiresAt: new Date(Date.now() - 1000) }],
  ])('%s: R0 revoca familia y sesión', async (_caso, overS) => {
    cadena(5, {}, overS)

    await expect(rotateGrant('tok-viejo', 'tok-N', new Date())).resolves.toEqual({ reutilizado: true })

    expect(tx.refreshGrant.create).not.toHaveBeenCalled()
    esperaRevocacion()
  })

  it('S no existe: revoca (nunca acuña sobre un enlace roto)', async () => {
    cadena(5, { rotatedToId: 'fantasma' })

    await expect(rotateGrant('tok-viejo', 'tok-N', new Date())).resolves.toEqual({ reutilizado: true })

    expect(tx.refreshGrant.create).not.toHaveBeenCalled()
    esperaRevocacion()
  })

  it('R0 revocado (la familia ya murió): revoca, nunca eco tardío', async () => {
    cadena(5, { revokedAt: new Date(Date.now() - MIN) })

    await expect(rotateGrant('tok-viejo', 'tok-N', new Date())).resolves.toEqual({ reutilizado: true })

    expect(tx.refreshGrant.create).not.toHaveBeenCalled()
    expect(sessionService.revokeSession).toHaveBeenCalledWith('s1', 'refresh_reuse_detected', tx)
  })

  it('sin SESSION_SUCCESSOR_ENC_KEY no hay eco tardío (no podría dejar el eco de 60 s de N): se comporta como hoy', async () => {
    const llave = jest.spyOn(successorCrypto, 'sucesorCifradoDisponible').mockReturnValue(false)
    try {
      cadena(5)

      await expect(rotateGrant('tok-viejo', 'tok-N', new Date())).resolves.toEqual({ reutilizado: true })

      expect(tx.refreshGrant.create).not.toHaveBeenCalled()
      esperaRevocacion()
    } finally {
      llave.mockRestore()
    }
  })

  it('dentro de los 60 s con un cifrado que no descifra NO es eco tardío: revoca como hoy', async () => {
    cadena(0, { successorEnc: 'v1.formato-invalido', successorEncExpiresAt: new Date(Date.now() + 50_000) })

    await expect(rotateGrant('tok-viejo', 'tok-N', new Date())).resolves.toEqual({ reutilizado: true })

    expect(tx.refreshGrant.create).not.toHaveBeenCalled()
    esperaRevocacion()
  })

  it('el ganador ya dejó su eco al releer bajo el candado: devuelve ESE N y no escribe nada', async () => {
    const { r0 } = cadena(5)
    const conEco = {
      ...r0,
      rotatedToId: 'n-del-ganador',
      successorEnc: cifrarSucesor('tok-N-ganador', { grantId: 'r0', familyId: 'f1', sessionId: 's1' }),
      successorEncExpiresAt: new Date(Date.now() + 50_000),
    }
    tx.refreshGrant.findUnique.mockImplementation(async ({ where }: any) => (where.tokenHash ? conEco : null))

    const r = await rotateGrant('tok-viejo', 'tok-N-perdedor', new Date())

    expect(r).toEqual({ sucesor: 'tok-N-ganador', sessionId: 's1', familyId: 'f1', retransmision: true })
    expect(tx.refreshGrant.updateMany).not.toHaveBeenCalled()
    expect(tx.refreshGrant.create).not.toHaveBeenCalled()
    expect(sessionService.revokeSession).not.toHaveBeenCalled()
  })

  it('🔴 si una escritura condicional no afecta exactamente una fila, la transacción LANZA (se revierte) y se devuelve el eco del ganador', async () => {
    const { r0 } = cadena(5)
    // El re-enlace de R0 (la SEGUNDA escritura condicional, después de anular S y crear N) no encuentra su fila.
    tx.refreshGrant.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    const errores: unknown[] = []
    prismaMock.$transaction.mockImplementationOnce(async (fn: any) => {
      try {
        return await fn(tx)
      } catch (e) {
        errores.push(e)
        throw e
      }
    })
    // Al releer con el candado (segunda transacción), el ganador ya dejó su N cifrado.
    const conEco = {
      ...r0,
      rotatedToId: 'n-del-ganador',
      successorEnc: cifrarSucesor('tok-N-ganador', { grantId: 'r0', familyId: 'f1', sessionId: 's1' }),
      successorEncExpiresAt: new Date(Date.now() + 50_000),
    }
    tx.refreshGrant.findUnique.mockImplementation(async ({ where }: any) =>
      where.tokenHash ? (errores.length ? conEco : r0) : where.id === 's' ? grantVigente({ id: 's' }) : null,
    )

    const r = await rotateGrant('tok-viejo', 'tok-N-perdedor', new Date())

    // Lanzar (no devolver un valor) es lo que hace que Prisma revierta la anulación de S y la creación de N.
    expect(errores).toHaveLength(1)
    expect(r).toEqual({ sucesor: 'tok-N-ganador', sessionId: 's1', familyId: 'f1', retransmision: true })
    expect(prisma.$transaction).toHaveBeenCalledTimes(2)
    // La segunda decisión no vuelve a intentar el eco tardío: sólo lee.
    expect(tx.refreshGrant.create).toHaveBeenCalledTimes(1)
    expect(sessionService.revokeSession).not.toHaveBeenCalled()
  })

  it('si tras perder la escritura condicional no hay eco del ganador, cae al reuso (revoca)', async () => {
    cadena(5)
    tx.refreshGrant.updateMany.mockResolvedValueOnce({ count: 0 }) // la anulación de S no fue nuestra

    await expect(rotateGrant('tok-viejo', 'tok-N', new Date())).resolves.toEqual({ reutilizado: true })

    expect(prisma.$transaction).toHaveBeenCalledTimes(2)
    expect(tx.refreshGrant.create).not.toHaveBeenCalled()
    esperaRevocacion()
  })
})

describe('D19 · «consumido sin sucesor» = anulado: quien lo presente revoca por CUALQUIER camino', () => {
  it('presentado de frente (S anulado por un eco tardío): revoca familia y sesión', async () => {
    primeGrant(grantVigente({ id: 's', consumedAt: new Date(Date.now() - 2 * MIN), rotatedToId: null }))

    await expect(rotateGrant('tok-s', 'tok-X', new Date())).resolves.toEqual({ reutilizado: true })

    esperaRevocacion()
  })

  it('🔴 en la carrera perdida (el dueño con S contra el eco tardío del ladrón): ahora SÍ revoca', async () => {
    // Sin candado, S se veía vigente; con el candado ya está consumido y sin sucesor: lo anuló el eco tardío de R0.
    prismaMock.refreshGrant.findUnique.mockResolvedValue(grantVigente({ id: 's' }))
    tx.refreshGrant.findUnique.mockResolvedValue(grantVigente({ id: 's', consumedAt: new Date(), rotatedToId: null }))

    await expect(rotateGrant('tok-s', 'tok-T', new Date())).resolves.toEqual({ reutilizado: true })

    expect(tx.refreshGrant.create).not.toHaveBeenCalled()
    esperaRevocacion()
  })

  it('la carrera perdida NORMAL (consumido CON sucesor, sin eco legible) sigue rechazando SIN revocar, como hoy', async () => {
    prismaMock.refreshGrant.findUnique.mockResolvedValue(grantVigente())
    tx.refreshGrant.findUnique.mockResolvedValue(grantVigente({ consumedAt: new Date(), rotatedToId: 'g2' }))

    await expect(rotateGrant('tok-viejo', 'tok-nuevo', new Date())).resolves.toEqual({ reutilizado: true })

    expect(tx.refreshGrant.updateMany).not.toHaveBeenCalled()
    expect(sessionService.revokeSession).not.toHaveBeenCalled()
  })

  it('la carrera perdida con el eco del ganador vigente devuelve el MISMO sucesor', async () => {
    prismaMock.refreshGrant.findUnique.mockResolvedValue(grantVigente())
    tx.refreshGrant.findUnique.mockResolvedValue(
      grantVigente({
        consumedAt: new Date(),
        rotatedToId: 'g2',
        successorEnc: cifrarSucesor('tok-ganador', { grantId: 'g1', familyId: 'f1', sessionId: 's1' }),
        successorEncExpiresAt: new Date(Date.now() + 59_000),
      }),
    )

    const r = await rotateGrant('tok-viejo', 'tok-perdedor', new Date())

    expect(r).toEqual({ sucesor: 'tok-ganador', sessionId: 's1', familyId: 'f1', retransmision: true })
    expect(sessionService.revokeSession).not.toHaveBeenCalled()
  })
})

describe('D19 · un timeout o conflicto de la transacción es FALLA OPERATIVA (5xx), nunca reuso ni éxito', () => {
  const errorDePrisma = (code: string) =>
    new Prisma.PrismaClientKnownRequestError('Transaction API error: Transaction already closed', { code, clientVersion: '6.19.3' })

  it.each([
    ['P2028 (tiempo agotado esperando el candado)', 'P2028'],
    ['P2034 (conflicto o interbloqueo)', 'P2034'],
  ])('%s en la rotación normal → 503', async (_caso, code) => {
    primeGrant(grantVigente())
    prismaMock.$transaction.mockRejectedValue(errorDePrisma(code))

    const error = await rotateGrant('tok-viejo', 'tok-nuevo', new Date()).then(
      () => null,
      e => e,
    )

    expect(error).toMatchObject({ statusCode: 503, code: 'SESSION_REFRESH_RETRY' })
    expect(sessionCache.invalidateSession).not.toHaveBeenCalled()
  })

  it('P2028 en el camino del eco tardío / reuso → 503, nunca { reutilizado }', async () => {
    cadena(5)
    prismaMock.$transaction.mockRejectedValue(errorDePrisma('P2028'))

    await expect(rotateGrant('tok-viejo', 'tok-N', new Date())).rejects.toMatchObject({ statusCode: 503 })
    expect(sessionCache.invalidateSession).not.toHaveBeenCalled()
  })

  it('un error de base distinto se propaga tal cual (5xx del manejador global), nunca se vuelve { reutilizado }', async () => {
    primeGrant(grantVigente())
    const caida = new Error('la base no contesta')
    prismaMock.$transaction.mockRejectedValue(caida)

    await expect(rotateGrant('tok-viejo', 'tok-nuevo', new Date())).rejects.toBe(caida)
  })
})
