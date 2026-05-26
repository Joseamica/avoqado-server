import { PaymentMethod, CardBrand, TransactionCardType } from '@prisma/client'

// Mock the heavy service before importing the module under test.
// transactionCost.service transitively imports prisma + logger which require
// a running DB and env setup — block that entire module.
// determineTransactionCardType is pure logic; we replicate its behaviour here.
jest.mock('@/services/payments/transactionCost.service', () => ({
  __esModule: true,
  determineTransactionCardType: (method: string, cardBrand: string | null, isInternational?: boolean): TransactionCardType => {
    if (isInternational) return TransactionCardType.INTERNATIONAL
    if (cardBrand === CardBrand.AMERICAN_EXPRESS) return TransactionCardType.AMEX
    if (method === PaymentMethod.DEBIT_CARD) return TransactionCardType.DEBIT
    if (method === PaymentMethod.CREDIT_CARD) return TransactionCardType.CREDIT
    return TransactionCardType.OTHER
  },
}))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {},
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { recomputePaymentEconomics } from '@/services/superadmin/rateCorrection/rateCorrectionPreview'

const venuePricing = {
  debitRate: 0.02,
  creditRate: 0.055,
  amexRate: 0.04,
  internationalRate: 0.045,
  includesTax: true,
  taxRate: 0.16,
  fixedFeePerTransaction: 0,
}

describe('recomputePaymentEconomics', () => {
  it('uses amount + tip and the card-brand-derived type', () => {
    const payment: any = {
      amount: '900',
      tipAmount: '100',
      method: PaymentMethod.CREDIT_CARD,
      cardBrand: CardBrand.VISA,
      processorData: null,
    }
    const r = recomputePaymentEconomics(payment, venuePricing, null)
    expect(r.transactionType).toBe(TransactionCardType.CREDIT)
    expect(r.after.feeAmount).toBeCloseTo(1000 * 0.055, 6)
    expect(r.after.netAmount).toBeCloseTo(945, 6)
  })
  it('routes AMEX brand to the AMEX tier', () => {
    const payment: any = {
      amount: '1000',
      tipAmount: '0',
      method: PaymentMethod.CREDIT_CARD,
      cardBrand: CardBrand.AMERICAN_EXPRESS,
      processorData: null,
    }
    const r = recomputePaymentEconomics(payment, venuePricing, null)
    expect(r.transactionType).toBe(TransactionCardType.AMEX)
    expect(r.after.feeAmount).toBeCloseTo(40, 6)
  })
})
