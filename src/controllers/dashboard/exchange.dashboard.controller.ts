import type { NextFunction, Request, Response } from 'express'
import { UnauthorizedError } from '@/errors/AppError'
import * as service from '@/services/dashboard/exchange.dashboard.service'
import { listExchangesSchema } from '@/schemas/dashboard/exchange.dashboard.schema'
import type { z } from 'zod'

export async function listExchanges(req: Request, res: Response, next: NextFunction) {
  try {
    const { pendingReview, limit, offset } = req.query as unknown as z.infer<typeof listExchangesSchema>['query']
    const data = await service.listExchangesForReview({ venueId: req.params.venueId, pendingReview, limit, offset })
    const hayMas = offset + data.items.length < data.total
    res.status(200).json({ success: true, data: { ...data, hayMas, siguienteOffset: hayMas ? offset + data.items.length : null } })
  } catch (error) {
    next(error)
  }
}

export async function reviewExchange(req: Request, res: Response, next: NextFunction) {
  try {
    const staffId = req.authContext?.userId
    if (!staffId) throw new UnauthorizedError('Inicia sesión para revisar el cambio')
    const data = await service.markExchangeReviewed({
      venueId: req.params.venueId,
      exchangeId: req.params.exchangeId,
      staffId,
      note: req.body.note,
    })
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
