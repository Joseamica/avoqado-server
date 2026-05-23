/**
 * Superadmin Dashboard Routes
 *
 * Aggregated metrics for the operations home screen.
 * Protected by authenticateTokenMiddleware + authorizeRole([SUPERADMIN])
 * from the parent router (superadmin.routes.ts).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getSuperadminDashboardSummary } from '@/services/superadmin/dashboard.service'

const router = Router()

/**
 * GET /api/v1/superadmin/dashboard/summary
 * Aggregated counters for the dashboard home (venues, terminals, KYC, staff,
 * payments 24h, activity log 24h). Single round-trip.
 */
router.get('/summary', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await getSuperadminDashboardSummary()
    res.json({ success: true, data: summary })
  } catch (error) {
    next(error)
  }
})

export default router
