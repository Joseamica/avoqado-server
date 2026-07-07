/**
 * Cash Out (PlayTelecom) organization routes — org-level config (uniform rate table +
 * active-days calendar) and org-wide withdrawals/report aggregation.
 *
 * Mounted at /dashboard/organizations/:orgId/cash-out from dashboard.routes.ts.
 *
 * Access control:
 * - checkPermission is VENUE-scoped (resolves a venue via :venueId param / x-venue-id
 *   header / JWT) and cannot authorize an org-level action, so it is NOT used here.
 * - requireOrgRole (copied verbatim from organizationStockControl.routes.ts) requires
 *   an active StaffVenue with an allowed role in ANY venue of the target org.
 *   SUPERADMIN bypasses the check entirely.
 * - The SERIALIZED_INVENTORY module gate stays in the service layer
 *   (assertCashOutEnabledForOrg), same as the venue-scoped routes.
 */
import { Router, Request, Response, NextFunction } from 'express'
import { StaffRole } from '@prisma/client'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import prisma from '@/utils/prismaClient'
import { validateRequest } from '@/middlewares/validation'
import * as ctrl from '@/controllers/dashboard/cash-out.dashboard.controller'
import {
  replaceCommissionRatesSchema,
  setActiveDaysSchema,
  listActiveDaysSchema,
  generateReportSchema,
  listWithdrawalsSchema,
} from '@/schemas/dashboard/cash-out.schema'

const router = Router({ mergeParams: true })

/**
 * Builds a role-gate middleware that checks the actor has at least one
 * StaffVenue with one of `allowedRoles` inside the target org. SUPERADMIN
 * bypasses the check entirely.
 */
function requireOrgRole(allowedRoles: StaffRole[], forbiddenMessage: string) {
  return async function (req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, role } = (req as any).authContext ?? {}
      const { orgId } = req.params

      if (role === 'SUPERADMIN') return next()

      if (!userId) {
        return res.status(401).json({ success: false, error: 'unauthorized', message: 'Autenticación requerida' })
      }

      const membership = await prisma.staffVenue.findFirst({
        where: {
          staffId: userId,
          venue: { organizationId: orgId },
          role: { in: allowedRoles },
        },
        select: { id: true },
      })

      if (!membership) {
        return res.status(403).json({ success: false, error: 'forbidden', message: forbiddenMessage })
      }

      next()
    } catch (err) {
      next(err)
    }
  }
}

const MANAGE_ROLES: StaffRole[] = [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER, StaffRole.SUPERADMIN]
const FORBIDDEN = 'No tienes permisos para gestionar comisiones de esta organización.'

router.get('/commission-rates', authenticateTokenMiddleware, requireOrgRole(MANAGE_ROLES, FORBIDDEN), ctrl.getOrgCommissionRates)
router.put(
  '/commission-rates',
  authenticateTokenMiddleware,
  requireOrgRole(MANAGE_ROLES, FORBIDDEN),
  validateRequest(replaceCommissionRatesSchema),
  ctrl.putOrgCommissionRates,
)

router.get(
  '/active-days',
  authenticateTokenMiddleware,
  requireOrgRole(MANAGE_ROLES, FORBIDDEN),
  validateRequest(listActiveDaysSchema),
  ctrl.getOrgActiveDays,
)
router.put(
  '/active-days',
  authenticateTokenMiddleware,
  requireOrgRole(MANAGE_ROLES, FORBIDDEN),
  validateRequest(setActiveDaysSchema),
  ctrl.putOrgActiveDays,
)

router.get(
  '/withdrawals',
  authenticateTokenMiddleware,
  requireOrgRole(MANAGE_ROLES, FORBIDDEN),
  validateRequest(listWithdrawalsSchema),
  ctrl.getOrgWithdrawals,
)

router.post(
  '/report',
  authenticateTokenMiddleware,
  requireOrgRole(MANAGE_ROLES, FORBIDDEN),
  validateRequest(generateReportSchema),
  ctrl.postOrgReport,
)

export default router
