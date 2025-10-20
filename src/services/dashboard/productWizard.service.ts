import prisma from '../../utils/prismaClient'
import { Decimal } from '@prisma/client/runtime/library'
import { Unit } from '@prisma/client'
import AppError from '../../errors/AppError'
import { createRecipe } from './recipe.service'
import { setProductInventoryType, InventoryType } from './productInventoryIntegration.service'
import logger from '@/config/logger'

/**
 * Product Creation Wizard Service
 * Guides users through creating products with optional inventory integration
 */

export interface WizardStep1Data {
  // Basic product info
  name: string
  description?: string
  price: number
  categoryId: string
  imageUrl?: string
}

export interface WizardStep2Data {
  // Inventory decision
  useInventory: boolean
  inventoryType?: InventoryType // 'NONE' | 'SIMPLE_STOCK' | 'RECIPE_BASED'
}

export interface WizardStep3SimpleStockData {
  // For SIMPLE_STOCK: initial stock setup
  initialStock: number
  reorderPoint: number
  costPerUnit: number
}

export interface WizardStep3RecipeData {
  // For RECIPE_BASED: recipe configuration
  portionYield: number
  prepTime?: number
  cookTime?: number
  notes?: string
  ingredients: Array<{
    rawMaterialId: string
    quantity: number
    unit: string
    isOptional?: boolean
    substituteNotes?: string
  }>
}

/**
 * Step 1: Create basic product
 * Returns productId for subsequent steps
 */
export async function createProductStep1(venueId: string, data: WizardStep1Data) {
  // Validate category belongs to venue
  const category = await prisma.menuCategory.findFirst({
    where: {
      id: data.categoryId,
      venueId,
    },
  })

  if (!category) {
    throw new AppError('Category not found or does not belong to this venue', 404)
  }

  // Create product
  const product = await prisma.product.create({
    data: {
      venueId,
      categoryId: data.categoryId,
      name: data.name,
      sku: `SKU-${Date.now()}`, // Auto-generate SKU
      description: data.description,
      price: new Decimal(data.price),
      imageUrl: data.imageUrl && data.imageUrl.trim() !== '' ? data.imageUrl : undefined,
      active: true,
      externalData: {
        wizardCompleted: false,
        inventoryConfigured: false,
      },
    },
  })

  return {
    success: true,
    productId: product.id,
    product: {
      id: product.id,
      name: product.name,
      price: product.price.toNumber(),
      category: category.name,
    },
    nextStep: 'inventory_decision',
    message: 'Product created successfully. Configure inventory next.',
  }
}

/**
 * Step 2: Configure inventory type
 * User decides if and how to track inventory
 */
export async function configureInventoryStep2(productId: string, data: WizardStep2Data) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
  })

  if (!product) {
    throw new AppError('Product not found', 404)
  }

  if (!data.useInventory || data.inventoryType === 'NONE') {
    // User doesn't want inventory tracking
    await setProductInventoryType(productId, 'NONE')

    await prisma.product.update({
      where: { id: productId },
      data: {
        externalData: {
          ...(product.externalData as any),
          wizardCompleted: true,
          inventoryConfigured: true,
          inventoryType: 'NONE',
        },
      },
    })

    return {
      success: true,
      inventoryType: 'NONE',
      nextStep: 'complete',
      message: 'Product created without inventory tracking',
    }
  }

  if (!data.inventoryType) {
    throw new AppError('Inventory type is required when useInventory is true', 400)
  }

  // Set inventory type
  await setProductInventoryType(productId, data.inventoryType)

  await prisma.product.update({
    where: { id: productId },
    data: {
      externalData: {
        ...(product.externalData as any),
        inventoryType: data.inventoryType,
      },
    },
  })

  return {
    success: true,
    inventoryType: data.inventoryType,
    nextStep: data.inventoryType === 'SIMPLE_STOCK' ? 'simple_stock_setup' : 'recipe_setup',
    message: `Inventory type set to ${data.inventoryType}`,
  }
}

/**
 * Step 3A: Setup simple stock (for retail/jewelry)
 * Creates/updates the product's raw material record
 */
export async function setupSimpleStockStep3(venueId: string, productId: string, data: WizardStep3SimpleStockData) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      recipe: {
        select: { id: true },
      },
    },
  })

  if (!product) {
    throw new AppError('Product not found', 404)
  }

  // VALIDATION: Prevent SIMPLE_STOCK if product already has a recipe
  if (product.recipe) {
    throw new AppError(
      'Cannot configure Simple Stock: This product already has a recipe configured. Please delete the recipe first or use Recipe-Based inventory.',
      409,
    )
  }

  // Create or update raw material for this product
  const existingRawMaterial = await prisma.rawMaterial.findFirst({
    where: {
      venueId,
      sku: `PRODUCT-${productId}`,
    },
  })

  if (existingRawMaterial) {
    // Update existing
    await prisma.rawMaterial.update({
      where: { id: existingRawMaterial.id },
      data: {
        currentStock: new Decimal(data.initialStock),
        reorderPoint: new Decimal(data.reorderPoint),
        costPerUnit: new Decimal(data.costPerUnit),
        avgCostPerUnit: new Decimal(data.costPerUnit),
      },
    })
  } else {
    // Create new
    await prisma.rawMaterial.create({
      data: {
        venueId,
        name: product.name,
        sku: `PRODUCT-${productId}`,
        category: 'OTHER', // Use OTHER category for finished goods
        unit: 'UNIT',
        unitType: 'COUNT',
        currentStock: new Decimal(data.initialStock),
        minimumStock: new Decimal(1), // Minimum stock threshold
        reorderPoint: new Decimal(data.reorderPoint),
        costPerUnit: new Decimal(data.costPerUnit),
        avgCostPerUnit: new Decimal(data.costPerUnit),
        active: true,
        perishable: false,
      },
    })
  }

  // Mark wizard as complete
  await prisma.product.update({
    where: { id: productId },
    data: {
      externalData: {
        ...(product.externalData as any),
        wizardCompleted: true,
        inventoryConfigured: true,
      },
    },
  })

  return {
    success: true,
    inventoryType: 'SIMPLE_STOCK',
    initialStock: data.initialStock,
    reorderPoint: data.reorderPoint,
    nextStep: 'complete',
    message: `Simple stock configured: ${data.initialStock} unit(s) in stock`,
  }
}

/**
 * Step 3B: Setup recipe (for restaurants)
 * Creates recipe with ingredients
 */
export async function setupRecipeStep3(venueId: string, productId: string, data: WizardStep3RecipeData) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
  })

  if (!product) {
    throw new AppError('Product not found', 404)
  }

  if (product.venueId !== venueId) {
    throw new AppError('Product does not belong to this venue', 403)
  }

  // VALIDATION: Prevent RECIPE_BASED if product already has simple stock configured
  const existingSimpleStock = await prisma.rawMaterial.findFirst({
    where: {
      venueId,
      sku: `PRODUCT-${productId}`,
    },
  })

  if (existingSimpleStock) {
    throw new AppError(
      'Cannot configure Recipe: This product already has Simple Stock configured. Please delete the simple stock configuration first or use Simple Stock inventory.',
      409,
    )
  }

  // Validate that all ingredients exist
  const rawMaterialIds = data.ingredients.map(i => i.rawMaterialId)
  const rawMaterials = await prisma.rawMaterial.findMany({
    where: {
      id: { in: rawMaterialIds },
      venueId,
    },
  })

  if (rawMaterials.length !== rawMaterialIds.length) {
    throw new AppError('Some ingredients were not found or do not belong to this venue', 404)
  }

  // Create recipe
  const recipe = await createRecipe(venueId, productId, {
    portionYield: data.portionYield,
    prepTime: data.prepTime,
    cookTime: data.cookTime,
    notes: data.notes,
    lines: data.ingredients.map(ing => ({
      rawMaterialId: ing.rawMaterialId,
      quantity: ing.quantity,
      unit: ing.unit as Unit,
      isOptional: ing.isOptional || false,
      substituteNotes: ing.substituteNotes,
    })),
  })

  // Mark wizard as complete
  await prisma.product.update({
    where: { id: productId },
    data: {
      externalData: {
        ...(product.externalData as any),
        wizardCompleted: true,
        inventoryConfigured: true,
      },
    },
  })

  return {
    success: true,
    inventoryType: 'RECIPE_BASED',
    recipeId: recipe.id,
    recipeCost: recipe.totalCost.toNumber(),
    portionYield: data.portionYield,
    ingredientCount: data.ingredients.length,
    nextStep: 'complete',
    message: `Recipe configured with ${data.ingredients.length} ingredient(s)`,
  }
}

/**
 * Complete wizard flow - all in one call
 * For simpler UIs that don't need step-by-step
 */
export async function createProductWithInventory(
  venueId: string,
  data: {
    product: WizardStep1Data
    inventory: WizardStep2Data
    simpleStock?: WizardStep3SimpleStockData
    recipe?: WizardStep3RecipeData
  },
) {
  // Step 1: Create product
  const step1Result = await createProductStep1(venueId, data.product)
  const productId = step1Result.productId

  try {
    // Step 2: Configure inventory
    const step2Result = await configureInventoryStep2(productId, data.inventory)

    // Step 3: Setup inventory details
    let step3Result
    if (step2Result.inventoryType === 'SIMPLE_STOCK' && data.simpleStock) {
      step3Result = await setupSimpleStockStep3(venueId, productId, data.simpleStock)
    } else if (step2Result.inventoryType === 'RECIPE_BASED' && data.recipe) {
      step3Result = await setupRecipeStep3(venueId, productId, data.recipe)
    }

    return {
      success: true,
      productId,
      inventoryType: step2Result.inventoryType,
      details: step3Result,
      message: 'Product created successfully with inventory configuration',
    }
  } catch (error) {
    // Rollback: Delete the product if inventory setup fails
    await prisma.product.delete({
      where: { id: productId },
    })
    throw error
  }
}

/**
 * Get wizard progress for a product
 * Returns current step and what's completed
 */
export async function getWizardProgress(productId: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      recipe: {
        select: {
          id: true,
          totalCost: true,
          lines: {
            select: {
              rawMaterialId: true,
            },
          },
        },
      },
    },
  })

  if (!product) {
    throw new AppError('Product not found', 404)
  }

  const externalData = (product.externalData as any) || {}
  const wizardCompleted = externalData.wizardCompleted || false
  const inventoryConfigured = externalData.inventoryConfigured || false
  const inventoryType = externalData.inventoryType || 'NONE'

  // Check if simple stock raw material exists
  const simpleStockMaterial = await prisma.rawMaterial.findFirst({
    where: {
      venueId: product.venueId,
      sku: `PRODUCT-${productId}`,
    },
  })

  return {
    productId: product.id,
    productName: product.name,
    wizardCompleted,
    steps: {
      productCreated: true,
      inventoryDecided: !!externalData.inventoryType,
      inventoryConfigured,
    },
    inventoryType,
    details:
      inventoryType === 'SIMPLE_STOCK' && simpleStockMaterial
        ? {
            currentStock: simpleStockMaterial.currentStock.toNumber(),
            reorderPoint: simpleStockMaterial.reorderPoint.toNumber(),
            costPerUnit: simpleStockMaterial.costPerUnit.toNumber(),
          }
        : inventoryType === 'RECIPE_BASED' && product.recipe
          ? {
              recipeId: product.recipe.id,
              recipeCost: product.recipe.totalCost.toNumber(),
              ingredientCount: product.recipe.lines.length,
            }
          : null,
    nextStep: !externalData.inventoryType
      ? 'inventory_decision'
      : !inventoryConfigured
        ? inventoryType === 'SIMPLE_STOCK'
          ? 'simple_stock_setup'
          : 'recipe_setup'
        : 'complete',
  }
}

/**
 * Switch inventory type (auto-conversion)
 * Handles conversion between SIMPLE_STOCK ↔ RECIPE_BASED
 * Automatically removes old configuration and updates inventoryType
 */
export async function switchInventoryType(venueId: string, productId: string, newType: InventoryType) {
  return await prisma.$transaction(async tx => {
    // Verify product exists and belongs to venue
    const product = await tx.product.findUnique({
      where: { id: productId },
      include: {
        recipe: {
          select: { id: true },
        },
      },
    })

    if (!product) {
      throw new AppError('Product not found', 404)
    }

    logger.info('🔧 [DEBUG] switchInventoryType:', { venueId, productId, productVenueId: product.venueId, newType })

    if (product.venueId !== venueId) {
      logger.error('❌ [DEBUG] Venue mismatch!', { requestVenueId: venueId, productVenueId: product.venueId })
      throw new AppError('Product does not belong to this venue', 403)
    }

    // Perform conversion based on newType
    if (newType === 'RECIPE_BASED') {
      // Switching TO RECIPE_BASED: Remove existing simple stock
      const existingRawMaterial = await tx.rawMaterial.findFirst({
        where: {
          venueId,
          sku: `PRODUCT-${productId}`,
        },
      })

      if (existingRawMaterial) {
        // Delete the simple stock raw material
        await tx.rawMaterial.delete({
          where: { id: existingRawMaterial.id },
        })
      }
    } else if (newType === 'SIMPLE_STOCK') {
      // Switching TO SIMPLE_STOCK: Remove existing recipe
      if (product.recipe) {
        // Delete recipe lines first (foreign key constraint)
        await tx.recipeLine.deleteMany({
          where: { recipeId: product.recipe.id },
        })

        // Then delete the recipe
        await tx.recipe.delete({
          where: { id: product.recipe.id },
        })
      }
    }

    // Update product's inventoryType in externalData
    const externalData = (product.externalData as any) || {}
    await tx.product.update({
      where: { id: productId },
      data: {
        externalData: {
          ...externalData,
          inventoryType: newType,
        },
      },
    })

    return {
      success: true,
      newType,
      message: `Inventory type switched to ${newType} successfully`,
    }
  })
}
