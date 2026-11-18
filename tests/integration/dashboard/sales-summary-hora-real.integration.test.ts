/**
 * D93 (REAL PostgreSQL · encargo 18cc7f, founder 16-nov «B», como Square): lo vendido sin internet sale en los REPORTES a su hora real.
 *
 * La venta en efectivo de las 23:50 del 11 (hora de CDMX) que el POS subió a las 00:10 del 12 guarda `createdAt` = 00:10 (la
 * llegada, que siguen leyendo el corte, los turnos y demás reglas de dinero) y `clientCreatedAt` = 23:50. El Resumen de ventas
 * (cifras y barras), el correo de «ayer» y las horas pico la cuentan el 11, a las 23; el 12 no. Las barras siguen sumando la cabecera.
 *
 *   TEST_DATABASE_URL='postgresql://…/<base desechable>' npx jest --selectProjects integration --testPathPattern sales-summary-hora-real
 */

import prisma from '@/utils/prismaClient'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { getOrderSourcesBreakdown } from '@/jobs/nightly-sales-summary.job'
import { getChartData } from '@/services/dashboard/generalStats.dashboard.service'

const TZ = 'America/Mexico_City'
const DIA_11 = { desde: '2026-11-11T06:00:00.000Z', hasta: '2026-11-12T05:59:59.999Z' }
const DIA_12 = { desde: '2026-11-12T06:00:00.000Z', hasta: '2026-11-13T05:59:59.999Z' }
const suffix = `horareal-${Date.now()}`

let orgId: string
let venueId: string
let seq = 0

async function venta(p: { monto: number; llegada: Date; delAparato?: Date }) {
  seq += 1
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `HR-${seq}-${suffix}`,
      createdAt: p.llegada,
      clientCreatedAt: p.delAparato ?? null,
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: p.monto,
      taxAmount: 0,
      discountAmount: 0,
      tipAmount: 0,
      total: p.monto,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    },
    select: { id: true },
  })
  await prisma.payment.create({
    data: {
      venueId,
      orderId: order.id,
      amount: p.monto,
      tipAmount: 0,
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REGULAR',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: p.monto,
      createdAt: p.llegada,
      clientCreatedAt: p.delAparato ?? null,
    },
  })
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `HoraReal Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `hr-${suffix}`, slug: `hr-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id
  // En línea, el 11 a las 18:00.
  await venta({ monto: 100, llegada: new Date('2026-11-12T00:00:00.000Z') })
  // Sin internet: 23:50 del 11, subida a las 00:10 del 12.
  await venta({ monto: 50, llegada: new Date('2026-11-12T06:10:00.000Z'), delAparato: new Date('2026-11-12T05:50:00.000Z') })
  // En línea, el 12 a las 10:00.
  await venta({ monto: 30, llegada: new Date('2026-11-12T16:00:00.000Z') })
  // Sin internet: 21:00 del 10, subida 20 h después (el 11 a las 17:00): es del 10, no del 11.
  await venta({ monto: 7, llegada: new Date('2026-11-11T23:00:00.000Z'), delAparato: new Date('2026-11-11T03:00:00.000Z') })
})

afterAll(async () => {
  if (venueId) {
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('D93 · lo vendido sin internet sale en los reportes a su hora real', () => {
  it('el 11 cuenta la venta de las 23:50 que subió el 12; el 12 no; la del 10 subida el 11 no cuenta el 11', async () => {
    const r11 = await getSalesSummary(venueId, { startDate: DIA_11.desde, endDate: DIA_11.hasta, timezone: TZ })
    expect(r11.summary.netSales).toBeCloseTo(150, 2)
    expect(r11.summary.totalCollected).toBeCloseTo(150, 2)
    expect(r11.summary.transactionCount).toBe(2)
    const r12 = await getSalesSummary(venueId, { startDate: DIA_12.desde, endDate: DIA_12.hasta, timezone: TZ })
    expect(r12.summary.netSales).toBeCloseTo(30, 2)
    expect(r12.summary.transactionCount).toBe(1)
  })

  it('por método de pago también (la misma población)', async () => {
    const r11 = await getSalesSummary(venueId, { startDate: DIA_11.desde, endDate: DIA_11.hasta, timezone: TZ, groupBy: 'paymentMethod' })
    const efectivo = (r11.byPaymentMethod ?? []).find(m => m.method === 'CASH')
    expect(efectivo?.amount).toBeCloseTo(150, 2)
    const cobraste = (r11.byPaymentMethodDetailed ?? []).reduce((s, b) => s + b.amount, 0)
    expect(cobraste).toBeCloseTo(150, 2)
  })

  it('las barras por hora la ponen a las 23 del 11 y suman la cabecera', async () => {
    const r = await getSalesSummary(venueId, { startDate: DIA_11.desde, endDate: DIA_11.hasta, timezone: TZ, reportType: 'hourlySum' })
    // El periodo de `hourlySum` llega como «23:00» (formatPeriod): `Number('23:00')` es NaN y no encontraba ninguna barra.
    const porHora = new Map((r.byPeriod ?? []).map(p => [parseInt(String(p.period), 10), p.metrics]))
    expect(porHora.size).toBe(24)
    expect(porHora.get(23)?.grossSales ?? 0).toBeCloseTo(50, 2)
    expect(porHora.get(18)?.grossSales ?? 0).toBeCloseTo(100, 2)
    expect(porHora.get(0)?.grossSales ?? 0).toBeCloseTo(0, 2)
    const bruto = (r.byPeriod ?? []).reduce((s, p) => s + (p.metrics.grossSales ?? 0), 0)
    expect(bruto).toBeCloseTo(r.summary.grossSales ?? 0, 2)
  })

  it('el correo de «ayer» (origen del pedido) dice lo mismo que la cabecera', async () => {
    const fuentes = await getOrderSourcesBreakdown(venueId, new Date(DIA_11.desde), new Date(DIA_11.hasta))
    expect(fuentes.reduce((s, f) => s + f.netSales, 0)).toBeCloseTo(150, 2)
  })

  it('las horas pico la cuentan a las 23', async () => {
    const horas = (await getChartData(venueId, 'peak-hours', { fromDate: DIA_11.desde, toDate: DIA_11.hasta })) as Array<{
      hour: number
      sales: number
    }>
    expect(horas.find(h => h.hour === 23)?.sales ?? 0).toBeCloseTo(50, 2)
    expect(horas.find(h => h.hour === 0)?.sales ?? 0).toBeCloseTo(0, 2)
  })

  it('regresión: createdAt (la llegada, la que lee el dinero) sigue siendo las 00:10 del 12', async () => {
    const cobro = await prisma.payment.findFirst({ where: { venueId, amount: 50 }, select: { createdAt: true, clientCreatedAt: true } })
    expect(cobro?.createdAt.toISOString()).toBe('2026-11-12T06:10:00.000Z')
    expect(cobro?.clientCreatedAt?.toISOString()).toBe('2026-11-12T05:50:00.000Z')
  })
})
