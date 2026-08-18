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

- `AccountingPeriodLock` → `schema.prisma:L14814`
- `AccountMapping` → `schema.prisma:L14710`
- `ActivityLog` → `schema.prisma:L6173`
- `Aggregator` → `schema.prisma:L13162`
- `AngelPayUserAccount` → `schema.prisma:L4864`
- `AppUpdate` → `schema.prisma:L11382`
- `Area` → `schema.prisma:L2783`
- `AreaTicket` → `schema.prisma:L13605`
- `AreaTicketCheckoutSession` → `schema.prisma:L13727`
- `AreaTicketExternalIncident` → `schema.prisma:L13974`
- `AreaTicketExternalSettlement` → `schema.prisma:L13939`
- `AreaTicketFulfillment` → `schema.prisma:L13803`
- `AreaTicketInventoryReservation` → `schema.prisma:L13698`
- `AreaTicketLine` → `schema.prisma:L13666`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13759`
- `AreaTicketPrintAttempt` → `schema.prisma:L13782`
- `BankStatement` → `schema.prisma:L14584`
- `BankStatementLine` → `schema.prisma:L14605`
- `BillingTaxProfile` → `schema.prisma:L15394`
- `BulkCommandOperation` → `schema.prisma:L8696`
- `CalendarSyncOutbox` → `schema.prisma:L12556`
- `CampaignDelivery` → `schema.prisma:L11540`
- `CashCloseout` → `schema.prisma:L9061`
- `CashDeposit` → `schema.prisma:L11184`
- `CashDrawerEvent` → `schema.prisma:L12999`
- `CashDrawerSession` → `schema.prisma:L12975`
- `CashOutCommissionRate` → `schema.prisma:L15223`
- `CashOutScheduleDay` → `schema.prisma:L15246`
- `CashOutWithdrawal` → `schema.prisma:L15308`
- `CatalogBindingBatch` → `schema.prisma:L10092`
- `CatalogBindingLine` → `schema.prisma:L10128`
- `CatalogBrand` → `schema.prisma:L9545`
- `CatalogClientObservation` → `schema.prisma:L9858`
- `CatalogClientReadinessOverride` → `schema.prisma:L9877`
- `CatalogFamily` → `schema.prisma:L9595`
- `CatalogIdempotencyRecord` → `schema.prisma:L9991`
- `CatalogIdentifier` → `schema.prisma:L9726`
- `CatalogImportBatch` → `schema.prisma:L10034`
- `CatalogImportLine` → `schema.prisma:L10071`
- `CatalogItem` → `schema.prisma:L9628`
- `CatalogItemBusinessType` → `schema.prisma:L9688`
- `CatalogItemPrice` → `schema.prisma:L9776`
- `CatalogManufacturer` → `schema.prisma:L9569`
- `CatalogProductTypeMapping` → `schema.prisma:L9705`
- `CatalogPublicationBatch` → `schema.prisma:L10156`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10250`
- `CatalogPublicationLine` → `schema.prisma:L10197`
- `CatalogPublicationOutbox` → `schema.prisma:L10293`
- `CatalogValidationProfile` → `schema.prisma:L9747`
- `CatalogVenueBinding` → `schema.prisma:L9905`
- `CatalogVenueClientRequirement` → `schema.prisma:L9832`
- `CatalogVenueEventSequence` → `schema.prisma:L10276`
- `CatalogVenueOverride` → `schema.prisma:L9947`
- `CatalogVenueRollout` → `schema.prisma:L9807`
- `Cfdi` → `schema.prisma:L14487`
- `ChatbotTokenBudget` → `schema.prisma:L8344`
- `ChatConversation` → `schema.prisma:L8199`
- `ChatFeedback` → `schema.prisma:L8285`
- `ChatLearningEvent` → `schema.prisma:L8242`
- `ChatMessage` → `schema.prisma:L8222`
- `ChatTrainingData` → `schema.prisma:L8156`
- `CheckoutSession` → `schema.prisma:L5144`
- `ClassSession` → `schema.prisma:L12174`
- `CommissionCalculation` → `schema.prisma:L10963`
- `CommissionClawback` → `schema.prisma:L11136`
- `CommissionConfig` → `schema.prisma:L10736`
- `CommissionMilestone` → `schema.prisma:L10879`
- `CommissionOverride` → `schema.prisma:L10806`
- `CommissionPayout` → `schema.prisma:L11087`
- `CommissionSummary` → `schema.prisma:L11026`
- `CommissionTier` → `schema.prisma:L10843`
- `Consumer` → `schema.prisma:L6309`
- `ConsumerAuthAccount` → `schema.prisma:L6334`
- `CouponCode` → `schema.prisma:L6950`
- `CouponRedemption` → `schema.prisma:L6981`
- `CreditAssessmentHistory` → `schema.prisma:L9170`
- `CreditItemBalance` → `schema.prisma:L12765`
- `CreditOffer` → `schema.prisma:L9189`
- `CreditPack` → `schema.prisma:L12681`
- `CreditPackItem` → `schema.prisma:L12710`
- `CreditPackPurchase` → `schema.prisma:L12727`
- `CreditTransaction` → `schema.prisma:L12787`
- `Customer` → `schema.prisma:L6214`
- `CustomerDiscount` → `schema.prisma:L7001`
- `CustomerGroup` → `schema.prisma:L6368`
- `CustomerTaxProfile` → `schema.prisma:L14556`
- `DeliveryActivationRequest` → `schema.prisma:L5466`
- `DeliveryChannelLink` → `schema.prisma:L5430`
- `DeliveryOrderEvent` → `schema.prisma:L5490`
- `DeviceToken` → `schema.prisma:L7270`
- `DigitalReceipt` → `schema.prisma:L3859`
- `Discount` → `schema.prisma:L6640`
- `EcommerceMerchant` → `schema.prisma:L4956`
- `EmailTemplate` → `schema.prisma:L11479`
- `Employee` → `schema.prisma:L15071`
- `Estimate` → `schema.prisma:L13069`
- `EstimateItem` → `schema.prisma:L13097`
- `Expense` → `schema.prisma:L14858`
- `ExternalBusyBlock` → `schema.prisma:L12449`
- `Feature` → `schema.prisma:L3988`
- `FeeSchedule` → `schema.prisma:L4066`
- `FeeTier` → `schema.prisma:L4077`
- `FinancialAccount` → `schema.prisma:L13259`
- `FinancialConnection` → `schema.prisma:L13228`
- `FinancialProvider` → `schema.prisma:L13214`
- `FiscalEmisor` → `schema.prisma:L14410`
- `FiscalLossCarryforward` → `schema.prisma:L14981`
- `FixedAsset` → `schema.prisma:L14999`
- `FixedAssetDepreciation` → `schema.prisma:L15028`
- `FloorElement` → `schema.prisma:L2859`
- `FulfillmentArea` → `schema.prisma:L13470`
- `GeofenceRule` → `schema.prisma:L8781`
- `GoogleCalendarChannel` → `schema.prisma:L12426`
- `GoogleCalendarConnection` → `schema.prisma:L12378`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12479`
- `GoogleOAuthSession` → `schema.prisma:L12501`
- `HolidayCalendar` → `schema.prisma:L6097`
- `IdempotencyRequest` → `schema.prisma:L10611`
- `InterVenueTransfer` → `schema.prisma:L2611`
- `InterVenueTransferAllocation` → `schema.prisma:L2694`
- `InterVenueTransferItem` → `schema.prisma:L2663`
- `InterVenueTransferReceipt` → `schema.prisma:L2721`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2737`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2765`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2749`
- `Inventory` → `schema.prisma:L1804`
- `InventoryMovement` → `schema.prisma:L1831`
- `InventoryPosting` → `schema.prisma:L1913`
- `InventoryPostingLine` → `schema.prisma:L1953`
- `InventoryTransfer` → `schema.prisma:L13041`
- `Invitation` → `schema.prisma:L1352`
- `Invoice` → `schema.prisma:L4089`
- `InvoiceItem` → `schema.prisma:L4115`
- `ItemCategory` → `schema.prisma:L10328`
- `JournalEntry` → `schema.prisma:L14768`
- `JournalLine` → `schema.prisma:L14796`
- `KdsOrder` → `schema.prisma:L13307`
- `KdsOrderItem` → `schema.prisma:L13324`
- `LearnedPatterns` → `schema.prisma:L8266`
- `LedgerAccount` → `schema.prisma:L14660`
- `LiveDemoSession` → `schema.prisma:L771`
- `LowStockAlert` → `schema.prisma:L2452`
- `LoyaltyConfig` → `schema.prisma:L6398`
- `LoyaltyTransaction` → `schema.prisma:L6421`
- `MarketingCampaign` → `schema.prisma:L11497`
- `McpAuthCode` → `schema.prisma:L14293`
- `McpOAuthClient` → `schema.prisma:L14277`
- `McpRefreshToken` → `schema.prisma:L14311`
- `McpToolCall` → `schema.prisma:L14332`
- `MeasurementUnit` → `schema.prisma:L13147`
- `Menu` → `schema.prisma:L1538`
- `MenuCategory` → `schema.prisma:L1475`
- `MenuCategoryAssignment` → `schema.prisma:L1573`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14207`
- `MerchantAccount` → `schema.prisma:L4694`
- `MerchantFiscalConfig` → `schema.prisma:L14458`
- `MerchantRevenueShare` → `schema.prisma:L5677`
- `MerchantRoutingRule` → `schema.prisma:L4816`
- `MilestoneAchievement` → `schema.prisma:L10924`
- `Modifier` → `schema.prisma:L3475`
- `ModifierGroup` → `schema.prisma:L3439`
- `Module` → `schema.prisma:L9237`
- `MoneyAnomaly` → `schema.prisma:L5580`
- `MonthlyVenueProfit` → `schema.prisma:L6123`
- `Notification` → `schema.prisma:L7172`
- `NotificationPreference` → `schema.prisma:L7219`
- `NotificationTemplate` → `schema.prisma:L7246`
- `OAuthState` → `schema.prisma:L1403`
- `OnboardingProgress` → `schema.prisma:L1421`
- `Order` → `schema.prisma:L3090`
- `OrderAction` → `schema.prisma:L3540`
- `OrderCustomer` → `schema.prisma:L3290`
- `OrderDiscount` → `schema.prisma:L7033`
- `OrderFulfillment` → `schema.prisma:L13525`
- `OrderFulfillmentLine` → `schema.prisma:L13556`
- `OrderItem` → `schema.prisma:L3306`
- `OrderItemModifier` → `schema.prisma:L3524`
- `OrderPromotion` → `schema.prisma:L15634`
- `OrderServiceCharge` → `schema.prisma:L7117`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11298`
- `OrganizationEntitlement` → `schema.prisma:L9520`
- `OrganizationGoal` → `schema.prisma:L11256`
- `OrganizationModule` → `schema.prisma:L9297`
- `OrganizationPaymentConfig` → `schema.prisma:L5268`
- `OrganizationPayoutConfig` → `schema.prisma:L11331`
- `OrganizationPricingStructure` → `schema.prisma:L5300`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11279`
- `OtpChallenge` → `schema.prisma:L6353`
- `PartnerAPIKey` → `schema.prisma:L5098`
- `Payment` → `schema.prisma:L3573`
- `PaymentAllocation` → `schema.prisma:L3838`
- `PaymentLink` → `schema.prisma:L12833`
- `PaymentLinkAttribution` → `schema.prisma:L12941`
- `PaymentLinkItem` → `schema.prisma:L12896`
- `PaymentLinkItemModifier` → `schema.prisma:L12923`
- `PaymentProvider` → `schema.prisma:L4653`
- `PayrollLine` → `schema.prisma:L15142`
- `PayrollRun` → `schema.prisma:L15111`
- `PerformanceGoal` → `schema.prisma:L11233`
- `PermissionOverride` → `schema.prisma:L1280`
- `PermissionSet` → `schema.prisma:L1303`
- `PlatformCfdi` → `schema.prisma:L15427`
- `PlatformEmisor` → `schema.prisma:L15367`
- `PlatformSettings` → `schema.prisma:L5075`
- `PosCommand` → `schema.prisma:L7300`
- `PosConnectionStatus` → `schema.prisma:L877`
- `PosSyncIntent` → `schema.prisma:L15505`
- `PricingPolicy` → `schema.prisma:L2356`
- `Printer` → `schema.prisma:L13353`
- `PrintGateway` → `schema.prisma:L13406`
- `PrintJob` → `schema.prisma:L14106`
- `PrintStation` → `schema.prisma:L13424`
- `ProcessedStripeEvent` → `schema.prisma:L5566`
- `ProcessorReliabilityMetric` → `schema.prisma:L6051`
- `Product` → `schema.prisma:L1591`
- `ProductModifierGroup` → `schema.prisma:L3512`
- `ProductOption` → `schema.prisma:L13124`
- `ProductOptionValue` → `schema.prisma:L13135`
- `ProductStaff` → `schema.prisma:L12089`
- `PromoterBankAccount` → `schema.prisma:L15262`
- `PromoterCommissionEntry` → `schema.prisma:L15281`
- `PromoterLocationPing` → `schema.prisma:L3056`
- `Promotion` → `schema.prisma:L15556`
- `PromotionGroup` → `schema.prisma:L15595`
- `PromotionOption` → `schema.prisma:L15611`
- `ProviderCostStructure` → `schema.prisma:L5602`
- `ProviderEventLog` → `schema.prisma:L5377`
- `PurchaseOrder` → `schema.prisma:L2224`
- `PurchaseOrderItem` → `schema.prisma:L2281`
- `RateCorrectionBatch` → `schema.prisma:L5827`
- `RateCorrectionEntry` → `schema.prisma:L5869`
- `RawMaterial` → `schema.prisma:L1985`
- `RawMaterialMovement` → `schema.prisma:L2409`
- `RawMaterialPresentation` → `schema.prisma:L2058`
- `Recipe` → `schema.prisma:L2078`
- `RecipeLine` → `schema.prisma:L2102`
- `Referral` → `schema.prisma:L6488`
- `ReferralProgramConfig` → `schema.prisma:L6453`
- `ReferralRewardGrant` → `schema.prisma:L6579`
- `ReferralTierReward` → `schema.prisma:L6551`
- `ReferralTierUnlock` → `schema.prisma:L6624`
- `Reservation` → `schema.prisma:L11876`
- `ReservationGoogleEventMapping` → `schema.prisma:L12613`
- `ReservationModifier` → `schema.prisma:L12037`
- `ReservationReminderSent` → `schema.prisma:L12020`
- `ReservationSettings` → `schema.prisma:L12251`
- `ReservationWaitlistEntry` → `schema.prisma:L12219`
- `Review` → `schema.prisma:L4133`
- `SalesRetention` → `schema.prisma:L14962`
- `SaleVerification` → `schema.prisma:L3892`
- `ScaleProfile` → `schema.prisma:L13847`
- `ScheduledCommand` → `schema.prisma:L8741`
- `SerializedItem` → `schema.prisma:L10371`
- `SerializedItemCustodyEvent` → `schema.prisma:L10534`
- `ServiceCharge` → `schema.prisma:L7088`
- `SettlementConfiguration` → `schema.prisma:L5902`
- `SettlementConfirmation` → `schema.prisma:L6015`
- `SettlementIncident` → `schema.prisma:L5966`
- `SettlementSimulation` → `schema.prisma:L5937`
- `Shift` → `schema.prisma:L2897`
- `SimRegistrationRequest` → `schema.prisma:L10572`
- `SimRegistrationRequestItem` → `schema.prisma:L10594`
- `SlotHold` → `schema.prisma:L12120`
- `Staff` → `schema.prisma:L897`
- `StaffOnboardingState` → `schema.prisma:L14177`
- `StaffOrganization` → `schema.prisma:L1193`
- `StaffPasskey` → `schema.prisma:L1220`
- `StaffSchedule` → `schema.prisma:L12060`
- `StaffScheduleException` → `schema.prisma:L12072`
- `StaffVenue` → `schema.prisma:L1123`
- `StockAlertConfig` → `schema.prisma:L11215`
- `StockBatch` → `schema.prisma:L2560`
- `StockCount` → `schema.prisma:L2484`
- `StockCountItem` → `schema.prisma:L2508`
- `StripeWebhookEvent` → `schema.prisma:L5549`
- `Supplier` → `schema.prisma:L2137`
- `SupplierPricing` → `schema.prisma:L2190`
- `Table` → `schema.prisma:L2809`
- `Terminal` → `schema.prisma:L4184`
- `TerminalHealth` → `schema.prisma:L4423`
- `TerminalLog` → `schema.prisma:L4397`
- `TerminalOrder` → `schema.prisma:L4556`
- `TerminalOrderItem` → `schema.prisma:L4631`
- `TerminalPaymentRequest` → `schema.prisma:L4494`
- `TimeEntry` → `schema.prisma:L2969`
- `TimeEntryBreak` → `schema.prisma:L3038`
- `TokenPurchase` → `schema.prisma:L8415`
- `TokenUsageRecord` → `schema.prisma:L8387`
- `TpvCommandHistory` → `schema.prisma:L8647`
- `TpvCommandQueue` → `schema.prisma:L8587`
- `TpvFeedback` → `schema.prisma:L8300`
- `TpvMessage` → `schema.prisma:L11572`
- `TpvMessageDelivery` → `schema.prisma:L11624`
- `TpvMessageResponse` → `schema.prisma:L11647`
- `TrainingModule` → `schema.prisma:L11702`
- `TrainingProgress` → `schema.prisma:L11779`
- `TrainingQuizQuestion` → `schema.prisma:L11761`
- `TrainingStep` → `schema.prisma:L11741`
- `TransactionCost` → `schema.prisma:L5765`
- `UnitConversion` → `schema.prisma:L2387`
- `UpsellAcceptance` → `schema.prisma:L6909`
- `UpsellAiRun` → `schema.prisma:L6929`
- `UpsellImpression` → `schema.prisma:L6869`
- `UpsellRule` → `schema.prisma:L6789`
- `user_sessions` → `schema.prisma:L5133`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L13584`
- `VenueChatMessage` → `schema.prisma:L747`
- `VenueChatSession` → `schema.prisma:L702`
- `VenueCommission` → `schema.prisma:L13285`
- `VenueCreditAssessment` → `schema.prisma:L9109`
- `VenueCryptoConfig` → `schema.prisma:L11439`
- `VenueFeature` → `schema.prisma:L4006`
- `VenueModule` → `schema.prisma:L9269`
- `VenuePaymentConfig` → `schema.prisma:L5234`
- `VenuePaymentLinkSettings` → `schema.prisma:L12646`
- `VenuePricingStructure` → `schema.prisma:L5705`
- `VenueRoleConfig` → `schema.prisma:L1332`
- `VenueRolePermission` → `schema.prisma:L1250`
- `VenueScaleSettings` → `schema.prisma:L13835`
- `VenueSettings` → `schema.prisma:L787`
- `VenueTenderType` → `schema.prisma:L3751`
- `VenueTenderTypeRevision` → `schema.prisma:L3816`
- `VenueTransaction` → `schema.prisma:L3943`
- `VenueWhatsappActivation` → `schema.prisma:L638`
- `WebhookEvent` → `schema.prisma:L4042`
- `WebhookSubscription` → `schema.prisma:L5350`
- `WhatsappContactWindow` → `schema.prisma:L656`
- `WhatsappInboundEvent` → `schema.prisma:L676`
- `Zone` → `schema.prisma:L142`
