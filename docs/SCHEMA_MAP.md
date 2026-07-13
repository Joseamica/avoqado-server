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

- `AccountingPeriodLock` → `schema.prisma:L11486`
- `AccountMapping` → `schema.prisma:L11382`
- `ActivityLog` → `schema.prisma:L5048`
- `Aggregator` → `schema.prisma:L10530`
- `AngelPayUserAccount` → `schema.prisma:L3857`
- `AppUpdate` → `schema.prisma:L8816`
- `Area` → `schema.prisma:L2129`
- `BankStatement` → `schema.prisma:L11256`
- `BankStatementLine` → `schema.prisma:L11277`
- `BillingTaxProfile` → `schema.prisma:L12066`
- `BulkCommandOperation` → `schema.prisma:L7169`
- `CalendarSyncOutbox` → `schema.prisma:L9933`
- `CampaignDelivery` → `schema.prisma:L8974`
- `CashCloseout` → `schema.prisma:L7502`
- `CashDeposit` → `schema.prisma:L8618`
- `CashDrawerEvent` → `schema.prisma:L10376`
- `CashDrawerSession` → `schema.prisma:L10352`
- `CashOutCommissionRate` → `schema.prisma:L11895`
- `CashOutScheduleDay` → `schema.prisma:L11918`
- `CashOutWithdrawal` → `schema.prisma:L11980`
- `Cfdi` → `schema.prisma:L11159`
- `ChatbotTokenBudget` → `schema.prisma:L6817`
- `ChatConversation` → `schema.prisma:L6672`
- `ChatFeedback` → `schema.prisma:L6758`
- `ChatLearningEvent` → `schema.prisma:L6715`
- `ChatMessage` → `schema.prisma:L6695`
- `ChatTrainingData` → `schema.prisma:L6629`
- `CheckoutSession` → `schema.prisma:L4137`
- `ClassSession` → `schema.prisma:L9554`
- `CommissionCalculation` → `schema.prisma:L8397`
- `CommissionClawback` → `schema.prisma:L8570`
- `CommissionConfig` → `schema.prisma:L8170`
- `CommissionMilestone` → `schema.prisma:L8313`
- `CommissionOverride` → `schema.prisma:L8240`
- `CommissionPayout` → `schema.prisma:L8521`
- `CommissionSummary` → `schema.prisma:L8460`
- `CommissionTier` → `schema.prisma:L8277`
- `Consumer` → `schema.prisma:L5169`
- `ConsumerAuthAccount` → `schema.prisma:L5194`
- `CouponCode` → `schema.prisma:L5597`
- `CouponRedemption` → `schema.prisma:L5628`
- `CreditAssessmentHistory` → `schema.prisma:L7611`
- `CreditItemBalance` → `schema.prisma:L10142`
- `CreditOffer` → `schema.prisma:L7630`
- `CreditPack` → `schema.prisma:L10058`
- `CreditPackItem` → `schema.prisma:L10087`
- `CreditPackPurchase` → `schema.prisma:L10104`
- `CreditTransaction` → `schema.prisma:L10164`
- `Customer` → `schema.prisma:L5074`
- `CustomerDiscount` → `schema.prisma:L5648`
- `CustomerGroup` → `schema.prisma:L5228`
- `CustomerTaxProfile` → `schema.prisma:L11228`
- `DeviceToken` → `schema.prisma:L5843`
- `DigitalReceipt` → `schema.prisma:L2951`
- `Discount` → `schema.prisma:L5497`
- `EcommerceMerchant` → `schema.prisma:L3949`
- `EmailTemplate` → `schema.prisma:L8913`
- `Employee` → `schema.prisma:L11743`
- `Estimate` → `schema.prisma:L10437`
- `EstimateItem` → `schema.prisma:L10465`
- `Expense` → `schema.prisma:L11530`
- `ExternalBusyBlock` → `schema.prisma:L9826`
- `Feature` → `schema.prisma:L3080`
- `FeeSchedule` → `schema.prisma:L3158`
- `FeeTier` → `schema.prisma:L3169`
- `FinancialAccount` → `schema.prisma:L10627`
- `FinancialConnection` → `schema.prisma:L10596`
- `FinancialProvider` → `schema.prisma:L10582`
- `FiscalEmisor` → `schema.prisma:L11082`
- `FiscalLossCarryforward` → `schema.prisma:L11653`
- `FixedAsset` → `schema.prisma:L11671`
- `FixedAssetDepreciation` → `schema.prisma:L11700`
- `FloorElement` → `schema.prisma:L2205`
- `GeofenceRule` → `schema.prisma:L7254`
- `GoogleCalendarChannel` → `schema.prisma:L9803`
- `GoogleCalendarConnection` → `schema.prisma:L9755`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L9856`
- `GoogleOAuthSession` → `schema.prisma:L9878`
- `HolidayCalendar` → `schema.prisma:L4972`
- `IdempotencyRequest` → `schema.prisma:L8045`
- `Inventory` → `schema.prisma:L1547`
- `InventoryMovement` → `schema.prisma:L1571`
- `InventoryTransfer` → `schema.prisma:L10409`
- `Invitation` → `schema.prisma:L1139`
- `Invoice` → `schema.prisma:L3181`
- `InvoiceItem` → `schema.prisma:L3207`
- `ItemCategory` → `schema.prisma:L7762`
- `JournalEntry` → `schema.prisma:L11440`
- `JournalLine` → `schema.prisma:L11468`
- `KdsOrder` → `schema.prisma:L10675`
- `KdsOrderItem` → `schema.prisma:L10692`
- `LearnedPatterns` → `schema.prisma:L6739`
- `LedgerAccount` → `schema.prisma:L11332`
- `LiveDemoSession` → `schema.prisma:L662`
- `LowStockAlert` → `schema.prisma:L1988`
- `LoyaltyConfig` → `schema.prisma:L5258`
- `LoyaltyTransaction` → `schema.prisma:L5281`
- `MarketingCampaign` → `schema.prisma:L8931`
- `McpAuthCode` → `schema.prisma:L10989`
- `McpOAuthClient` → `schema.prisma:L10973`
- `McpRefreshToken` → `schema.prisma:L11007`
- `MeasurementUnit` → `schema.prisma:L10515`
- `Menu` → `schema.prisma:L1325`
- `MenuCategory` → `schema.prisma:L1262`
- `MenuCategoryAssignment` → `schema.prisma:L1360`
- `MercadoPagoWebhookEvent` → `schema.prisma:L10903`
- `MerchantAccount` → `schema.prisma:L3687`
- `MerchantFiscalConfig` → `schema.prisma:L11130`
- `MerchantRevenueShare` → `schema.prisma:L4552`
- `MerchantRoutingRule` → `schema.prisma:L3809`
- `MilestoneAchievement` → `schema.prisma:L8358`
- `Modifier` → `schema.prisma:L2693`
- `ModifierGroup` → `schema.prisma:L2657`
- `Module` → `schema.prisma:L7678`
- `MoneyAnomaly` → `schema.prisma:L4455`
- `MonthlyVenueProfit` → `schema.prisma:L4998`
- `Notification` → `schema.prisma:L5745`
- `NotificationPreference` → `schema.prisma:L5792`
- `NotificationTemplate` → `schema.prisma:L5819`
- `OAuthState` → `schema.prisma:L1190`
- `OnboardingProgress` → `schema.prisma:L1208`
- `Order` → `schema.prisma:L2429`
- `OrderAction` → `schema.prisma:L2758`
- `OrderCustomer` → `schema.prisma:L2556`
- `OrderDiscount` → `schema.prisma:L5680`
- `OrderItem` → `schema.prisma:L2572`
- `OrderItemModifier` → `schema.prisma:L2742`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L8732`
- `OrganizationGoal` → `schema.prisma:L8690`
- `OrganizationModule` → `schema.prisma:L7734`
- `OrganizationPaymentConfig` → `schema.prisma:L4261`
- `OrganizationPayoutConfig` → `schema.prisma:L8765`
- `OrganizationPricingStructure` → `schema.prisma:L4293`
- `OrganizationSalesGoalConfig` → `schema.prisma:L8713`
- `OtpChallenge` → `schema.prisma:L5213`
- `PartnerAPIKey` → `schema.prisma:L4091`
- `Payment` → `schema.prisma:L2791`
- `PaymentAllocation` → `schema.prisma:L2930`
- `PaymentLink` → `schema.prisma:L10210`
- `PaymentLinkAttribution` → `schema.prisma:L10318`
- `PaymentLinkItem` → `schema.prisma:L10273`
- `PaymentLinkItemModifier` → `schema.prisma:L10300`
- `PaymentProvider` → `schema.prisma:L3646`
- `PayrollLine` → `schema.prisma:L11814`
- `PayrollRun` → `schema.prisma:L11783`
- `PerformanceGoal` → `schema.prisma:L8667`
- `PermissionSet` → `schema.prisma:L1090`
- `PlatformCfdi` → `schema.prisma:L12095`
- `PlatformEmisor` → `schema.prisma:L12039`
- `PlatformSettings` → `schema.prisma:L4068`
- `PosCommand` → `schema.prisma:L5873`
- `PosConnectionStatus` → `schema.prisma:L747`
- `PricingPolicy` → `schema.prisma:L1899`
- `Printer` → `schema.prisma:L10721`
- `PrintGateway` → `schema.prisma:L10758`
- `PrintJob` → `schema.prisma:L10805`
- `PrintStation` → `schema.prisma:L10776`
- `ProcessedStripeEvent` → `schema.prisma:L4441`
- `ProcessorReliabilityMetric` → `schema.prisma:L4926`
- `Product` → `schema.prisma:L1378`
- `ProductModifierGroup` → `schema.prisma:L2730`
- `ProductOption` → `schema.prisma:L10492`
- `ProductOptionValue` → `schema.prisma:L10503`
- `PromoterBankAccount` → `schema.prisma:L11934`
- `PromoterCommissionEntry` → `schema.prisma:L11953`
- `PromoterLocationPing` → `schema.prisma:L2395`
- `ProviderCostStructure` → `schema.prisma:L4477`
- `ProviderEventLog` → `schema.prisma:L4370`
- `PurchaseOrder` → `schema.prisma:L1813`
- `PurchaseOrderItem` → `schema.prisma:L1870`
- `RateCorrectionBatch` → `schema.prisma:L4702`
- `RateCorrectionEntry` → `schema.prisma:L4744`
- `RawMaterial` → `schema.prisma:L1601`
- `RawMaterialMovement` → `schema.prisma:L1952`
- `Recipe` → `schema.prisma:L1667`
- `RecipeLine` → `schema.prisma:L1691`
- `Referral` → `schema.prisma:L5345`
- `ReferralProgramConfig` → `schema.prisma:L5310`
- `ReferralRewardGrant` → `schema.prisma:L5436`
- `ReferralTierReward` → `schema.prisma:L5408`
- `ReferralTierUnlock` → `schema.prisma:L5481`
- `Reservation` → `schema.prisma:L9310`
- `ReservationGoogleEventMapping` → `schema.prisma:L9990`
- `ReservationModifier` → `schema.prisma:L9469`
- `ReservationReminderSent` → `schema.prisma:L9452`
- `ReservationSettings` → `schema.prisma:L9630`
- `ReservationWaitlistEntry` → `schema.prisma:L9598`
- `Review` → `schema.prisma:L3225`
- `SalesRetention` → `schema.prisma:L11634`
- `SaleVerification` → `schema.prisma:L2984`
- `ScheduledCommand` → `schema.prisma:L7214`
- `SerializedItem` → `schema.prisma:L7805`
- `SerializedItemCustodyEvent` → `schema.prisma:L7968`
- `SettlementConfiguration` → `schema.prisma:L4777`
- `SettlementConfirmation` → `schema.prisma:L4890`
- `SettlementIncident` → `schema.prisma:L4841`
- `SettlementSimulation` → `schema.prisma:L4812`
- `Shift` → `schema.prisma:L2243`
- `SimRegistrationRequest` → `schema.prisma:L8006`
- `SimRegistrationRequestItem` → `schema.prisma:L8028`
- `SlotHold` → `schema.prisma:L9509`
- `Staff` → `schema.prisma:L767`
- `StaffOnboardingState` → `schema.prisma:L10873`
- `StaffOrganization` → `schema.prisma:L1004`
- `StaffPasskey` → `schema.prisma:L1031`
- `StaffVenue` → `schema.prisma:L940`
- `StockAlertConfig` → `schema.prisma:L8649`
- `StockBatch` → `schema.prisma:L2083`
- `StockCount` → `schema.prisma:L2020`
- `StockCountItem` → `schema.prisma:L2041`
- `StripeWebhookEvent` → `schema.prisma:L4424`
- `Supplier` → `schema.prisma:L1726`
- `SupplierPricing` → `schema.prisma:L1779`
- `Table` → `schema.prisma:L2155`
- `Terminal` → `schema.prisma:L3276`
- `TerminalHealth` → `schema.prisma:L3422`
- `TerminalLog` → `schema.prisma:L3396`
- `TerminalOrder` → `schema.prisma:L3549`
- `TerminalOrderItem` → `schema.prisma:L3624`
- `TerminalPaymentRequest` → `schema.prisma:L3493`
- `TimeEntry` → `schema.prisma:L2308`
- `TimeEntryBreak` → `schema.prisma:L2377`
- `TokenPurchase` → `schema.prisma:L6888`
- `TokenUsageRecord` → `schema.prisma:L6860`
- `TpvCommandHistory` → `schema.prisma:L7120`
- `TpvCommandQueue` → `schema.prisma:L7060`
- `TpvFeedback` → `schema.prisma:L6773`
- `TpvMessage` → `schema.prisma:L9006`
- `TpvMessageDelivery` → `schema.prisma:L9058`
- `TpvMessageResponse` → `schema.prisma:L9081`
- `TrainingModule` → `schema.prisma:L9136`
- `TrainingProgress` → `schema.prisma:L9213`
- `TrainingQuizQuestion` → `schema.prisma:L9195`
- `TrainingStep` → `schema.prisma:L9175`
- `TransactionCost` → `schema.prisma:L4640`
- `UnitConversion` → `schema.prisma:L1930`
- `user_sessions` → `schema.prisma:L4126`
- `Venue` → `schema.prisma:L113`
- `VenueChatMessage` → `schema.prisma:L638`
- `VenueChatSession` → `schema.prisma:L593`
- `VenueCommission` → `schema.prisma:L10653`
- `VenueCreditAssessment` → `schema.prisma:L7550`
- `VenueCryptoConfig` → `schema.prisma:L8873`
- `VenueFeature` → `schema.prisma:L3098`
- `VenueModule` → `schema.prisma:L7706`
- `VenuePaymentConfig` → `schema.prisma:L4227`
- `VenuePaymentLinkSettings` → `schema.prisma:L10023`
- `VenuePricingStructure` → `schema.prisma:L4580`
- `VenueRoleConfig` → `schema.prisma:L1119`
- `VenueRolePermission` → `schema.prisma:L1061`
- `VenueSettings` → `schema.prisma:L678`
- `VenueTransaction` → `schema.prisma:L3035`
- `VenueWhatsappActivation` → `schema.prisma:L529`
- `WebhookEvent` → `schema.prisma:L3134`
- `WebhookSubscription` → `schema.prisma:L4343`
- `WhatsappContactWindow` → `schema.prisma:L547`
- `WhatsappInboundEvent` → `schema.prisma:L567`
- `Zone` → `schema.prisma:L96`
