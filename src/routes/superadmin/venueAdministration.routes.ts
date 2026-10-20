import { Router } from 'express'
import { z } from 'zod'
import { validateRequest } from '@/middlewares/validation'
import * as controller from '@/controllers/superadmin/venueAdministration.controller'
import {
  venueAdministrationParams,
  updateVenueProfileBody,
  updateVenueOrganizationBody,
  updateVenueOwnerBody,
  updateVenueStatusBody,
} from '@/schemas/superadmin/venueAdministration.schema'

// Inherits authentication and the current SUPERADMIN role check from the parent router.
const router = Router()
router.get('/:venueId/administration', validateRequest(z.object({ params: venueAdministrationParams })), controller.getAdministration)
router.patch(
  '/:venueId/profile',
  validateRequest(z.object({ params: venueAdministrationParams, body: updateVenueProfileBody })),
  controller.updateProfile,
)
router.patch(
  '/:venueId/organization',
  validateRequest(z.object({ params: venueAdministrationParams, body: updateVenueOrganizationBody })),
  controller.updateOrganization,
)
router.patch(
  '/:venueId/owner',
  validateRequest(z.object({ params: venueAdministrationParams, body: updateVenueOwnerBody })),
  controller.updateOwner,
)
router.patch(
  '/:venueId/status',
  validateRequest(z.object({ params: venueAdministrationParams, body: updateVenueStatusBody })),
  controller.updateStatus,
)
export default router
