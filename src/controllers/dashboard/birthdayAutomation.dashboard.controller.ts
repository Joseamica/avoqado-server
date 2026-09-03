import { Request, Response, NextFunction } from 'express'

import { obtenerAutomatizacion, guardarAutomatizacion } from '@/services/marketing/birthdayAutomation.service'

function actorStaffId(req: Request): string | undefined {
  return (req as any).authContext?.userId
}

export async function getBirthdayAutomation(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    // `null` cuando nunca se ha configurado: la pantalla lo distingue de «configurada y
    // pausada», que son cosas distintas para el dueño.
    res.json({ data: { automation: await obtenerAutomatizacion(venueId) } })
  } catch (error) {
    next(error)
  }
}

export async function putBirthdayAutomation(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const result = await guardarAutomatizacion({ venueId, actorStaffId: actorStaffId(req), ...req.body })
    res.json({ data: { automation: result } })
  } catch (error) {
    next(error)
  }
}
