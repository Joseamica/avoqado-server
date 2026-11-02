import winston, { type Logform } from 'winston'
import { getContext, type ExecutionContext } from './executionContext'
import { isDemoUser, isDemoVenue } from './venueNames'

const CONTEXTO_AL_LLAMAR = Symbol('contextoAlLlamar')

/**
 * Only the fields `contextFormat` reads: internal ones (`cancellation`, `prismaBatch`) never travel with a line.
 * `negocioFijado` decides the demo mark and is never logged.
 */
type FotoDelContexto = Pick<
  ExecutionContext,
  'correlationId' | 'source' | 'entrypoint' | 'venueId' | 'venueName' | 'userId' | 'role' | 'terminalSerial' | 'negocioFijado'
>

const foto = ({
  correlationId,
  source,
  entrypoint,
  venueId,
  venueName,
  userId,
  role,
  terminalSerial,
  negocioFijado,
}: ExecutionContext): FotoDelContexto => ({
  correlationId,
  source,
  entrypoint,
  venueId,
  venueName,
  userId,
  role,
  terminalSerial,
  negocioFijado,
})

/**
 * hz:f26b3afc:D3 — Each transport runs its format when it WRITES the line, not when the logger was called. When the
 * console or a file backs up, lines wait in a queue and get formatted later, inside another request's or job's context:
 * an alert could carry another business's venue. This takes a snapshot of the context at call time (`logger.write` is
 * synchronous, and every logger method and child goes through it) and `contextFormat` reads only that snapshot.
 * Each write gets its own copy of the record with its own snapshot (Codex r1): the caller's object is never touched, so
 * the same object logged twice carries each call's context, and the snapshot never shows up when the caller logs that
 * object again. A copy of the fields, so what the request adds later (`enrichContext`) does not leak into an earlier line.
 */
export function capturarContextoAlLlamar<T extends winston.Logger>(logger: T): T {
  const write = logger.write.bind(logger) as (...args: unknown[]) => boolean
  logger.write = ((info: unknown, ...resto: unknown[]) => {
    if (!info || typeof info !== 'object') return write(info, ...resto)
    const ctx = getContext()
    return write({ ...info, [CONTEXTO_AL_LLAMAR]: ctx && foto(ctx) }, ...resto)
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
  const ctx: FotoDelContexto | undefined =
    CONTEXTO_AL_LLAMAR in info ? (info as Record<symbol, FotoDelContexto | undefined>)[CONTEXTO_AL_LLAMAR] : getContext()
  const conCtx = conContexto(info, ctx)
  return esActividadDeUnDemo(ctx) ? marcarDemo(conCtx) : conCtx
})

/**
 * ¿La línea la generó un demo? Sólo con certeza: un job que fijó un negocio demo (`conNegocio`) o la sesión de un usuario
 * demo, que el candado sólo deja tocar su propio negocio. NO por el negocio del token ni por un id en los campos: un
 * SUPERADMIN o una persona con un token viejo del demo pueden estar operando otro negocio, y el registro copia ese id
 * (Codex r1 y r2). NO por nombre: un negocio real puede llamarse igual.
 */
function esActividadDeUnDemo(ctx: FotoDelContexto | undefined): boolean {
  if (!ctx) return false
  if (ctx.negocioFijado) return isDemoVenue(ctx.negocioFijado)
  return isDemoUser(ctx.userId)
}

/** «🧪 DEMO ·» y `demo: true`: las alertas de un demo no se confunden con las de un negocio real (founder, 1-nov). No cambia la gravedad. */
function marcarDemo(info: Logform.TransformableInfo): Logform.TransformableInfo {
  const yaLoDice = typeof info.message === 'string' && /demo|🧪/i.test(info.message)
  return { ...info, demo: true, ...(typeof info.message === 'string' && !yaLoDice ? { message: `🧪 DEMO · ${info.message}` } : {}) }
}

function conContexto(info: Logform.TransformableInfo, ctx: FotoDelContexto | undefined): Logform.TransformableInfo {
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
