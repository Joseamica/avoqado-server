# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **370 models / 352 enums / ~17,700 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                                                       |
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

- `AccountingPeriodLock` → `schema.prisma:L16368`
- `AccountMapping` → `schema.prisma:L16264`
- `ActivityLog` → `schema.prisma:L6871`
- `Aggregator` → `schema.prisma:L14661`
- `AngelPayUserAccount` → `schema.prisma:L5522`
- `AppUpdate` → `schema.prisma:L12826`
- `Area` → `schema.prisma:L3104`
- `AreaTicket` → `schema.prisma:L15159`
- `AreaTicketCheckoutSession` → `schema.prisma:L15281`
- `AreaTicketExternalIncident` → `schema.prisma:L15528`
- `AreaTicketExternalSettlement` → `schema.prisma:L15493`
- `AreaTicketFulfillment` → `schema.prisma:L15357`
- `AreaTicketInventoryReservation` → `schema.prisma:L15252`
- `AreaTicketLine` → `schema.prisma:L15220`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15313`
- `AreaTicketPrintAttempt` → `schema.prisma:L15336`
- `BankStatement` → `schema.prisma:L16138`
- `BankStatementLine` → `schema.prisma:L16159`
- `BillingTaxProfile` → `schema.prisma:L16948`
- `BirthdayAutomation` → `schema.prisma:L7192`
- `BulkCommandOperation` → `schema.prisma:L10106`
- `CalendarSyncOutbox` → `schema.prisma:L14033`
- `CampaignDelivery` → `schema.prisma:L12984`
- `CashCloseout` → `schema.prisma:L10491`
- `CashDeposit` → `schema.prisma:L12628`
- `CashDrawerEvent` → `schema.prisma:L14498`
- `CashDrawerSession` → `schema.prisma:L14459`
- `CashOutCommissionRate` → `schema.prisma:L16777`
- `CashOutScheduleDay` → `schema.prisma:L16800`
- `CashOutWithdrawal` → `schema.prisma:L16862`
- `CatalogBindingBatch` → `schema.prisma:L11522`
- `CatalogBindingLine` → `schema.prisma:L11558`
- `CatalogBrand` → `schema.prisma:L10975`
- `CatalogClientObservation` → `schema.prisma:L11288`
- `CatalogClientReadinessOverride` → `schema.prisma:L11307`
- `CatalogFamily` → `schema.prisma:L11025`
- `CatalogIdempotencyRecord` → `schema.prisma:L11421`
- `CatalogIdentifier` → `schema.prisma:L11156`
- `CatalogImportBatch` → `schema.prisma:L11464`
- `CatalogImportLine` → `schema.prisma:L11501`
- `CatalogItem` → `schema.prisma:L11058`
- `CatalogItemBusinessType` → `schema.prisma:L11118`
- `CatalogItemPrice` → `schema.prisma:L11206`
- `CatalogManufacturer` → `schema.prisma:L10999`
- `CatalogProductTypeMapping` → `schema.prisma:L11135`
- `CatalogPublicationBatch` → `schema.prisma:L11586`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11680`
- `CatalogPublicationLine` → `schema.prisma:L11627`
- `CatalogPublicationOutbox` → `schema.prisma:L11723`
- `CatalogValidationProfile` → `schema.prisma:L11177`
- `CatalogVenueBinding` → `schema.prisma:L11335`
- `CatalogVenueClientRequirement` → `schema.prisma:L11262`
- `CatalogVenueEventSequence` → `schema.prisma:L11706`
- `CatalogVenueOverride` → `schema.prisma:L11377`
- `CatalogVenueRollout` → `schema.prisma:L11237`
- `Cfdi` → `schema.prisma:L16041`
- `ChatbotTokenBudget` → `schema.prisma:L9754`
- `ChatConversation` → `schema.prisma:L9609`
- `ChatFeedback` → `schema.prisma:L9695`
- `ChatLearningEvent` → `schema.prisma:L9652`
- `ChatMessage` → `schema.prisma:L9632`
- `ChatTrainingData` → `schema.prisma:L9566`
- `CheckoutSession` → `schema.prisma:L5802`
- `ClassSession` → `schema.prisma:L13637`
- `CommissionCalculation` → `schema.prisma:L12404`
- `CommissionClawback` → `schema.prisma:L12580`
- `CommissionConfig` → `schema.prisma:L12170`
- `CommissionMilestone` → `schema.prisma:L12320`
- `CommissionOverride` → `schema.prisma:L12247`
- `CommissionPayout` → `schema.prisma:L12531`
- `CommissionSummary` → `schema.prisma:L12470`
- `CommissionTier` → `schema.prisma:L12284`
- `ConsentEvent` → `schema.prisma:L7054`
- `Consumer` → `schema.prisma:L7284`
- `ConsumerAuthAccount` → `schema.prisma:L7309`
- `CouponCode` → `schema.prisma:L8256`
- `CouponRedemption` → `schema.prisma:L8287`
- `CreditAssessmentHistory` → `schema.prisma:L10600`
- `CreditItemBalance` → `schema.prisma:L14249`
- `CreditOffer` → `schema.prisma:L10619`
- `CreditPack` → `schema.prisma:L14158`
- `CreditPackItem` → `schema.prisma:L14187`
- `CreditPackPurchase` → `schema.prisma:L14204`
- `CreditTransaction` → `schema.prisma:L14271`
- `Customer` → `schema.prisma:L6912`
- `CustomerApprovalDelivery` → `schema.prisma:L9268`
- `CustomerApprovalOutbox` → `schema.prisma:L9243`
- `CustomerCampaign` → `schema.prisma:L7142`
- `CustomerCampaignDelivery` → `schema.prisma:L7224`
- `CustomerCaptureToken` → `schema.prisma:L7090`
- `CustomerDiscount` → `schema.prisma:L8307`
- `CustomerGroup` → `schema.prisma:L7348`
- `CustomerOrderMetric` → `schema.prisma:L3875`
- `CustomerTaxProfile` → `schema.prisma:L16110`
- `DeliveryActivationRequest` → `schema.prisma:L6155`
- `DeliveryChannelLink` → `schema.prisma:L6100`
- `DeliveryOrderEvent` → `schema.prisma:L6179`
- `DeviceToken` → `schema.prisma:L8576`
- `DigitalReceipt` → `schema.prisma:L4453`
- `Discount` → `schema.prisma:L7946`
- `EcommerceMerchant` → `schema.prisma:L5614`
- `EmailQuotaLedger` → `schema.prisma:L7271`
- `EmailSuppression` → `schema.prisma:L7259`
- `EmailTemplate` → `schema.prisma:L12923`
- `Employee` → `schema.prisma:L16625`
- `Estimate` → `schema.prisma:L14568`
- `EstimateItem` → `schema.prisma:L14596`
- `Expense` → `schema.prisma:L16412`
- `ExternalBusyBlock` → `schema.prisma:L13926`
- `Feature` → `schema.prisma:L4582`
- `FeeSchedule` → `schema.prisma:L4660`
- `FeeTier` → `schema.prisma:L4671`
- `FinancialAccount` → `schema.prisma:L14758`
- `FinancialConnection` → `schema.prisma:L14727`
- `FinancialProvider` → `schema.prisma:L14713`
- `FiscalEmisor` → `schema.prisma:L15964`
- `FiscalLossCarryforward` → `schema.prisma:L16535`
- `FixedAsset` → `schema.prisma:L16553`
- `FixedAssetDepreciation` → `schema.prisma:L16582`
- `FloorElement` → `schema.prisma:L3180`
- `FulfillmentArea` → `schema.prisma:L15024`
- `GeofenceRule` → `schema.prisma:L10191`
- `GoogleCalendarChannel` → `schema.prisma:L13903`
- `GoogleCalendarConnection` → `schema.prisma:L13855`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13956`
- `GoogleOAuthSession` → `schema.prisma:L13978`
- `HolidayCalendar` → `schema.prisma:L6795`
- `IdempotencyRequest` → `schema.prisma:L12045`
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
- `InventoryTransfer` → `schema.prisma:L14540`
- `Invitation` → `schema.prisma:L1477`
- `Invoice` → `schema.prisma:L4683`
- `InvoiceItem` → `schema.prisma:L4709`
- `ItemCategory` → `schema.prisma:L11758`
- `JournalEntry` → `schema.prisma:L16322`
- `JournalLine` → `schema.prisma:L16350`
- `KdsOrder` → `schema.prisma:L14806`
- `KdsOrderItem` → `schema.prisma:L14847`
- `KioskCheckInAttempt` → `schema.prisma:L17271`
- `KioskCheckInChallenge` → `schema.prisma:L17225`
- `KioskOutreachOutbox` → `schema.prisma:L17292`
- `LaunchCampaign` → `schema.prisma:L17630`
- `LaunchCampaignRedemption` → `schema.prisma:L17736`
- `LearnedPatterns` → `schema.prisma:L9676`
- `LedgerAccount` → `schema.prisma:L16214`
- `LiveDemoSession` → `schema.prisma:L822`
- `LowStockAlert` → `schema.prisma:L2766`
- `LoyaltyConfig` → `schema.prisma:L7378`
- `LoyaltyTransaction` → `schema.prisma:L7421`
- `MarketingCampaign` → `schema.prisma:L12941`
- `McpAuthCode` → `schema.prisma:L15847`
- `McpOAuthClient` → `schema.prisma:L15831`
- `McpRefreshToken` → `schema.prisma:L15865`
- `McpToolCall` → `schema.prisma:L15886`
- `MeasurementUnit` → `schema.prisma:L14646`
- `Menu` → `schema.prisma:L1695`
- `MenuCategory` → `schema.prisma:L1632`
- `MenuCategoryAssignment` → `schema.prisma:L1730`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15761`
- `MerchantAccount` → `schema.prisma:L5352`
- `MerchantFiscalConfig` → `schema.prisma:L16012`
- `MerchantRevenueShare` → `schema.prisma:L6375`
- `MerchantRoutingRule` → `schema.prisma:L5474`
- `MilestoneAchievement` → `schema.prisma:L12365`
- `Modifier` → `schema.prisma:L4059`
- `ModifierGroup` → `schema.prisma:L4023`
- `Module` → `schema.prisma:L10667`
- `MoneyAnomaly` → `schema.prisma:L6278`
- `MonthlyVenueProfit` → `schema.prisma:L6821`
- `Notification` → `schema.prisma:L8478`
- `NotificationPreference` → `schema.prisma:L8525`
- `NotificationTemplate` → `schema.prisma:L8552`
- `OAuthState` → `schema.prisma:L1528`
- `OnboardingProgress` → `schema.prisma:L1546`
- `Order` → `schema.prisma:L3629`
- `OrderAction` → `schema.prisma:L4126`
- `OrderCustomer` → `schema.prisma:L3854`
- `OrderDiscount` → `schema.prisma:L8339`
- `OrderFulfillment` → `schema.prisma:L15079`
- `OrderFulfillmentLine` → `schema.prisma:L15110`
- `OrderItem` → `schema.prisma:L3890`
- `OrderItemModifier` → `schema.prisma:L4108`
- `OrderPromotion` → `schema.prisma:L17188`
- `OrderServiceCharge` → `schema.prisma:L8423`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12742`
- `OrganizationEntitlement` → `schema.prisma:L10950`
- `OrganizationGoal` → `schema.prisma:L12700`
- `OrganizationModule` → `schema.prisma:L10727`
- `OrganizationPaymentConfig` → `schema.prisma:L5926`
- `OrganizationPayoutConfig` → `schema.prisma:L12775`
- `OrganizationPricingStructure` → `schema.prisma:L5958`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12723`
- `OtpChallenge` → `schema.prisma:L7328`
- `OvertimeApproval` → `schema.prisma:L3407`
- `PartnerAPIKey` → `schema.prisma:L5756`
- `Payment` → `schema.prisma:L4159`
- `PaymentAllocation` → `schema.prisma:L4432`
- `PaymentEffect` → `schema.prisma:L17562`
- `PaymentLink` → `schema.prisma:L14317`
- `PaymentLinkAttribution` → `schema.prisma:L14425`
- `PaymentLinkItem` → `schema.prisma:L14380`
- `PaymentLinkItemModifier` → `schema.prisma:L14407`
- `PaymentProvider` → `schema.prisma:L5311`
- `PayrollLine` → `schema.prisma:L16696`
- `PayrollRun` → `schema.prisma:L16665`
- `PerformanceGoal` → `schema.prisma:L12677`
- `PermissionOverride` → `schema.prisma:L1401`
- `PermissionSet` → `schema.prisma:L1424`
- `PlatformAnnouncement` → `schema.prisma:L17352`
- `PlatformAnnouncementClick` → `schema.prisma:L17417`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17454`
- `PlatformCfdi` → `schema.prisma:L16981`
- `PlatformEmisor` → `schema.prisma:L16921`
- `PlatformSettings` → `schema.prisma:L5733`
- `PosCommand` → `schema.prisma:L8606`
- `PosConnectionStatus` → `schema.prisma:L948`
- `PosSyncIntent` → `schema.prisma:L17059`
- `PricingPolicy` → `schema.prisma:L2670`
- `Printer` → `schema.prisma:L14889`
- `PrintGateway` → `schema.prisma:L14946`
- `PrintJob` → `schema.prisma:L15660`
- `PrintStation` → `schema.prisma:L14964`
- `PrivacyNoticeVersion` → `schema.prisma:L7076`
- `ProcessedStripeEvent` → `schema.prisma:L6264`
- `ProcessorReliabilityMetric` → `schema.prisma:L6749`
- `Product` → `schema.prisma:L1748`
- `ProductModifierGroup` → `schema.prisma:L4096`
- `ProductOption` → `schema.prisma:L14623`
- `ProductOptionValue` → `schema.prisma:L14634`
- `ProductStaff` → `schema.prisma:L13552`
- `PromoterBankAccount` → `schema.prisma:L16816`
- `PromoterCommissionEntry` → `schema.prisma:L16835`
- `PromoterLocationPing` → `schema.prisma:L3595`
- `Promotion` → `schema.prisma:L17110`
- `PromotionGroup` → `schema.prisma:L17149`
- `PromotionOption` → `schema.prisma:L17165`
- `ProviderCostStructure` → `schema.prisma:L6300`
- `ProviderEventLog` → `schema.prisma:L6035`
- `PurchaseOrder` → `schema.prisma:L2395`
- `PurchaseOrderInvoice` → `schema.prisma:L2540`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2597`
- `PurchaseOrderItem` → `schema.prisma:L2453`
- `RateCorrectionBatch` → `schema.prisma:L6525`
- `RateCorrectionEntry` → `schema.prisma:L6567`
- `RawMaterial` → `schema.prisma:L2152`
- `RawMaterialMovement` → `schema.prisma:L2723`
- `RawMaterialPresentation` → `schema.prisma:L2227`
- `ReceiptLayout` → `schema.prisma:L17596`
- `Recipe` → `schema.prisma:L2247`
- `RecipeLine` → `schema.prisma:L2271`
- `Referral` → `schema.prisma:L7794`
- `ReferralProgramConfig` → `schema.prisma:L7759`
- `ReferralRewardGrant` → `schema.prisma:L7885`
- `ReferralTierReward` → `schema.prisma:L7857`
- `ReferralTierUnlock` → `schema.prisma:L7930`
- `RefreshGrant` → `schema.prisma:L17541`
- `Reservation` → `schema.prisma:L13320`
- `ReservationGoogleEventMapping` → `schema.prisma:L14090`
- `ReservationModifier` → `schema.prisma:L13500`
- `ReservationReminderSent` → `schema.prisma:L13483`
- `ReservationSettings` → `schema.prisma:L13714`
- `ReservationWaitlistEntry` → `schema.prisma:L13682`
- `Review` → `schema.prisma:L4727`
- `SalesRetention` → `schema.prisma:L16516`
- `SaleVerification` → `schema.prisma:L4486`
- `ScaleProfile` → `schema.prisma:L15401`
- `ScheduledCommand` → `schema.prisma:L10151`
- `SerializedItem` → `schema.prisma:L11801`
- `SerializedItemCustodyEvent` → `schema.prisma:L11968`
- `ServiceCharge` → `schema.prisma:L8394`
- `Session` → `schema.prisma:L17520`
- `SettlementConfiguration` → `schema.prisma:L6600`
- `SettlementConfirmation` → `schema.prisma:L6713`
- `SettlementIncident` → `schema.prisma:L6664`
- `SettlementSimulation` → `schema.prisma:L6635`
- `Shift` → `schema.prisma:L3218`
- `SimRegistrationRequest` → `schema.prisma:L12006`
- `SimRegistrationRequestItem` → `schema.prisma:L12028`
- `SlotHold` → `schema.prisma:L13583`
- `Staff` → `schema.prisma:L968`
- `StaffDocument` → `schema.prisma:L3466`
- `StaffOnboardingState` → `schema.prisma:L15731`
- `StaffOrganization` → `schema.prisma:L1300`
- `StaffPasskey` → `schema.prisma:L1327`
- `StaffSchedule` → `schema.prisma:L13523`
- `StaffScheduleException` → `schema.prisma:L13535`
- `StaffVenue` → `schema.prisma:L1224`
- `StaffWorkSchedule` → `schema.prisma:L3343`
- `StaffWorkScheduleException` → `schema.prisma:L3441`
- `StampCard` → `schema.prisma:L7642`
- `StampEvent` → `schema.prisma:L7681`
- `StampReward` → `schema.prisma:L7719`
- `StockAlertConfig` → `schema.prisma:L12659`
- `StockBatch` → `schema.prisma:L2881`
- `StockCount` → `schema.prisma:L2798`
- `StockCountItem` → `schema.prisma:L2826`
- `StripeWebhookEvent` → `schema.prisma:L6247`
- `Supplier` → `schema.prisma:L2306`
- `SupplierItemCode` → `schema.prisma:L2638`
- `SupplierPricing` → `schema.prisma:L2361`
- `Table` → `schema.prisma:L3130`
- `Terminal` → `schema.prisma:L4778`
- `TerminalHealth` → `schema.prisma:L5029`
- `TerminalLog` → `schema.prisma:L5003`
- `TerminalOrder` → `schema.prisma:L5214`
- `TerminalOrderItem` → `schema.prisma:L5289`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5167`
- `TerminalPaymentRequest` → `schema.prisma:L5100`
- `TimeEntry` → `schema.prisma:L3508`
- `TimeEntryBreak` → `schema.prisma:L3577`
- `TokenPurchase` → `schema.prisma:L9825`
- `TokenUsageRecord` → `schema.prisma:L9797`
- `TpvCommandHistory` → `schema.prisma:L10057`
- `TpvCommandQueue` → `schema.prisma:L9997`
- `TpvFeedback` → `schema.prisma:L9710`
- `TpvMessage` → `schema.prisma:L13016`
- `TpvMessageDelivery` → `schema.prisma:L13068`
- `TpvMessageResponse` → `schema.prisma:L13091`
- `TrainingModule` → `schema.prisma:L13146`
- `TrainingProgress` → `schema.prisma:L13223`
- `TrainingQuizQuestion` → `schema.prisma:L13205`
- `TrainingStep` → `schema.prisma:L13185`
- `TransactionCost` → `schema.prisma:L6463`
- `UnitConversion` → `schema.prisma:L2701`
- `UpsellAcceptance` → `schema.prisma:L8215`
- `UpsellAiRun` → `schema.prisma:L8235`
- `UpsellImpression` → `schema.prisma:L8175`
- `UpsellRule` → `schema.prisma:L8095`
- `user_sessions` → `schema.prisma:L5791`
- `Venue` → `schema.prisma:L163`
- `VenueAreaTicketSettings` → `schema.prisma:L15138`
- `VenueChatMessage` → `schema.prisma:L798`
- `VenueChatSession` → `schema.prisma:L753`
- `VenueCommission` → `schema.prisma:L14784`
- `VenueCreditAssessment` → `schema.prisma:L10539`
- `VenueCryptoConfig` → `schema.prisma:L12883`
- `VenueFeature` → `schema.prisma:L4600`
- `VenueModule` → `schema.prisma:L10699`
- `VenuePaymentConfig` → `schema.prisma:L5892`
- `VenuePaymentLinkSettings` → `schema.prisma:L14123`
- `VenuePricingStructure` → `schema.prisma:L6403`
- `VenueRoleConfig` → `schema.prisma:L1453`
- `VenueRolePermission` → `schema.prisma:L1357`
- `VenueScaleSettings` → `schema.prisma:L15389`
- `VenueSettings` → `schema.prisma:L838`
- `VenueTenderType` → `schema.prisma:L4345`
- `VenueTenderTypeRevision` → `schema.prisma:L4410`
- `VenueTransaction` → `schema.prisma:L4537`
- `VenueWhatsappActivation` → `schema.prisma:L689`
- `WalletCardDesign` → `schema.prisma:L7560`
- `WalletPass` → `schema.prisma:L7461`
- `WalletPassRegistration` → `schema.prisma:L7527`
- `WebhookEvent` → `schema.prisma:L4636`
- `WebhookSubscription` → `schema.prisma:L6008`
- `WhatsappContactWindow` → `schema.prisma:L707`
- `WhatsappInboundEvent` → `schema.prisma:L727`
- `WorkShiftAssignment` → `schema.prisma:L3383`
- `WorkShiftTemplate` → `schema.prisma:L3360`
- `Zone` → `schema.prisma:L146`
