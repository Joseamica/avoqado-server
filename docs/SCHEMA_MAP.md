# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **223 models / 198 enums / ~10,500 lines**. Nobody reads it top to bottom. This file is the **index**: 20 domains,
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
| 9   | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                       |
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

- `ActivityLog` → `schema.prisma:L4834`
- `Aggregator` → `schema.prisma:L10169`
- `AngelPayUserAccount` → `schema.prisma:L3643`
- `AppUpdate` → `schema.prisma:L8463`
- `Area` → `schema.prisma:L2053`
- `BulkCommandOperation` → `schema.prisma:L6842`
- `CalendarSyncOutbox` → `schema.prisma:L9572`
- `CampaignDelivery` → `schema.prisma:L8613`
- `CashCloseout` → `schema.prisma:L7175`
- `CashDeposit` → `schema.prisma:L8290`
- `CashDrawerEvent` → `schema.prisma:L10015`
- `CashDrawerSession` → `schema.prisma:L9991`
- `Cfdi` → `schema.prisma:L10503`
- `ChatbotTokenBudget` → `schema.prisma:L6490`
- `ChatConversation` → `schema.prisma:L6345`
- `ChatFeedback` → `schema.prisma:L6431`
- `ChatLearningEvent` → `schema.prisma:L6388`
- `ChatMessage` → `schema.prisma:L6368`
- `ChatTrainingData` → `schema.prisma:L6302`
- `CheckoutSession` → `schema.prisma:L3923`
- `ClassSession` → `schema.prisma:L9193`
- `CommissionCalculation` → `schema.prisma:L8069`
- `CommissionClawback` → `schema.prisma:L8242`
- `CommissionConfig` → `schema.prisma:L7842`
- `CommissionMilestone` → `schema.prisma:L7985`
- `CommissionOverride` → `schema.prisma:L7912`
- `CommissionPayout` → `schema.prisma:L8193`
- `CommissionSummary` → `schema.prisma:L8132`
- `CommissionTier` → `schema.prisma:L7949`
- `Consumer` → `schema.prisma:L4952`
- `ConsumerAuthAccount` → `schema.prisma:L4977`
- `CouponCode` → `schema.prisma:L5271`
- `CouponRedemption` → `schema.prisma:L5302`
- `CreditAssessmentHistory` → `schema.prisma:L7284`
- `CreditItemBalance` → `schema.prisma:L9781`
- `CreditOffer` → `schema.prisma:L7303`
- `CreditPack` → `schema.prisma:L9697`
- `CreditPackItem` → `schema.prisma:L9726`
- `CreditPackPurchase` → `schema.prisma:L9743`
- `CreditTransaction` → `schema.prisma:L9803`
- `Customer` → `schema.prisma:L4860`
- `CustomerDiscount` → `schema.prisma:L5322`
- `CustomerGroup` → `schema.prisma:L5011`
- `CustomerTaxProfile` → `schema.prisma:L10572`
- `DeviceToken` → `schema.prisma:L5517`
- `DigitalReceipt` → `schema.prisma:L2827`
- `Discount` → `schema.prisma:L5172`
- `EcommerceMerchant` → `schema.prisma:L3735`
- `EmailTemplate` → `schema.prisma:L8552`
- `Estimate` → `schema.prisma:L10076`
- `EstimateItem` → `schema.prisma:L10104`
- `ExternalBusyBlock` → `schema.prisma:L9465`
- `Feature` → `schema.prisma:L2956`
- `FeeSchedule` → `schema.prisma:L3034`
- `FeeTier` → `schema.prisma:L3045`
- `FiscalEmisor` → `schema.prisma:L10445`
- `FloorElement` → `schema.prisma:L2129`
- `GeofenceRule` → `schema.prisma:L6927`
- `GoogleCalendarChannel` → `schema.prisma:L9442`
- `GoogleCalendarConnection` → `schema.prisma:L9394`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9495`
- `GoogleOAuthSession` → `schema.prisma:L9517`
- `HolidayCalendar` → `schema.prisma:L4758`
- `IdempotencyRequest` → `schema.prisma:L7717`
- `Inventory` → `schema.prisma:L1485`
- `InventoryMovement` → `schema.prisma:L1509`
- `InventoryTransfer` → `schema.prisma:L10048`
- `Invitation` → `schema.prisma:L1089`
- `Invoice` → `schema.prisma:L3057`
- `InvoiceItem` → `schema.prisma:L3083`
- `ItemCategory` → `schema.prisma:L7435`
- `KdsOrder` → `schema.prisma:L10209`
- `KdsOrderItem` → `schema.prisma:L10226`
- `LearnedPatterns` → `schema.prisma:L6412`
- `LiveDemoSession` → `schema.prisma:L624`
- `LowStockAlert` → `schema.prisma:L1924`
- `LoyaltyConfig` → `schema.prisma:L5041`
- `LoyaltyTransaction` → `schema.prisma:L5064`
- `MarketingCampaign` → `schema.prisma:L8570`
- `McpAuthCode` → `schema.prisma:L10352`
- `McpOAuthClient` → `schema.prisma:L10336`
- `McpRefreshToken` → `schema.prisma:L10370`
- `MeasurementUnit` → `schema.prisma:L10154`
- `Menu` → `schema.prisma:L1270`
- `MenuCategory` → `schema.prisma:L1212`
- `MenuCategoryAssignment` → `schema.prisma:L1305`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10285`
- `MerchantAccount` → `schema.prisma:L3517`
- `MerchantFiscalConfig` → `schema.prisma:L10481`
- `MerchantRevenueShare` → `schema.prisma:L4338`
- `MilestoneAchievement` → `schema.prisma:L8030`
- `Modifier` → `schema.prisma:L2574`
- `ModifierGroup` → `schema.prisma:L2538`
- `Module` → `schema.prisma:L7351`
- `MoneyAnomaly` → `schema.prisma:L4241`
- `MonthlyVenueProfit` → `schema.prisma:L4784`
- `Notification` → `schema.prisma:L5419`
- `NotificationPreference` → `schema.prisma:L5466`
- `NotificationTemplate` → `schema.prisma:L5493`
- `OAuthState` → `schema.prisma:L1140`
- `OnboardingProgress` → `schema.prisma:L1158`
- `Order` → `schema.prisma:L2316`
- `OrderAction` → `schema.prisma:L2639`
- `OrderCustomer` → `schema.prisma:L2443`
- `OrderDiscount` → `schema.prisma:L5354`
- `OrderItem` → `schema.prisma:L2459`
- `OrderItemModifier` → `schema.prisma:L2623`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8404`
- `OrganizationGoal` → `schema.prisma:L8362`
- `OrganizationModule` → `schema.prisma:L7407`
- `OrganizationPaymentConfig` → `schema.prisma:L4047`
- `OrganizationPayoutConfig` → `schema.prisma:L8430`
- `OrganizationPricingStructure` → `schema.prisma:L4079`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8385`
- `OtpChallenge` → `schema.prisma:L4996`
- `PartnerAPIKey` → `schema.prisma:L3877`
- `Payment` → `schema.prisma:L2672`
- `PaymentAllocation` → `schema.prisma:L2806`
- `PaymentLink` → `schema.prisma:L9849`
- `PaymentLinkAttribution` → `schema.prisma:L9957`
- `PaymentLinkItem` → `schema.prisma:L9912`
- `PaymentLinkItemModifier` → `schema.prisma:L9939`
- `PaymentProvider` → `schema.prisma:L3476`
- `PerformanceGoal` → `schema.prisma:L8339`
- `PermissionSet` → `schema.prisma:L1040`
- `PlatformSettings` → `schema.prisma:L3854`
- `PosCommand` → `schema.prisma:L5547`
- `PosConnectionStatus` → `schema.prisma:L700`
- `PricingPolicy` → `schema.prisma:L1835`
- `ProcessedStripeEvent` → `schema.prisma:L4227`
- `ProcessorReliabilityMetric` → `schema.prisma:L4712`
- `Product` → `schema.prisma:L1323`
- `ProductModifierGroup` → `schema.prisma:L2611`
- `ProductOption` → `schema.prisma:L10131`
- `ProductOptionValue` → `schema.prisma:L10142`
- `ProviderCostStructure` → `schema.prisma:L4263`
- `ProviderEventLog` → `schema.prisma:L4156`
- `PurchaseOrder` → `schema.prisma:L1750`
- `PurchaseOrderItem` → `schema.prisma:L1806`
- `RateCorrectionBatch` → `schema.prisma:L4488`
- `RateCorrectionEntry` → `schema.prisma:L4530`
- `RawMaterial` → `schema.prisma:L1539`
- `RawMaterialMovement` → `schema.prisma:L1888`
- `Recipe` → `schema.prisma:L1604`
- `RecipeLine` → `schema.prisma:L1628`
- `Referral` → `schema.prisma:L5126`
- `ReferralProgramConfig` → `schema.prisma:L5093`
- `Reservation` → `schema.prisma:L8949`
- `ReservationGoogleEventMapping` → `schema.prisma:L9629`
- `ReservationModifier` → `schema.prisma:L9108`
- `ReservationReminderSent` → `schema.prisma:L9091`
- `ReservationSettings` → `schema.prisma:L9269`
- `ReservationWaitlistEntry` → `schema.prisma:L9237`
- `Review` → `schema.prisma:L3101`
- `SaleVerification` → `schema.prisma:L2860`
- `ScheduledCommand` → `schema.prisma:L6887`
- `SerializedItem` → `schema.prisma:L7478`
- `SerializedItemCustodyEvent` → `schema.prisma:L7640`
- `SettlementConfiguration` → `schema.prisma:L4563`
- `SettlementConfirmation` → `schema.prisma:L4676`
- `SettlementIncident` → `schema.prisma:L4627`
- `SettlementSimulation` → `schema.prisma:L4598`
- `Shift` → `schema.prisma:L2167`
- `SimRegistrationRequest` → `schema.prisma:L7678`
- `SimRegistrationRequestItem` → `schema.prisma:L7700`
- `SlotHold` → `schema.prisma:L9148`
- `Staff` → `schema.prisma:L720`
- `StaffOnboardingState` → `schema.prisma:L10255`
- `StaffOrganization` → `schema.prisma:L954`
- `StaffPasskey` → `schema.prisma:L981`
- `StaffVenue` → `schema.prisma:L890`
- `StockAlertConfig` → `schema.prisma:L8321`
- `StockBatch` → `schema.prisma:L2007`
- `StockCount` → `schema.prisma:L1956`
- `StockCountItem` → `schema.prisma:L1977`
- `StripeWebhookEvent` → `schema.prisma:L4210`
- `Supplier` → `schema.prisma:L1663`
- `SupplierPricing` → `schema.prisma:L1716`
- `Table` → `schema.prisma:L2079`
- `Terminal` → `schema.prisma:L3152`
- `TerminalHealth` → `schema.prisma:L3296`
- `TerminalLog` → `schema.prisma:L3270`
- `TerminalOrder` → `schema.prisma:L3379`
- `TerminalOrderItem` → `schema.prisma:L3454`
- `TimeEntry` → `schema.prisma:L2232`
- `TimeEntryBreak` → `schema.prisma:L2301`
- `TokenPurchase` → `schema.prisma:L6561`
- `TokenUsageRecord` → `schema.prisma:L6533`
- `TpvCommandHistory` → `schema.prisma:L6793`
- `TpvCommandQueue` → `schema.prisma:L6733`
- `TpvFeedback` → `schema.prisma:L6446`
- `TpvMessage` → `schema.prisma:L8645`
- `TpvMessageDelivery` → `schema.prisma:L8697`
- `TpvMessageResponse` → `schema.prisma:L8720`
- `TrainingModule` → `schema.prisma:L8775`
- `TrainingProgress` → `schema.prisma:L8852`
- `TrainingQuizQuestion` → `schema.prisma:L8834`
- `TrainingStep` → `schema.prisma:L8814`
- `TransactionCost` → `schema.prisma:L4426`
- `UnitConversion` → `schema.prisma:L1866`
- `user_sessions` → `schema.prisma:L3912`
- `Venue` → `schema.prisma:L108`
- `VenueChatMessage` → `schema.prisma:L600`
- `VenueChatSession` → `schema.prisma:L555`
- `VenueCommission` → `schema.prisma:L10187`
- `VenueCreditAssessment` → `schema.prisma:L7223`
- `VenueCryptoConfig` → `schema.prisma:L8512`
- `VenueFeature` → `schema.prisma:L2974`
- `VenueModule` → `schema.prisma:L7379`
- `VenuePaymentConfig` → `schema.prisma:L4013`
- `VenuePaymentLinkSettings` → `schema.prisma:L9662`
- `VenuePricingStructure` → `schema.prisma:L4366`
- `VenueRoleConfig` → `schema.prisma:L1069`
- `VenueRolePermission` → `schema.prisma:L1011`
- `VenueSettings` → `schema.prisma:L640`
- `VenueTransaction` → `schema.prisma:L2911`
- `VenueWhatsappActivation` → `schema.prisma:L491`
- `WebhookEvent` → `schema.prisma:L3010`
- `WebhookSubscription` → `schema.prisma:L4129`
- `WhatsappContactWindow` → `schema.prisma:L509`
- `WhatsappInboundEvent` → `schema.prisma:L529`
- `Zone` → `schema.prisma:L91`
