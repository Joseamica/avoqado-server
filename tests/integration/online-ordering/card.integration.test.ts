// tests/integration/online-ordering/card.integration.test.ts
/**
 * Integration (REAL DB) — pedir con tarjeta (fase 2, tarea 4): borrador `OnlineOrderCharge` + sesión de Stripe (espiada).
 * Lo que los simulacros no prueban: que no nace ninguna cuenta, la llave compartida con pagar al recoger bajo el MISMO candado de
 * Postgres (en serie y a la vez), los topes con borradores reales y dos reintentos simultáneos que terminan en una sola sesión.
 */
import { OnlineOrderChargeStatus, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { StripeConnectProvider } from '@/services/payments/providers/stripe-connect.provider'
import { confirmCardAuthorization } from '@/services/online-ordering/card/confirm.service'
import { releaseCharge } from '@/services/online-ordering/card/release.service'
import { reconcileCardCharges } from '@/services/online-ordering/card/reconcile.service'
import { CARD_RECONCILE_BATCH } from '@/services/online-ordering/constants'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  acceptOnlineOrder,
  cancelOnlineOrderByCustomer,
  expireOnlineOrder,
  markOnlineOrderDelivered,
  rejectOnlineOrder,
} from '@/services/online-ordering/transitions.service'
import { processStripeConnectWebhookEvent } from '@/services/payments/reservation-deposit-webhook.service'
import { createCardOnlineDraft } from '@/services/online-ordering/card/draft.service'
import { clearPublicMenuCache } from '@/services/online-ordering/menu.service'
import { abandonCardPayment, createOnlineOrder, getTrackingByToken, writeOnlineOrderInTx } from '@/services/online-ordering/order.service'
import { __resetPresenceDebounceForTests, touchInboxPoll } from '@/services/online-ordering/presence.service'
import { updateSettings } from '@/services/online-ordering/settings.service'
import { listOrders as listMobileOrders } from '@/services/mobile/order.mobile.service'
import { moveOrderToTable } from '@/services/tpv/table.tpv.service'

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
// Comisión determinista: 1 % + IVA 16 %.
jest.mock('@/services/superadmin/platformSettings.service', () => ({
  ...jest.requireActual('@/services/superadmin/platformSettings.service'),
  getVatRateBps: jest.fn(async () => 1600),
}))

const RUN = Date.now()
const MIN = 60_000

describe('Pedidos en línea con tarjeta — borrador + sesión (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let merchantId: string
  let productId: string
  let customerId: string
  let seq = 0
  let phoneSeq = 0
  const nextKey = () => `card-${RUN}-${++seq}-`.padEnd(40, 'x')
  const nextPhone = () => `+5255${40_000_000 + (((RUN % 100_000) * 100 + ++phoneSeq) % 60_000_000)}`
  const ITEMS = () => [{ productId, quantity: 1 }]
  const PUEDE_CREAR = { assertCanCreate: async () => {} }

  /** Stripe espiado con su idempotencia: la misma clave devuelve la misma sesión. */
  const sessions = new Map<string, { id: string; url: string; expiresAt: Date }>()
  let spy: jest.SpyInstance
  let authSpy: jest.SpyInstance
  let voidSpy: jest.SpyInstance
  let captureSpy: jest.SpyInstance
  let expireSpy: jest.SpyInstance
  let piSeq = 0
  /** Lo que `getAuthorization` contesta con la tarjeta apartada por `cents`. */
  const authorized = (cents = 25_000) => ({
    sessionStatus: 'complete',
    paymentIntentId: `pi_itest_${RUN}_${++piSeq}`,
    piStatus: 'requires_capture',
    amountCapturableCents: cents,
    amountReceivedCents: 0,
    captureBefore: new Date(Date.now() + 7 * 24 * 60 * MIN),
    card: { brand: 'visa', last4: '4242', funding: 'credit' },
    paymentMethodType: 'card',
  })
  /** Lo que `capture` contesta cuando cobró lo pedido. */
  const capturedState = (p: { paymentIntentId: string; amountCents: number }, funding = 'credit') => ({
    sessionStatus: null,
    paymentIntentId: p.paymentIntentId,
    piStatus: 'succeeded',
    amountCapturableCents: 0,
    amountReceivedCents: p.amountCents,
    captureBefore: null,
    card: { brand: 'visa', last4: '4242', funding },
    paymentMethodType: 'card',
  })
  const stripeOk = () =>
    spy.mockImplementation(async (_m: any, p: any) => {
      if (!sessions.has(p.idempotencyKey)) {
        const id = `cs_itest_${RUN}_${sessions.size + 1}`
        sessions.set(p.idempotencyKey, { id, url: `https://checkout.stripe.test/${id}`, expiresAt: p.expiresAt })
      }
      return sessions.get(p.idempotencyKey)!
    })

  const draft = (o: { key?: string; phone?: string; expectedTotal?: string; items?: any[]; now?: Date; opts?: any } = {}) =>
    createCardOnlineDraft(
      {
        venueId: venueId!,
        venueSlug: `itest-card-${RUN}`,
        idempotencyKey: o.key ?? nextKey(),
        items: o.items ?? ITEMS(),
        expectedTotal: o.expectedTotal ?? '250.00',
        customer: { name: 'Ana ITEST', phone: o.phone ?? nextPhone(), email: 'ana@test.com' },
        note: null,
        whatsappConsent: false,
        now: o.now,
      },
      o.opts ?? PUEDE_CREAR,
    )
  const pickup = (key: string, phone = nextPhone()) =>
    createOnlineOrder(
      {
        venueId: venueId!,
        idempotencyKey: key,
        items: ITEMS(),
        paymentMode: 'PAY_AT_PICKUP',
        expectedTotal: '250.00',
        customer: { name: 'Ana ITEST', phone },
        customerId,
        verifiedPhone: phone,
        note: null,
        whatsappConsent: false,
      },
      PUEDE_CREAR,
    )
  const chargeOf = (key: string) =>
    prisma.onlineOrderCharge.findUniqueOrThrow({ where: { venueId_idempotencyKey: { venueId: venueId!, idempotencyKey: key } } })
  const beat = async () => {
    __resetPresenceDebounceForTests()
    await touchInboxPoll(venueId!)
  }
  /** Borradores vigentes de otras pruebas no deben topar a ésta: se vencen al empezar cada caso. */
  const expireLiveDrafts = () =>
    prisma.onlineOrderCharge.updateMany({ where: { venueId: venueId! }, data: { checkoutExpiresAt: new Date(Date.now() - MIN) } })

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Tarjeta Org', slug: `itest-card-org-${RUN}`, email: `itest-card-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Tarjeta Venue',
        slug: `itest-card-${RUN}`,
        organizationId: org.id,
        timezone: 'America/Mexico_City',
        address: 'Av. Coyoacán 123',
        city: 'CDMX',
        state: 'CDMX',
        zipCode: '04000',
        phone: '5512345678',
      },
    })
    venueId = venue.id
    await prisma.privacyNoticeVersion.create({ data: { venueId, content: 'Aviso ITEST', contentHash: `itest-card-${RUN}` } })
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Flautas', slug: `flautas-card-${RUN}` } })
    productId = (
      await prisma.product.create({
        data: { venueId, name: 'Orden grande', sku: `CARD-${RUN}`, price: 250, categoryId: category.id, availableOnline: true },
      })
    ).id
    customerId = (await prisma.customer.create({ data: { venueId, phone: nextPhone(), firstName: 'Ana', provider: 'PHONE' } })).id

    const provider = await prisma.paymentProvider.upsert({
      where: { code: 'STRIPE_CONNECT' },
      update: {},
      create: { code: 'STRIPE_CONNECT', name: 'Stripe Connect', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
    merchantId = (
      await prisma.ecommerceMerchant.create({
        data: {
          venueId,
          businessName: 'ITEST Tarjeta',
          contactEmail: `itest-card-merchant-${RUN}@test.com`,
          publicKey: `pk_test_itest_${RUN}`,
          secretKeyHash: `itest-hash-${RUN}`,
          providerId: provider.id,
          providerCredentials: { connectAccountId: 'acct_itest_1' },
          chargesEnabled: true,
          platformFeeBps: 100,
          sandboxMode: true,
        },
      })
    ).id

    await updateSettings(venueId, { enabled: true, minOrderAmount: 0, defaultPrepMinutes: 15 }, null)
    await prisma.onlineOrderingSettings.update({ where: { venueId }, data: { acceptsCardOnline: true } })
    clearPublicMenuCache()
    spy = jest.spyOn(StripeConnectProvider.prototype, 'createAuthorizationCheckout')
    authSpy = jest.spyOn(StripeConnectProvider.prototype, 'getAuthorization')
    voidSpy = jest.spyOn(StripeConnectProvider.prototype, 'voidAuthorization')
    captureSpy = jest.spyOn(StripeConnectProvider.prototype, 'capture')
    expireSpy = jest.spyOn(StripeConnectProvider.prototype, 'expireAuthorizationCheckout')
  })

  beforeEach(async () => {
    spy.mockReset()
    stripeOk()
    authSpy.mockReset()
    voidSpy.mockReset()
    voidSpy.mockImplementation(async (_m: any, p: any) => ({ ...authorized(), paymentIntentId: p.paymentIntentId, piStatus: 'canceled' }))
    captureSpy.mockReset()
    captureSpy.mockImplementation(async (_m: any, p: any) => capturedState(p))
    expireSpy.mockReset()
    expireSpy.mockResolvedValue(undefined)
    delete process.env.STRIPE_MIN_CHARGE_MXN_CENTS
    await expireLiveDrafts()
    await beat()
  })

  afterAll(async () => {
    spy?.mockRestore()
    authSpy?.mockRestore()
    voidSpy?.mockRestore()
    captureSpy?.mockRestore()
    expireSpy?.mockRestore()
    // Limpieza acotada: sin venueId NO se borra nada (una limpieza sin filtro vaciaría tablas enteras).
    if (!venueId) return
    const v = { venueId }
    await prisma.idempotencyRequest.deleteMany({ where: { organizationId: `venue:${venueId}` } })
    await prisma.moneyAnomaly.deleteMany({
      where: {
        category: { in: ['ONLINE_ORDER_STRIPE_EVENT_FOREIGN', 'ONLINE_ORDER_CARD_CAPTURED_OUTSIDE'] },
        expectedState: { path: ['venueId'], equals: venueId },
      },
    })
    await prisma.activityLog.deleteMany({ where: v })
    await prisma.paymentEffect.deleteMany({ where: v })
    await prisma.inventoryPosting.deleteMany({ where: v })
    await prisma.venueTransaction.deleteMany({ where: v })
    await prisma.payment.deleteMany({ where: v })
    await prisma.onlineOrderCharge.deleteMany({ where: v }) // antes del comercio (Restrict)
    await prisma.onlineOrder.deleteMany({ where: v })
    await prisma.order.deleteMany({ where: v })
    await prisma.ecommerceMerchant.deleteMany({ where: v })
    await prisma.product.deleteMany({ where: v })
    await prisma.menuCategory.deleteMany({ where: v })
    await prisma.customer.deleteMany({ where: v })
    await prisma.onlineOrderingSettings.deleteMany({ where: v })
    await prisma.privacyNoticeVersion.deleteMany({ where: v })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  it('crea el borrador y la sesión: no hay Order ni OnlineOrder todavía', async () => {
    const key = nextKey()
    const now = new Date()
    const r = await draft({ key, now })

    expect(r).toMatchObject({ status: 'AWAITING_PAYMENT', total: '250.00', replay: false })
    expect(await prisma.order.count({ where: { venueId: venueId! } })).toBe(0)
    expect(await prisma.onlineOrder.count({ where: { venueId: venueId! } })).toBe(0)
    const c = await chargeOf(key)
    expect(c).toMatchObject({
      status: OnlineOrderChargeStatus.PENDING_AUTH,
      trackingToken: r.trackingToken,
      ecommerceMerchantId: merchantId,
      platformFeeBps: 100,
      // calculateApplicationFeeWithVAT(25000, 100, 1600) = 290
      applicationFeeCents: 290,
      checkoutAttempt: 1,
      checkoutSessionId: expect.stringMatching(/^cs_itest_/),
      checkoutUrl: r.checkoutUrl,
      merchantSnapshot: { connectAccountId: 'acct_itest_1', sandboxMode: true, providerCode: 'STRIPE_CONNECT' },
    })
    expect(new Prisma.Decimal(c.amount).toFixed(2)).toBe('250.00')
    // Codex r2 #4: 35 min (5 de margen sobre el mínimo de 30 de Stripe).
    expect(c.checkoutExpiresAt.getTime()).toBe(now.getTime() + 35 * MIN)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][1]).toMatchObject({
      amountCents: 25000,
      idempotencyKey: `online-order-charge:${c.id}:checkout:1`,
      expiresAt: c.checkoutExpiresAt,
      metadata: { type: 'online_order', chargeId: c.id, venueId },
    })
  })

  it('repetir con la misma llave y la misma solicitud devuelve el mismo trackingToken y no crea otra sesión', async () => {
    const key = nextKey()
    const phone = nextPhone()
    const first = await draft({ key, phone })
    const again = await draft({ key, phone })
    expect(again).toEqual({ ...first, replay: true })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(await prisma.onlineOrderCharge.count({ where: { venueId: venueId!, idempotencyKey: key } })).toBe(1)
  })

  it('S7 (clientes, Codex plan r2 #5): repetir con la página de pago ya vencida no manda checkoutUrl; vigente, la misma', async () => {
    const key = nextKey()
    const phone = nextPhone()
    const first = await draft({ key, phone })
    const { checkoutExpiresAt } = await chargeOf(key)
    await expect(draft({ key, phone, now: new Date(checkoutExpiresAt.getTime() - 1) })).resolves.toEqual({ ...first, replay: true })
    await expect(draft({ key, phone, now: checkoutExpiresAt })).resolves.toEqual({
      ...first,
      checkoutUrl: '',
      status: 'AWAITING_PAYMENT',
      replay: true,
    })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('S8: sin pagar al recoger y con la tarjeta disponible, pagar al recoger pide recargar para pagar con tarjeta (mismo código)', async () => {
    await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { acceptsPayAtPickup: false } })
    try {
      await expect(pickup(nextKey())).rejects.toMatchObject({
        statusCode: 400,
        code: 'PAYMENT_MODE_NOT_ACCEPTED',
        message: 'Este negocio ahora cobra con tarjeta en línea. Recarga la página para pagar con tarjeta.',
      })
      await prisma.ecommerceMerchant.update({ where: { id: merchantId }, data: { chargesEnabled: false } })
      await expect(pickup(nextKey())).rejects.toMatchObject({
        code: 'PAYMENT_MODE_NOT_ACCEPTED',
        message: 'Este negocio no acepta pagar al recoger.',
      })
    } finally {
      await prisma.ecommerceMerchant.update({ where: { id: merchantId }, data: { chargesEnabled: true } })
      await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { acceptsPayAtPickup: true } })
    }
  })

  it('misma llave con otro carrito → 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    const key = nextKey()
    const phone = nextPhone()
    await draft({ key, phone })
    await expect(draft({ key, phone, items: [{ productId, quantity: 2 }], expectedTotal: '500.00' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_CONFLICT',
    })
  })

  it('switch apagado → 400 CARD_PAYMENT_NOT_ACCEPTED y sin comercio Stripe cobrable → 400 CARD_PAYMENT_NOT_ACCEPTED', async () => {
    await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { acceptsCardOnline: false } })
    try {
      await expect(draft()).rejects.toMatchObject({ statusCode: 400, code: 'CARD_PAYMENT_NOT_ACCEPTED' })
    } finally {
      await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { acceptsCardOnline: true } })
    }
    await prisma.ecommerceMerchant.update({ where: { id: merchantId }, data: { chargesEnabled: false } })
    try {
      await expect(draft()).rejects.toMatchObject({ statusCode: 400, code: 'CARD_PAYMENT_NOT_ACCEPTED' })
    } finally {
      await prisma.ecommerceMerchant.update({ where: { id: merchantId }, data: { chargesEnabled: true } })
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('total fuera de rango → 400 CARD_AMOUNT_OUT_OF_RANGE (con STRIPE_MIN_CHARGE_MXN_CENTS=100000), sin borrador', async () => {
    process.env.STRIPE_MIN_CHARGE_MXN_CENTS = '100000'
    const key = nextKey()
    await expect(draft({ key })).rejects.toMatchObject({ statusCode: 400, code: 'CARD_AMOUNT_OUT_OF_RANGE' })
    expect(await prisma.onlineOrderCharge.count({ where: { venueId: venueId!, idempotencyKey: key } })).toBe(0)
  })

  it('el cuarto borrador vivo del mismo teléfono → 409 TOO_MANY_PENDING_ORDERS; un borrador vencido no cuenta', async () => {
    const phone = nextPhone()
    const keys = [nextKey(), nextKey(), nextKey()]
    for (const key of keys) await draft({ key, phone })
    await expect(draft({ phone })).rejects.toMatchObject({ statusCode: 409, code: 'TOO_MANY_PENDING_ORDERS' })

    await prisma.onlineOrderCharge.update({
      where: { venueId_idempotencyKey: { venueId: venueId!, idempotencyKey: keys[0] } },
      data: { checkoutExpiresAt: new Date(Date.now() - MIN) },
    })
    await expect(draft({ phone })).resolves.toMatchObject({ replay: false })
  })

  it('pagar al recoger con 3 borradores vivos del mismo teléfono → 409 TOO_MANY_PENDING_ORDERS; un borrador vencido no cuenta', async () => {
    const phone = nextPhone()
    const keys = [nextKey(), nextKey(), nextKey()]
    for (const key of keys) await draft({ key, phone })
    await expect(pickup(nextKey(), phone)).rejects.toMatchObject({ statusCode: 409, code: 'TOO_MANY_PENDING_ORDERS' })

    await prisma.onlineOrderCharge.update({
      where: { venueId_idempotencyKey: { venueId: venueId!, idempotencyKey: keys[0] } },
      data: { checkoutExpiresAt: new Date(Date.now() - MIN) },
    })
    await expect(pickup(nextKey(), phone)).resolves.toMatchObject({ status: 'PENDING_ACCEPTANCE', replay: false })
  })

  it('Codex r1 #3: si Stripe falla, el cargo SIGUE PENDING_AUTH con lastError (502); el reintento repite clave y parámetros', async () => {
    const key = nextKey()
    const phone = nextPhone()
    spy.mockRejectedValueOnce(new Error('Stripe no responde'))
    await expect(draft({ key, phone })).rejects.toMatchObject({ statusCode: 502, code: 'CARD_PROVIDER_UNAVAILABLE' })
    const failed = await chargeOf(key)
    expect(failed).toMatchObject({ status: 'PENDING_AUTH', lastError: 'Stripe no responde', checkoutSessionId: null, attempts: 1 })

    const r = await draft({ key, phone })
    expect(r).toMatchObject({ replay: true, trackingToken: failed.trackingToken, checkoutUrl: expect.stringContaining('cs_itest_') })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[1][1]).toEqual(spy.mock.calls[0][1])
    expect(spy.mock.calls[1][1].expiresAt).toEqual(failed.checkoutExpiresAt)
    expect(await chargeOf(key)).toMatchObject({ status: 'PENDING_AUTH', lastError: null, checkoutUrl: r.checkoutUrl })
  })

  it('dos reintentos simultáneos sin checkoutUrl terminan con una sola sesión y ninguno marca ABANDONED', async () => {
    const key = nextKey()
    const phone = nextPhone()
    spy.mockRejectedValueOnce(new Error('Stripe no responde'))
    await expect(draft({ key, phone })).rejects.toMatchObject({ code: 'CARD_PROVIDER_UNAVAILABLE' })

    const [a, b] = await Promise.all([draft({ key, phone }), draft({ key, phone })])
    expect(a.checkoutUrl).toBe(b.checkoutUrl)
    const c = await chargeOf(key)
    expect(c.status).toBe('PENDING_AUTH')
    expect(c.checkoutUrl).toBe(a.checkoutUrl)
    expect(new Set(spy.mock.calls.map(([, p]) => p.idempotencyKey))).toEqual(new Set([`online-order-charge:${c.id}:checkout:1`]))
  })

  it('Codex r2 #4: con menos de 31 min, primero repite el intento N; sólo si Stripe rechaza expires_at sube a N+1', async () => {
    const key = nextKey()
    const phone = nextPhone()
    spy.mockRejectedValueOnce(new Error('Stripe no responde'))
    await expect(draft({ key, phone })).rejects.toMatchObject({ code: 'CARD_PROVIDER_UNAVAILABLE' })
    const before = await chargeOf(key)

    // Quedan 20 min del vencimiento guardado: Stripe nunca ejecutó el intento 1 y ya no acepta su expires_at.
    const now = new Date(before.checkoutExpiresAt.getTime() - 20 * MIN)
    spy.mockImplementationOnce(async () => {
      throw Object.assign(new Error('expires_at must be at least 30 minutes in the future'), {
        type: 'StripeInvalidRequestError',
        param: 'expires_at',
      })
    })
    const r = await draft({ key, phone, now })

    expect(r).toMatchObject({ replay: true, checkoutUrl: expect.stringContaining('cs_itest_') })
    const keysUsed = spy.mock.calls.map(([, p]) => p.idempotencyKey)
    expect(keysUsed).toEqual([
      `online-order-charge:${before.id}:checkout:1`,
      `online-order-charge:${before.id}:checkout:1`,
      `online-order-charge:${before.id}:checkout:2`,
    ])
    const after = await chargeOf(key)
    expect(after.checkoutAttempt).toBe(2)
    expect(after.checkoutExpiresAt.getTime()).toBe(now.getTime() + 35 * MIN)
    expect(spy.mock.calls[2][1].expiresAt).toEqual(after.checkoutExpiresAt)
  })

  it('Codex r2 #5: la llave de un pedido al recoger → 409 antes de Checkout; y al revés; y a la vez gana uno', async () => {
    const k1 = nextKey()
    await pickup(k1)
    await expect(draft({ key: k1 })).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' })
    expect(spy).not.toHaveBeenCalled()

    const k2 = nextKey()
    await draft({ key: k2 })
    await expect(pickup(k2)).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' })
    expect(await prisma.order.count({ where: { venueId: venueId!, externalId: `web:${k2}` } })).toBe(0)

    const k3 = nextKey()
    const results = await Promise.allSettled([pickup(k3), draft({ key: k3 })])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'IDEMPOTENCY_KEY_CONFLICT' } })
    const orders = await prisma.order.count({ where: { venueId: venueId!, externalId: `web:${k3}` } })
    const charges = await prisma.onlineOrderCharge.count({ where: { venueId: venueId!, idempotencyKey: k3 } })
    expect(orders + charges).toBe(1)
  })

  it('Codex r3 #1: autorizar → se crea la cuenta → otra copia del POST original → 200 replay con el mismo token, no 409', async () => {
    const key = nextKey()
    const phone = nextPhone()
    const first = await draft({ key, phone })
    // La tarea 5 hace esto al confirmar la autorización; aquí se simula con sus mismas piezas.
    const c = await chargeOf(key)
    await prisma.$transaction(async tx => {
      const req = c.request as any
      const created = await writeOnlineOrderInTx(tx, {
        venueId: venueId!,
        externalId: `web:${key}`,
        orderNumber: `WC${seq}`,
        quote: req.quote,
        customer: req.customer,
        customerId: null,
        note: null,
        paymentMode: 'CARD_ONLINE',
        trackingToken: c.trackingToken,
        requestHash: c.requestHash,
        acceptDeadlineAt: new Date(Date.now() + 10 * MIN),
        whatsappConsent: false,
      })
      await tx.onlineOrderCharge.update({ where: { id: c.id }, data: { status: 'AUTHORIZED', onlineOrderId: created.onlineOrderId } })
    })

    // Tarea 5: la repetición dice el estado real del pedido (el mismo que el seguimiento), con el mismo token.
    await expect(draft({ key, phone })).resolves.toEqual({ ...first, status: 'PENDING_ACCEPTANCE', replay: true })
  })

  it('Codex r4 #8: con la respuesta perdida, cerrar la tienda, apagar la tarjeta o cambiar el precio no convierte la repetición en rechazo', async () => {
    const key = nextKey()
    const phone = nextPhone()
    const first = await draft({ key, phone })
    await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { acceptsCardOnline: false, manualPause: true } })
    await prisma.product.update({ where: { id: productId }, data: { price: 260 } })
    clearPublicMenuCache()
    try {
      await expect(
        draft({ key, phone, opts: { assertCanCreate: async () => Promise.reject(new Error('plan vencido')) } }),
      ).resolves.toEqual({ ...first, replay: true })
    } finally {
      await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { acceptsCardOnline: true, manualPause: false } })
      await prisma.product.update({ where: { id: productId }, data: { price: 250 } })
      clearPublicMenuCache()
    }
  })

  it('PRICE_CHANGED y CART_INVALID se comportan igual que pagar al recoger', async () => {
    await expect(draft({ expectedTotal: '249.00' })).rejects.toMatchObject({ statusCode: 409, code: 'PRICE_CHANGED' })
    await expect(draft({ items: [{ productId: 'c000000000000000000000000', quantity: 1 }] })).rejects.toMatchObject({
      statusCode: 400,
      code: 'CART_INVALID',
    })
    expect(spy).not.toHaveBeenCalled()
  })

  // ── Tarea 5: confirmar la autorización (borrador → pedido) ──
  it('confirmar crea UNA cuenta con los precios del borrador aunque el menú cambió después', async () => {
    const key = nextKey()
    await draft({ key })
    const c = await chargeOf(key)
    await prisma.product.update({ where: { id: productId }, data: { price: 300 } })
    clearPublicMenuCache()
    try {
      const auth = authorized()
      authSpy.mockResolvedValue(auth)
      const now = new Date()
      await expect(confirmCardAuthorization(c.id, now)).resolves.toBe('CREATED')
      expect(authSpy.mock.calls[0][1]).toEqual({ checkoutSessionId: c.checkoutSessionId })

      const order = await prisma.order.findUniqueOrThrow({
        where: { venueId_externalId: { venueId: venueId!, externalId: `web:${key}` } },
        include: { onlineOrder: true, items: true },
      })
      expect(order.total.toFixed(2)).toBe('250.00')
      expect(order.items[0].unitPrice.toFixed(2)).toBe('250.00')
      expect(order.paymentStatus).toBe('PENDING')
      expect(order.customerId).toBeNull()
      // Codex r1 C1: se cobra en el momento (tarjeta), nunca es fiado aunque después se le ligue un cliente.
      expect(order.payLater).toBe(false)
      expect(order.onlineOrder).toMatchObject({ paymentMode: 'CARD_ONLINE', status: 'PENDING_ACCEPTANCE', trackingToken: c.trackingToken })
      expect(order.onlineOrder!.acceptDeadlineAt.getTime()).toBe(now.getTime() + 10 * MIN)
      expect(await chargeOf(key)).toMatchObject({
        status: 'AUTHORIZED',
        paymentIntentId: auth.paymentIntentId,
        authorizedAt: now,
        captureBefore: auth.captureBefore,
        onlineOrderId: order.onlineOrder!.id,
      })
      // Otra vez (aviso repetido, seguimiento, conciliador): no hace nada.
      await expect(confirmCardAuthorization(c.id)).resolves.toBe('ALREADY')
    } finally {
      await prisma.product.update({ where: { id: productId }, data: { price: 250 } })
      clearPublicMenuCache()
    }
  })

  it('confirmar dos veces en paralelo crea una sola cuenta', async () => {
    const key = nextKey()
    await draft({ key })
    const c = await chargeOf(key)
    const auth = authorized()
    authSpy.mockResolvedValue(auth)

    const outcomes = await Promise.all([confirmCardAuthorization(c.id), confirmCardAuthorization(c.id)])
    expect([...outcomes].sort()).toEqual(['ALREADY', 'CREATED'])
    expect(await prisma.order.count({ where: { venueId: venueId!, externalId: `web:${key}` } })).toBe(1)
  })

  it('r2 R2: sesión complete pero PaymentIntent canceled → ABANDONED por CAS, sin anomalía; repetir no escribe nada', async () => {
    const key = nextKey()
    await draft({ key })
    const c = await chargeOf(key)
    authSpy.mockResolvedValue({ ...authorized(), sessionStatus: 'complete', piStatus: 'canceled', amountCapturableCents: 0 })

    await expect(confirmCardAuthorization(c.id)).resolves.toBe('ABANDONED')
    const after = await chargeOf(key)
    expect(after.status).toBe('ABANDONED')
    expect(await prisma.order.count({ where: { venueId: venueId!, externalId: `web:${key}` } })).toBe(0)
    expect(await prisma.moneyAnomaly.count({ where: { stripeEventId: { contains: c.id } } })).toBe(0)
    // Otra vez (aviso repetido o seguimiento): ni Stripe ni escrituras.
    await expect(confirmCardAuthorization(c.id)).resolves.toBe('ALREADY')
    expect(authSpy).toHaveBeenCalledTimes(1)
    expect((await chargeOf(key)).updatedAt).toEqual(after.updatedAt)
  })

  it('sesión vencida sin autorizar → ABANDONED y ninguna cuenta', async () => {
    const key = nextKey()
    await draft({ key })
    const c = await chargeOf(key)
    authSpy.mockResolvedValue({
      ...authorized(),
      sessionStatus: 'expired',
      paymentIntentId: null,
      piStatus: null,
      amountCapturableCents: 0,
    })

    await expect(confirmCardAuthorization(c.id)).resolves.toBe('ABANDONED')
    expect((await chargeOf(key)).status).toBe('ABANDONED')
    expect(await prisma.order.count({ where: { venueId: venueId!, externalId: `web:${key}` } })).toBe(0)
    // Sesión abierta (el comensal sigue en la página de pago) → todavía no.
    const k2 = nextKey()
    await draft({ key: k2 })
    authSpy.mockResolvedValue({ ...authorized(), sessionStatus: 'open', paymentIntentId: null, piStatus: null, amountCapturableCents: 0 })
    await expect(confirmCardAuthorization((await chargeOf(k2)).id)).resolves.toBe('NOT_YET')
    expect((await chargeOf(k2)).status).toBe('PENDING_AUTH')
  })

  it('monto apartado distinto → RELEASED_LATE, voidAuthorization llamado, ninguna cuenta', async () => {
    const key = nextKey()
    await draft({ key })
    const c = await chargeOf(key)
    const auth = authorized(24_000)
    authSpy.mockResolvedValue(auth)

    await expect(confirmCardAuthorization(c.id)).resolves.toBe('RELEASED_LATE')
    expect(voidSpy).toHaveBeenCalledTimes(1)
    expect(voidSpy.mock.calls[0][1]).toEqual({
      paymentIntentId: auth.paymentIntentId,
      idempotencyKey: `online-order-charge:${c.id}:release`,
    })
    expect(await chargeOf(key)).toMatchObject({ status: 'RELEASED', paymentIntentId: auth.paymentIntentId, releasedAt: expect.any(Date) })
    expect(await prisma.order.count({ where: { venueId: venueId!, externalId: `web:${key}` } })).toBe(0)
    // M2: la liberación tardía también deja ONLINE_ORDER_CARD_RELEASED (sobre el cargo: no hay pedido).
    expect(releasedLogs(c.id)).toBe(1)
  })

  it('Codex r2 #5: la llave ya tiene cuenta (externalId único) → no crea nada, libera y RELEASED_LATE', async () => {
    const key = nextKey()
    await draft({ key })
    const c = await chargeOf(key)
    const req = c.request as any
    await prisma.$transaction(tx =>
      writeOnlineOrderInTx(tx, {
        venueId: venueId!,
        externalId: `web:${key}`,
        orderNumber: `WX${seq}`,
        quote: req.quote,
        customer: req.customer,
        customerId: null,
        note: null,
        paymentMode: 'PAY_AT_PICKUP',
        trackingToken: `${'z'.repeat(20)}${RUN}`.slice(0, 32),
        requestHash: 'otra',
        acceptDeadlineAt: new Date(Date.now() + 10 * MIN),
        whatsappConsent: false,
      }),
    )
    authSpy.mockResolvedValue(authorized())

    await expect(confirmCardAuthorization(c.id)).resolves.toBe('RELEASED_LATE')
    expect(voidSpy).toHaveBeenCalledTimes(1)
    expect(await chargeOf(key)).toMatchObject({ status: 'RELEASED', onlineOrderId: null })
    expect(await prisma.order.count({ where: { venueId: venueId!, externalId: `web:${key}` } })).toBe(1)
  })

  it('seguimiento de un borrador dice AWAITING_PAYMENT y no expone teléfono; tras confirmar dice PENDING_ACCEPTANCE con cardStatus AUTHORIZED', async () => {
    const key = nextKey()
    const phone = nextPhone()
    const r = await draft({ key, phone })

    const t = await getTrackingByToken(r.trackingToken)
    expect(t).toMatchObject({
      status: 'AWAITING_PAYMENT',
      paymentMode: 'CARD_ONLINE',
      cardStatus: null,
      venueId,
      total: 250,
      paid: false,
      canCancel: false,
      items: [{ name: 'Orden grande', quantity: 1, note: null, modifiers: [] }],
    })
    expect(JSON.stringify(t)).not.toContain(phone.slice(-8))
    expect(authSpy).not.toHaveBeenCalled() // borrador recién creado (< 5 s): no se pregunta a Stripe

    // Más de 5 s sin noticias: el seguimiento confirma solo (la página de regreso).
    const c = await chargeOf(key)
    await prisma.onlineOrderCharge.update({ where: { id: c.id }, data: { updatedAt: new Date(Date.now() - 10_000) } })
    authSpy.mockResolvedValue(authorized())
    const after = await getTrackingByToken(r.trackingToken)
    expect(after).toMatchObject({ status: 'PENDING_ACCEPTANCE', paymentMode: 'CARD_ONLINE', cardStatus: 'AUTHORIZED', canCancel: true })
    expect(after!.orderNumber).toMatch(/^W/)
    expect(JSON.stringify(after)).not.toContain(phone.slice(-8))

    // Un borrador abandonado ya no espera el pago.
    const k2 = nextKey()
    const r2 = await draft({ key: k2 })
    await prisma.onlineOrderCharge.update({ where: { id: (await chargeOf(k2)).id }, data: { status: 'ABANDONED' } })
    await expect(getTrackingByToken(r2.trackingToken)).resolves.toMatchObject({ status: 'PAYMENT_NOT_COMPLETED', canCancel: false })
  })

  it('fix r1: el seguimiento pregunta a Stripe a lo más una vez cada 5 s por borrador, aunque lleguen consultas a la vez', async () => {
    const key = nextKey()
    const r = await draft({ key })
    const c = await chargeOf(key)
    const stillOpen = { ...authorized(), sessionStatus: 'open', paymentIntentId: null, piStatus: null, amountCapturableCents: 0 }
    authSpy.mockResolvedValue(stillOpen)

    // Dos consultas a la vez sobre un borrador de 6 s: una sola llamada a Stripe.
    await prisma.onlineOrderCharge.update({ where: { id: c.id }, data: { updatedAt: new Date(Date.now() - 6_000) } })
    const both = await Promise.all([getTrackingByToken(r.trackingToken), getTrackingByToken(r.trackingToken)])
    expect(both.map(t => t!.status)).toEqual(['AWAITING_PAYMENT', 'AWAITING_PAYMENT'])
    expect(authSpy).toHaveBeenCalledTimes(1)

    // Otra consulta dentro de los 5 s siguientes: sin Stripe.
    await expect(getTrackingByToken(r.trackingToken)).resolves.toMatchObject({ status: 'AWAITING_PAYMENT' })
    expect(authSpy).toHaveBeenCalledTimes(1)

    // Pasados otros 5 s, la consulta que confirma muestra el pedido.
    await prisma.onlineOrderCharge.update({ where: { id: c.id }, data: { updatedAt: new Date(Date.now() - 6_000) } })
    authSpy.mockResolvedValue(authorized())
    await expect(getTrackingByToken(r.trackingToken)).resolves.toMatchObject({ status: 'PENDING_ACCEPTANCE', cardStatus: 'AUTHORIZED' })
    expect(authSpy).toHaveBeenCalledTimes(2)
  })

  // ── Tarea 6: aceptar cobra; rechazar, vencer y cancelar liberan ──
  /** Un pedido con la tarjeta apartada (borrador → autorización confirmada). */
  const authorizedOrder = async () => {
    const key = nextKey()
    const d = await draft({ key })
    const c = await chargeOf(key)
    authSpy.mockResolvedValueOnce(authorized())
    await expect(confirmCardAuthorization(c.id)).resolves.toBe('CREATED')
    const charge = await chargeOf(key)
    const oo = await prisma.onlineOrder.findUniqueOrThrow({ where: { id: charge.onlineOrderId! } })
    return { key, charge, orderId: oo.orderId, trackingToken: d.trackingToken }
  }
  const accept = (orderId: string, now?: Date) => acceptOnlineOrder({ venueId: venueId!, orderId, staffId: null, now })
  const reject = (orderId: string) => rejectOnlineOrder({ venueId: venueId!, orderId, staffId: null, reason: 'OTHER' })
  const onlineOf = (orderId: string) => prisma.onlineOrder.findFirstOrThrow({ where: { orderId } })
  const paymentsOf = (orderId: string) => prisma.payment.findMany({ where: { orderId }, take: 10 })
  const lost = () => Object.assign(new Error('se perdió la respuesta'), { type: 'StripeConnectionError' })

  it('aceptar captura una vez y deja la cuenta pagada y aceptada', async () => {
    const { charge, orderId } = await authorizedOrder()
    const r = await accept(orderId)
    expect(r).toMatchObject({ outcome: 'OK', status: 'ACCEPTED' })

    expect(captureSpy).toHaveBeenCalledTimes(1)
    expect(captureSpy.mock.calls[0][1]).toEqual({
      paymentIntentId: charge.paymentIntentId,
      amountCents: 25_000,
      // calculateApplicationFeeWithVAT(25000, 100, 1600) = 290
      applicationFeeCents: 290,
      idempotencyKey: `online-order:${orderId}:capture`,
    })
    const payments = await paymentsOf(orderId)
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({
      fundsFlow: 'AVOQADO_PROCESSED',
      ecommerceMerchantId: merchantId,
      method: 'CREDIT_CARD',
      source: 'WEB',
      status: 'COMPLETED',
      type: 'REGULAR',
      processor: 'stripe',
      processorId: charge.paymentIntentId,
      cardBrand: 'VISA',
      maskedPan: '************4242',
      idempotencyKey: `online-order:${orderId}:capture`,
      shiftId: null,
    })
    expect(payments[0].amount.toFixed(2)).toBe('250.00')
    expect(payments[0].tipAmount.toFixed(2)).toBe('0.00')
    expect(payments[0].feeAmount.toFixed(2)).toBe('2.90')
    expect(payments[0].netAmount.toFixed(2)).toBe('247.10')
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order).toMatchObject({ paymentStatus: 'PAID', status: 'CONFIRMED' })
    expect(order.paidAmount.toFixed(2)).toBe('250.00')
    expect(order.remainingBalance.toFixed(2)).toBe('0.00')
    expect((await onlineOf(orderId)).status).toBe('ACCEPTED')
    const after = await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: charge.id } })
    expect(after.status).toBe('CAPTURED')
    expect(after.capturedAmount!.toFixed(2)).toBe('250.00')
    expect(after.attempts).toBe(1)
  })

  it('S2 (clientes, Codex plan r1 #1): «Cuentas abiertas» de las apps no lista la tarjeta apartada; ya cobrada, sí', async () => {
    const { orderId } = await authorizedOrder()
    const ids = async (search?: string) => (await listMobileOrders(venueId!, { page: 1, pageSize: 100, search })).data.map(o => o.id)
    const { orderNumber } = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { orderNumber: true } })
    expect(await ids()).not.toContain(orderId)
    expect(await ids(orderNumber)).not.toContain(orderId)
    await accept(orderId)
    expect(await ids()).toContain(orderId)
  })

  it('S2 (clientes, Codex plan r2 #1): mover a una mesa la tarjeta sin cobrar → 409 y no mueve nada; pagar al recoger sí se mueve', async () => {
    const mesa = await prisma.table.create({
      data: { venueId: venueId!, number: `S2-${RUN}-${++seq}`, capacity: 4, qrCode: `itest-card-s2-${RUN}-${seq}` },
    })
    const { orderId } = await authorizedOrder()
    await expect(moveOrderToTable(venueId!, orderId, mesa.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ONLINE_ORDER_PAID_BY_CARD',
    })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).tableId).toBeNull()
    expect(await prisma.table.findUniqueOrThrow({ where: { id: mesa.id } })).toMatchObject({ status: 'AVAILABLE', currentOrderId: null })

    // Pagar al recoger (sin cargo) sí se mueve. Se arma directo: los topes del negocio no son lo que se prueba aquí.
    const key = nextKey()
    await draft({ key })
    const req = (await chargeOf(key)).request as any
    const pickupOrder = await prisma.$transaction(tx =>
      writeOnlineOrderInTx(tx, {
        venueId: venueId!,
        externalId: `web:s2-move-${RUN}-${seq}`,
        orderNumber: `WM${seq}`,
        quote: req.quote,
        customer: req.customer,
        customerId: null,
        note: null,
        paymentMode: 'PAY_AT_PICKUP',
        trackingToken: `${'m'.repeat(20)}${RUN}${seq}`.slice(0, 32),
        requestHash: `s2-move-${seq}`,
        acceptDeadlineAt: new Date(Date.now() + 10 * MIN),
        whatsappConsent: false,
      }),
    )
    await moveOrderToTable(venueId!, pickupOrder.orderId, mesa.id)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: pickupOrder.orderId } })).tableId).toBe(mesa.id)
  })

  // ── S5: el comensal abandona el pago (regresa de Stripe con ?pago=cancelado) ──
  const abandon = (trackingToken: string, venue = venueId!) => abandonCardPayment({ venueId: venue, trackingToken })
  const notExpirable = () =>
    Object.assign(new Error('Only Checkout Sessions with a status of open can be expired.'), { type: 'StripeInvalidRequestError' })
  const expiredSession = () => ({
    ...authorized(),
    sessionStatus: 'expired',
    paymentIntentId: null,
    piStatus: null,
    amountCapturableCents: 0,
  })

  it('S5 (clientes, Codex plan r1 #5 y r2 #2): página abierta → la vence en la cuenta conectada de la FOTO del cargo y queda PAYMENT_NOT_COMPLETED; repetir da lo mismo', async () => {
    const key = nextKey()
    const r = await draft({ key })
    const c = await chargeOf(key)
    authSpy.mockResolvedValue(expiredSession())
    await prisma.ecommerceMerchant.update({
      where: { id: merchantId },
      data: { providerCredentials: { connectAccountId: 'acct_itest_B' } },
    })
    let t: Awaited<ReturnType<typeof abandon>>
    try {
      t = await abandon(r.trackingToken)
    } finally {
      await prisma.ecommerceMerchant.update({
        where: { id: merchantId },
        data: { providerCredentials: { connectAccountId: 'acct_itest_1' } },
      })
    }
    expect(t).toMatchObject({ status: 'PAYMENT_NOT_COMPLETED', cardStatus: null, paymentMode: 'CARD_ONLINE', venueId, canCancel: false })
    expect(expireSpy).toHaveBeenCalledTimes(1)
    expect(expireSpy.mock.calls[0][0].providerCredentials).toEqual({ connectAccountId: 'acct_itest_1' })
    expect(expireSpy.mock.calls[0][1]).toBe(c.checkoutSessionId)
    const after = await chargeOf(key)
    expect(after.status).toBe('ABANDONED')
    expect(await prisma.order.count({ where: { venueId: venueId!, externalId: `web:${key}` } })).toBe(0)

    // Repetir: el mismo seguimiento, sin Stripe y sin escribir.
    await expect(abandon(r.trackingToken)).resolves.toEqual(t)
    expect(expireSpy).toHaveBeenCalledTimes(1)
    expect(authSpy).toHaveBeenCalledTimes(1)
    expect((await chargeOf(key)).updatedAt).toEqual(after.updatedAt)
  })

  it('S5: Stripe dice que la página ya se completó → corre la misma confirmación y nace el pedido (nunca se pierde un pago)', async () => {
    const key = nextKey()
    const r = await draft({ key })
    expireSpy.mockRejectedValueOnce(notExpirable())
    authSpy.mockResolvedValue(authorized())
    await expect(abandon(r.trackingToken)).resolves.toMatchObject({ status: 'PENDING_ACCEPTANCE', cardStatus: 'AUTHORIZED' })
    expect((await chargeOf(key)).status).toBe('AUTHORIZED')
    expect(await prisma.order.count({ where: { venueId: venueId!, externalId: `web:${key}` } })).toBe(1)
    expect(voidSpy).not.toHaveBeenCalled()
  })

  it('S5 fix r1 (Codex servidor r1 #1): Stripe vence la página, la confirmación falla y se repite el POST → checkoutUrl vacío, sigue PENDING_AUTH', async () => {
    const key = nextKey()
    const phone = nextPhone()
    const r = await draft({ key, phone })
    authSpy.mockRejectedValue(lost())
    await expect(abandon(r.trackingToken)).resolves.toMatchObject({ status: 'AWAITING_PAYMENT', cardStatus: null })
    expect(expireSpy).toHaveBeenCalledTimes(1)
    expect(authSpy).toHaveBeenCalledTimes(1)

    await expect(draft({ key, phone })).resolves.toMatchObject({
      trackingToken: r.trackingToken,
      checkoutUrl: '',
      status: 'AWAITING_PAYMENT',
      replay: true,
    })
    expect((await chargeOf(key)).status).toBe('PENDING_AUTH')

    // Si Stripe dijo que no se podía vencer, no se toca el vencimiento: manda la relectura.
    const k2 = nextKey()
    await draft({ key: k2 })
    const before = await chargeOf(k2)
    expireSpy.mockRejectedValueOnce(notExpirable())
    await abandon(before.trackingToken)
    expect((await chargeOf(k2)).checkoutExpiresAt).toEqual(before.checkoutExpiresAt)
  })

  it('S5: el token ya es un pedido (otra pestaña completó el pago) → responde el seguimiento sin cancelar, liberar ni preguntar a Stripe', async () => {
    const { charge, orderId, trackingToken } = await authorizedOrder()
    const stripeReads = authSpy.mock.calls.length
    await expect(abandon(trackingToken)).resolves.toMatchObject({ status: 'PENDING_ACCEPTANCE', cardStatus: 'AUTHORIZED', canCancel: true })
    expect(expireSpy).not.toHaveBeenCalled()
    expect(voidSpy).not.toHaveBeenCalled()
    expect(authSpy).toHaveBeenCalledTimes(stripeReads)
    expect((await onlineOf(orderId)).status).toBe('PENDING_ACCEPTANCE')
    expect((await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe('AUTHORIZED')
  })

  it('S5: sin respuesta de Stripe al vencer la página → 502 CARD_PROVIDER_UNAVAILABLE y el borrador sigue PENDING_AUTH; el token de otro negocio no toca nada', async () => {
    const key = nextKey()
    const r = await draft({ key })
    expireSpy.mockRejectedValueOnce(lost())
    await expect(abandon(r.trackingToken)).rejects.toMatchObject({ statusCode: 502, code: 'CARD_PROVIDER_UNAVAILABLE' })
    expect((await chargeOf(key)).status).toBe('PENDING_AUTH')
    expect(authSpy).not.toHaveBeenCalled()

    await expect(abandon(r.trackingToken, 'c000000000000000000000000')).resolves.toBeNull()
    expect(expireSpy).toHaveBeenCalledTimes(1)
    expect((await chargeOf(key)).status).toBe('PENDING_AUTH')
  })

  it('doble aceptar en paralelo captura una sola vez', async () => {
    const { orderId } = await authorizedOrder()
    const outcomes = await Promise.all([accept(orderId), accept(orderId)])
    expect(outcomes.filter(o => o.outcome === 'OK')).toHaveLength(1)
    expect(captureSpy).toHaveBeenCalledTimes(1)
    expect(await paymentsOf(orderId)).toHaveLength(1)
  })

  it('aceptar con la respuesta perdida deja CAPTURING y responde CONFIRMING_PAYMENT; rechazar y vencer después responden CONFIRMING_PAYMENT sin escribir', async () => {
    const { charge, orderId } = await authorizedOrder()
    captureSpy.mockRejectedValue(lost())
    authSpy.mockResolvedValue({ ...authorized(), paymentIntentId: charge.paymentIntentId })

    await expect(accept(orderId)).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
    const c = await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: charge.id } })
    expect(c.status).toBe('CAPTURING')
    expect(c.lastError).toBeTruthy()
    expect(authSpy).toHaveBeenLastCalledWith(expect.anything(), { paymentIntentId: charge.paymentIntentId })

    await expect(reject(orderId)).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
    const late = new Date(Date.now() + 60 * MIN)
    await expect(expireOnlineOrder({ venueId: venueId!, orderId, now: late })).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
    await expect(accept(orderId)).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
    expect(captureSpy).toHaveBeenCalledTimes(1)
    expect((await onlineOf(orderId)).status).toBe('PENDING_ACCEPTANCE')
    expect((await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe('CAPTURING')
    expect(await paymentsOf(orderId)).toHaveLength(0)
    expect(voidSpy).not.toHaveBeenCalled()
  })

  it('Stripe rechaza la captura (PI canceled) → pedido REJECTED con PAYMENT_FAILED, sin Payment', async () => {
    const { charge, orderId } = await authorizedOrder()
    captureSpy.mockRejectedValue(Object.assign(new Error('canceled'), { type: 'StripeInvalidRequestError' }))
    authSpy.mockResolvedValue({ ...authorized(), paymentIntentId: charge.paymentIntentId, piStatus: 'canceled', amountCapturableCents: 0 })

    await expect(accept(orderId)).resolves.toEqual({ outcome: 'STALE', status: 'REJECTED' })
    expect(await onlineOf(orderId)).toMatchObject({ status: 'REJECTED', rejectReason: 'PAYMENT_FAILED' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
    expect((await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe('CAPTURE_FAILED')
    expect(await paymentsOf(orderId)).toHaveLength(0)
    expect(voidSpy).not.toHaveBeenCalled()
  })

  it('rechazar libera: cargo RELEASED y voidAuthorization con online-order:<id>:release; vencer libera; cancelar el cliente libera', async () => {
    const a = await authorizedOrder()
    await expect(reject(a.orderId)).resolves.toEqual({ outcome: 'OK', status: 'REJECTED' })
    expect(voidSpy).toHaveBeenCalledWith(expect.anything(), {
      paymentIntentId: a.charge.paymentIntentId,
      idempotencyKey: `online-order:${a.orderId}:release`,
    })
    const ca = await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: a.charge.id } })
    expect(ca.status).toBe('RELEASED')
    expect(ca.releasedAt).toBeInstanceOf(Date)

    const b = await authorizedOrder()
    const late = new Date(Date.now() + 60 * MIN)
    await expect(expireOnlineOrder({ venueId: venueId!, orderId: b.orderId, now: late })).resolves.toEqual({
      outcome: 'OK',
      status: 'EXPIRED',
    })
    expect((await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: b.charge.id } })).status).toBe('RELEASED')

    const c = await authorizedOrder()
    await expect(cancelOnlineOrderByCustomer({ venueId: venueId!, trackingToken: c.trackingToken })).resolves.toEqual({
      outcome: 'OK',
      status: 'CANCELLED_BY_CUSTOMER',
    })
    expect((await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: c.charge.id } })).status).toBe('RELEASED')
    expect(voidSpy).toHaveBeenCalledTimes(3)
    expect(captureSpy).not.toHaveBeenCalled()
  })

  it('liberar falla → cargo queda RELEASING y el pedido igual se ve rechazado', async () => {
    const { charge, orderId } = await authorizedOrder()
    voidSpy.mockRejectedValue(lost())
    await expect(reject(orderId)).resolves.toEqual({ outcome: 'OK', status: 'REJECTED' })
    const c = await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: charge.id } })
    expect(c.status).toBe('RELEASING')
    expect(c.lastError).toBeTruthy()
    expect((await onlineOf(orderId)).status).toBe('REJECTED')
    // El conciliador lo reintenta con la misma clave.
    voidSpy.mockImplementation(async (_m: any, p: any) => ({ ...authorized(), paymentIntentId: p.paymentIntentId, piStatus: 'canceled' }))
    await expect(releaseCharge(charge.id)).resolves.toBe('RELEASED')
    expect(voidSpy.mock.calls[1][1].idempotencyKey).toBe(`online-order:${orderId}:release`)
  })

  it('S4 (clientes, Codex plan r1 #3 y r2 #3): el seguimiento no afirma «no se cobró» con el dinero en duda', async () => {
    // Pedido rechazado cuya liberación falló: la tarjeta sigue apartada ⇒ RELEASING, no RELEASED.
    const { orderId, trackingToken } = await authorizedOrder()
    voidSpy.mockRejectedValue(lost())
    await reject(orderId)
    await expect(getTrackingByToken(trackingToken)).resolves.toMatchObject({ status: 'REJECTED', cardStatus: 'RELEASING' })

    // Borrador normal: espera el pago, sin estado de tarjeta.
    const k1 = nextKey()
    const r1 = await draft({ key: k1 })
    await expect(getTrackingByToken(r1.trackingToken)).resolves.toMatchObject({ status: 'AWAITING_PAYMENT', cardStatus: null })

    // Borrador que terminó CAPTURED sin pedido (se iba a liberar y ya estaba cobrado a mano).
    await prisma.onlineOrderCharge.update({
      where: { id: (await chargeOf(k1)).id },
      data: { status: 'CAPTURED', lastError: 'CAPTURED_OUTSIDE', paymentIntentId: `pi_s4_${RUN}` },
    })
    await expect(getTrackingByToken(r1.trackingToken)).resolves.toMatchObject({ status: 'PAYMENT_NOT_COMPLETED', cardStatus: 'CAPTURED' })

    // Borrador PENDING_AUTH cobrado fuera de Avoqado: lo mismo, y sin volver a preguntarle a Stripe.
    const k2 = nextKey()
    const r2 = await draft({ key: k2 })
    await prisma.onlineOrderCharge.update({
      where: { id: (await chargeOf(k2)).id },
      data: { lastError: 'CAPTURED_OUTSIDE', updatedAt: new Date(Date.now() - 10_000) },
    })
    const stripeReads = authSpy.mock.calls.length
    await expect(getTrackingByToken(r2.trackingToken)).resolves.toMatchObject({ status: 'PAYMENT_NOT_COMPLETED', cardStatus: 'CAPTURED' })
    expect(authSpy).toHaveBeenCalledTimes(stripeReads)
  })

  it('un cargo RELEASING sin pedido (liberación tardía) se libera con la clave del cargo', async () => {
    const key = nextKey()
    await draft({ key })
    const c = await chargeOf(key)
    await prisma.onlineOrderCharge.update({ where: { id: c.id }, data: { status: 'RELEASING', paymentIntentId: `pi_late_${RUN}` } })
    await expect(releaseCharge(c.id)).resolves.toBe('RELEASED')
    expect(voidSpy.mock.calls[0][1]).toEqual({ paymentIntentId: `pi_late_${RUN}`, idempotencyKey: `online-order-charge:${c.id}:release` })
    expect((await chargeOf(key)).status).toBe('RELEASED')
  })

  it('entregar un pedido de tarjeta ya aceptado no pide cobro', async () => {
    const { orderId } = await authorizedOrder()
    await expect(accept(orderId)).resolves.toMatchObject({ outcome: 'OK' })
    await expect(markOnlineOrderDelivered({ venueId: venueId!, orderId, staffId: null })).resolves.toEqual({
      outcome: 'OK',
      status: 'COMPLETED',
    })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('COMPLETED')
  })

  it('cambiar la comisión del comercio después del borrador no cambia lo que se manda a Stripe ni el feeAmount', async () => {
    const { orderId } = await authorizedOrder()
    await prisma.ecommerceMerchant.update({ where: { id: merchantId }, data: { platformFeeBps: 500 } })
    try {
      await expect(accept(orderId)).resolves.toMatchObject({ outcome: 'OK' })
      expect(captureSpy.mock.calls[0][1].applicationFeeCents).toBe(290)
      expect((await paymentsOf(orderId))[0].feeAmount.toFixed(2)).toBe('2.90')
    } finally {
      await prisma.ecommerceMerchant.update({ where: { id: merchantId }, data: { platformFeeBps: 100 } })
    }
  })

  it('débito → Payment.method DEBIT_CARD; crédito → CREDIT_CARD', async () => {
    const debit = await authorizedOrder()
    captureSpy.mockImplementation(async (_m: any, p: any) => capturedState(p, 'debit'))
    await expect(accept(debit.orderId)).resolves.toMatchObject({ outcome: 'OK' })
    expect((await paymentsOf(debit.orderId))[0].method).toBe('DEBIT_CARD')

    const credit = await authorizedOrder()
    captureSpy.mockImplementation(async (_m: any, p: any) => capturedState(p, 'credit'))
    await expect(accept(credit.orderId)).resolves.toMatchObject({ outcome: 'OK' })
    expect((await paymentsOf(credit.orderId))[0].method).toBe('CREDIT_CARD')
  })

  it('autorizar en la cuenta A, cambiar las credenciales del comercio a B, aceptar → la captura va a A; igual al liberar', async () => {
    const a = await authorizedOrder()
    const b = await authorizedOrder()
    await prisma.ecommerceMerchant.update({
      where: { id: merchantId },
      data: { providerCredentials: { connectAccountId: 'acct_itest_B' } },
    })
    try {
      await expect(accept(a.orderId)).resolves.toMatchObject({ outcome: 'OK' })
      expect(captureSpy.mock.calls[0][0].providerCredentials).toEqual({ connectAccountId: 'acct_itest_1' })
      await expect(reject(b.orderId)).resolves.toMatchObject({ outcome: 'OK' })
      expect(voidSpy.mock.calls[0][0].providerCredentials).toEqual({ connectAccountId: 'acct_itest_1' })
    } finally {
      await prisma.ecommerceMerchant.update({
        where: { id: merchantId },
        data: { providerCredentials: { connectAccountId: 'acct_itest_1' } },
      })
    }
  })

  it('Order.total distinto de charge.amount al aceptar → no captura, PAYMENT_FAILED, libera', async () => {
    const { charge, orderId } = await authorizedOrder()
    await prisma.order.update({ where: { id: orderId }, data: { total: new Prisma.Decimal('300.00') } })
    await expect(accept(orderId)).resolves.toEqual({ outcome: 'STALE', status: 'REJECTED' })
    expect(captureSpy).not.toHaveBeenCalled()
    expect(await onlineOf(orderId)).toMatchObject({ status: 'REJECTED', rejectReason: 'PAYMENT_FAILED' })
    expect((await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe('RELEASED')
    expect(voidSpy).toHaveBeenCalledTimes(1)
  })

  it('ruling T6: aceptar con el cargo RELEASED o CAPTURE_FAILED rechaza con PAYMENT_FAILED sin capturar', async () => {
    for (const status of ['RELEASED', 'CAPTURE_FAILED'] as const) {
      const { charge, orderId } = await authorizedOrder()
      await prisma.onlineOrderCharge.update({ where: { id: charge.id }, data: { status } })
      await expect(accept(orderId)).resolves.toEqual({ outcome: 'STALE', status: 'REJECTED' })
      expect(await onlineOf(orderId)).toMatchObject({ status: 'REJECTED', rejectReason: 'PAYMENT_FAILED' })
    }
    expect(captureSpy).not.toHaveBeenCalled()
    expect(voidSpy).not.toHaveBeenCalled()
  })

  /** Un aviso del endpoint Connect con la metadata de un cargo (la cuenta y el modo, los del cargo salvo que se diga otra cosa). */
  let evtSeq = 0
  const connectEvent = (type: string, data: Record<string, unknown>, o: { account?: string; livemode?: boolean } = {}) =>
    processStripeConnectWebhookEvent({
      id: `evt_itest_${RUN}_${++evtSeq}`,
      type,
      account: o.account ?? 'acct_itest_1',
      livemode: o.livemode ?? false,
      data,
    })
  const meta = (chargeId: string) => ({ type: 'online_order', chargeId, venueId: venueId! })
  const releasedLogs = (entityId: string) =>
    (logAction as jest.Mock).mock.calls.filter(([p]) => p.action === 'ONLINE_ORDER_CARD_RELEASED' && p.entityId === entityId).length
  const anomalies = (category: string) => prisma.moneyAnomaly.count({ where: { category, stripeEventId: { contains: `${RUN}` } } })

  it('ruling T6: payment_intent.canceled sobre un cargo AUTHORIZED rechaza el pedido con PAYMENT_FAILED y deja el cargo RELEASED', async () => {
    const { charge, orderId } = await authorizedOrder()
    // Codex r1 C2: el aviso sólo encuentra el cargo; lo que se escribe sale de releer Stripe con el PaymentIntent PROPIO.
    authSpy.mockResolvedValueOnce({ ...authorized(), paymentIntentId: charge.paymentIntentId, piStatus: 'canceled' })
    await connectEvent('payment_intent.canceled', { id: charge.paymentIntentId, metadata: meta(charge.id) })
    expect(authSpy.mock.calls.at(-1)![1]).toEqual({ paymentIntentId: charge.paymentIntentId })
    expect(await onlineOf(orderId)).toMatchObject({ status: 'REJECTED', rejectReason: 'PAYMENT_FAILED' })
    const c = await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: charge.id } })
    expect(c.status).toBe('RELEASED')
    expect(c.releasedAt).toBeInstanceOf(Date)
    expect(voidSpy).not.toHaveBeenCalled() // Stripe ya la canceló
    // M2: la liberación por el aviso deja su bitácora, una sola vez.
    expect(releasedLogs(c.onlineOrderId!)).toBe(1)
  })

  it('Codex r1 C2: un PaymentIntent AJENO cancelado con la metadata copiada no libera la tarjeta ni rechaza el pedido', async () => {
    const errorSpy = jest.spyOn(logger, 'error')
    try {
      const { charge, orderId } = await authorizedOrder()
      await connectEvent('payment_intent.canceled', { id: `pi_ajeno_${RUN}`, metadata: meta(charge.id) })
      expect(await chargeById(charge.id)).toMatchObject({ status: 'AUTHORIZED', releasedAt: null })
      expect(await onlineOf(orderId)).toMatchObject({ status: 'PENDING_ACCEPTANCE' })
      expect(authSpy).toHaveBeenCalledTimes(1) // sólo la confirmación del pedido; el aviso ajeno ni se relee
      expect(errorSpy.mock.calls.some(([m]: unknown[]) => typeof m === 'string' && m.startsWith('🚨'))).toBe(true)

      // El PaymentIntent propio, pero Stripe dice que sigue apartado (aviso viejo o inventado): tampoco.
      authSpy.mockResolvedValueOnce({ ...authorized(), paymentIntentId: charge.paymentIntentId })
      await connectEvent('payment_intent.canceled', { id: charge.paymentIntentId, metadata: meta(charge.id) })
      expect(await chargeById(charge.id)).toMatchObject({ status: 'AUTHORIZED' })
      expect(await onlineOf(orderId)).toMatchObject({ status: 'PENDING_ACCEPTANCE' })
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('Codex r1 C2: un aviso de OTRA cuenta conectada o de otro modo (real/prueba) → anomalía y nada escrito', async () => {
    const { charge, orderId } = await authorizedOrder()
    const before = await anomalies('ONLINE_ORDER_STRIPE_EVENT_FOREIGN')
    await connectEvent('payment_intent.canceled', { id: charge.paymentIntentId, metadata: meta(charge.id) }, { account: 'acct_otro' })
    await connectEvent('payment_intent.canceled', { id: charge.paymentIntentId, metadata: meta(charge.id) }, { livemode: true })
    expect(await anomalies('ONLINE_ORDER_STRIPE_EVENT_FOREIGN')).toBe(before + 2)
    expect(await chargeById(charge.id)).toMatchObject({ status: 'AUTHORIZED' })
    expect(await onlineOf(orderId)).toMatchObject({ status: 'PENDING_ACCEPTANCE' })

    // Un borrador: el «completed» de otra cuenta ni siquiera consulta a Stripe ni crea el pedido.
    const key = nextKey()
    await draft({ key })
    const d = await chargeOf(key)
    const calls = authSpy.mock.calls.length
    await connectEvent('checkout.session.completed', { id: d.checkoutSessionId, metadata: meta(d.id) }, { account: 'acct_otro' })
    expect(authSpy.mock.calls.length).toBe(calls)
    expect((await chargeOf(key)).status).toBe('PENDING_AUTH')
    expect(await anomalies('ONLINE_ORDER_STRIPE_EVENT_FOREIGN')).toBe(before + 3)
  })

  it('Codex r1 C2: payment_intent.canceled sobre un borrador relee la sesión propia: abierta → sigue esperando; vencida → ABANDONED', async () => {
    const key = nextKey()
    await draft({ key })
    const d = await chargeOf(key)
    const open = { ...authorized(), sessionStatus: 'open', paymentIntentId: null, piStatus: null, amountCapturableCents: 0 }
    authSpy.mockResolvedValueOnce(open)
    await connectEvent('payment_intent.canceled', { id: `pi_cualquiera_${RUN}`, metadata: meta(d.id) })
    expect(authSpy.mock.calls.at(-1)![1]).toEqual({ checkoutSessionId: d.checkoutSessionId })
    expect((await chargeOf(key)).status).toBe('PENDING_AUTH')

    authSpy.mockResolvedValueOnce({ ...open, sessionStatus: 'expired' })
    await connectEvent('payment_intent.canceled', { id: `pi_cualquiera_${RUN}`, metadata: meta(d.id) })
    expect((await chargeOf(key)).status).toBe('ABANDONED')
  })

  it('Codex r1 C3: Stripe dice succeeded (capturado a mano) sobre un borrador → sin pedido, anomalía y alerta UNA vez; nadie lo abandona ni lo libera', async () => {
    const errorSpy = jest.spyOn(logger, 'error')
    try {
      const key = nextKey()
      const r = await draft({ key })
      const d = await chargeOf(key)
      const pi = `pi_itest_${RUN}_${++piSeq}`
      authSpy.mockResolvedValue(capturedState({ paymentIntentId: pi, amountCents: 25_000 }))
      const outsideLogs = () =>
        (logAction as jest.Mock).mock.calls.filter(([p]) => p.action === 'ONLINE_ORDER_CARD_CAPTURED_OUTSIDE' && p.entityId === d.id)

      await expect(confirmCardAuthorization(d.id)).resolves.toBe('CAPTURED_OUTSIDE')
      expect(await chargeById(d.id)).toMatchObject({ status: 'PENDING_AUTH', paymentIntentId: pi, lastError: 'CAPTURED_OUTSIDE' })
      expect(await prisma.order.count({ where: { venueId: venueId!, externalId: `web:${key}` } })).toBe(0)
      expect(outsideLogs()).toHaveLength(1)
      expect(outsideLogs()[0][0].data).toMatchObject({ paymentIntentId: pi, amount: '250.00' })
      expect(
        await prisma.moneyAnomaly.count({
          where: { category: 'ONLINE_ORDER_CARD_CAPTURED_OUTSIDE', stripeEventId: `ooc:CAPTURED_OUTSIDE:${d.id}` },
        }),
      ).toBe(1)
      expect(
        errorSpy.mock.calls.filter(([m]: unknown[]) => typeof m === 'string' && m.includes('capturada fuera de Avoqado')),
      ).toHaveLength(1)

      // Otra vez (aviso, seguimiento): ni Stripe, ni otra alerta.
      await expect(confirmCardAuthorization(d.id)).resolves.toBe('CAPTURED_OUTSIDE')
      expect(authSpy).toHaveBeenCalledTimes(1)
      expect(outsideLogs()).toHaveLength(1)

      // El conciliador ya no lo reintenta como «todavía no» ni lo abandona al vencer la sesión; no libera dinero ya cobrado.
      await prisma.onlineOrderCharge.update({ where: { id: d.id }, data: { checkoutExpiresAt: ago(MIN) } })
      await quiet([d.id])
      await expect(reconcile()).resolves.toMatchObject({ scanned: 0 })
      expect(await chargeById(d.id)).toMatchObject({ status: 'PENDING_AUTH' })
      expect(voidSpy).not.toHaveBeenCalled()
      // S4 (Codex plan r2 #3): el comensal ya no ve «esperando el pago»: el pago no se completó por aquí y su tarjeta SÍ se cobró.
      await expect(getTrackingByToken(r.trackingToken)).resolves.toMatchObject({ status: 'PAYMENT_NOT_COMPLETED', cardStatus: 'CAPTURED' })
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('Codex r1 C3: un pedido con la tarjeta apartada que el negocio capturó a mano en Stripe → aceptar termina CAPTURED con UN Payment', async () => {
    const { charge, orderId } = await authorizedOrder()
    captureSpy.mockRejectedValueOnce(
      Object.assign(new Error('This PaymentIntent could not be captured because it has a status of succeeded.'), {
        type: 'StripeInvalidRequestError',
        code: 'payment_intent_unexpected_state',
        statusCode: 400,
      }),
    )
    authSpy.mockResolvedValueOnce(capturedState({ paymentIntentId: charge.paymentIntentId!, amountCents: 25_000 }))
    await expect(accept(orderId)).resolves.toMatchObject({ outcome: 'OK', status: 'ACCEPTED' })
    expect(await chargeById(charge.id)).toMatchObject({ status: 'CAPTURED' })
    expect(await paymentsOf(orderId)).toHaveLength(1)
  })

  it('la cuenta ya tiene dinero de otro camino → no captura: libera y acepta normal', async () => {
    const { charge, orderId } = await authorizedOrder()
    await prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'PAID', paidAmount: new Prisma.Decimal('250.00') } })
    await expect(accept(orderId)).resolves.toMatchObject({ outcome: 'OK', status: 'ACCEPTED' })
    expect(captureSpy).not.toHaveBeenCalled()
    expect((await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe('RELEASED')
  })

  // ── Fix r1 de la tarea 6 ──
  it('fix r1 I1: un pedido de tarjeta sin cargo nunca se acepta sin cobrar: PAYMENT_FAILED', async () => {
    const { charge, orderId } = await authorizedOrder()
    await prisma.onlineOrderCharge.update({ where: { id: charge.id }, data: { onlineOrderId: null } })
    await expect(accept(orderId)).resolves.toEqual({ outcome: 'STALE', status: 'REJECTED' })
    expect(await onlineOf(orderId)).toMatchObject({ status: 'REJECTED', rejectReason: 'PAYMENT_FAILED' })
    expect(captureSpy).not.toHaveBeenCalled()
  })

  it('fix r1 I1: con un pago parcial de otro camino no captura ni acepta; suelta la tarjeta', async () => {
    const { charge, orderId } = await authorizedOrder()
    await prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'PARTIAL', paidAmount: new Prisma.Decimal('100.00') } })
    const r = await accept(orderId)
    expect(r.outcome).not.toBe('OK')
    expect(captureSpy).not.toHaveBeenCalled()
    expect((await onlineOf(orderId)).status).not.toBe('ACCEPTED')
    expect((await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe('RELEASED')
  })

  it('fix r1 I2: el total cambia entre la primera transacción y el registro del cobro → sin Payment, cargo CAPTURING con TOTAL_CHANGED', async () => {
    const { charge, orderId } = await authorizedOrder()
    captureSpy.mockImplementation(async (_m: any, p: any) => {
      await prisma.order.update({ where: { id: orderId }, data: { total: new Prisma.Decimal('300.00') } })
      return capturedState(p)
    })
    await expect(accept(orderId)).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
    expect(await paymentsOf(orderId)).toHaveLength(0)
    const c = await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: charge.id } })
    expect(c).toMatchObject({ status: 'CAPTURING', lastError: 'TOTAL_CHANGED' })
    expect((await onlineOf(orderId)).status).toBe('PENDING_ACCEPTANCE')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PENDING')
  })

  it('T8 fix r1: un cobro de la TPV cae mientras Stripe captura → se registra el de tarjeta igual y queda ONLINE_ORDER_CARD_DOUBLE_PAYMENT', async () => {
    const { charge, orderId } = await authorizedOrder()
    let tpvPaymentId = ''
    captureSpy.mockImplementation(async (_m: any, p: any) => {
      // La terminal registra un cobro YA hecho entre la primera transacción de la captura y su registro.
      tpvPaymentId = (
        await prisma.payment.create({
          data: {
            venueId: venueId!,
            orderId,
            amount: new Prisma.Decimal('250.00'),
            tipAmount: 0,
            method: 'CREDIT_CARD',
            status: 'COMPLETED',
            type: 'REGULAR',
            source: 'TPV',
            feePercentage: 0,
            feeAmount: 0,
            netAmount: new Prisma.Decimal('250.00'),
          },
        })
      ).id
      await prisma.order.update({ where: { id: orderId }, data: { paidAmount: new Prisma.Decimal('250.00') } })
      return capturedState(p)
    })
    ;(logAction as jest.Mock).mockClear()
    await expect(accept(orderId)).resolves.toMatchObject({ outcome: 'OK', status: 'ACCEPTED' })

    const pagos = await paymentsOf(orderId)
    expect(pagos).toHaveLength(2)
    const deTarjeta = pagos.find(p => p.processorId === charge.paymentIntentId)!
    expect(deTarjeta).toMatchObject({ status: 'COMPLETED', source: 'WEB' })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.paymentStatus).toBe('PAID')
    // Lo cobrado dice la verdad: los dos cobros, no sólo el de la tarjeta.
    expect(order.paidAmount.toFixed(2)).toBe('500.00')
    expect((await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe('CAPTURED')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ONLINE_ORDER_CARD_DOUBLE_PAYMENT',
        entity: 'Order',
        entityId: orderId,
        data: expect.objectContaining({ paymentId: deTarjeta.id, chargeId: charge.id, source: 'ONLINE_CAPTURE' }),
      }),
    )
    expect(tpvPaymentId).not.toBe('')
  })

  // ── Tarea 7: el conciliador termina lo que quedó en duda ──
  const NONFINAL = ['PENDING_AUTH', 'AUTHORIZED', 'CAPTURING', 'RELEASING'] as const
  /** El conciliador lee TODOS los cargos de la base (desechable): los de otras pruebas se cierran para que no cuenten. */
  const quiet = (keep: string[] = []) =>
    prisma.onlineOrderCharge.updateMany({ where: { status: { in: [...NONFINAL] }, id: { notIn: keep } }, data: { status: 'ABANDONED' } })
  const reconcile = (now = new Date()) => reconcileCardCharges(now, read => read())
  const chargeById = (id: string) => prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id } })
  const ago = (ms: number) => new Date(Date.now() - ms)
  /** `logAction` está simulado en toda la integración (integration-setup): se cuentan sus llamadas. */
  const stuckLogs = async (chargeId: string, action = 'ONLINE_ORDER_CARD_RELEASE_STUCK') =>
    (logAction as jest.Mock).mock.calls.filter(([p]) => p.action === action && p.entityId === chargeId).length
  /** Un pedido cuya captura quedó en duda (`CAPTURING`) hace 2 min. */
  const capturingOrder = async () => {
    const a = await authorizedOrder()
    captureSpy.mockRejectedValueOnce(lost())
    authSpy.mockResolvedValueOnce({ ...authorized(), paymentIntentId: a.charge.paymentIntentId })
    await expect(accept(a.orderId)).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
    await prisma.onlineOrderCharge.update({ where: { id: a.charge.id }, data: { updatedAt: ago(2 * MIN) } })
    await quiet([a.charge.id])
    return a
  }
  /** Un borrador cuya sesión ya venció, con `updatedAt` controlado (filas sintéticas: rápidas y sin carrito). */
  const expiredDraftRow = async (o: { session?: string | null; updatedAt: Date; template: Awaited<ReturnType<typeof chargeOf>> }) => {
    ++seq
    return prisma.onlineOrderCharge.create({
      data: {
        venueId: venueId!,
        ecommerceMerchantId: merchantId,
        idempotencyKey: nextKey(),
        trackingToken: `rec${RUN}${seq}`.padEnd(32, 't'),
        customerPhone: o.template.customerPhone,
        request: o.template.request as Prisma.InputJsonValue,
        requestHash: o.template.requestHash,
        checkoutSessionId: o.session === undefined ? `cs_rec_${RUN}_${seq}` : o.session,
        checkoutExpiresAt: ago(10 * MIN),
        amount: o.template.amount,
        platformFeeBps: o.template.platformFeeBps,
        applicationFeeCents: o.template.applicationFeeCents,
        merchantSnapshot: o.template.merchantSnapshot as Prisma.InputJsonValue,
        updatedAt: o.updatedAt,
      },
    })
  }

  it('conciliador: un CAPTURING cuyo PI ya está succeeded termina con un solo Payment', async () => {
    const { charge, orderId } = await capturingOrder()
    authSpy.mockResolvedValue(capturedState({ paymentIntentId: charge.paymentIntentId!, amountCents: 25_000 }))

    const r = await reconcile()
    expect(r).toMatchObject({ scanned: 1, finished: 1, errors: 0 })
    expect(captureSpy).toHaveBeenCalledTimes(1) // sólo la de aceptar: no se vuelve a cobrar
    expect((await chargeById(charge.id)).status).toBe('CAPTURED')
    expect((await onlineOf(orderId)).status).toBe('ACCEPTED')
    expect(await paymentsOf(orderId)).toHaveLength(1)

    await reconcile(new Date(Date.now() + 5 * MIN))
    expect(await paymentsOf(orderId)).toHaveLength(1)
  })

  it('conciliador: un CAPTURING que sigue requires_capture reintenta con la misma clave; uno de menos de 60 s no se toca', async () => {
    const { charge, orderId } = await capturingOrder()
    await prisma.onlineOrderCharge.update({ where: { id: charge.id }, data: { updatedAt: ago(20_000) } })
    authSpy.mockClear()
    authSpy.mockResolvedValue({ ...authorized(), paymentIntentId: charge.paymentIntentId })

    // Ruling 2: puede haber una captura en vuelo.
    await expect(reconcile()).resolves.toMatchObject({ scanned: 0 })
    expect(authSpy).not.toHaveBeenCalled()

    await prisma.onlineOrderCharge.update({ where: { id: charge.id }, data: { updatedAt: ago(2 * MIN) } })
    await expect(reconcile()).resolves.toMatchObject({ scanned: 1, finished: 1 })
    expect(captureSpy).toHaveBeenCalledTimes(2)
    expect(captureSpy.mock.calls[1][1]).toEqual(captureSpy.mock.calls[0][1])
    expect(captureSpy.mock.calls[1][1].idempotencyKey).toBe(`online-order:${orderId}:capture`)
    expect((await chargeById(charge.id)).status).toBe('CAPTURED')
    expect(await paymentsOf(orderId)).toHaveLength(1)
  })

  it('conciliador: un CAPTURING cuyo PI quedó canceled sigue el camino de captura fallida', async () => {
    const { charge, orderId } = await capturingOrder()
    authSpy.mockResolvedValue({ ...authorized(), paymentIntentId: charge.paymentIntentId, piStatus: 'canceled', amountCapturableCents: 0 })
    await expect(reconcile()).resolves.toMatchObject({ scanned: 1, finished: 1 })
    expect((await chargeById(charge.id)).status).toBe('CAPTURE_FAILED')
    expect(await onlineOf(orderId)).toMatchObject({ status: 'REJECTED', rejectReason: 'PAYMENT_FAILED' })
    expect(await paymentsOf(orderId)).toHaveLength(0)
  })

  it('conciliador: un RELEASING se libera', async () => {
    const { charge, orderId } = await authorizedOrder()
    voidSpy.mockRejectedValueOnce(lost())
    await expect(reject(orderId)).resolves.toEqual({ outcome: 'OK', status: 'REJECTED' })
    expect((await chargeById(charge.id)).status).toBe('RELEASING')
    await quiet([charge.id])

    await expect(reconcile()).resolves.toMatchObject({ scanned: 1, released: 1 })
    expect(voidSpy).toHaveBeenCalledTimes(2)
    expect(voidSpy.mock.calls[1][1]).toEqual({ paymentIntentId: charge.paymentIntentId, idempotencyKey: `online-order:${orderId}:release` })
    expect((await chargeById(charge.id)).status).toBe('RELEASED')
  })

  it('conciliador: la caja canceló la cuenta con la tarjeta apartada → el conciliador libera', async () => {
    const { charge, orderId } = await authorizedOrder()
    const keep = await authorizedOrder() // su pedido sigue por aceptar: su tarjeta NO se toca
    await prisma.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } })
    await quiet([charge.id, keep.charge.id])

    await expect(reconcile()).resolves.toMatchObject({ scanned: 1, released: 1 })
    expect(voidSpy).toHaveBeenCalledTimes(1)
    expect(voidSpy.mock.calls[0][1]).toEqual({ paymentIntentId: charge.paymentIntentId, idempotencyKey: `online-order:${orderId}:release` })
    expect((await chargeById(charge.id)).status).toBe('RELEASED')
    expect((await chargeById(keep.charge.id)).status).toBe('AUTHORIZED')
  })

  // ── r2 R1: la tarjeta apartada que el negocio cobró a mano en Stripe y después se rechaza, vence o cancela ──
  /** Stripe ya no deja cancelar (el PI está succeeded) y la relectura dice cobrado por `cents`. */
  const capturedByHand = (pi: string, cents = 25_000) => {
    voidSpy.mockImplementation(async () => {
      throw Object.assign(new Error('This PaymentIntent could not be canceled because it has a status of succeeded.'), {
        type: 'StripeInvalidRequestError',
        code: 'payment_intent_unexpected_state',
        statusCode: 400,
      })
    })
    authSpy.mockResolvedValue(capturedState({ paymentIntentId: pi, amountCents: cents }))
  }
  const outsideLogsOf = (entityId: string) =>
    (logAction as jest.Mock).mock.calls.filter(([p]) => p.action === 'ONLINE_ORDER_CARD_CAPTURED_OUTSIDE' && p.entityId === entityId).length
  /** Lo que debe quedar: un Payment de tarjeta COMPLETED, el cargo CAPTURED con lo cobrado, una anomalía y UNA alerta. */
  const expectRecordedOnce = async (a: { charge: { id: string; paymentIntentId: string | null }; orderId: string }, cents = 25_000) => {
    const c = await chargeById(a.charge.id)
    expect(c).toMatchObject({ status: 'CAPTURED', lastError: 'CAPTURED_OUTSIDE', releasedAt: null })
    expect(c.capturedAmount!.toFixed(2)).toBe((cents / 100).toFixed(2))
    const pays = await paymentsOf(a.orderId)
    expect(pays).toHaveLength(1)
    expect(pays[0]).toMatchObject({ status: 'COMPLETED', type: 'REGULAR', processorId: a.charge.paymentIntentId, source: 'WEB' })
    expect(pays[0].amount.toFixed(2)).toBe((cents / 100).toFixed(2))
    expect(await prisma.moneyAnomaly.count({ where: { stripeEventId: `ooc:CAPTURED_OUTSIDE:${a.charge.id}` } })).toBe(1)
    expect(outsideLogsOf(c.onlineOrderId!)).toBe(1)
    expect(await stuckLogs(a.charge.id)).toBe(0)
  }

  it('r2 R1: rechazar un pedido cuya tarjeta ya se cobró a mano → registra el cobro (CAPTURED, un Payment), anomalía y alerta UNA vez', async () => {
    const a = await authorizedOrder()
    capturedByHand(a.charge.paymentIntentId!)
    await expect(reject(a.orderId)).resolves.toEqual({ outcome: 'OK', status: 'REJECTED' })
    await expectRecordedOnce(a)
    // El conciliador ya no lo ve atorado ni lo reintenta; otra pasada no duplica nada.
    await quiet([a.charge.id])
    await reconcile(new Date(Date.now() + 20 * MIN))
    await reconcile(new Date(Date.now() + 40 * MIN))
    await expectRecordedOnce(a)
    // El seguimiento y la bandeja dicen la verdad: cobrado, no liberado.
    await expect(getTrackingByToken(a.trackingToken)).resolves.toMatchObject({ status: 'REJECTED', cardStatus: 'CAPTURED' })
    const { getInboxOrder } = await import('@/services/online-ordering/inbox.service')
    await expect(getInboxOrder({ venueId: venueId!, orderId: a.orderId })).resolves.toMatchObject({
      card: { status: 'CAPTURED', capturedAmount: 250 },
    })
    expect(captureSpy).not.toHaveBeenCalled() // no se cobró nada nuevo: se registró lo que ya pasó
  })

  it('r2 R1: vencer y cancelar el cliente con la tarjeta cobrada a mano → lo mismo (también con el monto real cobrado)', async () => {
    const b = await authorizedOrder()
    capturedByHand(b.charge.paymentIntentId!)
    await expect(expireOnlineOrder({ venueId: venueId!, orderId: b.orderId, now: new Date(Date.now() + 60 * MIN) })).resolves.toEqual({
      outcome: 'OK',
      status: 'EXPIRED',
    })
    await expectRecordedOnce(b)

    const c = await authorizedOrder()
    capturedByHand(c.charge.paymentIntentId!, 20_000) // el negocio cobró de menos a mano
    await expect(cancelOnlineOrderByCustomer({ venueId: venueId!, trackingToken: c.trackingToken })).resolves.toEqual({
      outcome: 'OK',
      status: 'CANCELLED_BY_CUSTOMER',
    })
    await expectRecordedOnce(c, 20_000)
  })

  it('r2 R1: el conciliador libera una cuenta cancelada por la caja con la tarjeta cobrada a mano → registra, sin RELEASE_STUCK', async () => {
    const a = await authorizedOrder()
    await prisma.order.update({ where: { id: a.orderId }, data: { status: 'CANCELLED' } })
    await quiet([a.charge.id])
    capturedByHand(a.charge.paymentIntentId!)
    await reconcile()
    await reconcile(new Date(Date.now() + 20 * MIN))
    await expectRecordedOnce(a)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: a.orderId } })).status).toBe('CANCELLED')
  })

  it('r2 R1: la liberación tardía de un borrador (monto distinto) que ya se cobró a mano → CAPTURED sin pedido, anomalía una vez', async () => {
    const key = nextKey()
    await draft({ key })
    const d = await chargeOf(key)
    const pi = `pi_itest_${RUN}_${++piSeq}`
    authSpy.mockResolvedValueOnce({ ...authorized(24_000), paymentIntentId: pi }) // apartado por otro monto → se libera tarde
    capturedByHand(pi, 24_000)
    await expect(confirmCardAuthorization(d.id)).resolves.toBe('CAPTURED_OUTSIDE')
    const c = await chargeById(d.id)
    expect(c).toMatchObject({ status: 'CAPTURED', onlineOrderId: null, lastError: 'CAPTURED_OUTSIDE' })
    expect(c.capturedAmount!.toFixed(2)).toBe('240.00')
    expect(await prisma.order.count({ where: { venueId: venueId!, externalId: `web:${key}` } })).toBe(0)
    expect(await prisma.moneyAnomaly.count({ where: { stripeEventId: `ooc:CAPTURED_OUTSIDE:${d.id}` } })).toBe(1)
    expect(outsideLogsOf(d.id)).toBe(1)
  })

  it('r2 R1: dos liberaciones a la vez del mismo cargo cobrado a mano → un solo Payment, una anomalía, una alerta', async () => {
    const a = await authorizedOrder()
    await prisma.onlineOrderCharge.update({ where: { id: a.charge.id }, data: { status: 'RELEASING' } })
    capturedByHand(a.charge.paymentIntentId!)
    await Promise.all([releaseCharge(a.charge.id), releaseCharge(a.charge.id)])
    await expectRecordedOnce(a)
  })

  it('conciliador: PENDING_AUTH vencido pero autorizado (aviso perdido) crea el pedido', async () => {
    const key = nextKey()
    await draft({ key })
    const c = await chargeOf(key)
    await prisma.onlineOrderCharge.update({ where: { id: c.id }, data: { checkoutExpiresAt: ago(MIN) } })
    await quiet([c.id])
    authSpy.mockResolvedValue(authorized())

    await expect(reconcile()).resolves.toMatchObject({ scanned: 1, finished: 1 })
    const after = await chargeOf(key)
    expect(after.status).toBe('AUTHORIZED')
    expect((await prisma.onlineOrder.findUniqueOrThrow({ where: { id: after.onlineOrderId! } })).status).toBe('PENDING_ACCEPTANCE')
  })

  it('conciliador: PENDING_AUTH sin sesión guardada repite la clave del último intento; si Stripe rechaza el vencimiento → ABANDONED', async () => {
    // A: Stripe sí creó la sesión pero la respuesta se perdió → la repetición la devuelve, se guarda y se confirma.
    const k1 = nextKey()
    const lostId = `cs_itest_${RUN}_lost_${seq}`
    spy.mockImplementationOnce(async (_m: any, p: any) => {
      const id = lostId
      sessions.set(p.idempotencyKey, { id, url: `https://checkout.stripe.test/${id}`, expiresAt: p.expiresAt })
      throw lost()
    })
    await expect(draft({ key: k1 })).rejects.toMatchObject({ code: 'CARD_PROVIDER_UNAVAILABLE' })
    const a = await chargeOf(k1)
    expect(a.checkoutSessionId).toBeNull()

    // B: la clave nunca se ejecutó y ya pasó el vencimiento: Stripe rechaza expires_at.
    const k2 = nextKey()
    spy.mockRejectedValueOnce(new Error('Stripe no responde'))
    await expect(draft({ key: k2 })).rejects.toMatchObject({ code: 'CARD_PROVIDER_UNAVAILABLE' })
    const b = await chargeOf(k2)

    const [paramsA, paramsB] = spy.mock.calls.map(([, p]) => p)
    await quiet([a.id, b.id])
    spy.mockClear()
    spy.mockImplementation(async (_m: any, p: any) => {
      const s = sessions.get(p.idempotencyKey)
      if (s) return s
      throw Object.assign(new Error('expires_at must be at least 30 minutes in the future'), {
        type: 'StripeInvalidRequestError',
        param: 'expires_at',
      })
    })
    authSpy.mockResolvedValue(authorized())

    // Ya pasó el vencimiento guardado de los dos (35 min).
    await expect(reconcile(new Date(Date.now() + 40 * MIN))).resolves.toMatchObject({ scanned: 2, finished: 1, abandoned: 1 })
    // La MISMA clave y los MISMOS parámetros que el intento original (Stripe los compara).
    const sent = spy.mock.calls.map(([, p]) => p)
    expect(sent).toHaveLength(2)
    expect(sent).toEqual(expect.arrayContaining([paramsA, paramsB]))
    expect(paramsA.idempotencyKey).toBe(`online-order-charge:${a.id}:checkout:1`)
    expect(await chargeOf(k1)).toMatchObject({ status: 'AUTHORIZED', checkoutSessionId: lostId })
    expect(await chargeOf(k2)).toMatchObject({ status: 'ABANDONED', checkoutSessionId: null })
  })

  it('conciliador: un cargo que lanza no impide procesar los demás', async () => {
    const key = nextKey()
    await draft({ key })
    const template = await chargeOf(key)
    const bad = await expiredDraftRow({ template, updatedAt: ago(10 * MIN) })
    const good = await expiredDraftRow({ template, updatedAt: ago(9 * MIN) })
    await quiet([bad.id, good.id])
    authSpy.mockImplementation(async (_m: any, ref: any) => {
      if (ref.checkoutSessionId === bad.checkoutSessionId) throw lost()
      return { ...authorized(), sessionStatus: 'expired', paymentIntentId: null, piStatus: null, amountCapturableCents: 0 }
    })

    await expect(reconcile()).resolves.toMatchObject({ scanned: 2, abandoned: 1, errors: 1 })
    expect((await chargeById(good.id)).status).toBe('ABANDONED')
    expect(await chargeById(bad.id)).toMatchObject({ status: 'PENDING_AUTH', attempts: 1 })
  })

  it('ruling 4: un lote lleno de cargos que truenan no tapa para siempre al sano de atrás (lo procesa en 2 pasadas)', async () => {
    const key = nextKey()
    await draft({ key })
    const template = await chargeOf(key)
    const bads = []
    for (let n = 0; n < CARD_RECONCILE_BATCH; n++) bads.push(await expiredDraftRow({ template, updatedAt: ago(20 * MIN - n) }))
    const good = await expiredDraftRow({ template, updatedAt: ago(5 * MIN) })
    await quiet([...bads.map(b => b.id), good.id])
    const badSessions = new Set(bads.map(b => b.checkoutSessionId))
    authSpy.mockImplementation(async (_m: any, ref: any) => {
      if (badSessions.has(ref.checkoutSessionId)) throw lost()
      return { ...authorized(), sessionStatus: 'expired', paymentIntentId: null, piStatus: null, amountCapturableCents: 0 }
    })

    await expect(reconcile()).resolves.toMatchObject({ scanned: CARD_RECONCILE_BATCH, errors: CARD_RECONCILE_BATCH })
    expect((await chargeById(good.id)).status).toBe('PENDING_AUTH')
    await expect(reconcile()).resolves.toMatchObject({ abandoned: 1 })
    expect((await chargeById(good.id)).status).toBe('ABANDONED')
  })

  it('conciliador: alerta 🚨 una sola vez a los 15 min y borra la marca al terminar', async () => {
    const errorSpy = jest.spyOn(logger, 'error')
    try {
      const { charge, orderId } = await authorizedOrder()
      voidSpy.mockRejectedValue(lost())
      await expect(reject(orderId)).resolves.toEqual({ outcome: 'OK', status: 'REJECTED' })
      await quiet([charge.id])
      const t0 = new Date()
      const alerts = () =>
        errorSpy.mock.calls.filter(([m, meta]: any[]) => m === '🚨 [OnlineOrderCard] cargo atorado' && meta?.chargeId === charge.id)

      await expect(reconcile(t0)).resolves.toMatchObject({ stuck: 1 })
      expect((await chargeById(charge.id)).inDoubtSince).toEqual(t0)
      await reconcile(new Date(t0.getTime() + 10 * MIN))
      expect(alerts()).toHaveLength(0)
      expect(await stuckLogs(charge.id)).toBe(0)

      await reconcile(new Date(t0.getTime() + 16 * MIN))
      await reconcile(new Date(t0.getTime() + 17 * MIN))
      expect(alerts()).toHaveLength(1)
      expect((alerts()[0] as unknown[])[1]).toMatchObject({ chargeId: charge.id, status: 'RELEASING', venueId })
      expect(await stuckLogs(charge.id)).toBe(1)
      expect((await chargeById(charge.id)).stuckAlertedAt).toBeInstanceOf(Date)

      voidSpy.mockImplementation(async (_m: any, p: any) => ({ ...authorized(), paymentIntentId: p.paymentIntentId, piStatus: 'canceled' }))
      await expect(reconcile(new Date(t0.getTime() + 18 * MIN))).resolves.toMatchObject({ released: 1 })
      expect(await chargeById(charge.id)).toMatchObject({ status: 'RELEASED', stuckAlertedAt: null, inDoubtSince: null })
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('ruling 3: un CAPTURING con TOTAL_CHANGED alerta de inmediato y una sola vez', async () => {
    const { charge, orderId } = await authorizedOrder()
    captureSpy.mockImplementationOnce(async (_m: any, p: any) => {
      await prisma.order.update({ where: { id: orderId }, data: { total: new Prisma.Decimal('300.00') } })
      return capturedState(p)
    })
    await expect(accept(orderId)).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
    await prisma.onlineOrderCharge.update({ where: { id: charge.id }, data: { updatedAt: ago(2 * MIN) } })
    await quiet([charge.id])
    authSpy.mockResolvedValue(capturedState({ paymentIntentId: charge.paymentIntentId!, amountCents: 25_000 }))

    const t0 = new Date()
    await expect(reconcile(t0)).resolves.toMatchObject({ stuck: 1 })
    await reconcile(new Date(t0.getTime() + 2 * MIN))
    expect(await chargeById(charge.id)).toMatchObject({ status: 'CAPTURING', lastError: 'TOTAL_CHANGED', stuckAlertedAt: expect.any(Date) })
    expect(await stuckLogs(charge.id, 'ONLINE_ORDER_CARD_CAPTURE_STUCK')).toBe(1)
    expect(await paymentsOf(orderId)).toHaveLength(0)
  })

  it('ruling 3: un PENDING_AUTH vencido cuya confirmación truena 3 pasadas alerta una sola vez', async () => {
    const key = nextKey()
    await draft({ key })
    const template = await chargeOf(key)
    const bad = await expiredDraftRow({ template, updatedAt: ago(10 * MIN) })
    await quiet([bad.id])
    authSpy.mockRejectedValue(lost())

    await reconcile()
    await reconcile()
    expect(await stuckLogs(bad.id, 'ONLINE_ORDER_CARD_CONFIRM_STUCK')).toBe(0)
    await reconcile()
    await reconcile()
    expect(await stuckLogs(bad.id, 'ONLINE_ORDER_CARD_CONFIRM_STUCK')).toBe(1)
    expect(await chargeById(bad.id)).toMatchObject({ status: 'PENDING_AUTH', attempts: 4, stuckAlertedAt: expect.any(Date) })
  })

  it('fix r1: un PENDING_AUTH sin sesión de más de 23 h cuya repetición dice expires_at inválido NO se abandona: alerta una vez', async () => {
    const key = nextKey()
    await draft({ key })
    const template = await chargeOf(key)
    const old = await expiredDraftRow({ template, session: null, updatedAt: ago(10 * MIN) })
    await prisma.onlineOrderCharge.update({ where: { id: old.id }, data: { createdAt: ago(24 * 60 * MIN) } })
    await quiet([old.id])
    spy.mockClear()
    spy.mockImplementation(async () => {
      throw Object.assign(new Error('expires_at must be at least 30 minutes in the future'), {
        type: 'StripeInvalidRequestError',
        param: 'expires_at',
      })
    })

    await expect(reconcile()).resolves.toMatchObject({ scanned: 1, abandoned: 0, errors: 0 })
    await reconcile()
    expect(spy).toHaveBeenCalledTimes(2)
    expect(await chargeById(old.id)).toMatchObject({ status: 'PENDING_AUTH', checkoutSessionId: null, stuckAlertedAt: expect.any(Date) })
    expect(await stuckLogs(old.id, 'ONLINE_ORDER_CARD_CONFIRM_STUCK')).toBe(1)
    expect(authSpy).not.toHaveBeenCalled()
  })
})
