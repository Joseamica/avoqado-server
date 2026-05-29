/**
 * AngelPay TPV Webhook Controller — HTTP adapter for the receiver endpoint.
 *
 * Responsibilities:
 *   1. Read merchantAccountId from URL param, look up MerchantAccount + per-row secret
 *   2. Read raw Buffer body (HMAC verification needs exact bytes)
 *   3. Read real AngelPay headers: X-Webhook-Event-Id, X-Webhook-Signature,
 *      X-Webhook-Timestamp, X-Webhook-Event (Express lowercases all header names)
 *   4. Verify HMAC-SHA256 signature:
 *        key  = full secret string including "whsec_" prefix, as raw UTF-8 bytes
 *        body = raw request body bytes exactly as received
 *        output = lowercase hex digest (64 chars)
 *   5. Hand off to the service for matching + reconciliation
 *   6. Map AngelPayWebhookResult → HTTP response (always 200 if signature ok, except 404/503 errors)
 *
 * See: docs/angelpay/WEBHOOK_RECEIVER_SPEC.md §7
 */

import crypto from 'crypto'

import { Request, Response, NextFunction } from 'express'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import type { AngelPayWebhookPayload } from '@/services/tpv/angelpay-webhook.service'
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'

export async function handleAngelPayWebhook(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const merchantAccountId = req.params.merchantAccountId
  if (!merchantAccountId) {
    res.status(400).json({ error: 'missing merchantAccountId path param' })
    return
  }

  const merchantAccount = await prisma.merchantAccount.findFirst({
    where: { id: merchantAccountId, provider: { code: 'ANGELPAY' } },
    select: {
      id: true,
      externalMerchantId: true,
      angelpayWebhookSecret: true,
    },
  })

  if (!merchantAccount) {
    res.status(404).json({ error: 'unknown merchant' })
    return
  }
  if (!merchantAccount.angelpayWebhookSecret) {
    res.status(503).json({ error: 'webhook not provisioned for this merchant' })
    return
  }

  // Real AngelPay header names (Express lowercases them)
  const eventId = req.header('x-webhook-event-id')
  const signature = req.header('x-webhook-signature')

  if (!signature || !eventId) {
    res.status(401).json({ error: 'missing signature headers' })
    return
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}))

  // HMAC-SHA256 with the full secret string (including "whsec_" prefix) as raw UTF-8 key.
  // This is NOT Svix: the key is NOT base64-decoded, NOT stripped. Pass the full string.
  const expected = crypto.createHmac('sha256', merchantAccount.angelpayWebhookSecret).update(rawBody).digest('hex')

  const valid =
    expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))

  if (!valid) {
    logger.warn('🚫 [AngelPay webhook] invalid signature', { merchantAccountId, eventId })
    res.status(401).json({ error: 'invalid signature' })
    return
  }

  let payload: AngelPayWebhookPayload
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as AngelPayWebhookPayload
  } catch {
    res.status(400).json({ error: 'invalid JSON body' })
    return
  }

  try {
    const result = await processAngelPayWebhook({
      payload,
      eventId: eventId,
      merchantAccount: {
        id: merchantAccount.id,
        externalMerchantId: merchantAccount.externalMerchantId,
      },
    })
    res.status(200).json(result)
  } catch (err) {
    logger.error('❌ [AngelPay webhook] unexpected processing error', { err, eventId })
    res.status(200).json({ action: 'ERROR', errorReason: 'PROCESSING_ERROR' })
  }
}

export function angelpayWebhookHealthCheck(_req: Request, res: Response): void {
  res.status(200).json({
    success: true,
    message: 'AngelPay TPV webhook endpoint is healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  })
}
