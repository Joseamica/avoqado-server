import { NextFunction, Request, Response } from 'express'
import * as floorPlanService from '../../services/dashboard/floorPlan/floorPlan.service'
import type { PublishFloorPlanBody } from '../../schemas/dashboard/floorPlan.schema'

/** Quién publica: va a la bitácora (ActivityLog) que escribe el servicio. */
const actor = (req: Request): string | undefined => (req as any).authContext?.userId

export async function getFloorPlan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await floorPlanService.getFloorPlan(req.params.venueId)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function publishFloorPlan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await floorPlanService.publishFloorPlan(
      req.params.venueId,
      // El cuerpo ya pasó por `publishFloorPlanSchema` (validateRequest): el compilador ata la salida de Zod a la entrada del servicio.
      req.body as PublishFloorPlanBody,
      actor(req),
    )
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
