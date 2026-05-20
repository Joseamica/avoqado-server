// tests/__helpers__/setup.ts

// This file is executed once per test file after the test framework is setup
// but before the tests are run.

// Set test timeout to 30 seconds to prevent timeout issues
jest.setTimeout(30000)

// Set required environment variables for tests
process.env.NODE_ENV = 'test'
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret'
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret'
process.env.SESSION_SECRET = 'test-session-secret'
process.env.COOKIE_SECRET = 'test-cookie-secret'
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test'
process.env.RABBITMQ_URL = 'amqp://test:test@localhost:5672'
// Stripe key must be set before any service module imports — TokenBudgetService
// instantiates its Stripe client in the constructor (singleton), and tests rely
// on jest.mock('stripe') hooking that constructor. Without this, CI (which has
// no STRIPE_SECRET_KEY) skips Stripe init and chargeOverage returns 'no_stripe'.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_for_jest'

// Google Calendar Sync (Phase 1) — services that read these at module-load time
// need deterministic test values BEFORE any import. The token key must be 32-byte
// hex (64 chars) to satisfy GoogleCalendarTokenEncryption's getKey() validator.
process.env.GOOGLE_CALENDAR_TOKEN_KEY = process.env.GOOGLE_CALENDAR_TOKEN_KEY || 'a'.repeat(64)
process.env.OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || 'test-oauth-state-secret'
process.env.GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || 'test-google-oauth-client-id'
process.env.GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || 'test-google-oauth-client-secret'
process.env.GOOGLE_OAUTH_REDIRECT_URI =
  process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:4000/api/v1/google-calendar/oauth/callback'
process.env.GOOGLE_CALENDAR_WEBHOOK_BASE = process.env.GOOGLE_CALENDAR_WEBHOOK_BASE || 'http://localhost:4000'

// Mercado Pago — services that read these at module-load time (Brick OAuth,
// token encryption, webhook signing) need deterministic test values BEFORE any
// import. Token key must be 32-byte hex (64 chars) to satisfy createTokenCipher.
process.env.MP_CLIENT_ID = process.env.MP_CLIENT_ID || 'test-mp-client-id'
process.env.MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET || 'test-mp-client-secret'
process.env.MP_REDIRECT_URI =
  process.env.MP_REDIRECT_URI || 'http://localhost:3000/api/v1/integrations/mercadopago/oauth/callback'
process.env.MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || 'test-mp-webhook-secret'
process.env.MP_PUBLIC_KEY_TEST = process.env.MP_PUBLIC_KEY_TEST || 'TEST-pk-test'
process.env.MP_ACCESS_TOKEN_TEST = process.env.MP_ACCESS_TOKEN_TEST || 'TEST-at-test'
process.env.MERCADO_PAGO_TOKEN_KEY =
  process.env.MERCADO_PAGO_TOKEN_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
process.env.MP_API_BASE_URL = process.env.MP_API_BASE_URL || 'https://api.mercadopago.com'
process.env.MP_AUTH_BASE_URL = process.env.MP_AUTH_BASE_URL || 'https://auth.mercadopago.com.mx'

// Comprehensive Prisma Mock Setup
const createMockModel = () => ({
  findUnique: jest.fn(),
  findUniqueOrThrow: jest.fn(),
  findFirst: jest.fn(),
  findFirstOrThrow: jest.fn(),
  findMany: jest.fn(),
  create: jest.fn(),
  createMany: jest.fn(),
  createManyAndReturn: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
  updateManyAndReturn: jest.fn(),
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
  // Token budget models
  chatbotTokenBudget: createMockModel(),
  tokenUsageRecord: createMockModel(),
  tokenPurchase: createMockModel(),
  // Customer & Loyalty models
  customer: createMockModel(),
  customerGroup: createMockModel(),
  loyaltyConfig: createMockModel(),
  loyaltyTransaction: createMockModel(),
  // Discount & Coupon models
  discount: createMockModel(),
  couponCode: createMockModel(),
  couponRedemption: createMockModel(),
  customerDiscount: createMockModel(),
  orderDiscount: createMockModel(),
  // Venue Role Config (custom role display names)
  venueRoleConfig: createMockModel(),
  // Invitation and StaffOrganization models
  invitation: createMockModel(),
  staffOrganization: createMockModel(),
  // Modifier Inventory Analytics models
  modifier: createMockModel(),
  modifierGroup: createMockModel(),
  productModifierGroup: createMockModel(),
  orderItemModifier: createMockModel(),
  rawMaterial: createMockModel(),
  reservationModifier: createMockModel(),
  // Inventory models (QUANTITY method)
  inventory: createMockModel(),
  inventoryMovement: createMockModel(),
  // Recipe models (RECIPE method)
  recipe: createMockModel(),
  recipeLine: createMockModel(),
  stockBatch: createMockModel(),
  rawMaterialMovement: createMockModel(),
  // Payment config & analytics models
  merchantAccount: createMockModel(),
  providerCostStructure: createMockModel(),
  venuePaymentConfig: createMockModel(),
  organizationPaymentConfig: createMockModel(),
  venuePricingStructure: createMockModel(),
  organizationPricingStructure: createMockModel(),
  settlementConfiguration: createMockModel(),
  transactionCost: createMockModel(),
  // Time entry models
  timeEntry: createMockModel(),
  timeEntryBreak: createMockModel(),
  venueSettings: createMockModel(),
  // Organization dashboard models
  cashDeposit: createMockModel(),
  stockAlertConfig: createMockModel(),
  serializedItem: createMockModel(),
  performanceGoal: createMockModel(),
  module: createMockModel(),
  venueModule: createMockModel(),
  organizationSalesGoalConfig: createMockModel(),
  organizationAttendanceConfig: createMockModel(),
  terminal: createMockModel(),
  // Reservation / Booking models
  reservation: createMockModel(),
  classSession: createMockModel(),
  reservationWaitlistEntry: createMockModel(),
  table: createMockModel(),
  // Permission Set models
  permissionSet: createMockModel(),
  // Item Category models
  itemCategory: createMockModel(),
  // Commission models
  commissionConfig: createMockModel(),
  commissionTier: createMockModel(),
  commissionOverride: createMockModel(),
  commissionCalculation: createMockModel(),
  commissionSummary: createMockModel(),
  // Credit Pack models
  creditPack: createMockModel(),
  creditPackItem: createMockModel(),
  creditPackPurchase: createMockModel(),
  creditItemBalance: createMockModel(),
  creditTransaction: createMockModel(),
  // Payment Link models
  paymentLink: createMockModel(),
  checkoutSession: createMockModel(),
  ecommerceMerchant: createMockModel(),
  paymentProvider: createMockModel(),
  // Mercado Pago (Phase 0 of MP marketplace integration)
  mercadoPagoWebhookEvent: createMockModel(),
  // Google Calendar Sync (Phase 1)
  googleCalendarConnection: createMockModel(),
  googleCalendarChannel: createMockModel(),
  externalBusyBlock: createMockModel(),
  googleCalendarWebhookInbox: createMockModel(),
  googleOAuthSession: createMockModel(),
  // Google Calendar Sync (Phase 2 — push)
  calendarSyncOutbox: createMockModel(),
  reservationGoogleEventMapping: createMockModel(),
  reservationSettings: createMockModel(),
  // Venue chat (WhatsApp relay) — venue-chat v1
  venueWhatsappActivation: createMockModel(),
  whatsappContactWindow: createMockModel(),
  whatsappInboundEvent: createMockModel(),
  venueChatSession: createMockModel(),
  venueChatMessage: createMockModel(),
  // Add $connect and $disconnect for connection management
  $connect: jest.fn(),
  $disconnect: jest.fn(),
}

// Add $transaction after the object is created to avoid circular reference
prismaMock.$transaction = jest.fn((callback: any) => callback(prismaMock))

// Add $queryRaw for raw SQL queries
prismaMock.$queryRaw = jest.fn()

// Set safe default return values for mocks that are frequently queried
prismaMock.productModifierGroup.findMany.mockResolvedValue([])
prismaMock.externalBusyBlock.findFirst.mockResolvedValue(null)

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

// Mock activity log service globally (fire-and-forget, no need to assert in most tests)
jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

console.log('Jest global setup file loaded.')

// Clear all mocks before each test to ensure test isolation
beforeEach(() => {
  jest.clearAllMocks()
})

export { prismaMock }
