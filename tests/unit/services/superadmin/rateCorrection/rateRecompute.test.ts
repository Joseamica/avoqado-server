import { TransactionCardType } from '@prisma/client'
import { recomputeEconomics, getRateForTransactionType, applyTaxIfNeeded } from '@/services/superadmin/rateCorrection/rateRecompute'

const venuePricing = (over = {}) => ({
  debitRate: 0.02,
  creditRate: 0.055,
  amexRate: 0.04,
  internationalRate: 0.045,
  includesTax: true,
  taxRate: 0.16,
  fixedFeePerTransaction: 0,
  ...over,
})
const providerCost = (over = {}) => ({
  debitRate: 0.01,
  creditRate: 0.02,
  amexRate: 0.025,
  internationalRate: 0.03,
  includesTax: true,
  taxRate: 0.16,
  fixedCostPerTransaction: 0,
  ...over,
})

describe('getRateForTransactionType', () => {
  it('selects the rate column by card type', () => {
    expect(getRateForTransactionType(venuePricing(), TransactionCardType.CREDIT)).toBe(0.055)
    expect(getRateForTransactionType(venuePricing(), TransactionCardType.DEBIT)).toBe(0.02)
    expect(getRateForTransactionType(venuePricing(), TransactionCardType.AMEX)).toBe(0.04)
    expect(getRateForTransactionType(venuePricing(), TransactionCardType.INTERNATIONAL)).toBe(0.045)
  })
  it('falls back to credit for OTHER', () => {
    expect(getRateForTransactionType(venuePricing(), TransactionCardType.OTHER)).toBe(0.055)
  })
})

describe('applyTaxIfNeeded', () => {
  it('returns base rate when includesTax is true', () => {
    expect(applyTaxIfNeeded(venuePricing({ includesTax: true }), 0.055)).toBeCloseTo(0.055, 10)
  })
  it('returns base rate when includesTax is null (legacy)', () => {
    expect(applyTaxIfNeeded(venuePricing({ includesTax: null }), 0.055)).toBeCloseTo(0.055, 10)
  })
  it('adds tax when includesTax is false', () => {
    expect(applyTaxIfNeeded(venuePricing({ includesTax: false, taxRate: 0.16 }), 0.05)).toBeCloseTo(0.058, 10)
  })
  it('honors a 0 taxRate (no-IVA jurisdiction) instead of defaulting to 16%', () => {
    expect(applyTaxIfNeeded(venuePricing({ includesTax: false, taxRate: 0 }), 0.05)).toBeCloseTo(0.05, 10)
  })
})

describe('recomputeEconomics', () => {
  it('computes fee/net/profit for a credit payment with includesTax=true', () => {
    const r = recomputeEconomics({
      amount: 1000,
      transactionType: TransactionCardType.CREDIT,
      venuePricing: venuePricing(),
      providerCost: providerCost(),
    })
    expect(r.venueRate).toBeCloseTo(0.055, 10)
    expect(r.venueChargeAmount).toBeCloseTo(55, 6)
    expect(r.feeAmount).toBeCloseTo(55, 6)
    expect(r.netAmount).toBeCloseTo(945, 6)
    expect(r.providerCostAmount).toBeCloseTo(20, 6)
    expect(r.grossProfit).toBeCloseTo(35, 6)
    expect(r.profitMargin).toBeCloseTo(35 / 55, 10)
  })
  it('treats missing providerCost as zero cost (margin = full venue charge)', () => {
    const r = recomputeEconomics({
      amount: 1000,
      transactionType: TransactionCardType.CREDIT,
      venuePricing: venuePricing(),
      providerCost: null,
    })
    expect(r.providerCostAmount).toBe(0)
    expect(r.grossProfit).toBeCloseTo(55, 6)
  })
  it('applies fixed fees on both sides', () => {
    const r = recomputeEconomics({
      amount: 100,
      transactionType: TransactionCardType.DEBIT,
      venuePricing: venuePricing({ fixedFeePerTransaction: 1 }),
      providerCost: providerCost({ fixedCostPerTransaction: 0.5 }),
    })
    expect(r.feeAmount).toBeCloseTo(100 * 0.02 + 1, 6)
    expect(r.grossProfit).toBeCloseTo(3 - (100 * 0.01 + 0.5), 6)
  })
})

describe('parity with live transactionCost math', () => {
  it('venueRate/feeAmount match the documented live formula (amount incl. tip, fee = charge + fixed, net = amount - fee)', () => {
    const amount = 1234.56
    const r = recomputeEconomics({
      amount,
      transactionType: TransactionCardType.CREDIT,
      venuePricing: {
        debitRate: 0.02,
        creditRate: 0.03,
        amexRate: 0.04,
        internationalRate: 0.045,
        includesTax: false,
        taxRate: 0.16,
        fixedFeePerTransaction: 2,
      },
      providerCost: null,
    })
    const expectedVenueRate = 0.03 * 1.16
    expect(r.venueRate).toBeCloseTo(expectedVenueRate, 10)
    expect(r.feeAmount).toBeCloseTo(amount * expectedVenueRate + 2, 6)
    expect(r.netAmount).toBeCloseTo(amount - (amount * expectedVenueRate + 2), 6)
  })
})
