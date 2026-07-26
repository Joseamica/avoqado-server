# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **276 models / 252 enums / ~12,700 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
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
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `PermissionSet`, `PromoterLocationPing`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                   |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                  |
| 6   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                           |
| 7   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderItem`, `OrderItemModifier`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`                                                                                                                                                                               |
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

- `AccountingPeriodLock` → `schema.prisma:L12064`
- `AccountMapping` → `schema.prisma:L11960`
- `ActivityLog` → `schema.prisma:L5397`
- `Aggregator` → `schema.prisma:L11084`
- `AngelPayUserAccount` → `schema.prisma:L4106`
- `AppUpdate` → `schema.prisma:L9313`
- `Area` → `schema.prisma:L2351`
- `BankStatement` → `schema.prisma:L11834`
- `BankStatementLine` → `schema.prisma:L11855`
- `BillingTaxProfile` → `schema.prisma:L12644`
- `BulkCommandOperation` → `schema.prisma:L7634`
- `CalendarSyncOutbox` → `schema.prisma:L10487`
- `CampaignDelivery` → `schema.prisma:L9471`
- `CashCloseout` → `schema.prisma:L7999`
- `CashDeposit` → `schema.prisma:L9115`
- `CashDrawerEvent` → `schema.prisma:L10930`
- `CashDrawerSession` → `schema.prisma:L10906`
- `CashOutCommissionRate` → `schema.prisma:L12473`
- `CashOutScheduleDay` → `schema.prisma:L12496`
- `CashOutWithdrawal` → `schema.prisma:L12558`
- `Cfdi` → `schema.prisma:L11737`
- `ChatbotTokenBudget` → `schema.prisma:L7282`
- `ChatConversation` → `schema.prisma:L7137`
- `ChatFeedback` → `schema.prisma:L7223`
- `ChatLearningEvent` → `schema.prisma:L7180`
- `ChatMessage` → `schema.prisma:L7160`
- `ChatTrainingData` → `schema.prisma:L7094`
- `CheckoutSession` → `schema.prisma:L4386`
- `ClassSession` → `schema.prisma:L10105`
- `CommissionCalculation` → `schema.prisma:L8894`
- `CommissionClawback` → `schema.prisma:L9067`
- `CommissionConfig` → `schema.prisma:L8667`
- `CommissionMilestone` → `schema.prisma:L8810`
- `CommissionOverride` → `schema.prisma:L8737`
- `CommissionPayout` → `schema.prisma:L9018`
- `CommissionSummary` → `schema.prisma:L8957`
- `CommissionTier` → `schema.prisma:L8774`
- `Consumer` → `schema.prisma:L5518`
- `ConsumerAuthAccount` → `schema.prisma:L5543`
- `CouponCode` → `schema.prisma:L5949`
- `CouponRedemption` → `schema.prisma:L5980`
- `CreditAssessmentHistory` → `schema.prisma:L8108`
- `CreditItemBalance` → `schema.prisma:L10696`
- `CreditOffer` → `schema.prisma:L8127`
- `CreditPack` → `schema.prisma:L10612`
- `CreditPackItem` → `schema.prisma:L10641`
- `CreditPackPurchase` → `schema.prisma:L10658`
- `CreditTransaction` → `schema.prisma:L10718`
- `Customer` → `schema.prisma:L5423`
- `CustomerDiscount` → `schema.prisma:L6000`
- `CustomerGroup` → `schema.prisma:L5577`
- `CustomerTaxProfile` → `schema.prisma:L11806`
- `DeliveryActivationRequest` → `schema.prisma:L4708`
- `DeliveryChannelLink` → `schema.prisma:L4672`
- `DeliveryOrderEvent` → `schema.prisma:L4732`
- `DeviceToken` → `schema.prisma:L6269`
- `DigitalReceipt` → `schema.prisma:L3200`
- `Discount` → `schema.prisma:L5849`
- `EcommerceMerchant` → `schema.prisma:L4198`
- `EmailTemplate` → `schema.prisma:L9410`
- `Employee` → `schema.prisma:L12321`
- `Estimate` → `schema.prisma:L10991`
- `EstimateItem` → `schema.prisma:L11019`
- `Expense` → `schema.prisma:L12108`
- `ExternalBusyBlock` → `schema.prisma:L10380`
- `Feature` → `schema.prisma:L3329`
- `FeeSchedule` → `schema.prisma:L3407`
- `FeeTier` → `schema.prisma:L3418`
- `FinancialAccount` → `schema.prisma:L11181`
- `FinancialConnection` → `schema.prisma:L11150`
- `FinancialProvider` → `schema.prisma:L11136`
- `FiscalEmisor` → `schema.prisma:L11660`
- `FiscalLossCarryforward` → `schema.prisma:L12231`
- `FixedAsset` → `schema.prisma:L12249`
- `FixedAssetDepreciation` → `schema.prisma:L12278`
- `FloorElement` → `schema.prisma:L2427`
- `GeofenceRule` → `schema.prisma:L7719`
- `GoogleCalendarChannel` → `schema.prisma:L10357`
- `GoogleCalendarConnection` → `schema.prisma:L10309`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L10410`
- `GoogleOAuthSession` → `schema.prisma:L10432`
- `HolidayCalendar` → `schema.prisma:L5321`
- `IdempotencyRequest` → `schema.prisma:L8542`
- `InterVenueTransfer` → `schema.prisma:L2179`
- `InterVenueTransferAllocation` → `schema.prisma:L2262`
- `InterVenueTransferItem` → `schema.prisma:L2231`
- `InterVenueTransferReceipt` → `schema.prisma:L2289`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2305`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2333`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2317`
- `Inventory` → `schema.prisma:L1584`
- `InventoryMovement` → `schema.prisma:L1611`
- `InventoryTransfer` → `schema.prisma:L10963`
- `Invitation` → `schema.prisma:L1169`
- `Invoice` → `schema.prisma:L3430`
- `InvoiceItem` → `schema.prisma:L3456`
- `ItemCategory` → `schema.prisma:L8259`
- `JournalEntry` → `schema.prisma:L12018`
- `JournalLine` → `schema.prisma:L12046`
- `KdsOrder` → `schema.prisma:L11229`
- `KdsOrderItem` → `schema.prisma:L11246`
- `LearnedPatterns` → `schema.prisma:L7204`
- `LedgerAccount` → `schema.prisma:L11910`
- `LiveDemoSession` → `schema.prisma:L675`
- `LowStockAlert` → `schema.prisma:L2033`
- `LoyaltyConfig` → `schema.prisma:L5607`
- `LoyaltyTransaction` → `schema.prisma:L5630`
- `MarketingCampaign` → `schema.prisma:L9428`
- `McpAuthCode` → `schema.prisma:L11543`
- `McpOAuthClient` → `schema.prisma:L11527`
- `McpRefreshToken` → `schema.prisma:L11561`
- `McpToolCall` → `schema.prisma:L11582`
- `MeasurementUnit` → `schema.prisma:L11069`
- `Menu` → `schema.prisma:L1355`
- `MenuCategory` → `schema.prisma:L1292`
- `MenuCategoryAssignment` → `schema.prisma:L1390`
- `MercadoPagoWebhookEvent` → `schema.prisma:L11457`
- `MerchantAccount` → `schema.prisma:L3936`
- `MerchantFiscalConfig` → `schema.prisma:L11708`
- `MerchantRevenueShare` → `schema.prisma:L4901`
- `MerchantRoutingRule` → `schema.prisma:L4058`
- `MilestoneAchievement` → `schema.prisma:L8855`
- `Modifier` → `schema.prisma:L2942`
- `ModifierGroup` → `schema.prisma:L2906`
- `Module` → `schema.prisma:L8175`
- `MoneyAnomaly` → `schema.prisma:L4804`
- `MonthlyVenueProfit` → `schema.prisma:L5347`
- `Notification` → `schema.prisma:L6171`
- `NotificationPreference` → `schema.prisma:L6218`
- `NotificationTemplate` → `schema.prisma:L6245`
- `OAuthState` → `schema.prisma:L1220`
- `OnboardingProgress` → `schema.prisma:L1238`
- `Order` → `schema.prisma:L2651`
- `OrderAction` → `schema.prisma:L3007`
- `OrderCustomer` → `schema.prisma:L2787`
- `OrderDiscount` → `schema.prisma:L6032`
- `OrderItem` → `schema.prisma:L2803`
- `OrderItemModifier` → `schema.prisma:L2991`
- `OrderServiceCharge` → `schema.prisma:L6116`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L9229`
- `OrganizationGoal` → `schema.prisma:L9187`
- `OrganizationModule` → `schema.prisma:L8231`
- `OrganizationPaymentConfig` → `schema.prisma:L4510`
- `OrganizationPayoutConfig` → `schema.prisma:L9262`
- `OrganizationPricingStructure` → `schema.prisma:L4542`
- `OrganizationSalesGoalConfig` → `schema.prisma:L9210`
- `OtpChallenge` → `schema.prisma:L5562`
- `PartnerAPIKey` → `schema.prisma:L4340`
- `Payment` → `schema.prisma:L3040`
- `PaymentAllocation` → `schema.prisma:L3179`
- `PaymentLink` → `schema.prisma:L10764`
- `PaymentLinkAttribution` → `schema.prisma:L10872`
- `PaymentLinkItem` → `schema.prisma:L10827`
- `PaymentLinkItemModifier` → `schema.prisma:L10854`
- `PaymentProvider` → `schema.prisma:L3895`
- `PayrollLine` → `schema.prisma:L12392`
- `PayrollRun` → `schema.prisma:L12361`
- `PerformanceGoal` → `schema.prisma:L9164`
- `PermissionSet` → `schema.prisma:L1120`
- `PlatformCfdi` → `schema.prisma:L12673`
- `PlatformEmisor` → `schema.prisma:L12617`
- `PlatformSettings` → `schema.prisma:L4317`
- `PosCommand` → `schema.prisma:L6299`
- `PosConnectionStatus` → `schema.prisma:L767`
- `PosSyncIntent` → `schema.prisma:L12751`
- `PricingPolicy` → `schema.prisma:L1944`
- `Printer` → `schema.prisma:L11275`
- `PrintGateway` → `schema.prisma:L11312`
- `PrintJob` → `schema.prisma:L11359`
- `PrintStation` → `schema.prisma:L11330`
- `ProcessedStripeEvent` → `schema.prisma:L4790`
- `ProcessorReliabilityMetric` → `schema.prisma:L5275`
- `Product` → `schema.prisma:L1408`
- `ProductModifierGroup` → `schema.prisma:L2979`
- `ProductOption` → `schema.prisma:L11046`
- `ProductOptionValue` → `schema.prisma:L11057`
- `ProductStaff` → `schema.prisma:L10020`
- `PromoterBankAccount` → `schema.prisma:L12512`
- `PromoterCommissionEntry` → `schema.prisma:L12531`
- `PromoterLocationPing` → `schema.prisma:L2617`
- `ProviderCostStructure` → `schema.prisma:L4826`
- `ProviderEventLog` → `schema.prisma:L4619`
- `PurchaseOrder` → `schema.prisma:L1858`
- `PurchaseOrderItem` → `schema.prisma:L1915`
- `RateCorrectionBatch` → `schema.prisma:L5051`
- `RateCorrectionEntry` → `schema.prisma:L5093`
- `RawMaterial` → `schema.prisma:L1644`
- `RawMaterialMovement` → `schema.prisma:L1997`
- `Recipe` → `schema.prisma:L1712`
- `RecipeLine` → `schema.prisma:L1736`
- `Referral` → `schema.prisma:L5697`
- `ReferralProgramConfig` → `schema.prisma:L5662`
- `ReferralRewardGrant` → `schema.prisma:L5788`
- `ReferralTierReward` → `schema.prisma:L5760`
- `ReferralTierUnlock` → `schema.prisma:L5833`
- `Reservation` → `schema.prisma:L9807`
- `ReservationGoogleEventMapping` → `schema.prisma:L10544`
- `ReservationModifier` → `schema.prisma:L9968`
- `ReservationReminderSent` → `schema.prisma:L9951`
- `ReservationSettings` → `schema.prisma:L10182`
- `ReservationWaitlistEntry` → `schema.prisma:L10150`
- `Review` → `schema.prisma:L3474`
- `SalesRetention` → `schema.prisma:L12212`
- `SaleVerification` → `schema.prisma:L3233`
- `ScheduledCommand` → `schema.prisma:L7679`
- `SerializedItem` → `schema.prisma:L8302`
- `SerializedItemCustodyEvent` → `schema.prisma:L8465`
- `ServiceCharge` → `schema.prisma:L6087`
- `SettlementConfiguration` → `schema.prisma:L5126`
- `SettlementConfirmation` → `schema.prisma:L5239`
- `SettlementIncident` → `schema.prisma:L5190`
- `SettlementSimulation` → `schema.prisma:L5161`
- `Shift` → `schema.prisma:L2465`
- `SimRegistrationRequest` → `schema.prisma:L8503`
- `SimRegistrationRequestItem` → `schema.prisma:L8525`
- `SlotHold` → `schema.prisma:L10051`
- `Staff` → `schema.prisma:L787`
- `StaffOnboardingState` → `schema.prisma:L11427`
- `StaffOrganization` → `schema.prisma:L1034`
- `StaffPasskey` → `schema.prisma:L1061`
- `StaffSchedule` → `schema.prisma:L9991`
- `StaffScheduleException` → `schema.prisma:L10003`
- `StaffVenue` → `schema.prisma:L964`
- `StockAlertConfig` → `schema.prisma:L9146`
- `StockBatch` → `schema.prisma:L2128`
- `StockCount` → `schema.prisma:L2065`
- `StockCountItem` → `schema.prisma:L2086`
- `StripeWebhookEvent` → `schema.prisma:L4773`
- `Supplier` → `schema.prisma:L1771`
- `SupplierPricing` → `schema.prisma:L1824`
- `Table` → `schema.prisma:L2377`
- `Terminal` → `schema.prisma:L3525`
- `TerminalHealth` → `schema.prisma:L3671`
- `TerminalLog` → `schema.prisma:L3645`
- `TerminalOrder` → `schema.prisma:L3798`
- `TerminalOrderItem` → `schema.prisma:L3873`
- `TerminalPaymentRequest` → `schema.prisma:L3742`
- `TimeEntry` → `schema.prisma:L2530`
- `TimeEntryBreak` → `schema.prisma:L2599`
- `TokenPurchase` → `schema.prisma:L7353`
- `TokenUsageRecord` → `schema.prisma:L7325`
- `TpvCommandHistory` → `schema.prisma:L7585`
- `TpvCommandQueue` → `schema.prisma:L7525`
- `TpvFeedback` → `schema.prisma:L7238`
- `TpvMessage` → `schema.prisma:L9503`
- `TpvMessageDelivery` → `schema.prisma:L9555`
- `TpvMessageResponse` → `schema.prisma:L9578`
- `TrainingModule` → `schema.prisma:L9633`
- `TrainingProgress` → `schema.prisma:L9710`
- `TrainingQuizQuestion` → `schema.prisma:L9692`
- `TrainingStep` → `schema.prisma:L9672`
- `TransactionCost` → `schema.prisma:L4989`
- `UnitConversion` → `schema.prisma:L1975`
- `user_sessions` → `schema.prisma:L4375`
- `Venue` → `schema.prisma:L116`
- `VenueChatMessage` → `schema.prisma:L651`
- `VenueChatSession` → `schema.prisma:L606`
- `VenueCommission` → `schema.prisma:L11207`
- `VenueCreditAssessment` → `schema.prisma:L8047`
- `VenueCryptoConfig` → `schema.prisma:L9370`
- `VenueFeature` → `schema.prisma:L3347`
- `VenueModule` → `schema.prisma:L8203`
- `VenuePaymentConfig` → `schema.prisma:L4476`
- `VenuePaymentLinkSettings` → `schema.prisma:L10577`
- `VenuePricingStructure` → `schema.prisma:L4929`
- `VenueRoleConfig` → `schema.prisma:L1149`
- `VenueRolePermission` → `schema.prisma:L1091`
- `VenueSettings` → `schema.prisma:L691`
- `VenueTransaction` → `schema.prisma:L3284`
- `VenueWhatsappActivation` → `schema.prisma:L542`
- `WebhookEvent` → `schema.prisma:L3383`
- `WebhookSubscription` → `schema.prisma:L4592`
- `WhatsappContactWindow` → `schema.prisma:L560`
- `WhatsappInboundEvent` → `schema.prisma:L580`
- `Zone` → `schema.prisma:L99`
