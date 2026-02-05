/**
 * Promoters Audit Routes (WHITE-LABEL)
 * Provides promoter tracking, attendance, sales stats, and deposit management
 * for the PlayTelecom/White-Label dashboard.
 *
 * Middleware: verifyAccess with requireWhiteLabel + featureCode
 * - Validates JWT authentication
 * - Ensures WHITE_LABEL_DASHBOARD module is enabled
 * - Checks role-based access to PROMOTERS_AUDIT feature
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { verifyAccess } from '../../middlewares/verifyAccess.middleware'
import { promotersService } from '../../services/promoters/promoters.service'

// mergeParams: true allows access to :venueId from parent route
const router = Router({ mergeParams: true })

// Feature code for role-based access control
const FEATURE_CODE = 'PROMOTERS_AUDIT'

// Unified middleware for white-label promoters routes
const whiteLabelAccess = [authenticateTokenMiddleware, verifyAccess({ featureCode: FEATURE_CODE, requireWhiteLabel: true })]

/**
 * GET /dashboard/promoters
 * Returns: List of promoters with today's stats
 */
router.get('/', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId

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
router.get('/:promoterId', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
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
router.get('/:promoterId/deposits', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
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
})

/**
 * POST /dashboard/promoters/:promoterId/deposits/:depositId/approve
 * Approve a pending deposit
 */
router.post('/:promoterId/deposits/:depositId/approve', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req as any).authContext
    const venueId = req.params.venueId || (req as any).authContext?.venueId
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
})

/**
 * POST /dashboard/promoters/:promoterId/deposits/:depositId/reject
 * Reject a pending deposit
 * Body: { reason: string }
 */
router.post('/:promoterId/deposits/:depositId/reject', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
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
})

export default router
