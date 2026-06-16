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
- `Aggregator` → `schema.prisma:L10195`
- `AngelPayUserAccount` → `schema.prisma:L3661`
- `AppUpdate` → `schema.prisma:L8488`
- `Area` → `schema.prisma:L2071`
- `BankStatement` → `schema.prisma:L10626`
- `BankStatementLine` → `schema.prisma:L10647`
- `BulkCommandOperation` → `schema.prisma:L6860`
- `CalendarSyncOutbox` → `schema.prisma:L9598`
- `CampaignDelivery` → `schema.prisma:L8639`
- `CashCloseout` → `schema.prisma:L7193`
- `CashDeposit` → `schema.prisma:L8308`
- `CashDrawerEvent` → `schema.prisma:L10041`
- `CashDrawerSession` → `schema.prisma:L10017`
- `Cfdi` → `schema.prisma:L10529`
- `ChatbotTokenBudget` → `schema.prisma:L6508`
- `ChatConversation` → `schema.prisma:L6363`
- `ChatFeedback` → `schema.prisma:L6449`
- `ChatLearningEvent` → `schema.prisma:L6406`
- `ChatMessage` → `schema.prisma:L6386`
- `ChatTrainingData` → `schema.prisma:L6320`
- `CheckoutSession` → `schema.prisma:L3941`
- `ClassSession` → `schema.prisma:L9219`
- `CommissionCalculation` → `schema.prisma:L8087`
- `CommissionClawback` → `schema.prisma:L8260`
- `CommissionConfig` → `schema.prisma:L7860`
- `CommissionMilestone` → `schema.prisma:L8003`
- `CommissionOverride` → `schema.prisma:L7930`
- `CommissionPayout` → `schema.prisma:L8211`
- `CommissionSummary` → `schema.prisma:L8150`
- `CommissionTier` → `schema.prisma:L7967`
- `Consumer` → `schema.prisma:L4970`
- `ConsumerAuthAccount` → `schema.prisma:L4995`
- `CouponCode` → `schema.prisma:L5289`
- `CouponRedemption` → `schema.prisma:L5320`
- `CreditAssessmentHistory` → `schema.prisma:L7302`
- `CreditItemBalance` → `schema.prisma:L9807`
- `CreditOffer` → `schema.prisma:L7321`
- `CreditPack` → `schema.prisma:L9723`
- `CreditPackItem` → `schema.prisma:L9752`
- `CreditPackPurchase` → `schema.prisma:L9769`
- `CreditTransaction` → `schema.prisma:L9829`
- `Customer` → `schema.prisma:L4878`
- `CustomerDiscount` → `schema.prisma:L5340`
- `CustomerGroup` → `schema.prisma:L5029`
- `CustomerTaxProfile` → `schema.prisma:L10598`
- `DeviceToken` → `schema.prisma:L5535`
- `DigitalReceipt` → `schema.prisma:L2845`
- `Discount` → `schema.prisma:L5190`
- `EcommerceMerchant` → `schema.prisma:L3753`
- `EmailTemplate` → `schema.prisma:L8578`
- `Estimate` → `schema.prisma:L10102`
- `EstimateItem` → `schema.prisma:L10130`
- `ExternalBusyBlock` → `schema.prisma:L9491`
- `Feature` → `schema.prisma:L2974`
- `FeeSchedule` → `schema.prisma:L3052`
- `FeeTier` → `schema.prisma:L3063`
- `FiscalEmisor` → `schema.prisma:L10471`
- `FloorElement` → `schema.prisma:L2147`
- `GeofenceRule` → `schema.prisma:L6945`
- `GoogleCalendarChannel` → `schema.prisma:L9468`
- `GoogleCalendarConnection` → `schema.prisma:L9420`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9521`
- `GoogleOAuthSession` → `schema.prisma:L9543`
- `HolidayCalendar` → `schema.prisma:L4776`
- `IdempotencyRequest` → `schema.prisma:L7735`
- `Inventory` → `schema.prisma:L1502`
- `InventoryMovement` → `schema.prisma:L1526`
- `InventoryTransfer` → `schema.prisma:L10074`
- `Invitation` → `schema.prisma:L1106`
- `Invoice` → `schema.prisma:L3075`
- `InvoiceItem` → `schema.prisma:L3101`
- `ItemCategory` → `schema.prisma:L7453`
- `KdsOrder` → `schema.prisma:L10235`
- `KdsOrderItem` → `schema.prisma:L10252`
- `LearnedPatterns` → `schema.prisma:L6430`
- `LiveDemoSession` → `schema.prisma:L641`
- `LowStockAlert` → `schema.prisma:L1942`
- `LoyaltyConfig` → `schema.prisma:L5059`
- `LoyaltyTransaction` → `schema.prisma:L5082`
- `MarketingCampaign` → `schema.prisma:L8596`
- `McpAuthCode` → `schema.prisma:L10378`
- `McpOAuthClient` → `schema.prisma:L10362`
- `McpRefreshToken` → `schema.prisma:L10396`
- `MeasurementUnit` → `schema.prisma:L10180`
- `Menu` → `schema.prisma:L1287`
- `MenuCategory` → `schema.prisma:L1229`
- `MenuCategoryAssignment` → `schema.prisma:L1322`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10311`
- `MerchantAccount` → `schema.prisma:L3535`
- `MerchantFiscalConfig` → `schema.prisma:L10507`
- `MerchantRevenueShare` → `schema.prisma:L4356`
- `MilestoneAchievement` → `schema.prisma:L8048`
- `Modifier` → `schema.prisma:L2592`
- `ModifierGroup` → `schema.prisma:L2556`
- `Module` → `schema.prisma:L7369`
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
- `OrganizationAttendanceConfig` → `schema.prisma:L8422`
- `OrganizationGoal` → `schema.prisma:L8380`
- `OrganizationModule` → `schema.prisma:L7425`
- `OrganizationPaymentConfig` → `schema.prisma:L4065`
- `OrganizationPayoutConfig` → `schema.prisma:L8448`
- `OrganizationPricingStructure` → `schema.prisma:L4097`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8403`
- `OtpChallenge` → `schema.prisma:L5014`
- `PartnerAPIKey` → `schema.prisma:L3895`
- `Payment` → `schema.prisma:L2690`
- `PaymentAllocation` → `schema.prisma:L2824`
- `PaymentLink` → `schema.prisma:L9875`
- `PaymentLinkAttribution` → `schema.prisma:L9983`
- `PaymentLinkItem` → `schema.prisma:L9938`
- `PaymentLinkItemModifier` → `schema.prisma:L9965`
- `PaymentProvider` → `schema.prisma:L3494`
- `PerformanceGoal` → `schema.prisma:L8357`
- `PermissionSet` → `schema.prisma:L1057`
- `PlatformSettings` → `schema.prisma:L3872`
- `PosCommand` → `schema.prisma:L5565`
- `PosConnectionStatus` → `schema.prisma:L717`
- `PricingPolicy` → `schema.prisma:L1853`
- `ProcessedStripeEvent` → `schema.prisma:L4245`
- `ProcessorReliabilityMetric` → `schema.prisma:L4730`
- `Product` → `schema.prisma:L1340`
- `ProductModifierGroup` → `schema.prisma:L2629`
- `ProductOption` → `schema.prisma:L10157`
- `ProductOptionValue` → `schema.prisma:L10168`
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
- `Reservation` → `schema.prisma:L8975`
- `ReservationGoogleEventMapping` → `schema.prisma:L9655`
- `ReservationModifier` → `schema.prisma:L9134`
- `ReservationReminderSent` → `schema.prisma:L9117`
- `ReservationSettings` → `schema.prisma:L9295`
- `ReservationWaitlistEntry` → `schema.prisma:L9263`
- `Review` → `schema.prisma:L3119`
- `SaleVerification` → `schema.prisma:L2878`
- `ScheduledCommand` → `schema.prisma:L6905`
- `SerializedItem` → `schema.prisma:L7496`
- `SerializedItemCustodyEvent` → `schema.prisma:L7658`
- `SettlementConfiguration` → `schema.prisma:L4581`
- `SettlementConfirmation` → `schema.prisma:L4694`
- `SettlementIncident` → `schema.prisma:L4645`
- `SettlementSimulation` → `schema.prisma:L4616`
- `Shift` → `schema.prisma:L2185`
- `SimRegistrationRequest` → `schema.prisma:L7696`
- `SimRegistrationRequestItem` → `schema.prisma:L7718`
- `SlotHold` → `schema.prisma:L9174`
- `Staff` → `schema.prisma:L737`
- `StaffOnboardingState` → `schema.prisma:L10281`
- `StaffOrganization` → `schema.prisma:L971`
- `StaffPasskey` → `schema.prisma:L998`
- `StaffVenue` → `schema.prisma:L907`
- `StockAlertConfig` → `schema.prisma:L8339`
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
- `TokenPurchase` → `schema.prisma:L6579`
- `TokenUsageRecord` → `schema.prisma:L6551`
- `TpvCommandHistory` → `schema.prisma:L6811`
- `TpvCommandQueue` → `schema.prisma:L6751`
- `TpvFeedback` → `schema.prisma:L6464`
- `TpvMessage` → `schema.prisma:L8671`
- `TpvMessageDelivery` → `schema.prisma:L8723`
- `TpvMessageResponse` → `schema.prisma:L8746`
- `TrainingModule` → `schema.prisma:L8801`
- `TrainingProgress` → `schema.prisma:L8878`
- `TrainingQuizQuestion` → `schema.prisma:L8860`
- `TrainingStep` → `schema.prisma:L8840`
- `TransactionCost` → `schema.prisma:L4444`
- `UnitConversion` → `schema.prisma:L1884`
- `user_sessions` → `schema.prisma:L3930`
- `Venue` → `schema.prisma:L108`
- `VenueChatMessage` → `schema.prisma:L617`
- `VenueChatSession` → `schema.prisma:L572`
- `VenueCommission` → `schema.prisma:L10213`
- `VenueCreditAssessment` → `schema.prisma:L7241`
- `VenueCryptoConfig` → `schema.prisma:L8538`
- `VenueFeature` → `schema.prisma:L2992`
- `VenueModule` → `schema.prisma:L7397`
- `VenuePaymentConfig` → `schema.prisma:L4031`
- `VenuePaymentLinkSettings` → `schema.prisma:L9688`
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
