# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **249 models / 235 enums / ~11,700 lines**. Nobody reads it top to bottom. This file is the **index**: 20 domains,
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
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `OAuthState`, `PermissionSet`, `PromoterLocationPing`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                  |
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

- `AccountingPeriodLock` → `schema.prisma:L11135`
- `AccountMapping` → `schema.prisma:L11035`
- `ActivityLog` → `schema.prisma:L4906`
- `Aggregator` → `schema.prisma:L10362`
- `AngelPayUserAccount` → `schema.prisma:L3715`
- `AppUpdate` → `schema.prisma:L8648`
- `Area` → `schema.prisma:L2091`
- `BankStatement` → `schema.prisma:L10909`
- `BankStatementLine` → `schema.prisma:L10930`
- `BillingTaxProfile` → `schema.prisma:L11624`
- `BulkCommandOperation` → `schema.prisma:L7008`
- `CalendarSyncOutbox` → `schema.prisma:L9765`
- `CampaignDelivery` → `schema.prisma:L8806`
- `CashCloseout` → `schema.prisma:L7341`
- `CashDeposit` → `schema.prisma:L8457`
- `CashDrawerEvent` → `schema.prisma:L10208`
- `CashDrawerSession` → `schema.prisma:L10184`
- `CashOutCommissionRate` → `schema.prisma:L11453`
- `CashOutScheduleDay` → `schema.prisma:L11476`
- `CashOutWithdrawal` → `schema.prisma:L11538`
- `Cfdi` → `schema.prisma:L10812`
- `ChatbotTokenBudget` → `schema.prisma:L6656`
- `ChatConversation` → `schema.prisma:L6511`
- `ChatFeedback` → `schema.prisma:L6597`
- `ChatLearningEvent` → `schema.prisma:L6554`
- `ChatMessage` → `schema.prisma:L6534`
- `ChatTrainingData` → `schema.prisma:L6468`
- `CheckoutSession` → `schema.prisma:L3995`
- `ClassSession` → `schema.prisma:L9386`
- `CommissionCalculation` → `schema.prisma:L8236`
- `CommissionClawback` → `schema.prisma:L8409`
- `CommissionConfig` → `schema.prisma:L8009`
- `CommissionMilestone` → `schema.prisma:L8152`
- `CommissionOverride` → `schema.prisma:L8079`
- `CommissionPayout` → `schema.prisma:L8360`
- `CommissionSummary` → `schema.prisma:L8299`
- `CommissionTier` → `schema.prisma:L8116`
- `Consumer` → `schema.prisma:L5027`
- `ConsumerAuthAccount` → `schema.prisma:L5052`
- `CouponCode` → `schema.prisma:L5436`
- `CouponRedemption` → `schema.prisma:L5467`
- `CreditAssessmentHistory` → `schema.prisma:L7450`
- `CreditItemBalance` → `schema.prisma:L9974`
- `CreditOffer` → `schema.prisma:L7469`
- `CreditPack` → `schema.prisma:L9890`
- `CreditPackItem` → `schema.prisma:L9919`
- `CreditPackPurchase` → `schema.prisma:L9936`
- `CreditTransaction` → `schema.prisma:L9996`
- `Customer` → `schema.prisma:L4932`
- `CustomerDiscount` → `schema.prisma:L5487`
- `CustomerGroup` → `schema.prisma:L5086`
- `CustomerTaxProfile` → `schema.prisma:L10881`
- `DeviceToken` → `schema.prisma:L5682`
- `DigitalReceipt` → `schema.prisma:L2895`
- `Discount` → `schema.prisma:L5336`
- `EcommerceMerchant` → `schema.prisma:L3807`
- `EmailTemplate` → `schema.prisma:L8745`
- `Employee` → `schema.prisma:L11301`
- `Estimate` → `schema.prisma:L10269`
- `EstimateItem` → `schema.prisma:L10297`
- `Expense` → `schema.prisma:L11178`
- `ExternalBusyBlock` → `schema.prisma:L9658`
- `Feature` → `schema.prisma:L3024`
- `FeeSchedule` → `schema.prisma:L3102`
- `FeeTier` → `schema.prisma:L3113`
- `FinancialAccount` → `schema.prisma:L10451`
- `FinancialConnection` → `schema.prisma:L10423`
- `FinancialProvider` → `schema.prisma:L10409`
- `FiscalEmisor` → `schema.prisma:L10754`
- `FloorElement` → `schema.prisma:L2167`
- `GeofenceRule` → `schema.prisma:L7093`
- `GoogleCalendarChannel` → `schema.prisma:L9635`
- `GoogleCalendarConnection` → `schema.prisma:L9587`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9688`
- `GoogleOAuthSession` → `schema.prisma:L9710`
- `HolidayCalendar` → `schema.prisma:L4830`
- `IdempotencyRequest` → `schema.prisma:L7884`
- `Inventory` → `schema.prisma:L1522`
- `InventoryMovement` → `schema.prisma:L1546`
- `InventoryTransfer` → `schema.prisma:L10241`
- `Invitation` → `schema.prisma:L1123`
- `Invoice` → `schema.prisma:L3125`
- `InvoiceItem` → `schema.prisma:L3151`
- `ItemCategory` → `schema.prisma:L7601`
- `JournalEntry` → `schema.prisma:L11089`
- `JournalLine` → `schema.prisma:L11117`
- `KdsOrder` → `schema.prisma:L10499`
- `KdsOrderItem` → `schema.prisma:L10516`
- `LearnedPatterns` → `schema.prisma:L6578`
- `LedgerAccount` → `schema.prisma:L10985`
- `LiveDemoSession` → `schema.prisma:L651`
- `LowStockAlert` → `schema.prisma:L1962`
- `LoyaltyConfig` → `schema.prisma:L5116`
- `LoyaltyTransaction` → `schema.prisma:L5139`
- `MarketingCampaign` → `schema.prisma:L8763`
- `McpAuthCode` → `schema.prisma:L10661`
- `McpOAuthClient` → `schema.prisma:L10645`
- `McpRefreshToken` → `schema.prisma:L10679`
- `MeasurementUnit` → `schema.prisma:L10347`
- `Menu` → `schema.prisma:L1304`
- `MenuCategory` → `schema.prisma:L1246`
- `MenuCategoryAssignment` → `schema.prisma:L1339`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10575`
- `MerchantAccount` → `schema.prisma:L3585`
- `MerchantFiscalConfig` → `schema.prisma:L10790`
- `MerchantRevenueShare` → `schema.prisma:L4410`
- `MilestoneAchievement` → `schema.prisma:L8197`
- `Modifier` → `schema.prisma:L2642`
- `ModifierGroup` → `schema.prisma:L2606`
- `Module` → `schema.prisma:L7517`
- `MoneyAnomaly` → `schema.prisma:L4313`
- `MonthlyVenueProfit` → `schema.prisma:L4856`
- `Notification` → `schema.prisma:L5584`
- `NotificationPreference` → `schema.prisma:L5631`
- `NotificationTemplate` → `schema.prisma:L5658`
- `OAuthState` → `schema.prisma:L1174`
- `OnboardingProgress` → `schema.prisma:L1192`
- `Order` → `schema.prisma:L2384`
- `OrderAction` → `schema.prisma:L2707`
- `OrderCustomer` → `schema.prisma:L2511`
- `OrderDiscount` → `schema.prisma:L5519`
- `OrderItem` → `schema.prisma:L2527`
- `OrderItemModifier` → `schema.prisma:L2691`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8571`
- `OrganizationGoal` → `schema.prisma:L8529`
- `OrganizationModule` → `schema.prisma:L7573`
- `OrganizationPaymentConfig` → `schema.prisma:L4119`
- `OrganizationPayoutConfig` → `schema.prisma:L8597`
- `OrganizationPricingStructure` → `schema.prisma:L4151`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8552`
- `OtpChallenge` → `schema.prisma:L5071`
- `PartnerAPIKey` → `schema.prisma:L3949`
- `Payment` → `schema.prisma:L2740`
- `PaymentAllocation` → `schema.prisma:L2874`
- `PaymentLink` → `schema.prisma:L10042`
- `PaymentLinkAttribution` → `schema.prisma:L10150`
- `PaymentLinkItem` → `schema.prisma:L10105`
- `PaymentLinkItemModifier` → `schema.prisma:L10132`
- `PaymentProvider` → `schema.prisma:L3544`
- `PayrollLine` → `schema.prisma:L11372`
- `PayrollRun` → `schema.prisma:L11341`
- `PerformanceGoal` → `schema.prisma:L8506`
- `PermissionSet` → `schema.prisma:L1074`
- `PlatformCfdi` → `schema.prisma:L11653`
- `PlatformEmisor` → `schema.prisma:L11597`
- `PlatformSettings` → `schema.prisma:L3926`
- `PosCommand` → `schema.prisma:L5712`
- `PosConnectionStatus` → `schema.prisma:L731`
- `PricingPolicy` → `schema.prisma:L1873`
- `ProcessedStripeEvent` → `schema.prisma:L4299`
- `ProcessorReliabilityMetric` → `schema.prisma:L4784`
- `Product` → `schema.prisma:L1357`
- `ProductModifierGroup` → `schema.prisma:L2679`
- `ProductOption` → `schema.prisma:L10324`
- `ProductOptionValue` → `schema.prisma:L10335`
- `PromoterBankAccount` → `schema.prisma:L11492`
- `PromoterCommissionEntry` → `schema.prisma:L11511`
- `PromoterLocationPing` → `schema.prisma:L2357`
- `ProviderCostStructure` → `schema.prisma:L4335`
- `ProviderEventLog` → `schema.prisma:L4228`
- `PurchaseOrder` → `schema.prisma:L1787`
- `PurchaseOrderItem` → `schema.prisma:L1844`
- `RateCorrectionBatch` → `schema.prisma:L4560`
- `RateCorrectionEntry` → `schema.prisma:L4602`
- `RawMaterial` → `schema.prisma:L1576`
- `RawMaterialMovement` → `schema.prisma:L1926`
- `Recipe` → `schema.prisma:L1641`
- `RecipeLine` → `schema.prisma:L1665`
- `Referral` → `schema.prisma:L5203`
- `ReferralProgramConfig` → `schema.prisma:L5168`
- `ReferralRewardGrant` → `schema.prisma:L5275`
- `ReferralTierReward` → `schema.prisma:L5247`
- `ReferralTierUnlock` → `schema.prisma:L5320`
- `Reservation` → `schema.prisma:L9142`
- `ReservationGoogleEventMapping` → `schema.prisma:L9822`
- `ReservationModifier` → `schema.prisma:L9301`
- `ReservationReminderSent` → `schema.prisma:L9284`
- `ReservationSettings` → `schema.prisma:L9462`
- `ReservationWaitlistEntry` → `schema.prisma:L9430`
- `Review` → `schema.prisma:L3169`
- `SaleVerification` → `schema.prisma:L2928`
- `ScheduledCommand` → `schema.prisma:L7053`
- `SerializedItem` → `schema.prisma:L7644`
- `SerializedItemCustodyEvent` → `schema.prisma:L7807`
- `SettlementConfiguration` → `schema.prisma:L4635`
- `SettlementConfirmation` → `schema.prisma:L4748`
- `SettlementIncident` → `schema.prisma:L4699`
- `SettlementSimulation` → `schema.prisma:L4670`
- `Shift` → `schema.prisma:L2205`
- `SimRegistrationRequest` → `schema.prisma:L7845`
- `SimRegistrationRequestItem` → `schema.prisma:L7867`
- `SlotHold` → `schema.prisma:L9341`
- `Staff` → `schema.prisma:L751`
- `StaffOnboardingState` → `schema.prisma:L10545`
- `StaffOrganization` → `schema.prisma:L988`
- `StaffPasskey` → `schema.prisma:L1015`
- `StaffVenue` → `schema.prisma:L924`
- `StockAlertConfig` → `schema.prisma:L8488`
- `StockBatch` → `schema.prisma:L2045`
- `StockCount` → `schema.prisma:L1994`
- `StockCountItem` → `schema.prisma:L2015`
- `StripeWebhookEvent` → `schema.prisma:L4282`
- `Supplier` → `schema.prisma:L1700`
- `SupplierPricing` → `schema.prisma:L1753`
- `Table` → `schema.prisma:L2117`
- `Terminal` → `schema.prisma:L3220`
- `TerminalHealth` → `schema.prisma:L3364`
- `TerminalLog` → `schema.prisma:L3338`
- `TerminalOrder` → `schema.prisma:L3447`
- `TerminalOrderItem` → `schema.prisma:L3522`
- `TimeEntry` → `schema.prisma:L2270`
- `TimeEntryBreak` → `schema.prisma:L2339`
- `TokenPurchase` → `schema.prisma:L6727`
- `TokenUsageRecord` → `schema.prisma:L6699`
- `TpvCommandHistory` → `schema.prisma:L6959`
- `TpvCommandQueue` → `schema.prisma:L6899`
- `TpvFeedback` → `schema.prisma:L6612`
- `TpvMessage` → `schema.prisma:L8838`
- `TpvMessageDelivery` → `schema.prisma:L8890`
- `TpvMessageResponse` → `schema.prisma:L8913`
- `TrainingModule` → `schema.prisma:L8968`
- `TrainingProgress` → `schema.prisma:L9045`
- `TrainingQuizQuestion` → `schema.prisma:L9027`
- `TrainingStep` → `schema.prisma:L9007`
- `TransactionCost` → `schema.prisma:L4498`
- `UnitConversion` → `schema.prisma:L1904`
- `user_sessions` → `schema.prisma:L3984`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L627`
- `VenueChatSession` → `schema.prisma:L582`
- `VenueCommission` → `schema.prisma:L10477`
- `VenueCreditAssessment` → `schema.prisma:L7389`
- `VenueCryptoConfig` → `schema.prisma:L8705`
- `VenueFeature` → `schema.prisma:L3042`
- `VenueModule` → `schema.prisma:L7545`
- `VenuePaymentConfig` → `schema.prisma:L4085`
- `VenuePaymentLinkSettings` → `schema.prisma:L9855`
- `VenuePricingStructure` → `schema.prisma:L4438`
- `VenueRoleConfig` → `schema.prisma:L1103`
- `VenueRolePermission` → `schema.prisma:L1045`
- `VenueSettings` → `schema.prisma:L667`
- `VenueTransaction` → `schema.prisma:L2979`
- `VenueWhatsappActivation` → `schema.prisma:L518`
- `WebhookEvent` → `schema.prisma:L3078`
- `WebhookSubscription` → `schema.prisma:L4201`
- `WhatsappContactWindow` → `schema.prisma:L536`
- `WhatsappInboundEvent` → `schema.prisma:L556`
- `Zone` → `schema.prisma:L96`
