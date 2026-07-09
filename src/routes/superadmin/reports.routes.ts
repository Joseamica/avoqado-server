/**
 * Superadmin Ad-Hoc Report Routes
 *
 * Protected by authenticateTokenMiddleware + authorizeRole([SUPERADMIN])
 * from the parent router (superadmin.routes.ts).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { weeklyNewCustomersReportJob } from '../../jobs/weekly-new-customers-report.job'

const router = Router()

/**
 * GET /api/v1/superadmin/reports/weekly-new-customers/preview
 *
 * Computes the "new activated + paid venues" report for the most recently
 * completed Mon-Sun week WITHOUT sending the email — lets a human confirm
 * the real data (from prod, via the deployed app, not a local script) before
 * the recurring Monday send is switched on. See weekly-new-customers-report.job.ts.
 */
router.get('/weekly-new-customers/preview', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await weeklyNewCustomersReportJob.runNow({ previewOnly: true })
    res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
})

export default router
