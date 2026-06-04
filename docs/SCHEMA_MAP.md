# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **219 models / 198 enums / ~10,500 lines**. Nobody reads it
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
| 12 | **Facturación (CFDI)** | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `Cfdi`, `CustomerTaxProfile`, `FiscalEmisor`, `MerchantFiscalConfig` |
| 13 | **Pricing, Costs & Venue Lending** | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment. | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure` |
| 14 | **Discounts, Loyalty & Credit Packs** | Discounts/coupons, loyalty points, and prepaid credit-pack bundles. | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig` |
| 15 | **Commissions & Sales Goals** | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter). | `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `VenueCommission` |
| 16 | **Reservations & Booking** | Appointments/classes, waitlist, slot holds, Google Calendar sync. | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold` |
| 17 | **Terminals / TPV Fleet** | PAX terminal fleet: health, logs, app updates, remote commands, messaging. | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig` |
| 18 | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns. | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent` |
| 19 | **AI Chatbot (Text-to-SQL)** | The in-dashboard AI assistant: conversations, training data, learned patterns. | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns` |
| 20 | **Customers, Consumers & Reviews** | End-customer identity (venue customers + cross-venue Consumers) and reviews. | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerGroup`, `Review` |
| 21 | **System: Audit, Webhooks & Platform** | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings. | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription` |

> Line numbers are section starts and drift as the schema grows — treat them as
> "jump near here", then search for the exact `model Name {`. When the map goes stale,
> regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `ActivityLog` → `schema.prisma:L4810`
- `Aggregator` → `schema.prisma:L10129`
- `AngelPayUserAccount` → `schema.prisma:L3619`
- `AppUpdate` → `schema.prisma:L8423`
- `Area` → `schema.prisma:L2029`
- `BulkCommandOperation` → `schema.prisma:L6802`
- `CalendarSyncOutbox` → `schema.prisma:L9532`
- `CampaignDelivery` → `schema.prisma:L8573`
- `CashCloseout` → `schema.prisma:L7135`
- `CashDeposit` → `schema.prisma:L8250`
- `CashDrawerEvent` → `schema.prisma:L9975`
- `CashDrawerSession` → `schema.prisma:L9951`
- `Cfdi` → `schema.prisma:L10413`
- `ChatbotTokenBudget` → `schema.prisma:L6450`
- `ChatConversation` → `schema.prisma:L6305`
- `ChatFeedback` → `schema.prisma:L6391`
- `ChatLearningEvent` → `schema.prisma:L6348`
- `ChatMessage` → `schema.prisma:L6328`
- `ChatTrainingData` → `schema.prisma:L6262`
- `CheckoutSession` → `schema.prisma:L3899`
- `ClassSession` → `schema.prisma:L9153`
- `CommissionCalculation` → `schema.prisma:L8029`
- `CommissionClawback` → `schema.prisma:L8202`
- `CommissionConfig` → `schema.prisma:L7802`
- `CommissionMilestone` → `schema.prisma:L7945`
- `CommissionOverride` → `schema.prisma:L7872`
- `CommissionPayout` → `schema.prisma:L8153`
- `CommissionSummary` → `schema.prisma:L8092`
- `CommissionTier` → `schema.prisma:L7909`
- `Consumer` → `schema.prisma:L4928`
- `ConsumerAuthAccount` → `schema.prisma:L4953`
- `CouponCode` → `schema.prisma:L5232`
- `CouponRedemption` → `schema.prisma:L5263`
- `CreditAssessmentHistory` → `schema.prisma:L7244`
- `CreditItemBalance` → `schema.prisma:L9741`
- `CreditOffer` → `schema.prisma:L7263`
- `CreditPack` → `schema.prisma:L9657`
- `CreditPackItem` → `schema.prisma:L9686`
- `CreditPackPurchase` → `schema.prisma:L9703`
- `CreditTransaction` → `schema.prisma:L9763`
- `Customer` → `schema.prisma:L4836`
- `CustomerDiscount` → `schema.prisma:L5283`
- `CustomerGroup` → `schema.prisma:L4972`
- `CustomerTaxProfile` → `schema.prisma:L10482`
- `DeviceToken` → `schema.prisma:L5478`
- `DigitalReceipt` → `schema.prisma:L2803`
- `Discount` → `schema.prisma:L5133`
- `EcommerceMerchant` → `schema.prisma:L3711`
- `EmailTemplate` → `schema.prisma:L8512`
- `Estimate` → `schema.prisma:L10036`
- `EstimateItem` → `schema.prisma:L10064`
- `ExternalBusyBlock` → `schema.prisma:L9425`
- `Feature` → `schema.prisma:L2932`
- `FeeSchedule` → `schema.prisma:L3010`
- `FeeTier` → `schema.prisma:L3021`
- `FiscalEmisor` → `schema.prisma:L10355`
- `FloorElement` → `schema.prisma:L2105`
- `GeofenceRule` → `schema.prisma:L6887`
- `GoogleCalendarChannel` → `schema.prisma:L9402`
- `GoogleCalendarConnection` → `schema.prisma:L9354`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9455`
- `GoogleOAuthSession` → `schema.prisma:L9477`
- `HolidayCalendar` → `schema.prisma:L4734`
- `IdempotencyRequest` → `schema.prisma:L7677`
- `Inventory` → `schema.prisma:L1461`
- `InventoryMovement` → `schema.prisma:L1485`
- `InventoryTransfer` → `schema.prisma:L10008`
- `Invitation` → `schema.prisma:L1065`
- `Invoice` → `schema.prisma:L3033`
- `InvoiceItem` → `schema.prisma:L3059`
- `ItemCategory` → `schema.prisma:L7395`
- `KdsOrder` → `schema.prisma:L10169`
- `KdsOrderItem` → `schema.prisma:L10186`
- `LearnedPatterns` → `schema.prisma:L6372`
- `LiveDemoSession` → `schema.prisma:L606`
- `LowStockAlert` → `schema.prisma:L1900`
- `LoyaltyConfig` → `schema.prisma:L5002`
- `LoyaltyTransaction` → `schema.prisma:L5025`
- `MarketingCampaign` → `schema.prisma:L8530`
- `MeasurementUnit` → `schema.prisma:L10114`
- `Menu` → `schema.prisma:L1246`
- `MenuCategory` → `schema.prisma:L1188`
- `MenuCategoryAssignment` → `schema.prisma:L1281`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10245`
- `MerchantAccount` → `schema.prisma:L3493`
- `MerchantFiscalConfig` → `schema.prisma:L10391`
- `MerchantRevenueShare` → `schema.prisma:L4314`
- `MilestoneAchievement` → `schema.prisma:L7990`
- `Modifier` → `schema.prisma:L2550`
- `ModifierGroup` → `schema.prisma:L2514`
- `Module` → `schema.prisma:L7311`
- `MoneyAnomaly` → `schema.prisma:L4217`
- `MonthlyVenueProfit` → `schema.prisma:L4760`
- `Notification` → `schema.prisma:L5380`
- `NotificationPreference` → `schema.prisma:L5427`
- `NotificationTemplate` → `schema.prisma:L5454`
- `OAuthState` → `schema.prisma:L1116`
- `OnboardingProgress` → `schema.prisma:L1134`
- `Order` → `schema.prisma:L2292`
- `OrderAction` → `schema.prisma:L2615`
- `OrderCustomer` → `schema.prisma:L2419`
- `OrderDiscount` → `schema.prisma:L5315`
- `OrderItem` → `schema.prisma:L2435`
- `OrderItemModifier` → `schema.prisma:L2599`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8364`
- `OrganizationGoal` → `schema.prisma:L8322`
- `OrganizationModule` → `schema.prisma:L7367`
- `OrganizationPaymentConfig` → `schema.prisma:L4023`
- `OrganizationPayoutConfig` → `schema.prisma:L8390`
- `OrganizationPricingStructure` → `schema.prisma:L4055`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8345`
- `PartnerAPIKey` → `schema.prisma:L3853`
- `Payment` → `schema.prisma:L2648`
- `PaymentAllocation` → `schema.prisma:L2782`
- `PaymentLink` → `schema.prisma:L9809`
- `PaymentLinkAttribution` → `schema.prisma:L9917`
- `PaymentLinkItem` → `schema.prisma:L9872`
- `PaymentLinkItemModifier` → `schema.prisma:L9899`
- `PaymentProvider` → `schema.prisma:L3452`
- `PerformanceGoal` → `schema.prisma:L8299`
- `PermissionSet` → `schema.prisma:L1016`
- `PlatformSettings` → `schema.prisma:L3830`
- `PosCommand` → `schema.prisma:L5508`
- `PosConnectionStatus` → `schema.prisma:L682`
- `PricingPolicy` → `schema.prisma:L1811`
- `ProcessedStripeEvent` → `schema.prisma:L4203`
- `ProcessorReliabilityMetric` → `schema.prisma:L4688`
- `Product` → `schema.prisma:L1299`
- `ProductModifierGroup` → `schema.prisma:L2587`
- `ProductOption` → `schema.prisma:L10091`
- `ProductOptionValue` → `schema.prisma:L10102`
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
- `Referral` → `schema.prisma:L5087`
- `ReferralProgramConfig` → `schema.prisma:L5054`
- `Reservation` → `schema.prisma:L8909`
- `ReservationGoogleEventMapping` → `schema.prisma:L9589`
- `ReservationModifier` → `schema.prisma:L9068`
- `ReservationReminderSent` → `schema.prisma:L9051`
- `ReservationSettings` → `schema.prisma:L9229`
- `ReservationWaitlistEntry` → `schema.prisma:L9197`
- `Review` → `schema.prisma:L3077`
- `SaleVerification` → `schema.prisma:L2836`
- `ScheduledCommand` → `schema.prisma:L6847`
- `SerializedItem` → `schema.prisma:L7438`
- `SerializedItemCustodyEvent` → `schema.prisma:L7600`
- `SettlementConfiguration` → `schema.prisma:L4539`
- `SettlementConfirmation` → `schema.prisma:L4652`
- `SettlementIncident` → `schema.prisma:L4603`
- `SettlementSimulation` → `schema.prisma:L4574`
- `Shift` → `schema.prisma:L2143`
- `SimRegistrationRequest` → `schema.prisma:L7638`
- `SimRegistrationRequestItem` → `schema.prisma:L7660`
- `SlotHold` → `schema.prisma:L9108`
- `Staff` → `schema.prisma:L702`
- `StaffOnboardingState` → `schema.prisma:L10215`
- `StaffOrganization` → `schema.prisma:L930`
- `StaffPasskey` → `schema.prisma:L957`
- `StaffVenue` → `schema.prisma:L872`
- `StockAlertConfig` → `schema.prisma:L8281`
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
- `TokenPurchase` → `schema.prisma:L6521`
- `TokenUsageRecord` → `schema.prisma:L6493`
- `TpvCommandHistory` → `schema.prisma:L6753`
- `TpvCommandQueue` → `schema.prisma:L6693`
- `TpvFeedback` → `schema.prisma:L6406`
- `TpvMessage` → `schema.prisma:L8605`
- `TpvMessageDelivery` → `schema.prisma:L8657`
- `TpvMessageResponse` → `schema.prisma:L8680`
- `TrainingModule` → `schema.prisma:L8735`
- `TrainingProgress` → `schema.prisma:L8812`
- `TrainingQuizQuestion` → `schema.prisma:L8794`
- `TrainingStep` → `schema.prisma:L8774`
- `TransactionCost` → `schema.prisma:L4402`
- `UnitConversion` → `schema.prisma:L1842`
- `user_sessions` → `schema.prisma:L3888`
- `Venue` → `schema.prisma:L108`
- `VenueChatMessage` → `schema.prisma:L582`
- `VenueChatSession` → `schema.prisma:L537`
- `VenueCommission` → `schema.prisma:L10147`
- `VenueCreditAssessment` → `schema.prisma:L7183`
- `VenueCryptoConfig` → `schema.prisma:L8472`
- `VenueFeature` → `schema.prisma:L2950`
- `VenueModule` → `schema.prisma:L7339`
- `VenuePaymentConfig` → `schema.prisma:L3989`
- `VenuePaymentLinkSettings` → `schema.prisma:L9622`
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
