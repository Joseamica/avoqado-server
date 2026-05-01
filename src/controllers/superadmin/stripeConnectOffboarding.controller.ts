import { Request, Response, NextFunction } from 'express'
import { offboardVenueStripeConnect } from '../../services/superadmin/stripeConnectOffboarding.service'

export async function offboardVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await offboardVenueStripeConnect(req.params.venueId, (req as any).user?.id)
    res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}
