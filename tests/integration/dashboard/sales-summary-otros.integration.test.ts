/**
 * Integración: «Otros» y el estado de cuenta (carril C2, 22-nov-2026; hz:fefa11b6:D12 y la parte del estado de D17).
 *
 * - D12.1: el filtro de método (pantalla y archivo detallado) no cuenta saldo a favor, saldo de regalo ni el crédito de un
 *   cambio: una devolución a saldo a favor no es dinero que salió.
 * - D12.2: un tipo de pago propio que cuenta como efectivo está en «Ya en tu mano».
 * - D12.3: «Otros métodos» del estado, por tipo de pago y con su nombre.
 * - D17: una devolución se fecha el día en que se registró (como «Saldo disponible»), no en un depósito futuro; un cobro de
 *   liga en otra moneda no se suma como pesos.
 */

import prisma from '@/utils/prismaClient'
import { countSalesSummaryDetailRows, getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'

const TZ = 'America/Mexico_City'
// Martes 8 de abril de 2025 en la Ciudad de México.
const FROM = new Date('2025-04-08T06:00:00.000Z')
const TO = new Date('2025-04-09T05:59:59.999Z')
const INSIDE = new Date('2025-04-08T18:00:00.000Z')

const suffix = `otr-${Date.now()}`
let orgId: string
let venueId: string
let providerId: string
let aggregatorId: string
let merchantR: string
let ecommerceId: string
const tenders: Record<'vales' | 'uber' | 'storeCredit' | 'exchange' | 'giftCard', string> = {
  vales: '',
  uber: '',
  storeCredit: '',
  exchange: '',
  giftCard: '',
}
let seq = 0

type Seed = {
  method: 'CASH' | 'CREDIT_CARD' | 'BANK_TRANSFER' | 'OTHER'
  amount: number
  type?: 'REGULAR' | 'REFUND'
  tender?: keyof typeof tenders
  tenderLabel?: string
  countsAsCash?: boolean
  fundsFlow?: 'AVOQADO_PROCESSED' | 'CASH_DRAWER' | 'EXTERNAL_RECORDED'
  tenderCommission?: number
  merchant?: string
  fee?: number
  ecommerce?: boolean
  feeAmount?: number
  processorData?: Record<string, unknown>
  processorId?: string
}

async function seed(s: Seed): Promise<string> {
  seq += 1
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `OTR-${seq}-${suffix}`,
      createdAt: INSIDE,
      subtotal: Math.abs(s.amount),
      taxAmount: 0,
      discountAmount: 0,
      total: Math.abs(s.amount),
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    },
    select: { id: true },
  })
  const payment = await prisma.payment.create({
    data: {
      venueId,
      orderId: order.id,
      amount: s.amount,
      tipAmount: 0,
      method: s.method,
      status: 'COMPLETED',
      type: s.type ?? 'REGULAR',
      feePercentage: 0,
      feeAmount: s.feeAmount ?? 0,
      netAmount: s.amount,
      tenderTypeId: s.tender ? tenders[s.tender] : undefined,
      tenderLabel: s.tenderLabel,
      tenderCountsAsCash: s.countsAsCash,
      fundsFlow: s.fundsFlow,
      tenderCommissionAmount: s.tenderCommission,
      merchantAccountId: s.merchant,
      ecommerceMerchantId: s.ecommerce ? ecommerceId : undefined,
      processorData: s.processorData as never,
      processorId: s.processorId,
      createdAt: INSIDE,
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
        createdAt: INSIDE,
      },
    })
  }
  return payment.id
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
const c = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 100) / 100)

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `OTR Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `otr-${suffix}`, slug: `otr-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id
  const tender = async (name: string, extra: Record<string, unknown>) =>
    (
      await prisma.venueTenderType.create({
        data: { venueId, name, normalizedName: `${name.toLowerCase()}-${suffix}`, baseMethod: 'OTHER', ...extra },
        select: { id: true },
      })
    ).id
  tenders.vales = await tender('Vales', { countsAsPhysicalCash: true })
  tenders.uber = await tender('Uber Eats', { commissionPercent: 30 })
  tenders.storeCredit = await tender('Saldo a favor', { isSystem: true, showOnPos: false, systemKind: 'STORE_CREDIT' })
  tenders.exchange = await tender('Crédito de cambio', { isSystem: true, showOnPos: false, systemKind: 'EXCHANGE_CREDIT' })
  tenders.giftCard = await tender('Tarjeta de regalo', { isSystem: true, showOnPos: false, systemKind: 'GIFT_CARD' })

  providerId = (
    await prisma.paymentProvider.create({
      data: { code: `OTR-${suffix}`, name: `P ${suffix}`, type: 'PAYMENT_PROCESSOR' },
      select: { id: true },
    })
  ).id
  aggregatorId = (await prisma.aggregator.create({ data: { name: `Agg ${suffix}`, baseFees: {} }, select: { id: true } })).id
  merchantR = (
    await prisma.merchantAccount.create({
      data: { providerId, externalMerchantId: `r-${suffix}`, credentialsEncrypted: {}, aggregatorId, displayName: 'Comercio R' },
      select: { id: true },
    })
  ).id
  await prisma.settlementConfiguration.create({
    data: {
      merchantAccountId: merchantR,
      cardType: 'CREDIT',
      settlementDays: 1,
      settlementDayType: 'BUSINESS_DAYS',
      cutoffTime: '23:00',
      cutoffTimezone: TZ,
      effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
    },
  })
  ecommerceId = (
    await prisma.ecommerceMerchant.create({
      data: {
        venueId,
        businessName: 'OTR en línea',
        contactEmail: `otr-${suffix}@test.com`,
        publicKey: `pk_test_otr_${suffix}`,
        secretKeyHash: `otr-hash-${suffix}`,
        providerId,
        providerCredentials: {},
      },
      select: { id: true },
    })
  ).id

  // Dinero de verdad: efectivo, un vale que cuenta como efectivo, Uber con su 30 % y una transferencia.
  await seed({ method: 'CASH', amount: 100 })
  await seed({ method: 'OTHER', amount: 80, tender: 'vales', tenderLabel: 'Vales', countsAsCash: true, fundsFlow: 'CASH_DRAWER' })
  // Uber como lo guarda el escritor de delivery: con su tipo de pago y SIN `tenderLabel` (el nombre sale del tipo, el de hoy).
  await seed({ method: 'OTHER', amount: 100, tender: 'uber', fundsFlow: 'EXTERNAL_RECORDED', tenderCommission: 30 })
  await seed({ method: 'BANK_TRANSFER', amount: 50, fundsFlow: 'EXTERNAL_RECORDED' })
  // Lo que NO es dinero: devolución a saldo a favor, las dos patas de un cambio parejo y un pago con saldo de regalo.
  await seed({ method: 'OTHER', amount: -30, type: 'REFUND', tender: 'storeCredit', tenderLabel: 'Saldo a favor' })
  await seed({ method: 'OTHER', amount: -100, type: 'REFUND', tender: 'exchange', tenderLabel: 'Crédito de cambio' })
  await seed({ method: 'OTHER', amount: 100, tender: 'exchange', tenderLabel: 'Crédito de cambio' })
  await seed({ method: 'OTHER', amount: 40, tender: 'giftCard', tenderLabel: 'Tarjeta de regalo' })
  // Cuentas cubiertas por una cortesía: la TPV cierra con $0 marcado `FREE_CART`; el POS, con efectivo de $0 sin marca. No son dinero.
  await seed({ method: 'OTHER', amount: 0, processorData: { type: 'FREE_CART', reason: 'total_zero_cortesia_or_discount' } })
  await seed({ method: 'CASH', amount: 0 })
  // Una devolución a tarjeta registrada hoy (con su comisión revertida) en el comercio R.
  await seed({ method: 'CREDIT_CARD', amount: -30, type: 'REFUND', merchant: merchantR, fee: -0.9 })
  // D17 · una liga cobrada en dólares (US$100, comisión 4) y su devolución parcial (US$20): no se suman como pesos.
  const usd = await seed({ method: 'CREDIT_CARD', amount: 100, ecommerce: true, fundsFlow: 'AVOQADO_PROCESSED', feeAmount: 4 })
  await prisma.checkoutSession.create({
    data: {
      sessionId: `cs_test_otr_${suffix}`,
      ecommerceMerchantId: ecommerceId,
      amount: 100,
      currency: 'usd',
      paymentId: usd,
      status: 'COMPLETED',
      expiresAt: new Date('2025-04-09T18:00:00.000Z'),
    },
  })
  await seed({ method: 'CREDIT_CARD', amount: -20, type: 'REFUND', processorData: { originalPaymentId: usd } })
  // D17 · ligas de antes de D7 (la sesión no trae `paymentId`): Stripe Checkout guarda el `pi_…` del cobro en su metadata y
  // Blumon E-commerce en `blumonCheckoutId` (y su cobro viejo no trae canal). Las dos en euros (Codex r3 del carril C2, #1).
  await seed({ method: 'CREDIT_CARD', amount: 50, ecommerce: true, fundsFlow: 'AVOQADO_PROCESSED', processorId: `pi_otr_${suffix}` })
  await prisma.checkoutSession.create({
    data: {
      sessionId: `cs_test_otr_viejo_${suffix}`,
      ecommerceMerchantId: ecommerceId,
      amount: 50,
      currency: 'eur',
      metadata: { stripePaymentIntentId: `pi_otr_${suffix}` },
      status: 'COMPLETED',
      expiresAt: new Date('2025-04-09T18:00:00.000Z'),
    },
  })
  await seed({ method: 'CREDIT_CARD', amount: 30, processorId: `blm_otr_${suffix}` })
  await prisma.checkoutSession.create({
    data: {
      sessionId: `cs_avoqado_otr_viejo_${suffix}`,
      ecommerceMerchantId: ecommerceId,
      amount: 30,
      currency: ' EUR ',
      blumonCheckoutId: `blm_otr_${suffix}`,
      status: 'COMPLETED',
      expiresAt: new Date('2025-04-09T18:00:00.000Z'),
    },
  })
  // `484` es el peso (código numérico ISO): sigue en las cuentas en pesos, en línea.
  const pesos484 = await seed({ method: 'CREDIT_CARD', amount: 25, ecommerce: true, fundsFlow: 'AVOQADO_PROCESSED' })
  await prisma.checkoutSession.create({
    data: {
      sessionId: `cs_test_otr_484_${suffix}`,
      ecommerceMerchantId: ecommerceId,
      amount: 25,
      currency: '484',
      paymentId: pesos484,
      status: 'COMPLETED',
      expiresAt: new Date('2025-04-09T18:00:00.000Z'),
    },
  })
})

afterAll(async () => {
  if (!orgId) return
  await prisma.checkoutSession.deleteMany({ where: { ecommerceMerchantId: ecommerceId } })
  await prisma.transactionCost.deleteMany({ where: { payment: { venueId } } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.settlementConfiguration.deleteMany({ where: { merchantAccountId: merchantR } })
  await prisma.merchantAccount.deleteMany({ where: { id: merchantR } })
  if (ecommerceId) await prisma.ecommerceMerchant.deleteMany({ where: { id: ecommerceId } })
  if (aggregatorId) await prisma.aggregator.deleteMany({ where: { id: aggregatorId } })
  if (providerId) await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
  await prisma.venueTenderType.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('D12.1 · el filtro «Otros» sólo cuenta dinero', () => {
  it('sin saldo a favor, cambios ni saldo de regalo: la devolución a saldo a favor no resta', async () => {
    const r = await getSalesSummary(venueId, base({ paymentMethod: 'OTHER' }))
    // Vales 80 + Uber 100 + transferencia 50; nada de devoluciones ni la cortesía de $0.
    expect(r.summary.refunds).toBe(0)
    expect(r.summary.transactionCount).toBe(3)
    expect(c(r.summary.tips)).toBe(0)
  })

  it('con «Efectivo», la cortesía del POS (efectivo de $0 sin marca) tampoco cuenta', async () => {
    const r = await getSalesSummary(venueId, base({ paymentMethod: 'CASH' }))
    expect(r.summary.transactionCount).toBe(1)
  })

  it('el archivo detallado con «Otros» tiene la misma población', async () => {
    const n = await countSalesSummaryDetailRows(venueId, {
      startDate: FROM.toISOString(),
      endDate: TO.toISOString(),
      paymentMethod: 'OTHER',
    })
    expect(n).toBe(3)
  })
})

describe('D12.2 y D12.3 · el estado de cuenta clasifica por tenderSemantics y nombra los tipos de pago', () => {
  it('el vale que cuenta como efectivo está en «Ya en tu mano»; «Otros» trae Uber y la transferencia por nombre', async () => {
    const r = await getSalesSummary(venueId, base())
    const d = r.statementDestinations!
    expect(c(d.drawer.collected)).toBe(180) // efectivo 100 + vales 80
    expect(d.drawer.transactionCount).toBe(2) // la cortesía de $0 del POS no es un cobro
    expect(c(d.other.collected)).toBe(150) // Uber 100 + transferencia 50 (sin saldo a favor, cambio ni saldo de regalo)
    expect(c(d.tenderCommissions)).toBe(30)
    const tipos = (d.otherByType ?? []).map(t => [t.label ?? t.method, c(t.netToReceive), c(t.tenderCommissions)])
    expect(tipos).toEqual(
      expect.arrayContaining([
        ['Uber Eats', 100, 30],
        ['BANK_TRANSFER', 50, 0],
      ]),
    )
    expect(tipos).toHaveLength(2) // la cortesía de $0 no es un tipo de cobro
    expect(d.other.transactionCount).toBe(2)
    expect(c((d.otherByType ?? []).reduce((s, t) => s + t.netToReceive, 0))).toBe(c(d.other.netToReceive))
  })
})

describe('D17 · fechas y monedas del estado de cuenta', () => {
  it('una liga en otra moneda sale aparte, en su moneda, y no se suma a cajones ni destinos', async () => {
    const r = await getSalesSummary(venueId, base())
    // USD: neto (100 cobrados − 20 devueltos), con sus cobros y sus devoluciones contados aparte. EUR: las dos ligas de antes de D7.
    expect(r.statementDestinations?.foreignCurrency).toEqual([
      { currency: 'EUR', net: 80, transactionCount: 2, refundCount: 0 },
      { currency: 'USD', net: 80, transactionCount: 1, refundCount: 1 },
    ])
    // La de `484` sí es pesos: en línea.
    expect([c(r.statementDestinations?.online.collected), r.statementDestinations?.online.transactionCount]).toEqual([25, 1])
    const card = r.byPaymentMethodDetailed?.find(b => b.bucket === 'CARD')
    // Los campos de siempre del cajón siguen contando todo (−30 de R + 100 − 20 + 50 + 30 + 25), como «Métodos de pago» y el
    // total; el cajón dice cuánto es de otra moneda, y lo nuevo del estado (lo cobrado) es sólo pesos.
    expect([c(card?.amount), card?.count]).toEqual([155, 6])
    expect([c(card?.foreignAmount), card?.foreignCount]).toEqual([160, 4])
    expect([c(card?.chargedAmount), card?.chargedCount]).toEqual([25, 1])
  })
})
