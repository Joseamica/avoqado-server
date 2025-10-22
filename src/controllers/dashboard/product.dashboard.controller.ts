import { Request, Response, NextFunction } from 'express'
import * as productService from '../../services/dashboard/product.dashboard.service'
import AppError from '../../errors/AppError'
import logger from '../../config/logger'

/**
 * Get all products for a venue
 */
export const getProductsHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { venueId } = req.params
    const { includeRecipe, categoryId, orderBy } = req.query
    const correlationId = (req as any).correlationId

    logger.info(`Fetching products for venue ${venueId}`, {
      correlationId,
      includeRecipe: includeRecipe === 'true',
      categoryId: categoryId || undefined,
      orderBy: orderBy || 'displayOrder',
    })

    const products = await productService.getProducts(venueId, {
      includeRecipe: includeRecipe === 'true',
      categoryId: categoryId as string | undefined,
      orderBy: (orderBy === 'name' ? 'name' : 'displayOrder') as 'name' | 'displayOrder',
    })

    res.status(200).json({
      message: `Products for venue ${venueId}`,
      data: products,
      correlationId,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get a single product by ID
 */
export const getProductHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { venueId, productId } = req.params
    const correlationId = (req as any).correlationId

    logger.info(`Fetching product ${productId} for venue ${venueId}`, { correlationId })

    const product = await productService.getProduct(venueId, productId)

    if (!product) {
      throw new AppError(`Product with ID ${productId} not found in venue ${venueId}`, 404)
    }

    res.status(200).json({
      message: `Product ${productId} details`,
      data: product,
      correlationId,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Create a new product
 */
export const createProductHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { venueId } = req.params
    const productData = req.body
    const correlationId = (req as any).correlationId

    logger.info(`Creating product in venue ${venueId}`, {
      correlationId,
      productName: productData.name,
      authContext: req.authContext,
    })

    const product = await productService.createProduct(venueId, productData)

    res.status(201).json({
      message: `Product '${product.name}' created successfully`,
      data: product,
      correlationId,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Update an existing product
 */
export const updateProductHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { venueId, productId } = req.params
    const productData = req.body
    const correlationId = (req as any).correlationId

    logger.info(`Updating product ${productId} in venue ${venueId}`, {
      correlationId,
      authContext: req.authContext,
    })

    const product = await productService.updateProduct(venueId, productId, productData)

    res.status(200).json({
      message: `Product '${product.name}' updated successfully`,
      data: product,
      correlationId,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Delete a product
 */
export const deleteProductHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { venueId, productId } = req.params
    const correlationId = (req as any).correlationId
    const userId = req.authContext?.userId

    if (!userId) {
      throw new AppError('User ID not found in authentication context', 401)
    }

    logger.info(`Deleting product ${productId} in venue ${venueId}`, {
      correlationId,
      authContext: req.authContext,
    })

    await productService.deleteProduct(venueId, productId, userId)

    res.status(200).json({
      message: `Product deleted successfully`,
      correlationId,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Reorder products
 */
export const reorderProductsHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { venueId } = req.params
    const reorderData = req.body
    const correlationId = (req as any).correlationId

    logger.info(`Reordering products in venue ${venueId}`, {
      correlationId,
      itemCount: reorderData.length,
    })

    await productService.reorderProducts(venueId, reorderData)

    res.status(200).json({
      message: 'Products reordered successfully',
      correlationId,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Assign a modifier group to a product
 */
export const assignModifierGroupToProductHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { venueId, productId } = req.params
    const assignmentData = req.body
    const correlationId = (req as any).correlationId

    logger.info(`Assigning modifier group to product ${productId} in venue ${venueId}`, {
      correlationId,
      modifierGroupId: assignmentData.modifierGroupId,
    })

    const assignment = await productService.assignModifierGroupToProduct(venueId, productId, assignmentData)

    res.status(201).json({
      message: 'Modifier group assigned to product successfully',
      data: assignment,
      correlationId,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Remove a modifier group from a product
 */
export const removeModifierGroupFromProductHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { venueId, productId, modifierGroupId } = req.params
    const correlationId = (req as any).correlationId

    logger.info(`Removing modifier group ${modifierGroupId} from product ${productId} in venue ${venueId}`, {
      correlationId,
    })

    await productService.removeModifierGroupFromProduct(venueId, productId, modifierGroupId)

    res.status(200).json({
      message: 'Modifier group removed from product successfully',
      correlationId,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Delete/clear the image from a product
 */
export const deleteProductImageHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { venueId, productId } = req.params
    const correlationId = (req as any).correlationId

    logger.info(`Removing image from product ${productId} in venue ${venueId}`, {
      correlationId,
      authContext: req.authContext,
    })

    const product = await productService.updateProduct(venueId, productId, { imageUrl: null })

    res.status(200).json({
      message: 'Product image removed successfully',
      data: product,
      correlationId,
    })
  } catch (error) {
    next(error)
  }
}
