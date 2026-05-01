import { NextFunction, Request, Response } from 'express'
import type { ConsumerAuthContext } from '@/middlewares/consumerAuth.middleware'
import * as reservationConsumerService from '@/services/consumer/reservation.consumer.service'

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { consumerId } = (req as any).consumerAuth as ConsumerAuthContext
    const result = await reservationConsumerService.createReservationForConsumer(consumerId, req.params.venueSlug, req.body)
    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
}

export async function mine(req: Request, res: Response, next: NextFunction) {
  try {
    const { consumerId } = (req as any).consumerAuth as ConsumerAuthContext
    const result = await reservationConsumerService.getConsumerReservations(consumerId)
    res.json(result)
  } catch (error) {
    next(error)
  }
}
