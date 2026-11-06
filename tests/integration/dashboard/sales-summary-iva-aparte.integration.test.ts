/**
 * D16 (REAL PostgreSQL): el Resumen de ventas cuenta el IVA que la cuenta cobró ENCIMA del precio.
 *
 * El reporte dice «los impuestos ya están incluidos en los precios» (México). En una cuenta nativa es cierto: el subtotal ya
 * trae el IVA. Pero en una cuenta con el IVA aparte (los datos de demostración de onboarding, `IVA_APARTE`, y el histórico
 * importado de SoftRestaurant, `DESCONOCIDO` con `taxAmount > 0`) el cliente pagó subtotal + IVA y las ventas sumaban sólo el
 * subtotal: «Total cobrado» quedaba por debajo de «Cobraste» justo por el IVA (visto al grabar el tutorial, 5-nov-2026).
 * La regla de qué IVA va aparte es la de `impuestoQueSeCobraAparte` (la misma que fija el total y el saldo de la cuenta).
 *
 *   TEST_DATABASE_URL='postgresql://…/<base desechable>' npx jest --selectProjects integration --testPathPattern sales-summary-iva-aparte
 */

import prisma from '@/utils/prismaClient'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { getOrderSourcesBreakdown } from '@/jobs/nightly-sales-summary.job'

const TZ = 'America/Mexico_City'
const FROM = '2025-05-08T06:00:00.000Z'
const TO = '2025-05-09T05:59:59.999Z'
const INSIDE = new Date('2025-05-08T18:00:00.000Z')
const suffix = `ivaaparte-${Date.now()}`

let orgId: string
let venueId: string
let seq = 0

type Cuenta = {
  contrato: 'IVA_INCLUIDO' | 'IVA_APARTE' | 'DESCONOCIDO'
  subtotal: number
  tax: number
  discount?: number
  tip?: number
  status?: 'COMPLETED' | 'CANCELLED'
  /** Lo que pagó el cliente sin propina (= total de la cuenta sin propina). */
  paid: number
  method?: 'CASH' | 'CREDIT_CARD'
}

async function cuenta(c: Cuenta) {
  seq += 1
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `IVA-${seq}-${suffix}`,
      createdAt: INSIDE,
      contratoDePrecio: c.contrato,
      subtotal: c.subtotal,
      taxAmount: c.tax,
      discountAmount: c.discount ?? 0,
      tipAmount: c.tip ?? 0,
      total: c.paid + (c.tip ?? 0),
      status: c.status ?? 'COMPLETED',
      paymentStatus: 'PAID',
    },
    select: { id: true },
  })
  if (c.status === 'CANCELLED') return
  await prisma.payment.create({
    data: {
      venueId,
      orderId: order.id,
      amount: c.paid,
      tipAmount: c.tip ?? 0,
      method: c.method ?? 'CASH',
      status: 'COMPLETED',
      type: 'REGULAR',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: c.paid,
      createdAt: INSIDE,
    },
  })
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `IVA Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `iva-${suffix}`, slug: `iva-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id
  // Demo de onboarding: IVA encima, con propina.
  await cuenta({ contrato: 'IVA_APARTE', subtotal: 100, tax: 16, tip: 10, paid: 116 })
  // IVA encima con descuento: el IVA ya viene sobre lo descontado (80 × 16 %).
  await cuenta({ contrato: 'IVA_APARTE', subtotal: 100, tax: 12.8, discount: 20, paid: 92.8, method: 'CREDIT_CARD' })
  // Nativa: el subtotal YA trae el IVA y no hay IVA escrito.
  await cuenta({ contrato: 'IVA_INCLUIDO', subtotal: 232, tax: 0, paid: 232 })
  // Nativa con un IVA escrito por error: IVA_INCLUIDO nunca suma.
  await cuenta({ contrato: 'IVA_INCLUIDO', subtotal: 116, tax: 16, paid: 116 })
  // Histórico de SoftRestaurant: sin contrato, con IVA escrito ⇒ va aparte (regla P12).
  await cuenta({ contrato: 'DESCONOCIDO', subtotal: 50, tax: 8, paid: 58 })
  // Sin contrato y sin IVA: como siempre.
  await cuenta({ contrato: 'DESCONOCIDO', subtotal: 40, tax: 0, paid: 40 })
  // Cancelada con IVA encima: no es venta.
  await cuenta({ contrato: 'IVA_APARTE', subtotal: 100, tax: 16, paid: 116, status: 'CANCELLED' })
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

// Lo que pagaron los clientes sin propina: 116 + 92.80 + 232 + 116 + 58 + 40.
const VENTAS_CON_IVA = 654.8
const PROPINAS = 10

describe('D16 · el IVA cobrado aparte es venta', () => {
  it('ventas brutas y netas traen el IVA cobrado encima; «Total cobrado» cuadra al centavo con lo cobrado por método', async () => {
    const r = await getSalesSummary(venueId, { startDate: FROM, endDate: TO, timezone: TZ, groupBy: 'paymentMethod' })
    expect(r.summary.discounts).toBeCloseTo(20, 2)
    expect(r.summary.grossSales).toBeCloseTo(VENTAS_CON_IVA + 20, 2)
    expect(r.summary.items).toBeCloseTo(VENTAS_CON_IVA + 20, 2)
    expect(r.summary.netSales).toBeCloseTo(VENTAS_CON_IVA, 2)
    expect(r.summary.totalCollected).toBeCloseTo(VENTAS_CON_IVA + PROPINAS, 2)
    // «Cobraste» del estado del periodo = Σ de los métodos (sin comisiones aquí).
    const cobraste = (r.byPaymentMethodDetailed ?? []).reduce((s, b) => s + b.amount, 0)
    expect(Math.round(cobraste * 100)).toBe(Math.round(r.summary.totalCollected * 100))
  })

  it('las barras por periodo suman lo mismo que la cabecera', async () => {
    const r = await getSalesSummary(venueId, { startDate: FROM, endDate: TO, timezone: TZ, reportType: 'days' })
    const bruto = (r.byPeriod ?? []).reduce((s, p) => s + (p.metrics.grossSales ?? 0), 0)
    const neto = (r.byPeriod ?? []).reduce((s, p) => s + (p.metrics.netSales ?? 0), 0)
    expect(bruto).toBeCloseTo(VENTAS_CON_IVA + 20, 2)
    expect(neto).toBeCloseTo(VENTAS_CON_IVA, 2)
  })

  it('el correo nocturno («Origen del pedido») dice las mismas ventas netas', async () => {
    const fuentes = await getOrderSourcesBreakdown(venueId, new Date(FROM), new Date(TO))
    expect(fuentes.reduce((s, f) => s + f.netSales, 0)).toBeCloseTo(VENTAS_CON_IVA, 2)
  })
})
