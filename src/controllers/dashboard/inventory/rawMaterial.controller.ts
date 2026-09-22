import { Request, Response, NextFunction } from 'express'
import * as rawMaterialService from '../../../services/dashboard/rawMaterial.service'
import AppError from '../../../errors/AppError'
import prisma from '../../../utils/prismaClient'
import { adaptDashboardWaste, canRecordDashboardWaste } from '../../../services/shared/dashboardWasteAdapter'
import type { AdjustStockDto } from '../../../schemas/dashboard/inventory.schema'

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
    const staffId = req.authContext?.userId

    const rawMaterial = await rawMaterialService.updateRawMaterial(venueId, rawMaterialId, data, staffId)

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
 * Deactivate a raw material (soft disable)
 */
export async function deactivateRawMaterial(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, rawMaterialId } = req.params

    const rawMaterial = await rawMaterialService.deactivateRawMaterial(venueId, rawMaterialId)

    res.json({
      success: true,
      message: `Raw material "${rawMaterial.name}" has been deactivated`,
      data: rawMaterial,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Reactivate a raw material
 */
export async function reactivateRawMaterial(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, rawMaterialId } = req.params

    const rawMaterial = await rawMaterialService.reactivateRawMaterial(venueId, rawMaterialId)

    res.json({
      success: true,
      message: `Raw material "${rawMaterial.name}" has been reactivated`,
      data: rawMaterial,
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
    // Ya validado y normalizado por `validateRequest(AdjustStockSchema)`.
    const data = req.body as AdjustStockDto
    const staffId = req.authContext?.userId

    // Merma (SPOILAGE negativa) → libro de merma (tarea 10, spec §4.5). Mismo contrato de
    // respuesta, más `waste` (el resumen del folio). Ya no se rechaza por existencia: descuenta lo
    // que haya y marca el excedente. Todo lo demás —ADJUSTMENT, entradas— sigue igual que siempre.
    if (data.type === 'SPOILAGE' && data.quantity < 0 && canRecordDashboardWaste(staffId)) {
      const waste = await adaptDashboardWaste(venueId, staffId, 'RAW_MATERIAL', rawMaterialId, data)
      const updated = await prisma.rawMaterial.findFirstOrThrow({ where: { id: rawMaterialId, venueId } })
      res.json({
        success: true,
        message: 'Stock adjusted successfully',
        data: updated,
        waste,
      })
      return
    }

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
