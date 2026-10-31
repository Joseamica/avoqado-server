import { NextFunction, Request, Response } from 'express'
import { CRM_KEY_LABELS, CRM_KEYS, CrmKey } from '../lib/permissions'
import { CrmAccess, getCrmAccess, hasCrmKey } from '../services/crm/access.service'

/**
 * Guard for `/api/v1/crm/*`: lets the request through when the person holds the key — with an array, ANY of them — and
 * leaves the access it read in `req.crmAccess` for the handler.
 *
 * 🔴 The keys are re-read from the database on EVERY request (`getCrmAccess`), like `authorizeRole` with `rolVigente`:
 * the token only says who is asking. A key turned off mid-session stops working on the very next request.
 * Runs after `authenticateTokenMiddleware`, which already turns impersonation sessions away from `/api/v1/crm`.
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
