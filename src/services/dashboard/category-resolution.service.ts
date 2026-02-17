/**
 * Category Resolution Service
 *
 * Implements MERGE pattern for item categories:
 * - Venue sees its own categories + org-level categories
 * - If venue has a category with the same name as an org-level one, venue wins (override)
 * - Each returned category includes `source: 'venue' | 'organization'`
 */

import prisma from '@/utils/prismaClient'
import { NotFoundError } from '@/errors/AppError'

// ==========================================
// TYPES
// ==========================================

export type CategorySource = 'venue' | 'organization'

export interface MergedCategory {
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
  source: CategorySource
  // Optional stats
  totalItems?: number
  availableItems?: number
  soldItems?: number
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

// ==========================================
// RESOLUTION
// ==========================================

/**
 * Get merged categories for a venue (venue + org, venue overrides on name conflict).
 */
export async function getMergedCategories(venueId: string, options: { includeStats?: boolean } = {}): Promise<MergedCategory[]> {
  const organizationId = await getOrgIdFromVenue(venueId)

  // Fetch both in parallel
  const [venueCategories, orgCategories] = await Promise.all([
    prisma.itemCategory.findMany({
      where: { venueId, active: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.itemCategory.findMany({
      where: { organizationId, venueId: null, active: true },
      orderBy: { sortOrder: 'asc' },
    }),
  ])

  // Build set of venue category names for override detection
  const venueCategoryNames = new Set(venueCategories.map(c => c.name.toLowerCase()))

  // Merge: venue categories first, then org categories not overridden by venue
  const merged: MergedCategory[] = []

  for (const cat of venueCategories) {
    merged.push({
      ...cat,
      suggestedPrice: cat.suggestedPrice ? Number(cat.suggestedPrice) : null,
      source: 'venue',
    })
  }

  for (const cat of orgCategories) {
    // Skip if venue has a category with the same name (venue override)
    if (venueCategoryNames.has(cat.name.toLowerCase())) continue

    merged.push({
      ...cat,
      suggestedPrice: cat.suggestedPrice ? Number(cat.suggestedPrice) : null,
      source: 'organization',
    })
  }

  if (!options.includeStats) {
    return merged.map(c => ({
      ...c,
      totalItems: 0,
      availableItems: 0,
      soldItems: 0,
    }))
  }

  // Get stats for all categories in a single query
  const categoryIds = merged.map(c => c.id)
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

  return merged.map(cat => {
    const stats = statsMap.get(cat.id) || { total: 0, available: 0, sold: 0 }
    return {
      ...cat,
      totalItems: stats.total,
      availableItems: stats.available,
      soldItems: stats.sold,
    }
  })
}
