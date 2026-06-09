/**
 * Unit tests for planStateService.applyRetentionOffer (cancellation-retention flow).
 *
 * Strategy: the global setup (tests/__helpers__/setup.ts) mocks prismaClient + logger.
 * We additionally mock the stripe.service module so we can drive the Stripe-side helpers
 * (subscriptionHasActiveDiscount / applySubscriptionCoupon / pauseSubscriptionCollection /
 * retrievePlanSubscription) and the access/basePlan.service (getVenueBaseTier), then assert
 * the service:
 *   - applies RETENTION_30_3M on the 'discount' offer,
 *   - pauses collection on the 'pause' offer,
 *   - blocks (BadRequestError) when the subscription already carries a discount (anti-abuse),
 *   - blocks (BadRequestError) when the venue has no active base plan.
 */

// --- Mocks ---------------------------------------------------------------

const mockGetVenueBaseTier = jest.fn()
// basePlan.service exports both the access helpers AND the constants/derivePlanState that
// planState.service imports — preserve the real module and only override getVenueBaseTier.
jest.mock('@/services/access/basePlan.service', () => {
  const actual = jest.requireActual('@/services/access/basePlan.service')
  return { __esModule: true, ...actual, getVenueBaseTier: (...args: any[]) => mockGetVenueBaseTier(...args) }
})

const mockSubscriptionHasActiveDiscount = jest.fn()
const mockApplySubscriptionCoupon = jest.fn()
const mockPauseSubscriptionCollection = jest.fn()
const mockRetrievePlanSubscription = jest.fn()
const mockSetSubscriptionCancelAtPeriodEnd = jest.fn()
const mockCreateWinbackPromotionCode = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  __esModule: true,
  subscriptionHasActiveDiscount: (...a: any[]) => mockSubscriptionHasActiveDiscount(...a),
  applySubscriptionCoupon: (...a: any[]) => mockApplySubscriptionCoupon(...a),
  pauseSubscriptionCollection: (...a: any[]) => mockPauseSubscriptionCollection(...a),
  retrievePlanSubscription: (...a: any[]) => mockRetrievePlanSubscription(...a),
  setSubscriptionCancelAtPeriodEnd: (...a: any[]) => mockSetSubscriptionCancelAtPeriodEnd(...a),
  createWinbackPromotionCode: (...a: any[]) => mockCreateWinbackPromotionCode(...a),
}))

// Email + notification: applyRetentionOffer doesn't email, but planState.service imports them
// at module load, so provide light stubs to keep the module graph happy.
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendPlanCancellationEmail: jest.fn() } }))
jest.mock('@/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn(),
}))

import { prismaMock } from '../../__helpers__/setup'
import { applyRetentionOffer, RETENTION_DISCOUNT_COUPON } from '@/services/dashboard/planState.service'
import { BadRequestError } from '@/errors/AppError'

const VENUE_ID = 'venue_1'
const SUB_ID = 'sub_123'

// A PLAN_PRO VenueFeature row as returned by findPlanProFeature's select.
const planProFeature = {
  id: 'vf_1',
  active: true,
  endDate: null,
  suspendedAt: null,
  gracePeriodEndsAt: null,
  monthlyPrice: { toNumber: () => 999 },
  stripeSubscriptionId: SUB_ID,
  feature: { code: 'PLAN_PRO', name: 'Plan Avoqado Pro' },
}

beforeEach(() => {
  jest.clearAllMocks()
  // Active base plan by default.
  mockGetVenueBaseTier.mockResolvedValue('PRO')
  // No existing discount by default → offer allowed.
  mockSubscriptionHasActiveDiscount.mockResolvedValue(false)
  mockApplySubscriptionCoupon.mockResolvedValue({ id: SUB_ID })
  mockPauseSubscriptionCollection.mockResolvedValue({ id: SUB_ID })
  // getPlanState (called at the end) reads the VenueFeature + venue + Stripe sub.
  prismaMock.venue.findUnique.mockResolvedValue({ id: VENUE_ID, stripeCustomerId: 'cus_1' })
  prismaMock.venueFeature.findFirst.mockResolvedValue(planProFeature)
  mockRetrievePlanSubscription.mockResolvedValue({
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    interval: 'month',
    grossAmountCents: 115884,
  })
})

describe('applyRetentionOffer', () => {
  it("discount offer: applies RETENTION_30_3M to the venue's base-plan subscription", async () => {
    const state = await applyRetentionOffer(VENUE_ID, 'discount')

    expect(mockSubscriptionHasActiveDiscount).toHaveBeenCalledWith(SUB_ID)
    expect(mockApplySubscriptionCoupon).toHaveBeenCalledWith(SUB_ID, RETENTION_DISCOUNT_COUPON)
    expect(mockPauseSubscriptionCollection).not.toHaveBeenCalled()
    // Returns the refreshed PlanState envelope.
    expect(state.hasPlan).toBe(true)
  })

  it('defaults to the discount offer when no offer is passed', async () => {
    await applyRetentionOffer(VENUE_ID)
    expect(mockApplySubscriptionCoupon).toHaveBeenCalledWith(SUB_ID, RETENTION_DISCOUNT_COUPON)
  })

  it('pause offer: pauses collection (~2 months) instead of applying a coupon', async () => {
    await applyRetentionOffer(VENUE_ID, 'pause')

    expect(mockPauseSubscriptionCollection).toHaveBeenCalledTimes(1)
    const [subArg, resumesAt] = mockPauseSubscriptionCollection.mock.calls[0]
    expect(subArg).toBe(SUB_ID)
    expect(resumesAt).toBeInstanceOf(Date)
    expect(resumesAt.getTime()).toBeGreaterThan(Date.now())
    expect(mockApplySubscriptionCoupon).not.toHaveBeenCalled()
  })

  it('anti-abuse: blocks with BadRequestError when the subscription already has a discount', async () => {
    mockSubscriptionHasActiveDiscount.mockResolvedValue(true)

    await expect(applyRetentionOffer(VENUE_ID, 'discount')).rejects.toBeInstanceOf(BadRequestError)
    await expect(applyRetentionOffer(VENUE_ID, 'discount')).rejects.toThrow('Ya tienes una oferta activa.')
    expect(mockApplySubscriptionCoupon).not.toHaveBeenCalled()
    expect(mockPauseSubscriptionCollection).not.toHaveBeenCalled()
  })

  it('blocks with BadRequestError when the venue has no active base plan', async () => {
    mockGetVenueBaseTier.mockResolvedValue(null)

    await expect(applyRetentionOffer(VENUE_ID, 'discount')).rejects.toBeInstanceOf(BadRequestError)
    // Never reaches the Stripe discount check / apply.
    expect(mockSubscriptionHasActiveDiscount).not.toHaveBeenCalled()
    expect(mockApplySubscriptionCoupon).not.toHaveBeenCalled()
  })

  it('blocks when there is an active plan but no Stripe subscription id', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue({ ...planProFeature, stripeSubscriptionId: null })

    await expect(applyRetentionOffer(VENUE_ID, 'discount')).rejects.toBeInstanceOf(BadRequestError)
    expect(mockApplySubscriptionCoupon).not.toHaveBeenCalled()
  })
})
