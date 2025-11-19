/**
 * SDK Checkout Routes
 *
 * Public API endpoints for e-commerce merchants using Avoqado SDK.
 * Requires API key authentication (public or secret key).
 *
 * @module routes/sdk/checkout
 */

import express from 'express'
import * as checkoutController from '@/controllers/sdk/checkout.sdk.controller'
import { requireAnyKey, requireSecretKey } from '@/middlewares/sdk-auth.middleware'

const router = express.Router()

/**
 * POST /api/v1/sdk/checkout/sessions
 * Create a new checkout session
 * Auth: Public or Secret key
 */
router.post('/sessions', requireAnyKey, checkoutController.createCheckoutSession)

/**
 * GET /api/v1/sdk/checkout/sessions/:sessionId
 * Retrieve a checkout session
 * Auth: Public or Secret key
 */
router.get('/sessions/:sessionId', requireAnyKey, checkoutController.getCheckoutSession)

/**
 * POST /api/v1/sdk/checkout/sessions/:sessionId/cancel
 * Cancel a checkout session
 * Auth: Secret key only (sensitive operation)
 */
router.post('/sessions/:sessionId/cancel', requireSecretKey, checkoutController.cancelCheckoutSession)

/**
 * GET /api/v1/sdk/checkout/sessions
 * List checkout sessions
 * Auth: Secret key only (retrieve all sessions)
 */
router.get('/sessions', requireSecretKey, checkoutController.listCheckoutSessions)

/**
 * GET /api/v1/sdk/checkout/stats
 * Get checkout statistics
 * Auth: Secret key only
 */
router.get('/stats', requireSecretKey, checkoutController.getCheckoutStats)

export default router
