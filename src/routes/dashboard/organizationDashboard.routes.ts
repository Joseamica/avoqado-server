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
    const { orgId } = (req as any).authContext
    const requestedOrgId = req.params.orgId

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

export default router
