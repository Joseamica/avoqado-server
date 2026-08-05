# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **294 models / 276 enums / ~13,700 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 21 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `PermissionSet`, `PromoterLocationPing`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                                          |
| 7   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 8   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 9   | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 10  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                           |
| 11  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 12  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                           |
| 13  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 14  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`                                                                                                                                                                                                                                                                                                    |
| 15  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                        |
| 16  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                       |
| 17  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                   |
| 18  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 19  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 20  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 21  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L13073`
- `AccountMapping` → `schema.prisma:L12969`
- `ActivityLog` → `schema.prisma:L5672`
- `Aggregator` → `schema.prisma:L11600`
- `AngelPayUserAccount` → `schema.prisma:L4381`
- `AppUpdate` → `schema.prisma:L9829`
- `Area` → `schema.prisma:L2442`
- `AreaTicket` → `schema.prisma:L12019`
- `AreaTicketCheckoutSession` → `schema.prisma:L12127`
- `AreaTicketFulfillment` → `schema.prisma:L12203`
- `AreaTicketInventoryReservation` → `schema.prisma:L12102`
- `AreaTicketLine` → `schema.prisma:L12070`
- `AreaTicketPaymentAttempt` → `schema.prisma:L12159`
- `AreaTicketPrintAttempt` → `schema.prisma:L12182`
- `BankStatement` → `schema.prisma:L12843`
- `BankStatementLine` → `schema.prisma:L12864`
- `BillingTaxProfile` → `schema.prisma:L13653`
- `BulkCommandOperation` → `schema.prisma:L8150`
- `CalendarSyncOutbox` → `schema.prisma:L11003`
- `CampaignDelivery` → `schema.prisma:L9987`
- `CashCloseout` → `schema.prisma:L8515`
- `CashDeposit` → `schema.prisma:L9631`
- `CashDrawerEvent` → `schema.prisma:L11446`
- `CashDrawerSession` → `schema.prisma:L11422`
- `CashOutCommissionRate` → `schema.prisma:L13482`
- `CashOutScheduleDay` → `schema.prisma:L13505`
- `CashOutWithdrawal` → `schema.prisma:L13567`
- `Cfdi` → `schema.prisma:L12746`
- `ChatbotTokenBudget` → `schema.prisma:L7798`
- `ChatConversation` → `schema.prisma:L7653`
- `ChatFeedback` → `schema.prisma:L7739`
- `ChatLearningEvent` → `schema.prisma:L7696`
- `ChatMessage` → `schema.prisma:L7676`
- `ChatTrainingData` → `schema.prisma:L7610`
- `CheckoutSession` → `schema.prisma:L4661`
- `ClassSession` → `schema.prisma:L10621`
- `CommissionCalculation` → `schema.prisma:L9410`
- `CommissionClawback` → `schema.prisma:L9583`
- `CommissionConfig` → `schema.prisma:L9183`
- `CommissionMilestone` → `schema.prisma:L9326`
- `CommissionOverride` → `schema.prisma:L9253`
- `CommissionPayout` → `schema.prisma:L9534`
- `CommissionSummary` → `schema.prisma:L9473`
- `CommissionTier` → `schema.prisma:L9290`
- `Consumer` → `schema.prisma:L5793`
- `ConsumerAuthAccount` → `schema.prisma:L5818`
- `CouponCode` → `schema.prisma:L6421`
- `CouponRedemption` → `schema.prisma:L6452`
- `CreditAssessmentHistory` → `schema.prisma:L8624`
- `CreditItemBalance` → `schema.prisma:L11212`
- `CreditOffer` → `schema.prisma:L8643`
- `CreditPack` → `schema.prisma:L11128`
- `CreditPackItem` → `schema.prisma:L11157`
- `CreditPackPurchase` → `schema.prisma:L11174`
- `CreditTransaction` → `schema.prisma:L11234`
- `Customer` → `schema.prisma:L5698`
- `CustomerDiscount` → `schema.prisma:L6472`
- `CustomerGroup` → `schema.prisma:L5852`
- `CustomerTaxProfile` → `schema.prisma:L12815`
- `DeliveryActivationRequest` → `schema.prisma:L4983`
- `DeliveryChannelLink` → `schema.prisma:L4947`
- `DeliveryOrderEvent` → `schema.prisma:L5007`
- `DeviceToken` → `schema.prisma:L6741`
- `DigitalReceipt` → `schema.prisma:L3389`
- `Discount` → `schema.prisma:L6124`
- `EcommerceMerchant` → `schema.prisma:L4473`
- `EmailTemplate` → `schema.prisma:L9926`
- `Employee` → `schema.prisma:L13330`
- `Estimate` → `schema.prisma:L11507`
- `EstimateItem` → `schema.prisma:L11535`
- `Expense` → `schema.prisma:L13117`
- `ExternalBusyBlock` → `schema.prisma:L10896`
- `Feature` → `schema.prisma:L3518`
- `FeeSchedule` → `schema.prisma:L3596`
- `FeeTier` → `schema.prisma:L3607`
- `FinancialAccount` → `schema.prisma:L11697`
- `FinancialConnection` → `schema.prisma:L11666`
- `FinancialProvider` → `schema.prisma:L11652`
- `FiscalEmisor` → `schema.prisma:L12669`
- `FiscalLossCarryforward` → `schema.prisma:L13240`
- `FixedAsset` → `schema.prisma:L13258`
- `FixedAssetDepreciation` → `schema.prisma:L13287`
- `FloorElement` → `schema.prisma:L2518`
- `FulfillmentArea` → `schema.prisma:L11892`
- `GeofenceRule` → `schema.prisma:L8235`
- `GoogleCalendarChannel` → `schema.prisma:L10873`
- `GoogleCalendarConnection` → `schema.prisma:L10825`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L10926`
- `GoogleOAuthSession` → `schema.prisma:L10948`
- `HolidayCalendar` → `schema.prisma:L5596`
- `IdempotencyRequest` → `schema.prisma:L9058`
- `InterVenueTransfer` → `schema.prisma:L2270`
- `InterVenueTransferAllocation` → `schema.prisma:L2353`
- `InterVenueTransferItem` → `schema.prisma:L2322`
- `InterVenueTransferReceipt` → `schema.prisma:L2380`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2396`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2424`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2408`
- `Inventory` → `schema.prisma:L1643`
- `InventoryMovement` → `schema.prisma:L1670`
- `InventoryTransfer` → `schema.prisma:L11479`
- `Invitation` → `schema.prisma:L1210`
- `Invoice` → `schema.prisma:L3619`
- `InvoiceItem` → `schema.prisma:L3645`
- `ItemCategory` → `schema.prisma:L8775`
- `JournalEntry` → `schema.prisma:L13027`
- `JournalLine` → `schema.prisma:L13055`
- `KdsOrder` → `schema.prisma:L11745`
- `KdsOrderItem` → `schema.prisma:L11762`
- `LearnedPatterns` → `schema.prisma:L7720`
- `LedgerAccount` → `schema.prisma:L12919`
- `LiveDemoSession` → `schema.prisma:L703`
- `LowStockAlert` → `schema.prisma:L2124`
- `LoyaltyConfig` → `schema.prisma:L5882`
- `LoyaltyTransaction` → `schema.prisma:L5905`
- `MarketingCampaign` → `schema.prisma:L9944`
- `McpAuthCode` → `schema.prisma:L12552`
- `McpOAuthClient` → `schema.prisma:L12536`
- `McpRefreshToken` → `schema.prisma:L12570`
- `McpToolCall` → `schema.prisma:L12591`
- `MeasurementUnit` → `schema.prisma:L11585`
- `Menu` → `schema.prisma:L1396`
- `MenuCategory` → `schema.prisma:L1333`
- `MenuCategoryAssignment` → `schema.prisma:L1431`
- `MercadoPagoWebhookEvent` → `schema.prisma:L12466`
- `MerchantAccount` → `schema.prisma:L4211`
- `MerchantFiscalConfig` → `schema.prisma:L12717`
- `MerchantRevenueShare` → `schema.prisma:L5176`
- `MerchantRoutingRule` → `schema.prisma:L4333`
- `MilestoneAchievement` → `schema.prisma:L9371`
- `Modifier` → `schema.prisma:L3118`
- `ModifierGroup` → `schema.prisma:L3082`
- `Module` → `schema.prisma:L8691`
- `MoneyAnomaly` → `schema.prisma:L5079`
- `MonthlyVenueProfit` → `schema.prisma:L5622`
- `Notification` → `schema.prisma:L6643`
- `NotificationPreference` → `schema.prisma:L6690`
- `NotificationTemplate` → `schema.prisma:L6717`
- `OAuthState` → `schema.prisma:L1261`
- `OnboardingProgress` → `schema.prisma:L1279`
- `Order` → `schema.prisma:L2742`
- `OrderAction` → `schema.prisma:L3183`
- `OrderCustomer` → `schema.prisma:L2939`
- `OrderDiscount` → `schema.prisma:L6504`
- `OrderFulfillment` → `schema.prisma:L11939`
- `OrderFulfillmentLine` → `schema.prisma:L11970`
- `OrderItem` → `schema.prisma:L2955`
- `OrderItemModifier` → `schema.prisma:L3167`
- `OrderServiceCharge` → `schema.prisma:L6588`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L9745`
- `OrganizationGoal` → `schema.prisma:L9703`
- `OrganizationModule` → `schema.prisma:L8747`
- `OrganizationPaymentConfig` → `schema.prisma:L4785`
- `OrganizationPayoutConfig` → `schema.prisma:L9778`
- `OrganizationPricingStructure` → `schema.prisma:L4817`
- `OrganizationSalesGoalConfig` → `schema.prisma:L9726`
- `OtpChallenge` → `schema.prisma:L5837`
- `PartnerAPIKey` → `schema.prisma:L4615`
- `Payment` → `schema.prisma:L3216`
- `PaymentAllocation` → `schema.prisma:L3368`
- `PaymentLink` → `schema.prisma:L11280`
- `PaymentLinkAttribution` → `schema.prisma:L11388`
- `PaymentLinkItem` → `schema.prisma:L11343`
- `PaymentLinkItemModifier` → `schema.prisma:L11370`
- `PaymentProvider` → `schema.prisma:L4170`
- `PayrollLine` → `schema.prisma:L13401`
- `PayrollRun` → `schema.prisma:L13370`
- `PerformanceGoal` → `schema.prisma:L9680`
- `PermissionSet` → `schema.prisma:L1161`
- `PlatformCfdi` → `schema.prisma:L13682`
- `PlatformEmisor` → `schema.prisma:L13626`
- `PlatformSettings` → `schema.prisma:L4592`
- `PosCommand` → `schema.prisma:L6771`
- `PosConnectionStatus` → `schema.prisma:L795`
- `PosSyncIntent` → `schema.prisma:L13760`
- `PricingPolicy` → `schema.prisma:L2035`
- `Printer` → `schema.prisma:L11791`
- `PrintGateway` → `schema.prisma:L11828`
- `PrintJob` → `schema.prisma:L12365`
- `PrintStation` → `schema.prisma:L11846`
- `ProcessedStripeEvent` → `schema.prisma:L5065`
- `ProcessorReliabilityMetric` → `schema.prisma:L5550`
- `Product` → `schema.prisma:L1449`
- `ProductModifierGroup` → `schema.prisma:L3155`
- `ProductOption` → `schema.prisma:L11562`
- `ProductOptionValue` → `schema.prisma:L11573`
- `ProductStaff` → `schema.prisma:L10536`
- `PromoterBankAccount` → `schema.prisma:L13521`
- `PromoterCommissionEntry` → `schema.prisma:L13540`
- `PromoterLocationPing` → `schema.prisma:L2708`
- `ProviderCostStructure` → `schema.prisma:L5101`
- `ProviderEventLog` → `schema.prisma:L4894`
- `PurchaseOrder` → `schema.prisma:L1942`
- `PurchaseOrderItem` → `schema.prisma:L1999`
- `RateCorrectionBatch` → `schema.prisma:L5326`
- `RateCorrectionEntry` → `schema.prisma:L5368`
- `RawMaterial` → `schema.prisma:L1703`
- `RawMaterialMovement` → `schema.prisma:L2088`
- `RawMaterialPresentation` → `schema.prisma:L1776`
- `Recipe` → `schema.prisma:L1796`
- `RecipeLine` → `schema.prisma:L1820`
- `Referral` → `schema.prisma:L5972`
- `ReferralProgramConfig` → `schema.prisma:L5937`
- `ReferralRewardGrant` → `schema.prisma:L6063`
- `ReferralTierReward` → `schema.prisma:L6035`
- `ReferralTierUnlock` → `schema.prisma:L6108`
- `Reservation` → `schema.prisma:L10323`
- `ReservationGoogleEventMapping` → `schema.prisma:L11060`
- `ReservationModifier` → `schema.prisma:L10484`
- `ReservationReminderSent` → `schema.prisma:L10467`
- `ReservationSettings` → `schema.prisma:L10698`
- `ReservationWaitlistEntry` → `schema.prisma:L10666`
- `Review` → `schema.prisma:L3663`
- `SalesRetention` → `schema.prisma:L13221`
- `SaleVerification` → `schema.prisma:L3422`
- `ScaleProfile` → `schema.prisma:L12236`
- `ScheduledCommand` → `schema.prisma:L8195`
- `SerializedItem` → `schema.prisma:L8818`
- `SerializedItemCustodyEvent` → `schema.prisma:L8981`
- `ServiceCharge` → `schema.prisma:L6559`
- `SettlementConfiguration` → `schema.prisma:L5401`
- `SettlementConfirmation` → `schema.prisma:L5514`
- `SettlementIncident` → `schema.prisma:L5465`
- `SettlementSimulation` → `schema.prisma:L5436`
- `Shift` → `schema.prisma:L2556`
- `SimRegistrationRequest` → `schema.prisma:L9019`
- `SimRegistrationRequestItem` → `schema.prisma:L9041`
- `SlotHold` → `schema.prisma:L10567`
- `Staff` → `schema.prisma:L815`
- `StaffOnboardingState` → `schema.prisma:L12436`
- `StaffOrganization` → `schema.prisma:L1075`
- `StaffPasskey` → `schema.prisma:L1102`
- `StaffSchedule` → `schema.prisma:L10507`
- `StaffScheduleException` → `schema.prisma:L10519`
- `StaffVenue` → `schema.prisma:L1004`
- `StockAlertConfig` → `schema.prisma:L9662`
- `StockBatch` → `schema.prisma:L2219`
- `StockCount` → `schema.prisma:L2156`
- `StockCountItem` → `schema.prisma:L2177`
- `StripeWebhookEvent` → `schema.prisma:L5048`
- `Supplier` → `schema.prisma:L1855`
- `SupplierPricing` → `schema.prisma:L1908`
- `Table` → `schema.prisma:L2468`
- `Terminal` → `schema.prisma:L3714`
- `TerminalHealth` → `schema.prisma:L3946`
- `TerminalLog` → `schema.prisma:L3920`
- `TerminalOrder` → `schema.prisma:L4073`
- `TerminalOrderItem` → `schema.prisma:L4148`
- `TerminalPaymentRequest` → `schema.prisma:L4017`
- `TimeEntry` → `schema.prisma:L2621`
- `TimeEntryBreak` → `schema.prisma:L2690`
- `TokenPurchase` → `schema.prisma:L7869`
- `TokenUsageRecord` → `schema.prisma:L7841`
- `TpvCommandHistory` → `schema.prisma:L8101`
- `TpvCommandQueue` → `schema.prisma:L8041`
- `TpvFeedback` → `schema.prisma:L7754`
- `TpvMessage` → `schema.prisma:L10019`
- `TpvMessageDelivery` → `schema.prisma:L10071`
- `TpvMessageResponse` → `schema.prisma:L10094`
- `TrainingModule` → `schema.prisma:L10149`
- `TrainingProgress` → `schema.prisma:L10226`
- `TrainingQuizQuestion` → `schema.prisma:L10208`
- `TrainingStep` → `schema.prisma:L10188`
- `TransactionCost` → `schema.prisma:L5264`
- `UnitConversion` → `schema.prisma:L2066`
- `UpsellAcceptance` → `schema.prisma:L6380`
- `UpsellAiRun` → `schema.prisma:L6400`
- `UpsellImpression` → `schema.prisma:L6340`
- `UpsellRule` → `schema.prisma:L6270`
- `user_sessions` → `schema.prisma:L4650`
- `Venue` → `schema.prisma:L116`
- `VenueAreaTicketSettings` → `schema.prisma:L11998`
- `VenueChatMessage` → `schema.prisma:L679`
- `VenueChatSession` → `schema.prisma:L634`
- `VenueCommission` → `schema.prisma:L11723`
- `VenueCreditAssessment` → `schema.prisma:L8563`
- `VenueCryptoConfig` → `schema.prisma:L9886`
- `VenueFeature` → `schema.prisma:L3536`
- `VenueModule` → `schema.prisma:L8719`
- `VenuePaymentConfig` → `schema.prisma:L4751`
- `VenuePaymentLinkSettings` → `schema.prisma:L11093`
- `VenuePricingStructure` → `schema.prisma:L5204`
- `VenueRoleConfig` → `schema.prisma:L1190`
- `VenueRolePermission` → `schema.prisma:L1132`
- `VenueScaleSettings` → `schema.prisma:L12226`
- `VenueSettings` → `schema.prisma:L719`
- `VenueTransaction` → `schema.prisma:L3473`
- `VenueWhatsappActivation` → `schema.prisma:L570`
- `WebhookEvent` → `schema.prisma:L3572`
- `WebhookSubscription` → `schema.prisma:L4867`
- `WhatsappContactWindow` → `schema.prisma:L588`
- `WhatsappInboundEvent` → `schema.prisma:L608`
- `Zone` → `schema.prisma:L99`
