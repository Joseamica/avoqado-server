/**
 * Stock Dashboard Routes
 * Provides stock metrics, charts, alerts, and bulk upload
 * for the PlayTelecom/White-Label dashboard.
 *
 * These routes are WHITE-LABEL SPECIFIC and completely independent
 * from regular dashboard endpoints.
 *
 * Middleware: verifyAccess with requireWhiteLabel
 * - Validates JWT authentication
 * - Ensures WHITE_LABEL_DASHBOARD module is enabled
 * - Role-based access handled by verifyAccess middleware
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { verifyAccess } from '../../middlewares/verifyAccess.middleware'
import { stockDashboardService } from '../../services/stock-dashboard/stockDashboard.service'
import * as itemCategoryService from '../../services/dashboard/itemCategory.dashboard.service'

// mergeParams: true allows access to :venueId from parent route
const router = Router({ mergeParams: true })

// Unified middleware for white-label stock routes
const whiteLabelStockAccess = [authenticateTokenMiddleware, verifyAccess({ requireWhiteLabel: true })]

/**
 * GET /dashboard/stock/metrics
 * Returns: Total pieces, value, available, sold today/week
 */
router.get('/metrics', whiteLabelStockAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId

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
router.get('/categories', whiteLabelStockAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId

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
router.get('/chart', whiteLabelStockAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
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
router.get('/alerts', whiteLabelStockAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId

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
router.post('/alerts/configure', whiteLabelStockAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
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
})

/**
 * POST /dashboard/stock/bulk-upload
 * Process CSV bulk upload for item registration
 * Body: { categoryId, csvContent }
 */
router.post('/bulk-upload', whiteLabelStockAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req as any).authContext
    const venueId = req.params.venueId || (req as any).authContext?.venueId
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
router.get('/movements', whiteLabelStockAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Use target venueId from URL params
    const venueId = req.params.venueId || (req as any).authContext?.venueId
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

/**
 * GET /dashboard/stock/item-categories
 * Returns: Item categories for white-label dashboard
 * This is a white-label specific endpoint that bypasses checkPermission
 * Query: includeStats (default false)
 */
router.get('/item-categories', whiteLabelStockAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Use target venueId from URL params
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { includeStats } = req.query

    const categories = await itemCategoryService.getItemCategories(venueId, {
      includeStats: includeStats === 'true',
    })

    res.json({
      success: true,
      data: categories,
    })
  } catch (error) {
    next(error)
  }
})

export default router
