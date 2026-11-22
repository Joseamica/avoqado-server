// tests/unit/services/online-ordering/card/draft.service.test.ts
import { Prisma } from '@prisma/client'
import { ForbiddenError, ServiceUnavailableError } from '@/errors/AppError'
import { prismaMock } from '@tests/__helpers__/setup'
import { contar, cumpleWhere } from '@tests/__helpers__/baseEnMemoria'

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
import { borradoresNadieWhere, cargoDeNadie, unpaidFoliosWhere } from '@/services/online-ordering/constants'

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

describe('D661 · el borrador de tarjeta en «Nadie»: sesión, teléfono verificado y tope por clienta', () => {
  /** La caja capaz de avisar recibió una respuesta rápida hace 30 s (`cardOnlineAvailable` mide con el reloj del sistema). */
  const NADIE = () => ({
    acceptsCardOnline: false,
    requiresAcceptance: false,
    cardOnlineNadie: true,
    lastCardAlertPollAt: new Date(Date.now() - 60_000),
    cardAlertFastPollAt: new Date(Date.now() - 30_000),
  })
  const MI_EQUIPO = { acceptsCardOnline: true, requiresAcceptance: true }
  const TELEFONO_DE_LA_SESION = '+525511112222'
  const ADMISION = 'online-order-admission:v1'
  /** La clienta de «Nadie»: con sesión (`clientaDeLaSesion`, aquí por correo) y sin teléfono en el cuerpo. */
  const nadie = (o: Record<string, unknown> = {}) =>
    input({ customer: { name: 'María G.', email: 'maria@test.com' }, customerId: 'cust1', verifiedPhone: null, ...o })

  let cargos: any[]
  let pedidos: any[]
  const borradorNadie = (clienta: string, o: Record<string, unknown> = {}) => ({
    id: `b${cargos.length}`,
    venueId: 'v1',
    idempotencyKey: `otra-${cargos.length}`,
    status: 'PENDING_AUTH',
    customerPhone: '',
    checkoutExpiresAt: new Date(NOW.getTime() + 60_000),
    request: { nadie: true, customerId: clienta },
    ...o,
  })
  const apartadoNadie = (clienta: string, o: Record<string, unknown> = {}) => ({
    venueId: 'v1',
    status: 'PENDING_ACCEPTANCE',
    requiresAcceptance: false,
    paymentMode: 'CARD_ONLINE',
    order: { customerId: clienta, paymentStatus: 'PENDING' },
    ...o,
  })
  const folioDeCaja = (clienta: string | null) => ({
    venueId: 'v1',
    status: 'PENDING_ACCEPTANCE',
    requiresAcceptance: false,
    paymentMode: 'PAY_AT_PICKUP',
    order: { customerId: clienta, paymentStatus: 'PENDING' },
  })
  const creados = () => prismaMock.onlineOrderCharge.create.mock.calls.map((c: any) => c[0].data)
  /** El candado de admisión se toma ANTES del primer conteo de topes. */
  const conteosBajoElCandado = () => {
    const raw = prismaMock.$executeRaw as jest.Mock
    const admision = raw.mock.calls.findIndex(([, k]) => k === ADMISION)
    expect(admision).toBeGreaterThanOrEqual(0)
    expect(raw.mock.invocationCallOrder[admision]).toBeLessThan(prismaMock.onlineOrderCharge.count.mock.invocationCallOrder[0])
  }

  beforeEach(() => {
    cargos = []
    pedidos = []
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(NADIE() as any)
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({
      status: 'OPEN',
      reason: null,
      config: { acceptsPayAtPickup: true, requiresAcceptance: false },
    })
    ;(simularBeneficios as jest.Mock).mockReset()
    ;(simularBeneficios as jest.Mock).mockResolvedValue({ total: D('250.00'), aplicados: [], descartados: [] })
    ;(cedeLaSimulacion as jest.Mock).mockReturnValue(false)
    // La base en memoria: los topes cuentan FILAS con el filtro de verdad.
    prismaMock.onlineOrderCharge.count.mockImplementation(contar(cargos) as any)
    prismaMock.onlineOrder.count.mockImplementation(contar(pedidos) as any)
    prismaMock.onlineOrderCharge.create.mockImplementation((async ({ data }: any) => {
      const fila = {
        id: `ch${cargos.length + 1}`,
        status: 'PENDING_AUTH',
        checkoutAttempt: 1,
        checkoutSessionId: null,
        checkoutUrl: null,
        ...data,
      }
      cargos.push(fila)
      return { ...fila }
    }) as any)
    prismaMock.onlineOrderCharge.findUnique.mockImplementation((async ({ where }: any) => {
      const k = where.venueId_idempotencyKey
      const fila = cargos.find(c => (k ? c.venueId === k.venueId && c.idempotencyKey === k.idempotencyKey : c.id === where.id))
      return fila ? { ...fila } : null
    }) as any)
    prismaMock.onlineOrderCharge.updateMany.mockImplementation((async ({ where, data }: any) => {
      const filas = cargos.filter(c => cumpleWhere(c, where))
      filas.forEach(c => Object.assign(c, data))
      return { count: filas.length }
    }) as any)
  })

  it('«Nadie» sin sesión: 401 con el código del folio anónimo (order.service.ts:777-790), nada se crea', async () => {
    for (const sinSesion of [nadie({ customerId: null }), input({ customerId: null })]) {
      await expect(createCardOnlineDraft(sinSesion, PUEDE_CREAR)).rejects.toMatchObject({
        statusCode: 401,
        code: 'PHONE_VERIFICATION_REQUIRED',
      })
    }
    expect(cargos).toHaveLength(0)
    expect(quoteCart).not.toHaveBeenCalled()
    expect(createAuthorizationCheckout).not.toHaveBeenCalled()
    expect(prismaMock.idempotencyRequest.create).not.toHaveBeenCalled()
  })

  it('«Nadie» con sesión sin teléfono: request.nadie true, customerId de la sesión, telefonoVerificado ausente', async () => {
    await expect(createCardOnlineDraft(nadie(), PUEDE_CREAR)).resolves.toMatchObject({ status: 'AWAITING_PAYMENT', replay: false })
    const [data] = creados()
    expect(data.request).toMatchObject({
      nadie: true,
      customerId: 'cust1',
      customer: { name: 'María G.', phone: null, email: 'maria@test.com' },
    })
    expect(data.request).not.toHaveProperty('telefonoVerificado')
    // Su tope es por clienta, nunca por un número vacío compartido.
    expect(data.customerPhone).toBe('')
    // Con sesión, lo autorizado es el total estricto de SU cadena de beneficios.
    expect(simularBeneficios).toHaveBeenCalledWith('v1', QUOTE_OK, 'cust1', {})
    expect(createAuthorizationCheckout).toHaveBeenCalledTimes(1)
  })

  it('«Nadie» con sesión de WhatsApp: telefonoVerificado = el de la sesión', async () => {
    // Aunque el cuerpo traiga otro número (una pestaña vieja), cuenta el que la sesión probó.
    await createCardOnlineDraft(
      nadie({ verifiedPhone: TELEFONO_DE_LA_SESION, customer: { name: 'María G.', phone: '55 9999 8888' } }),
      PUEDE_CREAR,
    )
    const [data] = creados()
    expect(data.request).toMatchObject({
      nadie: true,
      customerId: 'cust1',
      telefonoVerificado: TELEFONO_DE_LA_SESION,
      customer: { phone: TELEFONO_DE_LA_SESION },
    })
    expect(data.customerPhone).toBe('')
  })

  it('«Mi equipo» sin teléfono: 400 como hoy', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(MI_EQUIPO as any)
    for (const sinTelefono of [input({ customer: { name: 'María G.' } }), nadie({ verifiedPhone: TELEFONO_DE_LA_SESION })]) {
      const err = await createCardOnlineDraft(sinTelefono, PUEDE_CREAR).catch((e: unknown) => e)
      // El mismo 400 y el mismo texto que daba el esquema (la regla se movió al servicio, r1 #12), sin código.
      expect(err).toMatchObject({ statusCode: 400, message: 'Error de validación: Escribe tu teléfono' })
      expect((err as { code?: string }).code).toBeUndefined()
    }
    expect(cargos).toHaveLength(0)
    expect(createAuthorizationCheckout).not.toHaveBeenCalled()
  })

  it('el tope cuenta borradores y pedidos de tarjeta de «Nadie» todavía vivos de la MISMA clienta (OnlineOrder.order.customerId), bajo el candado de admisión: el cuarto intento se rechaza aunque uno ya esté apartado; los folios de caja no cuentan', async () => {
    // cust1: un borrador vigente, otro con su página ya vencida (sigue sin resolver) y un apartado. Además sus dos folios de caja y lo
    // de otra clienta.
    cargos.push(
      borradorNadie('cust1'),
      borradorNadie('cust1', { checkoutExpiresAt: new Date(NOW.getTime() - 60_000) }),
      borradorNadie('cust2'),
    )
    pedidos.push(apartadoNadie('cust1'), folioDeCaja('cust1'), folioDeCaja('cust1'), apartadoNadie('cust2'))

    await expect(createCardOnlineDraft(nadie(), PUEDE_CREAR)).rejects.toMatchObject({ statusCode: 409, code: 'TOO_MANY_PENDING_ORDERS' })
    expect(prismaMock.onlineOrderCharge.create).not.toHaveBeenCalled()
    conteosBajoElCandado()

    // Una caja abrió (y cobró) el apartado: ese lugar se libera; los dos folios de caja siguen sin contar.
    pedidos[0].status = 'ACCEPTED'
    await expect(createCardOnlineDraft(nadie(), PUEDE_CREAR)).resolves.toMatchObject({ replay: false })
  })

  it('un apartado D661 vivo sigue ocupando su lugar en el tope de tarjeta POR SUCURSAL bajo el candado de admisión hasta resolverse; no ocupa el cupo de folios de caja', async () => {
    // 30 lugares de otras clientas: 8 borradores vigentes, 4 con la página vencida pero sin resolver y 18 apartados. Lo ya resuelto
    // (un borrador abandonado, un apartado cobrado) y lo de «Mi equipo» no cuentan.
    for (let i = 0; i < 8; i++) cargos.push(borradorNadie(`b${i}`))
    for (let i = 0; i < 4; i++) cargos.push(borradorNadie(`v${i}`, { checkoutExpiresAt: new Date(NOW.getTime() - 60_000) }))
    cargos.push(borradorNadie('x', { status: 'ABANDONED' }))
    for (let i = 0; i < 18; i++) pedidos.push(apartadoNadie(`a${i}`))
    pedidos.push(apartadoNadie('y', { status: 'ACCEPTED' }))

    const err = await createCardOnlineDraft(nadie(), PUEDE_CREAR).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 409, code: 'CARD_ONLINE_QUEUE_FULL' })
    // r6 #6: la fila de tarjeta no cierra la tienda (la tienda trata ORDERING_* como «no recibe pedidos»).
    expect((err as { code: string }).code).not.toMatch(/^ORDERING_/)
    expect(prismaMock.onlineOrderCharge.create).not.toHaveBeenCalled()
    conteosBajoElCandado()

    // Los apartados no ocupan el cupo de folios de caja.
    expect(pedidos.filter(p => cumpleWhere(p, unpaidFoliosWhere('v1')))).toHaveLength(0)

    // El conciliador resuelve un borrador vencido (nunca se autorizó): su lugar se libera; el reloj solo no lo hacía.
    cargos.find(c => c.request.customerId === 'v0').status = 'ABANDONED'
    await expect(createCardOnlineDraft(nadie(), PUEDE_CREAR)).resolves.toMatchObject({ replay: false })
  })

  it('repetir un borrador con su misma llave devuelve el original aunque la tienda haya cambiado de modo: la llave se resuelve ANTES de la regla de sesión (draft.service.ts:213)', async () => {
    // Nació en «Mi equipo» (sin sesión, con teléfono); la tienda pasó a «Nadie»: SU borrador, no el 401.
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(MI_EQUIPO as any)
    const deMiEquipo = await createCardOnlineDraft(input({ customerId: null }), PUEDE_CREAR)
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(NADIE() as any)
    await expect(createCardOnlineDraft(input({ customerId: null }), PUEDE_CREAR)).resolves.toEqual({ ...deMiEquipo, replay: true })

    // Nació en «Nadie» (sesión sin teléfono); la tienda volvió a «Mi equipo»: SU borrador, no el 400 por falta de teléfono.
    const K2 = 'n'.repeat(32)
    const deNadie = await createCardOnlineDraft(nadie({ idempotencyKey: K2 }), PUEDE_CREAR)
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(MI_EQUIPO as any)
    await expect(createCardOnlineDraft(nadie({ idempotencyKey: K2 }), PUEDE_CREAR)).resolves.toEqual({ ...deNadie, replay: true })

    expect(cargos).toHaveLength(2)
    expect(createAuthorizationCheckout).toHaveBeenCalledTimes(2)
    // La huella de «Nadie» lleva a la clienta: la misma llave con OTRA sesión choca, nunca le entrega el borrador de otra.
    await expect(createCardOnlineDraft(nadie({ idempotencyKey: K2, customerId: 'cust2' }), PUEDE_CREAR)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      final: true,
    })
  })

  it("R1' en «Nadie»: el PRICE_CHANGED se guarda con la huella de «Nadie» y su repetición recibe esa decisión, aunque la tienda vuelva a «Mi equipo»", async () => {
    const filas = new Map<string, any>()
    const k = (w: any) => JSON.stringify(Object.values(w.organizationId_actorStaffId_endpoint_idempotencyKey ?? w))
    prismaMock.idempotencyRequest.findUnique.mockImplementation((async (a: any) => filas.get(k(a.where)) ?? null) as any)
    prismaMock.idempotencyRequest.create.mockImplementation((async ({ data }: any) => {
      const { organizationId, actorStaffId, endpoint, idempotencyKey } = data
      filas.set(k({ organizationId, actorStaffId, endpoint, idempotencyKey }), data)
      return data
    }) as any)
    ;(simularBeneficios as jest.Mock).mockResolvedValue({ total: D('225.00'), aplicados: [], descartados: [] })

    await expect(createCardOnlineDraft(nadie(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'PRICE_CHANGED', final: true })
    const guardada = (prismaMock.idempotencyRequest.create as jest.Mock).mock.calls[0][0].data
    expect(guardada).toMatchObject(decisionDePrecio('v1', KEY))
    expect(guardada.requestHash).not.toBe(huella()) // no es la huella de «Mi equipo»

    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(MI_EQUIPO as any)
    await expect(createCardOnlineDraft(nadie(), PUEDE_CREAR)).rejects.toMatchObject({ code: 'PRICE_CHANGED', final: true })
    // Otra clienta con la misma llave choca: la decisión no es suya.
    await expect(createCardOnlineDraft(nadie({ customerId: 'cust2' }), PUEDE_CREAR)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
    })
    expect(prismaMock.idempotencyRequest.create).toHaveBeenCalledTimes(1)
    expect(cargos).toHaveLength(0)
  })

  it('D661 · matriz fila 1 (r6): cortar antes de crear el Checkout y después de crearlo sin guardar la respuesta: repetir con la misma llave da la misma sesión y el mismo borrador', async () => {
    // Stripe en memoria: la misma clave de idempotencia devuelve SIEMPRE la misma sesión.
    const sesiones = new Map<string, { id: string; url: string }>()
    createAuthorizationCheckout.mockImplementation((async (_m: unknown, p: { idempotencyKey: string }) => {
      if (!sesiones.has(p.idempotencyKey)) {
        const id = `cs_${sesiones.size + 1}`
        sesiones.set(p.idempotencyKey, { id, url: `https://checkout.stripe.test/${id}` })
      }
      return sesiones.get(p.idempotencyKey)
    }) as any)

    // (a) Se corta ANTES de que Stripe cree nada: el borrador quedó guardado sin sesión.
    createAuthorizationCheckout.mockImplementationOnce(async () => {
      throw new Error('el proceso murió antes de crear la sesión')
    })
    await expect(createCardOnlineDraft(nadie(), PUEDE_CREAR)).rejects.toBeDefined()
    expect(sesiones.size).toBe(0)
    const a = await createCardOnlineDraft(nadie(), PUEDE_CREAR)
    expect(a).toMatchObject({ replay: true, checkoutUrl: 'https://checkout.stripe.test/cs_1' })
    expect(cargos).toHaveLength(1)
    expect(cargos[0].checkoutSessionId).toBe('cs_1')

    // (b) Stripe crea la sesión y el proceso muere ANTES de guardarla: el reintento recibe ESA sesión, no otra.
    const K2 = 'n'.repeat(32)
    prismaMock.onlineOrderCharge.updateMany.mockImplementationOnce(async () => {
      throw new Error('el proceso murió antes de guardar la sesión')
    })
    await expect(createCardOnlineDraft(nadie({ idempotencyKey: K2 }), PUEDE_CREAR)).rejects.toThrow('antes de guardar la sesión')
    expect(sesiones.size).toBe(2)
    expect(cargos[1].checkoutSessionId).toBeNull()
    const b = await createCardOnlineDraft(nadie({ idempotencyKey: K2 }), PUEDE_CREAR)
    expect(b).toMatchObject({ replay: true, checkoutUrl: 'https://checkout.stripe.test/cs_2' })
    expect(sesiones.size).toBe(2)
    expect(cargos).toHaveLength(2)
    expect(cargos[1].checkoutSessionId).toBe('cs_2')
    // Las dos llamadas de cada borrador llevan la MISMA clave y los mismos datos.
    const llamadas = createAuthorizationCheckout.mock.calls.map((c: any) => c[1])
    expect(llamadas[0]).toEqual(llamadas[1])
    expect(llamadas[2]).toEqual(llamadas[3])
    expect(llamadas[0].idempotencyKey).not.toBe(llamadas[2].idempotencyKey)
  })

  it('D661 (3A): repetir con la misma llave y la MISMA clienta después de verificar su teléfono devuelve SU borrador original, no un 409 (la huella de «Nadie» no lleva el teléfono)', async () => {
    // Sin teléfono probado primero; verificó entre el envío y el reintento.
    const original = await createCardOnlineDraft(nadie(), PUEDE_CREAR)
    await expect(createCardOnlineDraft(nadie({ verifiedPhone: TELEFONO_DE_LA_SESION }), PUEDE_CREAR)).resolves.toEqual({
      ...original,
      replay: true,
    })
    // Y al revés: verificado primero, luego la sesión ya no trae el teléfono.
    const K2 = 'n'.repeat(32)
    const verificada = await createCardOnlineDraft(nadie({ idempotencyKey: K2, verifiedPhone: TELEFONO_DE_LA_SESION }), PUEDE_CREAR)
    await expect(createCardOnlineDraft(nadie({ idempotencyKey: K2 }), PUEDE_CREAR)).resolves.toEqual({ ...verificada, replay: true })
    expect(cargos).toHaveLength(2)
    expect(cargos[0].request).not.toHaveProperty('telefonoVerificado') // el borrador conserva lo que guardó al nacer
    expect(cargos[1].request).toMatchObject({ telefonoVerificado: TELEFONO_DE_LA_SESION })
    expect(createAuthorizationCheckout).toHaveBeenCalledTimes(2)
  })

  it('D661 (3A): cargoDeNadie dice si el borrador nació en «Nadie» con la misma marca de la columna que sus filtros: sí para el de «Nadie», no para el de «Mi equipo»', async () => {
    await createCardOnlineDraft(nadie(), PUEDE_CREAR)
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(MI_EQUIPO as any)
    await createCardOnlineDraft(input({ customerId: null, idempotencyKey: 'm'.repeat(32) }), PUEDE_CREAR)
    const [deNadie, deMiEquipo] = cargos
    expect(cargoDeNadie(deNadie)).toBe(true)
    expect(cargoDeNadie(deMiEquipo)).toBe(false)
    // La misma respuesta que el filtro de los borradores de «Nadie» (una sola fuente de verdad del modo del borrador).
    expect(cumpleWhere(deNadie, borradoresNadieWhere('v1'))).toBe(true)
    expect(cumpleWhere(deMiEquipo, borradoresNadieWhere('v1'))).toBe(false)
  })

  it('D661 (3A, Ruling 10): el borrador de «Nadie» guarda el cierre de la franja del horario en que empezó (en la zona del negocio); sin horario, null; «Mi equipo» no lo guarda', async () => {
    const dia = { enabled: true, ranges: [{ open: '09:00', close: '22:00' }] }
    const HORARIO = { monday: dia, tuesday: dia, wednesday: dia, thursday: dia, friday: dia, saturday: dia, sunday: dia }
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({
      status: 'OPEN',
      reason: null,
      config: { acceptsPayAtPickup: true, requiresAcceptance: false, hours: HORARIO },
    })
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
    // NOW = 2026-10-28 12:00 en CDMX (UTC−6): la franja cierra a las 22:00 locales = 04:00 UTC del día siguiente.
    await createCardOnlineDraft(nadie(), PUEDE_CREAR)
    expect(creados()[0].request.cierreDeFranja).toBe('2026-10-29T04:00:00.000Z')

    // Sin horario (abierta todo el día): sin límite de franja, dicho con `null` (no «sin el campo»).
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({
      status: 'OPEN',
      reason: null,
      config: { acceptsPayAtPickup: true, requiresAcceptance: false, hours: null },
    })
    await createCardOnlineDraft(nadie({ idempotencyKey: 'n'.repeat(32) }), PUEDE_CREAR)
    expect(creados()[1].request).toHaveProperty('cierreDeFranja', null)

    // «Mi equipo» no tiene plazo de franja: su request sigue como hoy.
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(MI_EQUIPO as any)
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue({
      status: 'OPEN',
      reason: null,
      config: { acceptsPayAtPickup: true, requiresAcceptance: true, hours: HORARIO },
    })
    await createCardOnlineDraft(input({ customerId: null, idempotencyKey: 'm'.repeat(32) }), PUEDE_CREAR)
    expect(creados()[2].request).not.toHaveProperty('cierreDeFranja')
  })

  /** El texto de una llamada a `$queryRaw` (plantilla). */
  const sqlDe = (llamada: any[]) => (Array.isArray(llamada[0]) ? llamada[0].join('?') : '')
  const candadoDeAjustes = () =>
    ((prismaMock.$queryRaw as jest.Mock).mock.calls as any[][]).findIndex(
      l => sqlDe(l).includes('FROM "OnlineOrderingSettings"') && sqlDe(l).includes('FOR UPDATE'),
    )

  it('D661 · A (Ruling 72): la única caja recibe la respuesta lenta (apaga su marca rápida) MIENTRAS se cotiza → 400 CARD_PAYMENT_NOT_ACCEPTED y nada se escribe; la fila de ajustes se toma bajo candado ANTES de releer', async () => {
    let marcaApagada = false
    prismaMock.onlineOrderingSettings.findUnique.mockImplementation((async () => ({
      ...NADIE(),
      cardAlertFastPollAt: marcaApagada ? null : new Date(Date.now() - 30_000),
    })) as any)
    ;(quoteCart as jest.Mock).mockImplementationOnce(async () => {
      marcaApagada = true // la revisión del POST ya pasó; la caja sondea, recibe 600 s y apaga su marca
      return QUOTE_OK
    })
    await expect(createCardOnlineDraft(nadie(), PUEDE_CREAR)).rejects.toMatchObject({ statusCode: 400, code: 'CARD_PAYMENT_NOT_ACCEPTED' })
    expect(cargos).toHaveLength(0)
    expect(createAuthorizationCheckout).not.toHaveBeenCalled()
    // La fila que escribe el latido, bajo candado dentro de la transacción del borrador, y DESPUÉS la relectura (la 3.ª lectura de ajustes:
    // las dos primeras son las de la revisión de siempre).
    const candado = candadoDeAjustes()
    expect(candado).toBeGreaterThanOrEqual(0)
    const lecturas = prismaMock.onlineOrderingSettings.findUnique.mock.invocationCallOrder
    expect(lecturas.length).toBeGreaterThanOrEqual(3)
    expect((prismaMock.$queryRaw as jest.Mock).mock.invocationCallOrder[candado]).toBeLessThan(lecturas[2])
    expect((prismaMock.$queryRaw as jest.Mock).mock.invocationCallOrder[candado]).toBeGreaterThan(lecturas[1])
  })

  it('D661 · A (Ruling 72): la tienda pasó a «Mi equipo» (con su tarjeta prendida) entre la revisión y la escritura → tampoco nace el borrador de «Nadie»', async () => {
    let miEquipo = false
    prismaMock.onlineOrderingSettings.findUnique.mockImplementation((async () => (miEquipo ? MI_EQUIPO : NADIE())) as any)
    ;(quoteCart as jest.Mock).mockImplementationOnce(async () => {
      miEquipo = true
      return QUOTE_OK
    })
    await expect(createCardOnlineDraft(nadie(), PUEDE_CREAR)).rejects.toMatchObject({ statusCode: 400, code: 'CARD_PAYMENT_NOT_ACCEPTED' })
    expect(cargos).toHaveLength(0)
    expect(createAuthorizationCheckout).not.toHaveBeenCalled()
  })

  it('D661 · A (Ruling 72): con la caja a tiempo todo el camino, nace como hoy (la relectura bajo candado sí pasa); «Mi equipo» no la toma', async () => {
    await expect(createCardOnlineDraft(nadie(), PUEDE_CREAR)).resolves.toMatchObject({ status: 'AWAITING_PAYMENT', replay: false })
    expect(candadoDeAjustes()).toBeGreaterThanOrEqual(0)
    ;(prismaMock.$queryRaw as jest.Mock).mockClear()
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(MI_EQUIPO as any)
    await expect(createCardOnlineDraft(input({ customerId: null, idempotencyKey: 'm'.repeat(32) }), PUEDE_CREAR)).resolves.toMatchObject({
      replay: false,
    })
    expect(candadoDeAjustes()).toBe(-1)
  })
})
