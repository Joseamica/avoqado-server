/**
 * Venue Checkout Public Controller
 *
 * Public (unauthenticated) checkout flow keyed by venue slug — used by the
 * embeddable checkout widget (`<avoqado-checkout data-venue="...">`). Mirrors
 * the payment-link public controller but charges a venue directly with a
 * host/customer-provided amount, no payment link.
 *
 * @module controllers/public/venueCheckout
 */

import { Request, Response } from 'express'
import * as venueCheckoutService from '@/services/dashboard/venueCheckout.service'
import logger from '@/config/logger'

/** GET /api/v1/public/venues/:venueSlug/checkout-info */
export async function getCheckoutInfo(req: Request, res: Response) {
  try {
    const { venueSlug } = req.params
    const data = await venueCheckoutService.getVenueCheckoutInfo(venueSlug)
    res.json({ success: true, data })
  } catch (error: any) {
    logger.error('Error resolving venue checkout info:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'No se pudo cargar la información de cobro' })
  }
}

/** POST /api/v1/public/venues/:venueSlug/checkout/payment-intent (Stripe) */
export async function createStripePaymentIntent(req: Request, res: Response) {
  try {
    const { venueSlug } = req.params
    const data = await venueCheckoutService.createStripePaymentIntentForVenue(venueSlug, req.body)
    res.status(201).json({ success: true, data })
  } catch (error: any) {
    logger.error('Error creating Stripe PaymentIntent for venue checkout:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Error al iniciar pago con Stripe' })
  }
}

/** POST /api/v1/public/venues/:venueSlug/checkout/mp-payment-intent (MP) */
export async function createMercadoPagoPaymentIntent(req: Request, res: Response) {
  try {
    const { venueSlug } = req.params
    const data = await venueCheckoutService.createMercadoPagoPaymentIntentForVenue(venueSlug, req.body)
    res.status(201).json({ success: true, data })
  } catch (error: any) {
    logger.error('Error creating MP payment intent for venue checkout:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Error al iniciar pago con Mercado Pago' })
  }
}

/** POST /api/v1/public/venues/:venueSlug/checkout/mp-pay (MP Brick submit) */
export async function executeMercadoPagoPayment(req: Request, res: Response) {
  try {
    const { venueSlug } = req.params
    const { sessionId, ...payInput } = req.body
    const data = await venueCheckoutService.executeMercadoPagoPaymentForVenue(venueSlug, sessionId, payInput)
    res.status(201).json({ success: true, data })
  } catch (error: any) {
    logger.error('Error executing MP payment for venue checkout:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Error al procesar pago con Mercado Pago' })
  }
}

/** GET /api/v1/public/venues/:venueSlug/checkout/session/:sessionId */
export async function getSessionStatus(req: Request, res: Response) {
  try {
    const { venueSlug, sessionId } = req.params
    const data = await venueCheckoutService.getVenueCheckoutSessionStatus(venueSlug, sessionId)
    res.json({ success: true, data })
  } catch (error: any) {
    logger.error('Error getting venue checkout session status:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Sesión no encontrada' })
  }
}
