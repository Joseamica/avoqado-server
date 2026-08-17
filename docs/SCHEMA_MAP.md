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

- `AccountingPeriodLock` → `schema.prisma:L14778`
- `AccountMapping` → `schema.prisma:L14674`
- `ActivityLog` → `schema.prisma:L6137`
- `Aggregator` → `schema.prisma:L13126`
- `AngelPayUserAccount` → `schema.prisma:L4846`
- `AppUpdate` → `schema.prisma:L11346`
- `Area` → `schema.prisma:L2771`
- `AreaTicket` → `schema.prisma:L13569`
- `AreaTicketCheckoutSession` → `schema.prisma:L13691`
- `AreaTicketExternalIncident` → `schema.prisma:L13938`
- `AreaTicketExternalSettlement` → `schema.prisma:L13903`
- `AreaTicketFulfillment` → `schema.prisma:L13767`
- `AreaTicketInventoryReservation` → `schema.prisma:L13662`
- `AreaTicketLine` → `schema.prisma:L13630`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13723`
- `AreaTicketPrintAttempt` → `schema.prisma:L13746`
- `BankStatement` → `schema.prisma:L14548`
- `BankStatementLine` → `schema.prisma:L14569`
- `BillingTaxProfile` → `schema.prisma:L15358`
- `BulkCommandOperation` → `schema.prisma:L8660`
- `CalendarSyncOutbox` → `schema.prisma:L12520`
- `CampaignDelivery` → `schema.prisma:L11504`
- `CashCloseout` → `schema.prisma:L9025`
- `CashDeposit` → `schema.prisma:L11148`
- `CashDrawerEvent` → `schema.prisma:L12963`
- `CashDrawerSession` → `schema.prisma:L12939`
- `CashOutCommissionRate` → `schema.prisma:L15187`
- `CashOutScheduleDay` → `schema.prisma:L15210`
- `CashOutWithdrawal` → `schema.prisma:L15272`
- `CatalogBindingBatch` → `schema.prisma:L10056`
- `CatalogBindingLine` → `schema.prisma:L10092`
- `CatalogBrand` → `schema.prisma:L9509`
- `CatalogClientObservation` → `schema.prisma:L9822`
- `CatalogClientReadinessOverride` → `schema.prisma:L9841`
- `CatalogFamily` → `schema.prisma:L9559`
- `CatalogIdempotencyRecord` → `schema.prisma:L9955`
- `CatalogIdentifier` → `schema.prisma:L9690`
- `CatalogImportBatch` → `schema.prisma:L9998`
- `CatalogImportLine` → `schema.prisma:L10035`
- `CatalogItem` → `schema.prisma:L9592`
- `CatalogItemBusinessType` → `schema.prisma:L9652`
- `CatalogItemPrice` → `schema.prisma:L9740`
- `CatalogManufacturer` → `schema.prisma:L9533`
- `CatalogProductTypeMapping` → `schema.prisma:L9669`
- `CatalogPublicationBatch` → `schema.prisma:L10120`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10214`
- `CatalogPublicationLine` → `schema.prisma:L10161`
- `CatalogPublicationOutbox` → `schema.prisma:L10257`
- `CatalogValidationProfile` → `schema.prisma:L9711`
- `CatalogVenueBinding` → `schema.prisma:L9869`
- `CatalogVenueClientRequirement` → `schema.prisma:L9796`
- `CatalogVenueEventSequence` → `schema.prisma:L10240`
- `CatalogVenueOverride` → `schema.prisma:L9911`
- `CatalogVenueRollout` → `schema.prisma:L9771`
- `Cfdi` → `schema.prisma:L14451`
- `ChatbotTokenBudget` → `schema.prisma:L8308`
- `ChatConversation` → `schema.prisma:L8163`
- `ChatFeedback` → `schema.prisma:L8249`
- `ChatLearningEvent` → `schema.prisma:L8206`
- `ChatMessage` → `schema.prisma:L8186`
- `ChatTrainingData` → `schema.prisma:L8120`
- `CheckoutSession` → `schema.prisma:L5126`
- `ClassSession` → `schema.prisma:L12138`
- `CommissionCalculation` → `schema.prisma:L10927`
- `CommissionClawback` → `schema.prisma:L11100`
- `CommissionConfig` → `schema.prisma:L10700`
- `CommissionMilestone` → `schema.prisma:L10843`
- `CommissionOverride` → `schema.prisma:L10770`
- `CommissionPayout` → `schema.prisma:L11051`
- `CommissionSummary` → `schema.prisma:L10990`
- `CommissionTier` → `schema.prisma:L10807`
- `Consumer` → `schema.prisma:L6273`
- `ConsumerAuthAccount` → `schema.prisma:L6298`
- `CouponCode` → `schema.prisma:L6914`
- `CouponRedemption` → `schema.prisma:L6945`
- `CreditAssessmentHistory` → `schema.prisma:L9134`
- `CreditItemBalance` → `schema.prisma:L12729`
- `CreditOffer` → `schema.prisma:L9153`
- `CreditPack` → `schema.prisma:L12645`
- `CreditPackItem` → `schema.prisma:L12674`
- `CreditPackPurchase` → `schema.prisma:L12691`
- `CreditTransaction` → `schema.prisma:L12751`
- `Customer` → `schema.prisma:L6178`
- `CustomerDiscount` → `schema.prisma:L6965`
- `CustomerGroup` → `schema.prisma:L6332`
- `CustomerTaxProfile` → `schema.prisma:L14520`
- `DeliveryActivationRequest` → `schema.prisma:L5448`
- `DeliveryChannelLink` → `schema.prisma:L5412`
- `DeliveryOrderEvent` → `schema.prisma:L5472`
- `DeviceToken` → `schema.prisma:L7234`
- `DigitalReceipt` → `schema.prisma:L3847`
- `Discount` → `schema.prisma:L6604`
- `EcommerceMerchant` → `schema.prisma:L4938`
- `EmailTemplate` → `schema.prisma:L11443`
- `Employee` → `schema.prisma:L15035`
- `Estimate` → `schema.prisma:L13033`
- `EstimateItem` → `schema.prisma:L13061`
- `Expense` → `schema.prisma:L14822`
- `ExternalBusyBlock` → `schema.prisma:L12413`
- `Feature` → `schema.prisma:L3976`
- `FeeSchedule` → `schema.prisma:L4054`
- `FeeTier` → `schema.prisma:L4065`
- `FinancialAccount` → `schema.prisma:L13223`
- `FinancialConnection` → `schema.prisma:L13192`
- `FinancialProvider` → `schema.prisma:L13178`
- `FiscalEmisor` → `schema.prisma:L14374`
- `FiscalLossCarryforward` → `schema.prisma:L14945`
- `FixedAsset` → `schema.prisma:L14963`
- `FixedAssetDepreciation` → `schema.prisma:L14992`
- `FloorElement` → `schema.prisma:L2847`
- `FulfillmentArea` → `schema.prisma:L13434`
- `GeofenceRule` → `schema.prisma:L8745`
- `GoogleCalendarChannel` → `schema.prisma:L12390`
- `GoogleCalendarConnection` → `schema.prisma:L12342`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12443`
- `GoogleOAuthSession` → `schema.prisma:L12465`
- `HolidayCalendar` → `schema.prisma:L6061`
- `IdempotencyRequest` → `schema.prisma:L10575`
- `InterVenueTransfer` → `schema.prisma:L2599`
- `InterVenueTransferAllocation` → `schema.prisma:L2682`
- `InterVenueTransferItem` → `schema.prisma:L2651`
- `InterVenueTransferReceipt` → `schema.prisma:L2709`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2725`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2753`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2737`
- `Inventory` → `schema.prisma:L1792`
- `InventoryMovement` → `schema.prisma:L1819`
- `InventoryPosting` → `schema.prisma:L1901`
- `InventoryPostingLine` → `schema.prisma:L1941`
- `InventoryTransfer` → `schema.prisma:L13005`
- `Invitation` → `schema.prisma:L1340`
- `Invoice` → `schema.prisma:L4077`
- `InvoiceItem` → `schema.prisma:L4103`
- `ItemCategory` → `schema.prisma:L10292`
- `JournalEntry` → `schema.prisma:L14732`
- `JournalLine` → `schema.prisma:L14760`
- `KdsOrder` → `schema.prisma:L13271`
- `KdsOrderItem` → `schema.prisma:L13288`
- `LearnedPatterns` → `schema.prisma:L8230`
- `LedgerAccount` → `schema.prisma:L14624`
- `LiveDemoSession` → `schema.prisma:L759`
- `LowStockAlert` → `schema.prisma:L2440`
- `LoyaltyConfig` → `schema.prisma:L6362`
- `LoyaltyTransaction` → `schema.prisma:L6385`
- `MarketingCampaign` → `schema.prisma:L11461`
- `McpAuthCode` → `schema.prisma:L14257`
- `McpOAuthClient` → `schema.prisma:L14241`
- `McpRefreshToken` → `schema.prisma:L14275`
- `McpToolCall` → `schema.prisma:L14296`
- `MeasurementUnit` → `schema.prisma:L13111`
- `Menu` → `schema.prisma:L1526`
- `MenuCategory` → `schema.prisma:L1463`
- `MenuCategoryAssignment` → `schema.prisma:L1561`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14171`
- `MerchantAccount` → `schema.prisma:L4676`
- `MerchantFiscalConfig` → `schema.prisma:L14422`
- `MerchantRevenueShare` → `schema.prisma:L5641`
- `MerchantRoutingRule` → `schema.prisma:L4798`
- `MilestoneAchievement` → `schema.prisma:L10888`
- `Modifier` → `schema.prisma:L3463`
- `ModifierGroup` → `schema.prisma:L3427`
- `Module` → `schema.prisma:L9201`
- `MoneyAnomaly` → `schema.prisma:L5544`
- `MonthlyVenueProfit` → `schema.prisma:L6087`
- `Notification` → `schema.prisma:L7136`
- `NotificationPreference` → `schema.prisma:L7183`
- `NotificationTemplate` → `schema.prisma:L7210`
- `OAuthState` → `schema.prisma:L1391`
- `OnboardingProgress` → `schema.prisma:L1409`
- `Order` → `schema.prisma:L3078`
- `OrderAction` → `schema.prisma:L3528`
- `OrderCustomer` → `schema.prisma:L3278`
- `OrderDiscount` → `schema.prisma:L6997`
- `OrderFulfillment` → `schema.prisma:L13489`
- `OrderFulfillmentLine` → `schema.prisma:L13520`
- `OrderItem` → `schema.prisma:L3294`
- `OrderItemModifier` → `schema.prisma:L3512`
- `OrderPromotion` → `schema.prisma:L15598`
- `OrderServiceCharge` → `schema.prisma:L7081`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11262`
- `OrganizationEntitlement` → `schema.prisma:L9484`
- `OrganizationGoal` → `schema.prisma:L11220`
- `OrganizationModule` → `schema.prisma:L9261`
- `OrganizationPaymentConfig` → `schema.prisma:L5250`
- `OrganizationPayoutConfig` → `schema.prisma:L11295`
- `OrganizationPricingStructure` → `schema.prisma:L5282`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11243`
- `OtpChallenge` → `schema.prisma:L6317`
- `PartnerAPIKey` → `schema.prisma:L5080`
- `Payment` → `schema.prisma:L3561`
- `PaymentAllocation` → `schema.prisma:L3826`
- `PaymentLink` → `schema.prisma:L12797`
- `PaymentLinkAttribution` → `schema.prisma:L12905`
- `PaymentLinkItem` → `schema.prisma:L12860`
- `PaymentLinkItemModifier` → `schema.prisma:L12887`
- `PaymentProvider` → `schema.prisma:L4635`
- `PayrollLine` → `schema.prisma:L15106`
- `PayrollRun` → `schema.prisma:L15075`
- `PerformanceGoal` → `schema.prisma:L11197`
- `PermissionOverride` → `schema.prisma:L1268`
- `PermissionSet` → `schema.prisma:L1291`
- `PlatformCfdi` → `schema.prisma:L15391`
- `PlatformEmisor` → `schema.prisma:L15331`
- `PlatformSettings` → `schema.prisma:L5057`
- `PosCommand` → `schema.prisma:L7264`
- `PosConnectionStatus` → `schema.prisma:L865`
- `PosSyncIntent` → `schema.prisma:L15469`
- `PricingPolicy` → `schema.prisma:L2344`
- `Printer` → `schema.prisma:L13317`
- `PrintGateway` → `schema.prisma:L13370`
- `PrintJob` → `schema.prisma:L14070`
- `PrintStation` → `schema.prisma:L13388`
- `ProcessedStripeEvent` → `schema.prisma:L5530`
- `ProcessorReliabilityMetric` → `schema.prisma:L6015`
- `Product` → `schema.prisma:L1579`
- `ProductModifierGroup` → `schema.prisma:L3500`
- `ProductOption` → `schema.prisma:L13088`
- `ProductOptionValue` → `schema.prisma:L13099`
- `ProductStaff` → `schema.prisma:L12053`
- `PromoterBankAccount` → `schema.prisma:L15226`
- `PromoterCommissionEntry` → `schema.prisma:L15245`
- `PromoterLocationPing` → `schema.prisma:L3044`
- `Promotion` → `schema.prisma:L15520`
- `PromotionGroup` → `schema.prisma:L15559`
- `PromotionOption` → `schema.prisma:L15575`
- `ProviderCostStructure` → `schema.prisma:L5566`
- `ProviderEventLog` → `schema.prisma:L5359`
- `PurchaseOrder` → `schema.prisma:L2212`
- `PurchaseOrderItem` → `schema.prisma:L2269`
- `RateCorrectionBatch` → `schema.prisma:L5791`
- `RateCorrectionEntry` → `schema.prisma:L5833`
- `RawMaterial` → `schema.prisma:L1973`
- `RawMaterialMovement` → `schema.prisma:L2397`
- `RawMaterialPresentation` → `schema.prisma:L2046`
- `Recipe` → `schema.prisma:L2066`
- `RecipeLine` → `schema.prisma:L2090`
- `Referral` → `schema.prisma:L6452`
- `ReferralProgramConfig` → `schema.prisma:L6417`
- `ReferralRewardGrant` → `schema.prisma:L6543`
- `ReferralTierReward` → `schema.prisma:L6515`
- `ReferralTierUnlock` → `schema.prisma:L6588`
- `Reservation` → `schema.prisma:L11840`
- `ReservationGoogleEventMapping` → `schema.prisma:L12577`
- `ReservationModifier` → `schema.prisma:L12001`
- `ReservationReminderSent` → `schema.prisma:L11984`
- `ReservationSettings` → `schema.prisma:L12215`
- `ReservationWaitlistEntry` → `schema.prisma:L12183`
- `Review` → `schema.prisma:L4121`
- `SalesRetention` → `schema.prisma:L14926`
- `SaleVerification` → `schema.prisma:L3880`
- `ScaleProfile` → `schema.prisma:L13811`
- `ScheduledCommand` → `schema.prisma:L8705`
- `SerializedItem` → `schema.prisma:L10335`
- `SerializedItemCustodyEvent` → `schema.prisma:L10498`
- `ServiceCharge` → `schema.prisma:L7052`
- `SettlementConfiguration` → `schema.prisma:L5866`
- `SettlementConfirmation` → `schema.prisma:L5979`
- `SettlementIncident` → `schema.prisma:L5930`
- `SettlementSimulation` → `schema.prisma:L5901`
- `Shift` → `schema.prisma:L2885`
- `SimRegistrationRequest` → `schema.prisma:L10536`
- `SimRegistrationRequestItem` → `schema.prisma:L10558`
- `SlotHold` → `schema.prisma:L12084`
- `Staff` → `schema.prisma:L885`
- `StaffOnboardingState` → `schema.prisma:L14141`
- `StaffOrganization` → `schema.prisma:L1181`
- `StaffPasskey` → `schema.prisma:L1208`
- `StaffSchedule` → `schema.prisma:L12024`
- `StaffScheduleException` → `schema.prisma:L12036`
- `StaffVenue` → `schema.prisma:L1111`
- `StockAlertConfig` → `schema.prisma:L11179`
- `StockBatch` → `schema.prisma:L2548`
- `StockCount` → `schema.prisma:L2472`
- `StockCountItem` → `schema.prisma:L2496`
- `StripeWebhookEvent` → `schema.prisma:L5513`
- `Supplier` → `schema.prisma:L2125`
- `SupplierPricing` → `schema.prisma:L2178`
- `Table` → `schema.prisma:L2797`
- `Terminal` → `schema.prisma:L4172`
- `TerminalHealth` → `schema.prisma:L4411`
- `TerminalLog` → `schema.prisma:L4385`
- `TerminalOrder` → `schema.prisma:L4538`
- `TerminalOrderItem` → `schema.prisma:L4613`
- `TerminalPaymentRequest` → `schema.prisma:L4482`
- `TimeEntry` → `schema.prisma:L2957`
- `TimeEntryBreak` → `schema.prisma:L3026`
- `TokenPurchase` → `schema.prisma:L8379`
- `TokenUsageRecord` → `schema.prisma:L8351`
- `TpvCommandHistory` → `schema.prisma:L8611`
- `TpvCommandQueue` → `schema.prisma:L8551`
- `TpvFeedback` → `schema.prisma:L8264`
- `TpvMessage` → `schema.prisma:L11536`
- `TpvMessageDelivery` → `schema.prisma:L11588`
- `TpvMessageResponse` → `schema.prisma:L11611`
- `TrainingModule` → `schema.prisma:L11666`
- `TrainingProgress` → `schema.prisma:L11743`
- `TrainingQuizQuestion` → `schema.prisma:L11725`
- `TrainingStep` → `schema.prisma:L11705`
- `TransactionCost` → `schema.prisma:L5729`
- `UnitConversion` → `schema.prisma:L2375`
- `UpsellAcceptance` → `schema.prisma:L6873`
- `UpsellAiRun` → `schema.prisma:L6893`
- `UpsellImpression` → `schema.prisma:L6833`
- `UpsellRule` → `schema.prisma:L6753`
- `user_sessions` → `schema.prisma:L5115`
- `Venue` → `schema.prisma:L147`
- `VenueAreaTicketSettings` → `schema.prisma:L13548`
- `VenueChatMessage` → `schema.prisma:L735`
- `VenueChatSession` → `schema.prisma:L690`
- `VenueCommission` → `schema.prisma:L13249`
- `VenueCreditAssessment` → `schema.prisma:L9073`
- `VenueCryptoConfig` → `schema.prisma:L11403`
- `VenueFeature` → `schema.prisma:L3994`
- `VenueModule` → `schema.prisma:L9233`
- `VenuePaymentConfig` → `schema.prisma:L5216`
- `VenuePaymentLinkSettings` → `schema.prisma:L12610`
- `VenuePricingStructure` → `schema.prisma:L5669`
- `VenueRoleConfig` → `schema.prisma:L1320`
- `VenueRolePermission` → `schema.prisma:L1238`
- `VenueScaleSettings` → `schema.prisma:L13799`
- `VenueSettings` → `schema.prisma:L775`
- `VenueTenderType` → `schema.prisma:L3739`
- `VenueTenderTypeRevision` → `schema.prisma:L3804`
- `VenueTransaction` → `schema.prisma:L3931`
- `VenueWhatsappActivation` → `schema.prisma:L626`
- `WebhookEvent` → `schema.prisma:L4030`
- `WebhookSubscription` → `schema.prisma:L5332`
- `WhatsappContactWindow` → `schema.prisma:L644`
- `WhatsappInboundEvent` → `schema.prisma:L664`
- `Zone` → `schema.prisma:L130`
