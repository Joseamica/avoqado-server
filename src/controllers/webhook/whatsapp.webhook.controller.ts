import { Request, Response } from 'express'

import { getWhatsappVerifyToken } from '@/config/whatsappCloud'

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
// Implemented in subsequent tasks (4.3 HMAC middleware, 4.4 dedup + dispatch).
// For now: always 200 so Meta's "Test" button in the Configuración panel
// doesn't show errors before the full handler exists.
export async function handleWhatsappInbound(_req: Request, res: Response) {
  return res.sendStatus(200)
}
