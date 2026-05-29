# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **215 models / 188 enums / ~10,200 lines**. Nobody reads it
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
| 7 | **Serialized Inventory** | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification. | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem` |
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

- `ActivityLog` → `schema.prisma:L4775`
- `Aggregator` → `schema.prisma:L10062`
- `AngelPayUserAccount` → `schema.prisma:L3587`
- `AppUpdate` → `schema.prisma:L8356`
- `Area` → `schema.prisma:L2008`
- `BulkCommandOperation` → `schema.prisma:L6757`
- `CalendarSyncOutbox` → `schema.prisma:L9465`
- `CampaignDelivery` → `schema.prisma:L8506`
- `CashCloseout` → `schema.prisma:L7090`
- `CashDeposit` → `schema.prisma:L8183`
- `CashDrawerEvent` → `schema.prisma:L9908`
- `CashDrawerSession` → `schema.prisma:L9884`
- `ChatbotTokenBudget` → `schema.prisma:L6405`
- `ChatConversation` → `schema.prisma:L6260`
- `ChatFeedback` → `schema.prisma:L6346`
- `ChatLearningEvent` → `schema.prisma:L6303`
- `ChatMessage` → `schema.prisma:L6283`
- `ChatTrainingData` → `schema.prisma:L6217`
- `CheckoutSession` → `schema.prisma:L3864`
- `ClassSession` → `schema.prisma:L9086`
- `CommissionCalculation` → `schema.prisma:L7962`
- `CommissionClawback` → `schema.prisma:L8135`
- `CommissionConfig` → `schema.prisma:L7740`
- `CommissionMilestone` → `schema.prisma:L7878`
- `CommissionOverride` → `schema.prisma:L7810`
- `CommissionPayout` → `schema.prisma:L8086`
- `CommissionSummary` → `schema.prisma:L8025`
- `CommissionTier` → `schema.prisma:L7847`
- `Consumer` → `schema.prisma:L4890`
- `ConsumerAuthAccount` → `schema.prisma:L4915`
- `CouponCode` → `schema.prisma:L5194`
- `CouponRedemption` → `schema.prisma:L5225`
- `CreditAssessmentHistory` → `schema.prisma:L7199`
- `CreditItemBalance` → `schema.prisma:L9674`
- `CreditOffer` → `schema.prisma:L7218`
- `CreditPack` → `schema.prisma:L9590`
- `CreditPackItem` → `schema.prisma:L9619`
- `CreditPackPurchase` → `schema.prisma:L9636`
- `CreditTransaction` → `schema.prisma:L9696`
- `Customer` → `schema.prisma:L4801`
- `CustomerDiscount` → `schema.prisma:L5245`
- `CustomerGroup` → `schema.prisma:L4934`
- `DeviceToken` → `schema.prisma:L5440`
- `DigitalReceipt` → `schema.prisma:L2779`
- `Discount` → `schema.prisma:L5095`
- `EcommerceMerchant` → `schema.prisma:L3679`
- `EmailTemplate` → `schema.prisma:L8445`
- `Estimate` → `schema.prisma:L9969`
- `EstimateItem` → `schema.prisma:L9997`
- `ExternalBusyBlock` → `schema.prisma:L9358`
- `Feature` → `schema.prisma:L2908`
- `FeeSchedule` → `schema.prisma:L2983`
- `FeeTier` → `schema.prisma:L2994`
- `FloorElement` → `schema.prisma:L2084`
- `GeofenceRule` → `schema.prisma:L6842`
- `GoogleCalendarChannel` → `schema.prisma:L9335`
- `GoogleCalendarConnection` → `schema.prisma:L9287`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9388`
- `GoogleOAuthSession` → `schema.prisma:L9410`
- `HolidayCalendar` → `schema.prisma:L4699`
- `IdempotencyRequest` → `schema.prisma:L7624`
- `Inventory` → `schema.prisma:L1440`
- `InventoryMovement` → `schema.prisma:L1464`
- `InventoryTransfer` → `schema.prisma:L9941`
- `Invitation` → `schema.prisma:L1053`
- `Invoice` → `schema.prisma:L3006`
- `InvoiceItem` → `schema.prisma:L3032`
- `ItemCategory` → `schema.prisma:L7350`
- `KdsOrder` → `schema.prisma:L10102`
- `KdsOrderItem` → `schema.prisma:L10119`
- `LearnedPatterns` → `schema.prisma:L6327`
- `LiveDemoSession` → `schema.prisma:L594`
- `LowStockAlert` → `schema.prisma:L1879`
- `LoyaltyConfig` → `schema.prisma:L4964`
- `LoyaltyTransaction` → `schema.prisma:L4987`
- `MarketingCampaign` → `schema.prisma:L8463`
- `MeasurementUnit` → `schema.prisma:L10047`
- `Menu` → `schema.prisma:L1230`
- `MenuCategory` → `schema.prisma:L1176`
- `MenuCategoryAssignment` → `schema.prisma:L1265`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10178`
- `MerchantAccount` → `schema.prisma:L3464`
- `MerchantRevenueShare` → `schema.prisma:L4279`
- `MilestoneAchievement` → `schema.prisma:L7923`
- `Modifier` → `schema.prisma:L2526`
- `ModifierGroup` → `schema.prisma:L2490`
- `Module` → `schema.prisma:L7266`
- `MoneyAnomaly` → `schema.prisma:L4182`
- `MonthlyVenueProfit` → `schema.prisma:L4725`
- `Notification` → `schema.prisma:L5342`
- `NotificationPreference` → `schema.prisma:L5389`
- `NotificationTemplate` → `schema.prisma:L5416`
- `OAuthState` → `schema.prisma:L1104`
- `OnboardingProgress` → `schema.prisma:L1122`
- `Order` → `schema.prisma:L2271`
- `OrderAction` → `schema.prisma:L2591`
- `OrderCustomer` → `schema.prisma:L2395`
- `OrderDiscount` → `schema.prisma:L5277`
- `OrderItem` → `schema.prisma:L2411`
- `OrderItemModifier` → `schema.prisma:L2575`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8297`
- `OrganizationGoal` → `schema.prisma:L8255`
- `OrganizationModule` → `schema.prisma:L7322`
- `OrganizationPaymentConfig` → `schema.prisma:L3988`
- `OrganizationPayoutConfig` → `schema.prisma:L8323`
- `OrganizationPricingStructure` → `schema.prisma:L4020`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8278`
- `PartnerAPIKey` → `schema.prisma:L3818`
- `Payment` → `schema.prisma:L2624`
- `PaymentAllocation` → `schema.prisma:L2758`
- `PaymentLink` → `schema.prisma:L9742`
- `PaymentLinkAttribution` → `schema.prisma:L9850`
- `PaymentLinkItem` → `schema.prisma:L9805`
- `PaymentLinkItemModifier` → `schema.prisma:L9832`
- `PaymentProvider` → `schema.prisma:L3423`
- `PerformanceGoal` → `schema.prisma:L8232`
- `PermissionSet` → `schema.prisma:L1004`
- `PlatformSettings` → `schema.prisma:L3795`
- `PosCommand` → `schema.prisma:L5470`
- `PosConnectionStatus` → `schema.prisma:L670`
- `PricingPolicy` → `schema.prisma:L1790`
- `ProcessedStripeEvent` → `schema.prisma:L4168`
- `ProcessorReliabilityMetric` → `schema.prisma:L4653`
- `Product` → `schema.prisma:L1283`
- `ProductModifierGroup` → `schema.prisma:L2563`
- `ProductOption` → `schema.prisma:L10024`
- `ProductOptionValue` → `schema.prisma:L10035`
- `ProviderCostStructure` → `schema.prisma:L4204`
- `ProviderEventLog` → `schema.prisma:L4097`
- `PurchaseOrder` → `schema.prisma:L1705`
- `PurchaseOrderItem` → `schema.prisma:L1761`
- `RateCorrectionBatch` → `schema.prisma:L4429`
- `RateCorrectionEntry` → `schema.prisma:L4471`
- `RawMaterial` → `schema.prisma:L1494`
- `RawMaterialMovement` → `schema.prisma:L1843`
- `Recipe` → `schema.prisma:L1559`
- `RecipeLine` → `schema.prisma:L1583`
- `Referral` → `schema.prisma:L5049`
- `ReferralProgramConfig` → `schema.prisma:L5016`
- `Reservation` → `schema.prisma:L8842`
- `ReservationGoogleEventMapping` → `schema.prisma:L9522`
- `ReservationModifier` → `schema.prisma:L9001`
- `ReservationReminderSent` → `schema.prisma:L8984`
- `ReservationSettings` → `schema.prisma:L9162`
- `ReservationWaitlistEntry` → `schema.prisma:L9130`
- `Review` → `schema.prisma:L3050`
- `SaleVerification` → `schema.prisma:L2812`
- `ScheduledCommand` → `schema.prisma:L6802`
- `SerializedItem` → `schema.prisma:L7393`
- `SerializedItemCustodyEvent` → `schema.prisma:L7547`
- `SettlementConfiguration` → `schema.prisma:L4504`
- `SettlementConfirmation` → `schema.prisma:L4617`
- `SettlementIncident` → `schema.prisma:L4568`
- `SettlementSimulation` → `schema.prisma:L4539`
- `Shift` → `schema.prisma:L2122`
- `SimRegistrationRequest` → `schema.prisma:L7585`
- `SimRegistrationRequestItem` → `schema.prisma:L7607`
- `SlotHold` → `schema.prisma:L9041`
- `Staff` → `schema.prisma:L690`
- `StaffOnboardingState` → `schema.prisma:L10148`
- `StaffOrganization` → `schema.prisma:L918`
- `StaffPasskey` → `schema.prisma:L945`
- `StaffVenue` → `schema.prisma:L860`
- `StockAlertConfig` → `schema.prisma:L8214`
- `StockBatch` → `schema.prisma:L1962`
- `StockCount` → `schema.prisma:L1911`
- `StockCountItem` → `schema.prisma:L1932`
- `StripeWebhookEvent` → `schema.prisma:L4151`
- `Supplier` → `schema.prisma:L1618`
- `SupplierPricing` → `schema.prisma:L1671`
- `Table` → `schema.prisma:L2034`
- `Terminal` → `schema.prisma:L3101`
- `TerminalHealth` → `schema.prisma:L3243`
- `TerminalLog` → `schema.prisma:L3217`
- `TerminalOrder` → `schema.prisma:L3326`
- `TerminalOrderItem` → `schema.prisma:L3401`
- `TimeEntry` → `schema.prisma:L2187`
- `TimeEntryBreak` → `schema.prisma:L2256`
- `TokenPurchase` → `schema.prisma:L6476`
- `TokenUsageRecord` → `schema.prisma:L6448`
- `TpvCommandHistory` → `schema.prisma:L6708`
- `TpvCommandQueue` → `schema.prisma:L6648`
- `TpvFeedback` → `schema.prisma:L6361`
- `TpvMessage` → `schema.prisma:L8538`
- `TpvMessageDelivery` → `schema.prisma:L8590`
- `TpvMessageResponse` → `schema.prisma:L8613`
- `TrainingModule` → `schema.prisma:L8668`
- `TrainingProgress` → `schema.prisma:L8745`
- `TrainingQuizQuestion` → `schema.prisma:L8727`
- `TrainingStep` → `schema.prisma:L8707`
- `TransactionCost` → `schema.prisma:L4367`
- `UnitConversion` → `schema.prisma:L1821`
- `user_sessions` → `schema.prisma:L3853`
- `Venue` → `schema.prisma:L108`
- `VenueChatMessage` → `schema.prisma:L570`
- `VenueChatSession` → `schema.prisma:L525`
- `VenueCommission` → `schema.prisma:L10080`
- `VenueCreditAssessment` → `schema.prisma:L7138`
- `VenueCryptoConfig` → `schema.prisma:L8405`
- `VenueFeature` → `schema.prisma:L2926`
- `VenueModule` → `schema.prisma:L7294`
- `VenuePaymentConfig` → `schema.prisma:L3954`
- `VenuePaymentLinkSettings` → `schema.prisma:L9555`
- `VenuePricingStructure` → `schema.prisma:L4307`
- `VenueRoleConfig` → `schema.prisma:L1033`
- `VenueRolePermission` → `schema.prisma:L975`
- `VenueSettings` → `schema.prisma:L610`
- `VenueTransaction` → `schema.prisma:L2863`
- `VenueWhatsappActivation` → `schema.prisma:L461`
- `WebhookEvent` → `schema.prisma:L2959`
- `WebhookSubscription` → `schema.prisma:L4070`
- `WhatsappContactWindow` → `schema.prisma:L479`
- `WhatsappInboundEvent` → `schema.prisma:L499`
- `Zone` → `schema.prisma:L91`
