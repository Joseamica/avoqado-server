# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **246 models / 232 enums / ~11,600 lines**. Nobody reads it top to bottom. This file is the **index**: 20 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L11015`
- `AccountMapping` → `schema.prisma:L10915`
- `ActivityLog` → `schema.prisma:L4902`
- `Aggregator` → `schema.prisma:L10265`
- `AngelPayUserAccount` → `schema.prisma:L3711`
- `AppUpdate` → `schema.prisma:L8551`
- `Area` → `schema.prisma:L2087`
- `BankStatement` → `schema.prisma:L10789`
- `BankStatementLine` → `schema.prisma:L10810`
- `BillingTaxProfile` → `schema.prisma:L11504`
- `BulkCommandOperation` → `schema.prisma:L6911`
- `CalendarSyncOutbox` → `schema.prisma:L9668`
- `CampaignDelivery` → `schema.prisma:L8709`
- `CashCloseout` → `schema.prisma:L7244`
- `CashDeposit` → `schema.prisma:L8360`
- `CashDrawerEvent` → `schema.prisma:L10111`
- `CashDrawerSession` → `schema.prisma:L10087`
- `CashOutCommissionRate` → `schema.prisma:L11333`
- `CashOutScheduleDay` → `schema.prisma:L11356`
- `CashOutWithdrawal` → `schema.prisma:L11418`
- `Cfdi` → `schema.prisma:L10692`
- `ChatbotTokenBudget` → `schema.prisma:L6559`
- `ChatConversation` → `schema.prisma:L6414`
- `ChatFeedback` → `schema.prisma:L6500`
- `ChatLearningEvent` → `schema.prisma:L6457`
- `ChatMessage` → `schema.prisma:L6437`
- `ChatTrainingData` → `schema.prisma:L6371`
- `CheckoutSession` → `schema.prisma:L3991`
- `ClassSession` → `schema.prisma:L9289`
- `CommissionCalculation` → `schema.prisma:L8139`
- `CommissionClawback` → `schema.prisma:L8312`
- `CommissionConfig` → `schema.prisma:L7912`
- `CommissionMilestone` → `schema.prisma:L8055`
- `CommissionOverride` → `schema.prisma:L7982`
- `CommissionPayout` → `schema.prisma:L8263`
- `CommissionSummary` → `schema.prisma:L8202`
- `CommissionTier` → `schema.prisma:L8019`
- `Consumer` → `schema.prisma:L5020`
- `ConsumerAuthAccount` → `schema.prisma:L5045`
- `CouponCode` → `schema.prisma:L5339`
- `CouponRedemption` → `schema.prisma:L5370`
- `CreditAssessmentHistory` → `schema.prisma:L7353`
- `CreditItemBalance` → `schema.prisma:L9877`
- `CreditOffer` → `schema.prisma:L7372`
- `CreditPack` → `schema.prisma:L9793`
- `CreditPackItem` → `schema.prisma:L9822`
- `CreditPackPurchase` → `schema.prisma:L9839`
- `CreditTransaction` → `schema.prisma:L9899`
- `Customer` → `schema.prisma:L4928`
- `CustomerDiscount` → `schema.prisma:L5390`
- `CustomerGroup` → `schema.prisma:L5079`
- `CustomerTaxProfile` → `schema.prisma:L10761`
- `DeviceToken` → `schema.prisma:L5585`
- `DigitalReceipt` → `schema.prisma:L2891`
- `Discount` → `schema.prisma:L5240`
- `EcommerceMerchant` → `schema.prisma:L3803`
- `EmailTemplate` → `schema.prisma:L8648`
- `Employee` → `schema.prisma:L11181`
- `Estimate` → `schema.prisma:L10172`
- `EstimateItem` → `schema.prisma:L10200`
- `Expense` → `schema.prisma:L11058`
- `ExternalBusyBlock` → `schema.prisma:L9561`
- `Feature` → `schema.prisma:L3020`
- `FeeSchedule` → `schema.prisma:L3098`
- `FeeTier` → `schema.prisma:L3109`
- `FinancialAccount` → `schema.prisma:L10354`
- `FinancialConnection` → `schema.prisma:L10326`
- `FinancialProvider` → `schema.prisma:L10312`
- `FiscalEmisor` → `schema.prisma:L10634`
- `FloorElement` → `schema.prisma:L2163`
- `GeofenceRule` → `schema.prisma:L6996`
- `GoogleCalendarChannel` → `schema.prisma:L9538`
- `GoogleCalendarConnection` → `schema.prisma:L9490`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9591`
- `GoogleOAuthSession` → `schema.prisma:L9613`
- `HolidayCalendar` → `schema.prisma:L4826`
- `IdempotencyRequest` → `schema.prisma:L7787`
- `Inventory` → `schema.prisma:L1518`
- `InventoryMovement` → `schema.prisma:L1542`
- `InventoryTransfer` → `schema.prisma:L10144`
- `Invitation` → `schema.prisma:L1122`
- `Invoice` → `schema.prisma:L3121`
- `InvoiceItem` → `schema.prisma:L3147`
- `ItemCategory` → `schema.prisma:L7504`
- `JournalEntry` → `schema.prisma:L10969`
- `JournalLine` → `schema.prisma:L10997`
- `KdsOrder` → `schema.prisma:L10398`
- `KdsOrderItem` → `schema.prisma:L10415`
- `LearnedPatterns` → `schema.prisma:L6481`
- `LedgerAccount` → `schema.prisma:L10865`
- `LiveDemoSession` → `schema.prisma:L650`
- `LowStockAlert` → `schema.prisma:L1958`
- `LoyaltyConfig` → `schema.prisma:L5109`
- `LoyaltyTransaction` → `schema.prisma:L5132`
- `MarketingCampaign` → `schema.prisma:L8666`
- `McpAuthCode` → `schema.prisma:L10541`
- `McpOAuthClient` → `schema.prisma:L10525`
- `McpRefreshToken` → `schema.prisma:L10559`
- `MeasurementUnit` → `schema.prisma:L10250`
- `Menu` → `schema.prisma:L1303`
- `MenuCategory` → `schema.prisma:L1245`
- `MenuCategoryAssignment` → `schema.prisma:L1338`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10474`
- `MerchantAccount` → `schema.prisma:L3581`
- `MerchantFiscalConfig` → `schema.prisma:L10670`
- `MerchantRevenueShare` → `schema.prisma:L4406`
- `MilestoneAchievement` → `schema.prisma:L8100`
- `Modifier` → `schema.prisma:L2638`
- `ModifierGroup` → `schema.prisma:L2602`
- `Module` → `schema.prisma:L7420`
- `MoneyAnomaly` → `schema.prisma:L4309`
- `MonthlyVenueProfit` → `schema.prisma:L4852`
- `Notification` → `schema.prisma:L5487`
- `NotificationPreference` → `schema.prisma:L5534`
- `NotificationTemplate` → `schema.prisma:L5561`
- `OAuthState` → `schema.prisma:L1173`
- `OnboardingProgress` → `schema.prisma:L1191`
- `Order` → `schema.prisma:L2380`
- `OrderAction` → `schema.prisma:L2703`
- `OrderCustomer` → `schema.prisma:L2507`
- `OrderDiscount` → `schema.prisma:L5422`
- `OrderItem` → `schema.prisma:L2523`
- `OrderItemModifier` → `schema.prisma:L2687`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8474`
- `OrganizationGoal` → `schema.prisma:L8432`
- `OrganizationModule` → `schema.prisma:L7476`
- `OrganizationPaymentConfig` → `schema.prisma:L4115`
- `OrganizationPayoutConfig` → `schema.prisma:L8500`
- `OrganizationPricingStructure` → `schema.prisma:L4147`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8455`
- `OtpChallenge` → `schema.prisma:L5064`
- `PartnerAPIKey` → `schema.prisma:L3945`
- `Payment` → `schema.prisma:L2736`
- `PaymentAllocation` → `schema.prisma:L2870`
- `PaymentLink` → `schema.prisma:L9945`
- `PaymentLinkAttribution` → `schema.prisma:L10053`
- `PaymentLinkItem` → `schema.prisma:L10008`
- `PaymentLinkItemModifier` → `schema.prisma:L10035`
- `PaymentProvider` → `schema.prisma:L3540`
- `PayrollLine` → `schema.prisma:L11252`
- `PayrollRun` → `schema.prisma:L11221`
- `PerformanceGoal` → `schema.prisma:L8409`
- `PermissionSet` → `schema.prisma:L1073`
- `PlatformCfdi` → `schema.prisma:L11533`
- `PlatformEmisor` → `schema.prisma:L11477`
- `PlatformSettings` → `schema.prisma:L3922`
- `PosCommand` → `schema.prisma:L5615`
- `PosConnectionStatus` → `schema.prisma:L730`
- `PricingPolicy` → `schema.prisma:L1869`
- `ProcessedStripeEvent` → `schema.prisma:L4295`
- `ProcessorReliabilityMetric` → `schema.prisma:L4780`
- `Product` → `schema.prisma:L1356`
- `ProductModifierGroup` → `schema.prisma:L2675`
- `ProductOption` → `schema.prisma:L10227`
- `ProductOptionValue` → `schema.prisma:L10238`
- `PromoterBankAccount` → `schema.prisma:L11372`
- `PromoterCommissionEntry` → `schema.prisma:L11391`
- `PromoterLocationPing` → `schema.prisma:L2353`
- `ProviderCostStructure` → `schema.prisma:L4331`
- `ProviderEventLog` → `schema.prisma:L4224`
- `PurchaseOrder` → `schema.prisma:L1783`
- `PurchaseOrderItem` → `schema.prisma:L1840`
- `RateCorrectionBatch` → `schema.prisma:L4556`
- `RateCorrectionEntry` → `schema.prisma:L4598`
- `RawMaterial` → `schema.prisma:L1572`
- `RawMaterialMovement` → `schema.prisma:L1922`
- `Recipe` → `schema.prisma:L1637`
- `RecipeLine` → `schema.prisma:L1661`
- `Referral` → `schema.prisma:L5194`
- `ReferralProgramConfig` → `schema.prisma:L5161`
- `Reservation` → `schema.prisma:L9045`
- `ReservationGoogleEventMapping` → `schema.prisma:L9725`
- `ReservationModifier` → `schema.prisma:L9204`
- `ReservationReminderSent` → `schema.prisma:L9187`
- `ReservationSettings` → `schema.prisma:L9365`
- `ReservationWaitlistEntry` → `schema.prisma:L9333`
- `Review` → `schema.prisma:L3165`
- `SaleVerification` → `schema.prisma:L2924`
- `ScheduledCommand` → `schema.prisma:L6956`
- `SerializedItem` → `schema.prisma:L7547`
- `SerializedItemCustodyEvent` → `schema.prisma:L7710`
- `SettlementConfiguration` → `schema.prisma:L4631`
- `SettlementConfirmation` → `schema.prisma:L4744`
- `SettlementIncident` → `schema.prisma:L4695`
- `SettlementSimulation` → `schema.prisma:L4666`
- `Shift` → `schema.prisma:L2201`
- `SimRegistrationRequest` → `schema.prisma:L7748`
- `SimRegistrationRequestItem` → `schema.prisma:L7770`
- `SlotHold` → `schema.prisma:L9244`
- `Staff` → `schema.prisma:L750`
- `StaffOnboardingState` → `schema.prisma:L10444`
- `StaffOrganization` → `schema.prisma:L987`
- `StaffPasskey` → `schema.prisma:L1014`
- `StaffVenue` → `schema.prisma:L923`
- `StockAlertConfig` → `schema.prisma:L8391`
- `StockBatch` → `schema.prisma:L2041`
- `StockCount` → `schema.prisma:L1990`
- `StockCountItem` → `schema.prisma:L2011`
- `StripeWebhookEvent` → `schema.prisma:L4278`
- `Supplier` → `schema.prisma:L1696`
- `SupplierPricing` → `schema.prisma:L1749`
- `Table` → `schema.prisma:L2113`
- `Terminal` → `schema.prisma:L3216`
- `TerminalHealth` → `schema.prisma:L3360`
- `TerminalLog` → `schema.prisma:L3334`
- `TerminalOrder` → `schema.prisma:L3443`
- `TerminalOrderItem` → `schema.prisma:L3518`
- `TimeEntry` → `schema.prisma:L2266`
- `TimeEntryBreak` → `schema.prisma:L2335`
- `TokenPurchase` → `schema.prisma:L6630`
- `TokenUsageRecord` → `schema.prisma:L6602`
- `TpvCommandHistory` → `schema.prisma:L6862`
- `TpvCommandQueue` → `schema.prisma:L6802`
- `TpvFeedback` → `schema.prisma:L6515`
- `TpvMessage` → `schema.prisma:L8741`
- `TpvMessageDelivery` → `schema.prisma:L8793`
- `TpvMessageResponse` → `schema.prisma:L8816`
- `TrainingModule` → `schema.prisma:L8871`
- `TrainingProgress` → `schema.prisma:L8948`
- `TrainingQuizQuestion` → `schema.prisma:L8930`
- `TrainingStep` → `schema.prisma:L8910`
- `TransactionCost` → `schema.prisma:L4494`
- `UnitConversion` → `schema.prisma:L1900`
- `user_sessions` → `schema.prisma:L3980`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L626`
- `VenueChatSession` → `schema.prisma:L581`
- `VenueCommission` → `schema.prisma:L10376`
- `VenueCreditAssessment` → `schema.prisma:L7292`
- `VenueCryptoConfig` → `schema.prisma:L8608`
- `VenueFeature` → `schema.prisma:L3038`
- `VenueModule` → `schema.prisma:L7448`
- `VenuePaymentConfig` → `schema.prisma:L4081`
- `VenuePaymentLinkSettings` → `schema.prisma:L9758`
- `VenuePricingStructure` → `schema.prisma:L4434`
- `VenueRoleConfig` → `schema.prisma:L1102`
- `VenueRolePermission` → `schema.prisma:L1044`
- `VenueSettings` → `schema.prisma:L666`
- `VenueTransaction` → `schema.prisma:L2975`
- `VenueWhatsappActivation` → `schema.prisma:L517`
- `WebhookEvent` → `schema.prisma:L3074`
- `WebhookSubscription` → `schema.prisma:L4197`
- `WhatsappContactWindow` → `schema.prisma:L535`
- `WhatsappInboundEvent` → `schema.prisma:L555`
- `Zone` → `schema.prisma:L96`
