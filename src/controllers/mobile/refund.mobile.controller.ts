/**
 * Mobile Refund Controller
 *
 * Handles unassociated refunds for POS mobile apps.
 */

import { NextFunction, Request, Response } from 'express'
import * as refundService from '../../services/mobile/refund.mobile.service'

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
