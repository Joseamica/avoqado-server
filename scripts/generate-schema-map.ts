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
    name: 'Master Catalog & Publication',
    description: 'Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.',
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
  OrganizationEntitlement: 'Modules, Features & Billing',
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
  McpToolCall: 'Staff, Auth, Permissions & Time',
  StaffPasskey: 'Staff, Auth, Permissions & Time',
  user_sessions: 'Staff, Auth, Permissions & Time',
  Session: 'Staff, Auth, Permissions & Time',
  RefreshGrant: 'Staff, Auth, Permissions & Time',
  PermissionSet: 'Staff, Auth, Permissions & Time',
  VenueRoleConfig: 'Staff, Auth, Permissions & Time',
  VenueRolePermission: 'Staff, Auth, Permissions & Time',
  PermissionOverride: 'Staff, Auth, Permissions & Time',
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

  // 6. Master Catalog & Publication
  // Keep the whole H1 aggregate together: runtime Product and Venue retain
  // their legacy domains while corporate identity/publication stays explicit.
  CatalogBrand: 'Master Catalog & Publication',
  CatalogManufacturer: 'Master Catalog & Publication',
  CatalogFamily: 'Master Catalog & Publication',
  CatalogItem: 'Master Catalog & Publication',
  CatalogItemBusinessType: 'Master Catalog & Publication',
  CatalogProductTypeMapping: 'Master Catalog & Publication',
  CatalogIdentifier: 'Master Catalog & Publication',
  CatalogValidationProfile: 'Master Catalog & Publication',
  CatalogItemPrice: 'Master Catalog & Publication',
  CatalogVenueRollout: 'Master Catalog & Publication',
  CatalogVenueClientRequirement: 'Master Catalog & Publication',
  CatalogClientObservation: 'Master Catalog & Publication',
  CatalogClientReadinessOverride: 'Master Catalog & Publication',
  CatalogVenueBinding: 'Master Catalog & Publication',
  CatalogVenueOverride: 'Master Catalog & Publication',
  CatalogIdempotencyRecord: 'Master Catalog & Publication',
  CatalogImportBatch: 'Master Catalog & Publication',
  CatalogImportLine: 'Master Catalog & Publication',
  CatalogBindingBatch: 'Master Catalog & Publication',
  CatalogBindingLine: 'Master Catalog & Publication',
  CatalogPublicationBatch: 'Master Catalog & Publication',
  CatalogPublicationLine: 'Master Catalog & Publication',
  CatalogPublicationFieldDecision: 'Master Catalog & Publication',
  CatalogVenueEventSequence: 'Master Catalog & Publication',
  CatalogPublicationOutbox: 'Master Catalog & Publication',

  // 7. Inventory & Stock
  Inventory: 'Inventory & Stock',
  InventoryMovement: 'Inventory & Stock',
  InventoryPosting: 'Inventory & Stock',
  InventoryPostingLine: 'Inventory & Stock',
  InventoryTransfer: 'Inventory & Stock',
  InterVenueTransfer: 'Inventory & Stock',
  InterVenueTransferItem: 'Inventory & Stock',
  InterVenueTransferAllocation: 'Inventory & Stock',
  InterVenueTransferReceipt: 'Inventory & Stock',
  InterVenueTransferReceiptLine: 'Inventory & Stock',
  InterVenueTransferVarianceResolution: 'Inventory & Stock',
  InterVenueTransferVarianceLine: 'Inventory & Stock',
  StockBatch: 'Inventory & Stock',
  StockCount: 'Inventory & Stock',
  StockCountItem: 'Inventory & Stock',
  StockAlertConfig: 'Inventory & Stock',
  LowStockAlert: 'Inventory & Stock',
  RawMaterial: 'Inventory & Stock',
  RawMaterialMovement: 'Inventory & Stock',
  RawMaterialPresentation: 'Inventory & Stock',
  Recipe: 'Inventory & Stock',
  RecipeLine: 'Inventory & Stock',
  Supplier: 'Inventory & Stock',
  SupplierPricing: 'Inventory & Stock',
  PurchaseOrder: 'Inventory & Stock',
  PurchaseOrderItem: 'Inventory & Stock',
  PurchaseOrderInvoice: 'Inventory & Stock',
  PurchaseOrderInvoiceLine: 'Inventory & Stock',
  SupplierItemCode: 'Inventory & Stock',
  StaffDocument: 'Staff, Auth, Permissions & Time',
  StaffWorkSchedule: 'Staff, Auth, Permissions & Time',
  StaffWorkScheduleException: 'Staff, Auth, Permissions & Time',
  OvertimeApproval: 'Staff, Auth, Permissions & Time',
  WorkShiftTemplate: 'Staff, Auth, Permissions & Time',
  WorkShiftAssignment: 'Staff, Auth, Permissions & Time',

  // 8. Serialized Inventory
  SerializedItem: 'Serialized Inventory',
  SerializedItemCustodyEvent: 'Serialized Inventory',
  SimRegistrationRequest: 'Serialized Inventory',
  SimRegistrationRequestItem: 'Serialized Inventory',
  SaleVerification: 'Serialized Inventory',

  // 9. Orders, KDS & Cash
  Order: 'Orders, KDS & Cash',
  OrderItem: 'Orders, KDS & Cash',
  OrderItemModifier: 'Orders, KDS & Cash',
  OrderAction: 'Orders, KDS & Cash',
  OrderDiscount: 'Orders, KDS & Cash',
  ServiceCharge: 'Orders, KDS & Cash',
  OrderServiceCharge: 'Orders, KDS & Cash',
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
  DeliveryChannelLink: 'Orders, KDS & Cash',
  DeliveryOrderEvent: 'Orders, KDS & Cash',
  DeliveryActivationRequest: 'Orders, KDS & Cash',
  PosSyncIntent: 'Orders, KDS & Cash',
  // Vales por área (AREA_TICKETS): cuenta compartida entre áreas emisoras + entrega.
  // Cuelgan de Order/OrderItem/PrintStation, por eso van con sus hermanos de orden.
  FulfillmentArea: 'Orders, KDS & Cash',
  OrderFulfillment: 'Orders, KDS & Cash',
  OrderFulfillmentLine: 'Orders, KDS & Cash',
  VenueAreaTicketSettings: 'Orders, KDS & Cash',
  AreaTicket: 'Orders, KDS & Cash',
  AreaTicketLine: 'Orders, KDS & Cash',
  AreaTicketInventoryReservation: 'Orders, KDS & Cash',
  AreaTicketCheckoutSession: 'Orders, KDS & Cash',
  AreaTicketPaymentAttempt: 'Orders, KDS & Cash',
  AreaTicketPrintAttempt: 'Orders, KDS & Cash',
  AreaTicketFulfillment: 'Orders, KDS & Cash',
  AreaTicketExternalSettlement: 'Orders, KDS & Cash',
  AreaTicketExternalIncident: 'Orders, KDS & Cash',

  // 10. Payments & Fees
  Payment: 'Payments & Fees',
  PaymentAllocation: 'Payments & Fees',
  VenueTenderType: 'Payments & Fees',
  VenueTenderTypeRevision: 'Payments & Fees',
  MerchantRoutingRule: 'Payments & Fees',
  VenueTransaction: 'Payments & Fees',
  BankStatement: 'Payments & Fees',
  BankStatementLine: 'Payments & Fees',
  DigitalReceipt: 'Payments & Fees',
  IdempotencyRequest: 'Payments & Fees',
  FeeSchedule: 'Payments & Fees',
  FeeTier: 'Payments & Fees',
  TransactionCost: 'Payments & Fees',

  // 11. Payment Providers & Settlement
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

  // 12. Payment Links
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

  // 13. Pricing, Costs & Venue Lending
  PricingPolicy: 'Pricing, Costs & Venue Lending',
  OrganizationPricingStructure: 'Pricing, Costs & Venue Lending',
  VenuePricingStructure: 'Pricing, Costs & Venue Lending',
  MonthlyVenueProfit: 'Pricing, Costs & Venue Lending',
  CreditAssessmentHistory: 'Pricing, Costs & Venue Lending',
  VenueCreditAssessment: 'Pricing, Costs & Venue Lending',
  CreditOffer: 'Pricing, Costs & Venue Lending',

  // 14. Discounts, Loyalty & Credit Packs
  Discount: 'Discounts, Loyalty & Credit Packs',
  CustomerDiscount: 'Discounts, Loyalty & Credit Packs',
  // Upsell "¿Algo más?" — vive aquí porque es la misma familia comercial que
  // descuentos/promos: qué se le empuja al cliente y con qué evidencia.
  UpsellRule: 'Discounts, Loyalty & Credit Packs',
  UpsellImpression: 'Discounts, Loyalty & Credit Packs',
  UpsellAcceptance: 'Discounts, Loyalty & Credit Packs',
  UpsellAiRun: 'Discounts, Loyalty & Credit Packs',
  // Promociones del POS (bundle/combo/2x1) — misma familia comercial.
  Promotion: 'Discounts, Loyalty & Credit Packs',
  PromotionGroup: 'Discounts, Loyalty & Credit Packs',
  PromotionOption: 'Discounts, Loyalty & Credit Packs',
  // La instancia vendida vive con las órdenes: es dinero cobrado, no catálogo.
  OrderPromotion: 'Orders, KDS & Cash',
  CouponCode: 'Discounts, Loyalty & Credit Packs',
  CouponRedemption: 'Discounts, Loyalty & Credit Packs',
  LoyaltyConfig: 'Discounts, Loyalty & Credit Packs',
  LoyaltyTransaction: 'Discounts, Loyalty & Credit Packs',
  CustomerOrderMetric: 'Discounts, Loyalty & Credit Packs',
  WalletPass: 'Discounts, Loyalty & Credit Packs',
  WalletCardDesign: 'Discounts, Loyalty & Credit Packs',
  WalletPassRegistration: 'Discounts, Loyalty & Credit Packs',
  StampCard: 'Discounts, Loyalty & Credit Packs',
  StampEvent: 'Discounts, Loyalty & Credit Packs',
  StampReward: 'Discounts, Loyalty & Credit Packs',
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

  // 15. Commissions & Sales Goals
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

  // 16. Reservations & Booking
  Reservation: 'Reservations & Booking',
  KioskCheckInChallenge: 'Reservations & Booking',
  KioskCheckInAttempt: 'Reservations & Booking',
  KioskOutreachOutbox: 'Reservations & Booking',
  ReservationSettings: 'Reservations & Booking',
  ReservationModifier: 'Reservations & Booking',
  ReservationReminderSent: 'Reservations & Booking',
  ReservationWaitlistEntry: 'Reservations & Booking',
  ReservationGoogleEventMapping: 'Reservations & Booking',
  SlotHold: 'Reservations & Booking',
  ClassSession: 'Reservations & Booking',
  StaffSchedule: 'Reservations & Booking',
  StaffScheduleException: 'Reservations & Booking',
  ProductStaff: 'Reservations & Booking',
  ExternalBusyBlock: 'Reservations & Booking',
  HolidayCalendar: 'Reservations & Booking',
  GoogleCalendarConnection: 'Reservations & Booking',
  GoogleCalendarChannel: 'Reservations & Booking',
  GoogleCalendarWebhookInbox: 'Reservations & Booking',
  GoogleOAuthSession: 'Reservations & Booking',
  CalendarSyncOutbox: 'Reservations & Booking',

  // 17. Terminals / TPV Fleet
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
  VenueScaleSettings: 'Terminals / TPV Fleet',
  ScaleProfile: 'Terminals / TPV Fleet',

  // 18. Notifications, WhatsApp & Marketing
  Notification: 'Notifications, WhatsApp & Marketing',
  NotificationPreference: 'Notifications, WhatsApp & Marketing',
  PlatformAnnouncement: 'Notifications, WhatsApp & Marketing',
  PlatformAnnouncementClick: 'Notifications, WhatsApp & Marketing',
  PlatformAnnouncementDelivery: 'Notifications, WhatsApp & Marketing',
  NotificationTemplate: 'Notifications, WhatsApp & Marketing',
  EmailTemplate: 'Notifications, WhatsApp & Marketing',
  VenueChatSession: 'Notifications, WhatsApp & Marketing',
  VenueChatMessage: 'Notifications, WhatsApp & Marketing',
  VenueWhatsappActivation: 'Notifications, WhatsApp & Marketing',
  WhatsappContactWindow: 'Notifications, WhatsApp & Marketing',
  WhatsappInboundEvent: 'Notifications, WhatsApp & Marketing',
  MarketingCampaign: 'Notifications, WhatsApp & Marketing',
  CampaignDelivery: 'Notifications, WhatsApp & Marketing',

  // 19. AI Chatbot (Text-to-SQL)
  ChatConversation: 'AI Chatbot (Text-to-SQL)',
  ChatMessage: 'AI Chatbot (Text-to-SQL)',
  ChatFeedback: 'AI Chatbot (Text-to-SQL)',
  ChatLearningEvent: 'AI Chatbot (Text-to-SQL)',
  ChatTrainingData: 'AI Chatbot (Text-to-SQL)',
  LearnedPatterns: 'AI Chatbot (Text-to-SQL)',

  // 20. Customers, Consumers & Reviews
  Customer: 'Customers, Consumers & Reviews',
  CustomerGroup: 'Customers, Consumers & Reviews',
  // Fase 1 — aprobación del cliente por el venue: el evento y su entrega por destinatario
  CustomerApprovalOutbox: 'Customers, Consumers & Reviews',
  CustomerApprovalDelivery: 'Customers, Consumers & Reviews',
  Consumer: 'Customers, Consumers & Reviews',
  ConsumerAuthAccount: 'Customers, Consumers & Reviews',
  OtpChallenge: 'Customers, Consumers & Reviews',
  Review: 'Customers, Consumers & Reviews',
  // Fase 0 — consentimiento y captura de datos para campañas de correo
  ConsentEvent: 'Customers, Consumers & Reviews',
  PrivacyNoticeVersion: 'Customers, Consumers & Reviews',
  CustomerCaptureToken: 'Customers, Consumers & Reviews',
  // Fase 1A — carril de envío de campañas de correo a clientes
  CustomerCampaign: 'Customers, Consumers & Reviews',
  CustomerCampaignDelivery: 'Customers, Consumers & Reviews',
  EmailSuppression: 'Customers, Consumers & Reviews',
  EmailQuotaLedger: 'Customers, Consumers & Reviews',

  // 21. System: Audit, Webhooks & Platform
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
