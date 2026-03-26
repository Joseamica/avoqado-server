import { Router } from 'express'
import * as aggregatorController from '../../controllers/superadmin/aggregator.controller'

const router = Router()

/**
 * Aggregator Routes
 * Base path: /api/v1/superadmin/aggregators
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 */

router.get('/', aggregatorController.getAggregators)
router.get('/:id', aggregatorController.getAggregatorById)
router.post('/', aggregatorController.createAggregator)
router.put('/:id', aggregatorController.updateAggregator)
router.patch('/:id/toggle', aggregatorController.toggleAggregator)

export default router
