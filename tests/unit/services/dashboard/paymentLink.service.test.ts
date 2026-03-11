// Mock nanoid before imports
jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'abc12345'),
}))

// Mock Blumon E-commerce service
const mockBlumonService = {
  tokenizeCard: jest.fn().mockResolvedValue({
    token: 'tok_test_123',
    maskedPan: '424242******4242',
    cardBrand: 'VISA',
  }),
  authorizePayment: jest.fn().mockResolvedValue({
    transactionId: 'txn_test_123',
    authorizationCode: 'AUTH123',
  }),
}

jest.mock('@/services/sdk/blumon-ecommerce.service', () => ({
  getBlumonEcommerceService: jest.fn(() => mockBlumonService),
}))

// Mock inventory deduction
const mockDeductInventory = jest.fn().mockResolvedValue(undefined)
jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  deductInventoryForProduct: mockDeductInventory,
}))

import {
  createPaymentLink,
  getPaymentLinks,
  getPaymentLinkById,
  updatePaymentLink,
  archivePaymentLink,
  getPaymentLinkByShortCode,
  createCheckoutSession,
  completeCharge,
  getSessionStatus,
} from '../../../../src/services/dashboard/paymentLink.service'
import { prismaMock } from '../../../__helpers__/setup'
import { BadRequestError, NotFoundError } from '../../../../src/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'

// ==========================================
// MOCK HELPERS
// ==========================================

const VENUE_ID = 'venue-123'
const STAFF_ID = 'staff-123'
const PRODUCT_ID = 'product-456'

const createMockPaymentLink = (overrides: Record<string, any> = {}) => ({
  id: 'pl-123',
  shortCode: 'abc12345',
  venueId: VENUE_ID,
  ecommerceMerchantId: 'merchant-123',
  createdById: STAFF_ID,
  purpose: 'PAYMENT',
  productId: null,
  title: 'Test Payment',
  description: 'Test description',
  imageUrl: null,
  amountType: 'FIXED',
  amount: new Decimal(100),
  currency: 'MXN',
  isReusable: false,
  expiresAt: null,
  redirectUrl: null,
  status: 'ACTIVE',
  totalCollected: new Decimal(0),
  paymentCount: 0,
  createdAt: new Date('2026-03-01'),
  updatedAt: new Date('2026-03-01'),
  createdBy: { id: STAFF_ID, firstName: 'Test', lastName: 'User' },
  _count: { checkoutSessions: 0 },
  ...overrides,
})

const createMockItemPaymentLink = (overrides: Record<string, any> = {}) =>
  createMockPaymentLink({
    purpose: 'ITEM',
    productId: PRODUCT_ID,
    title: 'Test Product',
    amount: new Decimal(250),
    product: {
      id: PRODUCT_ID,
      name: 'Test Product',
      price: new Decimal(250),
      taxRate: new Decimal(0.16),
    },
    ...overrides,
  })

const createMockCheckoutSession = (overrides: Record<string, any> = {}) => ({
  id: 'session-db-123',
  sessionId: 'cs_pl_test123',
  ecommerceMerchantId: 'merchant-123',
  paymentLinkId: 'pl-123',
  amount: new Decimal(100),
  currency: 'MXN',
  description: 'Test Payment',
  customerEmail: 'john@example.com',
  customerPhone: null,
  customerName: 'John Doe',
  status: 'PROCESSING',
  metadata: {
    cardToken: 'tok_test_123',
    maskedPan: '424242******4242',
    cardBrand: 'VISA',
    cvv: '123',
  },
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  completedAt: null,
  blumonCheckoutId: null,
  errorMessage: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  paymentLink: {
    id: 'pl-123',
    shortCode: 'abc12345',
    venueId: VENUE_ID,
    purpose: 'PAYMENT',
    productId: null,
    createdById: STAFF_ID,
  },
  ecommerceMerchant: {
    id: 'merchant-123',
    sandboxMode: true,
    providerCredentials: { accessToken: 'test-token' },
  },
  ...overrides,
})

// ==========================================
// TESTS: DASHBOARD CRUD
// ==========================================

describe('PaymentLink Service', () => {
  // ─── CREATE ──────────────────────────────────────
  describe('createPaymentLink', () => {
    it('should create a PAYMENT link with FIXED amount', async () => {
      prismaMock.ecommerceMerchant.findFirst.mockResolvedValueOnce({ id: 'merchant-123' })
      prismaMock.paymentLink.create.mockResolvedValueOnce(createMockPaymentLink())

      const result = await createPaymentLink(VENUE_ID, {
        title: 'Test Payment',
        description: 'Test description',
        amountType: 'FIXED',
        amount: 100,
        purpose: 'PAYMENT',
      }, STAFF_ID)

      expect(result).toBeDefined()
      expect(result.shortCode).toBe('abc12345')
      expect(prismaMock.paymentLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            purpose: 'PAYMENT',
            productId: undefined,
            title: 'Test Payment',
            amountType: 'FIXED',
          }),
        }),
      )
    })

    it('should create an ITEM link with productId', async () => {
      prismaMock.ecommerceMerchant.findFirst.mockResolvedValueOnce({ id: 'merchant-123' })
      prismaMock.product.findFirst.mockResolvedValueOnce({ id: PRODUCT_ID })
      prismaMock.paymentLink.create.mockResolvedValueOnce(createMockItemPaymentLink())

      const result = await createPaymentLink(VENUE_ID, {
        title: 'Test Product',
        amountType: 'FIXED',
        amount: 250,
        purpose: 'ITEM',
        productId: PRODUCT_ID,
      }, STAFF_ID)

      expect(result).toBeDefined()
      expect(prismaMock.product.findFirst).toHaveBeenCalledWith({
        where: { id: PRODUCT_ID, venueId: VENUE_ID },
        select: { id: true },
      })
      expect(prismaMock.paymentLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            purpose: 'ITEM',
            productId: PRODUCT_ID,
          }),
        }),
      )
    })

    it('should reject ITEM link without productId', async () => {
      prismaMock.ecommerceMerchant.findFirst.mockResolvedValueOnce({ id: 'merchant-123' })

      await expect(
        createPaymentLink(VENUE_ID, {
          title: 'No Product',
          amountType: 'FIXED',
          amount: 100,
          purpose: 'ITEM',
          // No productId
        }, STAFF_ID),
      ).rejects.toThrow(BadRequestError)
    })

    it('should reject ITEM link with product from another venue', async () => {
      prismaMock.ecommerceMerchant.findFirst.mockResolvedValueOnce({ id: 'merchant-123' })
      prismaMock.product.findFirst.mockResolvedValueOnce(null) // Product not found in venue

      await expect(
        createPaymentLink(VENUE_ID, {
          title: 'Wrong Product',
          amountType: 'FIXED',
          amount: 100,
          purpose: 'ITEM',
          productId: 'product-from-other-venue',
        }, STAFF_ID),
      ).rejects.toThrow(BadRequestError)
    })

    it('should reject if no ecommerce merchant', async () => {
      prismaMock.ecommerceMerchant.findFirst.mockResolvedValue(null)

      await expect(
        createPaymentLink(VENUE_ID, {
          title: 'Test',
          amountType: 'FIXED',
          amount: 100,
        }, STAFF_ID),
      ).rejects.toThrow(BadRequestError)
    })
  })

  // ─── LIST ──────────────────────────────────────
  describe('getPaymentLinks', () => {
    it('should return paginated links', async () => {
      const mockLinks = [createMockPaymentLink()]
      prismaMock.paymentLink.findMany.mockResolvedValueOnce(mockLinks)
      prismaMock.paymentLink.count.mockResolvedValueOnce(1)

      const result = await getPaymentLinks(VENUE_ID)

      expect(result.paymentLinks).toHaveLength(1)
      expect(result.total).toBe(1)
      expect(prismaMock.paymentLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: VENUE_ID },
        }),
      )
    })

    it('should filter by status', async () => {
      prismaMock.paymentLink.findMany.mockResolvedValueOnce([])
      prismaMock.paymentLink.count.mockResolvedValueOnce(0)

      await getPaymentLinks(VENUE_ID, { status: 'PAUSED' })

      expect(prismaMock.paymentLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: VENUE_ID, status: 'PAUSED' },
        }),
      )
    })

    it('should filter by search term', async () => {
      prismaMock.paymentLink.findMany.mockResolvedValueOnce([])
      prismaMock.paymentLink.count.mockResolvedValueOnce(0)

      await getPaymentLinks(VENUE_ID, { search: 'test' })

      expect(prismaMock.paymentLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            venueId: VENUE_ID,
            title: { contains: 'test', mode: 'insensitive' },
          },
        }),
      )
    })
  })

  // ─── GET BY ID ──────────────────────────────────────
  describe('getPaymentLinkById', () => {
    it('should return link with checkout sessions', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(
        createMockPaymentLink({ checkoutSessions: [] }),
      )

      const result = await getPaymentLinkById(VENUE_ID, 'pl-123')
      expect(result).toBeDefined()
      expect(result.id).toBe('pl-123')
    })

    it('should reject if link not found', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(null)

      await expect(getPaymentLinkById(VENUE_ID, 'bad-id')).rejects.toThrow(NotFoundError)
    })

    it('should reject if link belongs to another venue', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(
        createMockPaymentLink({ venueId: 'other-venue' }),
      )

      await expect(getPaymentLinkById(VENUE_ID, 'pl-123')).rejects.toThrow()
    })
  })

  // ─── UPDATE ──────────────────────────────────────
  describe('updatePaymentLink', () => {
    it('should update title and amount', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce({
        id: 'pl-123',
        venueId: VENUE_ID,
        status: 'ACTIVE',
      })
      prismaMock.paymentLink.update.mockResolvedValueOnce(
        createMockPaymentLink({ title: 'Updated', amount: new Decimal(200) }),
      )

      const result = await updatePaymentLink(VENUE_ID, 'pl-123', {
        title: 'Updated',
        amount: 200,
      })

      expect(result.title).toBe('Updated')
    })

    it('should reject update on archived link', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce({
        id: 'pl-123',
        venueId: VENUE_ID,
        status: 'ARCHIVED',
      })

      await expect(
        updatePaymentLink(VENUE_ID, 'pl-123', { title: 'Nope' }),
      ).rejects.toThrow(BadRequestError)
    })
  })

  // ─── ARCHIVE ──────────────────────────────────────
  describe('archivePaymentLink', () => {
    it('should soft-delete by setting status to ARCHIVED', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce({
        id: 'pl-123',
        venueId: VENUE_ID,
      })
      prismaMock.paymentLink.update.mockResolvedValueOnce({})

      const result = await archivePaymentLink(VENUE_ID, 'pl-123')

      expect(result.success).toBe(true)
      expect(prismaMock.paymentLink.update).toHaveBeenCalledWith({
        where: { id: 'pl-123' },
        data: { status: 'ARCHIVED' },
      })
    })
  })

  // ─── PUBLIC: RESOLVE BY SHORT CODE ─────────────────
  describe('getPaymentLinkByShortCode', () => {
    it('should return link with venue branding', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(
        createMockPaymentLink({
          venue: { id: VENUE_ID, name: 'Test Venue', slug: 'test', logo: null, primaryColor: null, secondaryColor: null },
          product: null,
        }),
      )

      const result = await getPaymentLinkByShortCode('abc12345')

      expect(result.shortCode).toBe('abc12345')
      expect(result.venue.name).toBe('Test Venue')
      expect(result.purpose).toBe('PAYMENT')
    })

    it('should return product data for ITEM links', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(
        createMockItemPaymentLink({
          venue: { id: VENUE_ID, name: 'Test Venue', slug: 'test', logo: null, primaryColor: null, secondaryColor: null },
          product: { id: PRODUCT_ID, name: 'Test Product', description: null, price: new Decimal(250), imageUrl: null },
        }),
      )

      const result = await getPaymentLinkByShortCode('abc12345')

      expect(result.purpose).toBe('ITEM')
      expect(result.product).toBeDefined()
      expect(result.product!.name).toBe('Test Product')
    })

    it('should reject expired links', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(
        createMockPaymentLink({
          expiresAt: new Date('2020-01-01'), // In the past
          venue: {},
          product: null,
        }),
      )
      prismaMock.paymentLink.update.mockResolvedValueOnce({})

      await expect(getPaymentLinkByShortCode('abc12345')).rejects.toThrow(BadRequestError)
    })

    it('should reject single-use link already used', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(
        createMockPaymentLink({
          isReusable: false,
          paymentCount: 1,
          venue: {},
          product: null,
        }),
      )

      await expect(getPaymentLinkByShortCode('abc12345')).rejects.toThrow(BadRequestError)
    })

    it('should reject paused/archived links', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(
        createMockPaymentLink({ status: 'PAUSED', venue: {}, product: null }),
      )

      await expect(getPaymentLinkByShortCode('abc12345')).rejects.toThrow(BadRequestError)
    })
  })

  // ─── COMPLETE CHARGE (ITEM LINK) ─────────────────
  describe('completeCharge', () => {
    it('should charge and create Order for ITEM link', async () => {
      const itemSession = createMockCheckoutSession({
        paymentLink: {
          id: 'pl-123',
          shortCode: 'abc12345',
          venueId: VENUE_ID,
          purpose: 'ITEM',
          productId: PRODUCT_ID,
          createdById: STAFF_ID,
        },
        metadata: {
          cardToken: 'tok_test_123',
          maskedPan: '424242******4242',
          cardBrand: 'VISA',
          cvv: '123',
          purpose: 'ITEM',
          productId: PRODUCT_ID,
          productName: 'Test Product',
          productPrice: 250,
          quantity: 2,
        },
        amount: new Decimal(500),
      })

      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(itemSession)

      // $transaction mock calls callback with prismaMock
      // The callback creates checkout update, payment link update, and order create
      prismaMock.checkoutSession.update.mockResolvedValueOnce({})
      prismaMock.paymentLink.update.mockResolvedValueOnce({})
      prismaMock.order.create.mockResolvedValueOnce({ id: 'order-123', orderNumber: 'PL-123' })

      const result = await completeCharge('abc12345', 'cs_pl_test123')

      expect(result.status).toBe('COMPLETED')
      expect(result.transactionId).toBe('txn_test_123')

      // Verify Blumon was called
      expect(mockBlumonService.authorizePayment).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 500,
          cardToken: 'tok_test_123',
        }),
      )

      // Verify order was created inside transaction
      expect(prismaMock.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            venueId: VENUE_ID,
            source: 'PAYMENT_LINK',
            status: 'COMPLETED',
            paymentStatus: 'PAID',
            items: expect.objectContaining({
              create: expect.objectContaining({
                productId: PRODUCT_ID,
                productName: 'Test Product',
                quantity: 2,
              }),
            }),
          }),
        }),
      )

      // Verify inventory was deducted
      expect(mockDeductInventory).toHaveBeenCalledWith(
        VENUE_ID,
        PRODUCT_ID,
        2,
        'cs_pl_test123',
      )
    })

    it('should charge WITHOUT creating Order for PAYMENT link', async () => {
      const paymentSession = createMockCheckoutSession()

      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(paymentSession)
      prismaMock.checkoutSession.update.mockResolvedValueOnce({})
      prismaMock.paymentLink.update.mockResolvedValueOnce({})

      const result = await completeCharge('abc12345', 'cs_pl_test123')

      expect(result.status).toBe('COMPLETED')
      // Should NOT create order for PAYMENT links
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      // Should NOT deduct inventory
      expect(mockDeductInventory).not.toHaveBeenCalled()
    })

    it('should reject already completed session', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(
        createMockCheckoutSession({ status: 'COMPLETED' }),
      )

      await expect(completeCharge('abc12345', 'cs_pl_test123')).rejects.toThrow(BadRequestError)
    })

    it('should reject session from wrong payment link', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(
        createMockCheckoutSession({
          paymentLink: { ...createMockCheckoutSession().paymentLink, shortCode: 'other123' },
        }),
      )

      await expect(completeCharge('abc12345', 'cs_pl_test123')).rejects.toThrow(BadRequestError)
    })

    it('should not fail payment if inventory deduction fails', async () => {
      mockDeductInventory.mockRejectedValueOnce(new Error('Insufficient stock'))

      const itemSession = createMockCheckoutSession({
        paymentLink: {
          id: 'pl-123',
          shortCode: 'abc12345',
          venueId: VENUE_ID,
          purpose: 'ITEM',
          productId: PRODUCT_ID,
          createdById: STAFF_ID,
        },
        metadata: {
          cardToken: 'tok_test_123',
          maskedPan: '424242******4242',
          cardBrand: 'VISA',
          cvv: '123',
          purpose: 'ITEM',
          productId: PRODUCT_ID,
          productName: 'Test Product',
          productPrice: 250,
          quantity: 1,
        },
        amount: new Decimal(250),
      })

      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(itemSession)
      prismaMock.checkoutSession.update.mockResolvedValueOnce({})
      prismaMock.paymentLink.update.mockResolvedValueOnce({})
      prismaMock.order.create.mockResolvedValueOnce({ id: 'order-123' })

      // Should NOT throw — inventory failure is non-blocking
      const result = await completeCharge('abc12345', 'cs_pl_test123')
      expect(result.status).toBe('COMPLETED')
    })
  })

  // ─── SESSION STATUS ─────────────────────────────
  describe('getSessionStatus', () => {
    it('should return session status', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({
        sessionId: 'cs_pl_test123',
        status: 'COMPLETED',
        amount: new Decimal(100),
        currency: 'MXN',
        completedAt: new Date(),
        errorMessage: null,
        paymentLink: { shortCode: 'abc12345', redirectUrl: null },
      })

      const result = await getSessionStatus('abc12345', 'cs_pl_test123')

      expect(result.status).toBe('COMPLETED')
      expect(result.sessionId).toBe('cs_pl_test123')
    })

    it('should reject if session not found', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(null)

      await expect(getSessionStatus('abc12345', 'bad-session')).rejects.toThrow(NotFoundError)
    })
  })

  // ─── REGRESSION: Existing features still work ─────
  describe('Regression tests', () => {
    it('DONATION links should work with OPEN amount', async () => {
      prismaMock.ecommerceMerchant.findFirst.mockResolvedValueOnce({ id: 'merchant-123' })
      prismaMock.paymentLink.create.mockResolvedValueOnce(
        createMockPaymentLink({
          purpose: 'DONATION',
          amountType: 'OPEN',
          amount: null,
          isReusable: true,
        }),
      )

      const result = await createPaymentLink(VENUE_ID, {
        title: 'Donación',
        amountType: 'OPEN',
        isReusable: true,
        purpose: 'DONATION',
      }, STAFF_ID)

      expect(result).toBeDefined()
      expect(prismaMock.paymentLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            purpose: 'DONATION',
            productId: undefined,
            isReusable: true,
          }),
        }),
      )
    })

    it('default purpose should be PAYMENT when not specified', async () => {
      prismaMock.ecommerceMerchant.findFirst.mockResolvedValueOnce({ id: 'merchant-123' })
      prismaMock.paymentLink.create.mockResolvedValueOnce(createMockPaymentLink())

      await createPaymentLink(VENUE_ID, {
        title: 'No purpose specified',
        amountType: 'FIXED',
        amount: 50,
        // No purpose field
      }, STAFF_ID)

      expect(prismaMock.paymentLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            purpose: 'PAYMENT',
          }),
        }),
      )
    })
  })
})
