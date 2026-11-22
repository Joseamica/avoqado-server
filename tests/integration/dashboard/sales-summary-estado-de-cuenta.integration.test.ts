/**
 * Integración: el «Estado del periodo» del Resumen de ventas contra Postgres real (carril C, 21-nov-2026).
 *
 * Las cuatro fichas del carril, al centavo:
 *   - D10.2: una devolución del día no se cuenta como cobro y se separa de lo cobrado (cajones y comercios); la devolución de
 *     una cuenta CANCELADA sale aparte para que la pantalla diga por qué «Cobraste» no cuadra con las ventas.
 *   - D11: los cobros en línea (Stripe/Mercado Pago, sin comercio de terminal) salen en su propio destino con su comisión.
 *   - Cada cobro cae en UN destino (`statementDestinations`, decidido por `tenderSemantics`) leído en la misma consulta que los
 *     cajones: Σ destinos − comisión de terceros = Σ cajones − comisiones − comisión de terceros, al centavo.
 *   - D9.2: con un comercio elegido, comercios, proyección y en línea hablan sólo de ese comercio.
 *   - D1: la comisión congelada de Rappi/Uber o de un tipo de pago propio (`tenderCommissionAmount`) va por cajón, con signo.
 *
 * Cada caso vive en su propio negocio para que sus cuentas no se mezclen.
 */

import prisma from '@/utils/prismaClient'
import {
  flattenSalesSummaryForExport,
  getSalesSummary,
  type PaymentMethodDetailedBreakdown,
} from '@/services/dashboard/sales-summary.dashboard.service'

const TZ = 'America/Mexico_City'
// Martes 8 de abril de 2025 en la Ciudad de México.
const FROM = new Date('2025-04-08T06:00:00.000Z')
const TO = new Date('2025-04-09T05:59:59.999Z')
const INSIDE = new Date('2025-04-08T18:00:00.000Z')
const YESTERDAY = new Date('2025-04-07T18:00:00.000Z')
const AFTER = new Date('2025-04-09T06:10:00.000Z') // llegó 10 min después del día

const suffix = `edc-${Date.now()}`
let orgId: string
let providerId: string
let aggregatorId: string
const venues: Record<'online' | 'refund' | 'merchant' | 'tender' | 'dest' | 'pct', string> = {
  online: '',
  refund: '',
  merchant: '',
  tender: '',
  dest: '',
  pct: '',
}
const merchants: string[] = []
let ecommerceId: string
let seq = 0

type Seed = {
  venue: string
  method: 'CASH' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'BANK_TRANSFER' | 'OTHER'
  amount: number
  tip?: number
  type?: 'REGULAR' | 'REFUND'
  merchant?: string
  fee?: number // TransactionCost.venueChargeAmount (negativo en la devolución)
  feeAmount?: number // Payment.feeAmount (cobros en línea)
  fundsFlow?: 'AVOQADO_PROCESSED' | 'CASH_DRAWER' | 'EXTERNAL_RECORDED'
  ecommerce?: boolean
  tenderCommission?: number
  countsAsCash?: boolean
  processorData?: Record<string, unknown>
  at?: Date
  clientAt?: Date
  orderId?: string
  orderStatus?: 'COMPLETED' | 'CANCELLED'
}

async function newOrder(venueId: string, at: Date, total: number, status: 'COMPLETED' | 'CANCELLED' = 'COMPLETED') {
  seq += 1
  return (
    await prisma.order.create({
      data: {
        venueId,
        orderNumber: `EDC-${seq}-${suffix}`,
        createdAt: at,
        subtotal: total,
        taxAmount: 0,
        discountAmount: 0,
        total,
        status,
        paymentStatus: 'PAID',
      },
      select: { id: true },
    })
  ).id
}

async function seed(s: Seed): Promise<{ orderId: string; paymentId: string }> {
  const at = s.at ?? INSIDE
  const orderId = s.orderId ?? (await newOrder(s.venue, at, Math.abs(s.amount), s.orderStatus))
  const payment = await prisma.payment.create({
    data: {
      venueId: s.venue,
      orderId,
      amount: s.amount,
      tipAmount: s.tip ?? 0,
      method: s.method,
      status: 'COMPLETED',
      type: s.type ?? 'REGULAR',
      feePercentage: 0,
      feeAmount: s.feeAmount ?? 0,
      netAmount: s.amount,
      merchantAccountId: s.merchant,
      ecommerceMerchantId: s.ecommerce ? ecommerceId : undefined,
      fundsFlow: s.fundsFlow,
      tenderCommissionAmount: s.tenderCommission,
      tenderCountsAsCash: s.countsAsCash,
      processorData: s.processorData as never,
      createdAt: at,
      clientCreatedAt: s.clientAt,
    },
    select: { id: true },
  })
  if (s.fee !== undefined) {
    await prisma.transactionCost.create({
      data: {
        paymentId: payment.id,
        merchantAccountId: s.merchant!,
        transactionType: 'CREDIT',
        amount: s.amount,
        providerRate: 0,
        providerCostAmount: 0,
        venueRate: 0,
        venueChargeAmount: s.fee,
        venueFixedFee: 0,
        grossProfit: 0,
        profitMargin: 0,
        createdAt: at,
      },
    })
  }
  return { orderId, paymentId: payment.id }
}

async function newMerchant(tag: string) {
  const id = (
    await prisma.merchantAccount.create({
      data: { providerId, externalMerchantId: `${tag}-${suffix}`, credentialsEncrypted: {}, aggregatorId, displayName: `Comercio ${tag}` },
      select: { id: true },
    })
  ).id
  merchants.push(id)
  // Tarjeta de crédito: un día hábil, corte 23:00.
  await prisma.settlementConfiguration.create({
    data: {
      merchantAccountId: id,
      cardType: 'CREDIT',
      settlementDays: 1,
      settlementDayType: 'BUSINESS_DAYS',
      cutoffTime: '23:00',
      cutoffTimezone: TZ,
      effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
    },
  })
  return id
}

const base = (extra: Record<string, unknown> = {}) => ({
  startDate: FROM.toISOString(),
  endDate: TO.toISOString(),
  timezone: TZ,
  groupBy: 'paymentMethod' as const,
  includeMerchantBreakdown: true,
  includeSettlementProjection: true,
  ...extra,
})

const bucket = (rows: PaymentMethodDetailedBreakdown[] | undefined, key: string) => rows?.find(b => b.bucket === key)
const c = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 100) / 100)

/**
 * Cada cobro cae en UN destino, leído con los cajones: lo cobrado y la comisión de terceros se reparten EXACTOS entre destinos; la
 * comisión de Avoqado de los destinos va redondeada por cobro (como la liquidación), así que difiere de la suma cruda de los
 * cajones sólo por esos redondeos (menos de medio centavo por cobro).
 */
function expectIdentity(r: Awaited<ReturnType<typeof getSalesSummary>>) {
  const d = r.statementDestinations!
  const lista = [d.terminal, d.drawer, d.online, d.other]
  const cajones = r.byPaymentMethodDetailed ?? []
  expect(c(lista.reduce((s, x) => s + x.collected, 0))).toBe(c(cajones.reduce((s, b) => s + b.amount, 0)))
  expect(c(d.tenderCommissions)).toBe(c(cajones.reduce((s, b) => s + (b.tenderCommissions ?? 0), 0)))
  const filas = cajones.reduce((s, b) => s + b.count, 0)
  expect(Math.abs(lista.reduce((s, x) => s + x.platformFee, 0) - cajones.reduce((s, b) => s + b.platformFees, 0))).toBeLessThanOrEqual(
    0.005 * filas + 1e-9,
  )
  for (const x of lista) expect(c(x.netToReceive)).toBe(c(x.collected - x.platformFee))
}

let merchantA: string
let merchantB: string
let merchantR: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `EDC Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  for (const k of Object.keys(venues) as Array<keyof typeof venues>) {
    venues[k] = (
      await prisma.venue.create({
        data: { organizationId: orgId, name: `edc-${k}-${suffix}`, slug: `edc-${k}-${suffix}`, timezone: TZ },
        select: { id: true },
      })
    ).id
  }
  providerId = (
    await prisma.paymentProvider.create({
      data: { code: `EDC-${suffix}`, name: `P ${suffix}`, type: 'PAYMENT_PROCESSOR' },
      select: { id: true },
    })
  ).id
  aggregatorId = (await prisma.aggregator.create({ data: { name: `Agg ${suffix}`, baseFees: {} }, select: { id: true } })).id
  ecommerceId = (
    await prisma.ecommerceMerchant.create({
      data: {
        venueId: venues.online,
        businessName: 'EDC en línea',
        contactEmail: `edc-${suffix}@test.com`,
        publicKey: `pk_test_edc_${suffix}`,
        secretKeyHash: `edc-hash-${suffix}`,
        providerId,
        providerCredentials: {},
      },
      select: { id: true },
    })
  ).id
  merchantA = await newMerchant('A')
  merchantB = await newMerchant('B')
  merchantR = await newMerchant('R')

  // D11 · terminal $100 (comisión $3) + pedido en línea $200 (comisión $6 en feeAmount) + una tarjeta de otra terminal
  // registrada a mano ($40, EXTERNAL_RECORDED): ésa NO es «en línea».
  await seed({ venue: venues.online, method: 'CREDIT_CARD', amount: 100, merchant: merchantA, fee: 3 })
  await seed({ venue: venues.online, method: 'CREDIT_CARD', amount: 200, ecommerce: true, fundsFlow: 'AVOQADO_PROCESSED', feeAmount: 6 })
  await seed({ venue: venues.online, method: 'CREDIT_CARD', amount: 40, fundsFlow: 'EXTERNAL_RECORDED' })
  // Una devolución parcial del pedido en línea: −$50 con −$1.50 de comisión devuelta (copia fundsFlow, como `refund.dashboard`).
  await seed({
    venue: venues.online,
    method: 'CREDIT_CARD',
    amount: -50,
    type: 'REFUND',
    ecommerce: true,
    fundsFlow: 'AVOQADO_PROCESSED',
    feeAmount: -1.5,
  })

  // D10 · efectivo $100 hoy y $30 devueltos a la tarjeta (comercio R) de una venta de AYER, con $0.90 de comisión revertida.
  const ayer = await seed({ venue: venues.refund, method: 'CREDIT_CARD', amount: 100, merchant: merchantR, fee: 3, at: YESTERDAY })
  await seed({ venue: venues.refund, method: 'CASH', amount: 100 })
  await seed({
    venue: venues.refund,
    method: 'CREDIT_CARD',
    amount: -30,
    type: 'REFUND',
    merchant: merchantR,
    fee: -0.9,
    orderId: ayer.orderId,
  })
  // D10 · cuenta cobrada a mano ayer, CANCELADA y devuelta entera hoy (−$250 por transferencia).
  const cancelada = await newOrder(venues.refund, YESTERDAY, 250, 'CANCELLED')
  await seed({ venue: venues.refund, method: 'BANK_TRANSFER', amount: 250, orderId: cancelada, at: YESTERDAY })
  await seed({ venue: venues.refund, method: 'BANK_TRANSFER', amount: -250, type: 'REFUND', orderId: cancelada })

  // D9.2 · comercio A deja $97 (+ $50 hechos hoy que LLEGARON mañana: su hora real es de hoy) y B deja $197; más un cobro en línea.
  await seed({ venue: venues.merchant, method: 'CREDIT_CARD', amount: 100, merchant: merchantA, fee: 3 })
  await seed({ venue: venues.merchant, method: 'CREDIT_CARD', amount: 50, merchant: merchantA, fee: 1.5, at: AFTER, clientAt: INSIDE })
  await seed({ venue: venues.merchant, method: 'CREDIT_CARD', amount: 200, merchant: merchantB, fee: 3 })
  await seed({ venue: venues.merchant, method: 'CREDIT_CARD', amount: 80, ecommerce: true, fundsFlow: 'AVOQADO_PROCESSED', feeAmount: 2 })

  // D1 · Uber $100 con su 30 % congelado ($30), su compensación del proveedor (−$10 con −$3 de comisión) y efectivo $50.
  await seed({ venue: venues.tender, method: 'OTHER', amount: 100, fundsFlow: 'EXTERNAL_RECORDED', tenderCommission: 30 })
  await seed({ venue: venues.tender, method: 'OTHER', amount: -10, type: 'REFUND', fundsFlow: 'EXTERNAL_RECORDED', tenderCommission: -3 })
  await seed({ venue: venues.tender, method: 'CASH', amount: 50 })

  // Un solo destino por cobro, por la autoridad (`tenderSemantics`):
  // OXXO viejo de una liga (guardado como CASH pero AVOQADO_PROCESSED) → en línea, NO efectivo (Codex r1 #1).
  await seed({ venue: venues.dest, method: 'CASH', amount: 120, ecommerce: true, fundsFlow: 'AVOQADO_PROCESSED', feeAmount: 4 })
  // Vale que cuenta como efectivo (CASH_DRAWER) y uno viejo con la marca congelada → cajón.
  await seed({ venue: venues.dest, method: 'OTHER', amount: 80, fundsFlow: 'CASH_DRAWER' })
  await seed({ venue: venues.dest, method: 'OTHER', amount: 20, countsAsCash: true })
  // Pedido de Rappi cobrado en efectivo con su comisión congelada: el efectivo queda ENTERO en el cajón (Codex r1 #5).
  await seed({ venue: venues.dest, method: 'CASH', amount: 100, fundsFlow: 'CASH_DRAWER', tenderCommission: 30 })
  // TPV sin afiliación, SoftRestaurant o prueba (tarjeta sin comercio ni sello en línea) → otros, NO banco (Codex r2 #2).
  await seed({ venue: venues.dest, method: 'DEBIT_CARD', amount: 60 })
  // Efectivo que la TPV guardó con comercio (resuelto por serial) → cajón, no «Por comercio» (Codex r2 #3).
  await seed({ venue: venues.dest, method: 'CASH', amount: 25, merchant: merchantB })
  // Liga vieja de Blumon E-commerce (sólo `ecommerceMerchantId`) y su devolución SIN sellos que apunta al cobro: las dos en línea.
  const liga = await seed({ venue: venues.dest, method: 'CREDIT_CARD', amount: 100, ecommerce: true })
  await seed({
    venue: venues.dest,
    method: 'CREDIT_CARD',
    amount: -30,
    type: 'REFUND',
    orderId: liga.orderId,
    processorData: { originalPaymentId: liga.paymentId },
  })
  // Devolución por transferencia de una venta con afiliación: sólo se registra → otros, nunca «Se descuenta de tu banco» (Codex r3 #5).
  await seed({
    venue: venues.dest,
    method: 'BANK_TRANSFER',
    amount: -30,
    type: 'REFUND',
    merchant: merchantB,
    fundsFlow: 'EXTERNAL_RECORDED',
  })
  // Dos cobros de $21 en el MISMO comercio con $0.5355 de comisión cada uno: la liquidación redondea por cobro ($0.54 + $0.54).
  await seed({ venue: venues.dest, method: 'CREDIT_CARD', amount: 21, merchant: merchantA, fee: 0.5355 })
  await seed({ venue: venues.dest, method: 'CREDIT_CARD', amount: 21, merchant: merchantA, fee: 0.5355 })
  // Porcentajes exactos aunque la lectura agrupe por comercio (Codex r4 #3): crédito 100 (A) + 100.33 (B), débito 59.67.
  await seed({ venue: venues.pct, method: 'CREDIT_CARD', amount: 100, merchant: merchantA })
  await seed({ venue: venues.pct, method: 'CREDIT_CARD', amount: 100.33, merchant: merchantB })
  await seed({ venue: venues.pct, method: 'DEBIT_CARD', amount: 59.67, merchant: merchantA })
  // SPEI en línea bien sellado ($200, comisión $2): con el filtro «Otros» el exporte sí debe traerlo (Codex r2 #6).
  await seed({ venue: venues.dest, method: 'BANK_TRANSFER', amount: 200, ecommerce: true, fundsFlow: 'AVOQADO_PROCESSED', feeAmount: 2 })
  // Transferencia vieja sin `fundsFlow`: la autoridad la daría por «depositable» (falsedad conocida) → se queda en otros.
  await seed({ venue: venues.dest, method: 'BANK_TRANSFER', amount: 70 })
  // Cobro de terminal cuyo costo todavía no llega → su neto sale como «sin fecha estimada».
  await seed({ venue: venues.dest, method: 'CREDIT_CARD', amount: 90, merchant: merchantB })
})

afterAll(async () => {
  if (!orgId) return
  const ids = Object.values(venues).filter(Boolean)
  await prisma.transactionCost.deleteMany({ where: { payment: { venueId: { in: ids } } } })
  await prisma.payment.deleteMany({ where: { venueId: { in: ids } } })
  await prisma.order.deleteMany({ where: { venueId: { in: ids } } })
  await prisma.settlementConfiguration.deleteMany({ where: { merchantAccountId: { in: merchants } } })
  await prisma.merchantAccount.deleteMany({ where: { id: { in: merchants } } })
  if (ecommerceId) await prisma.ecommerceMerchant.deleteMany({ where: { id: ecommerceId } })
  if (aggregatorId) await prisma.aggregator.deleteMany({ where: { id: aggregatorId } })
  if (providerId) await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
  await prisma.venue.deleteMany({ where: { id: { in: ids } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('D11 · los cobros en línea salen en el estado de cuenta', () => {
  it('el cajón de tarjeta cuenta lo cobrado sin devoluciones y el destino «en línea» trae el pedido con su comisión', async () => {
    const r = await getSalesSummary(venues.online, base())
    const card = bucket(r.byPaymentMethodDetailed, 'CARD')!
    // Lo de siempre no cambia: importe con signo (100 + 200 + 40 − 50) y conteo con la devolución.
    expect(c(card.amount)).toBe(290)
    expect(card.count).toBe(4)
    // Lo nuevo: cobros sin devoluciones.
    expect(c(card.chargedAmount)).toBe(340)
    expect(card.chargedCount).toBe(3)

    const d = r.statementDestinations!
    expect(d.online).toEqual({ collected: 150, refunds: 50, refundCount: 1, platformFee: 4.5, netToReceive: 145.5, transactionCount: 2 })
    expect(d.terminal).toEqual(expect.objectContaining({ collected: 100, platformFee: 3, netToReceive: 97, transactionCount: 1 }))
    // La tarjeta de otra terminal registrada a mano no la deposita Avoqado: «otros», no banco.
    expect(d.other).toEqual(expect.objectContaining({ collected: 40, netToReceive: 40, transactionCount: 1 }))
    expect(d.drawer.transactionCount).toBe(0)
    expectIdentity(r)
    // La tarjeta de otra terminal (EXTERNAL_RECORDED) no es «en línea» ni de un comercio de Avoqado.
    expect(r.byMerchantAccount?.map(m => m.merchantAccountId)).toEqual([merchantA])
    expect(c(r.byMerchantAccount?.[0].netToReceive)).toBe(97)
  })

  it('el exporte «Desglose por comercio» trae la fila «Cobros en línea» y cuenta cobros, no devoluciones', async () => {
    const r = await getSalesSummary(venues.online, base())
    const { rows } = flattenSalesSummaryForExport(r, ['merchantAccounts'])
    expect(rows).toEqual([
      expect.objectContaining({ section: 'merchantAccounts', label: 'Comercio A', count: 1, amount: 97 }),
      expect.objectContaining({ section: 'merchantAccounts', label: 'Cobros en línea', count: 1, amount: 145.5 }),
    ])
  })
})

describe('D10.2 · una devolución del día no descompone el estado de cuenta', () => {
  it('cada cajón separa lo cobrado de lo devuelto, y la devolución no cuenta como cobro', async () => {
    const r = await getSalesSummary(venues.refund, base())
    const cash = bucket(r.byPaymentMethodDetailed, 'CASH')!
    const card = bucket(r.byPaymentMethodDetailed, 'CARD')!
    const other = bucket(r.byPaymentMethodDetailed, 'OTHER')!
    expect([c(cash.chargedAmount), cash.chargedCount, c(cash.amount)]).toEqual([100, 1, 100])
    // Tarjeta: sólo la devolución de la venta de ayer: nada cobrado hoy, −$30 de movimiento y la comisión revertida.
    expect([c(card.chargedAmount), card.chargedCount, c(card.amount), card.count]).toEqual([0, 0, -30, 1])
    expect(c(card.platformFees)).toBe(-0.9)
    expect(card.cancelledOrderRefunds ?? 0).toBe(0)
    // La devolución de la cuenta cancelada: sí salió dinero, y se marca para explicar por qué no se resta de las ventas.
    expect([c(other.chargedAmount), other.chargedCount, c(other.amount)]).toEqual([0, 0, -250])
    expect(c(other.cancelledOrderRefunds)).toBe(250)
  })

  it('el comercio de la devolución separa lo devuelto y su neto es lo que se descuenta del depósito', async () => {
    const r = await getSalesSummary(venues.refund, base())
    expect(r.byMerchantAccount).toEqual([
      expect.objectContaining({
        merchantAccountId: merchantR,
        collectedOnCard: -30,
        refunds: 30,
        refundCount: 1,
        platformFee: -0.9,
        netToReceive: -29.1,
        transactionCount: 1,
      }),
    ])
    const { rows } = flattenSalesSummaryForExport(r, ['merchantAccounts'])
    // Cero cobros hoy en ese comercio: la devolución no es una transacción del exporte.
    expect(rows).toEqual([expect.objectContaining({ label: 'Comercio R', count: 0, amount: -29.1 })])
  })
})

describe('D10.2 · destinos con devoluciones', () => {
  it('cada destino es neto de sus devoluciones y la devolución de la cuenta cancelada sale de «otros»', async () => {
    const r = await getSalesSummary(venues.refund, base())
    const d = r.statementDestinations!
    expect(c(d.drawer.netToReceive)).toBe(100)
    expect(d.terminal).toEqual(expect.objectContaining({ collected: -30, refunds: 30, refundCount: 1, transactionCount: 1 }))
    expect(c(d.terminal.netToReceive)).toBe(-29.1)
    expect(d.other).toEqual(expect.objectContaining({ collected: -250, refunds: 250, refundCount: 1 }))
    expectIdentity(r)
  })
})

describe('D9.2 · con un comercio elegido, todo el estado de cuenta es de ese comercio', () => {
  it('sin filtro: los dos comercios (con el cobro que llegó tarde en su día real) y el cobro en línea', async () => {
    const r = await getSalesSummary(venues.merchant, base())
    const porComercio = Object.fromEntries((r.byMerchantAccount ?? []).map(m => [m.merchantAccountId, c(m.netToReceive)]))
    // A: (100 − 3) + (50 − 1.5): el de $50 se hizo hoy aunque llegó mañana; los cajones ya lo cuentan hoy (hora real).
    expect(porComercio).toEqual({ [merchantA]: 145.5, [merchantB]: 197 })
    expect(c(bucket(r.byPaymentMethodDetailed, 'CARD')!.chargedAmount)).toBe(430)
    expect(r.statementDestinations?.online.netToReceive).toBe(78)
    expectIdentity(r)
  })

  it('con el comercio A: comercios, proyección y cajones sólo de A, y nada en línea', async () => {
    const r = await getSalesSummary(venues.merchant, base({ merchantAccountId: merchantA }))
    expect(r.byMerchantAccount?.map(m => m.merchantAccountId)).toEqual([merchantA])
    expect(c(r.byMerchantAccount?.[0].netToReceive)).toBe(145.5)
    const proyectados = (r.settlementCalendar ?? []).flatMap(d => d.byMerchant.map(m => m.merchantAccountId))
    expect(new Set(proyectados)).toEqual(new Set([merchantA]))
    const totalProyectado = (r.settlementCalendar ?? []).reduce((s, d) => s + d.totalNet, 0)
    expect(c(totalProyectado)).toBe(145.5)
    expect(c(bucket(r.byPaymentMethodDetailed, 'CARD')!.chargedAmount)).toBe(150)
    expect(r.statementDestinations?.online.transactionCount).toBe(0)
    expectIdentity(r)

    const { rows } = flattenSalesSummaryForExport(r, ['merchantAccounts'])
    expect(rows.map(x => x.label)).toEqual(['Comercio A'])
  })
})

describe('D1 · la comisión de Rappi/Uber o de un tipo de pago propio, por cajón', () => {
  it('suma la comisión congelada con signo (la compensación del proveedor la devuelve)', async () => {
    const r = await getSalesSummary(venues.tender, base())
    const other = bucket(r.byPaymentMethodDetailed, 'OTHER')!
    expect([c(other.chargedAmount), c(other.amount), c(other.tenderCommissions)]).toEqual([100, 90, 27])
    expect(c(bucket(r.byPaymentMethodDetailed, 'CASH')!.tenderCommissions)).toBe(0)
    expect(c(r.statementDestinations?.tenderCommissions)).toBe(27)
    expect(c(r.statementDestinations?.other.netToReceive)).toBe(90) // Uber deposita aparte: la comisión es renglón propio
    expectIdentity(r)
  })
})

describe('un solo destino por cobro (tenderSemantics), leído con los cajones', () => {
  it('cada cobro cae en UN destino y la suma cuadra con los cajones', async () => {
    const r = await getSalesSummary(venues.dest, base())
    const d = r.statementDestinations!
    // En línea: OXXO viejo (120 − 4) + liga Blumon (100 − 30 devueltos) + SPEI (200 − 2).
    expect(d.online).toEqual(expect.objectContaining({ collected: 390, refunds: 30, refundCount: 1, platformFee: 6, netToReceive: 384 }))
    expect(c(d.drawer.collected)).toBe(225) // vale 80 + vale viejo 20 + Rappi 100 entero + efectivo con comercio 25
    expect(c(d.other.collected)).toBe(100) // tarjeta sin comercio 60 + transferencia vieja 70 − devolución por transferencia 30
    expect(c(d.terminal.collected)).toBe(132) // B 90 + A 21 + 21
    expect(c(d.tenderCommissions)).toBe(30)
    // El cajón de EFECTIVO por método sí trae el OXXO (método CASH): la barra es por método; el destino, por dinero.
    expect(c(bucket(r.byPaymentMethodDetailed, 'CASH')!.chargedAmount)).toBe(245)
    // «Por comercio» es la misma lectura: sólo la terminal, sin el efectivo que traía comercio.
    const filas = Object.fromEntries((r.byMerchantAccount ?? []).map(m => [m.merchantAccountId, c(m.netToReceive)]))
    expect(filas).toEqual({ [merchantB]: 90, [merchantA]: 40.92 })
    expectIdentity(r)
  })

  it('el cobro de terminal sin costo todavía cuenta como «sin fecha estimada» de su comercio', async () => {
    const r = await getSalesSummary(venues.dest, base())
    const b = r.byMerchantAccount?.find(m => m.merchantAccountId === merchantB)
    expect(b?.unprojectedNet).toBe(90)
    // B no tiene ningún cobro en el calendario (sin costo); A sí (sus dos cobros de $21).
    expect((r.settlementCalendar ?? []).flatMap(x => x.byMerchant).map(m => m.merchantAccountId)).toEqual([merchantA])
    const { rows } = flattenSalesSummaryForExport(r, ['merchantAccounts'])
    expect(rows.map(x => x.label)).toEqual(['Comercio B', 'Comercio A', 'Cobros en línea'])
  })

  it('el exporte con filtro «Efectivo» no lista comercios de tarjeta', async () => {
    const r = await getSalesSummary(venues.dest, { ...base(), paymentMethod: 'CASH' })
    expect(r.byMerchantAccount).toEqual([])
    expect(r.byPaymentMethodDetailed).toBeUndefined() // el contrato filtrado no cambia
  })

  it('el exporte con filtro «Otros» trae el SPEI en línea, el único cobro de ese método que llega al banco', async () => {
    const r = await getSalesSummary(venues.dest, { ...base(), paymentMethod: 'OTHER' })
    const { rows } = flattenSalesSummaryForExport(r, ['merchantAccounts'])
    expect(rows).toEqual([expect.objectContaining({ label: 'Cobros en línea', count: 1, amount: 198 })])
  })

  it('banco, «Por comercio» y el calendario redondean la comisión igual: por cobro (Codex r3 #4)', async () => {
    const r = await getSalesSummary(venues.dest, base())
    const a = r.byMerchantAccount?.find(m => m.merchantAccountId === merchantA)
    expect([a?.collectedOnCard, a?.platformFee, a?.netToReceive]).toEqual([42, 1.08, 40.92])
    const enCalendario = (r.settlementCalendar ?? []).flatMap(x => x.byMerchant).filter(m => m.merchantAccountId === merchantA)
    expect(c(enCalendario.reduce((acc, m) => acc + m.netToReceive, 0))).toBe(40.92)
    expect(a?.unprojectedNet).toBe(0)
    // El detalle por tipo de tarjeta trae la misma base (Codex r6 #2): crédito = los dos de $21 (lo demás de crédito no cobra comisión).
    const credito = bucket(r.byPaymentMethodDetailed, 'CARD')?.subBuckets?.find(x => x.type === 'CREDIT')
    expect([c(credito?.platformFees), credito?.platformFeesCents]).toEqual([1.07, 1.08])
  })

  it('el aplanador del exporte (lo usa la MCP) arma el estado del periodo («statement»): «Te queda» = suma de sus renglones', async () => {
    const r = await getSalesSummary(venues.dest, base())
    const { rows } = flattenSalesSummaryForExport(r, ['statement'])
    const v = Object.fromEntries(rows.map(x => [x.label, x.amount]))
    expect(
      c(v['Ya en tu mano (efectivo)']! + v['Llega a tu banco']! + v['Otros métodos']! + v['Comisión de plataformas y tipos de pago']!),
    ).toBe(v['Te queda'])
    expect(c(v['Cobraste']! + v['Devoluciones']! + v['Comisiones de Avoqado']! + v['Comisión de plataformas y tipos de pago']!)).toBe(
      v['Te queda'],
    )
  })
})

describe('el contrato de siempre de byPaymentMethodDetailed no cambia con la lectura nueva', () => {
  it('sumas y porcentajes exactos aunque un tipo de tarjeta venga de dos comercios', async () => {
    const r = await getSalesSummary(venues.pct, base())
    const card = bucket(r.byPaymentMethodDetailed, 'CARD')!
    const credito = card.subBuckets?.find(x => x.type === 'CREDIT')
    expect(credito?.amount).toBe(200.33)
    expect(credito?.percentage).toBe(77.1)
    expect(card.amount).toBe(260)
  })
})
