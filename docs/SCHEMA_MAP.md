# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **377 models / 359 enums / ~18,100 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueIvaPorProducto`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                                                                                                       |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `InventoryWasteReport`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                                                                                                         |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryConnectIntent`, `DeliveryLineAction`, `DeliveryOrderEvent`, `DeliveryStoreRevocation`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                                                                                                      |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                                                                                                |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                                                                                                           |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalAttemptResolution`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L16731`
- `AccountMapping` → `schema.prisma:L16627`
- `ActivityLog` → `schema.prisma:L7202`
- `Aggregator` → `schema.prisma:L14992`
- `AngelPayUserAccount` → `schema.prisma:L5747`
- `AppUpdate` → `schema.prisma:L13157`
- `Area` → `schema.prisma:L3222`
- `AreaTicket` → `schema.prisma:L15505`
- `AreaTicketCheckoutSession` → `schema.prisma:L15627`
- `AreaTicketExternalIncident` → `schema.prisma:L15874`
- `AreaTicketExternalSettlement` → `schema.prisma:L15839`
- `AreaTicketFulfillment` → `schema.prisma:L15703`
- `AreaTicketInventoryReservation` → `schema.prisma:L15598`
- `AreaTicketLine` → `schema.prisma:L15566`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15659`
- `AreaTicketPrintAttempt` → `schema.prisma:L15682`
- `BankStatement` → `schema.prisma:L16501`
- `BankStatementLine` → `schema.prisma:L16522`
- `BillingObligationConflict` → `schema.prisma:L4784`
- `BillingTaxProfile` → `schema.prisma:L17323`
- `BirthdayAutomation` → `schema.prisma:L7523`
- `BulkCommandOperation` → `schema.prisma:L10437`
- `CalendarSyncOutbox` → `schema.prisma:L14364`
- `CampaignDelivery` → `schema.prisma:L13315`
- `CashCloseout` → `schema.prisma:L10822`
- `CashDeposit` → `schema.prisma:L12959`
- `CashDrawerEvent` → `schema.prisma:L14829`
- `CashDrawerSession` → `schema.prisma:L14790`
- `CashOutCommissionRate` → `schema.prisma:L17140`
- `CashOutScheduleDay` → `schema.prisma:L17163`
- `CashOutWithdrawal` → `schema.prisma:L17225`
- `CatalogBindingBatch` → `schema.prisma:L11853`
- `CatalogBindingLine` → `schema.prisma:L11889`
- `CatalogBrand` → `schema.prisma:L11306`
- `CatalogClientObservation` → `schema.prisma:L11619`
- `CatalogClientReadinessOverride` → `schema.prisma:L11638`
- `CatalogFamily` → `schema.prisma:L11356`
- `CatalogIdempotencyRecord` → `schema.prisma:L11752`
- `CatalogIdentifier` → `schema.prisma:L11487`
- `CatalogImportBatch` → `schema.prisma:L11795`
- `CatalogImportLine` → `schema.prisma:L11832`
- `CatalogItem` → `schema.prisma:L11389`
- `CatalogItemBusinessType` → `schema.prisma:L11449`
- `CatalogItemPrice` → `schema.prisma:L11537`
- `CatalogManufacturer` → `schema.prisma:L11330`
- `CatalogProductTypeMapping` → `schema.prisma:L11466`
- `CatalogPublicationBatch` → `schema.prisma:L11917`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12011`
- `CatalogPublicationLine` → `schema.prisma:L11958`
- `CatalogPublicationOutbox` → `schema.prisma:L12054`
- `CatalogValidationProfile` → `schema.prisma:L11508`
- `CatalogVenueBinding` → `schema.prisma:L11666`
- `CatalogVenueClientRequirement` → `schema.prisma:L11593`
- `CatalogVenueEventSequence` → `schema.prisma:L12037`
- `CatalogVenueOverride` → `schema.prisma:L11708`
- `CatalogVenueRollout` → `schema.prisma:L11568`
- `Cfdi` → `schema.prisma:L16394`
- `ChatbotTokenBudget` → `schema.prisma:L10085`
- `ChatConversation` → `schema.prisma:L9940`
- `ChatFeedback` → `schema.prisma:L10026`
- `ChatLearningEvent` → `schema.prisma:L9983`
- `ChatMessage` → `schema.prisma:L9963`
- `ChatTrainingData` → `schema.prisma:L9897`
- `CheckoutSession` → `schema.prisma:L6027`
- `ClassSession` → `schema.prisma:L13968`
- `CommissionCalculation` → `schema.prisma:L12735`
- `CommissionClawback` → `schema.prisma:L12911`
- `CommissionConfig` → `schema.prisma:L12501`
- `CommissionMilestone` → `schema.prisma:L12651`
- `CommissionOverride` → `schema.prisma:L12578`
- `CommissionPayout` → `schema.prisma:L12862`
- `CommissionSummary` → `schema.prisma:L12801`
- `CommissionTier` → `schema.prisma:L12615`
- `ConsentEvent` → `schema.prisma:L7385`
- `Consumer` → `schema.prisma:L7615`
- `ConsumerAuthAccount` → `schema.prisma:L7640`
- `CouponCode` → `schema.prisma:L8587`
- `CouponRedemption` → `schema.prisma:L8618`
- `CreditAssessmentHistory` → `schema.prisma:L10931`
- `CreditItemBalance` → `schema.prisma:L14580`
- `CreditOffer` → `schema.prisma:L10950`
- `CreditPack` → `schema.prisma:L14489`
- `CreditPackItem` → `schema.prisma:L14518`
- `CreditPackPurchase` → `schema.prisma:L14535`
- `CreditTransaction` → `schema.prisma:L14602`
- `Customer` → `schema.prisma:L7243`
- `CustomerApprovalDelivery` → `schema.prisma:L9599`
- `CustomerApprovalOutbox` → `schema.prisma:L9574`
- `CustomerCampaign` → `schema.prisma:L7473`
- `CustomerCampaignDelivery` → `schema.prisma:L7555`
- `CustomerCaptureToken` → `schema.prisma:L7421`
- `CustomerDiscount` → `schema.prisma:L8638`
- `CustomerGroup` → `schema.prisma:L7679`
- `CustomerOrderMetric` → `schema.prisma:L4010`
- `CustomerTaxProfile` → `schema.prisma:L16473`
- `DeliveryActivationRequest` → `schema.prisma:L6486`
- `DeliveryChannelLink` → `schema.prisma:L6325`
- `DeliveryConnectIntent` → `schema.prisma:L6437`
- `DeliveryLineAction` → `schema.prisma:L6398`
- `DeliveryOrderEvent` → `schema.prisma:L6510`
- `DeliveryStoreRevocation` → `schema.prisma:L6474`
- `DeviceToken` → `schema.prisma:L8907`
- `DigitalReceipt` → `schema.prisma:L4593`
- `Discount` → `schema.prisma:L8277`
- `EcommerceMerchant` → `schema.prisma:L5839`
- `EmailQuotaLedger` → `schema.prisma:L7602`
- `EmailSuppression` → `schema.prisma:L7590`
- `EmailTemplate` → `schema.prisma:L13254`
- `Employee` → `schema.prisma:L16988`
- `Estimate` → `schema.prisma:L14899`
- `EstimateItem` → `schema.prisma:L14927`
- `Expense` → `schema.prisma:L16775`
- `ExternalBusyBlock` → `schema.prisma:L14257`
- `Feature` → `schema.prisma:L4722`
- `FeeSchedule` → `schema.prisma:L4846`
- `FeeTier` → `schema.prisma:L4857`
- `FinancialAccount` → `schema.prisma:L15089`
- `FinancialConnection` → `schema.prisma:L15058`
- `FinancialProvider` → `schema.prisma:L15044`
- `FiscalEmisor` → `schema.prisma:L16310`
- `FiscalLossCarryforward` → `schema.prisma:L16898`
- `FixedAsset` → `schema.prisma:L16916`
- `FixedAssetDepreciation` → `schema.prisma:L16945`
- `FloorElement` → `schema.prisma:L3298`
- `FulfillmentArea` → `schema.prisma:L15370`
- `GeofenceRule` → `schema.prisma:L10522`
- `GoogleCalendarChannel` → `schema.prisma:L14234`
- `GoogleCalendarConnection` → `schema.prisma:L14186`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14287`
- `GoogleOAuthSession` → `schema.prisma:L14309`
- `HolidayCalendar` → `schema.prisma:L7126`
- `IdempotencyRequest` → `schema.prisma:L12376`
- `InterVenueTransfer` → `schema.prisma:L3050`
- `InterVenueTransferAllocation` → `schema.prisma:L3133`
- `InterVenueTransferItem` → `schema.prisma:L3102`
- `InterVenueTransferReceipt` → `schema.prisma:L3160`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3176`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3204`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3188`
- `Inventory` → `schema.prisma:L1994`
- `InventoryMovement` → `schema.prisma:L2094`
- `InventoryPosting` → `schema.prisma:L2189`
- `InventoryPostingLine` → `schema.prisma:L2229`
- `InventoryTransfer` → `schema.prisma:L14871`
- `InventoryWasteReport` → `schema.prisma:L2049`
- `Invitation` → `schema.prisma:L1494`
- `Invoice` → `schema.prisma:L4869`
- `InvoiceItem` → `schema.prisma:L4895`
- `ItemCategory` → `schema.prisma:L12089`
- `JournalEntry` → `schema.prisma:L16685`
- `JournalLine` → `schema.prisma:L16713`
- `KdsOrder` → `schema.prisma:L15137`
- `KdsOrderItem` → `schema.prisma:L15186`
- `KioskCheckInAttempt` → `schema.prisma:L17646`
- `KioskCheckInChallenge` → `schema.prisma:L17600`
- `KioskOutreachOutbox` → `schema.prisma:L17667`
- `LaunchCampaign` → `schema.prisma:L18005`
- `LaunchCampaignRedemption` → `schema.prisma:L18122`
- `LearnedPatterns` → `schema.prisma:L10007`
- `LedgerAccount` → `schema.prisma:L16577`
- `LiveDemoSession` → `schema.prisma:L830`
- `LowStockAlert` → `schema.prisma:L2884`
- `LoyaltyConfig` → `schema.prisma:L7709`
- `LoyaltyTransaction` → `schema.prisma:L7752`
- `MarketingCampaign` → `schema.prisma:L13272`
- `McpAuthCode` → `schema.prisma:L16193`
- `McpOAuthClient` → `schema.prisma:L16177`
- `McpRefreshToken` → `schema.prisma:L16211`
- `McpToolCall` → `schema.prisma:L16232`
- `MeasurementUnit` → `schema.prisma:L14977`
- `Menu` → `schema.prisma:L1712`
- `MenuCategory` → `schema.prisma:L1649`
- `MenuCategoryAssignment` → `schema.prisma:L1747`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16107`
- `MerchantAccount` → `schema.prisma:L5577`
- `MerchantFiscalConfig` → `schema.prisma:L16365`
- `MerchantRevenueShare` → `schema.prisma:L6706`
- `MerchantRoutingRule` → `schema.prisma:L5699`
- `MilestoneAchievement` → `schema.prisma:L12696`
- `Modifier` → `schema.prisma:L4199`
- `ModifierGroup` → `schema.prisma:L4163`
- `Module` → `schema.prisma:L10998`
- `MoneyAnomaly` → `schema.prisma:L6609`
- `MonthlyVenueProfit` → `schema.prisma:L7152`
- `Notification` → `schema.prisma:L8809`
- `NotificationPreference` → `schema.prisma:L8856`
- `NotificationTemplate` → `schema.prisma:L8883`
- `OAuthState` → `schema.prisma:L1545`
- `OnboardingProgress` → `schema.prisma:L1563`
- `Order` → `schema.prisma:L3747`
- `OrderAction` → `schema.prisma:L4266`
- `OrderCustomer` → `schema.prisma:L3989`
- `OrderDiscount` → `schema.prisma:L8670`
- `OrderFulfillment` → `schema.prisma:L15425`
- `OrderFulfillmentLine` → `schema.prisma:L15456`
- `OrderItem` → `schema.prisma:L4025`
- `OrderItemModifier` → `schema.prisma:L4248`
- `OrderPromotion` → `schema.prisma:L17563`
- `OrderServiceCharge` → `schema.prisma:L8754`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13073`
- `OrganizationEntitlement` → `schema.prisma:L11281`
- `OrganizationGoal` → `schema.prisma:L13031`
- `OrganizationModule` → `schema.prisma:L11058`
- `OrganizationPaymentConfig` → `schema.prisma:L6151`
- `OrganizationPayoutConfig` → `schema.prisma:L13106`
- `OrganizationPricingStructure` → `schema.prisma:L6183`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13054`
- `OtpChallenge` → `schema.prisma:L7659`
- `OvertimeApproval` → `schema.prisma:L3525`
- `PartnerAPIKey` → `schema.prisma:L5981`
- `Payment` → `schema.prisma:L4299`
- `PaymentAllocation` → `schema.prisma:L4572`
- `PaymentEffect` → `schema.prisma:L17937`
- `PaymentLink` → `schema.prisma:L14648`
- `PaymentLinkAttribution` → `schema.prisma:L14756`
- `PaymentLinkItem` → `schema.prisma:L14711`
- `PaymentLinkItemModifier` → `schema.prisma:L14738`
- `PaymentProvider` → `schema.prisma:L5536`
- `PayrollLine` → `schema.prisma:L17059`
- `PayrollRun` → `schema.prisma:L17028`
- `PerformanceGoal` → `schema.prisma:L13008`
- `PermissionOverride` → `schema.prisma:L1418`
- `PermissionSet` → `schema.prisma:L1441`
- `PlatformAnnouncement` → `schema.prisma:L17727`
- `PlatformAnnouncementClick` → `schema.prisma:L17792`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17829`
- `PlatformCfdi` → `schema.prisma:L17356`
- `PlatformEmisor` → `schema.prisma:L17296`
- `PlatformSettings` → `schema.prisma:L5958`
- `PosCommand` → `schema.prisma:L8937`
- `PosConnectionStatus` → `schema.prisma:L964`
- `PosSyncIntent` → `schema.prisma:L17434`
- `PricingPolicy` → `schema.prisma:L2780`
- `Printer` → `schema.prisma:L15235`
- `PrintGateway` → `schema.prisma:L15292`
- `PrintJob` → `schema.prisma:L16006`
- `PrintStation` → `schema.prisma:L15310`
- `PrivacyNoticeVersion` → `schema.prisma:L7407`
- `ProcessedStripeEvent` → `schema.prisma:L6595`
- `ProcessorReliabilityMetric` → `schema.prisma:L7080`
- `Product` → `schema.prisma:L1765`
- `ProductModifierGroup` → `schema.prisma:L4236`
- `ProductOption` → `schema.prisma:L14954`
- `ProductOptionValue` → `schema.prisma:L14965`
- `ProductStaff` → `schema.prisma:L13883`
- `PromoterBankAccount` → `schema.prisma:L17179`
- `PromoterCommissionEntry` → `schema.prisma:L17198`
- `PromoterLocationPing` → `schema.prisma:L3713`
- `Promotion` → `schema.prisma:L17485`
- `PromotionGroup` → `schema.prisma:L17524`
- `PromotionOption` → `schema.prisma:L17540`
- `ProviderCostStructure` → `schema.prisma:L6631`
- `ProviderEventLog` → `schema.prisma:L6260`
- `PurchaseOrder` → `schema.prisma:L2505`
- `PurchaseOrderInvoice` → `schema.prisma:L2650`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2707`
- `PurchaseOrderItem` → `schema.prisma:L2563`
- `RateCorrectionBatch` → `schema.prisma:L6856`
- `RateCorrectionEntry` → `schema.prisma:L6898`
- `RawMaterial` → `schema.prisma:L2261`
- `RawMaterialMovement` → `schema.prisma:L2833`
- `RawMaterialPresentation` → `schema.prisma:L2337`
- `ReceiptLayout` → `schema.prisma:L17971`
- `Recipe` → `schema.prisma:L2357`
- `RecipeLine` → `schema.prisma:L2381`
- `Referral` → `schema.prisma:L8125`
- `ReferralProgramConfig` → `schema.prisma:L8090`
- `ReferralRewardGrant` → `schema.prisma:L8216`
- `ReferralTierReward` → `schema.prisma:L8188`
- `ReferralTierUnlock` → `schema.prisma:L8261`
- `RefreshGrant` → `schema.prisma:L17916`
- `Reservation` → `schema.prisma:L13651`
- `ReservationGoogleEventMapping` → `schema.prisma:L14421`
- `ReservationModifier` → `schema.prisma:L13831`
- `ReservationReminderSent` → `schema.prisma:L13814`
- `ReservationSettings` → `schema.prisma:L14045`
- `ReservationWaitlistEntry` → `schema.prisma:L14013`
- `Review` → `schema.prisma:L4913`
- `SalesRetention` → `schema.prisma:L16879`
- `SaleVerification` → `schema.prisma:L4626`
- `ScaleProfile` → `schema.prisma:L15747`
- `ScheduledCommand` → `schema.prisma:L10482`
- `SerializedItem` → `schema.prisma:L12132`
- `SerializedItemCustodyEvent` → `schema.prisma:L12299`
- `ServiceCharge` → `schema.prisma:L8725`
- `Session` → `schema.prisma:L17895`
- `SettlementConfiguration` → `schema.prisma:L6931`
- `SettlementConfirmation` → `schema.prisma:L7044`
- `SettlementIncident` → `schema.prisma:L6995`
- `SettlementSimulation` → `schema.prisma:L6966`
- `Shift` → `schema.prisma:L3336`
- `SimRegistrationRequest` → `schema.prisma:L12337`
- `SimRegistrationRequestItem` → `schema.prisma:L12359`
- `SlotHold` → `schema.prisma:L13914`
- `Staff` → `schema.prisma:L984`
- `StaffDocument` → `schema.prisma:L3584`
- `StaffOnboardingState` → `schema.prisma:L16077`
- `StaffOrganization` → `schema.prisma:L1317`
- `StaffPasskey` → `schema.prisma:L1344`
- `StaffSchedule` → `schema.prisma:L13854`
- `StaffScheduleException` → `schema.prisma:L13866`
- `StaffVenue` → `schema.prisma:L1241`
- `StaffWorkSchedule` → `schema.prisma:L3461`
- `StaffWorkScheduleException` → `schema.prisma:L3559`
- `StampCard` → `schema.prisma:L7973`
- `StampEvent` → `schema.prisma:L8012`
- `StampReward` → `schema.prisma:L8050`
- `StockAlertConfig` → `schema.prisma:L12990`
- `StockBatch` → `schema.prisma:L2999`
- `StockCount` → `schema.prisma:L2916`
- `StockCountItem` → `schema.prisma:L2944`
- `StripeWebhookEvent` → `schema.prisma:L6578`
- `Supplier` → `schema.prisma:L2416`
- `SupplierItemCode` → `schema.prisma:L2748`
- `SupplierPricing` → `schema.prisma:L2471`
- `Table` → `schema.prisma:L3248`
- `Terminal` → `schema.prisma:L4964`
- `TerminalAttemptResolution` → `schema.prisma:L5395`
- `TerminalHealth` → `schema.prisma:L5215`
- `TerminalLog` → `schema.prisma:L5189`
- `TerminalOrder` → `schema.prisma:L5439`
- `TerminalOrderItem` → `schema.prisma:L5514`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5367`
- `TerminalPaymentRequest` → `schema.prisma:L5286`
- `TimeEntry` → `schema.prisma:L3626`
- `TimeEntryBreak` → `schema.prisma:L3695`
- `TokenPurchase` → `schema.prisma:L10156`
- `TokenUsageRecord` → `schema.prisma:L10128`
- `TpvCommandHistory` → `schema.prisma:L10388`
- `TpvCommandQueue` → `schema.prisma:L10328`
- `TpvFeedback` → `schema.prisma:L10041`
- `TpvMessage` → `schema.prisma:L13347`
- `TpvMessageDelivery` → `schema.prisma:L13399`
- `TpvMessageResponse` → `schema.prisma:L13422`
- `TrainingModule` → `schema.prisma:L13477`
- `TrainingProgress` → `schema.prisma:L13554`
- `TrainingQuizQuestion` → `schema.prisma:L13536`
- `TrainingStep` → `schema.prisma:L13516`
- `TransactionCost` → `schema.prisma:L6794`
- `UnitConversion` → `schema.prisma:L2811`
- `UpsellAcceptance` → `schema.prisma:L8546`
- `UpsellAiRun` → `schema.prisma:L8566`
- `UpsellImpression` → `schema.prisma:L8506`
- `UpsellRule` → `schema.prisma:L8426`
- `user_sessions` → `schema.prisma:L6016`
- `Venue` → `schema.prisma:L167`
- `VenueAreaTicketSettings` → `schema.prisma:L15484`
- `VenueChatMessage` → `schema.prisma:L806`
- `VenueChatSession` → `schema.prisma:L761`
- `VenueCommission` → `schema.prisma:L15115`
- `VenueCreditAssessment` → `schema.prisma:L10870`
- `VenueCryptoConfig` → `schema.prisma:L13214`
- `VenueFeature` → `schema.prisma:L4740`
- `VenueIvaPorProducto` → `schema.prisma:L957`
- `VenueModule` → `schema.prisma:L11030`
- `VenuePaymentConfig` → `schema.prisma:L6117`
- `VenuePaymentLinkSettings` → `schema.prisma:L14454`
- `VenuePricingStructure` → `schema.prisma:L6734`
- `VenueRoleConfig` → `schema.prisma:L1470`
- `VenueRolePermission` → `schema.prisma:L1374`
- `VenueScaleSettings` → `schema.prisma:L15735`
- `VenueSettings` → `schema.prisma:L846`
- `VenueTenderType` → `schema.prisma:L4485`
- `VenueTenderTypeRevision` → `schema.prisma:L4550`
- `VenueTransaction` → `schema.prisma:L4677`
- `VenueWhatsappActivation` → `schema.prisma:L697`
- `WalletCardDesign` → `schema.prisma:L7891`
- `WalletPass` → `schema.prisma:L7792`
- `WalletPassRegistration` → `schema.prisma:L7858`
- `WebhookEvent` → `schema.prisma:L4822`
- `WebhookSubscription` → `schema.prisma:L6233`
- `WhatsappContactWindow` → `schema.prisma:L715`
- `WhatsappInboundEvent` → `schema.prisma:L735`
- `WorkShiftAssignment` → `schema.prisma:L3501`
- `WorkShiftTemplate` → `schema.prisma:L3478`
- `Zone` → `schema.prisma:L150`
