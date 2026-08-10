import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import { scheduleCron } from '../observability/jobContext'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'

const INACTIVITY_DAYS = 7

// Closes `OPEN` venue chat sessions whose `lastActivityAt` is older than 7
// days. Customer + venue both abandoned the conversation; keeping it OPEN
// pollutes shortCode reuse (partial unique index on OPEN sessions per venue)
// and the dashboard "active chats" list.
export async function runVenueChatInactivityCleanup(): Promise<void> {
  const cutoff = new Date(Date.now() - INACTIVITY_DAYS * 24 * 3600 * 1000)
  // Idempotent updateMany: the WHERE only matches still-OPEN sessions, so a
  // retry after a connection blip re-closes nothing already closed.
  const result = await retry(
    () =>
      prisma.venueChatSession.updateMany({
        where: { status: 'OPEN', lastActivityAt: { lt: cutoff } },
        data: { status: 'CLOSED_BY_INACTIVITY', closedAt: new Date() },
      }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'venue-chat-inactivity-cleanup.closeStale' },
  )
  if (result.count > 0) {
    logger.info(`[Inactivity Cleanup] Closed ${result.count} venue chat session(s) inactive >${INACTIVITY_DAYS} days`)
  }
}

export function startVenueChatInactivityCleanupJob(): void {
  logger.info('[Inactivity Cleanup] ⏰ Job started. Runs hourly.')
  scheduleCron('venue-chat-inactivity-cleanup', '0 * * * *', () => {
    runVenueChatInactivityCleanup().catch(err => {
      logger.error('[Inactivity Cleanup] Job iteration failed', { err })
    })
  })
}
