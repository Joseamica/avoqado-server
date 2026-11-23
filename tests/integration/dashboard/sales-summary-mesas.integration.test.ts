/**
 * Carril B3 · las cuentas abiertas de la TPV en «Sin cobrar» (REAL PostgreSQL, 23-nov-2026). Clave hz:fefa11b6:D19.
 *
 * Abrir mesa (y Cobrar, separar, el check-in de una reserva, una cuenta reabierta…) deja la cuenta en `Order.status = PENDING`
 * mientras sigue abierta: `PENDING` NO es un borrador. La cabecera la trataba como tal y la sacaba de todo: «Sin cobrar» nunca veía
 * una mesa, su abono sí contaba como transacción, y una mesa ya cubierta por sus cobros (o PAID sin cerrar) no era venta ni deuda:
 * desaparecía del reporte. Lo que de verdad todavía no es cuenta sigue fuera, también su cobro: el reparto o el pedido en línea que
 * nadie aceptó, el folio por pagar de la tienda híbrida (decisión «A», 23-nov), el kiosco, la orden testigo de un cobro con cripto
 * (sin renglones) y la mesa vacía.
 *
 *   npx jest --selectProjects integration --testPathPattern sales-summary-mesas   (por avq-verify: corre en la nube)
 */

import type { OnlineOrderStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { getCategoryBreakdown, getOrderSourcesBreakdown } from '@/jobs/nightly-sales-summary.job'

jest.setTimeout(60000)

const TZ = 'America/Mexico_City'
const FROM = '2025-06-10T06:00:00.000Z'
const TO = '2025-06-11T05:59:59.999Z'
const INSIDE = new Date('2025-06-10T18:00:00.000Z')
const suffix = `mesas-${Date.now()}`
const cents = (n: number | null | undefined) => (n == null ? n : Math.round(n * 100))

let orgId: string
const venues: string[] = []
let providerId: string
let aggregatorId: string
let comercio: string
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
  method?: 'CASH' | 'CREDIT_CARD' | 'CRYPTOCURRENCY'
  status?: 'COMPLETED' | 'FAILED'
  /** `null` = un cobro viejo sin tipo (antes de que existiera la columna): sí es cobro. */
  type?: 'REGULAR' | 'REFUND' | null
  /** Lo que una devolución de un abono volvió a deber (D19). */
  reopenedAmount?: number
  /** Comisión de Avoqado guardada en el `TransactionCost` del cobro. */
  fee?: number
}

type Cuenta = {
  venueId: string
  subtotal: number
  tip?: number
  status?: 'PENDING' | 'CONFIRMED' | 'COMPLETED'
  paymentStatus?: 'PAID' | 'PENDING' | 'PARTIAL'
  remainingBalance?: number
  source?: 'TPV' | 'KIOSK' | 'WEB' | 'RAPPI' | 'POS'
  type?: 'DINE_IN' | 'TAKEOUT' | 'DELIVERY' | 'PICKUP'
  originSystem?: 'AVOQADO' | 'DELIVERY_PLATFORM' | 'POS_SOFTRESTAURANT'
  providerAcceptedAt?: Date
  /** Sin renglones = la orden testigo de un cobro con cripto, una mesa recién abierta o la cabecera de SoftRestaurant. */
  sinRenglones?: boolean
  /** Su pedido en línea: «Mi equipo» (`requiresAcceptance: true`) o un folio de la tienda híbrida (`false`). */
  enLinea?: { requiresAcceptance: boolean; status?: OnlineOrderStatus }
  pagos?: Pago[]
}

async function cuenta(c: Cuenta): Promise<string> {
  seq += 1
  const order = await prisma.order.create({
    data: {
      venueId: c.venueId,
      orderNumber: `MES-${seq}-${suffix}`,
      createdAt: INSIDE,
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: c.subtotal,
      taxAmount: 0,
      tipAmount: c.tip ?? 0,
      total: c.subtotal + (c.tip ?? 0),
      remainingBalance: c.remainingBalance ?? 0,
      status: c.status ?? 'PENDING',
      paymentStatus: c.paymentStatus ?? 'PENDING',
      source: c.source ?? 'TPV',
      type: c.type ?? 'DINE_IN',
      originSystem: c.originSystem ?? 'AVOQADO',
      providerAcceptedAt: c.providerAcceptedAt,
    },
    select: { id: true },
  })
  if (!c.sinRenglones && c.subtotal > 0) {
    await prisma.orderItem.create({
      data: { orderId: order.id, productName: 'Comida', quantity: 1, unitPrice: c.subtotal, taxAmount: 0, total: c.subtotal },
    })
  }
  if (c.enLinea) {
    await prisma.onlineOrder.create({
      data: {
        orderId: order.id,
        venueId: c.venueId,
        status: c.enLinea.status ?? 'PENDING_ACCEPTANCE',
        paymentMode: 'PAY_AT_PICKUP',
        trackingToken: `trk-${seq}-${suffix}`,
        acceptDeadlineAt: new Date(INSIDE.getTime() + 30 * 60_000),
        requiresAcceptance: c.enLinea.requiresAcceptance,
      },
    })
  }
  for (const p of c.pagos ?? []) {
    const pago = await prisma.payment.create({
      data: {
        venueId: c.venueId,
        orderId: order.id,
        amount: p.amount,
        tipAmount: p.tip ?? 0,
        method: p.method ?? 'CASH',
        status: p.status ?? 'COMPLETED',
        type: p.type === undefined ? 'REGULAR' : p.type,
        reopenedAmount: p.reopenedAmount,
        merchantAccountId: p.fee !== undefined ? comercio : undefined,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: p.amount,
        createdAt: INSIDE,
      },
      select: { id: true },
    })
    if (p.fee !== undefined) {
      await prisma.transactionCost.create({
        data: {
          paymentId: pago.id,
          merchantAccountId: comercio,
          transactionType: 'CREDIT',
          amount: p.amount,
          providerRate: 0,
          providerCostAmount: 0,
          venueRate: 0,
          venueChargeAmount: p.fee,
          venueFixedFee: 0,
          grossProfit: 0,
          profitMargin: 0,
          createdAt: INSIDE,
        },
      })
    }
  }
  return order.id
}

const resumen = (venueId: string, extra: Record<string, unknown> = {}) =>
  getSalesSummary(venueId, { startDate: FROM, endDate: TO, timezone: TZ, ...extra })

type Metrica = 'grossSales' | 'unpaidSales' | 'unpaidOrders' | 'tips' | 'transactionCount'
/** La suma de una métrica en la tabla por día, en centavos (los conteos, tal cual). */
async function sumaPorDia(venueId: string, k: Metrica): Promise<number> {
  const r = await resumen(venueId, { reportType: 'days' })
  const conteo = k === 'unpaidOrders' || k === 'transactionCount'
  return (r.byPeriod ?? []).reduce((s, p) => s + (conteo ? Number(p.metrics[k] ?? 0) : Math.round(Number(p.metrics[k] ?? 0) * 100)), 0)
}

/** El correo nocturno («Origen del pedido» y «Desglose por categoría») tiene que sumar las ventas netas de la cabecera. */
async function correoCuadra(venueId: string, netSales: number | null | undefined) {
  const origen = await getOrderSourcesBreakdown(venueId, new Date(FROM), new Date(TO))
  expect(origen.reduce((s, o) => s + Math.round(o.netSales * 100), 0)).toBe(cents(netSales))
}

let mesas: string
let cubierta: string
let pagadaSinCerrar: string
let cabeceraSinRenglones: string
let cobroSinTipo: string
let reparto: string
let folios: string
let noSonCuentas: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Mesas Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  providerId = (
    await prisma.paymentProvider.create({
      data: { code: `MES-${suffix}`, name: `P ${suffix}`, type: 'PAYMENT_PROCESSOR' },
      select: { id: true },
    })
  ).id
  aggregatorId = (await prisma.aggregator.create({ data: { name: `Agg ${suffix}`, baseFees: {} }, select: { id: true } })).id
  comercio = (
    await prisma.merchantAccount.create({
      data: { providerId, externalMerchantId: `m-${suffix}`, credentialsEncrypted: {}, aggregatorId },
      select: { id: true },
    })
  ).id

  // El caso medido en D19: dos mesas de la TPV abiertas. $50 sin pagar; $85 con un abono de $30 + $5 de propina (con $1 de comisión).
  mesas = await venue('mesas')
  await cuenta({ venueId: mesas, subtotal: 50, remainingBalance: 50 })
  await cuenta({
    venueId: mesas,
    subtotal: 85,
    tip: 5,
    paymentStatus: 'PARTIAL',
    remainingBalance: 55,
    pagos: [{ amount: 30, tip: 5, method: 'CREDIT_CARD', fee: 1 }],
  })

  // 🔴 Pregunta 2 del encargo, cada caso en su negocio: una mesa que sus cobros ya cubren pero sigue abierta (la «pagada pero abierta»
  // que cierra el barrido), una ya PAID sin cerrar (lo que deja la corrección de precio de una venta verificada) y la cabecera de
  // SoftRestaurant, que se guarda sin renglones, cubierta por el cobro de la TPV con el aviso de cierre perdido (Codex B3 r1 #4).
  cubierta = await venue('cubierta')
  await cuenta({ venueId: cubierta, subtotal: 120, tip: 10, paymentStatus: 'PARTIAL', pagos: [{ amount: 120, tip: 10 }] })
  pagadaSinCerrar = await venue('pagada-sin-cerrar')
  await cuenta({ venueId: pagadaSinCerrar, subtotal: 40, paymentStatus: 'PAID', pagos: [{ amount: 40 }] })
  cabeceraSinRenglones = await venue('cabecera-sin-renglones')
  await cuenta({
    venueId: cabeceraSinRenglones,
    subtotal: 75,
    source: 'POS',
    originSystem: 'POS_SOFTRESTAURANT',
    sinRenglones: true,
    paymentStatus: 'PARTIAL',
    pagos: [{ amount: 75 }],
  })

  // Revisión de apps viejas (hallazgo 4): una cuenta de $100 con PARTIAL rezagado y un cobro viejo de $100 con `type` NULL. La puerta
  // de «cobrada» pedía REGULAR/FAST: salía con $0 de venta y, como lo pagado sí cuenta el NULL, con $0 «Sin cobrar».
  cobroSinTipo = await venue('cobro-sin-tipo')
  await cuenta({
    venueId: cobroSinTipo,
    subtotal: 100,
    status: 'CONFIRMED',
    paymentStatus: 'PARTIAL',
    pagos: [{ amount: 100, type: null }],
  })

  // Reparto en modo manual: aceptar a mano NO cambia el estado (sólo estampa `providerAcceptedAt`). Sin aceptar no es cuenta, ni su
  // cobro ni su propina (Codex B3 r1 #1); aceptado y pagado por la plataforma es venta; aceptado con efectivo contra entrega (Rappi
  // 2b) sale en «Sin cobrar».
  reparto = await venue('reparto')
  const delivery = { source: 'RAPPI' as const, type: 'DELIVERY' as const, originSystem: 'DELIVERY_PLATFORM' as const }
  await cuenta({ venueId: reparto, ...delivery, subtotal: 200, tip: 20, paymentStatus: 'PAID', pagos: [{ amount: 200, tip: 20 }] })
  await cuenta({
    venueId: reparto,
    ...delivery,
    subtotal: 150,
    paymentStatus: 'PAID',
    providerAcceptedAt: INSIDE,
    pagos: [{ amount: 150 }],
  })
  await cuenta({ venueId: reparto, ...delivery, subtotal: 90, providerAcceptedAt: INSIDE, remainingBalance: 90 })

  // Tienda híbrida («Nadie», pagar en caja), decisión «A» del 23-nov: el folio por pagar se cobra desde su lista «Por pagar» y no
  // es «Sin cobrar», ni su abono cuenta hasta que se paga completo. Sin pagar ($80), con abono vivo de $50 + $5 de propina, y vencido
  // con su abono devuelto (R44: `EXPIRED` sin cancelar, PARTIAL, «debe» $100; Codex B3 r1 #2).
  folios = await venue('folios')
  const folio = { source: 'WEB' as const, type: 'PICKUP' as const }
  await cuenta({ venueId: folios, ...folio, subtotal: 80, remainingBalance: 80, enLinea: { requiresAcceptance: false } })
  await cuenta({
    venueId: folios,
    ...folio,
    subtotal: 100,
    tip: 5,
    paymentStatus: 'PARTIAL',
    remainingBalance: 50,
    enLinea: { requiresAcceptance: false },
    pagos: [{ amount: 50, tip: 5 }],
  })
  await cuenta({
    venueId: folios,
    ...folio,
    subtotal: 100,
    paymentStatus: 'PARTIAL',
    remainingBalance: 100,
    enLinea: { requiresAcceptance: false, status: 'EXPIRED' },
    pagos: [{ amount: 50 }, { amount: -50, type: 'REFUND', reopenedAmount: 50 }],
  })

  // Lo que sigue sin ser cuenta: pedido en línea «Mi equipo» por aceptar, kiosco abandonado, testigo de un cobro con cripto que
  // falló, mesa vacía.
  noSonCuentas = await venue('no-son-cuentas')
  await cuenta({
    venueId: noSonCuentas,
    subtotal: 60,
    source: 'WEB',
    type: 'PICKUP',
    remainingBalance: 60,
    enLinea: { requiresAcceptance: true },
  })
  await cuenta({ venueId: noSonCuentas, subtotal: 45, source: 'KIOSK', type: 'TAKEOUT', remainingBalance: 45 })
  await cuenta({
    venueId: noSonCuentas,
    subtotal: 70,
    type: 'TAKEOUT',
    remainingBalance: 70,
    sinRenglones: true,
    pagos: [{ amount: 70, method: 'CRYPTOCURRENCY', status: 'FAILED' }],
  })
  await cuenta({ venueId: noSonCuentas, subtotal: 0 })
})

afterAll(async () => {
  for (const v of venues) {
    await prisma.onlineOrder.deleteMany({ where: { venueId: v } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId: v } } })
    await prisma.transactionCost.deleteMany({ where: { payment: { venueId: v } } })
    await prisma.payment.deleteMany({ where: { venueId: v } })
    await prisma.order.deleteMany({ where: { venueId: v } })
    await prisma.venue.deleteMany({ where: { id: v } })
  }
  if (comercio) await prisma.merchantAccount.deleteMany({ where: { id: comercio } })
  if (aggregatorId) await prisma.aggregator.deleteMany({ where: { id: aggregatorId } })
  if (providerId) await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('🔴 B3 · una mesa PENDING que sus cobros ya cubren ES venta (antes desaparecía de las ventas y de «Sin cobrar»)', () => {
  it('mesa abierta cubierta por su cobro ($120 + $10 de propina): venta $120, 1 transacción, su propina, nada en «Sin cobrar»', async () => {
    const r = await resumen(cubierta)
    expect(cents(r.summary.grossSales)).toBe(12000)
    expect(cents(r.summary.netSales)).toBe(12000)
    expect(cents(r.summary.tips)).toBe(1000)
    expect(r.summary.transactionCount).toBe(1)
    expect(cents(r.summary.totalCollected)).toBe(13000)
    expect(cents(r.summary.unpaidSales)).toBe(0)
    expect(r.summary.unpaidOrders).toBe(0)
    expect(await sumaPorDia(cubierta, 'grossSales')).toBe(12000)
    expect(await sumaPorDia(cubierta, 'transactionCount')).toBe(1)
    await correoCuadra(cubierta, r.summary.netSales)
    const categorias = await getCategoryBreakdown(cubierta, new Date(FROM), new Date(TO))
    expect(categorias).toEqual([{ name: 'Sin categorizar', itemsSold: 1, netSales: 120 }])
  })

  it('mesa PAID que no se cerró ($40): venta $40, 1 transacción, nada en «Sin cobrar»', async () => {
    const r = await resumen(pagadaSinCerrar)
    expect(cents(r.summary.grossSales)).toBe(4000)
    expect(cents(r.summary.netSales)).toBe(4000)
    expect(r.summary.transactionCount).toBe(1)
    expect(cents(r.summary.unpaidSales)).toBe(0)
    expect(await sumaPorDia(pagadaSinCerrar, 'grossSales')).toBe(4000)
    await correoCuadra(pagadaSinCerrar, r.summary.netSales)
  })

  it('cabecera de SoftRestaurant sin renglones, cubierta por la TPV ($75): es venta aunque no tenga renglones', async () => {
    const r = await resumen(cabeceraSinRenglones)
    expect(cents(r.summary.grossSales)).toBe(7500)
    expect(r.summary.transactionCount).toBe(1)
    expect(cents(r.summary.unpaidSales)).toBe(0)
    await correoCuadra(cabeceraSinRenglones, r.summary.netSales)
  })
})

describe('B3 · un cobro viejo con tipo NULL es cobro (revisión de apps viejas, hallazgo 4)', () => {
  it('cuenta de $100 PARTIAL rezagada con un cobro NULL de $100: venta $100, 1 transacción, nada en «Sin cobrar»', async () => {
    const r = await resumen(cobroSinTipo)
    expect(cents(r.summary.grossSales)).toBe(10000)
    expect(r.summary.transactionCount).toBe(1)
    expect(cents(r.summary.unpaidSales)).toBe(0)
    expect(r.summary.unpaidOrders).toBe(0)
    expect(await sumaPorDia(cobroSinTipo, 'grossSales')).toBe(10000)
    await correoCuadra(cobroSinTipo, r.summary.netSales)
  })
})

describe('B3 · una mesa abierta de la TPV (PENDING) es una cuenta', () => {
  it('🔴 D19: las dos mesas salen en «Sin cobrar» ($50 + $55 = $105, 2 cuentas) y no son venta', async () => {
    const r = await resumen(mesas)
    expect(cents(r.summary.unpaidSales)).toBe(10500)
    expect(r.summary.unpaidOrders).toBe(2)
    expect(cents(r.summary.deferredSales)).toBe(10500)
    expect(cents(r.summary.grossSales)).toBe(0)
    expect(cents(r.summary.netSales)).toBe(0)
  })

  it('🔴 D19: el abono de la mesa a medias no cuenta en transacciones, propinas ni comisión hasta que se cobre', async () => {
    const r = await resumen(mesas)
    expect(r.summary.transactionCount).toBe(0)
    expect(cents(r.summary.tips)).toBe(0)
    expect(cents(r.summary.platformFees)).toBe(0)
    expect(cents(r.summary.totalCollected)).toBe(0)
    expect(cents(r.summary.netProfit)).toBe(0)
  })

  it('por periodo igual: las barras suman la cabecera', async () => {
    expect(await sumaPorDia(mesas, 'unpaidSales')).toBe(10500)
    expect(await sumaPorDia(mesas, 'unpaidOrders')).toBe(2)
    expect(await sumaPorDia(mesas, 'transactionCount')).toBe(0)
    expect(await sumaPorDia(mesas, 'tips')).toBe(0)
  })

  it('en la vista de movimientos (comercio elegido) el abono sí se ve, como antes: $30 + $5 − $1', async () => {
    const r = await resumen(mesas, { merchantAccountId: comercio })
    expect(r.summary.unpaidSales).toBeNull()
    expect(cents(r.summary.totalCollected)).toBe(3400)
    expect(r.summary.transactionCount).toBe(1)
  })
})

describe('B3 · reparto en modo manual', () => {
  it('aceptado a mano ya cuenta (venta $150, «Sin cobrar» $90 del efectivo por cobrar); sin aceptar, ni su cobro ni su propina', async () => {
    const r = await resumen(reparto)
    expect(cents(r.summary.grossSales)).toBe(15000)
    expect(cents(r.summary.unpaidSales)).toBe(9000)
    expect(r.summary.unpaidOrders).toBe(1)
    expect(r.summary.transactionCount).toBe(1)
    expect(cents(r.summary.tips)).toBe(0)
    expect(cents(r.summary.totalCollected)).toBe(15000)
    expect(await sumaPorDia(reparto, 'transactionCount')).toBe(1)
    expect(await sumaPorDia(reparto, 'tips')).toBe(0)
  })
})

describe('B3 · folio por pagar de la tienda híbrida (decisión «A»: se cobra desde «Por pagar»)', () => {
  it('ni sin pagar, ni con abono vivo, ni vencido con su abono devuelto salen en «Sin cobrar»; su abono no cuenta', async () => {
    const r = await resumen(folios)
    expect(cents(r.summary.unpaidSales)).toBe(0)
    expect(r.summary.unpaidOrders).toBe(0)
    expect(cents(r.summary.grossSales)).toBe(0)
    expect(cents(r.summary.tips)).toBe(0)
    expect(r.summary.transactionCount).toBe(0)
    expect(cents(r.summary.refunds)).toBe(0)
    expect(cents(r.summary.totalCollected)).toBe(0)
    expect(await sumaPorDia(folios, 'unpaidSales')).toBe(0)
  })
})

describe('B3 · lo que todavía no es cuenta sigue fuera', () => {
  it('pedido en línea por aceptar, kiosco, testigo de cripto y mesa vacía: nada en ventas ni en «Sin cobrar»', async () => {
    const r = await resumen(noSonCuentas)
    expect(cents(r.summary.grossSales)).toBe(0)
    expect(cents(r.summary.unpaidSales)).toBe(0)
    expect(r.summary.unpaidOrders).toBe(0)
    expect(cents(r.summary.deferredSales)).toBe(0)
    expect(await sumaPorDia(noSonCuentas, 'unpaidSales')).toBe(0)
  })
})
