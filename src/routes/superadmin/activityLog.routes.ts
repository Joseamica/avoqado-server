/**
 * Superadmin Activity Log Routes
 *
 * Global audit trail — all logs across all venues/organizations.
 * Protected by authenticateTokenMiddleware + authorizeRole([SUPERADMIN])
 * from parent router (superadmin.routes.ts).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import {
  querySuperadminActivityLogs,
  getSuperadminDistinctActions,
  getSuperadminDistinctEntities,
} from '@/services/dashboard/activity-log.service'

const router = Router()

/**
 * GET /api/v1/superadmin/activity-log
 * List all activity logs with filters + pagination
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { organizationId, venueId, staffId, action, entity, search, startDate, endDate, page, pageSize } = req.query

    const result = await querySuperadminActivityLogs({
      organizationId: organizationId as string | undefined,
      venueId: venueId as string | undefined,
      staffId: staffId as string | undefined,
      action: action as string | undefined,
      entity: entity as string | undefined,
      search: search as string | undefined,
      startDate: startDate as string | undefined,
      endDate: endDate as string | undefined,
      page: page ? parseInt(page as string, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize as string, 10) : undefined,
    })

    res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /api/v1/superadmin/activity-log/actions
 * Get distinct action types for filter dropdown
 */
router.get('/actions', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const actions = await getSuperadminDistinctActions()
    res.json({ success: true, data: actions })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /api/v1/superadmin/activity-log/entities
 * Get distinct entity types for filter dropdown
 */
router.get('/entities', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const entities = await getSuperadminDistinctEntities()
    res.json({ success: true, data: entities })
  } catch (error) {
    next(error)
  }
})

export default router
