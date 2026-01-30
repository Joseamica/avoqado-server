import { Request, Response, NextFunction } from 'express'
import * as paymentTpvService from '../../services/tpv/payment.tpv.service'

/**
 * Record a fast payment (no order, just amount)
 * Used for custom amounts and quick payments from iOS app
 */
export async function recordFastPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    const userId = req.authContext?.userId
    const venueId: string = req.params.venueId

    const paymentData = req.body

    const result = await paymentTpvService.recordFastPayment(venueId, paymentData, userId, orgId)

    res.status(201).json({
      success: true,
      data: result,
      message: 'Fast payment recorded successfully',
    })
  } catch (error) {
    next(error)
  }
}
