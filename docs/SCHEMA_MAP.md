# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **245 models / 231 enums / ~11,500 lines**. Nobody reads it top to bottom. This file is the **index**: 20 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 20 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                     |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `OAuthState`, `PermissionSet`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                                          |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                  |
| 6   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `Inventory`, `InventoryMovement`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                                                                                                                                                                                                   |
| 7   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderItem`, `OrderItemModifier`, `Shift`                                                                                                                                                                                                                                                                                                                                                                        |
| 9   | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 10  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig` |
| 11  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 12  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`                                                                                                                                                                                                                                                                                                                     |
| 13  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 14  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig`                                                                                                                                                                                                                                                                                                                                                  |
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

- `AccountingPeriodLock` → `schema.prisma:L10977`
- `AccountMapping` → `schema.prisma:L10877`
- `ActivityLog` → `schema.prisma:L4864`
- `Aggregator` → `schema.prisma:L10227`
- `AngelPayUserAccount` → `schema.prisma:L3673`
- `AppUpdate` → `schema.prisma:L8513`
- `Area` → `schema.prisma:L2079`
- `BankStatement` → `schema.prisma:L10751`
- `BankStatementLine` → `schema.prisma:L10772`
- `BillingTaxProfile` → `schema.prisma:L11466`
- `BulkCommandOperation` → `schema.prisma:L6873`
- `CalendarSyncOutbox` → `schema.prisma:L9630`
- `CampaignDelivery` → `schema.prisma:L8671`
- `CashCloseout` → `schema.prisma:L7206`
- `CashDeposit` → `schema.prisma:L8322`
- `CashDrawerEvent` → `schema.prisma:L10073`
- `CashDrawerSession` → `schema.prisma:L10049`
- `CashOutCommissionRate` → `schema.prisma:L11295`
- `CashOutScheduleDay` → `schema.prisma:L11318`
- `CashOutWithdrawal` → `schema.prisma:L11380`
- `Cfdi` → `schema.prisma:L10654`
- `ChatbotTokenBudget` → `schema.prisma:L6521`
- `ChatConversation` → `schema.prisma:L6376`
- `ChatFeedback` → `schema.prisma:L6462`
- `ChatLearningEvent` → `schema.prisma:L6419`
- `ChatMessage` → `schema.prisma:L6399`
- `ChatTrainingData` → `schema.prisma:L6333`
- `CheckoutSession` → `schema.prisma:L3953`
- `ClassSession` → `schema.prisma:L9251`
- `CommissionCalculation` → `schema.prisma:L8101`
- `CommissionClawback` → `schema.prisma:L8274`
- `CommissionConfig` → `schema.prisma:L7874`
- `CommissionMilestone` → `schema.prisma:L8017`
- `CommissionOverride` → `schema.prisma:L7944`
- `CommissionPayout` → `schema.prisma:L8225`
- `CommissionSummary` → `schema.prisma:L8164`
- `CommissionTier` → `schema.prisma:L7981`
- `Consumer` → `schema.prisma:L4982`
- `ConsumerAuthAccount` → `schema.prisma:L5007`
- `CouponCode` → `schema.prisma:L5301`
- `CouponRedemption` → `schema.prisma:L5332`
- `CreditAssessmentHistory` → `schema.prisma:L7315`
- `CreditItemBalance` → `schema.prisma:L9839`
- `CreditOffer` → `schema.prisma:L7334`
- `CreditPack` → `schema.prisma:L9755`
- `CreditPackItem` → `schema.prisma:L9784`
- `CreditPackPurchase` → `schema.prisma:L9801`
- `CreditTransaction` → `schema.prisma:L9861`
- `Customer` → `schema.prisma:L4890`
- `CustomerDiscount` → `schema.prisma:L5352`
- `CustomerGroup` → `schema.prisma:L5041`
- `CustomerTaxProfile` → `schema.prisma:L10723`
- `DeviceToken` → `schema.prisma:L5547`
- `DigitalReceipt` → `schema.prisma:L2853`
- `Discount` → `schema.prisma:L5202`
- `EcommerceMerchant` → `schema.prisma:L3765`
- `EmailTemplate` → `schema.prisma:L8610`
- `Employee` → `schema.prisma:L11143`
- `Estimate` → `schema.prisma:L10134`
- `EstimateItem` → `schema.prisma:L10162`
- `Expense` → `schema.prisma:L11020`
- `ExternalBusyBlock` → `schema.prisma:L9523`
- `Feature` → `schema.prisma:L2982`
- `FeeSchedule` → `schema.prisma:L3060`
- `FeeTier` → `schema.prisma:L3071`
- `FinancialAccount` → `schema.prisma:L10316`
- `FinancialConnection` → `schema.prisma:L10288`
- `FinancialProvider` → `schema.prisma:L10274`
- `FiscalEmisor` → `schema.prisma:L10596`
- `FloorElement` → `schema.prisma:L2155`
- `GeofenceRule` → `schema.prisma:L6958`
- `GoogleCalendarChannel` → `schema.prisma:L9500`
- `GoogleCalendarConnection` → `schema.prisma:L9452`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9553`
- `GoogleOAuthSession` → `schema.prisma:L9575`
- `HolidayCalendar` → `schema.prisma:L4788`
- `IdempotencyRequest` → `schema.prisma:L7749`
- `Inventory` → `schema.prisma:L1510`
- `InventoryMovement` → `schema.prisma:L1534`
- `InventoryTransfer` → `schema.prisma:L10106`
- `Invitation` → `schema.prisma:L1114`
- `Invoice` → `schema.prisma:L3083`
- `InvoiceItem` → `schema.prisma:L3109`
- `ItemCategory` → `schema.prisma:L7466`
- `JournalEntry` → `schema.prisma:L10931`
- `JournalLine` → `schema.prisma:L10959`
- `KdsOrder` → `schema.prisma:L10360`
- `KdsOrderItem` → `schema.prisma:L10377`
- `LearnedPatterns` → `schema.prisma:L6443`
- `LedgerAccount` → `schema.prisma:L10827`
- `LiveDemoSession` → `schema.prisma:L649`
- `LowStockAlert` → `schema.prisma:L1950`
- `LoyaltyConfig` → `schema.prisma:L5071`
- `LoyaltyTransaction` → `schema.prisma:L5094`
- `MarketingCampaign` → `schema.prisma:L8628`
- `McpAuthCode` → `schema.prisma:L10503`
- `McpOAuthClient` → `schema.prisma:L10487`
- `McpRefreshToken` → `schema.prisma:L10521`
- `MeasurementUnit` → `schema.prisma:L10212`
- `Menu` → `schema.prisma:L1295`
- `MenuCategory` → `schema.prisma:L1237`
- `MenuCategoryAssignment` → `schema.prisma:L1330`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10436`
- `MerchantAccount` → `schema.prisma:L3543`
- `MerchantFiscalConfig` → `schema.prisma:L10632`
- `MerchantRevenueShare` → `schema.prisma:L4368`
- `MilestoneAchievement` → `schema.prisma:L8062`
- `Modifier` → `schema.prisma:L2600`
- `ModifierGroup` → `schema.prisma:L2564`
- `Module` → `schema.prisma:L7382`
- `MoneyAnomaly` → `schema.prisma:L4271`
- `MonthlyVenueProfit` → `schema.prisma:L4814`
- `Notification` → `schema.prisma:L5449`
- `NotificationPreference` → `schema.prisma:L5496`
- `NotificationTemplate` → `schema.prisma:L5523`
- `OAuthState` → `schema.prisma:L1165`
- `OnboardingProgress` → `schema.prisma:L1183`
- `Order` → `schema.prisma:L2342`
- `OrderAction` → `schema.prisma:L2665`
- `OrderCustomer` → `schema.prisma:L2469`
- `OrderDiscount` → `schema.prisma:L5384`
- `OrderItem` → `schema.prisma:L2485`
- `OrderItemModifier` → `schema.prisma:L2649`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8436`
- `OrganizationGoal` → `schema.prisma:L8394`
- `OrganizationModule` → `schema.prisma:L7438`
- `OrganizationPaymentConfig` → `schema.prisma:L4077`
- `OrganizationPayoutConfig` → `schema.prisma:L8462`
- `OrganizationPricingStructure` → `schema.prisma:L4109`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8417`
- `OtpChallenge` → `schema.prisma:L5026`
- `PartnerAPIKey` → `schema.prisma:L3907`
- `Payment` → `schema.prisma:L2698`
- `PaymentAllocation` → `schema.prisma:L2832`
- `PaymentLink` → `schema.prisma:L9907`
- `PaymentLinkAttribution` → `schema.prisma:L10015`
- `PaymentLinkItem` → `schema.prisma:L9970`
- `PaymentLinkItemModifier` → `schema.prisma:L9997`
- `PaymentProvider` → `schema.prisma:L3502`
- `PayrollLine` → `schema.prisma:L11214`
- `PayrollRun` → `schema.prisma:L11183`
- `PerformanceGoal` → `schema.prisma:L8371`
- `PermissionSet` → `schema.prisma:L1065`
- `PlatformCfdi` → `schema.prisma:L11495`
- `PlatformEmisor` → `schema.prisma:L11439`
- `PlatformSettings` → `schema.prisma:L3884`
- `PosCommand` → `schema.prisma:L5577`
- `PosConnectionStatus` → `schema.prisma:L725`
- `PricingPolicy` → `schema.prisma:L1861`
- `ProcessedStripeEvent` → `schema.prisma:L4257`
- `ProcessorReliabilityMetric` → `schema.prisma:L4742`
- `Product` → `schema.prisma:L1348`
- `ProductModifierGroup` → `schema.prisma:L2637`
- `ProductOption` → `schema.prisma:L10189`
- `ProductOptionValue` → `schema.prisma:L10200`
- `PromoterBankAccount` → `schema.prisma:L11334`
- `PromoterCommissionEntry` → `schema.prisma:L11353`
- `ProviderCostStructure` → `schema.prisma:L4293`
- `ProviderEventLog` → `schema.prisma:L4186`
- `PurchaseOrder` → `schema.prisma:L1775`
- `PurchaseOrderItem` → `schema.prisma:L1832`
- `RateCorrectionBatch` → `schema.prisma:L4518`
- `RateCorrectionEntry` → `schema.prisma:L4560`
- `RawMaterial` → `schema.prisma:L1564`
- `RawMaterialMovement` → `schema.prisma:L1914`
- `Recipe` → `schema.prisma:L1629`
- `RecipeLine` → `schema.prisma:L1653`
- `Referral` → `schema.prisma:L5156`
- `ReferralProgramConfig` → `schema.prisma:L5123`
- `Reservation` → `schema.prisma:L9007`
- `ReservationGoogleEventMapping` → `schema.prisma:L9687`
- `ReservationModifier` → `schema.prisma:L9166`
- `ReservationReminderSent` → `schema.prisma:L9149`
- `ReservationSettings` → `schema.prisma:L9327`
- `ReservationWaitlistEntry` → `schema.prisma:L9295`
- `Review` → `schema.prisma:L3127`
- `SaleVerification` → `schema.prisma:L2886`
- `ScheduledCommand` → `schema.prisma:L6918`
- `SerializedItem` → `schema.prisma:L7509`
- `SerializedItemCustodyEvent` → `schema.prisma:L7672`
- `SettlementConfiguration` → `schema.prisma:L4593`
- `SettlementConfirmation` → `schema.prisma:L4706`
- `SettlementIncident` → `schema.prisma:L4657`
- `SettlementSimulation` → `schema.prisma:L4628`
- `Shift` → `schema.prisma:L2193`
- `SimRegistrationRequest` → `schema.prisma:L7710`
- `SimRegistrationRequestItem` → `schema.prisma:L7732`
- `SlotHold` → `schema.prisma:L9206`
- `Staff` → `schema.prisma:L745`
- `StaffOnboardingState` → `schema.prisma:L10406`
- `StaffOrganization` → `schema.prisma:L979`
- `StaffPasskey` → `schema.prisma:L1006`
- `StaffVenue` → `schema.prisma:L915`
- `StockAlertConfig` → `schema.prisma:L8353`
- `StockBatch` → `schema.prisma:L2033`
- `StockCount` → `schema.prisma:L1982`
- `StockCountItem` → `schema.prisma:L2003`
- `StripeWebhookEvent` → `schema.prisma:L4240`
- `Supplier` → `schema.prisma:L1688`
- `SupplierPricing` → `schema.prisma:L1741`
- `Table` → `schema.prisma:L2105`
- `Terminal` → `schema.prisma:L3178`
- `TerminalHealth` → `schema.prisma:L3322`
- `TerminalLog` → `schema.prisma:L3296`
- `TerminalOrder` → `schema.prisma:L3405`
- `TerminalOrderItem` → `schema.prisma:L3480`
- `TimeEntry` → `schema.prisma:L2258`
- `TimeEntryBreak` → `schema.prisma:L2327`
- `TokenPurchase` → `schema.prisma:L6592`
- `TokenUsageRecord` → `schema.prisma:L6564`
- `TpvCommandHistory` → `schema.prisma:L6824`
- `TpvCommandQueue` → `schema.prisma:L6764`
- `TpvFeedback` → `schema.prisma:L6477`
- `TpvMessage` → `schema.prisma:L8703`
- `TpvMessageDelivery` → `schema.prisma:L8755`
- `TpvMessageResponse` → `schema.prisma:L8778`
- `TrainingModule` → `schema.prisma:L8833`
- `TrainingProgress` → `schema.prisma:L8910`
- `TrainingQuizQuestion` → `schema.prisma:L8892`
- `TrainingStep` → `schema.prisma:L8872`
- `TransactionCost` → `schema.prisma:L4456`
- `UnitConversion` → `schema.prisma:L1892`
- `user_sessions` → `schema.prisma:L3942`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L625`
- `VenueChatSession` → `schema.prisma:L580`
- `VenueCommission` → `schema.prisma:L10338`
- `VenueCreditAssessment` → `schema.prisma:L7254`
- `VenueCryptoConfig` → `schema.prisma:L8570`
- `VenueFeature` → `schema.prisma:L3000`
- `VenueModule` → `schema.prisma:L7410`
- `VenuePaymentConfig` → `schema.prisma:L4043`
- `VenuePaymentLinkSettings` → `schema.prisma:L9720`
- `VenuePricingStructure` → `schema.prisma:L4396`
- `VenueRoleConfig` → `schema.prisma:L1094`
- `VenueRolePermission` → `schema.prisma:L1036`
- `VenueSettings` → `schema.prisma:L665`
- `VenueTransaction` → `schema.prisma:L2937`
- `VenueWhatsappActivation` → `schema.prisma:L516`
- `WebhookEvent` → `schema.prisma:L3036`
- `WebhookSubscription` → `schema.prisma:L4159`
- `WhatsappContactWindow` → `schema.prisma:L534`
- `WhatsappInboundEvent` → `schema.prisma:L554`
- `Zone` → `schema.prisma:L96`
