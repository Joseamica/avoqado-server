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

- `ActivityLog` → `schema.prisma:L4810`
- `Aggregator` → `schema.prisma:L10145`
- `AngelPayUserAccount` → `schema.prisma:L3619`
- `AppUpdate` → `schema.prisma:L8439`
- `Area` → `schema.prisma:L2029`
- `BulkCommandOperation` → `schema.prisma:L6818`
- `CalendarSyncOutbox` → `schema.prisma:L9548`
- `CampaignDelivery` → `schema.prisma:L8589`
- `CashCloseout` → `schema.prisma:L7151`
- `CashDeposit` → `schema.prisma:L8266`
- `CashDrawerEvent` → `schema.prisma:L9991`
- `CashDrawerSession` → `schema.prisma:L9967`
- `Cfdi` → `schema.prisma:L10479`
- `ChatbotTokenBudget` → `schema.prisma:L6466`
- `ChatConversation` → `schema.prisma:L6321`
- `ChatFeedback` → `schema.prisma:L6407`
- `ChatLearningEvent` → `schema.prisma:L6364`
- `ChatMessage` → `schema.prisma:L6344`
- `ChatTrainingData` → `schema.prisma:L6278`
- `CheckoutSession` → `schema.prisma:L3899`
- `ClassSession` → `schema.prisma:L9169`
- `CommissionCalculation` → `schema.prisma:L8045`
- `CommissionClawback` → `schema.prisma:L8218`
- `CommissionConfig` → `schema.prisma:L7818`
- `CommissionMilestone` → `schema.prisma:L7961`
- `CommissionOverride` → `schema.prisma:L7888`
- `CommissionPayout` → `schema.prisma:L8169`
- `CommissionSummary` → `schema.prisma:L8108`
- `CommissionTier` → `schema.prisma:L7925`
- `Consumer` → `schema.prisma:L4928`
- `ConsumerAuthAccount` → `schema.prisma:L4953`
- `CouponCode` → `schema.prisma:L5247`
- `CouponRedemption` → `schema.prisma:L5278`
- `CreditAssessmentHistory` → `schema.prisma:L7260`
- `CreditItemBalance` → `schema.prisma:L9757`
- `CreditOffer` → `schema.prisma:L7279`
- `CreditPack` → `schema.prisma:L9673`
- `CreditPackItem` → `schema.prisma:L9702`
- `CreditPackPurchase` → `schema.prisma:L9719`
- `CreditTransaction` → `schema.prisma:L9779`
- `Customer` → `schema.prisma:L4836`
- `CustomerDiscount` → `schema.prisma:L5298`
- `CustomerGroup` → `schema.prisma:L4987`
- `CustomerTaxProfile` → `schema.prisma:L10548`
- `DeviceToken` → `schema.prisma:L5493`
- `DigitalReceipt` → `schema.prisma:L2803`
- `Discount` → `schema.prisma:L5148`
- `EcommerceMerchant` → `schema.prisma:L3711`
- `EmailTemplate` → `schema.prisma:L8528`
- `Estimate` → `schema.prisma:L10052`
- `EstimateItem` → `schema.prisma:L10080`
- `ExternalBusyBlock` → `schema.prisma:L9441`
- `Feature` → `schema.prisma:L2932`
- `FeeSchedule` → `schema.prisma:L3010`
- `FeeTier` → `schema.prisma:L3021`
- `FiscalEmisor` → `schema.prisma:L10421`
- `FloorElement` → `schema.prisma:L2105`
- `GeofenceRule` → `schema.prisma:L6903`
- `GoogleCalendarChannel` → `schema.prisma:L9418`
- `GoogleCalendarConnection` → `schema.prisma:L9370`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9471`
- `GoogleOAuthSession` → `schema.prisma:L9493`
- `HolidayCalendar` → `schema.prisma:L4734`
- `IdempotencyRequest` → `schema.prisma:L7693`
- `Inventory` → `schema.prisma:L1461`
- `InventoryMovement` → `schema.prisma:L1485`
- `InventoryTransfer` → `schema.prisma:L10024`
- `Invitation` → `schema.prisma:L1065`
- `Invoice` → `schema.prisma:L3033`
- `InvoiceItem` → `schema.prisma:L3059`
- `ItemCategory` → `schema.prisma:L7411`
- `KdsOrder` → `schema.prisma:L10185`
- `KdsOrderItem` → `schema.prisma:L10202`
- `LearnedPatterns` → `schema.prisma:L6388`
- `LiveDemoSession` → `schema.prisma:L606`
- `LowStockAlert` → `schema.prisma:L1900`
- `LoyaltyConfig` → `schema.prisma:L5017`
- `LoyaltyTransaction` → `schema.prisma:L5040`
- `MarketingCampaign` → `schema.prisma:L8546`
- `McpAuthCode` → `schema.prisma:L10328`
- `McpOAuthClient` → `schema.prisma:L10312`
- `McpRefreshToken` → `schema.prisma:L10346`
- `MeasurementUnit` → `schema.prisma:L10130`
- `Menu` → `schema.prisma:L1246`
- `MenuCategory` → `schema.prisma:L1188`
- `MenuCategoryAssignment` → `schema.prisma:L1281`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10261`
- `MerchantAccount` → `schema.prisma:L3493`
- `MerchantFiscalConfig` → `schema.prisma:L10457`
- `MerchantRevenueShare` → `schema.prisma:L4314`
- `MilestoneAchievement` → `schema.prisma:L8006`
- `Modifier` → `schema.prisma:L2550`
- `ModifierGroup` → `schema.prisma:L2514`
- `Module` → `schema.prisma:L7327`
- `MoneyAnomaly` → `schema.prisma:L4217`
- `MonthlyVenueProfit` → `schema.prisma:L4760`
- `Notification` → `schema.prisma:L5395`
- `NotificationPreference` → `schema.prisma:L5442`
- `NotificationTemplate` → `schema.prisma:L5469`
- `OAuthState` → `schema.prisma:L1116`
- `OnboardingProgress` → `schema.prisma:L1134`
- `Order` → `schema.prisma:L2292`
- `OrderAction` → `schema.prisma:L2615`
- `OrderCustomer` → `schema.prisma:L2419`
- `OrderDiscount` → `schema.prisma:L5330`
- `OrderItem` → `schema.prisma:L2435`
- `OrderItemModifier` → `schema.prisma:L2599`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8380`
- `OrganizationGoal` → `schema.prisma:L8338`
- `OrganizationModule` → `schema.prisma:L7383`
- `OrganizationPaymentConfig` → `schema.prisma:L4023`
- `OrganizationPayoutConfig` → `schema.prisma:L8406`
- `OrganizationPricingStructure` → `schema.prisma:L4055`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8361`
- `OtpChallenge` → `schema.prisma:L4972`
- `PartnerAPIKey` → `schema.prisma:L3853`
- `Payment` → `schema.prisma:L2648`
- `PaymentAllocation` → `schema.prisma:L2782`
- `PaymentLink` → `schema.prisma:L9825`
- `PaymentLinkAttribution` → `schema.prisma:L9933`
- `PaymentLinkItem` → `schema.prisma:L9888`
- `PaymentLinkItemModifier` → `schema.prisma:L9915`
- `PaymentProvider` → `schema.prisma:L3452`
- `PerformanceGoal` → `schema.prisma:L8315`
- `PermissionSet` → `schema.prisma:L1016`
- `PlatformSettings` → `schema.prisma:L3830`
- `PosCommand` → `schema.prisma:L5523`
- `PosConnectionStatus` → `schema.prisma:L682`
- `PricingPolicy` → `schema.prisma:L1811`
- `ProcessedStripeEvent` → `schema.prisma:L4203`
- `ProcessorReliabilityMetric` → `schema.prisma:L4688`
- `Product` → `schema.prisma:L1299`
- `ProductModifierGroup` → `schema.prisma:L2587`
- `ProductOption` → `schema.prisma:L10107`
- `ProductOptionValue` → `schema.prisma:L10118`
- `ProviderCostStructure` → `schema.prisma:L4239`
- `ProviderEventLog` → `schema.prisma:L4132`
- `PurchaseOrder` → `schema.prisma:L1726`
- `PurchaseOrderItem` → `schema.prisma:L1782`
- `RateCorrectionBatch` → `schema.prisma:L4464`
- `RateCorrectionEntry` → `schema.prisma:L4506`
- `RawMaterial` → `schema.prisma:L1515`
- `RawMaterialMovement` → `schema.prisma:L1864`
- `Recipe` → `schema.prisma:L1580`
- `RecipeLine` → `schema.prisma:L1604`
- `Referral` → `schema.prisma:L5102`
- `ReferralProgramConfig` → `schema.prisma:L5069`
- `Reservation` → `schema.prisma:L8925`
- `ReservationGoogleEventMapping` → `schema.prisma:L9605`
- `ReservationModifier` → `schema.prisma:L9084`
- `ReservationReminderSent` → `schema.prisma:L9067`
- `ReservationSettings` → `schema.prisma:L9245`
- `ReservationWaitlistEntry` → `schema.prisma:L9213`
- `Review` → `schema.prisma:L3077`
- `SaleVerification` → `schema.prisma:L2836`
- `ScheduledCommand` → `schema.prisma:L6863`
- `SerializedItem` → `schema.prisma:L7454`
- `SerializedItemCustodyEvent` → `schema.prisma:L7616`
- `SettlementConfiguration` → `schema.prisma:L4539`
- `SettlementConfirmation` → `schema.prisma:L4652`
- `SettlementIncident` → `schema.prisma:L4603`
- `SettlementSimulation` → `schema.prisma:L4574`
- `Shift` → `schema.prisma:L2143`
- `SimRegistrationRequest` → `schema.prisma:L7654`
- `SimRegistrationRequestItem` → `schema.prisma:L7676`
- `SlotHold` → `schema.prisma:L9124`
- `Staff` → `schema.prisma:L702`
- `StaffOnboardingState` → `schema.prisma:L10231`
- `StaffOrganization` → `schema.prisma:L930`
- `StaffPasskey` → `schema.prisma:L957`
- `StaffVenue` → `schema.prisma:L872`
- `StockAlertConfig` → `schema.prisma:L8297`
- `StockBatch` → `schema.prisma:L1983`
- `StockCount` → `schema.prisma:L1932`
- `StockCountItem` → `schema.prisma:L1953`
- `StripeWebhookEvent` → `schema.prisma:L4186`
- `Supplier` → `schema.prisma:L1639`
- `SupplierPricing` → `schema.prisma:L1692`
- `Table` → `schema.prisma:L2055`
- `Terminal` → `schema.prisma:L3128`
- `TerminalHealth` → `schema.prisma:L3272`
- `TerminalLog` → `schema.prisma:L3246`
- `TerminalOrder` → `schema.prisma:L3355`
- `TerminalOrderItem` → `schema.prisma:L3430`
- `TimeEntry` → `schema.prisma:L2208`
- `TimeEntryBreak` → `schema.prisma:L2277`
- `TokenPurchase` → `schema.prisma:L6537`
- `TokenUsageRecord` → `schema.prisma:L6509`
- `TpvCommandHistory` → `schema.prisma:L6769`
- `TpvCommandQueue` → `schema.prisma:L6709`
- `TpvFeedback` → `schema.prisma:L6422`
- `TpvMessage` → `schema.prisma:L8621`
- `TpvMessageDelivery` → `schema.prisma:L8673`
- `TpvMessageResponse` → `schema.prisma:L8696`
- `TrainingModule` → `schema.prisma:L8751`
- `TrainingProgress` → `schema.prisma:L8828`
- `TrainingQuizQuestion` → `schema.prisma:L8810`
- `TrainingStep` → `schema.prisma:L8790`
- `TransactionCost` → `schema.prisma:L4402`
- `UnitConversion` → `schema.prisma:L1842`
- `user_sessions` → `schema.prisma:L3888`
- `Venue` → `schema.prisma:L108`
- `VenueChatMessage` → `schema.prisma:L582`
- `VenueChatSession` → `schema.prisma:L537`
- `VenueCommission` → `schema.prisma:L10163`
- `VenueCreditAssessment` → `schema.prisma:L7199`
- `VenueCryptoConfig` → `schema.prisma:L8488`
- `VenueFeature` → `schema.prisma:L2950`
- `VenueModule` → `schema.prisma:L7355`
- `VenuePaymentConfig` → `schema.prisma:L3989`
- `VenuePaymentLinkSettings` → `schema.prisma:L9638`
- `VenuePricingStructure` → `schema.prisma:L4342`
- `VenueRoleConfig` → `schema.prisma:L1045`
- `VenueRolePermission` → `schema.prisma:L987`
- `VenueSettings` → `schema.prisma:L622`
- `VenueTransaction` → `schema.prisma:L2887`
- `VenueWhatsappActivation` → `schema.prisma:L473`
- `WebhookEvent` → `schema.prisma:L2986`
- `WebhookSubscription` → `schema.prisma:L4105`
- `WhatsappContactWindow` → `schema.prisma:L491`
- `WhatsappInboundEvent` → `schema.prisma:L511`
- `Zone` → `schema.prisma:L91`
