# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **280 models / 254 enums / ~13,000 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
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
| 6   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                |
| 7   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`                                                                                                                |
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

- `AccountingPeriodLock` → `schema.prisma:L12387`
- `AccountMapping` → `schema.prisma:L12283`
- `ActivityLog` → `schema.prisma:L5573`
- `Aggregator` → `schema.prisma:L11284`
- `AngelPayUserAccount` → `schema.prisma:L4282`
- `AppUpdate` → `schema.prisma:L9513`
- `Area` → `schema.prisma:L2392`
- `BankStatement` → `schema.prisma:L12157`
- `BankStatementLine` → `schema.prisma:L12178`
- `BillingTaxProfile` → `schema.prisma:L12967`
- `BulkCommandOperation` → `schema.prisma:L7834`
- `CalendarSyncOutbox` → `schema.prisma:L10687`
- `CampaignDelivery` → `schema.prisma:L9671`
- `CashCloseout` → `schema.prisma:L8199`
- `CashDeposit` → `schema.prisma:L9315`
- `CashDrawerEvent` → `schema.prisma:L11130`
- `CashDrawerSession` → `schema.prisma:L11106`
- `CashOutCommissionRate` → `schema.prisma:L12796`
- `CashOutScheduleDay` → `schema.prisma:L12819`
- `CashOutWithdrawal` → `schema.prisma:L12881`
- `Cfdi` → `schema.prisma:L12060`
- `ChatbotTokenBudget` → `schema.prisma:L7482`
- `ChatConversation` → `schema.prisma:L7337`
- `ChatFeedback` → `schema.prisma:L7423`
- `ChatLearningEvent` → `schema.prisma:L7380`
- `ChatMessage` → `schema.prisma:L7360`
- `ChatTrainingData` → `schema.prisma:L7294`
- `CheckoutSession` → `schema.prisma:L4562`
- `ClassSession` → `schema.prisma:L10305`
- `CommissionCalculation` → `schema.prisma:L9094`
- `CommissionClawback` → `schema.prisma:L9267`
- `CommissionConfig` → `schema.prisma:L8867`
- `CommissionMilestone` → `schema.prisma:L9010`
- `CommissionOverride` → `schema.prisma:L8937`
- `CommissionPayout` → `schema.prisma:L9218`
- `CommissionSummary` → `schema.prisma:L9157`
- `CommissionTier` → `schema.prisma:L8974`
- `Consumer` → `schema.prisma:L5694`
- `ConsumerAuthAccount` → `schema.prisma:L5719`
- `CouponCode` → `schema.prisma:L6125`
- `CouponRedemption` → `schema.prisma:L6156`
- `CreditAssessmentHistory` → `schema.prisma:L8308`
- `CreditItemBalance` → `schema.prisma:L10896`
- `CreditOffer` → `schema.prisma:L8327`
- `CreditPack` → `schema.prisma:L10812`
- `CreditPackItem` → `schema.prisma:L10841`
- `CreditPackPurchase` → `schema.prisma:L10858`
- `CreditTransaction` → `schema.prisma:L10918`
- `Customer` → `schema.prisma:L5599`
- `CustomerDiscount` → `schema.prisma:L6176`
- `CustomerGroup` → `schema.prisma:L5753`
- `CustomerTaxProfile` → `schema.prisma:L12129`
- `DeliveryActivationRequest` → `schema.prisma:L4884`
- `DeliveryChannelLink` → `schema.prisma:L4848`
- `DeliveryOrderEvent` → `schema.prisma:L4908`
- `DeviceToken` → `schema.prisma:L6445`
- `DigitalReceipt` → `schema.prisma:L3305`
- `Discount` → `schema.prisma:L6025`
- `EcommerceMerchant` → `schema.prisma:L4374`
- `EmailTemplate` → `schema.prisma:L9610`
- `Employee` → `schema.prisma:L12644`
- `Estimate` → `schema.prisma:L11191`
- `EstimateItem` → `schema.prisma:L11219`
- `Expense` → `schema.prisma:L12431`
- `ExternalBusyBlock` → `schema.prisma:L10580`
- `Feature` → `schema.prisma:L3434`
- `FeeSchedule` → `schema.prisma:L3512`
- `FeeTier` → `schema.prisma:L3523`
- `FinancialAccount` → `schema.prisma:L11381`
- `FinancialConnection` → `schema.prisma:L11350`
- `FinancialProvider` → `schema.prisma:L11336`
- `FiscalEmisor` → `schema.prisma:L11983`
- `FiscalLossCarryforward` → `schema.prisma:L12554`
- `FixedAsset` → `schema.prisma:L12572`
- `FixedAssetDepreciation` → `schema.prisma:L12601`
- `FloorElement` → `schema.prisma:L2468`
- `FulfillmentArea` → `schema.prisma:L11576`
- `GeofenceRule` → `schema.prisma:L7919`
- `GoogleCalendarChannel` → `schema.prisma:L10557`
- `GoogleCalendarConnection` → `schema.prisma:L10509`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L10610`
- `GoogleOAuthSession` → `schema.prisma:L10632`
- `HolidayCalendar` → `schema.prisma:L5497`
- `IdempotencyRequest` → `schema.prisma:L8742`
- `InterVenueTransfer` → `schema.prisma:L2220`
- `InterVenueTransferAllocation` → `schema.prisma:L2303`
- `InterVenueTransferItem` → `schema.prisma:L2272`
- `InterVenueTransferReceipt` → `schema.prisma:L2330`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2346`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2374`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2358`
- `Inventory` → `schema.prisma:L1593`
- `InventoryMovement` → `schema.prisma:L1620`
- `InventoryTransfer` → `schema.prisma:L11163`
- `Invitation` → `schema.prisma:L1178`
- `Invoice` → `schema.prisma:L3535`
- `InvoiceItem` → `schema.prisma:L3561`
- `ItemCategory` → `schema.prisma:L8459`
- `JournalEntry` → `schema.prisma:L12341`
- `JournalLine` → `schema.prisma:L12369`
- `KdsOrder` → `schema.prisma:L11429`
- `KdsOrderItem` → `schema.prisma:L11446`
- `LearnedPatterns` → `schema.prisma:L7404`
- `LedgerAccount` → `schema.prisma:L12233`
- `LiveDemoSession` → `schema.prisma:L680`
- `LowStockAlert` → `schema.prisma:L2074`
- `LoyaltyConfig` → `schema.prisma:L5783`
- `LoyaltyTransaction` → `schema.prisma:L5806`
- `MarketingCampaign` → `schema.prisma:L9628`
- `McpAuthCode` → `schema.prisma:L11866`
- `McpOAuthClient` → `schema.prisma:L11850`
- `McpRefreshToken` → `schema.prisma:L11884`
- `McpToolCall` → `schema.prisma:L11905`
- `MeasurementUnit` → `schema.prisma:L11269`
- `Menu` → `schema.prisma:L1364`
- `MenuCategory` → `schema.prisma:L1301`
- `MenuCategoryAssignment` → `schema.prisma:L1399`
- `MercadoPagoWebhookEvent` → `schema.prisma:L11780`
- `MerchantAccount` → `schema.prisma:L4112`
- `MerchantFiscalConfig` → `schema.prisma:L12031`
- `MerchantRevenueShare` → `schema.prisma:L5077`
- `MerchantRoutingRule` → `schema.prisma:L4234`
- `MilestoneAchievement` → `schema.prisma:L9055`
- `Modifier` → `schema.prisma:L3047`
- `ModifierGroup` → `schema.prisma:L3011`
- `Module` → `schema.prisma:L8375`
- `MoneyAnomaly` → `schema.prisma:L4980`
- `MonthlyVenueProfit` → `schema.prisma:L5523`
- `Notification` → `schema.prisma:L6347`
- `NotificationPreference` → `schema.prisma:L6394`
- `NotificationTemplate` → `schema.prisma:L6421`
- `OAuthState` → `schema.prisma:L1229`
- `OnboardingProgress` → `schema.prisma:L1247`
- `Order` → `schema.prisma:L2692`
- `OrderAction` → `schema.prisma:L3112`
- `OrderCustomer` → `schema.prisma:L2872`
- `OrderDiscount` → `schema.prisma:L6208`
- `OrderFulfillment` → `schema.prisma:L11621`
- `OrderFulfillmentLine` → `schema.prisma:L11652`
- `OrderItem` → `schema.prisma:L2888`
- `OrderItemModifier` → `schema.prisma:L3096`
- `OrderServiceCharge` → `schema.prisma:L6292`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L9429`
- `OrganizationGoal` → `schema.prisma:L9387`
- `OrganizationModule` → `schema.prisma:L8431`
- `OrganizationPaymentConfig` → `schema.prisma:L4686`
- `OrganizationPayoutConfig` → `schema.prisma:L9462`
- `OrganizationPricingStructure` → `schema.prisma:L4718`
- `OrganizationSalesGoalConfig` → `schema.prisma:L9410`
- `OtpChallenge` → `schema.prisma:L5738`
- `PartnerAPIKey` → `schema.prisma:L4516`
- `Payment` → `schema.prisma:L3145`
- `PaymentAllocation` → `schema.prisma:L3284`
- `PaymentLink` → `schema.prisma:L10964`
- `PaymentLinkAttribution` → `schema.prisma:L11072`
- `PaymentLinkItem` → `schema.prisma:L11027`
- `PaymentLinkItemModifier` → `schema.prisma:L11054`
- `PaymentProvider` → `schema.prisma:L4071`
- `PayrollLine` → `schema.prisma:L12715`
- `PayrollRun` → `schema.prisma:L12684`
- `PerformanceGoal` → `schema.prisma:L9364`
- `PermissionSet` → `schema.prisma:L1129`
- `PlatformCfdi` → `schema.prisma:L12996`
- `PlatformEmisor` → `schema.prisma:L12940`
- `PlatformSettings` → `schema.prisma:L4493`
- `PosCommand` → `schema.prisma:L6475`
- `PosConnectionStatus` → `schema.prisma:L772`
- `PosSyncIntent` → `schema.prisma:L13074`
- `PricingPolicy` → `schema.prisma:L1985`
- `Printer` → `schema.prisma:L11475`
- `PrintGateway` → `schema.prisma:L11512`
- `PrintJob` → `schema.prisma:L11679`
- `PrintStation` → `schema.prisma:L11530`
- `ProcessedStripeEvent` → `schema.prisma:L4966`
- `ProcessorReliabilityMetric` → `schema.prisma:L5451`
- `Product` → `schema.prisma:L1417`
- `ProductModifierGroup` → `schema.prisma:L3084`
- `ProductOption` → `schema.prisma:L11246`
- `ProductOptionValue` → `schema.prisma:L11257`
- `ProductStaff` → `schema.prisma:L10220`
- `PromoterBankAccount` → `schema.prisma:L12835`
- `PromoterCommissionEntry` → `schema.prisma:L12854`
- `PromoterLocationPing` → `schema.prisma:L2658`
- `ProviderCostStructure` → `schema.prisma:L5002`
- `ProviderEventLog` → `schema.prisma:L4795`
- `PurchaseOrder` → `schema.prisma:L1892`
- `PurchaseOrderItem` → `schema.prisma:L1949`
- `RateCorrectionBatch` → `schema.prisma:L5227`
- `RateCorrectionEntry` → `schema.prisma:L5269`
- `RawMaterial` → `schema.prisma:L1653`
- `RawMaterialMovement` → `schema.prisma:L2038`
- `RawMaterialPresentation` → `schema.prisma:L1726`
- `Recipe` → `schema.prisma:L1746`
- `RecipeLine` → `schema.prisma:L1770`
- `Referral` → `schema.prisma:L5873`
- `ReferralProgramConfig` → `schema.prisma:L5838`
- `ReferralRewardGrant` → `schema.prisma:L5964`
- `ReferralTierReward` → `schema.prisma:L5936`
- `ReferralTierUnlock` → `schema.prisma:L6009`
- `Reservation` → `schema.prisma:L10007`
- `ReservationGoogleEventMapping` → `schema.prisma:L10744`
- `ReservationModifier` → `schema.prisma:L10168`
- `ReservationReminderSent` → `schema.prisma:L10151`
- `ReservationSettings` → `schema.prisma:L10382`
- `ReservationWaitlistEntry` → `schema.prisma:L10350`
- `Review` → `schema.prisma:L3579`
- `SalesRetention` → `schema.prisma:L12535`
- `SaleVerification` → `schema.prisma:L3338`
- `ScheduledCommand` → `schema.prisma:L7879`
- `SerializedItem` → `schema.prisma:L8502`
- `SerializedItemCustodyEvent` → `schema.prisma:L8665`
- `ServiceCharge` → `schema.prisma:L6263`
- `SettlementConfiguration` → `schema.prisma:L5302`
- `SettlementConfirmation` → `schema.prisma:L5415`
- `SettlementIncident` → `schema.prisma:L5366`
- `SettlementSimulation` → `schema.prisma:L5337`
- `Shift` → `schema.prisma:L2506`
- `SimRegistrationRequest` → `schema.prisma:L8703`
- `SimRegistrationRequestItem` → `schema.prisma:L8725`
- `SlotHold` → `schema.prisma:L10251`
- `Staff` → `schema.prisma:L792`
- `StaffOnboardingState` → `schema.prisma:L11750`
- `StaffOrganization` → `schema.prisma:L1043`
- `StaffPasskey` → `schema.prisma:L1070`
- `StaffSchedule` → `schema.prisma:L10191`
- `StaffScheduleException` → `schema.prisma:L10203`
- `StaffVenue` → `schema.prisma:L973`
- `StockAlertConfig` → `schema.prisma:L9346`
- `StockBatch` → `schema.prisma:L2169`
- `StockCount` → `schema.prisma:L2106`
- `StockCountItem` → `schema.prisma:L2127`
- `StripeWebhookEvent` → `schema.prisma:L4949`
- `Supplier` → `schema.prisma:L1805`
- `SupplierPricing` → `schema.prisma:L1858`
- `Table` → `schema.prisma:L2418`
- `Terminal` → `schema.prisma:L3630`
- `TerminalHealth` → `schema.prisma:L3847`
- `TerminalLog` → `schema.prisma:L3821`
- `TerminalOrder` → `schema.prisma:L3974`
- `TerminalOrderItem` → `schema.prisma:L4049`
- `TerminalPaymentRequest` → `schema.prisma:L3918`
- `TimeEntry` → `schema.prisma:L2571`
- `TimeEntryBreak` → `schema.prisma:L2640`
- `TokenPurchase` → `schema.prisma:L7553`
- `TokenUsageRecord` → `schema.prisma:L7525`
- `TpvCommandHistory` → `schema.prisma:L7785`
- `TpvCommandQueue` → `schema.prisma:L7725`
- `TpvFeedback` → `schema.prisma:L7438`
- `TpvMessage` → `schema.prisma:L9703`
- `TpvMessageDelivery` → `schema.prisma:L9755`
- `TpvMessageResponse` → `schema.prisma:L9778`
- `TrainingModule` → `schema.prisma:L9833`
- `TrainingProgress` → `schema.prisma:L9910`
- `TrainingQuizQuestion` → `schema.prisma:L9892`
- `TrainingStep` → `schema.prisma:L9872`
- `TransactionCost` → `schema.prisma:L5165`
- `UnitConversion` → `schema.prisma:L2016`
- `user_sessions` → `schema.prisma:L4551`
- `Venue` → `schema.prisma:L116`
- `VenueChatMessage` → `schema.prisma:L656`
- `VenueChatSession` → `schema.prisma:L611`
- `VenueCommission` → `schema.prisma:L11407`
- `VenueCreditAssessment` → `schema.prisma:L8247`
- `VenueCryptoConfig` → `schema.prisma:L9570`
- `VenueFeature` → `schema.prisma:L3452`
- `VenueModule` → `schema.prisma:L8403`
- `VenuePaymentConfig` → `schema.prisma:L4652`
- `VenuePaymentLinkSettings` → `schema.prisma:L10777`
- `VenuePricingStructure` → `schema.prisma:L5105`
- `VenueRoleConfig` → `schema.prisma:L1158`
- `VenueRolePermission` → `schema.prisma:L1100`
- `VenueSettings` → `schema.prisma:L696`
- `VenueTransaction` → `schema.prisma:L3389`
- `VenueWhatsappActivation` → `schema.prisma:L547`
- `WebhookEvent` → `schema.prisma:L3488`
- `WebhookSubscription` → `schema.prisma:L4768`
- `WhatsappContactWindow` → `schema.prisma:L565`
- `WhatsappInboundEvent` → `schema.prisma:L585`
- `Zone` → `schema.prisma:L99`
