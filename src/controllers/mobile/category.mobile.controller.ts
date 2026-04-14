/**
 * Category Mobile Controller
 *
 * CRUD endpoints for iOS/Android category management.
 * Response format: { success: true, data: <payload> }
 */

import { NextFunction, Request, Response } from 'express'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a URL-safe slug from a name.
 * Example: "Bebidas Frías" → "bebidas-frias"
 */
function slugify(text: string): string {
  return text
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ---------------------------------------------------------------------------
// GET /api/v1/mobile/venues/:venueId/categories
// ---------------------------------------------------------------------------

/**
 * List all active categories for a venue, ordered by displayOrder.
 */
export async function listCategories(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const categories = await prisma.menuCategory.findMany({
      where: { venueId, active: true },
      orderBy: { displayOrder: 'asc' },
    })

    return res.json({ success: true, data: categories })
  } catch (error) {
    next(error)
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/mobile/venues/:venueId/categories
// ---------------------------------------------------------------------------

/**
 * Create a new category. Requires `name`. Generates slug from name.
 */
export async function createCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { name, description, color, icon, imageUrl, displayOrder, parentId } = req.body

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'name es requerido' })
    }

    // Generate slug, ensure uniqueness within venue
    let slug = slugify(name)
    const existing = await prisma.menuCategory.findUnique({
      where: { venueId_slug: { venueId, slug } },
      select: { id: true },
    })
    if (existing) {
      slug = `${slug}-${Date.now().toString(36)}`
    }

    const category = await prisma.menuCategory.create({
      data: {
        name: name.trim(),
        slug,
        venueId,
        description: description || null,
        color: color || null,
        icon: icon || null,
        imageUrl: imageUrl || null,
        displayOrder: displayOrder ?? 0,
        parentId: parentId || null,
      },
    })

    return res.status(201).json({ success: true, data: category })
  } catch (error) {
    logger.error('Error creating category (mobile)', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params.venueId,
    })
    next(error)
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/v1/mobile/venues/:venueId/categories/:categoryId
// ---------------------------------------------------------------------------

/**
 * Update an existing category.
 */
export async function updateCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, categoryId } = req.params
    const data = req.body

    // Verify category belongs to this venue
    const existing = await prisma.menuCategory.findFirst({
      where: { id: categoryId, venueId },
      select: { id: true },
    })

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Categoría no encontrada' })
    }

    // If name changed, regenerate slug
    if (data.name) {
      let slug = slugify(data.name)
      const slugConflict = await prisma.menuCategory.findFirst({
        where: { venueId, slug, id: { not: categoryId } },
        select: { id: true },
      })
      if (slugConflict) {
        slug = `${slug}-${Date.now().toString(36)}`
      }
      data.slug = slug
    }

    const category = await prisma.menuCategory.update({
      where: { id: categoryId },
      data,
    })

    return res.json({ success: true, data: category })
  } catch (error) {
    logger.error('Error updating category (mobile)', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params.venueId,
      categoryId: req.params.categoryId,
    })
    next(error)
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/mobile/venues/:venueId/categories/:categoryId
// ---------------------------------------------------------------------------

/**
 * Soft-delete a category (sets active=false).
 */
export async function deleteCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, categoryId } = req.params

    // Verify category belongs to this venue and is active
    const existing = await prisma.menuCategory.findFirst({
      where: { id: categoryId, venueId, active: true },
      select: { id: true },
    })

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Categoría no encontrada' })
    }

    const category = await prisma.menuCategory.update({
      where: { id: categoryId },
      data: { active: false },
    })

    return res.json({ success: true, data: { id: category.id } })
  } catch (error) {
    logger.error('Error deleting category (mobile)', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params.venueId,
      categoryId: req.params.categoryId,
    })
    next(error)
  }
}
