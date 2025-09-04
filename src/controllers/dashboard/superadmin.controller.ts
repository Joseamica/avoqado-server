import type { Request, Response, NextFunction } from 'express'
import * as superadminService from '../../services/dashboard/superadmin.service'
import logger from '../../config/logger'

/**
 * Get superadmin dashboard overview data
 */
export async function getDashboardData(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    logger.info('Getting superadmin dashboard data', { userId: req.authContext?.userId })

    const dashboardData = await superadminService.getSuperadminDashboardData()

    res.json({ success: true, data: dashboardData, message: 'Dashboard data retrieved successfully' })
  } catch (error) {
    logger.error('Error getting superadmin dashboard data', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Get all venues with detailed management information
 */
export async function getAllVenues(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    logger.info('Getting all venues for superadmin', { userId: req.authContext?.userId })

    const venues = await superadminService.getAllVenuesForSuperadmin()

    res.json({ success: true, data: venues, message: 'Venues retrieved successfully' })
  } catch (error) {
    logger.error('Error getting venues for superadmin', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Get all platform features
 */
export async function getAllFeatures(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    logger.info('Getting all platform features', { userId: req.authContext?.userId })

    const features = await superadminService.getAllPlatformFeatures()

    res.json({ success: true, data: features, message: 'Features retrieved successfully' })
  } catch (error) {
    logger.error('Error getting platform features', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Approve a venue for platform access
 */
export async function approveVenue(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    logger.info('Approving venue', { venueId, userId: req.authContext?.userId })

    await superadminService.approveVenue(venueId, req.authContext!.userId)

    logger.info('Venue approved successfully', { venueId, approvedBy: req.authContext!.userId })
    res.json({ success: true, data: { venueId }, message: 'Venue approved successfully' })
  } catch (error) {
    logger.error('Error approving venue', {
      venueId: req.params.venueId,
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Create a new platform feature
 */
export async function createFeature(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { name, code, description, category, pricingModel, basePrice, isCore } = req.body
    logger.info('Creating new platform feature', { code, name, userId: req.authContext?.userId })

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
      updatedAt: new Date().toISOString(),
    }

    logger.info('Feature created successfully', { featureId: newFeature.id, code, createdBy: req.authContext!.userId })
    res.status(201).json({ success: true, data: newFeature, message: 'Feature created successfully' })
  } catch (error) {
    logger.error('Error creating feature', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Get detailed information for a specific venue
 */
export async function getVenueDetails(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    logger.info('Getting venue details', { venueId, userId: req.authContext?.userId })

    const venue = await superadminService.getVenueDetails(venueId)
    if (!venue) {
      res.status(404).json({ success: false, message: 'Venue not found' })
      return
    }

    res.json({ success: true, data: venue, message: 'Venue details retrieved successfully' })
  } catch (error) {
    logger.error('Error getting venue details', {
      venueId: req.params.venueId,
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Suspend a venue
 */
export async function suspendVenue(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const { reason } = req.body
    logger.info('Suspending venue', { venueId, reason, userId: req.authContext?.userId })

    await superadminService.suspendVenue(venueId, reason)
    res.json({ success: true, data: { venueId }, message: 'Venue suspended successfully' })
  } catch (error) {
    logger.error('Error suspending venue', {
      venueId: req.params.venueId,
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Enable a feature for a venue
 */
export async function enableFeatureForVenue(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, featureCode } = req.params
    logger.info('Enabling feature for venue', { venueId, featureCode, userId: req.authContext?.userId })

    await superadminService.enableFeatureForVenue(venueId, featureCode)
    res.json({ success: true, data: { venueId, featureCode }, message: 'Feature enabled successfully' })
  } catch (error) {
    logger.error('Error enabling feature for venue', {
      venueId: req.params.venueId,
      featureCode: req.params.featureCode,
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Disable a feature for a venue
 */
export async function disableFeatureForVenue(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, featureCode } = req.params
    logger.info('Disabling feature for venue', { venueId, featureCode, userId: req.authContext?.userId })

    await superadminService.disableFeatureForVenue(venueId, featureCode)
    // No content response is appropriate for successful DELETE
    res.status(204).send()
  } catch (error) {
    logger.error('Error disabling feature for venue', {
      venueId: req.params.venueId,
      featureCode: req.params.featureCode,
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Get revenue metrics for a date range
 */
export async function getRevenueMetrics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { startDate, endDate } = req.query

    const start = startDate ? new Date(startDate as string) : undefined
    const end = endDate ? new Date(endDate as string) : undefined

    const metrics = await superadminService.getRevenueMetrics(start, end)

    logger.info('Revenue metrics retrieved successfully', {
      startDate: start?.toISOString(),
      endDate: end?.toISOString(),
      totalRevenue: metrics.totalRevenue,
      userId: req.authContext?.userId,
    })

    res.json({
      success: true,
      data: metrics,
      message: 'Revenue metrics retrieved successfully',
    })
  } catch (error) {
    logger.error('Error getting revenue metrics', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Get detailed revenue breakdown
 */
export async function getRevenueBreakdown(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { startDate, endDate } = req.query

    const start = startDate ? new Date(startDate as string) : undefined
    const end = endDate ? new Date(endDate as string) : undefined

    const breakdown = await superadminService.getRevenueBreakdown(start, end)

    logger.info('Revenue breakdown retrieved successfully', {
      startDate: start?.toISOString(),
      endDate: end?.toISOString(),
      venueCount: breakdown.byVenue.length,
      userId: req.authContext?.userId,
    })

    res.json({
      success: true,
      data: breakdown,
      message: 'Revenue breakdown retrieved successfully',
    })
  } catch (error) {
    logger.error('Error getting revenue breakdown', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Get list of all payment providers
 */
export async function getProvidersList(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    logger.info('Getting providers list', { userId: req.authContext?.userId })

    const providers = await superadminService.getPaymentProvidersList()

    res.json({
      success: true,
      data: providers,
      message: 'Payment providers retrieved successfully',
    })
  } catch (error) {
    logger.error('Error getting providers list', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Get list of merchant accounts
 */
export async function getMerchantAccountsList(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { providerId } = req.query

    logger.info('Getting merchant accounts list', {
      userId: req.authContext?.userId,
      providerId,
    })

    const merchantAccounts = await superadminService.getMerchantAccountsList(providerId as string)

    res.json({
      success: true,
      data: merchantAccounts,
      message: 'Merchant accounts retrieved successfully',
    })
  } catch (error) {
    logger.error('Error getting merchant accounts list', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}

/**
 * Get simplified venues list for dropdowns
 */
export async function getVenuesListSimple(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    logger.info('Getting venues list (simple)', { userId: req.authContext?.userId })

    const venues = await superadminService.getVenuesListSimple()

    res.json({
      success: true,
      data: venues,
      message: 'Venues list retrieved successfully',
    })
  } catch (error) {
    logger.error('Error getting venues list', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.authContext?.userId,
    })
    next(error)
  }
}
