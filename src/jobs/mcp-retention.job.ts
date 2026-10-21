import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'

const RETENTION_DAYS = 90
const PAGE_SIZE = 100
const MAX_PAGES = 50

/** Technical MCP metadata only; business records and ActivityLog have separate retention. */
export class McpRetentionJob {
  private job: CronJob | null = null
  private isRunning = false

  start(): void {
    if (this.job) return
    this.job = scheduleJob('mcp-retention', '37 * * * *', async () => {
      try {
        await this.runNow()
      } catch (error) {
        logger.error('MCP technical audit cleanup failed', { mcpRetention: true, error: (error as Error).message })
      }
    })
    this.job.start()
  }

  stop(): void {
    this.job?.stop()
    this.job = null
  }

  async runNow(now = new Date()): Promise<{ deleted: number; backlog: boolean; skipped?: boolean }> {
    if (this.isRunning) return { deleted: 0, backlog: false, skipped: true }
    this.isRunning = true
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400_000)
    const where = { createdAt: { lt: cutoff } }
    let deleted = 0
    try {
      // ponytail: at most 5,000 rows/hour/process; backlog is logged, raise the budget after measuring load.
      for (let page = 0; page < MAX_PAGES; page++) {
        const rows = await retry(
          () =>
            prisma.mcpToolCall.findMany({ where, select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: PAGE_SIZE }),
          { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'mcp-retention.read' },
        )
        if (rows.length === 0) {
          logger.info('MCP technical audit cleanup complete', {
            mcpRetention: true,
            deleted,
            retentionDays: RETENTION_DAYS,
            backlog: false,
          })
          return { deleted, backlog: false }
        }
        const result = await prisma.mcpToolCall.deleteMany({ where: { ...where, id: { in: rows.map(row => row.id) } } })
        deleted += result.count
      }
      const remaining = await prisma.mcpToolCall.findFirst({ where, select: { id: true } })
      const backlog = remaining !== null
      const meta = { mcpRetention: true, deleted, retentionDays: RETENTION_DAYS, backlog }
      if (backlog) logger.warn('MCP technical audit cleanup reached its budget; remaining rows continue next hour', meta)
      else logger.info('MCP technical audit cleanup complete', meta)
      return { deleted, backlog }
    } finally {
      this.isRunning = false
    }
  }
}

export const mcpRetentionJob = new McpRetentionJob()
