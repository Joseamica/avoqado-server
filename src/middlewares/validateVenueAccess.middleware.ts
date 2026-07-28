import { NextFunction, Request, Response } from 'express'

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
