import { PaymentMethod, CardBrand } from '@prisma/client'

const tx = {
  payment: { update: jest.fn() },
  venueTransaction: { update: jest.fn() },
  transactionCost: { update: jest.fn(), createMany: jest.fn(), delete: jest.fn() },
  rateCorrectionEntry: { createMany: jest.fn() },
}
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venuePaymentConfig: { findUnique: jest.fn() },
    payment: { findMany: jest.fn() },
    transactionCost: { findMany: jest.fn() },
    venueTransaction: { findMany: jest.fn() },
    providerCostStructure: { findFirst: jest.fn() },
    venuePricingStructure: { findFirst: jest.fn() },
    merchantAccount: { findUniqueOrThrow: jest.fn() },
    rateCorrectionBatch: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
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
import { getActivePricingStructure } from '@/services/superadmin/venuePricing.service'
import { applyRateCorrection } from '@/services/superadmin/rateCorrection/rateCorrectionApply'
import { reverseRateCorrection } from '@/services/superadmin/rateCorrection/rateCorrectionReverse'

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

describe('apply → reverse round trip', () => {
  it('reverse restores exactly the before-values apply recorded', async () => {
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
    ;(prisma.transactionCost.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'tc1',
        paymentId: 'p1',
        venueRate: '0.01',
        venueChargeAmount: '10',
        venueFixedFee: '0',
        providerRate: '0.005',
        providerCostAmount: '5',
        providerFixedFee: '0',
        grossProfit: '5',
        profitMargin: '0.5',
      },
    ])
    ;(prisma.venueTransaction.findMany as jest.Mock).mockResolvedValue([
      { paymentId: 'p1', feeAmount: '10', netAmount: '990', netSettlementAmount: '990' },
    ])

    await applyRateCorrection(
      { venueId: 'v1', accountType: 'PRIMARY', newVenueRates, missingCostMode: 'FIX_PAYMENT_ONLY' },
      { staffId: 's1' },
    )

    // apply wrote the recomputed fee (55) and recorded before (10)
    const applyWrite = (tx.payment.update as jest.Mock).mock.calls[0][0].data
    expect(applyWrite.feeAmount).toBeCloseTo(55, 6)
    // entries are batched via createMany → data is an array
    const recordedEntry = (tx.rateCorrectionEntry.createMany as jest.Mock).mock.calls[0][0].data[0]
    expect(recordedEntry.beforeFeeAmount).toBe(10)
    expect(recordedEntry.beforeNetAmount).toBe(990)

    // feed that exact entry into reverse (do NOT clear mocks — $transaction impl must stay)
    ;(prisma.rateCorrectionBatch.findUnique as jest.Mock).mockResolvedValue({
      id: 'b1',
      venueId: 'v1',
      status: 'APPLIED',
      entries: [recordedEntry],
    })
    ;(prisma.rateCorrectionBatch.update as jest.Mock).mockResolvedValue({ id: 'b1', status: 'REVERSED' })

    await reverseRateCorrection('b1', { staffId: 's1' })

    // reverse's payment.update is the SECOND call on the shared tx stub → restores 10/990
    const reverseWrite = (tx.payment.update as jest.Mock).mock.calls[1][0].data
    expect(reverseWrite.feeAmount).toBe(10)
    expect(reverseWrite.netAmount).toBe(990)
  })
})
