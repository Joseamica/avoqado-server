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

import { parcharProcessorData } from '../shared/parcheDeProcessorData'
import prisma from '../../utils/prismaClient'
import { CardBrand, Prisma, ProviderType, EventStatus, TerminalType } from '@prisma/client'
import logger from '../../config/logger'
import { isVenueOperational } from '@/lib/venueStatus.constants'
import { normalizeTerminalSerialNumber } from '@/utils/terminalSerial'
import { llaveDeIntento } from './candadoDeIntento'
import { sdkPropioEncendido, vencerReversoSinRespuesta } from './reversoDeLaTerminal.service'
import {
  RECEIVER_FIRST_WINDOW_MS,
  capturarTarifaAlIngreso,
  confirmarAvisoPorVinculo,
  ingresarEventoDelIntento,
} from './angelpay-webhook.service'
// Familia D: la red lo lee de aquí (importar el núcleo directo desde el job lo acercaría a los transportes de mensajes).
export { RETENCION_DIFERIDA } from './angelpay-webhook.service'

/**
 * Helper function for async delay
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Webhook reconciliation constants — canonical reasons for ProviderEventLog.errorReason
// Kept as string literals so we can add cases without DB migrations. The set is
// intentionally small and stable so dashboards can query by it.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/**
 * Blumon `operationType` values that move money BACK to the cardholder. They
 * are recorded but never run the sale-matching path, and never orphan-alert.
 * Single source of truth shared with the reconciliation job.
 */
export const REVERSAL_OPERATION_TYPES = ['DEVOLUCION', 'CANCELACION'] as const

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
  /** 2+ Payments matched the webhook keys — requires human attribution */
  AMBIGUOUS_MATCH: 'AMBIGUOUS_MATCH',
  /** Only a weak key (partial reference) matched — never auto-linked */
  WEAK_MATCH_ONLY: 'WEAK_MATCH_ONLY',
  /** Reversal event recorded but not yet tied to a refund (ledger plan) */
  REVERSAL_UNMATCHED: 'REVERSAL_UNMATCHED',
} as const

/**
 * How long an event can sit in `PENDING` before the worker promotes it to
 * ERROR + errorReason=ORPHANED. 24h covers offline-queue replays from killed
 * apps with no internet for a day.
 */
export const BLUMON_WEBHOOK_PENDING_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Time window for the AUTH_CODE tier (incident 2026-07-30, Mindform).
 *
 * 6-digit issuer auth codes RECYCLE. Unbounded, `venue + auth + amount` matched
 * a Payment from 20 days earlier — same venue, same $110, same auth, different
 * card and different operation number. The real Payment did not exist yet (the
 * webhook beat it by 1.97s), so there was only ONE candidate and the ambiguity
 * guard never fired.
 *
 * 48h is deliberately wider than the arrival skew we actually see (seconds) so
 * an offline-queue replay still lands, but far tighter than the recycle period.
 * It only bounds the WEAK tier: OP_NUMBER / REFERENCE_EXACT stay unbounded
 * because they identify a transaction on their own.
 */
export const BLUMON_AUTH_CODE_MATCH_WINDOW_MS = 48 * 60 * 60 * 1000

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
  return (await resolveBlumonScope(rawSerial)).venueIds
}

/**
 * Same resolution as {@link resolveScopeVenueIdsFromBlumonSerial}, but also
 * returns the `MerchantAccount.id` behind the serial so matching can be scoped
 * to the EXACT merchant — not just the venue. A venue can hold more than one
 * Blumon merchant, and venue-only scoping lets a weak key select a Payment
 * that was charged through a different merchant.
 *
 * Resolved here (rather than importing `payment.tpv.service.ts`) because that
 * module imports THIS one — the reverse import would create a cycle. The
 * merchant is already queried below, so this costs nothing extra.
 */
export async function resolveBlumonScope(
  rawSerial: string | undefined | null,
): Promise<{ venueIds: string[]; merchantAccountId: string | null }> {
  if (!rawSerial) return { venueIds: [], merchantAccountId: null }
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

  return { venueIds: Array.from(venueIds), merchantAccountId: merchantAccount?.id ?? null }
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
  const opType = payload.operationType

  // A reversal carries the SAME (operationNumber, reference) as the sale it
  // reverses, so without a namespace the unique index treats it as a duplicate
  // of its own sale. VENTA (and any legacy/absent operationType) MUST keep the
  // exact historical shape — changing it would break dedup against every row
  // already stored.
  // `find` (not `includes`) so the result is narrowed to the literal union —
  // `operationType` is optional, so it may be undefined here.
  const reversalType = REVERSAL_OPERATION_TYPES.find(t => t === opType)
  const prefix = reversalType ? `blumon-tpv-reversal-${reversalType.toLowerCase()}` : 'blumon-tpv'

  if (op != null && ref) return `${prefix}-${op}-${ref}`
  if (op != null) return `${prefix}-${op}`
  if (ref) return `${prefix}-${ref}`
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
  business?: string // Merchant name registered with Blumon (e.g., an aggregator's business name)
  businessRfc?: string // Tax ID (RFC) of the merchant

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

  /**
   * EMV Authorization Request Cryptogram — proof that the chip authenticated. 16 hex chars. F6: dato del chip — NUNCA se
   * guarda en `ProviderEventLog.payload` (`sinTitular`) ni va al log (`paraElLog`).
   */
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
    | 'REVERSAL_RECEIVED' // DEVOLUCION/CANCELACION — recorded, excluded from sale matching
    | 'AMBIGUOUS' // 2+ Payment candidates matched — quarantined, NEVER auto-linked
    | 'NO_AUTO_MATCH' // only weak-key candidates (partial reference) — human attribution required
    | 'ERROR' // Internal exception
    // El aviso con nuestro intento vinculado (`confirmarBlumonPorVinculo`), con la misma regla que AngelPay:
    | 'CONFIRMED' // fue el PRIMER confirmador: creó el Payment por el registrador
    | 'SECOND_CAPTURE' // la solicitud ya tenía ganador: evidencia de posible segunda captura
    | 'REFERENCE_COLLISION' // evidencia de colisión de referencia, no un cobro
    | 'HELD_BY_REVERSAL'
    | 'REVERSED_BY_TERMINAL'
  /** ProviderEventLog row that was created/found for this webhook (always set when persisted). */
  eventLogId?: string
  /**
   * Canonical reason to persist on the event log. Lets a caller distinguish
   * kinds of ERROR (e.g. an unmatchable payload vs an internal exception)
   * without overloading `message`, which is human-facing.
   */
  errorReason?: string
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
export async function processBlumonPaymentWebhook(crudo: BlumonWebhookPayload): Promise<WebhookProcessingResult> {
  const correlationId = `blumon-wh-${Date.now()}`
  // R3-7: el receptor trabaja con la copia por lista BLANCA (valores validados y texto enmascarado), la misma que guarda y que
  // la red relee: ningún log ni escritura de este camino lee el cuerpo CRUDO. Sólo la decisión de aprobado (abajo) mira el
  // `codeResponse` crudo, para no cambiarla: un `codeResponse` ilegible que la copia descarta sigue sin aprobar.
  const payload = sinTitular(crudo)

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
    const [terminal, blumonScope] = await Promise.all([
      resolveTerminalFromBlumonSerial(payload.serialNumber),
      resolveBlumonScope(payload.serialNumber),
    ])
    const scopeVenueIds = blumonScope.venueIds
    const merchantAccountId = blumonScope.merchantAccountId
    const scopeVenueId = terminal?.venueId ?? null

    // A serial is OURS if it resolves to EITHER identity:
    //   • a physical `Terminal` row, or
    //   • a `MerchantAccount.blumonSerialNumber` — where VIRTUAL serials live.
    //
    // Virtual serials are a deliberate multi-merchant strategy: one physical
    // device carries N Blumon affiliations, registered as the base serial plus
    // variants with an extra digit (2840744167 → 28407441672). Those variants
    // exist ONLY on MerchantAccount, never as a Terminal row.
    //
    // Checking `terminal` alone discarded a real $9,324 charge as
    // UNKNOWN_TERMINAL before it ever reached the matching cascade (Berthe,
    // 2026-07-30) — while `resolveBlumonScope`, already resolved in the same
    // Promise.all above, identified the merchant correctly.
    //
    // Both lookups stay EXACT. Fuzzy serial comparison to route money would be
    // far more dangerous than a missed webhook.
    // Full context: `.claude/rules/blumon-seriales-virtuales.md`
    if (payload.serialNumber && !terminal && !merchantAccountId) {
      logger.warn('🚫 [Blumon webhook] Unknown serial — no Terminal and no MerchantAccount', {
        correlationId,
        rawSerial: payload.serialNumber,
        canonical: canonicalizeBlumonSerial(payload.serialNumber),
        hint: 'Serial matches neither a Terminal nor a MerchantAccount.blumonSerialNumber. Either it belongs to another integrator, or a (possibly virtual) merchant serial was never registered.',
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
    const isApproved = !crudo.codeResponse || crudo.codeResponse === '00'
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

      // 🔴 Blumon NO libera solo, y es una decisión medida, no prudencia genérica (21-sep-2026).
      //
      // Blumon no devuelve nuestra llave: manda `reference`, un timestamp de SU terminal. La única correlación
      // posible sería la ranura + el importe, y eso se midió contra producción: **149 de 1211 transacciones
      // (12,3 %) tienen otra del MISMO importe en la MISMA terminal dentro de 15 minutos**. Uno de cada ocho.
      // Atribuir automáticamente con esa tasa es el camino al cobro doble — exactamente lo que la cerca existe
      // para impedir. (Codex gpt-6-astra lo señaló como P1: «el índice garantiza exclusividad ACTUAL, no
      // pertenencia histórica del webhook».)
      //
      // 🔑 Lo que sí sabe el cajero y el servidor no: CUÁL de esos cobros es el suyo. Por eso aquí el rechazo se
      // queda como EVIDENCIA consultable (`ProviderEventLog` ya lo guarda con su terminal, importe y hora), y el
      // POS la ofrece para que una persona confirme con un toque. La evidencia del banco convierte su declaración
      // de «te creo» en «confirma lo que el banco ya dijo».
      //
      // Y de paso desaparecen otros dos P1 que eran de este carril: una DEVOLUCIÓN o CANCELACIÓN rechazada ya no
      // puede leerse como venta rechazada (que es al revés: el cargo sigue vigente), y un webhook falsificado —
      // Blumon no firma, sólo lista de IPs — ya no mueve estado financiero por sí solo.
      return {
        success: true,
        action: 'NOT_APPROVED',
        eventLogId: event.id,
        message: `Transaction not approved: ${payload.descriptionResponse || 'Unknown'}`,
        details: { blumonAmount },
      }
    }

    // ───────────── 4. ¿Trae nuestro intento vinculado? Se decide UNA vez, al ingreso, y viaja en el evento ─────────────
    const ctx = await contextoDelIntento(payload)

    // ───────────── 5. Insert PENDING event row before any Payment lookup ─────────────
    let event: { id: string }
    try {
      if (ctx) {
        // La misma regla que AngelPay: la tarifa se congela al INGRESO (sólo con el venue del vínculo acreditado) y el
        // evento entra serializado bajo el candado del intento; un ingreso por el fallback (55P03) lleva su marca.
        const tarifaCongeladaAlIngreso = ctx.receiverVenueId
          ? await capturarTarifaAlIngreso(ctx.linkVenueId, ctx.merchantAccountId, 'Blumon')
          : null
        const id = await ingresarEventoDelIntento(ctx.attemptId, (tx, marca) =>
          tx.providerEventLog.create({
            data: {
              provider: ProviderType.PAYMENT_PROCESSOR,
              eventId: eventIdString,
              type: payload.operationType ?? 'VENTA',
              payload: {
                ...payload,
                _avoqado: {
                  receivedByMerchantAccountId: ctx.merchantAccountId,
                  contextoDelIngreso: ctx,
                  ...(tarifaCongeladaAlIngreso ? { tarifaCongeladaAlIngreso } : {}),
                  ...(marca ?? {}),
                },
              } as unknown as Prisma.InputJsonValue,
              venueId: ctx.receiverVenueId ?? terminal?.venueId ?? null,
              terminalId: terminal?.id ?? null,
              status: EventStatus.PENDING,
              attemptId: ctx.attemptId,
              nextAttemptAt: new Date(Date.now() + RECEIVER_FIRST_WINDOW_MS),
            },
            select: { id: true },
          }),
        )
        event = { id }
      } else {
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
      }
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

    // ───────────── 6. Con nuestro intento: el núcleo compartido decide (y sella el evento); el débil ya no corre ─────────────
    if (ctx) {
      try {
        const r = await confirmarBlumonPorVinculo({ payload, eventLogId: event.id, ctx })
        if (r) return { ...r, eventLogId: event.id }
      } catch (error) {
        // El aviso YA está guardado (PENDING, con su contexto): no se lanza, o el controlador contestaría «no se guardó».
        logger.error('❌ [Blumon webhook] La confirmación por vínculo falló DESPUÉS del ingreso durable — el evento queda PENDING', {
          correlationId,
          eventLogId: event.id,
          attemptId: ctx.attemptId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
        return {
          success: false,
          action: 'ERROR',
          errorReason: BLUMON_WEBHOOK_ERROR_REASONS.PROCESSING_ERROR,
          eventLogId: event.id,
          message: 'Confirmation by attempt link failed after durable ingress',
          details: { blumonAmount },
        }
      }
    }

    // ───────────── 7. Inline reconciliation (5s retry, scoped to merchant's venues) ─────────────
    const matchResult = await attemptPaymentMatch(payload, { scopeVenueIds, merchantAccountId, correlationId })

    // ───────────── 8. Persist final state into the event row ─────────────
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
  // Tarea 6 (hallazgo 7): un evento que entró CON contexto se recupera por el vínculo con la identidad y la tarifa del
  // INGRESO, nunca con la configuración de ahora, y no cae en el emparejamiento débil. Sin contexto guardado nunca crea: un
  // vínculo que llegó después del aviso no tiene identidad ni tarifa acreditadas (lo completa el REST).
  // Sólo vale el contexto de SU fila: la columna `attemptId` la pone únicamente el ingreso con contexto, y tiene que ser la
  // misma llave que el contexto y que la referencia del aviso.
  const guardado = contextoGuardado(payload)
  if (guardado) {
    const fila = await prisma.providerEventLog.findUnique({ where: { id: eventLogId }, select: { attemptId: true } })
    const llave = llaveDeIntento(payload.reference)
    if (fila?.attemptId && fila.attemptId === guardado.attemptId && guardado.attemptId === llave) {
      const r = await confirmarBlumonPorVinculo({ payload, eventLogId, ctx: guardado })
      if (r) return { ...r, eventLogId }
    }
  }
  const correlationId = `blumon-recon-${eventLogId.slice(-8)}`
  const resolvedScope = ctx.scopeVenueIds ? null : await resolveBlumonScope(payload.serialNumber)
  const scopeVenueIds = ctx.scopeVenueIds ?? resolvedScope!.venueIds
  const merchantAccountId = resolvedScope?.merchantAccountId ?? null
  const result = await attemptPaymentMatch(payload, {
    scopeVenueIds,
    merchantAccountId,
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
    case 'REVERSAL_RECEIVED':
      // Terminal (never retried) but explicitly NOT claimed as reconciled —
      // the errorReason keeps it queryable as "received, not tied to a refund".
      data.status = EventStatus.PROCESSED
      data.errorReason = BLUMON_WEBHOOK_ERROR_REASONS.REVERSAL_UNMATCHED
      data.processedAt = new Date()
      break
    case 'AMBIGUOUS':
      // Quarantine: 2+ candidates matched. Deliberately NOT linked to any
      // Payment — attributing to the wrong one is worse than not attributing.
      data.status = EventStatus.ERROR
      data.errorReason = BLUMON_WEBHOOK_ERROR_REASONS.AMBIGUOUS_MATCH
      data.processedAt = new Date()
      break
    case 'NO_AUTO_MATCH':
      // Only a weak key (partial reference) matched — human attribution only.
      data.status = EventStatus.ERROR
      data.errorReason = BLUMON_WEBHOOK_ERROR_REASONS.WEAK_MATCH_ONLY
      data.processedAt = new Date()
      break
    case 'ERROR':
      data.status = EventStatus.ERROR
      // Prefer the caller's canonical reason (e.g. NO_MATCH_FIELDS); fall back
      // to PROCESSING_ERROR for genuine internal exceptions.
      data.errorReason = result.errorReason ?? BLUMON_WEBHOOK_ERROR_REASONS.PROCESSING_ERROR
      data.processedAt = new Date()
      break
    default:
      // PENDING / DUPLICATE / UNKNOWN_TERMINAL / NOT_APPROVED handled by caller already
      return
  }

  // Familia A: sólo un aviso que sigue PENDING (el receptor, la red, el respaldo del REST y el resultado del reverso lo pueden tocar):
  // uno que otro ya resolvió no se reescribe; no aplicar no es error. R3-1: la única excepción es una conciliación que YA tiene su
  // Payment: puede reparar el huérfano que la red escribió en medio (ERROR/ORPHANED), nunca otro desenlace.
  const reparaHuerfano = (result.action === 'MATCHED' || result.action === 'RECONCILED') && !!result.paymentId
  const where: Prisma.ProviderEventLogWhereUniqueInput = reparaHuerfano
    ? {
        id: eventLogId,
        OR: [{ status: EventStatus.PENDING }, { status: EventStatus.ERROR, errorReason: BLUMON_WEBHOOK_ERROR_REASONS.ORPHANED }],
      }
    : { id: eventLogId, status: EventStatus.PENDING }
  await prisma.providerEventLog.update({ where, data }).catch(err => {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      logger.info('🔒 [Blumon webhook] El aviso ya tenía desenlace: no se reescribe', { eventLogId, action: result.action })
      return
    }
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
  ctx: { scopeVenueIds: string[]; merchantAccountId?: string | null; correlationId: string; skipRetries?: boolean } = {
    scopeVenueIds: [],
    correlationId: `blumon-wh-${Date.now()}`,
  },
): Promise<WebhookProcessingResult> {
  const { scopeVenueIds, merchantAccountId, correlationId, skipRetries } = ctx
  try {
    const blumonAmount = parseFloat(payload.amount)

    // ── Deterministic tiered matching (audit 2026-07-18) ────────────────────
    // WHY tiers instead of one big OR: the weak keys are NOT unique in
    // production. `referenceNumber` is a timestamp to the second
    // (yyMMddHHmmss, e.g. 260717220609) and 6-digit issuer auth codes recycle
    // — both already collide in prod with DIFFERENT amounts. And the amount is
    // only compared AFTER a candidate is chosen, where BOTH the MATCHED and
    // DISCREPANCY branches write to that Payment — so a wrong pick is never
    // caught by it. Therefore the amount is part of the KEY in the weak tiers,
    // and a partial reference NEVER auto-links.
    //
    // Reversal/cancellation events must NEVER run the sale-matching logic:
    // they would confirm the wrong row, and their non-match would fire the
    // "charge without record" alert for money that is LEAVING. Recorded as
    // informational; fine-grained reversal↔refund matching ships with the
    // ledger plan.
    if (REVERSAL_OPERATION_TYPES.includes(payload.operationType as (typeof REVERSAL_OPERATION_TYPES)[number])) {
      logger.info('↩️ Blumon webhook: reversal-type event — recorded, excluded from sale matching', {
        correlationId,
        operationType: payload.operationType,
        reference: payload.reference,
        operationNumber: payload.operationNumber,
      })
      return {
        success: true,
        action: 'REVERSAL_RECEIVED',
        message: `Reversal event (${payload.operationType}) recorded`,
        details: { blumonAmount },
      }
    }

    // Venue scope is MANDATORY: an unscoped global search can attribute money
    // to another venue's Payment.
    if (scopeVenueIds.length === 0) {
      logger.warn('⚠️ [Blumon webhook] No venue scope resolved for serial — matching deferred', {
        correlationId,
        serialNumber: payload.serialNumber,
        reference: payload.reference,
      })
      return {
        success: false,
        action: 'PENDING',
        message: 'No venue scope resolved for serial — matching deferred',
        details: { blumonAmount },
      }
    }

    const scopeWhere: Prisma.PaymentWhereInput = {
      status: { in: ['COMPLETED', 'PENDING'] },
      // Refunds share `referenceNumber` with the sale they reverse, so a VENTA
      // webhook could select a REFUND row and write Blumon operation data onto
      // it. Same guard as payment.tpv.service.ts:1413.
      type: { not: 'REFUND' },
      // Exact merchant, not just the venue: one venue can hold more than one
      // Blumon merchant, and venue-only scoping lets a weak key select a
      // Payment charged through a different merchant.
      ...(merchantAccountId ? { merchantAccountId } : {}),
      order: { venueId: { in: scopeVenueIds } },
    }

    type MatchTier = {
      name: 'OP_NUMBER' | 'REFERENCE_EXACT' | 'AUTH_CODE' | 'REFERENCE_PARTIAL'
      where: Prisma.PaymentWhereInput
      /** false ⇒ candidates are reported for human attribution, NEVER auto-linked */
      autoLink: boolean
      /** true ⇒ the amount is part of the selection key, not a post-hoc check */
      requireAmount: boolean
      /**
       * true ⇒ the card brand is part of the key too (when the payload carries
       * one). Only for tiers keyed on a RECYCLABLE value — a brand mismatch
       * proves it is a different transaction. See BLUMON_AUTH_CODE_MATCH_WINDOW_MS.
       */
      requireBrand?: boolean
    }

    const tiers: MatchTier[] = []

    if (payload.operationNumber != null) {
      tiers.push({
        name: 'OP_NUMBER',
        where: {
          ...scopeWhere,
          OR: [
            { processorId: payload.operationNumber.toString() },
            // The REAL home of the Blumon operation number is the JSON the TPV
            // records. `processorId` is legacy-Menta and is read by other
            // domains — match the JSON, don't repurpose the column.
            { processorData: { path: ['blumonOperationNumber'], equals: payload.operationNumber } },
          ],
        },
        autoLink: true,
        requireAmount: false,
      })
    }

    if (payload.reference) {
      tiers.push({
        name: 'REFERENCE_EXACT',
        where: { ...scopeWhere, referenceNumber: payload.reference },
        autoLink: true,
        requireAmount: true,
      })
    }

    if (payload.authorizationCode) {
      tiers.push({
        name: 'AUTH_CODE',
        where: {
          ...scopeWhere,
          authorizationNumber: payload.authorizationCode,
          // Auth codes recycle — without this bound the tier reached a Payment
          // from 20 days earlier (incident 2026-07-30). Out-of-window events
          // fall through to PENDING, where the 24h retry + the per-Payment
          // backfill reconcile them against their real owner.
          createdAt: { gte: new Date(Date.now() - BLUMON_AUTH_CODE_MATCH_WINDOW_MS) },
        },
        autoLink: true,
        requireAmount: true,
        requireBrand: true,
      })
    }

    if (payload.reference && payload.reference.length >= 10) {
      tiers.push({
        name: 'REFERENCE_PARTIAL',
        where: { ...scopeWhere, referenceNumber: { contains: payload.reference.slice(-10) } },
        autoLink: false,
        requireAmount: true,
      })
    }

    if (tiers.length === 0) {
      logger.error('🚨 [Blumon webhook] Payload with NO matchable key — manual review required', {
        correlationId,
        amount: blumonAmount,
        operationType: payload.operationType,
        serialNumber: payload.serialNumber,
      })

      return {
        success: false,
        action: 'ERROR',
        // Terminal, not retryable: without a key this can never match, so
        // leaving it PENDING would make the cron retry it forever.
        errorReason: BLUMON_WEBHOOK_ERROR_REASONS.NO_MATCH_FIELDS,
        message: 'No fields available for payment matching',
        details: { blumonAmount },
      }
    }

    // Tip-aware comparison — Blumon charges base+tip (prod fix 2026-06-24:
    // 67/67 historical "discrepancies" were exactly the tip).
    const amountMatches = (p: { amount: unknown; tipAmount: unknown }): boolean =>
      Math.abs(blumonAmount - (parseFloat(String(p.amount)) + parseFloat(String(p.tipAmount ?? 0)))) < 0.01

    /**
     * Brand check for tiers keyed on a recyclable value. FAIL-OPEN by design:
     * only a POSITIVE disagreement rejects. The webhook without a brand, or a
     * Payment stored without one (legacy rows, AngelPay records it UNKNOWN),
     * proves nothing — rejecting those would strand real charges as orphans,
     * which is the failure mode this whole path exists to prevent.
     */
    const payloadBrand = normalizeBrand(payload.brand)
    const brandMatches = (p: { cardBrand?: unknown }): boolean => {
      if (!payloadBrand) return true
      const paymentBrand = normalizeBrand(p.cardBrand)
      if (!paymentBrand) return true
      return paymentBrand === payloadBrand
    }

    const paymentInclude = {
      order: {
        select: {
          id: true,
          orderNumber: true,
          venueId: true,
          venue: { select: { id: true, name: true, status: true } },
        },
      },
    }

    type TierOutcome =
      | { kind: 'match'; payment: any; tier: string }
      | { kind: 'ambiguous'; tier: string; ids: string[] }
      | { kind: 'weak'; tier: string; ids: string[] }
      | { kind: 'none' }

    const resolveTiers = async (): Promise<TierOutcome> => {
      for (const tier of tiers) {
        const found = await prisma.payment.findMany({
          where: tier.where,
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: paymentInclude,
        })
        const byAmount = tier.requireAmount ? found.filter(amountMatches) : found
        const viable = tier.requireBrand ? byAmount.filter(brandMatches) : byAmount
        if (viable.length === 0) continue
        if (viable.length >= 2) return { kind: 'ambiguous', tier: tier.name, ids: viable.map(v => v.id) }
        if (!tier.autoLink) return { kind: 'weak', tier: tier.name, ids: viable.map(v => v.id) }
        return { kind: 'match', payment: viable[0], tier: tier.name }
      }
      return { kind: 'none' }
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

      const outcome = await resolveTiers()

      if (outcome.kind === 'ambiguous') {
        logger.error('🚨 Blumon webhook: AMBIGUOUS match — quarantining, never auto-linking', {
          correlationId,
          tier: outcome.tier,
          reference: payload.reference,
          operationNumber: payload.operationNumber,
          candidateIds: outcome.ids,
        })
        return {
          success: false,
          action: 'AMBIGUOUS',
          message: `Multiple Payment candidates in tier ${outcome.tier} — requires human attribution`,
          details: { blumonAmount },
        }
      }

      if (outcome.kind === 'weak') {
        logger.error('🚨 Blumon webhook: only a WEAK key matched — not auto-linking', {
          correlationId,
          tier: outcome.tier,
          reference: payload.reference,
          candidateIds: outcome.ids,
        })
        return {
          success: false,
          action: 'NO_AUTO_MATCH',
          message: `Only weak-key candidates (${outcome.tier}) — requires human attribution`,
          details: { blumonAmount },
        }
      }

      payment = outcome.kind === 'match' ? outcome.payment : null

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

      // Payment found - verify amounts match.
      // Blumon charges the card the FULL amount the customer pays (base + tip),
      // so we must compare against `amount + tipAmount`. Comparing against
      // `amount` alone mis-flagged every tipped TPV payment as a discrepancy
      // (prod investigation 2026-06-24: 67/67 historical "discrepancies" were
      // exactly the tip).
      const recordedAmount = parseFloat(payment.amount.toString()) + parseFloat((payment.tipAmount ?? 0).toString())
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

        // Update payment with Blumon operation data if not already received.
        // Codex R12-10: parche ATÓMICO sobre el JSON vigente, sólo con las llaves de este escritor, y el «si no lo tenía
        // ya» decidido en la misma sentencia — nunca un reemplazo desde la copia leída arriba (reponía un `costPending`
        // viejo sobre una obligación ya convergida y pisaba enriquecimientos concurrentes).
        await parcharProcessorData(
          prisma,
          payment.id,
          {
            blumonOperationNumber: payload.operationNumber,
            blumonWebhookReceived: new Date().toISOString(),
            blumonAuthCode: payload.authorizationCode,
            blumonMembership: payload.membership,
          },
          { soloSiFalta: 'blumonWebhookReceived' },
        )

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

        // Create discrepancy alert (could trigger notification to admin). Codex R12-10: parche atómico (ver arriba).
        await parcharProcessorData(prisma, payment.id, {
          blumonDiscrepancy: {
            detectedAt: new Date().toISOString(),
            blumonAmount,
            recordedAmount,
            difference,
            operationNumber: payload.operationNumber,
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
 * Familia E: los campos del aviso que se COPIAN, por lista BLANCA (antes se quitaban por lista negra y un campo EMV nuevo o un
 * objeto anidado se colaba). Son los del tipo `BlumonWebhookPayload` que leen el emparejamiento, la red de 30 s, la conciliación
 * a mano, el auditor de cobros sin aviso y los lectores SQL (`codeResponse`, `serialNumber`). Ninguno es un objeto: sólo se copia
 * un valor primitivo. `cardHolder`, `arqc` y `aid` nunca están (R6, F6, rediseño v2); `bin` y `lastFour` sólo en la base, nunca en el log.
 */
const CAMPOS_DEL_AVISO = [
  'business',
  'businessRfc',
  'bin',
  'lastFour',
  'cardType',
  'brand',
  'bank',
  'amount',
  'reference',
  'authorizationCode',
  'operationType',
  'operationNumber',
  'descriptionResponse',
  'dateTransaction',
  'authentication',
  'membership',
  'provideResponse',
  'codeResponse',
  'serialNumber',
  'realCounter',
] as const
const SOLO_EN_LA_BASE = new Set(['bin', 'lastFour'])
/**
 * Lo que se quita a propósito y en silencio: no es «nuevo» (`_avoqado` lo escribe sólo el SERVIDOR). Rediseño v2: `aid` también —
 * nada lo lee para emparejar ni conciliar, y su forma hexadecimal admite un criptograma del chip.
 */
const CAMPOS_QUE_NUNCA_SE_COPIAN = new Set(['cardHolder', 'arqc', 'aid', '_avoqado'])
/** Cuántos nombres de campos desconocidos se guardan: basta para saber que Blumon agregó algo. */
const TOPE_DE_CAMPOS_NO_RECONOCIDOS = 20
/**
 * R3-7: un nombre desconocido sólo se guarda si tiene forma de identificador y menos de 12 dígitos (con o sin separadores); los demás
 * sólo se cuentan (`camposNoReconocidosSinNombre`): una llave también puede traer el PAN.
 */
const NOMBRE_GUARDABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
/**
 * R3-7: los campos con forma FIJA se validan por valor; uno que no la cumple no se copia y su nombre va a `camposNoReconocidos`.
 * Rediseño v2: la fecha y el RFC también (con forma fija no son texto libre: su enmascarado los volvería ilegibles).
 */
const FORMA_FIJA = new Map<string, RegExp>([
  ['lastFour', /^\d{4}$/],
  ['bin', /^\d{6,8}$/],
  ['dateTransaction', /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/],
  ['businessRfc', /^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/i],
])
/**
 * R3-7 + rediseño v2 (Codex r4 #6): el texto LIBRE (lo que Blumon describe, no las llaves del emparejamiento) va con TODO dígito
 * enmascarado —así ningún separador deja pasar un PAN— y toda racha de 12+ hexadecimales también (un criptograma), con tope de
 * largo, antes de ir al log o a la base. Nada lee dígitos de estos campos (la marca, el tipo de operación y el tipo de tarjeta
 * son palabras). Las llaves (`amount`, `reference`, `operationNumber`, `authorizationCode`, `codeResponse`, `serialNumber`,
 * `membership`, `realCounter`) se copian tal cual: el emparejamiento y los lectores SQL comparan su valor exacto (`reference` es
 * un timestamp de 14 dígitos).
 */
const TEXTO_LIBRE = new Set([
  'business',
  'cardType',
  'brand',
  'bank',
  'operationType',
  'descriptionResponse',
  'authentication',
  'provideResponse',
])

/**
 * El saneador del texto libre que viene del banco (el aviso de Blumon y el resultado del reverso): `null` sigue `null`; un valor
 * que no cambia conserva su tipo.
 */
export function enmascararTextoLibre(valor: unknown): unknown {
  if (valor === null) return valor
  const texto = String(valor)
  const limpio = texto
    .replace(/[0-9A-Fa-f]{12,}/g, '[enmascarado]')
    .replace(/\d/g, '#')
    .slice(0, 120)
  return limpio === texto ? valor : limpio
}

function copiaPorListaBlanca(aviso: Record<string, unknown>, destino: 'base' | 'log'): Record<string, unknown> {
  const copia: Record<string, unknown> = {}
  const permitidos = new Set<string>(CAMPOS_DEL_AVISO)
  const noReconocidos: string[] = []
  let sinNombre = 0
  for (const [campo, valor] of Object.entries(aviso)) {
    if (CAMPOS_QUE_NUNCA_SE_COPIAN.has(campo)) continue
    const primitivo = valor === null || ['string', 'number', 'boolean'].includes(typeof valor)
    const conForma = FORMA_FIJA.get(campo)?.test(String(valor)) ?? true
    if (permitidos.has(campo) && primitivo && conForma) {
      if (destino === 'base' || !SOLO_EN_LA_BASE.has(campo)) copia[campo] = TEXTO_LIBRE.has(campo) ? enmascararTextoLibre(valor) : valor
    } else if (!NOMBRE_GUARDABLE.test(campo) || (campo.match(/\d/g)?.length ?? 0) >= 12) {
      sinNombre++
    } else if (noReconocidos.length < TOPE_DE_CAMPOS_NO_RECONOCIDOS) {
      noReconocidos.push(campo)
    }
  }
  if (noReconocidos.length > 0) copia.camposNoReconocidos = noReconocidos
  if (sinNombre > 0) copia.camposNoReconocidosSinNombre = sinNombre
  return copia
}

/**
 * Lo que del aviso se guarda en `ProviderEventLog.payload`: los campos de la lista blanca (con `bin` y `lastFour`, que usan el
 * emparejamiento y la conciliación a mano) y los NOMBRES de los que no conoce (`camposNoReconocidos`). Sin titular, sin `arqc`
 * y sin `_avoqado`: ése es el sello que escribe el SERVIDOR (contexto y tarifa del ingreso, marca 55P03, afiliación receptora);
 * uno que llegue en el aviso nunca puede hacerse pasar por él. No toca el aviso original.
 */
export function sinTitular(payload: BlumonWebhookPayload): BlumonWebhookPayload {
  return copiaPorListaBlanca(payload, 'base') as BlumonWebhookPayload
}

/**
 * Lo que del aviso puede ir al log: la misma lista blanca sin `bin` ni `lastFour`, y los nombres de lo desconocido. Si la raíz
 * no es un objeto (cadena, número, arreglo, `null`), sólo su tipo y el tamaño, nunca el valor: un JSON doblemente codificado
 * trae la tarjeta entera dentro de la cadena.
 */
export function paraElLog(body: unknown, rawBodyLength?: number): Record<string, unknown> {
  if (body && typeof body === 'object' && !Array.isArray(body)) return copiaPorListaBlanca(body as Record<string, unknown>, 'log')
  const rootType = body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body
  return { rootType, rawBodyLength }
}

/** Marca de la tarjeta como la guarda la base (`AMEX` ⇒ `AMERICAN_EXPRESS`); vacía, `UNKNOWN` u `OTHER` ⇒ `null`. */
export function normalizeBrand(b: unknown): string | null {
  const s = String(b ?? '')
    .trim()
    .toUpperCase()
  if (!s || s === 'UNKNOWN' || s === 'OTHER') return null
  return s === 'AMEX' ? 'AMERICAN_EXPRESS' : s
}

/**
 * F7: la marca con la que el aviso CREA el Payment: la normalizada si es un valor de `CardBrand`; otra conocida por Blumon que
 * el enum no tiene (p. ej. `CARNET`) ⇒ `OTHER` (con ella el registrador fallaba en cada reintento). El emparejamiento sigue
 * con `normalizeBrand`.
 */
export function marcaParaElRegistro(b: unknown): CardBrand | undefined {
  const marca = normalizeBrand(b)
  if (!marca) return undefined
  return (Object.values(CardBrand) as string[]).includes(marca) ? (marca as CardBrand) : CardBrand.OTHER
}

/** El importe del aviso en centavos EXACTOS: sólo una cadena `123` o `123.4` o `123.45`; lo demás (número, comas, 3 decimales) ⇒ `null`. */
export function centavosExactos(amount: unknown): number | null {
  if (typeof amount !== 'string') return null
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount)
  if (!m) return null
  const centavos = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(centavos) ? centavos : null
}

/**
 * Lo que el aviso de Blumon acredita al INGRESO cuando trae nuestro intento vinculado. Se calcula una vez y viaja en el
 * evento (`_avoqado.contextoDelIngreso`): la recuperación nunca lo recalcula con la configuración de horas después.
 */
export type ContextoDelIngreso = {
  attemptId: string
  requestId: string
  linkVenueId: string
  linkTerminalId: string
  merchantAccountId: string
  /** El venue del vínculo, sólo si la afiliación está en SU configuración de pago; si no, `null` (⇒ LINK_VENUE_MISMATCH). */
  receiverVenueId: string | null
  /** El serial con el que el núcleo compara contra la terminal del vínculo. */
  terminalSerialEfectivo: string
}

/**
 * `null` = el aviso no crea dinero por vínculo (sigue el emparejamiento de hoy). Exige todo a la vez: `VENTA` y `'00'`
 * EXACTOS (ausentes no aprueban), `reference` = llave de un intento con vínculo S1, y UNA sola afiliación con ese serial.
 */
export async function contextoDelIntento(payload: BlumonWebhookPayload): Promise<ContextoDelIngreso | null> {
  // Rediseño v2: con el candado general apagado (el default), ningún aviso entra por vínculo ni nace con contexto.
  if (!sdkPropioEncendido()) return null
  if (payload.operationType !== 'VENTA' || payload.codeResponse !== '00') return null
  const attemptId = llaveDeIntento(payload.reference)
  const serial = typeof payload.serialNumber === 'string' ? payload.serialNumber : ''
  if (!attemptId || !serial.trim()) return null
  const { terminalPaymentService } = await import('../terminal-payment.service')
  const link = await terminalPaymentService.findAttemptLink(attemptId)
  if (!link) return null
  // H7: la MISMA normalización que `resolveBlumonScope`; búsqueda exacta (seriales virtuales).
  const afiliaciones = await prisma.merchantAccount.findMany({
    where: { blumonSerialNumber: serial.trim().replace(/^AVQD-/, '') },
    select: { id: true },
    take: 2,
  })
  if (afiliaciones.length !== 1) return null
  const merchantAccountId = afiliaciones[0].id

  const [config, terminalDelAviso] = await Promise.all([
    prisma.venuePaymentConfig.findUnique({
      where: { venueId: link.venueId },
      select: { primaryAccountId: true, secondaryAccountId: true, tertiaryAccountId: true },
    }),
    // F12: el mismo normalizador que guarda `Terminal.serialNumber` (mayúsculas), no `canonicalizeBlumonSerial`.
    prisma.terminal.findUnique({
      where: { serialNumber: normalizeTerminalSerialNumber(serial, TerminalType.TPV_ANDROID) },
      select: { id: true },
    }),
  ])
  const enLaConfiguracion =
    !!config && [config.primaryAccountId, config.secondaryAccountId, config.tertiaryAccountId].includes(merchantAccountId)

  // Un serial con su propia `Terminal` la identifica: si no es la del vínculo, el núcleo lo contradice (la afiliación
  // compartida no lo tapa). Uno virtual (sin `Terminal`) vale por la del vínculo sólo si esa terminal tiene la afiliación.
  let terminalSerialEfectivo = serial
  if (!terminalDelAviso) {
    const delVinculo = await prisma.terminal.findUnique({
      where: { serialNumber: normalizeTerminalSerialNumber(link.terminalId, TerminalType.TPV_ANDROID) },
      select: { assignedMerchantIds: true },
    })
    if (delVinculo?.assignedMerchantIds.includes(merchantAccountId)) terminalSerialEfectivo = link.terminalId
  }

  return {
    attemptId,
    requestId: link.requestId,
    linkVenueId: link.venueId,
    linkTerminalId: link.terminalId,
    merchantAccountId,
    receiverVenueId: enLaConfiguracion ? link.venueId : null,
    terminalSerialEfectivo,
  }
}

/** El contexto que el ingreso guardó en el evento, con su forma exacta; cualquier otra cosa ⇒ `null`. */
export function contextoGuardado(payload: unknown): ContextoDelIngreso | null {
  const c = (payload as { _avoqado?: { contextoDelIngreso?: Record<string, unknown> } } | null)?._avoqado?.contextoDelIngreso
  if (!c || typeof c !== 'object') return null
  const texto = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  const { attemptId, requestId, linkVenueId, linkTerminalId, merchantAccountId, receiverVenueId, terminalSerialEfectivo } = c
  if (![attemptId, requestId, linkVenueId, linkTerminalId, merchantAccountId, terminalSerialEfectivo].every(texto)) return null
  if (receiverVenueId !== null && !texto(receiverVenueId)) return null
  return {
    attemptId,
    requestId,
    linkVenueId,
    linkTerminalId,
    merchantAccountId,
    receiverVenueId,
    terminalSerialEfectivo,
  } as ContextoDelIngreso
}

/**
 * El traductor de Blumon al núcleo compartido (`confirmarAvisoPorVinculo`): afiliación, venue y serial salen del CONTEXTO
 * del ingreso, nunca recalculados. `null` = no aplica (el llamador sigue con el emparejamiento de hoy).
 */
export async function confirmarBlumonPorVinculo(args: {
  payload: BlumonWebhookPayload
  eventLogId: string
  ctx: ContextoDelIngreso
}): Promise<WebhookProcessingResult | null> {
  const { payload, eventLogId, ctx } = args
  // Tarea 7: una lápida `reversing` vencida no detiene el aviso: aquí se vence. F2: la MARCA `reversoIncierto` no sale de esta
  // lectura (previa al candado: la red puede vencerla en medio) sino de la que hace la guarda del registrador bajo el candado.
  await vencerReversoSinRespuesta(ctx.attemptId)
  const r = await confirmarAvisoPorVinculo({
    etiqueta: 'Blumon',
    attemptId: ctx.attemptId,
    eventLogId,
    receiverVenueId: ctx.receiverVenueId,
    merchantAccountId: ctx.merchantAccountId,
    terminalSerial: ctx.terminalSerialEfectivo,
    importeCentavos: centavosExactos(payload.amount),
    // Sin `maskedPan`/`last4`: los pone el REST (así no hay contradicción de formato).
    datosDelRegistro: {
      referenceNumber: payload.reference,
      authorizationNumber: payload.authorizationCode,
      cardBrand: marcaParaElRegistro(payload.brand),
      blumonOperationNumber: payload.operationNumber,
      blumonSerialNumber: payload.serialNumber,
    },
    huella: {
      clave: 'blumonWebhook',
      datos: {
        eventId: buildBlumonEventId(payload),
        operationNumber: payload.operationNumber ?? null,
        reference: payload.reference ?? null,
        serialNumber: payload.serialNumber ?? null,
      },
      // Codex r5: la marca que lee el auditor de cobros sin aviso (`blumon-payment-audit.job.ts`).
      extra: { blumonWebhookReceived: true },
    },
    // Familia A: el aviso de Blumon no tiene token de dueño (lo procesan el receptor, la red y el resultado del reverso); cada
    // escritura del núcleo exige que siga PENDING. Uno que ya tiene desenlace (p. ej. el REVERSADA lo selló) no se reabre: 0 filas
    // no es error y se contesta el desenlace que la fila ya tiene.
    propietario: { status: EventStatus.PENDING },
    correlationId: `blumon-wh-${eventLogId.slice(-8)}`,
  })
  if (!r) return null
  // Familia B: el 🚨 del cobro con el reverso en duda ya no sale de aquí: lo emite el registrador que CREÓ el Payment, con su
  // ActivityLog en la misma transacción (una lectura después del sello podía perderlo y dos procesadores, repetirlo).
  const pasan = [
    'CONFIRMED',
    'SECOND_CAPTURE',
    'REFERENCE_COLLISION',
    'MATCHED',
    'DISCREPANCY',
    'ERROR',
    'HELD_BY_REVERSAL',
    'REVERSED_BY_TERMINAL',
  ] as const
  const action = pasan.find(a => a === r.action) ?? 'PENDING' // ORPHANED: el evento sigue PENDING
  return {
    success: action === 'CONFIRMED' || action === 'MATCHED',
    action,
    ...(r.errorReason ? { errorReason: r.errorReason } : {}),
    ...(r.paymentId ? { paymentId: r.paymentId } : {}),
    eventLogId,
    message: r.message ?? `Blumon webhook ${action} by attempt link`,
    details: { blumonAmount: parseFloat(payload.amount) },
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
  // `operationNumber` is Blumon's strongest per-transaction key — it was
  // missing here, so a webhook identified only by it was rejected outright.
  const hasCardIdentifier = 'lastFour' in p || 'authorizationCode' in p || 'reference' in p || 'operationNumber' in p
  if (!hasCardIdentifier) {
    return false
  }

  return true
}
