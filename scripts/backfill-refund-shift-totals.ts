/**
 * Backfill Shift.totalSales for pre-fix refunds.
 *
 * Context: Before 2026-04-18, the refund service only decremented Shift.totalSales
 * when the refunder had an open shift. Refunds that inherited the ORIGINAL payment's
 * shiftId (the common dashboard/TPV case) left that shift's totalSales inflated.
 * Fix is in `src/services/dashboard/refund.dashboard.service.ts:351-359`.
 *
 * This script is idempotent:
 *   - Only touches refunds where processorData.shiftBackfilled is NOT true.
 *   - Each refund it touches gets marked processorData.shiftBackfilled=true after commit.
 *   - Running twice is a no-op on already-backfilled rows.
 *
 * Usage (dry-run by default):
 *   npx tsx scripts/backfill-refund-shift-totals.ts
 *   npx tsx scripts/backfill-refund-shift-totals.ts --execute
 *   npx tsx scripts/backfill-refund-shift-totals.ts --execute --cutoff 2026-04-18T20:00:00Z
 *
 * Flags:
 *   --execute        Apply the change (default: dry-run preview only)
 *   --cutoff <iso>   Only consider refunds created strictly before this timestamp.
 *                    Default: current time. Use this in prod with the deploy
 *                    timestamp to exclude refunds that were already decremented
 *                    in-line by the fixed code path.
 */

import { Prisma } from '@prisma/client'
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

type Args = { execute: boolean; cutoff: Date }

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const execute = argv.includes('--execute')
  const cutoffIdx = argv.indexOf('--cutoff')
  const cutoff = cutoffIdx >= 0 && argv[cutoffIdx + 1] ? new Date(argv[cutoffIdx + 1]) : new Date()
  if (Number.isNaN(cutoff.getTime())) {
    throw new Error(`Invalid --cutoff value: ${argv[cutoffIdx + 1]}`)
  }
  return { execute, cutoff }
}

async function main() {
  const { execute, cutoff } = parseArgs()
  logger.info(`[BACKFILL-SHIFT] mode=${execute ? 'EXECUTE' : 'DRY-RUN'} cutoff=${cutoff.toISOString()}`)

  // 1. Find eligible refunds (shiftId set, created before cutoff).
  //    Filter out already-marked rows in JS — Prisma JSON NOT can't distinguish
  //    "key missing" from "key present but not true".
  const candidates = await prisma.payment.findMany({
    where: {
      type: 'REFUND',
      shiftId: { not: null },
      createdAt: { lt: cutoff },
    },
    select: { id: true, amount: true, shiftId: true, createdAt: true, processorData: true },
    orderBy: { createdAt: 'asc' },
  })
  const eligible = candidates.filter(r => {
    const pd = (r.processorData as Record<string, unknown> | null) ?? {}
    return pd.shiftBackfilled !== true
  })

  if (eligible.length === 0) {
    logger.info('[BACKFILL-SHIFT] No eligible refunds. Nothing to do.')
    await prisma.$disconnect()
    return
  }

  // 2. Aggregate per shift for preview.
  const perShift = new Map<string, { delta: Prisma.Decimal; count: number }>()
  for (const r of eligible) {
    const shiftId = r.shiftId!
    const agg = perShift.get(shiftId) ?? { delta: new Prisma.Decimal(0), count: 0 }
    agg.delta = agg.delta.plus(new Prisma.Decimal(r.amount).abs())
    agg.count += 1
    perShift.set(shiftId, agg)
  }

  // 3. Fetch current totals for preview.
  const shifts = await prisma.shift.findMany({
    where: { id: { in: Array.from(perShift.keys()) } },
    select: { id: true, totalSales: true, venueId: true, status: true },
  })
  const shiftMap = new Map(shifts.map(s => [s.id, s]))

  logger.info(`[BACKFILL-SHIFT] ${eligible.length} refunds across ${perShift.size} shift(s).`)
  console.log('\n--- PER-SHIFT PREVIEW ---')
  console.log('shiftId | venueId | status | currentTotalSales | delta | newTotalSales | refundCount')
  let totalDelta = new Prisma.Decimal(0)
  for (const [shiftId, agg] of perShift) {
    const s = shiftMap.get(shiftId)
    if (!s) {
      console.log(`${shiftId} | <MISSING SHIFT> | -- | -- | -${agg.delta} | -- | ${agg.count}`)
      continue
    }
    const newTotal = new Prisma.Decimal(s.totalSales).minus(agg.delta)
    console.log(`${shiftId} | ${s.venueId} | ${s.status} | ${s.totalSales} | -${agg.delta} | ${newTotal} | ${agg.count}`)
    totalDelta = totalDelta.plus(agg.delta)
  }
  console.log(`\nTOTAL DELTA ACROSS ALL SHIFTS: -${totalDelta}`)

  if (!execute) {
    console.log('\n[DRY-RUN] Re-run with --execute to apply. No changes made.')
    await prisma.$disconnect()
    return
  }

  // 4. Apply in a single transaction: decrement each shift and mark each refund.
  logger.info('[BACKFILL-SHIFT] Applying changes in transaction...')
  await prisma.$transaction(async tx => {
    for (const [shiftId, agg] of perShift) {
      if (!shiftMap.has(shiftId)) {
        logger.warn(`[BACKFILL-SHIFT] Skipping missing shift ${shiftId} (${agg.count} refunds)`)
        continue
      }
      await tx.shift.update({
        where: { id: shiftId },
        data: { totalSales: { decrement: agg.delta } },
      })
    }
    for (const r of eligible) {
      const pd = (r.processorData as Record<string, unknown> | null) ?? {}
      await tx.payment.update({
        where: { id: r.id },
        data: {
          processorData: { ...pd, shiftBackfilled: true } as Prisma.InputJsonValue,
        },
      })
    }
  })

  logger.info(`[BACKFILL-SHIFT] Applied. ${eligible.length} refunds marked, ${perShift.size} shifts updated.`)
  await prisma.$disconnect()
}

main().catch(err => {
  logger.error('[BACKFILL-SHIFT] Failed:', err)
  process.exit(1)
})
