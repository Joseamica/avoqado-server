/**
 * SDK Routes Index
 *
 * Main router for Avoqado Payment SDK endpoints.
 * Direct charge flow: checkout sessions + card tokenization + payment authorization.
 *
 * @module routes/sdk
 */

import express from 'express'
import checkoutRoutes from './sdk/checkout.sdk.routes'
import tokenizeRoutes from './sdk/tokenize.sdk.routes'
import sessionDashboardRoutes from './sdk/session-dashboard.sdk.routes'

const router = express.Router()

// Checkout endpoints (requires API key authentication)
router.use('/checkout', checkoutRoutes)

// Tokenization endpoints (card tokenization and payment processing)
// Rate-limited: 10 requests/minute per IP
router.use('/', tokenizeRoutes)

// Session Dashboard (development only)
router.use('/dashboard', sessionDashboardRoutes)

export default router
