import { Router } from 'express'
import { z } from 'zod'
import { validateRequest } from '../../middlewares/validation'
import * as controller from '../../controllers/superadmin/stripeConnectOffboarding.controller'

const router = Router()

router.post(
  '/venues/:venueId/offboard-payments',
  validateRequest(z.object({ params: z.object({ venueId: z.string().min(1) }) })),
  controller.offboardVenue,
)

export default router
