/**
 * Webhook Routes
 *
 * Public webhook endpoints (no authentication)
 * - Stripe webhooks use signature verification instead of JWT
 * - Blumon webhooks are verified by IP/membership (configured in Blumon dashboard)
 */

import { Router } from 'express'
import { handleStripeWebhook } from '../controllers/webhook.controller'
import { handleBlumonTPVWebhook, blumonWebhookHealthCheck } from '../controllers/tpv/blumon-webhook.tpv.controller'
import { handleB4BitWebhook, b4bitWebhookHealthCheck } from '../controllers/tpv/b4bit-webhook.tpv.controller'
import { blumonIPWhitelist } from '../middlewares/blumon-ip-whitelist.middleware'

const router = Router()

/**
 * @openapi
 * /api/v1/webhooks/stripe:
 *   post:
 *     tags: [Webhooks]
 *     summary: Stripe webhook endpoint
 *     description: |
 *       Receives and processes Stripe webhook events.
 *       This endpoint validates Stripe signature and updates database based on events.
 *
 *       **Handled Events:**
 *       - customer.subscription.updated - Trial → paid, status changes
 *       - customer.subscription.deleted - Subscription canceled
 *       - invoice.payment_succeeded - Payment successful
 *       - invoice.payment_failed - Payment failed
 *       - customer.subscription.trial_will_end - Trial ending reminder
 *
 *       **IMPORTANT:** This endpoint requires raw body (not JSON parsed) for signature verification.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Stripe Event object (signature verified)
 *     responses:
 *       200:
 *         description: Webhook received and processed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 eventId: { type: string }
 *                 eventType: { type: string }
 *       400:
 *         description: Invalid signature or missing headers
 *       500:
 *         description: Webhook secret not configured
 */
router.post('/stripe', handleStripeWebhook)

/**
 * @openapi
 * /api/v1/webhooks/blumon/tpv:
 *   post:
 *     tags: [Webhooks]
 *     summary: Blumon TPV payment confirmation webhook
 *     description: |
 *       Receives payment confirmations from Blumon after transactions are processed on PAX terminals.
 *
 *       **Layer 4 of 4-layer payment reconciliation strategy:**
 *       1. Android SDK → Blumon (direct payment processing)
 *       2. Android → Backend (payment recording)
 *       3. Backend validation (merchantAccountId fallback)
 *       4. Blumon webhook (independent confirmation) ← THIS ENDPOINT
 *
 *       **Use Cases:**
 *       - Reconcile payments that Android failed to record
 *       - Verify amounts match between Blumon and our records
 *       - Detect discrepancies for investigation
 *
 *       **Response Actions:**
 *       - MATCHED: Payment found and amounts verified
 *       - RECONCILED: Payment found but was missing confirmation
 *       - DISCREPANCY: Payment found but amounts don't match
 *       - NOT_FOUND: Payment not in database (requires manual reconciliation)
 *       - ERROR: Processing error occurred
 *
 *       **Configuration:** Provide this URL to Edgardo at Blumon
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *               - reference
 *               - operationNumber
 *               - codeResponse
 *               - descriptionResponse
 *               - operationType
 *             properties:
 *               bin: { type: string, description: "Card BIN (first 6 digits)" }
 *               lastFour: { type: string, description: "Card last 4 digits" }
 *               cardType: { type: string, enum: [DEBITO, CREDITO], description: "Card type" }
 *               brand: { type: string, enum: [VISA, MASTERCARD, AMERICAN_EXPRESS], description: "Card brand" }
 *               bank: { type: string, description: "Issuing bank (e.g., BANORTE)" }
 *               amount: { type: string, description: "Transaction amount (string format)" }
 *               reference: { type: string, description: "Transaction reference" }
 *               cardHolder: { type: string, description: "Cardholder name (PCI sensitive)" }
 *               authorizationCode: { type: string, description: "Bank authorization code" }
 *               operationType: { type: string, enum: [VENTA, DEVOLUCION], description: "Operation type" }
 *               operationNumber: { type: number, description: "Blumon operation ID" }
 *               descriptionResponse: { type: string, description: "Response description (e.g., APROBADA)" }
 *               dateTransaction: { type: string, description: "Format: DD/MM/YYYY HH:mm:ss" }
 *               authentication: { type: string, description: "3DS status" }
 *               membership: { type: string, description: "Blumon membership ID" }
 *               provideResponse: { type: string, description: "Provider response code (SB = sandbox)" }
 *               codeResponse: { type: string, description: "Response code (00 = approved)" }
 *     responses:
 *       200:
 *         description: Webhook processed (always returns 200 to prevent retries)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 action: { type: string, enum: [MATCHED, RECONCILED, DISCREPANCY, NOT_FOUND, ERROR] }
 *                 message: { type: string }
 *                 paymentId: { type: string }
 *                 details:
 *                   type: object
 *                   properties:
 *                     blumonAmount: { type: number }
 *                     recordedAmount: { type: number }
 *                     difference: { type: number }
 *       400:
 *         description: Invalid payload structure
 */
router.post('/blumon/tpv', blumonIPWhitelist, handleBlumonTPVWebhook)

/**
 * @openapi
 * /api/v1/webhooks/blumon/tpv/health:
 *   get:
 *     tags: [Webhooks]
 *     summary: Blumon webhook health check
 *     description: Endpoint for Blumon to verify webhook connectivity
 *     responses:
 *       200:
 *         description: Webhook endpoint is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 timestamp: { type: string }
 *                 version: { type: string }
 */
router.get('/blumon/tpv/health', blumonWebhookHealthCheck)

/**
 * @openapi
 * /api/v1/webhooks/b4bit:
 *   post:
 *     tags: [Webhooks]
 *     summary: B4Bit crypto payment confirmation webhook
 *     description: |
 *       Receives payment status updates from B4Bit crypto payment gateway.
 *
 *       **Status Codes:**
 *       - PE: Pending - Waiting for payment
 *       - AC: Awaiting Completion - Payment detected, waiting for confirmations
 *       - CO: Completed - Payment confirmed
 *       - OC: Out of Condition - Insufficient amount or other issue
 *       - EX: Expired - Order timed out without payment
 *
 *       **Security:**
 *       - Verifies HMAC-SHA256 signature in X-SIGNATURE header
 *       - Checks timestamp freshness in X-NONCE header (max 20s)
 *
 *       **Actions:**
 *       - On CO: Marks payment as COMPLETED, emits Socket.IO event to TPV
 *       - On EX/OC: Marks payment as FAILED, emits failure event
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - identifier
 *               - status
 *             properties:
 *               identifier:
 *                 type: string
 *                 description: Our payment ID (passed as reference to B4Bit)
 *               request_id:
 *                 type: string
 *                 description: B4Bit request ID
 *               fiat_amount:
 *                 type: number
 *                 description: Amount in fiat currency
 *               fiat_currency:
 *                 type: string
 *                 example: "MXN"
 *               crypto_amount:
 *                 type: string
 *                 description: Amount paid in crypto
 *               currency:
 *                 type: string
 *                 description: Crypto currency (BTC, ETH, etc.)
 *               status:
 *                 type: string
 *                 enum: [PE, AC, CO, OC, EX]
 *               tx_hash:
 *                 type: string
 *                 description: Blockchain transaction hash (on confirmation)
 *               confirmations:
 *                 type: integer
 *                 description: Number of blockchain confirmations
 *     responses:
 *       200:
 *         description: Webhook processed (always returns 200 to prevent retries)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 action:
 *                   type: string
 *                   enum: [CONFIRMED, AWAITING_CONFIRMATION, FAILED, EXPIRED, NOT_FOUND, ERROR]
 *                 message:
 *                   type: string
 *                 paymentId:
 *                   type: string
 */
router.post('/b4bit', handleB4BitWebhook)

/**
 * @openapi
 * /api/v1/webhooks/b4bit/health:
 *   get:
 *     tags: [Webhooks]
 *     summary: B4Bit webhook health check
 *     description: Endpoint for B4Bit to verify webhook connectivity
 *     responses:
 *       200:
 *         description: Webhook endpoint is healthy
 */
router.get('/b4bit/health', b4bitWebhookHealthCheck)

export default router
