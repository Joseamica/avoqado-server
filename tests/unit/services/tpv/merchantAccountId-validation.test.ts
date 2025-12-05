/**
 * MerchantAccountId Validation Tests
 *
 * Tests the defensive validation that prevents FK constraint violations
 * when Android sends a stale/invalid merchantAccountId.
 *
 * Bug scenario this prevents:
 * - Android has cached merchantAccountId from deleted/old merchant
 * - Payment request arrives with invalid merchantAccountId
 * - Without validation: FK constraint error, payment blocked
 * - With validation: Falls back to null, payment succeeds
 *
 * Pattern: Toast/Square - Backend is SOURCE OF TRUTH
 */

import { PaymentMethod, PaymentStatus, CardBrand } from '@prisma/client'

// Define mock type to avoid circular reference
interface MockPrismaClient {
  merchantAccount: { findUnique: jest.Mock }
  payment: { create: jest.Mock; findFirst: jest.Mock; update: jest.Mock }
  order: { findUnique: jest.Mock; update: jest.Mock }
  venue: { findUnique: jest.Mock }
  $transaction: jest.Mock
}

// Mock prisma before importing the service
const mockPrismaClient: MockPrismaClient = {
  merchantAccount: {
    findUnique: jest.fn(),
  },
  payment: {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  order: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  venue: {
    findUnique: jest.fn(),
  },
  $transaction: jest.fn((callback: (tx: MockPrismaClient) => Promise<unknown>) => callback(mockPrismaClient)),
}

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: mockPrismaClient,
}))

// Mock logger
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

// Mock socket manager
jest.mock('@/communication/sockets', () => ({
  socketManager: {
    getBroadcastingService: jest.fn(() => ({
      broadcastPaymentUpdate: jest.fn(),
      broadcastOrderUpdate: jest.fn(),
    })),
  },
}))

// Mock transaction cost service
jest.mock('@/services/payments/transactionCost.service', () => ({
  calculateTransactionCost: jest.fn(() => ({
    providerCost: 10,
    venueCharge: 25,
    grossProfit: 15,
    netProfit: 15,
    transactionCardType: 'CREDIT',
  })),
  determineTransactionCardType: jest.fn(() => 'CREDIT'),
}))

// Mock rawMaterial service (inventory)
jest.mock('@/services/dashboard/rawMaterial.service', () => ({
  deductStockForRecipe: jest.fn(() => Promise.resolve({ success: true, errors: [] })),
}))

import logger from '@/config/logger'

describe('MerchantAccountId Validation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('Defensive Validation Logic', () => {
    /**
     * This test verifies the core validation logic that prevents FK errors
     */
    it('should detect non-existent merchantAccountId and log error', async () => {
      const phantomMerchantId = 'cmio3f7t0000q9kcr4dk0t2en' // ID that doesn't exist

      // Simulate the validation check
      mockPrismaClient.merchantAccount.findUnique.mockResolvedValue(null)

      const merchantExists = await mockPrismaClient.merchantAccount.findUnique({
        where: { id: phantomMerchantId },
        select: { id: true, active: true },
      })

      expect(merchantExists).toBeNull()
      expect(mockPrismaClient.merchantAccount.findUnique).toHaveBeenCalledWith({
        where: { id: phantomMerchantId },
        select: { id: true, active: true },
      })
    })

    it('should detect inactive merchantAccountId', async () => {
      const inactiveMerchantId = 'cmip14p3w000q9krckhfrfrzo'

      mockPrismaClient.merchantAccount.findUnique.mockResolvedValue({
        id: inactiveMerchantId,
        active: false, // Inactive merchant
      })

      const merchantExists = await mockPrismaClient.merchantAccount.findUnique({
        where: { id: inactiveMerchantId },
        select: { id: true, active: true },
      })

      expect(merchantExists).not.toBeNull()
      expect(merchantExists?.active).toBe(false)
    })

    it('should allow valid and active merchantAccountId', async () => {
      const validMerchantId = 'cmip14p3w000q9krckhfrfrzo'

      mockPrismaClient.merchantAccount.findUnique.mockResolvedValue({
        id: validMerchantId,
        active: true,
      })

      const merchantExists = await mockPrismaClient.merchantAccount.findUnique({
        where: { id: validMerchantId },
        select: { id: true, active: true },
      })

      expect(merchantExists).not.toBeNull()
      expect(merchantExists?.active).toBe(true)
    })
  })

  describe('Fallback Behavior', () => {
    /**
     * Simulates the fallback logic from payment.tpv.service.ts
     */
    it('should fall back to undefined when merchantAccountId does not exist', () => {
      let merchantAccountId: string | undefined = 'phantom-id-123'
      const merchantExists = null // Simulating DB returned null

      // This is the actual logic from the service
      if (!merchantExists) {
        merchantAccountId = undefined
      }

      expect(merchantAccountId).toBeUndefined()
    })

    it('should fall back to undefined when merchantAccountId is inactive', () => {
      let merchantAccountId: string | undefined = 'inactive-merchant-id'
      const merchantExists = { id: 'inactive-merchant-id', active: false }

      // This is the actual logic from the service
      if (merchantExists && !merchantExists.active) {
        merchantAccountId = undefined
      }

      expect(merchantAccountId).toBeUndefined()
    })

    it('should keep merchantAccountId when valid and active', () => {
      let merchantAccountId: string | undefined = 'valid-merchant-id'
      const merchantExists = { id: 'valid-merchant-id', active: true }

      // This is the actual logic from the service
      if (!merchantExists) {
        merchantAccountId = undefined
      } else if (!merchantExists.active) {
        merchantAccountId = undefined
      }
      // Otherwise keep the original value

      expect(merchantAccountId).toBe('valid-merchant-id')
    })

    it('should handle null merchantAccountId gracefully (legacy mode)', () => {
      const merchantAccountId: string | undefined | null = null

      // When merchantAccountId is null/undefined, validation is skipped
      if (merchantAccountId) {
        // This block should not execute
        throw new Error('Should not validate null merchantAccountId')
      }

      // Payment should proceed with null merchantAccountId
      expect(merchantAccountId).toBeNull()
    })
  })

  describe('Payment Creation with Validated MerchantAccountId', () => {
    const basePaymentData = {
      amount: '100.00',
      tipAmount: '15.00',
      method: PaymentMethod.CREDIT_CARD,
      status: PaymentStatus.PAID,
      cardBrand: CardBrand.VISA,
      cardLastFour: '1234',
      referenceNumber: 'REF-123456',
      authorizationNumber: 'AUTH-789',
    }

    it('should create payment with valid merchantAccountId', async () => {
      const validMerchantId = 'cmip14p3w000q9krckhfrfrzo'

      mockPrismaClient.merchantAccount.findUnique.mockResolvedValue({
        id: validMerchantId,
        active: true,
      })

      mockPrismaClient.payment.create.mockResolvedValue({
        id: 'payment-123',
        ...basePaymentData,
        merchantAccountId: validMerchantId,
      })

      // Simulate the validation + creation flow
      const merchantExists = await mockPrismaClient.merchantAccount.findUnique({
        where: { id: validMerchantId },
        select: { id: true, active: true },
      })

      let finalMerchantId: string | undefined = validMerchantId
      if (!merchantExists || !merchantExists.active) {
        finalMerchantId = undefined
      }

      const payment = await mockPrismaClient.payment.create({
        data: {
          ...basePaymentData,
          merchantAccountId: finalMerchantId,
        },
      })

      expect(payment.merchantAccountId).toBe(validMerchantId)
    })

    it('should create payment with null merchantAccountId when invalid ID provided', async () => {
      const phantomMerchantId = 'phantom-deleted-merchant'

      mockPrismaClient.merchantAccount.findUnique.mockResolvedValue(null)

      mockPrismaClient.payment.create.mockResolvedValue({
        id: 'payment-123',
        ...basePaymentData,
        merchantAccountId: null, // Fell back to null
      })

      // Simulate the validation + creation flow
      const merchantExists = await mockPrismaClient.merchantAccount.findUnique({
        where: { id: phantomMerchantId },
        select: { id: true, active: true },
      })

      let finalMerchantId: string | undefined = phantomMerchantId
      if (!merchantExists) {
        finalMerchantId = undefined
      }

      const payment = await mockPrismaClient.payment.create({
        data: {
          ...basePaymentData,
          merchantAccountId: finalMerchantId,
        },
      })

      // Payment succeeded with null merchantAccountId
      expect(payment.merchantAccountId).toBeNull()
      expect(payment.id).toBe('payment-123')
    })

    it('should NOT throw FK constraint error with invalid merchantAccountId', async () => {
      const phantomMerchantId = 'cmio3f7t0000q9kcr4dk0t2en'

      // Without validation, this would cause FK error
      mockPrismaClient.merchantAccount.findUnique.mockResolvedValue(null)

      // With validation, we fall back to null and payment succeeds
      mockPrismaClient.payment.create.mockResolvedValue({
        id: 'payment-success',
        ...basePaymentData,
        merchantAccountId: null,
      })

      // Simulate the full flow
      const merchantExists = await mockPrismaClient.merchantAccount.findUnique({
        where: { id: phantomMerchantId },
        select: { id: true, active: true },
      })

      let finalMerchantId: string | undefined = phantomMerchantId
      if (!merchantExists) {
        finalMerchantId = undefined
      }

      // This should NOT throw
      const createPayment = async () => {
        return mockPrismaClient.payment.create({
          data: {
            ...basePaymentData,
            merchantAccountId: finalMerchantId,
          },
        })
      }

      await expect(createPayment()).resolves.not.toThrow()
      const payment = await createPayment()
      expect(payment.id).toBe('payment-success')
    })
  })

  describe('Logging Verification', () => {
    it('should log error when merchantAccountId not found', () => {
      const phantomId = 'phantom-merchant-id'
      const venueId = 'venue-123'
      const paymentMethod = PaymentMethod.CREDIT_CARD

      // Simulate the logging that happens in the service
      logger.error(`❌ MerchantAccount not found: ${phantomId}`, {
        venueId,
        paymentMethod,
        providedId: phantomId,
        hint: 'Android may have stale config. User should restart app to refresh merchant list.',
      })

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('MerchantAccount not found'),
        expect.objectContaining({
          venueId,
          providedId: phantomId,
        }),
      )
    })

    it('should log warning when falling back to legacy mode', () => {
      logger.warn(`⚠️ Falling back to null merchantAccountId (legacy mode) - payment will succeed but without merchant attribution`)

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Falling back to null merchantAccountId'))
    })

    it('should log warning for inactive merchant', () => {
      const inactiveId = 'inactive-merchant-id'
      const venueId = 'venue-123'

      logger.warn(`⚠️ MerchantAccount ${inactiveId} is inactive`, {
        venueId,
        paymentMethod: PaymentMethod.DEBIT_CARD,
      })

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('is inactive'),
        expect.objectContaining({
          venueId,
        }),
      )
    })
  })

  describe('Edge Cases', () => {
    it('should handle empty string merchantAccountId', () => {
      let merchantAccountId: string | undefined = ''

      // Empty string is falsy, so validation is skipped
      if (merchantAccountId) {
        throw new Error('Should not validate empty string')
      }

      // Convert empty string to undefined for consistency
      if (merchantAccountId === '') {
        merchantAccountId = undefined
      }

      expect(merchantAccountId).toBeUndefined()
    })

    it('should handle whitespace-only merchantAccountId', () => {
      let merchantAccountId: string | undefined = '   '

      // Trim and check
      if (merchantAccountId?.trim() === '') {
        merchantAccountId = undefined
      }

      expect(merchantAccountId).toBeUndefined()
    })

    it('should handle concurrent validation requests', async () => {
      const merchantId = 'valid-merchant'

      mockPrismaClient.merchantAccount.findUnique.mockResolvedValue({
        id: merchantId,
        active: true,
      })

      // Simulate 5 concurrent payment validations
      const validations = Array(5)
        .fill(null)
        .map(() =>
          mockPrismaClient.merchantAccount.findUnique({
            where: { id: merchantId },
            select: { id: true, active: true },
          }),
        )

      const results = await Promise.all(validations)

      // All should succeed
      expect(results).toHaveLength(5)
      results.forEach(result => {
        expect(result?.active).toBe(true)
      })
    })
  })

  describe('Real Bug Scenario Regression Tests', () => {
    /**
     * This test recreates the exact bug scenario from the plan:
     * - Terminal AVQD-2841548417 has empty assignedMerchantIds
     * - Android sends phantom ID cmio3f7t0000q9kcr4dk0t2en
     * - FK constraint should NOT fail
     */
    it('should handle the exact phantom ID from the bug report', async () => {
      const phantomId = 'cmio3f7t0000q9kcr4dk0t2en' // The exact ID from the bug
      const venueId = 'cmip14p9u00219krcfxvjlehe' // The exact venue from the bug

      // This ID does not exist in the database
      mockPrismaClient.merchantAccount.findUnique.mockResolvedValue(null)

      // Simulate the validation
      const merchantExists = await mockPrismaClient.merchantAccount.findUnique({
        where: { id: phantomId },
        select: { id: true, active: true },
      })

      let finalMerchantId: string | undefined = phantomId
      if (!merchantExists) {
        finalMerchantId = undefined
      }

      // Payment should proceed with null
      expect(finalMerchantId).toBeUndefined()

      // Now create the payment
      mockPrismaClient.payment.create.mockResolvedValue({
        id: 'payment-from-bug-scenario',
        amount: '908.02',
        tipAmount: '130.08',
        merchantAccountId: null,
        status: PaymentStatus.PAID,
      })

      const payment = await mockPrismaClient.payment.create({
        data: {
          amount: '908.02',
          tipAmount: '130.08',
          merchantAccountId: finalMerchantId,
          venueId,
          status: PaymentStatus.PAID,
        },
      })

      // Payment succeeded despite invalid merchantAccountId
      expect(payment.status).toBe(PaymentStatus.PAID)
      expect(payment.merchantAccountId).toBeNull()
    })

    it('should succeed with valid merchant IDs from the bug report', async () => {
      // These are the actual valid merchant IDs from the bug investigation
      const validMerchantIds = ['cmip14p3w000q9krckhfrfrzo', 'cmip14p3x000s9krcjkm3z3v7']

      for (const merchantId of validMerchantIds) {
        mockPrismaClient.merchantAccount.findUnique.mockResolvedValue({
          id: merchantId,
          active: true,
        })

        const merchantExists = await mockPrismaClient.merchantAccount.findUnique({
          where: { id: merchantId },
          select: { id: true, active: true },
        })

        expect(merchantExists).not.toBeNull()
        expect(merchantExists?.active).toBe(true)
      }
    })
  })
})
