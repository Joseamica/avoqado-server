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
// OTP_PEPPER is REQUIRED (min 16 chars) in src/config/env.ts — peppers WhatsApp/email
// login OTP hashes. Without it here, CI (no .env file) fails env validation and env.ts
// calls process.exit(1) at import time, crashing Jest workers → "Jest worker encountered
// N child process exceptions, exceeding retry limit". Locally it passes because .env has it.
process.env.OTP_PEPPER = 'test-otp-pepper-secret-1234567890'
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test'
process.env.RABBITMQ_URL = 'amqp://test:test@localhost:5672'
// Stripe key must be set before any service module imports — TokenBudgetService
// instantiates its Stripe client in the constructor (singleton), and tests rely
// on jest.mock('stripe') hooking that constructor. Without this, CI (which has
// no STRIPE_SECRET_KEY) skips Stripe init and chargeOverage returns 'no_stripe'.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_for_jest'

// OpenAI key must be set before any service module imports — AssistantDashboardService
// builds its OpenAI client in the constructor and is exported as a module-load singleton
// (`export default new AssistantDashboardService()`), reached transitively by importing
// dashboard.routes (e.g. route-permission tests). Without this, CI (no .env file) throws
// "OPENAI_API_KEY is required" at import time and the whole suite fails to run. Locally it
// passes because .env has it. The dummy is never used for a real call in unit tests.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-dummy-for-jest'

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
process.env.MP_REDIRECT_URI = process.env.MP_REDIRECT_URI || 'http://localhost:3000/api/v1/integrations/mercadopago/oauth/callback'
process.env.MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || 'test-mp-webhook-secret'
process.env.MP_PUBLIC_KEY_TEST = process.env.MP_PUBLIC_KEY_TEST || 'TEST-pk-test'
process.env.MP_ACCESS_TOKEN_TEST = process.env.MP_ACCESS_TOKEN_TEST || 'TEST-at-test'
process.env.MERCADO_PAGO_TOKEN_KEY =
  process.env.MERCADO_PAGO_TOKEN_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
process.env.MP_API_BASE_URL = process.env.MP_API_BASE_URL || 'https://api.mercadopago.com'
process.env.MP_AUTH_BASE_URL = process.env.MP_AUTH_BASE_URL || 'https://auth.mercadopago.com.mx'

// Deliverect (delivery channels) — deliverect.client.ts builds its axios instance
// and reads client-credentials at module-load time, before any test import.
process.env.DELIVERECT_API_URL = process.env.DELIVERECT_API_URL || 'https://api.staging.deliverect.com'
process.env.DELIVERECT_CLIENT_ID = process.env.DELIVERECT_CLIENT_ID || 'test-deliverect-client-id'
process.env.DELIVERECT_CLIENT_SECRET = process.env.DELIVERECT_CLIENT_SECRET || 'test-deliverect-client-secret'

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
  deliveryChannelLink: createMockModel(),
  deliveryOrderEvent: createMockModel(),
  deliveryActivationRequest: createMockModel(),
  payment: createMockModel(),
  terminalPaymentRequest: createMockModel(),
  paymentAllocation: createMockModel(),
  shift: createMockModel(),
  product: createMockModel(),
  menu: createMockModel(),
  menuCategory: createMockModel(),
  menuCategoryAssignment: createMockModel(),
  organization: createMockModel(),
  review: createMockModel(),
  digitalReceipt: createMockModel(),
  venueTransaction: createMockModel(),
  billV2: createMockModel(),
  // Stripe-related models
  feature: createMockModel(),
  venueFeature: createMockModel(),
  webhookEvent: createMockModel(),
  // Platform billing CFDI (Avoqado factura a sus propios clientes)
  platformEmisor: createMockModel(),
  billingTaxProfile: createMockModel(),
  platformCfdi: createMockModel(),
  // Token budget models
  chatbotTokenBudget: createMockModel(),
  tokenUsageRecord: createMockModel(),
  tokenPurchase: createMockModel(),
  // Customer & Loyalty models
  customer: createMockModel(),
  // Global consumer identity + passwordless OTP login
  consumer: createMockModel(),
  otpChallenge: createMockModel(),
  customerGroup: createMockModel(),
  loyaltyConfig: createMockModel(),
  loyaltyTransaction: createMockModel(),
  // Discount & Coupon models
  discount: createMockModel(),
  couponCode: createMockModel(),
  couponRedemption: createMockModel(),
  customerDiscount: createMockModel(),
  orderDiscount: createMockModel(),
  // Referral Program — configurable tier rewards (grant + unlock tables)
  referral: createMockModel(),
  referralProgramConfig: createMockModel(),
  referralTierReward: {
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
  },
  referralRewardGrant: {
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    update: jest.fn(),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
  },
  referralTierUnlock: { createMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn(), delete: jest.fn() },
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
  angelPayUserAccount: createMockModel(),
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
  // Field-promoter geolocation ("cambaceo" tracking)
  promoterLocationPing: createMockModel(),
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
  tpvCommandQueue: createMockModel(),
  // Reservation / Booking models
  reservation: createMockModel(),
  classSession: createMockModel(),
  staffSchedule: createMockModel(),
  staffScheduleException: createMockModel(),
  productStaff: createMockModel(),
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
  commissionPayout: createMockModel(),
  commissionSummary: createMockModel(),
  milestoneAchievement: createMockModel(),
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
  // Slot holds (booking + reschedule countdown)
  slotHold: createMockModel(),
  // Venue chat (WhatsApp relay) — venue-chat v1
  venueWhatsappActivation: createMockModel(),
  whatsappContactWindow: createMockModel(),
  whatsappInboundEvent: createMockModel(),
  venueChatSession: createMockModel(),
  venueChatMessage: createMockModel(),
  // Audit trail
  activityLog: createMockModel(),
  // Sale verification (PlayTelecom SIM-sale documentation / back-office review)
  saleVerification: createMockModel(),
  // Live demo sessions (demo.dashboard.avoqado.io)
  liveDemoSession: createMockModel(),
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
// Terminal list endpoints (getOrgTerminals / getAllTerminals) run an incidental
// migration-badge query (prisma.tpvCommandQueue.findMany) for the page's terminals.
// Tests that don't exercise migration badges shouldn't have to mock it — default to
// no in-flight migrations so the result is iterable and the "Migrando…" badge is off.
prismaMock.tpvCommandQueue.findMany.mockResolvedValue([])
// Plan-tier gating (checkFeatureAccess middleware → getVenueBaseTier in
// src/services/access/basePlan.service.ts) iterates the rows returned by
// prisma.venueFeature.findMany. A bare jest.fn() resolves undefined and the
// `for (const r of rows)` throws, surfacing as a handled 500 in ANY route behind
// a feature gate. Default to [] (= no base-plan rows → FREE tier); tests that
// exercise tiers override with their own mockResolvedValue per test.
prismaMock.venueFeature.findMany.mockResolvedValue([])

function primeReservationStaffMocks() {
  prismaMock.staffSchedule.findUnique.mockResolvedValue(null)
  prismaMock.staffScheduleException.findMany.mockResolvedValue([])
  prismaMock.productStaff.findMany.mockResolvedValue([])
}

primeReservationStaffMocks()

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
  primeReservationStaffMocks()
})

export { prismaMock, primeReservationStaffMocks }
