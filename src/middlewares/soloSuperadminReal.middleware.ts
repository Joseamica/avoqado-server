import type { NextFunction, Request, Response } from 'express'
import { esSuperadminReal } from '../services/access/rolVigente'

/**
 * Sólo el superadmin real (fila SUPERADMIN activa de una persona activa), sin impersonar. Para las rutas del CRM que son del
 * founder y de nadie más (el WhatsApp de ventas, founder 20-nov: «Sólo yo»).
 *
 * 🔴 Va ANTES de `requireCrm`: `getCrmAccess` reclama la fila de llaves de un vendedor la primera vez que la usa, y un 403 no
 * debe cambiar nada (Codex r1 #8). Para el superadmin, `requireCrm` no lee ninguna fila.
 */
export async function soloSuperadminReal(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.authContext?.userId
  try {
    if (userId && !req.authContext?.isImpersonating && (await esSuperadminReal(userId))) return next()
  } catch (error) {
    return next(error)
  }
  res.status(403).json({ code: 'CRM_FORBIDDEN', message: 'Los chats del WhatsApp de ventas sólo los ve el superadmin.' })
}
