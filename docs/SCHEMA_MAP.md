# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **412 models / 378 enums / ~19,200 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `FloorPlanPublication`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueIvaPorProducto`, `VenuePosSinAparato`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
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
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `ClassSessionPayState`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `ServiceEarning`, `ServicePayPeriod`, `ServicePayTable`, `ServicePayTableCell`, `ServicePayTableVersion`, `StaffPayLevel`, `StaffPayLevelAssignment`, `StaffPayStatement`, `StaffPayTipWindow`, `StaffPayVenueWindow`, `VenueCommission`                                                                                                                                                                                                    |
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

- `AccountingPeriodLock` → `schema.prisma:L17539`
- `AccountMapping` → `schema.prisma:L17434`
- `ActivityLog` → `schema.prisma:L7581`
- `Aggregator` → `schema.prisma:L15692`
- `AggregatorBooking` → `schema.prisma:L15000`
- `AggregatorCapacityRule` → `schema.prisma:L14981`
- `AggregatorConnection` → `schema.prisma:L14906`
- `AggregatorInboundEvent` → `schema.prisma:L15069`
- `AggregatorOutbox` → `schema.prisma:L15089`
- `AggregatorProductLink` → `schema.prisma:L14938`
- `AggregatorSessionLink` → `schema.prisma:L14957`
- `AggregatorVisit` → `schema.prisma:L15026`
- `AngelPayUserAccount` → `schema.prisma:L6126`
- `AppUpdate` → `schema.prisma:L13567`
- `Area` → `schema.prisma:L3289`
- `AreaTicket` → `schema.prisma:L16241`
- `AreaTicketCheckoutSession` → `schema.prisma:L16363`
- `AreaTicketExternalIncident` → `schema.prisma:L16610`
- `AreaTicketExternalSettlement` → `schema.prisma:L16575`
- `AreaTicketFulfillment` → `schema.prisma:L16439`
- `AreaTicketInventoryReservation` → `schema.prisma:L16334`
- `AreaTicketLine` → `schema.prisma:L16302`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16395`
- `AreaTicketPrintAttempt` → `schema.prisma:L16418`
- `BankStatement` → `schema.prisma:L17308`
- `BankStatementLine` → `schema.prisma:L17329`
- `BillingObligationConflict` → `schema.prisma:L5156`
- `BillingTaxProfile` → `schema.prisma:L18131`
- `BirthdayAutomation` → `schema.prisma:L7905`
- `BulkCommandOperation` → `schema.prisma:L10839`
- `CalendarSyncOutbox` → `schema.prisma:L14789`
- `CampaignDelivery` → `schema.prisma:L13725`
- `CapabilityGrant` → `schema.prisma:L4896`
- `CashCloseout` → `schema.prisma:L11224`
- `CashDeposit` → `schema.prisma:L13369`
- `CashDrawerEvent` → `schema.prisma:L15529`
- `CashDrawerSession` → `schema.prisma:L15490`
- `CashOutCommissionRate` → `schema.prisma:L17948`
- `CashOutScheduleDay` → `schema.prisma:L17971`
- `CashOutWithdrawal` → `schema.prisma:L18033`
- `CatalogBindingBatch` → `schema.prisma:L12255`
- `CatalogBindingLine` → `schema.prisma:L12291`
- `CatalogBrand` → `schema.prisma:L11708`
- `CatalogClientObservation` → `schema.prisma:L12021`
- `CatalogClientReadinessOverride` → `schema.prisma:L12040`
- `CatalogFamily` → `schema.prisma:L11758`
- `CatalogIdempotencyRecord` → `schema.prisma:L12154`
- `CatalogIdentifier` → `schema.prisma:L11889`
- `CatalogImportBatch` → `schema.prisma:L12197`
- `CatalogImportLine` → `schema.prisma:L12234`
- `CatalogItem` → `schema.prisma:L11791`
- `CatalogItemBusinessType` → `schema.prisma:L11851`
- `CatalogItemPrice` → `schema.prisma:L11939`
- `CatalogManufacturer` → `schema.prisma:L11732`
- `CatalogProductTypeMapping` → `schema.prisma:L11868`
- `CatalogPublicationBatch` → `schema.prisma:L12319`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12413`
- `CatalogPublicationLine` → `schema.prisma:L12360`
- `CatalogPublicationOutbox` → `schema.prisma:L12456`
- `CatalogValidationProfile` → `schema.prisma:L11910`
- `CatalogVenueBinding` → `schema.prisma:L12068`
- `CatalogVenueClientRequirement` → `schema.prisma:L11995`
- `CatalogVenueEventSequence` → `schema.prisma:L12439`
- `CatalogVenueOverride` → `schema.prisma:L12110`
- `CatalogVenueRollout` → `schema.prisma:L11970`
- `Cfdi` → `schema.prisma:L17136`
- `CfdiGlobalOrden` → `schema.prisma:L17261`
- `ChatbotTokenBudget` → `schema.prisma:L10485`
- `ChatConversation` → `schema.prisma:L10340`
- `ChatFeedback` → `schema.prisma:L10426`
- `ChatLearningEvent` → `schema.prisma:L10383`
- `ChatMessage` → `schema.prisma:L10363`
- `ChatTrainingData` → `schema.prisma:L10297`
- `CheckoutSession` → `schema.prisma:L6406`
- `ClassSession` → `schema.prisma:L14383`
- `ClassSessionPayState` → `schema.prisma:L19091`
- `CommissionCalculation` → `schema.prisma:L13144`
- `CommissionClawback` → `schema.prisma:L13321`
- `CommissionConfig` → `schema.prisma:L12903`
- `CommissionMilestone` → `schema.prisma:L13060`
- `CommissionOverride` → `schema.prisma:L12987`
- `CommissionPayout` → `schema.prisma:L13272`
- `CommissionSummary` → `schema.prisma:L13211`
- `CommissionTier` → `schema.prisma:L13024`
- `ConsentEvent` → `schema.prisma:L7767`
- `Consumer` → `schema.prisma:L7997`
- `ConsumerAuthAccount` → `schema.prisma:L8022`
- `CouponCode` → `schema.prisma:L8969`
- `CouponRedemption` → `schema.prisma:L9000`
- `CreditAssessmentHistory` → `schema.prisma:L11333`
- `CreditItemBalance` → `schema.prisma:L15280`
- `CreditOffer` → `schema.prisma:L11352`
- `CreditPack` → `schema.prisma:L15189`
- `CreditPackItem` → `schema.prisma:L15218`
- `CreditPackPurchase` → `schema.prisma:L15235`
- `CreditTransaction` → `schema.prisma:L15302`
- `Customer` → `schema.prisma:L7622`
- `CustomerApprovalDelivery` → `schema.prisma:L9999`
- `CustomerApprovalOutbox` → `schema.prisma:L9974`
- `CustomerCampaign` → `schema.prisma:L7855`
- `CustomerCampaignDelivery` → `schema.prisma:L7937`
- `CustomerCaptureToken` → `schema.prisma:L7803`
- `CustomerDiscount` → `schema.prisma:L9020`
- `CustomerExternalIdentity` → `schema.prisma:L15056`
- `CustomerGroup` → `schema.prisma:L8061`
- `CustomerOrderMetric` → `schema.prisma:L4110`
- `CustomerTaxProfile` → `schema.prisma:L17280`
- `DeliveryActivationRequest` → `schema.prisma:L6865`
- `DeliveryChannelLink` → `schema.prisma:L6704`
- `DeliveryConnectIntent` → `schema.prisma:L6816`
- `DeliveryLineAction` → `schema.prisma:L6777`
- `DeliveryOrderEvent` → `schema.prisma:L6889`
- `DeliveryStoreRevocation` → `schema.prisma:L6853`
- `DeviceToken` → `schema.prisma:L9294`
- `DigitalReceipt` → `schema.prisma:L4709`
- `Discount` → `schema.prisma:L8659`
- `EcommerceMerchant` → `schema.prisma:L6218`
- `EmailQuotaLedger` → `schema.prisma:L7984`
- `EmailSuppression` → `schema.prisma:L7972`
- `EmailTemplate` → `schema.prisma:L13664`
- `Employee` → `schema.prisma:L17796`
- `Estimate` → `schema.prisma:L15599`
- `EstimateItem` → `schema.prisma:L15627`
- `Expense` → `schema.prisma:L17583`
- `ExternalBusyBlock` → `schema.prisma:L14682`
- `Feature` → `schema.prisma:L4838`
- `FeeSchedule` → `schema.prisma:L5218`
- `FeeTier` → `schema.prisma:L5229`
- `FinancialAccount` → `schema.prisma:L15789`
- `FinancialConnection` → `schema.prisma:L15758`
- `FinancialProvider` → `schema.prisma:L15744`
- `FiscalEmisor` → `schema.prisma:L17047`
- `FiscalLossCarryforward` → `schema.prisma:L17706`
- `FixedAsset` → `schema.prisma:L17724`
- `FixedAssetDepreciation` → `schema.prisma:L17753`
- `FloorElement` → `schema.prisma:L3370`
- `FloorPlanPublication` → `schema.prisma:L3410`
- `FulfillmentArea` → `schema.prisma:L16106`
- `GeofenceRule` → `schema.prisma:L10924`
- `GoogleCalendarChannel` → `schema.prisma:L14659`
- `GoogleCalendarConnection` → `schema.prisma:L14611`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14712`
- `GoogleOAuthSession` → `schema.prisma:L14734`
- `HolidayCalendar` → `schema.prisma:L7505`
- `HybridBillingOperation` → `schema.prisma:L5080`
- `HybridCampaign` → `schema.prisma:L4921`
- `HybridContract` → `schema.prisma:L5037`
- `HybridContractSelection` → `schema.prisma:L5069`
- `HybridCreditAllocation` → `schema.prisma:L5136`
- `HybridOfferPublication` → `schema.prisma:L4984`
- `HybridPaymentPeriod` → `schema.prisma:L5115`
- `HybridPromotionGroup` → `schema.prisma:L4965`
- `HybridPurchase` → `schema.prisma:L5004`
- `HybridRedemption` → `schema.prisma:L5098`
- `IdempotencyRequest` → `schema.prisma:L12778`
- `InterVenueTransfer` → `schema.prisma:L3117`
- `InterVenueTransferAllocation` → `schema.prisma:L3200`
- `InterVenueTransferItem` → `schema.prisma:L3169`
- `InterVenueTransferReceipt` → `schema.prisma:L3227`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3243`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3271`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3255`
- `Inventory` → `schema.prisma:L2043`
- `InventoryMovement` → `schema.prisma:L2143`
- `InventoryPosting` → `schema.prisma:L2238`
- `InventoryPostingLine` → `schema.prisma:L2278`
- `InventoryTransfer` → `schema.prisma:L15571`
- `InventoryWasteReport` → `schema.prisma:L2098`
- `Invitation` → `schema.prisma:L1537`
- `Invoice` → `schema.prisma:L5241`
- `InvoiceItem` → `schema.prisma:L5267`
- `ItemCategory` → `schema.prisma:L12491`
- `JournalEntry` → `schema.prisma:L17492`
- `JournalLine` → `schema.prisma:L17521`
- `KdsOrder` → `schema.prisma:L15837`
- `KdsOrderItem` → `schema.prisma:L15904`
- `KioskCheckInAttempt` → `schema.prisma:L18454`
- `KioskCheckInChallenge` → `schema.prisma:L18408`
- `KioskOutreachOutbox` → `schema.prisma:L18475`
- `LaunchCampaign` → `schema.prisma:L18813`
- `LaunchCampaignRedemption` → `schema.prisma:L18930`
- `LearnedPatterns` → `schema.prisma:L10407`
- `LedgerAccount` → `schema.prisma:L17384`
- `LiveDemoSession` → `schema.prisma:L858`
- `LowStockAlert` → `schema.prisma:L2951`
- `LoyaltyConfig` → `schema.prisma:L8091`
- `LoyaltyTransaction` → `schema.prisma:L8134`
- `MarketingCampaign` → `schema.prisma:L13682`
- `McpAuthCode` → `schema.prisma:L16929`
- `McpOAuthClient` → `schema.prisma:L16913`
- `McpRefreshToken` → `schema.prisma:L16947`
- `McpToolCall` → `schema.prisma:L16969`
- `MeasurementUnit` → `schema.prisma:L15677`
- `Menu` → `schema.prisma:L1755`
- `MenuCategory` → `schema.prisma:L1692`
- `MenuCategoryAssignment` → `schema.prisma:L1790`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16843`
- `MerchantAccount` → `schema.prisma:L5956`
- `MerchantFiscalConfig` → `schema.prisma:L17107`
- `MerchantRevenueShare` → `schema.prisma:L7085`
- `MerchantRoutingRule` → `schema.prisma:L6078`
- `MilestoneAchievement` → `schema.prisma:L13105`
- `Modifier` → `schema.prisma:L4311`
- `ModifierGroup` → `schema.prisma:L4275`
- `Module` → `schema.prisma:L11400`
- `MoneyAnomaly` → `schema.prisma:L6988`
- `MonthlyVenueProfit` → `schema.prisma:L7531`
- `Notification` → `schema.prisma:L9196`
- `NotificationPreference` → `schema.prisma:L9243`
- `NotificationTemplate` → `schema.prisma:L9270`
- `OAuthState` → `schema.prisma:L1588`
- `OnboardingProgress` → `schema.prisma:L1606`
- `Order` → `schema.prisma:L3836`
- `OrderAction` → `schema.prisma:L4382`
- `OrderCustomer` → `schema.prisma:L4089`
- `OrderDiscount` → `schema.prisma:L9052`
- `OrderFulfillment` → `schema.prisma:L16161`
- `OrderFulfillmentLine` → `schema.prisma:L16192`
- `OrderItem` → `schema.prisma:L4125`
- `OrderItemModifier` → `schema.prisma:L4364`
- `OrderItemSelloIva` → `schema.prisma:L17241`
- `OrderPromotion` → `schema.prisma:L18371`
- `OrderServiceCharge` → `schema.prisma:L9141`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13483`
- `OrganizationEntitlement` → `schema.prisma:L11683`
- `OrganizationGoal` → `schema.prisma:L13441`
- `OrganizationModule` → `schema.prisma:L11460`
- `OrganizationPaymentConfig` → `schema.prisma:L6530`
- `OrganizationPayoutConfig` → `schema.prisma:L13516`
- `OrganizationPricingStructure` → `schema.prisma:L6562`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13464`
- `OtpChallenge` → `schema.prisma:L8041`
- `OvertimeApproval` → `schema.prisma:L3614`
- `PartnerAPIKey` → `schema.prisma:L6360`
- `Payment` → `schema.prisma:L4415`
- `PaymentAllocation` → `schema.prisma:L4688`
- `PaymentEffect` → `schema.prisma:L18745`
- `PaymentLink` → `schema.prisma:L15348`
- `PaymentLinkAttribution` → `schema.prisma:L15456`
- `PaymentLinkItem` → `schema.prisma:L15411`
- `PaymentLinkItemModifier` → `schema.prisma:L15438`
- `PaymentProvider` → `schema.prisma:L5915`
- `PayrollLine` → `schema.prisma:L17867`
- `PayrollRun` → `schema.prisma:L17836`
- `PerformanceGoal` → `schema.prisma:L13418`
- `PermissionOverride` → `schema.prisma:L1461`
- `PermissionSet` → `schema.prisma:L1484`
- `PlatformAnnouncement` → `schema.prisma:L18535`
- `PlatformAnnouncementClick` → `schema.prisma:L18600`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18637`
- `PlatformCfdi` → `schema.prisma:L18164`
- `PlatformEmisor` → `schema.prisma:L18104`
- `PlatformSettings` → `schema.prisma:L6337`
- `PosCommand` → `schema.prisma:L9324`
- `PosConnectionStatus` → `schema.prisma:L1006`
- `PosSyncIntent` → `schema.prisma:L18242`
- `PricingPolicy` → `schema.prisma:L2847`
- `Printer` → `schema.prisma:L15962`
- `PrintGateway` → `schema.prisma:L16019`
- `PrintJob` → `schema.prisma:L16742`
- `PrintStation` → `schema.prisma:L16037`
- `PrivacyNoticeVersion` → `schema.prisma:L7789`
- `ProcessedStripeEvent` → `schema.prisma:L6974`
- `ProcessorReliabilityMetric` → `schema.prisma:L7459`
- `Product` → `schema.prisma:L1808`
- `ProductModifierGroup` → `schema.prisma:L4352`
- `ProductOption` → `schema.prisma:L15654`
- `ProductOptionValue` → `schema.prisma:L15665`
- `ProductStaff` → `schema.prisma:L14298`
- `PromoterBankAccount` → `schema.prisma:L17987`
- `PromoterCommissionEntry` → `schema.prisma:L18006`
- `PromoterLocationPing` → `schema.prisma:L3802`
- `Promotion` → `schema.prisma:L18293`
- `PromotionGroup` → `schema.prisma:L18332`
- `PromotionOption` → `schema.prisma:L18348`
- `ProviderCostStructure` → `schema.prisma:L7010`
- `ProviderEventLog` → `schema.prisma:L6639`
- `PurchaseOrder` → `schema.prisma:L2554`
- `PurchaseOrderInvoice` → `schema.prisma:L2699`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2766`
- `PurchaseOrderItem` → `schema.prisma:L2612`
- `RateCorrectionBatch` → `schema.prisma:L7235`
- `RateCorrectionEntry` → `schema.prisma:L7277`
- `RawMaterial` → `schema.prisma:L2310`
- `RawMaterialMovement` → `schema.prisma:L2900`
- `RawMaterialPresentation` → `schema.prisma:L2386`
- `ReceiptLayout` → `schema.prisma:L18779`
- `Recipe` → `schema.prisma:L2406`
- `RecipeLine` → `schema.prisma:L2430`
- `Referral` → `schema.prisma:L8507`
- `ReferralProgramConfig` → `schema.prisma:L8472`
- `ReferralRewardGrant` → `schema.prisma:L8598`
- `ReferralTierReward` → `schema.prisma:L8570`
- `ReferralTierUnlock` → `schema.prisma:L8643`
- `RefreshGrant` → `schema.prisma:L18724`
- `Reservation` → `schema.prisma:L14061`
- `ReservationGoogleEventMapping` → `schema.prisma:L15121`
- `ReservationModifier` → `schema.prisma:L14246`
- `ReservationReminderSent` → `schema.prisma:L14229`
- `ReservationSettings` → `schema.prisma:L14470`
- `ReservationWaitlistEntry` → `schema.prisma:L14438`
- `Review` → `schema.prisma:L5285`
- `SalesRetention` → `schema.prisma:L17687`
- `SaleVerification` → `schema.prisma:L4742`
- `ScaleProfile` → `schema.prisma:L16483`
- `ScheduledCommand` → `schema.prisma:L10884`
- `SerializedItem` → `schema.prisma:L12534`
- `SerializedItemCustodyEvent` → `schema.prisma:L12701`
- `ServiceCharge` → `schema.prisma:L9112`
- `ServiceEarning` → `schema.prisma:L19153`
- `ServicePayPeriod` → `schema.prisma:L19129`
- `ServicePayTable` → `schema.prisma:L19037`
- `ServicePayTableCell` → `schema.prisma:L19079`
- `ServicePayTableVersion` → `schema.prisma:L19054`
- `Session` → `schema.prisma:L18703`
- `SettlementConfiguration` → `schema.prisma:L7310`
- `SettlementConfirmation` → `schema.prisma:L7423`
- `SettlementIncident` → `schema.prisma:L7374`
- `SettlementSimulation` → `schema.prisma:L7345`
- `Shift` → `schema.prisma:L3425`
- `SimRegistrationRequest` → `schema.prisma:L12739`
- `SimRegistrationRequestItem` → `schema.prisma:L12761`
- `SlotHold` → `schema.prisma:L14329`
- `Staff` → `schema.prisma:L1026`
- `StaffDocument` → `schema.prisma:L3673`
- `StaffOnboardingState` → `schema.prisma:L16813`
- `StaffOrganization` → `schema.prisma:L1360`
- `StaffPasskey` → `schema.prisma:L1387`
- `StaffPayLevel` → `schema.prisma:L19001`
- `StaffPayLevelAssignment` → `schema.prisma:L19019`
- `StaffPayStatement` → `schema.prisma:L19185`
- `StaffPayTipWindow` → `schema.prisma:L19201`
- `StaffPayVenueWindow` → `schema.prisma:L19218`
- `StaffSchedule` → `schema.prisma:L14269`
- `StaffScheduleException` → `schema.prisma:L14281`
- `StaffVenue` → `schema.prisma:L1284`
- `StaffWorkSchedule` → `schema.prisma:L3550`
- `StaffWorkScheduleException` → `schema.prisma:L3648`
- `StampCard` → `schema.prisma:L8355`
- `StampEvent` → `schema.prisma:L8394`
- `StampReward` → `schema.prisma:L8432`
- `StockAlertConfig` → `schema.prisma:L13400`
- `StockBatch` → `schema.prisma:L3066`
- `StockCount` → `schema.prisma:L2983`
- `StockCountItem` → `schema.prisma:L3011`
- `StripeWebhookEvent` → `schema.prisma:L6957`
- `Supplier` → `schema.prisma:L2465`
- `SupplierItemCode` → `schema.prisma:L2810`
- `SupplierPricing` → `schema.prisma:L2520`
- `Table` → `schema.prisma:L3320`
- `Terminal` → `schema.prisma:L5336`
- `TerminalAttemptResolution` → `schema.prisma:L5774`
- `TerminalHealth` → `schema.prisma:L5594`
- `TerminalLog` → `schema.prisma:L5568`
- `TerminalOrder` → `schema.prisma:L5818`
- `TerminalOrderItem` → `schema.prisma:L5893`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5746`
- `TerminalPaymentRequest` → `schema.prisma:L5665`
- `TimeEntry` → `schema.prisma:L3715`
- `TimeEntryBreak` → `schema.prisma:L3784`
- `TokenPurchase` → `schema.prisma:L10556`
- `TokenUsageRecord` → `schema.prisma:L10528`
- `TpvCommandHistory` → `schema.prisma:L10790`
- `TpvCommandQueue` → `schema.prisma:L10728`
- `TpvFeedback` → `schema.prisma:L10441`
- `TpvMessage` → `schema.prisma:L13757`
- `TpvMessageDelivery` → `schema.prisma:L13809`
- `TpvMessageResponse` → `schema.prisma:L13832`
- `TrainingModule` → `schema.prisma:L13887`
- `TrainingProgress` → `schema.prisma:L13964`
- `TrainingQuizQuestion` → `schema.prisma:L13946`
- `TrainingStep` → `schema.prisma:L13926`
- `TransactionCost` → `schema.prisma:L7173`
- `UnitConversion` → `schema.prisma:L2878`
- `UpsellAcceptance` → `schema.prisma:L8928`
- `UpsellAiRun` → `schema.prisma:L8948`
- `UpsellImpression` → `schema.prisma:L8888`
- `UpsellRule` → `schema.prisma:L8808`
- `user_sessions` → `schema.prisma:L6395`
- `Venue` → `schema.prisma:L182`
- `VenueAreaTicketSettings` → `schema.prisma:L16220`
- `VenueChatMessage` → `schema.prisma:L834`
- `VenueChatSession` → `schema.prisma:L789`
- `VenueCommission` → `schema.prisma:L15815`
- `VenueCreditAssessment` → `schema.prisma:L11272`
- `VenueCryptoConfig` → `schema.prisma:L13624`
- `VenueFeature` → `schema.prisma:L4856`
- `VenueIvaPorProducto` → `schema.prisma:L989`
- `VenueModule` → `schema.prisma:L11432`
- `VenuePaymentConfig` → `schema.prisma:L6496`
- `VenuePaymentLinkSettings` → `schema.prisma:L15154`
- `VenuePosSinAparato` → `schema.prisma:L1000`
- `VenuePricingStructure` → `schema.prisma:L7113`
- `VenueRoleConfig` → `schema.prisma:L1513`
- `VenueRolePermission` → `schema.prisma:L1417`
- `VenueScaleSettings` → `schema.prisma:L16471`
- `VenueSettings` → `schema.prisma:L874`
- `VenueTenderType` → `schema.prisma:L4601`
- `VenueTenderTypeRevision` → `schema.prisma:L4666`
- `VenueTransaction` → `schema.prisma:L4793`
- `VenueWhatsappActivation` → `schema.prisma:L725`
- `WalletCardDesign` → `schema.prisma:L8273`
- `WalletPass` → `schema.prisma:L8174`
- `WalletPassRegistration` → `schema.prisma:L8240`
- `WebhookEvent` → `schema.prisma:L5194`
- `WebhookSubscription` → `schema.prisma:L6612`
- `WhatsappContactWindow` → `schema.prisma:L743`
- `WhatsappInboundEvent` → `schema.prisma:L763`
- `WorkShiftAssignment` → `schema.prisma:L3590`
- `WorkShiftTemplate` → `schema.prisma:L3567`
- `Zone` → `schema.prisma:L165`
