import cron from 'node-cron'

import logger from '../config/logger'
import prisma from '../utils/prismaClient'

const STALE_THRESHOLD_SECONDS = 60

// Surfaces inbound customer messages that are stuck in `PENDING` for longer
// than the threshold. The relay service marks rows `SENT`/`FAILED` out-of-band
// on its own; anything that stays `PENDING` >60s means the relay never ran
// (process crash, unhandled exception, etc.) and needs an admin to look. The
// admin alert path is shared with the template-status-update handler; for now
// we log at error severity and a follow-up wires email/Slack.
export async function runStalePendingAlert(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_SECONDS * 1000)
  const stale = await prisma.venueChatMessage.findMany({
    where: {
      relayStatus: 'PENDING',
      direction: 'INBOUND_FROM_CUSTOMER',
      OR: [{ sendAttemptedAt: { lt: cutoff } }, { sendAttemptedAt: null, createdAt: { lt: cutoff } }],
    },
    select: { id: true, sessionId: true, sendAttemptedAt: true, createdAt: true },
  })
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
  cron.schedule('*/5 * * * *', () => {
    runStalePendingAlert().catch(err => {
      logger.error('[Stale-PENDING Alert] Job iteration failed', { err })
    })
  })
}
