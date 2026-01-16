import express, { RequestHandler } from 'express'
import { z } from 'zod'
import multer from 'multer'
import rateLimit from 'express-rate-limit'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware' // Verifica esta ruta
import { checkPermission } from '../middlewares/checkPermission.middleware'
import { authorizeRole } from '../middlewares/authorizeRole.middleware'
import { chatbotRateLimitMiddleware } from '../middlewares/chatbot-rate-limit.middleware'
import { tokenBudgetMiddleware } from '../middlewares/token-budget.middleware'
import { passwordResetRateLimiter } from '../middlewares/password-reset-rate-limit.middleware'
import { validateRequest } from '../middlewares/validation' // Verifica esta ruta
import { StaffRole } from '../security'

// Importa StaffRole desde @prisma/client si ahí es donde está definido tu enum de Prisma
// o desde donde lo hayas exportado como enum de TS (si es una copia manual)

// Importa el SCHEMA de Zod, no el tipo DTO, para el middleware de validación
import * as assistantController from '../controllers/dashboard/assistant.dashboard.controller'
import * as authDashboardController from '../controllers/dashboard/auth.dashboard.controller'
import * as availableBalanceController from '../controllers/dashboard/availableBalance.dashboard.controller'
import * as settlementIncidentController from '../controllers/dashboard/settlementIncident.dashboard.controller'
import * as cashCloseoutController from '../controllers/dashboard/cashCloseout.dashboard.controller'
import * as creditOfferController from '../controllers/dashboard/creditOffer.dashboard.controller'
import * as featureController from '../controllers/dashboard/feature.controller'
import * as generalStatsController from '../controllers/dashboard/generalStats.dashboard.controller'
import * as googleOAuthController from '../controllers/dashboard/googleOAuth.controller'
import * as googleIntegrationController from '../controllers/dashboard/googleIntegration.dashboard.controller'
import * as menuController from '../controllers/dashboard/menu.dashboard.controller'
import * as modifierInventoryAnalyticsController from '../controllers/dashboard/modifierInventoryAnalytics.controller'
import * as notificationController from '../controllers/dashboard/notification.dashboard.controller'
import * as orderController from '../controllers/dashboard/order.dashboard.controller'
import * as paymentController from '../controllers/dashboard/payment.dashboard.controller'
import * as productController from '../controllers/dashboard/product.dashboard.controller'
import * as reviewController from '../controllers/dashboard/review.dashboard.controller'
import * as rolePermissionController from '../controllers/dashboard/rolePermission.controller'
import * as customerController from '../controllers/dashboard/customer.dashboard.controller'
import * as customerGroupController from '../controllers/dashboard/customerGroup.dashboard.controller'
import * as venueRoleConfigController from '../controllers/dashboard/venueRoleConfig.dashboard.controller'
import * as venueSettingsController from '../controllers/dashboard/venueSettings.dashboard.controller'
import * as loyaltyController from '../controllers/dashboard/loyalty.dashboard.controller'
import * as discountController from '../controllers/dashboard/discount.dashboard.controller'
import * as couponController from '../controllers/dashboard/coupon.dashboard.controller'
import * as shiftController from '../controllers/dashboard/shift.dashboard.controller'
import * as teamController from '../controllers/dashboard/team.dashboard.controller'
import * as testingController from '../controllers/dashboard/testing.dashboard.controller'
import * as textToSqlAssistantController from '../controllers/dashboard/text-to-sql-assistant.controller'
import * as tokenBudgetController from '../controllers/dashboard/token-budget.dashboard.controller'
import * as tpvController from '../controllers/dashboard/tpv.dashboard.controller'
import * as tpvCommandController from '../controllers/dashboard/tpv-command.dashboard.controller'
import * as venueController from '../controllers/dashboard/venue.dashboard.controller'
import * as venueKycController from '../controllers/dashboard/venueKyc.controller'
import * as venueFeatureController from '../controllers/dashboard/venueFeature.dashboard.controller'
import { assistantQuerySchema, feedbackSubmissionSchema } from '../schemas/dashboard/assistant.schema'
import {
  dateRangeQuerySchema,
  timelineQuerySchema,
  simulateTransactionSchema,
  balanceProjectionQuerySchema,
} from '../schemas/dashboard/availableBalance.schema'
import {
  incidentListQuerySchema,
  confirmIncidentSchema,
  escalateIncidentSchema,
  bulkConfirmIncidentSchema,
} from '../schemas/dashboard/settlementIncident.schema'
import { createCloseoutSchema, closeoutHistoryQuerySchema } from '../schemas/dashboard/cashCloseout.schema'
import {
  loginSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  switchVenueSchema,
  updateAccountSchema,
} from '../schemas/dashboard/auth.schema'
import { enhancedCreateVenueSchema } from '../schemas/dashboard/cost-management.schema'
import { GeneralStatsQuerySchema } from '../schemas/dashboard/generalStats.schema'
import {
  // Assignment schemas
  AssignCategoryToMenuSchema,
  AssignModifierGroupToProductSchema,
  CloneMenuSchema,
  // Menu schemas
  CreateMenuSchema,
  ImportMenuSchema,
  // Modifier schemas
  CreateModifierGroupSchema,
  CreateModifierSchema,
  // Product schemas
  CreateProductSchema,
  GetMenuParamsSchema,
  GetModifierGroupParamsSchema,
  GetModifierParamsSchema,
  GetProductParamsSchema,
  MenuQuerySchema,
  ModifierGroupQuerySchema,
  RemoveModifierGroupFromProductParamsSchema,
  ReorderMenusSchema,
  ReorderProductsSchema,
  UpdateMenuSchema,
  UpdateModifierGroupSchema,
  UpdateModifierSchema,
  UpdateProductSchema,
} from '../schemas/dashboard/menu.schema'
import {
  CreateMenuCategorySchema,
  GetMenuCategoryParamsSchema, // For listing all under a venue or POST to a venue
  ReorderMenuCategoriesSchema,
  UpdateMenuCategorySchema, // For GET one, DELETE
  VenueIdParamsSchema, // For listing all under a venue or POST to a venue
} from '../schemas/dashboard/menuCategory.schema'
import {
  CreateCustomerSchema,
  UpdateCustomerSchema,
  CustomersQuerySchema,
  CustomerParamsSchema,
  VenueIdParamsSchema as CustomerVenueIdParamsSchema,
} from '../schemas/dashboard/customer.schema'
import { SettleOrderSchema } from '../schemas/dashboard/order.schema'
import {
  CreateCustomerGroupSchema,
  UpdateCustomerGroupSchema,
  CustomerGroupsQuerySchema,
  CustomerGroupParamsSchema,
  AssignCustomersSchema,
  RemoveCustomersSchema,
} from '../schemas/dashboard/customerGroup.schema'
import { UpdateRoleConfigsSchema, RoleConfigParamsSchema } from '../schemas/dashboard/venueRoleConfig.schema'
import { UpdateVenueSettingsSchema, UpdateTpvSettingsSchema } from '../schemas/dashboard/venueSettings.schema'
import {
  GetModifierUsageStatsSchema,
  GetModifiersLowStockSchema,
  GetModifierInventorySummarySchema,
  GetModifiersWithInventorySchema,
} from '../schemas/dashboard/modifierInventoryAnalytics.schema'
import {
  UpdateLoyaltyConfigSchema,
  CalculatePointsSchema,
  CalculateDiscountSchema,
  RedeemPointsSchema,
  AdjustPointsSchema,
  LoyaltyTransactionsQuerySchema,
  LoyaltyParamsSchema,
  LoyaltyVenueParamsSchema,
} from '../schemas/dashboard/loyalty.schema'
import {
  getDiscountsQuerySchema,
  createDiscountBodySchema,
  updateDiscountBodySchema,
  assignDiscountToCustomerBodySchema,
  discountParamsSchema,
  venueParamsSchema as DiscountVenueParamsSchema,
} from '../schemas/dashboard/discount.schema'
import {
  getCouponsQuerySchema,
  getRedemptionsQuerySchema,
  createCouponBodySchema,
  updateCouponBodySchema,
  bulkGenerateCouponsBodySchema,
  validateCouponBodySchema,
  recordRedemptionBodySchema,
  couponParamsSchema,
  venueParamsSchema as CouponVenueParamsSchema,
} from '../schemas/dashboard/coupon.schema'
import {
  InvitationParamsSchema,
  InviteTeamMemberSchema,
  TeamMemberParamsSchema,
  TeamMembersQuerySchema,
  VenueIdParamsSchema as TeamVenueIdParamsSchema,
  UpdateTeamMemberSchema,
} from '../schemas/dashboard/team.schema'
import { createTestPaymentSchema, getTestPaymentsSchema } from '../schemas/dashboard/testing.schema'
import { generateActivationCodeSchema } from '../schemas/activation.schema'
import {
  createVenueSchema,
  listVenuesQuerySchema,
  convertDemoVenueSchema,
  addVenueFeaturesSchema,
  updatePaymentMethodSchema,
  createBillingPortalSessionSchema,
} from '../schemas/dashboard/venue.schema'
import {
  // Wrapped schemas for route validation (use these with validateRequest)
  sendCommandSchema,
  bulkCommandSchema,
  commandsQuerySchema,
  commandHistoryQuerySchema,
  bulkOperationsQuerySchema,
  createScheduledCommandSchema,
  updateScheduledCommandSchema,
  scheduledCommandsQuerySchema,
  createGeofenceRuleSchema,
  updateGeofenceRuleSchema,
  geofenceRulesQuerySchema,
  terminalAckSchema,
  terminalResultSchema,
} from '../schemas/dashboard/tpv-command.schema'
import inventoryRoutes from './dashboard/inventory.routes'
import superadminRoutes from './dashboard/superadmin.routes'
import venuePaymentConfigRoutes from './dashboard/venuePaymentConfig.routes'
import ecommerceMerchantRoutes from './dashboard/ecommerceMerchant.routes'
import reportsRoutes from './dashboard/reports.routes'
import commissionRoutes from './dashboard/commission.routes'
// @temporary - Serialized inventory demo routes (delete after final implementation)
import serializedInventoryRoutes from './dashboard/serializedInventory.routes'
// Command Center routes for PlayTelecom/White-Label dashboard
import commandCenterRoutes from './dashboard/commandCenter.routes'
// Promoters Audit routes for PlayTelecom/White-Label dashboard
import promotersRoutes from './dashboard/promoters.routes'
// Stock Dashboard routes for PlayTelecom/White-Label dashboard
import stockDashboardRoutes from './dashboard/stockDashboard.routes'
// Organization Dashboard routes for PlayTelecom/White-Label dashboard
import organizationDashboardRoutes from './dashboard/organizationDashboard.routes'

const router = express.Router({ mergeParams: true })

// Rate limiters for security (FAANG best practices)
// More permissive rate limits in development for easier testing
const isDevelopment = process.env.NODE_ENV !== 'production'

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDevelopment ? 100 : 10, // Dev: 100/15min, Prod: 10/15min
  message: 'Too many login attempts from this account. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.body.email || req.ip || 'unknown',
  skipSuccessfulRequests: true, // Don't count successful logins against the limit
})

// Configure multer for document uploads (memory storage, max 10MB)
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (_req, file, cb) => {
    // Accept PDF, JPG, JPEG, PNG files
    const allowedMimeTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png']
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Only PDF, JPG, JPEG, and PNG files are allowed'))
    }
  },
})

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
  loginRateLimiter, // Rate limit login attempts
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

/**
 * @openapi
 * /api/v1/dashboard/{venueId}/account:
 *   patch:
 *     tags: [Authentication]
 *     summary: Update user account information
 *     description: Update profile information for the authenticated user including name, email, phone, and password
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *         description: Venue ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               firstName:
 *                 type: string
 *                 description: User's first name
 *               lastName:
 *                 type: string
 *                 description: User's last name
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User's email address
 *               phone:
 *                 type: string
 *                 description: User's phone number
 *               old_password:
 *                 type: string
 *                 description: Current password (required if changing password)
 *               password:
 *                 type: string
 *                 description: New password
 *     responses:
 *       200:
 *         description: Account updated successfully
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
 *                   properties:
 *                     id:
 *                       type: string
 *                     firstName:
 *                       type: string
 *                     lastName:
 *                       type: string
 *                     email:
 *                       type: string
 *                     phone:
 *                       type: string
 *       400:
 *         description: Validation error or incorrect current password
 *       401:
 *         description: Unauthorized
 */
router.patch(
  '/:venueId/account',
  authenticateTokenMiddleware,
  validateRequest(updateAccountSchema),
  authDashboardController.updateAccountController,
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

/**
 * @openapi
 * /api/v1/dashboard/auth/google/one-tap:
 *   post:
 *     tags: [Authentication]
 *     summary: Handle Google One Tap Sign-In
 *     description: Process Google One Tap JWT credential to authenticate user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - credential
 *             properties:
 *               credential:
 *                 type: string
 *                 description: Google One Tap JWT credential
 *     responses:
 *       200:
 *         description: Successfully authenticated with Google One Tap
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
 *         description: Invalid request or missing credential
 *       403:
 *         description: No invitation found for this email
 *       401:
 *         description: Authentication failed
 */
router.post('/auth/google/one-tap', googleOAuthController.googleOneTapLogin)

// --- Password Reset Routes (PUBLIC - no auth required) ---

/**
 * @openapi
 * /api/v1/dashboard/auth/request-reset:
 *   post:
 *     tags: [Authentication]
 *     summary: Request a password reset email
 *     description: Sends a password reset email with a secure token. Always returns success to prevent user enumeration.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *     responses:
 *       200:
 *         description: Success message (always returned, even if email doesn't exist)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       429:
 *         description: Too many requests (rate limited)
 */
router.post(
  '/auth/request-reset',
  passwordResetRateLimiter,
  validateRequest(requestPasswordResetSchema),
  authDashboardController.requestPasswordReset,
)

/**
 * @openapi
 * /api/v1/dashboard/auth/validate-reset-token/{token}:
 *   get:
 *     tags: [Authentication]
 *     summary: Validate a password reset token
 *     description: Checks if a password reset token is valid and not expired
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *         description: The password reset token from the email
 *     responses:
 *       200:
 *         description: Token is valid
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 valid:
 *                   type: boolean
 *                 email:
 *                   type: string
 *                   description: Masked email address (e.g., j***n@example.com)
 *       400:
 *         description: Token is invalid or expired
 */
router.get('/auth/validate-reset-token/:token', authDashboardController.validateResetToken)

/**
 * @openapi
 * /api/v1/dashboard/auth/reset-password:
 *   post:
 *     tags: [Authentication]
 *     summary: Reset password with token
 *     description: Sets a new password using a valid reset token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *               - newPassword
 *             properties:
 *               token:
 *                 type: string
 *                 description: The password reset token from the email
 *               newPassword:
 *                 type: string
 *                 format: password
 *                 minLength: 8
 *                 description: New password (min 8 chars, must include uppercase, lowercase, number, and special char)
 *     responses:
 *       200:
 *         description: Password reset successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid token or password does not meet requirements
 */
router.post('/auth/reset-password', validateRequest(resetPasswordSchema), authDashboardController.resetPassword)

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
  checkPermission('menu:read'),
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
  checkPermission('menu:create'),
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
  checkPermission('menu:update'),
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
  checkPermission('menu:read'),
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
  checkPermission('menu:update'),
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
  checkPermission('menu:delete'),
  validateRequest(GetMenuCategoryParamsSchema),
  menuController.deleteMenuCategoryHandler,
)

// router.get('/venues/:venueId/menus', getMenusHandler) // This seems to be a duplicate or old route
router.get('/venues/:venueId/menus', authenticateTokenMiddleware, checkPermission('menu:read'), menuController.getMenusHandler)
router.post(
  '/venues/:venueId/menucategories',
  authenticateTokenMiddleware,
  checkPermission('menu:create'),
  validateRequest(CreateMenuCategorySchema),
  menuController.createMenuCategoryHandler,
)

router.get(
  '/venues/:venueId/menucategories',
  authenticateTokenMiddleware,
  checkPermission('menu:read'),
  validateRequest(VenueIdParamsSchema), // Validate venueId from params
  menuController.listMenuCategoriesHandler,
)

router.post(
  '/venues/:venueId/menucategories/reorder',
  authenticateTokenMiddleware,
  checkPermission('menu:update'),
  validateRequest(ReorderMenuCategoriesSchema),
  menuController.reorderMenuCategoriesHandler,
)

router.get(
  '/venues/:venueId/menucategories/:categoryId',
  authenticateTokenMiddleware,
  checkPermission('menu:read'),
  validateRequest(GetMenuCategoryParamsSchema),
  menuController.getMenuCategoryHandler,
)

router.patch(
  '/venues/:venueId/menucategories/:categoryId',
  authenticateTokenMiddleware,
  checkPermission('menu:update'),
  validateRequest(UpdateMenuCategorySchema),
  menuController.updateMenuCategoryHandler,
)

router.delete(
  '/venues/:venueId/menucategories/:categoryId',
  authenticateTokenMiddleware,
  checkPermission('menu:delete'),
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
router.get('/venues/:venueId/reviews', authenticateTokenMiddleware, checkPermission('reviews:read'), reviewController.getReviewsData)

router.delete(
  '/venues/:venueId/reviews/:reviewId',
  authenticateTokenMiddleware,
  checkPermission('reviews:delete'), // SUPERADMIN only
  reviewController.deleteReview,
)

// Google Business Profile Integration Routes
/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/integrations/google/init-oauth:
 *   post:
 *     tags: [Integrations]
 *     summary: Initialize Google Business Profile OAuth flow
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OAuth authorization URL generated
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.post(
  '/venues/:venueId/integrations/google/init-oauth',
  authenticateTokenMiddleware,
  checkPermission('venues:manage'),
  googleIntegrationController.initGoogleOAuth,
)

/**
 * @openapi
 * /api/v1/dashboard/integrations/google/callback:
 *   get:
 *     tags: [Integrations]
 *     summary: Handle Google OAuth callback (no auth required, uses state parameter)
 *     parameters:
 *       - in: query
 *         name: code
 *         schema:
 *           type: string
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         description: Contains stateToken:venueId for security and routing
 *     responses:
 *       302:
 *         description: Redirect to dashboard with success/error status
 */
router.get('/integrations/google/callback', googleIntegrationController.handleGoogleCallback)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/integrations/google/status:
 *   get:
 *     tags: [Integrations]
 *     summary: Get Google Business Profile integration status
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Integration status retrieved
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get(
  '/venues/:venueId/integrations/google/status',
  authenticateTokenMiddleware,
  checkPermission('venues:read'),
  googleIntegrationController.getGoogleIntegrationStatus,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/integrations/google/sync:
 *   post:
 *     tags: [Integrations]
 *     summary: Manually trigger Google reviews sync
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Reviews synced successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.post(
  '/venues/:venueId/integrations/google/sync',
  authenticateTokenMiddleware,
  checkPermission('venues:manage'),
  googleIntegrationController.syncGoogleReviews,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/integrations/google/disconnect:
 *   delete:
 *     tags: [Integrations]
 *     summary: Disconnect Google Business Profile integration
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Integration disconnected
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.delete(
  '/venues/:venueId/integrations/google/disconnect',
  authenticateTokenMiddleware,
  checkPermission('venues:manage'),
  googleIntegrationController.disconnectGoogleIntegration,
)

// Review Response Routes
/**
 * @openapi
 * /api/v1/dashboard/reviews/{reviewId}/generate-response:
 *   post:
 *     tags: [Reviews]
 *     summary: Generate AI-powered response draft for a review
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: reviewId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: AI response generated successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.post(
  '/reviews/:reviewId/generate-response',
  authenticateTokenMiddleware,
  checkPermission('reviews:respond'),
  reviewController.generateReviewResponse,
)

/**
 * @openapi
 * /api/v1/dashboard/reviews/{reviewId}/submit-response:
 *   post:
 *     tags: [Reviews]
 *     summary: Submit approved review response
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: reviewId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               responseText:
 *                 type: string
 *     responses:
 *       200:
 *         description: Response submitted successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.post(
  '/reviews/:reviewId/submit-response',
  authenticateTokenMiddleware,
  checkPermission('reviews:respond'),
  reviewController.submitReviewResponse,
)

/**
 * @openapi
 * /api/v1/dashboard/reviews/{reviewId}/response-feedback:
 *   post:
 *     tags: [Reviews]
 *     summary: Submit feedback on AI-generated response
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: reviewId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               trainingDataId:
 *                 type: string
 *               feedback:
 *                 type: string
 *                 enum: [positive, negative]
 *               correctionText:
 *                 type: string
 *     responses:
 *       200:
 *         description: Feedback submitted successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.post(
  '/reviews/:reviewId/response-feedback',
  authenticateTokenMiddleware,
  checkPermission('reviews:respond'),
  reviewController.submitResponseFeedback,
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
  checkPermission('venues:manage'),
  validateRequest(createVenueSchema), // Pasas el schema de Zod
  venueController.createVenue, // Llamas al método del controlador
)

/**
 * @openapi
 * /api/v1/dashboard/venues/enhanced:
 *   post:
 *     tags: [Venues]
 *     summary: Create a new venue with enhanced features (payment processing and pricing)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - type
 *               - logo
 *               - address
 *               - city
 *               - state
 *               - zipCode
 *               - phone
 *               - email
 *             properties:
 *               name: { type: string, description: "Venue name" }
 *               type: { type: string, description: "Venue type" }
 *               logo: { type: string, format: uri, description: "Logo URL" }
 *               address: { type: string, description: "Street address" }
 *               city: { type: string, description: "City" }
 *               state: { type: string, description: "State/Province" }
 *               country: { type: string, default: "MX", description: "Country code" }
 *               zipCode: { type: string, description: "ZIP/Postal code" }
 *               phone: { type: string, description: "Phone number" }
 *               email: { type: string, format: email, description: "Email address" }
 *               website: { type: string, format: uri, description: "Website URL" }
 *               enablePaymentProcessing: { type: boolean, default: true, description: "Enable payment processing setup" }
 *               primaryAccountId: { type: string, description: "Primary payment account ID" }
 *               secondaryAccountId: { type: string, description: "Secondary payment account ID" }
 *               tertiaryAccountId: { type: string, description: "Tertiary payment account ID" }
 *               setupPricingStructure: { type: boolean, default: true, description: "Setup pricing structure" }
 *               pricingTier: { type: string, enum: ["STANDARD", "PREMIUM", "ENTERPRISE", "CUSTOM"], default: "STANDARD", description: "Pricing tier" }
 *               currency: { type: string, default: "MXN", description: "Currency code" }
 *               timezone: { type: string, default: "America/Mexico_City", description: "Timezone" }
 *     responses:
 *       201:
 *         description: Enhanced venue created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     venueId: { type: string }
 *                     venue: { $ref: '#/components/schemas/Venue' }
 *                     paymentProcessing: { type: boolean }
 *                     pricingStructure: { type: boolean }
 *                 message: { type: string }
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/enhanced',
  authenticateTokenMiddleware,
  checkPermission('venues:manage'),
  validateRequest(enhancedCreateVenueSchema),
  venueController.createEnhancedVenue,
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
  checkPermission('venues:read'),
  validateRequest(listVenuesQuerySchema), // Validar query params
  venueController.listVenues as unknown as RequestHandler, // Type assertion for controller
)

/**
 * @openapi
 * /api/v1/dashboard/venues/slug/{slug}:
 *   get:
 *     tags: [Venues]
 *     summary: Get a venue by slug (for KYC resubmission page)
 *     description: Returns minimal venue data with KYC status fields
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: slug, in: path, required: true, schema: { type: string }, description: Venue slug }
 *     responses:
 *       200:
 *         description: Venue data with KYC status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     name: { type: string }
 *                     slug: { type: string }
 *                     kycStatus: { type: string, enum: [PENDING, APPROVED, REJECTED] }
 *                     kycRejectionReason: { type: string, nullable: true }
 *                     entityType: { type: string, enum: [PERSONA_FISICA, PERSONA_MORAL] }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.get('/venues/slug/:slug', authenticateTokenMiddleware, checkPermission('venues:read'), venueController.getVenueBySlug)

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
router.get('/venues/:venueId', authenticateTokenMiddleware, checkPermission('venues:read'), venueController.getVenueById)

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
router.put('/venues/:venueId', authenticateTokenMiddleware, checkPermission('venues:manage'), venueController.updateVenue)

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
router.delete('/venues/:venueId', authenticateTokenMiddleware, checkPermission('venues:manage'), venueController.deleteVenue)

// ============================================
// VENUE STATUS MANAGEMENT ROUTES
// ============================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/suspend:
 *   post:
 *     tags: [Venues]
 *     summary: Suspend a venue (voluntary)
 *     description: |
 *       Suspends a venue temporarily. The venue owner/admin can request suspension.
 *       This transitions the venue from ACTIVE to SUSPENDED status.
 *       Staff and TPV cannot access a suspended venue.
 *       This is reversible - use the reactivate endpoint to restore access.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Reason for suspension (for audit purposes)
 *                 example: Temporary closure for renovation
 *     responses:
 *       200:
 *         description: Venue suspended successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data: { $ref: '#/components/schemas/Venue' }
 *                 message: { type: string, example: Venue suspendido exitosamente }
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.post('/venues/:venueId/suspend', authenticateTokenMiddleware, checkPermission('venues:manage'), venueController.suspendVenue)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/close:
 *   post:
 *     tags: [Venues]
 *     summary: Close a venue permanently
 *     description: |
 *       Closes a venue permanently. This is a terminal state - the venue cannot be reactivated.
 *       Data is retained for audit purposes (Mexican regulatory compliance - SAT).
 *       The venue must already be in SUSPENDED or ADMIN_SUSPENDED state.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Reason for permanent closure (for audit purposes)
 *                 example: Business cessation
 *     responses:
 *       200:
 *         description: Venue closed permanently
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data: { $ref: '#/components/schemas/Venue' }
 *                 message: { type: string, example: Venue cerrado permanentemente }
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.post('/venues/:venueId/close', authenticateTokenMiddleware, checkPermission('venues:manage'), venueController.closeVenue)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/reactivate:
 *   post:
 *     tags: [Venues]
 *     summary: Reactivate a suspended venue
 *     description: |
 *       Reactivates a suspended venue, restoring full access.
 *       Only works for SUSPENDED status (user-initiated suspension).
 *       ADMIN_SUSPENDED venues require superadmin intervention.
 *       CLOSED venues cannot be reactivated.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Venue reactivated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data: { $ref: '#/components/schemas/Venue' }
 *                 message: { type: string, example: Venue reactivado exitosamente }
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.post('/venues/:venueId/reactivate', authenticateTokenMiddleware, checkPermission('venues:manage'), venueController.reactivateVenue)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/status-history:
 *   get:
 *     tags: [Venues]
 *     summary: Get venue status information
 *     description: |
 *       Returns the current status and related metadata for a venue.
 *       Useful for audit and displaying status information in the dashboard.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Venue status information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     venueId: { type: string }
 *                     venueName: { type: string }
 *                     currentStatus: { type: string, enum: [ONBOARDING, TRIAL, PENDING_ACTIVATION, ACTIVE, SUSPENDED, ADMIN_SUSPENDED, CLOSED] }
 *                     statusChangedAt: { type: string, format: date-time }
 *                     statusChangedBy: { type: string }
 *                     suspensionReason: { type: string }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.get(
  '/venues/:venueId/status-history',
  authenticateTokenMiddleware,
  checkPermission('venues:read'),
  venueController.getVenueStatusHistory,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/payment-method:
 *   put:
 *     tags: [Venues]
 *     summary: Update venue payment method
 *     description: Updates the Stripe payment method for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [paymentMethodId]
 *             properties:
 *               paymentMethodId:
 *                 type: string
 *                 description: Stripe payment method ID
 *                 example: pm_1234567890abcdef
 *     responses:
 *       200:
 *         description: Payment method updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Payment method updated successfully }
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.put(
  '/venues/:venueId/payment-method',
  authenticateTokenMiddleware,
  checkPermission('venues:manage'),
  validateRequest(updatePaymentMethodSchema) as RequestHandler,
  venueController.updateVenuePaymentMethod,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/billing-portal:
 *   post:
 *     tags: [Venues]
 *     summary: Create Stripe Customer Portal session
 *     description: |
 *       Generates a URL to Stripe's hosted billing portal where customers can:
 *       - View subscription details
 *       - Update payment methods
 *       - View invoices and payment history
 *       - Cancel subscriptions
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *         description: Venue ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               returnUrl:
 *                 type: string
 *                 format: uri
 *                 description: URL to redirect to after customer exits portal
 *                 example: https://dashboard.example.com/settings/billing
 *             required:
 *               - returnUrl
 *     responses:
 *       200:
 *         description: Billing portal session URL generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 url: { type: string, format: uri, example: https://billing.stripe.com/session/... }
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.post(
  '/venues/:venueId/billing-portal',
  authenticateTokenMiddleware,
  checkPermission('venues:manage'),
  validateRequest(createBillingPortalSessionSchema) as RequestHandler,
  venueController.createBillingPortalSession,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/payment-methods:
 *   get:
 *     tags: [Venues]
 *     summary: List payment methods for a venue
 *     description: Returns all saved payment methods (credit cards) for the venue's Stripe customer
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: List of payment methods
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, example: pm_1234567890 }
 *                       card:
 *                         type: object
 *                         properties:
 *                           brand: { type: string, example: visa }
 *                           last4: { type: string, example: "4242" }
 *                           exp_month: { type: number, example: 12 }
 *                           exp_year: { type: number, example: 2025 }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.get(
  '/venues/:venueId/payment-methods',
  authenticateTokenMiddleware,
  checkPermission('venues:manage'),
  venueController.listVenuePaymentMethods,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/payment-methods/{paymentMethodId}:
 *   delete:
 *     tags: [Venues]
 *     summary: Delete a payment method
 *     description: Detaches a payment method from the venue's Stripe customer
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *       - { name: paymentMethodId, in: path, required: true, schema: { type: string, example: pm_1234567890 } }
 *     responses:
 *       200:
 *         description: Payment method deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Payment method deleted successfully }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.delete(
  '/venues/:venueId/payment-methods/:paymentMethodId',
  authenticateTokenMiddleware,
  checkPermission('venues:manage'),
  venueController.detachVenuePaymentMethod,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/payment-methods/set-default:
 *   put:
 *     tags: [Venues]
 *     summary: Set default payment method
 *     description: Sets a payment method as the default for subscriptions and invoices
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [paymentMethodId]
 *             properties:
 *               paymentMethodId:
 *                 type: string
 *                 example: pm_1234567890
 *     responses:
 *       200:
 *         description: Default payment method set successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Default payment method set successfully }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.put(
  '/venues/:venueId/payment-methods/set-default',
  authenticateTokenMiddleware,
  checkPermission('venues:manage'),
  venueController.setVenueDefaultPaymentMethod,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/setup-intent:
 *   post:
 *     tags: [Venues]
 *     summary: Create SetupIntent for payment method collection
 *     description: Creates a Stripe SetupIntent to collect payment method details without charging. Returns client secret for Stripe Elements.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: SetupIntent created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     clientSecret:
 *                       type: string
 *                       example: seti_1234567890_secret_abcdef
 *                       description: Client secret for Stripe Elements CardElement
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.post(
  '/venues/:venueId/setup-intent',
  authenticateTokenMiddleware,
  checkPermission('venues:manage'),
  venueController.createVenueSetupIntent,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/convert-from-demo:
 *   post:
 *     tags: [Venues]
 *     summary: Convert demo venue to real venue
 *     description: Converts a demo venue to a real (production) venue by providing tax information
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rfc, legalName, fiscalRegime]
 *             properties:
 *               rfc:
 *                 type: string
 *                 description: RFC (Tax ID) for Mexico
 *                 pattern: '^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$'
 *                 example: 'XAXX010101000'
 *               legalName:
 *                 type: string
 *                 description: Legal business name
 *                 example: 'Mi Restaurante S.A. de C.V.'
 *               fiscalRegime:
 *                 type: string
 *                 description: Tax regime code
 *                 example: '601'
 *               taxDocumentUrl:
 *                 type: string
 *                 format: uri
 *                 description: URL to uploaded tax document
 *                 nullable: true
 *               idDocumentUrl:
 *                 type: string
 *                 format: uri
 *                 description: URL to uploaded ID document
 *                 nullable: true
 *               actaDocumentUrl:
 *                 type: string
 *                 format: uri
 *                 description: URL to uploaded Acta Constitutiva document
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Venue successfully converted to real
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 data: { $ref: '#/components/schemas/Venue' }
 *       400:
 *         description: Venue is not in demo mode or validation failed
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.post(
  '/venues/:venueId/convert-from-demo',
  authenticateTokenMiddleware,
  checkPermission('venues:manage'),
  validateRequest(convertDemoVenueSchema) as RequestHandler,
  venueController.convertDemoVenue,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/features:
 *   get:
 *     tags: [Venue Features]
 *     summary: Get venue feature status
 *     description: Returns active features and available features for the venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Feature status retrieved successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.get(
  '/venues/:venueId/features',
  authenticateTokenMiddleware,
  checkPermission('venues:read'),
  venueFeatureController.getVenueFeatures,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/features:
 *   post:
 *     tags: [Venue Features]
 *     summary: Add features to venue
 *     description: Add features to venue with trial subscriptions
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [featureCodes]
 *             properties:
 *               featureCodes:
 *                 type: array
 *                 items: { type: string }
 *                 example: ['CHATBOT', 'ADVANCED_ANALYTICS']
 *               trialPeriodDays:
 *                 type: number
 *                 default: 5
 *     responses:
 *       201:
 *         description: Features added successfully
 *       400:
 *         description: Venue does not have Stripe customer or validation failed
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.post(
  '/venues/:venueId/features',
  authenticateTokenMiddleware,
  checkPermission('venues:manage'),
  validateRequest(addVenueFeaturesSchema) as RequestHandler,
  venueFeatureController.addVenueFeatures,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/features/{featureId}:
 *   delete:
 *     tags: [Venue Features]
 *     summary: Remove feature from venue
 *     description: Remove feature from venue and cancel Stripe subscription
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *       - { name: featureId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Feature removed successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.delete(
  '/venues/:venueId/features/:featureId',
  authenticateTokenMiddleware,
  checkPermission('venues:manage'),
  venueFeatureController.removeVenueFeature,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/upload-document:
 *   post:
 *     tags: [Venues]
 *     summary: Upload venue document (tax or ID document)
 *     description: |
 *       Upload a document file for venue conversion. File will be auto-renamed based on field name or type parameter:
 *       - Field name contains 'tax', 'csf', or 'fiscal' → CSF.{ext}
 *       - Field name contains 'id' or 'identif' → ID.{ext}
 *       - Query param type=csf → CSF.{ext}
 *       - Query param type=id → ID.{ext}
 *       - Otherwise → Document.{ext}
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: type, in: query, required: false, schema: { type: string, enum: [csf, id] }, description: 'Optional: Document type override. Auto-detected from field name if not provided.' }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Document file (PDF, JPG, JPEG, or PNG). Use field name 'taxDocument' or 'idDocument' for auto-detection.
 *     responses:
 *       200:
 *         description: Document uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   properties:
 *                     buffer: { type: string, description: 'Base64 encoded file data' }
 *                     filename: { type: string, description: 'Clean filename (CSF.pdf, ID.jpg, or Document.pdf)' }
 *                     mimeType: { type: string }
 *                     size: { type: number }
 *       400:
 *         description: No file uploaded or invalid file type
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/upload-document',
  authenticateTokenMiddleware,
  checkPermission('venues:manage'),
  documentUpload.single('file'),
  venueController.uploadVenueDocument,
)

// Venue KYC - Upload single document (auto-save)
router.put(
  '/venues/:venueId/kyc/document/:documentKey',
  authenticateTokenMiddleware,
  documentUpload.single('file'),
  venueKycController.uploadSingleKycDocument,
)

// Venue KYC - Submit for review
router.post('/venues/:venueId/kyc/submit', authenticateTokenMiddleware, venueKycController.submitKycForReview)

// Venue KYC Resubmission (after rejection) - LEGACY: kept for backwards compatibility
router.post(
  '/venues/:venueId/kyc/resubmit',
  authenticateTokenMiddleware,
  documentUpload.fields([
    { name: 'ineUrl', maxCount: 1 },
    { name: 'rfcDocumentUrl', maxCount: 1 },
    { name: 'comprobanteDomicilioUrl', maxCount: 1 },
    { name: 'caratulaBancariaUrl', maxCount: 1 },
    { name: 'actaDocumentUrl', maxCount: 1 },
    { name: 'poderLegalUrl', maxCount: 1 },
  ]),
  venueKycController.resubmitKycDocuments,
)

// --- Feature Routes (Step 4 of Onboarding) ---
/**
 * @openapi
 * /api/v1/dashboard/features:
 *   get:
 *     tags: [Features]
 *     summary: Get all available features
 *     description: Returns list of all active features that venues can enable
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: List of available features
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: cuid
 *                       name:
 *                         type: string
 *                         description: Display name of the feature
 *                         example: Control de Inventario
 *                       code:
 *                         type: string
 *                         description: Unique feature code
 *                         example: INVENTORY_TRACKING
 *                       description:
 *                         type: string
 *                         description: Feature description
 *                         example: Sistema completo de gestión de inventario
 *                       category:
 *                         type: string
 *                         description: Feature category
 *                         example: OPERATIONS
 *                       active:
 *                         type: boolean
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.get('/features', authenticateTokenMiddleware, checkPermission('features:read'), featureController.getAvailableFeatures)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/features:
 *   get:
 *     tags: [Features]
 *     summary: Get venue's enabled features
 *     description: Returns features enabled for a specific venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: List of venue's enabled features
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: cuid
 *                       name:
 *                         type: string
 *                       code:
 *                         type: string
 *                       description:
 *                         type: string
 *                       category:
 *                         type: string
 *                       active:
 *                         type: boolean
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */
router.get('/venues/:venueId/features', authenticateTokenMiddleware, checkPermission('features:read'), featureController.getVenueFeatures)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/features:
 *   post:
 *     tags: [Features]
 *     summary: Save selected features for a venue
 *     description: Enables specified features for a venue during onboarding or feature management
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [featureIds]
 *             properties:
 *               featureIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: cuid
 *                 description: Array of feature IDs to enable for the venue
 *                 example: ["cm123abc456", "cm456def789"]
 *     responses:
 *       200:
 *         description: Features saved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: cuid
 *                       name:
 *                         type: string
 *                       code:
 *                         type: string
 *                       description:
 *                         type: string
 *                       category:
 *                         type: string
 *                       active:
 *                         type: boolean
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: Invalid or inactive feature IDs
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */
router.post(
  '/venues/:venueId/features',
  authenticateTokenMiddleware,
  checkPermission('features:write'),
  featureController.saveVenueFeatures,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/features/{featureId}/proration-preview:
 *   post:
 *     tags: [Features]
 *     summary: Preview proration for subscription change
 *     description: Calculate how much will be charged/credited when changing to a different feature tier
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: featureId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               newFeatureCode:
 *                 type: string
 *                 example: ANALYTICS_PRO
 *     responses:
 *       200:
 *         description: Proration preview calculated successfully
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */
router.post(
  '/venues/:venueId/features/:featureId/proration-preview',
  authenticateTokenMiddleware,
  checkPermission('features:read'),
  venueFeatureController.previewSubscriptionChange,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/features/{featureId}/subscription:
 *   put:
 *     tags: [Features]
 *     summary: Update subscription to new feature/price
 *     description: Change subscription to a different feature tier with automatic proration
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: featureId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               newFeatureCode:
 *                 type: string
 *                 example: ANALYTICS_PRO
 *     responses:
 *       200:
 *         description: Subscription updated successfully
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */
router.put(
  '/venues/:venueId/features/:featureId/subscription',
  authenticateTokenMiddleware,
  checkPermission('features:write'),
  venueFeatureController.updateSubscription,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/invoices:
 *   get:
 *     tags: [Billing]
 *     summary: Get Stripe invoices for a venue
 *     description: Retrieves all invoices from Stripe for the venue's organization
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: List of invoices retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     invoices:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           number:
 *                             type: string
 *                           created:
 *                             type: number
 *                           amount_due:
 *                             type: number
 *                           currency:
 *                             type: string
 *                           status:
 *                             type: string
 *                             enum: [paid, open, draft, uncollectible, void]
 *                           description:
 *                             type: string
 *                           invoice_pdf:
 *                             type: string
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */
router.get(
  '/venues/:venueId/invoices',
  authenticateTokenMiddleware,
  checkPermission('features:read'),
  venueFeatureController.getVenueInvoices,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/invoices/{invoiceId}/download:
 *   get:
 *     tags: [Billing]
 *     summary: Download invoice PDF
 *     description: Redirects to Stripe's hosted PDF for the invoice
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: invoiceId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       302:
 *         description: Redirects to invoice PDF URL
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */
router.get(
  '/venues/:venueId/invoices/:invoiceId/download',
  authenticateTokenMiddleware,
  checkPermission('features:read'),
  venueFeatureController.downloadInvoice,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/invoices/{invoiceId}/retry:
 *   post:
 *     tags: [Invoices]
 *     summary: Retry payment for failed invoice
 *     description: Manually retry payment for a failed invoice using the customer's default payment method
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: invoiceId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Payment retry successful
 *       400:
 *         description: Invoice cannot be paid or no payment method available
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 */
router.post(
  '/venues/:venueId/invoices/:invoiceId/retry',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  venueFeatureController.retryInvoicePayment,
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
router.get('/venues/:venueId/payments', authenticateTokenMiddleware, checkPermission('payments:read'), paymentController.getPaymentsData)

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
  checkPermission('orders:read'),
  orderController.getOrdersData, // Apunta al nuevo controlador
)

router.get(
  '/venues/:venueId/orders/:orderId', // Nueva ruta semántica
  authenticateTokenMiddleware,
  checkPermission('orders:read'),
  orderController.getOrder, // Apunta al nuevo controlador
)

router.put(
  '/venues/:venueId/orders/:orderId', // Nueva ruta semántica
  authenticateTokenMiddleware,
  checkPermission('orders:update'),
  orderController.updateOrder, // Apunta al nuevo controlador
)

router.delete(
  '/venues/:venueId/orders/:orderId',
  authenticateTokenMiddleware,
  checkPermission('orders:delete'),
  orderController.deleteOrder,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/orders/{orderId}/settle:
 *   post:
 *     summary: Settle a single order's pending balance
 *     description: Marks a pay-later order as paid and creates a payment record
 *     tags:
 *       - Dashboard - Orders
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: orderId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notes:
 *                 type: string
 *                 description: Optional notes about the settlement
 *     responses:
 *       200:
 *         description: Order settled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 orderId:
 *                   type: string
 *                 orderNumber:
 *                   type: string
 *                 settledAmount:
 *                   type: number
 *                 message:
 *                   type: string
 *       404:
 *         description: Order not found
 */
router.post(
  '/venues/:venueId/orders/:orderId/settle',
  authenticateTokenMiddleware,
  checkPermission('orders:update'), // Same permission as updating orders
  validateRequest(SettleOrderSchema),
  orderController.settleOrder,
)

router.get(
  '/venues/:venueId/payments/:paymentId',
  authenticateTokenMiddleware,
  checkPermission('payments:read'), // Allows WAITER+ to view payment details (read-only)
  paymentController.getPayment,
)

router.delete(
  '/venues/:venueId/payments/:paymentId',
  authenticateTokenMiddleware,
  checkPermission('payments:delete'), // SUPERADMIN only
  paymentController.deletePayment,
)

router.put(
  '/venues/:venueId/payments/:paymentId',
  authenticateTokenMiddleware,
  checkPermission('payments:update'), // SUPERADMIN only
  paymentController.updatePayment,
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
  checkPermission('payments:refund'), // Requires MANAGER+ to send receipts (administrative action)
  paymentController.sendPaymentReceipt,
)

router.get(
  '/venues/:venueId/payments/:paymentId/receipts',
  authenticateTokenMiddleware,
  checkPermission('payments:read'), // Allows WAITER+ to view payment receipts (read-only)
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
  checkPermission('payments:read'),
  paymentController.getReceiptById,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/available-balance:
 *   get:
 *     tags: [Available Balance]
 *     summary: Get available balance summary for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: from, in: query, schema: { type: string, format: date-time } }
 *       - { name: to, in: query, schema: { type: string, format: date-time } }
 *     responses:
 *       200:
 *         description: Available balance summary
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/available-balance',
  authenticateTokenMiddleware,
  checkPermission('settlements:read'),
  validateRequest(dateRangeQuerySchema),
  availableBalanceController.getAvailableBalance,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/available-balance/by-card-type:
 *   get:
 *     tags: [Available Balance]
 *     summary: Get balance breakdown by card type
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: from, in: query, schema: { type: string, format: date-time } }
 *       - { name: to, in: query, schema: { type: string, format: date-time } }
 *     responses:
 *       200:
 *         description: Balance breakdown by card type
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/available-balance/by-card-type',
  authenticateTokenMiddleware,
  checkPermission('settlements:read'),
  validateRequest(dateRangeQuerySchema),
  availableBalanceController.getBalanceByCardType,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/available-balance/timeline:
 *   get:
 *     tags: [Available Balance]
 *     summary: Get settlement timeline
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: from, in: query, required: true, schema: { type: string, format: date-time } }
 *       - { name: to, in: query, required: true, schema: { type: string, format: date-time } }
 *     responses:
 *       200:
 *         description: Settlement timeline
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/available-balance/timeline',
  authenticateTokenMiddleware,
  checkPermission('settlements:read'),
  validateRequest(timelineQuerySchema),
  availableBalanceController.getSettlementTimeline,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/available-balance/settlement-calendar:
 *   get:
 *     tags: [Available Balance]
 *     summary: Get settlement calendar - shows exactly how much will be deposited each day
 *     description: Groups transactions by settlement date to show daily deposit amounts
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: from, in: query, required: false, schema: { type: string, format: date-time }, description: "Start date (defaults to today)" }
 *       - { name: to, in: query, required: false, schema: { type: string, format: date-time }, description: "End date (defaults to 30 days from now)" }
 *     responses:
 *       200:
 *         description: Settlement calendar entries
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/available-balance/settlement-calendar',
  authenticateTokenMiddleware,
  checkPermission('settlements:read'),
  validateRequest(dateRangeQuerySchema),
  availableBalanceController.getSettlementCalendar,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/available-balance/simulate:
 *   post:
 *     tags: [Available Balance]
 *     summary: Simulate a transaction to see estimated settlement
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               amount:
 *                 type: number
 *               cardType:
 *                 type: string
 *                 enum: [DEBIT, CREDIT, AMEX, INTERNATIONAL, OTHER]
 *               transactionDate:
 *                 type: string
 *                 format: date-time
 *               transactionTime:
 *                 type: string
 *                 pattern: '^([01]\\d|2[0-3]):([0-5]\\d)$'
 *     responses:
 *       200:
 *         description: Simulation results
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/available-balance/simulate',
  authenticateTokenMiddleware,
  checkPermission('settlements:read'),
  validateRequest(simulateTransactionSchema),
  availableBalanceController.simulateTransaction,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/available-balance/projection:
 *   get:
 *     tags: [Available Balance]
 *     summary: Project future balance based on historical patterns
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: days, in: query, schema: { type: integer, minimum: 1, maximum: 30, default: 7 } }
 *     responses:
 *       200:
 *         description: Balance projection
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/available-balance/projection',
  authenticateTokenMiddleware,
  checkPermission('settlements:read'),
  validateRequest(balanceProjectionQuerySchema),
  availableBalanceController.getBalanceProjection,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/settlement-incidents:
 *   get:
 *     tags: [Settlement Incidents]
 *     summary: Get settlement incidents for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: status, in: query, schema: { type: string, enum: [pending, active, all] } }
 *     responses:
 *       200:
 *         description: List of settlement incidents
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/settlement-incidents',
  authenticateTokenMiddleware,
  checkPermission('settlements:read'),
  validateRequest(incidentListQuerySchema),
  settlementIncidentController.getVenueIncidents,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/settlement-incidents/stats:
 *   get:
 *     tags: [Settlement Incidents]
 *     summary: Get incident statistics for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       200:
 *         description: Incident statistics
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/settlement-incidents/stats',
  authenticateTokenMiddleware,
  checkPermission('settlements:read'),
  settlementIncidentController.getVenueIncidentStats,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/settlement-incidents/{incidentId}/confirm:
 *   post:
 *     tags: [Settlement Incidents]
 *     summary: Confirm whether a settlement arrived or not
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: incidentId, in: path, required: true, schema: { type: string, format: cuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [settlementArrived]
 *             properties:
 *               settlementArrived: { type: boolean }
 *               actualDate: { type: string, format: date-time }
 *               notes: { type: string, maxLength: 1000 }
 *     responses:
 *       200:
 *         description: Settlement incident confirmed
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/settlement-incidents/:incidentId/confirm',
  authenticateTokenMiddleware,
  checkPermission('settlements:write'),
  validateRequest(confirmIncidentSchema),
  settlementIncidentController.confirmIncident,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/settlement-incidents/bulk-confirm:
 *   post:
 *     tags: [Settlement Incidents]
 *     summary: Bulk confirm multiple settlement incidents
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [incidentIds, settlementArrived]
 *             properties:
 *               incidentIds: { type: array, items: { type: string, format: uuid }, minItems: 1, maxItems: 100 }
 *               settlementArrived: { type: boolean }
 *               actualDate: { type: string, format: date-time }
 *               notes: { type: string, maxLength: 1000 }
 *     responses:
 *       200:
 *         description: Bulk confirmation result
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/settlement-incidents/bulk-confirm',
  authenticateTokenMiddleware,
  checkPermission('settlements:write'),
  validateRequest(bulkConfirmIncidentSchema),
  settlementIncidentController.bulkConfirmIncidents,
)

// ==========================================
// CASH CLOSEOUT (CORTES DE CAJA) ROUTES
// ==========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/cash-closeouts/expected:
 *   get:
 *     tags: [Cash Closeout]
 *     summary: Get expected cash amount since last closeout
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Expected cash amount and period info
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/cash-closeouts/expected',
  authenticateTokenMiddleware,
  checkPermission('settlements:read'),
  cashCloseoutController.getExpectedCash,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/cash-closeouts:
 *   post:
 *     tags: [Cash Closeout]
 *     summary: Create a new cash closeout
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [actualAmount, depositMethod]
 *             properties:
 *               actualAmount: { type: number, minimum: 0 }
 *               depositMethod: { type: string, enum: [BANK_DEPOSIT, SAFE, OWNER_WITHDRAWAL, NEXT_SHIFT] }
 *               bankReference: { type: string, maxLength: 100 }
 *               notes: { type: string, maxLength: 1000 }
 *     responses:
 *       201:
 *         description: Cash closeout created successfully
 *       400: { $ref: '#/components/responses/ValidationError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/cash-closeouts',
  authenticateTokenMiddleware,
  checkPermission('settlements:write'),
  validateRequest(createCloseoutSchema),
  cashCloseoutController.createCloseout,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/cash-closeouts:
 *   get:
 *     tags: [Cash Closeout]
 *     summary: Get closeout history with pagination
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *       - { name: page, in: query, schema: { type: integer, default: 1 } }
 *       - { name: pageSize, in: query, schema: { type: integer, default: 10 } }
 *     responses:
 *       200:
 *         description: Paginated closeout history
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/cash-closeouts',
  authenticateTokenMiddleware,
  checkPermission('settlements:read'),
  validateRequest(closeoutHistoryQuerySchema),
  cashCloseoutController.getHistory,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/cash-closeouts/{closeoutId}:
 *   get:
 *     tags: [Cash Closeout]
 *     summary: Get a single closeout by ID
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *       - { name: closeoutId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Closeout details
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/cash-closeouts/:closeoutId',
  authenticateTokenMiddleware,
  checkPermission('settlements:read'),
  cashCloseoutController.getCloseoutById,
)

/**
 * @openapi
 * /api/v1/dashboard/superadmin/settlement-incidents:
 *   get:
 *     tags: [Settlement Incidents]
 *     summary: Get all settlement incidents (SuperAdmin only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: status, in: query, schema: { type: string, enum: [pending, active, all] } }
 *     responses:
 *       200:
 *         description: List of all settlement incidents
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/superadmin/settlement-incidents',
  authenticateTokenMiddleware,
  checkPermission('system:manage'),
  validateRequest(incidentListQuerySchema),
  settlementIncidentController.getAllIncidents,
)

/**
 * @openapi
 * /api/v1/dashboard/superadmin/settlement-incidents/stats:
 *   get:
 *     tags: [Settlement Incidents]
 *     summary: Get global incident statistics (SuperAdmin only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Global incident statistics
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/superadmin/settlement-incidents/stats',
  authenticateTokenMiddleware,
  checkPermission('system:manage'),
  settlementIncidentController.getGlobalIncidentStats,
)

/**
 * @openapi
 * /api/v1/dashboard/superadmin/settlement-incidents/{incidentId}/escalate:
 *   post:
 *     tags: [Settlement Incidents]
 *     summary: Escalate an incident (SuperAdmin only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: incidentId, in: path, required: true, schema: { type: string, format: cuid } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notes: { type: string, maxLength: 1000 }
 *     responses:
 *       200:
 *         description: Incident escalated
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/superadmin/settlement-incidents/:incidentId/escalate',
  authenticateTokenMiddleware,
  checkPermission('system:manage'),
  validateRequest(escalateIncidentSchema),
  settlementIncidentController.escalateIncident,
)

// Venue Payment Configuration routes (SUPERADMIN only)
router.use('/venues/:venueId/payment-config', authenticateTokenMiddleware, checkPermission('system:config'), venuePaymentConfigRoutes)

// E-commerce Merchant Management routes (OWNER, ADMIN)
router.use('/venues/:venueId/ecommerce-merchants', authenticateTokenMiddleware, ecommerceMerchantRoutes)

// Inventory Management routes (ADMIN and MANAGER)
router.use('/venues/:venueId/inventory', authenticateTokenMiddleware, inventoryRoutes)

// @temporary - Serialized Inventory Demo routes (delete after final implementation)
// For PlayTelecom SIM sales visualization demo
router.use('/venues/:venueId/serialized-inventory', authenticateTokenMiddleware, serializedInventoryRoutes)

// Command Center routes for PlayTelecom/White-Label dashboard
// Provides real-time KPIs, activity feeds, and operational insights
router.use('/venues/:venueId/command-center', commandCenterRoutes)

// Promoters Audit routes for PlayTelecom/White-Label dashboard
// Provides promoter tracking, attendance, sales stats, and deposit management
router.use('/venues/:venueId/promoters', promotersRoutes)

// Stock Dashboard routes for PlayTelecom/White-Label dashboard
// Provides stock metrics, charts, alerts, and bulk upload
router.use('/venues/:venueId/stock', stockDashboardRoutes)

// Organization Dashboard routes for PlayTelecom/White-Label dashboard
// Provides organization-level aggregate metrics and vision global
router.use('/organizations', organizationDashboardRoutes)

// Reports routes (ADMIN and OWNER)
router.use('/reports', authenticateTokenMiddleware, reportsRoutes)

// Commission routes (OWNER/ADMIN for config, STAFF for view own)
router.use('/commissions', authenticateTokenMiddleware, commissionRoutes)

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
router.get('/venues/:venueId/tpvs', authenticateTokenMiddleware, checkPermission('tpv:read'), tpvController.getTerminals)

// Create TPV (terminal)
router.post('/venues/:venueId/tpvs', authenticateTokenMiddleware, checkPermission('tpv:create'), tpvController.createTpv)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv/{tpvId}:
 *   get:
 *     tags: [TPV Management]
 *     summary: Get a specific terminal (TPV) by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: The venue ID
 *       - name: tpvId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: The TPV ID
 *     responses:
 *       200:
 *         description: Terminal retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Terminal'
 *       404:
 *         description: Terminal not found
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get('/venues/:venueId/tpv/:tpvId', authenticateTokenMiddleware, checkPermission('tpv:read'), tpvController.getTpvById)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv/{tpvId}:
 *   put:
 *     tags: [TPV Management]
 *     summary: Update a specific terminal (TPV)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: The venue ID
 *       - name: tpvId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: The TPV ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Terminal name
 *               version:
 *                 type: string
 *                 description: Terminal version
 *               serial:
 *                 type: string
 *                 description: Terminal serial number
 *               tradeMark:
 *                 type: string
 *                 description: Terminal brand/trademark
 *               model:
 *                 type: string
 *                 description: Terminal model
 *               idMenta:
 *                 type: string
 *                 description: Menta integration ID
 *               customerId:
 *                 type: string
 *                 description: Customer ID
 *               configuration:
 *                 type: string
 *                 description: Terminal configuration JSON
 *               status:
 *                 type: string
 *                 enum: [ACTIVE, INACTIVE, MAINTENANCE]
 *                 description: Terminal status
 *               type:
 *                 type: string
 *                 enum: [TPV_ANDROID, TPV_IOS, PRINTER_RECEIPT, PRINTER_KITCHEN, KDS]
 *                 description: Terminal type
 *     responses:
 *       200:
 *         description: Terminal updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Terminal'
 *       404:
 *         description: Terminal not found
 *       400:
 *         description: Invalid request data
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.put('/venues/:venueId/tpv/:tpvId', authenticateTokenMiddleware, checkPermission('tpv:update'), tpvController.updateTpv)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpvs/{tpvId}/activate:
 *   patch:
 *     tags: [TPV (Terminals)]
 *     summary: Activate a terminal by registering its hardware serial number
 *     description: |
 *       Activates a terminal by adding its physical hardware serial number.
 *       The terminal must be in PENDING_ACTIVATION status.
 *       Serial numbers must be unique across the system.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *         description: Venue ID
 *       - in: path
 *         name: tpvId
 *         required: true
 *         schema:
 *           type: string
 *         description: Terminal ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - serialNumber
 *             properties:
 *               serialNumber:
 *                 type: string
 *                 description: The hardware serial number printed on the physical device
 *                 example: "PAX-A910S-12345678"
 *     responses:
 *       200:
 *         description: Terminal activated successfully
 *       400:
 *         description: Bad request (invalid status, duplicate serial number, etc.)
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Terminal not found
 */
router.patch(
  '/venues/:venueId/tpvs/:tpvId/activate',
  authenticateTokenMiddleware,
  checkPermission('tpv:update'),
  tpvController.activateTerminal,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv/{tpvId}:
 *   delete:
 *     tags: [TPV (Terminals)]
 *     summary: Delete a terminal (only if not activated)
 *     description: |
 *       Deletes a terminal from the venue.
 *
 *       **IMPORTANT: Security Restrictions**
 *       - Can ONLY delete terminals that have NOT been activated
 *       - Activated terminals must be marked as RETIRED instead
 *       - This prevents accidental deletion of terminals with historical data
 *
 *       **Use Cases:**
 *       - Remove test/demo terminals before production
 *       - Delete incorrectly created terminals
 *       - Clean up terminals that were never deployed
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *         description: Venue ID
 *       - in: path
 *         name: tpvId
 *         required: true
 *         schema:
 *           type: string
 *         description: Terminal ID to delete
 *     responses:
 *       200:
 *         description: Terminal deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Terminal eliminada exitosamente"
 *       400:
 *         description: Cannot delete activated terminal
 *       404:
 *         description: Terminal not found
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.delete('/venues/:venueId/tpv/:tpvId', authenticateTokenMiddleware, checkPermission('tpv:delete'), tpvController.deleteTpv)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv/{tpvId}/deactivate:
 *   patch:
 *     tags: [TPV]
 *     summary: Deactivate terminal (SUPERADMIN only)
 *     description: |
 *       Clears the activatedAt field to deactivate a terminal.
 *       This allows generating a new activation code for the terminal.
 *
 *       **SUPERADMIN ONLY**: Only users with SUPERADMIN role can deactivate terminals.
 *
 *       **Use Cases:**
 *       - Terminal needs to be reassigned to a different device
 *       - Terminal activation was done incorrectly
 *       - Device was lost/stolen and needs reactivation with new device
 *
 *       **Note:** This does NOT delete the terminal or its historical data.
 *       After deactivation, a new activation code can be generated.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *         description: Venue ID
 *       - in: path
 *         name: tpvId
 *         required: true
 *         schema:
 *           type: string
 *         description: Terminal ID to deactivate
 *     responses:
 *       200:
 *         description: Terminal deactivated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Terminal desactivada exitosamente"
 *                 data:
 *                   type: object
 *                   description: Updated terminal object with activatedAt set to null
 *       400:
 *         description: Terminal is not activated
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - SUPERADMIN role required
 *       404:
 *         description: Terminal not found
 */
router.patch(
  '/venues/:venueId/tpv/:tpvId/deactivate',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.SUPERADMIN]),
  tpvController.deactivateTpv,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv/{terminalId}/activation-code:
 *   post:
 *     tags: [TPV Activation]
 *     summary: Generate activation code for terminal
 *     description: |
 *       Generates a 6-character alphanumeric activation code for terminal activation.
 *       Similar to Square POS device activation flow.
 *
 *       **Process:**
 *       1. Admin clicks "Generate Code" for a terminal in dashboard
 *       2. System generates secure 6-char code (e.g., A3F9K2)
 *       3. Code expires in 7 days
 *       4. Admin shares code with staff
 *       5. Staff enters code in Android app to activate terminal
 *
 *       **Security:**
 *       - Requires 'tpv:update' permission
 *       - Code expires after 7 days
 *       - Single-use codes (cleared after activation)
 *       - Cannot generate code for already activated terminal
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *         description: Venue ID
 *       - in: path
 *         name: terminalId
 *         required: true
 *         schema:
 *           type: string
 *         description: Terminal ID
 *     responses:
 *       200:
 *         description: Activation code generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 activationCode:
 *                   type: string
 *                   description: 6-character activation code
 *                   example: "A3F9K2"
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                   description: Code expiration timestamp
 *                 expiresIn:
 *                   type: number
 *                   description: Seconds until expiration (604800 = 7 days)
 *                 terminalId:
 *                   type: string
 *                   format: cuid
 *                 serialNumber:
 *                   type: string
 *                   description: Terminal serial number
 *                 venueName:
 *                   type: string
 *                   description: Venue name
 *       400:
 *         description: Bad request (terminal already activated)
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden (missing tpv:update permission)
 *       404:
 *         description: Terminal not found
 */
router.post(
  '/venues/:venueId/tpv/:terminalId/activation-code',
  authenticateTokenMiddleware,
  checkPermission('tpv:update'),
  validateRequest(generateActivationCodeSchema),
  tpvController.generateActivationCode,
)

/**
 * @openapi
 * /api/v1/dashboard/tpv/{tpvId}/settings:
 *   get:
 *     tags: [TPV Settings]
 *     summary: Get TPV settings for a specific terminal
 *     description: |
 *       Retrieves the configuration settings for a terminal's payment flow screens.
 *       Each terminal can have its own configuration (e.g., one terminal with tips, another without).
 *
 *       Returns default settings if none have been customized.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: tpvId
 *         required: true
 *         schema:
 *           type: string
 *         description: Terminal ID
 *     responses:
 *       200:
 *         description: Settings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 showReviewScreen:
 *                   type: boolean
 *                 showTipScreen:
 *                   type: boolean
 *                 showReceiptScreen:
 *                   type: boolean
 *                 defaultTipPercentage:
 *                   type: number
 *                   nullable: true
 *                 tipSuggestions:
 *                   type: array
 *                   items:
 *                     type: number
 *                 requirePinLogin:
 *                   type: boolean
 *       403:
 *         description: Forbidden (missing tpv-settings:read permission)
 *       404:
 *         description: Terminal not found
 */
router.get('/tpv/:tpvId/settings', authenticateTokenMiddleware, checkPermission('tpv-settings:read'), tpvController.getTpvSettings)

/**
 * @openapi
 * /api/v1/dashboard/tpv/{tpvId}/settings:
 *   put:
 *     tags: [TPV Settings]
 *     summary: Update TPV settings for a specific terminal
 *     description: |
 *       Updates the configuration settings for a terminal's payment flow screens.
 *       Performs partial update - only provided fields are updated.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: tpvId
 *         required: true
 *         schema:
 *           type: string
 *         description: Terminal ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               showReviewScreen:
 *                 type: boolean
 *               showTipScreen:
 *                 type: boolean
 *               showReceiptScreen:
 *                 type: boolean
 *               defaultTipPercentage:
 *                 type: number
 *                 nullable: true
 *               tipSuggestions:
 *                 type: array
 *                 items:
 *                   type: number
 *               requirePinLogin:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 showReviewScreen:
 *                   type: boolean
 *                 showTipScreen:
 *                   type: boolean
 *                 showReceiptScreen:
 *                   type: boolean
 *                 defaultTipPercentage:
 *                   type: number
 *                   nullable: true
 *                 tipSuggestions:
 *                   type: array
 *                   items:
 *                     type: number
 *                 requirePinLogin:
 *                   type: boolean
 *       403:
 *         description: Forbidden (missing tpv-settings:update permission)
 *       404:
 *         description: Terminal not found
 */
router.put('/tpv/:tpvId/settings', authenticateTokenMiddleware, checkPermission('tpv-settings:update'), tpvController.updateTpvSettings)

/**
 * @openapi
 * /api/v1/dashboard/tpv/{tpvId}/merchants:
 *   get:
 *     tags: [TPV Settings]
 *     summary: Get merchants assigned to a terminal
 *     description: |
 *       Returns the list of merchant accounts assigned to this terminal.
 *       Used for kiosk default merchant selection in Dashboard settings.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: tpvId
 *         required: true
 *         schema:
 *           type: string
 *         description: Terminal ID
 *     responses:
 *       200:
 *         description: List of assigned merchants
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
 *                       id:
 *                         type: string
 *                       displayName:
 *                         type: string
 *                       active:
 *                         type: boolean
 *       401:
 *         description: Unauthorized (missing or invalid token)
 *       403:
 *         description: Forbidden (missing tpv-settings:read permission)
 *       404:
 *         description: Terminal not found
 */
router.get('/tpv/:tpvId/merchants', authenticateTokenMiddleware, checkPermission('tpv-settings:read'), tpvController.getTerminalMerchants)

// Heartbeat endpoint moved to tpv.routes.ts (unauthenticated endpoint for terminal health monitoring)

/**
 * @openapi
 * /api/v1/dashboard/tpv/{terminalId}/command:
 *   post:
 *     tags: [TPV Commands]
 *     summary: Send command to TPV terminal
 *     description: Send remote commands to TPV terminals for maintenance, updates, or control
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: terminalId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID or serial number of the terminal
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               command:
 *                 type: string
 *                 enum: [SHUTDOWN, RESTART, MAINTENANCE_MODE, UPDATE_STATUS]
 *                 description: Command to send to terminal
 *               payload:
 *                 type: object
 *                 description: Optional command payload
 *             required:
 *               - command
 *     responses:
 *       200:
 *         description: Command sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *       400:
 *         description: Invalid command data
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: Terminal not found or offline
 */
router.post('/tpv/:terminalId/command', authenticateTokenMiddleware, checkPermission('tpv:command'), tpvController.sendTpvCommand)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpvs/health:
 *   get:
 *     tags: [TPV Health]
 *     summary: Get health summary for all terminals in venue
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: The venue ID
 *     responses:
 *       200:
 *         description: Health summary retrieved successfully
 *       403:
 *         description: Forbidden
 */
router.get('/venues/:venueId/tpvs/health', authenticateTokenMiddleware, checkPermission('tpv:read'), tpvController.getVenueTerminalHealth)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv/{tpvId}/health:
 *   get:
 *     tags: [TPV Health]
 *     summary: Get detailed health info for specific terminal
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: The venue ID
 *       - name: tpvId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: The terminal ID
 *     responses:
 *       200:
 *         description: Terminal health retrieved successfully
 *       404:
 *         description: Terminal not found
 *       403:
 *         description: Forbidden
 */
router.get('/venues/:venueId/tpv/:tpvId/health', authenticateTokenMiddleware, checkPermission('tpv:read'), tpvController.getTerminalHealth)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv/{tpvId}/command:
 *   post:
 *     tags: [TPV Health]
 *     summary: Send command to TPV terminal
 *     description: Send control commands to TPV terminals (SUPERADMIN, ADMIN, OWNER only)
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: The venue ID
 *       - name: tpvId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: The terminal ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               command:
 *                 type: object
 *                 properties:
 *                   type:
 *                     type: string
 *                     enum: [SHUTDOWN, RESTART, MAINTENANCE_MODE, UPDATE_STATUS]
 *                   payload:
 *                     type: object
 *                     description: Optional command payload
 *     responses:
 *       200:
 *         description: Command sent successfully
 *       403:
 *         description: Forbidden - insufficient permissions
 *       404:
 *         description: Terminal not found or offline
 */
router.post(
  '/venues/:venueId/tpv/:tpvId/command',
  authenticateTokenMiddleware,
  checkPermission('tpv:command'),
  tpvController.sendTpvCommand,
)

// =====================================================
// TPV COMMAND QUEUE ROUTES (Enterprise Remote Command System)
// =====================================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands:
 *   post:
 *     tags: [TPV Remote Commands]
 *     summary: Send a remote command to a TPV terminal
 *     description: |
 *       Queue a command for delivery to a TPV terminal.
 *       Commands are queued if terminal is offline and delivered when it reconnects.
 *       High-risk commands (REMOTE_WIPE, FACTORY_RESET, LOCK) require PIN confirmation.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: The venue ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - terminalId
 *               - commandType
 *             properties:
 *               terminalId:
 *                 type: string
 *                 description: Target terminal ID
 *               commandType:
 *                 type: string
 *                 enum: [RESTART, SHUTDOWN, LOCK, UNLOCK, REMOTE_WIPE, FACTORY_RESET, SYNC_MENU, UPDATE_CONFIG, CLEAR_CACHE, REFRESH_AUTH, PRINT_TEST, SCREENSHOT, LOG_UPLOAD, FORCE_UPDATE, ENTER_MAINTENANCE, EXIT_MAINTENANCE, SET_BRIGHTNESS, MUTE_AUDIO]
 *               priority:
 *                 type: string
 *                 enum: [LOW, NORMAL, HIGH, CRITICAL]
 *                 default: NORMAL
 *               payload:
 *                 type: object
 *                 description: Command-specific payload
 *               confirmationPin:
 *                 type: string
 *                 description: 4-digit PIN for high-risk commands
 *               scheduledFor:
 *                 type: string
 *                 format: date-time
 *                 description: Schedule command for future execution
 *     responses:
 *       201:
 *         description: Command queued successfully
 *       400:
 *         description: Invalid command data or PIN required
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 */
router.post(
  '/venues/:venueId/tpv-commands',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:write'),
  validateRequest(sendCommandSchema),
  tpvCommandController.sendCommand,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands:
 *   get:
 *     tags: [TPV Remote Commands]
 *     summary: List commands for venue terminals
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: terminalId
 *         in: query
 *         schema:
 *           type: string
 *         description: Filter by terminal ID
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *           enum: [PENDING, QUEUED, SENT, RECEIVED, EXECUTING, COMPLETED, FAILED, CANCELLED, EXPIRED]
 *       - name: commandType
 *         in: query
 *         schema:
 *           type: string
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Commands retrieved successfully
 */
router.get(
  '/venues/:venueId/tpv-commands',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:read'),
  validateRequest(commandsQuerySchema),
  tpvCommandController.getCommands as any,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/bulk:
 *   post:
 *     tags: [TPV Remote Commands]
 *     summary: Send bulk command to multiple terminals
 *     description: Execute the same command across multiple terminals simultaneously
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - terminalIds
 *               - commandType
 *             properties:
 *               terminalIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 maxItems: 50
 *               commandType:
 *                 type: string
 *               payload:
 *                 type: object
 *               confirmationPin:
 *                 type: string
 *     responses:
 *       201:
 *         description: Bulk operation created successfully
 *       400:
 *         description: Invalid request (FACTORY_RESET not allowed in bulk)
 */
router.post(
  '/venues/:venueId/tpv-commands/bulk',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:bulk'),
  validateRequest(bulkCommandSchema),
  tpvCommandController.sendBulkCommand,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/bulk-operations:
 *   get:
 *     tags: [TPV Remote Commands]
 *     summary: List bulk command operations
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *           enum: [PENDING, IN_PROGRESS, COMPLETED, PARTIALLY_COMPLETED, FAILED, CANCELLED]
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Bulk operations retrieved successfully
 */
router.get(
  '/venues/:venueId/tpv-commands/bulk-operations',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:read'),
  validateRequest(bulkOperationsQuerySchema),
  tpvCommandController.getBulkOperations as any,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/bulk-operations/{operationId}:
 *   get:
 *     tags: [TPV Remote Commands]
 *     summary: Get bulk operation details
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: operationId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Bulk operation details
 *       404:
 *         description: Operation not found
 */
router.get(
  '/venues/:venueId/tpv-commands/bulk-operations/:operationId',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:read'),
  tpvCommandController.getBulkOperationStatus,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/history:
 *   get:
 *     tags: [TPV Remote Commands]
 *     summary: Get command execution history
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: terminalId
 *         in: query
 *         schema:
 *           type: string
 *       - name: fromDate
 *         in: query
 *         schema:
 *           type: string
 *           format: date-time
 *       - name: toDate
 *         in: query
 *         schema:
 *           type: string
 *           format: date-time
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Command history retrieved successfully
 */
router.get(
  '/venues/:venueId/tpv-commands/history',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:read'),
  validateRequest(commandHistoryQuerySchema),
  tpvCommandController.getCommandHistory as any,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/{commandId}:
 *   get:
 *     tags: [TPV Remote Commands]
 *     summary: Get command status and details
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: commandId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Command details retrieved
 *       404:
 *         description: Command not found
 */
router.get(
  '/venues/:venueId/tpv-commands/:commandId',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:read'),
  tpvCommandController.getCommandStatus,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/{commandId}/cancel:
 *   post:
 *     tags: [TPV Remote Commands]
 *     summary: Cancel a pending or queued command
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: commandId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Optional cancellation reason
 *     responses:
 *       200:
 *         description: Command cancelled successfully
 *       400:
 *         description: Command cannot be cancelled (already completed/executing)
 */
router.post(
  '/venues/:venueId/tpv-commands/:commandId/cancel',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:write'),
  tpvCommandController.cancelCommand,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/{commandId}/retry:
 *   post:
 *     tags: [TPV Remote Commands]
 *     summary: Retry a failed or expired command
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: commandId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       201:
 *         description: Command retried successfully
 *       400:
 *         description: Command cannot be retried
 */
router.post(
  '/venues/:venueId/tpv-commands/:commandId/retry',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:write'),
  tpvCommandController.retryCommand,
)

// =====================================================
// SCHEDULED COMMANDS ROUTES
// =====================================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/scheduled:
 *   post:
 *     tags: [TPV Remote Commands - Scheduling]
 *     summary: Create a scheduled command
 *     description: Schedule a recurring or one-time command (e.g., restart every night at 3am)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - terminalIds
 *               - commandType
 *               - cronExpression
 *             properties:
 *               name:
 *                 type: string
 *               terminalIds:
 *                 type: array
 *                 items:
 *                   type: string
 *               commandType:
 *                 type: string
 *               cronExpression:
 *                 type: string
 *                 description: Cron expression (e.g., "0 3 * * *" for 3am daily)
 *               timezone:
 *                 type: string
 *                 default: UTC
 *               payload:
 *                 type: object
 *               enabled:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       201:
 *         description: Scheduled command created
 */
router.post(
  '/venues/:venueId/tpv-commands/scheduled',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:schedule'),
  validateRequest(createScheduledCommandSchema),
  tpvCommandController.createScheduledCommand,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/scheduled:
 *   get:
 *     tags: [TPV Remote Commands - Scheduling]
 *     summary: List scheduled commands
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: enabled
 *         in: query
 *         schema:
 *           type: boolean
 *       - name: terminalId
 *         in: query
 *         schema:
 *           type: string
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Scheduled commands retrieved
 */
router.get(
  '/venues/:venueId/tpv-commands/scheduled',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:read'),
  validateRequest(scheduledCommandsQuerySchema),
  tpvCommandController.getScheduledCommands as any,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/scheduled/{scheduleId}:
 *   get:
 *     tags: [TPV Remote Commands - Scheduling]
 *     summary: Get scheduled command details
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: scheduleId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Scheduled command details
 *       404:
 *         description: Schedule not found
 */
router.get(
  '/venues/:venueId/tpv-commands/scheduled/:scheduleId',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:read'),
  tpvCommandController.getScheduledCommand,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/scheduled/{scheduleId}:
 *   put:
 *     tags: [TPV Remote Commands - Scheduling]
 *     summary: Update a scheduled command
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: scheduleId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               cronExpression:
 *                 type: string
 *               enabled:
 *                 type: boolean
 *               payload:
 *                 type: object
 *     responses:
 *       200:
 *         description: Scheduled command updated
 *       404:
 *         description: Schedule not found
 */
router.put(
  '/venues/:venueId/tpv-commands/scheduled/:scheduleId',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:schedule'),
  validateRequest(updateScheduledCommandSchema),
  tpvCommandController.updateScheduledCommand,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/scheduled/{scheduleId}:
 *   delete:
 *     tags: [TPV Remote Commands - Scheduling]
 *     summary: Delete a scheduled command
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: scheduleId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Scheduled command deleted
 *       404:
 *         description: Schedule not found
 */
router.delete(
  '/venues/:venueId/tpv-commands/scheduled/:scheduleId',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:schedule'),
  tpvCommandController.deleteScheduledCommand,
)

// =====================================================
// GEOFENCE RULES ROUTES
// =====================================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/geofence:
 *   post:
 *     tags: [TPV Remote Commands - Geofencing]
 *     summary: Create a geofence rule
 *     description: |
 *       Create location-based command rules (e.g., lock terminal if moved outside venue).
 *       Requires terminal GPS location reporting.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - terminalIds
 *               - latitude
 *               - longitude
 *               - radiusMeters
 *               - triggerOn
 *               - commandType
 *             properties:
 *               name:
 *                 type: string
 *               terminalIds:
 *                 type: array
 *                 items:
 *                   type: string
 *               latitude:
 *                 type: number
 *                 format: double
 *               longitude:
 *                 type: number
 *                 format: double
 *               radiusMeters:
 *                 type: integer
 *                 minimum: 10
 *                 maximum: 10000
 *               triggerOn:
 *                 type: string
 *                 enum: [EXIT, ENTER]
 *               commandType:
 *                 type: string
 *     responses:
 *       201:
 *         description: Geofence rule created
 */
router.post(
  '/venues/:venueId/tpv-commands/geofence',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:geofence'),
  validateRequest(createGeofenceRuleSchema),
  tpvCommandController.createGeofenceRule,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/geofence:
 *   get:
 *     tags: [TPV Remote Commands - Geofencing]
 *     summary: List geofence rules
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: enabled
 *         in: query
 *         schema:
 *           type: boolean
 *       - name: terminalId
 *         in: query
 *         schema:
 *           type: string
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Geofence rules retrieved
 */
router.get(
  '/venues/:venueId/tpv-commands/geofence',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:read'),
  validateRequest(geofenceRulesQuerySchema),
  tpvCommandController.getGeofenceRules as any,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/geofence/{ruleId}:
 *   get:
 *     tags: [TPV Remote Commands - Geofencing]
 *     summary: Get geofence rule details
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: ruleId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Geofence rule details
 *       404:
 *         description: Rule not found
 */
router.get(
  '/venues/:venueId/tpv-commands/geofence/:ruleId',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:read'),
  tpvCommandController.getGeofenceRule,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/geofence/{ruleId}:
 *   put:
 *     tags: [TPV Remote Commands - Geofencing]
 *     summary: Update a geofence rule
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: ruleId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               radiusMeters:
 *                 type: integer
 *               enabled:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Geofence rule updated
 *       404:
 *         description: Rule not found
 */
router.put(
  '/venues/:venueId/tpv-commands/geofence/:ruleId',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:geofence'),
  validateRequest(updateGeofenceRuleSchema),
  tpvCommandController.updateGeofenceRule,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/tpv-commands/geofence/{ruleId}:
 *   delete:
 *     tags: [TPV Remote Commands - Geofencing]
 *     summary: Delete a geofence rule
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: ruleId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Geofence rule deleted
 *       404:
 *         description: Rule not found
 */
router.delete(
  '/venues/:venueId/tpv-commands/geofence/:ruleId',
  authenticateTokenMiddleware,
  checkPermission('tpv-commands:geofence'),
  tpvCommandController.deleteGeofenceRule,
)

// =====================================================
// TERMINAL ACK/RESULT HANDLERS (Internal use from Socket.IO)
// =====================================================

/**
 * @openapi
 * /api/v1/dashboard/tpv-commands/{commandId}/ack:
 *   post:
 *     tags: [TPV Remote Commands - Terminal Handlers]
 *     summary: Handle command acknowledgment from terminal
 *     description: Internal endpoint called when terminal receives and acknowledges a command
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: commandId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - terminalId
 *             properties:
 *               terminalId:
 *                 type: string
 *               receivedAt:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: ACK processed
 */
router.post(
  '/tpv-commands/:commandId/ack',
  authenticateTokenMiddleware,
  validateRequest(terminalAckSchema),
  tpvCommandController.handleCommandAck,
)

/**
 * @openapi
 * /api/v1/dashboard/tpv-commands/{commandId}/result:
 *   post:
 *     tags: [TPV Remote Commands - Terminal Handlers]
 *     summary: Handle command execution result from terminal
 *     description: Internal endpoint called when terminal finishes executing a command
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: commandId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - terminalId
 *               - resultStatus
 *             properties:
 *               terminalId:
 *                 type: string
 *               resultStatus:
 *                 type: string
 *                 enum: [SUCCESS, FAILED, PARTIAL, TIMEOUT, REJECTED, REQUIRES_PIN]
 *               message:
 *                 type: string
 *               resultData:
 *                 type: object
 *     responses:
 *       200:
 *         description: Result processed
 */
router.post(
  '/tpv-commands/:commandId/result',
  authenticateTokenMiddleware,
  validateRequest(terminalResultSchema),
  tpvCommandController.handleCommandResult,
)

// =====================================================
// END TPV COMMAND QUEUE ROUTES
// =====================================================

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
  checkPermission('analytics:read'),
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
  checkPermission('analytics:read'),
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
  checkPermission('analytics:read'),
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
  checkPermission('analytics:read'),
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
  checkPermission('menu:read'),
  validateRequest(MenuQuerySchema),
  menuController.getMenusHandler,
)

router.post(
  '/venues/:venueId/menus',
  authenticateTokenMiddleware,
  checkPermission('menu:create'),
  validateRequest(CreateMenuSchema),
  menuController.createMenuHandler,
)

router.get(
  '/venues/:venueId/menus/:menuId',
  authenticateTokenMiddleware,
  checkPermission('menu:read'),
  validateRequest(GetMenuParamsSchema),
  menuController.getMenuHandler,
)

router.patch(
  '/venues/:venueId/menus/:menuId',
  authenticateTokenMiddleware,
  checkPermission('menu:update'),
  validateRequest(UpdateMenuSchema),
  menuController.updateMenuHandler,
)

router.delete(
  '/venues/:venueId/menus/:menuId',
  authenticateTokenMiddleware,
  checkPermission('menu:delete'),
  validateRequest(GetMenuParamsSchema),
  menuController.deleteMenuHandler,
)

router.post(
  '/venues/:venueId/menus/:menuId/clone',
  authenticateTokenMiddleware,
  checkPermission('menu:create'),
  validateRequest(CloneMenuSchema),
  menuController.cloneMenuHandler,
)

router.post(
  '/venues/:venueId/menus/reorder',
  authenticateTokenMiddleware,
  checkPermission('menu:update'),
  validateRequest(ReorderMenusSchema),
  menuController.reorderMenusHandler,
)

router.put(
  '/venues/:venueId/products/reorder',
  authenticateTokenMiddleware,
  checkPermission('menu:update'),
  validateRequest(ReorderProductsSchema),
  menuController.reorderProductsHandler,
)

router.post(
  '/venues/:venueId/menu/import',
  authenticateTokenMiddleware,
  checkPermission('menu:import'),
  validateRequest(ImportMenuSchema),
  menuController.importMenuHandler,
)

// Menu-Category assignments
router.post(
  '/venues/:venueId/menus/:menuId/categories',
  authenticateTokenMiddleware,
  checkPermission('menu:update'),
  validateRequest(AssignCategoryToMenuSchema),
  menuController.assignCategoryToMenuHandler,
)

router.delete(
  '/venues/:venueId/menus/:menuId/categories/:categoryId',
  authenticateTokenMiddleware,
  checkPermission('menu:update'),
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
  checkPermission('menu:read'),
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
  checkPermission('menu:create'),
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
  checkPermission('menu:read'),
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
  checkPermission('menu:update'),
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
  checkPermission('menu:update'),
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
  checkPermission('menu:delete'),
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
  checkPermission('menu:read'),
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
  checkPermission('menu:create'),
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
  checkPermission('menu:read'),
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
  checkPermission('menu:update'),
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
  checkPermission('menu:update'),
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
  checkPermission('menu:delete'),
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
  checkPermission('menu:update'),
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
  checkPermission('menu:update'),
  validateRequest(RemoveModifierGroupFromProductParamsSchema),
  menuController.removeModifierGroupFromProductHandler,
)

// ==========================================
// MODIFIER INVENTORY ANALYTICS ROUTES
// ==========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/modifiers/inventory/usage:
 *   get:
 *     tags: [Modifier Inventory]
 *     summary: Get modifier usage statistics
 *     description: Returns usage statistics for modifiers including times used, quantity consumed, and cost impact
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string, format: cuid }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: modifierGroupId
 *         schema: { type: string, format: cuid }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Modifier usage statistics
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get(
  '/venues/:venueId/modifiers/inventory/usage',
  authenticateTokenMiddleware,
  checkPermission('inventory:read'),
  validateRequest(GetModifierUsageStatsSchema),
  modifierInventoryAnalyticsController.getModifierUsageStatsHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/modifiers/inventory/low-stock:
 *   get:
 *     tags: [Modifier Inventory]
 *     summary: Get modifiers with low stock raw materials
 *     description: Returns modifiers whose linked raw materials are at or below reorder point
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     responses:
 *       200:
 *         description: Low stock modifiers
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get(
  '/venues/:venueId/modifiers/inventory/low-stock',
  authenticateTokenMiddleware,
  checkPermission('inventory:read'),
  validateRequest(GetModifiersLowStockSchema),
  modifierInventoryAnalyticsController.getModifiersLowStockHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/modifiers/inventory/summary:
 *   get:
 *     tags: [Modifier Inventory]
 *     summary: Get modifier inventory summary
 *     description: Returns comprehensive summary including total modifiers with inventory, low stock count, cost impact
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string, format: cuid }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Modifier inventory summary
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get(
  '/venues/:venueId/modifiers/inventory/summary',
  authenticateTokenMiddleware,
  checkPermission('inventory:read'),
  validateRequest(GetModifierInventorySummarySchema),
  modifierInventoryAnalyticsController.getModifierInventorySummaryHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/modifiers/inventory/list:
 *   get:
 *     tags: [Modifier Inventory]
 *     summary: List all modifiers with inventory configuration
 *     description: Returns all modifiers with their inventory tracking configuration
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string, format: cuid }
 *       - in: query
 *         name: includeInactive
 *         schema: { type: boolean, default: false }
 *       - in: query
 *         name: groupId
 *         schema: { type: string, format: cuid }
 *     responses:
 *       200:
 *         description: List of modifiers with inventory configuration
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get(
  '/venues/:venueId/modifiers/inventory/list',
  authenticateTokenMiddleware,
  checkPermission('inventory:read'),
  validateRequest(GetModifiersWithInventorySchema),
  modifierInventoryAnalyticsController.getModifiersWithInventoryHandler,
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
  checkPermission('menu:read'),
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
  checkPermission('menu:create'),
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
  checkPermission('menu:read'),
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
  checkPermission('menu:update'),
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
  checkPermission('menu:delete'),
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
  checkPermission('menu:update'),
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
  checkPermission('teams:read'),
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
  checkPermission('teams:invite'),
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
  checkPermission('teams:read'),
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
  checkPermission('teams:delete'),
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
  checkPermission('teams:invite'),
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
  checkPermission('teams:read'),
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
  checkPermission('teams:update'),
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
  checkPermission('teams:delete'),
  validateRequest(TeamMemberParamsSchema),
  teamController.removeTeamMember,
)

/**
 * @openapi
 * /api/v2/dashboard/{venueId}/team/{teamMemberId}/hard-delete:
 *   delete:
 *     tags: [Team]
 *     summary: Hard delete team member (SUPERADMIN only)
 *     description: |
 *       **SUPERADMIN ONLY**: Permanently deletes ALL data associated with a team member.
 *       This includes: commission calculations, commission payouts, milestone progress,
 *       tip distributions, commission overrides, and the staff venue record itself.
 *
 *       WARNING: This action is IRREVERSIBLE. Use only for:
 *       - GDPR "right to be forgotten" requests
 *       - Removing test/demo data
 *       - Legal compliance requirements
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
 *             required: [confirmDeletion]
 *             properties:
 *               confirmDeletion:
 *                 type: boolean
 *                 description: Must be explicitly set to true to confirm permanent deletion
 *     responses:
 *       200:
 *         description: Team member permanently deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 deletedRecords:
 *                   type: object
 *                   description: Count of deleted records per table
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403:
 *         description: Forbidden - SUPERADMIN role required
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.delete(
  '/venues/:venueId/team/:teamMemberId/hard-delete',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.SUPERADMIN]),
  validateRequest(TeamMemberParamsSchema),
  teamController.hardDeleteTeamMember,
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
router.get('/venues/:venueId/shifts', authenticateTokenMiddleware, checkPermission('shifts:read'), shiftController.getShifts)

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
router.get('/venues/:venueId/shifts/:shiftId', authenticateTokenMiddleware, checkPermission('shifts:read'), shiftController.getShift)

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
router.get('/venues/:venueId/shifts/summary', authenticateTokenMiddleware, checkPermission('shifts:read'), shiftController.getShiftsSummary)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/shifts/{shiftId}:
 *   delete:
 *     tags: [Shifts]
 *     summary: Delete a shift
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string, format: cuid } }
 *       - { name: shiftId, in: path, required: true, schema: { type: string, format: cuid } }
 *     responses:
 *       204:
 *         description: Shift deleted successfully
 *       400:
 *         description: Cannot delete open shift
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.delete(
  '/venues/:venueId/shifts/:shiftId',
  authenticateTokenMiddleware,
  checkPermission('shifts:delete'),
  shiftController.deleteShift,
)

router.put(
  '/venues/:venueId/shifts/:shiftId',
  authenticateTokenMiddleware,
  checkPermission('shifts:update'), // SUPERADMIN only
  shiftController.updateShift,
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
router.post('/notifications', authenticateTokenMiddleware, checkPermission('notifications:send'), notificationController.createNotification)

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
  checkPermission('notifications:send'),
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
  checkPermission('notifications:send'),
  notificationController.sendVenueNotification,
)

// ==========================================
// ASSISTANT AI ROUTES
// ==========================================

/**
 * @openapi
 * /api/v1/dashboard/assistant/query:
 *   post:
 *     tags: [AI Assistant]
 *     summary: Process a query with the AI assistant
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - message
 *             properties:
 *               message:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 2000
 *                 description: The query message for the assistant
 *               conversationHistory:
 *                 type: array
 *                 maxItems: 50
 *                 items:
 *                   type: object
 *                   properties:
 *                     role:
 *                       type: string
 *                       enum: [user, assistant]
 *                     content:
 *                       type: string
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *     responses:
 *       200:
 *         description: Assistant response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     response: { type: string }
 *                     suggestions:
 *                       type: array
 *                       items: { type: string }
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       500: { $ref: '#/components/responses/InternalServerError' }
 */
router.post(
  '/assistant/query',
  authenticateTokenMiddleware,
  validateRequest(assistantQuerySchema),
  assistantController.processAssistantQuery,
)

/**
 * @openapi
 * /api/v1/dashboard/assistant/generate-title:
 *   post:
 *     tags: [AI Assistant]
 *     summary: Generate a conversation title using LLM
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - conversationSummary
 *             properties:
 *               conversationSummary:
 *                 type: string
 *                 description: Summary of the conversation messages
 *                 example: "Usuario: ¿Cuáles fueron las ventas de hoy?\nAsistente: Las ventas de hoy fueron $1,250 MXN..."
 *     responses:
 *       200:
 *         description: Title generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     title:
 *                       type: string
 *                       example: "Ventas de hoy"
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       500: { $ref: '#/components/responses/InternalServerError' }
 */
router.post('/assistant/generate-title', authenticateTokenMiddleware, assistantController.generateConversationTitle)

/**
 * @openapi
 * /api/v1/dashboard/assistant/text-to-sql:
 *   post:
 *     tags: [AI Assistant]
 *     summary: Process queries using Text-to-SQL AI (dynamic SQL generation)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               message:
 *                 type: string
 *                 description: Natural language query
 *                 example: "¿Cuántas reseñas de 5 estrellas tengo en los últimos 49 días?"
 *               conversationHistory:
 *                 type: array
 *                 description: Previous conversation context
 *                 items:
 *                   type: object
 *                   properties:
 *                     role:
 *                       type: string
 *                       enum: [user, assistant]
 *                     content:
 *                       type: string
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *             required: [message]
 *     responses:
 *       200:
 *         description: Successful SQL-generated response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     response:
 *                       type: string
 *                       description: Natural language interpretation of results
 *                     suggestions:
 *                       type: array
 *                       items:
 *                         type: string
 *                     metadata:
 *                       type: object
 *                       properties:
 *                         confidence:
 *                           type: number
 *                         queryGenerated:
 *                           type: boolean
 *                         queryExecuted:
 *                           type: boolean
 *                         rowsReturned:
 *                           type: number
 *                         executionTime:
 *                           type: number
 *                         dataSourcesUsed:
 *                           type: array
 *                           items:
 *                             type: string
 *                         sqlQuery:
 *                           type: string
 *                           description: Generated SQL query (development only)
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       500: { $ref: '#/components/responses/InternalServerError' }
 */
router.post(
  '/assistant/text-to-sql',
  authenticateTokenMiddleware,
  chatbotRateLimitMiddleware, // Rate limit: 10 queries/min per user, 100/hour per venue
  tokenBudgetMiddleware, // Track token budget and add headers
  validateRequest(assistantQuerySchema),
  textToSqlAssistantController.processTextToSqlQuery,
)

/**
 * @openapi
 * /api/v1/dashboard/assistant/suggestions:
 *   get:
 *     tags: [AI Assistant]
 *     summary: Get predefined suggestions for the assistant
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: List of suggested queries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     suggestions:
 *                       type: array
 *                       items: { type: string }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get('/assistant/suggestions', authenticateTokenMiddleware, assistantController.getAssistantSuggestions)

/**
 * @openapi
 * /api/v1/dashboard/assistant/feedback:
 *   post:
 *     tags: [AI Assistant]
 *     summary: Submit user feedback for AI assistant responses
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - trainingDataId
 *               - feedbackType
 *             properties:
 *               trainingDataId:
 *                 type: string
 *                 description: ID of the training data record to provide feedback for
 *               feedbackType:
 *                 type: string
 *                 enum: [CORRECT, INCORRECT, PARTIALLY_CORRECT]
 *                 description: Type of feedback for the AI response
 *               correctedResponse:
 *                 type: string
 *                 description: What the response should have been (optional)
 *               correctedSql:
 *                 type: string
 *                 description: What the SQL should have been (optional)
 *               userNotes:
 *                 type: string
 *                 description: Additional notes from the user (optional)
 *     responses:
 *       200:
 *         description: Feedback submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       500: { $ref: '#/components/responses/InternalServerError' }
 */
router.post(
  '/assistant/feedback',
  authenticateTokenMiddleware,
  validateRequest(feedbackSubmissionSchema),
  assistantController.submitFeedback,
)

// ========================================
// TESTING ROUTES (SUPERADMIN ONLY)
// ========================================

/**
 * @openapi
 * /api/v1/dashboard/testing/payment/fast:
 *   post:
 *     tags: [Testing]
 *     summary: Create a test payment (SUPERADMIN only)
 *     description: Creates a fast payment for testing purposes. This endpoint is only available for SUPERADMIN users.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - venueId
 *               - amount
 *               - method
 *             properties:
 *               venueId:
 *                 type: string
 *                 format: cuid
 *                 description: Venue ID where the test payment will be created
 *               amount:
 *                 type: integer
 *                 minimum: 1
 *                 description: Payment amount in cents (e.g., 50000 = $500.00)
 *               tipAmount:
 *                 type: integer
 *                 minimum: 0
 *                 default: 0
 *                 description: Tip amount in cents (e.g., 5000 = $50.00)
 *               method:
 *                 type: string
 *                 enum: [CASH, CREDIT_CARD, DEBIT_CARD, DIGITAL_WALLET, BANK_TRANSFER, OTHER]
 *                 description: Payment method
 *     responses:
 *       201:
 *         description: Test payment created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     payment:
 *                       $ref: '#/components/schemas/Payment'
 *                     receiptUrl:
 *                       type: string
 *                       description: URL to the digital receipt
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       500: { $ref: '#/components/responses/InternalServerError' }
 */
router.post(
  '/testing/payment/fast',
  authenticateTokenMiddleware,
  checkPermission('system:test'),
  validateRequest(createTestPaymentSchema),
  testingController.createTestPayment,
)

/**
 * @openapi
 * /api/v1/dashboard/testing/payments:
 *   get:
 *     tags: [Testing]
 *     summary: Get recent test payments (SUPERADMIN only)
 *     description: Retrieves the most recent test payments, optionally filtered by venue
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: venueId
 *         schema:
 *           type: string
 *           format: cuid
 *         description: Optional venue ID to filter test payments
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *         description: Maximum number of payments to return
 *     responses:
 *       200:
 *         description: Test payments retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Payment'
 *                 meta:
 *                   type: object
 *                   properties:
 *                     count:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     venueId:
 *                       type: string
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       500: { $ref: '#/components/responses/InternalServerError' }
 */
router.get(
  '/testing/payments',
  authenticateTokenMiddleware,
  checkPermission('system:test'),
  validateRequest(getTestPaymentsSchema),
  testingController.getTestPayments,
)

/**
 * @openapi
 * /api/v1/dashboard/testing/payment/{paymentId}:
 *   delete:
 *     tags: [Testing]
 *     summary: Delete a test payment (SUPERADMIN only)
 *     description: Removes a test payment and its associated order. Only allows deletion of payments marked as test payments.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: paymentId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: Payment ID to delete
 *     responses:
 *       200:
 *         description: Test payment deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       500: { $ref: '#/components/responses/InternalServerError' }
 */
router.delete(
  '/testing/payment/:paymentId',
  authenticateTokenMiddleware,
  checkPermission('system:test'),
  testingController.deleteTestPayment,
)

// ==========================================
// ROLE PERMISSIONS MANAGEMENT ROUTES
// ==========================================
// Allows OWNER and ADMIN to customize permissions for each role

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/role-permissions:
 *   get:
 *     tags: [Role Permissions]
 *     summary: Get all role permissions for a venue
 *     description: Returns both custom and default permissions for each role
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *     responses:
 *       200:
 *         description: List of all role permissions
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/role-permissions',
  authenticateTokenMiddleware,
  checkPermission('settings:manage'),
  rolePermissionController.getAllRolePermissions,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/role-permissions/{role}:
 *   get:
 *     tags: [Role Permissions]
 *     summary: Get permissions for a specific role
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: role
 *         required: true
 *         schema:
 *           type: string
 *           enum: [VIEWER, HOST, KITCHEN, WAITER, CASHIER, MANAGER, ADMIN, OWNER, SUPERADMIN]
 *     responses:
 *       200:
 *         description: Role permissions
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/role-permissions/:role',
  authenticateTokenMiddleware,
  checkPermission('settings:manage'),
  rolePermissionController.getRolePermissions,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/role-permissions/{role}:
 *   put:
 *     tags: [Role Permissions]
 *     summary: Update permissions for a specific role
 *     description: Includes hierarchy and self-lockout validation
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: role
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - permissions
 *             properties:
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["menu:read", "menu:create", "orders:read"]
 *     responses:
 *       200:
 *         description: Permissions updated successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.put(
  '/venues/:venueId/role-permissions/:role',
  authenticateTokenMiddleware,
  checkPermission('settings:manage'),
  rolePermissionController.updateRolePermissions,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/role-permissions/{role}:
 *   delete:
 *     tags: [Role Permissions]
 *     summary: Delete custom permissions (revert to defaults)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: role
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Reverted to default permissions
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.delete(
  '/venues/:venueId/role-permissions/:role',
  authenticateTokenMiddleware,
  checkPermission('settings:manage'),
  rolePermissionController.deleteRolePermissions,
)

/**
 * @openapi
 * /api/v1/dashboard/role-permissions/hierarchy:
 *   get:
 *     tags: [Role Permissions]
 *     summary: Get role hierarchy information
 *     description: Returns which roles can modify which other roles, critical permissions, etc.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Role hierarchy information
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get(
  '/role-permissions/hierarchy',
  authenticateTokenMiddleware,
  checkPermission('settings:manage'),
  rolePermissionController.getRoleHierarchyInfo,
)

// ============================================================================
// TOKEN BUDGET ROUTES
// ============================================================================

/**
 * @openapi
 * /api/v1/dashboard/tokens/status:
 *   get:
 *     tags: [Token Budget]
 *     summary: Get token budget status
 *     description: Returns current token budget status including free tokens remaining, extra balance, and usage percentage
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Token budget status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     freeTokensRemaining: { type: number }
 *                     extraTokensBalance: { type: number }
 *                     totalAvailable: { type: number }
 *                     percentageUsed: { type: number }
 *                     isInOverage: { type: boolean }
 *                     overageTokensUsed: { type: number }
 *                     overageCost: { type: number }
 *                     periodEndsAt: { type: string, format: date-time }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get('/tokens/status', authenticateTokenMiddleware, tokenBudgetController.getStatus)

/**
 * @openapi
 * /api/v1/dashboard/tokens/purchase:
 *   post:
 *     tags: [Token Budget]
 *     summary: Purchase additional tokens
 *     description: Purchase extra tokens using Stripe. Requires OWNER or ADMIN role.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tokenAmount]
 *             properties:
 *               tokenAmount:
 *                 type: number
 *                 minimum: 1000
 *                 description: Number of tokens to purchase
 *               paymentMethodId:
 *                 type: string
 *                 description: Optional Stripe payment method ID
 *     responses:
 *       200:
 *         description: Purchase initiated
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/tokens/purchase',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.ADMIN]),
  tokenBudgetController.purchase,
)

/**
 * @openapi
 * /api/v1/dashboard/tokens/auto-recharge:
 *   put:
 *     tags: [Token Budget]
 *     summary: Configure auto-recharge settings
 *     description: Enable/disable automatic token recharge when balance is low. Requires OWNER or ADMIN role.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [enabled]
 *             properties:
 *               enabled:
 *                 type: boolean
 *                 description: Enable or disable auto-recharge
 *               threshold:
 *                 type: number
 *                 minimum: 100
 *                 description: Token balance that triggers auto-recharge
 *               amount:
 *                 type: number
 *                 minimum: 1000
 *                 description: Number of tokens to purchase when triggered
 *     responses:
 *       200:
 *         description: Auto-recharge settings updated
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.put(
  '/tokens/auto-recharge',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.ADMIN]),
  tokenBudgetController.updateAutoRecharge,
)

/**
 * @openapi
 * /api/v1/dashboard/tokens/history:
 *   get:
 *     tags: [Token Budget]
 *     summary: Get token usage and purchase history
 *     description: Returns paginated list of token usage records and purchases. Requires OWNER or ADMIN role.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: page
 *         in: query
 *         schema: { type: number, default: 1 }
 *       - name: limit
 *         in: query
 *         schema: { type: number, default: 20, maximum: 100 }
 *       - name: startDate
 *         in: query
 *         schema: { type: string, format: date-time }
 *       - name: endDate
 *         in: query
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Token history
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/tokens/history',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.ADMIN]),
  tokenBudgetController.getHistory,
)

/**
 * @openapi
 * /api/v1/dashboard/tokens/analytics:
 *   get:
 *     tags: [Token Budget]
 *     summary: Get token usage analytics
 *     description: Returns usage analytics including daily breakdown, query type distribution, and top users. Requires OWNER or ADMIN role.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: days
 *         in: query
 *         schema: { type: number, default: 30 }
 *         description: Number of days to analyze
 *     responses:
 *       200:
 *         description: Token analytics
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/tokens/analytics',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.OWNER, StaffRole.ADMIN]),
  tokenBudgetController.getAnalytics,
)

// ==========================================
// CUSTOMER MANAGEMENT ROUTES (Phase 1)
// ==========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customers:
 *   get:
 *     tags: [Customer Management]
 *     summary: List all customers for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: page
 *         in: query
 *         schema: { type: number, default: 1 }
 *       - name: pageSize
 *         in: query
 *         schema: { type: number, default: 20, maximum: 100 }
 *       - name: search
 *         in: query
 *         schema: { type: string }
 *         description: Search by name, email, or phone
 *       - name: customerGroupId
 *         in: query
 *         schema: { type: string }
 *       - name: noGroup
 *         in: query
 *         schema: { type: boolean }
 *         description: Filter customers without a group
 *       - name: tags
 *         in: query
 *         schema: { type: string }
 *         description: Comma-separated tags
 *       - name: sortBy
 *         in: query
 *         schema: { type: string, enum: [createdAt, totalSpent, visitCount, lastVisit] }
 *         description: Field to sort by
 *       - name: sortOrder
 *         in: query
 *         schema: { type: string, enum: [asc, desc], default: desc }
 *         description: Sort order (ascending or descending)
 *       - name: hasPendingBalance
 *         in: query
 *         schema: { type: boolean }
 *         description: Filter customers with pending pay-later orders
 *     responses:
 *       200:
 *         description: A paginated list of customers
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/customers',
  authenticateTokenMiddleware,
  checkPermission('customers:read'),
  validateRequest(z.object({ params: CustomerVenueIdParamsSchema.shape.params, query: CustomersQuerySchema.shape.query })),
  customerController.getCustomers,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customers/stats:
 *   get:
 *     tags: [Customer Management]
 *     summary: Get customer statistics for dashboard
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Customer statistics
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/customers/stats',
  authenticateTokenMiddleware,
  checkPermission('customers:read'),
  validateRequest(CustomerVenueIdParamsSchema),
  customerController.getCustomerStats,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customers/{customerId}:
 *   get:
 *     tags: [Customer Management]
 *     summary: Get a single customer by ID
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: customerId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Customer details
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/customers/:customerId',
  authenticateTokenMiddleware,
  checkPermission('customers:read'),
  validateRequest(CustomerParamsSchema),
  customerController.getCustomerById,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customers:
 *   post:
 *     tags: [Customer Management]
 *     summary: Create a new customer
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *               phone: { type: string }
 *               firstName: { type: string }
 *               lastName: { type: string }
 *               birthDate: { type: string, format: date }
 *               gender: { type: string, enum: [MALE, FEMALE, OTHER, PREFER_NOT_TO_SAY] }
 *               customerGroupId: { type: string }
 *               notes: { type: string }
 *               tags: { type: array, items: { type: string } }
 *               marketingConsent: { type: boolean }
 *     responses:
 *       201:
 *         description: Customer created successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/customers',
  authenticateTokenMiddleware,
  checkPermission('customers:create'),
  validateRequest(CreateCustomerSchema),
  customerController.createCustomer,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customers/{customerId}:
 *   put:
 *     tags: [Customer Management]
 *     summary: Update an existing customer
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: customerId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *               phone: { type: string }
 *               firstName: { type: string }
 *               lastName: { type: string }
 *               birthDate: { type: string, format: date }
 *               gender: { type: string, enum: [MALE, FEMALE, OTHER, PREFER_NOT_TO_SAY] }
 *               customerGroupId: { type: string }
 *               notes: { type: string }
 *               tags: { type: array, items: { type: string } }
 *               marketingConsent: { type: boolean }
 *               active: { type: boolean }
 *     responses:
 *       200:
 *         description: Customer updated successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.put(
  '/venues/:venueId/customers/:customerId',
  authenticateTokenMiddleware,
  checkPermission('customers:update'),
  validateRequest(UpdateCustomerSchema),
  customerController.updateCustomer,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customers/{customerId}:
 *   delete:
 *     tags: [Customer Management]
 *     summary: Soft delete a customer (set active=false)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: customerId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Customer deleted successfully
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.delete(
  '/venues/:venueId/customers/:customerId',
  authenticateTokenMiddleware,
  checkPermission('customers:delete'),
  validateRequest(CustomerParamsSchema),
  customerController.deleteCustomer,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customers/{customerId}/settle-balance:
 *   post:
 *     tags: [Customer Management]
 *     summary: Settle pending balance for a customer
 *     description: |
 *       Marks all pay-later orders for this customer as paid.
 *       Use this when the customer pays their outstanding balance via cash, bank transfer, or deposit.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: customerId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notes:
 *                 type: string
 *                 description: Optional notes about the settlement (e.g., "Paid in cash", "Bank transfer received")
 *     responses:
 *       200:
 *         description: Balance settled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 settledOrderCount:
 *                   type: number
 *                   description: Number of orders that were settled
 *                 settledAmount:
 *                   type: number
 *                   description: Total amount that was settled
 *                 message:
 *                   type: string
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/customers/:customerId/settle-balance',
  authenticateTokenMiddleware,
  checkPermission('customers:settle-balance'),
  validateRequest(CustomerParamsSchema),
  customerController.settleCustomerBalance,
)

// ============================================================================
// Customer Group Routes (Phase 1: Customer System)
// ============================================================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customer-groups:
 *   get:
 *     tags: [Customer Management]
 *     summary: Get all customer groups with pagination and search
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: page
 *         in: query
 *         schema: { type: integer, minimum: 1 }
 *       - name: pageSize
 *         in: query
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - name: search
 *         in: query
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: A paginated list of customer groups
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/customer-groups',
  authenticateTokenMiddleware,
  checkPermission('customer-groups:read'),
  validateRequest(
    z.object({ params: CustomerGroupParamsSchema.shape.params.pick({ venueId: true }), query: CustomerGroupsQuerySchema.shape.query }),
  ),
  customerGroupController.getCustomerGroups,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customer-groups/stats:
 *   get:
 *     tags: [Customer Management]
 *     summary: Get customer group statistics
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Customer group statistics
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/customer-groups/stats',
  authenticateTokenMiddleware,
  checkPermission('customer-groups:read'),
  validateRequest(z.object({ params: CustomerGroupParamsSchema.shape.params.pick({ venueId: true }) })),
  customerGroupController.getCustomerGroupStats,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customer-groups/{groupId}:
 *   get:
 *     tags: [Customer Management]
 *     summary: Get a single customer group by ID with detailed stats
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: groupId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Customer group details with statistics
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/customer-groups/:groupId',
  authenticateTokenMiddleware,
  checkPermission('customer-groups:read'),
  validateRequest(CustomerGroupParamsSchema),
  customerGroupController.getCustomerGroupById,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customer-groups:
 *   post:
 *     tags: [Customer Management]
 *     summary: Create a new customer group
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, minLength: 1, maxLength: 100 }
 *               description: { type: string, maxLength: 500 }
 *               color: { type: string, pattern: '^#[0-9A-Fa-f]{6}$' }
 *               autoAssignRules: { type: object }
 *     responses:
 *       201:
 *         description: Customer group created successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/customer-groups',
  authenticateTokenMiddleware,
  checkPermission('customer-groups:create'),
  validateRequest(CreateCustomerGroupSchema),
  customerGroupController.createCustomerGroup,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customer-groups/{groupId}:
 *   put:
 *     tags: [Customer Management]
 *     summary: Update an existing customer group
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: groupId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, minLength: 1, maxLength: 100 }
 *               description: { type: string, maxLength: 500 }
 *               color: { type: string, pattern: '^#[0-9A-Fa-f]{6}$' }
 *               autoAssignRules: { type: object }
 *               active: { type: boolean }
 *     responses:
 *       200:
 *         description: Customer group updated successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.put(
  '/venues/:venueId/customer-groups/:groupId',
  authenticateTokenMiddleware,
  checkPermission('customer-groups:update'),
  validateRequest(UpdateCustomerGroupSchema),
  customerGroupController.updateCustomerGroup,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customer-groups/{groupId}:
 *   delete:
 *     tags: [Customer Management]
 *     summary: Soft delete a customer group (set active=false)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: groupId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Customer group deleted successfully
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.delete(
  '/venues/:venueId/customer-groups/:groupId',
  authenticateTokenMiddleware,
  checkPermission('customer-groups:delete'),
  validateRequest(CustomerGroupParamsSchema),
  customerGroupController.deleteCustomerGroup,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customer-groups/{groupId}/assign:
 *   post:
 *     tags: [Customer Management]
 *     summary: Assign customers to a group
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: groupId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [customerIds]
 *             properties:
 *               customerIds: { type: array, items: { type: string }, minItems: 1, maxItems: 100 }
 *     responses:
 *       200:
 *         description: Customers assigned to group successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/customer-groups/:groupId/assign',
  authenticateTokenMiddleware,
  checkPermission('customer-groups:update'),
  validateRequest(AssignCustomersSchema),
  customerGroupController.assignCustomersToGroup,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customer-groups/{groupId}/remove:
 *   post:
 *     tags: [Customer Management]
 *     summary: Remove customers from a group
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: groupId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [customerIds]
 *             properties:
 *               customerIds: { type: array, items: { type: string }, minItems: 1, maxItems: 100 }
 *     responses:
 *       200:
 *         description: Customers removed from group successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/customer-groups/:groupId/remove',
  authenticateTokenMiddleware,
  checkPermission('customer-groups:update'),
  validateRequest(RemoveCustomersSchema),
  customerGroupController.removeCustomersFromGroup,
)

// ============================================================================
// Loyalty Program Routes (Phase 1b: Loyalty System)
// ============================================================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/loyalty/config:
 *   get:
 *     tags: [Loyalty Program]
 *     summary: Get loyalty program configuration for venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Loyalty configuration
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/loyalty/config',
  authenticateTokenMiddleware,
  checkPermission('loyalty:read'),
  validateRequest(LoyaltyVenueParamsSchema),
  loyaltyController.getLoyaltyConfig,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/loyalty/config:
 *   put:
 *     tags: [Loyalty Program]
 *     summary: Update loyalty program configuration
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               pointsPerDollar: { type: number, minimum: 0 }
 *               minPurchaseAmount: { type: number, minimum: 0 }
 *               redemptionRate: { type: number, minimum: 0 }
 *               minRedemptionPoints: { type: integer, minimum: 0 }
 *               maxRedemptionPercentage: { type: number, minimum: 0, maximum: 100 }
 *               pointsExpirationDays: { type: integer, minimum: 0 }
 *               enabled: { type: boolean }
 *     responses:
 *       200:
 *         description: Loyalty configuration updated successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.put(
  '/venues/:venueId/loyalty/config',
  authenticateTokenMiddleware,
  checkPermission('loyalty:update'),
  validateRequest(UpdateLoyaltyConfigSchema),
  loyaltyController.updateLoyaltyConfig,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/loyalty/calculate-points:
 *   post:
 *     tags: [Loyalty Program]
 *     summary: Calculate points for a purchase amount
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount]
 *             properties:
 *               amount: { type: number, minimum: 0 }
 *     responses:
 *       200:
 *         description: Points calculated successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/loyalty/calculate-points',
  authenticateTokenMiddleware,
  checkPermission('loyalty:read'),
  validateRequest(CalculatePointsSchema),
  loyaltyController.calculatePoints,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/loyalty/calculate-discount:
 *   post:
 *     tags: [Loyalty Program]
 *     summary: Calculate discount value from points
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [points, orderTotal]
 *             properties:
 *               points: { type: integer, minimum: 1 }
 *               orderTotal: { type: number, minimum: 0 }
 *     responses:
 *       200:
 *         description: Discount calculated successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/loyalty/calculate-discount',
  authenticateTokenMiddleware,
  checkPermission('loyalty:read'),
  validateRequest(CalculateDiscountSchema),
  loyaltyController.calculateDiscount,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customers/{customerId}/loyalty/balance:
 *   get:
 *     tags: [Loyalty Program]
 *     summary: Get customer's loyalty points balance
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: customerId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Customer loyalty balance
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/customers/:customerId/loyalty/balance',
  authenticateTokenMiddleware,
  checkPermission('loyalty:read'),
  validateRequest(LoyaltyParamsSchema),
  loyaltyController.getPointsBalance,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customers/{customerId}/loyalty/redeem:
 *   post:
 *     tags: [Loyalty Program]
 *     summary: Redeem loyalty points for discount
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: customerId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [points, orderId]
 *             properties:
 *               points: { type: integer, minimum: 1 }
 *               orderId: { type: string }
 *     responses:
 *       200:
 *         description: Points redeemed successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/customers/:customerId/loyalty/redeem',
  authenticateTokenMiddleware,
  checkPermission('loyalty:redeem'),
  validateRequest(RedeemPointsSchema),
  loyaltyController.redeemPoints,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customers/{customerId}/loyalty/adjust:
 *   post:
 *     tags: [Loyalty Program]
 *     summary: Manual point adjustment by staff (corrections, bonuses, penalties)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: customerId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [points, reason]
 *             properties:
 *               points: { type: integer }
 *               reason: { type: string, minLength: 5, maxLength: 500 }
 *     responses:
 *       200:
 *         description: Points adjusted successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/customers/:customerId/loyalty/adjust',
  authenticateTokenMiddleware,
  checkPermission('loyalty:adjust'),
  validateRequest(AdjustPointsSchema),
  loyaltyController.adjustPoints,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customers/{customerId}/loyalty/transactions:
 *   get:
 *     tags: [Loyalty Program]
 *     summary: Get loyalty transaction history for customer
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: customerId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: page
 *         in: query
 *         schema: { type: integer, minimum: 1 }
 *       - name: pageSize
 *         in: query
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - name: type
 *         in: query
 *         schema: { type: string, enum: [EARN, REDEEM, EXPIRE, ADJUST] }
 *     responses:
 *       200:
 *         description: A paginated list of loyalty transactions
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.get(
  '/venues/:venueId/customers/:customerId/loyalty/transactions',
  authenticateTokenMiddleware,
  checkPermission('loyalty:read'),
  validateRequest(
    z.object({
      params: LoyaltyParamsSchema.shape.params,
      query: LoyaltyTransactionsQuerySchema.shape.query,
    }),
  ),
  loyaltyController.getLoyaltyTransactions,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/loyalty/expire-old-points:
 *   post:
 *     tags: [Loyalty Program]
 *     summary: Expire old loyalty points (admin/cron job endpoint)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Old points expired successfully
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 */
router.post(
  '/venues/:venueId/loyalty/expire-old-points',
  authenticateTokenMiddleware,
  checkPermission('loyalty:expire'),
  validateRequest(LoyaltyVenueParamsSchema),
  loyaltyController.expireOldPoints,
)

// ============================================================================
// Discount Routes (Phase 2: Discount System)
// ============================================================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/discounts:
 *   get:
 *     tags: [Discounts]
 *     summary: Get all discounts for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: page
 *         in: query
 *         schema: { type: integer, default: 1 }
 *       - name: pageSize
 *         in: query
 *         schema: { type: integer, default: 20 }
 *       - name: search
 *         in: query
 *         schema: { type: string }
 *       - name: type
 *         in: query
 *         schema: { type: string, enum: [PERCENTAGE, FIXED_AMOUNT, COMP] }
 *       - name: scope
 *         in: query
 *         schema: { type: string, enum: [ORDER, ITEM, CATEGORY, MODIFIER, MODIFIER_GROUP, CUSTOMER_GROUP, QUANTITY] }
 *       - name: isAutomatic
 *         in: query
 *         schema: { type: boolean }
 *       - name: active
 *         in: query
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: Paginated list of discounts
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get(
  '/venues/:venueId/discounts',
  authenticateTokenMiddleware,
  checkPermission('discounts:read'),
  validateRequest(
    z.object({
      params: DiscountVenueParamsSchema,
      query: getDiscountsQuerySchema,
    }),
  ),
  discountController.getDiscounts,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/discounts/stats:
 *   get:
 *     tags: [Discounts]
 *     summary: Get discount statistics for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Discount statistics
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get(
  '/venues/:venueId/discounts/stats',
  authenticateTokenMiddleware,
  checkPermission('discounts:read'),
  validateRequest(z.object({ params: DiscountVenueParamsSchema })),
  discountController.getDiscountStats,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/discounts/automatic:
 *   get:
 *     tags: [Discounts]
 *     summary: Get all active automatic discounts
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of active automatic discounts
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get(
  '/venues/:venueId/discounts/automatic',
  authenticateTokenMiddleware,
  checkPermission('discounts:read'),
  validateRequest(z.object({ params: DiscountVenueParamsSchema })),
  discountController.getActiveAutomaticDiscounts,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/discounts/{discountId}:
 *   get:
 *     tags: [Discounts]
 *     summary: Get single discount by ID
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: discountId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Discount details
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get(
  '/venues/:venueId/discounts/:discountId',
  authenticateTokenMiddleware,
  checkPermission('discounts:read'),
  validateRequest(z.object({ params: discountParamsSchema })),
  discountController.getDiscountById,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/discounts:
 *   post:
 *     tags: [Discounts]
 *     summary: Create a new discount
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateDiscount' }
 *     responses:
 *       201:
 *         description: Discount created successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.post(
  '/venues/:venueId/discounts',
  authenticateTokenMiddleware,
  checkPermission('discounts:create'),
  validateRequest(
    z.object({
      params: DiscountVenueParamsSchema,
      body: createDiscountBodySchema,
    }),
  ),
  discountController.createDiscount,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/discounts/{discountId}:
 *   put:
 *     tags: [Discounts]
 *     summary: Update a discount
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: discountId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdateDiscount' }
 *     responses:
 *       200:
 *         description: Discount updated successfully
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.put(
  '/venues/:venueId/discounts/:discountId',
  authenticateTokenMiddleware,
  checkPermission('discounts:update'),
  validateRequest(
    z.object({
      params: discountParamsSchema,
      body: updateDiscountBodySchema,
    }),
  ),
  discountController.updateDiscount,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/discounts/{discountId}:
 *   delete:
 *     tags: [Discounts]
 *     summary: Delete a discount
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: discountId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Discount deleted successfully
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.delete(
  '/venues/:venueId/discounts/:discountId',
  authenticateTokenMiddleware,
  checkPermission('discounts:delete'),
  validateRequest(z.object({ params: discountParamsSchema })),
  discountController.deleteDiscount,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/discounts/{discountId}/clone:
 *   post:
 *     tags: [Discounts]
 *     summary: Clone a discount
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: discountId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       201:
 *         description: Discount cloned successfully
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.post(
  '/venues/:venueId/discounts/:discountId/clone',
  authenticateTokenMiddleware,
  checkPermission('discounts:create'),
  validateRequest(z.object({ params: discountParamsSchema })),
  discountController.cloneDiscount,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/discounts/{discountId}/customers:
 *   post:
 *     tags: [Discounts]
 *     summary: Assign a discount to a customer
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: discountId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [customerId]
 *             properties:
 *               customerId: { type: string }
 *               validFrom: { type: string, format: date-time }
 *               validUntil: { type: string, format: date-time }
 *               maxUses: { type: integer }
 *     responses:
 *       201:
 *         description: Discount assigned to customer
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.post(
  '/venues/:venueId/discounts/:discountId/customers',
  authenticateTokenMiddleware,
  checkPermission('discounts:update'),
  validateRequest(
    z.object({
      params: discountParamsSchema,
      body: assignDiscountToCustomerBodySchema,
    }),
  ),
  discountController.assignDiscountToCustomer,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/discounts/{discountId}/customers/{customerId}:
 *   delete:
 *     tags: [Discounts]
 *     summary: Remove a discount from a customer
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: discountId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: customerId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Discount removed from customer
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.delete(
  '/venues/:venueId/discounts/:discountId/customers/:customerId',
  authenticateTokenMiddleware,
  checkPermission('discounts:update'),
  validateRequest(
    z.object({
      params: z.object({
        venueId: z.string().min(1),
        discountId: z.string().min(1),
        customerId: z.string().min(1),
      }),
    }),
  ),
  discountController.removeDiscountFromCustomer,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/customers/{customerId}/discounts:
 *   get:
 *     tags: [Discounts]
 *     summary: Get all discounts assigned to a customer
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: customerId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of customer's assigned discounts
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get(
  '/venues/:venueId/customers/:customerId/discounts',
  authenticateTokenMiddleware,
  checkPermission('discounts:read'),
  validateRequest(
    z.object({
      params: z.object({
        venueId: z.string().min(1),
        customerId: z.string().min(1),
      }),
    }),
  ),
  discountController.getCustomerDiscounts,
)

// ============================================================================
// Coupon Routes (Phase 2: Coupon System)
// ============================================================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/coupons:
 *   get:
 *     tags: [Coupons]
 *     summary: Get all coupon codes for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: page
 *         in: query
 *         schema: { type: integer, default: 1 }
 *       - name: pageSize
 *         in: query
 *         schema: { type: integer, default: 20 }
 *       - name: search
 *         in: query
 *         schema: { type: string }
 *       - name: discountId
 *         in: query
 *         schema: { type: string }
 *       - name: active
 *         in: query
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: Paginated list of coupon codes
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get(
  '/venues/:venueId/coupons',
  authenticateTokenMiddleware,
  checkPermission('coupons:read'),
  validateRequest(
    z.object({
      params: CouponVenueParamsSchema,
      query: getCouponsQuerySchema,
    }),
  ),
  couponController.getCouponCodes,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/coupons/stats:
 *   get:
 *     tags: [Coupons]
 *     summary: Get coupon statistics for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Coupon statistics
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get(
  '/venues/:venueId/coupons/stats',
  authenticateTokenMiddleware,
  checkPermission('coupons:read'),
  validateRequest(z.object({ params: CouponVenueParamsSchema })),
  couponController.getCouponStats,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/coupons/redemptions:
 *   get:
 *     tags: [Coupons]
 *     summary: Get coupon redemption history
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: page
 *         in: query
 *         schema: { type: integer, default: 1 }
 *       - name: pageSize
 *         in: query
 *         schema: { type: integer, default: 20 }
 *       - name: couponId
 *         in: query
 *         schema: { type: string }
 *       - name: customerId
 *         in: query
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated list of redemptions
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get(
  '/venues/:venueId/coupons/redemptions',
  authenticateTokenMiddleware,
  checkPermission('coupons:read'),
  validateRequest(
    z.object({
      params: CouponVenueParamsSchema,
      query: getRedemptionsQuerySchema,
    }),
  ),
  couponController.getCouponRedemptions,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/coupons/validate:
 *   post:
 *     tags: [Coupons]
 *     summary: Validate a coupon code
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code: { type: string }
 *               orderTotal: { type: number }
 *               customerId: { type: string }
 *     responses:
 *       200:
 *         description: Coupon validation result
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.post(
  '/venues/:venueId/coupons/validate',
  authenticateTokenMiddleware,
  checkPermission('coupons:read'),
  validateRequest(
    z.object({
      params: CouponVenueParamsSchema,
      body: validateCouponBodySchema,
    }),
  ),
  couponController.validateCouponCode,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/coupons/bulk-generate:
 *   post:
 *     tags: [Coupons]
 *     summary: Bulk generate coupon codes
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [discountId, quantity]
 *             properties:
 *               discountId: { type: string }
 *               prefix: { type: string }
 *               quantity: { type: integer, minimum: 1, maximum: 1000 }
 *               codeLength: { type: integer, minimum: 4, maximum: 20 }
 *               maxUsesPerCode: { type: integer }
 *               maxUsesPerCustomer: { type: integer }
 *               validFrom: { type: string, format: date-time }
 *               validUntil: { type: string, format: date-time }
 *     responses:
 *       201:
 *         description: Coupon codes generated successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.post(
  '/venues/:venueId/coupons/bulk-generate',
  authenticateTokenMiddleware,
  checkPermission('coupons:create'),
  validateRequest(
    z.object({
      params: CouponVenueParamsSchema,
      body: bulkGenerateCouponsBodySchema,
    }),
  ),
  couponController.bulkGenerateCoupons,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/coupons/{couponId}:
 *   get:
 *     tags: [Coupons]
 *     summary: Get single coupon code by ID
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: couponId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Coupon code details
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get(
  '/venues/:venueId/coupons/:couponId',
  authenticateTokenMiddleware,
  checkPermission('coupons:read'),
  validateRequest(z.object({ params: couponParamsSchema })),
  couponController.getCouponCodeById,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/coupons:
 *   post:
 *     tags: [Coupons]
 *     summary: Create a new coupon code
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [discountId, code]
 *             properties:
 *               discountId: { type: string }
 *               code: { type: string }
 *               maxUses: { type: integer }
 *               maxUsesPerCustomer: { type: integer }
 *               minPurchaseAmount: { type: number }
 *               validFrom: { type: string, format: date-time }
 *               validUntil: { type: string, format: date-time }
 *               active: { type: boolean }
 *     responses:
 *       201:
 *         description: Coupon code created successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.post(
  '/venues/:venueId/coupons',
  authenticateTokenMiddleware,
  checkPermission('coupons:create'),
  validateRequest(
    z.object({
      params: CouponVenueParamsSchema,
      body: createCouponBodySchema,
    }),
  ),
  couponController.createCouponCode,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/coupons/{couponId}:
 *   put:
 *     tags: [Coupons]
 *     summary: Update a coupon code
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: couponId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               code: { type: string }
 *               maxUses: { type: integer }
 *               maxUsesPerCustomer: { type: integer }
 *               minPurchaseAmount: { type: number }
 *               validFrom: { type: string, format: date-time }
 *               validUntil: { type: string, format: date-time }
 *               active: { type: boolean }
 *     responses:
 *       200:
 *         description: Coupon code updated successfully
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.put(
  '/venues/:venueId/coupons/:couponId',
  authenticateTokenMiddleware,
  checkPermission('coupons:update'),
  validateRequest(
    z.object({
      params: couponParamsSchema,
      body: updateCouponBodySchema,
    }),
  ),
  couponController.updateCouponCode,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/coupons/{couponId}:
 *   delete:
 *     tags: [Coupons]
 *     summary: Delete a coupon code
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: couponId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Coupon code deleted successfully
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.delete(
  '/venues/:venueId/coupons/:couponId',
  authenticateTokenMiddleware,
  checkPermission('coupons:delete'),
  validateRequest(z.object({ params: couponParamsSchema })),
  couponController.deleteCouponCode,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/coupons/{couponId}/redeem:
 *   post:
 *     tags: [Coupons]
 *     summary: Record a coupon redemption
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: couponId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orderId, amountSaved]
 *             properties:
 *               orderId: { type: string }
 *               amountSaved: { type: number }
 *               customerId: { type: string }
 *     responses:
 *       201:
 *         description: Redemption recorded successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.post(
  '/venues/:venueId/coupons/:couponId/redeem',
  authenticateTokenMiddleware,
  checkPermission('coupons:redeem'),
  validateRequest(
    z.object({
      params: couponParamsSchema,
      body: recordRedemptionBodySchema,
    }),
  ),
  couponController.recordRedemption,
)

// ============================================================================
// Venue Role Config Routes (Custom Role Display Names)
// ============================================================================
// Allows venues to customize role display names while keeping
// the internal StaffRole enum for type safety.
// Example: CASHIER -> "Promotor" for events businesses
// ============================================================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/role-config:
 *   get:
 *     tags: [Venue Settings]
 *     summary: Get all role configs for a venue (with defaults for unconfigured roles)
 *     description: |
 *       Returns ALL roles with custom display names if configured, or defaults if not.
 *       Useful for displaying role names in UI (e.g., CASHIER -> "Promotor").
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of role configs for all roles
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 configs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       role: { type: string, enum: [SUPERADMIN, OWNER, ADMIN, MANAGER, CASHIER, WAITER, KITCHEN, HOST, VIEWER] }
 *                       displayName: { type: string }
 *                       description: { type: string, nullable: true }
 *                       icon: { type: string, nullable: true }
 *                       color: { type: string, nullable: true }
 *                       isActive: { type: boolean }
 *                       sortOrder: { type: integer }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.get(
  '/venues/:venueId/role-config',
  authenticateTokenMiddleware,
  checkPermission('role-config:read'),
  validateRequest(RoleConfigParamsSchema),
  venueRoleConfigController.getRoleConfigs,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/role-config:
 *   put:
 *     tags: [Venue Settings]
 *     summary: Update role configs for a venue (bulk upsert)
 *     description: |
 *       Creates new role configs or updates existing ones.
 *       SUPERADMIN role cannot be renamed (will be skipped).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [configs]
 *             properties:
 *               configs:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [role, displayName]
 *                   properties:
 *                     role: { type: string, enum: [OWNER, ADMIN, MANAGER, CASHIER, WAITER, KITCHEN, HOST, VIEWER] }
 *                     displayName: { type: string, minLength: 1, maxLength: 50 }
 *                     description: { type: string, maxLength: 200 }
 *                     icon: { type: string, maxLength: 50 }
 *                     color: { type: string, pattern: '^#[0-9A-Fa-f]{6}$' }
 *                     isActive: { type: boolean }
 *                     sortOrder: { type: integer, minimum: 0, maximum: 100 }
 *     responses:
 *       200:
 *         description: Role configs updated successfully
 *       400: { $ref: '#/components/responses/BadRequestError' }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.put(
  '/venues/:venueId/role-config',
  authenticateTokenMiddleware,
  checkPermission('role-config:update'),
  validateRequest(
    z.object({
      params: RoleConfigParamsSchema.shape.params,
      body: UpdateRoleConfigsSchema.shape.body,
    }),
  ),
  venueRoleConfigController.updateRoleConfigs,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/role-config:
 *   delete:
 *     tags: [Venue Settings]
 *     summary: Reset all role configs to defaults for a venue
 *     description: |
 *       Deletes all custom role configs for the venue.
 *       All roles will return to their default display names.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Role configs reset to defaults
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.delete(
  '/venues/:venueId/role-config',
  authenticateTokenMiddleware,
  checkPermission('role-config:update'),
  validateRequest(RoleConfigParamsSchema),
  venueRoleConfigController.resetRoleConfigs,
)

// ============================================================================
// VENUE SETTINGS ENDPOINTS
// Configure venue operational settings (TPV screens, inventory, payments, etc.)
// ============================================================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/settings:
 *   get:
 *     tags: [Venue Settings]
 *     summary: Get all venue settings
 *     description: Returns all venue settings including operations, inventory, payment, and TPV configuration.
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Venue settings
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.get(
  '/venues/:venueId/settings',
  authenticateTokenMiddleware,
  checkPermission('venues:read'),
  venueSettingsController.getVenueSettings,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/settings:
 *   put:
 *     tags: [Venue Settings]
 *     summary: Update venue settings
 *     description: Updates venue settings. Only provided fields are updated.
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               tpvShowReviewScreen: { type: boolean, description: Show review screen after payment }
 *               tpvShowTipScreen: { type: boolean, description: Show tip selection screen }
 *               tpvShowReceiptScreen: { type: boolean, description: Show receipt options screen }
 *               tpvDefaultTipPercentage: { type: integer, nullable: true, description: Pre-select tip percentage }
 *     responses:
 *       200:
 *         description: Updated venue settings
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.put(
  '/venues/:venueId/settings',
  authenticateTokenMiddleware,
  checkPermission('venues:update'),
  validateRequest(UpdateVenueSettingsSchema),
  venueSettingsController.updateVenueSettings,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/settings/tpv:
 *   get:
 *     tags: [Venue Settings]
 *     summary: Get TPV-specific settings
 *     description: Returns only TPV-related settings for the Android terminal app.
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: TPV settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 showReviewScreen: { type: boolean }
 *                 showTipScreen: { type: boolean }
 *                 showReceiptScreen: { type: boolean }
 *                 defaultTipPercentage: { type: integer, nullable: true }
 *                 tipSuggestions: { type: array, items: { type: integer } }
 *                 requirePinLogin: { type: boolean }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.get(
  '/venues/:venueId/settings/tpv',
  authenticateTokenMiddleware,
  checkPermission('venues:read'),
  venueSettingsController.getTpvSettings,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/settings/tpv:
 *   put:
 *     tags: [Venue Settings]
 *     summary: Update TPV-specific settings
 *     description: Updates only TPV-related settings (review screen, tip screen, etc.)
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               showReviewScreen: { type: boolean, description: Show review screen after payment }
 *               showTipScreen: { type: boolean, description: Show tip selection screen }
 *               showReceiptScreen: { type: boolean, description: Show receipt options screen }
 *               defaultTipPercentage: { type: integer, nullable: true, description: Pre-select tip percentage (0-100) }
 *     responses:
 *       200:
 *         description: Updated TPV settings
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       403: { $ref: '#/components/responses/ForbiddenError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.put(
  '/venues/:venueId/settings/tpv',
  authenticateTokenMiddleware,
  checkPermission('venues:update'),
  validateRequest(UpdateTpvSettingsSchema),
  venueSettingsController.updateTpvSettings,
)

// ============================================================
// CREDIT OFFER ROUTES (Client-facing)
// ============================================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/credit-offer:
 *   get:
 *     tags: [Credit Offers]
 *     summary: Get pending credit offer for venue
 *     description: Returns any pending credit offer for the venue. Does NOT expose credit scores.
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Credit offer status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 hasOffer: { type: boolean }
 *                 offer:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     id: { type: string }
 *                     offerAmount: { type: number }
 *                     factorRate: { type: number }
 *                     totalRepayment: { type: number }
 *                     repaymentPercent: { type: number }
 *                     estimatedTermDays: { type: integer }
 *                     expiresAt: { type: string, format: date-time }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get(
  '/venues/:venueId/credit-offer',
  authenticateTokenMiddleware,
  checkPermission('settlements:read'),
  creditOfferController.getPendingOffer,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/credit-offer/{offerId}/interest:
 *   post:
 *     tags: [Credit Offers]
 *     summary: Express interest in credit offer
 *     description: Registers venue's interest in the credit offer. Triggers follow-up process.
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: offerId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Interest registered
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.post(
  '/venues/:venueId/credit-offer/:offerId/interest',
  authenticateTokenMiddleware,
  checkPermission('settlements:write'),
  creditOfferController.expressInterest,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/credit-offer/{offerId}/decline:
 *   post:
 *     tags: [Credit Offers]
 *     summary: Decline credit offer
 *     description: Declines the credit offer. Venue can receive new offers in the future.
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: offerId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason: { type: string, description: Optional reason for declining }
 *     responses:
 *       200:
 *         description: Offer declined
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 *       404: { $ref: '#/components/responses/NotFoundError' }
 */
router.post(
  '/venues/:venueId/credit-offer/:offerId/decline',
  authenticateTokenMiddleware,
  checkPermission('settlements:write'),
  creditOfferController.declineOffer,
)

export default router
