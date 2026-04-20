import { NextFunction, Request, Response } from 'express'
import logger from '../../config/logger'
import * as refundService from '../../services/dashboard/refund.dashboard.service'

/**
 * Issue a refund against an existing payment.
 * @route POST /api/v1/dashboard/venues/:venueId/payments/:paymentId/refund
 *
 * Body: { amount: number (cents), reason: RefundReason, note?: string }
 */
export async function issueRefund(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, paymentId } = req.params
    const { amount, items, restockItemIds, reason, note, tipRefundCents } = req.body ?? {}

    const hasItems = Array.isArray(items) && items.length > 0
    if (!hasItems && (typeof amount !== 'number' || amount <= 0)) {
      return res.status(400).json({
        success: false,
        message: 'Se requiere `amount` (centavos) o `items` con al menos un elemento',
      })
    }
    if (!reason || typeof reason !== 'string') {
      return res.status(400).json({ success: false, message: 'reason es requerido' })
    }

    const result = await refundService.issueRefund({
      venueId,
      paymentId,
      amount: typeof amount === 'number' ? amount : undefined,
      items: hasItems ? items : undefined,
      restockItemIds: Array.isArray(restockItemIds) ? restockItemIds : undefined,
      reason: reason as refundService.RefundReason,
      staffId: req.authContext?.userId,
      note: typeof note === 'string' ? note : null,
      tipRefundCents: typeof tipRefundCents === 'number' ? tipRefundCents : undefined,
    })

    return res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error('Error issuing refund (dashboard):', error)
    next(error)
  }
}

/**
 * List refunds for a given payment (for drawer display).
 * @route GET /api/v1/dashboard/venues/:venueId/payments/:paymentId/refunds
 */
export async function listRefunds(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, paymentId } = req.params
    const refunds = await refundService.listRefundsForPayment(venueId, paymentId)
    return res.status(200).json({ success: true, data: refunds })
  } catch (error) {
    next(error)
  }
}
