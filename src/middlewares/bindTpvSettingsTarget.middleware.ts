import type { NextFunction, Request, Response } from 'express'

import { NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

export interface BoundTpvSettingsTarget {
  id: string
  venueId: string
}

/**
 * Amarra `/tpv/:tpvId/...` al venue REAL de la terminal ANTES de `checkPermission`.
 *
 * 🔴 Estas rutas no llevan `:venueId`, así que `checkPermission` evaluaba el permiso en el venue del
 * header `x-venue-id` o del token — el del usuario — y el servicio leía o escribía la terminal sólo
 * por id: con permiso en su negocio, cualquiera tocaba la terminal de otro negocio si conocía su id
 * (auditoría de Codex, 2026-09-16). Al poner aquí `req.params.venueId`, el permiso se evalúa en el
 * venue de la terminal (los params le ganan al header), y el controlador pasa ese mismo venue al
 * servicio para acotar lecturas y escrituras.
 *
 * Mismo molde que `bindTpvCommandTarget`, sin la búsqueda por serial: estas rutas siempre reciben el id.
 */
export async function bindTpvSettingsTarget(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const target = await prisma.terminal.findUnique({
      where: { id: req.params.tpvId },
      select: { id: true, venueId: true },
    })

    if (!target) {
      throw new NotFoundError('Terminal no encontrada')
    }

    req.tpvSettingsTarget = { id: target.id, venueId: target.venueId }
    req.params.venueId = target.venueId
    next()
  } catch (error) {
    next(error)
  }
}
