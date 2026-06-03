# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **215 models / 189 enums / ~10,200 lines**. Nobody reads it
top to bottom. This file is the **index**: 20 domains, what each is for, and where it
lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail
read `docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the *What it is* column → open the
domain at its line. Every model is listed once, in its primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):
- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 20 domains

| # | Domain | What it is | Models (`schema.prisma`) |
|---|--------|-----------|--------------------------|
| 1 | **Multi-Tenant Core** | The org/venue tree + physical floor layout. The root every other table hangs off. | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone` |
| 2 | **Modules, Features & Billing** | What a venue pays for / is gated on, and how Avoqado invoices it. | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule` |
| 3 | **Staff, Auth, Permissions & Time** | Who works where, how they log in, what they may do, and hours worked. | `DeviceToken`, `Invitation`, `OAuthState`, `PermissionSet`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission` |
| 4 | **Onboarding & Training** | New-venue/new-staff onboarding state + the LMS. | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep` |
| 5 | **Menu, Products & Modifiers** | The catalog: what a venue sells and its variants/add-ons. | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion` |
| 6 | **Inventory & Stock** | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches. | `Inventory`, `InventoryMovement`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing` |
| 7 | **Serialized Inventory** | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification. | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem` |
| 8 | **Orders, KDS & Cash** | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja. | `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderItem`, `OrderItemModifier`, `Shift` |
| 9 | **Payments & Fees** | The payment record itself + allocations, receipts, fee schedules. | `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction` |
| 10 | **Payment Providers & Settlement** | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement. | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig` |
| 11 | **Payment Links** | Pay-by-link: links, line items, attribution. | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings` |
| 12 | **Pricing, Costs & Venue Lending** | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment. | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure` |
| 13 | **Discounts, Loyalty & Credit Packs** | Discounts/coupons, loyalty points, and prepaid credit-pack bundles. | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig` |
| 14 | **Commissions & Sales Goals** | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter). | `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `VenueCommission` |
| 15 | **Reservations & Booking** | Appointments/classes, waitlist, slot holds, Google Calendar sync. | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold` |
| 16 | **Terminals / TPV Fleet** | PAX terminal fleet: health, logs, app updates, remote commands, messaging. | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig` |
| 17 | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns. | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent` |
| 18 | **AI Chatbot (Text-to-SQL)** | The in-dashboard AI assistant: conversations, training data, learned patterns. | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns` |
| 19 | **Customers, Consumers & Reviews** | End-customer identity (venue customers + cross-venue Consumers) and reviews. | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerGroup`, `Review` |
| 20 | **System: Audit, Webhooks & Platform** | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings. | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription` |

> Line numbers are section starts and drift as the schema grows — treat them as
> "jump near here", then search for the exact `model Name {`. When the map goes stale,
> regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `ActivityLog` → `schema.prisma:L4782`
- `Aggregator` → `schema.prisma:L10084`
- `AngelPayUserAccount` → `schema.prisma:L3594`
- `AppUpdate` → `schema.prisma:L8378`
- `Area` → `schema.prisma:L2013`
- `BulkCommandOperation` → `schema.prisma:L6771`
- `CalendarSyncOutbox` → `schema.prisma:L9487`
- `CampaignDelivery` → `schema.prisma:L8528`
- `CashCloseout` → `schema.prisma:L7104`
- `CashDeposit` → `schema.prisma:L8205`
- `CashDrawerEvent` → `schema.prisma:L9930`
- `CashDrawerSession` → `schema.prisma:L9906`
- `ChatbotTokenBudget` → `schema.prisma:L6419`
- `ChatConversation` → `schema.prisma:L6274`
- `ChatFeedback` → `schema.prisma:L6360`
- `ChatLearningEvent` → `schema.prisma:L6317`
- `ChatMessage` → `schema.prisma:L6297`
- `ChatTrainingData` → `schema.prisma:L6231`
- `CheckoutSession` → `schema.prisma:L3871`
- `ClassSession` → `schema.prisma:L9108`
- `CommissionCalculation` → `schema.prisma:L7984`
- `CommissionClawback` → `schema.prisma:L8157`
- `CommissionConfig` → `schema.prisma:L7762`
- `CommissionMilestone` → `schema.prisma:L7900`
- `CommissionOverride` → `schema.prisma:L7832`
- `CommissionPayout` → `schema.prisma:L8108`
- `CommissionSummary` → `schema.prisma:L8047`
- `CommissionTier` → `schema.prisma:L7869`
- `Consumer` → `schema.prisma:L4897`
- `ConsumerAuthAccount` → `schema.prisma:L4922`
- `CouponCode` → `schema.prisma:L5201`
- `CouponRedemption` → `schema.prisma:L5232`
- `CreditAssessmentHistory` → `schema.prisma:L7213`
- `CreditItemBalance` → `schema.prisma:L9696`
- `CreditOffer` → `schema.prisma:L7232`
- `CreditPack` → `schema.prisma:L9612`
- `CreditPackItem` → `schema.prisma:L9641`
- `CreditPackPurchase` → `schema.prisma:L9658`
- `CreditTransaction` → `schema.prisma:L9718`
- `Customer` → `schema.prisma:L4808`
- `CustomerDiscount` → `schema.prisma:L5252`
- `CustomerGroup` → `schema.prisma:L4941`
- `DeviceToken` → `schema.prisma:L5447`
- `DigitalReceipt` → `schema.prisma:L2784`
- `Discount` → `schema.prisma:L5102`
- `EcommerceMerchant` → `schema.prisma:L3686`
- `EmailTemplate` → `schema.prisma:L8467`
- `Estimate` → `schema.prisma:L9991`
- `EstimateItem` → `schema.prisma:L10019`
- `ExternalBusyBlock` → `schema.prisma:L9380`
- `Feature` → `schema.prisma:L2913`
- `FeeSchedule` → `schema.prisma:L2988`
- `FeeTier` → `schema.prisma:L2999`
- `FloorElement` → `schema.prisma:L2089`
- `GeofenceRule` → `schema.prisma:L6856`
- `GoogleCalendarChannel` → `schema.prisma:L9357`
- `GoogleCalendarConnection` → `schema.prisma:L9309`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9410`
- `GoogleOAuthSession` → `schema.prisma:L9432`
- `HolidayCalendar` → `schema.prisma:L4706`
- `IdempotencyRequest` → `schema.prisma:L7646`
- `Inventory` → `schema.prisma:L1445`
- `InventoryMovement` → `schema.prisma:L1469`
- `InventoryTransfer` → `schema.prisma:L9963`
- `Invitation` → `schema.prisma:L1058`
- `Invoice` → `schema.prisma:L3011`
- `InvoiceItem` → `schema.prisma:L3037`
- `ItemCategory` → `schema.prisma:L7364`
- `KdsOrder` → `schema.prisma:L10124`
- `KdsOrderItem` → `schema.prisma:L10141`
- `LearnedPatterns` → `schema.prisma:L6341`
- `LiveDemoSession` → `schema.prisma:L599`
- `LowStockAlert` → `schema.prisma:L1884`
- `LoyaltyConfig` → `schema.prisma:L4971`
- `LoyaltyTransaction` → `schema.prisma:L4994`
- `MarketingCampaign` → `schema.prisma:L8485`
- `MeasurementUnit` → `schema.prisma:L10069`
- `Menu` → `schema.prisma:L1235`
- `MenuCategory` → `schema.prisma:L1181`
- `MenuCategoryAssignment` → `schema.prisma:L1270`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10200`
- `MerchantAccount` → `schema.prisma:L3471`
- `MerchantRevenueShare` → `schema.prisma:L4286`
- `MilestoneAchievement` → `schema.prisma:L7945`
- `Modifier` → `schema.prisma:L2531`
- `ModifierGroup` → `schema.prisma:L2495`
- `Module` → `schema.prisma:L7280`
- `MoneyAnomaly` → `schema.prisma:L4189`
- `MonthlyVenueProfit` → `schema.prisma:L4732`
- `Notification` → `schema.prisma:L5349`
- `NotificationPreference` → `schema.prisma:L5396`
- `NotificationTemplate` → `schema.prisma:L5423`
- `OAuthState` → `schema.prisma:L1109`
- `OnboardingProgress` → `schema.prisma:L1127`
- `Order` → `schema.prisma:L2276`
- `OrderAction` → `schema.prisma:L2596`
- `OrderCustomer` → `schema.prisma:L2400`
- `OrderDiscount` → `schema.prisma:L5284`
- `OrderItem` → `schema.prisma:L2416`
- `OrderItemModifier` → `schema.prisma:L2580`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8319`
- `OrganizationGoal` → `schema.prisma:L8277`
- `OrganizationModule` → `schema.prisma:L7336`
- `OrganizationPaymentConfig` → `schema.prisma:L3995`
- `OrganizationPayoutConfig` → `schema.prisma:L8345`
- `OrganizationPricingStructure` → `schema.prisma:L4027`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8300`
- `PartnerAPIKey` → `schema.prisma:L3825`
- `Payment` → `schema.prisma:L2629`
- `PaymentAllocation` → `schema.prisma:L2763`
- `PaymentLink` → `schema.prisma:L9764`
- `PaymentLinkAttribution` → `schema.prisma:L9872`
- `PaymentLinkItem` → `schema.prisma:L9827`
- `PaymentLinkItemModifier` → `schema.prisma:L9854`
- `PaymentProvider` → `schema.prisma:L3430`
- `PerformanceGoal` → `schema.prisma:L8254`
- `PermissionSet` → `schema.prisma:L1009`
- `PlatformSettings` → `schema.prisma:L3802`
- `PosCommand` → `schema.prisma:L5477`
- `PosConnectionStatus` → `schema.prisma:L675`
- `PricingPolicy` → `schema.prisma:L1795`
- `ProcessedStripeEvent` → `schema.prisma:L4175`
- `ProcessorReliabilityMetric` → `schema.prisma:L4660`
- `Product` → `schema.prisma:L1288`
- `ProductModifierGroup` → `schema.prisma:L2568`
- `ProductOption` → `schema.prisma:L10046`
- `ProductOptionValue` → `schema.prisma:L10057`
- `ProviderCostStructure` → `schema.prisma:L4211`
- `ProviderEventLog` → `schema.prisma:L4104`
- `PurchaseOrder` → `schema.prisma:L1710`
- `PurchaseOrderItem` → `schema.prisma:L1766`
- `RateCorrectionBatch` → `schema.prisma:L4436`
- `RateCorrectionEntry` → `schema.prisma:L4478`
- `RawMaterial` → `schema.prisma:L1499`
- `RawMaterialMovement` → `schema.prisma:L1848`
- `Recipe` → `schema.prisma:L1564`
- `RecipeLine` → `schema.prisma:L1588`
- `Referral` → `schema.prisma:L5056`
- `ReferralProgramConfig` → `schema.prisma:L5023`
- `Reservation` → `schema.prisma:L8864`
- `ReservationGoogleEventMapping` → `schema.prisma:L9544`
- `ReservationModifier` → `schema.prisma:L9023`
- `ReservationReminderSent` → `schema.prisma:L9006`
- `ReservationSettings` → `schema.prisma:L9184`
- `ReservationWaitlistEntry` → `schema.prisma:L9152`
- `Review` → `schema.prisma:L3055`
- `SaleVerification` → `schema.prisma:L2817`
- `ScheduledCommand` → `schema.prisma:L6816`
- `SerializedItem` → `schema.prisma:L7407`
- `SerializedItemCustodyEvent` → `schema.prisma:L7569`
- `SettlementConfiguration` → `schema.prisma:L4511`
- `SettlementConfirmation` → `schema.prisma:L4624`
- `SettlementIncident` → `schema.prisma:L4575`
- `SettlementSimulation` → `schema.prisma:L4546`
- `Shift` → `schema.prisma:L2127`
- `SimRegistrationRequest` → `schema.prisma:L7607`
- `SimRegistrationRequestItem` → `schema.prisma:L7629`
- `SlotHold` → `schema.prisma:L9063`
- `Staff` → `schema.prisma:L695`
- `StaffOnboardingState` → `schema.prisma:L10170`
- `StaffOrganization` → `schema.prisma:L923`
- `StaffPasskey` → `schema.prisma:L950`
- `StaffVenue` → `schema.prisma:L865`
- `StockAlertConfig` → `schema.prisma:L8236`
- `StockBatch` → `schema.prisma:L1967`
- `StockCount` → `schema.prisma:L1916`
- `StockCountItem` → `schema.prisma:L1937`
- `StripeWebhookEvent` → `schema.prisma:L4158`
- `Supplier` → `schema.prisma:L1623`
- `SupplierPricing` → `schema.prisma:L1676`
- `Table` → `schema.prisma:L2039`
- `Terminal` → `schema.prisma:L3106`
- `TerminalHealth` → `schema.prisma:L3250`
- `TerminalLog` → `schema.prisma:L3224`
- `TerminalOrder` → `schema.prisma:L3333`
- `TerminalOrderItem` → `schema.prisma:L3408`
- `TimeEntry` → `schema.prisma:L2192`
- `TimeEntryBreak` → `schema.prisma:L2261`
- `TokenPurchase` → `schema.prisma:L6490`
- `TokenUsageRecord` → `schema.prisma:L6462`
- `TpvCommandHistory` → `schema.prisma:L6722`
- `TpvCommandQueue` → `schema.prisma:L6662`
- `TpvFeedback` → `schema.prisma:L6375`
- `TpvMessage` → `schema.prisma:L8560`
- `TpvMessageDelivery` → `schema.prisma:L8612`
- `TpvMessageResponse` → `schema.prisma:L8635`
- `TrainingModule` → `schema.prisma:L8690`
- `TrainingProgress` → `schema.prisma:L8767`
- `TrainingQuizQuestion` → `schema.prisma:L8749`
- `TrainingStep` → `schema.prisma:L8729`
- `TransactionCost` → `schema.prisma:L4374`
- `UnitConversion` → `schema.prisma:L1826`
- `user_sessions` → `schema.prisma:L3860`
- `Venue` → `schema.prisma:L108`
- `VenueChatMessage` → `schema.prisma:L575`
- `VenueChatSession` → `schema.prisma:L530`
- `VenueCommission` → `schema.prisma:L10102`
- `VenueCreditAssessment` → `schema.prisma:L7152`
- `VenueCryptoConfig` → `schema.prisma:L8427`
- `VenueFeature` → `schema.prisma:L2931`
- `VenueModule` → `schema.prisma:L7308`
- `VenuePaymentConfig` → `schema.prisma:L3961`
- `VenuePaymentLinkSettings` → `schema.prisma:L9577`
- `VenuePricingStructure` → `schema.prisma:L4314`
- `VenueRoleConfig` → `schema.prisma:L1038`
- `VenueRolePermission` → `schema.prisma:L980`
- `VenueSettings` → `schema.prisma:L615`
- `VenueTransaction` → `schema.prisma:L2868`
- `VenueWhatsappActivation` → `schema.prisma:L466`
- `WebhookEvent` → `schema.prisma:L2964`
- `WebhookSubscription` → `schema.prisma:L4077`
- `WhatsappContactWindow` → `schema.prisma:L484`
- `WhatsappInboundEvent` → `schema.prisma:L504`
- `Zone` → `schema.prisma:L91`
