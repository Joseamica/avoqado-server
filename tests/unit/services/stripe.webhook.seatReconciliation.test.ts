/**
 * Proves the Pro→Free seat reconciliation hook fires on the paid→Free transition in the Stripe
 * webhook, and ONLY there:
 *   - handleSubscriptionUpdated('canceled') for a BASE-PLAN feature → executeSeatReconciliation(venue)
 *   - handleSubscriptionUpdated('canceled') for a NON-base-plan add-on → NOT called
 *   - handleSubscriptionDeleted for a base-plan sub → executeSeatReconciliation(venue)
 *   - a reconciliation failure NEVER throws (must not fail the webhook)
 *
 * Self-contained prisma + dependency mocks (does not touch the existing webhook test's mocks).
 */
import Stripe from 'stripe'

// Mock the reconciliation service so we can assert the hooks are invoked (the service's own
// behavior is covered by seatReconciliation.service.test.ts).
jest.mock('@/services/dashboard/seatReconciliation.service', () => ({
  __esModule: true,
  executeSeatReconciliation: jest.fn().mockResolvedValue(0),
  reactivateSeatCapDeactivated: jest.fn().mockResolvedValue(0),
}))

// Mock the Stripe service module to avoid SDK init at import time.
jest.mock('@/services/stripe.service', () => ({
  __esModule: true,
  default: jest.fn(),
  handlePaymentFailure: jest.fn(),
  generateBillingPortalUrl: jest.fn(),
  fulfillPlanCheckout: jest.fn(),
}))
jest.mock('@/services/dashboard/creditPack.public.service', () => ({
  __esModule: true,
  fulfillPurchase: jest.fn(),
}))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendTrialEndingEmail: jest.fn() } }))
jest.mock('@/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn(),
}))
jest.mock('@/services/dashboard/notification.dashboard.service', () => ({ createNotification: jest.fn() }))
jest.mock('@/services/dashboard/token-budget.service', () => ({ tokenBudgetService: {} }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getServer: () => null, broadcastToVenue: jest.fn() } }))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    venue: { findUnique: jest.fn(), update: jest.fn() },
    webhookEvent: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import prisma from '@/utils/prismaClient'
import { fulfillPlanCheckout } from '@/services/stripe.service'
import { executeSeatReconciliation, reactivateSeatCapDeactivated } from '@/services/dashboard/seatReconciliation.service'
import { handleSubscriptionUpdated, handleSubscriptionDeleted, handleStripeWebhookEvent } from '@/services/stripe.webhook.service'

const execMock = executeSeatReconciliation as jest.Mock
const reactivateMock = reactivateSeatCapDeactivated as jest.Mock
const fulfillMock = fulfillPlanCheckout as jest.Mock

function baseplanFeature(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vf_1',
    venueId: 'venue_1',
    featureId: 'feat_1',
    active: true,
    feature: { code: 'PLAN_PRO', name: 'Plan Avoqado Pro' },
    venue: { id: 'venue_1', name: 'Test Venue', status: 'ACTIVE' },
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.venueFeature.update as jest.Mock).mockResolvedValue({})
  ;(prisma.venueFeature.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
})

describe('stripe webhook → seat reconciliation hook', () => {
  it('runs executeSeatReconciliation on a base-plan paid→Free transition (status=canceled)', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(baseplanFeature())

    await handleSubscriptionUpdated({ id: 'sub_1', status: 'canceled' } as Stripe.Subscription)

    expect(prisma.venueFeature.update).toHaveBeenCalled() // feature deactivated first
    expect(execMock).toHaveBeenCalledWith('venue_1') // then reconciliation runs
  })

  it('does NOT run reconciliation when the canceled feature is a non-base-plan add-on', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(
      baseplanFeature({ feature: { code: 'CHATBOT', name: 'Chatbot Add-on' } }),
    )

    await handleSubscriptionUpdated({ id: 'sub_2', status: 'canceled' } as Stripe.Subscription)

    expect(prisma.venueFeature.update).toHaveBeenCalled()
    expect(execMock).not.toHaveBeenCalled() // add-ons don't trigger seat reconciliation
  })

  it('runs reconciliation from handleSubscriptionDeleted for a base-plan subscription', async () => {
    ;(prisma.venueFeature.findMany as jest.Mock).mockResolvedValue([{ venueId: 'venue_1', feature: { code: 'PLAN_PRO' } }])

    await handleSubscriptionDeleted({ id: 'sub_3' } as Stripe.Subscription)

    expect(prisma.venueFeature.updateMany).toHaveBeenCalled() // features deactivated
    expect(execMock).toHaveBeenCalledWith('venue_1')
  })

  it('a reconciliation failure never throws (webhook must not fail)', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(baseplanFeature())
    execMock.mockRejectedValueOnce(new Error('boom'))

    await expect(handleSubscriptionUpdated({ id: 'sub_4', status: 'canceled' } as Stripe.Subscription)).resolves.toBeUndefined()
    expect(execMock).toHaveBeenCalledWith('venue_1')
  })
})

describe('stripe webhook → seat REACTIVATION hook (re-upgrade to paid plan)', () => {
  it('runs reactivateSeatCapDeactivated on a base-plan Free→paid transition (status=active)', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(baseplanFeature())

    await handleSubscriptionUpdated({ id: 'sub_5', status: 'active' } as Stripe.Subscription)

    expect(prisma.venueFeature.update).toHaveBeenCalled() // feature (re)activated
    expect(reactivateMock).toHaveBeenCalledWith('venue_1') // cap-deactivated seats reactivated
    expect(execMock).not.toHaveBeenCalled() // never deactivates on an activation
  })

  it('does NOT reactivate when the activated feature is a non-base-plan add-on', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(
      baseplanFeature({ feature: { code: 'CHATBOT', name: 'Chatbot Add-on' } }),
    )

    await handleSubscriptionUpdated({ id: 'sub_6', status: 'active' } as Stripe.Subscription)

    expect(prisma.venueFeature.update).toHaveBeenCalled()
    expect(reactivateMock).not.toHaveBeenCalled() // add-ons don't trigger seat reactivation
  })

  it('a reactivation failure never throws (webhook must not fail)', async () => {
    ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(baseplanFeature())
    reactivateMock.mockRejectedValueOnce(new Error('boom'))

    await expect(handleSubscriptionUpdated({ id: 'sub_7', status: 'active' } as Stripe.Subscription)).resolves.toBeUndefined()
    expect(reactivateMock).toHaveBeenCalledWith('venue_1')
  })

  it('runs reactivateSeatCapDeactivated on fulfillPlanCheckout (base-plan checkout.session.completed)', async () => {
    ;(prisma.webhookEvent.create as jest.Mock).mockResolvedValue({ id: 'whe_1' })
    ;(prisma.webhookEvent.update as jest.Mock).mockResolvedValue({})
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ id: 'venue_1' })
    fulfillMock.mockResolvedValue({
      venueId: 'venue_1',
      featureId: 'feat_1',
      featureCode: 'PLAN_PRO',
      subscriptionId: 'sub_8',
      endDate: null,
    })

    const event = {
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          metadata: { tierCode: 'PLAN_PRO', venueId: 'venue_1', interval: 'month' },
        },
      },
    } as unknown as Stripe.Event

    await handleStripeWebhookEvent(event)

    expect(fulfillMock).toHaveBeenCalled()
    expect(reactivateMock).toHaveBeenCalledWith('venue_1')
  })

  it('does NOT reactivate for a non-base-plan checkout (e.g. credit pack)', async () => {
    ;(prisma.webhookEvent.create as jest.Mock).mockResolvedValue({ id: 'whe_2' })
    ;(prisma.webhookEvent.update as jest.Mock).mockResolvedValue({})

    const event = {
      id: 'evt_2',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_2',
          metadata: { type: 'credit_pack_purchase', venueId: 'venue_1', packId: 'pack_1' },
        },
      },
    } as unknown as Stripe.Event

    await handleStripeWebhookEvent(event)

    expect(fulfillMock).not.toHaveBeenCalled()
    expect(reactivateMock).not.toHaveBeenCalled()
  })
})
