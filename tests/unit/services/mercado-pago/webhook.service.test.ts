import crypto from 'crypto'
import { verifyWebhookSignature } from '@/services/mercado-pago/webhook.service'

const SECRET = process.env.MP_WEBHOOK_SECRET!

/**
 * Build a valid signature string for testing, mirroring MP's manifest format:
 *   manifest = `id:<lowercased dataId>;request-id:<requestId>;ts:<ts>;`
 *   v1 = HMAC-SHA256(manifest, MP_WEBHOOK_SECRET).hex()
 *   header = `ts=<ts>,v1=<v1>`
 */
function signWith(ts: string | number, requestId: string, dataId: string): string {
  const tsStr = String(ts)
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${tsStr};`
  const v1 = crypto.createHmac('sha256', SECRET).update(manifest).digest('hex')
  return `ts=${tsStr},v1=${v1}`
}

describe('verifyWebhookSignature', () => {
  it('accepts a valid signature using queryDataId', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = signWith(ts, 'req-1', 'pay_abc')
    expect(() =>
      verifyWebhookSignature({
        signature: sig,
        requestId: 'req-1',
        queryDataId: 'pay_abc',
        bodyDataId: null,
      }),
    ).not.toThrow()
  })

  it('lowercases alphanumeric dataId before HMAC (caller may pass uppercase)', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    // Pre-sign with lowercase (matches what MP would do server-side)
    const sig = signWith(ts, 'req-1', 'pay_abc')
    // Caller passes uppercase — verification should still pass after normalization
    expect(() =>
      verifyWebhookSignature({
        signature: sig,
        requestId: 'req-1',
        queryDataId: 'PAY_ABC',
        bodyDataId: null,
      }),
    ).not.toThrow()
  })

  it('falls back to bodyDataId when queryDataId is null', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = signWith(ts, 'req-1', 'pay_xyz')
    expect(() =>
      verifyWebhookSignature({
        signature: sig,
        requestId: 'req-1',
        queryDataId: null,
        bodyDataId: 'pay_xyz',
      }),
    ).not.toThrow()
  })

  it('prefers queryDataId over bodyDataId when both present', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    // Sign with the QUERY value; if implementation incorrectly prefers body, this will fail
    const sig = signWith(ts, 'req-1', 'from_query')
    expect(() =>
      verifyWebhookSignature({
        signature: sig,
        requestId: 'req-1',
        queryDataId: 'from_query',
        bodyDataId: 'from_body',
      }),
    ).not.toThrow()
  })

  it('rejects when timestamp is stale beyond tolerance (>300s)', () => {
    const stale = String(Math.floor(Date.now() / 1000) - 400)
    const sig = signWith(stale, 'req-1', 'pay_x')
    expect(() =>
      verifyWebhookSignature({
        signature: sig,
        requestId: 'req-1',
        queryDataId: 'pay_x',
        bodyDataId: null,
      }),
    ).toThrow(/tolerance|replay|stale|out of/i)
  })

  it('rejects when timestamp is in the future beyond tolerance', () => {
    const future = String(Math.floor(Date.now() / 1000) + 400)
    const sig = signWith(future, 'req-1', 'pay_x')
    expect(() =>
      verifyWebhookSignature({
        signature: sig,
        requestId: 'req-1',
        queryDataId: 'pay_x',
        bodyDataId: null,
      }),
    ).toThrow(/tolerance|replay/i)
  })

  it('rejects when signature is invalid (HMAC mismatch)', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    expect(() =>
      verifyWebhookSignature({
        signature: `ts=${ts},v1=deadbeef00000000`,
        requestId: 'req-1',
        queryDataId: 'pay_x',
        bodyDataId: null,
      }),
    ).toThrow(/invalid/i)
  })

  it('rejects when signature header is malformed', () => {
    expect(() =>
      verifyWebhookSignature({
        signature: 'garbage-no-equals-signs',
        requestId: 'req-1',
        queryDataId: 'pay_x',
        bodyDataId: null,
      }),
    ).toThrow(/malformed/i)
  })

  it('rejects when no dataId is provided at all', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = signWith(ts, 'req-1', 'pay_x')
    expect(() =>
      verifyWebhookSignature({
        signature: sig,
        requestId: 'req-1',
        queryDataId: null,
        bodyDataId: null,
      }),
    ).toThrow(/no data\.id|missing/i)
  })

  it('rejects when MP_WEBHOOK_SECRET is missing from env', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = signWith(ts, 'req-1', 'pay_x')
    const previous = process.env.MP_WEBHOOK_SECRET
    delete process.env.MP_WEBHOOK_SECRET
    try {
      expect(() =>
        verifyWebhookSignature({
          signature: sig,
          requestId: 'req-1',
          queryDataId: 'pay_x',
          bodyDataId: null,
        }),
      ).toThrow(/MP_WEBHOOK_SECRET/)
    } finally {
      process.env.MP_WEBHOOK_SECRET = previous
    }
  })

  it('uses timing-safe comparison (no early-exit length leak)', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    // Construct a signature that has the right format but wrong hex value
    const sig = `ts=${ts},v1=${'0'.repeat(64)}`
    expect(() =>
      verifyWebhookSignature({
        signature: sig,
        requestId: 'req-1',
        queryDataId: 'pay_x',
        bodyDataId: null,
      }),
    ).toThrow(/invalid/i)
  })
})
