/**
 * Mobile Routes
 *
 * API endpoints for mobile apps (iOS, Android).
 * Base path: /api/v1/mobile
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import * as authMobileController from '../controllers/mobile/auth.mobile.controller'
import * as coachClassController from '../controllers/mobile/coachClass.mobile.controller'
import * as kioskCheckInController from '../controllers/kiosk/kioskCheckIn.controller'
import * as promotionMobileController from '../controllers/mobile/promotion.mobile.controller'
import * as tenderTypeMobileController from '../controllers/mobile/tenderType.mobile.controller'
import * as orderMobileController from '../controllers/mobile/order.mobile.controller'
import * as timeEntryMobileController from '../controllers/mobile/time-entry.mobile.controller'
import * as staffMobileController from '../controllers/mobile/staff.mobile.controller'
import * as pushMobileController from '../controllers/mobile/push.mobile.controller'
import * as transactionMobileController from '../controllers/mobile/transaction.mobile.controller'
import * as paymentMobileController from '../controllers/mobile/payment.mobile.controller'
import * as terminalPaymentMobileController from '../controllers/mobile/terminal-payment.mobile.controller'
import * as inventoryMobileController from '../controllers/mobile/inventory.mobile.controller'
import * as loyaltyMobileController from '../controllers/mobile/loyalty.mobile.controller'
import * as serviceChargeMobileController from '../controllers/mobile/service-charge.mobile.controller'
import * as menuMobileController from '../controllers/mobile/menu.mobile.controller'
import * as receiptMobileController from '../controllers/mobile/receipt.mobile.controller'
import * as reportsMobileController from '../controllers/mobile/reports.mobile.controller'
import * as customerController from '../controllers/dashboard/customer.dashboard.controller'
import * as customerGroupController from '../controllers/dashboard/customerGroup.dashboard.controller'
import * as productMobileController from '../controllers/mobile/product.mobile.controller'
import * as categoryMobileController from '../controllers/mobile/category.mobile.controller'
import * as discountMobileController from '../controllers/mobile/discount.mobile.controller'
import * as couponMobileController from '../controllers/mobile/coupon.mobile.controller'
import * as upsellMobileController from '../controllers/mobile/upsell.mobile.controller'
import { recordUpsellImpressionSchema, convertUpsellImpressionSchema } from '../schemas/dashboard/upsell.schema'
import { updateDisplayModeSchema } from '../schemas/mobile/tpvSettings.mobile.schema'
import * as tpvSettingsMobileController from '../controllers/mobile/tpvSettings.mobile.controller'
import { reportDeviceCapabilitiesSchema } from '../schemas/mobile/deviceCapabilities.mobile.schema'
import * as deviceCapabilitiesMobileController from '../controllers/mobile/deviceCapabilities.mobile.controller'
import * as notificationMobileController from '../controllers/mobile/notification.mobile.controller'
import * as supplierMobileController from '../controllers/mobile/supplier.mobile.controller'
import * as cashDrawerMobileController from '../controllers/mobile/cash-drawer.mobile.controller'
import * as purchaseOrderMobileController from '../controllers/mobile/purchase-order.mobile.controller'
import * as transferMobileController from '../controllers/mobile/transfer.mobile.controller'
import * as refundMobileController from '../controllers/mobile/refund.mobile.controller'
import * as estimateMobileController from '../controllers/mobile/estimate.mobile.controller'
import * as productOptionMobileController from '../controllers/mobile/product-option.mobile.controller'
import * as measurementUnitMobileController from '../controllers/mobile/measurement-unit.mobile.controller'
import * as deliveryOrderMobileController from '../controllers/mobile/deliveryOrder.mobile.controller'
import * as deliveryChannelMobileController from '../controllers/mobile/deliveryChannel.mobile.controller'
import * as kdsMobileController from '../controllers/mobile/kds.mobile.controller'
import * as tableMobileController from '../controllers/mobile/table.mobile.controller'
import * as syncMobileController from '../controllers/mobile/sync.mobile.controller'
import * as creditPackMobileController from '../controllers/mobile/creditPack.mobile.controller'
import * as printMobileController from '../controllers/mobile/print.mobile.controller'
import * as areaTicketMobileController from '../controllers/mobile/areaTicket.mobile.controller'
import * as areaTicketV7MobileController from '../controllers/mobile/areaTicketV7.mobile.controller'
import * as areaTicketExternalMobileController from '../controllers/mobile/areaTicketExternal.mobile.controller'
import * as permissionOverrideMobileController from '../controllers/mobile/permission-override.mobile.controller'
import * as switchUserMobileController from '../controllers/mobile/switch-user.mobile.controller'
import { createPermissionOverrideSchema } from '../schemas/mobile/permissionOverride.mobile.schema'
import { switchUserSchema } from '../schemas/mobile/switchUser.mobile.schema'
import { handoffSchema, confirmExternalSettlementSchema, notChargedSchema } from '../schemas/mobile/areaTicketExternal.schema'
import { areaTicketResolveRateLimiter } from '../middlewares/area-ticket-rate-limit.middleware'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware'
import { checkFeatureAccess } from '../middlewares/checkFeatureAccess.middleware'
import { checkPermission } from '../middlewares/checkPermission.middleware'
import { marcarPermiso, PERMISO_VER_ESPERADO } from '../middlewares/permissionFlag.middleware'
import { PAYMENT_OWNERSHIP_OVERRIDES, checkTableOwnership } from '../middlewares/checkTableOwnership.middleware'
import { validateVenueAccess, requireVenueMembership } from '../middlewares/validateVenueAccess.middleware'
import { pinLoginRateLimiter, pinOverrideRateLimiter, pinSwitchUserRateLimiter } from '../middlewares/pin-login-rate-limit.middleware'
import { registerDeviceMiddleware } from '../middlewares/registerDevice.middleware'
import { validateRequest } from '../middlewares/validation'
import { recordFastPaymentParamsSchema, recordPaymentBodySchema } from '../schemas/tpv.schema'
import { gatewayHeartbeatSchema, printConfigParamSchema, syncPrintJobsSchema } from '../schemas/mobile/print.mobile.schema'
import * as announcementReadController from '../controllers/shared/announcement.read.controller'

const router = Router()

// Registro pasivo de dispositivos (estilo Square Device Management).
//
// Va arriba de todo A PROPÓSITO aunque la autenticación de este router es por ruta: el
// middleware no hace nada en línea, sólo engancha el trabajo a `res.on('finish')`, así
// que corre cuando la respuesta ya salió y `authContext` ya lo pobló la ruta que
// autenticó. Un solo punto de montaje en vez de tocar las 126 rutas, y cero latencia
// añadida al camino del cobro. Un request sin `X-Device-Id` no hace absolutamente nada.
router.use(registerDeviceMiddleware)

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
// PASSKEY REGISTRATION & MANAGEMENT
// Authenticated — a passkey is created/managed from a logged-in session.
// ============================================================================

/**
 * POST /api/v1/mobile/auth/passkey/register/challenge
 * Generate WebAuthn registration options for the authenticated user.
 */
router.post('/auth/passkey/register/challenge', authenticateTokenMiddleware, authMobileController.passkeyRegisterChallenge)

/**
 * POST /api/v1/mobile/auth/passkey/register/verify
 * Verify the attestation and persist the new credential.
 */
router.post('/auth/passkey/register/verify', authenticateTokenMiddleware, authMobileController.passkeyRegisterVerify)

/**
 * GET /api/v1/mobile/auth/passkeys
 * List the authenticated user's registered passkeys.
 */
router.get('/auth/passkeys', authenticateTokenMiddleware, authMobileController.listPasskeys)

/**
 * DELETE /api/v1/mobile/auth/passkeys/:passkeyId
 * Delete one of the authenticated user's passkeys.
 */
router.delete('/auth/passkeys/:passkeyId', authenticateTokenMiddleware, authMobileController.deletePasskey)

/**
 * DELETE /api/v1/mobile/account
 * Delete the requesting staff member's own account (App Store 5.1.1(v)).
 * Soft delete: anonymizes PII + revokes all access; retains financial/audit
 * records (payments company, regulated).
 */
router.delete('/account', authenticateTokenMiddleware, authMobileController.deleteAccount)

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
 *                     discountId:
 *                       type: string
 *                       description: Optional item/category-scoped Discount id to apply to this line (must belong to the venue and be active)
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
 *               customerId:
 *                 type: string
 *                 description: Optional customer to link order as pay-later account receivable
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
/**
 * Candados que dependen del BODY, no de la ruta: sólo corren si la venta trae
 * al menos un `items[].promotionRef`.
 *
 * 1. `discounts:apply` — aplicar una promoción regala mercancía, igual que
 *    aplicar un descuento. Es el espejo online del guard del reducer
 *    (sync.mobile.service.ts → requiredPermissionsForIntent); sin él, la venta
 *    rápida sería la puerta de atrás de ese permiso.
 * 2. `PROMOTIONS` (plan PRO) — el MISMO candado que el catálogo de promociones
 *    del POS (checkFeatureAccess más abajo) y que el reducer
 *    (assertPromotionsFeature): un venue degradado a FREE tampoco aplica
 *    promociones por aquí.
 *
 * El permiso va ANTES del plan a propósito: a quien no puede aplicar
 * promociones no se le revela el plan del negocio.
 *
 * Una venta sin `promotionRef` no paga ninguna consulta extra y se comporta
 * EXACTAMENTE igual que antes.
 */
const checkPromotionGuardsIfPresent = (req: Request, res: Response, next: NextFunction) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  if (!items.some((item: any) => item?.promotionRef)) return next()
  return checkPermission('discounts:apply')(req, res, () => checkFeatureAccess('PROMOTIONS')(req, res, next))
}

router.post(
  '/venues/:venueId/orders',
  authenticateTokenMiddleware,
  checkPermission('orders:create'),
  checkPromotionGuardsIfPresent,
  orderMobileController.createOrder,
)

router.get('/venues/:venueId/staff', authenticateTokenMiddleware, checkPermission('teams:read'), staffMobileController.getActiveStaff)

/**
 * GET /api/v1/mobile/venues/:venueId/tender-types
 * Catálogo de tipos de pago que el POS pinta en "ya pagó de otra forma".
 * Sólo lectura. `payments:read` — cualquier rol que pueda cobrar puede listarlos.
 */
router.get(
  '/venues/:venueId/tender-types',
  authenticateTokenMiddleware,
  checkPermission('payments:read'),
  tenderTypeMobileController.listTenderTypesForPos,
)

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
 * Aceptar o rechazar un pedido de una app de delivery, desde el punto de venta.
 *
 * 🔴 Sin esto, el modo MANUAL era una trampa: el dashboard dejaba activarlo, entraban los
 * pedidos, NADIE podía aceptarlos, y el proveedor los cancelaba a los ~11.5 minutos. Todos,
 * en silencio y sin que nada fallara.
 *
 * Y es la salida cuando el marketplace vende algo que la cocina no puede preparar — cosa
 * que pasa de verdad en un venue sin inventario, porque ahí nunca se marca nada como
 * agotado y el proveedor lo sigue ofreciendo.
 *
 * Permiso `orders:update`: quien puede modificar una cuenta puede decir si la cocina la
 * saca. No se inventa un permiso nuevo — uno más que nadie tiene asignado deja el botón
 * muerto para todos.
 */
router.post(
  '/venues/:venueId/orders/:orderId/delivery/accept',
  authenticateTokenMiddleware,
  checkPermission('orders:update'),
  deliveryOrderMobileController.acceptOrder,
)

router.post(
  '/venues/:venueId/orders/:orderId/delivery/deny',
  authenticateTokenMiddleware,
  checkPermission('orders:update'),
  deliveryOrderMobileController.denyOrder,
)

/**
 * "Me saturé" — frenar los pedidos de reparto un rato, desde el POS.
 *
 * Permiso `delivery-channels:snooze`, NUEVO y angosto a propósito: NO es
 * `delivery-channels:manage`, que además deja reconectar el canal y cambiar precios y
 * horario. Quien cocina necesita el freno, no el tablero. Es el mismo corte que hace Toast,
 * que separa "Throttle Online Orders" del permiso de configuración justo para poder
 * dárselo al puesto de cocina. Lo tienen KITCHEN, WAITER, CASHIER, MANAGER, y —vía
 * dependencia— ADMIN y OWNER.
 *
 * El feature gate PREMIUM no se repite aquí: `listChannelLinks` sólo devuelve canales de
 * venues que ya lo tienen, y un venue sin canales simplemente no ve el control.
 */
router.get(
  '/venues/:venueId/delivery/channels',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('delivery-channels:snooze'),
  deliveryChannelMobileController.listChannels,
)

router.post(
  '/venues/:venueId/delivery/channels/:linkId/snooze',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('delivery-channels:snooze'),
  deliveryChannelMobileController.snoozeChannel,
)

router.delete(
  '/venues/:venueId/delivery/channels/:linkId/snooze',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('delivery-channels:snooze'),
  deliveryChannelMobileController.resumeChannel,
)

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
// 🔴 Única ruta eximida del candado de propiedad de mesa con `tables:pay-any`: con la
// propiedad encendida, el CAJERO no podía liquidar ninguna mesa abierta por un mesero
// —su trabajo literal— y el único escape era `tables:manage-all`, que le regalaría
// editar, descontar, cortesiar, cancelar, mover y fusionar CUALQUIER mesa. Toast y
// Square resuelven igual: hay dueño de mesa para EDITAR el cheque, y la caja lo liquida.
// Las demás rutas de esta orden conservan el override default.
router.post(
  '/venues/:venueId/orders/:orderId/pay',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  checkTableOwnership('order', PAYMENT_OWNERSHIP_OVERRIDES),
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
// 🔴 `orders:cancel-unpaid`, no `orders:cancel`: el POS crea la orden ANTES de cobrar,
// así que si el cliente se arrepiente o falla la terminal el mostrador tiene que poder
// deshacerla — con `orders:cancel` (MANAGER+) quedaba una orden abierta y cobrable
// ensuciando el corte, y el cajero atrapado en la pantalla de error. Dar `orders:cancel`
// al mostrador habría permitido anular cheques AJENOS ya en servicio; el permiso acotado
// no, porque el servicio rechaza cualquier orden con pagos (PAID o PARTIAL).
// `orders:cancel` lo implica, así que MANAGER+ no pierde nada.
router.delete(
  '/venues/:venueId/orders/:orderId',
  authenticateTokenMiddleware,
  checkPermission('orders:cancel-unpaid'),
  checkTableOwnership('order'),
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
// PIN DE AUTORIZACIÓN DE GERENTE (manager override)
// ============================================================================

/**
 * POST /api/v1/mobile/venues/:venueId/permission-overrides
 * Cambia el PIN de alguien CON el permiso por un token de un solo uso (60 s)
 * para ESE permiso y ESE venue. No ejecuta nada: el POS reintenta su request
 * original con el header `X-Permission-Override`.
 *
 * Mismo rate limit que el login por PIN (prod: 10/15 min por IP, 20 por venue).
 */
router.post(
  '/venues/:venueId/permission-overrides',
  authenticateTokenMiddleware,
  requireVenueMembership,
  // 🔴 Cubeta PROPIA, no la del login: compartirla hacía que un cambio de turno
  // dejara al local sin poder autorizar, y que las autorizaciones dejaran al
  // personal sin poder checar entrada. Mismos topes, presupuesto separado.
  pinOverrideRateLimiter,
  validateRequest(createPermissionOverrideSchema),
  permissionOverrideMobileController.createOverride,
)

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/auth/switch-user:
 *   post:
 *     tags: [Mobile Auth]
 *     summary: Cambiar de usuario con PIN, sin cerrar sesión
 *     description: |
 *       Releva a quien está operando el aparato. Devuelve la MISMA forma que el login
 *       (`accessToken`, `refreshToken`, `staff`) para que la app reuse su camino de guardado y
 *       refresque la UI con los permisos de quien entra.
 *
 *       Requiere una sesión VIVA en el aparato: el PIN nunca abre una tablet donde nadie inició
 *       sesión con contraseña. La sesión saliente queda revocada.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema: { type: string }
 *       - in: header
 *         name: X-Device-Id
 *         schema: { type: string }
 *         description: Identificador del aparato. Es la llave del limitador de intentos.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pin]
 *             properties:
 *               pin: { type: string, example: "1234", description: "4 a 10 dígitos" }
 *     responses:
 *       200: { description: Usuario cambiado; tokens y permisos nuevos }
 *       401: { description: PIN incorrecto, o no hay sesión viva en el aparato }
 *       429: { description: Demasiados intentos desde este aparato }
 */
router.post(
  '/venues/:venueId/auth/switch-user',
  authenticateTokenMiddleware,
  requireVenueMembership,
  // 🔴 Cubeta PROPIA y contada por APARATO (no por IP): las tablets de un local comparten IP por
  // NAT, así que contar por IP dejaría a todo el negocio sin cambiar de usuario por los dedos de
  // una sola persona. Misma lección que ya documentó el override al compartir cubeta con el reloj.
  pinSwitchUserRateLimiter,
  validateRequest(switchUserSchema),
  switchUserMobileController.switchUser,
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
router.post('/venues/:venueId/time-clock/identify', pinLoginRateLimiter, timeEntryMobileController.identifyByPin)

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
router.post('/venues/:venueId/time-clock/clock-in', pinLoginRateLimiter, timeEntryMobileController.clockIn)

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
router.post('/venues/:venueId/time-clock/clock-out', pinLoginRateLimiter, timeEntryMobileController.clockOut)

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/time-clock/break/start:
 *   post:
 *     tags: [Mobile - Time Clock]
 *     summary: Start break (by PIN)
 */
router.post('/venues/:venueId/time-clock/break/start', pinLoginRateLimiter, timeEntryMobileController.startBreak)

/**
 * @openapi
 * /api/v1/mobile/venues/{venueId}/time-clock/break/end:
 *   post:
 *     tags: [Mobile - Time Clock]
 *     summary: End break (by PIN)
 */
router.post('/venues/:venueId/time-clock/break/end', pinLoginRateLimiter, timeEntryMobileController.endBreak)

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

// ─── CREDIT PACKS (prepaid packages — sell in person / redeem at the POS) ───
// List a venue's active packs (optionally ?productId= to only those including it).
router.get(
  '/venues/:venueId/credit-packs',
  authenticateTokenMiddleware,
  checkPermission('creditPacks:read'),
  creditPackMobileController.listPacks,
)
// A customer's active, non-expired credit balances.
router.get(
  '/venues/:venueId/customers/:customerId/credit-balance',
  authenticateTokenMiddleware,
  checkPermission('creditPacks:read'),
  creditPackMobileController.getBalance,
)
// Sell a pack to a customer in person (paid through the POS, not Stripe).
// `creditPacks:sell`, NO `:create` — esta ruta vende un paquete YA existente; `:create`
// es la llave de crear uno nuevo en el CATÁLOGO (precio y sesiones) desde el dashboard.
router.post(
  '/venues/:venueId/credit-packs/:packId/sell',
  authenticateTokenMiddleware,
  checkPermission('creditPacks:sell'),
  creditPackMobileController.sellPack,
)
// Redeem one credit from a balance.
// `creditPacks:redeem`, NO `:update` — descontar la clase que el socio ya pagó no puede
// costar el permiso de editarle el precio al paquete (founder, 2026-08-16).
router.post(
  '/venues/:venueId/credit-balances/:balanceId/redeem',
  authenticateTokenMiddleware,
  checkPermission('creditPacks:redeem'),
  creditPackMobileController.redeemCredit,
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

router.post(
  '/venues/:venueId/payments/:paymentId/customer',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  paymentMobileController.attachCustomerToPayment,
)

router.post(
  '/venues/:venueId/payments/customer',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  paymentMobileController.attachCustomerToLatestPayment,
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
 * POST /api/v1/mobile/venues/:venueId/terminals/:terminalId/print-receipt
 * Print a receipt on a connected TPV terminal.
 */
router.post(
  '/venues/:venueId/terminals/:terminalId/print-receipt',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  terminalPaymentMobileController.printReceiptOnTerminal,
)

/**
 * POST /api/v1/mobile/venues/:venueId/terminals/:terminalId/refund-request
 * Abrir en una terminal conectada la devolución de un cobro con tarjeta.
 * Pide `payments:refund` —el mismo permiso que reembolsar desde el POS—, no
 * `payments:create`: quien no puede devolver aquí tampoco puede mandarlo al
 * aparato para que lo devuelvan por él.
 */
router.post(
  '/venues/:venueId/terminals/:terminalId/refund-request',
  authenticateTokenMiddleware,
  checkPermission('payments:refund'),
  terminalPaymentMobileController.requestRefundOnTerminal,
)

/**
 * GET /api/v1/mobile/venues/:venueId/terminal-payment/:requestId
 * Status of a terminal payment request — recovery after a dropped long-poll /
 * timeout. Trichotomy: terminal status / IN_PROGRESS / 404 NOT_FOUND. Clients
 * MUST call this before retrying a timed-out charge (never blind-retry money).
 */
router.get(
  '/venues/:venueId/terminal-payment/:requestId',
  authenticateTokenMiddleware,
  checkPermission('payments:read'),
  terminalPaymentMobileController.getTerminalPaymentStatus,
)

/**
 * GET /api/v1/mobile/venues/:venueId/terminals/online
 * List terminals currently connected via Socket.IO.
 *
 * Pide `payments:create` —el mismo permiso que mandar el cobro a la terminal—,
 * no `tpv:read`: ver qué aparato está prendido es parte de COBRAR, no de
 * ADMINISTRAR terminales (listarlas y ver su salud desde el dashboard). Con
 * `tpv:read` un CASHIER, cuyo trabajo es justamente cobrar, recibía «No tienes
 * permiso» a media pantalla de propina porque la app consulta esta ruta sola.
 */
router.get(
  '/venues/:venueId/terminals/online',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
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
// 🔴 `tpv-products:write`, el permiso que el catálogo declara literal como "crear
// productos al vuelo (Scan & Go)" y que hasta hoy NO RESOLVÍA A NADA: se le daba a
// MANAGER+ y esta ruta —la del diálogo "Crear nuevo" del escáner— pedía `menu:create`.
// Un rol personalizado con el toggle de Scan & Go encendido recibía 403 con la captura
// ya hecha. `menu:create` lo implica (puente), así que nadie que administre el menú
// pierde el alta. El alta de catálogo del back-office se queda en `menu:create`.
router.post(
  '/venues/:venueId/products',
  authenticateTokenMiddleware,
  checkPermission('tpv-products:write'),
  productMobileController.createProduct,
)

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
//
// 🔴 Estas rutas llevaban SÓLO `requireVenueMembership`: cualquier miembro del
// venue —mesero, cocinero o VIEWER— podía crear, editar y borrar los descuentos
// del negocio desde el POS, mientras la gemela de /dashboard sí exigía
// `discounts:create/update/delete`. El POS era la puerta de atrás al mismo
// catálogo. Mismos nombres que /dashboard: un permiso se espeja EXACTO o el
// mismo usuario puede en un cliente y no en el otro.
// El mostrador NO pierde nada: leer descuentos para aplicarlos sigue siendo
// `discounts:read` + `discounts:apply`, que CASHIER y WAITER ya traen.
// ============================================================================

router.get(
  '/venues/:venueId/discounts',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('discounts:read'),
  discountMobileController.listDiscounts,
)
router.post(
  '/venues/:venueId/discounts',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('discounts:create'),
  discountMobileController.createDiscount,
)
router.put(
  '/venues/:venueId/discounts/:discountId',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('discounts:update'),
  discountMobileController.updateDiscount,
)
router.delete(
  '/venues/:venueId/discounts/:discountId',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('discounts:delete'),
  discountMobileController.deleteDiscount,
)

// ============================================================================
// COUPONS
//
// 🔴 Mismo hueco que descuentos: sin `checkPermission`, cualquier miembro creaba
// y borraba cupones del negocio. `validate` es el gesto del COBRO (comprobar un
// código con el cliente enfrente) → `coupons:redeem`, que CASHIER y WAITER ya
// tienen; no `coupons:create`, que administra el catálogo.
// ============================================================================

router.get(
  '/venues/:venueId/coupons',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('coupons:read'),
  couponMobileController.listCoupons,
)
router.post(
  '/venues/:venueId/coupons',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('coupons:create'),
  couponMobileController.createCoupon,
)
router.put(
  '/venues/:venueId/coupons/:couponId',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('coupons:update'),
  couponMobileController.updateCoupon,
)
router.delete(
  '/venues/:venueId/coupons/:couponId',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('coupons:delete'),
  couponMobileController.deleteCoupon,
)
router.post(
  '/venues/:venueId/coupons/validate',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('coupons:redeem'),
  couponMobileController.validateCoupon,
)

// ============================================================================
// UPSELL "¿Algo más?"
//
// 🔴 `checkFeatureAccess('UPSELL')` va PRIMERO a propósito: su 403 lleva
// `featureCode` en el cuerpo, y el POS borra su caché de reglas SÓLO cuando ve ese
// campo. Un 403 de permisos no lo trae, así que no apaga la función en un local
// que sí la paga (spec R3).
//
// Las impresiones NO llevan feature gate: son analítica fuego-y-olvido y un 403
// ahí sólo generaría ruido en el log de un POS que ya dejó de mostrar tarjetas.
// ============================================================================

// 🔴 El permiso va ANTES del candado de plan, no al revés.
//
// Dos razones, y las dos importan:
//  1. Al revés, un extraño que no es de este local recibe primero la respuesta
//     del PLAN — o sea, se entera de qué contrata un negocio ajeno antes de que
//     se le diga que no pertenece. Es la fuga "feature-antes-de-permiso" que ya
//     está identificada en la plataforma; aquí no se agrega otra.
//  2. El POS borra su tabla cacheada SÓLO ante un 403 con `featureCode`. Con este
//     orden, ese cuerpo lo produce únicamente el candado de plan de verdad: a un
//     mesero sin permiso se le niega sin `featureCode` y el local conserva sus
//     sugerencias en lugar de apagarlas por una confusión de roles.
router.get(
  '/venues/:venueId/upsell-rules',
  authenticateTokenMiddleware,
  checkPermission('upsells:read'),
  checkFeatureAccess('UPSELL'),
  upsellMobileController.listUpsellRules,
)

/**
 * GET /api/v1/mobile/venues/:venueId/promotions
 * Promociones vigentes y las que abren en las próximas 4 horas.
 *
 * `requireVenueMembership` va ANTES del candado de plan por la misma razón
 * documentada arriba para upsell: un extraño no se entera del plan de un
 * negocio ajeno antes de que se le diga que no pertenece.
 */
router.get(
  '/venues/:venueId/promotions',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkFeatureAccess('PROMOTIONS'),
  promotionMobileController.getPromotions,
)

router.post(
  '/venues/:venueId/upsell-impressions',
  authenticateTokenMiddleware,
  requireVenueMembership,
  validateRequest(recordUpsellImpressionSchema),
  upsellMobileController.recordUpsellImpression,
)

router.patch(
  '/venues/:venueId/upsell-impressions/:impressionId',
  authenticateTokenMiddleware,
  requireVenueMembership,
  validateRequest(convertUpsellImpressionSchema),
  upsellMobileController.convertUpsellImpression,
)

// ============================================================================
// TPV SETTINGS (combined terminals + settings in one call)
// ============================================================================

router.get(
  '/venues/:venueId/settings',
  authenticateTokenMiddleware,
  requireVenueMembership,
  tpvSettingsMobileController.getVenueTpvSettings,
)

// Hechos técnicos observados por el POS Android. El dispositivo se identifica por
// X-Device-ID; no requiere activación y no acepta un terminalId elegido por el body.
router.put(
  '/venues/:venueId/device-capabilities',
  authenticateTokenMiddleware,
  requireVenueMembership,
  validateRequest(reportDeviceCapabilitiesSchema),
  deviceCapabilitiesMobileController.reportDeviceCapabilities,
)

// Entrega v1 ligera: el terminalId viene del vínculo exacto del propio X-Device-ID.
// No se mezcla con /settings y una lectura nunca expira ni muta la intención.
router.get(
  '/venues/:venueId/display-mode-request',
  authenticateTokenMiddleware,
  requireVenueMembership,
  tpvSettingsMobileController.getDisplayModeRequest,
)

// Mostrador invertido (customer-display grande/chico) — por DISPOSITIVO. El POS
// aplica su valor local y sincroniza con este; el dashboard lo puede cambiar remoto.
router.patch(
  '/venues/:venueId/terminals/:terminalId/display-mode',
  authenticateTokenMiddleware,
  requireVenueMembership,
  validateRequest(updateDisplayModeSchema),
  tpvSettingsMobileController.updateDisplayMode,
)

// ============================================================================
// NOTIFICATIONS (user-scoped, not venue-scoped)
// ============================================================================

router.get('/notifications', authenticateTokenMiddleware, notificationMobileController.getUserNotifications)

// ===== Anuncios de plataforma (aditivo: el buzon de /notifications NO se toca) =====
// 🔴 `/home` va ANTES que `/:id`, si no Express toma "home" como un id.
router.get('/announcements/home', authenticateTokenMiddleware, announcementReadController.home)
router.get('/announcements/:id', authenticateTokenMiddleware, announcementReadController.getDetail)
router.post('/announcements/:id/open', authenticateTokenMiddleware, announcementReadController.open)
router.post('/announcements/:id/cta', authenticateTokenMiddleware, announcementReadController.cta)
router.post('/announcements/:id/dismiss', authenticateTokenMiddleware, announcementReadController.dismiss)

router.get('/notifications/unread-count', authenticateTokenMiddleware, notificationMobileController.getUnreadCount)
router.patch('/notifications/:notificationId/read', authenticateTokenMiddleware, notificationMobileController.markAsRead)
router.patch('/notifications/mark-all-read', authenticateTokenMiddleware, notificationMobileController.markAllAsRead)
router.delete('/notifications/:notificationId', authenticateTokenMiddleware, notificationMobileController.deleteNotification)

// ============================================================================
// SUPPLIERS
// ============================================================================

router.get('/venues/:venueId/suppliers', authenticateTokenMiddleware, requireVenueMembership, supplierMobileController.listSuppliers)

// ============================================================================
// TABLES (reservation MESA picker — reuses the same table.tpv.service the
// /tpv/venues/:venueId/tables endpoint uses; identical response shape)
// ============================================================================

/**
 * @openapi
 * /mobile/venues/{venueId}/tables:
 *   get:
 *     summary: Get all tables with current status (for reservation table picker)
 *     tags: [Mobile - Tables]
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of tables with their current status and orders
 */
router.get('/venues/:venueId/tables', authenticateTokenMiddleware, checkPermission('tables:read'), tableMobileController.getTables)

// ─── TABLE_SERVICE (PRO) — restaurant table service from the mobile POS ─────
// Open/clear tables and add rounds to an open order. Gated by the
// TABLE_SERVICE feature code (paid-tier blanket grant → PRO+; FREE gets 403),
// mirrored by exact name in the iOS/Android plan gates. Delegates to the same
// TPV services, so Socket.IO TABLE_STATUS_CHANGE stays consistent everywhere.

/**
 * POST /api/v1/mobile/venues/{venueId}/tables/{tableId}/open
 * Open a table: reuses its active order or creates an empty DINE_IN order and
 * marks the table OCCUPIED. Body: { covers?: number }
 */
// 🔴 `tables:update`, no `orders:create`: abrir una mesa es un acto de SALA — cambia
// el estado del piso. La orden DINE_IN vacía que se crea nace sin líneas y sin dinero,
// es un detalle de implementación. Con `orders:create` el HOST —que decide dónde se
// sienta la gente— no podía abrir una mesa, y `tables:update`, que sí tiene, no abría
// NINGUNA ruta: era un permiso muerto. Mismo nombre que ya usa el MCP `set_table_status`.
router.post(
  '/venues/:venueId/tables/:tableId/open',
  authenticateTokenMiddleware,
  checkFeatureAccess('TABLE_SERVICE'),
  checkPermission('tables:update'),
  // Propiedad de mesa: abrir una mesa OCUPADA por otro mesero reutilizaría su
  // orden activa → 403 TABLE_OWNED_BY_OTHER (el cliente muestra read-only).
  checkTableOwnership('table'),
  tableMobileController.openTable,
)

/**
 * POST /api/v1/mobile/venues/{venueId}/tables/{tableId}/clear
 * Release a table after its order is PAID (rejects unpaid orders).
 */
// Liberar la mesa es la otra mitad del mismo acto de sala (y sólo procede con la
// cuenta PAGADA), así que comparte permiso con abrir.
router.post(
  '/venues/:venueId/tables/:tableId/clear',
  authenticateTokenMiddleware,
  checkFeatureAccess('TABLE_SERVICE'),
  checkPermission('tables:update'),
  checkTableOwnership('table'),
  tableMobileController.clearTable,
)

/**
 * POST /api/v1/mobile/venues/{venueId}/orders/{orderId}/move
 * Move an OPEN check to another table (Square's "Mover").
 * Body: { targetTableId: string }
 */
// Mover la cuenta a otra mesa es reubicar gente en el salón, no editar la comanda:
// Toast lo separa igual ("Change Table" es su propio permiso). Con `orders:update` lo
// podía hacer KITCHEN y no lo podía hacer el HOST — justo al revés.
router.post(
  '/venues/:venueId/orders/:orderId/move',
  authenticateTokenMiddleware,
  checkFeatureAccess('TABLE_SERVICE'),
  checkPermission('tables:update'),
  checkTableOwnership('order'),
  tableMobileController.moveOrder,
)

/**
 * POST /api/v1/mobile/venues/{venueId}/orders/{orderId}/assign
 * Reassign an OPEN check to another waiter (Square's "Asignar").
 * Body: { staffId: string }
 */
router.post(
  '/venues/:venueId/orders/:orderId/assign',
  authenticateTokenMiddleware,
  checkFeatureAccess('TABLE_SERVICE'),
  checkPermission('orders:update'),
  checkTableOwnership('order'),
  tableMobileController.assignOrder,
)

/**
 * POST /api/v1/mobile/venues/{venueId}/orders/{orderId}/items
 * Add a round of items to an OPEN order (optimistic concurrency via body
 * `version`; stale version → 409).
 */
router.post(
  '/venues/:venueId/orders/:orderId/items',
  authenticateTokenMiddleware,
  checkFeatureAccess('TABLE_SERVICE'),
  checkPermission('orders:create'),
  checkTableOwnership('order'),
  orderMobileController.addItemsToOrder,
)

// ─── OFFLINE-FIRST SYNC (Fase 1, Corte D) ────────────────────────────────────

/**
 * POST /api/v1/mobile/venues/{venueId}/sync/intents
 * Replay del outbox offline de los POS: batch FIFO por dispositivo, un ack por
 * intent (idempotente vía [venueId, idempotencyKey]). El gating de features
 * (TABLE_SERVICE) y la propiedad de mesa se evalúan POR INTENT en el reducer —
 * sincronizar no es puerta trasera. Body: { deviceId, intents: [...] }
 */
router.post('/venues/:venueId/sync/intents', authenticateTokenMiddleware, validateVenueAccess, syncMobileController.syncIntents)

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
 * GET /api/v1/mobile/venues/:venueId/inventory/raw-materials
 * List active raw materials (ingredients) for cycle-count picking and
 * barcode matching in the counting flow.
 */
router.get(
  '/venues/:venueId/inventory/raw-materials',
  authenticateTokenMiddleware,
  checkPermission('inventory:read'),
  inventoryMobileController.getRawMaterials,
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
  // No bloquea: sólo marca si puede ver el efectivo esperado. Sin el permiso, la respuesta
  // llega sin ese campo mientras la caja esté abierta (conteo ciego). El POS no lo lee —lo
  // calcula con `startingAmount` y los eventos, que sí siguen viajando—, así que ninguna app
  // instalada cambia de comportamiento.
  marcarPermiso(PERMISO_VER_ESPERADO, 'puedeVerEsperado'),
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
  // Mismo criterio que `current`: quien puede ver el esperado lo recibe también al abrir.
  marcarPermiso(PERMISO_VER_ESPERADO, 'puedeVerEsperado'),
  cashDrawerMobileController.openSession,
)

/**
 * POST /api/v1/mobile/venues/:venueId/cash-drawer/pay-in
 * Add pay-in event to open session.
 * Body: { amount: number (cents), note?: string, staffName: string, localId?: string }
 *
 * `localId` (opcional, ≤64 chars, no vacío) = el id local del POS. Es la llave de
 * idempotencia: reenviar el MISMO `localId` devuelve el movimiento original con **200**
 * en vez de crear otro (**201** sólo cuando de verdad se creó). Sin él, un reintento tras
 * una respuesta perdida duplica el ingreso y el arqueo inventa efectivo.
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
 * Body: { amount: number (cents), note?: string, staffName: string, localId?: string }
 *
 * `localId` igual que en pay-in: MISMA llave → **200** con el retiro original, sin restar
 * el dinero dos veces. Aquí el defecto va al otro lado (faltante inventado).
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
 * POST /api/v1/mobile/venues/:venueId/orders/:orderId/items/:itemId/comp
 * "Dar de cortesía": the line stays on the check but stops costing money.
 * Body: { reason } (required). Rejected once the order is PAID/PARTIAL.
 */
router.post(
  '/venues/:venueId/orders/:orderId/split',
  authenticateTokenMiddleware,
  checkFeatureAccess('TABLE_SERVICE'),
  checkPermission('orders:update'),
  checkTableOwnership('order'),
  orderMobileController.splitOrder,
)

/**
 * POST /api/v1/mobile/venues/:venueId/orders/:orderId/merge
 * "Fusionar cuentas" (Square's merge): el inverso de dividir.
 * 🔴 Permiso PROPIO desde 2026-08: junta el dinero de dos cheques y cierra el
 * origen. WAITER no lo trae — el POS ofrece PIN de gerente si el venue lo activó.
 */
router.post(
  '/venues/:venueId/orders/:orderId/merge',
  authenticateTokenMiddleware,
  checkFeatureAccess('TABLE_SERVICE'),
  checkPermission('orders:merge'),
  checkTableOwnership('order'),
  orderMobileController.mergeOrders,
)

/**
 * POST /api/v1/mobile/venues/:venueId/orders/:orderId/split-by-seat
 * "Dividir por puesto" (Square): un cheque por asiento, atómico.
 */
router.post(
  '/venues/:venueId/orders/:orderId/split-by-seat',
  authenticateTokenMiddleware,
  checkFeatureAccess('TABLE_SERVICE'),
  checkPermission('orders:update'),
  checkTableOwnership('order'),
  orderMobileController.splitOrderBySeat,
)

router.post(
  '/venues/:venueId/orders/:orderId/discounts',
  authenticateTokenMiddleware,
  checkFeatureAccess('TABLE_SERVICE'),
  checkPermission('orders:update'),
  checkTableOwnership('order'),
  orderMobileController.applyOrderDiscount,
)

/**
 * DELETE /api/v1/mobile/venues/:venueId/orders/:orderId/discounts/:orderDiscountId
 * Removes one applied order discount from the open check.
 */
router.delete(
  '/venues/:venueId/orders/:orderId/discounts/:orderDiscountId',
  authenticateTokenMiddleware,
  checkFeatureAccess('TABLE_SERVICE'),
  checkPermission('orders:update'),
  checkTableOwnership('order'),
  orderMobileController.removeOrderDiscount,
)

// 🔴 ASIMETRÍA DECLARADA, NO ARREGLADA (auditoría de permisos de piso, 2026-08-17).
// Regalar la cuenta entera pide aquí `orders:update` (lo traen WAITER y CASHIER), pero
// la MISMA cortesía pide `orders:comp` (MANAGER+) por TPV y por la cola offline
// (intents COMP_ORDER y ADD_ITEMS con isCortesia). Es PREEXISTENTE — no la abrió esta
// auditoría — y apretarla le quitaría a los meseros de todos los venues algo que hoy
// usan. Es decisión de producto con dinero enfrente, del founder. Detalle y tabla
// medida: `src/services/mobile/sync.mobile.service.ts` (case 'COMP_ORDER').
router.post(
  '/venues/:venueId/orders/:orderId/comp',
  authenticateTokenMiddleware,
  checkFeatureAccess('TABLE_SERVICE'),
  checkPermission('orders:update'),
  checkTableOwnership('order'),
  orderMobileController.compWholeOrder,
)

/**
 * GET /api/v1/mobile/venues/:venueId/menus
 * Menús del venue con su horario y cuál aplica AHORA (zona horaria del venue).
 * El POS filtra su cuadrícula por las categorías del menú seleccionado.
 */
router.get('/venues/:venueId/menus', authenticateTokenMiddleware, checkPermission('menu:read'), menuMobileController.listMenus)

/**
 * GET /api/v1/mobile/venues/:venueId/service-charges
 * Catálogo de cobros por servicio (propina automática por grupo, descorche…).
 */
router.get(
  '/venues/:venueId/service-charges',
  authenticateTokenMiddleware,
  checkFeatureAccess('TABLE_SERVICE'),
  checkPermission('orders:read'),
  serviceChargeMobileController.listServiceCharges,
)

/**
 * POST /api/v1/mobile/venues/:venueId/orders/:orderId/service-charges
 * Aplica un cobro por servicio a la cuenta abierta — SUMA al total (ingreso
 * gravable del negocio, a diferencia de la propina).
 */
router.post(
  '/venues/:venueId/orders/:orderId/service-charges',
  authenticateTokenMiddleware,
  checkFeatureAccess('TABLE_SERVICE'),
  checkPermission('orders:update'),
  checkTableOwnership('order'),
  serviceChargeMobileController.applyServiceCharge,
)

/**
 * DELETE /api/v1/mobile/venues/:venueId/orders/:orderId/service-charges/:orderServiceChargeId
 */
router.delete(
  '/venues/:venueId/orders/:orderId/service-charges/:orderServiceChargeId',
  authenticateTokenMiddleware,
  checkFeatureAccess('TABLE_SERVICE'),
  checkPermission('orders:update'),
  checkTableOwnership('order'),
  serviceChargeMobileController.removeServiceCharge,
)

/**
 * GET /api/v1/mobile/venues/:venueId/customers/:customerId/loyalty
 * "Recompensas": balance + program rules for the customer on the check.
 * Optional ?orderId= caps the redeemable amount at that check's total.
 */
router.get(
  '/venues/:venueId/customers/:customerId/loyalty',
  authenticateTokenMiddleware,
  checkFeatureAccess('LOYALTY_PROGRAM'),
  checkPermission('loyalty:read'),
  loyaltyMobileController.getCustomerLoyalty,
)

/**
 * POST /api/v1/mobile/venues/:venueId/orders/:orderId/loyalty/redeem
 * Burns points and applies the matching discount to the OPEN check in ONE
 * transaction (see loyalty.mobile.service — the dashboard path never did).
 */
router.post(
  '/venues/:venueId/orders/:orderId/loyalty/redeem',
  authenticateTokenMiddleware,
  checkFeatureAccess('LOYALTY_PROGRAM'),
  checkPermission('orders:update'),
  checkTableOwnership('order'),
  loyaltyMobileController.redeemPoints,
)

/**
 * POST /api/v1/mobile/venues/:venueId/orders/:orderId/details
 * Partial update of the check's metadata: { name?, notes?, covers?, customerId? }
 */
router.post(
  '/venues/:venueId/orders/:orderId/details',
  authenticateTokenMiddleware,
  checkFeatureAccess('TABLE_SERVICE'),
  checkPermission('orders:update'),
  checkTableOwnership('order'),
  orderMobileController.updateOrderDetails,
)

// 🔴 Misma asimetría declarada que la cortesía de la cuenta entera (ver arriba):
// `orders:update` aquí vs `orders:comp` en TPV y en el replay offline. Preexistente.
router.post(
  '/venues/:venueId/orders/:orderId/items/:itemId/comp',
  authenticateTokenMiddleware,
  checkFeatureAccess('TABLE_SERVICE'),
  checkPermission('orders:update'),
  checkTableOwnership('order'),
  orderMobileController.compOrderItem,
)

/**
 * GET /api/v1/mobile/venues/:venueId/end-of-day
 * "Cierre del día": the day's sales by tender + blockers (open checks, open
 * cash drawers, clocked-in staff). Read-only aggregator.
 */
router.get(
  '/venues/:venueId/end-of-day',
  authenticateTokenMiddleware,
  checkPermission('payments:read'),
  cashDrawerMobileController.getEndOfDay,
)

/**
 * GET /api/v1/mobile/venues/:venueId/cash-drawer/tender-breakdown?from=&to=
 * Payments grouped by method for the corte de caja Z-report (card + cash + other).
 */
router.get(
  '/venues/:venueId/cash-drawer/tender-breakdown',
  authenticateTokenMiddleware,
  checkPermission('payments:read'),
  cashDrawerMobileController.getTenderBreakdown,
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
 * Body: { amount: number (cents), reason: string, method, staffName?: string }
 *
 * `method` es cómo se devolvió el dinero DE VERDAD: CASH sale del cajón;
 * CREDIT_CARD/DEBIT_CARD significa que la devolución la hizo la TERMINAL con su
 * propia función —no hay API para eso— y aquí sólo se registra para que la
 * venta deje de contar como cobrada, sin tocar el arqueo.
 */
router.post(
  '/venues/:venueId/refunds',
  authenticateTokenMiddleware,
  checkPermission('payments:create'),
  refundMobileController.createRefund,
)

/**
 * POST /api/v1/mobile/venues/:venueId/payments/:paymentId/refund
 * Issue an associated refund (by amount OR by items, with optional restock).
 * Mobile wrapper that delegates to the shared dashboard refund service.
 */
router.post(
  '/venues/:venueId/payments/:paymentId/refund',
  authenticateTokenMiddleware,
  checkPermission('payments:refund'),
  refundMobileController.issueAssociatedRefund,
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
// 🔴 `estimates:create`, no `orders:create`: cotizar no es tomar comanda. Con el
// permiso de comanda la recepcionista (HOST) llenaba el presupuesto con el cliente
// enfrente y truena al guardar; darle `orders:create` le abriría de golpe líneas,
// cortesías, cargos y separar. `orders:create` implica `estimates:create` (puente), así
// que nadie que ya cotizaba pierde nada.
router.post(
  '/venues/:venueId/estimates',
  authenticateTokenMiddleware,
  checkPermission('estimates:create'),
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
// Enviar, aceptar, rechazar y cancelar son el ciclo de vida del MISMO presupuesto:
// mismo permiso que crearlo.
router.put(
  '/venues/:venueId/estimates/:estimateId/status',
  authenticateTokenMiddleware,
  checkPermission('estimates:create'),
  estimateMobileController.updateStatus,
)

/**
 * POST /api/v1/mobile/venues/:venueId/estimates/:estimateId/convert
 * Convert an accepted estimate to an order.
 */
// 🔴 CONVERTIR pide `estimates:create`, NO `orders:create`. (Antes decía lo contrario
// "a propósito"; la verificación mostró que dejaba al HOST a media función y el
// razonamiento no se sostiene.)
//
// 1. La autoridad YA se gastó antes: el HOST escribe los renglones y los PRECIOS al
//    crear el presupuesto, y lo ACEPTA (mismo permiso). `convertToOrder` no deja
//    escribir nada nuevo — COPIA verbatim lo ya aceptado. El candado estaba en el paso
//    equivocado.
// 2. Square: el permiso de presupuestos es el de facturas, y con Invoices Plus el
//    presupuesto se AUTO-CONVIERTE al aceptarlo el cliente, sin humano en medio. Si
//    convertir fuera frontera de autoridad, no se podría automatizar.
// 3. `orders:create` abre de más: es también el gate de `POST /orders/:orderId/items`
//    (agregar renglones a CUALQUIER cuenta abierta) y arrastra `inventory:read`.
//
// Nadie pierde: `orders:create` implica `estimates:create`. La orden que nace es inerte
// (PENDING/PENDING) y el HOST no puede cobrarla, editarla, descontarla ni anularla.
router.post(
  '/venues/:venueId/estimates/:estimateId/convert',
  authenticateTokenMiddleware,
  checkPermission('estimates:create'),
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
//
// 🔴 Las 4 rutas llevaban SÓLO `requireVenueMembership`: cualquier miembro del
// venue, VIEWER incluido, podía crear comandas, cambiarles el estado y
// BUMPEARLAS — o sea borrar de la pantalla el trabajo de la cocina.
//
// El permiso se elige fail-open PARA LA COCINA, que es la regla de este dominio:
// se toma el más conservador que NO deje fuera a KITCHEN. `orders:update` es el
// que KITCHEN ya trae por default (avanzar comandas es su trabajo) y que también
// tiene el POS que crea la comanda tras el cobro (CASHIER/WAITER/MANAGER+).
// NO se inventa un namespace `kds:*`: habría nacido sin roles y habría apagado
// la cocina el día del deploy. Leer el tablero se queda en `orders:read`, que
// tienen los 9 roles — mirar la pantalla nunca debe requerir escritura.
// ============================================================================

/**
 * GET /api/v1/mobile/venues/:venueId/kds/orders
 * List active KDS orders for a venue.
 * Query: ?status=NEW,PREPARING,READY (default: active orders)
 */
router.get(
  '/venues/:venueId/kds/orders',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('orders:read'),
  kdsMobileController.listKdsOrders,
)

/**
 * POST /api/v1/mobile/venues/:venueId/kds/orders
 * Create a new KDS order (after payment succeeds).
 * Body: { orderNumber, orderType?, orderId?, items: [{ productName, quantity, modifiers?, notes? }] }
 */
router.post(
  '/venues/:venueId/kds/orders',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('orders:update'),
  kdsMobileController.createKdsOrder,
)

/**
 * Reclamar / confirmar / soltar la impresión de una comanda que llegó sola.
 *
 * Permiso `orders:update`, el MISMO que ya pide crear y avanzar una comanda: quien puede
 * mover el tablero puede imprimirlo. Inventar un permiso nuevo aquí dejaría el papel sin
 * salir para todos hasta que alguien se acordara de otorgarlo — y en este dominio el
 * fail-safe no puede ser no imprimir.
 */
router.post(
  '/venues/:venueId/kds/orders/:id/claim-print',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('orders:update'),
  kdsMobileController.claimKdsPrint,
)

router.post(
  '/venues/:venueId/kds/orders/:id/confirm-print',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('orders:update'),
  kdsMobileController.confirmKdsPrinted,
)

router.post(
  '/venues/:venueId/kds/orders/:id/release-print',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('orders:update'),
  kdsMobileController.releaseKdsPrint,
)

/**
 * PUT /api/v1/mobile/venues/:venueId/kds/orders/:id/status
 * Update KDS order status.
 * Body: { status: "PREPARING" | "READY" | "COMPLETED" }
 */
router.put(
  '/venues/:venueId/kds/orders/:id/status',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('orders:update'),
  kdsMobileController.updateKdsOrderStatus,
)

/**
 * POST /api/v1/mobile/venues/:venueId/kds/orders/:id/bump
 * Mark KDS order as COMPLETED instantly.
 */
router.post(
  '/venues/:venueId/kds/orders/:id/bump',
  authenticateTokenMiddleware,
  requireVenueMembership,
  checkPermission('orders:update'),
  kdsMobileController.bumpKdsOrder,
)

// ============================================================================
// PRINT STATIONS (PRINT_STATIONS) — routing config + gateway outbox replica
// Feature gratis/core. print-config lo lee cualquiera que toma/rutea órdenes
// (orders:read); la réplica del outbox la escribe el gateway (orders:update).
// ============================================================================
router.get(
  '/venues/:venueId/print-config',
  authenticateTokenMiddleware,
  checkPermission('orders:read'),
  validateRequest(printConfigParamSchema),
  printMobileController.getPrintConfig,
)
router.post(
  '/venues/:venueId/print-jobs/sync',
  authenticateTokenMiddleware,
  checkPermission('orders:update'),
  validateRequest(syncPrintJobsSchema),
  printMobileController.syncPrintJobs,
)
router.post(
  '/venues/:venueId/print-gateway/heartbeat',
  authenticateTokenMiddleware,
  checkPermission('orders:read'),
  validateRequest(gatewayHeartbeatSchema),
  printMobileController.gatewayHeartbeat,
)

// ============================================================================
// VALES POR ÁREA (AREA_TICKETS) — cuenta compartida entre áreas emisoras
// Contrato CONGELADO §6 del spec 2026-07-28-vales-por-area-y-bascula-design.md.
// Las rutas y sus nombres NO se cambian: Android se implementa contra esto.
//
// 🔴 EL GATE DE PLAN VA SÓLO EN "ABRIR" (§2). `AREA_TICKETS` es PRO (blanket: NO
// va en PREMIUM_ONLY_CODES). Consultar, agregar a un vale YA abierto, reclamar y
// **entregar** quedan SIN gate a propósito: si el plan vence a media mañana, hay
// producto de un cliente guardado en el mostrador y dejarlo secuestrado detrás de
// un paywall sería indefendible. Lo que se corta es abrir vales NUEVOS.
// ============================================================================

/**
 * POST /api/v1/mobile/devices/partition
 * Asigna (o devuelve) la partición del dispositivo. Se llama al iniciar sesión.
 * Sin gate de plan: sin partición el dispositivo no puede ni consultar un vale ya
 * abierto, y el venue puede haber caído de plan con producto en el mostrador.
 */
router.post('/devices/partition', authenticateTokenMiddleware, areaTicketMobileController.assignDevicePartition)

/**
 * POST /api/v1/mobile/venues/:venueId/area-tickets
 * Abre la cuenta con el código ACUÑADO POR EL CLIENTE. Único endpoint con gate.
 */
router.post(
  '/venues/:venueId/area-tickets',
  authenticateTokenMiddleware,
  (req, res, next) => checkPermission(Array.isArray(req.body?.lines) ? 'area-tickets:issue' : 'orders:create')(req, res, next),
  checkFeatureAccess('AREA_TICKETS'),
  (req, res, next) =>
    Array.isArray(req.body?.lines)
      ? areaTicketV7MobileController.issue(req, res, next)
      : areaTicketMobileController.openAreaTicket(req, res, next),
)

// V7 es aditivo: los endpoints legacy de arriba/abajo siguen disponibles para
// apps desplegadas. La forma del body (`lines` vs `items + code`) discrimina la
// emisión sin reinterpretar una petición vieja.
router.get(
  '/venues/:venueId/area-ticket-settings',
  authenticateTokenMiddleware,
  checkPermission('orders:read'),
  areaTicketV7MobileController.getSettings,
)

// 🔴 `SCALE_INTEGRATION` es PREMIUM (basePlan.service.ts) y NADIE lo exigía:
// ni esta ruta, ni iOS, ni Android. El código estaba declarado Premium y la
// báscula funcionaba en cualquier plan — una etiqueta de precio que no cobraba.
//
// El permiso va ANTES del candado de plan, por lo mismo que en upsell-rules:
// al revés, alguien ajeno al local se entera de qué contrata ese negocio antes
// de que se le diga que no pertenece.
router.get(
  '/venues/:venueId/scale-settings',
  authenticateTokenMiddleware,
  checkPermission('scale:use'),
  checkFeatureAccess('SCALE_INTEGRATION'),
  areaTicketV7MobileController.getScaleSettings,
)

router.post(
  '/venues/:venueId/scans/resolve',
  authenticateTokenMiddleware,
  areaTicketResolveRateLimiter,
  checkPermission('orders:read'),
  areaTicketV7MobileController.resolveScan,
)

router.post(
  '/venues/:venueId/area-ticket-checkouts',
  authenticateTokenMiddleware,
  checkPermission('area-tickets:checkout'),
  checkFeatureAccess('AREA_TICKETS'),
  areaTicketV7MobileController.createCheckout,
)

router.post(
  '/venues/:venueId/area-ticket-checkouts/:sessionId/tickets',
  authenticateTokenMiddleware,
  checkPermission('area-tickets:checkout'),
  areaTicketV7MobileController.addTicket,
)

router.delete(
  '/venues/:venueId/area-ticket-checkouts/:sessionId/tickets/:ticketId',
  authenticateTokenMiddleware,
  checkPermission('area-tickets:checkout'),
  areaTicketV7MobileController.removeTicket,
)

router.post(
  '/venues/:venueId/area-ticket-checkouts/:sessionId/materialize-order',
  authenticateTokenMiddleware,
  checkPermission('area-tickets:checkout'),
  areaTicketV7MobileController.materialize,
)

router.post(
  '/venues/:venueId/area-ticket-checkouts/:sessionId/heartbeat',
  authenticateTokenMiddleware,
  checkPermission('area-tickets:checkout'),
  areaTicketV7MobileController.heartbeat,
)

router.post(
  '/venues/:venueId/area-ticket-checkouts/:sessionId/prepare-payment',
  authenticateTokenMiddleware,
  checkPermission('area-tickets:checkout'),
  checkPermission('payments:create'),
  areaTicketV7MobileController.preparePayment,
)

router.get(
  '/venues/:venueId/area-ticket-checkouts/:sessionId/payment-attempts/:attemptId',
  authenticateTokenMiddleware,
  checkPermission('area-tickets:checkout'),
  checkPermission('payments:read'),
  areaTicketV7MobileController.getPaymentAttempt,
)

router.post(
  '/venues/:venueId/area-ticket-checkouts/:sessionId/cancel',
  authenticateTokenMiddleware,
  checkPermission('area-tickets:cancel'),
  areaTicketV7MobileController.cancelCheckout,
)

router.get(
  '/venues/:venueId/area-ticket-checkouts/:sessionId',
  authenticateTokenMiddleware,
  checkPermission('area-tickets:checkout'),
  areaTicketV7MobileController.getCheckout,
)

router.post(
  '/venues/:venueId/area-tickets/:ticketId/print-attempts',
  authenticateTokenMiddleware,
  checkPermission('area-tickets:issue'),
  areaTicketV7MobileController.recordPrintAttempt,
)

router.get(
  '/venues/:venueId/area-ticket-fulfillment/pending',
  authenticateTokenMiddleware,
  checkPermission('area-tickets:deliver'),
  areaTicketV7MobileController.pendingFulfillment,
)

router.post(
  '/venues/:venueId/area-ticket-fulfillment/resolve',
  authenticateTokenMiddleware,
  areaTicketResolveRateLimiter,
  checkPermission('area-tickets:deliver'),
  areaTicketV7MobileController.resolveFulfillment,
)

router.post(
  '/venues/:venueId/area-tickets/:ticketId/fulfill',
  authenticateTokenMiddleware,
  checkPermission('area-tickets:deliver'),
  areaTicketV7MobileController.fulfill,
)

// ─── COBRO EXTERNO (settlementRoute EXTERNAL) — Task 11 de
// "caja externa fase 1": la puerta HTTP de lo que ya construyeron las Tasks
// 6-9 en `areaTicketExternal.mobile.service.ts`. `handoff` y la cola comparten
// el permiso de emitir (`area-tickets:issue`, trabajo de piso — kitchen/waiter
// también lo tienen); `confirm` y `not-charged` exigen
// `area-tickets:confirm-external` (MANAGER+ — es una afirmación sobre dinero
// que Avoqado nunca vio, no una tarea de piso).
//
// Sin `checkFeatureAccess('AREA_TICKETS')` en ninguna de las cuatro: mismo
// criterio que ya explica el comentario de arriba para checkout/cancel/deliver
// — un vale YA emitido es un compromiso vigente, no una apertura nueva. El
// propio servicio (`markExternalHandoff`) deja explícito por qué NO llama a
// `assertAreaTicketsEnabled`.
router.post(
  '/venues/:venueId/area-tickets/:ticketId/external-settlement/handoff',
  authenticateTokenMiddleware,
  checkPermission('area-tickets:issue'),
  validateRequest(handoffSchema),
  areaTicketExternalMobileController.handoff,
)

router.post(
  '/venues/:venueId/area-tickets/:ticketId/external-settlement/confirm',
  authenticateTokenMiddleware,
  checkPermission('area-tickets:confirm-external'),
  validateRequest(confirmExternalSettlementSchema),
  areaTicketExternalMobileController.confirm,
)

router.post(
  '/venues/:venueId/area-tickets/:ticketId/external-settlement/not-charged',
  authenticateTokenMiddleware,
  checkPermission('area-tickets:confirm-external'),
  validateRequest(notChargedSchema),
  areaTicketExternalMobileController.notCharged,
)

// 🔴 DEBE ir antes de `GET /area-tickets/:code` (justo abajo): mismo verbo y
// misma forma de ruta (2 segmentos bajo `area-tickets/`), y Express resuelve
// por ORDEN DE REGISTRO, no por especificidad — un segmento `:code` hace match
// de CUALQUIER string, incluida la palabra literal "pending-confirmation". Se
// verificó empíricamente en el RED de esta tarea: con este bloque después de
// `:code`, la petición caía en `resolveAreaTicket` (que por diseño responde
// SIEMPRE 200 con `state: NOT_FOUND` en vez de un 404) y el 200 salía por la
// razón equivocada — nunca llegaba a este controlador.
router.get(
  '/venues/:venueId/area-tickets/pending-confirmation',
  authenticateTokenMiddleware,
  checkPermission('area-tickets:issue'),
  areaTicketExternalMobileController.listPendingConfirmation,
)

/**
 * GET /api/v1/mobile/venues/:venueId/area-tickets/:code
 * Resuelve el vale. SIEMPRE 200 con `state` (OPEN | CHECKOUT_CLAIMED | ALREADY_PAID
 * | DELIVERED | CANCELLED | NOT_FOUND) y `message` en español — nunca un 404 mudo.
 * Con límite de tasa: el verificador mod-10 es público y no es seguridad (§5.1).
 */
router.get(
  '/venues/:venueId/area-tickets/:code',
  authenticateTokenMiddleware,
  areaTicketResolveRateLimiter,
  checkPermission('orders:read'),
  areaTicketMobileController.resolveAreaTicket,
)

/**
 * POST /api/v1/mobile/venues/:venueId/area-tickets/:code/items
 * Agrega renglones (área o caja). El server pone el área desde
 * `Terminal.fulfillmentAreaId`, NUNCA desde el payload.
 */
router.post(
  '/venues/:venueId/area-tickets/:code/items',
  authenticateTokenMiddleware,
  checkPermission('orders:update'),
  areaTicketMobileController.addAreaTicketItems,
)

/**
 * POST /api/v1/mobile/venues/:venueId/area-tickets/:code/claim
 * La caja reclama la cuenta (CHECKOUT_CLAIMED). Caduca sola a los 5 minutos.
 */
router.post(
  '/venues/:venueId/area-tickets/:code/claim',
  authenticateTokenMiddleware,
  checkPermission('orders:update'),
  areaTicketMobileController.claimAreaTicket,
)

/**
 * POST /api/v1/mobile/orders/:id/fulfill
 * Entrega de TODOS los renglones de un área. Idempotente; exige PAID.
 */
router.post(
  '/orders/:id/fulfill',
  authenticateTokenMiddleware,
  checkPermission('orders:update'),
  areaTicketMobileController.fulfillOrderArea,
)

/**
 * GET /api/v1/mobile/venues/:venueId/fulfillment/pending
 * Vales PAGADOS y NO ENTREGADOS del área de esta terminal (o de `?fulfillmentAreaId`).
 */
router.get(
  '/venues/:venueId/fulfillment/pending',
  authenticateTokenMiddleware,
  checkPermission('orders:read'),
  areaTicketMobileController.listPendingFulfillment,
)

// ─────────────────────────────────────────────────────────────────────────────
// Fase 8 del kiosco — "Mi clase ahora"
//
// El permiso es el más estrecho del catálogo a propósito: quien da la clase ve SU clase
// y nada más. `reservations:read` abriría la agenda entera del negocio.
// ─────────────────────────────────────────────────────────────────────────────
// Respaldo del kiosco: "no aparezco en la lista". El kiosco vive dentro de esta app y usa
// la sesión que ya tiene (la credencial de aparato es la Fase 3, que el founder sacó del
// piloto), así que entra por el espacio móvil y no por el de terminales.
// Compra en el kiosco: catálogo y enlace de pago para el QR. Sin PIN de empleado a
// propósito (decisión del founder) — lo que lo hace seguro es que el precio sale del
// catálogo y el cliente paga con SU tarjeta en SU teléfono, no que se pida un PIN.
router.get('/venues/:venueId/kiosk/packs', authenticateTokenMiddleware, kioskCheckInController.kioskPacks)
router.post('/venues/:venueId/kiosk/pack-checkout', authenticateTokenMiddleware, kioskCheckInController.kioskPackCheckout)

router.post(
  '/venues/:venueId/kiosk/check-in',
  authenticateTokenMiddleware,
  checkPermission('reservations:update'),
  kioskCheckInController.checkInByCode,
)

router.get(
  '/venues/:venueId/my-class-now',
  authenticateTokenMiddleware,
  checkPermission('class-sessions:read-assigned'),
  coachClassController.myClassNow,
)

export default router
