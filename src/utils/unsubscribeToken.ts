import crypto from 'crypto'
import { ACCESS_TOKEN_SECRET } from '../config/env'

/**
 * Stateless, signed one-click email-unsubscribe tokens.
 *
 * Goal: let someone stop receiving a given category of Avoqado emails WITHOUT
 * logging in and regardless of which dashboard account they're signed into.
 * The token carries exactly who (staff), where (venue) and what (category), and
 * is HMAC-signed so it can't be forged or enumerated.
 *
 * Security notes:
 * - The signing key is DERIVED from ACCESS_TOKEN_SECRET (key separation), so an
 *   unsubscribe token can never be replayed as an auth token and vice-versa. No
 *   new env var to provision.
 * - Purpose-scoped (`p:'unsub'`): the token authorizes ONLY unsubscription.
 * - Non-expiring by design — unsubscribe links in old emails must keep working.
 * - Even a leaked token can only turn OFF one person's email channel for one
 *   category (idempotent, reversible from the dashboard). Minimal blast radius.
 */

export type EmailUnsubscribeCategory = 'INVENTORY'

interface UnsubscribePayload {
  v: 1
  p: 'unsub'
  s: string // staffId
  ve: string // venueId
  c: EmailUnsubscribeCategory
}

export interface UnsubscribeTokenData {
  staffId: string
  venueId: string
  category: EmailUnsubscribeCategory
}

const KEY_LABEL = 'avoqado-unsubscribe-token-v1'

function unsubscribeKey(): Buffer {
  // HMAC the fixed label under the app secret → a distinct, stable subkey.
  return crypto.createHmac('sha256', ACCESS_TOKEN_SECRET).update(KEY_LABEL).digest()
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function sign(b64Body: string): string {
  return crypto.createHmac('sha256', unsubscribeKey()).update(b64Body).digest('base64url')
}

export function signUnsubscribeToken(data: UnsubscribeTokenData): string {
  const payload: UnsubscribePayload = { v: 1, p: 'unsub', s: data.staffId, ve: data.venueId, c: data.category }
  const b64Body = b64url(JSON.stringify(payload))
  return `${b64Body}.${sign(b64Body)}`
}

/**
 * Verify + decode. Returns null for anything malformed, tampered, or wrong-purpose.
 * Uses a constant-time comparison so the signature can't be brute-forced by timing.
 */
export function verifyUnsubscribeToken(token: string | undefined | null): UnsubscribeTokenData | null {
  if (!token || typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null

  const b64Body = token.slice(0, dot)
  const providedSig = token.slice(dot + 1)
  const expectedSig = sign(b64Body)

  const a = Buffer.from(providedSig)
  const b = Buffer.from(expectedSig)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  let payload: UnsubscribePayload
  try {
    payload = JSON.parse(Buffer.from(b64Body, 'base64url').toString('utf-8'))
  } catch {
    return null
  }

  if (!payload || payload.v !== 1 || payload.p !== 'unsub') return null
  if (typeof payload.s !== 'string' || typeof payload.ve !== 'string' || payload.c !== 'INVENTORY') return null

  return { staffId: payload.s, venueId: payload.ve, category: payload.c }
}
