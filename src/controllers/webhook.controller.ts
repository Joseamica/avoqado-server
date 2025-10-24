/**
 * Stripe Webhook Controller
 *
 * Handles incoming webhook events from Stripe
 */

import { Request, Response, NextFunction } from 'express'
import Stripe from 'stripe'
import logger from '../config/logger'
import { handleStripeWebhookEvent } from '../services/stripe.webhook.service'

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-10-28' as any,
})

/**
 * Handle Stripe webhook events
 * POST /webhooks/stripe
 *
 * IMPORTANT: This endpoint must receive raw body (not JSON parsed)
 * for signature verification to work correctly
 */
export async function handleStripeWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  const signature = req.headers['stripe-signature'] as string

  if (!signature) {
    logger.error('❌ Webhook: Missing stripe-signature header')
    res.status(400).json({
      success: false,
      error: 'Missing stripe-signature header',
    })
    return
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  if (!webhookSecret) {
    logger.error('❌ Webhook: STRIPE_WEBHOOK_SECRET not configured')
    res.status(500).json({
      success: false,
      error: 'Webhook secret not configured',
    })
    return
  }

  let event: Stripe.Event

  try {
    // Verify webhook signature and construct event
    // req.body should be raw buffer, NOT parsed JSON
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret)

    logger.info('✅ Webhook: Signature verified', {
      eventId: event.id,
      eventType: event.type,
    })
  } catch (error) {
    logger.error('❌ Webhook: Signature verification failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      signature: signature.substring(0, 20) + '...',
    })

    res.status(400).json({
      success: false,
      error: 'Invalid signature',
    })
    return
  }

  try {
    // Process the event
    await handleStripeWebhookEvent(event)

    // Return 200 OK to Stripe to acknowledge receipt
    res.status(200).json({
      success: true,
      message: 'Webhook processed successfully',
      eventId: event.id,
      eventType: event.type,
    })
  } catch (error) {
    logger.error('❌ Webhook: Event processing failed', {
      eventId: event.id,
      eventType: event.type,
      error: error instanceof Error ? error.message : 'Unknown error',
    })

    // Still return 200 to Stripe to prevent retries
    // Log the error for manual investigation
    res.status(200).json({
      success: false,
      message: 'Webhook received but processing failed',
      eventId: event.id,
      eventType: event.type,
    })
  }
}
