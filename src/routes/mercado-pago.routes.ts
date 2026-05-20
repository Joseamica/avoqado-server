/**
 * Mercado Pago — OAuth + connection routes.
 *
 * Mounted at `/api/v1/integrations/mercadopago` in `src/routes/index.ts`.
 *
 *   GET    /oauth/connect                                                — auth required, redirects to MP authorize page
 *   GET    /oauth/callback                                               — UNAUTHENTICATED, MP's redirect target
 *   DELETE /venues/:venueId/ecommerce-merchants/:merchantId/oauth        — auth required, disconnects MP
 *
 * The callback route is intentionally NOT authenticated — MP's top-level
 * redirect lands cookieless (third-party context), and we use a signed `state`
 * JWT instead. Do not add auth middleware to that route.
 */
import { Router } from 'express'

import { initiate, callback, disconnect } from '@/controllers/dashboard/mercadoPagoOAuth.controller'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'

const router = Router()

router.get('/oauth/connect', authenticateTokenMiddleware, initiate)

// ⚠️ NO auth middleware — MP's redirect lands without cookies. The state JWT
// (signed at initiate time) carries venueId + ecommerceMerchantId + staffId.
// Defense-in-depth: the controller re-runs the tenant guard.
router.get('/oauth/callback', callback)

router.delete(
  '/venues/:venueId/ecommerce-merchants/:merchantId/oauth',
  authenticateTokenMiddleware,
  disconnect,
)

export default router
