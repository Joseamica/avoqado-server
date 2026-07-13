/**
 * Terminal Payment Mobile Controller
 *
 * Handles HTTP endpoints for sending payments to TPV terminals via Socket.IO.
 * iOS app calls these endpoints; backend bridges to terminal via socket.
 */

import { Request, Response } from 'express'
import { terminalPaymentService } from '../../services/terminal-payment.service'
import { terminalRegistry } from '../../communication/sockets/terminal-registry'
import logger from '../../config/logger'
import { BadRequestError, TerminalBusyError } from '../../errors/AppError'
import { validateStaffVenue } from '../../utils/staff-venue.util'

/**
 * POST /api/v1/mobile/venues/:venueId/terminal-payment
 *
 * Send a payment request to a specific terminal.
 * Long-polls until the terminal succeeds, is cancelled, or reaches the server timeout.
 */
export async function sendTerminalPayment(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { terminalId, amountCents, tipCents, rating, skipReview, orderId, requestId, processedByStaffId } = req.body
    const userId = (req as any).authContext?.userId

    // Validate required fields
    if (!terminalId || !amountCents) {
      return res.status(400).json({
        success: false,
        message: 'terminalId y amountCents son requeridos',
      })
    }

    if (amountCents <= 0) {
      return res.status(400).json({
        success: false,
        message: 'El monto debe ser mayor a 0',
      })
    }

    // Validate terminal belongs to this venue (registry normalizes AVQD- prefix)
    const terminal = terminalRegistry.getTerminal(terminalId)
    if (terminal && terminal.venueId !== venueId) {
      return res.status(403).json({
        success: false,
        message: 'La terminal no pertenece a este establecimiento',
      })
    }

    let validatedProcessedByStaffId: string | undefined
    if (processedByStaffId) {
      validatedProcessedByStaffId = await validateStaffVenue(processedByStaffId, venueId)
    }

    logger.info(`💳 [API] Terminal payment request`, {
      venueId,
      terminalId,
      amountCents,
      tipCents,
      orderId,
      userId,
      processedByStaffId: validatedProcessedByStaffId,
    })

    const result = await terminalPaymentService.sendPaymentToTerminal({
      terminalId,
      amountCents,
      tipCents,
      rating,
      skipReview: skipReview ?? true,
      orderId,
      venueId,
      requestedBy: userId,
      senderDeviceName: req.headers['x-device-name'] as string | undefined,
      processedByStaffId: validatedProcessedByStaffId,
      requestId, // Client-generated for cancel tracking
    })

    const httpStatus = result.status === 'success' ? 200 : result.status === 'timeout' ? 504 : result.status === 'cancelled' ? 409 : 422

    return res.status(httpStatus).json({
      success: result.status === 'success',
      ...result,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido'

    // Terminal already processing another charge → 409 busy.
    // Body carries status:'failed' so OLD iOS/Desktop clients (which parse the
    // body `status` field, not the HTTP code) degrade safely; NEW clients read
    // `code`/`blockingRequest` to offer "pick another terminal".
    if (error instanceof TerminalBusyError) {
      return res.status(409).json({
        success: false,
        status: 'failed',
        code: 'TERMINAL_BUSY',
        errorMessage: message,
        message,
        blockingRequest: error.details.blockingRequest,
      })
    }

    // Terminal not online → 404
    if (message.includes('no está conectada')) {
      return res.status(404).json({
        success: false,
        message,
      })
    }

    // Terminal registered via HTTP heartbeat but no socket → 422
    if (message.includes('no tiene conexión de socket')) {
      return res.status(422).json({
        success: false,
        message,
      })
    }

    if (error instanceof BadRequestError) {
      return res.status(400).json({
        success: false,
        message,
      })
    }

    logger.error('Error in sendTerminalPayment', {
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
      venueId: req.params.venueId,
      terminalId: req.body.terminalId,
      amountCents: req.body.amountCents,
    })

    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
    })
  }
}

/**
 * POST /api/v1/mobile/venues/:venueId/terminals/:terminalId/print-receipt
 *
 * Send a receipt snapshot to a TPV terminal for physical printing.
 */
export async function printReceiptOnTerminal(req: Request, res: Response) {
  try {
    const { venueId, terminalId } = req.params
    const { requestId, receipt } = req.body
    const userId = (req as any).authContext?.userId

    if (!terminalId || !receipt) {
      return res.status(400).json({
        success: false,
        message: 'terminalId y receipt son requeridos',
      })
    }

    const terminal = terminalRegistry.getTerminal(terminalId)
    if (terminal && terminal.venueId !== venueId) {
      return res.status(403).json({
        success: false,
        message: 'La terminal no pertenece a este establecimiento',
      })
    }

    const result = await terminalPaymentService.printReceiptOnTerminal({
      terminalId,
      venueId,
      requestedBy: userId,
      requestId,
      receipt,
    })

    const httpStatus = result.status === 'success' ? 200 : result.status === 'timeout' ? 504 : 422
    return res.status(httpStatus).json({
      success: result.status === 'success',
      ...result,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido'

    if (message.includes('no está conectada')) {
      return res.status(404).json({ success: false, message })
    }

    if (message.includes('no tiene conexión de socket')) {
      return res.status(422).json({ success: false, message })
    }

    logger.error('Error in printReceiptOnTerminal', {
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
      venueId: req.params.venueId,
      terminalId: req.params.terminalId,
    })

    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
    })
  }
}

/**
 * POST /api/v1/mobile/venues/:venueId/terminal-payment/cancel
 *
 * Cancel a pending terminal payment and notify the terminal.
 * Includes requestId so TPV only cancels if it's still on THAT payment.
 */
export async function cancelTerminalPayment(req: Request, res: Response) {
  try {
    const { terminalId, requestId, reason } = req.body

    if (!terminalId) {
      return res.status(400).json({
        success: false,
        message: 'terminalId is required',
      })
    }

    logger.info(`🚫 [API] Cancel terminal payment request`, {
      terminalId,
      requestId,
      reason,
    })

    const cancelled = await terminalPaymentService.cancelPayment(terminalId, requestId, reason)

    return res.json({
      success: cancelled,
      message: cancelled ? 'Cancelación enviada a la terminal' : 'Terminal no conectada',
    })
  } catch (error) {
    logger.error('Error in cancelTerminalPayment', {
      error: error instanceof Error ? error.message : 'Error desconocido',
    })

    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
    })
  }
}

/**
 * GET /api/v1/mobile/venues/:venueId/terminal-payment/:requestId
 *
 * Status of a terminal payment request (recovery after a dropped long-poll /
 * timeout / network error). Trichotomy the POS relies on:
 *  - 200 + terminal status (COMPLETED/FAILED/CANCELLED/TIMED_OUT/UNKNOWN) → the
 *    real outcome; the client stops and acts on it (never blind-retries).
 *  - 200 + IN_PROGRESS → still running; client keeps polling.
 *  - 404 NOT_FOUND → never persisted → safe to retry with the SAME requestId.
 * Golden rule for clients: on timeout/NetworkError, GET status BEFORE retrying.
 */
export async function getTerminalPaymentStatus(req: Request, res: Response) {
  try {
    const { venueId, requestId } = req.params

    const status = await terminalPaymentService.getPaymentStatus(requestId, venueId)
    if (!status) {
      return res.status(404).json({
        success: false,
        status: 'NOT_FOUND',
        message: 'No existe una solicitud de cobro con ese identificador',
      })
    }

    const inProgress = ['PENDING', 'SENT', 'CANCEL_REQUESTED'].includes(status.status)
    return res.status(200).json({
      success: true,
      inProgress,
      ...status,
    })
  } catch (error) {
    logger.error('Error in getTerminalPaymentStatus', {
      error: error instanceof Error ? error.message : 'Error desconocido',
      venueId: req.params.venueId,
      requestId: req.params.requestId,
    })
    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
    })
  }
}

/**
 * GET /api/v1/mobile/venues/:venueId/terminals/online
 *
 * Returns terminals currently connected via Socket.IO.
 */
export async function getOnlineTerminals(req: Request, res: Response) {
  try {
    const { venueId } = req.params

    // Only payment-capable terminals (have a live socket). A terminal known
    // only via HTTP heartbeat (socketId null) can't be charged, so hiding it
    // here prevents the POS from picking one that would 422.
    const terminals = terminalRegistry.getPaymentReadyTerminals(venueId)
    const busySet = await terminalPaymentService.getBusyTerminalIds(venueId)

    logger.info(`📡 [API] getOnlineTerminals for venue ${venueId}: found ${terminals.length}`, {
      venueId,
      terminalIds: terminals.map(t => t.terminalId),
    })

    return res.json({
      success: true,
      terminals: terminals.map(t => ({
        terminalId: t.terminalId,
        name: t.name || `Terminal ${t.terminalId}`,
        isOnline: true,
        hasSocket: t.socketId !== null,
        busy: busySet.has(t.terminalId),
        lastHeartbeat: t.lastHeartbeat.toISOString(),
        registeredAt: t.registeredAt.toISOString(),
      })),
    })
  } catch (error) {
    logger.error('Error in getOnlineTerminals', {
      error: error instanceof Error ? error.message : 'Error desconocido',
      venueId: req.params.venueId,
    })

    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
    })
  }
}
