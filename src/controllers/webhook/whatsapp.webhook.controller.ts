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
    const e = err as { code?: unknown; httpStatus?: unknown; cloudApiErrorCode?: unknown; cause?: { code?: unknown } } | null
    const code = e?.code
    // T-F25 (W11): the cause, never the error's text nor a phone: Meta's HTTP status and code, or the network's (ECONNREFUSED…).
    const number = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : undefined)
    const status = number(e?.httpStatus)
    const metaCode = number(e?.cloudApiErrorCode)
    const cause = [e?.cause?.code, code].find(
      (value): value is string => typeof value === 'string' && /^(E[A-Z0-9_]{2,40}|UND_ERR_[A-Z_]{1,40})$/.test(value),
    )
    logger.error('WhatsApp webhook processing failed', {
      code:
        err instanceof SyntaxError
          ? 'INVALID_JSON'
          : typeof code === 'string' && /^(SUPPORT_[A-Z_]{1,80}|P\d{4})$/.test(code)
            ? code
            : 'DELIVERY_FAILED',
      ...(status !== undefined ? { status } : {}),
      ...(metaCode !== undefined ? { metaCode } : {}),
      ...(cause ? { cause } : {}),
    })
    return res.sendStatus(500)
  }
}
