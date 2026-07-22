// tests/__helpers__/integration-setup.ts
//
// Integration test setup - Uses REAL Prisma client (no mocks)
// This file is executed once per test file for integration tests.

// Load .env file for integration tests
import * as dotenv from 'dotenv'

const testDatabaseUrlWasPresent = Object.prototype.hasOwnProperty.call(process.env, 'TEST_DATABASE_URL')
const testDatabaseUrlFromCaller = process.env.TEST_DATABASE_URL

dotenv.config()

// Integration teardown performs broad fixture cleanup. Only a TEST_DATABASE_URL
// explicitly supplied by the caller before dotenv loading is allowed to select
// that database; DATABASE_URL and dotenv values are never accepted as fallbacks.
if (!testDatabaseUrlWasPresent || !testDatabaseUrlFromCaller?.trim()) {
  delete process.env.DATABASE_URL
  delete process.env.TEST_DATABASE_URL
  throw new Error('Export a non-empty TEST_DATABASE_URL before running integration tests.')
}

process.env.TEST_DATABASE_URL = testDatabaseUrlFromCaller
process.env.DATABASE_URL = testDatabaseUrlFromCaller

// Set longer timeout for integration tests (real database operations)
jest.setTimeout(60000)

// Set required environment variables for tests
process.env.NODE_ENV = 'test'
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret'
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret'
process.env.SESSION_SECRET = 'test-session-secret'
process.env.COOKIE_SECRET = 'test-cookie-secret'
process.env.OTP_PEPPER = 'test-otp-pepper-secret'
// Some app-level integration suites import module-load singletons. A dummy key
// lets those deterministic paths initialize without authorizing a real request.
process.env.OPENAI_API_KEY = 'sk-test-dummy-for-jest'
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_for_jest'
// Never inherit a developer or release broker from dotenv in integration tests.
// Port 1 is deliberately inert; suites that exercise messaging mock the client.
process.env.RABBITMQ_URL = 'amqp://127.0.0.1:1'

console.log('ℹ️  Using caller-supplied TEST_DATABASE_URL for integration tests')

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
