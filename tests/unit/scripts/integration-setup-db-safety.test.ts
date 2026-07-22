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
  refreshTokenSecret: string | null
  otpPepper: string | null
  openaiApiKey: string | null
  rabbitmqUrl: string | null
  stripeSecretKey: string | null
  error: string | null
}

const DOTENV_DATABASE_URL = 'dotenv-production-database-sentinel'
const DOTENV_TEST_DATABASE_URL = 'dotenv-production-test-sentinel'
const CALLER_DATABASE_URL = 'caller-database-sentinel'
const CALLER_TEST_DATABASE_URL = 'caller-test-database-sentinel'
const REQUIRED_TEST_ENV = {
  refreshTokenSecret: 'test-refresh-token-secret',
  otpPepper: 'test-otp-pepper-secret',
  openaiApiKey: 'sk-test-dummy-for-jest',
  rabbitmqUrl: 'amqp://127.0.0.1:1',
  stripeSecretKey: 'sk_test_dummy_for_jest',
}

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
        '  refreshTokenSecret: process.env.REFRESH_TOKEN_SECRET ?? null,',
        '  otpPepper: process.env.OTP_PEPPER ?? null,',
        '  openaiApiKey: process.env.OPENAI_API_KEY ?? null,',
        '  rabbitmqUrl: process.env.RABBITMQ_URL ?? null,',
        '  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? null,',
        '  error: setupError,',
        '}));',
      ].join('\n'),
    )

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      TS_NODE_PROJECT: path.join(repoRoot, 'tsconfig.json'),
      TS_NODE_TRANSPILE_ONLY: 'true',
    }
    delete childEnv.DATABASE_URL
    delete childEnv.TEST_DATABASE_URL
    delete childEnv.REFRESH_TOKEN_SECRET
    delete childEnv.OTP_PEPPER
    delete childEnv.OPENAI_API_KEY
    delete childEnv.RABBITMQ_URL
    delete childEnv.STRIPE_SECRET_KEY
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
  it('rejects DATABASE_URL-only callers and removes dotenv database values', () => {
    const result = runIntegrationSetup({ databaseUrl: CALLER_DATABASE_URL })

    expect(result.databaseUrl).toBeNull()
    expect(result.testDatabaseUrl).toBeNull()
    expect(result.error).toContain('Export a non-empty TEST_DATABASE_URL before running integration tests')
    expect(result.error).not.toContain(CALLER_DATABASE_URL)
    expect(result.error).not.toContain(DOTENV_DATABASE_URL)
    expect(result.error).not.toContain(DOTENV_TEST_DATABASE_URL)
  })

  it('uses a caller TEST_DATABASE_URL for both effective database variables', () => {
    expect(runIntegrationSetup({ testDatabaseUrl: CALLER_TEST_DATABASE_URL })).toEqual({
      databaseUrl: CALLER_TEST_DATABASE_URL,
      testDatabaseUrl: CALLER_TEST_DATABASE_URL,
      ...REQUIRED_TEST_ENV,
      error: null,
    })
  })

  it('preserves an explicit pair and intentionally selects explicit TEST_DATABASE_URL', () => {
    expect(runIntegrationSetup({ databaseUrl: CALLER_DATABASE_URL, testDatabaseUrl: CALLER_TEST_DATABASE_URL })).toEqual({
      databaseUrl: CALLER_TEST_DATABASE_URL,
      testDatabaseUrl: CALLER_TEST_DATABASE_URL,
      ...REQUIRED_TEST_ENV,
      error: null,
    })
  })

  it('rejects dotenv-only database values and removes them from the process', () => {
    const result = runIntegrationSetup({})

    expect(result.databaseUrl).toBeNull()
    expect(result.testDatabaseUrl).toBeNull()
    expect(result.error).toContain('Export a non-empty TEST_DATABASE_URL before running integration tests')
    expect(result.error).not.toContain(DOTENV_DATABASE_URL)
    expect(result.error).not.toContain(DOTENV_TEST_DATABASE_URL)
  })

  it('rejects an explicitly empty TEST_DATABASE_URL even when DATABASE_URL is set', () => {
    const result = runIntegrationSetup({ databaseUrl: CALLER_DATABASE_URL, testDatabaseUrl: '' })

    expect(result.databaseUrl).toBeNull()
    expect(result.testDatabaseUrl).toBeNull()
    expect(result.error).toContain('Export a non-empty TEST_DATABASE_URL before running integration tests')
  })

  it('rejects an explicitly empty DATABASE_URL when TEST_DATABASE_URL is absent', () => {
    const result = runIntegrationSetup({ databaseUrl: '' })

    expect(result.databaseUrl).toBeNull()
    expect(result.testDatabaseUrl).toBeNull()
    expect(result.error).toContain('Export a non-empty TEST_DATABASE_URL before running integration tests')
  })

  it('provides every required non-database value without relying on dotenv', () => {
    const result = runIntegrationSetup({ testDatabaseUrl: CALLER_TEST_DATABASE_URL })

    expect(result).toMatchObject({
      ...REQUIRED_TEST_ENV,
      error: null,
    })
  })

  it('runs the complete integration project serially', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }

    expect(packageJson.scripts['test:integration']).toContain('--runInBand')
  })
})
