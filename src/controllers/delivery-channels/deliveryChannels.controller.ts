/**
 * Gestión de canales de delivery (DeliveryChannelLink CRUD + pause, Task 10).
 * Controller delgado: extrae `authContext` (JAMÁS `req.user`) y delega al service.
 */
import { NextFunction, Request, Response } from 'express'
import * as deliveryChannelLinkService from '../../services/delivery-channels/core/deliveryChannelLink.service'
import * as activationService from '../../services/delivery-channels/core/deliveryActivation.service'

/** GET /venues/:venueId/channels */
export async function listChannels(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const result = await deliveryChannelLinkService.listChannelLinks(venueId)
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/** POST /venues/:venueId/channels */
export async function createChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const { userId } = (req as any).authContext
    const result = await deliveryChannelLinkService.createChannelLink(venueId, req.body, userId)
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/** PATCH /venues/:venueId/channels/:linkId */
export async function updateChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, linkId } = req.params
    const { userId } = (req as any).authContext
    const result = await deliveryChannelLinkService.updateChannelLink(venueId, linkId, req.body, userId)
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/** POST /venues/:venueId/channels/:linkId/pause */
export async function pauseChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, linkId } = req.params
    const { userId } = (req as any).authContext
    const result = await deliveryChannelLinkService.pauseChannelLink(venueId, linkId, req.body.paused, userId)
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /venues/:venueId/activation-request — el dueño solicita activar delivery (self-serve,
 * idempotente: el service devuelve la solicitud viva existente en vez de duplicarla).
 *
 * `venueId` viene de `req.params` (el venue de la URL), NO de `authContext`: checkFeatureAccess/
 * checkPermission autorizan vía `resolveRequestVenueId` que prioriza `params > x-venue-id > token`
 * (el JWT queda stale tras switchVenue), así que leer del token abriría un hueco cross-tenant
 * (autorizar venue B, escribir venue A). `userId` (requestedById) SÍ sale de authContext — es el
 * actor autenticado. Mismo patrón que los handlers hermanos createChannel/listChannels.
 *
 * Sin try/catch propio (patrón de deliverect.webhook.controller.ts en este mismo dominio):
 * `express-async-errors` (montado en app.ts) propaga cualquier throw al error handler global.
 */
export const requestActivation = async (req: Request, res: Response): Promise<void> => {
  const { venueId } = req.params
  const { userId } = (req as any).authContext
  const request = await activationService.createActivationRequest(venueId, userId, req.body)
  res.json({ success: true, data: request })
}

/**
 * GET /venues/:venueId/activation-request — la solicitud viva (PENDING|CONTACTED) del venue, o null.
 * `venueId` de `req.params` (el autorizado por el middleware), NO de authContext — ver requestActivation.
 */
export const getActivation = async (req: Request, res: Response): Promise<void> => {
  const { venueId } = req.params
  const request = await activationService.getActivationRequest(venueId)
  res.json({ success: true, data: request })
}
