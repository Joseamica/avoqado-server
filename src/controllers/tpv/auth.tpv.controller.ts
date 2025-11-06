import { Request, Response, NextFunction } from 'express'
import {
  staffSignIn as staffSignInService,
  refreshAccessToken as refreshAccessTokenService,
  staffLogout as staffLogoutService,
} from '../../services/tpv/auth.tpv.service'

/**
 * Staff sign-in controller using PIN for TPV access
 * @param req Request object with venueId in params and pin + serialNumber in body
 * @param res Response object
 * @param next Next function for error handling
 * @returns Staff information with venue-specific data
 */
export const staffSignIn = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { pin, serialNumber } = req.body

    const staffData = await staffSignInService(venueId, pin, serialNumber)

    return res.json(staffData)
  } catch (error) {
    next(error)
  }
}

/**
 * Refresh access token controller for TPV
 * @param req Request object with refreshToken in body
 * @param res Response object
 * @param next Next function for error handling
 * @returns New access token with updated expiration
 */
export const refreshAccessToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body

    const tokenData = await refreshAccessTokenService(refreshToken)

    return res.json(tokenData)
  } catch (error) {
    next(error)
  }
}

/**
 * Staff logout controller for TPV
 * @param req Request object with accessToken in body
 * @param res Response object
 * @param next Next function for error handling
 * @returns Success message with logout timestamp
 */
export const staffLogout = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accessToken } = req.body

    const logoutData = await staffLogoutService(accessToken)

    return res.json(logoutData)
  } catch (error) {
    next(error)
  }
}
