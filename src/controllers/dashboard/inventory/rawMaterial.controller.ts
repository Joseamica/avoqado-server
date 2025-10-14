import { Request, Response, NextFunction } from 'express'
import * as rawMaterialService from '../../../services/dashboard/rawMaterial.service'
import AppError from '../../../errors/AppError'

/**
 * Get all raw materials for a venue
 */
export async function getRawMaterials(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { category, lowStock, active, search } = req.query

    const filters = {
      category: category as string | undefined,
      lowStock: lowStock === 'true',
      active: active === 'true' ? true : active === 'false' ? false : undefined,
      search: search as string | undefined,
    }

    const rawMaterials = await rawMaterialService.getRawMaterials(venueId, filters)

    res.json({
      success: true,
      data: rawMaterials,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get a single raw material by ID
 */
export async function getRawMaterial(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, rawMaterialId } = req.params

    const rawMaterial = await rawMaterialService.getRawMaterial(venueId, rawMaterialId)

    if (!rawMaterial) {
      throw new AppError('Raw material not found', 404)
    }

    res.json({
      success: true,
      data: rawMaterial,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Create a new raw material
 */
export async function createRawMaterial(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const data = req.body

    const rawMaterial = await rawMaterialService.createRawMaterial(venueId, data)

    res.status(201).json({
      success: true,
      message: 'Raw material created successfully',
      data: rawMaterial,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Update an existing raw material
 */
export async function updateRawMaterial(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, rawMaterialId } = req.params
    const data = req.body

    const rawMaterial = await rawMaterialService.updateRawMaterial(venueId, rawMaterialId, data)

    res.json({
      success: true,
      message: 'Raw material updated successfully',
      data: rawMaterial,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Delete a raw material
 */
export async function deleteRawMaterial(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, rawMaterialId } = req.params

    await rawMaterialService.deleteRawMaterial(venueId, rawMaterialId)

    res.json({
      success: true,
      message: 'Raw material deleted successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Adjust stock for a raw material
 */
export async function adjustStock(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, rawMaterialId } = req.params
    const data = req.body
    const staffId = req.authContext?.userId

    const rawMaterial = await rawMaterialService.adjustStock(venueId, rawMaterialId, data, staffId)

    res.json({
      success: true,
      message: 'Stock adjusted successfully',
      data: rawMaterial,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get recipes that use a raw material
 */
export async function getRawMaterialRecipes(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, rawMaterialId } = req.params

    const recipes = await rawMaterialService.getRawMaterialRecipes(venueId, rawMaterialId)

    res.json({
      success: true,
      data: recipes,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get stock movements for a raw material
 */
export async function getStockMovements(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, rawMaterialId } = req.params
    const { startDate, endDate, limit } = req.query

    const options = {
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
    }

    const movements = await rawMaterialService.getStockMovements(venueId, rawMaterialId, options)

    res.json({
      success: true,
      data: movements,
    })
  } catch (error) {
    next(error)
  }
}
