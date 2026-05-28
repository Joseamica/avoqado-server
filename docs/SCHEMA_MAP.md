# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **209 models / 181 enums / ~9,900 lines**. Nobody reads it
top to bottom. This file is the **index**: 20 domains, what each is for, and where it
lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail
read `docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the *What it is* column → open the
domain at its line. Every model is listed once, in its primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):
- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 20 domains

| # | Domain | What it is | Models (`schema.prisma`) |
|---|--------|-----------|--------------------------|
| 1 | **Multi-Tenant Core** | The org/venue tree + physical floor layout. The root every other table hangs off. | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone` |
| 2 | **Modules, Features & Billing** | What a venue pays for / is gated on, and how Avoqado invoices it. | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule` |
| 3 | **Staff, Auth, Permissions & Time** | Who works where, how they log in, what they may do, and hours worked. | `DeviceToken`, `Invitation`, `OAuthState`, `PermissionSet`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission` |
| 4 | **Onboarding & Training** | New-venue/new-staff onboarding state + the LMS. | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep` |
| 5 | **Menu, Products & Modifiers** | The catalog: what a venue sells and its variants/add-ons. | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion` |
| 6 | **Inventory & Stock** | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches. | `Inventory`, `InventoryMovement`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing` |
| 7 | **Serialized Inventory** | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification. | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent` |
| 8 | **Orders, KDS & Cash** | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja. | `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderItem`, `OrderItemModifier`, `Shift` |
| 9 | **Payments & Fees** | The payment record itself + allocations, receipts, fee schedules. | `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction` |
| 10 | **Payment Providers & Settlement** | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement. | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig` |
| 11 | **Payment Links** | Pay-by-link: links, line items, attribution. | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings` |
| 12 | **Pricing, Costs & Venue Lending** | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment. | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure` |
| 13 | **Discounts, Loyalty & Credit Packs** | Discounts/coupons, loyalty points, and prepaid credit-pack bundles. | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction` |
| 14 | **Commissions & Sales Goals** | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter). | `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `VenueCommission` |
| 15 | **Reservations & Booking** | Appointments/classes, waitlist, slot holds, Google Calendar sync. | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold` |
| 16 | **Terminals / TPV Fleet** | PAX terminal fleet: health, logs, app updates, remote commands, messaging. | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig` |
| 17 | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns. | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent` |
| 18 | **AI Chatbot (Text-to-SQL)** | The in-dashboard AI assistant: conversations, training data, learned patterns. | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns` |
| 19 | **Customers, Consumers & Reviews** | End-customer identity (venue customers + cross-venue Consumers) and reviews. | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerGroup`, `Review` |
| 20 | **System: Audit, Webhooks & Platform** | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings. | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription` |

> Line numbers are section starts and drift as the schema grows — treat them as
> "jump near here", then search for the exact `model Name {`. When the map goes stale,
> regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `ActivityLog` → `schema.prisma:L4633`
- `Aggregator` → `schema.prisma:L9762`
- `AngelPayUserAccount` → `schema.prisma:L3444`
- `AppUpdate` → `schema.prisma:L8056`
- `Area` → `schema.prisma:L1987`
- `BulkCommandOperation` → `schema.prisma:L6511`
- `CalendarSyncOutbox` → `schema.prisma:L9165`
- `CampaignDelivery` → `schema.prisma:L8206`
- `CashCloseout` → `schema.prisma:L6844`
- `CashDeposit` → `schema.prisma:L7883`
- `CashDrawerEvent` → `schema.prisma:L9608`
- `CashDrawerSession` → `schema.prisma:L9584`
- `ChatbotTokenBudget` → `schema.prisma:L6159`
- `ChatConversation` → `schema.prisma:L6014`
- `ChatFeedback` → `schema.prisma:L6100`
- `ChatLearningEvent` → `schema.prisma:L6057`
- `ChatMessage` → `schema.prisma:L6037`
- `ChatTrainingData` → `schema.prisma:L5971`
- `CheckoutSession` → `schema.prisma:L3722`
- `ClassSession` → `schema.prisma:L8786`
- `CommissionCalculation` → `schema.prisma:L7662`
- `CommissionClawback` → `schema.prisma:L7835`
- `CommissionConfig` → `schema.prisma:L7440`
- `CommissionMilestone` → `schema.prisma:L7578`
- `CommissionOverride` → `schema.prisma:L7510`
- `CommissionPayout` → `schema.prisma:L7786`
- `CommissionSummary` → `schema.prisma:L7725`
- `CommissionTier` → `schema.prisma:L7547`
- `Consumer` → `schema.prisma:L4733`
- `ConsumerAuthAccount` → `schema.prisma:L4758`
- `CouponCode` → `schema.prisma:L4948`
- `CouponRedemption` → `schema.prisma:L4979`
- `CreditAssessmentHistory` → `schema.prisma:L6953`
- `CreditItemBalance` → `schema.prisma:L9374`
- `CreditOffer` → `schema.prisma:L6972`
- `CreditPack` → `schema.prisma:L9290`
- `CreditPackItem` → `schema.prisma:L9319`
- `CreditPackPurchase` → `schema.prisma:L9336`
- `CreditTransaction` → `schema.prisma:L9396`
- `Customer` → `schema.prisma:L4659`
- `CustomerDiscount` → `schema.prisma:L4999`
- `CustomerGroup` → `schema.prisma:L4777`
- `DeviceToken` → `schema.prisma:L5194`
- `DigitalReceipt` → `schema.prisma:L2755`
- `Discount` → `schema.prisma:L4859`
- `EcommerceMerchant` → `schema.prisma:L3537`
- `EmailTemplate` → `schema.prisma:L8145`
- `Estimate` → `schema.prisma:L9669`
- `EstimateItem` → `schema.prisma:L9697`
- `ExternalBusyBlock` → `schema.prisma:L9058`
- `Feature` → `schema.prisma:L2884`
- `FeeSchedule` → `schema.prisma:L2959`
- `FeeTier` → `schema.prisma:L2970`
- `FloorElement` → `schema.prisma:L2063`
- `GeofenceRule` → `schema.prisma:L6596`
- `GoogleCalendarChannel` → `schema.prisma:L9035`
- `GoogleCalendarConnection` → `schema.prisma:L8987`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9088`
- `GoogleOAuthSession` → `schema.prisma:L9110`
- `HolidayCalendar` → `schema.prisma:L4557`
- `IdempotencyRequest` → `schema.prisma:L7324`
- `Inventory` → `schema.prisma:L1419`
- `InventoryMovement` → `schema.prisma:L1443`
- `InventoryTransfer` → `schema.prisma:L9641`
- `Invitation` → `schema.prisma:L1032`
- `Invoice` → `schema.prisma:L2982`
- `InvoiceItem` → `schema.prisma:L3008`
- `ItemCategory` → `schema.prisma:L7104`
- `KdsOrder` → `schema.prisma:L9802`
- `KdsOrderItem` → `schema.prisma:L9819`
- `LearnedPatterns` → `schema.prisma:L6081`
- `LiveDemoSession` → `schema.prisma:L583`
- `LowStockAlert` → `schema.prisma:L1858`
- `LoyaltyConfig` → `schema.prisma:L4807`
- `LoyaltyTransaction` → `schema.prisma:L4830`
- `MarketingCampaign` → `schema.prisma:L8163`
- `MeasurementUnit` → `schema.prisma:L9747`
- `Menu` → `schema.prisma:L1209`
- `MenuCategory` → `schema.prisma:L1155`
- `MenuCategoryAssignment` → `schema.prisma:L1244`
- `MercadoPagoWebhookEvent` → `schema.prisma:L9878`
- `MerchantAccount` → `schema.prisma:L3321`
- `MerchantRevenueShare` → `schema.prisma:L4137`
- `MilestoneAchievement` → `schema.prisma:L7623`
- `Modifier` → `schema.prisma:L2502`
- `ModifierGroup` → `schema.prisma:L2466`
- `Module` → `schema.prisma:L7020`
- `MoneyAnomaly` → `schema.prisma:L4040`
- `MonthlyVenueProfit` → `schema.prisma:L4583`
- `Notification` → `schema.prisma:L5096`
- `NotificationPreference` → `schema.prisma:L5143`
- `NotificationTemplate` → `schema.prisma:L5170`
- `OAuthState` → `schema.prisma:L1083`
- `OnboardingProgress` → `schema.prisma:L1101`
- `Order` → `schema.prisma:L2250`
- `OrderAction` → `schema.prisma:L2567`
- `OrderCustomer` → `schema.prisma:L2371`
- `OrderDiscount` → `schema.prisma:L5031`
- `OrderItem` → `schema.prisma:L2387`
- `OrderItemModifier` → `schema.prisma:L2551`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L7997`
- `OrganizationGoal` → `schema.prisma:L7955`
- `OrganizationModule` → `schema.prisma:L7076`
- `OrganizationPaymentConfig` → `schema.prisma:L3846`
- `OrganizationPayoutConfig` → `schema.prisma:L8023`
- `OrganizationPricingStructure` → `schema.prisma:L3878`
- `OrganizationSalesGoalConfig` → `schema.prisma:L7978`
- `PartnerAPIKey` → `schema.prisma:L3676`
- `Payment` → `schema.prisma:L2600`
- `PaymentAllocation` → `schema.prisma:L2734`
- `PaymentLink` → `schema.prisma:L9442`
- `PaymentLinkAttribution` → `schema.prisma:L9550`
- `PaymentLinkItem` → `schema.prisma:L9505`
- `PaymentLinkItemModifier` → `schema.prisma:L9532`
- `PaymentProvider` → `schema.prisma:L3280`
- `PerformanceGoal` → `schema.prisma:L7932`
- `PermissionSet` → `schema.prisma:L983`
- `PlatformSettings` → `schema.prisma:L3653`
- `PosCommand` → `schema.prisma:L5224`
- `PosConnectionStatus` → `schema.prisma:L659`
- `PricingPolicy` → `schema.prisma:L1769`
- `ProcessedStripeEvent` → `schema.prisma:L4026`
- `ProcessorReliabilityMetric` → `schema.prisma:L4511`
- `Product` → `schema.prisma:L1262`
- `ProductModifierGroup` → `schema.prisma:L2539`
- `ProductOption` → `schema.prisma:L9724`
- `ProductOptionValue` → `schema.prisma:L9735`
- `ProviderCostStructure` → `schema.prisma:L4062`
- `ProviderEventLog` → `schema.prisma:L3955`
- `PurchaseOrder` → `schema.prisma:L1684`
- `PurchaseOrderItem` → `schema.prisma:L1740`
- `RateCorrectionBatch` → `schema.prisma:L4287`
- `RateCorrectionEntry` → `schema.prisma:L4329`
- `RawMaterial` → `schema.prisma:L1473`
- `RawMaterialMovement` → `schema.prisma:L1822`
- `Recipe` → `schema.prisma:L1538`
- `RecipeLine` → `schema.prisma:L1562`
- `Reservation` → `schema.prisma:L8542`
- `ReservationGoogleEventMapping` → `schema.prisma:L9222`
- `ReservationModifier` → `schema.prisma:L8701`
- `ReservationReminderSent` → `schema.prisma:L8684`
- `ReservationSettings` → `schema.prisma:L8862`
- `ReservationWaitlistEntry` → `schema.prisma:L8830`
- `Review` → `schema.prisma:L3026`
- `SaleVerification` → `schema.prisma:L2788`
- `ScheduledCommand` → `schema.prisma:L6556`
- `SerializedItem` → `schema.prisma:L7146`
- `SerializedItemCustodyEvent` → `schema.prisma:L7300`
- `SettlementConfiguration` → `schema.prisma:L4362`
- `SettlementConfirmation` → `schema.prisma:L4475`
- `SettlementIncident` → `schema.prisma:L4426`
- `SettlementSimulation` → `schema.prisma:L4397`
- `Shift` → `schema.prisma:L2101`
- `SlotHold` → `schema.prisma:L8741`
- `Staff` → `schema.prisma:L679`
- `StaffOnboardingState` → `schema.prisma:L9848`
- `StaffOrganization` → `schema.prisma:L897`
- `StaffPasskey` → `schema.prisma:L924`
- `StaffVenue` → `schema.prisma:L842`
- `StockAlertConfig` → `schema.prisma:L7914`
- `StockBatch` → `schema.prisma:L1941`
- `StockCount` → `schema.prisma:L1890`
- `StockCountItem` → `schema.prisma:L1911`
- `StripeWebhookEvent` → `schema.prisma:L4009`
- `Supplier` → `schema.prisma:L1597`
- `SupplierPricing` → `schema.prisma:L1650`
- `Table` → `schema.prisma:L2013`
- `Terminal` → `schema.prisma:L3077`
- `TerminalHealth` → `schema.prisma:L3213`
- `TerminalLog` → `schema.prisma:L3187`
- `TimeEntry` → `schema.prisma:L2166`
- `TimeEntryBreak` → `schema.prisma:L2235`
- `TokenPurchase` → `schema.prisma:L6230`
- `TokenUsageRecord` → `schema.prisma:L6202`
- `TpvCommandHistory` → `schema.prisma:L6462`
- `TpvCommandQueue` → `schema.prisma:L6402`
- `TpvFeedback` → `schema.prisma:L6115`
- `TpvMessage` → `schema.prisma:L8238`
- `TpvMessageDelivery` → `schema.prisma:L8290`
- `TpvMessageResponse` → `schema.prisma:L8313`
- `TrainingModule` → `schema.prisma:L8368`
- `TrainingProgress` → `schema.prisma:L8445`
- `TrainingQuizQuestion` → `schema.prisma:L8427`
- `TrainingStep` → `schema.prisma:L8407`
- `TransactionCost` → `schema.prisma:L4225`
- `UnitConversion` → `schema.prisma:L1800`
- `user_sessions` → `schema.prisma:L3711`
- `Venue` → `schema.prisma:L105`
- `VenueChatMessage` → `schema.prisma:L559`
- `VenueChatSession` → `schema.prisma:L514`
- `VenueCommission` → `schema.prisma:L9780`
- `VenueCreditAssessment` → `schema.prisma:L6892`
- `VenueCryptoConfig` → `schema.prisma:L8105`
- `VenueFeature` → `schema.prisma:L2902`
- `VenueModule` → `schema.prisma:L7048`
- `VenuePaymentConfig` → `schema.prisma:L3812`
- `VenuePaymentLinkSettings` → `schema.prisma:L9255`
- `VenuePricingStructure` → `schema.prisma:L4165`
- `VenueRoleConfig` → `schema.prisma:L1012`
- `VenueRolePermission` → `schema.prisma:L954`
- `VenueSettings` → `schema.prisma:L599`
- `VenueTransaction` → `schema.prisma:L2839`
- `VenueWhatsappActivation` → `schema.prisma:L450`
- `WebhookEvent` → `schema.prisma:L2935`
- `WebhookSubscription` → `schema.prisma:L3928`
- `WhatsappContactWindow` → `schema.prisma:L468`
- `WhatsappInboundEvent` → `schema.prisma:L488`
- `Zone` → `schema.prisma:L88`
