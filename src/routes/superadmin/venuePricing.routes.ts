import { Router } from 'express'
import * as venuePricingController from '../../controllers/superadmin/venuePricing.controller'

const router = Router()

/**
 * VenuePricing Routes
 * Base path: /api/v1/superadmin/venue-pricing
 *
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 *
 * This router handles two related resources:
 * 1. Venue Payment Config (payment config)
 * 2. Venue Pricing Structures (structures)
 */

/**
 * ========================================
 * VENUE PAYMENT CONFIG ROUTES
 * ========================================
 */

// GET /api/v1/superadmin/venue-pricing/config/:venueId
router.get('/config/:venueId', venuePricingController.getVenuePaymentConfig)

// GET /api/v1/superadmin/venue-pricing/configs-by-merchant/:merchantAccountId
// Get all venue payment configs that reference a specific merchant account
router.get('/configs-by-merchant/:merchantAccountId', venuePricingController.getVenueConfigsByMerchantAccount)

// POST /api/v1/superadmin/venue-pricing/config
router.post('/config', venuePricingController.createVenuePaymentConfig)

// PUT /api/v1/superadmin/venue-pricing/config/:venueId
router.put('/config/:venueId', venuePricingController.updateVenuePaymentConfig)

// DELETE /api/v1/superadmin/venue-pricing/config/:venueId
router.delete('/config/:venueId', venuePricingController.deleteVenuePaymentConfig)

/**
 * ========================================
 * VENUE PRICING STRUCTURE ROUTES
 * ========================================
 */

// GET /api/v1/superadmin/venue-pricing/structures
// Query params: ?venueId=xxx&accountType=PRIMARY&includeInactive=true
router.get('/structures', venuePricingController.getVenuePricingStructures)

// GET /api/v1/superadmin/venue-pricing/structures/active/:venueId/:accountType
// Get the currently active pricing structure for a venue and account type
router.get('/structures/active/:venueId/:accountType', venuePricingController.getActivePricingStructure)

// GET /api/v1/superadmin/venue-pricing/structures/:id
router.get('/structures/:id', venuePricingController.getVenuePricingStructure)

// POST /api/v1/superadmin/venue-pricing/structures
router.post('/structures', venuePricingController.createVenuePricingStructure)

// POST /api/v1/superadmin/venue-pricing/structures/flat-rate
// Helper endpoint for creating flat-rate pricing structures
router.post('/structures/flat-rate', venuePricingController.createFlatRatePricingStructure)

// PUT /api/v1/superadmin/venue-pricing/structures/:id
router.put('/structures/:id', venuePricingController.updateVenuePricingStructure)

// PATCH /api/v1/superadmin/venue-pricing/structures/:id/deactivate
router.patch('/structures/:id/deactivate', venuePricingController.deactivatePricingStructure)

// DELETE /api/v1/superadmin/venue-pricing/structures/:id
router.delete('/structures/:id', venuePricingController.deleteVenuePricingStructure)

export default router
