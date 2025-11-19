/**
 * Session Dashboard Routes - Development Tool
 *
 * ⚠️ DEVELOPMENT ONLY: These routes should NOT be exposed in production.
 *
 * Endpoints for managing checkout sessions during development:
 * - List sessions with filters
 * - View session details
 * - Reset failed sessions
 * - Expire sessions manually
 * - Cleanup old sessions
 *
 * @module routes/sdk/session-dashboard
 */

import { Router } from 'express'
import {
  listSessions,
  getSessionDetails,
  resetSession,
  expireSession,
  cleanupSessions,
  getDashboardStats,
} from '@/controllers/sdk/session-dashboard.sdk.controller'

const router = Router()

/**
 * ⚠️ DEVELOPMENT ONLY ROUTES
 *
 * These endpoints should be disabled in production or protected with authentication.
 */

// Only enable in development/staging
if (process.env.NODE_ENV !== 'production') {
  /**
   * GET /api/v1/sdk/dashboard/stats
   * Get dashboard statistics
   */
  router.get('/stats', getDashboardStats)

  /**
   * GET /api/v1/sdk/dashboard/sessions
   * List all checkout sessions with optional filters
   *
   * Query params:
   * - status: Filter by status (PENDING, PROCESSING, COMPLETED, FAILED, EXPIRED)
   * - merchantId: Filter by ecommerce merchant
   * - limit: Number of sessions to return (default: 50)
   * - offset: Pagination offset (default: 0)
   */
  router.get('/sessions', listSessions)

  /**
   * GET /api/v1/sdk/dashboard/sessions/:sessionId
   * Get single session details
   */
  router.get('/sessions/:sessionId', getSessionDetails)

  /**
   * POST /api/v1/sdk/dashboard/sessions/:sessionId/reset
   * Reset session to PENDING (for retrying failed payments)
   */
  router.post('/sessions/:sessionId/reset', resetSession)

  /**
   * POST /api/v1/sdk/dashboard/sessions/:sessionId/expire
   * Manually expire a session
   */
  router.post('/sessions/:sessionId/expire', expireSession)

  /**
   * DELETE /api/v1/sdk/dashboard/sessions/cleanup
   * Delete old test sessions
   *
   * Query params:
   * - olderThan: Delete sessions older than X hours (default: 24)
   * - status: Only delete sessions with specific status (optional)
   */
  router.delete('/sessions/cleanup', cleanupSessions)
} else {
  // Production: Return 404 for all dashboard routes
  router.all('*', (req, res) => {
    res.status(404).json({
      success: false,
      error: 'Session dashboard is disabled in production',
    })
  })
}

export default router
