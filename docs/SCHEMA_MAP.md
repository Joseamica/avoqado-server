# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **253 models / 237 enums / ~11,800 lines**. Nobody reads it top to bottom. This file is the **index**: 20 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L11195`
- `AccountMapping` → `schema.prisma:L11091`
- `ActivityLog` → `schema.prisma:L4916`
- `Aggregator` → `schema.prisma:L10391`
- `AngelPayUserAccount` → `schema.prisma:L3725`
- `AppUpdate` → `schema.prisma:L8677`
- `Area` → `schema.prisma:L2092`
- `BankStatement` → `schema.prisma:L10965`
- `BankStatementLine` → `schema.prisma:L10986`
- `BillingTaxProfile` → `schema.prisma:L11774`
- `BulkCommandOperation` → `schema.prisma:L7037`
- `CalendarSyncOutbox` → `schema.prisma:L9794`
- `CampaignDelivery` → `schema.prisma:L8835`
- `CashCloseout` → `schema.prisma:L7370`
- `CashDeposit` → `schema.prisma:L8486`
- `CashDrawerEvent` → `schema.prisma:L10237`
- `CashDrawerSession` → `schema.prisma:L10213`
- `CashOutCommissionRate` → `schema.prisma:L11603`
- `CashOutScheduleDay` → `schema.prisma:L11626`
- `CashOutWithdrawal` → `schema.prisma:L11688`
- `Cfdi` → `schema.prisma:L10868`
- `ChatbotTokenBudget` → `schema.prisma:L6685`
- `ChatConversation` → `schema.prisma:L6540`
- `ChatFeedback` → `schema.prisma:L6626`
- `ChatLearningEvent` → `schema.prisma:L6583`
- `ChatMessage` → `schema.prisma:L6563`
- `ChatTrainingData` → `schema.prisma:L6497`
- `CheckoutSession` → `schema.prisma:L4005`
- `ClassSession` → `schema.prisma:L9415`
- `CommissionCalculation` → `schema.prisma:L8265`
- `CommissionClawback` → `schema.prisma:L8438`
- `CommissionConfig` → `schema.prisma:L8038`
- `CommissionMilestone` → `schema.prisma:L8181`
- `CommissionOverride` → `schema.prisma:L8108`
- `CommissionPayout` → `schema.prisma:L8389`
- `CommissionSummary` → `schema.prisma:L8328`
- `CommissionTier` → `schema.prisma:L8145`
- `Consumer` → `schema.prisma:L5037`
- `ConsumerAuthAccount` → `schema.prisma:L5062`
- `CouponCode` → `schema.prisma:L5465`
- `CouponRedemption` → `schema.prisma:L5496`
- `CreditAssessmentHistory` → `schema.prisma:L7479`
- `CreditItemBalance` → `schema.prisma:L10003`
- `CreditOffer` → `schema.prisma:L7498`
- `CreditPack` → `schema.prisma:L9919`
- `CreditPackItem` → `schema.prisma:L9948`
- `CreditPackPurchase` → `schema.prisma:L9965`
- `CreditTransaction` → `schema.prisma:L10025`
- `Customer` → `schema.prisma:L4942`
- `CustomerDiscount` → `schema.prisma:L5516`
- `CustomerGroup` → `schema.prisma:L5096`
- `CustomerTaxProfile` → `schema.prisma:L10937`
- `DeviceToken` → `schema.prisma:L5711`
- `DigitalReceipt` → `schema.prisma:L2903`
- `Discount` → `schema.prisma:L5365`
- `EcommerceMerchant` → `schema.prisma:L3817`
- `EmailTemplate` → `schema.prisma:L8774`
- `Employee` → `schema.prisma:L11451`
- `Estimate` → `schema.prisma:L10298`
- `EstimateItem` → `schema.prisma:L10326`
- `Expense` → `schema.prisma:L11239`
- `ExternalBusyBlock` → `schema.prisma:L9687`
- `Feature` → `schema.prisma:L3032`
- `FeeSchedule` → `schema.prisma:L3110`
- `FeeTier` → `schema.prisma:L3121`
- `FinancialAccount` → `schema.prisma:L10488`
- `FinancialConnection` → `schema.prisma:L10457`
- `FinancialProvider` → `schema.prisma:L10443`
- `FiscalEmisor` → `schema.prisma:L10791`
- `FiscalLossCarryforward` → `schema.prisma:L11362`
- `FixedAsset` → `schema.prisma:L11380`
- `FixedAssetDepreciation` → `schema.prisma:L11408`
- `FloorElement` → `schema.prisma:L2168`
- `GeofenceRule` → `schema.prisma:L7122`
- `GoogleCalendarChannel` → `schema.prisma:L9664`
- `GoogleCalendarConnection` → `schema.prisma:L9616`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9717`
- `GoogleOAuthSession` → `schema.prisma:L9739`
- `HolidayCalendar` → `schema.prisma:L4840`
- `IdempotencyRequest` → `schema.prisma:L7913`
- `Inventory` → `schema.prisma:L1523`
- `InventoryMovement` → `schema.prisma:L1547`
- `InventoryTransfer` → `schema.prisma:L10270`
- `Invitation` → `schema.prisma:L1124`
- `Invoice` → `schema.prisma:L3133`
- `InvoiceItem` → `schema.prisma:L3159`
- `ItemCategory` → `schema.prisma:L7630`
- `JournalEntry` → `schema.prisma:L11149`
- `JournalLine` → `schema.prisma:L11177`
- `KdsOrder` → `schema.prisma:L10536`
- `KdsOrderItem` → `schema.prisma:L10553`
- `LearnedPatterns` → `schema.prisma:L6607`
- `LedgerAccount` → `schema.prisma:L11041`
- `LiveDemoSession` → `schema.prisma:L651`
- `LowStockAlert` → `schema.prisma:L1963`
- `LoyaltyConfig` → `schema.prisma:L5126`
- `LoyaltyTransaction` → `schema.prisma:L5149`
- `MarketingCampaign` → `schema.prisma:L8792`
- `McpAuthCode` → `schema.prisma:L10698`
- `McpOAuthClient` → `schema.prisma:L10682`
- `McpRefreshToken` → `schema.prisma:L10716`
- `MeasurementUnit` → `schema.prisma:L10376`
- `Menu` → `schema.prisma:L1305`
- `MenuCategory` → `schema.prisma:L1247`
- `MenuCategoryAssignment` → `schema.prisma:L1340`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10612`
- `MerchantAccount` → `schema.prisma:L3595`
- `MerchantFiscalConfig` → `schema.prisma:L10839`
- `MerchantRevenueShare` → `schema.prisma:L4420`
- `MilestoneAchievement` → `schema.prisma:L8226`
- `Modifier` → `schema.prisma:L2650`
- `ModifierGroup` → `schema.prisma:L2614`
- `Module` → `schema.prisma:L7546`
- `MoneyAnomaly` → `schema.prisma:L4323`
- `MonthlyVenueProfit` → `schema.prisma:L4866`
- `Notification` → `schema.prisma:L5613`
- `NotificationPreference` → `schema.prisma:L5660`
- `NotificationTemplate` → `schema.prisma:L5687`
- `OAuthState` → `schema.prisma:L1175`
- `OnboardingProgress` → `schema.prisma:L1193`
- `Order` → `schema.prisma:L2392`
- `OrderAction` → `schema.prisma:L2715`
- `OrderCustomer` → `schema.prisma:L2519`
- `OrderDiscount` → `schema.prisma:L5548`
- `OrderItem` → `schema.prisma:L2535`
- `OrderItemModifier` → `schema.prisma:L2699`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8600`
- `OrganizationGoal` → `schema.prisma:L8558`
- `OrganizationModule` → `schema.prisma:L7602`
- `OrganizationPaymentConfig` → `schema.prisma:L4129`
- `OrganizationPayoutConfig` → `schema.prisma:L8626`
- `OrganizationPricingStructure` → `schema.prisma:L4161`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8581`
- `OtpChallenge` → `schema.prisma:L5081`
- `PartnerAPIKey` → `schema.prisma:L3959`
- `Payment` → `schema.prisma:L2748`
- `PaymentAllocation` → `schema.prisma:L2882`
- `PaymentLink` → `schema.prisma:L10071`
- `PaymentLinkAttribution` → `schema.prisma:L10179`
- `PaymentLinkItem` → `schema.prisma:L10134`
- `PaymentLinkItemModifier` → `schema.prisma:L10161`
- `PaymentProvider` → `schema.prisma:L3554`
- `PayrollLine` → `schema.prisma:L11522`
- `PayrollRun` → `schema.prisma:L11491`
- `PerformanceGoal` → `schema.prisma:L8535`
- `PermissionSet` → `schema.prisma:L1075`
- `PlatformCfdi` → `schema.prisma:L11803`
- `PlatformEmisor` → `schema.prisma:L11747`
- `PlatformSettings` → `schema.prisma:L3936`
- `PosCommand` → `schema.prisma:L5741`
- `PosConnectionStatus` → `schema.prisma:L732`
- `PricingPolicy` → `schema.prisma:L1874`
- `ProcessedStripeEvent` → `schema.prisma:L4309`
- `ProcessorReliabilityMetric` → `schema.prisma:L4794`
- `Product` → `schema.prisma:L1358`
- `ProductModifierGroup` → `schema.prisma:L2687`
- `ProductOption` → `schema.prisma:L10353`
- `ProductOptionValue` → `schema.prisma:L10364`
- `PromoterBankAccount` → `schema.prisma:L11642`
- `PromoterCommissionEntry` → `schema.prisma:L11661`
- `PromoterLocationPing` → `schema.prisma:L2358`
- `ProviderCostStructure` → `schema.prisma:L4345`
- `ProviderEventLog` → `schema.prisma:L4238`
- `PurchaseOrder` → `schema.prisma:L1788`
- `PurchaseOrderItem` → `schema.prisma:L1845`
- `RateCorrectionBatch` → `schema.prisma:L4570`
- `RateCorrectionEntry` → `schema.prisma:L4612`
- `RawMaterial` → `schema.prisma:L1577`
- `RawMaterialMovement` → `schema.prisma:L1927`
- `Recipe` → `schema.prisma:L1642`
- `RecipeLine` → `schema.prisma:L1666`
- `Referral` → `schema.prisma:L5213`
- `ReferralProgramConfig` → `schema.prisma:L5178`
- `ReferralRewardGrant` → `schema.prisma:L5304`
- `ReferralTierReward` → `schema.prisma:L5276`
- `ReferralTierUnlock` → `schema.prisma:L5349`
- `Reservation` → `schema.prisma:L9171`
- `ReservationGoogleEventMapping` → `schema.prisma:L9851`
- `ReservationModifier` → `schema.prisma:L9330`
- `ReservationReminderSent` → `schema.prisma:L9313`
- `ReservationSettings` → `schema.prisma:L9491`
- `ReservationWaitlistEntry` → `schema.prisma:L9459`
- `Review` → `schema.prisma:L3177`
- `SalesRetention` → `schema.prisma:L11343`
- `SaleVerification` → `schema.prisma:L2936`
- `ScheduledCommand` → `schema.prisma:L7082`
- `SerializedItem` → `schema.prisma:L7673`
- `SerializedItemCustodyEvent` → `schema.prisma:L7836`
- `SettlementConfiguration` → `schema.prisma:L4645`
- `SettlementConfirmation` → `schema.prisma:L4758`
- `SettlementIncident` → `schema.prisma:L4709`
- `SettlementSimulation` → `schema.prisma:L4680`
- `Shift` → `schema.prisma:L2206`
- `SimRegistrationRequest` → `schema.prisma:L7874`
- `SimRegistrationRequestItem` → `schema.prisma:L7896`
- `SlotHold` → `schema.prisma:L9370`
- `Staff` → `schema.prisma:L752`
- `StaffOnboardingState` → `schema.prisma:L10582`
- `StaffOrganization` → `schema.prisma:L989`
- `StaffPasskey` → `schema.prisma:L1016`
- `StaffVenue` → `schema.prisma:L925`
- `StockAlertConfig` → `schema.prisma:L8517`
- `StockBatch` → `schema.prisma:L2046`
- `StockCount` → `schema.prisma:L1995`
- `StockCountItem` → `schema.prisma:L2016`
- `StripeWebhookEvent` → `schema.prisma:L4292`
- `Supplier` → `schema.prisma:L1701`
- `SupplierPricing` → `schema.prisma:L1754`
- `Table` → `schema.prisma:L2118`
- `Terminal` → `schema.prisma:L3228`
- `TerminalHealth` → `schema.prisma:L3374`
- `TerminalLog` → `schema.prisma:L3348`
- `TerminalOrder` → `schema.prisma:L3457`
- `TerminalOrderItem` → `schema.prisma:L3532`
- `TimeEntry` → `schema.prisma:L2271`
- `TimeEntryBreak` → `schema.prisma:L2340`
- `TokenPurchase` → `schema.prisma:L6756`
- `TokenUsageRecord` → `schema.prisma:L6728`
- `TpvCommandHistory` → `schema.prisma:L6988`
- `TpvCommandQueue` → `schema.prisma:L6928`
- `TpvFeedback` → `schema.prisma:L6641`
- `TpvMessage` → `schema.prisma:L8867`
- `TpvMessageDelivery` → `schema.prisma:L8919`
- `TpvMessageResponse` → `schema.prisma:L8942`
- `TrainingModule` → `schema.prisma:L8997`
- `TrainingProgress` → `schema.prisma:L9074`
- `TrainingQuizQuestion` → `schema.prisma:L9056`
- `TrainingStep` → `schema.prisma:L9036`
- `TransactionCost` → `schema.prisma:L4508`
- `UnitConversion` → `schema.prisma:L1905`
- `user_sessions` → `schema.prisma:L3994`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L627`
- `VenueChatSession` → `schema.prisma:L582`
- `VenueCommission` → `schema.prisma:L10514`
- `VenueCreditAssessment` → `schema.prisma:L7418`
- `VenueCryptoConfig` → `schema.prisma:L8734`
- `VenueFeature` → `schema.prisma:L3050`
- `VenueModule` → `schema.prisma:L7574`
- `VenuePaymentConfig` → `schema.prisma:L4095`
- `VenuePaymentLinkSettings` → `schema.prisma:L9884`
- `VenuePricingStructure` → `schema.prisma:L4448`
- `VenueRoleConfig` → `schema.prisma:L1104`
- `VenueRolePermission` → `schema.prisma:L1046`
- `VenueSettings` → `schema.prisma:L667`
- `VenueTransaction` → `schema.prisma:L2987`
- `VenueWhatsappActivation` → `schema.prisma:L518`
- `WebhookEvent` → `schema.prisma:L3086`
- `WebhookSubscription` → `schema.prisma:L4211`
- `WhatsappContactWindow` → `schema.prisma:L536`
- `WhatsappInboundEvent` → `schema.prisma:L556`
- `Zone` → `schema.prisma:L96`
