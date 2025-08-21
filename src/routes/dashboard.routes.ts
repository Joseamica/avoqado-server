import express, { RequestHandler } from 'express'
import { z } from 'zod'
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
import * as googleOAuthController from '../controllers/dashboard/googleOAuth.controller'
import * as reviewController from '../controllers/dashboard/review.dashboard.controller'
import * as paymentController from '../controllers/dashboard/payment.dashboard.controller'
import * as orderController from '../controllers/dashboard/order.dashboard.controller'
import * as tpvController from '../controllers/dashboard/tpv.dashboard.controller'
import * as generalStatsController from '../controllers/dashboard/generalStats.dashboard.controller'
import * as productController from '../controllers/dashboard/product.dashboard.controller'
import * as shiftController from '../controllers/dashboard/shift.dashboard.controller'
import * as teamController from '../controllers/dashboard/team.dashboard.controller'
import * as notificationController from '../controllers/dashboard/notification.dashboard.controller'
import superadminRoutes from './dashboard/superadmin.routes'
import {
  CreateMenuCategorySchema,
  UpdateMenuCategorySchema,
  GetMenuCategoryParamsSchema, // For GET one, DELETE
  VenueIdParamsSchema, // For listing all under a venue or POST to a venue
  ReorderMenuCategoriesSchema,
} from '../schemas/dashboard/menuCategory.schema'
import {
  // Menu schemas
  CreateMenuSchema,
  UpdateMenuSchema,
  GetMenuParamsSchema,
  CloneMenuSchema,
  MenuQuerySchema,
  ReorderMenusSchema,
  // Product schemas
  CreateProductSchema,
  UpdateProductSchema,
  GetProductParamsSchema,
  ProductQuerySchema,
  BulkUpdateProductsSchema,
  // Modifier schemas
  CreateModifierGroupSchema,
  UpdateModifierGroupSchema,
  GetModifierGroupParamsSchema,
  ModifierGroupQuerySchema,
  CreateModifierSchema,
  UpdateModifierSchema,
  GetModifierParamsSchema,
  // Assignment schemas
  AssignCategoryToMenuSchema,
  AssignModifierGroupToProductSchema,
  RemoveModifierGroupFromProductParamsSchema,
  ReorderProductsSchema,
} from '../schemas/dashboard/menu.schema'
import { loginSchema, switchVenueSchema } from '../schemas/dashboard/auth.schema'
import { GeneralStatsQuerySchema } from '../schemas/dashboard/generalStats.schema'
import {
  VenueIdParamsSchema as TeamVenueIdParamsSchema,
  TeamMemberParamsSchema,
  InvitationParamsSchema,
  TeamMembersQuerySchema,
  InviteTeamMemberSchema,
  UpdateTeamMemberSchema,
} from '../schemas/dashboard/team.schema'

const router = express.Router()

// Superadmin routes - highest priority
router.use('/superadmin', superadminRoutes)

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
 *     Modifier:
 *       type: object
 *       properties:
 *         id: { type: string, format: cuid }
 *         groupId: { type: string, format: cuid }
 *         name: { type: string }
 *         price: { type: number, format: float }
 *         active: { type: boolean }
 *     ModifierGroup:
 *       type: object
 *       properties:
 *         id: { type: string, format: cuid }
 *         venueId: { type: string, format: cuid }
 *         name: { type: string }
 *         description: { type: string, nullable: true }
 *         required: { type: boolean }
 *         allowMultiple: { type: boolean }
 *         minSelections: { type: integer, minimum: 0 }
 *         maxSelections: { type: integer, minimum: 1, nullable: true }
 *         displayOrder: { type: integer, minimum: 0 }
 *         active: { type: boolean }
 *         createdAt: { type: string, format: date-time }
 *         updatedAt: { type: string, format: date-time }
 *         modifiers:
 *           type: array
 *           items: { $ref: '#/components/schemas/Modifier' }
 *     ProductModifierGroupAssignment:
 *       type: object
 *       properties:
 *         id: { type: string, format: cuid }
 *         productId: { type: string, format: cuid }
 *         groupId: { type: string, format: cuid }
 *         displayOrder: { type: integer, minimum: 0 }
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

// --- Google OAuth Routes ---
/**
 * @openapi
 * /api/v1/dashboard/auth/google/url:
 *   get:
 *     tags: [Authentication]
 *     summary: Get Google OAuth authorization URL
 *     description: Returns the Google OAuth URL for client-side redirection
 *     responses:
 *       200:
 *         description: Google OAuth URL retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 authUrl:
 *                   type: string
 */
router.get('/auth/google/url', googleOAuthController.getGoogleAuthUrl)

/**
 * @openapi
 * /api/v1/dashboard/auth/google/callback:
 *   post:
 *     tags: [Authentication]
 *     summary: Handle Google OAuth callback
 *     description: Process Google OAuth authorization code or ID token to authenticate user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               code:
 *                 type: string
 *                 description: Google OAuth authorization code
 *               token:
 *                 type: string
 *                 description: Google ID token (alternative to code)
 *     responses:
 *       200:
 *         description: Successfully authenticated with Google
 *         headers:
 *           Set-Cookie:
 *             schema:
 *               type: string
 *               example: accessToken=abc123; Path=/; HttpOnly; SameSite=Strict
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 user:
 *                   type: object
 *                 isNewUser:
 *                   type: boolean
 *       400:
 *         description: Invalid request or missing parameters
 *       403:
 *         description: No invitation found for this email
 *       401:
 *         description: Authentication failed
 */
router.post('/auth/google/callback', googleOAuthController.googleOAuthCallback)

/**
 * @openapi
 * /api/v1/dashboard/auth/google/check-invitation:
 *   get:
 *     tags: [Authentication]
 *     summary: Check if email has pending invitation
 *     description: Checks if the provided email has a pending team invitation
 *     parameters:
 *       - name: email
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *           format: email
 *     responses:
 *       200:
 *         description: Invitation status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 hasInvitation:
 *                   type: boolean
 *                 venue:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     name:
 *                       type: string
 *                     slug:
 *                       type: string
 *                 role:
 *                   type: string
 *                   enum: [ADMIN, MANAGER, WAITER, CASHIER]
 */
router.get('/auth/google/check-invitation', googleOAuthController.checkInvitation)

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

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}:
 *   put:
 *     tags: [Venues]
 *     summary: Update a venue by ID
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateVenue'
 *     responses:
 *       200:
 *         description: Venue updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Venue'
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.put(
  '/venues/:venueId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  venueController.updateVenue,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}:
 *   delete:
 *     tags: [Venues]
 *     summary: Delete a venue by ID
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Venue deleted successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.delete(
  '/venues/:venueId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  venueController.deleteVenue,
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

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/general-stats:
 *   get:
 *     tags: [Dashboard Analytics]
 *     summary: Get general statistics for venue dashboard
 *     description: Aggregated endpoint that provides payments, reviews, products, and metrics data for the dashboard home page
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: fromDate, in: query, schema: { type: string, format: date-time }, description: "Start date for data filtering (ISO 8601)" }
 *       - { name: toDate, in: query, schema: { type: string, format: date-time }, description: "End date for data filtering (ISO 8601)" }
 *     responses:
 *       200:
 *         description: General statistics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 payments:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       amount: { type: number }
 *                       method: { type: string }
 *                       createdAt: { type: string, format: date-time }
 *                       tips:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             amount: { type: number }
 *                 reviews:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       stars: { type: integer, minimum: 1, maximum: 5 }
 *                       createdAt: { type: string, format: date-time }
 *                 products:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       name: { type: string }
 *                       type: { type: string }
 *                       quantity: { type: number }
 *                       price: { type: number }
 *                 extraMetrics:
 *                   type: object
 *                   properties:
 *                     tablePerformance: { type: array }
 *                     staffPerformanceMetrics: { type: array }
 *                     productProfitability: { type: array }
 *                     peakHoursData: { type: array }
 *                     weeklyTrendsData: { type: array }
 *                     prepTimesByCategory: { type: object }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { description: "Venue not found" }
 */
router.get(
  '/venues/:venueId/general-stats',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.SUPERADMIN, StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(z.object({ query: GeneralStatsQuerySchema })),
  generalStatsController.getGeneralStats,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/basic-metrics:
 *   get:
 *     tags: [Dashboard Analytics]
 *     summary: Get basic metrics for venue dashboard (priority load)
 *     description: Returns essential metrics for initial dashboard load including sales, reviews, and payment methods
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: fromDate
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: toDate
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Basic metrics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 payments: { type: array }
 *                 reviews: { type: array }
 *                 paymentMethodsData: { type: array }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { description: "Venue not found" }
 */
router.get(
  '/venues/:venueId/basic-metrics',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.SUPERADMIN, StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(z.object({ query: GeneralStatsQuerySchema })),
  generalStatsController.getBasicMetrics,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/charts/{chartType}:
 *   get:
 *     tags: [Dashboard Analytics]
 *     summary: Get specific chart data for progressive loading
 *     description: Returns data for a specific chart type to enable progressive loading
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: chartType
 *         required: true
 *         schema:
 *           type: string
 *           enum: [best-selling-products, tips-over-time, sales-by-payment-method, peak-hours, weekly-trends]
 *       - in: query
 *         name: fromDate
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: toDate
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Chart data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { description: "Venue or chart type not found" }
 */
router.get(
  '/venues/:venueId/charts/:chartType',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.SUPERADMIN, StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(z.object({ query: GeneralStatsQuerySchema })),
  generalStatsController.getChartData,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/metrics/{metricType}:
 *   get:
 *     tags: [Dashboard Analytics]
 *     summary: Get extended metrics data for progressive loading
 *     description: Returns extended metrics for a specific type to enable progressive loading
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: metricType
 *         required: true
 *         schema:
 *           type: string
 *           enum: [table-performance, product-profitability, staff-performance, prep-times]
 *       - in: query
 *         name: fromDate
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: toDate
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Extended metrics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { description: "Venue or metric type not found" }
 */
router.get(
  '/venues/:venueId/metrics/:metricType',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.SUPERADMIN, StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(z.object({ query: GeneralStatsQuerySchema })),
  generalStatsController.getExtendedMetrics,
)

// ==========================================
// MENU SYSTEM ROUTES
// ==========================================

// --- Menu Routes ---
router.get(
  '/venues/:venueId/menus',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(MenuQuerySchema),
  menuController.getMenusHandler,
)

router.post(
  '/venues/:venueId/menus',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(CreateMenuSchema),
  menuController.createMenuHandler,
)

router.get(
  '/venues/:venueId/menus/:menuId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.WAITER]),
  validateRequest(GetMenuParamsSchema),
  menuController.getMenuHandler,
)

router.patch(
  '/venues/:venueId/menus/:menuId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(UpdateMenuSchema),
  menuController.updateMenuHandler,
)

router.delete(
  '/venues/:venueId/menus/:menuId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(GetMenuParamsSchema),
  menuController.deleteMenuHandler,
)

router.post(
  '/venues/:venueId/menus/:menuId/clone',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(CloneMenuSchema),
  menuController.cloneMenuHandler,
)

router.post(
  '/venues/:venueId/menus/reorder',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(ReorderMenusSchema),
  menuController.reorderMenusHandler,
)

router.put(
  '/venues/:venueId/products/reorder',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(ReorderProductsSchema),
  menuController.reorderProductsHandler,
)

// Menu-Category assignments
router.post(
  '/venues/:venueId/menus/:menuId/categories',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(AssignCategoryToMenuSchema),
  menuController.assignCategoryToMenuHandler,
)

router.delete(
  '/venues/:venueId/menus/:menuId/categories/:categoryId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(GetMenuParamsSchema),
  menuController.removeCategoryFromMenuHandler,
)

// --- Modifier Groups Routes ---

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/modifier-groups:
 *   get:
 *     tags: [Modifier Groups]
 *     summary: List all modifier groups for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string, format: cuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: active
 *         schema: { type: boolean }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [name, displayOrder, createdAt, updatedAt] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [asc, desc] }
 *     responses:
 *       200:
 *         description: A list of modifier groups
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/ModifierGroup' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/modifier-groups',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.WAITER]),
  validateRequest(ModifierGroupQuerySchema),
  menuController.listModifierGroupsHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/modifier-groups:
 *   post:
 *     tags: [Modifier Groups]
 *     summary: Create a new modifier group
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ModifierGroup'
 *     responses:
 *       201:
 *         description: The created modifier group
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ModifierGroup'
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/modifier-groups',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(CreateModifierGroupSchema),
  menuController.createModifierGroupHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/modifier-groups/{modifierGroupId}:
 *   get:
 *     tags: [Modifier Groups]
 *     summary: Get a modifier group by ID
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: modifierGroupId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: The requested modifier group
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ModifierGroup'
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.get(
  '/venues/:venueId/modifier-groups/:modifierGroupId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.WAITER]),
  validateRequest(GetModifierGroupParamsSchema),
  menuController.getModifierGroupHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/modifier-groups/{modifierGroupId}:
 *   patch:
 *     tags: [Modifier Groups]
 *     summary: Update a modifier group
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: modifierGroupId, in: path, required: true, schema: { type: string, format: cuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ModifierGroup' # Simplified for example
 *     responses:
 *       200:
 *         description: The updated modifier group
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ModifierGroup'
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.patch(
  '/venues/:venueId/modifier-groups/:modifierGroupId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(UpdateModifierGroupSchema),
  menuController.updateModifierGroupHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/modifier-groups/{modifierGroupId}:
 *   put:
 *     tags: [Modifier Groups]
 *     summary: Update a modifier group
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: modifierGroupId, in: path, required: true, schema: { type: string, format: cuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ModifierGroup'
 *     responses:
 *       200:
 *         description: The updated modifier group
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ModifierGroup'
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.put(
  '/venues/:venueId/modifier-groups/:modifierGroupId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(UpdateModifierGroupSchema),
  menuController.updateModifierGroupHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/modifier-groups/{modifierGroupId}:
 *   delete:
 *     tags: [Modifier Groups]
 *     summary: Delete a modifier group
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: modifierGroupId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       204:
 *         description: Modifier group deleted successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.delete(
  '/venues/:venueId/modifier-groups/:modifierGroupId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(GetModifierGroupParamsSchema),
  menuController.deleteModifierGroupHandler,
)

// --- Modifiers Routes ---

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/modifier-groups/{modifierGroupId}/modifiers:
 *   get:
 *     tags: [Modifiers]
 *     summary: List modifiers in a modifier group
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: modifierGroupId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: A list of modifiers for the group
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Modifier'
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.get(
  '/venues/:venueId/modifier-groups/:modifierGroupId/modifiers',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.WAITER]),
  validateRequest(GetModifierGroupParamsSchema),
  menuController.listModifiersHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/modifier-groups/{modifierGroupId}/modifiers:
 *   post:
 *     tags: [Modifiers]
 *     summary: Create a modifier within a group
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: modifierGroupId, in: path, required: true, schema: { type: string, format: cuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Modifier'
 *     responses:
 *       201:
 *         description: The created modifier
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Modifier'
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.post(
  '/venues/:venueId/modifier-groups/:modifierGroupId/modifiers',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(CreateModifierSchema),
  menuController.createModifierHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/modifier-groups/{modifierGroupId}/modifiers/{modifierId}:
 *   get:
 *     tags: [Modifiers]
 *     summary: Get a modifier by ID
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: modifierGroupId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: modifierId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: The requested modifier
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Modifier'
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.get(
  '/venues/:venueId/modifier-groups/:modifierGroupId/modifiers/:modifierId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.WAITER]),
  validateRequest(GetModifierParamsSchema),
  menuController.getModifierHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/modifier-groups/{modifierGroupId}/modifiers/{modifierId}:
 *   patch:
 *     tags: [Modifiers]
 *     summary: Update a modifier
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: modifierGroupId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: modifierId, in: path, required: true, schema: { type: string, format: cuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Modifier' # Simplified for example
 *     responses:
 *       200:
 *         description: The updated modifier
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Modifier'
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.patch(
  '/venues/:venueId/modifier-groups/:modifierGroupId/modifiers/:modifierId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(UpdateModifierSchema),
  menuController.updateModifierHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/modifier-groups/{modifierGroupId}/modifiers/{modifierId}:
 *   put:
 *     tags: [Modifiers]
 *     summary: Update a modifier
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: modifierGroupId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: modifierId, in: path, required: true, schema: { type: string, format: cuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Modifier'
 *     responses:
 *       200:
 *         description: The updated modifier
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Modifier'
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.put(
  '/venues/:venueId/modifier-groups/:modifierGroupId/modifiers/:modifierId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(UpdateModifierSchema),
  menuController.updateModifierHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/modifier-groups/{modifierGroupId}/modifiers/{modifierId}:
 *   delete:
 *     tags: [Modifiers]
 *     summary: Delete a modifier
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: modifierGroupId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: modifierId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       204:
 *         description: Modifier deleted successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.delete(
  '/venues/:venueId/modifier-groups/:modifierGroupId/modifiers/:modifierId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(GetModifierParamsSchema),
  menuController.deleteModifierHandler,
)

// --- Product <-> ModifierGroup assignments ---

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/products/{productId}/modifier-groups:
 *   post:
 *     tags: [Products]
 *     summary: Assign a modifier group to a product
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: productId, in: path, required: true, schema: { type: string, format: cuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               modifierGroupId: { type: string, format: cuid }
 *               displayOrder: { type: integer, minimum: 0 }
 *     responses:
 *       201:
 *         description: Assignment created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ProductModifierGroupAssignment'
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.post(
  '/venues/:venueId/products/:productId/modifier-groups',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(AssignModifierGroupToProductSchema),
  menuController.assignModifierGroupToProductHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/products/{productId}/modifier-groups/{modifierGroupId}:
 *   delete:
 *     tags: [Products]
 *     summary: Remove a modifier group from a product
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: productId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: modifierGroupId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       204:
 *         description: Assignment removed successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.delete(
  '/venues/:venueId/products/:productId/modifier-groups/:modifierGroupId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(RemoveModifierGroupFromProductParamsSchema),
  menuController.removeModifierGroupFromProductHandler,
)

// ==========================================
// PRODUCT ROUTES
// ==========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/products:
 *   get:
 *     tags: [Products]
 *     summary: List all products for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     responses:
 *       200:
 *         description: A list of products
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       name: { type: string }
 *                       description: { type: string }
 *                       price: { type: number }
 *                       type: { type: string }
 *                       imageUrl: { type: string }
 *                       sku: { type: string }
 *                       active: { type: boolean }
 *                       displayOrder: { type: integer }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/products',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.WAITER]),
  validateRequest(VenueIdParamsSchema),
  productController.getProductsHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/products:
 *   post:
 *     tags: [Products]
 *     summary: Create a new product
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateProduct'
 *     responses:
 *       201:
 *         description: The created product
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/products',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(CreateProductSchema),
  productController.createProductHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/products/{productId}:
 *   get:
 *     tags: [Products]
 *     summary: Get a product by ID
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: productId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: The requested product
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.get(
  '/venues/:venueId/products/:productId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.WAITER]),
  validateRequest(GetProductParamsSchema),
  productController.getProductHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/products/{productId}:
 *   put:
 *     tags: [Products]
 *     summary: Update a product
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: productId, in: path, required: true, schema: { type: string, format: cuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateProduct'
 *     responses:
 *       200:
 *         description: The updated product
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.put(
  '/venues/:venueId/products/:productId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(UpdateProductSchema),
  productController.updateProductHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/products/{productId}:
 *   delete:
 *     tags: [Products]
 *     summary: Delete a product
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: productId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: Product deleted successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.delete(
  '/venues/:venueId/products/:productId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(GetProductParamsSchema),
  productController.deleteProductHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/products/{productId}/image:
 *   patch:
 *     tags: [Products]
 *     summary: Remove/clear the image from a product
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: productId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: Product image removed successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.patch(
  '/venues/:venueId/products/:productId/image',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequest(GetProductParamsSchema),
  productController.deleteProductImageHandler,
)

// ==========================================
// TEAM MANAGEMENT ROUTES
// ==========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/team:
 *   get:
 *     tags: [Team Management]
 *     summary: List all team members for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string, format: cuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 10 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: A paginated list of team members
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       firstName: { type: string }
 *                       lastName: { type: string }
 *                       email: { type: string }
 *                       role: { type: string, enum: [OWNER, ADMIN, MANAGER, WAITER, CASHIER, KITCHEN, HOST, VIEWER] }
 *                       active: { type: boolean }
 *                       startDate: { type: string, format: date-time }
 *                       endDate: { type: string, format: date-time, nullable: true }
 *                       totalSales: { type: number }
 *                       totalTips: { type: number }
 *                       totalOrders: { type: integer }
 *                       averageRating: { type: number }
 *                 meta:
 *                   type: object
 *                   properties:
 *                     totalCount: { type: integer }
 *                     pageSize: { type: integer }
 *                     currentPage: { type: integer }
 *                     totalPages: { type: integer }
 *                     hasNextPage: { type: boolean }
 *                     hasPrevPage: { type: boolean }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/team',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.ADMIN]),
  validateRequest(z.object({ params: TeamVenueIdParamsSchema.shape.params, query: TeamMembersQuerySchema.shape.query })),
  teamController.getTeamMembers,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/team:
 *   post:
 *     tags: [Team Management]
 *     summary: Invite a new team member
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - firstName
 *               - lastName
 *               - role
 *             properties:
 *               email: { type: string, format: email }
 *               firstName: { type: string, minLength: 1, maxLength: 50 }
 *               lastName: { type: string, minLength: 1, maxLength: 50 }
 *               role: { type: string, enum: [OWNER, ADMIN, MANAGER, WAITER, CASHIER, KITCHEN, HOST, VIEWER] }
 *               message: { type: string, maxLength: 500 }
 *     responses:
 *       201:
 *         description: Team member invited successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 invitation: { type: object }
 *                 emailSent: { type: boolean }
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/team',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.ADMIN]),
  validateRequest(InviteTeamMemberSchema),
  teamController.inviteTeamMember,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/team/invitations:
 *   get:
 *     tags: [Team Management]
 *     summary: Get pending invitations for venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: List of pending invitations
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/team/invitations',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.ADMIN]),
  validateRequest(TeamVenueIdParamsSchema),
  teamController.getPendingInvitations,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/team/invitations/{invitationId}:
 *   delete:
 *     tags: [Team Management]
 *     summary: Cancel/revoke an invitation
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: invitationId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: Invitation cancelled successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.delete(
  '/venues/:venueId/team/invitations/:invitationId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.ADMIN]),
  validateRequest(InvitationParamsSchema),
  teamController.cancelInvitation,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/team/invitations/{invitationId}/resend:
 *   post:
 *     tags: [Team Management]
 *     summary: Resend an invitation (extends expiration and sends new email)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: invitationId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: Invitation resent successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.post(
  '/venues/:venueId/team/invitations/:invitationId/resend',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.ADMIN]),
  validateRequest(InvitationParamsSchema),
  teamController.resendInvitation,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/team/{teamMemberId}:
 *   get:
 *     tags: [Team Management]
 *     summary: Get a specific team member
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: teamMemberId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: Team member details
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.get(
  '/venues/:venueId/team/:teamMemberId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.ADMIN]),
  validateRequest(TeamMemberParamsSchema),
  teamController.getTeamMember,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/team/{teamMemberId}:
 *   patch:
 *     tags: [Team Management]
 *     summary: Update team member role or status
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: teamMemberId, in: path, required: true, schema: { type: string, format: cuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               role: { type: string, enum: [OWNER, ADMIN, MANAGER, WAITER, CASHIER, KITCHEN, HOST, VIEWER] }
 *               active: { type: boolean }
 *               pin: { type: string, pattern: '^\d{4,6}$' }
 *     responses:
 *       200:
 *         description: Team member updated successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.patch(
  '/venues/:venueId/team/:teamMemberId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.ADMIN]),
  validateRequest(UpdateTeamMemberSchema),
  teamController.updateTeamMember,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/team/{teamMemberId}:
 *   delete:
 *     tags: [Team Management]
 *     summary: Remove team member from venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: teamMemberId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: Team member removed successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.delete(
  '/venues/:venueId/team/:teamMemberId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.ADMIN]),
  validateRequest(TeamMemberParamsSchema),
  teamController.removeTeamMember,
)

// ==========================================
// SHIFTS ROUTES
// ==========================================

/**
 * @openapi
 * /api/v2/dashboard/{venueId}/shifts:
 *   get:
 *     tags: [Shifts]
 *     summary: List all shifts for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string, format: cuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 10 }
 *       - in: query
 *         name: staffId
 *         schema: { type: string, format: cuid }
 *       - in: query
 *         name: startTime
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: endTime
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: A paginated list of shifts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       venueId: { type: string }
 *                       staffId: { type: string }
 *                       startTime: { type: string, format: date-time }
 *                       endTime: { type: string, format: date-time, nullable: true }
 *                       startingCash: { type: number }
 *                       endingCash: { type: number, nullable: true }
 *                       cashDifference: { type: number, nullable: true }
 *                       totalSales: { type: number }
 *                       totalTips: { type: number }
 *                       totalOrders: { type: integer }
 *                       status: { type: string, enum: [OPEN, CLOSING, CLOSED] }
 *                       staff: { type: object }
 *                       venue: { type: object }
 *                 meta:
 *                   type: object
 *                   properties:
 *                     totalCount: { type: integer }
 *                     pageSize: { type: integer }
 *                     currentPage: { type: integer }
 *                     totalPages: { type: integer }
 *                     hasNextPage: { type: boolean }
 *                     hasPrevPage: { type: boolean }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/shifts',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  shiftController.getShifts,
)

/**
 * @openapi
 * /api/v2/dashboard/{venueId}/shifts/{shiftId}:
 *   get:
 *     tags: [Shifts]
 *     summary: Get a shift by ID
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: shiftId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: The requested shift
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.get(
  '/venues/:venueId/shifts/:shiftId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  shiftController.getShift,
)

/**
 * @openapi
 * /api/v2/dashboard/{venueId}/shifts/summary:
 *   get:
 *     tags: [Shifts]
 *     summary: Get shifts summary with totals and waiter breakdown
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string, format: cuid }
 *       - in: query
 *         name: staffId
 *         schema: { type: string, format: cuid }
 *       - in: query
 *         name: startTime
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: endTime
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Shift summary data
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/shifts/summary',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  shiftController.getShiftsSummary,
)

// ==========================================
// NOTIFICATIONS ROUTES
// ==========================================

/**
 * @openapi
 * /api/v1/dashboard/notifications:
 *   get:
 *     tags: [Notifications]
 *     summary: Get user notifications
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: isRead
 *         schema: { type: boolean }
 *       - in: query
 *         name: type
 *         schema: { type: string }
 *       - in: query
 *         name: priority
 *         schema: { type: string, enum: [LOW, NORMAL, HIGH, URGENT] }
 *     responses:
 *       200:
 *         description: List of notifications
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 notifications: { type: array }
 *                 pagination: { type: object }
 *                 unreadCount: { type: integer }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get('/notifications', authenticateTokenMiddleware, notificationController.getUserNotifications)

/**
 * @openapi
 * /api/v1/dashboard/notifications/unread-count:
 *   get:
 *     tags: [Notifications]
 *     summary: Get unread notifications count
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Unread count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count: { type: integer }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get('/notifications/unread-count', authenticateTokenMiddleware, notificationController.getUnreadCount)

/**
 * @openapi
 * /api/v1/dashboard/notifications/{id}/read:
 *   patch:
 *     tags: [Notifications]
 *     summary: Mark notification as read
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Notification marked as read
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.patch('/notifications/:id/read', authenticateTokenMiddleware, notificationController.markAsRead)

/**
 * @openapi
 * /api/v1/dashboard/notifications/mark-all-read:
 *   patch:
 *     tags: [Notifications]
 *     summary: Mark all notifications as read
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: All notifications marked as read
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.patch('/notifications/mark-all-read', authenticateTokenMiddleware, notificationController.markAllAsRead)

/**
 * @openapi
 * /api/v1/dashboard/notifications/{id}:
 *   delete:
 *     tags: [Notifications]
 *     summary: Delete notification
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       204:
 *         description: Notification deleted successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.delete('/notifications/:id', authenticateTokenMiddleware, notificationController.deleteNotification)

/**
 * @openapi
 * /api/v1/dashboard/notifications/preferences:
 *   get:
 *     tags: [Notifications]
 *     summary: Get notification preferences
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: User notification preferences
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get('/notifications/preferences', authenticateTokenMiddleware, notificationController.getPreferences)

/**
 * @openapi
 * /api/v1/dashboard/notifications/preferences:
 *   put:
 *     tags: [Notifications]
 *     summary: Update notification preferences
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type: { type: string }
 *               enabled: { type: boolean }
 *               channels: { type: array, items: { type: string } }
 *               priority: { type: string }
 *               quietStart: { type: string }
 *               quietEnd: { type: string }
 *     responses:
 *       200:
 *         description: Preferences updated successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.put('/notifications/preferences', authenticateTokenMiddleware, notificationController.updatePreferences)

/**
 * @openapi
 * /api/v1/dashboard/notifications/types:
 *   get:
 *     tags: [Notifications]
 *     summary: Get available notification types
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: List of notification types
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get('/notifications/types', authenticateTokenMiddleware, notificationController.getNotificationTypes)

// Admin-only notification routes
/**
 * @openapi
 * /api/v1/dashboard/notifications:
 *   post:
 *     tags: [Notifications]
 *     summary: Create a notification (admin only)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - recipientId
 *               - type
 *               - title
 *               - message
 *             properties:
 *               recipientId: { type: string }
 *               venueId: { type: string }
 *               type: { type: string }
 *               title: { type: string }
 *               message: { type: string }
 *               actionUrl: { type: string }
 *               actionLabel: { type: string }
 *               priority: { type: string }
 *     responses:
 *       201:
 *         description: Notification created successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/notifications',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.SUPERADMIN]),
  notificationController.createNotification,
)

/**
 * @openapi
 * /api/v1/dashboard/notifications/bulk:
 *   post:
 *     tags: [Notifications]
 *     summary: Send bulk notifications (admin only)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - recipientIds
 *               - type
 *               - title
 *               - message
 *             properties:
 *               recipientIds: { type: array, items: { type: string } }
 *               type: { type: string }
 *               title: { type: string }
 *               message: { type: string }
 *     responses:
 *       201:
 *         description: Bulk notifications sent successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/notifications/bulk',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.SUPERADMIN]),
  notificationController.sendBulkNotification,
)

/**
 * @openapi
 * /api/v1/dashboard/notifications/venue/{venueId}:
 *   post:
 *     tags: [Notifications]
 *     summary: Send notification to all venue staff (admin only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - type
 *               - title
 *               - message
 *             properties:
 *               type: { type: string }
 *               title: { type: string }
 *               message: { type: string }
 *               roles: { type: array, items: { type: string } }
 *     responses:
 *       201:
 *         description: Venue notifications sent successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/notifications/venue/:venueId',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.SUPERADMIN]),
  notificationController.sendVenueNotification,
)

export default router
