import { PaymentMethod, CardBrand } from '@prisma/client'

const tx = {
  payment: { update: jest.fn() },
  venueTransaction: { update: jest.fn() },
  transactionCost: { update: jest.fn(), createMany: jest.fn() },
  rateCorrectionEntry: { createMany: jest.fn() },
}
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venuePaymentConfig: { findUnique: jest.fn() },
    payment: { findMany: jest.fn() },
    transactionCost: { findMany: jest.fn() },
    venueTransaction: { findMany: jest.fn() },
    providerCostStructure: { findFirst: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    venuePricingStructure: { findFirst: jest.fn() },
    merchantAccount: { findUniqueOrThrow: jest.fn() },
    rateCorrectionBatch: { create: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(async cb => cb(tx)),
  },
}))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('@/services/superadmin/venuePricing.service', () => ({
  __esModule: true,
  getActivePricingStructure: jest.fn(),
  updateVenuePricingStructure: jest.fn(),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getActivePricingStructure } from '@/services/superadmin/venuePricing.service'
import { applyRateCorrection } from '@/services/superadmin/rateCorrection/rateCorrectionApply'

const newVenueRates = {
  debitRate: 0.02,
  creditRate: 0.055,
  amexRate: 0.04,
  internationalRate: 0.045,
  includesTax: true,
  taxRate: 0.16,
  fixedFeePerTransaction: 0,
}
const activeVenue = { id: 'vps_1', ...newVenueRates }
const activeProvider = {
  id: 'pcs_1',
  debitRate: 0.01,
  creditRate: 0.02,
  amexRate: 0.025,
  internationalRate: 0.03,
  includesTax: true,
  taxRate: 0.16,
  fixedCostPerTransaction: 0,
}

describe('applyRateCorrection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.venuePaymentConfig.findUnique as jest.Mock).mockResolvedValue({
      primaryAccountId: 'ma_1',
      secondaryAccountId: null,
      tertiaryAccountId: null,
    })
    ;(prisma.venuePricingStructure.findFirst as jest.Mock).mockResolvedValue(activeVenue)
    ;(prisma.providerCostStructure.findFirst as jest.Mock).mockResolvedValue(activeProvider)
    ;(getActivePricingStructure as jest.Mock).mockResolvedValue(activeVenue)
    ;(prisma.rateCorrectionBatch.create as jest.Mock).mockResolvedValue({ id: 'b1' })
    ;(prisma.rateCorrectionBatch.update as jest.Mock).mockResolvedValue({ id: 'b1', status: 'APPLIED' })
    ;(prisma.payment.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'p1',
        amount: '1000',
        tipAmount: '0',
        method: PaymentMethod.CREDIT_CARD,
        cardBrand: CardBrand.VISA,
        processorData: null,
        feeAmount: '10',
        netAmount: '990',
        feePercentage: '0.01',
      },
    ])
    ;(prisma.transactionCost.findMany as jest.Mock).mockResolvedValue([{ paymentId: 'p1', venueRate: '0.01' }])
    ;(prisma.venueTransaction.findMany as jest.Mock).mockResolvedValue([
      { paymentId: 'p1', feeAmount: '10', netAmount: '990', netSettlementAmount: '990' },
    ])
  })

  it('applies, writes 3 tables, records entry, logs, marks APPLIED', async () => {
    const batch = await applyRateCorrection(
      { venueId: 'v1', accountType: 'PRIMARY', newVenueRates, missingCostMode: 'FIX_PAYMENT_ONLY' },
      { staffId: 's1' },
    )
    expect(prisma.rateCorrectionBatch.create).toHaveBeenCalled()
    expect(tx.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1' },
        data: expect.objectContaining({ feeAmount: expect.any(Number), netAmount: expect.any(Number), feePercentage: expect.any(Number) }),
      }),
    )
    expect(tx.venueTransaction.update).toHaveBeenCalled()
    expect(tx.transactionCost.update).toHaveBeenCalled()
    expect(tx.rateCorrectionEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([expect.objectContaining({ beforeFeeAmount: 10, afterFeeAmount: 55 })]),
      }),
    )
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'RATE_CORRECTION_APPLIED', entityId: 'b1' }))
    expect(prisma.rateCorrectionBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'APPLIED' }) }),
    )
    expect(batch).toBeDefined()
  })

  it('rejects scopes over 500 payments', async () => {
    ;(prisma.payment.findMany as jest.Mock).mockResolvedValue(
      Array.from({ length: 501 }, (_, i) => ({
        id: `p${i}`,
        amount: '1',
        tipAmount: '0',
        method: PaymentMethod.CREDIT_CARD,
        cardBrand: CardBrand.VISA,
        processorData: null,
        feeAmount: '0',
        netAmount: '1',
        feePercentage: '0',
      })),
    )
    ;(prisma.transactionCost.findMany as jest.Mock).mockResolvedValue([])
    await expect(
      applyRateCorrection({ venueId: 'v1', accountType: 'PRIMARY', newVenueRates, missingCostMode: 'FIX_PAYMENT_ONLY' }, { staffId: 's1' }),
    ).rejects.toThrow(/500/)
  })

  it('rejects CREATE_COST when no provider cost structure', async () => {
    ;(prisma.providerCostStructure.findFirst as jest.Mock).mockResolvedValue(null)
    await expect(
      applyRateCorrection({ venueId: 'v1', accountType: 'PRIMARY', newVenueRates, missingCostMode: 'CREATE_COST' }, { staffId: 's1' }),
    ).rejects.toThrow()
  })
})
