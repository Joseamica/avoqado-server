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
  categoryId: string
  modifierGroupIds?: string[]
}

export interface UpdateProductDto {
  name?: string
  description?: string
  price?: number
  type?: ProductType
  imageUrl?: string | null
  sku?: string
  categoryId?: string
  modifierGroupIds?: string[]
  active?: boolean
  displayOrder?: number
  trackInventory?: boolean
  inventoryMethod?: 'QUANTITY' | 'RECIPE' | null
}

export interface ReorderProductsDto {
  id: string
  displayOrder: number
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
              modifiers: true,
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
              modifiers: true,
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
  const { modifierGroupIds, ...productFields } = productData

  // Get the next display order
  const maxOrder = await prisma.product.findFirst({
    where: { venueId },
    orderBy: { displayOrder: 'desc' },
    select: { displayOrder: true },
  })

  const displayOrder = (maxOrder?.displayOrder || 0) + 1

  const product = await prisma.product.create({
    data: {
      name: productFields.name,
      description: productFields.description,
      price: productFields.price,
      type: productFields.type,
      imageUrl: productFields.imageUrl,
      sku: productFields.sku,
      categoryId: productFields.categoryId,
      venueId,
      displayOrder,
      active: true,
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
  const { modifierGroupIds, ...productFields } = productData

  // First check if product exists and belongs to venue
  const existingProduct = await prisma.product.findFirst({
    where: { id: productId, venueId },
  })

  if (!existingProduct) {
    throw new AppError(`Product with ID ${productId} not found in venue ${venueId}`, 404)
  }

  // If modifierGroupIds is provided, update the relationships
  const updateData: any = productFields

  // ✅ WORLD-CLASS: If trackInventory is set to false, clear inventoryMethod
  if (productData.trackInventory === false) {
    updateData.inventoryMethod = null
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
