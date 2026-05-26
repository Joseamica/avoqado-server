import { Router } from 'express'
import * as ctrl from '../../controllers/superadmin/rateCorrection.controller'

const router = Router()
// Base path: /api/v1/superadmin/rate-corrections (SUPERADMIN enforced by parent router)
router.get('/', ctrl.list)
router.post('/venues/:venueId/preview', ctrl.preview)
router.post('/venues/:venueId/apply', ctrl.apply)
router.post('/:batchId/reverse', ctrl.reverse)

export default router
