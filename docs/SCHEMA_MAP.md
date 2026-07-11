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

- `AccountingPeriodLock` → `schema.prisma:L11267`
- `AccountMapping` → `schema.prisma:L11163`
- `ActivityLog` → `schema.prisma:L4981`
- `Aggregator` → `schema.prisma:L10463`
- `AngelPayUserAccount` → `schema.prisma:L3790`
- `AppUpdate` → `schema.prisma:L8749`
- `Area` → `schema.prisma:L2112`
- `BankStatement` → `schema.prisma:L11037`
- `BankStatementLine` → `schema.prisma:L11058`
- `BillingTaxProfile` → `schema.prisma:L11847`
- `BulkCommandOperation` → `schema.prisma:L7102`
- `CalendarSyncOutbox` → `schema.prisma:L9866`
- `CampaignDelivery` → `schema.prisma:L8907`
- `CashCloseout` → `schema.prisma:L7435`
- `CashDeposit` → `schema.prisma:L8551`
- `CashDrawerEvent` → `schema.prisma:L10309`
- `CashDrawerSession` → `schema.prisma:L10285`
- `CashOutCommissionRate` → `schema.prisma:L11676`
- `CashOutScheduleDay` → `schema.prisma:L11699`
- `CashOutWithdrawal` → `schema.prisma:L11761`
- `Cfdi` → `schema.prisma:L10940`
- `ChatbotTokenBudget` → `schema.prisma:L6750`
- `ChatConversation` → `schema.prisma:L6605`
- `ChatFeedback` → `schema.prisma:L6691`
- `ChatLearningEvent` → `schema.prisma:L6648`
- `ChatMessage` → `schema.prisma:L6628`
- `ChatTrainingData` → `schema.prisma:L6562`
- `CheckoutSession` → `schema.prisma:L4070`
- `ClassSession` → `schema.prisma:L9487`
- `CommissionCalculation` → `schema.prisma:L8330`
- `CommissionClawback` → `schema.prisma:L8503`
- `CommissionConfig` → `schema.prisma:L8103`
- `CommissionMilestone` → `schema.prisma:L8246`
- `CommissionOverride` → `schema.prisma:L8173`
- `CommissionPayout` → `schema.prisma:L8454`
- `CommissionSummary` → `schema.prisma:L8393`
- `CommissionTier` → `schema.prisma:L8210`
- `Consumer` → `schema.prisma:L5102`
- `ConsumerAuthAccount` → `schema.prisma:L5127`
- `CouponCode` → `schema.prisma:L5530`
- `CouponRedemption` → `schema.prisma:L5561`
- `CreditAssessmentHistory` → `schema.prisma:L7544`
- `CreditItemBalance` → `schema.prisma:L10075`
- `CreditOffer` → `schema.prisma:L7563`
- `CreditPack` → `schema.prisma:L9991`
- `CreditPackItem` → `schema.prisma:L10020`
- `CreditPackPurchase` → `schema.prisma:L10037`
- `CreditTransaction` → `schema.prisma:L10097`
- `Customer` → `schema.prisma:L5007`
- `CustomerDiscount` → `schema.prisma:L5581`
- `CustomerGroup` → `schema.prisma:L5161`
- `CustomerTaxProfile` → `schema.prisma:L11009`
- `DeviceToken` → `schema.prisma:L5776`
- `DigitalReceipt` → `schema.prisma:L2928`
- `Discount` → `schema.prisma:L5430`
- `EcommerceMerchant` → `schema.prisma:L3882`
- `EmailTemplate` → `schema.prisma:L8846`
- `Employee` → `schema.prisma:L11524`
- `Estimate` → `schema.prisma:L10370`
- `EstimateItem` → `schema.prisma:L10398`
- `Expense` → `schema.prisma:L11311`
- `ExternalBusyBlock` → `schema.prisma:L9759`
- `Feature` → `schema.prisma:L3057`
- `FeeSchedule` → `schema.prisma:L3135`
- `FeeTier` → `schema.prisma:L3146`
- `FinancialAccount` → `schema.prisma:L10560`
- `FinancialConnection` → `schema.prisma:L10529`
- `FinancialProvider` → `schema.prisma:L10515`
- `FiscalEmisor` → `schema.prisma:L10863`
- `FiscalLossCarryforward` → `schema.prisma:L11434`
- `FixedAsset` → `schema.prisma:L11452`
- `FixedAssetDepreciation` → `schema.prisma:L11481`
- `FloorElement` → `schema.prisma:L2188`
- `GeofenceRule` → `schema.prisma:L7187`
- `GoogleCalendarChannel` → `schema.prisma:L9736`
- `GoogleCalendarConnection` → `schema.prisma:L9688`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9789`
- `GoogleOAuthSession` → `schema.prisma:L9811`
- `HolidayCalendar` → `schema.prisma:L4905`
- `IdempotencyRequest` → `schema.prisma:L7978`
- `Inventory` → `schema.prisma:L1530`
- `InventoryMovement` → `schema.prisma:L1554`
- `InventoryTransfer` → `schema.prisma:L10342`
- `Invitation` → `schema.prisma:L1131`
- `Invoice` → `schema.prisma:L3158`
- `InvoiceItem` → `schema.prisma:L3184`
- `ItemCategory` → `schema.prisma:L7695`
- `JournalEntry` → `schema.prisma:L11221`
- `JournalLine` → `schema.prisma:L11249`
- `KdsOrder` → `schema.prisma:L10608`
- `KdsOrderItem` → `schema.prisma:L10625`
- `LearnedPatterns` → `schema.prisma:L6672`
- `LedgerAccount` → `schema.prisma:L11113`
- `LiveDemoSession` → `schema.prisma:L654`
- `LowStockAlert` → `schema.prisma:L1971`
- `LoyaltyConfig` → `schema.prisma:L5191`
- `LoyaltyTransaction` → `schema.prisma:L5214`
- `MarketingCampaign` → `schema.prisma:L8864`
- `McpAuthCode` → `schema.prisma:L10770`
- `McpOAuthClient` → `schema.prisma:L10754`
- `McpRefreshToken` → `schema.prisma:L10788`
- `MeasurementUnit` → `schema.prisma:L10448`
- `Menu` → `schema.prisma:L1312`
- `MenuCategory` → `schema.prisma:L1254`
- `MenuCategoryAssignment` → `schema.prisma:L1347`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10684`
- `MerchantAccount` → `schema.prisma:L3620`
- `MerchantFiscalConfig` → `schema.prisma:L10911`
- `MerchantRevenueShare` → `schema.prisma:L4485`
- `MerchantRoutingRule` → `schema.prisma:L3742`
- `MilestoneAchievement` → `schema.prisma:L8291`
- `Modifier` → `schema.prisma:L2670`
- `ModifierGroup` → `schema.prisma:L2634`
- `Module` → `schema.prisma:L7611`
- `MoneyAnomaly` → `schema.prisma:L4388`
- `MonthlyVenueProfit` → `schema.prisma:L4931`
- `Notification` → `schema.prisma:L5678`
- `NotificationPreference` → `schema.prisma:L5725`
- `NotificationTemplate` → `schema.prisma:L5752`
- `OAuthState` → `schema.prisma:L1182`
- `OnboardingProgress` → `schema.prisma:L1200`
- `Order` → `schema.prisma:L2412`
- `OrderAction` → `schema.prisma:L2735`
- `OrderCustomer` → `schema.prisma:L2539`
- `OrderDiscount` → `schema.prisma:L5613`
- `OrderItem` → `schema.prisma:L2555`
- `OrderItemModifier` → `schema.prisma:L2719`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8665`
- `OrganizationGoal` → `schema.prisma:L8623`
- `OrganizationModule` → `schema.prisma:L7667`
- `OrganizationPaymentConfig` → `schema.prisma:L4194`
- `OrganizationPayoutConfig` → `schema.prisma:L8698`
- `OrganizationPricingStructure` → `schema.prisma:L4226`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8646`
- `OtpChallenge` → `schema.prisma:L5146`
- `PartnerAPIKey` → `schema.prisma:L4024`
- `Payment` → `schema.prisma:L2768`
- `PaymentAllocation` → `schema.prisma:L2907`
- `PaymentLink` → `schema.prisma:L10143`
- `PaymentLinkAttribution` → `schema.prisma:L10251`
- `PaymentLinkItem` → `schema.prisma:L10206`
- `PaymentLinkItemModifier` → `schema.prisma:L10233`
- `PaymentProvider` → `schema.prisma:L3579`
- `PayrollLine` → `schema.prisma:L11595`
- `PayrollRun` → `schema.prisma:L11564`
- `PerformanceGoal` → `schema.prisma:L8600`
- `PermissionSet` → `schema.prisma:L1082`
- `PlatformCfdi` → `schema.prisma:L11876`
- `PlatformEmisor` → `schema.prisma:L11820`
- `PlatformSettings` → `schema.prisma:L4001`
- `PosCommand` → `schema.prisma:L5806`
- `PosConnectionStatus` → `schema.prisma:L739`
- `PricingPolicy` → `schema.prisma:L1882`
- `ProcessedStripeEvent` → `schema.prisma:L4374`
- `ProcessorReliabilityMetric` → `schema.prisma:L4859`
- `Product` → `schema.prisma:L1365`
- `ProductModifierGroup` → `schema.prisma:L2707`
- `ProductOption` → `schema.prisma:L10425`
- `ProductOptionValue` → `schema.prisma:L10436`
- `PromoterBankAccount` → `schema.prisma:L11715`
- `PromoterCommissionEntry` → `schema.prisma:L11734`
- `PromoterLocationPing` → `schema.prisma:L2378`
- `ProviderCostStructure` → `schema.prisma:L4410`
- `ProviderEventLog` → `schema.prisma:L4303`
- `PurchaseOrder` → `schema.prisma:L1796`
- `PurchaseOrderItem` → `schema.prisma:L1853`
- `RateCorrectionBatch` → `schema.prisma:L4635`
- `RateCorrectionEntry` → `schema.prisma:L4677`
- `RawMaterial` → `schema.prisma:L1584`
- `RawMaterialMovement` → `schema.prisma:L1935`
- `Recipe` → `schema.prisma:L1650`
- `RecipeLine` → `schema.prisma:L1674`
- `Referral` → `schema.prisma:L5278`
- `ReferralProgramConfig` → `schema.prisma:L5243`
- `ReferralRewardGrant` → `schema.prisma:L5369`
- `ReferralTierReward` → `schema.prisma:L5341`
- `ReferralTierUnlock` → `schema.prisma:L5414`
- `Reservation` → `schema.prisma:L9243`
- `ReservationGoogleEventMapping` → `schema.prisma:L9923`
- `ReservationModifier` → `schema.prisma:L9402`
- `ReservationReminderSent` → `schema.prisma:L9385`
- `ReservationSettings` → `schema.prisma:L9563`
- `ReservationWaitlistEntry` → `schema.prisma:L9531`
- `Review` → `schema.prisma:L3202`
- `SalesRetention` → `schema.prisma:L11415`
- `SaleVerification` → `schema.prisma:L2961`
- `ScheduledCommand` → `schema.prisma:L7147`
- `SerializedItem` → `schema.prisma:L7738`
- `SerializedItemCustodyEvent` → `schema.prisma:L7901`
- `SettlementConfiguration` → `schema.prisma:L4710`
- `SettlementConfirmation` → `schema.prisma:L4823`
- `SettlementIncident` → `schema.prisma:L4774`
- `SettlementSimulation` → `schema.prisma:L4745`
- `Shift` → `schema.prisma:L2226`
- `SimRegistrationRequest` → `schema.prisma:L7939`
- `SimRegistrationRequestItem` → `schema.prisma:L7961`
- `SlotHold` → `schema.prisma:L9442`
- `Staff` → `schema.prisma:L759`
- `StaffOnboardingState` → `schema.prisma:L10654`
- `StaffOrganization` → `schema.prisma:L996`
- `StaffPasskey` → `schema.prisma:L1023`
- `StaffVenue` → `schema.prisma:L932`
- `StockAlertConfig` → `schema.prisma:L8582`
- `StockBatch` → `schema.prisma:L2066`
- `StockCount` → `schema.prisma:L2003`
- `StockCountItem` → `schema.prisma:L2024`
- `StripeWebhookEvent` → `schema.prisma:L4357`
- `Supplier` → `schema.prisma:L1709`
- `SupplierPricing` → `schema.prisma:L1762`
- `Table` → `schema.prisma:L2138`
- `Terminal` → `schema.prisma:L3253`
- `TerminalHealth` → `schema.prisma:L3399`
- `TerminalLog` → `schema.prisma:L3373`
- `TerminalOrder` → `schema.prisma:L3482`
- `TerminalOrderItem` → `schema.prisma:L3557`
- `TimeEntry` → `schema.prisma:L2291`
- `TimeEntryBreak` → `schema.prisma:L2360`
- `TokenPurchase` → `schema.prisma:L6821`
- `TokenUsageRecord` → `schema.prisma:L6793`
- `TpvCommandHistory` → `schema.prisma:L7053`
- `TpvCommandQueue` → `schema.prisma:L6993`
- `TpvFeedback` → `schema.prisma:L6706`
- `TpvMessage` → `schema.prisma:L8939`
- `TpvMessageDelivery` → `schema.prisma:L8991`
- `TpvMessageResponse` → `schema.prisma:L9014`
- `TrainingModule` → `schema.prisma:L9069`
- `TrainingProgress` → `schema.prisma:L9146`
- `TrainingQuizQuestion` → `schema.prisma:L9128`
- `TrainingStep` → `schema.prisma:L9108`
- `TransactionCost` → `schema.prisma:L4573`
- `UnitConversion` → `schema.prisma:L1913`
- `user_sessions` → `schema.prisma:L4059`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L630`
- `VenueChatSession` → `schema.prisma:L585`
- `VenueCommission` → `schema.prisma:L10586`
- `VenueCreditAssessment` → `schema.prisma:L7483`
- `VenueCryptoConfig` → `schema.prisma:L8806`
- `VenueFeature` → `schema.prisma:L3075`
- `VenueModule` → `schema.prisma:L7639`
- `VenuePaymentConfig` → `schema.prisma:L4160`
- `VenuePaymentLinkSettings` → `schema.prisma:L9956`
- `VenuePricingStructure` → `schema.prisma:L4513`
- `VenueRoleConfig` → `schema.prisma:L1111`
- `VenueRolePermission` → `schema.prisma:L1053`
- `VenueSettings` → `schema.prisma:L670`
- `VenueTransaction` → `schema.prisma:L3012`
- `VenueWhatsappActivation` → `schema.prisma:L521`
- `WebhookEvent` → `schema.prisma:L3111`
- `WebhookSubscription` → `schema.prisma:L4276`
- `WhatsappContactWindow` → `schema.prisma:L539`
- `WhatsappInboundEvent` → `schema.prisma:L559`
- `Zone` → `schema.prisma:L96`
