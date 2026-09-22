# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **372 models / 354 enums / ~17,800 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
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
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalAttemptResolution`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                         |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L16463`
- `AccountMapping` → `schema.prisma:L16359`
- `ActivityLog` → `schema.prisma:L6956`
- `Aggregator` → `schema.prisma:L14746`
- `AngelPayUserAccount` → `schema.prisma:L5607`
- `AppUpdate` → `schema.prisma:L12911`
- `Area` → `schema.prisma:L3104`
- `AreaTicket` → `schema.prisma:L15244`
- `AreaTicketCheckoutSession` → `schema.prisma:L15366`
- `AreaTicketExternalIncident` → `schema.prisma:L15613`
- `AreaTicketExternalSettlement` → `schema.prisma:L15578`
- `AreaTicketFulfillment` → `schema.prisma:L15442`
- `AreaTicketInventoryReservation` → `schema.prisma:L15337`
- `AreaTicketLine` → `schema.prisma:L15305`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15398`
- `AreaTicketPrintAttempt` → `schema.prisma:L15421`
- `BankStatement` → `schema.prisma:L16233`
- `BankStatementLine` → `schema.prisma:L16254`
- `BillingObligationConflict` → `schema.prisma:L4644`
- `BillingTaxProfile` → `schema.prisma:L17043`
- `BirthdayAutomation` → `schema.prisma:L7277`
- `BulkCommandOperation` → `schema.prisma:L10191`
- `CalendarSyncOutbox` → `schema.prisma:L14118`
- `CampaignDelivery` → `schema.prisma:L13069`
- `CashCloseout` → `schema.prisma:L10576`
- `CashDeposit` → `schema.prisma:L12713`
- `CashDrawerEvent` → `schema.prisma:L14583`
- `CashDrawerSession` → `schema.prisma:L14544`
- `CashOutCommissionRate` → `schema.prisma:L16872`
- `CashOutScheduleDay` → `schema.prisma:L16895`
- `CashOutWithdrawal` → `schema.prisma:L16957`
- `CatalogBindingBatch` → `schema.prisma:L11607`
- `CatalogBindingLine` → `schema.prisma:L11643`
- `CatalogBrand` → `schema.prisma:L11060`
- `CatalogClientObservation` → `schema.prisma:L11373`
- `CatalogClientReadinessOverride` → `schema.prisma:L11392`
- `CatalogFamily` → `schema.prisma:L11110`
- `CatalogIdempotencyRecord` → `schema.prisma:L11506`
- `CatalogIdentifier` → `schema.prisma:L11241`
- `CatalogImportBatch` → `schema.prisma:L11549`
- `CatalogImportLine` → `schema.prisma:L11586`
- `CatalogItem` → `schema.prisma:L11143`
- `CatalogItemBusinessType` → `schema.prisma:L11203`
- `CatalogItemPrice` → `schema.prisma:L11291`
- `CatalogManufacturer` → `schema.prisma:L11084`
- `CatalogProductTypeMapping` → `schema.prisma:L11220`
- `CatalogPublicationBatch` → `schema.prisma:L11671`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11765`
- `CatalogPublicationLine` → `schema.prisma:L11712`
- `CatalogPublicationOutbox` → `schema.prisma:L11808`
- `CatalogValidationProfile` → `schema.prisma:L11262`
- `CatalogVenueBinding` → `schema.prisma:L11420`
- `CatalogVenueClientRequirement` → `schema.prisma:L11347`
- `CatalogVenueEventSequence` → `schema.prisma:L11791`
- `CatalogVenueOverride` → `schema.prisma:L11462`
- `CatalogVenueRollout` → `schema.prisma:L11322`
- `Cfdi` → `schema.prisma:L16126`
- `ChatbotTokenBudget` → `schema.prisma:L9839`
- `ChatConversation` → `schema.prisma:L9694`
- `ChatFeedback` → `schema.prisma:L9780`
- `ChatLearningEvent` → `schema.prisma:L9737`
- `ChatMessage` → `schema.prisma:L9717`
- `ChatTrainingData` → `schema.prisma:L9651`
- `CheckoutSession` → `schema.prisma:L5887`
- `ClassSession` → `schema.prisma:L13722`
- `CommissionCalculation` → `schema.prisma:L12489`
- `CommissionClawback` → `schema.prisma:L12665`
- `CommissionConfig` → `schema.prisma:L12255`
- `CommissionMilestone` → `schema.prisma:L12405`
- `CommissionOverride` → `schema.prisma:L12332`
- `CommissionPayout` → `schema.prisma:L12616`
- `CommissionSummary` → `schema.prisma:L12555`
- `CommissionTier` → `schema.prisma:L12369`
- `ConsentEvent` → `schema.prisma:L7139`
- `Consumer` → `schema.prisma:L7369`
- `ConsumerAuthAccount` → `schema.prisma:L7394`
- `CouponCode` → `schema.prisma:L8341`
- `CouponRedemption` → `schema.prisma:L8372`
- `CreditAssessmentHistory` → `schema.prisma:L10685`
- `CreditItemBalance` → `schema.prisma:L14334`
- `CreditOffer` → `schema.prisma:L10704`
- `CreditPack` → `schema.prisma:L14243`
- `CreditPackItem` → `schema.prisma:L14272`
- `CreditPackPurchase` → `schema.prisma:L14289`
- `CreditTransaction` → `schema.prisma:L14356`
- `Customer` → `schema.prisma:L6997`
- `CustomerApprovalDelivery` → `schema.prisma:L9353`
- `CustomerApprovalOutbox` → `schema.prisma:L9328`
- `CustomerCampaign` → `schema.prisma:L7227`
- `CustomerCampaignDelivery` → `schema.prisma:L7309`
- `CustomerCaptureToken` → `schema.prisma:L7175`
- `CustomerDiscount` → `schema.prisma:L8392`
- `CustomerGroup` → `schema.prisma:L7433`
- `CustomerOrderMetric` → `schema.prisma:L3875`
- `CustomerTaxProfile` → `schema.prisma:L16205`
- `DeliveryActivationRequest` → `schema.prisma:L6240`
- `DeliveryChannelLink` → `schema.prisma:L6185`
- `DeliveryOrderEvent` → `schema.prisma:L6264`
- `DeviceToken` → `schema.prisma:L8661`
- `DigitalReceipt` → `schema.prisma:L4453`
- `Discount` → `schema.prisma:L8031`
- `EcommerceMerchant` → `schema.prisma:L5699`
- `EmailQuotaLedger` → `schema.prisma:L7356`
- `EmailSuppression` → `schema.prisma:L7344`
- `EmailTemplate` → `schema.prisma:L13008`
- `Employee` → `schema.prisma:L16720`
- `Estimate` → `schema.prisma:L14653`
- `EstimateItem` → `schema.prisma:L14681`
- `Expense` → `schema.prisma:L16507`
- `ExternalBusyBlock` → `schema.prisma:L14011`
- `Feature` → `schema.prisma:L4582`
- `FeeSchedule` → `schema.prisma:L4706`
- `FeeTier` → `schema.prisma:L4717`
- `FinancialAccount` → `schema.prisma:L14843`
- `FinancialConnection` → `schema.prisma:L14812`
- `FinancialProvider` → `schema.prisma:L14798`
- `FiscalEmisor` → `schema.prisma:L16049`
- `FiscalLossCarryforward` → `schema.prisma:L16630`
- `FixedAsset` → `schema.prisma:L16648`
- `FixedAssetDepreciation` → `schema.prisma:L16677`
- `FloorElement` → `schema.prisma:L3180`
- `FulfillmentArea` → `schema.prisma:L15109`
- `GeofenceRule` → `schema.prisma:L10276`
- `GoogleCalendarChannel` → `schema.prisma:L13988`
- `GoogleCalendarConnection` → `schema.prisma:L13940`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14041`
- `GoogleOAuthSession` → `schema.prisma:L14063`
- `HolidayCalendar` → `schema.prisma:L6880`
- `IdempotencyRequest` → `schema.prisma:L12130`
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
- `InventoryTransfer` → `schema.prisma:L14625`
- `Invitation` → `schema.prisma:L1477`
- `Invoice` → `schema.prisma:L4729`
- `InvoiceItem` → `schema.prisma:L4755`
- `ItemCategory` → `schema.prisma:L11843`
- `JournalEntry` → `schema.prisma:L16417`
- `JournalLine` → `schema.prisma:L16445`
- `KdsOrder` → `schema.prisma:L14891`
- `KdsOrderItem` → `schema.prisma:L14932`
- `KioskCheckInAttempt` → `schema.prisma:L17366`
- `KioskCheckInChallenge` → `schema.prisma:L17320`
- `KioskOutreachOutbox` → `schema.prisma:L17387`
- `LaunchCampaign` → `schema.prisma:L17725`
- `LaunchCampaignRedemption` → `schema.prisma:L17831`
- `LearnedPatterns` → `schema.prisma:L9761`
- `LedgerAccount` → `schema.prisma:L16309`
- `LiveDemoSession` → `schema.prisma:L822`
- `LowStockAlert` → `schema.prisma:L2766`
- `LoyaltyConfig` → `schema.prisma:L7463`
- `LoyaltyTransaction` → `schema.prisma:L7506`
- `MarketingCampaign` → `schema.prisma:L13026`
- `McpAuthCode` → `schema.prisma:L15932`
- `McpOAuthClient` → `schema.prisma:L15916`
- `McpRefreshToken` → `schema.prisma:L15950`
- `McpToolCall` → `schema.prisma:L15971`
- `MeasurementUnit` → `schema.prisma:L14731`
- `Menu` → `schema.prisma:L1695`
- `MenuCategory` → `schema.prisma:L1632`
- `MenuCategoryAssignment` → `schema.prisma:L1730`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15846`
- `MerchantAccount` → `schema.prisma:L5437`
- `MerchantFiscalConfig` → `schema.prisma:L16097`
- `MerchantRevenueShare` → `schema.prisma:L6460`
- `MerchantRoutingRule` → `schema.prisma:L5559`
- `MilestoneAchievement` → `schema.prisma:L12450`
- `Modifier` → `schema.prisma:L4059`
- `ModifierGroup` → `schema.prisma:L4023`
- `Module` → `schema.prisma:L10752`
- `MoneyAnomaly` → `schema.prisma:L6363`
- `MonthlyVenueProfit` → `schema.prisma:L6906`
- `Notification` → `schema.prisma:L8563`
- `NotificationPreference` → `schema.prisma:L8610`
- `NotificationTemplate` → `schema.prisma:L8637`
- `OAuthState` → `schema.prisma:L1528`
- `OnboardingProgress` → `schema.prisma:L1546`
- `Order` → `schema.prisma:L3629`
- `OrderAction` → `schema.prisma:L4126`
- `OrderCustomer` → `schema.prisma:L3854`
- `OrderDiscount` → `schema.prisma:L8424`
- `OrderFulfillment` → `schema.prisma:L15164`
- `OrderFulfillmentLine` → `schema.prisma:L15195`
- `OrderItem` → `schema.prisma:L3890`
- `OrderItemModifier` → `schema.prisma:L4108`
- `OrderPromotion` → `schema.prisma:L17283`
- `OrderServiceCharge` → `schema.prisma:L8508`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12827`
- `OrganizationEntitlement` → `schema.prisma:L11035`
- `OrganizationGoal` → `schema.prisma:L12785`
- `OrganizationModule` → `schema.prisma:L10812`
- `OrganizationPaymentConfig` → `schema.prisma:L6011`
- `OrganizationPayoutConfig` → `schema.prisma:L12860`
- `OrganizationPricingStructure` → `schema.prisma:L6043`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12808`
- `OtpChallenge` → `schema.prisma:L7413`
- `OvertimeApproval` → `schema.prisma:L3407`
- `PartnerAPIKey` → `schema.prisma:L5841`
- `Payment` → `schema.prisma:L4159`
- `PaymentAllocation` → `schema.prisma:L4432`
- `PaymentEffect` → `schema.prisma:L17657`
- `PaymentLink` → `schema.prisma:L14402`
- `PaymentLinkAttribution` → `schema.prisma:L14510`
- `PaymentLinkItem` → `schema.prisma:L14465`
- `PaymentLinkItemModifier` → `schema.prisma:L14492`
- `PaymentProvider` → `schema.prisma:L5396`
- `PayrollLine` → `schema.prisma:L16791`
- `PayrollRun` → `schema.prisma:L16760`
- `PerformanceGoal` → `schema.prisma:L12762`
- `PermissionOverride` → `schema.prisma:L1401`
- `PermissionSet` → `schema.prisma:L1424`
- `PlatformAnnouncement` → `schema.prisma:L17447`
- `PlatformAnnouncementClick` → `schema.prisma:L17512`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17549`
- `PlatformCfdi` → `schema.prisma:L17076`
- `PlatformEmisor` → `schema.prisma:L17016`
- `PlatformSettings` → `schema.prisma:L5818`
- `PosCommand` → `schema.prisma:L8691`
- `PosConnectionStatus` → `schema.prisma:L948`
- `PosSyncIntent` → `schema.prisma:L17154`
- `PricingPolicy` → `schema.prisma:L2670`
- `Printer` → `schema.prisma:L14974`
- `PrintGateway` → `schema.prisma:L15031`
- `PrintJob` → `schema.prisma:L15745`
- `PrintStation` → `schema.prisma:L15049`
- `PrivacyNoticeVersion` → `schema.prisma:L7161`
- `ProcessedStripeEvent` → `schema.prisma:L6349`
- `ProcessorReliabilityMetric` → `schema.prisma:L6834`
- `Product` → `schema.prisma:L1748`
- `ProductModifierGroup` → `schema.prisma:L4096`
- `ProductOption` → `schema.prisma:L14708`
- `ProductOptionValue` → `schema.prisma:L14719`
- `ProductStaff` → `schema.prisma:L13637`
- `PromoterBankAccount` → `schema.prisma:L16911`
- `PromoterCommissionEntry` → `schema.prisma:L16930`
- `PromoterLocationPing` → `schema.prisma:L3595`
- `Promotion` → `schema.prisma:L17205`
- `PromotionGroup` → `schema.prisma:L17244`
- `PromotionOption` → `schema.prisma:L17260`
- `ProviderCostStructure` → `schema.prisma:L6385`
- `ProviderEventLog` → `schema.prisma:L6120`
- `PurchaseOrder` → `schema.prisma:L2395`
- `PurchaseOrderInvoice` → `schema.prisma:L2540`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2597`
- `PurchaseOrderItem` → `schema.prisma:L2453`
- `RateCorrectionBatch` → `schema.prisma:L6610`
- `RateCorrectionEntry` → `schema.prisma:L6652`
- `RawMaterial` → `schema.prisma:L2152`
- `RawMaterialMovement` → `schema.prisma:L2723`
- `RawMaterialPresentation` → `schema.prisma:L2227`
- `ReceiptLayout` → `schema.prisma:L17691`
- `Recipe` → `schema.prisma:L2247`
- `RecipeLine` → `schema.prisma:L2271`
- `Referral` → `schema.prisma:L7879`
- `ReferralProgramConfig` → `schema.prisma:L7844`
- `ReferralRewardGrant` → `schema.prisma:L7970`
- `ReferralTierReward` → `schema.prisma:L7942`
- `ReferralTierUnlock` → `schema.prisma:L8015`
- `RefreshGrant` → `schema.prisma:L17636`
- `Reservation` → `schema.prisma:L13405`
- `ReservationGoogleEventMapping` → `schema.prisma:L14175`
- `ReservationModifier` → `schema.prisma:L13585`
- `ReservationReminderSent` → `schema.prisma:L13568`
- `ReservationSettings` → `schema.prisma:L13799`
- `ReservationWaitlistEntry` → `schema.prisma:L13767`
- `Review` → `schema.prisma:L4773`
- `SalesRetention` → `schema.prisma:L16611`
- `SaleVerification` → `schema.prisma:L4486`
- `ScaleProfile` → `schema.prisma:L15486`
- `ScheduledCommand` → `schema.prisma:L10236`
- `SerializedItem` → `schema.prisma:L11886`
- `SerializedItemCustodyEvent` → `schema.prisma:L12053`
- `ServiceCharge` → `schema.prisma:L8479`
- `Session` → `schema.prisma:L17615`
- `SettlementConfiguration` → `schema.prisma:L6685`
- `SettlementConfirmation` → `schema.prisma:L6798`
- `SettlementIncident` → `schema.prisma:L6749`
- `SettlementSimulation` → `schema.prisma:L6720`
- `Shift` → `schema.prisma:L3218`
- `SimRegistrationRequest` → `schema.prisma:L12091`
- `SimRegistrationRequestItem` → `schema.prisma:L12113`
- `SlotHold` → `schema.prisma:L13668`
- `Staff` → `schema.prisma:L968`
- `StaffDocument` → `schema.prisma:L3466`
- `StaffOnboardingState` → `schema.prisma:L15816`
- `StaffOrganization` → `schema.prisma:L1300`
- `StaffPasskey` → `schema.prisma:L1327`
- `StaffSchedule` → `schema.prisma:L13608`
- `StaffScheduleException` → `schema.prisma:L13620`
- `StaffVenue` → `schema.prisma:L1224`
- `StaffWorkSchedule` → `schema.prisma:L3343`
- `StaffWorkScheduleException` → `schema.prisma:L3441`
- `StampCard` → `schema.prisma:L7727`
- `StampEvent` → `schema.prisma:L7766`
- `StampReward` → `schema.prisma:L7804`
- `StockAlertConfig` → `schema.prisma:L12744`
- `StockBatch` → `schema.prisma:L2881`
- `StockCount` → `schema.prisma:L2798`
- `StockCountItem` → `schema.prisma:L2826`
- `StripeWebhookEvent` → `schema.prisma:L6332`
- `Supplier` → `schema.prisma:L2306`
- `SupplierItemCode` → `schema.prisma:L2638`
- `SupplierPricing` → `schema.prisma:L2361`
- `Table` → `schema.prisma:L3130`
- `Terminal` → `schema.prisma:L4824`
- `TerminalAttemptResolution` → `schema.prisma:L5255`
- `TerminalHealth` → `schema.prisma:L5075`
- `TerminalLog` → `schema.prisma:L5049`
- `TerminalOrder` → `schema.prisma:L5299`
- `TerminalOrderItem` → `schema.prisma:L5374`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5227`
- `TerminalPaymentRequest` → `schema.prisma:L5146`
- `TimeEntry` → `schema.prisma:L3508`
- `TimeEntryBreak` → `schema.prisma:L3577`
- `TokenPurchase` → `schema.prisma:L9910`
- `TokenUsageRecord` → `schema.prisma:L9882`
- `TpvCommandHistory` → `schema.prisma:L10142`
- `TpvCommandQueue` → `schema.prisma:L10082`
- `TpvFeedback` → `schema.prisma:L9795`
- `TpvMessage` → `schema.prisma:L13101`
- `TpvMessageDelivery` → `schema.prisma:L13153`
- `TpvMessageResponse` → `schema.prisma:L13176`
- `TrainingModule` → `schema.prisma:L13231`
- `TrainingProgress` → `schema.prisma:L13308`
- `TrainingQuizQuestion` → `schema.prisma:L13290`
- `TrainingStep` → `schema.prisma:L13270`
- `TransactionCost` → `schema.prisma:L6548`
- `UnitConversion` → `schema.prisma:L2701`
- `UpsellAcceptance` → `schema.prisma:L8300`
- `UpsellAiRun` → `schema.prisma:L8320`
- `UpsellImpression` → `schema.prisma:L8260`
- `UpsellRule` → `schema.prisma:L8180`
- `user_sessions` → `schema.prisma:L5876`
- `Venue` → `schema.prisma:L163`
- `VenueAreaTicketSettings` → `schema.prisma:L15223`
- `VenueChatMessage` → `schema.prisma:L798`
- `VenueChatSession` → `schema.prisma:L753`
- `VenueCommission` → `schema.prisma:L14869`
- `VenueCreditAssessment` → `schema.prisma:L10624`
- `VenueCryptoConfig` → `schema.prisma:L12968`
- `VenueFeature` → `schema.prisma:L4600`
- `VenueModule` → `schema.prisma:L10784`
- `VenuePaymentConfig` → `schema.prisma:L5977`
- `VenuePaymentLinkSettings` → `schema.prisma:L14208`
- `VenuePricingStructure` → `schema.prisma:L6488`
- `VenueRoleConfig` → `schema.prisma:L1453`
- `VenueRolePermission` → `schema.prisma:L1357`
- `VenueScaleSettings` → `schema.prisma:L15474`
- `VenueSettings` → `schema.prisma:L838`
- `VenueTenderType` → `schema.prisma:L4345`
- `VenueTenderTypeRevision` → `schema.prisma:L4410`
- `VenueTransaction` → `schema.prisma:L4537`
- `VenueWhatsappActivation` → `schema.prisma:L689`
- `WalletCardDesign` → `schema.prisma:L7645`
- `WalletPass` → `schema.prisma:L7546`
- `WalletPassRegistration` → `schema.prisma:L7612`
- `WebhookEvent` → `schema.prisma:L4682`
- `WebhookSubscription` → `schema.prisma:L6093`
- `WhatsappContactWindow` → `schema.prisma:L707`
- `WhatsappInboundEvent` → `schema.prisma:L727`
- `WorkShiftAssignment` → `schema.prisma:L3383`
- `WorkShiftTemplate` → `schema.prisma:L3360`
- `Zone` → `schema.prisma:L146`
