const { randomBytes } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { existsSync, lstatSync, realpathSync, symlinkSync } = require('node:fs')
const path = require('node:path')

function attachDeclaredDependencies() {
  const raw = process.env.COMMERCIAL_C3_NODE_MODULES
  if (!raw) return
  if (!path.isAbsolute(raw) || path.basename(raw) !== 'node_modules') {
    throw new Error('COMMERCIAL_C3_NODE_MODULES_REJECTED')
  }
  const target = realpathSync(raw)
  for (const required of ['prisma/build/index.js', 'jest/bin/jest.js', 'pg/package.json', 'dotenv/package.json']) {
    if (!existsSync(path.join(target, required))) throw new Error('COMMERCIAL_C3_NODE_MODULES_INCOMPLETE')
  }
  const destination = path.join(process.cwd(), 'node_modules')
  if (existsSync(destination)) {
    if (!lstatSync(destination).isSymbolicLink() || realpathSync(destination) !== target) {
      throw new Error('COMMERCIAL_C3_NODE_MODULES_DESTINATION_OCCUPIED')
    }
    return
  }
  symlinkSync(target, destination, 'dir')
}

attachDeclaredDependencies()

if (process.env.DOTENV_CONFIG_PATH) {
  require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH, quiet: true })
}

const { Client } = require('pg')

const DATABASE_NAME = /^avoqado_commercial_c3_[0-9]+_[0-9]+_[a-f0-9]{8}_test$/u
const PRISMA_CLI = require.resolve('prisma/build/index.js')
const JEST_CLI = require.resolve('jest/bin/jest')

function localServer(raw) {
  if (!raw) throw new Error('COMMERCIAL_C3_TEST_DATABASE_URL_REQUIRED')
  const url = new URL(raw)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('COMMERCIAL_C3_TEST_DATABASE_URL_REJECTED')
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('COMMERCIAL_C3_NON_LOOPBACK_REJECTED')
  if (!url.username || !url.password) throw new Error('COMMERCIAL_C3_TEST_DATABASE_URL_REJECTED')
  const port = url.port ? Number(url.port) : 5432
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('COMMERCIAL_C3_TEST_DATABASE_URL_REJECTED')
  return {
    host: url.hostname,
    port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  }
}

function quoteDatabaseName(value) {
  if (!DATABASE_NAME.test(value)) throw new Error('COMMERCIAL_C3_DATABASE_NAME_REJECTED')
  return `"${value}"`
}

function databaseUrl(server, database) {
  const url = new URL('postgresql://localhost')
  url.username = server.user
  url.password = server.password
  url.hostname = server.host
  url.port = String(server.port)
  url.pathname = `/${database}`
  return url.toString()
}

function run(command, args, database) {
  const childEnv = {
    ...process.env,
    USE_RENDER_DB: 'false',
    DATABASE_URL: database,
    TEST_DATABASE_URL: database,
    RENDER_DATABASE_URL: '',
    DIRECT_URL: '',
    DIRECT_DATABASE_URL: '',
    SHADOW_DATABASE_URL: '',
  }
  const result = spawnSync(command, args, { env: childEnv, stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? 1
}

async function main() {
  const testPaths = process.argv.slice(2)
  if (testPaths.length === 0 || testPaths.some(path => !/^tests\/integration\/commercial\/[A-Za-z0-9._/-]+\.test\.ts$/u.test(path))) {
    throw new Error('usage: node scripts/commercial/run-c3-integration-tests.cjs <commercial-integration-test> [...]')
  }

  const server = localServer(process.env.DATABASE_URL)
  const databaseName = `avoqado_commercial_c3_${process.pid}_${Date.now()}_${randomBytes(4).toString('hex')}_test`
  const admin = new Client({ ...server, database: 'postgres', ssl: false })
  let created = false
  let exitCode = 1

  await admin.connect()
  try {
    const identity = await admin.query('SELECT current_database() AS database, host(inet_server_addr()) AS address')
    if (identity.rows[0]?.database !== 'postgres' || !['127.0.0.1', '::1'].includes(identity.rows[0]?.address)) {
      throw new Error('COMMERCIAL_C3_MAINTENANCE_IDENTITY_REJECTED')
    }
    await admin.query(`CREATE DATABASE ${quoteDatabaseName(databaseName)}`)
    created = true
    const targetUrl = databaseUrl(server, databaseName)

    const migrateStatus = run(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], targetUrl)
    if (migrateStatus !== 0) return migrateStatus

    exitCode = run(process.execPath, [JEST_CLI, '--selectProjects=integration', '--runInBand', '--runTestsByPath', ...testPaths], targetUrl)
    return exitCode
  } finally {
    if (created) await admin.query(`DROP DATABASE ${quoteDatabaseName(databaseName)} WITH (FORCE)`)
    const cleanup = await admin.query('SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS dropped', [databaseName])
    await admin.end()
    if (!cleanup.rows[0]?.dropped) throw new Error('COMMERCIAL_C3_DATABASE_CLEANUP_FAILED')
  }
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error(error instanceof Error ? error.message : 'COMMERCIAL_C3_INTEGRATION_RUNNER_FAILED')
    process.exit(1)
  })
