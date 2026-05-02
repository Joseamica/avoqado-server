import { NextFunction, Request, Response } from 'express'
import type { ConsumerAuthContext } from '@/middlewares/consumerAuth.middleware'
import * as creditConsumerService from '@/services/consumer/credit.consumer.service'

export async function createCheckout(req: Request, res: Response, next: NextFunction) {
  try {
    const { consumerId } = (req as any).consumerAuth as ConsumerAuthContext
    const { venueSlug, packId } = req.params
    const result = await creditConsumerService.createCreditCheckoutForConsumer(consumerId, venueSlug, packId)
    res.json(result)
  } catch (error) {
    next(error)
  }
}

export async function finalizeCheckout(req: Request, res: Response, next: NextFunction) {
  try {
    const { consumerId } = (req as any).consumerAuth as ConsumerAuthContext
    const { sessionId } = req.body
    const result = await creditConsumerService.finalizeCreditCheckout(consumerId, sessionId)
    res.json(result)
  } catch (error) {
    next(error)
  }
}
