/**
 * Gestión de canales de delivery (DeliveryChannelLink CRUD + pause, Task 10).
 * Controller delgado: extrae `authContext` (JAMÁS `req.user`) y delega al service.
 */
import { NextFunction, Request, Response } from 'express'
import * as deliveryChannelLinkService from '../../services/delivery-channels/core/deliveryChannelLink.service'

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
