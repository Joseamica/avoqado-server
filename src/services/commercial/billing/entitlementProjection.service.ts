import { Prisma, type PrismaClient } from '@prisma/client'

import type {
  CommercialBillingScheduleKeyV1,
  CommercialEntitlementProjectionPlan,
  ProjectCommercialPaidEntitlementsInput,
  ProjectCommercialPaidEntitlementsResult,
  ProjectCommercialReversedEntitlementsInput,
  ProjectCommercialReversedEntitlementsResult,
  CommercialSubscriptionContractSnapshotV1,
  CommercialSubscriptionEntitlementPeriod,
} from '@/types/commercialBilling'
import prisma from '@/utils/prismaClient'
import type { CommercialBillingTransactionHost } from './cashReceipt.service'
import { assertCommercialBillingContractSnapshotV1, checksumCommercialBillingContractSnapshotV1 } from './subscriptionContract.service'

function requiredDate(value: Date, code: string): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(code)
  return value.getTime()
}

export function buildCommercialEntitlementProjectionPlan(input: {
  snapshot: CommercialSubscriptionContractSnapshotV1
  periods: readonly CommercialSubscriptionEntitlementPeriod[]
}): CommercialEntitlementProjectionPlan {
  const coverageStartsAt = new Date(input.snapshot.startsAt)
  const coverageStartMillis = requiredDate(coverageStartsAt, 'COMMERCIAL_ENTITLEMENT_CONTRACT_START_INVALID')
  const scheduleKeys = new Set(input.snapshot.schedules.map(schedule => schedule.scheduleKey))
  const periodIds = new Set<string>()
  const periodSequences = new Set<string>()

  for (const period of input.periods) {
    if (!scheduleKeys.has(period.scheduleKey)) throw new Error('COMMERCIAL_ENTITLEMENT_PERIOD_SCHEDULE_INVALID')
    if (typeof period.id !== 'string' || period.id.trim() === '' || periodIds.has(period.id)) {
      throw new Error('COMMERCIAL_ENTITLEMENT_PERIOD_ID_INVALID')
    }
    periodIds.add(period.id)
    if (!Number.isSafeInteger(period.sequence) || period.sequence < 1) {
      throw new Error('COMMERCIAL_ENTITLEMENT_PERIOD_SEQUENCE_INVALID')
    }
    const sequenceKey = `${period.scheduleKey}:${period.sequence}`
    if (periodSequences.has(sequenceKey)) throw new Error('COMMERCIAL_ENTITLEMENT_PERIOD_SEQUENCE_DUPLICATED')
    periodSequences.add(sequenceKey)
    const startsAt = requiredDate(period.startsAt, 'COMMERCIAL_ENTITLEMENT_PERIOD_START_INVALID')
    const endsAt = requiredDate(period.endsAt, 'COMMERCIAL_ENTITLEMENT_PERIOD_END_INVALID')
    if (endsAt <= startsAt) throw new Error('COMMERCIAL_ENTITLEMENT_PERIOD_WINDOW_INVALID')
  }

  const coverageBySchedule = new Map<CommercialBillingScheduleKeyV1, { coverageEndsAt: Date; sourcePeriodIds: string[] }>()
  for (const scheduleKey of scheduleKeys) {
    const candidates = input.periods
      .filter(period => period.scheduleKey === scheduleKey)
      .sort((left, right) => left.sequence - right.sequence)
    let expectedSequence = 1
    let expectedStartMillis = coverageStartMillis
    const sourcePeriodIds: string[] = []

    for (const period of candidates) {
      if (period.sequence !== expectedSequence || period.status !== 'PAID' || period.startsAt.getTime() !== expectedStartMillis) {
        break
      }
      sourcePeriodIds.push(period.id)
      expectedSequence += 1
      expectedStartMillis = period.endsAt.getTime()
    }
    if (sourcePeriodIds.length > 0) {
      coverageBySchedule.set(scheduleKey, {
        coverageEndsAt: new Date(expectedStartMillis),
        sourcePeriodIds,
      })
    }
  }

  const grants = input.snapshot.entitlements
    .map(entitlement => {
      const requiredScheduleKeys = [...entitlement.requiredScheduleKeys].sort()
      if (requiredScheduleKeys.length === 0 || new Set(requiredScheduleKeys).size !== requiredScheduleKeys.length) {
        throw new Error('COMMERCIAL_ENTITLEMENT_REQUIREMENTS_INVALID')
      }
      const requiredCoverage = requiredScheduleKeys.map(scheduleKey => {
        if (!scheduleKeys.has(scheduleKey)) throw new Error('COMMERCIAL_ENTITLEMENT_REQUIREMENT_SCHEDULE_INVALID')
        return coverageBySchedule.get(scheduleKey)
      })
      if (requiredCoverage.some(coverage => coverage === undefined)) return null
      const completeCoverage = requiredCoverage.filter((coverage): coverage is NonNullable<typeof coverage> => coverage !== undefined)
      const coverageEndsAt = new Date(Math.min(...completeCoverage.map(coverage => coverage.coverageEndsAt.getTime())))
      if (coverageEndsAt.getTime() <= coverageStartMillis) return null
      return {
        featureCode: entitlement.featureCode,
        coverageStartsAt,
        coverageEndsAt,
        requiredScheduleKeys,
        sourcePeriodIds: completeCoverage.flatMap(coverage => coverage.sourcePeriodIds),
      }
    })
    .filter((grant): grant is NonNullable<typeof grant> => grant !== null)
    .sort((left, right) => left.featureCode.localeCompare(right.featureCode))

  return { grants }
}

export function buildCommercialEntitlementReversalPlan(input: {
  currentPlan: CommercialEntitlementProjectionPlan
  previousEffectiveGrants: ReadonlyArray<{
    featureCode: string
    coverageStartsAt: Date
    coverageEndsAt: Date
  }>
}): {
  revocations: Array<{
    featureCode: string
    coverageStartsAt: Date
    coverageEndsAt: Date
  }>
} {
  const currentByFeature = new Map(input.currentPlan.grants.map(grant => [grant.featureCode, grant]))
  const seen = new Set<string>()
  const revocations: Array<{
    featureCode: string
    coverageStartsAt: Date
    coverageEndsAt: Date
  }> = []

  for (const previous of input.previousEffectiveGrants) {
    if (typeof previous.featureCode !== 'string' || previous.featureCode.trim() === '' || seen.has(previous.featureCode)) {
      throw new Error('COMMERCIAL_ENTITLEMENT_PREVIOUS_GRANT_INVALID')
    }
    seen.add(previous.featureCode)
    const previousStartsAt = requiredDate(previous.coverageStartsAt, 'COMMERCIAL_ENTITLEMENT_PREVIOUS_GRANT_START_INVALID')
    const previousEndsAt = requiredDate(previous.coverageEndsAt, 'COMMERCIAL_ENTITLEMENT_PREVIOUS_GRANT_END_INVALID')
    if (previousEndsAt <= previousStartsAt) throw new Error('COMMERCIAL_ENTITLEMENT_PREVIOUS_GRANT_WINDOW_INVALID')

    const current = currentByFeature.get(previous.featureCode)
    const revokeStartsAt = current?.coverageEndsAt ?? previous.coverageStartsAt
    if (revokeStartsAt.getTime() >= previousEndsAt) continue
    revocations.push({
      featureCode: previous.featureCode,
      coverageStartsAt: revokeStartsAt,
      coverageEndsAt: previous.coverageEndsAt,
    })
  }

  revocations.sort((left, right) => left.featureCode.localeCompare(right.featureCode))
  return { revocations }
}

interface LockedPaidEntitlementEventRow {
  eventId: string
  organizationId: string | null
  venueId: string | null
  sourceType: string
  sourceId: string
  sourceRevision: number
  eventType: string
  periodStatus: string
  periodStatusRevision: number
  contractId: string
  contractStatus: string
  contractSnapshot: CommercialSubscriptionContractSnapshotV1
  contractChecksum: string
  acceptedById: string
}

function requiredId(value: string, code: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(code)
  return value
}

function validNow(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('COMMERCIAL_ENTITLEMENT_PROJECTION_NOW_INVALID')
  }
}

async function loadOrganizationFeatureCoverage(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; featureCode: string },
): Promise<Array<{ coverageStartsAt: Date; coverageEndsAt: Date }>> {
  const contracts = await tx.commercialSubscriptionContract.findMany({
    where: {
      organizationId: input.organizationId,
      status: { in: ['PENDING_PAYMENT', 'ACTIVE', 'PAUSED'] },
    },
    select: {
      id: true,
      snapshot: true,
      checksum: true,
      periods: {
        orderBy: [{ scheduleKey: 'asc' }, { sequence: 'asc' }],
        select: {
          id: true,
          scheduleKey: true,
          sequence: true,
          startsAt: true,
          endsAt: true,
          status: true,
        },
      },
    },
  })
  const organizationCoverage: Array<{ coverageStartsAt: Date; coverageEndsAt: Date }> = []
  for (const contract of contracts) {
    const contractSnapshot = contract.snapshot as unknown as CommercialSubscriptionContractSnapshotV1
    assertCommercialBillingContractSnapshotV1(contractSnapshot)
    if (
      checksumCommercialBillingContractSnapshotV1(contractSnapshot) !== contract.checksum ||
      contractSnapshot.organizationId !== input.organizationId
    ) {
      throw new Error('COMMERCIAL_ENTITLEMENT_ORGANIZATION_CONTRACT_MISMATCH')
    }
    const contractPlan = buildCommercialEntitlementProjectionPlan({
      snapshot: contractSnapshot,
      periods: contract.periods.map(period => ({
        ...period,
        scheduleKey: period.scheduleKey as CommercialBillingScheduleKeyV1,
      })),
    })
    const coverage = contractPlan.grants.find(grant => grant.featureCode === input.featureCode)
    if (coverage) organizationCoverage.push(coverage)
  }
  return organizationCoverage
}

async function rebuildOrganizationContractEntitlement(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    featureCode: string
    acceptedById: string
    reason: string
  },
): Promise<boolean> {
  const organizationCoverage = await loadOrganizationFeatureCoverage(tx, input)
  if (organizationCoverage.length === 0) return false

  const startsAt = new Date(Math.min(...organizationCoverage.map(coverage => coverage.coverageStartsAt.getTime())))
  const endsAt = new Date(Math.max(...organizationCoverage.map(coverage => coverage.coverageEndsAt.getTime())))
  const existingEntitlement = await tx.organizationEntitlement.findUnique({
    where: {
      organizationId_featureCode: {
        organizationId: input.organizationId,
        featureCode: input.featureCode,
      },
    },
    select: { source: true },
  })
  if (existingEntitlement?.source === 'CUSTOM') return true

  await tx.organizationEntitlement.upsert({
    where: {
      organizationId_featureCode: {
        organizationId: input.organizationId,
        featureCode: input.featureCode,
      },
    },
    create: {
      organizationId: input.organizationId,
      featureCode: input.featureCode,
      status: 'ACTIVE',
      source: 'CONTRACT',
      startsAt,
      endsAt,
      grantedById: input.acceptedById,
      reason: input.reason,
    },
    update: {
      status: 'ACTIVE',
      source: 'CONTRACT',
      startsAt,
      endsAt,
      reason: input.reason,
    },
  })
  return true
}

export async function projectCommercialPaidEntitlements(
  input: ProjectCommercialPaidEntitlementsInput,
  dependencies: { host?: CommercialBillingTransactionHost } = {},
): Promise<ProjectCommercialPaidEntitlementsResult> {
  requiredId(input.eventId, 'COMMERCIAL_ENTITLEMENT_EVENT_ID_INVALID')
  validNow(input.now)
  const host = dependencies.host ?? (prisma as PrismaClient)

  return host.$transaction(
    async tx => {
      const [event] = await tx.$queryRawUnsafe<LockedPaidEntitlementEventRow[]>(
        `SELECT outbox."eventId", outbox."organizationId", outbox."venueId",
              outbox."sourceType"::text, outbox."sourceId", outbox."sourceRevision",
              outbox."eventType"::text,
              period."status"::text AS "periodStatus",
              period."statusRevision" AS "periodStatusRevision",
              contract."id" AS "contractId", contract."status"::text AS "contractStatus",
              contract."snapshot" AS "contractSnapshot", contract."checksum" AS "contractChecksum",
              acceptance."acceptedById"
         FROM "CommercialEventOutbox" AS outbox
         JOIN "CommercialSubscriptionPeriod" AS period ON period."id" = outbox."sourceId"
         JOIN "CommercialSubscriptionContract" AS contract ON contract."id" = period."contractId"
         JOIN "CommercialQuoteAcceptance" AS acceptance ON acceptance."id" = contract."quoteAcceptanceId"
        WHERE outbox."eventId" = $1
        FOR UPDATE OF outbox, period, contract`,
        input.eventId,
      )
      if (!event) throw new Error('COMMERCIAL_ENTITLEMENT_EVENT_NOT_FOUND')
      if (
        !['SUBSCRIPTION_PAYMENT_RECONCILED', 'SUBSCRIPTION_NON_CASH_ACTIVATED'].includes(event.eventType) ||
        event.sourceType !== 'SUBSCRIPTION_PERIOD' ||
        !event.organizationId ||
        !event.venueId
      ) {
        throw new Error('COMMERCIAL_ENTITLEMENT_EVENT_NOT_ELIGIBLE')
      }

      const snapshot = event.contractSnapshot
      assertCommercialBillingContractSnapshotV1(snapshot)
      if (
        checksumCommercialBillingContractSnapshotV1(snapshot) !== event.contractChecksum ||
        snapshot.organizationId !== event.organizationId ||
        snapshot.venueId !== event.venueId
      ) {
        throw new Error('COMMERCIAL_ENTITLEMENT_CONTRACT_MISMATCH')
      }

      const existingForEvent = await tx.commercialEntitlementProjection.findMany({
        where: { eventId: input.eventId },
        orderBy: { featureCode: 'asc' },
        select: { featureCode: true, coverageStartsAt: true, coverageEndsAt: true },
      })
      if (existingForEvent.length > 0) {
        return {
          decision: 'REPLAY',
          eventId: input.eventId,
          grants: existingForEvent,
        }
      }
      if (
        event.periodStatus !== 'PAID' ||
        event.periodStatusRevision !== event.sourceRevision ||
        !['PENDING_PAYMENT', 'ACTIVE', 'PAUSED'].includes(event.contractStatus)
      ) {
        throw new Error('COMMERCIAL_ENTITLEMENT_EVENT_NOT_ELIGIBLE')
      }

      const periods = await tx.commercialSubscriptionPeriod.findMany({
        where: { contractId: event.contractId },
        orderBy: [{ scheduleKey: 'asc' }, { sequence: 'asc' }],
        select: {
          id: true,
          scheduleKey: true,
          sequence: true,
          startsAt: true,
          endsAt: true,
          status: true,
        },
      })
      const plan = buildCommercialEntitlementProjectionPlan({
        snapshot,
        periods: periods.map(period => ({
          ...period,
          scheduleKey: period.scheduleKey as CommercialBillingScheduleKeyV1,
        })),
      })

      const projected: ProjectCommercialPaidEntitlementsResult['grants'] = []
      for (const grant of plan.grants) {
        const advisoryKey = `${event.organizationId}:${grant.featureCode}`
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, advisoryKey)

        const projectionHistory = await tx.commercialEntitlementProjection.findMany({
          where: {
            contractId: event.contractId,
            featureCode: grant.featureCode,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            featureCode: true,
            action: true,
            coverageStartsAt: true,
            coverageEndsAt: true,
          },
        })
        const effectiveGrant = effectiveGrantsFromProjectionHistory(
          projectionHistory.map(row => ({
            ...row,
            action: row.action as 'GRANT' | 'REVOKE',
          })),
        ).find(row => row.featureCode === grant.featureCode)
        if (
          effectiveGrant &&
          effectiveGrant.coverageStartsAt.getTime() <= grant.coverageStartsAt.getTime() &&
          effectiveGrant.coverageEndsAt.getTime() >= grant.coverageEndsAt.getTime()
        ) {
          continue
        }

        await tx.commercialEntitlementProjection.create({
          data: {
            eventId: input.eventId,
            organizationId: event.organizationId,
            venueId: event.venueId,
            contractId: event.contractId,
            subscriptionPeriodId: event.sourceId,
            sourceRevision: event.sourceRevision,
            featureCode: grant.featureCode,
            action: 'GRANT',
            coverageStartsAt: grant.coverageStartsAt,
            coverageEndsAt: grant.coverageEndsAt,
          },
        })
        const rebuilt = await rebuildOrganizationContractEntitlement(tx, {
          organizationId: event.organizationId,
          featureCode: grant.featureCode,
          acceptedById: event.acceptedById,
          reason: `Commercial billing projection ${input.eventId}`,
        })
        if (!rebuilt) throw new Error('COMMERCIAL_ENTITLEMENT_PAID_COVERAGE_MISSING')
        projected.push({
          featureCode: grant.featureCode,
          coverageStartsAt: grant.coverageStartsAt,
          coverageEndsAt: grant.coverageEndsAt,
        })
      }

      if (projected.length > 0) {
        if (['PENDING_PAYMENT', 'PAUSED'].includes(event.contractStatus)) {
          await tx.commercialSubscriptionContract.update({
            where: { id: event.contractId },
            data: { status: 'ACTIVE' },
          })
        }
        await tx.activityLog.create({
          data: {
            organizationId: event.organizationId,
            venueId: event.venueId,
            actorType: 'SERVICE',
            servicePrincipalId: 'commercial-entitlement-projector',
            action:
              event.eventType === 'SUBSCRIPTION_NON_CASH_ACTIVATED'
                ? 'COMMERCIAL_NON_CASH_ENTITLEMENTS_PROJECTED'
                : 'COMMERCIAL_PAID_ENTITLEMENTS_PROJECTED',
            entity: 'CommercialEventOutbox',
            entityId: input.eventId,
            data: {
              schemaVersion: 1,
              contractId: event.contractId,
              sourcePeriodId: event.sourceId,
              sourceRevision: event.sourceRevision,
              features: projected.map(grant => ({
                featureCode: grant.featureCode,
                coverageEndsAt: grant.coverageEndsAt.toISOString(),
              })),
            },
          },
        })
      }

      return {
        decision: projected.length > 0 ? 'PROJECTED' : 'NO_CHANGE',
        eventId: input.eventId,
        grants: projected,
      }
    },
    {
      maxWait: 5_000,
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  )
}

function effectiveGrantsFromProjectionHistory(
  rows: ReadonlyArray<{
    featureCode: string
    action: 'GRANT' | 'REVOKE'
    coverageStartsAt: Date
    coverageEndsAt: Date
  }>,
): Array<{ featureCode: string; coverageStartsAt: Date; coverageEndsAt: Date }> {
  const effective = new Map<string, { featureCode: string; coverageStartsAt: Date; coverageEndsAt: Date }>()
  for (const row of rows) {
    if (row.action === 'GRANT') {
      effective.set(row.featureCode, {
        featureCode: row.featureCode,
        coverageStartsAt: row.coverageStartsAt,
        coverageEndsAt: row.coverageEndsAt,
      })
      continue
    }
    const current = effective.get(row.featureCode)
    if (!current) continue
    const shortenedEndsAt = new Date(Math.min(current.coverageEndsAt.getTime(), row.coverageStartsAt.getTime()))
    if (shortenedEndsAt.getTime() <= current.coverageStartsAt.getTime()) {
      effective.delete(row.featureCode)
    } else {
      effective.set(row.featureCode, { ...current, coverageEndsAt: shortenedEndsAt })
    }
  }
  return [...effective.values()].sort((left, right) => left.featureCode.localeCompare(right.featureCode))
}

export async function projectCommercialReversedEntitlements(
  input: ProjectCommercialReversedEntitlementsInput,
  dependencies: { host?: CommercialBillingTransactionHost } = {},
): Promise<ProjectCommercialReversedEntitlementsResult> {
  requiredId(input.eventId, 'COMMERCIAL_ENTITLEMENT_EVENT_ID_INVALID')
  validNow(input.now)
  const host = dependencies.host ?? (prisma as PrismaClient)

  return host.$transaction(
    async tx => {
      const [event] = await tx.$queryRawUnsafe<LockedPaidEntitlementEventRow[]>(
        `SELECT outbox."eventId", outbox."organizationId", outbox."venueId",
              outbox."sourceType"::text, outbox."sourceId", outbox."sourceRevision",
              outbox."eventType"::text,
              period."status"::text AS "periodStatus",
              period."statusRevision" AS "periodStatusRevision",
              contract."id" AS "contractId", contract."status"::text AS "contractStatus",
              contract."snapshot" AS "contractSnapshot", contract."checksum" AS "contractChecksum",
              acceptance."acceptedById"
         FROM "CommercialEventOutbox" AS outbox
         JOIN "CommercialSubscriptionPeriod" AS period ON period."id" = outbox."sourceId"
         JOIN "CommercialSubscriptionContract" AS contract ON contract."id" = period."contractId"
         JOIN "CommercialQuoteAcceptance" AS acceptance ON acceptance."id" = contract."quoteAcceptanceId"
        WHERE outbox."eventId" = $1
        FOR UPDATE OF outbox, period, contract`,
        input.eventId,
      )
      if (!event) throw new Error('COMMERCIAL_ENTITLEMENT_EVENT_NOT_FOUND')
      if (
        event.eventType !== 'SUBSCRIPTION_PAYMENT_COVERAGE_REVERSED' ||
        event.sourceType !== 'SUBSCRIPTION_PERIOD' ||
        !event.organizationId ||
        !event.venueId
      ) {
        throw new Error('COMMERCIAL_ENTITLEMENT_EVENT_NOT_ELIGIBLE')
      }

      const snapshot = event.contractSnapshot
      assertCommercialBillingContractSnapshotV1(snapshot)
      if (
        checksumCommercialBillingContractSnapshotV1(snapshot) !== event.contractChecksum ||
        snapshot.organizationId !== event.organizationId ||
        snapshot.venueId !== event.venueId
      ) {
        throw new Error('COMMERCIAL_ENTITLEMENT_CONTRACT_MISMATCH')
      }

      const existingForEvent = await tx.commercialEntitlementProjection.findMany({
        where: { eventId: input.eventId },
        orderBy: { featureCode: 'asc' },
        select: { featureCode: true, coverageStartsAt: true, coverageEndsAt: true },
      })
      if (existingForEvent.length > 0) {
        return {
          decision: 'REPLAY',
          eventId: input.eventId,
          revocations: existingForEvent,
        }
      }
      if (
        event.periodStatus === 'PAID' ||
        event.periodStatusRevision !== event.sourceRevision ||
        !['ACTIVE', 'PAUSED'].includes(event.contractStatus)
      ) {
        throw new Error('COMMERCIAL_ENTITLEMENT_EVENT_NOT_ELIGIBLE')
      }

      const periods = await tx.commercialSubscriptionPeriod.findMany({
        where: { contractId: event.contractId },
        orderBy: [{ scheduleKey: 'asc' }, { sequence: 'asc' }],
        select: {
          id: true,
          scheduleKey: true,
          sequence: true,
          startsAt: true,
          endsAt: true,
          status: true,
        },
      })
      const currentPlan = buildCommercialEntitlementProjectionPlan({
        snapshot,
        periods: periods.map(period => ({
          ...period,
          scheduleKey: period.scheduleKey as CommercialBillingScheduleKeyV1,
        })),
      })
      const projectionHistory = await tx.commercialEntitlementProjection.findMany({
        where: { contractId: event.contractId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          featureCode: true,
          action: true,
          coverageStartsAt: true,
          coverageEndsAt: true,
          createdAt: true,
        },
      })
      const reversalPlan = buildCommercialEntitlementReversalPlan({
        currentPlan,
        previousEffectiveGrants: effectiveGrantsFromProjectionHistory(
          projectionHistory.map(row => ({
            ...row,
            action: row.action as 'GRANT' | 'REVOKE',
          })),
        ),
      })

      for (const revocation of reversalPlan.revocations) {
        const advisoryKey = `${event.organizationId}:${revocation.featureCode}`
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, advisoryKey)

        await tx.commercialEntitlementProjection.create({
          data: {
            eventId: input.eventId,
            organizationId: event.organizationId,
            venueId: event.venueId,
            contractId: event.contractId,
            subscriptionPeriodId: event.sourceId,
            sourceRevision: event.sourceRevision,
            featureCode: revocation.featureCode,
            action: 'REVOKE',
            coverageStartsAt: revocation.coverageStartsAt,
            coverageEndsAt: revocation.coverageEndsAt,
          },
        })
        const rebuilt = await rebuildOrganizationContractEntitlement(tx, {
          organizationId: event.organizationId,
          featureCode: revocation.featureCode,
          acceptedById: event.acceptedById,
          reason: `Commercial billing reversal rebuild ${input.eventId}`,
        })
        if (rebuilt) continue

        const existingEntitlement = await tx.organizationEntitlement.findUnique({
          where: {
            organizationId_featureCode: {
              organizationId: event.organizationId,
              featureCode: revocation.featureCode,
            },
          },
          select: { source: true },
        })
        if (existingEntitlement?.source !== 'CUSTOM' && existingEntitlement) {
          await tx.organizationEntitlement.update({
            where: {
              organizationId_featureCode: {
                organizationId: event.organizationId,
                featureCode: revocation.featureCode,
              },
            },
            data: {
              status: 'REVOKED',
              endsAt: input.now,
              reason: `Commercial billing coverage reversed ${input.eventId}`,
            },
          })
        }
      }

      if (currentPlan.grants.length === 0 && event.contractStatus === 'ACTIVE') {
        await tx.commercialSubscriptionContract.update({
          where: { id: event.contractId },
          data: { status: 'PAUSED' },
        })
      }
      if (reversalPlan.revocations.length > 0) {
        await tx.activityLog.create({
          data: {
            organizationId: event.organizationId,
            venueId: event.venueId,
            actorType: 'SERVICE',
            servicePrincipalId: 'commercial-entitlement-projector',
            action: 'COMMERCIAL_PAID_ENTITLEMENTS_REVERSED',
            entity: 'CommercialEventOutbox',
            entityId: input.eventId,
            data: {
              schemaVersion: 1,
              contractId: event.contractId,
              sourcePeriodId: event.sourceId,
              sourceRevision: event.sourceRevision,
              features: reversalPlan.revocations.map(revocation => ({
                featureCode: revocation.featureCode,
                coverageStartsAt: revocation.coverageStartsAt.toISOString(),
                coverageEndsAt: revocation.coverageEndsAt.toISOString(),
              })),
            },
          },
        })
      }

      return {
        decision: reversalPlan.revocations.length > 0 ? 'PROJECTED' : 'NO_CHANGE',
        eventId: input.eventId,
        revocations: reversalPlan.revocations,
      }
    },
    {
      maxWait: 5_000,
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  )
}
