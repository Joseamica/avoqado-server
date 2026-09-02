import { DateTime } from 'luxon'
import Ajv from 'ajv'
import { Prisma, type PrismaClient } from '@prisma/client'

import { MAX_COMMERCIAL_MONEY_MINOR } from '@/contracts/commercial/commercialContractV2.constants'
import billingSchema from '@/contracts/commercial/commercial-billing-v1.schema.json'
import type {
  CommercialBillingEntitlementRequirementV1,
  CommercialBillingScheduleKeyV1,
  CommercialBillingScheduleV1,
  CommercialSubscriptionContractSnapshotV1,
  CreateCommercialSubscriptionContractInput,
  CreateCommercialSubscriptionContractResult,
  CommercialSubscriptionPeriodDraft,
  CommercialSubscriptionPeriodDraftInput,
} from '@/types/commercialBilling'
import type { CommercialQuoteSnapshotV3 } from '@/types/commercialQuoteV3'
import prisma from '@/utils/prismaClient'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import type { CommercialBillingTransactionHost } from './cashReceipt.service'
import { activateCommercialZeroAmountPeriod } from './zeroAmountActivation.service'

const validateBillingContractV1 = new Ajv({ allErrors: true, jsonPointers: true }).compile(billingSchema as object)
const BILLING_CONTRACT_HASH_NAMESPACE = 'avoqado:commercial-billing:subscription-contract'

function assertMoney(value: bigint, code: string): void {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_COMMERCIAL_MONEY_MINOR) {
    throw new Error(code)
  }
}

export function buildCommercialSubscriptionPeriodDrafts(
  input: CommercialSubscriptionPeriodDraftInput,
): CommercialSubscriptionPeriodDraft[] {
  if (input.cadence !== 'MONTHLY' && input.cadence !== 'ANNUAL') {
    throw new Error('COMMERCIAL_BILLING_CADENCE_INVALID')
  }
  if (!(input.startsAt instanceof Date) || !Number.isFinite(input.startsAt.getTime())) {
    throw new Error('COMMERCIAL_BILLING_START_INVALID')
  }
  if (typeof input.timezone !== 'string' || input.timezone.trim() === '') {
    throw new Error('COMMERCIAL_BILLING_TIMEZONE_INVALID')
  }
  if (!Number.isSafeInteger(input.periodCount) || input.periodCount < 1 || input.periodCount > 120) {
    throw new Error('COMMERCIAL_BILLING_PERIOD_COUNT_INVALID')
  }
  if (!Number.isSafeInteger(input.graceDays) || input.graceDays < 0 || input.graceDays > 31) {
    throw new Error('COMMERCIAL_BILLING_GRACE_DAYS_INVALID')
  }
  assertMoney(input.firstPeriodAmountMinor, 'COMMERCIAL_BILLING_FIRST_PERIOD_AMOUNT_INVALID')
  assertMoney(input.renewalAmountMinor, 'COMMERCIAL_BILLING_RENEWAL_AMOUNT_INVALID')

  const anchor = DateTime.fromJSDate(input.startsAt, { zone: input.timezone })
  if (!anchor.isValid) throw new Error('COMMERCIAL_BILLING_TIMEZONE_INVALID')

  const boundary = (index: number): DateTime =>
    input.cadence === 'MONTHLY' ? anchor.plus({ months: index }) : anchor.plus({ years: index })

  return Array.from({ length: input.periodCount }, (_, index) => {
    const startsAt = boundary(index)
    const endsAt = boundary(index + 1)
    return {
      sequence: index + 1,
      startsAt: startsAt.toJSDate(),
      endsAt: endsAt.toJSDate(),
      dueAt: startsAt.toJSDate(),
      graceEndsAt: startsAt.plus({ days: input.graceDays }).toJSDate(),
      amountDueMinor: index === 0 ? input.firstPeriodAmountMinor : input.renewalAmountMinor,
    }
  })
}

function minorUnits(value: string, code: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/u.test(value)) throw new Error(code)
  const parsed = BigInt(value)
  if (parsed > MAX_COMMERCIAL_MONEY_MINOR) throw new Error(code)
  return parsed
}

function scheduleForBillingUnit(billingUnit: string): {
  scheduleKey: CommercialBillingScheduleKeyV1
  cadence: 'MONTHLY' | 'ANNUAL'
} {
  if (billingUnit === 'VENUE_MONTH') return { scheduleKey: 'SAAS_MONTHLY', cadence: 'MONTHLY' }
  if (billingUnit === 'VENUE_YEAR') return { scheduleKey: 'SAAS_ANNUAL', cadence: 'ANNUAL' }
  throw new Error('COMMERCIAL_BILLING_SAAS_BILLING_UNIT_INVALID')
}

export function buildCommercialSubscriptionContractSnapshotV1(input: {
  acceptanceId: string
  quoteChecksum: string
  quote: CommercialQuoteSnapshotV3
  timezone: string
  startsAt: Date
}): CommercialSubscriptionContractSnapshotV1 {
  if (input.quote.subject.kind !== 'VENUE') throw new Error('COMMERCIAL_BILLING_QUOTE_SCOPE_INVALID')
  if (!/^[0-9a-f]{64}$/u.test(input.quoteChecksum)) throw new Error('COMMERCIAL_BILLING_QUOTE_CHECKSUM_INVALID')
  if (!(input.startsAt instanceof Date) || !Number.isFinite(input.startsAt.getTime())) {
    throw new Error('COMMERCIAL_BILLING_START_INVALID')
  }
  const zonedStart = DateTime.fromJSDate(input.startsAt, { zone: input.timezone })
  if (!zonedStart.isValid) throw new Error('COMMERCIAL_BILLING_TIMEZONE_INVALID')

  const scheduleTotals = new Map<CommercialBillingScheduleKeyV1, CommercialBillingScheduleV1>()
  const lineSchedules = new Map<string, CommercialBillingScheduleKeyV1>()
  for (const line of input.quote.saasLines) {
    const schedule = scheduleForBillingUnit(line.billingUnit)
    if (lineSchedules.has(line.lineKey)) throw new Error('COMMERCIAL_BILLING_LINE_KEY_DUPLICATED')
    lineSchedules.set(line.lineKey, schedule.scheduleKey)
    const current = scheduleTotals.get(schedule.scheduleKey)
    const firstPeriodAmountMinor = (current ? BigInt(current.firstPeriodAmountMinor) : 0n) +
      minorUnits(line.totalMinor, 'COMMERCIAL_BILLING_LINE_TOTAL_INVALID')
    const renewalAmountMinor = (current ? BigInt(current.renewalAmountMinor) : 0n) +
      minorUnits(line.renewalTotalMinor, 'COMMERCIAL_BILLING_LINE_RENEWAL_INVALID')
    if (firstPeriodAmountMinor > MAX_COMMERCIAL_MONEY_MINOR || renewalAmountMinor > MAX_COMMERCIAL_MONEY_MINOR) {
      throw new Error('COMMERCIAL_BILLING_SCHEDULE_TOTAL_INVALID')
    }
    scheduleTotals.set(schedule.scheduleKey, {
      ...schedule,
      firstPeriodAmountMinor: firstPeriodAmountMinor.toString(),
      renewalAmountMinor: renewalAmountMinor.toString(),
    })
  }
  if (scheduleTotals.size === 0) throw new Error('COMMERCIAL_BILLING_SAAS_LINES_REQUIRED')

  const entitlements: CommercialBillingEntitlementRequirementV1[] = input.quote.entitlementGrants
    .map(grant => {
      const requiredScheduleKeys = new Set<CommercialBillingScheduleKeyV1>()
      for (const origin of grant.origins) {
        if (!('lineKey' in origin)) throw new Error('COMMERCIAL_BILLING_ENTITLEMENT_LINEAGE_INVALID')
        const scheduleKey = lineSchedules.get(origin.lineKey)
        if (!scheduleKey) throw new Error('COMMERCIAL_BILLING_ENTITLEMENT_LINEAGE_INVALID')
        requiredScheduleKeys.add(scheduleKey)
      }
      if (requiredScheduleKeys.size === 0) throw new Error('COMMERCIAL_BILLING_ENTITLEMENT_LINEAGE_INVALID')
      return {
        featureCode: grant.capabilityCode,
        requiredScheduleKeys: [...requiredScheduleKeys].sort(),
      }
    })
    .sort((left, right) => left.featureCode.localeCompare(right.featureCode))

  const schedules = [...scheduleTotals.values()].sort((left, right) =>
    left.scheduleKey === right.scheduleKey ? 0 : left.scheduleKey === 'SAAS_MONTHLY' ? -1 : 1,
  )
  return {
    schemaVersion: 1,
    contractVersion: '1.0.0',
    acceptanceId: input.acceptanceId,
    quoteId: input.quote.quoteId,
    quoteChecksum: input.quoteChecksum,
    organizationId: input.quote.subject.organizationId,
    venueId: input.quote.subject.venueId,
    currency: 'MXN',
    timezone: input.timezone,
    startsAt: input.startsAt.toISOString(),
    cadence: schedules.length === 2 ? 'MIXED' : schedules[0]!.cadence,
    schedules,
    entitlements,
  }
}

interface LockedAcceptedQuoteBillingRow {
  acceptanceId: string
  quoteId: string
  quoteChecksum: string
  organizationId: string
  venueId: string
  acceptedById: string
  startsAtMatches: boolean
  status: string
}

export function assertCommercialBillingContractSnapshotV1(snapshot: CommercialSubscriptionContractSnapshotV1): void {
  if (!validateBillingContractV1(snapshot)) throw new Error('COMMERCIAL_BILLING_CONTRACT_SNAPSHOT_INVALID')
}

export function checksumCommercialBillingContractSnapshotV1(
  snapshot: CommercialSubscriptionContractSnapshotV1,
): string {
  assertCommercialBillingContractSnapshotV1(snapshot)
  return hashCanonicalJsonV1(BILLING_CONTRACT_HASH_NAMESPACE, snapshot)
}

function receivableReference(acceptanceId: string, scheduleKey: CommercialBillingScheduleKeyV1): string {
  return `AVQ-${hashCanonicalJsonV1('avoqado:commercial-billing:receivable-reference', {
    acceptanceId,
    scheduleKey,
    sequence: 1,
  })
    .slice(0, 24)
    .toUpperCase()}`
}

export async function createCommercialSubscriptionContract(
  input: CreateCommercialSubscriptionContractInput,
  dependencies: {
    host?: CommercialBillingTransactionHost
    activateZeroAmountPeriod?: typeof activateCommercialZeroAmountPeriod
  } = {},
): Promise<CreateCommercialSubscriptionContractResult> {
  assertCommercialBillingContractSnapshotV1(input.snapshot)
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim() === '') {
    throw new Error('COMMERCIAL_BILLING_CONTRACT_IDEMPOTENCY_INVALID')
  }
  const contractChecksum = checksumCommercialBillingContractSnapshotV1(input.snapshot)
  const host = dependencies.host ?? (prisma as PrismaClient)
  const activateZeroAmountPeriod = dependencies.activateZeroAmountPeriod ?? activateCommercialZeroAmountPeriod

  return host.$transaction(async tx => {
    const existing = await tx.commercialSubscriptionContract.findUnique({
      where: { quoteAcceptanceId: input.snapshot.acceptanceId },
      include: {
        periods: {
          orderBy: [{ scheduleKey: 'asc' }, { sequence: 'asc' }],
          include: { receivable: { select: { id: true } } },
        },
      },
    })
    if (existing) {
      if (
        existing.organizationId !== input.snapshot.organizationId ||
        existing.venueId !== input.snapshot.venueId ||
        existing.checksum !== contractChecksum ||
        existing.idempotencyKey !== input.idempotencyKey
      ) {
        throw new Error('COMMERCIAL_BILLING_CONTRACT_REPLAY_CONFLICT')
      }
      return {
        decision: 'REPLAY',
        contractId: existing.id,
        contractChecksum: existing.checksum,
        periods: existing.periods.map(period => {
          if (!period.receivable) throw new Error('COMMERCIAL_BILLING_CONTRACT_REPLAY_INCOMPLETE')
          return {
            periodId: period.id,
            receivableId: period.receivable.id,
            scheduleKey: period.scheduleKey as CommercialBillingScheduleKeyV1,
            amountDueMinor: period.amountDueMinor,
          }
        }),
      }
    }

    const [accepted] = await tx.$queryRawUnsafe<LockedAcceptedQuoteBillingRow[]>(
      `SELECT acceptance."id" AS "acceptanceId", acceptance."quoteId", quote."checksum" AS "quoteChecksum",
              acceptance."organizationId", acceptance."venueId", acceptance."acceptedById",
              acceptance."status"::text,
              acceptance."acceptedAt" = ($2::timestamptz AT TIME ZONE 'UTC') AS "startsAtMatches"
         FROM "CommercialQuoteAcceptance" AS acceptance
         JOIN "CommercialQuote" AS quote ON quote."id" = acceptance."quoteId"
        WHERE acceptance."id" = $1
        FOR UPDATE OF acceptance, quote`,
      input.snapshot.acceptanceId,
      input.snapshot.startsAt,
    )
    if (!accepted) throw new Error('COMMERCIAL_BILLING_ACCEPTANCE_NOT_FOUND')
    if (
      accepted.status !== 'ACCEPTED' ||
      accepted.quoteId !== input.snapshot.quoteId ||
      accepted.quoteChecksum !== input.snapshot.quoteChecksum ||
      accepted.organizationId !== input.snapshot.organizationId ||
      accepted.venueId !== input.snapshot.venueId ||
      accepted.startsAtMatches !== true
    ) {
      throw new Error('COMMERCIAL_BILLING_ACCEPTANCE_MISMATCH')
    }

    const contract = await tx.commercialSubscriptionContract.create({
      data: {
        quoteAcceptanceId: input.snapshot.acceptanceId,
        idempotencyKey: input.idempotencyKey,
        organizationId: input.snapshot.organizationId,
        venueId: input.snapshot.venueId,
        schemaVersion: 1,
        snapshot: input.snapshot as unknown as Prisma.InputJsonValue,
        checksum: contractChecksum,
        status: 'PENDING_PAYMENT',
        cadence: input.snapshot.cadence,
        currency: 'MXN',
        timezone: input.snapshot.timezone,
        startsAt: new Date(input.snapshot.startsAt),
      },
      select: { id: true, checksum: true },
    })

    const periods = [] as CreateCommercialSubscriptionContractResult['periods']
    for (const schedule of input.snapshot.schedules) {
      const [draft] = buildCommercialSubscriptionPeriodDrafts({
        cadence: schedule.cadence,
        startsAt: new Date(input.snapshot.startsAt),
        timezone: input.snapshot.timezone,
        firstPeriodAmountMinor: BigInt(schedule.firstPeriodAmountMinor),
        renewalAmountMinor: BigInt(schedule.renewalAmountMinor),
        periodCount: 1,
        graceDays: input.graceDays,
      })
      if (!draft) throw new Error('COMMERCIAL_BILLING_PERIOD_DRAFT_MISSING')
      const period = await tx.commercialSubscriptionPeriod.create({
        data: {
          contractId: contract.id,
          scheduleKey: schedule.scheduleKey,
          cadence: schedule.cadence,
          sequence: draft.sequence,
          startsAt: draft.startsAt,
          endsAt: draft.endsAt,
          dueAt: draft.dueAt,
          graceEndsAt: draft.graceEndsAt,
          amountDueMinor: draft.amountDueMinor,
          currency: 'MXN',
          status: 'OPEN',
          statusRevision: 1,
        },
        select: { id: true },
      })
      const receivable = await tx.commercialAccountReceivable.create({
        data: {
          organizationId: input.snapshot.organizationId,
          venueId: input.snapshot.venueId,
          subjectType: 'SUBSCRIPTION_PERIOD',
          subscriptionPeriodId: period.id,
          reference: receivableReference(input.snapshot.acceptanceId, schedule.scheduleKey),
          amountDueMinor: draft.amountDueMinor,
          currency: 'MXN',
          dueAt: draft.dueAt,
          status: 'OPEN',
        },
        select: { id: true },
      })
      periods.push({
        periodId: period.id,
        receivableId: receivable.id,
        scheduleKey: schedule.scheduleKey,
        amountDueMinor: draft.amountDueMinor,
      })
      if (draft.amountDueMinor === 0n) {
        const nestedHost: CommercialBillingTransactionHost = {
          $transaction: async operation => operation(tx),
        }
        await activateZeroAmountPeriod(
          {
            organizationId: input.snapshot.organizationId,
            venueId: input.snapshot.venueId,
            periodId: period.id,
            now: new Date(input.snapshot.startsAt),
          },
          { host: nestedHost },
        )
      }
    }

    await tx.activityLog.create({
      data: {
        organizationId: input.snapshot.organizationId,
        venueId: input.snapshot.venueId,
        actorType: 'HUMAN',
        staffId: accepted.acceptedById,
        actorStaffId: accepted.acceptedById,
        action: 'COMMERCIAL_SUBSCRIPTION_CONTRACT_CREATED',
        entity: 'CommercialSubscriptionContract',
        entityId: contract.id,
        data: {
          schemaVersion: 1,
          acceptanceId: input.snapshot.acceptanceId,
          quoteId: input.snapshot.quoteId,
          contractChecksum,
          scheduleKeys: input.snapshot.schedules.map(schedule => schedule.scheduleKey),
        },
      },
    })

    return {
      decision: 'CREATED',
      contractId: contract.id,
      contractChecksum: contract.checksum,
      periods,
    }
  }, {
    maxWait: 5_000,
    timeout: 30_000,
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  })
}
