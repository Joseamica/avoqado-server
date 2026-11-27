const mockSessionCreate = jest.fn()
const mockPriceList = jest.fn()
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockSessionCreate } },
    prices: { list: mockPriceList },
  }))
})
const mockFeatureFindFirst = jest.fn()
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    feature: {
      findFirst: (...args: any[]) => mockFeatureFindFirst(...args),
    },
  },
}))

import { createPlanCheckoutSession } from '../../../src/services/stripe.service'

beforeEach(() => {
  jest.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  // Resolve the feature by the code the service queries (PLAN_PRO / PLAN_PREMIUM).
  mockFeatureFindFirst.mockImplementation(async ({ where }: any) => {
    const code = where?.code
    if (code === 'PLAN_PREMIUM') return { id: 'feat-premium', code: 'PLAN_PREMIUM', monthlyPrice: 1999 }
    return { id: 'feat-pro', code: 'PLAN_PRO', monthlyPrice: 999 }
  })
  mockPriceList.mockResolvedValue({ data: [{ id: 'price_monthly' }] })
  mockSessionCreate.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' })
})

describe('createPlanCheckoutSession', () => {
  it('monthly: subscription-mode session with PLAN_PRO monthly price and the dashboard URLs', async () => {
    const url = await createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      priceId: 'price_cotizado',
      interval: 'monthly',
      successUrl: 'https://dash/venues/acme/settings/billing/subscriptions?checkout=success',
      cancelUrl: 'https://dash/venues/acme/settings/billing/subscriptions?checkout=cancel',
      venueName: 'Acme',
      venueSlug: 'acme',
    })

    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_1')

    const arg = mockSessionCreate.mock.calls[0][0]
    expect(arg.mode).toBe('subscription')
    expect(arg.customer).toBe('cus_1')
    expect(arg.line_items).toEqual([{ price: 'price_cotizado', quantity: 1 }])
    expect(arg.allow_promotion_codes).toBe(true)
    expect(arg.success_url).toContain('checkout=success')
    expect(arg.cancel_url).toContain('checkout=cancel')
    expect(arg.metadata).toEqual(expect.objectContaining({ venueId: 'v1', tierCode: 'PLAN_PRO' }))
    expect(arg.subscription_data.metadata).toEqual(expect.objectContaining({ venueId: 'v1', tierCode: 'PLAN_PRO' }))
    // IVA is baked into the price (inclusive) — Stripe Tax must NOT be enabled.
    expect(arg.automatic_tax).toBeUndefined()
  })

  it('🔴 V5-A: la sesión se marca como NUESTRA (kind) y caduca en 30 min, para que la regla común pueda expirarla', async () => {
    const antes = Math.floor(Date.now() / 1000)
    await createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      priceId: 'price_cotizado',
      interval: 'monthly',
      successUrl: 'https://ok',
      cancelUrl: 'https://no',
    })

    const arg = mockSessionCreate.mock.calls[0][0]
    expect(arg.metadata).toMatchObject({ kind: 'PLAN_CHECKOUT', venueId: 'v1' })
    expect(arg.subscription_data.metadata).toMatchObject({ kind: 'PLAN_CHECKOUT' })
    expect(arg.payment_method_types).toEqual(['card'])
    expect(arg.expires_at).toBeGreaterThanOrEqual(antes + 30 * 60)
    expect(arg.expires_at).toBeLessThanOrEqual(antes + 31 * 60)
  })

  it('B4: la descripción de la suscripción lleva el nombre de la versión; sin él, Pro como hoy', async () => {
    const base = {
      venueId: 'v1',
      customerId: 'cus_1',
      priceId: 'price_cotizado',
      interval: 'monthly' as const,
      successUrl: 'https://dash/ok',
      cancelUrl: 'https://dash/no',
      venueName: 'Acme',
    }
    await createPlanCheckoutSession({ ...base, planDisplayName: 'Plus' })
    expect(mockSessionCreate.mock.calls[0][0].subscription_data.description).toBe('Plan Avoqado Plus - Acme')
    await createPlanCheckoutSession(base)
    expect(mockSessionCreate.mock.calls[1][0].subscription_data.description).toBe('Plan Avoqado Pro - Acme')
  })

  it('annual: uses the annual price lookup_key', async () => {
    await createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      priceId: 'price_cotizado',
      interval: 'annual',
      successUrl: 'https://dash/ok',
      cancelUrl: 'https://dash/cancel',
    })
    const arg = mockSessionCreate.mock.calls[0][0]
    expect(arg.line_items[0].price).toBe('price_cotizado')
  })

  it('defaults to PLAN_PRO when tierCode is omitted (back-compat)', async () => {
    await createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      priceId: 'price_cotizado',
      interval: 'monthly',
      successUrl: 'https://dash/ok',
      cancelUrl: 'https://dash/cancel',
    })
    expect(mockFeatureFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { code: 'PLAN_PRO', active: true } }))
    const arg = mockSessionCreate.mock.calls[0][0]
    expect(arg.metadata).toEqual(expect.objectContaining({ tierCode: 'PLAN_PRO' }))
    expect(arg.subscription_data.metadata).toEqual(expect.objectContaining({ tierCode: 'PLAN_PRO' }))
  })

  it('PREMIUM monthly: resolves the plan_premium_monthly price and stamps tierCode PLAN_PREMIUM', async () => {
    const url = await createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      priceId: 'price_cotizado',
      interval: 'monthly',
      tierCode: 'PLAN_PREMIUM',
      successUrl: 'https://dash/venues/acme/settings/billing/subscriptions?checkout=success',
      cancelUrl: 'https://dash/venues/acme/settings/billing/subscriptions?checkout=cancel',
      venueName: 'Acme',
      venueSlug: 'acme',
    })

    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_1')
    // Looks up the PLAN_PREMIUM feature, not PLAN_PRO.
    expect(mockFeatureFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { code: 'PLAN_PREMIUM', active: true } }))

    const arg = mockSessionCreate.mock.calls[0][0]
    expect(arg.mode).toBe('subscription')
    expect(arg.line_items).toEqual([{ price: 'price_cotizado', quantity: 1 }])
    expect(arg.metadata).toEqual(expect.objectContaining({ venueId: 'v1', tierCode: 'PLAN_PREMIUM' }))
    expect(arg.subscription_data.metadata).toEqual(
      expect.objectContaining({ venueId: 'v1', tierCode: 'PLAN_PREMIUM', featureId: 'feat-premium', featureCode: 'PLAN_PREMIUM' }),
    )
    // IVA inclusive — Stripe Tax stays off.
    expect(arg.automatic_tax).toBeUndefined()
  })

  it('PREMIUM annual: uses the plan_premium_annual lookup_key', async () => {
    await createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      priceId: 'price_cotizado',
      interval: 'annual',
      tierCode: 'PLAN_PREMIUM',
      successUrl: 'https://dash/ok',
      cancelUrl: 'https://dash/cancel',
    })
    const arg = mockSessionCreate.mock.calls[0][0]
    expect(arg.line_items[0].price).toBe('price_cotizado')
  })

  it('usa el priceId recibido y no lista por llave', async () => {
    await createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      priceId: 'price_cotizado',
      interval: 'monthly',
      successUrl: 'https://dash/ok',
      cancelUrl: 'https://dash/cancel',
    })
    expect(mockSessionCreate.mock.calls[0][0].line_items[0].price).toBe('price_cotizado')
    expect(mockPriceList).not.toHaveBeenCalled()
  })

  it('sin el plan en el catálogo lanza y no abre sesión', async () => {
    mockFeatureFindFirst.mockResolvedValue(null)
    await expect(
      createPlanCheckoutSession({
        venueId: 'v1',
        customerId: 'cus_1',
        priceId: 'price_cotizado',
        interval: 'annual',
        tierCode: 'PLAN_PREMIUM',
        successUrl: 'https://dash/ok',
        cancelUrl: 'https://dash/cancel',
      }),
    ).rejects.toThrow(/PLAN_PREMIUM/)
    expect(mockSessionCreate).not.toHaveBeenCalled()
  })
})

describe('🔴 Codex C3: se abre bajo el candado de la regla', () => {
  it('cada llamada a Stripe sin reintentos del SDK', async () => {
    await createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      priceId: 'price_cotizado',
      interval: 'monthly',
      successUrl: 'https://dash/ok',
      cancelUrl: 'https://dash/no',
    })

    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeout: expect.any(Number), maxNetworkRetries: 0 }),
    )
  })

  // D3: quedarse con el plan de una prueba regalada — la prueba de Stripe termina en la fecha EXACTA del fin de la regalada.
  it('con trialEnd: trial_end en segundos, sin códigos promocionales; sin él, igual que siempre', async () => {
    const fin = new Date('2026-12-05T17:19:24.000Z')
    await createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      priceId: 'price_cotizado',
      interval: 'monthly',
      successUrl: 's',
      cancelUrl: 'c',
      trialEnd: fin,
    })
    const conPrueba = mockSessionCreate.mock.calls[0][0]
    expect(conPrueba.subscription_data.trial_end).toBe(Math.floor(fin.getTime() / 1000))
    expect(conPrueba.allow_promotion_codes).toBe(false)

    await createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      priceId: 'price_cotizado',
      interval: 'monthly',
      successUrl: 's',
      cancelUrl: 'c',
    })
    const normal = mockSessionCreate.mock.calls[1][0]
    expect(normal.subscription_data.trial_end).toBeUndefined()
    expect(normal.allow_promotion_codes).toBe(true)
  })
})

// Planes editables (B2, Task 7): la compra de «Tu plan» con una versión del editor cita su versión en la metadata.
describe('extraMetadata (B2, Task 7)', () => {
  const abrir = (extraMetadata?: Record<string, string>) =>
    createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      priceId: 'price_v2_pro_m',
      interval: 'monthly',
      tierCode: 'PLAN_PRO',
      successUrl: 's',
      cancelUrl: 'c',
      venueName: 'Acme',
      venueSlug: 'acme',
      ...(extraMetadata ? { extraMetadata } : {}),
    })

  it('extraMetadata va en metadata y en subscription_data.metadata sin pisar kind, venueId, tierCode ni interval; sin ella, el cuerpo de siempre', async () => {
    await abrir()
    const deSiempre = mockSessionCreate.mock.calls[0]

    await abrir({
      planOfferVersion: '2',
      planOfferPrecioDe: '2',
      // Lo que intenta pisar lo nuestro no lo pisa.
      kind: 'OTRO',
      venueId: 'v_ajeno',
      tierCode: 'PLAN_PREMIUM',
      interval: 'annual',
    })
    const conVersion = mockSessionCreate.mock.calls[1][0]

    expect(conVersion.metadata).toEqual({
      planOfferVersion: '2',
      planOfferPrecioDe: '2',
      kind: 'PLAN_CHECKOUT',
      venueId: 'v1',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
    })
    expect(conVersion.subscription_data.metadata).toEqual({
      planOfferVersion: '2',
      planOfferPrecioDe: '2',
      kind: 'PLAN_CHECKOUT',
      venueId: 'v1',
      tierCode: 'PLAN_PRO',
      featureId: 'feat-pro',
      featureCode: 'PLAN_PRO',
      interval: 'monthly',
      venueName: 'Acme',
      venueSlug: 'acme',
    })

    // Sin ella, exactamente el cuerpo de siempre: las mismas llaves, en el mismo orden, y las mismas opciones.
    expect(deSiempre[0].metadata).toEqual({ kind: 'PLAN_CHECKOUT', venueId: 'v1', tierCode: 'PLAN_PRO', interval: 'monthly' })
    expect(Object.keys(deSiempre[0].metadata)).toEqual(['kind', 'venueId', 'tierCode', 'interval'])
    expect(Object.keys(deSiempre[0].subscription_data.metadata)).toEqual([
      'kind',
      'venueId',
      'tierCode',
      'featureId',
      'featureCode',
      'interval',
      'venueName',
      'venueSlug',
    ])
    expect(deSiempre[1]).toEqual({ timeout: 15_000, maxNetworkRetries: 0 })
  })
})
