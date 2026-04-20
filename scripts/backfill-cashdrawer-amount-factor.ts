/**
 * Backfill CashDrawer amounts that were incorrectly divided by 100.
 *
 * Context: Before 2026-04-19, `cash-drawer.mobile.service.ts` treated the
 * incoming `amount` as cents and divided by 100 before persisting, but all
 * clients (Android, iOS) actually send dollars. The result was that every
 * CashDrawerEvent.amount and CashDrawerSession.startingAmount/actualAmount/
 * overShort in the DB is 1/100 of the real value. The UI looked correct
 * because the response path multiplied by 100 again, but every other consumer
 * (reports, reconciliation, analytics) reads the raw DB value which is wrong.
 *
 * This script multiplies each pre-fix row by 100 so the stored value matches
 * the intended dollars. It is idempotent via a `meta.cashDrawerBackfilled`
 * marker is NOT possible here (no jsonb column on these tables), so we rely on
 * a hard cutoff timestamp and a marker table entry per row is overkill. Use
 * `--cutoff` with the deploy timestamp to scope the fix to pre-deploy rows.
 *
 * Usage:
 *   npx tsx scripts/backfill-cashdrawer-amount-factor.ts                     # dry-run
 *   npx tsx scripts/backfill-cashdrawer-amount-factor.ts --execute
 *   npx tsx scripts/backfill-cashdrawer-amount-factor.ts --execute --cutoff 2026-04-19T20:00:00Z
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
  logger.info(`[BACKFILL-CD] mode=${execute ? 'EXECUTE' : 'DRY-RUN'} cutoff=${cutoff.toISOString()}`)

  const [events, sessions] = await Promise.all([
    prisma.cashDrawerEvent.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true, amount: true, type: true, createdAt: true, sessionId: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.cashDrawerSession.findMany({
      where: { createdAt: { lt: cutoff } },
      select: {
        id: true,
        startingAmount: true,
        actualAmount: true,
        overShort: true,
        createdAt: true,
        status: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  logger.info(`[BACKFILL-CD] ${events.length} events + ${sessions.length} sessions pre-cutoff`)

  if (events.length === 0 && sessions.length === 0) {
    logger.info('[BACKFILL-CD] Nothing to backfill.')
    await prisma.$disconnect()
    return
  }

  console.log('\n--- EVENTS PREVIEW (×100) ---')
  console.log('id | type | sessionId | current → new')
  for (const e of events) {
    const newAmt = new Prisma.Decimal(e.amount).mul(100)
    console.log(`${e.id} | ${e.type} | ${e.sessionId} | ${e.amount} → ${newAmt}`)
  }

  console.log('\n--- SESSIONS PREVIEW (×100 on startingAmount/actualAmount/overShort) ---')
  console.log('id | status | startingAmount | actualAmount | overShort')
  for (const s of sessions) {
    const ns = new Prisma.Decimal(s.startingAmount).mul(100)
    const na = s.actualAmount ? new Prisma.Decimal(s.actualAmount).mul(100) : null
    const no = s.overShort ? new Prisma.Decimal(s.overShort).mul(100) : null
    console.log(
      `${s.id} | ${s.status} | ${s.startingAmount}→${ns} | ${s.actualAmount ?? '-'}→${na ?? '-'} | ${s.overShort ?? '-'}→${no ?? '-'}`,
    )
  }

  if (!execute) {
    console.log('\n[DRY-RUN] Re-run with --execute to apply.')
    await prisma.$disconnect()
    return
  }

  logger.info('[BACKFILL-CD] Applying in transaction...')
  await prisma.$transaction(async tx => {
    for (const e of events) {
      await tx.cashDrawerEvent.update({
        where: { id: e.id },
        data: { amount: new Prisma.Decimal(e.amount).mul(100) },
      })
    }
    for (const s of sessions) {
      await tx.cashDrawerSession.update({
        where: { id: s.id },
        data: {
          startingAmount: new Prisma.Decimal(s.startingAmount).mul(100),
          ...(s.actualAmount ? { actualAmount: new Prisma.Decimal(s.actualAmount).mul(100) } : {}),
          ...(s.overShort ? { overShort: new Prisma.Decimal(s.overShort).mul(100) } : {}),
        },
      })
    }
  })

  logger.info(`[BACKFILL-CD] Applied. ${events.length} events + ${sessions.length} sessions updated.`)
  await prisma.$disconnect()
}

main().catch(err => {
  logger.error('[BACKFILL-CD] Failed:', err)
  process.exit(1)
})
