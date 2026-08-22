# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **331 models / 322 enums / ~15,700 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L14925`
- `AccountMapping` → `schema.prisma:L14821`
- `ActivityLog` → `schema.prisma:L6227`
- `Aggregator` → `schema.prisma:L13222`
- `AngelPayUserAccount` → `schema.prisma:L4890`
- `AppUpdate` → `schema.prisma:L11442`
- `Area` → `schema.prisma:L2797`
- `AreaTicket` → `schema.prisma:L13716`
- `AreaTicketCheckoutSession` → `schema.prisma:L13838`
- `AreaTicketExternalIncident` → `schema.prisma:L14085`
- `AreaTicketExternalSettlement` → `schema.prisma:L14050`
- `AreaTicketFulfillment` → `schema.prisma:L13914`
- `AreaTicketInventoryReservation` → `schema.prisma:L13809`
- `AreaTicketLine` → `schema.prisma:L13777`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13870`
- `AreaTicketPrintAttempt` → `schema.prisma:L13893`
- `BankStatement` → `schema.prisma:L14695`
- `BankStatementLine` → `schema.prisma:L14716`
- `BillingTaxProfile` → `schema.prisma:L15505`
- `BulkCommandOperation` → `schema.prisma:L8755`
- `CalendarSyncOutbox` → `schema.prisma:L12616`
- `CampaignDelivery` → `schema.prisma:L11600`
- `CashCloseout` → `schema.prisma:L9120`
- `CashDeposit` → `schema.prisma:L11244`
- `CashDrawerEvent` → `schema.prisma:L13059`
- `CashDrawerSession` → `schema.prisma:L13035`
- `CashOutCommissionRate` → `schema.prisma:L15334`
- `CashOutScheduleDay` → `schema.prisma:L15357`
- `CashOutWithdrawal` → `schema.prisma:L15419`
- `CatalogBindingBatch` → `schema.prisma:L10151`
- `CatalogBindingLine` → `schema.prisma:L10187`
- `CatalogBrand` → `schema.prisma:L9604`
- `CatalogClientObservation` → `schema.prisma:L9917`
- `CatalogClientReadinessOverride` → `schema.prisma:L9936`
- `CatalogFamily` → `schema.prisma:L9654`
- `CatalogIdempotencyRecord` → `schema.prisma:L10050`
- `CatalogIdentifier` → `schema.prisma:L9785`
- `CatalogImportBatch` → `schema.prisma:L10093`
- `CatalogImportLine` → `schema.prisma:L10130`
- `CatalogItem` → `schema.prisma:L9687`
- `CatalogItemBusinessType` → `schema.prisma:L9747`
- `CatalogItemPrice` → `schema.prisma:L9835`
- `CatalogManufacturer` → `schema.prisma:L9628`
- `CatalogProductTypeMapping` → `schema.prisma:L9764`
- `CatalogPublicationBatch` → `schema.prisma:L10215`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10309`
- `CatalogPublicationLine` → `schema.prisma:L10256`
- `CatalogPublicationOutbox` → `schema.prisma:L10352`
- `CatalogValidationProfile` → `schema.prisma:L9806`
- `CatalogVenueBinding` → `schema.prisma:L9964`
- `CatalogVenueClientRequirement` → `schema.prisma:L9891`
- `CatalogVenueEventSequence` → `schema.prisma:L10335`
- `CatalogVenueOverride` → `schema.prisma:L10006`
- `CatalogVenueRollout` → `schema.prisma:L9866`
- `Cfdi` → `schema.prisma:L14598`
- `ChatbotTokenBudget` → `schema.prisma:L8403`
- `ChatConversation` → `schema.prisma:L8258`
- `ChatFeedback` → `schema.prisma:L8344`
- `ChatLearningEvent` → `schema.prisma:L8301`
- `ChatMessage` → `schema.prisma:L8281`
- `ChatTrainingData` → `schema.prisma:L8215`
- `CheckoutSession` → `schema.prisma:L5170`
- `ClassSession` → `schema.prisma:L12234`
- `CommissionCalculation` → `schema.prisma:L11023`
- `CommissionClawback` → `schema.prisma:L11196`
- `CommissionConfig` → `schema.prisma:L10796`
- `CommissionMilestone` → `schema.prisma:L10939`
- `CommissionOverride` → `schema.prisma:L10866`
- `CommissionPayout` → `schema.prisma:L11147`
- `CommissionSummary` → `schema.prisma:L11086`
- `CommissionTier` → `schema.prisma:L10903`
- `Consumer` → `schema.prisma:L6363`
- `ConsumerAuthAccount` → `schema.prisma:L6388`
- `CouponCode` → `schema.prisma:L7009`
- `CouponRedemption` → `schema.prisma:L7040`
- `CreditAssessmentHistory` → `schema.prisma:L9229`
- `CreditItemBalance` → `schema.prisma:L12825`
- `CreditOffer` → `schema.prisma:L9248`
- `CreditPack` → `schema.prisma:L12741`
- `CreditPackItem` → `schema.prisma:L12770`
- `CreditPackPurchase` → `schema.prisma:L12787`
- `CreditTransaction` → `schema.prisma:L12847`
- `Customer` → `schema.prisma:L6268`
- `CustomerDiscount` → `schema.prisma:L7060`
- `CustomerGroup` → `schema.prisma:L6427`
- `CustomerTaxProfile` → `schema.prisma:L14667`
- `DeliveryActivationRequest` → `schema.prisma:L5511`
- `DeliveryChannelLink` → `schema.prisma:L5456`
- `DeliveryOrderEvent` → `schema.prisma:L5535`
- `DeviceToken` → `schema.prisma:L7329`
- `DigitalReceipt` → `schema.prisma:L3885`
- `Discount` → `schema.prisma:L6699`
- `EcommerceMerchant` → `schema.prisma:L4982`
- `EmailTemplate` → `schema.prisma:L11539`
- `Employee` → `schema.prisma:L15182`
- `Estimate` → `schema.prisma:L13129`
- `EstimateItem` → `schema.prisma:L13157`
- `Expense` → `schema.prisma:L14969`
- `ExternalBusyBlock` → `schema.prisma:L12509`
- `Feature` → `schema.prisma:L4014`
- `FeeSchedule` → `schema.prisma:L4092`
- `FeeTier` → `schema.prisma:L4103`
- `FinancialAccount` → `schema.prisma:L13319`
- `FinancialConnection` → `schema.prisma:L13288`
- `FinancialProvider` → `schema.prisma:L13274`
- `FiscalEmisor` → `schema.prisma:L14521`
- `FiscalLossCarryforward` → `schema.prisma:L15092`
- `FixedAsset` → `schema.prisma:L15110`
- `FixedAssetDepreciation` → `schema.prisma:L15139`
- `FloorElement` → `schema.prisma:L2873`
- `FulfillmentArea` → `schema.prisma:L13581`
- `GeofenceRule` → `schema.prisma:L8840`
- `GoogleCalendarChannel` → `schema.prisma:L12486`
- `GoogleCalendarConnection` → `schema.prisma:L12438`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12539`
- `GoogleOAuthSession` → `schema.prisma:L12561`
- `HolidayCalendar` → `schema.prisma:L6151`
- `IdempotencyRequest` → `schema.prisma:L10671`
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
- `InventoryTransfer` → `schema.prisma:L13101`
- `Invitation` → `schema.prisma:L1366`
- `Invoice` → `schema.prisma:L4115`
- `InvoiceItem` → `schema.prisma:L4141`
- `ItemCategory` → `schema.prisma:L10387`
- `JournalEntry` → `schema.prisma:L14879`
- `JournalLine` → `schema.prisma:L14907`
- `KdsOrder` → `schema.prisma:L13367`
- `KdsOrderItem` → `schema.prisma:L13408`
- `LearnedPatterns` → `schema.prisma:L8325`
- `LedgerAccount` → `schema.prisma:L14771`
- `LiveDemoSession` → `schema.prisma:L771`
- `LowStockAlert` → `schema.prisma:L2466`
- `LoyaltyConfig` → `schema.prisma:L6457`
- `LoyaltyTransaction` → `schema.prisma:L6480`
- `MarketingCampaign` → `schema.prisma:L11557`
- `McpAuthCode` → `schema.prisma:L14404`
- `McpOAuthClient` → `schema.prisma:L14388`
- `McpRefreshToken` → `schema.prisma:L14422`
- `McpToolCall` → `schema.prisma:L14443`
- `MeasurementUnit` → `schema.prisma:L13207`
- `Menu` → `schema.prisma:L1552`
- `MenuCategory` → `schema.prisma:L1489`
- `MenuCategoryAssignment` → `schema.prisma:L1587`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14318`
- `MerchantAccount` → `schema.prisma:L4720`
- `MerchantFiscalConfig` → `schema.prisma:L14569`
- `MerchantRevenueShare` → `schema.prisma:L5731`
- `MerchantRoutingRule` → `schema.prisma:L4842`
- `MilestoneAchievement` → `schema.prisma:L10984`
- `Modifier` → `schema.prisma:L3501`
- `ModifierGroup` → `schema.prisma:L3465`
- `Module` → `schema.prisma:L9296`
- `MoneyAnomaly` → `schema.prisma:L5634`
- `MonthlyVenueProfit` → `schema.prisma:L6177`
- `Notification` → `schema.prisma:L7231`
- `NotificationPreference` → `schema.prisma:L7278`
- `NotificationTemplate` → `schema.prisma:L7305`
- `OAuthState` → `schema.prisma:L1417`
- `OnboardingProgress` → `schema.prisma:L1435`
- `Order` → `schema.prisma:L3104`
- `OrderAction` → `schema.prisma:L3566`
- `OrderCustomer` → `schema.prisma:L3316`
- `OrderDiscount` → `schema.prisma:L7092`
- `OrderFulfillment` → `schema.prisma:L13636`
- `OrderFulfillmentLine` → `schema.prisma:L13667`
- `OrderItem` → `schema.prisma:L3332`
- `OrderItemModifier` → `schema.prisma:L3550`
- `OrderPromotion` → `schema.prisma:L15745`
- `OrderServiceCharge` → `schema.prisma:L7176`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11358`
- `OrganizationEntitlement` → `schema.prisma:L9579`
- `OrganizationGoal` → `schema.prisma:L11316`
- `OrganizationModule` → `schema.prisma:L9356`
- `OrganizationPaymentConfig` → `schema.prisma:L5294`
- `OrganizationPayoutConfig` → `schema.prisma:L11391`
- `OrganizationPricingStructure` → `schema.prisma:L5326`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11339`
- `OtpChallenge` → `schema.prisma:L6407`
- `PartnerAPIKey` → `schema.prisma:L5124`
- `Payment` → `schema.prisma:L3599`
- `PaymentAllocation` → `schema.prisma:L3864`
- `PaymentLink` → `schema.prisma:L12893`
- `PaymentLinkAttribution` → `schema.prisma:L13001`
- `PaymentLinkItem` → `schema.prisma:L12956`
- `PaymentLinkItemModifier` → `schema.prisma:L12983`
- `PaymentProvider` → `schema.prisma:L4679`
- `PayrollLine` → `schema.prisma:L15253`
- `PayrollRun` → `schema.prisma:L15222`
- `PerformanceGoal` → `schema.prisma:L11293`
- `PermissionOverride` → `schema.prisma:L1294`
- `PermissionSet` → `schema.prisma:L1317`
- `PlatformCfdi` → `schema.prisma:L15538`
- `PlatformEmisor` → `schema.prisma:L15478`
- `PlatformSettings` → `schema.prisma:L5101`
- `PosCommand` → `schema.prisma:L7359`
- `PosConnectionStatus` → `schema.prisma:L877`
- `PosSyncIntent` → `schema.prisma:L15616`
- `PricingPolicy` → `schema.prisma:L2370`
- `Printer` → `schema.prisma:L13450`
- `PrintGateway` → `schema.prisma:L13503`
- `PrintJob` → `schema.prisma:L14217`
- `PrintStation` → `schema.prisma:L13521`
- `ProcessedStripeEvent` → `schema.prisma:L5620`
- `ProcessorReliabilityMetric` → `schema.prisma:L6105`
- `Product` → `schema.prisma:L1605`
- `ProductModifierGroup` → `schema.prisma:L3538`
- `ProductOption` → `schema.prisma:L13184`
- `ProductOptionValue` → `schema.prisma:L13195`
- `ProductStaff` → `schema.prisma:L12149`
- `PromoterBankAccount` → `schema.prisma:L15373`
- `PromoterCommissionEntry` → `schema.prisma:L15392`
- `PromoterLocationPing` → `schema.prisma:L3070`
- `Promotion` → `schema.prisma:L15667`
- `PromotionGroup` → `schema.prisma:L15706`
- `PromotionOption` → `schema.prisma:L15722`
- `ProviderCostStructure` → `schema.prisma:L5656`
- `ProviderEventLog` → `schema.prisma:L5403`
- `PurchaseOrder` → `schema.prisma:L2238`
- `PurchaseOrderItem` → `schema.prisma:L2295`
- `RateCorrectionBatch` → `schema.prisma:L5881`
- `RateCorrectionEntry` → `schema.prisma:L5923`
- `RawMaterial` → `schema.prisma:L1999`
- `RawMaterialMovement` → `schema.prisma:L2423`
- `RawMaterialPresentation` → `schema.prisma:L2072`
- `Recipe` → `schema.prisma:L2092`
- `RecipeLine` → `schema.prisma:L2116`
- `Referral` → `schema.prisma:L6547`
- `ReferralProgramConfig` → `schema.prisma:L6512`
- `ReferralRewardGrant` → `schema.prisma:L6638`
- `ReferralTierReward` → `schema.prisma:L6610`
- `ReferralTierUnlock` → `schema.prisma:L6683`
- `Reservation` → `schema.prisma:L11936`
- `ReservationGoogleEventMapping` → `schema.prisma:L12673`
- `ReservationModifier` → `schema.prisma:L12097`
- `ReservationReminderSent` → `schema.prisma:L12080`
- `ReservationSettings` → `schema.prisma:L12311`
- `ReservationWaitlistEntry` → `schema.prisma:L12279`
- `Review` → `schema.prisma:L4159`
- `SalesRetention` → `schema.prisma:L15073`
- `SaleVerification` → `schema.prisma:L3918`
- `ScaleProfile` → `schema.prisma:L13958`
- `ScheduledCommand` → `schema.prisma:L8800`
- `SerializedItem` → `schema.prisma:L10430`
- `SerializedItemCustodyEvent` → `schema.prisma:L10594`
- `ServiceCharge` → `schema.prisma:L7147`
- `SettlementConfiguration` → `schema.prisma:L5956`
- `SettlementConfirmation` → `schema.prisma:L6069`
- `SettlementIncident` → `schema.prisma:L6020`
- `SettlementSimulation` → `schema.prisma:L5991`
- `Shift` → `schema.prisma:L2911`
- `SimRegistrationRequest` → `schema.prisma:L10632`
- `SimRegistrationRequestItem` → `schema.prisma:L10654`
- `SlotHold` → `schema.prisma:L12180`
- `Staff` → `schema.prisma:L897`
- `StaffOnboardingState` → `schema.prisma:L14288`
- `StaffOrganization` → `schema.prisma:L1193`
- `StaffPasskey` → `schema.prisma:L1220`
- `StaffSchedule` → `schema.prisma:L12120`
- `StaffScheduleException` → `schema.prisma:L12132`
- `StaffVenue` → `schema.prisma:L1123`
- `StockAlertConfig` → `schema.prisma:L11275`
- `StockBatch` → `schema.prisma:L2574`
- `StockCount` → `schema.prisma:L2498`
- `StockCountItem` → `schema.prisma:L2522`
- `StripeWebhookEvent` → `schema.prisma:L5603`
- `Supplier` → `schema.prisma:L2151`
- `SupplierPricing` → `schema.prisma:L2204`
- `Table` → `schema.prisma:L2823`
- `Terminal` → `schema.prisma:L4210`
- `TerminalHealth` → `schema.prisma:L4449`
- `TerminalLog` → `schema.prisma:L4423`
- `TerminalOrder` → `schema.prisma:L4582`
- `TerminalOrderItem` → `schema.prisma:L4657`
- `TerminalPaymentRequest` → `schema.prisma:L4520`
- `TimeEntry` → `schema.prisma:L2983`
- `TimeEntryBreak` → `schema.prisma:L3052`
- `TokenPurchase` → `schema.prisma:L8474`
- `TokenUsageRecord` → `schema.prisma:L8446`
- `TpvCommandHistory` → `schema.prisma:L8706`
- `TpvCommandQueue` → `schema.prisma:L8646`
- `TpvFeedback` → `schema.prisma:L8359`
- `TpvMessage` → `schema.prisma:L11632`
- `TpvMessageDelivery` → `schema.prisma:L11684`
- `TpvMessageResponse` → `schema.prisma:L11707`
- `TrainingModule` → `schema.prisma:L11762`
- `TrainingProgress` → `schema.prisma:L11839`
- `TrainingQuizQuestion` → `schema.prisma:L11821`
- `TrainingStep` → `schema.prisma:L11801`
- `TransactionCost` → `schema.prisma:L5819`
- `UnitConversion` → `schema.prisma:L2401`
- `UpsellAcceptance` → `schema.prisma:L6968`
- `UpsellAiRun` → `schema.prisma:L6988`
- `UpsellImpression` → `schema.prisma:L6928`
- `UpsellRule` → `schema.prisma:L6848`
- `user_sessions` → `schema.prisma:L5159`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L13695`
- `VenueChatMessage` → `schema.prisma:L747`
- `VenueChatSession` → `schema.prisma:L702`
- `VenueCommission` → `schema.prisma:L13345`
- `VenueCreditAssessment` → `schema.prisma:L9168`
- `VenueCryptoConfig` → `schema.prisma:L11499`
- `VenueFeature` → `schema.prisma:L4032`
- `VenueModule` → `schema.prisma:L9328`
- `VenuePaymentConfig` → `schema.prisma:L5260`
- `VenuePaymentLinkSettings` → `schema.prisma:L12706`
- `VenuePricingStructure` → `schema.prisma:L5759`
- `VenueRoleConfig` → `schema.prisma:L1346`
- `VenueRolePermission` → `schema.prisma:L1250`
- `VenueScaleSettings` → `schema.prisma:L13946`
- `VenueSettings` → `schema.prisma:L787`
- `VenueTenderType` → `schema.prisma:L3777`
- `VenueTenderTypeRevision` → `schema.prisma:L3842`
- `VenueTransaction` → `schema.prisma:L3969`
- `VenueWhatsappActivation` → `schema.prisma:L638`
- `WebhookEvent` → `schema.prisma:L4068`
- `WebhookSubscription` → `schema.prisma:L5376`
- `WhatsappContactWindow` → `schema.prisma:L656`
- `WhatsappInboundEvent` → `schema.prisma:L676`
- `Zone` → `schema.prisma:L142`
