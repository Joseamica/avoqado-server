import logger from '../config/logger'
import AppError from './AppError'

/**
 * Log a controller exception at the level it deserves.
 *
 * PROBLEM: the mobile controllers logged EVERY exception at `error` — including
 * the ones the code raises on purpose ("este establecimiento está suspendido",
 * "tu contraseña cambió"). `error` is the level alerting keys on, so a customer
 * signing into a suspended venue looked exactly like a crash. Measured in a live
 * pass: 3 of the 5 `error:` lines in the window were expected 401/403s.
 *
 * THE LINE: `AppError.isOperational` plus a 4xx status — something the caller
 * did wrong that this code already anticipated and answered. Everything else,
 * including a 5xx AppError and any exception we did not model, stays `error`.
 * When in doubt it shouts: a real failure logged as `warn` is the expensive
 * mistake, a rejection logged as `error` is only noise.
 */
export function logControllerError(context: string, error: unknown): void {
  const anticipated = error instanceof AppError && error.isOperational && error.statusCode >= 400 && error.statusCode < 500

  const reason = error instanceof Error ? error.message : String(error)

  if (anticipated) {
    // No stack: an anticipated rejection has nothing to debug, and the stack is
    // what makes these lines expensive to read past.
    logger.warn(`[${context}] rechazo esperado: ${reason}`, { statusCode: (error as AppError).statusCode })
    return
  }

  logger.error(`[${context}] ${reason}`, error)
}
