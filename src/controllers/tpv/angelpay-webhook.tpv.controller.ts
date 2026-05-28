/**
 * AngelPay TPV Webhook Controller — HTTP adapter for the receiver endpoint.
 *
 * Responsibilities:
 *   1. Read merchantAccountId from URL param, look up MerchantAccount + per-row secret
 *   2. Read raw Buffer body (svix verification needs exact bytes)
 *   3. Normalize Svix headers (accept webhook-* aliases per AngelPay's reference impl)
 *   4. Verify signature with the per-merchant secret
 *   5. Hand off to the service for cross-check + matching
 *   6. Map AngelPayWebhookResult → HTTP response (always 200 if signature ok, except 404/503 errors)
 *
 * See: docs/angelpay/WEBHOOK_RECEIVER_SPEC.md §7
 */

import { Request, Response, NextFunction } from 'express'
import { Webhook } from 'svix'

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
      venueConfigsPrimary: { select: { venueId: true }, take: 1 },
      venueConfigsSecondary: { select: { venueId: true }, take: 1 },
      venueConfigsTertiary: { select: { venueId: true }, take: 1 },
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

  // Resolve venueId via VenuePaymentConfig join chain (MerchantAccount has no direct venueId)
  const venueId =
    merchantAccount.venueConfigsPrimary[0]?.venueId ??
    merchantAccount.venueConfigsSecondary[0]?.venueId ??
    merchantAccount.venueConfigsTertiary[0]?.venueId ??
    null
  if (!venueId) {
    res.status(503).json({ error: 'merchant has no venue assigned' })
    return
  }

  // Accept svix-* or webhook-* aliases
  const headers = {
    'svix-id': req.header('svix-id') ?? req.header('webhook-id'),
    'svix-timestamp': req.header('svix-timestamp') ?? req.header('webhook-timestamp'),
    'svix-signature': req.header('svix-signature') ?? req.header('webhook-signature'),
  }
  if (!headers['svix-id'] || !headers['svix-timestamp'] || !headers['svix-signature']) {
    res.status(401).json({ error: 'missing signature headers' })
    return
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}))

  let payload: AngelPayWebhookPayload
  try {
    payload = new Webhook(merchantAccount.angelpayWebhookSecret).verify(
      rawBody,
      headers as Record<string, string>,
    ) as AngelPayWebhookPayload
  } catch {
    logger.warn('🚫 [AngelPay webhook] invalid signature', { merchantAccountId, svixId: headers['svix-id'] })
    res.status(401).json({ error: 'invalid signature' })
    return
  }

  try {
    const result = await processAngelPayWebhook({
      payload,
      svixId: headers['svix-id']!,
      merchantAccount: {
        id: merchantAccount.id,
        venueId,
        externalMerchantId: merchantAccount.externalMerchantId,
      },
    })
    res.status(200).json(result)
  } catch (err) {
    logger.error('❌ [AngelPay webhook] unexpected processing error', { err, svixId: headers['svix-id'] })
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
