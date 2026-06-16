# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **227 models / 206 enums / ~10,700 lines**. Nobody reads it top to bottom. This file is the **index**: 20 domains,
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
| 9   | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                 |
| 10  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig` |
| 11  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                             |
| 12  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountMapping`, `Cfdi`, `CustomerTaxProfile`, `FiscalEmisor`, `LedgerAccount`, `MerchantFiscalConfig`                                                                                                                                                                                                                                                                                                                                                                                                                       |
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

- `AccountMapping` → `schema.prisma:L10756`
- `ActivityLog` → `schema.prisma:L4856`
- `Aggregator` → `schema.prisma:L10200`
- `AngelPayUserAccount` → `schema.prisma:L3665`
- `AppUpdate` → `schema.prisma:L8493`
- `Area` → `schema.prisma:L2075`
- `BankStatement` → `schema.prisma:L10631`
- `BankStatementLine` → `schema.prisma:L10652`
- `BulkCommandOperation` → `schema.prisma:L6865`
- `CalendarSyncOutbox` → `schema.prisma:L9603`
- `CampaignDelivery` → `schema.prisma:L8644`
- `CashCloseout` → `schema.prisma:L7198`
- `CashDeposit` → `schema.prisma:L8313`
- `CashDrawerEvent` → `schema.prisma:L10046`
- `CashDrawerSession` → `schema.prisma:L10022`
- `Cfdi` → `schema.prisma:L10534`
- `ChatbotTokenBudget` → `schema.prisma:L6513`
- `ChatConversation` → `schema.prisma:L6368`
- `ChatFeedback` → `schema.prisma:L6454`
- `ChatLearningEvent` → `schema.prisma:L6411`
- `ChatMessage` → `schema.prisma:L6391`
- `ChatTrainingData` → `schema.prisma:L6325`
- `CheckoutSession` → `schema.prisma:L3945`
- `ClassSession` → `schema.prisma:L9224`
- `CommissionCalculation` → `schema.prisma:L8092`
- `CommissionClawback` → `schema.prisma:L8265`
- `CommissionConfig` → `schema.prisma:L7865`
- `CommissionMilestone` → `schema.prisma:L8008`
- `CommissionOverride` → `schema.prisma:L7935`
- `CommissionPayout` → `schema.prisma:L8216`
- `CommissionSummary` → `schema.prisma:L8155`
- `CommissionTier` → `schema.prisma:L7972`
- `Consumer` → `schema.prisma:L4974`
- `ConsumerAuthAccount` → `schema.prisma:L4999`
- `CouponCode` → `schema.prisma:L5293`
- `CouponRedemption` → `schema.prisma:L5324`
- `CreditAssessmentHistory` → `schema.prisma:L7307`
- `CreditItemBalance` → `schema.prisma:L9812`
- `CreditOffer` → `schema.prisma:L7326`
- `CreditPack` → `schema.prisma:L9728`
- `CreditPackItem` → `schema.prisma:L9757`
- `CreditPackPurchase` → `schema.prisma:L9774`
- `CreditTransaction` → `schema.prisma:L9834`
- `Customer` → `schema.prisma:L4882`
- `CustomerDiscount` → `schema.prisma:L5344`
- `CustomerGroup` → `schema.prisma:L5033`
- `CustomerTaxProfile` → `schema.prisma:L10603`
- `DeviceToken` → `schema.prisma:L5539`
- `DigitalReceipt` → `schema.prisma:L2849`
- `Discount` → `schema.prisma:L5194`
- `EcommerceMerchant` → `schema.prisma:L3757`
- `EmailTemplate` → `schema.prisma:L8583`
- `Estimate` → `schema.prisma:L10107`
- `EstimateItem` → `schema.prisma:L10135`
- `ExternalBusyBlock` → `schema.prisma:L9496`
- `Feature` → `schema.prisma:L2978`
- `FeeSchedule` → `schema.prisma:L3056`
- `FeeTier` → `schema.prisma:L3067`
- `FiscalEmisor` → `schema.prisma:L10476`
- `FloorElement` → `schema.prisma:L2151`
- `GeofenceRule` → `schema.prisma:L6950`
- `GoogleCalendarChannel` → `schema.prisma:L9473`
- `GoogleCalendarConnection` → `schema.prisma:L9425`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9526`
- `GoogleOAuthSession` → `schema.prisma:L9548`
- `HolidayCalendar` → `schema.prisma:L4780`
- `IdempotencyRequest` → `schema.prisma:L7740`
- `Inventory` → `schema.prisma:L1506`
- `InventoryMovement` → `schema.prisma:L1530`
- `InventoryTransfer` → `schema.prisma:L10079`
- `Invitation` → `schema.prisma:L1110`
- `Invoice` → `schema.prisma:L3079`
- `InvoiceItem` → `schema.prisma:L3105`
- `ItemCategory` → `schema.prisma:L7458`
- `KdsOrder` → `schema.prisma:L10240`
- `KdsOrderItem` → `schema.prisma:L10257`
- `LearnedPatterns` → `schema.prisma:L6435`
- `LedgerAccount` → `schema.prisma:L10707`
- `LiveDemoSession` → `schema.prisma:L645`
- `LowStockAlert` → `schema.prisma:L1946`
- `LoyaltyConfig` → `schema.prisma:L5063`
- `LoyaltyTransaction` → `schema.prisma:L5086`
- `MarketingCampaign` → `schema.prisma:L8601`
- `McpAuthCode` → `schema.prisma:L10383`
- `McpOAuthClient` → `schema.prisma:L10367`
- `McpRefreshToken` → `schema.prisma:L10401`
- `MeasurementUnit` → `schema.prisma:L10185`
- `Menu` → `schema.prisma:L1291`
- `MenuCategory` → `schema.prisma:L1233`
- `MenuCategoryAssignment` → `schema.prisma:L1326`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10316`
- `MerchantAccount` → `schema.prisma:L3539`
- `MerchantFiscalConfig` → `schema.prisma:L10512`
- `MerchantRevenueShare` → `schema.prisma:L4360`
- `MilestoneAchievement` → `schema.prisma:L8053`
- `Modifier` → `schema.prisma:L2596`
- `ModifierGroup` → `schema.prisma:L2560`
- `Module` → `schema.prisma:L7374`
- `MoneyAnomaly` → `schema.prisma:L4263`
- `MonthlyVenueProfit` → `schema.prisma:L4806`
- `Notification` → `schema.prisma:L5441`
- `NotificationPreference` → `schema.prisma:L5488`
- `NotificationTemplate` → `schema.prisma:L5515`
- `OAuthState` → `schema.prisma:L1161`
- `OnboardingProgress` → `schema.prisma:L1179`
- `Order` → `schema.prisma:L2338`
- `OrderAction` → `schema.prisma:L2661`
- `OrderCustomer` → `schema.prisma:L2465`
- `OrderDiscount` → `schema.prisma:L5376`
- `OrderItem` → `schema.prisma:L2481`
- `OrderItemModifier` → `schema.prisma:L2645`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8427`
- `OrganizationGoal` → `schema.prisma:L8385`
- `OrganizationModule` → `schema.prisma:L7430`
- `OrganizationPaymentConfig` → `schema.prisma:L4069`
- `OrganizationPayoutConfig` → `schema.prisma:L8453`
- `OrganizationPricingStructure` → `schema.prisma:L4101`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8408`
- `OtpChallenge` → `schema.prisma:L5018`
- `PartnerAPIKey` → `schema.prisma:L3899`
- `Payment` → `schema.prisma:L2694`
- `PaymentAllocation` → `schema.prisma:L2828`
- `PaymentLink` → `schema.prisma:L9880`
- `PaymentLinkAttribution` → `schema.prisma:L9988`
- `PaymentLinkItem` → `schema.prisma:L9943`
- `PaymentLinkItemModifier` → `schema.prisma:L9970`
- `PaymentProvider` → `schema.prisma:L3498`
- `PerformanceGoal` → `schema.prisma:L8362`
- `PermissionSet` → `schema.prisma:L1061`
- `PlatformSettings` → `schema.prisma:L3876`
- `PosCommand` → `schema.prisma:L5569`
- `PosConnectionStatus` → `schema.prisma:L721`
- `PricingPolicy` → `schema.prisma:L1857`
- `ProcessedStripeEvent` → `schema.prisma:L4249`
- `ProcessorReliabilityMetric` → `schema.prisma:L4734`
- `Product` → `schema.prisma:L1344`
- `ProductModifierGroup` → `schema.prisma:L2633`
- `ProductOption` → `schema.prisma:L10162`
- `ProductOptionValue` → `schema.prisma:L10173`
- `ProviderCostStructure` → `schema.prisma:L4285`
- `ProviderEventLog` → `schema.prisma:L4178`
- `PurchaseOrder` → `schema.prisma:L1771`
- `PurchaseOrderItem` → `schema.prisma:L1828`
- `RateCorrectionBatch` → `schema.prisma:L4510`
- `RateCorrectionEntry` → `schema.prisma:L4552`
- `RawMaterial` → `schema.prisma:L1560`
- `RawMaterialMovement` → `schema.prisma:L1910`
- `Recipe` → `schema.prisma:L1625`
- `RecipeLine` → `schema.prisma:L1649`
- `Referral` → `schema.prisma:L5148`
- `ReferralProgramConfig` → `schema.prisma:L5115`
- `Reservation` → `schema.prisma:L8980`
- `ReservationGoogleEventMapping` → `schema.prisma:L9660`
- `ReservationModifier` → `schema.prisma:L9139`
- `ReservationReminderSent` → `schema.prisma:L9122`
- `ReservationSettings` → `schema.prisma:L9300`
- `ReservationWaitlistEntry` → `schema.prisma:L9268`
- `Review` → `schema.prisma:L3123`
- `SaleVerification` → `schema.prisma:L2882`
- `ScheduledCommand` → `schema.prisma:L6910`
- `SerializedItem` → `schema.prisma:L7501`
- `SerializedItemCustodyEvent` → `schema.prisma:L7663`
- `SettlementConfiguration` → `schema.prisma:L4585`
- `SettlementConfirmation` → `schema.prisma:L4698`
- `SettlementIncident` → `schema.prisma:L4649`
- `SettlementSimulation` → `schema.prisma:L4620`
- `Shift` → `schema.prisma:L2189`
- `SimRegistrationRequest` → `schema.prisma:L7701`
- `SimRegistrationRequestItem` → `schema.prisma:L7723`
- `SlotHold` → `schema.prisma:L9179`
- `Staff` → `schema.prisma:L741`
- `StaffOnboardingState` → `schema.prisma:L10286`
- `StaffOrganization` → `schema.prisma:L975`
- `StaffPasskey` → `schema.prisma:L1002`
- `StaffVenue` → `schema.prisma:L911`
- `StockAlertConfig` → `schema.prisma:L8344`
- `StockBatch` → `schema.prisma:L2029`
- `StockCount` → `schema.prisma:L1978`
- `StockCountItem` → `schema.prisma:L1999`
- `StripeWebhookEvent` → `schema.prisma:L4232`
- `Supplier` → `schema.prisma:L1684`
- `SupplierPricing` → `schema.prisma:L1737`
- `Table` → `schema.prisma:L2101`
- `Terminal` → `schema.prisma:L3174`
- `TerminalHealth` → `schema.prisma:L3318`
- `TerminalLog` → `schema.prisma:L3292`
- `TerminalOrder` → `schema.prisma:L3401`
- `TerminalOrderItem` → `schema.prisma:L3476`
- `TimeEntry` → `schema.prisma:L2254`
- `TimeEntryBreak` → `schema.prisma:L2323`
- `TokenPurchase` → `schema.prisma:L6584`
- `TokenUsageRecord` → `schema.prisma:L6556`
- `TpvCommandHistory` → `schema.prisma:L6816`
- `TpvCommandQueue` → `schema.prisma:L6756`
- `TpvFeedback` → `schema.prisma:L6469`
- `TpvMessage` → `schema.prisma:L8676`
- `TpvMessageDelivery` → `schema.prisma:L8728`
- `TpvMessageResponse` → `schema.prisma:L8751`
- `TrainingModule` → `schema.prisma:L8806`
- `TrainingProgress` → `schema.prisma:L8883`
- `TrainingQuizQuestion` → `schema.prisma:L8865`
- `TrainingStep` → `schema.prisma:L8845`
- `TransactionCost` → `schema.prisma:L4448`
- `UnitConversion` → `schema.prisma:L1888`
- `user_sessions` → `schema.prisma:L3934`
- `Venue` → `schema.prisma:L112`
- `VenueChatMessage` → `schema.prisma:L621`
- `VenueChatSession` → `schema.prisma:L576`
- `VenueCommission` → `schema.prisma:L10218`
- `VenueCreditAssessment` → `schema.prisma:L7246`
- `VenueCryptoConfig` → `schema.prisma:L8543`
- `VenueFeature` → `schema.prisma:L2996`
- `VenueModule` → `schema.prisma:L7402`
- `VenuePaymentConfig` → `schema.prisma:L4035`
- `VenuePaymentLinkSettings` → `schema.prisma:L9693`
- `VenuePricingStructure` → `schema.prisma:L4388`
- `VenueRoleConfig` → `schema.prisma:L1090`
- `VenueRolePermission` → `schema.prisma:L1032`
- `VenueSettings` → `schema.prisma:L661`
- `VenueTransaction` → `schema.prisma:L2933`
- `VenueWhatsappActivation` → `schema.prisma:L512`
- `WebhookEvent` → `schema.prisma:L3032`
- `WebhookSubscription` → `schema.prisma:L4151`
- `WhatsappContactWindow` → `schema.prisma:L530`
- `WhatsappInboundEvent` → `schema.prisma:L550`
- `Zone` → `schema.prisma:L95`
