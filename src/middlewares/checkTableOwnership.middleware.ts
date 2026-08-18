import { Request, Response, NextFunction } from 'express'
import { StaffRole } from '@prisma/client'
import { evaluatePermissionList, hasPermission } from '@/lib/permissions'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { resolveUserRoleForVenue } from './checkPermission.middleware'

/**
 * Propiedad de mesa — "Solo el propietario puede modificar sus mesas".
 *
 * Con `VenueSettings.enforceTableOwnership` encendido (switch PRO del venue),
 * solo el mesero dueño de la orden (`Order.servedById`) puede mutarla:
 * agregar items, descuentos, cortesías, cargos por servicio, mover, dividir,
 * fusionar, cobrar, cancelar y liberar la mesa. Los demás la ven read-only.
 *
 * Override: permiso `tables:manage-all` (MANAGER+ por default; OWNER/ADMIN via
 * `tables:*`; SUPERADMIN bypass). Espejado por nombre EXACTO en iOS/Android.
 *
 * Solo aplica a órdenes de mesa (`tableId != null`) — ventas de mostrador y
 * cobros rápidos no tienen dueño de mesa. Con el switch apagado (default) el
 * middleware es un no-op de una sola query.
 *
 * Rechazo: 403 con `code: 'TABLE_OWNED_BY_OTHER'` + nombre del dueño, para que
 * los clientes muestren "Mesa de {mesero} — solo lectura" en vez de un error
 * genérico. Corre DESPUÉS de authenticate/checkFeatureAccess/checkPermission.
 */

/**
 * Override por DEFAULT: administrar mesas ajenas de punta a punta (MANAGER+).
 * `tables:pay-any` es el override ACOTADO que sólo monta la ruta de COBRO.
 */
export const DEFAULT_OWNERSHIP_OVERRIDES = ['tables:manage-all'] as const
/** Cobro: la caja liquida cualquier cheque sin poder editarlo (Toast/Square hacen igual). */
export const PAYMENT_OWNERSHIP_OVERRIDES = ['tables:manage-all', 'tables:pay-any'] as const

/**
 * ¿El staff puede saltarse la regla de propiedad en este venue?
 *
 * @param overridePermissions cualquiera de estos permisos exime. Por default sólo
 *        `tables:manage-all`; la ruta de cobro añade `tables:pay-any`.
 */
export async function staffCanManageAllTables(
  userId: string,
  venueId: string,
  tokenVenueId?: string,
  tokenRole?: string,
  overridePermissions: readonly string[] = DEFAULT_OWNERSHIP_OVERRIDES,
  /**
   * La petición en curso, SOLO para que `resolveUserRoleForVenue` memoice y no
   * consulte la base una vez por middleware. Opcional a propósito: el reducer offline
   * (`sync.mobile.service.ts`) llama a esta función SIN request, y ahí no debe haber
   * memoria compartida — cada intent se evalúa por su cuenta.
   */
  req?: Request,
): Promise<boolean> {
  // SUPERADMIN bypass (mismo criterio que checkPermission)
  const superAdminVenue = await prisma.staffVenue.findFirst({
    where: { staffId: userId, role: StaffRole.SUPERADMIN },
    select: { id: true },
  })
  if (superAdminVenue) return true

  const { role: userRole, permissionSet } = await resolveUserRoleForVenue({
    userId,
    targetVenueId: venueId,
    tokenVenueId,
    tokenRole,
    req,
  })
  if (!userRole) return false

  if (permissionSet) {
    return overridePermissions.some(perm => evaluatePermissionList(permissionSet.permissions, perm))
  }

  const venueRolePermission = await prisma.venueRolePermission.findUnique({
    where: { venueId_role: { venueId, role: userRole } },
    select: { permissions: true },
  })
  const customPermissions = venueRolePermission ? (venueRolePermission.permissions as string[]) : null
  return overridePermissions.some(perm => hasPermission(userRole, customPermissions, perm))
}

/** ¿El venue tiene encendida la regla de propiedad de mesa? */
export async function isTableOwnershipEnforced(venueId: string): Promise<boolean> {
  const settings = await prisma.venueSettings.findUnique({
    where: { venueId },
    select: { enforceTableOwnership: true },
  })
  return settings?.enforceTableOwnership === true
}

type OwnershipSource = 'order' | 'table'

/**
 * @param source 'order' = la ruta trae `:orderId`; 'table' = trae `:tableId`
 *               (open/clear) y la regla evalúa la(s) orden(es) abierta(s) de esa mesa.
 * @param overridePermissions permisos que eximen del candado. La ruta de COBRO monta
 *        `PAYMENT_OWNERSHIP_OVERRIDES` para que la caja pueda liquidar un cheque ajeno
 *        sin ganar el derecho a editarlo; todas las demás se quedan con el default.
 */
export const checkTableOwnership = (
  source: OwnershipSource = 'order',
  overridePermissions: readonly string[] = DEFAULT_OWNERSHIP_OVERRIDES,
) => {
  const middleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authContext = (req as any).authContext
      if (!authContext?.userId) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' })
      }

      const venueId = req.params?.venueId
      if (!venueId) {
        return res.status(400).json({ error: 'Bad Request', message: 'Venue ID required' })
      }

      // Switch apagado (default) → no-op.
      if (!(await isTableOwnershipEnforced(venueId))) return next()

      // Dueño(s) de la(s) orden(es) afectada(s).
      let owners: { servedById: string | null; servedBy: { firstName: string; lastName: string } | null }[] = []
      if (source === 'order') {
        const orderId = req.params?.orderId
        if (!orderId) return next() // ruta mal cableada — que el controller responda
        const order = await prisma.order.findFirst({
          where: { id: orderId, venueId },
          select: {
            tableId: true,
            servedById: true,
            servedBy: { select: { firstName: true, lastName: true } },
          },
        })
        // Orden inexistente → 404 del controller. Sin mesa → venta de mostrador,
        // la regla de propiedad no aplica.
        if (!order || !order.tableId) return next()
        owners = [order]
      } else {
        const tableId = req.params?.tableId
        if (!tableId) return next()
        owners = await prisma.order.findMany({
          where: {
            venueId,
            tableId,
            status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] },
          },
          select: {
            servedById: true,
            servedBy: { select: { firstName: true, lastName: true } },
          },
        })
        // Mesa libre (sin órdenes abiertas) → abrirla es de quien llegue primero.
        if (owners.length === 0) return next()
      }

      // Sin dueño registrado (servedById null) → no hay a quién proteger.
      const foreign = owners.find(o => o.servedById && o.servedById !== authContext.userId)
      if (!foreign) return next()

      if (
        await staffCanManageAllTables(authContext.userId, venueId, authContext.venueId, authContext.role, overridePermissions, req)
      ) {
        logger.debug(`checkTableOwnership: override [${overridePermissions.join(', ')}] para ${authContext.userId} en venue ${venueId}`)
        return next()
      }

      const ownerName = foreign.servedBy ? `${foreign.servedBy.firstName} ${foreign.servedBy.lastName}`.trim() : 'otro mesero'
      logger.info(
        `checkTableOwnership: ${authContext.userId} bloqueado — mesa propiedad de ${foreign.servedById} (${ownerName}) en venue ${venueId}`,
      )
      return res.status(403).json({
        error: 'Forbidden',
        code: 'TABLE_OWNED_BY_OTHER',
        message: `Solo ${ownerName} puede modificar esta mesa`,
        ownerId: foreign.servedById,
        ownerName,
      })
    } catch (error) {
      logger.error('checkTableOwnership: error evaluando propiedad de mesa', error)
      return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to verify table ownership' })
    }
  }

  // Expuesto para tests de auditoría de rutas: permite afirmar QUÉ override monta cada
  // endpoint sin ejecutar el middleware (mismo patrón que `requiredPermission`).
  ;(middleware as any).ownershipOverridePermissions = [...overridePermissions]
  return middleware
}
