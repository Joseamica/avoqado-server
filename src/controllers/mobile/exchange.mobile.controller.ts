import type { Request, Response, NextFunction } from 'express'
import * as exchangeService from '../../services/exchanges/exchange.service'

export async function completeExchange(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const exchange = await exchangeService.completeExchange({
      venueId: req.params.venueId,
      exchangeId: req.params.exchangeId,
      actorStaffId: req.authContext!.userId,
    })
    res.status(200).json({ success: true, data: { exchange } })
  } catch (error) {
    next(error)
  }
}

export async function createExchange(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { exchange, replay } = await exchangeService.createExchange({
      venueId: req.params.venueId,
      actorStaffId: req.authContext!.userId,
      body: req.body,
    })
    res.status(replay ? 200 : 201).json({ success: true, data: { exchange } })
  } catch (error) {
    next(error)
  }
}
