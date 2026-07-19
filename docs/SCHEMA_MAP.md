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

- `AccountingPeriodLock` → `schema.prisma:L11725`
- `AccountMapping` → `schema.prisma:L11621`
- `ActivityLog` → `schema.prisma:L5174`
- `Aggregator` → `schema.prisma:L10769`
- `AngelPayUserAccount` → `schema.prisma:L3895`
- `AppUpdate` → `schema.prisma:L9055`
- `Area` → `schema.prisma:L2144`
- `BankStatement` → `schema.prisma:L11495`
- `BankStatementLine` → `schema.prisma:L11516`
- `BillingTaxProfile` → `schema.prisma:L12305`
- `BulkCommandOperation` → `schema.prisma:L7408`
- `CalendarSyncOutbox` → `schema.prisma:L10172`
- `CampaignDelivery` → `schema.prisma:L9213`
- `CashCloseout` → `schema.prisma:L7741`
- `CashDeposit` → `schema.prisma:L8857`
- `CashDrawerEvent` → `schema.prisma:L10615`
- `CashDrawerSession` → `schema.prisma:L10591`
- `CashOutCommissionRate` → `schema.prisma:L12134`
- `CashOutScheduleDay` → `schema.prisma:L12157`
- `CashOutWithdrawal` → `schema.prisma:L12219`
- `Cfdi` → `schema.prisma:L11398`
- `ChatbotTokenBudget` → `schema.prisma:L7056`
- `ChatConversation` → `schema.prisma:L6911`
- `ChatFeedback` → `schema.prisma:L6997`
- `ChatLearningEvent` → `schema.prisma:L6954`
- `ChatMessage` → `schema.prisma:L6934`
- `ChatTrainingData` → `schema.prisma:L6868`
- `CheckoutSession` → `schema.prisma:L4175`
- `ClassSession` → `schema.prisma:L9793`
- `CommissionCalculation` → `schema.prisma:L8636`
- `CommissionClawback` → `schema.prisma:L8809`
- `CommissionConfig` → `schema.prisma:L8409`
- `CommissionMilestone` → `schema.prisma:L8552`
- `CommissionOverride` → `schema.prisma:L8479`
- `CommissionPayout` → `schema.prisma:L8760`
- `CommissionSummary` → `schema.prisma:L8699`
- `CommissionTier` → `schema.prisma:L8516`
- `Consumer` → `schema.prisma:L5295`
- `ConsumerAuthAccount` → `schema.prisma:L5320`
- `CouponCode` → `schema.prisma:L5726`
- `CouponRedemption` → `schema.prisma:L5757`
- `CreditAssessmentHistory` → `schema.prisma:L7850`
- `CreditItemBalance` → `schema.prisma:L10381`
- `CreditOffer` → `schema.prisma:L7869`
- `CreditPack` → `schema.prisma:L10297`
- `CreditPackItem` → `schema.prisma:L10326`
- `CreditPackPurchase` → `schema.prisma:L10343`
- `CreditTransaction` → `schema.prisma:L10403`
- `Customer` → `schema.prisma:L5200`
- `CustomerDiscount` → `schema.prisma:L5777`
- `CustomerGroup` → `schema.prisma:L5354`
- `CustomerTaxProfile` → `schema.prisma:L11467`
- `DeliveryActivationRequest` → `schema.prisma:L4497`
- `DeliveryChannelLink` → `schema.prisma:L4461`
- `DeliveryOrderEvent` → `schema.prisma:L4521`
- `DeviceToken` → `schema.prisma:L6043`
- `DigitalReceipt` → `schema.prisma:L2989`
- `Discount` → `schema.prisma:L5626`
- `EcommerceMerchant` → `schema.prisma:L3987`
- `EmailTemplate` → `schema.prisma:L9152`
- `Employee` → `schema.prisma:L11982`
- `Estimate` → `schema.prisma:L10676`
- `EstimateItem` → `schema.prisma:L10704`
- `Expense` → `schema.prisma:L11769`
- `ExternalBusyBlock` → `schema.prisma:L10065`
- `Feature` → `schema.prisma:L3118`
- `FeeSchedule` → `schema.prisma:L3196`
- `FeeTier` → `schema.prisma:L3207`
- `FinancialAccount` → `schema.prisma:L10866`
- `FinancialConnection` → `schema.prisma:L10835`
- `FinancialProvider` → `schema.prisma:L10821`
- `FiscalEmisor` → `schema.prisma:L11321`
- `FiscalLossCarryforward` → `schema.prisma:L11892`
- `FixedAsset` → `schema.prisma:L11910`
- `FixedAssetDepreciation` → `schema.prisma:L11939`
- `FloorElement` → `schema.prisma:L2220`
- `GeofenceRule` → `schema.prisma:L7493`
- `GoogleCalendarChannel` → `schema.prisma:L10042`
- `GoogleCalendarConnection` → `schema.prisma:L9994`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L10095`
- `GoogleOAuthSession` → `schema.prisma:L10117`
- `HolidayCalendar` → `schema.prisma:L5098`
- `IdempotencyRequest` → `schema.prisma:L8284`
- `Inventory` → `schema.prisma:L1562`
- `InventoryMovement` → `schema.prisma:L1586`
- `InventoryTransfer` → `schema.prisma:L10648`
- `Invitation` → `schema.prisma:L1148`
- `Invoice` → `schema.prisma:L3219`
- `InvoiceItem` → `schema.prisma:L3245`
- `ItemCategory` → `schema.prisma:L8001`
- `JournalEntry` → `schema.prisma:L11679`
- `JournalLine` → `schema.prisma:L11707`
- `KdsOrder` → `schema.prisma:L10914`
- `KdsOrderItem` → `schema.prisma:L10931`
- `LearnedPatterns` → `schema.prisma:L6978`
- `LedgerAccount` → `schema.prisma:L11571`
- `LiveDemoSession` → `schema.prisma:L667`
- `LowStockAlert` → `schema.prisma:L2003`
- `LoyaltyConfig` → `schema.prisma:L5384`
- `LoyaltyTransaction` → `schema.prisma:L5407`
- `MarketingCampaign` → `schema.prisma:L9170`
- `McpAuthCode` → `schema.prisma:L11228`
- `McpOAuthClient` → `schema.prisma:L11212`
- `McpRefreshToken` → `schema.prisma:L11246`
- `MeasurementUnit` → `schema.prisma:L10754`
- `Menu` → `schema.prisma:L1334`
- `MenuCategory` → `schema.prisma:L1271`
- `MenuCategoryAssignment` → `schema.prisma:L1369`
- `MercadoPagoWebhookEvent` → `schema.prisma:L11142`
- `MerchantAccount` → `schema.prisma:L3725`
- `MerchantFiscalConfig` → `schema.prisma:L11369`
- `MerchantRevenueShare` → `schema.prisma:L4678`
- `MerchantRoutingRule` → `schema.prisma:L3847`
- `MilestoneAchievement` → `schema.prisma:L8597`
- `Modifier` → `schema.prisma:L2731`
- `ModifierGroup` → `schema.prisma:L2695`
- `Module` → `schema.prisma:L7917`
- `MoneyAnomaly` → `schema.prisma:L4581`
- `MonthlyVenueProfit` → `schema.prisma:L5124`
- `Notification` → `schema.prisma:L5945`
- `NotificationPreference` → `schema.prisma:L5992`
- `NotificationTemplate` → `schema.prisma:L6019`
- `OAuthState` → `schema.prisma:L1199`
- `OnboardingProgress` → `schema.prisma:L1217`
- `Order` → `schema.prisma:L2444`
- `OrderAction` → `schema.prisma:L2796`
- `OrderCustomer` → `schema.prisma:L2576`
- `OrderDiscount` → `schema.prisma:L5809`
- `OrderItem` → `schema.prisma:L2592`
- `OrderItemModifier` → `schema.prisma:L2780`
- `OrderServiceCharge` → `schema.prisma:L5893`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8971`
- `OrganizationGoal` → `schema.prisma:L8929`
- `OrganizationModule` → `schema.prisma:L7973`
- `OrganizationPaymentConfig` → `schema.prisma:L4299`
- `OrganizationPayoutConfig` → `schema.prisma:L9004`
- `OrganizationPricingStructure` → `schema.prisma:L4331`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8952`
- `OtpChallenge` → `schema.prisma:L5339`
- `PartnerAPIKey` → `schema.prisma:L4129`
- `Payment` → `schema.prisma:L2829`
- `PaymentAllocation` → `schema.prisma:L2968`
- `PaymentLink` → `schema.prisma:L10449`
- `PaymentLinkAttribution` → `schema.prisma:L10557`
- `PaymentLinkItem` → `schema.prisma:L10512`
- `PaymentLinkItemModifier` → `schema.prisma:L10539`
- `PaymentProvider` → `schema.prisma:L3684`
- `PayrollLine` → `schema.prisma:L12053`
- `PayrollRun` → `schema.prisma:L12022`
- `PerformanceGoal` → `schema.prisma:L8906`
- `PermissionSet` → `schema.prisma:L1099`
- `PlatformCfdi` → `schema.prisma:L12334`
- `PlatformEmisor` → `schema.prisma:L12278`
- `PlatformSettings` → `schema.prisma:L4106`
- `PosCommand` → `schema.prisma:L6073`
- `PosConnectionStatus` → `schema.prisma:L752`
- `PricingPolicy` → `schema.prisma:L1914`
- `Printer` → `schema.prisma:L10960`
- `PrintGateway` → `schema.prisma:L10997`
- `PrintJob` → `schema.prisma:L11044`
- `PrintStation` → `schema.prisma:L11015`
- `ProcessedStripeEvent` → `schema.prisma:L4567`
- `ProcessorReliabilityMetric` → `schema.prisma:L5052`
- `Product` → `schema.prisma:L1387`
- `ProductModifierGroup` → `schema.prisma:L2768`
- `ProductOption` → `schema.prisma:L10731`
- `ProductOptionValue` → `schema.prisma:L10742`
- `PromoterBankAccount` → `schema.prisma:L12173`
- `PromoterCommissionEntry` → `schema.prisma:L12192`
- `PromoterLocationPing` → `schema.prisma:L2410`
- `ProviderCostStructure` → `schema.prisma:L4603`
- `ProviderEventLog` → `schema.prisma:L4408`
- `PurchaseOrder` → `schema.prisma:L1828`
- `PurchaseOrderItem` → `schema.prisma:L1885`
- `RateCorrectionBatch` → `schema.prisma:L4828`
- `RateCorrectionEntry` → `schema.prisma:L4870`
- `RawMaterial` → `schema.prisma:L1616`
- `RawMaterialMovement` → `schema.prisma:L1967`
- `Recipe` → `schema.prisma:L1682`
- `RecipeLine` → `schema.prisma:L1706`
- `Referral` → `schema.prisma:L5474`
- `ReferralProgramConfig` → `schema.prisma:L5439`
- `ReferralRewardGrant` → `schema.prisma:L5565`
- `ReferralTierReward` → `schema.prisma:L5537`
- `ReferralTierUnlock` → `schema.prisma:L5610`
- `Reservation` → `schema.prisma:L9549`
- `ReservationGoogleEventMapping` → `schema.prisma:L10229`
- `ReservationModifier` → `schema.prisma:L9708`
- `ReservationReminderSent` → `schema.prisma:L9691`
- `ReservationSettings` → `schema.prisma:L9869`
- `ReservationWaitlistEntry` → `schema.prisma:L9837`
- `Review` → `schema.prisma:L3263`
- `SalesRetention` → `schema.prisma:L11873`
- `SaleVerification` → `schema.prisma:L3022`
- `ScheduledCommand` → `schema.prisma:L7453`
- `SerializedItem` → `schema.prisma:L8044`
- `SerializedItemCustodyEvent` → `schema.prisma:L8207`
- `ServiceCharge` → `schema.prisma:L5864`
- `SettlementConfiguration` → `schema.prisma:L4903`
- `SettlementConfirmation` → `schema.prisma:L5016`
- `SettlementIncident` → `schema.prisma:L4967`
- `SettlementSimulation` → `schema.prisma:L4938`
- `Shift` → `schema.prisma:L2258`
- `SimRegistrationRequest` → `schema.prisma:L8245`
- `SimRegistrationRequestItem` → `schema.prisma:L8267`
- `SlotHold` → `schema.prisma:L9748`
- `Staff` → `schema.prisma:L772`
- `StaffOnboardingState` → `schema.prisma:L11112`
- `StaffOrganization` → `schema.prisma:L1013`
- `StaffPasskey` → `schema.prisma:L1040`
- `StaffVenue` → `schema.prisma:L948`
- `StockAlertConfig` → `schema.prisma:L8888`
- `StockBatch` → `schema.prisma:L2098`
- `StockCount` → `schema.prisma:L2035`
- `StockCountItem` → `schema.prisma:L2056`
- `StripeWebhookEvent` → `schema.prisma:L4550`
- `Supplier` → `schema.prisma:L1741`
- `SupplierPricing` → `schema.prisma:L1794`
- `Table` → `schema.prisma:L2170`
- `Terminal` → `schema.prisma:L3314`
- `TerminalHealth` → `schema.prisma:L3460`
- `TerminalLog` → `schema.prisma:L3434`
- `TerminalOrder` → `schema.prisma:L3587`
- `TerminalOrderItem` → `schema.prisma:L3662`
- `TerminalPaymentRequest` → `schema.prisma:L3531`
- `TimeEntry` → `schema.prisma:L2323`
- `TimeEntryBreak` → `schema.prisma:L2392`
- `TokenPurchase` → `schema.prisma:L7127`
- `TokenUsageRecord` → `schema.prisma:L7099`
- `TpvCommandHistory` → `schema.prisma:L7359`
- `TpvCommandQueue` → `schema.prisma:L7299`
- `TpvFeedback` → `schema.prisma:L7012`
- `TpvMessage` → `schema.prisma:L9245`
- `TpvMessageDelivery` → `schema.prisma:L9297`
- `TpvMessageResponse` → `schema.prisma:L9320`
- `TrainingModule` → `schema.prisma:L9375`
- `TrainingProgress` → `schema.prisma:L9452`
- `TrainingQuizQuestion` → `schema.prisma:L9434`
- `TrainingStep` → `schema.prisma:L9414`
- `TransactionCost` → `schema.prisma:L4766`
- `UnitConversion` → `schema.prisma:L1945`
- `user_sessions` → `schema.prisma:L4164`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L643`
- `VenueChatSession` → `schema.prisma:L598`
- `VenueCommission` → `schema.prisma:L10892`
- `VenueCreditAssessment` → `schema.prisma:L7789`
- `VenueCryptoConfig` → `schema.prisma:L9112`
- `VenueFeature` → `schema.prisma:L3136`
- `VenueModule` → `schema.prisma:L7945`
- `VenuePaymentConfig` → `schema.prisma:L4265`
- `VenuePaymentLinkSettings` → `schema.prisma:L10262`
- `VenuePricingStructure` → `schema.prisma:L4706`
- `VenueRoleConfig` → `schema.prisma:L1128`
- `VenueRolePermission` → `schema.prisma:L1070`
- `VenueSettings` → `schema.prisma:L683`
- `VenueTransaction` → `schema.prisma:L3073`
- `VenueWhatsappActivation` → `schema.prisma:L534`
- `WebhookEvent` → `schema.prisma:L3172`
- `WebhookSubscription` → `schema.prisma:L4381`
- `WhatsappContactWindow` → `schema.prisma:L552`
- `WhatsappInboundEvent` → `schema.prisma:L572`
- `Zone` → `schema.prisma:L96`
