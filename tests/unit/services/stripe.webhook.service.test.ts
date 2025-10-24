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
    stripeWebhookEvent: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    venueFeature: {
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    organization: {
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
      ;(prisma.stripeWebhookEvent.create as jest.Mock).mockResolvedValueOnce({
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
      ;(prisma.stripeWebhookEvent.update as jest.Mock).mockResolvedValueOnce({})

      await handleStripeWebhookEvent(mockEvent)

      expect(prisma.stripeWebhookEvent.create).toHaveBeenCalledTimes(1)
      expect(prisma.venueFeature.update).toHaveBeenCalledTimes(1)

      // Second call - should skip (idempotency)
      const P2002Error = new Error('Unique constraint violation')
      ;(P2002Error as any).code = 'P2002'
      ;(prisma.stripeWebhookEvent.create as jest.Mock).mockRejectedValueOnce(P2002Error)

      await handleStripeWebhookEvent(mockEvent)

      // Should NOT process again
      expect(prisma.stripeWebhookEvent.create).toHaveBeenCalledTimes(2)
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
      ;(prisma.stripeWebhookEvent.create as jest.Mock).mockResolvedValueOnce({
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
      ;(prisma.stripeWebhookEvent.update as jest.Mock).mockResolvedValue({})

      // Other 9 calls get P2002 (already processing)
      const P2002Error = new Error('Unique constraint violation')
      ;(P2002Error as any).code = 'P2002'
      for (let i = 0; i < 9; i++) {
        ;(prisma.stripeWebhookEvent.create as jest.Mock).mockRejectedValueOnce(P2002Error)
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
    it('should deactivate all venue features when customer is deleted', async () => {
      const mockCustomer: Stripe.Customer = {
        id: 'cus_test_123',
        object: 'customer',
        email: 'test@example.com',
        name: 'Test Customer',
        created: Date.now() / 1000,
        livemode: false,
      } as Stripe.Customer

      // Mock organization with customer
      ;(prisma.organization.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'org_1',
        name: 'Test Org',
        stripeCustomerId: 'cus_test_123',
        venues: [
          { id: 'venue_1', name: 'Venue 1' },
          { id: 'venue_2', name: 'Venue 2' },
        ],
      })
      ;(prisma.organization.update as jest.Mock).mockResolvedValueOnce({})
      ;(prisma.venueFeature.updateMany as jest.Mock).mockResolvedValueOnce({ count: 5 })

      await handleCustomerDeleted(mockCustomer)

      // Should clear customer ID
      expect(prisma.organization.update).toHaveBeenCalledWith({
        where: { id: 'org_1' },
        data: { stripeCustomerId: null },
      })

      // Should deactivate all features
      expect(prisma.venueFeature.updateMany).toHaveBeenCalledWith({
        where: {
          venue: { organizationId: 'org_1' },
          active: true,
        },
        data: { active: false },
      })
    })

    it('should handle missing organization gracefully', async () => {
      const mockCustomer: Stripe.Customer = {
        id: 'cus_orphaned_123',
        object: 'customer',
        email: 'orphaned@example.com',
        created: Date.now() / 1000,
        livemode: false,
      } as Stripe.Customer

      // No organization found
      ;(prisma.organization.findFirst as jest.Mock).mockResolvedValueOnce(null)

      await handleCustomerDeleted(mockCustomer)

      // Should NOT throw error, just log warning
      expect(prisma.organization.update).not.toHaveBeenCalled()
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
  })
})
