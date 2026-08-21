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

- `AccountingPeriodLock` → `schema.prisma:L14843`
- `AccountMapping` → `schema.prisma:L14739`
- `ActivityLog` → `schema.prisma:L6202`
- `Aggregator` → `schema.prisma:L13191`
- `AngelPayUserAccount` → `schema.prisma:L4878`
- `AppUpdate` → `schema.prisma:L11411`
- `Area` → `schema.prisma:L2797`
- `AreaTicket` → `schema.prisma:L13634`
- `AreaTicketCheckoutSession` → `schema.prisma:L13756`
- `AreaTicketExternalIncident` → `schema.prisma:L14003`
- `AreaTicketExternalSettlement` → `schema.prisma:L13968`
- `AreaTicketFulfillment` → `schema.prisma:L13832`
- `AreaTicketInventoryReservation` → `schema.prisma:L13727`
- `AreaTicketLine` → `schema.prisma:L13695`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13788`
- `AreaTicketPrintAttempt` → `schema.prisma:L13811`
- `BankStatement` → `schema.prisma:L14613`
- `BankStatementLine` → `schema.prisma:L14634`
- `BillingTaxProfile` → `schema.prisma:L15423`
- `BulkCommandOperation` → `schema.prisma:L8725`
- `CalendarSyncOutbox` → `schema.prisma:L12585`
- `CampaignDelivery` → `schema.prisma:L11569`
- `CashCloseout` → `schema.prisma:L9090`
- `CashDeposit` → `schema.prisma:L11213`
- `CashDrawerEvent` → `schema.prisma:L13028`
- `CashDrawerSession` → `schema.prisma:L13004`
- `CashOutCommissionRate` → `schema.prisma:L15252`
- `CashOutScheduleDay` → `schema.prisma:L15275`
- `CashOutWithdrawal` → `schema.prisma:L15337`
- `CatalogBindingBatch` → `schema.prisma:L10121`
- `CatalogBindingLine` → `schema.prisma:L10157`
- `CatalogBrand` → `schema.prisma:L9574`
- `CatalogClientObservation` → `schema.prisma:L9887`
- `CatalogClientReadinessOverride` → `schema.prisma:L9906`
- `CatalogFamily` → `schema.prisma:L9624`
- `CatalogIdempotencyRecord` → `schema.prisma:L10020`
- `CatalogIdentifier` → `schema.prisma:L9755`
- `CatalogImportBatch` → `schema.prisma:L10063`
- `CatalogImportLine` → `schema.prisma:L10100`
- `CatalogItem` → `schema.prisma:L9657`
- `CatalogItemBusinessType` → `schema.prisma:L9717`
- `CatalogItemPrice` → `schema.prisma:L9805`
- `CatalogManufacturer` → `schema.prisma:L9598`
- `CatalogProductTypeMapping` → `schema.prisma:L9734`
- `CatalogPublicationBatch` → `schema.prisma:L10185`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10279`
- `CatalogPublicationLine` → `schema.prisma:L10226`
- `CatalogPublicationOutbox` → `schema.prisma:L10322`
- `CatalogValidationProfile` → `schema.prisma:L9776`
- `CatalogVenueBinding` → `schema.prisma:L9934`
- `CatalogVenueClientRequirement` → `schema.prisma:L9861`
- `CatalogVenueEventSequence` → `schema.prisma:L10305`
- `CatalogVenueOverride` → `schema.prisma:L9976`
- `CatalogVenueRollout` → `schema.prisma:L9836`
- `Cfdi` → `schema.prisma:L14516`
- `ChatbotTokenBudget` → `schema.prisma:L8373`
- `ChatConversation` → `schema.prisma:L8228`
- `ChatFeedback` → `schema.prisma:L8314`
- `ChatLearningEvent` → `schema.prisma:L8271`
- `ChatMessage` → `schema.prisma:L8251`
- `ChatTrainingData` → `schema.prisma:L8185`
- `CheckoutSession` → `schema.prisma:L5158`
- `ClassSession` → `schema.prisma:L12203`
- `CommissionCalculation` → `schema.prisma:L10992`
- `CommissionClawback` → `schema.prisma:L11165`
- `CommissionConfig` → `schema.prisma:L10765`
- `CommissionMilestone` → `schema.prisma:L10908`
- `CommissionOverride` → `schema.prisma:L10835`
- `CommissionPayout` → `schema.prisma:L11116`
- `CommissionSummary` → `schema.prisma:L11055`
- `CommissionTier` → `schema.prisma:L10872`
- `Consumer` → `schema.prisma:L6338`
- `ConsumerAuthAccount` → `schema.prisma:L6363`
- `CouponCode` → `schema.prisma:L6979`
- `CouponRedemption` → `schema.prisma:L7010`
- `CreditAssessmentHistory` → `schema.prisma:L9199`
- `CreditItemBalance` → `schema.prisma:L12794`
- `CreditOffer` → `schema.prisma:L9218`
- `CreditPack` → `schema.prisma:L12710`
- `CreditPackItem` → `schema.prisma:L12739`
- `CreditPackPurchase` → `schema.prisma:L12756`
- `CreditTransaction` → `schema.prisma:L12816`
- `Customer` → `schema.prisma:L6243`
- `CustomerDiscount` → `schema.prisma:L7030`
- `CustomerGroup` → `schema.prisma:L6397`
- `CustomerTaxProfile` → `schema.prisma:L14585`
- `DeliveryActivationRequest` → `schema.prisma:L5486`
- `DeliveryChannelLink` → `schema.prisma:L5444`
- `DeliveryOrderEvent` → `schema.prisma:L5510`
- `DeviceToken` → `schema.prisma:L7299`
- `DigitalReceipt` → `schema.prisma:L3873`
- `Discount` → `schema.prisma:L6669`
- `EcommerceMerchant` → `schema.prisma:L4970`
- `EmailTemplate` → `schema.prisma:L11508`
- `Employee` → `schema.prisma:L15100`
- `Estimate` → `schema.prisma:L13098`
- `EstimateItem` → `schema.prisma:L13126`
- `Expense` → `schema.prisma:L14887`
- `ExternalBusyBlock` → `schema.prisma:L12478`
- `Feature` → `schema.prisma:L4002`
- `FeeSchedule` → `schema.prisma:L4080`
- `FeeTier` → `schema.prisma:L4091`
- `FinancialAccount` → `schema.prisma:L13288`
- `FinancialConnection` → `schema.prisma:L13257`
- `FinancialProvider` → `schema.prisma:L13243`
- `FiscalEmisor` → `schema.prisma:L14439`
- `FiscalLossCarryforward` → `schema.prisma:L15010`
- `FixedAsset` → `schema.prisma:L15028`
- `FixedAssetDepreciation` → `schema.prisma:L15057`
- `FloorElement` → `schema.prisma:L2873`
- `FulfillmentArea` → `schema.prisma:L13499`
- `GeofenceRule` → `schema.prisma:L8810`
- `GoogleCalendarChannel` → `schema.prisma:L12455`
- `GoogleCalendarConnection` → `schema.prisma:L12407`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12508`
- `GoogleOAuthSession` → `schema.prisma:L12530`
- `HolidayCalendar` → `schema.prisma:L6126`
- `IdempotencyRequest` → `schema.prisma:L10640`
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
- `InventoryTransfer` → `schema.prisma:L13070`
- `Invitation` → `schema.prisma:L1366`
- `Invoice` → `schema.prisma:L4103`
- `InvoiceItem` → `schema.prisma:L4129`
- `ItemCategory` → `schema.prisma:L10357`
- `JournalEntry` → `schema.prisma:L14797`
- `JournalLine` → `schema.prisma:L14825`
- `KdsOrder` → `schema.prisma:L13336`
- `KdsOrderItem` → `schema.prisma:L13353`
- `LearnedPatterns` → `schema.prisma:L8295`
- `LedgerAccount` → `schema.prisma:L14689`
- `LiveDemoSession` → `schema.prisma:L771`
- `LowStockAlert` → `schema.prisma:L2466`
- `LoyaltyConfig` → `schema.prisma:L6427`
- `LoyaltyTransaction` → `schema.prisma:L6450`
- `MarketingCampaign` → `schema.prisma:L11526`
- `McpAuthCode` → `schema.prisma:L14322`
- `McpOAuthClient` → `schema.prisma:L14306`
- `McpRefreshToken` → `schema.prisma:L14340`
- `McpToolCall` → `schema.prisma:L14361`
- `MeasurementUnit` → `schema.prisma:L13176`
- `Menu` → `schema.prisma:L1552`
- `MenuCategory` → `schema.prisma:L1489`
- `MenuCategoryAssignment` → `schema.prisma:L1587`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14236`
- `MerchantAccount` → `schema.prisma:L4708`
- `MerchantFiscalConfig` → `schema.prisma:L14487`
- `MerchantRevenueShare` → `schema.prisma:L5706`
- `MerchantRoutingRule` → `schema.prisma:L4830`
- `MilestoneAchievement` → `schema.prisma:L10953`
- `Modifier` → `schema.prisma:L3489`
- `ModifierGroup` → `schema.prisma:L3453`
- `Module` → `schema.prisma:L9266`
- `MoneyAnomaly` → `schema.prisma:L5609`
- `MonthlyVenueProfit` → `schema.prisma:L6152`
- `Notification` → `schema.prisma:L7201`
- `NotificationPreference` → `schema.prisma:L7248`
- `NotificationTemplate` → `schema.prisma:L7275`
- `OAuthState` → `schema.prisma:L1417`
- `OnboardingProgress` → `schema.prisma:L1435`
- `Order` → `schema.prisma:L3104`
- `OrderAction` → `schema.prisma:L3554`
- `OrderCustomer` → `schema.prisma:L3304`
- `OrderDiscount` → `schema.prisma:L7062`
- `OrderFulfillment` → `schema.prisma:L13554`
- `OrderFulfillmentLine` → `schema.prisma:L13585`
- `OrderItem` → `schema.prisma:L3320`
- `OrderItemModifier` → `schema.prisma:L3538`
- `OrderPromotion` → `schema.prisma:L15663`
- `OrderServiceCharge` → `schema.prisma:L7146`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11327`
- `OrganizationEntitlement` → `schema.prisma:L9549`
- `OrganizationGoal` → `schema.prisma:L11285`
- `OrganizationModule` → `schema.prisma:L9326`
- `OrganizationPaymentConfig` → `schema.prisma:L5282`
- `OrganizationPayoutConfig` → `schema.prisma:L11360`
- `OrganizationPricingStructure` → `schema.prisma:L5314`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11308`
- `OtpChallenge` → `schema.prisma:L6382`
- `PartnerAPIKey` → `schema.prisma:L5112`
- `Payment` → `schema.prisma:L3587`
- `PaymentAllocation` → `schema.prisma:L3852`
- `PaymentLink` → `schema.prisma:L12862`
- `PaymentLinkAttribution` → `schema.prisma:L12970`
- `PaymentLinkItem` → `schema.prisma:L12925`
- `PaymentLinkItemModifier` → `schema.prisma:L12952`
- `PaymentProvider` → `schema.prisma:L4667`
- `PayrollLine` → `schema.prisma:L15171`
- `PayrollRun` → `schema.prisma:L15140`
- `PerformanceGoal` → `schema.prisma:L11262`
- `PermissionOverride` → `schema.prisma:L1294`
- `PermissionSet` → `schema.prisma:L1317`
- `PlatformCfdi` → `schema.prisma:L15456`
- `PlatformEmisor` → `schema.prisma:L15396`
- `PlatformSettings` → `schema.prisma:L5089`
- `PosCommand` → `schema.prisma:L7329`
- `PosConnectionStatus` → `schema.prisma:L877`
- `PosSyncIntent` → `schema.prisma:L15534`
- `PricingPolicy` → `schema.prisma:L2370`
- `Printer` → `schema.prisma:L13382`
- `PrintGateway` → `schema.prisma:L13435`
- `PrintJob` → `schema.prisma:L14135`
- `PrintStation` → `schema.prisma:L13453`
- `ProcessedStripeEvent` → `schema.prisma:L5595`
- `ProcessorReliabilityMetric` → `schema.prisma:L6080`
- `Product` → `schema.prisma:L1605`
- `ProductModifierGroup` → `schema.prisma:L3526`
- `ProductOption` → `schema.prisma:L13153`
- `ProductOptionValue` → `schema.prisma:L13164`
- `ProductStaff` → `schema.prisma:L12118`
- `PromoterBankAccount` → `schema.prisma:L15291`
- `PromoterCommissionEntry` → `schema.prisma:L15310`
- `PromoterLocationPing` → `schema.prisma:L3070`
- `Promotion` → `schema.prisma:L15585`
- `PromotionGroup` → `schema.prisma:L15624`
- `PromotionOption` → `schema.prisma:L15640`
- `ProviderCostStructure` → `schema.prisma:L5631`
- `ProviderEventLog` → `schema.prisma:L5391`
- `PurchaseOrder` → `schema.prisma:L2238`
- `PurchaseOrderItem` → `schema.prisma:L2295`
- `RateCorrectionBatch` → `schema.prisma:L5856`
- `RateCorrectionEntry` → `schema.prisma:L5898`
- `RawMaterial` → `schema.prisma:L1999`
- `RawMaterialMovement` → `schema.prisma:L2423`
- `RawMaterialPresentation` → `schema.prisma:L2072`
- `Recipe` → `schema.prisma:L2092`
- `RecipeLine` → `schema.prisma:L2116`
- `Referral` → `schema.prisma:L6517`
- `ReferralProgramConfig` → `schema.prisma:L6482`
- `ReferralRewardGrant` → `schema.prisma:L6608`
- `ReferralTierReward` → `schema.prisma:L6580`
- `ReferralTierUnlock` → `schema.prisma:L6653`
- `Reservation` → `schema.prisma:L11905`
- `ReservationGoogleEventMapping` → `schema.prisma:L12642`
- `ReservationModifier` → `schema.prisma:L12066`
- `ReservationReminderSent` → `schema.prisma:L12049`
- `ReservationSettings` → `schema.prisma:L12280`
- `ReservationWaitlistEntry` → `schema.prisma:L12248`
- `Review` → `schema.prisma:L4147`
- `SalesRetention` → `schema.prisma:L14991`
- `SaleVerification` → `schema.prisma:L3906`
- `ScaleProfile` → `schema.prisma:L13876`
- `ScheduledCommand` → `schema.prisma:L8770`
- `SerializedItem` → `schema.prisma:L10400`
- `SerializedItemCustodyEvent` → `schema.prisma:L10563`
- `ServiceCharge` → `schema.prisma:L7117`
- `SettlementConfiguration` → `schema.prisma:L5931`
- `SettlementConfirmation` → `schema.prisma:L6044`
- `SettlementIncident` → `schema.prisma:L5995`
- `SettlementSimulation` → `schema.prisma:L5966`
- `Shift` → `schema.prisma:L2911`
- `SimRegistrationRequest` → `schema.prisma:L10601`
- `SimRegistrationRequestItem` → `schema.prisma:L10623`
- `SlotHold` → `schema.prisma:L12149`
- `Staff` → `schema.prisma:L897`
- `StaffOnboardingState` → `schema.prisma:L14206`
- `StaffOrganization` → `schema.prisma:L1193`
- `StaffPasskey` → `schema.prisma:L1220`
- `StaffSchedule` → `schema.prisma:L12089`
- `StaffScheduleException` → `schema.prisma:L12101`
- `StaffVenue` → `schema.prisma:L1123`
- `StockAlertConfig` → `schema.prisma:L11244`
- `StockBatch` → `schema.prisma:L2574`
- `StockCount` → `schema.prisma:L2498`
- `StockCountItem` → `schema.prisma:L2522`
- `StripeWebhookEvent` → `schema.prisma:L5578`
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
- `TokenPurchase` → `schema.prisma:L8444`
- `TokenUsageRecord` → `schema.prisma:L8416`
- `TpvCommandHistory` → `schema.prisma:L8676`
- `TpvCommandQueue` → `schema.prisma:L8616`
- `TpvFeedback` → `schema.prisma:L8329`
- `TpvMessage` → `schema.prisma:L11601`
- `TpvMessageDelivery` → `schema.prisma:L11653`
- `TpvMessageResponse` → `schema.prisma:L11676`
- `TrainingModule` → `schema.prisma:L11731`
- `TrainingProgress` → `schema.prisma:L11808`
- `TrainingQuizQuestion` → `schema.prisma:L11790`
- `TrainingStep` → `schema.prisma:L11770`
- `TransactionCost` → `schema.prisma:L5794`
- `UnitConversion` → `schema.prisma:L2401`
- `UpsellAcceptance` → `schema.prisma:L6938`
- `UpsellAiRun` → `schema.prisma:L6958`
- `UpsellImpression` → `schema.prisma:L6898`
- `UpsellRule` → `schema.prisma:L6818`
- `user_sessions` → `schema.prisma:L5147`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L13613`
- `VenueChatMessage` → `schema.prisma:L747`
- `VenueChatSession` → `schema.prisma:L702`
- `VenueCommission` → `schema.prisma:L13314`
- `VenueCreditAssessment` → `schema.prisma:L9138`
- `VenueCryptoConfig` → `schema.prisma:L11468`
- `VenueFeature` → `schema.prisma:L4020`
- `VenueModule` → `schema.prisma:L9298`
- `VenuePaymentConfig` → `schema.prisma:L5248`
- `VenuePaymentLinkSettings` → `schema.prisma:L12675`
- `VenuePricingStructure` → `schema.prisma:L5734`
- `VenueRoleConfig` → `schema.prisma:L1346`
- `VenueRolePermission` → `schema.prisma:L1250`
- `VenueScaleSettings` → `schema.prisma:L13864`
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
