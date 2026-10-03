import { NextFunction, Request, Response, Router } from 'express'
import { z } from 'zod'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as controller from '../../controllers/dashboard/staffPay.dashboard.controller'
import { venueHasServicePayAccess } from '../../services/dashboard/staffPay/acceso'
import {
  asignarNivelSchema,
  crearNivelSchema,
  editarNivelSchema,
  fechaQuerySchema,
  levelParamsSchema,
  staffParamsSchema,
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

export default router
