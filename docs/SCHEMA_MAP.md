# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **357 models / 339 enums / ~17,100 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                        |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                            |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                                      |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                           |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                           |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                     |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                        |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L15922`
- `AccountMapping` → `schema.prisma:L15818`
- `ActivityLog` → `schema.prisma:L6703`
- `Aggregator` → `schema.prisma:L14215`
- `AngelPayUserAccount` → `schema.prisma:L5366`
- `AppUpdate` → `schema.prisma:L12395`
- `Area` → `schema.prisma:L3026`
- `AreaTicket` → `schema.prisma:L14713`
- `AreaTicketCheckoutSession` → `schema.prisma:L14835`
- `AreaTicketExternalIncident` → `schema.prisma:L15082`
- `AreaTicketExternalSettlement` → `schema.prisma:L15047`
- `AreaTicketFulfillment` → `schema.prisma:L14911`
- `AreaTicketInventoryReservation` → `schema.prisma:L14806`
- `AreaTicketLine` → `schema.prisma:L14774`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14867`
- `AreaTicketPrintAttempt` → `schema.prisma:L14890`
- `BankStatement` → `schema.prisma:L15692`
- `BankStatementLine` → `schema.prisma:L15713`
- `BillingTaxProfile` → `schema.prisma:L16502`
- `BulkCommandOperation` → `schema.prisma:L9675`
- `CalendarSyncOutbox` → `schema.prisma:L13602`
- `CampaignDelivery` → `schema.prisma:L12553`
- `CashCloseout` → `schema.prisma:L10060`
- `CashDeposit` → `schema.prisma:L12197`
- `CashDrawerEvent` → `schema.prisma:L14052`
- `CashDrawerSession` → `schema.prisma:L14028`
- `CashOutCommissionRate` → `schema.prisma:L16331`
- `CashOutScheduleDay` → `schema.prisma:L16354`
- `CashOutWithdrawal` → `schema.prisma:L16416`
- `CatalogBindingBatch` → `schema.prisma:L11091`
- `CatalogBindingLine` → `schema.prisma:L11127`
- `CatalogBrand` → `schema.prisma:L10544`
- `CatalogClientObservation` → `schema.prisma:L10857`
- `CatalogClientReadinessOverride` → `schema.prisma:L10876`
- `CatalogFamily` → `schema.prisma:L10594`
- `CatalogIdempotencyRecord` → `schema.prisma:L10990`
- `CatalogIdentifier` → `schema.prisma:L10725`
- `CatalogImportBatch` → `schema.prisma:L11033`
- `CatalogImportLine` → `schema.prisma:L11070`
- `CatalogItem` → `schema.prisma:L10627`
- `CatalogItemBusinessType` → `schema.prisma:L10687`
- `CatalogItemPrice` → `schema.prisma:L10775`
- `CatalogManufacturer` → `schema.prisma:L10568`
- `CatalogProductTypeMapping` → `schema.prisma:L10704`
- `CatalogPublicationBatch` → `schema.prisma:L11155`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11249`
- `CatalogPublicationLine` → `schema.prisma:L11196`
- `CatalogPublicationOutbox` → `schema.prisma:L11292`
- `CatalogValidationProfile` → `schema.prisma:L10746`
- `CatalogVenueBinding` → `schema.prisma:L10904`
- `CatalogVenueClientRequirement` → `schema.prisma:L10831`
- `CatalogVenueEventSequence` → `schema.prisma:L11275`
- `CatalogVenueOverride` → `schema.prisma:L10946`
- `CatalogVenueRollout` → `schema.prisma:L10806`
- `Cfdi` → `schema.prisma:L15595`
- `ChatbotTokenBudget` → `schema.prisma:L9323`
- `ChatConversation` → `schema.prisma:L9178`
- `ChatFeedback` → `schema.prisma:L9264`
- `ChatLearningEvent` → `schema.prisma:L9221`
- `ChatMessage` → `schema.prisma:L9201`
- `ChatTrainingData` → `schema.prisma:L9135`
- `CheckoutSession` → `schema.prisma:L5646`
- `ClassSession` → `schema.prisma:L13206`
- `CommissionCalculation` → `schema.prisma:L11973`
- `CommissionClawback` → `schema.prisma:L12149`
- `CommissionConfig` → `schema.prisma:L11739`
- `CommissionMilestone` → `schema.prisma:L11889`
- `CommissionOverride` → `schema.prisma:L11816`
- `CommissionPayout` → `schema.prisma:L12100`
- `CommissionSummary` → `schema.prisma:L12039`
- `CommissionTier` → `schema.prisma:L11853`
- `Consumer` → `schema.prisma:L6866`
- `ConsumerAuthAccount` → `schema.prisma:L6891`
- `CouponCode` → `schema.prisma:L7830`
- `CouponRedemption` → `schema.prisma:L7861`
- `CreditAssessmentHistory` → `schema.prisma:L10169`
- `CreditItemBalance` → `schema.prisma:L13818`
- `CreditOffer` → `schema.prisma:L10188`
- `CreditPack` → `schema.prisma:L13727`
- `CreditPackItem` → `schema.prisma:L13756`
- `CreditPackPurchase` → `schema.prisma:L13773`
- `CreditTransaction` → `schema.prisma:L13840`
- `Customer` → `schema.prisma:L6744`
- `CustomerApprovalDelivery` → `schema.prisma:L8837`
- `CustomerApprovalOutbox` → `schema.prisma:L8812`
- `CustomerDiscount` → `schema.prisma:L7881`
- `CustomerGroup` → `schema.prisma:L6930`
- `CustomerOrderMetric` → `schema.prisma:L3778`
- `CustomerTaxProfile` → `schema.prisma:L15664`
- `DeliveryActivationRequest` → `schema.prisma:L5987`
- `DeliveryChannelLink` → `schema.prisma:L5932`
- `DeliveryOrderEvent` → `schema.prisma:L6011`
- `DeviceToken` → `schema.prisma:L8150`
- `DigitalReceipt` → `schema.prisma:L4349`
- `Discount` → `schema.prisma:L7520`
- `EcommerceMerchant` → `schema.prisma:L5458`
- `EmailTemplate` → `schema.prisma:L12492`
- `Employee` → `schema.prisma:L16179`
- `Estimate` → `schema.prisma:L14122`
- `EstimateItem` → `schema.prisma:L14150`
- `Expense` → `schema.prisma:L15966`
- `ExternalBusyBlock` → `schema.prisma:L13495`
- `Feature` → `schema.prisma:L4478`
- `FeeSchedule` → `schema.prisma:L4556`
- `FeeTier` → `schema.prisma:L4567`
- `FinancialAccount` → `schema.prisma:L14312`
- `FinancialConnection` → `schema.prisma:L14281`
- `FinancialProvider` → `schema.prisma:L14267`
- `FiscalEmisor` → `schema.prisma:L15518`
- `FiscalLossCarryforward` → `schema.prisma:L16089`
- `FixedAsset` → `schema.prisma:L16107`
- `FixedAssetDepreciation` → `schema.prisma:L16136`
- `FloorElement` → `schema.prisma:L3102`
- `FulfillmentArea` → `schema.prisma:L14578`
- `GeofenceRule` → `schema.prisma:L9760`
- `GoogleCalendarChannel` → `schema.prisma:L13472`
- `GoogleCalendarConnection` → `schema.prisma:L13424`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13525`
- `GoogleOAuthSession` → `schema.prisma:L13547`
- `HolidayCalendar` → `schema.prisma:L6627`
- `IdempotencyRequest` → `schema.prisma:L11614`
- `InterVenueTransfer` → `schema.prisma:L2854`
- `InterVenueTransferAllocation` → `schema.prisma:L2937`
- `InterVenueTransferItem` → `schema.prisma:L2906`
- `InterVenueTransferReceipt` → `schema.prisma:L2964`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2980`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3008`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2992`
- `Inventory` → `schema.prisma:L1900`
- `InventoryMovement` → `schema.prisma:L1927`
- `InventoryPosting` → `schema.prisma:L2009`
- `InventoryPostingLine` → `schema.prisma:L2049`
- `InventoryTransfer` → `schema.prisma:L14094`
- `Invitation` → `schema.prisma:L1438`
- `Invoice` → `schema.prisma:L4579`
- `InvoiceItem` → `schema.prisma:L4605`
- `ItemCategory` → `schema.prisma:L11327`
- `JournalEntry` → `schema.prisma:L15876`
- `JournalLine` → `schema.prisma:L15904`
- `KdsOrder` → `schema.prisma:L14360`
- `KdsOrderItem` → `schema.prisma:L14401`
- `KioskCheckInAttempt` → `schema.prisma:L16825`
- `KioskCheckInChallenge` → `schema.prisma:L16779`
- `KioskOutreachOutbox` → `schema.prisma:L16846`
- `LearnedPatterns` → `schema.prisma:L9245`
- `LedgerAccount` → `schema.prisma:L15768`
- `LiveDemoSession` → `schema.prisma:L785`
- `LowStockAlert` → `schema.prisma:L2695`
- `LoyaltyConfig` → `schema.prisma:L6960`
- `LoyaltyTransaction` → `schema.prisma:L7003`
- `MarketingCampaign` → `schema.prisma:L12510`
- `McpAuthCode` → `schema.prisma:L15401`
- `McpOAuthClient` → `schema.prisma:L15385`
- `McpRefreshToken` → `schema.prisma:L15419`
- `McpToolCall` → `schema.prisma:L15440`
- `MeasurementUnit` → `schema.prisma:L14200`
- `Menu` → `schema.prisma:L1624`
- `MenuCategory` → `schema.prisma:L1561`
- `MenuCategoryAssignment` → `schema.prisma:L1659`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15315`
- `MerchantAccount` → `schema.prisma:L5196`
- `MerchantFiscalConfig` → `schema.prisma:L15566`
- `MerchantRevenueShare` → `schema.prisma:L6207`
- `MerchantRoutingRule` → `schema.prisma:L5318`
- `MilestoneAchievement` → `schema.prisma:L11934`
- `Modifier` → `schema.prisma:L3962`
- `ModifierGroup` → `schema.prisma:L3926`
- `Module` → `schema.prisma:L10236`
- `MoneyAnomaly` → `schema.prisma:L6110`
- `MonthlyVenueProfit` → `schema.prisma:L6653`
- `Notification` → `schema.prisma:L8052`
- `NotificationPreference` → `schema.prisma:L8099`
- `NotificationTemplate` → `schema.prisma:L8126`
- `OAuthState` → `schema.prisma:L1489`
- `OnboardingProgress` → `schema.prisma:L1507`
- `Order` → `schema.prisma:L3533`
- `OrderAction` → `schema.prisma:L4029`
- `OrderCustomer` → `schema.prisma:L3757`
- `OrderDiscount` → `schema.prisma:L7913`
- `OrderFulfillment` → `schema.prisma:L14633`
- `OrderFulfillmentLine` → `schema.prisma:L14664`
- `OrderItem` → `schema.prisma:L3793`
- `OrderItemModifier` → `schema.prisma:L4011`
- `OrderPromotion` → `schema.prisma:L16742`
- `OrderServiceCharge` → `schema.prisma:L7997`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12311`
- `OrganizationEntitlement` → `schema.prisma:L10519`
- `OrganizationGoal` → `schema.prisma:L12269`
- `OrganizationModule` → `schema.prisma:L10296`
- `OrganizationPaymentConfig` → `schema.prisma:L5770`
- `OrganizationPayoutConfig` → `schema.prisma:L12344`
- `OrganizationPricingStructure` → `schema.prisma:L5802`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12292`
- `OtpChallenge` → `schema.prisma:L6910`
- `OvertimeApproval` → `schema.prisma:L3311`
- `PartnerAPIKey` → `schema.prisma:L5600`
- `Payment` → `schema.prisma:L4062`
- `PaymentAllocation` → `schema.prisma:L4328`
- `PaymentLink` → `schema.prisma:L13886`
- `PaymentLinkAttribution` → `schema.prisma:L13994`
- `PaymentLinkItem` → `schema.prisma:L13949`
- `PaymentLinkItemModifier` → `schema.prisma:L13976`
- `PaymentProvider` → `schema.prisma:L5155`
- `PayrollLine` → `schema.prisma:L16250`
- `PayrollRun` → `schema.prisma:L16219`
- `PerformanceGoal` → `schema.prisma:L12246`
- `PermissionOverride` → `schema.prisma:L1362`
- `PermissionSet` → `schema.prisma:L1385`
- `PlatformAnnouncement` → `schema.prisma:L16906`
- `PlatformAnnouncementClick` → `schema.prisma:L16971`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17008`
- `PlatformCfdi` → `schema.prisma:L16535`
- `PlatformEmisor` → `schema.prisma:L16475`
- `PlatformSettings` → `schema.prisma:L5577`
- `PosCommand` → `schema.prisma:L8180`
- `PosConnectionStatus` → `schema.prisma:L911`
- `PosSyncIntent` → `schema.prisma:L16613`
- `PricingPolicy` → `schema.prisma:L2599`
- `Printer` → `schema.prisma:L14443`
- `PrintGateway` → `schema.prisma:L14500`
- `PrintJob` → `schema.prisma:L15214`
- `PrintStation` → `schema.prisma:L14518`
- `ProcessedStripeEvent` → `schema.prisma:L6096`
- `ProcessorReliabilityMetric` → `schema.prisma:L6581`
- `Product` → `schema.prisma:L1677`
- `ProductModifierGroup` → `schema.prisma:L3999`
- `ProductOption` → `schema.prisma:L14177`
- `ProductOptionValue` → `schema.prisma:L14188`
- `ProductStaff` → `schema.prisma:L13121`
- `PromoterBankAccount` → `schema.prisma:L16370`
- `PromoterCommissionEntry` → `schema.prisma:L16389`
- `PromoterLocationPing` → `schema.prisma:L3499`
- `Promotion` → `schema.prisma:L16664`
- `PromotionGroup` → `schema.prisma:L16703`
- `PromotionOption` → `schema.prisma:L16719`
- `ProviderCostStructure` → `schema.prisma:L6132`
- `ProviderEventLog` → `schema.prisma:L5879`
- `PurchaseOrder` → `schema.prisma:L2324`
- `PurchaseOrderInvoice` → `schema.prisma:L2469`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2526`
- `PurchaseOrderItem` → `schema.prisma:L2382`
- `RateCorrectionBatch` → `schema.prisma:L6357`
- `RateCorrectionEntry` → `schema.prisma:L6399`
- `RawMaterial` → `schema.prisma:L2081`
- `RawMaterialMovement` → `schema.prisma:L2652`
- `RawMaterialPresentation` → `schema.prisma:L2156`
- `Recipe` → `schema.prisma:L2176`
- `RecipeLine` → `schema.prisma:L2200`
- `Referral` → `schema.prisma:L7368`
- `ReferralProgramConfig` → `schema.prisma:L7333`
- `ReferralRewardGrant` → `schema.prisma:L7459`
- `ReferralTierReward` → `schema.prisma:L7431`
- `ReferralTierUnlock` → `schema.prisma:L7504`
- `RefreshGrant` → `schema.prisma:L17095`
- `Reservation` → `schema.prisma:L12889`
- `ReservationGoogleEventMapping` → `schema.prisma:L13659`
- `ReservationModifier` → `schema.prisma:L13069`
- `ReservationReminderSent` → `schema.prisma:L13052`
- `ReservationSettings` → `schema.prisma:L13283`
- `ReservationWaitlistEntry` → `schema.prisma:L13251`
- `Review` → `schema.prisma:L4623`
- `SalesRetention` → `schema.prisma:L16070`
- `SaleVerification` → `schema.prisma:L4382`
- `ScaleProfile` → `schema.prisma:L14955`
- `ScheduledCommand` → `schema.prisma:L9720`
- `SerializedItem` → `schema.prisma:L11370`
- `SerializedItemCustodyEvent` → `schema.prisma:L11537`
- `ServiceCharge` → `schema.prisma:L7968`
- `Session` → `schema.prisma:L17074`
- `SettlementConfiguration` → `schema.prisma:L6432`
- `SettlementConfirmation` → `schema.prisma:L6545`
- `SettlementIncident` → `schema.prisma:L6496`
- `SettlementSimulation` → `schema.prisma:L6467`
- `Shift` → `schema.prisma:L3140`
- `SimRegistrationRequest` → `schema.prisma:L11575`
- `SimRegistrationRequestItem` → `schema.prisma:L11597`
- `SlotHold` → `schema.prisma:L13152`
- `Staff` → `schema.prisma:L931`
- `StaffDocument` → `schema.prisma:L3370`
- `StaffOnboardingState` → `schema.prisma:L15285`
- `StaffOrganization` → `schema.prisma:L1261`
- `StaffPasskey` → `schema.prisma:L1288`
- `StaffSchedule` → `schema.prisma:L13092`
- `StaffScheduleException` → `schema.prisma:L13104`
- `StaffVenue` → `schema.prisma:L1185`
- `StaffWorkSchedule` → `schema.prisma:L3247`
- `StaffWorkScheduleException` → `schema.prisma:L3345`
- `StampCard` → `schema.prisma:L7216`
- `StampEvent` → `schema.prisma:L7255`
- `StampReward` → `schema.prisma:L7293`
- `StockAlertConfig` → `schema.prisma:L12228`
- `StockBatch` → `schema.prisma:L2803`
- `StockCount` → `schema.prisma:L2727`
- `StockCountItem` → `schema.prisma:L2751`
- `StripeWebhookEvent` → `schema.prisma:L6079`
- `Supplier` → `schema.prisma:L2235`
- `SupplierItemCode` → `schema.prisma:L2567`
- `SupplierPricing` → `schema.prisma:L2290`
- `Table` → `schema.prisma:L3052`
- `Terminal` → `schema.prisma:L4674`
- `TerminalHealth` → `schema.prisma:L4925`
- `TerminalLog` → `schema.prisma:L4899`
- `TerminalOrder` → `schema.prisma:L5058`
- `TerminalOrderItem` → `schema.prisma:L5133`
- `TerminalPaymentRequest` → `schema.prisma:L4996`
- `TimeEntry` → `schema.prisma:L3412`
- `TimeEntryBreak` → `schema.prisma:L3481`
- `TokenPurchase` → `schema.prisma:L9394`
- `TokenUsageRecord` → `schema.prisma:L9366`
- `TpvCommandHistory` → `schema.prisma:L9626`
- `TpvCommandQueue` → `schema.prisma:L9566`
- `TpvFeedback` → `schema.prisma:L9279`
- `TpvMessage` → `schema.prisma:L12585`
- `TpvMessageDelivery` → `schema.prisma:L12637`
- `TpvMessageResponse` → `schema.prisma:L12660`
- `TrainingModule` → `schema.prisma:L12715`
- `TrainingProgress` → `schema.prisma:L12792`
- `TrainingQuizQuestion` → `schema.prisma:L12774`
- `TrainingStep` → `schema.prisma:L12754`
- `TransactionCost` → `schema.prisma:L6295`
- `UnitConversion` → `schema.prisma:L2630`
- `UpsellAcceptance` → `schema.prisma:L7789`
- `UpsellAiRun` → `schema.prisma:L7809`
- `UpsellImpression` → `schema.prisma:L7749`
- `UpsellRule` → `schema.prisma:L7669`
- `user_sessions` → `schema.prisma:L5635`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14692`
- `VenueChatMessage` → `schema.prisma:L761`
- `VenueChatSession` → `schema.prisma:L716`
- `VenueCommission` → `schema.prisma:L14338`
- `VenueCreditAssessment` → `schema.prisma:L10108`
- `VenueCryptoConfig` → `schema.prisma:L12452`
- `VenueFeature` → `schema.prisma:L4496`
- `VenueModule` → `schema.prisma:L10268`
- `VenuePaymentConfig` → `schema.prisma:L5736`
- `VenuePaymentLinkSettings` → `schema.prisma:L13692`
- `VenuePricingStructure` → `schema.prisma:L6235`
- `VenueRoleConfig` → `schema.prisma:L1414`
- `VenueRolePermission` → `schema.prisma:L1318`
- `VenueScaleSettings` → `schema.prisma:L14943`
- `VenueSettings` → `schema.prisma:L801`
- `VenueTenderType` → `schema.prisma:L4241`
- `VenueTenderTypeRevision` → `schema.prisma:L4306`
- `VenueTransaction` → `schema.prisma:L4433`
- `VenueWhatsappActivation` → `schema.prisma:L652`
- `WalletCardDesign` → `schema.prisma:L7134`
- `WalletPass` → `schema.prisma:L7043`
- `WalletPassRegistration` → `schema.prisma:L7101`
- `WebhookEvent` → `schema.prisma:L4532`
- `WebhookSubscription` → `schema.prisma:L5852`
- `WhatsappContactWindow` → `schema.prisma:L670`
- `WhatsappInboundEvent` → `schema.prisma:L690`
- `WorkShiftAssignment` → `schema.prisma:L3287`
- `WorkShiftTemplate` → `schema.prisma:L3264`
- `Zone` → `schema.prisma:L142`
