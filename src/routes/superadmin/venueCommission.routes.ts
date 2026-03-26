import { Router } from 'express'
import * as venueCommissionController from '../../controllers/superadmin/venueCommission.controller'

const router = Router()

/**
 * VenueCommission Routes
 * Base path: /api/v1/superadmin/venue-commissions
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 */

router.get('/', venueCommissionController.getVenueCommissions)
router.get('/:id', venueCommissionController.getVenueCommissionById)
router.post('/', venueCommissionController.createVenueCommission)
router.put('/:id', venueCommissionController.updateVenueCommission)
router.delete('/:id', venueCommissionController.deleteVenueCommission)

export default router
