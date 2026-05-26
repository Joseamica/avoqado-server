# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **207 models / 179 enums / ~9,700 lines**. Nobody reads it top to bottom. This file is the **index**: 20 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 20 domains

| #   | Domain                                  | What it is                                                                                   | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.            | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                               |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                            | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                       |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                        | `DeviceToken`, `Invitation`, `OAuthState`, `PermissionSet`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                              | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                   |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                    | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                    |
| 6   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.             | `Inventory`, `InventoryMovement`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                                                                                     |
| 7   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.     | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`                                                                                                                                                                                                                                                                                                                                                                                                              |
| 8   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.               | `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderItem`, `OrderItemModifier`, `Shift`                                                                                                                                                                                                                                                          |
| 9   | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                            | `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                         |
| 10  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.            | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig` |
| 11  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                 | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                               |
| 12  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.             | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                               |
| 13  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                          | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`                                                                                                                                                                                                                                                                         |
| 14  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                   | `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `VenueCommission`                                                                                                                                                                                      |
| 15  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                            | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`                                                                                                                          |
| 16  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                   | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`                                                                                                                                                                                 |
| 17  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                     | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                  |
| 18  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.               | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                 | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerGroup`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                        |
| 20  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings. | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                       |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `ActivityLog` → `schema.prisma:L4510`
- `Aggregator` → `schema.prisma:L9639`
- `AngelPayUserAccount` → `schema.prisma:L3408`
- `AppUpdate` → `schema.prisma:L7933`
- `Area` → `schema.prisma:L1969`
- `BulkCommandOperation` → `schema.prisma:L6388`
- `CalendarSyncOutbox` → `schema.prisma:L9042`
- `CampaignDelivery` → `schema.prisma:L8083`
- `CashCloseout` → `schema.prisma:L6721`
- `CashDeposit` → `schema.prisma:L7760`
- `CashDrawerEvent` → `schema.prisma:L9485`
- `CashDrawerSession` → `schema.prisma:L9461`
- `ChatbotTokenBudget` → `schema.prisma:L6036`
- `ChatConversation` → `schema.prisma:L5891`
- `ChatFeedback` → `schema.prisma:L5977`
- `ChatLearningEvent` → `schema.prisma:L5934`
- `ChatMessage` → `schema.prisma:L5914`
- `ChatTrainingData` → `schema.prisma:L5848`
- `CheckoutSession` → `schema.prisma:L3686`
- `ClassSession` → `schema.prisma:L8663`
- `CommissionCalculation` → `schema.prisma:L7539`
- `CommissionClawback` → `schema.prisma:L7712`
- `CommissionConfig` → `schema.prisma:L7317`
- `CommissionMilestone` → `schema.prisma:L7455`
- `CommissionOverride` → `schema.prisma:L7387`
- `CommissionPayout` → `schema.prisma:L7663`
- `CommissionSummary` → `schema.prisma:L7602`
- `CommissionTier` → `schema.prisma:L7424`
- `Consumer` → `schema.prisma:L4610`
- `ConsumerAuthAccount` → `schema.prisma:L4635`
- `CouponCode` → `schema.prisma:L4825`
- `CouponRedemption` → `schema.prisma:L4856`
- `CreditAssessmentHistory` → `schema.prisma:L6830`
- `CreditItemBalance` → `schema.prisma:L9251`
- `CreditOffer` → `schema.prisma:L6849`
- `CreditPack` → `schema.prisma:L9167`
- `CreditPackItem` → `schema.prisma:L9196`
- `CreditPackPurchase` → `schema.prisma:L9213`
- `CreditTransaction` → `schema.prisma:L9273`
- `Customer` → `schema.prisma:L4536`
- `CustomerDiscount` → `schema.prisma:L4876`
- `CustomerGroup` → `schema.prisma:L4654`
- `DeviceToken` → `schema.prisma:L5071`
- `DigitalReceipt` → `schema.prisma:L2734`
- `Discount` → `schema.prisma:L4736`
- `EcommerceMerchant` → `schema.prisma:L3501`
- `EmailTemplate` → `schema.prisma:L8022`
- `Estimate` → `schema.prisma:L9546`
- `EstimateItem` → `schema.prisma:L9574`
- `ExternalBusyBlock` → `schema.prisma:L8935`
- `Feature` → `schema.prisma:L2863`
- `FeeSchedule` → `schema.prisma:L2938`
- `FeeTier` → `schema.prisma:L2949`
- `FloorElement` → `schema.prisma:L2045`
- `GeofenceRule` → `schema.prisma:L6473`
- `GoogleCalendarChannel` → `schema.prisma:L8912`
- `GoogleCalendarConnection` → `schema.prisma:L8864`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L8965`
- `GoogleOAuthSession` → `schema.prisma:L8987`
- `HolidayCalendar` → `schema.prisma:L4434`
- `IdempotencyRequest` → `schema.prisma:L7201`
- `Inventory` → `schema.prisma:L1401`
- `InventoryMovement` → `schema.prisma:L1425`
- `InventoryTransfer` → `schema.prisma:L9518`
- `Invitation` → `schema.prisma:L1014`
- `Invoice` → `schema.prisma:L2961`
- `InvoiceItem` → `schema.prisma:L2987`
- `ItemCategory` → `schema.prisma:L6981`
- `KdsOrder` → `schema.prisma:L9679`
- `KdsOrderItem` → `schema.prisma:L9696`
- `LearnedPatterns` → `schema.prisma:L5958`
- `LiveDemoSession` → `schema.prisma:L569`
- `LowStockAlert` → `schema.prisma:L1840`
- `LoyaltyConfig` → `schema.prisma:L4684`
- `LoyaltyTransaction` → `schema.prisma:L4707`
- `MarketingCampaign` → `schema.prisma:L8040`
- `MeasurementUnit` → `schema.prisma:L9624`
- `Menu` → `schema.prisma:L1191`
- `MenuCategory` → `schema.prisma:L1137`
- `MenuCategoryAssignment` → `schema.prisma:L1226`
- `MercadoPagoWebhookEvent` → `schema.prisma:L9755`
- `MerchantAccount` → `schema.prisma:L3300`
- `MerchantRevenueShare` → `schema.prisma:L4101`
- `MilestoneAchievement` → `schema.prisma:L7500`
- `Modifier` → `schema.prisma:L2484`
- `ModifierGroup` → `schema.prisma:L2448`
- `Module` → `schema.prisma:L6897`
- `MoneyAnomaly` → `schema.prisma:L4004`
- `MonthlyVenueProfit` → `schema.prisma:L4460`
- `Notification` → `schema.prisma:L4973`
- `NotificationPreference` → `schema.prisma:L5020`
- `NotificationTemplate` → `schema.prisma:L5047`
- `OAuthState` → `schema.prisma:L1065`
- `OnboardingProgress` → `schema.prisma:L1083`
- `Order` → `schema.prisma:L2232`
- `OrderAction` → `schema.prisma:L2549`
- `OrderCustomer` → `schema.prisma:L2353`
- `OrderDiscount` → `schema.prisma:L4908`
- `OrderItem` → `schema.prisma:L2369`
- `OrderItemModifier` → `schema.prisma:L2533`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L7874`
- `OrganizationGoal` → `schema.prisma:L7832`
- `OrganizationModule` → `schema.prisma:L6953`
- `OrganizationPaymentConfig` → `schema.prisma:L3810`
- `OrganizationPayoutConfig` → `schema.prisma:L7900`
- `OrganizationPricingStructure` → `schema.prisma:L3842`
- `OrganizationSalesGoalConfig` → `schema.prisma:L7855`
- `PartnerAPIKey` → `schema.prisma:L3640`
- `Payment` → `schema.prisma:L2582`
- `PaymentAllocation` → `schema.prisma:L2713`
- `PaymentLink` → `schema.prisma:L9319`
- `PaymentLinkAttribution` → `schema.prisma:L9427`
- `PaymentLinkItem` → `schema.prisma:L9382`
- `PaymentLinkItemModifier` → `schema.prisma:L9409`
- `PaymentProvider` → `schema.prisma:L3259`
- `PerformanceGoal` → `schema.prisma:L7809`
- `PermissionSet` → `schema.prisma:L965`
- `PlatformSettings` → `schema.prisma:L3617`
- `PosCommand` → `schema.prisma:L5101`
- `PosConnectionStatus` → `schema.prisma:L645`
- `PricingPolicy` → `schema.prisma:L1751`
- `ProcessedStripeEvent` → `schema.prisma:L3990`
- `ProcessorReliabilityMetric` → `schema.prisma:L4388`
- `Product` → `schema.prisma:L1244`
- `ProductModifierGroup` → `schema.prisma:L2521`
- `ProductOption` → `schema.prisma:L9601`
- `ProductOptionValue` → `schema.prisma:L9612`
- `ProviderCostStructure` → `schema.prisma:L4026`
- `ProviderEventLog` → `schema.prisma:L3919`
- `PurchaseOrder` → `schema.prisma:L1666`
- `PurchaseOrderItem` → `schema.prisma:L1722`
- `RawMaterial` → `schema.prisma:L1455`
- `RawMaterialMovement` → `schema.prisma:L1804`
- `Recipe` → `schema.prisma:L1520`
- `RecipeLine` → `schema.prisma:L1544`
- `Reservation` → `schema.prisma:L8419`
- `ReservationGoogleEventMapping` → `schema.prisma:L9099`
- `ReservationModifier` → `schema.prisma:L8578`
- `ReservationReminderSent` → `schema.prisma:L8561`
- `ReservationSettings` → `schema.prisma:L8739`
- `ReservationWaitlistEntry` → `schema.prisma:L8707`
- `Review` → `schema.prisma:L3005`
- `SaleVerification` → `schema.prisma:L2767`
- `ScheduledCommand` → `schema.prisma:L6433`
- `SerializedItem` → `schema.prisma:L7023`
- `SerializedItemCustodyEvent` → `schema.prisma:L7177`
- `SettlementConfiguration` → `schema.prisma:L4239`
- `SettlementConfirmation` → `schema.prisma:L4352`
- `SettlementIncident` → `schema.prisma:L4303`
- `SettlementSimulation` → `schema.prisma:L4274`
- `Shift` → `schema.prisma:L2083`
- `SlotHold` → `schema.prisma:L8618`
- `Staff` → `schema.prisma:L665`
- `StaffOnboardingState` → `schema.prisma:L9725`
- `StaffOrganization` → `schema.prisma:L879`
- `StaffPasskey` → `schema.prisma:L906`
- `StaffVenue` → `schema.prisma:L824`
- `StockAlertConfig` → `schema.prisma:L7791`
- `StockBatch` → `schema.prisma:L1923`
- `StockCount` → `schema.prisma:L1872`
- `StockCountItem` → `schema.prisma:L1893`
- `StripeWebhookEvent` → `schema.prisma:L3973`
- `Supplier` → `schema.prisma:L1579`
- `SupplierPricing` → `schema.prisma:L1632`
- `Table` → `schema.prisma:L1995`
- `Terminal` → `schema.prisma:L3056`
- `TerminalHealth` → `schema.prisma:L3192`
- `TerminalLog` → `schema.prisma:L3166`
- `TimeEntry` → `schema.prisma:L2148`
- `TimeEntryBreak` → `schema.prisma:L2217`
- `TokenPurchase` → `schema.prisma:L6107`
- `TokenUsageRecord` → `schema.prisma:L6079`
- `TpvCommandHistory` → `schema.prisma:L6339`
- `TpvCommandQueue` → `schema.prisma:L6279`
- `TpvFeedback` → `schema.prisma:L5992`
- `TpvMessage` → `schema.prisma:L8115`
- `TpvMessageDelivery` → `schema.prisma:L8167`
- `TpvMessageResponse` → `schema.prisma:L8190`
- `TrainingModule` → `schema.prisma:L8245`
- `TrainingProgress` → `schema.prisma:L8322`
- `TrainingQuizQuestion` → `schema.prisma:L8304`
- `TrainingStep` → `schema.prisma:L8284`
- `TransactionCost` → `schema.prisma:L4189`
- `UnitConversion` → `schema.prisma:L1782`
- `user_sessions` → `schema.prisma:L3675`
- `Venue` → `schema.prisma:L105`
- `VenueChatMessage` → `schema.prisma:L545`
- `VenueChatSession` → `schema.prisma:L500`
- `VenueCommission` → `schema.prisma:L9657`
- `VenueCreditAssessment` → `schema.prisma:L6769`
- `VenueCryptoConfig` → `schema.prisma:L7982`
- `VenueFeature` → `schema.prisma:L2881`
- `VenueModule` → `schema.prisma:L6925`
- `VenuePaymentConfig` → `schema.prisma:L3776`
- `VenuePaymentLinkSettings` → `schema.prisma:L9132`
- `VenuePricingStructure` → `schema.prisma:L4129`
- `VenueRoleConfig` → `schema.prisma:L994`
- `VenueRolePermission` → `schema.prisma:L936`
- `VenueSettings` → `schema.prisma:L585`
- `VenueTransaction` → `schema.prisma:L2818`
- `VenueWhatsappActivation` → `schema.prisma:L436`
- `WebhookEvent` → `schema.prisma:L2914`
- `WebhookSubscription` → `schema.prisma:L3892`
- `WhatsappContactWindow` → `schema.prisma:L454`
- `WhatsappInboundEvent` → `schema.prisma:L474`
- `Zone` → `schema.prisma:L88`
