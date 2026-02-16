import { Request, Response, NextFunction } from 'express'
import * as tpvMessageService from '../../services/tpv/tpv-message.service'
import logger from '../../config/logger'

/**
 * Get pending messages for this terminal
 * GET /api/v1/tpv/messages/pending
 */
export async function getPendingMessages(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = (req as any).user?.venueId
    const terminalId = (req as any).user?.terminalId

    if (!venueId || !terminalId) {
      return res.status(400).json({
        success: false,
        message: 'Missing venueId or terminalId in auth context',
      })
    }

    const messages = await tpvMessageService.getPendingMessages(terminalId, venueId)

    res.status(200).json({
      success: true,
      data: messages,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get message history for this terminal (all messages, including handled)
 * GET /api/v1/tpv/messages/history
 */
export async function getMessageHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = (req as any).user?.venueId
    const terminalId = (req as any).user?.terminalId

    if (!venueId || !terminalId) {
      return res.status(400).json({
        success: false,
        message: 'Missing venueId or terminalId in auth context',
      })
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100)
    const offset = parseInt(req.query.offset as string) || 0

    const result = await tpvMessageService.getTerminalMessageHistory(terminalId, venueId, limit, offset)

    res.status(200).json({
      success: true,
      ...result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Acknowledge a message
 * POST /api/v1/tpv/messages/:messageId/acknowledge
 */
export async function acknowledgeMessage(req: Request, res: Response, next: NextFunction) {
  try {
    const { messageId } = req.params
    const terminalId = (req as any).user?.terminalId
    const staffId = req.body.staffId

    logger.info(`📨 TPV message acknowledge via REST: ${messageId}`, {
      messageId,
      terminalId: terminalId || 'N/A',
      staffId,
    })

    const delivery = await tpvMessageService.acknowledgeMessage(messageId, terminalId, staffId)

    res.status(200).json({
      success: true,
      data: delivery,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Dismiss a message
 * POST /api/v1/tpv/messages/:messageId/dismiss
 */
export async function dismissMessage(req: Request, res: Response, next: NextFunction) {
  try {
    const { messageId } = req.params
    const terminalId = (req as any).user?.terminalId

    logger.info(`📨 TPV message dismiss via REST: ${messageId}`, {
      messageId,
      terminalId: terminalId || 'N/A',
    })

    const delivery = await tpvMessageService.dismissMessage(messageId, terminalId)

    res.status(200).json({
      success: true,
      data: delivery,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Submit a survey response
 * POST /api/v1/tpv/messages/:messageId/respond
 */
export async function respondToMessage(req: Request, res: Response, next: NextFunction) {
  try {
    const { messageId } = req.params
    const terminalId = (req as any).user?.terminalId
    const { selectedOptions, staffId, staffName } = req.body

    if (!terminalId) {
      return res.status(400).json({
        success: false,
        message: 'Missing terminalId in auth context',
      })
    }

    if (!selectedOptions || !Array.isArray(selectedOptions) || selectedOptions.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'selectedOptions is required and must be a non-empty array',
      })
    }

    logger.info(`📨 TPV survey response via REST: ${messageId}`, {
      messageId,
      terminalId,
      selectedOptions,
    })

    const response = await tpvMessageService.submitResponse(messageId, terminalId, selectedOptions, staffId, staffName)

    res.status(200).json({
      success: true,
      data: response,
    })
  } catch (error) {
    next(error)
  }
}
