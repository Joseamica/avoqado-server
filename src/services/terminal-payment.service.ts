/**
 * Terminal Payment Service
 *
 * Bridges iOS HTTP requests to TPV terminals via Socket.IO.
 * iOS sends POST → backend holds connection → emits to terminal →
 * terminal processes payment → emits result → backend resolves HTTP response.
 *
 * Uses a pending payment store with 60-second TTL.
 */

import { v4 as uuidv4 } from 'uuid'
import { terminalRegistry } from '../communication/sockets/terminal-registry'
import socketManager from '../communication/sockets/managers/socketManager'
import logger from '../config/logger'

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
}

export interface TerminalPaymentResult {
  requestId: string
  status: 'success' | 'failed' | 'timeout'
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

interface PendingPayment {
  resolve: (result: TerminalPaymentResult) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  requestId: string
  terminalId: string
  venueId: string
  createdAt: Date
}

const PAYMENT_TIMEOUT_MS = 60_000 // 60 seconds

class TerminalPaymentService {
  private pendingPayments = new Map<string, PendingPayment>()

  /**
   * Send a payment request to a terminal and wait for the result.
   * Returns a Promise that resolves when the terminal responds or times out.
   */
  async sendPaymentToTerminal(request: TerminalPaymentRequest): Promise<TerminalPaymentResult> {
    const { terminalId, venueId } = request

    // Look up terminal (registry normalizes AVQD- prefix automatically)
    const terminalEntry = terminalRegistry.getTerminal(terminalId)
    if (!terminalEntry) {
      throw new Error(`Terminal ${terminalId} is not online`)
    }
    const socketId = terminalEntry.socketId
    if (!socketId) {
      throw new Error(`Terminal ${terminalId} is online but has no socket connection`)
    }

    const requestId = uuidv4()

    logger.info(`💳 [TerminalPayment] Sending payment request to terminal`, {
      requestId,
      terminalId,
      venueId,
      amountCents: request.amountCents,
      tipCents: request.tipCents,
      orderId: request.orderId,
    })

    // Emit to the specific terminal's socket
    const io = socketManager.getServer()
    if (!io) {
      throw new Error('Socket.IO server not initialized')
    }

    return new Promise<TerminalPaymentResult>((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingPayments.delete(requestId)
        logger.warn(`⏰ [TerminalPayment] Request timed out`, { requestId, terminalId })
        resolve({
          requestId,
          status: 'timeout',
          errorMessage: 'Terminal did not respond within 60 seconds',
        })
      }, PAYMENT_TIMEOUT_MS)

      // Store pending payment
      this.pendingPayments.set(requestId, {
        resolve,
        reject,
        timeout,
        requestId,
        terminalId,
        venueId,
        createdAt: new Date(),
      })

      // Emit directly to the terminal's socket
      const paymentPayload = {
        requestId,
        terminalId,
        amountCents: request.amountCents,
        tipCents: request.tipCents ?? 0,
        rating: request.rating,
        skipReview: request.skipReview ?? true,
        orderId: request.orderId,
        senderDeviceName: request.senderDeviceName,
        venueId,
        timestamp: new Date().toISOString(),
      }

      io.to(socketId).emit('terminal:payment_request', paymentPayload)
      logger.info(`📡 [TerminalPayment] Emitted to socket ${socketId}`, { requestId, terminalId })
    })
  }

  /**
   * Handle payment result from a terminal.
   * Called when the terminal emits 'terminal:payment_result'.
   */
  handlePaymentResult(result: TerminalPaymentResult): boolean {
    const pending = this.pendingPayments.get(result.requestId)
    if (!pending) {
      logger.warn(`⚠️ [TerminalPayment] No pending payment for requestId`, {
        requestId: result.requestId,
      })
      return false
    }

    // Clean up
    clearTimeout(pending.timeout)
    this.pendingPayments.delete(result.requestId)

    logger.info(`✅ [TerminalPayment] Payment result received`, {
      requestId: result.requestId,
      status: result.status,
      transactionId: result.transactionId,
      terminalId: pending.terminalId,
    })

    // Resolve the pending Promise → HTTP response returns to iOS
    pending.resolve(result)
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
