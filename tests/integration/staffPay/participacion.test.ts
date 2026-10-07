// tests/integration/staffPay/participacion.test.ts — participación por sede, fase 3 B9 (diseño r7 + r6.3/r6.6, Codex r7).
//
// B9 sólo ESCRIBE ventanas y pone candados y barreras: ningún lector de dinero las usa todavía. Aquí se prueban la apertura
// de ventanas al activar la organización, el presupuesto ÚNICO de espera de candados por transacción, el candado de fila de
// la sede (escritores en `FOR KEY SHARE`, traslado y borrados en `FOR UPDATE` antes de mirar la historia) y las barreras.
// Las carreras corren el código REAL, pausado en un punto exacto, con la espera comprobada en `pg_stat_activity` antes de
// soltar. Fechas de 2026 en UTC; CDMX = UTC−6, Tijuana = UTC−7.
import type { Request, Response } from 'express'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { transferVenue } from '@/controllers/dashboard/venues.superadmin.controller'
import { deleteVenue } from '@/services/dashboard/venue.dashboard.service'
import {
  cleanupExpiredLiveDemos,
  createDisposableDemoSessionDeletion,
  deleteDisposableDemoSession,
} from '@/services/cleanup/liveDemoCleanup.service'
import { activarPagoAlPersonal } from '@/services/dashboard/staffPay/activacion.service'
import { agregarAjusteManual } from '@/services/dashboard/staffPay/ajustesManuales.service'
import { cerrarPeriodo, previewCierre, TIMEOUT_CIERRE_MS } from '@/services/dashboard/staffPay/cierre.service'
import { liquidarDiferencia, previewLiquidacion } from '@/services/dashboard/staffPay/liquidacion.service'
import * as participacion from '@/services/dashboard/staffPay/participacion'
import { PresupuestoDeEspera } from '@/services/dashboard/staffPay/periodosGuardados'
import { dbDateComoFecha, fechaComoDbDate, venuePeriodRange } from '@/services/dashboard/staffPay/periodos'
import {
  barreraDeLaFilaDeOrganizacion,
  barreraDeLaOrganizacion,
  barreraDeLaSede,
  borrarMundo,
  CIERRE_EN_CURSO,
  clase,
  conCandadoRetenido,
  confirmadas,
  crearMundo,
  crearSede,
  Mundo,
  tablaMindform,
} from './_mundo'
import { cobro, comision, congelar, esquema, reembolso } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  assertPermisoEnTodasLasSedes: jest.fn(async () => undefined),
}))

const AHORA = new Date('2026-09-02T12:00:00Z') // agosto ya terminó en CDMX; septiembre abierto
const ACTIVA_EL = new Date('2026-09-20T18:00:00Z') // activar el 20-sep: mensual ⇒ desde el 1-sep
const OPERACION_EN_CURSO = {
  statusCode: 409,
  code: 'OPERACION_EN_CURSO',
  message: 'Otra operación está cambiando esta sede o su organización; intenta de nuevo en un momento',
}
const dormir = (ms: number) => new Promise(r => setTimeout(r, ms))

let m: Mundo
const orgsExtra: string[] = []
const espias: jest.SpyInstance[] = []
/** Pausas que una prueba fallida dejó puestas: se sueltan antes de limpiar (si no, la limpieza espera sus candados). */
const sueltas: Array<() => void> = []
let n = 0
beforeEach(async () => {
  m = await crearMundo('participacion')
  ;(global as any).__sedes = [m.venueId]
})
afterEach(async () => {
  for (const soltar of sueltas.splice(0)) soltar()
  for (const e of espias.splice(0)) e.mockRestore()
  for (const id of orgsExtra.splice(0)) {
    // Una sede trasladada ya no la borra `borrarMundo` (es de la otra organización).
    await prisma.serviceEarning.deleteMany({ where: { organizationId: id } })
    await prisma.venue.deleteMany({ where: { organizationId: id } })
    await prisma.staffOrganization.deleteMany({ where: { organizationId: id } })
    await prisma.organization.deleteMany({ where: { id } })
  }
  await borrarMundo(m)
})

// ── utilidades ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function otraOrg(s: string) {
  const o = await prisma.organization.create({
    data: { name: `${m.key}-${s}`, slug: `${m.key}-${s}`, email: `${m.key}-${s}@example.test`, phone: '5500000000' },
  })
  orgsExtra.push(o.id)
  return o.id
}

/** Una sucursal demo desechable (LIVE_DEMO), con su visitante y su sesión ya caducada. */
async function demo(s: string) {
  const { venueId, productId } = await crearSede(m.orgId, m.key, s)
  await prisma.venue.update({ where: { id: venueId }, data: { status: 'LIVE_DEMO' } })
  const visitante = await prisma.staff.create({
    data: { email: `${m.key}-${s}-visitante@example.test`, firstName: 'Visitante', lastName: s, active: true },
  })
  const sesion = await prisma.liveDemoSession.create({
    data: { sessionId: `${m.key}-${s}`, venueId, staffId: visitante.id, expiresAt: new Date(Date.now() - 60_000) },
  })
  return { venueId, productId, visitante: visitante.id, sesion: { id: sesion.id, venueId, staffId: visitante.id } }
}

const periodo = (start: string, end: string, venueIds: string[], status: 'OPEN' | 'CLOSED' = 'OPEN') =>
  prisma.servicePayPeriod.create({
    data: {
      organizationId: m.orgId,
      periodStart: fechaComoDbDate(start),
      periodEnd: fechaComoDbDate(end),
      venueIds,
      status,
      ...(status === 'CLOSED' ? { closedAt: new Date(), closedById: m.owner, closeFingerprint: 'manual' } : {}),
    },
  })

const activar = () => activarPagoAlPersonal({ userId: m.owner, venueId: m.venueId, periodicidad: 'MONTHLY', ahora: ACTIVA_EL })
const ajuste = (sede: string, amount = 50) =>
  agregarAjusteManual({
    userId: m.owner,
    venueId: m.venueId,
    sede,
    staffId: m.ana,
    amount,
    reason: 'Bono de prueba B9',
    fecha: '2026-08-20',
    clientKey: `${m.key}-aj-${++n}`,
    ahora: AHORA,
  })

/** El controlador REAL del traslado, sin HTTP: el error que pasó a `next`, o `{ status, body }`. */
async function trasladar(venueId: string, targetOrganizationId: string): Promise<any> {
  let error: unknown = null
  let status = 0
  let body: unknown = null
  const res = { status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res) } as unknown as Response
  const req = { params: { venueId }, body: { targetOrganizationId }, authContext: { userId: m.owner } } as unknown as Request
  await transferVenue(req, res, (e?: unknown) => (error = e))
  return error ?? { status, body }
}

/** Resultado de una operación sin que la prueba truene: su valor o su error, y cuánto tardó. */
async function resultado<T>(p: Promise<T>): Promise<{ valor: T | null; error: any; ms: number }> {
  const t = Date.now()
  return p.then(
    valor => ({ valor, error: null, ms: Date.now() - t }),
    (error: unknown) => ({ valor: null, error, ms: Date.now() - t }),
  )
}

/** Pausa la PRIMERA llamada a `participacion[nombre]` DESPUÉS de que hizo su trabajo (con sus candados tomados). */
function pausarDespuesDe(nombre: 'bloquearSedesDeLaOrganizacion' | 'historiaDeSede') {
  let soltar!: () => void
  const suelto = new Promise<void>(r => (soltar = r))
  let avisar!: () => void
  const llego = new Promise<void>(r => (avisar = r))
  const real = (participacion as any)[nombre]
  const espia = jest.spyOn(participacion, nombre)
  espias.push(espia)
  espia.mockImplementationOnce((async (...a: unknown[]) => {
    const r = await real(...a)
    avisar()
    await suelto
    return r
  }) as any)
  sueltas.push(() => soltar())
  return { llego, soltar: () => soltar() }
}

/**
 * Espera a ver una sesión DETENIDA por un candado cuyo SQL contiene `fragmento` (las sentencias de candado de B9 llevan un
 * comentario que las nombra). Devuelve false si la operación terminó antes (`mientras` deja de cumplirse).
 */
async function esperarBloqueo(fragmento: string, mientras: () => boolean): Promise<boolean> {
  const limite = Date.now() + 15_000
  for (;;) {
    if (!mientras()) return false
    const [{ n: detenidas }] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${`%${fragmento}%`}`
    if (detenidas > 0) return true
    if (Date.now() > limite) throw new Error(`Nadie quedó detenido en «${fragmento}»`)
    await dormir(10)
  }
}

/** El invariante de B9: ningún devengo de una sede que ya no existe o que ya es de otra organización. */
async function devengosHuerfanos(): Promise<number> {
  const [{ n: huerfanos }] = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM "ServiceEarning" e
    WHERE e."organizationId" = ${m.orgId}
      AND NOT EXISTS (SELECT 1 FROM "Venue" v WHERE v.id = e."venueId" AND v."organizationId" = e."organizationId")`
  return huerfanos
}

const sedeDe = (venueId: string) => prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true, status: true } })
/** La demo sigue completa: su sede (de la organización y LIVE_DEMO), su visitante y su sesión. */
const demoIntacta = async (d: Awaited<ReturnType<typeof demo>>) => {
  expect(await sedeDe(d.venueId)).toMatchObject({ organizationId: m.orgId, status: 'LIVE_DEMO' })
  expect(await prisma.staff.count({ where: { id: d.visitante } })).toBe(1)
  expect(await prisma.liveDemoSession.count({ where: { id: d.sesion.id } })).toBe(1)
}
const devengosDe = (venueId: string) => prisma.serviceEarning.findMany({ where: { venueId }, select: { amount: true }, take: 10 })

// ── activar la organización (r6.1, r6.6.2) ─────────────────────────────────────────────────────────────────────────────

describe('activar la organización abre una ventana por cada sede con plan (B9)', () => {
  it('todas las sedes con plan desde el inicio, la sin plan ninguna; el ActivityLog las nombra; repetir no abre nada', async () => {
    const tij = await crearSede(m.orgId, m.key, 'tij')
    await prisma.venue.update({ where: { id: tij.venueId }, data: { timezone: 'America/Tijuana' } })
    const sinPlan = await crearSede(m.orgId, m.key, 'sin-plan')
    const conPlan = [m.venueId, tij.venueId].sort()
    ;(global as any).__sedes = [tij.venueId, m.venueId]

    expect(await activar()).toEqual({ startDate: '2026-09-01', yaActivado: false })
    const vs = await prisma.staffPayVenueWindow.findMany({ where: { organizationId: m.orgId }, orderBy: { venueId: 'asc' }, take: 10 })
    expect(vs.map(v => [v.venueId, dbDateComoFecha(v.desde), v.hasta, v.activadaPor, v.desactivadaPor])).toEqual(
      conPlan.map(id => [id, '2026-09-01', null, m.owner, null]),
    )
    expect(await prisma.staffPayVenueWindow.count({ where: { venueId: sinPlan.venueId } })).toBe(0)
    const log = await prisma.activityLog.findFirstOrThrow({ where: { action: 'SERVICE_PAY_ACTIVATED', entityId: m.orgId } })
    expect(log.data).toMatchObject({ startDate: '2026-09-01', sedes: conPlan })

    // `desde` es un día civil: medianoche en la zona de CADA sede.
    const desde = dbDateComoFecha(vs[0].desde)
    expect(venuePeriodRange({ start: desde, end: desde }, 'America/Mexico_City').from.toISOString()).toBe('2026-09-01T06:00:00.000Z')
    expect(venuePeriodRange({ start: desde, end: desde }, 'America/Tijuana').from.toISOString()).toBe('2026-09-01T07:00:00.000Z')

    expect(await activar()).toEqual({ startDate: '2026-09-01', yaActivado: true })
    expect(await prisma.staffPayVenueWindow.count({ where: { organizationId: m.orgId } })).toBe(2)
    expect(await prisma.activityLog.count({ where: { action: 'SERVICE_PAY_ACTIVATED', entityId: m.orgId } })).toBe(1)
  })

  it('una sede resuelta con plan que bajo el candado ya es de otra organización: 409 completo, no activa ni abre nada', async () => {
    const z = await otraOrg('z-ajena')
    const ajena = await crearSede(z, m.key, 'ajena')
    ;(global as any).__sedes = [m.venueId, ajena.venueId]
    await expect(activar()).rejects.toMatchObject({
      statusCode: 409,
      code: 'SEDE_EN_OTRA_ORGANIZACION',
      message: `La sede ${m.key}-ajena ya no pertenece a esta organización`,
    })
    ;(global as any).__sedes = [m.venueId, `${m.key}-borrada`]
    await expect(activar()).rejects.toMatchObject({
      code: 'SEDE_EN_OTRA_ORGANIZACION',
      message: `La sede ${m.key}-borrada ya no pertenece a esta organización`,
    })
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: m.orgId }, select: { staffPayStartDate: true } })).toEqual({
      staffPayStartDate: null,
    })
    expect(await prisma.staffPayVenueWindow.count({ where: { organizationId: m.orgId } })).toBe(0)
  })
})

// ── presupuesto único de espera (r7.2, Codex r7 #19 y #24) ──────────────────────────────────────────────────────────────

describe('un solo presupuesto de espera por transacción (B9)', () => {
  /** Retiene `b` `ms` desde que la operación llega a su candado, o la suelta si la operación terminó antes. */
  const retener = async (b: Awaited<ReturnType<typeof barreraDeLaSede>>, ms: number, mientras: () => boolean) => {
    try {
      if (await b.esperarA(1, { mientras })) await dormir(ms)
    } finally {
      await b.soltar()
    }
  }

  it('esperas de 4 s + 4 s + 3 s en los candados de activar: 409 antes de 10 s (no el P2028 de su transacción)', async () => {
    const b1 = await barreraDeLaOrganizacion(m.orgId)
    const b2 = await barreraDeLaFilaDeOrganizacion(m.orgId)
    const b3 = await barreraDeLaSede(m.venueId)
    let termino = false
    const mientras = () => !termino
    try {
      const op = resultado(activar()).finally(() => (termino = true))
      const [r] = await Promise.all([op, retener(b1, 4_000, mientras), retener(b2, 4_000, mientras), retener(b3, 3_000, mientras)])
      expect(r.error).toMatchObject(OPERACION_EN_CURSO)
      expect(r.ms).toBeGreaterThanOrEqual(5_500)
      expect(r.ms).toBeLessThan(10_000)
    } finally {
      await Promise.all([b1.soltar(), b2.soltar(), b3.soltar()])
    }
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: m.orgId }, select: { staffPayStartDate: true } })).toEqual({
      staffPayStartDate: null,
    })
    expect(await prisma.staffPayVenueWindow.count({ where: { organizationId: m.orgId } })).toBe(0)
  }, 60_000)

  it('dos sedes retenidas 4 s cada una comparten el presupuesto: 409 a los ~6 s, no éxito a los 8', async () => {
    const otra = await crearSede(m.orgId, m.key, 's2')
    const [v1, v2] = [m.venueId, otra.venueId].sort()
    ;(global as any).__sedes = [v2, v1]
    const b1 = await barreraDeLaSede(v1)
    const b2 = await barreraDeLaSede(v2)
    let termino = false
    const mientras = () => !termino
    try {
      const op = resultado(activar()).finally(() => (termino = true))
      const [r] = await Promise.all([op, retener(b1, 4_000, mientras), retener(b2, 4_000, mientras)])
      expect(r.error).toMatchObject(OPERACION_EN_CURSO)
      expect(r.ms).toBeGreaterThanOrEqual(5_500)
      expect(r.ms).toBeLessThan(8_000)
    } finally {
      await Promise.all([b1.soltar(), b2.soltar()])
    }
    expect(await prisma.staffPayVenueWindow.count({ where: { organizationId: m.orgId } })).toBe(0)
  }, 60_000)

  it('el cierre ya no espera sin tope: su presupuesto es de 30 s y, retenido más que eso, contesta 409 CIERRE_EN_CURSO', async () => {
    expect(PresupuestoDeEspera.para(TIMEOUT_CIERRE_MS).restanteMs()).toBe(30_000)
    expect(PresupuestoDeEspera.para(10_000).restanteMs()).toBe(6_000)
    await tablaMindform(m)
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const { huella } = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: AHORA })
    // Sin esperar 30 s reales: el presupuesto que pide el cierre, recortado a 2 s (el valor real se fija arriba).
    const real = PresupuestoDeEspera.para
    const espia = jest
      .spyOn(PresupuestoDeEspera, 'para')
      .mockImplementation(ms => (ms === TIMEOUT_CIERRE_MS ? new PresupuestoDeEspera(2_000) : real(ms)))
    espias.push(espia)
    const r = await conCandadoRetenido(await barreraDeLaOrganizacion(m.orgId), () =>
      cerrarPeriodo({
        userId: m.owner,
        venueId: m.venueId,
        fecha: '2026-08-15',
        ahora: AHORA,
        huellaEsperada: huella,
        confirmarHuerfanas: true,
      }),
    )
    expect(espia).toHaveBeenCalledWith(TIMEOUT_CIERRE_MS)
    expect(r.error).toMatchObject(CIERRE_EN_CURSO)
    expect(r.ms).toBeGreaterThanOrEqual(1_500)
    expect(r.ms).toBeLessThan(10_000)
    expect(await prisma.serviceEarning.count({ where: { organizationId: m.orgId } })).toBe(0)
  }, 60_000)
})

// ── activar contra trasladar (r7.1, Codex r7 #23) ───────────────────────────────────────────────────────────────────────

describe('activar y trasladar la misma sede a la vez: sin bloqueo mutuo, una gana (B9)', () => {
  it('gana la activación: el traslado espera la fila de la organización, ve la ventana y contesta 409', async () => {
    const b = await crearSede(m.orgId, m.key, 'b')
    const z = await otraOrg('z')
    ;(global as any).__sedes = [m.venueId, b.venueId]
    const pausa = pausarDespuesDe('bloquearSedesDeLaOrganizacion')
    const act = resultado(activar())
    await Promise.race([pausa.llego, act])
    let termino = false
    const tras = trasladar(b.venueId, z).finally(() => (termino = true))
    expect(await esperarBloqueo('B9:organizacion', () => !termino)).toBe(true)
    pausa.soltar()
    const [a, t] = await Promise.all([act, tras])
    expect(a.valor).toEqual({ startDate: '2026-09-01', yaActivado: false })
    expect(t).toMatchObject({
      statusCode: 409,
      code: 'SEDE_CON_PAGO_AL_PERSONAL',
      message: 'Esta sede tiene historial de pago al personal; no se puede trasladar a otra organización',
    })
    expect(await sedeDe(b.venueId)).toMatchObject({ organizationId: m.orgId })
    expect(await prisma.staffPayVenueWindow.count({ where: { venueId: b.venueId, organizationId: m.orgId } })).toBe(1)
  }, 60_000)

  it('gana el traslado: la activación espera, reintenta y contesta 409 SEDE_EN_OTRA_ORGANIZACION; ninguna ventana de A en la sede de Z', async () => {
    const b = await crearSede(m.orgId, m.key, 'b')
    const z = await otraOrg('z')
    ;(global as any).__sedes = [m.venueId, b.venueId]
    const pausa = pausarDespuesDe('historiaDeSede')
    const tras = trasladar(b.venueId, z)
    await Promise.race([pausa.llego, tras])
    let termino = false
    const act = resultado(activar()).finally(() => (termino = true))
    expect(await esperarBloqueo('B9:organizacion', () => !termino)).toBe(true)
    pausa.soltar()
    const [t, a] = await Promise.all([tras, act])
    expect(t).toMatchObject({ status: 200 })
    expect(a.error).toMatchObject({ statusCode: 409, code: 'SEDE_EN_OTRA_ORGANIZACION' })
    expect(await sedeDe(b.venueId)).toMatchObject({ organizationId: z })
    expect(await prisma.staffPayVenueWindow.count({ where: { venueId: b.venueId } })).toBe(0)
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: m.orgId }, select: { staffPayStartDate: true } })).toEqual({
      staffPayStartDate: null,
    })
  }, 60_000)
})

// ── primer devengo contra el borrado y el traslado (el contraejemplo de Codex r6/r7) ────────────────────────────────────

describe('el primer devengo de una sede contra su borrado o su traslado: nunca $50 en una sede inexistente (B9)', () => {
  /** Borra la demo pausada con su fila ya bloqueada (FOR UPDATE), antes de mirar la historia. */
  function borradoPausado() {
    let soltar!: () => void
    const suelto = new Promise<void>(r => (soltar = r))
    let avisar!: () => void
    const llego = new Promise<void>(r => (avisar = r))
    const borrar = createDisposableDemoSessionDeletion({
      afterVenueLock: async () => {
        avisar()
        await suelto
      },
    })
    sueltas.push(() => soltar())
    return { borrar, llego, soltar: () => soltar() }
  }
  const DEMO_RECHAZADA = { statusCode: 409, code: 'LIVE_DEMO_CON_PAGO_AL_PERSONAL' }

  describe('el ajuste manual de +$50', () => {
    it('gana el borrado: el ajuste espera la fila, reintenta y contesta que la sede ya no es de la organización', async () => {
      const d = await demo('demo')
      await periodo('2026-08-01', '2026-08-31', [m.venueId, d.venueId])
      ;(global as any).__sedes = [m.venueId, d.venueId]
      const borrado = borradoPausado()
      const del = resultado(borrado.borrar(d.sesion))
      await Promise.race([borrado.llego, del])
      let termino = false
      const aj = resultado(ajuste(d.venueId)).finally(() => (termino = true))
      expect(await esperarBloqueo('B9:sede:escritor', () => !termino)).toBe(true)
      borrado.soltar()
      const [x, a] = await Promise.all([del, aj])
      expect(x.error).toBeNull()
      expect(await sedeDe(d.venueId)).toBeNull()
      expect(a.error).toMatchObject({ statusCode: 409, code: 'SEDE_EN_OTRA_ORGANIZACION' })
      expect(await devengosDe(d.venueId)).toEqual([])
      expect(await devengosHuerfanos()).toBe(0)
    }, 60_000)

    it('gana el ajuste: el borrado espera la fila, ve los $50 y se rechaza con la demo intacta', async () => {
      const d = await demo('demo')
      await periodo('2026-08-01', '2026-08-31', [m.venueId, d.venueId])
      ;(global as any).__sedes = [m.venueId, d.venueId]
      const pausa = pausarDespuesDe('bloquearSedesDeLaOrganizacion')
      const aj = resultado(ajuste(d.venueId))
      await Promise.race([pausa.llego, aj])
      let termino = false
      const del = resultado(deleteDisposableDemoSession(d.sesion)).finally(() => (termino = true))
      expect(await esperarBloqueo('id, name, status FROM "Venue"', () => !termino)).toBe(true)
      pausa.soltar()
      const [a, x] = await Promise.all([aj, del])
      expect(a.valor).toMatchObject({ sede: d.venueId, amount: '50.00' })
      expect(x.error).toMatchObject(DEMO_RECHAZADA)
      await demoIntacta(d)
      expect((await devengosDe(d.venueId)).map(e => e.amount.toFixed(2))).toEqual(['50.00'])
      expect(await devengosHuerfanos()).toBe(0)
    }, 60_000)
  })

  describe('el cierre', () => {
    async function conClaseEnLaDemo() {
      const d = await demo('demo')
      await tablaMindform(m, d.venueId)
      await clase(m, {
        staffId: m.ana,
        inicioIso: '2026-08-04T14:00:00Z',
        reservas: confirmadas(8),
        venueId: d.venueId,
        productId: d.productId,
      })
      await periodo('2026-08-01', '2026-08-31', [m.venueId, d.venueId])
      ;(global as any).__sedes = [m.venueId, d.venueId]
      const { huella } = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: AHORA })
      const cerrar = () =>
        cerrarPeriodo({
          userId: m.owner,
          venueId: m.venueId,
          fecha: '2026-08-15',
          ahora: AHORA,
          huellaEsperada: huella,
          confirmarHuerfanas: true,
        })
      return { d, cerrar }
    }

    it('gana el borrado: el cierre espera la fila, reintenta y no congela nada de la sede borrada', async () => {
      const { d, cerrar } = await conClaseEnLaDemo()
      const borrado = borradoPausado()
      const del = resultado(borrado.borrar(d.sesion))
      await Promise.race([borrado.llego, del])
      let termino = false
      const ci = resultado(cerrar()).finally(() => (termino = true))
      expect(await esperarBloqueo('B9:sede:escritor', () => !termino)).toBe(true)
      borrado.soltar()
      const [x, c] = await Promise.all([del, ci])
      expect(x.error).toBeNull()
      expect(c.error).not.toBeNull() // la huella ya no es la que se revisó: el dueño revisa de nuevo
      expect(await devengosDe(d.venueId)).toEqual([])
      expect(await devengosHuerfanos()).toBe(0)
    }, 60_000)

    it('gana el cierre: congela la clase de la demo y el borrado se rechaza con la demo intacta', async () => {
      const { d, cerrar } = await conClaseEnLaDemo()
      const pausa = pausarDespuesDe('bloquearSedesDeLaOrganizacion')
      const ci = resultado(cerrar())
      await Promise.race([pausa.llego, ci])
      let termino = false
      const del = resultado(deleteDisposableDemoSession(d.sesion)).finally(() => (termino = true))
      expect(await esperarBloqueo('id, name, status FROM "Venue"', () => !termino)).toBe(true)
      pausa.soltar()
      const [c, x] = await Promise.all([ci, del])
      expect(c.valor).toMatchObject({ yaCerrado: false, total: '570.00' })
      expect(x.error).toMatchObject(DEMO_RECHAZADA)
      await demoIntacta(d)
      expect((await devengosDe(d.venueId)).map(e => e.amount.toFixed(2))).toEqual(['570.00'])
      expect(await devengosHuerfanos()).toBe(0)
    }, 60_000)
  })

  describe('la liquidación de una diferencia', () => {
    // Agosto cerrado con la demo en su alcance y sin devengo de su clase (p. ej. excluida al cerrar y reincluida después):
    // la liquidación de septiembre escribe su PRIMER devengo, +$570.
    async function conDiferenciaEnLaDemo() {
      const d = await demo('demo')
      await tablaMindform(m, d.venueId)
      const cs = await clase(m, {
        staffId: m.ana,
        inicioIso: '2026-08-04T14:00:00Z',
        reservas: confirmadas(8),
        venueId: d.venueId,
        productId: d.productId,
      })
      await periodo('2026-08-01', '2026-08-31', [m.venueId, d.venueId], 'CLOSED')
      await periodo('2026-09-01', '2026-09-30', [m.venueId, d.venueId])
      ;(global as any).__sedes = [m.venueId, d.venueId]
      const pv = await previewLiquidacion({
        userId: m.owner,
        venueId: d.venueId,
        classSessionId: cs,
        destinoFecha: '2026-09-10',
        ahora: AHORA,
      })
      expect(pv.total).toBe('570.00')
      const liquidar = () =>
        liquidarDiferencia({
          userId: m.owner,
          venueId: d.venueId,
          classSessionId: cs,
          periodoOrigenId: pv.periodoOrigen!.id,
          huellaEsperada: pv.huella,
          solicitudId: `${m.key}-liq`,
          destinoFecha: '2026-09-10',
          ahora: AHORA,
        })
      return { d, liquidar }
    }

    it('gana el borrado: la liquidación espera la fila, reintenta y no escribe nada', async () => {
      const { d, liquidar } = await conDiferenciaEnLaDemo()
      const borrado = borradoPausado()
      const del = resultado(borrado.borrar(d.sesion))
      await Promise.race([borrado.llego, del])
      let termino = false
      const lq = resultado(liquidar()).finally(() => (termino = true))
      expect(await esperarBloqueo('B9:sede:escritor', () => !termino)).toBe(true)
      borrado.soltar()
      const [x, l] = await Promise.all([del, lq])
      expect(x.error).toBeNull()
      expect([404, 409]).toContain(l.error?.statusCode)
      expect(await devengosDe(d.venueId)).toEqual([])
      expect(await devengosHuerfanos()).toBe(0)
    }, 60_000)

    it('gana la liquidación: escribe los +$570 y el borrado se rechaza con la demo intacta', async () => {
      const { d, liquidar } = await conDiferenciaEnLaDemo()
      const pausa = pausarDespuesDe('bloquearSedesDeLaOrganizacion')
      const lq = resultado(liquidar())
      await Promise.race([pausa.llego, lq])
      let termino = false
      const del = resultado(deleteDisposableDemoSession(d.sesion)).finally(() => (termino = true))
      expect(await esperarBloqueo('id, name, status FROM "Venue"', () => !termino)).toBe(true)
      pausa.soltar()
      const [l, x] = await Promise.all([lq, del])
      expect(l.valor).toMatchObject({ lineas: [{ staffId: m.ana, amount: '570.00' }], yaLiquidada: false })
      expect(x.error).toMatchObject(DEMO_RECHAZADA)
      await demoIntacta(d)
      expect(await devengosHuerfanos()).toBe(0)
    }, 60_000)
  })

  describe('el ajuste de +$50 contra el TRASLADO de la sede', () => {
    it('gana el traslado: el ajuste espera la fila, reintenta y contesta que la sede ya es de otra organización', async () => {
      const b = await crearSede(m.orgId, m.key, 'b')
      const z = await otraOrg('z')
      await periodo('2026-08-01', '2026-08-31', [m.venueId, b.venueId])
      ;(global as any).__sedes = [m.venueId, b.venueId]
      const pausa = pausarDespuesDe('historiaDeSede')
      const tras = trasladar(b.venueId, z)
      await Promise.race([pausa.llego, tras])
      let termino = false
      const aj = resultado(ajuste(b.venueId)).finally(() => (termino = true))
      expect(await esperarBloqueo('B9:sede:escritor', () => !termino)).toBe(true)
      pausa.soltar()
      const [t, a] = await Promise.all([tras, aj])
      expect(t).toMatchObject({ status: 200 })
      expect(a.error).toMatchObject({ statusCode: 409, code: 'SEDE_EN_OTRA_ORGANIZACION' })
      expect(await sedeDe(b.venueId)).toMatchObject({ organizationId: z })
      expect(await devengosDe(b.venueId)).toEqual([])
      expect(await devengosHuerfanos()).toBe(0)
    }, 60_000)

    it('gana el ajuste: el traslado espera la fila de la sede, ve los $50 y contesta 409; la sede se queda', async () => {
      const b = await crearSede(m.orgId, m.key, 'b')
      const z = await otraOrg('z')
      await periodo('2026-08-01', '2026-08-31', [m.venueId, b.venueId])
      ;(global as any).__sedes = [m.venueId, b.venueId]
      const pausa = pausarDespuesDe('bloquearSedesDeLaOrganizacion')
      const aj = resultado(ajuste(b.venueId))
      await Promise.race([pausa.llego, aj])
      let termino = false
      const tras = trasladar(b.venueId, z).finally(() => (termino = true))
      expect(await esperarBloqueo('B9:sede:exclusivo', () => !termino)).toBe(true)
      pausa.soltar()
      const [a, t] = await Promise.all([aj, tras])
      expect(a.valor).toMatchObject({ sede: b.venueId, amount: '50.00' })
      expect(t).toMatchObject({ statusCode: 409, code: 'SEDE_CON_PAGO_AL_PERSONAL' })
      expect(await sedeDe(b.venueId)).toMatchObject({ organizationId: m.orgId })
      expect(await devengosHuerfanos()).toBe(0)
    }, 60_000)
  })
})

// ── barreras (r6.6.5) ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('barreras: una sede con historia de pago al personal no se traslada ni se borra (B9)', () => {
  const conVentana = async (s: string, status?: 'TRIAL') => {
    const { venueId } = await crearSede(m.orgId, m.key, s)
    if (status) await prisma.venue.update({ where: { id: venueId }, data: { status } })
    await prisma.staffPayVenueWindow.create({
      data: { organizationId: m.orgId, venueId, desde: fechaComoDbDate('2026-09-01'), activadaPor: m.owner },
    })
    return venueId
  }
  const conDevengo = async (s: string, status?: 'TRIAL') => {
    const { venueId } = await crearSede(m.orgId, m.key, s)
    if (status) await prisma.venue.update({ where: { id: venueId }, data: { status } })
    const p = await periodo('2026-07-01', '2026-07-31', [venueId], 'CLOSED')
    await congelar(m, p.id, { fuente: 'COMMISSION', sourceId: `${m.key}-${s}`, staffId: m.ana, monto: 50, venueId })
    return venueId
  }

  it('traslado: con ventana o con devengos, 409 SEDE_CON_PAGO_AL_PERSONAL; sin historia, como hoy', async () => {
    const z = await otraOrg('z')
    const CON_HISTORIA = {
      statusCode: 409,
      code: 'SEDE_CON_PAGO_AL_PERSONAL',
      message: 'Esta sede tiene historial de pago al personal; no se puede trasladar a otra organización',
    }
    const v = await conVentana('cv')
    const e = await conDevengo('cd')
    const limpia = (await crearSede(m.orgId, m.key, 'limpia')).venueId
    expect(await trasladar(v, z)).toMatchObject(CON_HISTORIA)
    expect(await trasladar(e, z)).toMatchObject(CON_HISTORIA)
    expect(await sedeDe(v)).toMatchObject({ organizationId: m.orgId })
    expect(await sedeDe(e)).toMatchObject({ organizationId: m.orgId })
    expect(await trasladar(limpia, z)).toMatchObject({ status: 200 })
    expect(await sedeDe(limpia)).toMatchObject({ organizationId: z })
  })

  it('borrar un negocio de prueba (deleteVenue): con ventana o con devengos, 409; sin historia, se borra como hoy', async () => {
    const CON_HISTORIA = {
      statusCode: 409,
      code: 'SEDE_CON_PAGO_AL_PERSONAL',
      message: 'Esta sede tiene historial de pago al personal; no se puede borrar',
    }
    const v = await conVentana('cv', 'TRIAL')
    const e = await conDevengo('cd', 'TRIAL')
    const limpia = (await crearSede(m.orgId, m.key, 'limpia')).venueId
    await prisma.venue.update({ where: { id: limpia }, data: { status: 'TRIAL' } })
    await expect(deleteVenue(m.orgId, v)).rejects.toMatchObject(CON_HISTORIA)
    await expect(deleteVenue(m.orgId, e)).rejects.toMatchObject(CON_HISTORIA)
    expect(await sedeDe(v)).not.toBeNull()
    expect(await sedeDe(e)).not.toBeNull()
    await expect(deleteVenue(m.orgId, limpia)).resolves.toBeUndefined()
    expect(await sedeDe(limpia)).toBeNull()
  })

  it('la limpieza de demos deja ENTERA la demo con +$50 congelados y −$50 pendientes, avisa con warn y limpia las demás', async () => {
    const con = await demo('con-historia')
    const sin = await demo('sin-historia')
    // La venta de la demo, su comisión de +$50 ya congelada en julio y la devolución con su reverso de −$50 pendiente.
    const pago = await cobro(m, { iso: '2026-07-10T18:00:00Z', venueId: con.venueId })
    const conf = await esquema(m, con.venueId)
    const original = await comision(m, {
      configId: conf,
      staffId: m.ana,
      iso: '2026-07-10T18:00:00Z',
      neto: 50,
      pago,
      venueId: con.venueId,
    })
    const julio = await periodo('2026-07-01', '2026-07-31', [con.venueId], 'CLOSED')
    await congelar(m, julio.id, { fuente: 'COMMISSION', sourceId: original.id, staffId: m.ana, monto: 50, venueId: con.venueId })
    const devolucion = await reembolso(m, pago, { iso: '2026-08-05T18:00:00Z', monto: 100 })
    await comision(m, { configId: conf, staffId: m.ana, iso: '2026-08-05T18:00:00Z', neto: -50, pago: devolucion, venueId: con.venueId })
    await prisma.staffPayVenueWindow.create({
      data: { organizationId: m.orgId, venueId: con.venueId, desde: fechaComoDbDate('2026-07-01'), activadaPor: m.owner },
    })
    // Sólo las sesiones de ESTA prueba: la base es compartida.
    const mias = [con.sesion.id, sin.sesion.id]
    const realFindMany = prisma.liveDemoSession.findMany.bind(prisma.liveDemoSession)
    espias.push(
      jest
        .spyOn(prisma.liveDemoSession, 'findMany')
        .mockImplementation(((a: any) => realFindMany({ ...a, where: { AND: [a?.where ?? {}, { id: { in: mias } }] } })) as any),
    )

    expect(await cleanupExpiredLiveDemos()).toBe(1)

    await demoIntacta(con)
    expect(await prisma.payment.count({ where: { venueId: con.venueId } })).toBe(2)
    expect(await prisma.order.count({ where: { venueId: con.venueId } })).toBe(1)
    expect(await prisma.staffPayVenueWindow.count({ where: { venueId: con.venueId } })).toBe(1)
    expect((await devengosDe(con.venueId)).map(e => e.amount.toFixed(2))).toEqual(['50.00'])
    expect(await sedeDe(sin.venueId)).toBeNull()
    expect(await prisma.staff.count({ where: { id: sin.visitante } })).toBe(0)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('historial de pago al personal'),
      expect.objectContaining({ venueId: con.venueId, code: 'LIVE_DEMO_CON_PAGO_AL_PERSONAL' }),
    )
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining(`${m.key}-con-historia`), expect.anything())
  }, 60_000)
})
