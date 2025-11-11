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

// GET /api/v1/superadmin/merchant-accounts/:id
// Query params: ?includeCredentials=true (optional, defaults to false)
router.get('/:id', merchantAccountController.getMerchantAccount)

// GET /api/v1/superadmin/merchant-accounts/:id/credentials
// SECURITY: Only use when needed for payment processing setup
router.get('/:id/credentials', merchantAccountController.getMerchantAccountCredentials)

// POST /api/v1/superadmin/merchant-accounts
router.post('/', merchantAccountController.createMerchantAccount)

// POST /api/v1/superadmin/merchant-accounts/blumon/register
// Specialized endpoint for Blumon merchant registration with auto-config
router.post('/blumon/register', merchantAccountController.registerBlumonMerchant)

// POST /api/v1/superadmin/merchant-accounts/blumon/auto-fetch
// Auto-fetch Blumon credentials via device OAuth flow (serial + brand + model)
router.post('/blumon/auto-fetch', merchantAccountController.autoFetchBlumonCredentials)

// PUT /api/v1/superadmin/merchant-accounts/:id
router.put('/:id', merchantAccountController.updateMerchantAccount)

// PATCH /api/v1/superadmin/merchant-accounts/:id/toggle
router.patch('/:id/toggle', merchantAccountController.toggleMerchantAccountStatus)

// DELETE /api/v1/superadmin/merchant-accounts/:id
router.delete('/:id', merchantAccountController.deleteMerchantAccount)

export default router
