/**
 * Terminal Payment Service
 *
 * Bridges POS HTTP requests (iOS/Android/Desktop) to TPV terminals via Socket.IO.
 * POS sends POST → backend holds connection → emits to terminal →
 * terminal processes payment → emits result → backend resolves HTTP response.
 *
 * Concurrency (arbitration): a physical PAX runs ONE EMV transaction at a time.
 * The durable `TerminalPaymentRequest` row + its partial UNIQUE index on
 * terminalId (active statuses only) is the authoritative per-terminal mutex —
 * correct across process restarts and multiple server instances. The in-memory
 * `pendingPayments` Map is ONLY the transport that resolves the long-poll; it is
 * never the source of truth. Recovery (result lost, restart, TPV crash) is via
 * the row: the TPV's idempotent REST payment-record closes it, and a watchdog
 * reconciles stale rows against the Payment table (holding the slot on UNKNOWN,
 * never freeing it blind — which would risk a double charge).
 * See Avoqado-HQ/specs/2026-07-11-terminal-payment-arbitration.md.
 */

import { v4 as uuidv4 } from 'uuid'
import { Prisma, TerminalPaymentRequestStatus } from '@prisma/client'
import prisma from '../utils/prismaClient'
import { terminalRegistry, normalizeTerminalId } from '../communication/sockets/terminal-registry'
import socketManager from '../communication/sockets/managers/socketManager'
import logger from '../config/logger'
import { TerminalBusyError } from '../errors/AppError'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'

export interface TerminalPaymentRequest {
  terminalId: string
  amountCents: number
  tipCents?: number
  rating?: number
  skipReview?: boolean
  orderId?: string
  venueId: string
  requestedBy: string // userId
  senderDeviceName?: string
  processedByStaffId?: string
  requestId?: string // Client-generated for cancel tracking + idempotency
}

export interface TerminalPaymentResult {
  requestId: string
  status: 'success' | 'failed' | 'cancelled' | 'timeout'
  paymentId?: string
  transactionId?: string
  cardDetails?: {
    lastFour?: string
    brand?: string
    entryMode?: string
  }
  errorMessage?: string
  receipt?: {
    receiptUrl?: string
    receiptAccessKey?: string
  }
}

export interface TerminalPaymentStatus {
  requestId: string
  venueId: string
  terminalId: string
  status: TerminalPaymentRequestStatus
  amount: number // PESOS (major units)
  tip: number // PESOS
  orderId: string | null
  paymentId: string | null
  senderDevice: string | null
  lateResult: boolean
  createdAt: string // ISO
  updatedAt: string // ISO
}

export interface TerminalReceiptPrintRequest {
  terminalId: string
  venueId: string
  requestedBy: string
  requestId?: string
  receipt: Record<string, unknown>
}

export interface TerminalReceiptPrintResult {
  requestId: string
  status: 'success' | 'failed' | 'timeout'
  errorMessage?: string
}

interface PendingPayment {
  resolve: (result: TerminalPaymentResult) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  requestId: string
  terminalId: string
  venueId: string
  createdAt: Date
}

interface PendingReceiptPrint {
  resolve: (result: TerminalReceiptPrintResult) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  requestId: string
  terminalId: string
  venueId: string
  createdAt: Date
}

const PAYMENT_TIMEOUT_MS = 300_000 // 5 minutes
const RECEIPT_PRINT_TIMEOUT_MS = 30_000 // 30 seconds
const CANCEL_GRACE_MS = 30_000 // watchdog grace before a CANCEL_REQUESTED row is resolved

// Statuses that HOLD the per-terminal slot (must match the partial UNIQUE index
// in the migration). UNKNOWN holds the slot on purpose — a terminal whose
// outcome we can't determine may still be mid-charge, so we never free it blind.
const SLOT_HELD: TerminalPaymentRequestStatus[] = [
  TerminalPaymentRequestStatus.PENDING,
  TerminalPaymentRequestStatus.SENT,
  TerminalPaymentRequestStatus.CANCEL_REQUESTED,
  TerminalPaymentRequestStatus.UNKNOWN,
]
// A live request still awaiting its result (subset of SLOT_HELD, excludes UNKNOWN).
const IN_FLIGHT: TerminalPaymentRequestStatus[] = [
  TerminalPaymentRequestStatus.PENDING,
  TerminalPaymentRequestStatus.SENT,
  TerminalPaymentRequestStatus.CANCEL_REQUESTED,
]

function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') ||
    (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002')
  )
}

function resultToStatus(status: TerminalPaymentResult['status']): TerminalPaymentRequestStatus {
  switch (status) {
    case 'success':
      return TerminalPaymentRequestStatus.COMPLETED
    case 'failed':
      return TerminalPaymentRequestStatus.FAILED
    case 'cancelled':
      return TerminalPaymentRequestStatus.CANCELLED
    case 'timeout':
    default:
      return TerminalPaymentRequestStatus.TIMED_OUT
  }
}

/** Reconstruct a client-facing result from a stored row (for idempotent replay). */
function resultFromRow(row: {
  requestId: string
  status: TerminalPaymentRequestStatus
  paymentId: string | null
  resultJson: Prisma.JsonValue | null
}): TerminalPaymentResult {
  if (row.resultJson && typeof row.resultJson === 'object') {
    return row.resultJson as unknown as TerminalPaymentResult
  }
  switch (row.status) {
    case TerminalPaymentRequestStatus.COMPLETED:
      return { requestId: row.requestId, status: 'success', paymentId: row.paymentId ?? undefined }
    case TerminalPaymentRequestStatus.FAILED:
      return { requestId: row.requestId, status: 'failed', errorMessage: 'El cobro falló' }
    case TerminalPaymentRequestStatus.CANCELLED:
      return { requestId: row.requestId, status: 'cancelled', errorMessage: 'Cancelado' }
    case TerminalPaymentRequestStatus.TIMED_OUT:
      return { requestId: row.requestId, status: 'timeout', errorMessage: 'La terminal no respondió a tiempo' }
    case TerminalPaymentRequestStatus.UNKNOWN:
    default:
      return { requestId: row.requestId, status: 'timeout', errorMessage: 'Resultado desconocido — verifica el estado en la terminal' }
  }
}

class TerminalPaymentService {
  private pendingPayments = new Map<string, PendingPayment>()
  private pendingReceiptPrints = new Map<string, PendingReceiptPrint>()

  /**
   * Whether the per-terminal busy REJECTION is enforced. Rollback flag: setting
   * TERMINAL_PAYMENT_LOCK_ENABLED=false stops rejecting concurrent charges
   * (pre-lock behavior) WITHOUT disabling persistence/recovery — the row is
   * still written so the status endpoint and watchdog keep working.
   */
  private isLockEnabled(): boolean {
    return process.env.TERMINAL_PAYMENT_LOCK_ENABLED !== 'false'
  }

  /** Best-effort busy flag for the terminal picker (authoritative gate is the send itself). */
  async isTerminalBusy(terminalId: string): Promise<boolean> {
    const lockKey = normalizeTerminalId(terminalId)
    const active = await prisma.terminalPaymentRequest.findFirst({
      where: { terminalId: lockKey, status: { in: SLOT_HELD } },
      select: { id: true },
    })
    return active !== null
  }

  /** Normalized terminalIds that currently hold a slot for a venue (batch for the picker). */
  async getBusyTerminalIds(venueId: string): Promise<Set<string>> {
    const rows = await prisma.terminalPaymentRequest.findMany({
      where: { venueId, status: { in: SLOT_HELD } },
      select: { terminalId: true },
    })
    return new Set(rows.map(r => r.terminalId))
  }

  /**
   * Send a payment request to a terminal and wait for the result.
   * Returns a Promise that resolves when the terminal responds or times out.
   */
  async sendPaymentToTerminal(request: TerminalPaymentRequest): Promise<TerminalPaymentResult> {
    const { terminalId, venueId } = request

    // Look up terminal (registry normalizes AVQD- prefix automatically)
    const terminalEntry = terminalRegistry.getTerminal(terminalId)
    if (!terminalEntry) {
      logger.error(`❌ [TerminalPayment] Terminal not found in registry`, {
        terminalId,
        registeredTerminals: terminalRegistry.getAllTerminalIds(),
      })
      throw new Error(`La terminal ${terminalId} no está conectada`)
    }
    const socketId = terminalEntry.socketId
    if (!socketId) {
      throw new Error(`La terminal ${terminalId} está registrada pero no tiene conexión de socket. Reinicia la app de la terminal.`)
    }

    // NOTE: a registry socketId can be STALE (terminal dropped ungracefully; the HTTP
    // heartbeat preserves the old id — terminal-registry.ts). The emit below is
    // fire-and-forget, so a dead socket silently no-ops → the POS hangs the full 5 min →
    // watchdog parks the row UNKNOWN → the terminal is stuck-busy until manual reconcile.
    // The real fix is emit-with-ack + timeout (covers BOTH a fully-gone socket and a
    // half-open zombie), version-gated per the arbitration spec — deliberately NOT a
    // pre-INSERT liveness probe, which misses the half-open case we actually observe.

    // Use client-provided requestId if available, otherwise generate one
    const requestId = request.requestId || uuidv4()
    const lockKey = terminalEntry.terminalId // registry stores the normalized id

    // Acquire the durable per-terminal slot by INSERTing the row. The partial
    // UNIQUE index on terminalId (active statuses) is the mutex: a concurrent
    // second active charge fails with P2002 — correct across restarts and
    // multiple server instances, no in-memory lock needed.
    let persisted = true
    try {
      await prisma.terminalPaymentRequest.create({
        data: {
          requestId,
          venueId,
          terminalId: lockKey,
          status: TerminalPaymentRequestStatus.PENDING,
          amountCents: request.amountCents,
          tipCents: request.tipCents ?? 0,
          orderId: request.orderId ?? null,
          requestedById: request.requestedBy ?? null,
          senderDevice: request.senderDeviceName ?? null,
          expiresAt: new Date(Date.now() + PAYMENT_TIMEOUT_MS),
        },
      })
    } catch (err) {
      if (!isPrismaUniqueViolation(err)) throw err
      // Disambiguate WITHOUT parsing meta.target: look up MY requestId.
      // - my row exists  → this requestId collided (replay or in-flight dup)
      // - my row absent  → the terminal slot is held by ANOTHER request → busy
      const mine = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
      if (mine) {
        if ((IN_FLIGHT as string[]).includes(mine.status)) {
          // Same requestId still in flight → do NOT re-emit (would double-charge)
          throw new TerminalBusyError(`Este cobro ya está en proceso en la terminal ${terminalId}`, {
            requestId: mine.requestId,
            amountCents: mine.amountCents,
            senderDevice: mine.senderDevice ?? undefined,
            ageSeconds: Math.max(0, Math.floor((Date.now() - mine.createdAt.getTime()) / 1000)),
          })
        }
        // Terminal (or UNKNOWN) state → idempotent replay of the stored outcome
        logger.info(`♻️ [TerminalPayment] Idempotent replay for requestId`, { requestId, status: mine.status })
        return resultFromRow(mine)
      }
      // Slot held by another request
      const blocker = await prisma.terminalPaymentRequest.findFirst({
        where: { terminalId: lockKey, status: { in: SLOT_HELD } },
        orderBy: { createdAt: 'desc' },
      })
      if (this.isLockEnabled()) {
        logger.warn(`🔒 [TerminalPayment] Terminal busy, rejecting`, {
          lockKey,
          blockerRequestId: blocker?.requestId,
          incomingRequestId: requestId,
        })
        throw new TerminalBusyError(`La terminal ${terminalId} está ocupada procesando otro cobro`, {
          requestId: blocker?.requestId ?? 'unknown',
          amountCents: blocker?.amountCents,
          senderDevice: blocker?.senderDevice ?? undefined,
          ageSeconds: blocker ? Math.max(0, Math.floor((Date.now() - blocker.createdAt.getTime()) / 1000)) : 0,
        })
      }
      // Rollback flag off → don't reject; proceed WITHOUT a persisted row (old behavior).
      persisted = false
      logger.warn(`⚠️ [TerminalPayment] Lock disabled — proceeding without persistence despite busy terminal`, { lockKey, requestId })
    }

    logger.info(`💳 [TerminalPayment] Sending payment request to terminal`, {
      requestId,
      terminalId,
      venueId,
      amountCents: request.amountCents,
      tipCents: request.tipCents,
      orderId: request.orderId,
      persisted,
    })

    const io = socketManager.getServer()
    if (!io) {
      // Never leak the slot if we bail before storing the pending payment.
      if (persisted) await this.closeRow(requestId, { requestId, status: 'failed', errorMessage: 'Servidor no inicializado' })
      throw new Error('Servidor de Socket.IO no inicializado')
    }

    return new Promise<TerminalPaymentResult>((resolve, reject) => {
      // The in-memory timeout only resolves the long-poll (POS gets 'timeout').
      // It does NOT close the DB row — the charge may still have happened, so
      // the watchdog owns the row's fate (reconcile vs Payment, else UNKNOWN).
      const timeout = setTimeout(() => {
        this.pendingPayments.delete(requestId)
        logger.warn(`⏰ [TerminalPayment] Long-poll timed out (row left for watchdog)`, { requestId, terminalId })
        resolve({
          requestId,
          status: 'timeout',
          errorMessage: 'La terminal no respondió en 5 minutos',
        })
      }, PAYMENT_TIMEOUT_MS)

      this.pendingPayments.set(requestId, {
        resolve,
        reject,
        timeout,
        requestId,
        terminalId,
        venueId,
        createdAt: new Date(),
      })

      const paymentPayload = {
        requestId,
        terminalId,
        amountCents: request.amountCents,
        tipCents: request.tipCents ?? 0,
        rating: request.rating,
        skipReview: request.skipReview ?? true,
        orderId: request.orderId,
        senderDeviceName: request.senderDeviceName,
        processedByStaffId: request.processedByStaffId,
        venueId,
        timestamp: new Date().toISOString(),
      }

      io.to(socketId).emit('terminal:payment_request', paymentPayload)
      logger.info(`📡 [TerminalPayment] Emitted to socket ${socketId}`, { requestId, terminalId })
    })
  }

  /**
   * Handle payment result from a terminal (socket 'terminal:payment_result').
   * Resolves the long-poll synchronously (fast); closes the durable row as a
   * fire-and-forget so a DB hiccup can't stall the POS response — the watchdog
   * and the TPV's REST payment-record are the backstops.
   */
  handlePaymentResult(result: TerminalPaymentResult): boolean {
    const pending = this.pendingPayments.get(result.requestId)

    // Always close the durable row, even if the long-poll already timed out.
    void this.closeRow(result.requestId, result)

    if (!pending) {
      logger.warn(`⚠️ [TerminalPayment] No in-flight long-poll for requestId (row still closed)`, { requestId: result.requestId })
      return false
    }

    clearTimeout(pending.timeout)
    this.pendingPayments.delete(result.requestId)

    logger.info(`✅ [TerminalPayment] Payment result received`, {
      requestId: result.requestId,
      status: result.status,
      paymentId: result.paymentId,
      terminalId: pending.terminalId,
    })

    pending.resolve(result)
    return true
  }

  /**
   * Transition a request row to its terminal status (CAS, immutable terminals).
   * - in-flight → terminal: normal close.
   * - TIMED_OUT/UNKNOWN → terminal: LATE result wins (flag lateResult); the POS
   *   was already told timeout, but the money truth is captured.
   * - already terminal: no-op (log the conflict).
   */
  private async closeRow(requestId: string, result: TerminalPaymentResult): Promise<void> {
    const newStatus = resultToStatus(result.status)
    const data: Prisma.TerminalPaymentRequestUpdateManyMutationInput = {
      status: newStatus,
      paymentId: result.paymentId ?? undefined,
      resultJson: result as unknown as Prisma.InputJsonValue,
      failureCode: result.status === 'failed' ? 'TPV_ERROR' : null,
    }
    try {
      const inFlight = await prisma.terminalPaymentRequest.updateMany({
        where: { requestId, status: { in: IN_FLIGHT } },
        data,
      })
      if (inFlight.count > 0) return

      const late = await prisma.terminalPaymentRequest.updateMany({
        where: { requestId, status: { in: [TerminalPaymentRequestStatus.TIMED_OUT, TerminalPaymentRequestStatus.UNKNOWN] } },
        data: { ...data, lateResult: true },
      })
      if (late.count > 0) {
        logger.warn(`🕰️ [TerminalPayment] Late result reconciled a stale row`, { requestId, newStatus })
        return
      }
      // Neither matched → row already in a final immutable state (or never existed).
      logger.info(`ℹ️ [TerminalPayment] closeRow no-op (row absent or already final)`, { requestId, newStatus })
    } catch (err) {
      logger.error(`❌ [TerminalPayment] closeRow failed`, { requestId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * Close the arbitration row from the TPV's idempotent REST payment-record,
   * INSIDE that record's transaction so it commits/rolls back with the Payment.
   * This is the ROBUST close path (survives socket loss / server restart):
   * once the TPV threads `terminalPaymentRequestId` (= the POS requestId), a
   * recorded Payment always closes the row. Old TPVs don't send it → the socket
   * result / watchdog close it instead. Best-effort: never throws (must not roll
   * back a real money write).
   */
  async closeRowFromPaymentTx(tx: Prisma.TransactionClient, requestId: string, paymentId: string): Promise<void> {
    try {
      // A recorded Payment is GROUND TRUTH that money moved — it beats any prior
      // cancel/fail/timeout close. Reconcile ANY non-COMPLETED row to COMPLETED so the
      // status endpoint can NEVER report cancelled/failed for a charge that actually
      // landed (which would invite a cashier re-charge → double charge). This closes the
      // window where a POS-cancelled row is moved to CANCELLED by the watchdog (30s grace)
      // BEFORE the TPV records the Payment (AngelPay records "minutes later").
      // Idempotent: an already-COMPLETED row is left untouched (never clobber its paymentId).
      const before = await tx.terminalPaymentRequest.findUnique({
        where: { requestId },
        select: { status: true },
      })
      if (!before || before.status === TerminalPaymentRequestStatus.COMPLETED) return

      // `lateResult` = this row had already been closed/timed-out when the money truth
      // arrived (reopened), vs a normal in-flight close.
      const reopened = !IN_FLIGHT.includes(before.status)
      await tx.terminalPaymentRequest.updateMany({
        where: { requestId, status: { not: TerminalPaymentRequestStatus.COMPLETED } },
        data: { status: TerminalPaymentRequestStatus.COMPLETED, paymentId, lateResult: reopened },
      })

      // If the POS had asked to cancel (CANCEL_REQUESTED) or we had already CLOSED this
      // row as cancelled/failed, the charge went through DESPITE that — reconciled to
      // COMPLETED here, but a human must know a cancelled attempt actually took money.
      // 🚨 = the stable Better Stack token.
      if (
        before.status === TerminalPaymentRequestStatus.CANCELLED ||
        before.status === TerminalPaymentRequestStatus.FAILED ||
        before.status === TerminalPaymentRequestStatus.CANCEL_REQUESTED
      ) {
        logger.error(
          `🚨 [Terminal-payment] Payment recorded for an already-${before.status} request — reconciled to COMPLETED (money moved despite cancel/close)`,
          {
            requestId,
            paymentId,
            priorStatus: before.status,
          },
        )
      }
    } catch (err) {
      logger.error(`❌ [TerminalPayment] closeRowFromPaymentTx failed (non-fatal)`, {
        requestId,
        paymentId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * True when the order has a terminal charge that could still move money and
   * NOBODY has asked to cancel: PENDING/SENT (charge live) or UNKNOWN (outcome
   * undetermined — money may already have moved). Used to block cancelOrder:
   * cancelling the order under one of these lets the charge land on a
   * CANCELLED order (recorded & settled, but excluded from reports).
   *
   * CANCEL_REQUESTED is deliberately EXCLUDED: the POS cancel flow cancels the
   * charge first and cancels the order immediately after — blocking on it
   * would 409 every normal cancel. The residual race (money lands despite the
   * cancel request) is reconciled by closeRowFromPaymentTx + the 🚨 alert.
   */
  async hasChargeBlockingOrderCancel(venueId: string, orderId: string): Promise<boolean> {
    const row = await prisma.terminalPaymentRequest.findFirst({
      where: {
        venueId,
        orderId,
        status: {
          in: [TerminalPaymentRequestStatus.PENDING, TerminalPaymentRequestStatus.SENT, TerminalPaymentRequestStatus.UNKNOWN],
        },
      },
      select: { requestId: true },
    })
    return row !== null
  }

  /** Read a request's current status (mobile status endpoint + MCP tool). */
  async getPaymentStatus(requestId: string, venueId?: string): Promise<TerminalPaymentStatus | null> {
    const row = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
    if (!row) return null
    if (venueId && row.venueId !== venueId) return null // tenant isolation
    return {
      requestId: row.requestId,
      venueId: row.venueId,
      terminalId: row.terminalId,
      status: row.status,
      amount: row.amountCents / 100,
      tip: row.tipCents / 100,
      orderId: row.orderId,
      paymentId: row.paymentId,
      senderDevice: row.senderDevice,
      lateResult: row.lateResult,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  /**
   * Watchdog sweep: reconcile stale active rows. Runs every ~30s + at boot.
   * - stale in-flight (past expiresAt) or CANCEL_REQUESTED past a short grace:
   *   if a Payment exists for the order → COMPLETED (late); else → UNKNOWN
   *   (HOLD the slot, never free blind) and alert. Returns a small summary.
   * The entry read is retry-wrapped per .claude/rules/cron-jobs.md.
   */
  async reconcileStaleRequests(now: Date = new Date()): Promise<{ completed: number; unknown: number; cancelled: number }> {
    const cancelCutoff = new Date(now.getTime() - CANCEL_GRACE_MS)
    const stale = await retry(
      () =>
        prisma.terminalPaymentRequest.findMany({
          where: {
            status: { in: IN_FLIGHT },
            OR: [{ expiresAt: { lt: now } }, { status: TerminalPaymentRequestStatus.CANCEL_REQUESTED, updatedAt: { lt: cancelCutoff } }],
          },
          take: 200,
        }),
      { retries: 3, shouldRetry: shouldRetryDbConnectionError, context: 'terminal-payment-watchdog:findStale' },
    )

    let completed = 0
    let unknown = 0
    let cancelled = 0

    for (const row of stale) {
      // Reconcile ONLY against a Payment that plausibly belongs to THIS request; otherwise fall
      // through to UNKNOWN and HOLD the slot (never free blind → the double-charge safeguard).
      // Two guards, because an order legitimately carries several Payments (split/partial tender):
      //   1) createdAt >= row.createdAt — a payment for THIS request cannot predate the request row,
      //      so an unrelated PRIOR cash/split payment on the same order is never matched.
      //   2) not already claimed by another TerminalPaymentRequest.paymentId (soft ref, no FK) —
      //      so one payment can't reconcile (and free) multiple stale requests.
      let payment: { id: string } | null = null
      if (row.orderId) {
        const candidate = await prisma.payment.findFirst({
          where: { orderId: row.orderId, venueId: row.venueId, createdAt: { gte: row.createdAt } },
          select: { id: true },
          orderBy: { createdAt: 'desc' },
        })
        if (candidate) {
          const claimedByAnother = await prisma.terminalPaymentRequest.findFirst({
            where: { paymentId: candidate.id, id: { not: row.id } },
            select: { id: true },
          })
          if (!claimedByAnother) payment = candidate
        }
      }

      if (payment) {
        const r = await prisma.terminalPaymentRequest.updateMany({
          where: { id: row.id, status: { in: IN_FLIGHT } },
          data: { status: TerminalPaymentRequestStatus.COMPLETED, paymentId: payment.id, lateResult: true },
        })
        completed += r.count
        continue
      }

      if (row.status === TerminalPaymentRequestStatus.CANCEL_REQUESTED) {
        // Cancelled and no payment landed within the grace → safe to free.
        const r = await prisma.terminalPaymentRequest.updateMany({
          where: { id: row.id, status: TerminalPaymentRequestStatus.CANCEL_REQUESTED },
          data: { status: TerminalPaymentRequestStatus.CANCELLED, failureCode: 'CANCELLED' },
        })
        cancelled += r.count
        continue
      }

      // Unknown outcome — HOLD the slot (never free blind), alert, flag for manual reconcile.
      // 🚨 token is the stable string Better Stack's alert rule matches — do NOT rename.
      logger.error(`🚨 [Terminal-payment watchdog] Row went UNKNOWN — manual reconcile needed`, {
        requestId: row.requestId,
        terminalId: row.terminalId,
        venueId: row.venueId,
        orderId: row.orderId,
        ageSeconds: Math.floor((now.getTime() - row.createdAt.getTime()) / 1000),
      })
      const r = await prisma.terminalPaymentRequest.updateMany({
        where: { id: row.id, status: { in: IN_FLIGHT } },
        data: { status: TerminalPaymentRequestStatus.UNKNOWN, failureCode: 'TIMED_OUT' },
      })
      unknown += r.count
    }

    if (completed || unknown || cancelled) {
      logger.info(`🧹 [Terminal-payment watchdog] reconciled`, { completed, unknown, cancelled, scanned: stale.length })
    }
    return { completed, unknown, cancelled }
  }

  /**
   * Send a receipt print request to a terminal and wait for the result.
   */
  async printReceiptOnTerminal(request: TerminalReceiptPrintRequest): Promise<TerminalReceiptPrintResult> {
    const { terminalId, venueId } = request
    const terminalEntry = terminalRegistry.getTerminal(terminalId)
    if (!terminalEntry) {
      throw new Error(`La terminal ${terminalId} no está conectada`)
    }
    if (!terminalEntry.socketId) {
      throw new Error(`La terminal ${terminalId} está registrada pero no tiene conexión de socket. Reinicia la app de la terminal.`)
    }
    const socketId = terminalEntry.socketId

    const io = socketManager.getServer()
    if (!io) {
      throw new Error('Servidor de Socket.IO no inicializado')
    }

    const requestId = request.requestId || uuidv4()

    return new Promise<TerminalReceiptPrintResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingReceiptPrints.delete(requestId)
        logger.warn(`⏰ [TerminalReceiptPrint] Request timed out`, { requestId, terminalId })
        resolve({
          requestId,
          status: 'timeout',
          errorMessage: 'La terminal no respondió a la impresión',
        })
      }, RECEIPT_PRINT_TIMEOUT_MS)

      this.pendingReceiptPrints.set(requestId, {
        resolve,
        reject,
        timeout,
        requestId,
        terminalId,
        venueId,
        createdAt: new Date(),
      })

      io.to(socketId).emit('terminal:print_receipt_request', {
        requestId,
        terminalId,
        venueId,
        receipt: request.receipt,
        timestamp: new Date().toISOString(),
      })
      logger.info(`🖨️ [TerminalReceiptPrint] Emitted to socket ${socketId}`, { requestId, terminalId })
    })
  }

  /**
   * Handle receipt print result from a terminal.
   */
  handleReceiptPrintResult(result: TerminalReceiptPrintResult): boolean {
    const pending = this.pendingReceiptPrints.get(result.requestId)
    if (!pending) {
      logger.warn(`⚠️ [TerminalReceiptPrint] No pending print request for requestId`, {
        requestId: result.requestId,
      })
      return false
    }

    clearTimeout(pending.timeout)
    this.pendingReceiptPrints.delete(result.requestId)

    logger.info(`🖨️ [TerminalReceiptPrint] Result received`, {
      requestId: result.requestId,
      status: result.status,
      terminalId: pending.terminalId,
    })

    pending.resolve(result)
    return true
  }

  /**
   * Cancel a pending payment and notify the terminal.
   * requestId ensures TPV only cancels if it's still processing THAT specific payment.
   * The row goes to CANCEL_REQUESTED (still holds the slot): if the card was
   * already authorized, a later result wins → COMPLETED; the watchdog frees the
   * slot (→ CANCELLED) only after a short grace with no Payment.
   */
  async cancelPayment(terminalId: string, requestId?: string, reason?: string, venueId?: string): Promise<boolean> {
    const terminalEntry = terminalRegistry.getTerminal(terminalId)

    // The cancel INTENT must be recorded even when the terminal is unreachable:
    // returning early used to leave the row PENDING/SENT holding the slot until
    // expiresAt (5 min) while the POS had already moved on. The row CAS + long-poll
    // resolve run regardless; only the socket emit needs a live terminal. `venueId`
    // scopes the write so a requestId alone can never touch another venue's row.
    const emitted = await this.emitCancelToTerminal(terminalEntry?.socketId, terminalId, requestId, reason)

    if (requestId) {
      // Mark the durable row as cancel-requested (CAS, still holds the slot).
      try {
        await prisma.terminalPaymentRequest.updateMany({
          where: { requestId, status: { in: IN_FLIGHT }, ...(venueId ? { venueId } : {}) },
          data: { status: TerminalPaymentRequestStatus.CANCEL_REQUESTED },
        })
      } catch (err) {
        logger.error(`❌ [TerminalPayment] cancel row update failed`, {
          requestId,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // Resolve the long-poll so the POS UI unblocks (existing behavior).
      const pending = this.pendingPayments.get(requestId)
      if (pending) {
        clearTimeout(pending.timeout)
        this.pendingPayments.delete(requestId)
        pending.resolve({
          requestId,
          status: 'cancelled',
          errorMessage: 'Cancelado por el usuario',
        })
      }
    }

    return emitted
  }

  /** Emit the cancel to the terminal. Returns false when it couldn't be delivered. */
  private async emitCancelToTerminal(
    socketId: string | null | undefined,
    terminalId: string,
    requestId?: string,
    reason?: string,
  ): Promise<boolean> {
    if (!socketId) {
      logger.warn(`⚠️ [TerminalPayment] Cannot notify terminal of cancel - not online (row still cancelled)`, { terminalId })
      return false
    }
    const io = socketManager.getServer()
    if (!io) return false

    logger.info(`🚫 [TerminalPayment] Sending cancel to terminal`, { terminalId, requestId, reason })
    io.to(socketId).emit('terminal:payment_cancel', {
      terminalId,
      requestId, // TPV checks: if currentRequestId !== requestId, ignore cancel
      reason: reason || 'Cancelado por el usuario',
      timestamp: new Date().toISOString(),
    })
    return true
  }

  /**
   * Get count of pending payments (for monitoring).
   */
  getPendingCount(): number {
    return this.pendingPayments.size
  }
}

// Singleton
export const terminalPaymentService = new TerminalPaymentService()
