/**
 * Mobile Refund Controller
 *
 * Handles unassociated refunds for POS mobile apps.
 */

import { NextFunction, Request, Response } from 'express'
import logger from '../../config/logger'
import * as refundService from '../../services/mobile/refund.mobile.service'
import * as refundDashboardService from '../../services/dashboard/refund.dashboard.service'
import { esCantidadNoNegativaEnCentavos, esCantidadPositivaEnCentavos } from '../../services/shared/devueltoDeUnCobro'

/**
 * Create unassociated refund
 * @route POST /api/v1/mobile/venues/:venueId/refunds
 */
export const createRefund = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId || ''
    const { amount, reason, method, staffName } = req.body

    if (!esCantidadPositivaEnCentavos(amount)) {
      return res.status(400).json({ success: false, message: 'amount debe ser un entero seguro positivo expresado en centavos' })
    }

    if (!reason) {
      return res.status(400).json({ success: false, message: 'reason es requerido' })
    }

    // Sólo métodos reales: un valor inventado acabaría en la columna `method`
    // del pago y ensuciaría el desglose del corte en silencio.
    const METODOS_VALIDOS = ['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'DIGITAL_WALLET', 'BANK_TRANSFER', 'OTHER']
    const metodo = method || 'CASH'
    if (!METODOS_VALIDOS.includes(metodo)) {
      return res.status(400).json({ success: false, message: 'Método de reembolso inválido' })
    }

    const result = await refundService.createRefund({
      venueId,
      amount: Number(amount),
      reason,
      method: metodo,
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
    if (amount !== undefined && !esCantidadPositivaEnCentavos(amount)) {
      return res.status(400).json({ success: false, message: 'amount debe ser un entero seguro positivo expresado en centavos' })
    }
    if (tipRefundCents !== undefined && !esCantidadNoNegativaEnCentavos(tipRefundCents)) {
      return res.status(400).json({ success: false, message: 'tipRefundCents debe ser un entero seguro no negativo expresado en centavos' })
    }
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
