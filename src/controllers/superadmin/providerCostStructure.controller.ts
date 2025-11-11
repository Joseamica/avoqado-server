import { Request, Response, NextFunction } from 'express'
import * as providerCostStructureService from '../../services/superadmin/providerCostStructure.service'
import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'

/**
 * ProviderCostStructure Controller
 *
 * REST API endpoints for managing provider cost structures with timeline support.
 * All endpoints require SUPERADMIN role (enforced by parent router middleware).
 */

/**
 * GET /api/v1/superadmin/provider-cost-structures
 * Get all provider cost structures with optional filters
 */
export async function getProviderCostStructures(req: Request, res: Response, next: NextFunction) {
  try {
    const { merchantAccountId, includeInactive } = req.query

    const costStructures = await providerCostStructureService.getProviderCostStructures(
      merchantAccountId as string | undefined,
      includeInactive === 'true',
    )

    res.json({
      success: true,
      data: costStructures,
      count: costStructures.length,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/provider-cost-structures/:id
 * Get a single provider cost structure by ID
 */
export async function getProviderCostStructure(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const costStructure = await providerCostStructureService.getProviderCostStructure(id)

    res.json({
      success: true,
      data: costStructure,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/provider-cost-structures/active/:merchantAccountId
 * Get the currently active cost structure for a merchant account
 */
export async function getActiveCostStructure(req: Request, res: Response, next: NextFunction) {
  try {
    const { merchantAccountId } = req.params

    const costStructure = await providerCostStructureService.getActiveCostStructure(merchantAccountId)

    if (!costStructure) {
      res.json({
        success: true,
        data: null,
        message: 'No active cost structure found for this merchant account',
      })
      return
    }

    res.json({
      success: true,
      data: costStructure,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/superadmin/provider-cost-structures
 * Create a new provider cost structure
 */
export async function createProviderCostStructure(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      merchantAccountId,
      effectiveFrom,
      debitRate,
      creditRate,
      amexRate,
      internationalRate,
      fixedCostPerTransaction,
      monthlyFee,
      notes,
    } = req.body

    // Validate required fields
    if (!merchantAccountId) {
      throw new BadRequestError('merchantAccountId is required')
    }

    if (!effectiveFrom) {
      throw new BadRequestError('effectiveFrom is required')
    }

    if (debitRate === undefined || creditRate === undefined || amexRate === undefined || internationalRate === undefined) {
      throw new BadRequestError('All rate fields are required: debitRate, creditRate, amexRate, internationalRate')
    }

    const costStructure = await providerCostStructureService.createProviderCostStructure({
      merchantAccountId,
      effectiveFrom: new Date(effectiveFrom),
      debitRate,
      creditRate,
      amexRate,
      internationalRate,
      fixedCostPerTransaction,
      monthlyFee,
      notes,
    })

    logger.info('Provider cost structure created via API', {
      costStructureId: costStructure.id,
      createdBy: (req as any).user?.uid,
    })

    res.status(201).json({
      success: true,
      data: costStructure,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/superadmin/provider-cost-structures/flat-rate
 * Create a flat-rate cost structure (same rate for all card types)
 */
export async function createFlatRateCostStructure(req: Request, res: Response, next: NextFunction) {
  try {
    const { merchantAccountId, effectiveFrom, flatRate, fixedCostPerTransaction, notes } = req.body

    // Validate required fields
    if (!merchantAccountId) {
      throw new BadRequestError('merchantAccountId is required')
    }

    if (!effectiveFrom) {
      throw new BadRequestError('effectiveFrom is required')
    }

    if (flatRate === undefined) {
      throw new BadRequestError('flatRate is required')
    }

    const costStructure = await providerCostStructureService.createFlatRateCostStructure(
      merchantAccountId,
      new Date(effectiveFrom),
      flatRate,
      fixedCostPerTransaction,
      notes,
    )

    logger.info('Flat-rate provider cost structure created via API', {
      costStructureId: costStructure.id,
      flatRate,
      createdBy: (req as any).user?.uid,
    })

    res.status(201).json({
      success: true,
      data: costStructure,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/superadmin/provider-cost-structures/:id
 * Update a provider cost structure
 */
export async function updateProviderCostStructure(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const {
      effectiveFrom,
      effectiveTo,
      debitRate,
      creditRate,
      amexRate,
      internationalRate,
      fixedCostPerTransaction,
      monthlyFee,
      notes,
      active,
    } = req.body

    const costStructure = await providerCostStructureService.updateProviderCostStructure(id, {
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : undefined,
      effectiveTo: effectiveTo ? new Date(effectiveTo) : undefined,
      debitRate,
      creditRate,
      amexRate,
      internationalRate,
      fixedCostPerTransaction,
      monthlyFee,
      notes,
      active,
    })

    logger.info('Provider cost structure updated via API', {
      costStructureId: id,
      updatedBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      data: costStructure,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PATCH /api/v1/superadmin/provider-cost-structures/:id/deactivate
 * Deactivate a cost structure
 */
export async function deactivateCostStructure(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const costStructure = await providerCostStructureService.deactivateCostStructure(id)

    logger.info('Provider cost structure deactivated via API', {
      costStructureId: id,
      deactivatedBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      data: costStructure,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/superadmin/provider-cost-structures/:id
 * Delete a provider cost structure
 * Only allowed if no transaction costs reference it
 */
export async function deleteProviderCostStructure(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    await providerCostStructureService.deleteProviderCostStructure(id)

    logger.warn('Provider cost structure deleted via API', {
      costStructureId: id,
      deletedBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      message: 'Provider cost structure deleted successfully',
    })
  } catch (error) {
    next(error)
  }
}
