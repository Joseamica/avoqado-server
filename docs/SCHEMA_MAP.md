# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **375 models / 354 enums / ~18,000 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                                                                                                                                 |
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

- `AccountingPeriodLock` → `schema.prisma:L16606`
- `AccountMapping` → `schema.prisma:L16502`
- `ActivityLog` → `schema.prisma:L7084`
- `Aggregator` → `schema.prisma:L14874`
- `AngelPayUserAccount` → `schema.prisma:L5629`
- `AppUpdate` → `schema.prisma:L13039`
- `Area` → `schema.prisma:L3104`
- `AreaTicket` → `schema.prisma:L15387`
- `AreaTicketCheckoutSession` → `schema.prisma:L15509`
- `AreaTicketExternalIncident` → `schema.prisma:L15756`
- `AreaTicketExternalSettlement` → `schema.prisma:L15721`
- `AreaTicketFulfillment` → `schema.prisma:L15585`
- `AreaTicketInventoryReservation` → `schema.prisma:L15480`
- `AreaTicketLine` → `schema.prisma:L15448`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15541`
- `AreaTicketPrintAttempt` → `schema.prisma:L15564`
- `BankStatement` → `schema.prisma:L16376`
- `BankStatementLine` → `schema.prisma:L16397`
- `BillingObligationConflict` → `schema.prisma:L4666`
- `BillingTaxProfile` → `schema.prisma:L17186`
- `BirthdayAutomation` → `schema.prisma:L7405`
- `BulkCommandOperation` → `schema.prisma:L10319`
- `CalendarSyncOutbox` → `schema.prisma:L14246`
- `CampaignDelivery` → `schema.prisma:L13197`
- `CashCloseout` → `schema.prisma:L10704`
- `CashDeposit` → `schema.prisma:L12841`
- `CashDrawerEvent` → `schema.prisma:L14711`
- `CashDrawerSession` → `schema.prisma:L14672`
- `CashOutCommissionRate` → `schema.prisma:L17015`
- `CashOutScheduleDay` → `schema.prisma:L17038`
- `CashOutWithdrawal` → `schema.prisma:L17100`
- `CatalogBindingBatch` → `schema.prisma:L11735`
- `CatalogBindingLine` → `schema.prisma:L11771`
- `CatalogBrand` → `schema.prisma:L11188`
- `CatalogClientObservation` → `schema.prisma:L11501`
- `CatalogClientReadinessOverride` → `schema.prisma:L11520`
- `CatalogFamily` → `schema.prisma:L11238`
- `CatalogIdempotencyRecord` → `schema.prisma:L11634`
- `CatalogIdentifier` → `schema.prisma:L11369`
- `CatalogImportBatch` → `schema.prisma:L11677`
- `CatalogImportLine` → `schema.prisma:L11714`
- `CatalogItem` → `schema.prisma:L11271`
- `CatalogItemBusinessType` → `schema.prisma:L11331`
- `CatalogItemPrice` → `schema.prisma:L11419`
- `CatalogManufacturer` → `schema.prisma:L11212`
- `CatalogProductTypeMapping` → `schema.prisma:L11348`
- `CatalogPublicationBatch` → `schema.prisma:L11799`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11893`
- `CatalogPublicationLine` → `schema.prisma:L11840`
- `CatalogPublicationOutbox` → `schema.prisma:L11936`
- `CatalogValidationProfile` → `schema.prisma:L11390`
- `CatalogVenueBinding` → `schema.prisma:L11548`
- `CatalogVenueClientRequirement` → `schema.prisma:L11475`
- `CatalogVenueEventSequence` → `schema.prisma:L11919`
- `CatalogVenueOverride` → `schema.prisma:L11590`
- `CatalogVenueRollout` → `schema.prisma:L11450`
- `Cfdi` → `schema.prisma:L16269`
- `ChatbotTokenBudget` → `schema.prisma:L9967`
- `ChatConversation` → `schema.prisma:L9822`
- `ChatFeedback` → `schema.prisma:L9908`
- `ChatLearningEvent` → `schema.prisma:L9865`
- `ChatMessage` → `schema.prisma:L9845`
- `ChatTrainingData` → `schema.prisma:L9779`
- `CheckoutSession` → `schema.prisma:L5909`
- `ClassSession` → `schema.prisma:L13850`
- `CommissionCalculation` → `schema.prisma:L12617`
- `CommissionClawback` → `schema.prisma:L12793`
- `CommissionConfig` → `schema.prisma:L12383`
- `CommissionMilestone` → `schema.prisma:L12533`
- `CommissionOverride` → `schema.prisma:L12460`
- `CommissionPayout` → `schema.prisma:L12744`
- `CommissionSummary` → `schema.prisma:L12683`
- `CommissionTier` → `schema.prisma:L12497`
- `ConsentEvent` → `schema.prisma:L7267`
- `Consumer` → `schema.prisma:L7497`
- `ConsumerAuthAccount` → `schema.prisma:L7522`
- `CouponCode` → `schema.prisma:L8469`
- `CouponRedemption` → `schema.prisma:L8500`
- `CreditAssessmentHistory` → `schema.prisma:L10813`
- `CreditItemBalance` → `schema.prisma:L14462`
- `CreditOffer` → `schema.prisma:L10832`
- `CreditPack` → `schema.prisma:L14371`
- `CreditPackItem` → `schema.prisma:L14400`
- `CreditPackPurchase` → `schema.prisma:L14417`
- `CreditTransaction` → `schema.prisma:L14484`
- `Customer` → `schema.prisma:L7125`
- `CustomerApprovalDelivery` → `schema.prisma:L9481`
- `CustomerApprovalOutbox` → `schema.prisma:L9456`
- `CustomerCampaign` → `schema.prisma:L7355`
- `CustomerCampaignDelivery` → `schema.prisma:L7437`
- `CustomerCaptureToken` → `schema.prisma:L7303`
- `CustomerDiscount` → `schema.prisma:L8520`
- `CustomerGroup` → `schema.prisma:L7561`
- `CustomerOrderMetric` → `schema.prisma:L3892`
- `CustomerTaxProfile` → `schema.prisma:L16348`
- `DeliveryActivationRequest` → `schema.prisma:L6368`
- `DeliveryChannelLink` → `schema.prisma:L6207`
- `DeliveryConnectIntent` → `schema.prisma:L6319`
- `DeliveryLineAction` → `schema.prisma:L6280`
- `DeliveryOrderEvent` → `schema.prisma:L6392`
- `DeliveryStoreRevocation` → `schema.prisma:L6356`
- `DeviceToken` → `schema.prisma:L8789`
- `DigitalReceipt` → `schema.prisma:L4475`
- `Discount` → `schema.prisma:L8159`
- `EcommerceMerchant` → `schema.prisma:L5721`
- `EmailQuotaLedger` → `schema.prisma:L7484`
- `EmailSuppression` → `schema.prisma:L7472`
- `EmailTemplate` → `schema.prisma:L13136`
- `Employee` → `schema.prisma:L16863`
- `Estimate` → `schema.prisma:L14781`
- `EstimateItem` → `schema.prisma:L14809`
- `Expense` → `schema.prisma:L16650`
- `ExternalBusyBlock` → `schema.prisma:L14139`
- `Feature` → `schema.prisma:L4604`
- `FeeSchedule` → `schema.prisma:L4728`
- `FeeTier` → `schema.prisma:L4739`
- `FinancialAccount` → `schema.prisma:L14971`
- `FinancialConnection` → `schema.prisma:L14940`
- `FinancialProvider` → `schema.prisma:L14926`
- `FiscalEmisor` → `schema.prisma:L16192`
- `FiscalLossCarryforward` → `schema.prisma:L16773`
- `FixedAsset` → `schema.prisma:L16791`
- `FixedAssetDepreciation` → `schema.prisma:L16820`
- `FloorElement` → `schema.prisma:L3180`
- `FulfillmentArea` → `schema.prisma:L15252`
- `GeofenceRule` → `schema.prisma:L10404`
- `GoogleCalendarChannel` → `schema.prisma:L14116`
- `GoogleCalendarConnection` → `schema.prisma:L14068`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14169`
- `GoogleOAuthSession` → `schema.prisma:L14191`
- `HolidayCalendar` → `schema.prisma:L7008`
- `IdempotencyRequest` → `schema.prisma:L12258`
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
- `InventoryTransfer` → `schema.prisma:L14753`
- `Invitation` → `schema.prisma:L1477`
- `Invoice` → `schema.prisma:L4751`
- `InvoiceItem` → `schema.prisma:L4777`
- `ItemCategory` → `schema.prisma:L11971`
- `JournalEntry` → `schema.prisma:L16560`
- `JournalLine` → `schema.prisma:L16588`
- `KdsOrder` → `schema.prisma:L15019`
- `KdsOrderItem` → `schema.prisma:L15068`
- `KioskCheckInAttempt` → `schema.prisma:L17509`
- `KioskCheckInChallenge` → `schema.prisma:L17463`
- `KioskOutreachOutbox` → `schema.prisma:L17530`
- `LaunchCampaign` → `schema.prisma:L17868`
- `LaunchCampaignRedemption` → `schema.prisma:L17974`
- `LearnedPatterns` → `schema.prisma:L9889`
- `LedgerAccount` → `schema.prisma:L16452`
- `LiveDemoSession` → `schema.prisma:L822`
- `LowStockAlert` → `schema.prisma:L2766`
- `LoyaltyConfig` → `schema.prisma:L7591`
- `LoyaltyTransaction` → `schema.prisma:L7634`
- `MarketingCampaign` → `schema.prisma:L13154`
- `McpAuthCode` → `schema.prisma:L16075`
- `McpOAuthClient` → `schema.prisma:L16059`
- `McpRefreshToken` → `schema.prisma:L16093`
- `McpToolCall` → `schema.prisma:L16114`
- `MeasurementUnit` → `schema.prisma:L14859`
- `Menu` → `schema.prisma:L1695`
- `MenuCategory` → `schema.prisma:L1632`
- `MenuCategoryAssignment` → `schema.prisma:L1730`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15989`
- `MerchantAccount` → `schema.prisma:L5459`
- `MerchantFiscalConfig` → `schema.prisma:L16240`
- `MerchantRevenueShare` → `schema.prisma:L6588`
- `MerchantRoutingRule` → `schema.prisma:L5581`
- `MilestoneAchievement` → `schema.prisma:L12578`
- `Modifier` → `schema.prisma:L4081`
- `ModifierGroup` → `schema.prisma:L4045`
- `Module` → `schema.prisma:L10880`
- `MoneyAnomaly` → `schema.prisma:L6491`
- `MonthlyVenueProfit` → `schema.prisma:L7034`
- `Notification` → `schema.prisma:L8691`
- `NotificationPreference` → `schema.prisma:L8738`
- `NotificationTemplate` → `schema.prisma:L8765`
- `OAuthState` → `schema.prisma:L1528`
- `OnboardingProgress` → `schema.prisma:L1546`
- `Order` → `schema.prisma:L3629`
- `OrderAction` → `schema.prisma:L4148`
- `OrderCustomer` → `schema.prisma:L3871`
- `OrderDiscount` → `schema.prisma:L8552`
- `OrderFulfillment` → `schema.prisma:L15307`
- `OrderFulfillmentLine` → `schema.prisma:L15338`
- `OrderItem` → `schema.prisma:L3907`
- `OrderItemModifier` → `schema.prisma:L4130`
- `OrderPromotion` → `schema.prisma:L17426`
- `OrderServiceCharge` → `schema.prisma:L8636`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12955`
- `OrganizationEntitlement` → `schema.prisma:L11163`
- `OrganizationGoal` → `schema.prisma:L12913`
- `OrganizationModule` → `schema.prisma:L10940`
- `OrganizationPaymentConfig` → `schema.prisma:L6033`
- `OrganizationPayoutConfig` → `schema.prisma:L12988`
- `OrganizationPricingStructure` → `schema.prisma:L6065`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12936`
- `OtpChallenge` → `schema.prisma:L7541`
- `OvertimeApproval` → `schema.prisma:L3407`
- `PartnerAPIKey` → `schema.prisma:L5863`
- `Payment` → `schema.prisma:L4181`
- `PaymentAllocation` → `schema.prisma:L4454`
- `PaymentEffect` → `schema.prisma:L17800`
- `PaymentLink` → `schema.prisma:L14530`
- `PaymentLinkAttribution` → `schema.prisma:L14638`
- `PaymentLinkItem` → `schema.prisma:L14593`
- `PaymentLinkItemModifier` → `schema.prisma:L14620`
- `PaymentProvider` → `schema.prisma:L5418`
- `PayrollLine` → `schema.prisma:L16934`
- `PayrollRun` → `schema.prisma:L16903`
- `PerformanceGoal` → `schema.prisma:L12890`
- `PermissionOverride` → `schema.prisma:L1401`
- `PermissionSet` → `schema.prisma:L1424`
- `PlatformAnnouncement` → `schema.prisma:L17590`
- `PlatformAnnouncementClick` → `schema.prisma:L17655`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17692`
- `PlatformCfdi` → `schema.prisma:L17219`
- `PlatformEmisor` → `schema.prisma:L17159`
- `PlatformSettings` → `schema.prisma:L5840`
- `PosCommand` → `schema.prisma:L8819`
- `PosConnectionStatus` → `schema.prisma:L948`
- `PosSyncIntent` → `schema.prisma:L17297`
- `PricingPolicy` → `schema.prisma:L2670`
- `Printer` → `schema.prisma:L15117`
- `PrintGateway` → `schema.prisma:L15174`
- `PrintJob` → `schema.prisma:L15888`
- `PrintStation` → `schema.prisma:L15192`
- `PrivacyNoticeVersion` → `schema.prisma:L7289`
- `ProcessedStripeEvent` → `schema.prisma:L6477`
- `ProcessorReliabilityMetric` → `schema.prisma:L6962`
- `Product` → `schema.prisma:L1748`
- `ProductModifierGroup` → `schema.prisma:L4118`
- `ProductOption` → `schema.prisma:L14836`
- `ProductOptionValue` → `schema.prisma:L14847`
- `ProductStaff` → `schema.prisma:L13765`
- `PromoterBankAccount` → `schema.prisma:L17054`
- `PromoterCommissionEntry` → `schema.prisma:L17073`
- `PromoterLocationPing` → `schema.prisma:L3595`
- `Promotion` → `schema.prisma:L17348`
- `PromotionGroup` → `schema.prisma:L17387`
- `PromotionOption` → `schema.prisma:L17403`
- `ProviderCostStructure` → `schema.prisma:L6513`
- `ProviderEventLog` → `schema.prisma:L6142`
- `PurchaseOrder` → `schema.prisma:L2395`
- `PurchaseOrderInvoice` → `schema.prisma:L2540`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2597`
- `PurchaseOrderItem` → `schema.prisma:L2453`
- `RateCorrectionBatch` → `schema.prisma:L6738`
- `RateCorrectionEntry` → `schema.prisma:L6780`
- `RawMaterial` → `schema.prisma:L2152`
- `RawMaterialMovement` → `schema.prisma:L2723`
- `RawMaterialPresentation` → `schema.prisma:L2227`
- `ReceiptLayout` → `schema.prisma:L17834`
- `Recipe` → `schema.prisma:L2247`
- `RecipeLine` → `schema.prisma:L2271`
- `Referral` → `schema.prisma:L8007`
- `ReferralProgramConfig` → `schema.prisma:L7972`
- `ReferralRewardGrant` → `schema.prisma:L8098`
- `ReferralTierReward` → `schema.prisma:L8070`
- `ReferralTierUnlock` → `schema.prisma:L8143`
- `RefreshGrant` → `schema.prisma:L17779`
- `Reservation` → `schema.prisma:L13533`
- `ReservationGoogleEventMapping` → `schema.prisma:L14303`
- `ReservationModifier` → `schema.prisma:L13713`
- `ReservationReminderSent` → `schema.prisma:L13696`
- `ReservationSettings` → `schema.prisma:L13927`
- `ReservationWaitlistEntry` → `schema.prisma:L13895`
- `Review` → `schema.prisma:L4795`
- `SalesRetention` → `schema.prisma:L16754`
- `SaleVerification` → `schema.prisma:L4508`
- `ScaleProfile` → `schema.prisma:L15629`
- `ScheduledCommand` → `schema.prisma:L10364`
- `SerializedItem` → `schema.prisma:L12014`
- `SerializedItemCustodyEvent` → `schema.prisma:L12181`
- `ServiceCharge` → `schema.prisma:L8607`
- `Session` → `schema.prisma:L17758`
- `SettlementConfiguration` → `schema.prisma:L6813`
- `SettlementConfirmation` → `schema.prisma:L6926`
- `SettlementIncident` → `schema.prisma:L6877`
- `SettlementSimulation` → `schema.prisma:L6848`
- `Shift` → `schema.prisma:L3218`
- `SimRegistrationRequest` → `schema.prisma:L12219`
- `SimRegistrationRequestItem` → `schema.prisma:L12241`
- `SlotHold` → `schema.prisma:L13796`
- `Staff` → `schema.prisma:L968`
- `StaffDocument` → `schema.prisma:L3466`
- `StaffOnboardingState` → `schema.prisma:L15959`
- `StaffOrganization` → `schema.prisma:L1300`
- `StaffPasskey` → `schema.prisma:L1327`
- `StaffSchedule` → `schema.prisma:L13736`
- `StaffScheduleException` → `schema.prisma:L13748`
- `StaffVenue` → `schema.prisma:L1224`
- `StaffWorkSchedule` → `schema.prisma:L3343`
- `StaffWorkScheduleException` → `schema.prisma:L3441`
- `StampCard` → `schema.prisma:L7855`
- `StampEvent` → `schema.prisma:L7894`
- `StampReward` → `schema.prisma:L7932`
- `StockAlertConfig` → `schema.prisma:L12872`
- `StockBatch` → `schema.prisma:L2881`
- `StockCount` → `schema.prisma:L2798`
- `StockCountItem` → `schema.prisma:L2826`
- `StripeWebhookEvent` → `schema.prisma:L6460`
- `Supplier` → `schema.prisma:L2306`
- `SupplierItemCode` → `schema.prisma:L2638`
- `SupplierPricing` → `schema.prisma:L2361`
- `Table` → `schema.prisma:L3130`
- `Terminal` → `schema.prisma:L4846`
- `TerminalAttemptResolution` → `schema.prisma:L5277`
- `TerminalHealth` → `schema.prisma:L5097`
- `TerminalLog` → `schema.prisma:L5071`
- `TerminalOrder` → `schema.prisma:L5321`
- `TerminalOrderItem` → `schema.prisma:L5396`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5249`
- `TerminalPaymentRequest` → `schema.prisma:L5168`
- `TimeEntry` → `schema.prisma:L3508`
- `TimeEntryBreak` → `schema.prisma:L3577`
- `TokenPurchase` → `schema.prisma:L10038`
- `TokenUsageRecord` → `schema.prisma:L10010`
- `TpvCommandHistory` → `schema.prisma:L10270`
- `TpvCommandQueue` → `schema.prisma:L10210`
- `TpvFeedback` → `schema.prisma:L9923`
- `TpvMessage` → `schema.prisma:L13229`
- `TpvMessageDelivery` → `schema.prisma:L13281`
- `TpvMessageResponse` → `schema.prisma:L13304`
- `TrainingModule` → `schema.prisma:L13359`
- `TrainingProgress` → `schema.prisma:L13436`
- `TrainingQuizQuestion` → `schema.prisma:L13418`
- `TrainingStep` → `schema.prisma:L13398`
- `TransactionCost` → `schema.prisma:L6676`
- `UnitConversion` → `schema.prisma:L2701`
- `UpsellAcceptance` → `schema.prisma:L8428`
- `UpsellAiRun` → `schema.prisma:L8448`
- `UpsellImpression` → `schema.prisma:L8388`
- `UpsellRule` → `schema.prisma:L8308`
- `user_sessions` → `schema.prisma:L5898`
- `Venue` → `schema.prisma:L163`
- `VenueAreaTicketSettings` → `schema.prisma:L15366`
- `VenueChatMessage` → `schema.prisma:L798`
- `VenueChatSession` → `schema.prisma:L753`
- `VenueCommission` → `schema.prisma:L14997`
- `VenueCreditAssessment` → `schema.prisma:L10752`
- `VenueCryptoConfig` → `schema.prisma:L13096`
- `VenueFeature` → `schema.prisma:L4622`
- `VenueModule` → `schema.prisma:L10912`
- `VenuePaymentConfig` → `schema.prisma:L5999`
- `VenuePaymentLinkSettings` → `schema.prisma:L14336`
- `VenuePricingStructure` → `schema.prisma:L6616`
- `VenueRoleConfig` → `schema.prisma:L1453`
- `VenueRolePermission` → `schema.prisma:L1357`
- `VenueScaleSettings` → `schema.prisma:L15617`
- `VenueSettings` → `schema.prisma:L838`
- `VenueTenderType` → `schema.prisma:L4367`
- `VenueTenderTypeRevision` → `schema.prisma:L4432`
- `VenueTransaction` → `schema.prisma:L4559`
- `VenueWhatsappActivation` → `schema.prisma:L689`
- `WalletCardDesign` → `schema.prisma:L7773`
- `WalletPass` → `schema.prisma:L7674`
- `WalletPassRegistration` → `schema.prisma:L7740`
- `WebhookEvent` → `schema.prisma:L4704`
- `WebhookSubscription` → `schema.prisma:L6115`
- `WhatsappContactWindow` → `schema.prisma:L707`
- `WhatsappInboundEvent` → `schema.prisma:L727`
- `WorkShiftAssignment` → `schema.prisma:L3383`
- `WorkShiftTemplate` → `schema.prisma:L3360`
- `Zone` → `schema.prisma:L146`
