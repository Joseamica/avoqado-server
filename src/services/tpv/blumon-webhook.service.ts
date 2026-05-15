/**
 * Blumon TPV Webhook Service
 *
 * Layer 4 of the 4-layer payment reconciliation strategy:
 * 1. Android SDK → Blumon (direct payment processing)
 * 2. Android → Backend (payment recording)
 * 3. Backend validation (merchantAccountId fallback)
 * 4. Blumon webhook (independent confirmation) ← THIS SERVICE
 *
 * This webhook receives payment confirmations directly from Blumon,
 * enabling reconciliation even when Android fails to record the payment.
 *
 * Use Cases:
 * - Reconcile payments that Android failed to record
 * - Verify amounts match between Blumon and our records
 * - Detect discrepancies for investigation
 */

import prisma from '../../utils/prismaClient'
import { Prisma, ProviderType, EventStatus } from '@prisma/client'
import logger from '../../config/logger'
import { isVenueOperational } from '@/lib/venueStatus.constants'

/**
 * Helper function for async delay
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Webhook reconciliation constants — canonical reasons for ProviderEventLog.errorReason
// Kept as string literals so we can add cases without DB migrations. The set is
// intentionally small and stable so dashboards can query by it.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export const BLUMON_WEBHOOK_ERROR_REASONS = {
  /** Blumon's `serialNumber` is not registered as a Terminal in our DB */
  UNKNOWN_TERMINAL: 'UNKNOWN_TERMINAL',
  /** Webhook lacks any usable matching field (no reference / authCode / operationNumber) */
  NO_MATCH_FIELDS: 'NO_MATCH_FIELDS',
  /** Matched a Payment but `amount` differs by ≥ $0.01 */
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  /** No Payment matched after async retries; > 24h since received */
  ORPHANED: 'ORPHANED',
  /** Transaction not approved (`codeResponse` ≠ "00") — informational, not a bug */
  NOT_APPROVED: 'NOT_APPROVED',
  /** Internal exception while processing; check logs for stack */
  PROCESSING_ERROR: 'PROCESSING_ERROR',
} as const

/**
 * How long an event can sit in `PENDING` before the worker promotes it to
 * ERROR + errorReason=ORPHANED. 24h covers offline-queue replays from killed
 * apps with no internet for a day.
 */
export const BLUMON_WEBHOOK_PENDING_TTL_MS = 24 * 60 * 60 * 1000

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SerialNumber bridge — Blumon → our Terminal table
//
// Blumon sends a raw serial like "2841548628" in the webhook. Our DB stores
// the same serial prefixed as "AVQD-2841548628" (Avoqado convention). These
// helpers do the canonicalization and the lookup once.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Convert Blumon's raw serial → our DB's `AVQD-` prefixed form (idempotent). */
export function canonicalizeBlumonSerial(rawSerial: string): string {
  const trimmed = rawSerial.trim()
  if (trimmed.startsWith('AVQD-')) return trimmed
  return `AVQD-${trimmed}`
}

/**
 * Resolve a Blumon webhook's `serialNumber` to a Terminal+Venue in our DB.
 *
 * @returns the terminal (with venueId) if found, or `null` when the serial is
 *          unknown to us. Callers should mark the event with errorReason =
 *          `UNKNOWN_TERMINAL` in that case — it's the strongest signal that
 *          the webhook is for another integrator, or that we forgot to
 *          register a new device in our DB.
 */
export async function resolveTerminalFromBlumonSerial(
  rawSerial: string | undefined | null,
): Promise<{ id: string; venueId: string; serialNumber: string | null } | null> {
  if (!rawSerial) return null
  const canonical = canonicalizeBlumonSerial(rawSerial)
  return prisma.terminal.findUnique({
    where: { serialNumber: canonical },
    select: { id: true, venueId: true, serialNumber: true },
  })
}

/**
 * Resolve the **scope of venues** a Blumon webhook can legitimately match against.
 *
 * Blumon sends a single `serialNumber` per webhook, but in our data model that
 * serial can map to two distinct things at the same time:
 *   1. A physical PAX `Terminal` (one venue — where the device lives).
 *   2. A `MerchantAccount.blumonSerialNumber` (N venues — every venue whose
 *      `VenuePaymentConfig` points at that merchant account as
 *      primary/secondary/tertiary).
 *
 * When a single MerchantAccount is shared across many venues (e.g. a chain
 * using one Blumon merchant for 35 stores), scoping the matcher to just the
 * terminal's venue creates false negatives — the webhook arrives for a
 * Payment recorded in *another* venue of the same merchant, and the cron job
 * keeps retrying forever. See: 2026-05-14 reconciliation incident.
 *
 * @returns deduped list of venueIds the webhook may match against. Empty list
 *          means "no scope, match globally" (intentional — caller decides what
 *          to do with that).
 */
export async function resolveScopeVenueIdsFromBlumonSerial(rawSerial: string | undefined | null): Promise<string[]> {
  if (!rawSerial) return []
  const canonical = canonicalizeBlumonSerial(rawSerial)
  const rawTrimmed = rawSerial.trim().replace(/^AVQD-/, '')

  const [terminal, merchantAccount] = await Promise.all([
    prisma.terminal.findUnique({
      where: { serialNumber: canonical },
      select: { venueId: true },
    }),
    prisma.merchantAccount.findFirst({
      where: { blumonSerialNumber: rawTrimmed },
      select: { id: true },
    }),
  ])

  const venueIds = new Set<string>()
  if (terminal?.venueId) venueIds.add(terminal.venueId)

  if (merchantAccount?.id) {
    const configs = await prisma.venuePaymentConfig.findMany({
      where: {
        OR: [
          { primaryAccountId: merchantAccount.id },
          { secondaryAccountId: merchantAccount.id },
          { tertiaryAccountId: merchantAccount.id },
        ],
      },
      select: { venueId: true },
    })
    for (const cfg of configs) venueIds.add(cfg.venueId)
  }

  return Array.from(venueIds)
}

/**
 * Build a canonical, idempotent event id from a Blumon webhook payload.
 *
 * The pair `(operationNumber, reference)` is unique-per-transaction inside
 * Blumon's system. The `provider+eventId` UNIQUE constraint on
 * `ProviderEventLog` then prevents double-inserts when Blumon retries (e.g.
 * if we returned 5xx once or our ngrok dropped a packet).
 *
 * @returns a stable string, or `null` when neither field is present (very
 *          rare; row will be inserted with eventId=NULL — Postgres treats
 *          multiple NULLs as distinct so it won't break the unique index).
 */
export function buildBlumonEventId(payload: BlumonWebhookPayload): string | null {
  const op = payload.operationNumber
  const ref = payload.reference
  if (op != null && ref) return `blumon-tpv-${op}-${ref}`
  if (op != null) return `blumon-tpv-${op}`
  if (ref) return `blumon-tpv-${ref}`
  return null
}

/**
 * Retry configuration for payment lookup
 *
 * WHY: Blumon webhook often arrives BEFORE Android finishes recording the payment.
 * The webhook is processed in ~100ms, but Android's POST /fast can take 500ms+.
 *
 * Strategy: 3 attempts with increasing delays
 * - Attempt 1: Immediate (0ms)
 * - Attempt 2: After 2000ms
 * - Attempt 3: After 3000ms more
 * - Total max wait: 5 seconds
 */
const RETRY_CONFIG = {
  maxAttempts: 3,
  delays: [0, 2000, 3000], // Immediate, then 2s, then 3s
}

/**
 * Blumon webhook payload structure
 *
 * NOTE: Blumon's actual payload differs from initial documentation!
 * Field mapping (Blumon sends → We expected):
 * - business → (new field) Merchant name registered with Blumon
 * - businessRfc → (new field) Tax ID (RFC) of the merchant
 * - reference → Not always present, use authorizationCode + lastFour for matching
 *
 * @example Actual sandbox payload (2025-12-03):
 * {
 *   "business": "AVOQADO",
 *   "businessRfc": "STA241210PW8",
 *   "lastFour": "7182",
 *   "cardType": "CREDITO",
 *   "brand": "MASTERCARD",
 *   "bank": "GENERAL",
 *   "amount": "20.00",
 *   ...
 * }
 */
export interface BlumonWebhookPayload {
  // Merchant identification (ACTUAL fields from Blumon)
  business?: string // Merchant name registered with Blumon (e.g., "MONEYGIVER")
  businessRfc?: string // Tax ID (RFC) of the merchant (e.g., "MGI220204FA4")

  // Card information
  bin?: string // Card BIN (first 6 digits)
  lastFour: string // Card last 4 digits
  cardType: 'DEBITO' | 'CREDITO' | 'AMEX' | string // DEBITO, CREDITO, AMEX (AMEX no separa débito/crédito)
  brand: 'VISA' | 'MASTERCARD' | 'AMEX' | 'AMERICAN_EXPRESS' | string
  bank: string // Issuing bank (e.g., "BANORTE", "BANCOMER", "AMERICAN EXPRESS")

  // Transaction details
  amount: string // Transaction amount (string with 2 decimals — e.g., "29150.00")
  reference?: string // Our transaction reference (may not be present in all webhooks)
  cardHolder?: string // Cardholder name (PCI - careful with logging)
  authorizationCode?: string // Bank authorization code
  operationType?: 'VENTA' | 'DEVOLUCION' | 'CANCELACION' | string // VENTA = sale
  operationNumber?: number // Blumon's operation ID (numeric in payload, not string)
  descriptionResponse?: string // Response description (e.g., "APROBADA")
  dateTransaction?: string // Format: "20/01/2021 18:24:38"
  authentication?: string // EMV cardholder verification — observed: "signature", "pin", "unknown"
  membership?: string // Blumon membership ID
  provideResponse?: string // Provider response code — observed: "AMEX", "PR" (Prosa), "SB" (sandbox)
  codeResponse?: string // Response code ("00" = approved)

  // ━━━ Undocumented but observed in real production webhooks (2026-05-07) ━━━
  // All optional because Blumon may stop sending them without notice (their docs
  // are a minimum contract, not the exact shape).

  /** EMV Application Identifier — different per card brand. AMEX: A000000025010801, VISA: A0000000031010 */
  aid?: string

  /** EMV Authorization Request Cryptogram — proof that the chip authenticated. 16 hex chars. */
  arqc?: string

  /**
   * Physical PAX terminal serial number that processed the payment. RAW (no
   * `AVQD-` prefix). Used to bridge webhook → Terminal → Venue without trusting
   * the webhook URL or the `business` field, which can be misconfigured.
   */
  serialNumber?: string

  /**
   * Batch counter — only observed on VISA so far. Sometimes absent on AMEX.
   * Possibly the provider's internal sequence number.
   */
  realCounter?: string

  // Allow additional unknown fields from Blumon — defensive against future schema changes.
  [key: string]: unknown
}

/**
 * Webhook processing result
 */
export interface WebhookProcessingResult {
  success: boolean
  action:
    | 'MATCHED' // Payment found, amounts match — happy path
    | 'RECONCILED' // Same as MATCHED but emphasized (legacy alias kept)
    | 'DISCREPANCY' // Payment found, amounts differ — flagged for ops
    | 'NOT_FOUND' // No matching Payment after retries — typically transient
    | 'PENDING' // Event stored, will be reconciled async (Payment not yet recorded)
    | 'DUPLICATE' // Webhook already received before (Blumon re-delivered) — idempotent no-op
    | 'NOT_APPROVED' // codeResponse != "00" — informational
    | 'UNKNOWN_TERMINAL' // serialNumber not registered in our DB
    | 'ERROR' // Internal exception
  /** ProviderEventLog row that was created/found for this webhook (always set when persisted). */
  eventLogId?: string
  paymentId?: string
  message: string
  details?: {
    blumonAmount: number
    recordedAmount?: number
    difference?: number
  }
}

/**
 * Process Blumon payment confirmation webhook
 *
 * Orchestrates the immutable event log + reconciliation flow:
 *
 *   1. Build canonical eventId from `(operationNumber, reference)`.
 *   2. Idempotency check via `ProviderEventLog @@unique(provider, eventId)` —
 *      returns DUPLICATE if Blumon re-delivered the same event.
 *   3. Resolve `serialNumber` → Terminal → Venue. If unknown, persist with
 *      errorReason=UNKNOWN_TERMINAL and return — webhook acknowledged but
 *      not actionable on our side.
 *   4. Insert ProviderEventLog row (status=PENDING) before doing any
 *      Payment lookup. This guarantees we never lose a webhook to a crash.
 *   5. Inline reconcile (5s retry) scoped to the resolved venueId — if Blumon
 *      arrives before TPV finishes recording the payment, the retries cover
 *      common races (<5s). Anything slower is handled by the cron worker.
 *   6. Update event row with final status + errorReason + paymentId.
 *
 * The webhook controller treats every case as 200 OK (Blumon must not retry —
 * we own the retry semantics now).
 */
export async function processBlumonPaymentWebhook(payload: BlumonWebhookPayload): Promise<WebhookProcessingResult> {
  const correlationId = `blumon-wh-${Date.now()}`

  try {
    const blumonAmount = parseFloat(payload.amount)
    const eventIdString = buildBlumonEventId(payload)

    // ───────────── 1. Idempotency check (Blumon retries on 5xx) ─────────────
    if (eventIdString) {
      const existing = await prisma.providerEventLog.findFirst({
        where: { provider: ProviderType.PAYMENT_PROCESSOR, eventId: eventIdString },
        select: { id: true, status: true, paymentId: true, errorReason: true },
      })
      if (existing) {
        logger.info('🔁 [Blumon webhook] Duplicate event ignored', {
          correlationId,
          eventId: eventIdString,
          previousStatus: existing.status,
          previousErrorReason: existing.errorReason,
        })
        return {
          success: true,
          action: 'DUPLICATE',
          eventLogId: existing.id,
          paymentId: existing.paymentId ?? undefined,
          message: `Webhook already processed (status=${existing.status})`,
          details: { blumonAmount },
        }
      }
    }

    // ───────────── 2. Resolve serialNumber → Terminal → Venue ─────────────
    // `terminal` is used for the physical-location stamp on the event row.
    // `scopeVenueIds` widens that to every venue sharing the same Blumon
    // MerchantAccount — necessary when a single merchant fans out to N venues
    // (one webhook → one of N possible Payments). See
    // `resolveScopeVenueIdsFromBlumonSerial` for the why.
    const [terminal, scopeVenueIds] = await Promise.all([
      resolveTerminalFromBlumonSerial(payload.serialNumber),
      resolveScopeVenueIdsFromBlumonSerial(payload.serialNumber),
    ])
    const scopeVenueId = terminal?.venueId ?? null

    if (payload.serialNumber && !terminal) {
      logger.warn('🚫 [Blumon webhook] Unknown terminal serial', {
        correlationId,
        rawSerial: payload.serialNumber,
        canonical: canonicalizeBlumonSerial(payload.serialNumber),
        hint: 'This terminal is not registered in our DB. Either it belongs to another integrator or we forgot to register it.',
      })

      // Still persist the event so ops can see it in the dashboard and decide
      // whether to register the terminal retroactively.
      const event = await prisma.providerEventLog.create({
        data: {
          provider: ProviderType.PAYMENT_PROCESSOR,
          eventId: eventIdString,
          type: payload.operationType ?? 'UNKNOWN',
          payload: payload as unknown as Prisma.InputJsonValue,
          status: EventStatus.ERROR,
          errorReason: BLUMON_WEBHOOK_ERROR_REASONS.UNKNOWN_TERMINAL,
          processedAt: new Date(),
        },
        select: { id: true },
      })

      return {
        success: true,
        action: 'UNKNOWN_TERMINAL',
        eventLogId: event.id,
        message: `Terminal serial ${payload.serialNumber} not registered`,
        details: { blumonAmount },
      }
    }

    // ───────────── 3. Non-approved transactions: log + persist + return ─────────────
    const isApproved = !payload.codeResponse || payload.codeResponse === '00'
    if (!isApproved) {
      logger.warn('⚠️ [Blumon webhook] Non-approved transaction', {
        correlationId,
        reference: payload.reference,
        codeResponse: payload.codeResponse,
        descriptionResponse: payload.descriptionResponse,
      })

      const event = await prisma.providerEventLog.create({
        data: {
          provider: ProviderType.PAYMENT_PROCESSOR,
          eventId: eventIdString,
          type: payload.operationType ?? 'UNKNOWN',
          payload: payload as unknown as Prisma.InputJsonValue,
          venueId: scopeVenueId,
          terminalId: terminal?.id ?? null,
          status: EventStatus.ERROR,
          errorReason: BLUMON_WEBHOOK_ERROR_REASONS.NOT_APPROVED,
          processedAt: new Date(),
        },
        select: { id: true },
      })

      return {
        success: true,
        action: 'NOT_APPROVED',
        eventLogId: event.id,
        message: `Transaction not approved: ${payload.descriptionResponse || 'Unknown'}`,
        details: { blumonAmount },
      }
    }

    // ───────────── 4. Insert PENDING event row before any Payment lookup ─────────────
    let event
    try {
      event = await prisma.providerEventLog.create({
        data: {
          provider: ProviderType.PAYMENT_PROCESSOR,
          eventId: eventIdString,
          type: payload.operationType ?? 'VENTA',
          payload: payload as unknown as Prisma.InputJsonValue,
          venueId: scopeVenueId,
          terminalId: terminal?.id ?? null,
          status: EventStatus.PENDING,
        },
        select: { id: true },
      })
    } catch (err) {
      // Race with idempotency check (someone else just inserted) — re-fetch and
      // return DUPLICATE. P2002 = unique constraint violation in Prisma.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && eventIdString) {
        const existing = await prisma.providerEventLog.findFirst({
          where: { provider: ProviderType.PAYMENT_PROCESSOR, eventId: eventIdString },
          select: { id: true, status: true, paymentId: true },
        })
        if (existing) {
          return {
            success: true,
            action: 'DUPLICATE',
            eventLogId: existing.id,
            paymentId: existing.paymentId ?? undefined,
            message: 'Webhook already processed (race with concurrent insert)',
            details: { blumonAmount },
          }
        }
      }
      throw err
    }

    // ───────────── 5. Inline reconciliation (5s retry, scoped to merchant's venues) ─────────────
    const matchResult = await attemptPaymentMatch(payload, { scopeVenueIds, correlationId })

    // ───────────── 6. Persist final state into the event row ─────────────
    await updateEventLogFromMatchResult(event.id, matchResult)

    return { ...matchResult, eventLogId: event.id }
  } catch (error) {
    logger.error('❌ [Blumon webhook] Processing error', {
      correlationId,
      reference: payload.reference,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    })

    return {
      success: false,
      action: 'ERROR',
      message: error instanceof Error ? error.message : 'Unknown error processing webhook',
    }
  }
}

/**
 * Re-run the matching logic for a previously-stored ProviderEventLog row.
 * Used by the cron worker (see `BlumonWebhookReconciliationJob`) to retry
 * PENDING events without re-inserting or re-validating idempotency.
 *
 * @param eventLogId The ProviderEventLog row to update.
 * @param payload The original webhook payload (taken from `event.payload` JSONB).
 * @param ctx Optional context — when `scopeVenueIds` is omitted we re-resolve
 *            from `payload.serialNumber` on every pass. That avoids caching a
 *            too-narrow scope on the row (a single terminal's venue, when the
 *            same Blumon merchant fans out to N venues). Callers that already
 *            know the correct narrow scope (e.g. the per-Payment backfill in
 *            `reconcileWebhooksForPayment`) can pass it explicitly.
 */
export async function reconcileBlumonEvent(
  eventLogId: string,
  payload: BlumonWebhookPayload,
  ctx: { scopeVenueIds?: string[] } = {},
): Promise<WebhookProcessingResult> {
  const correlationId = `blumon-recon-${eventLogId.slice(-8)}`
  const scopeVenueIds = ctx.scopeVenueIds ?? (await resolveScopeVenueIdsFromBlumonSerial(payload.serialNumber))
  const result = await attemptPaymentMatch(payload, {
    scopeVenueIds,
    correlationId,
    skipRetries: true, // Cron is already on a 30s cadence, no need for inline retry
  })

  await updateEventLogFromMatchResult(eventLogId, result)
  return { ...result, eventLogId }
}

/**
 * Backfill reconciliation: when TPV records a Payment that arrived AFTER the
 * webhook (race), the Payment-creation path calls this to find any pending
 * webhook events for the same `(operationNumber, reference)` and reconcile
 * them immediately — instead of waiting up to 30s for the cron worker.
 *
 * Safe to call on every Payment.create — it's a single indexed query and a
 * no-op when no pending webhook exists.
 */
export async function reconcileWebhooksForPayment(payment: {
  id: string
  processorId: string | null
  referenceNumber: string | null
  venueId: string
}): Promise<number> {
  if (!payment.processorId && !payment.referenceNumber) return 0

  // Build the same eventId variants the webhook orchestrator would have produced.
  const candidateEventIds: string[] = []
  if (payment.processorId && payment.referenceNumber) {
    candidateEventIds.push(`blumon-tpv-${payment.processorId}-${payment.referenceNumber}`)
  }
  if (payment.processorId) candidateEventIds.push(`blumon-tpv-${payment.processorId}`)
  if (payment.referenceNumber) candidateEventIds.push(`blumon-tpv-${payment.referenceNumber}`)

  const pending = await prisma.providerEventLog.findMany({
    where: {
      provider: ProviderType.PAYMENT_PROCESSOR,
      status: EventStatus.PENDING,
      eventId: { in: candidateEventIds },
      createdAt: { gte: new Date(Date.now() - BLUMON_WEBHOOK_PENDING_TTL_MS) },
    },
    select: { id: true, payload: true, venueId: true },
  })

  if (pending.length === 0) return 0

  let reconciled = 0
  for (const row of pending) {
    try {
      const payload = row.payload as unknown as BlumonWebhookPayload
      const result = await reconcileBlumonEvent(row.id, payload, {
        // Backfill is triggered by a specific Payment creation — restrict the
        // match to that Payment's venue. Payments are the source of truth and
        // this prevents accidentally matching against another orphan payment
        // in a sibling venue of the same merchant.
        scopeVenueIds: [payment.venueId],
      })
      if (result.action === 'MATCHED' || result.action === 'RECONCILED') reconciled++
    } catch (err) {
      logger.error('❌ [Blumon backfill] Failed to reconcile event for new payment', {
        eventLogId: row.id,
        paymentId: payment.id,
        error: err instanceof Error ? err.message : err,
      })
    }
  }

  if (reconciled > 0) {
    logger.info('✅ [Blumon backfill] Reconciled webhook(s) on Payment record', {
      paymentId: payment.id,
      reconciledCount: reconciled,
      pendingCount: pending.length,
    })
  }

  return reconciled
}

/**
 * Update a ProviderEventLog row based on a match attempt result.
 * Centralized so both the inline path and the cron worker behave identically.
 */
async function updateEventLogFromMatchResult(eventLogId: string, result: WebhookProcessingResult): Promise<void> {
  const data: Prisma.ProviderEventLogUpdateInput = {}

  switch (result.action) {
    case 'MATCHED':
    case 'RECONCILED':
      data.status = EventStatus.PROCESSED
      data.processedAt = new Date()
      if (result.paymentId) data.payment = { connect: { id: result.paymentId } }
      data.errorReason = null
      break
    case 'DISCREPANCY':
      data.status = EventStatus.ERROR
      data.errorReason = BLUMON_WEBHOOK_ERROR_REASONS.AMOUNT_MISMATCH
      data.processedAt = new Date()
      if (result.paymentId) data.payment = { connect: { id: result.paymentId } }
      break
    case 'NOT_FOUND':
      // Stay PENDING — the cron worker will retry up to 24h.
      data.status = EventStatus.PENDING
      break
    case 'ERROR':
      data.status = EventStatus.ERROR
      data.errorReason = BLUMON_WEBHOOK_ERROR_REASONS.PROCESSING_ERROR
      data.processedAt = new Date()
      break
    default:
      // PENDING / DUPLICATE / UNKNOWN_TERMINAL / NOT_APPROVED handled by caller already
      return
  }

  await prisma.providerEventLog.update({ where: { id: eventLogId }, data }).catch(err => {
    logger.error('❌ [Blumon webhook] Failed to update event log row', {
      eventLogId,
      action: result.action,
      error: err instanceof Error ? err.message : err,
    })
  })
}

/**
 * Inner matching logic — extracted from the legacy implementation so it can
 * be re-used by the cron worker. NEVER inserts into ProviderEventLog (the
 * caller owns the row); only reads + updates Payment.processorData.
 *
 * @param scopeVenueIds If non-empty, matches are restricted to Payments whose
 *                      order is in one of these venues (Prisma `IN` clause).
 *                      Empty list means "no scope, match globally" — reserved
 *                      for cases where serialNumber is missing. Reduces
 *                      false-positives when references collide across
 *                      merchants. Resolved from the webhook's serialNumber in
 *                      the orchestrator/cron entry points.
 */
async function attemptPaymentMatch(
  payload: BlumonWebhookPayload,
  ctx: { scopeVenueIds: string[]; correlationId: string; skipRetries?: boolean } = {
    scopeVenueIds: [],
    correlationId: `blumon-wh-${Date.now()}`,
  },
): Promise<WebhookProcessingResult> {
  const { scopeVenueIds, correlationId, skipRetries } = ctx
  try {
    const blumonAmount = parseFloat(payload.amount)

    // Build matching conditions based on available fields
    const matchConditions: Prisma.PaymentWhereInput[] = []

    if (payload.reference) {
      matchConditions.push({ referenceNumber: payload.reference })
      // Try partial match on last 10 chars
      if (payload.reference.length >= 10) {
        matchConditions.push({ referenceNumber: { contains: payload.reference.slice(-10) } })
      }
    }

    if (payload.authorizationCode) {
      matchConditions.push({ authorizationNumber: payload.authorizationCode })
    }

    if (payload.operationNumber) {
      matchConditions.push({ processorId: payload.operationNumber.toString() })
    }

    // If we have lastFour, add a combined condition with amount + lastFour + date
    // This is a fallback for when reference/auth might not match exactly
    if (payload.lastFour && payload.dateTransaction) {
      // Parse dateTransaction format: "DD/MM/YYYY HH:mm:ss" or similar
      // For now, just log it - we'll add this matching later if needed
      logger.debug('🔍 Additional matching fields available', {
        correlationId,
        lastFour: payload.lastFour,
        dateTransaction: payload.dateTransaction,
        amount: blumonAmount,
      })
    }

    if (matchConditions.length === 0) {
      logger.error('❌ Blumon webhook: No matching fields available', {
        correlationId,
        payload: {
          reference: payload.reference,
          authorizationCode: payload.authorizationCode,
          operationNumber: payload.operationNumber,
        },
      })

      return {
        success: false,
        action: 'ERROR',
        message: 'No fields available for payment matching',
        details: { blumonAmount },
      }
    }

    // Build the where clause once. When `scopeVenueIds` is non-empty we
    // restrict the search to Payments inside those venues — eliminates false
    // positives from references that collide across merchants. The list is
    // resolved from the webhook's `serialNumber` and covers (a) the physical
    // terminal's venue + (b) every venue using the same Blumon MerchantAccount
    // (a single merchant can fan out to N venues).
    const baseWhere: Prisma.PaymentWhereInput = {
      OR: matchConditions,
      status: { in: ['COMPLETED', 'PENDING'] },
      ...(scopeVenueIds.length > 0 ? { order: { venueId: { in: scopeVenueIds } } } : {}),
    }

    // Retry loop only when called inline from the webhook controller. The cron
    // worker passes `skipRetries=true` because it's already running on a delay
    // and just needs one shot per pass.
    const maxAttempts = skipRetries ? 1 : RETRY_CONFIG.maxAttempts
    let payment = null
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Wait before retry (first attempt is immediate)
      if (!skipRetries && RETRY_CONFIG.delays[attempt] > 0) {
        logger.debug(`🔄 Blumon webhook: Retry attempt ${attempt + 1}/${maxAttempts} after ${RETRY_CONFIG.delays[attempt]}ms`, {
          correlationId,
          reference: payload.reference,
        })
        await delay(RETRY_CONFIG.delays[attempt])
      }

      payment = await prisma.payment.findFirst({
        where: baseWhere,
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
              venueId: true,
              venue: {
                select: {
                  id: true,
                  name: true,
                  status: true,
                },
              },
            },
          },
        },
      })

      if (payment) {
        if (attempt > 0) {
          logger.info(`✅ Blumon webhook: Payment found on retry attempt ${attempt + 1}`, {
            correlationId,
            paymentId: payment.id,
            totalWaitMs: RETRY_CONFIG.delays.slice(0, attempt + 1).reduce((a, b) => a + b, 0),
          })
        }
        break // Found payment, exit retry loop
      }
    }

    if (payment) {
      // Security Enhancement: Check if venue is operational
      // We still process the webhook for data integrity, but log a warning
      const venueStatus = payment.order?.venue?.status
      const venueName = payment.order?.venue?.name
      if (venueStatus && !isVenueOperational(venueStatus)) {
        logger.warn('⚠️ Blumon webhook: Payment confirmation for NON-OPERATIONAL venue', {
          correlationId,
          paymentId: payment.id,
          venueId: payment.order?.venueId,
          venueName,
          venueStatus,
          reference: payload.reference,
          amount: blumonAmount,
          note: 'Payment was processed before venue was suspended. Webhook still processed for reconciliation.',
        })
      }

      // Payment found - verify amounts match
      const recordedAmount = parseFloat(payment.amount.toString())
      const difference = Math.abs(blumonAmount - recordedAmount)

      if (difference < 0.01) {
        // Amounts match - perfect reconciliation
        logger.info('✅ Blumon webhook: Payment verified', {
          correlationId,
          paymentId: payment.id,
          reference: payload.reference,
          amount: blumonAmount,
          authCode: payload.authorizationCode,
        })

        // Update payment with Blumon operation data if not already received
        const existingProcessorData = (payment.processorData as Record<string, unknown>) || {}
        if (!existingProcessorData.blumonWebhookReceived) {
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              processorData: {
                ...existingProcessorData,
                blumonOperationNumber: payload.operationNumber,
                blumonWebhookReceived: new Date().toISOString(),
                blumonAuthCode: payload.authorizationCode,
                blumonMembership: payload.membership,
              },
            },
          })
        }

        return {
          success: true,
          action: 'MATCHED',
          paymentId: payment.id,
          message: 'Payment verified successfully',
          details: {
            blumonAmount,
            recordedAmount,
          },
        }
      } else {
        // Amounts don't match - discrepancy detected
        logger.error('❌ Blumon webhook: AMOUNT DISCREPANCY detected', {
          correlationId,
          paymentId: payment.id,
          reference: payload.reference,
          blumonAmount,
          recordedAmount,
          difference,
        })

        // Create discrepancy alert (could trigger notification to admin)
        const discrepancyProcessorData = (payment.processorData as Record<string, unknown>) || {}
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            processorData: {
              ...discrepancyProcessorData,
              blumonDiscrepancy: {
                detectedAt: new Date().toISOString(),
                blumonAmount,
                recordedAmount,
                difference,
                operationNumber: payload.operationNumber,
              },
            },
          },
        })

        return {
          success: false,
          action: 'DISCREPANCY',
          paymentId: payment.id,
          message: `Amount discrepancy: Blumon=${blumonAmount}, Recorded=${recordedAmount}`,
          details: {
            blumonAmount,
            recordedAmount,
            difference,
          },
        }
      }
    } else {
      // Payment not found inline. The orchestrator will keep the
      // ProviderEventLog row in PENDING status; the cron worker
      // (`reconcileBlumonPendingWebhooks`) will retry every 30s for up to 24h
      // before marking it ORPHANED. No manual reconciliation needed in 99% of
      // cases — TPV's offline queue eventually replays the Payment.
      const totalWaitTime = skipRetries ? 0 : RETRY_CONFIG.delays.reduce((a, b) => a + b, 0)
      logger.warn('⚠️ [Blumon webhook] Payment not yet found — staying PENDING', {
        correlationId,
        reference: payload.reference,
        operationNumber: payload.operationNumber,
        amount: blumonAmount,
        retryAttempts: skipRetries ? 0 : RETRY_CONFIG.maxAttempts,
        totalWaitMs: totalWaitTime,
        scopeVenueIds,
        scopeVenueCount: scopeVenueIds.length,
        skipRetries,
      })

      return {
        success: true, // Webhook processed successfully — async retry covers it
        action: 'NOT_FOUND',
        message: skipRetries
          ? 'Payment not found on this scan (cron will retry)'
          : `Payment not found inline — queued for async reconciliation (worker retries every 30s for 24h)`,
        details: { blumonAmount },
      }
    }
  } catch (error) {
    logger.error('❌ Blumon webhook processing error', {
      correlationId,
      reference: payload.reference,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    })

    return {
      success: false,
      action: 'ERROR',
      message: error instanceof Error ? error.message : 'Unknown error processing webhook',
    }
  }
}

/**
 * Validate webhook payload has minimum required fields
 *
 * We use lenient validation because:
 * 1. Blumon's payload format may differ from documentation
 * 2. Different sandbox/production environments may have different fields
 * 3. We want to LOG all webhooks for investigation, even if some fields missing
 *
 * Minimum requirements:
 * - amount: Must know how much was charged
 * - At least one card identifier (lastFour OR authorizationCode)
 */
export function validateBlumonWebhookPayload(payload: unknown): payload is BlumonWebhookPayload {
  if (!payload || typeof payload !== 'object') {
    return false
  }

  const p = payload as Record<string, unknown>

  // MINIMUM required: amount (how much was charged)
  if (!('amount' in p)) {
    return false
  }

  // At least one card/transaction identifier for matching
  const hasCardIdentifier = 'lastFour' in p || 'authorizationCode' in p || 'reference' in p
  if (!hasCardIdentifier) {
    return false
  }

  return true
}
