import { Router } from 'express'
import * as terminalController from '../../controllers/superadmin/terminal.controller'

const router = Router()

/**
 * Terminal Routes
 * Base path: /api/v1/superadmin/terminals
 *
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 */

// POST /api/v1/superadmin/terminals/:terminalId/merchants
// Assign merchant accounts to a terminal for multi-merchant payment routing
router.post('/:terminalId/merchants', terminalController.assignMerchantsToTerminal)

export default router
