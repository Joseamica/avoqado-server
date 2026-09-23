# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **374 models / 354 enums / ~18,000 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                                                                        |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                                                                            |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                                                                                                      |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryConnectIntent`, `DeliveryLineAction`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                                                                           |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                                                                     |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                                                                                |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalAttemptResolution`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                        |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L16589`
- `AccountMapping` → `schema.prisma:L16485`
- `ActivityLog` → `schema.prisma:L7070`
- `Aggregator` → `schema.prisma:L14860`
- `AngelPayUserAccount` → `schema.prisma:L5629`
- `AppUpdate` → `schema.prisma:L13025`
- `Area` → `schema.prisma:L3104`
- `AreaTicket` → `schema.prisma:L15370`
- `AreaTicketCheckoutSession` → `schema.prisma:L15492`
- `AreaTicketExternalIncident` → `schema.prisma:L15739`
- `AreaTicketExternalSettlement` → `schema.prisma:L15704`
- `AreaTicketFulfillment` → `schema.prisma:L15568`
- `AreaTicketInventoryReservation` → `schema.prisma:L15463`
- `AreaTicketLine` → `schema.prisma:L15431`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15524`
- `AreaTicketPrintAttempt` → `schema.prisma:L15547`
- `BankStatement` → `schema.prisma:L16359`
- `BankStatementLine` → `schema.prisma:L16380`
- `BillingObligationConflict` → `schema.prisma:L4666`
- `BillingTaxProfile` → `schema.prisma:L17169`
- `BirthdayAutomation` → `schema.prisma:L7391`
- `BulkCommandOperation` → `schema.prisma:L10305`
- `CalendarSyncOutbox` → `schema.prisma:L14232`
- `CampaignDelivery` → `schema.prisma:L13183`
- `CashCloseout` → `schema.prisma:L10690`
- `CashDeposit` → `schema.prisma:L12827`
- `CashDrawerEvent` → `schema.prisma:L14697`
- `CashDrawerSession` → `schema.prisma:L14658`
- `CashOutCommissionRate` → `schema.prisma:L16998`
- `CashOutScheduleDay` → `schema.prisma:L17021`
- `CashOutWithdrawal` → `schema.prisma:L17083`
- `CatalogBindingBatch` → `schema.prisma:L11721`
- `CatalogBindingLine` → `schema.prisma:L11757`
- `CatalogBrand` → `schema.prisma:L11174`
- `CatalogClientObservation` → `schema.prisma:L11487`
- `CatalogClientReadinessOverride` → `schema.prisma:L11506`
- `CatalogFamily` → `schema.prisma:L11224`
- `CatalogIdempotencyRecord` → `schema.prisma:L11620`
- `CatalogIdentifier` → `schema.prisma:L11355`
- `CatalogImportBatch` → `schema.prisma:L11663`
- `CatalogImportLine` → `schema.prisma:L11700`
- `CatalogItem` → `schema.prisma:L11257`
- `CatalogItemBusinessType` → `schema.prisma:L11317`
- `CatalogItemPrice` → `schema.prisma:L11405`
- `CatalogManufacturer` → `schema.prisma:L11198`
- `CatalogProductTypeMapping` → `schema.prisma:L11334`
- `CatalogPublicationBatch` → `schema.prisma:L11785`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11879`
- `CatalogPublicationLine` → `schema.prisma:L11826`
- `CatalogPublicationOutbox` → `schema.prisma:L11922`
- `CatalogValidationProfile` → `schema.prisma:L11376`
- `CatalogVenueBinding` → `schema.prisma:L11534`
- `CatalogVenueClientRequirement` → `schema.prisma:L11461`
- `CatalogVenueEventSequence` → `schema.prisma:L11905`
- `CatalogVenueOverride` → `schema.prisma:L11576`
- `CatalogVenueRollout` → `schema.prisma:L11436`
- `Cfdi` → `schema.prisma:L16252`
- `ChatbotTokenBudget` → `schema.prisma:L9953`
- `ChatConversation` → `schema.prisma:L9808`
- `ChatFeedback` → `schema.prisma:L9894`
- `ChatLearningEvent` → `schema.prisma:L9851`
- `ChatMessage` → `schema.prisma:L9831`
- `ChatTrainingData` → `schema.prisma:L9765`
- `CheckoutSession` → `schema.prisma:L5909`
- `ClassSession` → `schema.prisma:L13836`
- `CommissionCalculation` → `schema.prisma:L12603`
- `CommissionClawback` → `schema.prisma:L12779`
- `CommissionConfig` → `schema.prisma:L12369`
- `CommissionMilestone` → `schema.prisma:L12519`
- `CommissionOverride` → `schema.prisma:L12446`
- `CommissionPayout` → `schema.prisma:L12730`
- `CommissionSummary` → `schema.prisma:L12669`
- `CommissionTier` → `schema.prisma:L12483`
- `ConsentEvent` → `schema.prisma:L7253`
- `Consumer` → `schema.prisma:L7483`
- `ConsumerAuthAccount` → `schema.prisma:L7508`
- `CouponCode` → `schema.prisma:L8455`
- `CouponRedemption` → `schema.prisma:L8486`
- `CreditAssessmentHistory` → `schema.prisma:L10799`
- `CreditItemBalance` → `schema.prisma:L14448`
- `CreditOffer` → `schema.prisma:L10818`
- `CreditPack` → `schema.prisma:L14357`
- `CreditPackItem` → `schema.prisma:L14386`
- `CreditPackPurchase` → `schema.prisma:L14403`
- `CreditTransaction` → `schema.prisma:L14470`
- `Customer` → `schema.prisma:L7111`
- `CustomerApprovalDelivery` → `schema.prisma:L9467`
- `CustomerApprovalOutbox` → `schema.prisma:L9442`
- `CustomerCampaign` → `schema.prisma:L7341`
- `CustomerCampaignDelivery` → `schema.prisma:L7423`
- `CustomerCaptureToken` → `schema.prisma:L7289`
- `CustomerDiscount` → `schema.prisma:L8506`
- `CustomerGroup` → `schema.prisma:L7547`
- `CustomerOrderMetric` → `schema.prisma:L3892`
- `CustomerTaxProfile` → `schema.prisma:L16331`
- `DeliveryActivationRequest` → `schema.prisma:L6354`
- `DeliveryChannelLink` → `schema.prisma:L6207`
- `DeliveryConnectIntent` → `schema.prisma:L6319`
- `DeliveryLineAction` → `schema.prisma:L6280`
- `DeliveryOrderEvent` → `schema.prisma:L6378`
- `DeviceToken` → `schema.prisma:L8775`
- `DigitalReceipt` → `schema.prisma:L4475`
- `Discount` → `schema.prisma:L8145`
- `EcommerceMerchant` → `schema.prisma:L5721`
- `EmailQuotaLedger` → `schema.prisma:L7470`
- `EmailSuppression` → `schema.prisma:L7458`
- `EmailTemplate` → `schema.prisma:L13122`
- `Employee` → `schema.prisma:L16846`
- `Estimate` → `schema.prisma:L14767`
- `EstimateItem` → `schema.prisma:L14795`
- `Expense` → `schema.prisma:L16633`
- `ExternalBusyBlock` → `schema.prisma:L14125`
- `Feature` → `schema.prisma:L4604`
- `FeeSchedule` → `schema.prisma:L4728`
- `FeeTier` → `schema.prisma:L4739`
- `FinancialAccount` → `schema.prisma:L14957`
- `FinancialConnection` → `schema.prisma:L14926`
- `FinancialProvider` → `schema.prisma:L14912`
- `FiscalEmisor` → `schema.prisma:L16175`
- `FiscalLossCarryforward` → `schema.prisma:L16756`
- `FixedAsset` → `schema.prisma:L16774`
- `FixedAssetDepreciation` → `schema.prisma:L16803`
- `FloorElement` → `schema.prisma:L3180`
- `FulfillmentArea` → `schema.prisma:L15235`
- `GeofenceRule` → `schema.prisma:L10390`
- `GoogleCalendarChannel` → `schema.prisma:L14102`
- `GoogleCalendarConnection` → `schema.prisma:L14054`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14155`
- `GoogleOAuthSession` → `schema.prisma:L14177`
- `HolidayCalendar` → `schema.prisma:L6994`
- `IdempotencyRequest` → `schema.prisma:L12244`
- `InterVenueTransfer` → `schema.prisma:L2932`
- `InterVenueTransferAllocation` → `schema.prisma:L3015`
- `InterVenueTransferItem` → `schema.prisma:L2984`
- `InterVenueTransferReceipt` → `schema.prisma:L3042`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3058`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3086`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3070`
- `Inventory` → `schema.prisma:L1971`
- `InventoryMovement` → `schema.prisma:L1998`
- `InventoryPosting` → `schema.prisma:L2080`
- `InventoryPostingLine` → `schema.prisma:L2120`
- `InventoryTransfer` → `schema.prisma:L14739`
- `Invitation` → `schema.prisma:L1477`
- `Invoice` → `schema.prisma:L4751`
- `InvoiceItem` → `schema.prisma:L4777`
- `ItemCategory` → `schema.prisma:L11957`
- `JournalEntry` → `schema.prisma:L16543`
- `JournalLine` → `schema.prisma:L16571`
- `KdsOrder` → `schema.prisma:L15005`
- `KdsOrderItem` → `schema.prisma:L15051`
- `KioskCheckInAttempt` → `schema.prisma:L17492`
- `KioskCheckInChallenge` → `schema.prisma:L17446`
- `KioskOutreachOutbox` → `schema.prisma:L17513`
- `LaunchCampaign` → `schema.prisma:L17851`
- `LaunchCampaignRedemption` → `schema.prisma:L17957`
- `LearnedPatterns` → `schema.prisma:L9875`
- `LedgerAccount` → `schema.prisma:L16435`
- `LiveDemoSession` → `schema.prisma:L822`
- `LowStockAlert` → `schema.prisma:L2766`
- `LoyaltyConfig` → `schema.prisma:L7577`
- `LoyaltyTransaction` → `schema.prisma:L7620`
- `MarketingCampaign` → `schema.prisma:L13140`
- `McpAuthCode` → `schema.prisma:L16058`
- `McpOAuthClient` → `schema.prisma:L16042`
- `McpRefreshToken` → `schema.prisma:L16076`
- `McpToolCall` → `schema.prisma:L16097`
- `MeasurementUnit` → `schema.prisma:L14845`
- `Menu` → `schema.prisma:L1695`
- `MenuCategory` → `schema.prisma:L1632`
- `MenuCategoryAssignment` → `schema.prisma:L1730`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15972`
- `MerchantAccount` → `schema.prisma:L5459`
- `MerchantFiscalConfig` → `schema.prisma:L16223`
- `MerchantRevenueShare` → `schema.prisma:L6574`
- `MerchantRoutingRule` → `schema.prisma:L5581`
- `MilestoneAchievement` → `schema.prisma:L12564`
- `Modifier` → `schema.prisma:L4081`
- `ModifierGroup` → `schema.prisma:L4045`
- `Module` → `schema.prisma:L10866`
- `MoneyAnomaly` → `schema.prisma:L6477`
- `MonthlyVenueProfit` → `schema.prisma:L7020`
- `Notification` → `schema.prisma:L8677`
- `NotificationPreference` → `schema.prisma:L8724`
- `NotificationTemplate` → `schema.prisma:L8751`
- `OAuthState` → `schema.prisma:L1528`
- `OnboardingProgress` → `schema.prisma:L1546`
- `Order` → `schema.prisma:L3629`
- `OrderAction` → `schema.prisma:L4148`
- `OrderCustomer` → `schema.prisma:L3871`
- `OrderDiscount` → `schema.prisma:L8538`
- `OrderFulfillment` → `schema.prisma:L15290`
- `OrderFulfillmentLine` → `schema.prisma:L15321`
- `OrderItem` → `schema.prisma:L3907`
- `OrderItemModifier` → `schema.prisma:L4130`
- `OrderPromotion` → `schema.prisma:L17409`
- `OrderServiceCharge` → `schema.prisma:L8622`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12941`
- `OrganizationEntitlement` → `schema.prisma:L11149`
- `OrganizationGoal` → `schema.prisma:L12899`
- `OrganizationModule` → `schema.prisma:L10926`
- `OrganizationPaymentConfig` → `schema.prisma:L6033`
- `OrganizationPayoutConfig` → `schema.prisma:L12974`
- `OrganizationPricingStructure` → `schema.prisma:L6065`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12922`
- `OtpChallenge` → `schema.prisma:L7527`
- `OvertimeApproval` → `schema.prisma:L3407`
- `PartnerAPIKey` → `schema.prisma:L5863`
- `Payment` → `schema.prisma:L4181`
- `PaymentAllocation` → `schema.prisma:L4454`
- `PaymentEffect` → `schema.prisma:L17783`
- `PaymentLink` → `schema.prisma:L14516`
- `PaymentLinkAttribution` → `schema.prisma:L14624`
- `PaymentLinkItem` → `schema.prisma:L14579`
- `PaymentLinkItemModifier` → `schema.prisma:L14606`
- `PaymentProvider` → `schema.prisma:L5418`
- `PayrollLine` → `schema.prisma:L16917`
- `PayrollRun` → `schema.prisma:L16886`
- `PerformanceGoal` → `schema.prisma:L12876`
- `PermissionOverride` → `schema.prisma:L1401`
- `PermissionSet` → `schema.prisma:L1424`
- `PlatformAnnouncement` → `schema.prisma:L17573`
- `PlatformAnnouncementClick` → `schema.prisma:L17638`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17675`
- `PlatformCfdi` → `schema.prisma:L17202`
- `PlatformEmisor` → `schema.prisma:L17142`
- `PlatformSettings` → `schema.prisma:L5840`
- `PosCommand` → `schema.prisma:L8805`
- `PosConnectionStatus` → `schema.prisma:L948`
- `PosSyncIntent` → `schema.prisma:L17280`
- `PricingPolicy` → `schema.prisma:L2670`
- `Printer` → `schema.prisma:L15100`
- `PrintGateway` → `schema.prisma:L15157`
- `PrintJob` → `schema.prisma:L15871`
- `PrintStation` → `schema.prisma:L15175`
- `PrivacyNoticeVersion` → `schema.prisma:L7275`
- `ProcessedStripeEvent` → `schema.prisma:L6463`
- `ProcessorReliabilityMetric` → `schema.prisma:L6948`
- `Product` → `schema.prisma:L1748`
- `ProductModifierGroup` → `schema.prisma:L4118`
- `ProductOption` → `schema.prisma:L14822`
- `ProductOptionValue` → `schema.prisma:L14833`
- `ProductStaff` → `schema.prisma:L13751`
- `PromoterBankAccount` → `schema.prisma:L17037`
- `PromoterCommissionEntry` → `schema.prisma:L17056`
- `PromoterLocationPing` → `schema.prisma:L3595`
- `Promotion` → `schema.prisma:L17331`
- `PromotionGroup` → `schema.prisma:L17370`
- `PromotionOption` → `schema.prisma:L17386`
- `ProviderCostStructure` → `schema.prisma:L6499`
- `ProviderEventLog` → `schema.prisma:L6142`
- `PurchaseOrder` → `schema.prisma:L2395`
- `PurchaseOrderInvoice` → `schema.prisma:L2540`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2597`
- `PurchaseOrderItem` → `schema.prisma:L2453`
- `RateCorrectionBatch` → `schema.prisma:L6724`
- `RateCorrectionEntry` → `schema.prisma:L6766`
- `RawMaterial` → `schema.prisma:L2152`
- `RawMaterialMovement` → `schema.prisma:L2723`
- `RawMaterialPresentation` → `schema.prisma:L2227`
- `ReceiptLayout` → `schema.prisma:L17817`
- `Recipe` → `schema.prisma:L2247`
- `RecipeLine` → `schema.prisma:L2271`
- `Referral` → `schema.prisma:L7993`
- `ReferralProgramConfig` → `schema.prisma:L7958`
- `ReferralRewardGrant` → `schema.prisma:L8084`
- `ReferralTierReward` → `schema.prisma:L8056`
- `ReferralTierUnlock` → `schema.prisma:L8129`
- `RefreshGrant` → `schema.prisma:L17762`
- `Reservation` → `schema.prisma:L13519`
- `ReservationGoogleEventMapping` → `schema.prisma:L14289`
- `ReservationModifier` → `schema.prisma:L13699`
- `ReservationReminderSent` → `schema.prisma:L13682`
- `ReservationSettings` → `schema.prisma:L13913`
- `ReservationWaitlistEntry` → `schema.prisma:L13881`
- `Review` → `schema.prisma:L4795`
- `SalesRetention` → `schema.prisma:L16737`
- `SaleVerification` → `schema.prisma:L4508`
- `ScaleProfile` → `schema.prisma:L15612`
- `ScheduledCommand` → `schema.prisma:L10350`
- `SerializedItem` → `schema.prisma:L12000`
- `SerializedItemCustodyEvent` → `schema.prisma:L12167`
- `ServiceCharge` → `schema.prisma:L8593`
- `Session` → `schema.prisma:L17741`
- `SettlementConfiguration` → `schema.prisma:L6799`
- `SettlementConfirmation` → `schema.prisma:L6912`
- `SettlementIncident` → `schema.prisma:L6863`
- `SettlementSimulation` → `schema.prisma:L6834`
- `Shift` → `schema.prisma:L3218`
- `SimRegistrationRequest` → `schema.prisma:L12205`
- `SimRegistrationRequestItem` → `schema.prisma:L12227`
- `SlotHold` → `schema.prisma:L13782`
- `Staff` → `schema.prisma:L968`
- `StaffDocument` → `schema.prisma:L3466`
- `StaffOnboardingState` → `schema.prisma:L15942`
- `StaffOrganization` → `schema.prisma:L1300`
- `StaffPasskey` → `schema.prisma:L1327`
- `StaffSchedule` → `schema.prisma:L13722`
- `StaffScheduleException` → `schema.prisma:L13734`
- `StaffVenue` → `schema.prisma:L1224`
- `StaffWorkSchedule` → `schema.prisma:L3343`
- `StaffWorkScheduleException` → `schema.prisma:L3441`
- `StampCard` → `schema.prisma:L7841`
- `StampEvent` → `schema.prisma:L7880`
- `StampReward` → `schema.prisma:L7918`
- `StockAlertConfig` → `schema.prisma:L12858`
- `StockBatch` → `schema.prisma:L2881`
- `StockCount` → `schema.prisma:L2798`
- `StockCountItem` → `schema.prisma:L2826`
- `StripeWebhookEvent` → `schema.prisma:L6446`
- `Supplier` → `schema.prisma:L2306`
- `SupplierItemCode` → `schema.prisma:L2638`
- `SupplierPricing` → `schema.prisma:L2361`
- `Table` → `schema.prisma:L3130`
- `Terminal` → `schema.prisma:L4846`
- `TerminalAttemptResolution` → `schema.prisma:L5277`
- `TerminalHealth` → `schema.prisma:L5097`
- `TerminalLog` → `schema.prisma:L5071`
- `TerminalOrder` → `schema.prisma:L5321`
- `TerminalOrderItem` → `schema.prisma:L5396`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5249`
- `TerminalPaymentRequest` → `schema.prisma:L5168`
- `TimeEntry` → `schema.prisma:L3508`
- `TimeEntryBreak` → `schema.prisma:L3577`
- `TokenPurchase` → `schema.prisma:L10024`
- `TokenUsageRecord` → `schema.prisma:L9996`
- `TpvCommandHistory` → `schema.prisma:L10256`
- `TpvCommandQueue` → `schema.prisma:L10196`
- `TpvFeedback` → `schema.prisma:L9909`
- `TpvMessage` → `schema.prisma:L13215`
- `TpvMessageDelivery` → `schema.prisma:L13267`
- `TpvMessageResponse` → `schema.prisma:L13290`
- `TrainingModule` → `schema.prisma:L13345`
- `TrainingProgress` → `schema.prisma:L13422`
- `TrainingQuizQuestion` → `schema.prisma:L13404`
- `TrainingStep` → `schema.prisma:L13384`
- `TransactionCost` → `schema.prisma:L6662`
- `UnitConversion` → `schema.prisma:L2701`
- `UpsellAcceptance` → `schema.prisma:L8414`
- `UpsellAiRun` → `schema.prisma:L8434`
- `UpsellImpression` → `schema.prisma:L8374`
- `UpsellRule` → `schema.prisma:L8294`
- `user_sessions` → `schema.prisma:L5898`
- `Venue` → `schema.prisma:L163`
- `VenueAreaTicketSettings` → `schema.prisma:L15349`
- `VenueChatMessage` → `schema.prisma:L798`
- `VenueChatSession` → `schema.prisma:L753`
- `VenueCommission` → `schema.prisma:L14983`
- `VenueCreditAssessment` → `schema.prisma:L10738`
- `VenueCryptoConfig` → `schema.prisma:L13082`
- `VenueFeature` → `schema.prisma:L4622`
- `VenueModule` → `schema.prisma:L10898`
- `VenuePaymentConfig` → `schema.prisma:L5999`
- `VenuePaymentLinkSettings` → `schema.prisma:L14322`
- `VenuePricingStructure` → `schema.prisma:L6602`
- `VenueRoleConfig` → `schema.prisma:L1453`
- `VenueRolePermission` → `schema.prisma:L1357`
- `VenueScaleSettings` → `schema.prisma:L15600`
- `VenueSettings` → `schema.prisma:L838`
- `VenueTenderType` → `schema.prisma:L4367`
- `VenueTenderTypeRevision` → `schema.prisma:L4432`
- `VenueTransaction` → `schema.prisma:L4559`
- `VenueWhatsappActivation` → `schema.prisma:L689`
- `WalletCardDesign` → `schema.prisma:L7759`
- `WalletPass` → `schema.prisma:L7660`
- `WalletPassRegistration` → `schema.prisma:L7726`
- `WebhookEvent` → `schema.prisma:L4704`
- `WebhookSubscription` → `schema.prisma:L6115`
- `WhatsappContactWindow` → `schema.prisma:L707`
- `WhatsappInboundEvent` → `schema.prisma:L727`
- `WorkShiftAssignment` → `schema.prisma:L3383`
- `WorkShiftTemplate` → `schema.prisma:L3360`
- `Zone` → `schema.prisma:L146`
