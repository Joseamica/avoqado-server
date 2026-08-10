import { Router } from 'express'
import * as controller from '../../controllers/dashboard/masterCatalog.dashboard.controller'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'

const router = Router({ mergeParams: true })

// WHY: The catalog venue services re-resolve active StaffVenue membership and
// custom permission overrides. A generic permission middleware would grant its
// SUPERADMIN shortcut before that catalog-specific fail-closed authority runs.
router.use(authenticateTokenMiddleware)
router.get('/access', controller.getVenueAccess)
router.get('/products/:productId/provenance', controller.getVenueProvenance)
router.get('/changes', controller.listVenueChanges)
router.post('/override-requests/preview', controller.previewVenueOverride)
router.post('/override-requests/:requestBatchId/confirm', controller.confirmVenueOverride)

export default router
