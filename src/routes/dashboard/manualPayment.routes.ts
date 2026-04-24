/**
 * Manual Payment Routes (Dashboard)
 *
 * Base path: /api/v1/dashboard/venues/:venueId/payments
 *
 * Authentication is enforced at mount time in `dashboard.routes.ts` via
 * `authenticateTokenMiddleware`. Permission gating is applied per-route.
 *
 * @module routes/dashboard/manualPayment
 */

import { Router } from 'express'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as manualPaymentController from '../../controllers/dashboard/manualPayment.controller'
import { createManualPaymentSchema, getExternalSourcesSchema } from '../../schemas/dashboard/manualPayment.schema'

const router = Router({ mergeParams: true })

/**
 * POST /api/v1/dashboard/venues/:venueId/payments/manual
 * Records a manual payment that was received outside Avoqado (cash, external terminal, transfer, etc.).
 * Restricted to staff with `payment:create-manual` (SUPERADMIN / OWNER / ADMIN by default).
 */
router.post(
  '/manual',
  checkPermission('payment:create-manual'),
  validateRequest(createManualPaymentSchema),
  manualPaymentController.createManualPayment,
)

/**
 * GET /api/v1/dashboard/venues/:venueId/payments/external-sources
 * Returns recently-used external payment source labels for autocomplete.
 */
router.get(
  '/external-sources',
  checkPermission('payment:create-manual'),
  validateRequest(getExternalSourcesSchema),
  manualPaymentController.getExternalSources,
)

/**
 * GET /api/v1/dashboard/venues/:venueId/payments/waiters
 * Lists active staff eligible to be attributed as the waiter (tip + commission
 * credit) on a manual payment. Gated by the same permission as creation.
 */
router.get(
  '/waiters',
  checkPermission('payment:create-manual'),
  manualPaymentController.getEligibleWaiters,
)

export default router
