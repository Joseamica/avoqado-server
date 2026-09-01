import crypto from 'crypto'
import { ACCESS_TOKEN_SECRET } from '../config/env'

/**
 * Stateless, signed customer action tokens (unsubscribe + capture).
 *
 * Goal: allow customers to unsubscribe from marketing emails and verify their birthdate
 * WITHOUT logging in, using stateless signed tokens tied to a specific customer and venue.
 * The token carries exactly who (customer), where (venue), what action, and is HMAC-signed
 * so it can't be forged or enumerated.
 *
 * Security notes:
 * - The signing key is DERIVED from ACCESS_TOKEN_SECRET with a DISTINCT label per purpose,
 *   so a customer unsubscribe token can never be replayed as a staff unsubscribe token
 *   or as a capture token (and vice-versa). No new env var needed.
 * - Purpose-scoped (`p:'cust-unsub'` or `p:'cust-capture'`) — the token authorizes
 *   ONLY its intended action.
 * - Unsubscribe tokens never expire — links in old emails must keep working.
 * - Capture tokens expire in 30 days and are single-use (consumed against a table
 *   that tracks `tokenHash`).
 * - Minimal blast radius: leaked token can only affect one customer, one venue,
 *   one action (idempotent, reversible).
 */

interface UnsubscribePayload {
  v: 1
  p: 'cust-unsub'
  cu: string // customerId
  ve: string // venueId
}

interface CapturePayload {
  v: 1
  p: 'cust-capture'
  cu: string // customerId
  ve: string // venueId
  exp: number // expiresAt epoch ms
  n: string // nonce (base64url)
}

export interface CustomerUnsubscribeTokenData {
  customerId: string
  venueId: string
}

export interface BirthdateCaptureTokenResult {
  token: string
  tokenHash: string
  expiresAt: Date
}

export interface VerifyBirthdateCaptureTokenResult {
  customerId: string
  venueId: string
  tokenHash: string
}

const UNSUB_KEY_LABEL = 'avoqado-customer-unsub-v1'
const CAPTURE_KEY_LABEL = 'avoqado-customer-capture-v1'

function unsubscribeKey(): Buffer {
  return crypto.createHmac('sha256', ACCESS_TOKEN_SECRET).update(UNSUB_KEY_LABEL).digest()
}

function captureKey(): Buffer {
  return crypto.createHmac('sha256', ACCESS_TOKEN_SECRET).update(CAPTURE_KEY_LABEL).digest()
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function sign(b64Body: string, key: Buffer): string {
  return crypto.createHmac('sha256', key).update(b64Body).digest('base64url')
}

export function signCustomerUnsubscribeToken(data: CustomerUnsubscribeTokenData): string {
  const payload: UnsubscribePayload = { v: 1, p: 'cust-unsub', cu: data.customerId, ve: data.venueId }
  const b64Body = b64url(JSON.stringify(payload))
  return `${b64Body}.${sign(b64Body, unsubscribeKey())}`
}

/**
 * Verify + decode unsubscribe token. Returns null for anything malformed, tampered, or wrong-purpose.
 * Uses constant-time comparison so the signature can't be brute-forced by timing.
 */
export function verifyCustomerUnsubscribeToken(token: string | undefined | null): CustomerUnsubscribeTokenData | null {
  if (!token || typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null

  const b64Body = token.slice(0, dot)
  const providedSig = token.slice(dot + 1)
  const expectedSig = sign(b64Body, unsubscribeKey())

  const a = Buffer.from(providedSig)
  const b = Buffer.from(expectedSig)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  let payload: UnsubscribePayload
  try {
    payload = JSON.parse(Buffer.from(b64Body, 'base64url').toString('utf-8'))
  } catch {
    return null
  }

  if (!payload || payload.v !== 1 || payload.p !== 'cust-unsub') return null
  if (typeof payload.cu !== 'string' || typeof payload.ve !== 'string') return null

  return { customerId: payload.cu, venueId: payload.ve }
}

export function signBirthdateCaptureToken(data: CustomerUnsubscribeTokenData): BirthdateCaptureTokenResult {
  const nonce = crypto.randomBytes(16).toString('base64url')
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000)

  const payload: CapturePayload = {
    v: 1,
    p: 'cust-capture',
    cu: data.customerId,
    ve: data.venueId,
    exp: expiresAt.getTime(),
    n: nonce,
  }
  const b64Body = b64url(JSON.stringify(payload))
  const token = `${b64Body}.${sign(b64Body, captureKey())}`
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

  return { token, tokenHash, expiresAt }
}

/**
 * Verify + decode capture token. Returns null for anything malformed, tampered, wrong-purpose,
 * or expired. Uses constant-time comparison so the signature can't be brute-forced by timing.
 */
export function verifyBirthdateCaptureToken(token: string | undefined | null): VerifyBirthdateCaptureTokenResult | null {
  if (!token || typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null

  const b64Body = token.slice(0, dot)
  const providedSig = token.slice(dot + 1)
  const expectedSig = sign(b64Body, captureKey())

  const a = Buffer.from(providedSig)
  const b = Buffer.from(expectedSig)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  let payload: CapturePayload
  try {
    payload = JSON.parse(Buffer.from(b64Body, 'base64url').toString('utf-8'))
  } catch {
    return null
  }

  if (!payload || payload.v !== 1 || payload.p !== 'cust-capture') return null
  if (typeof payload.cu !== 'string' || typeof payload.ve !== 'string') return null
  if (typeof payload.exp !== 'number' || typeof payload.n !== 'string') return null

  // Check expiration
  if (Date.now() > payload.exp) return null

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

  return { customerId: payload.cu, venueId: payload.ve, tokenHash }
}
