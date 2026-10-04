import { NextFunction, Request, Response, Router } from 'express'
import { z } from 'zod'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as controller from '../../controllers/dashboard/staffPay.dashboard.controller'
import { organizacionTieneServicePay, venueHasServicePayAccess } from '../../services/dashboard/staffPay/acceso'
import {
  ajusteClaseSchema,
  ajusteManualSchema,
  archivarTablaSchema,
  asignarNivelSchema,
  cerrarPeriodoSchema,
  crearNivelSchema,
  crearTablaSchema,
  cursorQuerySchema,
  destinoQuerySchema,
  differencesQuerySchema,
  editarNivelSchema,
  exportReciboQuerySchema,
  fechaQuerySchema,
  fechaRequeridaQuerySchema,
  levelParamsSchema,
  liquidarSchema,
  listaPeriodosQuerySchema,
  marcarPagadoSchema,
  pagadoPreviewQuerySchema,
  periodicidadSchema,
  periodParamsSchema,
  publicarVersionSchema,
  reciboQuerySchema,
  reporteQuerySchema,
  sessionPayParamsSchema,
  staffParamsSchema,
  tableParamsSchema,
  venueParamsSchema,
} from '../../schemas/dashboard/staffPay.schema'

const router = Router({ mergeParams: true })

// Antes del gate: la pantalla necesita saber si está apagado para explicarlo (spec §7.3).
router.get('/access', checkPermission('staffpay:read'), validateRequest(z.object({ params: venueParamsSchema })), controller.getAccess)

export async function servicePayGate(req: Request, res: Response, next: NextFunction) {
  try {
    if (await venueHasServicePayAccess(req.params.venueId)) return next()
    return res
      .status(403)
      .json({ error: 'module_disabled', message: 'Pago por servicio no está activo en este negocio. Pídelo a Avoqado.' })
  } catch (error) {
    return next(error)
  }
}

/**
 * Gate de las diferencias de UNA clase (Codex R2-R1-1, spec §5.6): liquidar suma la sede de la clase al periodo destino
 * aunque ya no tenga el módulo, así que basta con que ALGUNA sede de su organización lo tenga. Va antes del gate de la sede.
 */
export async function servicePayGateOrganizacion(req: Request, res: Response, next: NextFunction) {
  try {
    if (await organizacionTieneServicePay(req.params.venueId)) return next()
    return res
      .status(403)
      .json({ error: 'module_disabled', message: 'Pago por servicio no está activo en ninguna sede de este negocio. Pídelo a Avoqado.' })
  } catch (error) {
    return next(error)
  }
}
// La sede del URL es la de la clase: el preview pide leer ahí; liquidar, `staffpay:close` ahí, y el service lo exige
// además en todas las sedes del periodo destino (spec §9.2).
router.get(
  '/class-sessions/:sessionId/difference',
  servicePayGateOrganizacion,
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: sessionPayParamsSchema, query: destinoQuerySchema })),
  controller.getClassDifference,
)
router.post(
  '/class-sessions/:sessionId/difference/settle',
  servicePayGateOrganizacion,
  checkPermission('staffpay:close'),
  validateRequest(z.object({ params: sessionPayParamsSchema, body: liquidarSchema })),
  controller.postSettleDifference,
)
// Tarjeta de pago de una clase y sus ajustes auditados (spec §5.4, §6.1), con el MISMO gate de organización (revisión
// final, M-2): una diferencia en excepción de una sede que apagó el módulo se resuelve con «Ajustar monto» y después se
// liquida; con el gate de la sede se quedaba sin salida (spec §5.6). Permisos y validación, iguales.
router.get(
  '/class-sessions/:sessionId/pay',
  servicePayGateOrganizacion,
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: sessionPayParamsSchema })),
  controller.getClassPay,
)
router.put(
  '/class-sessions/:sessionId/pay-adjustments',
  servicePayGateOrganizacion,
  checkPermission('staffpay:manage'),
  validateRequest(z.object({ params: sessionPayParamsSchema, body: ajusteClaseSchema })),
  controller.putClassPayAdjustments,
)

router.use(servicePayGate)

// Niveles y asignaciones: son de la ORGANIZACIÓN; escribir exige staffpay:manage en todas sus sedes (spec §9.2, en el service).
router.get('/levels', checkPermission('staffpay:read'), validateRequest(z.object({ params: venueParamsSchema })), controller.listLevels)
router.post(
  '/levels',
  checkPermission('staffpay:manage'),
  validateRequest(z.object({ params: venueParamsSchema, body: crearNivelSchema })),
  controller.createLevel,
)
router.patch(
  '/levels/:levelId',
  checkPermission('staffpay:manage'),
  validateRequest(z.object({ params: levelParamsSchema, body: editarNivelSchema })),
  controller.updateLevel,
)
router.post(
  '/assignments',
  checkPermission('staffpay:manage'),
  validateRequest(z.object({ params: venueParamsSchema, body: asignarNivelSchema })),
  controller.assignLevel,
)
router.get(
  '/assignments',
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: venueParamsSchema, query: fechaQuerySchema })),
  controller.currentAssignments,
)
router.get(
  '/assignments/:staffId/history',
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: staffParamsSchema })),
  controller.assignmentHistory,
)

// Tablas de pago: son de la SEDE (spec §5.3); la ruta ya exige el permiso en esta sede.
router.get(
  '/tables',
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: venueParamsSchema, query: fechaQuerySchema })),
  controller.listTables,
)
router.post(
  '/tables',
  checkPermission('staffpay:manage'),
  validateRequest(z.object({ params: venueParamsSchema, body: crearTablaSchema })),
  controller.createTable,
)
router.post(
  '/tables/:tableId/versions',
  checkPermission('staffpay:manage'),
  validateRequest(z.object({ params: tableParamsSchema, body: publicarVersionSchema })),
  controller.publishVersion,
)
router.post(
  '/tables/:tableId/archive',
  checkPermission('staffpay:manage'),
  validateRequest(z.object({ params: tableParamsSchema, body: archivarTablaSchema })),
  controller.archiveTable,
)
router.get(
  '/tables/:tableId/versions',
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: tableParamsSchema })),
  controller.tableHistory,
)

// Reporte del periodo abierto (spec §6.2, §9.2): multi-sede; el service junta sólo las sedes que el usuario puede leer
// y marca la vista como parcial.
router.get(
  '/report',
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: venueParamsSchema, query: reporteQuerySchema })),
  controller.getReport,
)
router.get(
  '/report/staff/:staffId',
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: staffParamsSchema, query: cursorQuerySchema })),
  controller.getStaffDetail,
)
router.get(
  '/report/exceptions',
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: venueParamsSchema, query: cursorQuerySchema })),
  controller.getExceptions,
)
router.get(
  '/report/orphans',
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: venueParamsSchema, query: reporteQuerySchema })),
  controller.getOrphans,
)

// Fase 2: cerrar y pagar. El permiso de ruta revisa la sede del URL; el service, el alcance completo (spec §9.2).
router.get(
  '/periods',
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: venueParamsSchema, query: listaPeriodosQuerySchema })),
  controller.listPeriods,
)
router.patch(
  '/periodicity',
  checkPermission('staffpay:close'),
  validateRequest(z.object({ params: venueParamsSchema, body: periodicidadSchema })),
  controller.patchPeriodicity,
)
router.get(
  '/periods/close-preview',
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: venueParamsSchema, query: fechaRequeridaQuerySchema })),
  controller.getClosePreview,
)
router.post(
  '/periods/close',
  checkPermission('staffpay:close'),
  validateRequest(z.object({ params: venueParamsSchema, body: cerrarPeriodoSchema })),
  controller.postClose,
)
router.post(
  '/periods/:periodId/paid',
  checkPermission('staffpay:close'),
  validateRequest(z.object({ params: periodParamsSchema, body: marcarPagadoSchema })),
  controller.postPaid,
)
// Sólo lectura: lo que «marcar pagado» registraría (cantidad, total pendiente, huella). La ruta pide leer; el service exige
// además `staffpay:close` en todas las sedes de esos recibos (el mismo permiso que marcar), así que no enseña de más.
router.get(
  '/periods/:periodId/paid-preview',
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: periodParamsSchema, query: pagadoPreviewQuerySchema })),
  controller.getPaidPreview,
)
router.post(
  '/adjustments',
  checkPermission('staffpay:close'),
  validateRequest(z.object({ params: venueParamsSchema, body: ajusteManualSchema })),
  controller.postAdjustment,
)
router.get(
  '/staff/:staffId/receipt',
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: staffParamsSchema, query: reciboQuerySchema })),
  controller.getReceipt,
)
router.get(
  '/staff/:staffId/receipt/export',
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: staffParamsSchema, query: exportReciboQuerySchema })),
  controller.getReceiptExport,
)
// Lo pendiente de un periodo CERRADO (spec §6.4), por páginas; el service lee sólo las sedes legibles del alcance histórico.
router.get(
  '/periods/:periodId/differences',
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: periodParamsSchema, query: differencesQuerySchema })),
  controller.getDifferences,
)

export default router
