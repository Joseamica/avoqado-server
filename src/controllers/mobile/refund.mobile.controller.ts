/**
 * Mobile Refund Controller
 *
 * Handles unassociated refunds for POS mobile apps.
 */

import { NextFunction, Request, Response } from 'express'
import logger from '../../config/logger'
import AppError from '../../errors/AppError'
import * as refundService from '../../services/mobile/refund.mobile.service'
import type { RefundReason } from '../../services/dashboard/refund.dashboard.service'
import { issuePosRefund } from '../../services/storeCredit/storeCreditRefund.service'
import { esCantidadNoNegativaEnCentavos, esCantidadPositivaEnCentavos, vieneAusente } from '../../services/shared/devueltoDeUnCobro'

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
 *         restockItemIds?: string[], reason: RefundReason, note?: string,
 *         tipRefundCents?: number (cents), refundMethod?: 'CASH' | 'BANK_TRANSFER' | 'STORE_CREDIT',
 *         customerId?: string, idempotencyKey?: string, defective?: boolean }
 *
 * Saldo a favor (spec 2026-10-30-saldo-a-favor §5.5, campos nuevos y opcionales): `STORE_CREDIT` abona lo devuelto al sobre de
 * `customerId`, con `idempotencyKey` obligatoria; la respuesta trae `storeCredit`. `defective` sólo cuenta con «Sólo saldo a favor».
 */
export const issueAssociatedRefund = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, paymentId } = req.params
    const { amount, items, restockItemIds, reason, note, tipRefundCents, refundMethod, customerId, idempotencyKey, defective } =
      req.body ?? {}

    const hasItems = Array.isArray(items) && items.length > 0
    if (!vieneAusente(amount) && !esCantidadPositivaEnCentavos(amount)) {
      return res.status(400).json({ success: false, message: 'amount debe ser un entero seguro positivo expresado en centavos' })
    }
    if (!vieneAusente(tipRefundCents) && !esCantidadNoNegativaEnCentavos(tipRefundCents)) {
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
    if (!vieneAusente(refundMethod) && refundMethod !== 'CASH' && refundMethod !== 'BANK_TRANSFER' && refundMethod !== 'STORE_CREDIT') {
      return res.status(400).json({ success: false, message: 'refundMethod debe ser CASH, BANK_TRANSFER o STORE_CREDIT' })
    }
    if (!vieneAusente(defective) && typeof defective !== 'boolean') {
      return res.status(400).json({ success: false, message: 'defective debe ser true o false' })
    }
    for (const [campo, valor] of [
      ['customerId', customerId],
      ['idempotencyKey', idempotencyKey],
    ] as const) {
      if (!vieneAusente(valor) && typeof valor !== 'string') {
        return res.status(400).json({ success: false, message: `${campo} debe ser texto` })
      }
    }

    const result = await issuePosRefund({
      venueId,
      paymentId,
      amount: typeof amount === 'number' ? amount : undefined,
      items: hasItems ? items : undefined,
      restockItemIds: Array.isArray(restockItemIds) ? restockItemIds : undefined,
      reason: reason as RefundReason,
      staffId: req.authContext?.userId,
      note: typeof note === 'string' ? note : null,
      tipRefundCents: typeof tipRefundCents === 'number' ? tipRefundCents : undefined,
      refundMethod: vieneAusente(refundMethod) ? undefined : refundMethod,
      customerId: vieneAusente(customerId) ? undefined : customerId,
      idempotencyKey: vieneAusente(idempotencyKey) ? undefined : idempotencyKey,
      defective: defective === true,
    })

    return res.status(201).json({ success: true, data: result })
  } catch (error) {
    // Un rechazo de NEGOCIO (4xx) no es una falla del servidor: aviso, no error (mismo criterio que el dashboard).
    if (error instanceof AppError && error.statusCode < 500) logger.warn(`Refund rejected (mobile): ${error.message}`)
    else logger.error('Error issuing associated refund (mobile):', error)
    next(error)
  }
}
