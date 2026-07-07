# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **249 models / 236 enums / ~11,700 lines**. Nobody reads it top to bottom. This file is the **index**: 20 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L11170`
- `AccountMapping` → `schema.prisma:L11070`
- `ActivityLog` → `schema.prisma:L4907`
- `Aggregator` → `schema.prisma:L10382`
- `AngelPayUserAccount` → `schema.prisma:L3716`
- `AppUpdate` → `schema.prisma:L8668`
- `Area` → `schema.prisma:L2092`
- `BankStatement` → `schema.prisma:L10944`
- `BankStatementLine` → `schema.prisma:L10965`
- `BillingTaxProfile` → `schema.prisma:L11659`
- `BulkCommandOperation` → `schema.prisma:L7028`
- `CalendarSyncOutbox` → `schema.prisma:L9785`
- `CampaignDelivery` → `schema.prisma:L8826`
- `CashCloseout` → `schema.prisma:L7361`
- `CashDeposit` → `schema.prisma:L8477`
- `CashDrawerEvent` → `schema.prisma:L10228`
- `CashDrawerSession` → `schema.prisma:L10204`
- `CashOutCommissionRate` → `schema.prisma:L11488`
- `CashOutScheduleDay` → `schema.prisma:L11511`
- `CashOutWithdrawal` → `schema.prisma:L11573`
- `Cfdi` → `schema.prisma:L10847`
- `ChatbotTokenBudget` → `schema.prisma:L6676`
- `ChatConversation` → `schema.prisma:L6531`
- `ChatFeedback` → `schema.prisma:L6617`
- `ChatLearningEvent` → `schema.prisma:L6574`
- `ChatMessage` → `schema.prisma:L6554`
- `ChatTrainingData` → `schema.prisma:L6488`
- `CheckoutSession` → `schema.prisma:L3996`
- `ClassSession` → `schema.prisma:L9406`
- `CommissionCalculation` → `schema.prisma:L8256`
- `CommissionClawback` → `schema.prisma:L8429`
- `CommissionConfig` → `schema.prisma:L8029`
- `CommissionMilestone` → `schema.prisma:L8172`
- `CommissionOverride` → `schema.prisma:L8099`
- `CommissionPayout` → `schema.prisma:L8380`
- `CommissionSummary` → `schema.prisma:L8319`
- `CommissionTier` → `schema.prisma:L8136`
- `Consumer` → `schema.prisma:L5028`
- `ConsumerAuthAccount` → `schema.prisma:L5053`
- `CouponCode` → `schema.prisma:L5456`
- `CouponRedemption` → `schema.prisma:L5487`
- `CreditAssessmentHistory` → `schema.prisma:L7470`
- `CreditItemBalance` → `schema.prisma:L9994`
- `CreditOffer` → `schema.prisma:L7489`
- `CreditPack` → `schema.prisma:L9910`
- `CreditPackItem` → `schema.prisma:L9939`
- `CreditPackPurchase` → `schema.prisma:L9956`
- `CreditTransaction` → `schema.prisma:L10016`
- `Customer` → `schema.prisma:L4933`
- `CustomerDiscount` → `schema.prisma:L5507`
- `CustomerGroup` → `schema.prisma:L5087`
- `CustomerTaxProfile` → `schema.prisma:L10916`
- `DeviceToken` → `schema.prisma:L5702`
- `DigitalReceipt` → `schema.prisma:L2896`
- `Discount` → `schema.prisma:L5356`
- `EcommerceMerchant` → `schema.prisma:L3808`
- `EmailTemplate` → `schema.prisma:L8765`
- `Employee` → `schema.prisma:L11336`
- `Estimate` → `schema.prisma:L10289`
- `EstimateItem` → `schema.prisma:L10317`
- `Expense` → `schema.prisma:L11213`
- `ExternalBusyBlock` → `schema.prisma:L9678`
- `Feature` → `schema.prisma:L3025`
- `FeeSchedule` → `schema.prisma:L3103`
- `FeeTier` → `schema.prisma:L3114`
- `FinancialAccount` → `schema.prisma:L10479`
- `FinancialConnection` → `schema.prisma:L10448`
- `FinancialProvider` → `schema.prisma:L10434`
- `FiscalEmisor` → `schema.prisma:L10782`
- `FloorElement` → `schema.prisma:L2168`
- `GeofenceRule` → `schema.prisma:L7113`
- `GoogleCalendarChannel` → `schema.prisma:L9655`
- `GoogleCalendarConnection` → `schema.prisma:L9607`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9708`
- `GoogleOAuthSession` → `schema.prisma:L9730`
- `HolidayCalendar` → `schema.prisma:L4831`
- `IdempotencyRequest` → `schema.prisma:L7904`
- `Inventory` → `schema.prisma:L1523`
- `InventoryMovement` → `schema.prisma:L1547`
- `InventoryTransfer` → `schema.prisma:L10261`
- `Invitation` → `schema.prisma:L1124`
- `Invoice` → `schema.prisma:L3126`
- `InvoiceItem` → `schema.prisma:L3152`
- `ItemCategory` → `schema.prisma:L7621`
- `JournalEntry` → `schema.prisma:L11124`
- `JournalLine` → `schema.prisma:L11152`
- `KdsOrder` → `schema.prisma:L10527`
- `KdsOrderItem` → `schema.prisma:L10544`
- `LearnedPatterns` → `schema.prisma:L6598`
- `LedgerAccount` → `schema.prisma:L11020`
- `LiveDemoSession` → `schema.prisma:L651`
- `LowStockAlert` → `schema.prisma:L1963`
- `LoyaltyConfig` → `schema.prisma:L5117`
- `LoyaltyTransaction` → `schema.prisma:L5140`
- `MarketingCampaign` → `schema.prisma:L8783`
- `McpAuthCode` → `schema.prisma:L10689`
- `McpOAuthClient` → `schema.prisma:L10673`
- `McpRefreshToken` → `schema.prisma:L10707`
- `MeasurementUnit` → `schema.prisma:L10367`
- `Menu` → `schema.prisma:L1305`
- `MenuCategory` → `schema.prisma:L1247`
- `MenuCategoryAssignment` → `schema.prisma:L1340`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10603`
- `MerchantAccount` → `schema.prisma:L3586`
- `MerchantFiscalConfig` → `schema.prisma:L10822`
- `MerchantRevenueShare` → `schema.prisma:L4411`
- `MilestoneAchievement` → `schema.prisma:L8217`
- `Modifier` → `schema.prisma:L2643`
- `ModifierGroup` → `schema.prisma:L2607`
- `Module` → `schema.prisma:L7537`
- `MoneyAnomaly` → `schema.prisma:L4314`
- `MonthlyVenueProfit` → `schema.prisma:L4857`
- `Notification` → `schema.prisma:L5604`
- `NotificationPreference` → `schema.prisma:L5651`
- `NotificationTemplate` → `schema.prisma:L5678`
- `OAuthState` → `schema.prisma:L1175`
- `OnboardingProgress` → `schema.prisma:L1193`
- `Order` → `schema.prisma:L2385`
- `OrderAction` → `schema.prisma:L2708`
- `OrderCustomer` → `schema.prisma:L2512`
- `OrderDiscount` → `schema.prisma:L5539`
- `OrderItem` → `schema.prisma:L2528`
- `OrderItemModifier` → `schema.prisma:L2692`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8591`
- `OrganizationGoal` → `schema.prisma:L8549`
- `OrganizationModule` → `schema.prisma:L7593`
- `OrganizationPaymentConfig` → `schema.prisma:L4120`
- `OrganizationPayoutConfig` → `schema.prisma:L8617`
- `OrganizationPricingStructure` → `schema.prisma:L4152`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8572`
- `OtpChallenge` → `schema.prisma:L5072`
- `PartnerAPIKey` → `schema.prisma:L3950`
- `Payment` → `schema.prisma:L2741`
- `PaymentAllocation` → `schema.prisma:L2875`
- `PaymentLink` → `schema.prisma:L10062`
- `PaymentLinkAttribution` → `schema.prisma:L10170`
- `PaymentLinkItem` → `schema.prisma:L10125`
- `PaymentLinkItemModifier` → `schema.prisma:L10152`
- `PaymentProvider` → `schema.prisma:L3545`
- `PayrollLine` → `schema.prisma:L11407`
- `PayrollRun` → `schema.prisma:L11376`
- `PerformanceGoal` → `schema.prisma:L8526`
- `PermissionSet` → `schema.prisma:L1075`
- `PlatformCfdi` → `schema.prisma:L11688`
- `PlatformEmisor` → `schema.prisma:L11632`
- `PlatformSettings` → `schema.prisma:L3927`
- `PosCommand` → `schema.prisma:L5732`
- `PosConnectionStatus` → `schema.prisma:L732`
- `PricingPolicy` → `schema.prisma:L1874`
- `ProcessedStripeEvent` → `schema.prisma:L4300`
- `ProcessorReliabilityMetric` → `schema.prisma:L4785`
- `Product` → `schema.prisma:L1358`
- `ProductModifierGroup` → `schema.prisma:L2680`
- `ProductOption` → `schema.prisma:L10344`
- `ProductOptionValue` → `schema.prisma:L10355`
- `PromoterBankAccount` → `schema.prisma:L11527`
- `PromoterCommissionEntry` → `schema.prisma:L11546`
- `PromoterLocationPing` → `schema.prisma:L2358`
- `ProviderCostStructure` → `schema.prisma:L4336`
- `ProviderEventLog` → `schema.prisma:L4229`
- `PurchaseOrder` → `schema.prisma:L1788`
- `PurchaseOrderItem` → `schema.prisma:L1845`
- `RateCorrectionBatch` → `schema.prisma:L4561`
- `RateCorrectionEntry` → `schema.prisma:L4603`
- `RawMaterial` → `schema.prisma:L1577`
- `RawMaterialMovement` → `schema.prisma:L1927`
- `Recipe` → `schema.prisma:L1642`
- `RecipeLine` → `schema.prisma:L1666`
- `Referral` → `schema.prisma:L5204`
- `ReferralProgramConfig` → `schema.prisma:L5169`
- `ReferralRewardGrant` → `schema.prisma:L5295`
- `ReferralTierReward` → `schema.prisma:L5267`
- `ReferralTierUnlock` → `schema.prisma:L5340`
- `Reservation` → `schema.prisma:L9162`
- `ReservationGoogleEventMapping` → `schema.prisma:L9842`
- `ReservationModifier` → `schema.prisma:L9321`
- `ReservationReminderSent` → `schema.prisma:L9304`
- `ReservationSettings` → `schema.prisma:L9482`
- `ReservationWaitlistEntry` → `schema.prisma:L9450`
- `Review` → `schema.prisma:L3170`
- `SaleVerification` → `schema.prisma:L2929`
- `ScheduledCommand` → `schema.prisma:L7073`
- `SerializedItem` → `schema.prisma:L7664`
- `SerializedItemCustodyEvent` → `schema.prisma:L7827`
- `SettlementConfiguration` → `schema.prisma:L4636`
- `SettlementConfirmation` → `schema.prisma:L4749`
- `SettlementIncident` → `schema.prisma:L4700`
- `SettlementSimulation` → `schema.prisma:L4671`
- `Shift` → `schema.prisma:L2206`
- `SimRegistrationRequest` → `schema.prisma:L7865`
- `SimRegistrationRequestItem` → `schema.prisma:L7887`
- `SlotHold` → `schema.prisma:L9361`
- `Staff` → `schema.prisma:L752`
- `StaffOnboardingState` → `schema.prisma:L10573`
- `StaffOrganization` → `schema.prisma:L989`
- `StaffPasskey` → `schema.prisma:L1016`
- `StaffVenue` → `schema.prisma:L925`
- `StockAlertConfig` → `schema.prisma:L8508`
- `StockBatch` → `schema.prisma:L2046`
- `StockCount` → `schema.prisma:L1995`
- `StockCountItem` → `schema.prisma:L2016`
- `StripeWebhookEvent` → `schema.prisma:L4283`
- `Supplier` → `schema.prisma:L1701`
- `SupplierPricing` → `schema.prisma:L1754`
- `Table` → `schema.prisma:L2118`
- `Terminal` → `schema.prisma:L3221`
- `TerminalHealth` → `schema.prisma:L3365`
- `TerminalLog` → `schema.prisma:L3339`
- `TerminalOrder` → `schema.prisma:L3448`
- `TerminalOrderItem` → `schema.prisma:L3523`
- `TimeEntry` → `schema.prisma:L2271`
- `TimeEntryBreak` → `schema.prisma:L2340`
- `TokenPurchase` → `schema.prisma:L6747`
- `TokenUsageRecord` → `schema.prisma:L6719`
- `TpvCommandHistory` → `schema.prisma:L6979`
- `TpvCommandQueue` → `schema.prisma:L6919`
- `TpvFeedback` → `schema.prisma:L6632`
- `TpvMessage` → `schema.prisma:L8858`
- `TpvMessageDelivery` → `schema.prisma:L8910`
- `TpvMessageResponse` → `schema.prisma:L8933`
- `TrainingModule` → `schema.prisma:L8988`
- `TrainingProgress` → `schema.prisma:L9065`
- `TrainingQuizQuestion` → `schema.prisma:L9047`
- `TrainingStep` → `schema.prisma:L9027`
- `TransactionCost` → `schema.prisma:L4499`
- `UnitConversion` → `schema.prisma:L1905`
- `user_sessions` → `schema.prisma:L3985`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L627`
- `VenueChatSession` → `schema.prisma:L582`
- `VenueCommission` → `schema.prisma:L10505`
- `VenueCreditAssessment` → `schema.prisma:L7409`
- `VenueCryptoConfig` → `schema.prisma:L8725`
- `VenueFeature` → `schema.prisma:L3043`
- `VenueModule` → `schema.prisma:L7565`
- `VenuePaymentConfig` → `schema.prisma:L4086`
- `VenuePaymentLinkSettings` → `schema.prisma:L9875`
- `VenuePricingStructure` → `schema.prisma:L4439`
- `VenueRoleConfig` → `schema.prisma:L1104`
- `VenueRolePermission` → `schema.prisma:L1046`
- `VenueSettings` → `schema.prisma:L667`
- `VenueTransaction` → `schema.prisma:L2980`
- `VenueWhatsappActivation` → `schema.prisma:L518`
- `WebhookEvent` → `schema.prisma:L3079`
- `WebhookSubscription` → `schema.prisma:L4202`
- `WhatsappContactWindow` → `schema.prisma:L536`
- `WhatsappInboundEvent` → `schema.prisma:L556`
- `Zone` → `schema.prisma:L96`
