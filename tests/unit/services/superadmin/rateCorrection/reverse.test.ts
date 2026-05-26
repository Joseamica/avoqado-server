const tx = {
  payment: { update: jest.fn() },
  venueTransaction: { update: jest.fn() },
  transactionCost: { update: jest.fn(), delete: jest.fn() },
}

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    rateCorrectionBatch: { findUnique: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(async cb => cb(tx)),
  },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { reverseRateCorrection } from '@/services/superadmin/rateCorrection/rateCorrectionReverse'

describe('reverseRateCorrection', () => {
  beforeEach(() => jest.clearAllMocks())

  it('restores before-values and marks REVERSED', async () => {
    ;(prisma.rateCorrectionBatch.findUnique as jest.Mock).mockResolvedValue({
      id: 'b1',
      venueId: 'v1',
      status: 'APPLIED',
      entries: [
        {
          paymentId: 'p1',
          beforeFeeAmount: '10',
          beforeNetAmount: '990',
          beforeFeePercentage: '0.01',
          beforeVenueTxnFee: '10',
          beforeVenueTxnNet: '990',
          beforeVenueTxnNetSettlement: '990',
          costCreated: false,
          beforeCostJson: {
            venueRate: '0.01',
            venueChargeAmount: '10',
            venueFixedFee: '0',
            providerRate: '0.005',
            providerCostAmount: '5',
            providerFixedFee: '0',
            grossProfit: '5',
            profitMargin: '0.5',
          },
        },
      ],
    })
    ;(prisma.rateCorrectionBatch.update as jest.Mock).mockResolvedValue({ id: 'b1', status: 'REVERSED' })

    await reverseRateCorrection('b1', { staffId: 's1' })

    expect(tx.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1' },
        data: expect.objectContaining({ feeAmount: 10, netAmount: 990 }),
      }),
    )
    expect(tx.transactionCost.update).toHaveBeenCalled()
    expect(tx.transactionCost.delete).not.toHaveBeenCalled()
    expect(prisma.rateCorrectionBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REVERSED' }) }),
    )
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'RATE_CORRECTION_REVERSED' }))
  })

  it('deletes cost rows it created', async () => {
    ;(prisma.rateCorrectionBatch.findUnique as jest.Mock).mockResolvedValue({
      id: 'b1',
      venueId: 'v1',
      status: 'APPLIED',
      entries: [
        {
          paymentId: 'p2',
          beforeFeeAmount: '0',
          beforeNetAmount: '100',
          beforeFeePercentage: '0',
          beforeVenueTxnFee: null,
          beforeVenueTxnNet: null,
          beforeVenueTxnNetSettlement: null,
          costCreated: true,
          beforeCostJson: null,
        },
      ],
    })
    ;(prisma.rateCorrectionBatch.update as jest.Mock).mockResolvedValue({ id: 'b1', status: 'REVERSED' })

    await reverseRateCorrection('b1', { staffId: 's1' })

    expect(tx.transactionCost.delete).toHaveBeenCalledWith({ where: { paymentId: 'p2' } })
  })

  it('throws when batch is not APPLIED', async () => {
    ;(prisma.rateCorrectionBatch.findUnique as jest.Mock).mockResolvedValue({
      id: 'b1',
      status: 'REVERSED',
      entries: [],
    })

    await expect(reverseRateCorrection('b1', { staffId: 's1' })).rejects.toThrow()
  })
})
