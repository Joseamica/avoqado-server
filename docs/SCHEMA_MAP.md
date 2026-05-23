# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **207 models / 179 enums / ~9,700 lines**. Nobody reads it
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

- `ActivityLog` → `schema.prisma:L4489`
- `Aggregator` → `schema.prisma:L9618`
- `AngelPayUserAccount` → `schema.prisma:L3408`
- `AppUpdate` → `schema.prisma:L7912`
- `Area` → `schema.prisma:L1969`
- `BulkCommandOperation` → `schema.prisma:L6367`
- `CalendarSyncOutbox` → `schema.prisma:L9021`
- `CampaignDelivery` → `schema.prisma:L8062`
- `CashCloseout` → `schema.prisma:L6700`
- `CashDeposit` → `schema.prisma:L7739`
- `CashDrawerEvent` → `schema.prisma:L9464`
- `CashDrawerSession` → `schema.prisma:L9440`
- `ChatbotTokenBudget` → `schema.prisma:L6015`
- `ChatConversation` → `schema.prisma:L5870`
- `ChatFeedback` → `schema.prisma:L5956`
- `ChatLearningEvent` → `schema.prisma:L5913`
- `ChatMessage` → `schema.prisma:L5893`
- `ChatTrainingData` → `schema.prisma:L5827`
- `CheckoutSession` → `schema.prisma:L3665`
- `ClassSession` → `schema.prisma:L8642`
- `CommissionCalculation` → `schema.prisma:L7518`
- `CommissionClawback` → `schema.prisma:L7691`
- `CommissionConfig` → `schema.prisma:L7296`
- `CommissionMilestone` → `schema.prisma:L7434`
- `CommissionOverride` → `schema.prisma:L7366`
- `CommissionPayout` → `schema.prisma:L7642`
- `CommissionSummary` → `schema.prisma:L7581`
- `CommissionTier` → `schema.prisma:L7403`
- `Consumer` → `schema.prisma:L4589`
- `ConsumerAuthAccount` → `schema.prisma:L4614`
- `CouponCode` → `schema.prisma:L4804`
- `CouponRedemption` → `schema.prisma:L4835`
- `CreditAssessmentHistory` → `schema.prisma:L6809`
- `CreditItemBalance` → `schema.prisma:L9230`
- `CreditOffer` → `schema.prisma:L6828`
- `CreditPack` → `schema.prisma:L9146`
- `CreditPackItem` → `schema.prisma:L9175`
- `CreditPackPurchase` → `schema.prisma:L9192`
- `CreditTransaction` → `schema.prisma:L9252`
- `Customer` → `schema.prisma:L4515`
- `CustomerDiscount` → `schema.prisma:L4855`
- `CustomerGroup` → `schema.prisma:L4633`
- `DeviceToken` → `schema.prisma:L5050`
- `DigitalReceipt` → `schema.prisma:L2734`
- `Discount` → `schema.prisma:L4715`
- `EcommerceMerchant` → `schema.prisma:L3480`
- `EmailTemplate` → `schema.prisma:L8001`
- `Estimate` → `schema.prisma:L9525`
- `EstimateItem` → `schema.prisma:L9553`
- `ExternalBusyBlock` → `schema.prisma:L8914`
- `Feature` → `schema.prisma:L2863`
- `FeeSchedule` → `schema.prisma:L2938`
- `FeeTier` → `schema.prisma:L2949`
- `FloorElement` → `schema.prisma:L2045`
- `GeofenceRule` → `schema.prisma:L6452`
- `GoogleCalendarChannel` → `schema.prisma:L8891`
- `GoogleCalendarConnection` → `schema.prisma:L8843`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L8944`
- `GoogleOAuthSession` → `schema.prisma:L8966`
- `HolidayCalendar` → `schema.prisma:L4413`
- `IdempotencyRequest` → `schema.prisma:L7180`
- `Inventory` → `schema.prisma:L1401`
- `InventoryMovement` → `schema.prisma:L1425`
- `InventoryTransfer` → `schema.prisma:L9497`
- `Invitation` → `schema.prisma:L1014`
- `Invoice` → `schema.prisma:L2961`
- `InvoiceItem` → `schema.prisma:L2987`
- `ItemCategory` → `schema.prisma:L6960`
- `KdsOrder` → `schema.prisma:L9658`
- `KdsOrderItem` → `schema.prisma:L9675`
- `LearnedPatterns` → `schema.prisma:L5937`
- `LiveDemoSession` → `schema.prisma:L569`
- `LowStockAlert` → `schema.prisma:L1840`
- `LoyaltyConfig` → `schema.prisma:L4663`
- `LoyaltyTransaction` → `schema.prisma:L4686`
- `MarketingCampaign` → `schema.prisma:L8019`
- `MeasurementUnit` → `schema.prisma:L9603`
- `Menu` → `schema.prisma:L1191`
- `MenuCategory` → `schema.prisma:L1137`
- `MenuCategoryAssignment` → `schema.prisma:L1226`
- `MercadoPagoWebhookEvent` → `schema.prisma:L9734`
- `MerchantAccount` → `schema.prisma:L3300`
- `MerchantRevenueShare` → `schema.prisma:L4080`
- `MilestoneAchievement` → `schema.prisma:L7479`
- `Modifier` → `schema.prisma:L2484`
- `ModifierGroup` → `schema.prisma:L2448`
- `Module` → `schema.prisma:L6876`
- `MoneyAnomaly` → `schema.prisma:L3983`
- `MonthlyVenueProfit` → `schema.prisma:L4439`
- `Notification` → `schema.prisma:L4952`
- `NotificationPreference` → `schema.prisma:L4999`
- `NotificationTemplate` → `schema.prisma:L5026`
- `OAuthState` → `schema.prisma:L1065`
- `OnboardingProgress` → `schema.prisma:L1083`
- `Order` → `schema.prisma:L2232`
- `OrderAction` → `schema.prisma:L2549`
- `OrderCustomer` → `schema.prisma:L2353`
- `OrderDiscount` → `schema.prisma:L4887`
- `OrderItem` → `schema.prisma:L2369`
- `OrderItemModifier` → `schema.prisma:L2533`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L7853`
- `OrganizationGoal` → `schema.prisma:L7811`
- `OrganizationModule` → `schema.prisma:L6932`
- `OrganizationPaymentConfig` → `schema.prisma:L3789`
- `OrganizationPayoutConfig` → `schema.prisma:L7879`
- `OrganizationPricingStructure` → `schema.prisma:L3821`
- `OrganizationSalesGoalConfig` → `schema.prisma:L7834`
- `PartnerAPIKey` → `schema.prisma:L3619`
- `Payment` → `schema.prisma:L2582`
- `PaymentAllocation` → `schema.prisma:L2713`
- `PaymentLink` → `schema.prisma:L9298`
- `PaymentLinkAttribution` → `schema.prisma:L9406`
- `PaymentLinkItem` → `schema.prisma:L9361`
- `PaymentLinkItemModifier` → `schema.prisma:L9388`
- `PaymentProvider` → `schema.prisma:L3259`
- `PerformanceGoal` → `schema.prisma:L7788`
- `PermissionSet` → `schema.prisma:L965`
- `PlatformSettings` → `schema.prisma:L3596`
- `PosCommand` → `schema.prisma:L5080`
- `PosConnectionStatus` → `schema.prisma:L645`
- `PricingPolicy` → `schema.prisma:L1751`
- `ProcessedStripeEvent` → `schema.prisma:L3969`
- `ProcessorReliabilityMetric` → `schema.prisma:L4367`
- `Product` → `schema.prisma:L1244`
- `ProductModifierGroup` → `schema.prisma:L2521`
- `ProductOption` → `schema.prisma:L9580`
- `ProductOptionValue` → `schema.prisma:L9591`
- `ProviderCostStructure` → `schema.prisma:L4005`
- `ProviderEventLog` → `schema.prisma:L3898`
- `PurchaseOrder` → `schema.prisma:L1666`
- `PurchaseOrderItem` → `schema.prisma:L1722`
- `RawMaterial` → `schema.prisma:L1455`
- `RawMaterialMovement` → `schema.prisma:L1804`
- `Recipe` → `schema.prisma:L1520`
- `RecipeLine` → `schema.prisma:L1544`
- `Reservation` → `schema.prisma:L8398`
- `ReservationGoogleEventMapping` → `schema.prisma:L9078`
- `ReservationModifier` → `schema.prisma:L8557`
- `ReservationReminderSent` → `schema.prisma:L8540`
- `ReservationSettings` → `schema.prisma:L8718`
- `ReservationWaitlistEntry` → `schema.prisma:L8686`
- `Review` → `schema.prisma:L3005`
- `SaleVerification` → `schema.prisma:L2767`
- `ScheduledCommand` → `schema.prisma:L6412`
- `SerializedItem` → `schema.prisma:L7002`
- `SerializedItemCustodyEvent` → `schema.prisma:L7156`
- `SettlementConfiguration` → `schema.prisma:L4218`
- `SettlementConfirmation` → `schema.prisma:L4331`
- `SettlementIncident` → `schema.prisma:L4282`
- `SettlementSimulation` → `schema.prisma:L4253`
- `Shift` → `schema.prisma:L2083`
- `SlotHold` → `schema.prisma:L8597`
- `Staff` → `schema.prisma:L665`
- `StaffOnboardingState` → `schema.prisma:L9704`
- `StaffOrganization` → `schema.prisma:L879`
- `StaffPasskey` → `schema.prisma:L906`
- `StaffVenue` → `schema.prisma:L824`
- `StockAlertConfig` → `schema.prisma:L7770`
- `StockBatch` → `schema.prisma:L1923`
- `StockCount` → `schema.prisma:L1872`
- `StockCountItem` → `schema.prisma:L1893`
- `StripeWebhookEvent` → `schema.prisma:L3952`
- `Supplier` → `schema.prisma:L1579`
- `SupplierPricing` → `schema.prisma:L1632`
- `Table` → `schema.prisma:L1995`
- `Terminal` → `schema.prisma:L3056`
- `TerminalHealth` → `schema.prisma:L3192`
- `TerminalLog` → `schema.prisma:L3166`
- `TimeEntry` → `schema.prisma:L2148`
- `TimeEntryBreak` → `schema.prisma:L2217`
- `TokenPurchase` → `schema.prisma:L6086`
- `TokenUsageRecord` → `schema.prisma:L6058`
- `TpvCommandHistory` → `schema.prisma:L6318`
- `TpvCommandQueue` → `schema.prisma:L6258`
- `TpvFeedback` → `schema.prisma:L5971`
- `TpvMessage` → `schema.prisma:L8094`
- `TpvMessageDelivery` → `schema.prisma:L8146`
- `TpvMessageResponse` → `schema.prisma:L8169`
- `TrainingModule` → `schema.prisma:L8224`
- `TrainingProgress` → `schema.prisma:L8301`
- `TrainingQuizQuestion` → `schema.prisma:L8283`
- `TrainingStep` → `schema.prisma:L8263`
- `TransactionCost` → `schema.prisma:L4168`
- `UnitConversion` → `schema.prisma:L1782`
- `user_sessions` → `schema.prisma:L3654`
- `Venue` → `schema.prisma:L105`
- `VenueChatMessage` → `schema.prisma:L545`
- `VenueChatSession` → `schema.prisma:L500`
- `VenueCommission` → `schema.prisma:L9636`
- `VenueCreditAssessment` → `schema.prisma:L6748`
- `VenueCryptoConfig` → `schema.prisma:L7961`
- `VenueFeature` → `schema.prisma:L2881`
- `VenueModule` → `schema.prisma:L6904`
- `VenuePaymentConfig` → `schema.prisma:L3755`
- `VenuePaymentLinkSettings` → `schema.prisma:L9111`
- `VenuePricingStructure` → `schema.prisma:L4108`
- `VenueRoleConfig` → `schema.prisma:L994`
- `VenueRolePermission` → `schema.prisma:L936`
- `VenueSettings` → `schema.prisma:L585`
- `VenueTransaction` → `schema.prisma:L2818`
- `VenueWhatsappActivation` → `schema.prisma:L436`
- `WebhookEvent` → `schema.prisma:L2914`
- `WebhookSubscription` → `schema.prisma:L3871`
- `WhatsappContactWindow` → `schema.prisma:L454`
- `WhatsappInboundEvent` → `schema.prisma:L474`
- `Zone` → `schema.prisma:L88`
