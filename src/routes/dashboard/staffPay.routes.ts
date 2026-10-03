import { NextFunction, Request, Response, Router } from 'express'
import { z } from 'zod'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as controller from '../../controllers/dashboard/staffPay.dashboard.controller'
import { venueHasServicePayAccess } from '../../services/dashboard/staffPay/acceso'
import { venueParamsSchema } from '../../schemas/dashboard/staffPay.schema'

const router = Router({ mergeParams: true })

// Antes del gate: la pantalla necesita saber si está apagado para explicarlo (spec §7.3).
router.get('/access', checkPermission('staffpay:read'), validateRequest(z.object({ params: venueParamsSchema })), controller.getAccess)

export async function servicePayGate(req: Request, res: Response, next: NextFunction) {
  try {
    if (await venueHasServicePayAccess(req.params.venueId)) return next()
    return res.status(403).json({ error: 'module_disabled', message: 'Pago por servicio no está activo en este negocio. Pídelo a Avoqado.' })
  } catch (error) {
    return next(error)
  }
}
router.use(servicePayGate)

export default router
