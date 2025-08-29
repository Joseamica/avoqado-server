// tests/__helpers__/setup.ts

// This file is executed once per test file after the test framework is setup
// but before the tests are run.

// Set required environment variables for tests
process.env.NODE_ENV = 'test'
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret'
process.env.SESSION_SECRET = 'test-session-secret'
process.env.COOKIE_SECRET = 'test-cookie-secret'
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test'
process.env.RABBITMQ_URL = 'amqp://test:test@localhost:5672'

// Prisma Mock Setup
const prismaMock = {
  staff: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  venue: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  notification: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    createMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
    groupBy: jest.fn(),
  },
  notificationPreference: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
  },
  notificationTemplate: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  staffVenue: {
    findMany: jest.fn(),
  },
  chatTrainingData: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
    groupBy: jest.fn(),
  },
  chatFeedback: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  learnedPatterns: {
    findMany: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
  },
}

// Mock Prisma Client globally
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: prismaMock,
}))

// Mock logger to prevent console noise during tests
jest.mock('@/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}))

console.log('Jest global setup file loaded.')

// Clear all mocks before each test to ensure test isolation
beforeEach(() => {
  jest.clearAllMocks()
})

export { prismaMock }
