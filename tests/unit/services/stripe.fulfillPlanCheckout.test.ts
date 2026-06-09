/**
 * PLAN_PRO Checkout Fulfillment Tests
 *
 * Regression for the fulfillment gap: `createPlanCheckoutSession` hands Stripe the
 * subscription to create, but on `checkout.session.completed` NOTHING created the local
 * VenueFeature PLAN_PRO row (handleSubscriptionUpdated returns early when no VenueFeature
 * maps to the new subscription). `fulfillPlanCheckout` closes that gap by upserting the
 * PLAN_PRO VenueFeature, mirroring `createPlanSubscription`'s upsert shape.
 *
 * Mock shape mirrors stripe.createPlanSubscription.test.ts: Stripe SDK + prisma are mocked.
 */

const mockSubRetrieve = jest.fn()
const mockSessionRetrieve = jest.fn()
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    subscriptions: { create: jest.fn(), retrieve: mockSubRetrieve },
    prices: { list: jest.fn() },
    checkout: { sessions: { retrieve: mockSessionRetrieve } },
  }))
})
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueFeature: { upsert: jest.fn().mockResolvedValue({}) },
    feature: {
      findFirst: jest.fn(),
    },
  },
}))

import { fulfillPlanCheckout } from '../../../src/services/stripe.service'
import prisma from '../../../src/utils/prismaClient'

// Resolve the feature row by the code the service queries (tier-aware).
const featureByCode = ({ where }: any) => {
  if (where?.code === 'PLAN_PREMIUM') return Promise.resolve({ id: 'feat-premium', code: 'PLAN_PREMIUM', monthlyPrice: 1999 })
  return Promise.resolve({ id: 'feat-pro', code: 'PLAN_PRO', monthlyPrice: 999 })
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  ;(prisma.feature.findFirst as jest.Mock).mockImplementation(featureByCode)
  ;(prisma.venueFeature.upsert as jest.Mock).mockResolvedValue({})
})

const makeSession = (overrides: any = {}) =>
  ({
    id: 'cs_test_123',
    object: 'checkout.session',
    mode: 'subscription',
    subscription: 'sub_pro_new',
    metadata: { tierCode: 'PLAN_PRO', venueId: 'v1', interval: 'monthly' },
    ...overrides,
  }) as any

describe('fulfillPlanCheckout', () => {
  it('upserts an active PLAN_PRO VenueFeature with the right subscription + price (paid, no trial)', async () => {
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_pro_new',
      status: 'active',
      trial_end: null,
      items: { data: [{ price: { id: 'price_monthly' } }] },
    })

    const result = await fulfillPlanCheckout(makeSession())

    // Retrieved the subscription Stripe created to read price/interval/trial state.
    expect(mockSubRetrieve).toHaveBeenCalledWith('sub_pro_new')

    expect(prisma.venueFeature.upsert).toHaveBeenCalledTimes(1)
    const arg = (prisma.venueFeature.upsert as jest.Mock).mock.calls[0][0]
    // Idempotent: keyed on the (venueId, featureId) unique constraint → re-delivery is a no-op update.
    expect(arg.where).toEqual({ venueId_featureId: { venueId: 'v1', featureId: 'feat-pro' } })
    // Mirrors createPlanSubscription's upsert field set.
    expect(arg.update).toMatchObject({
      active: true,
      stripeSubscriptionId: 'sub_pro_new',
      stripePriceId: 'price_monthly',
      monthlyPrice: 999,
      endDate: null,
      trialEndDate: null,
      suspendedAt: null,
      paymentFailureCount: 0,
    })
    expect(arg.create).toMatchObject({
      venueId: 'v1',
      featureId: 'feat-pro',
      active: true,
      monthlyPrice: 999,
      stripeSubscriptionId: 'sub_pro_new',
      stripePriceId: 'price_monthly',
      endDate: null,
      trialEndDate: null,
    })

    expect(result).toMatchObject({
      venueId: 'v1',
      featureId: 'feat-pro',
      featureCode: 'PLAN_PRO',
      subscriptionId: 'sub_pro_new',
      endDate: null,
    })
  })

  it('sets endDate/trialEndDate when the subscription is trialing', async () => {
    const trialEndUnix = Math.floor(Date.now() / 1000) + 30 * 86400
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_pro_new',
      status: 'trialing',
      trial_end: trialEndUnix,
      items: { data: [{ price: { id: 'price_annual' } }] },
    })

    const result = await fulfillPlanCheckout(makeSession({ metadata: { tierCode: 'PLAN_PRO', venueId: 'v1', interval: 'annual' } }))

    const arg = (prisma.venueFeature.upsert as jest.Mock).mock.calls[0][0]
    expect(arg.update.endDate).toEqual(new Date(trialEndUnix * 1000))
    expect(arg.update.trialEndDate).toEqual(new Date(trialEndUnix * 1000))
    expect(arg.update.stripePriceId).toBe('price_annual')
    expect(result?.endDate).toEqual(new Date(trialEndUnix * 1000))
  })

  it('upserts a PLAN_PREMIUM VenueFeature when the session metadata.tierCode is PLAN_PREMIUM', async () => {
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_premium_new',
      status: 'active',
      trial_end: null,
      items: { data: [{ price: { id: 'price_premium_monthly' } }] },
    })

    const result = await fulfillPlanCheckout(
      makeSession({ subscription: 'sub_premium_new', metadata: { tierCode: 'PLAN_PREMIUM', venueId: 'v1', interval: 'monthly' } }),
    )

    // Looked up the PLAN_PREMIUM feature, not PLAN_PRO.
    expect(prisma.feature.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { code: 'PLAN_PREMIUM', active: true } }))

    const arg = (prisma.venueFeature.upsert as jest.Mock).mock.calls[0][0]
    expect(arg.where).toEqual({ venueId_featureId: { venueId: 'v1', featureId: 'feat-premium' } })
    expect(arg.update).toMatchObject({
      active: true,
      stripeSubscriptionId: 'sub_premium_new',
      stripePriceId: 'price_premium_monthly',
      monthlyPrice: 1999,
      endDate: null,
      trialEndDate: null,
      suspendedAt: null,
      paymentFailureCount: 0,
    })
    expect(arg.create).toMatchObject({
      venueId: 'v1',
      featureId: 'feat-premium',
      active: true,
      monthlyPrice: 1999,
      stripeSubscriptionId: 'sub_premium_new',
      stripePriceId: 'price_premium_monthly',
    })

    expect(result).toMatchObject({
      venueId: 'v1',
      featureId: 'feat-premium',
      featureCode: 'PLAN_PREMIUM',
      subscriptionId: 'sub_premium_new',
      endDate: null,
    })
  })

  it('defaults to PLAN_PRO when metadata.tierCode is absent (back-compat)', async () => {
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_pro_new',
      status: 'active',
      trial_end: null,
      items: { data: [{ price: { id: 'price_monthly' } }] },
    })

    const result = await fulfillPlanCheckout(makeSession({ metadata: { venueId: 'v1', interval: 'monthly' } }))

    expect(prisma.feature.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { code: 'PLAN_PRO', active: true } }))
    expect(result?.featureCode).toBe('PLAN_PRO')
  })

  it('falls back to expanding the session when subscription id is not inlined', async () => {
    mockSessionRetrieve.mockResolvedValue({ id: 'cs_test_123', subscription: 'sub_from_expand' })
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_from_expand',
      status: 'active',
      trial_end: null,
      items: { data: [{ price: { id: 'price_monthly' } }] },
    })

    const result = await fulfillPlanCheckout(makeSession({ subscription: null }))

    expect(mockSessionRetrieve).toHaveBeenCalledWith('cs_test_123', { expand: ['subscription'] })
    expect(mockSubRetrieve).toHaveBeenCalledWith('sub_from_expand')
    expect(result?.subscriptionId).toBe('sub_from_expand')
  })

  it('returns null and does not upsert when there is no subscription id at all', async () => {
    mockSessionRetrieve.mockResolvedValue({ id: 'cs_test_123', subscription: null })

    const result = await fulfillPlanCheckout(makeSession({ subscription: null }))

    expect(result).toBeNull()
    expect(prisma.venueFeature.upsert).not.toHaveBeenCalled()
  })

  it('returns null when metadata.venueId is missing', async () => {
    const result = await fulfillPlanCheckout(makeSession({ metadata: { tierCode: 'PLAN_PRO' } }))

    expect(result).toBeNull()
    expect(mockSubRetrieve).not.toHaveBeenCalled()
    expect(prisma.venueFeature.upsert).not.toHaveBeenCalled()
  })
})
