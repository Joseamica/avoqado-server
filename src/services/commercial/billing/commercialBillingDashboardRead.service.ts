import { Prisma, type PrismaClient } from '@prisma/client'

import {
  assertCommercialBillingContractSnapshotV1,
  checksumCommercialBillingContractSnapshotV1,
} from '@/services/commercial/billing/subscriptionContract.service'
import type { CommercialSubscriptionContractSnapshotV1 } from '@/types/commercialBilling'
import prisma from '@/utils/prismaClient'

const MONEY_MINOR = /^(0|[1-9][0-9]{0,18})$/
const MAX_RECEIPT_PAGE = 100
const OVERVIEW_RECEIPT_LIMIT = 5

type ReadHost = Pick<PrismaClient, '$transaction'>

interface QuoteMoneyBreakdown {
  listSubtotalMinor: string
  discountMinor: string
  subtotalMinor: string
  taxMinor: string
  totalMinor: string
}

interface QuoteLineProjection {
  lineKey: string
  targetType: string
  targetCode: string
  priceCode: string
  quantity: number
  productKind: string
  name: string
  billingUnit: string
  listUnitAmountMinor: string
  listSubtotalMinor: string
  discountMinor: string
  subtotalMinor: string
  taxMinor: string
  totalMinor: string
  promotionalCycles: number | null
  renewalSubtotalMinor: string
  renewalTaxMinor: string
  renewalTotalMinor: string
}

function requiredId(value: string, code: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(code)
  return value
}

function pageLimit(value: number | undefined): number {
  const limit = value ?? 25
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECEIPT_PAGE) {
    throw new Error('COMMERCIAL_BILLING_DASHBOARD_RECEIPT_LIMIT_INVALID')
  }
  return limit
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function minor(value: unknown): string | null {
  return typeof value === 'string' && MONEY_MINOR.test(value) ? value : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function moneyBreakdown(value: unknown): QuoteMoneyBreakdown | null {
  if (!isRecord(value)) return null
  const projected = {
    listSubtotalMinor: minor(value.listSubtotalMinor),
    discountMinor: minor(value.discountMinor),
    subtotalMinor: minor(value.subtotalMinor),
    taxMinor: minor(value.taxMinor),
    totalMinor: minor(value.totalMinor),
  }
  return Object.values(projected).every(item => item !== null) ? (projected as QuoteMoneyBreakdown) : null
}

function quoteLine(value: unknown): QuoteLineProjection | null {
  if (!isRecord(value)) return null
  const projected = {
    lineKey: stringValue(value.lineKey),
    targetType: stringValue(value.targetType),
    targetCode: stringValue(value.targetCode),
    priceCode: stringValue(value.priceCode),
    quantity: value.quantity,
    productKind: stringValue(value.productKind),
    name: stringValue(value.name),
    billingUnit: stringValue(value.billingUnit),
    listUnitAmountMinor: minor(value.listUnitAmountMinor),
    listSubtotalMinor: minor(value.listSubtotalMinor),
    discountMinor: minor(value.discountMinor),
    subtotalMinor: minor(value.subtotalMinor),
    taxMinor: minor(value.taxMinor),
    totalMinor: minor(value.totalMinor),
    promotionalCycles: value.promotionalCycles,
    renewalSubtotalMinor: minor(value.renewalSubtotalMinor),
    renewalTaxMinor: minor(value.renewalTaxMinor),
    renewalTotalMinor: minor(value.renewalTotalMinor),
  }
  if (
    !Number.isSafeInteger(projected.quantity) ||
    (projected.quantity as number) < 1 ||
    !(
      projected.promotionalCycles === null ||
      (Number.isSafeInteger(projected.promotionalCycles) && (projected.promotionalCycles as number) > 0)
    )
  ) {
    return null
  }
  const stringFields = [
    projected.lineKey,
    projected.targetType,
    projected.targetCode,
    projected.priceCode,
    projected.productKind,
    projected.name,
    projected.billingUnit,
    projected.listUnitAmountMinor,
    projected.listSubtotalMinor,
    projected.discountMinor,
    projected.subtotalMinor,
    projected.taxMinor,
    projected.totalMinor,
    projected.renewalSubtotalMinor,
    projected.renewalTaxMinor,
    projected.renewalTotalMinor,
  ]
  return stringFields.every(item => item !== null) ? (projected as QuoteLineProjection) : null
}

function contractSnapshotIsValid(
  rawSnapshot: unknown,
  expected: {
    checksum: string
    acceptanceId: string
    quoteId: string
    quoteChecksum: string
    organizationId: string
    venueId: string
  },
): rawSnapshot is CommercialSubscriptionContractSnapshotV1 {
  try {
    assertCommercialBillingContractSnapshotV1(rawSnapshot as CommercialSubscriptionContractSnapshotV1)
    const snapshot = rawSnapshot as CommercialSubscriptionContractSnapshotV1
    return (
      checksumCommercialBillingContractSnapshotV1(snapshot) === expected.checksum &&
      snapshot.acceptanceId === expected.acceptanceId &&
      snapshot.quoteId === expected.quoteId &&
      snapshot.quoteChecksum === expected.quoteChecksum &&
      snapshot.organizationId === expected.organizationId &&
      snapshot.venueId === expected.venueId &&
      snapshot.currency === 'MXN'
    )
  } catch {
    return false
  }
}

function projectQuote(
  quote: {
    id: string
    checksum: string
    snapshot: Prisma.JsonValue
    listSubtotalMinor: bigint
    discountMinor: bigint
    subtotalMinor: bigint
    taxMinor: bigint
    totalMinor: bigint
    renewalSubtotalMinor: bigint
    renewalTaxMinor: bigint
    renewalTotalMinor: bigint
  },
  organizationId: string,
  venueId: string,
) {
  if (!isRecord(quote.snapshot)) return null
  const subject = quote.snapshot.subject
  if (
    quote.snapshot.schemaVersion !== 3 ||
    quote.snapshot.quoteId !== quote.id ||
    quote.snapshot.currency !== 'MXN' ||
    !isRecord(subject) ||
    subject.kind !== 'VENUE' ||
    subject.organizationId !== organizationId ||
    subject.venueId !== venueId ||
    !Array.isArray(quote.snapshot.saasLines)
  ) {
    return null
  }
  const lines = quote.snapshot.saasLines.map(quoteLine)
  const totals = quote.snapshot.totals
  if (!isRecord(totals)) return null
  const today = moneyBreakdown(totals.recurringCurrent)
  const dueNow = moneyBreakdown(totals.dueNow)
  const renewal = moneyBreakdown(quote.snapshot.renewal)
  if (lines.some(line => line === null) || !today || !dueNow || !renewal) return null
  const rowTotals = [
    quote.listSubtotalMinor,
    quote.discountMinor,
    quote.subtotalMinor,
    quote.taxMinor,
    quote.totalMinor,
    quote.renewalSubtotalMinor,
    quote.renewalTaxMinor,
    quote.renewalTotalMinor,
  ].map(value => value.toString())
  const snapshotTotals = [
    dueNow.listSubtotalMinor,
    dueNow.discountMinor,
    dueNow.subtotalMinor,
    dueNow.taxMinor,
    dueNow.totalMinor,
    renewal.subtotalMinor,
    renewal.taxMinor,
    renewal.totalMinor,
  ]
  if (rowTotals.some((value, index) => value !== snapshotTotals[index])) return null
  return { lines: lines as QuoteLineProjection[], today, renewal }
}

function receiptProjection(row: {
  id: string
  provider: string
  entryType: string
  amountMinor: bigint
  currency: string
  observedAt: Date
  createdAt: Date
}) {
  return {
    id: row.id,
    provider: row.provider,
    entryType: row.entryType,
    amountMinor: row.amountMinor.toString(),
    currency: row.currency,
    observedAt: row.observedAt,
    createdAt: row.createdAt,
  }
}

async function receiptPage(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    venueId: string
    contractId: string
    cursor?: string
    limit: number
  },
) {
  const rows = await tx.commercialCashReceipt.findMany({
    where: {
      organizationId: input.organizationId,
      venueId: input.venueId,
      allocations: { some: { receivable: { subscriptionPeriod: { contractId: input.contractId } } } },
    },
    orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: input.limit + 1,
    select: {
      id: true,
      provider: true,
      entryType: true,
      amountMinor: true,
      currency: true,
      observedAt: true,
      createdAt: true,
    },
  })
  const hasMore = rows.length > input.limit
  const page = hasMore ? rows.slice(0, input.limit) : rows
  return {
    items: page.map(receiptProjection),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  }
}

function paymentState(
  attempt: {
    provider: string
    status: string
    manualSpeiCase: { status: string } | null
  } | null,
): 'REQUIRED' | 'PENDING' | 'UNDER_REVIEW' | 'FAILED' {
  if (!attempt) return 'REQUIRED'
  if (
    attempt.provider === 'MANUAL_SPEI' &&
    attempt.manualSpeiCase &&
    ['PENDING_REVIEW', 'AWAITING_APPROVAL', 'READY_TO_RECONCILE'].includes(attempt.manualSpeiCase.status)
  ) {
    return 'UNDER_REVIEW'
  }
  if (attempt.status === 'FAILED' || attempt.status === 'CANCELED') return 'FAILED'
  return 'PENDING'
}

export async function getCommercialBillingDashboardOverview(
  input: { organizationId: string; venueId: string },
  dependencies: { client?: ReadHost } = {},
) {
  requiredId(input.organizationId, 'COMMERCIAL_BILLING_DASHBOARD_ORGANIZATION_INVALID')
  requiredId(input.venueId, 'COMMERCIAL_BILLING_DASHBOARD_VENUE_INVALID')
  const host = dependencies.client ?? prisma

  return host.$transaction(
    async tx => {
      const contract = await tx.commercialSubscriptionContract.findFirst({
        where: { organizationId: input.organizationId, venueId: input.venueId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          quoteAcceptanceId: true,
          organizationId: true,
          venueId: true,
          schemaVersion: true,
          snapshot: true,
          checksum: true,
          status: true,
          cadence: true,
          currency: true,
          timezone: true,
          startsAt: true,
          endedAt: true,
          quoteAcceptance: {
            select: {
              quote: {
                select: {
                  id: true,
                  schemaVersion: true,
                  checksum: true,
                  snapshot: true,
                  listSubtotalMinor: true,
                  discountMinor: true,
                  subtotalMinor: true,
                  taxMinor: true,
                  totalMinor: true,
                  renewalSubtotalMinor: true,
                  renewalTaxMinor: true,
                  renewalTotalMinor: true,
                },
              },
            },
          },
        },
      })
      if (!contract) return { schemaVersion: 1 as const, state: 'NO_COMMERCIAL_CONTRACT' as const }
      const quote = contract.quoteAcceptance.quote
      if (contract.schemaVersion !== 1 || quote.schemaVersion !== 3) {
        return {
          schemaVersion: 1 as const,
          state: 'INCOMPATIBLE' as const,
          supportCode: 'COMMERCIAL_BILLING_SCHEMA_UNSUPPORTED' as const,
        }
      }
      if (
        !contractSnapshotIsValid(contract.snapshot, {
          checksum: contract.checksum,
          acceptanceId: contract.quoteAcceptanceId,
          quoteId: quote.id,
          quoteChecksum: quote.checksum,
          organizationId: input.organizationId,
          venueId: input.venueId,
        })
      ) {
        return {
          schemaVersion: 1 as const,
          state: 'INCOMPATIBLE' as const,
          supportCode: 'COMMERCIAL_BILLING_INTEGRITY_MISMATCH' as const,
        }
      }
      const projectedQuote = projectQuote(quote, input.organizationId, input.venueId)
      if (!projectedQuote) {
        return {
          schemaVersion: 1 as const,
          state: 'INCOMPATIBLE' as const,
          supportCode: 'COMMERCIAL_BILLING_INTEGRITY_MISMATCH' as const,
        }
      }

      const [obligationRows, latestPaidRows] = await Promise.all([
        tx.commercialSubscriptionPeriod.findMany({
          where: { contractId: contract.id, status: { in: ['OPEN', 'PAST_DUE', 'EXPIRED'] } },
          orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
          take: 3,
          select: {
            id: true,
            scheduleKey: true,
            cadence: true,
            sequence: true,
            startsAt: true,
            endsAt: true,
            dueAt: true,
            graceEndsAt: true,
            amountDueMinor: true,
            currency: true,
            status: true,
            paidAt: true,
            receivable: {
              select: {
                id: true,
                reference: true,
                amountDueMinor: true,
                currency: true,
                dueAt: true,
                status: true,
                paymentAttempts: {
                  orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
                  take: 1,
                  select: {
                    provider: true,
                    status: true,
                    updatedAt: true,
                    manualSpeiCase: { select: { status: true } },
                  },
                },
              },
            },
          },
        }),
        tx.commercialSubscriptionPeriod.findMany({
          where: { contractId: contract.id, status: 'PAID' },
          orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { id: true, scheduleKey: true, endsAt: true, paidAt: true },
        }),
      ])
      if (obligationRows.some(period => period.receivable === null)) {
        return {
          schemaVersion: 1 as const,
          state: 'INCOMPATIBLE' as const,
          supportCode: 'COMMERCIAL_BILLING_INTEGRITY_MISMATCH' as const,
        }
      }
      const receivableIds = obligationRows.flatMap(period => (period.receivable ? [period.receivable.id] : []))
      const allocationGroups = receivableIds.length
        ? await tx.commercialBillingAllocation.groupBy({
            by: ['receivableId', 'direction'],
            where: { receivableId: { in: receivableIds } },
            _sum: { amountMinor: true },
          })
        : []
      const allocatedByReceivable = new Map<string, bigint>()
      for (const group of allocationGroups) {
        const signed = group.direction === 'CREDIT' ? (group._sum.amountMinor ?? 0n) : -(group._sum.amountMinor ?? 0n)
        allocatedByReceivable.set(group.receivableId, (allocatedByReceivable.get(group.receivableId) ?? 0n) + signed)
      }
      const obligations = obligationRows.map(period => {
        const receivable = period.receivable!
        const allocatedMinor = allocatedByReceivable.get(receivable.id) ?? 0n
        if (allocatedMinor < 0n || allocatedMinor > receivable.amountDueMinor) {
          throw new Error('COMMERCIAL_BILLING_DASHBOARD_ALLOCATION_INVARIANT')
        }
        const latestAttempt = receivable.paymentAttempts[0] ?? null
        return {
          periodId: period.id,
          scheduleKey: period.scheduleKey,
          cadence: period.cadence,
          sequence: period.sequence,
          startsAt: period.startsAt,
          endsAt: period.endsAt,
          dueAt: period.dueAt,
          graceEndsAt: period.graceEndsAt,
          periodStatus: period.status,
          receivableId: receivable.id,
          reference: receivable.reference,
          receivableStatus: receivable.status,
          amountDueMinor: receivable.amountDueMinor.toString(),
          allocatedMinor: allocatedMinor.toString(),
          outstandingMinor: (receivable.amountDueMinor - allocatedMinor).toString(),
          currency: receivable.currency,
          paymentProvider: latestAttempt?.provider ?? null,
          paymentState: paymentState(latestAttempt),
        }
      })
      const recentReceipts = await receiptPage(tx, {
        organizationId: input.organizationId,
        venueId: input.venueId,
        contractId: contract.id,
        limit: OVERVIEW_RECEIPT_LIMIT,
      })
      const collectionState =
        contract.status === 'CANCELED' || contract.status === 'COMPLETED'
          ? 'CANCELED'
          : obligations.some(obligation => ['PAST_DUE', 'EXPIRED'].includes(obligation.periodStatus))
            ? 'PAST_DUE'
            : obligations.some(obligation => obligation.paymentState === 'FAILED')
              ? 'PAYMENT_FAILED'
              : obligations.some(obligation => obligation.paymentState === 'UNDER_REVIEW')
                ? 'PAYMENT_UNDER_REVIEW'
                : obligations.some(obligation => obligation.paymentState === 'PENDING')
                  ? 'PAYMENT_PENDING'
                  : obligations.length > 0
                    ? 'PAYMENT_REQUIRED'
                    : 'CURRENT'

      return {
        schemaVersion: 1 as const,
        state: 'READY' as const,
        collectionState,
        contract: {
          id: contract.id,
          status: contract.status,
          cadence: contract.cadence,
          currency: contract.currency,
          timezone: contract.timezone,
          startsAt: contract.startsAt,
          endedAt: contract.endedAt,
          quoteId: quote.id,
          lines: projectedQuote.lines,
          today: projectedQuote.today,
          renewal: projectedQuote.renewal,
          entitlements: contract.snapshot.entitlements.map(item => item.featureCode),
        },
        obligations,
        latestPaidPeriod: latestPaidRows[0] ?? null,
        nextRenewalAt: latestPaidRows[0]?.endsAt ?? null,
        recentReceipts: recentReceipts.items,
        receiptHistoryHasMore: recentReceipts.nextCursor !== null,
      }
    },
    {
      maxWait: 5_000,
      timeout: 15_000,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  )
}

export async function listCommercialBillingDashboardReceipts(
  input: {
    organizationId: string
    venueId: string
    cursor?: string
    limit?: number
  },
  dependencies: { client?: ReadHost } = {},
) {
  requiredId(input.organizationId, 'COMMERCIAL_BILLING_DASHBOARD_ORGANIZATION_INVALID')
  requiredId(input.venueId, 'COMMERCIAL_BILLING_DASHBOARD_VENUE_INVALID')
  if (input.cursor !== undefined) requiredId(input.cursor, 'COMMERCIAL_BILLING_DASHBOARD_RECEIPT_CURSOR_INVALID')
  const limit = pageLimit(input.limit)
  const host = dependencies.client ?? prisma

  return host.$transaction(
    async tx => {
      const contract = await tx.commercialSubscriptionContract.findFirst({
        where: { organizationId: input.organizationId, venueId: input.venueId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          schemaVersion: true,
          quoteAcceptance: { select: { quote: { select: { schemaVersion: true } } } },
        },
      })
      if (!contract) return { schemaVersion: 1 as const, state: 'NO_COMMERCIAL_CONTRACT' as const }
      if (contract.schemaVersion !== 1 || contract.quoteAcceptance.quote.schemaVersion !== 3) {
        return {
          schemaVersion: 1 as const,
          state: 'INCOMPATIBLE' as const,
          supportCode: 'COMMERCIAL_BILLING_SCHEMA_UNSUPPORTED' as const,
        }
      }
      const page = await receiptPage(tx, {
        organizationId: input.organizationId,
        venueId: input.venueId,
        contractId: contract.id,
        cursor: input.cursor,
        limit,
      })
      return { schemaVersion: 1 as const, state: 'READY' as const, ...page }
    },
    {
      maxWait: 5_000,
      timeout: 15_000,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  )
}
