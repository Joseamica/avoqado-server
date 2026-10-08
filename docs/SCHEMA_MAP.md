# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **409 models / 377 enums / ~19,100 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueIvaPorProducto`, `VenuePosSinAparato`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `CapabilityGrant`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `HybridBillingOperation`, `HybridCampaign`, `HybridContract`, `HybridContractSelection`, `HybridCreditAllocation`, `HybridOfferPublication`, `HybridPaymentPeriod`, `HybridPromotionGroup`, `HybridPurchase`, `HybridRedemption`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                               |
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
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CfdiGlobalOrden`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `OrderItemSelloIva`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                                                                                                |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `ClassSessionPayState`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `ServiceEarning`, `ServicePayPeriod`, `ServicePayTable`, `ServicePayTableCell`, `ServicePayTableVersion`, `StaffPayLevel`, `StaffPayLevelAssignment`, `StaffPayStatement`, `VenueCommission`                                                                                                                                                                                                                                                |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `AggregatorBooking`, `AggregatorCapacityRule`, `AggregatorConnection`, `AggregatorInboundEvent`, `AggregatorOutbox`, `AggregatorProductLink`, `AggregatorSessionLink`, `AggregatorVisit`, `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                 |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalAttemptResolution`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerExternalIdentity`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L17467`
- `AccountMapping` → `schema.prisma:L17362`
- `ActivityLog` → `schema.prisma:L7543`
- `Aggregator` → `schema.prisma:L15633`
- `AggregatorBooking` → `schema.prisma:L14941`
- `AggregatorCapacityRule` → `schema.prisma:L14922`
- `AggregatorConnection` → `schema.prisma:L14847`
- `AggregatorInboundEvent` → `schema.prisma:L15010`
- `AggregatorOutbox` → `schema.prisma:L15030`
- `AggregatorProductLink` → `schema.prisma:L14879`
- `AggregatorSessionLink` → `schema.prisma:L14898`
- `AggregatorVisit` → `schema.prisma:L14967`
- `AngelPayUserAccount` → `schema.prisma:L6088`
- `AppUpdate` → `schema.prisma:L13514`
- `Area` → `schema.prisma:L3275`
- `AreaTicket` → `schema.prisma:L16169`
- `AreaTicketCheckoutSession` → `schema.prisma:L16291`
- `AreaTicketExternalIncident` → `schema.prisma:L16538`
- `AreaTicketExternalSettlement` → `schema.prisma:L16503`
- `AreaTicketFulfillment` → `schema.prisma:L16367`
- `AreaTicketInventoryReservation` → `schema.prisma:L16262`
- `AreaTicketLine` → `schema.prisma:L16230`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16323`
- `AreaTicketPrintAttempt` → `schema.prisma:L16346`
- `BankStatement` → `schema.prisma:L17236`
- `BankStatementLine` → `schema.prisma:L17257`
- `BillingObligationConflict` → `schema.prisma:L5118`
- `BillingTaxProfile` → `schema.prisma:L18059`
- `BirthdayAutomation` → `schema.prisma:L7867`
- `BulkCommandOperation` → `schema.prisma:L10794`
- `CalendarSyncOutbox` → `schema.prisma:L14730`
- `CampaignDelivery` → `schema.prisma:L13672`
- `CapabilityGrant` → `schema.prisma:L4858`
- `CashCloseout` → `schema.prisma:L11179`
- `CashDeposit` → `schema.prisma:L13316`
- `CashDrawerEvent` → `schema.prisma:L15470`
- `CashDrawerSession` → `schema.prisma:L15431`
- `CashOutCommissionRate` → `schema.prisma:L17876`
- `CashOutScheduleDay` → `schema.prisma:L17899`
- `CashOutWithdrawal` → `schema.prisma:L17961`
- `CatalogBindingBatch` → `schema.prisma:L12210`
- `CatalogBindingLine` → `schema.prisma:L12246`
- `CatalogBrand` → `schema.prisma:L11663`
- `CatalogClientObservation` → `schema.prisma:L11976`
- `CatalogClientReadinessOverride` → `schema.prisma:L11995`
- `CatalogFamily` → `schema.prisma:L11713`
- `CatalogIdempotencyRecord` → `schema.prisma:L12109`
- `CatalogIdentifier` → `schema.prisma:L11844`
- `CatalogImportBatch` → `schema.prisma:L12152`
- `CatalogImportLine` → `schema.prisma:L12189`
- `CatalogItem` → `schema.prisma:L11746`
- `CatalogItemBusinessType` → `schema.prisma:L11806`
- `CatalogItemPrice` → `schema.prisma:L11894`
- `CatalogManufacturer` → `schema.prisma:L11687`
- `CatalogProductTypeMapping` → `schema.prisma:L11823`
- `CatalogPublicationBatch` → `schema.prisma:L12274`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12368`
- `CatalogPublicationLine` → `schema.prisma:L12315`
- `CatalogPublicationOutbox` → `schema.prisma:L12411`
- `CatalogValidationProfile` → `schema.prisma:L11865`
- `CatalogVenueBinding` → `schema.prisma:L12023`
- `CatalogVenueClientRequirement` → `schema.prisma:L11950`
- `CatalogVenueEventSequence` → `schema.prisma:L12394`
- `CatalogVenueOverride` → `schema.prisma:L12065`
- `CatalogVenueRollout` → `schema.prisma:L11925`
- `Cfdi` → `schema.prisma:L17064`
- `CfdiGlobalOrden` → `schema.prisma:L17189`
- `ChatbotTokenBudget` → `schema.prisma:L10440`
- `ChatConversation` → `schema.prisma:L10295`
- `ChatFeedback` → `schema.prisma:L10381`
- `ChatLearningEvent` → `schema.prisma:L10338`
- `ChatMessage` → `schema.prisma:L10318`
- `ChatTrainingData` → `schema.prisma:L10252`
- `CheckoutSession` → `schema.prisma:L6368`
- `ClassSession` → `schema.prisma:L14330`
- `ClassSessionPayState` → `schema.prisma:L19014`
- `CommissionCalculation` → `schema.prisma:L13092`
- `CommissionClawback` → `schema.prisma:L13268`
- `CommissionConfig` → `schema.prisma:L12858`
- `CommissionMilestone` → `schema.prisma:L13008`
- `CommissionOverride` → `schema.prisma:L12935`
- `CommissionPayout` → `schema.prisma:L13219`
- `CommissionSummary` → `schema.prisma:L13158`
- `CommissionTier` → `schema.prisma:L12972`
- `ConsentEvent` → `schema.prisma:L7729`
- `Consumer` → `schema.prisma:L7959`
- `ConsumerAuthAccount` → `schema.prisma:L7984`
- `CouponCode` → `schema.prisma:L8931`
- `CouponRedemption` → `schema.prisma:L8962`
- `CreditAssessmentHistory` → `schema.prisma:L11288`
- `CreditItemBalance` → `schema.prisma:L15221`
- `CreditOffer` → `schema.prisma:L11307`
- `CreditPack` → `schema.prisma:L15130`
- `CreditPackItem` → `schema.prisma:L15159`
- `CreditPackPurchase` → `schema.prisma:L15176`
- `CreditTransaction` → `schema.prisma:L15243`
- `Customer` → `schema.prisma:L7584`
- `CustomerApprovalDelivery` → `schema.prisma:L9954`
- `CustomerApprovalOutbox` → `schema.prisma:L9929`
- `CustomerCampaign` → `schema.prisma:L7817`
- `CustomerCampaignDelivery` → `schema.prisma:L7899`
- `CustomerCaptureToken` → `schema.prisma:L7765`
- `CustomerDiscount` → `schema.prisma:L8982`
- `CustomerExternalIdentity` → `schema.prisma:L14997`
- `CustomerGroup` → `schema.prisma:L8023`
- `CustomerOrderMetric` → `schema.prisma:L4074`
- `CustomerTaxProfile` → `schema.prisma:L17208`
- `DeliveryActivationRequest` → `schema.prisma:L6827`
- `DeliveryChannelLink` → `schema.prisma:L6666`
- `DeliveryConnectIntent` → `schema.prisma:L6778`
- `DeliveryLineAction` → `schema.prisma:L6739`
- `DeliveryOrderEvent` → `schema.prisma:L6851`
- `DeliveryStoreRevocation` → `schema.prisma:L6815`
- `DeviceToken` → `schema.prisma:L9256`
- `DigitalReceipt` → `schema.prisma:L4671`
- `Discount` → `schema.prisma:L8621`
- `EcommerceMerchant` → `schema.prisma:L6180`
- `EmailQuotaLedger` → `schema.prisma:L7946`
- `EmailSuppression` → `schema.prisma:L7934`
- `EmailTemplate` → `schema.prisma:L13611`
- `Employee` → `schema.prisma:L17724`
- `Estimate` → `schema.prisma:L15540`
- `EstimateItem` → `schema.prisma:L15568`
- `Expense` → `schema.prisma:L17511`
- `ExternalBusyBlock` → `schema.prisma:L14623`
- `Feature` → `schema.prisma:L4800`
- `FeeSchedule` → `schema.prisma:L5180`
- `FeeTier` → `schema.prisma:L5191`
- `FinancialAccount` → `schema.prisma:L15730`
- `FinancialConnection` → `schema.prisma:L15699`
- `FinancialProvider` → `schema.prisma:L15685`
- `FiscalEmisor` → `schema.prisma:L16975`
- `FiscalLossCarryforward` → `schema.prisma:L17634`
- `FixedAsset` → `schema.prisma:L17652`
- `FixedAssetDepreciation` → `schema.prisma:L17681`
- `FloorElement` → `schema.prisma:L3351`
- `FulfillmentArea` → `schema.prisma:L16034`
- `GeofenceRule` → `schema.prisma:L10879`
- `GoogleCalendarChannel` → `schema.prisma:L14600`
- `GoogleCalendarConnection` → `schema.prisma:L14552`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14653`
- `GoogleOAuthSession` → `schema.prisma:L14675`
- `HolidayCalendar` → `schema.prisma:L7467`
- `HybridBillingOperation` → `schema.prisma:L5042`
- `HybridCampaign` → `schema.prisma:L4883`
- `HybridContract` → `schema.prisma:L4999`
- `HybridContractSelection` → `schema.prisma:L5031`
- `HybridCreditAllocation` → `schema.prisma:L5098`
- `HybridOfferPublication` → `schema.prisma:L4946`
- `HybridPaymentPeriod` → `schema.prisma:L5077`
- `HybridPromotionGroup` → `schema.prisma:L4927`
- `HybridPurchase` → `schema.prisma:L4966`
- `HybridRedemption` → `schema.prisma:L5060`
- `IdempotencyRequest` → `schema.prisma:L12733`
- `InterVenueTransfer` → `schema.prisma:L3103`
- `InterVenueTransferAllocation` → `schema.prisma:L3186`
- `InterVenueTransferItem` → `schema.prisma:L3155`
- `InterVenueTransferReceipt` → `schema.prisma:L3213`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3229`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3257`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3241`
- `Inventory` → `schema.prisma:L2029`
- `InventoryMovement` → `schema.prisma:L2129`
- `InventoryPosting` → `schema.prisma:L2224`
- `InventoryPostingLine` → `schema.prisma:L2264`
- `InventoryTransfer` → `schema.prisma:L15512`
- `InventoryWasteReport` → `schema.prisma:L2084`
- `Invitation` → `schema.prisma:L1523`
- `Invoice` → `schema.prisma:L5203`
- `InvoiceItem` → `schema.prisma:L5229`
- `ItemCategory` → `schema.prisma:L12446`
- `JournalEntry` → `schema.prisma:L17420`
- `JournalLine` → `schema.prisma:L17449`
- `KdsOrder` → `schema.prisma:L15778`
- `KdsOrderItem` → `schema.prisma:L15841`
- `KioskCheckInAttempt` → `schema.prisma:L18382`
- `KioskCheckInChallenge` → `schema.prisma:L18336`
- `KioskOutreachOutbox` → `schema.prisma:L18403`
- `LaunchCampaign` → `schema.prisma:L18741`
- `LaunchCampaignRedemption` → `schema.prisma:L18858`
- `LearnedPatterns` → `schema.prisma:L10362`
- `LedgerAccount` → `schema.prisma:L17312`
- `LiveDemoSession` → `schema.prisma:L848`
- `LowStockAlert` → `schema.prisma:L2937`
- `LoyaltyConfig` → `schema.prisma:L8053`
- `LoyaltyTransaction` → `schema.prisma:L8096`
- `MarketingCampaign` → `schema.prisma:L13629`
- `McpAuthCode` → `schema.prisma:L16857`
- `McpOAuthClient` → `schema.prisma:L16841`
- `McpRefreshToken` → `schema.prisma:L16875`
- `McpToolCall` → `schema.prisma:L16897`
- `MeasurementUnit` → `schema.prisma:L15618`
- `Menu` → `schema.prisma:L1741`
- `MenuCategory` → `schema.prisma:L1678`
- `MenuCategoryAssignment` → `schema.prisma:L1776`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16771`
- `MerchantAccount` → `schema.prisma:L5918`
- `MerchantFiscalConfig` → `schema.prisma:L17035`
- `MerchantRevenueShare` → `schema.prisma:L7047`
- `MerchantRoutingRule` → `schema.prisma:L6040`
- `MilestoneAchievement` → `schema.prisma:L13053`
- `Modifier` → `schema.prisma:L4273`
- `ModifierGroup` → `schema.prisma:L4237`
- `Module` → `schema.prisma:L11355`
- `MoneyAnomaly` → `schema.prisma:L6950`
- `MonthlyVenueProfit` → `schema.prisma:L7493`
- `Notification` → `schema.prisma:L9158`
- `NotificationPreference` → `schema.prisma:L9205`
- `NotificationTemplate` → `schema.prisma:L9232`
- `OAuthState` → `schema.prisma:L1574`
- `OnboardingProgress` → `schema.prisma:L1592`
- `Order` → `schema.prisma:L3800`
- `OrderAction` → `schema.prisma:L4344`
- `OrderCustomer` → `schema.prisma:L4053`
- `OrderDiscount` → `schema.prisma:L9014`
- `OrderFulfillment` → `schema.prisma:L16089`
- `OrderFulfillmentLine` → `schema.prisma:L16120`
- `OrderItem` → `schema.prisma:L4089`
- `OrderItemModifier` → `schema.prisma:L4326`
- `OrderItemSelloIva` → `schema.prisma:L17169`
- `OrderPromotion` → `schema.prisma:L18299`
- `OrderServiceCharge` → `schema.prisma:L9103`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13430`
- `OrganizationEntitlement` → `schema.prisma:L11638`
- `OrganizationGoal` → `schema.prisma:L13388`
- `OrganizationModule` → `schema.prisma:L11415`
- `OrganizationPaymentConfig` → `schema.prisma:L6492`
- `OrganizationPayoutConfig` → `schema.prisma:L13463`
- `OrganizationPricingStructure` → `schema.prisma:L6524`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13411`
- `OtpChallenge` → `schema.prisma:L8003`
- `OvertimeApproval` → `schema.prisma:L3578`
- `PartnerAPIKey` → `schema.prisma:L6322`
- `Payment` → `schema.prisma:L4377`
- `PaymentAllocation` → `schema.prisma:L4650`
- `PaymentEffect` → `schema.prisma:L18673`
- `PaymentLink` → `schema.prisma:L15289`
- `PaymentLinkAttribution` → `schema.prisma:L15397`
- `PaymentLinkItem` → `schema.prisma:L15352`
- `PaymentLinkItemModifier` → `schema.prisma:L15379`
- `PaymentProvider` → `schema.prisma:L5877`
- `PayrollLine` → `schema.prisma:L17795`
- `PayrollRun` → `schema.prisma:L17764`
- `PerformanceGoal` → `schema.prisma:L13365`
- `PermissionOverride` → `schema.prisma:L1447`
- `PermissionSet` → `schema.prisma:L1470`
- `PlatformAnnouncement` → `schema.prisma:L18463`
- `PlatformAnnouncementClick` → `schema.prisma:L18528`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18565`
- `PlatformCfdi` → `schema.prisma:L18092`
- `PlatformEmisor` → `schema.prisma:L18032`
- `PlatformSettings` → `schema.prisma:L6299`
- `PosCommand` → `schema.prisma:L9286`
- `PosConnectionStatus` → `schema.prisma:L992`
- `PosSyncIntent` → `schema.prisma:L18170`
- `PricingPolicy` → `schema.prisma:L2833`
- `Printer` → `schema.prisma:L15890`
- `PrintGateway` → `schema.prisma:L15947`
- `PrintJob` → `schema.prisma:L16670`
- `PrintStation` → `schema.prisma:L15965`
- `PrivacyNoticeVersion` → `schema.prisma:L7751`
- `ProcessedStripeEvent` → `schema.prisma:L6936`
- `ProcessorReliabilityMetric` → `schema.prisma:L7421`
- `Product` → `schema.prisma:L1794`
- `ProductModifierGroup` → `schema.prisma:L4314`
- `ProductOption` → `schema.prisma:L15595`
- `ProductOptionValue` → `schema.prisma:L15606`
- `ProductStaff` → `schema.prisma:L14245`
- `PromoterBankAccount` → `schema.prisma:L17915`
- `PromoterCommissionEntry` → `schema.prisma:L17934`
- `PromoterLocationPing` → `schema.prisma:L3766`
- `Promotion` → `schema.prisma:L18221`
- `PromotionGroup` → `schema.prisma:L18260`
- `PromotionOption` → `schema.prisma:L18276`
- `ProviderCostStructure` → `schema.prisma:L6972`
- `ProviderEventLog` → `schema.prisma:L6601`
- `PurchaseOrder` → `schema.prisma:L2540`
- `PurchaseOrderInvoice` → `schema.prisma:L2685`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2752`
- `PurchaseOrderItem` → `schema.prisma:L2598`
- `RateCorrectionBatch` → `schema.prisma:L7197`
- `RateCorrectionEntry` → `schema.prisma:L7239`
- `RawMaterial` → `schema.prisma:L2296`
- `RawMaterialMovement` → `schema.prisma:L2886`
- `RawMaterialPresentation` → `schema.prisma:L2372`
- `ReceiptLayout` → `schema.prisma:L18707`
- `Recipe` → `schema.prisma:L2392`
- `RecipeLine` → `schema.prisma:L2416`
- `Referral` → `schema.prisma:L8469`
- `ReferralProgramConfig` → `schema.prisma:L8434`
- `ReferralRewardGrant` → `schema.prisma:L8560`
- `ReferralTierReward` → `schema.prisma:L8532`
- `ReferralTierUnlock` → `schema.prisma:L8605`
- `RefreshGrant` → `schema.prisma:L18652`
- `Reservation` → `schema.prisma:L14008`
- `ReservationGoogleEventMapping` → `schema.prisma:L15062`
- `ReservationModifier` → `schema.prisma:L14193`
- `ReservationReminderSent` → `schema.prisma:L14176`
- `ReservationSettings` → `schema.prisma:L14411`
- `ReservationWaitlistEntry` → `schema.prisma:L14379`
- `Review` → `schema.prisma:L5247`
- `SalesRetention` → `schema.prisma:L17615`
- `SaleVerification` → `schema.prisma:L4704`
- `ScaleProfile` → `schema.prisma:L16411`
- `ScheduledCommand` → `schema.prisma:L10839`
- `SerializedItem` → `schema.prisma:L12489`
- `SerializedItemCustodyEvent` → `schema.prisma:L12656`
- `ServiceCharge` → `schema.prisma:L9074`
- `ServiceEarning` → `schema.prisma:L19074`
- `ServicePayPeriod` → `schema.prisma:L19050`
- `ServicePayTable` → `schema.prisma:L18965`
- `ServicePayTableCell` → `schema.prisma:L19002`
- `ServicePayTableVersion` → `schema.prisma:L18982`
- `Session` → `schema.prisma:L18631`
- `SettlementConfiguration` → `schema.prisma:L7272`
- `SettlementConfirmation` → `schema.prisma:L7385`
- `SettlementIncident` → `schema.prisma:L7336`
- `SettlementSimulation` → `schema.prisma:L7307`
- `Shift` → `schema.prisma:L3389`
- `SimRegistrationRequest` → `schema.prisma:L12694`
- `SimRegistrationRequestItem` → `schema.prisma:L12716`
- `SlotHold` → `schema.prisma:L14276`
- `Staff` → `schema.prisma:L1012`
- `StaffDocument` → `schema.prisma:L3637`
- `StaffOnboardingState` → `schema.prisma:L16741`
- `StaffOrganization` → `schema.prisma:L1346`
- `StaffPasskey` → `schema.prisma:L1373`
- `StaffPayLevel` → `schema.prisma:L18929`
- `StaffPayLevelAssignment` → `schema.prisma:L18947`
- `StaffPayStatement` → `schema.prisma:L19104`
- `StaffSchedule` → `schema.prisma:L14216`
- `StaffScheduleException` → `schema.prisma:L14228`
- `StaffVenue` → `schema.prisma:L1270`
- `StaffWorkSchedule` → `schema.prisma:L3514`
- `StaffWorkScheduleException` → `schema.prisma:L3612`
- `StampCard` → `schema.prisma:L8317`
- `StampEvent` → `schema.prisma:L8356`
- `StampReward` → `schema.prisma:L8394`
- `StockAlertConfig` → `schema.prisma:L13347`
- `StockBatch` → `schema.prisma:L3052`
- `StockCount` → `schema.prisma:L2969`
- `StockCountItem` → `schema.prisma:L2997`
- `StripeWebhookEvent` → `schema.prisma:L6919`
- `Supplier` → `schema.prisma:L2451`
- `SupplierItemCode` → `schema.prisma:L2796`
- `SupplierPricing` → `schema.prisma:L2506`
- `Table` → `schema.prisma:L3301`
- `Terminal` → `schema.prisma:L5298`
- `TerminalAttemptResolution` → `schema.prisma:L5736`
- `TerminalHealth` → `schema.prisma:L5556`
- `TerminalLog` → `schema.prisma:L5530`
- `TerminalOrder` → `schema.prisma:L5780`
- `TerminalOrderItem` → `schema.prisma:L5855`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5708`
- `TerminalPaymentRequest` → `schema.prisma:L5627`
- `TimeEntry` → `schema.prisma:L3679`
- `TimeEntryBreak` → `schema.prisma:L3748`
- `TokenPurchase` → `schema.prisma:L10511`
- `TokenUsageRecord` → `schema.prisma:L10483`
- `TpvCommandHistory` → `schema.prisma:L10745`
- `TpvCommandQueue` → `schema.prisma:L10683`
- `TpvFeedback` → `schema.prisma:L10396`
- `TpvMessage` → `schema.prisma:L13704`
- `TpvMessageDelivery` → `schema.prisma:L13756`
- `TpvMessageResponse` → `schema.prisma:L13779`
- `TrainingModule` → `schema.prisma:L13834`
- `TrainingProgress` → `schema.prisma:L13911`
- `TrainingQuizQuestion` → `schema.prisma:L13893`
- `TrainingStep` → `schema.prisma:L13873`
- `TransactionCost` → `schema.prisma:L7135`
- `UnitConversion` → `schema.prisma:L2864`
- `UpsellAcceptance` → `schema.prisma:L8890`
- `UpsellAiRun` → `schema.prisma:L8910`
- `UpsellImpression` → `schema.prisma:L8850`
- `UpsellRule` → `schema.prisma:L8770`
- `user_sessions` → `schema.prisma:L6357`
- `Venue` → `schema.prisma:L173`
- `VenueAreaTicketSettings` → `schema.prisma:L16148`
- `VenueChatMessage` → `schema.prisma:L824`
- `VenueChatSession` → `schema.prisma:L779`
- `VenueCommission` → `schema.prisma:L15756`
- `VenueCreditAssessment` → `schema.prisma:L11227`
- `VenueCryptoConfig` → `schema.prisma:L13571`
- `VenueFeature` → `schema.prisma:L4818`
- `VenueIvaPorProducto` → `schema.prisma:L975`
- `VenueModule` → `schema.prisma:L11387`
- `VenuePaymentConfig` → `schema.prisma:L6458`
- `VenuePaymentLinkSettings` → `schema.prisma:L15095`
- `VenuePosSinAparato` → `schema.prisma:L986`
- `VenuePricingStructure` → `schema.prisma:L7075`
- `VenueRoleConfig` → `schema.prisma:L1499`
- `VenueRolePermission` → `schema.prisma:L1403`
- `VenueScaleSettings` → `schema.prisma:L16399`
- `VenueSettings` → `schema.prisma:L864`
- `VenueTenderType` → `schema.prisma:L4563`
- `VenueTenderTypeRevision` → `schema.prisma:L4628`
- `VenueTransaction` → `schema.prisma:L4755`
- `VenueWhatsappActivation` → `schema.prisma:L715`
- `WalletCardDesign` → `schema.prisma:L8235`
- `WalletPass` → `schema.prisma:L8136`
- `WalletPassRegistration` → `schema.prisma:L8202`
- `WebhookEvent` → `schema.prisma:L5156`
- `WebhookSubscription` → `schema.prisma:L6574`
- `WhatsappContactWindow` → `schema.prisma:L733`
- `WhatsappInboundEvent` → `schema.prisma:L753`
- `WorkShiftAssignment` → `schema.prisma:L3554`
- `WorkShiftTemplate` → `schema.prisma:L3531`
- `Zone` → `schema.prisma:L156`
