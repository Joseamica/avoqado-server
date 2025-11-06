// tests/__helpers__/setup.ts

// This file is executed once per test file after the test framework is setup
// but before the tests are run.

// Set test timeout to 30 seconds to prevent timeout issues
jest.setTimeout(30000)

// Set required environment variables for tests
process.env.NODE_ENV = 'test'
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret'
process.env.SESSION_SECRET = 'test-session-secret'
process.env.COOKIE_SECRET = 'test-cookie-secret'
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test'
process.env.RABBITMQ_URL = 'amqp://test:test@localhost:5672'

// Comprehensive Prisma Mock Setup
const createMockModel = () => ({
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  create: jest.fn(),
  createMany: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
  upsert: jest.fn(),
  delete: jest.fn(),
  deleteMany: jest.fn(),
  count: jest.fn(),
  aggregate: jest.fn(),
  groupBy: jest.fn(),
})

const prismaMock: any = {
  staff: createMockModel(),
  venue: createMockModel(),
  venueRolePermission: createMockModel(),
  notification: createMockModel(),
  notificationPreference: createMockModel(),
  notificationTemplate: createMockModel(),
  staffVenue: createMockModel(),
  chatTrainingData: createMockModel(),
  chatFeedback: createMockModel(),
  learnedPatterns: createMockModel(),
  area: createMockModel(),
  order: createMockModel(),
  orderItem: createMockModel(),
  payment: createMockModel(),
  paymentAllocation: createMockModel(),
  shift: createMockModel(),
  product: createMockModel(),
  menuCategory: createMockModel(),
  organization: createMockModel(),
  review: createMockModel(),
  digitalReceipt: createMockModel(),
  venueTransaction: createMockModel(),
  billV2: createMockModel(),
  // Stripe-related models
  feature: createMockModel(),
  venueFeature: createMockModel(),
  webhookEvent: createMockModel(),
  // Add $connect and $disconnect for connection management
  $connect: jest.fn(),
  $disconnect: jest.fn(),
}

// Add $transaction after the object is created to avoid circular reference
prismaMock.$transaction = jest.fn((callback: any) => callback(prismaMock))

// Mock Prisma Client globally
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: prismaMock,
}))

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

console.log('Jest global setup file loaded.')

// Clear all mocks before each test to ensure test isolation
beforeEach(() => {
  jest.clearAllMocks()
})

export { prismaMock }
