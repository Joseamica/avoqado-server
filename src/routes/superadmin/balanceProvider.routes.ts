import { Router } from 'express'
import * as balanceProviderController from '../../controllers/superadmin/balanceProvider.controller'

const router = Router()

/**
 * BalanceProvider Routes
 * Base path: /api/v1/superadmin/balance-providers
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 *
 * Read-only catalog for now — managed via scripts/seed-balance-providers.ts.
 */

router.get('/', balanceProviderController.getBalanceProviders)

export default router
