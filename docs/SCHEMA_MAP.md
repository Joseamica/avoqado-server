# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **267 models / 248 enums / ~12,400 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
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
| 6   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `Inventory`, `InventoryMovement`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                                                                                                                                                                                                   |
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

- `AccountingPeriodLock` → `schema.prisma:L11814`
- `AccountMapping` → `schema.prisma:L11710`
- `ActivityLog` → `schema.prisma:L5203`
- `Aggregator` → `schema.prisma:L10858`
- `AngelPayUserAccount` → `schema.prisma:L3912`
- `AppUpdate` → `schema.prisma:L9087`
- `Area` → `schema.prisma:L2157`
- `BankStatement` → `schema.prisma:L11584`
- `BankStatementLine` → `schema.prisma:L11605`
- `BillingTaxProfile` → `schema.prisma:L12394`
- `BulkCommandOperation` → `schema.prisma:L7440`
- `CalendarSyncOutbox` → `schema.prisma:L10261`
- `CampaignDelivery` → `schema.prisma:L9245`
- `CashCloseout` → `schema.prisma:L7773`
- `CashDeposit` → `schema.prisma:L8889`
- `CashDrawerEvent` → `schema.prisma:L10704`
- `CashDrawerSession` → `schema.prisma:L10680`
- `CashOutCommissionRate` → `schema.prisma:L12223`
- `CashOutScheduleDay` → `schema.prisma:L12246`
- `CashOutWithdrawal` → `schema.prisma:L12308`
- `Cfdi` → `schema.prisma:L11487`
- `ChatbotTokenBudget` → `schema.prisma:L7088`
- `ChatConversation` → `schema.prisma:L6943`
- `ChatFeedback` → `schema.prisma:L7029`
- `ChatLearningEvent` → `schema.prisma:L6986`
- `ChatMessage` → `schema.prisma:L6966`
- `ChatTrainingData` → `schema.prisma:L6900`
- `CheckoutSession` → `schema.prisma:L4192`
- `ClassSession` → `schema.prisma:L9879`
- `CommissionCalculation` → `schema.prisma:L8668`
- `CommissionClawback` → `schema.prisma:L8841`
- `CommissionConfig` → `schema.prisma:L8441`
- `CommissionMilestone` → `schema.prisma:L8584`
- `CommissionOverride` → `schema.prisma:L8511`
- `CommissionPayout` → `schema.prisma:L8792`
- `CommissionSummary` → `schema.prisma:L8731`
- `CommissionTier` → `schema.prisma:L8548`
- `Consumer` → `schema.prisma:L5324`
- `ConsumerAuthAccount` → `schema.prisma:L5349`
- `CouponCode` → `schema.prisma:L5755`
- `CouponRedemption` → `schema.prisma:L5786`
- `CreditAssessmentHistory` → `schema.prisma:L7882`
- `CreditItemBalance` → `schema.prisma:L10470`
- `CreditOffer` → `schema.prisma:L7901`
- `CreditPack` → `schema.prisma:L10386`
- `CreditPackItem` → `schema.prisma:L10415`
- `CreditPackPurchase` → `schema.prisma:L10432`
- `CreditTransaction` → `schema.prisma:L10492`
- `Customer` → `schema.prisma:L5229`
- `CustomerDiscount` → `schema.prisma:L5806`
- `CustomerGroup` → `schema.prisma:L5383`
- `CustomerTaxProfile` → `schema.prisma:L11556`
- `DeliveryActivationRequest` → `schema.prisma:L4514`
- `DeliveryChannelLink` → `schema.prisma:L4478`
- `DeliveryOrderEvent` → `schema.prisma:L4538`
- `DeviceToken` → `schema.prisma:L6075`
- `DigitalReceipt` → `schema.prisma:L3006`
- `Discount` → `schema.prisma:L5655`
- `EcommerceMerchant` → `schema.prisma:L4004`
- `EmailTemplate` → `schema.prisma:L9184`
- `Employee` → `schema.prisma:L12071`
- `Estimate` → `schema.prisma:L10765`
- `EstimateItem` → `schema.prisma:L10793`
- `Expense` → `schema.prisma:L11858`
- `ExternalBusyBlock` → `schema.prisma:L10154`
- `Feature` → `schema.prisma:L3135`
- `FeeSchedule` → `schema.prisma:L3213`
- `FeeTier` → `schema.prisma:L3224`
- `FinancialAccount` → `schema.prisma:L10955`
- `FinancialConnection` → `schema.prisma:L10924`
- `FinancialProvider` → `schema.prisma:L10910`
- `FiscalEmisor` → `schema.prisma:L11410`
- `FiscalLossCarryforward` → `schema.prisma:L11981`
- `FixedAsset` → `schema.prisma:L11999`
- `FixedAssetDepreciation` → `schema.prisma:L12028`
- `FloorElement` → `schema.prisma:L2233`
- `GeofenceRule` → `schema.prisma:L7525`
- `GoogleCalendarChannel` → `schema.prisma:L10131`
- `GoogleCalendarConnection` → `schema.prisma:L10083`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L10184`
- `GoogleOAuthSession` → `schema.prisma:L10206`
- `HolidayCalendar` → `schema.prisma:L5127`
- `IdempotencyRequest` → `schema.prisma:L8316`
- `Inventory` → `schema.prisma:L1569`
- `InventoryMovement` → `schema.prisma:L1596`
- `InventoryTransfer` → `schema.prisma:L10737`
- `Invitation` → `schema.prisma:L1154`
- `Invoice` → `schema.prisma:L3236`
- `InvoiceItem` → `schema.prisma:L3262`
- `ItemCategory` → `schema.prisma:L8033`
- `JournalEntry` → `schema.prisma:L11768`
- `JournalLine` → `schema.prisma:L11796`
- `KdsOrder` → `schema.prisma:L11003`
- `KdsOrderItem` → `schema.prisma:L11020`
- `LearnedPatterns` → `schema.prisma:L7010`
- `LedgerAccount` → `schema.prisma:L11660`
- `LiveDemoSession` → `schema.prisma:L667`
- `LowStockAlert` → `schema.prisma:L2016`
- `LoyaltyConfig` → `schema.prisma:L5413`
- `LoyaltyTransaction` → `schema.prisma:L5436`
- `MarketingCampaign` → `schema.prisma:L9202`
- `McpAuthCode` → `schema.prisma:L11317`
- `McpOAuthClient` → `schema.prisma:L11301`
- `McpRefreshToken` → `schema.prisma:L11335`
- `MeasurementUnit` → `schema.prisma:L10843`
- `Menu` → `schema.prisma:L1340`
- `MenuCategory` → `schema.prisma:L1277`
- `MenuCategoryAssignment` → `schema.prisma:L1375`
- `MercadoPagoWebhookEvent` → `schema.prisma:L11231`
- `MerchantAccount` → `schema.prisma:L3742`
- `MerchantFiscalConfig` → `schema.prisma:L11458`
- `MerchantRevenueShare` → `schema.prisma:L4707`
- `MerchantRoutingRule` → `schema.prisma:L3864`
- `MilestoneAchievement` → `schema.prisma:L8629`
- `Modifier` → `schema.prisma:L2748`
- `ModifierGroup` → `schema.prisma:L2712`
- `Module` → `schema.prisma:L7949`
- `MoneyAnomaly` → `schema.prisma:L4610`
- `MonthlyVenueProfit` → `schema.prisma:L5153`
- `Notification` → `schema.prisma:L5977`
- `NotificationPreference` → `schema.prisma:L6024`
- `NotificationTemplate` → `schema.prisma:L6051`
- `OAuthState` → `schema.prisma:L1205`
- `OnboardingProgress` → `schema.prisma:L1223`
- `Order` → `schema.prisma:L2457`
- `OrderAction` → `schema.prisma:L2813`
- `OrderCustomer` → `schema.prisma:L2593`
- `OrderDiscount` → `schema.prisma:L5838`
- `OrderItem` → `schema.prisma:L2609`
- `OrderItemModifier` → `schema.prisma:L2797`
- `OrderServiceCharge` → `schema.prisma:L5922`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L9003`
- `OrganizationGoal` → `schema.prisma:L8961`
- `OrganizationModule` → `schema.prisma:L8005`
- `OrganizationPaymentConfig` → `schema.prisma:L4316`
- `OrganizationPayoutConfig` → `schema.prisma:L9036`
- `OrganizationPricingStructure` → `schema.prisma:L4348`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8984`
- `OtpChallenge` → `schema.prisma:L5368`
- `PartnerAPIKey` → `schema.prisma:L4146`
- `Payment` → `schema.prisma:L2846`
- `PaymentAllocation` → `schema.prisma:L2985`
- `PaymentLink` → `schema.prisma:L10538`
- `PaymentLinkAttribution` → `schema.prisma:L10646`
- `PaymentLinkItem` → `schema.prisma:L10601`
- `PaymentLinkItemModifier` → `schema.prisma:L10628`
- `PaymentProvider` → `schema.prisma:L3701`
- `PayrollLine` → `schema.prisma:L12142`
- `PayrollRun` → `schema.prisma:L12111`
- `PerformanceGoal` → `schema.prisma:L8938`
- `PermissionSet` → `schema.prisma:L1105`
- `PlatformCfdi` → `schema.prisma:L12423`
- `PlatformEmisor` → `schema.prisma:L12367`
- `PlatformSettings` → `schema.prisma:L4123`
- `PosCommand` → `schema.prisma:L6105`
- `PosConnectionStatus` → `schema.prisma:L752`
- `PricingPolicy` → `schema.prisma:L1927`
- `Printer` → `schema.prisma:L11049`
- `PrintGateway` → `schema.prisma:L11086`
- `PrintJob` → `schema.prisma:L11133`
- `PrintStation` → `schema.prisma:L11104`
- `ProcessedStripeEvent` → `schema.prisma:L4596`
- `ProcessorReliabilityMetric` → `schema.prisma:L5081`
- `Product` → `schema.prisma:L1393`
- `ProductModifierGroup` → `schema.prisma:L2785`
- `ProductOption` → `schema.prisma:L10820`
- `ProductOptionValue` → `schema.prisma:L10831`
- `ProductStaff` → `schema.prisma:L9794`
- `PromoterBankAccount` → `schema.prisma:L12262`
- `PromoterCommissionEntry` → `schema.prisma:L12281`
- `PromoterLocationPing` → `schema.prisma:L2423`
- `ProviderCostStructure` → `schema.prisma:L4632`
- `ProviderEventLog` → `schema.prisma:L4425`
- `PurchaseOrder` → `schema.prisma:L1841`
- `PurchaseOrderItem` → `schema.prisma:L1898`
- `RateCorrectionBatch` → `schema.prisma:L4857`
- `RateCorrectionEntry` → `schema.prisma:L4899`
- `RawMaterial` → `schema.prisma:L1629`
- `RawMaterialMovement` → `schema.prisma:L1980`
- `Recipe` → `schema.prisma:L1695`
- `RecipeLine` → `schema.prisma:L1719`
- `Referral` → `schema.prisma:L5503`
- `ReferralProgramConfig` → `schema.prisma:L5468`
- `ReferralRewardGrant` → `schema.prisma:L5594`
- `ReferralTierReward` → `schema.prisma:L5566`
- `ReferralTierUnlock` → `schema.prisma:L5639`
- `Reservation` → `schema.prisma:L9581`
- `ReservationGoogleEventMapping` → `schema.prisma:L10318`
- `ReservationModifier` → `schema.prisma:L9742`
- `ReservationReminderSent` → `schema.prisma:L9725`
- `ReservationSettings` → `schema.prisma:L9956`
- `ReservationWaitlistEntry` → `schema.prisma:L9924`
- `Review` → `schema.prisma:L3280`
- `SalesRetention` → `schema.prisma:L11962`
- `SaleVerification` → `schema.prisma:L3039`
- `ScheduledCommand` → `schema.prisma:L7485`
- `SerializedItem` → `schema.prisma:L8076`
- `SerializedItemCustodyEvent` → `schema.prisma:L8239`
- `ServiceCharge` → `schema.prisma:L5893`
- `SettlementConfiguration` → `schema.prisma:L4932`
- `SettlementConfirmation` → `schema.prisma:L5045`
- `SettlementIncident` → `schema.prisma:L4996`
- `SettlementSimulation` → `schema.prisma:L4967`
- `Shift` → `schema.prisma:L2271`
- `SimRegistrationRequest` → `schema.prisma:L8277`
- `SimRegistrationRequestItem` → `schema.prisma:L8299`
- `SlotHold` → `schema.prisma:L9825`
- `Staff` → `schema.prisma:L772`
- `StaffOnboardingState` → `schema.prisma:L11201`
- `StaffOrganization` → `schema.prisma:L1019`
- `StaffPasskey` → `schema.prisma:L1046`
- `StaffSchedule` → `schema.prisma:L9765`
- `StaffScheduleException` → `schema.prisma:L9777`
- `StaffVenue` → `schema.prisma:L949`
- `StockAlertConfig` → `schema.prisma:L8920`
- `StockBatch` → `schema.prisma:L2111`
- `StockCount` → `schema.prisma:L2048`
- `StockCountItem` → `schema.prisma:L2069`
- `StripeWebhookEvent` → `schema.prisma:L4579`
- `Supplier` → `schema.prisma:L1754`
- `SupplierPricing` → `schema.prisma:L1807`
- `Table` → `schema.prisma:L2183`
- `Terminal` → `schema.prisma:L3331`
- `TerminalHealth` → `schema.prisma:L3477`
- `TerminalLog` → `schema.prisma:L3451`
- `TerminalOrder` → `schema.prisma:L3604`
- `TerminalOrderItem` → `schema.prisma:L3679`
- `TerminalPaymentRequest` → `schema.prisma:L3548`
- `TimeEntry` → `schema.prisma:L2336`
- `TimeEntryBreak` → `schema.prisma:L2405`
- `TokenPurchase` → `schema.prisma:L7159`
- `TokenUsageRecord` → `schema.prisma:L7131`
- `TpvCommandHistory` → `schema.prisma:L7391`
- `TpvCommandQueue` → `schema.prisma:L7331`
- `TpvFeedback` → `schema.prisma:L7044`
- `TpvMessage` → `schema.prisma:L9277`
- `TpvMessageDelivery` → `schema.prisma:L9329`
- `TpvMessageResponse` → `schema.prisma:L9352`
- `TrainingModule` → `schema.prisma:L9407`
- `TrainingProgress` → `schema.prisma:L9484`
- `TrainingQuizQuestion` → `schema.prisma:L9466`
- `TrainingStep` → `schema.prisma:L9446`
- `TransactionCost` → `schema.prisma:L4795`
- `UnitConversion` → `schema.prisma:L1958`
- `user_sessions` → `schema.prisma:L4181`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L643`
- `VenueChatSession` → `schema.prisma:L598`
- `VenueCommission` → `schema.prisma:L10981`
- `VenueCreditAssessment` → `schema.prisma:L7821`
- `VenueCryptoConfig` → `schema.prisma:L9144`
- `VenueFeature` → `schema.prisma:L3153`
- `VenueModule` → `schema.prisma:L7977`
- `VenuePaymentConfig` → `schema.prisma:L4282`
- `VenuePaymentLinkSettings` → `schema.prisma:L10351`
- `VenuePricingStructure` → `schema.prisma:L4735`
- `VenueRoleConfig` → `schema.prisma:L1134`
- `VenueRolePermission` → `schema.prisma:L1076`
- `VenueSettings` → `schema.prisma:L683`
- `VenueTransaction` → `schema.prisma:L3090`
- `VenueWhatsappActivation` → `schema.prisma:L534`
- `WebhookEvent` → `schema.prisma:L3189`
- `WebhookSubscription` → `schema.prisma:L4398`
- `WhatsappContactWindow` → `schema.prisma:L552`
- `WhatsappInboundEvent` → `schema.prisma:L572`
- `Zone` → `schema.prisma:L96`
