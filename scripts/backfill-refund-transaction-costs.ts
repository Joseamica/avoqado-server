/**
 * Backfill TransactionCost records for existing refunds
 *
 * This script finds all refund payments that don't have a TransactionCost record
 * and creates negative TransactionCost records based on the original payment's costs.
 *
 * Usage:
 *   npx ts-node scripts/backfill-refund-transaction-costs.ts
 *
 * Or with dry-run:
 *   DRY_RUN=true npx ts-node scripts/backfill-refund-transaction-costs.ts
 */

import prisma from '../src/utils/prismaClient'

const DRY_RUN = process.env.DRY_RUN === 'true'

async function backfillRefundTransactionCosts() {
  console.log(`\n${'='.repeat(60)}`)
  console.log('Backfill Refund TransactionCost Records')
  console.log(`${'='.repeat(60)}`)
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE (changes will be made)'}\n`)

  // Find all refund payments without TransactionCost
  const refundsWithoutCost = await prisma.payment.findMany({
    where: {
      type: 'REFUND',
      transactionCost: null,
    },
    include: {
      venue: true,
    },
  })

  console.log(`Found ${refundsWithoutCost.length} refund payments without TransactionCost\n`)

  if (refundsWithoutCost.length === 0) {
    console.log('✅ All refunds already have TransactionCost records!')
    return
  }

  let successCount = 0
  let skipCount = 0
  let errorCount = 0

  for (const refund of refundsWithoutCost) {
    console.log(`\nProcessing refund: ${refund.id}`)
    console.log(`  Venue: ${refund.venue.name}`)
    console.log(`  Amount: ${refund.amount}`)
    console.log(`  Created: ${refund.createdAt}`)

    // Get originalPaymentId from processorData
    const processorData = refund.processorData as Record<string, unknown> | null
    const originalPaymentId = processorData?.originalPaymentId as string | undefined

    if (!originalPaymentId) {
      console.log('  ⚠️  No originalPaymentId in processorData, skipping')
      skipCount++
      continue
    }

    console.log(`  Original Payment: ${originalPaymentId}`)

    // Find original payment's TransactionCost
    const originalTransactionCost = await prisma.transactionCost.findUnique({
      where: { paymentId: originalPaymentId },
    })

    if (!originalTransactionCost) {
      console.log('  ⚠️  Original payment has no TransactionCost, skipping')
      skipCount++
      continue
    }

    // Calculate refund ratio for partial refunds
    const originalAmount = parseFloat(originalTransactionCost.amount.toString())
    const refundAmount = Math.abs(parseFloat(refund.amount.toString()))
    const refundRatio = originalAmount > 0 ? refundAmount / originalAmount : 1

    console.log(`  Original amount: ${originalAmount}`)
    console.log(`  Refund amount: ${refundAmount}`)
    console.log(`  Refund ratio: ${(refundRatio * 100).toFixed(1)}%`)

    const negativeGrossProfit = -(parseFloat(originalTransactionCost.grossProfit.toString()) * refundRatio)
    console.log(`  Negative gross profit: ${negativeGrossProfit.toFixed(4)}`)

    if (DRY_RUN) {
      console.log('  [DRY RUN] Would create TransactionCost')
      successCount++
    } else {
      try {
        const refundTransactionCost = await prisma.transactionCost.create({
          data: {
            paymentId: refund.id,
            merchantAccountId: originalTransactionCost.merchantAccountId,
            transactionType: originalTransactionCost.transactionType,
            amount: -refundAmount,
            providerRate: originalTransactionCost.providerRate,
            providerCostAmount: -(parseFloat(originalTransactionCost.providerCostAmount.toString()) * refundRatio),
            providerFixedFee: refundRatio === 1 ? -parseFloat(originalTransactionCost.providerFixedFee.toString()) : 0,
            providerCostStructureId: originalTransactionCost.providerCostStructureId,
            venueRate: originalTransactionCost.venueRate,
            venueChargeAmount: -(parseFloat(originalTransactionCost.venueChargeAmount.toString()) * refundRatio),
            venueFixedFee: refundRatio === 1 ? -parseFloat(originalTransactionCost.venueFixedFee.toString()) : 0,
            venuePricingStructureId: originalTransactionCost.venuePricingStructureId,
            grossProfit: negativeGrossProfit,
            profitMargin: parseFloat(originalTransactionCost.profitMargin.toString()),
          },
        })
        console.log(`  ✅ Created TransactionCost: ${refundTransactionCost.id}`)
        successCount++
      } catch (error) {
        console.log(`  ❌ Error: ${error}`)
        errorCount++
      }
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log('Summary:')
  console.log(`  ✅ Success: ${successCount}`)
  console.log(`  ⚠️  Skipped: ${skipCount}`)
  console.log(`  ❌ Errors: ${errorCount}`)
  console.log(`${'='.repeat(60)}\n`)
}

backfillRefundTransactionCosts()
  .then(() => {
    console.log('Done!')
    process.exit(0)
  })
  .catch(error => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
