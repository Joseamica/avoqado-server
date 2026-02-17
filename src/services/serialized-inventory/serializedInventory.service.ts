import { PrismaClient, SerializedItem, SerializedItemStatus, ItemCategory, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { moduleService, MODULE_CODES } from '../modules/module.service'
import { getMergedCategories } from '../dashboard/category-resolution.service'

// ==========================================
// SCAN RESULT TYPES
// ==========================================
export type ScanStatus = 'available' | 'already_sold' | 'not_registered' | 'module_disabled'

export interface ScanResult {
  found: boolean
  item: (SerializedItem & { category: ItemCategory }) | null
  category: ItemCategory | null
  status: ScanStatus
  suggestedPrice: number | null
}

export interface RegisterBatchResult {
  created: number
  duplicates: string[]
}

// ==========================================
// ORDER ITEM DATA
// Data to create an OrderItem for a SerializedItem.
// CRITICAL: productName and productSku must be filled manually.
// ==========================================
export interface OrderItemData {
  productName: string // From ItemCategory.name
  productSku: string // From SerializedItem.serialNumber
  unitPrice: Prisma.Decimal
  quantity: number // Always 1 for serialized items
  total: Prisma.Decimal // Changed from subtotal to match Prisma schema
  taxAmount: Prisma.Decimal // Required by OrderItem schema
  productId: null // SerializedItems don't have a Product
}

// ==========================================
// SERIALIZED INVENTORY SERVICE
// Manages items with unique barcodes (SIMs, jewelry, electronics).
// IMPORTANT: SerializedItem does NOT have price - price is captured at sale.
// ==========================================
export class SerializedInventoryService {
  constructor(private db: PrismaClient = prisma) {}

  /**
   * Scans a barcode and returns item information.
   *
   * @returns ScanResult with status:
   * - 'available': Item exists and is available for sale
   * - 'already_sold': Item exists but was already sold
   * - 'not_registered': Item doesn't exist in system
   * - 'module_disabled': Module is not enabled for this venue
   */
  async scan(venueId: string, serialNumber: string): Promise<ScanResult> {
    // Verify module is enabled
    const isEnabled = await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)

    if (!isEnabled) {
      return {
        found: false,
        item: null,
        category: null,
        status: 'module_disabled',
        suggestedPrice: null,
      }
    }

    // 1. Search for existing item at venue level
    const item = await this.db.serializedItem.findUnique({
      where: { venueId_serialNumber: { venueId, serialNumber } },
      include: { category: true },
    })

    if (item) {
      if (item.status === 'SOLD') {
        return {
          found: true,
          item,
          category: item.category,
          status: 'already_sold',
          suggestedPrice: null,
        }
      }

      return {
        found: true,
        item,
        category: item.category,
        status: 'available',
        suggestedPrice: item.category.suggestedPrice ? Number(item.category.suggestedPrice) : null,
      }
    }

    // 2. Fallback: search for org-level item
    const orgItem = await this.findOrgItem(venueId, serialNumber)

    if (orgItem) {
      if (orgItem.status === 'SOLD') {
        return {
          found: true,
          item: orgItem,
          category: orgItem.category,
          status: 'already_sold',
          suggestedPrice: null,
        }
      }

      return {
        found: true,
        item: orgItem,
        category: orgItem.category,
        status: 'available',
        suggestedPrice: orgItem.category.suggestedPrice ? Number(orgItem.category.suggestedPrice) : null,
      }
    }

    // 3. Item not found - try to categorize by pattern (venue + org categories)
    const matchedCategory = await this.findCategoryByPattern(venueId, serialNumber)

    return {
      found: false,
      item: null,
      category: matchedCategory,
      status: 'not_registered',
      suggestedPrice: matchedCategory?.suggestedPrice ? Number(matchedCategory.suggestedPrice) : null,
    }
  }

  /**
   * Registers a new item (inventory registration).
   */
  async register(data: {
    venueId: string
    categoryId: string
    serialNumber: string
    createdBy: string
  }): Promise<SerializedItem & { category: ItemCategory }> {
    return this.db.serializedItem.create({
      data: {
        venueId: data.venueId,
        categoryId: data.categoryId,
        serialNumber: data.serialNumber,
        createdBy: data.createdBy,
        status: 'AVAILABLE',
      },
      include: { category: true },
    })
  }

  /**
   * Registers multiple items in batch (bulk registration).
   *
   * @returns Object with count of created items and list of duplicate serial numbers
   */
  async registerBatch(data: {
    venueId: string
    categoryId: string
    serialNumbers: string[]
    createdBy: string
  }): Promise<RegisterBatchResult> {
    const duplicates: string[] = []
    let created = 0

    await this.db.$transaction(async tx => {
      for (const serialNumber of data.serialNumbers) {
        const existing = await tx.serializedItem.findUnique({
          where: { venueId_serialNumber: { venueId: data.venueId, serialNumber } },
        })

        if (existing) {
          duplicates.push(serialNumber)
          continue
        }

        await tx.serializedItem.create({
          data: {
            venueId: data.venueId,
            categoryId: data.categoryId,
            serialNumber,
            createdBy: data.createdBy,
            status: 'AVAILABLE',
          },
        })
        created++
      }
    })

    return { created, duplicates }
  }

  /**
   * Marks an item as sold (called from OrderService).
   * PRICE is passed to OrderItem.unitPrice, NOT stored in SerializedItem.
   * @param tx - Optional transaction client (required when called inside a transaction)
   */
  async markAsSold(venueId: string, serialNumber: string, orderItemId: string, tx?: Prisma.TransactionClient): Promise<SerializedItem> {
    const client = tx || this.db

    // 1. Try venue-level item first
    const venueItem = await client.serializedItem.findUnique({
      where: { venueId_serialNumber: { venueId, serialNumber } },
    })

    if (venueItem) {
      return client.serializedItem.update({
        where: { id: venueItem.id },
        data: {
          status: 'SOLD',
          soldAt: new Date(),
          orderItemId,
        },
      })
    }

    // 2. Fallback: find org-level item
    const orgItem = await this.findOrgItem(venueId, serialNumber, client)

    if (orgItem) {
      return client.serializedItem.update({
        where: { id: orgItem.id },
        data: {
          status: 'SOLD',
          soldAt: new Date(),
          orderItemId,
          sellingVenueId: venueId,
        },
      })
    }

    // If neither found, the original update will throw a not-found error (preserves legacy behavior)
    return client.serializedItem.update({
      where: { venueId_serialNumber: { venueId, serialNumber } },
      data: {
        status: 'SOLD',
        soldAt: new Date(),
        orderItemId,
      },
    })
  }

  /**
   * Registers and sells in a single transaction (for unregistered items).
   */
  async registerAndSell(data: {
    venueId: string
    categoryId: string
    serialNumber: string
    orderItemId: string
    createdBy: string
  }): Promise<SerializedItem> {
    return this.db.serializedItem.create({
      data: {
        venueId: data.venueId,
        categoryId: data.categoryId,
        serialNumber: data.serialNumber,
        createdBy: data.createdBy,
        status: 'SOLD',
        soldAt: new Date(),
        orderItemId: data.orderItemId,
      },
    })
  }

  /**
   * Creates OrderItem data for a SerializedItem.
   * CRITICAL: Fills productName and productSku manually for receipts.
   *
   * @param serializedItem - Item with category included
   * @param price - Price entered by cashier
   * @returns Data ready to create OrderItem
   */
  buildOrderItemData(serializedItem: SerializedItem & { category: ItemCategory }, price: number): OrderItemData {
    return {
      // Snapshot fields - CRITICAL for receipts
      productName: serializedItem.category.name, // "Chip Telcel Negra"
      productSku: serializedItem.serialNumber, // "8952140012345678"
      unitPrice: new Prisma.Decimal(price),
      quantity: 1, // Always 1 for serialized items
      total: new Prisma.Decimal(price), // Fixed: was "subtotal" but OrderItem schema uses "total"
      taxAmount: new Prisma.Decimal(0), // No tax for serialized items
      // No productId - it's SerializedItem, not Product
      productId: null,
    }
  }

  /**
   * Gets available stock by category (merged: venue + org-level).
   */
  async getStockByCategory(venueId: string): Promise<Array<{ category: ItemCategory; available: number; sold: number }>> {
    // Get venue's org ID for merged lookup
    const venue = await this.db.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    })

    const categories = await this.db.itemCategory.findMany({
      where: {
        active: true,
        OR: [{ venueId }, ...(venue ? [{ organizationId: venue.organizationId, venueId: null }] : [])],
      },
      orderBy: { sortOrder: 'asc' },
    })

    // Deduplicate: venue category overrides org category with same name
    const seen = new Map<string, (typeof categories)[0]>()
    for (const cat of categories) {
      const key = cat.name.toLowerCase()
      const existing = seen.get(key)
      // If venue-scoped, it always wins; org-level only added if no venue override
      if (!existing || cat.venueId) {
        seen.set(key, cat)
      }
    }
    const mergedCategories = Array.from(seen.values())

    // Single groupBy for all categories (avoids 2N queries)
    const categoryIds = mergedCategories.map(c => c.id)
    const countsByStatus = await this.db.serializedItem.groupBy({
      by: ['categoryId', 'status'],
      where: { categoryId: { in: categoryIds }, status: { in: ['AVAILABLE', 'SOLD'] } },
      _count: true,
    })

    const statsMap = new Map<string, { available: number; sold: number }>()
    for (const row of countsByStatus) {
      const existing = statsMap.get(row.categoryId) || { available: 0, sold: 0 }
      if (row.status === 'AVAILABLE') existing.available = row._count
      if (row.status === 'SOLD') existing.sold = row._count
      statsMap.set(row.categoryId, existing)
    }

    return mergedCategories.map(category => {
      const stats = statsMap.get(category.id) || { available: 0, sold: 0 }
      return { category, available: stats.available, sold: stats.sold }
    })
  }

  /**
   * Gets all categories for a venue (merged: venue + org-level).
   */
  async getCategories(venueId: string): Promise<ItemCategory[]> {
    // Use merged categories (venue + org) for backward compatibility
    const merged = await getMergedCategories(venueId)
    // Return as ItemCategory-compatible objects (strip extra fields)
    return merged.map(c => ({
      id: c.id,
      venueId: null, // org-level categories have null venueId
      organizationId: null,
      name: c.name,
      description: c.description,
      color: c.color,
      sortOrder: c.sortOrder,
      requiresPreRegistration: c.requiresPreRegistration,
      suggestedPrice: c.suggestedPrice !== null ? new Prisma.Decimal(c.suggestedPrice) : null,
      barcodePattern: c.barcodePattern,
      active: c.active,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })) as ItemCategory[]
  }

  /**
   * Gets a single category by ID.
   */
  async getCategoryById(categoryId: string): Promise<ItemCategory | null> {
    return this.db.itemCategory.findUnique({
      where: { id: categoryId },
    })
  }

  /**
   * Creates a new category.
   */
  async createCategory(data: {
    venueId: string
    name: string
    description?: string
    color?: string
    sortOrder?: number
    requiresPreRegistration?: boolean
    suggestedPrice?: number
    barcodePattern?: string
  }): Promise<ItemCategory> {
    return this.db.itemCategory.create({
      data: {
        venueId: data.venueId,
        name: data.name,
        description: data.description,
        color: data.color,
        sortOrder: data.sortOrder ?? 0,
        requiresPreRegistration: data.requiresPreRegistration ?? true,
        suggestedPrice: data.suggestedPrice ? new Prisma.Decimal(data.suggestedPrice) : null,
        barcodePattern: data.barcodePattern,
      },
    })
  }

  /**
   * Updates a category.
   */
  async updateCategory(
    categoryId: string,
    data: Partial<{
      name: string
      description: string
      color: string
      sortOrder: number
      requiresPreRegistration: boolean
      suggestedPrice: number | null
      barcodePattern: string | null
      active: boolean
    }>,
  ): Promise<ItemCategory> {
    return this.db.itemCategory.update({
      where: { id: categoryId },
      data: {
        ...data,
        suggestedPrice:
          data.suggestedPrice !== undefined ? (data.suggestedPrice !== null ? new Prisma.Decimal(data.suggestedPrice) : null) : undefined,
      },
    })
  }

  /**
   * Gets item by serial number.
   */
  async getItemBySerialNumber(venueId: string, serialNumber: string): Promise<(SerializedItem & { category: ItemCategory }) | null> {
    return this.db.serializedItem.findUnique({
      where: { venueId_serialNumber: { venueId, serialNumber } },
      include: { category: true },
    })
  }

  /**
   * Lists items with pagination and filters.
   */
  async listItems(options: {
    venueId: string
    categoryId?: string
    status?: SerializedItemStatus
    skip?: number
    take?: number
  }): Promise<{ items: (SerializedItem & { category: ItemCategory })[]; total: number }> {
    const where: Prisma.SerializedItemWhereInput = {
      venueId: options.venueId,
      ...(options.categoryId && { categoryId: options.categoryId }),
      ...(options.status && { status: options.status }),
    }

    const [items, total] = await Promise.all([
      this.db.serializedItem.findMany({
        where,
        include: { category: true },
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
      }),
      this.db.serializedItem.count({ where }),
    ])

    return { items, total }
  }

  /**
   * Marks an item as returned (reverses sale).
   */
  async markAsReturned(venueId: string, serialNumber: string): Promise<SerializedItem> {
    return this.db.serializedItem.update({
      where: { venueId_serialNumber: { venueId, serialNumber } },
      data: {
        status: 'RETURNED',
        orderItemId: null,
      },
    })
  }

  /**
   * Marks an item as damaged.
   */
  async markAsDamaged(venueId: string, serialNumber: string): Promise<SerializedItem> {
    return this.db.serializedItem.update({
      where: { venueId_serialNumber: { venueId, serialNumber } },
      data: {
        status: 'DAMAGED',
      },
    })
  }

  /**
   * Registers multiple items at org level (shared across all venues in the org).
   */
  async registerBatchOrg(data: {
    organizationId: string
    categoryId: string
    serialNumbers: string[]
    createdBy: string
  }): Promise<RegisterBatchResult> {
    const duplicates: string[] = []
    let created = 0

    await this.db.$transaction(async tx => {
      for (const serialNumber of data.serialNumbers) {
        // Check org-level duplicates
        const existingOrg = await tx.serializedItem.findFirst({
          where: { organizationId: data.organizationId, serialNumber },
        })

        if (existingOrg) {
          duplicates.push(serialNumber)
          continue
        }

        // Also check legacy venue-level items in same org
        const existingVenue = await tx.serializedItem.findFirst({
          where: {
            serialNumber,
            venue: { organizationId: data.organizationId },
          },
        })

        if (existingVenue) {
          duplicates.push(serialNumber)
          continue
        }

        await tx.serializedItem.create({
          data: {
            organizationId: data.organizationId,
            venueId: null,
            categoryId: data.categoryId,
            serialNumber,
            createdBy: data.createdBy,
            status: 'AVAILABLE',
          },
        })
        created++
      }
    })

    return { created, duplicates }
  }

  /**
   * Finds an org-level item by serial number for a venue's organization.
   */
  private async findOrgItem(
    venueId: string,
    serialNumber: string,
    client?: Prisma.TransactionClient,
  ): Promise<(SerializedItem & { category: ItemCategory }) | null> {
    const db = client || this.db
    const venue = await db.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    })
    if (!venue) return null

    return db.serializedItem.findFirst({
      where: {
        organizationId: venue.organizationId,
        venueId: null,
        serialNumber,
      },
      include: { category: true },
    })
  }

  /**
   * Finds category by barcode pattern match (searches venue + org categories).
   */
  private async findCategoryByPattern(venueId: string, serialNumber: string): Promise<ItemCategory | null> {
    // Get venue's org ID for org-level category search
    const venue = await this.db.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    })

    const categories = await this.db.itemCategory.findMany({
      where: {
        active: true,
        barcodePattern: { not: null },
        OR: [{ venueId }, ...(venue ? [{ organizationId: venue.organizationId, venueId: null }] : [])],
      },
    })

    for (const category of categories) {
      if (category.barcodePattern) {
        try {
          const regex = new RegExp(category.barcodePattern)
          if (regex.test(serialNumber)) {
            return category
          }
        } catch {
          // Invalid regex pattern for category - skip silently
        }
      }
    }

    return null
  }
}

// Export singleton instance
export const serializedInventoryService = new SerializedInventoryService()
