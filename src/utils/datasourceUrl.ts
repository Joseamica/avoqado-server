// src/utils/datasourceUrl.ts
// Sin importar Prisma: así también lo lee quien corre con el cliente simulado (S10, el tope de simulaciones).

/**
 * Builds the datasource URL with an explicit `connection_limit`.
 *
 * Prisma reads the pool size ONLY from the URL query string. The default
 * (num_physical_cores * 2 + 1 = 9 on the prod host) is too small: a single
 * burst of ~9 parallel org-analytics queries saturates it and every other
 * query fails with P2024 (incident 2026-06-23). We raise it via env so it can
 * be tuned without a code change.
 *
 * Sizing: prod Postgres max_connections=103 (~100 usable). This single-process
 * app also holds a session pg.Pool (max 5) + a LISTEN/NOTIFY client (1), so at
 * 18 → 18 + 6 = 24 steady-state, leaving ~76 free for migrate/psql/burst. Do
 * NOT exceed ~30 on this instance.
 *
 * Guards:
 * - If the URL already declares `connection_limit` (e.g. set directly in the
 *   Render secret), we respect it and add nothing.
 * - If the URL points at a transaction-mode pooler (`pgbouncer=true`), we add
 *   nothing — there `connection_limit` MUST be 1 and is the operator's call.
 * - `pool_timeout` is left at Prisma's default (10s) on purpose, so the app
 *   fails fast under exhaustion instead of hanging longer.
 *
 * Exported so the poll-budget measurement builds its client with THIS recipe
 * instead of a copy that could drift (tests/integration/customer-display/pollBudget.ts).
 */
export function buildDatasourceUrl(): string | undefined {
  const base = process.env.DATABASE_URL
  if (!base) return undefined
  if (/[?&]connection_limit=/.test(base) || /[?&]pgbouncer=true/.test(base)) return base
  const limit = process.env.DATABASE_CONNECTION_LIMIT || '18'
  return `${base}${base.includes('?') ? '&' : '?'}connection_limit=${limit}`
}
