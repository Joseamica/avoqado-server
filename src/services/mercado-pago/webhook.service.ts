/**
 * Mercado Pago webhook signature verification.
 *
 * MP signs IPN deliveries with HMAC SHA-256 over a manifest string of the form:
 *   id:<lowercased data.id>;request-id:<x-request-id>;ts:<unix-seconds>;
 *
 * The `x-signature` header has two comma-separated parts: `ts=<ts>,v1=<hex>`.
 * The `data.id` MUST come from the URL query param `?data.id=` (MP's canonical
 * source for signing); we fall back to the JSON body's `data.id` only when the
 * query is absent (some retry deliveries omit query params).
 *
 * Replay protection: timestamps outside ±5 minutes are rejected. MP recommends
 * 5-min tolerance to allow for clock skew while blocking obvious replays.
 *
 * Timing-safe comparison: uses `crypto.timingSafeEqual` so attackers can't
 * binary-search the HMAC byte by byte via response timing.
 *
 * @see https://www.mercadopago.com.mx/developers/es/docs/your-integrations/notifications/webhooks
 */
import crypto from 'crypto'

const TOLERANCE_SECONDS = 300 // 5 minutes — MP-recommended replay window

export interface VerifyWebhookSignatureParams {
  /** Value of `x-signature` header from MP */
  signature: string
  /** Value of `x-request-id` header from MP */
  requestId: string
  /** `data.id` from URL query (?data.id=...) — preferred source per MP docs */
  queryDataId: string | null
  /** `data.id` from JSON body — fallback when query is absent */
  bodyDataId: string | null
}

function requireWebhookSecret(): string {
  const secret = process.env.MP_WEBHOOK_SECRET
  if (!secret) {
    throw new Error('MP_WEBHOOK_SECRET is not set')
  }
  return secret
}

function parseHeader(header: string): { ts: string; v1: string } {
  const parts = header.split(',').map(p => p.trim())
  const map: Record<string, string> = {}
  for (const part of parts) {
    const idx = part.indexOf('=')
    if (idx > 0) {
      const key = part.slice(0, idx)
      const value = part.slice(idx + 1)
      if (key && value) {
        map[key] = value
      }
    }
  }
  if (!map.ts || !map.v1) {
    throw new Error('malformed x-signature header (expected ts=...,v1=...)')
  }
  return { ts: map.ts, v1: map.v1 }
}

export function verifyWebhookSignature(p: VerifyWebhookSignatureParams): void {
  const { ts, v1 } = parseHeader(p.signature)

  const tsNum = parseInt(ts, 10)
  if (Number.isNaN(tsNum)) {
    throw new Error('malformed x-signature timestamp')
  }
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - tsNum) > TOLERANCE_SECONDS) {
    throw new Error(`MP webhook timestamp out of tolerance (replay protection): now=${now}, ts=${tsNum}, max delta=${TOLERANCE_SECONDS}s`)
  }

  // Prefer query data.id; body is fallback for deliveries that lack query params
  const rawDataId = p.queryDataId ?? p.bodyDataId
  if (!rawDataId) {
    throw new Error('no data.id available for signature verification (neither query nor body)')
  }

  // MP normalizes alphanumeric ids to lowercase when signing
  const dataId = rawDataId.toLowerCase()
  const manifest = `id:${dataId};request-id:${p.requestId};ts:${ts};`
  const expectedV1 = crypto.createHmac('sha256', requireWebhookSecret()).update(manifest).digest('hex')

  // Timing-safe comparison. Buffers must have equal length, so we validate
  // the hex string lengths first (cheap pre-check that doesn't leak content).
  if (v1.length !== expectedV1.length) {
    throw new Error('invalid MP webhook signature')
  }
  if (!crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expectedV1, 'hex'))) {
    throw new Error('invalid MP webhook signature')
  }
}
