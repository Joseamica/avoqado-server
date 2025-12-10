/**
 * Venue Payment Readiness Controller
 *
 * Endpoints for checking venue payment configuration status.
 * Used by superadmins to track and complete venue payment setup.
 */

import { Request, Response, NextFunction } from 'express'
import { getPaymentReadiness, getVenuesPaymentReadiness } from '@/services/dashboard/venuePaymentReadiness.service'

/**
 * Get payment readiness status for a specific venue
 *
 * @route GET /api/v1/dashboard/venues/:venueId/payment-readiness
 */
export const getVenuePaymentReadiness = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params

    const readiness = await getPaymentReadiness(venueId)

    return res.status(200).json({
      data: readiness,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get payment readiness status for multiple venues
 * Used by superadmin dashboard to show venues needing configuration
 *
 * @route GET /api/v1/dashboard/superadmin/payment-readiness
 * @query venueIds - Optional comma-separated list of venue IDs
 */
export const getMultipleVenuesPaymentReadiness = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueIds } = req.query

    const venueIdArray = venueIds ? (venueIds as string).split(',').map(id => id.trim()) : undefined

    const results = await getVenuesPaymentReadiness(venueIdArray)

    // Separate ready and not-ready venues
    const readyVenues = results.filter(r => r.canProcessPayments)
    const pendingVenues = results.filter(r => !r.canProcessPayments)

    return res.status(200).json({
      data: {
        ready: readyVenues,
        pending: pendingVenues,
        summary: {
          total: results.length,
          ready: readyVenues.length,
          pending: pendingVenues.length,
        },
      },
    })
  } catch (error) {
    next(error)
  }
}
