import { Request, Response, NextFunction } from 'express'
import * as supplierService from '../../../services/dashboard/supplier.service'
import AppError from '../../../errors/AppError'

/**
 * Get all suppliers for a venue
 */
export async function getSuppliers(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { active, search, rating } = req.query

    const filters = {
      active: active === 'true' ? true : active === 'false' ? false : undefined,
      search: search as string | undefined,
      rating: rating ? parseFloat(rating as string) : undefined,
    }

    const suppliers = await supplierService.getSuppliers(venueId, filters)

    res.json({
      success: true,
      data: suppliers,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get a single supplier by ID
 */
export async function getSupplier(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, supplierId } = req.params

    const supplier = await supplierService.getSupplier(venueId, supplierId)

    if (!supplier) {
      throw new AppError('Supplier not found', 404)
    }

    res.json({
      success: true,
      data: supplier,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Create a new supplier
 */
export async function createSupplier(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const data = req.body

    const supplier = await supplierService.createSupplier(venueId, data)

    res.status(201).json({
      success: true,
      message: 'Supplier created successfully',
      data: supplier,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Update an existing supplier
 */
export async function updateSupplier(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, supplierId } = req.params
    const data = req.body

    const supplier = await supplierService.updateSupplier(venueId, supplierId, data)

    res.json({
      success: true,
      message: 'Supplier updated successfully',
      data: supplier,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Delete a supplier
 */
export async function deleteSupplier(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, supplierId } = req.params

    await supplierService.deleteSupplier(venueId, supplierId)

    res.json({
      success: true,
      message: 'Supplier deleted successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Create supplier pricing for a raw material
 */
export async function createSupplierPricing(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, supplierId } = req.params
    const data = req.body

    const pricing = await supplierService.createSupplierPricing(venueId, supplierId, data)

    res.status(201).json({
      success: true,
      message: 'Supplier pricing created successfully',
      data: pricing,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get supplier pricing history for a raw material
 */
export async function getSupplierPricingHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, rawMaterialId } = req.params

    const history = await supplierService.getSupplierPricingHistory(venueId, rawMaterialId)

    res.json({
      success: true,
      data: history,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get supplier recommendations for a raw material
 */
export async function getSupplierRecommendations(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, rawMaterialId } = req.params
    const { quantity } = req.query

    const recommendations = await supplierService.getSupplierRecommendations(
      venueId,
      rawMaterialId,
      quantity ? parseFloat(quantity as string) : 1,
    )

    res.json({
      success: true,
      data: recommendations,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get supplier performance metrics
 */
export async function getSupplierPerformance(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, supplierId } = req.params
    const { startDate, endDate } = req.query

    const performance = await supplierService.getSupplierPerformance(
      venueId,
      supplierId,
      startDate ? new Date(startDate as string) : undefined,
      endDate ? new Date(endDate as string) : undefined,
    )

    res.json({
      success: true,
      data: performance,
    })
  } catch (error) {
    next(error)
  }
}
