# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **215 models / 190 enums / ~10,200 lines**. Nobody reads it
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

- `ActivityLog` → `schema.prisma:L4786`
- `Aggregator` → `schema.prisma:L10099`
- `AngelPayUserAccount` → `schema.prisma:L3598`
- `AppUpdate` → `schema.prisma:L8393`
- `Area` → `schema.prisma:L2014`
- `BulkCommandOperation` → `schema.prisma:L6775`
- `CalendarSyncOutbox` → `schema.prisma:L9502`
- `CampaignDelivery` → `schema.prisma:L8543`
- `CashCloseout` → `schema.prisma:L7108`
- `CashDeposit` → `schema.prisma:L8220`
- `CashDrawerEvent` → `schema.prisma:L9945`
- `CashDrawerSession` → `schema.prisma:L9921`
- `ChatbotTokenBudget` → `schema.prisma:L6423`
- `ChatConversation` → `schema.prisma:L6278`
- `ChatFeedback` → `schema.prisma:L6364`
- `ChatLearningEvent` → `schema.prisma:L6321`
- `ChatMessage` → `schema.prisma:L6301`
- `ChatTrainingData` → `schema.prisma:L6235`
- `CheckoutSession` → `schema.prisma:L3875`
- `ClassSession` → `schema.prisma:L9123`
- `CommissionCalculation` → `schema.prisma:L7999`
- `CommissionClawback` → `schema.prisma:L8172`
- `CommissionConfig` → `schema.prisma:L7772`
- `CommissionMilestone` → `schema.prisma:L7915`
- `CommissionOverride` → `schema.prisma:L7842`
- `CommissionPayout` → `schema.prisma:L8123`
- `CommissionSummary` → `schema.prisma:L8062`
- `CommissionTier` → `schema.prisma:L7879`
- `Consumer` → `schema.prisma:L4901`
- `ConsumerAuthAccount` → `schema.prisma:L4926`
- `CouponCode` → `schema.prisma:L5205`
- `CouponRedemption` → `schema.prisma:L5236`
- `CreditAssessmentHistory` → `schema.prisma:L7217`
- `CreditItemBalance` → `schema.prisma:L9711`
- `CreditOffer` → `schema.prisma:L7236`
- `CreditPack` → `schema.prisma:L9627`
- `CreditPackItem` → `schema.prisma:L9656`
- `CreditPackPurchase` → `schema.prisma:L9673`
- `CreditTransaction` → `schema.prisma:L9733`
- `Customer` → `schema.prisma:L4812`
- `CustomerDiscount` → `schema.prisma:L5256`
- `CustomerGroup` → `schema.prisma:L4945`
- `DeviceToken` → `schema.prisma:L5451`
- `DigitalReceipt` → `schema.prisma:L2785`
- `Discount` → `schema.prisma:L5106`
- `EcommerceMerchant` → `schema.prisma:L3690`
- `EmailTemplate` → `schema.prisma:L8482`
- `Estimate` → `schema.prisma:L10006`
- `EstimateItem` → `schema.prisma:L10034`
- `ExternalBusyBlock` → `schema.prisma:L9395`
- `Feature` → `schema.prisma:L2914`
- `FeeSchedule` → `schema.prisma:L2992`
- `FeeTier` → `schema.prisma:L3003`
- `FloorElement` → `schema.prisma:L2090`
- `GeofenceRule` → `schema.prisma:L6860`
- `GoogleCalendarChannel` → `schema.prisma:L9372`
- `GoogleCalendarConnection` → `schema.prisma:L9324`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9425`
- `GoogleOAuthSession` → `schema.prisma:L9447`
- `HolidayCalendar` → `schema.prisma:L4710`
- `IdempotencyRequest` → `schema.prisma:L7650`
- `Inventory` → `schema.prisma:L1446`
- `InventoryMovement` → `schema.prisma:L1470`
- `InventoryTransfer` → `schema.prisma:L9978`
- `Invitation` → `schema.prisma:L1059`
- `Invoice` → `schema.prisma:L3015`
- `InvoiceItem` → `schema.prisma:L3041`
- `ItemCategory` → `schema.prisma:L7368`
- `KdsOrder` → `schema.prisma:L10139`
- `KdsOrderItem` → `schema.prisma:L10156`
- `LearnedPatterns` → `schema.prisma:L6345`
- `LiveDemoSession` → `schema.prisma:L600`
- `LowStockAlert` → `schema.prisma:L1885`
- `LoyaltyConfig` → `schema.prisma:L4975`
- `LoyaltyTransaction` → `schema.prisma:L4998`
- `MarketingCampaign` → `schema.prisma:L8500`
- `MeasurementUnit` → `schema.prisma:L10084`
- `Menu` → `schema.prisma:L1236`
- `MenuCategory` → `schema.prisma:L1182`
- `MenuCategoryAssignment` → `schema.prisma:L1271`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10215`
- `MerchantAccount` → `schema.prisma:L3475`
- `MerchantRevenueShare` → `schema.prisma:L4290`
- `MilestoneAchievement` → `schema.prisma:L7960`
- `Modifier` → `schema.prisma:L2532`
- `ModifierGroup` → `schema.prisma:L2496`
- `Module` → `schema.prisma:L7284`
- `MoneyAnomaly` → `schema.prisma:L4193`
- `MonthlyVenueProfit` → `schema.prisma:L4736`
- `Notification` → `schema.prisma:L5353`
- `NotificationPreference` → `schema.prisma:L5400`
- `NotificationTemplate` → `schema.prisma:L5427`
- `OAuthState` → `schema.prisma:L1110`
- `OnboardingProgress` → `schema.prisma:L1128`
- `Order` → `schema.prisma:L2277`
- `OrderAction` → `schema.prisma:L2597`
- `OrderCustomer` → `schema.prisma:L2401`
- `OrderDiscount` → `schema.prisma:L5288`
- `OrderItem` → `schema.prisma:L2417`
- `OrderItemModifier` → `schema.prisma:L2581`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8334`
- `OrganizationGoal` → `schema.prisma:L8292`
- `OrganizationModule` → `schema.prisma:L7340`
- `OrganizationPaymentConfig` → `schema.prisma:L3999`
- `OrganizationPayoutConfig` → `schema.prisma:L8360`
- `OrganizationPricingStructure` → `schema.prisma:L4031`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8315`
- `PartnerAPIKey` → `schema.prisma:L3829`
- `Payment` → `schema.prisma:L2630`
- `PaymentAllocation` → `schema.prisma:L2764`
- `PaymentLink` → `schema.prisma:L9779`
- `PaymentLinkAttribution` → `schema.prisma:L9887`
- `PaymentLinkItem` → `schema.prisma:L9842`
- `PaymentLinkItemModifier` → `schema.prisma:L9869`
- `PaymentProvider` → `schema.prisma:L3434`
- `PerformanceGoal` → `schema.prisma:L8269`
- `PermissionSet` → `schema.prisma:L1010`
- `PlatformSettings` → `schema.prisma:L3806`
- `PosCommand` → `schema.prisma:L5481`
- `PosConnectionStatus` → `schema.prisma:L676`
- `PricingPolicy` → `schema.prisma:L1796`
- `ProcessedStripeEvent` → `schema.prisma:L4179`
- `ProcessorReliabilityMetric` → `schema.prisma:L4664`
- `Product` → `schema.prisma:L1289`
- `ProductModifierGroup` → `schema.prisma:L2569`
- `ProductOption` → `schema.prisma:L10061`
- `ProductOptionValue` → `schema.prisma:L10072`
- `ProviderCostStructure` → `schema.prisma:L4215`
- `ProviderEventLog` → `schema.prisma:L4108`
- `PurchaseOrder` → `schema.prisma:L1711`
- `PurchaseOrderItem` → `schema.prisma:L1767`
- `RateCorrectionBatch` → `schema.prisma:L4440`
- `RateCorrectionEntry` → `schema.prisma:L4482`
- `RawMaterial` → `schema.prisma:L1500`
- `RawMaterialMovement` → `schema.prisma:L1849`
- `Recipe` → `schema.prisma:L1565`
- `RecipeLine` → `schema.prisma:L1589`
- `Referral` → `schema.prisma:L5060`
- `ReferralProgramConfig` → `schema.prisma:L5027`
- `Reservation` → `schema.prisma:L8879`
- `ReservationGoogleEventMapping` → `schema.prisma:L9559`
- `ReservationModifier` → `schema.prisma:L9038`
- `ReservationReminderSent` → `schema.prisma:L9021`
- `ReservationSettings` → `schema.prisma:L9199`
- `ReservationWaitlistEntry` → `schema.prisma:L9167`
- `Review` → `schema.prisma:L3059`
- `SaleVerification` → `schema.prisma:L2818`
- `ScheduledCommand` → `schema.prisma:L6820`
- `SerializedItem` → `schema.prisma:L7411`
- `SerializedItemCustodyEvent` → `schema.prisma:L7573`
- `SettlementConfiguration` → `schema.prisma:L4515`
- `SettlementConfirmation` → `schema.prisma:L4628`
- `SettlementIncident` → `schema.prisma:L4579`
- `SettlementSimulation` → `schema.prisma:L4550`
- `Shift` → `schema.prisma:L2128`
- `SimRegistrationRequest` → `schema.prisma:L7611`
- `SimRegistrationRequestItem` → `schema.prisma:L7633`
- `SlotHold` → `schema.prisma:L9078`
- `Staff` → `schema.prisma:L696`
- `StaffOnboardingState` → `schema.prisma:L10185`
- `StaffOrganization` → `schema.prisma:L924`
- `StaffPasskey` → `schema.prisma:L951`
- `StaffVenue` → `schema.prisma:L866`
- `StockAlertConfig` → `schema.prisma:L8251`
- `StockBatch` → `schema.prisma:L1968`
- `StockCount` → `schema.prisma:L1917`
- `StockCountItem` → `schema.prisma:L1938`
- `StripeWebhookEvent` → `schema.prisma:L4162`
- `Supplier` → `schema.prisma:L1624`
- `SupplierPricing` → `schema.prisma:L1677`
- `Table` → `schema.prisma:L2040`
- `Terminal` → `schema.prisma:L3110`
- `TerminalHealth` → `schema.prisma:L3254`
- `TerminalLog` → `schema.prisma:L3228`
- `TerminalOrder` → `schema.prisma:L3337`
- `TerminalOrderItem` → `schema.prisma:L3412`
- `TimeEntry` → `schema.prisma:L2193`
- `TimeEntryBreak` → `schema.prisma:L2262`
- `TokenPurchase` → `schema.prisma:L6494`
- `TokenUsageRecord` → `schema.prisma:L6466`
- `TpvCommandHistory` → `schema.prisma:L6726`
- `TpvCommandQueue` → `schema.prisma:L6666`
- `TpvFeedback` → `schema.prisma:L6379`
- `TpvMessage` → `schema.prisma:L8575`
- `TpvMessageDelivery` → `schema.prisma:L8627`
- `TpvMessageResponse` → `schema.prisma:L8650`
- `TrainingModule` → `schema.prisma:L8705`
- `TrainingProgress` → `schema.prisma:L8782`
- `TrainingQuizQuestion` → `schema.prisma:L8764`
- `TrainingStep` → `schema.prisma:L8744`
- `TransactionCost` → `schema.prisma:L4378`
- `UnitConversion` → `schema.prisma:L1827`
- `user_sessions` → `schema.prisma:L3864`
- `Venue` → `schema.prisma:L108`
- `VenueChatMessage` → `schema.prisma:L576`
- `VenueChatSession` → `schema.prisma:L531`
- `VenueCommission` → `schema.prisma:L10117`
- `VenueCreditAssessment` → `schema.prisma:L7156`
- `VenueCryptoConfig` → `schema.prisma:L8442`
- `VenueFeature` → `schema.prisma:L2932`
- `VenueModule` → `schema.prisma:L7312`
- `VenuePaymentConfig` → `schema.prisma:L3965`
- `VenuePaymentLinkSettings` → `schema.prisma:L9592`
- `VenuePricingStructure` → `schema.prisma:L4318`
- `VenueRoleConfig` → `schema.prisma:L1039`
- `VenueRolePermission` → `schema.prisma:L981`
- `VenueSettings` → `schema.prisma:L616`
- `VenueTransaction` → `schema.prisma:L2869`
- `VenueWhatsappActivation` → `schema.prisma:L467`
- `WebhookEvent` → `schema.prisma:L2968`
- `WebhookSubscription` → `schema.prisma:L4081`
- `WhatsappContactWindow` → `schema.prisma:L485`
- `WhatsappInboundEvent` → `schema.prisma:L505`
- `Zone` → `schema.prisma:L91`
