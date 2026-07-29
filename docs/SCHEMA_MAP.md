# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **277 models / 253 enums / ~12,800 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L12153`
- `AccountMapping` → `schema.prisma:L12049`
- `ActivityLog` → `schema.prisma:L5462`
- `Aggregator` → `schema.prisma:L11173`
- `AngelPayUserAccount` → `schema.prisma:L4171`
- `AppUpdate` → `schema.prisma:L9402`
- `Area` → `schema.prisma:L2383`
- `BankStatement` → `schema.prisma:L11923`
- `BankStatementLine` → `schema.prisma:L11944`
- `BillingTaxProfile` → `schema.prisma:L12733`
- `BulkCommandOperation` → `schema.prisma:L7723`
- `CalendarSyncOutbox` → `schema.prisma:L10576`
- `CampaignDelivery` → `schema.prisma:L9560`
- `CashCloseout` → `schema.prisma:L8088`
- `CashDeposit` → `schema.prisma:L9204`
- `CashDrawerEvent` → `schema.prisma:L11019`
- `CashDrawerSession` → `schema.prisma:L10995`
- `CashOutCommissionRate` → `schema.prisma:L12562`
- `CashOutScheduleDay` → `schema.prisma:L12585`
- `CashOutWithdrawal` → `schema.prisma:L12647`
- `Cfdi` → `schema.prisma:L11826`
- `ChatbotTokenBudget` → `schema.prisma:L7371`
- `ChatConversation` → `schema.prisma:L7226`
- `ChatFeedback` → `schema.prisma:L7312`
- `ChatLearningEvent` → `schema.prisma:L7269`
- `ChatMessage` → `schema.prisma:L7249`
- `ChatTrainingData` → `schema.prisma:L7183`
- `CheckoutSession` → `schema.prisma:L4451`
- `ClassSession` → `schema.prisma:L10194`
- `CommissionCalculation` → `schema.prisma:L8983`
- `CommissionClawback` → `schema.prisma:L9156`
- `CommissionConfig` → `schema.prisma:L8756`
- `CommissionMilestone` → `schema.prisma:L8899`
- `CommissionOverride` → `schema.prisma:L8826`
- `CommissionPayout` → `schema.prisma:L9107`
- `CommissionSummary` → `schema.prisma:L9046`
- `CommissionTier` → `schema.prisma:L8863`
- `Consumer` → `schema.prisma:L5583`
- `ConsumerAuthAccount` → `schema.prisma:L5608`
- `CouponCode` → `schema.prisma:L6014`
- `CouponRedemption` → `schema.prisma:L6045`
- `CreditAssessmentHistory` → `schema.prisma:L8197`
- `CreditItemBalance` → `schema.prisma:L10785`
- `CreditOffer` → `schema.prisma:L8216`
- `CreditPack` → `schema.prisma:L10701`
- `CreditPackItem` → `schema.prisma:L10730`
- `CreditPackPurchase` → `schema.prisma:L10747`
- `CreditTransaction` → `schema.prisma:L10807`
- `Customer` → `schema.prisma:L5488`
- `CustomerDiscount` → `schema.prisma:L6065`
- `CustomerGroup` → `schema.prisma:L5642`
- `CustomerTaxProfile` → `schema.prisma:L11895`
- `DeliveryActivationRequest` → `schema.prisma:L4773`
- `DeliveryChannelLink` → `schema.prisma:L4737`
- `DeliveryOrderEvent` → `schema.prisma:L4797`
- `DeviceToken` → `schema.prisma:L6334`
- `DigitalReceipt` → `schema.prisma:L3232`
- `Discount` → `schema.prisma:L5914`
- `EcommerceMerchant` → `schema.prisma:L4263`
- `EmailTemplate` → `schema.prisma:L9499`
- `Employee` → `schema.prisma:L12410`
- `Estimate` → `schema.prisma:L11080`
- `EstimateItem` → `schema.prisma:L11108`
- `Expense` → `schema.prisma:L12197`
- `ExternalBusyBlock` → `schema.prisma:L10469`
- `Feature` → `schema.prisma:L3361`
- `FeeSchedule` → `schema.prisma:L3439`
- `FeeTier` → `schema.prisma:L3450`
- `FinancialAccount` → `schema.prisma:L11270`
- `FinancialConnection` → `schema.prisma:L11239`
- `FinancialProvider` → `schema.prisma:L11225`
- `FiscalEmisor` → `schema.prisma:L11749`
- `FiscalLossCarryforward` → `schema.prisma:L12320`
- `FixedAsset` → `schema.prisma:L12338`
- `FixedAssetDepreciation` → `schema.prisma:L12367`
- `FloorElement` → `schema.prisma:L2459`
- `GeofenceRule` → `schema.prisma:L7808`
- `GoogleCalendarChannel` → `schema.prisma:L10446`
- `GoogleCalendarConnection` → `schema.prisma:L10398`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L10499`
- `GoogleOAuthSession` → `schema.prisma:L10521`
- `HolidayCalendar` → `schema.prisma:L5386`
- `IdempotencyRequest` → `schema.prisma:L8631`
- `InterVenueTransfer` → `schema.prisma:L2211`
- `InterVenueTransferAllocation` → `schema.prisma:L2294`
- `InterVenueTransferItem` → `schema.prisma:L2263`
- `InterVenueTransferReceipt` → `schema.prisma:L2321`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2337`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2365`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2349`
- `Inventory` → `schema.prisma:L1584`
- `InventoryMovement` → `schema.prisma:L1611`
- `InventoryTransfer` → `schema.prisma:L11052`
- `Invitation` → `schema.prisma:L1169`
- `Invoice` → `schema.prisma:L3462`
- `InvoiceItem` → `schema.prisma:L3488`
- `ItemCategory` → `schema.prisma:L8348`
- `JournalEntry` → `schema.prisma:L12107`
- `JournalLine` → `schema.prisma:L12135`
- `KdsOrder` → `schema.prisma:L11318`
- `KdsOrderItem` → `schema.prisma:L11335`
- `LearnedPatterns` → `schema.prisma:L7293`
- `LedgerAccount` → `schema.prisma:L11999`
- `LiveDemoSession` → `schema.prisma:L675`
- `LowStockAlert` → `schema.prisma:L2065`
- `LoyaltyConfig` → `schema.prisma:L5672`
- `LoyaltyTransaction` → `schema.prisma:L5695`
- `MarketingCampaign` → `schema.prisma:L9517`
- `McpAuthCode` → `schema.prisma:L11632`
- `McpOAuthClient` → `schema.prisma:L11616`
- `McpRefreshToken` → `schema.prisma:L11650`
- `McpToolCall` → `schema.prisma:L11671`
- `MeasurementUnit` → `schema.prisma:L11158`
- `Menu` → `schema.prisma:L1355`
- `MenuCategory` → `schema.prisma:L1292`
- `MenuCategoryAssignment` → `schema.prisma:L1390`
- `MercadoPagoWebhookEvent` → `schema.prisma:L11546`
- `MerchantAccount` → `schema.prisma:L4001`
- `MerchantFiscalConfig` → `schema.prisma:L11797`
- `MerchantRevenueShare` → `schema.prisma:L4966`
- `MerchantRoutingRule` → `schema.prisma:L4123`
- `MilestoneAchievement` → `schema.prisma:L8944`
- `Modifier` → `schema.prisma:L2974`
- `ModifierGroup` → `schema.prisma:L2938`
- `Module` → `schema.prisma:L8264`
- `MoneyAnomaly` → `schema.prisma:L4869`
- `MonthlyVenueProfit` → `schema.prisma:L5412`
- `Notification` → `schema.prisma:L6236`
- `NotificationPreference` → `schema.prisma:L6283`
- `NotificationTemplate` → `schema.prisma:L6310`
- `OAuthState` → `schema.prisma:L1220`
- `OnboardingProgress` → `schema.prisma:L1238`
- `Order` → `schema.prisma:L2683`
- `OrderAction` → `schema.prisma:L3039`
- `OrderCustomer` → `schema.prisma:L2819`
- `OrderDiscount` → `schema.prisma:L6097`
- `OrderItem` → `schema.prisma:L2835`
- `OrderItemModifier` → `schema.prisma:L3023`
- `OrderServiceCharge` → `schema.prisma:L6181`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L9318`
- `OrganizationGoal` → `schema.prisma:L9276`
- `OrganizationModule` → `schema.prisma:L8320`
- `OrganizationPaymentConfig` → `schema.prisma:L4575`
- `OrganizationPayoutConfig` → `schema.prisma:L9351`
- `OrganizationPricingStructure` → `schema.prisma:L4607`
- `OrganizationSalesGoalConfig` → `schema.prisma:L9299`
- `OtpChallenge` → `schema.prisma:L5627`
- `PartnerAPIKey` → `schema.prisma:L4405`
- `Payment` → `schema.prisma:L3072`
- `PaymentAllocation` → `schema.prisma:L3211`
- `PaymentLink` → `schema.prisma:L10853`
- `PaymentLinkAttribution` → `schema.prisma:L10961`
- `PaymentLinkItem` → `schema.prisma:L10916`
- `PaymentLinkItemModifier` → `schema.prisma:L10943`
- `PaymentProvider` → `schema.prisma:L3960`
- `PayrollLine` → `schema.prisma:L12481`
- `PayrollRun` → `schema.prisma:L12450`
- `PerformanceGoal` → `schema.prisma:L9253`
- `PermissionSet` → `schema.prisma:L1120`
- `PlatformCfdi` → `schema.prisma:L12762`
- `PlatformEmisor` → `schema.prisma:L12706`
- `PlatformSettings` → `schema.prisma:L4382`
- `PosCommand` → `schema.prisma:L6364`
- `PosConnectionStatus` → `schema.prisma:L767`
- `PosSyncIntent` → `schema.prisma:L12840`
- `PricingPolicy` → `schema.prisma:L1976`
- `Printer` → `schema.prisma:L11364`
- `PrintGateway` → `schema.prisma:L11401`
- `PrintJob` → `schema.prisma:L11448`
- `PrintStation` → `schema.prisma:L11419`
- `ProcessedStripeEvent` → `schema.prisma:L4855`
- `ProcessorReliabilityMetric` → `schema.prisma:L5340`
- `Product` → `schema.prisma:L1408`
- `ProductModifierGroup` → `schema.prisma:L3011`
- `ProductOption` → `schema.prisma:L11135`
- `ProductOptionValue` → `schema.prisma:L11146`
- `ProductStaff` → `schema.prisma:L10109`
- `PromoterBankAccount` → `schema.prisma:L12601`
- `PromoterCommissionEntry` → `schema.prisma:L12620`
- `PromoterLocationPing` → `schema.prisma:L2649`
- `ProviderCostStructure` → `schema.prisma:L4891`
- `ProviderEventLog` → `schema.prisma:L4684`
- `PurchaseOrder` → `schema.prisma:L1883`
- `PurchaseOrderItem` → `schema.prisma:L1940`
- `RateCorrectionBatch` → `schema.prisma:L5116`
- `RateCorrectionEntry` → `schema.prisma:L5158`
- `RawMaterial` → `schema.prisma:L1644`
- `RawMaterialMovement` → `schema.prisma:L2029`
- `RawMaterialPresentation` → `schema.prisma:L1717`
- `Recipe` → `schema.prisma:L1737`
- `RecipeLine` → `schema.prisma:L1761`
- `Referral` → `schema.prisma:L5762`
- `ReferralProgramConfig` → `schema.prisma:L5727`
- `ReferralRewardGrant` → `schema.prisma:L5853`
- `ReferralTierReward` → `schema.prisma:L5825`
- `ReferralTierUnlock` → `schema.prisma:L5898`
- `Reservation` → `schema.prisma:L9896`
- `ReservationGoogleEventMapping` → `schema.prisma:L10633`
- `ReservationModifier` → `schema.prisma:L10057`
- `ReservationReminderSent` → `schema.prisma:L10040`
- `ReservationSettings` → `schema.prisma:L10271`
- `ReservationWaitlistEntry` → `schema.prisma:L10239`
- `Review` → `schema.prisma:L3506`
- `SalesRetention` → `schema.prisma:L12301`
- `SaleVerification` → `schema.prisma:L3265`
- `ScheduledCommand` → `schema.prisma:L7768`
- `SerializedItem` → `schema.prisma:L8391`
- `SerializedItemCustodyEvent` → `schema.prisma:L8554`
- `ServiceCharge` → `schema.prisma:L6152`
- `SettlementConfiguration` → `schema.prisma:L5191`
- `SettlementConfirmation` → `schema.prisma:L5304`
- `SettlementIncident` → `schema.prisma:L5255`
- `SettlementSimulation` → `schema.prisma:L5226`
- `Shift` → `schema.prisma:L2497`
- `SimRegistrationRequest` → `schema.prisma:L8592`
- `SimRegistrationRequestItem` → `schema.prisma:L8614`
- `SlotHold` → `schema.prisma:L10140`
- `Staff` → `schema.prisma:L787`
- `StaffOnboardingState` → `schema.prisma:L11516`
- `StaffOrganization` → `schema.prisma:L1034`
- `StaffPasskey` → `schema.prisma:L1061`
- `StaffSchedule` → `schema.prisma:L10080`
- `StaffScheduleException` → `schema.prisma:L10092`
- `StaffVenue` → `schema.prisma:L964`
- `StockAlertConfig` → `schema.prisma:L9235`
- `StockBatch` → `schema.prisma:L2160`
- `StockCount` → `schema.prisma:L2097`
- `StockCountItem` → `schema.prisma:L2118`
- `StripeWebhookEvent` → `schema.prisma:L4838`
- `Supplier` → `schema.prisma:L1796`
- `SupplierPricing` → `schema.prisma:L1849`
- `Table` → `schema.prisma:L2409`
- `Terminal` → `schema.prisma:L3557`
- `TerminalHealth` → `schema.prisma:L3736`
- `TerminalLog` → `schema.prisma:L3710`
- `TerminalOrder` → `schema.prisma:L3863`
- `TerminalOrderItem` → `schema.prisma:L3938`
- `TerminalPaymentRequest` → `schema.prisma:L3807`
- `TimeEntry` → `schema.prisma:L2562`
- `TimeEntryBreak` → `schema.prisma:L2631`
- `TokenPurchase` → `schema.prisma:L7442`
- `TokenUsageRecord` → `schema.prisma:L7414`
- `TpvCommandHistory` → `schema.prisma:L7674`
- `TpvCommandQueue` → `schema.prisma:L7614`
- `TpvFeedback` → `schema.prisma:L7327`
- `TpvMessage` → `schema.prisma:L9592`
- `TpvMessageDelivery` → `schema.prisma:L9644`
- `TpvMessageResponse` → `schema.prisma:L9667`
- `TrainingModule` → `schema.prisma:L9722`
- `TrainingProgress` → `schema.prisma:L9799`
- `TrainingQuizQuestion` → `schema.prisma:L9781`
- `TrainingStep` → `schema.prisma:L9761`
- `TransactionCost` → `schema.prisma:L5054`
- `UnitConversion` → `schema.prisma:L2007`
- `user_sessions` → `schema.prisma:L4440`
- `Venue` → `schema.prisma:L116`
- `VenueChatMessage` → `schema.prisma:L651`
- `VenueChatSession` → `schema.prisma:L606`
- `VenueCommission` → `schema.prisma:L11296`
- `VenueCreditAssessment` → `schema.prisma:L8136`
- `VenueCryptoConfig` → `schema.prisma:L9459`
- `VenueFeature` → `schema.prisma:L3379`
- `VenueModule` → `schema.prisma:L8292`
- `VenuePaymentConfig` → `schema.prisma:L4541`
- `VenuePaymentLinkSettings` → `schema.prisma:L10666`
- `VenuePricingStructure` → `schema.prisma:L4994`
- `VenueRoleConfig` → `schema.prisma:L1149`
- `VenueRolePermission` → `schema.prisma:L1091`
- `VenueSettings` → `schema.prisma:L691`
- `VenueTransaction` → `schema.prisma:L3316`
- `VenueWhatsappActivation` → `schema.prisma:L542`
- `WebhookEvent` → `schema.prisma:L3415`
- `WebhookSubscription` → `schema.prisma:L4657`
- `WhatsappContactWindow` → `schema.prisma:L560`
- `WhatsappInboundEvent` → `schema.prisma:L580`
- `Zone` → `schema.prisma:L99`
