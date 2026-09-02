/**
 * Organization Stock Control Routes
 *
 * Org-level endpoints for the Control de Stock dashboard.
 * Mounted at /dashboard/organizations/:orgId from dashboard.routes.ts
 *
 * Access control:
 * - Authenticated user (authenticateTokenMiddleware)
 * - Read endpoints: canonical `inventory:read` permission evaluated in the active
 *   venue (including PermissionSet and per-staff overrides).
 * - /export.xlsx: OWNER + SUPERADMIN — exporting full inventory stays admin-only.
 * - Org has SERIALIZED_INVENTORY enabled at organization or venue level (checked in controller).
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { checkPermission, resolveRequestVenueId } from '../../middlewares/checkPermission.middleware'
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
 * Org routes do not carry `:venueId`, so first prove that the active venue context
 * belongs to the requested organization. `checkPermission` then evaluates the
 * actual StaffVenue, PermissionSet and role overrides in that venue.
 */
export async function requireVenueInTargetOrg(req: Request, res: Response, next: NextFunction) {
  try {
    const authContext = (req as any).authContext ?? {}
    const { orgId } = req.params

    // The token role is not authorization. Confirm the global role in DB, then
    // preserve the historical cross-organization SUPERADMIN behavior.
    if (authContext.userId) {
      const superAdminMembership = await prisma.staffVenue.findFirst({
        where: { staffId: authContext.userId, role: StaffRole.SUPERADMIN },
        select: { id: true },
      })
      if (superAdminMembership) return next()
    }

    const venueId = resolveRequestVenueId(req, authContext)

    if (!venueId) {
      return res.status(400).json({ success: false, error: 'bad_request', message: 'Venue activo requerido' })
    }

    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
    if (!venue || venue.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'El venue activo no pertenece a esta organización' })
    }

    next()
  } catch (err) {
    next(err)
  }
}

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
          active: true,
          staff: { active: true },
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
const requireOrgStockReader = checkPermission('inventory:read')

router.get('/stock-control/overview', authenticateTokenMiddleware, requireVenueInTargetOrg, requireOrgStockReader, getOrgStockOverview)
router.get('/stock-control/summary', authenticateTokenMiddleware, requireVenueInTargetOrg, requireOrgStockReader, getOrgStockSummary)
router.get('/stock-control/items', authenticateTokenMiddleware, requireVenueInTargetOrg, requireOrgStockReader, getOrgStockItems)
router.get('/stock-control/custody', authenticateTokenMiddleware, requireVenueInTargetOrg, requireOrgStockReader, getOrgStockCustody)
router.get('/stock-control/bulk-groups', authenticateTokenMiddleware, requireVenueInTargetOrg, requireOrgStockReader, getOrgStockBulkGroups)
router.get('/stock-control/export.xlsx', authenticateTokenMiddleware, requireOrgOwner, exportOrgStockExcel)

// Tabla Ciudad › Supervisor › Promotor. Mismo gate de lectura que /overview:
// los Supervisores (MANAGER) tienen que poder consultarla y exportarla para
// auditar físicamente a sus promotores en tienda.
router.get('/stock-control/by-responsible', authenticateTokenMiddleware, requireVenueInTargetOrg, requireOrgStockReader, getOrgInventoryByResponsible)

export default router
