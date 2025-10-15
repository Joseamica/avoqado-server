import { Request, Response, NextFunction } from 'express'
import * as productWizardService from '../../../services/dashboard/productWizard.service'
import * as productInventoryService from '../../../services/dashboard/productInventoryIntegration.service'
import * as costRecalculationService from '../../../services/dashboard/costRecalculationTrigger.service'
import * as recipeRecalculationService from '../../../services/dashboard/recipeRecalculation.service'

/**
 * Check if venue should use inventory (recommendations)
 */
export async function shouldUseInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const recommendations = await productInventoryService.shouldProductUseInventory(venueId)

    res.json({
      success: true,
      data: recommendations,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Wizard Step 1: Create basic product
 */
export async function createProductStep1(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const data = req.body

    const result = await productWizardService.createProductStep1(venueId, data)

    res.status(201).json({
      success: true,
      message: result.message,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Wizard Step 2: Configure inventory type
 */
export async function configureInventoryStep2(req: Request, res: Response, next: NextFunction) {
  try {
    const { productId } = req.params
    const data = req.body

    const result = await productWizardService.configureInventoryStep2(productId, data)

    res.json({
      success: true,
      message: result.message,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Wizard Step 3A: Setup simple stock (for retail/jewelry)
 */
export async function setupSimpleStockStep3(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId } = req.params
    const data = req.body

    const result = await productWizardService.setupSimpleStockStep3(venueId, productId, data)

    res.json({
      success: true,
      message: result.message,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Wizard Step 3B: Setup recipe (for restaurants)
 */
export async function setupRecipeStep3(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId } = req.params
    const data = req.body

    const result = await productWizardService.setupRecipeStep3(venueId, productId, data)

    res.json({
      success: true,
      message: result.message,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get wizard progress for a product
 */
export async function getWizardProgress(req: Request, res: Response, next: NextFunction) {
  try {
    const { productId } = req.params

    const progress = await productWizardService.getWizardProgress(productId)

    res.json({
      success: true,
      data: progress,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * All-in-one: Create product with inventory in single call
 */
export async function createProductWithInventory(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const data = req.body

    const result = await productWizardService.createProductWithInventory(venueId, data)

    res.status(201).json({
      success: true,
      message: result.message,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get product inventory status
 */
export async function getProductInventoryStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, productId } = req.params

    const status = await productInventoryService.getProductInventoryStatus(venueId, productId)

    res.json({
      success: true,
      data: status,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get product inventory type
 */
export async function getProductInventoryType(req: Request, res: Response, next: NextFunction) {
  try {
    const { productId } = req.params

    const inventoryType = await productInventoryService.getProductInventoryType(productId)

    res.json({
      success: true,
      data: { inventoryType },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Set product inventory type
 */
export async function setProductInventoryType(req: Request, res: Response, next: NextFunction) {
  try {
    const { productId } = req.params
    const { inventoryType } = req.body

    const result = await productInventoryService.setProductInventoryType(productId, inventoryType)

    res.json({
      success: true,
      message: result.message,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Preview cost change impact (what-if analysis)
 */
export async function previewCostChange(req: Request, res: Response, next: NextFunction) {
  try {
    const { rawMaterialId } = req.params
    const { proposedNewCost } = req.query

    if (!proposedNewCost) {
      return res.status(400).json({
        success: false,
        error: 'proposedNewCost is required',
      })
    }

    const preview = await costRecalculationService.previewCostChange(rawMaterialId, Number(proposedNewCost))

    res.json({
      success: true,
      data: preview,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Trigger cost recalculation (called when costPerUnit changes)
 */
export async function triggerCostRecalculation(req: Request, res: Response, next: NextFunction) {
  try {
    const { rawMaterialId } = req.params
    const { oldCost, newCost } = req.body

    const result = await costRecalculationService.onRawMaterialCostChange(rawMaterialId, oldCost, newCost)

    res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get stale recipes (ingredients updated more recently than recipe)
 */
export async function getStaleRecipes(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const staleRecipes = await recipeRecalculationService.getStaleRecipes(venueId)

    res.json({
      success: true,
      data: staleRecipes,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Recalculate all stale recipes
 */
export async function recalculateStaleRecipes(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const result = await recipeRecalculationService.recalculateStaleRecipes(venueId)

    res.json({
      success: true,
      message: result.message,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Force recalculation of all recipes (maintenance)
 */
export async function recalculateAllRecipes(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const result = await recipeRecalculationService.recalculateAllRecipes(venueId)

    res.json({
      success: true,
      message: result.message,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get recipes with cost variances (poor margins)
 */
export async function getRecipeCostVariances(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { minVariancePercentage, sort } = req.query

    const result = await recipeRecalculationService.getRecipeCostVariances(venueId, {
      minVariancePercentage: minVariancePercentage ? Number(minVariancePercentage) : undefined,
      sort: sort as 'highest' | 'lowest' | 'alphabetical' | undefined,
    })

    res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Switch inventory type (auto-conversion)
 * Handles conversion between SIMPLE_STOCK ↔ RECIPE_BASED
 */
export async function switchInventoryType(req: Request, res: Response, next: NextFunction) {
  try {
    console.log('🔧 [DEBUG] Controller req.params:', req.params)
    console.log('🔧 [DEBUG] Controller req.body:', req.body)

    const { venueId, productId } = req.params
    const { inventoryType } = req.body

    if (!inventoryType) {
      return res.status(400).json({
        success: false,
        error: 'inventoryType is required (SIMPLE_STOCK or RECIPE_BASED)',
      })
    }

    const result = await productWizardService.switchInventoryType(venueId, productId, inventoryType)

    res.json({
      success: true,
      message: result.message,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}
