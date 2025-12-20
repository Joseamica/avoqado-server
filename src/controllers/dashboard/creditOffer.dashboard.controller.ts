/**
 * Credit Offer Dashboard Controller
 *
 * Client-facing endpoints for venues to view and respond to credit offers.
 */

import { Request, Response, NextFunction } from 'express'
import * as creditOfferService from '../../services/dashboard/creditOffer.dashboard.service'

/**
 * Get pending credit offer for a venue
 * GET /api/v1/dashboard/venues/:venueId/credit-offer
 */
export async function getPendingOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const result = await creditOfferService.getPendingCreditOffer(venueId)

    res.status(200).json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Express interest in a credit offer
 * POST /api/v1/dashboard/venues/:venueId/credit-offer/:offerId/interest
 */
export async function expressInterest(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, offerId } = req.params
    const authContext = (req as any).authContext
    const staffId = authContext?.userId

    if (!staffId) {
      res.status(401).json({ success: false, message: 'Unauthorized' })
      return
    }

    await creditOfferService.expressInterestInOffer(venueId, offerId, staffId)

    res.status(200).json({
      success: true,
      message: 'Interest registered. Our team will contact you shortly.',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Decline a credit offer
 * POST /api/v1/dashboard/venues/:venueId/credit-offer/:offerId/decline
 */
export async function declineOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, offerId } = req.params
    const { reason } = req.body

    await creditOfferService.declineOffer(venueId, offerId, reason)

    res.status(200).json({
      success: true,
      message: 'Offer declined',
    })
  } catch (error) {
    next(error)
  }
}
