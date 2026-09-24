# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **376 models / 358 enums / ~18,100 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L16704`
- `AccountMapping` → `schema.prisma:L16600`
- `ActivityLog` → `schema.prisma:L7182`
- `Aggregator` → `schema.prisma:L14972`
- `AngelPayUserAccount` → `schema.prisma:L5727`
- `AppUpdate` → `schema.prisma:L13137`
- `Area` → `schema.prisma:L3202`
- `AreaTicket` → `schema.prisma:L15485`
- `AreaTicketCheckoutSession` → `schema.prisma:L15607`
- `AreaTicketExternalIncident` → `schema.prisma:L15854`
- `AreaTicketExternalSettlement` → `schema.prisma:L15819`
- `AreaTicketFulfillment` → `schema.prisma:L15683`
- `AreaTicketInventoryReservation` → `schema.prisma:L15578`
- `AreaTicketLine` → `schema.prisma:L15546`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15639`
- `AreaTicketPrintAttempt` → `schema.prisma:L15662`
- `BankStatement` → `schema.prisma:L16474`
- `BankStatementLine` → `schema.prisma:L16495`
- `BillingObligationConflict` → `schema.prisma:L4764`
- `BillingTaxProfile` → `schema.prisma:L17284`
- `BirthdayAutomation` → `schema.prisma:L7503`
- `BulkCommandOperation` → `schema.prisma:L10417`
- `CalendarSyncOutbox` → `schema.prisma:L14344`
- `CampaignDelivery` → `schema.prisma:L13295`
- `CashCloseout` → `schema.prisma:L10802`
- `CashDeposit` → `schema.prisma:L12939`
- `CashDrawerEvent` → `schema.prisma:L14809`
- `CashDrawerSession` → `schema.prisma:L14770`
- `CashOutCommissionRate` → `schema.prisma:L17113`
- `CashOutScheduleDay` → `schema.prisma:L17136`
- `CashOutWithdrawal` → `schema.prisma:L17198`
- `CatalogBindingBatch` → `schema.prisma:L11833`
- `CatalogBindingLine` → `schema.prisma:L11869`
- `CatalogBrand` → `schema.prisma:L11286`
- `CatalogClientObservation` → `schema.prisma:L11599`
- `CatalogClientReadinessOverride` → `schema.prisma:L11618`
- `CatalogFamily` → `schema.prisma:L11336`
- `CatalogIdempotencyRecord` → `schema.prisma:L11732`
- `CatalogIdentifier` → `schema.prisma:L11467`
- `CatalogImportBatch` → `schema.prisma:L11775`
- `CatalogImportLine` → `schema.prisma:L11812`
- `CatalogItem` → `schema.prisma:L11369`
- `CatalogItemBusinessType` → `schema.prisma:L11429`
- `CatalogItemPrice` → `schema.prisma:L11517`
- `CatalogManufacturer` → `schema.prisma:L11310`
- `CatalogProductTypeMapping` → `schema.prisma:L11446`
- `CatalogPublicationBatch` → `schema.prisma:L11897`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11991`
- `CatalogPublicationLine` → `schema.prisma:L11938`
- `CatalogPublicationOutbox` → `schema.prisma:L12034`
- `CatalogValidationProfile` → `schema.prisma:L11488`
- `CatalogVenueBinding` → `schema.prisma:L11646`
- `CatalogVenueClientRequirement` → `schema.prisma:L11573`
- `CatalogVenueEventSequence` → `schema.prisma:L12017`
- `CatalogVenueOverride` → `schema.prisma:L11688`
- `CatalogVenueRollout` → `schema.prisma:L11548`
- `Cfdi` → `schema.prisma:L16367`
- `ChatbotTokenBudget` → `schema.prisma:L10065`
- `ChatConversation` → `schema.prisma:L9920`
- `ChatFeedback` → `schema.prisma:L10006`
- `ChatLearningEvent` → `schema.prisma:L9963`
- `ChatMessage` → `schema.prisma:L9943`
- `ChatTrainingData` → `schema.prisma:L9877`
- `CheckoutSession` → `schema.prisma:L6007`
- `ClassSession` → `schema.prisma:L13948`
- `CommissionCalculation` → `schema.prisma:L12715`
- `CommissionClawback` → `schema.prisma:L12891`
- `CommissionConfig` → `schema.prisma:L12481`
- `CommissionMilestone` → `schema.prisma:L12631`
- `CommissionOverride` → `schema.prisma:L12558`
- `CommissionPayout` → `schema.prisma:L12842`
- `CommissionSummary` → `schema.prisma:L12781`
- `CommissionTier` → `schema.prisma:L12595`
- `ConsentEvent` → `schema.prisma:L7365`
- `Consumer` → `schema.prisma:L7595`
- `ConsumerAuthAccount` → `schema.prisma:L7620`
- `CouponCode` → `schema.prisma:L8567`
- `CouponRedemption` → `schema.prisma:L8598`
- `CreditAssessmentHistory` → `schema.prisma:L10911`
- `CreditItemBalance` → `schema.prisma:L14560`
- `CreditOffer` → `schema.prisma:L10930`
- `CreditPack` → `schema.prisma:L14469`
- `CreditPackItem` → `schema.prisma:L14498`
- `CreditPackPurchase` → `schema.prisma:L14515`
- `CreditTransaction` → `schema.prisma:L14582`
- `Customer` → `schema.prisma:L7223`
- `CustomerApprovalDelivery` → `schema.prisma:L9579`
- `CustomerApprovalOutbox` → `schema.prisma:L9554`
- `CustomerCampaign` → `schema.prisma:L7453`
- `CustomerCampaignDelivery` → `schema.prisma:L7535`
- `CustomerCaptureToken` → `schema.prisma:L7401`
- `CustomerDiscount` → `schema.prisma:L8618`
- `CustomerGroup` → `schema.prisma:L7659`
- `CustomerOrderMetric` → `schema.prisma:L3990`
- `CustomerTaxProfile` → `schema.prisma:L16446`
- `DeliveryActivationRequest` → `schema.prisma:L6466`
- `DeliveryChannelLink` → `schema.prisma:L6305`
- `DeliveryConnectIntent` → `schema.prisma:L6417`
- `DeliveryLineAction` → `schema.prisma:L6378`
- `DeliveryOrderEvent` → `schema.prisma:L6490`
- `DeliveryStoreRevocation` → `schema.prisma:L6454`
- `DeviceToken` → `schema.prisma:L8887`
- `DigitalReceipt` → `schema.prisma:L4573`
- `Discount` → `schema.prisma:L8257`
- `EcommerceMerchant` → `schema.prisma:L5819`
- `EmailQuotaLedger` → `schema.prisma:L7582`
- `EmailSuppression` → `schema.prisma:L7570`
- `EmailTemplate` → `schema.prisma:L13234`
- `Employee` → `schema.prisma:L16961`
- `Estimate` → `schema.prisma:L14879`
- `EstimateItem` → `schema.prisma:L14907`
- `Expense` → `schema.prisma:L16748`
- `ExternalBusyBlock` → `schema.prisma:L14237`
- `Feature` → `schema.prisma:L4702`
- `FeeSchedule` → `schema.prisma:L4826`
- `FeeTier` → `schema.prisma:L4837`
- `FinancialAccount` → `schema.prisma:L15069`
- `FinancialConnection` → `schema.prisma:L15038`
- `FinancialProvider` → `schema.prisma:L15024`
- `FiscalEmisor` → `schema.prisma:L16290`
- `FiscalLossCarryforward` → `schema.prisma:L16871`
- `FixedAsset` → `schema.prisma:L16889`
- `FixedAssetDepreciation` → `schema.prisma:L16918`
- `FloorElement` → `schema.prisma:L3278`
- `FulfillmentArea` → `schema.prisma:L15350`
- `GeofenceRule` → `schema.prisma:L10502`
- `GoogleCalendarChannel` → `schema.prisma:L14214`
- `GoogleCalendarConnection` → `schema.prisma:L14166`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14267`
- `GoogleOAuthSession` → `schema.prisma:L14289`
- `HolidayCalendar` → `schema.prisma:L7106`
- `IdempotencyRequest` → `schema.prisma:L12356`
- `InterVenueTransfer` → `schema.prisma:L3030`
- `InterVenueTransferAllocation` → `schema.prisma:L3113`
- `InterVenueTransferItem` → `schema.prisma:L3082`
- `InterVenueTransferReceipt` → `schema.prisma:L3140`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3156`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3184`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3168`
- `Inventory` → `schema.prisma:L1974`
- `InventoryMovement` → `schema.prisma:L2074`
- `InventoryPosting` → `schema.prisma:L2169`
- `InventoryPostingLine` → `schema.prisma:L2209`
- `InventoryTransfer` → `schema.prisma:L14851`
- `InventoryWasteReport` → `schema.prisma:L2029`
- `Invitation` → `schema.prisma:L1479`
- `Invoice` → `schema.prisma:L4849`
- `InvoiceItem` → `schema.prisma:L4875`
- `ItemCategory` → `schema.prisma:L12069`
- `JournalEntry` → `schema.prisma:L16658`
- `JournalLine` → `schema.prisma:L16686`
- `KdsOrder` → `schema.prisma:L15117`
- `KdsOrderItem` → `schema.prisma:L15166`
- `KioskCheckInAttempt` → `schema.prisma:L17607`
- `KioskCheckInChallenge` → `schema.prisma:L17561`
- `KioskOutreachOutbox` → `schema.prisma:L17628`
- `LaunchCampaign` → `schema.prisma:L17966`
- `LaunchCampaignRedemption` → `schema.prisma:L18083`
- `LearnedPatterns` → `schema.prisma:L9987`
- `LedgerAccount` → `schema.prisma:L16550`
- `LiveDemoSession` → `schema.prisma:L823`
- `LowStockAlert` → `schema.prisma:L2864`
- `LoyaltyConfig` → `schema.prisma:L7689`
- `LoyaltyTransaction` → `schema.prisma:L7732`
- `MarketingCampaign` → `schema.prisma:L13252`
- `McpAuthCode` → `schema.prisma:L16173`
- `McpOAuthClient` → `schema.prisma:L16157`
- `McpRefreshToken` → `schema.prisma:L16191`
- `McpToolCall` → `schema.prisma:L16212`
- `MeasurementUnit` → `schema.prisma:L14957`
- `Menu` → `schema.prisma:L1697`
- `MenuCategory` → `schema.prisma:L1634`
- `MenuCategoryAssignment` → `schema.prisma:L1732`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16087`
- `MerchantAccount` → `schema.prisma:L5557`
- `MerchantFiscalConfig` → `schema.prisma:L16338`
- `MerchantRevenueShare` → `schema.prisma:L6686`
- `MerchantRoutingRule` → `schema.prisma:L5679`
- `MilestoneAchievement` → `schema.prisma:L12676`
- `Modifier` → `schema.prisma:L4179`
- `ModifierGroup` → `schema.prisma:L4143`
- `Module` → `schema.prisma:L10978`
- `MoneyAnomaly` → `schema.prisma:L6589`
- `MonthlyVenueProfit` → `schema.prisma:L7132`
- `Notification` → `schema.prisma:L8789`
- `NotificationPreference` → `schema.prisma:L8836`
- `NotificationTemplate` → `schema.prisma:L8863`
- `OAuthState` → `schema.prisma:L1530`
- `OnboardingProgress` → `schema.prisma:L1548`
- `Order` → `schema.prisma:L3727`
- `OrderAction` → `schema.prisma:L4246`
- `OrderCustomer` → `schema.prisma:L3969`
- `OrderDiscount` → `schema.prisma:L8650`
- `OrderFulfillment` → `schema.prisma:L15405`
- `OrderFulfillmentLine` → `schema.prisma:L15436`
- `OrderItem` → `schema.prisma:L4005`
- `OrderItemModifier` → `schema.prisma:L4228`
- `OrderPromotion` → `schema.prisma:L17524`
- `OrderServiceCharge` → `schema.prisma:L8734`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13053`
- `OrganizationEntitlement` → `schema.prisma:L11261`
- `OrganizationGoal` → `schema.prisma:L13011`
- `OrganizationModule` → `schema.prisma:L11038`
- `OrganizationPaymentConfig` → `schema.prisma:L6131`
- `OrganizationPayoutConfig` → `schema.prisma:L13086`
- `OrganizationPricingStructure` → `schema.prisma:L6163`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13034`
- `OtpChallenge` → `schema.prisma:L7639`
- `OvertimeApproval` → `schema.prisma:L3505`
- `PartnerAPIKey` → `schema.prisma:L5961`
- `Payment` → `schema.prisma:L4279`
- `PaymentAllocation` → `schema.prisma:L4552`
- `PaymentEffect` → `schema.prisma:L17898`
- `PaymentLink` → `schema.prisma:L14628`
- `PaymentLinkAttribution` → `schema.prisma:L14736`
- `PaymentLinkItem` → `schema.prisma:L14691`
- `PaymentLinkItemModifier` → `schema.prisma:L14718`
- `PaymentProvider` → `schema.prisma:L5516`
- `PayrollLine` → `schema.prisma:L17032`
- `PayrollRun` → `schema.prisma:L17001`
- `PerformanceGoal` → `schema.prisma:L12988`
- `PermissionOverride` → `schema.prisma:L1403`
- `PermissionSet` → `schema.prisma:L1426`
- `PlatformAnnouncement` → `schema.prisma:L17688`
- `PlatformAnnouncementClick` → `schema.prisma:L17753`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17790`
- `PlatformCfdi` → `schema.prisma:L17317`
- `PlatformEmisor` → `schema.prisma:L17257`
- `PlatformSettings` → `schema.prisma:L5938`
- `PosCommand` → `schema.prisma:L8917`
- `PosConnectionStatus` → `schema.prisma:L949`
- `PosSyncIntent` → `schema.prisma:L17395`
- `PricingPolicy` → `schema.prisma:L2760`
- `Printer` → `schema.prisma:L15215`
- `PrintGateway` → `schema.prisma:L15272`
- `PrintJob` → `schema.prisma:L15986`
- `PrintStation` → `schema.prisma:L15290`
- `PrivacyNoticeVersion` → `schema.prisma:L7387`
- `ProcessedStripeEvent` → `schema.prisma:L6575`
- `ProcessorReliabilityMetric` → `schema.prisma:L7060`
- `Product` → `schema.prisma:L1750`
- `ProductModifierGroup` → `schema.prisma:L4216`
- `ProductOption` → `schema.prisma:L14934`
- `ProductOptionValue` → `schema.prisma:L14945`
- `ProductStaff` → `schema.prisma:L13863`
- `PromoterBankAccount` → `schema.prisma:L17152`
- `PromoterCommissionEntry` → `schema.prisma:L17171`
- `PromoterLocationPing` → `schema.prisma:L3693`
- `Promotion` → `schema.prisma:L17446`
- `PromotionGroup` → `schema.prisma:L17485`
- `PromotionOption` → `schema.prisma:L17501`
- `ProviderCostStructure` → `schema.prisma:L6611`
- `ProviderEventLog` → `schema.prisma:L6240`
- `PurchaseOrder` → `schema.prisma:L2485`
- `PurchaseOrderInvoice` → `schema.prisma:L2630`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2687`
- `PurchaseOrderItem` → `schema.prisma:L2543`
- `RateCorrectionBatch` → `schema.prisma:L6836`
- `RateCorrectionEntry` → `schema.prisma:L6878`
- `RawMaterial` → `schema.prisma:L2241`
- `RawMaterialMovement` → `schema.prisma:L2813`
- `RawMaterialPresentation` → `schema.prisma:L2317`
- `ReceiptLayout` → `schema.prisma:L17932`
- `Recipe` → `schema.prisma:L2337`
- `RecipeLine` → `schema.prisma:L2361`
- `Referral` → `schema.prisma:L8105`
- `ReferralProgramConfig` → `schema.prisma:L8070`
- `ReferralRewardGrant` → `schema.prisma:L8196`
- `ReferralTierReward` → `schema.prisma:L8168`
- `ReferralTierUnlock` → `schema.prisma:L8241`
- `RefreshGrant` → `schema.prisma:L17877`
- `Reservation` → `schema.prisma:L13631`
- `ReservationGoogleEventMapping` → `schema.prisma:L14401`
- `ReservationModifier` → `schema.prisma:L13811`
- `ReservationReminderSent` → `schema.prisma:L13794`
- `ReservationSettings` → `schema.prisma:L14025`
- `ReservationWaitlistEntry` → `schema.prisma:L13993`
- `Review` → `schema.prisma:L4893`
- `SalesRetention` → `schema.prisma:L16852`
- `SaleVerification` → `schema.prisma:L4606`
- `ScaleProfile` → `schema.prisma:L15727`
- `ScheduledCommand` → `schema.prisma:L10462`
- `SerializedItem` → `schema.prisma:L12112`
- `SerializedItemCustodyEvent` → `schema.prisma:L12279`
- `ServiceCharge` → `schema.prisma:L8705`
- `Session` → `schema.prisma:L17856`
- `SettlementConfiguration` → `schema.prisma:L6911`
- `SettlementConfirmation` → `schema.prisma:L7024`
- `SettlementIncident` → `schema.prisma:L6975`
- `SettlementSimulation` → `schema.prisma:L6946`
- `Shift` → `schema.prisma:L3316`
- `SimRegistrationRequest` → `schema.prisma:L12317`
- `SimRegistrationRequestItem` → `schema.prisma:L12339`
- `SlotHold` → `schema.prisma:L13894`
- `Staff` → `schema.prisma:L969`
- `StaffDocument` → `schema.prisma:L3564`
- `StaffOnboardingState` → `schema.prisma:L16057`
- `StaffOrganization` → `schema.prisma:L1302`
- `StaffPasskey` → `schema.prisma:L1329`
- `StaffSchedule` → `schema.prisma:L13834`
- `StaffScheduleException` → `schema.prisma:L13846`
- `StaffVenue` → `schema.prisma:L1226`
- `StaffWorkSchedule` → `schema.prisma:L3441`
- `StaffWorkScheduleException` → `schema.prisma:L3539`
- `StampCard` → `schema.prisma:L7953`
- `StampEvent` → `schema.prisma:L7992`
- `StampReward` → `schema.prisma:L8030`
- `StockAlertConfig` → `schema.prisma:L12970`
- `StockBatch` → `schema.prisma:L2979`
- `StockCount` → `schema.prisma:L2896`
- `StockCountItem` → `schema.prisma:L2924`
- `StripeWebhookEvent` → `schema.prisma:L6558`
- `Supplier` → `schema.prisma:L2396`
- `SupplierItemCode` → `schema.prisma:L2728`
- `SupplierPricing` → `schema.prisma:L2451`
- `Table` → `schema.prisma:L3228`
- `Terminal` → `schema.prisma:L4944`
- `TerminalAttemptResolution` → `schema.prisma:L5375`
- `TerminalHealth` → `schema.prisma:L5195`
- `TerminalLog` → `schema.prisma:L5169`
- `TerminalOrder` → `schema.prisma:L5419`
- `TerminalOrderItem` → `schema.prisma:L5494`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5347`
- `TerminalPaymentRequest` → `schema.prisma:L5266`
- `TimeEntry` → `schema.prisma:L3606`
- `TimeEntryBreak` → `schema.prisma:L3675`
- `TokenPurchase` → `schema.prisma:L10136`
- `TokenUsageRecord` → `schema.prisma:L10108`
- `TpvCommandHistory` → `schema.prisma:L10368`
- `TpvCommandQueue` → `schema.prisma:L10308`
- `TpvFeedback` → `schema.prisma:L10021`
- `TpvMessage` → `schema.prisma:L13327`
- `TpvMessageDelivery` → `schema.prisma:L13379`
- `TpvMessageResponse` → `schema.prisma:L13402`
- `TrainingModule` → `schema.prisma:L13457`
- `TrainingProgress` → `schema.prisma:L13534`
- `TrainingQuizQuestion` → `schema.prisma:L13516`
- `TrainingStep` → `schema.prisma:L13496`
- `TransactionCost` → `schema.prisma:L6774`
- `UnitConversion` → `schema.prisma:L2791`
- `UpsellAcceptance` → `schema.prisma:L8526`
- `UpsellAiRun` → `schema.prisma:L8546`
- `UpsellImpression` → `schema.prisma:L8486`
- `UpsellRule` → `schema.prisma:L8406`
- `user_sessions` → `schema.prisma:L5996`
- `Venue` → `schema.prisma:L163`
- `VenueAreaTicketSettings` → `schema.prisma:L15464`
- `VenueChatMessage` → `schema.prisma:L799`
- `VenueChatSession` → `schema.prisma:L754`
- `VenueCommission` → `schema.prisma:L15095`
- `VenueCreditAssessment` → `schema.prisma:L10850`
- `VenueCryptoConfig` → `schema.prisma:L13194`
- `VenueFeature` → `schema.prisma:L4720`
- `VenueModule` → `schema.prisma:L11010`
- `VenuePaymentConfig` → `schema.prisma:L6097`
- `VenuePaymentLinkSettings` → `schema.prisma:L14434`
- `VenuePricingStructure` → `schema.prisma:L6714`
- `VenueRoleConfig` → `schema.prisma:L1455`
- `VenueRolePermission` → `schema.prisma:L1359`
- `VenueScaleSettings` → `schema.prisma:L15715`
- `VenueSettings` → `schema.prisma:L839`
- `VenueTenderType` → `schema.prisma:L4465`
- `VenueTenderTypeRevision` → `schema.prisma:L4530`
- `VenueTransaction` → `schema.prisma:L4657`
- `VenueWhatsappActivation` → `schema.prisma:L690`
- `WalletCardDesign` → `schema.prisma:L7871`
- `WalletPass` → `schema.prisma:L7772`
- `WalletPassRegistration` → `schema.prisma:L7838`
- `WebhookEvent` → `schema.prisma:L4802`
- `WebhookSubscription` → `schema.prisma:L6213`
- `WhatsappContactWindow` → `schema.prisma:L708`
- `WhatsappInboundEvent` → `schema.prisma:L728`
- `WorkShiftAssignment` → `schema.prisma:L3481`
- `WorkShiftTemplate` → `schema.prisma:L3458`
- `Zone` → `schema.prisma:L146`
