/**
 * REFRESCO CONCURRENTE Y ECO TARDÍO — contra un Postgres real y desechable (nunca `av-db-25`: lo impide
 * `tests/__helpers__/integration-setup.ts`).
 *
 * Reproduce el incidente del 2026-09-02 16:07 (Sunmi D3, owner@owner.com,
 * sesión cmtkmm7sv0001q0t1z0ogtsgz): el POS despertó del background, seis
 * peticiones vencidas dispararon DOS refrescos que se SOLAPARON, y el segundo
 * recibió `reutilizado` → 401 «Tu sesión ya no es válida» → logout del cajero.
 *
 * 🔑 Lo que la evidencia de la base descartó: NADA quedó revocado — ni la
 * `Session` (`revokedAt` NULL) ni ningún grant de la familia. O sea que NO se
 * ejecutó el camino de robo (pre-chequeo `previo.consumedAt`), que sí revoca.
 * El que corrió fue el perdedor del `updateMany` condicional DENTRO de la
 * transacción, que devuelve `reutilizado` sin mirar la ventana de
 * retransmisión — aunque el ganador acababa de dejar el sucesor cifrado en la
 * fila, vigente 60 s.
 *
 * D19 (3-nov-2026) — la respuesta perdida MINUTOS u HORAS antes. Sunmi OrderPAD 3, sesión cmw10ct72006jwalgs3inxnyv:
 * a las 12:25:20 el servidor rotó R0 → S, el WiFi se apagó antes de que llegara la respuesta y a las 12:54:09 el
 * aparato volvió con R0. Fuera de los 60 s eso se leía como robo: familia y sesión revocadas, cajero fuera. Ahora, si S
 * nunca se usó (y dentro de 24 h), el eco tardío anula S y acuña un N nuevo; toda transacción que muta grants de la
 * familia toma antes su candado (`pg_advisory_xact_lock`). Diseño auditado por Codex en 3 rondas (bloqueantes 3 → 1 → 0):
 * `Avoqado/docs/audit/2026-11-03-d19-sesion-respuesta-perdida/`.
 *
 * Un mock no puede probar esto: la carrera la decide Postgres al serializar
 * dos UPDATE sobre la misma fila, y el candado sólo existe en una base real. El tiempo se simula moviendo `consumedAt`
 * y `successorEncExpiresAt` al pasado, nunca con relojes falsos.
 */
import prisma from '@/utils/prismaClient'
import { hashToken, issueGrant, rotateGrant } from '@/services/auth/refreshGrant.service'
import { aparcarLaSiguienteTransaccion, aTiempo, esperarBloqueado, type TransaccionAparcada } from '@tests/__helpers__/candadosDePostgres'

const SUF = `refcarrera_${Date.now()}`
let orgId: string
let venueId: string
let staffId: string
let sessionId: string

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `RefCarrera Org ${SUF}`, email: `${SUF}@test.local`, phone: '0000000000' },
  })
  orgId = org.id
  const venue = await prisma.venue.create({
    data: { organizationId: orgId, name: `V ${SUF}`, slug: `v-${SUF}` },
  })
  venueId = venue.id
  const staff = await prisma.staff.create({
    data: { email: `${SUF}@test.local`, firstName: 'Ref', lastName: 'Carrera' },
  })
  staffId = staff.id
})

afterAll(async () => {
  // Sin venue no se creó nada de este archivo: ningún deleteMany corre con filtros vacíos.
  if (!venueId) return
  if (staffId) await prisma.session.deleteMany({ where: { staffId } })
  if (staffId) await prisma.staff.delete({ where: { id: staffId } }).catch(() => undefined)
  await prisma.venue.delete({ where: { id: venueId } }).catch(() => undefined)
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined)
  await prisma.$disconnect()
})

beforeEach(async () => {
  const session = await prisma.session.create({
    data: { staffId, venueId, authMethod: 'PASSWORD' },
  })
  sessionId = session.id
})

const enUnaSemana = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

it('dos refrescos que SE SOLAPAN devuelven el MISMO sucesor y nadie pierde la sesión', async () => {
  const familyId = `fam-${SUF}-${Math.random()}`
  await issueGrant(sessionId, familyId, 'tok-viejo', enUnaSemana())

  // Las dos peticiones que el POS mandó a la vez al despertar. Cada una trae su
  // propio candidato a sucesor, igual que en producción: el token nuevo lo
  // acuña `refreshAccessToken` ANTES de llamar a rotateGrant, así que dos
  // llamadas concurrentes nunca proponen el mismo.
  const [a, b] = await Promise.all([
    rotateGrant('tok-viejo', 'tok-nuevo-A', enUnaSemana()),
    rotateGrant('tok-viejo', 'tok-nuevo-B', enUnaSemana()),
  ])

  // Ninguna de las dos puede salir como reutilización: es el MISMO cliente
  // legítimo, con el MISMO refresh token, en la misma ventana.
  expect(a).not.toHaveProperty('reutilizado')
  expect(b).not.toHaveProperty('reutilizado')

  // Y las dos tienen que quedarse con el MISMO sucesor: si cada una guardara el
  // suyo, el aparato acabaría con un refresh token que la base no reconoce.
  const sucesorA = (a as { sucesor: string }).sucesor
  const sucesorB = (b as { sucesor: string }).sucesor
  expect(sucesorA).toBe(sucesorB)

  // La sesión sigue viva: el cajero no se quedó fuera.
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  expect(session?.revokedAt).toBeNull()

  // Y la familia entera sigue sana — nada revocado.
  const revocados = await prisma.refreshGrant.count({ where: { familyId, revokedAt: { not: null } } })
  expect(revocados).toBe(0)
})

it('el sucesor que devuelve el perdedor SIRVE de verdad para el siguiente refresco', async () => {
  const familyId = `fam2-${SUF}-${Math.random()}`
  await issueGrant(sessionId, familyId, 'tok-viejo-2', enUnaSemana())

  const [a, b] = await Promise.all([
    rotateGrant('tok-viejo-2', 'tok-nuevo-A2', enUnaSemana()),
    rotateGrant('tok-viejo-2', 'tok-nuevo-B2', enUnaSemana()),
  ])

  // El aparato se queda con el token de la respuesta que le llegó al final —
  // cualquiera de las dos. Ese token tiene que poder rotar otra vez, o el POS
  // muere en el ciclo siguiente (10 min después) en vez de ahora.
  const ultimo = (b as { sucesor?: string }).sucesor ?? (a as { sucesor: string }).sucesor
  const siguiente = await rotateGrant(ultimo, 'tok-nuevo-C2', enUnaSemana())

  expect(siguiente).not.toHaveProperty('reutilizado')
})

it('un refresh token de VERDAD reutilizado (su sucesor ya se usó) SIGUE revocando la familia', async () => {
  const familyId = `fam3-${SUF}-${Math.random()}`
  await issueGrant(sessionId, familyId, 'tok-robado', enUnaSemana())

  const primero = await rotateGrant('tok-robado', 'tok-legitimo', enUnaSemana())
  expect(primero).not.toHaveProperty('reutilizado')
  // El aparato legítimo SÍ recibió su sucesor y lo siguió usando.
  const segundo = await rotateGrant('tok-legitimo', 'tok-legitimo-2', enUnaSemana())
  expect(segundo).not.toHaveProperty('reutilizado')

  // El ladrón reproduce el token viejo PASADA la ventana de retransmisión: se
  // fuerza venciendo el ciphertext del sucesor, que es lo que la ventana usa.
  await prisma.refreshGrant.updateMany({
    where: { familyId, consumedAt: { not: null } },
    data: { successorEncExpiresAt: new Date(Date.now() - 1000) },
  })

  const robo = await rotateGrant('tok-robado', 'tok-del-ladron', enUnaSemana())
  expect(robo).toEqual({ reutilizado: true })

  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  expect(session?.revokedAt).not.toBeNull()
  expect(session?.revokedReason).toBe('refresh_reuse_detected')
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// D19 · eco tardío
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const MIN = 60_000

const grant = (token: string) => prisma.refreshGrant.findUnique({ where: { tokenHash: hashToken(token) } })
const existe = async (token: string) => (await grant(token)) !== null
const vivos = (familyId: string) => prisma.refreshGrant.count({ where: { familyId, revokedAt: null } })
const cuantos = (familyId: string) => prisma.refreshGrant.count({ where: { familyId } })
const sesion = () => prisma.session.findUniqueOrThrow({ where: { id: sessionId } })

/** El candado de la familia, tal como lo toman la rotación, el eco tardío y la revocación (parte del diseño). */
const SQL_DEL_CANDADO = /pg_advisory_xact_lock\(hashtextextended\('refreshGrant:'/

/** Una cadena R0 → S como la de la Sunmi: el servidor rotó R0 y la respuesta con S nunca llegó al aparato. */
async function cadenaConRespuestaPerdida(etiqueta: string) {
  const familyId = `fam-${etiqueta}-${SUF}-${Math.random()}`
  const r0 = `tok-r0-${etiqueta}-${Math.random()}`
  const s = `tok-s-${etiqueta}-${Math.random()}`
  await issueGrant(sessionId, familyId, r0, enUnaSemana())
  expect(await rotateGrant(r0, s, enUnaSemana())).toEqual({ sucesor: s, sessionId, familyId })
  return { familyId, r0, s }
}

/** P → R0 → S: dos rotaciones ya hechas; P y R0 consumidos con su eco de 60 s vencido, S sin usar. */
async function cadenaDeTres(etiqueta: string) {
  const { familyId, r0: p, s: r0 } = await cadenaConRespuestaPerdida(etiqueta)
  const s = `tok-s3-${etiqueta}-${Math.random()}`
  expect(await rotateGrant(r0, s, enUnaSemana())).toEqual({ sucesor: s, sessionId, familyId })
  await pasaronMinutos(p, 15)
  await pasaronMinutos(r0, 5)
  return { familyId, p, r0, s }
}

/** Lee `prop` de `objeto`; si es un método, lo devuelve atado a su dueño (no al Proxy que lo envuelve). */
function conDueno(objeto: any, prop: PropertyKey): unknown {
  const valor = objeto[prop]
  return typeof valor === 'function' ? valor.bind(objeto) : valor
}

/**
 * Aparca la siguiente transacción (corre su cuerpo y se queda antes del commit, con su candado) y, pase lo que pase, al
 * final la suelta y espera a TODAS las renovaciones que la prueba lanzó con `lanzar`: una prueba que falla a medias no
 * deja promesas vivas que truenen dentro de la siguiente.
 */
async function conTransaccionAparcada(
  cuerpo: (h: { aparcada: TransaccionAparcada; lanzar: <T>(p: Promise<T>) => Promise<T> }) => Promise<void>,
): Promise<void> {
  const aparcada = aparcarLaSiguienteTransaccion(prisma)
  const lanzadas: Promise<unknown>[] = []
  const lanzar = <T>(p: Promise<T>): Promise<T> => {
    p.catch(() => undefined) // la prueba la espera aparte; esto sólo evita un rechazo «sin manejar» si falla antes
    lanzadas.push(p)
    return p
  }
  try {
    await cuerpo({ aparcada, lanzar })
  } finally {
    aparcada.soltar()
    aparcada.restaurar()
    await Promise.allSettled(lanzadas)
  }
}

/**
 * El aparato estuvo `minutos` sin red desde que el servidor consumió `token`: su consumo se mueve al pasado y su eco de
 * 60 s queda vencido. Con `purgado`, además, el job de las :00 ya borró el cifrado (lo normal pasados varios minutos).
 */
async function pasaronMinutos(token: string, minutos: number, { purgado = false } = {}) {
  const consumedAt = new Date(Date.now() - minutos * MIN)
  await prisma.refreshGrant.update({
    where: { tokenHash: hashToken(token) },
    data: purgado
      ? { consumedAt, successorEnc: null, successorEncExpiresAt: null }
      : { consumedAt, successorEncExpiresAt: new Date(consumedAt.getTime() + 60_000) },
  })
}

describe('D19 · eco tardío: la respuesta de la renovación se perdió minutos u horas antes', () => {
  it('1 · R0 a los 5 min con S sin usar: recibe un N nuevo, S queda anulado y familia y sesión siguen vivas', async () => {
    const { familyId, r0, s } = await cadenaConRespuestaPerdida('c1')
    await pasaronMinutos(r0, 5, { purgado: true })

    const r = await rotateGrant(r0, 'tok-N-c1', enUnaSemana())

    expect(r).toEqual({ sucesor: 'tok-N-c1', sessionId, familyId, ecoTardio: { minutosDesdeElConsumo: 5 } })
    const [gR0, gS, gN] = await Promise.all([grant(r0), grant(s), grant('tok-N-c1')])
    // S queda «anulado»: consumido y SIN sucesor. Si alguien lo presenta después, se revoca todo (prueba 4).
    expect(gS!.consumedAt).not.toBeNull()
    expect(gS!.rotatedToId).toBeNull()
    expect(gS!.successorEnc).toBeNull()
    expect(gN).toMatchObject({ familyId, sessionId, consumedAt: null, revokedAt: null })
    // R0 apunta ahora a N, con su eco de 60 s para un reintento inmediato (prueba 9).
    expect(gR0!.rotatedToId).toBe(gN!.id)
    expect(gR0!.successorEncExpiresAt!.getTime()).toBeGreaterThan(Date.now())
    expect((await sesion()).revokedAt).toBeNull()
    expect(await vivos(familyId)).toBe(await cuantos(familyId))

    // Y N sirve para la renovación siguiente, 10 minutos después.
    expect(await rotateGrant('tok-N-c1', 'tok-N2-c1', enUnaSemana())).toEqual({ sucesor: 'tok-N2-c1', sessionId, familyId })
  })

  it('2 · R0 a las 25 h: fuera del tope de 24 h se revocan familia y sesión, como hoy', async () => {
    const { familyId, r0 } = await cadenaConRespuestaPerdida('c2')
    await pasaronMinutos(r0, 25 * 60, { purgado: true })

    expect(await rotateGrant(r0, 'tok-N-c2', enUnaSemana())).toEqual({ reutilizado: true })

    expect(await existe('tok-N-c2')).toBe(false)
    expect(await vivos(familyId)).toBe(0)
    expect(await sesion()).toMatchObject({ revokedReason: 'refresh_reuse_detected' })
  })

  it('3 · S ya se usó (el aparato sí recibió S): R0 presentado después revoca familia y sesión', async () => {
    const { familyId, r0, s } = await cadenaConRespuestaPerdida('c3')
    expect(await rotateGrant(s, 'tok-T-c3', enUnaSemana())).toEqual({ sucesor: 'tok-T-c3', sessionId, familyId })
    await pasaronMinutos(r0, 5)

    expect(await rotateGrant(r0, 'tok-N-c3', enUnaSemana())).toEqual({ reutilizado: true })

    expect(await existe('tok-N-c3')).toBe(false)
    expect(await vivos(familyId)).toBe(0)
    expect(await sesion()).toMatchObject({ revokedReason: 'refresh_reuse_detected' })
  })

  it('4 · S anulado presentado después del eco tardío revoca familia y sesión (N incluido)', async () => {
    const { familyId, r0, s } = await cadenaConRespuestaPerdida('c4')
    await pasaronMinutos(r0, 5)
    expect(await rotateGrant(r0, 'tok-N-c4', enUnaSemana())).toMatchObject({ sucesor: 'tok-N-c4' })

    expect(await rotateGrant(s, 'tok-X-c4', enUnaSemana())).toEqual({ reutilizado: true })

    expect(await existe('tok-X-c4')).toBe(false)
    expect(await vivos(familyId)).toBe(0)
    expect(await sesion()).toMatchObject({ revokedReason: 'refresh_reuse_detected' })
  })

  it('5 · dos R0 tardíos a la vez salen con el MISMO N y la sesión sigue', async () => {
    const { familyId, r0, s } = await cadenaConRespuestaPerdida('c5')
    await pasaronMinutos(r0, 5)

    const [a, b] = await Promise.all([rotateGrant(r0, 'tok-A-c5', enUnaSemana()), rotateGrant(r0, 'tok-B-c5', enUnaSemana())])

    expect(a).not.toHaveProperty('reutilizado')
    expect(b).not.toHaveProperty('reutilizado')
    const sucesor = (a as { sucesor: string }).sucesor
    expect((b as { sucesor: string }).sucesor).toBe(sucesor)
    expect(['tok-A-c5', 'tok-B-c5']).toContain(sucesor)
    // Un solo N: R0, S (anulado) y N.
    expect(await cuantos(familyId)).toBe(3)
    expect((await grant(s))!.rotatedToId).toBeNull()
    expect((await sesion()).revokedAt).toBeNull()
    expect(await vivos(familyId)).toBe(3)
  })

  it('5b · el segundo R0 tardío ESPERA el candado de la familia y devuelve el N del primero', async () => {
    const { familyId, r0 } = await cadenaConRespuestaPerdida('c5b')
    await pasaronMinutos(r0, 5)

    await conTransaccionAparcada(async ({ aparcada, lanzar }) => {
      const primero = lanzar(rotateGrant(r0, 'tok-A-c5b', enUnaSemana()))
      const pid = await aTiempo(aparcada.pid, 10_000, 'el primer eco tardío no llegó a su commit')
      const segundo = lanzar(rotateGrant(r0, 'tok-B-c5b', enUnaSemana()))
      expect(await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: SQL_DEL_CANDADO, ms: 5_000 })).not.toBeNull()
      aparcada.soltar()

      const [a, b] = await Promise.all([primero, segundo])

      expect(a).toEqual({ sucesor: 'tok-A-c5b', sessionId, familyId, ecoTardio: { minutosDesdeElConsumo: 5 } })
      expect(b).toEqual({ sucesor: 'tok-A-c5b', sessionId, familyId, retransmision: true })
    })
    expect(await existe('tok-B-c5b')).toBe(false)
    expect((await sesion()).revokedAt).toBeNull()
  })

  describe('6 · R0 tardío del ladrón contra S del dueño: nunca «dueño fuera y ladrón dentro»', () => {
    it('6a · el eco tardío del ladrón va primero: el dueño con S anulado delata el robo y se revoca TODO', async () => {
      const { familyId, r0, s } = await cadenaConRespuestaPerdida('c6a')
      await pasaronMinutos(r0, 5)

      await conTransaccionAparcada(async ({ aparcada, lanzar }) => {
        const ladron = lanzar(rotateGrant(r0, 'tok-ladron-c6a', enUnaSemana()))
        const pid = await aTiempo(aparcada.pid, 10_000, 'el eco tardío del ladrón no llegó a su commit')
        // El dueño leyó S vigente sin candado; con el candado lo encontrará anulado.
        const dueno = lanzar(rotateGrant(s, 'tok-dueno-c6a', enUnaSemana()))
        expect(await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: SQL_DEL_CANDADO, ms: 5_000 })).not.toBeNull()
        aparcada.soltar()

        const [rLadron, rDueno] = await Promise.all([ladron, dueno])

        expect(rLadron).toMatchObject({ sucesor: 'tok-ladron-c6a' })
        expect(rDueno).toEqual({ reutilizado: true })
      })
      expect(await sesion()).toMatchObject({ revokedReason: 'refresh_reuse_detected' })
      expect(await vivos(familyId)).toBe(0) // el N del ladrón también muere
    })

    it('6b · el dueño con S va primero: el R0 del ladrón revoca TODO', async () => {
      const { familyId, r0, s } = await cadenaConRespuestaPerdida('c6b')
      await pasaronMinutos(r0, 5)

      await conTransaccionAparcada(async ({ aparcada, lanzar }) => {
        const dueno = lanzar(rotateGrant(s, 'tok-dueno-c6b', enUnaSemana()))
        const pid = await aTiempo(aparcada.pid, 10_000, 'la rotación del dueño no llegó a su commit')
        const ladron = lanzar(rotateGrant(r0, 'tok-ladron-c6b', enUnaSemana()))
        expect(await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: SQL_DEL_CANDADO, ms: 5_000 })).not.toBeNull()
        aparcada.soltar()

        const [rDueno, rLadron] = await Promise.all([dueno, ladron])

        expect(rDueno).toEqual({ sucesor: 'tok-dueno-c6b', sessionId, familyId })
        expect(rLadron).toEqual({ reutilizado: true })
      })
      expect(await existe('tok-ladron-c6b')).toBe(false)
      expect(await sesion()).toMatchObject({ revokedReason: 'refresh_reuse_detected' })
      expect(await vivos(familyId)).toBe(0)
    })

    it('6c · a la vez, en cualquier orden: la sesión termina revocada y la familia sin un solo grant vivo', async () => {
      const { familyId, r0, s } = await cadenaConRespuestaPerdida('c6c')
      await pasaronMinutos(r0, 5)

      const [rLadron, rDueno] = await Promise.all([
        rotateGrant(r0, 'tok-ladron-c6c', enUnaSemana()),
        rotateGrant(s, 'tok-dueno-c6c', enUnaSemana()),
      ])

      expect([rLadron, rDueno]).toContainEqual({ reutilizado: true })
      expect(await sesion()).toMatchObject({ revokedReason: 'refresh_reuse_detected' })
      expect(await vivos(familyId)).toBe(0)
    })
  })

  describe('7 · revocación por reuso contra eco tardío a la vez: sin interbloqueo y todo revocado', () => {
    it('7a · el eco tardío (R0) va primero; la revocación (P) espera el candado y revoca también N', async () => {
      const { familyId, p, r0 } = await cadenaDeTres('c7a')

      await conTransaccionAparcada(async ({ aparcada, lanzar }) => {
        const eco = lanzar(rotateGrant(r0, 'tok-N-c7a', enUnaSemana()))
        const pid = await aTiempo(aparcada.pid, 10_000, 'el eco tardío no llegó a su commit')
        const reuso = lanzar(rotateGrant(p, 'tok-X-c7a', enUnaSemana()))
        expect(await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: SQL_DEL_CANDADO, ms: 5_000 })).not.toBeNull()
        aparcada.soltar()

        const [rEco, rReuso] = await Promise.all([eco, reuso])

        expect(rEco).toMatchObject({ sucesor: 'tok-N-c7a' })
        expect(rReuso).toEqual({ reutilizado: true })
      })
      expect(await sesion()).toMatchObject({ revokedReason: 'refresh_reuse_detected' })
      expect(await vivos(familyId)).toBe(0)
    })

    it('7b · la revocación (P) va primero; el eco tardío (R0) espera el candado y ya no acuña nada', async () => {
      const { familyId, p, r0 } = await cadenaDeTres('c7b')

      await conTransaccionAparcada(async ({ aparcada, lanzar }) => {
        const reuso = lanzar(rotateGrant(p, 'tok-X-c7b', enUnaSemana()))
        const pid = await aTiempo(aparcada.pid, 10_000, 'la revocación no llegó a su commit')
        const eco = lanzar(rotateGrant(r0, 'tok-N-c7b', enUnaSemana()))
        expect(await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: SQL_DEL_CANDADO, ms: 5_000 })).not.toBeNull()
        aparcada.soltar()

        const [rReuso, rEco] = await Promise.all([reuso, eco])

        expect(rReuso).toEqual({ reutilizado: true })
        expect(rEco).toEqual({ reutilizado: true })
      })
      expect(await existe('tok-N-c7b')).toBe(false)
      expect(await sesion()).toMatchObject({ revokedReason: 'refresh_reuse_detected' })
      expect(await vivos(familyId)).toBe(0)
    })

    it('7c · a la vez: ninguna de las dos truena (sin interbloqueo) y no queda un solo grant vivo', async () => {
      const { familyId, p, r0 } = await cadenaDeTres('c7c')

      const [rEco, rReuso] = await Promise.all([rotateGrant(r0, 'tok-N-c7c', enUnaSemana()), rotateGrant(p, 'tok-X-c7c', enUnaSemana())])

      expect(rReuso).toEqual({ reutilizado: true })
      expect(rEco).toBeDefined()
      expect(await sesion()).toMatchObject({ revokedReason: 'refresh_reuse_detected' })
      expect(await vivos(familyId)).toBe(0)
    })
  })

  it('8 · la ráfaga de seis renovaciones normales con el mismo token sigue pasando sin cerrar la sesión', async () => {
    const familyId = `fam-c8-${SUF}-${Math.random()}`
    await issueGrant(sessionId, familyId, 'tok-rafaga-c8', enUnaSemana())

    const resultados = await Promise.all(
      Array.from({ length: 6 }, (_, i) => rotateGrant('tok-rafaga-c8', `tok-rafaga-c8-${i}`, enUnaSemana())),
    )

    for (const r of resultados) expect(r).not.toHaveProperty('reutilizado')
    const sucesores = new Set(resultados.map(r => (r as { sucesor: string }).sucesor))
    expect(sucesores.size).toBe(1)
    expect(await cuantos(familyId)).toBe(2)
    expect(await vivos(familyId)).toBe(2)
    expect((await sesion()).revokedAt).toBeNull()
    const [sucesor] = [...sucesores]
    expect(await rotateGrant(sucesor, 'tok-rafaga-c8-siguiente', enUnaSemana())).not.toHaveProperty('reutilizado')
  })

  it('9 · eco tardío y luego R0 otra vez antes de 60 s: el MISMO N', async () => {
    const { familyId, r0 } = await cadenaConRespuestaPerdida('c9')
    await pasaronMinutos(r0, 5)

    expect(await rotateGrant(r0, 'tok-N-c9', enUnaSemana())).toMatchObject({ sucesor: 'tok-N-c9', ecoTardio: { minutosDesdeElConsumo: 5 } })
    const otraVez = await rotateGrant(r0, 'tok-otro-c9', enUnaSemana())

    expect(otraVez).toEqual({ sucesor: 'tok-N-c9', sessionId, familyId, retransmision: true })
    expect(await existe('tok-otro-c9')).toBe(false)
    expect(await cuantos(familyId)).toBe(3)
    expect((await sesion()).revokedAt).toBeNull()
  })

  it('10 · dos respuestas perdidas seguidas: sale N2 y N queda anulado (el tope sigue contando desde el consumo de R0)', async () => {
    const { familyId, r0, s } = await cadenaConRespuestaPerdida('c10')
    await pasaronMinutos(r0, 5)
    expect(await rotateGrant(r0, 'tok-N-c10', enUnaSemana())).toMatchObject({ sucesor: 'tok-N-c10' })

    // La respuesta con N también se perdió; el aparato vuelve 20 minutos después, todavía con R0.
    await pasaronMinutos(r0, 25)
    const segunda = await rotateGrant(r0, 'tok-N2-c10', enUnaSemana())

    expect(segunda).toEqual({ sucesor: 'tok-N2-c10', sessionId, familyId, ecoTardio: { minutosDesdeElConsumo: 25 } })
    const [gR0, gS, gN, gN2] = await Promise.all([grant(r0), grant(s), grant('tok-N-c10'), grant('tok-N2-c10')])
    for (const anulado of [gS!, gN!]) {
      expect(anulado.consumedAt).not.toBeNull()
      expect(anulado.rotatedToId).toBeNull()
    }
    expect(gR0!.rotatedToId).toBe(gN2!.id)
    expect(gN2).toMatchObject({ consumedAt: null, revokedAt: null })
    expect((await sesion()).revokedAt).toBeNull()
    expect(await vivos(familyId)).toBe(4)
  })

  it('11 · esperar el candado más que el presupuesto de la transacción es FALLA OPERATIVA (503): ni reuso ni éxito', async () => {
    const familyId = `fam-c11-${SUF}-${Math.random()}`
    await issueGrant(sessionId, familyId, 'tok-c11', enUnaSemana())

    // Alguien retiene el candado de la familia 7 s: más que los 5 s de la transacción de la renovación.
    let avisarTomado: () => void = () => undefined
    const tomado = new Promise<void>(r => (avisarTomado = r))
    const retenedor = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('refreshGrant:' || ${familyId}, 0))::text`
        avisarTomado()
        await new Promise(r => setTimeout(r, 7_000))
      },
      { timeout: 20_000 },
    )
    await tomado

    const error = await rotateGrant('tok-c11', 'tok-c11-sucesor', enUnaSemana()).then(
      () => null,
      e => e,
    )
    await retenedor

    expect(error).toMatchObject({ statusCode: 503, code: 'SESSION_REFRESH_RETRY' })
    // Nada cambió: el aparato reintenta con el MISMO token y sigue dentro.
    expect(await grant('tok-c11')).toMatchObject({ consumedAt: null, revokedAt: null })
    expect(await existe('tok-c11-sucesor')).toBe(false)
    expect((await sesion()).revokedAt).toBeNull()
    expect(await rotateGrant('tok-c11', 'tok-c11-reintento', enUnaSemana())).toEqual({ sucesor: 'tok-c11-reintento', sessionId, familyId })
  })

  it('12 · si el re-enlace de R0 no afecta exactamente una fila, el eco tardío se revierte COMPLETO (S sin consumir, N no existe)', async () => {
    const { r0, s } = await cadenaConRespuestaPerdida('c12')
    await pasaronMinutos(r0, 5)
    const idR0 = (await grant(r0))!.id

    // Un escritor que NO toma el candado (hoy no existe: es la defensa en profundidad) cambia el enlace de R0 justo antes
    // de que el eco tardío lo re-enlace — después de que ya anuló S y creó N dentro de la transacción.
    const escrituras: string[] = []
    const original = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>
    const espia = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((cuerpo: (tx: any) => Promise<unknown>, opciones?: unknown) =>
      original(
        async (tx: any) =>
          cuerpo(
            new Proxy(tx, {
              get(objetivo, prop) {
                if (prop !== 'refreshGrant') return conDueno(objetivo, prop)
                return new Proxy(objetivo.refreshGrant, {
                  get(modelo, metodo) {
                    if (metodo === 'create') {
                      return async (args: unknown) => {
                        escrituras.push('crea N')
                        return modelo.create(args)
                      }
                    }
                    if (metodo !== 'updateMany') return conDueno(modelo, metodo)
                    return async (args: { where?: { id?: string; rotatedToId?: string } }) => {
                      if (args.where?.id === idR0 && args.where.rotatedToId) {
                        escrituras.push('re-enlaza R0')
                        await prisma.refreshGrant.update({ where: { id: idR0 }, data: { rotatedToId: 'enlace-ajeno' } })
                      } else {
                        escrituras.push(args.where?.id ? 'anula S' : 'otra')
                      }
                      return modelo.updateMany(args)
                    }
                  },
                })
              },
            }),
          ),
        opciones,
      )) as never)
    try {
      const r = await rotateGrant(r0, 'tok-N-c12', enUnaSemana())

      // Tras revertir, se decide otra vez con el candado: sin eco del ganador y con un enlace roto, es reuso.
      expect(r).toEqual({ reutilizado: true })
    } finally {
      espia.mockRestore()
    }
    // La prueba del rollback: dentro de la transacción del eco tardío SÍ se anuló S y SÍ se creó N antes de que fallara
    // el re-enlace (la tercera escritura)…
    expect(escrituras).toEqual(['anula S', 'crea N', 're-enlaza R0'])
    // …y las dos desaparecieron con la transacción.
    expect(await existe('tok-N-c12')).toBe(false)
    expect((await grant(s))!.consumedAt).toBeNull()
  })
})
