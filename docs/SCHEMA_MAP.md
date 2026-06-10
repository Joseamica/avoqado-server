# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **223 models / 198 enums / ~10,600 lines**. Nobody reads it top to bottom. This file is the **index**: 20 domains,
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

- `ActivityLog` → `schema.prisma:L4842`
- `Aggregator` → `schema.prisma:L10177`
- `AngelPayUserAccount` → `schema.prisma:L3651`
- `AppUpdate` → `schema.prisma:L8471`
- `Area` → `schema.prisma:L2061`
- `BulkCommandOperation` → `schema.prisma:L6850`
- `CalendarSyncOutbox` → `schema.prisma:L9580`
- `CampaignDelivery` → `schema.prisma:L8621`
- `CashCloseout` → `schema.prisma:L7183`
- `CashDeposit` → `schema.prisma:L8298`
- `CashDrawerEvent` → `schema.prisma:L10023`
- `CashDrawerSession` → `schema.prisma:L9999`
- `Cfdi` → `schema.prisma:L10511`
- `ChatbotTokenBudget` → `schema.prisma:L6498`
- `ChatConversation` → `schema.prisma:L6353`
- `ChatFeedback` → `schema.prisma:L6439`
- `ChatLearningEvent` → `schema.prisma:L6396`
- `ChatMessage` → `schema.prisma:L6376`
- `ChatTrainingData` → `schema.prisma:L6310`
- `CheckoutSession` → `schema.prisma:L3931`
- `ClassSession` → `schema.prisma:L9201`
- `CommissionCalculation` → `schema.prisma:L8077`
- `CommissionClawback` → `schema.prisma:L8250`
- `CommissionConfig` → `schema.prisma:L7850`
- `CommissionMilestone` → `schema.prisma:L7993`
- `CommissionOverride` → `schema.prisma:L7920`
- `CommissionPayout` → `schema.prisma:L8201`
- `CommissionSummary` → `schema.prisma:L8140`
- `CommissionTier` → `schema.prisma:L7957`
- `Consumer` → `schema.prisma:L4960`
- `ConsumerAuthAccount` → `schema.prisma:L4985`
- `CouponCode` → `schema.prisma:L5279`
- `CouponRedemption` → `schema.prisma:L5310`
- `CreditAssessmentHistory` → `schema.prisma:L7292`
- `CreditItemBalance` → `schema.prisma:L9789`
- `CreditOffer` → `schema.prisma:L7311`
- `CreditPack` → `schema.prisma:L9705`
- `CreditPackItem` → `schema.prisma:L9734`
- `CreditPackPurchase` → `schema.prisma:L9751`
- `CreditTransaction` → `schema.prisma:L9811`
- `Customer` → `schema.prisma:L4868`
- `CustomerDiscount` → `schema.prisma:L5330`
- `CustomerGroup` → `schema.prisma:L5019`
- `CustomerTaxProfile` → `schema.prisma:L10580`
- `DeviceToken` → `schema.prisma:L5525`
- `DigitalReceipt` → `schema.prisma:L2835`
- `Discount` → `schema.prisma:L5180`
- `EcommerceMerchant` → `schema.prisma:L3743`
- `EmailTemplate` → `schema.prisma:L8560`
- `Estimate` → `schema.prisma:L10084`
- `EstimateItem` → `schema.prisma:L10112`
- `ExternalBusyBlock` → `schema.prisma:L9473`
- `Feature` → `schema.prisma:L2964`
- `FeeSchedule` → `schema.prisma:L3042`
- `FeeTier` → `schema.prisma:L3053`
- `FiscalEmisor` → `schema.prisma:L10453`
- `FloorElement` → `schema.prisma:L2137`
- `GeofenceRule` → `schema.prisma:L6935`
- `GoogleCalendarChannel` → `schema.prisma:L9450`
- `GoogleCalendarConnection` → `schema.prisma:L9402`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9503`
- `GoogleOAuthSession` → `schema.prisma:L9525`
- `HolidayCalendar` → `schema.prisma:L4766`
- `IdempotencyRequest` → `schema.prisma:L7725`
- `Inventory` → `schema.prisma:L1493`
- `InventoryMovement` → `schema.prisma:L1517`
- `InventoryTransfer` → `schema.prisma:L10056`
- `Invitation` → `schema.prisma:L1097`
- `Invoice` → `schema.prisma:L3065`
- `InvoiceItem` → `schema.prisma:L3091`
- `ItemCategory` → `schema.prisma:L7443`
- `KdsOrder` → `schema.prisma:L10217`
- `KdsOrderItem` → `schema.prisma:L10234`
- `LearnedPatterns` → `schema.prisma:L6420`
- `LiveDemoSession` → `schema.prisma:L632`
- `LowStockAlert` → `schema.prisma:L1932`
- `LoyaltyConfig` → `schema.prisma:L5049`
- `LoyaltyTransaction` → `schema.prisma:L5072`
- `MarketingCampaign` → `schema.prisma:L8578`
- `McpAuthCode` → `schema.prisma:L10360`
- `McpOAuthClient` → `schema.prisma:L10344`
- `McpRefreshToken` → `schema.prisma:L10378`
- `MeasurementUnit` → `schema.prisma:L10162`
- `Menu` → `schema.prisma:L1278`
- `MenuCategory` → `schema.prisma:L1220`
- `MenuCategoryAssignment` → `schema.prisma:L1313`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10293`
- `MerchantAccount` → `schema.prisma:L3525`
- `MerchantFiscalConfig` → `schema.prisma:L10489`
- `MerchantRevenueShare` → `schema.prisma:L4346`
- `MilestoneAchievement` → `schema.prisma:L8038`
- `Modifier` → `schema.prisma:L2582`
- `ModifierGroup` → `schema.prisma:L2546`
- `Module` → `schema.prisma:L7359`
- `MoneyAnomaly` → `schema.prisma:L4249`
- `MonthlyVenueProfit` → `schema.prisma:L4792`
- `Notification` → `schema.prisma:L5427`
- `NotificationPreference` → `schema.prisma:L5474`
- `NotificationTemplate` → `schema.prisma:L5501`
- `OAuthState` → `schema.prisma:L1148`
- `OnboardingProgress` → `schema.prisma:L1166`
- `Order` → `schema.prisma:L2324`
- `OrderAction` → `schema.prisma:L2647`
- `OrderCustomer` → `schema.prisma:L2451`
- `OrderDiscount` → `schema.prisma:L5362`
- `OrderItem` → `schema.prisma:L2467`
- `OrderItemModifier` → `schema.prisma:L2631`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8412`
- `OrganizationGoal` → `schema.prisma:L8370`
- `OrganizationModule` → `schema.prisma:L7415`
- `OrganizationPaymentConfig` → `schema.prisma:L4055`
- `OrganizationPayoutConfig` → `schema.prisma:L8438`
- `OrganizationPricingStructure` → `schema.prisma:L4087`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8393`
- `OtpChallenge` → `schema.prisma:L5004`
- `PartnerAPIKey` → `schema.prisma:L3885`
- `Payment` → `schema.prisma:L2680`
- `PaymentAllocation` → `schema.prisma:L2814`
- `PaymentLink` → `schema.prisma:L9857`
- `PaymentLinkAttribution` → `schema.prisma:L9965`
- `PaymentLinkItem` → `schema.prisma:L9920`
- `PaymentLinkItemModifier` → `schema.prisma:L9947`
- `PaymentProvider` → `schema.prisma:L3484`
- `PerformanceGoal` → `schema.prisma:L8347`
- `PermissionSet` → `schema.prisma:L1048`
- `PlatformSettings` → `schema.prisma:L3862`
- `PosCommand` → `schema.prisma:L5555`
- `PosConnectionStatus` → `schema.prisma:L708`
- `PricingPolicy` → `schema.prisma:L1843`
- `ProcessedStripeEvent` → `schema.prisma:L4235`
- `ProcessorReliabilityMetric` → `schema.prisma:L4720`
- `Product` → `schema.prisma:L1331`
- `ProductModifierGroup` → `schema.prisma:L2619`
- `ProductOption` → `schema.prisma:L10139`
- `ProductOptionValue` → `schema.prisma:L10150`
- `ProviderCostStructure` → `schema.prisma:L4271`
- `ProviderEventLog` → `schema.prisma:L4164`
- `PurchaseOrder` → `schema.prisma:L1758`
- `PurchaseOrderItem` → `schema.prisma:L1814`
- `RateCorrectionBatch` → `schema.prisma:L4496`
- `RateCorrectionEntry` → `schema.prisma:L4538`
- `RawMaterial` → `schema.prisma:L1547`
- `RawMaterialMovement` → `schema.prisma:L1896`
- `Recipe` → `schema.prisma:L1612`
- `RecipeLine` → `schema.prisma:L1636`
- `Referral` → `schema.prisma:L5134`
- `ReferralProgramConfig` → `schema.prisma:L5101`
- `Reservation` → `schema.prisma:L8957`
- `ReservationGoogleEventMapping` → `schema.prisma:L9637`
- `ReservationModifier` → `schema.prisma:L9116`
- `ReservationReminderSent` → `schema.prisma:L9099`
- `ReservationSettings` → `schema.prisma:L9277`
- `ReservationWaitlistEntry` → `schema.prisma:L9245`
- `Review` → `schema.prisma:L3109`
- `SaleVerification` → `schema.prisma:L2868`
- `ScheduledCommand` → `schema.prisma:L6895`
- `SerializedItem` → `schema.prisma:L7486`
- `SerializedItemCustodyEvent` → `schema.prisma:L7648`
- `SettlementConfiguration` → `schema.prisma:L4571`
- `SettlementConfirmation` → `schema.prisma:L4684`
- `SettlementIncident` → `schema.prisma:L4635`
- `SettlementSimulation` → `schema.prisma:L4606`
- `Shift` → `schema.prisma:L2175`
- `SimRegistrationRequest` → `schema.prisma:L7686`
- `SimRegistrationRequestItem` → `schema.prisma:L7708`
- `SlotHold` → `schema.prisma:L9156`
- `Staff` → `schema.prisma:L728`
- `StaffOnboardingState` → `schema.prisma:L10263`
- `StaffOrganization` → `schema.prisma:L962`
- `StaffPasskey` → `schema.prisma:L989`
- `StaffVenue` → `schema.prisma:L898`
- `StockAlertConfig` → `schema.prisma:L8329`
- `StockBatch` → `schema.prisma:L2015`
- `StockCount` → `schema.prisma:L1964`
- `StockCountItem` → `schema.prisma:L1985`
- `StripeWebhookEvent` → `schema.prisma:L4218`
- `Supplier` → `schema.prisma:L1671`
- `SupplierPricing` → `schema.prisma:L1724`
- `Table` → `schema.prisma:L2087`
- `Terminal` → `schema.prisma:L3160`
- `TerminalHealth` → `schema.prisma:L3304`
- `TerminalLog` → `schema.prisma:L3278`
- `TerminalOrder` → `schema.prisma:L3387`
- `TerminalOrderItem` → `schema.prisma:L3462`
- `TimeEntry` → `schema.prisma:L2240`
- `TimeEntryBreak` → `schema.prisma:L2309`
- `TokenPurchase` → `schema.prisma:L6569`
- `TokenUsageRecord` → `schema.prisma:L6541`
- `TpvCommandHistory` → `schema.prisma:L6801`
- `TpvCommandQueue` → `schema.prisma:L6741`
- `TpvFeedback` → `schema.prisma:L6454`
- `TpvMessage` → `schema.prisma:L8653`
- `TpvMessageDelivery` → `schema.prisma:L8705`
- `TpvMessageResponse` → `schema.prisma:L8728`
- `TrainingModule` → `schema.prisma:L8783`
- `TrainingProgress` → `schema.prisma:L8860`
- `TrainingQuizQuestion` → `schema.prisma:L8842`
- `TrainingStep` → `schema.prisma:L8822`
- `TransactionCost` → `schema.prisma:L4434`
- `UnitConversion` → `schema.prisma:L1874`
- `user_sessions` → `schema.prisma:L3920`
- `Venue` → `schema.prisma:L108`
- `VenueChatMessage` → `schema.prisma:L608`
- `VenueChatSession` → `schema.prisma:L563`
- `VenueCommission` → `schema.prisma:L10195`
- `VenueCreditAssessment` → `schema.prisma:L7231`
- `VenueCryptoConfig` → `schema.prisma:L8520`
- `VenueFeature` → `schema.prisma:L2982`
- `VenueModule` → `schema.prisma:L7387`
- `VenuePaymentConfig` → `schema.prisma:L4021`
- `VenuePaymentLinkSettings` → `schema.prisma:L9670`
- `VenuePricingStructure` → `schema.prisma:L4374`
- `VenueRoleConfig` → `schema.prisma:L1077`
- `VenueRolePermission` → `schema.prisma:L1019`
- `VenueSettings` → `schema.prisma:L648`
- `VenueTransaction` → `schema.prisma:L2919`
- `VenueWhatsappActivation` → `schema.prisma:L499`
- `WebhookEvent` → `schema.prisma:L3018`
- `WebhookSubscription` → `schema.prisma:L4137`
- `WhatsappContactWindow` → `schema.prisma:L517`
- `WhatsappInboundEvent` → `schema.prisma:L537`
- `Zone` → `schema.prisma:L91`
