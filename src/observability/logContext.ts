import winston, { type Logform } from 'winston'
import { getContext, type ExecutionContext } from './executionContext'
import { isDemoUser, isDemoVenue } from './venueNames'

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
  const conCtx = conContexto(info, ctx)
  return esActividadDeUnDemo(ctx) ? marcarDemo(conCtx) : conCtx
})

/**
 * ¿La línea la generó un demo? Sólo con certeza: un job que fijó un negocio demo (`conNegocio`) o la sesión de un usuario
 * demo, que el candado sólo deja tocar su propio negocio. NO por el negocio del token ni por un id en los campos: un
 * SUPERADMIN o una persona con un token viejo del demo pueden estar operando otro negocio, y el registro copia ese id
 * (Codex r1 y r2). NO por nombre: un negocio real puede llamarse igual.
 */
function esActividadDeUnDemo(ctx: ExecutionContext | undefined): boolean {
  if (!ctx) return false
  if (ctx.negocioFijado) return isDemoVenue(ctx.negocioFijado)
  return isDemoUser(ctx.userId)
}

/** «🧪 DEMO ·» y `demo: true`: las alertas de un demo no se confunden con las de un negocio real (founder, 1-nov). No cambia la gravedad. */
function marcarDemo(info: Logform.TransformableInfo): Logform.TransformableInfo {
  const yaLoDice = typeof info.message === 'string' && /demo|🧪/i.test(info.message)
  return { ...info, demo: true, ...(typeof info.message === 'string' && !yaLoDice ? { message: `🧪 DEMO · ${info.message}` } : {}) }
}

function conContexto(info: Logform.TransformableInfo, ctx: ExecutionContext | undefined): Logform.TransformableInfo {
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
}
