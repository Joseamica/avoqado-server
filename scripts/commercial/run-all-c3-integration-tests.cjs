const { readdirSync } = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '../..')
const integrationDirectory = path.join(repoRoot, 'tests/integration/commercial')
const isolatedRunner = path.join(__dirname, 'run-c3-integration-tests.cjs')
const excluded = new Set(['commercial-contract-v2-migration.integration.test.ts'])

const testPaths = readdirSync(integrationDirectory)
  .filter(file => file.endsWith('.integration.test.ts') && !excluded.has(file))
  .sort()
  .map(file => path.posix.join('tests/integration/commercial', file))

if (testPaths.length === 0) {
  throw new Error('COMMERCIAL_C3_INTEGRATION_TESTS_NOT_FOUND')
}

for (const testPath of testPaths) {
  console.log(`[commercial-c3-isolated] ${testPath}`)
  const result = spawnSync(process.execPath, [isolatedRunner, testPath], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
