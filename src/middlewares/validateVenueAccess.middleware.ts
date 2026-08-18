import { NextFunction, Request, Response } from 'express'
import { resolveUserRoleForVenue } from './checkPermission.middleware'
import logger from '../config/logger'

/**
 * Verifica que el `:venueId` de la URL sea el del token.
 *
 * Existe porque `authenticateTokenMiddleware` nunca lee `req.params.venueId` y los
 * controllers lo pasan directo al servicio, que scopea con
 * `where: { id, venueId }` — es decir, contra el venueId QUE VINO EN LA URL.
 * Con un token del venue A se podía operar sobre el venue B. Ver spec §4.4.
 *
 * Deliberadamente estricto (igualdad exacta contra `authContext.venueId`, SIN el
 * fallback de `checkPermission`/`resolveUserRoleForVenue` que resuelve el rol real
 * del staff en CUALQUIER venue donde tenga un `StaffVenue` activo). Ese fallback es
 * correcto para el dashboard (un OWNER navega entre varios venues con un mismo
 * token), pero una TPV física está atada a UN venue por sesión — no debe poder
 * tocar otro solo porque el mismo humano también trabaja ahí.
 */
export function validateVenueAccess(req: Request, res: Response, next: NextFunction): void {
  const authContext = (req as any).authContext

  if (!authContext?.venueId) {
    res.status(401).json({ success: false, message: 'Autenticación requerida' })
    return
  }

  if (req.params.venueId !== authContext.venueId) {
    res.status(403).json({ success: false, message: 'No tienes acceso a este venue' })
    return
  }

  next()
}

/**
 * Verifica que el staff TRABAJE en el `:venueId` de la URL.
 *
 * La versión laxa de `validateVenueAccess`, para las rutas mobile que no exigen
 * un permiso concreto y por eso no pasaban por `checkPermission` — su única
 * defensa era `authenticateTokenMiddleware`, que valida QUIÉN eres pero no
 * DÓNDE. El venueId de la URL llegaba intacto al servicio, así que con un token
 * válido de cualquier negocio se leían los descuentos, cupones, proveedores,
 * ajustes y comandas de KDS de CUALQUIER otro — incluido uno de otra
 * organización. Verificado: un staff de la org A recibió íntegra una promoción
 * de un venue de la org B.
 *
 * Es deliberadamente MENOS estricto que `validateVenueAccess` (que exige
 * igualdad exacta con el venue del token): pide sólo que el staff pertenezca al
 * venue de la URL. La diferencia importa al desplegar — un POS cuyo token quedó
 * apuntando a otro local propio (pasaba antes de que el refresh conservara el
 * venue) sigue funcionando en vez de quedarse muerto hasta que alguien vuelva a
 * entrar. Lo que se cierra es lo grave: ver datos de un negocio ajeno.
 */
export async function requireVenueMembership(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authContext = (req as any).authContext

  if (!authContext?.userId) {
    res.status(401).json({ success: false, message: 'Autenticación requerida' })
    return
  }

  const targetVenueId = req.params.venueId
  if (!targetVenueId) {
    next()
    return
  }

  try {
    const { role } = await resolveUserRoleForVenue({
      userId: authContext.userId,
      targetVenueId,
      tokenVenueId: authContext.venueId,
      tokenRole: authContext.role,
      req,
    })

    if (!role) {
      logger.warn(`🔒 [VENUE ACCESS] staff ${authContext.userId} intentó entrar al venue ${targetVenueId} sin pertenecer`)
      res.status(403).json({ success: false, message: 'No tienes acceso a este establecimiento' })
      return
    }

    next()
  } catch (error) {
    next(error)
  }
}
