import { Router } from 'express'
import * as settlementConfigController from '../../controllers/superadmin/settlementConfiguration.controller'

const router = Router()

/**
 * SettlementConfiguration Routes
 * Base path: /api/v1/superadmin/settlement-configurations
 *
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 */

// GET /api/v1/superadmin/settlement-configurations
// Query params: ?merchantAccountId=xxx&cardType=DEBIT&includeExpired=true
router.get('/', settlementConfigController.getSettlementConfigurations)

// GET /api/v1/superadmin/settlement-configurations/active/:merchantAccountId/:cardType
// Get the currently active configuration for a merchant account and card type
router.get('/active/:merchantAccountId/:cardType', settlementConfigController.getActiveConfiguration)

// GET /api/v1/superadmin/settlement-configurations/:id
router.get('/:id', settlementConfigController.getSettlementConfiguration)

// POST /api/v1/superadmin/settlement-configurations
// Create a new settlement configuration
router.post('/', settlementConfigController.createSettlementConfiguration)

// POST /api/v1/superadmin/settlement-configurations/bulk
// Bulk create settlement configurations for a merchant account
router.post('/bulk', settlementConfigController.bulkCreateSettlementConfigurations)

// PUT /api/v1/superadmin/settlement-configurations/:id
// Update a settlement configuration
router.put('/:id', settlementConfigController.updateSettlementConfiguration)

// DELETE /api/v1/superadmin/settlement-configurations/:id
// Delete a settlement configuration
router.delete('/:id', settlementConfigController.deleteSettlementConfiguration)

export default router
