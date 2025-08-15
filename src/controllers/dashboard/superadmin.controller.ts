import type { Request, Response, NextFunction } from 'express'
import * as superadminService from '../../services/dashboard/superadmin.service'
import logger from '../../config/logger'

// Extend Request interface to include user property
interface AuthenticatedRequest extends Request {
  user?: any
}

/**
 * Get superadmin dashboard overview data
 */
export async function getDashboardData(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    logger.info('Getting superadmin dashboard data', { userId: req.user?.id })

    // Verify superadmin access
    if (!superadminService.verifySuperadminAccess(req.user!)) {
      res.status(403).json({ success: false, message: 'Access denied. Superadmin privileges required.' })
      return
    }

    const dashboardData = await superadminService.getSuperadminDashboardData()
    
    res.json({ success: true, data: dashboardData, message: 'Dashboard data retrieved successfully' })
  } catch (error) {
    logger.error('Error getting superadmin dashboard data', { 
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.user?.id 
    })
    next(error)
  }
}

/**
 * Get all venues with detailed management information
 */
export async function getAllVenues(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    logger.info('Getting all venues for superadmin', { userId: req.user?.id })

    // Verify superadmin access
    if (!superadminService.verifySuperadminAccess(req.user!)) {
      res.status(403).json({ success: false, message: 'Access denied. Superadmin privileges required.' })
      return
    }

    const venues = await superadminService.getAllVenuesForSuperadmin()
    
    res.json({ success: true, data: venues, message: 'Venues retrieved successfully' })
  } catch (error) {
    logger.error('Error getting venues for superadmin', { 
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.user?.id 
    })
    next(error)
  }
}

/**
 * Get all platform features
 */
export async function getAllFeatures(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    logger.info('Getting all platform features', { userId: req.user?.id })

    // Verify superadmin access
    if (!superadminService.verifySuperadminAccess(req.user!)) {
      res.status(403).json({ success: false, message: 'Access denied. Superadmin privileges required.' })
      return
    }

    const features = await superadminService.getAllPlatformFeatures()
    
    res.json({ success: true, data: features, message: 'Features retrieved successfully' })
  } catch (error) {
    logger.error('Error getting platform features', { 
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.user?.id 
    })
    next(error)
  }
}

/**
 * Approve a venue for platform access
 */
export async function approveVenue(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    logger.info('Approving venue', { venueId, userId: req.user?.id })

    // Verify superadmin access
    if (!superadminService.verifySuperadminAccess(req.user!)) {
      res.status(403).json({ success: false, message: 'Access denied. Superadmin privileges required.' })
      return
    }

    await superadminService.approveVenue(venueId, req.user!.id)
    
    logger.info('Venue approved successfully', { venueId, approvedBy: req.user!.id })
    res.json({ success: true, data: { venueId }, message: 'Venue approved successfully' })
  } catch (error) {
    logger.error('Error approving venue', { 
      venueId: req.params.venueId,
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.user?.id 
    })
    next(error)
  }
}

/**
 * Create a new platform feature
 */
export async function createFeature(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { name, code, description, category, pricingModel, basePrice, isCore } = req.body
    logger.info('Creating new platform feature', { code, name, userId: req.user?.id })

    // Verify superadmin access
    if (!superadminService.verifySuperadminAccess(req.user!)) {
      res.status(403).json({ success: false, message: 'Access denied. Superadmin privileges required.' })
      return
    }

    // Validate required fields
    if (!name || !code || !description || !category || !pricingModel) {
      res.status(400).json({ success: false, message: 'Missing required fields' })
      return
    }

    // TODO: Implement feature creation logic
    const newFeature = {
      id: Date.now().toString(), // Temporary ID generation
      code,
      name,
      description,
      category,
      pricingModel,
      basePrice: basePrice || 0,
      isCore: isCore || false,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    
    logger.info('Feature created successfully', { featureId: newFeature.id, code, createdBy: req.user!.id })
    res.status(201).json({ success: true, data: newFeature, message: 'Feature created successfully' })
  } catch (error) {
    logger.error('Error creating feature', { 
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.user?.id 
    })
    next(error)
  }
}