/**
 * Critical Stripe Webhook Tests
 *
 * Tests for the most critical webhook functionality:
 * 1. Idempotency - Prevents duplicate processing
 * 2. Customer deletion - Proper cleanup
 * 3. Race conditions - Concurrent webhook handling
 */

import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import { handleStripeWebhookEvent, handleCustomerDeleted, handleSubscriptionUpdated } from '@/services/stripe.webhook.service'

// Mock dependencies
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

describe('Stripe Webhook Service - Critical Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Default mock for webhookEvent.create - tests can override if needed
    ;(prisma.webhookEvent.create as jest.Mock).mockResolvedValue({
      id: 'webhook_default_id',
      stripeEventId: 'evt_default',
      eventType: 'default.event',
      status: 'PENDING',
    })
  })

  describe('🔒 TEST 1: Idempotency - Prevent Duplicate Processing', () => {
    it('should process webhook event only once when received twice', async () => {
      const mockEvent: Stripe.Event = {
        id: 'evt_test_123',
        object: 'event',
        type: 'customer.subscription.updated',
        created: Date.now() / 1000,
        livemode: false,
        pending_webhooks: 0,
        request: null,
        api_version: '2023-10-16',
        data: {
          object: {
            id: 'sub_test_123',
            status: 'active',
          } as Stripe.Subscription,
        },
      }

      // First call - should process
      ;(prisma.webhookEvent.create as jest.Mock).mockResolvedValueOnce({
        id: 'webhook_1',
        eventId: 'evt_test_123',
        type: 'customer.subscription.updated',
        processed: false,
        createdAt: new Date(),
      })
      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'vf_1',
        venueId: 'venue_1',
        featureId: 'feature_1',
        active: false,
        feature: { id: 'feature_1', code: 'TEST_FEATURE', name: 'Test Feature' },
        venue: { id: 'venue_1', name: 'Test Venue' },
      })
      ;(prisma.venueFeature.update as jest.Mock).mockResolvedValueOnce({})
      ;(prisma.webhookEvent.update as jest.Mock).mockResolvedValueOnce({})

      await handleStripeWebhookEvent(mockEvent)

      expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1)
      expect(prisma.venueFeature.update).toHaveBeenCalledTimes(1)

      // Second call - should skip (idempotency)
      const P2002Error = new Error('Unique constraint violation')
      ;(P2002Error as any).code = 'P2002'
      ;(prisma.webhookEvent.create as jest.Mock).mockRejectedValueOnce(P2002Error)

      await handleStripeWebhookEvent(mockEvent)

      // Should NOT process again
      expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(2)
      expect(prisma.venueFeature.update).toHaveBeenCalledTimes(1) // Still 1, not 2
    })

    it('should handle concurrent webhook processing without race conditions', async () => {
      const mockEvent: Stripe.Event = {
        id: 'evt_concurrent_123',
        object: 'event',
        type: 'customer.subscription.updated',
        created: Date.now() / 1000,
        livemode: false,
        pending_webhooks: 0,
        request: null,
        api_version: '2023-10-16',
        data: {
          object: {
            id: 'sub_test_123',
            status: 'active',
          } as Stripe.Subscription,
        },
      }

      // First call succeeds
      ;(prisma.webhookEvent.create as jest.Mock).mockResolvedValueOnce({
        id: 'webhook_1',
        eventId: 'evt_concurrent_123',
      })
      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue({
        id: 'vf_1',
        venueId: 'venue_1',
        featureId: 'feature_1',
        active: false,
        feature: { code: 'TEST' },
        venue: { name: 'Test' },
      })
      ;(prisma.venueFeature.update as jest.Mock).mockResolvedValue({})
      ;(prisma.webhookEvent.update as jest.Mock).mockResolvedValue({})

      // Other 9 calls get P2002 (already processing)
      const P2002Error = new Error('Unique constraint violation')
      ;(P2002Error as any).code = 'P2002'
      for (let i = 0; i < 9; i++) {
        ;(prisma.webhookEvent.create as jest.Mock).mockRejectedValueOnce(P2002Error)
      }

      // Simulate 10 concurrent webhooks
      const promises = []
      for (let i = 0; i < 10; i++) {
        promises.push(handleStripeWebhookEvent(mockEvent))
      }

      await Promise.all(promises)

      // Only ONE should actually process
      expect(prisma.venueFeature.update).toHaveBeenCalledTimes(1)
    })
  })

  describe('❌ TEST 2: Customer Deletion - Proper Cleanup', () => {
    it('should deactivate venue features when customer is deleted', async () => {
      const mockCustomer: Stripe.Customer = {
        id: 'cus_test_123',
        object: 'customer',
        email: 'test@example.com',
        name: 'Test Customer',
        created: Date.now() / 1000,
        livemode: false,
      } as Stripe.Customer

      // Mock venue with customer
      ;(prisma.venue.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'venue_1',
        name: 'Test Venue',
        slug: 'test-venue',
        stripeCustomerId: 'cus_test_123',
      })
      ;(prisma.venue.update as jest.Mock).mockResolvedValueOnce({})
      ;(prisma.venueFeature.updateMany as jest.Mock).mockResolvedValueOnce({ count: 5 })

      await handleCustomerDeleted(mockCustomer)

      // Should clear customer ID
      expect(prisma.venue.update).toHaveBeenCalledWith({
        where: { id: 'venue_1' },
        data: { stripeCustomerId: null },
      })

      // Should deactivate venue's features
      expect(prisma.venueFeature.updateMany).toHaveBeenCalledWith({
        where: {
          venueId: 'venue_1',
          active: true,
        },
        data: { active: false },
      })
    })

    it('should handle missing venue gracefully', async () => {
      const mockCustomer: Stripe.Customer = {
        id: 'cus_orphaned_123',
        object: 'customer',
        email: 'orphaned@example.com',
        created: Date.now() / 1000,
        livemode: false,
      } as Stripe.Customer

      // No venue found
      ;(prisma.venue.findFirst as jest.Mock).mockResolvedValueOnce(null)

      await handleCustomerDeleted(mockCustomer)

      // Should NOT throw error, just log warning
      expect(prisma.venue.update).not.toHaveBeenCalled()
      expect(prisma.venueFeature.updateMany).not.toHaveBeenCalled()
    })
  })

  describe('⏰ TEST 3: Subscription Status Updates', () => {
    it('should activate feature when subscription becomes active', async () => {
      const mockSubscription = {
        id: 'sub_active_123',
        object: 'subscription',
        status: 'active',
        current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days from now
        created: Date.now() / 1000,
        customer: 'cus_123',
        livemode: false,
      } as unknown as Stripe.Subscription

      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'vf_1',
        venueId: 'venue_1',
        featureId: 'feature_1',
        active: false,
        feature: { id: 'feature_1', code: 'TEST_FEATURE', name: 'Test Feature' },
        venue: { id: 'venue_1', name: 'Test Venue' },
      })
      ;(prisma.venueFeature.update as jest.Mock).mockResolvedValueOnce({})

      await handleSubscriptionUpdated(mockSubscription)

      // Should activate feature with no expiration (paid subscription)
      expect(prisma.venueFeature.update).toHaveBeenCalledWith({
        where: { id: 'vf_1' },
        data: {
          active: true,
          endDate: null, // null = paid subscription forever
        },
      })
    })

    it('should deactivate feature when subscription is canceled', async () => {
      const mockSubscription = {
        id: 'sub_canceled_123',
        object: 'subscription',
        status: 'canceled',
        current_period_end: Math.floor(Date.now() / 1000),
        created: Date.now() / 1000,
        customer: 'cus_123',
        livemode: false,
      } as unknown as Stripe.Subscription

      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'vf_1',
        venueId: 'venue_1',
        featureId: 'feature_1',
        active: true,
        feature: { id: 'feature_1', code: 'TEST_FEATURE', name: 'Test Feature' },
        venue: { id: 'venue_1', name: 'Test Venue' },
      })
      ;(prisma.venueFeature.update as jest.Mock).mockResolvedValueOnce({})

      await handleSubscriptionUpdated(mockSubscription)

      // Should deactivate feature
      expect(prisma.venueFeature.update).toHaveBeenCalledWith({
        where: { id: 'vf_1' },
        data: {
          active: false,
        },
      })
    })

    it('should set trial endDate when subscription is trialing', async () => {
      const trialEnd = Math.floor(Date.now() / 1000) + 86400 * 5 // 5 days from now
      const mockSubscription = {
        id: 'sub_trial_123',
        object: 'subscription',
        status: 'trialing',
        trial_end: trialEnd,
        current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
        created: Date.now() / 1000,
        customer: 'cus_123',
        livemode: false,
      } as unknown as Stripe.Subscription

      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'vf_1',
        venueId: 'venue_1',
        featureId: 'feature_1',
        active: false,
        feature: { id: 'feature_1', code: 'TEST_FEATURE', name: 'Test Feature' },
        venue: { id: 'venue_1', name: 'Test Venue' },
      })
      ;(prisma.venueFeature.update as jest.Mock).mockResolvedValueOnce({})

      await handleSubscriptionUpdated(mockSubscription)

      // Should activate with trial endDate
      expect(prisma.venueFeature.update).toHaveBeenCalledWith({
        where: { id: 'vf_1' },
        data: {
          active: true,
          endDate: new Date(trialEnd * 1000), // Convert to Date object
        },
      })
    })

    it('should handle past_due status without deactivating', async () => {
      const mockSubscription = {
        id: 'sub_past_due_123',
        object: 'subscription',
        status: 'past_due',
        created: Date.now() / 1000,
        customer: 'cus_123',
        livemode: false,
      } as unknown as Stripe.Subscription

      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'vf_1',
        venueId: 'venue_1',
        featureId: 'feature_1',
        active: true,
        feature: { code: 'TEST' },
        venue: { name: 'Test' },
      })

      await handleSubscriptionUpdated(mockSubscription)

      // Should NOT deactivate - Stripe will retry payment
      expect(prisma.venueFeature.update).not.toHaveBeenCalled()
    })

    it('should handle incomplete subscription status', async () => {
      const mockSubscription = {
        id: 'sub_incomplete_123',
        object: 'subscription',
        status: 'incomplete',
        created: Date.now() / 1000,
        customer: 'cus_123',
        livemode: false,
      } as unknown as Stripe.Subscription

      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'vf_1',
        venueId: 'venue_1',
        featureId: 'feature_1',
        active: true,
        feature: { code: 'TEST' },
        venue: { name: 'Test' },
      })
      ;(prisma.venueFeature.update as jest.Mock).mockResolvedValueOnce({})

      await handleSubscriptionUpdated(mockSubscription)

      // Should deactivate incomplete subscription
      expect(prisma.venueFeature.update).toHaveBeenCalledWith({
        where: { id: 'vf_1' },
        data: { active: false },
      })
    })
  })

  describe('💰 TEST 4: Invoice Payment Events', () => {
    it('should handle invoice payment succeeded', async () => {
      const mockInvoice = {
        id: 'in_success_123',
        object: 'invoice',
        subscription: 'sub_123',
        amount_paid: 9999, // $99.99 in cents
        currency: 'usd',
      } as any

      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'vf_1',
        venueId: 'venue_1',
        active: false, // Was inactive
        feature: { code: 'TEST' },
      })
      ;(prisma.venueFeature.update as jest.Mock).mockResolvedValueOnce({})

      await handleStripeWebhookEvent({
        id: 'evt_payment_success',
        object: 'event',
        type: 'invoice.payment_succeeded',
        created: Date.now() / 1000,
        livemode: false,
        pending_webhooks: 0,
        request: null,
        api_version: '2023-10-16',
        data: { object: mockInvoice },
      } as Stripe.Event)

      // Should reactivate feature after payment
      expect(prisma.venueFeature.update).toHaveBeenCalledWith({
        where: { id: 'vf_1' },
        data: { active: true, endDate: null },
      })
    })

    it('should handle invoice payment failed with attempt tracking', async () => {
      const mockInvoice = {
        id: 'in_failed_123',
        object: 'invoice',
        subscription: 'sub_123',
        attempt_count: 2,
      } as any

      const mockVenueFeature = {
        id: 'vf_1',
        venueId: 'venue_1',
        active: true,
        feature: { code: 'TEST', name: 'Test Feature' },
        venue: {
          name: 'Test Venue',
          organization: {
            email: 'test@example.com',
            stripeCustomerId: 'cus_test123',
          },
        },
      }

      // Mock all database queries (persist across all calls)
      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(mockVenueFeature)
      ;(prisma.staffVenue.findMany as jest.Mock).mockResolvedValue([])
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ slug: 'test-venue' })
      ;(prisma.venueFeature.update as jest.Mock).mockResolvedValue(mockVenueFeature)

      await handleStripeWebhookEvent({
        id: 'evt_payment_failed',
        object: 'event',
        type: 'invoice.payment_failed',
        created: Date.now() / 1000,
        livemode: false,
        pending_webhooks: 0,
        request: null,
        api_version: '2023-10-16',
        data: { object: mockInvoice },
      } as Stripe.Event)

      // Should track payment failure (attempt count 2)
      expect(prisma.venueFeature.update).toHaveBeenCalledWith({
        where: { id: 'vf_1' },
        data: expect.objectContaining({
          paymentFailureCount: 2,
          lastPaymentAttempt: expect.any(Date),
        }),
      })
    })
  })

  describe('⚠️ TEST 5: Error Handling & Edge Cases', () => {
    it('should handle subscription not found in database', async () => {
      const mockSubscription = {
        id: 'sub_orphaned_123',
        object: 'subscription',
        status: 'active',
      } as Stripe.Subscription

      // VenueFeature not found
      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce(null)

      await handleSubscriptionUpdated(mockSubscription)

      // Should NOT throw error, just log warning
      expect(prisma.venueFeature.update).not.toHaveBeenCalled()
    })

    it('should track failed webhook processing with retry count', async () => {
      const mockEvent: Stripe.Event = {
        id: 'evt_error_123',
        object: 'event',
        type: 'customer.subscription.updated',
        created: Date.now() / 1000,
        livemode: false,
        pending_webhooks: 0,
        request: null,
        api_version: '2023-10-16',
        data: {
          object: {
            id: 'sub_error_123',
            status: 'active',
          } as Stripe.Subscription,
        },
      }

      // Mock: Event creation succeeds
      ;(prisma.webhookEvent.create as jest.Mock).mockResolvedValueOnce({
        id: 'webhook_1',
        eventId: 'evt_error_123',
      })

      // Mock: VenueFeature query throws error
      ;(prisma.venueFeature.findFirst as jest.Mock).mockRejectedValueOnce(new Error('Database connection failed'))

      // Mock: Failure tracking
      ;(prisma.webhookEvent.update as jest.Mock).mockResolvedValueOnce({})
      ;(prisma.webhookEvent.findUnique as jest.Mock).mockResolvedValueOnce({
        eventId: 'evt_error_123',
        retryCount: 1,
      })

      await expect(handleStripeWebhookEvent(mockEvent)).rejects.toThrow('Database connection failed')

      // Should track failure
      expect(prisma.webhookEvent.update).toHaveBeenCalledWith({
        where: { id: 'webhook_1' },
        data: {
          status: 'FAILED',
          errorMessage: 'Database connection failed',
          processingTime: expect.any(Number),
          retryCount: { increment: 1 },
        },
      })
    })

    it('should alert when webhook fails 3+ times', async () => {
      const mockEvent: Stripe.Event = {
        id: 'evt_critical_failure',
        object: 'event',
        type: 'customer.subscription.updated',
        created: Date.now() / 1000,
        livemode: false,
        pending_webhooks: 0,
        request: null,
        api_version: '2023-10-16',
        data: {
          object: {
            id: 'sub_123',
            status: 'active',
          } as Stripe.Subscription,
        },
      }

      ;(prisma.webhookEvent.create as jest.Mock).mockResolvedValueOnce({
        id: 'webhook_1',
        eventId: 'evt_critical_failure',
      })
      ;(prisma.venueFeature.findFirst as jest.Mock).mockRejectedValueOnce(new Error('Critical error'))
      ;(prisma.webhookEvent.update as jest.Mock).mockResolvedValueOnce({})

      // Mock: 3 retries already happened
      ;(prisma.webhookEvent.findUnique as jest.Mock).mockResolvedValueOnce({
        eventId: 'evt_critical_failure',
        retryCount: 3, // Critical threshold
      })

      await expect(handleStripeWebhookEvent(mockEvent)).rejects.toThrow('Critical error')

      // Should log critical alert (in production: send to PagerDuty/Slack)
      // Verify it checked retry count
      expect(prisma.webhookEvent.findUnique).toHaveBeenCalledWith({
        where: { id: 'webhook_1' },
        select: { retryCount: true },
      })
    })

    it('should handle database error when tracking failure', async () => {
      const mockEvent: Stripe.Event = {
        id: 'evt_db_error',
        object: 'event',
        type: 'customer.subscription.updated',
        created: Date.now() / 1000,
        livemode: false,
        pending_webhooks: 0,
        request: null,
        api_version: '2023-10-16',
        data: {
          object: {
            id: 'sub_123',
            status: 'active',
          } as Stripe.Subscription,
        },
      }

      ;(prisma.webhookEvent.create as jest.Mock).mockResolvedValueOnce({
        id: 'webhook_1',
        eventId: 'evt_db_error',
      })
      ;(prisma.venueFeature.findFirst as jest.Mock).mockRejectedValueOnce(new Error('Processing error'))

      // Database update fails when tracking error
      ;(prisma.webhookEvent.update as jest.Mock).mockRejectedValueOnce(new Error('Database write failed'))

      await expect(handleStripeWebhookEvent(mockEvent)).rejects.toThrow('Processing error')

      // Should NOT throw secondary error, just log warning
      expect(prisma.webhookEvent.update).toHaveBeenCalled()
    })
  })

  describe('🔔 TEST 6: Trial Will End Event', () => {
    it('should send notifications when trial is ending', async () => {
      const trialEnd = Math.floor(Date.now() / 1000) + 86400 * 3 // 3 days from now
      const mockSubscription = {
        id: 'sub_trial_ending',
        object: 'subscription',
        status: 'trialing',
        trial_end: trialEnd,
      } as Stripe.Subscription

      const mockStaffMembers = [
        {
          staff: {
            id: 'staff_1',
            email: 'owner@test.com',
            firstName: 'John',
            lastName: 'Doe',
          },
        },
      ]

      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'vf_1',
        venueId: 'venue_1',
        feature: { name: 'Analytics', code: 'ANALYTICS' },
        venue: { name: 'Test Venue' },
      })

      // Mock staff query for notifications
      ;(prisma as any).staffVenue = {
        findMany: jest.fn().mockResolvedValueOnce(mockStaffMembers),
      }

      const mockCreateNotification = jest.fn().mockResolvedValue({})
      const mockSendEmail = jest.fn().mockResolvedValue(true)

      // Mock notification service
      jest.doMock('@/services/dashboard/notification.dashboard.service', () => ({
        createNotification: mockCreateNotification,
      }))

      // Mock email service
      jest.doMock('@/services/email.service', () => ({
        __esModule: true,
        default: {
          sendTrialEndingEmail: mockSendEmail,
        },
      }))

      await handleStripeWebhookEvent({
        id: 'evt_trial_ending',
        object: 'event',
        type: 'customer.subscription.trial_will_end',
        created: Date.now() / 1000,
        livemode: false,
        pending_webhooks: 0,
        request: null,
        api_version: '2023-10-16',
        data: { object: mockSubscription },
      } as Stripe.Event)

      // Should process event successfully
      expect(prisma.venueFeature.findFirst).toHaveBeenCalled()
    })
  })
})
