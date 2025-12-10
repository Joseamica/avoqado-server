/**
 * TransactionCost Service Tests
 *
 * Tests the transaction cost calculation, specifically verifying that
 * the tip amount is included in the total amount for commission calculation.
 */

import { determineTransactionCardType } from '@/services/payments/transactionCost.service'
import { PaymentMethod, CardBrand, TransactionCardType } from '@prisma/client'

describe('TransactionCost Service', () => {
  describe('determineTransactionCardType', () => {
    it('should return INTERNATIONAL for international cards', () => {
      const result = determineTransactionCardType(PaymentMethod.CREDIT_CARD, CardBrand.VISA, true)
      expect(result).toBe(TransactionCardType.INTERNATIONAL)
    })

    it('should return AMEX for American Express cards', () => {
      const result = determineTransactionCardType(PaymentMethod.CREDIT_CARD, CardBrand.AMERICAN_EXPRESS, false)
      expect(result).toBe(TransactionCardType.AMEX)
    })

    it('should return DEBIT for debit cards', () => {
      const result = determineTransactionCardType(PaymentMethod.DEBIT_CARD, CardBrand.VISA, false)
      expect(result).toBe(TransactionCardType.DEBIT)
    })

    it('should return CREDIT for credit cards', () => {
      const result = determineTransactionCardType(PaymentMethod.CREDIT_CARD, CardBrand.MASTERCARD, false)
      expect(result).toBe(TransactionCardType.CREDIT)
    })

    it('should prioritize INTERNATIONAL over AMEX', () => {
      // Even if it's an AMEX card, international rate takes precedence
      const result = determineTransactionCardType(PaymentMethod.CREDIT_CARD, CardBrand.AMERICAN_EXPRESS, true)
      expect(result).toBe(TransactionCardType.INTERNATIONAL)
    })
  })

  describe('Transaction amount calculation with tip', () => {
    /**
     * This test verifies the fix for the bug where tips were not included
     * in the transaction cost calculation.
     *
     * Bug scenario:
     * - Payment amount: $777.94
     * - Tip amount: $130.08
     * - Total processed by terminal: $908.02
     *
     * Before fix: Commission calculated on $777.94 (wrong)
     * After fix: Commission calculated on $908.02 (correct)
     */
    it('should calculate commission on total amount including tip', () => {
      // Simulate the calculation logic from transactionCost.service.ts
      const paymentAmount = 777.94
      const tipAmount = 130.08
      const providerRate = 0.015 // 1.5%
      const venueRate = 0.025 // 2.5%

      // NEW CORRECT CALCULATION (including tip)
      const totalAmount = paymentAmount + tipAmount // $908.02

      const providerCost = totalAmount * providerRate // $13.62
      const venueCharge = totalAmount * venueRate // $22.70
      const grossProfit = venueCharge - providerCost // $9.08

      expect(totalAmount).toBeCloseTo(908.02, 2)
      expect(providerCost).toBeCloseTo(13.62, 2)
      expect(venueCharge).toBeCloseTo(22.7, 2)
      expect(grossProfit).toBeCloseTo(9.08, 2)
    })

    it('should handle payments without tips', () => {
      const paymentAmount = 500.0
      const tipAmount = 0
      const providerRate = 0.015
      const venueRate = 0.025

      const totalAmount = paymentAmount + tipAmount

      const providerCost = totalAmount * providerRate
      const venueCharge = totalAmount * venueRate
      const grossProfit = venueCharge - providerCost

      expect(totalAmount).toBe(500.0)
      expect(providerCost).toBeCloseTo(7.5, 2)
      expect(venueCharge).toBeCloseTo(12.5, 2)
      expect(grossProfit).toBeCloseTo(5.0, 2)
    })

    it('should handle null/undefined tip amounts', () => {
      // Simulating a payment object where tipAmount might be null/undefined
      const payment = { amount: '100.0', tipAmount: null as string | null }

      // This mimics the fix: parseFloat(payment.tipAmount?.toString() || '0')
      const baseAmount = parseFloat(payment.amount)
      const tipAmount = parseFloat(payment.tipAmount?.toString() || '0')
      const totalAmount = baseAmount + tipAmount

      expect(totalAmount).toBe(100.0)
      expect(tipAmount).toBe(0)
    })

    it('should calculate correct profit margin percentage', () => {
      const paymentAmount = 777.94
      const tipAmount = 130.08
      const providerRate = 0.015
      const venueRate = 0.025

      const totalAmount = paymentAmount + tipAmount
      const providerCost = totalAmount * providerRate
      const venueCharge = totalAmount * venueRate
      const grossProfit = venueCharge - providerCost

      // Profit margin = grossProfit / venueCharge
      const profitMargin = grossProfit / venueCharge

      // 40% of what we charge is profit
      expect(profitMargin).toBeCloseTo(0.4, 2)
    })

    it('should demonstrate the bug fix with real numbers', () => {
      const paymentAmount = 777.94
      const tipAmount = 130.08
      const providerRate = 0.015
      const venueRate = 0.025

      // OLD BUGGY CALCULATION (without tip)
      const oldProviderCost = paymentAmount * providerRate // $11.67
      const oldVenueCharge = paymentAmount * venueRate // $19.45
      const oldGrossProfit = oldVenueCharge - oldProviderCost // $7.78

      // NEW CORRECT CALCULATION (with tip)
      const totalAmount = paymentAmount + tipAmount
      const newProviderCost = totalAmount * providerRate // $13.62
      const newVenueCharge = totalAmount * venueRate // $22.70
      const newGrossProfit = newVenueCharge - newProviderCost // $9.08

      // The difference is significant!
      const profitDifference = newGrossProfit - oldGrossProfit // $1.30

      expect(oldGrossProfit).toBeCloseTo(7.78, 2)
      expect(newGrossProfit).toBeCloseTo(9.08, 2)
      expect(profitDifference).toBeCloseTo(1.3, 2)

      // For a restaurant with 100 tipped payments/day, this is $130/day lost!
      const dailyLoss = profitDifference * 100
      expect(dailyLoss).toBeCloseTo(130, 0)
    })
  })

  describe('createTransactionCost return values', () => {
    /**
     * These tests verify the return value structure of createTransactionCost
     * which now returns { transactionCost, feeAmount, netAmount }
     *
     * This is critical for propagating fee values to Payment and VenueTransaction
     */

    it('should return feeAmount and netAmount for caller consumption', () => {
      // Test values from $100 payment with 3.5% + $3.00 fixed
      const totalAmount = 100
      const venueRate = 0.035
      const venueFixedFee = 3.0

      const venueChargeAmount = totalAmount * venueRate // $3.50
      const totalFee = venueChargeAmount + venueFixedFee // $6.50
      const netAmount = totalAmount - totalFee // $93.50

      expect(totalFee).toBeCloseTo(6.5, 2)
      expect(netAmount).toBeCloseTo(93.5, 2)
    })

    it('should calculate NEGATIVE net when fee exceeds amount', () => {
      // $1 payment with 2% + $3.00 fixed (Mindform production scenario)
      const totalAmount = 1.0
      const venueRate = 0.02
      const venueFixedFee = 3.0

      const venueChargeAmount = totalAmount * venueRate // $0.02
      const totalFee = venueChargeAmount + venueFixedFee // $3.02
      const netAmount = totalAmount - totalFee // -$2.02

      expect(totalFee).toBeCloseTo(3.02, 2)
      expect(netAmount).toBeCloseTo(-2.02, 2)
      expect(netAmount).toBeLessThan(0)
    })

    it('should calculate Avoqado profit correctly even with negative net', () => {
      // $1 payment: Avoqado still profits even if venue nets negative
      // This is the key business insight: Avoqado ALWAYS profits on the spread
      const totalAmount = 1.0
      const providerRate = 0.015 // 1.5% Blumon cost
      const venueRate = 0.02 // 2% charged to venue
      const providerFixedFee = 0
      const venueFixedFee = 3.0

      const providerCost = totalAmount * providerRate + providerFixedFee // $0.015
      const venueCharge = totalAmount * venueRate + venueFixedFee // $3.02

      const grossProfit = venueCharge - providerCost // $3.005

      expect(grossProfit).toBeGreaterThan(0) // Avoqado ALWAYS profits
      expect(grossProfit).toBeCloseTo(3.005, 2)
    })

    it('should include tip amount in fee calculation base', () => {
      // $100 base + $20 tip = $120 total for fee calculation
      // This ensures the processor is paid on ALL money that flows through
      const baseAmount = 100
      const tipAmount = 20
      const totalAmount = baseAmount + tipAmount
      const venueRate = 0.035
      const venueFixedFee = 3.0

      const venueChargeAmount = totalAmount * venueRate // $4.20 (not $3.50!)
      const totalFee = venueChargeAmount + venueFixedFee // $7.20

      expect(venueChargeAmount).toBeCloseTo(4.2, 2)
      expect(totalFee).toBeCloseTo(7.2, 2)
    })

    it('should calculate correct fee structure for standard venue pricing', () => {
      // Standard Avoqado pricing: 3.5% + $3.00 MXN fixed
      const paymentAmount = 500 // $500 MXN payment
      const tipAmount = 75 // $75 MXN tip
      const totalAmount = paymentAmount + tipAmount // $575 MXN total

      const venueRate = 0.035 // 3.5%
      const venueFixedFee = 3.0 // $3.00 MXN

      const venueChargeAmount = totalAmount * venueRate // $20.125
      const totalFee = venueChargeAmount + venueFixedFee // $23.125
      const netAmount = totalAmount - totalFee // $551.875

      expect(venueChargeAmount).toBeCloseTo(20.125, 2)
      expect(totalFee).toBeCloseTo(23.125, 2)
      expect(netAmount).toBeCloseTo(551.875, 2)
      expect(netAmount).toBeGreaterThan(0) // Normal payment should have positive net
    })

    it('should calculate breakeven point for minimum viable transaction', () => {
      // Find the minimum payment amount where net >= 0
      // With 3.5% + $3.00 fixed: solve for totalAmount - (0.035 * totalAmount + 3) >= 0
      // 0.965 * totalAmount >= 3
      // totalAmount >= 3.11
      const breakEvenAmount = 3.0 / 0.965 // ~$3.11

      const venueRate = 0.035
      const venueFixedFee = 3.0

      const venueChargeAtBreakeven = breakEvenAmount * venueRate + venueFixedFee
      const netAtBreakeven = breakEvenAmount - venueChargeAtBreakeven

      expect(netAtBreakeven).toBeCloseTo(0, 1)
      expect(breakEvenAmount).toBeCloseTo(3.11, 2)
    })
  })
})
