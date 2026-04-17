/**
 * Mobile Routes
 *
 * API endpoints for mobile apps (iOS, Android).
 * Base path: /api/v1/mobile
 */

import { Router } from 'express'
import * as authMobileController from '../controllers/mobile/auth.mobile.controller'
import * as orderMobileController from '../controllers/mobile/order.mobile.controller'
import * as timeEntryMobileController from '../controllers/mobile/time-entry.mobile.controller'
import * as pushMobileController from '../controllers/mobile/push.mobile.controller'
import * as transactionMobileController from '../controllers/mobile/transaction.mobile.controller'
import * as paymentMobileController from '../controllers/mobile/payment.mobile.controller'
import * as terminalPaymentMobileController from '../controllers/mobile/terminal-payment.mobile.controller'
import * as inventoryMobileController from '../controllers/mobile/inventory.mobile.controller'
import * as receiptMobileController from '../controllers/mobile/receipt.mobile.controller'
import * as reportsMobileController from '../controllers/mobile/reports.mobile.controller'
import * as customerController from '../controllers/dashboard/customer.dashboard.controller'
import * as customerGroupController from '../controllers/dashboard/customerGroup.dashboard.controller'
import * as productMobileController from '../controllers/mobile/product.mobile.controller'
import * as categoryMobileController from '../controllers/mobile/category.mobile.controller'
import * as discountMobileController from '../controllers/mobile/discount.mobile.controller'
import * as couponMobileController from '../controllers/mobile/coupon.mobile.controller'
import * as tpvSettingsMobileController from '../controllers/mobile/tpvSettings.mobile.controller'
import * as notificationMobileController from '../controllers/mobile/notification.mobile.controller'
import * as supplierMobileController from '../controllers/mobile/supplier.mobile.controller'
import * as cashDrawerMobileController from '../controllers/mobile/cash-drawer.mobile.controller'
import * as purchaseOrderMobileController from '../controllers/mobile/purchase-order.mobile.controller'
import * as transferMobileController from '../controllers/mobile/transfer.mobile.controller'
import * as refundMobileController from '../controllers/mobile/refund.mobile.controller'
import * as estimateMobileController from '../controllers/mobile/estimate.mobile.controller'
import * as productOptionMobileController from '../controllers/mobile/product-option.mobile.controller'
import * as measurementUnitMobileController from '../controllers/mobile/measurement-unit.mobile.controller'
import * as kdsMobileController from '../controllers/mobile/kds.mobile.controller'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware'
import { checkPermission } from '../middlewares/checkPermission.middleware'
import { validateRequest } from '../middlewares/validation'
import { recordFastPaymentParamsSchema, recordPaymentBodySchema } from '../schemas/tpv.schema'

const router = Router()

// ============================================================================
// EMAIL/PASSWORD AUTHENTICATION
// Public endpoints - no authentication required
// ============================================================================

/**
 * @openapi
 * /api/v1/mobile/auth/login:
 *   post:
 *     tags: [Mobile - Authentication]
 *     summary: Login with email and password
 *     description: |
 *       Authenticate with email and password.
 *       Returns JWT tokens in the response body (mobile apps can't read httpOnly cookies).
 *
 *       **Store tokens securely:**
 *       - iOS: Store in Keychain
 *       - Android: Store in EncryptedSharedPreferences
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User email address
 *                 example: user@example.com
 *               password:
 *                 type: string
 *                 description: User password
 *               rememberMe:
 *                 type: boolean
 *                 default: false
 *                 description: Extend token expiration (30 days vs 24 hours)
 *     responses:
 *       200:
 *         description: Login successful
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
 *                   example: Login exitoso
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     email:
 *                       type: string
 *                     firstName:
 *                       type: string
 *                     lastName:
 *                       type: string
 *                     venues:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           name:
 *                             type: string
 *                           slug:
 *                             type: string
 *                           role:
 *                             type: string
 *                 accessToken:
 *                   type: string
 *                   description: JWT access token (store in Keychain)
 *                 refreshToken:
 *                   type: string
 *                   description: JWT refresh token (store in Keychain)
 *       400:
 *         description: Missing email or password
 *       401:
 *         description: Invalid credentials
 *       403:
 *         description: Account locked, email not verified, or no venue access
 */
router.post('/auth/login', authMobileController.login)

/**
 * @openapi
 * /api/v1/mobile/auth/refresh:
 *   post:
 *     tags: [Mobile - Authentication]
 *     summary: Refresh access token
 *     description: |
 *       Get a new access token using a refresh token.
 *       Send the refresh token in the request body.
 *
 *       **When to use:**
 *       - When access token expires (401 response)
 *       - Proactively before expiration
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
 *                 description: The refresh token stored from login
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 accessToken:
 *                   type: string
 *                   description: New JWT access token
 *                 refreshToken:
 *                   type: string
 *                   description: New JWT refresh token (rotate tokens for security)
 *       400:
 *         description: Missing refresh token
 *       401:
 *         description: Invalid or expired refresh token
 */
router.post('/auth/refresh', authMobileController.refresh)

// ============================================================================
// PASSKEY (WebAuthn) AUTHENTICATION
// Public endpoints - no authentication required
// ============================================================================

/**
 * @openapi
 * /api/v1/mobile/auth/passkey/challenge:
 *   post:
 *     tags: [Mobile - Authentication]
 *     summary: Generate passkey authentication challenge
 *     description: |
 *       First step in passkey sign-in flow.
 *       Returns a challenge that must be signed by the user's passkey (Face ID, Touch ID, etc).
 *
 *       **Flow:**
 *       1. Mobile app calls this endpoint to get a challenge
 *       2. App presents the passkey authentication UI to the user
 *       3. User authenticates with biometrics
 *       4. App sends the signed assertion to /passkey/verify
 *     responses:
 *       200:
 *         description: Challenge generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 challenge:
 *                   type: string
 *                   description: Base64URL encoded challenge to be signed
 *                 challengeKey:
 *                   type: string
 *                   description: Key to identify this challenge during verification (send back with /verify)
 *                 rpId:
 *                   type: string
 *                   description: Relying Party ID
 *                   example: avoqado.io
 *                 timeout:
 *                   type: number
 *                   description: Challenge validity in milliseconds
 *                   example: 300000
 *                 userVerification:
 *                   type: string
 *                   description: User verification requirement
 *                   example: preferred
 *       500:
 *         description: Server error
 */
router.post('/auth/passkey/challenge', authMobileController.passkeyChallenge)

/**
 * @openapi
 * /api/v1/mobile/auth/passkey/verify:
 *   post:
 *     tags: [Mobile - Authentication]
 *     summary: Verify passkey assertion and authenticate
 *     description: |
 *       Second step in passkey sign-in flow.
 *       Verifies the signed assertion from the authenticator and returns auth tokens.
 *
 *       **iOS Implementation:**
 *       Use ASAuthorizationController with ASAuthorizationPlatformPublicKeyCredentialProvider
 *       to get the credential assertion, then send it to this endpoint.
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
 *                 type: object
 *                 description: WebAuthn credential assertion from the authenticator
 *                 required:
 *                   - id
 *                   - response
 *                 properties:
 *                   id:
 *                     type: string
 *                     description: Base64URL encoded credential ID
 *                   rawId:
 *                     type: string
 *                     description: Base64URL encoded raw credential ID (same as id)
 *                   type:
 *                     type: string
 *                     default: public-key
 *                   response:
 *                     type: object
 *                     required:
 *                       - authenticatorData
 *                       - clientDataJSON
 *                       - signature
 *                       - userHandle
 *                     properties:
 *                       authenticatorData:
 *                         type: string
 *                         description: Base64URL encoded authenticator data
 *                       clientDataJSON:
 *                         type: string
 *                         description: Base64URL encoded client data JSON
 *                       signature:
 *                         type: string
 *                         description: Base64URL encoded signature
 *                       userHandle:
 *                         type: string
 *                         description: Base64URL encoded user handle (user ID)
 *               challengeKey:
 *                 type: string
 *                 description: The challengeKey returned from /passkey/challenge
 *               rememberMe:
 *                 type: boolean
 *                 default: false
 *                 description: Whether to extend token expiration (30 days vs 24 hours)
 *     responses:
 *       200:
 *         description: Authentication successful
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
 *                   example: Login exitoso
 *                 user:
 *                   type: object
 *                   description: Authenticated user data
 *                   properties:
 *                     id:
 *                       type: string
 *                     email:
 *                       type: string
 *                     firstName:
 *                       type: string
 *                     lastName:
 *                       type: string
 *                     venues:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           name:
 *                             type: string
 *                           slug:
 *                             type: string
 *                           role:
 *                             type: string
 *                 accessToken:
 *                   type: string
 *                   description: JWT access token (store in Keychain)
 *                 refreshToken:
 *                   type: string
 *                   description: JWT refresh token (store in Keychain)
 *       400:
 *         description: Invalid credential format
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
 *                   example: Credential requerido
 *       401:
 *         description: Authentication failed (invalid passkey, expired challenge, etc)
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
 *                   example: Passkey no registrado. Por favor usa otro método de autenticación.
 */
router.post('/auth/passkey/verify', authMobileController.passkeyVerify)

// ============================================================================
// PASSWORD RESET
// Public endpoint - no authentication required
// ============================================================================

/**
 * POST /api/v1/mobile/auth/request-reset
 * Request a password reset email.
 * Always returns success (security: no user enumeration).
 */
router.post('/auth/request-reset', authMobileController.requestReset)

// ============================================================================
// ORDER MANAGEMENT
// Authenticated endpoints - requires valid JWT
// ============================================================================

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/orders:
 *   post:
 *     tags: [Mobile - Orders]
 *     summary: Create order with items
 *     description: |
 *       Creates an order with products/items for the dual-mode payment flow.
 *       Returns orderId which should be sent to TPV via BLE for payment.
 *
 *       **Dual-Mode Payment Flow:**
 *       1. iOS creates order with items (this endpoint)
 *       2. iOS sends `{orderId, amount, tip}` to TPV via BLE
 *       3. TPV processes card and completes payment
 *
 *       **Quick Payment (no products):**
 *       - Skip this endpoint, send `{amount, tip}` directly to TPV
 *       - TPV uses FastPayment flow
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
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
 *               - items
 *             properties:
 *               items:
 *                 type: array
 *                 description: Products to add to the order
 *                 items:
 *                   type: object
 *                   required:
 *                     - productId
 *                     - quantity
 *                   properties:
 *                     productId:
 *                       type: string
 *                       description: Product ID
 *                     quantity:
 *                       type: integer
 *                       minimum: 1
 *                       description: Quantity
 *                     notes:
 *                       type: string
 *                       description: Item notes (e.g., "sin cebolla")
 *                     modifierIds:
 *                       type: array
 *                       items:
 *                         type: string
 *                       description: Selected modifier IDs
 *               staffId:
 *                 type: string
 *                 description: Staff member ID (defaults to authenticated user)
 *               orderType:
 *                 type: string
 *                 enum: [DINE_IN, TAKEOUT, DELIVERY, PICKUP]
 *                 default: TAKEOUT
 *               source:
 *                 type: string
 *                 enum: [AVOQADO_IOS, AVOQADO_ANDROID]
 *                 default: AVOQADO_IOS
 *     responses:
 *       201:
 *         description: Order created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 order:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       description: Order ID (send this to TPV)
 *                     orderNumber:
 *                       type: string
 *                       example: ORD-1706285432123
 *                     status:
 *                       type: string
 *                       example: PENDING
 *                     paymentStatus:
 *                       type: string
 *                       example: PENDING
 *                     subtotal:
 *                       type: number
 *                       description: Subtotal in cents
 *                     total:
 *                       type: number
 *                       description: Total in cents
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *       400:
 *         description: Invalid request (missing items, invalid productId)
 *       401:
 *         description: Not authenticated
 */
router.post('/venues/:venueId/orders', authenticateTokenMiddleware, checkPermission('orders:create'), orderMobileController.createOrder)

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/orders:
 *   get:
 *     tags: [Mobile - Orders]
 *     summary: List orders for a venue (paginated)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: pageSize
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *       - name: search
 *         in: query
 *         schema:
 *           type: string
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *           description: Comma-separated statuses (e.g. COMPLETED,PENDING)
 *       - name: paymentStatus
 *         in: query
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Paginated list of orders
 */
router.get('/venues/:venueId/orders', authenticateTokenMiddleware, checkPermission('orders:read'), orderMobileController.listOrders)

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/orders/{orderId}:
 *   get:
 *     tags: [Mobile - Orders]
 *     summary: Get order details
 *     description: Retrieve order with items and payment status
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
 *     responses:
 *       200:
 *         description: Order details
 *       404:
 *         description: Order not found
 */
router.get('/venues/:venueId/orders/:orderId', authenticateTokenMiddleware, checkPermission('orders:read'), orderMobileController.getOrder)

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/orders/{orderId}/pay:
 *   post:
 *     tags: [Mobile - Orders]
 *     summary: Pay order with cash
 *     description: |
 *       Record a cash payment for an order. No TPV terminal involved.
 *       Payment goes directly to backend. Used when the user selects "Efectivo".
 *
 *       **Cash Payment Flow:**
 *       1. iOS creates order with items
 *       2. User selects "Efectivo" payment method
 *       3. User selects cash amount tendered (preset buttons or custom)
 *       4. iOS calculates and displays change
 *       5. iOS calls this endpoint to record the payment
 *       6. Backend marks order as PAID
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
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *             properties:
 *               amount:
 *                 type: integer
 *                 description: Payment amount in cents
 *                 example: 5000
 *               tip:
 *                 type: integer
 *                 description: Tip amount in cents (optional)
 *                 default: 0
 *               staffId:
 *                 type: string
 *                 description: Staff ID (defaults to authenticated user)
 *     responses:
 *       200:
 *         description: Cash payment recorded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 payment:
 *                   type: object
 *                   properties:
 *                     paymentId:
 *                       type: string
 *                     orderId:
 *                       type: string
 *                     orderNumber:
 *                       type: string
 *                     amount:
 *                       type: integer
 *                       description: Amount in cents
 *                     tipAmount:
 *                       type: integer
 *                       description: Tip in cents
 *                     method:
 *                       type: string
 *                       enum: [CASH]
 *                     status:
 *                       type: string
 *                       enum: [COMPLETED]
 *       400:
 *         description: Invalid request (missing amount, order already paid)
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Order not found
 */
router.post(
  '/venues/:venueId/orders/:orderId/pay',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  orderMobileController.payCash,
)

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/orders/{orderId}:
 *   delete:
 *     tags: [Mobile - Orders]
 *     summary: Cancel unpaid order
 *     description: Cancel an order that hasn't been paid yet
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
 *               reason:
 *                 type: string
 *                 description: Cancellation reason
 *     responses:
 *       200:
 *         description: Order cancelled
 *       400:
 *         description: Cannot cancel paid order
 *       404:
 *         description: Order not found
 */
router.delete(
  '/venues/:venueId/orders/:orderId',
  authenticateTokenMiddleware,
  checkPermission('orders:cancel'),
  orderMobileController.cancelOrder,
)

// ============================================================================
// TRANSACTIONS
// Authenticated endpoints - requires valid JWT
// ============================================================================

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/transactions:
 *   get:
 *     tags: [Mobile - Transactions]
 *     summary: List transactions (paginated)
 *     description: Get paginated list of completed transactions for a venue
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: pageSize
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 50
 *       - name: search
 *         in: query
 *         schema:
 *           type: string
 *       - name: method
 *         in: query
 *         schema:
 *           type: string
 *           enum: [CARD, CASH, OTHER]
 *       - name: dateFrom
 *         in: query
 *         schema:
 *           type: string
 *           format: date
 *       - name: dateTo
 *         in: query
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: Paginated transaction list
 *       401:
 *         description: Not authenticated
 */
router.get(
  '/venues/:venueId/transactions',
  authenticateTokenMiddleware,
  checkPermission('payments:read'),
  transactionMobileController.listTransactions,
)

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/transactions/{paymentId}:
 *   get:
 *     tags: [Mobile - Transactions]
 *     summary: Get transaction detail
 *     description: Get full transaction detail including order items
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: venueId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: paymentId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Transaction detail with order items
 *       404:
 *         description: Transaction not found
 *       401:
 *         description: Not authenticated
 */
router.get(
  '/venues/:venueId/transactions/:paymentId',
  authenticateTokenMiddleware,
  checkPermission('payments:read'),
  transactionMobileController.getTransaction,
)

// ============================================================================
// TIME CLOCK (Reloj Checador)
// PIN-based identification - no JWT required
// ============================================================================

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/time-clock/identify:
 *   post:
 *     tags: [Mobile - Time Clock]
 *     summary: Identify staff by PIN
 *     description: |
 *       Identify a staff member by their PIN and return their current time entry status.
 *       This is the first step in the time clock flow.
 *
 *       **Flow:**
 *       1. User enters PIN
 *       2. Call this endpoint to identify staff and get status
 *       3. Based on `currentEntry`:
 *          - null → Show "Iniciar turno" button
 *          - exists with status CLOCKED_IN → Show "Cerrar turno" / "Tomar descanso"
 *          - exists with status ON_BREAK → Show "Terminar descanso"
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
 *               - pin
 *             properties:
 *               pin:
 *                 type: string
 *                 description: Staff PIN (4-10 digits)
 *     responses:
 *       200:
 *         description: Staff identified
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 staff:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     firstName:
 *                       type: string
 *                     lastName:
 *                       type: string
 *                     role:
 *                       type: string
 *                 currentEntry:
 *                   type: object
 *                   nullable: true
 *                   description: Current active time entry (null if not clocked in)
 *                   properties:
 *                     id:
 *                       type: string
 *                     status:
 *                       type: string
 *                       enum: [CLOCKED_IN, ON_BREAK]
 *                     clockInTime:
 *                       type: string
 *                       format: date-time
 *                     isOnBreak:
 *                       type: boolean
 *       401:
 *         description: Invalid PIN
 */
router.post('/venues/:venueId/time-clock/identify', timeEntryMobileController.identifyByPin)

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/time-clock/clock-in:
 *   post:
 *     tags: [Mobile - Time Clock]
 *     summary: Clock in (by PIN)
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
 *               - pin
 *             properties:
 *               pin:
 *                 type: string
 *               jobRole:
 *                 type: string
 *               checkInPhotoUrl:
 *                 type: string
 *               latitude:
 *                 type: number
 *               longitude:
 *                 type: number
 *     responses:
 *       201:
 *         description: Clocked in successfully
 *       400:
 *         description: Already clocked in
 *       401:
 *         description: Invalid PIN
 */
router.post('/venues/:venueId/time-clock/clock-in', timeEntryMobileController.clockIn)

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/time-clock/clock-out:
 *   post:
 *     tags: [Mobile - Time Clock]
 *     summary: Clock out (by PIN)
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
 *               - pin
 *             properties:
 *               pin:
 *                 type: string
 *               checkOutPhotoUrl:
 *                 type: string
 *               latitude:
 *                 type: number
 *               longitude:
 *                 type: number
 *     responses:
 *       200:
 *         description: Clocked out successfully
 *       400:
 *         description: Not clocked in
 *       401:
 *         description: Invalid PIN
 */
router.post('/venues/:venueId/time-clock/clock-out', timeEntryMobileController.clockOut)

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/time-clock/break/start:
 *   post:
 *     tags: [Mobile - Time Clock]
 *     summary: Start break (by PIN)
 */
router.post('/venues/:venueId/time-clock/break/start', timeEntryMobileController.startBreak)

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/time-clock/break/end:
 *   post:
 *     tags: [Mobile - Time Clock]
 *     summary: End break (by PIN)
 */
router.post('/venues/:venueId/time-clock/break/end', timeEntryMobileController.endBreak)

// ============================================================================
// DEVICE REGISTRATION (Push Notifications)
// Authenticated endpoints
// ============================================================================

/**
 * @openapi
 * /api/v1/mobile/devices/register:
 *   post:
 *     tags: [Mobile - Push Notifications]
 *     summary: Register device for push notifications
 *     description: |
 *       Register an FCM token for push notifications.
 *       Call this after login and whenever the FCM token is refreshed.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *               - platform
 *             properties:
 *               token:
 *                 type: string
 *                 description: FCM registration token
 *               platform:
 *                 type: string
 *                 enum: [IOS, ANDROID, WEB]
 *               deviceModel:
 *                 type: string
 *                 description: Device model (e.g., "iPhone 15 Pro")
 *               osVersion:
 *                 type: string
 *                 description: OS version (e.g., "iOS 17.2")
 *               appVersion:
 *                 type: string
 *                 description: App version (e.g., "1.0.0")
 *               bundleId:
 *                 type: string
 *                 description: App bundle ID
 *     responses:
 *       200:
 *         description: Device registered successfully
 *       401:
 *         description: Authentication required
 */
router.post('/devices/register', authenticateTokenMiddleware, pushMobileController.registerDevice)

/**
 * @openapi
 * /api/v1/mobile/devices/unregister:
 *   post:
 *     tags: [Mobile - Push Notifications]
 *     summary: Unregister device (on logout)
 *     description: Remove the FCM token to stop receiving push notifications.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *             properties:
 *               token:
 *                 type: string
 *                 description: FCM registration token to unregister
 *     responses:
 *       200:
 *         description: Device unregistered successfully
 */
router.post('/devices/unregister', pushMobileController.unregisterDevice)

/**
 * @openapi
 * /api/v1/mobile/devices:
 *   get:
 *     tags: [Mobile - Push Notifications]
 *     summary: Get my registered devices
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of registered devices
 */
router.get('/devices', authenticateTokenMiddleware, pushMobileController.getMyDevices)

/**
 * @openapi
 * /api/v1/mobile/push/test:
 *   post:
 *     tags: [Mobile - Push Notifications]
 *     summary: Send test push notification
 *     description: Send a test push notification to all devices of the authenticated user
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *                 description: Notification title (optional)
 *               body:
 *                 type: string
 *                 description: Notification body (optional)
 *     responses:
 *       200:
 *         description: Test notification sent
 */
router.post('/push/test', authenticateTokenMiddleware, pushMobileController.sendTestPush)

// ============================================================================
// CUSTOMERS (for POS app)
// ============================================================================

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/customers:
 *   get:
 *     tags: [Mobile - Customers]
 *     summary: List customers for a venue
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *     responses:
 *       200:
 *         description: List of customers
 */
router.get('/venues/:venueId/customers', authenticateTokenMiddleware, checkPermission('customers:read'), customerController.getCustomers)

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/customers:
 *   post:
 *     tags: [Mobile - Customers]
 *     summary: Create a new customer
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
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
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *     responses:
 *       201:
 *         description: Customer created
 */
router.post(
  '/venues/:venueId/customers',
  authenticateTokenMiddleware,
  checkPermission('customers:create'),
  customerController.createCustomer,
)

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/customer-groups:
 *   get:
 *     tags: [Mobile - Customers]
 *     summary: List customer groups for a venue
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of customer groups
 */
router.get(
  '/venues/:venueId/customer-groups',
  authenticateTokenMiddleware,
  checkPermission('customers:read'),
  customerGroupController.getCustomerGroups,
)

// ============================================================================
// PAYMENTS
// ============================================================================

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/fast:
 *   post:
 *     tags: [Mobile - Payments]
 *     summary: Record a fast payment (no order)
 *     description: Record a quick payment with just an amount, no order required.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount, method]
 *             properties:
 *               amount:
 *                 type: integer
 *                 description: Amount in cents
 *               tip:
 *                 type: integer
 *                 description: Tip in cents
 *               method:
 *                 type: string
 *                 enum: [CASH, CREDIT_CARD]
 *     responses:
 *       201:
 *         description: Payment recorded
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/venues/:venueId/fast',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  validateRequest(recordFastPaymentParamsSchema),
  validateRequest(recordPaymentBodySchema),
  paymentMobileController.recordFastPayment,
)

// ============================================================================
// TERMINAL PAYMENTS (Socket.IO Bridge)
// Authenticated endpoints - requires valid JWT
// ============================================================================

/**
 * POST /api/v1/mobile/venues/:venueId/terminal-payment
 * Send payment request to a TPV terminal via Socket.IO.
 * Long-polls until terminal responds (max 60s).
 */
router.post(
  '/venues/:venueId/terminal-payment',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  terminalPaymentMobileController.sendTerminalPayment,
)

/**
 * POST /api/v1/mobile/venues/:venueId/terminal-payment/cancel
 * Cancel a pending terminal payment. Sends cancel signal to TPV.
 * requestId ensures TPV only cancels if still on THAT payment (idempotency).
 */
router.post(
  '/venues/:venueId/terminal-payment/cancel',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  terminalPaymentMobileController.cancelTerminalPayment,
)

/**
 * GET /api/v1/mobile/venues/:venueId/terminals/online
 * List terminals currently connected via Socket.IO.
 */
router.get(
  '/venues/:venueId/terminals/online',
  authenticateTokenMiddleware,
  checkPermission('tpv:read'),
  terminalPaymentMobileController.getOnlineTerminals,
)

// ============================================================================
// PRODUCTS
// Authenticated endpoints - requires valid JWT
// ============================================================================

/**
 * GET /api/v1/mobile/venues/:venueId/products
 * List all active, non-deleted products with category, inventory, modifierGroups.
 */
router.get('/venues/:venueId/products', authenticateTokenMiddleware, checkPermission('menu:read'), productMobileController.listProducts)

/**
 * POST /api/v1/mobile/venues/:venueId/products
 * Create a new product.
 */
router.post('/venues/:venueId/products', authenticateTokenMiddleware, checkPermission('menu:create'), productMobileController.createProduct)

/**
 * PUT /api/v1/mobile/venues/:venueId/products/:productId
 * Update product fields.
 */
router.put(
  '/venues/:venueId/products/:productId',
  authenticateTokenMiddleware,
  checkPermission('menu:update'),
  productMobileController.updateProduct,
)

/**
 * DELETE /api/v1/mobile/venues/:venueId/products/:productId
 * Soft delete a product (sets deletedAt + active=false).
 */
router.delete(
  '/venues/:venueId/products/:productId',
  authenticateTokenMiddleware,
  checkPermission('menu:delete'),
  productMobileController.deleteProduct,
)

// ============================================================================
// CATEGORIES
// Authenticated endpoints - requires valid JWT
// ============================================================================

/**
 * GET /api/v1/mobile/venues/:venueId/categories
 * List all active categories ordered by displayOrder.
 */
router.get(
  '/venues/:venueId/categories',
  authenticateTokenMiddleware,
  checkPermission('menu:read'),
  categoryMobileController.listCategories,
)

/**
 * POST /api/v1/mobile/venues/:venueId/categories
 * Create a new category (generates slug from name).
 */
router.post(
  '/venues/:venueId/categories',
  authenticateTokenMiddleware,
  checkPermission('menu:create'),
  categoryMobileController.createCategory,
)

/**
 * PATCH /api/v1/mobile/venues/:venueId/categories/:categoryId
 * Update a category.
 */
router.patch(
  '/venues/:venueId/categories/:categoryId',
  authenticateTokenMiddleware,
  checkPermission('menu:update'),
  categoryMobileController.updateCategory,
)

/**
 * DELETE /api/v1/mobile/venues/:venueId/categories/:categoryId
 * Soft delete a category (sets active=false).
 */
router.delete(
  '/venues/:venueId/categories/:categoryId',
  authenticateTokenMiddleware,
  checkPermission('menu:delete'),
  categoryMobileController.deleteCategory,
)

// ============================================================================
// DISCOUNTS
// ============================================================================

router.get('/venues/:venueId/discounts', authenticateTokenMiddleware, discountMobileController.listDiscounts)
router.post('/venues/:venueId/discounts', authenticateTokenMiddleware, discountMobileController.createDiscount)
router.put('/venues/:venueId/discounts/:discountId', authenticateTokenMiddleware, discountMobileController.updateDiscount)
router.delete('/venues/:venueId/discounts/:discountId', authenticateTokenMiddleware, discountMobileController.deleteDiscount)

// ============================================================================
// COUPONS
// ============================================================================

router.get('/venues/:venueId/coupons', authenticateTokenMiddleware, couponMobileController.listCoupons)
router.post('/venues/:venueId/coupons', authenticateTokenMiddleware, couponMobileController.createCoupon)
router.put('/venues/:venueId/coupons/:couponId', authenticateTokenMiddleware, couponMobileController.updateCoupon)
router.delete('/venues/:venueId/coupons/:couponId', authenticateTokenMiddleware, couponMobileController.deleteCoupon)
router.post('/venues/:venueId/coupons/validate', authenticateTokenMiddleware, couponMobileController.validateCoupon)

// ============================================================================
// TPV SETTINGS (combined terminals + settings in one call)
// ============================================================================

router.get('/venues/:venueId/settings', authenticateTokenMiddleware, tpvSettingsMobileController.getVenueTpvSettings)

// ============================================================================
// NOTIFICATIONS (user-scoped, not venue-scoped)
// ============================================================================

router.get('/notifications', authenticateTokenMiddleware, notificationMobileController.getUserNotifications)
router.get('/notifications/unread-count', authenticateTokenMiddleware, notificationMobileController.getUnreadCount)
router.patch('/notifications/:notificationId/read', authenticateTokenMiddleware, notificationMobileController.markAsRead)
router.patch('/notifications/mark-all-read', authenticateTokenMiddleware, notificationMobileController.markAllAsRead)
router.delete('/notifications/:notificationId', authenticateTokenMiddleware, notificationMobileController.deleteNotification)

// ============================================================================
// SUPPLIERS
// ============================================================================

router.get('/venues/:venueId/suppliers', authenticateTokenMiddleware, supplierMobileController.listSuppliers)

// ============================================================================
// INVENTORY
// Authenticated endpoints - requires valid JWT
// ============================================================================

/**
 * GET /api/v1/mobile/venues/:venueId/inventory/stock-overview
 * List products with inventory tracking and stock levels.
 */
router.get(
  '/venues/:venueId/inventory/stock-overview',
  authenticateTokenMiddleware,
  checkPermission('inventory:read'),
  inventoryMobileController.getStockOverview,
)

/**
 * GET /api/v1/mobile/venues/:venueId/inventory/stock-counts
 * List stock counts for a venue.
 */
router.get(
  '/venues/:venueId/inventory/stock-counts',
  authenticateTokenMiddleware,
  checkPermission('inventory:read'),
  inventoryMobileController.getStockCounts,
)

/**
 * POST /api/v1/mobile/venues/:venueId/inventory/stock-counts
 * Create a new stock count (CYCLE or FULL).
 */
router.post(
  '/venues/:venueId/inventory/stock-counts',
  authenticateTokenMiddleware,
  checkPermission('inventory:create'),
  inventoryMobileController.createStockCount,
)

/**
 * PUT /api/v1/mobile/venues/:venueId/inventory/stock-counts/:countId
 * Update stock count items (set counted quantities).
 */
router.put(
  '/venues/:venueId/inventory/stock-counts/:countId',
  authenticateTokenMiddleware,
  checkPermission('inventory:update'),
  inventoryMobileController.updateStockCount,
)

/**
 * POST /api/v1/mobile/venues/:venueId/inventory/stock-counts/:countId/confirm
 * Confirm stock count and apply inventory adjustments.
 */
router.post(
  '/venues/:venueId/inventory/stock-counts/:countId/confirm',
  authenticateTokenMiddleware,
  checkPermission('inventory:adjust'),
  inventoryMobileController.confirmStockCount,
)

// ============================================================================
// RECEIPTS (Digital Receipt Sending)
// Authenticated endpoints - requires valid JWT
// ============================================================================

/**
 * POST /api/v1/mobile/venues/:venueId/receipts/send-email
 * Send a digital receipt via email.
 * Body: { receiptAccessKey: string, email: string }
 */
router.post(
  '/venues/:venueId/receipts/send-email',
  authenticateTokenMiddleware,
  checkPermission('payments:read'),
  receiptMobileController.sendReceiptEmail,
)

/**
 * POST /api/v1/mobile/venues/:venueId/receipts/send-whatsapp
 * Send a digital receipt via WhatsApp Business API.
 * Body: { receiptAccessKey: string, phone: string }
 */
router.post(
  '/venues/:venueId/receipts/send-whatsapp',
  authenticateTokenMiddleware,
  checkPermission('payments:read'),
  receiptMobileController.sendReceiptWhatsapp,
)

// ============================================================================
// REPORTS (Sales Reports)
// Authenticated endpoints - requires MANAGER+ role
// ============================================================================

/**
 * GET /api/v1/mobile/venues/:venueId/reports/sales-summary
 * Get sales summary report with payment method breakdown and hourly data.
 * Query: { startDate: string, endDate: string, groupBy?: string, reportType?: string }
 */
router.get(
  '/venues/:venueId/reports/sales-summary',
  authenticateTokenMiddleware,
  checkPermission('reports:read'),
  reportsMobileController.salesSummary,
)

/**
 * GET /api/v1/mobile/venues/:venueId/reports/sales-by-item
 * Get sales by item report (top products).
 * Query: { startDate: string, endDate: string }
 */
router.get(
  '/venues/:venueId/reports/sales-by-item',
  authenticateTokenMiddleware,
  checkPermission('reports:read'),
  reportsMobileController.salesByItem,
)

// ============================================================================
// CASH DRAWER (Caja de Efectivo)
// Authenticated endpoints - requires valid JWT
// ============================================================================

/**
 * GET /api/v1/mobile/venues/:venueId/cash-drawer/current
 * Get current open cash drawer session with events.
 */
router.get(
  '/venues/:venueId/cash-drawer/current',
  authenticateTokenMiddleware,
  checkPermission('payments:read'),
  cashDrawerMobileController.getCurrent,
)

/**
 * POST /api/v1/mobile/venues/:venueId/cash-drawer/open
 * Open a new cash drawer session.
 * Body: { startingAmount: number (cents), deviceName?: string, staffName: string }
 */
router.post(
  '/venues/:venueId/cash-drawer/open',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  cashDrawerMobileController.openSession,
)

/**
 * POST /api/v1/mobile/venues/:venueId/cash-drawer/pay-in
 * Add pay-in event to open session.
 * Body: { amount: number (cents), note?: string, staffName: string }
 */
router.post(
  '/venues/:venueId/cash-drawer/pay-in',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  cashDrawerMobileController.payIn,
)

/**
 * POST /api/v1/mobile/venues/:venueId/cash-drawer/pay-out
 * Add pay-out event to open session.
 * Body: { amount: number (cents), note?: string, staffName: string }
 */
router.post(
  '/venues/:venueId/cash-drawer/pay-out',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  cashDrawerMobileController.payOut,
)

/**
 * POST /api/v1/mobile/venues/:venueId/cash-drawer/close
 * Close current cash drawer session.
 * Body: { actualAmount: number (cents), note?: string, staffName: string }
 */
router.post(
  '/venues/:venueId/cash-drawer/close',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  cashDrawerMobileController.closeSession,
)

/**
 * GET /api/v1/mobile/venues/:venueId/cash-drawer/history
 * List closed cash drawer sessions (paginated).
 * Query: { page?: number, pageSize?: number }
 */
router.get(
  '/venues/:venueId/cash-drawer/history',
  authenticateTokenMiddleware,
  checkPermission('payments:read'),
  cashDrawerMobileController.getHistory,
)

/**
 * POST /api/v1/mobile/venues/:venueId/cash-drawer/sync
 * Bulk sync events from mobile (offline-first support).
 * Body: { events: Array<{ type, amount, note?, staffId, staffName, orderId?, createdAt? }> }
 */
router.post(
  '/venues/:venueId/cash-drawer/sync',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  cashDrawerMobileController.syncEvents,
)

// ============================================================================
// PURCHASE ORDERS
// Authenticated endpoints - requires valid JWT
// ============================================================================

/**
 * GET /api/v1/mobile/venues/:venueId/purchase-orders
 * List purchase orders (paginated, with filters).
 * Query: { page?, pageSize?, status?, dateFrom?, dateTo?, search? }
 */
router.get(
  '/venues/:venueId/purchase-orders',
  authenticateTokenMiddleware,
  checkPermission('inventory:read'),
  purchaseOrderMobileController.listPurchaseOrders,
)

/**
 * POST /api/v1/mobile/venues/:venueId/purchase-orders
 * Create a new purchase order.
 * Body: { supplierName, items: [{ rawMaterialId, quantity, unitPrice, unit?, notes? }], notes?, expectedDate? }
 */
router.post(
  '/venues/:venueId/purchase-orders',
  authenticateTokenMiddleware,
  checkPermission('inventory:create'),
  purchaseOrderMobileController.createPurchaseOrder,
)

/**
 * GET /api/v1/mobile/venues/:venueId/purchase-orders/:poId
 * Get purchase order detail with items.
 */
router.get(
  '/venues/:venueId/purchase-orders/:poId',
  authenticateTokenMiddleware,
  checkPermission('inventory:read'),
  purchaseOrderMobileController.getPurchaseOrder,
)

/**
 * PUT /api/v1/mobile/venues/:venueId/purchase-orders/:poId/status
 * Update purchase order status (send, cancel, approve, etc.).
 * Body: { status: string }
 */
router.put(
  '/venues/:venueId/purchase-orders/:poId/status',
  authenticateTokenMiddleware,
  checkPermission('inventory:create'),
  purchaseOrderMobileController.updateStatus,
)

/**
 * POST /api/v1/mobile/venues/:venueId/purchase-orders/:poId/receive
 * Receive stock from a purchase order. Creates inventory movements.
 * Body: { items: [{ itemId: string, receivedQuantity: number }] }
 */
router.post(
  '/venues/:venueId/purchase-orders/:poId/receive',
  authenticateTokenMiddleware,
  checkPermission('inventory:create'),
  purchaseOrderMobileController.receiveStock,
)

// ============================================================================
// INVENTORY TRANSFERS
// Authenticated endpoints - requires valid JWT
// ============================================================================

/**
 * GET /api/v1/mobile/venues/:venueId/transfers
 * List inventory transfers (paginated).
 * Query: { page?, pageSize? }
 */
router.get(
  '/venues/:venueId/transfers',
  authenticateTokenMiddleware,
  checkPermission('inventory:read'),
  transferMobileController.listTransfers,
)

/**
 * POST /api/v1/mobile/venues/:venueId/transfers
 * Create a new inventory transfer.
 * Body: { fromLocationName, toLocationName, items: [{ productId, productName, quantity }], notes?, staffName }
 */
router.post(
  '/venues/:venueId/transfers',
  authenticateTokenMiddleware,
  checkPermission('inventory:create'),
  transferMobileController.createTransfer,
)

/**
 * GET /api/v1/mobile/venues/:venueId/transfers/:id
 * Get transfer detail.
 */
router.get(
  '/venues/:venueId/transfers/:id',
  authenticateTokenMiddleware,
  checkPermission('inventory:read'),
  transferMobileController.getTransfer,
)

/**
 * PUT /api/v1/mobile/venues/:venueId/transfers/:id/status
 * Update transfer status (send, complete, cancel).
 * Body: { status: string }
 */
router.put(
  '/venues/:venueId/transfers/:id/status',
  authenticateTokenMiddleware,
  checkPermission('inventory:create'),
  transferMobileController.updateStatus,
)

// ============================================================================
// REFUNDS (Unassociated)
// Authenticated endpoints - requires valid JWT
// ============================================================================

/**
 * POST /api/v1/mobile/venues/:venueId/refunds
 * Create an unassociated refund (not tied to a specific order).
 * Body: { amount: number (cents), reason: string, method: "CASH", staffName?: string }
 */
router.post(
  '/venues/:venueId/refunds',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  refundMobileController.createRefund,
)

// ============================================================================
// ESTIMATES / PRESUPUESTOS
// Authenticated endpoints - requires valid JWT
// ============================================================================

/**
 * GET /api/v1/mobile/venues/:venueId/estimates
 * List estimates (paginated, with filters).
 * Query: { page?, pageSize?, status?, dateFrom?, dateTo?, search? }
 */
router.get(
  '/venues/:venueId/estimates',
  authenticateTokenMiddleware,
  checkPermission('orders:read'),
  estimateMobileController.listEstimates,
)

/**
 * POST /api/v1/mobile/venues/:venueId/estimates
 * Create a new estimate.
 * Body: { items: [{ productId?, productName, quantity, unitPrice }], staffName, customerName?, customerEmail?, customerPhone?, notes?, validUntil? }
 */
router.post(
  '/venues/:venueId/estimates',
  authenticateTokenMiddleware,
  checkPermission('orders:create'),
  estimateMobileController.createEstimate,
)

/**
 * GET /api/v1/mobile/venues/:venueId/estimates/:estimateId
 * Get estimate detail with items.
 */
router.get(
  '/venues/:venueId/estimates/:estimateId',
  authenticateTokenMiddleware,
  checkPermission('orders:read'),
  estimateMobileController.getEstimate,
)

/**
 * PUT /api/v1/mobile/venues/:venueId/estimates/:estimateId/status
 * Update estimate status (send, accept, reject, cancel).
 * Body: { status: string }
 */
router.put(
  '/venues/:venueId/estimates/:estimateId/status',
  authenticateTokenMiddleware,
  checkPermission('orders:create'),
  estimateMobileController.updateStatus,
)

/**
 * POST /api/v1/mobile/venues/:venueId/estimates/:estimateId/convert
 * Convert an accepted estimate to an order.
 */
router.post(
  '/venues/:venueId/estimates/:estimateId/convert',
  authenticateTokenMiddleware,
  checkPermission('orders:create'),
  estimateMobileController.convertToOrder,
)

// ============================================================================
// PRODUCT OPTIONS (Variants)
// Authenticated endpoints - requires valid JWT
// ============================================================================

/**
 * GET /api/v1/mobile/venues/:venueId/product-options
 * List all product options with values.
 */
router.get(
  '/venues/:venueId/product-options',
  authenticateTokenMiddleware,
  checkPermission('menu:read'),
  productOptionMobileController.listProductOptions,
)

/**
 * POST /api/v1/mobile/venues/:venueId/product-options
 * Create a product option with values.
 * Body: { name: string, values: [{ value: string, sortOrder?: number }] }
 */
router.post(
  '/venues/:venueId/product-options',
  authenticateTokenMiddleware,
  checkPermission('menu:create'),
  productOptionMobileController.createProductOption,
)

/**
 * PUT /api/v1/mobile/venues/:venueId/product-options/:optionId
 * Update a product option and/or its values.
 * Body: { name?: string, values?: [{ value: string, sortOrder?: number }] }
 */
router.put(
  '/venues/:venueId/product-options/:optionId',
  authenticateTokenMiddleware,
  checkPermission('menu:create'),
  productOptionMobileController.updateProductOption,
)

/**
 * DELETE /api/v1/mobile/venues/:venueId/product-options/:optionId
 * Delete a product option and all its values.
 */
router.delete(
  '/venues/:venueId/product-options/:optionId',
  authenticateTokenMiddleware,
  checkPermission('menu:create'),
  productOptionMobileController.deleteProductOption,
)

// ============================================================================
// MEASUREMENT UNITS
// Authenticated endpoints - requires valid JWT
// ============================================================================

/**
 * GET /api/v1/mobile/venues/:venueId/measurement-units
 * List custom measurement units for a venue.
 */
router.get(
  '/venues/:venueId/measurement-units',
  authenticateTokenMiddleware,
  checkPermission('menu:read'),
  measurementUnitMobileController.listMeasurementUnits,
)

/**
 * POST /api/v1/mobile/venues/:venueId/measurement-units
 * Create a custom measurement unit.
 * Body: { name: string, abbreviation: string }
 */
router.post(
  '/venues/:venueId/measurement-units',
  authenticateTokenMiddleware,
  checkPermission('menu:create'),
  measurementUnitMobileController.createMeasurementUnit,
)

/**
 * DELETE /api/v1/mobile/venues/:venueId/measurement-units/:id
 * Delete a custom measurement unit.
 */
router.delete(
  '/venues/:venueId/measurement-units/:id',
  authenticateTokenMiddleware,
  checkPermission('menu:create'),
  measurementUnitMobileController.deleteMeasurementUnit,
)

// ============================================================================
// KDS (Kitchen Display System)
// Authenticated endpoints - requires valid JWT
// ============================================================================

/**
 * GET /api/v1/mobile/venues/:venueId/kds/orders
 * List active KDS orders for a venue.
 * Query: ?status=NEW,PREPARING,READY (default: active orders)
 */
router.get('/venues/:venueId/kds/orders', authenticateTokenMiddleware, kdsMobileController.listKdsOrders)

/**
 * POST /api/v1/mobile/venues/:venueId/kds/orders
 * Create a new KDS order (after payment succeeds).
 * Body: { orderNumber, orderType?, orderId?, items: [{ productName, quantity, modifiers?, notes? }] }
 */
router.post('/venues/:venueId/kds/orders', authenticateTokenMiddleware, kdsMobileController.createKdsOrder)

/**
 * PUT /api/v1/mobile/venues/:venueId/kds/orders/:id/status
 * Update KDS order status.
 * Body: { status: "PREPARING" | "READY" | "COMPLETED" }
 */
router.put('/venues/:venueId/kds/orders/:id/status', authenticateTokenMiddleware, kdsMobileController.updateKdsOrderStatus)

/**
 * POST /api/v1/mobile/venues/:venueId/kds/orders/:id/bump
 * Mark KDS order as COMPLETED instantly.
 */
router.post('/venues/:venueId/kds/orders/:id/bump', authenticateTokenMiddleware, kdsMobileController.bumpKdsOrder)

export default router
