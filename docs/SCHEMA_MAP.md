# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **368 models / 346 enums / ~17,500 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
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

- `AccountingPeriodLock` → `schema.prisma:L16328`
- `AccountMapping` → `schema.prisma:L16224`
- `ActivityLog` → `schema.prisma:L6831`
- `Aggregator` → `schema.prisma:L14621`
- `AngelPayUserAccount` → `schema.prisma:L5482`
- `AppUpdate` → `schema.prisma:L12786`
- `Area` → `schema.prisma:L3064`
- `AreaTicket` → `schema.prisma:L15119`
- `AreaTicketCheckoutSession` → `schema.prisma:L15241`
- `AreaTicketExternalIncident` → `schema.prisma:L15488`
- `AreaTicketExternalSettlement` → `schema.prisma:L15453`
- `AreaTicketFulfillment` → `schema.prisma:L15317`
- `AreaTicketInventoryReservation` → `schema.prisma:L15212`
- `AreaTicketLine` → `schema.prisma:L15180`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15273`
- `AreaTicketPrintAttempt` → `schema.prisma:L15296`
- `BankStatement` → `schema.prisma:L16098`
- `BankStatementLine` → `schema.prisma:L16119`
- `BillingTaxProfile` → `schema.prisma:L16908`
- `BirthdayAutomation` → `schema.prisma:L7152`
- `BulkCommandOperation` → `schema.prisma:L10066`
- `CalendarSyncOutbox` → `schema.prisma:L13993`
- `CampaignDelivery` → `schema.prisma:L12944`
- `CashCloseout` → `schema.prisma:L10451`
- `CashDeposit` → `schema.prisma:L12588`
- `CashDrawerEvent` → `schema.prisma:L14458`
- `CashDrawerSession` → `schema.prisma:L14419`
- `CashOutCommissionRate` → `schema.prisma:L16737`
- `CashOutScheduleDay` → `schema.prisma:L16760`
- `CashOutWithdrawal` → `schema.prisma:L16822`
- `CatalogBindingBatch` → `schema.prisma:L11482`
- `CatalogBindingLine` → `schema.prisma:L11518`
- `CatalogBrand` → `schema.prisma:L10935`
- `CatalogClientObservation` → `schema.prisma:L11248`
- `CatalogClientReadinessOverride` → `schema.prisma:L11267`
- `CatalogFamily` → `schema.prisma:L10985`
- `CatalogIdempotencyRecord` → `schema.prisma:L11381`
- `CatalogIdentifier` → `schema.prisma:L11116`
- `CatalogImportBatch` → `schema.prisma:L11424`
- `CatalogImportLine` → `schema.prisma:L11461`
- `CatalogItem` → `schema.prisma:L11018`
- `CatalogItemBusinessType` → `schema.prisma:L11078`
- `CatalogItemPrice` → `schema.prisma:L11166`
- `CatalogManufacturer` → `schema.prisma:L10959`
- `CatalogProductTypeMapping` → `schema.prisma:L11095`
- `CatalogPublicationBatch` → `schema.prisma:L11546`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11640`
- `CatalogPublicationLine` → `schema.prisma:L11587`
- `CatalogPublicationOutbox` → `schema.prisma:L11683`
- `CatalogValidationProfile` → `schema.prisma:L11137`
- `CatalogVenueBinding` → `schema.prisma:L11295`
- `CatalogVenueClientRequirement` → `schema.prisma:L11222`
- `CatalogVenueEventSequence` → `schema.prisma:L11666`
- `CatalogVenueOverride` → `schema.prisma:L11337`
- `CatalogVenueRollout` → `schema.prisma:L11197`
- `Cfdi` → `schema.prisma:L16001`
- `ChatbotTokenBudget` → `schema.prisma:L9714`
- `ChatConversation` → `schema.prisma:L9569`
- `ChatFeedback` → `schema.prisma:L9655`
- `ChatLearningEvent` → `schema.prisma:L9612`
- `ChatMessage` → `schema.prisma:L9592`
- `ChatTrainingData` → `schema.prisma:L9526`
- `CheckoutSession` → `schema.prisma:L5762`
- `ClassSession` → `schema.prisma:L13597`
- `CommissionCalculation` → `schema.prisma:L12364`
- `CommissionClawback` → `schema.prisma:L12540`
- `CommissionConfig` → `schema.prisma:L12130`
- `CommissionMilestone` → `schema.prisma:L12280`
- `CommissionOverride` → `schema.prisma:L12207`
- `CommissionPayout` → `schema.prisma:L12491`
- `CommissionSummary` → `schema.prisma:L12430`
- `CommissionTier` → `schema.prisma:L12244`
- `ConsentEvent` → `schema.prisma:L7014`
- `Consumer` → `schema.prisma:L7244`
- `ConsumerAuthAccount` → `schema.prisma:L7269`
- `CouponCode` → `schema.prisma:L8216`
- `CouponRedemption` → `schema.prisma:L8247`
- `CreditAssessmentHistory` → `schema.prisma:L10560`
- `CreditItemBalance` → `schema.prisma:L14209`
- `CreditOffer` → `schema.prisma:L10579`
- `CreditPack` → `schema.prisma:L14118`
- `CreditPackItem` → `schema.prisma:L14147`
- `CreditPackPurchase` → `schema.prisma:L14164`
- `CreditTransaction` → `schema.prisma:L14231`
- `Customer` → `schema.prisma:L6872`
- `CustomerApprovalDelivery` → `schema.prisma:L9228`
- `CustomerApprovalOutbox` → `schema.prisma:L9203`
- `CustomerCampaign` → `schema.prisma:L7102`
- `CustomerCampaignDelivery` → `schema.prisma:L7184`
- `CustomerCaptureToken` → `schema.prisma:L7050`
- `CustomerDiscount` → `schema.prisma:L8267`
- `CustomerGroup` → `schema.prisma:L7308`
- `CustomerOrderMetric` → `schema.prisma:L3835`
- `CustomerTaxProfile` → `schema.prisma:L16070`
- `DeliveryActivationRequest` → `schema.prisma:L6115`
- `DeliveryChannelLink` → `schema.prisma:L6060`
- `DeliveryOrderEvent` → `schema.prisma:L6139`
- `DeviceToken` → `schema.prisma:L8536`
- `DigitalReceipt` → `schema.prisma:L4413`
- `Discount` → `schema.prisma:L7906`
- `EcommerceMerchant` → `schema.prisma:L5574`
- `EmailQuotaLedger` → `schema.prisma:L7231`
- `EmailSuppression` → `schema.prisma:L7219`
- `EmailTemplate` → `schema.prisma:L12883`
- `Employee` → `schema.prisma:L16585`
- `Estimate` → `schema.prisma:L14528`
- `EstimateItem` → `schema.prisma:L14556`
- `Expense` → `schema.prisma:L16372`
- `ExternalBusyBlock` → `schema.prisma:L13886`
- `Feature` → `schema.prisma:L4542`
- `FeeSchedule` → `schema.prisma:L4620`
- `FeeTier` → `schema.prisma:L4631`
- `FinancialAccount` → `schema.prisma:L14718`
- `FinancialConnection` → `schema.prisma:L14687`
- `FinancialProvider` → `schema.prisma:L14673`
- `FiscalEmisor` → `schema.prisma:L15924`
- `FiscalLossCarryforward` → `schema.prisma:L16495`
- `FixedAsset` → `schema.prisma:L16513`
- `FixedAssetDepreciation` → `schema.prisma:L16542`
- `FloorElement` → `schema.prisma:L3140`
- `FulfillmentArea` → `schema.prisma:L14984`
- `GeofenceRule` → `schema.prisma:L10151`
- `GoogleCalendarChannel` → `schema.prisma:L13863`
- `GoogleCalendarConnection` → `schema.prisma:L13815`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13916`
- `GoogleOAuthSession` → `schema.prisma:L13938`
- `HolidayCalendar` → `schema.prisma:L6755`
- `IdempotencyRequest` → `schema.prisma:L12005`
- `InterVenueTransfer` → `schema.prisma:L2892`
- `InterVenueTransferAllocation` → `schema.prisma:L2975`
- `InterVenueTransferItem` → `schema.prisma:L2944`
- `InterVenueTransferReceipt` → `schema.prisma:L3002`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3018`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3046`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3030`
- `Inventory` → `schema.prisma:L1931`
- `InventoryMovement` → `schema.prisma:L1958`
- `InventoryPosting` → `schema.prisma:L2040`
- `InventoryPostingLine` → `schema.prisma:L2080`
- `InventoryTransfer` → `schema.prisma:L14500`
- `Invitation` → `schema.prisma:L1469`
- `Invoice` → `schema.prisma:L4643`
- `InvoiceItem` → `schema.prisma:L4669`
- `ItemCategory` → `schema.prisma:L11718`
- `JournalEntry` → `schema.prisma:L16282`
- `JournalLine` → `schema.prisma:L16310`
- `KdsOrder` → `schema.prisma:L14766`
- `KdsOrderItem` → `schema.prisma:L14807`
- `KioskCheckInAttempt` → `schema.prisma:L17231`
- `KioskCheckInChallenge` → `schema.prisma:L17185`
- `KioskOutreachOutbox` → `schema.prisma:L17252`
- `LearnedPatterns` → `schema.prisma:L9636`
- `LedgerAccount` → `schema.prisma:L16174`
- `LiveDemoSession` → `schema.prisma:L814`
- `LowStockAlert` → `schema.prisma:L2726`
- `LoyaltyConfig` → `schema.prisma:L7338`
- `LoyaltyTransaction` → `schema.prisma:L7381`
- `MarketingCampaign` → `schema.prisma:L12901`
- `McpAuthCode` → `schema.prisma:L15807`
- `McpOAuthClient` → `schema.prisma:L15791`
- `McpRefreshToken` → `schema.prisma:L15825`
- `McpToolCall` → `schema.prisma:L15846`
- `MeasurementUnit` → `schema.prisma:L14606`
- `Menu` → `schema.prisma:L1655`
- `MenuCategory` → `schema.prisma:L1592`
- `MenuCategoryAssignment` → `schema.prisma:L1690`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15721`
- `MerchantAccount` → `schema.prisma:L5312`
- `MerchantFiscalConfig` → `schema.prisma:L15972`
- `MerchantRevenueShare` → `schema.prisma:L6335`
- `MerchantRoutingRule` → `schema.prisma:L5434`
- `MilestoneAchievement` → `schema.prisma:L12325`
- `Modifier` → `schema.prisma:L4019`
- `ModifierGroup` → `schema.prisma:L3983`
- `Module` → `schema.prisma:L10627`
- `MoneyAnomaly` → `schema.prisma:L6238`
- `MonthlyVenueProfit` → `schema.prisma:L6781`
- `Notification` → `schema.prisma:L8438`
- `NotificationPreference` → `schema.prisma:L8485`
- `NotificationTemplate` → `schema.prisma:L8512`
- `OAuthState` → `schema.prisma:L1520`
- `OnboardingProgress` → `schema.prisma:L1538`
- `Order` → `schema.prisma:L3589`
- `OrderAction` → `schema.prisma:L4086`
- `OrderCustomer` → `schema.prisma:L3814`
- `OrderDiscount` → `schema.prisma:L8299`
- `OrderFulfillment` → `schema.prisma:L15039`
- `OrderFulfillmentLine` → `schema.prisma:L15070`
- `OrderItem` → `schema.prisma:L3850`
- `OrderItemModifier` → `schema.prisma:L4068`
- `OrderPromotion` → `schema.prisma:L17148`
- `OrderServiceCharge` → `schema.prisma:L8383`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12702`
- `OrganizationEntitlement` → `schema.prisma:L10910`
- `OrganizationGoal` → `schema.prisma:L12660`
- `OrganizationModule` → `schema.prisma:L10687`
- `OrganizationPaymentConfig` → `schema.prisma:L5886`
- `OrganizationPayoutConfig` → `schema.prisma:L12735`
- `OrganizationPricingStructure` → `schema.prisma:L5918`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12683`
- `OtpChallenge` → `schema.prisma:L7288`
- `OvertimeApproval` → `schema.prisma:L3367`
- `PartnerAPIKey` → `schema.prisma:L5716`
- `Payment` → `schema.prisma:L4119`
- `PaymentAllocation` → `schema.prisma:L4392`
- `PaymentEffect` → `schema.prisma:L17522`
- `PaymentLink` → `schema.prisma:L14277`
- `PaymentLinkAttribution` → `schema.prisma:L14385`
- `PaymentLinkItem` → `schema.prisma:L14340`
- `PaymentLinkItemModifier` → `schema.prisma:L14367`
- `PaymentProvider` → `schema.prisma:L5271`
- `PayrollLine` → `schema.prisma:L16656`
- `PayrollRun` → `schema.prisma:L16625`
- `PerformanceGoal` → `schema.prisma:L12637`
- `PermissionOverride` → `schema.prisma:L1393`
- `PermissionSet` → `schema.prisma:L1416`
- `PlatformAnnouncement` → `schema.prisma:L17312`
- `PlatformAnnouncementClick` → `schema.prisma:L17377`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17414`
- `PlatformCfdi` → `schema.prisma:L16941`
- `PlatformEmisor` → `schema.prisma:L16881`
- `PlatformSettings` → `schema.prisma:L5693`
- `PosCommand` → `schema.prisma:L8566`
- `PosConnectionStatus` → `schema.prisma:L940`
- `PosSyncIntent` → `schema.prisma:L17019`
- `PricingPolicy` → `schema.prisma:L2630`
- `Printer` → `schema.prisma:L14849`
- `PrintGateway` → `schema.prisma:L14906`
- `PrintJob` → `schema.prisma:L15620`
- `PrintStation` → `schema.prisma:L14924`
- `PrivacyNoticeVersion` → `schema.prisma:L7036`
- `ProcessedStripeEvent` → `schema.prisma:L6224`
- `ProcessorReliabilityMetric` → `schema.prisma:L6709`
- `Product` → `schema.prisma:L1708`
- `ProductModifierGroup` → `schema.prisma:L4056`
- `ProductOption` → `schema.prisma:L14583`
- `ProductOptionValue` → `schema.prisma:L14594`
- `ProductStaff` → `schema.prisma:L13512`
- `PromoterBankAccount` → `schema.prisma:L16776`
- `PromoterCommissionEntry` → `schema.prisma:L16795`
- `PromoterLocationPing` → `schema.prisma:L3555`
- `Promotion` → `schema.prisma:L17070`
- `PromotionGroup` → `schema.prisma:L17109`
- `PromotionOption` → `schema.prisma:L17125`
- `ProviderCostStructure` → `schema.prisma:L6260`
- `ProviderEventLog` → `schema.prisma:L5995`
- `PurchaseOrder` → `schema.prisma:L2355`
- `PurchaseOrderInvoice` → `schema.prisma:L2500`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2557`
- `PurchaseOrderItem` → `schema.prisma:L2413`
- `RateCorrectionBatch` → `schema.prisma:L6485`
- `RateCorrectionEntry` → `schema.prisma:L6527`
- `RawMaterial` → `schema.prisma:L2112`
- `RawMaterialMovement` → `schema.prisma:L2683`
- `RawMaterialPresentation` → `schema.prisma:L2187`
- `ReceiptLayout` → `schema.prisma:L17556`
- `Recipe` → `schema.prisma:L2207`
- `RecipeLine` → `schema.prisma:L2231`
- `Referral` → `schema.prisma:L7754`
- `ReferralProgramConfig` → `schema.prisma:L7719`
- `ReferralRewardGrant` → `schema.prisma:L7845`
- `ReferralTierReward` → `schema.prisma:L7817`
- `ReferralTierUnlock` → `schema.prisma:L7890`
- `RefreshGrant` → `schema.prisma:L17501`
- `Reservation` → `schema.prisma:L13280`
- `ReservationGoogleEventMapping` → `schema.prisma:L14050`
- `ReservationModifier` → `schema.prisma:L13460`
- `ReservationReminderSent` → `schema.prisma:L13443`
- `ReservationSettings` → `schema.prisma:L13674`
- `ReservationWaitlistEntry` → `schema.prisma:L13642`
- `Review` → `schema.prisma:L4687`
- `SalesRetention` → `schema.prisma:L16476`
- `SaleVerification` → `schema.prisma:L4446`
- `ScaleProfile` → `schema.prisma:L15361`
- `ScheduledCommand` → `schema.prisma:L10111`
- `SerializedItem` → `schema.prisma:L11761`
- `SerializedItemCustodyEvent` → `schema.prisma:L11928`
- `ServiceCharge` → `schema.prisma:L8354`
- `Session` → `schema.prisma:L17480`
- `SettlementConfiguration` → `schema.prisma:L6560`
- `SettlementConfirmation` → `schema.prisma:L6673`
- `SettlementIncident` → `schema.prisma:L6624`
- `SettlementSimulation` → `schema.prisma:L6595`
- `Shift` → `schema.prisma:L3178`
- `SimRegistrationRequest` → `schema.prisma:L11966`
- `SimRegistrationRequestItem` → `schema.prisma:L11988`
- `SlotHold` → `schema.prisma:L13543`
- `Staff` → `schema.prisma:L960`
- `StaffDocument` → `schema.prisma:L3426`
- `StaffOnboardingState` → `schema.prisma:L15691`
- `StaffOrganization` → `schema.prisma:L1292`
- `StaffPasskey` → `schema.prisma:L1319`
- `StaffSchedule` → `schema.prisma:L13483`
- `StaffScheduleException` → `schema.prisma:L13495`
- `StaffVenue` → `schema.prisma:L1216`
- `StaffWorkSchedule` → `schema.prisma:L3303`
- `StaffWorkScheduleException` → `schema.prisma:L3401`
- `StampCard` → `schema.prisma:L7602`
- `StampEvent` → `schema.prisma:L7641`
- `StampReward` → `schema.prisma:L7679`
- `StockAlertConfig` → `schema.prisma:L12619`
- `StockBatch` → `schema.prisma:L2841`
- `StockCount` → `schema.prisma:L2758`
- `StockCountItem` → `schema.prisma:L2786`
- `StripeWebhookEvent` → `schema.prisma:L6207`
- `Supplier` → `schema.prisma:L2266`
- `SupplierItemCode` → `schema.prisma:L2598`
- `SupplierPricing` → `schema.prisma:L2321`
- `Table` → `schema.prisma:L3090`
- `Terminal` → `schema.prisma:L4738`
- `TerminalHealth` → `schema.prisma:L4989`
- `TerminalLog` → `schema.prisma:L4963`
- `TerminalOrder` → `schema.prisma:L5174`
- `TerminalOrderItem` → `schema.prisma:L5249`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5127`
- `TerminalPaymentRequest` → `schema.prisma:L5060`
- `TimeEntry` → `schema.prisma:L3468`
- `TimeEntryBreak` → `schema.prisma:L3537`
- `TokenPurchase` → `schema.prisma:L9785`
- `TokenUsageRecord` → `schema.prisma:L9757`
- `TpvCommandHistory` → `schema.prisma:L10017`
- `TpvCommandQueue` → `schema.prisma:L9957`
- `TpvFeedback` → `schema.prisma:L9670`
- `TpvMessage` → `schema.prisma:L12976`
- `TpvMessageDelivery` → `schema.prisma:L13028`
- `TpvMessageResponse` → `schema.prisma:L13051`
- `TrainingModule` → `schema.prisma:L13106`
- `TrainingProgress` → `schema.prisma:L13183`
- `TrainingQuizQuestion` → `schema.prisma:L13165`
- `TrainingStep` → `schema.prisma:L13145`
- `TransactionCost` → `schema.prisma:L6423`
- `UnitConversion` → `schema.prisma:L2661`
- `UpsellAcceptance` → `schema.prisma:L8175`
- `UpsellAiRun` → `schema.prisma:L8195`
- `UpsellImpression` → `schema.prisma:L8135`
- `UpsellRule` → `schema.prisma:L8055`
- `user_sessions` → `schema.prisma:L5751`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L15098`
- `VenueChatMessage` → `schema.prisma:L790`
- `VenueChatSession` → `schema.prisma:L745`
- `VenueCommission` → `schema.prisma:L14744`
- `VenueCreditAssessment` → `schema.prisma:L10499`
- `VenueCryptoConfig` → `schema.prisma:L12843`
- `VenueFeature` → `schema.prisma:L4560`
- `VenueModule` → `schema.prisma:L10659`
- `VenuePaymentConfig` → `schema.prisma:L5852`
- `VenuePaymentLinkSettings` → `schema.prisma:L14083`
- `VenuePricingStructure` → `schema.prisma:L6363`
- `VenueRoleConfig` → `schema.prisma:L1445`
- `VenueRolePermission` → `schema.prisma:L1349`
- `VenueScaleSettings` → `schema.prisma:L15349`
- `VenueSettings` → `schema.prisma:L830`
- `VenueTenderType` → `schema.prisma:L4305`
- `VenueTenderTypeRevision` → `schema.prisma:L4370`
- `VenueTransaction` → `schema.prisma:L4497`
- `VenueWhatsappActivation` → `schema.prisma:L681`
- `WalletCardDesign` → `schema.prisma:L7520`
- `WalletPass` → `schema.prisma:L7421`
- `WalletPassRegistration` → `schema.prisma:L7487`
- `WebhookEvent` → `schema.prisma:L4596`
- `WebhookSubscription` → `schema.prisma:L5968`
- `WhatsappContactWindow` → `schema.prisma:L699`
- `WhatsappInboundEvent` → `schema.prisma:L719`
- `WorkShiftAssignment` → `schema.prisma:L3343`
- `WorkShiftTemplate` → `schema.prisma:L3320`
- `Zone` → `schema.prisma:L142`
