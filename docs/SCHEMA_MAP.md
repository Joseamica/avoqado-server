# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **402 models / 380 enums / ~18,500 lines**. Nobody reads it top to bottom. This file is the **index**: 23 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 23 domains

| #   | Domain                                  | What it is                                                                                                         | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                                  | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                                  | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                              | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                    | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                          | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.        | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 7   | **Commercial Platform**                 | Avoqado SaaS catalog, campaigns, acquisition claims, quotes, Stripe lifecycle, activation, and publication outbox. | `CommercialAccountReceivable`, `CommercialAcquisitionContext`, `CommercialAcquisitionContextBinding`, `CommercialAcquisitionRedemption`, `CommercialBillingAllocation`, `CommercialBillingPaymentAttempt`, `CommercialBillingProviderObject`, `CommercialBundleDraft`, `CommercialBundleItemDraft`, `CommercialCampaignActivation`, `CommercialCampaignClaim`, `CommercialCampaignDraft`, `CommercialCampaignRuleDraft`, `CommercialCampaignVersion`, `CommercialCashReceipt`, `CommercialDraft`, `CommercialEntitlementProjection`, `CommercialEventOutbox`, `CommercialFeatureBindingDraft`, `CommercialManualSpeiApproval`, `CommercialManualSpeiCase`, `CommercialManualSpeiEvidence`, `CommercialManualSpeiEvidenceReview`, `CommercialManualSpeiPolicyActivation`, `CommercialManualSpeiPolicyVersion`, `CommercialOfferBenefitDraft`, `CommercialOfferControlEvent`, `CommercialPricebookDraft`, `CommercialPriceDraft`, `CommercialProductDraft`, `CommercialPublication`, `CommercialPublicationActivation`, `CommercialPublicationOutbox`, `CommercialQuote`, `CommercialQuoteAcceptance`, `CommercialQuotePreviewBridge`, `CommercialStripeOperation`, `CommercialSubscriptionContract`, `CommercialSubscriptionEvent`, `CommercialSubscriptionPeriod`, `StripeCheckoutOrigin` |
| 8   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                                   | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 9   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                           | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 10  | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                     | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 11  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                                  | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 12  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                                  | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 13  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                       | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 14  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles.     | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 15  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                                   | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 16  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                                | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 17  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                         | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 18  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                                  | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 19  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                         | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 20  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                           | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 21  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                     | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 22  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                       | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerGroup`, `CustomerOrderMetric`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 23  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                       | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `StripeObjectBinding`, `WebhookDispatchObservation`, `WebhookEvent`, `WebhookManualRetryResultOutbox`, `WebhookOperationalAlert`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L17391`
- `AccountMapping` → `schema.prisma:L17287`
- `ActivityLog` → `schema.prisma:L6790`
- `Aggregator` → `schema.prisma:L15684`
- `AngelPayUserAccount` → `schema.prisma:L5453`
- `AppUpdate` → `schema.prisma:L13864`
- `Area` → `schema.prisma:L3074`
- `AreaTicket` → `schema.prisma:L16182`
- `AreaTicketCheckoutSession` → `schema.prisma:L16304`
- `AreaTicketExternalIncident` → `schema.prisma:L16551`
- `AreaTicketExternalSettlement` → `schema.prisma:L16516`
- `AreaTicketFulfillment` → `schema.prisma:L16380`
- `AreaTicketInventoryReservation` → `schema.prisma:L16275`
- `AreaTicketLine` → `schema.prisma:L16243`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16336`
- `AreaTicketPrintAttempt` → `schema.prisma:L16359`
- `BankStatement` → `schema.prisma:L17161`
- `BankStatementLine` → `schema.prisma:L17182`
- `BillingTaxProfile` → `schema.prisma:L17971`
- `BulkCommandOperation` → `schema.prisma:L9786`
- `CalendarSyncOutbox` → `schema.prisma:L15071`
- `CampaignDelivery` → `schema.prisma:L14022`
- `CashCloseout` → `schema.prisma:L10171`
- `CashDeposit` → `schema.prisma:L13666`
- `CashDrawerEvent` → `schema.prisma:L15521`
- `CashDrawerSession` → `schema.prisma:L15497`
- `CashOutCommissionRate` → `schema.prisma:L17800`
- `CashOutScheduleDay` → `schema.prisma:L17823`
- `CashOutWithdrawal` → `schema.prisma:L17885`
- `CatalogBindingBatch` → `schema.prisma:L11202`
- `CatalogBindingLine` → `schema.prisma:L11238`
- `CatalogBrand` → `schema.prisma:L10655`
- `CatalogClientObservation` → `schema.prisma:L10968`
- `CatalogClientReadinessOverride` → `schema.prisma:L10987`
- `CatalogFamily` → `schema.prisma:L10705`
- `CatalogIdempotencyRecord` → `schema.prisma:L11101`
- `CatalogIdentifier` → `schema.prisma:L10836`
- `CatalogImportBatch` → `schema.prisma:L11144`
- `CatalogImportLine` → `schema.prisma:L11181`
- `CatalogItem` → `schema.prisma:L10738`
- `CatalogItemBusinessType` → `schema.prisma:L10798`
- `CatalogItemPrice` → `schema.prisma:L10886`
- `CatalogManufacturer` → `schema.prisma:L10679`
- `CatalogProductTypeMapping` → `schema.prisma:L10815`
- `CatalogPublicationBatch` → `schema.prisma:L11266`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11360`
- `CatalogPublicationLine` → `schema.prisma:L11307`
- `CatalogPublicationOutbox` → `schema.prisma:L11403`
- `CatalogValidationProfile` → `schema.prisma:L10857`
- `CatalogVenueBinding` → `schema.prisma:L11015`
- `CatalogVenueClientRequirement` → `schema.prisma:L10942`
- `CatalogVenueEventSequence` → `schema.prisma:L11386`
- `CatalogVenueOverride` → `schema.prisma:L11057`
- `CatalogVenueRollout` → `schema.prisma:L10917`
- `Cfdi` → `schema.prisma:L17064`
- `ChatbotTokenBudget` → `schema.prisma:L9433`
- `ChatConversation` → `schema.prisma:L9288`
- `ChatFeedback` → `schema.prisma:L9374`
- `ChatLearningEvent` → `schema.prisma:L9331`
- `ChatMessage` → `schema.prisma:L9311`
- `ChatTrainingData` → `schema.prisma:L9245`
- `CheckoutSession` → `schema.prisma:L5733`
- `ClassSession` → `schema.prisma:L14675`
- `CommercialAccountReceivable` → `schema.prisma:L12335`
- `CommercialAcquisitionContext` → `schema.prisma:L12092`
- `CommercialAcquisitionContextBinding` → `schema.prisma:L12119`
- `CommercialAcquisitionRedemption` → `schema.prisma:L12240`
- `CommercialBillingAllocation` → `schema.prisma:L12445`
- `CommercialBillingPaymentAttempt` → `schema.prisma:L12363`
- `CommercialBillingProviderObject` → `schema.prisma:L12425`
- `CommercialBundleDraft` → `schema.prisma:L11773`
- `CommercialBundleItemDraft` → `schema.prisma:L11823`
- `CommercialCampaignActivation` → `schema.prisma:L12048`
- `CommercialCampaignClaim` → `schema.prisma:L12067`
- `CommercialCampaignDraft` → `schema.prisma:L11928`
- `CommercialCampaignRuleDraft` → `schema.prisma:L11955`
- `CommercialCampaignVersion` → `schema.prisma:L11999`
- `CommercialCashReceipt` → `schema.prisma:L12387`
- `CommercialDraft` → `schema.prisma:L11703`
- `CommercialEntitlementProjection` → `schema.prisma:L12523`
- `CommercialEventOutbox` → `schema.prisma:L12490`
- `CommercialFeatureBindingDraft` → `schema.prisma:L11841`
- `CommercialManualSpeiApproval` → `schema.prisma:L12660`
- `CommercialManualSpeiCase` → `schema.prisma:L12586`
- `CommercialManualSpeiEvidence` → `schema.prisma:L12625`
- `CommercialManualSpeiEvidenceReview` → `schema.prisma:L12644`
- `CommercialManualSpeiPolicyActivation` → `schema.prisma:L12572`
- `CommercialManualSpeiPolicyVersion` → `schema.prisma:L12551`
- `CommercialOfferBenefitDraft` → `schema.prisma:L11975`
- `CommercialOfferControlEvent` → `schema.prisma:L12031`
- `CommercialPricebookDraft` → `schema.prisma:L11754`
- `CommercialPriceDraft` → `schema.prisma:L11795`
- `CommercialProductDraft` → `schema.prisma:L11728`
- `CommercialPublication` → `schema.prisma:L11858`
- `CommercialPublicationActivation` → `schema.prisma:L11885`
- `CommercialPublicationOutbox` → `schema.prisma:L11900`
- `CommercialQuote` → `schema.prisma:L12139`
- `CommercialQuoteAcceptance` → `schema.prisma:L12211`
- `CommercialQuotePreviewBridge` → `schema.prisma:L12187`
- `CommercialStripeOperation` → `schema.prisma:L12260`
- `CommercialSubscriptionContract` → `schema.prisma:L12304`
- `CommercialSubscriptionEvent` → `schema.prisma:L12284`
- `CommercialSubscriptionPeriod` → `schema.prisma:L12460`
- `CommissionCalculation` → `schema.prisma:L13442`
- `CommissionClawback` → `schema.prisma:L13618`
- `CommissionConfig` → `schema.prisma:L13208`
- `CommissionMilestone` → `schema.prisma:L13358`
- `CommissionOverride` → `schema.prisma:L13285`
- `CommissionPayout` → `schema.prisma:L13569`
- `CommissionSummary` → `schema.prisma:L13508`
- `CommissionTier` → `schema.prisma:L13322`
- `Consumer` → `schema.prisma:L6955`
- `ConsumerAuthAccount` → `schema.prisma:L6980`
- `CouponCode` → `schema.prisma:L7919`
- `CouponRedemption` → `schema.prisma:L7950`
- `CreditAssessmentHistory` → `schema.prisma:L10280`
- `CreditItemBalance` → `schema.prisma:L15287`
- `CreditOffer` → `schema.prisma:L10299`
- `CreditPack` → `schema.prisma:L15196`
- `CreditPackItem` → `schema.prisma:L15225`
- `CreditPackPurchase` → `schema.prisma:L15242`
- `CreditTransaction` → `schema.prisma:L15309`
- `Customer` → `schema.prisma:L6833`
- `CustomerApprovalDelivery` → `schema.prisma:L8947`
- `CustomerApprovalOutbox` → `schema.prisma:L8922`
- `CustomerDiscount` → `schema.prisma:L7970`
- `CustomerGroup` → `schema.prisma:L7019`
- `CustomerOrderMetric` → `schema.prisma:L3826`
- `CustomerTaxProfile` → `schema.prisma:L17133`
- `DeliveryActivationRequest` → `schema.prisma:L6074`
- `DeliveryChannelLink` → `schema.prisma:L6019`
- `DeliveryOrderEvent` → `schema.prisma:L6098`
- `DeviceToken` → `schema.prisma:L8239`
- `DigitalReceipt` → `schema.prisma:L4397`
- `Discount` → `schema.prisma:L7609`
- `EcommerceMerchant` → `schema.prisma:L5545`
- `EmailTemplate` → `schema.prisma:L13961`
- `Employee` → `schema.prisma:L17648`
- `Estimate` → `schema.prisma:L15591`
- `EstimateItem` → `schema.prisma:L15619`
- `Expense` → `schema.prisma:L17435`
- `ExternalBusyBlock` → `schema.prisma:L14964`
- `Feature` → `schema.prisma:L4526`
- `FeeSchedule` → `schema.prisma:L4641`
- `FeeTier` → `schema.prisma:L4652`
- `FinancialAccount` → `schema.prisma:L15781`
- `FinancialConnection` → `schema.prisma:L15750`
- `FinancialProvider` → `schema.prisma:L15736`
- `FiscalEmisor` → `schema.prisma:L16987`
- `FiscalLossCarryforward` → `schema.prisma:L17558`
- `FixedAsset` → `schema.prisma:L17576`
- `FixedAssetDepreciation` → `schema.prisma:L17605`
- `FloorElement` → `schema.prisma:L3150`
- `FulfillmentArea` → `schema.prisma:L16047`
- `GeofenceRule` → `schema.prisma:L9871`
- `GoogleCalendarChannel` → `schema.prisma:L14941`
- `GoogleCalendarConnection` → `schema.prisma:L14893`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14994`
- `GoogleOAuthSession` → `schema.prisma:L15016`
- `HolidayCalendar` → `schema.prisma:L6714`
- `IdempotencyRequest` → `schema.prisma:L13083`
- `InterVenueTransfer` → `schema.prisma:L2902`
- `InterVenueTransferAllocation` → `schema.prisma:L2985`
- `InterVenueTransferItem` → `schema.prisma:L2954`
- `InterVenueTransferReceipt` → `schema.prisma:L3012`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3028`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3056`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3040`
- `Inventory` → `schema.prisma:L1948`
- `InventoryMovement` → `schema.prisma:L1975`
- `InventoryPosting` → `schema.prisma:L2057`
- `InventoryPostingLine` → `schema.prisma:L2097`
- `InventoryTransfer` → `schema.prisma:L15563`
- `Invitation` → `schema.prisma:L1486`
- `Invoice` → `schema.prisma:L4664`
- `InvoiceItem` → `schema.prisma:L4690`
- `ItemCategory` → `schema.prisma:L12796`
- `JournalEntry` → `schema.prisma:L17345`
- `JournalLine` → `schema.prisma:L17373`
- `KdsOrder` → `schema.prisma:L15829`
- `KdsOrderItem` → `schema.prisma:L15870`
- `KioskCheckInAttempt` → `schema.prisma:L18294`
- `KioskCheckInChallenge` → `schema.prisma:L18248`
- `KioskOutreachOutbox` → `schema.prisma:L18315`
- `LearnedPatterns` → `schema.prisma:L9355`
- `LedgerAccount` → `schema.prisma:L17237`
- `LiveDemoSession` → `schema.prisma:L807`
- `LowStockAlert` → `schema.prisma:L2743`
- `LoyaltyConfig` → `schema.prisma:L7049`
- `LoyaltyTransaction` → `schema.prisma:L7092`
- `MarketingCampaign` → `schema.prisma:L13979`
- `McpAuthCode` → `schema.prisma:L16870`
- `McpOAuthClient` → `schema.prisma:L16854`
- `McpRefreshToken` → `schema.prisma:L16888`
- `McpToolCall` → `schema.prisma:L16909`
- `MeasurementUnit` → `schema.prisma:L15669`
- `Menu` → `schema.prisma:L1672`
- `MenuCategory` → `schema.prisma:L1609`
- `MenuCategoryAssignment` → `schema.prisma:L1707`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16784`
- `MerchantAccount` → `schema.prisma:L5283`
- `MerchantFiscalConfig` → `schema.prisma:L17035`
- `MerchantRevenueShare` → `schema.prisma:L6294`
- `MerchantRoutingRule` → `schema.prisma:L5405`
- `MilestoneAchievement` → `schema.prisma:L13403`
- `Modifier` → `schema.prisma:L4010`
- `ModifierGroup` → `schema.prisma:L3974`
- `Module` → `schema.prisma:L10347`
- `MoneyAnomaly` → `schema.prisma:L6197`
- `MonthlyVenueProfit` → `schema.prisma:L6740`
- `Notification` → `schema.prisma:L8141`
- `NotificationPreference` → `schema.prisma:L8188`
- `NotificationTemplate` → `schema.prisma:L8215`
- `OAuthState` → `schema.prisma:L1537`
- `OnboardingProgress` → `schema.prisma:L1555`
- `Order` → `schema.prisma:L3581`
- `OrderAction` → `schema.prisma:L4077`
- `OrderCustomer` → `schema.prisma:L3805`
- `OrderDiscount` → `schema.prisma:L8002`
- `OrderFulfillment` → `schema.prisma:L16102`
- `OrderFulfillmentLine` → `schema.prisma:L16133`
- `OrderItem` → `schema.prisma:L3841`
- `OrderItemModifier` → `schema.prisma:L4059`
- `OrderPromotion` → `schema.prisma:L18211`
- `OrderServiceCharge` → `schema.prisma:L8086`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13780`
- `OrganizationEntitlement` → `schema.prisma:L10630`
- `OrganizationGoal` → `schema.prisma:L13738`
- `OrganizationModule` → `schema.prisma:L10407`
- `OrganizationPaymentConfig` → `schema.prisma:L5857`
- `OrganizationPayoutConfig` → `schema.prisma:L13813`
- `OrganizationPricingStructure` → `schema.prisma:L5889`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13761`
- `OtpChallenge` → `schema.prisma:L6999`
- `OvertimeApproval` → `schema.prisma:L3359`
- `PartnerAPIKey` → `schema.prisma:L5687`
- `Payment` → `schema.prisma:L4110`
- `PaymentAllocation` → `schema.prisma:L4376`
- `PaymentLink` → `schema.prisma:L15355`
- `PaymentLinkAttribution` → `schema.prisma:L15463`
- `PaymentLinkItem` → `schema.prisma:L15418`
- `PaymentLinkItemModifier` → `schema.prisma:L15445`
- `PaymentProvider` → `schema.prisma:L5242`
- `PayrollLine` → `schema.prisma:L17719`
- `PayrollRun` → `schema.prisma:L17688`
- `PerformanceGoal` → `schema.prisma:L13715`
- `PermissionOverride` → `schema.prisma:L1410`
- `PermissionSet` → `schema.prisma:L1433`
- `PlatformAnnouncement` → `schema.prisma:L18375`
- `PlatformAnnouncementClick` → `schema.prisma:L18440`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18477`
- `PlatformCfdi` → `schema.prisma:L18004`
- `PlatformEmisor` → `schema.prisma:L17944`
- `PlatformSettings` → `schema.prisma:L5664`
- `PosCommand` → `schema.prisma:L8269`
- `PosConnectionStatus` → `schema.prisma:L933`
- `PosSyncIntent` → `schema.prisma:L18082`
- `PricingPolicy` → `schema.prisma:L2647`
- `Printer` → `schema.prisma:L15912`
- `PrintGateway` → `schema.prisma:L15969`
- `PrintJob` → `schema.prisma:L16683`
- `PrintStation` → `schema.prisma:L15987`
- `ProcessedStripeEvent` → `schema.prisma:L6183`
- `ProcessorReliabilityMetric` → `schema.prisma:L6668`
- `Product` → `schema.prisma:L1725`
- `ProductModifierGroup` → `schema.prisma:L4047`
- `ProductOption` → `schema.prisma:L15646`
- `ProductOptionValue` → `schema.prisma:L15657`
- `ProductStaff` → `schema.prisma:L14590`
- `PromoterBankAccount` → `schema.prisma:L17839`
- `PromoterCommissionEntry` → `schema.prisma:L17858`
- `PromoterLocationPing` → `schema.prisma:L3547`
- `Promotion` → `schema.prisma:L18133`
- `PromotionGroup` → `schema.prisma:L18172`
- `PromotionOption` → `schema.prisma:L18188`
- `ProviderCostStructure` → `schema.prisma:L6219`
- `ProviderEventLog` → `schema.prisma:L5966`
- `PurchaseOrder` → `schema.prisma:L2372`
- `PurchaseOrderInvoice` → `schema.prisma:L2517`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2574`
- `PurchaseOrderItem` → `schema.prisma:L2430`
- `RateCorrectionBatch` → `schema.prisma:L6444`
- `RateCorrectionEntry` → `schema.prisma:L6486`
- `RawMaterial` → `schema.prisma:L2129`
- `RawMaterialMovement` → `schema.prisma:L2700`
- `RawMaterialPresentation` → `schema.prisma:L2204`
- `Recipe` → `schema.prisma:L2224`
- `RecipeLine` → `schema.prisma:L2248`
- `Referral` → `schema.prisma:L7457`
- `ReferralProgramConfig` → `schema.prisma:L7422`
- `ReferralRewardGrant` → `schema.prisma:L7548`
- `ReferralTierReward` → `schema.prisma:L7520`
- `ReferralTierUnlock` → `schema.prisma:L7593`
- `RefreshGrant` → `schema.prisma:L18564`
- `Reservation` → `schema.prisma:L14358`
- `ReservationGoogleEventMapping` → `schema.prisma:L15128`
- `ReservationModifier` → `schema.prisma:L14538`
- `ReservationReminderSent` → `schema.prisma:L14521`
- `ReservationSettings` → `schema.prisma:L14752`
- `ReservationWaitlistEntry` → `schema.prisma:L14720`
- `Review` → `schema.prisma:L4708`
- `SalesRetention` → `schema.prisma:L17539`
- `SaleVerification` → `schema.prisma:L4430`
- `ScaleProfile` → `schema.prisma:L16424`
- `ScheduledCommand` → `schema.prisma:L9831`
- `SerializedItem` → `schema.prisma:L12839`
- `SerializedItemCustodyEvent` → `schema.prisma:L13006`
- `ServiceCharge` → `schema.prisma:L8057`
- `Session` → `schema.prisma:L18543`
- `SettlementConfiguration` → `schema.prisma:L6519`
- `SettlementConfirmation` → `schema.prisma:L6632`
- `SettlementIncident` → `schema.prisma:L6583`
- `SettlementSimulation` → `schema.prisma:L6554`
- `Shift` → `schema.prisma:L3188`
- `SimRegistrationRequest` → `schema.prisma:L13044`
- `SimRegistrationRequestItem` → `schema.prisma:L13066`
- `SlotHold` → `schema.prisma:L14621`
- `Staff` → `schema.prisma:L953`
- `StaffDocument` → `schema.prisma:L3418`
- `StaffOnboardingState` → `schema.prisma:L16754`
- `StaffOrganization` → `schema.prisma:L1309`
- `StaffPasskey` → `schema.prisma:L1336`
- `StaffSchedule` → `schema.prisma:L14561`
- `StaffScheduleException` → `schema.prisma:L14573`
- `StaffVenue` → `schema.prisma:L1233`
- `StaffWorkSchedule` → `schema.prisma:L3295`
- `StaffWorkScheduleException` → `schema.prisma:L3393`
- `StampCard` → `schema.prisma:L7305`
- `StampEvent` → `schema.prisma:L7344`
- `StampReward` → `schema.prisma:L7382`
- `StockAlertConfig` → `schema.prisma:L13697`
- `StockBatch` → `schema.prisma:L2851`
- `StockCount` → `schema.prisma:L2775`
- `StockCountItem` → `schema.prisma:L2799`
- `StripeCheckoutOrigin` → `schema.prisma:L12677`
- `StripeObjectBinding` → `schema.prisma:L12696`
- `StripeWebhookEvent` → `schema.prisma:L6166`
- `Supplier` → `schema.prisma:L2283`
- `SupplierItemCode` → `schema.prisma:L2615`
- `SupplierPricing` → `schema.prisma:L2338`
- `Table` → `schema.prisma:L3100`
- `Terminal` → `schema.prisma:L4759`
- `TerminalHealth` → `schema.prisma:L5010`
- `TerminalLog` → `schema.prisma:L4984`
- `TerminalOrder` → `schema.prisma:L5143`
- `TerminalOrderItem` → `schema.prisma:L5220`
- `TerminalPaymentRequest` → `schema.prisma:L5081`
- `TimeEntry` → `schema.prisma:L3460`
- `TimeEntryBreak` → `schema.prisma:L3529`
- `TokenPurchase` → `schema.prisma:L9504`
- `TokenUsageRecord` → `schema.prisma:L9476`
- `TpvCommandHistory` → `schema.prisma:L9737`
- `TpvCommandQueue` → `schema.prisma:L9677`
- `TpvFeedback` → `schema.prisma:L9389`
- `TpvMessage` → `schema.prisma:L14054`
- `TpvMessageDelivery` → `schema.prisma:L14106`
- `TpvMessageResponse` → `schema.prisma:L14129`
- `TrainingModule` → `schema.prisma:L14184`
- `TrainingProgress` → `schema.prisma:L14261`
- `TrainingQuizQuestion` → `schema.prisma:L14243`
- `TrainingStep` → `schema.prisma:L14223`
- `TransactionCost` → `schema.prisma:L6382`
- `UnitConversion` → `schema.prisma:L2678`
- `UpsellAcceptance` → `schema.prisma:L7878`
- `UpsellAiRun` → `schema.prisma:L7898`
- `UpsellImpression` → `schema.prisma:L7838`
- `UpsellRule` → `schema.prisma:L7758`
- `user_sessions` → `schema.prisma:L5722`
- `Venue` → `schema.prisma:L170`
- `VenueAreaTicketSettings` → `schema.prisma:L16161`
- `VenueChatMessage` → `schema.prisma:L783`
- `VenueChatSession` → `schema.prisma:L738`
- `VenueCommission` → `schema.prisma:L15807`
- `VenueCreditAssessment` → `schema.prisma:L10219`
- `VenueCryptoConfig` → `schema.prisma:L13921`
- `VenueFeature` → `schema.prisma:L4545`
- `VenueModule` → `schema.prisma:L10379`
- `VenuePaymentConfig` → `schema.prisma:L5823`
- `VenuePaymentLinkSettings` → `schema.prisma:L15161`
- `VenuePricingStructure` → `schema.prisma:L6322`
- `VenueRoleConfig` → `schema.prisma:L1462`
- `VenueRolePermission` → `schema.prisma:L1366`
- `VenueScaleSettings` → `schema.prisma:L16412`
- `VenueSettings` → `schema.prisma:L823`
- `VenueTenderType` → `schema.prisma:L4289`
- `VenueTenderTypeRevision` → `schema.prisma:L4354`
- `VenueTransaction` → `schema.prisma:L4481`
- `VenueWhatsappActivation` → `schema.prisma:L674`
- `WalletCardDesign` → `schema.prisma:L7223`
- `WalletPass` → `schema.prisma:L7132`
- `WalletPassRegistration` → `schema.prisma:L7190`
- `WebhookDispatchObservation` → `schema.prisma:L12714`
- `WebhookEvent` → `schema.prisma:L4581`
- `WebhookManualRetryResultOutbox` → `schema.prisma:L12756`
- `WebhookOperationalAlert` → `schema.prisma:L12730`
- `WebhookSubscription` → `schema.prisma:L5939`
- `WhatsappContactWindow` → `schema.prisma:L692`
- `WhatsappInboundEvent` → `schema.prisma:L712`
- `WorkShiftAssignment` → `schema.prisma:L3335`
- `WorkShiftTemplate` → `schema.prisma:L3312`
- `Zone` → `schema.prisma:L153`
