import { Request, Response, NextFunction } from 'express'
import * as venuePricingService from '../../services/superadmin/venuePricing.service'
import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'
import { AccountType } from '@prisma/client'

/**
 * VenuePricing Controller
 *
 * REST API endpoints for managing venue payment configuration and pricing structures.
 * All endpoints require SUPERADMIN role (enforced by parent router middleware).
 */

/**
 * ========================================
 * VENUE PAYMENT CONFIG ENDPOINTS
 * ========================================
 */

/**
 * GET /api/v1/superadmin/venue-pricing/config/:venueId
 * Get venue payment configuration
 */
export async function getVenuePaymentConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const config = await venuePricingService.getVenuePaymentConfig(venueId)

    if (!config) {
      res.json({
        success: true,
        data: null,
        message: 'No payment configuration found for this venue',
      })
      return
    }

    res.json({
      success: true,
      data: config,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/superadmin/venue-pricing/config
 * Create venue payment configuration
 */
export async function createVenuePaymentConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, primaryAccountId, secondaryAccountId, tertiaryAccountId, routingRules, preferredProcessor } = req.body

    // Validate required fields
    if (!venueId) {
      throw new BadRequestError('venueId is required')
    }

    if (!primaryAccountId) {
      throw new BadRequestError('primaryAccountId is required')
    }

    const config = await venuePricingService.createVenuePaymentConfig({
      venueId,
      primaryAccountId,
      secondaryAccountId,
      tertiaryAccountId,
      routingRules,
      preferredProcessor,
    })

    logger.info('Venue payment config created via API', {
      configId: config.id,
      createdBy: (req as any).user?.uid,
    })

    res.status(201).json({
      success: true,
      data: config,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/venue-pricing/configs-by-merchant/:merchantAccountId
 * Get all venue payment configs that reference a specific merchant account
 * Useful for dependency checking before deleting a merchant account
 */
export async function getVenueConfigsByMerchantAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { merchantAccountId } = req.params

    const configs = await venuePricingService.getVenueConfigsByMerchantAccount(merchantAccountId)

    res.json({
      success: true,
      data: configs,
      count: configs.length,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/superadmin/venue-pricing/config/:venueId
 * Update venue payment configuration
 */
export async function updateVenuePaymentConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { primaryAccountId, secondaryAccountId, tertiaryAccountId, routingRules, preferredProcessor } = req.body

    const config = await venuePricingService.updateVenuePaymentConfig(venueId, {
      primaryAccountId,
      secondaryAccountId,
      tertiaryAccountId,
      routingRules,
      preferredProcessor,
    })

    logger.info('Venue payment config updated via API', {
      venueId,
      updatedBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      data: config,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * ========================================
 * VENUE PRICING STRUCTURE ENDPOINTS
 * ========================================
 */

/**
 * GET /api/v1/superadmin/venue-pricing/structures
 * Get all venue pricing structures with optional filters
 */
export async function getVenuePricingStructures(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, accountType, includeInactive } = req.query

    const pricingStructures = await venuePricingService.getVenuePricingStructures(
      venueId as string | undefined,
      accountType as AccountType | undefined,
      includeInactive === 'true',
    )

    res.json({
      success: true,
      data: pricingStructures,
      count: pricingStructures.length,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/venue-pricing/structures/:id
 * Get a single venue pricing structure by ID
 */
export async function getVenuePricingStructure(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const pricingStructure = await venuePricingService.getVenuePricingStructure(id)

    res.json({
      success: true,
      data: pricingStructure,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/venue-pricing/structures/active/:venueId/:accountType
 * Get the currently active pricing structure for a venue and account type
 */
export async function getActivePricingStructure(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, accountType } = req.params

    const pricingStructure = await venuePricingService.getActivePricingStructure(venueId, accountType as AccountType)

    if (!pricingStructure) {
      res.json({
        success: true,
        data: null,
        message: 'No active pricing structure found for this venue and account type',
      })
      return
    }

    res.json({
      success: true,
      data: pricingStructure,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/superadmin/venue-pricing/structures
 * Create a new venue pricing structure
 */
export async function createVenuePricingStructure(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      venueId,
      accountType,
      effectiveFrom,
      debitRate,
      creditRate,
      amexRate,
      internationalRate,
      fixedFeePerTransaction,
      monthlyServiceFee,
      minimumMonthlyVolume,
      volumePenalty,
      contractReference,
      notes,
    } = req.body

    // Validate required fields
    if (!venueId) {
      throw new BadRequestError('venueId is required')
    }

    if (!accountType) {
      throw new BadRequestError('accountType is required (PRIMARY, SECONDARY, or TERTIARY)')
    }

    if (!effectiveFrom) {
      throw new BadRequestError('effectiveFrom is required')
    }

    if (debitRate === undefined || creditRate === undefined || amexRate === undefined || internationalRate === undefined) {
      throw new BadRequestError('All rate fields are required: debitRate, creditRate, amexRate, internationalRate')
    }

    const pricingStructure = await venuePricingService.createVenuePricingStructure({
      venueId,
      accountType,
      effectiveFrom: new Date(effectiveFrom),
      debitRate,
      creditRate,
      amexRate,
      internationalRate,
      fixedFeePerTransaction,
      monthlyServiceFee,
      minimumMonthlyVolume,
      volumePenalty,
      contractReference,
      notes,
    })

    logger.info('Venue pricing structure created via API', {
      pricingStructureId: pricingStructure.id,
      createdBy: (req as any).user?.uid,
    })

    res.status(201).json({
      success: true,
      data: pricingStructure,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/superadmin/venue-pricing/structures/flat-rate
 * Create a flat-rate venue pricing structure
 */
export async function createFlatRatePricingStructure(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, accountType, effectiveFrom, flatRate, monthlyServiceFee, notes } = req.body

    // Validate required fields
    if (!venueId) {
      throw new BadRequestError('venueId is required')
    }

    if (!accountType) {
      throw new BadRequestError('accountType is required (PRIMARY, SECONDARY, or TERTIARY)')
    }

    if (!effectiveFrom) {
      throw new BadRequestError('effectiveFrom is required')
    }

    if (flatRate === undefined) {
      throw new BadRequestError('flatRate is required')
    }

    const pricingStructure = await venuePricingService.createFlatRatePricingStructure(
      venueId,
      accountType,
      new Date(effectiveFrom),
      flatRate,
      monthlyServiceFee,
      notes,
    )

    logger.info('Flat-rate venue pricing structure created via API', {
      pricingStructureId: pricingStructure.id,
      flatRate,
      createdBy: (req as any).user?.uid,
    })

    res.status(201).json({
      success: true,
      data: pricingStructure,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/superadmin/venue-pricing/structures/:id
 * Update a venue pricing structure
 */
export async function updateVenuePricingStructure(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const {
      effectiveFrom,
      effectiveTo,
      debitRate,
      creditRate,
      amexRate,
      internationalRate,
      fixedFeePerTransaction,
      monthlyServiceFee,
      minimumMonthlyVolume,
      volumePenalty,
      contractReference,
      notes,
      active,
    } = req.body

    const pricingStructure = await venuePricingService.updateVenuePricingStructure(id, {
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : undefined,
      effectiveTo: effectiveTo ? new Date(effectiveTo) : undefined,
      debitRate,
      creditRate,
      amexRate,
      internationalRate,
      fixedFeePerTransaction,
      monthlyServiceFee,
      minimumMonthlyVolume,
      volumePenalty,
      contractReference,
      notes,
      active,
    })

    logger.info('Venue pricing structure updated via API', {
      pricingStructureId: id,
      updatedBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      data: pricingStructure,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PATCH /api/v1/superadmin/venue-pricing/structures/:id/deactivate
 * Deactivate a pricing structure
 */
export async function deactivatePricingStructure(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const pricingStructure = await venuePricingService.deactivatePricingStructure(id)

    logger.info('Venue pricing structure deactivated via API', {
      pricingStructureId: id,
      deactivatedBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      data: pricingStructure,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/superadmin/venue-pricing/structures/:id
 * Delete a venue pricing structure
 */
export async function deleteVenuePricingStructure(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    await venuePricingService.deleteVenuePricingStructure(id)

    logger.warn('Venue pricing structure deleted via API', {
      pricingStructureId: id,
      deletedBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      message: 'Venue pricing structure deleted successfully',
    })
  } catch (error) {
    next(error)
  }
}
