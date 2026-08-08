# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **294 models / 276 enums / ~13,800 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L13133`
- `AccountMapping` → `schema.prisma:L13029`
- `ActivityLog` → `schema.prisma:L5726`
- `Aggregator` → `schema.prisma:L11654`
- `AngelPayUserAccount` → `schema.prisma:L4435`
- `AppUpdate` → `schema.prisma:L9883`
- `Area` → `schema.prisma:L2496`
- `AreaTicket` → `schema.prisma:L12073`
- `AreaTicketCheckoutSession` → `schema.prisma:L12185`
- `AreaTicketFulfillment` → `schema.prisma:L12261`
- `AreaTicketInventoryReservation` → `schema.prisma:L12160`
- `AreaTicketLine` → `schema.prisma:L12128`
- `AreaTicketPaymentAttempt` → `schema.prisma:L12217`
- `AreaTicketPrintAttempt` → `schema.prisma:L12240`
- `BankStatement` → `schema.prisma:L12903`
- `BankStatementLine` → `schema.prisma:L12924`
- `BillingTaxProfile` → `schema.prisma:L13713`
- `BulkCommandOperation` → `schema.prisma:L8204`
- `CalendarSyncOutbox` → `schema.prisma:L11057`
- `CampaignDelivery` → `schema.prisma:L10041`
- `CashCloseout` → `schema.prisma:L8569`
- `CashDeposit` → `schema.prisma:L9685`
- `CashDrawerEvent` → `schema.prisma:L11500`
- `CashDrawerSession` → `schema.prisma:L11476`
- `CashOutCommissionRate` → `schema.prisma:L13542`
- `CashOutScheduleDay` → `schema.prisma:L13565`
- `CashOutWithdrawal` → `schema.prisma:L13627`
- `Cfdi` → `schema.prisma:L12806`
- `ChatbotTokenBudget` → `schema.prisma:L7852`
- `ChatConversation` → `schema.prisma:L7707`
- `ChatFeedback` → `schema.prisma:L7793`
- `ChatLearningEvent` → `schema.prisma:L7750`
- `ChatMessage` → `schema.prisma:L7730`
- `ChatTrainingData` → `schema.prisma:L7664`
- `CheckoutSession` → `schema.prisma:L4715`
- `ClassSession` → `schema.prisma:L10675`
- `CommissionCalculation` → `schema.prisma:L9464`
- `CommissionClawback` → `schema.prisma:L9637`
- `CommissionConfig` → `schema.prisma:L9237`
- `CommissionMilestone` → `schema.prisma:L9380`
- `CommissionOverride` → `schema.prisma:L9307`
- `CommissionPayout` → `schema.prisma:L9588`
- `CommissionSummary` → `schema.prisma:L9527`
- `CommissionTier` → `schema.prisma:L9344`
- `Consumer` → `schema.prisma:L5847`
- `ConsumerAuthAccount` → `schema.prisma:L5872`
- `CouponCode` → `schema.prisma:L6475`
- `CouponRedemption` → `schema.prisma:L6506`
- `CreditAssessmentHistory` → `schema.prisma:L8678`
- `CreditItemBalance` → `schema.prisma:L11266`
- `CreditOffer` → `schema.prisma:L8697`
- `CreditPack` → `schema.prisma:L11182`
- `CreditPackItem` → `schema.prisma:L11211`
- `CreditPackPurchase` → `schema.prisma:L11228`
- `CreditTransaction` → `schema.prisma:L11288`
- `Customer` → `schema.prisma:L5752`
- `CustomerDiscount` → `schema.prisma:L6526`
- `CustomerGroup` → `schema.prisma:L5906`
- `CustomerTaxProfile` → `schema.prisma:L12875`
- `DeliveryActivationRequest` → `schema.prisma:L5037`
- `DeliveryChannelLink` → `schema.prisma:L5001`
- `DeliveryOrderEvent` → `schema.prisma:L5061`
- `DeviceToken` → `schema.prisma:L6795`
- `DigitalReceipt` → `schema.prisma:L3443`
- `Discount` → `schema.prisma:L6178`
- `EcommerceMerchant` → `schema.prisma:L4527`
- `EmailTemplate` → `schema.prisma:L9980`
- `Employee` → `schema.prisma:L13390`
- `Estimate` → `schema.prisma:L11561`
- `EstimateItem` → `schema.prisma:L11589`
- `Expense` → `schema.prisma:L13177`
- `ExternalBusyBlock` → `schema.prisma:L10950`
- `Feature` → `schema.prisma:L3572`
- `FeeSchedule` → `schema.prisma:L3650`
- `FeeTier` → `schema.prisma:L3661`
- `FinancialAccount` → `schema.prisma:L11751`
- `FinancialConnection` → `schema.prisma:L11720`
- `FinancialProvider` → `schema.prisma:L11706`
- `FiscalEmisor` → `schema.prisma:L12729`
- `FiscalLossCarryforward` → `schema.prisma:L13300`
- `FixedAsset` → `schema.prisma:L13318`
- `FixedAssetDepreciation` → `schema.prisma:L13347`
- `FloorElement` → `schema.prisma:L2572`
- `FulfillmentArea` → `schema.prisma:L11946`
- `GeofenceRule` → `schema.prisma:L8289`
- `GoogleCalendarChannel` → `schema.prisma:L10927`
- `GoogleCalendarConnection` → `schema.prisma:L10879`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L10980`
- `GoogleOAuthSession` → `schema.prisma:L11002`
- `HolidayCalendar` → `schema.prisma:L5650`
- `IdempotencyRequest` → `schema.prisma:L9112`
- `InterVenueTransfer` → `schema.prisma:L2324`
- `InterVenueTransferAllocation` → `schema.prisma:L2407`
- `InterVenueTransferItem` → `schema.prisma:L2376`
- `InterVenueTransferReceipt` → `schema.prisma:L2434`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2450`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2478`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2462`
- `Inventory` → `schema.prisma:L1647`
- `InventoryMovement` → `schema.prisma:L1674`
- `InventoryTransfer` → `schema.prisma:L11533`
- `Invitation` → `schema.prisma:L1211`
- `Invoice` → `schema.prisma:L3673`
- `InvoiceItem` → `schema.prisma:L3699`
- `ItemCategory` → `schema.prisma:L8829`
- `JournalEntry` → `schema.prisma:L13087`
- `JournalLine` → `schema.prisma:L13115`
- `KdsOrder` → `schema.prisma:L11799`
- `KdsOrderItem` → `schema.prisma:L11816`
- `LearnedPatterns` → `schema.prisma:L7774`
- `LedgerAccount` → `schema.prisma:L12979`
- `LiveDemoSession` → `schema.prisma:L703`
- `LowStockAlert` → `schema.prisma:L2178`
- `LoyaltyConfig` → `schema.prisma:L5936`
- `LoyaltyTransaction` → `schema.prisma:L5959`
- `MarketingCampaign` → `schema.prisma:L9998`
- `McpAuthCode` → `schema.prisma:L12612`
- `McpOAuthClient` → `schema.prisma:L12596`
- `McpRefreshToken` → `schema.prisma:L12630`
- `McpToolCall` → `schema.prisma:L12651`
- `MeasurementUnit` → `schema.prisma:L11639`
- `Menu` → `schema.prisma:L1397`
- `MenuCategory` → `schema.prisma:L1334`
- `MenuCategoryAssignment` → `schema.prisma:L1432`
- `MercadoPagoWebhookEvent` → `schema.prisma:L12526`
- `MerchantAccount` → `schema.prisma:L4265`
- `MerchantFiscalConfig` → `schema.prisma:L12777`
- `MerchantRevenueShare` → `schema.prisma:L5230`
- `MerchantRoutingRule` → `schema.prisma:L4387`
- `MilestoneAchievement` → `schema.prisma:L9425`
- `Modifier` → `schema.prisma:L3172`
- `ModifierGroup` → `schema.prisma:L3136`
- `Module` → `schema.prisma:L8745`
- `MoneyAnomaly` → `schema.prisma:L5133`
- `MonthlyVenueProfit` → `schema.prisma:L5676`
- `Notification` → `schema.prisma:L6697`
- `NotificationPreference` → `schema.prisma:L6744`
- `NotificationTemplate` → `schema.prisma:L6771`
- `OAuthState` → `schema.prisma:L1262`
- `OnboardingProgress` → `schema.prisma:L1280`
- `Order` → `schema.prisma:L2796`
- `OrderAction` → `schema.prisma:L3237`
- `OrderCustomer` → `schema.prisma:L2993`
- `OrderDiscount` → `schema.prisma:L6558`
- `OrderFulfillment` → `schema.prisma:L11993`
- `OrderFulfillmentLine` → `schema.prisma:L12024`
- `OrderItem` → `schema.prisma:L3009`
- `OrderItemModifier` → `schema.prisma:L3221`
- `OrderServiceCharge` → `schema.prisma:L6642`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L9799`
- `OrganizationGoal` → `schema.prisma:L9757`
- `OrganizationModule` → `schema.prisma:L8801`
- `OrganizationPaymentConfig` → `schema.prisma:L4839`
- `OrganizationPayoutConfig` → `schema.prisma:L9832`
- `OrganizationPricingStructure` → `schema.prisma:L4871`
- `OrganizationSalesGoalConfig` → `schema.prisma:L9780`
- `OtpChallenge` → `schema.prisma:L5891`
- `PartnerAPIKey` → `schema.prisma:L4669`
- `Payment` → `schema.prisma:L3270`
- `PaymentAllocation` → `schema.prisma:L3422`
- `PaymentLink` → `schema.prisma:L11334`
- `PaymentLinkAttribution` → `schema.prisma:L11442`
- `PaymentLinkItem` → `schema.prisma:L11397`
- `PaymentLinkItemModifier` → `schema.prisma:L11424`
- `PaymentProvider` → `schema.prisma:L4224`
- `PayrollLine` → `schema.prisma:L13461`
- `PayrollRun` → `schema.prisma:L13430`
- `PerformanceGoal` → `schema.prisma:L9734`
- `PermissionSet` → `schema.prisma:L1162`
- `PlatformCfdi` → `schema.prisma:L13746`
- `PlatformEmisor` → `schema.prisma:L13686`
- `PlatformSettings` → `schema.prisma:L4646`
- `PosCommand` → `schema.prisma:L6825`
- `PosConnectionStatus` → `schema.prisma:L796`
- `PosSyncIntent` → `schema.prisma:L13824`
- `PricingPolicy` → `schema.prisma:L2089`
- `Printer` → `schema.prisma:L11845`
- `PrintGateway` → `schema.prisma:L11882`
- `PrintJob` → `schema.prisma:L12425`
- `PrintStation` → `schema.prisma:L11900`
- `ProcessedStripeEvent` → `schema.prisma:L5119`
- `ProcessorReliabilityMetric` → `schema.prisma:L5604`
- `Product` → `schema.prisma:L1450`
- `ProductModifierGroup` → `schema.prisma:L3209`
- `ProductOption` → `schema.prisma:L11616`
- `ProductOptionValue` → `schema.prisma:L11627`
- `ProductStaff` → `schema.prisma:L10590`
- `PromoterBankAccount` → `schema.prisma:L13581`
- `PromoterCommissionEntry` → `schema.prisma:L13600`
- `PromoterLocationPing` → `schema.prisma:L2762`
- `ProviderCostStructure` → `schema.prisma:L5155`
- `ProviderEventLog` → `schema.prisma:L4948`
- `PurchaseOrder` → `schema.prisma:L1957`
- `PurchaseOrderItem` → `schema.prisma:L2014`
- `RateCorrectionBatch` → `schema.prisma:L5380`
- `RateCorrectionEntry` → `schema.prisma:L5422`
- `RawMaterial` → `schema.prisma:L1718`
- `RawMaterialMovement` → `schema.prisma:L2142`
- `RawMaterialPresentation` → `schema.prisma:L1791`
- `Recipe` → `schema.prisma:L1811`
- `RecipeLine` → `schema.prisma:L1835`
- `Referral` → `schema.prisma:L6026`
- `ReferralProgramConfig` → `schema.prisma:L5991`
- `ReferralRewardGrant` → `schema.prisma:L6117`
- `ReferralTierReward` → `schema.prisma:L6089`
- `ReferralTierUnlock` → `schema.prisma:L6162`
- `Reservation` → `schema.prisma:L10377`
- `ReservationGoogleEventMapping` → `schema.prisma:L11114`
- `ReservationModifier` → `schema.prisma:L10538`
- `ReservationReminderSent` → `schema.prisma:L10521`
- `ReservationSettings` → `schema.prisma:L10752`
- `ReservationWaitlistEntry` → `schema.prisma:L10720`
- `Review` → `schema.prisma:L3717`
- `SalesRetention` → `schema.prisma:L13281`
- `SaleVerification` → `schema.prisma:L3476`
- `ScaleProfile` → `schema.prisma:L12296`
- `ScheduledCommand` → `schema.prisma:L8249`
- `SerializedItem` → `schema.prisma:L8872`
- `SerializedItemCustodyEvent` → `schema.prisma:L9035`
- `ServiceCharge` → `schema.prisma:L6613`
- `SettlementConfiguration` → `schema.prisma:L5455`
- `SettlementConfirmation` → `schema.prisma:L5568`
- `SettlementIncident` → `schema.prisma:L5519`
- `SettlementSimulation` → `schema.prisma:L5490`
- `Shift` → `schema.prisma:L2610`
- `SimRegistrationRequest` → `schema.prisma:L9073`
- `SimRegistrationRequestItem` → `schema.prisma:L9095`
- `SlotHold` → `schema.prisma:L10621`
- `Staff` → `schema.prisma:L816`
- `StaffOnboardingState` → `schema.prisma:L12496`
- `StaffOrganization` → `schema.prisma:L1076`
- `StaffPasskey` → `schema.prisma:L1103`
- `StaffSchedule` → `schema.prisma:L10561`
- `StaffScheduleException` → `schema.prisma:L10573`
- `StaffVenue` → `schema.prisma:L1005`
- `StockAlertConfig` → `schema.prisma:L9716`
- `StockBatch` → `schema.prisma:L2273`
- `StockCount` → `schema.prisma:L2210`
- `StockCountItem` → `schema.prisma:L2231`
- `StripeWebhookEvent` → `schema.prisma:L5102`
- `Supplier` → `schema.prisma:L1870`
- `SupplierPricing` → `schema.prisma:L1923`
- `Table` → `schema.prisma:L2522`
- `Terminal` → `schema.prisma:L3768`
- `TerminalHealth` → `schema.prisma:L4000`
- `TerminalLog` → `schema.prisma:L3974`
- `TerminalOrder` → `schema.prisma:L4127`
- `TerminalOrderItem` → `schema.prisma:L4202`
- `TerminalPaymentRequest` → `schema.prisma:L4071`
- `TimeEntry` → `schema.prisma:L2675`
- `TimeEntryBreak` → `schema.prisma:L2744`
- `TokenPurchase` → `schema.prisma:L7923`
- `TokenUsageRecord` → `schema.prisma:L7895`
- `TpvCommandHistory` → `schema.prisma:L8155`
- `TpvCommandQueue` → `schema.prisma:L8095`
- `TpvFeedback` → `schema.prisma:L7808`
- `TpvMessage` → `schema.prisma:L10073`
- `TpvMessageDelivery` → `schema.prisma:L10125`
- `TpvMessageResponse` → `schema.prisma:L10148`
- `TrainingModule` → `schema.prisma:L10203`
- `TrainingProgress` → `schema.prisma:L10280`
- `TrainingQuizQuestion` → `schema.prisma:L10262`
- `TrainingStep` → `schema.prisma:L10242`
- `TransactionCost` → `schema.prisma:L5318`
- `UnitConversion` → `schema.prisma:L2120`
- `UpsellAcceptance` → `schema.prisma:L6434`
- `UpsellAiRun` → `schema.prisma:L6454`
- `UpsellImpression` → `schema.prisma:L6394`
- `UpsellRule` → `schema.prisma:L6324`
- `user_sessions` → `schema.prisma:L4704`
- `Venue` → `schema.prisma:L116`
- `VenueAreaTicketSettings` → `schema.prisma:L12052`
- `VenueChatMessage` → `schema.prisma:L679`
- `VenueChatSession` → `schema.prisma:L634`
- `VenueCommission` → `schema.prisma:L11777`
- `VenueCreditAssessment` → `schema.prisma:L8617`
- `VenueCryptoConfig` → `schema.prisma:L9940`
- `VenueFeature` → `schema.prisma:L3590`
- `VenueModule` → `schema.prisma:L8773`
- `VenuePaymentConfig` → `schema.prisma:L4805`
- `VenuePaymentLinkSettings` → `schema.prisma:L11147`
- `VenuePricingStructure` → `schema.prisma:L5258`
- `VenueRoleConfig` → `schema.prisma:L1191`
- `VenueRolePermission` → `schema.prisma:L1133`
- `VenueScaleSettings` → `schema.prisma:L12284`
- `VenueSettings` → `schema.prisma:L719`
- `VenueTransaction` → `schema.prisma:L3527`
- `VenueWhatsappActivation` → `schema.prisma:L570`
- `WebhookEvent` → `schema.prisma:L3626`
- `WebhookSubscription` → `schema.prisma:L4921`
- `WhatsappContactWindow` → `schema.prisma:L588`
- `WhatsappInboundEvent` → `schema.prisma:L608`
- `Zone` → `schema.prisma:L99`
