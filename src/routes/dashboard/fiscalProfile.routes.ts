/**
 * Datos fiscales del venue como receptor (feature GRATIS/core, OWNER-only).
 * Montado en /dashboard/venues/:venueId/fiscal-profile con authenticateToken en el mount.
 */
import { Router } from 'express'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as controller from '../../controllers/dashboard/fiscalProfile.dashboard.controller'
import { upsertFiscalProfileSchema, uploadConstanciaSchema, venueParamSchema } from '../../schemas/dashboard/fiscalProfile.schema'

const router = Router({ mergeParams: true })

router.get('/', checkPermission('venue-fiscal-profile:manage'), validateRequest(venueParamSchema), controller.getFiscalProfile)
router.put('/', checkPermission('venue-fiscal-profile:manage'), validateRequest(upsertFiscalProfileSchema), controller.upsertFiscalProfile)
router.post(
  '/constancia',
  checkPermission('venue-fiscal-profile:manage'),
  validateRequest(uploadConstanciaSchema),
  controller.uploadFiscalConstancia,
)

export default router
