/**
 * Org-scoped sale verification dashboard routes (PlayTelecom "Ventas" view).
 *
 * Mounted at /dashboard/organizations/:orgId/sale-verifications from
 * dashboard.routes.ts. Provides cross-venue listings, summary, chart
 * aggregations, and the back-office approve/reject endpoint.
 *
 * Pipeline per endpoint: authenticateToken → checkOrgAccess → checkPermission → controller
 */

import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import * as ctrl from '../../controllers/dashboard/sale-verification.org.dashboard.controller'

const router = Router({ mergeParams: true })

/**
 * Middleware: verify the authed staff has access to the requested org.
 * SUPERADMIN bypasses. Other users must have orgId in their authContext.
 */
async function checkOrgAccess(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId: authOrgId, role } = (req as any).authContext ?? {}
    const requestedOrgId = req.params.orgId

    if (role === 'SUPERADMIN') return next()

    if (!authOrgId || authOrgId !== requestedOrgId) {
      return res.status(403).json({
        success: false,
        error: 'access_denied',
        message: 'You do not have access to this organization',
      })
    }

    next()
  } catch (err) {
    next(err)
  }
}

router.use(authenticateTokenMiddleware)
router.use(checkOrgAccess)

router.get('/', checkPermission('sale-verifications:review'), ctrl.listOrgSaleVerifications)
router.get('/summary', checkPermission('sale-verifications:review'), ctrl.getOrgSalesSummary)
router.get('/by-month', checkPermission('sale-verifications:review'), ctrl.getSalesByMonth)
router.get('/by-sim-type', checkPermission('sale-verifications:review'), ctrl.getSalesBySimType)
router.get('/by-week', checkPermission('sale-verifications:review'), ctrl.getSalesByWeek)
router.get('/by-city', checkPermission('sale-verifications:review'), ctrl.getSalesByCity)
router.get('/by-supervisor', checkPermission('sale-verifications:review'), ctrl.getSalesBySupervisor)
router.get('/by-store', checkPermission('sale-verifications:review'), ctrl.getSalesByStore)

router.patch('/:id/review', checkPermission('sale-verifications:review'), ctrl.reviewOrgSaleVerification)
router.post('/:id/reopen', checkPermission('sale-verifications:reopen'), ctrl.reopenOrgSaleVerification)

export default router
