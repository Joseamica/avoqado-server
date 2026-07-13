/**
 * Self-maintaining generator for docs/SCHEMA_MAP.md
 * ================================================
 *
 * `docs/SCHEMA_MAP.md` is the human-friendly index of `prisma/schema.prisma`:
 * every model grouped into named domains. It goes stale because models are
 * added daily. This script regenerates it from an EXPLICIT model -> domain
 * mapping held below.
 *
 * Why an explicit map (and not the `// =====` section comments)? The schema's
 * section comments are NOT a reliable taxonomy: `Order` sits under a
 * "TIME TRACKING" comment, `Invoice` under "STRIPE WEBHOOK LOGGING", etc.
 * The DOMAINS + MODEL_TO_DOMAIN constants below are the single source of truth.
 *
 * Usage:
 *   npm run schema:map            -> regenerate docs/SCHEMA_MAP.md (write mode)
 *   npm run schema:map -- --check -> verify the file is up to date (CI mode)
 *
 * When a model exists in schema.prisma but is missing from MODEL_TO_DOMAIN,
 * the script exits non-zero and prints the model name(s) to add here.
 *
 * Dependency-free: Node `fs` only.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as prettier from 'prettier'

const REPO_ROOT = path.resolve(__dirname, '..')
const SCHEMA_PATH = path.join(REPO_ROOT, 'prisma', 'schema.prisma')
const MAP_PATH = path.join(REPO_ROOT, 'docs', 'SCHEMA_MAP.md')

// ---------------------------------------------------------------------------
// CONFIG — source of truth. Add new models to MODEL_TO_DOMAIN below.
// ---------------------------------------------------------------------------

interface Domain {
  name: string
  description: string
}

/** The domains, in display order. */
const DOMAINS: Domain[] = [
  {
    name: 'Multi-Tenant Core',
    description: 'The org/venue tree + physical floor layout. The root every other table hangs off.',
  },
  {
    name: 'Modules, Features & Billing',
    description: 'What a venue pays for / is gated on, and how Avoqado invoices it.',
  },
  {
    name: 'Staff, Auth, Permissions & Time',
    description: 'Who works where, how they log in, what they may do, and hours worked.',
  },
  {
    name: 'Onboarding & Training',
    description: 'New-venue/new-staff onboarding state + the LMS.',
  },
  {
    name: 'Menu, Products & Modifiers',
    description: 'The catalog: what a venue sells and its variants/add-ons.',
  },
  {
    name: 'Inventory & Stock',
    description: 'Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.',
  },
  {
    name: 'Serialized Inventory',
    description: 'Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.',
  },
  {
    name: 'Orders, KDS & Cash',
    description: 'The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.',
  },
  {
    name: 'Payments & Fees',
    description: 'The payment record itself + allocations, receipts, fee schedules.',
  },
  {
    name: 'Payment Providers & Settlement',
    description: 'Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.',
  },
  {
    name: 'Payment Links',
    description: 'Pay-by-link: links, line items, attribution.',
  },
  {
    name: 'Facturación (CFDI)',
    description: 'Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles.',
  },
  {
    name: 'Pricing, Costs & Venue Lending',
    description: 'MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.',
  },
  {
    name: 'Discounts, Loyalty & Credit Packs',
    description: 'Discounts/coupons, loyalty points, and prepaid credit-pack bundles.',
  },
  {
    name: 'Commissions & Sales Goals',
    description: 'Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).',
  },
  {
    name: 'Reservations & Booking',
    description: 'Appointments/classes, waitlist, slot holds, Google Calendar sync.',
  },
  {
    name: 'Terminals / TPV Fleet',
    description: 'PAX terminal fleet: health, logs, app updates, remote commands, messaging.',
  },
  {
    name: 'Notifications, WhatsApp & Marketing',
    description: 'Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.',
  },
  {
    name: 'AI Chatbot (Text-to-SQL)',
    description: 'The in-dashboard AI assistant: conversations, training data, learned patterns.',
  },
  {
    name: 'Customers, Consumers & Reviews',
    description: 'End-customer identity (venue customers + cross-venue Consumers) and reviews.',
  },
  {
    name: 'System: Audit, Webhooks & Platform',
    description: 'Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.',
  },
]

/**
 * Every model from prisma/schema.prisma -> its domain name.
 * MUST cover every model. If a new model is unclassified, the script fails
 * and prints the missing name(s) — add them here.
 */
const MODEL_TO_DOMAIN: Record<string, string> = {
  // 1. Multi-Tenant Core
  Organization: 'Multi-Tenant Core',
  Venue: 'Multi-Tenant Core',
  VenueSettings: 'Multi-Tenant Core',
  OrganizationAttendanceConfig: 'Multi-Tenant Core',
  Area: 'Multi-Tenant Core',
  Zone: 'Multi-Tenant Core',
  Table: 'Multi-Tenant Core',
  FloorElement: 'Multi-Tenant Core',

  // 2. Modules, Features & Billing
  Module: 'Modules, Features & Billing',
  VenueModule: 'Modules, Features & Billing',
  OrganizationModule: 'Modules, Features & Billing',
  Feature: 'Modules, Features & Billing',
  VenueFeature: 'Modules, Features & Billing',
  Invoice: 'Modules, Features & Billing',
  InvoiceItem: 'Modules, Features & Billing',
  Estimate: 'Modules, Features & Billing',
  EstimateItem: 'Modules, Features & Billing',
  TokenPurchase: 'Modules, Features & Billing',
  TokenUsageRecord: 'Modules, Features & Billing',
  ChatbotTokenBudget: 'Modules, Features & Billing',

  // 3. Staff, Auth, Permissions & Time
  Staff: 'Staff, Auth, Permissions & Time',
  StaffOrganization: 'Staff, Auth, Permissions & Time',
  StaffVenue: 'Staff, Auth, Permissions & Time',
  McpOAuthClient: 'Staff, Auth, Permissions & Time',
  McpAuthCode: 'Staff, Auth, Permissions & Time',
  McpRefreshToken: 'Staff, Auth, Permissions & Time',
  StaffPasskey: 'Staff, Auth, Permissions & Time',
  user_sessions: 'Staff, Auth, Permissions & Time',
  PermissionSet: 'Staff, Auth, Permissions & Time',
  VenueRoleConfig: 'Staff, Auth, Permissions & Time',
  VenueRolePermission: 'Staff, Auth, Permissions & Time',
  Invitation: 'Staff, Auth, Permissions & Time',
  OAuthState: 'Staff, Auth, Permissions & Time',
  DeviceToken: 'Staff, Auth, Permissions & Time',
  TimeEntry: 'Staff, Auth, Permissions & Time',
  TimeEntryBreak: 'Staff, Auth, Permissions & Time',
  PromoterLocationPing: 'Staff, Auth, Permissions & Time',

  // 4. Onboarding & Training
  OnboardingProgress: 'Onboarding & Training',
  StaffOnboardingState: 'Onboarding & Training',
  LiveDemoSession: 'Onboarding & Training',
  TrainingModule: 'Onboarding & Training',
  TrainingStep: 'Onboarding & Training',
  TrainingProgress: 'Onboarding & Training',
  TrainingQuizQuestion: 'Onboarding & Training',

  // 5. Menu, Products & Modifiers
  Menu: 'Menu, Products & Modifiers',
  MenuCategory: 'Menu, Products & Modifiers',
  MenuCategoryAssignment: 'Menu, Products & Modifiers',
  Product: 'Menu, Products & Modifiers',
  ProductOption: 'Menu, Products & Modifiers',
  ProductOptionValue: 'Menu, Products & Modifiers',
  ProductModifierGroup: 'Menu, Products & Modifiers',
  ItemCategory: 'Menu, Products & Modifiers',
  MeasurementUnit: 'Menu, Products & Modifiers',
  UnitConversion: 'Menu, Products & Modifiers',
  Modifier: 'Menu, Products & Modifiers',
  ModifierGroup: 'Menu, Products & Modifiers',

  // 6. Inventory & Stock
  Inventory: 'Inventory & Stock',
  InventoryMovement: 'Inventory & Stock',
  InventoryTransfer: 'Inventory & Stock',
  StockBatch: 'Inventory & Stock',
  StockCount: 'Inventory & Stock',
  StockCountItem: 'Inventory & Stock',
  StockAlertConfig: 'Inventory & Stock',
  LowStockAlert: 'Inventory & Stock',
  RawMaterial: 'Inventory & Stock',
  RawMaterialMovement: 'Inventory & Stock',
  Recipe: 'Inventory & Stock',
  RecipeLine: 'Inventory & Stock',
  Supplier: 'Inventory & Stock',
  SupplierPricing: 'Inventory & Stock',
  PurchaseOrder: 'Inventory & Stock',
  PurchaseOrderItem: 'Inventory & Stock',

  // 7. Serialized Inventory
  SerializedItem: 'Serialized Inventory',
  SerializedItemCustodyEvent: 'Serialized Inventory',
  SimRegistrationRequest: 'Serialized Inventory',
  SimRegistrationRequestItem: 'Serialized Inventory',
  SaleVerification: 'Serialized Inventory',

  // 8. Orders, KDS & Cash
  Order: 'Orders, KDS & Cash',
  OrderItem: 'Orders, KDS & Cash',
  OrderItemModifier: 'Orders, KDS & Cash',
  OrderAction: 'Orders, KDS & Cash',
  OrderDiscount: 'Orders, KDS & Cash',
  OrderCustomer: 'Orders, KDS & Cash',
  Shift: 'Orders, KDS & Cash',
  KdsOrder: 'Orders, KDS & Cash',
  KdsOrderItem: 'Orders, KDS & Cash',
  Printer: 'Orders, KDS & Cash',
  PrintGateway: 'Orders, KDS & Cash',
  PrintStation: 'Orders, KDS & Cash',
  PrintJob: 'Orders, KDS & Cash',
  CashCloseout: 'Orders, KDS & Cash',
  CashDeposit: 'Orders, KDS & Cash',
  CashDrawerSession: 'Orders, KDS & Cash',
  CashDrawerEvent: 'Orders, KDS & Cash',
  MoneyAnomaly: 'Orders, KDS & Cash',

  // 9. Payments & Fees
  Payment: 'Payments & Fees',
  PaymentAllocation: 'Payments & Fees',
  MerchantRoutingRule: 'Payments & Fees',
  VenueTransaction: 'Payments & Fees',
  BankStatement: 'Payments & Fees',
  BankStatementLine: 'Payments & Fees',
  DigitalReceipt: 'Payments & Fees',
  IdempotencyRequest: 'Payments & Fees',
  FeeSchedule: 'Payments & Fees',
  FeeTier: 'Payments & Fees',
  TransactionCost: 'Payments & Fees',

  // 10. Payment Providers & Settlement
  PaymentProvider: 'Payment Providers & Settlement',
  MerchantAccount: 'Payment Providers & Settlement',
  FinancialProvider: 'Payment Providers & Settlement',
  FinancialConnection: 'Payment Providers & Settlement',
  FinancialAccount: 'Payment Providers & Settlement',
  EcommerceMerchant: 'Payment Providers & Settlement',
  CheckoutSession: 'Payment Providers & Settlement',
  AngelPayUserAccount: 'Payment Providers & Settlement',
  Aggregator: 'Payment Providers & Settlement',
  MerchantRevenueShare: 'Payment Providers & Settlement',
  VenuePaymentConfig: 'Payment Providers & Settlement',
  OrganizationPaymentConfig: 'Payment Providers & Settlement',
  OrganizationPayoutConfig: 'Payment Providers & Settlement',
  ProcessorReliabilityMetric: 'Payment Providers & Settlement',
  ProviderCostStructure: 'Payment Providers & Settlement',
  ProviderEventLog: 'Payment Providers & Settlement',
  SettlementConfiguration: 'Payment Providers & Settlement',
  SettlementConfirmation: 'Payment Providers & Settlement',
  SettlementIncident: 'Payment Providers & Settlement',
  SettlementSimulation: 'Payment Providers & Settlement',
  StripeWebhookEvent: 'Payment Providers & Settlement',
  ProcessedStripeEvent: 'Payment Providers & Settlement',
  MercadoPagoWebhookEvent: 'Payment Providers & Settlement',
  RateCorrectionBatch: 'Payment Providers & Settlement',
  RateCorrectionEntry: 'Payment Providers & Settlement',

  // 11. Payment Links
  PaymentLink: 'Payment Links',
  PaymentLinkItem: 'Payment Links',
  PaymentLinkItemModifier: 'Payment Links',
  PaymentLinkAttribution: 'Payment Links',
  VenuePaymentLinkSettings: 'Payment Links',

  // Facturación (CFDI)
  FiscalEmisor: 'Facturación (CFDI)',
  MerchantFiscalConfig: 'Facturación (CFDI)',
  Cfdi: 'Facturación (CFDI)',
  CustomerTaxProfile: 'Facturación (CFDI)',
  LedgerAccount: 'Facturación (CFDI)',
  AccountMapping: 'Facturación (CFDI)',
  JournalEntry: 'Facturación (CFDI)',
  JournalLine: 'Facturación (CFDI)',
  AccountingPeriodLock: 'Facturación (CFDI)',
  Expense: 'Facturación (CFDI)',
  SalesRetention: 'Facturación (CFDI)',
  FixedAsset: 'Facturación (CFDI)',
  FixedAssetDepreciation: 'Facturación (CFDI)',
  FiscalLossCarryforward: 'Facturación (CFDI)',
  Employee: 'Facturación (CFDI)',
  PayrollRun: 'Facturación (CFDI)',
  PayrollLine: 'Facturación (CFDI)',
  // Platform billing CFDI (Avoqado factura a sus propios clientes)
  PlatformEmisor: 'Facturación (CFDI)',
  BillingTaxProfile: 'Facturación (CFDI)',
  PlatformCfdi: 'Facturación (CFDI)',

  // 12. Pricing, Costs & Venue Lending
  PricingPolicy: 'Pricing, Costs & Venue Lending',
  OrganizationPricingStructure: 'Pricing, Costs & Venue Lending',
  VenuePricingStructure: 'Pricing, Costs & Venue Lending',
  MonthlyVenueProfit: 'Pricing, Costs & Venue Lending',
  CreditAssessmentHistory: 'Pricing, Costs & Venue Lending',
  VenueCreditAssessment: 'Pricing, Costs & Venue Lending',
  CreditOffer: 'Pricing, Costs & Venue Lending',

  // 13. Discounts, Loyalty & Credit Packs
  Discount: 'Discounts, Loyalty & Credit Packs',
  CustomerDiscount: 'Discounts, Loyalty & Credit Packs',
  CouponCode: 'Discounts, Loyalty & Credit Packs',
  CouponRedemption: 'Discounts, Loyalty & Credit Packs',
  LoyaltyConfig: 'Discounts, Loyalty & Credit Packs',
  LoyaltyTransaction: 'Discounts, Loyalty & Credit Packs',
  CreditPack: 'Discounts, Loyalty & Credit Packs',
  CreditPackItem: 'Discounts, Loyalty & Credit Packs',
  CreditPackPurchase: 'Discounts, Loyalty & Credit Packs',
  CreditItemBalance: 'Discounts, Loyalty & Credit Packs',
  CreditTransaction: 'Discounts, Loyalty & Credit Packs',
  ReferralProgramConfig: 'Discounts, Loyalty & Credit Packs',
  Referral: 'Discounts, Loyalty & Credit Packs',
  ReferralTierReward: 'Discounts, Loyalty & Credit Packs',
  ReferralRewardGrant: 'Discounts, Loyalty & Credit Packs',
  ReferralTierUnlock: 'Discounts, Loyalty & Credit Packs',

  // 14. Commissions & Sales Goals
  CommissionCalculation: 'Commissions & Sales Goals',
  CommissionClawback: 'Commissions & Sales Goals',
  CommissionConfig: 'Commissions & Sales Goals',
  CommissionMilestone: 'Commissions & Sales Goals',
  CommissionOverride: 'Commissions & Sales Goals',
  CommissionPayout: 'Commissions & Sales Goals',
  CommissionSummary: 'Commissions & Sales Goals',
  CommissionTier: 'Commissions & Sales Goals',
  VenueCommission: 'Commissions & Sales Goals',
  OrganizationGoal: 'Commissions & Sales Goals',
  OrganizationSalesGoalConfig: 'Commissions & Sales Goals',
  PerformanceGoal: 'Commissions & Sales Goals',
  MilestoneAchievement: 'Commissions & Sales Goals',
  CashOutCommissionRate: 'Commissions & Sales Goals',
  CashOutScheduleDay: 'Commissions & Sales Goals',
  PromoterBankAccount: 'Commissions & Sales Goals',
  PromoterCommissionEntry: 'Commissions & Sales Goals',
  CashOutWithdrawal: 'Commissions & Sales Goals',

  // 15. Reservations & Booking
  Reservation: 'Reservations & Booking',
  ReservationSettings: 'Reservations & Booking',
  ReservationModifier: 'Reservations & Booking',
  ReservationReminderSent: 'Reservations & Booking',
  ReservationWaitlistEntry: 'Reservations & Booking',
  ReservationGoogleEventMapping: 'Reservations & Booking',
  SlotHold: 'Reservations & Booking',
  ClassSession: 'Reservations & Booking',
  ExternalBusyBlock: 'Reservations & Booking',
  HolidayCalendar: 'Reservations & Booking',
  GoogleCalendarConnection: 'Reservations & Booking',
  GoogleCalendarChannel: 'Reservations & Booking',
  GoogleCalendarWebhookInbox: 'Reservations & Booking',
  GoogleOAuthSession: 'Reservations & Booking',
  CalendarSyncOutbox: 'Reservations & Booking',

  // 16. Terminals / TPV Fleet
  Terminal: 'Terminals / TPV Fleet',
  TerminalHealth: 'Terminals / TPV Fleet',
  TerminalLog: 'Terminals / TPV Fleet',
  TerminalOrder: 'Terminals / TPV Fleet',
  TerminalPaymentRequest: 'Terminals / TPV Fleet',
  TerminalOrderItem: 'Terminals / TPV Fleet',
  AppUpdate: 'Terminals / TPV Fleet',
  TpvCommandHistory: 'Terminals / TPV Fleet',
  TpvCommandQueue: 'Terminals / TPV Fleet',
  TpvFeedback: 'Terminals / TPV Fleet',
  TpvMessage: 'Terminals / TPV Fleet',
  TpvMessageDelivery: 'Terminals / TPV Fleet',
  TpvMessageResponse: 'Terminals / TPV Fleet',
  PosCommand: 'Terminals / TPV Fleet',
  PosConnectionStatus: 'Terminals / TPV Fleet',
  ScheduledCommand: 'Terminals / TPV Fleet',
  BulkCommandOperation: 'Terminals / TPV Fleet',
  GeofenceRule: 'Terminals / TPV Fleet',
  VenueCryptoConfig: 'Terminals / TPV Fleet',

  // 17. Notifications, WhatsApp & Marketing
  Notification: 'Notifications, WhatsApp & Marketing',
  NotificationPreference: 'Notifications, WhatsApp & Marketing',
  NotificationTemplate: 'Notifications, WhatsApp & Marketing',
  EmailTemplate: 'Notifications, WhatsApp & Marketing',
  VenueChatSession: 'Notifications, WhatsApp & Marketing',
  VenueChatMessage: 'Notifications, WhatsApp & Marketing',
  VenueWhatsappActivation: 'Notifications, WhatsApp & Marketing',
  WhatsappContactWindow: 'Notifications, WhatsApp & Marketing',
  WhatsappInboundEvent: 'Notifications, WhatsApp & Marketing',
  MarketingCampaign: 'Notifications, WhatsApp & Marketing',
  CampaignDelivery: 'Notifications, WhatsApp & Marketing',

  // 18. AI Chatbot (Text-to-SQL)
  ChatConversation: 'AI Chatbot (Text-to-SQL)',
  ChatMessage: 'AI Chatbot (Text-to-SQL)',
  ChatFeedback: 'AI Chatbot (Text-to-SQL)',
  ChatLearningEvent: 'AI Chatbot (Text-to-SQL)',
  ChatTrainingData: 'AI Chatbot (Text-to-SQL)',
  LearnedPatterns: 'AI Chatbot (Text-to-SQL)',

  // 19. Customers, Consumers & Reviews
  Customer: 'Customers, Consumers & Reviews',
  CustomerGroup: 'Customers, Consumers & Reviews',
  Consumer: 'Customers, Consumers & Reviews',
  ConsumerAuthAccount: 'Customers, Consumers & Reviews',
  OtpChallenge: 'Customers, Consumers & Reviews',
  Review: 'Customers, Consumers & Reviews',

  // 20. System: Audit, Webhooks & Platform
  ActivityLog: 'System: Audit, Webhooks & Platform',
  WebhookEvent: 'System: Audit, Webhooks & Platform',
  WebhookSubscription: 'System: Audit, Webhooks & Platform',
  PartnerAPIKey: 'System: Audit, Webhooks & Platform',
  PlatformSettings: 'System: Audit, Webhooks & Platform',
}

// ---------------------------------------------------------------------------
// Static doc text — intro/header (above the table) and closing note (below the
// auto-generated section). Kept verbatim so the generator only owns the table
// and the model index.
// ---------------------------------------------------------------------------

const INTRO = `# Schema Domain Map — avoqado-server

\`prisma/schema.prisma\` is **{MODEL_COUNT} models / {ENUM_COUNT} enums / ~{LINE_COUNT} lines**. Nobody reads it
top to bottom. This file is the **index**: {DOMAIN_COUNT} domains, what each is for, and where it
lives. Find your domain → jump to the \`schema.prisma:LINE\` → for field-level detail
read \`docs/DATABASE_SCHEMA.md\`.

**How to use this:** "I need to touch X" → scan the *What it is* column → open the
domain at its line. Every model is listed once, in its primary domain.

**Universal rules** (also in \`.claude/rules/critical-warnings.md\`):
- Every row of every table is scoped by \`venueId\` or \`orgId\`. Multi-tenant: \`Organization → Venue → data\`.
- Money is \`Decimal\`, never float. Money writes go in \`prisma.$transaction()\`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See \`.claude/rules/feature-gating.md\`.

## The {DOMAIN_COUNT} domains
`

const TABLE_NOTE = `
> Line numbers are section starts and drift as the schema grows — treat them as
> "jump near here", then search for the exact \`model Name {\`. When the map goes stale,
> regenerate it: \`npm run schema:map\` (CI runs it automatically on \`prisma/schema.prisma\` changes).
`

// ---------------------------------------------------------------------------
// Schema parsing
// ---------------------------------------------------------------------------

interface ParsedSchema {
  /** model name -> 1-based line number of `model <Name> {` */
  models: Record<string, number>
  enumCount: number
  lineCount: number
}

function parseSchema(schemaText: string): ParsedSchema {
  const lines = schemaText.split('\n')
  const models: Record<string, number> = {}
  let enumCount = 0

  const modelRe = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/
  const enumRe = /^enum\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/

  lines.forEach((line, idx) => {
    const modelMatch = line.match(modelRe)
    if (modelMatch) {
      models[modelMatch[1]] = idx + 1 // 1-based
      return
    }
    if (enumRe.test(line)) {
      enumCount++
    }
  })

  return { models, enumCount, lineCount: lines.length }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function buildDocument(parsed: ParsedSchema): string {
  const modelNames = Object.keys(parsed.models)
  const modelCount = modelNames.length

  // Group models by domain
  const domainModels: Record<string, string[]> = {}
  for (const d of DOMAINS) domainModels[d.name] = []
  for (const name of modelNames) {
    const domain = MODEL_TO_DOMAIN[name]
    domainModels[domain].push(name)
  }

  // Intro with live counts. Round line count down to nearest 100 to match the
  // existing "~9,700 lines" phrasing.
  const roundedLines = Math.floor(parsed.lineCount / 100) * 100
  const intro = INTRO.replace('{MODEL_COUNT}', String(modelCount))
    .replace('{ENUM_COUNT}', String(parsed.enumCount))
    .replace('{LINE_COUNT}', roundedLines.toLocaleString('en-US'))
    .replace(/\{DOMAIN_COUNT\}/g, String(DOMAINS.length))

  // Domain table
  const tableRows: string[] = []
  tableRows.push('| # | Domain | What it is | Models (`schema.prisma`) |')
  tableRows.push('|---|--------|-----------|--------------------------|')
  DOMAINS.forEach((d, i) => {
    const sorted = [...domainModels[d.name]].sort((a, b) => a.localeCompare(b))
    const modelList = sorted.map(m => `\`${m}\``).join(', ')
    tableRows.push(`| ${i + 1} | **${d.name}** | ${d.description} | ${modelList} |`)
  })

  // Auto-generated model index (A-Z)
  const indexLines: string[] = []
  indexLines.push('## Model index')
  indexLines.push('')
  indexLines.push('<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->')
  indexLines.push('')
  indexLines.push('Every model A–Z with its location in `prisma/schema.prisma`.')
  indexLines.push('')
  const sortedAll = [...modelNames].sort((a, b) => a.localeCompare(b))
  for (const name of sortedAll) {
    indexLines.push(`- \`${name}\` → \`schema.prisma:L${parsed.models[name]}\``)
  }

  return [intro.trimEnd(), '', tableRows.join('\n'), TABLE_NOTE.trimEnd(), '', indexLines.join('\n'), ''].join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const checkMode = process.argv.includes('--check')

  if (!fs.existsSync(SCHEMA_PATH)) {
    console.error(`❌ Schema not found at ${SCHEMA_PATH}`)
    process.exit(1)
  }

  const schemaText = fs.readFileSync(SCHEMA_PATH, 'utf8')
  const parsed = parseSchema(schemaText)
  const modelNames = Object.keys(parsed.models)

  // Fail if any model is unclassified.
  const unclassified = modelNames.filter(name => !(name in MODEL_TO_DOMAIN))
  if (unclassified.length > 0) {
    console.error('❌ Unclassified model(s) found in prisma/schema.prisma:')
    for (const name of unclassified.sort()) console.error(`   - ${name}`)
    console.error('')
    console.error(
      'Add each model to MODEL_TO_DOMAIN in scripts/generate-schema-map.ts ' +
        `(pick one of the ${DOMAINS.length} domains), then re-run \`npm run schema:map\`.`,
    )
    process.exit(1)
  }

  // Warn if MODEL_TO_DOMAIN references a model that no longer exists. This is
  // not fatal — it just means a model was removed/renamed.
  const stale = Object.keys(MODEL_TO_DOMAIN).filter(name => !(name in parsed.models))
  if (stale.length > 0) {
    console.warn('⚠️  MODEL_TO_DOMAIN lists model(s) not in schema.prisma (remove them):')
    for (const name of stale.sort()) console.warn(`   - ${name}`)
  }

  const rawDocument = buildDocument(parsed)

  // Format the generated Markdown through the project's Prettier config so the
  // output is byte-identical to what `npm run format` (`prettier --write .`)
  // produces. Without this, `npm run format` reflows docs/SCHEMA_MAP.md (it is
  // NOT in .prettierignore) and the next `npm run schema:map` re-emits the raw
  // form, so the file is perpetually "out of date" even when no model changed.
  // That false drift is what made the Schema Map workflow auto-commit on every
  // run and fail with GH006 when it tried to push to protected `main`.
  const prettierConfig = await prettier.resolveConfig(MAP_PATH)
  const generated = await prettier.format(rawDocument, { ...prettierConfig, parser: 'markdown' })

  if (checkMode) {
    const current = fs.existsSync(MAP_PATH) ? fs.readFileSync(MAP_PATH, 'utf8') : ''
    if (current !== generated) {
      console.error('❌ docs/SCHEMA_MAP.md is out of date.')
      console.error('   Run `npm run schema:map` and commit the result.')
      process.exit(1)
    }
    console.log(`✅ docs/SCHEMA_MAP.md is up to date (${modelNames.length} models, ${parsed.enumCount} enums).`)
    process.exit(0)
  }

  fs.writeFileSync(MAP_PATH, generated, 'utf8')
  console.log(`✅ Regenerated docs/SCHEMA_MAP.md — ${modelNames.length} models, ` + `${parsed.enumCount} enums, ${parsed.lineCount} lines.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
