# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **254 models / 237 enums / ~11,900 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
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
| 8   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderItem`, `OrderItemModifier`, `Shift`                                                                                                                                                                                                                                                                                                                                                                        |
| 9   | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                          |
| 10  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig` |
| 11  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 12  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                 |
| 13  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 14  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`                                                                                                                                                                                                                                                                               |
| 15  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                              |
| 16  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`                                                                                                                                                                                                                                        |
| 17  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`                                                                                                                                                                                                                                                         |
| 18  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                |
| 19  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 20  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 21  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L11263`
- `AccountMapping` → `schema.prisma:L11159`
- `ActivityLog` → `schema.prisma:L4977`
- `Aggregator` → `schema.prisma:L10459`
- `AngelPayUserAccount` → `schema.prisma:L3786`
- `AppUpdate` → `schema.prisma:L8745`
- `Area` → `schema.prisma:L2108`
- `BankStatement` → `schema.prisma:L11033`
- `BankStatementLine` → `schema.prisma:L11054`
- `BillingTaxProfile` → `schema.prisma:L11843`
- `BulkCommandOperation` → `schema.prisma:L7098`
- `CalendarSyncOutbox` → `schema.prisma:L9862`
- `CampaignDelivery` → `schema.prisma:L8903`
- `CashCloseout` → `schema.prisma:L7431`
- `CashDeposit` → `schema.prisma:L8547`
- `CashDrawerEvent` → `schema.prisma:L10305`
- `CashDrawerSession` → `schema.prisma:L10281`
- `CashOutCommissionRate` → `schema.prisma:L11672`
- `CashOutScheduleDay` → `schema.prisma:L11695`
- `CashOutWithdrawal` → `schema.prisma:L11757`
- `Cfdi` → `schema.prisma:L10936`
- `ChatbotTokenBudget` → `schema.prisma:L6746`
- `ChatConversation` → `schema.prisma:L6601`
- `ChatFeedback` → `schema.prisma:L6687`
- `ChatLearningEvent` → `schema.prisma:L6644`
- `ChatMessage` → `schema.prisma:L6624`
- `ChatTrainingData` → `schema.prisma:L6558`
- `CheckoutSession` → `schema.prisma:L4066`
- `ClassSession` → `schema.prisma:L9483`
- `CommissionCalculation` → `schema.prisma:L8326`
- `CommissionClawback` → `schema.prisma:L8499`
- `CommissionConfig` → `schema.prisma:L8099`
- `CommissionMilestone` → `schema.prisma:L8242`
- `CommissionOverride` → `schema.prisma:L8169`
- `CommissionPayout` → `schema.prisma:L8450`
- `CommissionSummary` → `schema.prisma:L8389`
- `CommissionTier` → `schema.prisma:L8206`
- `Consumer` → `schema.prisma:L5098`
- `ConsumerAuthAccount` → `schema.prisma:L5123`
- `CouponCode` → `schema.prisma:L5526`
- `CouponRedemption` → `schema.prisma:L5557`
- `CreditAssessmentHistory` → `schema.prisma:L7540`
- `CreditItemBalance` → `schema.prisma:L10071`
- `CreditOffer` → `schema.prisma:L7559`
- `CreditPack` → `schema.prisma:L9987`
- `CreditPackItem` → `schema.prisma:L10016`
- `CreditPackPurchase` → `schema.prisma:L10033`
- `CreditTransaction` → `schema.prisma:L10093`
- `Customer` → `schema.prisma:L5003`
- `CustomerDiscount` → `schema.prisma:L5577`
- `CustomerGroup` → `schema.prisma:L5157`
- `CustomerTaxProfile` → `schema.prisma:L11005`
- `DeviceToken` → `schema.prisma:L5772`
- `DigitalReceipt` → `schema.prisma:L2924`
- `Discount` → `schema.prisma:L5426`
- `EcommerceMerchant` → `schema.prisma:L3878`
- `EmailTemplate` → `schema.prisma:L8842`
- `Employee` → `schema.prisma:L11520`
- `Estimate` → `schema.prisma:L10366`
- `EstimateItem` → `schema.prisma:L10394`
- `Expense` → `schema.prisma:L11307`
- `ExternalBusyBlock` → `schema.prisma:L9755`
- `Feature` → `schema.prisma:L3053`
- `FeeSchedule` → `schema.prisma:L3131`
- `FeeTier` → `schema.prisma:L3142`
- `FinancialAccount` → `schema.prisma:L10556`
- `FinancialConnection` → `schema.prisma:L10525`
- `FinancialProvider` → `schema.prisma:L10511`
- `FiscalEmisor` → `schema.prisma:L10859`
- `FiscalLossCarryforward` → `schema.prisma:L11430`
- `FixedAsset` → `schema.prisma:L11448`
- `FixedAssetDepreciation` → `schema.prisma:L11477`
- `FloorElement` → `schema.prisma:L2184`
- `GeofenceRule` → `schema.prisma:L7183`
- `GoogleCalendarChannel` → `schema.prisma:L9732`
- `GoogleCalendarConnection` → `schema.prisma:L9684`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9785`
- `GoogleOAuthSession` → `schema.prisma:L9807`
- `HolidayCalendar` → `schema.prisma:L4901`
- `IdempotencyRequest` → `schema.prisma:L7974`
- `Inventory` → `schema.prisma:L1530`
- `InventoryMovement` → `schema.prisma:L1554`
- `InventoryTransfer` → `schema.prisma:L10338`
- `Invitation` → `schema.prisma:L1131`
- `Invoice` → `schema.prisma:L3154`
- `InvoiceItem` → `schema.prisma:L3180`
- `ItemCategory` → `schema.prisma:L7691`
- `JournalEntry` → `schema.prisma:L11217`
- `JournalLine` → `schema.prisma:L11245`
- `KdsOrder` → `schema.prisma:L10604`
- `KdsOrderItem` → `schema.prisma:L10621`
- `LearnedPatterns` → `schema.prisma:L6668`
- `LedgerAccount` → `schema.prisma:L11109`
- `LiveDemoSession` → `schema.prisma:L654`
- `LowStockAlert` → `schema.prisma:L1971`
- `LoyaltyConfig` → `schema.prisma:L5187`
- `LoyaltyTransaction` → `schema.prisma:L5210`
- `MarketingCampaign` → `schema.prisma:L8860`
- `McpAuthCode` → `schema.prisma:L10766`
- `McpOAuthClient` → `schema.prisma:L10750`
- `McpRefreshToken` → `schema.prisma:L10784`
- `MeasurementUnit` → `schema.prisma:L10444`
- `Menu` → `schema.prisma:L1312`
- `MenuCategory` → `schema.prisma:L1254`
- `MenuCategoryAssignment` → `schema.prisma:L1347`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10680`
- `MerchantAccount` → `schema.prisma:L3616`
- `MerchantFiscalConfig` → `schema.prisma:L10907`
- `MerchantRevenueShare` → `schema.prisma:L4481`
- `MerchantRoutingRule` → `schema.prisma:L3738`
- `MilestoneAchievement` → `schema.prisma:L8287`
- `Modifier` → `schema.prisma:L2666`
- `ModifierGroup` → `schema.prisma:L2630`
- `Module` → `schema.prisma:L7607`
- `MoneyAnomaly` → `schema.prisma:L4384`
- `MonthlyVenueProfit` → `schema.prisma:L4927`
- `Notification` → `schema.prisma:L5674`
- `NotificationPreference` → `schema.prisma:L5721`
- `NotificationTemplate` → `schema.prisma:L5748`
- `OAuthState` → `schema.prisma:L1182`
- `OnboardingProgress` → `schema.prisma:L1200`
- `Order` → `schema.prisma:L2408`
- `OrderAction` → `schema.prisma:L2731`
- `OrderCustomer` → `schema.prisma:L2535`
- `OrderDiscount` → `schema.prisma:L5609`
- `OrderItem` → `schema.prisma:L2551`
- `OrderItemModifier` → `schema.prisma:L2715`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8661`
- `OrganizationGoal` → `schema.prisma:L8619`
- `OrganizationModule` → `schema.prisma:L7663`
- `OrganizationPaymentConfig` → `schema.prisma:L4190`
- `OrganizationPayoutConfig` → `schema.prisma:L8694`
- `OrganizationPricingStructure` → `schema.prisma:L4222`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8642`
- `OtpChallenge` → `schema.prisma:L5142`
- `PartnerAPIKey` → `schema.prisma:L4020`
- `Payment` → `schema.prisma:L2764`
- `PaymentAllocation` → `schema.prisma:L2903`
- `PaymentLink` → `schema.prisma:L10139`
- `PaymentLinkAttribution` → `schema.prisma:L10247`
- `PaymentLinkItem` → `schema.prisma:L10202`
- `PaymentLinkItemModifier` → `schema.prisma:L10229`
- `PaymentProvider` → `schema.prisma:L3575`
- `PayrollLine` → `schema.prisma:L11591`
- `PayrollRun` → `schema.prisma:L11560`
- `PerformanceGoal` → `schema.prisma:L8596`
- `PermissionSet` → `schema.prisma:L1082`
- `PlatformCfdi` → `schema.prisma:L11872`
- `PlatformEmisor` → `schema.prisma:L11816`
- `PlatformSettings` → `schema.prisma:L3997`
- `PosCommand` → `schema.prisma:L5802`
- `PosConnectionStatus` → `schema.prisma:L739`
- `PricingPolicy` → `schema.prisma:L1882`
- `ProcessedStripeEvent` → `schema.prisma:L4370`
- `ProcessorReliabilityMetric` → `schema.prisma:L4855`
- `Product` → `schema.prisma:L1365`
- `ProductModifierGroup` → `schema.prisma:L2703`
- `ProductOption` → `schema.prisma:L10421`
- `ProductOptionValue` → `schema.prisma:L10432`
- `PromoterBankAccount` → `schema.prisma:L11711`
- `PromoterCommissionEntry` → `schema.prisma:L11730`
- `PromoterLocationPing` → `schema.prisma:L2374`
- `ProviderCostStructure` → `schema.prisma:L4406`
- `ProviderEventLog` → `schema.prisma:L4299`
- `PurchaseOrder` → `schema.prisma:L1796`
- `PurchaseOrderItem` → `schema.prisma:L1853`
- `RateCorrectionBatch` → `schema.prisma:L4631`
- `RateCorrectionEntry` → `schema.prisma:L4673`
- `RawMaterial` → `schema.prisma:L1584`
- `RawMaterialMovement` → `schema.prisma:L1935`
- `Recipe` → `schema.prisma:L1650`
- `RecipeLine` → `schema.prisma:L1674`
- `Referral` → `schema.prisma:L5274`
- `ReferralProgramConfig` → `schema.prisma:L5239`
- `ReferralRewardGrant` → `schema.prisma:L5365`
- `ReferralTierReward` → `schema.prisma:L5337`
- `ReferralTierUnlock` → `schema.prisma:L5410`
- `Reservation` → `schema.prisma:L9239`
- `ReservationGoogleEventMapping` → `schema.prisma:L9919`
- `ReservationModifier` → `schema.prisma:L9398`
- `ReservationReminderSent` → `schema.prisma:L9381`
- `ReservationSettings` → `schema.prisma:L9559`
- `ReservationWaitlistEntry` → `schema.prisma:L9527`
- `Review` → `schema.prisma:L3198`
- `SalesRetention` → `schema.prisma:L11411`
- `SaleVerification` → `schema.prisma:L2957`
- `ScheduledCommand` → `schema.prisma:L7143`
- `SerializedItem` → `schema.prisma:L7734`
- `SerializedItemCustodyEvent` → `schema.prisma:L7897`
- `SettlementConfiguration` → `schema.prisma:L4706`
- `SettlementConfirmation` → `schema.prisma:L4819`
- `SettlementIncident` → `schema.prisma:L4770`
- `SettlementSimulation` → `schema.prisma:L4741`
- `Shift` → `schema.prisma:L2222`
- `SimRegistrationRequest` → `schema.prisma:L7935`
- `SimRegistrationRequestItem` → `schema.prisma:L7957`
- `SlotHold` → `schema.prisma:L9438`
- `Staff` → `schema.prisma:L759`
- `StaffOnboardingState` → `schema.prisma:L10650`
- `StaffOrganization` → `schema.prisma:L996`
- `StaffPasskey` → `schema.prisma:L1023`
- `StaffVenue` → `schema.prisma:L932`
- `StockAlertConfig` → `schema.prisma:L8578`
- `StockBatch` → `schema.prisma:L2062`
- `StockCount` → `schema.prisma:L2003`
- `StockCountItem` → `schema.prisma:L2024`
- `StripeWebhookEvent` → `schema.prisma:L4353`
- `Supplier` → `schema.prisma:L1709`
- `SupplierPricing` → `schema.prisma:L1762`
- `Table` → `schema.prisma:L2134`
- `Terminal` → `schema.prisma:L3249`
- `TerminalHealth` → `schema.prisma:L3395`
- `TerminalLog` → `schema.prisma:L3369`
- `TerminalOrder` → `schema.prisma:L3478`
- `TerminalOrderItem` → `schema.prisma:L3553`
- `TimeEntry` → `schema.prisma:L2287`
- `TimeEntryBreak` → `schema.prisma:L2356`
- `TokenPurchase` → `schema.prisma:L6817`
- `TokenUsageRecord` → `schema.prisma:L6789`
- `TpvCommandHistory` → `schema.prisma:L7049`
- `TpvCommandQueue` → `schema.prisma:L6989`
- `TpvFeedback` → `schema.prisma:L6702`
- `TpvMessage` → `schema.prisma:L8935`
- `TpvMessageDelivery` → `schema.prisma:L8987`
- `TpvMessageResponse` → `schema.prisma:L9010`
- `TrainingModule` → `schema.prisma:L9065`
- `TrainingProgress` → `schema.prisma:L9142`
- `TrainingQuizQuestion` → `schema.prisma:L9124`
- `TrainingStep` → `schema.prisma:L9104`
- `TransactionCost` → `schema.prisma:L4569`
- `UnitConversion` → `schema.prisma:L1913`
- `user_sessions` → `schema.prisma:L4055`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L630`
- `VenueChatSession` → `schema.prisma:L585`
- `VenueCommission` → `schema.prisma:L10582`
- `VenueCreditAssessment` → `schema.prisma:L7479`
- `VenueCryptoConfig` → `schema.prisma:L8802`
- `VenueFeature` → `schema.prisma:L3071`
- `VenueModule` → `schema.prisma:L7635`
- `VenuePaymentConfig` → `schema.prisma:L4156`
- `VenuePaymentLinkSettings` → `schema.prisma:L9952`
- `VenuePricingStructure` → `schema.prisma:L4509`
- `VenueRoleConfig` → `schema.prisma:L1111`
- `VenueRolePermission` → `schema.prisma:L1053`
- `VenueSettings` → `schema.prisma:L670`
- `VenueTransaction` → `schema.prisma:L3008`
- `VenueWhatsappActivation` → `schema.prisma:L521`
- `WebhookEvent` → `schema.prisma:L3107`
- `WebhookSubscription` → `schema.prisma:L4272`
- `WhatsappContactWindow` → `schema.prisma:L539`
- `WhatsappInboundEvent` → `schema.prisma:L559`
- `Zone` → `schema.prisma:L96`
