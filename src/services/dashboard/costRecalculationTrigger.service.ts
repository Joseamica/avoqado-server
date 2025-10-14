import prisma from '../../utils/prismaClient'
import { recalculateRecipeCost } from './recipe.service'
import logger from '@/config/logger'

/**
 * Cost Recalculation Trigger Service
 * Automatically recalculates recipe costs when ingredient prices change
 * This service should be called whenever a raw material's costPerUnit is updated
 */

/**
 * Trigger: Called when a raw material's costPerUnit changes
 * Recalculates all affected recipes and optionally updates pricing policies
 */
export async function onRawMaterialCostChange(
  rawMaterialId: string,
  oldCost: number,
  newCost: number,
  options?: {
    recalculateRecipes?: boolean // Default: true
    updatePricingPolicies?: boolean // Default: false (requires manual review)
    notifyManagers?: boolean // Default: true
  },
) {
  const { recalculateRecipes = true, updatePricingPolicies: _updatePricingPolicies = false, notifyManagers = true } = options || {}

  const rawMaterial = await prisma.rawMaterial.findUnique({
    where: { id: rawMaterialId },
    select: {
      id: true,
      name: true,
      venueId: true,
      costPerUnit: true,
    },
  })

  if (!rawMaterial) {
    logger.error(`Raw material ${rawMaterialId} not found`)
    return {
      success: false,
      error: 'Raw material not found',
    }
  }

  const costChange = newCost - oldCost
  const percentageChange = oldCost > 0 ? (costChange / oldCost) * 100 : 0

  logger.info(
    `🔄 Cost change detected for ${rawMaterial.name}: $${oldCost.toFixed(2)} → $${newCost.toFixed(2)} (${percentageChange > 0 ? '+' : ''}${percentageChange.toFixed(1)}%)`,
  )

  // Find all recipes using this ingredient
  const affectedRecipes = await prisma.recipe.findMany({
    where: {
      lines: {
        some: {
          rawMaterialId,
        },
      },
      product: {
        venueId: rawMaterial.venueId,
      },
    },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          price: true,
        },
      },
      lines: {
        where: {
          rawMaterialId,
        },
        select: {
          quantity: true,
        },
      },
    },
  })

  if (affectedRecipes.length === 0) {
    logger.info(`ℹ️ No recipes affected by this cost change`)
    return {
      success: true,
      affectedRecipes: 0,
      message: 'No recipes use this ingredient',
    }
  }

  logger.info(`📊 Found ${affectedRecipes.length} recipe(s) affected`)

  const results = {
    success: true,
    rawMaterialId,
    rawMaterialName: rawMaterial.name,
    costChange: {
      old: oldCost,
      new: newCost,
      difference: costChange,
      percentageChange,
    },
    affectedRecipes: [] as Array<{
      recipeId: string
      productName: string
      oldRecipeCost: number
      newRecipeCost: number
      costDifference: number
      percentageChange: number
      pricingImpact: {
        currentPrice: number
        oldMargin: number
        newMargin: number
        marginChange: number
        oldFoodCostPercentage: number
        newFoodCostPercentage: number
        needsReview: boolean
      }
    }>,
    summary: {
      totalRecipes: affectedRecipes.length,
      recalculated: 0,
      errors: 0,
      needsPriceReview: 0,
    },
  }

  // Recalculate each affected recipe
  for (const recipe of affectedRecipes) {
    try {
      const oldRecipeCost = recipe.totalCost.toNumber()

      // Recalculate recipe cost
      if (recalculateRecipes) {
        const updatedRecipe = await recalculateRecipeCost(recipe.id)
        const newRecipeCost = updatedRecipe.totalCost.toNumber()
        const recipeCostChange = newRecipeCost - oldRecipeCost
        const recipePercentageChange = oldRecipeCost > 0 ? (recipeCostChange / oldRecipeCost) * 100 : 0

        // Calculate pricing impact
        const currentPrice = recipe.product.price.toNumber()
        const oldMargin = currentPrice - oldRecipeCost
        const newMargin = currentPrice - newRecipeCost
        const marginChange = newMargin - oldMargin

        const oldFoodCostPercentage = currentPrice > 0 ? (oldRecipeCost / currentPrice) * 100 : 0
        const newFoodCostPercentage = currentPrice > 0 ? (newRecipeCost / currentPrice) * 100 : 0

        // Flag for review if food cost % exceeds thresholds
        const needsReview = newFoodCostPercentage > 35 || Math.abs(newFoodCostPercentage - oldFoodCostPercentage) > 5

        results.affectedRecipes.push({
          recipeId: recipe.id,
          productName: recipe.product.name,
          oldRecipeCost,
          newRecipeCost,
          costDifference: recipeCostChange,
          percentageChange: recipePercentageChange,
          pricingImpact: {
            currentPrice,
            oldMargin,
            newMargin,
            marginChange,
            oldFoodCostPercentage,
            newFoodCostPercentage,
            needsReview,
          },
        })

        results.summary.recalculated++
        if (needsReview) results.summary.needsPriceReview++

        logger.info(
          `  ✅ ${recipe.product.name}: $${oldRecipeCost.toFixed(2)} → $${newRecipeCost.toFixed(2)} (Food cost: ${oldFoodCostPercentage.toFixed(1)}% → ${newFoodCostPercentage.toFixed(1)}%)`,
        )
      }
    } catch (error) {
      logger.error(`  ❌ Error recalculating recipe ${recipe.id}:`, error)
      results.summary.errors++
    }
  }

  // TODO: Send notification to managers if enabled
  if (notifyManagers && results.summary.needsPriceReview > 0) {
    logger.info(`📧 TODO: Send notification to managers - ${results.summary.needsPriceReview} product(s) need price review`)
  }

  return results
}

/**
 * Bulk trigger: Called when multiple raw materials are updated
 * (e.g., after receiving a purchase order)
 */
export async function onBulkRawMaterialCostChange(
  updates: Array<{
    rawMaterialId: string
    oldCost: number
    newCost: number
  }>,
) {
  const results = []

  for (const update of updates) {
    const result = await onRawMaterialCostChange(update.rawMaterialId, update.oldCost, update.newCost, {
      recalculateRecipes: true,
      updatePricingPolicies: false,
      notifyManagers: false, // Will send single notification at the end
    })
    results.push(result)
  }

  const summary = {
    totalRawMaterialsUpdated: updates.length,
    totalRecipesAffected: results.reduce((sum, r) => {
      if ('affectedRecipes' in r && Array.isArray(r.affectedRecipes)) {
        return sum + r.affectedRecipes.length
      }
      return sum
    }, 0),
    totalRecipesRecalculated: results.reduce((sum, r) => {
      if ('summary' in r && r.summary) {
        return sum + r.summary.recalculated
      }
      return sum
    }, 0),
    totalNeedingPriceReview: results.reduce((sum, r) => {
      if ('summary' in r && r.summary) {
        return sum + r.summary.needsPriceReview
      }
      return sum
    }, 0),
    errors: results.reduce((sum, r) => {
      if ('summary' in r && r.summary) {
        return sum + r.summary.errors
      }
      return sum
    }, 0),
  }

  logger.info(`\n📊 Bulk Cost Update Summary:`)
  logger.info(`   - Raw materials updated: ${summary.totalRawMaterialsUpdated}`)
  logger.info(`   - Recipes affected: ${summary.totalRecipesAffected}`)
  logger.info(`   - Recipes recalculated: ${summary.totalRecipesRecalculated}`)
  logger.info(`   - Products needing price review: ${summary.totalNeedingPriceReview}`)

  return {
    success: true,
    summary,
    details: results,
  }
}

/**
 * Preview cost change impact WITHOUT applying changes
 * Useful for "what-if" analysis before updating costs
 */
export async function previewCostChange(rawMaterialId: string, proposedNewCost: number) {
  const rawMaterial = await prisma.rawMaterial.findUnique({
    where: { id: rawMaterialId },
    select: {
      id: true,
      name: true,
      costPerUnit: true,
    },
  })

  if (!rawMaterial) {
    throw new Error('Raw material not found')
  }

  const currentCost = rawMaterial.costPerUnit.toNumber()
  const costChange = proposedNewCost - currentCost
  const percentageChange = currentCost > 0 ? (costChange / currentCost) * 100 : 0

  // Find affected recipes
  const affectedRecipes = await prisma.recipe.findMany({
    where: {
      lines: {
        some: {
          rawMaterialId,
        },
      },
    },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          price: true,
        },
      },
      lines: {
        where: {
          rawMaterialId,
        },
        select: {
          quantity: true,
        },
      },
    },
  })

  const preview = affectedRecipes.map(recipe => {
    const currentRecipeCost = recipe.totalCost.toNumber()
    const ingredientQuantity = recipe.lines.reduce((sum, line) => sum + line.quantity.toNumber(), 0)
    const ingredientCostImpact = ingredientQuantity * costChange
    const estimatedNewRecipeCost = currentRecipeCost + ingredientCostImpact

    const currentPrice = recipe.product.price.toNumber()
    const currentFoodCostPercentage = currentPrice > 0 ? (currentRecipeCost / currentPrice) * 100 : 0
    const estimatedNewFoodCostPercentage = currentPrice > 0 ? (estimatedNewRecipeCost / currentPrice) * 100 : 0

    return {
      productId: recipe.product.id,
      productName: recipe.product.name,
      currentRecipeCost,
      estimatedNewRecipeCost,
      costImpact: ingredientCostImpact,
      currentPrice,
      currentFoodCostPercentage,
      estimatedNewFoodCostPercentage,
      recommendation: estimatedNewFoodCostPercentage > 40 ? 'INCREASE_PRICE' : estimatedNewFoodCostPercentage > 35 ? 'REVIEW_PRICE' : 'OK',
    }
  })

  return {
    rawMaterial: {
      id: rawMaterial.id,
      name: rawMaterial.name,
      currentCost,
      proposedNewCost,
      costChange,
      percentageChange,
    },
    affectedRecipes: preview,
    summary: {
      totalRecipes: preview.length,
      needPriceIncrease: preview.filter(p => p.recommendation === 'INCREASE_PRICE').length,
      needPriceReview: preview.filter(p => p.recommendation === 'REVIEW_PRICE').length,
      ok: preview.filter(p => p.recommendation === 'OK').length,
    },
  }
}
