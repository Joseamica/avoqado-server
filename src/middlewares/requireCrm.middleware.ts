import { NextFunction, Request, Response } from 'express'
import { CRM_KEY_LABELS, CRM_KEYS, CrmKey } from '../lib/permissions'
import { CrmAccess, getCrmAccess, hasCrmKey } from '../services/crm/access.service'

/**
 * Guard for `/api/v1/crm/*`: lets the request through when the person holds the key — with an array, ANY of them — and
 * leaves the access it read in `req.crmAccess` for the handler.
 *
 * 🔴 The keys are re-read from the database on EVERY request (`getCrmAccess`), like `authorizeRole` with `rolVigente`:
 * the token only says who is asking. A key turned off mid-session stops working on the very next request.
 *
 * 🔴 An impersonation session is turned away HERE, before any read. The shared impersonation guard also blocks the
 * `/api/v1/crm` prefix, but it compares case-sensitively while Express routes case-insensitively: `/api/v1/Crm/me`
 * gets past it (review I-1), so this guard must not lean on it.
 */
export const requireCrm = (key: CrmKey | readonly CrmKey[]) => {
  const keys: readonly CrmKey[] = typeof key === 'string' ? [key] : key
  const message =
    keys.length === CRM_KEYS.length
      ? 'No tienes ninguna llave del CRM'
      : `No tienes la llave ${keys.map(k => `«${CRM_KEY_LABELS[k]}»`).join(' ni ')}`

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.authContext?.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized', message: 'Inicia sesión para continuar.' })
      return
    }

    // Whose keys an impersonation token carries is never decided: in user mode `userId` is the impersonated person.
    if (req.authContext?.isImpersonating) {
      res
        .status(403)
        .json({ code: 'CRM_FORBIDDEN', message: 'El CRM no está disponible mientras impersonas. Sal de impersonación para continuar.' })
      return
    }

    let access: CrmAccess | null
    try {
      access = await getCrmAccess(userId)
    } catch (error) {
      return next(error)
    }

    if (!access || !keys.some(k => hasCrmKey(access, k))) {
      res.status(403).json({ code: 'CRM_FORBIDDEN', message })
      return
    }

    req.crmAccess = access
    next()
  }
}
