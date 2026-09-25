/**
 * PRINT_STATIONS dashboard sub-router (feature GRATIS/core, permission-gated).
 * Mounted at /dashboard/venues/:venueId/print-stations with authenticateToken applied
 * at the mount (see dashboard.routes.ts). More-specific static paths declared BEFORE
 * :param paths (Express matches in order).
 */
import { Router } from 'express'
import { authorizeRole } from '../../middlewares/authorizeRole.middleware'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import { StaffRole } from '../../security'
import * as controller from '../../controllers/dashboard/printStation.dashboard.controller'
import {
  assignRoutingSchema,
  createPrinterSchema,
  createStationSchema,
  previewRoutingSchema,
  printerParamSchema,
  setKitchenDisplaySchema,
  stationParamSchema,
  updatePrinterSchema,
  updateStationSchema,
  upsertGatewaySchema,
  venueParamSchema,
} from '../../schemas/dashboard/printStation.schema'

const router = Router({ mergeParams: true })

// ---- Printers ----
router.get('/printers', checkPermission('printers:read'), validateRequest(venueParamSchema), controller.listPrinters)
router.post('/printers', checkPermission('printers:manage'), validateRequest(createPrinterSchema), controller.createPrinter)
router.put('/printers/:printerId', checkPermission('printers:manage'), validateRequest(updatePrinterSchema), controller.updatePrinter)
router.delete('/printers/:printerId', checkPermission('printers:manage'), validateRequest(printerParamSchema), controller.deletePrinter)

// ---- Gateway (LAN broker device) ----
router.get('/gateway', checkPermission('printers:read'), validateRequest(venueParamSchema), controller.getGateway)
router.put('/gateway', checkPermission('printers:manage'), validateRequest(upsertGatewaySchema), controller.upsertGateway)

// ---- Routing (category/product → station) + simulator ----
router.get('/routing', checkPermission('printers:read'), validateRequest(venueParamSchema), controller.getRouting)
router.put('/routing', checkPermission('printers:manage'), validateRequest(assignRoutingSchema), controller.assignRouting)
router.post('/routing/preview', checkPermission('printers:read'), validateRequest(previewRoutingSchema), controller.previewRouting)

// ---- Stations (declare AFTER static sub-paths above) ----
router.get('/', checkPermission('printers:read'), validateRequest(venueParamSchema), controller.listStations)
router.post('/', checkPermission('printers:manage'), validateRequest(createStationSchema), controller.createStation)
// Casilla «pantalla de cocina» — etapa 1: SÓLO SUPERADMIN (spec 2026-09-24 §4). La etapa 3 la abre a
// dueño/admin con plan Pro; hasta entonces un cliente no puede prender una pantalla que no está terminada.
router.put(
  '/:stationId/kitchen-display',
  authorizeRole([StaffRole.SUPERADMIN]),
  validateRequest(setKitchenDisplaySchema),
  controller.setKitchenDisplay,
)
router.put('/:stationId', checkPermission('printers:manage'), validateRequest(updateStationSchema), controller.updateStation)
router.delete('/:stationId', checkPermission('printers:manage'), validateRequest(stationParamSchema), controller.deleteStation)

export default router
