/**
 * Stock Dashboard Routes
 * Provides stock metrics, charts, alerts, and bulk upload
 * for the PlayTelecom/White-Label dashboard.
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { stockDashboardService } from '../../services/stock-dashboard/stockDashboard.service'
import { moduleService, MODULE_CODES } from '../../services/modules/module.service'

const router = Router()

/**
 * Middleware to check WHITE_LABEL_DASHBOARD module is enabled
 */
async function checkWhiteLabelModule(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext

    const isEnabled = await moduleService.isModuleEnabled(venueId, MODULE_CODES.WHITE_LABEL_DASHBOARD)
    if (!isEnabled) {
      return res.status(403).json({
        success: false,
        error: 'module_disabled',
        message: 'White-label dashboard module is not enabled for this venue',
      })
    }

    next()
  } catch (error) {
    next(error)
  }
}

/**
 * GET /dashboard/stock/metrics
 * Returns: Total pieces, value, available, sold today/week
 */
router.get('/metrics', authenticateTokenMiddleware, checkWhiteLabelModule, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = (req as any).authContext

    const metrics = await stockDashboardService.getStockMetrics(venueId)

    res.json({
      success: true,
      data: metrics,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/stock/categories
 * Returns: Stock by category with coverage estimation
 */
router.get('/categories', authenticateTokenMiddleware, checkWhiteLabelModule, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = (req as any).authContext

    const categories = await stockDashboardService.getCategoryStock(venueId)

    res.json({
      success: true,
      data: {
        categories,
      },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/stock/chart
 * Returns: Stock vs sales trend for chart visualization
 * Query: days (default 14)
 */
router.get('/chart', authenticateTokenMiddleware, checkWhiteLabelModule, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = (req as any).authContext
    const { days = '14' } = req.query

    const data = await stockDashboardService.getStockVsSales(venueId, parseInt(days as string, 10))

    res.json({
      success: true,
      data: {
        days: data,
      },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/stock/alerts
 * Returns: All low stock alerts
 */
router.get('/alerts', authenticateTokenMiddleware, checkWhiteLabelModule, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = (req as any).authContext

    const alerts = await stockDashboardService.getLowStockAlerts(venueId)

    res.json({
      success: true,
      data: {
        alerts,
      },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /dashboard/stock/alerts/configure
 * Configure stock alert for a category
 * Body: { categoryId, minimumStock, alertEnabled }
 */
router.post(
  '/alerts/configure',
  authenticateTokenMiddleware,
  checkWhiteLabelModule,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { venueId } = (req as any).authContext
      const { categoryId, minimumStock, alertEnabled } = req.body

      if (!categoryId || typeof minimumStock !== 'number') {
        return res.status(400).json({
          success: false,
          error: 'validation_error',
          message: 'categoryId and minimumStock are required',
        })
      }

      const result = await stockDashboardService.configureStockAlert(venueId, categoryId, minimumStock, alertEnabled ?? true)

      res.json({
        success: true,
        data: result,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /dashboard/stock/bulk-upload
 * Process CSV bulk upload for item registration
 * Body: { categoryId, csvContent }
 */
router.post('/bulk-upload', authenticateTokenMiddleware, checkWhiteLabelModule, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, userId } = (req as any).authContext
    const { categoryId, csvContent } = req.body

    if (!categoryId || !csvContent) {
      return res.status(400).json({
        success: false,
        error: 'validation_error',
        message: 'categoryId and csvContent are required',
      })
    }

    const result = await stockDashboardService.processBulkUpload(venueId, categoryId, csvContent, userId)

    res.json({
      success: result.success,
      data: result,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/stock/movements
 * Returns: Recent stock movements (registrations, sales)
 * Query: limit (default 20)
 */
router.get('/movements', authenticateTokenMiddleware, checkWhiteLabelModule, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = (req as any).authContext
    const { limit = '20' } = req.query

    const movements = await stockDashboardService.getRecentMovements(venueId, parseInt(limit as string, 10))

    res.json({
      success: true,
      data: {
        movements,
      },
    })
  } catch (error) {
    next(error)
  }
})

export default router
