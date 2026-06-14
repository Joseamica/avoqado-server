# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **223 models / 199 enums / ~10,600 lines**. Nobody reads it top to bottom. This file is the **index**: 20 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 20 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                     |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `OAuthState`, `PermissionSet`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                          |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                 |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                  |
| 6   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `Inventory`, `InventoryMovement`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                                                                                                                                   |
| 7   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderItem`, `OrderItemModifier`, `Shift`                                                                                                                                                                                                                                                                                                        |
| 9   | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                       |
| 10  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig` |
| 11  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                             |
| 12  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `Cfdi`, `CustomerTaxProfile`, `FiscalEmisor`, `MerchantFiscalConfig`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 13  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                             |
| 14  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig`                                                                                                                                                                                                                                                                                  |
| 15  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `VenueCommission`                                                                                                                                                                                                                                    |
| 16  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`                                                                                                                                                                        |
| 17  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`                                                                                                                                                                                         |
| 18  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                |
| 19  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 20  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 21  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                     |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `ActivityLog` → `schema.prisma:L4849`
- `Aggregator` → `schema.prisma:L10192`
- `AngelPayUserAccount` → `schema.prisma:L3658`
- `AppUpdate` → `schema.prisma:L8485`
- `Area` → `schema.prisma:L2068`
- `BulkCommandOperation` → `schema.prisma:L6857`
- `CalendarSyncOutbox` → `schema.prisma:L9595`
- `CampaignDelivery` → `schema.prisma:L8636`
- `CashCloseout` → `schema.prisma:L7190`
- `CashDeposit` → `schema.prisma:L8305`
- `CashDrawerEvent` → `schema.prisma:L10038`
- `CashDrawerSession` → `schema.prisma:L10014`
- `Cfdi` → `schema.prisma:L10526`
- `ChatbotTokenBudget` → `schema.prisma:L6505`
- `ChatConversation` → `schema.prisma:L6360`
- `ChatFeedback` → `schema.prisma:L6446`
- `ChatLearningEvent` → `schema.prisma:L6403`
- `ChatMessage` → `schema.prisma:L6383`
- `ChatTrainingData` → `schema.prisma:L6317`
- `CheckoutSession` → `schema.prisma:L3938`
- `ClassSession` → `schema.prisma:L9216`
- `CommissionCalculation` → `schema.prisma:L8084`
- `CommissionClawback` → `schema.prisma:L8257`
- `CommissionConfig` → `schema.prisma:L7857`
- `CommissionMilestone` → `schema.prisma:L8000`
- `CommissionOverride` → `schema.prisma:L7927`
- `CommissionPayout` → `schema.prisma:L8208`
- `CommissionSummary` → `schema.prisma:L8147`
- `CommissionTier` → `schema.prisma:L7964`
- `Consumer` → `schema.prisma:L4967`
- `ConsumerAuthAccount` → `schema.prisma:L4992`
- `CouponCode` → `schema.prisma:L5286`
- `CouponRedemption` → `schema.prisma:L5317`
- `CreditAssessmentHistory` → `schema.prisma:L7299`
- `CreditItemBalance` → `schema.prisma:L9804`
- `CreditOffer` → `schema.prisma:L7318`
- `CreditPack` → `schema.prisma:L9720`
- `CreditPackItem` → `schema.prisma:L9749`
- `CreditPackPurchase` → `schema.prisma:L9766`
- `CreditTransaction` → `schema.prisma:L9826`
- `Customer` → `schema.prisma:L4875`
- `CustomerDiscount` → `schema.prisma:L5337`
- `CustomerGroup` → `schema.prisma:L5026`
- `CustomerTaxProfile` → `schema.prisma:L10595`
- `DeviceToken` → `schema.prisma:L5532`
- `DigitalReceipt` → `schema.prisma:L2842`
- `Discount` → `schema.prisma:L5187`
- `EcommerceMerchant` → `schema.prisma:L3750`
- `EmailTemplate` → `schema.prisma:L8575`
- `Estimate` → `schema.prisma:L10099`
- `EstimateItem` → `schema.prisma:L10127`
- `ExternalBusyBlock` → `schema.prisma:L9488`
- `Feature` → `schema.prisma:L2971`
- `FeeSchedule` → `schema.prisma:L3049`
- `FeeTier` → `schema.prisma:L3060`
- `FiscalEmisor` → `schema.prisma:L10468`
- `FloorElement` → `schema.prisma:L2144`
- `GeofenceRule` → `schema.prisma:L6942`
- `GoogleCalendarChannel` → `schema.prisma:L9465`
- `GoogleCalendarConnection` → `schema.prisma:L9417`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9518`
- `GoogleOAuthSession` → `schema.prisma:L9540`
- `HolidayCalendar` → `schema.prisma:L4773`
- `IdempotencyRequest` → `schema.prisma:L7732`
- `Inventory` → `schema.prisma:L1499`
- `InventoryMovement` → `schema.prisma:L1523`
- `InventoryTransfer` → `schema.prisma:L10071`
- `Invitation` → `schema.prisma:L1103`
- `Invoice` → `schema.prisma:L3072`
- `InvoiceItem` → `schema.prisma:L3098`
- `ItemCategory` → `schema.prisma:L7450`
- `KdsOrder` → `schema.prisma:L10232`
- `KdsOrderItem` → `schema.prisma:L10249`
- `LearnedPatterns` → `schema.prisma:L6427`
- `LiveDemoSession` → `schema.prisma:L638`
- `LowStockAlert` → `schema.prisma:L1939`
- `LoyaltyConfig` → `schema.prisma:L5056`
- `LoyaltyTransaction` → `schema.prisma:L5079`
- `MarketingCampaign` → `schema.prisma:L8593`
- `McpAuthCode` → `schema.prisma:L10375`
- `McpOAuthClient` → `schema.prisma:L10359`
- `McpRefreshToken` → `schema.prisma:L10393`
- `MeasurementUnit` → `schema.prisma:L10177`
- `Menu` → `schema.prisma:L1284`
- `MenuCategory` → `schema.prisma:L1226`
- `MenuCategoryAssignment` → `schema.prisma:L1319`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10308`
- `MerchantAccount` → `schema.prisma:L3532`
- `MerchantFiscalConfig` → `schema.prisma:L10504`
- `MerchantRevenueShare` → `schema.prisma:L4353`
- `MilestoneAchievement` → `schema.prisma:L8045`
- `Modifier` → `schema.prisma:L2589`
- `ModifierGroup` → `schema.prisma:L2553`
- `Module` → `schema.prisma:L7366`
- `MoneyAnomaly` → `schema.prisma:L4256`
- `MonthlyVenueProfit` → `schema.prisma:L4799`
- `Notification` → `schema.prisma:L5434`
- `NotificationPreference` → `schema.prisma:L5481`
- `NotificationTemplate` → `schema.prisma:L5508`
- `OAuthState` → `schema.prisma:L1154`
- `OnboardingProgress` → `schema.prisma:L1172`
- `Order` → `schema.prisma:L2331`
- `OrderAction` → `schema.prisma:L2654`
- `OrderCustomer` → `schema.prisma:L2458`
- `OrderDiscount` → `schema.prisma:L5369`
- `OrderItem` → `schema.prisma:L2474`
- `OrderItemModifier` → `schema.prisma:L2638`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8419`
- `OrganizationGoal` → `schema.prisma:L8377`
- `OrganizationModule` → `schema.prisma:L7422`
- `OrganizationPaymentConfig` → `schema.prisma:L4062`
- `OrganizationPayoutConfig` → `schema.prisma:L8445`
- `OrganizationPricingStructure` → `schema.prisma:L4094`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8400`
- `OtpChallenge` → `schema.prisma:L5011`
- `PartnerAPIKey` → `schema.prisma:L3892`
- `Payment` → `schema.prisma:L2687`
- `PaymentAllocation` → `schema.prisma:L2821`
- `PaymentLink` → `schema.prisma:L9872`
- `PaymentLinkAttribution` → `schema.prisma:L9980`
- `PaymentLinkItem` → `schema.prisma:L9935`
- `PaymentLinkItemModifier` → `schema.prisma:L9962`
- `PaymentProvider` → `schema.prisma:L3491`
- `PerformanceGoal` → `schema.prisma:L8354`
- `PermissionSet` → `schema.prisma:L1054`
- `PlatformSettings` → `schema.prisma:L3869`
- `PosCommand` → `schema.prisma:L5562`
- `PosConnectionStatus` → `schema.prisma:L714`
- `PricingPolicy` → `schema.prisma:L1850`
- `ProcessedStripeEvent` → `schema.prisma:L4242`
- `ProcessorReliabilityMetric` → `schema.prisma:L4727`
- `Product` → `schema.prisma:L1337`
- `ProductModifierGroup` → `schema.prisma:L2626`
- `ProductOption` → `schema.prisma:L10154`
- `ProductOptionValue` → `schema.prisma:L10165`
- `ProviderCostStructure` → `schema.prisma:L4278`
- `ProviderEventLog` → `schema.prisma:L4171`
- `PurchaseOrder` → `schema.prisma:L1764`
- `PurchaseOrderItem` → `schema.prisma:L1821`
- `RateCorrectionBatch` → `schema.prisma:L4503`
- `RateCorrectionEntry` → `schema.prisma:L4545`
- `RawMaterial` → `schema.prisma:L1553`
- `RawMaterialMovement` → `schema.prisma:L1903`
- `Recipe` → `schema.prisma:L1618`
- `RecipeLine` → `schema.prisma:L1642`
- `Referral` → `schema.prisma:L5141`
- `ReferralProgramConfig` → `schema.prisma:L5108`
- `Reservation` → `schema.prisma:L8972`
- `ReservationGoogleEventMapping` → `schema.prisma:L9652`
- `ReservationModifier` → `schema.prisma:L9131`
- `ReservationReminderSent` → `schema.prisma:L9114`
- `ReservationSettings` → `schema.prisma:L9292`
- `ReservationWaitlistEntry` → `schema.prisma:L9260`
- `Review` → `schema.prisma:L3116`
- `SaleVerification` → `schema.prisma:L2875`
- `ScheduledCommand` → `schema.prisma:L6902`
- `SerializedItem` → `schema.prisma:L7493`
- `SerializedItemCustodyEvent` → `schema.prisma:L7655`
- `SettlementConfiguration` → `schema.prisma:L4578`
- `SettlementConfirmation` → `schema.prisma:L4691`
- `SettlementIncident` → `schema.prisma:L4642`
- `SettlementSimulation` → `schema.prisma:L4613`
- `Shift` → `schema.prisma:L2182`
- `SimRegistrationRequest` → `schema.prisma:L7693`
- `SimRegistrationRequestItem` → `schema.prisma:L7715`
- `SlotHold` → `schema.prisma:L9171`
- `Staff` → `schema.prisma:L734`
- `StaffOnboardingState` → `schema.prisma:L10278`
- `StaffOrganization` → `schema.prisma:L968`
- `StaffPasskey` → `schema.prisma:L995`
- `StaffVenue` → `schema.prisma:L904`
- `StockAlertConfig` → `schema.prisma:L8336`
- `StockBatch` → `schema.prisma:L2022`
- `StockCount` → `schema.prisma:L1971`
- `StockCountItem` → `schema.prisma:L1992`
- `StripeWebhookEvent` → `schema.prisma:L4225`
- `Supplier` → `schema.prisma:L1677`
- `SupplierPricing` → `schema.prisma:L1730`
- `Table` → `schema.prisma:L2094`
- `Terminal` → `schema.prisma:L3167`
- `TerminalHealth` → `schema.prisma:L3311`
- `TerminalLog` → `schema.prisma:L3285`
- `TerminalOrder` → `schema.prisma:L3394`
- `TerminalOrderItem` → `schema.prisma:L3469`
- `TimeEntry` → `schema.prisma:L2247`
- `TimeEntryBreak` → `schema.prisma:L2316`
- `TokenPurchase` → `schema.prisma:L6576`
- `TokenUsageRecord` → `schema.prisma:L6548`
- `TpvCommandHistory` → `schema.prisma:L6808`
- `TpvCommandQueue` → `schema.prisma:L6748`
- `TpvFeedback` → `schema.prisma:L6461`
- `TpvMessage` → `schema.prisma:L8668`
- `TpvMessageDelivery` → `schema.prisma:L8720`
- `TpvMessageResponse` → `schema.prisma:L8743`
- `TrainingModule` → `schema.prisma:L8798`
- `TrainingProgress` → `schema.prisma:L8875`
- `TrainingQuizQuestion` → `schema.prisma:L8857`
- `TrainingStep` → `schema.prisma:L8837`
- `TransactionCost` → `schema.prisma:L4441`
- `UnitConversion` → `schema.prisma:L1881`
- `user_sessions` → `schema.prisma:L3927`
- `Venue` → `schema.prisma:L108`
- `VenueChatMessage` → `schema.prisma:L614`
- `VenueChatSession` → `schema.prisma:L569`
- `VenueCommission` → `schema.prisma:L10210`
- `VenueCreditAssessment` → `schema.prisma:L7238`
- `VenueCryptoConfig` → `schema.prisma:L8535`
- `VenueFeature` → `schema.prisma:L2989`
- `VenueModule` → `schema.prisma:L7394`
- `VenuePaymentConfig` → `schema.prisma:L4028`
- `VenuePaymentLinkSettings` → `schema.prisma:L9685`
- `VenuePricingStructure` → `schema.prisma:L4381`
- `VenueRoleConfig` → `schema.prisma:L1083`
- `VenueRolePermission` → `schema.prisma:L1025`
- `VenueSettings` → `schema.prisma:L654`
- `VenueTransaction` → `schema.prisma:L2926`
- `VenueWhatsappActivation` → `schema.prisma:L505`
- `WebhookEvent` → `schema.prisma:L3025`
- `WebhookSubscription` → `schema.prisma:L4144`
- `WhatsappContactWindow` → `schema.prisma:L523`
- `WhatsappInboundEvent` → `schema.prisma:L543`
- `Zone` → `schema.prisma:L91`
