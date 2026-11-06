// tests/unit/services/online-ordering/card/draft.service.test.ts
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/online-ordering/presence.service', () => ({ __esModule: true, getAcceptingStatus: jest.fn() }))
jest.mock('@/services/online-ordering/quote.service', () => ({
  __esModule: true,
  quoteCart: jest.fn(),
  toPublicQuote: jest.fn((q: any) => ({ total: Number(q.total.toFixed(2)) })),
}))
jest.mock('@/services/superadmin/platformSettings.service', () => ({ __esModule: true, getVatRateBps: jest.fn(async () => 1600) }))
const createAuthorizationCheckout = jest.fn()
jest.mock('@/services/payments/provider-registry', () => ({
  __esModule: true,
  getProvider: jest.fn(() => ({ createAuthorizationCheckout })),
}))

import { getAcceptingStatus } from '@/services/online-ordering/presence.service'
import { quoteCart } from '@/services/online-ordering/quote.service'
import { onlineOrderRequestHash } from '@/services/online-ordering/order.service'
import { createCardOnlineDraft } from '@/services/online-ordering/card/draft.service'

const D = (v: string) => new Prisma.Decimal(v)
const NOW = new Date('2026-10-28T18:00:00.000Z')
const KEY = 'c'.repeat(32)
const PHONE = '+525543453965'
const PUEDE_CREAR = { assertCanCreate: async () => {} }
const OPEN = { status: 'OPEN', reason: null, config: { acceptsPayAtPickup: true } }
const QUOTE_OK = {
  ok: true,
  issues: [],
  subtotal: D('250.00'),
  total: D('250.00'),
  minOrderAmount: D('0'),
  lines: [
    {
      productId: 'p1',
      productName: 'Flautas',
      productSku: 'FLA-1',
      categoryName: 'Flautas',
      quantity: 1,
      unitPrice: D('250.00'),
      modifiers: [],
      note: null,
      lineTotal: D('250.00'),
    },
  ],
}
const MERCHANT = {
  id: 'em1',
  active: true,
  chargesEnabled: true,
  platformFeeBps: 100,
  sandboxMode: true,
  providerCredentials: { connectAccountId: 'acct_123' },
  provider: { code: 'STRIPE_CONNECT' },
}

const input = (o: Record<string, unknown> = {}) => ({
  venueId: 'v1',
  venueSlug: 'flautas',
  idempotencyKey: KEY,
  items: [{ productId: 'p1', quantity: 1 }],
  expectedTotal: '250.00',
  customer: { name: 'María G.', phone: '55 4345 3965', email: 'maria@test.com' },
  note: null,
  whatsappConsent: false,
  now: NOW,
  ...o,
})
const huella = () =>
  onlineOrderRequestHash({
    venueId: 'v1',
    customerId: 'card',
    paymentMode: 'CARD_ONLINE',
    expectedTotal: '250.00',
    items: [{ productId: 'p1', quantity: 1 }],
    customerName: 'María G.',
    customerPhone: PHONE,
  })
const EXPIRES = new Date(NOW.getTime() + 35 * 60_000)
const charge = (o: Record<string, unknown> = {}) => ({
  id: 'ch1',
  venueId: 'v1',
  ecommerceMerchantId: 'em1',
  idempotencyKey: KEY,
  trackingToken: 'T'.repeat(32),
  customerPhone: PHONE,
  requestHash: huella(),
  request: {
    customer: { name: 'María G.', phone: PHONE, email: 'maria@test.com' },
    successUrl: `https://pedidos.test/flautas/pedido/${'T'.repeat(32)}?pago=1`,
    cancelUrl: `https://pedidos.test/flautas/pedido/${'T'.repeat(32)}?pago=cancelado`,
  },
  amount: D('250.00'),
  checkoutSessionId: 'cs_1',
  checkoutUrl: 'https://checkout.stripe.test/cs_1',
  checkoutExpiresAt: EXPIRES,
  checkoutAttempt: 1,
  status: 'PENDING_AUTH',
  merchantSnapshot: { connectAccountId: 'acct_123', sandboxMode: true, providerCode: 'STRIPE_CONNECT' },
  ...o,
})
const expectCode = async (p: Promise<unknown>, statusCode: number, code: string) => expect(p).rejects.toMatchObject({ statusCode, code })

beforeEach(() => {
  process.env.ORDERING_STOREFRONT_BASE_URL = 'https://pedidos.test'
  delete process.env.STRIPE_MIN_CHARGE_MXN_CENTS
  ;(getAcceptingStatus as jest.Mock).mockResolvedValue(OPEN)
  ;(quoteCart as jest.Mock).mockResolvedValue(QUOTE_OK)
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.onlineOrderCharge.findUnique.mockReset()
  prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(null)
  prismaMock.onlineOrderCharge.count.mockResolvedValue(0)
  prismaMock.onlineOrderCharge.create.mockImplementation(async (a: any) => ({
    id: 'ch1',
    status: 'PENDING_AUTH',
    checkoutAttempt: 1,
    checkoutSessionId: null,
    checkoutUrl: null,
    ...a.data,
  }))
  prismaMock.onlineOrderCharge.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.onlineOrderCharge.update.mockResolvedValue({})
  prismaMock.onlineOrder.count.mockResolvedValue(0)
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ acceptsCardOnline: true, requiresAcceptance: true } as any)
  prismaMock.ecommerceMerchant.findMany.mockResolvedValue([MERCHANT] as any)
  createAuthorizationCheckout.mockReset()
  createAuthorizationCheckout.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1', expiresAt: EXPIRES })
})

describe('createCardOnlineDraft — borrador + sesión de Stripe', () => {
  it('crea el borrador con comisión, vencimiento y foto del comercio fijos, y pide la sesión con la clave del cargo', async () => {
    const r = await createCardOnlineDraft(input(), PUEDE_CREAR)

    expect(r).toEqual({
      trackingToken: expect.any(String),
      checkoutUrl: 'https://checkout.stripe.test/cs_1',
      status: 'AWAITING_PAYMENT',
      total: '250.00',
      replay: false,
    })
    const data = (prismaMock.onlineOrderCharge.create.mock.calls[0][0] as any).data
    expect(data).toMatchObject({
      venueId: 'v1',
      ecommerceMerchantId: 'em1',
      idempotencyKey: KEY,
      customerPhone: PHONE,
      requestHash: huella(),
      platformFeeBps: 100,
      // calculateApplicationFeeWithVAT(25000, 100, 1600) = 290
      applicationFeeCents: 290,
      checkoutExpiresAt: EXPIRES,
      merchantSnapshot: { connectAccountId: 'acct_123', sandboxMode: true, providerCode: 'STRIPE_CONNECT' },
    })
    expect(data.amount.toFixed(2)).toBe('250.00')
    expect(data.request).toMatchObject({ externalId: `web:${KEY}`, customer: { name: 'María G.', phone: PHONE }, whatsappConsent: false })
    expect(data.request.quote.total).toBe('250')
    expect(data).not.toHaveProperty('customerId')

    expect(createAuthorizationCheckout).toHaveBeenCalledTimes(1)
    const [merchant, params] = createAuthorizationCheckout.mock.calls[0]
    expect(merchant).toMatchObject({
      id: 'em1',
      providerCredentials: { connectAccountId: 'acct_123' },
      provider: { code: 'STRIPE_CONNECT' },
    })
    expect(params).toMatchObject({
      amountCents: 25000,
      currency: 'MXN',
      expiresAt: EXPIRES,
      customerEmail: 'maria@test.com',
      metadata: { type: 'online_order', chargeId: 'ch1', venueId: 'v1' },
      idempotencyKey: 'online-order-charge:ch1:checkout:1',
      successUrl: `https://pedidos.test/flautas/pedido/${r.trackingToken}?pago=1`,
      cancelUrl: `https://pedidos.test/flautas/pedido/${r.trackingToken}?pago=cancelado`,
    })
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'ch1', checkoutSessionId: null },
      data: { checkoutSessionId: 'cs_1', checkoutUrl: 'https://checkout.stripe.test/cs_1', lastError: null },
    })
    // No hay cuenta todavía: nace al autorizarse (T5).
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('Codex r4 #8: una repetición se reconoce ANTES de revisar tienda, plan, switch o precios', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(charge() as any)
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({ status: 'CLOSED', reason: 'OUTSIDE_HOURS', config: {} })
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ acceptsCardOnline: false } as any)
    const opts = { assertCanCreate: jest.fn(async () => Promise.reject(new Error('no debe llamarse'))) }

    const r = await createCardOnlineDraft(input(), opts)

    expect(r).toEqual({
      trackingToken: 'T'.repeat(32),
      checkoutUrl: 'https://checkout.stripe.test/cs_1',
      status: 'AWAITING_PAYMENT',
      total: '250.00',
      replay: true,
    })
    expect(opts.assertCanCreate).not.toHaveBeenCalled()
    expect(quoteCart).not.toHaveBeenCalled()
    expect(createAuthorizationCheckout).not.toHaveBeenCalled()
    expect(prismaMock.onlineOrderCharge.create).not.toHaveBeenCalled()
  })

  it('S7 (Codex plan r2 #5): una repetición con la página de pago ya vencida no manda checkoutUrl; vigente, la misma URL', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(charge({ checkoutExpiresAt: NOW }) as any)
    await expect(createCardOnlineDraft(input(), PUEDE_CREAR)).resolves.toMatchObject({
      replay: true,
      checkoutUrl: '',
      status: 'AWAITING_PAYMENT',
    })
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(charge({ checkoutExpiresAt: new Date(NOW.getTime() + 1) }) as any)
    await expect(createCardOnlineDraft(input(), PUEDE_CREAR)).resolves.toMatchObject({
      replay: true,
      checkoutUrl: 'https://checkout.stripe.test/cs_1',
    })
    expect(createAuthorizationCheckout).not.toHaveBeenCalled()
  })

  it('Codex r3 #1: la repetición vale aunque el borrador ya tenga cuenta (no 409)', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(charge({ status: 'AUTHORIZED', onlineOrderId: 'oo1' }) as any)
    prismaMock.order.findUnique.mockResolvedValue({ id: 'ord1' } as any)
    prismaMock.onlineOrder.findUnique.mockResolvedValue({ status: 'PENDING_ACCEPTANCE' } as any)
    // Tarea 5: con cuenta ya creada, la repetición dice SU estado real (el mismo que el seguimiento), no AWAITING_PAYMENT.
    await expect(createCardOnlineDraft(input(), PUEDE_CREAR)).resolves.toMatchObject({
      replay: true,
      trackingToken: 'T'.repeat(32),
      status: 'PENDING_ACCEPTANCE',
    })
    expect(prismaMock.onlineOrder.findUnique).toHaveBeenCalledWith({ where: { id: 'oo1' }, select: { status: true } })
  })

  it('misma llave con otra solicitud → 409 IDEMPOTENCY_KEY_CONFLICT (final)', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(charge({ requestHash: 'otra' }) as any)
    await expect(createCardOnlineDraft(input(), PUEDE_CREAR)).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      final: true,
    })
  })

  it('Codex r3 #1: la llave ya es de un pedido al recoger → 409 antes de crear Checkout', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ id: 'ord1' } as any)
    await expectCode(createCardOnlineDraft(input(), PUEDE_CREAR), 409, 'IDEMPOTENCY_KEY_CONFLICT')
    expect(prismaMock.onlineOrderCharge.create).not.toHaveBeenCalled()
    expect(createAuthorizationCheckout).not.toHaveBeenCalled()
  })

  it('switch apagado → 400 CARD_PAYMENT_NOT_ACCEPTED', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ acceptsCardOnline: false } as any)
    await expectCode(createCardOnlineDraft(input(), PUEDE_CREAR), 400, 'CARD_PAYMENT_NOT_ACCEPTED')
    expect(prismaMock.onlineOrderCharge.create).not.toHaveBeenCalled()
  })

  it('T8: un borrador nuevo en «Nadie» → 400 PAYMENT_MODE_NOT_ACCEPTED y nada se crea', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ acceptsCardOnline: true, requiresAcceptance: false } as any)
    await expectCode(createCardOnlineDraft(input(), PUEDE_CREAR), 400, 'PAYMENT_MODE_NOT_ACCEPTED')
    expect(prismaMock.onlineOrderCharge.create).not.toHaveBeenCalled()
    expect(createAuthorizationCheckout).not.toHaveBeenCalled()
  })

  it('sin comercio Stripe cobrable → 400 CARD_PAYMENT_NOT_ACCEPTED', async () => {
    prismaMock.ecommerceMerchant.findMany.mockResolvedValue([{ ...MERCHANT, chargesEnabled: false }] as any)
    await expectCode(createCardOnlineDraft(input(), PUEDE_CREAR), 400, 'CARD_PAYMENT_NOT_ACCEPTED')
  })

  it('total fuera de rango → 400 CARD_AMOUNT_OUT_OF_RANGE, sin borrador', async () => {
    process.env.STRIPE_MIN_CHARGE_MXN_CENTS = '100000'
    await expectCode(createCardOnlineDraft(input(), PUEDE_CREAR), 400, 'CARD_AMOUNT_OUT_OF_RANGE')
    expect(prismaMock.onlineOrderCharge.create).not.toHaveBeenCalled()
  })

  it('PRICE_CHANGED y CART_INVALID igual que pagar al recoger', async () => {
    await expectCode(createCardOnlineDraft(input({ expectedTotal: '249.00' }), PUEDE_CREAR), 409, 'PRICE_CHANGED')
    ;(quoteCart as jest.Mock).mockResolvedValue({ ...QUOTE_OK, ok: false, issues: [{ code: 'X' }] })
    await expectCode(createCardOnlineDraft(input(), PUEDE_CREAR), 400, 'CART_INVALID')
  })

  it('el tope por teléfono cuenta pedidos por aceptar MÁS borradores vigentes', async () => {
    prismaMock.onlineOrder.count.mockResolvedValue(1)
    prismaMock.onlineOrderCharge.count.mockResolvedValue(2)
    await expectCode(createCardOnlineDraft(input(), PUEDE_CREAR), 409, 'TOO_MANY_PENDING_ORDERS')
    expect(prismaMock.onlineOrderCharge.count).toHaveBeenCalledWith({
      where: { venueId: 'v1', status: 'PENDING_AUTH', checkoutExpiresAt: { gt: NOW }, customerPhone: PHONE },
    })
  })

  it('tienda híbrida: con 30 folios vivos y el negocio de vuelta en «Mi equipo», un borrador nuevo no responde ORDERING_PAUSED ni TOO_BUSY', async () => {
    prismaMock.onlineOrder.count.mockImplementation((({ where }: any) => Promise.resolve(where.requiresAcceptance === true ? 0 : 30)) as any)
    await expect(createCardOnlineDraft(input(), PUEDE_CREAR)).resolves.toBeDefined()
  })

  it('Codex r1 #3: si Stripe falla, el cargo sigue PENDING_AUTH con lastError → 502; el reintento repite clave y parámetros', async () => {
    createAuthorizationCheckout.mockRejectedValueOnce(new Error('stripe caído'))
    await expectCode(createCardOnlineDraft(input(), PUEDE_CREAR), 502, 'CARD_PROVIDER_UNAVAILABLE')
    // Un gemelo que falla nunca escribe encima de una sesión ya guardada.
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'ch1', checkoutSessionId: null },
      data: { lastError: 'stripe caído', attempts: { increment: 1 } },
    })
    const first = createAuthorizationCheckout.mock.calls[0][1]

    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(
      charge({
        checkoutSessionId: null,
        checkoutUrl: null,
        trackingToken: (prismaMock.onlineOrderCharge.create.mock.calls[0][0] as any).data.trackingToken,
        request: (prismaMock.onlineOrderCharge.create.mock.calls[0][0] as any).data.request,
      }) as any,
    )
    const r = await createCardOnlineDraft(input(), PUEDE_CREAR)
    expect(r).toMatchObject({ replay: true, checkoutUrl: 'https://checkout.stripe.test/cs_1' })
    expect(createAuthorizationCheckout).toHaveBeenCalledTimes(2)
    expect(createAuthorizationCheckout.mock.calls[1][1]).toEqual(first)
  })

  it('Codex r2 #4: si Stripe dice que expires_at ya no vale, sube a checkoutAttempt 2 con vencimiento nuevo', async () => {
    const later = new Date(NOW.getTime() + 10 * 60_000) // quedan 25 min del vencimiento guardado
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(charge({ checkoutSessionId: null, checkoutUrl: null }) as any)
    prismaMock.onlineOrderCharge.findUniqueOrThrow.mockResolvedValue(
      charge({
        checkoutSessionId: null,
        checkoutUrl: null,
        checkoutAttempt: 2,
        checkoutExpiresAt: new Date(later.getTime() + 35 * 60_000),
      }) as any,
    )
    createAuthorizationCheckout.mockRejectedValueOnce(
      Object.assign(new Error('expires_at must be at least 30 minutes'), { type: 'StripeInvalidRequestError', param: 'expires_at' }),
    )

    const r = await createCardOnlineDraft(input({ now: later }), PUEDE_CREAR)

    expect(r).toMatchObject({ replay: true, checkoutUrl: 'https://checkout.stripe.test/cs_1' })
    expect(createAuthorizationCheckout.mock.calls[0][1]).toMatchObject({
      idempotencyKey: 'online-order-charge:ch1:checkout:1',
      expiresAt: EXPIRES,
    })
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'ch1', checkoutAttempt: 1, checkoutSessionId: null, status: 'PENDING_AUTH' },
      data: { checkoutAttempt: 2, checkoutExpiresAt: new Date(later.getTime() + 35 * 60_000) },
    })
    expect(createAuthorizationCheckout.mock.calls[1][1]).toMatchObject({
      idempotencyKey: 'online-order-charge:ch1:checkout:2',
      expiresAt: new Date(later.getTime() + 35 * 60_000),
    })
  })
})
