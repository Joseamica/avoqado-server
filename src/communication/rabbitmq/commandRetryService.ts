// src/infrastructure/rabbitmq/commandRetryService.ts
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'

const RETRY_INTERVAL_MS = 60000 // Check every minute
const MAX_ATTEMPTS = 5

export class CommandRetryService {
  private intervalId: NodeJS.Timeout | null = null

  start(): void {
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

  private async retryFailedCommands(): Promise<void> {
    try {
      // Find failed commands that haven't exceeded max attempts
      const failedCommands = await prisma.posCommand.findMany({
        where: {
          status: 'FAILED',
          attempts: { lt: MAX_ATTEMPTS },
        },
        take: 5,
      })

      if (failedCommands.length === 0) return

      logger.info(`🔄 Retrying ${failedCommands.length} failed commands`)

      for (const command of failedCommands) {
        // Reset to PENDING to trigger the NOTIFY
        await prisma.posCommand.update({
          where: { id: command.id },
          data: { status: 'PENDING' },
        })
      }
    } catch (error) {
      logger.error('Error in retry service:', error)
    }
  }
}
