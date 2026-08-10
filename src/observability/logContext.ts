import winston from 'winston'
import { getContext } from './executionContext'

/**
 * Injects the active execution context into every log record.
 *
 * This is why no call site had to change: the ~600 places that already pass a
 * correlationId by hand keep working, and every other `logger.*` in the codebase gains the
 * venue, the user and the entry point for free.
 *
 * Call-site fields win. `...info` is spread LAST on purpose, so an explicit venueId at the
 * call site is never overwritten by the ambient one — the caller knows something we don't.
 *
 * Only fields that have a value are injected, so a cron tick does not stamp
 * `venueId: undefined` onto every line and make the output noisier than it was before.
 *
 * Lives here rather than in config/logger.ts so it can be unit-tested: the test suite
 * mocks `@/config/logger` globally (tests/__helpers__/setup.ts) to keep logs quiet, which
 * would hide anything exported from there.
 */
export const contextFormat = winston.format(info => {
  const ctx = getContext()
  if (!ctx) return info

  const injected: Record<string, unknown> = {
    correlationId: ctx.correlationId,
    source: ctx.source,
    entrypoint: ctx.entrypoint,
  }
  if (ctx.venueId) injected.venueId = ctx.venueId
  if (ctx.userId) injected.userId = ctx.userId
  if (ctx.role) injected.role = ctx.role
  if (ctx.terminalSerial) injected.terminalSerial = ctx.terminalSerial

  return { ...injected, ...info }
})
