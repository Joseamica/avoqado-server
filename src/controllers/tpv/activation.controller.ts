import { Request, Response, NextFunction } from 'express'
import {
  activateTerminal as activateTerminalService,
  checkTerminalActivationStatus as checkTerminalActivationStatusService,
} from '../../services/dashboard/terminal-activation.service'

/**
 * Activate terminal controller
 * @param req Request with serialNumber and activationCode in body
 * @param res Response object
 * @param next Next function for error handling
 * @returns Venue information after successful activation
 */
export const activateTerminal = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serialNumber, activationCode } = req.body

    const activationResult = await activateTerminalService(serialNumber, activationCode)

    return res.status(200).json(activationResult)
  } catch (error) {
    next(error)
  }
}

/**
 * Check terminal activation status controller
 * @param req Request with serialNumber in URL params
 * @param res Response object
 * @param next Next function for error handling
 * @returns Activation status (isActivated, venueId, status, message)
 */
export const checkActivationStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serialNumber } = req.params

    const statusResult = await checkTerminalActivationStatusService(serialNumber)

    return res.status(200).json(statusResult)
  } catch (error) {
    next(error)
  }
}
