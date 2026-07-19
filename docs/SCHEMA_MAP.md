# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **264 models / 248 enums / ~12,400 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
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
| 16  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`                                                                                                                                                                                                                                        |
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

- `AccountingPeriodLock` → `schema.prisma:L11744`
- `AccountMapping` → `schema.prisma:L11640`
- `ActivityLog` → `schema.prisma:L5190`
- `Aggregator` → `schema.prisma:L10788`
- `AngelPayUserAccount` → `schema.prisma:L3899`
- `AppUpdate` → `schema.prisma:L9074`
- `Area` → `schema.prisma:L2144`
- `BankStatement` → `schema.prisma:L11514`
- `BankStatementLine` → `schema.prisma:L11535`
- `BillingTaxProfile` → `schema.prisma:L12324`
- `BulkCommandOperation` → `schema.prisma:L7427`
- `CalendarSyncOutbox` → `schema.prisma:L10191`
- `CampaignDelivery` → `schema.prisma:L9232`
- `CashCloseout` → `schema.prisma:L7760`
- `CashDeposit` → `schema.prisma:L8876`
- `CashDrawerEvent` → `schema.prisma:L10634`
- `CashDrawerSession` → `schema.prisma:L10610`
- `CashOutCommissionRate` → `schema.prisma:L12153`
- `CashOutScheduleDay` → `schema.prisma:L12176`
- `CashOutWithdrawal` → `schema.prisma:L12238`
- `Cfdi` → `schema.prisma:L11417`
- `ChatbotTokenBudget` → `schema.prisma:L7075`
- `ChatConversation` → `schema.prisma:L6930`
- `ChatFeedback` → `schema.prisma:L7016`
- `ChatLearningEvent` → `schema.prisma:L6973`
- `ChatMessage` → `schema.prisma:L6953`
- `ChatTrainingData` → `schema.prisma:L6887`
- `CheckoutSession` → `schema.prisma:L4179`
- `ClassSession` → `schema.prisma:L9812`
- `CommissionCalculation` → `schema.prisma:L8655`
- `CommissionClawback` → `schema.prisma:L8828`
- `CommissionConfig` → `schema.prisma:L8428`
- `CommissionMilestone` → `schema.prisma:L8571`
- `CommissionOverride` → `schema.prisma:L8498`
- `CommissionPayout` → `schema.prisma:L8779`
- `CommissionSummary` → `schema.prisma:L8718`
- `CommissionTier` → `schema.prisma:L8535`
- `Consumer` → `schema.prisma:L5311`
- `ConsumerAuthAccount` → `schema.prisma:L5336`
- `CouponCode` → `schema.prisma:L5742`
- `CouponRedemption` → `schema.prisma:L5773`
- `CreditAssessmentHistory` → `schema.prisma:L7869`
- `CreditItemBalance` → `schema.prisma:L10400`
- `CreditOffer` → `schema.prisma:L7888`
- `CreditPack` → `schema.prisma:L10316`
- `CreditPackItem` → `schema.prisma:L10345`
- `CreditPackPurchase` → `schema.prisma:L10362`
- `CreditTransaction` → `schema.prisma:L10422`
- `Customer` → `schema.prisma:L5216`
- `CustomerDiscount` → `schema.prisma:L5793`
- `CustomerGroup` → `schema.prisma:L5370`
- `CustomerTaxProfile` → `schema.prisma:L11486`
- `DeliveryActivationRequest` → `schema.prisma:L4501`
- `DeliveryChannelLink` → `schema.prisma:L4465`
- `DeliveryOrderEvent` → `schema.prisma:L4525`
- `DeviceToken` → `schema.prisma:L6062`
- `DigitalReceipt` → `schema.prisma:L2993`
- `Discount` → `schema.prisma:L5642`
- `EcommerceMerchant` → `schema.prisma:L3991`
- `EmailTemplate` → `schema.prisma:L9171`
- `Employee` → `schema.prisma:L12001`
- `Estimate` → `schema.prisma:L10695`
- `EstimateItem` → `schema.prisma:L10723`
- `Expense` → `schema.prisma:L11788`
- `ExternalBusyBlock` → `schema.prisma:L10084`
- `Feature` → `schema.prisma:L3122`
- `FeeSchedule` → `schema.prisma:L3200`
- `FeeTier` → `schema.prisma:L3211`
- `FinancialAccount` → `schema.prisma:L10885`
- `FinancialConnection` → `schema.prisma:L10854`
- `FinancialProvider` → `schema.prisma:L10840`
- `FiscalEmisor` → `schema.prisma:L11340`
- `FiscalLossCarryforward` → `schema.prisma:L11911`
- `FixedAsset` → `schema.prisma:L11929`
- `FixedAssetDepreciation` → `schema.prisma:L11958`
- `FloorElement` → `schema.prisma:L2220`
- `GeofenceRule` → `schema.prisma:L7512`
- `GoogleCalendarChannel` → `schema.prisma:L10061`
- `GoogleCalendarConnection` → `schema.prisma:L10013`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L10114`
- `GoogleOAuthSession` → `schema.prisma:L10136`
- `HolidayCalendar` → `schema.prisma:L5114`
- `IdempotencyRequest` → `schema.prisma:L8303`
- `Inventory` → `schema.prisma:L1562`
- `InventoryMovement` → `schema.prisma:L1586`
- `InventoryTransfer` → `schema.prisma:L10667`
- `Invitation` → `schema.prisma:L1148`
- `Invoice` → `schema.prisma:L3223`
- `InvoiceItem` → `schema.prisma:L3249`
- `ItemCategory` → `schema.prisma:L8020`
- `JournalEntry` → `schema.prisma:L11698`
- `JournalLine` → `schema.prisma:L11726`
- `KdsOrder` → `schema.prisma:L10933`
- `KdsOrderItem` → `schema.prisma:L10950`
- `LearnedPatterns` → `schema.prisma:L6997`
- `LedgerAccount` → `schema.prisma:L11590`
- `LiveDemoSession` → `schema.prisma:L667`
- `LowStockAlert` → `schema.prisma:L2003`
- `LoyaltyConfig` → `schema.prisma:L5400`
- `LoyaltyTransaction` → `schema.prisma:L5423`
- `MarketingCampaign` → `schema.prisma:L9189`
- `McpAuthCode` → `schema.prisma:L11247`
- `McpOAuthClient` → `schema.prisma:L11231`
- `McpRefreshToken` → `schema.prisma:L11265`
- `MeasurementUnit` → `schema.prisma:L10773`
- `Menu` → `schema.prisma:L1334`
- `MenuCategory` → `schema.prisma:L1271`
- `MenuCategoryAssignment` → `schema.prisma:L1369`
- `MercadoPagoWebhookEvent` → `schema.prisma:L11161`
- `MerchantAccount` → `schema.prisma:L3729`
- `MerchantFiscalConfig` → `schema.prisma:L11388`
- `MerchantRevenueShare` → `schema.prisma:L4694`
- `MerchantRoutingRule` → `schema.prisma:L3851`
- `MilestoneAchievement` → `schema.prisma:L8616`
- `Modifier` → `schema.prisma:L2735`
- `ModifierGroup` → `schema.prisma:L2699`
- `Module` → `schema.prisma:L7936`
- `MoneyAnomaly` → `schema.prisma:L4597`
- `MonthlyVenueProfit` → `schema.prisma:L5140`
- `Notification` → `schema.prisma:L5964`
- `NotificationPreference` → `schema.prisma:L6011`
- `NotificationTemplate` → `schema.prisma:L6038`
- `OAuthState` → `schema.prisma:L1199`
- `OnboardingProgress` → `schema.prisma:L1217`
- `Order` → `schema.prisma:L2444`
- `OrderAction` → `schema.prisma:L2800`
- `OrderCustomer` → `schema.prisma:L2580`
- `OrderDiscount` → `schema.prisma:L5825`
- `OrderItem` → `schema.prisma:L2596`
- `OrderItemModifier` → `schema.prisma:L2784`
- `OrderServiceCharge` → `schema.prisma:L5909`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8990`
- `OrganizationGoal` → `schema.prisma:L8948`
- `OrganizationModule` → `schema.prisma:L7992`
- `OrganizationPaymentConfig` → `schema.prisma:L4303`
- `OrganizationPayoutConfig` → `schema.prisma:L9023`
- `OrganizationPricingStructure` → `schema.prisma:L4335`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8971`
- `OtpChallenge` → `schema.prisma:L5355`
- `PartnerAPIKey` → `schema.prisma:L4133`
- `Payment` → `schema.prisma:L2833`
- `PaymentAllocation` → `schema.prisma:L2972`
- `PaymentLink` → `schema.prisma:L10468`
- `PaymentLinkAttribution` → `schema.prisma:L10576`
- `PaymentLinkItem` → `schema.prisma:L10531`
- `PaymentLinkItemModifier` → `schema.prisma:L10558`
- `PaymentProvider` → `schema.prisma:L3688`
- `PayrollLine` → `schema.prisma:L12072`
- `PayrollRun` → `schema.prisma:L12041`
- `PerformanceGoal` → `schema.prisma:L8925`
- `PermissionSet` → `schema.prisma:L1099`
- `PlatformCfdi` → `schema.prisma:L12353`
- `PlatformEmisor` → `schema.prisma:L12297`
- `PlatformSettings` → `schema.prisma:L4110`
- `PosCommand` → `schema.prisma:L6092`
- `PosConnectionStatus` → `schema.prisma:L752`
- `PricingPolicy` → `schema.prisma:L1914`
- `Printer` → `schema.prisma:L10979`
- `PrintGateway` → `schema.prisma:L11016`
- `PrintJob` → `schema.prisma:L11063`
- `PrintStation` → `schema.prisma:L11034`
- `ProcessedStripeEvent` → `schema.prisma:L4583`
- `ProcessorReliabilityMetric` → `schema.prisma:L5068`
- `Product` → `schema.prisma:L1387`
- `ProductModifierGroup` → `schema.prisma:L2772`
- `ProductOption` → `schema.prisma:L10750`
- `ProductOptionValue` → `schema.prisma:L10761`
- `PromoterBankAccount` → `schema.prisma:L12192`
- `PromoterCommissionEntry` → `schema.prisma:L12211`
- `PromoterLocationPing` → `schema.prisma:L2410`
- `ProviderCostStructure` → `schema.prisma:L4619`
- `ProviderEventLog` → `schema.prisma:L4412`
- `PurchaseOrder` → `schema.prisma:L1828`
- `PurchaseOrderItem` → `schema.prisma:L1885`
- `RateCorrectionBatch` → `schema.prisma:L4844`
- `RateCorrectionEntry` → `schema.prisma:L4886`
- `RawMaterial` → `schema.prisma:L1616`
- `RawMaterialMovement` → `schema.prisma:L1967`
- `Recipe` → `schema.prisma:L1682`
- `RecipeLine` → `schema.prisma:L1706`
- `Referral` → `schema.prisma:L5490`
- `ReferralProgramConfig` → `schema.prisma:L5455`
- `ReferralRewardGrant` → `schema.prisma:L5581`
- `ReferralTierReward` → `schema.prisma:L5553`
- `ReferralTierUnlock` → `schema.prisma:L5626`
- `Reservation` → `schema.prisma:L9568`
- `ReservationGoogleEventMapping` → `schema.prisma:L10248`
- `ReservationModifier` → `schema.prisma:L9727`
- `ReservationReminderSent` → `schema.prisma:L9710`
- `ReservationSettings` → `schema.prisma:L9888`
- `ReservationWaitlistEntry` → `schema.prisma:L9856`
- `Review` → `schema.prisma:L3267`
- `SalesRetention` → `schema.prisma:L11892`
- `SaleVerification` → `schema.prisma:L3026`
- `ScheduledCommand` → `schema.prisma:L7472`
- `SerializedItem` → `schema.prisma:L8063`
- `SerializedItemCustodyEvent` → `schema.prisma:L8226`
- `ServiceCharge` → `schema.prisma:L5880`
- `SettlementConfiguration` → `schema.prisma:L4919`
- `SettlementConfirmation` → `schema.prisma:L5032`
- `SettlementIncident` → `schema.prisma:L4983`
- `SettlementSimulation` → `schema.prisma:L4954`
- `Shift` → `schema.prisma:L2258`
- `SimRegistrationRequest` → `schema.prisma:L8264`
- `SimRegistrationRequestItem` → `schema.prisma:L8286`
- `SlotHold` → `schema.prisma:L9767`
- `Staff` → `schema.prisma:L772`
- `StaffOnboardingState` → `schema.prisma:L11131`
- `StaffOrganization` → `schema.prisma:L1013`
- `StaffPasskey` → `schema.prisma:L1040`
- `StaffVenue` → `schema.prisma:L948`
- `StockAlertConfig` → `schema.prisma:L8907`
- `StockBatch` → `schema.prisma:L2098`
- `StockCount` → `schema.prisma:L2035`
- `StockCountItem` → `schema.prisma:L2056`
- `StripeWebhookEvent` → `schema.prisma:L4566`
- `Supplier` → `schema.prisma:L1741`
- `SupplierPricing` → `schema.prisma:L1794`
- `Table` → `schema.prisma:L2170`
- `Terminal` → `schema.prisma:L3318`
- `TerminalHealth` → `schema.prisma:L3464`
- `TerminalLog` → `schema.prisma:L3438`
- `TerminalOrder` → `schema.prisma:L3591`
- `TerminalOrderItem` → `schema.prisma:L3666`
- `TerminalPaymentRequest` → `schema.prisma:L3535`
- `TimeEntry` → `schema.prisma:L2323`
- `TimeEntryBreak` → `schema.prisma:L2392`
- `TokenPurchase` → `schema.prisma:L7146`
- `TokenUsageRecord` → `schema.prisma:L7118`
- `TpvCommandHistory` → `schema.prisma:L7378`
- `TpvCommandQueue` → `schema.prisma:L7318`
- `TpvFeedback` → `schema.prisma:L7031`
- `TpvMessage` → `schema.prisma:L9264`
- `TpvMessageDelivery` → `schema.prisma:L9316`
- `TpvMessageResponse` → `schema.prisma:L9339`
- `TrainingModule` → `schema.prisma:L9394`
- `TrainingProgress` → `schema.prisma:L9471`
- `TrainingQuizQuestion` → `schema.prisma:L9453`
- `TrainingStep` → `schema.prisma:L9433`
- `TransactionCost` → `schema.prisma:L4782`
- `UnitConversion` → `schema.prisma:L1945`
- `user_sessions` → `schema.prisma:L4168`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L643`
- `VenueChatSession` → `schema.prisma:L598`
- `VenueCommission` → `schema.prisma:L10911`
- `VenueCreditAssessment` → `schema.prisma:L7808`
- `VenueCryptoConfig` → `schema.prisma:L9131`
- `VenueFeature` → `schema.prisma:L3140`
- `VenueModule` → `schema.prisma:L7964`
- `VenuePaymentConfig` → `schema.prisma:L4269`
- `VenuePaymentLinkSettings` → `schema.prisma:L10281`
- `VenuePricingStructure` → `schema.prisma:L4722`
- `VenueRoleConfig` → `schema.prisma:L1128`
- `VenueRolePermission` → `schema.prisma:L1070`
- `VenueSettings` → `schema.prisma:L683`
- `VenueTransaction` → `schema.prisma:L3077`
- `VenueWhatsappActivation` → `schema.prisma:L534`
- `WebhookEvent` → `schema.prisma:L3176`
- `WebhookSubscription` → `schema.prisma:L4385`
- `WhatsappContactWindow` → `schema.prisma:L552`
- `WhatsappInboundEvent` → `schema.prisma:L572`
- `Zone` → `schema.prisma:L96`
