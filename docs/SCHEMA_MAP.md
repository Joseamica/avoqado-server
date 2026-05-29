# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **213 models / 186 enums / ~10,100 lines**. Nobody reads it
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
| 13 | **Discounts, Loyalty & Credit Packs** | Discounts/coupons, loyalty points, and prepaid credit-pack bundles. | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig` |
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

- `ActivityLog` → `schema.prisma:L4765`
- `Aggregator` → `schema.prisma:L9998`
- `AngelPayUserAccount` → `schema.prisma:L3577`
- `AppUpdate` → `schema.prisma:L8292`
- `Area` → `schema.prisma:L1998`
- `BulkCommandOperation` → `schema.prisma:L6747`
- `CalendarSyncOutbox` → `schema.prisma:L9401`
- `CampaignDelivery` → `schema.prisma:L8442`
- `CashCloseout` → `schema.prisma:L7080`
- `CashDeposit` → `schema.prisma:L8119`
- `CashDrawerEvent` → `schema.prisma:L9844`
- `CashDrawerSession` → `schema.prisma:L9820`
- `ChatbotTokenBudget` → `schema.prisma:L6395`
- `ChatConversation` → `schema.prisma:L6250`
- `ChatFeedback` → `schema.prisma:L6336`
- `ChatLearningEvent` → `schema.prisma:L6293`
- `ChatMessage` → `schema.prisma:L6273`
- `ChatTrainingData` → `schema.prisma:L6207`
- `CheckoutSession` → `schema.prisma:L3854`
- `ClassSession` → `schema.prisma:L9022`
- `CommissionCalculation` → `schema.prisma:L7898`
- `CommissionClawback` → `schema.prisma:L8071`
- `CommissionConfig` → `schema.prisma:L7676`
- `CommissionMilestone` → `schema.prisma:L7814`
- `CommissionOverride` → `schema.prisma:L7746`
- `CommissionPayout` → `schema.prisma:L8022`
- `CommissionSummary` → `schema.prisma:L7961`
- `CommissionTier` → `schema.prisma:L7783`
- `Consumer` → `schema.prisma:L4880`
- `ConsumerAuthAccount` → `schema.prisma:L4905`
- `CouponCode` → `schema.prisma:L5184`
- `CouponRedemption` → `schema.prisma:L5215`
- `CreditAssessmentHistory` → `schema.prisma:L7189`
- `CreditItemBalance` → `schema.prisma:L9610`
- `CreditOffer` → `schema.prisma:L7208`
- `CreditPack` → `schema.prisma:L9526`
- `CreditPackItem` → `schema.prisma:L9555`
- `CreditPackPurchase` → `schema.prisma:L9572`
- `CreditTransaction` → `schema.prisma:L9632`
- `Customer` → `schema.prisma:L4791`
- `CustomerDiscount` → `schema.prisma:L5235`
- `CustomerGroup` → `schema.prisma:L4924`
- `DeviceToken` → `schema.prisma:L5430`
- `DigitalReceipt` → `schema.prisma:L2769`
- `Discount` → `schema.prisma:L5085`
- `EcommerceMerchant` → `schema.prisma:L3669`
- `EmailTemplate` → `schema.prisma:L8381`
- `Estimate` → `schema.prisma:L9905`
- `EstimateItem` → `schema.prisma:L9933`
- `ExternalBusyBlock` → `schema.prisma:L9294`
- `Feature` → `schema.prisma:L2898`
- `FeeSchedule` → `schema.prisma:L2973`
- `FeeTier` → `schema.prisma:L2984`
- `FloorElement` → `schema.prisma:L2074`
- `GeofenceRule` → `schema.prisma:L6832`
- `GoogleCalendarChannel` → `schema.prisma:L9271`
- `GoogleCalendarConnection` → `schema.prisma:L9223`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9324`
- `GoogleOAuthSession` → `schema.prisma:L9346`
- `HolidayCalendar` → `schema.prisma:L4689`
- `IdempotencyRequest` → `schema.prisma:L7560`
- `Inventory` → `schema.prisma:L1430`
- `InventoryMovement` → `schema.prisma:L1454`
- `InventoryTransfer` → `schema.prisma:L9877`
- `Invitation` → `schema.prisma:L1043`
- `Invoice` → `schema.prisma:L2996`
- `InvoiceItem` → `schema.prisma:L3022`
- `ItemCategory` → `schema.prisma:L7340`
- `KdsOrder` → `schema.prisma:L10038`
- `KdsOrderItem` → `schema.prisma:L10055`
- `LearnedPatterns` → `schema.prisma:L6317`
- `LiveDemoSession` → `schema.prisma:L588`
- `LowStockAlert` → `schema.prisma:L1869`
- `LoyaltyConfig` → `schema.prisma:L4954`
- `LoyaltyTransaction` → `schema.prisma:L4977`
- `MarketingCampaign` → `schema.prisma:L8399`
- `MeasurementUnit` → `schema.prisma:L9983`
- `Menu` → `schema.prisma:L1220`
- `MenuCategory` → `schema.prisma:L1166`
- `MenuCategoryAssignment` → `schema.prisma:L1255`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10114`
- `MerchantAccount` → `schema.prisma:L3454`
- `MerchantRevenueShare` → `schema.prisma:L4269`
- `MilestoneAchievement` → `schema.prisma:L7859`
- `Modifier` → `schema.prisma:L2516`
- `ModifierGroup` → `schema.prisma:L2480`
- `Module` → `schema.prisma:L7256`
- `MoneyAnomaly` → `schema.prisma:L4172`
- `MonthlyVenueProfit` → `schema.prisma:L4715`
- `Notification` → `schema.prisma:L5332`
- `NotificationPreference` → `schema.prisma:L5379`
- `NotificationTemplate` → `schema.prisma:L5406`
- `OAuthState` → `schema.prisma:L1094`
- `OnboardingProgress` → `schema.prisma:L1112`
- `Order` → `schema.prisma:L2261`
- `OrderAction` → `schema.prisma:L2581`
- `OrderCustomer` → `schema.prisma:L2385`
- `OrderDiscount` → `schema.prisma:L5267`
- `OrderItem` → `schema.prisma:L2401`
- `OrderItemModifier` → `schema.prisma:L2565`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8233`
- `OrganizationGoal` → `schema.prisma:L8191`
- `OrganizationModule` → `schema.prisma:L7312`
- `OrganizationPaymentConfig` → `schema.prisma:L3978`
- `OrganizationPayoutConfig` → `schema.prisma:L8259`
- `OrganizationPricingStructure` → `schema.prisma:L4010`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8214`
- `PartnerAPIKey` → `schema.prisma:L3808`
- `Payment` → `schema.prisma:L2614`
- `PaymentAllocation` → `schema.prisma:L2748`
- `PaymentLink` → `schema.prisma:L9678`
- `PaymentLinkAttribution` → `schema.prisma:L9786`
- `PaymentLinkItem` → `schema.prisma:L9741`
- `PaymentLinkItemModifier` → `schema.prisma:L9768`
- `PaymentProvider` → `schema.prisma:L3413`
- `PerformanceGoal` → `schema.prisma:L8168`
- `PermissionSet` → `schema.prisma:L994`
- `PlatformSettings` → `schema.prisma:L3785`
- `PosCommand` → `schema.prisma:L5460`
- `PosConnectionStatus` → `schema.prisma:L664`
- `PricingPolicy` → `schema.prisma:L1780`
- `ProcessedStripeEvent` → `schema.prisma:L4158`
- `ProcessorReliabilityMetric` → `schema.prisma:L4643`
- `Product` → `schema.prisma:L1273`
- `ProductModifierGroup` → `schema.prisma:L2553`
- `ProductOption` → `schema.prisma:L9960`
- `ProductOptionValue` → `schema.prisma:L9971`
- `ProviderCostStructure` → `schema.prisma:L4194`
- `ProviderEventLog` → `schema.prisma:L4087`
- `PurchaseOrder` → `schema.prisma:L1695`
- `PurchaseOrderItem` → `schema.prisma:L1751`
- `RateCorrectionBatch` → `schema.prisma:L4419`
- `RateCorrectionEntry` → `schema.prisma:L4461`
- `RawMaterial` → `schema.prisma:L1484`
- `RawMaterialMovement` → `schema.prisma:L1833`
- `Recipe` → `schema.prisma:L1549`
- `RecipeLine` → `schema.prisma:L1573`
- `Referral` → `schema.prisma:L5039`
- `ReferralProgramConfig` → `schema.prisma:L5006`
- `Reservation` → `schema.prisma:L8778`
- `ReservationGoogleEventMapping` → `schema.prisma:L9458`
- `ReservationModifier` → `schema.prisma:L8937`
- `ReservationReminderSent` → `schema.prisma:L8920`
- `ReservationSettings` → `schema.prisma:L9098`
- `ReservationWaitlistEntry` → `schema.prisma:L9066`
- `Review` → `schema.prisma:L3040`
- `SaleVerification` → `schema.prisma:L2802`
- `ScheduledCommand` → `schema.prisma:L6792`
- `SerializedItem` → `schema.prisma:L7382`
- `SerializedItemCustodyEvent` → `schema.prisma:L7536`
- `SettlementConfiguration` → `schema.prisma:L4494`
- `SettlementConfirmation` → `schema.prisma:L4607`
- `SettlementIncident` → `schema.prisma:L4558`
- `SettlementSimulation` → `schema.prisma:L4529`
- `Shift` → `schema.prisma:L2112`
- `SlotHold` → `schema.prisma:L8977`
- `Staff` → `schema.prisma:L684`
- `StaffOnboardingState` → `schema.prisma:L10084`
- `StaffOrganization` → `schema.prisma:L908`
- `StaffPasskey` → `schema.prisma:L935`
- `StaffVenue` → `schema.prisma:L850`
- `StockAlertConfig` → `schema.prisma:L8150`
- `StockBatch` → `schema.prisma:L1952`
- `StockCount` → `schema.prisma:L1901`
- `StockCountItem` → `schema.prisma:L1922`
- `StripeWebhookEvent` → `schema.prisma:L4141`
- `Supplier` → `schema.prisma:L1608`
- `SupplierPricing` → `schema.prisma:L1661`
- `Table` → `schema.prisma:L2024`
- `Terminal` → `schema.prisma:L3091`
- `TerminalHealth` → `schema.prisma:L3233`
- `TerminalLog` → `schema.prisma:L3207`
- `TerminalOrder` → `schema.prisma:L3316`
- `TerminalOrderItem` → `schema.prisma:L3391`
- `TimeEntry` → `schema.prisma:L2177`
- `TimeEntryBreak` → `schema.prisma:L2246`
- `TokenPurchase` → `schema.prisma:L6466`
- `TokenUsageRecord` → `schema.prisma:L6438`
- `TpvCommandHistory` → `schema.prisma:L6698`
- `TpvCommandQueue` → `schema.prisma:L6638`
- `TpvFeedback` → `schema.prisma:L6351`
- `TpvMessage` → `schema.prisma:L8474`
- `TpvMessageDelivery` → `schema.prisma:L8526`
- `TpvMessageResponse` → `schema.prisma:L8549`
- `TrainingModule` → `schema.prisma:L8604`
- `TrainingProgress` → `schema.prisma:L8681`
- `TrainingQuizQuestion` → `schema.prisma:L8663`
- `TrainingStep` → `schema.prisma:L8643`
- `TransactionCost` → `schema.prisma:L4357`
- `UnitConversion` → `schema.prisma:L1811`
- `user_sessions` → `schema.prisma:L3843`
- `Venue` → `schema.prisma:L105`
- `VenueChatMessage` → `schema.prisma:L564`
- `VenueChatSession` → `schema.prisma:L519`
- `VenueCommission` → `schema.prisma:L10016`
- `VenueCreditAssessment` → `schema.prisma:L7128`
- `VenueCryptoConfig` → `schema.prisma:L8341`
- `VenueFeature` → `schema.prisma:L2916`
- `VenueModule` → `schema.prisma:L7284`
- `VenuePaymentConfig` → `schema.prisma:L3944`
- `VenuePaymentLinkSettings` → `schema.prisma:L9491`
- `VenuePricingStructure` → `schema.prisma:L4297`
- `VenueRoleConfig` → `schema.prisma:L1023`
- `VenueRolePermission` → `schema.prisma:L965`
- `VenueSettings` → `schema.prisma:L604`
- `VenueTransaction` → `schema.prisma:L2853`
- `VenueWhatsappActivation` → `schema.prisma:L455`
- `WebhookEvent` → `schema.prisma:L2949`
- `WebhookSubscription` → `schema.prisma:L4060`
- `WhatsappContactWindow` → `schema.prisma:L473`
- `WhatsappInboundEvent` → `schema.prisma:L493`
- `Zone` → `schema.prisma:L88`
