/**
 * Carril B · cabecera del Resumen de ventas (REAL PostgreSQL, 21-nov-2026). Tarjetas hz:fefa11b6:D6, D2, D1, D9.1, D10.1.
 *
 * - D6 (proyecto «base de caja + Sin cobrar», founder 15-sep): las ventas brutas y netas cuentan sólo cuentas COBRADAS; las abiertas
 *   o pagadas a medias salen en `unpaidSales`/`unpaidOrders` (sin propina). Caso Testarudo del 15-sep: tres cuentas fantasma de
 *   $380 + $38, $170 y $145 + $14.50 que dejaba el cobro fallido a la terminal ($695 sin propina).
 * - D2: `Order.serviceChargeAmount` es venta (suma al total de la cuenta): `serviceCosts` y `grossSales = items + serviceCosts`.
 * - D1: la comisión congelada de Rappi/Uber/DiDi y de los tipos de pago propios (`Payment.tenderCommissionAmount`) se resta del
 *   cobrado y de la ganancia, aparte de las comisiones de Avoqado.
 * - D9.1: con un comercio elegido, la vista es de movimientos: nada de la cuenta entera, cobrado = los pagos de ese comercio.
 * - D10.1: una devolución no es una «transacción».
 *
 *   npx jest --selectProjects integration --testPathPattern sales-summary-cabecera   (por avq-verify: corre en la nube)
 */

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { getBasicMetricsData } from '@/services/dashboard/generalStats.dashboard.service'
import { getCategoryBreakdown, getOrderSourcesBreakdown, reconcileCategoryBreakdown } from '@/jobs/nightly-sales-summary.job'

jest.setTimeout(60000)

const TZ = 'America/Mexico_City'
const FROM = '2025-06-10T06:00:00.000Z'
const TO = '2025-06-11T05:59:59.999Z'
const INSIDE = new Date('2025-06-10T18:00:00.000Z')
const AYER = new Date('2025-06-09T18:00:00.000Z')
const suffix = `cabecera-${Date.now()}`
const cents = (n: number | null | undefined) => (n == null ? n : Math.round(n * 100))

let orgId: string
const venues: string[] = []
let providerId: string
let aggregatorId: string
let comercioA: string
let comercioB: string
let seq = 0

async function venue(nombre: string): Promise<string> {
  const id = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `${nombre}-${suffix}`, slug: `${nombre}-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id
  venues.push(id)
  return id
}

type Pago = {
  amount: number
  tip?: number
  method?: 'CASH' | 'CREDIT_CARD' | 'OTHER'
  type?: 'REGULAR' | 'REFUND' | null
  merchant?: string
  /** Comisión de Avoqado guardada en el `TransactionCost` del cobro. */
  fee?: number
  /** Comisión congelada del tipo de pago (Uber 30 %, vales…), con signo. */
  tenderCommission?: number
  fundsFlow?: 'EXTERNAL_RECORDED' | 'CASH_DRAWER'
  reopenedAmount?: number
  at?: Date
}

type Cuenta = {
  venueId: string
  subtotal: number
  discount?: number
  serviceCharge?: number
  tax?: number
  contrato?: 'IVA_INCLUIDO' | 'IVA_APARTE' | 'DESCONOCIDO'
  tip?: number
  status?: 'COMPLETED' | 'CONFIRMED' | 'CANCELLED'
  paymentStatus?: 'PAID' | 'PENDING' | 'PARTIAL'
  remainingBalance?: number
  at?: Date
  pagos?: Pago[]
}

async function cuenta(c: Cuenta) {
  seq += 1
  const at = c.at ?? INSIDE
  const total = Math.max(0, c.subtotal - (c.discount ?? 0)) + (c.serviceCharge ?? 0) + (c.tax ?? 0) + (c.tip ?? 0)
  const order = await prisma.order.create({
    data: {
      venueId: c.venueId,
      orderNumber: `CAB-${seq}-${suffix}`,
      createdAt: at,
      contratoDePrecio: c.contrato ?? 'IVA_INCLUIDO',
      subtotal: c.subtotal,
      discountAmount: c.discount ?? 0,
      serviceChargeAmount: c.serviceCharge ?? 0,
      taxAmount: c.tax ?? 0,
      tipAmount: c.tip ?? 0,
      total,
      remainingBalance: c.remainingBalance ?? 0,
      status: c.status ?? 'COMPLETED',
      paymentStatus: c.paymentStatus ?? 'PAID',
    },
    select: { id: true },
  })
  for (const p of c.pagos ?? []) {
    const pago = await prisma.payment.create({
      data: {
        venueId: c.venueId,
        orderId: order.id,
        amount: p.amount,
        tipAmount: p.tip ?? 0,
        method: p.method ?? 'CASH',
        status: 'COMPLETED',
        type: p.type === undefined ? 'REGULAR' : p.type,
        merchantAccountId: p.merchant,
        fundsFlow: p.fundsFlow,
        tenderCommissionAmount: p.tenderCommission === undefined ? undefined : new Prisma.Decimal(p.tenderCommission),
        reopenedAmount: p.reopenedAmount,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: p.amount,
        createdAt: p.at ?? at,
      },
      select: { id: true },
    })
    if (p.fee !== undefined) {
      await prisma.transactionCost.create({
        data: {
          paymentId: pago.id,
          merchantAccountId: p.merchant ?? comercioA,
          transactionType: 'CREDIT',
          amount: p.amount,
          providerRate: 0,
          providerCostAmount: 0,
          venueRate: 0,
          venueChargeAmount: p.fee,
          venueFixedFee: 0,
          grossProfit: 0,
          profitMargin: 0,
          createdAt: p.at ?? at,
        },
      })
    }
  }
  return order.id
}

const resumen = (venueId: string, extra: Record<string, unknown> = {}) =>
  getSalesSummary(venueId, { startDate: FROM, endDate: TO, timezone: TZ, ...extra })

let testarudo: string
let abiertas: string
let conCargo: string
let uber: string
let mixto: string
let devolucion: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Cabecera Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  providerId = (
    await prisma.paymentProvider.create({
      data: { code: `CAB-${suffix}`, name: `P ${suffix}`, type: 'PAYMENT_PROCESSOR' },
      select: { id: true },
    })
  ).id
  aggregatorId = (await prisma.aggregator.create({ data: { name: `Agg ${suffix}`, baseFees: {} }, select: { id: true } })).id
  comercioA = (
    await prisma.merchantAccount.create({
      data: { providerId, externalMerchantId: `a-${suffix}`, credentialsEncrypted: {}, aggregatorId },
      select: { id: true },
    })
  ).id
  comercioB = (
    await prisma.merchantAccount.create({
      data: { providerId, externalMerchantId: `b-${suffix}`, credentialsEncrypted: {}, aggregatorId },
      select: { id: true },
    })
  ).id

  // D6 · Testarudo: tres cuentas cobradas y las tres fantasma del 15-sep (CONFIRMED, sin pago).
  testarudo = await venue('testarudo')
  const cobrada = await cuenta({ venueId: testarudo, subtotal: 1000, tip: 100, pagos: [{ amount: 1000, tip: 100 }] })
  await cuenta({ venueId: testarudo, subtotal: 500, tip: 50, pagos: [{ amount: 500, tip: 50, method: 'CREDIT_CARD' }] })
  await cuenta({ venueId: testarudo, subtotal: 300, discount: 20, pagos: [{ amount: 280 }] })
  const fantasma = await cuenta({
    venueId: testarudo,
    subtotal: 380,
    tip: 38,
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    remainingBalance: 418,
  })
  for (const [orderId, total] of [
    [cobrada, 1000],
    [fantasma, 380],
  ] as const) {
    await prisma.orderItem.create({ data: { orderId, productName: 'Comida', quantity: 1, unitPrice: total, taxAmount: 0, total } })
  }
  await cuenta({ venueId: testarudo, subtotal: 170, status: 'CONFIRMED', paymentStatus: 'PENDING', remainingBalance: 170 })
  await cuenta({ venueId: testarudo, subtotal: 145, tip: 14.5, status: 'CONFIRMED', paymentStatus: 'PENDING', remainingBalance: 159.5 })

  // D6 · lo que falta de cada cuenta abierta, sin propina.
  abiertas = await venue('abiertas')
  // Pagada a medias: $200, abono de $80 + $8 de propina ⇒ faltan $120.
  await cuenta({
    venueId: abiertas,
    subtotal: 200,
    tip: 8,
    status: 'CONFIRMED',
    paymentStatus: 'PARTIAL',
    remainingBalance: 120,
    pagos: [{ amount: 80, tip: 8, method: 'CREDIT_CARD', merchant: comercioA, fee: 2 }],
  })
  // Abono de $60 devuelto (vuelve a deberse: reopenedAmount) ⇒ faltan los $100.
  await cuenta({
    venueId: abiertas,
    subtotal: 100,
    status: 'CONFIRMED',
    paymentStatus: 'PARTIAL',
    remainingBalance: 100,
    pagos: [{ amount: 60 }, { amount: -60, type: 'REFUND', reopenedAmount: 60 }],
  })
  // IVA cobrado aparte: $100 + $16.
  await cuenta({ venueId: abiertas, subtotal: 100, tax: 16, contrato: 'IVA_APARTE', status: 'CONFIRMED', paymentStatus: 'PENDING' })
  // Cortesía de cuenta completa, todavía abierta: no debe nada y no cuenta como cuenta sin cobrar.
  await cuenta({ venueId: abiertas, subtotal: 50, discount: 50, status: 'CONFIRMED', paymentStatus: 'PENDING' })
  // Con cargo por servicio: $100 + $10.
  await cuenta({ venueId: abiertas, subtotal: 100, serviceCharge: 10, status: 'CONFIRMED', paymentStatus: 'PENDING' })
  // Cancelada: fuera de todo.
  await cuenta({ venueId: abiertas, subtotal: 999, status: 'CANCELLED', paymentStatus: 'PENDING' })

  // D2 · cargo por servicio en una cuenta cobrada.
  conCargo = await venue('cargo')
  await cuenta({ venueId: conCargo, subtotal: 100, serviceCharge: 15, tip: 10, pagos: [{ amount: 115, tip: 10 }] })
  await cuenta({ venueId: conCargo, subtotal: 200, pagos: [{ amount: 200 }] })

  // D1 · Uber al 30 % ($30 de $100), un ajuste del proveedor que regresa $10 y $3 de su comisión, y una tarjeta con $3 de Avoqado.
  uber = await venue('uber')
  await cuenta({
    venueId: uber,
    subtotal: 100,
    pagos: [
      { amount: 100, method: 'OTHER', tenderCommission: 30, fundsFlow: 'EXTERNAL_RECORDED' },
      { amount: -10, method: 'OTHER', type: 'REFUND', tenderCommission: -3, fundsFlow: 'EXTERNAL_RECORDED' },
    ],
  })
  await cuenta({ venueId: uber, subtotal: 200, pagos: [{ amount: 200, method: 'CREDIT_CARD', merchant: comercioA, fee: 3 }] })

  // D9.1 · $300 pagados $100 con el comercio A ($3 de comisión) y $200 en efectivo; otra de $150 toda con B ($4).
  mixto = await venue('mixto')
  await cuenta({
    venueId: mixto,
    subtotal: 300,
    pagos: [{ amount: 100, method: 'CREDIT_CARD', merchant: comercioA, fee: 3 }, { amount: 200 }],
  })
  await cuenta({ venueId: mixto, subtotal: 150, pagos: [{ amount: 150, method: 'CREDIT_CARD', merchant: comercioB, fee: 4 }] })

  // D10.1 · hoy: un cobro en efectivo de $100, uno de $50 con tipo NULL (viejo) y la devolución de $30 de una venta de ayer.
  devolucion = await venue('devolucion')
  await cuenta({ venueId: devolucion, subtotal: 100, pagos: [{ amount: 100 }] })
  await cuenta({ venueId: devolucion, subtotal: 50, pagos: [{ amount: 50, type: null }] })
  await cuenta({
    venueId: devolucion,
    subtotal: 30,
    at: AYER,
    pagos: [
      { amount: 30, method: 'CREDIT_CARD', at: AYER },
      { amount: -30, method: 'CREDIT_CARD', type: 'REFUND', at: INSIDE },
    ],
  })
})

afterAll(async () => {
  for (const v of venues) {
    await prisma.orderItem.deleteMany({ where: { order: { venueId: v } } })
    await prisma.transactionCost.deleteMany({ where: { payment: { venueId: v } } })
    await prisma.payment.deleteMany({ where: { venueId: v } })
    await prisma.order.deleteMany({ where: { venueId: v } })
    await prisma.venue.deleteMany({ where: { id: v } })
  }
  if (comercioA) await prisma.merchantAccount.deleteMany({ where: { id: { in: [comercioA, comercioB] } } })
  if (aggregatorId) await prisma.aggregator.deleteMany({ where: { id: aggregatorId } })
  if (providerId) await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('D6 · base de caja + «Sin cobrar»', () => {
  it('Testarudo: las fantasmas no son venta; salen en «Sin cobrar» (3 cuentas, $695 sin propina) y el neto cuadra con Inicio', async () => {
    const r = await resumen(testarudo)
    expect(cents(r.summary.grossSales)).toBe(180000)
    expect(cents(r.summary.discounts)).toBe(2000)
    expect(cents(r.summary.netSales)).toBe(178000)
    expect(cents(r.summary.unpaidSales)).toBe(69500)
    expect(r.summary.unpaidOrders).toBe(3)
    // «Ventas diferidas» se conserva tal cual (Σ remainingBalance, con propina) para los clientes viejos.
    expect(cents(r.summary.deferredSales)).toBe(74750)
    expect(cents(r.summary.totalCollected)).toBe(193000)
    // Inicio suma los cobros: lo mismo que las ventas netas del Resumen.
    const inicio = await getBasicMetricsData(testarudo, { fromDate: FROM, toDate: TO })
    expect(cents(inicio.summary.totalAmount)).toBe(cents(r.summary.netSales))
    // Y el correo nocturno («Origen del pedido») dice lo mismo: las fantasmas tampoco entran ahí.
    const origen = await getOrderSourcesBreakdown(testarudo, new Date(FROM), new Date(TO))
    expect(origen.reduce((s, o) => s + Math.round(o.netSales * 100), 0)).toBe(cents(r.summary.netSales))
    // El desglose por categoría tampoco cuenta el renglón de la fantasma.
    const categorias = await getCategoryBreakdown(testarudo, new Date(FROM), new Date(TO))
    expect(categorias).toEqual([{ name: 'Sin categorizar', itemsSold: 1, netSales: 1000 }])
  })

  it('cada cuenta abierta aporta lo que todavía debe, sin propina, en las unidades de las ventas brutas', async () => {
    const r = await resumen(abiertas)
    // 120 (abono de 80) + 100 (abono devuelto) + 116 (IVA aparte) + 0 (cortesía total) + 110 (cargo por servicio).
    expect(cents(r.summary.unpaidSales)).toBe(44600)
    expect(r.summary.unpaidOrders).toBe(4)
    expect(cents(r.summary.grossSales)).toBe(0)
  })

  it('🔴 Codex r4: un abono de una cuenta abierta no cuenta en nada hasta que la cuenta se cobre (ni su propina, ni su comisión, ni su devolución)', async () => {
    const r = await resumen(abiertas)
    // Sin esto: $8 de propina − $2 de comisión, sobre $0 de ventas, y la devolución del abono de $60 restando como venta.
    expect(cents(r.summary.netSales)).toBe(0)
    expect(cents(r.summary.tips)).toBe(0)
    expect(cents(r.summary.platformFees)).toBe(0)
    expect(cents(r.summary.refunds)).toBe(0)
    expect(r.summary.refundCount).toBe(0)
    expect(r.summary.transactionCount).toBe(0)
    expect(cents(r.summary.totalCollected)).toBe(0)
    expect(cents(r.summary.netProfit)).toBe(0)
    // Por periodo igual; y en la vista de movimientos (comercio A) el abono sí se ve: $80 + $8 − $2.
    const p = await resumen(abiertas, { reportType: 'days' })
    expect((p.byPeriod ?? []).reduce((s, x) => s + Math.round(x.metrics.totalCollected * 100), 0)).toBe(0)
    const a = await resumen(abiertas, { merchantAccountId: comercioA })
    expect(cents(a.summary.totalCollected)).toBe(8600)
  })

  it('por periodo: las barras suman la cabecera, también «Sin cobrar»', async () => {
    const r = await resumen(testarudo, { reportType: 'days' })
    const suma = (k: 'grossSales' | 'unpaidSales') => (r.byPeriod ?? []).reduce((s, p) => s + Math.round((p.metrics[k] ?? 0) * 100), 0)
    expect(suma('grossSales')).toBe(180000)
    expect(suma('unpaidSales')).toBe(69500)
    expect((r.byPeriod ?? []).reduce((s, p) => s + (p.metrics.unpaidOrders ?? 0), 0)).toBe(3)
  })

  it('bajo un filtro de método, «Sin cobrar» es nulo como las demás métricas de orden', async () => {
    const r = await resumen(testarudo, { paymentMethod: 'CASH' })
    expect(r.summary.unpaidSales).toBeNull()
    expect(r.summary.unpaidOrders).toBeNull()
    expect(r.summary.grossSales).toBeNull()
  })
})

describe('D2 · los cargos por servicio son venta', () => {
  it('serviceCosts = Σ cargos de las cuentas cobradas y grossSales = artículos + cargos', async () => {
    const r = await resumen(conCargo)
    expect(cents(r.summary.items)).toBe(30000)
    expect(cents(r.summary.serviceCosts)).toBe(1500)
    expect(cents(r.summary.grossSales)).toBe(31500)
    expect(cents(r.summary.netSales)).toBe(31500)
    expect(cents(r.summary.totalCollected)).toBe(32500)
  })

  it('por periodo igual', async () => {
    const r = await resumen(conCargo, { reportType: 'days' })
    const suma = (k: 'grossSales' | 'serviceCosts') => (r.byPeriod ?? []).reduce((s, p) => s + Math.round((p.metrics[k] ?? 0) * 100), 0)
    expect(suma('serviceCosts')).toBe(1500)
    expect(suma('grossSales')).toBe(31500)
  })

  it('el correo nocturno sigue sumando las ventas netas: origen del pedido y desglose con su renglón de cargos', async () => {
    const r = await resumen(conCargo)
    const origen = await getOrderSourcesBreakdown(conCargo, new Date(FROM), new Date(TO))
    expect(origen.reduce((s, o) => s + Math.round(o.netSales * 100), 0)).toBe(cents(r.summary.netSales))
    const filas = reconcileCategoryBreakdown(
      await getCategoryBreakdown(conCargo, new Date(FROM), new Date(TO)),
      r.summary.netSales ?? 0,
      r.summary.refunds,
      conCargo,
      r.summary.serviceCosts ?? 0,
    )
    expect(filas).toContainEqual({ name: 'Cargos por servicio', itemsSold: null, netSales: 15 })
    expect(filas.reduce((s, f) => s + Math.round(f.netSales * 100), 0)).toBe(cents(r.summary.netSales))
  })
})

describe('D1 · la comisión de terceros (Uber, Rappi, tipos de pago propios)', () => {
  it('se resta del cobrado y de la ganancia, aparte de la de Avoqado; el ajuste del proveedor regresa su parte', async () => {
    const r = await resumen(uber)
    expect(cents(r.summary.netSales)).toBe(29000)
    expect(cents(r.summary.platformFees)).toBe(300)
    expect(cents(r.summary.tenderCommissions)).toBe(2700)
    expect(cents(r.summary.totalCollected)).toBe(26000)
    expect(cents(r.summary.netProfit)).toBe(26000)
  })

  it('en la vista de movimientos (filtro «Otros») también', async () => {
    const r = await resumen(uber, { paymentMethod: 'OTHER' })
    expect(cents(r.summary.tenderCommissions)).toBe(2700)
    expect(cents(r.summary.totalCollected)).toBe(6300)
  })

  it('por periodo: las barras suman la cabecera', async () => {
    const r = await resumen(uber, { reportType: 'days' })
    const suma = (k: 'tenderCommissions' | 'totalCollected') =>
      (r.byPeriod ?? []).reduce((s, p) => s + Math.round((p.metrics[k] ?? 0) * 100), 0)
    expect(suma('tenderCommissions')).toBe(2700)
    expect(suma('totalCollected')).toBe(26000)
  })
})

describe('D9.1 · con un comercio elegido, los números son de ese comercio', () => {
  it('cuenta mixta: con A sólo cuentan los $100 de A menos su comisión (no los $300 de la cuenta)', async () => {
    const r = await resumen(mixto, { merchantAccountId: comercioA })
    expect(r.filtered).toBe(true)
    expect(r.summary.grossSales).toBeNull()
    expect(r.summary.netSales).toBeNull()
    expect(r.summary.serviceCosts).toBeNull()
    expect(r.summary.unpaidSales).toBeNull()
    expect(cents(r.summary.totalCollected)).toBe(9700)
    expect(cents(r.summary.netProfit)).toBe(9700)
    expect(r.summary.transactionCount).toBe(1)
  })

  it('por periodo igual', async () => {
    const r = await resumen(mixto, { merchantAccountId: comercioA, reportType: 'days' })
    expect((r.byPeriod ?? []).every(p => p.metrics.grossSales === null)).toBe(true)
    expect((r.byPeriod ?? []).reduce((s, p) => s + Math.round(p.metrics.totalCollected * 100), 0)).toBe(9700)
  })

  it('sin comercio, la cabecera sigue completa', async () => {
    const r = await resumen(mixto)
    expect(r.filtered).toBe(false)
    expect(cents(r.summary.grossSales)).toBe(45000)
    expect(cents(r.summary.totalCollected)).toBe(44300)
  })
})

describe('D10.1 · las devoluciones no son transacciones', () => {
  it('un día con dos cobros (uno con tipo NULL) y una devolución dice 2 transacciones', async () => {
    const r = await resumen(devolucion)
    expect(r.summary.transactionCount).toBe(2)
    expect(cents(r.summary.refunds)).toBe(3000)
  })

  it('por periodo y bajo filtro igual', async () => {
    const p = await resumen(devolucion, { reportType: 'days' })
    expect((p.byPeriod ?? []).reduce((s, x) => s + x.metrics.transactionCount, 0)).toBe(2)
    const tarjeta = await resumen(devolucion, { paymentMethod: 'CARD' })
    expect(tarjeta.summary.transactionCount).toBe(0)
    expect(cents(tarjeta.summary.refunds)).toBe(3000)
  })
})
