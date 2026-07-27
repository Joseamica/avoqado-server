# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **277 models / 252 enums / ~12,800 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L12096`
- `AccountMapping` → `schema.prisma:L11992`
- `ActivityLog` → `schema.prisma:L5429`
- `Aggregator` → `schema.prisma:L11116`
- `AngelPayUserAccount` → `schema.prisma:L4138`
- `AppUpdate` → `schema.prisma:L9345`
- `Area` → `schema.prisma:L2383`
- `BankStatement` → `schema.prisma:L11866`
- `BankStatementLine` → `schema.prisma:L11887`
- `BillingTaxProfile` → `schema.prisma:L12676`
- `BulkCommandOperation` → `schema.prisma:L7666`
- `CalendarSyncOutbox` → `schema.prisma:L10519`
- `CampaignDelivery` → `schema.prisma:L9503`
- `CashCloseout` → `schema.prisma:L8031`
- `CashDeposit` → `schema.prisma:L9147`
- `CashDrawerEvent` → `schema.prisma:L10962`
- `CashDrawerSession` → `schema.prisma:L10938`
- `CashOutCommissionRate` → `schema.prisma:L12505`
- `CashOutScheduleDay` → `schema.prisma:L12528`
- `CashOutWithdrawal` → `schema.prisma:L12590`
- `Cfdi` → `schema.prisma:L11769`
- `ChatbotTokenBudget` → `schema.prisma:L7314`
- `ChatConversation` → `schema.prisma:L7169`
- `ChatFeedback` → `schema.prisma:L7255`
- `ChatLearningEvent` → `schema.prisma:L7212`
- `ChatMessage` → `schema.prisma:L7192`
- `ChatTrainingData` → `schema.prisma:L7126`
- `CheckoutSession` → `schema.prisma:L4418`
- `ClassSession` → `schema.prisma:L10137`
- `CommissionCalculation` → `schema.prisma:L8926`
- `CommissionClawback` → `schema.prisma:L9099`
- `CommissionConfig` → `schema.prisma:L8699`
- `CommissionMilestone` → `schema.prisma:L8842`
- `CommissionOverride` → `schema.prisma:L8769`
- `CommissionPayout` → `schema.prisma:L9050`
- `CommissionSummary` → `schema.prisma:L8989`
- `CommissionTier` → `schema.prisma:L8806`
- `Consumer` → `schema.prisma:L5550`
- `ConsumerAuthAccount` → `schema.prisma:L5575`
- `CouponCode` → `schema.prisma:L5981`
- `CouponRedemption` → `schema.prisma:L6012`
- `CreditAssessmentHistory` → `schema.prisma:L8140`
- `CreditItemBalance` → `schema.prisma:L10728`
- `CreditOffer` → `schema.prisma:L8159`
- `CreditPack` → `schema.prisma:L10644`
- `CreditPackItem` → `schema.prisma:L10673`
- `CreditPackPurchase` → `schema.prisma:L10690`
- `CreditTransaction` → `schema.prisma:L10750`
- `Customer` → `schema.prisma:L5455`
- `CustomerDiscount` → `schema.prisma:L6032`
- `CustomerGroup` → `schema.prisma:L5609`
- `CustomerTaxProfile` → `schema.prisma:L11838`
- `DeliveryActivationRequest` → `schema.prisma:L4740`
- `DeliveryChannelLink` → `schema.prisma:L4704`
- `DeliveryOrderEvent` → `schema.prisma:L4764`
- `DeviceToken` → `schema.prisma:L6301`
- `DigitalReceipt` → `schema.prisma:L3232`
- `Discount` → `schema.prisma:L5881`
- `EcommerceMerchant` → `schema.prisma:L4230`
- `EmailTemplate` → `schema.prisma:L9442`
- `Employee` → `schema.prisma:L12353`
- `Estimate` → `schema.prisma:L11023`
- `EstimateItem` → `schema.prisma:L11051`
- `Expense` → `schema.prisma:L12140`
- `ExternalBusyBlock` → `schema.prisma:L10412`
- `Feature` → `schema.prisma:L3361`
- `FeeSchedule` → `schema.prisma:L3439`
- `FeeTier` → `schema.prisma:L3450`
- `FinancialAccount` → `schema.prisma:L11213`
- `FinancialConnection` → `schema.prisma:L11182`
- `FinancialProvider` → `schema.prisma:L11168`
- `FiscalEmisor` → `schema.prisma:L11692`
- `FiscalLossCarryforward` → `schema.prisma:L12263`
- `FixedAsset` → `schema.prisma:L12281`
- `FixedAssetDepreciation` → `schema.prisma:L12310`
- `FloorElement` → `schema.prisma:L2459`
- `GeofenceRule` → `schema.prisma:L7751`
- `GoogleCalendarChannel` → `schema.prisma:L10389`
- `GoogleCalendarConnection` → `schema.prisma:L10341`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L10442`
- `GoogleOAuthSession` → `schema.prisma:L10464`
- `HolidayCalendar` → `schema.prisma:L5353`
- `IdempotencyRequest` → `schema.prisma:L8574`
- `InterVenueTransfer` → `schema.prisma:L2211`
- `InterVenueTransferAllocation` → `schema.prisma:L2294`
- `InterVenueTransferItem` → `schema.prisma:L2263`
- `InterVenueTransferReceipt` → `schema.prisma:L2321`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2337`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2365`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2349`
- `Inventory` → `schema.prisma:L1584`
- `InventoryMovement` → `schema.prisma:L1611`
- `InventoryTransfer` → `schema.prisma:L10995`
- `Invitation` → `schema.prisma:L1169`
- `Invoice` → `schema.prisma:L3462`
- `InvoiceItem` → `schema.prisma:L3488`
- `ItemCategory` → `schema.prisma:L8291`
- `JournalEntry` → `schema.prisma:L12050`
- `JournalLine` → `schema.prisma:L12078`
- `KdsOrder` → `schema.prisma:L11261`
- `KdsOrderItem` → `schema.prisma:L11278`
- `LearnedPatterns` → `schema.prisma:L7236`
- `LedgerAccount` → `schema.prisma:L11942`
- `LiveDemoSession` → `schema.prisma:L675`
- `LowStockAlert` → `schema.prisma:L2065`
- `LoyaltyConfig` → `schema.prisma:L5639`
- `LoyaltyTransaction` → `schema.prisma:L5662`
- `MarketingCampaign` → `schema.prisma:L9460`
- `McpAuthCode` → `schema.prisma:L11575`
- `McpOAuthClient` → `schema.prisma:L11559`
- `McpRefreshToken` → `schema.prisma:L11593`
- `McpToolCall` → `schema.prisma:L11614`
- `MeasurementUnit` → `schema.prisma:L11101`
- `Menu` → `schema.prisma:L1355`
- `MenuCategory` → `schema.prisma:L1292`
- `MenuCategoryAssignment` → `schema.prisma:L1390`
- `MercadoPagoWebhookEvent` → `schema.prisma:L11489`
- `MerchantAccount` → `schema.prisma:L3968`
- `MerchantFiscalConfig` → `schema.prisma:L11740`
- `MerchantRevenueShare` → `schema.prisma:L4933`
- `MerchantRoutingRule` → `schema.prisma:L4090`
- `MilestoneAchievement` → `schema.prisma:L8887`
- `Modifier` → `schema.prisma:L2974`
- `ModifierGroup` → `schema.prisma:L2938`
- `Module` → `schema.prisma:L8207`
- `MoneyAnomaly` → `schema.prisma:L4836`
- `MonthlyVenueProfit` → `schema.prisma:L5379`
- `Notification` → `schema.prisma:L6203`
- `NotificationPreference` → `schema.prisma:L6250`
- `NotificationTemplate` → `schema.prisma:L6277`
- `OAuthState` → `schema.prisma:L1220`
- `OnboardingProgress` → `schema.prisma:L1238`
- `Order` → `schema.prisma:L2683`
- `OrderAction` → `schema.prisma:L3039`
- `OrderCustomer` → `schema.prisma:L2819`
- `OrderDiscount` → `schema.prisma:L6064`
- `OrderItem` → `schema.prisma:L2835`
- `OrderItemModifier` → `schema.prisma:L3023`
- `OrderServiceCharge` → `schema.prisma:L6148`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L9261`
- `OrganizationGoal` → `schema.prisma:L9219`
- `OrganizationModule` → `schema.prisma:L8263`
- `OrganizationPaymentConfig` → `schema.prisma:L4542`
- `OrganizationPayoutConfig` → `schema.prisma:L9294`
- `OrganizationPricingStructure` → `schema.prisma:L4574`
- `OrganizationSalesGoalConfig` → `schema.prisma:L9242`
- `OtpChallenge` → `schema.prisma:L5594`
- `PartnerAPIKey` → `schema.prisma:L4372`
- `Payment` → `schema.prisma:L3072`
- `PaymentAllocation` → `schema.prisma:L3211`
- `PaymentLink` → `schema.prisma:L10796`
- `PaymentLinkAttribution` → `schema.prisma:L10904`
- `PaymentLinkItem` → `schema.prisma:L10859`
- `PaymentLinkItemModifier` → `schema.prisma:L10886`
- `PaymentProvider` → `schema.prisma:L3927`
- `PayrollLine` → `schema.prisma:L12424`
- `PayrollRun` → `schema.prisma:L12393`
- `PerformanceGoal` → `schema.prisma:L9196`
- `PermissionSet` → `schema.prisma:L1120`
- `PlatformCfdi` → `schema.prisma:L12705`
- `PlatformEmisor` → `schema.prisma:L12649`
- `PlatformSettings` → `schema.prisma:L4349`
- `PosCommand` → `schema.prisma:L6331`
- `PosConnectionStatus` → `schema.prisma:L767`
- `PosSyncIntent` → `schema.prisma:L12783`
- `PricingPolicy` → `schema.prisma:L1976`
- `Printer` → `schema.prisma:L11307`
- `PrintGateway` → `schema.prisma:L11344`
- `PrintJob` → `schema.prisma:L11391`
- `PrintStation` → `schema.prisma:L11362`
- `ProcessedStripeEvent` → `schema.prisma:L4822`
- `ProcessorReliabilityMetric` → `schema.prisma:L5307`
- `Product` → `schema.prisma:L1408`
- `ProductModifierGroup` → `schema.prisma:L3011`
- `ProductOption` → `schema.prisma:L11078`
- `ProductOptionValue` → `schema.prisma:L11089`
- `ProductStaff` → `schema.prisma:L10052`
- `PromoterBankAccount` → `schema.prisma:L12544`
- `PromoterCommissionEntry` → `schema.prisma:L12563`
- `PromoterLocationPing` → `schema.prisma:L2649`
- `ProviderCostStructure` → `schema.prisma:L4858`
- `ProviderEventLog` → `schema.prisma:L4651`
- `PurchaseOrder` → `schema.prisma:L1883`
- `PurchaseOrderItem` → `schema.prisma:L1940`
- `RateCorrectionBatch` → `schema.prisma:L5083`
- `RateCorrectionEntry` → `schema.prisma:L5125`
- `RawMaterial` → `schema.prisma:L1644`
- `RawMaterialMovement` → `schema.prisma:L2029`
- `RawMaterialPresentation` → `schema.prisma:L1717`
- `Recipe` → `schema.prisma:L1737`
- `RecipeLine` → `schema.prisma:L1761`
- `Referral` → `schema.prisma:L5729`
- `ReferralProgramConfig` → `schema.prisma:L5694`
- `ReferralRewardGrant` → `schema.prisma:L5820`
- `ReferralTierReward` → `schema.prisma:L5792`
- `ReferralTierUnlock` → `schema.prisma:L5865`
- `Reservation` → `schema.prisma:L9839`
- `ReservationGoogleEventMapping` → `schema.prisma:L10576`
- `ReservationModifier` → `schema.prisma:L10000`
- `ReservationReminderSent` → `schema.prisma:L9983`
- `ReservationSettings` → `schema.prisma:L10214`
- `ReservationWaitlistEntry` → `schema.prisma:L10182`
- `Review` → `schema.prisma:L3506`
- `SalesRetention` → `schema.prisma:L12244`
- `SaleVerification` → `schema.prisma:L3265`
- `ScheduledCommand` → `schema.prisma:L7711`
- `SerializedItem` → `schema.prisma:L8334`
- `SerializedItemCustodyEvent` → `schema.prisma:L8497`
- `ServiceCharge` → `schema.prisma:L6119`
- `SettlementConfiguration` → `schema.prisma:L5158`
- `SettlementConfirmation` → `schema.prisma:L5271`
- `SettlementIncident` → `schema.prisma:L5222`
- `SettlementSimulation` → `schema.prisma:L5193`
- `Shift` → `schema.prisma:L2497`
- `SimRegistrationRequest` → `schema.prisma:L8535`
- `SimRegistrationRequestItem` → `schema.prisma:L8557`
- `SlotHold` → `schema.prisma:L10083`
- `Staff` → `schema.prisma:L787`
- `StaffOnboardingState` → `schema.prisma:L11459`
- `StaffOrganization` → `schema.prisma:L1034`
- `StaffPasskey` → `schema.prisma:L1061`
- `StaffSchedule` → `schema.prisma:L10023`
- `StaffScheduleException` → `schema.prisma:L10035`
- `StaffVenue` → `schema.prisma:L964`
- `StockAlertConfig` → `schema.prisma:L9178`
- `StockBatch` → `schema.prisma:L2160`
- `StockCount` → `schema.prisma:L2097`
- `StockCountItem` → `schema.prisma:L2118`
- `StripeWebhookEvent` → `schema.prisma:L4805`
- `Supplier` → `schema.prisma:L1796`
- `SupplierPricing` → `schema.prisma:L1849`
- `Table` → `schema.prisma:L2409`
- `Terminal` → `schema.prisma:L3557`
- `TerminalHealth` → `schema.prisma:L3703`
- `TerminalLog` → `schema.prisma:L3677`
- `TerminalOrder` → `schema.prisma:L3830`
- `TerminalOrderItem` → `schema.prisma:L3905`
- `TerminalPaymentRequest` → `schema.prisma:L3774`
- `TimeEntry` → `schema.prisma:L2562`
- `TimeEntryBreak` → `schema.prisma:L2631`
- `TokenPurchase` → `schema.prisma:L7385`
- `TokenUsageRecord` → `schema.prisma:L7357`
- `TpvCommandHistory` → `schema.prisma:L7617`
- `TpvCommandQueue` → `schema.prisma:L7557`
- `TpvFeedback` → `schema.prisma:L7270`
- `TpvMessage` → `schema.prisma:L9535`
- `TpvMessageDelivery` → `schema.prisma:L9587`
- `TpvMessageResponse` → `schema.prisma:L9610`
- `TrainingModule` → `schema.prisma:L9665`
- `TrainingProgress` → `schema.prisma:L9742`
- `TrainingQuizQuestion` → `schema.prisma:L9724`
- `TrainingStep` → `schema.prisma:L9704`
- `TransactionCost` → `schema.prisma:L5021`
- `UnitConversion` → `schema.prisma:L2007`
- `user_sessions` → `schema.prisma:L4407`
- `Venue` → `schema.prisma:L116`
- `VenueChatMessage` → `schema.prisma:L651`
- `VenueChatSession` → `schema.prisma:L606`
- `VenueCommission` → `schema.prisma:L11239`
- `VenueCreditAssessment` → `schema.prisma:L8079`
- `VenueCryptoConfig` → `schema.prisma:L9402`
- `VenueFeature` → `schema.prisma:L3379`
- `VenueModule` → `schema.prisma:L8235`
- `VenuePaymentConfig` → `schema.prisma:L4508`
- `VenuePaymentLinkSettings` → `schema.prisma:L10609`
- `VenuePricingStructure` → `schema.prisma:L4961`
- `VenueRoleConfig` → `schema.prisma:L1149`
- `VenueRolePermission` → `schema.prisma:L1091`
- `VenueSettings` → `schema.prisma:L691`
- `VenueTransaction` → `schema.prisma:L3316`
- `VenueWhatsappActivation` → `schema.prisma:L542`
- `WebhookEvent` → `schema.prisma:L3415`
- `WebhookSubscription` → `schema.prisma:L4624`
- `WhatsappContactWindow` → `schema.prisma:L560`
- `WhatsappInboundEvent` → `schema.prisma:L580`
- `Zone` → `schema.prisma:L99`
