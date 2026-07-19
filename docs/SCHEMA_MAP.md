# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **264 models / 248 enums / ~12,400 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
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
| 8   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderItem`, `OrderItemModifier`, `OrderServiceCharge`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`                                                                                                                                                                                                |
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

- `AccountingPeriodLock` → `schema.prisma:L11742`
- `AccountMapping` → `schema.prisma:L11638`
- `ActivityLog` → `schema.prisma:L5188`
- `Aggregator` → `schema.prisma:L10786`
- `AngelPayUserAccount` → `schema.prisma:L3899`
- `AppUpdate` → `schema.prisma:L9072`
- `Area` → `schema.prisma:L2144`
- `BankStatement` → `schema.prisma:L11512`
- `BankStatementLine` → `schema.prisma:L11533`
- `BillingTaxProfile` → `schema.prisma:L12322`
- `BulkCommandOperation` → `schema.prisma:L7425`
- `CalendarSyncOutbox` → `schema.prisma:L10189`
- `CampaignDelivery` → `schema.prisma:L9230`
- `CashCloseout` → `schema.prisma:L7758`
- `CashDeposit` → `schema.prisma:L8874`
- `CashDrawerEvent` → `schema.prisma:L10632`
- `CashDrawerSession` → `schema.prisma:L10608`
- `CashOutCommissionRate` → `schema.prisma:L12151`
- `CashOutScheduleDay` → `schema.prisma:L12174`
- `CashOutWithdrawal` → `schema.prisma:L12236`
- `Cfdi` → `schema.prisma:L11415`
- `ChatbotTokenBudget` → `schema.prisma:L7073`
- `ChatConversation` → `schema.prisma:L6928`
- `ChatFeedback` → `schema.prisma:L7014`
- `ChatLearningEvent` → `schema.prisma:L6971`
- `ChatMessage` → `schema.prisma:L6951`
- `ChatTrainingData` → `schema.prisma:L6885`
- `CheckoutSession` → `schema.prisma:L4179`
- `ClassSession` → `schema.prisma:L9810`
- `CommissionCalculation` → `schema.prisma:L8653`
- `CommissionClawback` → `schema.prisma:L8826`
- `CommissionConfig` → `schema.prisma:L8426`
- `CommissionMilestone` → `schema.prisma:L8569`
- `CommissionOverride` → `schema.prisma:L8496`
- `CommissionPayout` → `schema.prisma:L8777`
- `CommissionSummary` → `schema.prisma:L8716`
- `CommissionTier` → `schema.prisma:L8533`
- `Consumer` → `schema.prisma:L5309`
- `ConsumerAuthAccount` → `schema.prisma:L5334`
- `CouponCode` → `schema.prisma:L5740`
- `CouponRedemption` → `schema.prisma:L5771`
- `CreditAssessmentHistory` → `schema.prisma:L7867`
- `CreditItemBalance` → `schema.prisma:L10398`
- `CreditOffer` → `schema.prisma:L7886`
- `CreditPack` → `schema.prisma:L10314`
- `CreditPackItem` → `schema.prisma:L10343`
- `CreditPackPurchase` → `schema.prisma:L10360`
- `CreditTransaction` → `schema.prisma:L10420`
- `Customer` → `schema.prisma:L5214`
- `CustomerDiscount` → `schema.prisma:L5791`
- `CustomerGroup` → `schema.prisma:L5368`
- `CustomerTaxProfile` → `schema.prisma:L11484`
- `DeliveryActivationRequest` → `schema.prisma:L4501`
- `DeliveryChannelLink` → `schema.prisma:L4465`
- `DeliveryOrderEvent` → `schema.prisma:L4525`
- `DeviceToken` → `schema.prisma:L6060`
- `DigitalReceipt` → `schema.prisma:L2993`
- `Discount` → `schema.prisma:L5640`
- `EcommerceMerchant` → `schema.prisma:L3991`
- `EmailTemplate` → `schema.prisma:L9169`
- `Employee` → `schema.prisma:L11999`
- `Estimate` → `schema.prisma:L10693`
- `EstimateItem` → `schema.prisma:L10721`
- `Expense` → `schema.prisma:L11786`
- `ExternalBusyBlock` → `schema.prisma:L10082`
- `Feature` → `schema.prisma:L3122`
- `FeeSchedule` → `schema.prisma:L3200`
- `FeeTier` → `schema.prisma:L3211`
- `FinancialAccount` → `schema.prisma:L10883`
- `FinancialConnection` → `schema.prisma:L10852`
- `FinancialProvider` → `schema.prisma:L10838`
- `FiscalEmisor` → `schema.prisma:L11338`
- `FiscalLossCarryforward` → `schema.prisma:L11909`
- `FixedAsset` → `schema.prisma:L11927`
- `FixedAssetDepreciation` → `schema.prisma:L11956`
- `FloorElement` → `schema.prisma:L2220`
- `GeofenceRule` → `schema.prisma:L7510`
- `GoogleCalendarChannel` → `schema.prisma:L10059`
- `GoogleCalendarConnection` → `schema.prisma:L10011`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L10112`
- `GoogleOAuthSession` → `schema.prisma:L10134`
- `HolidayCalendar` → `schema.prisma:L5112`
- `IdempotencyRequest` → `schema.prisma:L8301`
- `Inventory` → `schema.prisma:L1562`
- `InventoryMovement` → `schema.prisma:L1586`
- `InventoryTransfer` → `schema.prisma:L10665`
- `Invitation` → `schema.prisma:L1148`
- `Invoice` → `schema.prisma:L3223`
- `InvoiceItem` → `schema.prisma:L3249`
- `ItemCategory` → `schema.prisma:L8018`
- `JournalEntry` → `schema.prisma:L11696`
- `JournalLine` → `schema.prisma:L11724`
- `KdsOrder` → `schema.prisma:L10931`
- `KdsOrderItem` → `schema.prisma:L10948`
- `LearnedPatterns` → `schema.prisma:L6995`
- `LedgerAccount` → `schema.prisma:L11588`
- `LiveDemoSession` → `schema.prisma:L667`
- `LowStockAlert` → `schema.prisma:L2003`
- `LoyaltyConfig` → `schema.prisma:L5398`
- `LoyaltyTransaction` → `schema.prisma:L5421`
- `MarketingCampaign` → `schema.prisma:L9187`
- `McpAuthCode` → `schema.prisma:L11245`
- `McpOAuthClient` → `schema.prisma:L11229`
- `McpRefreshToken` → `schema.prisma:L11263`
- `MeasurementUnit` → `schema.prisma:L10771`
- `Menu` → `schema.prisma:L1334`
- `MenuCategory` → `schema.prisma:L1271`
- `MenuCategoryAssignment` → `schema.prisma:L1369`
- `MercadoPagoWebhookEvent` → `schema.prisma:L11159`
- `MerchantAccount` → `schema.prisma:L3729`
- `MerchantFiscalConfig` → `schema.prisma:L11386`
- `MerchantRevenueShare` → `schema.prisma:L4692`
- `MerchantRoutingRule` → `schema.prisma:L3851`
- `MilestoneAchievement` → `schema.prisma:L8614`
- `Modifier` → `schema.prisma:L2735`
- `ModifierGroup` → `schema.prisma:L2699`
- `Module` → `schema.prisma:L7934`
- `MoneyAnomaly` → `schema.prisma:L4595`
- `MonthlyVenueProfit` → `schema.prisma:L5138`
- `Notification` → `schema.prisma:L5962`
- `NotificationPreference` → `schema.prisma:L6009`
- `NotificationTemplate` → `schema.prisma:L6036`
- `OAuthState` → `schema.prisma:L1199`
- `OnboardingProgress` → `schema.prisma:L1217`
- `Order` → `schema.prisma:L2444`
- `OrderAction` → `schema.prisma:L2800`
- `OrderCustomer` → `schema.prisma:L2580`
- `OrderDiscount` → `schema.prisma:L5823`
- `OrderItem` → `schema.prisma:L2596`
- `OrderItemModifier` → `schema.prisma:L2784`
- `OrderServiceCharge` → `schema.prisma:L5907`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8988`
- `OrganizationGoal` → `schema.prisma:L8946`
- `OrganizationModule` → `schema.prisma:L7990`
- `OrganizationPaymentConfig` → `schema.prisma:L4303`
- `OrganizationPayoutConfig` → `schema.prisma:L9021`
- `OrganizationPricingStructure` → `schema.prisma:L4335`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8969`
- `OtpChallenge` → `schema.prisma:L5353`
- `PartnerAPIKey` → `schema.prisma:L4133`
- `Payment` → `schema.prisma:L2833`
- `PaymentAllocation` → `schema.prisma:L2972`
- `PaymentLink` → `schema.prisma:L10466`
- `PaymentLinkAttribution` → `schema.prisma:L10574`
- `PaymentLinkItem` → `schema.prisma:L10529`
- `PaymentLinkItemModifier` → `schema.prisma:L10556`
- `PaymentProvider` → `schema.prisma:L3688`
- `PayrollLine` → `schema.prisma:L12070`
- `PayrollRun` → `schema.prisma:L12039`
- `PerformanceGoal` → `schema.prisma:L8923`
- `PermissionSet` → `schema.prisma:L1099`
- `PlatformCfdi` → `schema.prisma:L12351`
- `PlatformEmisor` → `schema.prisma:L12295`
- `PlatformSettings` → `schema.prisma:L4110`
- `PosCommand` → `schema.prisma:L6090`
- `PosConnectionStatus` → `schema.prisma:L752`
- `PricingPolicy` → `schema.prisma:L1914`
- `Printer` → `schema.prisma:L10977`
- `PrintGateway` → `schema.prisma:L11014`
- `PrintJob` → `schema.prisma:L11061`
- `PrintStation` → `schema.prisma:L11032`
- `ProcessedStripeEvent` → `schema.prisma:L4581`
- `ProcessorReliabilityMetric` → `schema.prisma:L5066`
- `Product` → `schema.prisma:L1387`
- `ProductModifierGroup` → `schema.prisma:L2772`
- `ProductOption` → `schema.prisma:L10748`
- `ProductOptionValue` → `schema.prisma:L10759`
- `PromoterBankAccount` → `schema.prisma:L12190`
- `PromoterCommissionEntry` → `schema.prisma:L12209`
- `PromoterLocationPing` → `schema.prisma:L2410`
- `ProviderCostStructure` → `schema.prisma:L4617`
- `ProviderEventLog` → `schema.prisma:L4412`
- `PurchaseOrder` → `schema.prisma:L1828`
- `PurchaseOrderItem` → `schema.prisma:L1885`
- `RateCorrectionBatch` → `schema.prisma:L4842`
- `RateCorrectionEntry` → `schema.prisma:L4884`
- `RawMaterial` → `schema.prisma:L1616`
- `RawMaterialMovement` → `schema.prisma:L1967`
- `Recipe` → `schema.prisma:L1682`
- `RecipeLine` → `schema.prisma:L1706`
- `Referral` → `schema.prisma:L5488`
- `ReferralProgramConfig` → `schema.prisma:L5453`
- `ReferralRewardGrant` → `schema.prisma:L5579`
- `ReferralTierReward` → `schema.prisma:L5551`
- `ReferralTierUnlock` → `schema.prisma:L5624`
- `Reservation` → `schema.prisma:L9566`
- `ReservationGoogleEventMapping` → `schema.prisma:L10246`
- `ReservationModifier` → `schema.prisma:L9725`
- `ReservationReminderSent` → `schema.prisma:L9708`
- `ReservationSettings` → `schema.prisma:L9886`
- `ReservationWaitlistEntry` → `schema.prisma:L9854`
- `Review` → `schema.prisma:L3267`
- `SalesRetention` → `schema.prisma:L11890`
- `SaleVerification` → `schema.prisma:L3026`
- `ScheduledCommand` → `schema.prisma:L7470`
- `SerializedItem` → `schema.prisma:L8061`
- `SerializedItemCustodyEvent` → `schema.prisma:L8224`
- `ServiceCharge` → `schema.prisma:L5878`
- `SettlementConfiguration` → `schema.prisma:L4917`
- `SettlementConfirmation` → `schema.prisma:L5030`
- `SettlementIncident` → `schema.prisma:L4981`
- `SettlementSimulation` → `schema.prisma:L4952`
- `Shift` → `schema.prisma:L2258`
- `SimRegistrationRequest` → `schema.prisma:L8262`
- `SimRegistrationRequestItem` → `schema.prisma:L8284`
- `SlotHold` → `schema.prisma:L9765`
- `Staff` → `schema.prisma:L772`
- `StaffOnboardingState` → `schema.prisma:L11129`
- `StaffOrganization` → `schema.prisma:L1013`
- `StaffPasskey` → `schema.prisma:L1040`
- `StaffVenue` → `schema.prisma:L948`
- `StockAlertConfig` → `schema.prisma:L8905`
- `StockBatch` → `schema.prisma:L2098`
- `StockCount` → `schema.prisma:L2035`
- `StockCountItem` → `schema.prisma:L2056`
- `StripeWebhookEvent` → `schema.prisma:L4564`
- `Supplier` → `schema.prisma:L1741`
- `SupplierPricing` → `schema.prisma:L1794`
- `Table` → `schema.prisma:L2170`
- `Terminal` → `schema.prisma:L3318`
- `TerminalHealth` → `schema.prisma:L3464`
- `TerminalLog` → `schema.prisma:L3438`
- `TerminalOrder` → `schema.prisma:L3591`
- `TerminalOrderItem` → `schema.prisma:L3666`
- `TerminalPaymentRequest` → `schema.prisma:L3535`
- `TimeEntry` → `schema.prisma:L2323`
- `TimeEntryBreak` → `schema.prisma:L2392`
- `TokenPurchase` → `schema.prisma:L7144`
- `TokenUsageRecord` → `schema.prisma:L7116`
- `TpvCommandHistory` → `schema.prisma:L7376`
- `TpvCommandQueue` → `schema.prisma:L7316`
- `TpvFeedback` → `schema.prisma:L7029`
- `TpvMessage` → `schema.prisma:L9262`
- `TpvMessageDelivery` → `schema.prisma:L9314`
- `TpvMessageResponse` → `schema.prisma:L9337`
- `TrainingModule` → `schema.prisma:L9392`
- `TrainingProgress` → `schema.prisma:L9469`
- `TrainingQuizQuestion` → `schema.prisma:L9451`
- `TrainingStep` → `schema.prisma:L9431`
- `TransactionCost` → `schema.prisma:L4780`
- `UnitConversion` → `schema.prisma:L1945`
- `user_sessions` → `schema.prisma:L4168`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L643`
- `VenueChatSession` → `schema.prisma:L598`
- `VenueCommission` → `schema.prisma:L10909`
- `VenueCreditAssessment` → `schema.prisma:L7806`
- `VenueCryptoConfig` → `schema.prisma:L9129`
- `VenueFeature` → `schema.prisma:L3140`
- `VenueModule` → `schema.prisma:L7962`
- `VenuePaymentConfig` → `schema.prisma:L4269`
- `VenuePaymentLinkSettings` → `schema.prisma:L10279`
- `VenuePricingStructure` → `schema.prisma:L4720`
- `VenueRoleConfig` → `schema.prisma:L1128`
- `VenueRolePermission` → `schema.prisma:L1070`
- `VenueSettings` → `schema.prisma:L683`
- `VenueTransaction` → `schema.prisma:L3077`
- `VenueWhatsappActivation` → `schema.prisma:L534`
- `WebhookEvent` → `schema.prisma:L3176`
- `WebhookSubscription` → `schema.prisma:L4385`
- `WhatsappContactWindow` → `schema.prisma:L552`
- `WhatsappInboundEvent` → `schema.prisma:L572`
- `Zone` → `schema.prisma:L96`
