import prisma from '../../utils/prismaClient'
import { Decimal } from '@prisma/client/runtime/library'
import { Prisma, Unit } from '@prisma/client'
import AppError from '../../errors/AppError'
import { createRecipe } from './recipe.service'
import { setProductInventoryMethod, InventoryMethod } from './productInventoryIntegration.service'
import logger from '@/config/logger'
import { logAction } from './activity-log.service'

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
  // Product type (defaults to FOOD if omitted)
  type?: string
  // Service-specific (SERVICE, APPOINTMENTS_SERVICE)
  duration?: number
  // Class-specific (CLASS)
  maxParticipants?: number
  layoutConfig?: Record<string, unknown> | null
}

export interface WizardStep2Data {
  // Inventory decision
  useInventory: boolean
  inventoryMethod?: InventoryMethod // 'QUANTITY' | 'RECIPE'
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
      ...(data.type && { type: data.type as any }),
      ...(data.duration && { duration: data.duration }),
      ...(data.maxParticipants && { maxParticipants: data.maxParticipants }),
      ...(data.layoutConfig !== undefined && {
        layoutConfig: data.layoutConfig ? (data.layoutConfig as Prisma.InputJsonValue) : Prisma.JsonNull,
      }),
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

  if (!data.useInventory || !data.inventoryMethod) {
    // User doesn't want inventory tracking
    await prisma.product.update({
      where: { id: productId },
      data: {
        trackInventory: false,
        inventoryMethod: null,
        externalData: {
          ...(product.externalData as any),
          wizardCompleted: true,
          inventoryConfigured: true,
        },
      },
    })

    return {
      success: true,
      inventoryMethod: null,
      nextStep: 'complete',
      message: 'Product created without inventory tracking',
    }
  }

  if (!data.inventoryMethod) {
    throw new AppError('Inventory method is required when useInventory is true', 400)
  }

  // Set inventory method (✅ WORLD-CLASS: Uses dedicated column)
  await setProductInventoryMethod(productId, data.inventoryMethod)

  await prisma.product.update({
    where: { id: productId },
    data: {
      externalData: {
        ...(product.externalData as any),
        inventoryConfigured: true,
      },
    },
  })

  return {
    success: true,
    inventoryMethod: data.inventoryMethod,
    nextStep: data.inventoryMethod === 'QUANTITY' ? 'simple_stock_setup' : 'recipe_setup',
    message: `Inventory method set to ${data.inventoryMethod}`,
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

  // ✅ WORLD-CLASS: Auto-switch from RECIPE to QUANTITY if needed
  // Instead of blocking with 409 error, intelligently clean up conflicting config
  if (product.recipe) {
    logger.info('🔄 Auto-switching from RECIPE to QUANTITY - cleaning up existing recipe')
    await switchInventoryMethod(venueId, productId, 'QUANTITY')
  }

  // ✅ WORLD-CLASS: Create or update Inventory record (not RawMaterial!)
  // QUANTITY tracking uses Inventory table for simple count-based tracking
  const existingInventory = await prisma.inventory.findUnique({
    where: {
      productId,
    },
  })

  if (existingInventory) {
    // Update existing
    await prisma.inventory.update({
      where: { id: existingInventory.id },
      data: {
        currentStock: new Decimal(data.initialStock),
        minimumStock: new Decimal(data.reorderPoint),
      },
    })
  } else {
    // Create new
    await prisma.inventory.create({
      data: {
        productId,
        venueId,
        currentStock: new Decimal(data.initialStock),
        minimumStock: new Decimal(data.reorderPoint),
        reservedStock: new Decimal(0),
      },
    })
  }

  // Mark wizard as complete and save cost per unit
  await prisma.product.update({
    where: { id: productId },
    data: {
      cost: new Decimal(data.costPerUnit), // ✅ Save cost per unit
      externalData: {
        ...(product.externalData as any),
        wizardCompleted: true,
        inventoryConfigured: true,
      },
    },
  })

  return {
    success: true,
    inventoryMethod: 'QUANTITY',
    initialStock: data.initialStock,
    minimumStock: data.reorderPoint,
    nextStep: 'complete',
    message: `Simple stock tracking configured: ${data.initialStock} unit(s) in stock`,
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

  // ✅ WORLD-CLASS: Auto-switch from QUANTITY to RECIPE if needed
  // Instead of blocking with 409 error, intelligently clean up conflicting config
  const existingQuantityStock = await prisma.rawMaterial.findFirst({
    where: {
      venueId,
      sku: `PRODUCT-${productId}`,
    },
  })

  if (existingQuantityStock) {
    logger.info('🔄 Auto-switching from QUANTITY to RECIPE - cleaning up existing quantity tracking')
    await switchInventoryMethod(venueId, productId, 'RECIPE')
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
    inventoryMethod: 'RECIPE',
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
    if (step2Result.inventoryMethod === 'QUANTITY' && data.simpleStock) {
      step3Result = await setupSimpleStockStep3(venueId, productId, data.simpleStock)
    } else if (step2Result.inventoryMethod === 'RECIPE' && data.recipe) {
      step3Result = await setupRecipeStep3(venueId, productId, data.recipe)
    }

    logAction({
      venueId,
      action: 'PRODUCT_CREATED',
      entity: 'Product',
      entityId: productId,
      data: { name: data.product.name, inventoryMethod: step2Result.inventoryMethod },
    })

    return {
      success: true,
      productId,
      inventoryMethod: step2Result.inventoryMethod,
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
  const inventoryMethod = product.inventoryMethod // ✅ WORLD-CLASS: Read from dedicated column

  // ✅ WORLD-CLASS: Check if quantity tracking inventory exists (Inventory table, not RawMaterial)
  const inventoryRecord = await prisma.inventory.findUnique({
    where: {
      productId,
    },
  })

  return {
    productId: product.id,
    productName: product.name,
    wizardCompleted,
    steps: {
      productCreated: true,
      inventoryDecided: !!product.inventoryMethod,
      inventoryConfigured,
    },
    inventoryMethod,
    details:
      inventoryMethod === 'QUANTITY' && inventoryRecord
        ? {
            currentStock: inventoryRecord.currentStock.toNumber(),
            minimumStock: inventoryRecord.minimumStock.toNumber(),
            reservedStock: inventoryRecord.reservedStock.toNumber(),
            costPerUnit: product.cost?.toNumber() || 0, // ✅ Include cost per unit
          }
        : inventoryMethod === 'RECIPE' && product.recipe
          ? {
              recipeId: product.recipe.id,
              recipeCost: product.recipe.totalCost.toNumber(),
              ingredientCount: product.recipe.lines.length,
            }
          : null,
    nextStep: !product.inventoryMethod
      ? 'inventory_decision'
      : !inventoryConfigured
        ? inventoryMethod === 'QUANTITY'
          ? 'simple_stock_setup'
          : 'recipe_setup'
        : 'complete',
  }
}

/**
 * Switch inventory method (auto-conversion)
 * Handles conversion between QUANTITY ↔ RECIPE
 * Automatically removes old configuration and updates inventoryMethod
 */
export async function switchInventoryMethod(venueId: string, productId: string, newMethod: InventoryMethod) {
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

    logger.info('🔧 [DEBUG] switchInventoryMethod:', { venueId, productId, productVenueId: product.venueId, newMethod })

    if (product.venueId !== venueId) {
      logger.error('❌ [DEBUG] Venue mismatch!', { requestVenueId: venueId, productVenueId: product.venueId })
      throw new AppError('Product does not belong to this venue', 403)
    }

    // Perform conversion based on newMethod
    if (newMethod === 'RECIPE') {
      // Switching TO RECIPE: Remove existing quantity tracking (Inventory table)
      const existingInventory = await tx.inventory.findUnique({
        where: {
          productId,
        },
      })

      if (existingInventory) {
        // Delete the quantity tracking inventory record
        await tx.inventory.delete({
          where: { id: existingInventory.id },
        })
      }
    } else if (newMethod === 'QUANTITY') {
      // Switching TO QUANTITY: Remove existing recipe
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

    // ✅ WORLD-CLASS: Update product's inventoryMethod column
    await tx.product.update({
      where: { id: productId },
      data: {
        inventoryMethod: newMethod,
      },
    })

    return {
      success: true,
      newMethod,
      message: `Inventory method switched to ${newMethod} successfully`,
    }
  })
}
