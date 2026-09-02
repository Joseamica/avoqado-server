import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = path.resolve(__dirname, '../../..')
const harness = path.join(__dirname, 'stripe-checkout-origin-migration-harness.cjs')

function validateConnectionString(connectionString: string) {
  const script = `
    const { localTestServer } = require(${JSON.stringify(harness)});
    try {
      localTestServer(process.env.TEST_DATABASE_URL);
      process.stdout.write('accepted');
    } catch (error) {
      process.stderr.write(String(error.message));
      process.exitCode = 1;
    }
  `
  return spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    env: { ...process.env, TEST_DATABASE_URL: connectionString },
    encoding: 'utf8',
    timeout: 5_000,
  })
}

describe('StripeCheckoutOrigin migration', () => {
  it.each([
    'postgresql://user:password@localhost:5432/av-db-25-test?host=evil.example',
    'postgresql://user:password@localhost:5432/av-db-25-test?port=6543',
    'postgresql://user:password@localhost:5432/av-db-25-test?dbname=postgres',
    'postgresql://user:password@localhost:5432/av-db-25-test?sslmode=require',
  ])('rejects every connection-string query parameter before connecting: %s', connectionString => {
    const validation = validateConnectionString(connectionString)

    expect(validation.status).toBe(1)
    expect(validation.stdout).toBe('')
    expect(validation.stderr).toContain('query parameters')
  })

  it('installs the durable legacy origin constraints in an isolated local PostgreSQL database', () => {
    const replay = spawnSync(process.execPath, [harness], {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
      timeout: 120_000,
    })

    expect({ status: replay.status, stderr: replay.stderr }).toEqual({ status: 0, stderr: '' })
    const evidence = JSON.parse(replay.stdout)
    expect(evidence).toMatchObject({
      migration: '20260823150000_add_stripe_checkout_origin',
      targetValidated: true,
      tablePresent: true,
      primaryKey: ['stripeCheckoutSessionId'],
      exactPairConstraint: true,
      duplicateRejected: true,
      invalidPairRejected: true,
      updateRejected: true,
      deleteRejected: true,
      venueDeleteRestricted: true,
      featureDeleteRestricted: true,
      cleanupConfirmed: true,
    })
  }, 130_000)
})
