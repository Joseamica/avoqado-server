import { Request, Response } from 'express'
import * as venuePaymentConfigService from '../services/venuePaymentConfig.service'
import logger from '@/config/logger'

/**
 * GET /api/v1/dashboard/venues/:venueId/payment-config
 * Get payment configuration for a venue
 */
export async function getVenuePaymentConfig(req: Request, res: Response) {
  try {
    const { venueId } = req.params

    const config = await venuePaymentConfigService.getVenuePaymentConfig(venueId)

    if (!config) {
      return res.status(404).json({
        success: false,
        error: 'Payment config not found for this venue',
      })
    }

    res.json({
      success: true,
      data: config,
    })
  } catch (error: any) {
    logger.error('Error getting venue payment config:', error)
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get payment config',
    })
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/payment-config
 * Create payment configuration for a venue
 */
export async function createVenuePaymentConfig(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { primaryAccountId, secondaryAccountId, tertiaryAccountId, routingRules, preferredProcessor } = req.body

    if (!primaryAccountId) {
      return res.status(400).json({
        success: false,
        error: 'Primary account ID is required',
      })
    }

    const config = await venuePaymentConfigService.createVenuePaymentConfig({
      venueId,
      primaryAccountId,
      secondaryAccountId,
      tertiaryAccountId,
      routingRules,
      preferredProcessor,
    })

    res.status(201).json({
      success: true,
      data: config,
    })
  } catch (error: any) {
    logger.error('Error creating venue payment config:', error)
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to create payment config',
    })
  }
}

/**
 * PUT /api/v1/dashboard/venues/:venueId/payment-config/:configId
 * Update payment configuration for a venue
 */
export async function updateVenuePaymentConfig(req: Request, res: Response) {
  try {
    const { configId } = req.params
    const { primaryAccountId, secondaryAccountId, tertiaryAccountId, routingRules, preferredProcessor } = req.body

    const config = await venuePaymentConfigService.updateVenuePaymentConfig(configId, {
      primaryAccountId,
      secondaryAccountId,
      tertiaryAccountId,
      routingRules,
      preferredProcessor,
    })

    res.json({
      success: true,
      data: config,
    })
  } catch (error: any) {
    logger.error('Error updating venue payment config:', error)
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to update payment config',
    })
  }
}

/**
 * DELETE /api/v1/dashboard/venues/:venueId/payment-config/:configId
 * Delete payment configuration for a venue
 */
export async function deleteVenuePaymentConfig(req: Request, res: Response) {
  try {
    const { configId } = req.params

    await venuePaymentConfigService.deleteVenuePaymentConfig(configId)

    res.json({
      success: true,
      message: 'Payment config deleted successfully',
    })
  } catch (error: any) {
    logger.error('Error deleting venue payment config:', error)
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to delete payment config',
    })
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/merchant-accounts
 * Get merchant accounts for a venue (based on payment config)
 */
export async function getVenueMerchantAccounts(req: Request, res: Response) {
  try {
    const { venueId } = req.params

    const accounts = await venuePaymentConfigService.getVenueMerchantAccounts(venueId)

    res.json({
      success: true,
      data: accounts,
    })
  } catch (error: any) {
    logger.error('Error getting venue merchant accounts:', error)
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get merchant accounts',
    })
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/pricing-structures
 * Get venue pricing structures for a venue
 */
export async function getVenuePricingStructures(req: Request, res: Response) {
  try {
    const { venueId } = req.params

    const pricingStructures = await venuePaymentConfigService.getVenuePricingByVenue(venueId)

    res.json({
      success: true,
      data: pricingStructures,
    })
  } catch (error: any) {
    logger.error('Error getting venue pricing structures:', error)
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get pricing structures',
    })
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/cost-structures
 * Get cost structures for venue's merchant accounts
 */
export async function getVenueCostStructures(req: Request, res: Response) {
  try {
    const { venueId } = req.params

    const costStructures = await venuePaymentConfigService.getVenueCostStructures(venueId)

    res.json({
      success: true,
      data: costStructures,
    })
  } catch (error: any) {
    logger.error('Error getting venue cost structures:', error)
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get cost structures',
    })
  }
}
