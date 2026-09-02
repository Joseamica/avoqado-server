const mockSessionCreate = jest.fn()
const mockSessionExpire = jest.fn()
const mockPriceList = jest.fn()
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockSessionCreate, expire: mockSessionExpire } },
    prices: { list: mockPriceList },
  }))
})
const mockFeatureFindFirst = jest.fn()
const mockVenueFindUnique = jest.fn()
const mockStripeCheckoutOriginCreate = jest.fn()
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: {
      findUnique: (...args: any[]) => mockVenueFindUnique(...args),
    },
    feature: {
      findFirst: (...args: any[]) => mockFeatureFindFirst(...args),
    },
    stripeCheckoutOrigin: {
      create: (...args: any[]) => mockStripeCheckoutOriginCreate(...args),
    },
  },
}))

import { ForbiddenError } from '../../../src/errors/AppError'
import { createPlanCheckoutSession } from '../../../src/services/stripe.service'

beforeEach(() => {
  jest.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  mockVenueFindUnique.mockResolvedValue({ status: 'ACTIVE' })
  // Resolve the feature by the code the service queries (PLAN_PRO / PLAN_PREMIUM).
  mockFeatureFindFirst.mockImplementation(async ({ where }: any) => {
    const code = where?.code
    if (code === 'PLAN_PREMIUM') return { id: 'feat-premium', code: 'PLAN_PREMIUM', monthlyPrice: 1999 }
    return { id: 'feat-pro', code: 'PLAN_PRO', monthlyPrice: 999 }
  })
  mockPriceList.mockResolvedValue({ data: [{ id: 'price_monthly' }] })
  mockSessionCreate.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' })
  mockSessionExpire.mockResolvedValue({ id: 'cs_1', status: 'expired' })
  mockStripeCheckoutOriginCreate.mockResolvedValue({ stripeCheckoutSessionId: 'cs_1' })
})

describe('createPlanCheckoutSession', () => {
  it.each(['LIVE_DEMO', 'TRIAL'] as const)('rejects %s before resolving prices, creating Stripe state or writing origin', async status => {
    mockVenueFindUnique.mockResolvedValueOnce({ status })

    const failure = await createPlanCheckoutSession({
      venueId: 'v-demo',
      customerId: 'cus_demo',
      interval: 'monthly',
      successUrl: 'https://dash/ok',
      cancelUrl: 'https://dash/cancel',
    }).catch(error => error)

    expect(failure).toBeInstanceOf(ForbiddenError)
    expect(failure).toEqual(expect.objectContaining({ statusCode: 403, code: 'LEGACY_PLAN_CHECKOUT_DEMO_VENUE_FORBIDDEN' }))
    expect(mockFeatureFindFirst).not.toHaveBeenCalled()
    expect(mockPriceList).not.toHaveBeenCalled()
    expect(mockSessionCreate).not.toHaveBeenCalled()
    expect(mockStripeCheckoutOriginCreate).not.toHaveBeenCalled()
  })

  it('monthly: subscription-mode session with PLAN_PRO monthly price and the dashboard URLs', async () => {
    const url = await createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      interval: 'monthly',
      successUrl: 'https://dash/venues/acme/settings/billing/subscriptions?checkout=success',
      cancelUrl: 'https://dash/venues/acme/settings/billing/subscriptions?checkout=cancel',
      venueName: 'Acme',
      venueSlug: 'acme',
    })

    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_1')
    expect(mockPriceList).toHaveBeenCalledWith(expect.objectContaining({ lookup_keys: ['plan_pro_monthly'] }))

    const arg = mockSessionCreate.mock.calls[0][0]
    expect(arg.mode).toBe('subscription')
    expect(arg.customer).toBe('cus_1')
    expect(arg.line_items).toEqual([{ price: 'price_monthly', quantity: 1 }])
    expect(arg.allow_promotion_codes).toBe(true)
    expect(arg.success_url).toContain('checkout=success')
    expect(arg.cancel_url).toContain('checkout=cancel')
    expect(arg.metadata).toEqual(expect.objectContaining({ venueId: 'v1', tierCode: 'PLAN_PRO' }))
    expect(arg.subscription_data.metadata).toEqual(expect.objectContaining({ venueId: 'v1', tierCode: 'PLAN_PRO' }))
    // IVA is baked into the price (inclusive) — Stripe Tax must NOT be enabled.
    expect(arg.automatic_tax).toBeUndefined()
    expect(mockStripeCheckoutOriginCreate).toHaveBeenCalledWith({
      data: {
        stripeCheckoutSessionId: 'cs_1',
        ownerKind: 'LEGACY',
        routeKey: 'LEGACY_PLAN_CHECKOUT',
        venueId: 'v1',
        featureId: 'feat-pro',
        stripeCustomerId: 'cus_1',
        billingInterval: 'MONTHLY',
      },
    })
    expect(mockSessionCreate.mock.invocationCallOrder[0]).toBeLessThan(mockStripeCheckoutOriginCreate.mock.invocationCallOrder[0])
  })

  it('does not return the remote URL until the durable local origin has been written', async () => {
    let finishPersistence!: () => void
    mockStripeCheckoutOriginCreate.mockReturnValueOnce(
      new Promise(resolve => {
        finishPersistence = () => resolve({ stripeCheckoutSessionId: 'cs_1' })
      }),
    )
    let settled = false

    const pending = createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      interval: 'monthly',
      successUrl: 'https://dash/ok',
      cancelUrl: 'https://dash/cancel',
    }).finally(() => {
      settled = true
    })

    await new Promise(resolve => setImmediate(resolve))
    expect(mockStripeCheckoutOriginCreate).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)

    finishPersistence()
    await expect(pending).resolves.toBe('https://checkout.stripe.com/c/pay/cs_1')
  })

  it('reuses one explicit Stripe idempotency key across an ambiguous outer retry and originates only the returned session', async () => {
    mockSessionCreate
      .mockRejectedValueOnce(Object.assign(new Error('ambiguous Stripe response'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({ id: 'cs_after_retry', url: 'https://checkout.stripe.com/c/pay/cs_after_retry' })

    await expect(
      createPlanCheckoutSession({
        venueId: 'v1',
        customerId: 'cus_1',
        interval: 'monthly',
        successUrl: 'https://dash/ok',
        cancelUrl: 'https://dash/cancel',
      }),
    ).resolves.toBe('https://checkout.stripe.com/c/pay/cs_after_retry')

    expect(mockSessionCreate).toHaveBeenCalledTimes(2)
    const firstIdempotencyKey = mockSessionCreate.mock.calls[0][1]?.idempotencyKey
    const secondIdempotencyKey = mockSessionCreate.mock.calls[1][1]?.idempotencyKey
    expect(firstIdempotencyKey).toEqual(expect.stringMatching(/^legacy-plan-checkout:[0-9a-f-]{36}$/))
    expect(secondIdempotencyKey).toBe(firstIdempotencyKey)
    expect(mockStripeCheckoutOriginCreate).toHaveBeenCalledTimes(1)
    expect(mockStripeCheckoutOriginCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ stripeCheckoutSessionId: 'cs_after_retry' }),
    })
  })

  it('persists the returned session origin before expiring and rejecting a null Checkout URL', async () => {
    mockSessionCreate.mockResolvedValueOnce({ id: 'cs_without_url', url: null })

    await expect(
      createPlanCheckoutSession({
        venueId: 'v1',
        customerId: 'cus_1',
        interval: 'monthly',
        successUrl: 'https://dash/ok',
        cancelUrl: 'https://dash/cancel',
      }),
    ).rejects.toThrow('Stripe Checkout Session created without a URL')

    expect(mockStripeCheckoutOriginCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ stripeCheckoutSessionId: 'cs_without_url' }),
    })
    expect(mockSessionExpire).toHaveBeenCalledWith('cs_without_url')
    expect(mockStripeCheckoutOriginCreate.mock.invocationCallOrder[0]).toBeLessThan(mockSessionExpire.mock.invocationCallOrder[0])
  })

  it('preserves the null-URL error when expiration cleanup also fails', async () => {
    mockSessionCreate.mockResolvedValueOnce({ id: 'cs_without_url', url: null })
    mockSessionExpire.mockRejectedValueOnce(new Error('Stripe cleanup unavailable'))

    const failure = await createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      interval: 'monthly',
      successUrl: 'https://dash/ok',
      cancelUrl: 'https://dash/cancel',
    }).catch(error => error)

    expect(failure).toEqual(expect.objectContaining({ message: 'Stripe Checkout Session created without a URL' }))
    expect(mockStripeCheckoutOriginCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ stripeCheckoutSessionId: 'cs_without_url' }),
    })
    expect(mockSessionExpire).toHaveBeenCalledWith('cs_without_url')
  })

  it('expires the remote session and rejects with the original error when origin persistence fails', async () => {
    const persistenceError = new Error('origin database write failed')
    mockStripeCheckoutOriginCreate.mockRejectedValueOnce(persistenceError)

    await expect(
      createPlanCheckoutSession({
        venueId: 'v1',
        customerId: 'cus_1',
        interval: 'monthly',
        successUrl: 'https://dash/ok',
        cancelUrl: 'https://dash/cancel',
      }),
    ).rejects.toBe(persistenceError)
    expect(mockSessionExpire).toHaveBeenCalledWith('cs_1')
    expect(mockSessionCreate).toHaveBeenCalledTimes(1)
  })

  it('keeps the persistence error when remote cleanup also fails', async () => {
    const persistenceError = new Error('origin database write failed')
    mockStripeCheckoutOriginCreate.mockRejectedValueOnce(persistenceError)
    mockSessionExpire.mockRejectedValueOnce(new Error('Stripe cleanup unavailable'))

    await expect(
      createPlanCheckoutSession({
        venueId: 'v1',
        customerId: 'cus_1',
        interval: 'annual',
        successUrl: 'https://dash/ok',
        cancelUrl: 'https://dash/cancel',
      }),
    ).rejects.toBe(persistenceError)
    expect(mockSessionExpire).toHaveBeenCalledWith('cs_1')
    expect(mockSessionCreate).toHaveBeenCalledTimes(1)
  })

  it('annual: uses the annual price lookup_key', async () => {
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_annual' }] })
    await createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      interval: 'annual',
      successUrl: 'https://dash/ok',
      cancelUrl: 'https://dash/cancel',
    })
    expect(mockPriceList).toHaveBeenCalledWith(expect.objectContaining({ lookup_keys: ['plan_pro_annual'] }))
    const arg = mockSessionCreate.mock.calls[0][0]
    expect(arg.line_items[0].price).toBe('price_annual')
  })

  it('defaults to PLAN_PRO when tierCode is omitted (back-compat)', async () => {
    await createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      interval: 'monthly',
      successUrl: 'https://dash/ok',
      cancelUrl: 'https://dash/cancel',
    })
    expect(mockFeatureFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { code: 'PLAN_PRO', active: true } }))
    expect(mockPriceList).toHaveBeenCalledWith(expect.objectContaining({ lookup_keys: ['plan_pro_monthly'] }))
    const arg = mockSessionCreate.mock.calls[0][0]
    expect(arg.metadata).toEqual(expect.objectContaining({ tierCode: 'PLAN_PRO' }))
    expect(arg.subscription_data.metadata).toEqual(expect.objectContaining({ tierCode: 'PLAN_PRO' }))
  })

  it('PREMIUM monthly: resolves the plan_premium_monthly price and stamps tierCode PLAN_PREMIUM', async () => {
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_premium_monthly' }] })
    const url = await createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
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
    expect(mockPriceList).toHaveBeenCalledWith(expect.objectContaining({ lookup_keys: ['plan_premium_monthly'] }))

    const arg = mockSessionCreate.mock.calls[0][0]
    expect(arg.mode).toBe('subscription')
    expect(arg.line_items).toEqual([{ price: 'price_premium_monthly', quantity: 1 }])
    expect(arg.metadata).toEqual(expect.objectContaining({ venueId: 'v1', tierCode: 'PLAN_PREMIUM' }))
    expect(arg.subscription_data.metadata).toEqual(
      expect.objectContaining({ venueId: 'v1', tierCode: 'PLAN_PREMIUM', featureId: 'feat-premium', featureCode: 'PLAN_PREMIUM' }),
    )
    // IVA inclusive — Stripe Tax stays off.
    expect(arg.automatic_tax).toBeUndefined()
  })

  it('PREMIUM annual: uses the plan_premium_annual lookup_key', async () => {
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_premium_annual' }] })
    await createPlanCheckoutSession({
      venueId: 'v1',
      customerId: 'cus_1',
      interval: 'annual',
      tierCode: 'PLAN_PREMIUM',
      successUrl: 'https://dash/ok',
      cancelUrl: 'https://dash/cancel',
    })
    expect(mockPriceList).toHaveBeenCalledWith(expect.objectContaining({ lookup_keys: ['plan_premium_annual'] }))
    const arg = mockSessionCreate.mock.calls[0][0]
    expect(arg.line_items[0].price).toBe('price_premium_annual')
  })

  it('throws a clear error when the PLAN_PRO price cannot be resolved', async () => {
    mockPriceList.mockResolvedValue({ data: [] })
    await expect(
      createPlanCheckoutSession({
        venueId: 'v1',
        customerId: 'cus_1',
        interval: 'monthly',
        successUrl: 'https://dash/ok',
        cancelUrl: 'https://dash/cancel',
      }),
    ).rejects.toThrow(/plan_pro_monthly/)
    expect(mockSessionCreate).not.toHaveBeenCalled()
  })

  it('throws a clear error when the PLAN_PREMIUM price cannot be resolved', async () => {
    mockPriceList.mockResolvedValue({ data: [] })
    await expect(
      createPlanCheckoutSession({
        venueId: 'v1',
        customerId: 'cus_1',
        interval: 'annual',
        tierCode: 'PLAN_PREMIUM',
        successUrl: 'https://dash/ok',
        cancelUrl: 'https://dash/cancel',
      }),
    ).rejects.toThrow(/plan_premium_annual/)
    expect(mockSessionCreate).not.toHaveBeenCalled()
  })
})
