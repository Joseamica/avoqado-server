import { Router } from 'express'
import { validateRequest } from '../../middlewares/validation'
import * as controller from '../../controllers/superadmin/posAppVersions.controller'
import { clearPolicySchema, impactQuerySchema, putPolicySchema } from './posAppVersions.schemas'

/**
 * Actualizador del POS: versiones mínimas por plataforma. Montado en `/pos-app-versions` desde superadmin.routes.ts, que ya
 * exige token y rol SUPERADMIN (sin permiso nuevo).
 *
 *   GET   /api/v1/superadmin/pos-app-versions
 *   PUT   /api/v1/superadmin/pos-app-versions/:platform
 *   POST  /api/v1/superadmin/pos-app-versions/:platform/clear
 *   GET   /api/v1/superadmin/pos-app-versions/:platform/impact?versionCode=|versionName=&days=
 */
const router = Router()

router.get('/', controller.list)
router.get('/:platform/impact', validateRequest(impactQuerySchema), controller.impact)
router.post('/:platform/clear', validateRequest(clearPolicySchema), controller.clear)
router.put('/:platform', validateRequest(putPolicySchema), controller.put)

export default router
