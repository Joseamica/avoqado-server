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

/**
 * POST /api/v1/mobile/venues/:venueId/terminal-payment
 *
 * Send a payment request to a specific terminal.
 * Long-polls until the terminal responds or 60s timeout.
 */
export async function sendTerminalPayment(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { terminalId, amountCents, tipCents, rating, skipReview, orderId } = req.body
    const userId = (req as any).authContext?.userId

    // Validate required fields
    if (!terminalId || !amountCents) {
      return res.status(400).json({
        success: false,
        message: 'terminalId and amountCents are required',
      })
    }

    if (amountCents <= 0) {
      return res.status(400).json({
        success: false,
        message: 'amountCents must be positive',
      })
    }

    // Validate terminal belongs to this venue (registry normalizes AVQD- prefix)
    const terminal = terminalRegistry.getTerminal(terminalId)
    if (terminal && terminal.venueId !== venueId) {
      return res.status(403).json({
        success: false,
        message: 'Terminal does not belong to this venue',
      })
    }

    logger.info(`💳 [API] Terminal payment request`, {
      venueId,
      terminalId,
      amountCents,
      tipCents,
      orderId,
      userId,
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
    })

    const httpStatus = result.status === 'success' ? 200 : result.status === 'timeout' ? 504 : 422

    return res.status(httpStatus).json({
      success: result.status === 'success',
      ...result,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'

    // Terminal not online → 404
    if (message.includes('not online')) {
      return res.status(404).json({
        success: false,
        message,
      })
    }

    logger.error('Error in sendTerminalPayment', {
      error: message,
      venueId: req.params.venueId,
    })

    return res.status(500).json({
      success: false,
      message: 'Internal server error',
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

    const terminals = terminalRegistry.getOnlineTerminals(venueId)

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
        lastHeartbeat: t.lastHeartbeat.toISOString(),
        registeredAt: t.registeredAt.toISOString(),
      })),
    })
  } catch (error) {
    logger.error('Error in getOnlineTerminals', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params.venueId,
    })

    return res.status(500).json({
      success: false,
      message: 'Internal server error',
    })
  }
}
