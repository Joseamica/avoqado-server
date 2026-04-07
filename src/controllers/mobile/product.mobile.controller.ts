/**
 * Product Mobile Controller
 *
 * Lightweight endpoints for iOS/Android product-related data.
 * Returns simplified payloads optimized for mobile apps.
 */

import { Request, Response } from 'express'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'

/**
 * GET /api/v1/mobile/venues/:venueId/products
 *
 * List all products for a venue (mobile apps).
 */
export async function listProducts(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const products = await prisma.product.findMany({
      where: { venueId },
      include: { category: true },
      orderBy: { createdAt: 'desc' },
    })
    return res.json(products)
  } catch (error) {
    logger.error('Error listing products (mobile)', { error })
    return res.status(500).json({ success: false, message: 'Error al cargar productos' })
  }
}

/**
 * POST /api/v1/mobile/venues/:venueId/products
 *
 * Create a new product from mobile apps.
 */
export async function createProduct(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { name, price, sku, categoryId, type, description, taxRate, trackInventory, durationMinutes } = req.body

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
        description: description || null,
        categoryId: finalCategoryId,
        type: type || 'REGULAR',
        price: price ? parseFloat(price) : 0,
        taxRate: taxRate ?? 0.16,
        trackInventory: trackInventory ?? false,
        durationMinutes: durationMinutes || null,
      },
      include: { category: true },
    })

    return res.status(201).json({ success: true, product })
  } catch (error) {
    logger.error('Error creating product (mobile)', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params.venueId,
    })

    return res.status(500).json({
      success: false,
      message: 'Error al crear producto',
    })
  }
}

/**
 * GET /api/v1/mobile/venues/:venueId/categories
 *
 * Returns simplified category list for mobile apps (create product flow).
 */
export async function listCategories(req: Request, res: Response) {
  try {
    const { venueId } = req.params

    const categories = await prisma.menuCategory.findMany({
      where: { venueId },
      orderBy: { displayOrder: 'asc' },
      select: {
        id: true,
        name: true,
        color: true,
      },
    })

    return res.json(categories)
  } catch (error) {
    logger.error('Error in listCategories (mobile)', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params.venueId,
    })

    return res.status(500).json({
      success: false,
      message: 'Error al cargar categorías',
    })
  }
}
