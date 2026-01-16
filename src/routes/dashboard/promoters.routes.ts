/**
 * Promoters Audit Routes
 * Provides promoter tracking, attendance, sales stats, and deposit management
 * for the PlayTelecom/White-Label dashboard.
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { promotersService } from '../../services/promoters/promoters.service'
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
 * GET /dashboard/promoters
 * Returns: List of promoters with today's stats
 */
router.get('/', authenticateTokenMiddleware, checkWhiteLabelModule, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = (req as any).authContext

    const data = await promotersService.getPromotersList(venueId)

    res.json({
      success: true,
      data,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/promoters/:promoterId
 * Returns: Detailed promoter info with performance history
 */
router.get('/:promoterId', authenticateTokenMiddleware, checkWhiteLabelModule, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = (req as any).authContext
    const { promoterId } = req.params

    const data = await promotersService.getPromoterDetail(venueId, promoterId)

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Promoter not found',
      })
    }

    res.json({
      success: true,
      data,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/promoters/:promoterId/deposits
 * Returns: Deposits for validation
 * Query: status (optional, filter by PENDING, APPROVED, REJECTED)
 */
router.get(
  '/:promoterId/deposits',
  authenticateTokenMiddleware,
  checkWhiteLabelModule,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { venueId } = (req as any).authContext
      const { promoterId } = req.params
      const { status } = req.query

      const deposits = await promotersService.getPromoterDeposits(venueId, promoterId, status as any)

      res.json({
        success: true,
        data: {
          deposits,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /dashboard/promoters/:promoterId/deposits/:depositId/approve
 * Approve a pending deposit
 */
router.post(
  '/:promoterId/deposits/:depositId/approve',
  authenticateTokenMiddleware,
  checkWhiteLabelModule,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { venueId, userId } = (req as any).authContext
      const { depositId } = req.params

      const result = await promotersService.approveDeposit(venueId, depositId, userId)

      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: 'approval_failed',
          message: result.error,
        })
      }

      res.json({
        success: true,
        message: 'Deposit approved successfully',
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /dashboard/promoters/:promoterId/deposits/:depositId/reject
 * Reject a pending deposit
 * Body: { reason: string }
 */
router.post(
  '/:promoterId/deposits/:depositId/reject',
  authenticateTokenMiddleware,
  checkWhiteLabelModule,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { venueId } = (req as any).authContext
      const { depositId } = req.params
      const { reason } = req.body

      if (!reason || typeof reason !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'validation_error',
          message: 'Rejection reason is required',
        })
      }

      const result = await promotersService.rejectDeposit(venueId, depositId, reason)

      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: 'rejection_failed',
          message: result.error,
        })
      }

      res.json({
        success: true,
        message: 'Deposit rejected successfully',
      })
    } catch (error) {
      next(error)
    }
  },
)

export default router
