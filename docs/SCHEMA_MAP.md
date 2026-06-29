# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **242 models / 227 enums / ~11,400 lines**. Nobody reads it top to bottom. This file is the **index**: 20 domains,
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
| 12  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`                                                                                                                                                                                                                                                     |
| 13  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                             |
| 14  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig`                                                                                                                                                                                                                                                                                  |
| 15  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                              |
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

- `AccountingPeriodLock` → `schema.prisma:L10877`
- `AccountMapping` → `schema.prisma:L10777`
- `ActivityLog` → `schema.prisma:L4857`
- `Aggregator` → `schema.prisma:L10220`
- `AngelPayUserAccount` → `schema.prisma:L3666`
- `AppUpdate` → `schema.prisma:L8506`
- `Area` → `schema.prisma:L2076`
- `BankStatement` → `schema.prisma:L10651`
- `BankStatementLine` → `schema.prisma:L10672`
- `BillingTaxProfile` → `schema.prisma:L11366`
- `BulkCommandOperation` → `schema.prisma:L6866`
- `CalendarSyncOutbox` → `schema.prisma:L9623`
- `CampaignDelivery` → `schema.prisma:L8664`
- `CashCloseout` → `schema.prisma:L7199`
- `CashDeposit` → `schema.prisma:L8315`
- `CashDrawerEvent` → `schema.prisma:L10066`
- `CashDrawerSession` → `schema.prisma:L10042`
- `CashOutCommissionRate` → `schema.prisma:L11195`
- `CashOutScheduleDay` → `schema.prisma:L11218`
- `CashOutWithdrawal` → `schema.prisma:L11280`
- `Cfdi` → `schema.prisma:L10554`
- `ChatbotTokenBudget` → `schema.prisma:L6514`
- `ChatConversation` → `schema.prisma:L6369`
- `ChatFeedback` → `schema.prisma:L6455`
- `ChatLearningEvent` → `schema.prisma:L6412`
- `ChatMessage` → `schema.prisma:L6392`
- `ChatTrainingData` → `schema.prisma:L6326`
- `CheckoutSession` → `schema.prisma:L3946`
- `ClassSession` → `schema.prisma:L9244`
- `CommissionCalculation` → `schema.prisma:L8094`
- `CommissionClawback` → `schema.prisma:L8267`
- `CommissionConfig` → `schema.prisma:L7867`
- `CommissionMilestone` → `schema.prisma:L8010`
- `CommissionOverride` → `schema.prisma:L7937`
- `CommissionPayout` → `schema.prisma:L8218`
- `CommissionSummary` → `schema.prisma:L8157`
- `CommissionTier` → `schema.prisma:L7974`
- `Consumer` → `schema.prisma:L4975`
- `ConsumerAuthAccount` → `schema.prisma:L5000`
- `CouponCode` → `schema.prisma:L5294`
- `CouponRedemption` → `schema.prisma:L5325`
- `CreditAssessmentHistory` → `schema.prisma:L7308`
- `CreditItemBalance` → `schema.prisma:L9832`
- `CreditOffer` → `schema.prisma:L7327`
- `CreditPack` → `schema.prisma:L9748`
- `CreditPackItem` → `schema.prisma:L9777`
- `CreditPackPurchase` → `schema.prisma:L9794`
- `CreditTransaction` → `schema.prisma:L9854`
- `Customer` → `schema.prisma:L4883`
- `CustomerDiscount` → `schema.prisma:L5345`
- `CustomerGroup` → `schema.prisma:L5034`
- `CustomerTaxProfile` → `schema.prisma:L10623`
- `DeviceToken` → `schema.prisma:L5540`
- `DigitalReceipt` → `schema.prisma:L2850`
- `Discount` → `schema.prisma:L5195`
- `EcommerceMerchant` → `schema.prisma:L3758`
- `EmailTemplate` → `schema.prisma:L8603`
- `Employee` → `schema.prisma:L11043`
- `Estimate` → `schema.prisma:L10127`
- `EstimateItem` → `schema.prisma:L10155`
- `Expense` → `schema.prisma:L10920`
- `ExternalBusyBlock` → `schema.prisma:L9516`
- `Feature` → `schema.prisma:L2979`
- `FeeSchedule` → `schema.prisma:L3057`
- `FeeTier` → `schema.prisma:L3068`
- `FiscalEmisor` → `schema.prisma:L10496`
- `FloorElement` → `schema.prisma:L2152`
- `GeofenceRule` → `schema.prisma:L6951`
- `GoogleCalendarChannel` → `schema.prisma:L9493`
- `GoogleCalendarConnection` → `schema.prisma:L9445`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9546`
- `GoogleOAuthSession` → `schema.prisma:L9568`
- `HolidayCalendar` → `schema.prisma:L4781`
- `IdempotencyRequest` → `schema.prisma:L7742`
- `Inventory` → `schema.prisma:L1507`
- `InventoryMovement` → `schema.prisma:L1531`
- `InventoryTransfer` → `schema.prisma:L10099`
- `Invitation` → `schema.prisma:L1111`
- `Invoice` → `schema.prisma:L3080`
- `InvoiceItem` → `schema.prisma:L3106`
- `ItemCategory` → `schema.prisma:L7459`
- `JournalEntry` → `schema.prisma:L10831`
- `JournalLine` → `schema.prisma:L10859`
- `KdsOrder` → `schema.prisma:L10260`
- `KdsOrderItem` → `schema.prisma:L10277`
- `LearnedPatterns` → `schema.prisma:L6436`
- `LedgerAccount` → `schema.prisma:L10727`
- `LiveDemoSession` → `schema.prisma:L646`
- `LowStockAlert` → `schema.prisma:L1947`
- `LoyaltyConfig` → `schema.prisma:L5064`
- `LoyaltyTransaction` → `schema.prisma:L5087`
- `MarketingCampaign` → `schema.prisma:L8621`
- `McpAuthCode` → `schema.prisma:L10403`
- `McpOAuthClient` → `schema.prisma:L10387`
- `McpRefreshToken` → `schema.prisma:L10421`
- `MeasurementUnit` → `schema.prisma:L10205`
- `Menu` → `schema.prisma:L1292`
- `MenuCategory` → `schema.prisma:L1234`
- `MenuCategoryAssignment` → `schema.prisma:L1327`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10336`
- `MerchantAccount` → `schema.prisma:L3540`
- `MerchantFiscalConfig` → `schema.prisma:L10532`
- `MerchantRevenueShare` → `schema.prisma:L4361`
- `MilestoneAchievement` → `schema.prisma:L8055`
- `Modifier` → `schema.prisma:L2597`
- `ModifierGroup` → `schema.prisma:L2561`
- `Module` → `schema.prisma:L7375`
- `MoneyAnomaly` → `schema.prisma:L4264`
- `MonthlyVenueProfit` → `schema.prisma:L4807`
- `Notification` → `schema.prisma:L5442`
- `NotificationPreference` → `schema.prisma:L5489`
- `NotificationTemplate` → `schema.prisma:L5516`
- `OAuthState` → `schema.prisma:L1162`
- `OnboardingProgress` → `schema.prisma:L1180`
- `Order` → `schema.prisma:L2339`
- `OrderAction` → `schema.prisma:L2662`
- `OrderCustomer` → `schema.prisma:L2466`
- `OrderDiscount` → `schema.prisma:L5377`
- `OrderItem` → `schema.prisma:L2482`
- `OrderItemModifier` → `schema.prisma:L2646`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8429`
- `OrganizationGoal` → `schema.prisma:L8387`
- `OrganizationModule` → `schema.prisma:L7431`
- `OrganizationPaymentConfig` → `schema.prisma:L4070`
- `OrganizationPayoutConfig` → `schema.prisma:L8455`
- `OrganizationPricingStructure` → `schema.prisma:L4102`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8410`
- `OtpChallenge` → `schema.prisma:L5019`
- `PartnerAPIKey` → `schema.prisma:L3900`
- `Payment` → `schema.prisma:L2695`
- `PaymentAllocation` → `schema.prisma:L2829`
- `PaymentLink` → `schema.prisma:L9900`
- `PaymentLinkAttribution` → `schema.prisma:L10008`
- `PaymentLinkItem` → `schema.prisma:L9963`
- `PaymentLinkItemModifier` → `schema.prisma:L9990`
- `PaymentProvider` → `schema.prisma:L3499`
- `PayrollLine` → `schema.prisma:L11114`
- `PayrollRun` → `schema.prisma:L11083`
- `PerformanceGoal` → `schema.prisma:L8364`
- `PermissionSet` → `schema.prisma:L1062`
- `PlatformCfdi` → `schema.prisma:L11395`
- `PlatformEmisor` → `schema.prisma:L11339`
- `PlatformSettings` → `schema.prisma:L3877`
- `PosCommand` → `schema.prisma:L5570`
- `PosConnectionStatus` → `schema.prisma:L722`
- `PricingPolicy` → `schema.prisma:L1858`
- `ProcessedStripeEvent` → `schema.prisma:L4250`
- `ProcessorReliabilityMetric` → `schema.prisma:L4735`
- `Product` → `schema.prisma:L1345`
- `ProductModifierGroup` → `schema.prisma:L2634`
- `ProductOption` → `schema.prisma:L10182`
- `ProductOptionValue` → `schema.prisma:L10193`
- `PromoterBankAccount` → `schema.prisma:L11234`
- `PromoterCommissionEntry` → `schema.prisma:L11253`
- `ProviderCostStructure` → `schema.prisma:L4286`
- `ProviderEventLog` → `schema.prisma:L4179`
- `PurchaseOrder` → `schema.prisma:L1772`
- `PurchaseOrderItem` → `schema.prisma:L1829`
- `RateCorrectionBatch` → `schema.prisma:L4511`
- `RateCorrectionEntry` → `schema.prisma:L4553`
- `RawMaterial` → `schema.prisma:L1561`
- `RawMaterialMovement` → `schema.prisma:L1911`
- `Recipe` → `schema.prisma:L1626`
- `RecipeLine` → `schema.prisma:L1650`
- `Referral` → `schema.prisma:L5149`
- `ReferralProgramConfig` → `schema.prisma:L5116`
- `Reservation` → `schema.prisma:L9000`
- `ReservationGoogleEventMapping` → `schema.prisma:L9680`
- `ReservationModifier` → `schema.prisma:L9159`
- `ReservationReminderSent` → `schema.prisma:L9142`
- `ReservationSettings` → `schema.prisma:L9320`
- `ReservationWaitlistEntry` → `schema.prisma:L9288`
- `Review` → `schema.prisma:L3124`
- `SaleVerification` → `schema.prisma:L2883`
- `ScheduledCommand` → `schema.prisma:L6911`
- `SerializedItem` → `schema.prisma:L7502`
- `SerializedItemCustodyEvent` → `schema.prisma:L7665`
- `SettlementConfiguration` → `schema.prisma:L4586`
- `SettlementConfirmation` → `schema.prisma:L4699`
- `SettlementIncident` → `schema.prisma:L4650`
- `SettlementSimulation` → `schema.prisma:L4621`
- `Shift` → `schema.prisma:L2190`
- `SimRegistrationRequest` → `schema.prisma:L7703`
- `SimRegistrationRequestItem` → `schema.prisma:L7725`
- `SlotHold` → `schema.prisma:L9199`
- `Staff` → `schema.prisma:L742`
- `StaffOnboardingState` → `schema.prisma:L10306`
- `StaffOrganization` → `schema.prisma:L976`
- `StaffPasskey` → `schema.prisma:L1003`
- `StaffVenue` → `schema.prisma:L912`
- `StockAlertConfig` → `schema.prisma:L8346`
- `StockBatch` → `schema.prisma:L2030`
- `StockCount` → `schema.prisma:L1979`
- `StockCountItem` → `schema.prisma:L2000`
- `StripeWebhookEvent` → `schema.prisma:L4233`
- `Supplier` → `schema.prisma:L1685`
- `SupplierPricing` → `schema.prisma:L1738`
- `Table` → `schema.prisma:L2102`
- `Terminal` → `schema.prisma:L3175`
- `TerminalHealth` → `schema.prisma:L3319`
- `TerminalLog` → `schema.prisma:L3293`
- `TerminalOrder` → `schema.prisma:L3402`
- `TerminalOrderItem` → `schema.prisma:L3477`
- `TimeEntry` → `schema.prisma:L2255`
- `TimeEntryBreak` → `schema.prisma:L2324`
- `TokenPurchase` → `schema.prisma:L6585`
- `TokenUsageRecord` → `schema.prisma:L6557`
- `TpvCommandHistory` → `schema.prisma:L6817`
- `TpvCommandQueue` → `schema.prisma:L6757`
- `TpvFeedback` → `schema.prisma:L6470`
- `TpvMessage` → `schema.prisma:L8696`
- `TpvMessageDelivery` → `schema.prisma:L8748`
- `TpvMessageResponse` → `schema.prisma:L8771`
- `TrainingModule` → `schema.prisma:L8826`
- `TrainingProgress` → `schema.prisma:L8903`
- `TrainingQuizQuestion` → `schema.prisma:L8885`
- `TrainingStep` → `schema.prisma:L8865`
- `TransactionCost` → `schema.prisma:L4449`
- `UnitConversion` → `schema.prisma:L1889`
- `user_sessions` → `schema.prisma:L3935`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L622`
- `VenueChatSession` → `schema.prisma:L577`
- `VenueCommission` → `schema.prisma:L10238`
- `VenueCreditAssessment` → `schema.prisma:L7247`
- `VenueCryptoConfig` → `schema.prisma:L8563`
- `VenueFeature` → `schema.prisma:L2997`
- `VenueModule` → `schema.prisma:L7403`
- `VenuePaymentConfig` → `schema.prisma:L4036`
- `VenuePaymentLinkSettings` → `schema.prisma:L9713`
- `VenuePricingStructure` → `schema.prisma:L4389`
- `VenueRoleConfig` → `schema.prisma:L1091`
- `VenueRolePermission` → `schema.prisma:L1033`
- `VenueSettings` → `schema.prisma:L662`
- `VenueTransaction` → `schema.prisma:L2934`
- `VenueWhatsappActivation` → `schema.prisma:L513`
- `WebhookEvent` → `schema.prisma:L3033`
- `WebhookSubscription` → `schema.prisma:L4152`
- `WhatsappContactWindow` → `schema.prisma:L531`
- `WhatsappInboundEvent` → `schema.prisma:L551`
- `Zone` → `schema.prisma:L96`
