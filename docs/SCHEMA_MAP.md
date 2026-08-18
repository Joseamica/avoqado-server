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

- `AccountingPeriodLock` → `schema.prisma:L14796`
- `AccountMapping` → `schema.prisma:L14692`
- `ActivityLog` → `schema.prisma:L6155`
- `Aggregator` → `schema.prisma:L13144`
- `AngelPayUserAccount` → `schema.prisma:L4846`
- `AppUpdate` → `schema.prisma:L11364`
- `Area` → `schema.prisma:L2771`
- `AreaTicket` → `schema.prisma:L13587`
- `AreaTicketCheckoutSession` → `schema.prisma:L13709`
- `AreaTicketExternalIncident` → `schema.prisma:L13956`
- `AreaTicketExternalSettlement` → `schema.prisma:L13921`
- `AreaTicketFulfillment` → `schema.prisma:L13785`
- `AreaTicketInventoryReservation` → `schema.prisma:L13680`
- `AreaTicketLine` → `schema.prisma:L13648`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13741`
- `AreaTicketPrintAttempt` → `schema.prisma:L13764`
- `BankStatement` → `schema.prisma:L14566`
- `BankStatementLine` → `schema.prisma:L14587`
- `BillingTaxProfile` → `schema.prisma:L15376`
- `BulkCommandOperation` → `schema.prisma:L8678`
- `CalendarSyncOutbox` → `schema.prisma:L12538`
- `CampaignDelivery` → `schema.prisma:L11522`
- `CashCloseout` → `schema.prisma:L9043`
- `CashDeposit` → `schema.prisma:L11166`
- `CashDrawerEvent` → `schema.prisma:L12981`
- `CashDrawerSession` → `schema.prisma:L12957`
- `CashOutCommissionRate` → `schema.prisma:L15205`
- `CashOutScheduleDay` → `schema.prisma:L15228`
- `CashOutWithdrawal` → `schema.prisma:L15290`
- `CatalogBindingBatch` → `schema.prisma:L10074`
- `CatalogBindingLine` → `schema.prisma:L10110`
- `CatalogBrand` → `schema.prisma:L9527`
- `CatalogClientObservation` → `schema.prisma:L9840`
- `CatalogClientReadinessOverride` → `schema.prisma:L9859`
- `CatalogFamily` → `schema.prisma:L9577`
- `CatalogIdempotencyRecord` → `schema.prisma:L9973`
- `CatalogIdentifier` → `schema.prisma:L9708`
- `CatalogImportBatch` → `schema.prisma:L10016`
- `CatalogImportLine` → `schema.prisma:L10053`
- `CatalogItem` → `schema.prisma:L9610`
- `CatalogItemBusinessType` → `schema.prisma:L9670`
- `CatalogItemPrice` → `schema.prisma:L9758`
- `CatalogManufacturer` → `schema.prisma:L9551`
- `CatalogProductTypeMapping` → `schema.prisma:L9687`
- `CatalogPublicationBatch` → `schema.prisma:L10138`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10232`
- `CatalogPublicationLine` → `schema.prisma:L10179`
- `CatalogPublicationOutbox` → `schema.prisma:L10275`
- `CatalogValidationProfile` → `schema.prisma:L9729`
- `CatalogVenueBinding` → `schema.prisma:L9887`
- `CatalogVenueClientRequirement` → `schema.prisma:L9814`
- `CatalogVenueEventSequence` → `schema.prisma:L10258`
- `CatalogVenueOverride` → `schema.prisma:L9929`
- `CatalogVenueRollout` → `schema.prisma:L9789`
- `Cfdi` → `schema.prisma:L14469`
- `ChatbotTokenBudget` → `schema.prisma:L8326`
- `ChatConversation` → `schema.prisma:L8181`
- `ChatFeedback` → `schema.prisma:L8267`
- `ChatLearningEvent` → `schema.prisma:L8224`
- `ChatMessage` → `schema.prisma:L8204`
- `ChatTrainingData` → `schema.prisma:L8138`
- `CheckoutSession` → `schema.prisma:L5126`
- `ClassSession` → `schema.prisma:L12156`
- `CommissionCalculation` → `schema.prisma:L10945`
- `CommissionClawback` → `schema.prisma:L11118`
- `CommissionConfig` → `schema.prisma:L10718`
- `CommissionMilestone` → `schema.prisma:L10861`
- `CommissionOverride` → `schema.prisma:L10788`
- `CommissionPayout` → `schema.prisma:L11069`
- `CommissionSummary` → `schema.prisma:L11008`
- `CommissionTier` → `schema.prisma:L10825`
- `Consumer` → `schema.prisma:L6291`
- `ConsumerAuthAccount` → `schema.prisma:L6316`
- `CouponCode` → `schema.prisma:L6932`
- `CouponRedemption` → `schema.prisma:L6963`
- `CreditAssessmentHistory` → `schema.prisma:L9152`
- `CreditItemBalance` → `schema.prisma:L12747`
- `CreditOffer` → `schema.prisma:L9171`
- `CreditPack` → `schema.prisma:L12663`
- `CreditPackItem` → `schema.prisma:L12692`
- `CreditPackPurchase` → `schema.prisma:L12709`
- `CreditTransaction` → `schema.prisma:L12769`
- `Customer` → `schema.prisma:L6196`
- `CustomerDiscount` → `schema.prisma:L6983`
- `CustomerGroup` → `schema.prisma:L6350`
- `CustomerTaxProfile` → `schema.prisma:L14538`
- `DeliveryActivationRequest` → `schema.prisma:L5448`
- `DeliveryChannelLink` → `schema.prisma:L5412`
- `DeliveryOrderEvent` → `schema.prisma:L5472`
- `DeviceToken` → `schema.prisma:L7252`
- `DigitalReceipt` → `schema.prisma:L3847`
- `Discount` → `schema.prisma:L6622`
- `EcommerceMerchant` → `schema.prisma:L4938`
- `EmailTemplate` → `schema.prisma:L11461`
- `Employee` → `schema.prisma:L15053`
- `Estimate` → `schema.prisma:L13051`
- `EstimateItem` → `schema.prisma:L13079`
- `Expense` → `schema.prisma:L14840`
- `ExternalBusyBlock` → `schema.prisma:L12431`
- `Feature` → `schema.prisma:L3976`
- `FeeSchedule` → `schema.prisma:L4054`
- `FeeTier` → `schema.prisma:L4065`
- `FinancialAccount` → `schema.prisma:L13241`
- `FinancialConnection` → `schema.prisma:L13210`
- `FinancialProvider` → `schema.prisma:L13196`
- `FiscalEmisor` → `schema.prisma:L14392`
- `FiscalLossCarryforward` → `schema.prisma:L14963`
- `FixedAsset` → `schema.prisma:L14981`
- `FixedAssetDepreciation` → `schema.prisma:L15010`
- `FloorElement` → `schema.prisma:L2847`
- `FulfillmentArea` → `schema.prisma:L13452`
- `GeofenceRule` → `schema.prisma:L8763`
- `GoogleCalendarChannel` → `schema.prisma:L12408`
- `GoogleCalendarConnection` → `schema.prisma:L12360`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12461`
- `GoogleOAuthSession` → `schema.prisma:L12483`
- `HolidayCalendar` → `schema.prisma:L6079`
- `IdempotencyRequest` → `schema.prisma:L10593`
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
- `InventoryTransfer` → `schema.prisma:L13023`
- `Invitation` → `schema.prisma:L1340`
- `Invoice` → `schema.prisma:L4077`
- `InvoiceItem` → `schema.prisma:L4103`
- `ItemCategory` → `schema.prisma:L10310`
- `JournalEntry` → `schema.prisma:L14750`
- `JournalLine` → `schema.prisma:L14778`
- `KdsOrder` → `schema.prisma:L13289`
- `KdsOrderItem` → `schema.prisma:L13306`
- `LearnedPatterns` → `schema.prisma:L8248`
- `LedgerAccount` → `schema.prisma:L14642`
- `LiveDemoSession` → `schema.prisma:L759`
- `LowStockAlert` → `schema.prisma:L2440`
- `LoyaltyConfig` → `schema.prisma:L6380`
- `LoyaltyTransaction` → `schema.prisma:L6403`
- `MarketingCampaign` → `schema.prisma:L11479`
- `McpAuthCode` → `schema.prisma:L14275`
- `McpOAuthClient` → `schema.prisma:L14259`
- `McpRefreshToken` → `schema.prisma:L14293`
- `McpToolCall` → `schema.prisma:L14314`
- `MeasurementUnit` → `schema.prisma:L13129`
- `Menu` → `schema.prisma:L1526`
- `MenuCategory` → `schema.prisma:L1463`
- `MenuCategoryAssignment` → `schema.prisma:L1561`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14189`
- `MerchantAccount` → `schema.prisma:L4676`
- `MerchantFiscalConfig` → `schema.prisma:L14440`
- `MerchantRevenueShare` → `schema.prisma:L5659`
- `MerchantRoutingRule` → `schema.prisma:L4798`
- `MilestoneAchievement` → `schema.prisma:L10906`
- `Modifier` → `schema.prisma:L3463`
- `ModifierGroup` → `schema.prisma:L3427`
- `Module` → `schema.prisma:L9219`
- `MoneyAnomaly` → `schema.prisma:L5562`
- `MonthlyVenueProfit` → `schema.prisma:L6105`
- `Notification` → `schema.prisma:L7154`
- `NotificationPreference` → `schema.prisma:L7201`
- `NotificationTemplate` → `schema.prisma:L7228`
- `OAuthState` → `schema.prisma:L1391`
- `OnboardingProgress` → `schema.prisma:L1409`
- `Order` → `schema.prisma:L3078`
- `OrderAction` → `schema.prisma:L3528`
- `OrderCustomer` → `schema.prisma:L3278`
- `OrderDiscount` → `schema.prisma:L7015`
- `OrderFulfillment` → `schema.prisma:L13507`
- `OrderFulfillmentLine` → `schema.prisma:L13538`
- `OrderItem` → `schema.prisma:L3294`
- `OrderItemModifier` → `schema.prisma:L3512`
- `OrderPromotion` → `schema.prisma:L15616`
- `OrderServiceCharge` → `schema.prisma:L7099`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11280`
- `OrganizationEntitlement` → `schema.prisma:L9502`
- `OrganizationGoal` → `schema.prisma:L11238`
- `OrganizationModule` → `schema.prisma:L9279`
- `OrganizationPaymentConfig` → `schema.prisma:L5250`
- `OrganizationPayoutConfig` → `schema.prisma:L11313`
- `OrganizationPricingStructure` → `schema.prisma:L5282`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11261`
- `OtpChallenge` → `schema.prisma:L6335`
- `PartnerAPIKey` → `schema.prisma:L5080`
- `Payment` → `schema.prisma:L3561`
- `PaymentAllocation` → `schema.prisma:L3826`
- `PaymentLink` → `schema.prisma:L12815`
- `PaymentLinkAttribution` → `schema.prisma:L12923`
- `PaymentLinkItem` → `schema.prisma:L12878`
- `PaymentLinkItemModifier` → `schema.prisma:L12905`
- `PaymentProvider` → `schema.prisma:L4635`
- `PayrollLine` → `schema.prisma:L15124`
- `PayrollRun` → `schema.prisma:L15093`
- `PerformanceGoal` → `schema.prisma:L11215`
- `PermissionOverride` → `schema.prisma:L1268`
- `PermissionSet` → `schema.prisma:L1291`
- `PlatformCfdi` → `schema.prisma:L15409`
- `PlatformEmisor` → `schema.prisma:L15349`
- `PlatformSettings` → `schema.prisma:L5057`
- `PosCommand` → `schema.prisma:L7282`
- `PosConnectionStatus` → `schema.prisma:L865`
- `PosSyncIntent` → `schema.prisma:L15487`
- `PricingPolicy` → `schema.prisma:L2344`
- `Printer` → `schema.prisma:L13335`
- `PrintGateway` → `schema.prisma:L13388`
- `PrintJob` → `schema.prisma:L14088`
- `PrintStation` → `schema.prisma:L13406`
- `ProcessedStripeEvent` → `schema.prisma:L5548`
- `ProcessorReliabilityMetric` → `schema.prisma:L6033`
- `Product` → `schema.prisma:L1579`
- `ProductModifierGroup` → `schema.prisma:L3500`
- `ProductOption` → `schema.prisma:L13106`
- `ProductOptionValue` → `schema.prisma:L13117`
- `ProductStaff` → `schema.prisma:L12071`
- `PromoterBankAccount` → `schema.prisma:L15244`
- `PromoterCommissionEntry` → `schema.prisma:L15263`
- `PromoterLocationPing` → `schema.prisma:L3044`
- `Promotion` → `schema.prisma:L15538`
- `PromotionGroup` → `schema.prisma:L15577`
- `PromotionOption` → `schema.prisma:L15593`
- `ProviderCostStructure` → `schema.prisma:L5584`
- `ProviderEventLog` → `schema.prisma:L5359`
- `PurchaseOrder` → `schema.prisma:L2212`
- `PurchaseOrderItem` → `schema.prisma:L2269`
- `RateCorrectionBatch` → `schema.prisma:L5809`
- `RateCorrectionEntry` → `schema.prisma:L5851`
- `RawMaterial` → `schema.prisma:L1973`
- `RawMaterialMovement` → `schema.prisma:L2397`
- `RawMaterialPresentation` → `schema.prisma:L2046`
- `Recipe` → `schema.prisma:L2066`
- `RecipeLine` → `schema.prisma:L2090`
- `Referral` → `schema.prisma:L6470`
- `ReferralProgramConfig` → `schema.prisma:L6435`
- `ReferralRewardGrant` → `schema.prisma:L6561`
- `ReferralTierReward` → `schema.prisma:L6533`
- `ReferralTierUnlock` → `schema.prisma:L6606`
- `Reservation` → `schema.prisma:L11858`
- `ReservationGoogleEventMapping` → `schema.prisma:L12595`
- `ReservationModifier` → `schema.prisma:L12019`
- `ReservationReminderSent` → `schema.prisma:L12002`
- `ReservationSettings` → `schema.prisma:L12233`
- `ReservationWaitlistEntry` → `schema.prisma:L12201`
- `Review` → `schema.prisma:L4121`
- `SalesRetention` → `schema.prisma:L14944`
- `SaleVerification` → `schema.prisma:L3880`
- `ScaleProfile` → `schema.prisma:L13829`
- `ScheduledCommand` → `schema.prisma:L8723`
- `SerializedItem` → `schema.prisma:L10353`
- `SerializedItemCustodyEvent` → `schema.prisma:L10516`
- `ServiceCharge` → `schema.prisma:L7070`
- `SettlementConfiguration` → `schema.prisma:L5884`
- `SettlementConfirmation` → `schema.prisma:L5997`
- `SettlementIncident` → `schema.prisma:L5948`
- `SettlementSimulation` → `schema.prisma:L5919`
- `Shift` → `schema.prisma:L2885`
- `SimRegistrationRequest` → `schema.prisma:L10554`
- `SimRegistrationRequestItem` → `schema.prisma:L10576`
- `SlotHold` → `schema.prisma:L12102`
- `Staff` → `schema.prisma:L885`
- `StaffOnboardingState` → `schema.prisma:L14159`
- `StaffOrganization` → `schema.prisma:L1181`
- `StaffPasskey` → `schema.prisma:L1208`
- `StaffSchedule` → `schema.prisma:L12042`
- `StaffScheduleException` → `schema.prisma:L12054`
- `StaffVenue` → `schema.prisma:L1111`
- `StockAlertConfig` → `schema.prisma:L11197`
- `StockBatch` → `schema.prisma:L2548`
- `StockCount` → `schema.prisma:L2472`
- `StockCountItem` → `schema.prisma:L2496`
- `StripeWebhookEvent` → `schema.prisma:L5531`
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
- `TokenPurchase` → `schema.prisma:L8397`
- `TokenUsageRecord` → `schema.prisma:L8369`
- `TpvCommandHistory` → `schema.prisma:L8629`
- `TpvCommandQueue` → `schema.prisma:L8569`
- `TpvFeedback` → `schema.prisma:L8282`
- `TpvMessage` → `schema.prisma:L11554`
- `TpvMessageDelivery` → `schema.prisma:L11606`
- `TpvMessageResponse` → `schema.prisma:L11629`
- `TrainingModule` → `schema.prisma:L11684`
- `TrainingProgress` → `schema.prisma:L11761`
- `TrainingQuizQuestion` → `schema.prisma:L11743`
- `TrainingStep` → `schema.prisma:L11723`
- `TransactionCost` → `schema.prisma:L5747`
- `UnitConversion` → `schema.prisma:L2375`
- `UpsellAcceptance` → `schema.prisma:L6891`
- `UpsellAiRun` → `schema.prisma:L6911`
- `UpsellImpression` → `schema.prisma:L6851`
- `UpsellRule` → `schema.prisma:L6771`
- `user_sessions` → `schema.prisma:L5115`
- `Venue` → `schema.prisma:L147`
- `VenueAreaTicketSettings` → `schema.prisma:L13566`
- `VenueChatMessage` → `schema.prisma:L735`
- `VenueChatSession` → `schema.prisma:L690`
- `VenueCommission` → `schema.prisma:L13267`
- `VenueCreditAssessment` → `schema.prisma:L9091`
- `VenueCryptoConfig` → `schema.prisma:L11421`
- `VenueFeature` → `schema.prisma:L3994`
- `VenueModule` → `schema.prisma:L9251`
- `VenuePaymentConfig` → `schema.prisma:L5216`
- `VenuePaymentLinkSettings` → `schema.prisma:L12628`
- `VenuePricingStructure` → `schema.prisma:L5687`
- `VenueRoleConfig` → `schema.prisma:L1320`
- `VenueRolePermission` → `schema.prisma:L1238`
- `VenueScaleSettings` → `schema.prisma:L13817`
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
