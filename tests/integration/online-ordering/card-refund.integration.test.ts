// tests/integration/online-ordering/card-refund.integration.test.ts
/**
 * Integration (Postgres REAL) — fase 2, tarea 10: devolver a la tarjeta un pedido en línea cobrado. Stripe va espiado (con su
 * idempotencia por clave); `issueRefund` y el libro son los de verdad. Lo que los dobles no prueban: que avanzar se hace FUERA del
 * candado de la orden (la repetición de una SUCCEEDED escribe su renglón sin bloquearse), dos ejecutores a la vez dejan UN renglón,
 * la comisión devuelta llega al REFUND y a su VenueTransaction, el turno vivo no se toca, un «Cambio» previo cuenta como devuelto,
 * la cuenta del cargo (no la viva) y la caja de «Devolver por otro medio» con su rollback real. Sólo filas propias (sufijo único),
 * borradas en `afterAll`.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { StripeConnectProvider } from '@/services/payments/providers/stripe-connect.provider'
import { confirmCardAuthorization } from '@/services/online-ordering/card/confirm.service'
import { createCardOnlineDraft } from '@/services/online-ordering/card/draft.service'
import { acceptOnlineOrder, rejectOnlineOrder } from '@/services/online-ordering/transitions.service'
import { clearPublicMenuCache } from '@/services/online-ordering/menu.service'
import { updateSettings } from '@/services/online-ordering/settings.service'
import { __resetPresenceDebounceForTests, touchInboxPoll } from '@/services/online-ordering/presence.service'
import { processStripeConnectWebhookEvent } from '@/services/payments/reservation-deposit-webhook.service'
import { advanceCardRefund, refundCardOnlineOrder, resolveReversedCardRefund } from '@/services/online-ordering/card/refund.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { issueRefund, writeRefundInTx } from '@/services/dashboard/refund.dashboard.service'
import { ORDER_LOCK_WAIT_BUDGET } from '@/services/shared/paymentShiftClaim'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { getAvailableBalance, getSettlementTimeline } from '@/services/dashboard/availableBalance.dashboard.service'

/** `logAction` está simulado en toda la integración (integration-setup): se cuentan sus llamadas. */
const logged = (action: string, entityId: string) =>
  (logAction as jest.Mock).mock.calls.filter(([p]) => p.action === action && p.entityId === entityId).length

jest.setTimeout(60_000)

// El guardia global rechaza `av-db-25` y hosts remotos; esta suite exige además una base desechable o la propia de la fase.
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !/^\/(avoqado_[a-z0-9_]+_test_[a-z0-9_]+|av-db-25-[a-z0-9-]+)$/.test(database.pathname)
) {
  throw new Error('Esta suite sólo corre contra una base desechable (avoqado_<tarea>_test_<fecha> o av-db-25-<fase>) en localhost.')
}

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { broadcastToVenue: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn(async () => undefined),
}))
jest.mock('@/services/superadmin/platformSettings.service', () => ({
  ...jest.requireActual('@/services/superadmin/platformSettings.service'),
  getVatRateBps: jest.fn(async () => 1600),
}))
// El recibo y el aviso al panel no son de esta prueba (salen por correo/socket).
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/receipt.dashboard.service'),
  generateAndStoreReceipt: jest.fn(async () => undefined),
}))
jest.mock('@/services/dashboard/notification.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/notification.dashboard.service'),
  sendVenueNotification: jest.fn(async () => []),
}))

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e4)}`
const MIN = 60_000

describe('Pedidos en línea con tarjeta — devolución a la tarjeta (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string
  let merchantId: string
  let productId: string
  let seq = 0
  let phoneSeq = 0
  const nextKey = (p = 'ref') => `${p}-${RUN}-${++seq}`.padEnd(40, 'x').slice(0, 60)
  const nextPhone = () => `+5255${30_000_000 + (((Number(RUN.slice(-6)) % 100_000) * 100 + ++phoneSeq) % 60_000_000)}`

  let piSeq = 0
  let sessionSpy: jest.SpyInstance
  let authSpy: jest.SpyInstance
  let captureSpy: jest.SpyInstance
  let refundSpy: jest.SpyInstance
  let getRefundSpy: jest.SpyInstance
  let listRefundsSpy: jest.SpyInstance
  let feeSpy: jest.SpyInstance
  /** Stripe con su idempotencia: la misma clave devuelve la misma devolución. La comisión devuelta, proporcional por PI. */
  const stripeRefunds = new Map<string, { refundId: string; amount: number; status: 'PENDING' | 'SUCCEEDED' | 'FAILED' }>()
  const feeRefunded = new Map<string, number>()
  let nextRefundStatus: 'PENDING' | 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED'

  /** Un pedido con la tarjeta apartada (borrador → autorización confirmada); `capturedOrder` además lo acepta (cobra). */
  const authorizedOrder = async () => {
    const key = nextKey('cap')
    __resetPresenceDebounceForTests()
    await touchInboxPoll(venueId!)
    await createCardOnlineDraft(
      {
        venueId: venueId!,
        venueSlug: `itest-cr-${RUN}`,
        idempotencyKey: key,
        items: [{ productId, quantity: 1 }],
        expectedTotal: '250.00',
        customer: { name: 'Ana ITEST', phone: nextPhone(), email: 'ana@test.com' },
        note: null,
        whatsappConsent: false,
      },
      { assertCanCreate: async () => {} },
    )
    const draft = await prisma.onlineOrderCharge.findUniqueOrThrow({
      where: { venueId_idempotencyKey: { venueId: venueId!, idempotencyKey: key } },
    })
    authSpy.mockResolvedValueOnce({
      sessionStatus: 'complete',
      paymentIntentId: `pi_itest_cr_${RUN}_${++piSeq}`,
      piStatus: 'requires_capture',
      amountCapturableCents: 25_000,
      amountReceivedCents: 0,
      captureBefore: new Date(Date.now() + 7 * 24 * 60 * MIN),
      card: { brand: 'visa', last4: '4242', funding: 'credit' },
      paymentMethodType: 'card',
    })
    await expect(confirmCardAuthorization(draft.id)).resolves.toBe('CREATED')
    const charge = await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: draft.id } })
    const oo = await prisma.onlineOrder.findUniqueOrThrow({ where: { id: charge.onlineOrderId! } })
    return { orderId: oo.orderId, charge }
  }
  const capturedOrder = async () => {
    const { orderId, charge } = await authorizedOrder()
    const oo = { orderId }
    __resetPresenceDebounceForTests()
    await touchInboxPoll(venueId!)
    await expect(acceptOnlineOrder({ venueId: venueId!, orderId: oo.orderId, staffId: null })).resolves.toMatchObject({ outcome: 'OK' })
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: oo.orderId, type: 'REGULAR' } })
    return { orderId: oo.orderId, charge, paymentId: payment.id }
  }
  const pedir = (orderId: string, o: Partial<{ amount: string; key: string; note: string }> = {}) =>
    refundCardOnlineOrder({
      venueId: venueId!,
      orderId,
      amount: new Prisma.Decimal(o.amount ?? '250.00'),
      reason: 'CANCELLED_ORDER',
      staffId,
      idempotencyKey: o.key ?? nextKey(),
      note: o.note ?? null,
    })
  const refundsOf = (orderId: string) =>
    prisma.payment.findMany({ where: { orderId, type: 'REFUND' }, include: { transaction: true }, orderBy: { createdAt: 'asc' }, take: 10 })

  /**
   * Codex r4 H1: la comisión que publican el reporte de ventas (cabecera, barras y desglose por tarjeta) y el saldo disponible. El cobro
   * de Stripe no tiene `TransactionCost`: su comisión vive en el `Payment` (`feeAmount`), y publicarla como $0 mentía.
   */
  const comisiones = async () => {
    const rango = { startDate: new Date(Date.now() - 86_400_000).toISOString(), endDate: new Date(Date.now() + 86_400_000).toISOString() }
    const resumen = (await getSalesSummary(venueId!, { ...rango, reportType: 'summary' })).summary
    const porDia = (await getSalesSummary(venueId!, { ...rango, reportType: 'days' })).byPeriod ?? []
    const porMetodo = await getSalesSummary(venueId!, { ...rango, reportType: 'summary', groupBy: 'paymentMethod' })
    return {
      cabecera: Number(resumen.platformFees.toFixed(2)),
      barras: Number(porDia.reduce((t, p) => t + Number(p.metrics?.platformFees ?? 0), 0).toFixed(2)),
      desglose: Number((porMetodo.byPaymentMethodDetailed ?? []).reduce((t, b) => t + b.platformFees, 0).toFixed(2)),
      saldo: Number((await getAvailableBalance(venueId!)).totalFees.toFixed(2)),
      linea: Number(
        (await getSettlementTimeline(venueId!, { from: new Date(rango.startDate), to: new Date(rango.endDate) }))
          .reduce((t, e) => t + e.fees, 0)
          .toFixed(2),
      ),
    }
  }
  const mas = (a: Record<string, number>, d: number) =>
    Object.fromEntries(Object.entries(a).map(([k, v]) => [k, Number((v + d).toFixed(2))]))

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({
        data: { name: `ITEST devolución ${RUN}`, slug: `itest-cr-org-${RUN}`, email: `itest-cr-${RUN}@t.mx`, phone: '5550000000' },
      })
    ).id
    venueId = (
      await prisma.venue.create({
        data: {
          organizationId: orgId,
          name: `ITEST devolución ${RUN}`,
          slug: `itest-cr-${RUN}`,
          timezone: 'America/Mexico_City',
          address: 'Av. Coyoacán 123',
          city: 'CDMX',
          state: 'CDMX',
          zipCode: '04000',
          phone: '5512345678',
        },
      })
    ).id
    staffId = (await prisma.staff.create({ data: { email: `itest-cr-${RUN}@t.mx`, firstName: 'Gerente', lastName: 'Devolución' } })).id
    await prisma.staffVenue.create({ data: { venueId, staffId, role: 'OWNER' } })
    await prisma.privacyNoticeVersion.create({ data: { venueId, content: 'Aviso ITEST', contentHash: `itest-cr-${RUN}` } })
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Flautas', slug: `flautas-cr-${RUN}` } })
    productId = (
      await prisma.product.create({
        data: { venueId, name: 'Orden grande', sku: `CR-${RUN}`, price: 250, categoryId: category.id, availableOnline: true },
      })
    ).id
    const provider = await prisma.paymentProvider.upsert({
      where: { code: 'STRIPE_CONNECT' },
      update: {},
      create: { code: 'STRIPE_CONNECT', name: 'Stripe Connect', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
    merchantId = (
      await prisma.ecommerceMerchant.create({
        data: {
          venueId,
          businessName: 'ITEST devolución',
          contactEmail: `itest-cr-merchant-${RUN}@test.com`,
          publicKey: `pk_test_itest_cr_${RUN}`,
          secretKeyHash: `itest-cr-hash-${RUN}`,
          providerId: provider.id,
          providerCredentials: { connectAccountId: 'acct_itest_A' },
          chargesEnabled: true,
          platformFeeBps: 100,
          sandboxMode: true,
        },
      })
    ).id
    await updateSettings(venueId, { enabled: true, minOrderAmount: 0, defaultPrepMinutes: 15 }, null)
    await prisma.onlineOrderingSettings.update({ where: { venueId }, data: { acceptsCardOnline: true } })
    clearPublicMenuCache()

    sessionSpy = jest.spyOn(StripeConnectProvider.prototype, 'createAuthorizationCheckout')
    sessionSpy.mockImplementation(async (_m: any, p: any) => ({
      id: `cs_itest_cr_${p.idempotencyKey}`,
      url: `https://checkout.stripe.test/${p.idempotencyKey}`,
      expiresAt: p.expiresAt,
    }))
    authSpy = jest.spyOn(StripeConnectProvider.prototype, 'getAuthorization')
    captureSpy = jest.spyOn(StripeConnectProvider.prototype, 'capture')
    captureSpy.mockImplementation(async (_m: any, p: any) => ({
      sessionStatus: null,
      paymentIntentId: p.paymentIntentId,
      piStatus: 'succeeded',
      amountCapturableCents: 0,
      amountReceivedCents: p.amountCents,
      captureBefore: null,
      card: { brand: 'visa', last4: '4242', funding: 'credit' },
      paymentMethodType: 'card',
    }))
    refundSpy = jest.spyOn(StripeConnectProvider.prototype, 'refund')
    getRefundSpy = jest.spyOn(StripeConnectProvider.prototype, 'getRefund')
    listRefundsSpy = jest.spyOn(StripeConnectProvider.prototype, 'listRefunds')
    feeSpy = jest.spyOn(StripeConnectProvider.prototype, 'getApplicationFeeRefundedCents')
  })

  beforeEach(() => {
    nextRefundStatus = 'SUCCEEDED'
    refundSpy.mockReset()
    refundSpy.mockImplementation(async (_m: any, p: any) => {
      if (!stripeRefunds.has(p.idempotencyKey)) {
        stripeRefunds.set(p.idempotencyKey, {
          refundId: `re_itest_${RUN}_${stripeRefunds.size + 1}`,
          amount: p.amount,
          status: nextRefundStatus,
        })
        // Stripe devuelve la comisión en proporción (290 de 25,000), sólo si se pidió (Codex r3 #3: un cobro a mano no la trae).
        if (p.refundApplicationFee)
          feeRefunded.set(p.paymentIntentId, (feeRefunded.get(p.paymentIntentId) ?? 0) + Math.round((290 * p.amount) / 25_000))
      }
      return stripeRefunds.get(p.idempotencyKey)!
    })
    getRefundSpy.mockReset()
    getRefundSpy.mockImplementation(async (_m: any, id: string) => ({
      refundId: id,
      status: 'SUCCEEDED',
      amountCents: 0,
      failureReason: null,
    }))
    listRefundsSpy.mockReset()
    listRefundsSpy.mockResolvedValue([])
    feeSpy.mockReset()
    feeSpy.mockImplementation(async (_m: any, pi: string) => feeRefunded.get(pi) ?? 0)
  })

  afterAll(async () => {
    for (const s of [sessionSpy, authSpy, captureSpy, refundSpy, getRefundSpy, listRefundsSpy, feeSpy]) s?.mockRestore()
    // Limpieza acotada: sin venueId NO se borra nada.
    if (!venueId) return
    const v = { venueId }
    await prisma.onlineOrderCardRefundReversal.deleteMany({ where: v })
    await prisma.onlineOrderCardRefund.deleteMany({ where: v })
    await prisma.cashDrawerEvent.deleteMany({ where: v })
    await prisma.cashDrawerSession.deleteMany({ where: v })
    await prisma.processedStripeEvent.deleteMany({ where: { stripeEventId: { startsWith: `evt_itest_cr_${RUN}` } } })
    await prisma.moneyAnomaly.deleteMany({
      where: { stripeEventId: { startsWith: 'oocr:' }, expectedState: { path: ['venueId'], equals: venueId } },
    })
    await prisma.moneyAnomaly.deleteMany({ where: { stripeEventId: { startsWith: `evt_itest_cr_${RUN}` } } })
    await prisma.idempotencyRequest.deleteMany({ where: { organizationId: `venue:${venueId}` } })
    await prisma.activityLog.deleteMany({ where: v })
    await prisma.paymentEffect.deleteMany({ where: v })
    await prisma.inventoryPosting.deleteMany({ where: v })
    await prisma.venueTransaction.deleteMany({ where: v })
    await prisma.payment.deleteMany({ where: { ...v, type: 'REFUND' } })
    await prisma.payment.deleteMany({ where: v })
    await prisma.shift.deleteMany({ where: v })
    await prisma.onlineOrderCharge.deleteMany({ where: v })
    await prisma.onlineOrder.deleteMany({ where: v })
    await prisma.order.deleteMany({ where: v })
    await prisma.ecommerceMerchant.deleteMany({ where: v })
    await prisma.product.deleteMany({ where: v })
    await prisma.menuCategory.deleteMany({ where: v })
    await prisma.customer.deleteMany({ where: v })
    await prisma.onlineOrderingSettings.deleteMany({ where: v })
    await prisma.privacyNoticeVersion.deleteMany({ where: v })
    await prisma.staffVenue.deleteMany({ where: v })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
    if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  it('total: un renglón REFUND con la comisión devuelta, sin VenueTransaction (como su cobro), el saldo cuadra y la bitácora', async () => {
    const comisionAntes = await comisiones()
    const { orderId, charge } = await capturedOrder()
    // Codex r4 H1: la comisión de Avoqado ($2.90) se ve en el reporte, las barras, el desglose por tarjeta y el saldo.
    expect(await comisiones()).toEqual(mas(comisionAntes, 2.9))
    const saldoAntes = await getAvailableBalance(venueId!)
    const r = await pedir(orderId)
    expect(r).toMatchObject({ status: 'RECORDED', replay: false })
    expect(refundSpy).toHaveBeenCalledTimes(1)
    expect(refundSpy.mock.calls[0][1]).toEqual({
      paymentIntentId: charge.paymentIntentId,
      amount: 25_000,
      refundApplicationFee: true,
      idempotencyKey: `online-order:${orderId}:refund:${r.cardRefundId}`,
      metadata: { type: 'online_order_refund', cardRefundId: r.cardRefundId, orderId, venueId },
    })
    const [ledger] = await refundsOf(orderId)
    expect(ledger.id).toBe(r.refundId)
    expect(ledger.amount.toFixed(2)).toBe('-250.00')
    expect(ledger.feeAmount.toFixed(2)).toBe('-2.90')
    expect(ledger.netAmount.toFixed(2)).toBe('-247.10')
    // Codex r3 #2: el cobro de Stripe no tiene VenueTransaction (su saldo es «pendiente»), así que su devolución tampoco: una fila
    // SETTLED restaba de «Disponible» lo que nunca entró ahí y dejaba el cobro en «Pendiente» para siempre.
    expect(ledger.transaction).toBeNull()
    const saldoDespues = await getAvailableBalance(venueId!)
    expect(saldoDespues.availableNow).toBeCloseTo(saldoAntes.availableNow, 2)
    // Codex r4 H1: el cobro estaba en «Pendiente» neto de su comisión ($247.10) y la devolución resta lo mismo: se anulan.
    expect(saldoDespues.pendingSettlement).toBeCloseTo(saldoAntes.pendingSettlement - 247.1, 2)
    // …y la que Stripe devolvió con el reembolso total la regresa a donde estaba.
    expect(await comisiones()).toEqual(comisionAntes)
    expect(ledger.idempotencyKey).toBe(`oocr_${r.cardRefundId}`)
    const row = await prisma.onlineOrderCardRefund.findUniqueOrThrow({ where: { id: r.cardRefundId } })
    expect(row).toMatchObject({ status: 'RECORDED', feeRefundedCents: 290, refundPaymentId: ledger.id })
    expect(logged('ONLINE_ORDER_CARD_REFUNDED', r.cardRefundId)).toBe(1)
  })

  it('Codex r5: un día con sólo la devolución (sin pedidos nuevos) sale en las barras con su devolución y la comisión que regresó', async () => {
    const { orderId } = await capturedOrder()
    await pedir(orderId)
    const [ledger] = await refundsOf(orderId)
    const otroDia = new Date(Date.now() + 3 * 86_400_000)
    await prisma.payment.update({ where: { id: ledger.id }, data: { createdAt: otroDia } })
    const rango = {
      startDate: new Date(otroDia.getTime() - 6 * 3_600_000).toISOString(),
      endDate: new Date(otroDia.getTime() + 6 * 3_600_000).toISOString(),
    }
    const resumen = (await getSalesSummary(venueId!, { ...rango, reportType: 'summary' })).summary
    const porDia = (await getSalesSummary(venueId!, { ...rango, reportType: 'days' })).byPeriod ?? []
    const suma = (k: 'platformFees' | 'refunds') => Number(porDia.reduce((t, p) => t + Number(p.metrics?.[k] ?? 0), 0).toFixed(2))
    expect(resumen.platformFees).toBeCloseTo(-2.9, 2)
    expect(suma('platformFees')).toBe(-2.9)
    expect(resumen.refunds).toBeCloseTo(250, 2)
    expect(suma('refunds')).toBe(250)
  })

  it('Codex r5 (deuda 5): un cobro sin costo que NO procesó Avoqado (importado de SoftRestaurant, demo) no publica su feeAmount como comisión', async () => {
    const { orderId } = await capturedOrder()
    const antes = await comisiones()
    // Como lo escribe el importador de SoftRestaurant y las semillas demo: comisión calculada para cualquier método, sin `fundsFlow` ni
    // comercio en línea. Con tarjeta también: el saldo y la línea de tiempo cuentan las tarjetas sin `fundsFlow` (histórico).
    for (const method of ['CASH', 'CREDIT_CARD'] as const) {
      await prisma.payment.create({
        data: {
          venueId: venueId!,
          orderId,
          amount: new Prisma.Decimal(250),
          tipAmount: new Prisma.Decimal(0),
          feePercentage: new Prisma.Decimal(0.025),
          feeAmount: new Prisma.Decimal(6.25),
          netAmount: new Prisma.Decimal(243.75),
          method,
          status: 'COMPLETED',
          type: 'REGULAR',
          splitType: 'FULLPAYMENT',
          source: 'POS',
        },
      })
    }
    expect(await comisiones()).toEqual(antes)
  })

  it('Codex r6: el cobro viejo de una liga de pago (comercio en línea, sin `fundsFlow`) sí publica su comisión real', async () => {
    const { orderId, charge } = await capturedOrder()
    const antes = await comisiones()
    await prisma.payment.create({
      data: {
        venueId: venueId!,
        orderId,
        ecommerceMerchantId: charge.ecommerceMerchantId,
        amount: new Prisma.Decimal(250),
        tipAmount: new Prisma.Decimal(0),
        feePercentage: new Prisma.Decimal(0.0116),
        feeAmount: new Prisma.Decimal(2.9),
        netAmount: new Prisma.Decimal(247.1),
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        type: 'REGULAR',
        splitType: 'FULLPAYMENT',
        source: 'WEB',
      },
    })
    expect(await comisiones()).toEqual(mas(antes, 2.9))
  })

  it('parcial dos veces hasta el total: Σ feeAmount de los REFUND = −comisión del cobro; la tercera → 400 sin Stripe', async () => {
    const { orderId } = await capturedOrder()
    await expect(pedir(orderId, { amount: '125.00' })).resolves.toMatchObject({ status: 'RECORDED' })
    await expect(pedir(orderId, { amount: '125.00' })).resolves.toMatchObject({ status: 'RECORDED' })
    const ledger = await refundsOf(orderId)
    expect(ledger).toHaveLength(2)
    const fees = ledger.reduce((s, p) => s.plus(p.feeAmount), new Prisma.Decimal(0))
    expect(fees.toFixed(2)).toBe('-2.90')
    refundSpy.mockClear()
    await expect(pedir(orderId, { amount: '1.00' })).rejects.toMatchObject({ statusCode: 400 })
    expect(refundSpy).not.toHaveBeenCalled()
  })

  it('ruling 2: un «Cambio» de $100 en saldo a favor ya contra el cobro de Stripe → $250 a la tarjeta es 400 sin Stripe; $150 sí', async () => {
    const { orderId, paymentId } = await capturedOrder()
    await prisma.payment.create({
      data: {
        venueId: venueId!,
        orderId,
        amount: new Prisma.Decimal('-100.00'),
        tipAmount: 0,
        method: 'OTHER',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: new Prisma.Decimal('-100.00'),
        status: 'COMPLETED',
        type: 'REFUND',
        processor: 'dashboard',
        processorData: { originalPaymentId: paymentId, amountCents: 10_000, amount: 100, exchange: { exchangeId: null, role: 'CREDIT' } },
      },
    })
    await expect(pedir(orderId)).rejects.toMatchObject({ statusCode: 400 })
    expect(refundSpy).not.toHaveBeenCalled()
    expect(await prisma.onlineOrderCardRefund.count({ where: { venueId, chargeId: { not: '' }, status: 'REQUESTED' } })).toBe(0)
    await expect(pedir(orderId, { amount: '150.00' })).resolves.toMatchObject({ status: 'RECORDED' })
    expect(refundSpy).toHaveBeenCalledTimes(1)
  })

  it('fix r1: con $250 a la tarjeta PENDING, un «Cambio» de $100 (writeRefundInTx) o issueRefund → 400; la devolución en curso sí se anota', async () => {
    const { orderId, paymentId } = await capturedOrder()
    nextRefundStatus = 'PENDING'
    const r = await pedir(orderId)
    expect(r).toMatchObject({ status: 'PENDING', refundId: null })

    // El camino del «Cambio»: el núcleo del reembolso, con el candado compartido del cobro.
    await expect(
      prisma.$transaction(
        tx =>
          writeRefundInTx(tx, {
            venueId: venueId!,
            originalPaymentId: paymentId,
            salesRefundCents: 10_000,
            tipRefundCents: 0,
            refundedItems: [],
            reason: 'RETURNED_GOODS',
            note: 'Cambio ITEST',
            staffId,
            tenderCommission: 'NONE',
            shift: 'CLAIM_LIVE',
          }),
        ORDER_LOCK_WAIT_BUDGET,
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
    // issueRefund por el carril de pedidos en línea pero de otra devolución (sin excluir la suya) → 400 por saldo…
    await expect(
      issueRefund({ venueId: venueId!, paymentId, amount: 10_000, reason: 'OTHER', staffId, viaOnlineOrders: true }),
    ).rejects.toMatchObject({ statusCode: 400 })
    // …y sin el carril, la guarda de T8 lo manda a Pedidos en línea.
    await expect(issueRefund({ venueId: venueId!, paymentId, amount: 10_000, reason: 'OTHER', staffId })).rejects.toMatchObject({
      statusCode: 409,
      code: 'ONLINE_ORDER_REFUND_VIA_ONLINE_ORDERS',
    })
    expect(await refundsOf(orderId)).toHaveLength(0)

    // La devolución en curso no se rechaza a sí misma al anotarse.
    getRefundSpy.mockImplementation(async (_m: any, id: string) => ({
      refundId: id,
      status: 'SUCCEEDED',
      amountCents: 25_000,
      failureReason: null,
    }))
    await expect(advanceCardRefund(r.cardRefundId)).resolves.toBe('RECORDED')
    const ledger = await refundsOf(orderId)
    expect(ledger).toHaveLength(1)
    expect(ledger[0].amount.toFixed(2)).toBe('-250.00')
  })

  it('r4 #5: la repetición de una devolución SUCCEEDED escribe su renglón sin bloquearse (se avanza fuera del candado)', async () => {
    const { orderId } = await capturedOrder()
    const key = nextKey()
    feeSpy.mockRejectedValueOnce(Object.assign(new Error('Stripe no responde'), { type: 'StripeConnectionError' }))
    const first = await pedir(orderId, { key })
    expect(first).toMatchObject({ status: 'UNKNOWN', cardRefundStatus: 'SUCCEEDED', refundId: null })
    expect(await refundsOf(orderId)).toHaveLength(0)

    const again = await pedir(orderId, { key })
    expect(again).toMatchObject({ cardRefundId: first.cardRefundId, status: 'RECORDED', replay: true })
    expect(await refundsOf(orderId)).toHaveLength(1)
    expect(refundSpy).toHaveBeenCalledTimes(1)
  })

  it('dos ejecutores de la misma devolución en paralelo → un solo renglón', async () => {
    const { orderId } = await capturedOrder()
    feeSpy.mockRejectedValueOnce(Object.assign(new Error('Stripe no responde'), { type: 'StripeConnectionError' }))
    const first = await pedir(orderId)
    expect(first.cardRefundStatus).toBe('SUCCEEDED')

    const outcomes = await Promise.allSettled([advanceCardRefund(first.cardRefundId), advanceCardRefund(first.cardRefundId)])
    expect(outcomes.some(o => o.status === 'fulfilled' && o.value === 'RECORDED')).toBe(true)
    expect(await refundsOf(orderId)).toHaveLength(1)
    const row = await prisma.onlineOrderCardRefund.findUniqueOrThrow({ where: { id: first.cardRefundId } })
    expect(row.status).toBe('RECORDED')
    expect(logged('ONLINE_ORDER_CARD_REFUNDED', row.id)).toBe(1)
  })

  it('la misma llave del cliente en dos pedidos → dos devoluciones y dos renglones', async () => {
    const a = await capturedOrder()
    const b = await capturedOrder()
    const key = nextKey('shared')
    const ra = await pedir(a.orderId, { key })
    const rb = await pedir(b.orderId, { key })
    expect(ra.cardRefundId).not.toBe(rb.cardRefundId)
    expect(rb.replay).toBe(false)
    expect(await refundsOf(a.orderId)).toHaveLength(1)
    expect(await refundsOf(b.orderId)).toHaveLength(1)
  })

  it('con un turno abierto, la devolución no le resta al turno', async () => {
    const { orderId } = await capturedOrder()
    const shift = await prisma.shift.create({
      data: { venueId: venueId!, staffId, startTime: new Date(), status: 'OPEN', startingCash: 0, totalSales: 1000 },
    })
    try {
      await expect(pedir(orderId)).resolves.toMatchObject({ status: 'RECORDED' })
      const [ledger] = await refundsOf(orderId)
      expect(ledger.shiftId).toBeNull()
      const after = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })
      expect(after.totalSales.toFixed(2)).toBe('1000.00')
    } finally {
      await prisma.shift.update({ where: { id: shift.id }, data: { status: 'CLOSED', endTime: new Date() } })
    }
  })

  it('capturar en la cuenta A, cambiar el comercio a la cuenta B y devolver → sale de A', async () => {
    const { orderId } = await capturedOrder()
    await prisma.ecommerceMerchant.update({
      where: { id: merchantId },
      data: { providerCredentials: { connectAccountId: 'acct_itest_B' } },
    })
    try {
      await expect(pedir(orderId)).resolves.toMatchObject({ status: 'RECORDED' })
      expect(refundSpy.mock.calls[0][0].providerCredentials).toEqual({ connectAccountId: 'acct_itest_A' })
      expect(feeSpy.mock.calls[0][0].providerCredentials).toEqual({ connectAccountId: 'acct_itest_A' })
    } finally {
      await prisma.ecommerceMerchant.update({
        where: { id: merchantId },
        data: { providerCredentials: { connectAccountId: 'acct_itest_A' } },
      })
    }
  })

  it('el aviso refund.failed (endpoint Connect) relee Stripe y deja la devolución REVERSED con su reversa; el REFUND intacto', async () => {
    const { orderId, paymentId } = await capturedOrder()
    const r = await pedir(orderId)
    const row = await prisma.onlineOrderCardRefund.findUniqueOrThrow({ where: { id: r.cardRefundId } })
    getRefundSpy.mockResolvedValue({
      refundId: row.stripeRefundId,
      status: 'FAILED',
      amountCents: 25_000,
      failureReason: 'lost_or_stolen_card',
    })
    await processStripeConnectWebhookEvent({
      id: `evt_itest_cr_${RUN}_1`,
      type: 'refund.failed',
      account: 'acct_itest_A',
      livemode: false,
      data: { id: row.stripeRefundId, object: 'refund', metadata: { type: 'online_order_refund', cardRefundId: row.id, orderId, venueId } },
    })
    expect((await prisma.onlineOrderCardRefund.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('REVERSED')
    const rev = await prisma.onlineOrderCardRefundReversal.findUniqueOrThrow({ where: { cardRefundId: row.id } })
    expect(rev).toMatchObject({ amountCents: 25_000, feeCents: 290, failureReason: 'lost_or_stolen_card', resolvedAt: null })
    const [ledger] = await refundsOf(orderId)
    expect(ledger.amount.toFixed(2)).toBe('-250.00')
    expect(ledger.status).toBe('COMPLETED')
    const original = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })
    expect((original.processorData as any).refundReversals).toEqual([
      expect.objectContaining({ cardRefundId: row.id, amountCents: 25_000 }),
    ])
    expect(await prisma.moneyAnomaly.count({ where: { stripeEventId: `oocr:REVERSED:${row.stripeRefundId}` } })).toBe(1)
  })

  it('r2 R1: un pedido rechazado cuya tarjeta el negocio ya había cobrado a mano en Stripe se devuelve a la tarjeta desde el panel', async () => {
    const { orderId, charge } = await authorizedOrder()
    const voidSpy = jest.spyOn(StripeConnectProvider.prototype, 'voidAuthorization').mockImplementation(async () => {
      throw Object.assign(new Error('This PaymentIntent could not be canceled because it has a status of succeeded.'), {
        type: 'StripeInvalidRequestError',
        code: 'payment_intent_unexpected_state',
        statusCode: 400,
      })
    })
    try {
      authSpy.mockResolvedValueOnce({
        sessionStatus: null,
        paymentIntentId: charge.paymentIntentId,
        piStatus: 'succeeded',
        amountCapturableCents: 0,
        amountReceivedCents: 25_000,
        captureBefore: null,
        card: { brand: 'visa', last4: '4242', funding: 'credit' },
        paymentMethodType: 'card',
        applicationFeeCents: 0, // Codex r3 #3: el dueño capturó en su Stripe: sin comisión de la plataforma
      })
      await expect(rejectOnlineOrder({ venueId: venueId!, orderId, staffId: null, reason: 'OTHER' })).resolves.toMatchObject({
        outcome: 'OK',
        status: 'REJECTED',
      })
    } finally {
      voidSpy.mockRestore()
    }
    expect(await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: charge.id } })).toMatchObject({ status: 'CAPTURED' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')

    // Codex r3 #3: el cobro se anota con la comisión que Stripe sí cobró (ninguna), no con la congelada del borrador.
    const [cobro] = await prisma.payment.findMany({ where: { orderId, type: 'REGULAR' }, take: 2 })
    expect(cobro.feeAmount.toFixed(2)).toBe('0.00')
    expect(cobro.netAmount.toFixed(2)).toBe('250.00')

    // Codex r3 #1: la venta cancelada no se suma al reporte, así que su devolución tampoco se resta (antes: ventas netas −$250).
    const rango = { startDate: new Date(Date.now() - 86_400_000).toISOString(), endDate: new Date(Date.now() + 86_400_000).toISOString() }
    const reporte = async () => {
      const resumen = (await getSalesSummary(venueId!, { ...rango, reportType: 'summary' })).summary
      const porDia = (await getSalesSummary(venueId!, { ...rango, reportType: 'days' })).byPeriod ?? []
      return {
        refunds: resumen.refunds,
        netSales: resumen.netSales,
        refundsPorDia: porDia.reduce((t, p) => t + Number(p.metrics?.refunds ?? 0), 0),
      }
    }
    const antes = await reporte()
    const saldoAntes = await getAvailableBalance(venueId!)
    const filtrado = async () => ({
      resumen: (await getSalesSummary(venueId!, { ...rango, reportType: 'summary', paymentMethod: 'CARD' })).summary.refunds,
      porDia: ((await getSalesSummary(venueId!, { ...rango, reportType: 'days', paymentMethod: 'CARD' })).byPeriod ?? []).reduce(
        (t, p) => t + Number(p.metrics?.refunds ?? 0),
        0,
      ),
    })
    const filtradoAntes = await filtrado()

    const r = await pedir(orderId)
    expect(r).toMatchObject({ status: 'RECORDED', replay: false })
    const [ledger] = await refundsOf(orderId)
    expect(ledger.amount.toFixed(2)).toBe('-250.00')
    // Codex r3 #2: «Disponible» no baja por dinero que nunca estuvo ahí; lo cobrado y lo devuelto se anulan en «Pendiente».
    const saldoDespues = await getAvailableBalance(venueId!)
    expect(saldoDespues.availableNow).toBeCloseTo(saldoAntes.availableNow, 2)
    expect(saldoDespues.pendingSettlement).toBeCloseTo(saldoAntes.pendingSettlement - 250, 2)
    expect(refundSpy).toHaveBeenCalledTimes(1)
    expect(refundSpy.mock.calls[0][1]).toMatchObject({ refundApplicationFee: false })
    expect(await reporte()).toEqual(antes)
    // Codex r4 H5: la vista filtrada por «Tarjeta» es de movimientos: la devolución que sí salió se ve (el arreglo #1 sólo aplica a
    // las ventas netas, que bajo filtro no se calculan).
    expect(await filtrado()).toEqual(mas(filtradoAntes, 250))
    expect(await prisma.onlineOrderCardRefund.findUniqueOrThrow({ where: { id: r.cardRefundId } })).toMatchObject({ feeRefundedCents: 0 })
  })

  it('Codex r1 C2: un refund.failed de OTRA cuenta (o de otro modo) con nuestra metadata → anomalía, sin releer Stripe ni escribir', async () => {
    const { orderId } = await capturedOrder()
    const r = await pedir(orderId)
    const row = await prisma.onlineOrderCardRefund.findUniqueOrThrow({ where: { id: r.cardRefundId } })
    expect(row.status).toBe('RECORDED')
    getRefundSpy.mockClear()
    const data = {
      id: row.stripeRefundId,
      object: 'refund',
      metadata: { type: 'online_order_refund', cardRefundId: row.id, orderId, venueId },
    }
    await processStripeConnectWebhookEvent({
      id: `evt_itest_cr_${RUN}_f1`,
      type: 'refund.failed',
      account: 'acct_otro',
      livemode: false,
      data,
    })
    await processStripeConnectWebhookEvent({
      id: `evt_itest_cr_${RUN}_f2`,
      type: 'refund.failed',
      account: 'acct_itest_A',
      livemode: true,
      data,
    })
    expect(getRefundSpy).not.toHaveBeenCalled()
    expect((await prisma.onlineOrderCardRefund.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('RECORDED')
    expect(
      await prisma.moneyAnomaly.count({
        where: {
          category: 'ONLINE_ORDER_STRIPE_EVENT_FOREIGN',
          stripeEventId: { in: [`evt_itest_cr_${RUN}_f1`, `evt_itest_cr_${RUN}_f2`] },
        },
      }),
    ).toBe(2)
  })

  it('«Devolver por otro medio» en efectivo: sin caja → 409 y nada escrito; con caja abierta → RESOLVED y un PAY_OUT; repetir no escribe otro', async () => {
    const { orderId } = await capturedOrder()
    const r = await pedir(orderId)
    getRefundSpy.mockResolvedValue({ refundId: 'x', status: 'FAILED', amountCents: 25_000, failureReason: null })
    await expect(advanceCardRefund(r.cardRefundId)).resolves.toBe('REVERSED')
    const resolver = () =>
      resolveReversedCardRefund({ venueId: venueId!, orderId, cardRefundId: r.cardRefundId, method: 'CASH', staffId, note: null })

    await expect(resolver()).rejects.toMatchObject({ statusCode: 409, code: 'CASH_DRAWER_NOT_OPEN' })
    expect((await prisma.onlineOrderCardRefund.findUniqueOrThrow({ where: { id: r.cardRefundId } })).status).toBe('REVERSED')
    expect(await prisma.cashDrawerEvent.count({ where: { venueId, localId: `oocr-payout:${r.cardRefundId}` } })).toBe(0)

    const session = await prisma.cashDrawerSession.create({
      data: {
        venueId: venueId!,
        openedByStaffId: staffId,
        openedByName: 'Gerente',
        startingAmount: new Prisma.Decimal(500),
        status: 'OPEN',
      },
    })
    await expect(resolver()).resolves.toEqual({ status: 'RESOLVED', replay: false })
    await expect(resolver()).resolves.toEqual({ status: 'RESOLVED', replay: true })
    const events = await prisma.cashDrawerEvent.findMany({ where: { venueId, localId: `oocr-payout:${r.cardRefundId}` }, take: 5 })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ sessionId: session.id, type: 'PAY_OUT' })
    expect(events[0].amount.toFixed(2)).toBe('250.00')
    const rev = await prisma.onlineOrderCardRefundReversal.findUniqueOrThrow({ where: { cardRefundId: r.cardRefundId } })
    expect(rev).toMatchObject({ resolvedMethod: 'CASH', resolvedByStaffId: staffId, cashDrawerEventId: events[0].id })
    await prisma.cashDrawerSession.update({ where: { id: session.id }, data: { status: 'CLOSED', closedAt: new Date() } })
  })
})
