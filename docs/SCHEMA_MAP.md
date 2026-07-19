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

- `AccountingPeriodLock` → `schema.prisma:L11750`
- `AccountMapping` → `schema.prisma:L11646`
- `ActivityLog` → `schema.prisma:L5196`
- `Aggregator` → `schema.prisma:L10794`
- `AngelPayUserAccount` → `schema.prisma:L3905`
- `AppUpdate` → `schema.prisma:L9080`
- `Area` → `schema.prisma:L2150`
- `BankStatement` → `schema.prisma:L11520`
- `BankStatementLine` → `schema.prisma:L11541`
- `BillingTaxProfile` → `schema.prisma:L12330`
- `BulkCommandOperation` → `schema.prisma:L7433`
- `CalendarSyncOutbox` → `schema.prisma:L10197`
- `CampaignDelivery` → `schema.prisma:L9238`
- `CashCloseout` → `schema.prisma:L7766`
- `CashDeposit` → `schema.prisma:L8882`
- `CashDrawerEvent` → `schema.prisma:L10640`
- `CashDrawerSession` → `schema.prisma:L10616`
- `CashOutCommissionRate` → `schema.prisma:L12159`
- `CashOutScheduleDay` → `schema.prisma:L12182`
- `CashOutWithdrawal` → `schema.prisma:L12244`
- `Cfdi` → `schema.prisma:L11423`
- `ChatbotTokenBudget` → `schema.prisma:L7081`
- `ChatConversation` → `schema.prisma:L6936`
- `ChatFeedback` → `schema.prisma:L7022`
- `ChatLearningEvent` → `schema.prisma:L6979`
- `ChatMessage` → `schema.prisma:L6959`
- `ChatTrainingData` → `schema.prisma:L6893`
- `CheckoutSession` → `schema.prisma:L4185`
- `ClassSession` → `schema.prisma:L9818`
- `CommissionCalculation` → `schema.prisma:L8661`
- `CommissionClawback` → `schema.prisma:L8834`
- `CommissionConfig` → `schema.prisma:L8434`
- `CommissionMilestone` → `schema.prisma:L8577`
- `CommissionOverride` → `schema.prisma:L8504`
- `CommissionPayout` → `schema.prisma:L8785`
- `CommissionSummary` → `schema.prisma:L8724`
- `CommissionTier` → `schema.prisma:L8541`
- `Consumer` → `schema.prisma:L5317`
- `ConsumerAuthAccount` → `schema.prisma:L5342`
- `CouponCode` → `schema.prisma:L5748`
- `CouponRedemption` → `schema.prisma:L5779`
- `CreditAssessmentHistory` → `schema.prisma:L7875`
- `CreditItemBalance` → `schema.prisma:L10406`
- `CreditOffer` → `schema.prisma:L7894`
- `CreditPack` → `schema.prisma:L10322`
- `CreditPackItem` → `schema.prisma:L10351`
- `CreditPackPurchase` → `schema.prisma:L10368`
- `CreditTransaction` → `schema.prisma:L10428`
- `Customer` → `schema.prisma:L5222`
- `CustomerDiscount` → `schema.prisma:L5799`
- `CustomerGroup` → `schema.prisma:L5376`
- `CustomerTaxProfile` → `schema.prisma:L11492`
- `DeliveryActivationRequest` → `schema.prisma:L4507`
- `DeliveryChannelLink` → `schema.prisma:L4471`
- `DeliveryOrderEvent` → `schema.prisma:L4531`
- `DeviceToken` → `schema.prisma:L6068`
- `DigitalReceipt` → `schema.prisma:L2999`
- `Discount` → `schema.prisma:L5648`
- `EcommerceMerchant` → `schema.prisma:L3997`
- `EmailTemplate` → `schema.prisma:L9177`
- `Employee` → `schema.prisma:L12007`
- `Estimate` → `schema.prisma:L10701`
- `EstimateItem` → `schema.prisma:L10729`
- `Expense` → `schema.prisma:L11794`
- `ExternalBusyBlock` → `schema.prisma:L10090`
- `Feature` → `schema.prisma:L3128`
- `FeeSchedule` → `schema.prisma:L3206`
- `FeeTier` → `schema.prisma:L3217`
- `FinancialAccount` → `schema.prisma:L10891`
- `FinancialConnection` → `schema.prisma:L10860`
- `FinancialProvider` → `schema.prisma:L10846`
- `FiscalEmisor` → `schema.prisma:L11346`
- `FiscalLossCarryforward` → `schema.prisma:L11917`
- `FixedAsset` → `schema.prisma:L11935`
- `FixedAssetDepreciation` → `schema.prisma:L11964`
- `FloorElement` → `schema.prisma:L2226`
- `GeofenceRule` → `schema.prisma:L7518`
- `GoogleCalendarChannel` → `schema.prisma:L10067`
- `GoogleCalendarConnection` → `schema.prisma:L10019`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L10120`
- `GoogleOAuthSession` → `schema.prisma:L10142`
- `HolidayCalendar` → `schema.prisma:L5120`
- `IdempotencyRequest` → `schema.prisma:L8309`
- `Inventory` → `schema.prisma:L1562`
- `InventoryMovement` → `schema.prisma:L1589`
- `InventoryTransfer` → `schema.prisma:L10673`
- `Invitation` → `schema.prisma:L1148`
- `Invoice` → `schema.prisma:L3229`
- `InvoiceItem` → `schema.prisma:L3255`
- `ItemCategory` → `schema.prisma:L8026`
- `JournalEntry` → `schema.prisma:L11704`
- `JournalLine` → `schema.prisma:L11732`
- `KdsOrder` → `schema.prisma:L10939`
- `KdsOrderItem` → `schema.prisma:L10956`
- `LearnedPatterns` → `schema.prisma:L7003`
- `LedgerAccount` → `schema.prisma:L11596`
- `LiveDemoSession` → `schema.prisma:L667`
- `LowStockAlert` → `schema.prisma:L2009`
- `LoyaltyConfig` → `schema.prisma:L5406`
- `LoyaltyTransaction` → `schema.prisma:L5429`
- `MarketingCampaign` → `schema.prisma:L9195`
- `McpAuthCode` → `schema.prisma:L11253`
- `McpOAuthClient` → `schema.prisma:L11237`
- `McpRefreshToken` → `schema.prisma:L11271`
- `MeasurementUnit` → `schema.prisma:L10779`
- `Menu` → `schema.prisma:L1334`
- `MenuCategory` → `schema.prisma:L1271`
- `MenuCategoryAssignment` → `schema.prisma:L1369`
- `MercadoPagoWebhookEvent` → `schema.prisma:L11167`
- `MerchantAccount` → `schema.prisma:L3735`
- `MerchantFiscalConfig` → `schema.prisma:L11394`
- `MerchantRevenueShare` → `schema.prisma:L4700`
- `MerchantRoutingRule` → `schema.prisma:L3857`
- `MilestoneAchievement` → `schema.prisma:L8622`
- `Modifier` → `schema.prisma:L2741`
- `ModifierGroup` → `schema.prisma:L2705`
- `Module` → `schema.prisma:L7942`
- `MoneyAnomaly` → `schema.prisma:L4603`
- `MonthlyVenueProfit` → `schema.prisma:L5146`
- `Notification` → `schema.prisma:L5970`
- `NotificationPreference` → `schema.prisma:L6017`
- `NotificationTemplate` → `schema.prisma:L6044`
- `OAuthState` → `schema.prisma:L1199`
- `OnboardingProgress` → `schema.prisma:L1217`
- `Order` → `schema.prisma:L2450`
- `OrderAction` → `schema.prisma:L2806`
- `OrderCustomer` → `schema.prisma:L2586`
- `OrderDiscount` → `schema.prisma:L5831`
- `OrderItem` → `schema.prisma:L2602`
- `OrderItemModifier` → `schema.prisma:L2790`
- `OrderServiceCharge` → `schema.prisma:L5915`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8996`
- `OrganizationGoal` → `schema.prisma:L8954`
- `OrganizationModule` → `schema.prisma:L7998`
- `OrganizationPaymentConfig` → `schema.prisma:L4309`
- `OrganizationPayoutConfig` → `schema.prisma:L9029`
- `OrganizationPricingStructure` → `schema.prisma:L4341`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8977`
- `OtpChallenge` → `schema.prisma:L5361`
- `PartnerAPIKey` → `schema.prisma:L4139`
- `Payment` → `schema.prisma:L2839`
- `PaymentAllocation` → `schema.prisma:L2978`
- `PaymentLink` → `schema.prisma:L10474`
- `PaymentLinkAttribution` → `schema.prisma:L10582`
- `PaymentLinkItem` → `schema.prisma:L10537`
- `PaymentLinkItemModifier` → `schema.prisma:L10564`
- `PaymentProvider` → `schema.prisma:L3694`
- `PayrollLine` → `schema.prisma:L12078`
- `PayrollRun` → `schema.prisma:L12047`
- `PerformanceGoal` → `schema.prisma:L8931`
- `PermissionSet` → `schema.prisma:L1099`
- `PlatformCfdi` → `schema.prisma:L12359`
- `PlatformEmisor` → `schema.prisma:L12303`
- `PlatformSettings` → `schema.prisma:L4116`
- `PosCommand` → `schema.prisma:L6098`
- `PosConnectionStatus` → `schema.prisma:L752`
- `PricingPolicy` → `schema.prisma:L1920`
- `Printer` → `schema.prisma:L10985`
- `PrintGateway` → `schema.prisma:L11022`
- `PrintJob` → `schema.prisma:L11069`
- `PrintStation` → `schema.prisma:L11040`
- `ProcessedStripeEvent` → `schema.prisma:L4589`
- `ProcessorReliabilityMetric` → `schema.prisma:L5074`
- `Product` → `schema.prisma:L1387`
- `ProductModifierGroup` → `schema.prisma:L2778`
- `ProductOption` → `schema.prisma:L10756`
- `ProductOptionValue` → `schema.prisma:L10767`
- `PromoterBankAccount` → `schema.prisma:L12198`
- `PromoterCommissionEntry` → `schema.prisma:L12217`
- `PromoterLocationPing` → `schema.prisma:L2416`
- `ProviderCostStructure` → `schema.prisma:L4625`
- `ProviderEventLog` → `schema.prisma:L4418`
- `PurchaseOrder` → `schema.prisma:L1834`
- `PurchaseOrderItem` → `schema.prisma:L1891`
- `RateCorrectionBatch` → `schema.prisma:L4850`
- `RateCorrectionEntry` → `schema.prisma:L4892`
- `RawMaterial` → `schema.prisma:L1622`
- `RawMaterialMovement` → `schema.prisma:L1973`
- `Recipe` → `schema.prisma:L1688`
- `RecipeLine` → `schema.prisma:L1712`
- `Referral` → `schema.prisma:L5496`
- `ReferralProgramConfig` → `schema.prisma:L5461`
- `ReferralRewardGrant` → `schema.prisma:L5587`
- `ReferralTierReward` → `schema.prisma:L5559`
- `ReferralTierUnlock` → `schema.prisma:L5632`
- `Reservation` → `schema.prisma:L9574`
- `ReservationGoogleEventMapping` → `schema.prisma:L10254`
- `ReservationModifier` → `schema.prisma:L9733`
- `ReservationReminderSent` → `schema.prisma:L9716`
- `ReservationSettings` → `schema.prisma:L9894`
- `ReservationWaitlistEntry` → `schema.prisma:L9862`
- `Review` → `schema.prisma:L3273`
- `SalesRetention` → `schema.prisma:L11898`
- `SaleVerification` → `schema.prisma:L3032`
- `ScheduledCommand` → `schema.prisma:L7478`
- `SerializedItem` → `schema.prisma:L8069`
- `SerializedItemCustodyEvent` → `schema.prisma:L8232`
- `ServiceCharge` → `schema.prisma:L5886`
- `SettlementConfiguration` → `schema.prisma:L4925`
- `SettlementConfirmation` → `schema.prisma:L5038`
- `SettlementIncident` → `schema.prisma:L4989`
- `SettlementSimulation` → `schema.prisma:L4960`
- `Shift` → `schema.prisma:L2264`
- `SimRegistrationRequest` → `schema.prisma:L8270`
- `SimRegistrationRequestItem` → `schema.prisma:L8292`
- `SlotHold` → `schema.prisma:L9773`
- `Staff` → `schema.prisma:L772`
- `StaffOnboardingState` → `schema.prisma:L11137`
- `StaffOrganization` → `schema.prisma:L1013`
- `StaffPasskey` → `schema.prisma:L1040`
- `StaffVenue` → `schema.prisma:L948`
- `StockAlertConfig` → `schema.prisma:L8913`
- `StockBatch` → `schema.prisma:L2104`
- `StockCount` → `schema.prisma:L2041`
- `StockCountItem` → `schema.prisma:L2062`
- `StripeWebhookEvent` → `schema.prisma:L4572`
- `Supplier` → `schema.prisma:L1747`
- `SupplierPricing` → `schema.prisma:L1800`
- `Table` → `schema.prisma:L2176`
- `Terminal` → `schema.prisma:L3324`
- `TerminalHealth` → `schema.prisma:L3470`
- `TerminalLog` → `schema.prisma:L3444`
- `TerminalOrder` → `schema.prisma:L3597`
- `TerminalOrderItem` → `schema.prisma:L3672`
- `TerminalPaymentRequest` → `schema.prisma:L3541`
- `TimeEntry` → `schema.prisma:L2329`
- `TimeEntryBreak` → `schema.prisma:L2398`
- `TokenPurchase` → `schema.prisma:L7152`
- `TokenUsageRecord` → `schema.prisma:L7124`
- `TpvCommandHistory` → `schema.prisma:L7384`
- `TpvCommandQueue` → `schema.prisma:L7324`
- `TpvFeedback` → `schema.prisma:L7037`
- `TpvMessage` → `schema.prisma:L9270`
- `TpvMessageDelivery` → `schema.prisma:L9322`
- `TpvMessageResponse` → `schema.prisma:L9345`
- `TrainingModule` → `schema.prisma:L9400`
- `TrainingProgress` → `schema.prisma:L9477`
- `TrainingQuizQuestion` → `schema.prisma:L9459`
- `TrainingStep` → `schema.prisma:L9439`
- `TransactionCost` → `schema.prisma:L4788`
- `UnitConversion` → `schema.prisma:L1951`
- `user_sessions` → `schema.prisma:L4174`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L643`
- `VenueChatSession` → `schema.prisma:L598`
- `VenueCommission` → `schema.prisma:L10917`
- `VenueCreditAssessment` → `schema.prisma:L7814`
- `VenueCryptoConfig` → `schema.prisma:L9137`
- `VenueFeature` → `schema.prisma:L3146`
- `VenueModule` → `schema.prisma:L7970`
- `VenuePaymentConfig` → `schema.prisma:L4275`
- `VenuePaymentLinkSettings` → `schema.prisma:L10287`
- `VenuePricingStructure` → `schema.prisma:L4728`
- `VenueRoleConfig` → `schema.prisma:L1128`
- `VenueRolePermission` → `schema.prisma:L1070`
- `VenueSettings` → `schema.prisma:L683`
- `VenueTransaction` → `schema.prisma:L3083`
- `VenueWhatsappActivation` → `schema.prisma:L534`
- `WebhookEvent` → `schema.prisma:L3182`
- `WebhookSubscription` → `schema.prisma:L4391`
- `WhatsappContactWindow` → `schema.prisma:L552`
- `WhatsappInboundEvent` → `schema.prisma:L572`
- `Zone` → `schema.prisma:L96`
