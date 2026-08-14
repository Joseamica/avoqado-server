# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **324 models / 316 enums / ~15,200 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `PermissionSet`, `PromoterLocationPing`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                          |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                                                            |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                         |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                         |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`                                                                                                                                                                                                                                                                                                                                                                  |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                      |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                                                                     |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                 |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L14572`
- `AccountMapping` → `schema.prisma:L14468`
- `ActivityLog` → `schema.prisma:L5960`
- `Aggregator` → `schema.prisma:L12920`
- `AngelPayUserAccount` → `schema.prisma:L4669`
- `AppUpdate` → `schema.prisma:L11140`
- `Area` → `schema.prisma:L2716`
- `AreaTicket` → `schema.prisma:L13363`
- `AreaTicketCheckoutSession` → `schema.prisma:L13485`
- `AreaTicketExternalIncident` → `schema.prisma:L13732`
- `AreaTicketExternalSettlement` → `schema.prisma:L13697`
- `AreaTicketFulfillment` → `schema.prisma:L13561`
- `AreaTicketInventoryReservation` → `schema.prisma:L13456`
- `AreaTicketLine` → `schema.prisma:L13424`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13517`
- `AreaTicketPrintAttempt` → `schema.prisma:L13540`
- `BankStatement` → `schema.prisma:L14342`
- `BankStatementLine` → `schema.prisma:L14363`
- `BillingTaxProfile` → `schema.prisma:L15152`
- `BulkCommandOperation` → `schema.prisma:L8454`
- `CalendarSyncOutbox` → `schema.prisma:L12314`
- `CampaignDelivery` → `schema.prisma:L11298`
- `CashCloseout` → `schema.prisma:L8819`
- `CashDeposit` → `schema.prisma:L10942`
- `CashDrawerEvent` → `schema.prisma:L12757`
- `CashDrawerSession` → `schema.prisma:L12733`
- `CashOutCommissionRate` → `schema.prisma:L14981`
- `CashOutScheduleDay` → `schema.prisma:L15004`
- `CashOutWithdrawal` → `schema.prisma:L15066`
- `CatalogBindingBatch` → `schema.prisma:L9850`
- `CatalogBindingLine` → `schema.prisma:L9886`
- `CatalogBrand` → `schema.prisma:L9303`
- `CatalogClientObservation` → `schema.prisma:L9616`
- `CatalogClientReadinessOverride` → `schema.prisma:L9635`
- `CatalogFamily` → `schema.prisma:L9353`
- `CatalogIdempotencyRecord` → `schema.prisma:L9749`
- `CatalogIdentifier` → `schema.prisma:L9484`
- `CatalogImportBatch` → `schema.prisma:L9792`
- `CatalogImportLine` → `schema.prisma:L9829`
- `CatalogItem` → `schema.prisma:L9386`
- `CatalogItemBusinessType` → `schema.prisma:L9446`
- `CatalogItemPrice` → `schema.prisma:L9534`
- `CatalogManufacturer` → `schema.prisma:L9327`
- `CatalogProductTypeMapping` → `schema.prisma:L9463`
- `CatalogPublicationBatch` → `schema.prisma:L9914`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10008`
- `CatalogPublicationLine` → `schema.prisma:L9955`
- `CatalogPublicationOutbox` → `schema.prisma:L10051`
- `CatalogValidationProfile` → `schema.prisma:L9505`
- `CatalogVenueBinding` → `schema.prisma:L9663`
- `CatalogVenueClientRequirement` → `schema.prisma:L9590`
- `CatalogVenueEventSequence` → `schema.prisma:L10034`
- `CatalogVenueOverride` → `schema.prisma:L9705`
- `CatalogVenueRollout` → `schema.prisma:L9565`
- `Cfdi` → `schema.prisma:L14245`
- `ChatbotTokenBudget` → `schema.prisma:L8102`
- `ChatConversation` → `schema.prisma:L7957`
- `ChatFeedback` → `schema.prisma:L8043`
- `ChatLearningEvent` → `schema.prisma:L8000`
- `ChatMessage` → `schema.prisma:L7980`
- `ChatTrainingData` → `schema.prisma:L7914`
- `CheckoutSession` → `schema.prisma:L4949`
- `ClassSession` → `schema.prisma:L11932`
- `CommissionCalculation` → `schema.prisma:L10721`
- `CommissionClawback` → `schema.prisma:L10894`
- `CommissionConfig` → `schema.prisma:L10494`
- `CommissionMilestone` → `schema.prisma:L10637`
- `CommissionOverride` → `schema.prisma:L10564`
- `CommissionPayout` → `schema.prisma:L10845`
- `CommissionSummary` → `schema.prisma:L10784`
- `CommissionTier` → `schema.prisma:L10601`
- `Consumer` → `schema.prisma:L6096`
- `ConsumerAuthAccount` → `schema.prisma:L6121`
- `CouponCode` → `schema.prisma:L6724`
- `CouponRedemption` → `schema.prisma:L6755`
- `CreditAssessmentHistory` → `schema.prisma:L8928`
- `CreditItemBalance` → `schema.prisma:L12523`
- `CreditOffer` → `schema.prisma:L8947`
- `CreditPack` → `schema.prisma:L12439`
- `CreditPackItem` → `schema.prisma:L12468`
- `CreditPackPurchase` → `schema.prisma:L12485`
- `CreditTransaction` → `schema.prisma:L12545`
- `Customer` → `schema.prisma:L6001`
- `CustomerDiscount` → `schema.prisma:L6775`
- `CustomerGroup` → `schema.prisma:L6155`
- `CustomerTaxProfile` → `schema.prisma:L14314`
- `DeliveryActivationRequest` → `schema.prisma:L5271`
- `DeliveryChannelLink` → `schema.prisma:L5235`
- `DeliveryOrderEvent` → `schema.prisma:L5295`
- `DeviceToken` → `schema.prisma:L7044`
- `DigitalReceipt` → `schema.prisma:L3670`
- `Discount` → `schema.prisma:L6427`
- `EcommerceMerchant` → `schema.prisma:L4761`
- `EmailTemplate` → `schema.prisma:L11237`
- `Employee` → `schema.prisma:L14829`
- `Estimate` → `schema.prisma:L12827`
- `EstimateItem` → `schema.prisma:L12855`
- `Expense` → `schema.prisma:L14616`
- `ExternalBusyBlock` → `schema.prisma:L12207`
- `Feature` → `schema.prisma:L3799`
- `FeeSchedule` → `schema.prisma:L3877`
- `FeeTier` → `schema.prisma:L3888`
- `FinancialAccount` → `schema.prisma:L13017`
- `FinancialConnection` → `schema.prisma:L12986`
- `FinancialProvider` → `schema.prisma:L12972`
- `FiscalEmisor` → `schema.prisma:L14168`
- `FiscalLossCarryforward` → `schema.prisma:L14739`
- `FixedAsset` → `schema.prisma:L14757`
- `FixedAssetDepreciation` → `schema.prisma:L14786`
- `FloorElement` → `schema.prisma:L2792`
- `FulfillmentArea` → `schema.prisma:L13228`
- `GeofenceRule` → `schema.prisma:L8539`
- `GoogleCalendarChannel` → `schema.prisma:L12184`
- `GoogleCalendarConnection` → `schema.prisma:L12136`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12237`
- `GoogleOAuthSession` → `schema.prisma:L12259`
- `HolidayCalendar` → `schema.prisma:L5884`
- `IdempotencyRequest` → `schema.prisma:L10369`
- `InterVenueTransfer` → `schema.prisma:L2544`
- `InterVenueTransferAllocation` → `schema.prisma:L2627`
- `InterVenueTransferItem` → `schema.prisma:L2596`
- `InterVenueTransferReceipt` → `schema.prisma:L2654`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2670`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2698`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2682`
- `Inventory` → `schema.prisma:L1748`
- `InventoryMovement` → `schema.prisma:L1775`
- `InventoryPosting` → `schema.prisma:L1857`
- `InventoryPostingLine` → `schema.prisma:L1891`
- `InventoryTransfer` → `schema.prisma:L12799`
- `Invitation` → `schema.prisma:L1299`
- `Invoice` → `schema.prisma:L3900`
- `InvoiceItem` → `schema.prisma:L3926`
- `ItemCategory` → `schema.prisma:L10086`
- `JournalEntry` → `schema.prisma:L14526`
- `JournalLine` → `schema.prisma:L14554`
- `KdsOrder` → `schema.prisma:L13065`
- `KdsOrderItem` → `schema.prisma:L13082`
- `LearnedPatterns` → `schema.prisma:L8024`
- `LedgerAccount` → `schema.prisma:L14418`
- `LiveDemoSession` → `schema.prisma:L755`
- `LowStockAlert` → `schema.prisma:L2390`
- `LoyaltyConfig` → `schema.prisma:L6185`
- `LoyaltyTransaction` → `schema.prisma:L6208`
- `MarketingCampaign` → `schema.prisma:L11255`
- `McpAuthCode` → `schema.prisma:L14051`
- `McpOAuthClient` → `schema.prisma:L14035`
- `McpRefreshToken` → `schema.prisma:L14069`
- `McpToolCall` → `schema.prisma:L14090`
- `MeasurementUnit` → `schema.prisma:L12905`
- `Menu` → `schema.prisma:L1485`
- `MenuCategory` → `schema.prisma:L1422`
- `MenuCategoryAssignment` → `schema.prisma:L1520`
- `MercadoPagoWebhookEvent` → `schema.prisma:L13965`
- `MerchantAccount` → `schema.prisma:L4499`
- `MerchantFiscalConfig` → `schema.prisma:L14216`
- `MerchantRevenueShare` → `schema.prisma:L5464`
- `MerchantRoutingRule` → `schema.prisma:L4621`
- `MilestoneAchievement` → `schema.prisma:L10682`
- `Modifier` → `schema.prisma:L3399`
- `ModifierGroup` → `schema.prisma:L3363`
- `Module` → `schema.prisma:L8995`
- `MoneyAnomaly` → `schema.prisma:L5367`
- `MonthlyVenueProfit` → `schema.prisma:L5910`
- `Notification` → `schema.prisma:L6946`
- `NotificationPreference` → `schema.prisma:L6993`
- `NotificationTemplate` → `schema.prisma:L7020`
- `OAuthState` → `schema.prisma:L1350`
- `OnboardingProgress` → `schema.prisma:L1368`
- `Order` → `schema.prisma:L3023`
- `OrderAction` → `schema.prisma:L3464`
- `OrderCustomer` → `schema.prisma:L3220`
- `OrderDiscount` → `schema.prisma:L6807`
- `OrderFulfillment` → `schema.prisma:L13283`
- `OrderFulfillmentLine` → `schema.prisma:L13314`
- `OrderItem` → `schema.prisma:L3236`
- `OrderItemModifier` → `schema.prisma:L3448`
- `OrderServiceCharge` → `schema.prisma:L6891`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11056`
- `OrganizationEntitlement` → `schema.prisma:L9278`
- `OrganizationGoal` → `schema.prisma:L11014`
- `OrganizationModule` → `schema.prisma:L9055`
- `OrganizationPaymentConfig` → `schema.prisma:L5073`
- `OrganizationPayoutConfig` → `schema.prisma:L11089`
- `OrganizationPricingStructure` → `schema.prisma:L5105`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11037`
- `OtpChallenge` → `schema.prisma:L6140`
- `PartnerAPIKey` → `schema.prisma:L4903`
- `Payment` → `schema.prisma:L3497`
- `PaymentAllocation` → `schema.prisma:L3649`
- `PaymentLink` → `schema.prisma:L12591`
- `PaymentLinkAttribution` → `schema.prisma:L12699`
- `PaymentLinkItem` → `schema.prisma:L12654`
- `PaymentLinkItemModifier` → `schema.prisma:L12681`
- `PaymentProvider` → `schema.prisma:L4458`
- `PayrollLine` → `schema.prisma:L14900`
- `PayrollRun` → `schema.prisma:L14869`
- `PerformanceGoal` → `schema.prisma:L10991`
- `PermissionSet` → `schema.prisma:L1250`
- `PlatformCfdi` → `schema.prisma:L15185`
- `PlatformEmisor` → `schema.prisma:L15125`
- `PlatformSettings` → `schema.prisma:L4880`
- `PosCommand` → `schema.prisma:L7074`
- `PosConnectionStatus` → `schema.prisma:L848`
- `PosSyncIntent` → `schema.prisma:L15263`
- `PricingPolicy` → `schema.prisma:L2294`
- `Printer` → `schema.prisma:L13111`
- `PrintGateway` → `schema.prisma:L13164`
- `PrintJob` → `schema.prisma:L13864`
- `PrintStation` → `schema.prisma:L13182`
- `ProcessedStripeEvent` → `schema.prisma:L5353`
- `ProcessorReliabilityMetric` → `schema.prisma:L5838`
- `Product` → `schema.prisma:L1538`
- `ProductModifierGroup` → `schema.prisma:L3436`
- `ProductOption` → `schema.prisma:L12882`
- `ProductOptionValue` → `schema.prisma:L12893`
- `ProductStaff` → `schema.prisma:L11847`
- `PromoterBankAccount` → `schema.prisma:L15020`
- `PromoterCommissionEntry` → `schema.prisma:L15039`
- `PromoterLocationPing` → `schema.prisma:L2989`
- `ProviderCostStructure` → `schema.prisma:L5389`
- `ProviderEventLog` → `schema.prisma:L5182`
- `PurchaseOrder` → `schema.prisma:L2162`
- `PurchaseOrderItem` → `schema.prisma:L2219`
- `RateCorrectionBatch` → `schema.prisma:L5614`
- `RateCorrectionEntry` → `schema.prisma:L5656`
- `RawMaterial` → `schema.prisma:L1923`
- `RawMaterialMovement` → `schema.prisma:L2347`
- `RawMaterialPresentation` → `schema.prisma:L1996`
- `Recipe` → `schema.prisma:L2016`
- `RecipeLine` → `schema.prisma:L2040`
- `Referral` → `schema.prisma:L6275`
- `ReferralProgramConfig` → `schema.prisma:L6240`
- `ReferralRewardGrant` → `schema.prisma:L6366`
- `ReferralTierReward` → `schema.prisma:L6338`
- `ReferralTierUnlock` → `schema.prisma:L6411`
- `Reservation` → `schema.prisma:L11634`
- `ReservationGoogleEventMapping` → `schema.prisma:L12371`
- `ReservationModifier` → `schema.prisma:L11795`
- `ReservationReminderSent` → `schema.prisma:L11778`
- `ReservationSettings` → `schema.prisma:L12009`
- `ReservationWaitlistEntry` → `schema.prisma:L11977`
- `Review` → `schema.prisma:L3944`
- `SalesRetention` → `schema.prisma:L14720`
- `SaleVerification` → `schema.prisma:L3703`
- `ScaleProfile` → `schema.prisma:L13605`
- `ScheduledCommand` → `schema.prisma:L8499`
- `SerializedItem` → `schema.prisma:L10129`
- `SerializedItemCustodyEvent` → `schema.prisma:L10292`
- `ServiceCharge` → `schema.prisma:L6862`
- `SettlementConfiguration` → `schema.prisma:L5689`
- `SettlementConfirmation` → `schema.prisma:L5802`
- `SettlementIncident` → `schema.prisma:L5753`
- `SettlementSimulation` → `schema.prisma:L5724`
- `Shift` → `schema.prisma:L2830`
- `SimRegistrationRequest` → `schema.prisma:L10330`
- `SimRegistrationRequestItem` → `schema.prisma:L10352`
- `SlotHold` → `schema.prisma:L11878`
- `Staff` → `schema.prisma:L868`
- `StaffOnboardingState` → `schema.prisma:L13935`
- `StaffOrganization` → `schema.prisma:L1164`
- `StaffPasskey` → `schema.prisma:L1191`
- `StaffSchedule` → `schema.prisma:L11818`
- `StaffScheduleException` → `schema.prisma:L11830`
- `StaffVenue` → `schema.prisma:L1094`
- `StockAlertConfig` → `schema.prisma:L10973`
- `StockBatch` → `schema.prisma:L2493`
- `StockCount` → `schema.prisma:L2422`
- `StockCountItem` → `schema.prisma:L2446`
- `StripeWebhookEvent` → `schema.prisma:L5336`
- `Supplier` → `schema.prisma:L2075`
- `SupplierPricing` → `schema.prisma:L2128`
- `Table` → `schema.prisma:L2742`
- `Terminal` → `schema.prisma:L3995`
- `TerminalHealth` → `schema.prisma:L4234`
- `TerminalLog` → `schema.prisma:L4208`
- `TerminalOrder` → `schema.prisma:L4361`
- `TerminalOrderItem` → `schema.prisma:L4436`
- `TerminalPaymentRequest` → `schema.prisma:L4305`
- `TimeEntry` → `schema.prisma:L2902`
- `TimeEntryBreak` → `schema.prisma:L2971`
- `TokenPurchase` → `schema.prisma:L8173`
- `TokenUsageRecord` → `schema.prisma:L8145`
- `TpvCommandHistory` → `schema.prisma:L8405`
- `TpvCommandQueue` → `schema.prisma:L8345`
- `TpvFeedback` → `schema.prisma:L8058`
- `TpvMessage` → `schema.prisma:L11330`
- `TpvMessageDelivery` → `schema.prisma:L11382`
- `TpvMessageResponse` → `schema.prisma:L11405`
- `TrainingModule` → `schema.prisma:L11460`
- `TrainingProgress` → `schema.prisma:L11537`
- `TrainingQuizQuestion` → `schema.prisma:L11519`
- `TrainingStep` → `schema.prisma:L11499`
- `TransactionCost` → `schema.prisma:L5552`
- `UnitConversion` → `schema.prisma:L2325`
- `UpsellAcceptance` → `schema.prisma:L6683`
- `UpsellAiRun` → `schema.prisma:L6703`
- `UpsellImpression` → `schema.prisma:L6643`
- `UpsellRule` → `schema.prisma:L6573`
- `user_sessions` → `schema.prisma:L4938`
- `Venue` → `schema.prisma:L147`
- `VenueAreaTicketSettings` → `schema.prisma:L13342`
- `VenueChatMessage` → `schema.prisma:L731`
- `VenueChatSession` → `schema.prisma:L686`
- `VenueCommission` → `schema.prisma:L13043`
- `VenueCreditAssessment` → `schema.prisma:L8867`
- `VenueCryptoConfig` → `schema.prisma:L11197`
- `VenueFeature` → `schema.prisma:L3817`
- `VenueModule` → `schema.prisma:L9027`
- `VenuePaymentConfig` → `schema.prisma:L5039`
- `VenuePaymentLinkSettings` → `schema.prisma:L12404`
- `VenuePricingStructure` → `schema.prisma:L5492`
- `VenueRoleConfig` → `schema.prisma:L1279`
- `VenueRolePermission` → `schema.prisma:L1221`
- `VenueScaleSettings` → `schema.prisma:L13593`
- `VenueSettings` → `schema.prisma:L771`
- `VenueTransaction` → `schema.prisma:L3754`
- `VenueWhatsappActivation` → `schema.prisma:L622`
- `WebhookEvent` → `schema.prisma:L3853`
- `WebhookSubscription` → `schema.prisma:L5155`
- `WhatsappContactWindow` → `schema.prisma:L640`
- `WhatsappInboundEvent` → `schema.prisma:L660`
- `Zone` → `schema.prisma:L130`
