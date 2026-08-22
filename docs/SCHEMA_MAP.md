# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **333 models / 326 enums / ~15,800 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L15045`
- `AccountMapping` → `schema.prisma:L14941`
- `ActivityLog` → `schema.prisma:L6233`
- `Aggregator` → `schema.prisma:L13342`
- `AngelPayUserAccount` → `schema.prisma:L4896`
- `AppUpdate` → `schema.prisma:L11557`
- `Area` → `schema.prisma:L2803`
- `AreaTicket` → `schema.prisma:L13836`
- `AreaTicketCheckoutSession` → `schema.prisma:L13958`
- `AreaTicketExternalIncident` → `schema.prisma:L14205`
- `AreaTicketExternalSettlement` → `schema.prisma:L14170`
- `AreaTicketFulfillment` → `schema.prisma:L14034`
- `AreaTicketInventoryReservation` → `schema.prisma:L13929`
- `AreaTicketLine` → `schema.prisma:L13897`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13990`
- `AreaTicketPrintAttempt` → `schema.prisma:L14013`
- `BankStatement` → `schema.prisma:L14815`
- `BankStatementLine` → `schema.prisma:L14836`
- `BillingTaxProfile` → `schema.prisma:L15625`
- `BulkCommandOperation` → `schema.prisma:L8870`
- `CalendarSyncOutbox` → `schema.prisma:L12736`
- `CampaignDelivery` → `schema.prisma:L11715`
- `CashCloseout` → `schema.prisma:L9235`
- `CashDeposit` → `schema.prisma:L11359`
- `CashDrawerEvent` → `schema.prisma:L13179`
- `CashDrawerSession` → `schema.prisma:L13155`
- `CashOutCommissionRate` → `schema.prisma:L15454`
- `CashOutScheduleDay` → `schema.prisma:L15477`
- `CashOutWithdrawal` → `schema.prisma:L15539`
- `CatalogBindingBatch` → `schema.prisma:L10266`
- `CatalogBindingLine` → `schema.prisma:L10302`
- `CatalogBrand` → `schema.prisma:L9719`
- `CatalogClientObservation` → `schema.prisma:L10032`
- `CatalogClientReadinessOverride` → `schema.prisma:L10051`
- `CatalogFamily` → `schema.prisma:L9769`
- `CatalogIdempotencyRecord` → `schema.prisma:L10165`
- `CatalogIdentifier` → `schema.prisma:L9900`
- `CatalogImportBatch` → `schema.prisma:L10208`
- `CatalogImportLine` → `schema.prisma:L10245`
- `CatalogItem` → `schema.prisma:L9802`
- `CatalogItemBusinessType` → `schema.prisma:L9862`
- `CatalogItemPrice` → `schema.prisma:L9950`
- `CatalogManufacturer` → `schema.prisma:L9743`
- `CatalogProductTypeMapping` → `schema.prisma:L9879`
- `CatalogPublicationBatch` → `schema.prisma:L10330`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10424`
- `CatalogPublicationLine` → `schema.prisma:L10371`
- `CatalogPublicationOutbox` → `schema.prisma:L10467`
- `CatalogValidationProfile` → `schema.prisma:L9921`
- `CatalogVenueBinding` → `schema.prisma:L10079`
- `CatalogVenueClientRequirement` → `schema.prisma:L10006`
- `CatalogVenueEventSequence` → `schema.prisma:L10450`
- `CatalogVenueOverride` → `schema.prisma:L10121`
- `CatalogVenueRollout` → `schema.prisma:L9981`
- `Cfdi` → `schema.prisma:L14718`
- `ChatbotTokenBudget` → `schema.prisma:L8518`
- `ChatConversation` → `schema.prisma:L8373`
- `ChatFeedback` → `schema.prisma:L8459`
- `ChatLearningEvent` → `schema.prisma:L8416`
- `ChatMessage` → `schema.prisma:L8396`
- `ChatTrainingData` → `schema.prisma:L8330`
- `CheckoutSession` → `schema.prisma:L5176`
- `ClassSession` → `schema.prisma:L12349`
- `CommissionCalculation` → `schema.prisma:L11138`
- `CommissionClawback` → `schema.prisma:L11311`
- `CommissionConfig` → `schema.prisma:L10911`
- `CommissionMilestone` → `schema.prisma:L11054`
- `CommissionOverride` → `schema.prisma:L10981`
- `CommissionPayout` → `schema.prisma:L11262`
- `CommissionSummary` → `schema.prisma:L11201`
- `CommissionTier` → `schema.prisma:L11018`
- `Consumer` → `schema.prisma:L6391`
- `ConsumerAuthAccount` → `schema.prisma:L6416`
- `CouponCode` → `schema.prisma:L7037`
- `CouponRedemption` → `schema.prisma:L7068`
- `CreditAssessmentHistory` → `schema.prisma:L9344`
- `CreditItemBalance` → `schema.prisma:L12945`
- `CreditOffer` → `schema.prisma:L9363`
- `CreditPack` → `schema.prisma:L12861`
- `CreditPackItem` → `schema.prisma:L12890`
- `CreditPackPurchase` → `schema.prisma:L12907`
- `CreditTransaction` → `schema.prisma:L12967`
- `Customer` → `schema.prisma:L6274`
- `CustomerApprovalDelivery` → `schema.prisma:L8040`
- `CustomerApprovalOutbox` → `schema.prisma:L8015`
- `CustomerDiscount` → `schema.prisma:L7088`
- `CustomerGroup` → `schema.prisma:L6455`
- `CustomerTaxProfile` → `schema.prisma:L14787`
- `DeliveryActivationRequest` → `schema.prisma:L5517`
- `DeliveryChannelLink` → `schema.prisma:L5462`
- `DeliveryOrderEvent` → `schema.prisma:L5541`
- `DeviceToken` → `schema.prisma:L7357`
- `DigitalReceipt` → `schema.prisma:L3891`
- `Discount` → `schema.prisma:L6727`
- `EcommerceMerchant` → `schema.prisma:L4988`
- `EmailTemplate` → `schema.prisma:L11654`
- `Employee` → `schema.prisma:L15302`
- `Estimate` → `schema.prisma:L13249`
- `EstimateItem` → `schema.prisma:L13277`
- `Expense` → `schema.prisma:L15089`
- `ExternalBusyBlock` → `schema.prisma:L12629`
- `Feature` → `schema.prisma:L4020`
- `FeeSchedule` → `schema.prisma:L4098`
- `FeeTier` → `schema.prisma:L4109`
- `FinancialAccount` → `schema.prisma:L13439`
- `FinancialConnection` → `schema.prisma:L13408`
- `FinancialProvider` → `schema.prisma:L13394`
- `FiscalEmisor` → `schema.prisma:L14641`
- `FiscalLossCarryforward` → `schema.prisma:L15212`
- `FixedAsset` → `schema.prisma:L15230`
- `FixedAssetDepreciation` → `schema.prisma:L15259`
- `FloorElement` → `schema.prisma:L2879`
- `FulfillmentArea` → `schema.prisma:L13701`
- `GeofenceRule` → `schema.prisma:L8955`
- `GoogleCalendarChannel` → `schema.prisma:L12606`
- `GoogleCalendarConnection` → `schema.prisma:L12558`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12659`
- `GoogleOAuthSession` → `schema.prisma:L12681`
- `HolidayCalendar` → `schema.prisma:L6157`
- `IdempotencyRequest` → `schema.prisma:L10786`
- `InterVenueTransfer` → `schema.prisma:L2631`
- `InterVenueTransferAllocation` → `schema.prisma:L2714`
- `InterVenueTransferItem` → `schema.prisma:L2683`
- `InterVenueTransferReceipt` → `schema.prisma:L2741`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2757`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2785`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2769`
- `Inventory` → `schema.prisma:L1824`
- `InventoryMovement` → `schema.prisma:L1851`
- `InventoryPosting` → `schema.prisma:L1933`
- `InventoryPostingLine` → `schema.prisma:L1973`
- `InventoryTransfer` → `schema.prisma:L13221`
- `Invitation` → `schema.prisma:L1372`
- `Invoice` → `schema.prisma:L4121`
- `InvoiceItem` → `schema.prisma:L4147`
- `ItemCategory` → `schema.prisma:L10502`
- `JournalEntry` → `schema.prisma:L14999`
- `JournalLine` → `schema.prisma:L15027`
- `KdsOrder` → `schema.prisma:L13487`
- `KdsOrderItem` → `schema.prisma:L13528`
- `LearnedPatterns` → `schema.prisma:L8440`
- `LedgerAccount` → `schema.prisma:L14891`
- `LiveDemoSession` → `schema.prisma:L773`
- `LowStockAlert` → `schema.prisma:L2472`
- `LoyaltyConfig` → `schema.prisma:L6485`
- `LoyaltyTransaction` → `schema.prisma:L6508`
- `MarketingCampaign` → `schema.prisma:L11672`
- `McpAuthCode` → `schema.prisma:L14524`
- `McpOAuthClient` → `schema.prisma:L14508`
- `McpRefreshToken` → `schema.prisma:L14542`
- `McpToolCall` → `schema.prisma:L14563`
- `MeasurementUnit` → `schema.prisma:L13327`
- `Menu` → `schema.prisma:L1558`
- `MenuCategory` → `schema.prisma:L1495`
- `MenuCategoryAssignment` → `schema.prisma:L1593`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14438`
- `MerchantAccount` → `schema.prisma:L4726`
- `MerchantFiscalConfig` → `schema.prisma:L14689`
- `MerchantRevenueShare` → `schema.prisma:L5737`
- `MerchantRoutingRule` → `schema.prisma:L4848`
- `MilestoneAchievement` → `schema.prisma:L11099`
- `Modifier` → `schema.prisma:L3507`
- `ModifierGroup` → `schema.prisma:L3471`
- `Module` → `schema.prisma:L9411`
- `MoneyAnomaly` → `schema.prisma:L5640`
- `MonthlyVenueProfit` → `schema.prisma:L6183`
- `Notification` → `schema.prisma:L7259`
- `NotificationPreference` → `schema.prisma:L7306`
- `NotificationTemplate` → `schema.prisma:L7333`
- `OAuthState` → `schema.prisma:L1423`
- `OnboardingProgress` → `schema.prisma:L1441`
- `Order` → `schema.prisma:L3110`
- `OrderAction` → `schema.prisma:L3572`
- `OrderCustomer` → `schema.prisma:L3322`
- `OrderDiscount` → `schema.prisma:L7120`
- `OrderFulfillment` → `schema.prisma:L13756`
- `OrderFulfillmentLine` → `schema.prisma:L13787`
- `OrderItem` → `schema.prisma:L3338`
- `OrderItemModifier` → `schema.prisma:L3556`
- `OrderPromotion` → `schema.prisma:L15865`
- `OrderServiceCharge` → `schema.prisma:L7204`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11473`
- `OrganizationEntitlement` → `schema.prisma:L9694`
- `OrganizationGoal` → `schema.prisma:L11431`
- `OrganizationModule` → `schema.prisma:L9471`
- `OrganizationPaymentConfig` → `schema.prisma:L5300`
- `OrganizationPayoutConfig` → `schema.prisma:L11506`
- `OrganizationPricingStructure` → `schema.prisma:L5332`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11454`
- `OtpChallenge` → `schema.prisma:L6435`
- `PartnerAPIKey` → `schema.prisma:L5130`
- `Payment` → `schema.prisma:L3605`
- `PaymentAllocation` → `schema.prisma:L3870`
- `PaymentLink` → `schema.prisma:L13013`
- `PaymentLinkAttribution` → `schema.prisma:L13121`
- `PaymentLinkItem` → `schema.prisma:L13076`
- `PaymentLinkItemModifier` → `schema.prisma:L13103`
- `PaymentProvider` → `schema.prisma:L4685`
- `PayrollLine` → `schema.prisma:L15373`
- `PayrollRun` → `schema.prisma:L15342`
- `PerformanceGoal` → `schema.prisma:L11408`
- `PermissionOverride` → `schema.prisma:L1300`
- `PermissionSet` → `schema.prisma:L1323`
- `PlatformCfdi` → `schema.prisma:L15658`
- `PlatformEmisor` → `schema.prisma:L15598`
- `PlatformSettings` → `schema.prisma:L5107`
- `PosCommand` → `schema.prisma:L7387`
- `PosConnectionStatus` → `schema.prisma:L879`
- `PosSyncIntent` → `schema.prisma:L15736`
- `PricingPolicy` → `schema.prisma:L2376`
- `Printer` → `schema.prisma:L13570`
- `PrintGateway` → `schema.prisma:L13623`
- `PrintJob` → `schema.prisma:L14337`
- `PrintStation` → `schema.prisma:L13641`
- `ProcessedStripeEvent` → `schema.prisma:L5626`
- `ProcessorReliabilityMetric` → `schema.prisma:L6111`
- `Product` → `schema.prisma:L1611`
- `ProductModifierGroup` → `schema.prisma:L3544`
- `ProductOption` → `schema.prisma:L13304`
- `ProductOptionValue` → `schema.prisma:L13315`
- `ProductStaff` → `schema.prisma:L12264`
- `PromoterBankAccount` → `schema.prisma:L15493`
- `PromoterCommissionEntry` → `schema.prisma:L15512`
- `PromoterLocationPing` → `schema.prisma:L3076`
- `Promotion` → `schema.prisma:L15787`
- `PromotionGroup` → `schema.prisma:L15826`
- `PromotionOption` → `schema.prisma:L15842`
- `ProviderCostStructure` → `schema.prisma:L5662`
- `ProviderEventLog` → `schema.prisma:L5409`
- `PurchaseOrder` → `schema.prisma:L2244`
- `PurchaseOrderItem` → `schema.prisma:L2301`
- `RateCorrectionBatch` → `schema.prisma:L5887`
- `RateCorrectionEntry` → `schema.prisma:L5929`
- `RawMaterial` → `schema.prisma:L2005`
- `RawMaterialMovement` → `schema.prisma:L2429`
- `RawMaterialPresentation` → `schema.prisma:L2078`
- `Recipe` → `schema.prisma:L2098`
- `RecipeLine` → `schema.prisma:L2122`
- `Referral` → `schema.prisma:L6575`
- `ReferralProgramConfig` → `schema.prisma:L6540`
- `ReferralRewardGrant` → `schema.prisma:L6666`
- `ReferralTierReward` → `schema.prisma:L6638`
- `ReferralTierUnlock` → `schema.prisma:L6711`
- `Reservation` → `schema.prisma:L12051`
- `ReservationGoogleEventMapping` → `schema.prisma:L12793`
- `ReservationModifier` → `schema.prisma:L12212`
- `ReservationReminderSent` → `schema.prisma:L12195`
- `ReservationSettings` → `schema.prisma:L12426`
- `ReservationWaitlistEntry` → `schema.prisma:L12394`
- `Review` → `schema.prisma:L4165`
- `SalesRetention` → `schema.prisma:L15193`
- `SaleVerification` → `schema.prisma:L3924`
- `ScaleProfile` → `schema.prisma:L14078`
- `ScheduledCommand` → `schema.prisma:L8915`
- `SerializedItem` → `schema.prisma:L10545`
- `SerializedItemCustodyEvent` → `schema.prisma:L10709`
- `ServiceCharge` → `schema.prisma:L7175`
- `SettlementConfiguration` → `schema.prisma:L5962`
- `SettlementConfirmation` → `schema.prisma:L6075`
- `SettlementIncident` → `schema.prisma:L6026`
- `SettlementSimulation` → `schema.prisma:L5997`
- `Shift` → `schema.prisma:L2917`
- `SimRegistrationRequest` → `schema.prisma:L10747`
- `SimRegistrationRequestItem` → `schema.prisma:L10769`
- `SlotHold` → `schema.prisma:L12295`
- `Staff` → `schema.prisma:L899`
- `StaffOnboardingState` → `schema.prisma:L14408`
- `StaffOrganization` → `schema.prisma:L1199`
- `StaffPasskey` → `schema.prisma:L1226`
- `StaffSchedule` → `schema.prisma:L12235`
- `StaffScheduleException` → `schema.prisma:L12247`
- `StaffVenue` → `schema.prisma:L1129`
- `StockAlertConfig` → `schema.prisma:L11390`
- `StockBatch` → `schema.prisma:L2580`
- `StockCount` → `schema.prisma:L2504`
- `StockCountItem` → `schema.prisma:L2528`
- `StripeWebhookEvent` → `schema.prisma:L5609`
- `Supplier` → `schema.prisma:L2157`
- `SupplierPricing` → `schema.prisma:L2210`
- `Table` → `schema.prisma:L2829`
- `Terminal` → `schema.prisma:L4216`
- `TerminalHealth` → `schema.prisma:L4455`
- `TerminalLog` → `schema.prisma:L4429`
- `TerminalOrder` → `schema.prisma:L4588`
- `TerminalOrderItem` → `schema.prisma:L4663`
- `TerminalPaymentRequest` → `schema.prisma:L4526`
- `TimeEntry` → `schema.prisma:L2989`
- `TimeEntryBreak` → `schema.prisma:L3058`
- `TokenPurchase` → `schema.prisma:L8589`
- `TokenUsageRecord` → `schema.prisma:L8561`
- `TpvCommandHistory` → `schema.prisma:L8821`
- `TpvCommandQueue` → `schema.prisma:L8761`
- `TpvFeedback` → `schema.prisma:L8474`
- `TpvMessage` → `schema.prisma:L11747`
- `TpvMessageDelivery` → `schema.prisma:L11799`
- `TpvMessageResponse` → `schema.prisma:L11822`
- `TrainingModule` → `schema.prisma:L11877`
- `TrainingProgress` → `schema.prisma:L11954`
- `TrainingQuizQuestion` → `schema.prisma:L11936`
- `TrainingStep` → `schema.prisma:L11916`
- `TransactionCost` → `schema.prisma:L5825`
- `UnitConversion` → `schema.prisma:L2407`
- `UpsellAcceptance` → `schema.prisma:L6996`
- `UpsellAiRun` → `schema.prisma:L7016`
- `UpsellImpression` → `schema.prisma:L6956`
- `UpsellRule` → `schema.prisma:L6876`
- `user_sessions` → `schema.prisma:L5165`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L13815`
- `VenueChatMessage` → `schema.prisma:L749`
- `VenueChatSession` → `schema.prisma:L704`
- `VenueCommission` → `schema.prisma:L13465`
- `VenueCreditAssessment` → `schema.prisma:L9283`
- `VenueCryptoConfig` → `schema.prisma:L11614`
- `VenueFeature` → `schema.prisma:L4038`
- `VenueModule` → `schema.prisma:L9443`
- `VenuePaymentConfig` → `schema.prisma:L5266`
- `VenuePaymentLinkSettings` → `schema.prisma:L12826`
- `VenuePricingStructure` → `schema.prisma:L5765`
- `VenueRoleConfig` → `schema.prisma:L1352`
- `VenueRolePermission` → `schema.prisma:L1256`
- `VenueScaleSettings` → `schema.prisma:L14066`
- `VenueSettings` → `schema.prisma:L789`
- `VenueTenderType` → `schema.prisma:L3783`
- `VenueTenderTypeRevision` → `schema.prisma:L3848`
- `VenueTransaction` → `schema.prisma:L3975`
- `VenueWhatsappActivation` → `schema.prisma:L640`
- `WebhookEvent` → `schema.prisma:L4074`
- `WebhookSubscription` → `schema.prisma:L5382`
- `WhatsappContactWindow` → `schema.prisma:L658`
- `WhatsappInboundEvent` → `schema.prisma:L678`
- `Zone` → `schema.prisma:L142`
