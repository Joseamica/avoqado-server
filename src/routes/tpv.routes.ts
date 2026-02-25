import express, { Request, Response, NextFunction } from 'express'
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
  sendReceiptParamsSchema,
  sendReceiptBodySchema,
  paymentRouteSchema,
  tableParamsSchema,
  assignTableSchema,
  clearTableSchema,
  addOrderItemsSchema,
  removeOrderItemSchema,
  updateGuestInfoSchema,
  addOrderCustomerSchema,
  removeOrderCustomerSchema,
  createAndAddCustomerSchema,
  compItemsSchema,
  voidItemsSchema,
  applyDiscountSchema,
  getAvailableDiscountsSchema,
  applyAutomaticDiscountsSchema,
  applyPredefinedDiscountSchema,
  applyManualDiscountSchema,
  applyCouponCodeSchema,
  validateCouponSchema,
  removeOrderDiscountSchema,
  getOrderDiscountsSchema,
  createSaleVerificationSchema,
  listSaleVerificationsSchema,
  getSaleVerificationSchema,
  createProofOfSaleSchema,
  tpvFeedbackSchema,
  initiateCryptoPaymentSchema,
  cancelCryptoPaymentSchema,
  getCryptoPaymentStatusSchema,
} from '../schemas/tpv.schema'
import { activateTerminalSchema } from '../schemas/activation.schema'
import { trainingIdParamSchema, updateProgressSchema, getStaffProgressQuerySchema } from '../schemas/superadmin/training.schema'
import * as venueController from '../controllers/tpv/venue.tpv.controller'
import * as orderController from '../controllers/tpv/order.tpv.controller'
import * as paymentController from '../controllers/tpv/payment.tpv.controller'
import * as refundController from '../controllers/tpv/refund.tpv.controller'
import * as shiftController from '../controllers/tpv/shift.tpv.controller'
import * as authController from '../controllers/tpv/auth.tpv.controller'
import * as activationController from '../controllers/tpv/activation.controller'
import * as heartbeatController from '../controllers/tpv/heartbeat.tpv.controller'
import * as timeEntryController from '../controllers/tpv/time-entry.tpv.controller'
import * as terminalController from '../controllers/tpv/terminal.tpv.controller'
import * as tableController from '../controllers/tpv/table.tpv.controller'
import * as floorElementController from '../controllers/tpv/floor-element.tpv.controller'
import * as reportsController from '../controllers/tpv/reports.tpv.controller'
import * as customerController from '../controllers/tpv/customer.tpv.controller'
import * as discountController from '../controllers/tpv/discount.tpv.controller'
import * as saleVerificationController from '../controllers/tpv/sale-verification.tpv.controller'
import * as appUpdateController from '../controllers/tpv/appUpdate.tpv.controller'
import * as cryptoController from '../controllers/tpv/crypto.tpv.controller'
import * as tpvMessageController from '../controllers/tpv/tpv-message.tpv.controller'
import * as trainingController from '../controllers/tpv/training.tpv.controller'
import * as productService from '../services/dashboard/product.dashboard.service'
import emailService from '../services/email.service'
import { moduleService } from '../services/modules/module.service'
import { serializedInventoryService } from '../services/serialized-inventory/serializedInventory.service'
import * as salesGoalService from '../services/dashboard/commission/sales-goal.service'
import * as goalResolutionService from '../services/dashboard/commission/goal-resolution.service'
import * as orderTpvService from '../services/tpv/order.tpv.service'
import AppError from '../errors/AppError'
import logger from '../config/logger'
import { Decimal } from '@prisma/client/runtime/library'
import prisma from '../utils/prismaClient'
import { DEFAULT_PERMISSIONS, resolvePermissions, expandWildcards } from '../lib/permissions'
import * as rolePermissionService from '../services/dashboard/rolePermission.service'

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
 * /api/v1/tpv/command-ack:
 *   post:
 *     tags:
 *       - TPV - Health & Commands
 *     summary: Acknowledge command execution (Square Terminal API pattern)
 *     description: |
 *       Called by TPV terminal after processing a command received via heartbeat.
 *       This completes the polling pattern:
 *       1. Dashboard sends command → stored as PENDING in TpvCommandQueue
 *       2. Terminal receives command via heartbeat response
 *       3. Terminal executes command and calls this endpoint
 *       4. Dashboard receives notification via WebSocket
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - commandId
 *               - resultStatus
 *             properties:
 *               commandId:
 *                 type: string
 *                 format: cuid
 *                 description: The ID of the command being acknowledged
 *               resultStatus:
 *                 type: string
 *                 enum: [SUCCESS, FAILED, REJECTED, TIMEOUT]
 *                 description: Result of command execution
 *               resultMessage:
 *                 type: string
 *                 description: Optional human-readable result message
 *               resultPayload:
 *                 type: object
 *                 description: Optional result data (e.g., exported log URL)
 *     responses:
 *       200:
 *         description: Acknowledgment processed successfully
 *       400:
 *         description: Invalid request (missing commandId or resultStatus)
 *       404:
 *         description: Command not found
 */
router.post('/command-ack', heartbeatController.acknowledgeCommand)

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
 * /tpv/venues/{venueId}/orders/pay-later:
 *   get:
 *     tags:
 *       - TPV - Orders
 *     summary: Get pay-later orders
 *     description: Get all orders marked as "pay later" (orders with customer linkage and pending payment status). Used by TPV to display "Pendientes de Pago" filter.
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
 *         description: Pay-later orders retrieved successfully
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
 *                     description: Order with customer information
 *       401:
 *         description: Unauthorized - missing or invalid token
 *       403:
 *         description: Forbidden - insufficient permissions
 *       500:
 *         description: Internal server error
 */
router.get(
  '/venues/:venueId/orders/pay-later',
  authenticateTokenMiddleware,
  checkPermission('orders:read'), // Reuse existing permission
  validateRequest(venueIdParamSchema),
  orderController.getPayLaterOrders,
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
 *   post:
 *     tags:
 *       - TPV - Payments
 *     summary: Get payments for a venue
 *     description: Retrieve payments with pagination and filtering options (uses POST for complex filters in body)
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
router.post(
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
  checkPermission('tpv-reports:read'),
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

// ==========================================
// APP UPDATE ENDPOINTS (Dual Update System)
// Avoqado self-managed updates (independent of Blumon)
// ==========================================

/**
 * @openapi
 * /tpv/check-update:
 *   get:
 *     tags:
 *       - TPV App Updates
 *     summary: Check if a newer app version is available (Avoqado updates)
 *     description: |
 *       **Dual Update System - Avoqado Source**
 *
 *       This endpoint checks for updates managed by Avoqado (independent of Blumon).
 *       The TPV app should check both sources:
 *       1. Blumon: Via CheckVersionUseCase (provider-managed)
 *       2. Avoqado: Via this endpoint (self-managed)
 *
 *       **No authentication required** - called before login.
 *
 *       **Flow:**
 *       1. TPV sends current versionCode and environment
 *       2. Backend checks for newer active version
 *       3. Returns update info including signed APK URL from Firebase Storage
 *
 *     parameters:
 *       - in: query
 *         name: currentVersion
 *         required: true
 *         schema:
 *           type: integer
 *         description: Current app versionCode (e.g., 6)
 *       - in: query
 *         name: environment
 *         required: true
 *         schema:
 *           type: string
 *           enum: [SANDBOX, PRODUCTION]
 *         description: App environment (matches build variant)
 *     responses:
 *       200:
 *         description: Update check result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 hasUpdate:
 *                   type: boolean
 *                 update:
 *                   type: object
 *                   properties:
 *                     versionName:
 *                       type: string
 *                       example: "1.3.0"
 *                     versionCode:
 *                       type: integer
 *                       example: 6
 *                     downloadUrl:
 *                       type: string
 *                       description: Firebase Storage URL for APK download
 *                     fileSize:
 *                       type: string
 *                       description: File size in bytes
 *                     checksum:
 *                       type: string
 *                       description: SHA-256 hash for integrity verification
 *                     releaseNotes:
 *                       type: string
 *                       description: Markdown changelog
 *                     isRequired:
 *                       type: boolean
 *                       description: Force update flag
 *       400:
 *         description: Invalid parameters
 */
router.get('/check-update', appUpdateController.checkForUpdate)

/**
 * @openapi
 * /tpv/report-update-installed:
 *   post:
 *     tags:
 *       - TPV App Updates
 *     summary: Report successful update installation (analytics)
 *     description: |
 *       Called after an update is successfully installed to track adoption.
 *       Updates the terminal's version record.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - versionCode
 *               - versionName
 *               - updateSource
 *             properties:
 *               versionCode:
 *                 type: integer
 *               versionName:
 *                 type: string
 *               updateSource:
 *                 type: string
 *                 enum: [AVOQADO, BLUMON]
 *               serialNumber:
 *                 type: string
 *     responses:
 *       200:
 *         description: Report recorded
 */
router.post('/report-update-installed', authenticateTokenMiddleware, appUpdateController.reportUpdateInstalled)

/**
 * @openapi
 * /tpv/get-version:
 *   get:
 *     tags: [TPV - App Updates]
 *     summary: Get specific app version (for INSTALL_VERSION command)
 *     description: |
 *       Returns download information for a specific version by versionCode.
 *       Used by TPV when processing INSTALL_VERSION command to download
 *       a specific (older or newer) version for rollback/upgrade.
 *
 *       **Use Cases:**
 *       - Rollback to older stable version if new version has bugs
 *       - Upgrade specific terminals to a target version
 *       - SUPERADMIN-initiated version control
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: versionCode
 *         required: true
 *         schema:
 *           type: integer
 *         description: The versionCode of the version to retrieve
 *         example: 5
 *       - in: query
 *         name: environment
 *         required: true
 *         schema:
 *           type: string
 *           enum: [SANDBOX, PRODUCTION]
 *         description: Environment (SANDBOX or PRODUCTION)
 *     responses:
 *       200:
 *         description: Version info or not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 found:
 *                   type: boolean
 *                 version:
 *                   type: object
 *                   properties:
 *                     versionName:
 *                       type: string
 *                     versionCode:
 *                       type: integer
 *                     downloadUrl:
 *                       type: string
 *                     fileSize:
 *                       type: string
 *                     checksum:
 *                       type: string
 *       400:
 *         description: Invalid parameters
 */
router.get('/get-version', authenticateTokenMiddleware, appUpdateController.getSpecificVersion)

/**
 * @openapi
 * /tpv/terminals/{serialNumber}/settings:
 *   put:
 *     tags: [TPV - Terminal Configuration]
 *     summary: Update TPV settings for a specific terminal
 *     description: |
 *       Update payment flow screen configuration for a specific terminal.
 *       Each terminal can have individual settings (different from other terminals in the same venue).
 *
 *       **Configurable Settings:**
 *       - showReviewScreen: Show star rating after amount entry
 *       - showTipScreen: Show tip selection before payment
 *       - showReceiptScreen: Show QR code and print options after payment
 *       - defaultTipPercentage: Pre-selected tip percentage
 *       - tipSuggestions: Available tip percentage options
 *       - requirePinLogin: Require PIN for staff login
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serialNumber
 *         required: true
 *         schema:
 *           type: string
 *         description: Terminal serial number (e.g., "AVQD-2841548417")
 *         example: "AVQD-2841548417"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               showReviewScreen:
 *                 type: boolean
 *                 description: Show star rating screen after amount entry
 *                 example: true
 *               showTipScreen:
 *                 type: boolean
 *                 description: Show tip selection screen before payment
 *                 example: false
 *               showReceiptScreen:
 *                 type: boolean
 *                 description: Show QR code and print button after payment
 *                 example: true
 *               defaultTipPercentage:
 *                 type: integer
 *                 nullable: true
 *                 description: Pre-selected tip percentage (null = no pre-selection)
 *                 example: 15
 *               tipSuggestions:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: Available tip percentage options
 *                 example: [15, 18, 20, 25]
 *               requirePinLogin:
 *                 type: boolean
 *                 description: Require PIN for staff login
 *                 example: false
 *     responses:
 *       200:
 *         description: Settings updated successfully
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
 *                     showReviewScreen:
 *                       type: boolean
 *                     showTipScreen:
 *                       type: boolean
 *                     showReceiptScreen:
 *                       type: boolean
 *                     defaultTipPercentage:
 *                       type: integer
 *                       nullable: true
 *                     tipSuggestions:
 *                       type: array
 *                       items:
 *                         type: integer
 *                     requirePinLogin:
 *                       type: boolean
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       404:
 *         description: Terminal not found
 */
router.put('/terminals/:serialNumber/settings', authenticateTokenMiddleware, terminalController.updateTpvSettings)

router.post('/venues/:venueId/auth', pinLoginRateLimiter, validateRequest(pinLoginSchema), authController.staffSignIn)

/**
 * @openapi
 * /tpv/venues/{venueId}/auth/master:
 *   post:
 *     tags: [TPV - Authentication]
 *     summary: Master TOTP sign-in for emergency SUPERADMIN access
 *     description: |
 *       Uses Google Authenticator TOTP code for emergency access to any TPV.
 *       10-digit code changes every 60 seconds.
 *
 *       **Security:**
 *       - TOTP algorithm (RFC 6238)
 *       - All attempts logged for audit
 *       - Only for emergency/support use
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
 *             required:
 *               - totpCode
 *               - serialNumber
 *             properties:
 *               totpCode:
 *                 type: string
 *                 description: 10-digit TOTP code from Google Authenticator
 *                 example: "1234567890"
 *               serialNumber:
 *                 type: string
 *                 description: Terminal serial number
 *                 example: "AVQD-1234567890"
 *     responses:
 *       200:
 *         description: SUPERADMIN session created
 *       401:
 *         description: Invalid or expired TOTP code
 *       404:
 *         description: Venue or terminal not found
 */
router.post('/venues/:venueId/auth/master', pinLoginRateLimiter, authController.masterSignIn)

/**
 * @openapi
 * /tpv/venues/{venueId}/auth/refresh:
 *   post:
 *     tags: [TPV - Authentication]
 *     summary: Refresh access token (venue-scoped)
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
// ✅ Venue-scoped refresh (used by Android TPV)
router.post('/venues/:venueId/auth/refresh', validateRequest(refreshTokenSchema), authController.refreshAccessToken)
// 🔧 Legacy route (kept for backward compatibility)
router.post('/auth/refresh', validateRequest(refreshTokenSchema), authController.refreshAccessToken)

/**
 * @openapi
 * /tpv/venues/{venueId}/auth/logout:
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
// ✅ Venue-scoped logout (used by Android TPV)
router.post('/venues/:venueId/auth/logout', validateRequest(logoutSchema), authController.staffLogout)
// 🔧 Legacy route (kept for backward compatibility)
router.post('/auth/logout', validateRequest(logoutSchema), authController.staffLogout)

/**
 * @openapi
 * /tpv/auth/permissions:
 *   get:
 *     tags: [TPV - Authentication]
 *     summary: Get current staff permissions
 *     description: |
 *       Retrieves the complete list of resolved permissions for the authenticated staff member.
 *
 *       **Permission Resolution:**
 *       1. Fetches base permissions for the staff role from DEFAULT_PERMISSIONS
 *       2. Fetches custom permissions assigned via dashboard (if any)
 *       3. Merges base + custom permissions
 *       4. Resolves implicit permission dependencies
 *       5. Returns deduplicated set of all permissions
 *
 *       **Use Cases:**
 *       - TPV UI: Show/hide features based on permissions
 *       - Client-side authorization before API calls
 *       - Permission caching in mobile app
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Permissions retrieved successfully
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
 *                     staffId:
 *                       type: string
 *                       description: Staff member ID
 *                     venueId:
 *                       type: string
 *                       description: Venue ID
 *                     role:
 *                       type: string
 *                       enum: [SUPERADMIN, OWNER, ADMIN, MANAGER, CASHIER, WAITER, KITCHEN, HOST, VIEWER]
 *                       description: Staff member role
 *                     permissions:
 *                       type: array
 *                       items:
 *                         type: string
 *                       description: Resolved permissions array (includes base, custom, and implicit dependencies)
 *                       example: ["home:read", "orders:read", "orders:create", "payments:read", "tpv-terminal:settings", "tpv-orders:comp"]
 *       401:
 *         description: Unauthorized - Missing or invalid access token
 *       500:
 *         description: Internal server error
 */
router.get('/auth/permissions', authenticateTokenMiddleware, async (req: Request, res: Response) => {
  try {
    // Get authenticated user from authContext (set by authenticateTokenMiddleware)
    const authContext = req.authContext
    if (!authContext) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized - Missing auth context',
      })
    }

    const { venueId, role } = authContext
    const staffId = authContext.userId

    // 1. Get base permissions for this role
    const basePermissions = DEFAULT_PERMISSIONS[role as keyof typeof DEFAULT_PERMISSIONS] || []

    // 2. Get custom permissions (if any) from VenueRolePermission table
    const customPerms = await rolePermissionService.getRolePermissions(venueId, role)

    // 3. Merge base + custom permissions
    const allPermissions = customPerms ? [...basePermissions, ...customPerms.permissions] : basePermissions

    // 4. Resolve implicit dependencies
    const resolvedPermissionsSet = resolvePermissions(allPermissions)
    const resolvedPermissions = Array.from(resolvedPermissionsSet)

    // 5. Expand wildcards to individual permissions (for TPV client)
    // This ensures SUPERADMIN/OWNER/ADMIN get full permission list instead of ['*:*']
    const expandedPermissions = expandWildcards(resolvedPermissions)

    logger.info(`[TPV] Permissions fetched for staff ${staffId} (${role}): ${expandedPermissions.length} permissions`)

    return res.json({
      success: true,
      data: {
        staffId,
        venueId,
        role,
        permissions: expandedPermissions,
      },
    })
  } catch (error) {
    logger.error('[TPV] Error fetching staff permissions:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch permissions',
    })
  }
})

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
// CRYPTO PAYMENTS (B4Bit Integration)
// ==========================================

/**
 * @openapi
 * /tpv/venues/{venueId}/crypto/initiate:
 *   post:
 *     tags: [TPV - Crypto Payments]
 *     security:
 *       - bearerAuth: []
 *     summary: Initiate a cryptocurrency payment
 *     description: |
 *       Creates a pending payment record and requests a crypto payment order from B4Bit.
 *       Returns a payment URL that can be displayed as a QR code for the customer to scan.
 *
 *       **Flow:**
 *       1. TPV calls this endpoint with payment amount
 *       2. Backend creates pending payment and calls B4Bit API
 *       3. Returns payment URL + request ID for tracking
 *       4. TPV displays QR code from payment URL
 *       5. Customer scans QR and pays with crypto
 *       6. B4Bit sends webhook when payment confirmed
 *       7. Backend emits Socket.IO event to TPV
 *       8. TPV shows success screen
 *
 *       **Supported Cryptocurrencies:**
 *       BTC, ETH, USDT, USDC, DAI, SOL, XRP, and more (13 total)
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
 *               - amount
 *               - staffId
 *             properties:
 *               amount:
 *                 type: integer
 *                 description: Payment amount in centavos (e.g., 5500 = $55.00 MXN)
 *                 example: 5500
 *               tip:
 *                 type: integer
 *                 description: Tip amount in centavos
 *                 example: 500
 *               staffId:
 *                 type: string
 *                 format: cuid
 *                 description: Staff member processing the payment
 *               shiftId:
 *                 type: string
 *                 format: cuid
 *                 description: Current shift ID (optional)
 *               orderId:
 *                 type: string
 *                 format: cuid
 *                 description: Associated order ID (optional, for order payments)
 *               orderNumber:
 *                 type: string
 *                 description: Order number for display
 *               deviceSerialNumber:
 *                 type: string
 *                 description: Terminal serial number
 *               rating:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 5
 *                 description: Customer rating (1-5)
 *     responses:
 *       200:
 *         description: Crypto payment initiated successfully
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
 *                     requestId:
 *                       type: string
 *                       description: B4Bit request ID for tracking
 *                     paymentId:
 *                       type: string
 *                       format: cuid
 *                       description: Internal payment ID
 *                     paymentUrl:
 *                       type: string
 *                       description: URL for QR code generation
 *                       example: "https://pay.b4bit.com/order/abc123"
 *                     expiresAt:
 *                       type: string
 *                       format: date-time
 *                       description: When the payment order expires
 *                     expiresInSeconds:
 *                       type: integer
 *                       description: Seconds until expiration
 *                       example: 900
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Insufficient permissions
 *       400:
 *         description: Bad request
 *       500:
 *         description: B4Bit API error
 */
router.post(
  '/venues/:venueId/crypto/initiate',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  validateRequest(initiateCryptoPaymentSchema),
  cryptoController.initiateCryptoPaymentHandler,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/crypto/cancel:
 *   post:
 *     tags: [TPV - Crypto Payments]
 *     security:
 *       - bearerAuth: []
 *     summary: Cancel a pending crypto payment
 *     description: |
 *       Cancels a pending crypto payment before it's confirmed.
 *       Can only cancel payments in PENDING status.
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
 *             required:
 *               - paymentId
 *             properties:
 *               paymentId:
 *                 type: string
 *                 format: cuid
 *     responses:
 *       200:
 *         description: Payment cancelled
 *       400:
 *         description: Cannot cancel (already completed/failed)
 */
router.post(
  '/venues/:venueId/crypto/cancel',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  validateRequest(cancelCryptoPaymentSchema),
  cryptoController.cancelCryptoPaymentHandler,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/crypto/status/{requestId}:
 *   get:
 *     tags: [TPV - Crypto Payments]
 *     security:
 *       - bearerAuth: []
 *     summary: Get crypto payment status (polling fallback)
 *     description: |
 *       Queries B4Bit API for current payment status.
 *       Use this as a fallback if Socket.IO connection is lost.
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: string
 *         description: B4Bit request ID
 *     responses:
 *       200:
 *         description: Payment status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [PE, AC, CO, OC, EX]
 *                   description: |
 *                     PE = Pending, AC = Awaiting Confirmation,
 *                     CO = Completed, OC = Out of Condition, EX = Expired
 *                 cryptoAmount:
 *                   type: string
 *                 cryptoCurrency:
 *                   type: string
 *                 txHash:
 *                   type: string
 */
router.get(
  '/venues/:venueId/crypto/status/:requestId',
  authenticateTokenMiddleware,
  validateRequest(getCryptoPaymentStatusSchema),
  cryptoController.getCryptoPaymentStatusHandler,
)

// ==========================================
// SEND RECEIPT BY EMAIL
// ==========================================

/**
 * @openapi
 * /tpv/venues/{venueId}/payments/{paymentId}/send-receipt:
 *   post:
 *     summary: Send a payment receipt by email
 *     description: |
 *       Sends the payment receipt to the specified email address.
 *       Uses the same template as the dashboard receipt email.
 *
 *       **Flow:**
 *       1. TPV app displays email input dialog
 *       2. User enters customer email
 *       3. TPV calls this endpoint
 *       4. Backend generates receipt (if not exists) and sends email
 *       5. TPV shows confirmation toast
 *     tags:
 *       - TPV - Payments
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: Venue ID
 *       - in: path
 *         name: paymentId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: Payment ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - recipientEmail
 *             properties:
 *               recipientEmail:
 *                 type: string
 *                 format: email
 *                 description: Email address to send the receipt to
 *     responses:
 *       200:
 *         description: Receipt sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 receiptId:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid email format
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Payment not found
 */
router.post(
  '/venues/:venueId/payments/:paymentId/send-receipt',
  authenticateTokenMiddleware,
  validateRequest(sendReceiptParamsSchema),
  validateRequest(sendReceiptBodySchema),
  paymentController.sendPaymentReceipt,
)

// ==========================================
// REFUND ROUTES
// ==========================================

/**
 * @openapi
 * /tpv/venues/{venueId}/refunds:
 *   post:
 *     summary: Record a refund for an existing payment
 *     description: |
 *       Records a refund that was processed by the Blumon SDK (CancelIcc).
 *       The refund MUST be processed through the same merchant account as the original payment.
 *
 *       **Flow:**
 *       1. TPV app processes refund via Blumon SDK (CancelIcc)
 *       2. TPV app calls this endpoint to record the refund
 *       3. Backend validates and creates refund record
 *       4. Backend updates original payment's refunded tracking
 *       5. Backend generates digital receipt
 *     tags:
 *       - TPV - Refunds
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
 *             required:
 *               - originalPaymentId
 *               - amount
 *               - reason
 *               - staffId
 *               - blumonSerialNumber
 *               - authorizationNumber
 *               - referenceNumber
 *             properties:
 *               originalPaymentId:
 *                 type: string
 *                 description: ID of the original payment being refunded
 *               amount:
 *                 type: integer
 *                 description: Refund amount in cents (5000 = $50.00)
 *               reason:
 *                 type: string
 *                 description: Refund reason (CUSTOMER_REQUEST, DUPLICATE_CHARGE, etc.)
 *               staffId:
 *                 type: string
 *                 description: ID of staff processing the refund
 *               merchantAccountId:
 *                 type: string
 *                 description: Merchant account ID (must match original payment)
 *               blumonSerialNumber:
 *                 type: string
 *                 description: Blumon terminal serial number
 *               authorizationNumber:
 *                 type: string
 *                 description: Authorization code from Blumon CancelIcc
 *               referenceNumber:
 *                 type: string
 *                 description: Reference number from Blumon CancelIcc
 *     responses:
 *       201:
 *         description: Refund recorded successfully
 *       400:
 *         description: Invalid refund data or amount exceeds refundable
 *       404:
 *         description: Original payment not found
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - missing refunds:create permission
 */
router.post(
  '/venues/:venueId/refunds',
  authenticateTokenMiddleware,
  checkPermission('payments:refund'),
  validateRequest(recordFastPaymentParamsSchema), // Reuse for venueId param validation
  refundController.recordRefund,
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
 * Get time entries for a venue (requires shifts:manage permission)
 */
router.get(
  '/venues/:venueId/time-entries',
  authenticateTokenMiddleware,
  checkPermission('shifts:manage'),
  timeEntryController.getTimeEntries,
)

/**
 * Get MY time entries (self-service, no special permissions)
 * Used by TimeclockScreen to show the current clock-in status for the logged-in user.
 * Staff can always see their own clock-in/out history.
 */
router.get(
  '/venues/:venueId/staff/:staffId/time-entries',
  authenticateTokenMiddleware,
  // No permission check - staff can always see their OWN entries
  timeEntryController.getMyTimeEntries,
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

// ============================================================================
// Order-Customer Relationship Routes (Multi-Customer Support)
// ============================================================================

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/customers:
 *   get:
 *     tags:
 *       - TPV - Orders
 *     summary: Get all customers for an order
 *     description: Returns list of customers associated with an order (multi-customer support)
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
 *     responses:
 *       200:
 *         description: List of order customers
 */
router.get(
  '/venues/:venueId/orders/:orderId/customers',
  authenticateTokenMiddleware,
  checkPermission('orders:read'),
  orderController.getOrderCustomers,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/customers:
 *   post:
 *     tags:
 *       - TPV - Orders
 *     summary: Add customer to order
 *     description: Add an existing customer to an order (multi-customer support). First customer becomes primary.
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
 *               - customerId
 *             properties:
 *               customerId:
 *                 type: string
 *                 format: cuid
 *     responses:
 *       201:
 *         description: Customer added to order successfully
 */
router.post(
  '/venues/:venueId/orders/:orderId/customers',
  authenticateTokenMiddleware,
  checkPermission('orders:update'),
  validateRequest(addOrderCustomerSchema),
  orderController.addCustomerToOrder,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/customers/create:
 *   post:
 *     tags:
 *       - TPV - Orders
 *     summary: Create customer and add to order
 *     description: Create a new customer with minimal info and immediately add to order
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
 *               firstName:
 *                 type: string
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       201:
 *         description: Customer created and added to order successfully
 */
router.post(
  '/venues/:venueId/orders/:orderId/customers/create',
  authenticateTokenMiddleware,
  checkPermission('orders:update'),
  validateRequest(createAndAddCustomerSchema),
  orderController.createAndAddCustomerToOrder,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/customers/{customerId}:
 *   delete:
 *     tags:
 *       - TPV - Orders
 *     summary: Remove customer from order
 *     description: Remove a customer from an order. If primary is removed, next oldest becomes primary.
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
 *         name: customerId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *     responses:
 *       200:
 *         description: Customer removed from order successfully
 */
router.delete(
  '/venues/:venueId/orders/:orderId/customers/:customerId',
  authenticateTokenMiddleware,
  checkPermission('orders:update'),
  validateRequest(removeOrderCustomerSchema),
  orderController.removeCustomerFromOrder,
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

// ==========================================
// CUSTOMER LOOKUP ROUTES (Phase 1: Customer System)
// ==========================================

/**
 * @openapi
 * /tpv/venues/{venueId}/customers/search:
 *   get:
 *     tags:
 *       - TPV - Customers
 *     summary: Search customers for checkout
 *     description: |
 *       Search customers by phone, email, or general query.
 *       Returns customers sorted by visit frequency.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *       - in: query
 *         name: phone
 *         schema:
 *           type: string
 *         description: Search by phone number (partial match)
 *       - in: query
 *         name: email
 *         schema:
 *           type: string
 *         description: Search by email address (partial match)
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: General search (name, email, phone)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Maximum results to return
 *     responses:
 *       200:
 *         description: Search results
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
 *                       firstName:
 *                         type: string
 *                       lastName:
 *                         type: string
 *                       email:
 *                         type: string
 *                       phone:
 *                         type: string
 *                       loyaltyPoints:
 *                         type: integer
 *                       totalVisits:
 *                         type: integer
 *                       totalSpent:
 *                         type: number
 *                       customerGroup:
 *                         type: object
 *                         nullable: true
 *                 count:
 *                   type: integer
 */
router.get(
  '/venues/:venueId/customers/search',
  authenticateTokenMiddleware,
  checkPermission('customers:read'),
  customerController.searchCustomers,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/customers/recent:
 *   get:
 *     tags:
 *       - TPV - Customers
 *     summary: Get recent customers for quick selection
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Recent customers list
 */
router.get(
  '/venues/:venueId/customers/recent',
  authenticateTokenMiddleware,
  checkPermission('customers:read'),
  customerController.getRecentCustomers,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/customers/{customerId}:
 *   get:
 *     tags:
 *       - TPV - Customers
 *     summary: Get customer by ID for checkout confirmation
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
 *         name: customerId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *     responses:
 *       200:
 *         description: Customer details
 *       404:
 *         description: Customer not found
 */
router.get(
  '/venues/:venueId/customers/:customerId',
  authenticateTokenMiddleware,
  checkPermission('customers:read'),
  customerController.getCustomer,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/customers:
 *   post:
 *     tags:
 *       - TPV - Customers
 *     summary: Quick create customer during checkout
 *     description: |
 *       Creates a new customer with minimal data.
 *       If customer with same phone/email exists, returns existing customer (no error).
 *     security:
 *       - bearerAuth: []
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
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       201:
 *         description: Customer created or existing customer returned
 *       400:
 *         description: At least phone or email is required
 */
router.post(
  '/venues/:venueId/customers',
  authenticateTokenMiddleware,
  checkPermission('customers:create'),
  customerController.quickCreateCustomer,
)

// ==========================================
// DISCOUNT SYSTEM ROUTES (Phase 2: Discount System)
// ==========================================

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/discounts:
 *   get:
 *     tags:
 *       - TPV - Discounts
 *     summary: Get all discounts applied to an order
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
 *     responses:
 *       200:
 *         description: List of applied discounts
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
 *                       name:
 *                         type: string
 *                       type:
 *                         type: string
 *                       amount:
 *                         type: number
 *                       isAutomatic:
 *                         type: boolean
 *                       isCoupon:
 *                         type: boolean
 *                       couponCode:
 *                         type: string
 *                 count:
 *                   type: integer
 *                 totalSavings:
 *                   type: number
 */
router.get(
  '/venues/:venueId/orders/:orderId/discounts',
  authenticateTokenMiddleware,
  checkPermission('orders:read'),
  validateRequest(getOrderDiscountsSchema),
  discountController.getOrderDiscounts,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/discounts/available:
 *   get:
 *     tags:
 *       - TPV - Discounts
 *     summary: Get available discounts for an order
 *     description: Returns discounts that can be applied to the order based on eligibility rules
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
 *       - in: query
 *         name: customerId
 *         schema:
 *           type: string
 *           format: cuid
 *         description: Customer ID for customer-specific discounts
 *     responses:
 *       200:
 *         description: List of available discounts with estimated savings
 */
router.get(
  '/venues/:venueId/orders/:orderId/discounts/available',
  authenticateTokenMiddleware,
  checkPermission('orders:read'),
  validateRequest(getAvailableDiscountsSchema),
  discountController.getAvailableDiscounts,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/discounts/auto:
 *   post:
 *     tags:
 *       - TPV - Discounts
 *     summary: Apply all eligible automatic discounts
 *     description: Automatically applies all eligible discounts based on order context and customer
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
 *     responses:
 *       200:
 *         description: Automatic discounts applied
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
 *                     applied:
 *                       type: integer
 *                     totalSavings:
 *                       type: number
 *                     discounts:
 *                       type: array
 */
router.post(
  '/venues/:venueId/orders/:orderId/discounts/auto',
  authenticateTokenMiddleware,
  checkPermission('orders:discount'),
  validateRequest(applyAutomaticDiscountsSchema),
  discountController.applyAutomaticDiscounts,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/discounts/apply:
 *   post:
 *     tags:
 *       - TPV - Discounts
 *     summary: Apply a predefined discount to an order
 *     description: Apply a discount from the venue's discount list
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
 *               - discountId
 *             properties:
 *               discountId:
 *                 type: string
 *                 format: cuid
 *               authorizedById:
 *                 type: string
 *                 format: cuid
 *                 description: Required for discounts that require approval
 *     responses:
 *       200:
 *         description: Discount applied successfully
 *       400:
 *         description: Discount cannot be applied
 */
router.post(
  '/venues/:venueId/orders/:orderId/discounts/apply',
  authenticateTokenMiddleware,
  checkPermission('orders:discount'),
  validateRequest(applyPredefinedDiscountSchema),
  discountController.applyPredefinedDiscount,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/discounts/manual:
 *   post:
 *     tags:
 *       - TPV - Discounts
 *     summary: Apply a manual (on-the-fly) discount
 *     description: Apply a custom discount not in the predefined list
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
 *               - reason
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [PERCENTAGE, FIXED_AMOUNT, COMP]
 *               value:
 *                 type: number
 *               reason:
 *                 type: string
 *               authorizedById:
 *                 type: string
 *                 format: cuid
 *                 description: Required for COMP discounts
 *     responses:
 *       200:
 *         description: Manual discount applied
 *       400:
 *         description: Invalid discount parameters
 */
router.post(
  '/venues/:venueId/orders/:orderId/discounts/manual',
  authenticateTokenMiddleware,
  checkPermission('orders:discount'),
  validateRequest(applyManualDiscountSchema),
  discountController.applyManualDiscount,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/discounts/coupon:
 *   post:
 *     tags:
 *       - TPV - Discounts
 *     summary: Apply a coupon code to an order
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
 *               - couponCode
 *             properties:
 *               couponCode:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 30
 *     responses:
 *       200:
 *         description: Coupon applied successfully
 *       400:
 *         description: Invalid or expired coupon
 */
router.post(
  '/venues/:venueId/orders/:orderId/discounts/coupon',
  authenticateTokenMiddleware,
  checkPermission('orders:discount'),
  validateRequest(applyCouponCodeSchema),
  discountController.applyCouponCode,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/coupons/validate:
 *   post:
 *     tags:
 *       - TPV - Discounts
 *     summary: Validate a coupon code without applying
 *     description: Check if a coupon is valid and preview the discount
 *     security:
 *       - bearerAuth: []
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
 *             required:
 *               - couponCode
 *               - orderTotal
 *             properties:
 *               couponCode:
 *                 type: string
 *               orderTotal:
 *                 type: number
 *               customerId:
 *                 type: string
 *                 format: cuid
 *     responses:
 *       200:
 *         description: Coupon validation result
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
 *                     valid:
 *                       type: boolean
 *                     message:
 *                       type: string
 *                     discountName:
 *                       type: string
 *                     estimatedSavings:
 *                       type: number
 */
router.post(
  '/venues/:venueId/coupons/validate',
  authenticateTokenMiddleware,
  checkPermission('orders:read'),
  validateRequest(validateCouponSchema),
  discountController.validateCoupon,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/orders/{orderId}/discounts/{discountId}:
 *   delete:
 *     tags:
 *       - TPV - Discounts
 *     summary: Remove a discount from an order
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
 *         name: discountId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: The OrderDiscount ID to remove
 *     responses:
 *       200:
 *         description: Discount removed successfully
 *       404:
 *         description: Discount not found on order
 */
router.delete(
  '/venues/:venueId/orders/:orderId/discounts/:discountId',
  authenticateTokenMiddleware,
  checkPermission('orders:discount'),
  validateRequest(removeOrderDiscountSchema),
  discountController.removeDiscount,
)

// ============================================================
// SALE VERIFICATION ROUTES (Step 4 - Post-payment verification)
// ============================================================

/**
 * @openapi
 * /tpv/venues/{venueId}/verificaciones:
 *   post:
 *     tags:
 *       - TPV - Sale Verification
 *     summary: Create a sale verification record
 *     description: Records photos and scanned barcodes for post-payment verification (Step 4)
 *     security:
 *       - bearerAuth: []
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
 *             required:
 *               - paymentId
 *               - staffId
 *             properties:
 *               paymentId:
 *                 type: string
 *                 format: cuid
 *               staffId:
 *                 type: string
 *                 format: cuid
 *               photos:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uri
 *               scannedProducts:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     barcode:
 *                       type: string
 *                     format:
 *                       type: string
 *                     productName:
 *                       type: string
 *                     productId:
 *                       type: string
 *                     hasInventory:
 *                       type: boolean
 *                     quantity:
 *                       type: number
 *               deviceId:
 *                 type: string
 *               notes:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [PENDING, PROCESSING, COMPLETED, FAILED, SKIPPED]
 *     responses:
 *       201:
 *         description: Verification created successfully
 *       400:
 *         description: Verification already exists or invalid data
 *       404:
 *         description: Payment or staff not found
 */
router.post(
  '/venues/:venueId/verificaciones',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  validateRequest(createSaleVerificationSchema),
  saleVerificationController.createSaleVerification,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/verificaciones:
 *   get:
 *     tags:
 *       - TPV - Sale Verification
 *     summary: List sale verifications
 *     description: Get a paginated list of sale verifications for a venue
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: pageNumber
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, PROCESSING, COMPLETED, FAILED, SKIPPED]
 *       - in: query
 *         name: staffId
 *         schema:
 *           type: string
 *           format: cuid
 *       - in: query
 *         name: fromDate
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: toDate
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: List of verifications with pagination
 */
router.get(
  '/venues/:venueId/verificaciones',
  authenticateTokenMiddleware,
  checkPermission('payments:read'),
  validateRequest(listSaleVerificationsSchema),
  saleVerificationController.listSaleVerifications,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/verificaciones/{verificationId}:
 *   get:
 *     tags:
 *       - TPV - Sale Verification
 *     summary: Get a sale verification by ID
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
 *         name: verificationId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *     responses:
 *       200:
 *         description: Verification details
 *       404:
 *         description: Verification not found
 */
router.get(
  '/venues/:venueId/verificaciones/:verificationId',
  authenticateTokenMiddleware,
  checkPermission('payments:read'),
  validateRequest(getSaleVerificationSchema),
  saleVerificationController.getSaleVerification,
)

/**
 * @openapi
 * /tpv/venues/{venueId}/payments/{paymentId}/verificacion:
 *   get:
 *     tags:
 *       - TPV - Sale Verification
 *     summary: Get verification by payment ID
 *     description: Get the verification associated with a specific payment
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
 *         name: paymentId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *     responses:
 *       200:
 *         description: Verification details
 *       404:
 *         description: No verification found for payment
 */
router.get(
  '/venues/:venueId/payments/:paymentId/verificacion',
  authenticateTokenMiddleware,
  checkPermission('payments:read'),
  saleVerificationController.getVerificationByPaymentId,
)

/**
 * @openapi
 * /tpv/verification/proof-of-sale:
 *   post:
 *     tags:
 *       - TPV - Sale Verification
 *     summary: Upload proof-of-sale photo
 *     description: |
 *       Simplified endpoint for uploading proof-of-sale photos after successful payment.
 *       Used when SERIALIZED_INVENTORY module is active.
 *
 *       - If verification exists: Appends photos to existing record
 *       - If no verification: Creates new verification with COMPLETED status
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - paymentId
 *               - photoUrls
 *             properties:
 *               paymentId:
 *                 type: string
 *                 format: cuid
 *                 description: Payment ID to attach proof-of-sale photo
 *               photoUrls:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uri
 *                 minItems: 1
 *                 description: Firebase Storage URLs of uploaded photos
 *     responses:
 *       200:
 *         description: Proof-of-sale uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 verificationId:
 *                   type: string
 *                   format: cuid
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid request data
 *       404:
 *         description: Payment or staff not found
 */
router.post(
  '/verification/proof-of-sale',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  validateRequest(createProofOfSaleSchema),
  saleVerificationController.createProofOfSale,
)

// ══════════════════════════════════════════════════════════════════════════════
// BARCODE QUICK ADD (Square POS "Scan & Go" Pattern)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @openapi
 * /tpv/venues/{venueId}/products/barcode/{barcode}:
 *   get:
 *     tags:
 *       - TPV - Products
 *     summary: Search product by barcode (Scan & Go)
 *     description: |
 *       Find a product by scanning its barcode. Used by Android TPV app for quick product lookup.
 *
 *       **Square POS Pattern:**
 *       - Scan barcode → Find product by SKU → Add to order
 *       - If not found → Show "Quick Add Product" dialog
 *
 *       **Flow:**
 *       1. User presses VOLUME+ button on PAX terminal
 *       2. Opens barcode scanner
 *       3. Scans product barcode
 *       4. Calls this endpoint
 *       5. If found → Add to order with quantity=1
 *       6. If not found (404) → Show creation dialog
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *           format: cuid
 *         description: Venue ID from terminal authentication
 *       - in: path
 *         name: barcode
 *         required: true
 *         schema:
 *           type: string
 *         description: Barcode string (EAN-13, UPC-A, Code-128, etc.)
 *         example: "AVO-PROD-ALO"
 *     responses:
 *       200:
 *         description: Product found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Product found for barcode AVO-PROD-ALO"
 *                 data:
 *                   type: object
 *                   description: Product details with inventory, modifiers, recipe
 *       404:
 *         description: Product not found (client should show Quick Add dialog)
 *       401:
 *         description: Unauthorized (terminal not authenticated)
 *       403:
 *         description: Forbidden (terminal lacks menu:read permission)
 */
router.get(
  '/venues/:venueId/products/barcode/:barcode',
  authenticateTokenMiddleware,
  checkPermission('menu:read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { venueId, barcode } = req.params

      logger.info(`🔍 [TPV Barcode] Searching product by barcode: ${barcode} for venueId: ${venueId}`, {
        correlationId: req.correlationId,
        venueId,
        barcode,
      })

      // Search product by SKU (Product.sku stores barcode)
      const product = await productService.getProductByBarcode(venueId, barcode)

      if (!product) {
        logger.warn(`⚠️ [TPV Barcode] Product not found for barcode: ${barcode}`, {
          correlationId: req.correlationId,
          venueId,
          barcode,
        })

        return next(new AppError(`Product with barcode ${barcode} not found in venue ${venueId}`, 404))
      }

      logger.info(`✅ [TPV Barcode] Product found: ${product.name} (${product.id})`, {
        correlationId: req.correlationId,
        productId: product.id,
        productName: product.name,
      })

      res.status(200).json({
        message: `Product found for barcode ${barcode}`,
        data: product,
        correlationId: req.correlationId,
      })
    } catch (error) {
      logger.error(`❌ [TPV Barcode] Error searching product by barcode`, {
        correlationId: req.correlationId,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      next(error)
    }
  },
)

/**
 * @openapi
 * /tpv/venues/{venueId}/products/quick-add:
 *   post:
 *     tags:
 *       - TPV - Products
 *     summary: Create product on-the-fly from barcode scan
 *     description: |
 *       Create a new product when barcode is not found during scanning.
 *       Allows cashier to add products to catalog in real-time without leaving MenuScreen.
 *
 *       **Square POS Pattern:**
 *       - Scan unknown barcode → 404 from search endpoint
 *       - Show "Quick Add Product" dialog
 *       - User enters name, price, category
 *       - Submit → Product created → Added to order
 *
 *       **Flow:**
 *       1. Scan barcode "7501234567890"
 *       2. GET /barcode/:barcode returns 404
 *       3. Show dialog with barcode pre-filled (readonly)
 *       4. User enters: name="iPhone 15", price=999.00
 *       5. POST to this endpoint
 *       6. Product created with sku=barcode
 *       7. Automatically add to current order
 *     security:
 *       - bearerAuth: []
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
 *             required:
 *               - barcode
 *               - name
 *               - price
 *               - categoryId
 *             properties:
 *               barcode:
 *                 type: string
 *                 description: Scanned barcode (will be saved as SKU)
 *                 example: "7501234567890"
 *               name:
 *                 type: string
 *                 description: Product name
 *                 example: "iPhone 15 Pro Max 256GB"
 *               price:
 *                 type: number
 *                 format: decimal
 *                 description: Product price
 *                 example: 999.00
 *               categoryId:
 *                 type: string
 *                 format: cuid
 *                 description: Category ID (required)
 *               trackInventory:
 *                 type: boolean
 *                 default: false
 *                 description: Whether to track inventory for this product
 *     responses:
 *       201:
 *         description: Product created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Product created successfully"
 *                 data:
 *                   type: object
 *                   description: Created product with inventory
 *       409:
 *         description: Product with this barcode already exists
 *       400:
 *         description: Invalid request (missing required fields)
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden (lacks menu:write permission)
 */
router.post(
  '/venues/:venueId/products/quick-add',
  authenticateTokenMiddleware,
  checkPermission('menu:write'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { venueId } = req.params
      const { barcode, name, price, categoryId, trackInventory } = req.body

      // Validate required fields
      if (!barcode || !name || price === undefined || !categoryId) {
        return next(new AppError('Missing required fields: barcode, name, price, and categoryId are required', 400))
      }

      logger.info(`📦 [TPV Quick Add] Creating product from barcode scan`, {
        correlationId: req.correlationId,
        venueId,
        barcode,
        name,
        price,
        categoryId,
      })

      // Check if product already exists with this barcode
      const existingProduct = await productService.getProductByBarcode(venueId, barcode)
      if (existingProduct) {
        logger.warn(`⚠️ [TPV Quick Add] Product already exists with barcode: ${barcode}`, {
          correlationId: req.correlationId,
          existingProductId: existingProduct.id,
        })

        return res.status(409).json({
          message: `Product already exists with barcode ${barcode}`,
          data: existingProduct,
          correlationId: req.correlationId,
        })
      }

      // Create product using Prisma directly
      const product = await prisma.product.create({
        data: {
          venueId,
          sku: barcode, // ✅ Store barcode as SKU
          name,
          price: new Decimal(price),
          categoryId, // ✅ Required field
          trackInventory: trackInventory || false,
          active: true,
          displayOrder: 0,
        },
        include: {
          category: true,
          inventory: true,
        },
      })

      logger.info(`✅ [TPV Quick Add] Product created successfully: ${product.name} (${product.id})`, {
        correlationId: req.correlationId,
        productId: product.id,
        barcode,
      })

      res.status(201).json({
        message: 'Product created successfully',
        data: product,
        correlationId: req.correlationId,
      })
    } catch (error) {
      logger.error(`❌ [TPV Quick Add] Error creating product`, {
        correlationId: req.correlationId,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      next(error)
    }
  },
)

/**
 * @openapi
 * /api/v1/tpv/feedback:
 *   post:
 *     tags:
 *       - TPV Feedback
 *     summary: Send feedback from TPV (bug report or feature suggestion)
 *     description: Sends an email to hola@avoqado.io with bug reports or feature suggestions from TPV terminals
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - feedbackType
 *               - message
 *               - venueSlug
 *               - appVersion
 *               - buildVersion
 *               - androidVersion
 *               - deviceModel
 *               - deviceManufacturer
 *             properties:
 *               feedbackType:
 *                 type: string
 *                 enum: [bug, feature]
 *               message:
 *                 type: string
 *                 minLength: 10
 *               venueSlug:
 *                 type: string
 *               appVersion:
 *                 type: string
 *               buildVersion:
 *                 type: string
 *               androidVersion:
 *                 type: string
 *               deviceModel:
 *                 type: string
 *               deviceManufacturer:
 *                 type: string
 *     responses:
 *       200:
 *         description: Feedback sent successfully
 *       400:
 *         description: Invalid request body
 *       500:
 *         description: Server error
 */
router.post('/feedback', validateRequest(tpvFeedbackSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { feedbackType, message, venueSlug, appVersion, buildVersion, androidVersion, deviceModel, deviceManufacturer } = req.body

    logger.info(`📧 [TPV Feedback] Saving and sending ${feedbackType} feedback from ${venueSlug}`, {
      correlationId: req.correlationId,
      venueSlug,
      feedbackType,
    })

    // Save feedback to database first
    const feedbackRecord = await prisma.tpvFeedback.create({
      data: {
        feedbackType: feedbackType.toUpperCase() as 'BUG' | 'FEATURE',
        message,
        venueSlug,
        appVersion,
        buildVersion,
        androidVersion,
        deviceModel,
        deviceManufacturer,
      },
    })

    logger.info(`💾 [TPV Feedback] Saved to database with ID: ${feedbackRecord.id}`, {
      correlationId: req.correlationId,
      feedbackId: feedbackRecord.id,
    })

    // Send email
    const emailSent = await emailService.sendTpvFeedbackEmail({
      feedbackType,
      message,
      venueSlug,
      appVersion,
      buildVersion,
      androidVersion,
      deviceModel,
      deviceManufacturer,
    })

    // Update email status
    if (emailSent) {
      await prisma.tpvFeedback.update({
        where: { id: feedbackRecord.id },
        data: {
          emailSent: true,
          emailSentAt: new Date(),
        },
      })

      logger.info(`✅ [TPV Feedback] Email sent successfully`, {
        correlationId: req.correlationId,
        feedbackId: feedbackRecord.id,
        venueSlug,
        feedbackType,
      })
    } else {
      logger.warn(`⚠️ [TPV Feedback] Failed to send email, but feedback saved to database`, {
        correlationId: req.correlationId,
        feedbackId: feedbackRecord.id,
        venueSlug,
        feedbackType,
      })
      // Don't throw error - feedback is saved even if email fails
    }

    return res.status(200).json({
      success: true,
      message: 'Feedback enviado correctamente',
      correlationId: req.correlationId,
      feedbackId: feedbackRecord.id,
    })
  } catch (error) {
    logger.error(`❌ [TPV Feedback] Error processing feedback`, {
      correlationId: req.correlationId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    next(error)
  }
})

// ==========================================
// MODULES - Get enabled modules for a venue
// ==========================================

/**
 * GET /tpv/v1/modules
 * Get all enabled modules for a venue.
 *
 * Authentication: Semi-public endpoint
 * - If user is logged in: Uses authContext.venueId
 * - If no session (pre-login): Uses X-Venue-Id header from activated device
 *
 * This allows the TPV to fetch module configuration at app startup (splash screen)
 * before user login, enabling features like Timeclock to have correct UI from the start.
 *
 * Security: Only returns UI configuration (labels, feature flags).
 * Actual operations (clock-in, sales) still require full authentication.
 */
router.get('/modules', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Try to get venueId from auth context first (logged in user)
    let venueId = (req as any).authContext?.venueId

    // If no auth context, try X-Venue-Id header (activated device, pre-login)
    if (!venueId) {
      venueId = req.headers['x-venue-id'] as string
    }

    if (!venueId) {
      logger.warn(`⚠️ [TPV MODULES] No venueId provided`, {
        correlationId: req.correlationId,
        hasAuthContext: !!(req as any).authContext,
        hasVenueIdHeader: !!req.headers['x-venue-id'],
      })
      return res.status(400).json({
        error: 'venueId required',
        message: 'Provide venueId via authentication or X-Venue-Id header',
      })
    }

    // Validate that the venue exists (basic security check)
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, status: true },
    })

    if (!venue) {
      logger.warn(`⚠️ [TPV MODULES] Venue not found`, {
        venueId,
        correlationId: req.correlationId,
      })
      return res.status(404).json({ error: 'Venue not found' })
    }

    logger.info(`📦 [TPV MODULES] Getting enabled modules`, {
      venueId,
      source: (req as any).authContext?.venueId ? 'authContext' : 'header',
      correlationId: req.correlationId,
    })

    const modules = await moduleService.getEnabledModules(venueId)

    logger.info(`✅ [TPV MODULES] Found ${modules.length} enabled modules`, {
      venueId,
      modules: modules.map(m => m.code),
      correlationId: req.correlationId,
    })

    return res.status(200).json({ modules })
  } catch (error) {
    logger.error(`❌ [TPV MODULES] Error getting modules`, {
      correlationId: req.correlationId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    next(error)
  }
})

// ==========================================
// SALES GOAL - Staff sales targets
// Returns the current staff's active sales goal with progress
// ==========================================

/**
 * GET /tpv/sales-goal
 * Get the current staff's sales goal with progress.
 *
 * Returns the active sales goal for the logged-in staff member,
 * or the venue-wide goal if no staff-specific goal exists.
 *
 * Response:
 * - If goal exists: { salesGoal: { goal, period, currentSales, staffId } }
 * - If no goal: { salesGoal: null }
 */
router.get('/sales-goal', authenticateTokenMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, userId: staffId } = (req as any).authContext

    logger.info(`🎯 [TPV SALES GOAL] Getting sales goal`, {
      venueId,
      staffId,
      correlationId: req.correlationId,
    })

    // First try to get staff-specific goal
    let salesGoal = await salesGoalService.getStaffSalesGoal(venueId, staffId)

    // If no staff-specific goal, try venue-wide goal
    if (!salesGoal) {
      salesGoal = await salesGoalService.getPrimarySalesGoal(venueId)
    }

    if (salesGoal) {
      logger.info(`✅ [TPV SALES GOAL] Found sales goal`, {
        venueId,
        staffId,
        goalId: salesGoal.id,
        period: salesGoal.period,
        goal: salesGoal.goal,
        currentSales: salesGoal.currentSales,
        correlationId: req.correlationId,
      })

      return res.status(200).json({
        salesGoal: {
          goal: salesGoal.goal.toString(),
          goalType: salesGoal.goalType || 'AMOUNT',
          period: salesGoal.period,
          currentSales: salesGoal.currentSales.toString(),
          staffId: salesGoal.staffId,
        },
      })
    }

    logger.info(`ℹ️ [TPV SALES GOAL] No sales goal configured`, {
      venueId,
      staffId,
      correlationId: req.correlationId,
    })

    return res.status(200).json({ salesGoal: null })
  } catch (error) {
    logger.error(`❌ [TPV SALES GOAL] Error getting sales goal`, {
      correlationId: req.correlationId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    next(error)
  }
})

// ==========================================
// SALES GOALS (PLURAL) - All effective goals with inheritance
// Returns all resolved goals (venue > organization hierarchy)
// ==========================================

/**
 * GET /tpv/sales-goals
 * Get all effective sales goals for the current venue, resolved via hierarchy:
 * 1. If venue has its own goals → use those (source: 'venue')
 * 2. If no venue goals → fall back to organization goals (source: 'organization')
 *
 * Filters to only return goals relevant to the logged-in staff member
 * (staff-specific goals + venue-wide goals where staffId is null).
 *
 * Response: { salesGoals: [...] }
 */
router.get('/sales-goals', authenticateTokenMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, userId: staffId } = (req as any).authContext

    logger.info(`🎯 [TPV SALES GOALS] Getting all effective goals`, {
      venueId,
      staffId,
      correlationId: req.correlationId,
    })

    const allGoals = await goalResolutionService.getEffectiveGoals(venueId)

    // Filter: only goals for this staff + venue-wide goals (staffId === null)
    const relevantGoals = allGoals.filter(g => g.staffId === null || g.staffId === staffId)

    logger.info(`✅ [TPV SALES GOALS] Found ${relevantGoals.length} goals (from ${allGoals.length} total)`, {
      venueId,
      staffId,
      sources: relevantGoals.map(g => g.source),
      correlationId: req.correlationId,
    })

    return res.status(200).json({
      salesGoals: relevantGoals.map(g => ({
        goal: g.goal.toString(),
        goalType: g.goalType || 'AMOUNT',
        period: g.period,
        currentSales: g.currentSales.toString(),
        staffId: g.staffId,
        source: g.source, // 'venue' | 'organization'
      })),
    })
  } catch (error) {
    logger.error(`❌ [TPV SALES GOALS] Error getting sales goals`, {
      correlationId: req.correlationId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    next(error)
  }
})

// ==========================================
// SERIALIZED INVENTORY - Barcode-scanned items
// For SIMs, jewelry, electronics, etc.
// ==========================================

/**
 * GET /tpv/v1/serialized-inventory/categories
 * Get all item categories with stock counts.
 */
router.get('/serialized-inventory/categories', authenticateTokenMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = (req as any).authContext

    logger.info(`📦 [SERIALIZED INV] Getting categories`, {
      venueId,
      correlationId: req.correlationId,
    })

    const categoriesWithStock = await serializedInventoryService.getStockByCategory(venueId)

    // Transform to format expected by TPV Android
    const data = categoriesWithStock.map(item => ({
      id: item.category.id,
      name: item.category.name,
      description: item.category.description,
      suggestedPrice: item.category.suggestedPrice?.toString() ?? null,
      availableCount: item.available,
    }))

    logger.info(`📦 [SERIALIZED INV] Found ${data.length} categories`, {
      venueId,
      correlationId: req.correlationId,
    })

    return res.status(200).json({ success: true, data })
  } catch (error) {
    logger.error(`❌ [SERIALIZED INV] Error getting categories`, {
      correlationId: req.correlationId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    next(error)
  }
})

/**
 * POST /tpv/serialized-inventory/categories
 * Create a new category from TPV.
 */
router.post('/serialized-inventory/categories', authenticateTokenMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = (req as any).authContext
    const { name, description, suggestedPrice } = req.body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new AppError('name is required', 400)
    }

    logger.info(`📦 [SERIALIZED INV] Creating category`, {
      venueId,
      name,
      correlationId: req.correlationId,
    })

    const category = await serializedInventoryService.createCategory({
      venueId,
      name: name.trim(),
      description: description?.trim(),
      suggestedPrice: suggestedPrice ? parseFloat(suggestedPrice) : undefined,
    })

    logger.info(`✅ [SERIALIZED INV] Category created`, {
      venueId,
      categoryId: category.id,
      name: category.name,
      correlationId: req.correlationId,
    })

    return res.status(201).json({
      success: true,
      data: {
        id: category.id,
        name: category.name,
        description: category.description,
        suggestedPrice: category.suggestedPrice?.toString() ?? null,
      },
    })
  } catch (error) {
    logger.error(`❌ [SERIALIZED INV] Error creating category`, {
      correlationId: req.correlationId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    next(error)
  }
})

/**
 * POST /tpv/v1/serialized-inventory/scan
 * Scan a barcode and get item status.
 */
router.post('/serialized-inventory/scan', authenticateTokenMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = (req as any).authContext
    const { serialNumber } = req.body

    if (!serialNumber || typeof serialNumber !== 'string') {
      throw new AppError('serialNumber is required', 400)
    }

    logger.info(`🔍 [SERIALIZED INV] Scanning barcode`, {
      venueId,
      serialNumber,
      correlationId: req.correlationId,
    })

    const result = await serializedInventoryService.scan(venueId, serialNumber)

    logger.info(`✅ [SERIALIZED INV] Scan result: ${result.status}`, {
      venueId,
      serialNumber,
      found: result.found,
      status: result.status,
      correlationId: req.correlationId,
    })

    return res.status(200).json(result)
  } catch (error) {
    logger.error(`❌ [SERIALIZED INV] Error scanning`, {
      correlationId: req.correlationId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    next(error)
  }
})

/**
 * POST /tpv/v1/serialized-inventory/register-batch
 * Register multiple items in batch (bulk registration by manager).
 * Requires serialized-inventory:create permission.
 */
router.post(
  '/serialized-inventory/register-batch',
  authenticateTokenMiddleware,
  checkPermission('serialized-inventory:create'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // userId from authContext IS the staffId (authenticated staff member)
      const { venueId, userId: staffId } = (req as any).authContext
      const { categoryId, serialNumbers } = req.body

      if (!categoryId || typeof categoryId !== 'string') {
        throw new AppError('categoryId is required', 400)
      }

      if (!Array.isArray(serialNumbers) || serialNumbers.length === 0) {
        throw new AppError('serialNumbers array is required and cannot be empty', 400)
      }

      logger.info(`📦 [SERIALIZED INV] Batch registration`, {
        venueId,
        staffId,
        categoryId,
        count: serialNumbers.length,
        correlationId: req.correlationId,
      })

      const result = await serializedInventoryService.registerBatch({
        venueId,
        categoryId,
        serialNumbers,
        createdBy: staffId,
      })

      logger.info(`✅ [SERIALIZED INV] Batch complete: ${result.created} created, ${result.duplicates.length} duplicates`, {
        venueId,
        created: result.created,
        duplicatesCount: result.duplicates.length,
        correlationId: req.correlationId,
      })

      return res.status(200).json({ success: true, data: result })
    } catch (error) {
      logger.error(`❌ [SERIALIZED INV] Error in batch registration`, {
        correlationId: req.correlationId,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      next(error)
    }
  },
)

/**
 * POST /tpv/v1/serialized-inventory/sell
 * Quick sell a serialized item (creates order + item in one shot).
 * Requires serialized-inventory:sell permission.
 */
router.post(
  '/serialized-inventory/sell',
  authenticateTokenMiddleware,
  checkPermission('serialized-inventory:sell'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // userId from authContext IS the staffId (authenticated staff member)
      const { venueId, userId: staffId } = (req as any).authContext
      const { serialNumber, categoryId, price, paymentMethodId, notes, terminalId, isPortabilidad } = req.body

      if (!serialNumber || typeof serialNumber !== 'string') {
        throw new AppError('serialNumber is required', 400)
      }

      if (typeof price !== 'number' || price < 0) {
        throw new AppError('price must be a non-negative number', 400)
      }

      logger.info(`💵 [SERIALIZED INV] Quick sell`, {
        venueId,
        staffId,
        serialNumber,
        price,
        correlationId: req.correlationId,
      })

      const result = await orderTpvService.sellSerializedItem(
        venueId,
        { serialNumber, categoryId, price, paymentMethodId, notes, terminalId, isPortabilidad },
        staffId,
      )

      logger.info(`✅ [SERIALIZED INV] Order created: ${result.orderNumber}`, {
        venueId,
        orderId: result.id,
        orderNumber: result.orderNumber,
        correlationId: req.correlationId,
      })

      return res.status(201).json(result)
    } catch (error) {
      logger.error(`❌ [SERIALIZED INV] Error in quick sell`, {
        correlationId: req.correlationId,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      next(error)
    }
  },
)

/**
 * POST /tpv/v1/orders/:orderId/serialized-item
 * Add a serialized item to an existing order (mixed cart support).
 * Requires orders:update permission.
 */
router.post(
  '/orders/:orderId/serialized-item',
  authenticateTokenMiddleware,
  checkPermission('orders:update'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // userId from authContext IS the staffId (authenticated staff member)
      const { venueId, userId: staffId } = (req as any).authContext
      const { orderId } = req.params
      const { serialNumber, categoryId, price, notes, expectedVersion } = req.body

      if (!serialNumber || typeof serialNumber !== 'string') {
        throw new AppError('serialNumber is required', 400)
      }

      if (typeof price !== 'number' || price < 0) {
        throw new AppError('price must be a non-negative number', 400)
      }

      if (typeof expectedVersion !== 'number') {
        throw new AppError('expectedVersion is required', 400)
      }

      logger.info(`📦 [SERIALIZED INV] Adding to order`, {
        venueId,
        staffId,
        orderId,
        serialNumber,
        price,
        correlationId: req.correlationId,
      })

      const result = await orderTpvService.addSerializedItemToOrder(
        venueId,
        orderId,
        { serialNumber, categoryId, price, notes },
        expectedVersion,
        staffId,
      )

      logger.info(`✅ [SERIALIZED INV] Added to order: ${result.orderNumber}`, {
        venueId,
        orderId: result.id,
        orderNumber: result.orderNumber,
        newTotal: result.total,
        correlationId: req.correlationId,
      })

      return res.status(200).json(result)
    } catch (error) {
      logger.error(`❌ [SERIALIZED INV] Error adding to order`, {
        correlationId: req.correlationId,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      next(error)
    }
  },
)

// ==============================================
// GEOLOCATION (Cell ID + WiFi to Coordinates)
// ==============================================

/**
 * POST /tpv/v1/geolocation/cell-towers
 * Convert cell tower + WiFi info to GPS coordinates using Google Geolocation API.
 * Used by PAX devices for indoor location (no GPS satellite visibility).
 *
 * Accuracy:
 * - Cell towers only: ~100-1000m
 * - Cell + WiFi: ~20-50m (MUCH BETTER!)
 *
 * @requires GOOGLE_GEOLOCATION_API_KEY env variable
 */
router.post('/geolocation/cell-towers', authenticateTokenMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cellTowers, wifiAccessPoints } = req.body

    // Validate: need at least one of cell towers or WiFi APs
    const hasCellTowers = Array.isArray(cellTowers) && cellTowers.length > 0
    const hasWifiAPs = Array.isArray(wifiAccessPoints) && wifiAccessPoints.length > 0

    if (!hasCellTowers && !hasWifiAPs) {
      logger.error(`❌ [GEOLOCATION] Empty request - no cell towers or WiFi APs`, {
        correlationId: req.correlationId,
        rawBody: JSON.stringify(req.body),
        cellTowersType: typeof cellTowers,
        cellTowersIsArray: Array.isArray(cellTowers),
        cellTowersLength: cellTowers?.length,
        wifiAPsType: typeof wifiAccessPoints,
        wifiAPsIsArray: Array.isArray(wifiAccessPoints),
        wifiAPsLength: wifiAccessPoints?.length,
        userAgent: req.headers['user-agent'],
        appVersion: req.headers['x-app-version-code'],
      })
      throw new AppError('cellTowers or wifiAccessPoints array is required', 400)
    }

    logger.info(`📍 [GEOLOCATION] Network location request`, {
      cellTowersCount: cellTowers?.length || 0,
      wifiAPsCount: wifiAccessPoints?.length || 0,
      firstTower: cellTowers?.[0],
      allTowers: cellTowers?.map(
        (t: CellTowerInput) =>
          `${t.radioType} MCC=${t.mobileCountryCode} MNC=${t.mobileNetworkCode} LAC=${t.locationAreaCode} CID=${t.cellId}`,
      ),
      wifiAPs: wifiAccessPoints?.map((w: WifiInput) => `${w.macAddress} signal=${w.signalStrength} ch=${w.channel}`),
      correlationId: req.correlationId,
    })

    // Call geolocation providers (smart routing: WiFi → Google first, no WiFi → Unwired Labs first)
    const result = await getNetworkLocation(cellTowers || [], wifiAccessPoints || [])

    if (!result) {
      logger.warn(`📍 [GEOLOCATION] All providers failed — no location determined`, {
        cellTowersCount: cellTowers?.length || 0,
        wifiAPsCount: wifiAccessPoints?.length || 0,
        correlationId: req.correlationId,
      })
      throw new AppError('Could not determine location from network data', 404)
    }

    logger.info(`📍 [GEOLOCATION] ✅ Location determined via ${result.provider}`, {
      latitude: result.latitude,
      longitude: result.longitude,
      accuracy: `${result.accuracy}m`,
      provider: result.provider,
      correlationId: req.correlationId,
    })

    return res.status(200).json(result)
  } catch (error) {
    logger.error(`❌ [GEOLOCATION] Error in network location lookup`, {
      correlationId: req.correlationId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    next(error)
  }
})

/**
 * Maximum acceptable accuracy in meters.
 * Locations with accuracy worse than this are rejected as unreliable.
 * - GPS: 5-20m, Cell + WiFi: 20-50m, Cell only: 100-1000m
 * - IP-based fallback: 2,000,000+ meters (GARBAGE — must reject!)
 */
const MAX_ACCURACY_METERS = 1000

type CellTowerInput = {
  radioType: string
  mobileCountryCode: number
  mobileNetworkCode: number
  locationAreaCode: number
  cellId: number
  signalStrength?: number // dBm — helps triangulation accuracy
}

type WifiInput = {
  macAddress: string
  signalStrength: number
  channel: number
}

type GeoResult = { latitude: number; longitude: number; accuracy: number; provider: string }

/**
 * Smart provider routing based on WiFi availability:
 * - WITH WiFi  → Google first (best WiFi DB) → Unwired Labs
 * - WITHOUT WiFi → Unwired Labs first (204M cell towers) → Google
 *
 * Returns the first successful result with accuracy <= 1000m.
 */
async function getNetworkLocation(cellTowers: CellTowerInput[], wifiAccessPoints: WifiInput[]): Promise<GeoResult | null> {
  const hasWifi = wifiAccessPoints.length > 0

  if (hasWifi) {
    // WiFi available → Google has the best WiFi database (billions of Android phones)
    logger.info(`📍 [GEOLOCATION] WiFi detected (${wifiAccessPoints.length} APs) → trying Google first`)
    const googleResult = await getLocationFromGoogle(cellTowers, wifiAccessPoints)
    if (googleResult) return googleResult

    // Fallback to Unwired Labs
    const unwiredResult = await getLocationFromUnwiredLabs(cellTowers, wifiAccessPoints)
    if (unwiredResult) return unwiredResult
  } else {
    // No WiFi → Unwired Labs first (204M cell towers, best cell-only coverage)
    logger.info(`📍 [GEOLOCATION] No WiFi → trying Unwired Labs first`)
    const unwiredResult = await getLocationFromUnwiredLabs(cellTowers, wifiAccessPoints)
    if (unwiredResult) return unwiredResult

    // Fallback to Google (with considerIp: false)
    const googleResult = await getLocationFromGoogle(cellTowers, wifiAccessPoints)
    if (googleResult) return googleResult
  }

  logger.warn('📍 [GEOLOCATION] All providers failed to determine location')
  return null
}

/**
 * Unwired Labs LocationAPI — cell tower geolocation provider.
 * 204M cell towers globally (5x more than OpenCellID).
 * No IP fallback by default — returns error instead of garbage data.
 * https://unwiredlabs.com/
 */
async function getLocationFromUnwiredLabs(cellTowers: CellTowerInput[], wifiAccessPoints: WifiInput[]): Promise<GeoResult | null> {
  const token = process.env.UNWIRED_LABS_API_TOKEN

  if (!token) {
    logger.warn('📍 [GEOLOCATION] UNWIRED_LABS_API_TOKEN not configured, skipping Unwired Labs')
    return null
  }

  try {
    // Determine radio type from first cell tower
    const radioType = cellTowers[0]?.radioType || 'lte'

    const requestBody: Record<string, unknown> = {
      token,
      radio: radioType,
      mcc: cellTowers[0]?.mobileCountryCode,
      mnc: cellTowers[0]?.mobileNetworkCode,
      // ipf: 0 = no IP fallback, lacf: 1 = allow LAC-level fallback (area-level, ~few km)
      fallbacks: { ipf: 0, lacf: 1 },
    }

    // Add cell towers
    if (cellTowers.length > 0) {
      requestBody.cells = cellTowers.map(tower => ({
        lac: tower.locationAreaCode,
        cid: tower.cellId,
        radio: tower.radioType,
        ...(tower.signalStrength != null && { signal: tower.signalStrength }),
      }))
    }

    // Add WiFi access points
    if (wifiAccessPoints.length > 0) {
      requestBody.wifi = wifiAccessPoints.map(wifi => ({
        bssid: wifi.macAddress,
        signal: wifi.signalStrength,
        channel: wifi.channel,
      }))
    }

    const response = await fetch('https://us1.unwiredlabs.com/v2/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })

    const data = (await response.json()) as {
      status: string
      lat?: number
      lon?: number
      accuracy?: number
      balance?: number
      fallback?: string
    }

    if (data.status !== 'ok' || data.lat == null || data.lon == null) {
      logger.warn(`📍 [GEOLOCATION] Unwired Labs: no result`, { status: data.status, balance: data.balance })
      return null
    }

    const accuracy = data.accuracy || 9999

    // Reject locations with poor accuracy
    if (accuracy > MAX_ACCURACY_METERS) {
      logger.warn(`📍 [GEOLOCATION] Unwired Labs: rejected poor accuracy ${accuracy}m`, {
        lat: data.lat,
        lon: data.lon,
        accuracy,
        fallback: data.fallback,
      })
      return null
    }

    logger.info(`📍 [GEOLOCATION] Unwired Labs: success`, {
      lat: data.lat,
      lon: data.lon,
      accuracy: `${accuracy}m`,
      fallback: data.fallback || 'none',
      balance: data.balance,
    })

    return { latitude: data.lat, longitude: data.lon, accuracy, provider: 'unwired-labs' }
  } catch (error) {
    logger.error(`📍 [GEOLOCATION] Unwired Labs: failed`, {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return null
  }
}

/**
 * Google Geolocation API — fallback provider.
 * considerIp: false prevents using the SERVER's IP (Oregon) as location fallback.
 * https://developers.google.com/maps/documentation/geolocation/overview
 */
async function getLocationFromGoogle(cellTowers: CellTowerInput[], wifiAccessPoints: WifiInput[]): Promise<GeoResult | null> {
  const apiKey = process.env.GOOGLE_GEOLOCATION_API_KEY

  if (!apiKey) {
    logger.warn('📍 [GEOLOCATION] GOOGLE_GEOLOCATION_API_KEY not configured, skipping Google')
    return null
  }

  try {
    const requestBody: Record<string, unknown> = {
      considerIp: false,
    }

    if (cellTowers.length > 0) {
      requestBody.cellTowers = cellTowers.map(tower => ({
        cellId: tower.cellId,
        locationAreaCode: tower.locationAreaCode,
        mobileCountryCode: tower.mobileCountryCode,
        mobileNetworkCode: tower.mobileNetworkCode,
        radioType: tower.radioType,
        ...(tower.signalStrength != null && { signalStrength: tower.signalStrength }),
      }))
    }

    if (wifiAccessPoints.length > 0) {
      requestBody.wifiAccessPoints = wifiAccessPoints.map(wifi => ({
        macAddress: wifi.macAddress,
        signalStrength: wifi.signalStrength,
        channel: wifi.channel,
      }))
    }

    const response = await fetch(`https://www.googleapis.com/geolocation/v1/geolocate?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorBody = await response.text()
      logger.warn(`📍 [GEOLOCATION] Google: API error ${response.status}`, { errorBody })
      return null
    }

    const data = (await response.json()) as {
      location: { lat: number; lng: number }
      accuracy: number
    }

    if (data.accuracy > MAX_ACCURACY_METERS) {
      logger.warn(`📍 [GEOLOCATION] Google: rejected poor accuracy ${data.accuracy}m`, {
        lat: data.location.lat,
        lng: data.location.lng,
        accuracy: data.accuracy,
      })
      return null
    }

    logger.info(`📍 [GEOLOCATION] Google: success`, {
      lat: data.location.lat,
      lng: data.location.lng,
      accuracy: `${data.accuracy}m`,
    })

    return {
      latitude: data.location.lat,
      longitude: data.location.lng,
      accuracy: data.accuracy,
      provider: 'google',
    }
  } catch (error) {
    logger.error(`📍 [GEOLOCATION] Google: failed`, {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return null
  }
}

// ==========================================
// TPV MESSAGES - Pending messages & acknowledgment
// ==========================================

/**
 * @openapi
 * /api/v1/tpv/messages/history:
 *   get:
 *     tags: [TPV Messages]
 *     summary: Get message history for this terminal
 *     description: Returns all messages delivered to this terminal with delivery status. Used for inbox UI.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200: { description: Paginated message history with delivery statuses }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get('/messages/history', authenticateTokenMiddleware, tpvMessageController.getMessageHistory)

/**
 * @openapi
 * /api/v1/tpv/messages/pending:
 *   get:
 *     tags: [TPV Messages]
 *     summary: Get pending messages for this terminal
 *     description: Returns undelivered/unacknowledged messages. Used for offline recovery.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of pending messages }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get('/messages/pending', authenticateTokenMiddleware, tpvMessageController.getPendingMessages)

/**
 * @openapi
 * /api/v1/tpv/messages/{messageId}/acknowledge:
 *   post:
 *     tags: [TPV Messages]
 *     summary: Acknowledge a message
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               staffId: { type: string }
 *     responses:
 *       200: { description: Message acknowledged }
 *       404: { description: Delivery not found }
 */
router.post('/messages/:messageId/acknowledge', authenticateTokenMiddleware, tpvMessageController.acknowledgeMessage)

/**
 * @openapi
 * /api/v1/tpv/messages/{messageId}/dismiss:
 *   post:
 *     tags: [TPV Messages]
 *     summary: Dismiss a message
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Message dismissed }
 *       404: { description: Delivery not found }
 */
router.post('/messages/:messageId/dismiss', authenticateTokenMiddleware, tpvMessageController.dismissMessage)

/**
 * @openapi
 * /api/v1/tpv/messages/{messageId}/respond:
 *   post:
 *     tags: [TPV Messages]
 *     summary: Submit a survey response
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [selectedOptions]
 *             properties:
 *               selectedOptions: { type: array, items: { type: string } }
 *               staffId: { type: string }
 *               staffName: { type: string }
 *     responses:
 *       200: { description: Survey response submitted }
 *       404: { description: Message not found }
 */
router.post('/messages/:messageId/respond', authenticateTokenMiddleware, tpvMessageController.respondToMessage)

// ==========================================
// TPV TRAINING / LMS - Training modules & progress
// ==========================================

/**
 * @openapi
 * /api/v1/tpv/trainings:
 *   get:
 *     tags: [TPV Training]
 *     summary: List available trainings (auto-filtered by org modules)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of available training modules }
 *       401: { $ref: '#/components/responses/UnauthorizedError' }
 */
router.get('/trainings', authenticateTokenMiddleware, trainingController.getTrainings)

/**
 * @openapi
 * /api/v1/tpv/trainings/progress:
 *   get:
 *     tags: [TPV Training]
 *     summary: Get all progress for current staff member
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: staffId
 *         schema: { type: string }
 *     responses:
 *       200: { description: Staff training progress }
 */
router.get(
  '/trainings/progress',
  authenticateTokenMiddleware,
  validateRequest(getStaffProgressQuerySchema),
  trainingController.getStaffProgress,
)

/**
 * @openapi
 * /api/v1/tpv/trainings/{trainingId}:
 *   get:
 *     tags: [TPV Training]
 *     summary: Get training detail with steps and quiz
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: trainingId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Training detail with steps and quiz }
 *       404: { description: Training not found }
 */
router.get(
  '/trainings/:trainingId',
  authenticateTokenMiddleware,
  validateRequest(trainingIdParamSchema),
  trainingController.getTrainingDetail,
)

/**
 * @openapi
 * /api/v1/tpv/trainings/{trainingId}/progress:
 *   post:
 *     tags: [TPV Training]
 *     summary: Update training progress for staff member
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: trainingId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               staffId: { type: string }
 *               lastStepViewed: { type: integer }
 *               isCompleted: { type: boolean }
 *               quizScore: { type: integer }
 *               quizTotal: { type: integer }
 *               quizPassed: { type: boolean }
 *     responses:
 *       200: { description: Progress updated }
 *       404: { description: Training not found }
 */
router.post(
  '/trainings/:trainingId/progress',
  authenticateTokenMiddleware,
  validateRequest(updateProgressSchema),
  trainingController.updateProgress,
)

export default router
