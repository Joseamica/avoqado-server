/**
 * Payment Link Public Controller
 *
 * Handles public (unauthenticated) checkout flow for payment links.
 * Used by the avoqado-checkout frontend (pay.avoqado.io).
 *
 * @module controllers/public/paymentLink
 */

import { Request, Response } from 'express'
import * as paymentLinkService from '@/services/dashboard/paymentLink.service'
import logger from '@/config/logger'

/**
 * GET /api/v1/public/payment-links/:shortCode
 * Resolves a payment link by short code — returns venue branding + link data
 */
export async function resolvePaymentLink(req: Request, res: Response) {
  try {
    const { shortCode } = req.params

    const data = await paymentLinkService.getPaymentLinkByShortCode(shortCode)

    res.json({
      success: true,
      data,
    })
  } catch (error: any) {
    logger.error('Error resolving payment link:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Liga de pago no encontrada',
    })
  }
}

/**
 * POST /api/v1/public/payment-links/:shortCode/checkout
 * Creates a checkout session: tokenizes card, prepares for charge
 */
export async function createCheckout(req: Request, res: Response) {
  try {
    const { shortCode } = req.params

    const result = await paymentLinkService.createCheckoutSession(shortCode, req.body)

    res.status(201).json({
      success: true,
      data: result,
    })
  } catch (error: any) {
    logger.error('Error creating checkout session:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al procesar el pago',
    })
  }
}

/**
 * POST /api/v1/public/payment-links/:shortCode/charge
 * Completes the charge after 3DS (if applicable)
 */
export async function completeCharge(req: Request, res: Response) {
  try {
    const { shortCode } = req.params
    const { sessionId, threeDSTransactionId } = req.body

    const result = await paymentLinkService.completeCharge(shortCode, sessionId, threeDSTransactionId)

    res.json({
      success: true,
      data: result,
    })
  } catch (error: any) {
    logger.error('Error completing charge:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al completar el cobro',
    })
  }
}

/**
 * GET /api/v1/public/payment-links/:shortCode/session/:sessionId
 * Gets session status (for polling after 3DS redirect)
 */
export async function getSessionStatus(req: Request, res: Response) {
  try {
    const { shortCode, sessionId } = req.params

    const result = await paymentLinkService.getSessionStatus(shortCode, sessionId)

    res.json({
      success: true,
      data: result,
    })
  } catch (error: any) {
    logger.error('Error getting session status:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Sesión no encontrada',
    })
  }
}
