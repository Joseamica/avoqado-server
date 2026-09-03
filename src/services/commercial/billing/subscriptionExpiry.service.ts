import { Prisma, type PrismaClient } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import type { CommercialBillingTransactionHost } from './cashReceipt.service'

const MAX_EXPIRY_BATCH = 100

interface LockedExpiredPeriodRow {
  periodId: string
  contractId: string
  organizationId: string
  venueId: string
  previousPeriodStatus: 'OPEN' | 'PAST_DUE'
  previousReceivableStatus: 'OPEN' | 'PARTIALLY_PAID' | 'PAST_DUE'
  receivableId: string
  amountDueMinor: bigint
  activeAllocatedMinor: bigint
  graceEndsAt: Date
}

export interface SweepExpiredCommercialSubscriptionPeriodsInput {
  /** Test-only clock override. Production omits it and uses PostgreSQL. */
  now?: Date
  limit: number
}

export interface SweepExpiredCommercialSubscriptionPeriodsResult {
  claimed: number
  expired: number
  contractsPaused: number
}

function assertInput(input: SweepExpiredCommercialSubscriptionPeriodsInput): void {
  if (input.now !== undefined && (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime()))) {
    throw new Error('COMMERCIAL_BILLING_EXPIRY_NOW_INVALID')
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_EXPIRY_BATCH) {
    throw new Error('COMMERCIAL_BILLING_EXPIRY_LIMIT_INVALID')
  }
}

/**
 * Expires only subscription periods whose grace window has elapsed and whose
 * canonical cash allocations still leave a balance. The transaction locks a
 * bounded batch with SKIP LOCKED so multiple server instances can run safely.
 *
 * PAUSED is deliberately reversible: a late reconciled payment can move the
 * same contract back to ACTIVE through the existing entitlement projector.
 * No customer data or immutable commercial terms are deleted.
 */
export async function sweepExpiredCommercialSubscriptionPeriods(
  input: SweepExpiredCommercialSubscriptionPeriodsInput,
  dependencies: { host?: CommercialBillingTransactionHost } = {},
): Promise<SweepExpiredCommercialSubscriptionPeriodsResult> {
  assertInput(input)
  const host = dependencies.host ?? (prisma as PrismaClient)

  return host.$transaction(
    async tx => {
      const databaseClock = input.now
        ? null
        : (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`)[0]?.now
      const now = input.now ?? databaseClock
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new Error('COMMERCIAL_BILLING_EXPIRY_DATABASE_CLOCK_INVALID')
      }
      const rows = await tx.$queryRawUnsafe<LockedExpiredPeriodRow[]>(
        `SELECT period."id" AS "periodId",
                period."contractId",
                contract."organizationId",
                contract."venueId",
                period."status"::text AS "previousPeriodStatus",
                receivable."status"::text AS "previousReceivableStatus",
                receivable."id" AS "receivableId",
                receivable."amountDueMinor",
                COALESCE(allocation."activeAllocatedMinor", 0)::bigint AS "activeAllocatedMinor",
                period."graceEndsAt"
           FROM "CommercialSubscriptionPeriod" AS period
           JOIN "CommercialSubscriptionContract" AS contract
             ON contract."id" = period."contractId"
           JOIN "CommercialAccountReceivable" AS receivable
             ON receivable."subscriptionPeriodId" = period."id"
           LEFT JOIN LATERAL (
             SELECT COALESCE(SUM(
               CASE WHEN item."direction" = 'CREDIT'
                    THEN item."amountMinor"
                    ELSE -item."amountMinor"
               END
             ), 0)::bigint AS "activeAllocatedMinor"
               FROM "CommercialBillingAllocation" AS item
              WHERE item."receivableId" = receivable."id"
           ) AS allocation ON TRUE
          WHERE period."status" IN ('OPEN', 'PAST_DUE')
            AND receivable."status" IN ('OPEN', 'PARTIALLY_PAID', 'PAST_DUE')
            AND period."graceEndsAt" < $1
            AND COALESCE(allocation."activeAllocatedMinor", 0) < receivable."amountDueMinor"
          ORDER BY period."graceEndsAt" ASC, period."id" ASC
          FOR UPDATE OF period, contract, receivable SKIP LOCKED
          LIMIT $2`,
        now,
        input.limit,
      )

      let contractsPaused = 0
      for (const row of rows) {
        if (row.activeAllocatedMinor < 0n || row.activeAllocatedMinor > row.amountDueMinor) {
          throw new Error('COMMERCIAL_BILLING_EXPIRY_ALLOCATION_INVARIANT')
        }
        const outstandingMinor = row.amountDueMinor - row.activeAllocatedMinor

        await tx.commercialSubscriptionPeriod.update({
          where: { id: row.periodId },
          data: { status: 'EXPIRED', statusRevision: { increment: 1 } },
        })
        await tx.commercialAccountReceivable.update({
          where: { id: row.receivableId },
          data: { status: 'EXPIRED' },
        })

        const currentPaidCoverage = await tx.commercialSubscriptionPeriod.findFirst({
          where: {
            contractId: row.contractId,
            status: 'PAID',
            startsAt: { lte: now },
            endsAt: { gt: now },
          },
          select: { id: true },
        })
        const contractTransition = currentPaidCoverage
          ? null
          : await tx.commercialSubscriptionContract.updateMany({
              where: { id: row.contractId, status: { in: ['PENDING_PAYMENT', 'ACTIVE'] } },
              data: { status: 'PAUSED' },
            })
        const paused = contractTransition?.count === 1
        if (paused) contractsPaused += 1

        await tx.activityLog.create({
          data: {
            organizationId: row.organizationId,
            venueId: row.venueId,
            actorType: 'SERVICE',
            servicePrincipalId: 'commercial-subscription-expiry',
            action: 'COMMERCIAL_SUBSCRIPTION_PERIOD_EXPIRED',
            entity: 'CommercialSubscriptionPeriod',
            entityId: row.periodId,
            data: {
              schemaVersion: 1,
              contractId: row.contractId,
              receivableId: row.receivableId,
              previousPeriodStatus: row.previousPeriodStatus,
              previousReceivableStatus: row.previousReceivableStatus,
              graceEndsAt: row.graceEndsAt.toISOString(),
              expiredAt: now.toISOString(),
              amountDueMinor: row.amountDueMinor.toString(),
              activeAllocatedMinor: row.activeAllocatedMinor.toString(),
              outstandingMinor: outstandingMinor.toString(),
              contractPaused: paused,
              effectiveFallback: currentPaidCoverage ? 'PAID_COVERAGE_REMAINS' : 'FREE',
              customerDataDeleted: false,
            },
          },
        })
      }

      return { claimed: rows.length, expired: rows.length, contractsPaused }
    },
    {
      maxWait: 5_000,
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  )
}
