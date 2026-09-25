import { Request, Response, NextFunction } from 'express'
import { StaffRole } from '../security' // Assuming StaffRole and AuthContext are here or re-exported
import { rolVigente } from '../services/access/rolVigente'

/**
 * Middleware factory para autorización basada en roles.
 * Se espera que se ejecute después de un middleware de autenticación que popule `req.authContext`.
 *
 * 🔴 El rol se RELEE de la base en cada petición (`rolVigente`); el del token sólo dice qué sesión
 * es. Antes se le creía al token: un token de dueño mal emitido, o el de alguien dado de baja,
 * seguía pasando 24 h (Codex gpt-6-astra, 24-sep).
 *
 * @param allowedRoles Array de StaffRole permitidos para acceder al recurso.
 * @returns Un middleware de Express.
 */
export const authorizeRole = (allowedRoles: StaffRole[]) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Asegurarse de que authContext y role existen (deberían ser establecidos por un middleware anterior)
    if (!req.authContext || !req.authContext.role) {
      // Esto indica un problema de configuración del servidor o un flujo inesperado
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Contexto de autenticación no encontrado. Asegúrese de que el middleware de autenticación se ejecutó primero.',
      })
      return
    }

    let userRole: StaffRole | null
    try {
      userRole = await rolVigente(req.authContext as never)
    } catch (error) {
      return next(error)
    }

    // SUPERADMIN siempre tiene acceso
    if (userRole === StaffRole.SUPERADMIN) {
      return next()
    }

    if (userRole && allowedRoles.includes(userRole)) {
      next() // El rol del usuario está en la lista de permitidos
    } else {
      res.status(403).json({
        error: 'Forbidden',
        message: `Acceso denegado. Se requiere uno de los siguientes roles: ${allowedRoles.join(', ')}.`,
      })
    }
  }
}
