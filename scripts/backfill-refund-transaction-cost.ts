/**
 * Backfill TransactionCost for REFUND Payments that are missing one.
 *
 * Context: Before 2026-04-20, the dashboard refund service did NOT call
 * `createRefundTransactionCost` (TPV already did). This meant dashboard-
 * originated refunds were invisible to reports that INNER JOIN Payment with
 * TransactionCost (moneygiver-settlement, availableBalance per-card-type).
 *
 * This script finds REFUND Payments whose ORIGINAL payment had a
 * TransactionCost but the refund itself does not, and creates the reversal.
 *
 * Usage:
 *   npx tsx scripts/backfill-refund-transaction-cost.ts             # dry-run
 *   npx tsx scripts/backfill-refund-transaction-cost.ts --execute
 */

import prisma from '../src/utils/prismaClient'
import { createRefundTransactionCost } from '../src/services/payments/transactionCost.service'
import logger from '../src/config/logger'

async function main() {
  const execute = process.argv.includes('--execute')
  logger.info(`[BACKFILL-TXCOST] mode=${execute ? 'EXECUTE' : 'DRY-RUN'}`)

  const candidates = await prisma.payment.findMany({
    where: {
      type: 'REFUND',
      // refund has no TransactionCost row attached
      transactionCost: null,
    },
    select: { id: true, amount: true, processorData: true, createdAt: true, venueId: true },
    orderBy: { createdAt: 'asc' },
  })

  const eligible: Array<{ id: string; originalId: string; amount: number; venueId: string }> = []

  for (const r of candidates) {
    const pd = (r.processorData as Record<string, unknown> | null) ?? {}
    const originalId = typeof pd.originalPaymentId === 'string' ? pd.originalPaymentId : null
    if (!originalId) continue
    // Only refund if the ORIGINAL had a TransactionCost to revert
    const origHasCost = await prisma.transactionCost.findUnique({
      where: { paymentId: originalId },
      select: { id: true },
    })
    if (!origHasCost) continue
    eligible.push({ id: r.id, originalId, amount: Number(r.amount), venueId: r.venueId })
  }

  console.log(`\nFound ${eligible.length} refunds needing TransactionCost revert (of ${candidates.length} total candidates)`)
  for (const e of eligible) {
    console.log(`  ${e.id}  venue=${e.venueId} amount=${e.amount} original=${e.originalId}`)
  }

  if (!execute || eligible.length === 0) {
    console.log(execute ? '\nNothing to do.' : '\n[DRY-RUN] Re-run with --execute to apply.')
    await prisma.$disconnect()
    return
  }

  let ok = 0
  let failed = 0
  for (const e of eligible) {
    try {
      await createRefundTransactionCost(e.id, e.originalId)
      ok++
      console.log(`✅ ${e.id}`)
    } catch (err: any) {
      failed++
      console.log(`❌ ${e.id}: ${err?.message}`)
    }
  }
  console.log(`\nDone. ok=${ok} failed=${failed}`)
  await prisma.$disconnect()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
