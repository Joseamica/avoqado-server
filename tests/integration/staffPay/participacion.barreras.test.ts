// tests/integration/staffPay/participacion.barreras.test.ts — fase 3 B9 (diseño r6.6.5, r7.1): una sede con historia de
// pago al personal (ventanas o devengos) no se traslada ni se borra, y la limpieza de demos la omite completa. Sin historia,
// todo sigue como hoy. La limpieza tiene presupuesto de espera (ronda 1, F1): una demo cuya fila retiene otra operación se
// avisa con `warn` y la corrida sigue con las demás.
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { deleteVenue } from '@/services/dashboard/venue.dashboard.service'
import { cleanupExpiredLiveDemos, DELETION_TIMEOUT_MS } from '@/services/cleanup/liveDemoCleanup.service'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { PresupuestoDeEspera } from '@/utils/esperaDeCandados'
import { barreraDeLaSede, conCandadoRetenido, crearSede } from './_mundo'
import { cobro, comision, congelar, esquema, reembolso } from './_ventas'
import { prepararParticipacion } from './_participacion'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  assertPermisoEnTodasLasSedes: jest.fn(async () => undefined),
}))

const p = prepararParticipacion('participacion-barreras')

describe('barreras: una sede con historia de pago al personal no se traslada ni se borra (B9)', () => {
  const conVentana = async (s: string, status?: 'TRIAL') => {
    const m = p.m()
    const { venueId } = await crearSede(m.orgId, m.key, s)
    if (status) await prisma.venue.update({ where: { id: venueId }, data: { status } })
    await prisma.staffPayVenueWindow.create({
      data: { organizationId: m.orgId, venueId, desde: fechaComoDbDate('2026-09-01'), activadaPor: m.owner },
    })
    return venueId
  }
  const conDevengo = async (s: string, status?: 'TRIAL') => {
    const m = p.m()
    const { venueId } = await crearSede(m.orgId, m.key, s)
    if (status) await prisma.venue.update({ where: { id: venueId }, data: { status } })
    const julio = await p.periodo('2026-07-01', '2026-07-31', [venueId], 'CLOSED')
    await congelar(m, julio.id, { fuente: 'COMMISSION', sourceId: `${m.key}-${s}`, staffId: m.ana, monto: 50, venueId })
    return venueId
  }

  it('traslado: con ventana o con devengos, 409 SEDE_CON_PAGO_AL_PERSONAL; sin historia, como hoy', async () => {
    const m = p.m()
    const z = await p.otraOrg('z')
    const CON_HISTORIA = {
      statusCode: 409,
      code: 'SEDE_CON_PAGO_AL_PERSONAL',
      message: 'Esta sede tiene historial de pago al personal; no se puede trasladar a otra organización',
    }
    const v = await conVentana('cv')
    const e = await conDevengo('cd')
    const limpia = (await crearSede(m.orgId, m.key, 'limpia')).venueId
    expect(await p.trasladar(v, z)).toMatchObject(CON_HISTORIA)
    expect(await p.trasladar(e, z)).toMatchObject(CON_HISTORIA)
    expect(await p.sedeDe(v)).toMatchObject({ organizationId: m.orgId })
    expect(await p.sedeDe(e)).toMatchObject({ organizationId: m.orgId })
    expect(await p.trasladar(limpia, z)).toMatchObject({ status: 200 })
    expect(await p.sedeDe(limpia)).toMatchObject({ organizationId: z })
  })

  it('borrar un negocio de prueba (deleteVenue): con ventana o con devengos, 409; sin historia, se borra como hoy', async () => {
    const m = p.m()
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
    expect(await p.sedeDe(v)).not.toBeNull()
    expect(await p.sedeDe(e)).not.toBeNull()
    await expect(deleteVenue(m.orgId, limpia)).resolves.toBeUndefined()
    expect(await p.sedeDe(limpia)).toBeNull()
  })

  it('la limpieza de demos deja ENTERA la demo con +$50 congelados y −$50 pendientes, avisa con warn y limpia las demás', async () => {
    const m = p.m()
    const con = await p.demo('con-historia')
    const sin = await p.demo('sin-historia')
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
    const julio = await p.periodo('2026-07-01', '2026-07-31', [con.venueId], 'CLOSED')
    await congelar(m, julio.id, { fuente: 'COMMISSION', sourceId: original.id, staffId: m.ana, monto: 50, venueId: con.venueId })
    const devolucion = await reembolso(m, pago, { iso: '2026-08-05T18:00:00Z', monto: 100 })
    await comision(m, { configId: conf, staffId: m.ana, iso: '2026-08-05T18:00:00Z', neto: -50, pago: devolucion, venueId: con.venueId })
    await prisma.staffPayVenueWindow.create({
      data: { organizationId: m.orgId, venueId: con.venueId, desde: fechaComoDbDate('2026-07-01'), activadaPor: m.owner },
    })
    p.soloEstasDemos([con.sesion.id, sin.sesion.id])

    expect(await cleanupExpiredLiveDemos()).toBe(1)

    await p.demoIntacta(con)
    expect(await prisma.payment.count({ where: { venueId: con.venueId } })).toBe(2)
    expect(await prisma.order.count({ where: { venueId: con.venueId } })).toBe(1)
    expect(await prisma.staffPayVenueWindow.count({ where: { venueId: con.venueId } })).toBe(1)
    expect((await p.devengosDe(con.venueId)).map(e => e.amount.toFixed(2))).toEqual(['50.00'])
    expect(await p.sedeDe(sin.venueId)).toBeNull()
    expect(await prisma.staff.count({ where: { id: sin.visitante } })).toBe(0)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('historial de pago al personal'),
      expect.objectContaining({ venueId: con.venueId, code: 'LIVE_DEMO_CON_PAGO_AL_PERSONAL' }),
    )
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining(`${m.key}-con-historia`), expect.anything())
  }, 60_000)

  it('F1: la fila de una demo retenida por otra operación agota el presupuesto de la limpieza: avisa con warn y sigue con las demás', async () => {
    const m = p.m()
    const ocupada = await p.demo('ocupada')
    const libre = await p.demo('libre')
    p.soloEstasDemos([ocupada.sesion.id, libre.sesion.id])
    // Sin esperar 30 s reales: el presupuesto que pide la limpieza (su transacción de 60 s), recortado a 1 s.
    const real = PresupuestoDeEspera.para
    const espia = jest
      .spyOn(PresupuestoDeEspera, 'para')
      .mockImplementation(ms => (ms === DELETION_TIMEOUT_MS ? new PresupuestoDeEspera(1_000) : real(ms)))
    p.espiar(espia)
    const r = await conCandadoRetenido(await barreraDeLaSede(ocupada.venueId), () => cleanupExpiredLiveDemos())
    expect(espia).toHaveBeenCalledWith(DELETION_TIMEOUT_MS)
    expect(r.valor).toBe(1)
    expect(r.ms).toBeLessThan(25_000)
    await p.demoIntacta(ocupada)
    expect(await p.sedeDe(libre.venueId)).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ocupada'),
      expect.objectContaining({ venueId: ocupada.venueId, code: 'OPERACION_EN_CURSO' }),
    )
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining(`${m.key}-ocupada`), expect.anything())
  }, 60_000)
})
