import { Router } from 'express'
import * as controller from '../../controllers/dashboard/areaTicket.dashboard.controller'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import {
  areaTicketOverviewSchema,
  createFulfillmentAreaSchema,
  createScaleProfileSchema,
  updateAreaTicketSettingsSchema,
  updateAreaTicketTerminalSchema,
  updateFulfillmentAreaSchema,
  updateScaleProfileSchema,
  updateScaleSettingsSchema,
} from '../../schemas/dashboard/areaTicket.schema'

const router = Router({ mergeParams: true })

router.get('/', checkPermission('area-tickets:configure'), validateRequest(areaTicketOverviewSchema), controller.getOverview)
router.put(
  '/settings',
  checkPermission('area-tickets:configure'),
  validateRequest(updateAreaTicketSettingsSchema),
  controller.updateSettings,
)
router.get('/operations', checkPermission('area-tickets:deliver'), validateRequest(areaTicketOverviewSchema), controller.getOperations)
router.post('/areas', checkPermission('area-tickets:configure'), validateRequest(createFulfillmentAreaSchema), controller.createArea)
router.put('/areas/:areaId', checkPermission('area-tickets:configure'), validateRequest(updateFulfillmentAreaSchema), controller.updateArea)
router.put(
  '/terminals/:terminalId',
  checkPermission('area-tickets:configure'),
  validateRequest(updateAreaTicketTerminalSchema),
  controller.updateTerminal,
)
router.put(
  '/scale-settings',
  checkPermission('scale:configure'),
  validateRequest(updateScaleSettingsSchema),
  controller.updateScaleSettings,
)
router.post('/scale-profiles', checkPermission('scale:configure'), validateRequest(createScaleProfileSchema), controller.createScaleProfile)
router.put(
  '/scale-profiles/:profileId',
  checkPermission('scale:configure'),
  validateRequest(updateScaleProfileSchema),
  controller.updateScaleProfile,
)

export default router
