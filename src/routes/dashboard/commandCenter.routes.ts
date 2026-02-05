/**
 * Command Center Routes (WHITE-LABEL)
 * Provides real-time KPIs, activity feeds, and operational insights
 * for the PlayTelecom/White-Label dashboard.
 *
 * Middleware: verifyAccess with requireWhiteLabel + featureCode
 * - Validates JWT authentication
 * - Ensures WHITE_LABEL_DASHBOARD module is enabled
 * - Checks role-based access to COMMAND_CENTER feature
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { verifyAccess } from '../../middlewares/verifyAccess.middleware'
import { commandCenterService } from '../../services/command-center/commandCenter.service'

// mergeParams: true allows access to :venueId from parent route
const router = Router({ mergeParams: true })

// Feature code for role-based access control
const FEATURE_CODE = 'COMMAND_CENTER'

// Unified middleware for white-label command center routes
const whiteLabelAccess = [authenticateTokenMiddleware, verifyAccess({ featureCode: FEATURE_CODE, requireWhiteLabel: true })]

/**
 * GET /dashboard/command-center/summary
 * Returns: Today's sales, week/month sales, units sold, avg ticket, active promoters
 */
router.get('/summary', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId

    const summary = await commandCenterService.getSummary(venueId)

    res.json({
      success: true,
      data: summary,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/command-center/activity
 * Returns: Recent activity feed (sales, check-ins, deposits)
 * Query: limit (default 20)
 */
router.get('/activity', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { limit = '20' } = req.query

    const activities = await commandCenterService.getActivity(venueId, parseInt(limit as string, 10))

    res.json({
      success: true,
      data: {
        activities,
      },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/command-center/insights
 * Returns: Operational alerts requiring attention (pending deposits, low stock, missing check-ins)
 */
router.get('/insights', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId

    const insights = await commandCenterService.getInsights(venueId)

    res.json({
      success: true,
      data: {
        insights,
      },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/command-center/top-sellers
 * Returns: Top performing sellers today
 * Query: limit (default 5)
 */
router.get('/top-sellers', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { limit = '5' } = req.query

    const sellers = await commandCenterService.getTopSellers(venueId, parseInt(limit as string, 10))

    res.json({
      success: true,
      data: {
        sellers,
      },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/command-center/category-breakdown
 * Returns: Sales breakdown by category with percentages
 */
router.get('/category-breakdown', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId

    const categories = await commandCenterService.getCategoryBreakdown(venueId)

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
 * GET /dashboard/command-center/stock-vs-sales
 * Returns: Sales trend for chart visualization with comparison to previous period
 * Query: days (default 7), startDate (YYYY-MM-DD), endDate (YYYY-MM-DD)
 */
router.get('/stock-vs-sales', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { days, startDate, endDate } = req.query

    const options: { days?: number; startDate?: string; endDate?: string } = {}
    if (days) options.days = parseInt(days as string, 10)
    if (startDate) options.startDate = startDate as string
    if (endDate) options.endDate = endDate as string

    const data = await commandCenterService.getStockVsSales(venueId, options)

    res.json({
      success: true,
      data,
    })
  } catch (error) {
    next(error)
  }
})

export default router
