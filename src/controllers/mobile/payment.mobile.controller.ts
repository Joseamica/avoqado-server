import { Request, Response, NextFunction } from 'express'
import * as orderMobileService from '../../services/mobile/order.mobile.service'
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

export async function attachCustomerToPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, paymentId } = req.params
    const { customerId } = req.body

    const order = await orderMobileService.attachCustomerToPayment(venueId, paymentId, customerId)

    res.status(200).json({
      success: true,
      data: order,
      message: 'Customer attached to payment successfully',
    })
  } catch (error) {
    next(error)
  }
}

export async function attachCustomerToLatestPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const { customerId, amountCents, tipCents, staffId } = req.body

    const order = await orderMobileService.attachCustomerToLatestPayment(venueId, {
      customerId,
      amountCents,
      tipCents,
      staffId,
    })

    res.status(200).json({
      success: true,
      data: order,
      message: 'Customer attached to latest payment successfully',
    })
  } catch (error) {
    next(error)
  }
}
