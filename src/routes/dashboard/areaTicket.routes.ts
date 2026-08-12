import { Router } from 'express'
import * as controller from '../../controllers/dashboard/areaTicket.dashboard.controller'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import {
  areaTicketOverviewSchema,
  createFulfillmentAreaSchema,
  createScaleProfileSchema,
  listExternalIncidentsSchema,
  listExternalSettlementsSchema,
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
// Colas de sólo lectura de la ruta EXTERNAL (§caja externa fase 1, Task 15) — qué
// cobros nadie confirmó y qué incidencias quedaron abiertas. Mismo permiso que el
// resto de este router: quien puede configurar la ruta externa puede ver su cola.
router.get(
  '/external-settlements',
  checkPermission('area-tickets:configure'),
  validateRequest(listExternalSettlementsSchema),
  controller.listExternalSettlements,
)
router.get(
  '/external-incidents',
  checkPermission('area-tickets:configure'),
  validateRequest(listExternalIncidentsSchema),
  controller.listExternalIncidents,
)
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
