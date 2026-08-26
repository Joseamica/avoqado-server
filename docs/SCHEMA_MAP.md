# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **346 models / 336 enums / ~16,500 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                          |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                           |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                           |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`                                                                                                                                                                                                                                                      |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                        |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                |
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

- `AccountingPeriodLock` → `schema.prisma:L15630`
- `AccountMapping` → `schema.prisma:L15526`
- `ActivityLog` → `schema.prisma:L6481`
- `Aggregator` → `schema.prisma:L13927`
- `AngelPayUserAccount` → `schema.prisma:L5144`
- `AppUpdate` → `schema.prisma:L12107`
- `Area` → `schema.prisma:L2936`
- `AreaTicket` → `schema.prisma:L14421`
- `AreaTicketCheckoutSession` → `schema.prisma:L14543`
- `AreaTicketExternalIncident` → `schema.prisma:L14790`
- `AreaTicketExternalSettlement` → `schema.prisma:L14755`
- `AreaTicketFulfillment` → `schema.prisma:L14619`
- `AreaTicketInventoryReservation` → `schema.prisma:L14514`
- `AreaTicketLine` → `schema.prisma:L14482`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14575`
- `AreaTicketPrintAttempt` → `schema.prisma:L14598`
- `BankStatement` → `schema.prisma:L15400`
- `BankStatementLine` → `schema.prisma:L15421`
- `BillingTaxProfile` → `schema.prisma:L16210`
- `BulkCommandOperation` → `schema.prisma:L9405`
- `CalendarSyncOutbox` → `schema.prisma:L13314`
- `CampaignDelivery` → `schema.prisma:L12265`
- `CashCloseout` → `schema.prisma:L9785`
- `CashDeposit` → `schema.prisma:L11909`
- `CashDrawerEvent` → `schema.prisma:L13764`
- `CashDrawerSession` → `schema.prisma:L13740`
- `CashOutCommissionRate` → `schema.prisma:L16039`
- `CashOutScheduleDay` → `schema.prisma:L16062`
- `CashOutWithdrawal` → `schema.prisma:L16124`
- `CatalogBindingBatch` → `schema.prisma:L10816`
- `CatalogBindingLine` → `schema.prisma:L10852`
- `CatalogBrand` → `schema.prisma:L10269`
- `CatalogClientObservation` → `schema.prisma:L10582`
- `CatalogClientReadinessOverride` → `schema.prisma:L10601`
- `CatalogFamily` → `schema.prisma:L10319`
- `CatalogIdempotencyRecord` → `schema.prisma:L10715`
- `CatalogIdentifier` → `schema.prisma:L10450`
- `CatalogImportBatch` → `schema.prisma:L10758`
- `CatalogImportLine` → `schema.prisma:L10795`
- `CatalogItem` → `schema.prisma:L10352`
- `CatalogItemBusinessType` → `schema.prisma:L10412`
- `CatalogItemPrice` → `schema.prisma:L10500`
- `CatalogManufacturer` → `schema.prisma:L10293`
- `CatalogProductTypeMapping` → `schema.prisma:L10429`
- `CatalogPublicationBatch` → `schema.prisma:L10880`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10974`
- `CatalogPublicationLine` → `schema.prisma:L10921`
- `CatalogPublicationOutbox` → `schema.prisma:L11017`
- `CatalogValidationProfile` → `schema.prisma:L10471`
- `CatalogVenueBinding` → `schema.prisma:L10629`
- `CatalogVenueClientRequirement` → `schema.prisma:L10556`
- `CatalogVenueEventSequence` → `schema.prisma:L11000`
- `CatalogVenueOverride` → `schema.prisma:L10671`
- `CatalogVenueRollout` → `schema.prisma:L10531`
- `Cfdi` → `schema.prisma:L15303`
- `ChatbotTokenBudget` → `schema.prisma:L9053`
- `ChatConversation` → `schema.prisma:L8908`
- `ChatFeedback` → `schema.prisma:L8994`
- `ChatLearningEvent` → `schema.prisma:L8951`
- `ChatMessage` → `schema.prisma:L8931`
- `ChatTrainingData` → `schema.prisma:L8865`
- `CheckoutSession` → `schema.prisma:L5424`
- `ClassSession` → `schema.prisma:L12918`
- `CommissionCalculation` → `schema.prisma:L11688`
- `CommissionClawback` → `schema.prisma:L11861`
- `CommissionConfig` → `schema.prisma:L11461`
- `CommissionMilestone` → `schema.prisma:L11604`
- `CommissionOverride` → `schema.prisma:L11531`
- `CommissionPayout` → `schema.prisma:L11812`
- `CommissionSummary` → `schema.prisma:L11751`
- `CommissionTier` → `schema.prisma:L11568`
- `Consumer` → `schema.prisma:L6643`
- `ConsumerAuthAccount` → `schema.prisma:L6668`
- `CouponCode` → `schema.prisma:L7563`
- `CouponRedemption` → `schema.prisma:L7594`
- `CreditAssessmentHistory` → `schema.prisma:L9894`
- `CreditItemBalance` → `schema.prisma:L13530`
- `CreditOffer` → `schema.prisma:L9913`
- `CreditPack` → `schema.prisma:L13439`
- `CreditPackItem` → `schema.prisma:L13468`
- `CreditPackPurchase` → `schema.prisma:L13485`
- `CreditTransaction` → `schema.prisma:L13552`
- `Customer` → `schema.prisma:L6522`
- `CustomerApprovalDelivery` → `schema.prisma:L8570`
- `CustomerApprovalOutbox` → `schema.prisma:L8545`
- `CustomerDiscount` → `schema.prisma:L7614`
- `CustomerGroup` → `schema.prisma:L6707`
- `CustomerTaxProfile` → `schema.prisma:L15372`
- `DeliveryActivationRequest` → `schema.prisma:L5765`
- `DeliveryChannelLink` → `schema.prisma:L5710`
- `DeliveryOrderEvent` → `schema.prisma:L5789`
- `DeviceToken` → `schema.prisma:L7883`
- `DigitalReceipt` → `schema.prisma:L4139`
- `Discount` → `schema.prisma:L7253`
- `EcommerceMerchant` → `schema.prisma:L5236`
- `EmailTemplate` → `schema.prisma:L12204`
- `Employee` → `schema.prisma:L15887`
- `Estimate` → `schema.prisma:L13834`
- `EstimateItem` → `schema.prisma:L13862`
- `Expense` → `schema.prisma:L15674`
- `ExternalBusyBlock` → `schema.prisma:L13207`
- `Feature` → `schema.prisma:L4268`
- `FeeSchedule` → `schema.prisma:L4346`
- `FeeTier` → `schema.prisma:L4357`
- `FinancialAccount` → `schema.prisma:L14024`
- `FinancialConnection` → `schema.prisma:L13993`
- `FinancialProvider` → `schema.prisma:L13979`
- `FiscalEmisor` → `schema.prisma:L15226`
- `FiscalLossCarryforward` → `schema.prisma:L15797`
- `FixedAsset` → `schema.prisma:L15815`
- `FixedAssetDepreciation` → `schema.prisma:L15844`
- `FloorElement` → `schema.prisma:L3012`
- `FulfillmentArea` → `schema.prisma:L14286`
- `GeofenceRule` → `schema.prisma:L9490`
- `GoogleCalendarChannel` → `schema.prisma:L13184`
- `GoogleCalendarConnection` → `schema.prisma:L13136`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13237`
- `GoogleOAuthSession` → `schema.prisma:L13259`
- `HolidayCalendar` → `schema.prisma:L6405`
- `IdempotencyRequest` → `schema.prisma:L11336`
- `InterVenueTransfer` → `schema.prisma:L2764`
- `InterVenueTransferAllocation` → `schema.prisma:L2847`
- `InterVenueTransferItem` → `schema.prisma:L2816`
- `InterVenueTransferReceipt` → `schema.prisma:L2874`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2890`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2918`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2902`
- `Inventory` → `schema.prisma:L1858`
- `InventoryMovement` → `schema.prisma:L1885`
- `InventoryPosting` → `schema.prisma:L1967`
- `InventoryPostingLine` → `schema.prisma:L2007`
- `InventoryTransfer` → `schema.prisma:L13806`
- `Invitation` → `schema.prisma:L1398`
- `Invoice` → `schema.prisma:L4369`
- `InvoiceItem` → `schema.prisma:L4395`
- `ItemCategory` → `schema.prisma:L11052`
- `JournalEntry` → `schema.prisma:L15584`
- `JournalLine` → `schema.prisma:L15612`
- `KdsOrder` → `schema.prisma:L14072`
- `KdsOrderItem` → `schema.prisma:L14113`
- `KioskCheckInAttempt` → `schema.prisma:L16533`
- `KioskCheckInChallenge` → `schema.prisma:L16487`
- `KioskOutreachOutbox` → `schema.prisma:L16554`
- `LearnedPatterns` → `schema.prisma:L8975`
- `LedgerAccount` → `schema.prisma:L15476`
- `LiveDemoSession` → `schema.prisma:L783`
- `LowStockAlert` → `schema.prisma:L2605`
- `LoyaltyConfig` → `schema.prisma:L6737`
- `LoyaltyTransaction` → `schema.prisma:L6780`
- `MarketingCampaign` → `schema.prisma:L12222`
- `McpAuthCode` → `schema.prisma:L15109`
- `McpOAuthClient` → `schema.prisma:L15093`
- `McpRefreshToken` → `schema.prisma:L15127`
- `McpToolCall` → `schema.prisma:L15148`
- `MeasurementUnit` → `schema.prisma:L13912`
- `Menu` → `schema.prisma:L1584`
- `MenuCategory` → `schema.prisma:L1521`
- `MenuCategoryAssignment` → `schema.prisma:L1619`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15023`
- `MerchantAccount` → `schema.prisma:L4974`
- `MerchantFiscalConfig` → `schema.prisma:L15274`
- `MerchantRevenueShare` → `schema.prisma:L5985`
- `MerchantRoutingRule` → `schema.prisma:L5096`
- `MilestoneAchievement` → `schema.prisma:L11649`
- `Modifier` → `schema.prisma:L3754`
- `ModifierGroup` → `schema.prisma:L3718`
- `Module` → `schema.prisma:L9961`
- `MoneyAnomaly` → `schema.prisma:L5888`
- `MonthlyVenueProfit` → `schema.prisma:L6431`
- `Notification` → `schema.prisma:L7785`
- `NotificationPreference` → `schema.prisma:L7832`
- `NotificationTemplate` → `schema.prisma:L7859`
- `OAuthState` → `schema.prisma:L1449`
- `OnboardingProgress` → `schema.prisma:L1467`
- `Order` → `schema.prisma:L3356`
- `OrderAction` → `schema.prisma:L3819`
- `OrderCustomer` → `schema.prisma:L3569`
- `OrderDiscount` → `schema.prisma:L7646`
- `OrderFulfillment` → `schema.prisma:L14341`
- `OrderFulfillmentLine` → `schema.prisma:L14372`
- `OrderItem` → `schema.prisma:L3585`
- `OrderItemModifier` → `schema.prisma:L3803`
- `OrderPromotion` → `schema.prisma:L16450`
- `OrderServiceCharge` → `schema.prisma:L7730`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12023`
- `OrganizationEntitlement` → `schema.prisma:L10244`
- `OrganizationGoal` → `schema.prisma:L11981`
- `OrganizationModule` → `schema.prisma:L10021`
- `OrganizationPaymentConfig` → `schema.prisma:L5548`
- `OrganizationPayoutConfig` → `schema.prisma:L12056`
- `OrganizationPricingStructure` → `schema.prisma:L5580`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12004`
- `OtpChallenge` → `schema.prisma:L6687`
- `PartnerAPIKey` → `schema.prisma:L5378`
- `Payment` → `schema.prisma:L3852`
- `PaymentAllocation` → `schema.prisma:L4118`
- `PaymentLink` → `schema.prisma:L13598`
- `PaymentLinkAttribution` → `schema.prisma:L13706`
- `PaymentLinkItem` → `schema.prisma:L13661`
- `PaymentLinkItemModifier` → `schema.prisma:L13688`
- `PaymentProvider` → `schema.prisma:L4933`
- `PayrollLine` → `schema.prisma:L15958`
- `PayrollRun` → `schema.prisma:L15927`
- `PerformanceGoal` → `schema.prisma:L11958`
- `PermissionOverride` → `schema.prisma:L1326`
- `PermissionSet` → `schema.prisma:L1349`
- `PlatformCfdi` → `schema.prisma:L16243`
- `PlatformEmisor` → `schema.prisma:L16183`
- `PlatformSettings` → `schema.prisma:L5355`
- `PosCommand` → `schema.prisma:L7913`
- `PosConnectionStatus` → `schema.prisma:L893`
- `PosSyncIntent` → `schema.prisma:L16321`
- `PricingPolicy` → `schema.prisma:L2509`
- `Printer` → `schema.prisma:L14155`
- `PrintGateway` → `schema.prisma:L14208`
- `PrintJob` → `schema.prisma:L14922`
- `PrintStation` → `schema.prisma:L14226`
- `ProcessedStripeEvent` → `schema.prisma:L5874`
- `ProcessorReliabilityMetric` → `schema.prisma:L6359`
- `Product` → `schema.prisma:L1637`
- `ProductModifierGroup` → `schema.prisma:L3791`
- `ProductOption` → `schema.prisma:L13889`
- `ProductOptionValue` → `schema.prisma:L13900`
- `ProductStaff` → `schema.prisma:L12833`
- `PromoterBankAccount` → `schema.prisma:L16078`
- `PromoterCommissionEntry` → `schema.prisma:L16097`
- `PromoterLocationPing` → `schema.prisma:L3322`
- `Promotion` → `schema.prisma:L16372`
- `PromotionGroup` → `schema.prisma:L16411`
- `PromotionOption` → `schema.prisma:L16427`
- `ProviderCostStructure` → `schema.prisma:L5910`
- `ProviderEventLog` → `schema.prisma:L5657`
- `PurchaseOrder` → `schema.prisma:L2279`
- `PurchaseOrderInvoice` → `schema.prisma:L2424`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2479`
- `PurchaseOrderItem` → `schema.prisma:L2337`
- `RateCorrectionBatch` → `schema.prisma:L6135`
- `RateCorrectionEntry` → `schema.prisma:L6177`
- `RawMaterial` → `schema.prisma:L2039`
- `RawMaterialMovement` → `schema.prisma:L2562`
- `RawMaterialPresentation` → `schema.prisma:L2112`
- `Recipe` → `schema.prisma:L2132`
- `RecipeLine` → `schema.prisma:L2156`
- `Referral` → `schema.prisma:L7101`
- `ReferralProgramConfig` → `schema.prisma:L7066`
- `ReferralRewardGrant` → `schema.prisma:L7192`
- `ReferralTierReward` → `schema.prisma:L7164`
- `ReferralTierUnlock` → `schema.prisma:L7237`
- `Reservation` → `schema.prisma:L12601`
- `ReservationGoogleEventMapping` → `schema.prisma:L13371`
- `ReservationModifier` → `schema.prisma:L12781`
- `ReservationReminderSent` → `schema.prisma:L12764`
- `ReservationSettings` → `schema.prisma:L12995`
- `ReservationWaitlistEntry` → `schema.prisma:L12963`
- `Review` → `schema.prisma:L4413`
- `SalesRetention` → `schema.prisma:L15778`
- `SaleVerification` → `schema.prisma:L4172`
- `ScaleProfile` → `schema.prisma:L14663`
- `ScheduledCommand` → `schema.prisma:L9450`
- `SerializedItem` → `schema.prisma:L11095`
- `SerializedItemCustodyEvent` → `schema.prisma:L11259`
- `ServiceCharge` → `schema.prisma:L7701`
- `SettlementConfiguration` → `schema.prisma:L6210`
- `SettlementConfirmation` → `schema.prisma:L6323`
- `SettlementIncident` → `schema.prisma:L6274`
- `SettlementSimulation` → `schema.prisma:L6245`
- `Shift` → `schema.prisma:L3050`
- `SimRegistrationRequest` → `schema.prisma:L11297`
- `SimRegistrationRequestItem` → `schema.prisma:L11319`
- `SlotHold` → `schema.prisma:L12864`
- `Staff` → `schema.prisma:L913`
- `StaffDocument` → `schema.prisma:L3193`
- `StaffOnboardingState` → `schema.prisma:L14993`
- `StaffOrganization` → `schema.prisma:L1225`
- `StaffPasskey` → `schema.prisma:L1252`
- `StaffSchedule` → `schema.prisma:L12804`
- `StaffScheduleException` → `schema.prisma:L12816`
- `StaffVenue` → `schema.prisma:L1151`
- `StaffWorkSchedule` → `schema.prisma:L3157`
- `StaffWorkScheduleException` → `schema.prisma:L3172`
- `StampCard` → `schema.prisma:L6949`
- `StampEvent` → `schema.prisma:L6988`
- `StampReward` → `schema.prisma:L7026`
- `StockAlertConfig` → `schema.prisma:L11940`
- `StockBatch` → `schema.prisma:L2713`
- `StockCount` → `schema.prisma:L2637`
- `StockCountItem` → `schema.prisma:L2661`
- `StripeWebhookEvent` → `schema.prisma:L5857`
- `Supplier` → `schema.prisma:L2191`
- `SupplierPricing` → `schema.prisma:L2245`
- `Table` → `schema.prisma:L2962`
- `Terminal` → `schema.prisma:L4464`
- `TerminalHealth` → `schema.prisma:L4703`
- `TerminalLog` → `schema.prisma:L4677`
- `TerminalOrder` → `schema.prisma:L4836`
- `TerminalOrderItem` → `schema.prisma:L4911`
- `TerminalPaymentRequest` → `schema.prisma:L4774`
- `TimeEntry` → `schema.prisma:L3235`
- `TimeEntryBreak` → `schema.prisma:L3304`
- `TokenPurchase` → `schema.prisma:L9124`
- `TokenUsageRecord` → `schema.prisma:L9096`
- `TpvCommandHistory` → `schema.prisma:L9356`
- `TpvCommandQueue` → `schema.prisma:L9296`
- `TpvFeedback` → `schema.prisma:L9009`
- `TpvMessage` → `schema.prisma:L12297`
- `TpvMessageDelivery` → `schema.prisma:L12349`
- `TpvMessageResponse` → `schema.prisma:L12372`
- `TrainingModule` → `schema.prisma:L12427`
- `TrainingProgress` → `schema.prisma:L12504`
- `TrainingQuizQuestion` → `schema.prisma:L12486`
- `TrainingStep` → `schema.prisma:L12466`
- `TransactionCost` → `schema.prisma:L6073`
- `UnitConversion` → `schema.prisma:L2540`
- `UpsellAcceptance` → `schema.prisma:L7522`
- `UpsellAiRun` → `schema.prisma:L7542`
- `UpsellImpression` → `schema.prisma:L7482`
- `UpsellRule` → `schema.prisma:L7402`
- `user_sessions` → `schema.prisma:L5413`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14400`
- `VenueChatMessage` → `schema.prisma:L759`
- `VenueChatSession` → `schema.prisma:L714`
- `VenueCommission` → `schema.prisma:L14050`
- `VenueCreditAssessment` → `schema.prisma:L9833`
- `VenueCryptoConfig` → `schema.prisma:L12164`
- `VenueFeature` → `schema.prisma:L4286`
- `VenueModule` → `schema.prisma:L9993`
- `VenuePaymentConfig` → `schema.prisma:L5514`
- `VenuePaymentLinkSettings` → `schema.prisma:L13404`
- `VenuePricingStructure` → `schema.prisma:L6013`
- `VenueRoleConfig` → `schema.prisma:L1378`
- `VenueRolePermission` → `schema.prisma:L1282`
- `VenueScaleSettings` → `schema.prisma:L14651`
- `VenueSettings` → `schema.prisma:L799`
- `VenueTenderType` → `schema.prisma:L4031`
- `VenueTenderTypeRevision` → `schema.prisma:L4096`
- `VenueTransaction` → `schema.prisma:L4223`
- `VenueWhatsappActivation` → `schema.prisma:L650`
- `WalletCardDesign` → `schema.prisma:L6877`
- `WalletPass` → `schema.prisma:L6820`
- `WebhookEvent` → `schema.prisma:L4322`
- `WebhookSubscription` → `schema.prisma:L5630`
- `WhatsappContactWindow` → `schema.prisma:L668`
- `WhatsappInboundEvent` → `schema.prisma:L688`
- `Zone` → `schema.prisma:L142`
