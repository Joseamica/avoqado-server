import { PaymentMethod, CardBrand } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venuePaymentConfig: { findUnique: jest.fn() },
    payment: { findMany: jest.fn() },
    transactionCost: { findMany: jest.fn() },
    providerCostStructure: { findFirst: jest.fn() },
    venuePricingStructure: { findFirst: jest.fn() },
  },
}))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import prisma from '@/utils/prismaClient'
import { previewRateCorrection } from '@/services/superadmin/rateCorrection/rateCorrectionPreview'

const newVenueRates = {
  debitRate: 0.02,
  creditRate: 0.055,
  amexRate: 0.04,
  internationalRate: 0.045,
  includesTax: true,
  taxRate: 0.16,
  fixedFeePerTransaction: 0,
}

describe('previewRateCorrection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.venuePaymentConfig.findUnique as jest.Mock).mockResolvedValue({
      primaryAccountId: 'ma_1',
      secondaryAccountId: null,
      tertiaryAccountId: null,
    })
    ;(prisma.venuePricingStructure.findFirst as jest.Mock).mockResolvedValue(null)
  })

  it('aggregates counts and impact without writing', async () => {
    ;(prisma.payment.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'p1',
        amount: '1000',
        tipAmount: '0',
        method: PaymentMethod.CREDIT_CARD,
        cardBrand: CardBrand.VISA,
        processorData: null,
        feeAmount: '10',
      },
      {
        id: 'p2',
        amount: '1000',
        tipAmount: '0',
        method: PaymentMethod.CREDIT_CARD,
        cardBrand: CardBrand.VISA,
        processorData: null,
        feeAmount: '10',
      },
    ])
    ;(prisma.transactionCost.findMany as jest.Mock).mockResolvedValue([{ paymentId: 'p1' }])
    ;(prisma.providerCostStructure.findFirst as jest.Mock).mockResolvedValue({
      debitRate: 0.01,
      creditRate: 0.02,
      amexRate: 0.025,
      internationalRate: 0.03,
      includesTax: true,
      taxRate: 0.16,
      fixedCostPerTransaction: 0,
    })

    const r = await previewRateCorrection({ venueId: 'v1', accountType: 'PRIMARY', newVenueRates, missingCostMode: 'CREATE_COST' })

    expect(r.inScopeCount).toBe(2)
    expect(r.withCostCount).toBe(1)
    expect(r.missingCostCount).toBe(1)
    expect(r.beforeFeeTotal).toBeCloseTo(20, 6)
    expect(r.afterFeeTotal).toBeCloseTo(110, 6)
    expect(r.estimatedImpact).toBeCloseTo(90, 6)
    expect(r.negativeMarginCount).toBe(0)
    expect(r.costStructureAvailable).toBe(true)
    // assert NO write happened
    expect((prisma.payment as any).update).toBeUndefined()
  })

  it('flags costStructureAvailable=false when no provider cost structure and none provided', async () => {
    ;(prisma.payment.findMany as jest.Mock).mockResolvedValue([])
    ;(prisma.transactionCost.findMany as jest.Mock).mockResolvedValue([])
    ;(prisma.providerCostStructure.findFirst as jest.Mock).mockResolvedValue(null)
    const r = await previewRateCorrection({ venueId: 'v1', accountType: 'PRIMARY', newVenueRates, missingCostMode: 'CREATE_COST' })
    expect(r.costStructureAvailable).toBe(false)
    expect(r.inScopeCount).toBe(0)
  })

  it('uses provided newProviderRates over the active structure', async () => {
    ;(prisma.payment.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'p1',
        amount: '1000',
        tipAmount: '0',
        method: PaymentMethod.CREDIT_CARD,
        cardBrand: CardBrand.VISA,
        processorData: null,
        feeAmount: '10',
      },
    ])
    ;(prisma.transactionCost.findMany as jest.Mock).mockResolvedValue([{ paymentId: 'p1' }])
    ;(prisma.providerCostStructure.findFirst as jest.Mock).mockResolvedValue(null)
    const r = await previewRateCorrection({
      venueId: 'v1',
      accountType: 'PRIMARY',
      newVenueRates,
      newProviderRates: {
        debitRate: 0.01,
        creditRate: 0.02,
        amexRate: 0.025,
        internationalRate: 0.03,
        includesTax: true,
        taxRate: 0.16,
        fixedCostPerTransaction: 0,
      },
      missingCostMode: 'FIX_PAYMENT_ONLY',
    })
    expect(r.costStructureAvailable).toBe(true) // because newProviderRates provided
    expect(r.afterFeeTotal).toBeCloseTo(55, 6)
  })
})
