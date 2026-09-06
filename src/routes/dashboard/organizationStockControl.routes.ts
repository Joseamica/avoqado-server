/**
 * Organization Stock Control Routes
 *
 * Org-level endpoints for the Control de Stock dashboard.
 * Mounted at /dashboard/organizations/:orgId from dashboard.routes.ts
 *
 * Access control:
 * - Authenticated user (authenticateTokenMiddleware)
 * - Read endpoints: TWO gates, and las dos hacen falta:
 *     1. rol administrativo en la organización (OWNER / ADMIN / MANAGER), probado contra
 *        `StaffVenue` en la base — NUNCA contra el rol del token;
 *     2. el permiso canónico `inventory:read` evaluado en el venue activo (PermissionSet y
 *        overrides por persona).
 *   🔴 El permiso SOLO no basta: `inventory:read` lo resuelven también CASHIER, WAITER y KITCHEN
 *   por la dependencia `orders:create → inventory:read` (`src/lib/permissions.ts`), y con él un
 *   promotor de PlayTelecom leía la custodia de SIMs (ICCID + nombres de supervisores y
 *   promotores) de TODA la organización. Es la misma familia que el P1 de `tpv-time-entries:write`:
 *   un permiso que ya tienen roles de piso nunca gobierna una lectura administrativa por sí solo.
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
export function requireOrgRole(allowedRoles: StaffRole[], forbiddenMessage: string) {
  const gate = async function (req: Request, res: Response, next: NextFunction) {
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
  // Marcador para las pruebas de estructura de rutas (igual que `requiredPermission` en
  // `checkPermission`): así una prueba puede afirmar que el gate de rol sigue montado.
  ;(gate as any).requiredOrgRoles = allowedRoles
  return gate
}

export const ORG_STOCK_READER_ROLES: StaffRole[] = [StaffRole.OWNER, StaffRole.ADMIN, StaffRole.MANAGER]

const requireOrgOwner = requireOrgRole([StaffRole.OWNER], 'Solo los propietarios de la organización pueden ver esta sección')
/** Gate de ROL de las lecturas org-wide: dueños, administradores y supervisores. */
export const requireOrgStockRole = requireOrgRole(
  ORG_STOCK_READER_ROLES,
  'Solo los propietarios, administradores y supervisores de la organización pueden ver el control de stock',
)
/**
 * Las lecturas llevan los DOS gates en este orden: primero el rol (barato, y el que de verdad
 * acota a quién le toca), después el permiso canónico en el venue activo.
 */
const requireOrgStockReader = [requireOrgStockRole, checkPermission('inventory:read')]

router.get('/stock-control/overview', authenticateTokenMiddleware, requireVenueInTargetOrg, requireOrgStockReader, getOrgStockOverview)
router.get('/stock-control/summary', authenticateTokenMiddleware, requireVenueInTargetOrg, requireOrgStockReader, getOrgStockSummary)
router.get('/stock-control/items', authenticateTokenMiddleware, requireVenueInTargetOrg, requireOrgStockReader, getOrgStockItems)
router.get('/stock-control/custody', authenticateTokenMiddleware, requireVenueInTargetOrg, requireOrgStockReader, getOrgStockCustody)
router.get('/stock-control/bulk-groups', authenticateTokenMiddleware, requireVenueInTargetOrg, requireOrgStockReader, getOrgStockBulkGroups)
router.get('/stock-control/export.xlsx', authenticateTokenMiddleware, requireOrgOwner, exportOrgStockExcel)

// Tabla Ciudad › Supervisor › Promotor. Mismos DOS gates que /overview: los Supervisores
// (MANAGER) tienen que poder consultarla para auditar físicamente a sus promotores en tienda,
// y los promotores (WAITER/CASHIER) no la ven aunque su rol resuelva `inventory:read`.
router.get(
  '/stock-control/by-responsible',
  authenticateTokenMiddleware,
  requireVenueInTargetOrg,
  requireOrgStockReader,
  getOrgInventoryByResponsible,
)

export default router
