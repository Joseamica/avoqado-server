# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **274 models / 252 enums / ~12,700 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 21 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                     |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `OAuthState`, `PermissionSet`, `PromoterLocationPing`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                  |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                  |
| 6   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                           |
| 7   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderItem`, `OrderItemModifier`, `OrderServiceCharge`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`                                                                                                                                                                                                |
| 9   | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                          |
| 10  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig` |
| 11  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 12  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                 |
| 13  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 14  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`                                                                                                                                                                                                                                                                               |
| 15  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                              |
| 16  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                             |
| 17  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`                                                                                                                                                                                                                               |
| 18  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                |
| 19  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 20  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 21  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L12033`
- `AccountMapping` → `schema.prisma:L11929`
- `ActivityLog` → `schema.prisma:L5390`
- `Aggregator` → `schema.prisma:L11077`
- `AngelPayUserAccount` → `schema.prisma:L4099`
- `AppUpdate` → `schema.prisma:L9306`
- `Area` → `schema.prisma:L2344`
- `BankStatement` → `schema.prisma:L11803`
- `BankStatementLine` → `schema.prisma:L11824`
- `BillingTaxProfile` → `schema.prisma:L12613`
- `BulkCommandOperation` → `schema.prisma:L7627`
- `CalendarSyncOutbox` → `schema.prisma:L10480`
- `CampaignDelivery` → `schema.prisma:L9464`
- `CashCloseout` → `schema.prisma:L7992`
- `CashDeposit` → `schema.prisma:L9108`
- `CashDrawerEvent` → `schema.prisma:L10923`
- `CashDrawerSession` → `schema.prisma:L10899`
- `CashOutCommissionRate` → `schema.prisma:L12442`
- `CashOutScheduleDay` → `schema.prisma:L12465`
- `CashOutWithdrawal` → `schema.prisma:L12527`
- `Cfdi` → `schema.prisma:L11706`
- `ChatbotTokenBudget` → `schema.prisma:L7275`
- `ChatConversation` → `schema.prisma:L7130`
- `ChatFeedback` → `schema.prisma:L7216`
- `ChatLearningEvent` → `schema.prisma:L7173`
- `ChatMessage` → `schema.prisma:L7153`
- `ChatTrainingData` → `schema.prisma:L7087`
- `CheckoutSession` → `schema.prisma:L4379`
- `ClassSession` → `schema.prisma:L10098`
- `CommissionCalculation` → `schema.prisma:L8887`
- `CommissionClawback` → `schema.prisma:L9060`
- `CommissionConfig` → `schema.prisma:L8660`
- `CommissionMilestone` → `schema.prisma:L8803`
- `CommissionOverride` → `schema.prisma:L8730`
- `CommissionPayout` → `schema.prisma:L9011`
- `CommissionSummary` → `schema.prisma:L8950`
- `CommissionTier` → `schema.prisma:L8767`
- `Consumer` → `schema.prisma:L5511`
- `ConsumerAuthAccount` → `schema.prisma:L5536`
- `CouponCode` → `schema.prisma:L5942`
- `CouponRedemption` → `schema.prisma:L5973`
- `CreditAssessmentHistory` → `schema.prisma:L8101`
- `CreditItemBalance` → `schema.prisma:L10689`
- `CreditOffer` → `schema.prisma:L8120`
- `CreditPack` → `schema.prisma:L10605`
- `CreditPackItem` → `schema.prisma:L10634`
- `CreditPackPurchase` → `schema.prisma:L10651`
- `CreditTransaction` → `schema.prisma:L10711`
- `Customer` → `schema.prisma:L5416`
- `CustomerDiscount` → `schema.prisma:L5993`
- `CustomerGroup` → `schema.prisma:L5570`
- `CustomerTaxProfile` → `schema.prisma:L11775`
- `DeliveryActivationRequest` → `schema.prisma:L4701`
- `DeliveryChannelLink` → `schema.prisma:L4665`
- `DeliveryOrderEvent` → `schema.prisma:L4725`
- `DeviceToken` → `schema.prisma:L6262`
- `DigitalReceipt` → `schema.prisma:L3193`
- `Discount` → `schema.prisma:L5842`
- `EcommerceMerchant` → `schema.prisma:L4191`
- `EmailTemplate` → `schema.prisma:L9403`
- `Employee` → `schema.prisma:L12290`
- `Estimate` → `schema.prisma:L10984`
- `EstimateItem` → `schema.prisma:L11012`
- `Expense` → `schema.prisma:L12077`
- `ExternalBusyBlock` → `schema.prisma:L10373`
- `Feature` → `schema.prisma:L3322`
- `FeeSchedule` → `schema.prisma:L3400`
- `FeeTier` → `schema.prisma:L3411`
- `FinancialAccount` → `schema.prisma:L11174`
- `FinancialConnection` → `schema.prisma:L11143`
- `FinancialProvider` → `schema.prisma:L11129`
- `FiscalEmisor` → `schema.prisma:L11629`
- `FiscalLossCarryforward` → `schema.prisma:L12200`
- `FixedAsset` → `schema.prisma:L12218`
- `FixedAssetDepreciation` → `schema.prisma:L12247`
- `FloorElement` → `schema.prisma:L2420`
- `GeofenceRule` → `schema.prisma:L7712`
- `GoogleCalendarChannel` → `schema.prisma:L10350`
- `GoogleCalendarConnection` → `schema.prisma:L10302`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L10403`
- `GoogleOAuthSession` → `schema.prisma:L10425`
- `HolidayCalendar` → `schema.prisma:L5314`
- `IdempotencyRequest` → `schema.prisma:L8535`
- `InterVenueTransfer` → `schema.prisma:L2172`
- `InterVenueTransferAllocation` → `schema.prisma:L2255`
- `InterVenueTransferItem` → `schema.prisma:L2224`
- `InterVenueTransferReceipt` → `schema.prisma:L2282`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2298`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2326`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2310`
- `Inventory` → `schema.prisma:L1577`
- `InventoryMovement` → `schema.prisma:L1604`
- `InventoryTransfer` → `schema.prisma:L10956`
- `Invitation` → `schema.prisma:L1162`
- `Invoice` → `schema.prisma:L3423`
- `InvoiceItem` → `schema.prisma:L3449`
- `ItemCategory` → `schema.prisma:L8252`
- `JournalEntry` → `schema.prisma:L11987`
- `JournalLine` → `schema.prisma:L12015`
- `KdsOrder` → `schema.prisma:L11222`
- `KdsOrderItem` → `schema.prisma:L11239`
- `LearnedPatterns` → `schema.prisma:L7197`
- `LedgerAccount` → `schema.prisma:L11879`
- `LiveDemoSession` → `schema.prisma:L675`
- `LowStockAlert` → `schema.prisma:L2026`
- `LoyaltyConfig` → `schema.prisma:L5600`
- `LoyaltyTransaction` → `schema.prisma:L5623`
- `MarketingCampaign` → `schema.prisma:L9421`
- `McpAuthCode` → `schema.prisma:L11536`
- `McpOAuthClient` → `schema.prisma:L11520`
- `McpRefreshToken` → `schema.prisma:L11554`
- `MeasurementUnit` → `schema.prisma:L11062`
- `Menu` → `schema.prisma:L1348`
- `MenuCategory` → `schema.prisma:L1285`
- `MenuCategoryAssignment` → `schema.prisma:L1383`
- `MercadoPagoWebhookEvent` → `schema.prisma:L11450`
- `MerchantAccount` → `schema.prisma:L3929`
- `MerchantFiscalConfig` → `schema.prisma:L11677`
- `MerchantRevenueShare` → `schema.prisma:L4894`
- `MerchantRoutingRule` → `schema.prisma:L4051`
- `MilestoneAchievement` → `schema.prisma:L8848`
- `Modifier` → `schema.prisma:L2935`
- `ModifierGroup` → `schema.prisma:L2899`
- `Module` → `schema.prisma:L8168`
- `MoneyAnomaly` → `schema.prisma:L4797`
- `MonthlyVenueProfit` → `schema.prisma:L5340`
- `Notification` → `schema.prisma:L6164`
- `NotificationPreference` → `schema.prisma:L6211`
- `NotificationTemplate` → `schema.prisma:L6238`
- `OAuthState` → `schema.prisma:L1213`
- `OnboardingProgress` → `schema.prisma:L1231`
- `Order` → `schema.prisma:L2644`
- `OrderAction` → `schema.prisma:L3000`
- `OrderCustomer` → `schema.prisma:L2780`
- `OrderDiscount` → `schema.prisma:L6025`
- `OrderItem` → `schema.prisma:L2796`
- `OrderItemModifier` → `schema.prisma:L2984`
- `OrderServiceCharge` → `schema.prisma:L6109`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L9222`
- `OrganizationGoal` → `schema.prisma:L9180`
- `OrganizationModule` → `schema.prisma:L8224`
- `OrganizationPaymentConfig` → `schema.prisma:L4503`
- `OrganizationPayoutConfig` → `schema.prisma:L9255`
- `OrganizationPricingStructure` → `schema.prisma:L4535`
- `OrganizationSalesGoalConfig` → `schema.prisma:L9203`
- `OtpChallenge` → `schema.prisma:L5555`
- `PartnerAPIKey` → `schema.prisma:L4333`
- `Payment` → `schema.prisma:L3033`
- `PaymentAllocation` → `schema.prisma:L3172`
- `PaymentLink` → `schema.prisma:L10757`
- `PaymentLinkAttribution` → `schema.prisma:L10865`
- `PaymentLinkItem` → `schema.prisma:L10820`
- `PaymentLinkItemModifier` → `schema.prisma:L10847`
- `PaymentProvider` → `schema.prisma:L3888`
- `PayrollLine` → `schema.prisma:L12361`
- `PayrollRun` → `schema.prisma:L12330`
- `PerformanceGoal` → `schema.prisma:L9157`
- `PermissionSet` → `schema.prisma:L1113`
- `PlatformCfdi` → `schema.prisma:L12642`
- `PlatformEmisor` → `schema.prisma:L12586`
- `PlatformSettings` → `schema.prisma:L4310`
- `PosCommand` → `schema.prisma:L6292`
- `PosConnectionStatus` → `schema.prisma:L760`
- `PricingPolicy` → `schema.prisma:L1937`
- `Printer` → `schema.prisma:L11268`
- `PrintGateway` → `schema.prisma:L11305`
- `PrintJob` → `schema.prisma:L11352`
- `PrintStation` → `schema.prisma:L11323`
- `ProcessedStripeEvent` → `schema.prisma:L4783`
- `ProcessorReliabilityMetric` → `schema.prisma:L5268`
- `Product` → `schema.prisma:L1401`
- `ProductModifierGroup` → `schema.prisma:L2972`
- `ProductOption` → `schema.prisma:L11039`
- `ProductOptionValue` → `schema.prisma:L11050`
- `ProductStaff` → `schema.prisma:L10013`
- `PromoterBankAccount` → `schema.prisma:L12481`
- `PromoterCommissionEntry` → `schema.prisma:L12500`
- `PromoterLocationPing` → `schema.prisma:L2610`
- `ProviderCostStructure` → `schema.prisma:L4819`
- `ProviderEventLog` → `schema.prisma:L4612`
- `PurchaseOrder` → `schema.prisma:L1851`
- `PurchaseOrderItem` → `schema.prisma:L1908`
- `RateCorrectionBatch` → `schema.prisma:L5044`
- `RateCorrectionEntry` → `schema.prisma:L5086`
- `RawMaterial` → `schema.prisma:L1637`
- `RawMaterialMovement` → `schema.prisma:L1990`
- `Recipe` → `schema.prisma:L1705`
- `RecipeLine` → `schema.prisma:L1729`
- `Referral` → `schema.prisma:L5690`
- `ReferralProgramConfig` → `schema.prisma:L5655`
- `ReferralRewardGrant` → `schema.prisma:L5781`
- `ReferralTierReward` → `schema.prisma:L5753`
- `ReferralTierUnlock` → `schema.prisma:L5826`
- `Reservation` → `schema.prisma:L9800`
- `ReservationGoogleEventMapping` → `schema.prisma:L10537`
- `ReservationModifier` → `schema.prisma:L9961`
- `ReservationReminderSent` → `schema.prisma:L9944`
- `ReservationSettings` → `schema.prisma:L10175`
- `ReservationWaitlistEntry` → `schema.prisma:L10143`
- `Review` → `schema.prisma:L3467`
- `SalesRetention` → `schema.prisma:L12181`
- `SaleVerification` → `schema.prisma:L3226`
- `ScheduledCommand` → `schema.prisma:L7672`
- `SerializedItem` → `schema.prisma:L8295`
- `SerializedItemCustodyEvent` → `schema.prisma:L8458`
- `ServiceCharge` → `schema.prisma:L6080`
- `SettlementConfiguration` → `schema.prisma:L5119`
- `SettlementConfirmation` → `schema.prisma:L5232`
- `SettlementIncident` → `schema.prisma:L5183`
- `SettlementSimulation` → `schema.prisma:L5154`
- `Shift` → `schema.prisma:L2458`
- `SimRegistrationRequest` → `schema.prisma:L8496`
- `SimRegistrationRequestItem` → `schema.prisma:L8518`
- `SlotHold` → `schema.prisma:L10044`
- `Staff` → `schema.prisma:L780`
- `StaffOnboardingState` → `schema.prisma:L11420`
- `StaffOrganization` → `schema.prisma:L1027`
- `StaffPasskey` → `schema.prisma:L1054`
- `StaffSchedule` → `schema.prisma:L9984`
- `StaffScheduleException` → `schema.prisma:L9996`
- `StaffVenue` → `schema.prisma:L957`
- `StockAlertConfig` → `schema.prisma:L9139`
- `StockBatch` → `schema.prisma:L2121`
- `StockCount` → `schema.prisma:L2058`
- `StockCountItem` → `schema.prisma:L2079`
- `StripeWebhookEvent` → `schema.prisma:L4766`
- `Supplier` → `schema.prisma:L1764`
- `SupplierPricing` → `schema.prisma:L1817`
- `Table` → `schema.prisma:L2370`
- `Terminal` → `schema.prisma:L3518`
- `TerminalHealth` → `schema.prisma:L3664`
- `TerminalLog` → `schema.prisma:L3638`
- `TerminalOrder` → `schema.prisma:L3791`
- `TerminalOrderItem` → `schema.prisma:L3866`
- `TerminalPaymentRequest` → `schema.prisma:L3735`
- `TimeEntry` → `schema.prisma:L2523`
- `TimeEntryBreak` → `schema.prisma:L2592`
- `TokenPurchase` → `schema.prisma:L7346`
- `TokenUsageRecord` → `schema.prisma:L7318`
- `TpvCommandHistory` → `schema.prisma:L7578`
- `TpvCommandQueue` → `schema.prisma:L7518`
- `TpvFeedback` → `schema.prisma:L7231`
- `TpvMessage` → `schema.prisma:L9496`
- `TpvMessageDelivery` → `schema.prisma:L9548`
- `TpvMessageResponse` → `schema.prisma:L9571`
- `TrainingModule` → `schema.prisma:L9626`
- `TrainingProgress` → `schema.prisma:L9703`
- `TrainingQuizQuestion` → `schema.prisma:L9685`
- `TrainingStep` → `schema.prisma:L9665`
- `TransactionCost` → `schema.prisma:L4982`
- `UnitConversion` → `schema.prisma:L1968`
- `user_sessions` → `schema.prisma:L4368`
- `Venue` → `schema.prisma:L116`
- `VenueChatMessage` → `schema.prisma:L651`
- `VenueChatSession` → `schema.prisma:L606`
- `VenueCommission` → `schema.prisma:L11200`
- `VenueCreditAssessment` → `schema.prisma:L8040`
- `VenueCryptoConfig` → `schema.prisma:L9363`
- `VenueFeature` → `schema.prisma:L3340`
- `VenueModule` → `schema.prisma:L8196`
- `VenuePaymentConfig` → `schema.prisma:L4469`
- `VenuePaymentLinkSettings` → `schema.prisma:L10570`
- `VenuePricingStructure` → `schema.prisma:L4922`
- `VenueRoleConfig` → `schema.prisma:L1142`
- `VenueRolePermission` → `schema.prisma:L1084`
- `VenueSettings` → `schema.prisma:L691`
- `VenueTransaction` → `schema.prisma:L3277`
- `VenueWhatsappActivation` → `schema.prisma:L542`
- `WebhookEvent` → `schema.prisma:L3376`
- `WebhookSubscription` → `schema.prisma:L4585`
- `WhatsappContactWindow` → `schema.prisma:L560`
- `WhatsappInboundEvent` → `schema.prisma:L580`
- `Zone` → `schema.prisma:L99`
