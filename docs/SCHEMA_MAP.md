# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **331 models / 322 enums / ~15,600 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                            |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                                                                              |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                           |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                           |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`                                                                                                                                                                                                                                                                                                                                  |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                        |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                                                                                       |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L14837`
- `AccountMapping` → `schema.prisma:L14733`
- `ActivityLog` → `schema.prisma:L6196`
- `Aggregator` → `schema.prisma:L13185`
- `AngelPayUserAccount` → `schema.prisma:L4878`
- `AppUpdate` → `schema.prisma:L11405`
- `Area` → `schema.prisma:L2797`
- `AreaTicket` → `schema.prisma:L13628`
- `AreaTicketCheckoutSession` → `schema.prisma:L13750`
- `AreaTicketExternalIncident` → `schema.prisma:L13997`
- `AreaTicketExternalSettlement` → `schema.prisma:L13962`
- `AreaTicketFulfillment` → `schema.prisma:L13826`
- `AreaTicketInventoryReservation` → `schema.prisma:L13721`
- `AreaTicketLine` → `schema.prisma:L13689`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13782`
- `AreaTicketPrintAttempt` → `schema.prisma:L13805`
- `BankStatement` → `schema.prisma:L14607`
- `BankStatementLine` → `schema.prisma:L14628`
- `BillingTaxProfile` → `schema.prisma:L15417`
- `BulkCommandOperation` → `schema.prisma:L8719`
- `CalendarSyncOutbox` → `schema.prisma:L12579`
- `CampaignDelivery` → `schema.prisma:L11563`
- `CashCloseout` → `schema.prisma:L9084`
- `CashDeposit` → `schema.prisma:L11207`
- `CashDrawerEvent` → `schema.prisma:L13022`
- `CashDrawerSession` → `schema.prisma:L12998`
- `CashOutCommissionRate` → `schema.prisma:L15246`
- `CashOutScheduleDay` → `schema.prisma:L15269`
- `CashOutWithdrawal` → `schema.prisma:L15331`
- `CatalogBindingBatch` → `schema.prisma:L10115`
- `CatalogBindingLine` → `schema.prisma:L10151`
- `CatalogBrand` → `schema.prisma:L9568`
- `CatalogClientObservation` → `schema.prisma:L9881`
- `CatalogClientReadinessOverride` → `schema.prisma:L9900`
- `CatalogFamily` → `schema.prisma:L9618`
- `CatalogIdempotencyRecord` → `schema.prisma:L10014`
- `CatalogIdentifier` → `schema.prisma:L9749`
- `CatalogImportBatch` → `schema.prisma:L10057`
- `CatalogImportLine` → `schema.prisma:L10094`
- `CatalogItem` → `schema.prisma:L9651`
- `CatalogItemBusinessType` → `schema.prisma:L9711`
- `CatalogItemPrice` → `schema.prisma:L9799`
- `CatalogManufacturer` → `schema.prisma:L9592`
- `CatalogProductTypeMapping` → `schema.prisma:L9728`
- `CatalogPublicationBatch` → `schema.prisma:L10179`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10273`
- `CatalogPublicationLine` → `schema.prisma:L10220`
- `CatalogPublicationOutbox` → `schema.prisma:L10316`
- `CatalogValidationProfile` → `schema.prisma:L9770`
- `CatalogVenueBinding` → `schema.prisma:L9928`
- `CatalogVenueClientRequirement` → `schema.prisma:L9855`
- `CatalogVenueEventSequence` → `schema.prisma:L10299`
- `CatalogVenueOverride` → `schema.prisma:L9970`
- `CatalogVenueRollout` → `schema.prisma:L9830`
- `Cfdi` → `schema.prisma:L14510`
- `ChatbotTokenBudget` → `schema.prisma:L8367`
- `ChatConversation` → `schema.prisma:L8222`
- `ChatFeedback` → `schema.prisma:L8308`
- `ChatLearningEvent` → `schema.prisma:L8265`
- `ChatMessage` → `schema.prisma:L8245`
- `ChatTrainingData` → `schema.prisma:L8179`
- `CheckoutSession` → `schema.prisma:L5158`
- `ClassSession` → `schema.prisma:L12197`
- `CommissionCalculation` → `schema.prisma:L10986`
- `CommissionClawback` → `schema.prisma:L11159`
- `CommissionConfig` → `schema.prisma:L10759`
- `CommissionMilestone` → `schema.prisma:L10902`
- `CommissionOverride` → `schema.prisma:L10829`
- `CommissionPayout` → `schema.prisma:L11110`
- `CommissionSummary` → `schema.prisma:L11049`
- `CommissionTier` → `schema.prisma:L10866`
- `Consumer` → `schema.prisma:L6332`
- `ConsumerAuthAccount` → `schema.prisma:L6357`
- `CouponCode` → `schema.prisma:L6973`
- `CouponRedemption` → `schema.prisma:L7004`
- `CreditAssessmentHistory` → `schema.prisma:L9193`
- `CreditItemBalance` → `schema.prisma:L12788`
- `CreditOffer` → `schema.prisma:L9212`
- `CreditPack` → `schema.prisma:L12704`
- `CreditPackItem` → `schema.prisma:L12733`
- `CreditPackPurchase` → `schema.prisma:L12750`
- `CreditTransaction` → `schema.prisma:L12810`
- `Customer` → `schema.prisma:L6237`
- `CustomerDiscount` → `schema.prisma:L7024`
- `CustomerGroup` → `schema.prisma:L6391`
- `CustomerTaxProfile` → `schema.prisma:L14579`
- `DeliveryActivationRequest` → `schema.prisma:L5480`
- `DeliveryChannelLink` → `schema.prisma:L5444`
- `DeliveryOrderEvent` → `schema.prisma:L5504`
- `DeviceToken` → `schema.prisma:L7293`
- `DigitalReceipt` → `schema.prisma:L3873`
- `Discount` → `schema.prisma:L6663`
- `EcommerceMerchant` → `schema.prisma:L4970`
- `EmailTemplate` → `schema.prisma:L11502`
- `Employee` → `schema.prisma:L15094`
- `Estimate` → `schema.prisma:L13092`
- `EstimateItem` → `schema.prisma:L13120`
- `Expense` → `schema.prisma:L14881`
- `ExternalBusyBlock` → `schema.prisma:L12472`
- `Feature` → `schema.prisma:L4002`
- `FeeSchedule` → `schema.prisma:L4080`
- `FeeTier` → `schema.prisma:L4091`
- `FinancialAccount` → `schema.prisma:L13282`
- `FinancialConnection` → `schema.prisma:L13251`
- `FinancialProvider` → `schema.prisma:L13237`
- `FiscalEmisor` → `schema.prisma:L14433`
- `FiscalLossCarryforward` → `schema.prisma:L15004`
- `FixedAsset` → `schema.prisma:L15022`
- `FixedAssetDepreciation` → `schema.prisma:L15051`
- `FloorElement` → `schema.prisma:L2873`
- `FulfillmentArea` → `schema.prisma:L13493`
- `GeofenceRule` → `schema.prisma:L8804`
- `GoogleCalendarChannel` → `schema.prisma:L12449`
- `GoogleCalendarConnection` → `schema.prisma:L12401`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12502`
- `GoogleOAuthSession` → `schema.prisma:L12524`
- `HolidayCalendar` → `schema.prisma:L6120`
- `IdempotencyRequest` → `schema.prisma:L10634`
- `InterVenueTransfer` → `schema.prisma:L2625`
- `InterVenueTransferAllocation` → `schema.prisma:L2708`
- `InterVenueTransferItem` → `schema.prisma:L2677`
- `InterVenueTransferReceipt` → `schema.prisma:L2735`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2751`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2779`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2763`
- `Inventory` → `schema.prisma:L1818`
- `InventoryMovement` → `schema.prisma:L1845`
- `InventoryPosting` → `schema.prisma:L1927`
- `InventoryPostingLine` → `schema.prisma:L1967`
- `InventoryTransfer` → `schema.prisma:L13064`
- `Invitation` → `schema.prisma:L1366`
- `Invoice` → `schema.prisma:L4103`
- `InvoiceItem` → `schema.prisma:L4129`
- `ItemCategory` → `schema.prisma:L10351`
- `JournalEntry` → `schema.prisma:L14791`
- `JournalLine` → `schema.prisma:L14819`
- `KdsOrder` → `schema.prisma:L13330`
- `KdsOrderItem` → `schema.prisma:L13347`
- `LearnedPatterns` → `schema.prisma:L8289`
- `LedgerAccount` → `schema.prisma:L14683`
- `LiveDemoSession` → `schema.prisma:L771`
- `LowStockAlert` → `schema.prisma:L2466`
- `LoyaltyConfig` → `schema.prisma:L6421`
- `LoyaltyTransaction` → `schema.prisma:L6444`
- `MarketingCampaign` → `schema.prisma:L11520`
- `McpAuthCode` → `schema.prisma:L14316`
- `McpOAuthClient` → `schema.prisma:L14300`
- `McpRefreshToken` → `schema.prisma:L14334`
- `McpToolCall` → `schema.prisma:L14355`
- `MeasurementUnit` → `schema.prisma:L13170`
- `Menu` → `schema.prisma:L1552`
- `MenuCategory` → `schema.prisma:L1489`
- `MenuCategoryAssignment` → `schema.prisma:L1587`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14230`
- `MerchantAccount` → `schema.prisma:L4708`
- `MerchantFiscalConfig` → `schema.prisma:L14481`
- `MerchantRevenueShare` → `schema.prisma:L5700`
- `MerchantRoutingRule` → `schema.prisma:L4830`
- `MilestoneAchievement` → `schema.prisma:L10947`
- `Modifier` → `schema.prisma:L3489`
- `ModifierGroup` → `schema.prisma:L3453`
- `Module` → `schema.prisma:L9260`
- `MoneyAnomaly` → `schema.prisma:L5603`
- `MonthlyVenueProfit` → `schema.prisma:L6146`
- `Notification` → `schema.prisma:L7195`
- `NotificationPreference` → `schema.prisma:L7242`
- `NotificationTemplate` → `schema.prisma:L7269`
- `OAuthState` → `schema.prisma:L1417`
- `OnboardingProgress` → `schema.prisma:L1435`
- `Order` → `schema.prisma:L3104`
- `OrderAction` → `schema.prisma:L3554`
- `OrderCustomer` → `schema.prisma:L3304`
- `OrderDiscount` → `schema.prisma:L7056`
- `OrderFulfillment` → `schema.prisma:L13548`
- `OrderFulfillmentLine` → `schema.prisma:L13579`
- `OrderItem` → `schema.prisma:L3320`
- `OrderItemModifier` → `schema.prisma:L3538`
- `OrderPromotion` → `schema.prisma:L15657`
- `OrderServiceCharge` → `schema.prisma:L7140`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11321`
- `OrganizationEntitlement` → `schema.prisma:L9543`
- `OrganizationGoal` → `schema.prisma:L11279`
- `OrganizationModule` → `schema.prisma:L9320`
- `OrganizationPaymentConfig` → `schema.prisma:L5282`
- `OrganizationPayoutConfig` → `schema.prisma:L11354`
- `OrganizationPricingStructure` → `schema.prisma:L5314`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11302`
- `OtpChallenge` → `schema.prisma:L6376`
- `PartnerAPIKey` → `schema.prisma:L5112`
- `Payment` → `schema.prisma:L3587`
- `PaymentAllocation` → `schema.prisma:L3852`
- `PaymentLink` → `schema.prisma:L12856`
- `PaymentLinkAttribution` → `schema.prisma:L12964`
- `PaymentLinkItem` → `schema.prisma:L12919`
- `PaymentLinkItemModifier` → `schema.prisma:L12946`
- `PaymentProvider` → `schema.prisma:L4667`
- `PayrollLine` → `schema.prisma:L15165`
- `PayrollRun` → `schema.prisma:L15134`
- `PerformanceGoal` → `schema.prisma:L11256`
- `PermissionOverride` → `schema.prisma:L1294`
- `PermissionSet` → `schema.prisma:L1317`
- `PlatformCfdi` → `schema.prisma:L15450`
- `PlatformEmisor` → `schema.prisma:L15390`
- `PlatformSettings` → `schema.prisma:L5089`
- `PosCommand` → `schema.prisma:L7323`
- `PosConnectionStatus` → `schema.prisma:L877`
- `PosSyncIntent` → `schema.prisma:L15528`
- `PricingPolicy` → `schema.prisma:L2370`
- `Printer` → `schema.prisma:L13376`
- `PrintGateway` → `schema.prisma:L13429`
- `PrintJob` → `schema.prisma:L14129`
- `PrintStation` → `schema.prisma:L13447`
- `ProcessedStripeEvent` → `schema.prisma:L5589`
- `ProcessorReliabilityMetric` → `schema.prisma:L6074`
- `Product` → `schema.prisma:L1605`
- `ProductModifierGroup` → `schema.prisma:L3526`
- `ProductOption` → `schema.prisma:L13147`
- `ProductOptionValue` → `schema.prisma:L13158`
- `ProductStaff` → `schema.prisma:L12112`
- `PromoterBankAccount` → `schema.prisma:L15285`
- `PromoterCommissionEntry` → `schema.prisma:L15304`
- `PromoterLocationPing` → `schema.prisma:L3070`
- `Promotion` → `schema.prisma:L15579`
- `PromotionGroup` → `schema.prisma:L15618`
- `PromotionOption` → `schema.prisma:L15634`
- `ProviderCostStructure` → `schema.prisma:L5625`
- `ProviderEventLog` → `schema.prisma:L5391`
- `PurchaseOrder` → `schema.prisma:L2238`
- `PurchaseOrderItem` → `schema.prisma:L2295`
- `RateCorrectionBatch` → `schema.prisma:L5850`
- `RateCorrectionEntry` → `schema.prisma:L5892`
- `RawMaterial` → `schema.prisma:L1999`
- `RawMaterialMovement` → `schema.prisma:L2423`
- `RawMaterialPresentation` → `schema.prisma:L2072`
- `Recipe` → `schema.prisma:L2092`
- `RecipeLine` → `schema.prisma:L2116`
- `Referral` → `schema.prisma:L6511`
- `ReferralProgramConfig` → `schema.prisma:L6476`
- `ReferralRewardGrant` → `schema.prisma:L6602`
- `ReferralTierReward` → `schema.prisma:L6574`
- `ReferralTierUnlock` → `schema.prisma:L6647`
- `Reservation` → `schema.prisma:L11899`
- `ReservationGoogleEventMapping` → `schema.prisma:L12636`
- `ReservationModifier` → `schema.prisma:L12060`
- `ReservationReminderSent` → `schema.prisma:L12043`
- `ReservationSettings` → `schema.prisma:L12274`
- `ReservationWaitlistEntry` → `schema.prisma:L12242`
- `Review` → `schema.prisma:L4147`
- `SalesRetention` → `schema.prisma:L14985`
- `SaleVerification` → `schema.prisma:L3906`
- `ScaleProfile` → `schema.prisma:L13870`
- `ScheduledCommand` → `schema.prisma:L8764`
- `SerializedItem` → `schema.prisma:L10394`
- `SerializedItemCustodyEvent` → `schema.prisma:L10557`
- `ServiceCharge` → `schema.prisma:L7111`
- `SettlementConfiguration` → `schema.prisma:L5925`
- `SettlementConfirmation` → `schema.prisma:L6038`
- `SettlementIncident` → `schema.prisma:L5989`
- `SettlementSimulation` → `schema.prisma:L5960`
- `Shift` → `schema.prisma:L2911`
- `SimRegistrationRequest` → `schema.prisma:L10595`
- `SimRegistrationRequestItem` → `schema.prisma:L10617`
- `SlotHold` → `schema.prisma:L12143`
- `Staff` → `schema.prisma:L897`
- `StaffOnboardingState` → `schema.prisma:L14200`
- `StaffOrganization` → `schema.prisma:L1193`
- `StaffPasskey` → `schema.prisma:L1220`
- `StaffSchedule` → `schema.prisma:L12083`
- `StaffScheduleException` → `schema.prisma:L12095`
- `StaffVenue` → `schema.prisma:L1123`
- `StockAlertConfig` → `schema.prisma:L11238`
- `StockBatch` → `schema.prisma:L2574`
- `StockCount` → `schema.prisma:L2498`
- `StockCountItem` → `schema.prisma:L2522`
- `StripeWebhookEvent` → `schema.prisma:L5572`
- `Supplier` → `schema.prisma:L2151`
- `SupplierPricing` → `schema.prisma:L2204`
- `Table` → `schema.prisma:L2823`
- `Terminal` → `schema.prisma:L4198`
- `TerminalHealth` → `schema.prisma:L4437`
- `TerminalLog` → `schema.prisma:L4411`
- `TerminalOrder` → `schema.prisma:L4570`
- `TerminalOrderItem` → `schema.prisma:L4645`
- `TerminalPaymentRequest` → `schema.prisma:L4508`
- `TimeEntry` → `schema.prisma:L2983`
- `TimeEntryBreak` → `schema.prisma:L3052`
- `TokenPurchase` → `schema.prisma:L8438`
- `TokenUsageRecord` → `schema.prisma:L8410`
- `TpvCommandHistory` → `schema.prisma:L8670`
- `TpvCommandQueue` → `schema.prisma:L8610`
- `TpvFeedback` → `schema.prisma:L8323`
- `TpvMessage` → `schema.prisma:L11595`
- `TpvMessageDelivery` → `schema.prisma:L11647`
- `TpvMessageResponse` → `schema.prisma:L11670`
- `TrainingModule` → `schema.prisma:L11725`
- `TrainingProgress` → `schema.prisma:L11802`
- `TrainingQuizQuestion` → `schema.prisma:L11784`
- `TrainingStep` → `schema.prisma:L11764`
- `TransactionCost` → `schema.prisma:L5788`
- `UnitConversion` → `schema.prisma:L2401`
- `UpsellAcceptance` → `schema.prisma:L6932`
- `UpsellAiRun` → `schema.prisma:L6952`
- `UpsellImpression` → `schema.prisma:L6892`
- `UpsellRule` → `schema.prisma:L6812`
- `user_sessions` → `schema.prisma:L5147`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L13607`
- `VenueChatMessage` → `schema.prisma:L747`
- `VenueChatSession` → `schema.prisma:L702`
- `VenueCommission` → `schema.prisma:L13308`
- `VenueCreditAssessment` → `schema.prisma:L9132`
- `VenueCryptoConfig` → `schema.prisma:L11462`
- `VenueFeature` → `schema.prisma:L4020`
- `VenueModule` → `schema.prisma:L9292`
- `VenuePaymentConfig` → `schema.prisma:L5248`
- `VenuePaymentLinkSettings` → `schema.prisma:L12669`
- `VenuePricingStructure` → `schema.prisma:L5728`
- `VenueRoleConfig` → `schema.prisma:L1346`
- `VenueRolePermission` → `schema.prisma:L1250`
- `VenueScaleSettings` → `schema.prisma:L13858`
- `VenueSettings` → `schema.prisma:L787`
- `VenueTenderType` → `schema.prisma:L3765`
- `VenueTenderTypeRevision` → `schema.prisma:L3830`
- `VenueTransaction` → `schema.prisma:L3957`
- `VenueWhatsappActivation` → `schema.prisma:L638`
- `WebhookEvent` → `schema.prisma:L4056`
- `WebhookSubscription` → `schema.prisma:L5364`
- `WhatsappContactWindow` → `schema.prisma:L656`
- `WhatsappInboundEvent` → `schema.prisma:L676`
- `Zone` → `schema.prisma:L142`
