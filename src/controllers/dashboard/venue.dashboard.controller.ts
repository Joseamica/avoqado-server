// src/controllers/dashboard/venue.dashboard.controller.ts
import { Request, Response, NextFunction } from 'express'
import { StaffRole } from '@prisma/client' // O desde donde lo tengas
import * as venueDashboardService from '../../services/dashboard/venue.dashboard.service'
// Importa los TIPOS DTO inferidos de Zod
import { CreateVenueDto, ListVenuesQueryDto } from '../../schemas/venue.schema' // Ajusta la ruta

// ... (código del controlador que te di antes, usando CreateVenueDto y ListVenuesQueryDto)
// Ejemplo para createVenue:
// export async function createVenue(req: Request<{}, any, CreateVenueDto>, res: Response, next: NextFunction): Promise<void> {
//   const orgId = req.authContext!.orgId; // El '!' asume que authContext y orgId siempre estarán aquí
//   const venueData: CreateVenueDto = req.body; // req.body ya tiene el tipo CreateVenueDto
//   // ...
// }
// Ejemplo para listVenues:
// export async function listVenues(req: Request<{}, any, any, ListVenuesQueryDto>, res: Response, next: NextFunction): Promise<void> {
//   const orgId = req.authContext!.orgId;
//   const queryOptions: ListVenuesQueryDto = req.query; // req.query ya tiene el tipo ListVenuesQueryDto
//   // ...
// }

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
