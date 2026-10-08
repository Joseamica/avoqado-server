// tests/integration/staffPay/fuentesVenta.flujoViejo.test.ts — E6a-fix F6 (QA E6a H1, DINERO): una comisión que el flujo VIEJO
// ya pagó (su resumen está PAID o tiene un pago PAID) nunca vuelve a entrar al recibo, en NINGÚN lector del sobre.
import prisma from '@/utils/prismaClient'
import { AlcanceBarrido, comisionesBarribles, totalesVentas } from '@/services/dashboard/staffPay/fuentesVenta'
import { rangosConParticipacion } from '@/services/dashboard/staffPay/rangos'
import { reciboDePersona } from '@/services/dashboard/staffPay/recibos.service'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { borrarMundo, crearMundo, Mundo, TZ } from './_mundo'
import { activar, cobro, comision, esquema, reembolso } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
}))

const OCT2 = new Date('2026-10-02T12:00:00Z')
let m: Mundo
let cfg: string
beforeEach(async () => {
  m = await crearMundo('flujo-viejo')
  ;(global as any).__sedes = [m.venueId]
  await activar(m, { desde: '2026-09-01', propinasDesde: null })
  cfg = await esquema(m)
})
afterEach(() => borrarMundo(m))

const SEP: AlcanceBarrido['periodo'] = { id: null, start: '2026-09-01', end: '2026-09-30' }
const alcance = (): AlcanceBarrido => ({
  organizationId: m.orgId,
  periodo: SEP,
  sedes: [{ venueId: m.venueId, tz: TZ }],
  startDate: '2026-09-01',
})
let dia = 0
/**
 * Lo que dejaba el flujo viejo: un `CommissionSummary` con sus comisiones agregadas y, si hubo, su `CommissionPayout`. `resumen`
 * CALCULATED con pago PAID = el agregador volvió a abrir un resumen ya pagado (su `update` pone CALCULATED).
 */
async function flujoViejo(calcIds: string[], o: { resumen: 'PAID' | 'CALCULATED' | 'APPROVED'; pago: 'PAID' | 'PENDING' | null }) {
  const s = await prisma.commissionSummary.create({
    data: {
      venueId: m.venueId,
      staffId: m.sofia,
      periodType: 'MONTHLY',
      periodStart: new Date(Date.UTC(2026, 8, 1 + dia++, 6)), // uno por resumen: (sede, persona, tipo, inicio) es único
      periodEnd: new Date('2026-10-01T05:59:59Z'),
      totalSales: 0,
      totalCommissions: 0,
      grandTotal: 0,
      status: o.resumen,
    },
  })
  await prisma.commissionCalculation.updateMany({
    where: { id: { in: calcIds } },
    data: { summaryId: s.id, status: 'AGGREGATED', aggregatedAt: new Date('2026-09-09T18:00:00Z') },
  })
  if (o.pago) {
    await prisma.commissionPayout.create({
      data: {
        venueId: m.venueId,
        staffId: m.sofia,
        summaryId: s.id,
        amount: 0,
        paymentMethod: 'CASH',
        status: o.pago,
        paidAt: o.pago === 'PAID' ? new Date('2026-09-10T18:00:00Z') : null,
      },
    })
  }
}

/** Septiembre de Sofía: 5 comisiones pagadas por el flujo viejo el 10-sep ($37.77, como la QA), una de ellas con su devolución. */
async function septiembre() {
  const com = (iso: string, neto: number, pago?: { id: string; orderId: string }) =>
    comision(m, { configId: cfg, staffId: m.sofia, iso, neto, pago })
  const venta = await cobro(m, { iso: '2026-09-05T18:00:00Z', monto: 3000 })
  const pagadas = [
    await com('2026-09-03T18:00:00Z', 7.55),
    await com('2026-09-04T18:00:00Z', 7.55),
    await com('2026-09-05T18:00:05Z', 7.55, venta),
    await com('2026-09-06T18:00:00Z', 7.56),
    await com('2026-09-07T18:00:00Z', 7.56),
  ]
  await flujoViejo(
    pagadas.map(c => c.id),
    { resumen: 'PAID', pago: 'PAID' },
  )
  // Su devolución el 20-sep: el reverso de una comisión que el sobre nunca pagó tampoco se descuenta (spec §6.2 punto 6).
  const dev = await reembolso(m, venta, { iso: '2026-09-20T18:00:00Z', monto: 1000 })
  const reverso = await com('2026-09-20T18:00:00Z', -2.52, dev)
  // El agregador volvió a abrir un resumen ya pagado: su pago PAID manda.
  const reabierta = await com('2026-09-08T18:00:00Z', 11)
  await flujoViejo([reabierta.id], { resumen: 'CALCULATED', pago: 'PAID' })
  // Un resumen PAID sin fila de pago.
  const resumenPagado = await com('2026-09-09T18:00:00Z', 13)
  await flujoViejo([resumenPagado.id], { resumen: 'PAID', pago: null })
  // NO pagadas: una suelta y una con su pago viejo apenas PENDIENTE (nadie pagó).
  const viva = await com('2026-09-12T18:00:00Z', 20)
  const pendiente = await com('2026-09-13T18:00:00Z', 15)
  await flujoViejo([pendiente.id], { resumen: 'APPROVED', pago: 'PENDING' })
  return { pagadas, reverso, reabierta, resumenPagado, viva, pendiente }
}

describe('F6 — lo que el flujo viejo ya pagó no vuelve a entrar al recibo (QA E6a H1)', () => {
  it('el barrido y las sumas de ventas toman SÓLO las no pagadas', async () => {
    const s = await septiembre()
    const a = alcance()
    const barridas = await comisionesBarribles(prisma, a, await rangosConParticipacion(prisma, a), { limite: 1000 })
    expect(barridas.map(l => l.sourceId).sort()).toEqual([s.viva.id, s.pendiente.id].sort())
    // `totalesVentas` es lo que leen la vista previa de una sede, «fuera este periodo» y la vista previa del cierre por sede.
    expect((await totalesVentas(prisma, a)).map(t => [t.fuente, t.n, t.total.toFixed(2)])).toEqual([['COMMISSION', 2, '35.00']])
  })

  it('el recibo abierto, la vista previa del cierre y el cierre congelan sólo los $35 no pagados', async () => {
    const s = await septiembre()
    const recibo = await reciboDePersona({ userId: m.owner, venueId: m.venueId, staffId: m.sofia, fecha: '2026-09-15', limit: 100 })
    expect(recibo).toMatchObject({ total: '35.00', cantidad: 2, totalesPorTipo: { COMISION: '35.00' } })
    const p = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-09-15', ahora: OCT2 })
    expect(p).toMatchObject({ comisiones: 2, totalVentas: '35.00', total: '35.00' })
    await cerrarPeriodo({
      userId: m.owner,
      venueId: m.venueId,
      fecha: '2026-09-15',
      ahora: OCT2,
      confirmarHuerfanas: true,
      huellaEsperada: p.huella,
    })
    const congeladas = await prisma.serviceEarning.findMany({
      where: { organizationId: m.orgId, sourceType: 'COMMISSION' },
      select: { sourceId: true },
      orderBy: { sourceId: 'asc' },
      take: 20,
    })
    expect(congeladas.map(e => e.sourceId)).toEqual([s.viva.id, s.pendiente.id].sort())
  })
})
