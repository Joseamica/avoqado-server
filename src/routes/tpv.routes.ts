import express from 'express'
import { validateRequest } from '../middlewares/validation'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware'
import { checkPermission } from '../middlewares/checkPermission.middleware'
import { pinLoginRateLimiter } from '../middlewares/pin-login-rate-limit.middleware'
import {
  pinLoginSchema,
  refreshTokenSchema,
  logoutSchema,
  venueIdParamSchema,
  serialNumberParamSchema,
  orderParamsSchema,
  paymentsQuerySchema,
  shiftQuerySchema,
  shiftsQuerySchema,
  shiftsSummaryQuerySchema,
  recordPaymentParamsSchema,
  recordFastPaymentParamsSchema,
  recordPaymentBodySchema,
  paymentRouteSchema,
  tableParamsSchema,
  assignTableSchema,
  clearTableSchema,
  addOrderItemsSchema,
  removeOrderItemSchema,
  updateGuestInfoSchema,
  compItemsSchema,
  voidItemsSchema,
  applyDiscountSchema,
} from '../schemas/tpv.schema'
import { activateTerminalSchema } from '../schemas/activation.schema'
import * as venueController from '../controllers/tpv/venue.tpv.controller'
import * as orderController from '../controllers/tpv/order.tpv.controller'
import * as paymentController from '../controllers/tpv/payment.tpv.controller'
import * as shiftController from '../controllers/tpv/shift.tpv.controller'
import * as authController from '../controllers/tpv/auth.tpv.controller'
import * as activationController from '../controllers/tpv/activation.controller'
import * as heartbeatController from '../controllers/tpv/heartbeat.tpv.controller'
import * as timeEntryController from '../controllers/tpv/time-entry.tpv.controller'
import * as terminalController from '../controllers/tpv/terminal.tpv.controller'
import * as tableController from '../controllers/tpv/table.tpv.controller'
import * as floorElementController from '../controllers/tpv/floor-element.tpv.controller'
import * as reportsController from '../controllers/tpv/reports.tpv.controller'

const router = express.Router()

/**
 * @openapi
 * components:
 *   schemas:
 *     VenueIdResponse:
 *       type: object
 *       properties:
 *         venueId:
 *           type: string
 *           format: cuid
 *           description: The ID of the venue
 *       required:
 *         - venueId
 *     TerminalMerchantResponse:
 *       type: object
 *       properties:
 *         venueId:
 *           type: string
 *           format: cuid
 *           description: The ID of the venue
 *         terminalId:
 *           type: string
 *           format: uuid
 *           description: Menta's terminal UUID (required for payment processing - automatically fetched and cached)
 *         serialCode:
 *           type: string
 *           description: The serial number of the terminal
 *         status:
 *           type: string
 *           enum: [ACTIVE, INACTIVE, MAINTENANCE]
 *           description: Current status of the terminal
 *         model:
 *           type: string
 *           description: Terminal model/type
 *         hardwareVersion:
 *           type: string
 *           description: Hardware version
 *         features:
 *           type: array
 *           items:
 *             type: string
 *           description: Terminal capabilities/features
 *       required:
 *         - venueId
 *         - terminalId
 *         - serialCode
 *         - status
 *
 *     VenueTPVResponse:
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
 *         staff:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               staff:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                   firstName:
 *                     type: string
 *                   lastName:
 *                     type: string
 *                   pin:
 *                     type: string
 *                     nullable: true
 */

/**
 * @openapi
 * /tpv/venues/{venueId}:
 *   get:
 *     tags:
 *       - TPV - Venues
 *     summary: Get venue details for TPV
 *     description: Retrieve venue information including staff details for TPV usage
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The ID of the venue
 *     responses:
 *       200:
 *         description: Venue details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/VenueTPVResponse'
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       403:
 *         description: Forbidden - insufficient role permissions
 *       404:
 *         description: Venue not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Venue with ID {venueId} not found"
 *       500:
 *         description: Internal server error
 */
/**
 * SECURITY UPDATE: This endpoint now requires authentication and permission checks.
 * Middlewares order: authenticateTokenMiddleware -> checkPermission -> validateRequest -> controller
 */
router.get(
  '/venues/:venueId',
  authenticateTokenMiddleware,
  checkPermission('home:read'),
  validateRequest(venueIdParamSchema),
  venueController.getVenueById,
)

/**
 * @openapi
 * /tpv/serial-number/{serialNumber}:
 *   get:
 *     tags:
 *       - TPV - Venues
 *     summary: Get terminal information from serial number (Smart Caching)
 *     description: |
 *       Retrieve complete terminal information including venue ID and Menta terminal UUID for payment processing.
 *
 *       **Smart Caching Behavior:**
 *       - First request: Fetches terminal ID from Menta API and caches it in database
 *       - Subsequent requests: Returns cached terminal ID (no API call to Menta)
 *
 *       This ensures optimal performance while maintaining accurate terminal information.
 *     parameters:
 *       - in: path
 *         name: serialNumber
 *         required: true
 *         schema:
 *           type: string
 *         description: The serial number of the terminal (printed on hardware)
 *     responses:
 *       200:
 *         description: Terminal information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TerminalMerchantResponse'
 *       404:
 *         description: Terminal not found or not registered in Menta
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   examples:
 *                     terminal_not_found:
 *                       value: "Terminal not found"
 *                     venue_not_found:
 *                       value: "VenueId not found"
 *                     menta_not_found:
 *                       value: "Terminal {serialNumber} not found in Menta system. Please register the terminal in Menta dashboard first."
 *       500:
 *         description: Internal server error or Menta API unavailable
 */
router.get('/serial-number/:serialNumber', validateRequest(serialNumberParamSchema), venueController.getVenueIdFromSerialNumber)

/**
 * @openapi
 * /tpv/status-sync/{serialNumber}:
 *   get:
 *     tags:
 *       - TPV - Terminal Status
 *     summary: Get terminal status for synchronization
 *     description: Retrieve current terminal status from server for synchronization purposes
 *     parameters:
 *       - in: path
 *         name: serialNumber
 *         required: true
 *         schema:
 *           type: string
 *         description: The serial number of the terminal
 *     responses:
 *       200:
 *         description: Terminal status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 status:
 *                   type: string
 *                   description: Current terminal status
 *                 message:
 *                   type: string
 *                 lastSeen:
 *                   type: string
 *                   format: date-time
 *                   description: Last time terminal was seen
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   description: Current server timestamp
 *       404:
 *         description: Terminal not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 error:
 *                   type: string
 *                   example: "Terminal not found"
 *       500:
 *         description: Internal server error
 */
router.get('/status-sync/:serialNumber', validateRequest(serialNumberParamSchema), heartbeatController.getTerminalStatus)

/**
 * @openapi
 * /api/v1/tpv/heartbeat:
 *   post:
 *     tags: [TPV Health]
 *     summary: Process heartbeat from TPV terminal (unauthenticated)
 *     description: |
 *       Unauthenticated endpoint for TPV terminals to send periodic heartbeat data.
 *       Follows Square/Toast POS pattern: heartbeats are sent BEFORE login to enable
 *       terminal health monitoring. Backend uses this to determine ONLINE/OFFLINE status.
 *
 *       **Design Pattern (Square/Toast):**
 *       - Heartbeat does NOT require authentication
 *       - Terminal sends heartbeat every 30 seconds
 *       - Backend marks terminal as ONLINE if heartbeat received < 2 minutes
 *       - Backend marks terminal as OFFLINE if no heartbeat > 2 minutes
 *       - Offline status does NOT block login (terminal can recover automatically)
 *
 *       **Race Condition Prevention:**
 *       - Endpoint is idempotent (multiple simultaneous heartbeats are safe)
 *       - Only updates lastHeartbeat timestamp, does not change operational status
 *       - Login can proceed even if terminal is OFFLINE
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - terminalId
 *               - timestamp
 *               - status
 *             properties:
 *               terminalId:
 *                 type: string
 *                 description: Terminal serial number (without AVQD- prefix)
 *                 example: "1A2B3C4D5E6F"
 *               timestamp:
 *                 type: string
 *                 format: date-time
 *                 description: Heartbeat timestamp in ISO 8601 format
 *                 example: "2025-01-22T18:30:00.000Z"
 *               status:
 *                 type: string
 *                 enum: [ACTIVE, MAINTENANCE]
 *                 description: Current terminal operational status
 *               version:
 *                 type: string
 *                 description: AvoqadoPOS app version
 *                 example: "1.0.0"
 *               systemInfo:
 *                 type: object
 *                 description: Device health metrics (battery, memory, storage, etc.)
 *               networkInfo:
 *                 type: object
 *                 description: Network connection details (type, quality, etc.)
 *     responses:
 *       200:
 *         description: Heartbeat processed successfully
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
 *                   example: "Heartbeat processed successfully"
 *                 serverStatus:
 *                   type: string
 *                   enum: [ACTIVE, INACTIVE, MAINTENANCE, RETIRED]
 *                   description: Server's view of terminal status (for sync)
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Invalid heartbeat data
 *       404:
 *         description: Terminal not found or not activated
 */
router.post('/heartbeat', heartbeatController.processHeartbeat)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders:
 *   get:
 *     tags:
 *       - TPV - Orders
 *     summary: Get all open orders for a venue
 *     description: Retrieve all open orders (orders with pending or partial payment status) for a specific venue
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The ID of the venue
 *     responses:
 *       200:
 *         description: List of open orders retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                     format: cuid
 *                   orderNumber:
 *                     type: string
 *                   total:
 *                     type: number
 *                     format: decimal
 *                   paymentStatus:
 *                     type: string
 *                     enum: [PENDING, PARTIAL]
 *                   items:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                         quantity:
 *                           type: integer
 *                         unitPrice:
 *                           type: number
 *                         product:
 *                           type: object
 *                           properties:
 *                             id:
 *                               type: string
 *                             name:
 *                               type: string
 *                             price:
 *                               type: number
 *                   payments:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                         amount:
 *                           type: number
 *                         tipAmount:
 *                           type: number
 *                         method:
 *                           type: string
 *                   createdBy:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       firstName:
 *                         type: string
 *                       lastName:
 *                         type: string
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       403:
 *         description: Forbidden - insufficient role permissions
 *       404:
 *         description: Venue not found
 *       500:
 *         description: Internal server error
 */
router.get(
  '/venues/:venueId/orders',
  authenticateTokenMiddleware,
  checkPermission('orders:read'),
  validateRequest(venueIdParamSchema),
  orderController.getOrders,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders:
 *   post:
 *     tags:
 *       - TPV - Orders
 *     summary: Create a new order
 *     description: Create a new order for quick orders, counter service, delivery, etc. Generates CUID orderId and sequential orderNumber.
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
 *               tableId:
 *                 type: string
 *                 nullable: true
 *                 description: Table ID (null for counter/quick orders)
 *               covers:
 *                 type: integer
 *                 default: 1
 *                 description: Number of people
 *               waiterId:
 *                 type: string
 *                 description: Staff member ID
 *               orderType:
 *                 type: string
 *                 enum: [DINE_IN, TAKEOUT, DELIVERY, PICKUP]
 *                 default: DINE_IN
 *     responses:
 *       201:
 *         description: Order created successfully
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.post('/venues/:venueId/orders', authenticateTokenMiddleware, checkPermission('orders:create'), orderController.createOrder)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}:
 *   get:
 *     tags:
 *       - TPV - Orders
 *     summary: Get a specific order by ID
 *     description: Retrieve detailed information about a specific order including payment calculations
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The ID of the venue
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The ID of the order
 *     responses:
 *       200:
 *         description: Order details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   format: cuid
 *                 orderNumber:
 *                   type: string
 *                 total:
 *                   type: number
 *                   format: decimal
 *                 paymentStatus:
 *                   type: string
 *                   enum: [PENDING, PARTIAL]
 *                 amount_left:
 *                   type: number
 *                   description: Amount remaining to be paid
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       quantity:
 *                         type: integer
 *                       unitPrice:
 *                         type: number
 *                       total:
 *                         type: number
 *                       product:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           name:
 *                             type: string
 *                           price:
 *                             type: number
 *                       paymentAllocations:
 *                         type: array
 *                         items:
 *                           type: object
 *                 payments:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       amount:
 *                         type: number
 *                       tipAmount:
 *                         type: number
 *                       method:
 *                         type: string
 *                       status:
 *                         type: string
 *                       allocations:
 *                         type: array
 *                         items:
 *                           type: object
 *                 createdBy:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     firstName:
 *                       type: string
 *                     lastName:
 *                       type: string
 *                 servedBy:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     id:
 *                       type: string
 *                     firstName:
 *                       type: string
 *                     lastName:
 *                       type: string
 *       404:
 *         description: Order not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Order not found"
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       403:
 *         description: Forbidden - insufficient role permissions
 *       500:
 *         description: Internal server error
 */
router.get(
  '/venues/:venueId/orders/:orderId',
  authenticateTokenMiddleware,
  checkPermission('orders:read'),
  validateRequest(orderParamsSchema),
  orderController.getOrder,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/payments:
 *   get:
 *     tags:
 *       - TPV - Payments
 *     summary: Get payments for a venue
 *     description: Retrieve payments with pagination and filtering options
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The ID of the venue
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of items per page
 *       - in: query
 *         name: pageNumber
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fromDate:
 *                 type: string
 *                 format: date-time
 *                 description: Filter payments from this date
 *               toDate:
 *                 type: string
 *                 format: date-time
 *                 description: Filter payments to this date
 *               staffId:
 *                 type: string
 *                 description: Filter payments by staff member ID
 *     responses:
 *       200:
 *         description: Payments retrieved successfully
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
 *                       amount:
 *                         type: number
 *                       tipAmount:
 *                         type: number
 *                       method:
 *                         type: string
 *                       status:
 *                         type: string
 *                       processedBy:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           firstName:
 *                             type: string
 *                           lastName:
 *                             type: string
 *                       order:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           orderNumber:
 *                             type: string
 *                           total:
 *                             type: number
 *                 meta:
 *                   type: object
 *                   properties:
 *                     totalCount:
 *                       type: integer
 *                     currentPage:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *                     hasNextPage:
 *                       type: boolean
 *                     hasPrevPage:
 *                       type: boolean
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       403:
 *         description: Forbidden - insufficient role permissions
 *       400:
 *         description: Invalid pagination parameters or filters
 *       500:
 *         description: Internal server error
 */
router.get(
  '/venues/:venueId/payments',
  authenticateTokenMiddleware,
  checkPermission('payments:read'),
  validateRequest(paymentsQuerySchema),
  paymentController.getPayments,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/merchant-accounts:
 *   get:
 *     tags:
 *       - TPV - Payments
 *     summary: Get available merchant accounts for a venue
 *     description: Retrieve active merchant accounts configured for the venue for payment processing
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The ID of the venue
 *     responses:
 *       200:
 *         description: Merchant accounts retrieved successfully
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
 *                         description: Merchant account ID
 *                       accountType:
 *                         type: string
 *                         enum: [PRIMARY, SECONDARY, TERTIARY]
 *                         description: Account type in the venue configuration
 *                       displayName:
 *                         type: string
 *                         description: User-friendly name for the account
 *                       providerName:
 *                         type: string
 *                         description: Payment provider name
 *                       providerCode:
 *                         type: string
 *                         description: Payment provider code
 *                       active:
 *                         type: boolean
 *                         description: Whether the account is active
 *                       hasValidCredentials:
 *                         type: boolean
 *                         description: Whether the account has valid credentials
 *                       displayOrder:
 *                         type: integer
 *                         description: Display order for UI
 *                       ecommerceMerchantId:
 *                         type: string
 *                         description: External merchant ID from provider
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       403:
 *         description: Forbidden - insufficient role permissions
 *       404:
 *         description: Venue not found or not accessible
 *       500:
 *         description: Internal server error
 */
router.get(
  '/venues/:venueId/merchant-accounts',
  authenticateTokenMiddleware,
  checkPermission('payments:read'),
  validateRequest(venueIdParamSchema),
  paymentController.getMerchantAccounts,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/menta/route:
 *   post:
 *     tags:
 *       - TPV - Payments
 *     summary: Get Menta payment routing information
 *     description: Get dynamic merchant credentials and routing information for Menta payment processing
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The ID of the venue
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *               - merchantAccountId
 *               - terminalSerial
 *             properties:
 *               amount:
 *                 type: integer
 *                 description: Payment amount in cents
 *               factura:
 *                 type: boolean
 *                 description: Whether this payment should generate an invoice
 *                 default: false
 *               bin:
 *                 type: string
 *                 description: Card BIN (first 6 digits) for routing decisions
 *                 nullable: true
 *               merchantAccountId:
 *                 type: string
 *                 format: cuid
 *                 description: Selected merchant account ID
 *               terminalSerial:
 *                 type: string
 *                 description: Terminal serial number
 *     responses:
 *       200:
 *         description: Menta routing information retrieved successfully
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
 *                     route:
 *                       type: string
 *                       description: Routing decision (primary/secondary/tertiary)
 *                     merchantId:
 *                       type: string
 *                       description: Merchant ID for this transaction
 *                     apiKeyMerchant:
 *                       type: string
 *                       description: API key for merchant operations
 *                     customerId:
 *                       type: string
 *                       description: Customer ID in Menta system
 *                     acquirer:
 *                       type: string
 *                       description: Acquirer identifier (BANORTE, GPS, etc.)
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       403:
 *         description: Forbidden - insufficient role permissions
 *       404:
 *         description: Venue or merchant account not found
 *       500:
 *         description: Internal server error
 */
router.post(
  '/venues/:venueId/menta/route',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  validateRequest(paymentRouteSchema),
  paymentController.getMentaRoute,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/shift:
 *   get:
 *     tags:
 *       - TPV - Shifts
 *     summary: Get current active shift
 *     description: Retrieve the current active shift for a venue
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The ID of the venue
 *       - in: query
 *         name: pos_name
 *         schema:
 *           type: string
 *         description: POS name (optional)
 *     responses:
 *       200:
 *         description: Current shift retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   properties:
 *                     shift:
 *                       type: null
 *                   description: No active shift found
 *                 - type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     venueId:
 *                       type: string
 *                     startTime:
 *                       type: string
 *                       format: date-time
 *                     endTime:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       403:
 *         description: Forbidden - insufficient role permissions
 *       500:
 *         description: Internal server error
 */
router.get(
  '/venues/:venueId/shift',
  authenticateTokenMiddleware,
  checkPermission('shifts:read'),
  validateRequest(shiftQuerySchema),
  shiftController.getCurrentShift,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/shifts/open:
 *   post:
 *     tags:
 *       - TPV - Shifts
 *     summary: Open a new shift
 *     description: Open a new shift for the venue (works with both integrated POS and standalone mode)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The ID of the venue
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - staffId
 *             properties:
 *               staffId:
 *                 type: string
 *                 format: cuid
 *                 description: Staff member opening the shift
 *               startingCash:
 *                 type: number
 *                 description: Starting cash amount
 *                 default: 0
 *               stationId:
 *                 type: string
 *                 description: POS station ID (optional)
 *     responses:
 *       201:
 *         description: Shift opened successfully
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
 *                     id:
 *                       type: string
 *                     venueId:
 *                       type: string
 *                     staffId:
 *                       type: string
 *                     startTime:
 *                       type: string
 *                       format: date-time
 *                     status:
 *                       type: string
 *                       enum: [OPEN]
 *                     startingCash:
 *                       type: number
 *                     externalId:
 *                       type: string
 *                       nullable: true
 *       400:
 *         description: Bad request - Missing required fields or shift already open
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       403:
 *         description: Forbidden - insufficient role permissions
 *       404:
 *         description: Venue or staff not found
 *       500:
 *         description: Internal server error
 */
router.post('/venues/:venueId/shifts/open', authenticateTokenMiddleware, checkPermission('shifts:create'), shiftController.openShift)

/**
 * @openapi
 * /tpv/venues/{venueId}/shifts/{shiftId}/close:
 *   post:
 *     tags:
 *       - TPV - Shifts
 *     summary: Close an existing shift
 *     description: Close an existing shift with cash reconciliation (works with both integrated POS and standalone mode)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The ID of the venue
 *       - in: path
 *         name: shiftId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The ID of the shift to close
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               cashDeclared:
 *                 type: number
 *                 description: Cash amount declared at closing
 *                 default: 0
 *               cardDeclared:
 *                 type: number
 *                 description: Card payment amount declared
 *                 default: 0
 *               vouchersDeclared:
 *                 type: number
 *                 description: Vouchers amount declared
 *                 default: 0
 *               otherDeclared:
 *                 type: number
 *                 description: Other payment methods amount declared
 *                 default: 0
 *               notes:
 *                 type: string
 *                 description: Optional closing notes
 *     responses:
 *       200:
 *         description: Shift closed successfully
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
 *                     id:
 *                       type: string
 *                     venueId:
 *                       type: string
 *                     staffId:
 *                       type: string
 *                     startTime:
 *                       type: string
 *                       format: date-time
 *                     endTime:
 *                       type: string
 *                       format: date-time
 *                     status:
 *                       type: string
 *                       enum: [CLOSED]
 *                     totalSales:
 *                       type: number
 *                     totalTips:
 *                       type: number
 *                     cashDeclared:
 *                       type: number
 *                     cardDeclared:
 *                       type: number
 *       400:
 *         description: Bad request - Shift already closed
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       403:
 *         description: Forbidden - insufficient role permissions
 *       404:
 *         description: Shift not found
 *       500:
 *         description: Internal server error
 */
router.post(
  '/venues/:venueId/shifts/:shiftId/close',
  authenticateTokenMiddleware,
  checkPermission('shifts:close'),
  shiftController.closeShift,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/shifts:
 *   get:
 *     tags:
 *       - TPV - Shifts
 *     summary: Get shifts with pagination
 *     description: Retrieve shifts with pagination and filtering options
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The ID of the venue
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of items per page
 *       - in: query
 *         name: pageNumber
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: staffId
 *         schema:
 *           type: string
 *         description: Filter by staff member ID
 *       - in: query
 *         name: startTime
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter shifts from this date
 *       - in: query
 *         name: endTime
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter shifts to this date
 *     responses:
 *       200:
 *         description: Shifts retrieved successfully
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
 *                       venueId:
 *                         type: string
 *                       startTime:
 *                         type: string
 *                         format: date-time
 *                       endTime:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                       tipsSum:
 *                         type: number
 *                       paymentSum:
 *                         type: number
 *                       avgTipPercentage:
 *                         type: number
 *                 meta:
 *                   type: object
 *                   properties:
 *                     totalCount:
 *                       type: integer
 *                     currentPage:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       403:
 *         description: Forbidden - insufficient role permissions
 *       400:
 *         description: Invalid pagination parameters
 *       500:
 *         description: Internal server error
 */
router.get(
  '/venues/:venueId/shifts',
  authenticateTokenMiddleware,
  checkPermission('shifts:read'),
  validateRequest(shiftsQuerySchema),
  shiftController.getShifts,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/shifts-summary:
 *   get:
 *     tags:
 *       - TPV - Shifts
 *     summary: Get shift summary with totals
 *     description: Retrieve aggregated shift data with sales, tips, and staff breakdown
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The ID of the venue
 *       - in: query
 *         name: staffId
 *         schema:
 *           type: string
 *         description: Filter by staff member ID
 *       - in: query
 *         name: startTime
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter shifts from this date
 *       - in: query
 *         name: endTime
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter shifts to this date
 *     responses:
 *       200:
 *         description: Shift summary retrieved successfully
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
 *                     dateRange:
 *                       type: object
 *                       properties:
 *                         startTime:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *                         endTime:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *                     summary:
 *                       type: object
 *                       properties:
 *                         totalSales:
 *                           type: number
 *                         totalTips:
 *                           type: number
 *                         ordersCount:
 *                           type: integer
 *                         averageTipPercentage:
 *                           type: number
 *                         ratingsCount:
 *                           type: integer
 *                     waiterTips:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           staffId:
 *                             type: string
 *                           name:
 *                             type: string
 *                           amount:
 *                             type: number
 *                           count:
 *                             type: integer
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       403:
 *         description: Forbidden - insufficient role permissions
 *       400:
 *         description: Invalid date filters
 *       500:
 *         description: Internal server error
 */
router.get(
  '/venues/:venueId/shifts-summary',
  authenticateTokenMiddleware,
  checkPermission('shifts:read'),
  validateRequest(shiftsSummaryQuerySchema),
  shiftController.getShiftsSummary,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/reports/historical:
 *   get:
 *     tags:
 *       - TPV Reports
 *     summary: Get historical sales summaries grouped by time period
 *     description: |
 *       Retrieve aggregated sales data for multiple time periods with period-over-period comparisons.
 *       Supports grouping by day, week, month, quarter, or year with automatic comparison calculations.
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The ID of the venue
 *       - in: query
 *         name: grouping
 *         required: true
 *         schema:
 *           type: string
 *           enum: [DAILY, WEEKLY, MONTHLY, QUARTERLY, YEARLY]
 *         description: Time grouping for aggregation
 *       - in: query
 *         name: startDate
 *         required: true
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Start date for historical range (ISO 8601)
 *       - in: query
 *         name: endDate
 *         required: true
 *         schema:
 *           type: string
 *           format: date-time
 *         description: End date for historical range (ISO 8601)
 *       - in: query
 *         name: cursor
 *         required: false
 *         schema:
 *           type: string
 *         description: Pagination cursor (timestamp)
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Number of periods to return
 *     responses:
 *       200:
 *         description: Historical summaries retrieved successfully
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
 *                     periods:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           periodStart:
 *                             type: string
 *                             format: date-time
 *                           periodEnd:
 *                             type: string
 *                             format: date-time
 *                           grouping:
 *                             type: string
 *                             enum: [DAILY, WEEKLY, MONTHLY, QUARTERLY, YEARLY]
 *                           label:
 *                             type: string
 *                             example: "15 Enero 2025"
 *                           subtitle:
 *                             type: string
 *                             example: "Martes"
 *                           totalSales:
 *                             type: number
 *                           totalOrders:
 *                             type: integer
 *                           totalProducts:
 *                             type: integer
 *                           averageOrderValue:
 *                             type: number
 *                           salesChange:
 *                             type: number
 *                             nullable: true
 *                             description: Percentage change vs previous period
 *                           ordersChange:
 *                             type: number
 *                             nullable: true
 *                             description: Percentage change vs previous period
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         nextCursor:
 *                           type: string
 *                           nullable: true
 *                         hasMore:
 *                           type: boolean
 *       400:
 *         description: Invalid parameters
 *       404:
 *         description: Venue not found
 *       500:
 *         description: Internal server error
 */
router.get(
  '/venues/:venueId/reports/historical',
  authenticateTokenMiddleware,
  checkPermission('reports:read'),
  reportsController.getHistoricalReports,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/auth:
 *   post:
 *     tags:
 *       - TPV Auth
 *     summary: Staff sign-in using PIN
 *     description: Authenticate staff member using PIN for TPV access
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The ID of the venue
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               pin:
 *                 type: string
 *                 description: Staff PIN (4-6 digits)
 *                 example: "1234"
 *             required:
 *               - pin
 *     responses:
 *       200:
 *         description: Staff signed in successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   format: cuid
 *                 staffId:
 *                   type: string
 *                   format: cuid
 *                 venueId:
 *                   type: string
 *                   format: cuid
 *                 role:
 *                   type: string
 *                   enum: [ADMIN, MANAGER, WAITER, CASHIER, KITCHEN]
 *                 permissions:
 *                   type: object
 *                   nullable: true
 *                 totalSales:
 *                   type: number
 *                   format: decimal
 *                 totalTips:
 *                   type: number
 *                   format: decimal
 *                 averageRating:
 *                   type: number
 *                   format: decimal
 *                 totalOrders:
 *                   type: integer
 *                 staff:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: cuid
 *                     firstName:
 *                       type: string
 *                     lastName:
 *                       type: string
 *                     email:
 *                       type: string
 *                       format: email
 *                     phone:
 *                       type: string
 *                       nullable: true
 *                     employeeCode:
 *                       type: string
 *                       nullable: true
 *                     photoUrl:
 *                       type: string
 *                       nullable: true
 *                     active:
 *                       type: boolean
 *                 venue:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: cuid
 *                     name:
 *                       type: string
 *       400:
 *         description: Bad request - Missing PIN or venue ID
 *       404:
 *         description: Pin Incorrecto
 *       500:
 *         description: Internal server error
 */

/**
 * @openapi
 * /tpv/activate:
 *   post:
 *     tags: [TPV - Activation]
 *     summary: Activate terminal with activation code
 *     description: |
 *       Activates a terminal using its serial number and a 6-character activation code.
 *       This is similar to Square POS device activation flow.
 *
 *       **First-time Setup:**
 *       1. Admin generates activation code from dashboard (expires in 7 days)
 *       2. Android app automatically detects device serial number
 *       3. User enters activation code manually
 *       4. Terminal becomes activated and receives venueId
 *       5. Subsequent app launches go directly to login screen
 *
 *       **Security:**
 *       - Maximum 5 failed attempts before lockout
 *       - Code expires after 7 days
 *       - Single-use codes (cleared after activation)
 *       - Case-insensitive code matching
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - serialNumber
 *               - activationCode
 *             properties:
 *               serialNumber:
 *                 type: string
 *                 description: Device serial number (auto-detected by Android app)
 *                 example: "AVQD-1A2B3C4D5E6F"
 *               activationCode:
 *                 type: string
 *                 description: 6-character alphanumeric code (case-insensitive)
 *                 example: "A3F9K2"
 *                 pattern: "^[A-Z0-9]{6}$"
 *     responses:
 *       200:
 *         description: Terminal activated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 venueId:
 *                   type: string
 *                   format: cuid
 *                   description: Venue ID assigned to this terminal
 *                 terminalId:
 *                   type: string
 *                   format: cuid
 *                   description: Terminal ID
 *                 venueName:
 *                   type: string
 *                   description: Venue name
 *                 venueSlug:
 *                   type: string
 *                   description: Venue URL slug
 *                 activatedAt:
 *                   type: string
 *                   format: date-time
 *                   description: Activation timestamp
 *       400:
 *         description: Bad request (invalid code, expired, already activated)
 *       401:
 *         description: Unauthorized (invalid code, too many attempts)
 *       404:
 *         description: Terminal not registered
 *       500:
 *         description: Internal server error
 */
router.post('/activate', validateRequest(activateTerminalSchema), activationController.activateTerminal)

/**
 * @openapi
 * /tpv/terminals/{serialNumber}/activation-status:
 *   get:
 *     tags: [TPV - Activation]
 *     summary: Check terminal activation status
 *     description: |
 *       Checks if a terminal is activated by verifying backend activatedAt field.
 *       Used by SplashScreen to prevent routing to LoginScreen when terminal is not activated.
 *
 *       **Square/Toast Pattern:**
 *       - SplashScreen calls this BEFORE routing to Login
 *       - If not activated → route to ActivationScreen
 *       - If activated → route to LoginScreen (if no session) or HomeScreen (if session)
 *       - If RETIRED → clear local data and force re-activation (will fail)
 *
 *       **Security:**
 *       - No authentication required (terminal needs to check before login)
 *       - Returns RETIRED status to force logout of stolen devices
 *       - Returns Spanish error messages for user-friendly UX
 *     parameters:
 *       - in: path
 *         name: serialNumber
 *         required: true
 *         schema:
 *           type: string
 *         description: Device serial number (e.g., AVQD-1A2B3C4D5E6F)
 *         example: "AVQD-2841548417"
 *     responses:
 *       200:
 *         description: Activation status returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isActivated:
 *                   type: boolean
 *                   description: Whether terminal is activated (activatedAt !== null)
 *                 status:
 *                   type: string
 *                   enum: [ACTIVE, INACTIVE, MAINTENANCE, RETIRED]
 *                   description: Current terminal status
 *                 venueId:
 *                   type: string
 *                   format: cuid
 *                   description: Venue ID (null if not activated)
 *                   nullable: true
 *                 venueName:
 *                   type: string
 *                   description: Venue name (only if activated)
 *                 venueSlug:
 *                   type: string
 *                   description: Venue URL slug (only if activated)
 *                 activatedAt:
 *                   type: string
 *                   format: date-time
 *                   description: Activation timestamp (only if activated)
 *                 message:
 *                   type: string
 *                   description: Spanish user-friendly message
 *       404:
 *         description: Terminal not registered
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Terminal no registrado. Contacta a tu administrador."
 *       500:
 *         description: Internal server error
 */
router.get('/terminals/:serialNumber/activation-status', activationController.checkActivationStatus)

/**
 * @openapi
 * /tpv/terminals/{serialNumber}/config:
 *   get:
 *     tags: [TPV - Terminal Configuration]
 *     summary: Get terminal configuration with assigned merchant accounts
 *     description: |
 *       Fetch terminal configuration for Android TPV app on startup.
 *       Returns terminal info + assigned merchant accounts for multi-merchant support.
 *
 *       **Use Case:**
 *       - Android app calls this on startup to get dynamic config
 *       - No authentication required (terminal needs config before login)
 *       - Only returns active merchant accounts assigned to this terminal
 *
 *       **Multi-Merchant Flow:**
 *       1. Android fetches config for serial "2841548417"
 *       2. Backend returns terminal + 2 merchant accounts (Main + Ghost Kitchen)
 *       3. Android stores in TerminalConfig object
 *       4. User can switch between merchants in payment screen
 *     parameters:
 *       - in: path
 *         name: serialNumber
 *         required: true
 *         schema:
 *           type: string
 *           example: "2841548417"
 *         description: Terminal serial number (printed on hardware)
 *     responses:
 *       200:
 *         description: Terminal config retrieved successfully
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
 *                     terminal:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                           example: "term_xxxxx"
 *                         serialNumber:
 *                           type: string
 *                           example: "2841548417"
 *                         brand:
 *                           type: string
 *                           example: "PAX"
 *                         model:
 *                           type: string
 *                           example: "A910S"
 *                         status:
 *                           type: string
 *                           enum: [ACTIVE, INACTIVE, MAINTENANCE]
 *                         venueId:
 *                           type: string
 *                         venue:
 *                           type: object
 *                           properties:
 *                             id:
 *                               type: string
 *                             name:
 *                               type: string
 *                     merchantAccounts:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             example: "ma_xxxxx"
 *                           displayName:
 *                             type: string
 *                             example: "Main Account"
 *                           serialNumber:
 *                             type: string
 *                             example: "2841548417"
 *                           posId:
 *                             type: string
 *                             example: "376"
 *                           environment:
 *                             type: string
 *                             enum: [SANDBOX, PRODUCTION]
 *                           merchantId:
 *                             type: string
 *                           credentials:
 *                             type: object
 *                             description: Encrypted credentials (decrypted by Android)
 *                           providerConfig:
 *                             type: object
 *       404:
 *         description: Terminal not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Terminal not found with serial number: 2841548417"
 */
router.get('/terminals/:serialNumber/config', validateRequest(serialNumberParamSchema), terminalController.getTerminalConfig)

router.post('/venues/:venueId/auth', pinLoginRateLimiter, validateRequest(pinLoginSchema), authController.staffSignIn)

/**
 * @openapi
 * /tpv/auth/refresh:
 *   post:
 *     tags: [TPV - Authentication]
 *     summary: Refresh access token
 *     description: Generate a new access token using a valid refresh token. This allows users to maintain their session without re-entering their PIN.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 description: Valid refresh token received during login
 *                 example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *     responses:
 *       200:
 *         description: Access token refreshed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accessToken:
 *                   type: string
 *                   description: New JWT access token
 *                 expiresIn:
 *                   type: number
 *                   description: Token expiration time in seconds (3600 = 1 hour)
 *                 tokenType:
 *                   type: string
 *                   description: Token type (always "Bearer")
 *                 correlationId:
 *                   type: string
 *                   description: Unique correlation ID for request tracing
 *                 issuedAt:
 *                   type: string
 *                   format: date-time
 *                   description: Token issue timestamp in ISO 8601 format
 *       400:
 *         description: Bad request - Missing refresh token
 *       401:
 *         description: Unauthorized - Invalid or expired refresh token
 *       500:
 *         description: Internal server error
 */
router.post('/auth/refresh', validateRequest(refreshTokenSchema), authController.refreshAccessToken)

/**
 * @openapi
 * /tpv/auth/logout:
 *   post:
 *     tags: [TPV - Authentication]
 *     summary: Logout staff member (Cambio de usuario)
 *     description: Logout staff member from TPV. Records logout event for audit purposes. Client should clear tokens from secure storage after calling this endpoint.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - accessToken
 *             properties:
 *               accessToken:
 *                 type: string
 *                 description: Valid access token to logout
 *                 example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *     responses:
 *       200:
 *         description: Logout successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   description: Success message
 *                   example: "Logout successful"
 *                 loggedOutAt:
 *                   type: string
 *                   format: date-time
 *                   description: Logout timestamp in ISO 8601 format
 *       400:
 *         description: Bad request - Missing access token
 *       401:
 *         description: Unauthorized - Invalid or expired access token
 *       500:
 *         description: Internal server error
 */
router.post('/auth/logout', validateRequest(logoutSchema), authController.staffLogout)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}:
 *   post:
 *     tags: [TPV - Payments]
 *     security:
 *       - bearerAuth: []
 *     summary: Record a payment for a specific table
 *     description: Records a payment transaction for an order
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The venue ID
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The order ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - venueId
 *               - amount
 *               - tip
 *               - status
 *               - method
 *               - splitType
 *               - staffId
 *             properties:
 *               venueId:
 *                 type: string
 *                 format: cuid
 *               amount:
 *                 type: integer
 *                 description: Payment amount in cents
 *               tip:
 *                 type: integer
 *                 description: Tip amount in cents
 *               status:
 *                 type: string
 *                 enum: [COMPLETED, PENDING, FAILED, PROCESSING, REFUNDED]
 *               method:
 *                 type: string
 *                 enum: [CASH, CREDIT_CARD, DEBIT_CARD, DIGITAL_WALLET]
 *               splitType:
 *                 type: string
 *                 enum: [PERPRODUCT, EQUALPARTS, CUSTOMAMOUNT, FULLPAYMENT]
 *               staffId:
 *                 type: string
 *                 format: cuid
 *               paidProductsId:
 *                 type: array
 *                 items:
 *                   type: string
 *               cardBrand:
 *                 type: string
 *               last4:
 *                 type: string
 *               typeOfCard:
 *                 type: string
 *                 enum: [CREDIT, DEBIT]
 *               currency:
 *                 type: string
 *                 default: MXN
 *               bank:
 *                 type: string
 *               mentaAuthorizationReference:
 *                 type: string
 *               mentaOperationId:
 *                 type: string
 *                 format: uuid
 *               mentaTicketId:
 *                 type: string
 *               isInternational:
 *                 type: boolean
 *                 default: false
 *               reviewRating:
 *                 type: string
 *     responses:
 *       201:
 *         description: Payment recorded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized - Missing or invalid token
 *       403:
 *         description: Forbidden - Role not allowed
 *       400:
 *         description: Bad request - Invalid payment data
 *       404:
 *         description: Table or order not found
 *       500:
 *         description: Internal server error
 */
router.post(
  '/venues/:venueId/orders/:orderId',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  validateRequest(recordPaymentParamsSchema),
  validateRequest(recordPaymentBodySchema),
  paymentController.recordPayment,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/fast:
 *   post:
 *     tags: [TPV - Payments]
 *     security:
 *       - bearerAuth: []
 *     summary: Record a fast payment (without table association)
 *     description: Records a fast payment transaction without associating it to a specific table
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The venue ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - venueId
 *               - amount
 *               - tip
 *               - status
 *               - method
 *               - splitType
 *               - tpvId
 *               - waiterName
 *             properties:
 *               venueId:
 *                 type: string
 *                 format: cuid
 *               amount:
 *                 type: integer
 *                 description: Payment amount in cents
 *               tip:
 *                 type: integer
 *                 description: Tip amount in cents
 *               status:
 *                 type: string
 *                 enum: [ACCEPTED, PENDING, DECLINED]
 *               method:
 *                 type: string
 *                 enum: [CASH, CARD]
 *               splitType:
 *                 type: string
 *                 enum: [PERPRODUCT, EQUALPARTS, CUSTOMAMOUNT, FULLPAYMENT]
 *               tpvId:
 *                 type: string
 *                 format: cuid
 *               waiterName:
 *                 type: string
 *               paidProductsId:
 *                 type: array
 *                 items:
 *                   type: string
 *               cardBrand:
 *                 type: string
 *               last4:
 *                 type: string
 *               typeOfCard:
 *                 type: string
 *                 enum: [CREDIT, DEBIT]
 *               currency:
 *                 type: string
 *                 default: MXN
 *               bank:
 *                 type: string
 *               mentaAuthorizationReference:
 *                 type: string
 *               mentaOperationId:
 *                 type: string
 *                 format: uuid
 *               mentaTicketId:
 *                 type: string
 *               isInternational:
 *                 type: boolean
 *                 default: false
 *               reviewRating:
 *                 type: string
 *     responses:
 *       201:
 *         description: Fast payment recorded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized - Missing or invalid token
 *       403:
 *         description: Forbidden - Role not allowed
 *       400:
 *         description: Bad request - Invalid payment data
 *       500:
 *         description: Internal server error
 */
router.post(
  '/venues/:venueId/fast',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  validateRequest(recordFastPaymentParamsSchema),
  validateRequest(recordPaymentBodySchema),
  paymentController.recordFastPayment,
)

// ==========================================
// TIME ENTRY ROUTES
// ==========================================

/**
 * Clock in
 */
router.post('/venues/:venueId/time-entries/clock-in', authenticateTokenMiddleware, timeEntryController.clockIn)

/**
 * Clock out
 */
router.post('/venues/:venueId/time-entries/clock-out', authenticateTokenMiddleware, timeEntryController.clockOut)

/**
 * Start break
 */
router.post('/time-entries/:timeEntryId/break/start', authenticateTokenMiddleware, timeEntryController.startBreak)

/**
 * End break
 */
router.post('/time-entries/:timeEntryId/break/end', authenticateTokenMiddleware, timeEntryController.endBreak)

/**
 * Get time entries for a venue
 */
router.get(
  '/venues/:venueId/time-entries',
  authenticateTokenMiddleware,
  checkPermission('shifts:manage'),
  timeEntryController.getTimeEntries,
)

/**
 * Get staff time summary
 */
router.get('/staff/:staffId/time-summary', authenticateTokenMiddleware, timeEntryController.getStaffTimeSummary)

/**
 * Get currently clocked in staff
 */
router.get(
  '/venues/:venueId/time-entries/active',
  authenticateTokenMiddleware,
  checkPermission('shifts:manage'),
  timeEntryController.getCurrentlyClockedInStaff,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/tables:
 *   get:
 *     summary: Get all tables with current status for floor plan display
 *     tags: [Tables]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *         description: Venue ID
 *     responses:
 *       200:
 *         description: List of tables with their current status and orders
 */
router.get('/venues/:venueId/tables', authenticateTokenMiddleware, validateRequest(tableParamsSchema), tableController.getTables)

/**
 * @openapi
 * /tpv/venues/{venueId}/tables/assign:
 *   post:
 *     summary: Assign a table to create or return existing order
 *     tags: [Tables]
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
 *               tableId:
 *                 type: string
 *               staffId:
 *                 type: string
 *               covers:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Existing order returned
 *       201:
 *         description: New order created
 */
router.post('/venues/:venueId/tables/assign', authenticateTokenMiddleware, validateRequest(assignTableSchema), tableController.assignTable)

// POST /venues/:venueId/tables - Create a new table
router.post('/venues/:venueId/tables', authenticateTokenMiddleware, tableController.createTable)

// PUT /venues/:venueId/tables/:tableId/position - Update table position on floor plan
router.put('/venues/:venueId/tables/:tableId/position', authenticateTokenMiddleware, tableController.updateTablePosition)

// PUT /venues/:venueId/tables/:tableId - Update table properties (number, capacity, shape, rotation, areaId)
router.put('/venues/:venueId/tables/:tableId', authenticateTokenMiddleware, tableController.updateTable)

// DELETE /venues/:venueId/tables/:tableId - Delete a table (soft delete)
router.delete('/venues/:venueId/tables/:tableId', authenticateTokenMiddleware, tableController.deleteTable)

/**
 * @openapi
 * /tpv/venues/{venueId}/tables/{tableId}/clear:
 *   post:
 *     summary: Clear table after payment is completed
 *     tags: [Tables]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: tableId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Table cleared successfully
 */
router.post(
  '/venues/:venueId/tables/:tableId/clear',
  authenticateTokenMiddleware,
  validateRequest(clearTableSchema),
  tableController.clearTable,
)

// ============================================
// FLOOR ELEMENTS (Walls, Bars, Service Areas, Labels)
// ============================================

/**
 * GET /tpv/venues/:venueId/floor-elements
 * Get all floor elements for floor plan display
 */
router.get('/venues/:venueId/floor-elements', authenticateTokenMiddleware, floorElementController.getFloorElements)

/**
 * POST /tpv/venues/:venueId/floor-elements
 * Create a new floor element
 */
router.post('/venues/:venueId/floor-elements', authenticateTokenMiddleware, floorElementController.createFloorElement)

/**
 * PUT /tpv/venues/:venueId/floor-elements/:elementId
 * Update a floor element
 */
router.put('/venues/:venueId/floor-elements/:elementId', authenticateTokenMiddleware, floorElementController.updateFloorElement)

/**
 * DELETE /tpv/venues/:venueId/floor-elements/:elementId
 * Delete a floor element (soft delete)
 */
router.delete('/venues/:venueId/floor-elements/:elementId', authenticateTokenMiddleware, floorElementController.deleteFloorElement)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/items:
 *   patch:
 *     summary: Add items to an existing order with version control
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: orderId
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
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     productId:
 *                       type: string
 *                     quantity:
 *                       type: integer
 *                     notes:
 *                       type: string
 *               version:
 *                 type: integer
 *                 description: Current version number for optimistic locking
 *     responses:
 *       200:
 *         description: Items added successfully
 *       400:
 *         description: Version mismatch (concurrent update detected)
 */
router.patch(
  '/venues/:venueId/orders/:orderId/items',
  authenticateTokenMiddleware,
  validateRequest(addOrderItemsSchema),
  orderController.addItemsToOrder,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/items/{itemId}:
 *   delete:
 *     tags:
 *       - TPV - Orders
 *     summary: Remove an item from an order
 *     description: Delete a specific item from an order with optimistic locking
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *       - in: query
 *         name: version
 *         required: true
 *         schema:
 *           type: integer
 *         description: Current version number for optimistic locking
 *     responses:
 *       200:
 *         description: Item removed successfully
 *       400:
 *         description: Version mismatch or order already paid
 *       404:
 *         description: Order or item not found
 */
router.delete(
  '/venues/:venueId/orders/:orderId/items/:itemId',
  authenticateTokenMiddleware,
  checkPermission('orders:update'),
  validateRequest(removeOrderItemSchema),
  orderController.removeOrderItem,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/guest:
 *   patch:
 *     tags:
 *       - TPV - Orders
 *     summary: Update guest information for an order
 *     description: Update covers, customer name, phone, and special requests
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *       - in: path
 *         name: orderId
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
 *               covers:
 *                 type: integer
 *                 minimum: 1
 *               customerName:
 *                 type: string
 *                 nullable: true
 *               customerPhone:
 *                 type: string
 *                 nullable: true
 *               specialRequests:
 *                 type: string
 *                 nullable: true
 *                 description: Allergies, dietary restrictions, special occasions
 *     responses:
 *       200:
 *         description: Guest information updated successfully
 *       404:
 *         description: Order not found
 */
router.patch(
  '/venues/:venueId/orders/:orderId/guest',
  authenticateTokenMiddleware,
  checkPermission('orders:update'),
  validateRequest(updateGuestInfoSchema),
  orderController.updateGuestInfo,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/comp:
 *   post:
 *     tags:
 *       - TPV - Orders
 *     summary: Comp items or entire order
 *     description: Comp specific items or the entire order (for service recovery, food quality issues, etc.)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *       - in: path
 *         name: orderId
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
 *             required:
 *               - reason
 *               - staffId
 *             properties:
 *               itemIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: cuid
 *                 default: []
 *                 description: Empty array = comp entire order
 *               reason:
 *                 type: string
 *                 description: Required reason for comp
 *               staffId:
 *                 type: string
 *                 format: cuid
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Items comped successfully
 *       400:
 *         description: Order already paid
 *       404:
 *         description: Order not found
 */
router.post(
  '/venues/:venueId/orders/:orderId/comp',
  authenticateTokenMiddleware,
  checkPermission('orders:comp'),
  validateRequest(compItemsSchema),
  orderController.compItems,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/void:
 *   post:
 *     tags:
 *       - TPV - Orders
 *     summary: Void items from an order
 *     description: Void specific items (for incorrectly entered items, customer cancellation, etc.)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *       - in: path
 *         name: orderId
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
 *             required:
 *               - itemIds
 *               - reason
 *               - staffId
 *               - expectedVersion
 *             properties:
 *               itemIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: cuid
 *                 minItems: 1
 *               reason:
 *                 type: string
 *               staffId:
 *                 type: string
 *                 format: cuid
 *               expectedVersion:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Items voided successfully
 *       400:
 *         description: Version mismatch or order already paid
 *       404:
 *         description: Order not found
 */
router.post(
  '/venues/:venueId/orders/:orderId/void',
  authenticateTokenMiddleware,
  checkPermission('orders:void'),
  validateRequest(voidItemsSchema),
  orderController.voidItems,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/discount:
 *   post:
 *     tags:
 *       - TPV - Orders
 *     summary: Apply discount to order or specific items
 *     description: Apply percentage or fixed amount discount
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *       - in: path
 *         name: orderId
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
 *             required:
 *               - type
 *               - value
 *               - staffId
 *               - expectedVersion
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [PERCENTAGE, FIXED_AMOUNT]
 *               value:
 *                 type: number
 *                 description: 1-100 for percentage, dollar amount for fixed
 *               reason:
 *                 type: string
 *               staffId:
 *                 type: string
 *                 format: cuid
 *               itemIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: cuid
 *                 nullable: true
 *                 description: Null = order-level discount
 *               expectedVersion:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Discount applied successfully
 *       400:
 *         description: Invalid discount value or version mismatch
 *       404:
 *         description: Order not found
 */
router.post(
  '/venues/:venueId/orders/:orderId/discount',
  authenticateTokenMiddleware,
  checkPermission('orders:discount'),
  validateRequest(applyDiscountSchema),
  orderController.applyDiscount,
)

export default router
