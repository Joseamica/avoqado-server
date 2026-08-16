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

- `AccountingPeriodLock` → `schema.prisma:L14762`
- `AccountMapping` → `schema.prisma:L14658`
- `ActivityLog` → `schema.prisma:L6131`
- `Aggregator` → `schema.prisma:L13110`
- `AngelPayUserAccount` → `schema.prisma:L4840`
- `AppUpdate` → `schema.prisma:L11330`
- `Area` → `schema.prisma:L2765`
- `AreaTicket` → `schema.prisma:L13553`
- `AreaTicketCheckoutSession` → `schema.prisma:L13675`
- `AreaTicketExternalIncident` → `schema.prisma:L13922`
- `AreaTicketExternalSettlement` → `schema.prisma:L13887`
- `AreaTicketFulfillment` → `schema.prisma:L13751`
- `AreaTicketInventoryReservation` → `schema.prisma:L13646`
- `AreaTicketLine` → `schema.prisma:L13614`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13707`
- `AreaTicketPrintAttempt` → `schema.prisma:L13730`
- `BankStatement` → `schema.prisma:L14532`
- `BankStatementLine` → `schema.prisma:L14553`
- `BillingTaxProfile` → `schema.prisma:L15342`
- `BulkCommandOperation` → `schema.prisma:L8644`
- `CalendarSyncOutbox` → `schema.prisma:L12504`
- `CampaignDelivery` → `schema.prisma:L11488`
- `CashCloseout` → `schema.prisma:L9009`
- `CashDeposit` → `schema.prisma:L11132`
- `CashDrawerEvent` → `schema.prisma:L12947`
- `CashDrawerSession` → `schema.prisma:L12923`
- `CashOutCommissionRate` → `schema.prisma:L15171`
- `CashOutScheduleDay` → `schema.prisma:L15194`
- `CashOutWithdrawal` → `schema.prisma:L15256`
- `CatalogBindingBatch` → `schema.prisma:L10040`
- `CatalogBindingLine` → `schema.prisma:L10076`
- `CatalogBrand` → `schema.prisma:L9493`
- `CatalogClientObservation` → `schema.prisma:L9806`
- `CatalogClientReadinessOverride` → `schema.prisma:L9825`
- `CatalogFamily` → `schema.prisma:L9543`
- `CatalogIdempotencyRecord` → `schema.prisma:L9939`
- `CatalogIdentifier` → `schema.prisma:L9674`
- `CatalogImportBatch` → `schema.prisma:L9982`
- `CatalogImportLine` → `schema.prisma:L10019`
- `CatalogItem` → `schema.prisma:L9576`
- `CatalogItemBusinessType` → `schema.prisma:L9636`
- `CatalogItemPrice` → `schema.prisma:L9724`
- `CatalogManufacturer` → `schema.prisma:L9517`
- `CatalogProductTypeMapping` → `schema.prisma:L9653`
- `CatalogPublicationBatch` → `schema.prisma:L10104`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10198`
- `CatalogPublicationLine` → `schema.prisma:L10145`
- `CatalogPublicationOutbox` → `schema.prisma:L10241`
- `CatalogValidationProfile` → `schema.prisma:L9695`
- `CatalogVenueBinding` → `schema.prisma:L9853`
- `CatalogVenueClientRequirement` → `schema.prisma:L9780`
- `CatalogVenueEventSequence` → `schema.prisma:L10224`
- `CatalogVenueOverride` → `schema.prisma:L9895`
- `CatalogVenueRollout` → `schema.prisma:L9755`
- `Cfdi` → `schema.prisma:L14435`
- `ChatbotTokenBudget` → `schema.prisma:L8292`
- `ChatConversation` → `schema.prisma:L8147`
- `ChatFeedback` → `schema.prisma:L8233`
- `ChatLearningEvent` → `schema.prisma:L8190`
- `ChatMessage` → `schema.prisma:L8170`
- `ChatTrainingData` → `schema.prisma:L8104`
- `CheckoutSession` → `schema.prisma:L5120`
- `ClassSession` → `schema.prisma:L12122`
- `CommissionCalculation` → `schema.prisma:L10911`
- `CommissionClawback` → `schema.prisma:L11084`
- `CommissionConfig` → `schema.prisma:L10684`
- `CommissionMilestone` → `schema.prisma:L10827`
- `CommissionOverride` → `schema.prisma:L10754`
- `CommissionPayout` → `schema.prisma:L11035`
- `CommissionSummary` → `schema.prisma:L10974`
- `CommissionTier` → `schema.prisma:L10791`
- `Consumer` → `schema.prisma:L6267`
- `ConsumerAuthAccount` → `schema.prisma:L6292`
- `CouponCode` → `schema.prisma:L6898`
- `CouponRedemption` → `schema.prisma:L6929`
- `CreditAssessmentHistory` → `schema.prisma:L9118`
- `CreditItemBalance` → `schema.prisma:L12713`
- `CreditOffer` → `schema.prisma:L9137`
- `CreditPack` → `schema.prisma:L12629`
- `CreditPackItem` → `schema.prisma:L12658`
- `CreditPackPurchase` → `schema.prisma:L12675`
- `CreditTransaction` → `schema.prisma:L12735`
- `Customer` → `schema.prisma:L6172`
- `CustomerDiscount` → `schema.prisma:L6949`
- `CustomerGroup` → `schema.prisma:L6326`
- `CustomerTaxProfile` → `schema.prisma:L14504`
- `DeliveryActivationRequest` → `schema.prisma:L5442`
- `DeliveryChannelLink` → `schema.prisma:L5406`
- `DeliveryOrderEvent` → `schema.prisma:L5466`
- `DeviceToken` → `schema.prisma:L7218`
- `DigitalReceipt` → `schema.prisma:L3841`
- `Discount` → `schema.prisma:L6598`
- `EcommerceMerchant` → `schema.prisma:L4932`
- `EmailTemplate` → `schema.prisma:L11427`
- `Employee` → `schema.prisma:L15019`
- `Estimate` → `schema.prisma:L13017`
- `EstimateItem` → `schema.prisma:L13045`
- `Expense` → `schema.prisma:L14806`
- `ExternalBusyBlock` → `schema.prisma:L12397`
- `Feature` → `schema.prisma:L3970`
- `FeeSchedule` → `schema.prisma:L4048`
- `FeeTier` → `schema.prisma:L4059`
- `FinancialAccount` → `schema.prisma:L13207`
- `FinancialConnection` → `schema.prisma:L13176`
- `FinancialProvider` → `schema.prisma:L13162`
- `FiscalEmisor` → `schema.prisma:L14358`
- `FiscalLossCarryforward` → `schema.prisma:L14929`
- `FixedAsset` → `schema.prisma:L14947`
- `FixedAssetDepreciation` → `schema.prisma:L14976`
- `FloorElement` → `schema.prisma:L2841`
- `FulfillmentArea` → `schema.prisma:L13418`
- `GeofenceRule` → `schema.prisma:L8729`
- `GoogleCalendarChannel` → `schema.prisma:L12374`
- `GoogleCalendarConnection` → `schema.prisma:L12326`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12427`
- `GoogleOAuthSession` → `schema.prisma:L12449`
- `HolidayCalendar` → `schema.prisma:L6055`
- `IdempotencyRequest` → `schema.prisma:L10559`
- `InterVenueTransfer` → `schema.prisma:L2593`
- `InterVenueTransferAllocation` → `schema.prisma:L2676`
- `InterVenueTransferItem` → `schema.prisma:L2645`
- `InterVenueTransferReceipt` → `schema.prisma:L2703`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2719`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2747`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2731`
- `Inventory` → `schema.prisma:L1792`
- `InventoryMovement` → `schema.prisma:L1819`
- `InventoryPosting` → `schema.prisma:L1901`
- `InventoryPostingLine` → `schema.prisma:L1935`
- `InventoryTransfer` → `schema.prisma:L12989`
- `Invitation` → `schema.prisma:L1340`
- `Invoice` → `schema.prisma:L4071`
- `InvoiceItem` → `schema.prisma:L4097`
- `ItemCategory` → `schema.prisma:L10276`
- `JournalEntry` → `schema.prisma:L14716`
- `JournalLine` → `schema.prisma:L14744`
- `KdsOrder` → `schema.prisma:L13255`
- `KdsOrderItem` → `schema.prisma:L13272`
- `LearnedPatterns` → `schema.prisma:L8214`
- `LedgerAccount` → `schema.prisma:L14608`
- `LiveDemoSession` → `schema.prisma:L759`
- `LowStockAlert` → `schema.prisma:L2434`
- `LoyaltyConfig` → `schema.prisma:L6356`
- `LoyaltyTransaction` → `schema.prisma:L6379`
- `MarketingCampaign` → `schema.prisma:L11445`
- `McpAuthCode` → `schema.prisma:L14241`
- `McpOAuthClient` → `schema.prisma:L14225`
- `McpRefreshToken` → `schema.prisma:L14259`
- `McpToolCall` → `schema.prisma:L14280`
- `MeasurementUnit` → `schema.prisma:L13095`
- `Menu` → `schema.prisma:L1526`
- `MenuCategory` → `schema.prisma:L1463`
- `MenuCategoryAssignment` → `schema.prisma:L1561`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14155`
- `MerchantAccount` → `schema.prisma:L4670`
- `MerchantFiscalConfig` → `schema.prisma:L14406`
- `MerchantRevenueShare` → `schema.prisma:L5635`
- `MerchantRoutingRule` → `schema.prisma:L4792`
- `MilestoneAchievement` → `schema.prisma:L10872`
- `Modifier` → `schema.prisma:L3457`
- `ModifierGroup` → `schema.prisma:L3421`
- `Module` → `schema.prisma:L9185`
- `MoneyAnomaly` → `schema.prisma:L5538`
- `MonthlyVenueProfit` → `schema.prisma:L6081`
- `Notification` → `schema.prisma:L7120`
- `NotificationPreference` → `schema.prisma:L7167`
- `NotificationTemplate` → `schema.prisma:L7194`
- `OAuthState` → `schema.prisma:L1391`
- `OnboardingProgress` → `schema.prisma:L1409`
- `Order` → `schema.prisma:L3072`
- `OrderAction` → `schema.prisma:L3522`
- `OrderCustomer` → `schema.prisma:L3272`
- `OrderDiscount` → `schema.prisma:L6981`
- `OrderFulfillment` → `schema.prisma:L13473`
- `OrderFulfillmentLine` → `schema.prisma:L13504`
- `OrderItem` → `schema.prisma:L3288`
- `OrderItemModifier` → `schema.prisma:L3506`
- `OrderPromotion` → `schema.prisma:L15582`
- `OrderServiceCharge` → `schema.prisma:L7065`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11246`
- `OrganizationEntitlement` → `schema.prisma:L9468`
- `OrganizationGoal` → `schema.prisma:L11204`
- `OrganizationModule` → `schema.prisma:L9245`
- `OrganizationPaymentConfig` → `schema.prisma:L5244`
- `OrganizationPayoutConfig` → `schema.prisma:L11279`
- `OrganizationPricingStructure` → `schema.prisma:L5276`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11227`
- `OtpChallenge` → `schema.prisma:L6311`
- `PartnerAPIKey` → `schema.prisma:L5074`
- `Payment` → `schema.prisma:L3555`
- `PaymentAllocation` → `schema.prisma:L3820`
- `PaymentLink` → `schema.prisma:L12781`
- `PaymentLinkAttribution` → `schema.prisma:L12889`
- `PaymentLinkItem` → `schema.prisma:L12844`
- `PaymentLinkItemModifier` → `schema.prisma:L12871`
- `PaymentProvider` → `schema.prisma:L4629`
- `PayrollLine` → `schema.prisma:L15090`
- `PayrollRun` → `schema.prisma:L15059`
- `PerformanceGoal` → `schema.prisma:L11181`
- `PermissionOverride` → `schema.prisma:L1268`
- `PermissionSet` → `schema.prisma:L1291`
- `PlatformCfdi` → `schema.prisma:L15375`
- `PlatformEmisor` → `schema.prisma:L15315`
- `PlatformSettings` → `schema.prisma:L5051`
- `PosCommand` → `schema.prisma:L7248`
- `PosConnectionStatus` → `schema.prisma:L865`
- `PosSyncIntent` → `schema.prisma:L15453`
- `PricingPolicy` → `schema.prisma:L2338`
- `Printer` → `schema.prisma:L13301`
- `PrintGateway` → `schema.prisma:L13354`
- `PrintJob` → `schema.prisma:L14054`
- `PrintStation` → `schema.prisma:L13372`
- `ProcessedStripeEvent` → `schema.prisma:L5524`
- `ProcessorReliabilityMetric` → `schema.prisma:L6009`
- `Product` → `schema.prisma:L1579`
- `ProductModifierGroup` → `schema.prisma:L3494`
- `ProductOption` → `schema.prisma:L13072`
- `ProductOptionValue` → `schema.prisma:L13083`
- `ProductStaff` → `schema.prisma:L12037`
- `PromoterBankAccount` → `schema.prisma:L15210`
- `PromoterCommissionEntry` → `schema.prisma:L15229`
- `PromoterLocationPing` → `schema.prisma:L3038`
- `Promotion` → `schema.prisma:L15504`
- `PromotionGroup` → `schema.prisma:L15543`
- `PromotionOption` → `schema.prisma:L15559`
- `ProviderCostStructure` → `schema.prisma:L5560`
- `ProviderEventLog` → `schema.prisma:L5353`
- `PurchaseOrder` → `schema.prisma:L2206`
- `PurchaseOrderItem` → `schema.prisma:L2263`
- `RateCorrectionBatch` → `schema.prisma:L5785`
- `RateCorrectionEntry` → `schema.prisma:L5827`
- `RawMaterial` → `schema.prisma:L1967`
- `RawMaterialMovement` → `schema.prisma:L2391`
- `RawMaterialPresentation` → `schema.prisma:L2040`
- `Recipe` → `schema.prisma:L2060`
- `RecipeLine` → `schema.prisma:L2084`
- `Referral` → `schema.prisma:L6446`
- `ReferralProgramConfig` → `schema.prisma:L6411`
- `ReferralRewardGrant` → `schema.prisma:L6537`
- `ReferralTierReward` → `schema.prisma:L6509`
- `ReferralTierUnlock` → `schema.prisma:L6582`
- `Reservation` → `schema.prisma:L11824`
- `ReservationGoogleEventMapping` → `schema.prisma:L12561`
- `ReservationModifier` → `schema.prisma:L11985`
- `ReservationReminderSent` → `schema.prisma:L11968`
- `ReservationSettings` → `schema.prisma:L12199`
- `ReservationWaitlistEntry` → `schema.prisma:L12167`
- `Review` → `schema.prisma:L4115`
- `SalesRetention` → `schema.prisma:L14910`
- `SaleVerification` → `schema.prisma:L3874`
- `ScaleProfile` → `schema.prisma:L13795`
- `ScheduledCommand` → `schema.prisma:L8689`
- `SerializedItem` → `schema.prisma:L10319`
- `SerializedItemCustodyEvent` → `schema.prisma:L10482`
- `ServiceCharge` → `schema.prisma:L7036`
- `SettlementConfiguration` → `schema.prisma:L5860`
- `SettlementConfirmation` → `schema.prisma:L5973`
- `SettlementIncident` → `schema.prisma:L5924`
- `SettlementSimulation` → `schema.prisma:L5895`
- `Shift` → `schema.prisma:L2879`
- `SimRegistrationRequest` → `schema.prisma:L10520`
- `SimRegistrationRequestItem` → `schema.prisma:L10542`
- `SlotHold` → `schema.prisma:L12068`
- `Staff` → `schema.prisma:L885`
- `StaffOnboardingState` → `schema.prisma:L14125`
- `StaffOrganization` → `schema.prisma:L1181`
- `StaffPasskey` → `schema.prisma:L1208`
- `StaffSchedule` → `schema.prisma:L12008`
- `StaffScheduleException` → `schema.prisma:L12020`
- `StaffVenue` → `schema.prisma:L1111`
- `StockAlertConfig` → `schema.prisma:L11163`
- `StockBatch` → `schema.prisma:L2542`
- `StockCount` → `schema.prisma:L2466`
- `StockCountItem` → `schema.prisma:L2490`
- `StripeWebhookEvent` → `schema.prisma:L5507`
- `Supplier` → `schema.prisma:L2119`
- `SupplierPricing` → `schema.prisma:L2172`
- `Table` → `schema.prisma:L2791`
- `Terminal` → `schema.prisma:L4166`
- `TerminalHealth` → `schema.prisma:L4405`
- `TerminalLog` → `schema.prisma:L4379`
- `TerminalOrder` → `schema.prisma:L4532`
- `TerminalOrderItem` → `schema.prisma:L4607`
- `TerminalPaymentRequest` → `schema.prisma:L4476`
- `TimeEntry` → `schema.prisma:L2951`
- `TimeEntryBreak` → `schema.prisma:L3020`
- `TokenPurchase` → `schema.prisma:L8363`
- `TokenUsageRecord` → `schema.prisma:L8335`
- `TpvCommandHistory` → `schema.prisma:L8595`
- `TpvCommandQueue` → `schema.prisma:L8535`
- `TpvFeedback` → `schema.prisma:L8248`
- `TpvMessage` → `schema.prisma:L11520`
- `TpvMessageDelivery` → `schema.prisma:L11572`
- `TpvMessageResponse` → `schema.prisma:L11595`
- `TrainingModule` → `schema.prisma:L11650`
- `TrainingProgress` → `schema.prisma:L11727`
- `TrainingQuizQuestion` → `schema.prisma:L11709`
- `TrainingStep` → `schema.prisma:L11689`
- `TransactionCost` → `schema.prisma:L5723`
- `UnitConversion` → `schema.prisma:L2369`
- `UpsellAcceptance` → `schema.prisma:L6857`
- `UpsellAiRun` → `schema.prisma:L6877`
- `UpsellImpression` → `schema.prisma:L6817`
- `UpsellRule` → `schema.prisma:L6747`
- `user_sessions` → `schema.prisma:L5109`
- `Venue` → `schema.prisma:L147`
- `VenueAreaTicketSettings` → `schema.prisma:L13532`
- `VenueChatMessage` → `schema.prisma:L735`
- `VenueChatSession` → `schema.prisma:L690`
- `VenueCommission` → `schema.prisma:L13233`
- `VenueCreditAssessment` → `schema.prisma:L9057`
- `VenueCryptoConfig` → `schema.prisma:L11387`
- `VenueFeature` → `schema.prisma:L3988`
- `VenueModule` → `schema.prisma:L9217`
- `VenuePaymentConfig` → `schema.prisma:L5210`
- `VenuePaymentLinkSettings` → `schema.prisma:L12594`
- `VenuePricingStructure` → `schema.prisma:L5663`
- `VenueRoleConfig` → `schema.prisma:L1320`
- `VenueRolePermission` → `schema.prisma:L1238`
- `VenueScaleSettings` → `schema.prisma:L13783`
- `VenueSettings` → `schema.prisma:L775`
- `VenueTenderType` → `schema.prisma:L3733`
- `VenueTenderTypeRevision` → `schema.prisma:L3798`
- `VenueTransaction` → `schema.prisma:L3925`
- `VenueWhatsappActivation` → `schema.prisma:L626`
- `WebhookEvent` → `schema.prisma:L4024`
- `WebhookSubscription` → `schema.prisma:L5326`
- `WhatsappContactWindow` → `schema.prisma:L644`
- `WhatsappInboundEvent` → `schema.prisma:L664`
- `Zone` → `schema.prisma:L130`
