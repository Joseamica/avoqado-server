const { spawnSync } = require('node:child_process')
const dotenv = require('dotenv')

dotenv.config()

const source = new URL(process.env.DATABASE_URL)
if (!['localhost', '127.0.0.1'].includes(source.hostname)) {
  throw new Error('H1 test wrapper refuses a non-local DATABASE_URL')
}

// Keep the shared development database untouched by redirecting every H1 test process to its dedicated disposable database.
source.pathname = '/avoqado_h1a_test_20260808'
source.search = ''
source.hash = ''

const testUrl = source.toString()
const [command, ...args] = process.argv.slice(2)
if (!command) {
  throw new Error('usage: node run-with-h1-test-db.cjs <command> [args...]')
}

const commandArgs = command === 'psql' ? [testUrl, ...args] : args

// Prisma config honors USE_RENDER_DB before running any command. Build a
// scrubbed child environment so a poisoned parent shell cannot redirect this
// disposable-only wrapper to Render or another auxiliary database URL.
const childEnv = {
  ...process.env,
  USE_RENDER_DB: 'false',
  DATABASE_URL: testUrl,
  H1_TEST_DATABASE_URL: testUrl,
  TEST_DATABASE_URL: testUrl,
}
for (const remoteAlias of [
  'RENDER_DATABASE_URL',
  'DIRECT_URL',
  'DIRECT_DATABASE_URL',
  'SHADOW_DATABASE_URL',
]) {
  // Empty (instead of absent) also prevents a nested dotenv.config() from
  // repopulating a secret that exists in the repository's .env file.
  childEnv[remoteAlias] = ''
}

const result = spawnSync(command, commandArgs, {
  env: childEnv,
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
