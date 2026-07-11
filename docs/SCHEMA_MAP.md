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

- `AccountingPeriodLock` → `schema.prisma:L11254`
- `AccountMapping` → `schema.prisma:L11150`
- `ActivityLog` → `schema.prisma:L4968`
- `Aggregator` → `schema.prisma:L10450`
- `AngelPayUserAccount` → `schema.prisma:L3777`
- `AppUpdate` → `schema.prisma:L8736`
- `Area` → `schema.prisma:L2099`
- `BankStatement` → `schema.prisma:L11024`
- `BankStatementLine` → `schema.prisma:L11045`
- `BillingTaxProfile` → `schema.prisma:L11834`
- `BulkCommandOperation` → `schema.prisma:L7089`
- `CalendarSyncOutbox` → `schema.prisma:L9853`
- `CampaignDelivery` → `schema.prisma:L8894`
- `CashCloseout` → `schema.prisma:L7422`
- `CashDeposit` → `schema.prisma:L8538`
- `CashDrawerEvent` → `schema.prisma:L10296`
- `CashDrawerSession` → `schema.prisma:L10272`
- `CashOutCommissionRate` → `schema.prisma:L11663`
- `CashOutScheduleDay` → `schema.prisma:L11686`
- `CashOutWithdrawal` → `schema.prisma:L11748`
- `Cfdi` → `schema.prisma:L10927`
- `ChatbotTokenBudget` → `schema.prisma:L6737`
- `ChatConversation` → `schema.prisma:L6592`
- `ChatFeedback` → `schema.prisma:L6678`
- `ChatLearningEvent` → `schema.prisma:L6635`
- `ChatMessage` → `schema.prisma:L6615`
- `ChatTrainingData` → `schema.prisma:L6549`
- `CheckoutSession` → `schema.prisma:L4057`
- `ClassSession` → `schema.prisma:L9474`
- `CommissionCalculation` → `schema.prisma:L8317`
- `CommissionClawback` → `schema.prisma:L8490`
- `CommissionConfig` → `schema.prisma:L8090`
- `CommissionMilestone` → `schema.prisma:L8233`
- `CommissionOverride` → `schema.prisma:L8160`
- `CommissionPayout` → `schema.prisma:L8441`
- `CommissionSummary` → `schema.prisma:L8380`
- `CommissionTier` → `schema.prisma:L8197`
- `Consumer` → `schema.prisma:L5089`
- `ConsumerAuthAccount` → `schema.prisma:L5114`
- `CouponCode` → `schema.prisma:L5517`
- `CouponRedemption` → `schema.prisma:L5548`
- `CreditAssessmentHistory` → `schema.prisma:L7531`
- `CreditItemBalance` → `schema.prisma:L10062`
- `CreditOffer` → `schema.prisma:L7550`
- `CreditPack` → `schema.prisma:L9978`
- `CreditPackItem` → `schema.prisma:L10007`
- `CreditPackPurchase` → `schema.prisma:L10024`
- `CreditTransaction` → `schema.prisma:L10084`
- `Customer` → `schema.prisma:L4994`
- `CustomerDiscount` → `schema.prisma:L5568`
- `CustomerGroup` → `schema.prisma:L5148`
- `CustomerTaxProfile` → `schema.prisma:L10996`
- `DeviceToken` → `schema.prisma:L5763`
- `DigitalReceipt` → `schema.prisma:L2915`
- `Discount` → `schema.prisma:L5417`
- `EcommerceMerchant` → `schema.prisma:L3869`
- `EmailTemplate` → `schema.prisma:L8833`
- `Employee` → `schema.prisma:L11511`
- `Estimate` → `schema.prisma:L10357`
- `EstimateItem` → `schema.prisma:L10385`
- `Expense` → `schema.prisma:L11298`
- `ExternalBusyBlock` → `schema.prisma:L9746`
- `Feature` → `schema.prisma:L3044`
- `FeeSchedule` → `schema.prisma:L3122`
- `FeeTier` → `schema.prisma:L3133`
- `FinancialAccount` → `schema.prisma:L10547`
- `FinancialConnection` → `schema.prisma:L10516`
- `FinancialProvider` → `schema.prisma:L10502`
- `FiscalEmisor` → `schema.prisma:L10850`
- `FiscalLossCarryforward` → `schema.prisma:L11421`
- `FixedAsset` → `schema.prisma:L11439`
- `FixedAssetDepreciation` → `schema.prisma:L11468`
- `FloorElement` → `schema.prisma:L2175`
- `GeofenceRule` → `schema.prisma:L7174`
- `GoogleCalendarChannel` → `schema.prisma:L9723`
- `GoogleCalendarConnection` → `schema.prisma:L9675`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9776`
- `GoogleOAuthSession` → `schema.prisma:L9798`
- `HolidayCalendar` → `schema.prisma:L4892`
- `IdempotencyRequest` → `schema.prisma:L7965`
- `Inventory` → `schema.prisma:L1530`
- `InventoryMovement` → `schema.prisma:L1554`
- `InventoryTransfer` → `schema.prisma:L10329`
- `Invitation` → `schema.prisma:L1131`
- `Invoice` → `schema.prisma:L3145`
- `InvoiceItem` → `schema.prisma:L3171`
- `ItemCategory` → `schema.prisma:L7682`
- `JournalEntry` → `schema.prisma:L11208`
- `JournalLine` → `schema.prisma:L11236`
- `KdsOrder` → `schema.prisma:L10595`
- `KdsOrderItem` → `schema.prisma:L10612`
- `LearnedPatterns` → `schema.prisma:L6659`
- `LedgerAccount` → `schema.prisma:L11100`
- `LiveDemoSession` → `schema.prisma:L654`
- `LowStockAlert` → `schema.prisma:L1970`
- `LoyaltyConfig` → `schema.prisma:L5178`
- `LoyaltyTransaction` → `schema.prisma:L5201`
- `MarketingCampaign` → `schema.prisma:L8851`
- `McpAuthCode` → `schema.prisma:L10757`
- `McpOAuthClient` → `schema.prisma:L10741`
- `McpRefreshToken` → `schema.prisma:L10775`
- `MeasurementUnit` → `schema.prisma:L10435`
- `Menu` → `schema.prisma:L1312`
- `MenuCategory` → `schema.prisma:L1254`
- `MenuCategoryAssignment` → `schema.prisma:L1347`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10671`
- `MerchantAccount` → `schema.prisma:L3607`
- `MerchantFiscalConfig` → `schema.prisma:L10898`
- `MerchantRevenueShare` → `schema.prisma:L4472`
- `MerchantRoutingRule` → `schema.prisma:L3729`
- `MilestoneAchievement` → `schema.prisma:L8278`
- `Modifier` → `schema.prisma:L2657`
- `ModifierGroup` → `schema.prisma:L2621`
- `Module` → `schema.prisma:L7598`
- `MoneyAnomaly` → `schema.prisma:L4375`
- `MonthlyVenueProfit` → `schema.prisma:L4918`
- `Notification` → `schema.prisma:L5665`
- `NotificationPreference` → `schema.prisma:L5712`
- `NotificationTemplate` → `schema.prisma:L5739`
- `OAuthState` → `schema.prisma:L1182`
- `OnboardingProgress` → `schema.prisma:L1200`
- `Order` → `schema.prisma:L2399`
- `OrderAction` → `schema.prisma:L2722`
- `OrderCustomer` → `schema.prisma:L2526`
- `OrderDiscount` → `schema.prisma:L5600`
- `OrderItem` → `schema.prisma:L2542`
- `OrderItemModifier` → `schema.prisma:L2706`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8652`
- `OrganizationGoal` → `schema.prisma:L8610`
- `OrganizationModule` → `schema.prisma:L7654`
- `OrganizationPaymentConfig` → `schema.prisma:L4181`
- `OrganizationPayoutConfig` → `schema.prisma:L8685`
- `OrganizationPricingStructure` → `schema.prisma:L4213`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8633`
- `OtpChallenge` → `schema.prisma:L5133`
- `PartnerAPIKey` → `schema.prisma:L4011`
- `Payment` → `schema.prisma:L2755`
- `PaymentAllocation` → `schema.prisma:L2894`
- `PaymentLink` → `schema.prisma:L10130`
- `PaymentLinkAttribution` → `schema.prisma:L10238`
- `PaymentLinkItem` → `schema.prisma:L10193`
- `PaymentLinkItemModifier` → `schema.prisma:L10220`
- `PaymentProvider` → `schema.prisma:L3566`
- `PayrollLine` → `schema.prisma:L11582`
- `PayrollRun` → `schema.prisma:L11551`
- `PerformanceGoal` → `schema.prisma:L8587`
- `PermissionSet` → `schema.prisma:L1082`
- `PlatformCfdi` → `schema.prisma:L11863`
- `PlatformEmisor` → `schema.prisma:L11807`
- `PlatformSettings` → `schema.prisma:L3988`
- `PosCommand` → `schema.prisma:L5793`
- `PosConnectionStatus` → `schema.prisma:L739`
- `PricingPolicy` → `schema.prisma:L1881`
- `ProcessedStripeEvent` → `schema.prisma:L4361`
- `ProcessorReliabilityMetric` → `schema.prisma:L4846`
- `Product` → `schema.prisma:L1365`
- `ProductModifierGroup` → `schema.prisma:L2694`
- `ProductOption` → `schema.prisma:L10412`
- `ProductOptionValue` → `schema.prisma:L10423`
- `PromoterBankAccount` → `schema.prisma:L11702`
- `PromoterCommissionEntry` → `schema.prisma:L11721`
- `PromoterLocationPing` → `schema.prisma:L2365`
- `ProviderCostStructure` → `schema.prisma:L4397`
- `ProviderEventLog` → `schema.prisma:L4290`
- `PurchaseOrder` → `schema.prisma:L1795`
- `PurchaseOrderItem` → `schema.prisma:L1852`
- `RateCorrectionBatch` → `schema.prisma:L4622`
- `RateCorrectionEntry` → `schema.prisma:L4664`
- `RawMaterial` → `schema.prisma:L1584`
- `RawMaterialMovement` → `schema.prisma:L1934`
- `Recipe` → `schema.prisma:L1649`
- `RecipeLine` → `schema.prisma:L1673`
- `Referral` → `schema.prisma:L5265`
- `ReferralProgramConfig` → `schema.prisma:L5230`
- `ReferralRewardGrant` → `schema.prisma:L5356`
- `ReferralTierReward` → `schema.prisma:L5328`
- `ReferralTierUnlock` → `schema.prisma:L5401`
- `Reservation` → `schema.prisma:L9230`
- `ReservationGoogleEventMapping` → `schema.prisma:L9910`
- `ReservationModifier` → `schema.prisma:L9389`
- `ReservationReminderSent` → `schema.prisma:L9372`
- `ReservationSettings` → `schema.prisma:L9550`
- `ReservationWaitlistEntry` → `schema.prisma:L9518`
- `Review` → `schema.prisma:L3189`
- `SalesRetention` → `schema.prisma:L11402`
- `SaleVerification` → `schema.prisma:L2948`
- `ScheduledCommand` → `schema.prisma:L7134`
- `SerializedItem` → `schema.prisma:L7725`
- `SerializedItemCustodyEvent` → `schema.prisma:L7888`
- `SettlementConfiguration` → `schema.prisma:L4697`
- `SettlementConfirmation` → `schema.prisma:L4810`
- `SettlementIncident` → `schema.prisma:L4761`
- `SettlementSimulation` → `schema.prisma:L4732`
- `Shift` → `schema.prisma:L2213`
- `SimRegistrationRequest` → `schema.prisma:L7926`
- `SimRegistrationRequestItem` → `schema.prisma:L7948`
- `SlotHold` → `schema.prisma:L9429`
- `Staff` → `schema.prisma:L759`
- `StaffOnboardingState` → `schema.prisma:L10641`
- `StaffOrganization` → `schema.prisma:L996`
- `StaffPasskey` → `schema.prisma:L1023`
- `StaffVenue` → `schema.prisma:L932`
- `StockAlertConfig` → `schema.prisma:L8569`
- `StockBatch` → `schema.prisma:L2053`
- `StockCount` → `schema.prisma:L2002`
- `StockCountItem` → `schema.prisma:L2023`
- `StripeWebhookEvent` → `schema.prisma:L4344`
- `Supplier` → `schema.prisma:L1708`
- `SupplierPricing` → `schema.prisma:L1761`
- `Table` → `schema.prisma:L2125`
- `Terminal` → `schema.prisma:L3240`
- `TerminalHealth` → `schema.prisma:L3386`
- `TerminalLog` → `schema.prisma:L3360`
- `TerminalOrder` → `schema.prisma:L3469`
- `TerminalOrderItem` → `schema.prisma:L3544`
- `TimeEntry` → `schema.prisma:L2278`
- `TimeEntryBreak` → `schema.prisma:L2347`
- `TokenPurchase` → `schema.prisma:L6808`
- `TokenUsageRecord` → `schema.prisma:L6780`
- `TpvCommandHistory` → `schema.prisma:L7040`
- `TpvCommandQueue` → `schema.prisma:L6980`
- `TpvFeedback` → `schema.prisma:L6693`
- `TpvMessage` → `schema.prisma:L8926`
- `TpvMessageDelivery` → `schema.prisma:L8978`
- `TpvMessageResponse` → `schema.prisma:L9001`
- `TrainingModule` → `schema.prisma:L9056`
- `TrainingProgress` → `schema.prisma:L9133`
- `TrainingQuizQuestion` → `schema.prisma:L9115`
- `TrainingStep` → `schema.prisma:L9095`
- `TransactionCost` → `schema.prisma:L4560`
- `UnitConversion` → `schema.prisma:L1912`
- `user_sessions` → `schema.prisma:L4046`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L630`
- `VenueChatSession` → `schema.prisma:L585`
- `VenueCommission` → `schema.prisma:L10573`
- `VenueCreditAssessment` → `schema.prisma:L7470`
- `VenueCryptoConfig` → `schema.prisma:L8793`
- `VenueFeature` → `schema.prisma:L3062`
- `VenueModule` → `schema.prisma:L7626`
- `VenuePaymentConfig` → `schema.prisma:L4147`
- `VenuePaymentLinkSettings` → `schema.prisma:L9943`
- `VenuePricingStructure` → `schema.prisma:L4500`
- `VenueRoleConfig` → `schema.prisma:L1111`
- `VenueRolePermission` → `schema.prisma:L1053`
- `VenueSettings` → `schema.prisma:L670`
- `VenueTransaction` → `schema.prisma:L2999`
- `VenueWhatsappActivation` → `schema.prisma:L521`
- `WebhookEvent` → `schema.prisma:L3098`
- `WebhookSubscription` → `schema.prisma:L4263`
- `WhatsappContactWindow` → `schema.prisma:L539`
- `WhatsappInboundEvent` → `schema.prisma:L559`
- `Zone` → `schema.prisma:L96`
