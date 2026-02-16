import { Router } from 'express'
import * as merchantAccountController from '../../controllers/superadmin/merchantAccount.controller'

const router = Router()

/**
 * MerchantAccount Routes
 * Base path: /api/v1/superadmin/merchant-accounts
 *
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 */

// GET /api/v1/superadmin/merchant-accounts
// Query params: ?providerId=xxx&active=true
router.get('/', merchantAccountController.getMerchantAccounts)

// GET /api/v1/superadmin/merchant-accounts/mcc-lookup
// Get MCC rate suggestion for a business name
// Query params: ?businessName=xxx (required)
// IMPORTANT: This must be BEFORE /:id route to avoid matching "mcc-lookup" as an id
router.get('/mcc-lookup', merchantAccountController.getMccRateSuggestion)

// GET /api/v1/superadmin/merchant-accounts/:id
// Query params: ?includeCredentials=true (optional, defaults to false)
router.get('/:id', merchantAccountController.getMerchantAccount)

// GET /api/v1/superadmin/merchant-accounts/:id/credentials
// SECURITY: Only use when needed for payment processing setup
router.get('/:id/credentials', merchantAccountController.getMerchantAccountCredentials)

// GET /api/v1/superadmin/merchant-accounts/:id/terminals
// Get terminals that have this merchant account assigned
router.get('/:id/terminals', merchantAccountController.getTerminalsByMerchantAccount)

// DELETE /api/v1/superadmin/merchant-accounts/:id/terminals/:terminalId
// Remove merchant account from a terminal
router.delete('/:id/terminals/:terminalId', merchantAccountController.removeMerchantFromTerminal)

// POST /api/v1/superadmin/merchant-accounts
router.post('/', merchantAccountController.createMerchantAccount)

// POST /api/v1/superadmin/merchant-accounts/with-cost-structure
// Create MerchantAccount and auto-create ProviderCostStructure using MCC lookup
router.post('/with-cost-structure', merchantAccountController.createMerchantAccountWithCostStructure)

// POST /api/v1/superadmin/merchant-accounts/blumon/register
// Specialized endpoint for Blumon merchant registration with auto-config
router.post('/blumon/register', merchantAccountController.registerBlumonMerchant)

// POST /api/v1/superadmin/merchant-accounts/blumon/auto-fetch
// Auto-fetch Blumon credentials via device OAuth flow (serial + brand + model)
router.post('/blumon/auto-fetch', merchantAccountController.autoFetchBlumonCredentials)

// POST /api/v1/superadmin/merchant-accounts/blumon/batch-auto-fetch
// Batch auto-fetch for multiple terminals at once (e.g., 10 terminals to Cancún)
router.post('/blumon/batch-auto-fetch', merchantAccountController.batchAutoFetchBlumonCredentials)

// POST /api/v1/superadmin/merchant-accounts/blumon/full-setup
// Complete wizard setup: auto-fetch → assign terminals → cost structure → payment config → pricing → settlement
router.post('/blumon/full-setup', merchantAccountController.fullSetupBlumonMerchant)

// GET /api/v1/superadmin/merchant-accounts/payment-setup/summary
// Get full payment setup summary for a venue or organization
// Query: ?targetType=venue&targetId=xxx OR ?targetType=organization&targetId=xxx
router.get('/payment-setup/summary', merchantAccountController.getPaymentSetupSummary)

// POST /api/v1/superadmin/merchant-accounts/:id/batch-assign-terminals
// Batch assign terminals to a merchant account
router.post('/:id/batch-assign-terminals', merchantAccountController.batchAssignTerminals)

// PUT /api/v1/superadmin/merchant-accounts/:id
router.put('/:id', merchantAccountController.updateMerchantAccount)

// PATCH /api/v1/superadmin/merchant-accounts/:id/toggle
router.patch('/:id/toggle', merchantAccountController.toggleMerchantAccountStatus)

// DELETE /api/v1/superadmin/merchant-accounts/:id
router.delete('/:id', merchantAccountController.deleteMerchantAccount)

export default router
