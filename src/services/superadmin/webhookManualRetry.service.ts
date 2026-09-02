import cuid from 'cuid'
import { WebhookClaimPhase, WebhookEventStatus } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import {
  PLATFORM_WEBHOOK_LIMITS,
  type ManualEffectAuditIntentInput,
  type ManualRetryIntent,
  type WebhookLease,
} from '@/services/stripe-webhooks/platformWebhookInbox.service'
import { webhookManualRetryOutbox, type ManualRetryOutcome } from './webhookManualRetryOutbox.service'

export type { ManualRetryIntent }

export const LEGACY_DASHBOARD_WEBHOOK_RETRY_REASON = 'LEGACY_DASHBOARD_RETRY'

export type WebhookManualRetryAuditState = 'RECORDED' | 'PENDING' | 'UNKNOWN'

type WebhookManualRetryAuditContext = { recorded: boolean; intentId: string } | { state: 'UNKNOWN'; intentId: string }

export interface ManualRetrySnapshot {
  id: string
  venueId: string | null
  status: WebhookEventStatus
  effectAttempts: number
  effectNextAttemptAt: Date | null
  claimPhase: WebhookClaimPhase | null
  claimExpiresAt: Date | null
}

export abstract class WebhookSuperadminDomainError extends Error {
  abstract readonly code: string
  abstract readonly statusCode: number
  readonly phase = 'EFFECT' as const
  readonly auditState?: WebhookManualRetryAuditState
  readonly auditRecorded?: boolean
  readonly auditPending?: boolean
  readonly intentId?: string

  protected constructor(
    message: string,
    readonly eventId: string,
    readonly attempt?: number,
    audit?: WebhookManualRetryAuditContext,
  ) {
    super(message)
    if (audit) {
      this.auditState = 'recorded' in audit ? (audit.recorded ? 'RECORDED' : 'PENDING') : audit.state
      this.auditRecorded = this.auditState === 'RECORDED'
      this.auditPending = this.auditState === 'PENDING'
      this.intentId = audit.intentId
    }
  }
}

export class WebhookNotFoundError extends WebhookSuperadminDomainError {
  readonly code = 'WEBHOOK_NOT_FOUND'
  readonly statusCode = 404

  constructor(eventId: string) {
    super('No se encontró el evento webhook.', eventId)
    this.name = 'WebhookNotFoundError'
  }
}

export class WebhookLeaseBusyError extends WebhookSuperadminDomainError {
  readonly code = 'WEBHOOK_LEASE_BUSY'
  readonly statusCode = 409

  constructor(eventId: string, attempt?: number, audit?: WebhookManualRetryAuditContext) {
    super('El evento webhook ya tiene una operación en curso.', eventId, attempt, audit)
    this.name = 'WebhookLeaseBusyError'
  }
}

export class WebhookEffectNotRetryableError extends WebhookSuperadminDomainError {
  readonly code = 'WEBHOOK_EFFECT_NOT_RETRYABLE'
  readonly statusCode = 422

  constructor(eventId: string, attempt?: number) {
    super('El efecto de este webhook ya no es elegible para reintento.', eventId, attempt)
    this.name = 'WebhookEffectNotRetryableError'
  }
}

export class WebhookEffectAttemptFailedError extends WebhookSuperadminDomainError {
  readonly code = 'WEBHOOK_EFFECT_ATTEMPT_FAILED'
  readonly statusCode = 422

  constructor(eventId: string, attempt: number, audit?: WebhookManualRetryAuditContext) {
    super('El intento EFFECT no pudo completarse.', eventId, attempt, audit)
    this.name = 'WebhookEffectAttemptFailedError'
  }
}

export class WebhookAuditUnavailableError extends WebhookSuperadminDomainError {
  readonly code = 'WEBHOOK_AUDIT_UNAVAILABLE'
  readonly statusCode = 503

  constructor(eventId: string, attempt?: number, audit?: string | WebhookManualRetryAuditContext) {
    super(
      'No fue posible guardar la auditoría obligatoria del reintento.',
      eventId,
      attempt,
      typeof audit === 'string' ? { state: 'UNKNOWN', intentId: audit } : audit,
    )
    this.name = 'WebhookAuditUnavailableError'
  }
}

export function isWebhookSuperadminDomainError(error: unknown): error is WebhookSuperadminDomainError {
  return error instanceof WebhookSuperadminDomainError
}

export interface ManualRetryAuditInput {
  activityLogId: string
  intentId: string
  requestActivityLogId: string
  resultActivityLogId: string
  actorId: string
  venueId: string | null
  eventId: string
  action: string
  reason: string
  code?: string
  attempt?: number
}

export function createDurableManualRetryAuditWriter(db: Pick<typeof prisma, 'activityLog'>) {
  return async function writeManualRetryAudit(input: ManualRetryAuditInput): Promise<void> {
    const data = {
      id: input.activityLogId,
      staffId: input.actorId,
      venueId: input.venueId,
      action: input.action,
      entity: 'WebhookEvent',
      entityId: input.eventId,
      data: {
        phase: 'EFFECT',
        ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
        ...(input.code === undefined ? {} : { code: input.code }),
        reason: input.reason,
        actorId: input.actorId,
        venueId: input.venueId,
        intentId: input.intentId,
        requestActivityLogId: input.requestActivityLogId,
        resultActivityLogId: input.resultActivityLogId,
      },
    }
    let lastError: unknown
    for (let writeAttempt = 1; writeAttempt <= 2; writeAttempt++) {
      try {
        await db.activityLog.upsert({ where: { id: input.activityLogId }, create: data, update: {} })
        return
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }
}

function rejectionFor(snapshot: ManualRetrySnapshot | null, eventId: string, now: Date): WebhookSuperadminDomainError {
  if (!snapshot) return new WebhookNotFoundError(eventId)
  const liveLease = snapshot.claimPhase !== null && snapshot.claimExpiresAt !== null && snapshot.claimExpiresAt.getTime() > now.getTime()
  if (liveLease) return new WebhookLeaseBusyError(eventId)
  if (
    snapshot.status === 'SUCCESS' ||
    !['PENDING', 'FAILED', 'RETRYING'].includes(snapshot.status) ||
    snapshot.effectAttempts >= PLATFORM_WEBHOOK_LIMITS.maxAttempts ||
    snapshot.effectNextAttemptAt === null
  ) {
    return new WebhookEffectNotRetryableError(eventId, snapshot.effectAttempts)
  }
  return new WebhookLeaseBusyError(eventId)
}

export interface WebhookManualRetryPorts {
  inspect(eventId: string): Promise<ManualRetrySnapshot | null>
  writeAudit(input: ManualRetryAuditInput): Promise<void>
  acquireEffectWithIntent(input: ManualEffectAuditIntentInput): Promise<ManualRetryIntent | null>
  markDispatchStarted(intentId: string, lease: WebhookLease): Promise<void>
  processEffect(eventId: string, lease: WebhookLease): Promise<'COMPLETED' | 'SKIPPED'>
  settleRejected(intentId: string, lease: WebhookLease): Promise<void>
  deliverResult(intentId: string): Promise<{ delivered: boolean; outcome?: ManualRetryOutcome }>
  now?: () => Date
  newId?: () => string
}

export function createWebhookManualRetryService(ports: WebhookManualRetryPorts) {
  const now = ports.now ?? (() => new Date())
  const newId = ports.newId ?? cuid

  return async function executeManualRetry(eventId: string, input: { actorId: string; reason?: string }) {
    const reason = input.reason?.trim() || LEGACY_DASHBOARD_WEBHOOK_RETRY_REASON
    const intentId = newId()
    const requestActivityLogId = newId()
    const resultActivityLogId = newId()
    const correlation = { intentId, requestActivityLogId, resultActivityLogId }
    const initial = await ports.inspect(eventId)
    const requestAudit: ManualRetryAuditInput = {
      activityLogId: requestActivityLogId,
      ...correlation,
      actorId: input.actorId,
      venueId: initial?.venueId ?? null,
      eventId,
      action: 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_REQUESTED',
      reason,
    }

    try {
      await ports.writeAudit(requestAudit)
    } catch {
      throw new WebhookAuditUnavailableError(eventId)
    }

    let intent: ManualRetryIntent | null
    try {
      intent = await ports.acquireEffectWithIntent({
        ...correlation,
        actorId: input.actorId,
        venueId: initial?.venueId ?? null,
        eventId,
        reason,
      })
    } catch {
      throw new WebhookAuditUnavailableError(eventId, undefined, intentId)
    }

    if (!intent) {
      const rejection = rejectionFor(await ports.inspect(eventId), eventId, now())
      try {
        await ports.writeAudit({
          activityLogId: resultActivityLogId,
          ...correlation,
          actorId: input.actorId,
          venueId: initial?.venueId ?? null,
          eventId,
          action: 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_REJECTED',
          reason,
          code: rejection.code,
          attempt: rejection.attempt,
        })
      } catch {
        throw new WebhookAuditUnavailableError(eventId, rejection.attempt)
      }
      throw rejection
    }

    try {
      await ports.markDispatchStarted(intentId, intent.lease)
    } catch {
      throw new WebhookAuditUnavailableError(eventId, intent.lease.attempt, { recorded: false, intentId })
    }

    logger.info('Superadmin manual webhook EFFECT retry claimed with durable audit intent', {
      webhookEventId: eventId,
      effectAttempt: intent.lease.attempt,
      actorId: input.actorId,
      intentId,
    })

    const deliverAudit = (): Promise<{ delivered: boolean; outcome?: ManualRetryOutcome }> =>
      ports.deliverResult(intentId).catch(() => ({ delivered: false }))

    let processing: 'COMPLETED' | 'SKIPPED'
    try {
      processing = await ports.processEffect(eventId, intent.lease)
    } catch {
      const audit = await deliverAudit()
      if (audit.delivered && audit.outcome === 'SUCCEEDED') {
        return {
          success: true,
          message: 'Webhook effect reprocessed successfully',
          eventId,
          phase: 'EFFECT' as const,
          attempt: intent.lease.attempt,
          intentId,
          auditState: 'RECORDED' as const,
          auditRecorded: true,
          auditPending: false,
        }
      }
      throw new WebhookEffectAttemptFailedError(eventId, intent.lease.attempt, { recorded: audit.delivered, intentId })
    }

    if (processing === 'SKIPPED') {
      try {
        await ports.settleRejected(intentId, intent.lease)
      } catch {
        const audit = await deliverAudit()
        if (audit.delivered && audit.outcome === 'REJECTED') {
          throw new WebhookLeaseBusyError(eventId, intent.lease.attempt, { recorded: true, intentId })
        }
        throw new WebhookAuditUnavailableError(eventId, intent.lease.attempt, { recorded: false, intentId })
      }
      const audit = await deliverAudit()
      throw new WebhookLeaseBusyError(eventId, intent.lease.attempt, { recorded: audit.delivered, intentId })
    }

    const audit = await deliverAudit()
    return {
      success: true,
      message: 'Webhook effect reprocessed successfully',
      eventId,
      phase: 'EFFECT' as const,
      attempt: intent.lease.attempt,
      intentId,
      auditState: audit.delivered ? ('RECORDED' as const) : ('PENDING' as const),
      auditRecorded: audit.delivered,
      auditPending: !audit.delivered,
    }
  }
}

const manualRetrySelect = {
  id: true,
  venueId: true,
  status: true,
  effectAttempts: true,
  effectNextAttemptAt: true,
  claimPhase: true,
  claimExpiresAt: true,
} as const

const manualRetryService = createWebhookManualRetryService({
  inspect: eventId => prisma.webhookEvent.findUnique({ where: { id: eventId }, select: manualRetrySelect }),
  writeAudit: createDurableManualRetryAuditWriter(prisma),
  async acquireEffectWithIntent(input) {
    const { platformWebhookRuntime } = await import('@/services/stripe-webhooks/platformWebhookRuntime.service')
    return platformWebhookRuntime.inbox.acquireManualEffectWithAuditIntent(input)
  },
  markDispatchStarted: (intentId, lease) => webhookManualRetryOutbox.markDispatchStarted(intentId, lease),
  async processEffect(eventId, lease) {
    const { platformWebhookRuntime } = await import('@/services/stripe-webhooks/platformWebhookRuntime.service')
    return platformWebhookRuntime.processor.processEffect(eventId, lease)
  },
  settleRejected: (intentId, lease) => webhookManualRetryOutbox.settleRejected(intentId, lease),
  deliverResult: intentId => webhookManualRetryOutbox.deliverResult(intentId),
})

export function retryWebhookEvent(eventId: string, input: { actorId: string; reason?: string }) {
  return manualRetryService(eventId, input)
}
