import { Request, Response, NextFunction } from 'express'
import * as tpvMessageService from '../../services/tpv/tpv-message.service'
import logger from '../../config/logger'

/**
 * Get pending messages for this terminal
 * GET /api/v1/tpv/messages/pending?terminalId=xxx
 */
export async function getPendingMessages(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = req.authContext?.venueId
    const terminalId = (req.query.terminalId as string) || undefined

    if (!venueId || !terminalId) {
      return res.status(400).json({
        success: false,
        message: 'Missing venueId (from auth) or terminalId (query param)',
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
 * GET /api/v1/tpv/messages/history?terminalId=xxx&limit=50&offset=0
 */
export async function getMessageHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = req.authContext?.venueId
    const terminalId = (req.query.terminalId as string) || undefined

    if (!venueId || !terminalId) {
      return res.status(400).json({
        success: false,
        message: 'Missing venueId (from auth) or terminalId (query param)',
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
    const terminalId = req.body.terminalId || (req.query.terminalId as string) || undefined
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
    const terminalId = req.body.terminalId || (req.query.terminalId as string) || undefined

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
    const terminalId = req.body.terminalId || (req.query.terminalId as string) || undefined
    const { selectedOptions, staffId, staffName } = req.body

    if (!terminalId) {
      return res.status(400).json({
        success: false,
        message: 'Missing terminalId in request body or query param',
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
