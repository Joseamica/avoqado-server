import { NextFunction, Request, Response } from 'express'

import * as manualPaymentService from '@/services/dashboard/manualPayment.service'
import { CreateManualPaymentInput } from '@/schemas/dashboard/manualPayment.schema'

/**
 * 🔴 R6-2 (ronda 6 post-QA de sellos tardíos; Codex recheck-10 P2): en los tres handlers, UNA sola sucursal por operación — la de
 * la URL (`req.params.venueId`). Es la que evalúa `checkPermission('payment:create-manual')`, y la convención de los controllers del
 * panel. Con la del TOKEN, una sesión de A pedía `/venues/B/payments/manual`: el permiso se comprobaba en B y se escribía en A.
 */
export async function createManualPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = (req as any).authContext
    const { venueId } = req.params
    const body = req.body as CreateManualPaymentInput
    const payment = await manualPaymentService.createManualPayment(venueId, userId, body)
    res.status(201).json({ success: true, data: payment })
  } catch (err) {
    next(err)
  }
}

export async function getExternalSources(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const limit = Number(req.query.limit ?? 10)
    const sources = await manualPaymentService.getExternalSources(venueId, limit)
    res.json({ success: true, data: sources })
  } catch (err) {
    next(err)
  }
}

export async function getEligibleWaiters(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const waiters = await manualPaymentService.getEligibleWaiters(venueId)
    res.json({ success: true, data: waiters })
  } catch (err) {
    next(err)
  }
}
