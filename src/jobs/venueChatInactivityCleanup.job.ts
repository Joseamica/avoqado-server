import cron from 'node-cron'

import logger from '../config/logger'
import prisma from '../utils/prismaClient'

const INACTIVITY_DAYS = 7

// Closes `OPEN` venue chat sessions whose `lastActivityAt` is older than 7
// days. Customer + venue both abandoned the conversation; keeping it OPEN
// pollutes shortCode reuse (partial unique index on OPEN sessions per venue)
// and the dashboard "active chats" list.
export async function runVenueChatInactivityCleanup(): Promise<void> {
  const cutoff = new Date(Date.now() - INACTIVITY_DAYS * 24 * 3600 * 1000)
  const result = await prisma.venueChatSession.updateMany({
    where: { status: 'OPEN', lastActivityAt: { lt: cutoff } },
    data: { status: 'CLOSED_BY_INACTIVITY', closedAt: new Date() },
  })
  if (result.count > 0) {
    logger.info(`[Inactivity Cleanup] Closed ${result.count} venue chat session(s) inactive >${INACTIVITY_DAYS} days`)
  }
}

export function startVenueChatInactivityCleanupJob(): void {
  logger.info('[Inactivity Cleanup] ⏰ Job started. Runs hourly.')
  cron.schedule('0 * * * *', () => {
    runVenueChatInactivityCleanup().catch(err => {
      logger.error('[Inactivity Cleanup] Job iteration failed', { err })
    })
  })
}
