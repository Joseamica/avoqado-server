/**
 * Terminal Location Routes (WHITE-LABEL, supervisor-facing)
 * Exposes the "where are my terminals right now" read model
 * (Task 3: getSupervisorTerminalLocations) over REST.
 *
 * Middleware: verifyAccess with requireWhiteLabel
 * - Validates JWT authentication
 * - Ensures WHITE_LABEL_DASHBOARD module is enabled
 * - Role-based access handled by verifyAccess middleware (no featureCode —
 *   'SUPERVISOR_DASHBOARD' is a frontend-only route-guard code, never granted
 *   server-side; mirrors storesAnalysis.routes.ts's whiteLabelAccess)
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { verifyAccess } from '../../middlewares/verifyAccess.middleware'
import { getSupervisorTerminalLocations } from '../../services/promoters/terminalLocation.service'

// mergeParams: true allows access to :venueId from parent route
const router = Router({ mergeParams: true })

// Unified middleware for white-label supervisor routes
const whiteLabelAccess = [authenticateTokenMiddleware, verifyAccess({ requireWhiteLabel: true })]

/**
 * GET /dashboard/venues/:venueId/supervisor/terminals-locations
 * Returns: Latest known position per terminal, scoped to the requester's
 * custody (MANAGER) or the whole venue (ADMIN/OWNER/SUPERADMIN).
 */
router.get('/terminals-locations', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { userId, role } = (req as any).authContext

    const data = await getSupervisorTerminalLocations({
      venueId,
      requesterStaffId: userId,
      requesterRole: role,
    })

    res.json({
      success: true,
      data,
    })
  } catch (error) {
    next(error)
  }
})

export default router
