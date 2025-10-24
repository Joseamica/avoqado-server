/**
 * Webhook Routes
 *
 * Public webhook endpoints (no authentication)
 * Stripe webhooks use signature verification instead of JWT
 */

import { Router } from 'express'
import { handleStripeWebhook } from '../controllers/webhook.controller'

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

export default router
