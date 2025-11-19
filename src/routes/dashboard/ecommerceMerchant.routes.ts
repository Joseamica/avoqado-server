/**
 * E-commerce Merchant Routes (Dashboard)
 *
 * Base path: /api/v1/dashboard/venues/:venueId/ecommerce-merchants
 *
 * All routes require authentication (enforced by parent router).
 * Permission requirements vary by endpoint (see comments below).
 *
 * @module routes/dashboard/ecommerceMerchant
 */

import { Router } from 'express'
import { validateRequest } from '@/middlewares/validation'
import * as ecommerceMerchantController from '@/controllers/dashboard/ecommerceMerchant.controller'
import {
  listVenueEcommerceMerchantsSchema,
  getEcommerceMerchantSchema,
  createEcommerceMerchantWithVenueSchema,
  updateEcommerceMerchantWithVenueSchema,
  toggleEcommerceMerchantWithVenueSchema,
  regenerateKeysWithVenueSchema,
} from '@/schemas/dashboard/ecommerceMerchant.schema'

const router = Router({ mergeParams: true }) // mergeParams: true to access :venueId from parent

// ═══════════════════════════════════════════════════════════════════════════
// LIST & GET
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/dashboard/venues/:venueId/ecommerce-merchants
 * Lists e-commerce merchants for a venue
 *
 * Query params:
 * - active: boolean (optional)
 * - sandboxMode: boolean (optional)
 * - providerId: string (optional)
 * - limit: number (optional, default 20)
 * - offset: number (optional, default 0)
 *
 * Permission: venue:read or owner/admin of venue
 */
router.get('/', validateRequest(listVenueEcommerceMerchantsSchema), ecommerceMerchantController.listEcommerceMerchants)

/**
 * GET /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id
 * Gets a single e-commerce merchant by ID
 *
 * Permission: venue:read or owner/admin of venue
 */
router.get('/:id', validateRequest(getEcommerceMerchantSchema), ecommerceMerchantController.getEcommerceMerchant)

// ═══════════════════════════════════════════════════════════════════════════
// CREATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/dashboard/venues/:venueId/ecommerce-merchants
 * Creates a new e-commerce merchant
 *
 * ⚠️ IMPORTANT: Response includes secret key (sk_live_xxx or sk_test_xxx)
 * This is the ONLY time the client will see the secret key!
 *
 * Permission: venue:manage or owner/admin of venue
 */
router.post('/', validateRequest(createEcommerceMerchantWithVenueSchema), ecommerceMerchantController.createEcommerceMerchant)

// ═══════════════════════════════════════════════════════════════════════════
// UPDATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * PUT /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id
 * Updates an e-commerce merchant
 *
 * Permission: venue:manage or owner/admin of venue
 */
router.put('/:id', validateRequest(updateEcommerceMerchantWithVenueSchema), ecommerceMerchantController.updateEcommerceMerchant)

/**
 * PATCH /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id/toggle
 * Toggles e-commerce merchant active status
 *
 * Permission: venue:manage or owner/admin of venue
 */
router.patch(
  '/:id/toggle',
  validateRequest(toggleEcommerceMerchantWithVenueSchema),
  ecommerceMerchantController.toggleEcommerceMerchantStatus,
)

// ═══════════════════════════════════════════════════════════════════════════
// API KEYS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id/keys
 * Gets API keys for an e-commerce merchant
 *
 * Note: Secret key is masked (sk_live_••••••••)
 * Only shows full secret key on creation or regeneration.
 *
 * Permission: venue:read or owner/admin of venue
 */
router.get('/:id/keys', validateRequest(getEcommerceMerchantSchema), ecommerceMerchantController.getAPIKeys)

/**
 * POST /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id/regenerate-keys
 * Regenerates API keys for an e-commerce merchant
 *
 * ⚠️ WARNING: This invalidates old keys!
 * All existing integrations will break until they update to new keys.
 *
 * Permission: venue:manage or owner/admin of venue
 */
router.post('/:id/regenerate-keys', validateRequest(regenerateKeysWithVenueSchema), ecommerceMerchantController.regenerateAPIKeys)

// ═══════════════════════════════════════════════════════════════════════════
// DELETE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id
 * Deletes an e-commerce merchant
 *
 * ⚠️ CASCADE: Also deletes all checkout sessions
 *
 * Permission: venue:manage or owner/admin of venue
 */
router.delete('/:id', validateRequest(getEcommerceMerchantSchema), ecommerceMerchantController.deleteEcommerceMerchant)

export default router
