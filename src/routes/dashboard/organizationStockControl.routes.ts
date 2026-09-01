/**
 * Organization Stock Control Routes
 *
 * Org-level endpoints for the Control de Stock dashboard.
 * Mounted at /dashboard/organizations/:orgId from dashboard.routes.ts
 *
 * Access control:
 * - Authenticated user (authenticateTokenMiddleware)
 * - Read endpoints: OWNER + MANAGER (Supervisor) + SUPERADMIN — Supervisors need to
 *   read the same data to drive their own Custodia de SIMs tab at the venue
 *   dashboard (Asana confirmed: "Supervisor puede ver SIMs de otros Supervisores").
 * - /export.xlsx: OWNER + SUPERADMIN — exporting full inventory stays admin-only.
 * - Org has SERIALIZED_INVENTORY enabled at organization or venue level (checked in controller).
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import prisma from '../../utils/prismaClient'
import { StaffRole } from '@prisma/client'
import {
  getOrgStockOverview,
  getOrgStockSummary,
  getOrgStockItems,
  getOrgStockBulkGroups,
  getOrgStockCustody,
  exportOrgStockExcel,
  getOrgInventoryByResponsible,
} from '../../controllers/dashboard/organizationStockControl.controller'

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
router.get('/stock-control/summary', authenticateTokenMiddleware, requireOrgStockReader, getOrgStockSummary)
router.get('/stock-control/items', authenticateTokenMiddleware, requireOrgStockReader, getOrgStockItems)
router.get('/stock-control/custody', authenticateTokenMiddleware, requireOrgStockReader, getOrgStockCustody)
router.get('/stock-control/bulk-groups', authenticateTokenMiddleware, requireOrgStockReader, getOrgStockBulkGroups)
router.get('/stock-control/export.xlsx', authenticateTokenMiddleware, requireOrgOwner, exportOrgStockExcel)

// Tabla Ciudad › Supervisor › Promotor. Mismo gate de lectura que /overview:
// los Supervisores (MANAGER) tienen que poder consultarla y exportarla para
// auditar físicamente a sus promotores en tienda.
router.get('/stock-control/by-responsible', authenticateTokenMiddleware, requireOrgStockReader, getOrgInventoryByResponsible)

export default router
