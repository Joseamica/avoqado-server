/**
 * Crypto Payment TPV Controller
 *
 * Handles cryptocurrency payment initiation from TPV terminals.
 * Works with B4Bit payment gateway.
 */

import { Request, Response, NextFunction } from 'express'
import logger from '../../config/logger'
import { initiateCryptoPayment, cancelCryptoPayment, getPaymentStatus } from '../../services/b4bit/b4bit.service'
import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'

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

    const { amount, tip, staffId, shiftId, orderId, orderNumber, deviceSerialNumber, rating } = req.body

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
      shiftId,
      orderId,
      orderNumber,
      deviceSerialNumber,
      rating,
    })

    res.status(200).json({
      success: true,
      data: {
        requestId: result.requestId,
        paymentId: result.paymentId,
        paymentUrl: result.paymentUrl,
        expiresAt: result.expiresAt,
        expiresInSeconds: result.expiresInSeconds,
        cryptoSymbol: result.cryptoSymbol,
        cryptoAddress: result.cryptoAddress,
      },
      message: 'Crypto payment initiated successfully',
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
    const { paymentId, requestId, reason } = req.body

    let resolvedPaymentId = paymentId

    // TPV sends requestId (B4Bit external ID), resolve to internal paymentId
    if (!resolvedPaymentId && requestId) {
      const payment = await prisma.payment.findFirst({
        where: { externalId: requestId },
        select: { id: true },
      })
      if (payment) {
        resolvedPaymentId = payment.id
      }
    }

    if (!resolvedPaymentId) {
      throw new BadRequestError('paymentId or requestId is required')
    }

    logger.info('🚫 TPV: Cancelling crypto payment', { paymentId: resolvedPaymentId, reason })

    await cancelCryptoPayment(resolvedPaymentId)

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
