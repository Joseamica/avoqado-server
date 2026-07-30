# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **290 models / 269 enums / ~13,500 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
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
| 14  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`                                                                                                                                                                                                                                                                                                                                                                         |
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

- `AccountingPeriodLock` → `schema.prisma:L12805`
- `AccountMapping` → `schema.prisma:L12701`
- `ActivityLog` → `schema.prisma:L5621`
- `Aggregator` → `schema.prisma:L11332`
- `AngelPayUserAccount` → `schema.prisma:L4330`
- `AppUpdate` → `schema.prisma:L9561`
- `Area` → `schema.prisma:L2406`
- `AreaTicket` → `schema.prisma:L11751`
- `AreaTicketCheckoutSession` → `schema.prisma:L11859`
- `AreaTicketFulfillment` → `schema.prisma:L11935`
- `AreaTicketInventoryReservation` → `schema.prisma:L11834`
- `AreaTicketLine` → `schema.prisma:L11802`
- `AreaTicketPaymentAttempt` → `schema.prisma:L11891`
- `AreaTicketPrintAttempt` → `schema.prisma:L11914`
- `BankStatement` → `schema.prisma:L12575`
- `BankStatementLine` → `schema.prisma:L12596`
- `BillingTaxProfile` → `schema.prisma:L13385`
- `BulkCommandOperation` → `schema.prisma:L7882`
- `CalendarSyncOutbox` → `schema.prisma:L10735`
- `CampaignDelivery` → `schema.prisma:L9719`
- `CashCloseout` → `schema.prisma:L8247`
- `CashDeposit` → `schema.prisma:L9363`
- `CashDrawerEvent` → `schema.prisma:L11178`
- `CashDrawerSession` → `schema.prisma:L11154`
- `CashOutCommissionRate` → `schema.prisma:L13214`
- `CashOutScheduleDay` → `schema.prisma:L13237`
- `CashOutWithdrawal` → `schema.prisma:L13299`
- `Cfdi` → `schema.prisma:L12478`
- `ChatbotTokenBudget` → `schema.prisma:L7530`
- `ChatConversation` → `schema.prisma:L7385`
- `ChatFeedback` → `schema.prisma:L7471`
- `ChatLearningEvent` → `schema.prisma:L7428`
- `ChatMessage` → `schema.prisma:L7408`
- `ChatTrainingData` → `schema.prisma:L7342`
- `CheckoutSession` → `schema.prisma:L4610`
- `ClassSession` → `schema.prisma:L10353`
- `CommissionCalculation` → `schema.prisma:L9142`
- `CommissionClawback` → `schema.prisma:L9315`
- `CommissionConfig` → `schema.prisma:L8915`
- `CommissionMilestone` → `schema.prisma:L9058`
- `CommissionOverride` → `schema.prisma:L8985`
- `CommissionPayout` → `schema.prisma:L9266`
- `CommissionSummary` → `schema.prisma:L9205`
- `CommissionTier` → `schema.prisma:L9022`
- `Consumer` → `schema.prisma:L5742`
- `ConsumerAuthAccount` → `schema.prisma:L5767`
- `CouponCode` → `schema.prisma:L6173`
- `CouponRedemption` → `schema.prisma:L6204`
- `CreditAssessmentHistory` → `schema.prisma:L8356`
- `CreditItemBalance` → `schema.prisma:L10944`
- `CreditOffer` → `schema.prisma:L8375`
- `CreditPack` → `schema.prisma:L10860`
- `CreditPackItem` → `schema.prisma:L10889`
- `CreditPackPurchase` → `schema.prisma:L10906`
- `CreditTransaction` → `schema.prisma:L10966`
- `Customer` → `schema.prisma:L5647`
- `CustomerDiscount` → `schema.prisma:L6224`
- `CustomerGroup` → `schema.prisma:L5801`
- `CustomerTaxProfile` → `schema.prisma:L12547`
- `DeliveryActivationRequest` → `schema.prisma:L4932`
- `DeliveryChannelLink` → `schema.prisma:L4896`
- `DeliveryOrderEvent` → `schema.prisma:L4956`
- `DeviceToken` → `schema.prisma:L6493`
- `DigitalReceipt` → `schema.prisma:L3338`
- `Discount` → `schema.prisma:L6073`
- `EcommerceMerchant` → `schema.prisma:L4422`
- `EmailTemplate` → `schema.prisma:L9658`
- `Employee` → `schema.prisma:L13062`
- `Estimate` → `schema.prisma:L11239`
- `EstimateItem` → `schema.prisma:L11267`
- `Expense` → `schema.prisma:L12849`
- `ExternalBusyBlock` → `schema.prisma:L10628`
- `Feature` → `schema.prisma:L3467`
- `FeeSchedule` → `schema.prisma:L3545`
- `FeeTier` → `schema.prisma:L3556`
- `FinancialAccount` → `schema.prisma:L11429`
- `FinancialConnection` → `schema.prisma:L11398`
- `FinancialProvider` → `schema.prisma:L11384`
- `FiscalEmisor` → `schema.prisma:L12401`
- `FiscalLossCarryforward` → `schema.prisma:L12972`
- `FixedAsset` → `schema.prisma:L12990`
- `FixedAssetDepreciation` → `schema.prisma:L13019`
- `FloorElement` → `schema.prisma:L2482`
- `FulfillmentArea` → `schema.prisma:L11624`
- `GeofenceRule` → `schema.prisma:L7967`
- `GoogleCalendarChannel` → `schema.prisma:L10605`
- `GoogleCalendarConnection` → `schema.prisma:L10557`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L10658`
- `GoogleOAuthSession` → `schema.prisma:L10680`
- `HolidayCalendar` → `schema.prisma:L5545`
- `IdempotencyRequest` → `schema.prisma:L8790`
- `InterVenueTransfer` → `schema.prisma:L2234`
- `InterVenueTransferAllocation` → `schema.prisma:L2317`
- `InterVenueTransferItem` → `schema.prisma:L2286`
- `InterVenueTransferReceipt` → `schema.prisma:L2344`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2360`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2388`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2372`
- `Inventory` → `schema.prisma:L1607`
- `InventoryMovement` → `schema.prisma:L1634`
- `InventoryTransfer` → `schema.prisma:L11211`
- `Invitation` → `schema.prisma:L1191`
- `Invoice` → `schema.prisma:L3568`
- `InvoiceItem` → `schema.prisma:L3594`
- `ItemCategory` → `schema.prisma:L8507`
- `JournalEntry` → `schema.prisma:L12759`
- `JournalLine` → `schema.prisma:L12787`
- `KdsOrder` → `schema.prisma:L11477`
- `KdsOrderItem` → `schema.prisma:L11494`
- `LearnedPatterns` → `schema.prisma:L7452`
- `LedgerAccount` → `schema.prisma:L12651`
- `LiveDemoSession` → `schema.prisma:L688`
- `LowStockAlert` → `schema.prisma:L2088`
- `LoyaltyConfig` → `schema.prisma:L5831`
- `LoyaltyTransaction` → `schema.prisma:L5854`
- `MarketingCampaign` → `schema.prisma:L9676`
- `McpAuthCode` → `schema.prisma:L12284`
- `McpOAuthClient` → `schema.prisma:L12268`
- `McpRefreshToken` → `schema.prisma:L12302`
- `McpToolCall` → `schema.prisma:L12323`
- `MeasurementUnit` → `schema.prisma:L11317`
- `Menu` → `schema.prisma:L1377`
- `MenuCategory` → `schema.prisma:L1314`
- `MenuCategoryAssignment` → `schema.prisma:L1412`
- `MercadoPagoWebhookEvent` → `schema.prisma:L12198`
- `MerchantAccount` → `schema.prisma:L4160`
- `MerchantFiscalConfig` → `schema.prisma:L12449`
- `MerchantRevenueShare` → `schema.prisma:L5125`
- `MerchantRoutingRule` → `schema.prisma:L4282`
- `MilestoneAchievement` → `schema.prisma:L9103`
- `Modifier` → `schema.prisma:L3078`
- `ModifierGroup` → `schema.prisma:L3042`
- `Module` → `schema.prisma:L8423`
- `MoneyAnomaly` → `schema.prisma:L5028`
- `MonthlyVenueProfit` → `schema.prisma:L5571`
- `Notification` → `schema.prisma:L6395`
- `NotificationPreference` → `schema.prisma:L6442`
- `NotificationTemplate` → `schema.prisma:L6469`
- `OAuthState` → `schema.prisma:L1242`
- `OnboardingProgress` → `schema.prisma:L1260`
- `Order` → `schema.prisma:L2706`
- `OrderAction` → `schema.prisma:L3143`
- `OrderCustomer` → `schema.prisma:L2899`
- `OrderDiscount` → `schema.prisma:L6256`
- `OrderFulfillment` → `schema.prisma:L11671`
- `OrderFulfillmentLine` → `schema.prisma:L11702`
- `OrderItem` → `schema.prisma:L2915`
- `OrderItemModifier` → `schema.prisma:L3127`
- `OrderServiceCharge` → `schema.prisma:L6340`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L9477`
- `OrganizationGoal` → `schema.prisma:L9435`
- `OrganizationModule` → `schema.prisma:L8479`
- `OrganizationPaymentConfig` → `schema.prisma:L4734`
- `OrganizationPayoutConfig` → `schema.prisma:L9510`
- `OrganizationPricingStructure` → `schema.prisma:L4766`
- `OrganizationSalesGoalConfig` → `schema.prisma:L9458`
- `OtpChallenge` → `schema.prisma:L5786`
- `PartnerAPIKey` → `schema.prisma:L4564`
- `Payment` → `schema.prisma:L3176`
- `PaymentAllocation` → `schema.prisma:L3317`
- `PaymentLink` → `schema.prisma:L11012`
- `PaymentLinkAttribution` → `schema.prisma:L11120`
- `PaymentLinkItem` → `schema.prisma:L11075`
- `PaymentLinkItemModifier` → `schema.prisma:L11102`
- `PaymentProvider` → `schema.prisma:L4119`
- `PayrollLine` → `schema.prisma:L13133`
- `PayrollRun` → `schema.prisma:L13102`
- `PerformanceGoal` → `schema.prisma:L9412`
- `PermissionSet` → `schema.prisma:L1142`
- `PlatformCfdi` → `schema.prisma:L13414`
- `PlatformEmisor` → `schema.prisma:L13358`
- `PlatformSettings` → `schema.prisma:L4541`
- `PosCommand` → `schema.prisma:L6523`
- `PosConnectionStatus` → `schema.prisma:L780`
- `PosSyncIntent` → `schema.prisma:L13492`
- `PricingPolicy` → `schema.prisma:L1999`
- `Printer` → `schema.prisma:L11523`
- `PrintGateway` → `schema.prisma:L11560`
- `PrintJob` → `schema.prisma:L12097`
- `PrintStation` → `schema.prisma:L11578`
- `ProcessedStripeEvent` → `schema.prisma:L5014`
- `ProcessorReliabilityMetric` → `schema.prisma:L5499`
- `Product` → `schema.prisma:L1430`
- `ProductModifierGroup` → `schema.prisma:L3115`
- `ProductOption` → `schema.prisma:L11294`
- `ProductOptionValue` → `schema.prisma:L11305`
- `ProductStaff` → `schema.prisma:L10268`
- `PromoterBankAccount` → `schema.prisma:L13253`
- `PromoterCommissionEntry` → `schema.prisma:L13272`
- `PromoterLocationPing` → `schema.prisma:L2672`
- `ProviderCostStructure` → `schema.prisma:L5050`
- `ProviderEventLog` → `schema.prisma:L4843`
- `PurchaseOrder` → `schema.prisma:L1906`
- `PurchaseOrderItem` → `schema.prisma:L1963`
- `RateCorrectionBatch` → `schema.prisma:L5275`
- `RateCorrectionEntry` → `schema.prisma:L5317`
- `RawMaterial` → `schema.prisma:L1667`
- `RawMaterialMovement` → `schema.prisma:L2052`
- `RawMaterialPresentation` → `schema.prisma:L1740`
- `Recipe` → `schema.prisma:L1760`
- `RecipeLine` → `schema.prisma:L1784`
- `Referral` → `schema.prisma:L5921`
- `ReferralProgramConfig` → `schema.prisma:L5886`
- `ReferralRewardGrant` → `schema.prisma:L6012`
- `ReferralTierReward` → `schema.prisma:L5984`
- `ReferralTierUnlock` → `schema.prisma:L6057`
- `Reservation` → `schema.prisma:L10055`
- `ReservationGoogleEventMapping` → `schema.prisma:L10792`
- `ReservationModifier` → `schema.prisma:L10216`
- `ReservationReminderSent` → `schema.prisma:L10199`
- `ReservationSettings` → `schema.prisma:L10430`
- `ReservationWaitlistEntry` → `schema.prisma:L10398`
- `Review` → `schema.prisma:L3612`
- `SalesRetention` → `schema.prisma:L12953`
- `SaleVerification` → `schema.prisma:L3371`
- `ScaleProfile` → `schema.prisma:L11968`
- `ScheduledCommand` → `schema.prisma:L7927`
- `SerializedItem` → `schema.prisma:L8550`
- `SerializedItemCustodyEvent` → `schema.prisma:L8713`
- `ServiceCharge` → `schema.prisma:L6311`
- `SettlementConfiguration` → `schema.prisma:L5350`
- `SettlementConfirmation` → `schema.prisma:L5463`
- `SettlementIncident` → `schema.prisma:L5414`
- `SettlementSimulation` → `schema.prisma:L5385`
- `Shift` → `schema.prisma:L2520`
- `SimRegistrationRequest` → `schema.prisma:L8751`
- `SimRegistrationRequestItem` → `schema.prisma:L8773`
- `SlotHold` → `schema.prisma:L10299`
- `Staff` → `schema.prisma:L800`
- `StaffOnboardingState` → `schema.prisma:L12168`
- `StaffOrganization` → `schema.prisma:L1056`
- `StaffPasskey` → `schema.prisma:L1083`
- `StaffSchedule` → `schema.prisma:L10239`
- `StaffScheduleException` → `schema.prisma:L10251`
- `StaffVenue` → `schema.prisma:L986`
- `StockAlertConfig` → `schema.prisma:L9394`
- `StockBatch` → `schema.prisma:L2183`
- `StockCount` → `schema.prisma:L2120`
- `StockCountItem` → `schema.prisma:L2141`
- `StripeWebhookEvent` → `schema.prisma:L4997`
- `Supplier` → `schema.prisma:L1819`
- `SupplierPricing` → `schema.prisma:L1872`
- `Table` → `schema.prisma:L2432`
- `Terminal` → `schema.prisma:L3663`
- `TerminalHealth` → `schema.prisma:L3895`
- `TerminalLog` → `schema.prisma:L3869`
- `TerminalOrder` → `schema.prisma:L4022`
- `TerminalOrderItem` → `schema.prisma:L4097`
- `TerminalPaymentRequest` → `schema.prisma:L3966`
- `TimeEntry` → `schema.prisma:L2585`
- `TimeEntryBreak` → `schema.prisma:L2654`
- `TokenPurchase` → `schema.prisma:L7601`
- `TokenUsageRecord` → `schema.prisma:L7573`
- `TpvCommandHistory` → `schema.prisma:L7833`
- `TpvCommandQueue` → `schema.prisma:L7773`
- `TpvFeedback` → `schema.prisma:L7486`
- `TpvMessage` → `schema.prisma:L9751`
- `TpvMessageDelivery` → `schema.prisma:L9803`
- `TpvMessageResponse` → `schema.prisma:L9826`
- `TrainingModule` → `schema.prisma:L9881`
- `TrainingProgress` → `schema.prisma:L9958`
- `TrainingQuizQuestion` → `schema.prisma:L9940`
- `TrainingStep` → `schema.prisma:L9920`
- `TransactionCost` → `schema.prisma:L5213`
- `UnitConversion` → `schema.prisma:L2030`
- `user_sessions` → `schema.prisma:L4599`
- `Venue` → `schema.prisma:L116`
- `VenueAreaTicketSettings` → `schema.prisma:L11730`
- `VenueChatMessage` → `schema.prisma:L664`
- `VenueChatSession` → `schema.prisma:L619`
- `VenueCommission` → `schema.prisma:L11455`
- `VenueCreditAssessment` → `schema.prisma:L8295`
- `VenueCryptoConfig` → `schema.prisma:L9618`
- `VenueFeature` → `schema.prisma:L3485`
- `VenueModule` → `schema.prisma:L8451`
- `VenuePaymentConfig` → `schema.prisma:L4700`
- `VenuePaymentLinkSettings` → `schema.prisma:L10825`
- `VenuePricingStructure` → `schema.prisma:L5153`
- `VenueRoleConfig` → `schema.prisma:L1171`
- `VenueRolePermission` → `schema.prisma:L1113`
- `VenueScaleSettings` → `schema.prisma:L11958`
- `VenueSettings` → `schema.prisma:L704`
- `VenueTransaction` → `schema.prisma:L3422`
- `VenueWhatsappActivation` → `schema.prisma:L555`
- `WebhookEvent` → `schema.prisma:L3521`
- `WebhookSubscription` → `schema.prisma:L4816`
- `WhatsappContactWindow` → `schema.prisma:L573`
- `WhatsappInboundEvent` → `schema.prisma:L593`
- `Zone` → `schema.prisma:L99`
