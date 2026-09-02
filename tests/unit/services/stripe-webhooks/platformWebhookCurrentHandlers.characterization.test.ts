jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    staffVenue: { findMany: jest.fn() },
    venue: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: {} }))
jest.mock('@/services/access/planNotification.service', () => ({ resolvePlanNotificationTarget: jest.fn() }))
jest.mock('@/services/dashboard/notification.dashboard.service', () => ({ createNotification: jest.fn() }))
jest.mock('@/services/stripe.service', () => ({
  handlePaymentFailure: jest.fn(),
  generateBillingPortalUrl: jest.fn(),
  fulfillPlanCheckout: jest.fn(),
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getServer: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/dashboard/token-budget.service', () => ({
  tokenBudgetService: {
    completeInvoicePurchase: jest.fn(),
    failInvoicePurchase: jest.fn(),
    completePurchase: jest.fn(),
    failPurchase: jest.fn(),
  },
}))
jest.mock('@/services/dashboard/creditPack.public.service', () => ({ fulfillPurchase: jest.fn() }))
jest.mock('@/services/dashboard/seatReconciliation.service', () => ({
  executeSeatReconciliation: jest.fn(),
  reactivateSeatCapDeactivated: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { tokenBudgetService } from '@/services/dashboard/token-budget.service'
import {
  handleCustomerDeleted,
  handleInvoicePaymentFailed,
  handleInvoicePaymentSucceeded,
  handlePaymentMethodAttached,
  handlePaymentIntentFailed,
  handlePaymentIntentSucceeded,
  handleSubscriptionDeleted,
  handleSubscriptionTrialWillEnd,
  handleSubscriptionUpdated,
} from '@/services/stripe.webhook.service'

const db = prisma as any

beforeEach(() => {
  jest.clearAllMocks()
  db.venueFeature.update.mockResolvedValue({})
  db.venueFeature.findMany.mockResolvedValue([])
  db.venueFeature.updateMany.mockResolvedValue({ count: 0 })
  db.staffVenue.findMany.mockResolvedValue([])
  db.venue.update.mockResolvedValue({})
})

describe('closed result-effective observations from current handlers', () => {
  it('returns TOKEN_INVOICE_APPLIED after the existing token invoice side effect succeeds', async () => {
    const invoice = {
      id: 'in_token',
      amount_paid: 100,
      currency: 'mxn',
      metadata: { type: 'chatbot_tokens_purchase', venueId: 'venue-1', tokenAmount: '10' },
    } as any

    await expect(handleInvoicePaymentSucceeded(invoice)).resolves.toBe('TOKEN_INVOICE_APPLIED')
    expect(tokenBudgetService.completeInvoicePurchase).toHaveBeenCalledWith('in_token', {
      invoicePdfUrl: undefined,
      hostedInvoiceUrl: undefined,
    })
  })

  it('distinguishes no subscription, applied subscription and matched-no-change without changing writes', async () => {
    await expect(
      handleInvoicePaymentSucceeded({ id: 'in_none', amount_paid: 0, currency: 'mxn', metadata: {}, subscription: null } as any),
    ).resolves.toBe('INVOICE_NOOP_NO_SUBSCRIPTION')

    db.venueFeature.findFirst.mockResolvedValueOnce({
      id: 'vf-1',
      venueId: 'venue-1',
      active: false,
      feature: { code: 'PLAN_PRO' },
      venue: { status: 'ACTIVE' },
    })
    await expect(
      handleInvoicePaymentSucceeded({ id: 'in_apply', amount_paid: 100, currency: 'mxn', metadata: {}, subscription: 'sub-1' } as any),
    ).resolves.toBe('SUBSCRIPTION_INVOICE_APPLIED')
    expect(db.venueFeature.update).toHaveBeenCalledTimes(1)

    db.venueFeature.findFirst.mockResolvedValueOnce({
      id: 'vf-1',
      venueId: 'venue-1',
      active: true,
      feature: { code: 'PLAN_PRO' },
      venue: { status: 'ACTIVE' },
    })
    await expect(
      handleInvoicePaymentSucceeded({ id: 'in_same', amount_paid: 100, currency: 'mxn', metadata: {}, subscription: 'sub-1' } as any),
    ).resolves.toBe('SUBSCRIPTION_INVOICE_MATCHED_NO_CHANGE')
    expect(db.venueFeature.update).toHaveBeenCalledTimes(1)
  })

  it('returns the non-operational no-op after the same local subject lookup', async () => {
    db.venueFeature.findFirst.mockResolvedValueOnce({
      id: 'vf-1',
      venueId: 'venue-1',
      active: false,
      feature: { code: 'PLAN_PRO' },
      venue: { status: 'SUSPENDED' },
    })

    await expect(
      handleInvoicePaymentSucceeded({ id: 'in_suspended', amount_paid: 100, currency: 'mxn', metadata: {}, subscription: 'sub-1' } as any),
    ).resolves.toBe('INVOICE_NOOP_VENUE_NOT_OPERATIONAL')
    expect(db.venueFeature.update).not.toHaveBeenCalled()
  })

  it('keeps the failed invoice token and no-subscription paths observationally distinct', async () => {
    await expect(
      handleInvoicePaymentFailed({
        id: 'in_failed_token',
        amount_due: 100,
        currency: 'mxn',
        metadata: { type: 'chatbot_tokens_purchase' },
      } as any),
    ).resolves.toBe('TOKEN_INVOICE_APPLIED')
    expect(tokenBudgetService.failInvoicePurchase).toHaveBeenCalledWith('in_failed_token')

    await expect(
      handleInvoicePaymentFailed({ id: 'in_failed_none', amount_due: 100, currency: 'mxn', metadata: {}, subscription: null } as any),
    ).resolves.toBe('INVOICE_NOOP_NO_SUBSCRIPTION')
  })

  it('returns token applied or not-token while preserving PaymentIntent side effects', async () => {
    await expect(handlePaymentIntentSucceeded({ id: 'pi_token', metadata: { type: 'chatbot_tokens' }, amount: 100 } as any)).resolves.toBe(
      'TOKEN_PAYMENT_INTENT_APPLIED',
    )
    expect(tokenBudgetService.completePurchase).toHaveBeenCalledWith('pi_token')

    await expect(handlePaymentIntentSucceeded({ id: 'pi_other', metadata: {}, amount: 100 } as any)).resolves.toBe(
      'PAYMENT_INTENT_NOOP_NOT_TOKEN',
    )
    await expect(handlePaymentIntentFailed({ id: 'pi_failed_other', metadata: {} } as any)).resolves.toBe('PAYMENT_INTENT_NOOP_NOT_TOKEN')
  })

  it('distinguishes subscription subject absence, operational no-op, matched-no-change and applied', async () => {
    db.venueFeature.findFirst.mockResolvedValueOnce(null)
    await expect(handleSubscriptionUpdated({ id: 'sub-none', status: 'active' } as any)).resolves.toBe('NOOP_SUBJECT_NOT_FOUND')

    db.venueFeature.findFirst.mockResolvedValueOnce({
      id: 'vf-1',
      venueId: 'venue-1',
      featureId: 'feature-1',
      feature: { code: 'ADDON' },
      venue: { status: 'SUSPENDED' },
    })
    await expect(handleSubscriptionUpdated({ id: 'sub-suspended', status: 'active' } as any)).resolves.toBe('NOOP_VENUE_NOT_OPERATIONAL')

    db.venueFeature.findFirst.mockResolvedValueOnce({
      id: 'vf-1',
      venueId: 'venue-1',
      featureId: 'feature-1',
      feature: { code: 'ADDON' },
      venue: { status: 'ACTIVE' },
    })
    await expect(handleSubscriptionUpdated({ id: 'sub-due', status: 'past_due' } as any)).resolves.toBe('MATCHED_NO_CHANGE')

    db.venueFeature.findFirst.mockResolvedValueOnce({
      id: 'vf-1',
      venueId: 'venue-1',
      featureId: 'feature-1',
      feature: { code: 'ADDON' },
      venue: { status: 'ACTIVE' },
    })
    await expect(handleSubscriptionUpdated({ id: 'sub-active', status: 'active' } as any)).resolves.toBe('APPLIED')
    expect(db.venueFeature.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'vf-1' } }))
  })

  it('distinguishes deleted subscription, trial and customer subjects without changing writes', async () => {
    db.venueFeature.findMany.mockResolvedValueOnce([])
    db.venueFeature.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(handleSubscriptionDeleted({ id: 'sub-missing' } as any)).resolves.toBe('NOOP_SUBJECT_NOT_FOUND')

    db.venueFeature.findFirst.mockResolvedValueOnce(null)
    await expect(handleSubscriptionTrialWillEnd({ id: 'sub-trial-missing', trial_end: 1 } as any)).resolves.toBe('NOOP_SUBJECT_NOT_FOUND')

    db.venue.findFirst.mockResolvedValueOnce(null)
    await expect(handleCustomerDeleted({ id: 'cus-missing' } as any)).resolves.toBe('NOOP_SUBJECT_NOT_FOUND')

    db.venue.findFirst.mockResolvedValueOnce({ id: 'venue-1', name: 'Venue', slug: 'venue' })
    db.venueFeature.updateMany.mockResolvedValueOnce({ count: 2 })
    await expect(handleCustomerDeleted({ id: 'cus-present' } as any)).resolves.toBe('APPLIED')
    expect(db.venue.update).toHaveBeenCalledWith({ where: { id: 'venue-1' }, data: { stripeCustomerId: null } })
  })

  it('returns a closed no-op before any Stripe call for invalid payment-method inputs', async () => {
    await expect(handlePaymentMethodAttached({ id: 'pm-no-customer', customer: null, card: { fingerprint: 'fp' } } as any)).resolves.toBe(
      'NOOP_INVALID_INPUT',
    )
    await expect(handlePaymentMethodAttached({ id: 'pm-no-fingerprint', customer: 'cus-1', card: {} } as any)).resolves.toBe(
      'NOOP_INVALID_INPUT',
    )
  })
})
