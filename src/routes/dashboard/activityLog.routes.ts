/**
 * Activity Log Routes (Dashboard)
 *
 * Base path: /api/v1/dashboard/venues/:venueId/activity-log
 *
 * Authentication is enforced at mount time in `dashboard.routes.ts` via
 * `authenticateTokenMiddleware`. Feature + permission gating applied per-route.
 *
 * Guard order: feature (PRO: VENUE_AUDIT_LOG) → permission (activity:read) → controller.
 *
 * @module routes/dashboard/activityLog
 */

import { Router } from 'express'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { checkFeatureAccess } from '../../middlewares/checkFeatureAccess.middleware'
import { validateRequest } from '../../middlewares/validation'
import { activityLogQuerySchema } from '../../schemas/dashboard/activityLog.schema'
import * as activityLogController from '../../controllers/dashboard/activityLog.dashboard.controller'

const router = Router({ mergeParams: true })

/**
 * GET /api/v1/dashboard/venues/:venueId/activity-log
 * Returns paginated activity log entries for the venue.
 * Requires PRO plan (VENUE_AUDIT_LOG feature) and activity:read permission.
 */
router.get(
  '/',
  checkFeatureAccess('VENUE_AUDIT_LOG'),
  checkPermission('activity:read'),
  validateRequest(activityLogQuerySchema),
  activityLogController.getActivityLog,
)

/**
 * GET /api/v1/dashboard/venues/:venueId/activity-log/actions
 * Returns distinct action values for filter dropdowns.
 */
router.get('/actions', checkFeatureAccess('VENUE_AUDIT_LOG'), checkPermission('activity:read'), activityLogController.getActivityLogActions)

/**
 * GET /api/v1/dashboard/venues/:venueId/activity-log/entities
 * Returns distinct entity values for filter dropdowns.
 */
router.get(
  '/entities',
  checkFeatureAccess('VENUE_AUDIT_LOG'),
  checkPermission('activity:read'),
  activityLogController.getActivityLogEntities,
)

export default router
