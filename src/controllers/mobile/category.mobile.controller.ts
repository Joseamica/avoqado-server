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
import { deleteMenuCategory } from '../../services/dashboard/menu.dashboard.service'

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
      where: { venueId, active: true, deletedAt: null },
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
      select: { id: true, deletedAt: true, name: true },
    })
    // Una ELIMINADA con ese nombre se reusa, como en el panel (encargo bc1dcc): nunca dos «EVENTO» que el dueño no distingue. Si
    // en medio volvió a mostrarse, se crea otra como siempre.
    if (existing?.deletedAt && existing.name.trim().toLowerCase() === name.trim().toLowerCase()) {
      const reusada = await prisma.menuCategory.updateMany({
        where: { id: existing.id, venueId, deletedAt: { not: null } },
        // PRENDERLA, como en el panel (Codex r6-r8): de la app sólo la apariencia que trae con valor; lo demás (clave SAT, impresora,
        // horario, padre, orden) se queda como estaba.
        data: {
          ...(description && { description }),
          ...(color && { color }),
          ...(icon && { icon }),
          ...(imageUrl && { imageUrl }),
          active: true,
          deletedAt: null,
          isDemo: false,
        },
      })
      if (reusada.count === 1) {
        const category = await prisma.menuCategory.findUniqueOrThrow({ where: { id: existing.id } })
        return res.status(201).json({ success: true, data: category })
      }
    }
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

    // Verify category belongs to this venue (una eliminada no se edita ni se vuelve a prender por aquí)
    const existing = await prisma.menuCategory.findFirst({
      where: { id: categoryId, venueId, deletedAt: null },
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

    // `deletedAt: null` en la ESCRITURA (Codex r1 #12): si la eliminaron entre la lectura y aquí, 404 y no se vuelve a prender.
    const category = await prisma.menuCategory
      .update({
        where: { id: categoryId, venueId, deletedAt: null },
        // Sólo CAMPOS_EDITABLES (escalares de la categoría): la forma sin relaciones anidadas.
        data: data as Prisma.MenuCategoryUncheckedUpdateInput,
      })
      .catch(e => {
        if ((e as { code?: string })?.code === 'P2025') return null
        throw e
      })
    if (!category) {
      return res.status(404).json({ success: false, message: 'Categoría no encontrada' })
    }

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
 * Eliminar una categoría desde la app (ANDROID «Artículos → Categorías», iOS).
 * - Sin productos ni subcategorías vivas: la MISMA regla que el panel (`deleteMenuCategory`, encargo bc1dcc): vacía se borra; con
 *   archivados queda eliminada y deja de verse en el panel, la app y el MCP. Antes sólo se apagaba y el dueño la seguía viendo.
 * - Con productos o subcategorías vivas: como siempre, sólo se apaga (200). El panel rechaza ese caso con su porqué, pero las apps
 *   publicadas no leen el porqué y enseñarían «Error al eliminar» (Codex r1 #14): su contrato no cambia.
 */
export async function deleteCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, categoryId } = req.params

    const existing = await prisma.menuCategory.findFirst({
      where: { id: categoryId, venueId, deletedAt: null },
      select: { id: true },
    })
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Categoría no encontrada' })
    }

    const [productosVivos, hijasVivas] = await Promise.all([
      prisma.product.count({ where: { categoryId, deletedAt: null } }),
      prisma.menuCategory.count({ where: { parentId: categoryId, deletedAt: null } }),
    ])
    if (productosVivos > 0 || hijasVivas > 0) {
      // Comportamiento de siempre: sólo una activa se apaga; una ya apagada da 404 como antes.
      const apagada = await prisma.menuCategory.updateMany({
        where: { id: categoryId, venueId, active: true, deletedAt: null },
        data: { active: false },
      })
      if (apagada.count === 0) return res.status(404).json({ success: false, message: 'Categoría no encontrada' })
      return res.json({ success: true, data: { id: categoryId } })
    }

    // Si en medio le entró un producto o una subcategoría, el servicio la rechaza; aquí se apaga como siempre (la app no lee el
    // porqué y enseñaría «Error al eliminar»).
    const category = await deleteMenuCategory(venueId, categoryId).catch(async e => {
      const code = (e as { code?: string })?.code
      if (code !== 'CATEGORY_HAS_PRODUCTS' && code !== 'CATEGORY_HAS_SUBCATEGORIES') throw e
      const apagada = await prisma.menuCategory.updateMany({
        where: { id: categoryId, venueId, active: true, deletedAt: null },
        data: { active: false },
      })
      return apagada.count > 0 ? { id: categoryId } : null
    })
    if (!category) return res.status(404).json({ success: false, message: 'Categoría no encontrada' })
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
