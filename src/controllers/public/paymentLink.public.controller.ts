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
 * POST /api/v1/public/payment-links/:shortCode/stripe-checkout
 *
 * Stripe Connect hosted-checkout entry point. The customer never enters card
 * details on Avoqado's domain — we create a Stripe Checkout Session with
 * `application_fee_amount` (Avoqado's margin) and return the redirect URL.
 * The public checkout site (pay.avoqado.io) `window.location.assign`s to it.
 *
 * Body: { amount?, quantity?, tipAmount?, customerEmail?, customFieldResponses?, returnUrl? }
 */
export async function createStripeCheckout(req: Request, res: Response) {
  try {
    const { shortCode } = req.params
    const result = await paymentLinkService.createStripeCheckoutForPaymentLink(shortCode, req.body)
    res.status(201).json({ success: true, data: result })
  } catch (error: any) {
    logger.error('Error creating Stripe checkout for payment link:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al iniciar pago con Stripe',
    })
  }
}

/**
 * POST /api/v1/public/payment-links/:shortCode/payment-intent
 *
 * Stripe Connect Elements (inline) entry point. Creates a PaymentIntent on
 * the connected account with Avoqado's `application_fee_amount` and returns
 * the `client_secret` for the public checkout site to render Stripe Elements
 * inline. Customer never leaves `pay.avoqado.io`.
 *
 * Body: { amount?, quantity?, tipAmount?, customerEmail?, customFieldResponses? }
 */
export async function createStripePaymentIntent(req: Request, res: Response) {
  try {
    const { shortCode } = req.params
    const result = await paymentLinkService.createStripePaymentIntentForPaymentLink(shortCode, req.body)
    res.status(201).json({ success: true, data: result })
  } catch (error: any) {
    logger.error('Error creating Stripe PaymentIntent for payment link:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al iniciar pago con Stripe',
    })
  }
}

/**
 * POST /api/v1/public/payment-links/:shortCode/mp-payment-intent
 *
 * Mercado Pago Bricks (inline) entry point. Returns the seller's publicKey
 * + sessionId so the frontend Brick can initialize and tokenize the card
 * in-iframe. Customer stays on `pay.avoqado.io`.
 *
 * Body: { amount?, tipAmount?, customerEmail?, customFieldResponses? }
 */
export async function createMercadoPagoPaymentIntent(req: Request, res: Response) {
  try {
    const { shortCode } = req.params
    const result = await paymentLinkService.createMercadoPagoPaymentIntentForPaymentLink(shortCode, req.body)
    res.status(201).json({ success: true, data: result })
  } catch (error: any) {
    logger.error('Error creating MP payment intent for payment link:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al iniciar pago con Mercado Pago',
    })
  }
}

/**
 * POST /api/v1/public/payment-links/:shortCode/mp-pay
 *
 * Called by the frontend Brick's onSubmit. Receives the card token + payer
 * info, creates the MP payment on the connected seller's account with
 * `application_fee`, and returns the immediate result (approved/pending/3DS).
 *
 * Final status arrives later via webhook (handleIpn).
 *
 * Body: { sessionId, token, paymentMethodId, installments, issuerId?, payer: {...} }
 */
export async function executeMercadoPagoPayment(req: Request, res: Response) {
  try {
    const { shortCode } = req.params
    const { sessionId, ...payInput } = req.body
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId es requerido' })
    }
    const result = await paymentLinkService.executeMercadoPagoPaymentForPaymentLink(shortCode, sessionId, payInput)
    res.status(201).json({ success: true, data: result })
  } catch (error: any) {
    logger.error('Error executing MP payment for payment link:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al procesar pago con Mercado Pago',
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

/**
 * POST /api/v1/public/payment-links/:shortCode/send-receipt-whatsapp
 * Sends the Stripe-hosted receipt for a completed payment to a customer-
 * provided phone number via the venue's WhatsApp Business template.
 */
export async function sendReceiptWhatsapp(req: Request, res: Response) {
  try {
    const { shortCode } = req.params
    const { sessionId, phone } = req.body as { sessionId: string; phone: string }

    const result = await paymentLinkService.sendPaymentLinkReceiptWhatsapp(shortCode, sessionId, phone)

    res.json({ success: true, data: result })
  } catch (error: any) {
    logger.error('Error sending receipt via WhatsApp:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'No se pudo enviar el recibo por WhatsApp',
    })
  }
}

/**
 * POST /api/v1/public/payment-links/:shortCode/send-receipt-email
 * Emails the Stripe-hosted receipt for a completed payment to a customer-
 * supplied address using the existing transactional template.
 */
export async function sendReceiptEmail(req: Request, res: Response) {
  try {
    const { shortCode } = req.params
    const { sessionId, email } = req.body as { sessionId: string; email: string }

    const result = await paymentLinkService.sendPaymentLinkReceiptEmail(shortCode, sessionId, email)

    res.json({ success: true, data: result })
  } catch (error: any) {
    logger.error('Error sending receipt via email:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'No se pudo enviar el recibo por correo',
    })
  }
}
