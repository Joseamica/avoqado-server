/**
 * Integration test: agregados del MCP en SQL (REAL PostgreSQL).
 *
 * 2026-09-01 (query-guard en producción): `sales_by_payment_method` y `staff_tips`
 * traían TODAS las filas del rango a Node sólo para sumarlas — «ventas de este año» eran
 * 24 mil pagos. Ahora suman con `groupBy` en Postgres (aggregatePaymentsByMethod /
 * aggregateTipsByProcessor). Un `groupBy` mockeado devuelve lo que le digas, así que la
 * PARIDAD se prueba aquí contra base real: el camino viejo (filas + suma en Node) y el
 * nuevo (grupos) deben dar el MISMO resultado al centavo sobre la misma mezcla de pagos.
 *
 * La mezcla cubre justo lo que separa a las dos cifras de la herramienta: propinas,
 * un reembolso (fila negativa), un pago de una orden CANCELADA, un pago sin cajero
 * (QR), un pago de propina 0, y filas fuera de la ventana y de otro venue.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://…/av-db-25-test' \
 *     npx jest --selectProjects integration --testPathPattern sales-aggregates
 */

import prisma from '@/utils/prismaClient'
import { aggregatePaymentsByMethod, aggregateTipsByProcessor, fetchPaymentsForAnalytics } from '@/services/legacy/mergedPayments.service'
import { aggregateStaffTips, methodTotalsFromAggregates, rankProcessorTips, summarizeByPaymentMethod } from '@/mcp/tools/sales'

const DAY = new Date('2025-03-11T18:00:00.000Z')
const FUERA = new Date('2025-02-01T18:00:00.000Z')
const RANGO = { fromDate: new Date('2025-03-09T00:00:00.000Z'), toDate: new Date('2025-03-15T23:59:59.999Z') }
const suffix = `mcp-agg-${Date.now()}`

let orgId: string
let venueId: string
let otroVenueId: string
let fatimaId: string
let anaId: string

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `MCP Agg Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id
  const venue = await prisma.venue.create({
    data: { organizationId: orgId, name: `agg-${suffix}`, slug: `agg-${suffix}`, timezone: 'America/Mexico_City' },
    select: { id: true },
  })
  venueId = venue.id
  const otro = await prisma.venue.create({
    data: { organizationId: orgId, name: `agg-otro-${suffix}`, slug: `agg-otro-${suffix}`, timezone: 'America/Mexico_City' },
    select: { id: true },
  })
  otroVenueId = otro.id

  fatimaId = (
    await prisma.staff.create({
      data: { email: `fatima-${suffix}@example.test`, firstName: 'Fatima', lastName: 'Flores' },
      select: { id: true },
    })
  ).id
  anaId = (
    await prisma.staff.create({
      data: { email: `ana-${suffix}@example.test`, firstName: 'Ana', lastName: 'Gonzalez' },
      select: { id: true },
    })
  ).id

  const orden = async (vid: string, status: 'COMPLETED' | 'CANCELLED', n: string) =>
    (
      await prisma.order.create({
        data: {
          venueId: vid,
          orderNumber: `AGG-${n}-${suffix}`,
          createdAt: DAY,
          subtotal: 100,
          taxAmount: 0,
          total: 100,
          status,
          paymentStatus: 'PAID',
        },
        select: { id: true },
      })
    ).id
  const ok = await orden(venueId, 'COMPLETED', 'ok')
  const cancelada = await orden(venueId, 'CANCELLED', 'cx')
  const ajena = await orden(otroVenueId, 'COMPLETED', 'ajena')

  const base = { status: 'COMPLETED' as const, createdAt: DAY, feePercentage: 0, feeAmount: 0, netAmount: 0 }
  const pagos = [
    // Ventas normales con cajero
    { venueId, orderId: ok, amount: 100, tipAmount: 15, method: 'CASH' as const, processedById: fatimaId },
    { venueId, orderId: ok, amount: 200.25, tipAmount: 20.1, method: 'CREDIT_CARD' as const, processedById: fatimaId },
    { venueId, orderId: ok, amount: 50, tipAmount: 5, method: 'DEBIT_CARD' as const, processedById: anaId },
    // Propina 0: cuenta en ventas, NO en propinas por cajero
    { venueId, orderId: ok, amount: 30, tipAmount: 0, method: 'CASH' as const, processedById: anaId },
    // QR sin cajero: sus propinas van a "unattributed"
    { venueId, orderId: ok, amount: 80, tipAmount: 8, method: 'CREDIT_CARD' as const, processedById: null },
    // Reembolso: fila negativa, tipo REFUND (entra sólo con includeRefunds)
    { venueId, orderId: ok, amount: -10, tipAmount: -2, method: 'CASH' as const, processedById: fatimaId, type: 'REFUND' as const },
    // Pago de una orden CANCELADA (entra sólo con excludeCancelledOrders=false)
    { venueId, orderId: cancelada, amount: 40, tipAmount: 4, method: 'CASH' as const, processedById: anaId },
    // Fuera de la ventana y de otro venue: nunca entran
    { venueId, orderId: ok, amount: 999, tipAmount: 99, method: 'CASH' as const, processedById: fatimaId, createdAt: FUERA },
    { venueId: otroVenueId, orderId: ajena, amount: 777, tipAmount: 77, method: 'CASH' as const, processedById: fatimaId },
  ]
  for (const p of pagos) await prisma.payment.create({ data: { ...base, ...p } })
  // Un PENDING no cuenta nunca
  await prisma.payment.create({
    data: { ...base, venueId, orderId: ok, amount: 500, tipAmount: 50, method: 'CASH', status: 'PENDING', processedById: fatimaId },
  })
})

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { venueId: { in: [venueId, otroVenueId] } } })
  await prisma.order.deleteMany({ where: { venueId: { in: [venueId, otroVenueId] } } })
  await prisma.staff.deleteMany({ where: { id: { in: [fatimaId, anaId] } } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueId, otroVenueId] } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

const porMetodo = (rows: Array<{ method: string }>) => Object.fromEntries(rows.map(r => [r.method, r]))

describe('aggregatePaymentsByMethod — sales_by_payment_method', () => {
  it('grossCollected (con reembolsos, con canceladas, con propinas) cuadra con el camino de filas al centavo', async () => {
    const filtros = { ...RANGO, includeRefunds: true, excludeCancelledOrders: false }
    const nuevo = methodTotalsFromAggregates(await aggregatePaymentsByMethod(venueId, filtros), true)
    const viejo = summarizeByPaymentMethod(await fetchPaymentsForAnalytics(venueId, filtros), true)
    expect(nuevo).toEqual(viejo)

    const m = porMetodo(nuevo)
    // CASH: (100+15) + (30+0) + (-10-2) + (40+4) = 177, 4 filas
    expect(m.CASH).toEqual({ method: 'CASH', total: 177, count: 4 })
    // CREDIT_CARD: (200.25+20.10) + (80+8) = 308.35
    expect(m.CREDIT_CARD).toEqual({ method: 'CREDIT_CARD', total: 308.35, count: 2 })
    expect(m.DEBIT_CARD).toEqual({ method: 'DEBIT_CARD', total: 55, count: 1 })
    expect(nuevo.map(r => r.method)).toEqual(['CREDIT_CARD', 'CASH', 'DEBIT_CARD']) // desc por total
  })

  it('netSales (con reembolsos, SIN canceladas, SIN propinas) cuadra con el camino de filas al centavo', async () => {
    const filtros = { ...RANGO, includeRefunds: true, excludeCancelledOrders: true }
    const nuevo = methodTotalsFromAggregates(await aggregatePaymentsByMethod(venueId, filtros), false)
    const viejo = summarizeByPaymentMethod(await fetchPaymentsForAnalytics(venueId, filtros), false)
    expect(nuevo).toEqual(viejo)

    const m = porMetodo(nuevo)
    expect(m.CASH).toEqual({ method: 'CASH', total: 120, count: 3 }) // 100 + 30 - 10
    expect(m.CREDIT_CARD).toEqual({ method: 'CREDIT_CARD', total: 280.25, count: 2 })
    expect(m.DEBIT_CARD).toEqual({ method: 'DEBIT_CARD', total: 50, count: 1 })
  })

  it('defaults (sin reembolsos, sin canceladas): el reembolso y la cancelada quedan fuera; PENDING, otro venue y fuera de ventana nunca entran', async () => {
    const nuevo = await aggregatePaymentsByMethod(venueId, RANGO)
    const viejo = summarizeByPaymentMethod(await fetchPaymentsForAnalytics(venueId, RANGO), true)
    expect(methodTotalsFromAggregates(nuevo, true)).toEqual(viejo)
    const cash = nuevo.find(r => r.method === 'CASH')!
    expect(cash).toEqual({ method: 'CASH', amount: 130, tips: 15, count: 2 })
    expect(nuevo.reduce((s, r) => s + r.count, 0)).toBe(5)
  })

  it('rango sin pagos → lista vacía, no un error', async () => {
    expect(
      await aggregatePaymentsByMethod(venueId, {
        fromDate: new Date('2030-01-01T00:00:00.000Z'),
        toDate: new Date('2030-01-02T00:00:00.000Z'),
      }),
    ).toEqual([])
  })
})

describe('aggregateTipsByProcessor — staff_tips', () => {
  it('propinas por quien cobró cuadran con el camino de filas al centavo; el QR cae en unattributed; propina 0 no cuenta', async () => {
    const nuevo = rankProcessorTips(await aggregateTipsByProcessor(venueId, RANGO))
    const viejo = aggregateStaffTips(await fetchPaymentsForAnalytics(venueId, RANGO))
    expect(nuevo).toEqual(viejo)

    // Defaults: sin REFUND, sin la cancelada. Fátima 15 + 20.10; Ana 5 (el de propina 0 no cuenta); QR 8.
    expect(nuevo.staff).toEqual([
      { staffId: fatimaId, name: 'Fatima Flores', tips: 35.1, payments: 2 },
      { staffId: anaId, name: 'Ana Gonzalez', tips: 5, payments: 1 },
    ])
    expect(nuevo.unattributed).toEqual({ tips: 8, payments: 1 })
    expect(nuevo.total).toBe(48.1)
    expect(nuevo.count).toBe(4)
  })

  it('cada fila es UN cajero (o el cubo sin cajero), nunca un pago', async () => {
    const grupos = await aggregateTipsByProcessor(venueId, RANGO)
    expect(grupos).toHaveLength(3) // fatima, ana, null
    expect(new Set(grupos.map(g => g.processedById)).size).toBe(3)
  })
})
