import { Prisma } from '@prisma/client'
import type { CronJob } from 'cron'
import logger from '@/config/logger'
import { scheduleJob } from '@/observability/jobContext'
import { platformWebhookRuntime } from '@/services/stripe-webhooks/platformWebhookRuntime.service'
import type { OperationalAlertLease, WebhookClaimPhase, WebhookLease } from '@/services/stripe-webhooks/platformWebhookInbox.service'
import prisma from '@/utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'

interface ScheduleLike {
  start(): void
  stop(): void
}

interface RecoveryInbox {
  terminalizeExhausted(phase: WebhookClaimPhase): Promise<unknown>
  acquireNext(phase: WebhookClaimPhase): Promise<WebhookLease | null>
}

interface RecoveryProcessor {
  processClassification(eventId: string, lease: WebhookLease): Promise<unknown>
  processEffect(eventId: string, lease: WebhookLease): Promise<unknown>
}

interface JobLogger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

async function platformWebhookReadiness(): Promise<void> {
  await retry(() => prisma.$queryRaw(Prisma.sql`SELECT 1`), {
    retries: 2,
    initialDelay: 1500,
    shouldRetry: shouldRetryDbConnectionError,
    context: 'platform-webhook-recovery.readiness',
  })
}

export class PlatformWebhookPhaseRecoveryJob {
  private running = false
  private readonly schedule: ScheduleLike

  constructor(
    private readonly dependencies: {
      phase: WebhookClaimPhase
      enabled: boolean
      inbox: RecoveryInbox
      processor: RecoveryProcessor
      readiness: () => Promise<void>
      logger: JobLogger
      schedule?: ScheduleLike
    },
  ) {
    const pattern = dependencies.phase === 'CLASSIFICATION' ? '2-57/5 * * * *' : '3-58/5 * * * *'
    this.schedule =
      dependencies.schedule ??
      scheduleJob(
        `platform-webhook-${dependencies.phase.toLowerCase()}-recovery`,
        pattern,
        this.runOnce.bind(this),
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    if (!this.dependencies.enabled) {
      this.dependencies.logger.info('Platform webhook recovery remains disabled', { phase: this.dependencies.phase })
      return
    }
    this.schedule.start()
    this.dependencies.logger.info('Platform webhook recovery job started', { phase: this.dependencies.phase })
  }

  stop(): void {
    this.schedule.stop()
  }

  async runOnce(): Promise<void> {
    if (!this.dependencies.enabled || this.running) return
    this.running = true
    try {
      await this.dependencies.readiness()
      await this.dependencies.inbox.terminalizeExhausted(this.dependencies.phase)
      for (let processed = 0; processed < 25; processed += 1) {
        // Claim immediately before execution. Attempts represent actual phase
        // starts, never time spent waiting behind another handler in this process.
        const lease = await this.dependencies.inbox.acquireNext(this.dependencies.phase)
        if (!lease) break
        try {
          if (this.dependencies.phase === 'CLASSIFICATION') {
            await this.dependencies.processor.processClassification(lease.eventId, lease)
          } else {
            await this.dependencies.processor.processEffect(lease.eventId, lease)
          }
        } catch (error) {
          this.dependencies.logger.error('Platform webhook recovery phase failed under durable lease', {
            phase: this.dependencies.phase,
            webhookEventId: lease.eventId,
            attempt: lease.attempt,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } catch (error) {
      this.dependencies.logger.error('Platform webhook recovery tick failed', {
        phase: this.dependencies.phase,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.running = false
    }
  }
}

interface AlertInbox {
  claimOperationalAlerts(): Promise<OperationalAlertLease[]>
  acknowledgeOperationalAlert(lease: OperationalAlertLease): Promise<void>
  retryOperationalAlert(lease: OperationalAlertLease): Promise<void>
}

export class PlatformWebhookOperationalAlertJob {
  private running = false
  private readonly schedule: ScheduleLike

  constructor(
    private readonly dependencies: {
      enabled: boolean
      inbox: AlertInbox
      readiness: () => Promise<void>
      deliver: (lease: OperationalAlertLease) => Promise<void>
      logger: JobLogger
      schedule?: ScheduleLike
    },
  ) {
    this.schedule =
      dependencies.schedule ??
      scheduleJob('platform-webhook-operational-alerts', '4-59/5 * * * *', this.runOnce.bind(this), null, false, 'America/Mexico_City')
  }

  start(): void {
    if (!this.dependencies.enabled) {
      this.dependencies.logger.info('Platform webhook operational alert delivery remains disabled')
      return
    }
    this.schedule.start()
    this.dependencies.logger.info('Platform webhook operational alert job started')
  }

  stop(): void {
    this.schedule.stop()
  }

  async runOnce(): Promise<void> {
    if (!this.dependencies.enabled || this.running) return
    this.running = true
    try {
      await this.dependencies.readiness()
      const alerts = await this.dependencies.inbox.claimOperationalAlerts()
      for (const alert of alerts) {
        try {
          await this.dependencies.deliver(alert)
          await this.dependencies.inbox.acknowledgeOperationalAlert(alert)
        } catch (error) {
          this.dependencies.logger.error('Platform webhook operational alert delivery failed', {
            alertId: alert.alertId,
            webhookEventId: alert.webhookEventId,
            phase: alert.phase,
            terminalReason: alert.terminalReason,
            error: error instanceof Error ? error.message : String(error),
          })
          try {
            await this.dependencies.inbox.retryOperationalAlert(alert)
          } catch (retryError) {
            this.dependencies.logger.error('Platform webhook operational alert retry bookkeeping failed', {
              alertId: alert.alertId,
              error: retryError instanceof Error ? retryError.message : String(retryError),
            })
          }
        }
      }
    } catch (error) {
      this.dependencies.logger.error('Platform webhook operational alert tick failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.running = false
    }
  }
}

const common = {
  enabled: platformWebhookRuntime.mode === 'SHADOW' && platformWebhookRuntime.recoveryEnabled,
  inbox: platformWebhookRuntime.inbox,
  processor: platformWebhookRuntime.processor,
  readiness: platformWebhookReadiness,
  logger,
}

export const platformWebhookClassificationRecoveryJob = new PlatformWebhookPhaseRecoveryJob({
  ...common,
  phase: 'CLASSIFICATION',
})
export const platformWebhookEffectRecoveryJob = new PlatformWebhookPhaseRecoveryJob({ ...common, phase: 'EFFECT' })
export const platformWebhookOperationalAlertJob = new PlatformWebhookOperationalAlertJob({
  enabled: common.enabled,
  inbox: common.inbox,
  readiness: common.readiness,
  logger,
  async deliver(alert) {
    logger.error('🚨 Platform webhook phase exhausted', {
      alertId: alert.alertId,
      webhookEventId: alert.webhookEventId,
      phase: alert.phase,
      terminalReason: alert.terminalReason,
      attempt: alert.attempt,
      deliveryAttempt: alert.deliveryAttempt,
    })
  },
})

export type { CronJob }
