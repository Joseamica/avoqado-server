/**
 * Mobile Inventory Controller
 *
 * Stock overview and stock count endpoints for mobile apps.
 */

import { NextFunction, Request, Response } from 'express'
import * as inventoryService from '../../services/mobile/inventory.mobile.service'

/**
 * Get stock overview (products with inventory)
 * @route GET /api/v1/mobile/venues/:venueId/inventory/stock-overview
 */
export const getStockOverview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const page = parseInt(req.query.page as string) || 1
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 50, 100)

    const filters: inventoryService.StockOverviewFilters = {}
    if (req.query.search) filters.search = req.query.search as string
    if (req.query.categoryId) filters.categoryId = req.query.categoryId as string
    if (req.query.sortBy) filters.sortBy = req.query.sortBy as any

    const result = await inventoryService.getStockOverview(venueId, page, pageSize, filters)

    return res.json({ success: true, ...result })
  } catch (error) {
    next(error)
  }
}

/**
 * Get stock counts
 * @route GET /api/v1/mobile/venues/:venueId/inventory/stock-counts
 */
export const getStockCounts = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const counts = await inventoryService.getStockCounts(venueId)
    return res.json({ success: true, counts })
  } catch (error) {
    next(error)
  }
}

/**
 * Create stock count
 * @route POST /api/v1/mobile/venues/:venueId/inventory/stock-counts
 */
export const createStockCount = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const userId = req.authContext?.userId || ''
    const { type, productIds } = req.body

    const count = await inventoryService.createStockCount(venueId, userId, type, productIds)
    return res.status(201).json({ success: true, count })
  } catch (error) {
    next(error)
  }
}

/**
 * Update stock count (set counted quantities)
 * @route PUT /api/v1/mobile/venues/:venueId/inventory/stock-counts/:countId
 */
export const updateStockCount = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, countId } = req.params
    const { items, note } = req.body

    const result = await inventoryService.updateStockCount(countId, venueId, items, note)
    return res.json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * Confirm stock count (apply adjustments)
 * @route POST /api/v1/mobile/venues/:venueId/inventory/stock-counts/:countId/confirm
 */
export const confirmStockCount = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, countId } = req.params
    const userId = req.authContext?.userId || ''

    const result = await inventoryService.confirmStockCount(countId, venueId, userId)
    return res.json(result)
  } catch (error) {
    next(error)
  }
}
