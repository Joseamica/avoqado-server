/**
 * Mobile Refund Controller
 *
 * Handles unassociated refunds for POS mobile apps.
 */

import { NextFunction, Request, Response } from 'express'
import logger from '../../config/logger'
import * as refundService from '../../services/mobile/refund.mobile.service'
import * as refundDashboardService from '../../services/dashboard/refund.dashboard.service'

/**
 * Create unassociated refund
 * @route POST /api/v1/mobile/venues/:venueId/refunds
 */
export const createRefund = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId || ''
    const { amount, reason, method, staffName } = req.body

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'amount es requerido y debe ser mayor a 0' })
    }

    if (!reason) {
      return res.status(400).json({ success: false, message: 'reason es requerido' })
    }

    const result = await refundService.createRefund({
      venueId,
      amount: Number(amount),
      reason,
      method: method || 'CASH',
      staffId,
      staffName,
    })

    return res.status(201).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * Issue an associated refund for a specific payment (mobile wrapper over the
 * dashboard refund service). Supports amount-based and item-based refunds plus
 * optional inventory restock.
 *
 * @route POST /api/v1/mobile/venues/:venueId/payments/:paymentId/refund
 *
 * Body: { amount?: number (cents), items?: [{ orderItemId, quantity? }],
 *         restockItemIds?: string[], reason: RefundReason, note?: string }
 */
export const issueAssociatedRefund = async (req: Request, res: Response, next: NextFunction) => {
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

    const result = await refundDashboardService.issueRefund({
      venueId,
      paymentId,
      amount: typeof amount === 'number' ? amount : undefined,
      items: hasItems ? items : undefined,
      restockItemIds: Array.isArray(restockItemIds) ? restockItemIds : undefined,
      reason: reason as refundDashboardService.RefundReason,
      staffId: req.authContext?.userId,
      note: typeof note === 'string' ? note : null,
      tipRefundCents: typeof tipRefundCents === 'number' ? tipRefundCents : undefined,
    })

    return res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error('Error issuing associated refund (mobile):', error)
    next(error)
  }
}
