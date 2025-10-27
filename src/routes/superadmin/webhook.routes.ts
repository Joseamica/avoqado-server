/**
 * Webhook Monitoring Routes (SUPERADMIN)
 *
 * All routes are protected by authenticateTokenMiddleware and checkPermission('system:manage')
 * from the parent router (superadmin.routes.ts)
 */

import { Router } from 'express'
import webhookController from '@/controllers/superadmin/webhook.superadmin.controller'

const router = Router()

/**
 * GET /api/v1/superadmin/webhooks
 * List webhook events with filtering
 *
 * Query params:
 * - eventType: string (optional) - Filter by event type (e.g., "customer.subscription.updated")
 * - status: string (optional) - Filter by status (PENDING, SUCCESS, FAILED, RETRYING)
 * - venueId: string (optional) - Filter by venue
 * - startDate: string (optional) - ISO date string
 * - endDate: string (optional) - ISO date string
 * - limit: number (optional) - Items per page (default: 50)
 * - offset: number (optional) - Pagination offset (default: 0)
 */
router.get('/', webhookController.listWebhookEvents)

/**
 * GET /api/v1/superadmin/webhooks/metrics
 * Get webhook health metrics
 *
 * Query params:
 * - startDate: string (optional) - ISO date string (default: 7 days ago)
 * - endDate: string (optional) - ISO date string (default: now)
 */
router.get('/metrics', webhookController.getWebhookMetrics)

/**
 * GET /api/v1/superadmin/webhooks/event-types
 * Get list of available event types for filtering
 */
router.get('/event-types', webhookController.getEventTypes)

/**
 * GET /api/v1/superadmin/webhooks/:eventId
 * Get detailed information about a specific webhook event
 *
 * Path params:
 * - eventId: string - WebhookEvent ID
 */
router.get('/:eventId', webhookController.getWebhookEventDetails)

/**
 * POST /api/v1/superadmin/webhooks/:eventId/retry
 * Retry a failed webhook event
 *
 * Path params:
 * - eventId: string - WebhookEvent ID
 */
router.post('/:eventId/retry', webhookController.retryWebhookEvent)

export default router
