# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **261 models / 246 enums / ~12,200 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 21 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                     |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `OAuthState`, `PermissionSet`, `PromoterLocationPing`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                  |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                  |
| 6   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `Inventory`, `InventoryMovement`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                                                                                                                                                                                                   |
| 7   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderItem`, `OrderItemModifier`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `Shift`                                                                                                                                                                                                                                                                    |
| 9   | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                          |
| 10  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig` |
| 11  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 12  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                 |
| 13  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 14  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`                                                                                                                                                                                                                                                                               |
| 15  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                              |
| 16  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`                                                                                                                                                                                                                                        |
| 17  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`                                                                                                                                                                                                                               |
| 18  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                |
| 19  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 20  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 21  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L11616`
- `AccountMapping` → `schema.prisma:L11512`
- `ActivityLog` → `schema.prisma:L5136`
- `Aggregator` → `schema.prisma:L10660`
- `AngelPayUserAccount` → `schema.prisma:L3882`
- `AppUpdate` → `schema.prisma:L8946`
- `Area` → `schema.prisma:L2136`
- `BankStatement` → `schema.prisma:L11386`
- `BankStatementLine` → `schema.prisma:L11407`
- `BillingTaxProfile` → `schema.prisma:L12196`
- `BulkCommandOperation` → `schema.prisma:L7299`
- `CalendarSyncOutbox` → `schema.prisma:L10063`
- `CampaignDelivery` → `schema.prisma:L9104`
- `CashCloseout` → `schema.prisma:L7632`
- `CashDeposit` → `schema.prisma:L8748`
- `CashDrawerEvent` → `schema.prisma:L10506`
- `CashDrawerSession` → `schema.prisma:L10482`
- `CashOutCommissionRate` → `schema.prisma:L12025`
- `CashOutScheduleDay` → `schema.prisma:L12048`
- `CashOutWithdrawal` → `schema.prisma:L12110`
- `Cfdi` → `schema.prisma:L11289`
- `ChatbotTokenBudget` → `schema.prisma:L6947`
- `ChatConversation` → `schema.prisma:L6802`
- `ChatFeedback` → `schema.prisma:L6888`
- `ChatLearningEvent` → `schema.prisma:L6845`
- `ChatMessage` → `schema.prisma:L6825`
- `ChatTrainingData` → `schema.prisma:L6759`
- `CheckoutSession` → `schema.prisma:L4162`
- `ClassSession` → `schema.prisma:L9684`
- `CommissionCalculation` → `schema.prisma:L8527`
- `CommissionClawback` → `schema.prisma:L8700`
- `CommissionConfig` → `schema.prisma:L8300`
- `CommissionMilestone` → `schema.prisma:L8443`
- `CommissionOverride` → `schema.prisma:L8370`
- `CommissionPayout` → `schema.prisma:L8651`
- `CommissionSummary` → `schema.prisma:L8590`
- `CommissionTier` → `schema.prisma:L8407`
- `Consumer` → `schema.prisma:L5257`
- `ConsumerAuthAccount` → `schema.prisma:L5282`
- `CouponCode` → `schema.prisma:L5688`
- `CouponRedemption` → `schema.prisma:L5719`
- `CreditAssessmentHistory` → `schema.prisma:L7741`
- `CreditItemBalance` → `schema.prisma:L10272`
- `CreditOffer` → `schema.prisma:L7760`
- `CreditPack` → `schema.prisma:L10188`
- `CreditPackItem` → `schema.prisma:L10217`
- `CreditPackPurchase` → `schema.prisma:L10234`
- `CreditTransaction` → `schema.prisma:L10294`
- `Customer` → `schema.prisma:L5162`
- `CustomerDiscount` → `schema.prisma:L5739`
- `CustomerGroup` → `schema.prisma:L5316`
- `CustomerTaxProfile` → `schema.prisma:L11358`
- `DeliveryChannelLink` → `schema.prisma:L4448`
- `DeliveryOrderEvent` → `schema.prisma:L4483`
- `DeviceToken` → `schema.prisma:L5941`
- `DigitalReceipt` → `schema.prisma:L2976`
- `Discount` → `schema.prisma:L5588`
- `EcommerceMerchant` → `schema.prisma:L3974`
- `EmailTemplate` → `schema.prisma:L9043`
- `Employee` → `schema.prisma:L11873`
- `Estimate` → `schema.prisma:L10567`
- `EstimateItem` → `schema.prisma:L10595`
- `Expense` → `schema.prisma:L11660`
- `ExternalBusyBlock` → `schema.prisma:L9956`
- `Feature` → `schema.prisma:L3105`
- `FeeSchedule` → `schema.prisma:L3183`
- `FeeTier` → `schema.prisma:L3194`
- `FinancialAccount` → `schema.prisma:L10757`
- `FinancialConnection` → `schema.prisma:L10726`
- `FinancialProvider` → `schema.prisma:L10712`
- `FiscalEmisor` → `schema.prisma:L11212`
- `FiscalLossCarryforward` → `schema.prisma:L11783`
- `FixedAsset` → `schema.prisma:L11801`
- `FixedAssetDepreciation` → `schema.prisma:L11830`
- `FloorElement` → `schema.prisma:L2212`
- `GeofenceRule` → `schema.prisma:L7384`
- `GoogleCalendarChannel` → `schema.prisma:L9933`
- `GoogleCalendarConnection` → `schema.prisma:L9885`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9986`
- `GoogleOAuthSession` → `schema.prisma:L10008`
- `HolidayCalendar` → `schema.prisma:L5060`
- `IdempotencyRequest` → `schema.prisma:L8175`
- `Inventory` → `schema.prisma:L1554`
- `InventoryMovement` → `schema.prisma:L1578`
- `InventoryTransfer` → `schema.prisma:L10539`
- `Invitation` → `schema.prisma:L1140`
- `Invoice` → `schema.prisma:L3206`
- `InvoiceItem` → `schema.prisma:L3232`
- `ItemCategory` → `schema.prisma:L7892`
- `JournalEntry` → `schema.prisma:L11570`
- `JournalLine` → `schema.prisma:L11598`
- `KdsOrder` → `schema.prisma:L10805`
- `KdsOrderItem` → `schema.prisma:L10822`
- `LearnedPatterns` → `schema.prisma:L6869`
- `LedgerAccount` → `schema.prisma:L11462`
- `LiveDemoSession` → `schema.prisma:L663`
- `LowStockAlert` → `schema.prisma:L1995`
- `LoyaltyConfig` → `schema.prisma:L5346`
- `LoyaltyTransaction` → `schema.prisma:L5369`
- `MarketingCampaign` → `schema.prisma:L9061`
- `McpAuthCode` → `schema.prisma:L11119`
- `McpOAuthClient` → `schema.prisma:L11103`
- `McpRefreshToken` → `schema.prisma:L11137`
- `MeasurementUnit` → `schema.prisma:L10645`
- `Menu` → `schema.prisma:L1326`
- `MenuCategory` → `schema.prisma:L1263`
- `MenuCategoryAssignment` → `schema.prisma:L1361`
- `MercadoPagoWebhookEvent` → `schema.prisma:L11033`
- `MerchantAccount` → `schema.prisma:L3712`
- `MerchantFiscalConfig` → `schema.prisma:L11260`
- `MerchantRevenueShare` → `schema.prisma:L4640`
- `MerchantRoutingRule` → `schema.prisma:L3834`
- `MilestoneAchievement` → `schema.prisma:L8488`
- `Modifier` → `schema.prisma:L2718`
- `ModifierGroup` → `schema.prisma:L2682`
- `Module` → `schema.prisma:L7808`
- `MoneyAnomaly` → `schema.prisma:L4543`
- `MonthlyVenueProfit` → `schema.prisma:L5086`
- `Notification` → `schema.prisma:L5843`
- `NotificationPreference` → `schema.prisma:L5890`
- `NotificationTemplate` → `schema.prisma:L5917`
- `OAuthState` → `schema.prisma:L1191`
- `OnboardingProgress` → `schema.prisma:L1209`
- `Order` → `schema.prisma:L2436`
- `OrderAction` → `schema.prisma:L2783`
- `OrderCustomer` → `schema.prisma:L2563`
- `OrderDiscount` → `schema.prisma:L5771`
- `OrderItem` → `schema.prisma:L2579`
- `OrderItemModifier` → `schema.prisma:L2767`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8862`
- `OrganizationGoal` → `schema.prisma:L8820`
- `OrganizationModule` → `schema.prisma:L7864`
- `OrganizationPaymentConfig` → `schema.prisma:L4286`
- `OrganizationPayoutConfig` → `schema.prisma:L8895`
- `OrganizationPricingStructure` → `schema.prisma:L4318`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8843`
- `OtpChallenge` → `schema.prisma:L5301`
- `PartnerAPIKey` → `schema.prisma:L4116`
- `Payment` → `schema.prisma:L2816`
- `PaymentAllocation` → `schema.prisma:L2955`
- `PaymentLink` → `schema.prisma:L10340`
- `PaymentLinkAttribution` → `schema.prisma:L10448`
- `PaymentLinkItem` → `schema.prisma:L10403`
- `PaymentLinkItemModifier` → `schema.prisma:L10430`
- `PaymentProvider` → `schema.prisma:L3671`
- `PayrollLine` → `schema.prisma:L11944`
- `PayrollRun` → `schema.prisma:L11913`
- `PerformanceGoal` → `schema.prisma:L8797`
- `PermissionSet` → `schema.prisma:L1091`
- `PlatformCfdi` → `schema.prisma:L12225`
- `PlatformEmisor` → `schema.prisma:L12169`
- `PlatformSettings` → `schema.prisma:L4093`
- `PosCommand` → `schema.prisma:L5971`
- `PosConnectionStatus` → `schema.prisma:L748`
- `PricingPolicy` → `schema.prisma:L1906`
- `Printer` → `schema.prisma:L10851`
- `PrintGateway` → `schema.prisma:L10888`
- `PrintJob` → `schema.prisma:L10935`
- `PrintStation` → `schema.prisma:L10906`
- `ProcessedStripeEvent` → `schema.prisma:L4529`
- `ProcessorReliabilityMetric` → `schema.prisma:L5014`
- `Product` → `schema.prisma:L1379`
- `ProductModifierGroup` → `schema.prisma:L2755`
- `ProductOption` → `schema.prisma:L10622`
- `ProductOptionValue` → `schema.prisma:L10633`
- `PromoterBankAccount` → `schema.prisma:L12064`
- `PromoterCommissionEntry` → `schema.prisma:L12083`
- `PromoterLocationPing` → `schema.prisma:L2402`
- `ProviderCostStructure` → `schema.prisma:L4565`
- `ProviderEventLog` → `schema.prisma:L4395`
- `PurchaseOrder` → `schema.prisma:L1820`
- `PurchaseOrderItem` → `schema.prisma:L1877`
- `RateCorrectionBatch` → `schema.prisma:L4790`
- `RateCorrectionEntry` → `schema.prisma:L4832`
- `RawMaterial` → `schema.prisma:L1608`
- `RawMaterialMovement` → `schema.prisma:L1959`
- `Recipe` → `schema.prisma:L1674`
- `RecipeLine` → `schema.prisma:L1698`
- `Referral` → `schema.prisma:L5436`
- `ReferralProgramConfig` → `schema.prisma:L5401`
- `ReferralRewardGrant` → `schema.prisma:L5527`
- `ReferralTierReward` → `schema.prisma:L5499`
- `ReferralTierUnlock` → `schema.prisma:L5572`
- `Reservation` → `schema.prisma:L9440`
- `ReservationGoogleEventMapping` → `schema.prisma:L10120`
- `ReservationModifier` → `schema.prisma:L9599`
- `ReservationReminderSent` → `schema.prisma:L9582`
- `ReservationSettings` → `schema.prisma:L9760`
- `ReservationWaitlistEntry` → `schema.prisma:L9728`
- `Review` → `schema.prisma:L3250`
- `SalesRetention` → `schema.prisma:L11764`
- `SaleVerification` → `schema.prisma:L3009`
- `ScheduledCommand` → `schema.prisma:L7344`
- `SerializedItem` → `schema.prisma:L7935`
- `SerializedItemCustodyEvent` → `schema.prisma:L8098`
- `SettlementConfiguration` → `schema.prisma:L4865`
- `SettlementConfirmation` → `schema.prisma:L4978`
- `SettlementIncident` → `schema.prisma:L4929`
- `SettlementSimulation` → `schema.prisma:L4900`
- `Shift` → `schema.prisma:L2250`
- `SimRegistrationRequest` → `schema.prisma:L8136`
- `SimRegistrationRequestItem` → `schema.prisma:L8158`
- `SlotHold` → `schema.prisma:L9639`
- `Staff` → `schema.prisma:L768`
- `StaffOnboardingState` → `schema.prisma:L11003`
- `StaffOrganization` → `schema.prisma:L1005`
- `StaffPasskey` → `schema.prisma:L1032`
- `StaffVenue` → `schema.prisma:L941`
- `StockAlertConfig` → `schema.prisma:L8779`
- `StockBatch` → `schema.prisma:L2090`
- `StockCount` → `schema.prisma:L2027`
- `StockCountItem` → `schema.prisma:L2048`
- `StripeWebhookEvent` → `schema.prisma:L4512`
- `Supplier` → `schema.prisma:L1733`
- `SupplierPricing` → `schema.prisma:L1786`
- `Table` → `schema.prisma:L2162`
- `Terminal` → `schema.prisma:L3301`
- `TerminalHealth` → `schema.prisma:L3447`
- `TerminalLog` → `schema.prisma:L3421`
- `TerminalOrder` → `schema.prisma:L3574`
- `TerminalOrderItem` → `schema.prisma:L3649`
- `TerminalPaymentRequest` → `schema.prisma:L3518`
- `TimeEntry` → `schema.prisma:L2315`
- `TimeEntryBreak` → `schema.prisma:L2384`
- `TokenPurchase` → `schema.prisma:L7018`
- `TokenUsageRecord` → `schema.prisma:L6990`
- `TpvCommandHistory` → `schema.prisma:L7250`
- `TpvCommandQueue` → `schema.prisma:L7190`
- `TpvFeedback` → `schema.prisma:L6903`
- `TpvMessage` → `schema.prisma:L9136`
- `TpvMessageDelivery` → `schema.prisma:L9188`
- `TpvMessageResponse` → `schema.prisma:L9211`
- `TrainingModule` → `schema.prisma:L9266`
- `TrainingProgress` → `schema.prisma:L9343`
- `TrainingQuizQuestion` → `schema.prisma:L9325`
- `TrainingStep` → `schema.prisma:L9305`
- `TransactionCost` → `schema.prisma:L4728`
- `UnitConversion` → `schema.prisma:L1937`
- `user_sessions` → `schema.prisma:L4151`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L639`
- `VenueChatSession` → `schema.prisma:L594`
- `VenueCommission` → `schema.prisma:L10783`
- `VenueCreditAssessment` → `schema.prisma:L7680`
- `VenueCryptoConfig` → `schema.prisma:L9003`
- `VenueFeature` → `schema.prisma:L3123`
- `VenueModule` → `schema.prisma:L7836`
- `VenuePaymentConfig` → `schema.prisma:L4252`
- `VenuePaymentLinkSettings` → `schema.prisma:L10153`
- `VenuePricingStructure` → `schema.prisma:L4668`
- `VenueRoleConfig` → `schema.prisma:L1120`
- `VenueRolePermission` → `schema.prisma:L1062`
- `VenueSettings` → `schema.prisma:L679`
- `VenueTransaction` → `schema.prisma:L3060`
- `VenueWhatsappActivation` → `schema.prisma:L530`
- `WebhookEvent` → `schema.prisma:L3159`
- `WebhookSubscription` → `schema.prisma:L4368`
- `WhatsappContactWindow` → `schema.prisma:L548`
- `WhatsappInboundEvent` → `schema.prisma:L568`
- `Zone` → `schema.prisma:L96`
