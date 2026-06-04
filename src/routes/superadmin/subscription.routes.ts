import { Router } from 'express'
import { validateRequest } from '@/middlewares/validation'
import { listSubscriptionsSchema } from './subscription.schemas'
import * as controller from '@/controllers/superadmin/subscription.controller'

/**
 * PLAN_PRO subscription visibility for superadmin. Mounted under `/subscriptions`
 * in superadmin.routes.ts, which already applies authenticateTokenMiddleware +
 * authorizeRole([SUPERADMIN]) globally — no extra guard here.
 *
 *   GET /api/v1/superadmin/subscriptions/overview
 *   GET /api/v1/superadmin/subscriptions/venues?state=&q=&page=&pageSize=
 */
const router = Router()

router.get('/overview', controller.overview)
router.get('/venues', validateRequest(listSubscriptionsSchema), controller.venues)

export default router
