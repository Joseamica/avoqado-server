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
import { tarifaCongeladaDeLaAfiliacion, tarifaConCapturaFallida } from '../payments/transactionCost.service'
import { MARCA_INGRESO_SIN_CANDADO, type TarifaCapturadaAlIngreso } from './evidenciaDeIngreso'
import { utcTs } from '@/utils/sqlDates'
import { clasificarEstadoBancario, estadoBancarioSql, MOTIVO_ESTADO_INVALIDO, type EstadoBancario } from './estadoBancario'
import { Prisma, ProviderType, EventStatus, TerminalType } from '@prisma/client'
import logger from '@/config/logger'
import { normalizeTerminalSerialNumber, terminalIdentityKey } from '@/utils/terminalSerial'
import { randomUUID } from 'crypto'
import { tipoDeEvidencia } from './segundaCaptura'
import { OPCIONES_DE_TRANSACCION_DEL_INTENTO, candadoDeIntento, llaveDeIntento } from './candadoDeIntento'
import { RETRIES_EXHAUSTED } from './angelpayEventWorker.service'

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
  // Reconciled against a Payment recorded under a DIFFERENT merchant than the one
  // whose endpoint received the webhook — the money moved through one affiliation
  // while the books say another (cross-merchant incident, 2026-07). Loud, never silent.
  | 'MATCHED_WRONG_MERCHANT'
  | 'DISCREPANCY'
  | 'ORPHANED'
  | 'NOT_APPROVED'
  // Codex R13-4: estado bancario PRESENTE pero ilegible — evidencia pendiente con motivo, nunca aprobación demostrada.
  | 'INVALID_STATUS'
  | 'UNKNOWN_MERCHANT'
  | 'UNSUPPORTED_EVENT_TYPE'
  | 'DUPLICATE'
  | 'ERROR'
  // S2 (checkpoint 1): el webhook fue el PRIMER confirmador — creó el Payment por el registrador compartido.
  | 'CONFIRMED'
  // S2: la solicitud ya tenía ganador; el intento del webhook quedó como POSIBLE SEGUNDA CAPTURA (evidencia).
  | 'SECOND_CAPTURE'
  // Codex R5 (P2): el registrador devolvió por la llave una evidencia de COLISIÓN de referencia (R4-6) — evidencia, no un
  // cobro confirmado ni un MATCHED: la solicitud sigue sin ganador y nadie la lee como «cobrado».
  | 'REFERENCE_COLLISION'

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
  // Codex R13-4: el estado bancario viene pero no es legible (número, objeto, vacío): no acredita nada; queda PENDING con motivo.
  INVALID_STATUS: MOTIVO_ESTADO_INVALIDO,
  ORPHANED: 'ORPHANED',
  // AngelPay fires the webhook on charge-approval; the TPV records the Payment only
  // after the cashier dismisses the success screen (often minutes later). The event
  // is left PENDING with this reason so reconcile-on-Payment-create can pick it up.
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  // Codex R1 (P1-2): el webhook firmado acredita un cargo en una terminal distinta de la del vínculo del intento.
  LINK_TERMINAL_MISMATCH: 'LINK_TERMINAL_MISMATCH',
  // The webhook's receiving endpoint (per-merchant URL + per-merchant HMAC secret,
  // i.e. the affiliation that ACTUALLY charged) differs from the merchant the
  // Payment was recorded under. Deposits follow the affiliation, so the books
  // point at the wrong bank stream. Surfaced loudly; the match is still stored.
  MERCHANT_MISMATCH: 'MERCHANT_MISMATCH',
  PROCESSING_ERROR: 'PROCESSING_ERROR',
  // S2: el vínculo del intento (S1) pertenece a otro venue que el merchant del secreto — no se crea dinero.
  LINK_VENUE_MISMATCH: 'LINK_VENUE_MISMATCH',
  // S2: el intento del webhook resultó ser una posible segunda captura de una solicitud ya ganada.
  POSSIBLE_SECOND_CAPTURE: 'POSSIBLE_SECOND_CAPTURE',
  // Codex R5 (P2): el intento del webhook es una evidencia de colisión de referencia (misma referencia, candidato que contradice).
  POSSIBLE_REFERENCE_COLLISION: 'POSSIBLE_REFERENCE_COLLISION',
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
/** S4: ventana de exclusiva del receptor inmediato antes de que el worker pueda reclamar un evento PENDING. */
export const RECEIVER_FIRST_WINDOW_MS = 60_000
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export interface MatchedPayment {
  id: string
  amount: Prisma.Decimal | number | string
  tipAmount: Prisma.Decimal | number | string
  processorData: Prisma.JsonValue | null
  venueId: string
}

/**
 * Codex R1 (P2): TODA huella del webhook sobre `Payment.processorData` se fusiona en SQL sobre el valor VIGENTE
 * (`||` de jsonb), nunca desde una copia leída antes — un `update` con el spread de una lectura vieja pisaba lo que
 * S3 (enriquecimiento del REST) o el registrador escribieron en medio.
 */
async function estamparProcessorData(
  paymentId: string,
  parche: Record<string, unknown>,
  db: Pick<Prisma.TransactionClient, '$executeRaw'> = prisma,
): Promise<void> {
  await db.$executeRaw`
    UPDATE "Payment"
    SET "processorData" = CASE WHEN jsonb_typeof("processorData") = 'object' THEN "processorData" ELSE '{}'::jsonb END || CAST(${JSON.stringify(parche)} AS jsonb)
    WHERE "id" = ${paymentId}`
}

/** Escritura final de un evento COMO DUEÑO (token del receptor o del worker): si otro dueño lo reclamó, no se escribe y se dice. */
async function escribirEventoComoDueno(
  eventLogId: string,
  propietario: Record<string, unknown>,
  data: Prisma.ProviderEventLogUncheckedUpdateManyInput,
  contexto: Record<string, unknown>,
): Promise<boolean> {
  const { count } = await prisma.providerEventLog.updateMany({ where: { id: eventLogId, ...propietario }, data })
  if (count !== 1) {
    logger.warn('🔒 [AngelPay webhook] La escritura final del evento no aplicó: otro dueño (worker) lo reclamó — lo cierra él', {
      eventLogId,
      ...contexto,
    })
    return false
  }
  return true
}

/**
 * Codex R4-5 / R5-4: TODA escritura por identidad DÉBIL (sello MATCHED, cruce de comercio, discrepancia y el backfill) se
 * decide BAJO EL CANDADO del evento (`FOR UPDATE`) y sólo si, ya con el candado, el intento de la llave sigue SIN vínculo
 * S1. Con vínculo, el intento tiene DUEÑO: quien llama confirma por el vínculo (o deja el evento al worker) y no escribe
 * nada débil — un vínculo que llega entre la comprobación previa y la escritura convertiría el sello en «PROCESSED sobre
 * el Payment de OTRO cobro del mismo segundo». Orden: candado → S1 → escritura del evento COMO DUEÑO (`reclamo`: el token
 * del receptor/worker, o «sigue PENDING sin lease» en el backfill) → huella en el Payment. Si el reclamo no aplica, no se
 * estampa nada.
 */
async function escribirPorIdentidadDebil(args: {
  eventLogId: string
  llaveDelIntento: string | null
  reclamo: Prisma.ProviderEventLogWhereInput
  data: Prisma.ProviderEventLogUncheckedUpdateManyInput
  paymentId: string
  parche: Record<string, unknown>
}): Promise<{ vinculado: true; requestId: string } | { vinculado: false; escritura: { count: number } }> {
  return prisma.$transaction(async tx => {
    // Codex R6-2: primero la EXCLUSIÓN por intento (cubre el evento que la publicación del vínculo no llegó a ver), después
    // el candado de la fila del evento, y sólo entonces la lectura de S1 — en sentencias separadas: fotografía nueva.
    if (args.llaveDelIntento) await candadoDeIntento(tx, args.llaveDelIntento)
    await tx.$queryRaw`SELECT "id" FROM "ProviderEventLog" /* evento */ WHERE "id" = ${args.eventLogId} FOR UPDATE`
    if (args.llaveDelIntento) {
      const vinculo = await tx.terminalPaymentAttemptLink.findUnique({
        where: { attemptId: args.llaveDelIntento },
        select: { requestId: true },
      })
      if (vinculo) return { vinculado: true as const, requestId: vinculo.requestId }
    }
    const escritura = await tx.providerEventLog.updateMany({ where: { id: args.eventLogId, ...args.reclamo }, data: args.data })
    if (escritura.count === 1) await estamparProcessorData(args.paymentId, args.parche, tx)
    return { vinculado: false as const, escritura }
  }, OPCIONES_DE_TRANSACCION_DEL_INTENTO)
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
    // The TPV stores AngelPay's transactionId as the Payment's `referenceNumber`
    // (verified in prod: ref 260727125955 == webhook transactionId). Without this
    // key, a webhook that arrives WITHOUT integratorReference can never match
    // directly and always falls to the payment-create backfill — which is exactly
    // what made legitimate matches look like merchant mismatches (2026-07-25 $920).
    // Codex R1 (P1-1): `transactionId` es `yyMMddHHmmss` — dos cobros del mismo segundo colisionan. Si el webhook trae
    // llave FUERTE (`integratorReference`), una coincidencia débil sólo vale sobre un Payment SIN llave o con la MISMA;
    // un Payment con OTRA llave es otro intento y no se le atribuye este evento.
    const debiles: Prisma.PaymentWhereInput[] = [
      { processorId: payload.payload.transactionId },
      { referenceNumber: payload.payload.transactionId },
    ]
    const llaveFuerte = payload.payload.integratorReference
    conditions.push(
      ...(llaveFuerte ? debiles.map(c => ({ AND: [c, { OR: [{ idempotencyKey: null }, { idempotencyKey: llaveFuerte }] }] })) : debiles),
    )
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
      select: { id: true, amount: true, tipAmount: true, processorData: true, venueId: true },
    })
    if (payment) return payment as MatchedPayment
  }
  return null
}

/**
 * Second-chance match WITHOUT the receiving-merchant filter — the mismatch detector.
 *
 * The receiving endpoint (per-merchant URL + per-merchant HMAC secret) proves which
 * affiliation ACTUALLY charged the card. If the same-merchant match failed but the
 * same webhook keys point at a Payment recorded under a SIBLING AngelPay merchant of
 * the SAME venue, the TPV registered the charge under the wrong merchant
 * (multi-account incident, 2026-06→2026-07). Scope is deliberately tight:
 *   - same venue as the receiving merchant (never cross-tenant);
 *   - ANGELPAY-provider merchants only (a Blumon payment can never be linked —
 *     both processors use yyMMddHHmmss references, so raw refs DO collide);
 *   - amount must agree to the cent (weak keys are timestamps, not unique).
 */
export async function attemptCrossMerchantMatch(args: {
  payload: AngelPayWebhookPayload
  receiverMerchantAccountId: string
  receiverVenueId: string | null
}): Promise<(MatchedPayment & { merchantAccountId: string | null }) | null> {
  const { payload, receiverMerchantAccountId, receiverVenueId } = args
  if (!receiverVenueId) return null

  const conditions: Prisma.PaymentWhereInput[] = []
  if (payload.payload.integratorReference) {
    conditions.push({ idempotencyKey: payload.payload.integratorReference })
    conditions.push({ referenceNumber: payload.payload.integratorReference })
  }
  if (payload.payload.transactionId) {
    conditions.push({ processorId: payload.payload.transactionId })
    conditions.push({ referenceNumber: payload.payload.transactionId })
  }
  if (conditions.length === 0) return null

  const payment = await prisma.payment.findFirst({
    where: {
      // Codex R5-6: `type` es nullable (legacy): `not: 'REFUND'` a secas dejaba esas filas fuera de la conciliación.
      AND: [{ OR: conditions }, { OR: [{ type: null }, { type: { not: 'REFUND' } }] }],
      status: { in: ['COMPLETED', 'PENDING'] },
      venueId: receiverVenueId,
      merchantAccountId: { not: receiverMerchantAccountId },
      merchantAccount: { provider: { code: 'ANGELPAY' } },
    },
    select: { id: true, amount: true, tipAmount: true, processorData: true, venueId: true, merchantAccountId: true },
  })
  if (!payment) return null

  // Amount gate to the cent — a cross-merchant link on a weak key alone is how
  // money gets attributed to the wrong row. Webhook amount arrives in centavos.
  const webhookAmount = Number(payload.payload.amount) / 100
  const recordedAmount = Number(payment.amount) + Number(payment.tipAmount ?? 0)
  if (!Number.isFinite(webhookAmount) || Math.abs(webhookAmount - recordedAmount) >= 0.01) return null

  return payment as MatchedPayment & { merchantAccountId: string | null }
}

/**
 * Audit trail for a detected merchant mismatch. Fire-and-forget (never throws,
 * never inside a transaction) — an audit failure must not break reconciliation.
 * No staffId: the actor is AngelPay's webhook, not a human.
 */
function logMerchantMismatchActivity(args: {
  paymentId: string
  venueId: string | null
  referenceNumber: string | null
  receivedByMerchantAccountId: string
  recordedMerchantAccountId: string | null
  amount: number
  via: 'webhook-direct' | 'payment-create-backfill'
}): void {
  void prisma.activityLog
    .create({
      data: {
        action: 'ANGELPAY_MERCHANT_MISMATCH',
        entity: 'Payment',
        entityId: args.paymentId,
        venueId: args.venueId,
        data: {
          referenceNumber: args.referenceNumber,
          receivedByMerchantAccountId: args.receivedByMerchantAccountId,
          recordedMerchantAccountId: args.recordedMerchantAccountId,
          amount: args.amount,
          via: args.via,
        },
      },
    })
    .catch(err =>
      logger.warn('⚠️ [AngelPay webhook] failed to write ANGELPAY_MERCHANT_MISMATCH ActivityLog', {
        paymentId: args.paymentId,
        error: err instanceof Error ? err.message : err,
      }),
    )
}

/** Receiving merchant → its venue (via the AngelPay login that owns the merchant). */
async function resolveReceiverVenueId(merchantAccountId: string): Promise<string | null> {
  try {
    const row = await prisma.merchantAccount.findUnique({
      where: { id: merchantAccountId },
      select: { angelpayUserAccount: { select: { venueId: true } } },
    })
    return row?.angelpayUserAccount?.venueId ?? null
  } catch {
    return null
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// S2 · Confirmación por vínculo (checkpoint 1 del webhook como primer confirmador)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * El webhook `approved` crea el dinero SÓLO con correlación exacta (Codex, 13-sep-2026):
 *  · `integratorReference` = `attemptId` con vínculo S1 (`TerminalPaymentAttemptLink`) → la solicitud;
 *  · el venue del merchant del secreto es el venue del vínculo (nunca cross-tenant);
 *  · `status === 'approved'` EXPLÍCITO (la tolerancia a `status` ausente es de conciliación, no de creación);
 *  · `webhook.amount` (centavos) == `request.amountCents + request.tipCents` exacto — ni de más ni de menos; nunca se
 *    inventa propina. Cualquier diferencia ⇒ PENDING/AMOUNT_MISMATCH (lo concilia el REST de la terminal).
 * Entra por el MISMO registrador que el REST (`recordOrderPayment` / `recordFastPayment`) con `registradoVia:
 * 'webhook'`: mismo arbitraje (ganador · reintento · segunda captura), la fila cierra con `closedVia: 'webhook'`, y el
 * Payment nace con método provisional y costo pendiente (S3 lo enriquece). Si fue el PRIMER confirmador, despierta al
 * POS y avisa a la terminal (S5). `null` = no aplica: el llamador sigue con el flujo de siempre.
 */
async function confirmarPorVinculo(args: {
  payload: AngelPayWebhookPayload
  eventLogId: string
  rawEventId: string
  merchantAccount: { id: string; externalMerchantId: string }
  receiverVenueId: string | null
  correlationId: string
  propietario?: Record<string, unknown>
}): Promise<AngelPayWebhookResult | null> {
  const { payload, eventLogId, rawEventId, merchantAccount, receiverVenueId, correlationId } = args
  const propietario = args.propietario ?? {}
  const attemptId = typeof payload.payload.integratorReference === 'string' ? payload.payload.integratorReference.trim() : ''
  if (!attemptId) return null
  // Codex R14-3: la MISMA clasificación que el receptor, el backfill y S6 (`"  Approved  "` es APROBADO en todas partes).
  if (clasificarEstadoBancario(payload.payload.status) !== 'APROBADO') return null

  const { terminalPaymentService } = await import('../terminal-payment.service')
  const link = await terminalPaymentService.findAttemptLink(attemptId)
  if (!link) return null
  if (!receiverVenueId || link.venueId !== receiverVenueId) {
    logger.error('🚨 [AngelPay webhook] El vínculo del intento pertenece a OTRO venue que el merchant del secreto — no se crea dinero', {
      correlationId,
      attemptId,
      linkVenueId: link.venueId,
      receiverVenueId,
      receivedByMerchantAccountId: merchantAccount.id,
    })
    await prisma.providerEventLog.updateMany({
      where: { id: eventLogId, ...propietario },
      data: { status: EventStatus.ERROR, errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.LINK_VENUE_MISMATCH, processedAt: new Date() },
    })
    return { action: 'ERROR', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.LINK_VENUE_MISMATCH, eventLogId }
  }
  // Codex R1 (P1-2): si el webhook FIRMADO dice en qué terminal se cobró, tiene que ser la del vínculo. Una contradicción
  // conserva la evidencia y alarma, pero NO crea ni cierra dinero para esa solicitud.
  const serialDelWebhook = typeof payload.payload.terminalSerial === 'string' ? payload.payload.terminalSerial.trim() : ''
  if (serialDelWebhook && terminalIdentityKey(serialDelWebhook) !== terminalIdentityKey(link.terminalId)) {
    logger.error(
      '🚨 [AngelPay webhook] El serial del webhook CONTRADICE la terminal del vínculo — evidencia conservada, no se crea dinero',
      {
        correlationId,
        attemptId,
        requestId: link.requestId,
        linkTerminalId: link.terminalId,
        webhookTerminalSerial: serialDelWebhook,
      },
    )
    await prisma.providerEventLog.updateMany({
      where: { id: eventLogId, ...propietario },
      data: { status: EventStatus.ERROR, errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.LINK_TERMINAL_MISMATCH, processedAt: new Date() },
    })
    return { action: 'ERROR', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.LINK_TERMINAL_MISMATCH, eventLogId }
  }
  const request = await prisma.terminalPaymentRequest.findFirst({
    where: { requestId: link.requestId, venueId: link.venueId },
    select: {
      requestId: true,
      orderId: true,
      amountCents: true,
      tipCents: true,
      processedByStaffId: true,
      requestedById: true,
      customerId: true,
      rating: true,
    },
  })
  if (!request) return null

  const esperado = request.amountCents + (request.tipCents ?? 0)
  const recibido = Number(payload.payload.amount)
  if (!Number.isInteger(recibido) || recibido !== esperado) {
    logger.error(
      '🚨 [AngelPay webhook] Importe distinto del contrato de la solicitud (base + propina) — no se crea dinero ni se inventa propina',
      {
        correlationId,
        attemptId,
        requestId: request.requestId,
        esperadoCents: esperado,
        recibidoCents: recibido,
      },
    )
    const escritura = await prisma.providerEventLog.updateMany({
      where: { id: eventLogId, ...propietario },
      data: { status: EventStatus.PENDING, errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.AMOUNT_MISMATCH },
    })
    return desenlaceDurableSiPerdioLaPropiedad(eventLogId, escritura, {
      action: 'ORPHANED',
      errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.AMOUNT_MISMATCH,
      eventLogId,
    })
  }

  // El serial del vínculo es la llave normalizada; la base guarda `AVQD-…` en mayúsculas (normalizeTerminalSerialNumber).
  const serial = normalizeTerminalSerialNumber(link.terminalId, TerminalType.TPV_ANDROID)
  const { validateStaffVenue } = await import('@/utils/staff-venue.util')
  let staffId: string | undefined
  for (const candidato of [request.processedByStaffId, request.requestedById]) {
    if (!candidato) continue
    try {
      staffId = await validateStaffVenue(candidato, link.venueId)
      if (staffId) break
    } catch {
      // El siguiente candidato; sin ninguno, el Payment nace sin cajero (como un cobro sin identidad de personal).
    }
  }
  const paymentData = {
    venueId: link.venueId,
    amount: request.amountCents,
    tip: request.tipCents ?? 0,
    status: 'COMPLETED',
    method: 'CREDIT_CARD',
    source: 'TPV',
    splitType: 'FULLPAYMENT',
    staffId,
    referenceNumber: typeof payload.payload.transactionId === 'string' ? payload.payload.transactionId : undefined,
    idempotencyKey: attemptId,
    merchantAccountId: merchantAccount.id,
    paidProductsId: [],
    currency: 'MXN',
    // Codex R1 (P1-4): el webhook NO sabe si la tarjeta es internacional; se deja DESCONOCIDO (sin llave) para que el REST
    // lo acredite después (el JSON existente gana sobre el entrante, así que un `false` inventado habría tapado el `true`).
    customerId: request.customerId ?? undefined,
    reviewRating: request.rating != null ? String(request.rating) : undefined,
    deviceSerialNumber: serial,
    authenticatedTerminalSerial: serial,
    terminalPaymentRequestId: request.requestId,
    registradoVia: 'webhook',
    // Codex R12-1 / R14-1: la tarifa NO viaja aquí — el registrador la resuelve, bajo el candado del intento, desde la PRIMERA
    // evidencia durable del intento (que puede ser un evento anterior a éste); un cobro nacido del webhook nunca captura «ahora».
  }
  const registrador = await import('./payment.tpv.service')
  let resultado: { id: string } & Record<string, unknown>
  try {
    resultado = (
      request.orderId
        ? await registrador.recordOrderPayment(link.venueId, request.orderId, paymentData as any, staffId)
        : await registrador.recordFastPayment(link.venueId, paymentData as any, staffId)
    ) as { id: string } & Record<string, unknown>
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error)
    logger.error('🚨 [AngelPay webhook] El registrador no pudo crear el Payment del webhook — el evento queda PENDING para reintento', {
      correlationId,
      attemptId,
      requestId: request.requestId,
      error: mensaje,
    })
    // Codex R4 (P2): también esta escritura es del DUEÑO — si perdió la propiedad, se contesta el desenlace durable.
    const escritura = await prisma.providerEventLog.updateMany({
      where: { id: eventLogId, ...propietario },
      data: { status: EventStatus.PENDING, errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.PROCESSING_ERROR, lastError: mensaje.slice(0, 500) },
    })
    return desenlaceDurableSiPerdioLaPropiedad(eventLogId, escritura, {
      action: 'ERROR',
      errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.PROCESSING_ERROR,
      eventLogId,
    })
  }

  // Codex R2 (P2): también en un REPLAY (otro eventId) — el retorno idempotente ya no trae la marca transitoria.
  // Codex R5 (P2): y también la COLISIÓN de referencia (R4-6): lo que devuelve el registrador puede ser evidencia de dos tipos.
  const evidencia = tipoDeEvidencia(resultado)
  const esSegundaCaptura = evidencia === 'POSSIBLE_SECOND_CAPTURE'
  const esColision = evidencia === 'POSSIBLE_REFERENCE_COLLISION'
  const filaDespues = await prisma.terminalPaymentRequest.findFirst({
    where: { requestId: request.requestId },
    select: { paymentId: true, closedVia: true },
  })
  const primerConfirmador = evidencia === null && filaDespues?.paymentId === resultado.id && filaDespues?.closedVia === 'webhook'

  // La misma huella del webhook que deja el camino MATCHED, fusionada sobre el JSON VIGENTE (nunca desde una lectura vieja).
  const huella = {
    angelpayWebhook: {
      receivedAt: new Date().toISOString(),
      eventId: rawEventId,
      transactionId: payload.payload.transactionId ?? null,
      integratorReference: attemptId,
      terminalSerial: payload.payload.terminalSerial ?? null,
      timestamp: payload.payload.timestamp ?? null,
      status: payload.payload.status ?? null,
      firstConfirmer: primerConfirmador,
    },
  }
  await prisma.$executeRaw`
    UPDATE "Payment"
    SET "processorData" = CASE WHEN jsonb_typeof("processorData") = 'object' THEN "processorData" ELSE '{}'::jsonb END || CAST(${JSON.stringify(huella)} AS jsonb)
    WHERE "id" = ${resultado.id} AND "venueId" = ${link.venueId}`
  await escribirEventoComoDueno(
    eventLogId,
    propietario,
    {
      status: EventStatus.PROCESSED,
      paymentId: resultado.id,
      venueId: link.venueId,
      errorReason: esSegundaCaptura
        ? ANGELPAY_WEBHOOK_ERROR_REASONS.POSSIBLE_SECOND_CAPTURE
        : esColision
          ? ANGELPAY_WEBHOOK_ERROR_REASONS.POSSIBLE_REFERENCE_COLLISION
          : null,
      processedAt: new Date(),
    },
    { attemptId, requestId: request.requestId, paymentId: resultado.id },
  )
  await prisma.merchantAccount.update({ where: { id: merchantAccount.id }, data: { angelpayWebhookLastReceivedAt: new Date() } })

  if (primerConfirmador) {
    await terminalPaymentService
      .confirmFromWebhook({
        requestId: request.requestId,
        venueId: link.venueId,
        paymentId: resultado.id,
        attemptId,
        amountCents: request.amountCents,
        tipCents: request.tipCents ?? 0,
      })
      .catch(error =>
        logger.error('⚠️ [AngelPay webhook] No se pudo avisar al POS/terminal tras confirmar (el resultado durable ya está en la fila)', {
          requestId: request.requestId,
          error: String(error),
        }),
      )
  }
  const action: AngelPayWebhookAction = esSegundaCaptura
    ? 'SECOND_CAPTURE'
    : esColision
      ? 'REFERENCE_COLLISION'
      : primerConfirmador
        ? 'CONFIRMED'
        : 'MATCHED'
  logger.info(`✅ [AngelPay webhook] ${action} por vínculo`, {
    correlationId,
    attemptId,
    requestId: request.requestId,
    paymentId: resultado.id,
  })
  return { action, eventLogId, paymentId: resultado.id }
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
  // Stamp the venue + receiving merchant AT INSERT: the endpoint identity is the
  // only record of which affiliation actually charged (the payload itself carries
  // no merchant/affiliation), and the backfill needs both to scope its match —
  // an unscoped PENDING event can be stolen by a same-second reference collision
  // from another venue or from the Blumon side.
  const receiverVenueId = await resolveReceiverVenueId(merchantAccount.id)
  // Codex R12-1: la tarifa del negocio se captura AQUÍ, al INGRESO (la primera evidencia bancaria aceptada), y viaja DENTRO del
  // evento durable: si el proceso muere antes de registrar el Payment, S4 recupera el evento y registra con ESTA captura —
  // nunca con la tarifa de horas después. Sólo para un `approved` con venue conocido (un declined no nace como Payment).
  // Codex R14-3: UNA clasificación del estado bancario (`clasificarEstadoBancario`) — una aprobación con mayúsculas o espacios
  // se captura igual que `approved`; `null` presente, un número o un objeto no son aprobación y no se captura.
  const tarifaCongeladaAlIngreso =
    receiverVenueId && clasificarEstadoBancario(payload.payload.status) === 'APROBADO'
      ? await capturarTarifaAlIngreso(receiverVenueId, merchantAccount.id)
      : null
  const stampedPayload = {
    ...payload,
    _avoqado: { receivedByMerchantAccountId: merchantAccount.id, ...(tarifaCongeladaAlIngreso ? { tarifaCongeladaAlIngreso } : {}) },
  }
  let eventLogId: string
  const receptorToken = randomUUID()
  // S7: evidencia POR INTENTO — un `declined` queda apuntando al vínculo, y S6 puede listarla.
  // Codex R6-2: la MISMA llave canónica al persistir, al bloquear y al consultar (ver `candadoDeIntento.ts`).
  const llaveDelIntento = llaveDeIntento(payload.payload.integratorReference)
  try {
    eventLogId = await ingresarEventoDelIntento(llaveDelIntento, (tx, marca) =>
      tx.providerEventLog.create({
        data: {
          provider: ProviderType.PAYMENT_PROCESSOR,
          eventId: eventLogId_key,
          type: payload.event_type,
          // Codex R15-1: un ingreso por el FALLBACK (55P03) lleva la marca durable DENTRO del evento, junto a la captura.
          payload: (marca
            ? { ...stampedPayload, _avoqado: { ...stampedPayload._avoqado, ...marca } }
            : stampedPayload) as unknown as Prisma.InputJsonValue,
          venueId: receiverVenueId,
          status: EventStatus.PENDING,
          // Codex R1 (P2): el receptor también escribe COMO DUEÑO. Su token vive en la fila; si pasan sus 60 s y el worker
          // reclama el evento (token nuevo), las escrituras tardías del receptor no aplican.
          claimToken: receptorToken,
          attemptId: llaveDelIntento,
          // S4: el receptor inmediato tiene 60 s de exclusiva; el worker sólo toma lo que sigue PENDING después.
          nextAttemptAt: new Date(Date.now() + RECEIVER_FIRST_WINDOW_MS),
        },
        select: { id: true },
      }),
    )
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

  // El receptor reconcilia con el MISMO payload que quedó persistido (con la captura del ingreso): S4 leerá ese mismo objeto.
  return reconciliarEventoPendiente({
    payload: stampedPayload as unknown as AngelPayWebhookPayload,
    eventLogId,
    rawEventId,
    merchantAccount,
    receiverVenueId,
    correlationId,
    retryDelaysMs: args.retryDelaysMs,
    claimToken: receptorToken,
  })
}

/**
 * Codex R12-1: captura de la tarifa al ingreso del webhook. Nunca lanza: una captura que ni siquiera pudo intentarse queda como
 * marcador TOTAL (durable, en el evento), y el costo del Payment que nazca de este evento queda pendiente con motivo.
 */
/**
 * Codex R14-1: el INGRESO de un evento del intento va SERIALIZADO con la decisión durable del Payment — toma el candado del
 * intento (el mismo que el registrador REST, S1, la consolidación y los escritores débiles) y, bajo él, fecha el evento
 * ESTRICTAMENTE después del último del mismo intento (`createdAt` = max(ahora, último + 1 ms)): el orden durable `(createdAt, id)`
 * con el que se elige la PRIMERA evidencia no depende del reloj de inicio de una transacción que esperó el candado, y un evento
 * publicado después nunca se ordena antes. Quien llega segundo ve lo que el primero dejó commiteado: si el REST ya creó el
 * Payment bajo el candado, el evento que esperó se sella sobre ÉL (su captura no gobierna); si el evento entró primero, el REST
 * que espera lo ve y consume su captura.
 *
 * Si la espera del candado vence (un dueño anómalo lo retiene más que el presupuesto), la evidencia NO se pierde: se inserta sin
 * serializar, con 🚨 — perder el evento durable del banco sería peor que una decisión de tarifa no serializada (que además queda
 * visible: el snapshot del Payment y la captura del evento se pueden contrastar). Sin llave de intento no hay con quién serializar.
 */
async function ingresarEventoDelIntento(
  llaveDelIntento: string | null,
  insertar: (tx: Prisma.TransactionClient, marca?: MarcaDeIngresoSinCandado) => Promise<{ id: string }>,
): Promise<string> {
  if (!llaveDelIntento) return (await insertar(prisma as unknown as Prisma.TransactionClient)).id
  try {
    return await prisma.$transaction(async tx => {
      await candadoDeIntento(tx, llaveDelIntento)
      // Codex R15-1: lo que entró SIN candado se ordena PRIMERO (bajo el candado): el evento nuevo nace después de ello.
      await ordenarIngresosPendientesBajoCandado(tx, llaveDelIntento)
      // (El marcador SQL identifica esta transacción como el INGRESO para las pruebas que instrumentan el candado del intento.)
      const [ultimo] = await tx.$queryRaw<{ max: Date | null }[]>`
        SELECT max("createdAt") AS max FROM "ProviderEventLog" /* ingreso del intento */
        WHERE "provider" = 'PAYMENT_PROCESSOR' AND "attemptId" = ${llaveDelIntento}`
      const ahora = Date.now()
      const createdAt = new Date(ultimo?.max ? Math.max(ahora, ultimo.max.getTime() + 1) : ahora)
      const creado = await insertar(tx)
      await tx.providerEventLog.update({ where: { id: creado.id }, data: { createdAt } })
      return creado.id
    }, OPCIONES_DE_TRANSACCION_DEL_INTENTO)
  } catch (error) {
    if (!esEsperaDeCandadoVencida(error)) throw error
    // Codex R15-1: la evidencia se conserva, pero MARCADA — su posición histórica no es demostrable, así que ninguna evidencia
    // del intento acreditará la tarifa (`ORDEN_NO_ACREDITADO`) hasta una acreditación explícita; la recuperación (bajo el
    // candado, en el siguiente ingreso o en S4) le dará un orden de RECUPERACIÓN sin quitar la marca.
    logger.error(
      '🚨 [AngelPay webhook] La espera del candado del intento venció al INGRESAR el evento: se persiste SIN serializar y MARCADO (ingreso sin candado) — la tarifa del intento queda sin acreditar hasta una acreditación explícita',
      {
        attemptId: llaveDelIntento,
        error: error instanceof Error ? error.message : String(error),
      },
    )
    return (
      await insertar(prisma as unknown as Prisma.TransactionClient, {
        [MARCA_INGRESO_SIN_CANDADO]: { en: new Date().toISOString() },
      })
    ).id
  }
}

/** Codex R15-1: la marca durable (dentro de `_avoqado`) con la que nace un evento ingresado por el fallback. */
type MarcaDeIngresoSinCandado = { [MARCA_INGRESO_SIN_CANDADO]: { en: string } }

/**
 * Codex R15-1: RECUPERACIÓN de los ingresos sin candado del intento, BAJO el candado del intento (el llamador ya lo tomó como
 * primera sentencia). Cada evento marcado y todavía sin `ordenadoEn` se fecha estrictamente DESPUÉS de todo lo del intento
 * (`max(createdAt) + 1 ms`, en orden de `id`, uno tras otro — nunca con el reloj: un evento anterior fechado en el futuro
 * seguiría antes) y se sella `ordenadoEn`. La marca se CONSERVA: un orden de recuperación no demuestra la prioridad histórica,
 * y el selector sigue tratándola como incertidumbre. Idempotente (sin pendientes no escribe nada). Alcance: por proveedor e
 * intento (la llave del intento, la misma del candado), sin predicado de venue — el selector de la evidencia sí filtra por venue
 * (Codex R16, precisión documental).
 */
async function ordenarIngresosPendientesBajoCandado(tx: Prisma.TransactionClient, llave: string): Promise<number> {
  const marca = Prisma.raw(`'${MARCA_INGRESO_SIN_CANDADO}'`)
  const pendientes = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "ProviderEventLog" /* ingresos sin candado */
    WHERE "provider" = 'PAYMENT_PROCESSOR' AND "attemptId" = ${llave}
      AND jsonb_typeof("payload"->'_avoqado'->${marca}) = 'object'
      AND ("payload"->'_avoqado'->${marca}->'ordenadoEn') IS NULL
    ORDER BY "id" ASC
    FOR UPDATE`
  if (pendientes.length === 0) return 0
  const [ultimo] = await tx.$queryRaw<{ max: Date | null }[]>`
    SELECT max("createdAt") AS max FROM "ProviderEventLog"
    WHERE "provider" = 'PAYMENT_PROCESSOR' AND "attemptId" = ${llave}`
  // Los pendientes son del intento: el máximo nunca es nulo; si lo fuera, el evento conserva su fecha (+1 ms desde 0 sería 1970).
  let base = ultimo?.max ? ultimo.max.getTime() : null
  const ordenadoEn = new Date().toISOString()
  const ruta = Prisma.raw(`'{_avoqado,${MARCA_INGRESO_SIN_CANDADO},ordenadoEn}'`)
  for (const { id } of pendientes) {
    if (base === null) {
      const [propio] = await tx.$queryRaw<{ createdAt: Date }[]>`SELECT "createdAt" FROM "ProviderEventLog" WHERE "id" = ${id}`
      base = propio.createdAt.getTime()
    }
    base += 1
    await tx.$executeRaw`
      UPDATE "ProviderEventLog"
      SET "createdAt" = ${utcTs(new Date(base))},
          "payload" = jsonb_set("payload", ${ruta}::text[], to_jsonb(${ordenadoEn}::text), true)
      WHERE "id" = ${id}`
  }
  logger.warn(
    '⚠️ [AngelPay webhook] Ingresos sin candado ORDENADOS bajo el candado del intento (orden de RECUPERACIÓN; la marca se conserva y la tarifa sigue sin acreditar)',
    { attemptId: llave, eventLogIds: pendientes.map(p => p.id), ordenadoEn },
  )
  return pendientes.length
}

/**
 * Codex R15-1: la recuperación desde S4, en transacción PROPIA — el claim del worker usa `FOR UPDATE SKIP LOCKED` sin candado del
 * intento, y el orden de adquisición es intento → eventos: NUNCA se toma el intento después de un evento dentro de la misma
 * transacción. Candado del intento PRIMERO; después se revalida el claim (si el token ya no es el vigente, otro dueño hará la
 * recuperación: no se ordena nada); después se ordena. Sin pendientes no toma el candado (fast path fuera de toda transacción).
 */
export async function ordenarIngresosSinCandado(args: {
  llave: unknown
  eventLogId: string
  claimToken: string
}): Promise<{ ordenados: number }> {
  const llave = llaveDeIntento(args.llave)
  if (!llave) return { ordenados: 0 }
  const marca = Prisma.raw(`'${MARCA_INGRESO_SIN_CANDADO}'`)
  const [hayPendientes] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "ProviderEventLog"
    WHERE "provider" = 'PAYMENT_PROCESSOR' AND "attemptId" = ${llave}
      AND jsonb_typeof("payload"->'_avoqado'->${marca}) = 'object'
      AND ("payload"->'_avoqado'->${marca}->'ordenadoEn') IS NULL
    LIMIT 1`
  if (!hayPendientes) return { ordenados: 0 }
  const ordenados = await prisma.$transaction(async tx => {
    await candadoDeIntento(tx, llave)
    const [propio] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "ProviderEventLog" /* reclamo vigente */
      WHERE "id" = ${args.eventLogId} AND "claimToken" = ${args.claimToken} AND "status" = 'PENDING'`
    if (!propio) return 0
    return ordenarIngresosPendientesBajoCandado(tx, llave)
  }, OPCIONES_DE_TRANSACCION_DEL_INTENTO)
  return { ordenados }
}

/** `lock_timeout` vencido (55P03) — el único fallo que autoriza el ingreso sin serializar; cualquier otro se propaga. */
function esEsperaDeCandadoVencida(error: unknown): boolean {
  const texto = error instanceof Error ? error.message : String(error)
  const codigo = (error as { meta?: { code?: unknown } } | null)?.meta?.code
  return codigo === '55P03' || /55P03|lock timeout|canceling statement due to lock timeout/i.test(texto)
}

async function capturarTarifaAlIngreso(venueId: string, merchantAccountId: string): Promise<TarifaCapturadaAlIngreso> {
  const ahora = new Date()
  try {
    return await tarifaCongeladaDeLaAfiliacion(venueId, merchantAccountId, ahora)
  } catch (error) {
    logger.warn('⚠️ [AngelPay webhook] No se pudo congelar la tarifa al ingreso del evento; el costo quedará pendiente', {
      venueId,
      merchantAccountId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { slot: null, pricing: tarifaConCapturaFallida(merchantAccountId, ahora, error) }
  }
}

/**
 * Codex R3 (P2): una escritura final del dueño que ya PERDIÓ la propiedad del evento (el worker lo reclamó con otro token,
 * o el backfill del REST lo cerró) afecta cero filas; contestar entonces «huérfano» sería otra verdad que la durable. Se
 * comprueba el resultado del CAS y, si no aplicó, se contesta con el desenlace DURABLE del evento.
 */
async function desenlaceDurableSiPerdioLaPropiedad(
  eventLogId: string,
  escritura: { count?: number } | null | undefined,
  siAplico: AngelPayWebhookResult,
): Promise<AngelPayWebhookResult> {
  if (!escritura || typeof escritura.count !== 'number' || escritura.count === 1) return siAplico
  const durable = await prisma.providerEventLog.findFirst({
    where: { id: eventLogId },
    select: { status: true, paymentId: true, errorReason: true },
  })
  if (!durable) return siAplico
  logger.warn(
    '🪝 [AngelPay webhook] el dueño perdió la propiedad del evento antes de su escritura final — se contesta el desenlace DURABLE',
    {
      eventLogId,
      status: durable.status,
      paymentId: durable.paymentId,
      errorReason: durable.errorReason,
    },
  )
  if (durable.status === EventStatus.PROCESSED && durable.paymentId) {
    return {
      action:
        durable.errorReason === 'POSSIBLE_SECOND_CAPTURE'
          ? 'SECOND_CAPTURE'
          : durable.errorReason === 'POSSIBLE_REFERENCE_COLLISION'
            ? 'REFERENCE_COLLISION'
            : 'MATCHED',
      eventLogId,
      paymentId: durable.paymentId,
      errorReason: durable.errorReason ?? undefined,
      message: 'RESOLVED_BY_ANOTHER_OWNER',
    }
  }
  if (durable.status === EventStatus.ERROR) {
    return {
      action: durable.errorReason === ANGELPAY_WEBHOOK_ERROR_REASONS.AMOUNT_MISMATCH ? 'DISCREPANCY' : 'ERROR',
      eventLogId,
      paymentId: durable.paymentId ?? undefined,
      errorReason: durable.errorReason ?? undefined,
      message: 'RESOLVED_BY_ANOTHER_OWNER',
    }
  }
  return { ...siAplico, errorReason: durable.errorReason ?? siAplico.errorReason, message: 'OWNED_BY_ANOTHER_WRITER' }
}

/**
 * Codex R4-5: el vínculo S1 de un intento acaba de hacerse durable. Todo evento `approved` de ESE intento que el matcher
 * DÉBIL ya atribuyó a OTRO Payment (uno cuya llave no es este intento) se REABRE: vuelve a PENDING con
 * `LINK_ARRIVED_AFTER_WEAK_MATCH`, sin Payment y listo para el worker, que lo confirmará por el vínculo (S2). El Payment
 * equivocado conserva la huella del webhook como REVOCADA (`angelpayWebhookRevoked`) — nunca se borra evidencia. Toma el
 * candado de esos eventos: así se serializa con un matcher débil que esté decidiendo en este mismo instante.
 */
export async function recuperarEventosDebilesPorVinculo(
  attemptId: string,
  requestId: string,
  db?: Prisma.TransactionClient,
): Promise<{ reabiertos: number }> {
  const llave = typeof attemptId === 'string' ? attemptId.trim() : ''
  if (!llave) return { reabiertos: 0 }
  // Codex R5-5: DENTRO de la transacción del vínculo cuando la llama `handleAttemptOpenedFromSocket` (no hay vínculo sin
  // reapertura); con transacción propia cuando se repite sobre un vínculo ya durable (idempotente).
  const reabiertos = db
    ? await reabrirEventosDebiles(db, llave, requestId)
    : await prisma.$transaction(tx => reabrirEventosDebiles(tx, llave, requestId), OPCIONES_DE_TRANSACCION_DEL_INTENTO)
  return { reabiertos }
}

async function reabrirEventosDebiles(tx: Prisma.TransactionClient, llave: string, requestId: string): Promise<number> {
  // Codex R6-2: exclusión por intento PRIMERO (reentrante dentro de la transacción del vínculo, que ya la tomó); después
  // TODOS los eventos del intento en `(createdAt, id)`; después los Payments implicados, DISTINTOS y en `id ASC` con
  // `FOR NO KEY UPDATE` — dos reaperturas de intentos distintos con Payments compartidos en orden inverso ya no pueden
  // interbloquearse — y sólo entonces se relee la identidad de cada Payment y se revoca/reabre.
  await candadoDeIntento(tx, llave)
  const bloqueados = await tx.$queryRaw<
    {
      id: string
      eventId: string
      paymentId: string | null
      status: string
      errorReason: string | null
      transactionId: string | null
      estadoBancario: EstadoBancario
      attempts: number
      nextAttemptAt: Date | null
      rearmado: boolean
    }[]
  >`
    SELECT "id", "eventId", "paymentId", "status"::text AS "status", "errorReason",
           "payload"->'payload'->>'transactionId' AS "transactionId",
           ${estadoBancarioSql(Prisma.sql`"payload"->'payload'->'status'`)} AS "estadoBancario",
           "attempts", "nextAttemptAt",
           ("payload"->'_avoqado'->'rearmadoPorVinculo') IS NOT NULL AS "rearmado"
    FROM "ProviderEventLog" /* evento */
    WHERE "provider" = 'PAYMENT_PROCESSOR' AND "attemptId" = ${llave} AND "eventId" LIKE 'angelpay-%'
    ORDER BY "createdAt" ASC, "id" ASC
    FOR UPDATE`
  const recuperables = bloqueados.filter(
    e =>
      !!e.paymentId &&
      (e.status === EventStatus.PROCESSED ||
        (e.status === EventStatus.ERROR && e.errorReason === ANGELPAY_WEBHOOK_ERROR_REASONS.AMOUNT_MISMATCH)),
  )
  const idsDePago = [...new Set(recuperables.map(e => e.paymentId as string))].sort()
  const pagos = idsDePago.length
    ? await tx.$queryRaw<{ id: string; idempotencyKey: string | null }[]>`
        SELECT "id", "idempotencyKey" FROM "Payment" /* reapertura */
        WHERE "id" IN (${Prisma.join(idsDePago)})
        ORDER BY "id" ASC
        FOR NO KEY UPDATE`
    : []
  const identidad = new Map(pagos.map(p => [p.id, p.idempotencyKey]))
  let n = 0
  const ahora = new Date()
  /**
   * Codex R12-11: el rearme del PRESUPUESTO es UNA sola vez por evento (marcador durable `_avoqado.rearmadoPorVinculo` en el
   * payload): repetir el vínculo (ALREADY_LINKED) adelanta lo que haga falta, pero nunca vuelve a regalar los 40 intentos.
   */
  const marcarRearme = (evento: { id: string; attempts: number }) => tx.$executeRaw`
    UPDATE "ProviderEventLog"
    SET "payload" = "payload" || jsonb_build_object('_avoqado',
      COALESCE("payload"->'_avoqado', '{}'::jsonb) || jsonb_build_object('rearmadoPorVinculo',
        jsonb_build_object('at', ${ahora.toISOString()}::text, 'requestId', ${requestId}::text, 'attemptsAntes', ${evento.attempts}::int)))
    WHERE "id" = ${evento.id}`
  for (const evento of bloqueados) {
    // Codex R12-11: nueva evidencia FUERTE (el vínculo) rearma, de forma idempotente, la evidencia approved del intento que
    // el worker ya no iba a mirar. Sólo approved (o sin estado): un rechazo bancario (NOT_APPROVED), un LINK_*_MISMATCH o la
    // discrepancia por identidad FUERTE nunca se reactivan.
    // Codex R14-3: la clasificación compartida, en SQL (tipo JSON + trim como JS): AUSENTE (legacy) o APROBADO rearman; un
    // RECHAZADO o un INVALIDO (`null` presente, número, objeto, vacío) nunca.
    const approved = evento.estadoBancario === 'AUSENTE' || evento.estadoBancario === 'APROBADO'
    if (approved && evento.status === EventStatus.PENDING && !evento.paymentId) {
      // (a) PENDING con `nextAttemptAt` en el futuro (backoff / exclusión del receptor): se ADELANTA. Idempotente.
      if (!evento.nextAttemptAt || evento.nextAttemptAt.getTime() > ahora.getTime()) {
        await tx.providerEventLog.updateMany({ where: { id: evento.id, status: EventStatus.PENDING }, data: { nextAttemptAt: ahora } })
        n++
        logger.info('🔁 [AngelPay webhook] Evento PENDING adelantado al llegar el vínculo del intento', {
          eventLogId: evento.id,
          attemptId: llave,
          requestId,
        })
      }
      continue
    }
    if (
      approved &&
      evento.status === EventStatus.ERROR &&
      evento.errorReason === RETRIES_EXHAUSTED &&
      !evento.paymentId &&
      !evento.rearmado
    ) {
      // (b) AGOTADO sin Payment: vuelve a PENDING con el presupuesto en cero, una sola vez.
      await marcarRearme(evento)
      await tx.providerEventLog.update({
        where: { id: evento.id },
        data: {
          status: EventStatus.PENDING,
          errorReason: 'LINK_ARRIVED_AFTER_EXHAUSTION',
          attempts: 0,
          processedAt: null,
          nextAttemptAt: ahora,
          claimToken: null,
          leaseUntil: null,
        },
      })
      n++
      logger.warn('🔁 [AngelPay webhook] Evento con los intentos AGOTADOS rearmado al llegar el vínculo del intento', {
        eventLogId: evento.id,
        attemptId: llave,
        requestId,
        attemptsAntes: evento.attempts,
      })
      continue
    }
    // Dos decisiones DÉBILES son recuperables: el sello MATCHED (PROCESSED sobre otro Payment) y la DISCREPANCIA de importe
    // contra otro Payment (ERROR/AMOUNT_MISMATCH con paymentId). Codex R6-3: la discrepancia se juzgó contra un Payment que no
    // era el del intento; con el vínculo, el importe se juzga contra el CONTRATO de la solicitud. Un rechazo bancario
    // (NOT_APPROVED), un LINK_*_MISMATCH o la discrepancia por identidad FUERTE (PENDING, sin paymentId) NO se tocan.
    const selladoDebil = evento.status === EventStatus.PROCESSED && !!evento.paymentId
    const discrepanciaDebil =
      evento.status === EventStatus.ERROR && evento.errorReason === ANGELPAY_WEBHOOK_ERROR_REASONS.AMOUNT_MISMATCH && !!evento.paymentId
    if (!selladoDebil && !discrepanciaDebil) continue
    // Identidad releída BAJO el candado del Payment (nunca del objeto leído antes de esperar).
    if (!identidad.has(evento.paymentId as string)) continue
    const pago = { id: evento.paymentId as string, idempotencyKey: identidad.get(evento.paymentId as string) ?? null }
    if (pago.idempotencyKey === llave) continue
    // Sellado por identidad DÉBIL sobre otro cobro: se reabre y se revoca la huella en el Payment equivocado.
    // Codex R5 (P2): la revocación es POR IDENTIDAD — sólo si la huella VIGENTE es la de ESTE evento (`eventId`; una huella
    // vieja sin `eventId` cuenta si su `integratorReference` es esta llave). La huella de OTRO evento (el webhook propio de
    // ese Payment, llegado después) se queda. Cada revocación se APILA en `angelpayWebhookRevocations` y
    // `angelpayWebhookRevoked` conserva la última: dos reaperturas no se pisan.
    const rawEventId = evento.eventId.replace(/^angelpay-/, '')
    const datos = Prisma.sql`(CASE WHEN jsonb_typeof("processorData") = 'object' THEN "processorData" ELSE '{}'::jsonb END)`
    const huella = selladoDebil ? 'angelpayWebhook' : 'angelpayDiscrepancy'
    const revocacion = Prisma.sql`jsonb_build_object(
      'revokedAt', ${new Date().toISOString()}::text,
      'reason', 'LINK_ARRIVED_AFTER_WEAK_MATCH',
      'attemptId', ${llave}::text,
      'requestId', ${requestId}::text,
      'eventLogId', ${evento.id}::text,
      'eventId', ${rawEventId}::text,
      'previous', COALESCE(${datos}->${huella}, 'null'::jsonb))`
    const revocadas = selladoDebil
      ? await tx.$executeRaw`
      UPDATE "Payment"
      SET "processorData" = (${datos} - 'angelpayWebhook')
        || jsonb_build_object(
             'angelpayWebhookRevoked', ${revocacion},
             'angelpayWebhookRevocations', COALESCE(${datos}->'angelpayWebhookRevocations', '[]'::jsonb) || jsonb_build_array(${revocacion}))
      WHERE "id" = ${pago.id}
        AND (
          ${datos}->'angelpayWebhook'->>'eventId' = ${rawEventId}
          OR (${datos}->'angelpayWebhook'->>'eventId' IS NULL AND ${datos}->'angelpayWebhook'->>'integratorReference' = ${llave})
        )`
      : await tx.$executeRaw`
      UPDATE "Payment"
      SET "processorData" = (${datos} - 'angelpayDiscrepancy')
        || jsonb_build_object(
             'angelpayDiscrepancyRevoked', ${revocacion},
             'angelpayDiscrepancyRevocations', COALESCE(${datos}->'angelpayDiscrepancyRevocations', '[]'::jsonb) || jsonb_build_array(${revocacion}))
      WHERE "id" = ${pago.id}
        AND (
          ${datos}->'angelpayDiscrepancy'->>'eventId' = ${rawEventId}
          OR (${datos}->'angelpayDiscrepancy'->>'eventId' IS NULL AND ${datos}->'angelpayDiscrepancy'->>'transactionId' IS NOT DISTINCT FROM ${evento.transactionId})
        )`
    // Codex R12-11: la reapertura también rearma el presupuesto (una sola vez): un sello débil terminado en el intento 40
    // volvía a PENDING y el worker lo devolvía a ERROR/RETRIES_EXHAUSTED en el acto.
    const rearmarPresupuesto = !evento.rearmado
    if (rearmarPresupuesto) await marcarRearme(evento)
    await tx.providerEventLog.update({
      where: { id: evento.id },
      data: {
        status: EventStatus.PENDING,
        errorReason: 'LINK_ARRIVED_AFTER_WEAK_MATCH',
        paymentId: null,
        processedAt: null,
        nextAttemptAt: ahora,
        claimToken: null,
        leaseUntil: null,
        ...(rearmarPresupuesto ? { attempts: 0 } : {}),
      },
    })
    n++
    logger.warn('🔁 [AngelPay webhook] Evento decidido por identidad DÉBIL sobre otro Payment: REABIERTO al llegar el vínculo', {
      eventLogId: evento.id,
      attemptId: llave,
      requestId,
      paymentIdRevocado: pago.id,
      decision: selladoDebil ? 'MATCHED' : 'DISCREPANCY',
      huellaRevocada: revocadas === 1,
    })
  }
  return n
}

/**
 * S4: todo lo que pasa DESPUÉS de dejar el evento PENDING — matching, cruce de comercio, confirmación por vínculo (S2),
 * o dejarlo pendiente. Lo usan el receptor inmediato (sin token) y el WORKER (con su token de dueño): las escrituras
 * finales llevan `propietario` en el `where`, así un lease vencido y reclamado por otro worker no puede pisar el estado.
 */
export async function reconciliarEventoPendiente(args: {
  payload: AngelPayWebhookPayload
  eventLogId: string
  rawEventId: string
  merchantAccount: { id: string; externalMerchantId: string }
  receiverVenueId: string | null
  correlationId: string
  retryDelaysMs?: number[]
  claimToken?: string | null
}): Promise<AngelPayWebhookResult> {
  const { payload, eventLogId, rawEventId, merchantAccount, receiverVenueId, correlationId, retryDelaysMs } = args
  const propietario = args.claimToken ? { claimToken: args.claimToken } : {}
  // Bail: only reconcile approved transactions (AngelPay sends lowercase). Codex R13-4: clasificación EXPLÍCITA — un rechazo
  // legible cierra como NOT_APPROVED; un estado PRESENTE pero ilegible conserva la evidencia PENDING con motivo (nunca se
  // reconcilia ni se crea dinero con él); el campo AUSENTE sigue siendo la compatibilidad legacy de siempre.
  const estadoBancario = clasificarEstadoBancario(payload.payload.status)
  if (estadoBancario === 'RECHAZADO') {
    await prisma.providerEventLog.updateMany({
      where: { id: eventLogId, ...propietario },
      data: { status: EventStatus.ERROR, errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.NOT_APPROVED, processedAt: new Date() },
    })
    return { action: 'NOT_APPROVED', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.NOT_APPROVED, eventLogId }
  }
  if (estadoBancario === 'INVALIDO') {
    await prisma.providerEventLog.updateMany({
      where: { id: eventLogId, ...propietario },
      data: { status: EventStatus.PENDING, errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.INVALID_STATUS },
    })
    logger.error('🚨 [AngelPay webhook] estado bancario presente pero ilegible — evidencia pendiente con motivo, no se reconcilia', {
      correlationId,
      eventLogId,
      tipo: typeof payload.payload.status,
    })
    return { action: 'INVALID_STATUS', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.INVALID_STATUS, eventLogId }
  }

  // 3. Bail: no usable matching field
  const hasMatchableField = !!(payload.payload.integratorReference || payload.payload.transactionId)
  if (!hasMatchableField) {
    await prisma.providerEventLog.updateMany({
      where: { id: eventLogId, ...propietario },
      data: { status: EventStatus.ERROR, errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.NO_MATCH_FIELDS, processedAt: new Date() },
    })
    return { action: 'ORPHANED', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.NO_MATCH_FIELDS, eventLogId }
  }

  // Codex R1 (P1-1): la IDENTIDAD EXACTA manda. Con vínculo S1 para `integratorReference`, el evento va DIRECTO a la
  // confirmación por vínculo — nunca al matcher débil: `transactionId`/`referenceNumber` son `yyMMddHHmmss`, dos cobros
  // del mismo segundo colisionan, y el débil habría marcado PROCESSED sobre el Payment de OTRO intento, perdiendo éste.
  const llaveDelIntento = llaveDeIntento(payload.payload.integratorReference) ?? ''
  if (llaveDelIntento) {
    const { terminalPaymentService } = await import('../terminal-payment.service')
    if (await terminalPaymentService.findAttemptLink(llaveDelIntento)) {
      const confirmado = await confirmarPorVinculo({
        payload,
        eventLogId,
        rawEventId,
        merchantAccount,
        receiverVenueId,
        correlationId,
        propietario,
      })
      if (confirmado) return confirmado
    }
  }

  // Codex R5-4: lo que se hace cuando, BAJO el candado, el intento de la llave resultó tener vínculo S1 — igual en las tres
  // ramas débiles (sello, cruce de comercio, discrepancia): se confirma por el vínculo; si eso no crea dinero, el evento
  // queda PENDING/AWAITING_PAYMENT para el worker o el REST.
  const decidirPorElVinculo = async (rama: string): Promise<AngelPayWebhookResult> => {
    logger.warn(
      `🔁 [AngelPay webhook] El vínculo S1 llegó mientras se decidía por identidad débil (${rama}) — se confirma por el VÍNCULO`,
      {
        correlationId,
        attemptId: llaveDelIntento,
      },
    )
    const confirmado = await confirmarPorVinculo({
      payload,
      eventLogId,
      rawEventId,
      merchantAccount,
      receiverVenueId,
      correlationId,
      propietario,
    })
    if (confirmado) return confirmado
    const escritura = await prisma.providerEventLog.updateMany({
      where: { id: eventLogId, ...propietario },
      data: { status: EventStatus.PENDING, errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.AWAITING_PAYMENT },
    })
    return desenlaceDurableSiPerdioLaPropiedad(eventLogId, escritura, {
      action: 'ORPHANED',
      errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.AWAITING_PAYMENT,
      eventLogId,
    })
  }

  // 4. Match
  const payment = await attemptPaymentMatch({ payload, merchantAccountId: merchantAccount.id, retryDelaysMs })

  if (!payment) {
    // Second chance WITHOUT the merchant filter: same venue, ANGELPAY merchants
    // only, amount to the cent. A hit here means the charge went through THIS
    // endpoint's affiliation but the TPV recorded a sibling merchant — the exact
    // cross-merchant failure. Reconcile it (the money is real) but flag it LOUDLY instead
    // of letting the backfill absorb it in silence.
    const crossMatch = await attemptCrossMerchantMatch({
      payload,
      receiverMerchantAccountId: merchantAccount.id,
      receiverVenueId,
    })
    if (crossMatch) {
      const crossWebhookAmount = Number(payload.payload.amount) / 100
      // Codex R5-4: también el cruce de comercio es identidad DÉBIL — se escribe bajo el candado del evento y sólo si el
      // intento sigue sin vínculo S1; con vínculo, se confirma por él.
      const cruzado = await escribirPorIdentidadDebil({
        eventLogId,
        llaveDelIntento: llaveDelIntento || null,
        reclamo: propietario,
        data: {
          status: EventStatus.PROCESSED,
          errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.MERCHANT_MISMATCH,
          paymentId: crossMatch.id,
          venueId: crossMatch.venueId,
          processedAt: new Date(),
        },
        paymentId: crossMatch.id,
        parche: {
          angelpayWebhook: {
            receivedAt: new Date().toISOString(),
            eventId: rawEventId,
            transactionId: payload.payload.transactionId ?? null,
            integratorReference: payload.payload.integratorReference ?? null,
            terminalSerial: payload.payload.terminalSerial ?? null,
            timestamp: payload.payload.timestamp ?? null,
            status: payload.payload.status ?? null,
            merchantMismatch: true,
            receivedByMerchantAccountId: merchantAccount.id,
            recordedMerchantAccountId: crossMatch.merchantAccountId,
          },
        },
      })
      if (cruzado.vinculado) return await decidirPorElVinculo('cruce de comercio')
      if (cruzado.escritura.count !== 1) {
        return desenlaceDurableSiPerdioLaPropiedad(eventLogId, cruzado.escritura, {
          action: 'MATCHED_WRONG_MERCHANT',
          errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.MERCHANT_MISMATCH,
          eventLogId,
          paymentId: crossMatch.id,
        })
      }
      await prisma.merchantAccount.update({
        where: { id: merchantAccount.id },
        data: { angelpayWebhookLastReceivedAt: new Date() },
      })
      logMerchantMismatchActivity({
        paymentId: crossMatch.id,
        venueId: crossMatch.venueId,
        referenceNumber: payload.payload.transactionId ?? null,
        receivedByMerchantAccountId: merchantAccount.id,
        recordedMerchantAccountId: crossMatch.merchantAccountId,
        amount: crossWebhookAmount,
        via: 'webhook-direct',
      })
      logger.error('🚨 [AngelPay webhook] MERCHANT MISMATCH — charged affiliation differs from recorded merchant', {
        correlationId,
        paymentId: crossMatch.id,
        receivedByMerchantAccountId: merchantAccount.id,
        recordedMerchantAccountId: crossMatch.merchantAccountId,
        webhookAmount: crossWebhookAmount,
      })
      return {
        action: 'MATCHED_WRONG_MERCHANT',
        errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.MERCHANT_MISMATCH,
        eventLogId,
        paymentId: crossMatch.id,
      }
    }

    // S2 (checkpoint 1, Codex 13-sep): el webhook como PRIMER confirmador — sólo con correlación EXACTA por el
    // vínculo S1. Si crea (o encuentra) el dinero por el registrador compartido, aquí termina; sin vínculo, el evento
    // queda PENDING/AWAITING_PAYMENT como siempre y lo retoma el worker (S4) o el REST de la terminal.
    const confirmado = await confirmarPorVinculo({
      payload,
      eventLogId,
      rawEventId,
      merchantAccount,
      receiverVenueId,
      correlationId,
      propietario,
    })
    if (confirmado) return confirmado

    // Leave the event PENDING (not terminal ERROR) so reconcile-on-Payment-create
    // can find and reconcile it when the TPV finally records the Payment.
    // AngelPay almost always fires before the cashier dismisses the success screen.
    const escritura = await prisma.providerEventLog.updateMany({
      where: { id: eventLogId, ...propietario },
      data: { status: EventStatus.PENDING, errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.AWAITING_PAYMENT },
    })
    return desenlaceDurableSiPerdioLaPropiedad(eventLogId, escritura, {
      action: 'ORPHANED',
      errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.AWAITING_PAYMENT,
      eventLogId,
    })
  }

  // 5. Reconcile amount
  // Webhook amount is in CENTAVOS (zero-padded string, e.g. "000000000100" = 100 cents = $1.00 MXN).
  // Payment.amount is stored in PESOS (e.g. Decimal("1.00")).
  // Divide by 100 to convert centavos → pesos before comparing.
  const webhookAmount = Number(payload.payload.amount) / 100
  // AngelPay charges the card base + tip, so reconcile against `amount + tipAmount`
  // (not `amount` alone — that mis-flags every tipped payment as a discrepancy).
  const recordedAmount = Number(payment.amount) + Number(payment.tipAmount ?? 0)
  const diff = Math.abs(webhookAmount - recordedAmount)

  if (diff < 0.01) {
    // Codex R4-5: el matcher DÉBIL sólo puede sellar si, BAJO EL CANDADO del evento, el intento sigue sin vínculo S1. Un
    // vínculo que llegó entre la comprobación de arriba y esta escritura convertiría este sello en «PROCESSED sobre el
    // Payment de OTRO cobro del mismo segundo» y el intento real perdería su confirmación. Con vínculo, se confirma por él.
    const sellado = await escribirPorIdentidadDebil({
      eventLogId,
      llaveDelIntento: llaveDelIntento || null,
      reclamo: propietario,
      data: {
        status: EventStatus.PROCESSED,
        paymentId: payment.id,
        venueId: payment.venueId,
        errorReason: null,
        processedAt: new Date(),
      },
      paymentId: payment.id,
      parche: {
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
      },
    })
    if (sellado.vinculado) return await decidirPorElVinculo('sello MATCHED')
    await prisma.merchantAccount.update({
      where: { id: merchantAccount.id },
      data: { angelpayWebhookLastReceivedAt: new Date() },
    })
    logger.info('✅ [AngelPay webhook] matched', { correlationId, paymentId: payment.id, webhookAmount })
    return desenlaceDurableSiPerdioLaPropiedad(eventLogId, sellado.escritura, { action: 'MATCHED', eventLogId, paymentId: payment.id })
  }

  // DISCREPANCY path
  // Codex R5-4: la discrepancia también es identidad DÉBIL (el Payment se eligió por referencia): bajo el candado y sólo
  // sin vínculo S1; con vínculo, el importe se juzga contra el CONTRATO de la solicitud, no contra el Payment ajeno.
  const discrepancia = await escribirPorIdentidadDebil({
    eventLogId,
    llaveDelIntento: llaveDelIntento || null,
    reclamo: propietario,
    data: {
      status: EventStatus.ERROR,
      errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.AMOUNT_MISMATCH,
      paymentId: payment.id,
      venueId: payment.venueId,
      processedAt: new Date(),
    },
    paymentId: payment.id,
    parche: {
      angelpayDiscrepancy: {
        detectedAt: new Date().toISOString(),
        // Codex R6-3: la identidad del evento — una reapertura posterior sólo revoca la discrepancia de SU evento.
        eventId: rawEventId,
        webhookAmount,
        recordedAmount,
        difference: diff,
        transactionId: payload.payload.transactionId ?? null,
      },
    },
  })
  if (discrepancia.vinculado) return await decidirPorElVinculo('discrepancia de importe')
  if (discrepancia.escritura.count !== 1) {
    return desenlaceDurableSiPerdioLaPropiedad(eventLogId, discrepancia.escritura, {
      action: 'DISCREPANCY',
      errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.AMOUNT_MISMATCH,
      eventLogId,
      paymentId: payment.id,
    })
  }
  await prisma.merchantAccount.update({
    where: { id: merchantAccount.id },
    data: { angelpayWebhookLastReceivedAt: new Date() },
  })
  logger.error('❌ [AngelPay webhook] amount discrepancy', { correlationId, paymentId: payment.id, webhookAmount, recordedAmount, diff })
  return { action: 'DISCREPANCY', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.AMOUNT_MISMATCH, eventLogId, paymentId: payment.id }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Reconcile-on-Payment-create (backfill path)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Reconcile-on-Payment-create: AngelPay fires the webhook BEFORE the TPV records
 * the Payment (the cashier may linger on AngelPay's success screen for minutes).
 * So the webhook lands as PENDING/AWAITING_PAYMENT with no Payment to match yet.
 * When the Payment is finally recorded, the /tpv/fast path calls this to find that
 * PENDING webhook and reconcile it — stamping processorData + marking PROCESSED.
 *
 * Fire-and-forget from the caller; never throws (logs + swallows all errors).
 */
export async function reconcileAngelPayWebhookForPayment(payment: {
  id: string
  idempotencyKey: string | null
  referenceNumber: string | null
  venueId: string
  amount: Prisma.Decimal | number | string
  tipAmount: Prisma.Decimal | number | string
  merchantAccountId?: string | null
}): Promise<void> {
  try {
    // Provider guard: this backfill runs on EVERY TPV payment (Blumon included).
    // Blumon and AngelPay both use yyMMddHHmmss references, so a same-second charge
    // on the PAX could steal a pending AngelPay event. Only AngelPay-merchant
    // payments may link angelpay- events. (null merchant = legacy rows, allowed.)
    if (payment.merchantAccountId) {
      const merchant = await prisma.merchantAccount.findUnique({
        where: { id: payment.merchantAccountId },
        select: { provider: { select: { code: true } } },
      })
      if (merchant && merchant.provider?.code !== 'ANGELPAY') return
    }

    const orFilters: Prisma.ProviderEventLogWhereInput[] = []
    if (payment.idempotencyKey) {
      orFilters.push({ payload: { path: ['payload', 'integratorReference'], equals: payment.idempotencyKey } })
    }
    if (payment.referenceNumber) {
      orFilters.push({ payload: { path: ['payload', 'transactionId'], equals: payment.referenceNumber } })
    }
    if (orFilters.length === 0) return

    const pendingEvents = await prisma.providerEventLog.findMany({
      // Codex R3 (P2): acotado — un Payment tiene uno o dos eventos pendientes; el resto lo retoma el worker por su cuenta.
      take: 25,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      where: {
        provider: ProviderType.PAYMENT_PROCESSOR,
        status: EventStatus.PENDING,
        eventId: { startsWith: 'angelpay-' },
        // Codex R12-12: sólo el evento de una VENTA (`send_transaction`, el mismo tipo que reclama el worker) puede ser
        // el webhook de este cobro; un evento de otro tipo con la misma llave se deja a su propio camino.
        type: 'send_transaction',
        OR: orFilters,
        // Venue scope: events stamped since 2026-07 carry the receiver's venue;
        // pre-stamp events have venueId null (legacy) and stay matchable.
        AND: [
          { OR: [{ venueId: payment.venueId }, { venueId: null }] },
          // S4 (Codex): exclusión frente al WORKER — un evento con lease vigente lo está reconciliando su dueño,
          // que va a encontrar este mismo Payment por su llave y a cerrarlo con su token. Pisarlo desde aquí
          // dejaba un PROCESSED escrito por debajo de un reclamo ajeno.
          { OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }] },
        ],
      },
      select: { id: true, eventId: true, payload: true },
    })

    /** Codex R12-12: importe ilegible o no entero en centavos ⇒ el evento queda PENDING con motivo, sin Payment ni huella. */
    const marcarImporteInvalido = async (eventLogId: string, importe: unknown) => {
      await prisma.providerEventLog.updateMany({
        where: { id: eventLogId, status: EventStatus.PENDING },
        data: { errorReason: 'INVALID_AMOUNT' },
      })
      logger.error('🚨 [AngelPay backfill] importe del webhook ilegible o no entero en centavos — no certifica el cobro', {
        paymentId: payment.id,
        eventLogId,
        importe: typeof importe === 'string' ? importe.slice(0, 40) : typeof importe,
      })
    }
    for (const event of pendingEvents) {
      const webhookPayload = event.payload as unknown as AngelPayWebhookPayload
      // Codex R1 (P1-1): un evento con llave FUERTE de OTRO intento no es de este Payment aunque la referencia coincida
      // (misma referencia = mismo segundo, no mismo cobro). Se deja PENDING para su dueño.
      const llaveDelEvento = llaveDeIntento(webhookPayload?.payload?.integratorReference)
      if (llaveDelEvento && llaveDelEvento !== payment.idempotencyKey) {
        // Codex R2 (P1-1): con vínculo S1 para la llave del evento, ese intento tiene DUEÑO (el worker lo confirma por
        // vínculo): ni un Payment con OTRA llave ni uno SIN llave (legacy del mismo segundo) pueden cerrarlo.
        const { terminalPaymentService } = await import('../terminal-payment.service')
        if (payment.idempotencyKey || (await terminalPaymentService.findAttemptLink(llaveDelEvento))) {
          logger.info('🪝 [AngelPay backfill] evento con llave de OTRO intento — no es de este Payment (colisión de referencia)', {
            paymentId: payment.id,
            eventLogId: event.id,
            eventKey: llaveDelEvento,
            paymentKey: payment.idempotencyKey,
          })
          continue
        }
      }
      // Codex R12-12: el backfill verifica ESTADO BANCARIO e IMPORTE antes de clasificar — un declined que quedó PENDING por
      // un corte antes del filtro no puede recibir MATCHED, y un importe ilegible (`Number('abc')` = NaN, que esquivaba las
      // comprobaciones de discrepancia y caía en MATCHED) o no entero en centavos no certifica nada: conserva la evidencia
      // con un motivo específico, sin Payment ni huella. Los campos AUSENTES siguen siendo compatibles (legacy).
      // Codex R13-4: el estado se clasifica EXPLÍCITAMENTE (`clasificarEstadoBancario`): rechazo legible ⇒ ERROR/NOT_APPROVED;
      // estado PRESENTE pero ilegible (número, objeto, vacío, espacios) ⇒ PENDING con `INVALID_STATUS`, sin Payment ni huella —
      // no hay aprobación demostrada; el campo AUSENTE es la compatibilidad legacy autorizada y sigue aparte.
      const estadoBancario = webhookPayload?.payload?.status
      const clasificacion = clasificarEstadoBancario(estadoBancario)
      if (clasificacion === 'INVALIDO') {
        await prisma.providerEventLog.updateMany({
          where: { id: event.id, status: EventStatus.PENDING },
          data: { errorReason: MOTIVO_ESTADO_INVALIDO },
        })
        logger.error(
          '🚨 [AngelPay backfill] estado bancario presente pero ilegible — no certifica el cobro (evidencia pendiente con motivo)',
          {
            paymentId: payment.id,
            eventLogId: event.id,
            tipo: typeof estadoBancario,
          },
        )
        continue
      }
      if (clasificacion === 'RECHAZADO') {
        const cerrado = await prisma.providerEventLog.updateMany({
          where: { id: event.id, status: EventStatus.PENDING, OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }] },
          data: {
            status: EventStatus.ERROR,
            errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.NOT_APPROVED,
            processedAt: new Date(),
            claimToken: null,
            leaseUntil: null,
          },
        })
        logger.warn(
          '🪝 [AngelPay backfill] evento con estado bancario NO aprobado correlacionado con este cobro — evidencia, nunca MATCHED',
          {
            paymentId: payment.id,
            eventLogId: event.id,
            estadoBancario,
            cerrado: cerrado.count === 1,
          },
        )
        continue
      }
      const centavosDelWebhook = Number(webhookPayload?.payload?.amount)
      const importeCrudo = webhookPayload?.payload?.amount
      if (importeCrudo === undefined || importeCrudo === null) {
        // Compatibilidad legacy documentada: sin importe no hay comprobación posible; la clasificación de abajo lo trata
        // como «no comparable» (nunca discrepancia) igual que antes.
      } else if (typeof importeCrudo !== 'string' && typeof importeCrudo !== 'number') {
        await marcarImporteInvalido(event.id, importeCrudo)
        continue
      } else if (String(importeCrudo).trim() === '' || !Number.isInteger(centavosDelWebhook) || centavosDelWebhook < 0) {
        await marcarImporteInvalido(event.id, importeCrudo)
        continue
      }
      const webhookAmount = centavosDelWebhook / 100 // centavos → pesos
      // Compare against base + tip (the full amount charged to the card).
      const recordedAmount = Number(payment.amount) + Number(payment.tipAmount ?? 0)
      const diff = Math.abs(webhookAmount - recordedAmount)

      // Weak-key guard: `transactionId == referenceNumber` is a timestamp-to-the-
      // second, NOT unique — if the amounts disagree on a weak-key-only match this
      // is far more likely a reference collision than a real discrepancy. Skip it
      // (leave the event PENDING for its true owner) instead of stamping the
      // wrong Payment. The integratorReference key is a UUID → always trusted.
      const strongKeyMatch = !!(payment.idempotencyKey && webhookPayload?.payload?.integratorReference === payment.idempotencyKey)
      if (!strongKeyMatch && Number.isFinite(webhookAmount) && diff >= 0.01) {
        logger.warn('🪝 [AngelPay backfill] weak-key match with amount mismatch — skipping (likely reference collision)', {
          paymentId: payment.id,
          eventLogId: event.id,
          webhookAmount,
          recordedAmount,
        })
        continue
      }

      // Codex R1 (P2): el backfill RECLAMA el evento con CAS (sigue PENDING y sin lease vigente) ANTES de estampar el
      // Payment; si el worker lo tomó en medio, no se escribe nada y lo cierra él. La huella va con jsonb sobre el
      // valor VIGENTE del Payment, nunca desde una copia leída antes.
      // Codex R2 (P2): reclamo y huella en UNA transacción (una caída entre las dos no deja el evento terminado sin su
      // evidencia), y el reclamo ESTRENA token de dueño: una escritura tardía del receptor (con su token viejo) no aplica.
      // Codex R5-4: el reclamo va bajo el candado del evento y relee el vínculo S1 de la llave del evento (si no es la llave
      // del propio Payment): con vínculo, el intento tiene dueño y el evento se deja al worker, que lo confirma por él.
      const reclamarYEstampar = async (
        data: Prisma.ProviderEventLogUncheckedUpdateManyInput,
        parche: Record<string, unknown>,
      ): Promise<boolean> => {
        const decision = await escribirPorIdentidadDebil({
          eventLogId: event.id,
          llaveDelIntento: llaveDelEvento && llaveDelEvento !== payment.idempotencyKey ? llaveDelEvento : null,
          reclamo: { status: EventStatus.PENDING, OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }] },
          data: { ...data, claimToken: randomUUID() },
          paymentId: payment.id,
          parche,
        })
        if (decision.vinculado) {
          logger.info(
            '🪝 [AngelPay backfill] el vínculo S1 de la llave del evento llegó mientras se decidía: tiene dueño, se deja al worker',
            {
              paymentId: payment.id,
              eventLogId: event.id,
              eventKey: llaveDelEvento,
              requestId: decision.requestId,
            },
          )
          return false
        }
        if (decision.escritura.count !== 1) {
          logger.info('🪝 [AngelPay backfill] el evento ya no estaba disponible (otro dueño lo reclamó) — no se estampa', {
            paymentId: payment.id,
            eventLogId: event.id,
          })
          return false
        }
        return true
      }

      if (Number.isFinite(webhookAmount) && diff >= 0.01) {
        // Amount discrepancy — mark ERROR/AMOUNT_MISMATCH (reclamo primero), then stamp angelpayDiscrepancy
        const reclamado = await reclamarYEstampar(
          {
            status: EventStatus.ERROR,
            errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.AMOUNT_MISMATCH,
            paymentId: payment.id,
            venueId: payment.venueId,
            processedAt: new Date(),
          },
          {
            angelpayDiscrepancy: {
              detectedAt: new Date().toISOString(),
              eventId: event.eventId?.replace(/^angelpay-/, '') ?? null,
              webhookAmount,
              recordedAmount,
              difference: diff,
              transactionId: webhookPayload?.payload?.transactionId ?? null,
            },
          },
        )
        if (!reclamado) continue
        logger.warn('🪝 [AngelPay backfill] amount discrepancy on reconcile-on-create', {
          paymentId: payment.id,
          webhookAmount,
          recordedAmount,
          diff,
        })
      } else {
        // MATCHED — stamp processorData.angelpayWebhook, mark PROCESSED.
        // Mismatch check: the event carries which merchant's endpoint received it
        // (stamped at insert since 2026-07). If that differs from the merchant the
        // Payment was recorded under, the charge went through another affiliation —
        // reconcile anyway (the money is real) but flag it loudly.
        const receivedBy = ((webhookPayload as unknown as Record<string, unknown>)?._avoqado as Record<string, unknown> | undefined)
          ?.receivedByMerchantAccountId as string | undefined
        const merchantMismatch = !!(receivedBy && payment.merchantAccountId && receivedBy !== payment.merchantAccountId)

        const reclamado = await reclamarYEstampar(
          {
            status: EventStatus.PROCESSED,
            paymentId: payment.id,
            venueId: payment.venueId,
            errorReason: merchantMismatch ? ANGELPAY_WEBHOOK_ERROR_REASONS.MERCHANT_MISMATCH : null,
            processedAt: new Date(),
          },
          {
            angelpayWebhook: {
              receivedAt: new Date().toISOString(),
              // Codex R5 (P2): la huella lleva la IDENTIDAD del evento que la escribió — una revocación posterior sólo puede
              // retirar la huella de SU evento, nunca la de otro.
              eventId: event.eventId?.replace(/^angelpay-/, '') ?? null,
              reconciledVia: 'payment-create-backfill',
              transactionId: webhookPayload?.payload?.transactionId ?? null,
              integratorReference: webhookPayload?.payload?.integratorReference ?? null,
              terminalSerial: webhookPayload?.payload?.terminalSerial ?? null,
              timestamp: webhookPayload?.payload?.timestamp ?? null,
              status: webhookPayload?.payload?.status ?? null,
              ...(merchantMismatch
                ? {
                    merchantMismatch: true,
                    receivedByMerchantAccountId: receivedBy,
                    recordedMerchantAccountId: payment.merchantAccountId ?? null,
                  }
                : {}),
            },
          },
        )
        if (!reclamado) continue
        if (merchantMismatch) {
          logMerchantMismatchActivity({
            paymentId: payment.id,
            venueId: payment.venueId,
            referenceNumber: payment.referenceNumber,
            receivedByMerchantAccountId: receivedBy as string,
            recordedMerchantAccountId: payment.merchantAccountId ?? null,
            amount: recordedAmount,
            via: 'payment-create-backfill',
          })
          logger.error('🚨 [AngelPay backfill] MERCHANT MISMATCH — charged affiliation differs from recorded merchant', {
            paymentId: payment.id,
            eventLogId: event.id,
            receivedByMerchantAccountId: receivedBy,
            recordedMerchantAccountId: payment.merchantAccountId,
          })
        } else {
          logger.info('🪝 [AngelPay backfill] reconciled pending webhook on payment-create', {
            paymentId: payment.id,
            eventLogId: event.id,
          })
        }
      }
    }
  } catch (err) {
    logger.error('🪝 [AngelPay backfill] reconcileAngelPayWebhookForPayment failed', {
      paymentId: payment.id,
      error: err instanceof Error ? err.message : err,
    })
  }
}
