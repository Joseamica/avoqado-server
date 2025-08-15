import { Request, Response, NextFunction } from 'express'
import * as invitationService from '../services/invitation.service'
import logger from '../config/logger'

export async function getInvitationByToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token: string = req.params.token

    const invitation = await invitationService.getInvitationByToken(token)

    res.status(200).json(invitation)
  } catch (error) {
    logger.error('Error getting invitation by token:', error)
    next(error)
  }
}

export async function acceptInvitation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token: string = req.params.token
    const { firstName, lastName, password, pin } = req.body

    const result = await invitationService.acceptInvitation(token, {
      firstName,
      lastName,
      password,
      pin,
    })

    res.status(200).json({
      message: 'Invitation accepted successfully',
      user: result.user,
      tokens: result.tokens,
    })
  } catch (error) {
    logger.error('Error accepting invitation:', error)
    next(error)
  }
}