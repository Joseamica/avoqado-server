import { Router } from 'express'
import * as venuePaymentConfigController from '../../controllers/venuePaymentConfig.controller'
import * as venuePaymentReadinessController from '../../controllers/dashboard/venuePaymentReadiness.controller'
import { checkPermission } from '../../middlewares/checkPermission.middleware'

const router = Router({ mergeParams: true })

// Permission model for this router (parent mount applies authenticateToken only):
// - `system:config` (SUPERADMIN) → payment-config mutations + sensitive views.
// - `settlements:read` (ADMIN/OWNER/MANAGER) → read-only settlement views the
//   Sales Summary report needs. `merchant-accounts` strips secrets in the controller.

// Payment readiness check (must be before generic routes)
router.get('/readiness', checkPermission('system:config'), venuePaymentReadinessController.getVenuePaymentReadiness)

// Payment configuration routes (SUPERADMIN — sensitive config + mutations)
router.get('/', checkPermission('system:config'), venuePaymentConfigController.getVenuePaymentConfig)
router.post('/', checkPermission('system:config'), venuePaymentConfigController.createVenuePaymentConfig)
router.put('/:configId', checkPermission('system:config'), venuePaymentConfigController.updateVenuePaymentConfig)
router.delete('/:configId', checkPermission('system:config'), venuePaymentConfigController.deleteVenuePaymentConfig)

// Merchant accounts for this venue — read-only, consumed by the Sales Summary
// report. Secrets are stripped in the controller before responding.
router.get('/merchant-accounts', checkPermission('settlements:read'), venuePaymentConfigController.getVenueMerchantAccounts)

// Pricing structures for this venue (SUPERADMIN)
router.get('/pricing-structures', checkPermission('system:config'), venuePaymentConfigController.getVenuePricingStructures)

// Settlement configuration for this venue's merchant accounts — read-only,
// consumed by the Sales Summary report.
router.get('/settlement-info', checkPermission('settlements:read'), venuePaymentConfigController.getVenueSettlementInfo)

// Cost structures for this venue's merchant accounts (SUPERADMIN)
router.get('/cost-structures', checkPermission('system:config'), venuePaymentConfigController.getVenueCostStructures)

export default router
