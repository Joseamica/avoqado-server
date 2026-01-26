/**
 * Item Category Routes
 *
 * CRUD operations for serialized inventory item categories.
 * Used by PlayTelecom and other white-label dashboards.
 *
 * Base path: /api/v1/dashboard/venues/:venueId/item-categories
 */

import { Router } from 'express'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'

import * as itemCategoryController from '@/controllers/dashboard/itemCategory.dashboard.controller'
import { checkPermission } from '@/middlewares/checkPermission.middleware'

const router = Router({ mergeParams: true })

// All routes require authentication
router.use(authenticateTokenMiddleware)

/**
 * GET /item-categories
 * Get all categories for the venue
 * Query: ?includeStats=true to include item counts
 */
router.get('/', checkPermission('inventory:read'), itemCategoryController.getItemCategories)

/**
 * GET /item-categories/:categoryId
 * Get a single category with stats
 */
router.get('/:categoryId', checkPermission('inventory:read'), itemCategoryController.getItemCategoryById)

/**
 * POST /item-categories
 * Create a new category
 * Body: { name, description?, color?, sortOrder?, requiresPreRegistration?, suggestedPrice?, barcodePattern? }
 */
router.post('/', checkPermission('inventory:update'), itemCategoryController.createItemCategory)

/**
 * PUT /item-categories/:categoryId
 * Update a category
 * Body: { name?, description?, color?, sortOrder?, requiresPreRegistration?, suggestedPrice?, barcodePattern?, active? }
 */
router.put('/:categoryId', checkPermission('inventory:update'), itemCategoryController.updateItemCategory)

/**
 * DELETE /item-categories/:categoryId
 * Delete a category (soft delete if has items)
 */
router.delete('/:categoryId', checkPermission('inventory:delete'), itemCategoryController.deleteItemCategory)

/**
 * POST /item-categories/:categoryId/items/bulk
 * Bulk upload items to a category
 * Body: { csvContent?: string, serialNumbers?: string[] }
 */
router.post('/:categoryId/items/bulk', checkPermission('inventory:update'), itemCategoryController.bulkUploadItems)

/**
 * GET /item-categories/:categoryId/items
 * Get items in a category with pagination
 * Query: ?status=AVAILABLE&page=1&pageSize=50&search=
 */
router.get('/:categoryId/items', checkPermission('inventory:read'), itemCategoryController.getCategoryItems)

export default router
