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

- `AccountingPeriodLock` → `schema.prisma:L16363`
- `AccountMapping` → `schema.prisma:L16259`
- `ActivityLog` → `schema.prisma:L6866`
- `Aggregator` → `schema.prisma:L14656`
- `AngelPayUserAccount` → `schema.prisma:L5517`
- `AppUpdate` → `schema.prisma:L12821`
- `Area` → `schema.prisma:L3104`
- `AreaTicket` → `schema.prisma:L15154`
- `AreaTicketCheckoutSession` → `schema.prisma:L15276`
- `AreaTicketExternalIncident` → `schema.prisma:L15523`
- `AreaTicketExternalSettlement` → `schema.prisma:L15488`
- `AreaTicketFulfillment` → `schema.prisma:L15352`
- `AreaTicketInventoryReservation` → `schema.prisma:L15247`
- `AreaTicketLine` → `schema.prisma:L15215`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15308`
- `AreaTicketPrintAttempt` → `schema.prisma:L15331`
- `BankStatement` → `schema.prisma:L16133`
- `BankStatementLine` → `schema.prisma:L16154`
- `BillingTaxProfile` → `schema.prisma:L16943`
- `BirthdayAutomation` → `schema.prisma:L7187`
- `BulkCommandOperation` → `schema.prisma:L10101`
- `CalendarSyncOutbox` → `schema.prisma:L14028`
- `CampaignDelivery` → `schema.prisma:L12979`
- `CashCloseout` → `schema.prisma:L10486`
- `CashDeposit` → `schema.prisma:L12623`
- `CashDrawerEvent` → `schema.prisma:L14493`
- `CashDrawerSession` → `schema.prisma:L14454`
- `CashOutCommissionRate` → `schema.prisma:L16772`
- `CashOutScheduleDay` → `schema.prisma:L16795`
- `CashOutWithdrawal` → `schema.prisma:L16857`
- `CatalogBindingBatch` → `schema.prisma:L11517`
- `CatalogBindingLine` → `schema.prisma:L11553`
- `CatalogBrand` → `schema.prisma:L10970`
- `CatalogClientObservation` → `schema.prisma:L11283`
- `CatalogClientReadinessOverride` → `schema.prisma:L11302`
- `CatalogFamily` → `schema.prisma:L11020`
- `CatalogIdempotencyRecord` → `schema.prisma:L11416`
- `CatalogIdentifier` → `schema.prisma:L11151`
- `CatalogImportBatch` → `schema.prisma:L11459`
- `CatalogImportLine` → `schema.prisma:L11496`
- `CatalogItem` → `schema.prisma:L11053`
- `CatalogItemBusinessType` → `schema.prisma:L11113`
- `CatalogItemPrice` → `schema.prisma:L11201`
- `CatalogManufacturer` → `schema.prisma:L10994`
- `CatalogProductTypeMapping` → `schema.prisma:L11130`
- `CatalogPublicationBatch` → `schema.prisma:L11581`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11675`
- `CatalogPublicationLine` → `schema.prisma:L11622`
- `CatalogPublicationOutbox` → `schema.prisma:L11718`
- `CatalogValidationProfile` → `schema.prisma:L11172`
- `CatalogVenueBinding` → `schema.prisma:L11330`
- `CatalogVenueClientRequirement` → `schema.prisma:L11257`
- `CatalogVenueEventSequence` → `schema.prisma:L11701`
- `CatalogVenueOverride` → `schema.prisma:L11372`
- `CatalogVenueRollout` → `schema.prisma:L11232`
- `Cfdi` → `schema.prisma:L16036`
- `ChatbotTokenBudget` → `schema.prisma:L9749`
- `ChatConversation` → `schema.prisma:L9604`
- `ChatFeedback` → `schema.prisma:L9690`
- `ChatLearningEvent` → `schema.prisma:L9647`
- `ChatMessage` → `schema.prisma:L9627`
- `ChatTrainingData` → `schema.prisma:L9561`
- `CheckoutSession` → `schema.prisma:L5797`
- `ClassSession` → `schema.prisma:L13632`
- `CommissionCalculation` → `schema.prisma:L12399`
- `CommissionClawback` → `schema.prisma:L12575`
- `CommissionConfig` → `schema.prisma:L12165`
- `CommissionMilestone` → `schema.prisma:L12315`
- `CommissionOverride` → `schema.prisma:L12242`
- `CommissionPayout` → `schema.prisma:L12526`
- `CommissionSummary` → `schema.prisma:L12465`
- `CommissionTier` → `schema.prisma:L12279`
- `ConsentEvent` → `schema.prisma:L7049`
- `Consumer` → `schema.prisma:L7279`
- `ConsumerAuthAccount` → `schema.prisma:L7304`
- `CouponCode` → `schema.prisma:L8251`
- `CouponRedemption` → `schema.prisma:L8282`
- `CreditAssessmentHistory` → `schema.prisma:L10595`
- `CreditItemBalance` → `schema.prisma:L14244`
- `CreditOffer` → `schema.prisma:L10614`
- `CreditPack` → `schema.prisma:L14153`
- `CreditPackItem` → `schema.prisma:L14182`
- `CreditPackPurchase` → `schema.prisma:L14199`
- `CreditTransaction` → `schema.prisma:L14266`
- `Customer` → `schema.prisma:L6907`
- `CustomerApprovalDelivery` → `schema.prisma:L9263`
- `CustomerApprovalOutbox` → `schema.prisma:L9238`
- `CustomerCampaign` → `schema.prisma:L7137`
- `CustomerCampaignDelivery` → `schema.prisma:L7219`
- `CustomerCaptureToken` → `schema.prisma:L7085`
- `CustomerDiscount` → `schema.prisma:L8302`
- `CustomerGroup` → `schema.prisma:L7343`
- `CustomerOrderMetric` → `schema.prisma:L3875`
- `CustomerTaxProfile` → `schema.prisma:L16105`
- `DeliveryActivationRequest` → `schema.prisma:L6150`
- `DeliveryChannelLink` → `schema.prisma:L6095`
- `DeliveryOrderEvent` → `schema.prisma:L6174`
- `DeviceToken` → `schema.prisma:L8571`
- `DigitalReceipt` → `schema.prisma:L4453`
- `Discount` → `schema.prisma:L7941`
- `EcommerceMerchant` → `schema.prisma:L5609`
- `EmailQuotaLedger` → `schema.prisma:L7266`
- `EmailSuppression` → `schema.prisma:L7254`
- `EmailTemplate` → `schema.prisma:L12918`
- `Employee` → `schema.prisma:L16620`
- `Estimate` → `schema.prisma:L14563`
- `EstimateItem` → `schema.prisma:L14591`
- `Expense` → `schema.prisma:L16407`
- `ExternalBusyBlock` → `schema.prisma:L13921`
- `Feature` → `schema.prisma:L4582`
- `FeeSchedule` → `schema.prisma:L4660`
- `FeeTier` → `schema.prisma:L4671`
- `FinancialAccount` → `schema.prisma:L14753`
- `FinancialConnection` → `schema.prisma:L14722`
- `FinancialProvider` → `schema.prisma:L14708`
- `FiscalEmisor` → `schema.prisma:L15959`
- `FiscalLossCarryforward` → `schema.prisma:L16530`
- `FixedAsset` → `schema.prisma:L16548`
- `FixedAssetDepreciation` → `schema.prisma:L16577`
- `FloorElement` → `schema.prisma:L3180`
- `FulfillmentArea` → `schema.prisma:L15019`
- `GeofenceRule` → `schema.prisma:L10186`
- `GoogleCalendarChannel` → `schema.prisma:L13898`
- `GoogleCalendarConnection` → `schema.prisma:L13850`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13951`
- `GoogleOAuthSession` → `schema.prisma:L13973`
- `HolidayCalendar` → `schema.prisma:L6790`
- `IdempotencyRequest` → `schema.prisma:L12040`
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
- `InventoryTransfer` → `schema.prisma:L14535`
- `Invitation` → `schema.prisma:L1477`
- `Invoice` → `schema.prisma:L4683`
- `InvoiceItem` → `schema.prisma:L4709`
- `ItemCategory` → `schema.prisma:L11753`
- `JournalEntry` → `schema.prisma:L16317`
- `JournalLine` → `schema.prisma:L16345`
- `KdsOrder` → `schema.prisma:L14801`
- `KdsOrderItem` → `schema.prisma:L14842`
- `KioskCheckInAttempt` → `schema.prisma:L17266`
- `KioskCheckInChallenge` → `schema.prisma:L17220`
- `KioskOutreachOutbox` → `schema.prisma:L17287`
- `LaunchCampaign` → `schema.prisma:L17625`
- `LaunchCampaignRedemption` → `schema.prisma:L17731`
- `LearnedPatterns` → `schema.prisma:L9671`
- `LedgerAccount` → `schema.prisma:L16209`
- `LiveDemoSession` → `schema.prisma:L822`
- `LowStockAlert` → `schema.prisma:L2766`
- `LoyaltyConfig` → `schema.prisma:L7373`
- `LoyaltyTransaction` → `schema.prisma:L7416`
- `MarketingCampaign` → `schema.prisma:L12936`
- `McpAuthCode` → `schema.prisma:L15842`
- `McpOAuthClient` → `schema.prisma:L15826`
- `McpRefreshToken` → `schema.prisma:L15860`
- `McpToolCall` → `schema.prisma:L15881`
- `MeasurementUnit` → `schema.prisma:L14641`
- `Menu` → `schema.prisma:L1695`
- `MenuCategory` → `schema.prisma:L1632`
- `MenuCategoryAssignment` → `schema.prisma:L1730`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15756`
- `MerchantAccount` → `schema.prisma:L5347`
- `MerchantFiscalConfig` → `schema.prisma:L16007`
- `MerchantRevenueShare` → `schema.prisma:L6370`
- `MerchantRoutingRule` → `schema.prisma:L5469`
- `MilestoneAchievement` → `schema.prisma:L12360`
- `Modifier` → `schema.prisma:L4059`
- `ModifierGroup` → `schema.prisma:L4023`
- `Module` → `schema.prisma:L10662`
- `MoneyAnomaly` → `schema.prisma:L6273`
- `MonthlyVenueProfit` → `schema.prisma:L6816`
- `Notification` → `schema.prisma:L8473`
- `NotificationPreference` → `schema.prisma:L8520`
- `NotificationTemplate` → `schema.prisma:L8547`
- `OAuthState` → `schema.prisma:L1528`
- `OnboardingProgress` → `schema.prisma:L1546`
- `Order` → `schema.prisma:L3629`
- `OrderAction` → `schema.prisma:L4126`
- `OrderCustomer` → `schema.prisma:L3854`
- `OrderDiscount` → `schema.prisma:L8334`
- `OrderFulfillment` → `schema.prisma:L15074`
- `OrderFulfillmentLine` → `schema.prisma:L15105`
- `OrderItem` → `schema.prisma:L3890`
- `OrderItemModifier` → `schema.prisma:L4108`
- `OrderPromotion` → `schema.prisma:L17183`
- `OrderServiceCharge` → `schema.prisma:L8418`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12737`
- `OrganizationEntitlement` → `schema.prisma:L10945`
- `OrganizationGoal` → `schema.prisma:L12695`
- `OrganizationModule` → `schema.prisma:L10722`
- `OrganizationPaymentConfig` → `schema.prisma:L5921`
- `OrganizationPayoutConfig` → `schema.prisma:L12770`
- `OrganizationPricingStructure` → `schema.prisma:L5953`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12718`
- `OtpChallenge` → `schema.prisma:L7323`
- `OvertimeApproval` → `schema.prisma:L3407`
- `PartnerAPIKey` → `schema.prisma:L5751`
- `Payment` → `schema.prisma:L4159`
- `PaymentAllocation` → `schema.prisma:L4432`
- `PaymentEffect` → `schema.prisma:L17557`
- `PaymentLink` → `schema.prisma:L14312`
- `PaymentLinkAttribution` → `schema.prisma:L14420`
- `PaymentLinkItem` → `schema.prisma:L14375`
- `PaymentLinkItemModifier` → `schema.prisma:L14402`
- `PaymentProvider` → `schema.prisma:L5306`
- `PayrollLine` → `schema.prisma:L16691`
- `PayrollRun` → `schema.prisma:L16660`
- `PerformanceGoal` → `schema.prisma:L12672`
- `PermissionOverride` → `schema.prisma:L1401`
- `PermissionSet` → `schema.prisma:L1424`
- `PlatformAnnouncement` → `schema.prisma:L17347`
- `PlatformAnnouncementClick` → `schema.prisma:L17412`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17449`
- `PlatformCfdi` → `schema.prisma:L16976`
- `PlatformEmisor` → `schema.prisma:L16916`
- `PlatformSettings` → `schema.prisma:L5728`
- `PosCommand` → `schema.prisma:L8601`
- `PosConnectionStatus` → `schema.prisma:L948`
- `PosSyncIntent` → `schema.prisma:L17054`
- `PricingPolicy` → `schema.prisma:L2670`
- `Printer` → `schema.prisma:L14884`
- `PrintGateway` → `schema.prisma:L14941`
- `PrintJob` → `schema.prisma:L15655`
- `PrintStation` → `schema.prisma:L14959`
- `PrivacyNoticeVersion` → `schema.prisma:L7071`
- `ProcessedStripeEvent` → `schema.prisma:L6259`
- `ProcessorReliabilityMetric` → `schema.prisma:L6744`
- `Product` → `schema.prisma:L1748`
- `ProductModifierGroup` → `schema.prisma:L4096`
- `ProductOption` → `schema.prisma:L14618`
- `ProductOptionValue` → `schema.prisma:L14629`
- `ProductStaff` → `schema.prisma:L13547`
- `PromoterBankAccount` → `schema.prisma:L16811`
- `PromoterCommissionEntry` → `schema.prisma:L16830`
- `PromoterLocationPing` → `schema.prisma:L3595`
- `Promotion` → `schema.prisma:L17105`
- `PromotionGroup` → `schema.prisma:L17144`
- `PromotionOption` → `schema.prisma:L17160`
- `ProviderCostStructure` → `schema.prisma:L6295`
- `ProviderEventLog` → `schema.prisma:L6030`
- `PurchaseOrder` → `schema.prisma:L2395`
- `PurchaseOrderInvoice` → `schema.prisma:L2540`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2597`
- `PurchaseOrderItem` → `schema.prisma:L2453`
- `RateCorrectionBatch` → `schema.prisma:L6520`
- `RateCorrectionEntry` → `schema.prisma:L6562`
- `RawMaterial` → `schema.prisma:L2152`
- `RawMaterialMovement` → `schema.prisma:L2723`
- `RawMaterialPresentation` → `schema.prisma:L2227`
- `ReceiptLayout` → `schema.prisma:L17591`
- `Recipe` → `schema.prisma:L2247`
- `RecipeLine` → `schema.prisma:L2271`
- `Referral` → `schema.prisma:L7789`
- `ReferralProgramConfig` → `schema.prisma:L7754`
- `ReferralRewardGrant` → `schema.prisma:L7880`
- `ReferralTierReward` → `schema.prisma:L7852`
- `ReferralTierUnlock` → `schema.prisma:L7925`
- `RefreshGrant` → `schema.prisma:L17536`
- `Reservation` → `schema.prisma:L13315`
- `ReservationGoogleEventMapping` → `schema.prisma:L14085`
- `ReservationModifier` → `schema.prisma:L13495`
- `ReservationReminderSent` → `schema.prisma:L13478`
- `ReservationSettings` → `schema.prisma:L13709`
- `ReservationWaitlistEntry` → `schema.prisma:L13677`
- `Review` → `schema.prisma:L4727`
- `SalesRetention` → `schema.prisma:L16511`
- `SaleVerification` → `schema.prisma:L4486`
- `ScaleProfile` → `schema.prisma:L15396`
- `ScheduledCommand` → `schema.prisma:L10146`
- `SerializedItem` → `schema.prisma:L11796`
- `SerializedItemCustodyEvent` → `schema.prisma:L11963`
- `ServiceCharge` → `schema.prisma:L8389`
- `Session` → `schema.prisma:L17515`
- `SettlementConfiguration` → `schema.prisma:L6595`
- `SettlementConfirmation` → `schema.prisma:L6708`
- `SettlementIncident` → `schema.prisma:L6659`
- `SettlementSimulation` → `schema.prisma:L6630`
- `Shift` → `schema.prisma:L3218`
- `SimRegistrationRequest` → `schema.prisma:L12001`
- `SimRegistrationRequestItem` → `schema.prisma:L12023`
- `SlotHold` → `schema.prisma:L13578`
- `Staff` → `schema.prisma:L968`
- `StaffDocument` → `schema.prisma:L3466`
- `StaffOnboardingState` → `schema.prisma:L15726`
- `StaffOrganization` → `schema.prisma:L1300`
- `StaffPasskey` → `schema.prisma:L1327`
- `StaffSchedule` → `schema.prisma:L13518`
- `StaffScheduleException` → `schema.prisma:L13530`
- `StaffVenue` → `schema.prisma:L1224`
- `StaffWorkSchedule` → `schema.prisma:L3343`
- `StaffWorkScheduleException` → `schema.prisma:L3441`
- `StampCard` → `schema.prisma:L7637`
- `StampEvent` → `schema.prisma:L7676`
- `StampReward` → `schema.prisma:L7714`
- `StockAlertConfig` → `schema.prisma:L12654`
- `StockBatch` → `schema.prisma:L2881`
- `StockCount` → `schema.prisma:L2798`
- `StockCountItem` → `schema.prisma:L2826`
- `StripeWebhookEvent` → `schema.prisma:L6242`
- `Supplier` → `schema.prisma:L2306`
- `SupplierItemCode` → `schema.prisma:L2638`
- `SupplierPricing` → `schema.prisma:L2361`
- `Table` → `schema.prisma:L3130`
- `Terminal` → `schema.prisma:L4778`
- `TerminalHealth` → `schema.prisma:L5029`
- `TerminalLog` → `schema.prisma:L5003`
- `TerminalOrder` → `schema.prisma:L5209`
- `TerminalOrderItem` → `schema.prisma:L5284`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5162`
- `TerminalPaymentRequest` → `schema.prisma:L5100`
- `TimeEntry` → `schema.prisma:L3508`
- `TimeEntryBreak` → `schema.prisma:L3577`
- `TokenPurchase` → `schema.prisma:L9820`
- `TokenUsageRecord` → `schema.prisma:L9792`
- `TpvCommandHistory` → `schema.prisma:L10052`
- `TpvCommandQueue` → `schema.prisma:L9992`
- `TpvFeedback` → `schema.prisma:L9705`
- `TpvMessage` → `schema.prisma:L13011`
- `TpvMessageDelivery` → `schema.prisma:L13063`
- `TpvMessageResponse` → `schema.prisma:L13086`
- `TrainingModule` → `schema.prisma:L13141`
- `TrainingProgress` → `schema.prisma:L13218`
- `TrainingQuizQuestion` → `schema.prisma:L13200`
- `TrainingStep` → `schema.prisma:L13180`
- `TransactionCost` → `schema.prisma:L6458`
- `UnitConversion` → `schema.prisma:L2701`
- `UpsellAcceptance` → `schema.prisma:L8210`
- `UpsellAiRun` → `schema.prisma:L8230`
- `UpsellImpression` → `schema.prisma:L8170`
- `UpsellRule` → `schema.prisma:L8090`
- `user_sessions` → `schema.prisma:L5786`
- `Venue` → `schema.prisma:L163`
- `VenueAreaTicketSettings` → `schema.prisma:L15133`
- `VenueChatMessage` → `schema.prisma:L798`
- `VenueChatSession` → `schema.prisma:L753`
- `VenueCommission` → `schema.prisma:L14779`
- `VenueCreditAssessment` → `schema.prisma:L10534`
- `VenueCryptoConfig` → `schema.prisma:L12878`
- `VenueFeature` → `schema.prisma:L4600`
- `VenueModule` → `schema.prisma:L10694`
- `VenuePaymentConfig` → `schema.prisma:L5887`
- `VenuePaymentLinkSettings` → `schema.prisma:L14118`
- `VenuePricingStructure` → `schema.prisma:L6398`
- `VenueRoleConfig` → `schema.prisma:L1453`
- `VenueRolePermission` → `schema.prisma:L1357`
- `VenueScaleSettings` → `schema.prisma:L15384`
- `VenueSettings` → `schema.prisma:L838`
- `VenueTenderType` → `schema.prisma:L4345`
- `VenueTenderTypeRevision` → `schema.prisma:L4410`
- `VenueTransaction` → `schema.prisma:L4537`
- `VenueWhatsappActivation` → `schema.prisma:L689`
- `WalletCardDesign` → `schema.prisma:L7555`
- `WalletPass` → `schema.prisma:L7456`
- `WalletPassRegistration` → `schema.prisma:L7522`
- `WebhookEvent` → `schema.prisma:L4636`
- `WebhookSubscription` → `schema.prisma:L6003`
- `WhatsappContactWindow` → `schema.prisma:L707`
- `WhatsappInboundEvent` → `schema.prisma:L727`
- `WorkShiftAssignment` → `schema.prisma:L3383`
- `WorkShiftTemplate` → `schema.prisma:L3360`
- `Zone` → `schema.prisma:L146`
