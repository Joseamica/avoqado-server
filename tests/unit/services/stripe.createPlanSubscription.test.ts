const mockSubCreate = jest.fn()
const mockPriceList = jest.fn()
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: jest.fn() },
    prices: { list: mockPriceList },
  }))
})
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueFeature: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
    feature: {
      findFirst: jest.fn().mockResolvedValue({ id: 'feat-pro', code: 'PLAN_PRO', stripePriceId: 'price_monthly', monthlyPrice: 999 }),
    },
  },
}))

import { createPlanSubscription } from '../../../src/services/stripe.service'

beforeEach(() => {
  jest.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  mockPriceList.mockResolvedValue({ data: [{ id: 'price_monthly' }] })
  mockSubCreate.mockResolvedValue({ id: 'sub_1', status: 'trialing' })
})

describe('createPlanSubscription', () => {
  it('trial path: 30-day trial, no coupon, no Stripe Tax (IVA baked into the price)', async () => {
    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 30,
    })
    const arg = mockSubCreate.mock.calls[0][0]
    expect(arg.trial_period_days).toBe(30)
    expect(arg.discounts).toBeUndefined()
    // Stripe Tax is intentionally NOT used: the IVA is baked into the price (tax_behavior
    // 'inclusive'), so automatic_tax must be absent — enabling it would 400 in prod where
    // Stripe Tax isn't configured.
    expect(arg.automatic_tax).toBeUndefined()
  })

  it('pay-now monthly: no trial + INTRO_PRO_3M coupon', async () => {
    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 0,
      coupon: 'INTRO_PRO_3M',
    })
    const arg = mockSubCreate.mock.calls[0][0]
    expect(arg.trial_period_days).toBe(0)
    expect(arg.discounts).toEqual([{ coupon: 'INTRO_PRO_3M' }])
  })

  it('annual: uses the annual price lookup_key, no coupon', async () => {
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_annual' }] })
    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      tierCode: 'PLAN_PRO',
      interval: 'annual',
      trialPeriodDays: 0,
    })
    expect(mockPriceList).toHaveBeenCalledWith(expect.objectContaining({ lookup_keys: ['plan_pro_annual'] }))
    const arg = mockSubCreate.mock.calls[0][0]
    expect(arg.items[0].price).toBe('price_annual')
  })
})
