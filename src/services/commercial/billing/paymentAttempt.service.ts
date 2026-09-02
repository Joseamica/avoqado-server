import { Prisma, type PrismaClient } from '@prisma/client'

import { MAX_COMMERCIAL_MONEY_MINOR } from '@/contracts/commercial/commercialContractV2.constants'
import type {
  ReserveCommercialBillingPaymentAttemptInput,
  ReserveCommercialBillingPaymentAttemptResult,
} from '@/types/commercialBilling'
import prisma from '@/utils/prismaClient'
import type { CommercialBillingTransactionHost } from './cashReceipt.service'

interface LockedAttemptReceivableRow {
  id: string
  organizationId: string
  venueId: string
  amountDueMinor: bigint
  currency: string
  status: 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'PAST_DUE' | 'EXPIRED' | 'CANCELED'
}

interface ActiveAllocationRow {
  activeAllocatedMinor: bigint
}

function requiredId(value: string, code: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(code)
  return value
}

function assertInput(input: ReserveCommercialBillingPaymentAttemptInput): void {
  requiredId(input.organizationId, 'COMMERCIAL_BILLING_ATTEMPT_ORGANIZATION_INVALID')
  requiredId(input.venueId, 'COMMERCIAL_BILLING_ATTEMPT_VENUE_INVALID')
  requiredId(input.receivableId, 'COMMERCIAL_BILLING_ATTEMPT_RECEIVABLE_INVALID')
  requiredId(input.idempotencyKey, 'COMMERCIAL_BILLING_ATTEMPT_IDEMPOTENCY_INVALID')
  if (!['STRIPE', 'MANUAL_SPEI', 'AUTOMATIC_SPEI'].includes(input.provider)) {
    throw new Error('COMMERCIAL_BILLING_ATTEMPT_PROVIDER_INVALID')
  }
  if (!/^[0-9a-f]{64}$/u.test(input.requestFingerprint)) {
    throw new Error('COMMERCIAL_BILLING_ATTEMPT_FINGERPRINT_INVALID')
  }
}

export async function reserveCommercialBillingPaymentAttempt(
  input: ReserveCommercialBillingPaymentAttemptInput,
  dependencies: { host?: CommercialBillingTransactionHost } = {},
): Promise<ReserveCommercialBillingPaymentAttemptResult> {
  assertInput(input)
  const host = dependencies.host ?? (prisma as PrismaClient)

  return host.$transaction(async tx => {
    const [receivable] = await tx.$queryRawUnsafe<LockedAttemptReceivableRow[]>(
      `SELECT "id", "organizationId", "venueId", "amountDueMinor", "currency", "status"
         FROM "CommercialAccountReceivable"
        WHERE "id" = $1
        FOR UPDATE`,
      input.receivableId,
    )
    if (!receivable) throw new Error('COMMERCIAL_BILLING_ATTEMPT_RECEIVABLE_NOT_FOUND')
    if (receivable.organizationId !== input.organizationId || receivable.venueId !== input.venueId) {
      throw new Error('COMMERCIAL_BILLING_ATTEMPT_TENANT_MISMATCH')
    }
    if (receivable.currency !== 'MXN') throw new Error('COMMERCIAL_BILLING_ATTEMPT_CURRENCY_INVALID')
    if (['PAID', 'EXPIRED', 'CANCELED'].includes(receivable.status)) {
      throw new Error('COMMERCIAL_BILLING_ATTEMPT_RECEIVABLE_NOT_PAYABLE')
    }

    const [allocation] = await tx.$queryRawUnsafe<ActiveAllocationRow[]>(
      `SELECT COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amountMinor" ELSE -"amountMinor" END), 0)::bigint
              AS "activeAllocatedMinor"
         FROM "CommercialBillingAllocation"
        WHERE "receivableId" = $1`,
      input.receivableId,
    )
    const activeAllocatedMinor = allocation?.activeAllocatedMinor ?? 0n
    const outstandingMinor = receivable.amountDueMinor - activeAllocatedMinor
    if (
      outstandingMinor <= 0n ||
      outstandingMinor > receivable.amountDueMinor ||
      outstandingMinor > MAX_COMMERCIAL_MONEY_MINOR
    ) {
      throw new Error('COMMERCIAL_BILLING_ATTEMPT_OUTSTANDING_INVALID')
    }

    const existing = await tx.commercialBillingPaymentAttempt.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: {
        id: true,
        receivableId: true,
        provider: true,
        status: true,
        amountMinor: true,
        currency: true,
        requestFingerprint: true,
      },
    })
    if (existing) {
      if (
        existing.receivableId !== input.receivableId ||
        existing.provider !== input.provider ||
        existing.amountMinor !== outstandingMinor ||
        existing.currency !== 'MXN' ||
        existing.requestFingerprint !== input.requestFingerprint
      ) {
        throw new Error('COMMERCIAL_BILLING_ATTEMPT_REPLAY_CONFLICT')
      }
      return {
        decision: 'REPLAY',
        paymentAttemptId: existing.id,
        status: existing.status,
        amountMinor: existing.amountMinor,
        currency: 'MXN',
      }
    }

    const attempt = await tx.commercialBillingPaymentAttempt.create({
      data: {
        receivableId: input.receivableId,
        provider: input.provider,
        idempotencyKey: input.idempotencyKey,
        status: 'PENDING',
        amountMinor: outstandingMinor,
        currency: 'MXN',
        requestFingerprint: input.requestFingerprint,
      },
      select: { id: true, status: true, amountMinor: true },
    })
    await tx.activityLog.create({
      data: {
        organizationId: input.organizationId,
        venueId: input.venueId,
        actorType: 'SERVICE',
        servicePrincipalId: 'commercial-billing-attempt',
        action: 'COMMERCIAL_BILLING_PAYMENT_ATTEMPT_RESERVED',
        entity: 'CommercialBillingPaymentAttempt',
        entityId: attempt.id,
        data: {
          schemaVersion: 1,
          provider: input.provider,
          receivableId: input.receivableId,
          amountMinor: outstandingMinor.toString(),
          currency: 'MXN',
        },
      },
    })

    return {
      decision: 'CREATED',
      paymentAttemptId: attempt.id,
      status: attempt.status,
      amountMinor: attempt.amountMinor,
      currency: 'MXN',
    }
  }, {
    maxWait: 5_000,
    timeout: 30_000,
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  })
}
