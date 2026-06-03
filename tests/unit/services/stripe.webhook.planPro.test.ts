/**
 * PLAN_PRO Base-Plan Webhook Regression Tests
 *
 * The base plan `PLAN_PRO` is just another VenueFeature row (feature.code === 'PLAN_PRO')
 * keyed by `stripeSubscriptionId`. When its Stripe subscription reaches a terminal failure
 * state (unpaid / canceled) after Stripe's own retry + grace period, the existing webhook
 * handler (`handleSubscriptionUpdated`) must deactivate that VenueFeature (active: false).
 *
 * Because `venueHasActiveBasePlan` reads exactly active/suspendedAt/endDate, deactivating the
 * PLAN_PRO VenueFeature AUTOMATICALLY drops the venue to the basic feature set — no separate
 * venue-level flag is involved. This test pins that behavior: a PLAN_PRO subscription going
 * terminal flips the mapped VenueFeature to active:false, identical to any other feature.
 *
 * NOTE: This drives the REAL exported `handleSubscriptionUpdated` from the webhook service,
 * not a reimplementation. Mock shape mirrors `stripe.webhook.service.test.ts` exactly.
 */

import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'

// Mock credit pack public service BEFORE importing webhook service to prevent Stripe SDK initialization error
jest.mock('@/services/dashboard/creditPack.public.service', () => ({
  __esModule: true,
  fulfillPurchase: jest.fn(),
}))

// Mock Stripe service BEFORE importing webhook service to prevent Stripe SDK initialization error
jest.mock('@/services/stripe.service', () => ({
  __esModule: true,
  default: jest.fn(),
  getOrCreateStripeCustomer: jest.fn(),
  createTrialSubscriptions: jest.fn(),
  cancelSubscription: jest.fn(),
  updatePaymentMethod: jest.fn(),
  createTrialSetupIntent: jest.fn(),
  convertTrialToPaid: jest.fn(),
  getCustomerInvoices: jest.fn(),
  getInvoicePdfUrl: jest.fn(),
  syncFeaturesToStripe: jest.fn(),
  createCustomerPortalSession: jest.fn(),
  handlePaymentFailure: jest.fn(),
  generateBillingPortalUrl: jest.fn(),
}))

import { handleSubscriptionUpdated } from '@/services/stripe.webhook.service'

// Mock prisma — same shape as the sibling webhook test. The subscription maps to a PLAN_PRO
// VenueFeature whose grace period has already passed (gracePeriodEndsAt in the past,
// paymentFailureCount exhausted). The handler keys off `stripeSubscriptionId` via findFirst.
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    webhookEvent: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    venueFeature: {
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    staffVenue: {
      findMany: jest.fn(),
    },
    venue: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: {
    sendTrialEndingEmail: jest.fn(),
  },
}))

jest.mock('@/services/dashboard/notification.dashboard.service', () => ({
  createNotification: jest.fn(),
}))

// A PLAN_PRO VenueFeature whose Stripe subscription has exhausted its retry + grace window.
// gracePeriodEndsAt is in the past and paymentFailureCount is high to read as "grace passed".
const planProVenueFeature = {
  id: 'vf1',
  venueId: 'v1',
  featureId: 'feat_pro',
  active: true,
  paymentFailureCount: 3,
  gracePeriodEndsAt: new Date(Date.now() - 86400000), // grace already passed (yesterday)
  stripeSubscriptionId: 'sub_pro',
  feature: { id: 'feat_pro', code: 'PLAN_PRO', name: 'Plan Pro' },
  venue: { id: 'v1', name: 'Test Venue', status: 'ACTIVE' },
}

describe('Stripe Webhook — PLAN_PRO base plan deactivation on terminal failure', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // NEW BEHAVIOR: terminal failure past grace drops PLAN_PRO to basic
  // ──────────────────────────────────────────────────────────────────────────

  it('deactivates the PLAN_PRO VenueFeature when subscription goes "unpaid" after grace passed', async () => {
    // Stripe escalates past_due → unpaid only after its own retry/grace window is exhausted.
    const mockSubscription = {
      id: 'sub_pro',
      object: 'subscription',
      status: 'unpaid',
      current_period_end: Math.floor(Date.now() / 1000),
      created: Date.now() / 1000,
      customer: 'cus_pro',
      livemode: false,
      metadata: { featureCode: 'PLAN_PRO', venueId: 'v1' },
    } as unknown as Stripe.Subscription

    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce(planProVenueFeature)
    ;(prisma.venueFeature.update as jest.Mock).mockResolvedValueOnce({})

    await handleSubscriptionUpdated(mockSubscription)

    // The mapped PLAN_PRO VenueFeature must be deactivated → venue falls back to basic feature set.
    expect(prisma.venueFeature.update).toHaveBeenCalledTimes(1)
    const updateArg = (prisma.venueFeature.update as jest.Mock).mock.calls[0][0]
    expect(updateArg.where).toEqual({ id: 'vf1' })
    // active:false is the deactivation signal venueHasActiveBasePlan reads.
    // (suspendedAt may also be set by a future enhancement; assert active:false is the contract.)
    expect(updateArg.data.active).toBe(false)
  })

  it('deactivates the PLAN_PRO VenueFeature when subscription is "canceled"', async () => {
    const mockSubscription = {
      id: 'sub_pro',
      object: 'subscription',
      status: 'canceled',
      current_period_end: Math.floor(Date.now() / 1000),
      created: Date.now() / 1000,
      customer: 'cus_pro',
      livemode: false,
      metadata: { featureCode: 'PLAN_PRO', venueId: 'v1' },
    } as unknown as Stripe.Subscription

    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce(planProVenueFeature)
    ;(prisma.venueFeature.update as jest.Mock).mockResolvedValueOnce({})

    await handleSubscriptionUpdated(mockSubscription)

    expect(prisma.venueFeature.update).toHaveBeenCalledWith({
      where: { id: 'vf1' },
      data: { active: false },
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // REGRESSION: PLAN_PRO is treated exactly like any other VenueFeature; no
  // PLAN_PRO-specific branch should change grace/early-stage behavior.
  // ──────────────────────────────────────────────────────────────────────────

  it('does NOT deactivate PLAN_PRO on "past_due" alone (grace not yet exhausted by Stripe)', async () => {
    // past_due means Stripe is still retrying; it has not yet escalated to unpaid.
    const mockSubscription = {
      id: 'sub_pro',
      object: 'subscription',
      status: 'past_due',
      created: Date.now() / 1000,
      customer: 'cus_pro',
      livemode: false,
      metadata: { featureCode: 'PLAN_PRO', venueId: 'v1' },
    } as unknown as Stripe.Subscription

    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce({
      ...planProVenueFeature,
      gracePeriodEndsAt: new Date(Date.now() + 86400000), // grace still active (tomorrow)
      paymentFailureCount: 1,
    })

    await handleSubscriptionUpdated(mockSubscription)

    // Stripe will keep retrying — venue keeps PLAN_PRO until terminal failure.
    expect(prisma.venueFeature.update).not.toHaveBeenCalled()
  })

  it('does not deactivate any feature when the subscription maps to no VenueFeature', async () => {
    const mockSubscription = {
      id: 'sub_unknown',
      object: 'subscription',
      status: 'unpaid',
      created: Date.now() / 1000,
      customer: 'cus_pro',
      livemode: false,
    } as unknown as Stripe.Subscription

    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce(null)

    await handleSubscriptionUpdated(mockSubscription)

    expect(prisma.venueFeature.update).not.toHaveBeenCalled()
  })
})
