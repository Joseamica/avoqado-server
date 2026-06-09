import { prismaMock } from '../../../__helpers__/setup'
import * as stripeService from '@/services/stripe.service'
import { BadRequestError } from '@/errors/AppError'
import { getPlanState, cancelPlan, reactivatePlan } from '@/services/dashboard/planState.service'

jest.mock('@/services/stripe.service')
const mockStripe = stripeService as jest.Mocked<typeof stripeService>

const DAY_MS = 86400000
const future = new Date(Date.now() + 30 * DAY_MS)
/** Created 60 days ago → past the 30-day retention tenure threshold (eligible). */
const tenuredCreatedAt = new Date(Date.now() - 60 * DAY_MS)
/** Created 5 days ago → inside the first billing cycle (NOT eligible for the discount). */
const freshCreatedAt = new Date(Date.now() - 5 * DAY_MS)

/** Build a retrievePlanSubscription summary with eligible defaults (tenured, no discount). */
function subSummary(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: future,
    createdAt: tenuredCreatedAt,
    hasActiveDiscount: false,
    interval: 'month' as const,
    grossAmountCents: 115884,
    ...overrides,
  }
}

function planProFeature(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vf_1',
    venueId: 'venue_1',
    active: true,
    endDate: null,
    suspendedAt: null,
    gracePeriodEndsAt: null,
    monthlyPrice: { toNumber: () => 999 }, // Prisma.Decimal-like
    stripeSubscriptionId: 'sub_123',
    feature: { code: 'PLAN_PRO', name: 'Plan Avoqado Pro' },
    ...overrides,
  }
}

describe('planState.service', () => {
  beforeEach(() => {
    prismaMock.venue.findUnique.mockResolvedValue({ id: 'venue_1', stripeCustomerId: 'cus_1', stripePaymentMethodId: null })
  })

  // 1. getPlanState
  describe('getPlanState', () => {
    it('returns state "none" with hasPlan=false when there is no PLAN_PRO VenueFeature', async () => {
      prismaMock.venueFeature.findFirst.mockResolvedValue(null)
      const result = await getPlanState('venue_1')
      expect(result.hasPlan).toBe(false)
      expect(result.state).toBe('none')
      expect(result.stripeSubscriptionId).toBeNull()
    })

    it('returns "active" with real currentPeriodEnd + IVA gross/base price from Stripe', async () => {
      prismaMock.venueFeature.findFirst.mockResolvedValue(planProFeature())
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary())
      const result = await getPlanState('venue_1')
      expect(result.state).toBe('active')
      expect(result.planTier).toBe('PRO')
      expect(result.planName).toBe('Plan Avoqado Pro')
      expect(result.interval).toBe('month')
      expect(result.currentPeriodEnd).toBe(future.toISOString())
      expect(result.price).toEqual({ base: 999, gross: 1158.84, currency: 'MXN' })
      expect(result.stripeSubscriptionId).toBe('sub_123')
      // Tenured (60d) + no discount → eligible for the retention discount offer.
      expect(result.retentionOfferEligible).toBe(true)
    })

    it('returns "canceling" when Stripe sub has cancelAtPeriodEnd=true', async () => {
      prismaMock.venueFeature.findFirst.mockResolvedValue(planProFeature())
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary({ cancelAtPeriodEnd: true }))
      const result = await getPlanState('venue_1')
      expect(result.state).toBe('canceling')
      expect(result.cancelAtPeriodEnd).toBe(true)
    })

    it('retentionOfferEligible reflects tenure and active-discount state', async () => {
      // Eligible baseline (tenured, no discount).
      prismaMock.venueFeature.findFirst.mockResolvedValue(planProFeature())
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary())
      expect((await getPlanState('venue_1')).retentionOfferEligible).toBe(true)

      // Tenure < 30 days → NOT eligible (anti-farm).
      prismaMock.venueFeature.findFirst.mockResolvedValue(planProFeature())
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary({ createdAt: freshCreatedAt }))
      expect((await getPlanState('venue_1')).retentionOfferEligible).toBe(false)

      // Discount already active → NOT eligible (non-stackable).
      prismaMock.venueFeature.findFirst.mockResolvedValue(planProFeature())
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary({ hasActiveDiscount: true }))
      expect((await getPlanState('venue_1')).retentionOfferEligible).toBe(false)

      // DB-only plan (no Stripe sub) → NOT eligible (nothing to discount).
      prismaMock.venueFeature.findFirst.mockResolvedValue(planProFeature({ stripeSubscriptionId: null }))
      expect((await getPlanState('venue_1')).retentionOfferEligible).toBe(false)
    })

    it('returns "trial" with trialEndsAt and no Stripe call failing the response (DB-only trial)', async () => {
      prismaMock.venueFeature.findFirst.mockResolvedValue(planProFeature({ endDate: future, stripeSubscriptionId: null }))
      const result = await getPlanState('venue_1')
      expect(result.state).toBe('trial')
      expect(result.trialEndsAt).toBe(future.toISOString())
      expect(result.currentPeriodEnd).toBeNull()
      expect(mockStripe.retrievePlanSubscription).not.toHaveBeenCalled()
      // No Stripe sub → never eligible for the retention discount offer.
      expect(result.retentionOfferEligible).toBe(false)
    })

    it('returns "suspended" and tolerates a Stripe retrieve error (nulls, never throws)', async () => {
      // monthlyPrice nulled so the only price source would be Stripe; with Stripe down → price null.
      prismaMock.venueFeature.findFirst.mockResolvedValue(
        planProFeature({ suspendedAt: new Date(Date.now() - 86400000), monthlyPrice: null }),
      )
      mockStripe.retrievePlanSubscription.mockRejectedValue(new Error('stripe down'))
      const result = await getPlanState('venue_1')
      expect(result.state).toBe('suspended')
      expect(result.currentPeriodEnd).toBeNull()
      expect(result.price).toBeNull()
    })
  })

  // 2. cancelPlan / reactivatePlan
  describe('cancelPlan / reactivatePlan', () => {
    it('cancelPlan flips cancel_at_period_end=true (NOT immediate cancel) and returns updated state', async () => {
      prismaMock.venueFeature.findFirst
        .mockResolvedValueOnce(planProFeature()) // initial fetch for the sub id
        .mockResolvedValueOnce(planProFeature()) // re-fetch inside getPlanState
      mockStripe.setSubscriptionCancelAtPeriodEnd.mockResolvedValue({} as any)
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary({ cancelAtPeriodEnd: true }))
      const result = await cancelPlan('venue_1')
      expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledWith('sub_123', true)
      expect(mockStripe.cancelSubscription).not.toHaveBeenCalled()
      expect(result.state).toBe('canceling')
    })

    it('reactivatePlan flips cancel_at_period_end=false', async () => {
      prismaMock.venueFeature.findFirst.mockResolvedValueOnce(planProFeature()).mockResolvedValueOnce(planProFeature())
      mockStripe.setSubscriptionCancelAtPeriodEnd.mockResolvedValue({} as any)
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary())
      const result = await reactivatePlan('venue_1')
      expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledWith('sub_123', false)
      expect(result.state).toBe('active')
    })

    it('cancelPlan throws BadRequestError when there is no Stripe subscription', async () => {
      prismaMock.venueFeature.findFirst.mockResolvedValue(planProFeature({ stripeSubscriptionId: null }))
      await expect(cancelPlan('venue_1')).rejects.toThrow(BadRequestError)
      await expect(cancelPlan('venue_1')).rejects.toThrow('suscripción de Stripe que cancelar')
    })

    it('cancelPlan throws BadRequestError when there is no PLAN_PRO plan at all', async () => {
      prismaMock.venueFeature.findFirst.mockResolvedValue(null)
      await expect(cancelPlan('venue_1')).rejects.toThrow(BadRequestError)
    })
  })
})
