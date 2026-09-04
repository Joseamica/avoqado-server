// src/infrastructure/rabbitmq/commandRetryService.ts
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../../utils/retry'
import { deliverPosCommand } from './commandListener'

const RETRY_INTERVAL_MS = 60000 // Check every minute
const MAX_ATTEMPTS = 5
const STALE_OPEN_DELIVERY_MS = 5 * 60 * 1000

export class CommandRetryService {
  private intervalId: NodeJS.Timeout | null = null
  private isRunning = false

  start(): void {
    logger.info('🔄 Starting command retry service...')
    this.intervalId = setInterval(async () => {
      await this.retryFailedCommands()
    }, RETRY_INTERVAL_MS)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    logger.info('✅ Command retry service stopped')
  }

  private async retryFailedCommands(now = new Date()): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    try {
      // Only the new durable OPEN commands can be recovered from PROCESSING.
      // Historical Order/Payment rows were never marked COMPLETED by the old worker,
      // so replaying every stale row could resend real production commands.
      const staleBefore = new Date(now.getTime() - STALE_OPEN_DELIVERY_MS)
      const staleOpenCommands = await retry(
        () =>
          prisma.posCommand.findMany({
            where: {
              status: 'PROCESSING',
              entityType: 'Shift',
              action: 'OPEN',
              dedupeKey: { not: null },
              lastAttemptAt: { lt: staleBefore },
            },
            take: 5,
            orderBy: [{ lastAttemptAt: 'asc' }, { id: 'asc' }],
          }),
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'commandRetryService.findStaleOpen' },
      )

      for (const command of staleOpenCommands) {
        await prisma.posCommand.updateMany({
          where: {
            id: command.id,
            status: 'PROCESSING',
            lastAttemptAt: command.lastAttemptAt,
            entityType: 'Shift',
            action: 'OPEN',
            dedupeKey: { not: null },
          },
          data: { status: 'PENDING', nextAttemptAt: null, errorMessage: 'Recovered stale OPEN delivery' },
        })
      }

      // Notifications are only a wake-up optimization. This recurring bounded
      // sweep guarantees that a committed OPEN survives a crash or disconnect
      // after the one-time startup batch. Multiple instances remain safe because
      // deliverPosCommand owns the PENDING -> PROCESSING CAS.
      const dueOpenCommands = await retry(
        () =>
          prisma.posCommand.findMany({
            where: {
              status: { in: ['PENDING', 'FAILED'] },
              entityType: 'Shift',
              action: 'OPEN',
              dedupeKey: { not: null },
              OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
            },
            take: 5,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          }),
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'commandRetryService.findDueOpen' },
      )

      for (const command of dueOpenCommands) {
        if (command.status === 'FAILED') {
          const reset = await prisma.posCommand.updateMany({
            where: {
              id: command.id,
              status: 'FAILED',
              attempts: command.attempts,
              entityType: 'Shift',
              action: 'OPEN',
              dedupeKey: { not: null },
            },
            data: { status: 'PENDING' },
          })
          if (reset.count !== 1) continue
        }
        await deliverPosCommand(command.id, now)
      }

      // Find failed commands that haven't exceeded max attempts.
      // Retry only on transient DB connection blips (e.g. 2026-07-03 "server closed
      // the connection" incident). See .claude/rules/cron-jobs.md
      const failedCommands = await retry(
        () =>
          prisma.posCommand.findMany({
            where: {
              status: 'FAILED',
              attempts: { lt: MAX_ATTEMPTS },
              NOT: { entityType: 'Shift', action: 'OPEN', dedupeKey: { not: null } },
            },
            take: 5,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          }),
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'commandRetryService.findFailed' },
      )

      if (failedCommands.length === 0) return

      logger.info(`🔄 Retrying ${failedCommands.length} failed commands`)

      for (const command of failedCommands) {
        // CAS prevents two retry workers from both resetting a row selected from
        // the same snapshot. Delivery itself has a second PENDING claim fence.
        await prisma.posCommand.updateMany({
          where: { id: command.id, status: 'FAILED', attempts: command.attempts },
          data: { status: 'PENDING' },
        })
      }
    } catch (error) {
      logger.error('Error in retry service:', error)
    } finally {
      this.isRunning = false
    }
  }
}
