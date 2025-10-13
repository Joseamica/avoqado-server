import { Router } from 'express'
import * as venuePaymentConfigController from '../../controllers/venuePaymentConfig.controller'

const router = Router({ mergeParams: true })

// Payment configuration routes
router.get('/', venuePaymentConfigController.getVenuePaymentConfig)
router.post('/', venuePaymentConfigController.createVenuePaymentConfig)
router.put('/:configId', venuePaymentConfigController.updateVenuePaymentConfig)
router.delete('/:configId', venuePaymentConfigController.deleteVenuePaymentConfig)

// Merchant accounts for this venue
router.get('/merchant-accounts', venuePaymentConfigController.getVenueMerchantAccounts)

// Pricing structures for this venue
router.get('/pricing-structures', venuePaymentConfigController.getVenuePricingStructures)

// Cost structures for this venue's merchant accounts
router.get('/cost-structures', venuePaymentConfigController.getVenueCostStructures)

export default router
