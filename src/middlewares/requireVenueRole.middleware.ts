import { NextFunction, Request, Response } from 'express'
import { StaffRole } from '@prisma/client'

import { resolveUserRoleForVenue } from './checkPermission.middleware'

/**
 * Exige un rol mínimo EN EL VENUE DE LA URL.
 *
 * 🔴 No confundir con `authorizeRole`, que sólo mira el rol del JWT. El token dice quién
 * eres; el rol en ESE venue dice qué puedes hacer ahí. Con `authorizeRole`, un OWNER del
 * venue A podía ejecutar acciones de dueño sobre el venue B con sólo cambiar la URL
 * (auditoría Codex 2026-08-26, P1: borrado permanente cross-venue).
 *
 * Úsalo DESPUÉS de `authenticateTokenMiddleware`, en rutas `/venues/:venueId/...`.
 */
export const requireVenueRole = (allowedRoles: StaffRole[]) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const auth = req.authContext
      if (!auth?.userId || !auth.role) {
        res.status(401).json({ error: 'Unauthorized', message: 'Contexto de autenticación no encontrado.' })
        return
      }

      if (auth.role === StaffRole.SUPERADMIN) {
        next()
        return
      }

      const venueId = req.params.venueId
      if (!venueId) {
        res.status(400).json({ error: 'Bad Request', message: 'La ruta no trae venueId.' })
        return
      }

      const { role } = await resolveUserRoleForVenue({
        userId: auth.userId,
        targetVenueId: venueId,
        tokenVenueId: auth.venueId,
        tokenRole: auth.role,
        req,
      })

      if (!role || !allowedRoles.includes(role)) {
        res.status(403).json({
          error: 'Forbidden',
          message: `Acceso denegado. Se requiere uno de los siguientes roles en este negocio: ${allowedRoles.join(', ')}.`,
        })
        return
      }

      next()
    } catch (error) {
      next(error)
    }
  }
}
