/**
 * Cash Out — settlement sweep (the 18:15 corte runner).
 *
 * Discovers every CASH_OUT venue (org-level OR venue-level module) and runs
 * materialize → reconcile → report on each. Each step self-gates by module, so
 * a stray venue is a no-op. The entry read is retry-wrapped per .claude/rules/cron-jobs.md.
 */
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'
import { MODULE_CODES } from '@/services/modules/module.service'
import { materializeEntries, reconcileClawbacks } from './cash-out.ledger.service'
import { generateDispersionReport } from './cash-out.report.service'

const SYSTEM_ACTOR = { staffId: 'SYSTEM' }

/** Every venue with SERIALIZED_INVENTORY enabled (cash-out runs wherever serialized inventory is on; org-level inherited + venue-level). */
export async function listCashOutVenueIds(): Promise<string[]> {
  const [orgMods, venueMods] = await retry(
    () =>
      Promise.all([
        prisma.organizationModule.findMany({
          where: { enabled: true, module: { code: MODULE_CODES.SERIALIZED_INVENTORY } },
          select: { organizationId: true },
        }),
        prisma.venueModule.findMany({
          where: { enabled: true, module: { code: MODULE_CODES.SERIALIZED_INVENTORY } },
          select: { venueId: true },
        }),
      ]),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'cash-out-settlement.listVenues' },
  )

  const orgIds = orgMods.map(m => m.organizationId)
  const orgVenues = orgIds.length
    ? await prisma.venue.findMany({ where: { organizationId: { in: orgIds }, active: true }, select: { id: true } })
    : []

  return Array.from(new Set([...orgVenues.map(v => v.id), ...venueMods.map(m => m.venueId)]))
}

/** Run the full corte across all CASH_OUT venues. Resilient: one bad venue is logged, not fatal. */
export async function runCashOutSettlement(): Promise<{ venues: number; created: number; clawedBack: number; reported: number }> {
  const venueIds = await listCashOutVenueIds()
  let created = 0
  let clawedBack = 0
  let reported = 0

  for (const venueId of venueIds) {
    try {
      created += (await materializeEntries(venueId)).created
      clawedBack += (await reconcileClawbacks(venueId)).clawedBack
      reported += (await generateDispersionReport(venueId, {}, SYSTEM_ACTOR)).count
    } catch (err: any) {
      logger.error(`[cash-out-settlement] venue ${venueId} failed: ${err?.message ?? err}`)
    }
  }

  logger.info(`[cash-out-settlement] done — venues=${venueIds.length} created=${created} clawedBack=${clawedBack} reported=${reported}`)
  return { venues: venueIds.length, created, clawedBack, reported }
}
