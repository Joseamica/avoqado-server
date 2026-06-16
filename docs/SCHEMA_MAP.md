# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **225 models / 203 enums / ~10,600 lines**. Nobody reads it top to bottom. This file is the **index**: 20 domains,
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
| 12  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `Cfdi`, `CustomerTaxProfile`, `FiscalEmisor`, `MerchantFiscalConfig`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 13  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                             |
| 14  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig`                                                                                                                                                                                                                                                                                  |
| 15  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `VenueCommission`                                                                                                                                                                                                                                    |
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

- `ActivityLog` → `schema.prisma:L4852`
- `Aggregator` → `schema.prisma:L10196`
- `AngelPayUserAccount` → `schema.prisma:L3661`
- `AppUpdate` → `schema.prisma:L8489`
- `Area` → `schema.prisma:L2071`
- `BankStatement` → `schema.prisma:L10627`
- `BankStatementLine` → `schema.prisma:L10648`
- `BulkCommandOperation` → `schema.prisma:L6861`
- `CalendarSyncOutbox` → `schema.prisma:L9599`
- `CampaignDelivery` → `schema.prisma:L8640`
- `CashCloseout` → `schema.prisma:L7194`
- `CashDeposit` → `schema.prisma:L8309`
- `CashDrawerEvent` → `schema.prisma:L10042`
- `CashDrawerSession` → `schema.prisma:L10018`
- `Cfdi` → `schema.prisma:L10530`
- `ChatbotTokenBudget` → `schema.prisma:L6509`
- `ChatConversation` → `schema.prisma:L6364`
- `ChatFeedback` → `schema.prisma:L6450`
- `ChatLearningEvent` → `schema.prisma:L6407`
- `ChatMessage` → `schema.prisma:L6387`
- `ChatTrainingData` → `schema.prisma:L6321`
- `CheckoutSession` → `schema.prisma:L3941`
- `ClassSession` → `schema.prisma:L9220`
- `CommissionCalculation` → `schema.prisma:L8088`
- `CommissionClawback` → `schema.prisma:L8261`
- `CommissionConfig` → `schema.prisma:L7861`
- `CommissionMilestone` → `schema.prisma:L8004`
- `CommissionOverride` → `schema.prisma:L7931`
- `CommissionPayout` → `schema.prisma:L8212`
- `CommissionSummary` → `schema.prisma:L8151`
- `CommissionTier` → `schema.prisma:L7968`
- `Consumer` → `schema.prisma:L4970`
- `ConsumerAuthAccount` → `schema.prisma:L4995`
- `CouponCode` → `schema.prisma:L5289`
- `CouponRedemption` → `schema.prisma:L5320`
- `CreditAssessmentHistory` → `schema.prisma:L7303`
- `CreditItemBalance` → `schema.prisma:L9808`
- `CreditOffer` → `schema.prisma:L7322`
- `CreditPack` → `schema.prisma:L9724`
- `CreditPackItem` → `schema.prisma:L9753`
- `CreditPackPurchase` → `schema.prisma:L9770`
- `CreditTransaction` → `schema.prisma:L9830`
- `Customer` → `schema.prisma:L4878`
- `CustomerDiscount` → `schema.prisma:L5340`
- `CustomerGroup` → `schema.prisma:L5029`
- `CustomerTaxProfile` → `schema.prisma:L10599`
- `DeviceToken` → `schema.prisma:L5535`
- `DigitalReceipt` → `schema.prisma:L2845`
- `Discount` → `schema.prisma:L5190`
- `EcommerceMerchant` → `schema.prisma:L3753`
- `EmailTemplate` → `schema.prisma:L8579`
- `Estimate` → `schema.prisma:L10103`
- `EstimateItem` → `schema.prisma:L10131`
- `ExternalBusyBlock` → `schema.prisma:L9492`
- `Feature` → `schema.prisma:L2974`
- `FeeSchedule` → `schema.prisma:L3052`
- `FeeTier` → `schema.prisma:L3063`
- `FiscalEmisor` → `schema.prisma:L10472`
- `FloorElement` → `schema.prisma:L2147`
- `GeofenceRule` → `schema.prisma:L6946`
- `GoogleCalendarChannel` → `schema.prisma:L9469`
- `GoogleCalendarConnection` → `schema.prisma:L9421`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9522`
- `GoogleOAuthSession` → `schema.prisma:L9544`
- `HolidayCalendar` → `schema.prisma:L4776`
- `IdempotencyRequest` → `schema.prisma:L7736`
- `Inventory` → `schema.prisma:L1502`
- `InventoryMovement` → `schema.prisma:L1526`
- `InventoryTransfer` → `schema.prisma:L10075`
- `Invitation` → `schema.prisma:L1106`
- `Invoice` → `schema.prisma:L3075`
- `InvoiceItem` → `schema.prisma:L3101`
- `ItemCategory` → `schema.prisma:L7454`
- `KdsOrder` → `schema.prisma:L10236`
- `KdsOrderItem` → `schema.prisma:L10253`
- `LearnedPatterns` → `schema.prisma:L6431`
- `LiveDemoSession` → `schema.prisma:L641`
- `LowStockAlert` → `schema.prisma:L1942`
- `LoyaltyConfig` → `schema.prisma:L5059`
- `LoyaltyTransaction` → `schema.prisma:L5082`
- `MarketingCampaign` → `schema.prisma:L8597`
- `McpAuthCode` → `schema.prisma:L10379`
- `McpOAuthClient` → `schema.prisma:L10363`
- `McpRefreshToken` → `schema.prisma:L10397`
- `MeasurementUnit` → `schema.prisma:L10181`
- `Menu` → `schema.prisma:L1287`
- `MenuCategory` → `schema.prisma:L1229`
- `MenuCategoryAssignment` → `schema.prisma:L1322`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10312`
- `MerchantAccount` → `schema.prisma:L3535`
- `MerchantFiscalConfig` → `schema.prisma:L10508`
- `MerchantRevenueShare` → `schema.prisma:L4356`
- `MilestoneAchievement` → `schema.prisma:L8049`
- `Modifier` → `schema.prisma:L2592`
- `ModifierGroup` → `schema.prisma:L2556`
- `Module` → `schema.prisma:L7370`
- `MoneyAnomaly` → `schema.prisma:L4259`
- `MonthlyVenueProfit` → `schema.prisma:L4802`
- `Notification` → `schema.prisma:L5437`
- `NotificationPreference` → `schema.prisma:L5484`
- `NotificationTemplate` → `schema.prisma:L5511`
- `OAuthState` → `schema.prisma:L1157`
- `OnboardingProgress` → `schema.prisma:L1175`
- `Order` → `schema.prisma:L2334`
- `OrderAction` → `schema.prisma:L2657`
- `OrderCustomer` → `schema.prisma:L2461`
- `OrderDiscount` → `schema.prisma:L5372`
- `OrderItem` → `schema.prisma:L2477`
- `OrderItemModifier` → `schema.prisma:L2641`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8423`
- `OrganizationGoal` → `schema.prisma:L8381`
- `OrganizationModule` → `schema.prisma:L7426`
- `OrganizationPaymentConfig` → `schema.prisma:L4065`
- `OrganizationPayoutConfig` → `schema.prisma:L8449`
- `OrganizationPricingStructure` → `schema.prisma:L4097`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8404`
- `OtpChallenge` → `schema.prisma:L5014`
- `PartnerAPIKey` → `schema.prisma:L3895`
- `Payment` → `schema.prisma:L2690`
- `PaymentAllocation` → `schema.prisma:L2824`
- `PaymentLink` → `schema.prisma:L9876`
- `PaymentLinkAttribution` → `schema.prisma:L9984`
- `PaymentLinkItem` → `schema.prisma:L9939`
- `PaymentLinkItemModifier` → `schema.prisma:L9966`
- `PaymentProvider` → `schema.prisma:L3494`
- `PerformanceGoal` → `schema.prisma:L8358`
- `PermissionSet` → `schema.prisma:L1057`
- `PlatformSettings` → `schema.prisma:L3872`
- `PosCommand` → `schema.prisma:L5565`
- `PosConnectionStatus` → `schema.prisma:L717`
- `PricingPolicy` → `schema.prisma:L1853`
- `ProcessedStripeEvent` → `schema.prisma:L4245`
- `ProcessorReliabilityMetric` → `schema.prisma:L4730`
- `Product` → `schema.prisma:L1340`
- `ProductModifierGroup` → `schema.prisma:L2629`
- `ProductOption` → `schema.prisma:L10158`
- `ProductOptionValue` → `schema.prisma:L10169`
- `ProviderCostStructure` → `schema.prisma:L4281`
- `ProviderEventLog` → `schema.prisma:L4174`
- `PurchaseOrder` → `schema.prisma:L1767`
- `PurchaseOrderItem` → `schema.prisma:L1824`
- `RateCorrectionBatch` → `schema.prisma:L4506`
- `RateCorrectionEntry` → `schema.prisma:L4548`
- `RawMaterial` → `schema.prisma:L1556`
- `RawMaterialMovement` → `schema.prisma:L1906`
- `Recipe` → `schema.prisma:L1621`
- `RecipeLine` → `schema.prisma:L1645`
- `Referral` → `schema.prisma:L5144`
- `ReferralProgramConfig` → `schema.prisma:L5111`
- `Reservation` → `schema.prisma:L8976`
- `ReservationGoogleEventMapping` → `schema.prisma:L9656`
- `ReservationModifier` → `schema.prisma:L9135`
- `ReservationReminderSent` → `schema.prisma:L9118`
- `ReservationSettings` → `schema.prisma:L9296`
- `ReservationWaitlistEntry` → `schema.prisma:L9264`
- `Review` → `schema.prisma:L3119`
- `SaleVerification` → `schema.prisma:L2878`
- `ScheduledCommand` → `schema.prisma:L6906`
- `SerializedItem` → `schema.prisma:L7497`
- `SerializedItemCustodyEvent` → `schema.prisma:L7659`
- `SettlementConfiguration` → `schema.prisma:L4581`
- `SettlementConfirmation` → `schema.prisma:L4694`
- `SettlementIncident` → `schema.prisma:L4645`
- `SettlementSimulation` → `schema.prisma:L4616`
- `Shift` → `schema.prisma:L2185`
- `SimRegistrationRequest` → `schema.prisma:L7697`
- `SimRegistrationRequestItem` → `schema.prisma:L7719`
- `SlotHold` → `schema.prisma:L9175`
- `Staff` → `schema.prisma:L737`
- `StaffOnboardingState` → `schema.prisma:L10282`
- `StaffOrganization` → `schema.prisma:L971`
- `StaffPasskey` → `schema.prisma:L998`
- `StaffVenue` → `schema.prisma:L907`
- `StockAlertConfig` → `schema.prisma:L8340`
- `StockBatch` → `schema.prisma:L2025`
- `StockCount` → `schema.prisma:L1974`
- `StockCountItem` → `schema.prisma:L1995`
- `StripeWebhookEvent` → `schema.prisma:L4228`
- `Supplier` → `schema.prisma:L1680`
- `SupplierPricing` → `schema.prisma:L1733`
- `Table` → `schema.prisma:L2097`
- `Terminal` → `schema.prisma:L3170`
- `TerminalHealth` → `schema.prisma:L3314`
- `TerminalLog` → `schema.prisma:L3288`
- `TerminalOrder` → `schema.prisma:L3397`
- `TerminalOrderItem` → `schema.prisma:L3472`
- `TimeEntry` → `schema.prisma:L2250`
- `TimeEntryBreak` → `schema.prisma:L2319`
- `TokenPurchase` → `schema.prisma:L6580`
- `TokenUsageRecord` → `schema.prisma:L6552`
- `TpvCommandHistory` → `schema.prisma:L6812`
- `TpvCommandQueue` → `schema.prisma:L6752`
- `TpvFeedback` → `schema.prisma:L6465`
- `TpvMessage` → `schema.prisma:L8672`
- `TpvMessageDelivery` → `schema.prisma:L8724`
- `TpvMessageResponse` → `schema.prisma:L8747`
- `TrainingModule` → `schema.prisma:L8802`
- `TrainingProgress` → `schema.prisma:L8879`
- `TrainingQuizQuestion` → `schema.prisma:L8861`
- `TrainingStep` → `schema.prisma:L8841`
- `TransactionCost` → `schema.prisma:L4444`
- `UnitConversion` → `schema.prisma:L1884`
- `user_sessions` → `schema.prisma:L3930`
- `Venue` → `schema.prisma:L108`
- `VenueChatMessage` → `schema.prisma:L617`
- `VenueChatSession` → `schema.prisma:L572`
- `VenueCommission` → `schema.prisma:L10214`
- `VenueCreditAssessment` → `schema.prisma:L7242`
- `VenueCryptoConfig` → `schema.prisma:L8539`
- `VenueFeature` → `schema.prisma:L2992`
- `VenueModule` → `schema.prisma:L7398`
- `VenuePaymentConfig` → `schema.prisma:L4031`
- `VenuePaymentLinkSettings` → `schema.prisma:L9689`
- `VenuePricingStructure` → `schema.prisma:L4384`
- `VenueRoleConfig` → `schema.prisma:L1086`
- `VenueRolePermission` → `schema.prisma:L1028`
- `VenueSettings` → `schema.prisma:L657`
- `VenueTransaction` → `schema.prisma:L2929`
- `VenueWhatsappActivation` → `schema.prisma:L508`
- `WebhookEvent` → `schema.prisma:L3028`
- `WebhookSubscription` → `schema.prisma:L4147`
- `WhatsappContactWindow` → `schema.prisma:L526`
- `WhatsappInboundEvent` → `schema.prisma:L546`
- `Zone` → `schema.prisma:L91`
