import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

type DatabaseOverride = {
  databaseUrl?: string
  testDatabaseUrl?: string
}

type SetupResult = {
  databaseUrl: string | null
  testDatabaseUrl: string | null
  error: string | null
}

const DOTENV_DATABASE_URL = 'postgresql://dotenv-db:fake@production.invalid:5432/dotenv_db'
const DOTENV_TEST_DATABASE_URL = 'postgresql://dotenv-test:fake@production.invalid:5432/dotenv_test'
const CALLER_DATABASE_URL = 'postgresql://caller-db:fake@127.0.0.1:55432/caller_db'
const CALLER_TEST_DATABASE_URL = 'postgresql://caller-test:fake@127.0.0.1:55432/caller_test'

function runIntegrationSetup(overrides: DatabaseOverride): SetupResult {
  const repoRoot = process.cwd()
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-integration-setup-'))
  const runnerPath = path.join(fixtureDir, 'run-setup.cjs')
  const setupPath = path.join(repoRoot, 'tests/__helpers__/integration-setup.ts')
  const tsNodeRegister = require.resolve('ts-node/register/transpile-only')

  try {
    fs.writeFileSync(
      path.join(fixtureDir, '.env'),
      [`DATABASE_URL=${DOTENV_DATABASE_URL}`, `TEST_DATABASE_URL=${DOTENV_TEST_DATABASE_URL}`].join('\n'),
    )
    fs.writeFileSync(
      runnerPath,
      [
        'global.jest = { setTimeout() {}, mock() {} };',
        'let setupError = null;',
        `try { require(${JSON.stringify(setupPath)}); } catch (error) { setupError = error instanceof Error ? error.message : String(error); }`,
        "process.stdout.write('\\n@@DATABASE_SETUP@@' + JSON.stringify({",
        '  databaseUrl: process.env.DATABASE_URL ?? null,',
        '  testDatabaseUrl: process.env.TEST_DATABASE_URL ?? null,',
        '  error: setupError,',
        '}));',
      ].join('\n'),
    )

    const childEnv = {
      ...process.env,
      TS_NODE_PROJECT: path.join(repoRoot, 'tsconfig.json'),
      TS_NODE_TRANSPILE_ONLY: 'true',
    }
    delete childEnv.DATABASE_URL
    delete childEnv.TEST_DATABASE_URL
    if (Object.prototype.hasOwnProperty.call(overrides, 'databaseUrl')) {
      childEnv.DATABASE_URL = overrides.databaseUrl
    }
    if (Object.prototype.hasOwnProperty.call(overrides, 'testDatabaseUrl')) {
      childEnv.TEST_DATABASE_URL = overrides.testDatabaseUrl
    }

    const result = spawnSync(process.execPath, ['--require', tsNodeRegister, runnerPath], {
      cwd: fixtureDir,
      encoding: 'utf8',
      env: childEnv,
    })
    expect(result.status).toBe(0)

    const marker = '@@DATABASE_SETUP@@'
    const markerIndex = result.stdout.lastIndexOf(marker)
    expect(markerIndex).toBeGreaterThanOrEqual(0)
    return JSON.parse(result.stdout.slice(markerIndex + marker.length)) as SetupResult
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true })
  }
}

describe('integration setup database isolation', () => {
  it('keeps a caller DATABASE_URL isolated when dotenv defines TEST_DATABASE_URL', () => {
    expect(runIntegrationSetup({ databaseUrl: CALLER_DATABASE_URL })).toEqual({
      databaseUrl: CALLER_DATABASE_URL,
      testDatabaseUrl: CALLER_DATABASE_URL,
      error: null,
    })
  })

  it('uses a caller TEST_DATABASE_URL for both effective database variables', () => {
    expect(runIntegrationSetup({ testDatabaseUrl: CALLER_TEST_DATABASE_URL })).toEqual({
      databaseUrl: CALLER_TEST_DATABASE_URL,
      testDatabaseUrl: CALLER_TEST_DATABASE_URL,
      error: null,
    })
  })

  it('preserves an explicit pair and intentionally selects explicit TEST_DATABASE_URL', () => {
    expect(runIntegrationSetup({ databaseUrl: CALLER_DATABASE_URL, testDatabaseUrl: CALLER_TEST_DATABASE_URL })).toEqual({
      databaseUrl: CALLER_TEST_DATABASE_URL,
      testDatabaseUrl: CALLER_TEST_DATABASE_URL,
      error: null,
    })
  })

  it('retains legacy dotenv selection when neither variable is caller-supplied', () => {
    expect(runIntegrationSetup({})).toEqual({
      databaseUrl: DOTENV_TEST_DATABASE_URL,
      testDatabaseUrl: DOTENV_TEST_DATABASE_URL,
      error: null,
    })
  })

  it('never lets dotenv replace an explicitly empty database override', () => {
    const result = runIntegrationSetup({ databaseUrl: '' })

    expect(result.databaseUrl).toBe('')
    expect(result.testDatabaseUrl).toBeNull()
    expect(result.error).toContain('TEST_DATABASE_URL or DATABASE_URL is required')
  })
})
