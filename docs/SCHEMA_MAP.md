# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **351 models / 338 enums / ~16,800 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                                                                                   |
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
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                            |
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

- `AccountingPeriodLock` → `schema.prisma:L15754`
- `AccountMapping` → `schema.prisma:L15650`
- `ActivityLog` → `schema.prisma:L6547`
- `Aggregator` → `schema.prisma:L14051`
- `AngelPayUserAccount` → `schema.prisma:L5210`
- `AppUpdate` → `schema.prisma:L12231`
- `Area` → `schema.prisma:L2998`
- `AreaTicket` → `schema.prisma:L14545`
- `AreaTicketCheckoutSession` → `schema.prisma:L14667`
- `AreaTicketExternalIncident` → `schema.prisma:L14914`
- `AreaTicketExternalSettlement` → `schema.prisma:L14879`
- `AreaTicketFulfillment` → `schema.prisma:L14743`
- `AreaTicketInventoryReservation` → `schema.prisma:L14638`
- `AreaTicketLine` → `schema.prisma:L14606`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14699`
- `AreaTicketPrintAttempt` → `schema.prisma:L14722`
- `BankStatement` → `schema.prisma:L15524`
- `BankStatementLine` → `schema.prisma:L15545`
- `BillingTaxProfile` → `schema.prisma:L16334`
- `BulkCommandOperation` → `schema.prisma:L9514`
- `CalendarSyncOutbox` → `schema.prisma:L13438`
- `CampaignDelivery` → `schema.prisma:L12389`
- `CashCloseout` → `schema.prisma:L9899`
- `CashDeposit` → `schema.prisma:L12033`
- `CashDrawerEvent` → `schema.prisma:L13888`
- `CashDrawerSession` → `schema.prisma:L13864`
- `CashOutCommissionRate` → `schema.prisma:L16163`
- `CashOutScheduleDay` → `schema.prisma:L16186`
- `CashOutWithdrawal` → `schema.prisma:L16248`
- `CatalogBindingBatch` → `schema.prisma:L10930`
- `CatalogBindingLine` → `schema.prisma:L10966`
- `CatalogBrand` → `schema.prisma:L10383`
- `CatalogClientObservation` → `schema.prisma:L10696`
- `CatalogClientReadinessOverride` → `schema.prisma:L10715`
- `CatalogFamily` → `schema.prisma:L10433`
- `CatalogIdempotencyRecord` → `schema.prisma:L10829`
- `CatalogIdentifier` → `schema.prisma:L10564`
- `CatalogImportBatch` → `schema.prisma:L10872`
- `CatalogImportLine` → `schema.prisma:L10909`
- `CatalogItem` → `schema.prisma:L10466`
- `CatalogItemBusinessType` → `schema.prisma:L10526`
- `CatalogItemPrice` → `schema.prisma:L10614`
- `CatalogManufacturer` → `schema.prisma:L10407`
- `CatalogProductTypeMapping` → `schema.prisma:L10543`
- `CatalogPublicationBatch` → `schema.prisma:L10994`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11088`
- `CatalogPublicationLine` → `schema.prisma:L11035`
- `CatalogPublicationOutbox` → `schema.prisma:L11131`
- `CatalogValidationProfile` → `schema.prisma:L10585`
- `CatalogVenueBinding` → `schema.prisma:L10743`
- `CatalogVenueClientRequirement` → `schema.prisma:L10670`
- `CatalogVenueEventSequence` → `schema.prisma:L11114`
- `CatalogVenueOverride` → `schema.prisma:L10785`
- `CatalogVenueRollout` → `schema.prisma:L10645`
- `Cfdi` → `schema.prisma:L15427`
- `ChatbotTokenBudget` → `schema.prisma:L9162`
- `ChatConversation` → `schema.prisma:L9017`
- `ChatFeedback` → `schema.prisma:L9103`
- `ChatLearningEvent` → `schema.prisma:L9060`
- `ChatMessage` → `schema.prisma:L9040`
- `ChatTrainingData` → `schema.prisma:L8974`
- `CheckoutSession` → `schema.prisma:L5490`
- `ClassSession` → `schema.prisma:L13042`
- `CommissionCalculation` → `schema.prisma:L11809`
- `CommissionClawback` → `schema.prisma:L11985`
- `CommissionConfig` → `schema.prisma:L11575`
- `CommissionMilestone` → `schema.prisma:L11725`
- `CommissionOverride` → `schema.prisma:L11652`
- `CommissionPayout` → `schema.prisma:L11936`
- `CommissionSummary` → `schema.prisma:L11875`
- `CommissionTier` → `schema.prisma:L11689`
- `Consumer` → `schema.prisma:L6709`
- `ConsumerAuthAccount` → `schema.prisma:L6734`
- `CouponCode` → `schema.prisma:L7672`
- `CouponRedemption` → `schema.prisma:L7703`
- `CreditAssessmentHistory` → `schema.prisma:L10008`
- `CreditItemBalance` → `schema.prisma:L13654`
- `CreditOffer` → `schema.prisma:L10027`
- `CreditPack` → `schema.prisma:L13563`
- `CreditPackItem` → `schema.prisma:L13592`
- `CreditPackPurchase` → `schema.prisma:L13609`
- `CreditTransaction` → `schema.prisma:L13676`
- `Customer` → `schema.prisma:L6588`
- `CustomerApprovalDelivery` → `schema.prisma:L8679`
- `CustomerApprovalOutbox` → `schema.prisma:L8654`
- `CustomerDiscount` → `schema.prisma:L7723`
- `CustomerGroup` → `schema.prisma:L6773`
- `CustomerTaxProfile` → `schema.prisma:L15496`
- `DeliveryActivationRequest` → `schema.prisma:L5831`
- `DeliveryChannelLink` → `schema.prisma:L5776`
- `DeliveryOrderEvent` → `schema.prisma:L5855`
- `DeviceToken` → `schema.prisma:L7992`
- `DigitalReceipt` → `schema.prisma:L4205`
- `Discount` → `schema.prisma:L7362`
- `EcommerceMerchant` → `schema.prisma:L5302`
- `EmailTemplate` → `schema.prisma:L12328`
- `Employee` → `schema.prisma:L16011`
- `Estimate` → `schema.prisma:L13958`
- `EstimateItem` → `schema.prisma:L13986`
- `Expense` → `schema.prisma:L15798`
- `ExternalBusyBlock` → `schema.prisma:L13331`
- `Feature` → `schema.prisma:L4334`
- `FeeSchedule` → `schema.prisma:L4412`
- `FeeTier` → `schema.prisma:L4423`
- `FinancialAccount` → `schema.prisma:L14148`
- `FinancialConnection` → `schema.prisma:L14117`
- `FinancialProvider` → `schema.prisma:L14103`
- `FiscalEmisor` → `schema.prisma:L15350`
- `FiscalLossCarryforward` → `schema.prisma:L15921`
- `FixedAsset` → `schema.prisma:L15939`
- `FixedAssetDepreciation` → `schema.prisma:L15968`
- `FloorElement` → `schema.prisma:L3074`
- `FulfillmentArea` → `schema.prisma:L14410`
- `GeofenceRule` → `schema.prisma:L9599`
- `GoogleCalendarChannel` → `schema.prisma:L13308`
- `GoogleCalendarConnection` → `schema.prisma:L13260`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13361`
- `GoogleOAuthSession` → `schema.prisma:L13383`
- `HolidayCalendar` → `schema.prisma:L6471`
- `IdempotencyRequest` → `schema.prisma:L11450`
- `InterVenueTransfer` → `schema.prisma:L2826`
- `InterVenueTransferAllocation` → `schema.prisma:L2909`
- `InterVenueTransferItem` → `schema.prisma:L2878`
- `InterVenueTransferReceipt` → `schema.prisma:L2936`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2952`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2980`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2964`
- `Inventory` → `schema.prisma:L1872`
- `InventoryMovement` → `schema.prisma:L1899`
- `InventoryPosting` → `schema.prisma:L1981`
- `InventoryPostingLine` → `schema.prisma:L2021`
- `InventoryTransfer` → `schema.prisma:L13930`
- `Invitation` → `schema.prisma:L1410`
- `Invoice` → `schema.prisma:L4435`
- `InvoiceItem` → `schema.prisma:L4461`
- `ItemCategory` → `schema.prisma:L11166`
- `JournalEntry` → `schema.prisma:L15708`
- `JournalLine` → `schema.prisma:L15736`
- `KdsOrder` → `schema.prisma:L14196`
- `KdsOrderItem` → `schema.prisma:L14237`
- `KioskCheckInAttempt` → `schema.prisma:L16657`
- `KioskCheckInChallenge` → `schema.prisma:L16611`
- `KioskOutreachOutbox` → `schema.prisma:L16678`
- `LearnedPatterns` → `schema.prisma:L9084`
- `LedgerAccount` → `schema.prisma:L15600`
- `LiveDemoSession` → `schema.prisma:L784`
- `LowStockAlert` → `schema.prisma:L2667`
- `LoyaltyConfig` → `schema.prisma:L6803`
- `LoyaltyTransaction` → `schema.prisma:L6846`
- `MarketingCampaign` → `schema.prisma:L12346`
- `McpAuthCode` → `schema.prisma:L15233`
- `McpOAuthClient` → `schema.prisma:L15217`
- `McpRefreshToken` → `schema.prisma:L15251`
- `McpToolCall` → `schema.prisma:L15272`
- `MeasurementUnit` → `schema.prisma:L14036`
- `Menu` → `schema.prisma:L1596`
- `MenuCategory` → `schema.prisma:L1533`
- `MenuCategoryAssignment` → `schema.prisma:L1631`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15147`
- `MerchantAccount` → `schema.prisma:L5040`
- `MerchantFiscalConfig` → `schema.prisma:L15398`
- `MerchantRevenueShare` → `schema.prisma:L6051`
- `MerchantRoutingRule` → `schema.prisma:L5162`
- `MilestoneAchievement` → `schema.prisma:L11770`
- `Modifier` → `schema.prisma:L3820`
- `ModifierGroup` → `schema.prisma:L3784`
- `Module` → `schema.prisma:L10075`
- `MoneyAnomaly` → `schema.prisma:L5954`
- `MonthlyVenueProfit` → `schema.prisma:L6497`
- `Notification` → `schema.prisma:L7894`
- `NotificationPreference` → `schema.prisma:L7941`
- `NotificationTemplate` → `schema.prisma:L7968`
- `OAuthState` → `schema.prisma:L1461`
- `OnboardingProgress` → `schema.prisma:L1479`
- `Order` → `schema.prisma:L3422`
- `OrderAction` → `schema.prisma:L3885`
- `OrderCustomer` → `schema.prisma:L3635`
- `OrderDiscount` → `schema.prisma:L7755`
- `OrderFulfillment` → `schema.prisma:L14465`
- `OrderFulfillmentLine` → `schema.prisma:L14496`
- `OrderItem` → `schema.prisma:L3651`
- `OrderItemModifier` → `schema.prisma:L3869`
- `OrderPromotion` → `schema.prisma:L16574`
- `OrderServiceCharge` → `schema.prisma:L7839`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12147`
- `OrganizationEntitlement` → `schema.prisma:L10358`
- `OrganizationGoal` → `schema.prisma:L12105`
- `OrganizationModule` → `schema.prisma:L10135`
- `OrganizationPaymentConfig` → `schema.prisma:L5614`
- `OrganizationPayoutConfig` → `schema.prisma:L12180`
- `OrganizationPricingStructure` → `schema.prisma:L5646`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12128`
- `OtpChallenge` → `schema.prisma:L6753`
- `PartnerAPIKey` → `schema.prisma:L5444`
- `Payment` → `schema.prisma:L3918`
- `PaymentAllocation` → `schema.prisma:L4184`
- `PaymentLink` → `schema.prisma:L13722`
- `PaymentLinkAttribution` → `schema.prisma:L13830`
- `PaymentLinkItem` → `schema.prisma:L13785`
- `PaymentLinkItemModifier` → `schema.prisma:L13812`
- `PaymentProvider` → `schema.prisma:L4999`
- `PayrollLine` → `schema.prisma:L16082`
- `PayrollRun` → `schema.prisma:L16051`
- `PerformanceGoal` → `schema.prisma:L12082`
- `PermissionOverride` → `schema.prisma:L1338`
- `PermissionSet` → `schema.prisma:L1361`
- `PlatformAnnouncement` → `schema.prisma:L16738`
- `PlatformAnnouncementClick` → `schema.prisma:L16794`
- `PlatformAnnouncementDelivery` → `schema.prisma:L16825`
- `PlatformCfdi` → `schema.prisma:L16367`
- `PlatformEmisor` → `schema.prisma:L16307`
- `PlatformSettings` → `schema.prisma:L5421`
- `PosCommand` → `schema.prisma:L8022`
- `PosConnectionStatus` → `schema.prisma:L899`
- `PosSyncIntent` → `schema.prisma:L16445`
- `PricingPolicy` → `schema.prisma:L2571`
- `Printer` → `schema.prisma:L14279`
- `PrintGateway` → `schema.prisma:L14332`
- `PrintJob` → `schema.prisma:L15046`
- `PrintStation` → `schema.prisma:L14350`
- `ProcessedStripeEvent` → `schema.prisma:L5940`
- `ProcessorReliabilityMetric` → `schema.prisma:L6425`
- `Product` → `schema.prisma:L1649`
- `ProductModifierGroup` → `schema.prisma:L3857`
- `ProductOption` → `schema.prisma:L14013`
- `ProductOptionValue` → `schema.prisma:L14024`
- `ProductStaff` → `schema.prisma:L12957`
- `PromoterBankAccount` → `schema.prisma:L16202`
- `PromoterCommissionEntry` → `schema.prisma:L16221`
- `PromoterLocationPing` → `schema.prisma:L3388`
- `Promotion` → `schema.prisma:L16496`
- `PromotionGroup` → `schema.prisma:L16535`
- `PromotionOption` → `schema.prisma:L16551`
- `ProviderCostStructure` → `schema.prisma:L5976`
- `ProviderEventLog` → `schema.prisma:L5723`
- `PurchaseOrder` → `schema.prisma:L2296`
- `PurchaseOrderInvoice` → `schema.prisma:L2441`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2498`
- `PurchaseOrderItem` → `schema.prisma:L2354`
- `RateCorrectionBatch` → `schema.prisma:L6201`
- `RateCorrectionEntry` → `schema.prisma:L6243`
- `RawMaterial` → `schema.prisma:L2053`
- `RawMaterialMovement` → `schema.prisma:L2624`
- `RawMaterialPresentation` → `schema.prisma:L2128`
- `Recipe` → `schema.prisma:L2148`
- `RecipeLine` → `schema.prisma:L2172`
- `Referral` → `schema.prisma:L7210`
- `ReferralProgramConfig` → `schema.prisma:L7175`
- `ReferralRewardGrant` → `schema.prisma:L7301`
- `ReferralTierReward` → `schema.prisma:L7273`
- `ReferralTierUnlock` → `schema.prisma:L7346`
- `Reservation` → `schema.prisma:L12725`
- `ReservationGoogleEventMapping` → `schema.prisma:L13495`
- `ReservationModifier` → `schema.prisma:L12905`
- `ReservationReminderSent` → `schema.prisma:L12888`
- `ReservationSettings` → `schema.prisma:L13119`
- `ReservationWaitlistEntry` → `schema.prisma:L13087`
- `Review` → `schema.prisma:L4479`
- `SalesRetention` → `schema.prisma:L15902`
- `SaleVerification` → `schema.prisma:L4238`
- `ScaleProfile` → `schema.prisma:L14787`
- `ScheduledCommand` → `schema.prisma:L9559`
- `SerializedItem` → `schema.prisma:L11209`
- `SerializedItemCustodyEvent` → `schema.prisma:L11373`
- `ServiceCharge` → `schema.prisma:L7810`
- `SettlementConfiguration` → `schema.prisma:L6276`
- `SettlementConfirmation` → `schema.prisma:L6389`
- `SettlementIncident` → `schema.prisma:L6340`
- `SettlementSimulation` → `schema.prisma:L6311`
- `Shift` → `schema.prisma:L3112`
- `SimRegistrationRequest` → `schema.prisma:L11411`
- `SimRegistrationRequestItem` → `schema.prisma:L11433`
- `SlotHold` → `schema.prisma:L12988`
- `Staff` → `schema.prisma:L919`
- `StaffDocument` → `schema.prisma:L3259`
- `StaffOnboardingState` → `schema.prisma:L15117`
- `StaffOrganization` → `schema.prisma:L1237`
- `StaffPasskey` → `schema.prisma:L1264`
- `StaffSchedule` → `schema.prisma:L12928`
- `StaffScheduleException` → `schema.prisma:L12940`
- `StaffVenue` → `schema.prisma:L1163`
- `StaffWorkSchedule` → `schema.prisma:L3219`
- `StaffWorkScheduleException` → `schema.prisma:L3234`
- `StampCard` → `schema.prisma:L7058`
- `StampEvent` → `schema.prisma:L7097`
- `StampReward` → `schema.prisma:L7135`
- `StockAlertConfig` → `schema.prisma:L12064`
- `StockBatch` → `schema.prisma:L2775`
- `StockCount` → `schema.prisma:L2699`
- `StockCountItem` → `schema.prisma:L2723`
- `StripeWebhookEvent` → `schema.prisma:L5923`
- `Supplier` → `schema.prisma:L2207`
- `SupplierItemCode` → `schema.prisma:L2539`
- `SupplierPricing` → `schema.prisma:L2262`
- `Table` → `schema.prisma:L3024`
- `Terminal` → `schema.prisma:L4530`
- `TerminalHealth` → `schema.prisma:L4769`
- `TerminalLog` → `schema.prisma:L4743`
- `TerminalOrder` → `schema.prisma:L4902`
- `TerminalOrderItem` → `schema.prisma:L4977`
- `TerminalPaymentRequest` → `schema.prisma:L4840`
- `TimeEntry` → `schema.prisma:L3301`
- `TimeEntryBreak` → `schema.prisma:L3370`
- `TokenPurchase` → `schema.prisma:L9233`
- `TokenUsageRecord` → `schema.prisma:L9205`
- `TpvCommandHistory` → `schema.prisma:L9465`
- `TpvCommandQueue` → `schema.prisma:L9405`
- `TpvFeedback` → `schema.prisma:L9118`
- `TpvMessage` → `schema.prisma:L12421`
- `TpvMessageDelivery` → `schema.prisma:L12473`
- `TpvMessageResponse` → `schema.prisma:L12496`
- `TrainingModule` → `schema.prisma:L12551`
- `TrainingProgress` → `schema.prisma:L12628`
- `TrainingQuizQuestion` → `schema.prisma:L12610`
- `TrainingStep` → `schema.prisma:L12590`
- `TransactionCost` → `schema.prisma:L6139`
- `UnitConversion` → `schema.prisma:L2602`
- `UpsellAcceptance` → `schema.prisma:L7631`
- `UpsellAiRun` → `schema.prisma:L7651`
- `UpsellImpression` → `schema.prisma:L7591`
- `UpsellRule` → `schema.prisma:L7511`
- `user_sessions` → `schema.prisma:L5479`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14524`
- `VenueChatMessage` → `schema.prisma:L760`
- `VenueChatSession` → `schema.prisma:L715`
- `VenueCommission` → `schema.prisma:L14174`
- `VenueCreditAssessment` → `schema.prisma:L9947`
- `VenueCryptoConfig` → `schema.prisma:L12288`
- `VenueFeature` → `schema.prisma:L4352`
- `VenueModule` → `schema.prisma:L10107`
- `VenuePaymentConfig` → `schema.prisma:L5580`
- `VenuePaymentLinkSettings` → `schema.prisma:L13528`
- `VenuePricingStructure` → `schema.prisma:L6079`
- `VenueRoleConfig` → `schema.prisma:L1390`
- `VenueRolePermission` → `schema.prisma:L1294`
- `VenueScaleSettings` → `schema.prisma:L14775`
- `VenueSettings` → `schema.prisma:L800`
- `VenueTenderType` → `schema.prisma:L4097`
- `VenueTenderTypeRevision` → `schema.prisma:L4162`
- `VenueTransaction` → `schema.prisma:L4289`
- `VenueWhatsappActivation` → `schema.prisma:L651`
- `WalletCardDesign` → `schema.prisma:L6977`
- `WalletPass` → `schema.prisma:L6886`
- `WalletPassRegistration` → `schema.prisma:L6944`
- `WebhookEvent` → `schema.prisma:L4388`
- `WebhookSubscription` → `schema.prisma:L5696`
- `WhatsappContactWindow` → `schema.prisma:L669`
- `WhatsappInboundEvent` → `schema.prisma:L689`
- `Zone` → `schema.prisma:L142`
