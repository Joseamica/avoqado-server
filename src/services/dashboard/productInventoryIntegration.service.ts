import prisma from '../../utils/prismaClient'
import { Decimal } from '@prisma/client/runtime/library'
import { RawMaterialMovementType } from '@prisma/client'
import AppError from '../../errors/AppError'
import { deductStockForRecipe } from './rawMaterial.service'

/**
 * Product Inventory Integration Service
 * Handles different inventory models for different business types:
 * - NONE: Services (classes, consultations) - no inventory tracking
 * - SIMPLE_STOCK: Retail (jewelry, clothing) - simple -1 per sale
 * - RECIPE_BASED: Restaurants - ingredient-based costing
 */

export type InventoryType = 'NONE' | 'SIMPLE_STOCK' | 'RECIPE_BASED'

/**
 * Determine inventory type based on product and venue configuration
 */
export async function getProductInventoryType(productId: string): Promise<InventoryType> {
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

  // Check if venue has inventory feature enabled
  const hasInventoryFeature = product.venue.features.some(f => f.active)

  if (!hasInventoryFeature) {
    return 'NONE' // Venue doesn't use inventory
  }

  // If product has a recipe, use recipe-based inventory
  if (product.recipe) {
    return 'RECIPE_BASED'
  }

  // Check if product externalData indicates simple stock tracking
  // This would be set when creating/editing the product
  const externalData = product.externalData as any
  if (externalData?.inventoryType === 'SIMPLE_STOCK') {
    return 'SIMPLE_STOCK'
  }

  // Default: no inventory tracking for this product
  return 'NONE'
}

/**
 * Process inventory deduction when a product is sold
 * Automatically determines the correct method based on inventory type
 */
export async function deductInventoryForProduct(venueId: string, productId: string, quantity: number, orderId: string, staffId?: string) {
  const inventoryType = await getProductInventoryType(productId)

  switch (inventoryType) {
    case 'NONE':
      // No inventory tracking needed
      return {
        inventoryType: 'NONE',
        message: 'No inventory deduction needed',
      }

    case 'SIMPLE_STOCK':
      return await deductSimpleStock(venueId, productId, quantity, orderId, staffId)

    case 'RECIPE_BASED':
      return await deductRecipeBasedInventory(venueId, productId, quantity, orderId, staffId)

    default:
      throw new AppError(`Unknown inventory type: ${inventoryType}`, 500)
  }
}

/**
 * Deduct simple stock (for retail products like jewelry, clothing)
 * Creates a single raw material record for the product itself
 */
async function deductSimpleStock(venueId: string, productId: string, quantity: number, orderId: string, staffId?: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
  })

  if (!product) {
    throw new AppError('Product not found', 404)
  }

  // Find or create raw material for this product
  // First, check if product has a linked rawMaterialId in externalData
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

  if (!rawMaterial) {
    // Auto-create raw material for simple stock tracking
    rawMaterial = await prisma.rawMaterial.create({
      data: {
        venueId,
        name: product.name,
        sku: `PRODUCT-${productId}`,
        category: 'OTHER', // Use OTHER category for finished goods
        unit: 'UNIT',
        unitType: 'COUNT',
        currentStock: 0, // Will be updated via inventory adjustments
        minimumStock: 1, // Minimum stock threshold
        reorderPoint: 5, // Default reorder point
        costPerUnit: product.price.mul(0.5).toNumber(), // Estimate 50% cost ratio
        avgCostPerUnit: product.price.mul(0.5).toNumber(),
        active: true,
        perishable: false,
      },
    })

    // Update product externalData with the new rawMaterialId
    const updatedExternalData = { ...externalData, rawMaterialId: rawMaterial.id }
    await prisma.product.update({
      where: { id: productId },
      data: { externalData: updatedExternalData },
    })
  }

  // Check if there's enough stock
  if (rawMaterial.currentStock.lessThan(quantity)) {
    throw new AppError(
      `Insufficient stock for ${product.name}. Available: ${rawMaterial.currentStock.toNumber()}, Requested: ${quantity}`,
      400,
    )
  }

  // Deduct stock
  const previousStock = rawMaterial.currentStock
  const newStock = previousStock.minus(quantity)

  await prisma.$transaction([
    prisma.rawMaterial.update({
      where: { id: rawMaterial.id },
      data: {
        currentStock: newStock,
      },
    }),
    prisma.rawMaterialMovement.create({
      data: {
        rawMaterialId: rawMaterial.id,
        venueId,
        type: RawMaterialMovementType.USAGE,
        quantity: new Decimal(-quantity),
        unit: rawMaterial.unit,
        previousStock,
        newStock,
        costImpact: rawMaterial.costPerUnit.mul(quantity),
        reason: `Sold ${quantity}x ${product.name}`,
        reference: orderId,
        createdBy: staffId,
      },
    }),
  ])

  return {
    inventoryType: 'SIMPLE_STOCK',
    rawMaterialId: rawMaterial.id,
    quantityDeducted: quantity,
    remainingStock: newStock.toNumber(),
    message: `Deducted ${quantity} unit(s) from simple stock`,
  }
}

/**
 * Deduct recipe-based inventory (for restaurants)
 * Deducts all ingredients used in the recipe
 */
async function deductRecipeBasedInventory(venueId: string, productId: string, quantity: number, orderId: string, staffId?: string) {
  // Use existing recipe deduction logic
  await deductStockForRecipe(venueId, productId, quantity, orderId, staffId)

  return {
    inventoryType: 'RECIPE_BASED',
    message: `Deducted ingredients for ${quantity} portion(s) based on recipe`,
  }
}

/**
 * Get inventory status for a product
 * Returns different information based on inventory type
 */
export async function getProductInventoryStatus(venueId: string, productId: string) {
  const inventoryType = await getProductInventoryType(productId)

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

  switch (inventoryType) {
    case 'NONE':
      return {
        inventoryType: 'NONE',
        available: true,
        message: 'No inventory tracking',
      }

    case 'SIMPLE_STOCK': {
      // First, check if product has a linked rawMaterialId in externalData
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
        inventoryType: 'SIMPLE_STOCK',
        available: rawMaterial ? rawMaterial.currentStock.greaterThan(0) : false,
        currentStock: rawMaterial?.currentStock.toNumber() || 0,
        reorderPoint: rawMaterial?.reorderPoint.toNumber() || 0,
        lowStock: rawMaterial ? rawMaterial.currentStock.lessThanOrEqualTo(rawMaterial.reorderPoint) : false,
        message: rawMaterial ? `${rawMaterial.currentStock.toNumber()} unit(s) in stock` : 'Not tracked in inventory',
      }
    }

    case 'RECIPE_BASED': {
      if (!product.recipe) {
        return {
          inventoryType: 'RECIPE_BASED',
          available: true,
          message: 'Recipe not configured yet',
        }
      }

      // Check if all ingredients are available for at least 1 portion
      const insufficientIngredients = product.recipe.lines.filter(line => {
        if (line.isOptional) return false
        const requiredQuantity = line.quantity
        return line.rawMaterial.currentStock.lessThan(requiredQuantity)
      })

      // Calculate how many portions can be made
      let maxPortions = Infinity
      for (const line of product.recipe.lines) {
        if (line.isOptional) continue
        const portionsFromThisIngredient = line.rawMaterial.currentStock.div(line.quantity).toNumber()
        maxPortions = Math.min(maxPortions, Math.floor(portionsFromThisIngredient))
      }

      if (maxPortions === Infinity) maxPortions = 0

      return {
        inventoryType: 'RECIPE_BASED',
        available: insufficientIngredients.length === 0 && maxPortions > 0,
        maxPortions: maxPortions > 0 ? maxPortions : 0,
        insufficientIngredients: insufficientIngredients.map(line => ({
          rawMaterialId: line.rawMaterial.id,
          name: line.rawMaterial.name,
          required: line.quantity.toNumber(),
          available: line.rawMaterial.currentStock.toNumber(),
          unit: line.rawMaterial.unit,
        })),
        recipeCost: product.recipe.totalCost.toNumber(),
        message:
          maxPortions > 0
            ? `Can make ${maxPortions} portion(s)`
            : insufficientIngredients.length > 0
              ? `Missing ${insufficientIngredients.length} ingredient(s)`
              : 'Recipe configured but no stock',
      }
    }

    default:
      throw new AppError(`Unknown inventory type: ${inventoryType}`, 500)
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
        type: 'SIMPLE_STOCK' as const,
        label: 'wizard.step2.simpleStock',
        description: 'wizard.step2.simpleStockDesc',
        enabled: hasInventoryFeature,
      },
      {
        type: 'RECIPE_BASED' as const,
        label: 'wizard.step2.recipeBased',
        description: 'wizard.step2.recipeBasedDesc',
        enabled: hasInventoryFeature,
      },
    ],
  }
}

/**
 * Set inventory type for a product
 * Updates product metadata to store the inventory type preference
 */
export async function setProductInventoryType(productId: string, inventoryType: InventoryType) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
  })

  if (!product) {
    throw new AppError('Product not found', 404)
  }

  const externalData = (product.externalData as any) || {}
  externalData.inventoryType = inventoryType

  await prisma.product.update({
    where: { id: productId },
    data: {
      externalData,
    },
  })

  return {
    success: true,
    inventoryType,
    message: `Product inventory type set to ${inventoryType}`,
  }
}
