/**
 * Organization Dashboard Routes
 * Provides organization-level aggregate metrics and vision global
 * for the PlayTelecom/White-Label dashboard.
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { organizationDashboardService } from '../../services/organization-dashboard/organizationDashboard.service'

const router = Router()

/**
 * Middleware to verify user has access to the organization
 */
async function checkOrgAccess(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId, role } = (req as any).authContext
    const requestedOrgId = req.params.orgId

    // SUPERADMIN has access to all organizations
    if (role === 'SUPERADMIN') {
      return next()
    }

    // User must belong to the organization they're querying
    if (orgId !== requestedOrgId) {
      return res.status(403).json({
        success: false,
        error: 'access_denied',
        message: 'You do not have access to this organization',
      })
    }

    next()
  } catch (error) {
    next(error)
  }
}

/**
 * GET /dashboard/organizations/:orgId/vision-global
 * Returns: Aggregate KPIs across all venues in the organization
 */
router.get(
  '/:orgId/vision-global',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params

      const summary = await organizationDashboardService.getVisionGlobalSummary(orgId)

      res.json({
        success: true,
        data: summary,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/store-performance
 * Returns: Store performance ranking
 * Query: limit (default 10)
 */
router.get(
  '/:orgId/store-performance',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params
      const { limit = '10' } = req.query

      const performance = await organizationDashboardService.getStorePerformance(orgId, parseInt(limit as string, 10))

      res.json({
        success: true,
        data: {
          stores: performance,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/anomalies
 * Returns: Cross-store operational anomalies
 */
router.get('/:orgId/anomalies', authenticateTokenMiddleware, checkOrgAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params

    const anomalies = await organizationDashboardService.getCrossStoreAnomalies(orgId)

    res.json({
      success: true,
      data: {
        anomalies,
      },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/organizations/:orgId/managers
 * Returns: List of managers in the organization
 */
router.get('/:orgId/managers', authenticateTokenMiddleware, checkOrgAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params

    const managers = await organizationDashboardService.getOrgManagers(orgId)

    res.json({
      success: true,
      data: {
        managers,
      },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/organizations/:orgId/managers/:managerId
 * Returns: Manager dashboard with assigned stores and metrics
 */
router.get(
  '/:orgId/managers/:managerId',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, managerId } = req.params

      const dashboard = await organizationDashboardService.getManagerDashboard(orgId, managerId)

      if (!dashboard) {
        return res.status(404).json({
          success: false,
          error: 'not_found',
          message: 'Manager not found in this organization',
        })
      }

      res.json({
        success: true,
        data: dashboard,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/staff/online
 * Returns: Online staff count and details (staff with active TimeEntry)
 */
router.get('/:orgId/staff/online', authenticateTokenMiddleware, checkOrgAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params

    const onlineStaff = await organizationDashboardService.getOnlineStaff(orgId)

    res.json({
      success: true,
      data: onlineStaff,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/organizations/:orgId/activity-feed
 * Returns: Real-time activity feed (sales, check-ins, alerts)
 * Query: limit (default 50)
 */
router.get(
  '/:orgId/activity-feed',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params
      const { limit = '50' } = req.query

      const activityFeed = await organizationDashboardService.getActivityFeed(orgId, parseInt(limit as string, 10))

      res.json({
        success: true,
        data: activityFeed,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/stock-summary
 * Returns: Organization-wide stock summary
 */
router.get(
  '/:orgId/stock-summary',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params

      const stockSummary = await organizationDashboardService.getOrgStockSummary(orgId)

      res.json({
        success: true,
        data: stockSummary,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/charts/revenue-vs-target
 * Returns: Revenue vs target chart data for current week
 */
router.get(
  '/:orgId/charts/revenue-vs-target',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params
      const venueId = typeof req.query.venueId === 'string' ? req.query.venueId : undefined
      const chartData = await organizationDashboardService.getRevenueVsTarget(orgId, venueId)

      res.json({
        success: true,
        data: chartData,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/charts/volume-vs-target
 * Returns: Volume vs target chart data for current week
 */
router.get(
  '/:orgId/charts/volume-vs-target',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params
      const venueId = typeof req.query.venueId === 'string' ? req.query.venueId : undefined
      const chartData = await organizationDashboardService.getVolumeVsTarget(orgId, venueId)

      res.json({
        success: true,
        data: chartData,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/insights/top-promoter
 * Returns: Top promoter by sales count today
 */
router.get(
  '/:orgId/insights/top-promoter',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params

      const topPromoter = await organizationDashboardService.getTopPromoter(orgId)

      res.json({
        success: true,
        data: topPromoter,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/insights/worst-attendance
 * Returns: Store with worst attendance (lowest percentage of active staff)
 */
router.get(
  '/:orgId/insights/worst-attendance',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params

      const worstAttendance = await organizationDashboardService.getWorstAttendance(orgId)

      res.json({
        success: true,
        data: worstAttendance,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * PUT /dashboard/organizations/:orgId/goals
 * Update or create goals for a specific period
 * Body: { period, periodDate, salesTarget, volumeTarget }
 */
router.put('/:orgId/goals', authenticateTokenMiddleware, checkOrgAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    const { period, periodDate, salesTarget, volumeTarget } = req.body

    if (!period || !periodDate || !salesTarget || !volumeTarget) {
      return res.status(400).json({
        success: false,
        error: 'missing_fields',
        message: 'period, periodDate, salesTarget, and volumeTarget are required',
      })
    }

    const goal = await organizationDashboardService.updateOrganizationGoal(orgId, period, new Date(periodDate), salesTarget, volumeTarget)

    res.json({
      success: true,
      data: goal,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/organizations/:orgId/staff/attendance
 * Returns: Staff attendance with TimeEntry data for audit
 * Query: date (ISO date), venueId (optional), status (optional: ACTIVE/INACTIVE)
 */
router.get(
  '/:orgId/staff/attendance',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params
      const { date, venueId, status } = req.query

      const attendance = await organizationDashboardService.getStaffAttendance(
        orgId,
        date as string | undefined,
        venueId as string | undefined,
        status as string | undefined,
      )

      res.json({
        success: true,
        data: attendance,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/staff/:staffId/sales-trend
 * Returns: Sales trend for staff member (last 7 days)
 */
router.get(
  '/:orgId/staff/:staffId/sales-trend',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, staffId } = req.params

      const salesTrend = await organizationDashboardService.getStaffSalesTrend(orgId, staffId)

      res.json({
        success: true,
        data: salesTrend,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/staff/:staffId/sales-mix
 * Returns: Sales mix by category for staff member
 */
router.get(
  '/:orgId/staff/:staffId/sales-mix',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, staffId } = req.params

      const salesMix = await organizationDashboardService.getStaffSalesMix(orgId, staffId)

      res.json({
        success: true,
        data: salesMix,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/staff/:staffId/attendance-calendar
 * Returns: Attendance calendar for current month
 */
router.get(
  '/:orgId/staff/:staffId/attendance-calendar',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, staffId } = req.params

      const calendar = await organizationDashboardService.getStaffAttendanceCalendar(orgId, staffId)

      res.json({
        success: true,
        data: calendar,
      })
    } catch (error) {
      next(error)
    }
  },
)

export default router
