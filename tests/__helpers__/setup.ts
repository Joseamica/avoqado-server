// Reconoce ÚNICAMENTE la consulta con que el outbox relee su pago fuente
// (`paymentEffects.service.ts:22-26`): id + venueId + status COMPLETED, y un select que pide
// SOLO orderId. Ser preciso importa: un reflejo laxo intercepta búsquedas legítimas del
// servicio y le cambia el comportamiento, que sería peor que el fallo que viene a evitar.
const esConsultaDelOutbox = (a: any) =>
  a?.where?.status === 'COMPLETED' &&
  typeof a?.where?.id === 'string' &&
  'venueId' in (a?.where ?? {}) &&
  Object.keys(a?.select ?? {}).length === 1 &&
  a?.select?.orderId === true
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
// Parte A (sesiones revocables) — Task 9: cifra el sucesor del refresh token durante la
// ventana de retransmisión de 60 s (successorCrypto.ts). Debe ser hex de 32 bytes (64
// chars) para pasar el validador de env.ts, igual que GOOGLE_CALENDAR_TOKEN_KEY abajo.
process.env.SESSION_SUCCESSOR_ENC_KEY = process.env.SESSION_SUCCESSOR_ENC_KEY || 'b'.repeat(64)
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
  $queryRaw: jest.fn(),
  // La comisión del cobro se encola bajo un SAVEPOINT para que su fallo NO tumbe el dinero ya
  // capturado (`paymentEffects.service.ts:177`). Los tests que pasan este mock como `tx` lo
  // necesitan; sin él, el TypeError sustituye a la aserción real.
  $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  $executeRaw: jest.fn().mockResolvedValue(0),
  staff: createMockModel(),
  venue: createMockModel(),
  venueRolePermission: createMockModel(),
  permissionOverride: createMockModel(),
  notification: createMockModel(),
  notificationPreference: createMockModel(),
  notificationTemplate: createMockModel(),
  staffVenue: createMockModel(),
  // Parte A (sesiones revocables) — Task 6: el login móvil (password y passkey) ahora
  // crea una Session ANTES de emitir tokens. Sin esta entrada, cualquier test que ejercite
  // loginWithEmail/verifyPasskeyAssertion sin conocer la Session revienta con "Cannot read
  // properties of undefined (reading 'create')" — misma clase de bug que venueFeature.findMany
  // más abajo. staffPasskey es lo que verifyPasskeyAssertion consulta para resolver la credencial.
  session: createMockModel(),
  // Parte A (sesiones revocables) — Task 10: el login (password y passkey) ahora emite el
  // PRIMER RefreshGrant justo después de crear la Session (issueGrant → prisma.refreshGrant
  // .create). Sin esta entrada, cualquier test que ejercite loginWithEmail/
  // verifyPasskeyAssertion sin conocer los grants revienta con "Cannot read properties of
  // undefined (reading 'create')" — misma clase de bug que session arriba.
  refreshGrant: createMockModel(),
  // Outbox de efectos del cobro (Task 5) — `recordOrderPayment` encola RECEIPT/REVIEW/REFERRAL/
  // COMMISSION DENTRO de la transacción financiera (`paymentEffects.service.ts:28`). Sin esta
  // entrada, cualquier test que ejercite un cobro revienta con "Cannot read properties of
  // undefined (reading 'createMany')" — la MISMA clase de fallo que `session` y `refreshGrant`
  // arriba, y la tercera vez que muerde. Un `tx` armado a mano tiene que declararla aparte.
  paymentEffect: createMockModel(),
  staffPasskey: createMockModel(),
  chatTrainingData: createMockModel(),
  chatFeedback: createMockModel(),
  learnedPatterns: createMockModel(),
  area: createMockModel(),
  order: createMockModel(),
  orderItem: createMockModel(),
  // 🔴 Sin esta entrada, `awardLoyaltyForPaidOrder` (services/shared/loyaltyOnPaidOrder.ts:84)
  // revienta con "Cannot read properties of undefined (reading 'findMany')", entra por su
  // catch y guarda `loyaltyLastError` — o sea que el camino de lealtad del cobro en efectivo
  // móvil, el que se cerró el 2026-09-01 porque el sello no subía en el Sunmi de Testarudo,
  // NUNCA se ejercitaba: sus pruebas pasaban sin tocar la lógica que dicen cuidar.
  // El `?? []` de ese archivo no alcanza: protege de un findMany que devuelve undefined,
  // no de un modelo ausente, que falla un paso antes al leer `.findMany`.
  orderCustomer: createMockModel(),
  promotion: createMockModel(),
  promotionGroup: createMockModel(),
  promotionOption: createMockModel(),
  orderPromotion: createMockModel(),
  deliveryChannelLink: createMockModel(),
  kdsOrder: createMockModel(),
  kdsOrderItem: createMockModel(),
  deliveryOrderEvent: createMockModel(),
  deliveryActivationRequest: createMockModel(),
  payment: createMockModel(),
  terminalPaymentRequest: createMockModel(),
  // S1 (checkpoint 1 del webhook, 13-sep): vínculo intento → solicitud; lo consulta el webhook y el arbitraje.
  terminalPaymentAttemptLink: createMockModel(),
  // «Ninguna terminal muerta» (22-sep): sin esta entrada, la consulta S6 de un cobro LOCAL ejecuta `.findFirst` sobre
  // `undefined` y el controlador convierte ese TypeError en un 500 (Codex P2-7).
  terminalAttemptResolution: createMockModel(),
  providerEventLog: createMockModel(),
  paymentAllocation: createMockModel(),
  posCommand: createMockModel(),
  shift: createMockModel(),
  // El cajón físico: `getShiftById` lo consulta desde `resolveShiftCashDrawer`
  // (unificación de caja, fase 5). Este mock ENUMERA los modelos, así que un modelo
  // nuevo no falla donde se agregó — falla en cualquier suite vecina que llame al
  // servicio, con un `Cannot read properties of undefined`.
  cashDrawerSession: createMockModel(),
  cashDrawerEvent: createMockModel(),
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
  billingObligationConflict: createMockModel(),
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
  customerOrderMetric: createMockModel(),
  loyaltyConfig: createMockModel(),
  loyaltyTransaction: createMockModel(),
  walletPass: createMockModel(),
  receiptLayout: createMockModel(),
  walletCardDesign: createMockModel(),
  walletPassRegistration: createMockModel(),
  stampCard: createMockModel(),
  stampEvent: createMockModel(),
  stampReward: createMockModel(),
  // Discount & Coupon models
  discount: createMockModel(),
  couponCode: createMockModel(),
  couponRedemption: createMockModel(),
  customerDiscount: createMockModel(),
  orderDiscount: createMockModel(),
  // Order-level service charges (cobros por servicio) — MANUAL: without this
  // entry, `prisma.orderServiceCharge` is undefined and mergeOrders/split/
  // recalculateOrderTotals (which all read/write it) throw.
  orderServiceCharge: createMockModel(),
  // Upsell "¿Algo más?" — este registro es MANUAL: sin la entrada aquí,
  // `prisma.upsellRule` es undefined y cualquier test que lo toque truena.
  upsellRule: createMockModel(),
  upsellImpression: createMockModel(),
  upsellAcceptance: createMockModel(),
  upsellAiRun: createMockModel(),
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
  // 🔴 Parte de `createMockModel()` y sólo DESPUÉS fija sus defaults. Escrito a mano enumeraba
  // 7 operaciones y le faltaba `deleteMany`, así que la limpieza de demos —que borra estas
  // filas antes del venue— reventaba con un TypeError tres capas abajo, en una suite que no
  // habla de referidos. Es la trampa de [[mock-de-modulo-con-lista-fija]]: lo que el doble
  // ENUMERA se rompe en cuanto producción usa una operación más.
  referralRewardGrant: {
    ...createMockModel(),
    findMany: jest.fn().mockResolvedValue([]),
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
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
  inventoryPosting: createMockModel(),
  inventoryPostingLine: createMockModel(),
  // Stock counts (conteo de existencias)
  stockCount: createMockModel(),
  stockCountItem: createMockModel(),
  // Recipe models (RECIPE method)
  recipe: createMockModel(),
  recipeLine: createMockModel(),
  stockBatch: createMockModel(),
  rawMaterialMovement: createMockModel(),
  lowStockAlert: createMockModel(),
  rawMaterialPresentation: createMockModel(), // Presentaciones de compra/salida (caja, cono, kilo)
  // Compras (un modelo sin registrar aquí revienta con "Cannot read properties of undefined")
  supplier: createMockModel(),
  purchaseOrder: createMockModel(),
  purchaseOrderInvoice: createMockModel(),
  purchaseOrderInvoiceLine: createMockModel(),
  supplierItemCode: createMockModel(),
  staffDocument: createMockModel(),
  purchaseOrderItem: createMockModel(),
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
  // Horas extra (29-ago): el resumen de nómina consulta las autorizaciones para saber qué
  // entra al reparto doble/triple. Sin esta entrada, cualquier test que llegue a
  // getPayrollSummary revienta con "Cannot read properties of undefined (reading 'findMany')"
  // — la misma clase que session y venueFeature de arriba: este mock es una lista FIJA, así
  // que un modelo nuevo hay que declararlo aquí a mano.
  overtimeApproval: createMockModel(),
  timeEntryBreak: createMockModel(),
  // Field-promoter geolocation ("cambaceo" tracking)
  promoterLocationPing: createMockModel(),
  venueSettings: createMockModel(),
  // Custom tender types (VenueTenderType catalog + append-only revisions)
  venueTenderType: createMockModel(),
  venueTenderTypeRevision: createMockModel(),
  // Organization dashboard models
  cashDeposit: createMockModel(),
  stockAlertConfig: createMockModel(),
  serializedItem: createMockModel(),
  performanceGoal: createMockModel(),
  module: createMockModel(),
  venueModule: createMockModel(),
  organizationModule: createMockModel(),
  organizationSalesGoalConfig: createMockModel(),
  organizationAttendanceConfig: createMockModel(),
  terminal: createMockModel(),
  tpvCommandQueue: createMockModel(),
  // Vales por área (AREA_TICKETS): cuenta compartida entre áreas emisoras + entrega
  fulfillmentArea: createMockModel(),
  orderFulfillment: createMockModel(),
  orderFulfillmentLine: createMockModel(),
  venueAreaTicketSettings: createMockModel(),
  areaTicket: createMockModel(),
  areaTicketLine: createMockModel(),
  areaTicketInventoryReservation: createMockModel(),
  areaTicketCheckoutSession: createMockModel(),
  areaTicketPaymentAttempt: createMockModel(),
  areaTicketPrintAttempt: createMockModel(),
  areaTicketFulfillment: createMockModel(),
  areaTicketExternalSettlement: createMockModel(),
  areaTicketExternalIncident: createMockModel(),
  venueScaleSettings: createMockModel(),
  scaleProfile: createMockModel(),
  // Reservation / Booking models
  reservation: createMockModel(),
  kioskCheckInChallenge: createMockModel(),
  kioskCheckInAttempt: createMockModel(),
  kioskOutreachOutbox: createMockModel(),
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
  // Catálogo central. 🔴 Faltaban, y el mock tiene LISTA FIJA: en cuanto la limpieza de demos
  // empezó a borrarlos, sus pruebas tronaban con «Cannot read properties of undefined».
  catalogVenueBinding: createMockModel(),
  catalogBindingLine: createMockModel(),
  catalogVenueOverride: createMockModel(),
  catalogPublicationLine: createMockModel(),
  catalogPublicationFieldDecision: createMockModel(),
  // Money reconciliation (Fase 0.B: fulfillment fail-closed registra anomalías)
  moneyAnomaly: createMockModel(),
  // Stripe webhook idempotency claims (Connect + platform)
  processedStripeEvent: createMockModel(),
  // Fase 1: outbox de avisos de aprobación de clientes (evento + entrega por destinatario)
  customerApprovalOutbox: createMockModel(),
  customerApprovalDelivery: createMockModel(),
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
  // MCP tool-call audit (12h bad-experience audit cron)
  mcpToolCall: createMockModel(),
  // Sale verification (PlayTelecom SIM-sale documentation / back-office review)
  saleVerification: createMockModel(),
  // Live demo sessions (demo.dashboard.avoqado.io)
  liveDemoSession: createMockModel(),
  // Ledger de consentimiento (campañas de correo, Fase 0). La limpieza de demos los borra
  // explícitamente: `ConsentEvent.noticeVersionId` es RESTRICT contra `PrivacyNoticeVersion`,
  // que sí cascadea desde el venue — el borrado del venue truena si quedan filas.
  consentEvent: createMockModel(),
  privacyNoticeVersion: createMockModel(),
  // Lanzamiento con campañas ligeras (spec 2026-09-17). El progreso del alta lo escriben el
  // reclamo de campaña y `activate-plan`; sin estas tres entradas cualquier test que los toque
  // revienta con «Cannot read properties of undefined» en vez de fallar por su aserción.
  // 🔴 `fields` no es decorativo: la reserva del cupo compara columna contra columna
  // (`redemptionCount < redemptionCap`) con una REFERENCIA DE CAMPO de Prisma. Sin esta entrada
  // el servicio revienta con un TypeError y la prueba del cupo falla por el motivo equivocado.
  launchCampaign: Object.assign(createMockModel(), {
    fields: { redemptionCap: { name: 'redemptionCap' }, redemptionCount: { name: 'redemptionCount' } },
  }),
  launchCampaignRedemption: createMockModel(),
  onboardingProgress: createMockModel(),
  customerCaptureToken: createMockModel(),
  // Lo demás que BLOQUEA el borrado de un venue desechable (ver liveDemoCleanup.service).
  commissionClawback: createMockModel(),
  merchantFiscalConfig: createMockModel(),
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
prismaMock.orderItem.findMany.mockResolvedValue([])
prismaMock.inventoryPosting.create.mockResolvedValue({ id: 'posting-default', status: 'PENDING' })
prismaMock.inventoryPosting.updateMany.mockResolvedValue({ count: 0 })
// Plan-tier gating (checkFeatureAccess middleware → getVenueBaseTier in
// src/services/access/basePlan.service.ts) iterates the rows returned by
// prisma.venueFeature.findMany. A bare jest.fn() resolves undefined and the
// `for (const r of rows)` throws, surfacing as a handled 500 in ANY route behind
// a feature gate. Default to [] (= no base-plan rows → FREE tier); tests that
// exercise tiers override with their own mockResolvedValue per test.
prismaMock.venueFeature.findMany.mockResolvedValue([])
// Mobile venue-settings promotions block (getVenueTpvSettings, src/controllers/mobile/
// tpvSettings.mobile.controller.ts) calls prisma.venueSettings.findUnique(...).catch(...).
// A bare jest.fn() resolves undefined (not a Promise), so `.catch` on it throws
// "Cannot read properties of undefined (reading 'catch')" in ANY test that reaches this
// endpoint without knowing about `promotions` — same class of bug as venueFeature.findMany
// above. Default to null (= no VenueSettings row → design defaults TAB/SIDE_PANEL); tests
// that exercise the promotions block override with their own mockResolvedValue/mockRejectedValue.
prismaMock.venueSettings.findUnique.mockResolvedValue(null)
// Parte A (sesiones revocables) — Task 6: loginWithEmail/verifyPasskeyAssertion now call
// createSession(...) → prisma.session.create(...) BEFORE minting tokens (they need the row's
// `id` for the `sid` claim). Default so pre-existing mobile-auth tests that don't know about
// sessions yet (auth.permisosDeLaApp.test.ts, auth.loginSuspendedVenue.test.ts) keep passing;
// tests exercising the Session itself override with their own mockResolvedValue.
prismaMock.session.create.mockResolvedValue({ id: 'session-mock-default' })
// Parte A (sesiones revocables) — Task 10: idem, para el primer RefreshGrant que el login
// emite justo después (issueGrant). Mismo motivo que el default de session.create arriba.
prismaMock.refreshGrant.create.mockResolvedValue({ id: 'refresh-grant-mock-default' })
// Outbox de efectos del cobro (Task 5). `createRefundCommission` hace `for (const e of pending)`
// sobre `paymentEffect.findMany` (commission-calculation.service.ts:360-361): sin un default, el
// jest.fn() devuelve `undefined` y revienta con «pending is not iterable» DENTRO de la
// transacción del reembolso — que se traga el error y deja el PAY_OUT al cajón sin publicar.
// `[]` es el estado real de un cobro sin efectos previos; `createMany` cuenta lo encolado.
prismaMock.paymentEffect.findMany.mockResolvedValue([])
// El outbox comprueba que el Payment fuente pertenece a la MISMA orden antes de encolar y, si
// no cuadra, LANZA y tumba la transacción del cobro (`paymentEffects.service.ts:22-27`). Este
// default REFLEJA esa consulta concreta —id + status COMPLETED + select de orderId— en vez de
// inventar otra orden. Cualquier otro uso de findFirst sigue devolviendo undefined como antes,
// y un test que lo configure con mockResolvedValue lo sobreescribe igual.
prismaMock.payment.findFirst.mockImplementation(async (a: any) =>
  esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : undefined,
)
prismaMock.paymentEffect.createMany.mockResolvedValue({ count: 1 })
// Misma familia: `createRefundCommission` recorre `commissionCalculation.findMany` en la misma
// línea (`:359-369`). Sin default también revienta con «originalCalcs is not iterable» dentro de
// la transacción del reembolso. Una lista vacía es el estado real de un cobro sin comisiones.
prismaMock.commissionCalculation.findMany.mockResolvedValue([])

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
