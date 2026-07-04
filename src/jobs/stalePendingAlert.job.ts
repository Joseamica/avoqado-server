import cron from 'node-cron'

import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'

const STALE_THRESHOLD_SECONDS = 60

// Surfaces inbound customer messages that are stuck in `PENDING` for longer
// than the threshold. The relay service marks rows `SENT`/`FAILED` out-of-band
// on its own; anything that stays `PENDING` >60s means the relay never ran
// (process crash, unhandled exception, etc.) and needs an admin to look. The
// admin alert path is shared with the template-status-update handler; for now
// we log at error severity and a follow-up wires email/Slack.
export async function runStalePendingAlert(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_SECONDS * 1000)
  // Retry only on transient DB connection blips (P1001 during the cron stampede).
  // See .claude/rules/cron-jobs.md
  const stale = await retry(
    () =>
      prisma.venueChatMessage.findMany({
        where: {
          relayStatus: 'PENDING',
          direction: 'INBOUND_FROM_CUSTOMER',
          OR: [{ sendAttemptedAt: { lt: cutoff } }, { sendAttemptedAt: null, createdAt: { lt: cutoff } }],
        },
        select: { id: true, sessionId: true, sendAttemptedAt: true, createdAt: true },
      }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'stalePendingAlert.findStale' },
  )
  if (stale.length === 0) return

  for (const row of stale) {
    logger.error('[ADMIN ALERT] Stale PENDING relay (no auto-retry)', {
      messageId: row.id,
      sessionId: row.sessionId,
      since: row.sendAttemptedAt ?? row.createdAt,
    })
  }
}

export function startStalePendingAlertJob(): void {
  logger.info('[Stale-PENDING Alert] ⏰ Job started. Runs every 5 minutes.')
  // Offset 4 min into the 5-min window — several other */5 jobs (marketing,
  // reservation reminders/no-show, POS monitor) share this cadence; firing on the
  // exact same tick can exhaust the connection pool (P2024 incident 2026-07-03).
  // See .claude/rules/cron-jobs.md checklist item 4.
  cron.schedule('4-59/5 * * * *', () => {
    runStalePendingAlert().catch(err => {
      logger.error('[Stale-PENDING Alert] Job iteration failed', { err })
    })
  })
}
