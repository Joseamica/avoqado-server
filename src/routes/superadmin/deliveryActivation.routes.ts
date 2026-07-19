import { Router } from 'express'
import { DeliveryActivationStatus } from '@prisma/client'
import { z } from 'zod'
import { validateRequest } from '@/middlewares/validation'
import * as ctrl from '@/controllers/superadmin/deliveryActivation.superadmin.controller'

/**
 * Ops superadmin: cola de solicitudes de activación de delivery (DeliveryActivationRequest) +
 * avanzar status manualmente. Ver src/services/delivery-channels/core/deliveryActivation.service.ts
 * para las reglas de negocio (PENDING → CONTACTED → CONNECTED, o DISMISSED).
 *
 * Mounted under `/delivery-activation` in superadmin.routes.ts, which already applies
 * authenticateTokenMiddleware + authorizeRole([SUPERADMIN]) globally — no extra guard here
 * (mismo patrón que subscription.routes.ts / terminal.routes.ts / module.routes.ts). Esto es
 * CRÍTICO aquí en particular: `updateActivationStatus` (el service) no escopea por venueId
 * a propósito, así que el gate SUPERADMIN del router padre es lo único que lo hace seguro.
 *
 *   GET   /api/v1/superadmin/delivery-activation?status=       — cola de ops, filtrable
 *   PATCH /api/v1/superadmin/delivery-activation/:id   { status } — avanza el status
 */
const router = Router()

const DELIVERY_ACTIVATION_STATUS_VALUES = Object.values(DeliveryActivationStatus) as [
  DeliveryActivationStatus,
  ...DeliveryActivationStatus[],
]

const listRequestsSchema = z.object({
  query: z
    .object({
      status: z.enum(DELIVERY_ACTIVATION_STATUS_VALUES, { message: 'Estado inválido' }).optional(),
    })
    .passthrough()
    .optional(),
})

const updateRequestSchema = z.object({
  params: z.object({ id: z.string().min(1, 'El id es requerido') }).passthrough(),
  body: z
    .object({
      status: z.enum(DELIVERY_ACTIVATION_STATUS_VALUES, { message: 'Estado inválido' }),
    })
    .strict(),
})

router.get('/', validateRequest(listRequestsSchema), ctrl.listRequests)
router.patch('/:id', validateRequest(updateRequestSchema), ctrl.updateRequest)

export default router
