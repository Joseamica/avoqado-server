// src/routes/products.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validation'; // Zod validation middleware
import { protectRoute } from '../security'; // Your security middleware
import { StaffRole } from '@prisma/client'; // Assuming StaffRole enum
import AppError from '../errors/AppError'; // For custom errors
import logger from '../config/logger'; // Winston logger

const router = Router({ mergeParams: true }); // IMPORTANT: mergeParams allows access to parent router params

// --- Zod Schemas for Product --- 
const createProductSchema = z.object({
  body: z.object({
    name: z.string().min(3, 'Product name must be at least 3 characters long'),
    price: z.number().positive('Price must be a positive number'),
    description: z.string().optional(),
    // Add other product fields as necessary
  }),
});

// --- Product Data (Mock - Replace with actual database logic) ---
interface Product {
  id: string;
  venueId: string; // To associate product with a venue
  name: string;
  price: number;
  description?: string;
}

let mockProducts: Product[] = [
  { id: 'prod_1', venueId: 'venue_123', name: 'Pizza Margherita', price: 12.99, description: 'Classic cheese and tomato pizza' },
  { id: 'prod_2', venueId: 'venue_123', name: 'Coca-Cola', price: 2.50 },
  { id: 'prod_3', venueId: 'venue_456', name: 'Espresso', price: 3.00 },
];

// --- Product Routes --- 

// GET /api/v1/venues/:venueId/products
// Get all products for a specific venue (Public or semi-public)
router.get('/', (req: Request, res: Response, next: NextFunction) => {
  const { venueId } = req.params; // Access venueId from parent router thanks to mergeParams
  logger.info(`Fetching products for venueId: ${venueId}`, { correlationId: req.correlationId });

  if (!venueId) {
    return next(new AppError('Venue ID is required to fetch products.', 400));
  }

  const venueProducts = mockProducts.filter(p => p.venueId === venueId);
  
  res.status(200).json({
    message: `Products for venue ${venueId}`,
    data: venueProducts,
    correlationId: req.correlationId
  });
});

// GET /api/v1/venues/:venueId/products/:productId
// Get a specific product by ID for a venue (Public or semi-public)
router.get('/:productId', (req: Request, res: Response, next: NextFunction) => {
  const { venueId, productId } = req.params;
  logger.info(`Fetching product ${productId} for venueId: ${venueId}`, { correlationId: req.correlationId });

  if (!venueId || !productId) {
    return next(new AppError('Venue ID and Product ID are required.', 400));
  }

  const product = mockProducts.find(p => p.venueId === venueId && p.id === productId);

  if (!product) {
    return next(new AppError(`Product with ID ${productId} not found for venue ${venueId}.`, 404));
  }

  res.status(200).json({
    message: `Details for product ${productId} in venue ${venueId}`,
    data: product,
    correlationId: req.correlationId
  });
});

// POST /api/v1/venues/:venueId/products
// Create a new product (Protected: Requires authentication and specific role)
router.post(
  '/',
  protectRoute([StaffRole.MANAGER, StaffRole.ADMIN]), // Protect: Only Managers or Admins can create
  validateRequest(createProductSchema), // Validate request body using Zod
  (req: Request, res: Response, next: NextFunction) => {
    const { venueId } = req.params;
    const { name, price, description } = req.body;
    // req.authContext would be available here if set by protectRoute
    logger.info(`User ${req.authContext?.userId} creating product in venue ${venueId}: ${name}`, { // Changed .sub to .userId 
      correlationId: req.correlationId, 
      authContext: req.authContext 
    });

    if (!venueId) {
      return next(new AppError('Venue ID is required to create a product.', 400));
    }

    const newProduct: Product = {
      id: `prod_${Date.now()}`,
      venueId: venueId as string,
      name,
      price,
      description,
    };
    mockProducts.push(newProduct);

    res.status(201).json({
      message: `Product '${name}' created successfully for venue ${venueId}.`,
      data: newProduct,
      correlationId: req.correlationId
    });
  }
);

export default router;
