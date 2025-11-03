import { Request, Response, NextFunction } from 'express'
import * as settlementConfigService from '../../services/superadmin/settlementConfiguration.service'
import { BadRequestError } from '../../errors/AppError'

/**
 * SettlementConfiguration Controller (Superadmin)
 *
 * REST API endpoints for managing settlement configurations.
 * All endpoints require SUPERADMIN role (enforced by parent router middleware).
 */

/**
 * GET /api/v1/superadmin/settlement-configurations
 * Get all settlement configurations with optional filters
 */
export async function getSettlementConfigurations(req: Request, res: Response, next: NextFunction) {
  try {
    const { merchantAccountId, cardType, includeExpired } = req.query

    const configurations = await settlementConfigService.getSettlementConfigurations(
      {
        merchantAccountId: merchantAccountId as string | undefined,
        cardType: cardType as any,
      },
      includeExpired === 'true',
    )

    res.json({
      success: true,
      data: configurations,
      count: configurations.length,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/settlement-configurations/:id
 * Get a single settlement configuration by ID
 */
export async function getSettlementConfiguration(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const configuration = await settlementConfigService.getSettlementConfigurationById(id)

    res.json({
      success: true,
      data: configuration,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/settlement-configurations/active/:merchantAccountId/:cardType
 * Get the currently active configuration for a merchant account and card type
 */
export async function getActiveConfiguration(req: Request, res: Response, next: NextFunction) {
  try {
    const { merchantAccountId, cardType } = req.params

    const configuration = await settlementConfigService.getActiveConfiguration(merchantAccountId, cardType as any)

    if (!configuration) {
      res.json({
        success: true,
        data: null,
        message: 'No active settlement configuration found',
      })
      return
    }

    res.json({
      success: true,
      data: configuration,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/superadmin/settlement-configurations
 * Create a new settlement configuration
 */
export async function createSettlementConfiguration(req: Request, res: Response, next: NextFunction) {
  try {
    const { merchantAccountId, cardType, settlementDays, settlementDayType, cutoffTime, cutoffTimezone, effectiveFrom, notes } = req.body

    // Get user ID from auth middleware
    const createdBy = (req as any).user?.id

    // Validate required fields
    if (!merchantAccountId) {
      throw new BadRequestError('merchantAccountId is required')
    }

    if (!cardType) {
      throw new BadRequestError('cardType is required')
    }

    if (settlementDays === undefined || settlementDays === null) {
      throw new BadRequestError('settlementDays is required')
    }

    if (!settlementDayType) {
      throw new BadRequestError('settlementDayType is required')
    }

    if (!cutoffTime) {
      throw new BadRequestError('cutoffTime is required')
    }

    if (!cutoffTimezone) {
      throw new BadRequestError('cutoffTimezone is required')
    }

    if (!effectiveFrom) {
      throw new BadRequestError('effectiveFrom is required')
    }

    const configuration = await settlementConfigService.createSettlementConfiguration({
      merchantAccountId,
      cardType,
      settlementDays,
      settlementDayType,
      cutoffTime,
      cutoffTimezone,
      effectiveFrom: new Date(effectiveFrom),
      notes,
      createdBy,
    })

    res.status(201).json({
      success: true,
      data: configuration,
      message: 'Settlement configuration created successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/superadmin/settlement-configurations/:id
 * Update a settlement configuration
 */
export async function updateSettlementConfiguration(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { settlementDays, settlementDayType, cutoffTime, cutoffTimezone, effectiveFrom, effectiveTo, notes } = req.body

    const updateData: any = {}

    if (settlementDays !== undefined) updateData.settlementDays = settlementDays
    if (settlementDayType !== undefined) updateData.settlementDayType = settlementDayType
    if (cutoffTime !== undefined) updateData.cutoffTime = cutoffTime
    if (cutoffTimezone !== undefined) updateData.cutoffTimezone = cutoffTimezone
    if (notes !== undefined) updateData.notes = notes

    // Handle date fields
    if (effectiveFrom !== undefined) updateData.effectiveFrom = new Date(effectiveFrom)
    if (effectiveTo !== undefined) updateData.effectiveTo = effectiveTo ? new Date(effectiveTo) : null

    const configuration = await settlementConfigService.updateSettlementConfiguration(id, updateData)

    res.json({
      success: true,
      data: configuration,
      message: 'Settlement configuration updated successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/superadmin/settlement-configurations/:id
 * Delete a settlement configuration
 */
export async function deleteSettlementConfiguration(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    await settlementConfigService.deleteSettlementConfiguration(id)

    res.json({
      success: true,
      message: 'Settlement configuration deleted successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/superadmin/settlement-configurations/bulk
 * Bulk create settlement configurations for a merchant account
 */
export async function bulkCreateSettlementConfigurations(req: Request, res: Response, next: NextFunction) {
  try {
    const { merchantAccountId, configs, effectiveFrom } = req.body

    // Get user ID from auth middleware
    const createdBy = (req as any).user?.id

    // Validate required fields
    if (!merchantAccountId) {
      throw new BadRequestError('merchantAccountId is required')
    }

    if (!configs || !Array.isArray(configs) || configs.length === 0) {
      throw new BadRequestError('configs array is required and must not be empty')
    }

    if (!effectiveFrom) {
      throw new BadRequestError('effectiveFrom is required')
    }

    const configurations = await settlementConfigService.bulkCreateSettlementConfigurations(
      merchantAccountId,
      configs,
      new Date(effectiveFrom),
      createdBy,
    )

    res.status(201).json({
      success: true,
      data: configurations,
      count: configurations.length,
      message: 'Settlement configurations created successfully',
    })
  } catch (error) {
    next(error)
  }
}
