import { Router } from 'express'
import * as settlementCalendarController from '../../controllers/superadmin/settlementCalendar.controller'

const router = Router()

// Base path: /api/v1/superadmin/settlement-calendar
// SUPERADMIN guard inherited from the parent router (superadmin.routes.ts).
// Read-only: no ActivityLog (the audit rule covers mutations, not reads).
router.get('/', settlementCalendarController.getSettlementCalendar)

export default router
