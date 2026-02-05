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
import * as customerController from '../controllers/dashboard/customer.dashboard.controller'
import * as customerGroupController from '../controllers/dashboard/customerGroup.dashboard.controller'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware'
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
router.post('/venues/:venueId/orders', authenticateTokenMiddleware, orderMobileController.createOrder)

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
router.get('/venues/:venueId/orders/:orderId', authenticateTokenMiddleware, orderMobileController.getOrder)

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
router.post('/venues/:venueId/orders/:orderId/pay', authenticateTokenMiddleware, orderMobileController.payCash)

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
router.delete('/venues/:venueId/orders/:orderId', authenticateTokenMiddleware, orderMobileController.cancelOrder)

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
router.get('/venues/:venueId/transactions', authenticateTokenMiddleware, transactionMobileController.listTransactions)

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
router.get('/venues/:venueId/transactions/:paymentId', authenticateTokenMiddleware, transactionMobileController.getTransaction)

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
router.get('/venues/:venueId/customers', authenticateTokenMiddleware, customerController.getCustomers)

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
router.post('/venues/:venueId/customers', authenticateTokenMiddleware, customerController.createCustomer)

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
router.get('/venues/:venueId/customer-groups', authenticateTokenMiddleware, customerGroupController.getCustomerGroups)

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
router.post('/venues/:venueId/terminal-payment', authenticateTokenMiddleware, terminalPaymentMobileController.sendTerminalPayment)

/**
 * POST /api/v1/mobile/venues/:venueId/terminal-payment/cancel
 * Cancel a pending terminal payment. Sends cancel signal to TPV.
 * requestId ensures TPV only cancels if still on THAT payment (idempotency).
 */
router.post('/venues/:venueId/terminal-payment/cancel', authenticateTokenMiddleware, terminalPaymentMobileController.cancelTerminalPayment)

/**
 * GET /api/v1/mobile/venues/:venueId/terminals/online
 * List terminals currently connected via Socket.IO.
 */
router.get('/venues/:venueId/terminals/online', authenticateTokenMiddleware, terminalPaymentMobileController.getOnlineTerminals)

// ============================================================================
// INVENTORY
// Authenticated endpoints - requires valid JWT
// ============================================================================

/**
 * GET /api/v1/mobile/venues/:venueId/inventory/stock-overview
 * List products with inventory tracking and stock levels.
 */
router.get('/venues/:venueId/inventory/stock-overview', authenticateTokenMiddleware, inventoryMobileController.getStockOverview)

/**
 * GET /api/v1/mobile/venues/:venueId/inventory/stock-counts
 * List stock counts for a venue.
 */
router.get('/venues/:venueId/inventory/stock-counts', authenticateTokenMiddleware, inventoryMobileController.getStockCounts)

/**
 * POST /api/v1/mobile/venues/:venueId/inventory/stock-counts
 * Create a new stock count (CYCLE or FULL).
 */
router.post('/venues/:venueId/inventory/stock-counts', authenticateTokenMiddleware, inventoryMobileController.createStockCount)

/**
 * PUT /api/v1/mobile/venues/:venueId/inventory/stock-counts/:countId
 * Update stock count items (set counted quantities).
 */
router.put('/venues/:venueId/inventory/stock-counts/:countId', authenticateTokenMiddleware, inventoryMobileController.updateStockCount)

/**
 * POST /api/v1/mobile/venues/:venueId/inventory/stock-counts/:countId/confirm
 * Confirm stock count and apply inventory adjustments.
 */
router.post(
  '/venues/:venueId/inventory/stock-counts/:countId/confirm',
  authenticateTokenMiddleware,
  inventoryMobileController.confirmStockCount,
)

export default router
