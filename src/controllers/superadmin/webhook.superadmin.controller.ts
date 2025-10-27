/**
 * Webhook Monitoring Controller (SUPERADMIN)
 *
 * HTTP-agnostic controller for webhook monitoring endpoints
 */

import { Request, Response, NextFunction } from 'express'
import { WebhookEventStatus } from '@prisma/client'
import webhookService from '@/services/superadmin/webhook.superadmin.service'
import logger from '@/config/logger'

/**
 * List webhook events
 * GET /api/v1/superadmin/webhooks
 */
export async function listWebhookEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { eventType, status, venueId, startDate, endDate, limit = '50', offset = '0' } = req.query

    const filters = {
      eventType: eventType as string | undefined,
      status: status as WebhookEventStatus | undefined,
      venueId: venueId as string | undefined,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
      limit: parseInt(limit as string, 10),
      offset: parseInt(offset as string, 10),
    }

    const result = await webhookService.listWebhookEvents(filters)

    res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    logger.error('Error listing webhook events', {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    next(error)
  }
}

/**
 * Get webhook event details
 * GET /api/v1/superadmin/webhooks/:eventId
 */
export async function getWebhookEventDetails(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { eventId } = req.params

    const event = await webhookService.getWebhookEventDetails(eventId)

    res.json({
      success: true,
      data: event,
    })
  } catch (error) {
    logger.error('Error getting webhook event details', {
      eventId: req.params.eventId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    next(error)
  }
}

/**
 * Get webhook metrics
 * GET /api/v1/superadmin/webhooks/metrics
 */
export async function getWebhookMetrics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { startDate, endDate } = req.query

    // Default to last 7 days if not provided
    const end = endDate ? new Date(endDate as string) : new Date()
    const start = startDate ? new Date(startDate as string) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

    const metrics = await webhookService.getWebhookMetrics({
      startDate: start,
      endDate: end,
    })

    res.json({
      success: true,
      data: metrics,
    })
  } catch (error) {
    logger.error('Error getting webhook metrics', {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    next(error)
  }
}

/**
 * Retry a failed webhook event
 * POST /api/v1/superadmin/webhooks/:eventId/retry
 */
export async function retryWebhookEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { eventId } = req.params

    const result = await webhookService.retryWebhookEvent(eventId)

    res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    logger.error('Error retrying webhook event', {
      eventId: req.params.eventId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })

    // Return error response (don't throw to next - we want controlled error)
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to retry webhook',
    })
  }
}

/**
 * Get list of event types
 * GET /api/v1/superadmin/webhooks/event-types
 */
export async function getEventTypes(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const eventTypes = await webhookService.getEventTypes()

    res.json({
      success: true,
      data: eventTypes,
    })
  } catch (error) {
    logger.error('Error getting event types', {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    next(error)
  }
}

export default {
  listWebhookEvents,
  getWebhookEventDetails,
  getWebhookMetrics,
  retryWebhookEvent,
  getEventTypes,
}
