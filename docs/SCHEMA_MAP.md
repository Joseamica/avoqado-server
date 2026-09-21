# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **371 models / 356 enums / ~17,800 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                         |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                             |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `InventoryWasteReport`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                               |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                            |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                      |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                                         |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                                 |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                      |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L16479`
- `AccountMapping` → `schema.prisma:L16375`
- `ActivityLog` → `schema.prisma:L6982`
- `Aggregator` → `schema.prisma:L14772`
- `AngelPayUserAccount` → `schema.prisma:L5633`
- `AppUpdate` → `schema.prisma:L12937`
- `Area` → `schema.prisma:L3194`
- `AreaTicket` → `schema.prisma:L15270`
- `AreaTicketCheckoutSession` → `schema.prisma:L15392`
- `AreaTicketExternalIncident` → `schema.prisma:L15639`
- `AreaTicketExternalSettlement` → `schema.prisma:L15604`
- `AreaTicketFulfillment` → `schema.prisma:L15468`
- `AreaTicketInventoryReservation` → `schema.prisma:L15363`
- `AreaTicketLine` → `schema.prisma:L15331`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15424`
- `AreaTicketPrintAttempt` → `schema.prisma:L15447`
- `BankStatement` → `schema.prisma:L16249`
- `BankStatementLine` → `schema.prisma:L16270`
- `BillingTaxProfile` → `schema.prisma:L17059`
- `BirthdayAutomation` → `schema.prisma:L7303`
- `BulkCommandOperation` → `schema.prisma:L10217`
- `CalendarSyncOutbox` → `schema.prisma:L14144`
- `CampaignDelivery` → `schema.prisma:L13095`
- `CashCloseout` → `schema.prisma:L10602`
- `CashDeposit` → `schema.prisma:L12739`
- `CashDrawerEvent` → `schema.prisma:L14609`
- `CashDrawerSession` → `schema.prisma:L14570`
- `CashOutCommissionRate` → `schema.prisma:L16888`
- `CashOutScheduleDay` → `schema.prisma:L16911`
- `CashOutWithdrawal` → `schema.prisma:L16973`
- `CatalogBindingBatch` → `schema.prisma:L11633`
- `CatalogBindingLine` → `schema.prisma:L11669`
- `CatalogBrand` → `schema.prisma:L11086`
- `CatalogClientObservation` → `schema.prisma:L11399`
- `CatalogClientReadinessOverride` → `schema.prisma:L11418`
- `CatalogFamily` → `schema.prisma:L11136`
- `CatalogIdempotencyRecord` → `schema.prisma:L11532`
- `CatalogIdentifier` → `schema.prisma:L11267`
- `CatalogImportBatch` → `schema.prisma:L11575`
- `CatalogImportLine` → `schema.prisma:L11612`
- `CatalogItem` → `schema.prisma:L11169`
- `CatalogItemBusinessType` → `schema.prisma:L11229`
- `CatalogItemPrice` → `schema.prisma:L11317`
- `CatalogManufacturer` → `schema.prisma:L11110`
- `CatalogProductTypeMapping` → `schema.prisma:L11246`
- `CatalogPublicationBatch` → `schema.prisma:L11697`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11791`
- `CatalogPublicationLine` → `schema.prisma:L11738`
- `CatalogPublicationOutbox` → `schema.prisma:L11834`
- `CatalogValidationProfile` → `schema.prisma:L11288`
- `CatalogVenueBinding` → `schema.prisma:L11446`
- `CatalogVenueClientRequirement` → `schema.prisma:L11373`
- `CatalogVenueEventSequence` → `schema.prisma:L11817`
- `CatalogVenueOverride` → `schema.prisma:L11488`
- `CatalogVenueRollout` → `schema.prisma:L11348`
- `Cfdi` → `schema.prisma:L16152`
- `ChatbotTokenBudget` → `schema.prisma:L9865`
- `ChatConversation` → `schema.prisma:L9720`
- `ChatFeedback` → `schema.prisma:L9806`
- `ChatLearningEvent` → `schema.prisma:L9763`
- `ChatMessage` → `schema.prisma:L9743`
- `ChatTrainingData` → `schema.prisma:L9677`
- `CheckoutSession` → `schema.prisma:L5913`
- `ClassSession` → `schema.prisma:L13748`
- `CommissionCalculation` → `schema.prisma:L12515`
- `CommissionClawback` → `schema.prisma:L12691`
- `CommissionConfig` → `schema.prisma:L12281`
- `CommissionMilestone` → `schema.prisma:L12431`
- `CommissionOverride` → `schema.prisma:L12358`
- `CommissionPayout` → `schema.prisma:L12642`
- `CommissionSummary` → `schema.prisma:L12581`
- `CommissionTier` → `schema.prisma:L12395`
- `ConsentEvent` → `schema.prisma:L7165`
- `Consumer` → `schema.prisma:L7395`
- `ConsumerAuthAccount` → `schema.prisma:L7420`
- `CouponCode` → `schema.prisma:L8367`
- `CouponRedemption` → `schema.prisma:L8398`
- `CreditAssessmentHistory` → `schema.prisma:L10711`
- `CreditItemBalance` → `schema.prisma:L14360`
- `CreditOffer` → `schema.prisma:L10730`
- `CreditPack` → `schema.prisma:L14269`
- `CreditPackItem` → `schema.prisma:L14298`
- `CreditPackPurchase` → `schema.prisma:L14315`
- `CreditTransaction` → `schema.prisma:L14382`
- `Customer` → `schema.prisma:L7023`
- `CustomerApprovalDelivery` → `schema.prisma:L9379`
- `CustomerApprovalOutbox` → `schema.prisma:L9354`
- `CustomerCampaign` → `schema.prisma:L7253`
- `CustomerCampaignDelivery` → `schema.prisma:L7335`
- `CustomerCaptureToken` → `schema.prisma:L7201`
- `CustomerDiscount` → `schema.prisma:L8418`
- `CustomerGroup` → `schema.prisma:L7459`
- `CustomerOrderMetric` → `schema.prisma:L3965`
- `CustomerTaxProfile` → `schema.prisma:L16221`
- `DeliveryActivationRequest` → `schema.prisma:L6266`
- `DeliveryChannelLink` → `schema.prisma:L6211`
- `DeliveryOrderEvent` → `schema.prisma:L6290`
- `DeviceToken` → `schema.prisma:L8687`
- `DigitalReceipt` → `schema.prisma:L4543`
- `Discount` → `schema.prisma:L8057`
- `EcommerceMerchant` → `schema.prisma:L5725`
- `EmailQuotaLedger` → `schema.prisma:L7382`
- `EmailSuppression` → `schema.prisma:L7370`
- `EmailTemplate` → `schema.prisma:L13034`
- `Employee` → `schema.prisma:L16736`
- `Estimate` → `schema.prisma:L14679`
- `EstimateItem` → `schema.prisma:L14707`
- `Expense` → `schema.prisma:L16523`
- `ExternalBusyBlock` → `schema.prisma:L14037`
- `Feature` → `schema.prisma:L4672`
- `FeeSchedule` → `schema.prisma:L4757`
- `FeeTier` → `schema.prisma:L4768`
- `FinancialAccount` → `schema.prisma:L14869`
- `FinancialConnection` → `schema.prisma:L14838`
- `FinancialProvider` → `schema.prisma:L14824`
- `FiscalEmisor` → `schema.prisma:L16075`
- `FiscalLossCarryforward` → `schema.prisma:L16646`
- `FixedAsset` → `schema.prisma:L16664`
- `FixedAssetDepreciation` → `schema.prisma:L16693`
- `FloorElement` → `schema.prisma:L3270`
- `FulfillmentArea` → `schema.prisma:L15135`
- `GeofenceRule` → `schema.prisma:L10302`
- `GoogleCalendarChannel` → `schema.prisma:L14014`
- `GoogleCalendarConnection` → `schema.prisma:L13966`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14067`
- `GoogleOAuthSession` → `schema.prisma:L14089`
- `HolidayCalendar` → `schema.prisma:L6906`
- `IdempotencyRequest` → `schema.prisma:L12156`
- `InterVenueTransfer` → `schema.prisma:L3022`
- `InterVenueTransferAllocation` → `schema.prisma:L3105`
- `InterVenueTransferItem` → `schema.prisma:L3074`
- `InterVenueTransferReceipt` → `schema.prisma:L3132`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3148`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3176`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3160`
- `Inventory` → `schema.prisma:L1974`
- `InventoryMovement` → `schema.prisma:L2072`
- `InventoryPosting` → `schema.prisma:L2164`
- `InventoryPostingLine` → `schema.prisma:L2204`
- `InventoryTransfer` → `schema.prisma:L14651`
- `InventoryWasteReport` → `schema.prisma:L2029`
- `Invitation` → `schema.prisma:L1479`
- `Invoice` → `schema.prisma:L4780`
- `InvoiceItem` → `schema.prisma:L4806`
- `ItemCategory` → `schema.prisma:L11869`
- `JournalEntry` → `schema.prisma:L16433`
- `JournalLine` → `schema.prisma:L16461`
- `KdsOrder` → `schema.prisma:L14917`
- `KdsOrderItem` → `schema.prisma:L14958`
- `KioskCheckInAttempt` → `schema.prisma:L17382`
- `KioskCheckInChallenge` → `schema.prisma:L17336`
- `KioskOutreachOutbox` → `schema.prisma:L17403`
- `LaunchCampaign` → `schema.prisma:L17741`
- `LaunchCampaignRedemption` → `schema.prisma:L17847`
- `LearnedPatterns` → `schema.prisma:L9787`
- `LedgerAccount` → `schema.prisma:L16325`
- `LiveDemoSession` → `schema.prisma:L823`
- `LowStockAlert` → `schema.prisma:L2856`
- `LoyaltyConfig` → `schema.prisma:L7489`
- `LoyaltyTransaction` → `schema.prisma:L7532`
- `MarketingCampaign` → `schema.prisma:L13052`
- `McpAuthCode` → `schema.prisma:L15958`
- `McpOAuthClient` → `schema.prisma:L15942`
- `McpRefreshToken` → `schema.prisma:L15976`
- `McpToolCall` → `schema.prisma:L15997`
- `MeasurementUnit` → `schema.prisma:L14757`
- `Menu` → `schema.prisma:L1697`
- `MenuCategory` → `schema.prisma:L1634`
- `MenuCategoryAssignment` → `schema.prisma:L1732`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15872`
- `MerchantAccount` → `schema.prisma:L5463`
- `MerchantFiscalConfig` → `schema.prisma:L16123`
- `MerchantRevenueShare` → `schema.prisma:L6486`
- `MerchantRoutingRule` → `schema.prisma:L5585`
- `MilestoneAchievement` → `schema.prisma:L12476`
- `Modifier` → `schema.prisma:L4149`
- `ModifierGroup` → `schema.prisma:L4113`
- `Module` → `schema.prisma:L10778`
- `MoneyAnomaly` → `schema.prisma:L6389`
- `MonthlyVenueProfit` → `schema.prisma:L6932`
- `Notification` → `schema.prisma:L8589`
- `NotificationPreference` → `schema.prisma:L8636`
- `NotificationTemplate` → `schema.prisma:L8663`
- `OAuthState` → `schema.prisma:L1530`
- `OnboardingProgress` → `schema.prisma:L1548`
- `Order` → `schema.prisma:L3719`
- `OrderAction` → `schema.prisma:L4216`
- `OrderCustomer` → `schema.prisma:L3944`
- `OrderDiscount` → `schema.prisma:L8450`
- `OrderFulfillment` → `schema.prisma:L15190`
- `OrderFulfillmentLine` → `schema.prisma:L15221`
- `OrderItem` → `schema.prisma:L3980`
- `OrderItemModifier` → `schema.prisma:L4198`
- `OrderPromotion` → `schema.prisma:L17299`
- `OrderServiceCharge` → `schema.prisma:L8534`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12853`
- `OrganizationEntitlement` → `schema.prisma:L11061`
- `OrganizationGoal` → `schema.prisma:L12811`
- `OrganizationModule` → `schema.prisma:L10838`
- `OrganizationPaymentConfig` → `schema.prisma:L6037`
- `OrganizationPayoutConfig` → `schema.prisma:L12886`
- `OrganizationPricingStructure` → `schema.prisma:L6069`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12834`
- `OtpChallenge` → `schema.prisma:L7439`
- `OvertimeApproval` → `schema.prisma:L3497`
- `PartnerAPIKey` → `schema.prisma:L5867`
- `Payment` → `schema.prisma:L4249`
- `PaymentAllocation` → `schema.prisma:L4522`
- `PaymentEffect` → `schema.prisma:L17673`
- `PaymentLink` → `schema.prisma:L14428`
- `PaymentLinkAttribution` → `schema.prisma:L14536`
- `PaymentLinkItem` → `schema.prisma:L14491`
- `PaymentLinkItemModifier` → `schema.prisma:L14518`
- `PaymentProvider` → `schema.prisma:L5422`
- `PayrollLine` → `schema.prisma:L16807`
- `PayrollRun` → `schema.prisma:L16776`
- `PerformanceGoal` → `schema.prisma:L12788`
- `PermissionOverride` → `schema.prisma:L1403`
- `PermissionSet` → `schema.prisma:L1426`
- `PlatformAnnouncement` → `schema.prisma:L17463`
- `PlatformAnnouncementClick` → `schema.prisma:L17528`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17565`
- `PlatformCfdi` → `schema.prisma:L17092`
- `PlatformEmisor` → `schema.prisma:L17032`
- `PlatformSettings` → `schema.prisma:L5844`
- `PosCommand` → `schema.prisma:L8717`
- `PosConnectionStatus` → `schema.prisma:L949`
- `PosSyncIntent` → `schema.prisma:L17170`
- `PricingPolicy` → `schema.prisma:L2755`
- `Printer` → `schema.prisma:L15000`
- `PrintGateway` → `schema.prisma:L15057`
- `PrintJob` → `schema.prisma:L15771`
- `PrintStation` → `schema.prisma:L15075`
- `PrivacyNoticeVersion` → `schema.prisma:L7187`
- `ProcessedStripeEvent` → `schema.prisma:L6375`
- `ProcessorReliabilityMetric` → `schema.prisma:L6860`
- `Product` → `schema.prisma:L1750`
- `ProductModifierGroup` → `schema.prisma:L4186`
- `ProductOption` → `schema.prisma:L14734`
- `ProductOptionValue` → `schema.prisma:L14745`
- `ProductStaff` → `schema.prisma:L13663`
- `PromoterBankAccount` → `schema.prisma:L16927`
- `PromoterCommissionEntry` → `schema.prisma:L16946`
- `PromoterLocationPing` → `schema.prisma:L3685`
- `Promotion` → `schema.prisma:L17221`
- `PromotionGroup` → `schema.prisma:L17260`
- `PromotionOption` → `schema.prisma:L17276`
- `ProviderCostStructure` → `schema.prisma:L6411`
- `ProviderEventLog` → `schema.prisma:L6146`
- `PurchaseOrder` → `schema.prisma:L2480`
- `PurchaseOrderInvoice` → `schema.prisma:L2625`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2682`
- `PurchaseOrderItem` → `schema.prisma:L2538`
- `RateCorrectionBatch` → `schema.prisma:L6636`
- `RateCorrectionEntry` → `schema.prisma:L6678`
- `RawMaterial` → `schema.prisma:L2236`
- `RawMaterialMovement` → `schema.prisma:L2808`
- `RawMaterialPresentation` → `schema.prisma:L2312`
- `ReceiptLayout` → `schema.prisma:L17707`
- `Recipe` → `schema.prisma:L2332`
- `RecipeLine` → `schema.prisma:L2356`
- `Referral` → `schema.prisma:L7905`
- `ReferralProgramConfig` → `schema.prisma:L7870`
- `ReferralRewardGrant` → `schema.prisma:L7996`
- `ReferralTierReward` → `schema.prisma:L7968`
- `ReferralTierUnlock` → `schema.prisma:L8041`
- `RefreshGrant` → `schema.prisma:L17652`
- `Reservation` → `schema.prisma:L13431`
- `ReservationGoogleEventMapping` → `schema.prisma:L14201`
- `ReservationModifier` → `schema.prisma:L13611`
- `ReservationReminderSent` → `schema.prisma:L13594`
- `ReservationSettings` → `schema.prisma:L13825`
- `ReservationWaitlistEntry` → `schema.prisma:L13793`
- `Review` → `schema.prisma:L4824`
- `SalesRetention` → `schema.prisma:L16627`
- `SaleVerification` → `schema.prisma:L4576`
- `ScaleProfile` → `schema.prisma:L15512`
- `ScheduledCommand` → `schema.prisma:L10262`
- `SerializedItem` → `schema.prisma:L11912`
- `SerializedItemCustodyEvent` → `schema.prisma:L12079`
- `ServiceCharge` → `schema.prisma:L8505`
- `Session` → `schema.prisma:L17631`
- `SettlementConfiguration` → `schema.prisma:L6711`
- `SettlementConfirmation` → `schema.prisma:L6824`
- `SettlementIncident` → `schema.prisma:L6775`
- `SettlementSimulation` → `schema.prisma:L6746`
- `Shift` → `schema.prisma:L3308`
- `SimRegistrationRequest` → `schema.prisma:L12117`
- `SimRegistrationRequestItem` → `schema.prisma:L12139`
- `SlotHold` → `schema.prisma:L13694`
- `Staff` → `schema.prisma:L969`
- `StaffDocument` → `schema.prisma:L3556`
- `StaffOnboardingState` → `schema.prisma:L15842`
- `StaffOrganization` → `schema.prisma:L1302`
- `StaffPasskey` → `schema.prisma:L1329`
- `StaffSchedule` → `schema.prisma:L13634`
- `StaffScheduleException` → `schema.prisma:L13646`
- `StaffVenue` → `schema.prisma:L1226`
- `StaffWorkSchedule` → `schema.prisma:L3433`
- `StaffWorkScheduleException` → `schema.prisma:L3531`
- `StampCard` → `schema.prisma:L7753`
- `StampEvent` → `schema.prisma:L7792`
- `StampReward` → `schema.prisma:L7830`
- `StockAlertConfig` → `schema.prisma:L12770`
- `StockBatch` → `schema.prisma:L2971`
- `StockCount` → `schema.prisma:L2888`
- `StockCountItem` → `schema.prisma:L2916`
- `StripeWebhookEvent` → `schema.prisma:L6358`
- `Supplier` → `schema.prisma:L2391`
- `SupplierItemCode` → `schema.prisma:L2723`
- `SupplierPricing` → `schema.prisma:L2446`
- `Table` → `schema.prisma:L3220`
- `Terminal` → `schema.prisma:L4875`
- `TerminalHealth` → `schema.prisma:L5126`
- `TerminalLog` → `schema.prisma:L5100`
- `TerminalOrder` → `schema.prisma:L5325`
- `TerminalOrderItem` → `schema.prisma:L5400`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5278`
- `TerminalPaymentRequest` → `schema.prisma:L5197`
- `TimeEntry` → `schema.prisma:L3598`
- `TimeEntryBreak` → `schema.prisma:L3667`
- `TokenPurchase` → `schema.prisma:L9936`
- `TokenUsageRecord` → `schema.prisma:L9908`
- `TpvCommandHistory` → `schema.prisma:L10168`
- `TpvCommandQueue` → `schema.prisma:L10108`
- `TpvFeedback` → `schema.prisma:L9821`
- `TpvMessage` → `schema.prisma:L13127`
- `TpvMessageDelivery` → `schema.prisma:L13179`
- `TpvMessageResponse` → `schema.prisma:L13202`
- `TrainingModule` → `schema.prisma:L13257`
- `TrainingProgress` → `schema.prisma:L13334`
- `TrainingQuizQuestion` → `schema.prisma:L13316`
- `TrainingStep` → `schema.prisma:L13296`
- `TransactionCost` → `schema.prisma:L6574`
- `UnitConversion` → `schema.prisma:L2786`
- `UpsellAcceptance` → `schema.prisma:L8326`
- `UpsellAiRun` → `schema.prisma:L8346`
- `UpsellImpression` → `schema.prisma:L8286`
- `UpsellRule` → `schema.prisma:L8206`
- `user_sessions` → `schema.prisma:L5902`
- `Venue` → `schema.prisma:L163`
- `VenueAreaTicketSettings` → `schema.prisma:L15249`
- `VenueChatMessage` → `schema.prisma:L799`
- `VenueChatSession` → `schema.prisma:L754`
- `VenueCommission` → `schema.prisma:L14895`
- `VenueCreditAssessment` → `schema.prisma:L10650`
- `VenueCryptoConfig` → `schema.prisma:L12994`
- `VenueFeature` → `schema.prisma:L4690`
- `VenueModule` → `schema.prisma:L10810`
- `VenuePaymentConfig` → `schema.prisma:L6003`
- `VenuePaymentLinkSettings` → `schema.prisma:L14234`
- `VenuePricingStructure` → `schema.prisma:L6514`
- `VenueRoleConfig` → `schema.prisma:L1455`
- `VenueRolePermission` → `schema.prisma:L1359`
- `VenueScaleSettings` → `schema.prisma:L15500`
- `VenueSettings` → `schema.prisma:L839`
- `VenueTenderType` → `schema.prisma:L4435`
- `VenueTenderTypeRevision` → `schema.prisma:L4500`
- `VenueTransaction` → `schema.prisma:L4627`
- `VenueWhatsappActivation` → `schema.prisma:L690`
- `WalletCardDesign` → `schema.prisma:L7671`
- `WalletPass` → `schema.prisma:L7572`
- `WalletPassRegistration` → `schema.prisma:L7638`
- `WebhookEvent` → `schema.prisma:L4733`
- `WebhookSubscription` → `schema.prisma:L6119`
- `WhatsappContactWindow` → `schema.prisma:L708`
- `WhatsappInboundEvent` → `schema.prisma:L728`
- `WorkShiftAssignment` → `schema.prisma:L3473`
- `WorkShiftTemplate` → `schema.prisma:L3450`
- `Zone` → `schema.prisma:L146`
