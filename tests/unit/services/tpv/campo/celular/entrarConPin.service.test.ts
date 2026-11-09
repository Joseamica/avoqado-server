/**
 * Entrar con PIN y renovar la sesión del celular de campo (App de campo, bloque 1, Tarea 4).
 * Prisma va en una memoria chica que entiende los `where`; su `$transaction` corre EN FILA, como lo hace el candado de
 * la fila de Postgres (el UPDATE del intento). Que el candado real exista lo prueba la integración.
 */
import jwt from 'jsonwebtoken'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { hashToken, rotateGrant } from '@/services/auth/refreshGrant.service'
import { sucursalesDeLaPersona } from '@/services/tpv/campo/celular/personasDeCampo'
import { crearSesionDeCelular, sucursalesParaElCelular } from '@/services/tpv/campo/celular/sesionDeCelular'
import { motivoDeSesionInvalidada } from '@/utils/passwordChangeGuard'
import { verificarAccesoDeCampo } from '@/services/tpv/campo/celular/tokenDeCampo'
import { entrarConPin, esperaTrasFallos, renovarSesionDeCelular } from '@/services/tpv/campo/celular/entrarConPin.service'
import { entrarConPinSchema, renovarSesionSchema } from '@/schemas/tpv/campo.schema'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    celularDeCampo: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), updateMany: jest.fn() },
    refreshGrant: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('@/services/auth/refreshGrant.service', () => ({
  hashToken: jest.requireActual('@/services/auth/refreshGrant.service').hashToken,
  rotateGrant: jest.fn(),
}))
jest.mock('@/services/mobile/auth.mobile.service', () => ({ refreshGrantExpiry: () => new Date('2026-11-16T12:00:00.000Z') }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/tpv/campo/celular/personasDeCampo', () => ({ sucursalesDeLaPersona: jest.fn() }))
jest.mock('@/services/tpv/campo/celular/sesionDeCelular', () => ({ crearSesionDeCelular: jest.fn(), sucursalesParaElCelular: jest.fn() }))
jest.mock('@/utils/passwordChangeGuard', () => ({
  motivoDeSesionInvalidada: jest.fn(),
  mensajeDeCorte: jest.requireActual('@/utils/passwordChangeGuard').mensajeDeCorte,
}))

const db = prisma as any
const AHORA = new Date('2026-11-09T12:00:00.000Z')
const MIN = 60 * 1000
const PIN = '4321'

function coincide(fila: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'OR') return v.some((w: any) => coincide(fila, w))
    if (v === null) return fila[k] == null
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v) return v.not === null ? fila[k] != null : fila[k] !== v.not
      if ('lte' in v) return fila[k] != null && fila[k] <= v.lte
      throw new Error(`operador no soportado en el falso: ${JSON.stringify(v)}`)
    }
    return fila[k] === v
  })
}
function aplicar(fila: any, data: any) {
  for (const [k, v] of Object.entries(data) as [string, any][]) {
    if (v && typeof v === 'object' && 'increment' in v) fila[k] += v.increment
    else fila[k] = v
  }
}

let celulares: any[]
let sucursales: Record<string, any[]>
let grants: any[]

const celular = (id: string, staffId: string, extra: Record<string, unknown> = {}) => ({
  id,
  organizationId: 'org1',
  staffId,
  staffIdVinculado: staffId,
  credencialHash: `hash-${id}`,
  sesionId: `ses-${id}`,
  pinSal: 'c2FsLWRlLXBydWViYQ==',
  pinFallos: 0,
  pinBloqueadoHasta: null,
  desvinculadoAt: null,
  ...extra,
})
/** Lo que el middleware deja en `res.locals.celular`: la fila tal como está AHORA (una copia). */
const fila = (id = 'celA') => ({ ...celulares.find(c => c.id === id) })
const entrar = (pin = PIN, venueId?: string, id = 'celA') => entrarConPin(fila(id) as any, { pin, ...(venueId && { venueId }) })
const falla = (p: Promise<unknown>) =>
  p.then(
    () => Promise.reject(new Error('debió fallar')),
    (e: any) => e,
  )

beforeEach(() => {
  jest.resetAllMocks()
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(AHORA)
  celulares = [celular('celA', 'staffA'), celular('celB', 'staffB')]
  sucursales = {
    staffA: [{ staffVenueId: 'svA', venueId: 'v1', nombre: 'Tienda Uno', role: 'CASHIER', pin: PIN }],
    staffB: [{ staffVenueId: 'svB', venueId: 'v1', nombre: 'Tienda Uno', role: 'WAITER', pin: '9999' }],
  }
  grants = []
  ;(sucursalesDeLaPersona as jest.Mock).mockImplementation((staffId: string) =>
    Promise.resolve((sucursales[staffId] ?? []).map(s => ({ ...s }))),
  )
  ;(sucursalesParaElCelular as jest.Mock).mockResolvedValue([{ venueId: 'v1', nombre: 'Tienda Uno', verificadorPin: null }])
  ;(crearSesionDeCelular as jest.Mock).mockImplementation((c: any, s: any) =>
    Promise.resolve({ accessToken: `at-${c.id}`, refreshToken: 'r'.repeat(64), venueId: s.venueId, expiraEn: 86400 }),
  )
  ;(logAction as jest.Mock).mockResolvedValue(undefined)
  ;(motivoDeSesionInvalidada as jest.Mock).mockResolvedValue(null)
  // En fila: es lo que hace el candado de la fila que toma el UPDATE del intento hasta el commit.
  let cola: Promise<unknown> = Promise.resolve()
  db.$transaction.mockImplementation((fn: any) => {
    const r = cola.then(() => fn(db))
    cola = r.catch(() => undefined)
    return r
  })
  db.celularDeCampo.findUnique.mockImplementation(({ where }: any) => Promise.resolve(celulares.find(c => coincide(c, where)) ?? null))
  db.celularDeCampo.findUniqueOrThrow.mockImplementation(({ where }: any) => {
    const c = celulares.find(x => coincide(x, where))
    return c ? Promise.resolve(c) : Promise.reject(new Error('no existe'))
  })
  db.celularDeCampo.updateMany.mockImplementation(({ where, data }: any) => {
    const filas = celulares.filter(c => coincide(c, where))
    filas.forEach(f => aplicar(f, data))
    return Promise.resolve({ count: filas.length })
  })
  db.refreshGrant.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(grants.find(g => g.tokenHash === where.tokenHash) ?? null),
  )
})
afterEach(() => jest.useRealTimers())

describe('esperaTrasFallos', () => {
  it.each([
    [0, 0],
    [4, 0],
    [5, 1],
    [6, 2],
    [10, 32],
    [11, 60],
    [20, 60],
    [5000, 60],
  ])('%i fallos → %i min', (fallos, minutos) => {
    expect(esperaTrasFallos(fallos)).toBe(minutos * MIN)
  })
})

describe('entrarConPin', () => {
  it('PIN bueno: sesión nueva en esa sucursal, contador en cero, bitácora STAFF_LOGIN sin el PIN', async () => {
    celulares[0].pinFallos = 3
    const r = await entrar()
    expect(crearSesionDeCelular).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'celA' }),
      expect.objectContaining({ venueId: 'v1', role: 'CASHIER' }),
    )
    expect(r).toEqual({
      sesion: { accessToken: 'at-celA', refreshToken: 'r'.repeat(64), venueId: 'v1', expiraEn: 86400 },
      sucursales: [{ venueId: 'v1', nombre: 'Tienda Uno', verificadorPin: null }],
      horaDelServidor: AHORA.toISOString(),
    })
    expect(celulares[0]).toMatchObject({ pinFallos: 0, pinBloqueadoHasta: null })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'staffA',
        venueId: 'v1',
        action: 'STAFF_LOGIN',
        data: { source: 'campo', method: 'pin', celularId: 'celA' },
      }),
    )
    expect(JSON.stringify((logAction as jest.Mock).mock.calls)).not.toContain(PIN)
  })

  it('desvinculado → 401 CELULAR_DESVINCULADO sin comparar ni contar', async () => {
    Object.assign(celulares[0], { staffIdVinculado: null, desvinculadoAt: AHORA })
    expect(await falla(entrar())).toMatchObject({ statusCode: 401, code: 'CELULAR_DESVINCULADO' })
    expect(celulares[0].pinFallos).toBe(0)
    expect(crearSesionDeCelular).not.toHaveBeenCalled()
  })

  it('bloqueado → 429 PIN_BLOQUEADO con reintentaEn en segundos, y no cuenta otro fallo', async () => {
    Object.assign(celulares[0], { pinFallos: 5, pinBloqueadoHasta: new Date(AHORA.getTime() + 90 * 1000) })
    expect(await falla(entrar())).toMatchObject({ statusCode: 429, code: 'PIN_BLOQUEADO', details: { reintentaEn: 90 } })
    expect(celulares[0].pinFallos).toBe(5)
  })

  it('sin sucursales → 403 SIN_SUCURSAL', async () => {
    sucursales.staffA = []
    expect(await falla(entrar())).toMatchObject({ statusCode: 403, code: 'SIN_SUCURSAL' })
  })

  it('venueId que no es de sus sucursales → 403 SIN_ACCESO_A_LA_SUCURSAL sin contar intento', async () => {
    expect(await falla(entrar(PIN, 'v-ajena'))).toMatchObject({ statusCode: 403, code: 'SIN_ACCESO_A_LA_SUCURSAL' })
    expect(celulares[0].pinFallos).toBe(0)
  })

  it('dos sucursales sin venueId → 409 ELIGE_SUCURSAL con { venueId, nombre } (sin PIN)', async () => {
    sucursales.staffA.push({ staffVenueId: 'svA2', venueId: 'v2', nombre: 'Tienda Dos', role: 'WAITER', pin: '1111' })
    const e = await falla(entrar())
    expect(e).toMatchObject({ statusCode: 409, code: 'ELIGE_SUCURSAL' })
    expect(e.details).toEqual({
      sucursales: [
        { venueId: 'v1', nombre: 'Tienda Uno' },
        { venueId: 'v2', nombre: 'Tienda Dos' },
      ],
    })
    expect(celulares[0].pinFallos).toBe(0)
  })

  it('con venueId compara el PIN de ESA sucursal', async () => {
    sucursales.staffA.push({ staffVenueId: 'svA2', venueId: 'v2', nombre: 'Tienda Dos', role: 'WAITER', pin: '1111' })
    expect(await falla(entrar(PIN, 'v2'))).toMatchObject({ code: 'PIN_INCORRECTO' })
    await entrar('1111', 'v2')
    expect(crearSesionDeCelular).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ venueId: 'v2', role: 'WAITER' }))
  })

  it('sin PIN en esa sucursal → 409 SIN_PIN', async () => {
    sucursales.staffA[0].pin = null
    expect(await falla(entrar())).toMatchObject({ statusCode: 409, code: 'SIN_PIN' })
  })

  it('4 PINes malos cuentan 4,3,2,1; el 5.º bloquea 1 min; el siguiente → PIN_BLOQUEADO con reintentaEn 60', async () => {
    const quedan = []
    for (let i = 0; i < 5; i++) {
      const e = await falla(entrar('0000'))
      expect(e).toMatchObject({ statusCode: 401, code: 'PIN_INCORRECTO' })
      quedan.push(e.details.intentosAntesDeEsperar)
    }
    expect(quedan).toEqual([4, 3, 2, 1, 0])
    expect(celulares[0].pinBloqueadoHasta).toEqual(new Date(AHORA.getTime() + MIN))
    expect(await falla(entrar())).toMatchObject({ statusCode: 429, code: 'PIN_BLOQUEADO', details: { reintentaEn: 60 } })
    expect(celulares[0].pinFallos).toBe(5)
  })

  it('tras la espera, el PIN bueno entra y reinicia el contador; un malo después de la espera duplica la espera', async () => {
    for (let i = 0; i < 5; i++) await falla(entrar('0000'))
    jest.setSystemTime(new Date(AHORA.getTime() + MIN + 1000))
    expect(await falla(entrar('0000'))).toMatchObject({ code: 'PIN_INCORRECTO', details: { intentosAntesDeEsperar: 0 } })
    expect(celulares[0]).toMatchObject({ pinFallos: 6, pinBloqueadoHasta: new Date(AHORA.getTime() + MIN + 1000 + 2 * MIN) })

    jest.setSystemTime(new Date(AHORA.getTime() + 4 * MIN))
    await entrar()
    expect(celulares[0]).toMatchObject({ pinFallos: 0, pinBloqueadoHasta: null })
    expect(await falla(entrar('0000'))).toMatchObject({ details: { intentosAntesDeEsperar: 4 } })
  })

  it('20 PINes malos en el celular A no tocan al celular B (otra persona, misma sucursal): B entra a la primera', async () => {
    let t = AHORA.getTime()
    for (let i = 0; i < 20; i++) {
      t += 61 * MIN
      jest.setSystemTime(new Date(t))
      await falla(entrar('0000'))
    }
    expect(celulares[0].pinFallos).toBe(20)
    const r = await entrar('9999', undefined, 'celB')
    expect(r.sesion.accessToken).toBe('at-celB')
    expect(celulares[1]).toMatchObject({ pinFallos: 0, pinBloqueadoHasta: null })
  })

  it('ráfaga de 10 PINes malos en paralelo: a lo más 5 se comparan, los demás → PIN_BLOQUEADO', async () => {
    const espia = jest.spyOn(require('crypto'), 'timingSafeEqual')
    const rs = await Promise.all(Array.from({ length: 10 }, () => falla(entrar('0000'))))
    const comparados = espia.mock.calls.length
    espia.mockRestore()
    expect(comparados).toBeLessThanOrEqual(5)
    expect(rs.filter(e => e.code === 'PIN_INCORRECTO')).toHaveLength(5)
    expect(rs.filter(e => e.code === 'PIN_BLOQUEADO')).toHaveLength(5)
    expect(celulares[0].pinFallos).toBe(5)
  })

  it('el desvinculado que llega mientras tanto lo decide la fila de la base (no la copia del middleware)', async () => {
    const copia = fila()
    Object.assign(celulares[0], { staffIdVinculado: null, desvinculadoAt: AHORA })
    expect(await falla(entrarConPin(copia as any, { pin: PIN }))).toMatchObject({ statusCode: 401, code: 'CELULAR_DESVINCULADO' })
    expect(crearSesionDeCelular).not.toHaveBeenCalled()
  })
})

describe('renovarSesionDeCelular', () => {
  const REFRESH = 'a'.repeat(64)
  const conGrant = (sesion: Record<string, unknown>) =>
    grants.push({
      tokenHash: hashToken(REFRESH),
      session: { id: 'ses-celA', staffId: 'staffA', venueId: 'v1', revokedAt: null, createdAt: new Date(AHORA.getTime() - MIN), ...sesion },
    })
  const renovar = (refresh = REFRESH) => renovarSesionDeCelular(fila() as any, refresh)

  it('rota: devuelve el sucesor y un access nuevo con el rol de HOY y el sid de la sesión', async () => {
    conGrant({})
    sucursales.staffA[0].role = 'WAITER'
    ;(rotateGrant as jest.Mock).mockResolvedValue({ sucesor: 'b'.repeat(64), sessionId: 'ses-celA', familyId: 'f1' })
    const r = await renovar()
    expect(rotateGrant).toHaveBeenCalledWith(REFRESH, expect.stringMatching(/^[a-f0-9]{64}$/), new Date('2026-11-16T12:00:00.000Z'))
    expect(r).toEqual({ accessToken: expect.any(String), refreshToken: 'b'.repeat(64), venueId: 'v1' })
    expect(verificarAccesoDeCampo(r.accessToken)).toMatchObject({
      sub: 'staffA',
      orgId: 'org1',
      venueId: 'v1',
      role: 'WAITER',
      sid: 'ses-celA',
    })
    expect(motivoDeSesionInvalidada).toHaveBeenCalledWith('staffA', Math.floor((AHORA.getTime() - MIN) / 1000))
  })

  it('retransmisión: devuelve el MISMO sucesor', async () => {
    conGrant({})
    ;(rotateGrant as jest.Mock).mockResolvedValue({ sucesor: 'c'.repeat(64), sessionId: 'ses-celA', familyId: 'f1', retransmision: true })
    expect((await renovar()).refreshToken).toBe('c'.repeat(64))
  })

  it('refresh reutilizado (fuera de la ventana) → 401 SESION_INVALIDA', async () => {
    conGrant({})
    ;(rotateGrant as jest.Mock).mockResolvedValue({ reutilizado: true })
    expect(await falla(renovar())).toMatchObject({ statusCode: 401, code: 'SESION_INVALIDA' })
  })

  it('desvinculado → 401 CELULAR_DESVINCULADO', async () => {
    conGrant({})
    Object.assign(celulares[0], { staffIdVinculado: null, sesionId: null })
    expect(await falla(renovar())).toMatchObject({ statusCode: 401, code: 'CELULAR_DESVINCULADO' })
    expect(rotateGrant).not.toHaveBeenCalled()
  })

  it.each([
    ['refresh desconocido', null],
    ['la sesión de OTRO celular', { id: 'ses-celB' }],
    ['sesión revocada', { revokedAt: AHORA }],
    ['sesión de otra persona', { staffId: 'staffB' }],
  ])('%s → 401 SESION_INVALIDA sin rotar', async (_, sesion) => {
    if (sesion) conGrant(sesion)
    expect(await falla(renovar())).toMatchObject({ statusCode: 401, code: 'SESION_INVALIDA' })
    expect(rotateGrant).not.toHaveBeenCalled()
  })

  it('sesión anterior al corte (cambió su contraseña) → 401 SESION_INVALIDA con el mensaje del corte', async () => {
    conGrant({})
    ;(motivoDeSesionInvalidada as jest.Mock).mockResolvedValue('PASSWORD_CHANGED')
    expect(await falla(renovar())).toMatchObject({
      statusCode: 401,
      code: 'SESION_INVALIDA',
      message: 'Tu contraseña cambió. Vuelve a iniciar sesión.',
    })
    expect(rotateGrant).not.toHaveBeenCalled()
  })

  it('StaffVenue de esa sucursal desactivado → 401 SIN_ACCESO_A_LA_SUCURSAL sin rotar', async () => {
    conGrant({})
    sucursales.staffA = [{ staffVenueId: 'svX', venueId: 'v9', nombre: 'Otra', role: 'CASHIER', pin: PIN }]
    expect(await falla(renovar())).toMatchObject({ statusCode: 401, code: 'SIN_ACCESO_A_LA_SUCURSAL' })
    expect(rotateGrant).not.toHaveBeenCalled()
  })
})

describe('esquemas', () => {
  const ok = (s: any, body: unknown) => s.safeParse({ body }).success
  it('entrar: PIN de 4 a 10 dígitos, venueId opcional, nada más', () => {
    expect(ok(entrarConPinSchema, { pin: '1234' })).toBe(true)
    expect(ok(entrarConPinSchema, { pin: '1234', venueId: 'cmv1' })).toBe(true)
    expect(ok(entrarConPinSchema, { pin: '12a4' })).toBe(false)
    expect(ok(entrarConPinSchema, { pin: '123' })).toBe(false)
    expect(ok(entrarConPinSchema, { pin: '1234', extra: 1 })).toBe(false)
  })
  it('renovar: refresh de 64 hex', () => {
    expect(ok(renovarSesionSchema, { refreshToken: 'a'.repeat(64) })).toBe(true)
    expect(ok(renovarSesionSchema, { refreshToken: 'a'.repeat(63) })).toBe(false)
    expect(ok(renovarSesionSchema, { refreshToken: jwt.sign({}, 'x') })).toBe(false)
  })
})
