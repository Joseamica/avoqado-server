import { NextFunction, Request, Response } from 'express'

import * as venueTpvService from '../../services/tpv/venue.tpv.service'

export async function getVenueById(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    // const orgId = req.authContext?.orgId // 1. Extraer de req (Controller)
    // if (!orgId) {
    //   // 2. Sanity check básico (Controller)
    //   return next(new Error('Contexto de organización no encontrado...'))
    // }
    const venueId: string = req.params.venueId // 3. Extraer de req (Controller, ya validado)

    // 4. Llamada al servicio con datos limpios (Controller delega)
    const venue = await venueTpvService.getVenueById(venueId)

    res.status(200).json(venue) // 5. Enviar respuesta HTTP (Controller)
  } catch (error) {
    next(error) // 6. Manejo de error HTTP (Controller)
  }
}

export async function getVenueIdFromSerialNumber(req: Request<{ serialNumber: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const serialNumber: string = req.params.serialNumber // 1. Extraer de req (Controller, ya validado)

    // 2. Llamada al servicio con datos limpios (Controller delega)
    const result = await venueTpvService.getVenueIdFromSerialNumber(serialNumber)

    res.status(200).json(result) // 3. Enviar respuesta HTTP (Controller)
  } catch (error) {
    next(error) // 4. Manejo de error HTTP (Controller)
  }
}
