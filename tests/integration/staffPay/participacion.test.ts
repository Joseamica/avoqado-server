// tests/integration/staffPay/participacion.test.ts — participación por sede, fase 3 B9 (diseño r7 + r6.3/r6.6, Codex r7):
// activar la organización abre ventanas, el presupuesto ÚNICO de espera de candados y activar contra trasladar.
// Las carreras del primer devengo están en `participacion.carreras.test.ts` y las barreras en `participacion.barreras.test.ts`.
//
// B9 sólo ESCRIBE ventanas y pone candados y barreras: ningún lector de dinero las usa todavía. Las carreras corren el código
// REAL, pausado en un punto exacto, con la espera comprobada en `pg_stat_activity` (por el pid de quien la retiene) antes de
// soltar. Fechas de 2026 en UTC; CDMX = UTC−6, Tijuana = UTC−7.
import prisma from '@/utils/prismaClient'
import { cerrarPeriodo, previewCierre, TIMEOUT_CIERRE_MS } from '@/services/dashboard/staffPay/cierre.service'
import { PresupuestoDeEspera } from '@/utils/esperaDeCandados'
import { dbDateComoFecha, venuePeriodRange } from '@/services/dashboard/staffPay/periodos'
import {
  barreraDeLaFilaDeOrganizacion,
  barreraDeLaOrganizacion,
  barreraDeLaSede,
  CIERRE_EN_CURSO,
  clase,
  conCandadoRetenido,
  confirmadas,
  crearSede,
  tablaMindform,
} from './_mundo'
import { AHORA, dormir, esperarDetenidaPor, OPERACION_EN_CURSO, prepararParticipacion, resultado } from './_participacion'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  assertPermisoEnTodasLasSedes: jest.fn(async () => undefined),
}))

const p = prepararParticipacion('participacion')

// ── activar la organización (r6.1, r6.6.2) ─────────────────────────────────────────────────────────────────────────────

describe('activar la organización abre una ventana por cada sede con plan (B9)', () => {
  it('todas las sedes con plan desde el inicio, la sin plan ninguna; el ActivityLog las nombra; repetir no abre nada', async () => {
    const m = p.m()
    const tij = await crearSede(m.orgId, m.key, 'tij')
    await prisma.venue.update({ where: { id: tij.venueId }, data: { timezone: 'America/Tijuana' } })
    const sinPlan = await crearSede(m.orgId, m.key, 'sin-plan')
    const conPlan = [m.venueId, tij.venueId].sort()
    ;(global as any).__sedes = [tij.venueId, m.venueId]

    expect(await p.activar()).toEqual({ startDate: '2026-09-01', yaActivado: false })
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

    expect(await p.activar()).toEqual({ startDate: '2026-09-01', yaActivado: true })
    expect(await prisma.staffPayVenueWindow.count({ where: { organizationId: m.orgId } })).toBe(2)
    expect(await prisma.activityLog.count({ where: { action: 'SERVICE_PAY_ACTIVATED', entityId: m.orgId } })).toBe(1)
  })

  it('una sede resuelta con plan que bajo el candado ya es de otra organización: 409 completo, no activa ni abre nada', async () => {
    const m = p.m()
    const z = await p.otraOrg('z-ajena')
    const ajena = await crearSede(z, m.key, 'ajena')
    ;(global as any).__sedes = [m.venueId, ajena.venueId]
    await expect(p.activar()).rejects.toMatchObject({
      statusCode: 409,
      code: 'SEDE_EN_OTRA_ORGANIZACION',
      message: `La sede ${m.key}-ajena ya no pertenece a esta organización`,
    })
    ;(global as any).__sedes = [m.venueId, `${m.key}-borrada`]
    await expect(p.activar()).rejects.toMatchObject({
      statusCode: 409,
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
    const m = p.m()
    const b1 = await barreraDeLaOrganizacion(m.orgId)
    const b2 = await barreraDeLaFilaDeOrganizacion(m.orgId)
    const b3 = await barreraDeLaSede(m.venueId)
    let termino = false
    const mientras = () => !termino
    try {
      const op = resultado(p.activar()).finally(() => (termino = true))
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
    const m = p.m()
    const otra = await crearSede(m.orgId, m.key, 's2')
    const [v1, v2] = [m.venueId, otra.venueId].sort()
    ;(global as any).__sedes = [v2, v1]
    const b1 = await barreraDeLaSede(v1)
    const b2 = await barreraDeLaSede(v2)
    let termino = false
    const mientras = () => !termino
    try {
      const op = resultado(p.activar()).finally(() => (termino = true))
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
    const m = p.m()
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
    p.espiar(espia)
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
    const m = p.m()
    const b = await crearSede(m.orgId, m.key, 'b')
    const z = await p.otraOrg('z')
    ;(global as any).__sedes = [m.venueId, b.venueId]
    const pausa = p.pausarDespuesDe('bloquearSedesDeLaOrganizacion')
    const act = resultado(p.activar())
    const pid = await pausa.hasta(act)
    let termino = false
    const tras = p.trasladar(b.venueId, z).finally(() => (termino = true))
    expect(await esperarDetenidaPor(pid, () => !termino)).toBe(true)
    pausa.soltar()
    const [a, t] = await Promise.all([act, tras])
    expect(a.valor).toEqual({ startDate: '2026-09-01', yaActivado: false })
    expect(t).toMatchObject({
      statusCode: 409,
      code: 'SEDE_CON_PAGO_AL_PERSONAL',
      message: 'Esta sede tiene historial de pago al personal; no se puede trasladar a otra organización',
    })
    expect(await p.sedeDe(b.venueId)).toMatchObject({ organizationId: m.orgId })
    expect(await prisma.staffPayVenueWindow.count({ where: { venueId: b.venueId, organizationId: m.orgId } })).toBe(1)
  }, 60_000)

  it('gana el traslado: la activación espera, reintenta y contesta 409 SEDE_EN_OTRA_ORGANIZACION; ninguna ventana de A en la sede de Z', async () => {
    const m = p.m()
    const b = await crearSede(m.orgId, m.key, 'b')
    const z = await p.otraOrg('z')
    ;(global as any).__sedes = [m.venueId, b.venueId]
    const pausa = p.pausarDespuesDe('historiaDeSede')
    const tras = p.trasladar(b.venueId, z)
    const pid = await pausa.hasta(tras)
    let termino = false
    const act = resultado(p.activar()).finally(() => (termino = true))
    expect(await esperarDetenidaPor(pid, () => !termino)).toBe(true)
    pausa.soltar()
    const [t, a] = await Promise.all([tras, act])
    expect(t).toMatchObject({ status: 200 })
    expect(a.error).toMatchObject({
      statusCode: 409,
      code: 'SEDE_EN_OTRA_ORGANIZACION',
      message: `La sede ${m.key}-b ya no pertenece a esta organización`,
    })
    expect(await p.sedeDe(b.venueId)).toMatchObject({ organizationId: z })
    expect(await prisma.staffPayVenueWindow.count({ where: { venueId: b.venueId } })).toBe(0)
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: m.orgId }, select: { staffPayStartDate: true } })).toEqual({
      staffPayStartDate: null,
    })
  }, 60_000)
})
