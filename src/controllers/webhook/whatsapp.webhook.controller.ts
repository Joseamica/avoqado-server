import { Request, Response } from 'express'

import logger from '@/config/logger'
import { getWhatsappVerifyToken } from '@/config/whatsappCloud'
import { processWhatsappWebhook } from '@/services/whatsappWebhook.service'

// GET /api/v1/webhooks/whatsapp — Meta verification handshake.
// Meta sends this once when you configure the webhook URL to confirm you
// own the endpoint. We echo back hub.challenge if hub.verify_token matches
// the secret we configured on both sides. Per spec §Webhook verification.
export function handleWhatsappVerify(req: Request, res: Response) {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === getWhatsappVerifyToken()) {
    return res.status(200).send(String(req.query['hub.challenge']))
  }
  return res.sendStatus(403)
}

// POST /api/v1/webhooks/whatsapp — inbound message dispatcher.
// Body was preserved as Buffer by express.raw() so HMAC could verify against
// the exact bytes Meta sent. Parse to JSON now (after middleware) and hand
// off to the service. On any throw we return 500 so Meta retries.
export async function handleWhatsappInbound(req: Request, res: Response) {
  try {
    const payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : '{}')
    await processWhatsappWebhook(payload)
    return res.sendStatus(200)
  } catch (err) {
    logger.error('WhatsApp webhook processing failed', { err: (err as Error).message })
    return res.sendStatus(500)
  }
}
