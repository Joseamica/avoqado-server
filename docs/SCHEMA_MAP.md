# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **259 models / 242 enums / ~12,100 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
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
| 8   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderItem`, `OrderItemModifier`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `Shift`                                                                                                                                                                                                                                                                                                                 |
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

- `AccountingPeriodLock` → `schema.prisma:L11493`
- `AccountMapping` → `schema.prisma:L11389`
- `ActivityLog` → `schema.prisma:L5055`
- `Aggregator` → `schema.prisma:L10537`
- `AngelPayUserAccount` → `schema.prisma:L3864`
- `AppUpdate` → `schema.prisma:L8823`
- `Area` → `schema.prisma:L2129`
- `BankStatement` → `schema.prisma:L11263`
- `BankStatementLine` → `schema.prisma:L11284`
- `BillingTaxProfile` → `schema.prisma:L12073`
- `BulkCommandOperation` → `schema.prisma:L7176`
- `CalendarSyncOutbox` → `schema.prisma:L9940`
- `CampaignDelivery` → `schema.prisma:L8981`
- `CashCloseout` → `schema.prisma:L7509`
- `CashDeposit` → `schema.prisma:L8625`
- `CashDrawerEvent` → `schema.prisma:L10383`
- `CashDrawerSession` → `schema.prisma:L10359`
- `CashOutCommissionRate` → `schema.prisma:L11902`
- `CashOutScheduleDay` → `schema.prisma:L11925`
- `CashOutWithdrawal` → `schema.prisma:L11987`
- `Cfdi` → `schema.prisma:L11166`
- `ChatbotTokenBudget` → `schema.prisma:L6824`
- `ChatConversation` → `schema.prisma:L6679`
- `ChatFeedback` → `schema.prisma:L6765`
- `ChatLearningEvent` → `schema.prisma:L6722`
- `ChatMessage` → `schema.prisma:L6702`
- `ChatTrainingData` → `schema.prisma:L6636`
- `CheckoutSession` → `schema.prisma:L4144`
- `ClassSession` → `schema.prisma:L9561`
- `CommissionCalculation` → `schema.prisma:L8404`
- `CommissionClawback` → `schema.prisma:L8577`
- `CommissionConfig` → `schema.prisma:L8177`
- `CommissionMilestone` → `schema.prisma:L8320`
- `CommissionOverride` → `schema.prisma:L8247`
- `CommissionPayout` → `schema.prisma:L8528`
- `CommissionSummary` → `schema.prisma:L8467`
- `CommissionTier` → `schema.prisma:L8284`
- `Consumer` → `schema.prisma:L5176`
- `ConsumerAuthAccount` → `schema.prisma:L5201`
- `CouponCode` → `schema.prisma:L5604`
- `CouponRedemption` → `schema.prisma:L5635`
- `CreditAssessmentHistory` → `schema.prisma:L7618`
- `CreditItemBalance` → `schema.prisma:L10149`
- `CreditOffer` → `schema.prisma:L7637`
- `CreditPack` → `schema.prisma:L10065`
- `CreditPackItem` → `schema.prisma:L10094`
- `CreditPackPurchase` → `schema.prisma:L10111`
- `CreditTransaction` → `schema.prisma:L10171`
- `Customer` → `schema.prisma:L5081`
- `CustomerDiscount` → `schema.prisma:L5655`
- `CustomerGroup` → `schema.prisma:L5235`
- `CustomerTaxProfile` → `schema.prisma:L11235`
- `DeviceToken` → `schema.prisma:L5850`
- `DigitalReceipt` → `schema.prisma:L2958`
- `Discount` → `schema.prisma:L5504`
- `EcommerceMerchant` → `schema.prisma:L3956`
- `EmailTemplate` → `schema.prisma:L8920`
- `Employee` → `schema.prisma:L11750`
- `Estimate` → `schema.prisma:L10444`
- `EstimateItem` → `schema.prisma:L10472`
- `Expense` → `schema.prisma:L11537`
- `ExternalBusyBlock` → `schema.prisma:L9833`
- `Feature` → `schema.prisma:L3087`
- `FeeSchedule` → `schema.prisma:L3165`
- `FeeTier` → `schema.prisma:L3176`
- `FinancialAccount` → `schema.prisma:L10634`
- `FinancialConnection` → `schema.prisma:L10603`
- `FinancialProvider` → `schema.prisma:L10589`
- `FiscalEmisor` → `schema.prisma:L11089`
- `FiscalLossCarryforward` → `schema.prisma:L11660`
- `FixedAsset` → `schema.prisma:L11678`
- `FixedAssetDepreciation` → `schema.prisma:L11707`
- `FloorElement` → `schema.prisma:L2205`
- `GeofenceRule` → `schema.prisma:L7261`
- `GoogleCalendarChannel` → `schema.prisma:L9810`
- `GoogleCalendarConnection` → `schema.prisma:L9762`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9863`
- `GoogleOAuthSession` → `schema.prisma:L9885`
- `HolidayCalendar` → `schema.prisma:L4979`
- `IdempotencyRequest` → `schema.prisma:L8052`
- `Inventory` → `schema.prisma:L1547`
- `InventoryMovement` → `schema.prisma:L1571`
- `InventoryTransfer` → `schema.prisma:L10416`
- `Invitation` → `schema.prisma:L1139`
- `Invoice` → `schema.prisma:L3188`
- `InvoiceItem` → `schema.prisma:L3214`
- `ItemCategory` → `schema.prisma:L7769`
- `JournalEntry` → `schema.prisma:L11447`
- `JournalLine` → `schema.prisma:L11475`
- `KdsOrder` → `schema.prisma:L10682`
- `KdsOrderItem` → `schema.prisma:L10699`
- `LearnedPatterns` → `schema.prisma:L6746`
- `LedgerAccount` → `schema.prisma:L11339`
- `LiveDemoSession` → `schema.prisma:L662`
- `LowStockAlert` → `schema.prisma:L1988`
- `LoyaltyConfig` → `schema.prisma:L5265`
- `LoyaltyTransaction` → `schema.prisma:L5288`
- `MarketingCampaign` → `schema.prisma:L8938`
- `McpAuthCode` → `schema.prisma:L10996`
- `McpOAuthClient` → `schema.prisma:L10980`
- `McpRefreshToken` → `schema.prisma:L11014`
- `MeasurementUnit` → `schema.prisma:L10522`
- `Menu` → `schema.prisma:L1325`
- `MenuCategory` → `schema.prisma:L1262`
- `MenuCategoryAssignment` → `schema.prisma:L1360`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10910`
- `MerchantAccount` → `schema.prisma:L3694`
- `MerchantFiscalConfig` → `schema.prisma:L11137`
- `MerchantRevenueShare` → `schema.prisma:L4559`
- `MerchantRoutingRule` → `schema.prisma:L3816`
- `MilestoneAchievement` → `schema.prisma:L8365`
- `Modifier` → `schema.prisma:L2700`
- `ModifierGroup` → `schema.prisma:L2664`
- `Module` → `schema.prisma:L7685`
- `MoneyAnomaly` → `schema.prisma:L4462`
- `MonthlyVenueProfit` → `schema.prisma:L5005`
- `Notification` → `schema.prisma:L5752`
- `NotificationPreference` → `schema.prisma:L5799`
- `NotificationTemplate` → `schema.prisma:L5826`
- `OAuthState` → `schema.prisma:L1190`
- `OnboardingProgress` → `schema.prisma:L1208`
- `Order` → `schema.prisma:L2429`
- `OrderAction` → `schema.prisma:L2765`
- `OrderCustomer` → `schema.prisma:L2556`
- `OrderDiscount` → `schema.prisma:L5687`
- `OrderItem` → `schema.prisma:L2572`
- `OrderItemModifier` → `schema.prisma:L2749`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8739`
- `OrganizationGoal` → `schema.prisma:L8697`
- `OrganizationModule` → `schema.prisma:L7741`
- `OrganizationPaymentConfig` → `schema.prisma:L4268`
- `OrganizationPayoutConfig` → `schema.prisma:L8772`
- `OrganizationPricingStructure` → `schema.prisma:L4300`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8720`
- `OtpChallenge` → `schema.prisma:L5220`
- `PartnerAPIKey` → `schema.prisma:L4098`
- `Payment` → `schema.prisma:L2798`
- `PaymentAllocation` → `schema.prisma:L2937`
- `PaymentLink` → `schema.prisma:L10217`
- `PaymentLinkAttribution` → `schema.prisma:L10325`
- `PaymentLinkItem` → `schema.prisma:L10280`
- `PaymentLinkItemModifier` → `schema.prisma:L10307`
- `PaymentProvider` → `schema.prisma:L3653`
- `PayrollLine` → `schema.prisma:L11821`
- `PayrollRun` → `schema.prisma:L11790`
- `PerformanceGoal` → `schema.prisma:L8674`
- `PermissionSet` → `schema.prisma:L1090`
- `PlatformCfdi` → `schema.prisma:L12102`
- `PlatformEmisor` → `schema.prisma:L12046`
- `PlatformSettings` → `schema.prisma:L4075`
- `PosCommand` → `schema.prisma:L5880`
- `PosConnectionStatus` → `schema.prisma:L747`
- `PricingPolicy` → `schema.prisma:L1899`
- `Printer` → `schema.prisma:L10728`
- `PrintGateway` → `schema.prisma:L10765`
- `PrintJob` → `schema.prisma:L10812`
- `PrintStation` → `schema.prisma:L10783`
- `ProcessedStripeEvent` → `schema.prisma:L4448`
- `ProcessorReliabilityMetric` → `schema.prisma:L4933`
- `Product` → `schema.prisma:L1378`
- `ProductModifierGroup` → `schema.prisma:L2737`
- `ProductOption` → `schema.prisma:L10499`
- `ProductOptionValue` → `schema.prisma:L10510`
- `PromoterBankAccount` → `schema.prisma:L11941`
- `PromoterCommissionEntry` → `schema.prisma:L11960`
- `PromoterLocationPing` → `schema.prisma:L2395`
- `ProviderCostStructure` → `schema.prisma:L4484`
- `ProviderEventLog` → `schema.prisma:L4377`
- `PurchaseOrder` → `schema.prisma:L1813`
- `PurchaseOrderItem` → `schema.prisma:L1870`
- `RateCorrectionBatch` → `schema.prisma:L4709`
- `RateCorrectionEntry` → `schema.prisma:L4751`
- `RawMaterial` → `schema.prisma:L1601`
- `RawMaterialMovement` → `schema.prisma:L1952`
- `Recipe` → `schema.prisma:L1667`
- `RecipeLine` → `schema.prisma:L1691`
- `Referral` → `schema.prisma:L5352`
- `ReferralProgramConfig` → `schema.prisma:L5317`
- `ReferralRewardGrant` → `schema.prisma:L5443`
- `ReferralTierReward` → `schema.prisma:L5415`
- `ReferralTierUnlock` → `schema.prisma:L5488`
- `Reservation` → `schema.prisma:L9317`
- `ReservationGoogleEventMapping` → `schema.prisma:L9997`
- `ReservationModifier` → `schema.prisma:L9476`
- `ReservationReminderSent` → `schema.prisma:L9459`
- `ReservationSettings` → `schema.prisma:L9637`
- `ReservationWaitlistEntry` → `schema.prisma:L9605`
- `Review` → `schema.prisma:L3232`
- `SalesRetention` → `schema.prisma:L11641`
- `SaleVerification` → `schema.prisma:L2991`
- `ScheduledCommand` → `schema.prisma:L7221`
- `SerializedItem` → `schema.prisma:L7812`
- `SerializedItemCustodyEvent` → `schema.prisma:L7975`
- `SettlementConfiguration` → `schema.prisma:L4784`
- `SettlementConfirmation` → `schema.prisma:L4897`
- `SettlementIncident` → `schema.prisma:L4848`
- `SettlementSimulation` → `schema.prisma:L4819`
- `Shift` → `schema.prisma:L2243`
- `SimRegistrationRequest` → `schema.prisma:L8013`
- `SimRegistrationRequestItem` → `schema.prisma:L8035`
- `SlotHold` → `schema.prisma:L9516`
- `Staff` → `schema.prisma:L767`
- `StaffOnboardingState` → `schema.prisma:L10880`
- `StaffOrganization` → `schema.prisma:L1004`
- `StaffPasskey` → `schema.prisma:L1031`
- `StaffVenue` → `schema.prisma:L940`
- `StockAlertConfig` → `schema.prisma:L8656`
- `StockBatch` → `schema.prisma:L2083`
- `StockCount` → `schema.prisma:L2020`
- `StockCountItem` → `schema.prisma:L2041`
- `StripeWebhookEvent` → `schema.prisma:L4431`
- `Supplier` → `schema.prisma:L1726`
- `SupplierPricing` → `schema.prisma:L1779`
- `Table` → `schema.prisma:L2155`
- `Terminal` → `schema.prisma:L3283`
- `TerminalHealth` → `schema.prisma:L3429`
- `TerminalLog` → `schema.prisma:L3403`
- `TerminalOrder` → `schema.prisma:L3556`
- `TerminalOrderItem` → `schema.prisma:L3631`
- `TerminalPaymentRequest` → `schema.prisma:L3500`
- `TimeEntry` → `schema.prisma:L2308`
- `TimeEntryBreak` → `schema.prisma:L2377`
- `TokenPurchase` → `schema.prisma:L6895`
- `TokenUsageRecord` → `schema.prisma:L6867`
- `TpvCommandHistory` → `schema.prisma:L7127`
- `TpvCommandQueue` → `schema.prisma:L7067`
- `TpvFeedback` → `schema.prisma:L6780`
- `TpvMessage` → `schema.prisma:L9013`
- `TpvMessageDelivery` → `schema.prisma:L9065`
- `TpvMessageResponse` → `schema.prisma:L9088`
- `TrainingModule` → `schema.prisma:L9143`
- `TrainingProgress` → `schema.prisma:L9220`
- `TrainingQuizQuestion` → `schema.prisma:L9202`
- `TrainingStep` → `schema.prisma:L9182`
- `TransactionCost` → `schema.prisma:L4647`
- `UnitConversion` → `schema.prisma:L1930`
- `user_sessions` → `schema.prisma:L4133`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L638`
- `VenueChatSession` → `schema.prisma:L593`
- `VenueCommission` → `schema.prisma:L10660`
- `VenueCreditAssessment` → `schema.prisma:L7557`
- `VenueCryptoConfig` → `schema.prisma:L8880`
- `VenueFeature` → `schema.prisma:L3105`
- `VenueModule` → `schema.prisma:L7713`
- `VenuePaymentConfig` → `schema.prisma:L4234`
- `VenuePaymentLinkSettings` → `schema.prisma:L10030`
- `VenuePricingStructure` → `schema.prisma:L4587`
- `VenueRoleConfig` → `schema.prisma:L1119`
- `VenueRolePermission` → `schema.prisma:L1061`
- `VenueSettings` → `schema.prisma:L678`
- `VenueTransaction` → `schema.prisma:L3042`
- `VenueWhatsappActivation` → `schema.prisma:L529`
- `WebhookEvent` → `schema.prisma:L3141`
- `WebhookSubscription` → `schema.prisma:L4350`
- `WhatsappContactWindow` → `schema.prisma:L547`
- `WhatsappInboundEvent` → `schema.prisma:L567`
- `Zone` → `schema.prisma:L96`
