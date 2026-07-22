// tests/__helpers__/integration-setup.ts
//
// Integration test setup - Uses REAL Prisma client (no mocks)
// This file is executed once per test file for integration tests.

// Load .env file for integration tests
import * as dotenv from 'dotenv'

const databaseUrlWasPresent = Object.prototype.hasOwnProperty.call(process.env, 'DATABASE_URL')
const databaseUrlFromCaller = process.env.DATABASE_URL
const testDatabaseUrlWasPresent = Object.prototype.hasOwnProperty.call(process.env, 'TEST_DATABASE_URL')
const testDatabaseUrlFromCaller = process.env.TEST_DATABASE_URL

dotenv.config()

// A caller-supplied database override is an isolated pair. dotenv may fill a
// missing companion variable, so restore both sides after loading it. This is
// especially important when pre-deploy launches Jest with only DATABASE_URL:
// a TEST_DATABASE_URL from .env must never silently redirect integration tests.
if (databaseUrlWasPresent || testDatabaseUrlWasPresent) {
  if (databaseUrlWasPresent) {
    process.env.DATABASE_URL = databaseUrlFromCaller
  } else {
    delete process.env.DATABASE_URL
  }

  if (testDatabaseUrlWasPresent) {
    process.env.TEST_DATABASE_URL = testDatabaseUrlFromCaller
  } else if (databaseUrlFromCaller) {
    process.env.TEST_DATABASE_URL = databaseUrlFromCaller
  } else {
    delete process.env.TEST_DATABASE_URL
  }
}

// Set longer timeout for integration tests (real database operations)
jest.setTimeout(60000)

// Set required environment variables for tests
process.env.NODE_ENV = 'test'
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret'
process.env.SESSION_SECRET = 'test-session-secret'
process.env.COOKIE_SECRET = 'test-cookie-secret'

// IMPORTANT: Integration tests use REAL database connection
// Prefer TEST_DATABASE_URL if available, fallback to DATABASE_URL
const testDbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL

if (!testDbUrl) {
  throw new Error(
    '❌ TEST_DATABASE_URL or DATABASE_URL is required for integration tests.\n' +
      '   Please set one of them in your .env file or environment variables.\n' +
      '   Recommended: TEST_DATABASE_URL=postgresql://user:password@host:port/database\n' +
      '   This keeps your dev database separate from test data.',
  )
}

// Use the test database URL
process.env.DATABASE_URL = testDbUrl

console.log(`ℹ️  Using ${process.env.TEST_DATABASE_URL ? 'TEST_DATABASE_URL' : 'DATABASE_URL'} for integration tests`)

// Mock logger to prevent console noise during tests
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
  },
}))

// Mock activity log service (fire-and-forget, not relevant for integration test assertions)
jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

console.log('Integration test setup loaded (using REAL Prisma client)')

// Note: We do NOT mock Prisma for integration tests
// Integration tests use the real Prisma client to test actual database operations
