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

- `AccountingPeriodLock` → `schema.prisma:L16730`
- `AccountMapping` → `schema.prisma:L16626`
- `ActivityLog` → `schema.prisma:L7201`
- `Aggregator` → `schema.prisma:L14991`
- `AngelPayUserAccount` → `schema.prisma:L5746`
- `AppUpdate` → `schema.prisma:L13156`
- `Area` → `schema.prisma:L3221`
- `AreaTicket` → `schema.prisma:L15504`
- `AreaTicketCheckoutSession` → `schema.prisma:L15626`
- `AreaTicketExternalIncident` → `schema.prisma:L15873`
- `AreaTicketExternalSettlement` → `schema.prisma:L15838`
- `AreaTicketFulfillment` → `schema.prisma:L15702`
- `AreaTicketInventoryReservation` → `schema.prisma:L15597`
- `AreaTicketLine` → `schema.prisma:L15565`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15658`
- `AreaTicketPrintAttempt` → `schema.prisma:L15681`
- `BankStatement` → `schema.prisma:L16500`
- `BankStatementLine` → `schema.prisma:L16521`
- `BillingObligationConflict` → `schema.prisma:L4783`
- `BillingTaxProfile` → `schema.prisma:L17322`
- `BirthdayAutomation` → `schema.prisma:L7522`
- `BulkCommandOperation` → `schema.prisma:L10436`
- `CalendarSyncOutbox` → `schema.prisma:L14363`
- `CampaignDelivery` → `schema.prisma:L13314`
- `CashCloseout` → `schema.prisma:L10821`
- `CashDeposit` → `schema.prisma:L12958`
- `CashDrawerEvent` → `schema.prisma:L14828`
- `CashDrawerSession` → `schema.prisma:L14789`
- `CashOutCommissionRate` → `schema.prisma:L17139`
- `CashOutScheduleDay` → `schema.prisma:L17162`
- `CashOutWithdrawal` → `schema.prisma:L17224`
- `CatalogBindingBatch` → `schema.prisma:L11852`
- `CatalogBindingLine` → `schema.prisma:L11888`
- `CatalogBrand` → `schema.prisma:L11305`
- `CatalogClientObservation` → `schema.prisma:L11618`
- `CatalogClientReadinessOverride` → `schema.prisma:L11637`
- `CatalogFamily` → `schema.prisma:L11355`
- `CatalogIdempotencyRecord` → `schema.prisma:L11751`
- `CatalogIdentifier` → `schema.prisma:L11486`
- `CatalogImportBatch` → `schema.prisma:L11794`
- `CatalogImportLine` → `schema.prisma:L11831`
- `CatalogItem` → `schema.prisma:L11388`
- `CatalogItemBusinessType` → `schema.prisma:L11448`
- `CatalogItemPrice` → `schema.prisma:L11536`
- `CatalogManufacturer` → `schema.prisma:L11329`
- `CatalogProductTypeMapping` → `schema.prisma:L11465`
- `CatalogPublicationBatch` → `schema.prisma:L11916`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12010`
- `CatalogPublicationLine` → `schema.prisma:L11957`
- `CatalogPublicationOutbox` → `schema.prisma:L12053`
- `CatalogValidationProfile` → `schema.prisma:L11507`
- `CatalogVenueBinding` → `schema.prisma:L11665`
- `CatalogVenueClientRequirement` → `schema.prisma:L11592`
- `CatalogVenueEventSequence` → `schema.prisma:L12036`
- `CatalogVenueOverride` → `schema.prisma:L11707`
- `CatalogVenueRollout` → `schema.prisma:L11567`
- `Cfdi` → `schema.prisma:L16393`
- `ChatbotTokenBudget` → `schema.prisma:L10084`
- `ChatConversation` → `schema.prisma:L9939`
- `ChatFeedback` → `schema.prisma:L10025`
- `ChatLearningEvent` → `schema.prisma:L9982`
- `ChatMessage` → `schema.prisma:L9962`
- `ChatTrainingData` → `schema.prisma:L9896`
- `CheckoutSession` → `schema.prisma:L6026`
- `ClassSession` → `schema.prisma:L13967`
- `CommissionCalculation` → `schema.prisma:L12734`
- `CommissionClawback` → `schema.prisma:L12910`
- `CommissionConfig` → `schema.prisma:L12500`
- `CommissionMilestone` → `schema.prisma:L12650`
- `CommissionOverride` → `schema.prisma:L12577`
- `CommissionPayout` → `schema.prisma:L12861`
- `CommissionSummary` → `schema.prisma:L12800`
- `CommissionTier` → `schema.prisma:L12614`
- `ConsentEvent` → `schema.prisma:L7384`
- `Consumer` → `schema.prisma:L7614`
- `ConsumerAuthAccount` → `schema.prisma:L7639`
- `CouponCode` → `schema.prisma:L8586`
- `CouponRedemption` → `schema.prisma:L8617`
- `CreditAssessmentHistory` → `schema.prisma:L10930`
- `CreditItemBalance` → `schema.prisma:L14579`
- `CreditOffer` → `schema.prisma:L10949`
- `CreditPack` → `schema.prisma:L14488`
- `CreditPackItem` → `schema.prisma:L14517`
- `CreditPackPurchase` → `schema.prisma:L14534`
- `CreditTransaction` → `schema.prisma:L14601`
- `Customer` → `schema.prisma:L7242`
- `CustomerApprovalDelivery` → `schema.prisma:L9598`
- `CustomerApprovalOutbox` → `schema.prisma:L9573`
- `CustomerCampaign` → `schema.prisma:L7472`
- `CustomerCampaignDelivery` → `schema.prisma:L7554`
- `CustomerCaptureToken` → `schema.prisma:L7420`
- `CustomerDiscount` → `schema.prisma:L8637`
- `CustomerGroup` → `schema.prisma:L7678`
- `CustomerOrderMetric` → `schema.prisma:L4009`
- `CustomerTaxProfile` → `schema.prisma:L16472`
- `DeliveryActivationRequest` → `schema.prisma:L6485`
- `DeliveryChannelLink` → `schema.prisma:L6324`
- `DeliveryConnectIntent` → `schema.prisma:L6436`
- `DeliveryLineAction` → `schema.prisma:L6397`
- `DeliveryOrderEvent` → `schema.prisma:L6509`
- `DeliveryStoreRevocation` → `schema.prisma:L6473`
- `DeviceToken` → `schema.prisma:L8906`
- `DigitalReceipt` → `schema.prisma:L4592`
- `Discount` → `schema.prisma:L8276`
- `EcommerceMerchant` → `schema.prisma:L5838`
- `EmailQuotaLedger` → `schema.prisma:L7601`
- `EmailSuppression` → `schema.prisma:L7589`
- `EmailTemplate` → `schema.prisma:L13253`
- `Employee` → `schema.prisma:L16987`
- `Estimate` → `schema.prisma:L14898`
- `EstimateItem` → `schema.prisma:L14926`
- `Expense` → `schema.prisma:L16774`
- `ExternalBusyBlock` → `schema.prisma:L14256`
- `Feature` → `schema.prisma:L4721`
- `FeeSchedule` → `schema.prisma:L4845`
- `FeeTier` → `schema.prisma:L4856`
- `FinancialAccount` → `schema.prisma:L15088`
- `FinancialConnection` → `schema.prisma:L15057`
- `FinancialProvider` → `schema.prisma:L15043`
- `FiscalEmisor` → `schema.prisma:L16309`
- `FiscalLossCarryforward` → `schema.prisma:L16897`
- `FixedAsset` → `schema.prisma:L16915`
- `FixedAssetDepreciation` → `schema.prisma:L16944`
- `FloorElement` → `schema.prisma:L3297`
- `FulfillmentArea` → `schema.prisma:L15369`
- `GeofenceRule` → `schema.prisma:L10521`
- `GoogleCalendarChannel` → `schema.prisma:L14233`
- `GoogleCalendarConnection` → `schema.prisma:L14185`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14286`
- `GoogleOAuthSession` → `schema.prisma:L14308`
- `HolidayCalendar` → `schema.prisma:L7125`
- `IdempotencyRequest` → `schema.prisma:L12375`
- `InterVenueTransfer` → `schema.prisma:L3049`
- `InterVenueTransferAllocation` → `schema.prisma:L3132`
- `InterVenueTransferItem` → `schema.prisma:L3101`
- `InterVenueTransferReceipt` → `schema.prisma:L3159`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3175`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3203`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3187`
- `Inventory` → `schema.prisma:L1993`
- `InventoryMovement` → `schema.prisma:L2093`
- `InventoryPosting` → `schema.prisma:L2188`
- `InventoryPostingLine` → `schema.prisma:L2228`
- `InventoryTransfer` → `schema.prisma:L14870`
- `InventoryWasteReport` → `schema.prisma:L2048`
- `Invitation` → `schema.prisma:L1494`
- `Invoice` → `schema.prisma:L4868`
- `InvoiceItem` → `schema.prisma:L4894`
- `ItemCategory` → `schema.prisma:L12088`
- `JournalEntry` → `schema.prisma:L16684`
- `JournalLine` → `schema.prisma:L16712`
- `KdsOrder` → `schema.prisma:L15136`
- `KdsOrderItem` → `schema.prisma:L15185`
- `KioskCheckInAttempt` → `schema.prisma:L17645`
- `KioskCheckInChallenge` → `schema.prisma:L17599`
- `KioskOutreachOutbox` → `schema.prisma:L17666`
- `LaunchCampaign` → `schema.prisma:L18004`
- `LaunchCampaignRedemption` → `schema.prisma:L18121`
- `LearnedPatterns` → `schema.prisma:L10006`
- `LedgerAccount` → `schema.prisma:L16576`
- `LiveDemoSession` → `schema.prisma:L830`
- `LowStockAlert` → `schema.prisma:L2883`
- `LoyaltyConfig` → `schema.prisma:L7708`
- `LoyaltyTransaction` → `schema.prisma:L7751`
- `MarketingCampaign` → `schema.prisma:L13271`
- `McpAuthCode` → `schema.prisma:L16192`
- `McpOAuthClient` → `schema.prisma:L16176`
- `McpRefreshToken` → `schema.prisma:L16210`
- `McpToolCall` → `schema.prisma:L16231`
- `MeasurementUnit` → `schema.prisma:L14976`
- `Menu` → `schema.prisma:L1712`
- `MenuCategory` → `schema.prisma:L1649`
- `MenuCategoryAssignment` → `schema.prisma:L1747`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16106`
- `MerchantAccount` → `schema.prisma:L5576`
- `MerchantFiscalConfig` → `schema.prisma:L16364`
- `MerchantRevenueShare` → `schema.prisma:L6705`
- `MerchantRoutingRule` → `schema.prisma:L5698`
- `MilestoneAchievement` → `schema.prisma:L12695`
- `Modifier` → `schema.prisma:L4198`
- `ModifierGroup` → `schema.prisma:L4162`
- `Module` → `schema.prisma:L10997`
- `MoneyAnomaly` → `schema.prisma:L6608`
- `MonthlyVenueProfit` → `schema.prisma:L7151`
- `Notification` → `schema.prisma:L8808`
- `NotificationPreference` → `schema.prisma:L8855`
- `NotificationTemplate` → `schema.prisma:L8882`
- `OAuthState` → `schema.prisma:L1545`
- `OnboardingProgress` → `schema.prisma:L1563`
- `Order` → `schema.prisma:L3746`
- `OrderAction` → `schema.prisma:L4265`
- `OrderCustomer` → `schema.prisma:L3988`
- `OrderDiscount` → `schema.prisma:L8669`
- `OrderFulfillment` → `schema.prisma:L15424`
- `OrderFulfillmentLine` → `schema.prisma:L15455`
- `OrderItem` → `schema.prisma:L4024`
- `OrderItemModifier` → `schema.prisma:L4247`
- `OrderPromotion` → `schema.prisma:L17562`
- `OrderServiceCharge` → `schema.prisma:L8753`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13072`
- `OrganizationEntitlement` → `schema.prisma:L11280`
- `OrganizationGoal` → `schema.prisma:L13030`
- `OrganizationModule` → `schema.prisma:L11057`
- `OrganizationPaymentConfig` → `schema.prisma:L6150`
- `OrganizationPayoutConfig` → `schema.prisma:L13105`
- `OrganizationPricingStructure` → `schema.prisma:L6182`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13053`
- `OtpChallenge` → `schema.prisma:L7658`
- `OvertimeApproval` → `schema.prisma:L3524`
- `PartnerAPIKey` → `schema.prisma:L5980`
- `Payment` → `schema.prisma:L4298`
- `PaymentAllocation` → `schema.prisma:L4571`
- `PaymentEffect` → `schema.prisma:L17936`
- `PaymentLink` → `schema.prisma:L14647`
- `PaymentLinkAttribution` → `schema.prisma:L14755`
- `PaymentLinkItem` → `schema.prisma:L14710`
- `PaymentLinkItemModifier` → `schema.prisma:L14737`
- `PaymentProvider` → `schema.prisma:L5535`
- `PayrollLine` → `schema.prisma:L17058`
- `PayrollRun` → `schema.prisma:L17027`
- `PerformanceGoal` → `schema.prisma:L13007`
- `PermissionOverride` → `schema.prisma:L1418`
- `PermissionSet` → `schema.prisma:L1441`
- `PlatformAnnouncement` → `schema.prisma:L17726`
- `PlatformAnnouncementClick` → `schema.prisma:L17791`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17828`
- `PlatformCfdi` → `schema.prisma:L17355`
- `PlatformEmisor` → `schema.prisma:L17295`
- `PlatformSettings` → `schema.prisma:L5957`
- `PosCommand` → `schema.prisma:L8936`
- `PosConnectionStatus` → `schema.prisma:L964`
- `PosSyncIntent` → `schema.prisma:L17433`
- `PricingPolicy` → `schema.prisma:L2779`
- `Printer` → `schema.prisma:L15234`
- `PrintGateway` → `schema.prisma:L15291`
- `PrintJob` → `schema.prisma:L16005`
- `PrintStation` → `schema.prisma:L15309`
- `PrivacyNoticeVersion` → `schema.prisma:L7406`
- `ProcessedStripeEvent` → `schema.prisma:L6594`
- `ProcessorReliabilityMetric` → `schema.prisma:L7079`
- `Product` → `schema.prisma:L1765`
- `ProductModifierGroup` → `schema.prisma:L4235`
- `ProductOption` → `schema.prisma:L14953`
- `ProductOptionValue` → `schema.prisma:L14964`
- `ProductStaff` → `schema.prisma:L13882`
- `PromoterBankAccount` → `schema.prisma:L17178`
- `PromoterCommissionEntry` → `schema.prisma:L17197`
- `PromoterLocationPing` → `schema.prisma:L3712`
- `Promotion` → `schema.prisma:L17484`
- `PromotionGroup` → `schema.prisma:L17523`
- `PromotionOption` → `schema.prisma:L17539`
- `ProviderCostStructure` → `schema.prisma:L6630`
- `ProviderEventLog` → `schema.prisma:L6259`
- `PurchaseOrder` → `schema.prisma:L2504`
- `PurchaseOrderInvoice` → `schema.prisma:L2649`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2706`
- `PurchaseOrderItem` → `schema.prisma:L2562`
- `RateCorrectionBatch` → `schema.prisma:L6855`
- `RateCorrectionEntry` → `schema.prisma:L6897`
- `RawMaterial` → `schema.prisma:L2260`
- `RawMaterialMovement` → `schema.prisma:L2832`
- `RawMaterialPresentation` → `schema.prisma:L2336`
- `ReceiptLayout` → `schema.prisma:L17970`
- `Recipe` → `schema.prisma:L2356`
- `RecipeLine` → `schema.prisma:L2380`
- `Referral` → `schema.prisma:L8124`
- `ReferralProgramConfig` → `schema.prisma:L8089`
- `ReferralRewardGrant` → `schema.prisma:L8215`
- `ReferralTierReward` → `schema.prisma:L8187`
- `ReferralTierUnlock` → `schema.prisma:L8260`
- `RefreshGrant` → `schema.prisma:L17915`
- `Reservation` → `schema.prisma:L13650`
- `ReservationGoogleEventMapping` → `schema.prisma:L14420`
- `ReservationModifier` → `schema.prisma:L13830`
- `ReservationReminderSent` → `schema.prisma:L13813`
- `ReservationSettings` → `schema.prisma:L14044`
- `ReservationWaitlistEntry` → `schema.prisma:L14012`
- `Review` → `schema.prisma:L4912`
- `SalesRetention` → `schema.prisma:L16878`
- `SaleVerification` → `schema.prisma:L4625`
- `ScaleProfile` → `schema.prisma:L15746`
- `ScheduledCommand` → `schema.prisma:L10481`
- `SerializedItem` → `schema.prisma:L12131`
- `SerializedItemCustodyEvent` → `schema.prisma:L12298`
- `ServiceCharge` → `schema.prisma:L8724`
- `Session` → `schema.prisma:L17894`
- `SettlementConfiguration` → `schema.prisma:L6930`
- `SettlementConfirmation` → `schema.prisma:L7043`
- `SettlementIncident` → `schema.prisma:L6994`
- `SettlementSimulation` → `schema.prisma:L6965`
- `Shift` → `schema.prisma:L3335`
- `SimRegistrationRequest` → `schema.prisma:L12336`
- `SimRegistrationRequestItem` → `schema.prisma:L12358`
- `SlotHold` → `schema.prisma:L13913`
- `Staff` → `schema.prisma:L984`
- `StaffDocument` → `schema.prisma:L3583`
- `StaffOnboardingState` → `schema.prisma:L16076`
- `StaffOrganization` → `schema.prisma:L1317`
- `StaffPasskey` → `schema.prisma:L1344`
- `StaffSchedule` → `schema.prisma:L13853`
- `StaffScheduleException` → `schema.prisma:L13865`
- `StaffVenue` → `schema.prisma:L1241`
- `StaffWorkSchedule` → `schema.prisma:L3460`
- `StaffWorkScheduleException` → `schema.prisma:L3558`
- `StampCard` → `schema.prisma:L7972`
- `StampEvent` → `schema.prisma:L8011`
- `StampReward` → `schema.prisma:L8049`
- `StockAlertConfig` → `schema.prisma:L12989`
- `StockBatch` → `schema.prisma:L2998`
- `StockCount` → `schema.prisma:L2915`
- `StockCountItem` → `schema.prisma:L2943`
- `StripeWebhookEvent` → `schema.prisma:L6577`
- `Supplier` → `schema.prisma:L2415`
- `SupplierItemCode` → `schema.prisma:L2747`
- `SupplierPricing` → `schema.prisma:L2470`
- `Table` → `schema.prisma:L3247`
- `Terminal` → `schema.prisma:L4963`
- `TerminalAttemptResolution` → `schema.prisma:L5394`
- `TerminalHealth` → `schema.prisma:L5214`
- `TerminalLog` → `schema.prisma:L5188`
- `TerminalOrder` → `schema.prisma:L5438`
- `TerminalOrderItem` → `schema.prisma:L5513`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5366`
- `TerminalPaymentRequest` → `schema.prisma:L5285`
- `TimeEntry` → `schema.prisma:L3625`
- `TimeEntryBreak` → `schema.prisma:L3694`
- `TokenPurchase` → `schema.prisma:L10155`
- `TokenUsageRecord` → `schema.prisma:L10127`
- `TpvCommandHistory` → `schema.prisma:L10387`
- `TpvCommandQueue` → `schema.prisma:L10327`
- `TpvFeedback` → `schema.prisma:L10040`
- `TpvMessage` → `schema.prisma:L13346`
- `TpvMessageDelivery` → `schema.prisma:L13398`
- `TpvMessageResponse` → `schema.prisma:L13421`
- `TrainingModule` → `schema.prisma:L13476`
- `TrainingProgress` → `schema.prisma:L13553`
- `TrainingQuizQuestion` → `schema.prisma:L13535`
- `TrainingStep` → `schema.prisma:L13515`
- `TransactionCost` → `schema.prisma:L6793`
- `UnitConversion` → `schema.prisma:L2810`
- `UpsellAcceptance` → `schema.prisma:L8545`
- `UpsellAiRun` → `schema.prisma:L8565`
- `UpsellImpression` → `schema.prisma:L8505`
- `UpsellRule` → `schema.prisma:L8425`
- `user_sessions` → `schema.prisma:L6015`
- `Venue` → `schema.prisma:L167`
- `VenueAreaTicketSettings` → `schema.prisma:L15483`
- `VenueChatMessage` → `schema.prisma:L806`
- `VenueChatSession` → `schema.prisma:L761`
- `VenueCommission` → `schema.prisma:L15114`
- `VenueCreditAssessment` → `schema.prisma:L10869`
- `VenueCryptoConfig` → `schema.prisma:L13213`
- `VenueFeature` → `schema.prisma:L4739`
- `VenueIvaPorProducto` → `schema.prisma:L957`
- `VenueModule` → `schema.prisma:L11029`
- `VenuePaymentConfig` → `schema.prisma:L6116`
- `VenuePaymentLinkSettings` → `schema.prisma:L14453`
- `VenuePricingStructure` → `schema.prisma:L6733`
- `VenueRoleConfig` → `schema.prisma:L1470`
- `VenueRolePermission` → `schema.prisma:L1374`
- `VenueScaleSettings` → `schema.prisma:L15734`
- `VenueSettings` → `schema.prisma:L846`
- `VenueTenderType` → `schema.prisma:L4484`
- `VenueTenderTypeRevision` → `schema.prisma:L4549`
- `VenueTransaction` → `schema.prisma:L4676`
- `VenueWhatsappActivation` → `schema.prisma:L697`
- `WalletCardDesign` → `schema.prisma:L7890`
- `WalletPass` → `schema.prisma:L7791`
- `WalletPassRegistration` → `schema.prisma:L7857`
- `WebhookEvent` → `schema.prisma:L4821`
- `WebhookSubscription` → `schema.prisma:L6232`
- `WhatsappContactWindow` → `schema.prisma:L715`
- `WhatsappInboundEvent` → `schema.prisma:L735`
- `WorkShiftAssignment` → `schema.prisma:L3500`
- `WorkShiftTemplate` → `schema.prisma:L3477`
- `Zone` → `schema.prisma:L150`
