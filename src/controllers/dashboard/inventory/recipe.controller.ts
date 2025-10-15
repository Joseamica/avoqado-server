import { Request, Response, NextFunction } from 'express'
import * as recipeService from '../../../services/dashboard/recipe.service'

/**
 * Get recipe for a product
 */
export async function getRecipe(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId } = req.params

    const recipe = await recipeService.getRecipe(venueId, productId)

    if (!recipe) {
      return res.json({
        success: true,
        data: null,
        message: 'No recipe found for this product',
      })
    }

    res.json({
      success: true,
      data: recipe,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Create a new recipe for a product
 */
export async function createRecipe(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId } = req.params
    const data = req.body

    const recipe = await recipeService.createRecipe(venueId, productId, data)

    res.status(201).json({
      success: true,
      message: 'Recipe created successfully',
      data: recipe,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Update an existing recipe
 */
export async function updateRecipe(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId } = req.params
    const data = req.body

    const recipe = await recipeService.updateRecipe(venueId, productId, data)

    res.json({
      success: true,
      message: 'Recipe updated successfully',
      data: recipe,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Delete a recipe
 */
export async function deleteRecipe(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId } = req.params

    await recipeService.deleteRecipe(venueId, productId)

    res.json({
      success: true,
      message: 'Recipe deleted successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Add a single ingredient to a recipe
 */
export async function addRecipeLine(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId } = req.params
    const data = req.body

    const recipeLine = await recipeService.addRecipeLine(venueId, productId, data)

    res.status(201).json({
      success: true,
      message: 'Ingredient added to recipe',
      data: recipeLine,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Remove an ingredient from a recipe
 */
export async function removeRecipeLine(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId, recipeLineId } = req.params

    await recipeService.removeRecipeLine(venueId, productId, recipeLineId)

    res.json({
      success: true,
      message: 'Ingredient removed from recipe',
    })
  } catch (error) {
    next(error)
  }
}
