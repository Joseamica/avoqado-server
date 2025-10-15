import { Recipe, Unit } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { CreateRecipeDto, UpdateRecipeDto } from '../../schemas/dashboard/inventory.schema'
import { Decimal } from '@prisma/client/runtime/library'
import AppError from '@/errors/AppError'

/**
 * Get recipe for a product
 */
export async function getRecipe(venueId: string, productId: string) {
  const recipe = await prisma.recipe.findUnique({
    where: { productId },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          price: true,
          venueId: true,
        },
      },
      lines: {
        include: {
          rawMaterial: true,
        },
        orderBy: {
          displayOrder: 'asc',
        },
      },
    },
  })

  if (recipe && recipe.product.venueId !== venueId) {
    throw new AppError('Recipe not found', 404)
  }

  return recipe
}

/**
 * Calculate recipe cost from ingredients
 */
function calculateRecipeCost(lines: Array<{ quantity: Decimal; rawMaterial: { costPerUnit: Decimal } }>): Decimal {
  return lines.reduce((total, line) => {
    return total.add(line.quantity.mul(line.rawMaterial.costPerUnit))
  }, new Decimal(0))
}

/**
 * Create a new recipe for a product
 */
export async function createRecipe(venueId: string, productId: string, data: CreateRecipeDto): Promise<Recipe> {
  // Verify product exists and belongs to venue
  const product = await prisma.product.findFirst({
    where: {
      id: productId,
      venueId,
    },
  })

  if (!product) {
    throw new AppError(`Product with ID ${productId} not found in venue ${venueId}`, 404)
  }

  // Check if recipe already exists
  const existingRecipe = await prisma.recipe.findUnique({
    where: { productId },
  })

  if (existingRecipe) {
    throw new AppError(`Recipe already exists for product ${product.name}`, 400)
  }

  // Verify all raw materials exist
  const rawMaterialIds = data.lines.map(line => line.rawMaterialId)
  const rawMaterials = await prisma.rawMaterial.findMany({
    where: {
      id: { in: rawMaterialIds },
      venueId,
    },
  })

  if (rawMaterials.length !== rawMaterialIds.length) {
    throw new AppError('Some raw materials not found', 404)
  }

  // Calculate total cost
  const linesWithCosts = data.lines.map(line => {
    const rawMaterial = rawMaterials.find(rm => rm.id === line.rawMaterialId)!
    const costPerServing = new Decimal(line.quantity).mul(rawMaterial.costPerUnit).div(data.portionYield)
    return { ...line, costPerServing }
  })

  const totalCost = linesWithCosts.reduce((sum, line) => sum.add(line.costPerServing), new Decimal(0))

  // Create recipe with lines in transaction
  const recipe = await prisma.recipe.create({
    data: {
      productId,
      portionYield: data.portionYield,
      totalCost,
      prepTime: data.prepTime,
      cookTime: data.cookTime,
      notes: data.notes,
      lines: {
        create: linesWithCosts.map((line, index) => ({
          rawMaterialId: line.rawMaterialId,
          quantity: line.quantity,
          unit: line.unit as Unit,
          costPerServing: line.costPerServing,
          displayOrder: index,
          isOptional: line.isOptional,
          substituteNotes: line.substituteNotes,
        })),
      },
    },
    include: {
      lines: {
        include: {
          rawMaterial: true,
        },
      },
      product: true,
    },
  })

  return recipe as any
}

/**
 * Update an existing recipe
 */
export async function updateRecipe(venueId: string, productId: string, data: UpdateRecipeDto): Promise<Recipe> {
  const existingRecipe = await prisma.recipe.findUnique({
    where: { productId },
    include: {
      product: {
        select: {
          venueId: true,
        },
      },
    },
  })

  if (!existingRecipe || existingRecipe.product.venueId !== venueId) {
    throw new AppError(`Recipe not found for product ${productId}`, 404)
  }

  // If updating lines, recalculate cost
  let totalCost = existingRecipe.totalCost

  if (data.lines) {
    const rawMaterialIds = data.lines.map(line => line.rawMaterialId)
    const rawMaterials = await prisma.rawMaterial.findMany({
      where: {
        id: { in: rawMaterialIds },
        venueId,
      },
    })

    if (rawMaterials.length !== rawMaterialIds.length) {
      throw new AppError('Some raw materials not found', 404)
    }

    const portionYield = data.portionYield || existingRecipe.portionYield

    const linesWithCosts = data.lines.map(line => {
      const rawMaterial = rawMaterials.find(rm => rm.id === line.rawMaterialId)!
      const costPerServing = new Decimal(line.quantity).mul(rawMaterial.costPerUnit).div(portionYield)
      return { ...line, costPerServing }
    })

    totalCost = linesWithCosts.reduce((sum, line) => sum.add(line.costPerServing), new Decimal(0))

    // Update recipe with new lines
    const recipe = await prisma.$transaction(async tx => {
      // Delete old lines
      await tx.recipeLine.deleteMany({
        where: { recipeId: existingRecipe.id },
      })

      // Update recipe
      return tx.recipe.update({
        where: { id: existingRecipe.id },
        data: {
          portionYield: data.portionYield,
          totalCost,
          prepTime: data.prepTime,
          cookTime: data.cookTime,
          notes: data.notes,
          lines: {
            create: linesWithCosts.map((line, index) => ({
              rawMaterialId: line.rawMaterialId,
              quantity: line.quantity,
              unit: line.unit as Unit,
              costPerServing: line.costPerServing,
              displayOrder: index,
              isOptional: line.isOptional,
              substituteNotes: line.substituteNotes,
            })),
          },
        },
        include: {
          lines: {
            include: {
              rawMaterial: true,
            },
          },
          product: true,
        },
      })
    })

    return recipe as any
  } else {
    // Just update recipe metadata
    const recipe = await prisma.recipe.update({
      where: { id: existingRecipe.id },
      data: {
        portionYield: data.portionYield,
        prepTime: data.prepTime,
        cookTime: data.cookTime,
        notes: data.notes,
      },
      include: {
        lines: {
          include: {
            rawMaterial: true,
          },
        },
        product: true,
      },
    })

    return recipe as any
  }
}

/**
 * Delete a recipe
 */
export async function deleteRecipe(venueId: string, productId: string): Promise<void> {
  const recipe = await prisma.recipe.findUnique({
    where: { productId },
    include: {
      product: {
        select: {
          venueId: true,
        },
      },
    },
  })

  if (!recipe || recipe.product.venueId !== venueId) {
    throw new AppError(`Recipe not found for product ${productId}`, 404)
  }

  await prisma.recipe.delete({
    where: { id: recipe.id },
  })
}

/**
 * Add a single ingredient to a recipe
 */
export async function addRecipeLine(
  venueId: string,
  productId: string,
  data: {
    rawMaterialId: string
    quantity: number
    unit: string
    isOptional?: boolean
    substituteNotes?: string
  },
) {
  const recipe = await prisma.recipe.findUnique({
    where: { productId },
    include: {
      product: {
        select: {
          venueId: true,
        },
      },
      lines: true,
    },
  })

  if (!recipe || recipe.product.venueId !== venueId) {
    throw new AppError(`Recipe not found for product ${productId}`, 404)
  }

  // Verify raw material exists
  const rawMaterial = await prisma.rawMaterial.findFirst({
    where: {
      id: data.rawMaterialId,
      venueId,
    },
  })

  if (!rawMaterial) {
    throw new AppError(`Raw material not found`, 404)
  }

  // Calculate cost per serving
  const costPerServing = new Decimal(data.quantity).mul(rawMaterial.costPerUnit).div(recipe.portionYield)

  // Get next display order
  const maxOrder = Math.max(...recipe.lines.map(l => l.displayOrder), -1)

  const recipeLine = await prisma.recipeLine.create({
    data: {
      recipeId: recipe.id,
      rawMaterialId: data.rawMaterialId,
      quantity: data.quantity,
      unit: data.unit as Unit,
      costPerServing,
      displayOrder: maxOrder + 1,
      isOptional: data.isOptional || false,
      substituteNotes: data.substituteNotes,
    },
    include: {
      rawMaterial: true,
    },
  })

  // Update recipe total cost
  const newTotalCost = recipe.totalCost.add(costPerServing)
  await prisma.recipe.update({
    where: { id: recipe.id },
    data: { totalCost: newTotalCost },
  })

  return recipeLine
}

/**
 * Remove an ingredient from a recipe
 */
export async function removeRecipeLine(venueId: string, productId: string, recipeLineId: string): Promise<void> {
  const recipe = await prisma.recipe.findUnique({
    where: { productId },
    include: {
      product: {
        select: {
          venueId: true,
        },
      },
      lines: true,
    },
  })

  if (!recipe || recipe.product.venueId !== venueId) {
    throw new AppError(`Recipe not found for product ${productId}`, 404)
  }

  const line = recipe.lines.find(l => l.id === recipeLineId)

  if (!line) {
    throw new AppError(`Recipe line not found`, 404)
  }

  await prisma.$transaction([
    prisma.recipeLine.delete({
      where: { id: recipeLineId },
    }),
    prisma.recipe.update({
      where: { id: recipe.id },
      data: { totalCost: recipe.totalCost.minus(line.costPerServing || 0) },
    }),
  ])
}

/**
 * Recalculate recipe cost (useful when ingredient prices change)
 */
export async function recalculateRecipeCost(recipeId: string): Promise<Recipe> {
  const recipe = await prisma.recipe.findUnique({
    where: { id: recipeId },
    include: {
      lines: {
        include: {
          rawMaterial: true,
        },
      },
    },
  })

  if (!recipe) {
    throw new AppError('Recipe not found', 404)
  }

  const totalCost = calculateRecipeCost(recipe.lines)

  const updatedRecipe = await prisma.recipe.update({
    where: { id: recipeId },
    data: { totalCost },
    include: {
      lines: {
        include: {
          rawMaterial: true,
        },
      },
      product: true,
    },
  })

  return updatedRecipe as any
}
