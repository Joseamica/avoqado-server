import { NextFunction, Request, Response } from 'express'

import * as manualPaymentService from '@/services/dashboard/manualPayment.service'
import { CreateManualPaymentInput } from '@/schemas/dashboard/manualPayment.schema'

export async function createManualPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = (req as any).authContext
    const body = req.body as CreateManualPaymentInput
    const payment = await manualPaymentService.createManualPayment(venueId, userId, body)
    res.status(201).json({ success: true, data: payment })
  } catch (err) {
    next(err)
  }
}

export async function getExternalSources(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    const limit = Number(req.query.limit ?? 10)
    const sources = await manualPaymentService.getExternalSources(venueId, limit)
    res.json({ success: true, data: sources })
  } catch (err) {
    next(err)
  }
}

export async function getEligibleWaiters(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    const waiters = await manualPaymentService.getEligibleWaiters(venueId)
    res.json({ success: true, data: waiters })
  } catch (err) {
    next(err)
  }
}
