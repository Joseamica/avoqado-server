/**
 * Errores que NO dicen nada del negocio: el intent offline se reintenta, nunca se pierde. Una sola lista para el reducer de la
 * cola (`sync.mobile.service`) y para quien compensa dentro de él (`removeIntentPromotions`, Codex r2 N5).
 */
export const CODIGOS_TRANSITORIOS: ReadonlySet<string> = new Set([
  'VERSION_CONFLICT',
  // D25: otra caja movía las mismas comandas de cocina a la vez (`ponerComandasConSuCuenta`); anular o unir sin red se reintenta.
  'KDS_ORDER_OWNER_CHANGED',
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

/** Misma derivación que el reducer: `errorCode ?? code`. */
export function esErrorTransitorio(error: unknown): boolean {
  const e = error as { errorCode?: unknown; code?: unknown } | null
  const codigo = e?.errorCode ?? e?.code
  return typeof codigo === 'string' && CODIGOS_TRANSITORIOS.has(codigo)
}
