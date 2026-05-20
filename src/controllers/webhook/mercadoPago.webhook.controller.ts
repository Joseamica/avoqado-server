/**
 * Mercado Pago IPN webhook handler.
 *
 * Pipeline:
 *   1. Extract x-signature + x-request-id headers
 *   2. Parse the raw body (this route is mounted with express.raw())
 *   3. Verify HMAC signature (lowercased data.id from query, 5-min replay window)
 *   4. Dispatch to payment-flow.handleIpn (dedupe → fetch → update DB)
 *   5. Always return 200 on dispatch attempt (avoids MP retry storms) —
 *      our dedupe table is the recovery handle for ops/forensics.
 *
 * The 401 case is the only non-200 path. We intentionally return 200 even
 * when handleIpn returns "error", because:
 *   - The row is in MercadoPagoWebhookEvent with processingStatus='error'
 *   - Ops can replay manually via a cron or admin tool
 *   - MP retries would just re-trigger the same error
 */
import { Request, Response } from 'express'
import logger from '@/config/logger'
import { verifyWebhookSignature } from '@/services/mercado-pago/webhook.service'
import { handleIpn } from '@/services/mercado-pago/payment-flow.service'
import type { MercadoPagoWebhookPayload } from '@/services/mercado-pago/types'

export async function handleMercadoPagoWebhook(req: Request, res: Response) {
  const signature = req.get('x-signature')
  const requestId = req.get('x-request-id')
  if (!signature || !requestId) {
    return res.status(400).json({ error: 'missing x-signature or x-request-id' })
  }

  // The route is mounted with express.raw(), so req.body is a Buffer.
  let payload: MercadoPagoWebhookPayload
  try {
    payload = JSON.parse((req.body as Buffer).toString('utf8'))
  } catch {
    return res.status(400).json({ error: 'invalid JSON body' })
  }

  // MP signs against the data.id from the URL query string. Body fallback
  // for retry deliveries that omit query params.
  const queryDataId = typeof req.query['data.id'] === 'string' ? req.query['data.id'] : null
  const bodyDataId = payload?.data?.id ? String(payload.data.id) : null

  try {
    verifyWebhookSignature({ signature, requestId, queryDataId, bodyDataId })
  } catch (err: any) {
    logger.warn('[MP webhook] signature verification failed', {
      err: err.message,
      requestId,
    })
    return res.status(401).json({ error: 'invalid signature' })
  }

  try {
    const result = await handleIpn({ payload, requestId })
    logger.info('[MP webhook] dispatched', { result, requestId })
    return res.status(200).json({ received: true, ...result })
  } catch (err: any) {
    logger.error('[MP webhook] dispatch failed', { err: err.message, requestId })
    // Return 200 so MP doesn't retry indefinitely. The MercadoPagoWebhookEvent
    // row (if it was created before the throw) tracks the error for forensics.
    return res.status(200).json({ received: true, error: 'dispatch_failed' })
  }
}
