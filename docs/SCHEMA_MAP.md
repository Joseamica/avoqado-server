# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **386 models / 358 enums / ~18,300 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `CapabilityGrant`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `HybridBillingOperation`, `HybridCampaign`, `HybridContract`, `HybridContractSelection`, `HybridCreditAllocation`, `HybridOfferPublication`, `HybridPaymentPeriod`, `HybridPurchase`, `HybridRedemption`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                       |
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

- `AccountingPeriodLock` → `schema.prisma:L16963`
- `AccountMapping` → `schema.prisma:L16859`
- `ActivityLog` → `schema.prisma:L7411`
- `Aggregator` → `schema.prisma:L15201`
- `AngelPayUserAccount` → `schema.prisma:L5956`
- `AppUpdate` → `schema.prisma:L13366`
- `Area` → `schema.prisma:L3206`
- `AreaTicket` → `schema.prisma:L15737`
- `AreaTicketCheckoutSession` → `schema.prisma:L15859`
- `AreaTicketExternalIncident` → `schema.prisma:L16106`
- `AreaTicketExternalSettlement` → `schema.prisma:L16071`
- `AreaTicketFulfillment` → `schema.prisma:L15935`
- `AreaTicketInventoryReservation` → `schema.prisma:L15830`
- `AreaTicketLine` → `schema.prisma:L15798`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15891`
- `AreaTicketPrintAttempt` → `schema.prisma:L15914`
- `BankStatement` → `schema.prisma:L16733`
- `BankStatementLine` → `schema.prisma:L16754`
- `BillingObligationConflict` → `schema.prisma:L4993`
- `BillingTaxProfile` → `schema.prisma:L17543`
- `BirthdayAutomation` → `schema.prisma:L7732`
- `BulkCommandOperation` → `schema.prisma:L10646`
- `CalendarSyncOutbox` → `schema.prisma:L14573`
- `CampaignDelivery` → `schema.prisma:L13524`
- `CapabilityGrant` → `schema.prisma:L4769`
- `CashCloseout` → `schema.prisma:L11031`
- `CashDeposit` → `schema.prisma:L13168`
- `CashDrawerEvent` → `schema.prisma:L15038`
- `CashDrawerSession` → `schema.prisma:L14999`
- `CashOutCommissionRate` → `schema.prisma:L17372`
- `CashOutScheduleDay` → `schema.prisma:L17395`
- `CashOutWithdrawal` → `schema.prisma:L17457`
- `CatalogBindingBatch` → `schema.prisma:L12062`
- `CatalogBindingLine` → `schema.prisma:L12098`
- `CatalogBrand` → `schema.prisma:L11515`
- `CatalogClientObservation` → `schema.prisma:L11828`
- `CatalogClientReadinessOverride` → `schema.prisma:L11847`
- `CatalogFamily` → `schema.prisma:L11565`
- `CatalogIdempotencyRecord` → `schema.prisma:L11961`
- `CatalogIdentifier` → `schema.prisma:L11696`
- `CatalogImportBatch` → `schema.prisma:L12004`
- `CatalogImportLine` → `schema.prisma:L12041`
- `CatalogItem` → `schema.prisma:L11598`
- `CatalogItemBusinessType` → `schema.prisma:L11658`
- `CatalogItemPrice` → `schema.prisma:L11746`
- `CatalogManufacturer` → `schema.prisma:L11539`
- `CatalogProductTypeMapping` → `schema.prisma:L11675`
- `CatalogPublicationBatch` → `schema.prisma:L12126`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12220`
- `CatalogPublicationLine` → `schema.prisma:L12167`
- `CatalogPublicationOutbox` → `schema.prisma:L12263`
- `CatalogValidationProfile` → `schema.prisma:L11717`
- `CatalogVenueBinding` → `schema.prisma:L11875`
- `CatalogVenueClientRequirement` → `schema.prisma:L11802`
- `CatalogVenueEventSequence` → `schema.prisma:L12246`
- `CatalogVenueOverride` → `schema.prisma:L11917`
- `CatalogVenueRollout` → `schema.prisma:L11777`
- `Cfdi` → `schema.prisma:L16626`
- `ChatbotTokenBudget` → `schema.prisma:L10294`
- `ChatConversation` → `schema.prisma:L10149`
- `ChatFeedback` → `schema.prisma:L10235`
- `ChatLearningEvent` → `schema.prisma:L10192`
- `ChatMessage` → `schema.prisma:L10172`
- `ChatTrainingData` → `schema.prisma:L10106`
- `CheckoutSession` → `schema.prisma:L6236`
- `ClassSession` → `schema.prisma:L14177`
- `CommissionCalculation` → `schema.prisma:L12944`
- `CommissionClawback` → `schema.prisma:L13120`
- `CommissionConfig` → `schema.prisma:L12710`
- `CommissionMilestone` → `schema.prisma:L12860`
- `CommissionOverride` → `schema.prisma:L12787`
- `CommissionPayout` → `schema.prisma:L13071`
- `CommissionSummary` → `schema.prisma:L13010`
- `CommissionTier` → `schema.prisma:L12824`
- `ConsentEvent` → `schema.prisma:L7594`
- `Consumer` → `schema.prisma:L7824`
- `ConsumerAuthAccount` → `schema.prisma:L7849`
- `CouponCode` → `schema.prisma:L8796`
- `CouponRedemption` → `schema.prisma:L8827`
- `CreditAssessmentHistory` → `schema.prisma:L11140`
- `CreditItemBalance` → `schema.prisma:L14789`
- `CreditOffer` → `schema.prisma:L11159`
- `CreditPack` → `schema.prisma:L14698`
- `CreditPackItem` → `schema.prisma:L14727`
- `CreditPackPurchase` → `schema.prisma:L14744`
- `CreditTransaction` → `schema.prisma:L14811`
- `Customer` → `schema.prisma:L7452`
- `CustomerApprovalDelivery` → `schema.prisma:L9808`
- `CustomerApprovalOutbox` → `schema.prisma:L9783`
- `CustomerCampaign` → `schema.prisma:L7682`
- `CustomerCampaignDelivery` → `schema.prisma:L7764`
- `CustomerCaptureToken` → `schema.prisma:L7630`
- `CustomerDiscount` → `schema.prisma:L8847`
- `CustomerGroup` → `schema.prisma:L7888`
- `CustomerOrderMetric` → `schema.prisma:L3999`
- `CustomerTaxProfile` → `schema.prisma:L16705`
- `DeliveryActivationRequest` → `schema.prisma:L6695`
- `DeliveryChannelLink` → `schema.prisma:L6534`
- `DeliveryConnectIntent` → `schema.prisma:L6646`
- `DeliveryLineAction` → `schema.prisma:L6607`
- `DeliveryOrderEvent` → `schema.prisma:L6719`
- `DeliveryStoreRevocation` → `schema.prisma:L6683`
- `DeviceToken` → `schema.prisma:L9116`
- `DigitalReceipt` → `schema.prisma:L4582`
- `Discount` → `schema.prisma:L8486`
- `EcommerceMerchant` → `schema.prisma:L6048`
- `EmailQuotaLedger` → `schema.prisma:L7811`
- `EmailSuppression` → `schema.prisma:L7799`
- `EmailTemplate` → `schema.prisma:L13463`
- `Employee` → `schema.prisma:L17220`
- `Estimate` → `schema.prisma:L15108`
- `EstimateItem` → `schema.prisma:L15136`
- `Expense` → `schema.prisma:L17007`
- `ExternalBusyBlock` → `schema.prisma:L14466`
- `Feature` → `schema.prisma:L4711`
- `FeeSchedule` → `schema.prisma:L5055`
- `FeeTier` → `schema.prisma:L5066`
- `FinancialAccount` → `schema.prisma:L15298`
- `FinancialConnection` → `schema.prisma:L15267`
- `FinancialProvider` → `schema.prisma:L15253`
- `FiscalEmisor` → `schema.prisma:L16542`
- `FiscalLossCarryforward` → `schema.prisma:L17130`
- `FixedAsset` → `schema.prisma:L17148`
- `FixedAssetDepreciation` → `schema.prisma:L17177`
- `FloorElement` → `schema.prisma:L3282`
- `FulfillmentArea` → `schema.prisma:L15602`
- `GeofenceRule` → `schema.prisma:L10731`
- `GoogleCalendarChannel` → `schema.prisma:L14443`
- `GoogleCalendarConnection` → `schema.prisma:L14395`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14496`
- `GoogleOAuthSession` → `schema.prisma:L14518`
- `HolidayCalendar` → `schema.prisma:L7335`
- `HybridBillingOperation` → `schema.prisma:L4917`
- `HybridCampaign` → `schema.prisma:L4794`
- `HybridContract` → `schema.prisma:L4874`
- `HybridContractSelection` → `schema.prisma:L4906`
- `HybridCreditAllocation` → `schema.prisma:L4973`
- `HybridOfferPublication` → `schema.prisma:L4821`
- `HybridPaymentPeriod` → `schema.prisma:L4952`
- `HybridPurchase` → `schema.prisma:L4841`
- `HybridRedemption` → `schema.prisma:L4935`
- `IdempotencyRequest` → `schema.prisma:L12585`
- `InterVenueTransfer` → `schema.prisma:L3034`
- `InterVenueTransferAllocation` → `schema.prisma:L3117`
- `InterVenueTransferItem` → `schema.prisma:L3086`
- `InterVenueTransferReceipt` → `schema.prisma:L3144`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3160`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3188`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3172`
- `Inventory` → `schema.prisma:L1978`
- `InventoryMovement` → `schema.prisma:L2078`
- `InventoryPosting` → `schema.prisma:L2173`
- `InventoryPostingLine` → `schema.prisma:L2213`
- `InventoryTransfer` → `schema.prisma:L15080`
- `InventoryWasteReport` → `schema.prisma:L2033`
- `Invitation` → `schema.prisma:L1483`
- `Invoice` → `schema.prisma:L5078`
- `InvoiceItem` → `schema.prisma:L5104`
- `ItemCategory` → `schema.prisma:L12298`
- `JournalEntry` → `schema.prisma:L16917`
- `JournalLine` → `schema.prisma:L16945`
- `KdsOrder` → `schema.prisma:L15346`
- `KdsOrderItem` → `schema.prisma:L15409`
- `KioskCheckInAttempt` → `schema.prisma:L17866`
- `KioskCheckInChallenge` → `schema.prisma:L17820`
- `KioskOutreachOutbox` → `schema.prisma:L17887`
- `LaunchCampaign` → `schema.prisma:L18225`
- `LaunchCampaignRedemption` → `schema.prisma:L18342`
- `LearnedPatterns` → `schema.prisma:L10216`
- `LedgerAccount` → `schema.prisma:L16809`
- `LiveDemoSession` → `schema.prisma:L827`
- `LowStockAlert` → `schema.prisma:L2868`
- `LoyaltyConfig` → `schema.prisma:L7918`
- `LoyaltyTransaction` → `schema.prisma:L7961`
- `MarketingCampaign` → `schema.prisma:L13481`
- `McpAuthCode` → `schema.prisma:L16425`
- `McpOAuthClient` → `schema.prisma:L16409`
- `McpRefreshToken` → `schema.prisma:L16443`
- `McpToolCall` → `schema.prisma:L16464`
- `MeasurementUnit` → `schema.prisma:L15186`
- `Menu` → `schema.prisma:L1701`
- `MenuCategory` → `schema.prisma:L1638`
- `MenuCategoryAssignment` → `schema.prisma:L1736`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16339`
- `MerchantAccount` → `schema.prisma:L5786`
- `MerchantFiscalConfig` → `schema.prisma:L16597`
- `MerchantRevenueShare` → `schema.prisma:L6915`
- `MerchantRoutingRule` → `schema.prisma:L5908`
- `MilestoneAchievement` → `schema.prisma:L12905`
- `Modifier` → `schema.prisma:L4188`
- `ModifierGroup` → `schema.prisma:L4152`
- `Module` → `schema.prisma:L11207`
- `MoneyAnomaly` → `schema.prisma:L6818`
- `MonthlyVenueProfit` → `schema.prisma:L7361`
- `Notification` → `schema.prisma:L9018`
- `NotificationPreference` → `schema.prisma:L9065`
- `NotificationTemplate` → `schema.prisma:L9092`
- `OAuthState` → `schema.prisma:L1534`
- `OnboardingProgress` → `schema.prisma:L1552`
- `Order` → `schema.prisma:L3731`
- `OrderAction` → `schema.prisma:L4255`
- `OrderCustomer` → `schema.prisma:L3978`
- `OrderDiscount` → `schema.prisma:L8879`
- `OrderFulfillment` → `schema.prisma:L15657`
- `OrderFulfillmentLine` → `schema.prisma:L15688`
- `OrderItem` → `schema.prisma:L4014`
- `OrderItemModifier` → `schema.prisma:L4237`
- `OrderPromotion` → `schema.prisma:L17783`
- `OrderServiceCharge` → `schema.prisma:L8963`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13282`
- `OrganizationEntitlement` → `schema.prisma:L11490`
- `OrganizationGoal` → `schema.prisma:L13240`
- `OrganizationModule` → `schema.prisma:L11267`
- `OrganizationPaymentConfig` → `schema.prisma:L6360`
- `OrganizationPayoutConfig` → `schema.prisma:L13315`
- `OrganizationPricingStructure` → `schema.prisma:L6392`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13263`
- `OtpChallenge` → `schema.prisma:L7868`
- `OvertimeApproval` → `schema.prisma:L3509`
- `PartnerAPIKey` → `schema.prisma:L6190`
- `Payment` → `schema.prisma:L4288`
- `PaymentAllocation` → `schema.prisma:L4561`
- `PaymentEffect` → `schema.prisma:L18157`
- `PaymentLink` → `schema.prisma:L14857`
- `PaymentLinkAttribution` → `schema.prisma:L14965`
- `PaymentLinkItem` → `schema.prisma:L14920`
- `PaymentLinkItemModifier` → `schema.prisma:L14947`
- `PaymentProvider` → `schema.prisma:L5745`
- `PayrollLine` → `schema.prisma:L17291`
- `PayrollRun` → `schema.prisma:L17260`
- `PerformanceGoal` → `schema.prisma:L13217`
- `PermissionOverride` → `schema.prisma:L1407`
- `PermissionSet` → `schema.prisma:L1430`
- `PlatformAnnouncement` → `schema.prisma:L17947`
- `PlatformAnnouncementClick` → `schema.prisma:L18012`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18049`
- `PlatformCfdi` → `schema.prisma:L17576`
- `PlatformEmisor` → `schema.prisma:L17516`
- `PlatformSettings` → `schema.prisma:L6167`
- `PosCommand` → `schema.prisma:L9146`
- `PosConnectionStatus` → `schema.prisma:L953`
- `PosSyncIntent` → `schema.prisma:L17654`
- `PricingPolicy` → `schema.prisma:L2764`
- `Printer` → `schema.prisma:L15458`
- `PrintGateway` → `schema.prisma:L15515`
- `PrintJob` → `schema.prisma:L16238`
- `PrintStation` → `schema.prisma:L15533`
- `PrivacyNoticeVersion` → `schema.prisma:L7616`
- `ProcessedStripeEvent` → `schema.prisma:L6804`
- `ProcessorReliabilityMetric` → `schema.prisma:L7289`
- `Product` → `schema.prisma:L1754`
- `ProductModifierGroup` → `schema.prisma:L4225`
- `ProductOption` → `schema.prisma:L15163`
- `ProductOptionValue` → `schema.prisma:L15174`
- `ProductStaff` → `schema.prisma:L14092`
- `PromoterBankAccount` → `schema.prisma:L17411`
- `PromoterCommissionEntry` → `schema.prisma:L17430`
- `PromoterLocationPing` → `schema.prisma:L3697`
- `Promotion` → `schema.prisma:L17705`
- `PromotionGroup` → `schema.prisma:L17744`
- `PromotionOption` → `schema.prisma:L17760`
- `ProviderCostStructure` → `schema.prisma:L6840`
- `ProviderEventLog` → `schema.prisma:L6469`
- `PurchaseOrder` → `schema.prisma:L2489`
- `PurchaseOrderInvoice` → `schema.prisma:L2634`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2691`
- `PurchaseOrderItem` → `schema.prisma:L2547`
- `RateCorrectionBatch` → `schema.prisma:L7065`
- `RateCorrectionEntry` → `schema.prisma:L7107`
- `RawMaterial` → `schema.prisma:L2245`
- `RawMaterialMovement` → `schema.prisma:L2817`
- `RawMaterialPresentation` → `schema.prisma:L2321`
- `ReceiptLayout` → `schema.prisma:L18191`
- `Recipe` → `schema.prisma:L2341`
- `RecipeLine` → `schema.prisma:L2365`
- `Referral` → `schema.prisma:L8334`
- `ReferralProgramConfig` → `schema.prisma:L8299`
- `ReferralRewardGrant` → `schema.prisma:L8425`
- `ReferralTierReward` → `schema.prisma:L8397`
- `ReferralTierUnlock` → `schema.prisma:L8470`
- `RefreshGrant` → `schema.prisma:L18136`
- `Reservation` → `schema.prisma:L13860`
- `ReservationGoogleEventMapping` → `schema.prisma:L14630`
- `ReservationModifier` → `schema.prisma:L14040`
- `ReservationReminderSent` → `schema.prisma:L14023`
- `ReservationSettings` → `schema.prisma:L14254`
- `ReservationWaitlistEntry` → `schema.prisma:L14222`
- `Review` → `schema.prisma:L5122`
- `SalesRetention` → `schema.prisma:L17111`
- `SaleVerification` → `schema.prisma:L4615`
- `ScaleProfile` → `schema.prisma:L15979`
- `ScheduledCommand` → `schema.prisma:L10691`
- `SerializedItem` → `schema.prisma:L12341`
- `SerializedItemCustodyEvent` → `schema.prisma:L12508`
- `ServiceCharge` → `schema.prisma:L8934`
- `Session` → `schema.prisma:L18115`
- `SettlementConfiguration` → `schema.prisma:L7140`
- `SettlementConfirmation` → `schema.prisma:L7253`
- `SettlementIncident` → `schema.prisma:L7204`
- `SettlementSimulation` → `schema.prisma:L7175`
- `Shift` → `schema.prisma:L3320`
- `SimRegistrationRequest` → `schema.prisma:L12546`
- `SimRegistrationRequestItem` → `schema.prisma:L12568`
- `SlotHold` → `schema.prisma:L14123`
- `Staff` → `schema.prisma:L973`
- `StaffDocument` → `schema.prisma:L3568`
- `StaffOnboardingState` → `schema.prisma:L16309`
- `StaffOrganization` → `schema.prisma:L1306`
- `StaffPasskey` → `schema.prisma:L1333`
- `StaffSchedule` → `schema.prisma:L14063`
- `StaffScheduleException` → `schema.prisma:L14075`
- `StaffVenue` → `schema.prisma:L1230`
- `StaffWorkSchedule` → `schema.prisma:L3445`
- `StaffWorkScheduleException` → `schema.prisma:L3543`
- `StampCard` → `schema.prisma:L8182`
- `StampEvent` → `schema.prisma:L8221`
- `StampReward` → `schema.prisma:L8259`
- `StockAlertConfig` → `schema.prisma:L13199`
- `StockBatch` → `schema.prisma:L2983`
- `StockCount` → `schema.prisma:L2900`
- `StockCountItem` → `schema.prisma:L2928`
- `StripeWebhookEvent` → `schema.prisma:L6787`
- `Supplier` → `schema.prisma:L2400`
- `SupplierItemCode` → `schema.prisma:L2732`
- `SupplierPricing` → `schema.prisma:L2455`
- `Table` → `schema.prisma:L3232`
- `Terminal` → `schema.prisma:L5173`
- `TerminalAttemptResolution` → `schema.prisma:L5604`
- `TerminalHealth` → `schema.prisma:L5424`
- `TerminalLog` → `schema.prisma:L5398`
- `TerminalOrder` → `schema.prisma:L5648`
- `TerminalOrderItem` → `schema.prisma:L5723`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5576`
- `TerminalPaymentRequest` → `schema.prisma:L5495`
- `TimeEntry` → `schema.prisma:L3610`
- `TimeEntryBreak` → `schema.prisma:L3679`
- `TokenPurchase` → `schema.prisma:L10365`
- `TokenUsageRecord` → `schema.prisma:L10337`
- `TpvCommandHistory` → `schema.prisma:L10597`
- `TpvCommandQueue` → `schema.prisma:L10537`
- `TpvFeedback` → `schema.prisma:L10250`
- `TpvMessage` → `schema.prisma:L13556`
- `TpvMessageDelivery` → `schema.prisma:L13608`
- `TpvMessageResponse` → `schema.prisma:L13631`
- `TrainingModule` → `schema.prisma:L13686`
- `TrainingProgress` → `schema.prisma:L13763`
- `TrainingQuizQuestion` → `schema.prisma:L13745`
- `TrainingStep` → `schema.prisma:L13725`
- `TransactionCost` → `schema.prisma:L7003`
- `UnitConversion` → `schema.prisma:L2795`
- `UpsellAcceptance` → `schema.prisma:L8755`
- `UpsellAiRun` → `schema.prisma:L8775`
- `UpsellImpression` → `schema.prisma:L8715`
- `UpsellRule` → `schema.prisma:L8635`
- `user_sessions` → `schema.prisma:L6225`
- `Venue` → `schema.prisma:L163`
- `VenueAreaTicketSettings` → `schema.prisma:L15716`
- `VenueChatMessage` → `schema.prisma:L803`
- `VenueChatSession` → `schema.prisma:L758`
- `VenueCommission` → `schema.prisma:L15324`
- `VenueCreditAssessment` → `schema.prisma:L11079`
- `VenueCryptoConfig` → `schema.prisma:L13423`
- `VenueFeature` → `schema.prisma:L4729`
- `VenueModule` → `schema.prisma:L11239`
- `VenuePaymentConfig` → `schema.prisma:L6326`
- `VenuePaymentLinkSettings` → `schema.prisma:L14663`
- `VenuePricingStructure` → `schema.prisma:L6943`
- `VenueRoleConfig` → `schema.prisma:L1459`
- `VenueRolePermission` → `schema.prisma:L1363`
- `VenueScaleSettings` → `schema.prisma:L15967`
- `VenueSettings` → `schema.prisma:L843`
- `VenueTenderType` → `schema.prisma:L4474`
- `VenueTenderTypeRevision` → `schema.prisma:L4539`
- `VenueTransaction` → `schema.prisma:L4666`
- `VenueWhatsappActivation` → `schema.prisma:L694`
- `WalletCardDesign` → `schema.prisma:L8100`
- `WalletPass` → `schema.prisma:L8001`
- `WalletPassRegistration` → `schema.prisma:L8067`
- `WebhookEvent` → `schema.prisma:L5031`
- `WebhookSubscription` → `schema.prisma:L6442`
- `WhatsappContactWindow` → `schema.prisma:L712`
- `WhatsappInboundEvent` → `schema.prisma:L732`
- `WorkShiftAssignment` → `schema.prisma:L3485`
- `WorkShiftTemplate` → `schema.prisma:L3462`
- `Zone` → `schema.prisma:L146`
