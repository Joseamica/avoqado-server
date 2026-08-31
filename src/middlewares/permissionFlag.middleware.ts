// src/middlewares/permissionFlag.middleware.ts
//
// Marca en el request si el llamante tiene un permiso, SIN bloquear la petición.
//
// Nace del conteo ciego del cajón: la respuesta no debe traer el efectivo esperado para
// quien no puede verlo, pero el endpoint sí se sirve igual (el cajero necesita el resto de
// la caja). `checkPermission` no sirve para eso: su única salida es un 403.
//
// 🔴 Reusa las MISMAS piezas que `checkPermission` —`resolveRequestVenueId`,
// `resolveUserRoleForVenue`, `evaluatePermissionList`, `hasPermission`— y en el mismo orden,
// para no crear una segunda definición de "quién puede qué", que es como nacen los permisos
// que contestan distinto según por dónde entres. `permissionEquivalence.test.ts` compara las
// dos implementaciones sobre una matriz de casos y falla si divergen.
//
// Diferencia deliberada con `checkPermission`: NO honra el override por PIN de gerente. Ese
// PIN autoriza UNA acción puntual; revelar el esperado no es una acción, es un dato que se
// quedaría visible el resto del turno.

import { StaffRole } from '@prisma/client'
import { NextFunction, Request, Response } from 'express'
import logger from '../config/logger'
import { evaluatePermissionList, hasPermission } from '../lib/permissions'
import prisma from '../utils/prismaClient'
import { resolveRequestVenueId, resolveUserRoleForVenue } from './checkPermission.middleware'

/** El permiso que gobierna ver el efectivo esperado del cajón (MANAGER+). */
export const PERMISO_VER_ESPERADO = 'cash-drawer:view-expected'

/**
 * ¿El llamante tiene `permiso` en el venue de este request?
 *
 * 🔴 Falla CERRADO: ante cualquier problema (sin contexto, sin venue, error de base)
 * devuelve `false`. Aquí eso significa ocultar el dato, que es el lado seguro — al revés
 * que en un gate de acceso, donde fallar cerrado deja a alguien sin trabajar.
 */
export async function tienePermisoEnVenue(req: Request, permiso: string): Promise<boolean> {
  const authContext = (req as any).authContext
  if (!authContext?.userId) return false

  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) return false

  // SUPERADMIN lo ve todo, salvo mientras impersona: ahí manda el rol efectivo, igual
  // que en `checkPermission`.
  const superAdminVenue = authContext.isImpersonating
    ? null
    : await prisma.staffVenue.findFirst({
        where: { staffId: authContext.userId, role: StaffRole.SUPERADMIN },
        select: { id: true },
      })
  if (superAdminVenue) return true

  const { role: userRole, permissionSet } = await resolveUserRoleForVenue({
    userId: authContext.userId,
    targetVenueId: venueId,
    tokenVenueId: authContext.venueId,
    tokenRole: authContext.role,
    req,
  })
  if (!userRole) return false

  // Un conjunto de permisos asignado se evalúa tal cual, sin mezclar con los defaults.
  if (permissionSet) return evaluatePermissionList(permissionSet.permissions, permiso)

  const venueRolePermission = await prisma.venueRolePermission.findUnique({
    where: { venueId_role: { venueId, role: userRole } },
    select: { permissions: true, deniedPermissions: true },
  })

  const customPermissions = venueRolePermission ? (venueRolePermission.permissions as string[]) : null
  const deniedPermissions = venueRolePermission ? ((venueRolePermission.deniedPermissions as string[]) ?? null) : null

  return hasPermission(userRole, customPermissions, permiso, deniedPermissions)
}

/**
 * Middleware que deja la respuesta de `tienePermisoEnVenue` en `req[bandera]` y sigue.
 * Nunca corta la petición: sólo informa al controlador de qué puede incluir.
 */
export const marcarPermiso = (permiso: string, bandera: string) => {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      ;(req as any)[bandera] = await tienePermisoEnVenue(req, permiso)
    } catch (error) {
      // Un fallo de base no puede tumbar una lectura: se oculta el dato y se sigue.
      ;(req as any)[bandera] = false
      logger.warn('marcarPermiso: no se pudo resolver el permiso, se oculta el dato', {
        permiso,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    next()
  }
}
