import { NextFunction, Request, Response } from 'express'
import * as authConsumerService from '@/services/consumer/auth.consumer.service'
import type { ConsumerAuthContext } from '@/middlewares/consumerAuth.middleware'

export async function oauthLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authConsumerService.loginWithOAuth(req.body)
    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

export async function me(req: Request, res: Response, next: NextFunction) {
  try {
    const { consumerId } = (req as any).consumerAuth as ConsumerAuthContext
    const result = await authConsumerService.getMe(consumerId)
    res.json(result)
  } catch (error) {
    next(error)
  }
}
