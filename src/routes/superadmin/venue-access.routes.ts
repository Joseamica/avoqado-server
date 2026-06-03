import { Router } from 'express'
import { validateRequest } from '@/middlewares/validation'
import { grantVenueAccessSchema, listCandidatesSchema } from './venue-access.schemas'
import * as controller from '@/controllers/superadmin/venue-access.controller'

/**
 * Venue staff-access routes. Mounted under `/venues` in superadmin.routes.ts,
 * which already applies `authenticateTokenMiddleware` + `authorizeRole(SUPERADMIN)`
 * globally — no extra auth needed here.
 *
 *   GET  /api/v1/superadmin/venues/:venueId/staff-access/candidates?sourceVenueId=
 *   POST /api/v1/superadmin/venues/:venueId/staff-access
 */
const router = Router()

router.get('/:venueId/staff-access/candidates', validateRequest(listCandidatesSchema), controller.candidates)
router.post('/:venueId/staff-access', validateRequest(grantVenueAccessSchema), controller.grant)

export default router
