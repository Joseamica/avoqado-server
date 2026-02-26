import { MovementType } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import AppError from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { deductStockForModifiers, deductStockForRecipe, OrderModifierForInventory } from './rawMaterial.service'
import { logAction } from './activity-log.service'

/**
 * Product Inventory Integration Service
 * Handles different inventory models for different business types:
 * - NONE: Services (classes, consultations) - no inventory tracking
 * - QUANTITY: Retail (jewelry, clothing) - direct unit counting
 * - RECIPE: Restaurants - ingredient-based costing (FIFO)
 *
 * ✅ WORLD-CLASS PATTERN: Toast/Square/Shopify naming
 */

export type InventoryMethod = 'QUANTITY' | 'RECIPE'

/**
 * Determine inventory method based on product configuration
 * Returns null if product doesn't track inventory
 */
export async function getProductInventoryMethod(productId: string): Promise<InventoryMethod | null> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      recipe: {
        select: {
          id: true,
        },
      },
      venue: {
        select: {
          features: {
            where: {
              feature: {
                code: 'INVENTORY_TRACKING',
              },
            },
            select: {
              active: true,
            },
          },
        },
      },
    },
  })

  if (!product) {
    throw new AppError('Product not found', 404)
  }

  // If product doesn't track inventory, return null
  if (!product.trackInventory) {
    return null
  }

  // ✅ WORLD-CLASS: Read from dedicated column (not JSON!)
  // Use explicit inventoryMethod if set
  if (product.inventoryMethod) {
    return product.inventoryMethod
  }

  // Fallback for legacy products: infer from relations
  if (product.recipe) {
    return 'RECIPE'
  }

  // Default: null (no tracking)
  return null
}

/**
 * Process inventory deduction when a product is sold
 * Automatically determines the correct method based on inventory configuration
 *
 * ✅ WORLD-CLASS: Supports modifier inventory tracking (Toast/Square pattern)
 * - ADDITION modifiers: Add extra ingredients on top of the recipe
 * - SUBSTITUTION modifiers: Replace variable ingredients in the recipe
 *
 * @param orderModifiers - Optional: Modifiers selected for this order item
 */
export async function deductInventoryForProduct(
  venueId: string,
  productId: string,
  quantity: number,
  orderId: string,
  staffId?: string,
  orderModifiers?: OrderModifierForInventory[],
) {
  const inventoryMethod = await getProductInventoryMethod(productId)

  // No inventory tracking for product
  if (!inventoryMethod) {
    // ✅ Still process ADDITION modifiers even if product doesn't track inventory
    // Example: "Extra Bacon" on a product without recipe tracking
    if (orderModifiers?.length) {
      await deductStockForModifiers(venueId, quantity, orderModifiers, orderId, staffId)
    }
    return {
      inventoryMethod: null,
      message: orderModifiers?.length ? 'No product inventory, modifiers processed' : 'No inventory deduction needed',
    }
  }

  switch (inventoryMethod) {
    case 'QUANTITY': {
      const result = await deductSimpleStock(venueId, productId, quantity, orderId, staffId)
      // ✅ Also deduct ADDITION modifiers for QUANTITY products
      if (orderModifiers?.length) {
        await deductStockForModifiers(venueId, quantity, orderModifiers, orderId, staffId)
      }
      return result
    }

    case 'RECIPE': {
      // ✅ Pass modifiers to recipe deduction (handles SUBSTITUTION)
      const result = await deductRecipeBasedInventory(venueId, productId, quantity, orderId, staffId, orderModifiers)
      // ✅ Also deduct ADDITION modifiers (SUBSTITUTION handled in deductStockForRecipe)
      if (orderModifiers?.length) {
        await deductStockForModifiers(venueId, quantity, orderModifiers, orderId, staffId)
      }
      return result
    }

    default:
      throw new AppError(`Unknown inventory method: ${inventoryMethod}`, 500)
  }
}

/**
 * Deduct simple stock (for retail products like jewelry, clothing)
 * ✅ FIX (2025-11-29): Uses Inventory table consistently
 * - Status check uses Inventory table (getProductInventoryStatus)
 * - Deduction uses Inventory table (this function)
 * - Movement tracked in InventoryMovement table
 *
 * This ensures QUANTITY products have a single source of truth
 * (unlike the previous implementation that used RawMaterial for deduction)
 */
/**
 * Deduct simple stock (for retail products like jewelry, clothing)
 * ✅ FIX (2026-01-16): Uses ATOMIC DECREMENT to prevent race conditions
 * - Uses interactive transaction to ensure consistency
 * - Decrements stock atomically
 * - Creates movement log with correct values
 */
async function deductSimpleStock(venueId: string, productId: string, quantity: number, orderId: string, staffId?: string) {
  return await prisma.$transaction(async tx => {
    // 1. Get product for metadata
    const product = await tx.product.findUnique({
      where: { id: productId },
    })

    if (!product) {
      throw new AppError('Product not found', 404)
    }

    // 2. Get current inventory record
    const inventory = await tx.inventory.findUnique({
      where: { productId },
    })

    if (!inventory) {
      throw new AppError(
        `No inventory record for product "${product.name}". Create inventory via Product Wizard or manual stock adjustment.`,
        404,
      )
    }

    // 3. Check stock (Optimistic check - technically could race between this check and update,
    // but the atomic decrement below ensures we don't drift.
    // Ideally we would use tx.inventory.update({ where: { currentStock: { gte: quantity } } }) but Prisma doesn't support that easily yet.
    if (inventory.currentStock.lessThan(quantity)) {
      throw new AppError(
        `Insufficient stock for ${product.name}. Available: ${inventory.currentStock.toNumber()}, Requested: ${quantity}`,
        400,
      )
    }

    // 4. ATOMIC DECREMENT and return new value
    // This prevents "lost updates" race condition
    const updatedInventory = await tx.inventory.update({
      where: { productId },
      data: {
        currentStock: { decrement: quantity },
      },
    })

    // 5. Create Movement Log based on the operation
    // We calculate "previous" from the "new" + quantity to be consistent with the atomic op
    const newStock = updatedInventory.currentStock
    const previousStock = newStock.add(quantity)

    await tx.inventoryMovement.create({
      data: {
        inventoryId: inventory.id,
        type: MovementType.SALE,
        quantity: new Decimal(-quantity),
        previousStock,
        newStock,
        reason: `Sold ${quantity}x ${product.name}`,
        reference: orderId,
        createdBy: staffId,
      },
    })

    return {
      inventoryMethod: 'QUANTITY',
      inventoryId: inventory.id,
      quantityDeducted: quantity,
      remainingStock: newStock.toNumber(),
      message: `Deducted ${quantity} unit(s) from inventory tracking`,
    }
  })
}

/**
 * Deduct recipe-based inventory (for restaurants)
 * Deducts all ingredients used in the recipe
 *
 * ✅ WORLD-CLASS: Passes modifiers to support SUBSTITUTION mode
 * Variable ingredients in recipes can be substituted by modifier selections
 */
async function deductRecipeBasedInventory(
  venueId: string,
  productId: string,
  quantity: number,
  orderId: string,
  staffId?: string,
  orderModifiers?: OrderModifierForInventory[],
) {
  // Use existing recipe deduction logic with modifier support
  await deductStockForRecipe(venueId, productId, quantity, orderId, staffId, orderModifiers)

  return {
    inventoryMethod: 'RECIPE',
    message: `Deducted ingredients for ${quantity} portion(s) based on recipe`,
  }
}

/**
 * Get inventory status for a product
 * Returns different information based on inventory method
 */
export async function getProductInventoryStatus(venueId: string, productId: string) {
  const inventoryMethod = await getProductInventoryMethod(productId)

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      recipe: {
        include: {
          lines: {
            include: {
              rawMaterial: {
                select: {
                  id: true,
                  name: true,
                  currentStock: true,
                  reorderPoint: true,
                  unit: true,
                },
              },
            },
          },
        },
      },
    },
  })

  if (!product) {
    throw new AppError('Product not found', 404)
  }

  // No inventory tracking
  if (!inventoryMethod) {
    return {
      inventoryMethod: null,
      available: true,
      message: 'No inventory tracking',
    }
  }

  switch (inventoryMethod) {
    case 'QUANTITY': {
      // ✅ FIX: QUANTITY method should use Inventory table (per productWizard.service.ts design)
      // First, check the Inventory table (primary source for QUANTITY products)
      const inventoryRecord = await prisma.inventory.findUnique({
        where: { productId },
      })

      if (inventoryRecord) {
        const currentStock = inventoryRecord.currentStock.toNumber()
        const minimumStock = inventoryRecord.minimumStock.toNumber()
        return {
          inventoryMethod: 'QUANTITY',
          available: currentStock > 0,
          currentStock,
          reorderPoint: minimumStock,
          lowStock: currentStock <= minimumStock,
          message: `${currentStock} unit(s) in stock`,
        }
      }

      // Fallback: Check RawMaterial (legacy or externalData.rawMaterialId linkage)
      const externalData = product.externalData as any
      let rawMaterial = null

      if (externalData?.rawMaterialId) {
        rawMaterial = await prisma.rawMaterial.findUnique({
          where: { id: externalData.rawMaterialId },
        })
      }

      // Fallback: search by conventional SKU pattern
      if (!rawMaterial) {
        rawMaterial = await prisma.rawMaterial.findFirst({
          where: {
            venueId,
            sku: `PRODUCT-${productId}`,
          },
        })
      }

      return {
        inventoryMethod: 'QUANTITY',
        available: rawMaterial ? rawMaterial.currentStock.greaterThan(0) : false,
        currentStock: rawMaterial?.currentStock.toNumber() || 0,
        reorderPoint: rawMaterial?.reorderPoint.toNumber() || 0,
        lowStock: rawMaterial ? rawMaterial.currentStock.lessThanOrEqualTo(rawMaterial.reorderPoint) : false,
        message: rawMaterial ? `${rawMaterial.currentStock.toNumber()} unit(s) in stock` : 'Not tracked in inventory',
      }
    }

    case 'RECIPE': {
      if (!product.recipe) {
        return {
          inventoryMethod: 'RECIPE',
          available: true,
          message: 'Recipe not configured yet',
        }
      }

      // Calculate yield per ingredient and identify bottleneck
      const ingredientYields = product.recipe.lines
        .filter(line => !line.isOptional) // Skip optional ingredients for bottleneck calculation
        .map(line => {
          const available = line.rawMaterial.currentStock
          const required = line.quantity
          // Avoid division by zero
          if (required.equals(0)) return { line, portions: Infinity, available, required }

          const portions = available.div(required).toNumber()
          return {
            line,
            portions: Math.floor(portions),
            available: available.toNumber(),
            required: required.toNumber(),
          }
        })
        .sort((a, b) => a.portions - b.portions)

      const bottleneck = ingredientYields[0]

      // If no mandatory ingredients, assume infinite capacity (or handling logic)
      // But typically we treat "no ingredients" as "0 capacity" or "Not configured"
      let maxPortions = bottleneck ? bottleneck.portions : 0

      // If we have no mandatory ingredients but have recipe, strictly speaking yield is undefined/0
      if (product.recipe.lines.length === 0) maxPortions = 0

      // Map existing insufficientIngredients (legacy support + specific "completely missing" list)
      const insufficientIngredients = product.recipe.lines
        .filter(line => !line.isOptional && line.rawMaterial.currentStock.lessThan(line.quantity))
        .map(line => ({
          rawMaterialId: line.rawMaterial.id,
          name: line.rawMaterial.name,
          required: line.quantity.toNumber(),
          available: line.rawMaterial.currentStock.toNumber(),
          unit: line.rawMaterial.unit,
        }))

      return {
        inventoryMethod: 'RECIPE',
        available: maxPortions > 0,
        maxPortions,
        insufficientIngredients,
        // ✅ NEW: Explicit Limiting Factor (Bottleneck)
        limitingIngredient: bottleneck
          ? {
              rawMaterialId: bottleneck.line.rawMaterial.id,
              name: bottleneck.line.rawMaterial.name,
              required: bottleneck.required,
              available: bottleneck.available,
              unit: bottleneck.line.rawMaterial.unit,
              maxPortions: bottleneck.portions, // How many this ingredient allows
            }
          : null,
        recipeCost: product.recipe.totalCost.toNumber(),
        message: bottleneck ? `Limited by ${bottleneck.line.rawMaterial.name} (${bottleneck.portions})` : 'Recipe needs ingredients',
      }
    }

    default:
      throw new AppError(`Unknown inventory type: ${inventoryMethod}`, 500)
  }
}

/**
 * Wizard step 1: Check if product should use inventory
 * Returns recommendation based on venue type and features
 */
export async function shouldProductUseInventory(venueId: string) {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    include: {
      features: {
        where: {
          feature: {
            code: 'INVENTORY_TRACKING',
          },
        },
        select: {
          active: true,
        },
      },
    },
  })

  if (!venue) {
    throw new AppError('Venue not found', 404)
  }

  const hasInventoryFeature = venue.features.some(f => f.active)

  return {
    hasInventoryFeature,
    recommendation: hasInventoryFeature ? 'wizard.step2.recommendationEnabled' : 'wizard.step2.recommendationDisabled',
    options: [
      {
        type: 'NONE' as const,
        label: 'wizard.step2.noInventory',
        description: 'wizard.step2.noInventoryDesc',
        enabled: true,
      },
      {
        type: 'QUANTITY' as const,
        label: 'wizard.step2.simpleStock',
        description: 'wizard.step2.simpleStockDesc',
        enabled: hasInventoryFeature,
      },
      {
        type: 'RECIPE' as const,
        label: 'wizard.step2.recipeBased',
        description: 'wizard.step2.recipeBasedDesc',
        enabled: hasInventoryFeature,
      },
    ],
  }
}

/**
 * Set inventory method for a product
 * ✅ WORLD-CLASS: Updates dedicated column (not JSON!)
 */
export async function setProductInventoryMethod(productId: string, inventoryMethod: InventoryMethod) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
  })

  if (!product) {
    throw new AppError('Product not found', 404)
  }

  // ✅ Write to dedicated column (world-class pattern)
  await prisma.product.update({
    where: { id: productId },
    data: {
      trackInventory: true, // Enable tracking
      inventoryMethod, // Set method (QUANTITY | RECIPE)
    },
  })

  logAction({
    venueId: product.venueId,
    action: 'PRODUCT_INVENTORY_METHOD_SET',
    entity: 'Product',
    entityId: productId,
    data: { inventoryMethod },
  })

  return {
    success: true,
    inventoryMethod,
    message: `Product inventory method set to ${inventoryMethod}`,
  }
}
