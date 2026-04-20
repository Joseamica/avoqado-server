/**
 * Backfill DigitalReceipts for REFUND payments that don't have one.
 *
 * Context: Before 2026-04-18, the dashboard `issueRefund` service did not
 * auto-generate DigitalReceipt. Those pre-fix refunds lack a receipt. This
 * script finds them and calls the same generation function used in-line now.
 *
 * Usage:
 *   npx tsx scripts/backfill-missing-refund-receipts.ts                 # dry-run
 *   npx tsx scripts/backfill-missing-refund-receipts.ts --execute
 */

import prisma from '../src/utils/prismaClient'
import { generateAndStoreReceipt } from '../src/services/dashboard/receipt.dashboard.service'
import logger from '../src/config/logger'

async function main() {
  const execute = process.argv.includes('--execute')
  logger.info(`[BACKFILL-RECEIPTS] mode=${execute ? 'EXECUTE' : 'DRY-RUN'}`)

  const orphans = await prisma.payment.findMany({
    where: { type: 'REFUND', receipts: { none: {} } },
    select: { id: true, venueId: true, amount: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`\nFound ${orphans.length} REFUND payments without DigitalReceipt:`)
  for (const p of orphans) {
    console.log(`  ${p.id}  amount=${p.amount}  createdAt=${p.createdAt.toISOString()}`)
  }

  if (!execute || orphans.length === 0) {
    console.log('\n' + (execute ? 'Nothing to do.' : '[DRY-RUN] Re-run with --execute to generate receipts.'))
    await prisma.$disconnect()
    return
  }

  let ok = 0
  let failed = 0
  for (const p of orphans) {
    try {
      await generateAndStoreReceipt(p.venueId, p.id)
      ok++
      console.log(`✅ ${p.id}`)
    } catch (e: any) {
      failed++
      console.log(`❌ ${p.id}: ${e?.message}`)
    }
  }
  console.log(`\nDone. ok=${ok} failed=${failed}`)
  await prisma.$disconnect()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
