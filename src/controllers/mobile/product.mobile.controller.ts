/**
 * Product Mobile Controller
 *
 * CRUD endpoints for iOS/Android product management.
 * Returns payloads with category, inventory, and modifierGroups included.
 * Response format: { success: true, data: <payload> }
 */

import { NextFunction, Request, Response } from 'express'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Calculate how many portions can be made from a recipe's raw materials.
 * Returns the minimum across all ingredients (bottleneck).
 */
function calculateAvailablePortions(recipe: any): number {
  if (!recipe?.lines || recipe.lines.length === 0) {
    return 0
  }

  const portionsPerIngredient = recipe.lines.map((line: any) => {
    const stock = Number(line.rawMaterial?.currentStock ?? 0)
    const needed = Number(line.quantity ?? 0)
    if (needed === 0) return Infinity
    return Math.floor(stock / needed)
  })

  return Math.min(...portionsPerIngredient)
}

/**
 * Shared Prisma include for product queries (matches dashboard shape).
 */
const productInclude = {
  category: true,
  inventory: true,
  modifierGroups: {
    include: {
      group: {
        include: {
          modifiers: { where: { active: true } },
        },
      },
    },
    orderBy: { displayOrder: 'asc' as const },
  },
  recipe: {
    include: {
      lines: {
        include: {
          rawMaterial: {
            select: { id: true, currentStock: true },
          },
        },
      },
    },
  },
}

/**
 * Attach computed `availableQuantity` to a product.
 */
function withAvailableQuantity(product: any) {
  let availableQuantity = null

  if (product.trackInventory) {
    if (product.inventoryMethod === 'QUANTITY') {
      availableQuantity = Math.floor(Number(product.inventory?.currentStock ?? 0))
    } else if (product.inventoryMethod === 'RECIPE' && product.recipe) {
      availableQuantity = calculateAvailablePortions(product.recipe)
    }
  }

  return { ...product, availableQuantity }
}

// ---------------------------------------------------------------------------
// GET /api/v1/mobile/venues/:venueId/products
// ---------------------------------------------------------------------------

/**
 * List all active, non-deleted products for a venue.
 * Includes category, inventory, and modifierGroups (with modifiers).
 * Ordered by category.displayOrder, then product.displayOrder, then name.
 */
export async function listProducts(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const products = await prisma.product.findMany({
      where: {
        venueId,
        active: true,
        deletedAt: null,
      },
      include: productInclude,
      orderBy: [{ category: { displayOrder: 'asc' } }, { displayOrder: 'asc' }, { name: 'asc' }],
    })

    const data = products.map(withAvailableQuantity)

    return res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/mobile/venues/:venueId/products
// ---------------------------------------------------------------------------

/**
 * Create a new product.
 * Requires `name`. Generates SKU if not provided.
 * Defaults: type FOOD_AND_BEV, taxRate 0.16.
 */
export async function createProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { name, price, sku, gtin, categoryId, type, description, taxRate, trackInventory, durationMinutes } = req.body

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'name es requerido' })
    }

    // If no categoryId provided, use first category for this venue
    let finalCategoryId = categoryId
    if (!finalCategoryId) {
      const firstCategory = await prisma.menuCategory.findFirst({
        where: { venueId },
        orderBy: { displayOrder: 'asc' },
        select: { id: true },
      })
      if (!firstCategory) {
        return res.status(400).json({ success: false, message: 'No hay categorías. Crea una categoría primero.' })
      }
      finalCategoryId = firstCategory.id
    }

    // Generate SKU if not provided
    const finalSku = sku || `SKU-${Date.now().toString(36).toUpperCase()}`

    const product = await prisma.product.create({
      data: {
        name: name.trim(),
        venueId,
        sku: finalSku,
        gtin: gtin?.trim() || null,
        description: description || null,
        categoryId: finalCategoryId,
        type: type || 'FOOD_AND_BEV',
        price: price ? parseFloat(price) : 0,
        taxRate: taxRate ?? 0.16,
        trackInventory: trackInventory ?? false,
        durationMinutes: durationMinutes || null,
      },
      include: productInclude,
    })

    return res.status(201).json({ success: true, data: withAvailableQuantity(product) })
  } catch (error) {
    logger.error('Error creating product (mobile)', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params.venueId,
    })
    next(error)
  }
}

// ---------------------------------------------------------------------------
// PUT /api/v1/mobile/venues/:venueId/products/:productId
// ---------------------------------------------------------------------------

/**
 * Update an existing product's fields.
 */
export async function updateProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId } = req.params
    const data = req.body

    // Verify the product belongs to this venue and is not deleted
    const existing = await prisma.product.findFirst({
      where: { id: productId, venueId, deletedAt: null },
      select: { id: true },
    })

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Producto no encontrado' })
    }

    const product = await prisma.product.update({
      where: { id: productId },
      data,
      include: productInclude,
    })

    return res.json({ success: true, data: withAvailableQuantity(product) })
  } catch (error) {
    logger.error('Error updating product (mobile)', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params.venueId,
      productId: req.params.productId,
    })
    next(error)
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/mobile/venues/:venueId/products/:productId
// ---------------------------------------------------------------------------

/**
 * Soft-delete a product (sets deletedAt + active=false).
 */
export async function deleteProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId } = req.params

    // Verify the product belongs to this venue and is not already deleted
    const existing = await prisma.product.findFirst({
      where: { id: productId, venueId, deletedAt: null },
      select: { id: true },
    })

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Producto no encontrado' })
    }

    const product = await prisma.product.update({
      where: { id: productId },
      data: {
        deletedAt: new Date(),
        active: false,
        deletedBy: req.authContext?.userId || null,
      },
    })

    return res.json({ success: true, data: { id: product.id } })
  } catch (error) {
    logger.error('Error deleting product (mobile)', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params.venueId,
      productId: req.params.productId,
    })
    next(error)
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/mobile/venues/:venueId/categories
// (kept here for backwards compat — also available via category controller)
// ---------------------------------------------------------------------------

/**
 * Returns simplified category list for mobile apps (create product flow).
 */
export async function listCategories(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const categories = await prisma.menuCategory.findMany({
      where: { venueId, active: true },
      orderBy: { displayOrder: 'asc' },
      select: {
        id: true,
        name: true,
        color: true,
      },
    })

    return res.json({ success: true, data: categories })
  } catch (error) {
    next(error)
  }
}
