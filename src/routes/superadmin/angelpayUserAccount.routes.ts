import { Router } from 'express'
import * as angelpayController from '../../controllers/superadmin/angelpayUserAccount.controller'

/**
 * AngelPayUserAccount routes (Task 15 — Phase 2).
 *
 * Mounted at `/api/v1/superadmin/` (no shared prefix because the venue-scoped
 * GET/POST and the id-scoped PATCH/DELETE live at different URL roots:
 *
 *   /superadmin/venues/:venueId/angelpay-account            (venue-scoped)
 *   /superadmin/angelpay-accounts/:id/...                   (id-scoped)
 *
 * Mounting at root keeps both shapes in one file so superadmin.routes.ts only
 * has to import a single router. Parent middleware already enforces auth +
 * SUPERADMIN role.
 */
const router = Router({ mergeParams: true })

// Venue-scoped — operator opens the venue's AngelPay tab in the dashboard
router.get('/venues/:venueId/angelpay-account', angelpayController.getAngelPayUserAccountForVenue)
router.post('/venues/:venueId/angelpay-account', angelpayController.createAngelPayUserAccountForVenue)

// Option B closure — approve auto-discovered merchant AND assign it to a
// VenuePaymentConfig slot atomically (default slot=PRIMARY).
router.post(
  '/venues/:venueId/angelpay-merchants/:merchantAccountId/approve',
  angelpayController.approveAngelPayDiscoveredMerchantController,
)

// Id-scoped — operator acts on an existing account row
router.patch('/angelpay-accounts/:id/pin', angelpayController.setAngelPayUserAccountPinController)
router.patch('/angelpay-accounts/:id/status', angelpayController.updateAngelPayUserAccountStatusController)
router.delete('/angelpay-accounts/:id', angelpayController.deleteAngelPayUserAccountController)

export default router
