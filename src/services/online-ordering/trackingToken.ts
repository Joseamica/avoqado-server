import { randomBytes } from 'node:crypto'

export const TRACKING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/

/** 24 bytes aleatorios → 32 caracteres base64url (192 bits). */
export function generateTrackingToken(): string {
  return randomBytes(24).toString('base64url')
}
