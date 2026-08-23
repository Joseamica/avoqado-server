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

- `AccountingPeriodLock` → `schema.prisma:L15049`
- `AccountMapping` → `schema.prisma:L14945`
- `ActivityLog` → `schema.prisma:L6233`
- `Aggregator` → `schema.prisma:L13346`
- `AngelPayUserAccount` → `schema.prisma:L4896`
- `AppUpdate` → `schema.prisma:L11561`
- `Area` → `schema.prisma:L2803`
- `AreaTicket` → `schema.prisma:L13840`
- `AreaTicketCheckoutSession` → `schema.prisma:L13962`
- `AreaTicketExternalIncident` → `schema.prisma:L14209`
- `AreaTicketExternalSettlement` → `schema.prisma:L14174`
- `AreaTicketFulfillment` → `schema.prisma:L14038`
- `AreaTicketInventoryReservation` → `schema.prisma:L13933`
- `AreaTicketLine` → `schema.prisma:L13901`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13994`
- `AreaTicketPrintAttempt` → `schema.prisma:L14017`
- `BankStatement` → `schema.prisma:L14819`
- `BankStatementLine` → `schema.prisma:L14840`
- `BillingTaxProfile` → `schema.prisma:L15629`
- `BulkCommandOperation` → `schema.prisma:L8874`
- `CalendarSyncOutbox` → `schema.prisma:L12740`
- `CampaignDelivery` → `schema.prisma:L11719`
- `CashCloseout` → `schema.prisma:L9239`
- `CashDeposit` → `schema.prisma:L11363`
- `CashDrawerEvent` → `schema.prisma:L13183`
- `CashDrawerSession` → `schema.prisma:L13159`
- `CashOutCommissionRate` → `schema.prisma:L15458`
- `CashOutScheduleDay` → `schema.prisma:L15481`
- `CashOutWithdrawal` → `schema.prisma:L15543`
- `CatalogBindingBatch` → `schema.prisma:L10270`
- `CatalogBindingLine` → `schema.prisma:L10306`
- `CatalogBrand` → `schema.prisma:L9723`
- `CatalogClientObservation` → `schema.prisma:L10036`
- `CatalogClientReadinessOverride` → `schema.prisma:L10055`
- `CatalogFamily` → `schema.prisma:L9773`
- `CatalogIdempotencyRecord` → `schema.prisma:L10169`
- `CatalogIdentifier` → `schema.prisma:L9904`
- `CatalogImportBatch` → `schema.prisma:L10212`
- `CatalogImportLine` → `schema.prisma:L10249`
- `CatalogItem` → `schema.prisma:L9806`
- `CatalogItemBusinessType` → `schema.prisma:L9866`
- `CatalogItemPrice` → `schema.prisma:L9954`
- `CatalogManufacturer` → `schema.prisma:L9747`
- `CatalogProductTypeMapping` → `schema.prisma:L9883`
- `CatalogPublicationBatch` → `schema.prisma:L10334`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10428`
- `CatalogPublicationLine` → `schema.prisma:L10375`
- `CatalogPublicationOutbox` → `schema.prisma:L10471`
- `CatalogValidationProfile` → `schema.prisma:L9925`
- `CatalogVenueBinding` → `schema.prisma:L10083`
- `CatalogVenueClientRequirement` → `schema.prisma:L10010`
- `CatalogVenueEventSequence` → `schema.prisma:L10454`
- `CatalogVenueOverride` → `schema.prisma:L10125`
- `CatalogVenueRollout` → `schema.prisma:L9985`
- `Cfdi` → `schema.prisma:L14722`
- `ChatbotTokenBudget` → `schema.prisma:L8522`
- `ChatConversation` → `schema.prisma:L8377`
- `ChatFeedback` → `schema.prisma:L8463`
- `ChatLearningEvent` → `schema.prisma:L8420`
- `ChatMessage` → `schema.prisma:L8400`
- `ChatTrainingData` → `schema.prisma:L8334`
- `CheckoutSession` → `schema.prisma:L5176`
- `ClassSession` → `schema.prisma:L12353`
- `CommissionCalculation` → `schema.prisma:L11142`
- `CommissionClawback` → `schema.prisma:L11315`
- `CommissionConfig` → `schema.prisma:L10915`
- `CommissionMilestone` → `schema.prisma:L11058`
- `CommissionOverride` → `schema.prisma:L10985`
- `CommissionPayout` → `schema.prisma:L11266`
- `CommissionSummary` → `schema.prisma:L11205`
- `CommissionTier` → `schema.prisma:L11022`
- `Consumer` → `schema.prisma:L6391`
- `ConsumerAuthAccount` → `schema.prisma:L6416`
- `CouponCode` → `schema.prisma:L7037`
- `CouponRedemption` → `schema.prisma:L7068`
- `CreditAssessmentHistory` → `schema.prisma:L9348`
- `CreditItemBalance` → `schema.prisma:L12949`
- `CreditOffer` → `schema.prisma:L9367`
- `CreditPack` → `schema.prisma:L12865`
- `CreditPackItem` → `schema.prisma:L12894`
- `CreditPackPurchase` → `schema.prisma:L12911`
- `CreditTransaction` → `schema.prisma:L12971`
- `Customer` → `schema.prisma:L6274`
- `CustomerApprovalDelivery` → `schema.prisma:L8044`
- `CustomerApprovalOutbox` → `schema.prisma:L8019`
- `CustomerDiscount` → `schema.prisma:L7088`
- `CustomerGroup` → `schema.prisma:L6455`
- `CustomerTaxProfile` → `schema.prisma:L14791`
- `DeliveryActivationRequest` → `schema.prisma:L5517`
- `DeliveryChannelLink` → `schema.prisma:L5462`
- `DeliveryOrderEvent` → `schema.prisma:L5541`
- `DeviceToken` → `schema.prisma:L7357`
- `DigitalReceipt` → `schema.prisma:L3891`
- `Discount` → `schema.prisma:L6727`
- `EcommerceMerchant` → `schema.prisma:L4988`
- `EmailTemplate` → `schema.prisma:L11658`
- `Employee` → `schema.prisma:L15306`
- `Estimate` → `schema.prisma:L13253`
- `EstimateItem` → `schema.prisma:L13281`
- `Expense` → `schema.prisma:L15093`
- `ExternalBusyBlock` → `schema.prisma:L12633`
- `Feature` → `schema.prisma:L4020`
- `FeeSchedule` → `schema.prisma:L4098`
- `FeeTier` → `schema.prisma:L4109`
- `FinancialAccount` → `schema.prisma:L13443`
- `FinancialConnection` → `schema.prisma:L13412`
- `FinancialProvider` → `schema.prisma:L13398`
- `FiscalEmisor` → `schema.prisma:L14645`
- `FiscalLossCarryforward` → `schema.prisma:L15216`
- `FixedAsset` → `schema.prisma:L15234`
- `FixedAssetDepreciation` → `schema.prisma:L15263`
- `FloorElement` → `schema.prisma:L2879`
- `FulfillmentArea` → `schema.prisma:L13705`
- `GeofenceRule` → `schema.prisma:L8959`
- `GoogleCalendarChannel` → `schema.prisma:L12610`
- `GoogleCalendarConnection` → `schema.prisma:L12562`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12663`
- `GoogleOAuthSession` → `schema.prisma:L12685`
- `HolidayCalendar` → `schema.prisma:L6157`
- `IdempotencyRequest` → `schema.prisma:L10790`
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
- `InventoryTransfer` → `schema.prisma:L13225`
- `Invitation` → `schema.prisma:L1372`
- `Invoice` → `schema.prisma:L4121`
- `InvoiceItem` → `schema.prisma:L4147`
- `ItemCategory` → `schema.prisma:L10506`
- `JournalEntry` → `schema.prisma:L15003`
- `JournalLine` → `schema.prisma:L15031`
- `KdsOrder` → `schema.prisma:L13491`
- `KdsOrderItem` → `schema.prisma:L13532`
- `LearnedPatterns` → `schema.prisma:L8444`
- `LedgerAccount` → `schema.prisma:L14895`
- `LiveDemoSession` → `schema.prisma:L773`
- `LowStockAlert` → `schema.prisma:L2472`
- `LoyaltyConfig` → `schema.prisma:L6485`
- `LoyaltyTransaction` → `schema.prisma:L6508`
- `MarketingCampaign` → `schema.prisma:L11676`
- `McpAuthCode` → `schema.prisma:L14528`
- `McpOAuthClient` → `schema.prisma:L14512`
- `McpRefreshToken` → `schema.prisma:L14546`
- `McpToolCall` → `schema.prisma:L14567`
- `MeasurementUnit` → `schema.prisma:L13331`
- `Menu` → `schema.prisma:L1558`
- `MenuCategory` → `schema.prisma:L1495`
- `MenuCategoryAssignment` → `schema.prisma:L1593`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14442`
- `MerchantAccount` → `schema.prisma:L4726`
- `MerchantFiscalConfig` → `schema.prisma:L14693`
- `MerchantRevenueShare` → `schema.prisma:L5737`
- `MerchantRoutingRule` → `schema.prisma:L4848`
- `MilestoneAchievement` → `schema.prisma:L11103`
- `Modifier` → `schema.prisma:L3507`
- `ModifierGroup` → `schema.prisma:L3471`
- `Module` → `schema.prisma:L9415`
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
- `OrderFulfillment` → `schema.prisma:L13760`
- `OrderFulfillmentLine` → `schema.prisma:L13791`
- `OrderItem` → `schema.prisma:L3338`
- `OrderItemModifier` → `schema.prisma:L3556`
- `OrderPromotion` → `schema.prisma:L15869`
- `OrderServiceCharge` → `schema.prisma:L7204`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11477`
- `OrganizationEntitlement` → `schema.prisma:L9698`
- `OrganizationGoal` → `schema.prisma:L11435`
- `OrganizationModule` → `schema.prisma:L9475`
- `OrganizationPaymentConfig` → `schema.prisma:L5300`
- `OrganizationPayoutConfig` → `schema.prisma:L11510`
- `OrganizationPricingStructure` → `schema.prisma:L5332`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11458`
- `OtpChallenge` → `schema.prisma:L6435`
- `PartnerAPIKey` → `schema.prisma:L5130`
- `Payment` → `schema.prisma:L3605`
- `PaymentAllocation` → `schema.prisma:L3870`
- `PaymentLink` → `schema.prisma:L13017`
- `PaymentLinkAttribution` → `schema.prisma:L13125`
- `PaymentLinkItem` → `schema.prisma:L13080`
- `PaymentLinkItemModifier` → `schema.prisma:L13107`
- `PaymentProvider` → `schema.prisma:L4685`
- `PayrollLine` → `schema.prisma:L15377`
- `PayrollRun` → `schema.prisma:L15346`
- `PerformanceGoal` → `schema.prisma:L11412`
- `PermissionOverride` → `schema.prisma:L1300`
- `PermissionSet` → `schema.prisma:L1323`
- `PlatformCfdi` → `schema.prisma:L15662`
- `PlatformEmisor` → `schema.prisma:L15602`
- `PlatformSettings` → `schema.prisma:L5107`
- `PosCommand` → `schema.prisma:L7387`
- `PosConnectionStatus` → `schema.prisma:L879`
- `PosSyncIntent` → `schema.prisma:L15740`
- `PricingPolicy` → `schema.prisma:L2376`
- `Printer` → `schema.prisma:L13574`
- `PrintGateway` → `schema.prisma:L13627`
- `PrintJob` → `schema.prisma:L14341`
- `PrintStation` → `schema.prisma:L13645`
- `ProcessedStripeEvent` → `schema.prisma:L5626`
- `ProcessorReliabilityMetric` → `schema.prisma:L6111`
- `Product` → `schema.prisma:L1611`
- `ProductModifierGroup` → `schema.prisma:L3544`
- `ProductOption` → `schema.prisma:L13308`
- `ProductOptionValue` → `schema.prisma:L13319`
- `ProductStaff` → `schema.prisma:L12268`
- `PromoterBankAccount` → `schema.prisma:L15497`
- `PromoterCommissionEntry` → `schema.prisma:L15516`
- `PromoterLocationPing` → `schema.prisma:L3076`
- `Promotion` → `schema.prisma:L15791`
- `PromotionGroup` → `schema.prisma:L15830`
- `PromotionOption` → `schema.prisma:L15846`
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
- `Reservation` → `schema.prisma:L12055`
- `ReservationGoogleEventMapping` → `schema.prisma:L12797`
- `ReservationModifier` → `schema.prisma:L12216`
- `ReservationReminderSent` → `schema.prisma:L12199`
- `ReservationSettings` → `schema.prisma:L12430`
- `ReservationWaitlistEntry` → `schema.prisma:L12398`
- `Review` → `schema.prisma:L4165`
- `SalesRetention` → `schema.prisma:L15197`
- `SaleVerification` → `schema.prisma:L3924`
- `ScaleProfile` → `schema.prisma:L14082`
- `ScheduledCommand` → `schema.prisma:L8919`
- `SerializedItem` → `schema.prisma:L10549`
- `SerializedItemCustodyEvent` → `schema.prisma:L10713`
- `ServiceCharge` → `schema.prisma:L7175`
- `SettlementConfiguration` → `schema.prisma:L5962`
- `SettlementConfirmation` → `schema.prisma:L6075`
- `SettlementIncident` → `schema.prisma:L6026`
- `SettlementSimulation` → `schema.prisma:L5997`
- `Shift` → `schema.prisma:L2917`
- `SimRegistrationRequest` → `schema.prisma:L10751`
- `SimRegistrationRequestItem` → `schema.prisma:L10773`
- `SlotHold` → `schema.prisma:L12299`
- `Staff` → `schema.prisma:L899`
- `StaffOnboardingState` → `schema.prisma:L14412`
- `StaffOrganization` → `schema.prisma:L1199`
- `StaffPasskey` → `schema.prisma:L1226`
- `StaffSchedule` → `schema.prisma:L12239`
- `StaffScheduleException` → `schema.prisma:L12251`
- `StaffVenue` → `schema.prisma:L1129`
- `StockAlertConfig` → `schema.prisma:L11394`
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
- `TokenPurchase` → `schema.prisma:L8593`
- `TokenUsageRecord` → `schema.prisma:L8565`
- `TpvCommandHistory` → `schema.prisma:L8825`
- `TpvCommandQueue` → `schema.prisma:L8765`
- `TpvFeedback` → `schema.prisma:L8478`
- `TpvMessage` → `schema.prisma:L11751`
- `TpvMessageDelivery` → `schema.prisma:L11803`
- `TpvMessageResponse` → `schema.prisma:L11826`
- `TrainingModule` → `schema.prisma:L11881`
- `TrainingProgress` → `schema.prisma:L11958`
- `TrainingQuizQuestion` → `schema.prisma:L11940`
- `TrainingStep` → `schema.prisma:L11920`
- `TransactionCost` → `schema.prisma:L5825`
- `UnitConversion` → `schema.prisma:L2407`
- `UpsellAcceptance` → `schema.prisma:L6996`
- `UpsellAiRun` → `schema.prisma:L7016`
- `UpsellImpression` → `schema.prisma:L6956`
- `UpsellRule` → `schema.prisma:L6876`
- `user_sessions` → `schema.prisma:L5165`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L13819`
- `VenueChatMessage` → `schema.prisma:L749`
- `VenueChatSession` → `schema.prisma:L704`
- `VenueCommission` → `schema.prisma:L13469`
- `VenueCreditAssessment` → `schema.prisma:L9287`
- `VenueCryptoConfig` → `schema.prisma:L11618`
- `VenueFeature` → `schema.prisma:L4038`
- `VenueModule` → `schema.prisma:L9447`
- `VenuePaymentConfig` → `schema.prisma:L5266`
- `VenuePaymentLinkSettings` → `schema.prisma:L12830`
- `VenuePricingStructure` → `schema.prisma:L5765`
- `VenueRoleConfig` → `schema.prisma:L1352`
- `VenueRolePermission` → `schema.prisma:L1256`
- `VenueScaleSettings` → `schema.prisma:L14070`
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
