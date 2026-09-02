import { createHash } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'

import { MAX_COMMERCIAL_MONEY_MINOR } from '@/contracts/commercial/commercialContractV2.constants'
import type {
  CommercialCashReceiptObservation,
  CommercialBillingProviderObjectReference,
  ExistingCommercialCashReceipt,
  ReconcileCommercialCashReceiptInput,
  ReconciledCommercialCashReceiptResult,
} from '@/types/commercialBilling'
import prisma from '@/utils/prismaClient'
import { buildCommercialBillingAllocationPlan } from './paymentAllocation.service'

function validDateMillis(value: Date): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('COMMERCIAL_BILLING_RECEIPT_OBSERVED_AT_INVALID')
  }
  return value.getTime()
}

function validateObservation(observation: CommercialCashReceiptObservation): void {
  if (!['STRIPE', 'MANUAL_SPEI', 'AUTOMATIC_SPEI'].includes(observation.provider)) {
    throw new Error('COMMERCIAL_BILLING_RECEIPT_PROVIDER_INVALID')
  }
  if (typeof observation.providerEventId !== 'string' || observation.providerEventId.trim() === '') {
    throw new Error('COMMERCIAL_BILLING_PROVIDER_EVENT_ID_INVALID')
  }
  if (
    typeof observation.amountMinor !== 'bigint' ||
    observation.amountMinor <= 0n ||
    observation.amountMinor > MAX_COMMERCIAL_MONEY_MINOR
  ) {
    throw new Error('COMMERCIAL_BILLING_RECEIPT_AMOUNT_INVALID')
  }
  if (observation.currency !== 'MXN') throw new Error('COMMERCIAL_BILLING_RECEIPT_CURRENCY_INVALID')
  if (
    typeof observation.receivingAccountFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(observation.receivingAccountFingerprint)
  ) {
    throw new Error('COMMERCIAL_BILLING_RECEIVING_ACCOUNT_FINGERPRINT_INVALID')
  }
  validDateMillis(observation.observedAt)
}

export function resolveCommercialCashReceiptObservation(input: {
  observation: CommercialCashReceiptObservation
  existingReceipt: ExistingCommercialCashReceipt | null
}):
  | { decision: 'CREATE'; receipt: CommercialCashReceiptObservation }
  | { decision: 'REPLAY'; receiptId: string } {
  validateObservation(input.observation)
  if (!input.existingReceipt) return { decision: 'CREATE', receipt: input.observation }
  if (typeof input.existingReceipt.id !== 'string' || input.existingReceipt.id.trim() === '') {
    throw new Error('COMMERCIAL_BILLING_RECEIPT_ID_INVALID')
  }
  validateObservation(input.existingReceipt)

  const sameObservation =
    input.existingReceipt.provider === input.observation.provider &&
    input.existingReceipt.providerEventId === input.observation.providerEventId &&
    input.existingReceipt.amountMinor === input.observation.amountMinor &&
    input.existingReceipt.currency === input.observation.currency &&
    input.existingReceipt.receivingAccountFingerprint === input.observation.receivingAccountFingerprint &&
    validDateMillis(input.existingReceipt.observedAt) === validDateMillis(input.observation.observedAt)

  if (!sameObservation) throw new Error('COMMERCIAL_BILLING_PROVIDER_EVENT_CONFLICT')
  return { decision: 'REPLAY', receiptId: input.existingReceipt.id }
}

interface LockedCommercialReceivableRow {
  id: string
  organizationId: string
  venueId: string
  subscriptionPeriodId: string | null
  subjectType: 'SUBSCRIPTION_PERIOD' | 'TERMINAL_ORDER'
  amountDueMinor: bigint
  currency: string
  status: ReconciledCommercialCashReceiptResult['receivableStatus']
}

interface LockedCommercialSubscriptionPeriodRow {
  id: string
  status: ReconciledCommercialCashReceiptResult['periodStatus']
  statusRevision: number
}

interface ActiveAllocationRow {
  activeAllocatedMinor: bigint
}

interface LockedCommercialBillingPaymentAttemptRow {
  id: string
  receivableId: string
  provider: CommercialCashReceiptObservation['provider']
  providerAttemptId: string | null
  status: 'PENDING' | 'SUCCEEDED' | 'OUTCOME_UNKNOWN' | 'FAILED' | 'CANCELED'
  amountMinor: bigint
  currency: string
}

export interface CommercialBillingTransactionHost {
  $transaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { maxWait: number; timeout: number; isolationLevel: Prisma.TransactionIsolationLevel },
  ): Promise<T>
}

function requiredId(value: string, code: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(code)
  return value
}

function eventIdForPeriod(periodId: string, revision: number): string {
  return createHash('sha256')
    .update(`avoqado:commercial-billing:period:${periodId}:revision:${revision}:payment-reconciled`)
    .digest('hex')
}

function allocationIdempotencyKey(input: ReconcileCommercialCashReceiptInput): string {
  return `${input.idempotencyKey}:allocation:${input.receivableId}`
}

const PROVIDER_OBJECT_PREFIX: Readonly<Record<CommercialBillingProviderObjectReference['objectType'], string>> = {
  INVOICE: 'in_',
  PAYMENT_INTENT: 'pi_',
  CHARGE: 'ch_',
}

function validatedProviderObjectReferences(
  input: ReconcileCommercialCashReceiptInput,
): CommercialBillingProviderObjectReference[] {
  if (input.providerObjectReferences === undefined) return []
  if (!Array.isArray(input.providerObjectReferences) || input.providerObjectReferences.length < 1 || input.providerObjectReferences.length > 10) {
    throw new Error('COMMERCIAL_BILLING_PROVIDER_OBJECT_REFERENCES_INVALID')
  }
  if (input.observation.provider !== 'STRIPE' || !input.paymentAttemptId) {
    throw new Error('COMMERCIAL_BILLING_PROVIDER_OBJECT_AUTHORITY_INVALID')
  }
  const seen = new Set<string>()
  const references = input.providerObjectReferences.map(reference => {
    if (!reference || !Object.prototype.hasOwnProperty.call(PROVIDER_OBJECT_PREFIX, reference.objectType)) {
      throw new Error('COMMERCIAL_BILLING_PROVIDER_OBJECT_TYPE_INVALID')
    }
    const objectType = reference.objectType as CommercialBillingProviderObjectReference['objectType']
    const prefix = PROVIDER_OBJECT_PREFIX[objectType]
    if (
      typeof reference.objectId !== 'string' ||
      !reference.objectId.startsWith(prefix) ||
      reference.objectId.length <= prefix.length ||
      reference.objectId.length > 255 ||
      seen.has(reference.objectId)
    ) {
      throw new Error('COMMERCIAL_BILLING_PROVIDER_OBJECT_ID_INVALID')
    }
    seen.add(reference.objectId)
    return { objectType, objectId: reference.objectId }
  })
  return references.sort((left, right) => left.objectType.localeCompare(right.objectType))
}

function assertReconciliationInput(input: ReconcileCommercialCashReceiptInput): void {
  requiredId(input.organizationId, 'COMMERCIAL_BILLING_ORGANIZATION_ID_INVALID')
  requiredId(input.venueId, 'COMMERCIAL_BILLING_VENUE_ID_INVALID')
  requiredId(input.receivableId, 'COMMERCIAL_BILLING_RECEIVABLE_ID_INVALID')
  requiredId(input.idempotencyKey, 'COMMERCIAL_BILLING_IDEMPOTENCY_KEY_INVALID')
  if (input.reconciledById !== undefined) {
    requiredId(input.reconciledById, 'COMMERCIAL_BILLING_RECONCILER_ID_INVALID')
  }
  if (input.paymentAttemptId !== undefined) {
    requiredId(input.paymentAttemptId, 'COMMERCIAL_BILLING_PAYMENT_ATTEMPT_ID_INVALID')
  }
  if (input.paymentAttemptProviderId !== undefined) {
    requiredId(input.paymentAttemptProviderId, 'COMMERCIAL_BILLING_PROVIDER_ATTEMPT_ID_INVALID')
    if (!input.paymentAttemptId) throw new Error('COMMERCIAL_BILLING_PAYMENT_ATTEMPT_ID_REQUIRED')
  }
  validDateMillis(input.now)
  resolveCommercialCashReceiptObservation({ observation: input.observation, existingReceipt: null })
  validatedProviderObjectReferences(input)
}

async function replayResult(
  tx: Prisma.TransactionClient,
  input: ReconcileCommercialCashReceiptInput,
  existing: Awaited<ReturnType<Prisma.TransactionClient['commercialCashReceipt']['findUnique']>> & {
    paymentAttemptId?: string | null
    allocations?: Array<{
      amountMinor: bigint
      idempotencyKey: string
      receivableId: string
      receivable?: {
        status: ReconciledCommercialCashReceiptResult['receivableStatus']
        subscriptionPeriod?: { id: string; status: ReconciledCommercialCashReceiptResult['periodStatus'] } | null
      }
    }>
    providerObjects?: Array<{ objectType: string; objectId: string }>
  },
): Promise<ReconciledCommercialCashReceiptResult> {
  if (!existing) throw new Error('COMMERCIAL_BILLING_RECEIPT_REPLAY_INVALID')
  resolveCommercialCashReceiptObservation({
    observation: input.observation,
    existingReceipt: {
      id: existing.id,
      provider: existing.provider,
      providerEventId: existing.providerEventId,
      amountMinor: existing.amountMinor,
      currency: existing.currency as 'MXN',
      receivingAccountFingerprint: existing.receivingAccountFingerprint,
      observedAt: existing.observedAt,
    },
  })
  if (existing.organizationId !== input.organizationId || existing.venueId !== input.venueId) {
    throw new Error('COMMERCIAL_BILLING_RECEIPT_TENANT_CONFLICT')
  }
  if ((existing.paymentAttemptId ?? undefined) !== input.paymentAttemptId) {
    throw new Error('COMMERCIAL_BILLING_RECEIPT_ATTEMPT_CONFLICT')
  }
  const expectedProviderObjects = validatedProviderObjectReferences(input)
  const existingProviderObjects = (existing.providerObjects ?? [])
    .map(reference => ({ objectType: reference.objectType, objectId: reference.objectId }))
    .sort((left, right) => left.objectType.localeCompare(right.objectType))
  if (JSON.stringify(existingProviderObjects) !== JSON.stringify(expectedProviderObjects)) {
    throw new Error('COMMERCIAL_BILLING_PROVIDER_OBJECT_REPLAY_CONFLICT')
  }

  const allocation = existing.allocations?.find(
    candidate =>
      candidate.receivableId === input.receivableId && candidate.idempotencyKey === allocationIdempotencyKey(input),
  )
  if (!allocation?.receivable) throw new Error('COMMERCIAL_BILLING_RECEIPT_REPLAY_INCOMPLETE')
  const period = allocation.receivable.subscriptionPeriod
  const outbox = period
    ? await tx.commercialEventOutbox.findFirst({
        where: {
          sourceType: 'SUBSCRIPTION_PERIOD',
          sourceId: period.id,
          eventType: 'SUBSCRIPTION_PAYMENT_RECONCILED',
        },
        orderBy: { sourceRevision: 'desc' },
        select: { eventId: true },
      })
    : null

  return {
    decision: 'REPLAY',
    receiptId: existing.id,
    allocatedMinor: allocation.amountMinor,
    receivableStatus: allocation.receivable.status,
    periodStatus: period?.status ?? 'OPEN',
    eventId: outbox?.eventId ?? null,
  }
}

export async function reconcileCommercialCashReceipt(
  input: ReconcileCommercialCashReceiptInput,
  dependencies: { host?: CommercialBillingTransactionHost } = {},
): Promise<ReconciledCommercialCashReceiptResult> {
  assertReconciliationInput(input)
  const host = dependencies.host ?? (prisma as PrismaClient)

  return host.$transaction(async tx => {
    const existing = await tx.commercialCashReceipt.findUnique({
      where: {
        provider_providerEventId: {
          provider: input.observation.provider,
          providerEventId: input.observation.providerEventId,
        },
      },
      include: {
        allocations: {
          include: {
            receivable: { include: { subscriptionPeriod: { select: { id: true, status: true } } } },
          },
        },
        providerObjects: { select: { objectType: true, objectId: true } },
      },
    })
    if (existing) return replayResult(tx, input, existing)

    const [receivable] = await tx.$queryRawUnsafe<LockedCommercialReceivableRow[]>(
      `SELECT ar."id", ar."organizationId", ar."venueId", ar."subscriptionPeriodId",
              ar."subjectType", ar."amountDueMinor", ar."currency", ar."status"
         FROM "CommercialAccountReceivable" AS ar
        WHERE ar."id" = $1
        FOR UPDATE OF ar`,
      input.receivableId,
    )
    if (!receivable) throw new Error('COMMERCIAL_BILLING_RECEIVABLE_NOT_FOUND')
    if (receivable.organizationId !== input.organizationId || receivable.venueId !== input.venueId) {
      throw new Error('COMMERCIAL_BILLING_RECEIVABLE_TENANT_MISMATCH')
    }
    if (receivable.currency !== input.observation.currency) {
      throw new Error('COMMERCIAL_BILLING_RECEIVABLE_CURRENCY_MISMATCH')
    }
    if (receivable.subjectType !== 'SUBSCRIPTION_PERIOD' || !receivable.subscriptionPeriodId) {
      throw new Error('COMMERCIAL_BILLING_SUBSCRIPTION_RECEIVABLE_REQUIRED')
    }
    if (receivable.status === 'CANCELED') throw new Error('COMMERCIAL_BILLING_RECEIVABLE_CANCELED')

    let paymentAttempt: LockedCommercialBillingPaymentAttemptRow | null = null
    if (input.paymentAttemptId) {
      const [lockedAttempt] = await tx.$queryRawUnsafe<LockedCommercialBillingPaymentAttemptRow[]>(
        `SELECT "id", "receivableId", "provider", "providerAttemptId", "status", "amountMinor", "currency"
           FROM "CommercialBillingPaymentAttempt"
          WHERE "id" = $1
          FOR UPDATE`,
        input.paymentAttemptId,
      )
      if (!lockedAttempt) throw new Error('COMMERCIAL_BILLING_PAYMENT_ATTEMPT_NOT_FOUND')
      if (
        lockedAttempt.receivableId !== input.receivableId ||
        lockedAttempt.provider !== input.observation.provider ||
        lockedAttempt.amountMinor !== input.observation.amountMinor ||
        lockedAttempt.currency !== input.observation.currency
      ) {
        throw new Error('COMMERCIAL_BILLING_PAYMENT_ATTEMPT_MISMATCH')
      }
      if (
        input.paymentAttemptProviderId &&
        lockedAttempt.providerAttemptId &&
        lockedAttempt.providerAttemptId !== input.paymentAttemptProviderId
      ) {
        throw new Error('COMMERCIAL_BILLING_PROVIDER_ATTEMPT_CONFLICT')
      }
      if (!['PENDING', 'OUTCOME_UNKNOWN'].includes(lockedAttempt.status)) {
        throw new Error('COMMERCIAL_BILLING_PAYMENT_ATTEMPT_NOT_RECONCILABLE')
      }
      paymentAttempt = lockedAttempt
    }

    // This is a separate statement on purpose. If the AR lock waited for a
    // concurrent reconciliation, READ COMMITTED now observes that transaction's
    // period transition instead of retaining the first statement's stale join.
    const [lockedPeriod] = await tx.$queryRawUnsafe<LockedCommercialSubscriptionPeriodRow[]>(
      `SELECT "id", "status", "statusRevision"
         FROM "CommercialSubscriptionPeriod"
        WHERE "id" = $1
        FOR UPDATE`,
      receivable.subscriptionPeriodId,
    )
    if (!lockedPeriod) throw new Error('COMMERCIAL_BILLING_SUBSCRIPTION_PERIOD_NOT_FOUND')

    const [allocationState] = await tx.$queryRawUnsafe<ActiveAllocationRow[]>(
      `SELECT COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amountMinor" ELSE -"amountMinor" END), 0)::bigint
              AS "activeAllocatedMinor"
         FROM "CommercialBillingAllocation"
        WHERE "receivableId" = $1`,
      input.receivableId,
    )
    const activeAllocatedMinor = allocationState?.activeAllocatedMinor ?? 0n
    const plan = buildCommercialBillingAllocationPlan({
      receiptAmountMinor: input.observation.amountMinor,
      receiptAllocatedMinor: 0n,
      targets: [
        {
          receivableId: input.receivableId,
          amountMinor: receivable.amountDueMinor,
          allocatedMinor: activeAllocatedMinor,
        },
      ],
    })
    const plannedAllocation = plan.allocations[0]

    const receipt = await tx.commercialCashReceipt.create({
      data: {
        organizationId: input.organizationId,
        venueId: input.venueId,
        paymentAttemptId: paymentAttempt?.id,
        provider: input.observation.provider,
        providerEventId: input.observation.providerEventId,
        idempotencyKey: input.idempotencyKey,
        entryType: 'PAYMENT',
        amountMinor: input.observation.amountMinor,
        currency: input.observation.currency,
        receivingAccountFingerprint: input.observation.receivingAccountFingerprint,
        observedAt: input.observation.observedAt,
        reconciledById: input.reconciledById,
      },
      select: { id: true },
    })

    const providerObjectReferences = validatedProviderObjectReferences(input)
    if (providerObjectReferences.length > 0) {
      await tx.commercialBillingProviderObject.createMany({
        data: providerObjectReferences.map(reference => ({
          provider: input.observation.provider,
          objectType: reference.objectType,
          objectId: reference.objectId,
          organizationId: input.organizationId,
          venueId: input.venueId,
          paymentAttemptId: input.paymentAttemptId!,
          cashReceiptId: receipt.id,
        })),
      })
    }

    if (paymentAttempt) {
      await tx.commercialBillingPaymentAttempt.update({
        where: { id: paymentAttempt.id },
        data: {
          status: 'SUCCEEDED',
          lastErrorCode: null,
          ...(input.paymentAttemptProviderId ? { providerAttemptId: input.paymentAttemptProviderId } : {}),
        },
      })
    }

    if (plannedAllocation) {
      await tx.commercialBillingAllocation.create({
        data: {
          cashReceiptId: receipt.id,
          receivableId: input.receivableId,
          direction: 'CREDIT',
          amountMinor: plannedAllocation.amountMinor,
          idempotencyKey: allocationIdempotencyKey(input),
        },
      })
    }

    const nextActiveMinor = activeAllocatedMinor + (plannedAllocation?.amountMinor ?? 0n)
    const receivableStatus: ReconciledCommercialCashReceiptResult['receivableStatus'] =
      nextActiveMinor === receivable.amountDueMinor
        ? 'PAID'
        : nextActiveMinor > 0n
          ? 'PARTIALLY_PAID'
          : receivable.status
    await tx.commercialAccountReceivable.update({
      where: { id: input.receivableId },
      data: { status: receivableStatus },
    })

    let periodStatus = lockedPeriod.status
    let eventId: string | null = null
    if (plannedAllocation?.becomesCovered === true && receivableStatus === 'PAID' && periodStatus !== 'PAID') {
      const period = await tx.commercialSubscriptionPeriod.update({
        where: { id: receivable.subscriptionPeriodId },
        data: { status: 'PAID', paidAt: input.now, statusRevision: { increment: 1 } },
        select: { id: true, statusRevision: true },
      })
      periodStatus = 'PAID'
      eventId = eventIdForPeriod(period.id, period.statusRevision)
      await tx.commercialEventOutbox.create({
        data: {
          eventId,
          organizationId: input.organizationId,
          venueId: input.venueId,
          sourceType: 'SUBSCRIPTION_PERIOD',
          sourceId: period.id,
          sourceRevision: period.statusRevision,
          eventType: 'SUBSCRIPTION_PAYMENT_RECONCILED',
          payload: {
            schemaVersion: 1,
            periodId: period.id,
            receivableId: input.receivableId,
            receiptId: receipt.id,
            allocatedMinor: (plannedAllocation?.amountMinor ?? 0n).toString(),
            currency: input.observation.currency,
          },
          status: 'PENDING',
          attemptCount: 0,
          availableAt: input.now,
        },
      })
    }

    await tx.activityLog.create({
      data: {
        organizationId: input.organizationId,
        venueId: input.venueId,
        actorType: input.reconciledById ? 'HUMAN' : 'SERVICE',
        staffId: input.reconciledById,
        actorStaffId: input.reconciledById,
        servicePrincipalId: input.reconciledById ? undefined : 'commercial-billing-reconciliation',
        action: 'COMMERCIAL_CASH_RECEIPT_RECONCILED',
        entity: 'CommercialCashReceipt',
        entityId: receipt.id,
        data: {
          schemaVersion: 1,
          provider: input.observation.provider,
          receivableId: input.receivableId,
          allocatedMinor: (plannedAllocation?.amountMinor ?? 0n).toString(),
          receivableStatus,
          eventId,
        },
      },
    })

    return {
      decision: 'RECONCILED',
      receiptId: receipt.id,
      allocatedMinor: plannedAllocation?.amountMinor ?? 0n,
      receivableStatus,
      periodStatus,
      eventId,
    }
  }, {
    maxWait: 5_000,
    timeout: 30_000,
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  })
}
