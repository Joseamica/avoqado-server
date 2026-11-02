/**
 * Crypto Payment TPV Controller
 *
 * Handles cryptocurrency payment initiation from TPV terminals.
 * Works with B4Bit payment gateway.
 */

import { Request, Response, NextFunction } from 'express'
import logger from '../../config/logger'
import {
  initiateCryptoPayment,
  cancelCryptoPayment,
  getPaymentStatus,
  getCryptoOperationForVenue,
} from '../../services/b4bit/b4bit.service'
import { BadRequestError } from '../../errors/AppError'

/**
 * POST /api/v1/tpv/venues/:venueId/crypto/initiate
 *
 * Initiate a crypto payment from TPV.
 * Creates a pending payment and returns B4Bit payment URL for QR display.
 */
export async function initiateCryptoPaymentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId = req.params.venueId
    const orgId = req.authContext?.orgId

    if (!orgId) {
      throw new BadRequestError('Organization ID not found in auth context')
    }

    // 🔴 El `shiftId` del cuerpo NO se reenvía: el turno lo resuelve el servidor por `venueId`
    // (aislamiento de tenant, 3-sep-2026). El esquema lo sigue aceptando para no romper a una app
    // que todavía lo mande, pero nadie lo lee.
    const { amount, tip, staffId, orderId, orderNumber, deviceSerialNumber, rating, idempotencyKey } = req.body

    logger.info('🔐 TPV: Initiating crypto payment', {
      venueId,
      amount,
      tip,
      staffId,
      orderId,
    })

    const result = await initiateCryptoPayment({
      venueId,
      orgId,
      amount, // In centavos
      tip: tip || 0,
      staffId,
      orderId,
      orderNumber,
      deviceSerialNumber,
      rating,
      idempotencyKey,
      actorStaffId: req.authContext?.userId,
      terminalSerialNumber: req.authContext?.terminalSerialNumber,
    })

    res.status(200).json({
      success: true,
      data:
        'operation' in result
          ? result
          : {
              requestId: result.requestId,
              paymentId: result.paymentId,
              paymentUrl: result.paymentUrl,
              expiresAt: result.expiresAt,
              expiresInSeconds: result.expiresInSeconds,
              cryptoSymbol: result.cryptoSymbol,
              cryptoAddress: result.cryptoAddress,
              // En qué turno de caja quedó el cobro (`null` = el negocio no tenía ninguno abierto).
              shiftId: result.shiftId ?? null,
            },
      message: 'operation' in result ? 'Estado de la operación cripto' : 'Crypto payment initiated successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/tpv/venues/:venueId/crypto/cancel
 *
 * Cancel a pending crypto payment.
 */
export async function cancelCryptoPaymentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { paymentId, requestId } = req.body

    await cancelCryptoPayment({
      venueId: req.params.venueId,
      staffId: req.authContext?.userId ?? '',
      paymentId,
      requestId,
    })

    res.status(200).json({
      success: true,
      message: 'Crypto payment cancelled',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/tpv/venues/:venueId/crypto/status/:requestId
 *
 * Get the status of a crypto payment (polling fallback).
 */
export async function getCryptoPaymentStatusHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { requestId } = req.params

    if (!requestId) {
      throw new BadRequestError('requestId is required')
    }

    logger.info('🔍 TPV: Checking crypto payment status', { requestId })

    const venueId = req.params.venueId
    const status = await getPaymentStatus(requestId, venueId)

    res.status(200).json({
      success: true,
      data: status,
    })
  } catch (error) {
    next(error)
  }
}

export async function getCryptoOperationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const serial = req.authContext?.terminalSerialNumber
    if (!serial) throw new BadRequestError('Se requiere la terminal autenticada')
    const result = await getCryptoOperationForVenue(req.params.venueId, req.params.idempotencyKey, serial, req.authContext?.userId)
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}
