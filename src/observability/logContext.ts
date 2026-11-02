import winston from 'winston'
import { getContext, type ExecutionContext } from './executionContext'

const CONTEXTO_AL_LLAMAR = Symbol('contextoAlLlamar')

/**
 * hz:f26b3afc:D3 — Each transport runs its format when it WRITES the line, not when the logger was called. When the
 * console or a file backs up, lines wait in a queue and get formatted later, inside another request's or job's context:
 * an alert could carry another business's venue. This takes a snapshot of the context at call time (`logger.write` is
 * synchronous, and every logger method and child goes through it) and `contextFormat` reads only that snapshot. It is a
 * copy, so what the request adds later (`enrichContext`) does not leak into an earlier line.
 */
export function capturarContextoAlLlamar<T extends winston.Logger>(logger: T): T {
  const write = logger.write.bind(logger) as (...args: unknown[]) => boolean
  logger.write = ((info: unknown, ...resto: unknown[]) => {
    if (info && typeof info === 'object' && !(CONTEXTO_AL_LLAMAR in info)) {
      const ctx = getContext()
      ;(info as Record<symbol, ExecutionContext | undefined>)[CONTEXTO_AL_LLAMAR] = ctx ? { ...ctx } : undefined
    }
    return write(info, ...resto)
  }) as T['write']
  return logger
}

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
 *
 * The context comes from the snapshot `capturarContextoAlLlamar` took when the logger was CALLED. Without one (someone
 * ran the format by hand, synchronously, as the unit tests do), it is read now.
 */
export const contextFormat = winston.format(info => {
  const ctx = CONTEXTO_AL_LLAMAR in info ? (info as Record<symbol, ExecutionContext | undefined>)[CONTEXTO_AL_LLAMAR] : getContext()
  if (!ctx) return info

  const injected: Record<string, unknown> = {
    correlationId: ctx.correlationId,
    source: ctx.source,
    entrypoint: ctx.entrypoint,
  }
  if (ctx.venueId) injected.venueId = ctx.venueId
  if (ctx.venueName) injected.venueName = ctx.venueName
  if (ctx.userId) injected.userId = ctx.userId
  if (ctx.role) injected.role = ctx.role
  if (ctx.terminalSerial) injected.terminalSerial = ctx.terminalSerial

  return { ...injected, ...info }
})
