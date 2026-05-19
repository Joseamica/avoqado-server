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

// Multi-account-aware (2026-05-18): returns the FULL list of AngelPay user
// accounts for a venue, oldest-first. Always an array (possibly empty).
// Used by the dashboard onboarding wizard when a venue has more than one
// AngelPay login.
router.get('/venues/:venueId/angelpay-accounts', angelpayController.listAngelPayUserAccountsForVenue)

// Dispatch FETCH_ANGELPAY_MERCHANTS socket command — TPV re-authenticates
// the AngelPay SDK and reports discovered merchants to backend. Body may
// include `terminalId` (defaults to first ACTIVE NEXGO in venue) and
// `angelpayUserAccountId` (target specific AngelPay login for multi-account
// venues). Returns 202 + commandId; dashboard polls discovered-merchants
// endpoint for ~30s afterwards.
router.post('/venues/:venueId/angelpay-fetch-merchants', angelpayController.dispatchFetchAngelPayMerchantsForVenue)

// Option B closure — approve auto-discovered merchant AND assign it to a
// VenuePaymentConfig slot atomically (default slot=PRIMARY).
router.post(
  '/venues/:venueId/angelpay-merchants/:merchantAccountId/approve',
  angelpayController.approveAngelPayDiscoveredMerchantController,
)

// Placeholder reservation — admin reserves a slot for an AngelPay merchant
// BEFORE the real Merchant ID is known (those come from AngelPay/TPV). The
// placeholder gets upgraded with real IDs when the TPV reports discovery.
router.post('/venues/:venueId/angelpay-reserve-slot', angelpayController.reserveAngelPaySlotController)

// Id-scoped — operator acts on an existing account row
router.patch('/angelpay-accounts/:id/credentials', angelpayController.updateAngelPayUserAccountCredentialsController)
router.patch('/angelpay-accounts/:id/pin', angelpayController.setAngelPayUserAccountPinController)
router.patch('/angelpay-accounts/:id/status', angelpayController.updateAngelPayUserAccountStatusController)
router.delete('/angelpay-accounts/:id', angelpayController.deleteAngelPayUserAccountController)

export default router
