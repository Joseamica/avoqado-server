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
import { createCardOnlineDraft } from '@/services/online-ordering/card/draft.service'
import { clearPublicMenuCache } from '@/services/online-ordering/menu.service'
import { createOnlineOrder, getTrackingByToken, writeOnlineOrderInTx } from '@/services/online-ordering/order.service'
import { __resetPresenceDebounceForTests, touchInboxPoll } from '@/services/online-ordering/presence.service'
import { updateSettings } from '@/services/online-ordering/settings.service'

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
  })

  beforeEach(async () => {
    spy.mockReset()
    stripeOk()
    authSpy.mockReset()
    voidSpy.mockReset()
    voidSpy.mockImplementation(async (_m: any, p: any) => ({ ...authorized(), paymentIntentId: p.paymentIntentId, piStatus: 'canceled' }))
    delete process.env.STRIPE_MIN_CHARGE_MXN_CENTS
    await expireLiveDrafts()
    await beat()
  })

  afterAll(async () => {
    spy?.mockRestore()
    authSpy?.mockRestore()
    voidSpy?.mockRestore()
    // Limpieza acotada: sin venueId NO se borra nada (una limpieza sin filtro vaciaría tablas enteras).
    if (!venueId) return
    const v = { venueId }
    await prisma.idempotencyRequest.deleteMany({ where: { organizationId: `venue:${venueId}` } })
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
})
