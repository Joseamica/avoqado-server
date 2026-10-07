import { NextFunction, Request, Response, Router } from 'express'
import { z } from 'zod'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as controller from '../../controllers/dashboard/staffPay.dashboard.controller'
import {
  MENSAJE_SIN_ACTIVAR,
  organizacionDeLaSedeActivada,
  organizacionTieneServicePay,
  venueHasServicePayAccess,
} from '../../services/dashboard/staffPay/acceso'
import {
  activarSchema,
  activarSedeSchema,
  ajusteClaseSchema,
  ajusteManualSchema,
  ajustePreviewQuerySchema,
  archivarTablaSchema,
  asignarNivelSchema,
  cerrarPeriodoSchema,
  crearNivelSchema,
  crearTablaSchema,
  cursorQuerySchema,
  desactivarSedeSchema,
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
  propinasSchema,
  publicarVersionSchema,
  reciboQuerySchema,
  reporteQuerySchema,
  sedeParamsSchema,
  sessionPayParamsSchema,
  staffParamsSchema,
  tableParamsSchema,
  venueParamsSchema,
  vistaPreviaSedeQuerySchema,
} from '../../schemas/dashboard/staffPay.schema'

const router = Router({ mergeParams: true })

// Antes de las puertas: la pantalla necesita saber si está apagado (sin plan o sin activar) para explicarlo (spec §7.3, §10).
router.get('/access', checkPermission('staffpay:read'), validateRequest(z.object({ params: venueParamsSchema })), controller.getAccess)

/** El PLAN de la sede del URL (la función SERVICE_PAY: Pro o suelta por sucursal; spec fase 3 §10). */
export async function servicePayGate(req: Request, res: Response, next: NextFunction) {
  try {
    if (await venueHasServicePayAccess(req.params.venueId)) return next()
    return res.status(403).json({
      error: 'module_disabled',
      message: 'Pago por servicio no está activo en este negocio: viene en el plan Pro o se contrata suelto por sucursal.',
    })
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
    return res.status(403).json({
      error: 'module_disabled',
      message: 'Pago por servicio no está activo en ninguna sede de este negocio: viene en el plan Pro o se contrata suelto por sucursal.',
    })
  } catch (error) {
    return next(error)
  }
}

/**
 * Lo de DINERO (spec fase 3 §10): además del plan, la organización activó pago al personal («un negocio PRO no ve el módulo
 * encendido sólo por tener el plan»). Configurar niveles y tablas, elegir la periodicidad y activar NO lo exigen: el dueño
 * prepara su tabla y después activa. Es de la ORGANIZACIÓN (pre-flight C2, fila 13): no pide la ventana de la sede del URL.
 */
export async function servicePayActivadoGate(req: Request, res: Response, next: NextFunction) {
  try {
    if (await organizacionDeLaSedeActivada(req.params.venueId)) return next()
    return res.status(403).json({ error: 'not_activated', message: MENSAJE_SIN_ACTIVAR })
  } catch (error) {
    return next(error)
  }
}
// La sede del URL es la de la clase: el preview pide leer ahí; liquidar, `staffpay:close` ahí, y el service lo exige
// además en todas las sedes del periodo destino (spec §9.2). Mueven dinero: exigen además la activación (fase 3 §10).
router.get(
  '/class-sessions/:sessionId/difference',
  servicePayGateOrganizacion,
  servicePayActivadoGate,
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: sessionPayParamsSchema, query: destinoQuerySchema })),
  controller.getClassDifference,
)
router.post(
  '/class-sessions/:sessionId/difference/settle',
  servicePayGateOrganizacion,
  servicePayActivadoGate,
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
  servicePayActivadoGate,
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: sessionPayParamsSchema })),
  controller.getClassPay,
)
router.put(
  '/class-sessions/:sessionId/pay-adjustments',
  servicePayGateOrganizacion,
  servicePayActivadoGate,
  checkPermission('staffpay:manage'),
  validateRequest(z.object({ params: sessionPayParamsSchema, body: ajusteClaseSchema })),
  controller.putClassPayAdjustments,
)

// B11 (diseño r3.7, r4.7, r7.3): activar o desactivar UNA sede «desde / hasta qué día», y su vista previa con montos. La
// ruta pide el permiso en la sede del URL; el service, además, en la sede que se cambia (`staffpay:close` para escribir,
// `staffpay:read` para ver). Activar exige el plan en ALGUNA sede (como liquidar) y el service, en la sede que se activa
// (SEDE_SIN_PLAN). Desactivar y la vista previa NO llevan puerta de plan: desactivar es la salida del bloqueo de una sede
// activa que perdió el plan (SEDE_ACTIVA_SIN_PLAN).
router.get(
  '/sedes/:sedeId/participation-preview',
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: sedeParamsSchema, query: vistaPreviaSedeQuerySchema })),
  controller.getParticipationPreview,
)
router.post(
  '/sedes/:sedeId/activate',
  servicePayGateOrganizacion,
  checkPermission('staffpay:close'),
  validateRequest(z.object({ params: sedeParamsSchema, body: activarSedeSchema })),
  controller.postActivateSede,
)
router.post(
  '/sedes/:sedeId/deactivate',
  checkPermission('staffpay:close'),
  validateRequest(z.object({ params: sedeParamsSchema, body: desactivarSedeSchema })),
  controller.postDeactivateSede,
)
// B13 (diseño r3.7(1), r4.7): Configuración › Sedes. Sin puerta de plan, como la vista previa: una sede que perdió el plan (o
// nunca lo tuvo) también se ve, con su estado y qué le falta. El service muestra sólo las sedes que el usuario puede leer.
router.get('/sedes', checkPermission('staffpay:read'), validateRequest(z.object({ params: venueParamsSchema })), controller.getSedes)

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

// Fase 3 (spec §7.1): activar pago al personal y su periodicidad. Exigen el plan pero NO estar activado (sería imposible
// activar). Afectan a TODA la organización: el service exige además staffpay:close en todas sus sedes. La periodicidad se
// elige antes de activar; después la fija el service (409 PERIODICIDAD_FIJA, B9; pre-flight C2, fila 6).
router.patch(
  '/periodicity',
  checkPermission('staffpay:close'),
  validateRequest(z.object({ params: venueParamsSchema, body: periodicidadSchema })),
  controller.patchPeriodicity,
)
router.post(
  '/activate',
  checkPermission('staffpay:close'),
  validateRequest(z.object({ params: venueParamsSchema, body: activarSchema })),
  controller.postActivate,
)

// Desde aquí, todo es dinero: exige además la activación (spec fase 3 §10). `POST /activate` va ARRIBA de esta línea.
router.use(servicePayActivadoGate)

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
// Fase 3 (spec §6.3): el interruptor de propinas. Afecta a TODA la organización (el service exige staffpay:close en todas sus
// sedes) y mueve dinero: exige la activación (si no, el service respondería 409 NO_ACTIVADO).
router.put(
  '/tips',
  checkPermission('staffpay:close'),
  validateRequest(z.object({ params: venueParamsSchema, body: propinasSchema })),
  controller.putTips,
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
// B13 (diseño r5.1): lo que registraría el ajuste (periodo destino y huella) y el aviso de devoluciones pendientes de esa persona.
// Sólo lectura (GET: también durante una suplantación). La ruta pide leer; el service exige cerrar en la sede del ajuste.
router.get(
  '/adjustments/preview',
  checkPermission('staffpay:read'),
  validateRequest(z.object({ params: venueParamsSchema, query: ajustePreviewQuerySchema })),
  controller.getAdjustmentPreview,
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
