import { createHash } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import type { CommercialBillingTransactionHost } from './cashReceipt.service'

interface LockedZeroAmountPeriodRow {
  periodId: string
  periodStatus: string
  periodStatusRevision: number
  amountDueMinor: bigint
  contractId: string
  contractStatus: string
  acceptanceStatus: string
  organizationId: string
  venueId: string
  receivableId: string
  receivableStatus: string
  receivableAmountDueMinor: bigint
  activeAllocatedMinor: bigint
}

function requiredId(value: string, code: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(code)
  return value
}

function validDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('COMMERCIAL_BILLING_NON_CASH_NOW_INVALID')
  }
}

function nonCashEventId(periodId: string, revision: number): string {
  return createHash('sha256')
    .update(`avoqado:commercial-billing:period:${periodId}:revision:${revision}:non-cash-activated`)
    .digest('hex')
}

export async function activateCommercialZeroAmountPeriod(
  input: { organizationId: string; venueId: string; periodId: string; now: Date },
  dependencies: { host?: CommercialBillingTransactionHost } = {},
): Promise<{ decision: 'ACTIVATED' | 'REPLAY'; periodId: string; sourceRevision: number; eventId: string }> {
  requiredId(input.organizationId, 'COMMERCIAL_BILLING_ORGANIZATION_ID_INVALID')
  requiredId(input.venueId, 'COMMERCIAL_BILLING_VENUE_ID_INVALID')
  requiredId(input.periodId, 'COMMERCIAL_BILLING_SUBSCRIPTION_PERIOD_ID_INVALID')
  validDate(input.now)
  const host = dependencies.host ?? (prisma as PrismaClient)

  return host.$transaction(async tx => {
    const [row] = await tx.$queryRawUnsafe<LockedZeroAmountPeriodRow[]>(
      `SELECT period."id" AS "periodId", period."status"::text AS "periodStatus",
              period."statusRevision" AS "periodStatusRevision", period."amountDueMinor",
              contract."id" AS "contractId", contract."status"::text AS "contractStatus",
              acceptance."status"::text AS "acceptanceStatus",
              contract."organizationId", contract."venueId",
              ar."id" AS "receivableId", ar."status"::text AS "receivableStatus",
              ar."amountDueMinor" AS "receivableAmountDueMinor",
              COALESCE((
                SELECT SUM(CASE WHEN allocation."direction" = 'CREDIT'
                                THEN allocation."amountMinor" ELSE -allocation."amountMinor" END)
                  FROM "CommercialBillingAllocation" AS allocation
                 WHERE allocation."receivableId" = ar."id"
              ), 0)::bigint AS "activeAllocatedMinor"
         FROM "CommercialSubscriptionPeriod" AS period
         JOIN "CommercialSubscriptionContract" AS contract ON contract."id" = period."contractId"
         JOIN "CommercialQuoteAcceptance" AS acceptance ON acceptance."id" = contract."quoteAcceptanceId"
         JOIN "CommercialAccountReceivable" AS ar ON ar."subscriptionPeriodId" = period."id"
        WHERE period."id" = $1
        FOR UPDATE OF period, contract, acceptance, ar`,
      input.periodId,
    )
    if (!row) throw new Error('COMMERCIAL_BILLING_SUBSCRIPTION_PERIOD_NOT_FOUND')
    if (row.organizationId !== input.organizationId || row.venueId !== input.venueId) {
      throw new Error('COMMERCIAL_BILLING_NON_CASH_TENANT_MISMATCH')
    }
    if (row.amountDueMinor !== 0n || row.receivableAmountDueMinor !== 0n) {
      throw new Error('COMMERCIAL_BILLING_NON_CASH_AMOUNT_NOT_ZERO')
    }
    if (row.activeAllocatedMinor !== 0n) {
      throw new Error('COMMERCIAL_BILLING_NON_CASH_ALLOCATION_FORBIDDEN')
    }

    const existingEvent = await tx.commercialEventOutbox.findFirst({
      where: {
        sourceType: 'SUBSCRIPTION_PERIOD',
        sourceId: input.periodId,
        eventType: 'SUBSCRIPTION_NON_CASH_ACTIVATED',
      },
      orderBy: { sourceRevision: 'desc' },
      select: { eventId: true, sourceRevision: true },
    })
    if (row.periodStatus === 'PAID' && row.receivableStatus === 'PAID') {
      if (!existingEvent || existingEvent.sourceRevision !== row.periodStatusRevision) {
        throw new Error('COMMERCIAL_BILLING_NON_CASH_REPLAY_INCOMPLETE')
      }
      return {
        decision: 'REPLAY',
        periodId: input.periodId,
        sourceRevision: existingEvent.sourceRevision,
        eventId: existingEvent.eventId,
      }
    }
    if (
      existingEvent ||
      row.periodStatus !== 'OPEN' ||
      row.receivableStatus !== 'OPEN' ||
      row.acceptanceStatus !== 'ACCEPTED' ||
      !['PENDING_PAYMENT', 'ACTIVE'].includes(row.contractStatus)
    ) {
      throw new Error('COMMERCIAL_BILLING_NON_CASH_NOT_ELIGIBLE')
    }

    const sourceRevision = row.periodStatusRevision + 1
    const updated = await tx.commercialSubscriptionPeriod.updateMany({
      where: {
        id: input.periodId,
        status: 'OPEN',
        statusRevision: row.periodStatusRevision,
        amountDueMinor: 0n,
      },
      data: { status: 'PAID', statusRevision: sourceRevision, paidAt: input.now },
    })
    if (updated.count !== 1) throw new Error('COMMERCIAL_BILLING_NON_CASH_CONCURRENCY_CONFLICT')
    await tx.commercialAccountReceivable.update({
      where: { id: row.receivableId },
      data: { status: 'PAID' },
    })

    const eventId = nonCashEventId(input.periodId, sourceRevision)
    await tx.commercialEventOutbox.create({
      data: {
        eventId,
        organizationId: input.organizationId,
        venueId: input.venueId,
        sourceType: 'SUBSCRIPTION_PERIOD',
        sourceId: input.periodId,
        sourceRevision,
        eventType: 'SUBSCRIPTION_NON_CASH_ACTIVATED',
        payload: {
          schemaVersion: 1,
          contractId: row.contractId,
          periodId: input.periodId,
          sourceRevision,
          activationBasis: 'ZERO_AMOUNT_ACCEPTED_OFFER',
          amountDueMinor: '0',
        },
      },
    })
    await tx.activityLog.create({
      data: {
        organizationId: input.organizationId,
        venueId: input.venueId,
        actorType: 'SERVICE',
        servicePrincipalId: 'commercial-zero-amount-activation',
        action: 'COMMERCIAL_SUBSCRIPTION_NON_CASH_ACTIVATED',
        entity: 'CommercialSubscriptionPeriod',
        entityId: input.periodId,
        data: {
          schemaVersion: 1,
          contractId: row.contractId,
          sourceRevision,
          activationBasis: 'ZERO_AMOUNT_ACCEPTED_OFFER',
          eventId,
        },
      },
    })
    return { decision: 'ACTIVATED', periodId: input.periodId, sourceRevision, eventId }
  }, {
    maxWait: 5_000,
    timeout: 30_000,
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  })
}
