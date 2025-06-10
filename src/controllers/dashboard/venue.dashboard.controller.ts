// src/controllers/dashboard/venue.dashboard.controller.ts
import { NextFunction, Request, Response } from 'express'
import * as venueDashboardService from '../../services/dashboard/venue.dashboard.service'

import { CreateVenueDto, ListVenuesQueryDto } from '../../schemas/dashboard/venue.schema' // Ajusta la ruta

export async function listVenues(req: Request<{}, any, any, ListVenuesQueryDto>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId // 1. Extraer de req (Controller)
    if (!orgId) {
      // 2. Sanity check básico (Controller)
      return next(new Error('Contexto de organización no encontrado...'))
    }
    const queryOptions: ListVenuesQueryDto = req.query // 3. Extraer de req (Controller, ya validado)

    // 4. Llamada al servicio con datos limpios (Controller delega)
    const venues = await venueDashboardService.listVenuesForOrganization(orgId, queryOptions)

    res.status(200).json(venues) // 5. Enviar respuesta HTTP (Controller)
  } catch (error) {
    next(error) // 6. Manejo de error HTTP (Controller)
  }
}

export async function createVenue(req: Request<{}, any, CreateVenueDto>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId // 1. Extraer de req (Controller)
    if (!orgId) {
      // 2. Sanity check básico (Controller)
      return next(new Error('Contexto de organización no encontrado...'))
    }
    const venueData: CreateVenueDto = req.body // 3. Extraer de req (Controller, ya validado)

    // 4. Llamada al servicio con datos limpios (Controller delega)
    const newVenue = await venueDashboardService.createVenueForOrganization(orgId, venueData)

    res.status(201).json(newVenue) // 5. Enviar respuesta HTTP (Controller)
  } catch (error) {
    next(error) // 6. Manejo de error HTTP (Controller)
  }
}

export async function getVenueById(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId // 1. Extraer de req (Controller)
    if (!orgId) {
      // 2. Sanity check básico (Controller)
      return next(new Error('Contexto de organización no encontrado...'))
    }
    const venueId: string = req.params.venueId // 3. Extraer de req (Controller, ya validado)

    // 4. Llamada al servicio con datos limpios (Controller delega)
    const venue = await venueDashboardService.getVenueById(orgId, venueId)

    res.status(200).json(venue) // 5. Enviar respuesta HTTP (Controller)
  } catch (error) {
    next(error) // 6. Manejo de error HTTP (Controller)
  }
}
