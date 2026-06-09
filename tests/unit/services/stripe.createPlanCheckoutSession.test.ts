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
