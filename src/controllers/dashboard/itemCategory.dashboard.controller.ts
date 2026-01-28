/**
 * Item Category Controller (Thin HTTP Layer)
 *
 * CRUD operations for serialized inventory item categories.
 * Used by PlayTelecom and other white-label dashboards for
 * managing SIM categories, jewelry types, etc.
 *
 * PATTERN: Thin Controller Architecture
 * - Extract data from req (params, query, body)
 * - Call service method (business logic lives there)
 * - Return HTTP response
 */

import { Request, Response, NextFunction } from 'express'
import * as itemCategoryService from '@/services/dashboard/itemCategory.dashboard.service'

/**
 * GET /api/v1/dashboard/venues/:venueId/item-categories
 * Get all item categories for a venue
 */
export async function getItemCategories(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { includeStats } = req.query

    const result = await itemCategoryService.getItemCategories(venueId, {
      includeStats: includeStats === 'true',
    })

    return res.status(200).json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/item-categories/:categoryId
 * Get a single item category by ID
 */
export async function getItemCategoryById(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, categoryId } = req.params

    const result = await itemCategoryService.getItemCategoryById(venueId, categoryId)

    return res.status(200).json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/item-categories
 * Create a new item category
 */
export async function createItemCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const data = req.body

    const result = await itemCategoryService.createItemCategory(venueId, data)

    return res.status(201).json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/dashboard/venues/:venueId/item-categories/:categoryId
 * Update an item category
 */
export async function updateItemCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, categoryId } = req.params
    const data = req.body

    const result = await itemCategoryService.updateItemCategory(venueId, categoryId, data)

    return res.status(200).json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/dashboard/venues/:venueId/item-categories/:categoryId
 * Delete an item category (soft delete - sets active to false)
 */
export async function deleteItemCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, categoryId } = req.params

    const result = await itemCategoryService.deleteItemCategory(venueId, categoryId)

    return res.status(200).json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/item-categories/:categoryId/items/bulk
 * Bulk upload serialized items to a category via CSV
 */
export async function bulkUploadItems(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, categoryId } = req.params
    const { userId } = (req as any).authContext
    const { csvContent, serialNumbers } = req.body

    const result = await itemCategoryService.bulkUploadItems(venueId, categoryId, {
      csvContent,
      serialNumbers,
      registeredBy: userId,
    })

    return res.status(200).json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/item-categories/:categoryId/items
 * Get items in a category with pagination
 */
export async function getCategoryItems(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, categoryId } = req.params
    const { status, page, pageSize, search } = req.query

    const result = await itemCategoryService.getCategoryItems(venueId, categoryId, {
      status: status as string,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search: search as string,
    })

    return res.status(200).json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}
