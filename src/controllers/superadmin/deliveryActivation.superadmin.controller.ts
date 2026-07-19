/**
 * Ops superadmin — cola de solicitudes de activación de delivery (DeliveryActivationRequest) +
 * avanzar status manualmente (Task 4 del plan delivery-activation-backend). Controller delgado:
 * extrae `authContext` (JAMÁS `req.user`) y delega al service en
 * src/services/delivery-channels/core/deliveryActivation.service.ts.
 *
 * Sin try/catch propio (mismo patrón que deliveryChannels.controller.ts, dueño de este mismo
 * dominio): `express-async-errors` (montado en app.ts) propaga cualquier throw al error handler
 * global.
 *
 * SUPERADMIN-only: `updateActivationStatus` NO escopea por venueId (a propósito — es un
 * endpoint de ops cross-tenant). La seguridad la da el gate del router padre: montado bajo
 * `/delivery-activation` en superadmin.routes.ts, que ya aplica authenticateTokenMiddleware +
 * authorizeRole([SUPERADMIN]) a TODO /api/v1/superadmin/* antes de llegar a este subrouter.
 */
import { Request, Response } from 'express'
import { DeliveryActivationStatus } from '@prisma/client'
import * as activationService from '@/services/delivery-channels/core/deliveryActivation.service'

/** GET /api/v1/superadmin/delivery-activation — cola de ops, filtrable por ?status= */
export const listRequests = async (req: Request, res: Response): Promise<void> => {
  const status = req.query.status as DeliveryActivationStatus | undefined
  const rows = await activationService.listActivationRequests(status ? { status } : undefined)
  res.json({ success: true, data: rows })
}

/** PATCH /api/v1/superadmin/delivery-activation/:id — avanza el status (PENDING → CONTACTED → CONNECTED, o DISMISSED) */
export const updateRequest = async (req: Request, res: Response): Promise<void> => {
  const { userId } = (req as any).authContext
  const updated = await activationService.updateActivationStatus(req.params.id, req.body.status, userId)
  res.json({ success: true, data: updated })
}
