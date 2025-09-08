import express from 'express'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { authorizeRole } from '@/middlewares/authorizeRole.middleware'
import { validateRequest } from '@/middlewares/validation'
import { analyticsOverviewQuerySchema } from '@/schemas/analytics/analytics.schema'
import { getAnalyticsOverview } from '@/controllers/analytics/overview.analytics.controller'
import { StaffRole } from '@prisma/client'

const router = express.Router()

/**
 * @openapi
 * /api/v1/analytics/overview:
 *   get:
 *     tags: [Analytics]
 *     summary: Executive analytics overview (mocked)
 *     description: Returns KPI deck, visuals, insights, and definitions for the executive overview. Financials may be masked for non-executive roles.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: timeRange
 *         schema: { type: string, enum: ["7d","30d","90d","qtd","ytd","12m"] }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: compareTo
 *         schema: { type: string, enum: ["previous_period","previous_year"] }
 *       - in: query
 *         name: orgId
 *         schema: { type: string }
 *       - in: query
 *         name: venueId
 *         schema: { type: string }
 *       - in: query
 *         name: segments
 *         schema: { type: array, items: { type: string } }
 *       - in: query
 *         name: lang
 *         schema: { type: string, enum: ["en","es"] }
 *         description: Optional UI language for localized labels/messages. Defaults from Accept-Language or 'en'.
 *     responses:
 *       200:
 *         description: Analytics overview payload
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get(
  '/overview',
  authenticateTokenMiddleware,
  // Allow broad read roles; masking applied for non-execs in controller/service
  authorizeRole([StaffRole.SUPERADMIN, StaffRole.OWNER, StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.VIEWER]),
  validateRequest(analyticsOverviewQuerySchema),
  getAnalyticsOverview,
)

export default router
