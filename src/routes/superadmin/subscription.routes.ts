import { Router } from 'express'
import { validateRequest } from '@/middlewares/validation'
import { listSubscriptionsSchema, grantTrialSchema, adjustEndDateSchema } from './subscription.schemas'
import * as controller from '@/controllers/superadmin/subscription.controller'

/**
 * PLAN_PRO subscription visibility + management for superadmin. Mounted under
 * `/subscriptions` in superadmin.routes.ts, which already applies
 * authenticateTokenMiddleware + authorizeRole([SUPERADMIN]) globally — no extra
 * guard here.
 *
 *   GET  /api/v1/superadmin/subscriptions/overview
 *   GET  /api/v1/superadmin/subscriptions/venues?state=&q=&page=&pageSize=
 *   POST /api/v1/superadmin/subscriptions/venues/:venueId/activate
 *   POST /api/v1/superadmin/subscriptions/venues/:venueId/deactivate
 *   POST /api/v1/superadmin/subscriptions/venues/:venueId/grant-trial   { days }
 *   POST /api/v1/superadmin/subscriptions/venues/:venueId/adjust-end-date { deltaDays }
 */
const router = Router()

router.get('/overview', controller.overview)
router.get('/venues', validateRequest(listSubscriptionsSchema), controller.venues)

router.post('/venues/:venueId/activate', controller.activate)
router.post('/venues/:venueId/deactivate', controller.deactivate)
router.post('/venues/:venueId/grant-trial', validateRequest(grantTrialSchema), controller.grantTrial)
router.post('/venues/:venueId/adjust-end-date', validateRequest(adjustEndDateSchema), controller.adjustEndDate)

export default router
