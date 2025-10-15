import { Router } from 'express'
import * as providerCostStructureController from '../../controllers/superadmin/providerCostStructure.controller'

const router = Router()

/**
 * ProviderCostStructure Routes
 * Base path: /api/v1/superadmin/provider-cost-structures
 *
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 */

// GET /api/v1/superadmin/provider-cost-structures
// Query params: ?merchantAccountId=xxx&includeInactive=true
router.get('/', providerCostStructureController.getProviderCostStructures)

// GET /api/v1/superadmin/provider-cost-structures/active/:merchantAccountId
// Get the currently active cost structure for a merchant account
router.get('/active/:merchantAccountId', providerCostStructureController.getActiveCostStructure)

// GET /api/v1/superadmin/provider-cost-structures/:id
router.get('/:id', providerCostStructureController.getProviderCostStructure)

// POST /api/v1/superadmin/provider-cost-structures
router.post('/', providerCostStructureController.createProviderCostStructure)

// POST /api/v1/superadmin/provider-cost-structures/flat-rate
// Helper endpoint for creating flat-rate cost structures
router.post('/flat-rate', providerCostStructureController.createFlatRateCostStructure)

// PUT /api/v1/superadmin/provider-cost-structures/:id
router.put('/:id', providerCostStructureController.updateProviderCostStructure)

// PATCH /api/v1/superadmin/provider-cost-structures/:id/deactivate
router.patch('/:id/deactivate', providerCostStructureController.deactivateCostStructure)

// DELETE /api/v1/superadmin/provider-cost-structures/:id
router.delete('/:id', providerCostStructureController.deleteProviderCostStructure)

export default router
