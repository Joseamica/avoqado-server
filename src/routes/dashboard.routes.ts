import express, { RequestHandler } from 'express'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware' // Verifica esta ruta
import { authorizeRole } from '../middlewares/authorizeRole.middleware' // Verifica esta ruta
import { validateRequest } from '../middlewares/validation' // Verifica esta ruta

// Importa StaffRole desde @prisma/client si ahí es donde está definido tu enum de Prisma
// o desde donde lo hayas exportado como enum de TS (si es una copia manual)
import { StaffRole } from '@prisma/client' // O '../security' si StaffRole está definido ahí como un enum de TS manualmente

// Importa el SCHEMA de Zod, no el tipo DTO, para el middleware de validación
import { createVenueSchema, listVenuesQuerySchema } from '../schemas/dashboard/venue.schema'
import * as venueController from '../controllers/dashboard/venue.dashboard.controller'
import * as menuController from '../controllers/dashboard/menu.dashboard.controller'
import * as authDashboardController from '../controllers/dashboard/auth.dashboard.controller'
import * as reviewController from '../controllers/dashboard/review.dashboard.controller'
import * as paymentController from '../controllers/dashboard/payment.dashboard.controller'
import * as orderController from '../controllers/dashboard/order.dashboard.controller'
import * as tpvController from '../controllers/dashboard/tpv.dashboard.controller'
import {
  CreateMenuCategorySchema,
  UpdateMenuCategorySchema,
  GetMenuCategoryParamsSchema, // For GET one, DELETE
  VenueIdParamsSchema, // For listing all under a venue or POST to a venue
  ReorderMenuCategoriesSchema,
} from '../schemas/dashboard/menuCategory.schema'
import { loginSchema, switchVenueSchema } from '../schemas/dashboard/auth.schema'

const router = express.Router()

/**
 * @openapi
 * components:
 *   schemas:
 *     Venue:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: cuid
 *         name:
 *           type: string
 *         slug:
 *           type: string
 *         type:
 *           type: string
 *           enum: [RESTAURANT, BAR, CAFE, FOOD_TRUCK, OTHER]
 *         address:
 *           type: string
 *         city:
 *           type: string
 *         country:
 *           type: string
 *         phone:
 *           type: string
 *         email:
 *           type: string
 *           format: email
 *     MenuCategory:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: cuid
 *         name:
 *           type: string
 *         description:
 *           type: string
 *         displayOrder:
 *           type: integer
 *         active:
 *           type: boolean
 *     Payment:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: cuid
 *         amount:
 *           type: number
 *           format: float
 *         status:
 *           type: string
 *           enum: [PENDING, COMPLETED, FAILED]
 *         createdAt:
 *           type: string
 *           format: date-time
 *     Review:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: cuid
 *         rating:
 *           type: integer
 *           minimum: 1
 *           maximum: 5
 *         comment:
 *           type: string
 *         createdAt:
 *           type: string
 *           format: date-time
 *     LoginRequest:
 *       type: object
 *       required:
 *         - email
 *         - password
 *       properties:
 *         email:
 *           type: string
 *           format: email
 *           example: admin@example.com
 *         password:
 *           type: string
 *           format: password
 *           example: securePassword123
 *     AuthStatusResponse:
 *       type: object
 *       properties:
 *         isAuthenticated:
 *           type: boolean
 *         user:
 *           $ref: '#/components/schemas/User'
 *         currentVenue:
 *           $ref: '#/components/schemas/Venue'
 *         allVenues:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/Venue'
 *     SwitchVenueRequest:
 *       type: object
 *       required:
 *         - venueId
 *       properties:
 *         venueId:
 *           type: string
 *           format: uuid
 *           example: 123e4567-e89b-12d3-a456-426614174000
 *     ErrorResponse:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *         message:
 *           type: string
 *   securitySchemes:
 *     bearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 */

// --- Authentication Routes ---
/**
 * @openapi
 * /api/v1/dashboard/auth/status:
 *   get:
 *     tags: [Authentication]
 *     summary: Get current authentication status
 *     description: Returns the current authentication status and user information
 *     responses:
 *       200:
 *         description: Authentication status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthStatusResponse'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get(
  '/auth/status',
  // authenticateTokenMiddleware, // Controller handles token presence internally for flexibility
  authDashboardController.getAuthStatus,
)

/**
 * @openapi
 * /api/v1/dashboard/auth/login:
 *   post:
 *     tags: [Authentication]
 *     summary: Authenticate user and get JWT token
 *     description: Authenticates a user with email and password, returns a JWT token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *     responses:
 *       200:
 *         description: Successfully authenticated
 *         headers:
 *           Set-Cookie:
 *             schema:
 *               type: string
 *               example: token=abc123; Path=/; HttpOnly; SameSite=Strict
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthStatusResponse'
 *       400:
 *         description: Invalid input
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post(
  '/auth/login',
  validateRequest(loginSchema), // Validate login request body
  authDashboardController.dashboardLoginController,
)

/**
 * @openapi
 * /api/v1/dashboard/auth/logout:
 *   post:
 *     tags: [Authentication]
 *     summary: Log out the current user
 *     description: Clears the authentication cookie and logs out the user
 *     responses:
 *       200:
 *         description: Successfully logged out
 *         headers:
 *           Set-Cookie:
 *             schema:
 *               type: string
 *               example: token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Successfully logged out
 */
router.post(
  '/auth/logout',
  // authenticateTokenMiddleware, // Logout can be called even if token is expired/invalid to clear cookies
  authDashboardController.dashboardLogoutController,
)

/**
 * @openapi
 * /api/v1/dashboard/auth/switch-venue:
 *   post:
 *     tags: [Authentication]
 *     summary: Switch the current venue context
 *     description: Changes the currently active venue for the authenticated user
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SwitchVenueRequest'
 *     responses:
 *       200:
 *         description: Venue switched successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthStatusResponse'
 *       400:
 *         description: Invalid input or not authorized for venue
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Venue not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post(
  '/auth/switch-venue',
  authenticateTokenMiddleware, // Requires a valid token to know who the user is
  validateRequest(switchVenueSchema), // Validate the request body (changed from validateRequestMiddleware)
  authDashboardController.switchVenueController,
)

// --- Menu Category Routes ---

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/menucategories:
 *   get:
 *     tags: [Menu Categories]
 *     summary: List all menu categories for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *     responses:
 *       200:
 *         description: A list of menu categories.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/MenuCategory'
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/menucategories',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.WAITER]),
  validateRequest(VenueIdParamsSchema), // Validate venueId from params
  menuController.listMenuCategoriesHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/menucategories:
 *   post:
 *     tags: [Menu Categories]
 *     summary: Create a new menu category
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, example: 'Appetizers' }
 *               description: { type: string, example: 'Starters and small plates' }
 *     responses:
 *       201:
 *         description: The created menu category.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MenuCategory'
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/menucategories',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(CreateMenuCategorySchema),
  menuController.createMenuCategoryHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/menucategories/reorder:
 *   post:
 *     tags: [Menu Categories]
 *     summary: Reorder menu categories
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               type: object
 *               properties:
 *                 id: { type: string, format: cuid }
 *                 displayOrder: { type: integer }
 *     responses:
 *       200:
 *         description: Categories reordered successfully.
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/menucategories/reorder',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(ReorderMenuCategoriesSchema),
  menuController.reorderMenuCategoriesHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/menucategories/{categoryId}:
 *   get:
 *     tags: [Menu Categories]
 *     summary: Get a single menu category by ID
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: categoryId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: The requested menu category.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MenuCategory'
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.get(
  '/venues/:venueId/menucategories/:categoryId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.WAITER]),
  validateRequest(GetMenuCategoryParamsSchema),
  menuController.getMenuCategoryHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/menucategories/{categoryId}:
 *   patch:
 *     tags: [Menu Categories]
 *     summary: Update a menu category
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: categoryId, in: path, required: true, schema: { type: string, format: cuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/MenuCategory' # Simplified for example
 *     responses:
 *       200:
 *         description: The updated menu category.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MenuCategory'
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.patch(
  '/venues/:venueId/menucategories/:categoryId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(UpdateMenuCategorySchema),
  menuController.updateMenuCategoryHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/menucategories/{categoryId}:
 *   delete:
 *     tags: [Menu Categories]
 *     summary: Delete a menu category
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: categoryId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       204:
 *         description: Category deleted successfully.
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.delete(
  '/venues/:venueId/menucategories/:categoryId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(GetMenuCategoryParamsSchema),
  menuController.deleteMenuCategoryHandler,
)

// router.get('/venues/:venueId/menus', getMenusHandler) // This seems to be a duplicate or old route
router.get(
  '/venues/:venueId/menus',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  menuController.getMenusHandler,
)
router.post(
  '/venues/:venueId/menucategories',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(CreateMenuCategorySchema),
  menuController.createMenuCategoryHandler,
)

router.get(
  '/venues/:venueId/menucategories',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.WAITER]),
  validateRequest(VenueIdParamsSchema), // Validate venueId from params
  menuController.listMenuCategoriesHandler,
)

router.post(
  '/venues/:venueId/menucategories/reorder',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(ReorderMenuCategoriesSchema),
  menuController.reorderMenuCategoriesHandler,
)

router.get(
  '/venues/:venueId/menucategories/:categoryId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.WAITER]),
  validateRequest(GetMenuCategoryParamsSchema),
  menuController.getMenuCategoryHandler,
)

router.patch(
  '/venues/:venueId/menucategories/:categoryId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(UpdateMenuCategorySchema),
  menuController.updateMenuCategoryHandler,
)

router.delete(
  '/venues/:venueId/menucategories/:categoryId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(GetMenuCategoryParamsSchema),
  menuController.deleteMenuCategoryHandler,
)

// router.get('/venues/:venueId/basic-metrics', getBasicMetrics)
// router.get('/venues/:venueId/products', getProductsData)
// router.get('/venues/:venueId/analytics', getAnalyticsData)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/reviews:
 *   get:
 *     tags: [Reviews]
 *     summary: Get reviews data for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: fromDate, in: query, required: false, schema: { type: string, format: date } }
 *       - { name: toDate, in: query, required: false, schema: { type: string, format: date } }
 *     responses:
 *       200:
 *         description: A list of reviews.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Review'
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/reviews',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.SUPERADMIN, StaffRole.ADMIN, StaffRole.MANAGER]),
  reviewController.getReviewsData,
)

// Rutas de Venue para el Dashboard
/**
 * @openapi
 * /api/v1/dashboard/venues:
 *   post:
 *     tags: [Venues]
 *     summary: Create a new venue
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Venue' # Simplified for example
 *     responses:
 *       201:
 *         description: The created venue.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Venue'
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN]),
  validateRequest(createVenueSchema), // Pasas el schema de Zod
  venueController.createVenue, // Llamas al método del controlador
)

/**
 * @openapi
 * /api/v1/dashboard/venues:
 *   get:
 *     tags: [Venues]
 *     summary: List all venues for the organization
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: page, in: query, schema: { type: integer, default: 1 } }
 *       - { name: limit, in: query, schema: { type: integer, default: 10 } }
 *       - { name: search, in: query, schema: { type: string } }
 *     responses:
 *       200:
 *         description: A list of venues.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Venue'
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(listVenuesQuerySchema), // Validar query params
  venueController.listVenues as unknown as RequestHandler, // Type assertion for controller
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}:
 *   get:
 *     tags: [Venues]
 *     summary: Get a single venue by ID
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: The requested venue.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Venue'
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.get(
  '/venues/:venueId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  venueController.getVenueById,
)
//Rutas de Payment para el Dashboard
/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/payments:
 *   get:
 *     tags: [Payments]
 *     summary: Get payments data for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: page, in: query, schema: { type: integer, default: 1 } }
 *       - { name: limit, in: query, schema: { type: integer, default: 10 } }
 *     responses:
 *       200:
 *         description: A list of payments.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Payment'
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/payments',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.SUPERADMIN, StaffRole.ADMIN, StaffRole.MANAGER]),
  paymentController.getPaymentsData,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/orders:
 *   get:
 *     tags: [Orders]
 *     summary: Get orders data for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: page, in: query, schema: { type: integer, default: 1 } }
 *       - { name: limit, in: query, schema: { type: integer, default: 10 } }
 *     responses:
 *       200:
 *         description: A list of orders.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Order'
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/orders', // Nueva ruta semántica
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.SUPERADMIN, StaffRole.ADMIN, StaffRole.MANAGER]),
  orderController.getOrdersData, // Apunta al nuevo controlador
)

router.get(
  '/venues/:venueId/orders/:orderId', // Nueva ruta semántica
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.SUPERADMIN, StaffRole.ADMIN, StaffRole.MANAGER]),
  orderController.getOrder, // Apunta al nuevo controlador
)

router.put(
  '/venues/:venueId/orders/:orderId', // Nueva ruta semántica
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.SUPERADMIN, StaffRole.ADMIN, StaffRole.MANAGER]),
  orderController.updateOrder, // Apunta al nuevo controlador
)

router.delete(
  '/venues/:venueId/orders/:orderId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.SUPERADMIN, StaffRole.ADMIN, StaffRole.MANAGER]),
  orderController.deleteOrder,
)
router.get(
  '/venues/:venueId/payments/:paymentId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.SUPERADMIN, StaffRole.ADMIN, StaffRole.MANAGER]),
  paymentController.getPayment,
)
/**
 * @openapi
 * /api/v1/dashboard/payments/{paymentId}/send-receipt:
 *   post:
 *     tags: [Receipts]
 *     summary: Generate and send a digital receipt for a payment
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: paymentId, in: path, required: true, schema: { type: string, format: cuid } }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               recipientEmail:
 *                 type: string
 *                 format: email
 *     responses:
 *       201:
 *         description: Receipt created successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404:
 *         description: Payment not found
 */
router.post(
  '/venues/:venueId/payments/:paymentId/send-receipt',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.SUPERADMIN, StaffRole.ADMIN, StaffRole.MANAGER]),
  paymentController.sendPaymentReceipt,
)

router.get(
  '/venues/:venueId/payments/:paymentId/receipts',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.SUPERADMIN, StaffRole.ADMIN, StaffRole.MANAGER]),
  paymentController.getPaymentReceipts,
)

/**
 * @openapi
 * /api/v1/dashboard/receipts/{receiptId}:
 *   get:
 *     tags: [Receipts]
 *     summary: Get a digital receipt by ID
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: receiptId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: Digital receipt data
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404:
 *         description: Receipt not found
 */
router.get(
  '/venues/:venueId/receipts/:receiptId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.SUPERADMIN, StaffRole.ADMIN, StaffRole.MANAGER]),
  paymentController.getReceiptById,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpvs:
 *   get:
 *     tags: [Terminals]
 *     summary: List all terminals (TPVs) for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: page, in: query, schema: { type: integer, default: 1 } }
 *       - { name: pageSize, in: query, schema: { type: integer, default: 10 } }
 *       - { name: status, in: query, schema: { type: string, enum: [ACTIVE, INACTIVE] } }
 *       - { name: type, in: query, schema: { type: string, enum: [TPV_ANDROID, TPV_IOS, PRINTER_RECEIPT, PRINTER_KITCHEN, KDS]  } }
 *     responses:
 *       200:
 *         description: A paginated list of terminals.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Terminal'
 *                 meta:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     pageSize:
 *                       type: integer
 *                     pageCount:
 *                       type: integer
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/tpvs',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.SUPERADMIN, StaffRole.ADMIN, StaffRole.MANAGER]),
  tpvController.getTerminals,
)

export default router
