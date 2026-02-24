import { Product, Prisma, ProductType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import AppError from '../../errors/AppError'
import { deleteFileFromStorage } from '../storage.service'
import logger from '../../config/logger'
import socketManager from '../../communication/sockets'

export interface CreateProductDto {
  name: string
  description?: string
  price: number
  type: ProductType
  imageUrl?: string
  sku: string
  gtin?: string
  categoryId: string
  modifierGroupIds?: string[]

  // ═══════════════════════════════════════════════════════════════
  // Square-aligned contextual fields
  // ═══════════════════════════════════════════════════════════════
  isAlcoholic?: boolean // Only for FOOD_AND_BEV
  kitchenName?: string // Short name for kitchen display (max 50)
  abbreviation?: string // Ultra-short text for POS (max 24)
  duration?: number // Minutes (for SERVICE, APPOINTMENTS_SERVICE)

  // Event fields
  eventDate?: string | Date
  eventTime?: string
  eventEndTime?: string
  eventCapacity?: number
  eventLocation?: string

  // Digital fields
  downloadUrl?: string
  downloadLimit?: number
  fileSize?: string

  // Donation fields
  suggestedAmounts?: number[]
  allowCustomAmount?: boolean
  donationCause?: string
}

export interface UpdateProductDto {
  name?: string
  description?: string
  price?: number
  type?: ProductType
  imageUrl?: string | null
  sku?: string
  gtin?: string | null
  categoryId?: string
  modifierGroupIds?: string[]
  active?: boolean
  displayOrder?: number
  trackInventory?: boolean
  inventoryMethod?: 'QUANTITY' | 'RECIPE' | null

  // ═══════════════════════════════════════════════════════════════
  // Square-aligned contextual fields
  // ═══════════════════════════════════════════════════════════════
  isAlcoholic?: boolean
  kitchenName?: string | null
  abbreviation?: string | null
  duration?: number | null

  // Event fields
  eventDate?: string | Date | null
  eventTime?: string | null
  eventEndTime?: string | null
  eventCapacity?: number | null
  eventLocation?: string | null

  // Digital fields
  downloadUrl?: string | null
  downloadLimit?: number | null
  fileSize?: string | null

  // Donation fields
  suggestedAmounts?: number[]
  allowCustomAmount?: boolean
  donationCause?: string | null
}

export interface ReorderProductsDto {
  id: string
  displayOrder: number
}

export interface QuickAddProductDto {
  barcode: string
  name: string
  price: number
  categoryId?: string
  trackInventory?: boolean
}

// ═══════════════════════════════════════════════════════════════
// PRODUCT TYPE VALIDATION (Square-aligned)
// ═══════════════════════════════════════════════════════════════

/**
 * Types that CANNOT track inventory (services, digital, donations)
 */
const _NO_INVENTORY_TYPES: ProductType[] = ['SERVICE', 'APPOINTMENTS_SERVICE', 'CLASS', 'DIGITAL', 'DONATION']

/**
 * Validate product data based on its type (Square-aligned rules)
 */
function validateProductByType(data: CreateProductDto | UpdateProductDto, _isUpdate: boolean = false): void {
  const type = data.type

  if (!type) return // Type not being changed in update

  // Kitchen name validation (max 50 chars)
  if (data.kitchenName && data.kitchenName.length > 50) {
    throw new AppError('Kitchen name must be 50 characters or less', 400)
  }

  // Abbreviation validation (max 24 chars, like Square)
  if (data.abbreviation && data.abbreviation.length > 24) {
    throw new AppError('Abbreviation must be 24 characters or less', 400)
  }

  // Duration validation (1-1440 minutes = 1 min to 24 hours)
  if (data.duration !== undefined && data.duration !== null) {
    if (data.duration < 1 || data.duration > 1440) {
      throw new AppError('Duration must be between 1 and 1440 minutes', 400)
    }
  }

  // Type-specific validations
  switch (type) {
    case 'FOOD_AND_BEV':
      // isAlcoholic is optional, defaults to false
      break

    case 'SERVICE':
    case 'APPOINTMENTS_SERVICE':
      // Services cannot track inventory
      if ('trackInventory' in data && data.trackInventory === true) {
        throw new AppError('Services cannot track inventory', 400)
      }
      break

    case 'EVENT':
      // Event date is recommended but not strictly required (can be TBD)
      // Capacity validation
      if (data.eventCapacity !== undefined && data.eventCapacity !== null && data.eventCapacity < 1) {
        throw new AppError('Event capacity must be at least 1', 400)
      }
      break

    case 'DIGITAL':
      // Digital products cannot track inventory (infinite by nature)
      if ('trackInventory' in data && data.trackInventory === true) {
        throw new AppError('Digital products cannot track inventory', 400)
      }
      // Download URL is recommended but can be added later
      break

    case 'DONATION':
      // Donations cannot track inventory
      if ('trackInventory' in data && data.trackInventory === true) {
        throw new AppError('Donations cannot track inventory', 400)
      }
      // Suggested amounts validation
      if (data.suggestedAmounts) {
        for (const amount of data.suggestedAmounts) {
          if (amount <= 0) {
            throw new AppError('Suggested donation amounts must be positive', 400)
          }
        }
      }
      break

    case 'REGULAR':
    case 'OTHER':
      // No special validations
      break

    // Legacy types (deprecated but still valid for backwards compatibility)
    case 'FOOD':
    case 'BEVERAGE':
    case 'ALCOHOL':
    case 'RETAIL':
      // Allow but log deprecation warning
      logger.warn(`Using deprecated product type: ${type}. Consider migrating to Square-aligned types.`)
      break
  }
}

/**
 * Normalize product type for legacy compatibility
 * Maps legacy types to new Square-aligned types for queries
 */
export function normalizeProductType(type: ProductType): ProductType {
  const legacyMap: Record<string, ProductType> = {
    FOOD: 'FOOD_AND_BEV',
    BEVERAGE: 'FOOD_AND_BEV',
    ALCOHOL: 'FOOD_AND_BEV',
    RETAIL: 'REGULAR',
  }
  return (legacyMap[type] as ProductType) || type
}

/**
 * Calculate available portions from recipe (Toast POS pattern)
 *
 * Logic: For each ingredient, calculate how many complete portions can be made.
 * Return the MINIMUM (bottleneck ingredient determines max portions).
 *
 * Example:
 *   Burger recipe:
 *     - Beef: 3750g stock ÷ 250g per burger = 15 portions
 *     - Bun: 40 buns ÷ 2 per burger = 20 portions
 *     - Lettuce: 1500g ÷ 50g per burger = 30 portions
 *   Result: Math.min(15, 20, 30) = 15 burgers available
 */
function calculateAvailablePortions(recipe: any): number {
  if (!recipe?.lines || recipe.lines.length === 0) {
    return 0 // No ingredients = can't make any
  }

  const portionsPerIngredient = recipe.lines.map((line: any) => {
    const stock = Number(line.rawMaterial?.currentStock ?? 0)
    const needed = Number(line.quantity ?? 0)

    if (needed === 0) {
      return Infinity // Optional ingredient (skip)
    }

    return Math.floor(stock / needed)
  })

  // Return minimum (bottleneck ingredient)
  return Math.min(...portionsPerIngredient)
}

/**
 * Get all products for a venue (excluding soft-deleted)
 *
 * ✅ WORLD-CLASS: Calculates availableQuantity for both QUANTITY and RECIPE tracking
 * (Toast POS pattern - unified field for frontend display)
 */
export async function getProducts(
  venueId: string,
  options?: {
    includeRecipe?: boolean
    includePricingPolicy?: boolean
    categoryId?: string
    orderBy?: 'displayOrder' | 'name'
  },
): Promise<any[]> {
  const products = await prisma.product.findMany({
    where: {
      venueId,
      deletedAt: null, // Exclude soft-deleted products
      ...(options?.categoryId && { categoryId: options.categoryId }),
    },
    include: {
      category: true,
      inventory: true, // ✅ For QUANTITY tracking
      modifierGroups: {
        include: {
          group: {
            include: {
              modifiers: { where: { active: true } },
            },
          },
        },
        orderBy: { displayOrder: 'asc' },
      },
      // ✅ ALWAYS include recipe for availableQuantity calculation
      recipe: {
        include: {
          lines: {
            include: {
              rawMaterial: {
                select: {
                  id: true,
                  currentStock: true,
                },
              },
            },
          },
        },
      },
      // ✅ Include pricing policy for pricing analysis page
      ...(options?.includePricingPolicy && {
        pricingPolicy: true,
      }),
    },
    orderBy: options?.orderBy === 'name' ? { name: 'asc' } : { displayOrder: 'asc' },
  })

  // ✅ Calculate availableQuantity for each product (Toast POS pattern)
  return products.map(product => {
    let availableQuantity = null

    if (product.trackInventory) {
      if (product.inventoryMethod === 'QUANTITY') {
        // ✅ Simple count (wine bottles, beer cans)
        availableQuantity = Math.floor(Number(product.inventory?.currentStock ?? 0))
      } else if (product.inventoryMethod === 'RECIPE' && product.recipe) {
        // ✅ Calculate from recipe ingredients (burgers, pizzas)
        availableQuantity = calculateAvailablePortions(product.recipe)
      }
    }

    return {
      ...product,
      availableQuantity, // ✅ Unified field for frontend (both QUANTITY and RECIPE)
    }
  })
}

/**
 * Get a single product by ID (excluding soft-deleted)
 *
 * ✅ WORLD-CLASS: Calculates availableQuantity for both QUANTITY and RECIPE tracking
 * (Toast POS pattern - unified field for frontend display)
 */
export async function getProduct(venueId: string, productId: string): Promise<any> {
  const product = await prisma.product.findFirst({
    where: {
      id: productId,
      venueId,
      deletedAt: null, // Exclude soft-deleted products
    },
    include: {
      category: true,
      inventory: true, // ✅ For QUANTITY tracking
      modifierGroups: {
        include: {
          group: {
            include: {
              modifiers: { where: { active: true } },
            },
          },
        },
        orderBy: { displayOrder: 'asc' },
      },
      // ✅ Include recipe for availableQuantity calculation
      recipe: {
        include: {
          lines: {
            include: {
              rawMaterial: {
                select: {
                  id: true,
                  currentStock: true,
                },
              },
            },
          },
        },
      },
    },
  })

  if (!product) {
    return null
  }

  // ✅ Calculate availableQuantity (Toast POS pattern)
  let availableQuantity = null

  if (product.trackInventory) {
    if (product.inventoryMethod === 'QUANTITY') {
      // ✅ Simple count (wine bottles, beer cans)
      availableQuantity = Math.floor(Number(product.inventory?.currentStock ?? 0))
    } else if (product.inventoryMethod === 'RECIPE' && product.recipe) {
      // ✅ Calculate from recipe ingredients (burgers, pizzas)
      availableQuantity = calculateAvailablePortions(product.recipe)
    }
  }

  return {
    ...product,
    availableQuantity, // ✅ Unified field for frontend (both QUANTITY and RECIPE)
  }
}

/**
 * Create a new product
 */
export async function createProduct(venueId: string, productData: CreateProductDto): Promise<Product> {
  // ✅ Validate product data based on type (Square-aligned)
  validateProductByType(productData)

  const { modifierGroupIds, ...productFields } = productData

  // Get the next display order
  const maxOrder = await prisma.product.findFirst({
    where: { venueId },
    orderBy: { displayOrder: 'desc' },
    select: { displayOrder: true },
  })

  const displayOrder = (maxOrder?.displayOrder || 0) + 1

  // ✅ Build product data with Square-aligned contextual fields
  const product = await prisma.product.create({
    data: {
      // Basic fields
      name: productFields.name,
      description: productFields.description,
      price: productFields.price,
      type: productFields.type,
      imageUrl: productFields.imageUrl,
      sku: productFields.sku,
      gtin: productFields.gtin,
      categoryId: productFields.categoryId,
      venueId,
      displayOrder,
      active: true,

      // ═══════════════════════════════════════════════════════════════
      // Square-aligned contextual fields
      // ═══════════════════════════════════════════════════════════════
      isAlcoholic: productFields.isAlcoholic ?? false,
      kitchenName: productFields.kitchenName,
      abbreviation: productFields.abbreviation,
      duration: productFields.duration,

      // Event fields
      eventDate: productFields.eventDate ? new Date(productFields.eventDate) : undefined,
      eventTime: productFields.eventTime,
      eventEndTime: productFields.eventEndTime,
      eventCapacity: productFields.eventCapacity,
      eventLocation: productFields.eventLocation,

      // Digital fields
      downloadUrl: productFields.downloadUrl,
      downloadLimit: productFields.downloadLimit,
      fileSize: productFields.fileSize,

      // Donation fields
      suggestedAmounts: productFields.suggestedAmounts,
      allowCustomAmount: productFields.allowCustomAmount ?? true,
      donationCause: productFields.donationCause,

      // Modifier groups
      modifierGroups: modifierGroupIds?.length
        ? {
            create: modifierGroupIds.map((groupId, index) => ({
              groupId,
              displayOrder: index,
            })),
          }
        : undefined,
    },
    include: {
      category: true,
      modifierGroups: {
        include: {
          group: true,
        },
      },
    },
  })

  // 🔌 REAL-TIME: Broadcast product creation via Socket.IO
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    // Broadcast menu item created event
    broadcastingService.broadcastMenuItemCreated(venueId, {
      itemId: product.id,
      itemName: product.name,
      sku: product.sku,
      categoryId: product.categoryId,
      categoryName: product.category.name,
      price: Number(product.price),
      available: product.active,
      imageUrl: product.imageUrl,
      description: product.description,
      modifierGroupIds: product.modifierGroups.map(mg => mg.groupId),
    })

    // Broadcast menu_updated event for full refresh
    broadcastingService.broadcastMenuUpdated(venueId, {
      updateType: 'PARTIAL_UPDATE',
      productIds: [product.id],
      categoryIds: [product.categoryId],
      reason: 'ITEM_ADDED',
    })

    logger.info('🔌 Menu item created event broadcasted', {
      venueId,
      productId: product.id,
      productName: product.name,
      categoryId: product.categoryId,
    })
  }

  return product
}

/**
 * Update an existing product
 */
export async function updateProduct(venueId: string, productId: string, productData: UpdateProductDto): Promise<Product> {
  // ✅ Validate product data based on type (Square-aligned)
  validateProductByType(productData, true)

  const { modifierGroupIds, ...productFields } = productData

  // First check if product exists and belongs to venue
  const existingProduct = await prisma.product.findFirst({
    where: { id: productId, venueId },
  })

  if (!existingProduct) {
    throw new AppError(`Product with ID ${productId} not found in venue ${venueId}`, 404)
  }

  // If modifierGroupIds is provided, update the relationships
  const updateData: any = { ...productFields }

  // ✅ WORLD-CLASS: If trackInventory is set to false, clear inventoryMethod
  if (productData.trackInventory === false) {
    updateData.inventoryMethod = null
  }

  // ✅ Handle event date conversion
  if (productData.eventDate !== undefined) {
    updateData.eventDate = productData.eventDate ? new Date(productData.eventDate) : null
  }

  if (modifierGroupIds !== undefined) {
    // Validate that all provided modifier group IDs exist and belong to the venue
    if (modifierGroupIds.length > 0) {
      const validModifierGroups = await prisma.modifierGroup.findMany({
        where: {
          id: { in: modifierGroupIds },
          venueId,
        },
        select: { id: true },
      })

      const validGroupIds = validModifierGroups.map(group => group.id)
      const invalidGroupIds = modifierGroupIds.filter(id => !validGroupIds.includes(id))

      if (invalidGroupIds.length > 0) {
        throw new AppError(`Invalid modifier group IDs: ${invalidGroupIds.join(', ')}`, 400)
      }

      updateData.modifierGroups = {
        deleteMany: {}, // Remove all existing relationships
        create: validGroupIds.map((groupId, index) => ({
          groupId,
          displayOrder: index,
        })),
      }
    } else {
      // No modifier groups selected, just remove all existing relationships
      updateData.modifierGroups = {
        deleteMany: {}, // Remove all existing relationships
      }
    }
  }

  const product = await prisma.product.update({
    where: { id: productId },
    data: updateData,
    include: {
      category: true,
      modifierGroups: {
        include: {
          group: true,
        },
      },
    },
  })

  // 🔌 REAL-TIME: Broadcast product update via Socket.IO
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    // Detect what changed
    const priceChanged = productData.price !== undefined && productData.price !== Number(existingProduct.price)
    const availabilityChanged = productData.active !== undefined && productData.active !== existingProduct.active

    // Broadcast specific price change event
    if (priceChanged) {
      const oldPrice = Number(existingProduct.price)
      const newPrice = productData.price!
      const priceChange = newPrice - oldPrice
      const priceChangePercent = (priceChange / oldPrice) * 100

      broadcastingService.broadcastProductPriceChanged(venueId, {
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        oldPrice,
        newPrice,
        priceChange,
        priceChangePercent,
        categoryId: product.categoryId,
        categoryName: product.category.name,
      })

      logger.info('🔌 Product price changed event broadcasted', {
        venueId,
        productId: product.id,
        productName: product.name,
        oldPrice,
        newPrice,
        priceChange: `${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}`,
        priceChangePercent: `${priceChangePercent >= 0 ? '+' : ''}${priceChangePercent.toFixed(2)}%`,
      })
    }

    // Broadcast specific availability change event
    if (availabilityChanged) {
      broadcastingService.broadcastMenuItemAvailabilityChanged(venueId, {
        itemId: product.id,
        itemName: product.name,
        available: product.active,
        previousAvailability: existingProduct.active,
        reason: 'MANUAL',
      })

      logger.info('🔌 Menu item availability changed event broadcasted', {
        venueId,
        itemId: product.id,
        itemName: product.name,
        available: product.active,
        previousAvailability: existingProduct.active,
      })
    }

    // Broadcast general menu item updated event
    broadcastingService.broadcastMenuItemUpdated(venueId, {
      itemId: product.id,
      itemName: product.name,
      sku: product.sku,
      categoryId: product.categoryId,
      categoryName: product.category.name,
      price: Number(product.price),
      available: product.active,
      imageUrl: product.imageUrl,
      description: product.description,
      modifierGroupIds: product.modifierGroups.map(mg => mg.groupId),
    })

    // Broadcast menu_updated event for full refresh
    broadcastingService.broadcastMenuUpdated(venueId, {
      updateType: 'PARTIAL_UPDATE',
      productIds: [product.id],
      categoryIds: [product.categoryId],
      reason: priceChanged ? 'PRICE_CHANGE' : availabilityChanged ? 'AVAILABILITY_CHANGE' : 'ITEM_ADDED',
    })

    logger.info('🔌 Menu updated event broadcasted', {
      venueId,
      productId: product.id,
      updateReason: priceChanged ? 'PRICE_CHANGE' : availabilityChanged ? 'AVAILABILITY_CHANGE' : 'GENERAL_UPDATE',
    })
  }

  return product
}

/**
 * Delete a product (soft delete)
 * Also deletes the product image from Firebase Storage
 */
export async function deleteProduct(venueId: string, productId: string, userId: string): Promise<void> {
  // First check if product exists and belongs to venue (and is not already deleted)
  const existingProduct = await prisma.product.findFirst({
    where: {
      id: productId,
      venueId,
      deletedAt: null, // Ensure product is not already soft-deleted
    },
  })

  if (!existingProduct) {
    throw new AppError(`Product with ID ${productId} not found in venue ${venueId}`, 404)
  }

  // Delete image from Firebase Storage if it exists
  if (existingProduct.imageUrl) {
    logger.info(`🗑️  Deleting product image from storage: ${existingProduct.imageUrl}`)
    await deleteFileFromStorage(existingProduct.imageUrl).catch(error => {
      logger.error(`❌ Failed to delete product image from storage`, error)
      // Continue with soft delete even if storage cleanup fails
    })
  }

  // Soft delete: set deletedAt and deletedBy instead of physically removing the record
  await prisma.product.update({
    where: { id: productId },
    data: {
      deletedAt: new Date(),
      deletedBy: userId,
    },
  })

  // 🔌 REAL-TIME: Broadcast product deletion via Socket.IO
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    // Broadcast menu item deleted event
    broadcastingService.broadcastMenuItemDeleted(venueId, {
      itemId: productId,
      itemName: existingProduct.name,
      sku: existingProduct.sku,
      categoryId: existingProduct.categoryId,
    })

    // Broadcast menu_updated event for full refresh
    broadcastingService.broadcastMenuUpdated(venueId, {
      updateType: 'PARTIAL_UPDATE',
      productIds: [productId],
      categoryIds: [existingProduct.categoryId],
      reason: 'ITEM_REMOVED',
    })

    logger.info('🔌 Menu item deleted event broadcasted', {
      venueId,
      productId,
      productName: existingProduct.name,
      categoryId: existingProduct.categoryId,
    })
  }
}

/**
 * Reorder products by updating their display order
 */
export async function reorderProducts(venueId: string, reorderData: ReorderProductsDto[]): Promise<Prisma.BatchPayload[]> {
  const transactions = reorderData.map(item =>
    prisma.product.updateMany({
      where: { id: item.id, venueId },
      data: { displayOrder: item.displayOrder },
    }),
  )

  return prisma.$transaction(transactions)
}

/**
 * Assign a modifier group to a product
 */
export async function assignModifierGroupToProduct(
  venueId: string,
  productId: string,
  data: { modifierGroupId: string; displayOrder?: number },
): Promise<any> {
  // Check if product exists and belongs to venue
  const product = await prisma.product.findFirst({
    where: { id: productId, venueId },
  })

  if (!product) {
    throw new AppError(`Product with ID ${productId} not found in venue ${venueId}`, 404)
  }

  // Check if modifier group exists and belongs to venue
  const modifierGroup = await prisma.modifierGroup.findFirst({
    where: { id: data.modifierGroupId, venueId },
  })

  if (!modifierGroup) {
    throw new AppError(`Modifier group with ID ${data.modifierGroupId} not found in venue ${venueId}`, 404)
  }

  // Get next display order if not provided
  let displayOrder = data.displayOrder
  if (displayOrder === undefined) {
    const maxOrder = await prisma.productModifierGroup.findFirst({
      where: { productId },
      orderBy: { displayOrder: 'desc' },
      select: { displayOrder: true },
    })
    displayOrder = (maxOrder?.displayOrder || 0) + 1
  }

  const assignment = await prisma.productModifierGroup.create({
    data: {
      productId,
      groupId: data.modifierGroupId,
      displayOrder,
    },
    include: {
      group: true,
    },
  })

  return assignment
}

/**
 * Remove a modifier group from a product
 */
export async function removeModifierGroupFromProduct(venueId: string, productId: string, modifierGroupId: string): Promise<void> {
  // Check if product exists and belongs to venue
  const product = await prisma.product.findFirst({
    where: { id: productId, venueId },
  })

  if (!product) {
    throw new AppError(`Product with ID ${productId} not found in venue ${venueId}`, 404)
  }

  await prisma.productModifierGroup.deleteMany({
    where: {
      productId,
      groupId: modifierGroupId,
    },
  })
}

/**
 * Search product by barcode (SKU)
 *
 * ✅ BARCODE QUICK ADD: Find product by scanning barcode
 * Uses unique constraint (venueId, sku) for O(1) lookup
 */
export async function getProductByBarcode(venueId: string, barcode: string): Promise<any | null> {
  const product = await prisma.product.findFirst({
    where: {
      venueId,
      OR: [{ sku: barcode }, { gtin: barcode }],
      active: true,
      deletedAt: null,
    },
    include: {
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
        orderBy: { displayOrder: 'asc' },
      },
      recipe: {
        include: {
          lines: {
            include: {
              rawMaterial: {
                select: {
                  id: true,
                  currentStock: true,
                },
              },
            },
          },
        },
      },
    },
  })

  if (!product) {
    return null
  }

  // ✅ Calculate availableQuantity (Toast POS pattern)
  let availableQuantity = null

  if (product.trackInventory) {
    if (product.inventoryMethod === 'QUANTITY') {
      availableQuantity = Math.floor(Number(product.inventory?.currentStock ?? 0))
    } else if (product.inventoryMethod === 'RECIPE' && product.recipe) {
      availableQuantity = calculateAvailablePortions(product.recipe)
    }
  }

  return {
    ...product,
    availableQuantity,
  }
}

/**
 * Create product quickly from barcode scan (Square POS pattern)
 *
 * ✅ BARCODE QUICK ADD: When scanning unknown barcode, create product on-the-fly
 * Creates minimal product with barcode as SKU
 */
export async function createQuickAddProduct(venueId: string, quickAddData: QuickAddProductDto): Promise<Product> {
  const { barcode, name, price, categoryId, trackInventory } = quickAddData

  // ✅ CategoryId is required by the database schema
  if (!categoryId) {
    throw new AppError('categoryId is required for creating a product', 400)
  }

  // ✅ Check if product with this barcode already exists (check both SKU and GTIN)
  const existing = await prisma.product.findFirst({
    where: {
      venueId,
      OR: [{ sku: barcode }, { gtin: barcode }],
    },
  })

  if (existing) {
    throw new AppError(`Product with barcode ${barcode} already exists in venue ${venueId}`, 409)
  }

  // Get the next display order
  const maxOrder = await prisma.product.findFirst({
    where: { venueId },
    orderBy: { displayOrder: 'desc' },
    select: { displayOrder: true },
  })

  const displayOrder = (maxOrder?.displayOrder || 0) + 1

  // ✅ Create product with barcode as SKU
  const product = await prisma.product.create({
    data: {
      name,
      sku: barcode, // ✅ Barcode becomes the SKU
      price,
      venueId,
      categoryId, // Validated above, always present
      type: ProductType.OTHER, // Default type for quick-add
      trackInventory: trackInventory || false,
      inventoryMethod: trackInventory ? 'QUANTITY' : null,
      displayOrder,
      active: true,
    },
    include: {
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
      },
    },
  })

  // 🔌 REAL-TIME: Broadcast product creation via Socket.IO
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    const productWithRelations = product as typeof product & {
      category?: { name: string } | null
      modifierGroups: Array<{ groupId: string }>
    }
    broadcastingService.broadcastMenuItemCreated(venueId, {
      itemId: product.id,
      itemName: product.name,
      sku: product.sku,
      categoryId: product.categoryId,
      categoryName: productWithRelations.category?.name || '',
      price: Number(product.price),
      available: product.active,
      imageUrl: product.imageUrl,
      description: product.description,
      modifierGroupIds: productWithRelations.modifierGroups.map(mg => mg.groupId),
    })

    broadcastingService.broadcastMenuUpdated(venueId, {
      updateType: 'PARTIAL_UPDATE',
      productIds: [product.id],
      categoryIds: product.categoryId ? [product.categoryId] : [],
      reason: 'ITEM_ADDED',
    })

    logger.info('🔌 Quick-add product created and broadcasted', {
      venueId,
      productId: product.id,
      productName: product.name,
      barcode,
    })
  }

  return product
}

// ═══════════════════════════════════════════════════════════════
// PRODUCT TYPE CONFIGURATION (Square-aligned)
// ═══════════════════════════════════════════════════════════════

/**
 * Product type configuration for frontend display
 * Based on Square's CatalogItemProductType enum
 */
export interface ProductTypeConfig {
  code: ProductType
  label: string
  labelEs: string
  description: string
  descriptionEs: string
  hasAlcoholToggle?: boolean
  fields: string[]
  canTrackInventory: boolean
  icon?: string // Lucide icon name suggestion
}

/**
 * Complete product type definitions (Square-aligned)
 */
const PRODUCT_TYPE_CONFIGS: ProductTypeConfig[] = [
  {
    code: 'REGULAR' as ProductType,
    label: 'Regular Item',
    labelEs: 'Artículo Regular',
    description: 'Physical products that can be tracked in inventory',
    descriptionEs: 'Productos físicos que pueden rastrearse en inventario',
    fields: ['sku', 'trackInventory', 'inventoryMethod'],
    canTrackInventory: true,
    icon: 'Package',
  },
  {
    code: 'FOOD_AND_BEV' as ProductType,
    label: 'Food & Beverage',
    labelEs: 'Comida y Bebida',
    description: 'Food, drinks, and alcoholic beverages',
    descriptionEs: 'Comida, bebidas y bebidas alcohólicas',
    hasAlcoholToggle: true,
    fields: ['isAlcoholic', 'kitchenName', 'abbreviation', 'calories', 'allergens', 'prepTime', 'cookingNotes'],
    canTrackInventory: true,
    icon: 'UtensilsCrossed',
  },
  {
    code: 'APPOINTMENTS_SERVICE' as ProductType,
    label: 'Service / Appointment',
    labelEs: 'Servicio / Cita',
    description: 'Bookable services with a specific duration',
    descriptionEs: 'Servicios reservables con una duración específica',
    fields: ['duration'],
    canTrackInventory: false,
    icon: 'Calendar',
  },
  {
    code: 'CLASS' as ProductType,
    label: 'Class / Workshop',
    labelEs: 'Clase / Taller',
    description: 'Group sessions with a fixed capacity — yoga, fitness, courses',
    descriptionEs: 'Sesiones grupales con cupo fijo — yoga, fitness, cursos',
    fields: ['maxParticipants'],
    canTrackInventory: false,
    icon: 'Users',
  },
  {
    code: 'EVENT' as ProductType,
    label: 'Event Ticket',
    labelEs: 'Boleto de Evento',
    description: 'Tickets for events, shows, or workshops',
    descriptionEs: 'Boletos para eventos, shows o talleres',
    fields: ['eventDate', 'eventTime', 'eventEndTime', 'eventCapacity', 'eventLocation'],
    canTrackInventory: false,
    icon: 'Ticket',
  },
  {
    code: 'DIGITAL' as ProductType,
    label: 'Digital Product',
    labelEs: 'Producto Digital',
    description: 'Downloadable content, licenses, or subscriptions',
    descriptionEs: 'Contenido descargable, licencias o suscripciones',
    fields: ['downloadUrl', 'downloadLimit', 'fileSize'],
    canTrackInventory: false,
    icon: 'Download',
  },
  {
    code: 'DONATION' as ProductType,
    label: 'Donation',
    labelEs: 'Donación',
    description: 'Charitable contributions with suggested amounts',
    descriptionEs: 'Contribuciones caritativas con montos sugeridos',
    fields: ['suggestedAmounts', 'allowCustomAmount', 'donationCause'],
    canTrackInventory: false,
    icon: 'Heart',
  },
]

/**
 * Industry-specific type recommendations
 * (which types make sense for which VenueType)
 */
const INDUSTRY_TYPE_MATRIX: Record<string, ProductType[]> = {
  // Restaurant/Food Service
  RESTAURANT: ['FOOD_AND_BEV', 'REGULAR', 'DONATION'],
  CAFE: ['FOOD_AND_BEV', 'REGULAR', 'DONATION'],
  BAR: ['FOOD_AND_BEV', 'REGULAR', 'EVENT', 'DONATION'],
  FOOD_TRUCK: ['FOOD_AND_BEV', 'REGULAR'],
  BAKERY: ['FOOD_AND_BEV', 'REGULAR'],
  PIZZERIA: ['FOOD_AND_BEV', 'REGULAR', 'DONATION'],

  // Retail
  RETAIL_STORE: ['REGULAR', 'DIGITAL', 'DONATION'],
  CLOTHING_STORE: ['REGULAR', 'DONATION'],
  ELECTRONICS_STORE: ['REGULAR', 'DIGITAL', 'APPOINTMENTS_SERVICE'],
  GROCERY_STORE: ['REGULAR', 'FOOD_AND_BEV'],
  CONVENIENCE_STORE: ['REGULAR', 'FOOD_AND_BEV'],
  PHARMACY: ['REGULAR', 'APPOINTMENTS_SERVICE'],

  // Services
  SALON: ['APPOINTMENTS_SERVICE', 'REGULAR', 'DONATION'],
  SPA: ['APPOINTMENTS_SERVICE', 'CLASS', 'REGULAR', 'DONATION'],
  GYM: ['CLASS', 'APPOINTMENTS_SERVICE', 'REGULAR', 'EVENT', 'DONATION'],
  CLINIC: ['APPOINTMENTS_SERVICE', 'REGULAR'],

  // Entertainment
  THEATER: ['EVENT', 'FOOD_AND_BEV', 'REGULAR', 'DONATION'],
  MUSEUM: ['EVENT', 'REGULAR', 'DONATION'],
  NIGHT_CLUB: ['FOOD_AND_BEV', 'EVENT', 'DONATION'],

  // Telecom (PlayTelecom specific)
  TELECOM: ['REGULAR', 'DIGITAL', 'APPOINTMENTS_SERVICE'],

  // Default (all types available)
  OTHER: ['REGULAR', 'FOOD_AND_BEV', 'APPOINTMENTS_SERVICE', 'CLASS', 'EVENT', 'DIGITAL', 'DONATION'],
}

/**
 * Get available product types for a venue
 * Returns filtered types based on venue's industry
 *
 * @param venueId - The venue to get types for
 * @returns Product type configurations available for this venue
 */
export async function getProductTypesForVenue(venueId: string): Promise<{
  types: ProductTypeConfig[]
  venueType: string
  recommended: ProductType[]
}> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { type: true },
  })

  if (!venue) {
    throw new AppError('Venue not found', 404)
  }

  const venueType = venue.type || 'OTHER'
  const recommendedTypes = INDUSTRY_TYPE_MATRIX[venueType] || INDUSTRY_TYPE_MATRIX.OTHER

  // Filter and sort: recommended types first, then others
  const recommended = PRODUCT_TYPE_CONFIGS.filter(t => recommendedTypes.includes(t.code))
  const others = PRODUCT_TYPE_CONFIGS.filter(t => !recommendedTypes.includes(t.code))

  return {
    types: [...recommended, ...others],
    venueType,
    recommended: recommendedTypes,
  }
}

/**
 * Get all product type configurations (for superadmin/reference)
 */
export function getAllProductTypeConfigs(): ProductTypeConfig[] {
  return PRODUCT_TYPE_CONFIGS
}
