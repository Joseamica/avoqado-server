import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  getActivePricingStructure,
  updateVenuePricingStructure,
  createVenuePricingStructure,
} from '@/services/superadmin/venuePricing.service'
import { previewRateCorrection, recomputePaymentEconomics, PreviewArgs } from './rateCorrectionPreview'
import { buildScopeWhere } from './rateCorrectionScope'
import { RateStructureLike } from './rateRecompute'

/**
 * Arguments for applying a rate correction — identical shape to a preview run.
 * The apply path first previews (for guards + counts), then mutates payments,
 * venueTransactions and transactionCosts inside a single DB transaction, and
 * records a per-payment audit trail in rateCorrectionEntry rows.
 */
export type ApplyArgs = PreviewArgs

export interface ApplyContext {
  staffId: string | null
}

export async function applyRateCorrection(args: ApplyArgs, ctx: ApplyContext) {
  // 1. Preview first — gives us counts, the resolved merchant account, and the
  //    availability flags the guards below depend on.
  const preview = await previewRateCorrection(args)

  // 2. Guards.
  if (preview.inScopeCount > 500) {
    throw new BadRequestError(`Rate correction scope has ${preview.inScopeCount} payments (limit is 500). Please narrow the date range.`)
  }
  if (args.missingCostMode === 'CREATE_COST' && !preview.costStructureAvailable) {
    throw new BadRequestError('Cannot CREATE_COST: no provider cost structure available for this merchant account.')
  }
  if (!preview.venuePricingAvailable) {
    throw new BadRequestError('Cannot apply rate correction: no effective venue pricing structure available.')
  }

  // 3. Resolve the merchant account + read the current active structures (snapshots).
  const merchantAccountId = preview.merchantAccountId
  const activeVenue = await getActivePricingStructure(args.venueId, args.accountType)
  const activeProvider = await prisma.providerCostStructure.findFirst({
    where: { merchantAccountId, active: true },
    orderBy: { effectiveFrom: 'desc' },
  })

  // 4. Build before/after snapshots stored as plain JSON on the batch.
  const oldRates = { venue: activeVenue ?? null, provider: activeProvider ?? null }
  const newRates = {
    venue: args.newVenueRates ?? activeVenue ?? null,
    provider: args.newProviderRates ?? activeProvider ?? null,
  }

  // 5. Update the live structures so future payments compute with the new rates.
  if (args.newVenueRates) {
    if (activeVenue) {
      await updateVenuePricingStructure(activeVenue.id, {
        debitRate: Number(args.newVenueRates.debitRate),
        creditRate: Number(args.newVenueRates.creditRate),
        amexRate: Number(args.newVenueRates.amexRate),
        internationalRate: Number(args.newVenueRates.internationalRate),
        includesTax: args.newVenueRates.includesTax ?? undefined,
        taxRate: args.newVenueRates.taxRate != null ? Number(args.newVenueRates.taxRate) : undefined,
        fixedFeePerTransaction:
          args.newVenueRates.fixedFeePerTransaction != null ? Number(args.newVenueRates.fixedFeePerTransaction) : undefined,
      })
    } else {
      // No pre-existing structure for this venue+accountType — e.g. a first-time
      // retroactive correction on a venue that never had pricing configured (see
      // Alba Outlet de Muebles, 2026-07-06). Without this branch the historical
      // payments get corrected below but future payments keep hitting "no active
      // venue pricing structure found" forever, since nothing ever gets CREATEd.
      await createVenuePricingStructure({
        venueId: args.venueId,
        accountType: args.accountType,
        effectiveFrom: new Date(),
        debitRate: Number(args.newVenueRates.debitRate),
        creditRate: Number(args.newVenueRates.creditRate),
        amexRate: Number(args.newVenueRates.amexRate),
        internationalRate: Number(args.newVenueRates.internationalRate),
        includesTax: args.newVenueRates.includesTax ?? undefined,
        taxRate: args.newVenueRates.taxRate != null ? Number(args.newVenueRates.taxRate) : undefined,
        fixedFeePerTransaction:
          args.newVenueRates.fixedFeePerTransaction != null ? Number(args.newVenueRates.fixedFeePerTransaction) : undefined,
      })
    }
  }

  if (args.newProviderRates) {
    // Inline deactivate-and-create — NOT the dead-code updateProviderCosts (which lacks includesTax).
    const { providerId } = await prisma.merchantAccount.findUniqueOrThrow({
      where: { id: merchantAccountId },
      select: { providerId: true },
    })
    await prisma.providerCostStructure.updateMany({
      where: { merchantAccountId, active: true },
      data: { active: false, effectiveTo: new Date() },
    })
    await prisma.providerCostStructure.create({
      data: {
        merchantAccountId,
        providerId,
        debitRate: Number(args.newProviderRates.debitRate),
        creditRate: Number(args.newProviderRates.creditRate),
        amexRate: Number(args.newProviderRates.amexRate),
        internationalRate: Number(args.newProviderRates.internationalRate),
        includesTax: args.newProviderRates.includesTax ?? null,
        taxRate: args.newProviderRates.taxRate != null ? Number(args.newProviderRates.taxRate) : 0.16,
        fixedCostPerTransaction:
          args.newProviderRates.fixedCostPerTransaction != null ? Number(args.newProviderRates.fixedCostPerTransaction) : null,
        effectiveFrom: new Date(),
        active: true,
      },
    })
  }

  // 6. Effective rates used to recompute the in-scope (historical) payments.
  const effVenue: RateStructureLike | null = args.newVenueRates ?? (activeVenue as RateStructureLike | null)
  const effProvider: RateStructureLike | null = args.newProviderRates ?? (activeProvider as RateStructureLike | null)

  // 7. Create the batch in PENDING — the per-payment work below references its id.
  const batch = await prisma.rateCorrectionBatch.create({
    data: {
      venueId: args.venueId,
      merchantAccountId,
      accountType: args.accountType,
      // Json input types: Prisma's InputJsonValue rejects Decimal-bearing rows; snapshots are plain.
      oldRates: oldRates as any,
      newRates: newRates as any,
      dateFrom: args.dateFrom ?? null,
      dateTo: args.dateTo ?? null,
      missingCostMode: args.missingCostMode,
      status: 'PENDING',
    },
  })

  try {
    // 8. Load the in-scope payments + BULK-prefetch their existing TransactionCost
    //    and VenueTransaction rows. Reading in 2 findMany (instead of 2 findUnique
    //    PER payment inside the transaction) keeps the interactive transaction short:
    //    long transactions time out against a remote DB. Same data, fewer round-trips.
    const payments = await prisma.payment.findMany({
      where: buildScopeWhere({ venueId: args.venueId, merchantAccountId, dateFrom: args.dateFrom, dateTo: args.dateTo }),
      select: {
        id: true,
        amount: true,
        tipAmount: true,
        method: true,
        cardBrand: true,
        processorData: true,
        feeAmount: true,
        netAmount: true,
        feePercentage: true,
      },
    })

    const paymentIds = payments.map(p => p.id)
    const [existingCosts, existingVts] = await Promise.all([
      prisma.transactionCost.findMany({ where: { paymentId: { in: paymentIds } } }),
      prisma.venueTransaction.findMany({ where: { paymentId: { in: paymentIds } } }),
    ])
    const costByPayment = new Map(existingCosts.map(c => [c.paymentId, c]))
    const vtByPayment = new Map(existingVts.map(v => [v.paymentId, v]))

    // Pre-compute everything (pure, no DB) so the transaction only does writes.
    let costCreatedCount = 0
    let estimatedImpact = 0
    const entryRows: Array<Record<string, unknown>> = []
    const paymentUpdates: Array<{ id: string; feeAmount: number; netAmount: number; feePercentage: number }> = []
    const vtUpdates: Array<{ paymentId: string; feeAmount: number; netAmount: number; netSettlementAmount: number }> = []
    const costUpdates: Array<{ paymentId: string; data: Record<string, number> }> = []
    const costCreates: Array<Record<string, unknown>> = []

    for (const p of payments) {
      const { transactionType, after } = recomputePaymentEconomics(p, effVenue!, effProvider)
      const beforeFee = parseFloat(p.feeAmount.toString())
      estimatedImpact += after.feeAmount - beforeFee

      const existingCost = costByPayment.get(p.id)
      const existingVt = vtByPayment.get(p.id)
      const willCreateCost = !existingCost && args.missingCostMode === 'CREATE_COST'

      entryRows.push({
        batchId: batch.id,
        paymentId: p.id,
        beforeFeeAmount: beforeFee,
        beforeNetAmount: parseFloat(p.netAmount.toString()),
        beforeFeePercentage: parseFloat(p.feePercentage.toString()),
        beforeVenueTxnFee: existingVt ? parseFloat(existingVt.feeAmount.toString()) : null,
        beforeVenueTxnNet: existingVt ? parseFloat(existingVt.netAmount.toString()) : null,
        beforeVenueTxnNetSettlement: existingVt?.netSettlementAmount != null ? parseFloat(existingVt.netSettlementAmount.toString()) : null,
        costCreated: willCreateCost,
        // Json input: a TransactionCost row carries Decimals; store as-is for the audit trail.
        beforeCostJson: (existingCost ?? null) as unknown,
        afterFeeAmount: after.feeAmount,
        afterNetAmount: after.netAmount,
        afterFeePercentage: after.venueRate,
      })

      paymentUpdates.push({ id: p.id, feeAmount: after.feeAmount, netAmount: after.netAmount, feePercentage: after.venueRate })

      if (existingVt) {
        vtUpdates.push({
          paymentId: p.id,
          feeAmount: after.feeAmount,
          netAmount: after.netAmount,
          netSettlementAmount: after.netAmount,
        })
      }

      if (existingCost) {
        costUpdates.push({
          paymentId: p.id,
          data: {
            venueRate: after.venueRate,
            venueChargeAmount: after.venueChargeAmount,
            venueFixedFee: after.venueFixedFee,
            providerRate: after.providerRate,
            providerCostAmount: after.providerCostAmount,
            providerFixedFee: after.providerFixedFee,
            grossProfit: after.grossProfit,
            profitMargin: after.profitMargin,
          },
        })
      } else if (args.missingCostMode === 'CREATE_COST') {
        costCreates.push({
          paymentId: p.id,
          merchantAccountId,
          transactionType,
          amount: parseFloat(p.amount.toString()) + parseFloat(p.tipAmount?.toString() || '0'),
          venueRate: after.venueRate,
          venueChargeAmount: after.venueChargeAmount,
          venueFixedFee: after.venueFixedFee,
          providerRate: after.providerRate,
          providerCostAmount: after.providerCostAmount,
          providerFixedFee: after.providerFixedFee,
          grossProfit: after.grossProfit,
          profitMargin: after.profitMargin,
          providerCostStructureId: activeProvider?.id,
          venuePricingStructureId: activeVenue?.id,
        })
        costCreatedCount++
      }
    }

    // 9. Write everything in one transaction. Audit entries and any new cost rows
    //    batch into a single createMany each; the 3 snapshot tables need per-row
    //    values so they stay per-row updates — but with reads pre-fetched and entries
    //    batched, the transaction is far shorter. Timeout raised for safety.
    await prisma.$transaction(
      async tx => {
        if (entryRows.length) await tx.rateCorrectionEntry.createMany({ data: entryRows as never })
        if (costCreates.length) await tx.transactionCost.createMany({ data: costCreates as never })
        for (const u of paymentUpdates) {
          await tx.payment.update({
            where: { id: u.id },
            data: { feeAmount: u.feeAmount, netAmount: u.netAmount, feePercentage: u.feePercentage },
          })
        }
        for (const u of vtUpdates) {
          await tx.venueTransaction.update({
            where: { paymentId: u.paymentId },
            data: { feeAmount: u.feeAmount, netAmount: u.netAmount, netSettlementAmount: u.netSettlementAmount },
          })
        }
        for (const u of costUpdates) {
          await tx.transactionCost.update({ where: { paymentId: u.paymentId }, data: u.data })
        }
      },
      // Even shorter now, but keep a generous budget: remote DB × per-row updates.
      { timeout: 120_000, maxWait: 10_000 },
    )

    // 10. Finalize the batch.
    const applied = await prisma.rateCorrectionBatch.update({
      where: { id: batch.id },
      data: {
        status: 'APPLIED',
        paymentCount: payments.length,
        costCreatedCount,
        estimatedImpact,
        appliedById: ctx.staffId,
        appliedAt: new Date(),
      },
    })

    // 11. Audit trail (best-effort).
    await logAction({
      staffId: ctx.staffId,
      venueId: args.venueId,
      action: 'RATE_CORRECTION_APPLIED',
      entity: 'RateCorrectionBatch',
      entityId: batch.id,
      data: {
        merchantAccountId,
        accountType: args.accountType,
        // Json input types: snapshots are plain JSON built above.
        oldRates: oldRates as any,
        newRates: newRates as any,
        paymentCount: payments.length,
        costCreatedCount,
        estimatedImpact,
      },
    })

    // 12.
    return applied
  } catch (err) {
    await prisma.rateCorrectionBatch.update({
      where: { id: batch.id },
      data: { status: 'FAILED', failureReason: err instanceof Error ? err.message : 'Unknown error' },
    })
    throw err
  }
}
