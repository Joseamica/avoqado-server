import { Router } from 'express'
import * as holidaysController from '../../controllers/superadmin/holidays.controller'

const router = Router()

/**
 * Holidays Routes
 * Base path: /api/v1/superadmin/holidays
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 */

// GET /api/v1/superadmin/holidays?year=&country=
router.get('/', holidaysController.getHolidays)

export default router
