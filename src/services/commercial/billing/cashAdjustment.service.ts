import { createHash } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'

import { MAX_COMMERCIAL_MONEY_MINOR } from '@/contracts/commercial/commercialContractV2.constants'
import type { ReconcileCommercialCashAdjustmentInput, ReconcileCommercialCashAdjustmentResult } from '@/types/commercialBilling'
import prisma from '@/utils/prismaClient'
import type { CommercialBillingTransactionHost } from './cashReceipt.service'
import { evaluateCommercialSubscriptionPeriodCoverage } from './subscriptionPeriod.service'

export interface CommercialCashAdjustmentPlanInput {
  originalPaymentAmountMinor: bigint
  previouslyAdjustedMinor: bigint
  originalAllocatedMinor: bigint
  previouslyDebitedMinor: bigint
  activeReceivableAllocatedMinor: bigint
  adjustmentAmountMinor: bigint
}

export interface CommercialCashAdjustmentPlan {
  debitMinor: bigint
  nextActiveReceivableAllocatedMinor: bigint
  remainingAdjustablePaymentMinor: bigint
  remainingOriginalCoverageMinor: bigint
}

function assertMoney(value: bigint, code: string): void {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_COMMERCIAL_MONEY_MINOR) {
    throw new Error(code)
  }
}

function minimum(...values: bigint[]): bigint {
  return values.reduce((least, value) => (value < least ? value : least))
}

/**
 * Computes a refund/reversal write plan from values read under the same locks
 * that will protect the compensating receipt and DEBIT allocation.
 */
export function buildCommercialCashAdjustmentPlan(input: CommercialCashAdjustmentPlanInput): CommercialCashAdjustmentPlan {
  assertMoney(input.originalPaymentAmountMinor, 'COMMERCIAL_BILLING_ORIGINAL_PAYMENT_AMOUNT_INVALID')
  assertMoney(input.previouslyAdjustedMinor, 'COMMERCIAL_BILLING_PREVIOUS_ADJUSTMENT_INVALID')
  assertMoney(input.originalAllocatedMinor, 'COMMERCIAL_BILLING_ORIGINAL_ALLOCATION_INVALID')
  assertMoney(input.previouslyDebitedMinor, 'COMMERCIAL_BILLING_PREVIOUS_DEBIT_INVALID')
  assertMoney(input.activeReceivableAllocatedMinor, 'COMMERCIAL_BILLING_ACTIVE_ALLOCATION_INVALID')
  assertMoney(input.adjustmentAmountMinor, 'COMMERCIAL_BILLING_ADJUSTMENT_AMOUNT_INVALID')
  if (input.adjustmentAmountMinor === 0n) throw new Error('COMMERCIAL_BILLING_ADJUSTMENT_AMOUNT_INVALID')
  if (input.previouslyAdjustedMinor > input.originalPaymentAmountMinor) {
    throw new Error('COMMERCIAL_BILLING_PREVIOUS_ADJUSTMENT_EXCEEDS_PAYMENT')
  }
  if (input.originalAllocatedMinor > input.originalPaymentAmountMinor) {
    throw new Error('COMMERCIAL_BILLING_ORIGINAL_ALLOCATION_EXCEEDS_PAYMENT')
  }
  if (input.previouslyDebitedMinor > input.originalAllocatedMinor) {
    throw new Error('COMMERCIAL_BILLING_PREVIOUS_DEBIT_EXCEEDS_ALLOCATION')
  }

  const adjustablePaymentMinor = input.originalPaymentAmountMinor - input.previouslyAdjustedMinor
  if (input.adjustmentAmountMinor > adjustablePaymentMinor) {
    throw new Error('COMMERCIAL_BILLING_ADJUSTMENT_EXCEEDS_PAYMENT')
  }
  const unallocatedOriginalPaymentMinor = input.originalPaymentAmountMinor - input.originalAllocatedMinor
  const requiredPreviousDebitMinor =
    input.previouslyAdjustedMinor > unallocatedOriginalPaymentMinor ? input.previouslyAdjustedMinor - unallocatedOriginalPaymentMinor : 0n
  if (input.previouslyDebitedMinor > requiredPreviousDebitMinor) {
    throw new Error('COMMERCIAL_BILLING_PREVIOUS_DEBIT_EXCEEDS_REQUIRED_COVERAGE')
  }
  const adjustedAfterThisReceiptMinor = input.previouslyAdjustedMinor + input.adjustmentAmountMinor
  const requiredCumulativeDebitMinor =
    adjustedAfterThisReceiptMinor > unallocatedOriginalPaymentMinor ? adjustedAfterThisReceiptMinor - unallocatedOriginalPaymentMinor : 0n
  const requestedDebitMinor = requiredCumulativeDebitMinor - input.previouslyDebitedMinor
  const originalCoverageMinor = input.originalAllocatedMinor - input.previouslyDebitedMinor
  const debitMinor = minimum(requestedDebitMinor, originalCoverageMinor, input.activeReceivableAllocatedMinor)

  return {
    debitMinor,
    nextActiveReceivableAllocatedMinor: input.activeReceivableAllocatedMinor - debitMinor,
    remainingAdjustablePaymentMinor: adjustablePaymentMinor - input.adjustmentAmountMinor,
    remainingOriginalCoverageMinor: originalCoverageMinor - debitMinor,
  }
}

interface LockedOriginalPaymentRow {
  originalReceiptId: string
  organizationId: string
  venueId: string
  provider: ReconcileCommercialCashAdjustmentInput['observation']['provider']
  entryType: string
  originalPaymentAmountMinor: bigint
  currency: string
  receivableId: string
  originalAllocatedMinor: bigint
  amountDueMinor: bigint
  periodId: string
  periodStatus: ReconcileCommercialCashAdjustmentResult['periodStatus']
  periodStatusRevision: number
  dueAt: Date
  graceEndsAt: Date
}

interface AdjustmentAggregateRow {
  previouslyAdjustedMinor: bigint
  previouslyDebitedMinor: bigint
  activeReceivableAllocatedMinor: bigint
}

interface ExistingAdjustmentReplayRow {
  debitMinor: bigint
  receivableStatus: ReconcileCommercialCashAdjustmentResult['receivableStatus']
  periodId: string
  periodStatus: ReconcileCommercialCashAdjustmentResult['periodStatus']
  eventId: string | null
}

function requiredId(value: string, code: string): void {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(code)
}

function validDate(value: Date, code: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(code)
}

function assertAdjustmentInput(input: ReconcileCommercialCashAdjustmentInput): void {
  requiredId(input.organizationId, 'COMMERCIAL_BILLING_ADJUSTMENT_ORGANIZATION_INVALID')
  requiredId(input.venueId, 'COMMERCIAL_BILLING_ADJUSTMENT_VENUE_INVALID')
  requiredId(input.originalReceiptId, 'COMMERCIAL_BILLING_ADJUSTMENT_ORIGINAL_RECEIPT_INVALID')
  requiredId(input.idempotencyKey, 'COMMERCIAL_BILLING_ADJUSTMENT_IDEMPOTENCY_INVALID')
  if (input.reconciledById !== undefined) {
    requiredId(input.reconciledById, 'COMMERCIAL_BILLING_ADJUSTMENT_RECONCILER_INVALID')
  }
  if (!['STRIPE', 'MANUAL_SPEI', 'AUTOMATIC_SPEI'].includes(input.observation.provider)) {
    throw new Error('COMMERCIAL_BILLING_ADJUSTMENT_PROVIDER_INVALID')
  }
  requiredId(input.observation.providerEventId, 'COMMERCIAL_BILLING_ADJUSTMENT_PROVIDER_EVENT_INVALID')
  if (!['REFUND', 'REVERSAL'].includes(input.observation.entryType)) {
    throw new Error('COMMERCIAL_BILLING_ADJUSTMENT_ENTRY_TYPE_INVALID')
  }
  assertMoney(input.observation.amountMinor, 'COMMERCIAL_BILLING_ADJUSTMENT_AMOUNT_INVALID')
  if (input.observation.amountMinor === 0n) throw new Error('COMMERCIAL_BILLING_ADJUSTMENT_AMOUNT_INVALID')
  if (input.observation.currency !== 'MXN') throw new Error('COMMERCIAL_BILLING_ADJUSTMENT_CURRENCY_INVALID')
  if (!/^[0-9a-f]{64}$/u.test(input.observation.receivingAccountFingerprint)) {
    throw new Error('COMMERCIAL_BILLING_ADJUSTMENT_ACCOUNT_FINGERPRINT_INVALID')
  }
  validDate(input.observation.observedAt, 'COMMERCIAL_BILLING_ADJUSTMENT_OBSERVED_AT_INVALID')
  validDate(input.now, 'COMMERCIAL_BILLING_ADJUSTMENT_NOW_INVALID')
}

function adjustmentEventId(periodId: string, revision: number): string {
  return createHash('sha256')
    .update(`avoqado:commercial-billing:period:${periodId}:revision:${revision}:payment-coverage-reversed`)
    .digest('hex')
}

function adjustmentAllocationKey(input: ReconcileCommercialCashAdjustmentInput): string {
  return `${input.idempotencyKey}:debit:${input.originalReceiptId}`
}

async function replayCommercialCashAdjustment(
  tx: Prisma.TransactionClient,
  input: ReconcileCommercialCashAdjustmentInput,
  existing: {
    id: string
    organizationId: string
    venueId: string
    provider: string
    providerEventId: string
    idempotencyKey: string
    entryType: string
    relatedReceiptId: string | null
    amountMinor: bigint
    currency: string
    receivingAccountFingerprint: string
    observedAt: Date
  },
): Promise<ReconcileCommercialCashAdjustmentResult> {
  if (
    existing.organizationId !== input.organizationId ||
    existing.venueId !== input.venueId ||
    existing.provider !== input.observation.provider ||
    existing.providerEventId !== input.observation.providerEventId ||
    existing.idempotencyKey !== input.idempotencyKey ||
    existing.entryType !== input.observation.entryType ||
    existing.relatedReceiptId !== input.originalReceiptId ||
    existing.amountMinor !== input.observation.amountMinor ||
    existing.currency !== input.observation.currency ||
    existing.receivingAccountFingerprint !== input.observation.receivingAccountFingerprint ||
    existing.observedAt.getTime() !== input.observation.observedAt.getTime()
  ) {
    throw new Error('COMMERCIAL_BILLING_ADJUSTMENT_REPLAY_CONFLICT')
  }

  const [row] = await tx.$queryRawUnsafe<ExistingAdjustmentReplayRow[]>(
    `SELECT COALESCE(allocation."amountMinor", 0)::bigint AS "debitMinor",
            receivable."status"::text AS "receivableStatus",
            period."id" AS "periodId", period."status"::text AS "periodStatus",
            (SELECT outbox."eventId"
               FROM "CommercialEventOutbox" AS outbox
              WHERE outbox."eventType" = 'SUBSCRIPTION_PAYMENT_COVERAGE_REVERSED'
                AND outbox."payload"->>'adjustmentReceiptId' = adjustment."id"
              LIMIT 1) AS "eventId"
       FROM "CommercialCashReceipt" AS adjustment
       LEFT JOIN "CommercialBillingAllocation" AS allocation
         ON allocation."cashReceiptId" = adjustment."id" AND allocation."direction" = 'DEBIT'
       JOIN "CommercialCashReceipt" AS original ON original."id" = adjustment."relatedReceiptId"
       LEFT JOIN "CommercialBillingAllocation" AS original_allocation
         ON original_allocation."cashReceiptId" = original."id" AND original_allocation."direction" = 'CREDIT'
       LEFT JOIN "CommercialBillingPaymentAttempt" AS attempt ON attempt."id" = original."paymentAttemptId"
       JOIN "CommercialAccountReceivable" AS receivable
         ON receivable."id" = COALESCE(original_allocation."receivableId", attempt."receivableId")
       JOIN "CommercialSubscriptionPeriod" AS period ON period."id" = receivable."subscriptionPeriodId"
      WHERE adjustment."id" = $1`,
    existing.id,
  )
  if (!row) throw new Error('COMMERCIAL_BILLING_ADJUSTMENT_REPLAY_INCOMPLETE')
  return {
    decision: 'REPLAY',
    adjustmentReceiptId: existing.id,
    debitMinor: row.debitMinor,
    receivableStatus: row.receivableStatus,
    periodStatus: row.periodStatus,
    eventId: row.eventId,
  }
}

export async function reconcileCommercialCashAdjustment(
  input: ReconcileCommercialCashAdjustmentInput,
  dependencies: { host?: CommercialBillingTransactionHost } = {},
): Promise<ReconcileCommercialCashAdjustmentResult> {
  assertAdjustmentInput(input)
  const host = dependencies.host ?? (prisma as PrismaClient)

  return host.$transaction(
    async tx => {
      const existing = await tx.commercialCashReceipt.findUnique({
        where: {
          provider_providerEventId: {
            provider: input.observation.provider,
            providerEventId: input.observation.providerEventId,
          },
        },
        select: {
          id: true,
          organizationId: true,
          venueId: true,
          provider: true,
          providerEventId: true,
          idempotencyKey: true,
          entryType: true,
          relatedReceiptId: true,
          amountMinor: true,
          currency: true,
          receivingAccountFingerprint: true,
          observedAt: true,
        },
      })
      if (existing) return replayCommercialCashAdjustment(tx, input, existing)

      const originalRows = await tx.$queryRawUnsafe<LockedOriginalPaymentRow[]>(
        `SELECT original."id" AS "originalReceiptId", original."organizationId", original."venueId",
              original."provider"::text, original."entryType"::text,
              original."amountMinor" AS "originalPaymentAmountMinor", original."currency",
              COALESCE(allocation."receivableId", attempt."receivableId") AS "receivableId",
              COALESCE(allocation."amountMinor", 0)::bigint AS "originalAllocatedMinor",
              receivable."amountDueMinor", period."id" AS "periodId",
              period."status"::text AS "periodStatus", period."statusRevision" AS "periodStatusRevision",
              period."dueAt", period."graceEndsAt"
         FROM "CommercialCashReceipt" AS original
         LEFT JOIN "CommercialBillingAllocation" AS allocation
           ON allocation."cashReceiptId" = original."id" AND allocation."direction" = 'CREDIT'
         LEFT JOIN "CommercialBillingPaymentAttempt" AS attempt ON attempt."id" = original."paymentAttemptId"
         JOIN "CommercialAccountReceivable" AS receivable
           ON receivable."id" = COALESCE(allocation."receivableId", attempt."receivableId")
         JOIN "CommercialSubscriptionPeriod" AS period ON period."id" = receivable."subscriptionPeriodId"
        WHERE original."id" = $1
        FOR UPDATE OF original, receivable, period`,
        input.originalReceiptId,
      )
      if (originalRows.length === 0) throw new Error('COMMERCIAL_BILLING_ADJUSTMENT_ORIGINAL_PAYMENT_NOT_FOUND')
      if (originalRows.length !== 1) throw new Error('COMMERCIAL_BILLING_ADJUSTMENT_MULTI_RECEIVABLE_UNSUPPORTED')
      const [original] = originalRows
      if (!original) throw new Error('COMMERCIAL_BILLING_ADJUSTMENT_ORIGINAL_PAYMENT_NOT_FOUND')
      if (
        original.entryType !== 'PAYMENT' ||
        original.organizationId !== input.organizationId ||
        original.venueId !== input.venueId ||
        original.provider !== input.observation.provider ||
        original.currency !== input.observation.currency
      ) {
        throw new Error('COMMERCIAL_BILLING_ADJUSTMENT_ORIGINAL_PAYMENT_MISMATCH')
      }

      const racedExisting = await tx.commercialCashReceipt.findUnique({
        where: {
          provider_providerEventId: {
            provider: input.observation.provider,
            providerEventId: input.observation.providerEventId,
          },
        },
        select: {
          id: true,
          organizationId: true,
          venueId: true,
          provider: true,
          providerEventId: true,
          idempotencyKey: true,
          entryType: true,
          relatedReceiptId: true,
          amountMinor: true,
          currency: true,
          receivingAccountFingerprint: true,
          observedAt: true,
        },
      })
      if (racedExisting) return replayCommercialCashAdjustment(tx, input, racedExisting)

      const [aggregate] = await tx.$queryRawUnsafe<AdjustmentAggregateRow[]>(
        `SELECT
         COALESCE((
           SELECT SUM(adjustment."amountMinor")
             FROM "CommercialCashReceipt" AS adjustment
            WHERE adjustment."relatedReceiptId" = $1
              AND adjustment."entryType" IN ('REFUND', 'REVERSAL')
         ), 0)::bigint AS "previouslyAdjustedMinor",
         COALESCE((
           SELECT SUM(allocation."amountMinor")
             FROM "CommercialBillingAllocation" AS allocation
             JOIN "CommercialCashReceipt" AS adjustment ON adjustment."id" = allocation."cashReceiptId"
            WHERE adjustment."relatedReceiptId" = $1 AND allocation."direction" = 'DEBIT'
         ), 0)::bigint AS "previouslyDebitedMinor",
         COALESCE((
           SELECT SUM(CASE WHEN "direction" = 'CREDIT' THEN "amountMinor" ELSE -"amountMinor" END)
             FROM "CommercialBillingAllocation"
            WHERE "receivableId" = $2
         ), 0)::bigint AS "activeReceivableAllocatedMinor"`,
        input.originalReceiptId,
        original.receivableId,
      )
      if (!aggregate) throw new Error('COMMERCIAL_BILLING_ADJUSTMENT_LEDGER_STATE_MISSING')
      const plan = buildCommercialCashAdjustmentPlan({
        originalPaymentAmountMinor: original.originalPaymentAmountMinor,
        previouslyAdjustedMinor: aggregate.previouslyAdjustedMinor,
        originalAllocatedMinor: original.originalAllocatedMinor,
        previouslyDebitedMinor: aggregate.previouslyDebitedMinor,
        activeReceivableAllocatedMinor: aggregate.activeReceivableAllocatedMinor,
        adjustmentAmountMinor: input.observation.amountMinor,
      })

      const adjustment = await tx.commercialCashReceipt.create({
        data: {
          organizationId: input.organizationId,
          venueId: input.venueId,
          provider: input.observation.provider,
          providerEventId: input.observation.providerEventId,
          idempotencyKey: input.idempotencyKey,
          entryType: input.observation.entryType,
          relatedReceiptId: input.originalReceiptId,
          amountMinor: input.observation.amountMinor,
          currency: input.observation.currency,
          receivingAccountFingerprint: input.observation.receivingAccountFingerprint,
          observedAt: input.observation.observedAt,
          reconciledById: input.reconciledById,
        },
        select: { id: true },
      })
      if (plan.debitMinor > 0n) {
        await tx.commercialBillingAllocation.create({
          data: {
            cashReceiptId: adjustment.id,
            receivableId: original.receivableId,
            direction: 'DEBIT',
            amountMinor: plan.debitMinor,
            idempotencyKey: adjustmentAllocationKey(input),
          },
        })
      }

      const coverage = evaluateCommercialSubscriptionPeriodCoverage({
        previousStatus: original.periodStatus,
        amountDueMinor: original.amountDueMinor,
        activeAllocatedMinor: plan.nextActiveReceivableAllocatedMinor,
        dueAt: original.dueAt,
        graceEndsAt: original.graceEndsAt,
        now: input.now,
      })
      const receivableStatus: ReconcileCommercialCashAdjustmentResult['receivableStatus'] =
        coverage.status === 'PAID' ? 'PAID' : plan.nextActiveReceivableAllocatedMinor > 0n ? 'PARTIALLY_PAID' : coverage.status
      await tx.commercialAccountReceivable.update({
        where: { id: original.receivableId },
        data: { status: receivableStatus },
      })

      let eventId: string | null = null
      let periodStatus = original.periodStatus
      if (coverage.status !== original.periodStatus) {
        const period = await tx.commercialSubscriptionPeriod.update({
          where: { id: original.periodId },
          data: {
            status: coverage.status,
            paidAt: coverage.status === 'PAID' ? input.now : null,
            statusRevision: { increment: 1 },
          },
          select: { id: true, statusRevision: true },
        })
        periodStatus = coverage.status
        if (coverage.transition === 'PAYMENT_COVERAGE_REVERSED') {
          eventId = adjustmentEventId(period.id, period.statusRevision)
          await tx.commercialEventOutbox.create({
            data: {
              eventId,
              organizationId: input.organizationId,
              venueId: input.venueId,
              sourceType: 'SUBSCRIPTION_PERIOD',
              sourceId: period.id,
              sourceRevision: period.statusRevision,
              eventType: 'SUBSCRIPTION_PAYMENT_COVERAGE_REVERSED',
              payload: {
                schemaVersion: 1,
                periodId: period.id,
                receivableId: original.receivableId,
                originalReceiptId: input.originalReceiptId,
                adjustmentReceiptId: adjustment.id,
                adjustmentEntryType: input.observation.entryType,
                adjustmentAmountMinor: input.observation.amountMinor.toString(),
                debitedMinor: plan.debitMinor.toString(),
                currency: input.observation.currency,
              },
              status: 'PENDING',
              attemptCount: 0,
              availableAt: input.now,
            },
          })
        }
      }

      await tx.activityLog.create({
        data: {
          organizationId: input.organizationId,
          venueId: input.venueId,
          actorType: input.reconciledById ? 'HUMAN' : 'SERVICE',
          staffId: input.reconciledById,
          actorStaffId: input.reconciledById,
          servicePrincipalId: input.reconciledById ? undefined : 'commercial-billing-adjustment',
          action: 'COMMERCIAL_CASH_ADJUSTMENT_RECONCILED',
          entity: 'CommercialCashReceipt',
          entityId: adjustment.id,
          data: {
            schemaVersion: 1,
            originalReceiptId: input.originalReceiptId,
            entryType: input.observation.entryType,
            adjustmentAmountMinor: input.observation.amountMinor.toString(),
            debitedMinor: plan.debitMinor.toString(),
            receivableStatus,
            periodStatus,
            eventId,
          },
        },
      })

      return {
        decision: 'ADJUSTED',
        adjustmentReceiptId: adjustment.id,
        debitMinor: plan.debitMinor,
        receivableStatus,
        periodStatus,
        eventId,
      }
    },
    {
      maxWait: 5_000,
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  )
}
