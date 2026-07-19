import { Request, Response, NextFunction } from 'express'
import * as loyaltyMobileService from '../../services/mobile/loyalty.mobile.service'

/**
 * GET /mobile/venues/:venueId/customers/:customerId/loyalty
 * Balance + program rules for the customer attached to a check. Pass
 * ?orderId= to also get how much may be redeemed against that order.
 */
export const getCustomerLoyalty = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, customerId } = req.params
    const orderId = typeof req.query.orderId === 'string' ? req.query.orderId : undefined
    const data = await loyaltyMobileService.getCustomerLoyalty(venueId, customerId, orderId)
    return res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/loyalty/redeem
 * Burns points and applies the matching discount to the OPEN check, atomically.
 */
export const redeemPoints = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { customerId, points } = req.body || {}
    const staffId = (req as any).authContext?.userId as string | undefined

    if (!customerId || typeof customerId !== 'string') {
      return res.status(400).json({ success: false, message: 'customerId is required' })
    }
    if (typeof points !== 'number') {
      return res.status(400).json({ success: false, message: 'points is required' })
    }

    const data = await loyaltyMobileService.redeemPointsToOrder(venueId, orderId, customerId, points, staffId)
    return res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
