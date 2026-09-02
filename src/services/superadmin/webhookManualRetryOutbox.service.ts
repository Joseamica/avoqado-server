import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import type { WebhookLease } from '@/services/stripe-webhooks/platformWebhookInbox.service'

export type ManualRetryOutcome = 'SUCCEEDED' | 'FAILED' | 'REJECTED' | 'INTERRUPTED' | 'UNKNOWN'

export interface ManualRetryResultDeliveryLease {
  intentId: string
  deliveryAttempt: number
  deliveryClaimToken: string
  deliveryClaimedBy: string
  deliveryClaimedAt: Date
  deliveryClaimExpiresAt: Date
}

interface DispatchStartCommand {
  intentId: string
  lease: WebhookLease
  dispatchStartedAt: Date
}

interface RejectedCommand {
  intentId: string
  lease: WebhookLease
  now: Date
}

interface ClaimDueCommand {
  intentId?: string
  claimTokenPrefix: string
  claimedBy: string
  now: Date
  claimExpiresAt: Date
  limit: number
}

export interface WebhookManualRetryOutboxRepository {
  markDispatchStarted(command: DispatchStartCommand): Promise<boolean>
  settleRejected(command: RejectedCommand): Promise<boolean>
  claimDue(command: ClaimDueCommand): Promise<ManualRetryResultDeliveryLease[]>
  deliver(
    lease: ManualRetryResultDeliveryLease,
    now: Date,
  ): Promise<{ status: 'DELIVERED'; outcome: ManualRetryOutcome } | { status: 'WAITING' }>
  retryDelivery(lease: ManualRetryResultDeliveryLease, input: { now: Date; nextAttemptAt: Date }): Promise<boolean>
}

export class StaleManualRetryAuditIntentError extends Error {
  readonly code = 'STALE_MANUAL_RETRY_AUDIT_INTENT'

  constructor(intentId: string) {
    super(`Manual retry audit intent is stale: ${intentId}`)
    this.name = 'StaleManualRetryAuditIntentError'
  }
}

function nextDeliveryAt(now: Date, attempt: number): Date {
  return new Date(now.getTime() + Math.min(5 * 60_000, 2_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 10)))
}

export function createWebhookManualRetryOutboxService(dependencies: {
  repository: WebhookManualRetryOutboxRepository
  workerId: string
  now?: () => Date
  newClaimToken?: () => string
  deliveryLeaseMs?: number
}) {
  const now = dependencies.now ?? (() => new Date())
  const newClaimToken = dependencies.newClaimToken ?? randomUUID
  const deliveryLeaseMs = dependencies.deliveryLeaseMs ?? 2 * 60_000

  if (!dependencies.workerId.trim()) throw new Error('Manual retry audit workerId is required')

  async function retrySameCommand<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch {
      return operation()
    }
  }

  async function claim(intentId?: string): Promise<ManualRetryResultDeliveryLease[]> {
    const claimedAt = now()
    return dependencies.repository.claimDue({
      ...(intentId ? { intentId } : {}),
      claimTokenPrefix: newClaimToken(),
      claimedBy: dependencies.workerId,
      now: claimedAt,
      claimExpiresAt: new Date(claimedAt.getTime() + deliveryLeaseMs),
      limit: intentId ? 1 : 25,
    })
  }

  async function tryDelivery(lease: ManualRetryResultDeliveryLease) {
    const deliveryNow = now()
    try {
      const result = await dependencies.repository.deliver(lease, deliveryNow)
      if (result.status === 'DELIVERED') return { delivered: true as const, outcome: result.outcome }
      return { delivered: false as const, waiting: true as const }
    } catch {
      await dependencies.repository.retryDelivery(lease, {
        now: deliveryNow,
        nextAttemptAt: nextDeliveryAt(deliveryNow, lease.deliveryAttempt),
      })
      return { delivered: false as const, waiting: false as const }
    }
  }

  return {
    async markDispatchStarted(intentId: string, lease: WebhookLease): Promise<void> {
      const command = { intentId, lease, dispatchStartedAt: now() }
      const applied = await retrySameCommand(() => dependencies.repository.markDispatchStarted(command))
      if (!applied) throw new StaleManualRetryAuditIntentError(intentId)
    },

    async settleRejected(intentId: string, lease: WebhookLease): Promise<void> {
      const command = { intentId, lease, now: now() }
      const applied = await retrySameCommand(() => dependencies.repository.settleRejected(command))
      if (!applied) throw new StaleManualRetryAuditIntentError(intentId)
    },

    async deliverResult(intentId: string): Promise<{ delivered: boolean; outcome?: ManualRetryOutcome }> {
      const leases = await claim(intentId)
      const lease = leases[0]
      if (!lease) return { delivered: false }
      const result = await tryDelivery(lease)
      return result.delivered ? { delivered: true, outcome: result.outcome } : { delivered: false }
    },

    async deliverDueResults(): Promise<{ claimed: number; delivered: number; waiting: number; failed: number }> {
      const leases = await claim()
      let delivered = 0
      let waiting = 0
      let failed = 0
      for (const lease of leases) {
        const result = await tryDelivery(lease)
        if (result.delivered) delivered += 1
        else if (result.waiting) waiting += 1
        else failed += 1
      }
      return { claimed: leases.length, delivered, waiting, failed }
    },
  }
}

type RawPrisma = Pick<PrismaClient, '$queryRaw' | '$executeRaw' | '$transaction'>

function deliveryCas(lease: ManualRetryResultDeliveryLease, now: Date): Prisma.Sql {
  return Prisma.sql`
    id = ${lease.intentId}
    AND "deliveryClaimToken" = ${lease.deliveryClaimToken}
    AND "deliveryClaimedBy" = ${lease.deliveryClaimedBy}
    AND "deliveryClaimExpiresAt" > ${utcTs(now)}
    AND "deliveredAt" IS NULL
  `
}

export function createPrismaWebhookManualRetryOutboxRepository(db: RawPrisma): WebhookManualRetryOutboxRepository {
  return {
    async markDispatchStarted(command) {
      if (command.lease.phase !== 'EFFECT') return false
      const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "WebhookManualRetryResultOutbox"
        SET "dispatchStartedAt" = COALESCE("dispatchStartedAt", ${utcTs(command.dispatchStartedAt)}),
            "updatedAt" = ${utcTs(command.dispatchStartedAt)}
        WHERE id = ${command.intentId}
          AND "webhookEventId" = ${command.lease.eventId}
          AND "effectAttempt" = ${command.lease.attempt}
          AND "effectClaimToken" = ${command.lease.claimToken}
          AND "effectClaimedBy" = ${command.lease.claimedBy}
          AND "deliveredAt" IS NULL
          AND ("dispatchStartedAt" IS NULL OR "dispatchStartedAt" = ${utcTs(command.dispatchStartedAt)})
        RETURNING id
      `)
      return rows.length === 1
    },

    async settleRejected(command) {
      if (command.lease.phase !== 'EFFECT') return false
      const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "WebhookManualRetryResultOutbox"
        SET outcome = COALESCE(outcome, 'REJECTED'::"WebhookManualRetryOutcome"),
            "nextAttemptAt" = ${utcTs(command.now)},
            "updatedAt" = ${utcTs(command.now)}
        WHERE id = ${command.intentId}
          AND "webhookEventId" = ${command.lease.eventId}
          AND "effectAttempt" = ${command.lease.attempt}
          AND "effectClaimToken" = ${command.lease.claimToken}
          AND "dispatchStartedAt" IS NOT NULL
          AND "deliveredAt" IS NULL
          AND (outcome IS NULL OR outcome = 'REJECTED')
        RETURNING id
      `)
      return rows.length === 1
    },

    async claimDue(command) {
      const limit = Math.min(25, Math.max(1, Math.trunc(command.limit)))
      return db.$queryRaw<ManualRetryResultDeliveryLease[]>(Prisma.sql`
        WITH candidate AS MATERIALIZED (
          SELECT id, "nextAttemptAt" AS due_at, "createdAt" AS created_at
          FROM "WebhookManualRetryResultOutbox"
          WHERE (${command.intentId ?? null}::text IS NULL OR id = ${command.intentId ?? null})
            AND "deliveredAt" IS NULL
            AND "nextAttemptAt" <= ${utcTs(command.now)}
            AND ("deliveryClaimToken" IS NULL OR "deliveryClaimExpiresAt" <= ${utcTs(command.now)})
          ORDER BY "nextAttemptAt" ASC, "createdAt" ASC, id ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        ), claimed AS (
          UPDATE "WebhookManualRetryResultOutbox" outbox
          SET "deliveryAttempts" = outbox."deliveryAttempts" + 1,
              "deliveryClaimToken" = ${command.claimTokenPrefix} || ':' || outbox.id,
              "deliveryClaimedBy" = ${command.claimedBy},
              "deliveryClaimedAt" = ${utcTs(command.now)},
              "deliveryClaimExpiresAt" = ${utcTs(command.claimExpiresAt)},
              "updatedAt" = ${utcTs(command.now)}
          FROM candidate
          WHERE outbox.id = candidate.id
          RETURNING outbox.id AS "intentId", outbox."deliveryAttempts" AS "deliveryAttempt",
                    outbox."deliveryClaimToken", outbox."deliveryClaimedBy",
                    outbox."deliveryClaimedAt", outbox."deliveryClaimExpiresAt"
        )
        SELECT claimed.* FROM claimed JOIN candidate ON candidate.id = claimed."intentId"
        ORDER BY candidate.due_at ASC, candidate.created_at ASC, candidate.id ASC
      `)
    },

    async deliver(lease, now) {
      return db.$transaction(async tx => {
        const rows = await tx.$queryRaw<
          Array<{
            intentId: string
            webhookEventId: string
            actorId: string
            venueId: string | null
            reason: string
            requestActivityLogId: string
            resultActivityLogId: string
            effectAttempt: number
            effectClaimToken: string
            effectClaimedBy: string
            effectClaimExpiresAt: Date
            dispatchStartedAt: Date | null
            outcome: ManualRetryOutcome | null
            eventStatus: string
            eventEffectAttempts: number
            eventClaimPhase: string | null
            eventClaimToken: string | null
            eventClaimExpiresAt: Date | null
          }>
        >(Prisma.sql`
          SELECT outbox.id AS "intentId", outbox."webhookEventId", outbox."actorId", outbox."venueId", outbox.reason,
                 outbox."requestActivityLogId", outbox."resultActivityLogId", outbox."effectAttempt",
                 outbox."effectClaimToken", outbox."effectClaimedBy", outbox."effectClaimExpiresAt",
                 outbox."dispatchStartedAt", outbox.outcome,
                 event.status AS "eventStatus", event."effectAttempts" AS "eventEffectAttempts",
                 event."claimPhase" AS "eventClaimPhase", event."claimToken" AS "eventClaimToken",
                 event."claimExpiresAt" AS "eventClaimExpiresAt"
          FROM "WebhookManualRetryResultOutbox" outbox
          JOIN "WebhookEvent" event ON event.id = outbox."webhookEventId"
          WHERE outbox.${deliveryCas(lease, now)}
          FOR UPDATE OF outbox, event
        `)
        const row = rows[0]
        if (!row) throw new StaleManualRetryAuditIntentError(lease.intentId)

        const observations = await tx.$queryRaw<Array<{ effectOutcome: string }>>(Prisma.sql`
          SELECT "effectOutcome"
          FROM "WebhookDispatchObservation"
          WHERE "webhookEventId" = ${row.webhookEventId}
            AND "effectAttempt" = ${row.effectAttempt}
          LIMIT 1
        `)
        const observation = observations[0]
        let outcome = row.outcome
        if (!outcome && observation) {
          if (observation.effectOutcome === 'SUCCESS') outcome = 'SUCCEEDED'
          else if (observation.effectOutcome === 'FAILED') outcome = 'FAILED'
          else throw new Error('Manual retry observation has unknown outcome')
        }

        if (!outcome) {
          const sameLiveEffectLease =
            row.eventStatus === 'RETRYING' &&
            row.eventEffectAttempts === row.effectAttempt &&
            row.eventClaimPhase === 'EFFECT' &&
            row.eventClaimToken === row.effectClaimToken &&
            row.eventClaimExpiresAt !== null &&
            row.eventClaimExpiresAt.getTime() > now.getTime()
          if (sameLiveEffectLease) {
            const due = new Date(row.eventClaimExpiresAt!.getTime() + 1)
            const waiting = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
              UPDATE "WebhookManualRetryResultOutbox"
              SET "nextAttemptAt" = ${utcTs(due)},
                  "deliveryClaimToken" = NULL, "deliveryClaimedBy" = NULL,
                  "deliveryClaimedAt" = NULL, "deliveryClaimExpiresAt" = NULL,
                  "updatedAt" = ${utcTs(now)}
              WHERE ${deliveryCas(lease, now)}
              RETURNING id
            `)
            if (waiting.length !== 1) throw new StaleManualRetryAuditIntentError(lease.intentId)
            return { status: 'WAITING' as const }
          }
          outcome = row.dispatchStartedAt === null ? 'INTERRUPTED' : 'UNKNOWN'
        }

        const actionByOutcome: Record<ManualRetryOutcome, string> = {
          SUCCEEDED: 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_SUCCEEDED',
          FAILED: 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_FAILED',
          REJECTED: 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_REJECTED',
          INTERRUPTED: 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_INTERRUPTED',
          UNKNOWN: 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_UNKNOWN',
        }
        const codeByOutcome: Record<ManualRetryOutcome, string> = {
          SUCCEEDED: 'WEBHOOK_EFFECT_RETRY_SUCCEEDED',
          FAILED: 'WEBHOOK_EFFECT_ATTEMPT_FAILED',
          REJECTED: 'WEBHOOK_LEASE_BUSY',
          INTERRUPTED: 'WEBHOOK_EFFECT_RETRY_INTERRUPTED',
          UNKNOWN: 'WEBHOOK_EFFECT_RETRY_UNKNOWN',
        }
        const data = {
          phase: 'EFFECT',
          attempt: row.effectAttempt,
          code: codeByOutcome[outcome],
          reason: row.reason,
          actorId: row.actorId,
          venueId: row.venueId,
          intentId: row.intentId,
          requestActivityLogId: row.requestActivityLogId,
          resultActivityLogId: row.resultActivityLogId,
        }
        const serializedData = JSON.stringify(data)
        const principals = await tx.$queryRaw<Array<{ staffId: string | null; venueId: string | null }>>(Prisma.sql`
          SELECT
            (SELECT id FROM "Staff" WHERE id = ${row.actorId}) AS "staffId",
            (SELECT id FROM "Venue" WHERE id = ${row.venueId}) AS "venueId"
        `)
        const staffId = principals[0]?.staffId ?? null
        const venueId = principals[0]?.venueId ?? null
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "ActivityLog" (id, "staffId", "venueId", action, entity, "entityId", data)
          VALUES (
            ${row.resultActivityLogId}, ${staffId}, ${venueId}, ${actionByOutcome[outcome]},
            'WebhookEvent', ${row.webhookEventId}, ${serializedData}::jsonb
          )
          ON CONFLICT (id) DO NOTHING
        `)
        const audit = await tx.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
          SELECT EXISTS (
            SELECT 1 FROM "ActivityLog"
            WHERE id = ${row.resultActivityLogId}
              AND "staffId" IS NOT DISTINCT FROM ${staffId}
              AND "venueId" IS NOT DISTINCT FROM ${venueId}
              AND action = ${actionByOutcome[outcome]}
              AND entity = 'WebhookEvent'
              AND "entityId" = ${row.webhookEventId}
              AND data = ${serializedData}::jsonb
          ) AS valid
        `)
        if (audit[0]?.valid !== true) throw new Error(`Manual retry result ActivityLog conflict: ${row.resultActivityLogId}`)

        const delivered = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "WebhookManualRetryResultOutbox"
          SET outcome = ${outcome}::"WebhookManualRetryOutcome",
              "deliveredAt" = ${utcTs(now)}, "nextAttemptAt" = NULL,
              "deliveryClaimToken" = NULL, "deliveryClaimedBy" = NULL,
              "deliveryClaimedAt" = NULL, "deliveryClaimExpiresAt" = NULL,
              "updatedAt" = ${utcTs(now)}
          WHERE ${deliveryCas(lease, now)}
          RETURNING id
        `)
        if (delivered.length !== 1) throw new StaleManualRetryAuditIntentError(lease.intentId)
        return { status: 'DELIVERED' as const, outcome }
      })
    },

    async retryDelivery(lease, input) {
      const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "WebhookManualRetryResultOutbox"
        SET "nextAttemptAt" = ${utcTs(input.nextAttemptAt)},
            "deliveryClaimToken" = NULL, "deliveryClaimedBy" = NULL,
            "deliveryClaimedAt" = NULL, "deliveryClaimExpiresAt" = NULL,
            "updatedAt" = ${utcTs(input.now)}
        WHERE ${deliveryCas(lease, input.now)}
        RETURNING id
      `)
      return rows.length === 1
    },
  }
}

const manualRetryAuditWorkerId = `manual-webhook-retry-audit:${os.hostname()}:${process.pid}`

export const webhookManualRetryOutbox = createWebhookManualRetryOutboxService({
  repository: createPrismaWebhookManualRetryOutboxRepository(prisma),
  workerId: manualRetryAuditWorkerId,
})
