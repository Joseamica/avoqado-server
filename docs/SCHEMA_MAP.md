# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **329 models / 320 enums / ~15,400 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
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

- `AccountingPeriodLock` → `schema.prisma:L14632`
- `AccountMapping` → `schema.prisma:L14528`
- `ActivityLog` → `schema.prisma:L6017`
- `Aggregator` → `schema.prisma:L12980`
- `AngelPayUserAccount` → `schema.prisma:L4726`
- `AppUpdate` → `schema.prisma:L11200`
- `Area` → `schema.prisma:L2764`
- `AreaTicket` → `schema.prisma:L13423`
- `AreaTicketCheckoutSession` → `schema.prisma:L13545`
- `AreaTicketExternalIncident` → `schema.prisma:L13792`
- `AreaTicketExternalSettlement` → `schema.prisma:L13757`
- `AreaTicketFulfillment` → `schema.prisma:L13621`
- `AreaTicketInventoryReservation` → `schema.prisma:L13516`
- `AreaTicketLine` → `schema.prisma:L13484`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13577`
- `AreaTicketPrintAttempt` → `schema.prisma:L13600`
- `BankStatement` → `schema.prisma:L14402`
- `BankStatementLine` → `schema.prisma:L14423`
- `BillingTaxProfile` → `schema.prisma:L15212`
- `BulkCommandOperation` → `schema.prisma:L8514`
- `CalendarSyncOutbox` → `schema.prisma:L12374`
- `CampaignDelivery` → `schema.prisma:L11358`
- `CashCloseout` → `schema.prisma:L8879`
- `CashDeposit` → `schema.prisma:L11002`
- `CashDrawerEvent` → `schema.prisma:L12817`
- `CashDrawerSession` → `schema.prisma:L12793`
- `CashOutCommissionRate` → `schema.prisma:L15041`
- `CashOutScheduleDay` → `schema.prisma:L15064`
- `CashOutWithdrawal` → `schema.prisma:L15126`
- `CatalogBindingBatch` → `schema.prisma:L9910`
- `CatalogBindingLine` → `schema.prisma:L9946`
- `CatalogBrand` → `schema.prisma:L9363`
- `CatalogClientObservation` → `schema.prisma:L9676`
- `CatalogClientReadinessOverride` → `schema.prisma:L9695`
- `CatalogFamily` → `schema.prisma:L9413`
- `CatalogIdempotencyRecord` → `schema.prisma:L9809`
- `CatalogIdentifier` → `schema.prisma:L9544`
- `CatalogImportBatch` → `schema.prisma:L9852`
- `CatalogImportLine` → `schema.prisma:L9889`
- `CatalogItem` → `schema.prisma:L9446`
- `CatalogItemBusinessType` → `schema.prisma:L9506`
- `CatalogItemPrice` → `schema.prisma:L9594`
- `CatalogManufacturer` → `schema.prisma:L9387`
- `CatalogProductTypeMapping` → `schema.prisma:L9523`
- `CatalogPublicationBatch` → `schema.prisma:L9974`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10068`
- `CatalogPublicationLine` → `schema.prisma:L10015`
- `CatalogPublicationOutbox` → `schema.prisma:L10111`
- `CatalogValidationProfile` → `schema.prisma:L9565`
- `CatalogVenueBinding` → `schema.prisma:L9723`
- `CatalogVenueClientRequirement` → `schema.prisma:L9650`
- `CatalogVenueEventSequence` → `schema.prisma:L10094`
- `CatalogVenueOverride` → `schema.prisma:L9765`
- `CatalogVenueRollout` → `schema.prisma:L9625`
- `Cfdi` → `schema.prisma:L14305`
- `ChatbotTokenBudget` → `schema.prisma:L8162`
- `ChatConversation` → `schema.prisma:L8017`
- `ChatFeedback` → `schema.prisma:L8103`
- `ChatLearningEvent` → `schema.prisma:L8060`
- `ChatMessage` → `schema.prisma:L8040`
- `ChatTrainingData` → `schema.prisma:L7974`
- `CheckoutSession` → `schema.prisma:L5006`
- `ClassSession` → `schema.prisma:L11992`
- `CommissionCalculation` → `schema.prisma:L10781`
- `CommissionClawback` → `schema.prisma:L10954`
- `CommissionConfig` → `schema.prisma:L10554`
- `CommissionMilestone` → `schema.prisma:L10697`
- `CommissionOverride` → `schema.prisma:L10624`
- `CommissionPayout` → `schema.prisma:L10905`
- `CommissionSummary` → `schema.prisma:L10844`
- `CommissionTier` → `schema.prisma:L10661`
- `Consumer` → `schema.prisma:L6153`
- `ConsumerAuthAccount` → `schema.prisma:L6178`
- `CouponCode` → `schema.prisma:L6784`
- `CouponRedemption` → `schema.prisma:L6815`
- `CreditAssessmentHistory` → `schema.prisma:L8988`
- `CreditItemBalance` → `schema.prisma:L12583`
- `CreditOffer` → `schema.prisma:L9007`
- `CreditPack` → `schema.prisma:L12499`
- `CreditPackItem` → `schema.prisma:L12528`
- `CreditPackPurchase` → `schema.prisma:L12545`
- `CreditTransaction` → `schema.prisma:L12605`
- `Customer` → `schema.prisma:L6058`
- `CustomerDiscount` → `schema.prisma:L6835`
- `CustomerGroup` → `schema.prisma:L6212`
- `CustomerTaxProfile` → `schema.prisma:L14374`
- `DeliveryActivationRequest` → `schema.prisma:L5328`
- `DeliveryChannelLink` → `schema.prisma:L5292`
- `DeliveryOrderEvent` → `schema.prisma:L5352`
- `DeviceToken` → `schema.prisma:L7104`
- `DigitalReceipt` → `schema.prisma:L3727`
- `Discount` → `schema.prisma:L6484`
- `EcommerceMerchant` → `schema.prisma:L4818`
- `EmailTemplate` → `schema.prisma:L11297`
- `Employee` → `schema.prisma:L14889`
- `Estimate` → `schema.prisma:L12887`
- `EstimateItem` → `schema.prisma:L12915`
- `Expense` → `schema.prisma:L14676`
- `ExternalBusyBlock` → `schema.prisma:L12267`
- `Feature` → `schema.prisma:L3856`
- `FeeSchedule` → `schema.prisma:L3934`
- `FeeTier` → `schema.prisma:L3945`
- `FinancialAccount` → `schema.prisma:L13077`
- `FinancialConnection` → `schema.prisma:L13046`
- `FinancialProvider` → `schema.prisma:L13032`
- `FiscalEmisor` → `schema.prisma:L14228`
- `FiscalLossCarryforward` → `schema.prisma:L14799`
- `FixedAsset` → `schema.prisma:L14817`
- `FixedAssetDepreciation` → `schema.prisma:L14846`
- `FloorElement` → `schema.prisma:L2840`
- `FulfillmentArea` → `schema.prisma:L13288`
- `GeofenceRule` → `schema.prisma:L8599`
- `GoogleCalendarChannel` → `schema.prisma:L12244`
- `GoogleCalendarConnection` → `schema.prisma:L12196`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12297`
- `GoogleOAuthSession` → `schema.prisma:L12319`
- `HolidayCalendar` → `schema.prisma:L5941`
- `IdempotencyRequest` → `schema.prisma:L10429`
- `InterVenueTransfer` → `schema.prisma:L2592`
- `InterVenueTransferAllocation` → `schema.prisma:L2675`
- `InterVenueTransferItem` → `schema.prisma:L2644`
- `InterVenueTransferReceipt` → `schema.prisma:L2702`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2718`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2746`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2730`
- `Inventory` → `schema.prisma:L1791`
- `InventoryMovement` → `schema.prisma:L1818`
- `InventoryPosting` → `schema.prisma:L1900`
- `InventoryPostingLine` → `schema.prisma:L1934`
- `InventoryTransfer` → `schema.prisma:L12859`
- `Invitation` → `schema.prisma:L1339`
- `Invoice` → `schema.prisma:L3957`
- `InvoiceItem` → `schema.prisma:L3983`
- `ItemCategory` → `schema.prisma:L10146`
- `JournalEntry` → `schema.prisma:L14586`
- `JournalLine` → `schema.prisma:L14614`
- `KdsOrder` → `schema.prisma:L13125`
- `KdsOrderItem` → `schema.prisma:L13142`
- `LearnedPatterns` → `schema.prisma:L8084`
- `LedgerAccount` → `schema.prisma:L14478`
- `LiveDemoSession` → `schema.prisma:L758`
- `LowStockAlert` → `schema.prisma:L2433`
- `LoyaltyConfig` → `schema.prisma:L6242`
- `LoyaltyTransaction` → `schema.prisma:L6265`
- `MarketingCampaign` → `schema.prisma:L11315`
- `McpAuthCode` → `schema.prisma:L14111`
- `McpOAuthClient` → `schema.prisma:L14095`
- `McpRefreshToken` → `schema.prisma:L14129`
- `McpToolCall` → `schema.prisma:L14150`
- `MeasurementUnit` → `schema.prisma:L12965`
- `Menu` → `schema.prisma:L1525`
- `MenuCategory` → `schema.prisma:L1462`
- `MenuCategoryAssignment` → `schema.prisma:L1560`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14025`
- `MerchantAccount` → `schema.prisma:L4556`
- `MerchantFiscalConfig` → `schema.prisma:L14276`
- `MerchantRevenueShare` → `schema.prisma:L5521`
- `MerchantRoutingRule` → `schema.prisma:L4678`
- `MilestoneAchievement` → `schema.prisma:L10742`
- `Modifier` → `schema.prisma:L3456`
- `ModifierGroup` → `schema.prisma:L3420`
- `Module` → `schema.prisma:L9055`
- `MoneyAnomaly` → `schema.prisma:L5424`
- `MonthlyVenueProfit` → `schema.prisma:L5967`
- `Notification` → `schema.prisma:L7006`
- `NotificationPreference` → `schema.prisma:L7053`
- `NotificationTemplate` → `schema.prisma:L7080`
- `OAuthState` → `schema.prisma:L1390`
- `OnboardingProgress` → `schema.prisma:L1408`
- `Order` → `schema.prisma:L3071`
- `OrderAction` → `schema.prisma:L3521`
- `OrderCustomer` → `schema.prisma:L3271`
- `OrderDiscount` → `schema.prisma:L6867`
- `OrderFulfillment` → `schema.prisma:L13343`
- `OrderFulfillmentLine` → `schema.prisma:L13374`
- `OrderItem` → `schema.prisma:L3287`
- `OrderItemModifier` → `schema.prisma:L3505`
- `OrderPromotion` → `schema.prisma:L15452`
- `OrderServiceCharge` → `schema.prisma:L6951`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11116`
- `OrganizationEntitlement` → `schema.prisma:L9338`
- `OrganizationGoal` → `schema.prisma:L11074`
- `OrganizationModule` → `schema.prisma:L9115`
- `OrganizationPaymentConfig` → `schema.prisma:L5130`
- `OrganizationPayoutConfig` → `schema.prisma:L11149`
- `OrganizationPricingStructure` → `schema.prisma:L5162`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11097`
- `OtpChallenge` → `schema.prisma:L6197`
- `PartnerAPIKey` → `schema.prisma:L4960`
- `Payment` → `schema.prisma:L3554`
- `PaymentAllocation` → `schema.prisma:L3706`
- `PaymentLink` → `schema.prisma:L12651`
- `PaymentLinkAttribution` → `schema.prisma:L12759`
- `PaymentLinkItem` → `schema.prisma:L12714`
- `PaymentLinkItemModifier` → `schema.prisma:L12741`
- `PaymentProvider` → `schema.prisma:L4515`
- `PayrollLine` → `schema.prisma:L14960`
- `PayrollRun` → `schema.prisma:L14929`
- `PerformanceGoal` → `schema.prisma:L11051`
- `PermissionOverride` → `schema.prisma:L1267`
- `PermissionSet` → `schema.prisma:L1290`
- `PlatformCfdi` → `schema.prisma:L15245`
- `PlatformEmisor` → `schema.prisma:L15185`
- `PlatformSettings` → `schema.prisma:L4937`
- `PosCommand` → `schema.prisma:L7134`
- `PosConnectionStatus` → `schema.prisma:L864`
- `PosSyncIntent` → `schema.prisma:L15323`
- `PricingPolicy` → `schema.prisma:L2337`
- `Printer` → `schema.prisma:L13171`
- `PrintGateway` → `schema.prisma:L13224`
- `PrintJob` → `schema.prisma:L13924`
- `PrintStation` → `schema.prisma:L13242`
- `ProcessedStripeEvent` → `schema.prisma:L5410`
- `ProcessorReliabilityMetric` → `schema.prisma:L5895`
- `Product` → `schema.prisma:L1578`
- `ProductModifierGroup` → `schema.prisma:L3493`
- `ProductOption` → `schema.prisma:L12942`
- `ProductOptionValue` → `schema.prisma:L12953`
- `ProductStaff` → `schema.prisma:L11907`
- `PromoterBankAccount` → `schema.prisma:L15080`
- `PromoterCommissionEntry` → `schema.prisma:L15099`
- `PromoterLocationPing` → `schema.prisma:L3037`
- `Promotion` → `schema.prisma:L15374`
- `PromotionGroup` → `schema.prisma:L15413`
- `PromotionOption` → `schema.prisma:L15429`
- `ProviderCostStructure` → `schema.prisma:L5446`
- `ProviderEventLog` → `schema.prisma:L5239`
- `PurchaseOrder` → `schema.prisma:L2205`
- `PurchaseOrderItem` → `schema.prisma:L2262`
- `RateCorrectionBatch` → `schema.prisma:L5671`
- `RateCorrectionEntry` → `schema.prisma:L5713`
- `RawMaterial` → `schema.prisma:L1966`
- `RawMaterialMovement` → `schema.prisma:L2390`
- `RawMaterialPresentation` → `schema.prisma:L2039`
- `Recipe` → `schema.prisma:L2059`
- `RecipeLine` → `schema.prisma:L2083`
- `Referral` → `schema.prisma:L6332`
- `ReferralProgramConfig` → `schema.prisma:L6297`
- `ReferralRewardGrant` → `schema.prisma:L6423`
- `ReferralTierReward` → `schema.prisma:L6395`
- `ReferralTierUnlock` → `schema.prisma:L6468`
- `Reservation` → `schema.prisma:L11694`
- `ReservationGoogleEventMapping` → `schema.prisma:L12431`
- `ReservationModifier` → `schema.prisma:L11855`
- `ReservationReminderSent` → `schema.prisma:L11838`
- `ReservationSettings` → `schema.prisma:L12069`
- `ReservationWaitlistEntry` → `schema.prisma:L12037`
- `Review` → `schema.prisma:L4001`
- `SalesRetention` → `schema.prisma:L14780`
- `SaleVerification` → `schema.prisma:L3760`
- `ScaleProfile` → `schema.prisma:L13665`
- `ScheduledCommand` → `schema.prisma:L8559`
- `SerializedItem` → `schema.prisma:L10189`
- `SerializedItemCustodyEvent` → `schema.prisma:L10352`
- `ServiceCharge` → `schema.prisma:L6922`
- `SettlementConfiguration` → `schema.prisma:L5746`
- `SettlementConfirmation` → `schema.prisma:L5859`
- `SettlementIncident` → `schema.prisma:L5810`
- `SettlementSimulation` → `schema.prisma:L5781`
- `Shift` → `schema.prisma:L2878`
- `SimRegistrationRequest` → `schema.prisma:L10390`
- `SimRegistrationRequestItem` → `schema.prisma:L10412`
- `SlotHold` → `schema.prisma:L11938`
- `Staff` → `schema.prisma:L884`
- `StaffOnboardingState` → `schema.prisma:L13995`
- `StaffOrganization` → `schema.prisma:L1180`
- `StaffPasskey` → `schema.prisma:L1207`
- `StaffSchedule` → `schema.prisma:L11878`
- `StaffScheduleException` → `schema.prisma:L11890`
- `StaffVenue` → `schema.prisma:L1110`
- `StockAlertConfig` → `schema.prisma:L11033`
- `StockBatch` → `schema.prisma:L2541`
- `StockCount` → `schema.prisma:L2465`
- `StockCountItem` → `schema.prisma:L2489`
- `StripeWebhookEvent` → `schema.prisma:L5393`
- `Supplier` → `schema.prisma:L2118`
- `SupplierPricing` → `schema.prisma:L2171`
- `Table` → `schema.prisma:L2790`
- `Terminal` → `schema.prisma:L4052`
- `TerminalHealth` → `schema.prisma:L4291`
- `TerminalLog` → `schema.prisma:L4265`
- `TerminalOrder` → `schema.prisma:L4418`
- `TerminalOrderItem` → `schema.prisma:L4493`
- `TerminalPaymentRequest` → `schema.prisma:L4362`
- `TimeEntry` → `schema.prisma:L2950`
- `TimeEntryBreak` → `schema.prisma:L3019`
- `TokenPurchase` → `schema.prisma:L8233`
- `TokenUsageRecord` → `schema.prisma:L8205`
- `TpvCommandHistory` → `schema.prisma:L8465`
- `TpvCommandQueue` → `schema.prisma:L8405`
- `TpvFeedback` → `schema.prisma:L8118`
- `TpvMessage` → `schema.prisma:L11390`
- `TpvMessageDelivery` → `schema.prisma:L11442`
- `TpvMessageResponse` → `schema.prisma:L11465`
- `TrainingModule` → `schema.prisma:L11520`
- `TrainingProgress` → `schema.prisma:L11597`
- `TrainingQuizQuestion` → `schema.prisma:L11579`
- `TrainingStep` → `schema.prisma:L11559`
- `TransactionCost` → `schema.prisma:L5609`
- `UnitConversion` → `schema.prisma:L2368`
- `UpsellAcceptance` → `schema.prisma:L6743`
- `UpsellAiRun` → `schema.prisma:L6763`
- `UpsellImpression` → `schema.prisma:L6703`
- `UpsellRule` → `schema.prisma:L6633`
- `user_sessions` → `schema.prisma:L4995`
- `Venue` → `schema.prisma:L147`
- `VenueAreaTicketSettings` → `schema.prisma:L13402`
- `VenueChatMessage` → `schema.prisma:L734`
- `VenueChatSession` → `schema.prisma:L689`
- `VenueCommission` → `schema.prisma:L13103`
- `VenueCreditAssessment` → `schema.prisma:L8927`
- `VenueCryptoConfig` → `schema.prisma:L11257`
- `VenueFeature` → `schema.prisma:L3874`
- `VenueModule` → `schema.prisma:L9087`
- `VenuePaymentConfig` → `schema.prisma:L5096`
- `VenuePaymentLinkSettings` → `schema.prisma:L12464`
- `VenuePricingStructure` → `schema.prisma:L5549`
- `VenueRoleConfig` → `schema.prisma:L1319`
- `VenueRolePermission` → `schema.prisma:L1237`
- `VenueScaleSettings` → `schema.prisma:L13653`
- `VenueSettings` → `schema.prisma:L774`
- `VenueTransaction` → `schema.prisma:L3811`
- `VenueWhatsappActivation` → `schema.prisma:L625`
- `WebhookEvent` → `schema.prisma:L3910`
- `WebhookSubscription` → `schema.prisma:L5212`
- `WhatsappContactWindow` → `schema.prisma:L643`
- `WhatsappInboundEvent` → `schema.prisma:L663`
- `Zone` → `schema.prisma:L130`
