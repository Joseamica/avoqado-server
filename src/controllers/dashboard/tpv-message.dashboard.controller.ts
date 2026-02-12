import { Request, Response, NextFunction } from 'express'
import * as tpvMessageService from '../../services/tpv/tpv-message.service'
import { broadcastTpvMessage } from '../../communication/sockets'
import logger from '../../config/logger'

/**
 * Create and send a TPV message to terminals
 * POST /api/v1/dashboard/venues/:venueId/messages
 */
export async function createMessage(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const {
      type,
      title,
      body,
      priority,
      requiresAck,
      surveyOptions,
      surveyMultiSelect,
      actionLabel,
      actionType,
      actionPayload,
      targetType,
      targetTerminalIds,
      scheduledFor,
      expiresAt,
    } = req.body

    // Get creator info from auth context
    const createdBy = (req as any).user?.staffId || (req as any).user?.id || 'unknown'
    const createdByName = (req as any).user?.firstName
      ? `${(req as any).user.firstName} ${(req as any).user.lastName || ''}`.trim()
      : 'Admin'

    logger.info(`📨 Creating TPV message: "${title}" (${type}) for venue ${venueId}`, {
      venueId,
      type,
      targetType,
      createdBy,
    })

    const message = await tpvMessageService.createMessage({
      venueId,
      type,
      title,
      body,
      priority,
      requiresAck,
      surveyOptions,
      surveyMultiSelect,
      actionLabel,
      actionType,
      actionPayload,
      targetType,
      targetTerminalIds,
      scheduledFor,
      expiresAt,
      createdBy,
      createdByName,
    })

    // Broadcast via Socket.IO if not scheduled for later
    if (!scheduledFor) {
      broadcastTpvMessage(venueId, message)
    }

    res.status(201).json({
      success: true,
      data: message,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * List messages for a venue (paginated)
 * GET /api/v1/dashboard/venues/:venueId/messages
 */
export async function getMessages(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { status, type, limit, offset } = req.query

    const result = await tpvMessageService.getMessages({
      venueId,
      status: status as any,
      type: type as string | undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
    })

    res.status(200).json({
      success: true,
      data: result.messages,
      meta: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get a single message with delivery status
 * GET /api/v1/dashboard/venues/:venueId/messages/:messageId
 */
export async function getMessage(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, messageId } = req.params

    const message = await tpvMessageService.getMessageWithStatus(messageId, venueId)

    res.status(200).json({
      success: true,
      data: message,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get survey responses for a message
 * GET /api/v1/dashboard/venues/:venueId/messages/:messageId/responses
 */
export async function getMessageResponses(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, messageId } = req.params

    const result = await tpvMessageService.getMessageResponses(messageId, venueId)

    res.status(200).json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Cancel an active message
 * DELETE /api/v1/dashboard/venues/:venueId/messages/:messageId
 */
export async function cancelMessage(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, messageId } = req.params

    const message = await tpvMessageService.cancelMessage(messageId, venueId)

    // Broadcast cancellation via Socket.IO
    broadcastTpvMessageCancelled(venueId, messageId)

    res.status(200).json({
      success: true,
      data: message,
    })
  } catch (error) {
    next(error)
  }
}

// Import from sockets index is done at file level; this is a local helper
function broadcastTpvMessageCancelled(venueId: string, messageId: string) {
  try {
    const { getSocketManager } = require('../../communication/sockets')
    const socketManager = getSocketManager()
    if (socketManager.getServer()) {
      socketManager.broadcastToVenue(venueId, 'tpv_message_cancelled' as any, {
        messageId,
        venueId,
        timestamp: new Date().toISOString(),
      })
    }
  } catch (error) {
    logger.error('Error broadcasting TPV message cancellation', {
      venueId,
      messageId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}
