import type Stripe from 'stripe'
import type { PrismaClient } from '@prisma/client'

import type {
  CommercialBillingProviderObjectReference,
  ReconcileCommercialCashAdjustmentInput,
  ReconcileCommercialCashAdjustmentResult,
  ReconcileCommercialCashReceiptInput,
  ReconciledCommercialCashReceiptResult,
} from '@/types/commercialBilling'
import prisma from '@/utils/prismaClient'
import { reconcileCommercialCashReceipt } from './cashReceipt.service'
import { reconcileCommercialCashAdjustment } from './cashAdjustment.service'

interface StripeBillingAttemptRecord {
  id: string
  provider: string
  providerAttemptId: string | null
  status: string
  amountMinor: bigint
  currency: string
  receivableId: string
  organizationId: string
  venueId: string
}

interface StripePaymentProviderRepository {
  loadAttempt(paymentAttemptId: string): Promise<StripeBillingAttemptRecord | null>
  loadOriginalReceiptByReferences(referenceIds: string[]): Promise<{
    receiptId: string
    receivableId: string
    organizationId: string
    venueId: string
    receivingAccountFingerprint: string
    reversedMinor: bigint
  } | null>
}

interface StripePaymentProviderDependencies {
  repository: StripePaymentProviderRepository
  reconcileCash(input: ReconcileCommercialCashReceiptInput): Promise<ReconciledCommercialCashReceiptResult>
  reconcileAdjustment(input: ReconcileCommercialCashAdjustmentInput): Promise<ReconcileCommercialCashAdjustmentResult>
  receivingAccountFingerprint: string
  now(): Date
}

function invoiceMetadata(invoice: any): Record<string, unknown> | null {
  return invoice?.metadata?.type === 'commercial_billing_v1' ? invoice.metadata : null
}

function requiredDate(value: Date, code: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(code)
  return value
}

function stripeObjectId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id
    return typeof id === 'string' && id.trim() !== '' ? id : null
  }
  return null
}

function adjustmentReferences(value: { charge?: unknown; payment_intent?: unknown }): string[] {
  return [...new Set([stripeObjectId(value.charge), stripeObjectId(value.payment_intent)].filter((id): id is string => id !== null))]
}

function invoiceProviderObjectReferences(invoice: any): CommercialBillingProviderObjectReference[] {
  const references: CommercialBillingProviderObjectReference[] = [{ objectType: 'INVOICE', objectId: invoice.id }]
  const payments = Array.isArray(invoice?.payments?.data) ? invoice.payments.data : []
  for (const invoicePayment of payments) {
    if (invoicePayment?.status !== 'paid') continue
    const paymentIntentId = stripeObjectId(invoicePayment?.payment?.payment_intent)
    const chargeId = stripeObjectId(invoicePayment?.payment?.charge)
    if (paymentIntentId) references.push({ objectType: 'PAYMENT_INTENT', objectId: paymentIntentId })
    if (chargeId) references.push({ objectType: 'CHARGE', objectId: chargeId })
  }
  return references
}

export function createStripePaymentProviderAdapter(dependencies: StripePaymentProviderDependencies) {
  if (!/^[0-9a-f]{64}$/u.test(dependencies.receivingAccountFingerprint)) {
    throw new Error('COMMERCIAL_STRIPE_RECEIVING_ACCOUNT_FINGERPRINT_INVALID')
  }

  return {
    async reconcile(
      event: Stripe.Event,
    ): Promise<
      | { matched: false; applied: false }
      | { matched: true; applied: false }
      | { matched: true; applied: boolean; receiptId: string; eventId: string | null }
    > {
      if (event.type === 'charge.dispute.funds_reinstated') {
        const dispute = event.data.object as any
        if (typeof dispute.id !== 'string' || dispute.id.trim() === '') {
          throw new Error('COMMERCIAL_STRIPE_ADJUSTMENT_ID_INVALID')
        }
        if (!Number.isSafeInteger(dispute.amount) || dispute.amount <= 0) {
          throw new Error('COMMERCIAL_STRIPE_ADJUSTMENT_AMOUNT_INVALID')
        }
        const currency = typeof dispute.currency === 'string' ? dispute.currency.toUpperCase() : ''
        if (currency !== 'MXN') throw new Error('COMMERCIAL_STRIPE_CURRENCY_INVALID')
        if (!Number.isSafeInteger(event.created) || event.created <= 0) {
          throw new Error('COMMERCIAL_STRIPE_EVENT_TIME_INVALID')
        }
        const references = adjustmentReferences(dispute)
        if (references.length === 0) throw new Error('COMMERCIAL_STRIPE_ADJUSTMENT_REFERENCE_INVALID')
        const original = await dependencies.repository.loadOriginalReceiptByReferences(references)
        if (!original) throw new Error('COMMERCIAL_STRIPE_ORIGINAL_RECEIPT_NOT_FOUND')
        if (BigInt(dispute.amount) > original.reversedMinor) {
          throw new Error('COMMERCIAL_STRIPE_REINSTATED_AMOUNT_EXCEEDS_REVERSAL')
        }
        const reconciled = await dependencies.reconcileCash({
          organizationId: original.organizationId,
          venueId: original.venueId,
          receivableId: original.receivableId,
          idempotencyKey: `stripe:dispute-reinstated:${dispute.id}`,
          observation: {
            provider: 'STRIPE',
            providerEventId: `dispute-reinstated:${dispute.id}`,
            amountMinor: BigInt(dispute.amount),
            currency: 'MXN',
            receivingAccountFingerprint: original.receivingAccountFingerprint,
            observedAt: new Date(event.created * 1000),
          },
          now: requiredDate(dependencies.now(), 'COMMERCIAL_STRIPE_RECONCILIATION_TIME_INVALID'),
        })
        return {
          matched: true,
          applied: reconciled.decision === 'RECONCILED',
          receiptId: reconciled.receiptId,
          eventId: reconciled.eventId,
        }
      }

      const adjustmentKind =
        event.type === 'refund.created' || event.type === 'refund.updated'
          ? 'REFUND'
          : event.type === 'charge.dispute.funds_withdrawn'
            ? 'REVERSAL'
            : null
      if (adjustmentKind) {
        const adjustment = event.data.object as any
        if (adjustmentKind === 'REFUND' && adjustment.status !== 'succeeded') {
          return { matched: true, applied: false }
        }
        if (typeof adjustment.id !== 'string' || adjustment.id.trim() === '') {
          throw new Error('COMMERCIAL_STRIPE_ADJUSTMENT_ID_INVALID')
        }
        if (!Number.isSafeInteger(adjustment.amount) || adjustment.amount <= 0) {
          throw new Error('COMMERCIAL_STRIPE_ADJUSTMENT_AMOUNT_INVALID')
        }
        const currency = typeof adjustment.currency === 'string' ? adjustment.currency.toUpperCase() : ''
        if (currency !== 'MXN') throw new Error('COMMERCIAL_STRIPE_CURRENCY_INVALID')
        if (!Number.isSafeInteger(event.created) || event.created <= 0) {
          throw new Error('COMMERCIAL_STRIPE_EVENT_TIME_INVALID')
        }
        const references = adjustmentReferences(adjustment)
        if (references.length === 0) throw new Error('COMMERCIAL_STRIPE_ADJUSTMENT_REFERENCE_INVALID')
        const original = await dependencies.repository.loadOriginalReceiptByReferences(references)
        if (!original) throw new Error('COMMERCIAL_STRIPE_ORIGINAL_RECEIPT_NOT_FOUND')
        const prefix = adjustmentKind === 'REFUND' ? 'refund' : 'dispute'
        const reconciled = await dependencies.reconcileAdjustment({
          organizationId: original.organizationId,
          venueId: original.venueId,
          originalReceiptId: original.receiptId,
          idempotencyKey: `stripe:${prefix}:${adjustment.id}`,
          observation: {
            provider: 'STRIPE',
            providerEventId: adjustment.id,
            entryType: adjustmentKind,
            amountMinor: BigInt(adjustment.amount),
            currency: 'MXN',
            receivingAccountFingerprint: original.receivingAccountFingerprint,
            observedAt: new Date(event.created * 1000),
          },
          now: requiredDate(dependencies.now(), 'COMMERCIAL_STRIPE_RECONCILIATION_TIME_INVALID'),
        })
        return {
          matched: true,
          applied: reconciled.decision === 'ADJUSTED',
          receiptId: reconciled.adjustmentReceiptId,
          eventId: reconciled.eventId,
        }
      }

      if (!['invoice.paid', 'invoice.payment_succeeded'].includes(event.type)) {
        return { matched: false, applied: false }
      }
      const invoice = event.data.object as any
      const metadata = invoiceMetadata(invoice)
      if (!metadata) return { matched: false, applied: false }

      const paymentAttemptId = metadata.paymentAttemptId
      if (typeof paymentAttemptId !== 'string' || paymentAttemptId.trim() === '') {
        throw new Error('COMMERCIAL_STRIPE_PAYMENT_ATTEMPT_POINTER_INVALID')
      }
      if (typeof invoice.id !== 'string' || invoice.id.trim() === '') {
        throw new Error('COMMERCIAL_STRIPE_INVOICE_ID_INVALID')
      }
      if (!Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid <= 0) {
        throw new Error('COMMERCIAL_STRIPE_AMOUNT_PAID_INVALID')
      }
      const currency = typeof invoice.currency === 'string' ? invoice.currency.toUpperCase() : ''
      if (currency !== 'MXN') throw new Error('COMMERCIAL_STRIPE_CURRENCY_INVALID')
      if (!Number.isSafeInteger(event.created) || event.created <= 0) {
        throw new Error('COMMERCIAL_STRIPE_EVENT_TIME_INVALID')
      }
      const providerObjectReferences = invoiceProviderObjectReferences(invoice)
      if (!providerObjectReferences.some(reference => reference.objectType !== 'INVOICE')) {
        throw new Error('COMMERCIAL_STRIPE_INVOICE_SETTLEMENT_REFERENCE_REQUIRED')
      }

      const attempt = await dependencies.repository.loadAttempt(paymentAttemptId)
      if (!attempt) throw new Error('COMMERCIAL_STRIPE_PAYMENT_ATTEMPT_NOT_FOUND')
      if (
        attempt.provider !== 'STRIPE' ||
        attempt.amountMinor !== BigInt(invoice.amount_paid) ||
        attempt.currency !== 'MXN' ||
        (attempt.providerAttemptId !== null && attempt.providerAttemptId !== invoice.id)
      ) {
        throw new Error('COMMERCIAL_STRIPE_PAYMENT_ATTEMPT_MISMATCH')
      }
      if (attempt.status === 'SUCCEEDED' && attempt.providerAttemptId === invoice.id) {
        return { matched: true, applied: false }
      }
      if (!['PENDING', 'OUTCOME_UNKNOWN'].includes(attempt.status)) {
        throw new Error('COMMERCIAL_STRIPE_PAYMENT_ATTEMPT_MISMATCH')
      }

      const reconciled = await dependencies.reconcileCash({
        organizationId: attempt.organizationId,
        venueId: attempt.venueId,
        receivableId: attempt.receivableId,
        paymentAttemptId: attempt.id,
        paymentAttemptProviderId: invoice.id,
        idempotencyKey: `stripe:event:${event.id}`,
        observation: {
          provider: 'STRIPE',
          providerEventId: event.id,
          amountMinor: BigInt(invoice.amount_paid),
          currency: 'MXN',
          receivingAccountFingerprint: dependencies.receivingAccountFingerprint,
          observedAt: new Date(event.created * 1000),
        },
        providerObjectReferences,
        now: requiredDate(dependencies.now(), 'COMMERCIAL_STRIPE_RECONCILIATION_TIME_INVALID'),
      })
      return {
        matched: true,
        applied: reconciled.decision === 'RECONCILED',
        receiptId: reconciled.receiptId,
        eventId: reconciled.eventId,
      }
    },
  }
}

export function createPrismaStripePaymentProviderRepository(
  client: Pick<PrismaClient, 'commercialBillingPaymentAttempt' | 'commercialBillingProviderObject'> = prisma,
): StripePaymentProviderRepository {
  return {
    async loadAttempt(paymentAttemptId) {
      const attempt = await client.commercialBillingPaymentAttempt.findUnique({
        where: { id: paymentAttemptId },
        include: {
          receivable: {
            select: { id: true, organizationId: true, venueId: true },
          },
        },
      })
      if (!attempt) return null
      return {
        id: attempt.id,
        provider: attempt.provider,
        providerAttemptId: attempt.providerAttemptId,
        status: attempt.status,
        amountMinor: attempt.amountMinor,
        currency: attempt.currency,
        receivableId: attempt.receivable.id,
        organizationId: attempt.receivable.organizationId,
        venueId: attempt.receivable.venueId,
      }
    },
    async loadOriginalReceiptByReferences(referenceIds) {
      const aliases = await client.commercialBillingProviderObject.findMany({
        where: { provider: 'STRIPE', objectId: { in: referenceIds } },
        select: {
          cashReceipt: {
            select: {
              id: true,
              organizationId: true,
              venueId: true,
              receivingAccountFingerprint: true,
              paymentAttempt: { select: { receivableId: true } },
              allocations: {
                where: { direction: 'CREDIT' },
                select: { receivableId: true },
              },
              adjustments: {
                where: { entryType: 'REVERSAL' },
                select: { amountMinor: true },
              },
            },
          },
        },
      })
      const receipts = new Map(aliases.map(alias => [alias.cashReceipt.id, alias.cashReceipt]))
      if (receipts.size === 0) return null
      if (receipts.size !== 1) throw new Error('COMMERCIAL_STRIPE_REFERENCE_RECEIPT_CONFLICT')
      const [receipt] = receipts.values()
      if (receipt && receipt.allocations.length > 1) {
        throw new Error('COMMERCIAL_STRIPE_REFERENCE_RECEIVABLE_CONFLICT')
      }
      const receivableId = receipt?.allocations[0]?.receivableId ?? receipt?.paymentAttempt?.receivableId
      if (receipt && !receivableId) throw new Error('COMMERCIAL_STRIPE_REFERENCE_RECEIVABLE_CONFLICT')
      return receipt
        ? {
            receiptId: receipt.id,
            receivableId: receivableId!,
            organizationId: receipt.organizationId,
            venueId: receipt.venueId,
            receivingAccountFingerprint: receipt.receivingAccountFingerprint,
            reversedMinor: receipt.adjustments.reduce((sum, adjustment) => sum + adjustment.amountMinor, 0n),
          }
        : null
    },
  }
}

export const prismaStripePaymentProviderRepository = createPrismaStripePaymentProviderRepository()

export function createLiveStripePaymentProviderAdapter(receivingAccountFingerprint: string) {
  return createStripePaymentProviderAdapter({
    repository: prismaStripePaymentProviderRepository,
    reconcileCash: input => reconcileCommercialCashReceipt(input),
    reconcileAdjustment: input => reconcileCommercialCashAdjustment(input),
    receivingAccountFingerprint,
    now: () => new Date(),
  })
}
