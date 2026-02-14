/**
 * Item Category Service
 *
 * Business logic for managing serialized inventory categories.
 * Used by PlayTelecom (SIMs), jewelry stores, electronics, etc.
 *
 * Categories define:
 * - Name and description (e.g., "Chip Negra", "Chip Blanca")
 * - Suggested price for POS
 * - Barcode patterns for auto-categorization
 * - Stock alert configurations
 */

import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import AppError from '@/errors/AppError'

// ===========================================
// TYPES
// ===========================================

export interface CreateItemCategoryDto {
  name: string
  description?: string
  color?: string
  sortOrder?: number
  requiresPreRegistration?: boolean
  suggestedPrice?: number
  barcodePattern?: string
}

export interface UpdateItemCategoryDto {
  name?: string
  description?: string
  color?: string
  sortOrder?: number
  requiresPreRegistration?: boolean
  suggestedPrice?: number
  barcodePattern?: string
  active?: boolean
}

export interface BulkUploadDto {
  csvContent?: string
  serialNumbers?: string[]
  registeredBy: string
}

export interface BulkUploadResult {
  success: boolean
  created: number
  duplicates: string[]
  errors: string[]
  total: number
}

export interface CategoryWithStats {
  id: string
  name: string
  description: string | null
  color: string | null
  sortOrder: number
  requiresPreRegistration: boolean
  suggestedPrice: number | null
  barcodePattern: string | null
  active: boolean
  createdAt: Date
  updatedAt: Date
  // Stats
  totalItems: number
  availableItems: number
  soldItems: number
}

// ===========================================
// SERVICE FUNCTIONS
// ===========================================

/**
 * Get all item categories for a venue
 */
export async function getItemCategories(
  venueId: string,
  options: { includeStats?: boolean } = {},
): Promise<{ categories: CategoryWithStats[] }> {
  const categories = await prisma.itemCategory.findMany({
    where: {
      venueId,
      active: true,
    },
    orderBy: { sortOrder: 'asc' },
  })

  if (!options.includeStats) {
    return {
      categories: categories.map(cat => ({
        ...cat,
        suggestedPrice: cat.suggestedPrice ? Number(cat.suggestedPrice) : null,
        totalItems: 0,
        availableItems: 0,
        soldItems: 0,
      })),
    }
  }

  // Single groupBy for all categories (avoids 3N queries)
  const categoryIds = categories.map(c => c.id)
  const countsByStatus = await prisma.serializedItem.groupBy({
    by: ['categoryId', 'status'],
    where: { categoryId: { in: categoryIds } },
    _count: true,
  })

  // Build lookup: categoryId → { total, available, sold }
  const statsMap = new Map<string, { total: number; available: number; sold: number }>()
  for (const row of countsByStatus) {
    const existing = statsMap.get(row.categoryId) || { total: 0, available: 0, sold: 0 }
    existing.total += row._count
    if (row.status === 'AVAILABLE') existing.available = row._count
    if (row.status === 'SOLD') existing.sold = row._count
    statsMap.set(row.categoryId, existing)
  }

  const categoriesWithStats = categories.map(category => {
    const stats = statsMap.get(category.id) || { total: 0, available: 0, sold: 0 }
    return {
      ...category,
      suggestedPrice: category.suggestedPrice ? Number(category.suggestedPrice) : null,
      totalItems: stats.total,
      availableItems: stats.available,
      soldItems: stats.sold,
    }
  })

  return { categories: categoriesWithStats }
}

/**
 * Get a single item category by ID
 */
export async function getItemCategoryById(venueId: string, categoryId: string): Promise<CategoryWithStats> {
  const category = await prisma.itemCategory.findFirst({
    where: {
      id: categoryId,
      venueId,
    },
  })

  if (!category) {
    throw new AppError('Category not found', 404)
  }

  const [totalItems, availableItems, soldItems] = await Promise.all([
    prisma.serializedItem.count({
      where: { categoryId: category.id },
    }),
    prisma.serializedItem.count({
      where: { categoryId: category.id, status: 'AVAILABLE' },
    }),
    prisma.serializedItem.count({
      where: { categoryId: category.id, status: 'SOLD' },
    }),
  ])

  return {
    ...category,
    suggestedPrice: category.suggestedPrice ? Number(category.suggestedPrice) : null,
    totalItems,
    availableItems,
    soldItems,
  }
}

/**
 * Create a new item category
 */
export async function createItemCategory(venueId: string, data: CreateItemCategoryDto): Promise<CategoryWithStats> {
  // Check for duplicate name
  const existing = await prisma.itemCategory.findFirst({
    where: {
      venueId,
      name: data.name,
    },
  })

  if (existing) {
    throw new AppError(`Category "${data.name}" already exists`, 400)
  }

  // Get max sortOrder if not provided
  let sortOrder = data.sortOrder
  if (sortOrder === undefined) {
    const maxSort = await prisma.itemCategory.aggregate({
      where: { venueId },
      _max: { sortOrder: true },
    })
    sortOrder = (maxSort._max.sortOrder ?? 0) + 1
  }

  const category = await prisma.itemCategory.create({
    data: {
      venueId,
      name: data.name,
      description: data.description,
      color: data.color,
      sortOrder,
      requiresPreRegistration: data.requiresPreRegistration ?? true,
      suggestedPrice: data.suggestedPrice ? new Prisma.Decimal(data.suggestedPrice) : null,
      barcodePattern: data.barcodePattern,
    },
  })

  return {
    ...category,
    suggestedPrice: category.suggestedPrice ? Number(category.suggestedPrice) : null,
    totalItems: 0,
    availableItems: 0,
    soldItems: 0,
  }
}

/**
 * Update an item category
 */
export async function updateItemCategory(venueId: string, categoryId: string, data: UpdateItemCategoryDto): Promise<CategoryWithStats> {
  // Verify category exists and belongs to venue
  const existing = await prisma.itemCategory.findFirst({
    where: {
      id: categoryId,
      venueId,
    },
  })

  if (!existing) {
    throw new AppError('Category not found', 404)
  }

  // Check for duplicate name if name is being changed
  if (data.name && data.name !== existing.name) {
    const duplicate = await prisma.itemCategory.findFirst({
      where: {
        venueId,
        name: data.name,
        id: { not: categoryId },
      },
    })

    if (duplicate) {
      throw new AppError(`Category "${data.name}" already exists`, 400)
    }
  }

  const category = await prisma.itemCategory.update({
    where: { id: categoryId },
    data: {
      name: data.name,
      description: data.description,
      color: data.color,
      sortOrder: data.sortOrder,
      requiresPreRegistration: data.requiresPreRegistration,
      suggestedPrice:
        data.suggestedPrice !== undefined ? (data.suggestedPrice ? new Prisma.Decimal(data.suggestedPrice) : null) : undefined,
      barcodePattern: data.barcodePattern,
      active: data.active,
    },
  })

  // Get updated stats
  const [totalItems, availableItems, soldItems] = await Promise.all([
    prisma.serializedItem.count({ where: { categoryId } }),
    prisma.serializedItem.count({ where: { categoryId, status: 'AVAILABLE' } }),
    prisma.serializedItem.count({ where: { categoryId, status: 'SOLD' } }),
  ])

  return {
    ...category,
    suggestedPrice: category.suggestedPrice ? Number(category.suggestedPrice) : null,
    totalItems,
    availableItems,
    soldItems,
  }
}

/**
 * Delete an item category (soft delete)
 */
export async function deleteItemCategory(venueId: string, categoryId: string): Promise<{ deleted: boolean; message: string }> {
  // Verify category exists and belongs to venue
  const existing = await prisma.itemCategory.findFirst({
    where: {
      id: categoryId,
      venueId,
    },
  })

  if (!existing) {
    throw new AppError('Category not found', 404)
  }

  // Check if category has items
  const itemCount = await prisma.serializedItem.count({
    where: { categoryId },
  })

  if (itemCount > 0) {
    // Soft delete - just mark as inactive
    await prisma.itemCategory.update({
      where: { id: categoryId },
      data: { active: false },
    })

    return {
      deleted: true,
      message: `Category deactivated. ${itemCount} items preserved.`,
    }
  }

  // Hard delete if no items
  await prisma.itemCategory.delete({
    where: { id: categoryId },
  })

  return {
    deleted: true,
    message: 'Category deleted permanently.',
  }
}

/**
 * Bulk upload serialized items to a category
 */
export async function bulkUploadItems(venueId: string, categoryId: string, data: BulkUploadDto): Promise<BulkUploadResult> {
  // Verify category exists and belongs to venue
  const category = await prisma.itemCategory.findFirst({
    where: {
      id: categoryId,
      venueId,
    },
  })

  if (!category) {
    throw new AppError('Category not found', 404)
  }

  // Parse serial numbers from CSV or array
  let serialNumbers: string[] = []

  if (data.csvContent) {
    // Parse CSV - expect one serial number per line or comma-separated
    serialNumbers = data.csvContent
      .split(/[\n,]/)
      .map(s => s.trim())
      .filter(s => s.length > 0)
  } else if (data.serialNumbers) {
    serialNumbers = data.serialNumbers.map(s => s.trim()).filter(s => s.length > 0)
  }

  if (serialNumbers.length === 0) {
    throw new AppError('No serial numbers provided', 400)
  }

  // Check for duplicates within the venue (not just category)
  const existingItems = await prisma.serializedItem.findMany({
    where: {
      category: { venueId },
      serialNumber: { in: serialNumbers },
    },
    select: { serialNumber: true },
  })

  const existingSerials = new Set(existingItems.map(i => i.serialNumber))
  const newSerials = serialNumbers.filter(s => !existingSerials.has(s))
  const duplicates = serialNumbers.filter(s => existingSerials.has(s))

  // Create new items
  const errors: string[] = []
  let created = 0

  if (newSerials.length > 0) {
    try {
      const result = await prisma.serializedItem.createMany({
        data: newSerials.map(serialNumber => ({
          venueId,
          categoryId,
          serialNumber,
          status: 'AVAILABLE' as const,
          createdBy: data.registeredBy,
        })),
        skipDuplicates: true,
      })
      created = result.count
    } catch (error: any) {
      errors.push(`Database error: ${error.message}`)
    }
  }

  return {
    success: errors.length === 0,
    created,
    duplicates,
    errors,
    total: serialNumbers.length,
  }
}

/**
 * Get items in a category with pagination
 */
export async function getCategoryItems(
  venueId: string,
  categoryId: string,
  options: {
    status?: string
    page?: number
    pageSize?: number
    search?: string
  } = {},
) {
  // Verify category belongs to venue
  const category = await prisma.itemCategory.findFirst({
    where: {
      id: categoryId,
      venueId,
    },
  })

  if (!category) {
    throw new AppError('Category not found', 404)
  }

  const page = options.page || 1
  const pageSize = options.pageSize || 50
  const skip = (page - 1) * pageSize

  const where: Prisma.SerializedItemWhereInput = {
    categoryId,
    ...(options.status && { status: options.status as any }),
    ...(options.search && {
      serialNumber: { contains: options.search, mode: 'insensitive' },
    }),
  }

  const [items, total] = await Promise.all([
    prisma.serializedItem.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
      select: {
        id: true,
        serialNumber: true,
        status: true,
        createdAt: true,
        soldAt: true,
        createdBy: true,
      },
    }),
    prisma.serializedItem.count({ where }),
  ])

  return {
    items,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}
