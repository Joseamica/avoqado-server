import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { MOTIVO_EXCLUSION_DEL_PROTOCOLO, cobrosDelProtocolo } from '@/services/shared/cobroDelProtocolo'
import { MOTIVO_EXCLUSION_ORIGINAL_OCUPADO, bloquearLoteConOriginales } from '@/services/shared/candadosDelLote'

export async function reverseRateCorrection(batchId: string, ctx: { staffId: string | null }) {
  const batch = await prisma.rateCorrectionBatch.findUnique({
    where: { id: batchId },
    include: { entries: true },
  })
  if (!batch) throw new NotFoundError(`RateCorrectionBatch ${batchId} not found`)
  if (batch.status !== 'APPLIED') throw new BadRequestError(`Batch ${batchId} is ${batch.status}; only APPLIED batches can be reversed`)

  // Codex R12-4: un cobro que ya pertenece al protocolo de costo (también uno que entró DESPUÉS de aplicarse el lote —
  // acreditado y convergido) no se revierte: borrarle el costo o pisarle las proyecciones dejaría una obligación DONE sin
  // costo. Se decide bajo el mutex de los Payments, y lo apartado se explica.
  // Codex R15-2: los mismos candados que apply — ORIGINALES (NOWAIT, dentro y fuera del lote) → lote en `id ASC` → relectura —;
  // lo apartado por un original ocupado se queda como el lote lo dejó (explicado), no se espera a la unidad de costo.
  const excludedProtocolPaymentIds: string[] = []
  const excludedBusyPaymentIds: string[] = []
  await prisma.$transaction(
    async tx => {
      const ids = batch.entries.map(e => e.paymentId)
      const candados = await bloquearLoteConOriginales(tx, { venueId: batch.venueId, paymentIds: ids })
      excludedBusyPaymentIds.push(...candados.ocupados)
      const protocolo = await cobrosDelProtocolo(tx, candados.bloqueados)
      const reversibles = new Set(candados.bloqueados.filter(id => !protocolo.has(id)))
      for (const e of batch.entries) {
        if (protocolo.has(e.paymentId)) {
          excludedProtocolPaymentIds.push(e.paymentId)
          continue
        }
        if (!reversibles.has(e.paymentId)) continue
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
    },
    // Mismo motivo que applyRateCorrection: la transacción interactiva default de
    // Prisma aborta a los 5s. Contra la DB remota, cientos de updates secuenciales
    // (≤200 pagos) superan ese límite y hacen rollback con "Transaction not found".
    { timeout: 120_000, maxWait: 10_000 },
  )

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
    data: {
      paymentCount: batch.entries.length - excludedProtocolPaymentIds.length - excludedBusyPaymentIds.length,
      excludedProtocolCount: excludedProtocolPaymentIds.length,
      excludedProtocolPaymentIds,
      excludedProtocolReason: MOTIVO_EXCLUSION_DEL_PROTOCOLO,
      excludedBusyCount: excludedBusyPaymentIds.length,
      excludedBusyPaymentIds,
      excludedBusyReason: MOTIVO_EXCLUSION_ORIGINAL_OCUPADO,
    },
  })

  return {
    ...reversed,
    excludedProtocolCount: excludedProtocolPaymentIds.length,
    excludedProtocolPaymentIds,
    excludedProtocolReason: MOTIVO_EXCLUSION_DEL_PROTOCOLO,
    excludedBusyCount: excludedBusyPaymentIds.length,
    excludedBusyPaymentIds,
    excludedBusyReason: MOTIVO_EXCLUSION_ORIGINAL_OCUPADO,
  }
}
