/**
 * Plano de mesas — sub-router del dashboard (spec 2026-10-08).
 * Montado en /dashboard/venues/:venueId/floor-plan con authenticateToken en el montaje (dashboard.routes.ts).
 * Leer: cualquiera con tables:read (un negocio en Gratis ve su plano con el candado encima).
 * Publicar: tables:configure + Servicio de mesas (TABLE_SERVICE, PRO). checkFeatureAccess contesta el 403 del plan.
 */
import { Router } from 'express'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { checkFeatureAccess } from '../../middlewares/checkFeatureAccess.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as controller from '../../controllers/dashboard/floorPlan.dashboard.controller'
import { getFloorPlanSchema, publishFloorPlanSchema } from '../../schemas/dashboard/floorPlan.schema'

const router = Router({ mergeParams: true })

router.get('/', checkPermission('tables:read'), validateRequest(getFloorPlanSchema), controller.getFloorPlan)
router.put(
  '/',
  checkPermission('tables:configure'),
  checkFeatureAccess('TABLE_SERVICE'),
  validateRequest(publishFloorPlanSchema),
  controller.publishFloorPlan,
)

export default router
