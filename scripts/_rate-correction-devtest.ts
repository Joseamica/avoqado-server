/**
 * THROWAWAY dev verification for the retroactive rate-correction feature.
 * Runs the REAL service functions against the LOCAL av-db-25 DB, then fully
 * restores everything it changed. Delete this file after running.
 *
 *   npx tsx scripts/_rate-correction-devtest.ts
 */
import prisma from '@/utils/prismaClient'
import { previewRateCorrection } from '@/services/superadmin/rateCorrection/rateCorrectionPreview'
import { applyRateCorrection } from '@/services/superadmin/rateCorrection/rateCorrectionApply'
import { reverseRateCorrection } from '@/services/superadmin/rateCorrection/rateCorrectionReverse'
import { buildScopeWhere } from '@/services/superadmin/rateCorrection/rateCorrectionScope'

const VENUE_NAME = 'Avoqado Full'
const dateFrom = new Date('2026-05-19T00:00:00.000Z')
const dateTo = new Date('2026-05-20T00:00:00.000Z')
const NEW_RATES = { debitRate: 0.05, creditRate: 0.05, amexRate: 0.05, internationalRate: 0.05, includesTax: true, taxRate: 0.16 }

const sel = {
  id: true,
  feeAmount: true,
  netAmount: true,
  feePercentage: true,
  transaction: { select: { feeAmount: true, netAmount: true, netSettlementAmount: true } },
  transactionCost: { select: { venueRate: true, venueChargeAmount: true, grossProfit: true, profitMargin: true } },
} as const

const n = (x: any) => (x == null ? null : Number(x))
const snap = (p: any) => ({
  id: p.id,
  fee: n(p.feeAmount),
  net: n(p.netAmount),
  pct: n(p.feePercentage),
  vtFee: n(p.transaction?.feeAmount),
  vtNet: n(p.transaction?.netAmount),
  vtNetSettle: n(p.transaction?.netSettlementAmount),
  tcRate: n(p.transactionCost?.venueRate),
  tcGross: n(p.transactionCost?.grossProfit),
})

let failures = 0
function check(label: string, cond: boolean) {
  console.log(`${cond ? '✅' : '❌'} ${label}`)
  if (!cond) failures++
}

async function main() {
  const venue = await prisma.venue.findFirstOrThrow({ where: { name: VENUE_NAME } })
  const cfg = await prisma.venuePaymentConfig.findUniqueOrThrow({ where: { venueId: venue.id } })
  const vps = await prisma.venuePricingStructure.findFirstOrThrow({
    where: { venueId: venue.id, accountType: 'PRIMARY', active: true },
  })
  const originalRates = {
    debitRate: Number(vps.debitRate),
    creditRate: Number(vps.creditRate),
    amexRate: Number(vps.amexRate),
    internationalRate: Number(vps.internationalRate),
    includesTax: vps.includesTax,
    taxRate: Number(vps.taxRate),
    fixedFeePerTransaction: vps.fixedFeePerTransaction != null ? Number(vps.fixedFeePerTransaction) : undefined,
  }
  console.log('\n=== SETUP ===')
  console.log('venue:', venue.id, '| merchantAccount:', cfg.primaryAccountId, '| vps:', vps.id)
  console.log('original rates:', originalRates)

  const where = buildScopeWhere({ venueId: venue.id, merchantAccountId: cfg.primaryAccountId, dateFrom, dateTo })
  const beforeRows = await prisma.payment.findMany({ where, select: sel, orderBy: { id: 'asc' } })
  const before = beforeRows.map(snap)
  console.log('\n=== BEFORE (in-scope payments) ===')
  console.log('count:', before.length)
  console.table(before)

  if (before.length === 0) throw new Error('No in-scope payments — adjust the date window')

  console.log('\n=== PREVIEW (read-only) ===')
  const preview = await previewRateCorrection({
    venueId: venue.id,
    accountType: 'PRIMARY',
    newVenueRates: NEW_RATES,
    dateFrom,
    dateTo,
    missingCostMode: 'FIX_PAYMENT_ONLY',
  })
  console.log(preview)
  check('preview.inScopeCount matches snapshot', preview.inScopeCount === before.length)
  // preview must NOT have changed anything
  const afterPreview = (await prisma.payment.findMany({ where, select: sel, orderBy: { id: 'asc' } })).map(snap)
  check('preview did NOT mutate payments', JSON.stringify(afterPreview) === JSON.stringify(before))

  console.log('\n=== APPLY ===')
  const batch = await applyRateCorrection(
    { venueId: venue.id, accountType: 'PRIMARY', newVenueRates: NEW_RATES, dateFrom, dateTo, missingCostMode: 'FIX_PAYMENT_ONLY' },
    { staffId: null },
  )
  console.log(
    'batch:',
    batch.id,
    '| status:',
    batch.status,
    '| paymentCount:',
    batch.paymentCount,
    '| impact:',
    Number(batch.estimatedImpact),
  )
  check('batch APPLIED', batch.status === 'APPLIED')
  check('batch.paymentCount matches scope', batch.paymentCount === before.length)

  const afterRows = await prisma.payment.findMany({ where: { id: { in: before.map(b => b.id) } }, select: sel, orderBy: { id: 'asc' } })
  const after = afterRows.map(snap)
  console.log('\n=== AFTER APPLY ===')
  console.table(after)
  // expected venue rate after = 0.05 (includesTax true -> as-is)
  check(
    'all fees changed',
    after.every((a, i) => a.fee !== before[i].fee),
  )
  check(
    '3-table consistency: Payment.fee === VenueTransaction.fee',
    after.every(a => a.vtFee === null || Math.abs((a.fee ?? 0) - (a.vtFee ?? 0)) < 0.005),
  )
  check(
    'Payment.net === VenueTransaction.net',
    after.every(a => a.vtNet === null || Math.abs((a.net ?? 0) - (a.vtNet ?? 0)) < 0.005),
  )
  check(
    'TransactionCost.venueRate === 0.05',
    after.every(a => a.tcRate === null || Math.abs((a.tcRate ?? 0) - 0.05) < 1e-9),
  )
  check(
    'Payment.feePercentage === 0.05',
    after.every(a => Math.abs((a.pct ?? 0) - 0.05) < 1e-9),
  )

  const entries = await prisma.rateCorrectionEntry.count({ where: { batchId: batch.id } })
  check('one RateCorrectionEntry per payment', entries === before.length)
  const logs = await prisma.activityLog.findMany({ where: { entityId: batch.id }, select: { action: true } })
  check(
    'ActivityLog RATE_CORRECTION_APPLIED written',
    logs.some(l => l.action === 'RATE_CORRECTION_APPLIED'),
  )

  console.log('\n=== REVERSE ===')
  const rev = await reverseRateCorrection(batch.id, { staffId: null })
  check('batch REVERSED', rev.status === 'REVERSED')

  const restoredRows = await prisma.payment.findMany({ where: { id: { in: before.map(b => b.id) } }, select: sel, orderBy: { id: 'asc' } })
  const restored = restoredRows.map(snap)
  console.log('\n=== AFTER REVERSE (should equal BEFORE) ===')
  console.table(restored)
  check('payments restored EXACTLY to before', JSON.stringify(restored) === JSON.stringify(before))
  const revLogs = await prisma.activityLog.findMany({ where: { entityId: batch.id }, select: { action: true } })
  check(
    'ActivityLog RATE_CORRECTION_REVERSED written',
    revLogs.some(l => l.action === 'RATE_CORRECTION_REVERSED'),
  )

  console.log('\n=== CLEANUP (restore structure + delete test batch/logs) ===')
  await prisma.venuePricingStructure.update({ where: { id: vps.id }, data: originalRates })
  await prisma.rateCorrectionBatch.delete({ where: { id: batch.id } }) // cascade-deletes entries
  await prisma.activityLog.deleteMany({ where: { entityId: batch.id } })
  const vpsNow = await prisma.venuePricingStructure.findUniqueOrThrow({ where: { id: vps.id } })
  check('venue pricing rate restored to original', Number(vpsNow.creditRate) === originalRates.creditRate)
  const batchGone = await prisma.rateCorrectionBatch.findUnique({ where: { id: batch.id } })
  check('test batch deleted', batchGone === null)

  console.log(`\n${failures === 0 ? '🎉 ALL CHECKS PASSED' : `🚨 ${failures} CHECK(S) FAILED`}`)
  if (failures > 0) process.exitCode = 1
}

main()
  .catch(e => {
    console.error('\n🚨 DEV TEST ERROR:', e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
