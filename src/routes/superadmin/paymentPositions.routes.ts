import { Router } from 'express'
import { z } from 'zod'
import { validateRequest } from '../../middlewares/validation'
import { reportePosicionesQuerySchema } from '../../services/superadmin/reportePosiciones.service'
import { getReportePosiciones } from '../../controllers/superadmin/reportePosiciones.controller'

const router = Router()

// GET /api/v1/superadmin/payment-positions — reporte de sólo lectura (tarifa al comercio, paso 2). Sólo SUPERADMIN (router padre).
router.get('/', validateRequest(z.object({ query: reportePosicionesQuerySchema })), getReportePosiciones)

export default router
