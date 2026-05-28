# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **209 models / 181 enums / ~9,900 lines**. Nobody reads it top to bottom. This file is the **index**: 20 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 20 domains

| #   | Domain                                  | What it is                                                                                   | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.            | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                            | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                     |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                        | `DeviceToken`, `Invitation`, `OAuthState`, `PermissionSet`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                              |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                              | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                 |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                    | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                  |
| 6   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.             | `Inventory`, `InventoryMovement`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                                                                                                                                   |
| 7   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.     | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 8   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.               | `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderItem`, `OrderItemModifier`, `Shift`                                                                                                                                                                                                                                                                                                        |
| 9   | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                            | `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                       |
| 10  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.            | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig` |
| 11  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                 | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                             |
| 12  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.             | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                             |
| 13  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                          | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`                                                                                                                                                                                                                                                                                                                       |
| 14  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                   | `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `VenueCommission`                                                                                                                                                                                                                                    |
| 15  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                            | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`                                                                                                                                                                        |
| 16  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                   | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`                                                                                                                                                                                                                               |
| 17  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                     | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                |
| 18  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.               | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 19  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                 | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerGroup`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 20  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings. | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                     |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `ActivityLog` → `schema.prisma:L4621`
- `Aggregator` → `schema.prisma:L9750`
- `AngelPayUserAccount` → `schema.prisma:L3432`
- `AppUpdate` → `schema.prisma:L8044`
- `Area` → `schema.prisma:L1987`
- `BulkCommandOperation` → `schema.prisma:L6499`
- `CalendarSyncOutbox` → `schema.prisma:L9153`
- `CampaignDelivery` → `schema.prisma:L8194`
- `CashCloseout` → `schema.prisma:L6832`
- `CashDeposit` → `schema.prisma:L7871`
- `CashDrawerEvent` → `schema.prisma:L9596`
- `CashDrawerSession` → `schema.prisma:L9572`
- `ChatbotTokenBudget` → `schema.prisma:L6147`
- `ChatConversation` → `schema.prisma:L6002`
- `ChatFeedback` → `schema.prisma:L6088`
- `ChatLearningEvent` → `schema.prisma:L6045`
- `ChatMessage` → `schema.prisma:L6025`
- `ChatTrainingData` → `schema.prisma:L5959`
- `CheckoutSession` → `schema.prisma:L3710`
- `ClassSession` → `schema.prisma:L8774`
- `CommissionCalculation` → `schema.prisma:L7650`
- `CommissionClawback` → `schema.prisma:L7823`
- `CommissionConfig` → `schema.prisma:L7428`
- `CommissionMilestone` → `schema.prisma:L7566`
- `CommissionOverride` → `schema.prisma:L7498`
- `CommissionPayout` → `schema.prisma:L7774`
- `CommissionSummary` → `schema.prisma:L7713`
- `CommissionTier` → `schema.prisma:L7535`
- `Consumer` → `schema.prisma:L4721`
- `ConsumerAuthAccount` → `schema.prisma:L4746`
- `CouponCode` → `schema.prisma:L4936`
- `CouponRedemption` → `schema.prisma:L4967`
- `CreditAssessmentHistory` → `schema.prisma:L6941`
- `CreditItemBalance` → `schema.prisma:L9362`
- `CreditOffer` → `schema.prisma:L6960`
- `CreditPack` → `schema.prisma:L9278`
- `CreditPackItem` → `schema.prisma:L9307`
- `CreditPackPurchase` → `schema.prisma:L9324`
- `CreditTransaction` → `schema.prisma:L9384`
- `Customer` → `schema.prisma:L4647`
- `CustomerDiscount` → `schema.prisma:L4987`
- `CustomerGroup` → `schema.prisma:L4765`
- `DeviceToken` → `schema.prisma:L5182`
- `DigitalReceipt` → `schema.prisma:L2755`
- `Discount` → `schema.prisma:L4847`
- `EcommerceMerchant` → `schema.prisma:L3525`
- `EmailTemplate` → `schema.prisma:L8133`
- `Estimate` → `schema.prisma:L9657`
- `EstimateItem` → `schema.prisma:L9685`
- `ExternalBusyBlock` → `schema.prisma:L9046`
- `Feature` → `schema.prisma:L2884`
- `FeeSchedule` → `schema.prisma:L2959`
- `FeeTier` → `schema.prisma:L2970`
- `FloorElement` → `schema.prisma:L2063`
- `GeofenceRule` → `schema.prisma:L6584`
- `GoogleCalendarChannel` → `schema.prisma:L9023`
- `GoogleCalendarConnection` → `schema.prisma:L8975`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9076`
- `GoogleOAuthSession` → `schema.prisma:L9098`
- `HolidayCalendar` → `schema.prisma:L4545`
- `IdempotencyRequest` → `schema.prisma:L7312`
- `Inventory` → `schema.prisma:L1419`
- `InventoryMovement` → `schema.prisma:L1443`
- `InventoryTransfer` → `schema.prisma:L9629`
- `Invitation` → `schema.prisma:L1032`
- `Invoice` → `schema.prisma:L2982`
- `InvoiceItem` → `schema.prisma:L3008`
- `ItemCategory` → `schema.prisma:L7092`
- `KdsOrder` → `schema.prisma:L9790`
- `KdsOrderItem` → `schema.prisma:L9807`
- `LearnedPatterns` → `schema.prisma:L6069`
- `LiveDemoSession` → `schema.prisma:L583`
- `LowStockAlert` → `schema.prisma:L1858`
- `LoyaltyConfig` → `schema.prisma:L4795`
- `LoyaltyTransaction` → `schema.prisma:L4818`
- `MarketingCampaign` → `schema.prisma:L8151`
- `MeasurementUnit` → `schema.prisma:L9735`
- `Menu` → `schema.prisma:L1209`
- `MenuCategory` → `schema.prisma:L1155`
- `MenuCategoryAssignment` → `schema.prisma:L1244`
- `MercadoPagoWebhookEvent` → `schema.prisma:L9866`
- `MerchantAccount` → `schema.prisma:L3321`
- `MerchantRevenueShare` → `schema.prisma:L4125`
- `MilestoneAchievement` → `schema.prisma:L7611`
- `Modifier` → `schema.prisma:L2502`
- `ModifierGroup` → `schema.prisma:L2466`
- `Module` → `schema.prisma:L7008`
- `MoneyAnomaly` → `schema.prisma:L4028`
- `MonthlyVenueProfit` → `schema.prisma:L4571`
- `Notification` → `schema.prisma:L5084`
- `NotificationPreference` → `schema.prisma:L5131`
- `NotificationTemplate` → `schema.prisma:L5158`
- `OAuthState` → `schema.prisma:L1083`
- `OnboardingProgress` → `schema.prisma:L1101`
- `Order` → `schema.prisma:L2250`
- `OrderAction` → `schema.prisma:L2567`
- `OrderCustomer` → `schema.prisma:L2371`
- `OrderDiscount` → `schema.prisma:L5019`
- `OrderItem` → `schema.prisma:L2387`
- `OrderItemModifier` → `schema.prisma:L2551`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L7985`
- `OrganizationGoal` → `schema.prisma:L7943`
- `OrganizationModule` → `schema.prisma:L7064`
- `OrganizationPaymentConfig` → `schema.prisma:L3834`
- `OrganizationPayoutConfig` → `schema.prisma:L8011`
- `OrganizationPricingStructure` → `schema.prisma:L3866`
- `OrganizationSalesGoalConfig` → `schema.prisma:L7966`
- `PartnerAPIKey` → `schema.prisma:L3664`
- `Payment` → `schema.prisma:L2600`
- `PaymentAllocation` → `schema.prisma:L2734`
- `PaymentLink` → `schema.prisma:L9430`
- `PaymentLinkAttribution` → `schema.prisma:L9538`
- `PaymentLinkItem` → `schema.prisma:L9493`
- `PaymentLinkItemModifier` → `schema.prisma:L9520`
- `PaymentProvider` → `schema.prisma:L3280`
- `PerformanceGoal` → `schema.prisma:L7920`
- `PermissionSet` → `schema.prisma:L983`
- `PlatformSettings` → `schema.prisma:L3641`
- `PosCommand` → `schema.prisma:L5212`
- `PosConnectionStatus` → `schema.prisma:L659`
- `PricingPolicy` → `schema.prisma:L1769`
- `ProcessedStripeEvent` → `schema.prisma:L4014`
- `ProcessorReliabilityMetric` → `schema.prisma:L4499`
- `Product` → `schema.prisma:L1262`
- `ProductModifierGroup` → `schema.prisma:L2539`
- `ProductOption` → `schema.prisma:L9712`
- `ProductOptionValue` → `schema.prisma:L9723`
- `ProviderCostStructure` → `schema.prisma:L4050`
- `ProviderEventLog` → `schema.prisma:L3943`
- `PurchaseOrder` → `schema.prisma:L1684`
- `PurchaseOrderItem` → `schema.prisma:L1740`
- `RateCorrectionBatch` → `schema.prisma:L4275`
- `RateCorrectionEntry` → `schema.prisma:L4317`
- `RawMaterial` → `schema.prisma:L1473`
- `RawMaterialMovement` → `schema.prisma:L1822`
- `Recipe` → `schema.prisma:L1538`
- `RecipeLine` → `schema.prisma:L1562`
- `Reservation` → `schema.prisma:L8530`
- `ReservationGoogleEventMapping` → `schema.prisma:L9210`
- `ReservationModifier` → `schema.prisma:L8689`
- `ReservationReminderSent` → `schema.prisma:L8672`
- `ReservationSettings` → `schema.prisma:L8850`
- `ReservationWaitlistEntry` → `schema.prisma:L8818`
- `Review` → `schema.prisma:L3026`
- `SaleVerification` → `schema.prisma:L2788`
- `ScheduledCommand` → `schema.prisma:L6544`
- `SerializedItem` → `schema.prisma:L7134`
- `SerializedItemCustodyEvent` → `schema.prisma:L7288`
- `SettlementConfiguration` → `schema.prisma:L4350`
- `SettlementConfirmation` → `schema.prisma:L4463`
- `SettlementIncident` → `schema.prisma:L4414`
- `SettlementSimulation` → `schema.prisma:L4385`
- `Shift` → `schema.prisma:L2101`
- `SlotHold` → `schema.prisma:L8729`
- `Staff` → `schema.prisma:L679`
- `StaffOnboardingState` → `schema.prisma:L9836`
- `StaffOrganization` → `schema.prisma:L897`
- `StaffPasskey` → `schema.prisma:L924`
- `StaffVenue` → `schema.prisma:L842`
- `StockAlertConfig` → `schema.prisma:L7902`
- `StockBatch` → `schema.prisma:L1941`
- `StockCount` → `schema.prisma:L1890`
- `StockCountItem` → `schema.prisma:L1911`
- `StripeWebhookEvent` → `schema.prisma:L3997`
- `Supplier` → `schema.prisma:L1597`
- `SupplierPricing` → `schema.prisma:L1650`
- `Table` → `schema.prisma:L2013`
- `Terminal` → `schema.prisma:L3077`
- `TerminalHealth` → `schema.prisma:L3213`
- `TerminalLog` → `schema.prisma:L3187`
- `TimeEntry` → `schema.prisma:L2166`
- `TimeEntryBreak` → `schema.prisma:L2235`
- `TokenPurchase` → `schema.prisma:L6218`
- `TokenUsageRecord` → `schema.prisma:L6190`
- `TpvCommandHistory` → `schema.prisma:L6450`
- `TpvCommandQueue` → `schema.prisma:L6390`
- `TpvFeedback` → `schema.prisma:L6103`
- `TpvMessage` → `schema.prisma:L8226`
- `TpvMessageDelivery` → `schema.prisma:L8278`
- `TpvMessageResponse` → `schema.prisma:L8301`
- `TrainingModule` → `schema.prisma:L8356`
- `TrainingProgress` → `schema.prisma:L8433`
- `TrainingQuizQuestion` → `schema.prisma:L8415`
- `TrainingStep` → `schema.prisma:L8395`
- `TransactionCost` → `schema.prisma:L4213`
- `UnitConversion` → `schema.prisma:L1800`
- `user_sessions` → `schema.prisma:L3699`
- `Venue` → `schema.prisma:L105`
- `VenueChatMessage` → `schema.prisma:L559`
- `VenueChatSession` → `schema.prisma:L514`
- `VenueCommission` → `schema.prisma:L9768`
- `VenueCreditAssessment` → `schema.prisma:L6880`
- `VenueCryptoConfig` → `schema.prisma:L8093`
- `VenueFeature` → `schema.prisma:L2902`
- `VenueModule` → `schema.prisma:L7036`
- `VenuePaymentConfig` → `schema.prisma:L3800`
- `VenuePaymentLinkSettings` → `schema.prisma:L9243`
- `VenuePricingStructure` → `schema.prisma:L4153`
- `VenueRoleConfig` → `schema.prisma:L1012`
- `VenueRolePermission` → `schema.prisma:L954`
- `VenueSettings` → `schema.prisma:L599`
- `VenueTransaction` → `schema.prisma:L2839`
- `VenueWhatsappActivation` → `schema.prisma:L450`
- `WebhookEvent` → `schema.prisma:L2935`
- `WebhookSubscription` → `schema.prisma:L3916`
- `WhatsappContactWindow` → `schema.prisma:L468`
- `WhatsappInboundEvent` → `schema.prisma:L488`
- `Zone` → `schema.prisma:L88`
