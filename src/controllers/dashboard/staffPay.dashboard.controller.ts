import { NextFunction, Request, Response } from 'express'
import { BadRequestError } from '../../errors/AppError'
import { venueHasServicePayAccess } from '../../services/dashboard/staffPay/acceso'

export function ctx(req: Request): { venueId: string; userId: string } {
  const venueId = req.params.venueId
  if (!venueId) throw new BadRequestError('Venue ID requerido en la ruta')
  const { userId } = (req as any).authContext
  return { venueId, userId }
}

export async function getAccess(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = ctx(req)
    res.json({ enabled: await venueHasServicePayAccess(venueId) })
  } catch (error) {
    next(error)
  }
}
