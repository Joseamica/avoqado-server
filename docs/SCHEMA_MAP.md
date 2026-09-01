# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **363 models / 345 enums / ~17,200 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                        |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                            |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                                      |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                           |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                           |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                            |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                        |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L16081`
- `AccountMapping` → `schema.prisma:L15977`
- `ActivityLog` → `schema.prisma:L6673`
- `Aggregator` → `schema.prisma:L14378`
- `AngelPayUserAccount` → `schema.prisma:L5336`
- `AppUpdate` → `schema.prisma:L12558`
- `Area` → `schema.prisma:L3029`
- `AreaTicket` → `schema.prisma:L14872`
- `AreaTicketCheckoutSession` → `schema.prisma:L14994`
- `AreaTicketExternalIncident` → `schema.prisma:L15241`
- `AreaTicketExternalSettlement` → `schema.prisma:L15206`
- `AreaTicketFulfillment` → `schema.prisma:L15070`
- `AreaTicketInventoryReservation` → `schema.prisma:L14965`
- `AreaTicketLine` → `schema.prisma:L14933`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15026`
- `AreaTicketPrintAttempt` → `schema.prisma:L15049`
- `BankStatement` → `schema.prisma:L15851`
- `BankStatementLine` → `schema.prisma:L15872`
- `BillingTaxProfile` → `schema.prisma:L16661`
- `BulkCommandOperation` → `schema.prisma:L9841`
- `CalendarSyncOutbox` → `schema.prisma:L13765`
- `CampaignDelivery` → `schema.prisma:L12716`
- `CashCloseout` → `schema.prisma:L10226`
- `CashDeposit` → `schema.prisma:L12360`
- `CashDrawerEvent` → `schema.prisma:L14215`
- `CashDrawerSession` → `schema.prisma:L14191`
- `CashOutCommissionRate` → `schema.prisma:L16490`
- `CashOutScheduleDay` → `schema.prisma:L16513`
- `CashOutWithdrawal` → `schema.prisma:L16575`
- `CatalogBindingBatch` → `schema.prisma:L11257`
- `CatalogBindingLine` → `schema.prisma:L11293`
- `CatalogBrand` → `schema.prisma:L10710`
- `CatalogClientObservation` → `schema.prisma:L11023`
- `CatalogClientReadinessOverride` → `schema.prisma:L11042`
- `CatalogFamily` → `schema.prisma:L10760`
- `CatalogIdempotencyRecord` → `schema.prisma:L11156`
- `CatalogIdentifier` → `schema.prisma:L10891`
- `CatalogImportBatch` → `schema.prisma:L11199`
- `CatalogImportLine` → `schema.prisma:L11236`
- `CatalogItem` → `schema.prisma:L10793`
- `CatalogItemBusinessType` → `schema.prisma:L10853`
- `CatalogItemPrice` → `schema.prisma:L10941`
- `CatalogManufacturer` → `schema.prisma:L10734`
- `CatalogProductTypeMapping` → `schema.prisma:L10870`
- `CatalogPublicationBatch` → `schema.prisma:L11321`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11415`
- `CatalogPublicationLine` → `schema.prisma:L11362`
- `CatalogPublicationOutbox` → `schema.prisma:L11458`
- `CatalogValidationProfile` → `schema.prisma:L10912`
- `CatalogVenueBinding` → `schema.prisma:L11070`
- `CatalogVenueClientRequirement` → `schema.prisma:L10997`
- `CatalogVenueEventSequence` → `schema.prisma:L11441`
- `CatalogVenueOverride` → `schema.prisma:L11112`
- `CatalogVenueRollout` → `schema.prisma:L10972`
- `Cfdi` → `schema.prisma:L15754`
- `ChatbotTokenBudget` → `schema.prisma:L9489`
- `ChatConversation` → `schema.prisma:L9344`
- `ChatFeedback` → `schema.prisma:L9430`
- `ChatLearningEvent` → `schema.prisma:L9387`
- `ChatMessage` → `schema.prisma:L9367`
- `ChatTrainingData` → `schema.prisma:L9301`
- `CheckoutSession` → `schema.prisma:L5616`
- `ClassSession` → `schema.prisma:L13369`
- `CommissionCalculation` → `schema.prisma:L12136`
- `CommissionClawback` → `schema.prisma:L12312`
- `CommissionConfig` → `schema.prisma:L11902`
- `CommissionMilestone` → `schema.prisma:L12052`
- `CommissionOverride` → `schema.prisma:L11979`
- `CommissionPayout` → `schema.prisma:L12263`
- `CommissionSummary` → `schema.prisma:L12202`
- `CommissionTier` → `schema.prisma:L12016`
- `ConsentEvent` → `schema.prisma:L6855`
- `Consumer` → `schema.prisma:L7032`
- `ConsumerAuthAccount` → `schema.prisma:L7057`
- `CouponCode` → `schema.prisma:L7996`
- `CouponRedemption` → `schema.prisma:L8027`
- `CreditAssessmentHistory` → `schema.prisma:L10335`
- `CreditItemBalance` → `schema.prisma:L13981`
- `CreditOffer` → `schema.prisma:L10354`
- `CreditPack` → `schema.prisma:L13890`
- `CreditPackItem` → `schema.prisma:L13919`
- `CreditPackPurchase` → `schema.prisma:L13936`
- `CreditTransaction` → `schema.prisma:L14003`
- `Customer` → `schema.prisma:L6714`
- `CustomerApprovalDelivery` → `schema.prisma:L9003`
- `CustomerApprovalOutbox` → `schema.prisma:L8978`
- `CustomerCampaign` → `schema.prisma:L6939`
- `CustomerCampaignDelivery` → `schema.prisma:L6973`
- `CustomerCaptureToken` → `schema.prisma:L6891`
- `CustomerDiscount` → `schema.prisma:L8047`
- `CustomerGroup` → `schema.prisma:L7096`
- `CustomerTaxProfile` → `schema.prisma:L15823`
- `DeliveryActivationRequest` → `schema.prisma:L5957`
- `DeliveryChannelLink` → `schema.prisma:L5902`
- `DeliveryOrderEvent` → `schema.prisma:L5981`
- `DeviceToken` → `schema.prisma:L8316`
- `DigitalReceipt` → `schema.prisma:L4319`
- `Discount` → `schema.prisma:L7686`
- `EcommerceMerchant` → `schema.prisma:L5428`
- `EmailQuotaLedger` → `schema.prisma:L7019`
- `EmailSuppression` → `schema.prisma:L7007`
- `EmailTemplate` → `schema.prisma:L12655`
- `Employee` → `schema.prisma:L16338`
- `Estimate` → `schema.prisma:L14285`
- `EstimateItem` → `schema.prisma:L14313`
- `Expense` → `schema.prisma:L16125`
- `ExternalBusyBlock` → `schema.prisma:L13658`
- `Feature` → `schema.prisma:L4448`
- `FeeSchedule` → `schema.prisma:L4526`
- `FeeTier` → `schema.prisma:L4537`
- `FinancialAccount` → `schema.prisma:L14475`
- `FinancialConnection` → `schema.prisma:L14444`
- `FinancialProvider` → `schema.prisma:L14430`
- `FiscalEmisor` → `schema.prisma:L15677`
- `FiscalLossCarryforward` → `schema.prisma:L16248`
- `FixedAsset` → `schema.prisma:L16266`
- `FixedAssetDepreciation` → `schema.prisma:L16295`
- `FloorElement` → `schema.prisma:L3105`
- `FulfillmentArea` → `schema.prisma:L14737`
- `GeofenceRule` → `schema.prisma:L9926`
- `GoogleCalendarChannel` → `schema.prisma:L13635`
- `GoogleCalendarConnection` → `schema.prisma:L13587`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13688`
- `GoogleOAuthSession` → `schema.prisma:L13710`
- `HolidayCalendar` → `schema.prisma:L6597`
- `IdempotencyRequest` → `schema.prisma:L11777`
- `InterVenueTransfer` → `schema.prisma:L2857`
- `InterVenueTransferAllocation` → `schema.prisma:L2940`
- `InterVenueTransferItem` → `schema.prisma:L2909`
- `InterVenueTransferReceipt` → `schema.prisma:L2967`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2983`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3011`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2995`
- `Inventory` → `schema.prisma:L1903`
- `InventoryMovement` → `schema.prisma:L1930`
- `InventoryPosting` → `schema.prisma:L2012`
- `InventoryPostingLine` → `schema.prisma:L2052`
- `InventoryTransfer` → `schema.prisma:L14257`
- `Invitation` → `schema.prisma:L1441`
- `Invoice` → `schema.prisma:L4549`
- `InvoiceItem` → `schema.prisma:L4575`
- `ItemCategory` → `schema.prisma:L11493`
- `JournalEntry` → `schema.prisma:L16035`
- `JournalLine` → `schema.prisma:L16063`
- `KdsOrder` → `schema.prisma:L14523`
- `KdsOrderItem` → `schema.prisma:L14564`
- `KioskCheckInAttempt` → `schema.prisma:L16984`
- `KioskCheckInChallenge` → `schema.prisma:L16938`
- `KioskOutreachOutbox` → `schema.prisma:L17005`
- `LearnedPatterns` → `schema.prisma:L9411`
- `LedgerAccount` → `schema.prisma:L15927`
- `LiveDemoSession` → `schema.prisma:L792`
- `LowStockAlert` → `schema.prisma:L2698`
- `LoyaltyConfig` → `schema.prisma:L7126`
- `LoyaltyTransaction` → `schema.prisma:L7169`
- `MarketingCampaign` → `schema.prisma:L12673`
- `McpAuthCode` → `schema.prisma:L15560`
- `McpOAuthClient` → `schema.prisma:L15544`
- `McpRefreshToken` → `schema.prisma:L15578`
- `McpToolCall` → `schema.prisma:L15599`
- `MeasurementUnit` → `schema.prisma:L14363`
- `Menu` → `schema.prisma:L1627`
- `MenuCategory` → `schema.prisma:L1564`
- `MenuCategoryAssignment` → `schema.prisma:L1662`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15474`
- `MerchantAccount` → `schema.prisma:L5166`
- `MerchantFiscalConfig` → `schema.prisma:L15725`
- `MerchantRevenueShare` → `schema.prisma:L6177`
- `MerchantRoutingRule` → `schema.prisma:L5288`
- `MilestoneAchievement` → `schema.prisma:L12097`
- `Modifier` → `schema.prisma:L3934`
- `ModifierGroup` → `schema.prisma:L3898`
- `Module` → `schema.prisma:L10402`
- `MoneyAnomaly` → `schema.prisma:L6080`
- `MonthlyVenueProfit` → `schema.prisma:L6623`
- `Notification` → `schema.prisma:L8218`
- `NotificationPreference` → `schema.prisma:L8265`
- `NotificationTemplate` → `schema.prisma:L8292`
- `OAuthState` → `schema.prisma:L1492`
- `OnboardingProgress` → `schema.prisma:L1510`
- `Order` → `schema.prisma:L3536`
- `OrderAction` → `schema.prisma:L3999`
- `OrderCustomer` → `schema.prisma:L3749`
- `OrderDiscount` → `schema.prisma:L8079`
- `OrderFulfillment` → `schema.prisma:L14792`
- `OrderFulfillmentLine` → `schema.prisma:L14823`
- `OrderItem` → `schema.prisma:L3765`
- `OrderItemModifier` → `schema.prisma:L3983`
- `OrderPromotion` → `schema.prisma:L16901`
- `OrderServiceCharge` → `schema.prisma:L8163`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12474`
- `OrganizationEntitlement` → `schema.prisma:L10685`
- `OrganizationGoal` → `schema.prisma:L12432`
- `OrganizationModule` → `schema.prisma:L10462`
- `OrganizationPaymentConfig` → `schema.prisma:L5740`
- `OrganizationPayoutConfig` → `schema.prisma:L12507`
- `OrganizationPricingStructure` → `schema.prisma:L5772`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12455`
- `OtpChallenge` → `schema.prisma:L7076`
- `OvertimeApproval` → `schema.prisma:L3314`
- `PartnerAPIKey` → `schema.prisma:L5570`
- `Payment` → `schema.prisma:L4032`
- `PaymentAllocation` → `schema.prisma:L4298`
- `PaymentLink` → `schema.prisma:L14049`
- `PaymentLinkAttribution` → `schema.prisma:L14157`
- `PaymentLinkItem` → `schema.prisma:L14112`
- `PaymentLinkItemModifier` → `schema.prisma:L14139`
- `PaymentProvider` → `schema.prisma:L5125`
- `PayrollLine` → `schema.prisma:L16409`
- `PayrollRun` → `schema.prisma:L16378`
- `PerformanceGoal` → `schema.prisma:L12409`
- `PermissionOverride` → `schema.prisma:L1369`
- `PermissionSet` → `schema.prisma:L1392`
- `PlatformAnnouncement` → `schema.prisma:L17065`
- `PlatformAnnouncementClick` → `schema.prisma:L17130`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17167`
- `PlatformCfdi` → `schema.prisma:L16694`
- `PlatformEmisor` → `schema.prisma:L16634`
- `PlatformSettings` → `schema.prisma:L5547`
- `PosCommand` → `schema.prisma:L8346`
- `PosConnectionStatus` → `schema.prisma:L918`
- `PosSyncIntent` → `schema.prisma:L16772`
- `PricingPolicy` → `schema.prisma:L2602`
- `Printer` → `schema.prisma:L14606`
- `PrintGateway` → `schema.prisma:L14659`
- `PrintJob` → `schema.prisma:L15373`
- `PrintStation` → `schema.prisma:L14677`
- `PrivacyNoticeVersion` → `schema.prisma:L6877`
- `ProcessedStripeEvent` → `schema.prisma:L6066`
- `ProcessorReliabilityMetric` → `schema.prisma:L6551`
- `Product` → `schema.prisma:L1680`
- `ProductModifierGroup` → `schema.prisma:L3971`
- `ProductOption` → `schema.prisma:L14340`
- `ProductOptionValue` → `schema.prisma:L14351`
- `ProductStaff` → `schema.prisma:L13284`
- `PromoterBankAccount` → `schema.prisma:L16529`
- `PromoterCommissionEntry` → `schema.prisma:L16548`
- `PromoterLocationPing` → `schema.prisma:L3502`
- `Promotion` → `schema.prisma:L16823`
- `PromotionGroup` → `schema.prisma:L16862`
- `PromotionOption` → `schema.prisma:L16878`
- `ProviderCostStructure` → `schema.prisma:L6102`
- `ProviderEventLog` → `schema.prisma:L5849`
- `PurchaseOrder` → `schema.prisma:L2327`
- `PurchaseOrderInvoice` → `schema.prisma:L2472`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2529`
- `PurchaseOrderItem` → `schema.prisma:L2385`
- `RateCorrectionBatch` → `schema.prisma:L6327`
- `RateCorrectionEntry` → `schema.prisma:L6369`
- `RawMaterial` → `schema.prisma:L2084`
- `RawMaterialMovement` → `schema.prisma:L2655`
- `RawMaterialPresentation` → `schema.prisma:L2159`
- `Recipe` → `schema.prisma:L2179`
- `RecipeLine` → `schema.prisma:L2203`
- `Referral` → `schema.prisma:L7534`
- `ReferralProgramConfig` → `schema.prisma:L7499`
- `ReferralRewardGrant` → `schema.prisma:L7625`
- `ReferralTierReward` → `schema.prisma:L7597`
- `ReferralTierUnlock` → `schema.prisma:L7670`
- `RefreshGrant` → `schema.prisma:L17254`
- `Reservation` → `schema.prisma:L13052`
- `ReservationGoogleEventMapping` → `schema.prisma:L13822`
- `ReservationModifier` → `schema.prisma:L13232`
- `ReservationReminderSent` → `schema.prisma:L13215`
- `ReservationSettings` → `schema.prisma:L13446`
- `ReservationWaitlistEntry` → `schema.prisma:L13414`
- `Review` → `schema.prisma:L4593`
- `SalesRetention` → `schema.prisma:L16229`
- `SaleVerification` → `schema.prisma:L4352`
- `ScaleProfile` → `schema.prisma:L15114`
- `ScheduledCommand` → `schema.prisma:L9886`
- `SerializedItem` → `schema.prisma:L11536`
- `SerializedItemCustodyEvent` → `schema.prisma:L11700`
- `ServiceCharge` → `schema.prisma:L8134`
- `Session` → `schema.prisma:L17233`
- `SettlementConfiguration` → `schema.prisma:L6402`
- `SettlementConfirmation` → `schema.prisma:L6515`
- `SettlementIncident` → `schema.prisma:L6466`
- `SettlementSimulation` → `schema.prisma:L6437`
- `Shift` → `schema.prisma:L3143`
- `SimRegistrationRequest` → `schema.prisma:L11738`
- `SimRegistrationRequestItem` → `schema.prisma:L11760`
- `SlotHold` → `schema.prisma:L13315`
- `Staff` → `schema.prisma:L938`
- `StaffDocument` → `schema.prisma:L3373`
- `StaffOnboardingState` → `schema.prisma:L15444`
- `StaffOrganization` → `schema.prisma:L1268`
- `StaffPasskey` → `schema.prisma:L1295`
- `StaffSchedule` → `schema.prisma:L13255`
- `StaffScheduleException` → `schema.prisma:L13267`
- `StaffVenue` → `schema.prisma:L1192`
- `StaffWorkSchedule` → `schema.prisma:L3250`
- `StaffWorkScheduleException` → `schema.prisma:L3348`
- `StampCard` → `schema.prisma:L7382`
- `StampEvent` → `schema.prisma:L7421`
- `StampReward` → `schema.prisma:L7459`
- `StockAlertConfig` → `schema.prisma:L12391`
- `StockBatch` → `schema.prisma:L2806`
- `StockCount` → `schema.prisma:L2730`
- `StockCountItem` → `schema.prisma:L2754`
- `StripeWebhookEvent` → `schema.prisma:L6049`
- `Supplier` → `schema.prisma:L2238`
- `SupplierItemCode` → `schema.prisma:L2570`
- `SupplierPricing` → `schema.prisma:L2293`
- `Table` → `schema.prisma:L3055`
- `Terminal` → `schema.prisma:L4644`
- `TerminalHealth` → `schema.prisma:L4895`
- `TerminalLog` → `schema.prisma:L4869`
- `TerminalOrder` → `schema.prisma:L5028`
- `TerminalOrderItem` → `schema.prisma:L5103`
- `TerminalPaymentRequest` → `schema.prisma:L4966`
- `TimeEntry` → `schema.prisma:L3415`
- `TimeEntryBreak` → `schema.prisma:L3484`
- `TokenPurchase` → `schema.prisma:L9560`
- `TokenUsageRecord` → `schema.prisma:L9532`
- `TpvCommandHistory` → `schema.prisma:L9792`
- `TpvCommandQueue` → `schema.prisma:L9732`
- `TpvFeedback` → `schema.prisma:L9445`
- `TpvMessage` → `schema.prisma:L12748`
- `TpvMessageDelivery` → `schema.prisma:L12800`
- `TpvMessageResponse` → `schema.prisma:L12823`
- `TrainingModule` → `schema.prisma:L12878`
- `TrainingProgress` → `schema.prisma:L12955`
- `TrainingQuizQuestion` → `schema.prisma:L12937`
- `TrainingStep` → `schema.prisma:L12917`
- `TransactionCost` → `schema.prisma:L6265`
- `UnitConversion` → `schema.prisma:L2633`
- `UpsellAcceptance` → `schema.prisma:L7955`
- `UpsellAiRun` → `schema.prisma:L7975`
- `UpsellImpression` → `schema.prisma:L7915`
- `UpsellRule` → `schema.prisma:L7835`
- `user_sessions` → `schema.prisma:L5605`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14851`
- `VenueChatMessage` → `schema.prisma:L768`
- `VenueChatSession` → `schema.prisma:L723`
- `VenueCommission` → `schema.prisma:L14501`
- `VenueCreditAssessment` → `schema.prisma:L10274`
- `VenueCryptoConfig` → `schema.prisma:L12615`
- `VenueFeature` → `schema.prisma:L4466`
- `VenueModule` → `schema.prisma:L10434`
- `VenuePaymentConfig` → `schema.prisma:L5706`
- `VenuePaymentLinkSettings` → `schema.prisma:L13855`
- `VenuePricingStructure` → `schema.prisma:L6205`
- `VenueRoleConfig` → `schema.prisma:L1421`
- `VenueRolePermission` → `schema.prisma:L1325`
- `VenueScaleSettings` → `schema.prisma:L15102`
- `VenueSettings` → `schema.prisma:L808`
- `VenueTenderType` → `schema.prisma:L4211`
- `VenueTenderTypeRevision` → `schema.prisma:L4276`
- `VenueTransaction` → `schema.prisma:L4403`
- `VenueWhatsappActivation` → `schema.prisma:L659`
- `WalletCardDesign` → `schema.prisma:L7300`
- `WalletPass` → `schema.prisma:L7209`
- `WalletPassRegistration` → `schema.prisma:L7267`
- `WebhookEvent` → `schema.prisma:L4502`
- `WebhookSubscription` → `schema.prisma:L5822`
- `WhatsappContactWindow` → `schema.prisma:L677`
- `WhatsappInboundEvent` → `schema.prisma:L697`
- `WorkShiftAssignment` → `schema.prisma:L3290`
- `WorkShiftTemplate` → `schema.prisma:L3267`
- `Zone` → `schema.prisma:L142`
