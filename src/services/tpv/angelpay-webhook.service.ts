/**
 * AngelPay TPV Webhook Service
 *
 * Layer 4 of 4 in the payment reconciliation strategy. Receives HMAC-signed
 * payment confirmations from AngelPay cloud, verifies them, and reconciles
 * against the `Payment` table.
 *
 * Signature scheme (real production, reverse-engineered from live capture):
 *   HMAC_SHA256(key=fullSecretWithPrefix, body=rawBytes).hexdigest()
 *
 * See: docs/angelpay/WEBHOOK_RECEIVER_SPEC.md
 */

import prisma from '@/utils/prismaClient'
import { Prisma, ProviderType, EventStatus } from '@prisma/client'
import logger from '@/config/logger'

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Public types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Real AngelPay webhook delivery body (captured from live production webhook,
 * 2026-05-29). The top-level `id_merchant` field is NOT present in the actual
 * delivery — merchant identity is established by URL param + valid HMAC signature.
 *
 * Lenient on every field except `event_type` and `payload.amount`.
 */
export interface AngelPayWebhookPayload {
  event_type: string // "send_transaction" | "offline_event" | "canceled_transaction"
  payload: {
    amount: number | string // zero-padded string in CENTAVOS (e.g. "000000000100" = $1.00 MXN)
    description?: string // human-readable status (e.g. "APROBADA")
    integratorReference?: string // OUR paymentAttemptId / Payment.idempotencyKey
    status?: string // lowercase: "approved" | "declined" | ...
    terminalSerial?: string // Nexgo serial number (e.g. "N860W175781")
    timestamp?: string // ISO 8601
    transactionId?: string // AngelPay's transaction PK (numeric string)
    [key: string]: unknown // forward-compat
  }
  [key: string]: unknown
}

export type AngelPayWebhookAction =
  | 'MATCHED'
  | 'DISCREPANCY'
  | 'ORPHANED'
  | 'NOT_APPROVED'
  | 'UNKNOWN_MERCHANT'
  | 'UNSUPPORTED_EVENT_TYPE'
  | 'DUPLICATE'
  | 'ERROR'

export interface AngelPayWebhookResult {
  action: AngelPayWebhookAction
  eventLogId?: string
  paymentId?: string
  errorReason?: string
  message?: string
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Canonical error reasons — string literals so we can add without DB migrations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const ANGELPAY_WEBHOOK_ERROR_REASONS = {
  NOT_PROVISIONED: 'NOT_PROVISIONED',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  UNSUPPORTED_EVENT_TYPE: 'UNSUPPORTED_EVENT_TYPE',
  UNKNOWN_MERCHANT: 'UNKNOWN_MERCHANT',
  NO_MATCH_FIELDS: 'NO_MATCH_FIELDS',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  NOT_APPROVED: 'NOT_APPROVED',
  ORPHANED: 'ORPHANED',
  PROCESSING_ERROR: 'PROCESSING_ERROR',
} as const

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Payload validator
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function validateAngelPayWebhookPayload(payload: unknown): payload is AngelPayWebhookPayload {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  if (typeof p.event_type !== 'string' || !p.event_type) return false
  const inner = p.payload as Record<string, unknown> | undefined
  if (!inner || inner.amount == null) return false
  return true
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DB persistence helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function persistErrorEvent(args: {
  eventId: string | null
  type: string
  payload: AngelPayWebhookPayload
  venueId: string | null
  errorReason: string
}): Promise<{ id: string }> {
  return prisma.providerEventLog.create({
    data: {
      provider: ProviderType.PAYMENT_PROCESSOR,
      eventId: args.eventId,
      type: args.type,
      payload: args.payload as unknown as Prisma.InputJsonValue,
      venueId: args.venueId,
      status: EventStatus.ERROR,
      errorReason: args.errorReason,
      processedAt: new Date(),
    },
    select: { id: true },
  })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Payment matching — 3-retry loop
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const DEFAULT_RETRY_DELAYS_MS = [0, 2000, 3000]
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export interface MatchedPayment {
  id: string
  amount: Prisma.Decimal | number | string
  processorData: Prisma.JsonValue | null
  venueId: string
}

export async function attemptPaymentMatch(args: {
  payload: AngelPayWebhookPayload
  merchantAccountId: string
  retryDelaysMs?: number[]
}): Promise<MatchedPayment | null> {
  const { payload, merchantAccountId } = args
  const delays = args.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS

  const conditions: Prisma.PaymentWhereInput[] = []
  if (payload.payload.integratorReference) {
    // The TPV sets the SDK's `integratorReference` to its paymentAttemptId, which
    // it ALSO sends to /tpv/fast as the Payment's `idempotencyKey` (NOT as
    // referenceNumber — that holds AngelPay's own generated ref). Match both so we
    // reconcile regardless of which column the value landed in.
    conditions.push({ idempotencyKey: payload.payload.integratorReference })
    conditions.push({ referenceNumber: payload.payload.integratorReference })
  }
  if (payload.payload.transactionId) {
    conditions.push({ processorId: payload.payload.transactionId })
  }

  if (conditions.length === 0) return null

  const where: Prisma.PaymentWhereInput = {
    OR: conditions,
    status: { in: ['COMPLETED', 'PENDING'] },
    merchantAccountId,
  }

  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await delay(delays[i])
    const payment = await prisma.payment.findFirst({
      where,
      select: { id: true, amount: true, processorData: true, venueId: true },
    })
    if (payment) return payment as MatchedPayment
  }
  return null
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Orchestrator
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface ProcessArgs {
  payload: unknown
  eventId: string
  merchantAccount: {
    id: string
    externalMerchantId: string
  }
  retryDelaysMs?: number[]
}

export async function processAngelPayWebhook(args: ProcessArgs): Promise<AngelPayWebhookResult> {
  const { payload, eventId: rawEventId, merchantAccount } = args
  const eventLogId_key = `angelpay-${rawEventId}`
  const correlationId = `angelpay-wh-${rawEventId}`

  // 1. Lenient validation
  if (!validateAngelPayWebhookPayload(payload)) {
    const raw = payload as Record<string, unknown>
    const errored = await persistErrorEvent({
      eventId: eventLogId_key,
      type: (typeof raw?.event_type === 'string' ? raw.event_type : null) ?? 'unknown',
      payload: payload as AngelPayWebhookPayload,
      venueId: null,
      errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.INVALID_PAYLOAD,
    })
    return { action: 'ERROR', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.INVALID_PAYLOAD, eventLogId: errored.id }
  }

  // NOTE: No id_merchant cross-check. The real AngelPay webhook does not include
  // id_merchant in the body. Merchant identity is established solely by the URL
  // param (merchantAccountId) + valid HMAC signature (which proves AngelPay
  // signed for this merchant's secret). Removing the check prevents always-failing
  // MERCHANT_MISMATCH errors on legitimate webhooks.

  // Bail early: only act on send_transaction in v1
  if (payload.event_type !== 'send_transaction') {
    const errored = await persistErrorEvent({
      eventId: eventLogId_key,
      type: payload.event_type,
      payload,
      venueId: null,
      errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.UNSUPPORTED_EVENT_TYPE,
    })
    return { action: 'UNSUPPORTED_EVENT_TYPE', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.UNSUPPORTED_EVENT_TYPE, eventLogId: errored?.id }
  }

  // 2. Insert PENDING row (race-safe idempotency via unique eventId)
  let eventLogId: string
  try {
    const created = await prisma.providerEventLog.create({
      data: {
        provider: ProviderType.PAYMENT_PROCESSOR,
        eventId: eventLogId_key,
        type: payload.event_type,
        payload: payload as unknown as Prisma.InputJsonValue,
        venueId: null,
        status: EventStatus.PENDING,
      },
      select: { id: true },
    })
    eventLogId = created.id
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await prisma.providerEventLog.findFirst({
        where: { provider: ProviderType.PAYMENT_PROCESSOR, eventId: eventLogId_key },
        select: { id: true, paymentId: true },
      })
      return { action: 'DUPLICATE', eventLogId: existing?.id, paymentId: existing?.paymentId ?? undefined }
    }
    throw err
  }

  // Bail: only reconcile approved transactions (AngelPay sends lowercase)
  if (payload.payload.status && payload.payload.status.toLowerCase() !== 'approved') {
    await prisma.providerEventLog.update({
      where: { id: eventLogId },
      data: { status: EventStatus.ERROR, errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.NOT_APPROVED, processedAt: new Date() },
    })
    return { action: 'NOT_APPROVED', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.NOT_APPROVED, eventLogId }
  }

  // 3. Bail: no usable matching field
  const hasMatchableField = !!(payload.payload.integratorReference || payload.payload.transactionId)
  if (!hasMatchableField) {
    await prisma.providerEventLog.update({
      where: { id: eventLogId },
      data: { status: EventStatus.ERROR, errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.NO_MATCH_FIELDS, processedAt: new Date() },
    })
    return { action: 'ORPHANED', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.NO_MATCH_FIELDS, eventLogId }
  }

  // 4. Match
  const payment = await attemptPaymentMatch({ payload, merchantAccountId: merchantAccount.id, retryDelaysMs: args.retryDelaysMs })

  if (!payment) {
    await prisma.providerEventLog.update({
      where: { id: eventLogId },
      data: { status: EventStatus.ERROR, errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.ORPHANED, processedAt: new Date() },
    })
    return { action: 'ORPHANED', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.ORPHANED, eventLogId }
  }

  // 5. Reconcile amount
  // Webhook amount is in CENTAVOS (zero-padded string, e.g. "000000000100" = 100 cents = $1.00 MXN).
  // Payment.amount is stored in PESOS (e.g. Decimal("1.00")).
  // Divide by 100 to convert centavos → pesos before comparing.
  const webhookAmount = Number(payload.payload.amount) / 100
  const recordedAmount = Number(payment.amount)
  const diff = Math.abs(webhookAmount - recordedAmount)

  if (diff < 0.01) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        processorData: {
          ...((payment.processorData as Record<string, unknown>) ?? {}),
          angelpayWebhook: {
            receivedAt: new Date().toISOString(),
            eventId: rawEventId,
            transactionId: payload.payload.transactionId ?? null,
            integratorReference: payload.payload.integratorReference ?? null,
            terminalSerial: payload.payload.terminalSerial ?? null,
            timestamp: payload.payload.timestamp ?? null,
            status: payload.payload.status ?? null,
            // No auth_code, no card details — AngelPay doesn't send them
          },
        } as Prisma.InputJsonValue,
      },
    })
    await prisma.providerEventLog.update({
      where: { id: eventLogId },
      data: { status: EventStatus.PROCESSED, paymentId: payment.id, venueId: payment.venueId, errorReason: null, processedAt: new Date() },
    })
    await prisma.merchantAccount.update({
      where: { id: merchantAccount.id },
      data: { angelpayWebhookLastReceivedAt: new Date() },
    })
    logger.info('✅ [AngelPay webhook] matched', { correlationId, paymentId: payment.id, webhookAmount })
    return { action: 'MATCHED', eventLogId, paymentId: payment.id }
  }

  // DISCREPANCY path
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      processorData: {
        ...((payment.processorData as Record<string, unknown>) ?? {}),
        angelpayDiscrepancy: {
          detectedAt: new Date().toISOString(),
          webhookAmount,
          recordedAmount,
          difference: diff,
          transactionId: payload.payload.transactionId ?? null,
        },
      } as Prisma.InputJsonValue,
    },
  })
  await prisma.providerEventLog.update({
    where: { id: eventLogId },
    data: {
      status: EventStatus.ERROR,
      errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.AMOUNT_MISMATCH,
      paymentId: payment.id,
      venueId: payment.venueId,
      processedAt: new Date(),
    },
  })
  await prisma.merchantAccount.update({
    where: { id: merchantAccount.id },
    data: { angelpayWebhookLastReceivedAt: new Date() },
  })
  logger.error('❌ [AngelPay webhook] amount discrepancy', { correlationId, paymentId: payment.id, webhookAmount, recordedAmount, diff })
  return { action: 'DISCREPANCY', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.AMOUNT_MISMATCH, eventLogId, paymentId: payment.id }
}
