import { Router } from 'express'
import * as earningsController from '../../controllers/superadmin/earnings.controller'

const router = Router()

// Base path: /api/v1/superadmin/earnings  (SUPERADMIN guard inherited from parent router)
router.get('/summary', earningsController.getEarningsSummary)
router.get('/time-series', earningsController.getEarningsTimeSeries)

export default router
