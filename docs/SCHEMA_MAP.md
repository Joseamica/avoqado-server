# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **262 models / 247 enums / ~12,300 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
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
| 8   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderItem`, `OrderItemModifier`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `Shift`                                                                                                                                                                                                                                       |
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

- `AccountingPeriodLock` → `schema.prisma:L11652`
- `AccountMapping` → `schema.prisma:L11548`
- `ActivityLog` → `schema.prisma:L5165`
- `Aggregator` → `schema.prisma:L10696`
- `AngelPayUserAccount` → `schema.prisma:L3886`
- `AppUpdate` → `schema.prisma:L8982`
- `Area` → `schema.prisma:L2140`
- `BankStatement` → `schema.prisma:L11422`
- `BankStatementLine` → `schema.prisma:L11443`
- `BillingTaxProfile` → `schema.prisma:L12232`
- `BulkCommandOperation` → `schema.prisma:L7335`
- `CalendarSyncOutbox` → `schema.prisma:L10099`
- `CampaignDelivery` → `schema.prisma:L9140`
- `CashCloseout` → `schema.prisma:L7668`
- `CashDeposit` → `schema.prisma:L8784`
- `CashDrawerEvent` → `schema.prisma:L10542`
- `CashDrawerSession` → `schema.prisma:L10518`
- `CashOutCommissionRate` → `schema.prisma:L12061`
- `CashOutScheduleDay` → `schema.prisma:L12084`
- `CashOutWithdrawal` → `schema.prisma:L12146`
- `Cfdi` → `schema.prisma:L11325`
- `ChatbotTokenBudget` → `schema.prisma:L6983`
- `ChatConversation` → `schema.prisma:L6838`
- `ChatFeedback` → `schema.prisma:L6924`
- `ChatLearningEvent` → `schema.prisma:L6881`
- `ChatMessage` → `schema.prisma:L6861`
- `ChatTrainingData` → `schema.prisma:L6795`
- `CheckoutSession` → `schema.prisma:L4166`
- `ClassSession` → `schema.prisma:L9720`
- `CommissionCalculation` → `schema.prisma:L8563`
- `CommissionClawback` → `schema.prisma:L8736`
- `CommissionConfig` → `schema.prisma:L8336`
- `CommissionMilestone` → `schema.prisma:L8479`
- `CommissionOverride` → `schema.prisma:L8406`
- `CommissionPayout` → `schema.prisma:L8687`
- `CommissionSummary` → `schema.prisma:L8626`
- `CommissionTier` → `schema.prisma:L8443`
- `Consumer` → `schema.prisma:L5286`
- `ConsumerAuthAccount` → `schema.prisma:L5311`
- `CouponCode` → `schema.prisma:L5717`
- `CouponRedemption` → `schema.prisma:L5748`
- `CreditAssessmentHistory` → `schema.prisma:L7777`
- `CreditItemBalance` → `schema.prisma:L10308`
- `CreditOffer` → `schema.prisma:L7796`
- `CreditPack` → `schema.prisma:L10224`
- `CreditPackItem` → `schema.prisma:L10253`
- `CreditPackPurchase` → `schema.prisma:L10270`
- `CreditTransaction` → `schema.prisma:L10330`
- `Customer` → `schema.prisma:L5191`
- `CustomerDiscount` → `schema.prisma:L5768`
- `CustomerGroup` → `schema.prisma:L5345`
- `CustomerTaxProfile` → `schema.prisma:L11394`
- `DeliveryActivationRequest` → `schema.prisma:L4488`
- `DeliveryChannelLink` → `schema.prisma:L4452`
- `DeliveryOrderEvent` → `schema.prisma:L4512`
- `DeviceToken` → `schema.prisma:L5970`
- `DigitalReceipt` → `schema.prisma:L2980`
- `Discount` → `schema.prisma:L5617`
- `EcommerceMerchant` → `schema.prisma:L3978`
- `EmailTemplate` → `schema.prisma:L9079`
- `Employee` → `schema.prisma:L11909`
- `Estimate` → `schema.prisma:L10603`
- `EstimateItem` → `schema.prisma:L10631`
- `Expense` → `schema.prisma:L11696`
- `ExternalBusyBlock` → `schema.prisma:L9992`
- `Feature` → `schema.prisma:L3109`
- `FeeSchedule` → `schema.prisma:L3187`
- `FeeTier` → `schema.prisma:L3198`
- `FinancialAccount` → `schema.prisma:L10793`
- `FinancialConnection` → `schema.prisma:L10762`
- `FinancialProvider` → `schema.prisma:L10748`
- `FiscalEmisor` → `schema.prisma:L11248`
- `FiscalLossCarryforward` → `schema.prisma:L11819`
- `FixedAsset` → `schema.prisma:L11837`
- `FixedAssetDepreciation` → `schema.prisma:L11866`
- `FloorElement` → `schema.prisma:L2216`
- `GeofenceRule` → `schema.prisma:L7420`
- `GoogleCalendarChannel` → `schema.prisma:L9969`
- `GoogleCalendarConnection` → `schema.prisma:L9921`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L10022`
- `GoogleOAuthSession` → `schema.prisma:L10044`
- `HolidayCalendar` → `schema.prisma:L5089`
- `IdempotencyRequest` → `schema.prisma:L8211`
- `Inventory` → `schema.prisma:L1558`
- `InventoryMovement` → `schema.prisma:L1582`
- `InventoryTransfer` → `schema.prisma:L10575`
- `Invitation` → `schema.prisma:L1144`
- `Invoice` → `schema.prisma:L3210`
- `InvoiceItem` → `schema.prisma:L3236`
- `ItemCategory` → `schema.prisma:L7928`
- `JournalEntry` → `schema.prisma:L11606`
- `JournalLine` → `schema.prisma:L11634`
- `KdsOrder` → `schema.prisma:L10841`
- `KdsOrderItem` → `schema.prisma:L10858`
- `LearnedPatterns` → `schema.prisma:L6905`
- `LedgerAccount` → `schema.prisma:L11498`
- `LiveDemoSession` → `schema.prisma:L664`
- `LowStockAlert` → `schema.prisma:L1999`
- `LoyaltyConfig` → `schema.prisma:L5375`
- `LoyaltyTransaction` → `schema.prisma:L5398`
- `MarketingCampaign` → `schema.prisma:L9097`
- `McpAuthCode` → `schema.prisma:L11155`
- `McpOAuthClient` → `schema.prisma:L11139`
- `McpRefreshToken` → `schema.prisma:L11173`
- `MeasurementUnit` → `schema.prisma:L10681`
- `Menu` → `schema.prisma:L1330`
- `MenuCategory` → `schema.prisma:L1267`
- `MenuCategoryAssignment` → `schema.prisma:L1365`
- `MercadoPagoWebhookEvent` → `schema.prisma:L11069`
- `MerchantAccount` → `schema.prisma:L3716`
- `MerchantFiscalConfig` → `schema.prisma:L11296`
- `MerchantRevenueShare` → `schema.prisma:L4669`
- `MerchantRoutingRule` → `schema.prisma:L3838`
- `MilestoneAchievement` → `schema.prisma:L8524`
- `Modifier` → `schema.prisma:L2722`
- `ModifierGroup` → `schema.prisma:L2686`
- `Module` → `schema.prisma:L7844`
- `MoneyAnomaly` → `schema.prisma:L4572`
- `MonthlyVenueProfit` → `schema.prisma:L5115`
- `Notification` → `schema.prisma:L5872`
- `NotificationPreference` → `schema.prisma:L5919`
- `NotificationTemplate` → `schema.prisma:L5946`
- `OAuthState` → `schema.prisma:L1195`
- `OnboardingProgress` → `schema.prisma:L1213`
- `Order` → `schema.prisma:L2440`
- `OrderAction` → `schema.prisma:L2787`
- `OrderCustomer` → `schema.prisma:L2567`
- `OrderDiscount` → `schema.prisma:L5800`
- `OrderItem` → `schema.prisma:L2583`
- `OrderItemModifier` → `schema.prisma:L2771`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8898`
- `OrganizationGoal` → `schema.prisma:L8856`
- `OrganizationModule` → `schema.prisma:L7900`
- `OrganizationPaymentConfig` → `schema.prisma:L4290`
- `OrganizationPayoutConfig` → `schema.prisma:L8931`
- `OrganizationPricingStructure` → `schema.prisma:L4322`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8879`
- `OtpChallenge` → `schema.prisma:L5330`
- `PartnerAPIKey` → `schema.prisma:L4120`
- `Payment` → `schema.prisma:L2820`
- `PaymentAllocation` → `schema.prisma:L2959`
- `PaymentLink` → `schema.prisma:L10376`
- `PaymentLinkAttribution` → `schema.prisma:L10484`
- `PaymentLinkItem` → `schema.prisma:L10439`
- `PaymentLinkItemModifier` → `schema.prisma:L10466`
- `PaymentProvider` → `schema.prisma:L3675`
- `PayrollLine` → `schema.prisma:L11980`
- `PayrollRun` → `schema.prisma:L11949`
- `PerformanceGoal` → `schema.prisma:L8833`
- `PermissionSet` → `schema.prisma:L1095`
- `PlatformCfdi` → `schema.prisma:L12261`
- `PlatformEmisor` → `schema.prisma:L12205`
- `PlatformSettings` → `schema.prisma:L4097`
- `PosCommand` → `schema.prisma:L6000`
- `PosConnectionStatus` → `schema.prisma:L749`
- `PricingPolicy` → `schema.prisma:L1910`
- `Printer` → `schema.prisma:L10887`
- `PrintGateway` → `schema.prisma:L10924`
- `PrintJob` → `schema.prisma:L10971`
- `PrintStation` → `schema.prisma:L10942`
- `ProcessedStripeEvent` → `schema.prisma:L4558`
- `ProcessorReliabilityMetric` → `schema.prisma:L5043`
- `Product` → `schema.prisma:L1383`
- `ProductModifierGroup` → `schema.prisma:L2759`
- `ProductOption` → `schema.prisma:L10658`
- `ProductOptionValue` → `schema.prisma:L10669`
- `PromoterBankAccount` → `schema.prisma:L12100`
- `PromoterCommissionEntry` → `schema.prisma:L12119`
- `PromoterLocationPing` → `schema.prisma:L2406`
- `ProviderCostStructure` → `schema.prisma:L4594`
- `ProviderEventLog` → `schema.prisma:L4399`
- `PurchaseOrder` → `schema.prisma:L1824`
- `PurchaseOrderItem` → `schema.prisma:L1881`
- `RateCorrectionBatch` → `schema.prisma:L4819`
- `RateCorrectionEntry` → `schema.prisma:L4861`
- `RawMaterial` → `schema.prisma:L1612`
- `RawMaterialMovement` → `schema.prisma:L1963`
- `Recipe` → `schema.prisma:L1678`
- `RecipeLine` → `schema.prisma:L1702`
- `Referral` → `schema.prisma:L5465`
- `ReferralProgramConfig` → `schema.prisma:L5430`
- `ReferralRewardGrant` → `schema.prisma:L5556`
- `ReferralTierReward` → `schema.prisma:L5528`
- `ReferralTierUnlock` → `schema.prisma:L5601`
- `Reservation` → `schema.prisma:L9476`
- `ReservationGoogleEventMapping` → `schema.prisma:L10156`
- `ReservationModifier` → `schema.prisma:L9635`
- `ReservationReminderSent` → `schema.prisma:L9618`
- `ReservationSettings` → `schema.prisma:L9796`
- `ReservationWaitlistEntry` → `schema.prisma:L9764`
- `Review` → `schema.prisma:L3254`
- `SalesRetention` → `schema.prisma:L11800`
- `SaleVerification` → `schema.prisma:L3013`
- `ScheduledCommand` → `schema.prisma:L7380`
- `SerializedItem` → `schema.prisma:L7971`
- `SerializedItemCustodyEvent` → `schema.prisma:L8134`
- `SettlementConfiguration` → `schema.prisma:L4894`
- `SettlementConfirmation` → `schema.prisma:L5007`
- `SettlementIncident` → `schema.prisma:L4958`
- `SettlementSimulation` → `schema.prisma:L4929`
- `Shift` → `schema.prisma:L2254`
- `SimRegistrationRequest` → `schema.prisma:L8172`
- `SimRegistrationRequestItem` → `schema.prisma:L8194`
- `SlotHold` → `schema.prisma:L9675`
- `Staff` → `schema.prisma:L769`
- `StaffOnboardingState` → `schema.prisma:L11039`
- `StaffOrganization` → `schema.prisma:L1009`
- `StaffPasskey` → `schema.prisma:L1036`
- `StaffVenue` → `schema.prisma:L945`
- `StockAlertConfig` → `schema.prisma:L8815`
- `StockBatch` → `schema.prisma:L2094`
- `StockCount` → `schema.prisma:L2031`
- `StockCountItem` → `schema.prisma:L2052`
- `StripeWebhookEvent` → `schema.prisma:L4541`
- `Supplier` → `schema.prisma:L1737`
- `SupplierPricing` → `schema.prisma:L1790`
- `Table` → `schema.prisma:L2166`
- `Terminal` → `schema.prisma:L3305`
- `TerminalHealth` → `schema.prisma:L3451`
- `TerminalLog` → `schema.prisma:L3425`
- `TerminalOrder` → `schema.prisma:L3578`
- `TerminalOrderItem` → `schema.prisma:L3653`
- `TerminalPaymentRequest` → `schema.prisma:L3522`
- `TimeEntry` → `schema.prisma:L2319`
- `TimeEntryBreak` → `schema.prisma:L2388`
- `TokenPurchase` → `schema.prisma:L7054`
- `TokenUsageRecord` → `schema.prisma:L7026`
- `TpvCommandHistory` → `schema.prisma:L7286`
- `TpvCommandQueue` → `schema.prisma:L7226`
- `TpvFeedback` → `schema.prisma:L6939`
- `TpvMessage` → `schema.prisma:L9172`
- `TpvMessageDelivery` → `schema.prisma:L9224`
- `TpvMessageResponse` → `schema.prisma:L9247`
- `TrainingModule` → `schema.prisma:L9302`
- `TrainingProgress` → `schema.prisma:L9379`
- `TrainingQuizQuestion` → `schema.prisma:L9361`
- `TrainingStep` → `schema.prisma:L9341`
- `TransactionCost` → `schema.prisma:L4757`
- `UnitConversion` → `schema.prisma:L1941`
- `user_sessions` → `schema.prisma:L4155`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L640`
- `VenueChatSession` → `schema.prisma:L595`
- `VenueCommission` → `schema.prisma:L10819`
- `VenueCreditAssessment` → `schema.prisma:L7716`
- `VenueCryptoConfig` → `schema.prisma:L9039`
- `VenueFeature` → `schema.prisma:L3127`
- `VenueModule` → `schema.prisma:L7872`
- `VenuePaymentConfig` → `schema.prisma:L4256`
- `VenuePaymentLinkSettings` → `schema.prisma:L10189`
- `VenuePricingStructure` → `schema.prisma:L4697`
- `VenueRoleConfig` → `schema.prisma:L1124`
- `VenueRolePermission` → `schema.prisma:L1066`
- `VenueSettings` → `schema.prisma:L680`
- `VenueTransaction` → `schema.prisma:L3064`
- `VenueWhatsappActivation` → `schema.prisma:L531`
- `WebhookEvent` → `schema.prisma:L3163`
- `WebhookSubscription` → `schema.prisma:L4372`
- `WhatsappContactWindow` → `schema.prisma:L549`
- `WhatsappInboundEvent` → `schema.prisma:L569`
- `Zone` → `schema.prisma:L96`
