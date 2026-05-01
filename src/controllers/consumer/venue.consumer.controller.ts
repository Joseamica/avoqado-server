import { NextFunction, Request, Response } from 'express'
import * as venueConsumerService from '@/services/consumer/venue.consumer.service'

export async function search(req: Request, res: Response, next: NextFunction) {
  try {
    const { q, city, limit } = req.query as any
    const result = await venueConsumerService.searchVenues({ q, city, limit })
    res.json(result)
  } catch (error) {
    next(error)
  }
}

export async function detail(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await venueConsumerService.getVenueDetail(req.params.venueSlug)
    res.json(result)
  } catch (error) {
    next(error)
  }
}
