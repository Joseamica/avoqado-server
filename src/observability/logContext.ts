import winston, { type Logform } from 'winston'
import { getContext, type ExecutionContext } from './executionContext'
import { isDemoVenue } from './venueNames'

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
  return isDemoVenue(negocioDeLaLinea(info, ctx)) ? marcarDemo(conContexto(info, ctx)) : conContexto(info, ctx)
})

/**
 * De qué negocio ES la línea, para saber si es demo: el que da el emisor; si no, el que fijó el job (`conNegocio`); si no,
 * el de la sesión, salvo de un SUPERADMIN, cuya sesión puede estar en un demo mientras revisa otro negocio (Codex r1).
 * Nunca por nombre: un negocio real puede llamarse igual.
 */
function negocioDeLaLinea(info: Logform.TransformableInfo, ctx: ExecutionContext | undefined): string | undefined {
  if (typeof info.venueId === 'string') return info.venueId
  return ctx?.negocioFijado ?? (ctx?.role === 'SUPERADMIN' ? undefined : ctx?.venueId)
}

/**
 * Una línea de un negocio demo (`LIVE_DEMO`) sale «🧪 DEMO ·» y con `demo: true`: así sus alertas no se confunden con las
 * de un negocio real (founder, 1-nov). No cambia la gravedad.
 */
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
