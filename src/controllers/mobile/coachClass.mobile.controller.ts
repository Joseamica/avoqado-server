/**
 * Fase 8 del kiosco — "Mi clase ahora" (Android / iOS).
 *
 * Un solo endpoint, de sólo lectura, con el permiso más estrecho del catálogo:
 * `class-sessions:read-assigned`. Quien da la clase ve SU clase; no la agenda del negocio.
 */

import { NextFunction, Request, Response } from 'express'

import { getMyClassNow } from '@/services/reservation/coachClass.service'
import { BadRequestError, UnauthorizedError } from '@/errors/AppError'

/** GET /api/v1/mobile/venues/:venueId/my-class-now */
export async function myClassNow(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = req.params.venueId
    if (!venueId) throw new BadRequestError('Venue ID requerido en la ruta')
    const staffId = req.authContext?.userId
    if (!staffId) throw new UnauthorizedError('Sesión sin usuario')

    const clase = await getMyClassNow({ venueId, staffId, now: new Date() })

    // Sin clase NO es un error: es el estado normal el 90 % del día. La app enseña
    // "no tienes clase ahora", que es información, no una falla.
    res.json({ hasClass: clase != null, class: clase })
  } catch (error) {
    next(error)
  }
}
