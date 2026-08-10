'use strict'

const { spawnSync } = require('node:child_process')

const LOCK_TIMEOUT_OPTION = '-c lock_timeout=5s'

/**
 * Prisma migrations are immutable after deployment, so lock policy belongs on the
 * connection that executes them. PostgreSQL applies `options` while opening the
 * session, before Prisma can issue the first statement that might wait on a table.
 */
function buildBoundedDatabaseUrl(rawUrl) {
  const url = new URL(rawUrl)
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use the PostgreSQL protocol')
  }

  const existingOptions = url.searchParams.get('options')?.trim()
  url.searchParams.set('options', [existingOptions, LOCK_TIMEOUT_OPTION].filter(Boolean).join(' '))
  return url.toString()
}

function buildBoundedEnvironment(source = process.env) {
  const useRenderUrl = source.USE_RENDER_DB === 'true' && Boolean(source.RENDER_DATABASE_URL)
  const rawUrl = useRenderUrl ? source.RENDER_DATABASE_URL : source.DATABASE_URL
  if (!rawUrl) throw new Error('DATABASE_URL is required for migrate deploy')

  const boundedUrl = buildBoundedDatabaseUrl(rawUrl)
  return {
    ...source,
    DATABASE_URL: boundedUrl,
    ...(useRenderUrl ? { RENDER_DATABASE_URL: boundedUrl } : {}),
  }
}

function run() {
  const result = spawnSync(process.execPath, [require.resolve('prisma'), 'migrate', 'deploy'], {
    env: buildBoundedEnvironment(),
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

if (require.main === module) {
  try {
    run()
  } catch (error) {
    // Never print DATABASE_URL: it contains production credentials.
    console.error(`Unable to run bounded Prisma migration: ${error instanceof Error ? error.message : 'unknown error'}`)
    process.exitCode = 1
  }
}

module.exports = { buildBoundedDatabaseUrl, buildBoundedEnvironment, run }
