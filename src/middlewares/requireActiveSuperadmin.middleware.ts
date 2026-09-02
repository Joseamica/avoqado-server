import type { NextFunction, Request, Response } from 'express'
import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'

const deniedMessage = 'Acceso denegado. Se requiere una asignación SUPERADMIN activa.'

/**
 * Platform authority for the superadmin namespace.
 *
 * Authentication establishes identity, but its role claim can be stale until
 * the token expires. This middleware deliberately re-reads the active
 * StaffVenue authority on every request so revocation takes effect immediately.
 */
export async function requireActiveSuperadmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authContext = req.authContext
  if (!authContext?.userId) {
    res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' })
    return
  }

  if (authContext.isImpersonating) {
    res.status(403).json({ error: 'Forbidden', message: deniedMessage })
    return
  }

  try {
    const authority = await prisma.staffVenue.findFirst({
      where: {
        staffId: authContext.userId,
        role: StaffRole.SUPERADMIN,
        active: true,
        staff: { active: true },
      },
      select: { id: true },
    })
    if (!authority) {
      res.status(403).json({ error: 'Forbidden', message: deniedMessage })
      return
    }

    ;(req as Request & { resolvedRole?: StaffRole }).resolvedRole = StaffRole.SUPERADMIN
    next()
  } catch (error) {
    next(error)
  }
}
