import { Request, Response, NextFunction } from 'express'
import { staffSignIn as staffSignInService } from '../../services/tpv/auth.tpv.service'

/**
 * Staff sign-in controller using PIN for TPV access
 * @param req Request object with venueId in params and pin in body
 * @param res Response object
 * @param next Next function for error handling
 * @returns Staff information with venue-specific data
 */
export const staffSignIn = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { pin } = req.body

    const staffData = await staffSignInService(venueId, pin)

    return res.json(staffData)
  } catch (error) {
    next(error)
  }
}
