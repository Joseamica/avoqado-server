/**
 * Category Mobile Controller
 *
 * CRUD endpoints for iOS/Android category management.
 * Response format: { success: true, data: <payload> }
 */

import { NextFunction, Request, Response } from 'express'
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { MENSAJE_PADRE_FUERA_DEL_NEGOCIO, padreEsDelNegocio } from '../../services/menus/padreDeCategoria'

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

    // na7522fd: el padre tiene que ser de ESTE negocio (antes se guardaba cualquier id).
    if (parentId && !(await padreEsDelNegocio(venueId, parentId))) {
      return res.status(400).json({ success: false, message: MENSAJE_PADRE_FUERA_DEL_NEGOCIO })
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

/** Lo que la app puede editar de una categoría (las apps de hoy mandan nombre, descripción y color). */
const CAMPOS_EDITABLES = ['name', 'description', 'color', 'icon', 'imageUrl', 'displayOrder', 'active', 'parentId'] as const

/**
 * Update an existing category.
 */
export async function updateCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, categoryId } = req.params
    // na7522fd (Codex r1 #7): sólo los campos que la app puede editar. Antes el cuerpo entero iba a Prisma: con `venueId` o
    // una relación anidada (`parent: { connect }`) se movía la categoría a otro negocio o se colgaba de una ajena.
    const data: Record<string, unknown> = {}
    for (const campo of CAMPOS_EDITABLES) {
      if (campo in (req.body ?? {})) data[campo] = req.body[campo]
    }
    if ('parentId' in data && data.parentId !== null && (typeof data.parentId !== 'string' || !data.parentId)) {
      return res.status(400).json({ success: false, message: MENSAJE_PADRE_FUERA_DEL_NEGOCIO })
    }

    // Verify category belongs to this venue
    const existing = await prisma.menuCategory.findFirst({
      where: { id: categoryId, venueId },
      select: { id: true },
    })

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Categoría no encontrada' })
    }

    // na7522fd: colgarla de otra categoría, sólo de una de ESTE negocio.
    if (typeof data.parentId === 'string' && data.parentId && !(await padreEsDelNegocio(venueId, data.parentId))) {
      return res.status(400).json({ success: false, message: MENSAJE_PADRE_FUERA_DEL_NEGOCIO })
    }

    // If name changed, regenerate slug
    if (typeof data.name === 'string' && data.name) {
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
      // Sólo CAMPOS_EDITABLES (escalares de la categoría): la forma sin relaciones anidadas.
      data: data as Prisma.MenuCategoryUncheckedUpdateInput,
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
