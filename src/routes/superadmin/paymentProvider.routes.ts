import { Router } from 'express'
import * as paymentProviderController from '../../controllers/superadmin/paymentProvider.controller'

const router = Router()

/**
 * Payment Provider Routes
 * Base path: /api/v1/superadmin/payment-providers
 *
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 */

// GET /api/v1/superadmin/payment-providers
router.get('/', paymentProviderController.getPaymentProviders)

// GET /api/v1/superadmin/payment-providers/code/:code
router.get('/code/:code', paymentProviderController.getPaymentProviderByCode)

// GET /api/v1/superadmin/payment-providers/:id
router.get('/:id', paymentProviderController.getPaymentProvider)

// POST /api/v1/superadmin/payment-providers
router.post('/', paymentProviderController.createPaymentProvider)

// PUT /api/v1/superadmin/payment-providers/:id
router.put('/:id', paymentProviderController.updatePaymentProvider)

// PATCH /api/v1/superadmin/payment-providers/:id/toggle
router.patch('/:id/toggle', paymentProviderController.togglePaymentProviderStatus)

// DELETE /api/v1/superadmin/payment-providers/:id
router.delete('/:id', paymentProviderController.deletePaymentProvider)

export default router
