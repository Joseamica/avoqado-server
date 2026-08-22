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

- `AccountingPeriodLock` → `schema.prisma:L14851`
- `AccountMapping` → `schema.prisma:L14747`
- `ActivityLog` → `schema.prisma:L6210`
- `Aggregator` → `schema.prisma:L13199`
- `AngelPayUserAccount` → `schema.prisma:L4886`
- `AppUpdate` → `schema.prisma:L11419`
- `Area` → `schema.prisma:L2797`
- `AreaTicket` → `schema.prisma:L13642`
- `AreaTicketCheckoutSession` → `schema.prisma:L13764`
- `AreaTicketExternalIncident` → `schema.prisma:L14011`
- `AreaTicketExternalSettlement` → `schema.prisma:L13976`
- `AreaTicketFulfillment` → `schema.prisma:L13840`
- `AreaTicketInventoryReservation` → `schema.prisma:L13735`
- `AreaTicketLine` → `schema.prisma:L13703`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13796`
- `AreaTicketPrintAttempt` → `schema.prisma:L13819`
- `BankStatement` → `schema.prisma:L14621`
- `BankStatementLine` → `schema.prisma:L14642`
- `BillingTaxProfile` → `schema.prisma:L15431`
- `BulkCommandOperation` → `schema.prisma:L8733`
- `CalendarSyncOutbox` → `schema.prisma:L12593`
- `CampaignDelivery` → `schema.prisma:L11577`
- `CashCloseout` → `schema.prisma:L9098`
- `CashDeposit` → `schema.prisma:L11221`
- `CashDrawerEvent` → `schema.prisma:L13036`
- `CashDrawerSession` → `schema.prisma:L13012`
- `CashOutCommissionRate` → `schema.prisma:L15260`
- `CashOutScheduleDay` → `schema.prisma:L15283`
- `CashOutWithdrawal` → `schema.prisma:L15345`
- `CatalogBindingBatch` → `schema.prisma:L10129`
- `CatalogBindingLine` → `schema.prisma:L10165`
- `CatalogBrand` → `schema.prisma:L9582`
- `CatalogClientObservation` → `schema.prisma:L9895`
- `CatalogClientReadinessOverride` → `schema.prisma:L9914`
- `CatalogFamily` → `schema.prisma:L9632`
- `CatalogIdempotencyRecord` → `schema.prisma:L10028`
- `CatalogIdentifier` → `schema.prisma:L9763`
- `CatalogImportBatch` → `schema.prisma:L10071`
- `CatalogImportLine` → `schema.prisma:L10108`
- `CatalogItem` → `schema.prisma:L9665`
- `CatalogItemBusinessType` → `schema.prisma:L9725`
- `CatalogItemPrice` → `schema.prisma:L9813`
- `CatalogManufacturer` → `schema.prisma:L9606`
- `CatalogProductTypeMapping` → `schema.prisma:L9742`
- `CatalogPublicationBatch` → `schema.prisma:L10193`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10287`
- `CatalogPublicationLine` → `schema.prisma:L10234`
- `CatalogPublicationOutbox` → `schema.prisma:L10330`
- `CatalogValidationProfile` → `schema.prisma:L9784`
- `CatalogVenueBinding` → `schema.prisma:L9942`
- `CatalogVenueClientRequirement` → `schema.prisma:L9869`
- `CatalogVenueEventSequence` → `schema.prisma:L10313`
- `CatalogVenueOverride` → `schema.prisma:L9984`
- `CatalogVenueRollout` → `schema.prisma:L9844`
- `Cfdi` → `schema.prisma:L14524`
- `ChatbotTokenBudget` → `schema.prisma:L8381`
- `ChatConversation` → `schema.prisma:L8236`
- `ChatFeedback` → `schema.prisma:L8322`
- `ChatLearningEvent` → `schema.prisma:L8279`
- `ChatMessage` → `schema.prisma:L8259`
- `ChatTrainingData` → `schema.prisma:L8193`
- `CheckoutSession` → `schema.prisma:L5166`
- `ClassSession` → `schema.prisma:L12211`
- `CommissionCalculation` → `schema.prisma:L11000`
- `CommissionClawback` → `schema.prisma:L11173`
- `CommissionConfig` → `schema.prisma:L10773`
- `CommissionMilestone` → `schema.prisma:L10916`
- `CommissionOverride` → `schema.prisma:L10843`
- `CommissionPayout` → `schema.prisma:L11124`
- `CommissionSummary` → `schema.prisma:L11063`
- `CommissionTier` → `schema.prisma:L10880`
- `Consumer` → `schema.prisma:L6346`
- `ConsumerAuthAccount` → `schema.prisma:L6371`
- `CouponCode` → `schema.prisma:L6987`
- `CouponRedemption` → `schema.prisma:L7018`
- `CreditAssessmentHistory` → `schema.prisma:L9207`
- `CreditItemBalance` → `schema.prisma:L12802`
- `CreditOffer` → `schema.prisma:L9226`
- `CreditPack` → `schema.prisma:L12718`
- `CreditPackItem` → `schema.prisma:L12747`
- `CreditPackPurchase` → `schema.prisma:L12764`
- `CreditTransaction` → `schema.prisma:L12824`
- `Customer` → `schema.prisma:L6251`
- `CustomerDiscount` → `schema.prisma:L7038`
- `CustomerGroup` → `schema.prisma:L6405`
- `CustomerTaxProfile` → `schema.prisma:L14593`
- `DeliveryActivationRequest` → `schema.prisma:L5494`
- `DeliveryChannelLink` → `schema.prisma:L5452`
- `DeliveryOrderEvent` → `schema.prisma:L5518`
- `DeviceToken` → `schema.prisma:L7307`
- `DigitalReceipt` → `schema.prisma:L3881`
- `Discount` → `schema.prisma:L6677`
- `EcommerceMerchant` → `schema.prisma:L4978`
- `EmailTemplate` → `schema.prisma:L11516`
- `Employee` → `schema.prisma:L15108`
- `Estimate` → `schema.prisma:L13106`
- `EstimateItem` → `schema.prisma:L13134`
- `Expense` → `schema.prisma:L14895`
- `ExternalBusyBlock` → `schema.prisma:L12486`
- `Feature` → `schema.prisma:L4010`
- `FeeSchedule` → `schema.prisma:L4088`
- `FeeTier` → `schema.prisma:L4099`
- `FinancialAccount` → `schema.prisma:L13296`
- `FinancialConnection` → `schema.prisma:L13265`
- `FinancialProvider` → `schema.prisma:L13251`
- `FiscalEmisor` → `schema.prisma:L14447`
- `FiscalLossCarryforward` → `schema.prisma:L15018`
- `FixedAsset` → `schema.prisma:L15036`
- `FixedAssetDepreciation` → `schema.prisma:L15065`
- `FloorElement` → `schema.prisma:L2873`
- `FulfillmentArea` → `schema.prisma:L13507`
- `GeofenceRule` → `schema.prisma:L8818`
- `GoogleCalendarChannel` → `schema.prisma:L12463`
- `GoogleCalendarConnection` → `schema.prisma:L12415`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12516`
- `GoogleOAuthSession` → `schema.prisma:L12538`
- `HolidayCalendar` → `schema.prisma:L6134`
- `IdempotencyRequest` → `schema.prisma:L10648`
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
- `InventoryTransfer` → `schema.prisma:L13078`
- `Invitation` → `schema.prisma:L1366`
- `Invoice` → `schema.prisma:L4111`
- `InvoiceItem` → `schema.prisma:L4137`
- `ItemCategory` → `schema.prisma:L10365`
- `JournalEntry` → `schema.prisma:L14805`
- `JournalLine` → `schema.prisma:L14833`
- `KdsOrder` → `schema.prisma:L13344`
- `KdsOrderItem` → `schema.prisma:L13361`
- `LearnedPatterns` → `schema.prisma:L8303`
- `LedgerAccount` → `schema.prisma:L14697`
- `LiveDemoSession` → `schema.prisma:L771`
- `LowStockAlert` → `schema.prisma:L2466`
- `LoyaltyConfig` → `schema.prisma:L6435`
- `LoyaltyTransaction` → `schema.prisma:L6458`
- `MarketingCampaign` → `schema.prisma:L11534`
- `McpAuthCode` → `schema.prisma:L14330`
- `McpOAuthClient` → `schema.prisma:L14314`
- `McpRefreshToken` → `schema.prisma:L14348`
- `McpToolCall` → `schema.prisma:L14369`
- `MeasurementUnit` → `schema.prisma:L13184`
- `Menu` → `schema.prisma:L1552`
- `MenuCategory` → `schema.prisma:L1489`
- `MenuCategoryAssignment` → `schema.prisma:L1587`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14244`
- `MerchantAccount` → `schema.prisma:L4716`
- `MerchantFiscalConfig` → `schema.prisma:L14495`
- `MerchantRevenueShare` → `schema.prisma:L5714`
- `MerchantRoutingRule` → `schema.prisma:L4838`
- `MilestoneAchievement` → `schema.prisma:L10961`
- `Modifier` → `schema.prisma:L3497`
- `ModifierGroup` → `schema.prisma:L3461`
- `Module` → `schema.prisma:L9274`
- `MoneyAnomaly` → `schema.prisma:L5617`
- `MonthlyVenueProfit` → `schema.prisma:L6160`
- `Notification` → `schema.prisma:L7209`
- `NotificationPreference` → `schema.prisma:L7256`
- `NotificationTemplate` → `schema.prisma:L7283`
- `OAuthState` → `schema.prisma:L1417`
- `OnboardingProgress` → `schema.prisma:L1435`
- `Order` → `schema.prisma:L3104`
- `OrderAction` → `schema.prisma:L3562`
- `OrderCustomer` → `schema.prisma:L3312`
- `OrderDiscount` → `schema.prisma:L7070`
- `OrderFulfillment` → `schema.prisma:L13562`
- `OrderFulfillmentLine` → `schema.prisma:L13593`
- `OrderItem` → `schema.prisma:L3328`
- `OrderItemModifier` → `schema.prisma:L3546`
- `OrderPromotion` → `schema.prisma:L15671`
- `OrderServiceCharge` → `schema.prisma:L7154`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11335`
- `OrganizationEntitlement` → `schema.prisma:L9557`
- `OrganizationGoal` → `schema.prisma:L11293`
- `OrganizationModule` → `schema.prisma:L9334`
- `OrganizationPaymentConfig` → `schema.prisma:L5290`
- `OrganizationPayoutConfig` → `schema.prisma:L11368`
- `OrganizationPricingStructure` → `schema.prisma:L5322`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11316`
- `OtpChallenge` → `schema.prisma:L6390`
- `PartnerAPIKey` → `schema.prisma:L5120`
- `Payment` → `schema.prisma:L3595`
- `PaymentAllocation` → `schema.prisma:L3860`
- `PaymentLink` → `schema.prisma:L12870`
- `PaymentLinkAttribution` → `schema.prisma:L12978`
- `PaymentLinkItem` → `schema.prisma:L12933`
- `PaymentLinkItemModifier` → `schema.prisma:L12960`
- `PaymentProvider` → `schema.prisma:L4675`
- `PayrollLine` → `schema.prisma:L15179`
- `PayrollRun` → `schema.prisma:L15148`
- `PerformanceGoal` → `schema.prisma:L11270`
- `PermissionOverride` → `schema.prisma:L1294`
- `PermissionSet` → `schema.prisma:L1317`
- `PlatformCfdi` → `schema.prisma:L15464`
- `PlatformEmisor` → `schema.prisma:L15404`
- `PlatformSettings` → `schema.prisma:L5097`
- `PosCommand` → `schema.prisma:L7337`
- `PosConnectionStatus` → `schema.prisma:L877`
- `PosSyncIntent` → `schema.prisma:L15542`
- `PricingPolicy` → `schema.prisma:L2370`
- `Printer` → `schema.prisma:L13390`
- `PrintGateway` → `schema.prisma:L13443`
- `PrintJob` → `schema.prisma:L14143`
- `PrintStation` → `schema.prisma:L13461`
- `ProcessedStripeEvent` → `schema.prisma:L5603`
- `ProcessorReliabilityMetric` → `schema.prisma:L6088`
- `Product` → `schema.prisma:L1605`
- `ProductModifierGroup` → `schema.prisma:L3534`
- `ProductOption` → `schema.prisma:L13161`
- `ProductOptionValue` → `schema.prisma:L13172`
- `ProductStaff` → `schema.prisma:L12126`
- `PromoterBankAccount` → `schema.prisma:L15299`
- `PromoterCommissionEntry` → `schema.prisma:L15318`
- `PromoterLocationPing` → `schema.prisma:L3070`
- `Promotion` → `schema.prisma:L15593`
- `PromotionGroup` → `schema.prisma:L15632`
- `PromotionOption` → `schema.prisma:L15648`
- `ProviderCostStructure` → `schema.prisma:L5639`
- `ProviderEventLog` → `schema.prisma:L5399`
- `PurchaseOrder` → `schema.prisma:L2238`
- `PurchaseOrderItem` → `schema.prisma:L2295`
- `RateCorrectionBatch` → `schema.prisma:L5864`
- `RateCorrectionEntry` → `schema.prisma:L5906`
- `RawMaterial` → `schema.prisma:L1999`
- `RawMaterialMovement` → `schema.prisma:L2423`
- `RawMaterialPresentation` → `schema.prisma:L2072`
- `Recipe` → `schema.prisma:L2092`
- `RecipeLine` → `schema.prisma:L2116`
- `Referral` → `schema.prisma:L6525`
- `ReferralProgramConfig` → `schema.prisma:L6490`
- `ReferralRewardGrant` → `schema.prisma:L6616`
- `ReferralTierReward` → `schema.prisma:L6588`
- `ReferralTierUnlock` → `schema.prisma:L6661`
- `Reservation` → `schema.prisma:L11913`
- `ReservationGoogleEventMapping` → `schema.prisma:L12650`
- `ReservationModifier` → `schema.prisma:L12074`
- `ReservationReminderSent` → `schema.prisma:L12057`
- `ReservationSettings` → `schema.prisma:L12288`
- `ReservationWaitlistEntry` → `schema.prisma:L12256`
- `Review` → `schema.prisma:L4155`
- `SalesRetention` → `schema.prisma:L14999`
- `SaleVerification` → `schema.prisma:L3914`
- `ScaleProfile` → `schema.prisma:L13884`
- `ScheduledCommand` → `schema.prisma:L8778`
- `SerializedItem` → `schema.prisma:L10408`
- `SerializedItemCustodyEvent` → `schema.prisma:L10571`
- `ServiceCharge` → `schema.prisma:L7125`
- `SettlementConfiguration` → `schema.prisma:L5939`
- `SettlementConfirmation` → `schema.prisma:L6052`
- `SettlementIncident` → `schema.prisma:L6003`
- `SettlementSimulation` → `schema.prisma:L5974`
- `Shift` → `schema.prisma:L2911`
- `SimRegistrationRequest` → `schema.prisma:L10609`
- `SimRegistrationRequestItem` → `schema.prisma:L10631`
- `SlotHold` → `schema.prisma:L12157`
- `Staff` → `schema.prisma:L897`
- `StaffOnboardingState` → `schema.prisma:L14214`
- `StaffOrganization` → `schema.prisma:L1193`
- `StaffPasskey` → `schema.prisma:L1220`
- `StaffSchedule` → `schema.prisma:L12097`
- `StaffScheduleException` → `schema.prisma:L12109`
- `StaffVenue` → `schema.prisma:L1123`
- `StockAlertConfig` → `schema.prisma:L11252`
- `StockBatch` → `schema.prisma:L2574`
- `StockCount` → `schema.prisma:L2498`
- `StockCountItem` → `schema.prisma:L2522`
- `StripeWebhookEvent` → `schema.prisma:L5586`
- `Supplier` → `schema.prisma:L2151`
- `SupplierPricing` → `schema.prisma:L2204`
- `Table` → `schema.prisma:L2823`
- `Terminal` → `schema.prisma:L4206`
- `TerminalHealth` → `schema.prisma:L4445`
- `TerminalLog` → `schema.prisma:L4419`
- `TerminalOrder` → `schema.prisma:L4578`
- `TerminalOrderItem` → `schema.prisma:L4653`
- `TerminalPaymentRequest` → `schema.prisma:L4516`
- `TimeEntry` → `schema.prisma:L2983`
- `TimeEntryBreak` → `schema.prisma:L3052`
- `TokenPurchase` → `schema.prisma:L8452`
- `TokenUsageRecord` → `schema.prisma:L8424`
- `TpvCommandHistory` → `schema.prisma:L8684`
- `TpvCommandQueue` → `schema.prisma:L8624`
- `TpvFeedback` → `schema.prisma:L8337`
- `TpvMessage` → `schema.prisma:L11609`
- `TpvMessageDelivery` → `schema.prisma:L11661`
- `TpvMessageResponse` → `schema.prisma:L11684`
- `TrainingModule` → `schema.prisma:L11739`
- `TrainingProgress` → `schema.prisma:L11816`
- `TrainingQuizQuestion` → `schema.prisma:L11798`
- `TrainingStep` → `schema.prisma:L11778`
- `TransactionCost` → `schema.prisma:L5802`
- `UnitConversion` → `schema.prisma:L2401`
- `UpsellAcceptance` → `schema.prisma:L6946`
- `UpsellAiRun` → `schema.prisma:L6966`
- `UpsellImpression` → `schema.prisma:L6906`
- `UpsellRule` → `schema.prisma:L6826`
- `user_sessions` → `schema.prisma:L5155`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L13621`
- `VenueChatMessage` → `schema.prisma:L747`
- `VenueChatSession` → `schema.prisma:L702`
- `VenueCommission` → `schema.prisma:L13322`
- `VenueCreditAssessment` → `schema.prisma:L9146`
- `VenueCryptoConfig` → `schema.prisma:L11476`
- `VenueFeature` → `schema.prisma:L4028`
- `VenueModule` → `schema.prisma:L9306`
- `VenuePaymentConfig` → `schema.prisma:L5256`
- `VenuePaymentLinkSettings` → `schema.prisma:L12683`
- `VenuePricingStructure` → `schema.prisma:L5742`
- `VenueRoleConfig` → `schema.prisma:L1346`
- `VenueRolePermission` → `schema.prisma:L1250`
- `VenueScaleSettings` → `schema.prisma:L13872`
- `VenueSettings` → `schema.prisma:L787`
- `VenueTenderType` → `schema.prisma:L3773`
- `VenueTenderTypeRevision` → `schema.prisma:L3838`
- `VenueTransaction` → `schema.prisma:L3965`
- `VenueWhatsappActivation` → `schema.prisma:L638`
- `WebhookEvent` → `schema.prisma:L4064`
- `WebhookSubscription` → `schema.prisma:L5372`
- `WhatsappContactWindow` → `schema.prisma:L656`
- `WhatsappInboundEvent` → `schema.prisma:L676`
- `Zone` → `schema.prisma:L142`
