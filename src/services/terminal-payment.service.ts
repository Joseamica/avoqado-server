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
import { Prisma, TerminalPaymentRequestStatus, TransactionStatus, PaymentMethod } from '@prisma/client'
import prisma from '../utils/prismaClient'
import { terminalRegistry, normalizeTerminalId } from '../communication/sockets/terminal-registry'
import socketManager from '../communication/sockets/managers/socketManager'
import logger from '../config/logger'
import { BadRequestError, OrderAlreadyPaidError, TerminalBusyError } from '../errors/AppError'
import { resolveTerminalRefundTarget } from './tpv/terminalRefundTarget'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { logAction } from './dashboard/activity-log.service'
import { sendOpsAlert } from './alerts/opsAlert.service'

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
  /**
   * El cliente que el cajero eligió en el POS para esta venta.
   *
   * 🔴 Se persiste en la fila y NO se manda a la terminal. La TPV registra el cobro con
   * su propio payload (que no lleva cliente), así que sin esto la venta con TARJETA nace
   * anónima mientras la misma venta en efectivo sí lleva cliente. Mandarlo por el socket
   * sería PII viajando al aparato sin ningún consumidor — y obligaría a desplegar la TPV
   * (3-5 días por la firma PAX) para un arreglo que es sólo del server.
   */
  customerId?: string | null
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

export interface TerminalRefundRequest {
  terminalId: string
  venueId: string
  paymentId: string
  requestedBy: string
  requestId?: string
  reason?: string
}

/**
 * 🔑 El desenlace de este evento es "¿se abrió la devolución en la terminal?",
 * NO "¿se devolvió el dinero?". La devolución la termina una persona en el
 * aparato (en Blumon hay que volver a pasar la tarjeta) y puede tardar
 * minutos; quedarse esperando eso congelaría al cajero. Cuando el dinero se
 * mueve, la propia TPV lo registra por la ruta REST de reembolsos que ya
 * existe, y ahí es donde aparece en Avoqado.
 */
export interface TerminalRefundResult {
  requestId: string
  status: 'opened' | 'rejected' | 'timeout'
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

interface PendingRefundRequest {
  resolve: (result: TerminalRefundResult) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  requestId: string
  terminalId: string
  venueId: string
  paymentId: string
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
const PAYMENT_DELIVERY_ACK_TIMEOUT_MS = 5_000
const RECEIPT_PRINT_TIMEOUT_MS = 30_000 // 30 seconds
// Sólo se espera el ACK de "abrí la pantalla", no que alguien pase la tarjeta.
const REFUND_OPEN_TIMEOUT_MS = 20_000 // 20 seconds
const CANCEL_GRACE_MS = 30_000 // watchdog grace before a CANCEL_REQUESTED row is resolved
// UNKNOWN is no longer a dead end (2026-09-04, Testarudo: a PAX sat locked for 3 h). Once the
// terminal is BACK — an authenticated TPV API call bumps Terminal.lastHeartbeat past the
// request's deadline — and this grace passes with no card payment, the slot is freed.
// 🔴 Why 20 min and not 2: the TPV's offline payment queue is a PERIODIC worker every 15 min
// (`avoqado-tpv` PaymentSyncScheduler, `PAYMENT_SYNC_INTERVAL_MINUTES = 15`); on the Blumon/PAX
// path nothing triggers it at reconnect. A charge whose REST record got cut (8.5 s vs the PAX's
// 10 s client timeout — a daily event) lands up to 15 min later. Freeing before that replays
// would invite the cashier to charge again → double charge. The grace must cover the replay.
const UNKNOWN_AUTO_RELEASE_GRACE_MS = 20 * 60_000
// "Back" must mean back NOW: at release time the terminal has to have reported within this window,
// otherwise the stamp is dropped and the wait restarts when it returns (a heartbeat per reboot in a
// reboot loop, or one heartbeat then dark again, never frees the slot).
const TERMINAL_ALIVE_WINDOW_MS = 5 * 60_000
// After an automatic/manual release, a payment recorded WITHOUT the request id (old queues) still
// has to reach the row: released rows are swept for this long.
const RELEASED_LATE_RECONCILE_WINDOW_MS = 30 * 60_000
const RELEASE_FAILURE_CODES = ['AUTO_RELEASED', 'MANUAL_RELEASE']

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

/**
 * What the cashier reads on the tablet when the terminal is busy (Android shows this string as-is).
 * "Ocupada" alone sent Testarudo into a reboot loop; the amount, the age and the sender let them
 * tell a live charge from a stuck one — and a stuck one now says it frees itself.
 */
function busyMessage(
  terminalId: string,
  blocker: { status: TerminalPaymentRequestStatus; amountCents: number; senderDevice: string | null; createdAt: Date } | null,
): string {
  if (!blocker) return `La terminal ${terminalId} está ocupada procesando otro cobro`
  const minutes = Math.max(0, Math.floor((Date.now() - blocker.createdAt.getTime()) / 60_000))
  const amount = `$${(blocker.amountCents / 100).toFixed(2)}`
  if (blocker.status === TerminalPaymentRequestStatus.UNKNOWN) {
    return `La terminal ${terminalId} está ocupada por un cobro de ${amount} que quedó sin respuesta hace ${minutes} min; se liberará sola en cuanto la terminal reconecte`
  }
  const desde = blocker.senderDevice ? ` desde ${blocker.senderDevice}` : ''
  return `La terminal ${terminalId} está ocupada por un cobro de ${amount} enviado hace ${minutes} min${desde}`
}

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
  private pendingRefundRequests = new Map<string, PendingRefundRequest>()

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
  async isTerminalBusy(terminalId: string, venueId: string): Promise<boolean> {
    const lockKey = normalizeTerminalId(terminalId)
    const active = await prisma.terminalPaymentRequest.findFirst({
      where: { terminalId: lockKey, venueId, status: { in: SLOT_HELD } },
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

    // 🛡️ CANDADO DE SOBREPAGO — rechazar AQUÍ, donde todavía no hay dinero movido.
    //
    // Caso real (Mindform, 2026-06-21/22): una cuenta de $380 YA saldada aceptó $122 una hora
    // después y $232 al día siguiente — el POS mostraba la orden como abierta (lista rancia) y
    // la mandó a cobrar de nuevo. En `recordOrderPayment` ya es demasiado tarde para rechazar
    // (la tarjeta ya pasó por Blumon; ahí solo se detecta y alerta). Este es el ÚNICO punto del
    // flujo remoto donde bloquear es seguro: el request aún no llega a la terminal.
    //
    // Solo aplica a cobros CON orden. Fail-open ante error de lectura: un fallo de infra aquí
    // no debe tumbar un cobro legítimo (el resto del flujo tiene sus propias validaciones).
    if (request.orderId) {
      try {
        const order = await prisma.order.findFirst({
          where: { id: request.orderId, venueId },
          select: { paymentStatus: true, orderNumber: true },
        })
        if (order?.paymentStatus === 'PAID') {
          logger.warn('🛡️ [TerminalPayment] Cobro rechazado: la orden YA está pagada', {
            orderId: request.orderId,
            orderNumber: order.orderNumber,
            venueId,
            terminalId,
            amountCents: request.amountCents,
            requestedBy: request.requestedBy ?? null,
          })
          throw new OrderAlreadyPaidError(
            `La cuenta ${order.orderNumber ?? request.orderId} ya está pagada por completo. Actualiza la lista de órdenes — si necesitas cobrar algo más, agrégalo a la cuenta primero.`,
          )
        }
      } catch (err) {
        if (err instanceof OrderAlreadyPaidError) throw err
        logger.error('🛡️ [TerminalPayment] No se pudo verificar el estado de la orden — se procede (fail-open)', {
          orderId: request.orderId,
          error: err instanceof Error ? err.message : err,
        })
      }
    }

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
          // El cliente de la venta viaja AQUÍ (no por el socket): es de donde
          // `recordFastPayment` lo recoge cuando la TPV registra el cobro.
          customerId: request.customerId ?? null,
          processedByStaffId: request.processedByStaffId ?? null,
          rating: request.rating ?? null,
          skipReview: request.skipReview ?? true,
          expiresAt: new Date(Date.now() + PAYMENT_TIMEOUT_MS),
        },
      })
    } catch (err) {
      if (!isPrismaUniqueViolation(err)) throw err
      // Disambiguate WITHOUT parsing meta.target: look up MY requestId.
      // - my row exists  → this requestId collided (replay or in-flight dup)
      // - my row absent  → the terminal slot is held by ANOTHER request → busy
      const mine = await prisma.terminalPaymentRequest.findFirst({ where: { requestId, venueId } })
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
      // Slot held by another request. Scoped by venue: the slot index is GLOBAL per terminal, so a
      // migrated terminal can be held by a row of its OLD venue — that row's amount/device must not
      // be described to the new venue's cashier (busyMessage stays generic when blocker is null).
      const blocker = await prisma.terminalPaymentRequest.findFirst({
        where: { terminalId: lockKey, venueId, status: { in: SLOT_HELD } },
        orderBy: { createdAt: 'desc' },
      })
      if (!blocker) {
        logger.warn(`🔒 [TerminalPayment] Slot held by a request of ANOTHER venue (migrated terminal?)`, { lockKey, venueId })
      }
      if (this.isLockEnabled()) {
        logger.warn(`🔒 [TerminalPayment] Terminal busy, rejecting`, {
          lockKey,
          blockerRequestId: blocker?.requestId,
          incomingRequestId: requestId,
        })
        throw new TerminalBusyError(busyMessage(terminalId, blocker), {
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
      if (persisted) await this.closeRow(requestId, venueId, { requestId, status: 'failed', errorMessage: 'Servidor no inicializado' })
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

      // 🔴 `customerId` NO va aquí, a propósito: la TPV no lo consume y sería PII enviada
      // al aparato sin ningún uso. El cliente vive en la fila de arbitraje, que el server
      // relee al registrar el cobro. Guardarraíl en
      // `tests/unit/services/terminal-payment.service.test.ts`.
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

      const directSocket = io.sockets.sockets.get(socketId)
      if (!directSocket) {
        clearTimeout(timeout)
        this.pendingPayments.delete(requestId)
        if (persisted) void this.failUndelivered(requestId, venueId, 'SOCKET_NOT_FOUND')
        reject(new BadRequestError('La terminal perdió la conexión antes de recibir el cobro'))
        return
      }

      if ((terminalEntry.terminalPaymentAckVersion ?? 0) < 1) {
        // Compatibilidad backend-first: APKs publicadas aún no conocen el ACK ni
        // tienen inbox durable. Se entrega una sola vez, exactamente como antes.
        directSocket.emit('terminal:payment_request', paymentPayload)
        logger.info(`📡 [TerminalPayment] Emitted once to legacy socket ${socketId}`, { requestId, terminalId })
        return
      }

      directSocket
        .timeout(PAYMENT_DELIVERY_ACK_TIMEOUT_MS)
        .emit('terminal:payment_request', paymentPayload, (error: Error | null, response?: { accepted?: boolean; requestId?: string }) => {
          const stillPending = this.pendingPayments.has(requestId)
          if (error || response?.accepted !== true || response.requestId !== requestId) {
            if (!stillPending) return
            clearTimeout(timeout)
            this.pendingPayments.delete(requestId)
            if (persisted) void this.failUndelivered(requestId, venueId, error ? 'ACK_TIMEOUT' : 'ACK_REJECTED')
            reject(new BadRequestError('La terminal no confirmó que guardó el cobro. No se inició ningún cargo.'))
            return
          }

          if (persisted) void this.markDelivered(requestId, venueId)
          logger.info(`📡 [TerminalPayment] Durable ACK received from socket ${socketId}`, { requestId, terminalId })
        })
    })
  }

  private async markDelivered(requestId: string, venueId: string): Promise<void> {
    const acknowledgedAt = new Date()
    await prisma.terminalPaymentRequest.updateMany({
      where: { requestId, venueId, status: TerminalPaymentRequestStatus.PENDING },
      data: {
        status: TerminalPaymentRequestStatus.SENT,
        acknowledgedAt,
        lastDeliveredAt: acknowledgedAt,
        deliveryAttempts: { increment: 1 },
        expiresAt: new Date(acknowledgedAt.getTime() + PAYMENT_TIMEOUT_MS),
      },
    })
  }

  private async failUndelivered(requestId: string, venueId: string, failureCode: string): Promise<void> {
    await prisma.terminalPaymentRequest.updateMany({
      where: { requestId, venueId, status: TerminalPaymentRequestStatus.PENDING },
      data: {
        status: TerminalPaymentRequestStatus.FAILED,
        failureCode,
        resultJson: {
          requestId,
          status: 'failed',
          errorMessage: 'La terminal no confirmó la recepción; no se inició ningún cargo',
        },
      },
    })
  }

  /**
   * Reentrega al reconectar. Está capability-gated: una APK sin inbox durable no
   * recibe replays porque no podría distinguirlos de un cobro nuevo.
   */
  async replayPendingForTerminal(terminalId: string, venueId: string | undefined, socketId: string): Promise<void> {
    if (!venueId) return
    const entry = terminalRegistry.getTerminal(terminalId)
    if (!entry || entry.socketId !== socketId || entry.venueId !== venueId || (entry.terminalPaymentAckVersion ?? 0) < 1) return

    const io = socketManager.getServer()
    const directSocket = io?.sockets.sockets.get(socketId)
    if (!directSocket) return

    const normalizedTerminalId = normalizeTerminalId(terminalId)
    const rows = await prisma.terminalPaymentRequest.findMany({
      where: {
        terminalId: normalizedTerminalId,
        venueId,
        status: { in: IN_FLIGHT },
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'asc' },
      take: 1,
    })

    for (const row of rows) {
      if (row.status === TerminalPaymentRequestStatus.CANCEL_REQUESTED) {
        directSocket.emit('terminal:payment_cancel', {
          requestId: row.requestId,
          terminalId,
          reason: 'Cancelación pendiente durante reconexión',
          timestamp: new Date().toISOString(),
        })
        continue
      }

      const payload = {
        requestId: row.requestId,
        terminalId,
        amountCents: row.amountCents,
        tipCents: row.tipCents,
        rating: row.rating ?? undefined,
        skipReview: row.skipReview,
        orderId: row.orderId ?? undefined,
        senderDeviceName: row.senderDevice ?? undefined,
        processedByStaffId: row.processedByStaffId ?? undefined,
        venueId,
        timestamp: new Date().toISOString(),
      }
      directSocket
        .timeout(PAYMENT_DELIVERY_ACK_TIMEOUT_MS)
        .emit('terminal:payment_request', payload, (error: Error | null, response?: { accepted?: boolean; requestId?: string }) => {
          if (error || response?.accepted !== true || response.requestId !== row.requestId) return
          const acknowledgedAt = new Date()
          void prisma.terminalPaymentRequest.updateMany({
            where: {
              requestId: row.requestId,
              venueId,
              status: { in: [TerminalPaymentRequestStatus.PENDING, TerminalPaymentRequestStatus.SENT] },
            },
            data: {
              status: TerminalPaymentRequestStatus.SENT,
              acknowledgedAt,
              lastDeliveredAt: acknowledgedAt,
              deliveryAttempts: { increment: 1 },
              expiresAt: new Date(acknowledgedAt.getTime() + PAYMENT_TIMEOUT_MS),
            },
          })
        })
    }
  }

  /**
   * Handle payment result from a terminal (socket 'terminal:payment_result').
   * Resolves the long-poll synchronously (fast); closes the durable row as a
   * fire-and-forget so a DB hiccup can't stall the POS response — the watchdog
   * and the TPV's REST payment-record are the backstops.
   */
  handlePaymentResult(result: TerminalPaymentResult): boolean {
    const pending = this.pendingPayments.get(result.requestId)

    if (!pending) {
      logger.warn(`⚠️ [TerminalPayment] No in-flight long-poll for requestId`, { requestId: result.requestId })
      return false
    }

    void this.closeRow(result.requestId, pending.venueId, result)

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
   * Frontera autenticada TPV → server. El requestId del payload no basta: se ata
   * a la terminal y venue derivados del socket, y sólo entonces puede cerrar dinero.
   */
  async handlePaymentResultFromSocket(
    result: TerminalPaymentResult,
    terminal: { socketId: string | null; terminalId: string; venueId: string },
  ): Promise<boolean> {
    if (!result.requestId || !['success', 'failed', 'cancelled', 'timeout'].includes(result.status)) return false
    const row = await prisma.terminalPaymentRequest.findFirst({
      where: {
        requestId: result.requestId,
        terminalId: normalizeTerminalId(terminal.terminalId),
        venueId: terminal.venueId,
      },
      select: { requestId: true },
    })
    if (!row) {
      logger.warn('🛑 [TerminalPayment] Result rejected: request is not owned by authenticated terminal socket', {
        requestId: result.requestId,
        terminalId: terminal.terminalId,
        venueId: terminal.venueId,
        socketId: terminal.socketId,
      })
      return false
    }

    const pending = this.pendingPayments.get(result.requestId)
    void this.closeRow(result.requestId, terminal.venueId, result)
    if (!pending) {
      logger.warn(`⚠️ [TerminalPayment] Authenticated late result closed row without an HTTP waiter`, { requestId: result.requestId })
      return false
    }
    clearTimeout(pending.timeout)
    this.pendingPayments.delete(result.requestId)
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
  private async closeRow(requestId: string, venueId: string, result: TerminalPaymentResult): Promise<void> {
    const newStatus = resultToStatus(result.status)
    const data: Prisma.TerminalPaymentRequestUpdateManyMutationInput = {
      status: newStatus,
      paymentId: result.paymentId ?? undefined,
      resultJson: result as unknown as Prisma.InputJsonValue,
      failureCode: result.status === 'failed' ? 'TPV_ERROR' : null,
    }
    try {
      const inFlight = await prisma.terminalPaymentRequest.updateMany({
        where: { requestId, venueId, status: { in: IN_FLIGHT } },
        data,
      })
      if (inFlight.count > 0) return

      const late = await prisma.terminalPaymentRequest.updateMany({
        where: { requestId, venueId, status: { in: [TerminalPaymentRequestStatus.TIMED_OUT, TerminalPaymentRequestStatus.UNKNOWN] } },
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
  async closeRowFromPaymentTx(
    tx: Prisma.TransactionClient,
    requestId: string,
    paymentId: string,
    venueId: string,
    reported?: { amountCents: number; tipCents: number },
  ): Promise<void> {
    try {
      // A recorded Payment is GROUND TRUTH that money moved — it beats any prior
      // cancel/fail/timeout close. Reconcile ANY non-COMPLETED row to COMPLETED so the
      // status endpoint can NEVER report cancelled/failed for a charge that actually
      // landed (which would invite a cashier re-charge → double charge). This closes the
      // window where a POS-cancelled row is moved to CANCELLED by the watchdog (30s grace)
      // BEFORE the TPV records the Payment (AngelPay records "minutes later").
      // Idempotent: an already-COMPLETED row is left untouched (never clobber its paymentId).
      const before = await tx.terminalPaymentRequest.findFirst({
        where: { requestId, venueId },
        select: { status: true, amountCents: true, tipCents: true },
      })
      if (!before || before.status === TerminalPaymentRequestStatus.COMPLETED) return

      // `lateResult` = this row had already been closed/timed-out when the money truth
      // arrived (reopened), vs a normal in-flight close.
      const reopened = !IN_FLIGHT.includes(before.status)
      const requested =
        Number.isSafeInteger(before.amountCents) && Number.isSafeInteger(before.tipCents)
          ? {
              amountCents: before.amountCents,
              tipCents: before.tipCents,
              totalCents: before.amountCents + before.tipCents,
            }
          : undefined
      const reportedContract = reported && {
        amountCents: reported.amountCents,
        tipCents: reported.tipCents,
        totalCents: reported.amountCents + reported.tipCents,
      }
      const contractMismatch =
        requested !== undefined &&
        reportedContract !== undefined &&
        (reportedContract.amountCents !== requested.amountCents ||
          reportedContract.tipCents !== requested.tipCents ||
          reportedContract.totalCents !== requested.totalCents)

      await tx.terminalPaymentRequest.updateMany({
        where: { requestId, venueId, status: { not: TerminalPaymentRequestStatus.COMPLETED } },
        data: {
          status: TerminalPaymentRequestStatus.COMPLETED,
          paymentId,
          lateResult: reopened,
          ...(contractMismatch
            ? {
                failureCode: 'CONTRACT_MISMATCH',
                resultJson: {
                  requestId,
                  status: 'success',
                  paymentId,
                  reconciliationRequired: true,
                  requested,
                  reported: reportedContract,
                },
              }
            : {}),
        },
      })

      if (contractMismatch) {
        logger.error('🚨 [Terminal-payment contract mismatch] Payment was recorded with values different from the POS request', {
          requestId,
          paymentId,
          venueId,
          requested,
          reported: reportedContract,
        })
      }

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
            venueId,
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
  async getPaymentStatus(requestId: string, venueId: string): Promise<TerminalPaymentStatus | null> {
    const row = await prisma.terminalPaymentRequest.findFirst({ where: { requestId, venueId } })
    if (!row) return null
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
      // Four guards, because an order legitimately carries several Payments (split/partial tender):
      //   1) createdAt >= row.createdAt — a payment for THIS request cannot predate the request row,
      //      so an unrelated PRIOR cash/split payment on the same order is never matched.
      //   2) not already claimed by another TerminalPaymentRequest.paymentId (soft ref, no FK) —
      //      so one payment can't reconcile (and free) multiple stale requests.
      //   3) 🔴 status COMPLETED — a PENDING/PROCESSING/FAILED/REFUNDED Payment is NOT evidence
      //      that money moved. Without this, a DECLINED card closed the request as "charged".
      //   4) 🔴 card method — this row is a TERMINAL charge. A CASH (or transfer) payment landing
      //      on the same order afterwards proves nothing about whether the CARD went through;
      //      matching it closed the request as "charged" on the strength of an unrelated tender.
      //
      // Both new guards trade a silent WRONG money answer for an UNKNOWN, which holds the slot
      // and raises the alert. That direction is the expensive-but-correct one: the failure this
      // prevents is the POS telling the cashier "ya se cobró" for a sale that was never paid —
      // the merchant eats it, and nobody complains about a charge that never happened.
      //
      // NOT filtered on amount/tip on purpose: the tip is chosen ON the terminal, so a legitimate
      // charge can differ from the requested amount. Guessing there would push good cases into
      // UNKNOWN and jam terminals. If exact binding is ever needed, it has to come from a
      // request↔payment reference, not from arithmetic.
      // The 4 guards live in ONE place (findReconcilablePayment) — the UNKNOWN sweep and the
      // manual release ask the exact same question, and a rule copied in N sites drifts.
      const payment = await this.findReconcilablePayment(row)

      if (payment) {
        const r = await prisma.terminalPaymentRequest.updateMany({
          where: { id: row.id, status: { in: IN_FLIGHT } },
          data: { status: TerminalPaymentRequestStatus.COMPLETED, paymentId: payment.id, lateResult: true },
        })
        completed += r.count
        // 🔴 El MISMO evento de dinero se descubre por dos rutas y sólo una avisaba:
        // closeRowFromPaymentTx dispara el 🚨 cuando la fila venía cancelada, y esta no
        // disparaba nada. Si el hallazgo llegaba por aquí, nadie se enteraba de que el
        // cajero canceló y el dinero se fue igual.
        //
        // No se puede prevenir en la caja: medido en esta base, el registro tardío llega
        // entre 65 s y 3 HORAS después del cobro. Retener la venta ese tiempo sería mucho
        // peor que el problema — dejaría un fantasma bloqueando cada venta cancelada
        // durante toda una tarde. Si no se puede prevenir, lo mínimo es que un humano se
        // entere y pueda devolver el dinero.
        //
        // 🚨 token estable que machea la regla de Better Stack — NO renombrar.
        if (r.count > 0 && row.status === TerminalPaymentRequestStatus.CANCEL_REQUESTED) {
          logger.error(
            `🚨 [Terminal-payment watchdog] Payment recorded for an already-${row.status} request — reconciled to COMPLETED (money moved despite cancel)`,
            { requestId: row.requestId, paymentId: payment.id, priorStatus: row.status },
          )
        }
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
      if (r.count > 0) {
        // Second channel, independent of the log pipeline (see opsAlert.service.ts). Outside
        // any retry/transaction on purpose, and NOT awaited: a hung mail provider must never stall
        // this tick (the job's isRunning latch would then skip every following sweep, including
        // CANCEL_REQUESTED → CANCELLED). sendOpsAlert never throws.
        void sendOpsAlert({
          subject: `Terminal ${row.terminalId}: cobro sin respuesta (${row.venueId})`,
          lines: [
            `Un cobro de $${(row.amountCents / 100).toFixed(2)} enviado a la terminal ${row.terminalId} no obtuvo respuesta en 5 minutos (requestId ${row.requestId}, orden ${row.orderId ?? 'sin orden'}).`,
            'La terminal queda reservada mientras no vuelva. Cuando reconecte y pasen 20 minutos sin ningún pago con tarjeta (lo que tarda su cola offline en subir), el servidor la liberará solo.',
            'Si el negocio no puede esperar, se puede liberar a mano desde superadmin o el MCP (release_terminal_payment).',
          ],
        })
      }
    }

    if (completed || unknown || cancelled) {
      logger.info(`🧹 [Terminal-payment watchdog] reconciled`, { completed, unknown, cancelled, scanned: stale.length })
    }
    return { completed, unknown, cancelled }
  }

  /**
   * The ONLY question the recovery paths ask: "did a card payment land for THIS request?"
   * Four guards, because an order legitimately carries several Payments (split/partial tender):
   *   1) createdAt >= row.createdAt — a payment for this request cannot predate the request row,
   *      so an unrelated PRIOR cash/split payment on the same order is never matched.
   *   2) not already claimed by another TerminalPaymentRequest.paymentId (soft ref, no FK) —
   *      so one payment can't reconcile (and free) multiple stale requests.
   *   3) 🔴 status COMPLETED — a PENDING/PROCESSING/FAILED/REFUNDED Payment is NOT evidence
   *      that money moved. Without this, a DECLINED card closed the request as "charged".
   *   4) 🔴 card method — this row is a TERMINAL charge. A CASH (or transfer) payment landing
   *      on the same order afterwards proves nothing about whether the CARD went through.
   * NOT filtered on amount/tip on purpose: the tip is chosen ON the terminal.
   */
  private async findReconcilablePayment(row: {
    id: string
    orderId: string | null
    venueId: string
    createdAt: Date
  }): Promise<{ id: string } | null> {
    if (!row.orderId) return null
    const candidate = await prisma.payment.findFirst({
      where: {
        orderId: row.orderId,
        venueId: row.venueId,
        createdAt: { gte: row.createdAt },
        status: TransactionStatus.COMPLETED,
        method: { in: [PaymentMethod.CREDIT_CARD, PaymentMethod.DEBIT_CARD] },
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    })
    if (!candidate) return null
    const claimedByAnother = await prisma.terminalPaymentRequest.findFirst({
      where: { paymentId: candidate.id, venueId: row.venueId, id: { not: row.id } },
      select: { id: true },
    })
    return claimedByAnother ? null : candidate
  }

  /**
   * Terminal row for a normalized lock key (serial with or without AVQD-, case-insensitive — the
   * serial rule of the heartbeat middleware). Deliberately NOT scoped by venue: `Terminal.serialNumber`
   * is globally unique and a terminal migrated to another venue still has to be recognised as "back",
   * or its old venue's UNKNOWN row would hold the global slot forever (the incident, again).
   */
  private async findTerminalForRow(row: { terminalId: string }): Promise<{ id: string; lastHeartbeat: Date | null } | null> {
    return prisma.terminal.findFirst({
      where: {
        OR: [
          { serialNumber: { equals: row.terminalId, mode: 'insensitive' } },
          { serialNumber: { equals: `AVQD-${row.terminalId}`, mode: 'insensitive' } },
        ],
      },
      select: { id: true, lastHeartbeat: true },
    })
  }

  /**
   * UNKNOWN is not a dead end (2026-09-04, Testarudo: a PAX sat locked 3 h waiting for a human).
   * Every tick, for each UNKNOWN row, in this order:
   *   1) a reconcilable card payment → COMPLETED (late). Money always wins over a release.
   *   2) the terminal is BACK (Terminal.lastHeartbeat later than the request's deadline; any TPV
   *      API call bumps it, including the offline-queue replay) → stamp terminalReturnedAt. Not freed yet.
   *   3) UNKNOWN_AUTO_RELEASE_GRACE_MS after that stamp with still no payment → TIMED_OUT /
   *      AUTO_RELEASED: audit row, 🚨 log (Better Stack) and ops email (independent channel).
   * A terminal that never comes back keeps the slot: nobody can charge on it anyway, and a late
   * payment recorded afterwards still reconciles the row through closeRowFromPaymentTx.
   * Every write is a CAS on status = UNKNOWN so a late result that closes the row first wins.
   */
  async reconcileUnknownRequests(
    now: Date = new Date(),
  ): Promise<{ completed: number; marked: number; released: number; reset: number; lateReconciled: number }> {
    const rows = await retry(
      () =>
        prisma.terminalPaymentRequest.findMany({
          where: { status: TerminalPaymentRequestStatus.UNKNOWN },
          orderBy: { createdAt: 'asc' },
          take: 200,
        }),
      { retries: 3, shouldRetry: shouldRetryDbConnectionError, context: 'terminal-payment-watchdog:findUnknown' },
    )

    let completed = 0
    let marked = 0
    let released = 0
    let reset = 0
    let lateReconciled = 0

    for (const row of rows) {
      const payment = await this.findReconcilablePayment(row)
      if (payment) {
        const r = await prisma.terminalPaymentRequest.updateMany({
          where: { id: row.id, status: TerminalPaymentRequestStatus.UNKNOWN },
          data: { status: TerminalPaymentRequestStatus.COMPLETED, paymentId: payment.id, lateResult: true },
        })
        if (r.count > 0) {
          completed += r.count
          // 🚨 stable token for Better Stack — do NOT rename.
          logger.error(
            `🚨 [Terminal-payment watchdog] Payment recorded for an UNKNOWN request — reconciled to COMPLETED (money moved after the POS gave up)`,
            {
              requestId: row.requestId,
              paymentId: payment.id,
              terminalId: row.terminalId,
              venueId: row.venueId,
            },
          )
          await logAction({
            venueId: row.venueId,
            action: 'TERMINAL_PAYMENT_LATE_RECONCILED',
            entity: 'TerminalPaymentRequest',
            entityId: row.id,
            data: { requestId: row.requestId, terminalId: row.terminalId, paymentId: payment.id, priorStatus: row.status },
          })
        }
        continue
      }

      const terminal = await this.findTerminalForRow(row)
      const lastHeartbeat = terminal?.lastHeartbeat ?? null

      if (!row.terminalReturnedAt) {
        if (lastHeartbeat && lastHeartbeat.getTime() > row.expiresAt.getTime()) {
          // Stamped with the time we OBSERVED it, not the heartbeat's own time: after a server
          // outage the heartbeat may be 10 min old and would otherwise satisfy the grace at once.
          const r = await prisma.terminalPaymentRequest.updateMany({
            where: { id: row.id, status: TerminalPaymentRequestStatus.UNKNOWN, terminalReturnedAt: null },
            data: { terminalReturnedAt: now },
          })
          marked += r.count
        }
        continue
      }

      if (now.getTime() < row.terminalReturnedAt.getTime() + UNKNOWN_AUTO_RELEASE_GRACE_MS) continue

      // The grace only counts if the terminal is STILL here: gone again (or one heartbeat per
      // reboot) means its queue never had the chance to flush → drop the stamp and wait for it.
      if (!lastHeartbeat || lastHeartbeat.getTime() < now.getTime() - TERMINAL_ALIVE_WINDOW_MS) {
        const r = await prisma.terminalPaymentRequest.updateMany({
          where: { id: row.id, status: TerminalPaymentRequestStatus.UNKNOWN, terminalReturnedAt: row.terminalReturnedAt },
          data: { terminalReturnedAt: null },
        })
        reset += r.count
        continue
      }

      const r = await prisma.terminalPaymentRequest.updateMany({
        where: { id: row.id, status: TerminalPaymentRequestStatus.UNKNOWN },
        data: { status: TerminalPaymentRequestStatus.TIMED_OUT, failureCode: 'AUTO_RELEASED' },
      })
      if (r.count === 0) continue // a late result closed it first — its answer wins
      released += r.count

      const ageMinutes = Math.floor((now.getTime() - row.createdAt.getTime()) / 60_000)
      // 🚨 stable token for Better Stack — do NOT rename.
      logger.error(`🚨 [Terminal-payment watchdog] UNKNOWN request auto-released — terminal came back with no card payment`, {
        requestId: row.requestId,
        terminalId: row.terminalId,
        venueId: row.venueId,
        orderId: row.orderId,
        amountCents: row.amountCents,
        terminalReturnedAt: row.terminalReturnedAt.toISOString(),
        ageMinutes,
      })
      await logAction({
        venueId: row.venueId,
        action: 'TERMINAL_PAYMENT_AUTO_RELEASED',
        entity: 'TerminalPaymentRequest',
        entityId: row.id,
        data: {
          requestId: row.requestId,
          terminalId: row.terminalId,
          amountCents: row.amountCents,
          orderId: row.orderId,
          terminalReturnedAt: row.terminalReturnedAt.toISOString(),
          graceMs: UNKNOWN_AUTO_RELEASE_GRACE_MS,
          reason: 'La terminal volvió a reportar y pasaron 20 min sin ningún pago con tarjeta para este cobro',
        },
      })
      void sendOpsAlert({
        subject: `Terminal ${row.terminalId} liberada sola tras un cobro sin respuesta (${row.venueId})`,
        lines: [
          `El cobro de $${(row.amountCents / 100).toFixed(2)} (requestId ${row.requestId}, orden ${row.orderId ?? 'sin orden'}) quedó sin respuesta ${ageMinutes} min.`,
          'La terminal volvió a reportar y en 20 minutos no apareció ningún pago con tarjeta, así que el servidor liberó la terminal. La tablet ya puede volver a cobrar en ella.',
          'Si más tarde llegara un pago de ese cobro, el servidor lo reconcilia como cobrado y avisa con 🚨 (revisar que la orden no quede pagada dos veces).',
        ],
      })
    }

    // Released rows are not forgotten: a payment recorded afterwards WITHOUT the request id (old
    // offline queues) never reaches closeRowFromPaymentTx, and the status endpoint would keep
    // answering "timeout" — an invitation to charge again. Sweep them for a bounded window.
    const releasedRows = await retry(
      () =>
        prisma.terminalPaymentRequest.findMany({
          where: {
            status: TerminalPaymentRequestStatus.TIMED_OUT,
            failureCode: { in: RELEASE_FAILURE_CODES },
            updatedAt: { gte: new Date(now.getTime() - RELEASED_LATE_RECONCILE_WINDOW_MS) },
          },
          orderBy: { updatedAt: 'asc' },
          take: 200,
        }),
      { retries: 3, shouldRetry: shouldRetryDbConnectionError, context: 'terminal-payment-watchdog:findReleased' },
    )
    for (const row of releasedRows) {
      const payment = await this.findReconcilablePayment(row)
      if (!payment) continue
      const r = await prisma.terminalPaymentRequest.updateMany({
        where: { id: row.id, status: TerminalPaymentRequestStatus.TIMED_OUT },
        data: { status: TerminalPaymentRequestStatus.COMPLETED, paymentId: payment.id, lateResult: true },
      })
      if (r.count === 0) continue
      lateReconciled += r.count
      // 🚨 stable token for Better Stack — do NOT rename. This is the double-charge alarm: the slot
      // was freed and the money then showed up → someone must check the order is not paid twice.
      logger.error(
        `🚨 [Terminal-payment watchdog] Payment recorded for a RELEASED request — reconciled to COMPLETED (check the order for a double charge)`,
        {
          requestId: row.requestId,
          paymentId: payment.id,
          terminalId: row.terminalId,
          venueId: row.venueId,
          orderId: row.orderId,
          failureCode: row.failureCode,
        },
      )
      await logAction({
        venueId: row.venueId,
        action: 'TERMINAL_PAYMENT_LATE_RECONCILED',
        entity: 'TerminalPaymentRequest',
        entityId: row.id,
        data: {
          requestId: row.requestId,
          terminalId: row.terminalId,
          paymentId: payment.id,
          priorStatus: row.status,
          failureCode: row.failureCode,
        },
      })
      void sendOpsAlert({
        subject: `Terminal ${row.terminalId}: llegó el pago de un cobro YA liberado — revisar doble cobro (${row.venueId})`,
        lines: [
          `El cobro ${row.requestId} (orden ${row.orderId ?? 'sin orden'}) se había liberado como sin respuesta y ahora aparece un pago con tarjeta (${payment.id}).`,
          'Revisa que la orden no haya quedado pagada dos veces; si sí, hay que devolver uno de los dos cobros.',
        ],
      })
    }

    if (completed || marked || released || reset || lateReconciled) {
      logger.info(`🧹 [Terminal-payment watchdog] unknown sweep`, {
        completed,
        marked,
        released,
        reset,
        lateReconciled,
        scanned: rows.length,
      })
    }
    return { completed, marked, released, reset, lateReconciled }
  }

  /**
   * Manual release (MCP / superadmin / a manager on the tablet). Same money rule as the
   * watchdog: if a reconcilable card payment exists the row is closed as COMPLETED and NOT
   * released — nobody frees a slot on top of money. Tenant-scoped by venueId in every query.
   */
  async releaseUnknownRequest(input: {
    requestId: string
    venueId: string
    actor: { staffId?: string | null; source: 'MCP' | 'SUPERADMIN' | 'MOBILE' }
    reason: string
  }): Promise<{ requestId: string; released: boolean; status: TerminalPaymentRequestStatus | null; paymentId?: string }> {
    const { requestId, venueId, actor, reason } = input
    const row = await prisma.terminalPaymentRequest.findFirst({ where: { requestId, venueId } })
    if (!row) return { requestId, released: false, status: null }
    if (row.status !== TerminalPaymentRequestStatus.UNKNOWN) {
      return { requestId, released: false, status: row.status, paymentId: row.paymentId ?? undefined }
    }

    const payment = await this.findReconcilablePayment(row)
    if (payment) {
      const rc = await prisma.terminalPaymentRequest.updateMany({
        where: { id: row.id, venueId, status: TerminalPaymentRequestStatus.UNKNOWN },
        data: { status: TerminalPaymentRequestStatus.COMPLETED, paymentId: payment.id, lateResult: true },
      })
      if (rc.count === 0) {
        // Someone else closed it first (late socket result / REST record): report what it became.
        const fresh = await prisma.terminalPaymentRequest.findFirst({
          where: { requestId, venueId },
          select: { status: true, paymentId: true },
        })
        return { requestId, released: false, status: fresh?.status ?? null, paymentId: fresh?.paymentId ?? undefined }
      }
      logger.error(`🚨 [TerminalPayment] Manual release refused — a card payment exists for the UNKNOWN request; reconciled to COMPLETED`, {
        requestId,
        venueId,
        paymentId: payment.id,
        source: actor.source,
      })
      await logAction({
        staffId: actor.staffId ?? null,
        venueId,
        action: 'TERMINAL_PAYMENT_LATE_RECONCILED',
        entity: 'TerminalPaymentRequest',
        entityId: row.id,
        data: { requestId, terminalId: row.terminalId, paymentId: payment.id, priorStatus: row.status, source: actor.source, reason },
      })
      return { requestId, released: false, status: TerminalPaymentRequestStatus.COMPLETED, paymentId: payment.id }
    }

    const r = await prisma.terminalPaymentRequest.updateMany({
      where: { id: row.id, venueId, status: TerminalPaymentRequestStatus.UNKNOWN },
      data: { status: TerminalPaymentRequestStatus.TIMED_OUT, failureCode: 'MANUAL_RELEASE' },
    })
    if (r.count === 0) {
      const fresh = await prisma.terminalPaymentRequest.findFirst({
        where: { requestId, venueId },
        select: { status: true, paymentId: true },
      })
      return { requestId, released: false, status: fresh?.status ?? null, paymentId: fresh?.paymentId ?? undefined }
    }

    await logAction({
      staffId: actor.staffId ?? null,
      venueId,
      action: 'TERMINAL_PAYMENT_MANUAL_RELEASE',
      entity: 'TerminalPaymentRequest',
      entityId: row.id,
      data: {
        requestId,
        terminalId: row.terminalId,
        amountCents: row.amountCents,
        orderId: row.orderId,
        reason,
        source: actor.source,
      },
    })
    logger.error(`🚨 [TerminalPayment] UNKNOWN request released manually`, {
      requestId,
      venueId,
      terminalId: row.terminalId,
      amountCents: row.amountCents,
      staffId: actor.staffId ?? null,
      source: actor.source,
      reason,
    })
    void sendOpsAlert({
      subject: `Terminal ${row.terminalId} liberada a mano (${venueId})`,
      lines: [
        `Alguien (${actor.source}${actor.staffId ? `, staff ${actor.staffId}` : ''}) liberó el cobro sin respuesta de $${(row.amountCents / 100).toFixed(2)} (requestId ${requestId}). Motivo: ${reason}.`,
        'No existía ningún pago con tarjeta para ese cobro al momento de liberar.',
      ],
    })
    return { requestId, released: true, status: TerminalPaymentRequestStatus.TIMED_OUT }
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
   * Abrir en una terminal la devolución de un cobro con tarjeta.
   *
   * 🔴 Este evento NO autoriza que se mueva dinero: le dice a la terminal
   * "abre la pantalla de devolución de ESTE cobro". Quien la completa es una
   * persona en el aparato, y el registro en Avoqado sigue pasando por la ruta
   * de reembolsos de siempre —con su candado de fila y su validación de monto
   * reembolsable—. Por eso no hace falta una fila durable de arbitraje: si el
   * evento se pierde o se duplica, lo peor que pasa es que se abre una
   * pantalla de más, y ninguna devolución ocurre sin que alguien la confirme.
   */
  async requestRefundOnTerminal(request: TerminalRefundRequest): Promise<TerminalRefundResult> {
    const { terminalId, venueId, paymentId } = request

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, venueId: true, status: true, method: true, amount: true, tipAmount: true, processorData: true },
    })

    const processorData = (payment?.processorData ?? {}) as { refundedAmount?: number | string }
    const target = resolveTerminalRefundTarget(
      payment
        ? {
            id: payment.id,
            venueId: payment.venueId,
            status: payment.status,
            method: payment.method,
            amount: Number(payment.amount),
            tipAmount: Number(payment.tipAmount),
            refundedAmount: Number(processorData.refundedAmount ?? 0),
          }
        : null,
      venueId,
    )

    if (!target.eligible) {
      logger.warn(`🚫 [TerminalRefund] Cobro no elegible para devolución en terminal`, {
        paymentId,
        venueId,
        terminalId,
        reason: target.reason,
      })
      throw new BadRequestError(target.message)
    }

    const terminalEntry = terminalRegistry.getTerminal(terminalId)
    if (!terminalEntry) {
      throw new Error(`La terminal ${terminalId} no está conectada`)
    }
    if (terminalEntry.venueId !== venueId) {
      // Misma defensa que el cobro: nunca se le habla a la terminal de otro negocio.
      throw new BadRequestError('La terminal no pertenece a este establecimiento')
    }
    if (!terminalEntry.socketId) {
      throw new Error(`La terminal ${terminalId} está registrada pero no tiene conexión de socket. Reinicia la app de la terminal.`)
    }
    const socketId = terminalEntry.socketId

    // Una terminal hace UNA transacción EMV a la vez: si está a media venta,
    // abrirle una devolución encima le quitaría la pantalla al cliente que
    // está pagando. Se reporta QUIÉN la tiene ocupada, igual que en el cobro,
    // para que el cajero no se quede adivinando.
    const blocker = await prisma.terminalPaymentRequest.findFirst({
      where: { terminalId: normalizeTerminalId(terminalId), venueId, status: { in: SLOT_HELD } },
      select: { requestId: true, amountCents: true, senderDevice: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    })
    if (blocker) {
      throw new TerminalBusyError(`La terminal ${terminalId} está ocupada con un cobro. Espera a que termine e inténtalo de nuevo.`, {
        requestId: blocker.requestId,
        amountCents: blocker.amountCents,
        senderDevice: blocker.senderDevice ?? undefined,
        ageSeconds: Math.max(0, Math.floor((Date.now() - blocker.createdAt.getTime()) / 1000)),
      })
    }

    const io = socketManager.getServer()
    if (!io) {
      throw new Error('Servidor de Socket.IO no inicializado')
    }

    const requestId = request.requestId || uuidv4()

    return new Promise<TerminalRefundResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRefundRequests.delete(requestId)
        logger.warn(`⏰ [TerminalRefund] La terminal no confirmó que abrió la devolución`, { requestId, terminalId, paymentId })
        resolve({
          requestId,
          status: 'timeout',
          errorMessage: 'La terminal no respondió. Revisa que la app esté abierta.',
        })
      }, REFUND_OPEN_TIMEOUT_MS)

      this.pendingRefundRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        requestId,
        terminalId,
        venueId,
        paymentId,
        createdAt: new Date(),
      })

      io.to(socketId).emit('terminal:refund_request', {
        requestId,
        terminalId,
        venueId,
        paymentId,
        // Informativo para la pantalla de la terminal: lo que manda al validar
        // es el servicio de reembolsos, no este número.
        maxRefundableCents: target.remainingRefundableCents,
        reason: request.reason,
        requestedBy: request.requestedBy,
        timestamp: new Date().toISOString(),
      })
      logger.info(`↩️ [TerminalRefund] Devolución enviada a la terminal`, { requestId, terminalId, paymentId, venueId })
    })
  }

  /**
   * ACK de la terminal: abrió (o no pudo abrir) la pantalla de devolución.
   */
  handleRefundRequestResult(result: TerminalRefundResult): boolean {
    const pending = this.pendingRefundRequests.get(result.requestId)
    if (!pending) {
      logger.warn(`⚠️ [TerminalRefund] Llegó un ACK sin solicitud pendiente`, { requestId: result.requestId })
      return false
    }

    clearTimeout(pending.timeout)
    this.pendingRefundRequests.delete(result.requestId)

    logger.info(`↩️ [TerminalRefund] ACK recibido`, {
      requestId: result.requestId,
      status: result.status,
      terminalId: pending.terminalId,
      paymentId: pending.paymentId,
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
  async cancelPayment(terminalId: string, requestId: string | undefined, reason: string | undefined, venueId: string): Promise<boolean> {
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
          where: { requestId, venueId, status: { in: IN_FLIGHT } },
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
