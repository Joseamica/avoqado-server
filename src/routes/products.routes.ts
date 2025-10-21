// src/routes/products.routes.ts
import { Router, Request, Response, NextFunction } from 'express'
import { validateRequest } from '../middlewares/validation' // Zod validation middleware
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware'
import { checkPermission } from '../middlewares/checkPermission.middleware'
import AppError from '../errors/AppError' // For custom errors
import logger from '../config/logger' // Winston logger
import { CreateProductSchema, UpdateProductSchema, GetProductParamsSchema } from '@/schemas/dashboard/menu.schema'

const router = Router({ mergeParams: true }) // IMPORTANT: mergeParams allows access to parent router params

// --- Product Data (Mock - Replace with actual database logic) ---
interface Product {
  id: string
  venueId: string // To associate product with a venue
  name: string
  price: number
  description?: string
}

const mockProducts: Product[] = [
  { id: 'prod_1', venueId: 'venue_123', name: 'Pizza Margherita', price: 12.99, description: 'Classic cheese and tomato pizza' },
  { id: 'prod_2', venueId: 'venue_123', name: 'Coca-Cola', price: 2.5 },
  { id: 'prod_3', venueId: 'venue_456', name: 'Espresso', price: 3.0 },
]

// --- Product Routes ---

// GET /api/v1/venues/:venueId/products
// Get all products for a specific venue (Public or semi-public)
router.get('/', (req: Request, res: Response, next: NextFunction) => {
  const { venueId } = req.params // Access venueId from parent router thanks to mergeParams
  logger.info(`Fetching products for venueId: ${venueId}`, { correlationId: req.correlationId })

  if (!venueId) {
    return next(new AppError('Venue ID is required to fetch products.', 400))
  }

  const venueProducts = mockProducts.filter(p => p.venueId === venueId)

  res.status(200).json({
    message: `Products for venue ${venueId}`,
    data: venueProducts,
    correlationId: req.correlationId,
  })
})

// GET /api/v1/venues/:venueId/products/:productId
// Get a specific product by ID for a venue (Public or semi-public)
router.get('/:productId', (req: Request, res: Response, next: NextFunction) => {
  const { venueId, productId } = req.params
  logger.info(`Fetching product ${productId} for venueId: ${venueId}`, { correlationId: req.correlationId })

  if (!venueId || !productId) {
    return next(new AppError('Venue ID and Product ID are required.', 400))
  }

  const product = mockProducts.find(p => p.venueId === venueId && p.id === productId)

  if (!product) {
    return next(new AppError(`Product with ID ${productId} not found for venue ${venueId}.`, 404))
  }

  res.status(200).json({
    message: `Details for product ${productId} in venue ${venueId}`,
    data: product,
    correlationId: req.correlationId,
  })
})

// POST /api/v1/venues/:venueId/products
// Create a new product (Protected: Requires authentication and specific role)
router.post(
  '/',
  authenticateTokenMiddleware,
  checkPermission('menu:create'), // Requires menu create permission
  validateRequest(CreateProductSchema), // Validate request body using Zod
  (req: Request, res: Response, next: NextFunction) => {
    const { venueId } = req.params
    const { name, price, description } = req.body
    // req.authContext is populated by authenticateTokenMiddleware
    logger.info(`User ${req.authContext?.userId} creating product in venue ${venueId}: ${name}`, {
      // Changed .sub to .userId
      correlationId: req.correlationId,
      authContext: req.authContext,
    })

    if (!venueId) {
      return next(new AppError('Venue ID is required to create a product.', 400))
    }

    const newProduct: Product = {
      id: `prod_${Date.now()}`,
      venueId: venueId as string,
      name,
      price,
      description,
    }
    mockProducts.push(newProduct)

    res.status(201).json({
      message: `Product '${name}' created successfully for venue ${venueId}.`,
      data: newProduct,
      correlationId: req.correlationId,
    })
  },
)

// PUT /api/v1/venues/:venueId/products/:productId
// Update an existing product (Protected)
router.put(
  '/:productId',
  authenticateTokenMiddleware,
  checkPermission('menu:update'),
  validateRequest(UpdateProductSchema),
  (req: Request, res: Response, next: NextFunction) => {
    const { venueId, productId } = req.params
    const updates = req.body
    logger.info(`User ${req.authContext?.userId} updating product ${productId} in venue ${venueId}`, {
      correlationId: req.correlationId,
      authContext: req.authContext,
    })

    if (!venueId || !productId) {
      return next(new AppError('Venue ID and Product ID are required to update a product.', 400))
    }

    const index = mockProducts.findIndex(p => p.venueId === venueId && p.id === productId)
    if (index === -1) {
      return next(new AppError(`Product with ID ${productId} not found for venue ${venueId}.`, 404))
    }

    const updatedProduct = { ...mockProducts[index], ...updates }
    mockProducts[index] = updatedProduct

    res.status(200).json({
      message: `Product '${updatedProduct.name}' updated successfully for venue ${venueId}.`,
      data: updatedProduct,
      correlationId: req.correlationId,
    })
  },
)

// DELETE /api/v1/venues/:venueId/products/:productId
// Delete a product (Protected)
router.delete(
  '/:productId',
  authenticateTokenMiddleware,
  checkPermission('menu:delete'),
  validateRequest(GetProductParamsSchema),
  (req: Request, res: Response, next: NextFunction) => {
    const { venueId, productId } = req.params
    logger.info(`User ${req.authContext?.userId} deleting product ${productId} in venue ${venueId}`, {
      correlationId: req.correlationId,
      authContext: req.authContext,
    })

    if (!venueId || !productId) {
      return next(new AppError('Venue ID and Product ID are required to delete a product.', 400))
    }

    const index = mockProducts.findIndex(p => p.venueId === venueId && p.id === productId)
    if (index === -1) {
      return next(new AppError(`Product with ID ${productId} not found for venue ${venueId}.`, 404))
    }

    const [removed] = mockProducts.splice(index, 1)

    res.status(200).json({
      message: `Product '${removed.name}' deleted successfully for venue ${venueId}.`,
      data: removed,
      correlationId: req.correlationId,
    })
  },
)

export default router
