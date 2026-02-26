/**
 * Organization Item Category Service
 *
 * CRUD operations for org-level item categories.
 * Follows the same pattern as goal-resolution.service.ts for org-level config.
 *
 * Org-level categories are shared across all venues in the organization.
 * Venues can override them by creating a venue-level category with the same name.
 */

import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import { NotFoundError, BadRequestError } from '@/errors/AppError'
import type { CategorySource, MergedCategory } from './category-resolution.service'
import { logAction } from './activity-log.service'

// ==========================================
// TYPES
// ==========================================

export interface CreateOrgCategoryDto {
  name: string
  description?: string
  color?: string
  sortOrder?: number
  requiresPreRegistration?: boolean
  suggestedPrice?: number
  barcodePattern?: string
}

export interface UpdateOrgCategoryDto {
  name?: string
  description?: string
  color?: string
  sortOrder?: number
  requiresPreRegistration?: boolean
  suggestedPrice?: number
  barcodePattern?: string
  active?: boolean
}

// ==========================================
// HELPERS
// ==========================================

async function getOrgIdFromVenue(venueId: string): Promise<string> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { organizationId: true },
  })
  if (!venue) throw new NotFoundError('Venue not found')
  return venue.organizationId
}

function toMergedCategory(cat: any): MergedCategory {
  return {
    id: cat.id,
    name: cat.name,
    description: cat.description,
    color: cat.color,
    sortOrder: cat.sortOrder,
    requiresPreRegistration: cat.requiresPreRegistration,
    suggestedPrice: cat.suggestedPrice ? Number(cat.suggestedPrice) : null,
    barcodePattern: cat.barcodePattern,
    active: cat.active,
    createdAt: cat.createdAt,
    updatedAt: cat.updatedAt,
    source: 'organization' as CategorySource,
    totalItems: 0,
    availableItems: 0,
    soldItems: 0,
  }
}

// ==========================================
// CRUD
// ==========================================

/**
 * Get all org-level categories for the organization that owns this venue
 */
export async function getOrgCategories(venueId: string): Promise<MergedCategory[]> {
  const organizationId = await getOrgIdFromVenue(venueId)

  const categories = await prisma.itemCategory.findMany({
    where: { organizationId, venueId: null },
    orderBy: { sortOrder: 'asc' },
  })

  // Get stats for all org categories
  const categoryIds = categories.map(c => c.id)
  const countsByStatus = await prisma.serializedItem.groupBy({
    by: ['categoryId', 'status'],
    where: { categoryId: { in: categoryIds } },
    _count: true,
  })

  const statsMap = new Map<string, { total: number; available: number; sold: number }>()
  for (const row of countsByStatus) {
    const existing = statsMap.get(row.categoryId) || { total: 0, available: 0, sold: 0 }
    existing.total += row._count
    if (row.status === 'AVAILABLE') existing.available = row._count
    if (row.status === 'SOLD') existing.sold = row._count
    statsMap.set(row.categoryId, existing)
  }

  return categories.map(cat => {
    const stats = statsMap.get(cat.id) || { total: 0, available: 0, sold: 0 }
    return {
      ...toMergedCategory(cat),
      totalItems: stats.total,
      availableItems: stats.available,
      soldItems: stats.sold,
    }
  })
}

/**
 * Create an org-level item category
 */
export async function createOrgCategory(venueId: string, data: CreateOrgCategoryDto): Promise<MergedCategory> {
  const organizationId = await getOrgIdFromVenue(venueId)

  // Check for duplicate name at org level
  const existing = await prisma.itemCategory.findFirst({
    where: { organizationId, venueId: null, name: data.name },
  })

  if (existing) {
    throw new BadRequestError(`Ya existe una categoría "${data.name}" a nivel organización`)
  }

  // Get max sortOrder if not provided
  let sortOrder = data.sortOrder
  if (sortOrder === undefined) {
    const maxSort = await prisma.itemCategory.aggregate({
      where: { organizationId, venueId: null },
      _max: { sortOrder: true },
    })
    sortOrder = (maxSort._max.sortOrder ?? 0) + 1
  }

  const category = await prisma.itemCategory.create({
    data: {
      organizationId,
      venueId: null,
      name: data.name,
      description: data.description,
      color: data.color,
      sortOrder,
      requiresPreRegistration: data.requiresPreRegistration ?? true,
      suggestedPrice: data.suggestedPrice ? new Prisma.Decimal(data.suggestedPrice) : null,
      barcodePattern: data.barcodePattern,
    },
  })

  logAction({
    venueId,
    action: 'ORG_CATEGORY_CREATED',
    entity: 'ItemCategory',
    entityId: category.id,
  })

  return toMergedCategory(category)
}

/**
 * Update an org-level item category
 */
export async function updateOrgCategory(venueId: string, categoryId: string, data: UpdateOrgCategoryDto): Promise<MergedCategory> {
  const organizationId = await getOrgIdFromVenue(venueId)

  // Verify category belongs to this org and is org-level
  const existing = await prisma.itemCategory.findFirst({
    where: { id: categoryId, organizationId, venueId: null },
  })

  if (!existing) {
    throw new NotFoundError('Categoría de organización no encontrada')
  }

  // Check for duplicate name if changing name
  if (data.name && data.name !== existing.name) {
    const duplicate = await prisma.itemCategory.findFirst({
      where: {
        organizationId,
        venueId: null,
        name: data.name,
        id: { not: categoryId },
      },
    })
    if (duplicate) {
      throw new BadRequestError(`Ya existe una categoría "${data.name}" a nivel organización`)
    }
  }

  const category = await prisma.itemCategory.update({
    where: { id: categoryId },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.color !== undefined && { color: data.color }),
      ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
      ...(data.requiresPreRegistration !== undefined && { requiresPreRegistration: data.requiresPreRegistration }),
      ...(data.suggestedPrice !== undefined && {
        suggestedPrice: data.suggestedPrice ? new Prisma.Decimal(data.suggestedPrice) : null,
      }),
      ...(data.barcodePattern !== undefined && { barcodePattern: data.barcodePattern }),
      ...(data.active !== undefined && { active: data.active }),
    },
  })

  logAction({
    venueId,
    action: 'ORG_CATEGORY_UPDATED',
    entity: 'ItemCategory',
    entityId: categoryId,
  })

  return toMergedCategory(category)
}

/**
 * Delete an org-level item category
 * Soft delete if it has items, hard delete if empty
 */
export async function deleteOrgCategory(venueId: string, categoryId: string): Promise<{ deleted: boolean; message: string }> {
  const organizationId = await getOrgIdFromVenue(venueId)

  const existing = await prisma.itemCategory.findFirst({
    where: { id: categoryId, organizationId, venueId: null },
  })

  if (!existing) {
    throw new NotFoundError('Categoría de organización no encontrada')
  }

  // Check if category has items
  const itemCount = await prisma.serializedItem.count({
    where: { categoryId },
  })

  if (itemCount > 0) {
    // Soft delete
    await prisma.itemCategory.update({
      where: { id: categoryId },
      data: { active: false },
    })

    logAction({
      venueId,
      action: 'ORG_CATEGORY_DELETED',
      entity: 'ItemCategory',
      entityId: categoryId,
    })

    return {
      deleted: true,
      message: `Categoría desactivada. ${itemCount} items preservados.`,
    }
  }

  // Hard delete if no items
  await prisma.itemCategory.delete({
    where: { id: categoryId },
  })

  logAction({
    venueId,
    action: 'ORG_CATEGORY_DELETED',
    entity: 'ItemCategory',
    entityId: categoryId,
  })

  return {
    deleted: true,
    message: 'Categoría eliminada permanentemente.',
  }
}
