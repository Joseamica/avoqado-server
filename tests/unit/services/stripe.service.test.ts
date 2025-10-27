/**
 * Comprehensive Stripe Service Tests
 *
 * Tests ALL Stripe service functions with error scenarios:
 * 1. Customer creation (getOrCreateStripeCustomer)
 * 2. Subscription management (create, cancel, convert)
 * 3. Payment methods (update, attach)
 * 4. Invoices (list, PDF download)
 * 5. Feature syncing to Stripe
 * 6. Error handling & retries
 */

import prisma from '@/utils/prismaClient'
import * as stripeService from '@/services/stripe.service'
import { Feature } from '@prisma/client'
import * as retryUtils from '@/utils/retry'

// Mock dependencies
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    organization: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    venue: {
      findUnique: jest.fn(),
    },
    feature: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
    venueFeature: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
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

// Mock Stripe SDK - define everything inline in factory to avoid hoisting issues
jest.mock('stripe', () => {
  const mockInstance = {
    customers: {
      create: jest.fn(),
      update: jest.fn(),
    },
    products: {
      create: jest.fn(),
      update: jest.fn(),
    },
    prices: {
      create: jest.fn(),
    },
    subscriptions: {
      create: jest.fn(),
      cancel: jest.fn(),
      update: jest.fn(),
      retrieve: jest.fn(),
    },
    paymentMethods: {
      attach: jest.fn(),
    },
    invoices: {
      list: jest.fn(),
      retrieve: jest.fn(),
    },
    setupIntents: {
      create: jest.fn(),
    },
    billingPortal: {
      sessions: {
        create: jest.fn(),
      },
    },
  }

  return jest.fn().mockImplementation(() => mockInstance)
})

// Get the mock instance from the mocked Stripe constructor
const Stripe = require('stripe')
const mockStripeInstance = new Stripe()

// Mock retry utility
jest.mock('@/utils/retry', () => ({
  retry: jest.fn(async fn => await fn()),
  shouldRetryStripeError: jest.fn(),
}))

describe('Stripe Service - Comprehensive Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Mock retry to just execute the function (no delays in tests)
    ;(retryUtils.retry as jest.Mock).mockImplementation(async fn => await fn())
  })

  describe('🔑 TEST 1: Customer Creation & Management', () => {
    describe('getOrCreateStripeCustomer()', () => {
      it('should create new Stripe customer when organization has none', async () => {
        const mockOrgId = 'org_123'
        const mockEmail = 'test@example.com'
        const mockName = 'Test User'

        // Mock: Organization without Stripe customer
        ;(prisma.organization.findUnique as jest.Mock).mockResolvedValueOnce({
          id: mockOrgId,
          stripeCustomerId: null,
        })

        // Mock: Stripe customer creation
        mockStripeInstance.customers.create.mockResolvedValueOnce({
          id: 'cus_new_123',
          email: mockEmail,
          name: mockName,
        })

        // Mock: Update organization with new customer ID
        ;(prisma.organization.update as jest.Mock).mockResolvedValueOnce({
          id: mockOrgId,
          stripeCustomerId: 'cus_new_123',
        })

        const result = await stripeService.getOrCreateStripeCustomer(mockOrgId, mockEmail, mockName)

        expect(result).toBe('cus_new_123')
        expect(mockStripeInstance.customers.create).toHaveBeenCalledWith({
          email: mockEmail,
          name: mockName,
          description: undefined,
          metadata: {
            organizationId: mockOrgId,
          },
        })
        expect(prisma.organization.update).toHaveBeenCalledWith({
          where: { id: mockOrgId },
          data: { stripeCustomerId: 'cus_new_123' },
        })
      })

      it('should return existing customer ID without creating new one', async () => {
        const mockOrgId = 'org_existing'
        const existingCustomerId = 'cus_existing_123'

        // Mock: Organization with existing Stripe customer
        ;(prisma.organization.findUnique as jest.Mock).mockResolvedValueOnce({
          id: mockOrgId,
          stripeCustomerId: existingCustomerId,
        })

        const result = await stripeService.getOrCreateStripeCustomer(mockOrgId, 'test@example.com', 'Test User')

        expect(result).toBe(existingCustomerId)
        expect(mockStripeInstance.customers.create).not.toHaveBeenCalled()
        expect(prisma.organization.update).not.toHaveBeenCalled()
      })

      it('should update customer description when venue info provided', async () => {
        const mockOrgId = 'org_with_customer'
        const existingCustomerId = 'cus_update_123'
        const venueName = 'Test Venue'
        const venueSlug = 'test-venue'

        // Mock: Organization with existing customer
        ;(prisma.organization.findUnique as jest.Mock).mockResolvedValueOnce({
          id: mockOrgId,
          stripeCustomerId: existingCustomerId,
        })

        mockStripeInstance.customers.update.mockResolvedValueOnce({
          id: existingCustomerId,
          description: `Venue: ${venueName} (${venueSlug})`,
        })

        const result = await stripeService.getOrCreateStripeCustomer(mockOrgId, 'test@example.com', 'Test User', venueName, venueSlug)

        expect(result).toBe(existingCustomerId)
        expect(mockStripeInstance.customers.update).toHaveBeenCalledWith(existingCustomerId, {
          description: `Venue: ${venueName} (${venueSlug})`,
          metadata: {
            organizationId: mockOrgId,
            venueSlug,
          },
        })
      })

      it('should handle Stripe API errors gracefully', async () => {
        const mockOrgId = 'org_error'

        ;(prisma.organization.findUnique as jest.Mock).mockResolvedValueOnce({
          id: mockOrgId,
          stripeCustomerId: null,
        })

        // Mock: Stripe API error
        mockStripeInstance.customers.create.mockRejectedValueOnce(new Error('Stripe API unavailable'))

        await expect(stripeService.getOrCreateStripeCustomer(mockOrgId, 'test@example.com', 'Test User')).rejects.toThrow(
          'Stripe API unavailable',
        )

        // Should NOT save incomplete customer
        expect(prisma.organization.update).not.toHaveBeenCalled()
      })
    })
  })

  describe('💳 TEST 2: Subscription Management', () => {
    describe('createTrialSubscriptions()', () => {
      it('should create trial subscriptions for valid features', async () => {
        const mockCustomerId = 'cus_123'
        const mockVenueId = 'venue_123'
        const mockFeatureCodes = ['ANALYTICS', 'POS_INTEGRATION']
        const trialDays = 5

        // Mock: Venue lookup (for metadata)
        ;(prisma.venue.findUnique as jest.Mock).mockResolvedValueOnce({
          id: mockVenueId,
          name: 'Test Venue',
          slug: 'test-venue',
        })

        // Mock: VenueFeature lookup
        ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValue(null)

        // Mock: Features with Stripe prices
        ;(prisma.feature.findMany as jest.Mock).mockResolvedValueOnce([
          {
            id: 'feature_analytics',
            code: 'ANALYTICS',
            name: 'Analytics Dashboard',
            stripePriceId: 'price_analytics_123',
            stripeProductId: 'prod_analytics',
            monthlyPrice: 99.99,
          },
          {
            id: 'feature_pos',
            code: 'POS_INTEGRATION',
            name: 'POS Integration',
            stripePriceId: 'price_pos_123',
            stripeProductId: 'prod_pos',
            monthlyPrice: 199.99,
          },
        ])

        // Mock: Stripe subscription creation
        mockStripeInstance.subscriptions.create.mockResolvedValueOnce({
          id: 'sub_analytics_123',
          status: 'trialing',
          trial_end: Math.floor(Date.now() / 1000) + 86400 * trialDays,
        })
        mockStripeInstance.subscriptions.create.mockResolvedValueOnce({
          id: 'sub_pos_123',
          status: 'trialing',
          trial_end: Math.floor(Date.now() / 1000) + 86400 * trialDays,
        })

        // Mock: VenueFeature upsert
        ;(prisma.venueFeature.upsert as jest.Mock).mockResolvedValue({})

        const result = await stripeService.createTrialSubscriptions(mockCustomerId, mockVenueId, mockFeatureCodes, trialDays)

        expect(result).toEqual(['sub_analytics_123', 'sub_pos_123'])
        expect(mockStripeInstance.subscriptions.create).toHaveBeenCalledTimes(2)
        expect(prisma.venueFeature.upsert).toHaveBeenCalledTimes(2)

        // Verify trial subscription parameters
        expect(mockStripeInstance.subscriptions.create).toHaveBeenCalledWith(
          expect.objectContaining({
            customer: mockCustomerId,
            trial_period_days: trialDays,
            items: [{ price: 'price_analytics_123' }],
            metadata: expect.objectContaining({
              venueId: mockVenueId,
              featureCode: 'ANALYTICS',
            }),
          }),
        )
      })

      it('should throw error when no valid features found', async () => {
        ;(prisma.venue.findUnique as jest.Mock).mockResolvedValueOnce({
          id: 'venue_123',
          name: 'Test Venue',
          slug: 'test-venue',
        })
        ;(prisma.feature.findMany as jest.Mock).mockResolvedValueOnce([])

        await expect(stripeService.createTrialSubscriptions('cus_123', 'venue_123', ['INVALID_FEATURE'])).rejects.toThrow(
          'No valid features found to subscribe',
        )
      })

      it('should continue creating subscriptions even if one fails', async () => {
        const mockCustomerId = 'cus_123'
        const mockVenueId = 'venue_123'

        ;(prisma.venue.findUnique as jest.Mock).mockResolvedValueOnce({
          id: mockVenueId,
          name: 'Test Venue',
          slug: 'test-venue',
        })
        ;(prisma.feature.findMany as jest.Mock).mockResolvedValueOnce([
          {
            id: 'feature_1',
            code: 'FEATURE_1',
            name: 'Feature 1',
            stripePriceId: 'price_1',
            monthlyPrice: 50,
          },
          {
            id: 'feature_2',
            code: 'FEATURE_2',
            name: 'Feature 2',
            stripePriceId: 'price_2',
            monthlyPrice: 100,
          },
        ])

        // First subscription fails, second succeeds
        mockStripeInstance.subscriptions.create.mockRejectedValueOnce(new Error('Payment method required'))
        mockStripeInstance.subscriptions.create.mockResolvedValueOnce({ id: 'sub_2' })
        ;(prisma.venueFeature.upsert as jest.Mock).mockResolvedValue({})

        const result = await stripeService.createTrialSubscriptions(mockCustomerId, mockVenueId, ['FEATURE_1', 'FEATURE_2'])

        // Should only return successful subscription
        expect(result).toEqual(['sub_2'])
        expect(prisma.venueFeature.upsert).toHaveBeenCalledTimes(1) // Only for successful one
      })

      it('should set endDate to null for paid subscriptions (trialDays = 0)', async () => {
        const mockCustomerId = 'cus_123'
        const mockVenueId = 'venue_123'

        ;(prisma.venue.findUnique as jest.Mock).mockResolvedValueOnce({
          id: mockVenueId,
          name: 'Test Venue',
          slug: 'test-venue',
        })
        ;(prisma.feature.findMany as jest.Mock).mockResolvedValueOnce([
          {
            id: 'feature_paid',
            code: 'PAID_FEATURE',
            name: 'Paid Feature',
            stripePriceId: 'price_paid',
            monthlyPrice: 99.99,
          },
        ])

        mockStripeInstance.subscriptions.create.mockResolvedValueOnce({
          id: 'sub_paid_123',
          status: 'active',
        })
        ;(prisma.venueFeature.upsert as jest.Mock).mockResolvedValue({})

        await stripeService.createTrialSubscriptions(mockCustomerId, mockVenueId, ['PAID_FEATURE'], 0) // No trial

        // Verify endDate is null for paid subscription
        expect(prisma.venueFeature.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            create: expect.objectContaining({
              endDate: null, // Paid subscription forever
            }),
            update: expect.objectContaining({
              endDate: null,
            }),
          }),
        )
      })
    })

    describe('cancelSubscription()', () => {
      it('should cancel Stripe subscription and deactivate VenueFeature', async () => {
        const mockSubId = 'sub_cancel_123'

        mockStripeInstance.subscriptions.cancel.mockResolvedValueOnce({
          id: mockSubId,
          status: 'canceled',
        })
        ;(prisma.venueFeature.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 })

        await stripeService.cancelSubscription(mockSubId)

        expect(mockStripeInstance.subscriptions.cancel).toHaveBeenCalledWith(mockSubId)
        expect(prisma.venueFeature.updateMany).toHaveBeenCalledWith({
          where: { stripeSubscriptionId: mockSubId },
          data: { active: false },
        })
      })

      it('should handle already canceled subscriptions', async () => {
        const mockSubId = 'sub_already_canceled'

        // Stripe returns error for already canceled subscription
        const stripeError = new Error('No such subscription')
        ;(stripeError as any).type = 'invalid_request_error'
        mockStripeInstance.subscriptions.cancel.mockRejectedValueOnce(stripeError)

        await expect(stripeService.cancelSubscription(mockSubId)).rejects.toThrow('No such subscription')

        // Should NOT update database if Stripe call fails
        expect(prisma.venueFeature.updateMany).not.toHaveBeenCalled()
      })
    })

    describe('convertTrialToPaid()', () => {
      it('should convert trial to paid by setting endDate to null', async () => {
        const mockVenueFeatureId = 'vf_trial_123'

        ;(prisma.venueFeature.findUnique as jest.Mock).mockResolvedValueOnce({
          id: mockVenueFeatureId,
          venueId: 'venue_123',
          featureId: 'feature_123',
          active: true,
          endDate: new Date(Date.now() + 86400000), // Trial ending tomorrow
          feature: { id: 'feature_123', code: 'TEST_FEATURE' },
        })
        ;(prisma.venueFeature.update as jest.Mock).mockResolvedValueOnce({
          id: mockVenueFeatureId,
          endDate: null,
          active: true,
        })

        await stripeService.convertTrialToPaid(mockVenueFeatureId)

        expect(prisma.venueFeature.update).toHaveBeenCalledWith({
          where: { id: mockVenueFeatureId },
          data: {
            endDate: null, // Paid subscription
            active: true,
          },
        })
      })

      it('should throw error if VenueFeature not found', async () => {
        ;(prisma.venueFeature.findUnique as jest.Mock).mockResolvedValueOnce(null)

        await expect(stripeService.convertTrialToPaid('vf_nonexistent')).rejects.toThrow('VenueFeature vf_nonexistent not found')
      })
    })
  })

  describe('💰 TEST 3: Payment Methods', () => {
    describe('updatePaymentMethod()', () => {
      it('should attach payment method and set as default', async () => {
        const mockCustomerId = 'cus_123'
        const mockPaymentMethodId = 'pm_card_visa'

        mockStripeInstance.paymentMethods.attach.mockResolvedValueOnce({
          id: mockPaymentMethodId,
          customer: mockCustomerId,
        })

        mockStripeInstance.customers.update.mockResolvedValueOnce({
          id: mockCustomerId,
          invoice_settings: {
            default_payment_method: mockPaymentMethodId,
          },
        })

        await stripeService.updatePaymentMethod(mockCustomerId, mockPaymentMethodId)

        expect(mockStripeInstance.paymentMethods.attach).toHaveBeenCalledWith(mockPaymentMethodId, { customer: mockCustomerId })
        expect(mockStripeInstance.customers.update).toHaveBeenCalledWith(mockCustomerId, {
          invoice_settings: {
            default_payment_method: mockPaymentMethodId,
          },
        })
      })

      it('should handle already attached payment methods', async () => {
        const mockCustomerId = 'cus_123'
        const mockPaymentMethodId = 'pm_already_attached'

        // Stripe error: payment method already attached
        const stripeError = new Error('The payment method has already been attached to a customer')
        ;(stripeError as any).type = 'invalid_request_error'
        mockStripeInstance.paymentMethods.attach.mockRejectedValueOnce(stripeError)

        await expect(stripeService.updatePaymentMethod(mockCustomerId, mockPaymentMethodId)).rejects.toThrow(
          'The payment method has already been attached to a customer',
        )

        // Should NOT update default if attach fails
        expect(mockStripeInstance.customers.update).not.toHaveBeenCalled()
      })
    })

    describe('createTrialSetupIntent()', () => {
      it('should create setup intent for collecting payment method', async () => {
        const mockCustomerId = 'cus_123'
        const mockClientSecret = 'seti_secret_123'

        mockStripeInstance.setupIntents.create.mockResolvedValueOnce({
          id: 'seti_123',
          client_secret: mockClientSecret,
          customer: mockCustomerId,
        })

        const result = await stripeService.createTrialSetupIntent(mockCustomerId)

        expect(result).toBe(mockClientSecret)
        expect(mockStripeInstance.setupIntents.create).toHaveBeenCalledWith({
          customer: mockCustomerId,
          payment_method_types: ['card'],
        })
      })
    })
  })

  describe('📄 TEST 4: Invoices', () => {
    describe('getCustomerInvoices()', () => {
      it('should retrieve invoice list for customer', async () => {
        const mockCustomerId = 'cus_123'
        const mockInvoices = [
          { id: 'in_1', amount_due: 9999, status: 'paid' },
          { id: 'in_2', amount_due: 19999, status: 'open' },
        ]

        mockStripeInstance.invoices.list.mockResolvedValueOnce({
          data: mockInvoices,
          has_more: false,
        })

        const result = await stripeService.getCustomerInvoices(mockCustomerId, 10)

        expect(result).toEqual(mockInvoices)
        expect(mockStripeInstance.invoices.list).toHaveBeenCalledWith({
          customer: mockCustomerId,
          limit: 10,
        })
      })

      it('should default to 100 invoices if limit not specified', async () => {
        mockStripeInstance.invoices.list.mockResolvedValueOnce({ data: [] })

        await stripeService.getCustomerInvoices('cus_123')

        expect(mockStripeInstance.invoices.list).toHaveBeenCalledWith({
          customer: 'cus_123',
          limit: 100, // Default
        })
      })
    })

    describe('getInvoicePdfUrl()', () => {
      it('should return PDF URL for invoice', async () => {
        const mockInvoiceId = 'in_pdf_123'
        const mockPdfUrl = 'https://stripe.com/invoices/in_pdf_123.pdf'

        mockStripeInstance.invoices.retrieve.mockResolvedValueOnce({
          id: mockInvoiceId,
          invoice_pdf: mockPdfUrl,
        })

        const result = await stripeService.getInvoicePdfUrl(mockInvoiceId)

        expect(result).toBe(mockPdfUrl)
        expect(mockStripeInstance.invoices.retrieve).toHaveBeenCalledWith(mockInvoiceId)
      })

      it('should throw error if invoice has no PDF', async () => {
        const mockInvoiceId = 'in_no_pdf_123'

        mockStripeInstance.invoices.retrieve.mockResolvedValueOnce({
          id: mockInvoiceId,
          invoice_pdf: null, // No PDF available
        })

        await expect(stripeService.getInvoicePdfUrl(mockInvoiceId)).rejects.toThrow('Invoice in_no_pdf_123 does not have a PDF available')
      })
    })
  })

  describe('🔄 TEST 5: Feature Syncing to Stripe', () => {
    describe('syncFeaturesToStripe()', () => {
      it('should create Stripe products and prices for features without them', async () => {
        const mockFeatures: Partial<Feature>[] = [
          {
            id: 'feature_new',
            code: 'NEW_FEATURE',
            name: 'New Feature',
            description: 'A new premium feature',
            monthlyPrice: { toNumber: () => 99.99 } as any, // Decimal type with toNumber() method
            active: true,
            stripeProductId: null,
            stripePriceId: null,
          },
        ]

        ;(prisma.feature.findMany as jest.Mock).mockResolvedValueOnce(mockFeatures)

        // Mock: Create product
        mockStripeInstance.products.create.mockResolvedValueOnce({
          id: 'prod_new_123',
          name: 'New Feature',
        })

        // Mock: Create price
        mockStripeInstance.prices.create.mockResolvedValueOnce({
          id: 'price_new_123',
          product: 'prod_new_123',
          unit_amount: 9999, // $99.99 in cents
        })

        // Mock: Update feature with Stripe IDs
        ;(prisma.feature.update as jest.Mock).mockResolvedValueOnce({
          ...mockFeatures[0],
          stripeProductId: 'prod_new_123',
          stripePriceId: 'price_new_123',
        })

        // Mock: Final query
        ;(prisma.feature.findMany as jest.Mock).mockResolvedValueOnce([
          {
            ...mockFeatures[0],
            stripeProductId: 'prod_new_123',
            stripePriceId: 'price_new_123',
          },
        ])

        const result = await stripeService.syncFeaturesToStripe()

        expect(mockStripeInstance.products.create).toHaveBeenCalledWith({
          name: 'New Feature',
          description: 'A new premium feature',
          metadata: {
            featureId: 'feature_new',
            featureCode: 'NEW_FEATURE',
          },
        })

        expect(mockStripeInstance.prices.create).toHaveBeenCalledWith({
          product: 'prod_new_123',
          unit_amount: 9999, // $99.99 → 9999 cents
          currency: 'mxn',
          recurring: { interval: 'month' },
          metadata: {
            featureId: 'feature_new',
            featureCode: 'NEW_FEATURE',
          },
        })

        expect(result).toHaveLength(1)
        expect(result[0].stripePriceId).toBe('price_new_123')
      })

      it('should update existing Stripe products', async () => {
        const mockFeatures: Partial<Feature>[] = [
          {
            id: 'feature_existing',
            code: 'EXISTING_FEATURE',
            name: 'Updated Feature Name',
            description: 'Updated description',
            monthlyPrice: { toNumber: () => 149.99 } as any, // Decimal type with toNumber() method
            active: true,
            stripeProductId: 'prod_existing_123', // Already has product
            stripePriceId: 'price_existing_123',
          },
        ]

        ;(prisma.feature.findMany as jest.Mock).mockResolvedValueOnce(mockFeatures)

        mockStripeInstance.products.update.mockResolvedValueOnce({
          id: 'prod_existing_123',
          name: 'Updated Feature Name',
        })
        ;(prisma.feature.update as jest.Mock).mockResolvedValueOnce(mockFeatures[0])
        ;(prisma.feature.findMany as jest.Mock).mockResolvedValueOnce(mockFeatures)

        await stripeService.syncFeaturesToStripe()

        // Should update existing product, not create new one
        expect(mockStripeInstance.products.update).toHaveBeenCalledWith('prod_existing_123', {
          name: 'Updated Feature Name',
          description: 'Updated description',
        })
        expect(mockStripeInstance.products.create).not.toHaveBeenCalled()

        // Should NOT create new price (prices are immutable in Stripe)
        expect(mockStripeInstance.prices.create).not.toHaveBeenCalled()
      })

      it('should continue syncing even if one feature fails', async () => {
        const mockFeatures = [
          {
            id: 'f1',
            code: 'F1',
            name: 'Feature 1',
            monthlyPrice: { toNumber: () => 50 } as any,
            active: true,
            stripeProductId: null,
            stripePriceId: null,
          },
          {
            id: 'f2',
            code: 'F2',
            name: 'Feature 2',
            monthlyPrice: { toNumber: () => 100 } as any,
            active: true,
            stripeProductId: null,
            stripePriceId: null,
          },
        ]

        ;(prisma.feature.findMany as jest.Mock).mockResolvedValueOnce(mockFeatures)

        // First feature fails
        mockStripeInstance.products.create.mockRejectedValueOnce(new Error('Stripe API error'))

        // Second feature succeeds
        mockStripeInstance.products.create.mockResolvedValueOnce({ id: 'prod_f2' })
        mockStripeInstance.prices.create.mockResolvedValueOnce({ id: 'price_f2' })
        ;(prisma.feature.update as jest.Mock).mockResolvedValueOnce({})
        ;(prisma.feature.findMany as jest.Mock).mockResolvedValueOnce([])

        await stripeService.syncFeaturesToStripe()

        // Should attempt both
        expect(mockStripeInstance.products.create).toHaveBeenCalledTimes(2)
        // Should only update successful one
        expect(prisma.feature.update).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('🔐 TEST 6: Customer Portal', () => {
    describe('createCustomerPortalSession()', () => {
      it('should create billing portal session with return URL', async () => {
        const mockCustomerId = 'cus_123'
        const mockReturnUrl = 'https://example.com/dashboard/billing'
        const mockPortalUrl = 'https://billing.stripe.com/session/test_123'

        mockStripeInstance.billingPortal.sessions.create.mockResolvedValueOnce({
          id: 'bps_123',
          url: mockPortalUrl,
        })

        const result = await stripeService.createCustomerPortalSession(mockCustomerId, mockReturnUrl)

        expect(result).toBe(mockPortalUrl)
        expect(mockStripeInstance.billingPortal.sessions.create).toHaveBeenCalledWith({
          customer: mockCustomerId,
          return_url: mockReturnUrl,
        })
      })
    })
  })

  describe('🔄 TEST 7: Retry Logic & Error Handling', () => {
    it('should retry on transient Stripe errors', async () => {
      // Restore retry mock to test actual retry logic
      ;(retryUtils.retry as jest.Mock).mockRestore()
      ;(retryUtils.retry as jest.Mock).mockImplementation(async (fn, _options) => {
        // Simulate 2 retries, then success
        let attempts = 0
        while (attempts < 3) {
          try {
            return await fn()
          } catch (error) {
            attempts++
            if (attempts >= 3) throw error
          }
        }
      })
      ;(prisma.organization.findUnique as jest.Mock).mockResolvedValue({
        id: 'org_retry',
        stripeCustomerId: null,
      })

      // First 2 calls fail, 3rd succeeds
      mockStripeInstance.customers.create
        .mockRejectedValueOnce({ type: 'api_error', message: 'Transient error' })
        .mockRejectedValueOnce({ type: 'api_error', message: 'Transient error' })
        .mockResolvedValueOnce({ id: 'cus_success_after_retry' })
      ;(prisma.organization.update as jest.Mock).mockResolvedValue({})

      const result = await stripeService.getOrCreateStripeCustomer('org_retry', 'test@example.com', 'Test User')

      expect(result).toBe('cus_success_after_retry')
    })

    it('should not retry on permanent Stripe errors (invalid_request_error)', async () => {
      ;(retryUtils.shouldRetryStripeError as jest.Mock).mockReturnValue(false)
      ;(prisma.organization.findUnique as jest.Mock).mockResolvedValue({
        id: 'org_permanent_error',
        stripeCustomerId: null,
      })

      // Permanent error (e.g., invalid API key)
      const stripeError = new Error('Invalid API key')
      ;(stripeError as any).type = 'invalid_request_error'
      mockStripeInstance.customers.create.mockRejectedValueOnce(stripeError)

      await expect(stripeService.getOrCreateStripeCustomer('org_permanent_error', 'test@example.com', 'Test User')).rejects.toThrow(
        'Invalid API key',
      )
    })
  })
})
