// src/controllers/dashboard/venue.dashboard.controller.ts
import { NextFunction, Request, Response } from 'express'
import * as venueDashboardService from '../../services/dashboard/venue.dashboard.service'

import { CreateVenueDto, ListVenuesQueryDto } from '../../schemas/dashboard/venue.schema' // Ajusta la ruta
import { EnhancedCreateVenueBody } from '../../schemas/dashboard/cost-management.schema'
import logger from '../../config/logger'

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

export async function updateVenue(req: Request<{ venueId: string }, any, any>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Contexto de organización no encontrado'))
    }

    const venueId: string = req.params.venueId
    const updateData = req.body

    const updatedVenue = await venueDashboardService.updateVenue(orgId, venueId, updateData)

    res.status(200).json({
      success: true,
      data: updatedVenue,
      message: 'Venue updated successfully',
    })
  } catch (error) {
    next(error)
  }
}

export async function deleteVenue(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Contexto de organización no encontrado'))
    }

    const venueId: string = req.params.venueId

    await venueDashboardService.deleteVenue(orgId, venueId)

    res.status(200).json({
      success: true,
      message: 'Venue deleted successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Enhanced venue creation with payment processing and pricing configuration
 */
export async function createEnhancedVenue(
  req: Request<{}, any, EnhancedCreateVenueBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    if (!orgId) {
      logger.error('Organization context not found in enhanced venue creation')
      return next(new Error('Contexto de organización no encontrado'))
    }

    const userId = req.authContext?.userId
    if (!userId) {
      logger.error('User context not found in enhanced venue creation')
      return next(new Error('Contexto de usuario no encontrado'))
    }

    const venueData: EnhancedCreateVenueBody = req.body

    logger.info('Creating enhanced venue', {
      orgId,
      userId,
      venueName: venueData.name,
      enablePaymentProcessing: venueData.enablePaymentProcessing,
      setupPricingStructure: venueData.setupPricingStructure,
      pricingTier: venueData.pricingTier,
    })

    // Create the venue with enhanced features
    const newVenue = await venueDashboardService.createEnhancedVenue(orgId, userId, venueData)

    res.status(201).json({
      success: true,
      data: newVenue,
      message: 'Enhanced venue created successfully',
    })
  } catch (error) {
    logger.error('Error creating enhanced venue', {
      error: error instanceof Error ? error.message : 'Unknown error',
      orgId: req.authContext?.orgId,
      userId: req.authContext?.userId,
      venueName: req.body?.name,
    })
    next(error)
  }
}
