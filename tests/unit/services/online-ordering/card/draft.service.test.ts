// tests/unit/services/online-ordering/card/draft.service.test.ts
import { Prisma } from '@prisma/client'
import { ForbiddenError, ServiceUnavailableError } from '@/errors/AppError'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/online-ordering/presence.service', () => ({ __esModule: true, getAcceptingStatus: jest.fn() }))
jest.mock('@/services/online-ordering/quote.service', () => ({
  __esModule: true,
  quoteCart: jest.fn(),
  toPublicQuote: jest.fn((q: any) => ({ total: Number(q.total.toFixed(2)) })),
}))
jest.mock('@/services/superadmin/platformSettings.service', () => ({ __esModule: true, getVatRateBps: jest.fn(async () => 1600) }))
jest.mock('@/services/online-ordering/beneficios.service', () => ({
  __esModule: true,
  simularBeneficios: jest.fn(),
  cedeLaSimulacion: jest.fn(() => false),
}))
const createAuthorizationCheckout = jest.fn()
jest.mock('@/services/payments/provider-registry', () => ({
  __esModule: true,
  getProvider: jest.fn(() => ({ createAuthorizationCheckout })),
}))

import { getAcceptingStatus } from '@/services/online-ordering/presence.service'
import { quoteCart, toPublicQuote } from '@/services/online-ordering/quote.service'
import { onlineOrderRequestHash } from '@/services/online-ordering/order.service'
import { createCardOnlineDraft } from '@/services/online-ordering/card/draft.service'
import { cedeLaSimulacion, simularBeneficios } from '@/services/online-ordering/beneficios.service'
import { decisionDePrecio } from '@/services/online-ordering/order.service'

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
  prismaMock.idempotencyRequest = { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) }
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
    prismaMock.onlineOrder.count.mockImplementation((({ where }: any) =>
      Promise.resolve(where.requiresAcceptance === true ? 0 : 30)) as any)
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

describe("S11 · el borrador con sesión calcula su propio total estricto (R2'', R1')", () => {
  const conSesion = (o: Record<string, unknown> = {}) =>
    input({ customerId: 'cust1', verifiedPhone: PHONE, beneficios: { premioId: 'r1' }, expectedTotal: '240.00', ...o })
  const simulado = (total: string, o: Record<string, unknown> = {}) => ({ total: D(total), aplicados: [], descartados: [], ...o })
  const huellaConSesion = (o: { expectedTotal?: string; beneficios?: any } = {}) =>
    onlineOrderRequestHash({
      venueId: 'v1',
      customerId: 'card:cust1',
      paymentMode: 'CARD_ONLINE',
      expectedTotal: o.expectedTotal ?? '240.00',
      items: [{ productId: 'p1', quantity: 1 }],
      customerName: 'María G.',
      customerPhone: PHONE,
      beneficios: o.beneficios === undefined ? { premioId: 'r1' } : o.beneficios,
    })
  /** La tabla de decisiones en memoria (identidad y precio). */
  const tabla = () => {
    const filas = new Map<string, any>()
    const k = (w: any) => JSON.stringify(Object.values(w.organizationId_actorStaffId_endpoint_idempotencyKey ?? w))
    prismaMock.idempotencyRequest.findUnique.mockImplementation((async (a: any) => filas.get(k(a.where)) ?? null) as any)
    prismaMock.idempotencyRequest.create.mockImplementation((async (a: any) => {
      const { organizationId, actorStaffId, endpoint, idempotencyKey } = a.data
      filas.set(k({ organizationId, actorStaffId, endpoint, idempotencyKey }), a.data)
      return a.data
    }) as any)
    return filas
  }

  beforeEach(() => {
    ;(simularBeneficios as jest.Mock).mockReset()
    ;(simularBeneficios as jest.Mock).mockResolvedValue(simulado('240.00'))
    ;(cedeLaSimulacion as jest.Mock).mockReturnValue(false)
  })

  it('el borrador con sesión guarda customerId y la elección; lo autorizado es el total de la simulación; la huella es card:<id>', async () => {
    await createCardOnlineDraft(conSesion(), PUEDE_CREAR)
    expect(simularBeneficios).toHaveBeenCalledWith('v1', QUOTE_OK, 'cust1', { premioId: 'r1' })
    const data = (prismaMock.onlineOrderCharge.create.mock.calls[0][0] as any).data
    expect(data.amount.toFixed(2)).toBe('240.00')
    expect(data.requestHash).toBe(huellaConSesion())
    expect(data.request).toMatchObject({ customerId: 'cust1', beneficios: { premioId: 'r1' } })
    expect(createAuthorizationCheckout.mock.calls[0][1]).toMatchObject({ amountCents: 24000 })
  })

  it("con sesión y otro teléfono (no probado) el borrador es el de hoy: sin clienta, sin simular y huella 'card'", async () => {
    await createCardOnlineDraft(input({ customerId: 'cust1', verifiedPhone: '+525511112222' }), PUEDE_CREAR)
    expect(simularBeneficios).not.toHaveBeenCalled()
    const data = (prismaMock.onlineOrderCharge.create.mock.calls[0][0] as any).data
    expect(data.requestHash).toBe(huella())
    expect(data.request).toMatchObject({ customerId: null, beneficios: null })
  })

  it('S10 degradado + automático de $10: el total estricto (90) difiere de lo que vio ⇒ PRICE_CHANGED con totalEstricto, guardado bajo negocio + llave, sin Checkout', async () => {
    tabla()
    ;(simularBeneficios as jest.Mock).mockResolvedValue(simulado('225.00'))
    const err = await createCardOnlineDraft(conSesion({ beneficios: undefined, expectedTotal: '250.00' }), PUEDE_CREAR).catch(
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ statusCode: 409, code: 'PRICE_CHANGED', final: true, details: { totalEstricto: 225, descartados: [] } })
    expect(prismaMock.onlineOrderCharge.create).not.toHaveBeenCalled()
    expect(createAuthorizationCheckout).not.toHaveBeenCalled()
    const guardada = (prismaMock.idempotencyRequest.create as jest.Mock).mock.calls[0][0].data
    expect(guardada).toMatchObject({ ...decisionDePrecio('v1', KEY), responseStatus: 409 })
    // La corrección con K2 y el total estricto sí abre su borrador.
    await createCardOnlineDraft(conSesion({ beneficios: undefined, expectedTotal: '225.00', idempotencyKey: 'k'.repeat(32) }), PUEDE_CREAR)
    expect((prismaMock.onlineOrderCharge.create.mock.calls[0][0] as any).data.amount.toFixed(2)).toBe('225.00')
  })

  it('Codex r8: más de 500 filas ⇒ PRICE_CHANGED con el totalEstricto correcto, SIN desglose y calculados:false (serializador REAL)', async () => {
    const real = jest.requireActual('@/services/online-ordering/quote.service') as typeof import('@/services/online-ordering/quote.service')
    ;(toPublicQuote as jest.Mock).mockImplementationOnce(real.toPublicQuote)
    // 500 automáticos de $0.01 en el desglose y el premio de $10 FUERA del tope: $250 − $5 − $10 = $235 ≠ $240.
    const recortado = Array.from({ length: 500 }, (_, i) => ({
      tipo: 'DESCUENTO',
      nombre: `Auto ${i}`,
      monto: D('0.01'),
      orderDiscountId: `od${i}`,
    }))
    ;(simularBeneficios as jest.Mock).mockResolvedValue(
      simulado('235.00', { aplicados: recortado, aplicadosCompletos: false, premio: true }),
    )
    const err = (await createCardOnlineDraft(conSesion(), PUEDE_CREAR).catch((e: unknown) => e)) as any
    expect(err).toMatchObject({ statusCode: 409, code: 'PRICE_CHANGED', details: { totalEstricto: 235, descartados: [] } })
    expect(err.details.quote).toMatchObject({ beneficios: { calculados: false }, total: 250 })
    expect(err.details.quote).not.toHaveProperty('aplicados')
    expect(JSON.stringify(err.details)).not.toMatch(/Auto 0|aplicadosCompletos/)
    expect(createAuthorizationCheckout).not.toHaveBeenCalled()
  })

  it('un beneficio elegido que ya no está ⇒ PRICE_CHANGED con descartados de la MISMA simulación', async () => {
    ;(simularBeneficios as jest.Mock).mockResolvedValue(simulado('250.00', { descartados: ['PREMIO'] }))
    await expect(createCardOnlineDraft(conSesion(), PUEDE_CREAR)).rejects.toMatchObject({
      code: 'PRICE_CHANGED',
      details: { totalEstricto: 250, descartados: ['PREMIO'] },
    })
    expect(createAuthorizationCheckout).not.toHaveBeenCalled()
  })

  it('si la simulación cede por infraestructura ⇒ 503 reintentable, nunca un precio inventado ni una decisión guardada', async () => {
    ;(simularBeneficios as jest.Mock).mockRejectedValue(Object.assign(new Error('lock timeout'), { code: '55P03' }))
    ;(cedeLaSimulacion as jest.Mock).mockReturnValue(true)
    await expect(createCardOnlineDraft(conSesion(), PUEDE_CREAR)).rejects.toMatchObject({
      statusCode: 503,
      code: 'BENEFITS_CALCULATION_UNAVAILABLE',
    })
    expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
    expect(prismaMock.onlineOrderCharge.create).not.toHaveBeenCalled()
  })

  it('total con beneficios en $0 ⇒ ZERO_TOTAL al pedir con tarjeta (la tienda pasa al flujo sin tarjeta)', async () => {
    ;(simularBeneficios as jest.Mock).mockResolvedValue(simulado('0.00'))
    await expectCode(createCardOnlineDraft(conSesion({ expectedTotal: '0.00' }), PUEDE_CREAR), 400, 'ZERO_TOTAL')
    expect(createAuthorizationCheckout).not.toHaveBeenCalled()
  })

  it('sin sesión y con beneficios en el cuerpo ⇒ PRICE_CHANGED motivo SIN_SESION, guardado bajo negocio + llave', async () => {
    tabla()
    await expect(createCardOnlineDraft(input({ beneficios: { premioId: 'r1' } }), PUEDE_CREAR)).rejects.toMatchObject({
      code: 'PRICE_CHANGED',
      final: true,
      details: { motivo: 'SIN_SESION' },
    })
    expect(simularBeneficios).not.toHaveBeenCalled()
    expect((prismaMock.idempotencyRequest.create as jest.Mock).mock.calls[0][0].data).toMatchObject(decisionDePrecio('v1', KEY))
  })

  it("R1': una K que ya tiene decisión de precio (de pagar al recoger o de un borrador) no abre Checkout: otra huella ⇒ conflicto, la misma ⇒ esa decisión", async () => {
    const filas = tabla()
    filas.set(JSON.stringify(Object.values(decisionDePrecio('v1', KEY))), {
      requestHash: 'de-pagar-al-recoger',
      responseStatus: 409,
      responseBody: { code: 'PRICE_CHANGED', message: 'El precio cambió', details: {} },
    })
    await expect(createCardOnlineDraft(conSesion(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', final: true })
    filas.set(JSON.stringify(Object.values(decisionDePrecio('v1', KEY))), {
      requestHash: huellaConSesion(),
      responseStatus: 409,
      responseBody: { code: 'PRICE_CHANGED', message: 'El precio cambió', details: { totalEstricto: 90 } },
    })
    await expect(createCardOnlineDraft(conSesion(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'PRICE_CHANGED', final: true })
    expect(prismaMock.onlineOrderCharge.create).not.toHaveBeenCalled()
    expect(createAuthorizationCheckout).not.toHaveBeenCalled()
  })
  describe("Codex r4 #1 (R1'): lo ya decidido sobre K gana ANTES de la tienda y del semáforo, bajo el candado de K", () => {
    const guardada = (filas: Map<string, any>) =>
      filas.set(JSON.stringify(Object.values(decisionDePrecio('v1', KEY))), {
        requestHash: huellaConSesion(),
        responseStatus: 409,
        responseBody: { code: 'PRICE_CHANGED', message: 'El precio cambió', details: { totalEstricto: 90 } },
      })
    const caminos: Array<[string, () => void]> = [
      [
        'tienda cerrada',
        () => (getAcceptingStatus as jest.Mock).mockResolvedValue({ status: 'CLOSED', reason: 'OUTSIDE_HOURS', config: {} }),
      ],
      ['semáforo lleno', () => (simularBeneficios as jest.Mock).mockResolvedValue(null)],
    ]

    it.each(caminos)('K rechazada + %s ⇒ la decisión guardada (no ORDERING_CLOSED ni 503), leída con K ya tomada', async (_, preparar) => {
      guardada(tabla())
      preparar()
      await expect(createCardOnlineDraft(conSesion(), PUEDE_CREAR)).rejects.toMatchObject({
        statusCode: 409,
        code: 'PRICE_CHANGED',
        final: true,
        details: { totalEstricto: 90 },
      })
      expect(simularBeneficios).not.toHaveBeenCalled()
      const candado = (prismaMock.$executeRaw as jest.Mock).mock.invocationCallOrder[0]
      const lectura = (prismaMock.idempotencyRequest.findUnique as jest.Mock).mock.invocationCallOrder[0]
      expect(candado).toBeLessThan(lectura)
      expect(prismaMock.onlineOrderCharge.create).not.toHaveBeenCalled()
      expect(createAuthorizationCheckout).not.toHaveBeenCalled()
    })

    it.each(caminos)('K rechazada + otra elección con la misma K + %s ⇒ IDEMPOTENCY_KEY_CONFLICT', async (_, preparar) => {
      guardada(tabla())
      preparar()
      await expect(createCardOnlineDraft(conSesion({ beneficios: { premioId: 'r2' } }), PUEDE_CREAR)).rejects.toMatchObject({
        statusCode: 409,
        code: 'IDEMPOTENCY_KEY_CONFLICT',
        final: true,
      })
      expect(simularBeneficios).not.toHaveBeenCalled()
      expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
    })
    describe('Codex r6 · intercalado real: A lee K libre y espera el plan; B decide K; después A falla', () => {
      /** A se queda en la comprobación del plan hasta que se le suelta con un error (B ya terminó para entonces). */
      const enEspera = () => {
        let soltar!: (e: Error) => void
        const puerta = new Promise<Error>(r => (soltar = r))
        const opts = {
          assertCanCreate: jest.fn(async () => {
            throw await puerta
          }),
        }
        return { opts, soltar }
      }
      const hasta = async (cond: () => boolean) => {
        for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setImmediate(r))
        expect(cond()).toBe(true)
      }
      const casos: Array<[string, Record<string, unknown>, () => Error, Record<string, unknown>]> = [
        [
          '503 + la MISMA solicitud ⇒ la decisión de B',
          {},
          () => new ServiceUnavailableError('x', 'FEATURE_CHECK_UNAVAILABLE'),
          { statusCode: 409, code: 'PRICE_CHANGED', final: true, details: { totalEstricto: 225 } },
        ],
        [
          '503 + otra elección con K ⇒ IDEMPOTENCY_KEY_CONFLICT',
          { beneficios: { premioId: 'r2' } },
          () => new ServiceUnavailableError('x', 'FEATURE_CHECK_UNAVAILABLE'),
          { statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT', final: true },
        ],
        [
          'un rechazo definitivo que no se guarda (403 PLAN_REQUIRED) ⇒ la decisión de B',
          {},
          () => new ForbiddenError('x', 'PLAN_REQUIRED'),
          { statusCode: 409, code: 'PRICE_CHANGED', final: true, details: { totalEstricto: 225 } },
        ],
      ]

      it.each(casos)('%s', async (_, deA, caida, esperado) => {
        tabla()
        const a = enEspera()
        const respuestaDeA = createCardOnlineDraft(conSesion(deA), a.opts).catch((e: unknown) => e)
        await hasta(() => a.opts.assertCanCreate.mock.calls.length === 1) // A ya leyó K libre y espera
        expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
        // B, la misma solicitud con K, decide: su total estricto (225) no es el que vio ⇒ PRICE_CHANGED guardado.
        ;(simularBeneficios as jest.Mock).mockResolvedValueOnce(simulado('225.00'))
        await expect(createCardOnlineDraft(conSesion(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'PRICE_CHANGED' })
        expect(prismaMock.idempotencyRequest.create).toHaveBeenCalledTimes(1)
        a.soltar(caida())
        expect(await respuestaDeA).toMatchObject(esperado)
        expect(prismaMock.idempotencyRequest.create).toHaveBeenCalledTimes(1)
        expect(prismaMock.onlineOrderCharge.create).not.toHaveBeenCalled()
        expect(createAuthorizationCheckout).not.toHaveBeenCalled()
      })

      it('sin que nadie decida, A sale con su error de siempre', async () => {
        tabla()
        const a = enEspera()
        const respuestaDeA = createCardOnlineDraft(conSesion(), a.opts).catch((e: unknown) => e)
        await hasta(() => a.opts.assertCanCreate.mock.calls.length === 1)
        const caida = new ServiceUnavailableError('x', 'FEATURE_CHECK_UNAVAILABLE')
        a.soltar(caida)
        expect(await respuestaDeA).toBe(caida)
      })
    })

    describe('Codex r5: con el plan sin poder verificarse (503), también', () => {
      const PLAN_503 = {
        assertCanCreate: jest.fn(async () => {
          throw new ServiceUnavailableError('No pudimos verificar la disponibilidad. Intenta de nuevo.', 'FEATURE_CHECK_UNAVAILABLE')
        }),
      }
      beforeEach(() => PLAN_503.assertCanCreate.mockClear())

      it('K decidida + plan 503 ⇒ la decisión guardada, sin comprobar el plan', async () => {
        guardada(tabla())
        await expect(createCardOnlineDraft(conSesion(), PLAN_503)).rejects.toMatchObject({
          statusCode: 409,
          code: 'PRICE_CHANGED',
          final: true,
          details: { totalEstricto: 90 },
        })
        expect(PLAN_503.assertCanCreate).not.toHaveBeenCalled()
      })

      it('K decidida + otra elección + plan 503 ⇒ IDEMPOTENCY_KEY_CONFLICT', async () => {
        guardada(tabla())
        await expect(createCardOnlineDraft(conSesion({ beneficios: { premioId: 'r2' } }), PLAN_503)).rejects.toMatchObject({
          statusCode: 409,
          code: 'IDEMPOTENCY_KEY_CONFLICT',
          final: true,
        })
        expect(PLAN_503.assertCanCreate).not.toHaveBeenCalled()
      })

      it('la llave ya es de un pedido al recoger + plan 503 ⇒ IDEMPOTENCY_KEY_CONFLICT, no el 503', async () => {
        tabla()
        prismaMock.order.findUnique.mockResolvedValue({ id: 'o1' } as any)
        await expect(createCardOnlineDraft(conSesion(), PLAN_503)).rejects.toMatchObject({
          statusCode: 409,
          code: 'IDEMPOTENCY_KEY_CONFLICT',
        })
        expect(PLAN_503.assertCanCreate).not.toHaveBeenCalled()
      })

      it('K libre + plan 503 ⇒ el 503 de siempre, sin decisión ni borrador', async () => {
        tabla()
        await expect(createCardOnlineDraft(conSesion(), PLAN_503)).rejects.toMatchObject({
          statusCode: 503,
          code: 'FEATURE_CHECK_UNAVAILABLE',
        })
        expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
        expect(prismaMock.onlineOrderCharge.create).not.toHaveBeenCalled()
      })
    })
  })
})
