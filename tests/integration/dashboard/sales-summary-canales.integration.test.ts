/**
 * Carril G · ventas por canal y por tipo de pedido, y lo cobrado por adelantado (REAL PostgreSQL, 22-nov-2026).
 * Tarjetas hz:fefa11b6:D4 y D5.
 *
 * - D4: `byChannel` y `byOrderType` reparten la cabecera de `getSalesSummary` por la cuenta de cada cobro, y CADA tabla suma la
 *   cabecera al centavo (bruto, descuentos, devoluciones, neto, propinas, comisiones de Avoqado y de terceros, neto cobrado,
 *   transacciones y devoluciones), con los casos raros que la cabecera ya resuelve: abono de cuenta abierta, cuenta de tarjetas de
 *   regalo, cuenta cancelada con su devolución, devolución de una venta de ayer, IVA aparte, cortesía oculta, cargo por servicio,
 *   venta sin red con hora del aparato y comisión de Avoqado de 4 decimales.
 * - D5: el paquete comprado en línea y el depósito de una reserva salen en sus renglones, por la fecha de cobro, y NO en ventas.
 *
 *   npx jest --selectProjects integration --testPathPattern sales-summary-canales   (por avq-verify: corre en la nube)
 */

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { centavosComoSeVen } from '@/services/dashboard/salesSummaryCanales'

jest.setTimeout(60000)

const TZ = 'America/Mexico_City'
const FROM = '2025-06-10T06:00:00.000Z'
const TO = '2025-06-11T05:59:59.999Z'
const INSIDE = new Date('2025-06-10T18:00:00.000Z')
const AYER = new Date('2025-06-09T18:00:00.000Z')
// Llegó al servidor al día siguiente (sin red), pero el aparato la hizo hoy: cuenta hoy (D93).
const LLEGO_MANANA = new Date('2025-06-11T09:00:00.000Z')
const suffix = `canales-${Date.now()}`
// Los centavos de la cabecera como los enseña la pantalla (su formateador redondea el valor exacto, no `n * 100`).
const cents = (n: number | null | undefined) => (n == null ? n : centavosComoSeVen(n))

let orgId: string
let providerId: string
let aggregatorId: string
let comercio: string
const venues: string[] = []
const giftCards: string[] = []
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
  type?: 'REGULAR' | 'FAST' | 'REFUND' | null
  /** Comisión de Avoqado en el `TransactionCost` del cobro (hasta 4 decimales). */
  fee?: number
  /** Comisión de un cobro en línea de Avoqado (Stripe de la tienda o de la liga), en el propio cobro. */
  onlineFee?: number
  tenderCommission?: number
  fundsFlow?: 'EXTERNAL_RECORDED' | 'CASH_DRAWER' | 'AVOQADO_PROCESSED'
  reopenedAmount?: number
  at?: Date
  clientAt?: Date
}

type Cuenta = {
  venueId: string
  source: 'TPV' | 'AVOQADO_ANDROID' | 'QR' | 'WEB' | 'PAYMENT_LINK' | 'RAPPI' | 'DASHBOARD_MANUAL' | 'KIOSK'
  type?: 'DINE_IN' | 'TAKEOUT' | 'DELIVERY' | 'PICKUP' | 'MANUAL_ENTRY'
  tableId?: string
  subtotal: number
  discount?: number
  serviceCharge?: number
  tax?: number
  contrato?: 'IVA_INCLUIDO' | 'IVA_APARTE'
  status?: 'COMPLETED' | 'CONFIRMED' | 'CANCELLED'
  paymentStatus?: 'PAID' | 'PENDING' | 'PARTIAL'
  at?: Date
  clientAt?: Date
  pagos?: Pago[]
}

async function cuenta(c: Cuenta) {
  seq += 1
  const at = c.at ?? INSIDE
  const total = Math.max(0, c.subtotal - (c.discount ?? 0)) + (c.serviceCharge ?? 0) + (c.tax ?? 0)
  const order = await prisma.order.create({
    data: {
      venueId: c.venueId,
      orderNumber: `CAN-${seq}-${suffix}`,
      source: c.source,
      type: c.type ?? 'DINE_IN',
      tableId: c.tableId,
      createdAt: at,
      clientCreatedAt: c.clientAt,
      contratoDePrecio: c.contrato ?? 'IVA_INCLUIDO',
      subtotal: c.subtotal,
      discountAmount: c.discount ?? 0,
      serviceChargeAmount: c.serviceCharge ?? 0,
      taxAmount: c.tax ?? 0,
      total,
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
        merchantAccountId: p.fee !== undefined ? comercio : undefined,
        fundsFlow: p.fundsFlow,
        tenderCommissionAmount: p.tenderCommission === undefined ? undefined : new Prisma.Decimal(p.tenderCommission),
        reopenedAmount: p.reopenedAmount,
        feePercentage: 0,
        feeAmount: p.onlineFee ?? 0,
        netAmount: p.amount,
        createdAt: p.at ?? at,
        clientCreatedAt: p.clientAt,
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
          venueChargeAmount: new Prisma.Decimal(p.fee),
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
  getSalesSummary(venueId, { startDate: FROM, endDate: TO, timezone: TZ, groupBy: 'paymentMethod', ...extra })

let tienda: string
let estudio: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Canales Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  providerId = (
    await prisma.paymentProvider.create({
      data: { code: `CAN-${suffix}`, name: `P ${suffix}`, type: 'PAYMENT_PROCESSOR' },
      select: { id: true },
    })
  ).id
  aggregatorId = (await prisma.aggregator.create({ data: { name: `Agg ${suffix}`, baseFees: {} }, select: { id: true } })).id
  comercio = (
    await prisma.merchantAccount.create({
      data: { providerId, externalMerchantId: `c-${suffix}`, credentialsEncrypted: {}, aggregatorId },
      select: { id: true },
    })
  ).id

  // ── D4 · una tienda que vende por todos lados ──────────────────────────────────────────────────────────────────────────────
  tienda = await venue('tienda')
  const mesa = (
    await prisma.table.create({ data: { venueId: tienda, number: '7', capacity: 4, qrCode: `qr-${suffix}` }, select: { id: true } })
  ).id

  // Mostrador (terminal): $100 + $10 de propina en efectivo; y una cuenta de $50 del POS de ANDROID.
  await cuenta({ venueId: tienda, source: 'TPV', subtotal: 100, pagos: [{ amount: 100, tip: 10 }] })
  await cuenta({ venueId: tienda, source: 'AVOQADO_ANDROID', type: 'TAKEOUT', subtotal: 50, pagos: [{ amount: 50 }] })
  // Mostrador con cortesía oculta (la del POS: renglón en $0 con su precio en `discountAmount`): $35 a los dos lados.
  const conCortesia = await cuenta({ venueId: tienda, source: 'TPV', subtotal: 60, pagos: [{ amount: 60 }] })
  await prisma.orderItem.create({
    data: {
      orderId: conCortesia,
      productName: 'Agua',
      quantity: 1,
      unitPrice: 35,
      taxAmount: 0,
      total: 0,
      discountAmount: 35,
      isCortesia: true,
    },
  })
  // Mesas: $200 − $20 de descuento + $15 de cargo por servicio, $20 de propina con tarjeta y $5.1234 de comisión (4 decimales).
  await cuenta({
    venueId: tienda,
    source: 'TPV',
    tableId: mesa,
    subtotal: 200,
    discount: 20,
    serviceCharge: 15,
    pagos: [{ amount: 195, tip: 20, method: 'CREDIT_CARD', fee: 5.1234 }],
  })
  // Mesas desde el POS, sin red: llegó mañana pero el aparato la hizo hoy. $90 con $2.0049 de comisión.
  await cuenta({
    venueId: tienda,
    source: 'AVOQADO_ANDROID',
    tableId: mesa,
    subtotal: 90,
    at: LLEGO_MANANA,
    clientAt: INSIDE,
    pagos: [{ amount: 90, method: 'CREDIT_CARD', fee: 2.0049, at: LLEGO_MANANA, clientAt: INSIDE }],
  })
  // QR del cliente: $80, comisión $0.0051.
  await cuenta({ venueId: tienda, source: 'QR', subtotal: 80, pagos: [{ amount: 80, method: 'CREDIT_CARD', fee: 0.0051 }] })
  // Tienda en línea, para recoger, con IVA aparte ($100 + $16) y la comisión en el cobro de Stripe ($4.50); con su pedido en línea.
  const pedidoEnLinea = await cuenta({
    venueId: tienda,
    source: 'WEB',
    type: 'PICKUP',
    subtotal: 100,
    tax: 16,
    contrato: 'IVA_APARTE',
    pagos: [{ amount: 116, method: 'CREDIT_CARD', onlineFee: 4.5, fundsFlow: 'AVOQADO_PROCESSED' }],
  })
  await prisma.onlineOrder.create({
    data: {
      venueId: tienda,
      orderId: pedidoEnLinea,
      paymentMode: 'CARD_ONLINE',
      requiresAcceptance: false,
      status: 'COMPLETED',
      trackingToken: `tk-${suffix}`.padEnd(32, 't'),
      acceptDeadlineAt: INSIDE,
    },
  })
  // El checkout web de un monto (también `WEB`, sin pedido en línea): «Pagos en línea», y su tipo es «Cobro de un monto».
  await cuenta({
    venueId: tienda,
    source: 'WEB',
    type: 'TAKEOUT',
    subtotal: 40,
    pagos: [{ amount: 40, method: 'CREDIT_CARD', type: 'FAST', onlineFee: 1.4, fundsFlow: 'AVOQADO_PROCESSED' }],
  })
  // TPV · PAGO RÁPIDO: $75 tecleados (la terminal guarda TAKEOUT): mostrador, y no es «para llevar».
  await cuenta({ venueId: tienda, source: 'TPV', type: 'TAKEOUT', subtotal: 75, pagos: [{ amount: 75, type: 'FAST' }] })
  // Codex r2 #4 · un cobro cripto (FAST) sobre una cuenta de mesa CON productos: sigue siendo de la mesa y «en el local».
  const mesaCripto = await cuenta({
    venueId: tienda,
    source: 'TPV',
    tableId: mesa,
    subtotal: 50,
    pagos: [{ amount: 50, method: 'OTHER', type: 'FAST' }],
  })
  await prisma.orderItem.create({ data: { orderId: mesaCripto, productName: 'Café', quantity: 1, unitPrice: 50, taxAmount: 0, total: 50 } })
  // Codex r2 #3 · pedido de la tienda híbrida que llegó por el QR del negocio (WEB + pedido en línea por QR): va con el QR.
  const pedidoPorQr = await cuenta({
    venueId: tienda,
    source: 'WEB',
    type: 'PICKUP',
    subtotal: 60,
    pagos: [{ amount: 60, method: 'CREDIT_CARD', onlineFee: 2.1, fundsFlow: 'AVOQADO_PROCESSED' }],
  })
  await prisma.onlineOrder.create({
    data: {
      venueId: tienda,
      orderId: pedidoPorQr,
      paymentMode: 'PAY_AT_PICKUP',
      requiresAcceptance: false,
      status: 'COMPLETED',
      channel: 'QR',
      trackingToken: `qr-${suffix}`.padEnd(32, 'q'),
      acceptDeadlineAt: INSIDE,
    },
  })
  // Liga de pago sin productos: $300, comisión $9.
  await cuenta({
    venueId: tienda,
    source: 'PAYMENT_LINK',
    type: 'MANUAL_ENTRY',
    subtotal: 300,
    pagos: [{ amount: 300, method: 'CREDIT_CARD', onlineFee: 9, fundsFlow: 'AVOQADO_PROCESSED' }],
  })
  // Rappi a domicilio: $250 al 25 % ($62.50) y un ajuste que regresa $25 y $6.25 de su comisión.
  await cuenta({
    venueId: tienda,
    source: 'RAPPI',
    type: 'DELIVERY',
    subtotal: 250,
    pagos: [
      { amount: 250, method: 'OTHER', tenderCommission: 62.5, fundsFlow: 'EXTERNAL_RECORDED' },
      { amount: -25, method: 'OTHER', type: 'REFUND', tenderCommission: -6.25, fundsFlow: 'EXTERNAL_RECORDED' },
    ],
  })
  // Registrada en el panel: $120.
  await cuenta({
    venueId: tienda,
    source: 'DASHBOARD_MANUAL',
    type: 'MANUAL_ENTRY',
    subtotal: 120,
    pagos: [{ amount: 120, method: 'OTHER' }],
  })
  // Devolución hoy de una venta de ayer del mostrador: −$30 (resta hoy en «Mostrador», sin venta hoy).
  await cuenta({
    venueId: tienda,
    source: 'TPV',
    subtotal: 30,
    at: AYER,
    pagos: [
      { amount: 30, method: 'CREDIT_CARD', at: AYER },
      { amount: -30, method: 'CREDIT_CARD', type: 'REFUND', at: INSIDE },
    ],
  })
  // Abono de una cuenta de mesa todavía abierta: no cuenta en nada (ni propina, ni comisión, ni transacción).
  await cuenta({
    venueId: tienda,
    source: 'TPV',
    tableId: mesa,
    subtotal: 400,
    status: 'CONFIRMED',
    paymentStatus: 'PARTIAL',
    pagos: [{ amount: 40, tip: 4, method: 'CREDIT_CARD', fee: 1.25 }],
  })
  // Abono devuelto de otra cuenta abierta (vuelve a deberse): no es devolución de venta.
  await cuenta({
    venueId: tienda,
    source: 'TPV',
    subtotal: 100,
    status: 'CONFIRMED',
    paymentStatus: 'PARTIAL',
    pagos: [{ amount: 60 }, { amount: -60, type: 'REFUND', reopenedAmount: 60 }],
  })
  // Cuenta cancelada con su cobro y su devolución: la venta y la devolución no cuentan; el cobro sí es transacción (como la cabecera).
  await cuenta({
    venueId: tienda,
    source: 'KIOSK',
    subtotal: 70,
    status: 'CANCELLED',
    pagos: [{ amount: 70 }, { amount: -70, type: 'REFUND' }],
  })
  // Venta de una tarjeta de regalo en el mostrador: no es venta ni transacción, pero su propina sí está en «Propinas» (cabecera).
  const venta = await cuenta({ venueId: tienda, source: 'TPV', subtotal: 500, pagos: [{ amount: 500, tip: 5 }] })
  const tarjeta = await prisma.giftCard.create({
    data: {
      venueId: tienda,
      organizationId: orgId,
      codeHash: `h-${suffix}`,
      codeEnc: 'fixture',
      codeLast4: '1234',
      pageToken: `t-${suffix}`,
      initialAmount: 500,
      balance: 500,
      termsVersion: 'v1',
      deliveryChannel: 'PRINTED',
    },
    select: { id: true },
  })
  giftCards.push(tarjeta.id)
  await prisma.orderItem.create({
    data: { orderId: venta, productName: 'Tarjeta', quantity: 1, unitPrice: 500, total: 500, taxAmount: 0, giftCardId: tarjeta.id },
  })
  // Fuera del rango: no aparece.
  await cuenta({ venueId: tienda, source: 'RAPPI', type: 'DELIVERY', subtotal: 999, at: AYER, pagos: [{ amount: 999, at: AYER }] })

  // ── D5 · un estudio que vende paquetes en línea y cobra depósitos ──────────────────────────────────────────────────────────
  estudio = await venue('estudio')
  await cuenta({ venueId: estudio, source: 'TPV', subtotal: 300, pagos: [{ amount: 300 }] })
  const pack = await prisma.creditPack.create({ data: { venueId: estudio, name: '10 clases', price: 1200 }, select: { id: true } })
  const clienta = await prisma.customer.create({ data: { venueId: estudio, firstName: 'Karla' }, select: { id: true } })
  const compra = (data: Partial<Prisma.CreditPackPurchaseUncheckedCreateInput>) =>
    prisma.creditPackPurchase.create({
      data: { venueId: estudio, customerId: clienta.id, creditPackId: pack.id, amountPaid: 1200, purchasedAt: INSIDE, ...data },
    })
  // En línea hoy (dos, una marcada «reembolsada» en el panel, que no regresa dinero), en línea ayer, y una en caja hoy.
  await compra({ stripeCheckoutSessionId: `cs_hoy_${suffix}` })
  await compra({ stripeCheckoutSessionId: `cs_hoy2_${suffix}`, amountPaid: 800, status: 'REFUNDED' })
  await compra({ stripeCheckoutSessionId: `cs_ayer_${suffix}`, purchasedAt: AYER })
  await compra({})
  // Codex r2 #5 · un paquete en dólares: aparte, nunca sumado a los pesos.
  const enDolares = await prisma.creditPack.create({
    data: { venueId: estudio, name: 'Pack USD', price: 100, currency: 'USD' },
    select: { id: true },
  })
  await compra({ creditPackId: enDolares.id, amountPaid: 100, stripeCheckoutSessionId: `cs_usd_${suffix}` })
  let r = 0
  const reserva = (data: Partial<Prisma.ReservationUncheckedCreateInput>) => {
    r += 1
    return prisma.reservation.create({
      data: {
        venueId: estudio,
        confirmationCode: `CAN-${r}-${suffix}`,
        startsAt: INSIDE,
        endsAt: new Date(INSIDE.getTime() + 3_600_000),
        blockedEndsAt: new Date(INSIDE.getTime() + 3_600_000),
        duration: 60,
        status: 'CONFIRMED',
        customerId: clienta.id,
        ...data,
      },
    })
  }
  // Cobrados hoy: $200 (pagado), $150 (devuelto hoy), $100 (perdido por no-show). Devuelto hoy uno cobrado ayer ($80).
  // Fuera: uno pendiente, uno expirado y uno cobrado ayer que sigue pagado.
  await reserva({ depositAmount: 200, depositStatus: 'PAID', depositPaidAt: INSIDE })
  await reserva({ depositAmount: 150, depositStatus: 'REFUNDED', depositPaidAt: INSIDE, depositRefundedAt: INSIDE })
  await reserva({ depositAmount: 100, depositStatus: 'FORFEITED', depositPaidAt: INSIDE, status: 'NO_SHOW' })
  await reserva({ depositAmount: 80, depositStatus: 'REFUNDED', depositPaidAt: AYER, depositRefundedAt: INSIDE })
  await reserva({ depositAmount: 500, depositStatus: 'PENDING' })
  await reserva({ depositAmount: 500, depositStatus: 'EXPIRED' })
  await reserva({ depositAmount: 700, depositStatus: 'PAID', depositPaidAt: AYER })
})

afterAll(async () => {
  for (const v of venues) {
    await prisma.reservation.deleteMany({ where: { venueId: v } })
    await prisma.creditPackPurchase.deleteMany({ where: { venueId: v } })
    await prisma.onlineOrder.deleteMany({ where: { venueId: v } })
    await prisma.creditPack.deleteMany({ where: { venueId: v } })
    await prisma.customer.deleteMany({ where: { venueId: v } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId: v } } })
    await prisma.transactionCost.deleteMany({ where: { payment: { venueId: v } } })
    await prisma.payment.deleteMany({ where: { venueId: v } })
    await prisma.order.deleteMany({ where: { venueId: v } })
    await prisma.table.deleteMany({ where: { venueId: v } })
  }
  if (giftCards.length) await prisma.giftCard.deleteMany({ where: { id: { in: giftCards } } })
  for (const v of venues) await prisma.venue.deleteMany({ where: { id: v } })
  if (comercio) await prisma.merchantAccount.deleteMany({ where: { id: comercio } })
  if (aggregatorId) await prisma.aggregator.deleteMany({ where: { id: aggregatorId } })
  if (providerId) await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

type Fila = { key: string } & Record<string, number | string>
const suma = (filas: Fila[], campo: string) => filas.reduce((s, f) => s + Math.round(Number(f[campo]) * 100), 0)
const fila = (filas: Fila[], key: string) => filas.find(f => f.key === key)

describe('D4 · ventas por canal y por tipo de pedido', () => {
  it('🔴 cada tabla suma la cabecera al centavo, campo por campo', async () => {
    const r = await resumen(tienda, { includeChannelBreakdown: true })
    expect(r.byChannel).toBeDefined()
    expect(r.byOrderType).toBeDefined()
    // Leídas sin ventas de por medio: las tablas y la cabecera cuadran y la respuesta no trae el aviso.
    expect(r.channelBreakdownOutOfSync).toBeUndefined()
    const s = r.summary
    for (const filas of [r.byChannel!, r.byOrderType!] as unknown as Fila[][]) {
      expect(suma(filas, 'grossSales')).toBe(cents(s.grossSales))
      expect(suma(filas, 'discounts')).toBe(cents(s.discounts))
      expect(suma(filas, 'refunds')).toBe(cents(s.refunds))
      expect(suma(filas, 'netSales')).toBe(cents(s.netSales))
      expect(suma(filas, 'tips')).toBe(cents(s.tips))
      expect(suma(filas, 'platformFees')).toBe(cents(s.platformFees))
      expect(suma(filas, 'tenderCommissions')).toBe(cents(s.tenderCommissions))
      expect(suma(filas, 'totalCollected')).toBe(cents(s.totalCollected))
      expect(filas.reduce((n, f) => n + Number(f.transactionCount), 0)).toBe(s.transactionCount)
      expect(filas.reduce((n, f) => n + Number(f.refundCount), 0)).toBe(s.refundCount)
    }
    // La cabecera que se reparte (que no sea una suma de ceros): (100+50+60+35+75) + (200+15+90) + 80 + 116 + 40 + 300 + 250 + 120.
    // + 50 de la mesa pagada con cripto + 60 del pedido por QR.
    expect(cents(s.grossSales)).toBe(164100)
    expect(cents(s.netSales)).toBe(153100)
    expect(s.transactionCount).toBe(15)
    // 5.1234 + 2.0049 + 0.0051 + 4.5 + 1.4 + 2.1 + 9 = 24.1334 (el abono de la mesa abierta, $1.25, no entra).
    expect(cents(s.platformFees)).toBe(2413)
  })

  it('cada canal tiene lo suyo: mostrador, mesas (también la venta sin red), QR, tienda, checkout, liga, Rappi y el panel', async () => {
    const r = await resumen(tienda, { includeChannelBreakdown: true })
    const c = r.byChannel! as unknown as Fila[]
    // Mostrador: 100 + 50 + (60 + 35 de cortesía a los dos lados) + 75 del pago rápido − la devolución de $30 de ayer; propina $10
    // (+ $5 de la venta de la tarjeta de regalo: no es venta ni transacción, pero su propina sí está en la cabecera).
    expect(fila(c, 'COUNTER')).toMatchObject({
      grossSales: 320,
      discounts: 35,
      refunds: 30,
      netSales: 255,
      tips: 15,
      transactionCount: 4,
      orderCount: 4,
    })
    // Mesas: (200 − 20 + 15) + 90 de la venta sin red; el abono de la mesa abierta no entra.
    // + la mesa de $50 pagada con cripto.
    expect(fila(c, 'TABLES')).toMatchObject({ grossSales: 355, discounts: 20, netSales: 335, tips: 20, transactionCount: 3, orderCount: 3 })
    // El QR del cliente ($80) y el pedido de la tienda que llegó por el QR del negocio ($60).
    expect(fila(c, 'QR')).toMatchObject({ netSales: 140, transactionCount: 2, orderCount: 2 })
    expect(fila(c, 'ONLINE_STORE')).toMatchObject({ grossSales: 116, netSales: 116, platformFees: 4.5, totalCollected: 111.5 })
    expect(fila(c, 'WEB_CHECKOUT')).toMatchObject({ netSales: 40, platformFees: 1.4, totalCollected: 38.6 })
    expect(fila(c, 'PAYMENT_LINK')).toMatchObject({ netSales: 300, platformFees: 9, totalCollected: 291 })
    expect(fila(c, 'RAPPI')).toMatchObject({
      grossSales: 250,
      refunds: 25,
      netSales: 225,
      tenderCommissions: 56.25,
      totalCollected: 168.75,
      refundCount: 1,
    })
    expect(fila(c, 'DASHBOARD')).toMatchObject({ netSales: 120 })
    // La cuenta cancelada del kiosco: sin venta ni devolución, pero su cobro es transacción, como en la cabecera.
    expect(fila(c, 'KIOSK')).toMatchObject({ netSales: 0, refunds: 0, transactionCount: 1, orderCount: 0 })
  })

  it('por tipo de pedido: en el local, para llevar, para recoger, a domicilio, registro directo y cobro de un monto', async () => {
    const r = await resumen(tienda, { includeChannelBreakdown: true })
    const t = r.byOrderType! as unknown as Fila[]
    // Sólo el pedido para llevar de verdad: el pago rápido y el checkout (TAKEOUT con un cobro FAST) van a «Cobro de un monto».
    expect(fila(t, 'TAKEOUT')).toMatchObject({ netSales: 50 })
    expect(fila(t, 'QUICK_PAYMENT')).toMatchObject({ netSales: 115, transactionCount: 2 })
    expect(fila(t, 'PICKUP')).toMatchObject({ netSales: 176 })
    expect(fila(t, 'DELIVERY')).toMatchObject({ netSales: 225 })
    expect(fila(t, 'MANUAL_ENTRY')).toMatchObject({ netSales: 420 })
    // 100 + (95 − 35) + (215 − 20) + 90 + 80 + 50 de la mesa pagada con cripto − 30 de la devolución de ayer.
    expect(fila(t, 'DINE_IN')).toMatchObject({ netSales: 545 })
  })

  it('sin la opción, o con un filtro de método o de comercio, la respuesta no trae las tablas', async () => {
    expect((await resumen(tienda)).byChannel).toBeUndefined()
    expect((await resumen(tienda, { includeChannelBreakdown: true, paymentMethod: 'CASH' })).byChannel).toBeUndefined()
    expect((await resumen(tienda, { includeChannelBreakdown: true, merchantAccountId: comercio })).byOrderType).toBeUndefined()
  })
})

describe('D5 · paquetes en línea y depósitos de reservas', () => {
  it('salen en sus renglones por la fecha en que se cobraron, y NO en ventas ni en «Neto cobrado»', async () => {
    const sin = await resumen(estudio)
    const con = await resumen(estudio, { includePrepaid: true })
    // Paquetes en línea de hoy: $1,200 + $800 (el «reembolsado» del panel no regresó dinero). El de ayer y el de caja, fuera.
    expect(con.summary.packagesSoldOnline).toBe(2000)
    expect(con.summary.packagesSoldOnlineCount).toBe(2)
    expect(con.summary.packagesSoldOnlineOtherCurrencies).toEqual([{ currency: 'USD', amount: 100, count: 1 }])
    expect(con.summary.reservationDepositsRefunded).toBe(230)
    // Depósitos cobrados hoy: 200 + 150 + 100 = 450, menos lo devuelto hoy: 150 + 80 ⇒ 220; tres cobrados.
    expect(con.summary.reservationDeposits).toBe(220)
    expect(con.summary.reservationDepositsCount).toBe(3)
    // Ventas y «Neto cobrado» son los mismos con y sin los renglones: sólo la cuenta de $300.
    for (const campo of ['grossSales', 'netSales', 'totalCollected', 'tips', 'transactionCount'] as const) {
      expect(con.summary[campo]).toBe(sin.summary[campo])
    }
    expect(cents(con.summary.netSales)).toBe(30000)
    // Sin la opción no se pregunta nada (el POS, el correo y el bot no cambian).
    expect(sin.summary.packagesSoldOnline).toBeUndefined()
    expect(sin.summary.reservationDeposits).toBeUndefined()
  })

  it('con un filtro de método la vista es de movimientos y los renglones no salen', async () => {
    const r = await resumen(estudio, { includePrepaid: true, paymentMethod: 'CARD' })
    expect(r.summary.packagesSoldOnline).toBeUndefined()
    expect(r.summary.reservationDeposits).toBeUndefined()
  })
})
