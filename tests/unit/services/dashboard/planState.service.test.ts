import { prismaMock } from '../../../__helpers__/setup'
import * as stripeService from '@/services/stripe.service'
import { BadRequestError } from '@/errors/AppError'
import { getPlanState, cancelPlan, reactivatePlan } from '@/services/dashboard/planState.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import logger from '@/config/logger'

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
    // Añadido por OTRA sesión al tipo de producción en `fe1b1499` (la pausa de cobranza) sin actualizar este ayudante:
    // el commit dejó `develop` sin typechequear (8 errores TS2345). Aquí sólo se hace compilar — sin cambiar comportamiento,
    // porque `null` es lo que ya asumía cada aserción de esta suite.
    pausedUntil: null as Date | null,
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

function planContract(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hc_1',
    venueId: 'venue_1',
    planTier: 'PRO',
    stripeSubscriptionId: 'sub_h1',
    revision: 3,
    paidThrough: future,
    cancelAt: null,
    endedAt: null,
    publication: {
      definition: {
        schemaVersion: 1,
        kind: 'PLAN',
        planTier: 'PRO',
        terms: {
          currency: 'MXN',
          interval: 'MONTHLY',
          price: 1158.84,
          taxIncluded: true,
          promotionCycles: 3,
          renewal: { kind: 'SAME_PRICE' },
        },
      },
    },
    purchase: { lastIssue: null },
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
      prismaMock.venueFeature.findMany.mockResolvedValue([])
      const result = await getPlanState('venue_1')
      expect(result.hasPlan).toBe(false)
      expect(result.state).toBe('none')
      expect(result.stripeSubscriptionId).toBeNull()
    })

    it('returns "active" with real currentPeriodEnd + IVA gross/base price from Stripe', async () => {
      prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature()])
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

    it('🔴 Codex C8: con DOS filas de plan (la vieja retirada primero) administra la VIGENTE', async () => {
      prismaMock.venueFeature.findMany.mockResolvedValue([
        planProFeature({ id: 'vf_viejo', active: false, stripeSubscriptionId: null }),
        planProFeature({
          id: 'vf_premium',
          stripeSubscriptionId: 'sub_premium',
          feature: { code: 'PLAN_PREMIUM', name: 'Plan Avoqado Premium' },
        }),
      ])
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary())

      const result = await getPlanState('venue_1')

      expect(result.state).toBe('active')
      expect(result.planTier).toBe('PREMIUM')
      expect(result.stripeSubscriptionId).toBe('sub_premium')
    })

    it('returns "canceling" when Stripe sub has cancelAtPeriodEnd=true', async () => {
      prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature()])
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary({ cancelAtPeriodEnd: true }))
      const result = await getPlanState('venue_1')
      expect(result.state).toBe('canceling')
      expect(result.cancelAtPeriodEnd).toBe(true)
    })

    it('retentionOfferEligible reflects tenure and active-discount state', async () => {
      // Eligible baseline (tenured, no discount).
      prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature()])
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary())
      expect((await getPlanState('venue_1')).retentionOfferEligible).toBe(true)

      // Tenure < 30 days → NOT eligible (anti-farm).
      prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature()])
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary({ createdAt: freshCreatedAt }))
      expect((await getPlanState('venue_1')).retentionOfferEligible).toBe(false)

      // Discount already active → NOT eligible (non-stackable).
      prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature()])
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary({ hasActiveDiscount: true }))
      expect((await getPlanState('venue_1')).retentionOfferEligible).toBe(false)

      // DB-only plan (no Stripe sub) → NOT eligible (nothing to discount).
      prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature({ stripeSubscriptionId: null })])
      expect((await getPlanState('venue_1')).retentionOfferEligible).toBe(false)
    })

    it('returns "trial" with trialEndsAt and no Stripe call failing the response (DB-only trial)', async () => {
      prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature({ endDate: future, stripeSubscriptionId: null })])
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
      prismaMock.venueFeature.findMany.mockResolvedValue([
        planProFeature({ suspendedAt: new Date(Date.now() - 86400000), monthlyPrice: null }),
      ])
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
      prismaMock.venueFeature.findMany
        .mockResolvedValueOnce([planProFeature()]) // initial fetch for the sub id
        .mockResolvedValueOnce([planProFeature()]) // re-fetch inside getPlanState
      mockStripe.setSubscriptionCancelAtPeriodEnd.mockResolvedValue({} as any)
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary({ cancelAtPeriodEnd: true }))
      const result = await cancelPlan('venue_1')
      expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledWith('sub_123', true)
      expect(mockStripe.cancelSubscription).not.toHaveBeenCalled()
      expect(result.state).toBe('canceling')
    })

    it('reactivatePlan flips cancel_at_period_end=false', async () => {
      prismaMock.venueFeature.findMany.mockResolvedValueOnce([planProFeature()]).mockResolvedValueOnce([planProFeature()])
      mockStripe.setSubscriptionCancelAtPeriodEnd.mockResolvedValue({} as any)
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary())
      const result = await reactivatePlan('venue_1')
      expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledWith('sub_123', false)
      expect(result.state).toBe('active')
    })

    it('cancelPlan throws BadRequestError when there is no Stripe subscription', async () => {
      prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature({ stripeSubscriptionId: null })])
      await expect(cancelPlan('venue_1')).rejects.toThrow(BadRequestError)
      await expect(cancelPlan('venue_1')).rejects.toThrow('suscripción de Stripe que cancelar')
    })

    it('cancelPlan throws BadRequestError when there is no PLAN_PRO plan at all', async () => {
      prismaMock.venueFeature.findMany.mockResolvedValue([])
      await expect(cancelPlan('venue_1')).rejects.toThrow(BadRequestError)
    })
  })

  describe('cancelPlan with the owner reason', () => {
    beforeEach(() => {
      prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature()])
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary())
      mockStripe.setSubscriptionCancelAtPeriodEnd.mockResolvedValue({} as any)
    })

    it('sends Stripe the mapped reason and audits ours, with the actor', async () => {
      await cancelPlan('venue_1', { reason: 'TEMPORARY', comment: 'Cerramos en agosto', staffId: 'staff_1' })
      expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledWith('sub_123', true, {
        feedback: 'unused',
        comment: '[temporal] Cerramos en agosto',
      })
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PLAN_CANCEL_SCHEDULED',
          staffId: 'staff_1',
          data: expect.objectContaining({ reason: 'TEMPORARY', comment: 'Cerramos en agosto' }),
        }),
      )
    })

    it('without a reason behaves as before: two arguments to Stripe and no reason in the audit', async () => {
      await cancelPlan('venue_1')
      expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledWith('sub_123', true)
      const data = (logAction as jest.Mock).mock.calls.at(-1)[0].data
      expect(data).not.toHaveProperty('reason')
      expect(data).not.toHaveProperty('comment')
    })
  })

  describe('origin: the one obligation behind "Tu plan"', () => {
    it('CLASSIC: the live classic row, with its Stripe price and period', async () => {
      prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature()])
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary())
      const { origin } = await getPlanState('venue_1')
      expect(origin).toEqual({
        kind: 'CLASSIC',
        tier: 'PRO',
        price: { base: 999, gross: 1158.84, currency: 'MXN' },
        interval: 'month',
        currentPeriodEnd: future.toISOString(),
        cancelAt: null,
        contractId: null,
        contractRevision: null,
        subscriptionId: 'sub_123',
        paymentIssue: null,
      })
    })

    it('CLASSIC scheduled to end: cancelAt is the period end', async () => {
      prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature()])
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary({ cancelAtPeriodEnd: true }))
      expect((await getPlanState('venue_1')).origin?.cancelAt).toBe(future.toISOString())
    })

    it('COMP: a plan row without Stripe says until when, with no price', async () => {
      const until = new Date(Date.now() + 10 * DAY_MS)
      prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature({ stripeSubscriptionId: null, endDate: until })])
      prismaMock.hybridContract.findFirst.mockResolvedValue(null)
      const { origin } = await getPlanState('venue_1')
      expect(origin).toMatchObject({ kind: 'COMP', tier: 'PRO', price: null, currentPeriodEnd: until.toISOString() })
    })

    it('R4b: a paid plan contract wins over a courtesy/trial row inside its dates', async () => {
      const until = new Date(Date.now() + 10 * DAY_MS)
      prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature({ stripeSubscriptionId: null, endDate: until })])
      prismaMock.hybridContract.findFirst.mockResolvedValue(planContract())
      prismaMock.hybridPaymentPeriod.findFirst.mockResolvedValue(null)
      expect((await getPlanState('venue_1')).origin).toMatchObject({ kind: 'CONTRACT', tier: 'PRO', contractId: 'hc_1' })
    })

    it('R4a: a contract whose stored offer is invalid degrades to no price, never throws', async () => {
      prismaMock.venueFeature.findMany.mockResolvedValue([])
      prismaMock.hybridContract.findFirst.mockResolvedValue(planContract({ publication: { definition: { kind: 'PLAN', garbage: true } } }))
      prismaMock.hybridPaymentPeriod.findFirst.mockResolvedValue(null)
      const { origin } = await getPlanState('venue_1')
      expect(origin).toMatchObject({ kind: 'CONTRACT', tier: 'PRO', price: null, contractId: 'hc_1' })
      expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ venueId: 'venue_1', contractId: 'hc_1' }))
    })

    it('CONTRACT: the live plan contract, with what its last paid period charged', async () => {
      prismaMock.venueFeature.findMany.mockResolvedValue([])
      prismaMock.hybridContract.findFirst.mockResolvedValue(planContract())
      prismaMock.hybridPaymentPeriod.findFirst.mockResolvedValue({ composition: [{ contractId: 'hc_1', amount: '22.00' }] })
      expect((await getPlanState('venue_1')).origin).toEqual({
        kind: 'CONTRACT',
        tier: 'PRO',
        price: { base: 18.97, gross: 22, currency: 'MXN' },
        interval: 'month',
        currentPeriodEnd: future.toISOString(),
        cancelAt: null,
        contractId: 'hc_1',
        contractRevision: 3,
        subscriptionId: 'sub_h1',
        paymentIssue: null,
      })
    })

    it('CONTRACT before any paid period uses the offer price', async () => {
      prismaMock.venueFeature.findMany.mockResolvedValue([])
      prismaMock.hybridContract.findFirst.mockResolvedValue(planContract())
      prismaMock.hybridPaymentPeriod.findFirst.mockResolvedValue(null)
      expect((await getPlanState('venue_1')).origin?.price).toEqual({ base: 999, gross: 1158.84, currency: 'MXN' })
    })

    it('a retired classic row never wins over a live plan contract', async () => {
      prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature({ active: false, endDate: new Date(Date.now() - DAY_MS) })])
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary({ status: 'canceled' }))
      prismaMock.hybridContract.findFirst.mockResolvedValue(planContract({ planTier: 'PREMIUM' }))
      prismaMock.hybridPaymentPeriod.findFirst.mockResolvedValue(null)
      expect((await getPlanState('venue_1')).origin).toMatchObject({ kind: 'CONTRACT', tier: 'PREMIUM' })
    })

    it('skips contracts that ended or whose cancellation already took effect, Premium first', async () => {
      prismaMock.venueFeature.findMany.mockResolvedValue([])
      await getPlanState('venue_1')
      expect(prismaMock.hybridContract.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            venueId: 'venue_1',
            endedAt: null,
            planTier: { in: ['PRO', 'PREMIUM'] },
            OR: [{ cancelAt: null }, { cancelAt: { gt: expect.any(Date) } }],
          },
          orderBy: [{ planTier: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
        }),
      )
    })

    it('NONE: Gratis', async () => {
      prismaMock.venueFeature.findMany.mockResolvedValue([])
      prismaMock.hybridContract.findFirst.mockResolvedValue(null)
      expect((await getPlanState('venue_1')).origin?.kind).toBe('NONE')
    })
  })

  describe('pauseOfferEligible: the same checks applyRetentionOffer enforces', () => {
    beforeEach(() => {
      prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature()])
      prismaMock.activityLog.findFirst.mockResolvedValue(null)
    })

    it('true for a live classic plan, even a new one: a pause is not a discount', async () => {
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary({ createdAt: freshCreatedAt }))
      expect((await getPlanState('venue_1')).pauseOfferEligible).toBe(true)
    })

    it('false with an active discount', async () => {
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary({ hasActiveDiscount: true }))
      expect((await getPlanState('venue_1')).pauseOfferEligible).toBe(false)
    })

    it('false while collection is already paused', async () => {
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary({ pausedUntil: future }))
      expect((await getPlanState('venue_1')).pauseOfferEligible).toBe(false)
    })

    it('false after a pause in the last 12 months', async () => {
      mockStripe.retrievePlanSubscription.mockResolvedValue(subSummary())
      prismaMock.activityLog.findFirst.mockResolvedValue({ createdAt: new Date() })
      expect((await getPlanState('venue_1')).pauseOfferEligible).toBe(false)
    })

    it('false for a comped plan (no Stripe subscription)', async () => {
      prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature({ stripeSubscriptionId: null })])
      expect((await getPlanState('venue_1')).pauseOfferEligible).toBe(false)
    })
  })
})
