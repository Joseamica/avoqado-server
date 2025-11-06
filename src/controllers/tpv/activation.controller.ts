import { Request, Response, NextFunction } from 'express'
import { activateTerminal as activateTerminalService } from '../../services/dashboard/terminal-activation.service'

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
