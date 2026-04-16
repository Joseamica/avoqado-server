/**
 * Organization Stock Control Routes
 *
 * Org-level endpoints for the Control de Stock dashboard.
 * Mounted at /dashboard/organizations/:orgId from dashboard.routes.ts
 *
 * Access control:
 * - Authenticated user (authenticateTokenMiddleware)
 * - /overview: OWNER + MANAGER (Supervisor) + SUPERADMIN — Supervisors need to
 *   read the same data to drive their own Custodia de SIMs tab at the venue
 *   dashboard (Asana confirmed: "Supervisor puede ver SIMs de otros Supervisores").
 * - /export.xlsx: OWNER + SUPERADMIN — exporting full inventory stays admin-only.
 * - Org has at least one venue with WHITE_LABEL_DASHBOARD enabled (checked in controller).
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import prisma from '../../utils/prismaClient'
import { StaffRole } from '@prisma/client'
import { getOrgStockOverview, exportOrgStockExcel } from '../../controllers/dashboard/organizationStockControl.controller'

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

const requireOrgOwner = requireOrgRole([StaffRole.OWNER], 'Solo los propietarios de la organización pueden ver esta sección')
const requireOrgStockReader = requireOrgRole([StaffRole.OWNER, StaffRole.MANAGER], 'No tienes acceso al inventario de la organización')

router.get('/stock-control/overview', authenticateTokenMiddleware, requireOrgStockReader, getOrgStockOverview)
router.get('/stock-control/export.xlsx', authenticateTokenMiddleware, requireOrgOwner, exportOrgStockExcel)

export default router
