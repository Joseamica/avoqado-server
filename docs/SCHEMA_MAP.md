# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **229 models / 209 enums / ~10,800 lines**. Nobody reads it top to bottom. This file is the **index**: 20 domains,
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
| 12  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountMapping`, `Cfdi`, `CustomerTaxProfile`, `FiscalEmisor`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`                                                                                                                                                                                                                                                                                                                                                                                        |
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

- `AccountMapping` → `schema.prisma:L10758`
- `ActivityLog` → `schema.prisma:L4857`
- `Aggregator` → `schema.prisma:L10201`
- `AngelPayUserAccount` → `schema.prisma:L3666`
- `AppUpdate` → `schema.prisma:L8494`
- `Area` → `schema.prisma:L2076`
- `BankStatement` → `schema.prisma:L10632`
- `BankStatementLine` → `schema.prisma:L10653`
- `BulkCommandOperation` → `schema.prisma:L6866`
- `CalendarSyncOutbox` → `schema.prisma:L9604`
- `CampaignDelivery` → `schema.prisma:L8645`
- `CashCloseout` → `schema.prisma:L7199`
- `CashDeposit` → `schema.prisma:L8314`
- `CashDrawerEvent` → `schema.prisma:L10047`
- `CashDrawerSession` → `schema.prisma:L10023`
- `Cfdi` → `schema.prisma:L10535`
- `ChatbotTokenBudget` → `schema.prisma:L6514`
- `ChatConversation` → `schema.prisma:L6369`
- `ChatFeedback` → `schema.prisma:L6455`
- `ChatLearningEvent` → `schema.prisma:L6412`
- `ChatMessage` → `schema.prisma:L6392`
- `ChatTrainingData` → `schema.prisma:L6326`
- `CheckoutSession` → `schema.prisma:L3946`
- `ClassSession` → `schema.prisma:L9225`
- `CommissionCalculation` → `schema.prisma:L8093`
- `CommissionClawback` → `schema.prisma:L8266`
- `CommissionConfig` → `schema.prisma:L7866`
- `CommissionMilestone` → `schema.prisma:L8009`
- `CommissionOverride` → `schema.prisma:L7936`
- `CommissionPayout` → `schema.prisma:L8217`
- `CommissionSummary` → `schema.prisma:L8156`
- `CommissionTier` → `schema.prisma:L7973`
- `Consumer` → `schema.prisma:L4975`
- `ConsumerAuthAccount` → `schema.prisma:L5000`
- `CouponCode` → `schema.prisma:L5294`
- `CouponRedemption` → `schema.prisma:L5325`
- `CreditAssessmentHistory` → `schema.prisma:L7308`
- `CreditItemBalance` → `schema.prisma:L9813`
- `CreditOffer` → `schema.prisma:L7327`
- `CreditPack` → `schema.prisma:L9729`
- `CreditPackItem` → `schema.prisma:L9758`
- `CreditPackPurchase` → `schema.prisma:L9775`
- `CreditTransaction` → `schema.prisma:L9835`
- `Customer` → `schema.prisma:L4883`
- `CustomerDiscount` → `schema.prisma:L5345`
- `CustomerGroup` → `schema.prisma:L5034`
- `CustomerTaxProfile` → `schema.prisma:L10604`
- `DeviceToken` → `schema.prisma:L5540`
- `DigitalReceipt` → `schema.prisma:L2850`
- `Discount` → `schema.prisma:L5195`
- `EcommerceMerchant` → `schema.prisma:L3758`
- `EmailTemplate` → `schema.prisma:L8584`
- `Estimate` → `schema.prisma:L10108`
- `EstimateItem` → `schema.prisma:L10136`
- `ExternalBusyBlock` → `schema.prisma:L9497`
- `Feature` → `schema.prisma:L2979`
- `FeeSchedule` → `schema.prisma:L3057`
- `FeeTier` → `schema.prisma:L3068`
- `FiscalEmisor` → `schema.prisma:L10477`
- `FloorElement` → `schema.prisma:L2152`
- `GeofenceRule` → `schema.prisma:L6951`
- `GoogleCalendarChannel` → `schema.prisma:L9474`
- `GoogleCalendarConnection` → `schema.prisma:L9426`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9527`
- `GoogleOAuthSession` → `schema.prisma:L9549`
- `HolidayCalendar` → `schema.prisma:L4781`
- `IdempotencyRequest` → `schema.prisma:L7741`
- `Inventory` → `schema.prisma:L1507`
- `InventoryMovement` → `schema.prisma:L1531`
- `InventoryTransfer` → `schema.prisma:L10080`
- `Invitation` → `schema.prisma:L1111`
- `Invoice` → `schema.prisma:L3080`
- `InvoiceItem` → `schema.prisma:L3106`
- `ItemCategory` → `schema.prisma:L7459`
- `JournalEntry` → `schema.prisma:L10801`
- `JournalLine` → `schema.prisma:L10829`
- `KdsOrder` → `schema.prisma:L10241`
- `KdsOrderItem` → `schema.prisma:L10258`
- `LearnedPatterns` → `schema.prisma:L6436`
- `LedgerAccount` → `schema.prisma:L10708`
- `LiveDemoSession` → `schema.prisma:L646`
- `LowStockAlert` → `schema.prisma:L1947`
- `LoyaltyConfig` → `schema.prisma:L5064`
- `LoyaltyTransaction` → `schema.prisma:L5087`
- `MarketingCampaign` → `schema.prisma:L8602`
- `McpAuthCode` → `schema.prisma:L10384`
- `McpOAuthClient` → `schema.prisma:L10368`
- `McpRefreshToken` → `schema.prisma:L10402`
- `MeasurementUnit` → `schema.prisma:L10186`
- `Menu` → `schema.prisma:L1292`
- `MenuCategory` → `schema.prisma:L1234`
- `MenuCategoryAssignment` → `schema.prisma:L1327`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10317`
- `MerchantAccount` → `schema.prisma:L3540`
- `MerchantFiscalConfig` → `schema.prisma:L10513`
- `MerchantRevenueShare` → `schema.prisma:L4361`
- `MilestoneAchievement` → `schema.prisma:L8054`
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
- `OrganizationAttendanceConfig` → `schema.prisma:L8428`
- `OrganizationGoal` → `schema.prisma:L8386`
- `OrganizationModule` → `schema.prisma:L7431`
- `OrganizationPaymentConfig` → `schema.prisma:L4070`
- `OrganizationPayoutConfig` → `schema.prisma:L8454`
- `OrganizationPricingStructure` → `schema.prisma:L4102`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8409`
- `OtpChallenge` → `schema.prisma:L5019`
- `PartnerAPIKey` → `schema.prisma:L3900`
- `Payment` → `schema.prisma:L2695`
- `PaymentAllocation` → `schema.prisma:L2829`
- `PaymentLink` → `schema.prisma:L9881`
- `PaymentLinkAttribution` → `schema.prisma:L9989`
- `PaymentLinkItem` → `schema.prisma:L9944`
- `PaymentLinkItemModifier` → `schema.prisma:L9971`
- `PaymentProvider` → `schema.prisma:L3499`
- `PerformanceGoal` → `schema.prisma:L8363`
- `PermissionSet` → `schema.prisma:L1062`
- `PlatformSettings` → `schema.prisma:L3877`
- `PosCommand` → `schema.prisma:L5570`
- `PosConnectionStatus` → `schema.prisma:L722`
- `PricingPolicy` → `schema.prisma:L1858`
- `ProcessedStripeEvent` → `schema.prisma:L4250`
- `ProcessorReliabilityMetric` → `schema.prisma:L4735`
- `Product` → `schema.prisma:L1345`
- `ProductModifierGroup` → `schema.prisma:L2634`
- `ProductOption` → `schema.prisma:L10163`
- `ProductOptionValue` → `schema.prisma:L10174`
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
- `Reservation` → `schema.prisma:L8981`
- `ReservationGoogleEventMapping` → `schema.prisma:L9661`
- `ReservationModifier` → `schema.prisma:L9140`
- `ReservationReminderSent` → `schema.prisma:L9123`
- `ReservationSettings` → `schema.prisma:L9301`
- `ReservationWaitlistEntry` → `schema.prisma:L9269`
- `Review` → `schema.prisma:L3124`
- `SaleVerification` → `schema.prisma:L2883`
- `ScheduledCommand` → `schema.prisma:L6911`
- `SerializedItem` → `schema.prisma:L7502`
- `SerializedItemCustodyEvent` → `schema.prisma:L7664`
- `SettlementConfiguration` → `schema.prisma:L4586`
- `SettlementConfirmation` → `schema.prisma:L4699`
- `SettlementIncident` → `schema.prisma:L4650`
- `SettlementSimulation` → `schema.prisma:L4621`
- `Shift` → `schema.prisma:L2190`
- `SimRegistrationRequest` → `schema.prisma:L7702`
- `SimRegistrationRequestItem` → `schema.prisma:L7724`
- `SlotHold` → `schema.prisma:L9180`
- `Staff` → `schema.prisma:L742`
- `StaffOnboardingState` → `schema.prisma:L10287`
- `StaffOrganization` → `schema.prisma:L976`
- `StaffPasskey` → `schema.prisma:L1003`
- `StaffVenue` → `schema.prisma:L912`
- `StockAlertConfig` → `schema.prisma:L8345`
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
- `TpvMessage` → `schema.prisma:L8677`
- `TpvMessageDelivery` → `schema.prisma:L8729`
- `TpvMessageResponse` → `schema.prisma:L8752`
- `TrainingModule` → `schema.prisma:L8807`
- `TrainingProgress` → `schema.prisma:L8884`
- `TrainingQuizQuestion` → `schema.prisma:L8866`
- `TrainingStep` → `schema.prisma:L8846`
- `TransactionCost` → `schema.prisma:L4449`
- `UnitConversion` → `schema.prisma:L1889`
- `user_sessions` → `schema.prisma:L3935`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L622`
- `VenueChatSession` → `schema.prisma:L577`
- `VenueCommission` → `schema.prisma:L10219`
- `VenueCreditAssessment` → `schema.prisma:L7247`
- `VenueCryptoConfig` → `schema.prisma:L8544`
- `VenueFeature` → `schema.prisma:L2997`
- `VenueModule` → `schema.prisma:L7403`
- `VenuePaymentConfig` → `schema.prisma:L4036`
- `VenuePaymentLinkSettings` → `schema.prisma:L9694`
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
