import { PrismaClient } from '@prisma/client'

/**
 * Prisma Client Singleton
 *
 * ⚠️ CRITICAL DESIGN DECISION:
 * This file exports a SINGLE instance of PrismaClient to prevent multiple connection pools.
 *
 * Why singleton?
 * - Each PrismaClient instance creates its own connection pool to the database
 * - Multiple instances = exhausted database connections + performance degradation
 * - Singleton pattern = one pool shared across entire application
 *
 * Usage: Import this instance everywhere you need database access
 * ```typescript
 * import prisma from '@/utils/prismaClient'
 * const users = await prisma.user.findMany()
 * ```
 *
 * Connection pooling is configured via DATABASE_URL parameters
 */

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
 */
function buildDatasourceUrl(): string | undefined {
  const base = process.env.DATABASE_URL
  if (!base) return undefined
  if (/[?&]connection_limit=/.test(base) || /[?&]pgbouncer=true/.test(base)) return base
  const limit = process.env.DATABASE_CONNECTION_LIMIT || '18'
  return `${base}${base.includes('?') ? '&' : '?'}connection_limit=${limit}`
}

const datasourceUrl = buildDatasourceUrl()

const prisma = datasourceUrl
  ? new PrismaClient({
      datasources: { db: { url: datasourceUrl } },
      // log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
    })
  : new PrismaClient({
      // log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
    })

// Graceful shutdown to close database connections
process.on('beforeExit', async () => {
  await prisma.$disconnect()
})

process.on('SIGINT', async () => {
  await prisma.$disconnect()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await prisma.$disconnect()
  process.exit(0)
})

// For debugging (uncomment if needed):
// const prisma = new PrismaClient({
//   log: [
//     {
//       emit: 'stdout',
//       level: 'query',
//     },
//     {
//       emit: 'stdout',
//       level: 'info',
//     },
//     {
//       emit: 'stdout',
//       level: 'warn',
//     },
//     {
//       emit: 'stdout',
//       level: 'error',
//     },
//   ],
// });

export default prisma
