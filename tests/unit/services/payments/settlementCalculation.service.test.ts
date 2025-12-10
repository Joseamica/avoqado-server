/**
 * Settlement Calculation Service Tests
 *
 * Tests the net settlement amount calculation, specifically verifying that
 * both venueChargeAmount AND venueFixedFee are included in the calculation.
 *
 * BUG FIX: Previously only venueChargeAmount was subtracted, ignoring venueFixedFee
 */

import {
  calculateNetSettlementAmount,
  isBusinessDay,
  addBusinessDays,
  isMexicanHoliday,
  isWeekend,
} from '@/services/payments/settlementCalculation.service'
import prisma from '@/utils/prismaClient'
import { Payment } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    transactionCost: { findUnique: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}))

describe('Settlement Calculation Service', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('calculateNetSettlementAmount', () => {
    const mockPayment = {
      id: 'payment-123',
      amount: new Decimal(100),
    } as Payment

    it('should subtract BOTH venueChargeAmount AND venueFixedFee (BUG FIX)', async () => {
      // Setup: $100 payment with 3.5% + $3.00 fixed fee
      ;(prisma.transactionCost.findUnique as jest.Mock).mockResolvedValue({
        providerCostAmount: new Decimal(1.5), // Provider cost
        venueChargeAmount: new Decimal(3.5), // 3.5% of $100
        venueFixedFee: new Decimal(3.0), // $3.00 fixed
      })

      const netAmount = await calculateNetSettlementAmount(mockPayment)

      // CORRECTED: $100 - $3.50 - $3.00 = $93.50
      expect(netAmount).toBeCloseTo(93.5, 2)
    })

    it('should handle zero fixed fee correctly', async () => {
      ;(prisma.transactionCost.findUnique as jest.Mock).mockResolvedValue({
        providerCostAmount: new Decimal(1.5),
        venueChargeAmount: new Decimal(3.5),
        venueFixedFee: new Decimal(0),
      })

      const netAmount = await calculateNetSettlementAmount(mockPayment)
      expect(netAmount).toBeCloseTo(96.5, 2)
    })

    it('should allow NEGATIVE net amounts when fee > payment (Stripe pattern)', async () => {
      // $1 payment with $3.02 total fee
      const smallPayment = { id: 'small-payment', amount: new Decimal(1) } as Payment
      ;(prisma.transactionCost.findUnique as jest.Mock).mockResolvedValue({
        providerCostAmount: new Decimal(0.5),
        venueChargeAmount: new Decimal(0.02),
        venueFixedFee: new Decimal(3.0),
      })

      const netAmount = await calculateNetSettlementAmount(smallPayment)

      // $1 - $0.02 - $3.00 = -$2.02 (NEGATIVE - like Stripe)
      expect(netAmount).toBeCloseTo(-2.02, 2)
      expect(netAmount).toBeLessThan(0)
    })

    it('should return gross amount when no transaction cost found', async () => {
      ;(prisma.transactionCost.findUnique as jest.Mock).mockResolvedValue(null)
      const netAmount = await calculateNetSettlementAmount(mockPayment)
      expect(netAmount).toBe(100)
    })

    it('should use provided transactionCost instead of querying', async () => {
      const providedCost = {
        providerCostAmount: 2.0,
        venueChargeAmount: 5.0,
        venueFixedFee: 2.0,
      }

      const netAmount = await calculateNetSettlementAmount(mockPayment, providedCost)

      expect(netAmount).toBeCloseTo(93, 2)
      expect(prisma.transactionCost.findUnique).not.toHaveBeenCalled()
    })

    it('should handle high fee percentages correctly', async () => {
      // $50 payment with 5% + $5.00 fixed = $7.50 fee
      const payment = { id: 'payment-456', amount: new Decimal(50) } as Payment
      ;(prisma.transactionCost.findUnique as jest.Mock).mockResolvedValue({
        providerCostAmount: new Decimal(1.0),
        venueChargeAmount: new Decimal(2.5), // 5% of $50
        venueFixedFee: new Decimal(5.0),
      })

      const netAmount = await calculateNetSettlementAmount(payment)
      expect(netAmount).toBeCloseTo(42.5, 2) // $50 - $2.50 - $5.00 = $42.50
    })

    it('should handle Mindform production scenario (negative net)', async () => {
      // Real production case: $2 payment with ~$3.05 fee
      const mindformPayment = { id: 'mindform-payment', amount: new Decimal(2) } as Payment
      ;(prisma.transactionCost.findUnique as jest.Mock).mockResolvedValue({
        providerCostAmount: new Decimal(0.03),
        venueChargeAmount: new Decimal(0.05), // 2.5% of $2
        venueFixedFee: new Decimal(3.0),
      })

      const netAmount = await calculateNetSettlementAmount(mindformPayment)

      // $2 - $0.05 - $3.00 = -$1.05
      expect(netAmount).toBeCloseTo(-1.05, 2)
      expect(netAmount).toBeLessThan(0)
    })
  })

  describe('Mexican Holiday Functions', () => {
    it('should identify January 1st as holiday (New Year)', () => {
      expect(isMexicanHoliday(new Date(2025, 0, 1))).toBe(true)
    })

    it('should identify first Monday of February as Constitution Day', () => {
      // 2025: February 3rd is first Monday
      expect(isMexicanHoliday(new Date(2025, 1, 3))).toBe(true)
    })

    it('should identify third Monday of March as Benito Juarez birthday', () => {
      // 2025: March 17th is third Monday
      expect(isMexicanHoliday(new Date(2025, 2, 17))).toBe(true)
    })

    it('should identify Labor Day (May 1)', () => {
      expect(isMexicanHoliday(new Date(2025, 4, 1))).toBe(true)
    })

    it('should identify Independence Day (September 16)', () => {
      expect(isMexicanHoliday(new Date(2025, 8, 16))).toBe(true)
    })

    it('should identify third Monday of November as Revolution Day', () => {
      // 2025: November 17th is third Monday
      expect(isMexicanHoliday(new Date(2025, 10, 17))).toBe(true)
    })

    it('should identify Christmas (December 25)', () => {
      expect(isMexicanHoliday(new Date(2025, 11, 25))).toBe(true)
    })

    it('should NOT identify regular business day as holiday', () => {
      expect(isMexicanHoliday(new Date(2025, 5, 15))).toBe(false) // June 15
      expect(isMexicanHoliday(new Date(2025, 7, 10))).toBe(false) // August 10
    })
  })

  describe('Weekend Detection', () => {
    it('should identify Saturday as weekend', () => {
      expect(isWeekend(new Date(2025, 0, 4))).toBe(true) // Jan 4, 2025 is Saturday
    })

    it('should identify Sunday as weekend', () => {
      expect(isWeekend(new Date(2025, 0, 5))).toBe(true) // Jan 5, 2025 is Sunday
    })

    it('should NOT identify Monday as weekend', () => {
      expect(isWeekend(new Date(2025, 0, 6))).toBe(false) // Jan 6, 2025 is Monday
    })

    it('should NOT identify Friday as weekend', () => {
      expect(isWeekend(new Date(2025, 0, 10))).toBe(false) // Jan 10, 2025 is Friday
    })
  })

  describe('Business Day Calculations', () => {
    it('should correctly identify weekend days as non-business days', () => {
      expect(isBusinessDay(new Date(2025, 0, 4))).toBe(false) // Saturday
      expect(isBusinessDay(new Date(2025, 0, 5))).toBe(false) // Sunday
    })

    it('should correctly identify weekday as business day', () => {
      expect(isBusinessDay(new Date(2025, 0, 6))).toBe(true) // Monday
      expect(isBusinessDay(new Date(2025, 0, 7))).toBe(true) // Tuesday
    })

    it('should identify holiday as non-business day', () => {
      // January 1, 2025 is Wednesday but it's New Year
      expect(isBusinessDay(new Date(2025, 0, 1))).toBe(false)
    })

    it('should skip weekends when adding business days', () => {
      // Friday Dec 6, 2024 + 1 business day = Monday Dec 9
      const friday = new Date(2024, 11, 6)
      const result = addBusinessDays(friday, 1)
      expect(result.getDay()).toBe(1) // Monday
      expect(result.getDate()).toBe(9)
    })

    it('should skip holidays when adding business days', () => {
      // Dec 24, 2024 (Tuesday) + 1 business day should skip Dec 25 (Christmas)
      const dec24 = new Date(2024, 11, 24)
      const result = addBusinessDays(dec24, 1)
      expect(result.getDate()).toBe(26) // Dec 26
    })

    it('should handle multiple business days correctly', () => {
      // Monday Jan 6, 2025 + 5 business days = Monday Jan 13, 2025
      const monday = new Date(2025, 0, 6)
      const result = addBusinessDays(monday, 5)
      expect(result.getDate()).toBe(13)
      expect(result.getDay()).toBe(1) // Monday
    })
  })
})
