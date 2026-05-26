# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **207 models / 179 enums / ~9,800 lines**. Nobody reads it
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
| 10 | **Payment Providers & Settlement** | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement. | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig` |
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

- `ActivityLog` → `schema.prisma:L4521`
- `Aggregator` → `schema.prisma:L9650`
- `AngelPayUserAccount` → `schema.prisma:L3419`
- `AppUpdate` → `schema.prisma:L7944`
- `Area` → `schema.prisma:L1980`
- `BulkCommandOperation` → `schema.prisma:L6399`
- `CalendarSyncOutbox` → `schema.prisma:L9053`
- `CampaignDelivery` → `schema.prisma:L8094`
- `CashCloseout` → `schema.prisma:L6732`
- `CashDeposit` → `schema.prisma:L7771`
- `CashDrawerEvent` → `schema.prisma:L9496`
- `CashDrawerSession` → `schema.prisma:L9472`
- `ChatbotTokenBudget` → `schema.prisma:L6047`
- `ChatConversation` → `schema.prisma:L5902`
- `ChatFeedback` → `schema.prisma:L5988`
- `ChatLearningEvent` → `schema.prisma:L5945`
- `ChatMessage` → `schema.prisma:L5925`
- `ChatTrainingData` → `schema.prisma:L5859`
- `CheckoutSession` → `schema.prisma:L3697`
- `ClassSession` → `schema.prisma:L8674`
- `CommissionCalculation` → `schema.prisma:L7550`
- `CommissionClawback` → `schema.prisma:L7723`
- `CommissionConfig` → `schema.prisma:L7328`
- `CommissionMilestone` → `schema.prisma:L7466`
- `CommissionOverride` → `schema.prisma:L7398`
- `CommissionPayout` → `schema.prisma:L7674`
- `CommissionSummary` → `schema.prisma:L7613`
- `CommissionTier` → `schema.prisma:L7435`
- `Consumer` → `schema.prisma:L4621`
- `ConsumerAuthAccount` → `schema.prisma:L4646`
- `CouponCode` → `schema.prisma:L4836`
- `CouponRedemption` → `schema.prisma:L4867`
- `CreditAssessmentHistory` → `schema.prisma:L6841`
- `CreditItemBalance` → `schema.prisma:L9262`
- `CreditOffer` → `schema.prisma:L6860`
- `CreditPack` → `schema.prisma:L9178`
- `CreditPackItem` → `schema.prisma:L9207`
- `CreditPackPurchase` → `schema.prisma:L9224`
- `CreditTransaction` → `schema.prisma:L9284`
- `Customer` → `schema.prisma:L4547`
- `CustomerDiscount` → `schema.prisma:L4887`
- `CustomerGroup` → `schema.prisma:L4665`
- `DeviceToken` → `schema.prisma:L5082`
- `DigitalReceipt` → `schema.prisma:L2745`
- `Discount` → `schema.prisma:L4747`
- `EcommerceMerchant` → `schema.prisma:L3512`
- `EmailTemplate` → `schema.prisma:L8033`
- `Estimate` → `schema.prisma:L9557`
- `EstimateItem` → `schema.prisma:L9585`
- `ExternalBusyBlock` → `schema.prisma:L8946`
- `Feature` → `schema.prisma:L2874`
- `FeeSchedule` → `schema.prisma:L2949`
- `FeeTier` → `schema.prisma:L2960`
- `FloorElement` → `schema.prisma:L2056`
- `GeofenceRule` → `schema.prisma:L6484`
- `GoogleCalendarChannel` → `schema.prisma:L8923`
- `GoogleCalendarConnection` → `schema.prisma:L8875`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L8976`
- `GoogleOAuthSession` → `schema.prisma:L8998`
- `HolidayCalendar` → `schema.prisma:L4445`
- `IdempotencyRequest` → `schema.prisma:L7212`
- `Inventory` → `schema.prisma:L1412`
- `InventoryMovement` → `schema.prisma:L1436`
- `InventoryTransfer` → `schema.prisma:L9529`
- `Invitation` → `schema.prisma:L1025`
- `Invoice` → `schema.prisma:L2972`
- `InvoiceItem` → `schema.prisma:L2998`
- `ItemCategory` → `schema.prisma:L6992`
- `KdsOrder` → `schema.prisma:L9690`
- `KdsOrderItem` → `schema.prisma:L9707`
- `LearnedPatterns` → `schema.prisma:L5969`
- `LiveDemoSession` → `schema.prisma:L580`
- `LowStockAlert` → `schema.prisma:L1851`
- `LoyaltyConfig` → `schema.prisma:L4695`
- `LoyaltyTransaction` → `schema.prisma:L4718`
- `MarketingCampaign` → `schema.prisma:L8051`
- `MeasurementUnit` → `schema.prisma:L9635`
- `Menu` → `schema.prisma:L1202`
- `MenuCategory` → `schema.prisma:L1148`
- `MenuCategoryAssignment` → `schema.prisma:L1237`
- `MercadoPagoWebhookEvent` → `schema.prisma:L9766`
- `MerchantAccount` → `schema.prisma:L3311`
- `MerchantRevenueShare` → `schema.prisma:L4112`
- `MilestoneAchievement` → `schema.prisma:L7511`
- `Modifier` → `schema.prisma:L2495`
- `ModifierGroup` → `schema.prisma:L2459`
- `Module` → `schema.prisma:L6908`
- `MoneyAnomaly` → `schema.prisma:L4015`
- `MonthlyVenueProfit` → `schema.prisma:L4471`
- `Notification` → `schema.prisma:L4984`
- `NotificationPreference` → `schema.prisma:L5031`
- `NotificationTemplate` → `schema.prisma:L5058`
- `OAuthState` → `schema.prisma:L1076`
- `OnboardingProgress` → `schema.prisma:L1094`
- `Order` → `schema.prisma:L2243`
- `OrderAction` → `schema.prisma:L2560`
- `OrderCustomer` → `schema.prisma:L2364`
- `OrderDiscount` → `schema.prisma:L4919`
- `OrderItem` → `schema.prisma:L2380`
- `OrderItemModifier` → `schema.prisma:L2544`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L7885`
- `OrganizationGoal` → `schema.prisma:L7843`
- `OrganizationModule` → `schema.prisma:L6964`
- `OrganizationPaymentConfig` → `schema.prisma:L3821`
- `OrganizationPayoutConfig` → `schema.prisma:L7911`
- `OrganizationPricingStructure` → `schema.prisma:L3853`
- `OrganizationSalesGoalConfig` → `schema.prisma:L7866`
- `PartnerAPIKey` → `schema.prisma:L3651`
- `Payment` → `schema.prisma:L2593`
- `PaymentAllocation` → `schema.prisma:L2724`
- `PaymentLink` → `schema.prisma:L9330`
- `PaymentLinkAttribution` → `schema.prisma:L9438`
- `PaymentLinkItem` → `schema.prisma:L9393`
- `PaymentLinkItemModifier` → `schema.prisma:L9420`
- `PaymentProvider` → `schema.prisma:L3270`
- `PerformanceGoal` → `schema.prisma:L7820`
- `PermissionSet` → `schema.prisma:L976`
- `PlatformSettings` → `schema.prisma:L3628`
- `PosCommand` → `schema.prisma:L5112`
- `PosConnectionStatus` → `schema.prisma:L656`
- `PricingPolicy` → `schema.prisma:L1762`
- `ProcessedStripeEvent` → `schema.prisma:L4001`
- `ProcessorReliabilityMetric` → `schema.prisma:L4399`
- `Product` → `schema.prisma:L1255`
- `ProductModifierGroup` → `schema.prisma:L2532`
- `ProductOption` → `schema.prisma:L9612`
- `ProductOptionValue` → `schema.prisma:L9623`
- `ProviderCostStructure` → `schema.prisma:L4037`
- `ProviderEventLog` → `schema.prisma:L3930`
- `PurchaseOrder` → `schema.prisma:L1677`
- `PurchaseOrderItem` → `schema.prisma:L1733`
- `RawMaterial` → `schema.prisma:L1466`
- `RawMaterialMovement` → `schema.prisma:L1815`
- `Recipe` → `schema.prisma:L1531`
- `RecipeLine` → `schema.prisma:L1555`
- `Reservation` → `schema.prisma:L8430`
- `ReservationGoogleEventMapping` → `schema.prisma:L9110`
- `ReservationModifier` → `schema.prisma:L8589`
- `ReservationReminderSent` → `schema.prisma:L8572`
- `ReservationSettings` → `schema.prisma:L8750`
- `ReservationWaitlistEntry` → `schema.prisma:L8718`
- `Review` → `schema.prisma:L3016`
- `SaleVerification` → `schema.prisma:L2778`
- `ScheduledCommand` → `schema.prisma:L6444`
- `SerializedItem` → `schema.prisma:L7034`
- `SerializedItemCustodyEvent` → `schema.prisma:L7188`
- `SettlementConfiguration` → `schema.prisma:L4250`
- `SettlementConfirmation` → `schema.prisma:L4363`
- `SettlementIncident` → `schema.prisma:L4314`
- `SettlementSimulation` → `schema.prisma:L4285`
- `Shift` → `schema.prisma:L2094`
- `SlotHold` → `schema.prisma:L8629`
- `Staff` → `schema.prisma:L676`
- `StaffOnboardingState` → `schema.prisma:L9736`
- `StaffOrganization` → `schema.prisma:L890`
- `StaffPasskey` → `schema.prisma:L917`
- `StaffVenue` → `schema.prisma:L835`
- `StockAlertConfig` → `schema.prisma:L7802`
- `StockBatch` → `schema.prisma:L1934`
- `StockCount` → `schema.prisma:L1883`
- `StockCountItem` → `schema.prisma:L1904`
- `StripeWebhookEvent` → `schema.prisma:L3984`
- `Supplier` → `schema.prisma:L1590`
- `SupplierPricing` → `schema.prisma:L1643`
- `Table` → `schema.prisma:L2006`
- `Terminal` → `schema.prisma:L3067`
- `TerminalHealth` → `schema.prisma:L3203`
- `TerminalLog` → `schema.prisma:L3177`
- `TimeEntry` → `schema.prisma:L2159`
- `TimeEntryBreak` → `schema.prisma:L2228`
- `TokenPurchase` → `schema.prisma:L6118`
- `TokenUsageRecord` → `schema.prisma:L6090`
- `TpvCommandHistory` → `schema.prisma:L6350`
- `TpvCommandQueue` → `schema.prisma:L6290`
- `TpvFeedback` → `schema.prisma:L6003`
- `TpvMessage` → `schema.prisma:L8126`
- `TpvMessageDelivery` → `schema.prisma:L8178`
- `TpvMessageResponse` → `schema.prisma:L8201`
- `TrainingModule` → `schema.prisma:L8256`
- `TrainingProgress` → `schema.prisma:L8333`
- `TrainingQuizQuestion` → `schema.prisma:L8315`
- `TrainingStep` → `schema.prisma:L8295`
- `TransactionCost` → `schema.prisma:L4200`
- `UnitConversion` → `schema.prisma:L1793`
- `user_sessions` → `schema.prisma:L3686`
- `Venue` → `schema.prisma:L105`
- `VenueChatMessage` → `schema.prisma:L556`
- `VenueChatSession` → `schema.prisma:L511`
- `VenueCommission` → `schema.prisma:L9668`
- `VenueCreditAssessment` → `schema.prisma:L6780`
- `VenueCryptoConfig` → `schema.prisma:L7993`
- `VenueFeature` → `schema.prisma:L2892`
- `VenueModule` → `schema.prisma:L6936`
- `VenuePaymentConfig` → `schema.prisma:L3787`
- `VenuePaymentLinkSettings` → `schema.prisma:L9143`
- `VenuePricingStructure` → `schema.prisma:L4140`
- `VenueRoleConfig` → `schema.prisma:L1005`
- `VenueRolePermission` → `schema.prisma:L947`
- `VenueSettings` → `schema.prisma:L596`
- `VenueTransaction` → `schema.prisma:L2829`
- `VenueWhatsappActivation` → `schema.prisma:L447`
- `WebhookEvent` → `schema.prisma:L2925`
- `WebhookSubscription` → `schema.prisma:L3903`
- `WhatsappContactWindow` → `schema.prisma:L465`
- `WhatsappInboundEvent` → `schema.prisma:L485`
- `Zone` → `schema.prisma:L88`
