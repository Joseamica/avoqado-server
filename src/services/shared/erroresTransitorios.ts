import { isDeadlockError, isModelLockTimeoutError, isRetryableDbError } from '@/utils/serializableRetry'

/**
 * Errores que NO dicen nada del negocio: el intent offline se reintenta, nunca se pierde. Una sola lista para el reducer de la
 * cola (`sync.mobile.service`) y para quien compensa dentro de él (`removeIntentPromotions`, Codex r2 N5). La ronda con promociones
 * decide con la LISTA; todo lo demás, con `esErrorTransitorio` (que además lee el SQLSTATE de choque envuelto).
 */
export const CODIGOS_TRANSITORIOS: ReadonlySet<string> = new Set([
  'VERSION_CONFLICT',
  // Prisma / PostgreSQL transitorios: nunca deben convertirse en cuarentena.
  'P1001', // database unreachable
  'P1002', // connection timeout
  'P1008', // operation timeout
  'P1017', // connection closed
  'P2024', // connection pool timeout
  'P2028', // interactive transaction timeout (p. ej. `cancelOrder` esperando el lock de la orden con el pool saturado)
  'P2034', // transaction conflict / deadlock
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
])

/**
 * Misma derivación que el reducer: `errorCode ?? code`. Además, un error de la BASE sin código de dominio es transitorio si el
 * SQLSTATE que Prisma deja ADENTRO es de choque —40P01, 40001 o 55P03 en el `meta.code` de un `P2010` (consulta cruda) o en el
 * mensaje de un error de modelo sin código—: así sale un interbloqueo que agotó `withDeadlockRetry` (hz:381780f0:D1, Codex r4
 * #2 de D25). Un `P2010` con otro SQLSTATE (un SQL roto) sigue siendo definitivo.
 */
export function esErrorTransitorio(error: unknown): boolean {
  const e = error as { errorCode?: unknown; code?: unknown } | null
  const codigo = e?.errorCode ?? e?.code
  if (typeof codigo === 'string' && CODIGOS_TRANSITORIOS.has(codigo)) return true
  return e?.errorCode == null && (isDeadlockError(error) || isRetryableDbError(error) || isModelLockTimeoutError(error))
}
