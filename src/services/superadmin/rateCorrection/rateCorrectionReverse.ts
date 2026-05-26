import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'

export async function reverseRateCorrection(batchId: string, ctx: { staffId: string | null }) {
  const batch = await prisma.rateCorrectionBatch.findUnique({
    where: { id: batchId },
    include: { entries: true },
  })
  if (!batch) throw new NotFoundError(`RateCorrectionBatch ${batchId} not found`)
  if (batch.status !== 'APPLIED') throw new BadRequestError(`Batch ${batchId} is ${batch.status}; only APPLIED batches can be reversed`)

  await prisma.$transaction(async tx => {
    for (const e of batch.entries) {
      await tx.payment.update({
        where: { id: e.paymentId },
        data: {
          feeAmount: Number(e.beforeFeeAmount),
          netAmount: Number(e.beforeNetAmount),
          feePercentage: Number(e.beforeFeePercentage),
        },
      })

      if (e.beforeVenueTxnFee !== null && e.beforeVenueTxnFee !== undefined) {
        await tx.venueTransaction.update({
          where: { paymentId: e.paymentId },
          data: {
            feeAmount: Number(e.beforeVenueTxnFee),
            netAmount: e.beforeVenueTxnNet != null ? Number(e.beforeVenueTxnNet) : undefined,
            netSettlementAmount: e.beforeVenueTxnNetSettlement != null ? Number(e.beforeVenueTxnNetSettlement) : undefined,
          },
        })
      }

      if (e.costCreated) {
        await tx.transactionCost.delete({ where: { paymentId: e.paymentId } })
      } else if (e.beforeCostJson) {
        const c = e.beforeCostJson as any
        await tx.transactionCost.update({
          where: { paymentId: e.paymentId },
          data: {
            venueRate: Number(c.venueRate),
            venueChargeAmount: Number(c.venueChargeAmount),
            venueFixedFee: Number(c.venueFixedFee),
            providerRate: Number(c.providerRate),
            providerCostAmount: Number(c.providerCostAmount),
            providerFixedFee: Number(c.providerFixedFee),
            grossProfit: Number(c.grossProfit),
            profitMargin: Number(c.profitMargin),
          },
        })
      }
    }
  })

  const reversed = await prisma.rateCorrectionBatch.update({
    where: { id: batchId },
    data: { status: 'REVERSED', reversedById: ctx.staffId, reversedAt: new Date() },
  })

  await logAction({
    staffId: ctx.staffId,
    venueId: batch.venueId,
    action: 'RATE_CORRECTION_REVERSED',
    entity: 'RateCorrectionBatch',
    entityId: batchId,
    data: { paymentCount: batch.entries.length },
  })

  return reversed
}
