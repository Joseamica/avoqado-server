import { randomUUID } from 'node:crypto'

/** Header name used on HTTP and mirrored on AMQP message headers. */
export const CORRELATION_HEADER = 'x-correlation-id'

/**
 * Upper bound on an accepted id. A uuid is 36; the slack covers client-side formats that
 * prefix or suffix it. Anything longer is not an id.
 */
const MAX_LENGTH = 64

/** Letters, digits, dash and underscore. Deliberately no colons, spaces, slashes or quotes. */
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/

/**
 * Accepts a client-supplied correlation id, or rejects it.
 *
 * The id is echoed into logs and becomes a searchable field, so it is untrusted input on a
 * path that reaches storage. Two things are being prevented: a client sending something
 * enormous, and a client sending punctuation that would confuse whoever greps the log
 * later. Callers treat `undefined` as "generate a fresh one" — a bad header must never be
 * an error, only an id we decline to reuse.
 *
 * Intentionally looser than strict uuid v4: this platform has clients already sending a
 * correlation id today, and refusing their format would silently break a thread that
 * currently works. Shape and length are what matter for safety, not the exact scheme.
 */
export function sanitizeCorrelationId(raw: unknown): string | undefined {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return undefined

  const value = String(raw).trim()
  if (value.length === 0 || value.length > MAX_LENGTH) return undefined

  return SAFE_ID.test(value) ? value : undefined
}

export function newCorrelationId(): string {
  return randomUUID()
}

/** The id a client sent, when it is safe to reuse, otherwise a fresh one. */
export function resolveCorrelationId(raw: unknown): string {
  return sanitizeCorrelationId(raw) ?? newCorrelationId()
}
