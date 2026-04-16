/**
 * PostgreSQL connection pool for the legacy avo-pwa database.
 *
 * Read-only, used exclusively by the QR-payments bridge for MindForm.
 * If LEGACY_DATABASE_URL is not set the pool is null — callers must
 * guard against this so the rest of the app is unaffected.
 */

import { Pool } from 'pg'
import logger from '../../config/logger'

let legacyPool: Pool | null = null

if (process.env.LEGACY_DATABASE_URL) {
  legacyPool = new Pool({
    connectionString: process.env.LEGACY_DATABASE_URL,
    max: 3, // low — only MindForm reads
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })

  legacyPool.on('error', err => {
    logger.error('[LegacyPool] Unexpected error on idle client', err)
  })
} else {
  logger.warn('[LegacyPool] LEGACY_DATABASE_URL not set — legacy QR payments disabled')
}

export { legacyPool }
