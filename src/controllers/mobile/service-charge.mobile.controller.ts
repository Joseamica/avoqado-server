import { Request, Response, NextFunction } from 'express'
import * as serviceChargeService from '../../services/mobile/service-charge.mobile.service'

/**
 * GET /mobile/venues/:venueId/service-charges
 * Catálogo de cobros por servicio activos del venue.
 */
export const listServiceCharges = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const data = await serviceChargeService.listServiceCharges(venueId)
    return res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/service-charges
 * Aplica un cobro del catálogo a la cuenta abierta (SUMA al total).
 */
export const applyServiceCharge = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { serviceChargeId } = req.body || {}
    const staffId = (req as any).authContext?.userId as string | undefined
    if (!serviceChargeId || typeof serviceChargeId !== 'string') {
      return res.status(400).json({ success: false, message: 'serviceChargeId is required' })
    }
    const data = await serviceChargeService.applyServiceCharge(venueId, orderId, serviceChargeId, staffId)
    return res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /mobile/venues/:venueId/orders/:orderId/service-charges/:orderServiceChargeId
 * Quita un cobro aplicado de la cuenta.
 */
export const removeServiceCharge = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId, orderServiceChargeId } = req.params
    const staffId = (req as any).authContext?.userId as string | undefined
    const data = await serviceChargeService.removeServiceCharge(venueId, orderId, orderServiceChargeId, staffId)
    return res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
