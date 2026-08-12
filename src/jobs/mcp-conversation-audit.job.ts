/**
 * MCP "Bad Experience" Audit Job
 *
 * Every 12 hours, reviews the customer-MCP tool calls from the last window
 * (persisted by `src/mcp/instrument.ts` into `McpToolCall`) and surfaces the
 * calls where the MCP likely did NOT resolve the operator's request: tool
 * errors, permission denials, "not found / out of scope" (our tools encode that
 * as ok:false), and retry bursts (same caller hammering a failing tool).
 *
 * ⚠️ Ceiling (by design, be honest about it): we NEVER see the user's
 * natural-language question nor the model's natural-language answer — those live
 * in the operator's ChatGPT/Claude and never reach our server. So this detects
 * bad OUTCOMES/SIGNALS, not "the model's prose answer was wrong". See
 * `src/services/mcp/mcpAudit.service.ts`.
 *
 * Delivery v1: writes a structured summary to the logger → BetterStack (queryable
 * by `mcpAudit:true`, alertable). Email digest can be layered on later.
 *
 * Runs at 00:17 and 12:17 Mexico City (offset minute to dodge the top-of-hour
 * connection stampede — see .claude/rules/cron-jobs.md).
 */

import { CronJob } from 'cron'
import logger from '../config/logger'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { getRecentMcpCalls, detectBadMcpExperiences, summarizeBadMcpReport, BadMcpExperienceReport } from '../services/mcp/mcpAudit.service'
import { scheduleJob } from '../observability/jobContext'

const WINDOW_HOURS = 12

export class McpConversationAuditJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    this.job = scheduleJob(
      'mcp-conversation-audit',
      '17 */12 * * *', // 00:17 and 12:17
      async () => {
        await this.runAudit()
      },
      null,
      false,
      'America/Mexico_City',
    )
  }

  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('MCP Conversation Audit Job started — every 12h at :17 Mexico City')
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('MCP Conversation Audit Job stopped')
    }
  }

  /** Run manually (testing / ad-hoc). Returns the report. */
  async runNow(windowHours: number = WINDOW_HOURS): Promise<BadMcpExperienceReport> {
    return this.runAudit(windowHours)
  }

  private async runAudit(windowHours: number = WINDOW_HOURS): Promise<BadMcpExperienceReport> {
    if (this.isRunning) {
      logger.warn('MCP conversation audit already in progress, skipping')
      return detectBadMcpExperiences([], { windowHours })
    }
    this.isRunning = true
    const startTime = Date.now()
    try {
      // Entry read wrapped with connection retry (cron-jobs.md). Pure read → safe to retry.
      const calls = await retry(() => getRecentMcpCalls(windowHours), {
        retries: 2,
        initialDelay: 1500,
        shouldRetry: shouldRetryDbConnectionError,
        context: 'mcp-conversation-audit.getRecentMcpCalls',
      })

      const report = detectBadMcpExperiences(calls, { windowHours })
      const summary = summarizeBadMcpReport(report)

      const meta = {
        mcpAudit: true as const,
        windowHours,
        totalCalls: report.totalCalls,
        failedCalls: report.failedCalls,
        errorRate: Number(report.errorRate.toFixed(3)),
        permissionDeniedTools: report.permissionDenied.map(g => g.toolName),
        failingTools: report.failuresByTool.map(g => ({ tool: g.toolName, count: g.count })),
        retryBursts: report.retryBursts.length,
        affectedVenues: report.affectedVenueIds.length,
        durationMs: Date.now() - startTime,
      }

      if (report.hasSignal) logger.warn(`mcp.audit.report ${summary.join(' ')}`, meta)
      else logger.info(`mcp.audit.report ${summary[0]}`, meta)

      return report
    } catch (error) {
      logger.error('MCP conversation audit job failed', { mcpAudit: true, error: (error as Error).message })
      throw error
    } finally {
      this.isRunning = false
    }
  }

  isJobRunning(): boolean {
    return this.isRunning
  }

  getNextRun(): Date | null {
    return this.job?.nextDate()?.toJSDate() ?? null
  }
}

export const mcpConversationAuditJob = new McpConversationAuditJob()
