# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **211 models / 184 enums / ~10,000 lines**. Nobody reads it
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
| 16 | **Terminals / TPV Fleet** | PAX terminal fleet: health, logs, app updates, remote commands, messaging. | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig` |
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

- `ActivityLog` → `schema.prisma:L4756`
- `Aggregator` → `schema.prisma:L9885`
- `AngelPayUserAccount` → `schema.prisma:L3567`
- `AppUpdate` → `schema.prisma:L8179`
- `Area` → `schema.prisma:L1991`
- `BulkCommandOperation` → `schema.prisma:L6634`
- `CalendarSyncOutbox` → `schema.prisma:L9288`
- `CampaignDelivery` → `schema.prisma:L8329`
- `CashCloseout` → `schema.prisma:L6967`
- `CashDeposit` → `schema.prisma:L8006`
- `CashDrawerEvent` → `schema.prisma:L9731`
- `CashDrawerSession` → `schema.prisma:L9707`
- `ChatbotTokenBudget` → `schema.prisma:L6282`
- `ChatConversation` → `schema.prisma:L6137`
- `ChatFeedback` → `schema.prisma:L6223`
- `ChatLearningEvent` → `schema.prisma:L6180`
- `ChatMessage` → `schema.prisma:L6160`
- `ChatTrainingData` → `schema.prisma:L6094`
- `CheckoutSession` → `schema.prisma:L3845`
- `ClassSession` → `schema.prisma:L8909`
- `CommissionCalculation` → `schema.prisma:L7785`
- `CommissionClawback` → `schema.prisma:L7958`
- `CommissionConfig` → `schema.prisma:L7563`
- `CommissionMilestone` → `schema.prisma:L7701`
- `CommissionOverride` → `schema.prisma:L7633`
- `CommissionPayout` → `schema.prisma:L7909`
- `CommissionSummary` → `schema.prisma:L7848`
- `CommissionTier` → `schema.prisma:L7670`
- `Consumer` → `schema.prisma:L4856`
- `ConsumerAuthAccount` → `schema.prisma:L4881`
- `CouponCode` → `schema.prisma:L5071`
- `CouponRedemption` → `schema.prisma:L5102`
- `CreditAssessmentHistory` → `schema.prisma:L7076`
- `CreditItemBalance` → `schema.prisma:L9497`
- `CreditOffer` → `schema.prisma:L7095`
- `CreditPack` → `schema.prisma:L9413`
- `CreditPackItem` → `schema.prisma:L9442`
- `CreditPackPurchase` → `schema.prisma:L9459`
- `CreditTransaction` → `schema.prisma:L9519`
- `Customer` → `schema.prisma:L4782`
- `CustomerDiscount` → `schema.prisma:L5122`
- `CustomerGroup` → `schema.prisma:L4900`
- `DeviceToken` → `schema.prisma:L5317`
- `DigitalReceipt` → `schema.prisma:L2759`
- `Discount` → `schema.prisma:L4982`
- `EcommerceMerchant` → `schema.prisma:L3660`
- `EmailTemplate` → `schema.prisma:L8268`
- `Estimate` → `schema.prisma:L9792`
- `EstimateItem` → `schema.prisma:L9820`
- `ExternalBusyBlock` → `schema.prisma:L9181`
- `Feature` → `schema.prisma:L2888`
- `FeeSchedule` → `schema.prisma:L2963`
- `FeeTier` → `schema.prisma:L2974`
- `FloorElement` → `schema.prisma:L2067`
- `GeofenceRule` → `schema.prisma:L6719`
- `GoogleCalendarChannel` → `schema.prisma:L9158`
- `GoogleCalendarConnection` → `schema.prisma:L9110`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9211`
- `GoogleOAuthSession` → `schema.prisma:L9233`
- `HolidayCalendar` → `schema.prisma:L4680`
- `IdempotencyRequest` → `schema.prisma:L7447`
- `Inventory` → `schema.prisma:L1423`
- `InventoryMovement` → `schema.prisma:L1447`
- `InventoryTransfer` → `schema.prisma:L9764`
- `Invitation` → `schema.prisma:L1036`
- `Invoice` → `schema.prisma:L2986`
- `InvoiceItem` → `schema.prisma:L3012`
- `ItemCategory` → `schema.prisma:L7227`
- `KdsOrder` → `schema.prisma:L9925`
- `KdsOrderItem` → `schema.prisma:L9942`
- `LearnedPatterns` → `schema.prisma:L6204`
- `LiveDemoSession` → `schema.prisma:L584`
- `LowStockAlert` → `schema.prisma:L1862`
- `LoyaltyConfig` → `schema.prisma:L4930`
- `LoyaltyTransaction` → `schema.prisma:L4953`
- `MarketingCampaign` → `schema.prisma:L8286`
- `MeasurementUnit` → `schema.prisma:L9870`
- `Menu` → `schema.prisma:L1213`
- `MenuCategory` → `schema.prisma:L1159`
- `MenuCategoryAssignment` → `schema.prisma:L1248`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10001`
- `MerchantAccount` → `schema.prisma:L3444`
- `MerchantRevenueShare` → `schema.prisma:L4260`
- `MilestoneAchievement` → `schema.prisma:L7746`
- `Modifier` → `schema.prisma:L2506`
- `ModifierGroup` → `schema.prisma:L2470`
- `Module` → `schema.prisma:L7143`
- `MoneyAnomaly` → `schema.prisma:L4163`
- `MonthlyVenueProfit` → `schema.prisma:L4706`
- `Notification` → `schema.prisma:L5219`
- `NotificationPreference` → `schema.prisma:L5266`
- `NotificationTemplate` → `schema.prisma:L5293`
- `OAuthState` → `schema.prisma:L1087`
- `OnboardingProgress` → `schema.prisma:L1105`
- `Order` → `schema.prisma:L2254`
- `OrderAction` → `schema.prisma:L2571`
- `OrderCustomer` → `schema.prisma:L2375`
- `OrderDiscount` → `schema.prisma:L5154`
- `OrderItem` → `schema.prisma:L2391`
- `OrderItemModifier` → `schema.prisma:L2555`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8120`
- `OrganizationGoal` → `schema.prisma:L8078`
- `OrganizationModule` → `schema.prisma:L7199`
- `OrganizationPaymentConfig` → `schema.prisma:L3969`
- `OrganizationPayoutConfig` → `schema.prisma:L8146`
- `OrganizationPricingStructure` → `schema.prisma:L4001`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8101`
- `PartnerAPIKey` → `schema.prisma:L3799`
- `Payment` → `schema.prisma:L2604`
- `PaymentAllocation` → `schema.prisma:L2738`
- `PaymentLink` → `schema.prisma:L9565`
- `PaymentLinkAttribution` → `schema.prisma:L9673`
- `PaymentLinkItem` → `schema.prisma:L9628`
- `PaymentLinkItemModifier` → `schema.prisma:L9655`
- `PaymentProvider` → `schema.prisma:L3403`
- `PerformanceGoal` → `schema.prisma:L8055`
- `PermissionSet` → `schema.prisma:L987`
- `PlatformSettings` → `schema.prisma:L3776`
- `PosCommand` → `schema.prisma:L5347`
- `PosConnectionStatus` → `schema.prisma:L660`
- `PricingPolicy` → `schema.prisma:L1773`
- `ProcessedStripeEvent` → `schema.prisma:L4149`
- `ProcessorReliabilityMetric` → `schema.prisma:L4634`
- `Product` → `schema.prisma:L1266`
- `ProductModifierGroup` → `schema.prisma:L2543`
- `ProductOption` → `schema.prisma:L9847`
- `ProductOptionValue` → `schema.prisma:L9858`
- `ProviderCostStructure` → `schema.prisma:L4185`
- `ProviderEventLog` → `schema.prisma:L4078`
- `PurchaseOrder` → `schema.prisma:L1688`
- `PurchaseOrderItem` → `schema.prisma:L1744`
- `RateCorrectionBatch` → `schema.prisma:L4410`
- `RateCorrectionEntry` → `schema.prisma:L4452`
- `RawMaterial` → `schema.prisma:L1477`
- `RawMaterialMovement` → `schema.prisma:L1826`
- `Recipe` → `schema.prisma:L1542`
- `RecipeLine` → `schema.prisma:L1566`
- `Reservation` → `schema.prisma:L8665`
- `ReservationGoogleEventMapping` → `schema.prisma:L9345`
- `ReservationModifier` → `schema.prisma:L8824`
- `ReservationReminderSent` → `schema.prisma:L8807`
- `ReservationSettings` → `schema.prisma:L8985`
- `ReservationWaitlistEntry` → `schema.prisma:L8953`
- `Review` → `schema.prisma:L3030`
- `SaleVerification` → `schema.prisma:L2792`
- `ScheduledCommand` → `schema.prisma:L6679`
- `SerializedItem` → `schema.prisma:L7269`
- `SerializedItemCustodyEvent` → `schema.prisma:L7423`
- `SettlementConfiguration` → `schema.prisma:L4485`
- `SettlementConfirmation` → `schema.prisma:L4598`
- `SettlementIncident` → `schema.prisma:L4549`
- `SettlementSimulation` → `schema.prisma:L4520`
- `Shift` → `schema.prisma:L2105`
- `SlotHold` → `schema.prisma:L8864`
- `Staff` → `schema.prisma:L680`
- `StaffOnboardingState` → `schema.prisma:L9971`
- `StaffOrganization` → `schema.prisma:L901`
- `StaffPasskey` → `schema.prisma:L928`
- `StaffVenue` → `schema.prisma:L846`
- `StockAlertConfig` → `schema.prisma:L8037`
- `StockBatch` → `schema.prisma:L1945`
- `StockCount` → `schema.prisma:L1894`
- `StockCountItem` → `schema.prisma:L1915`
- `StripeWebhookEvent` → `schema.prisma:L4132`
- `Supplier` → `schema.prisma:L1601`
- `SupplierPricing` → `schema.prisma:L1654`
- `Table` → `schema.prisma:L2017`
- `Terminal` → `schema.prisma:L3081`
- `TerminalHealth` → `schema.prisma:L3223`
- `TerminalLog` → `schema.prisma:L3197`
- `TerminalOrder` → `schema.prisma:L3306`
- `TerminalOrderItem` → `schema.prisma:L3381`
- `TimeEntry` → `schema.prisma:L2170`
- `TimeEntryBreak` → `schema.prisma:L2239`
- `TokenPurchase` → `schema.prisma:L6353`
- `TokenUsageRecord` → `schema.prisma:L6325`
- `TpvCommandHistory` → `schema.prisma:L6585`
- `TpvCommandQueue` → `schema.prisma:L6525`
- `TpvFeedback` → `schema.prisma:L6238`
- `TpvMessage` → `schema.prisma:L8361`
- `TpvMessageDelivery` → `schema.prisma:L8413`
- `TpvMessageResponse` → `schema.prisma:L8436`
- `TrainingModule` → `schema.prisma:L8491`
- `TrainingProgress` → `schema.prisma:L8568`
- `TrainingQuizQuestion` → `schema.prisma:L8550`
- `TrainingStep` → `schema.prisma:L8530`
- `TransactionCost` → `schema.prisma:L4348`
- `UnitConversion` → `schema.prisma:L1804`
- `user_sessions` → `schema.prisma:L3834`
- `Venue` → `schema.prisma:L105`
- `VenueChatMessage` → `schema.prisma:L560`
- `VenueChatSession` → `schema.prisma:L515`
- `VenueCommission` → `schema.prisma:L9903`
- `VenueCreditAssessment` → `schema.prisma:L7015`
- `VenueCryptoConfig` → `schema.prisma:L8228`
- `VenueFeature` → `schema.prisma:L2906`
- `VenueModule` → `schema.prisma:L7171`
- `VenuePaymentConfig` → `schema.prisma:L3935`
- `VenuePaymentLinkSettings` → `schema.prisma:L9378`
- `VenuePricingStructure` → `schema.prisma:L4288`
- `VenueRoleConfig` → `schema.prisma:L1016`
- `VenueRolePermission` → `schema.prisma:L958`
- `VenueSettings` → `schema.prisma:L600`
- `VenueTransaction` → `schema.prisma:L2843`
- `VenueWhatsappActivation` → `schema.prisma:L451`
- `WebhookEvent` → `schema.prisma:L2939`
- `WebhookSubscription` → `schema.prisma:L4051`
- `WhatsappContactWindow` → `schema.prisma:L469`
- `WhatsappInboundEvent` → `schema.prisma:L489`
- `Zone` → `schema.prisma:L88`
