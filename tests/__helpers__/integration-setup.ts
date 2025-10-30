// tests/__helpers__/integration-setup.ts
//
// Integration test setup - Uses REAL Prisma client (no mocks)
// This file is executed once per test file for integration tests.

// Load .env file for integration tests
import * as dotenv from 'dotenv'
dotenv.config()

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

console.log('Integration test setup loaded (using REAL Prisma client)')

// Note: We do NOT mock Prisma for integration tests
// Integration tests use the real Prisma client to test actual database operations
