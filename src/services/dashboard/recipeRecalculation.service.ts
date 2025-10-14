import prisma from '../../utils/prismaClient'
import { Decimal } from '@prisma/client/runtime/library'
import { recalculateRecipeCost } from './recipe.service'
import logger from '@/config/logger'

/**
 * Recipe Cost Recalculation Background Job
 * Automatically recalculates recipe costs when ingredient prices change
 */

/**
 * Find recipes that need cost recalculation based on stale ingredient prices
 * A recipe is considered stale if any of its ingredients have been updated more recently than the recipe's cost calculation
 */
export async function getStaleRecipes(venueId: string) {
  // Get all recipes with their last update timestamps and ingredient update times
  const recipes = await prisma.recipe.findMany({
    where: {
      product: {
        venueId,
      },
    },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          venueId: true,
        },
      },
      lines: {
        include: {
          rawMaterial: {
            select: {
              id: true,
              name: true,
              costPerUnit: true,
              updatedAt: true,
            },
          },
        },
      },
      _count: {
        select: {
          lines: true,
        },
      },
    },
    orderBy: {
      updatedAt: 'asc', // Process oldest recipes first
    },
  })

  // Filter recipes where any ingredient has been updated after the recipe
  const staleRecipes = recipes.filter(recipe => {
    // Check if any ingredient was updated after the recipe
    const hasStaleIngredient = recipe.lines.some(line => {
      return line.rawMaterial.updatedAt > recipe.updatedAt
    })

    return hasStaleIngredient
  })

  return staleRecipes.map(recipe => ({
    recipeId: recipe.id,
    productId: recipe.productId,
    productName: recipe.product.name,
    currentCost: recipe.totalCost.toNumber(),
    lastUpdated: recipe.updatedAt,
    ingredientCount: recipe._count.lines,
    staleIngredients: recipe.lines
      .filter(line => line.rawMaterial.updatedAt > recipe.updatedAt)
      .map(line => ({
        rawMaterialId: line.rawMaterialId,
        name: line.rawMaterial.name,
        lastUpdated: line.rawMaterial.updatedAt,
      })),
  }))
}

/**
 * Recalculate all stale recipe costs for a venue
 * Returns statistics about the recalculation process
 */
export async function recalculateStaleRecipes(venueId: string) {
  const staleRecipes = await getStaleRecipes(venueId)

  if (staleRecipes.length === 0) {
    return {
      success: true,
      message: 'No stale recipes found',
      recipesRecalculated: 0,
      totalRecipes: 0,
      changes: [],
    }
  }

  const changes: Array<{
    recipeId: string
    productName: string
    oldCost: number
    newCost: number
    costDifference: number
    percentageChange: number
  }> = []

  let successCount = 0
  let errorCount = 0

  for (const stale of staleRecipes) {
    try {
      const oldCost = stale.currentCost

      // Recalculate the recipe cost
      const updatedRecipe = await recalculateRecipeCost(stale.recipeId)
      const newCost = updatedRecipe.totalCost.toNumber()

      const costDifference = newCost - oldCost
      const percentageChange = oldCost > 0 ? (costDifference / oldCost) * 100 : 0

      changes.push({
        recipeId: stale.recipeId,
        productName: stale.productName,
        oldCost,
        newCost,
        costDifference,
        percentageChange,
      })

      successCount++
    } catch (error) {
      errorCount++
      logger.error(`Error recalculating recipe ${stale.recipeId}:`, error)
    }
  }

  return {
    success: true,
    message: `Recalculated ${successCount} recipe(s) successfully`,
    recipesRecalculated: successCount,
    totalRecipes: staleRecipes.length,
    errors: errorCount,
    changes: changes.sort((a, b) => Math.abs(b.percentageChange) - Math.abs(a.percentageChange)), // Sort by biggest changes first
  }
}

/**
 * Force recalculation of all recipes for a venue
 * Useful for bulk updates or maintenance tasks
 */
export async function recalculateAllRecipes(venueId: string) {
  const recipes = await prisma.recipe.findMany({
    where: {
      product: {
        venueId,
      },
    },
    include: {
      product: {
        select: {
          name: true,
        },
      },
    },
  })

  if (recipes.length === 0) {
    return {
      success: true,
      message: 'No recipes found',
      recipesRecalculated: 0,
    }
  }

  const changes: Array<{
    recipeId: string
    productName: string
    oldCost: number
    newCost: number
    costDifference: number
    percentageChange: number
  }> = []

  let successCount = 0
  let errorCount = 0

  for (const recipe of recipes) {
    try {
      const oldCost = recipe.totalCost.toNumber()

      const updatedRecipe = await recalculateRecipeCost(recipe.id)
      const newCost = updatedRecipe.totalCost.toNumber()

      const costDifference = newCost - oldCost
      const percentageChange = oldCost > 0 ? (costDifference / oldCost) * 100 : 0

      // Only track if there was a change
      if (Math.abs(costDifference) > 0.01) {
        changes.push({
          recipeId: recipe.id,
          productName: recipe.product.name,
          oldCost,
          newCost,
          costDifference,
          percentageChange,
        })
      }

      successCount++
    } catch (error) {
      errorCount++
      logger.error(`Error recalculating recipe ${recipe.id}:`, error)
    }
  }

  return {
    success: true,
    message: `Recalculated ${successCount} recipe(s) successfully`,
    recipesRecalculated: successCount,
    totalRecipes: recipes.length,
    errors: errorCount,
    changes: changes.sort((a, b) => Math.abs(b.percentageChange) - Math.abs(a.percentageChange)),
  }
}

/**
 * Get recipes with significant cost variances from their product prices
 * Useful for identifying pricing issues and opportunities
 */
export async function getRecipeCostVariances(
  venueId: string,
  options?: {
    minVariancePercentage?: number // Default 10%
    sort?: 'highest' | 'lowest' | 'alphabetical'
  },
) {
  const minVariance = options?.minVariancePercentage || 10

  const recipes = await prisma.recipe.findMany({
    where: {
      product: {
        venueId,
      },
    },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          price: true,
          category: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  })

  const variances = recipes.map(recipe => {
    const recipeCost = recipe.totalCost
    const productPrice = recipe.product.price
    const margin = productPrice.minus(recipeCost)
    const marginPercentage = productPrice.greaterThan(0) ? margin.div(productPrice).mul(100) : new Decimal(0)
    const foodCostPercentage = productPrice.greaterThan(0) ? recipeCost.div(productPrice).mul(100) : new Decimal(0)

    return {
      recipeId: recipe.id,
      productId: recipe.product.id,
      productName: recipe.product.name,
      categoryName: recipe.product.category.name,
      recipeCost: recipeCost.toNumber(),
      productPrice: productPrice.toNumber(),
      margin: margin.toNumber(),
      marginPercentage: marginPercentage.toNumber(),
      foodCostPercentage: foodCostPercentage.toNumber(),
      status: foodCostPercentage.greaterThan(40)
        ? 'POOR'
        : foodCostPercentage.greaterThan(30)
          ? 'ACCEPTABLE'
          : foodCostPercentage.greaterThan(20)
            ? 'GOOD'
            : 'EXCELLENT',
    }
  })

  // Filter by minimum variance
  const filtered = variances.filter(v => {
    return Math.abs(100 - v.marginPercentage) >= minVariance || v.foodCostPercentage >= 40
  })

  // Sort based on option
  if (options?.sort === 'highest') {
    filtered.sort((a, b) => b.foodCostPercentage - a.foodCostPercentage)
  } else if (options?.sort === 'lowest') {
    filtered.sort((a, b) => a.foodCostPercentage - b.foodCostPercentage)
  } else {
    filtered.sort((a, b) => a.productName.localeCompare(b.productName))
  }

  return {
    totalRecipes: recipes.length,
    recipesWithVariance: filtered.length,
    averageFoodCostPercentage:
      recipes.length > 0
        ? recipes.reduce((sum, r) => {
            const fcp = r.product.price.greaterThan(0) ? r.totalCost.div(r.product.price).mul(100) : new Decimal(0)
            return sum + fcp.toNumber()
          }, 0) / recipes.length
        : 0,
    variances: filtered,
  }
}
