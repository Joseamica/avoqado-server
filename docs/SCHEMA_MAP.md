# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **370 models / 352 enums / ~17,800 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L16389`
- `AccountMapping` → `schema.prisma:L16285`
- `ActivityLog` → `schema.prisma:L6892`
- `Aggregator` → `schema.prisma:L14682`
- `AngelPayUserAccount` → `schema.prisma:L5543`
- `AppUpdate` → `schema.prisma:L12847`
- `Area` → `schema.prisma:L3104`
- `AreaTicket` → `schema.prisma:L15180`
- `AreaTicketCheckoutSession` → `schema.prisma:L15302`
- `AreaTicketExternalIncident` → `schema.prisma:L15549`
- `AreaTicketExternalSettlement` → `schema.prisma:L15514`
- `AreaTicketFulfillment` → `schema.prisma:L15378`
- `AreaTicketInventoryReservation` → `schema.prisma:L15273`
- `AreaTicketLine` → `schema.prisma:L15241`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15334`
- `AreaTicketPrintAttempt` → `schema.prisma:L15357`
- `BankStatement` → `schema.prisma:L16159`
- `BankStatementLine` → `schema.prisma:L16180`
- `BillingTaxProfile` → `schema.prisma:L16969`
- `BirthdayAutomation` → `schema.prisma:L7213`
- `BulkCommandOperation` → `schema.prisma:L10127`
- `CalendarSyncOutbox` → `schema.prisma:L14054`
- `CampaignDelivery` → `schema.prisma:L13005`
- `CashCloseout` → `schema.prisma:L10512`
- `CashDeposit` → `schema.prisma:L12649`
- `CashDrawerEvent` → `schema.prisma:L14519`
- `CashDrawerSession` → `schema.prisma:L14480`
- `CashOutCommissionRate` → `schema.prisma:L16798`
- `CashOutScheduleDay` → `schema.prisma:L16821`
- `CashOutWithdrawal` → `schema.prisma:L16883`
- `CatalogBindingBatch` → `schema.prisma:L11543`
- `CatalogBindingLine` → `schema.prisma:L11579`
- `CatalogBrand` → `schema.prisma:L10996`
- `CatalogClientObservation` → `schema.prisma:L11309`
- `CatalogClientReadinessOverride` → `schema.prisma:L11328`
- `CatalogFamily` → `schema.prisma:L11046`
- `CatalogIdempotencyRecord` → `schema.prisma:L11442`
- `CatalogIdentifier` → `schema.prisma:L11177`
- `CatalogImportBatch` → `schema.prisma:L11485`
- `CatalogImportLine` → `schema.prisma:L11522`
- `CatalogItem` → `schema.prisma:L11079`
- `CatalogItemBusinessType` → `schema.prisma:L11139`
- `CatalogItemPrice` → `schema.prisma:L11227`
- `CatalogManufacturer` → `schema.prisma:L11020`
- `CatalogProductTypeMapping` → `schema.prisma:L11156`
- `CatalogPublicationBatch` → `schema.prisma:L11607`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11701`
- `CatalogPublicationLine` → `schema.prisma:L11648`
- `CatalogPublicationOutbox` → `schema.prisma:L11744`
- `CatalogValidationProfile` → `schema.prisma:L11198`
- `CatalogVenueBinding` → `schema.prisma:L11356`
- `CatalogVenueClientRequirement` → `schema.prisma:L11283`
- `CatalogVenueEventSequence` → `schema.prisma:L11727`
- `CatalogVenueOverride` → `schema.prisma:L11398`
- `CatalogVenueRollout` → `schema.prisma:L11258`
- `Cfdi` → `schema.prisma:L16062`
- `ChatbotTokenBudget` → `schema.prisma:L9775`
- `ChatConversation` → `schema.prisma:L9630`
- `ChatFeedback` → `schema.prisma:L9716`
- `ChatLearningEvent` → `schema.prisma:L9673`
- `ChatMessage` → `schema.prisma:L9653`
- `ChatTrainingData` → `schema.prisma:L9587`
- `CheckoutSession` → `schema.prisma:L5823`
- `ClassSession` → `schema.prisma:L13658`
- `CommissionCalculation` → `schema.prisma:L12425`
- `CommissionClawback` → `schema.prisma:L12601`
- `CommissionConfig` → `schema.prisma:L12191`
- `CommissionMilestone` → `schema.prisma:L12341`
- `CommissionOverride` → `schema.prisma:L12268`
- `CommissionPayout` → `schema.prisma:L12552`
- `CommissionSummary` → `schema.prisma:L12491`
- `CommissionTier` → `schema.prisma:L12305`
- `ConsentEvent` → `schema.prisma:L7075`
- `Consumer` → `schema.prisma:L7305`
- `ConsumerAuthAccount` → `schema.prisma:L7330`
- `CouponCode` → `schema.prisma:L8277`
- `CouponRedemption` → `schema.prisma:L8308`
- `CreditAssessmentHistory` → `schema.prisma:L10621`
- `CreditItemBalance` → `schema.prisma:L14270`
- `CreditOffer` → `schema.prisma:L10640`
- `CreditPack` → `schema.prisma:L14179`
- `CreditPackItem` → `schema.prisma:L14208`
- `CreditPackPurchase` → `schema.prisma:L14225`
- `CreditTransaction` → `schema.prisma:L14292`
- `Customer` → `schema.prisma:L6933`
- `CustomerApprovalDelivery` → `schema.prisma:L9289`
- `CustomerApprovalOutbox` → `schema.prisma:L9264`
- `CustomerCampaign` → `schema.prisma:L7163`
- `CustomerCampaignDelivery` → `schema.prisma:L7245`
- `CustomerCaptureToken` → `schema.prisma:L7111`
- `CustomerDiscount` → `schema.prisma:L8328`
- `CustomerGroup` → `schema.prisma:L7369`
- `CustomerOrderMetric` → `schema.prisma:L3875`
- `CustomerTaxProfile` → `schema.prisma:L16131`
- `DeliveryActivationRequest` → `schema.prisma:L6176`
- `DeliveryChannelLink` → `schema.prisma:L6121`
- `DeliveryOrderEvent` → `schema.prisma:L6200`
- `DeviceToken` → `schema.prisma:L8597`
- `DigitalReceipt` → `schema.prisma:L4453`
- `Discount` → `schema.prisma:L7967`
- `EcommerceMerchant` → `schema.prisma:L5635`
- `EmailQuotaLedger` → `schema.prisma:L7292`
- `EmailSuppression` → `schema.prisma:L7280`
- `EmailTemplate` → `schema.prisma:L12944`
- `Employee` → `schema.prisma:L16646`
- `Estimate` → `schema.prisma:L14589`
- `EstimateItem` → `schema.prisma:L14617`
- `Expense` → `schema.prisma:L16433`
- `ExternalBusyBlock` → `schema.prisma:L13947`
- `Feature` → `schema.prisma:L4582`
- `FeeSchedule` → `schema.prisma:L4667`
- `FeeTier` → `schema.prisma:L4678`
- `FinancialAccount` → `schema.prisma:L14779`
- `FinancialConnection` → `schema.prisma:L14748`
- `FinancialProvider` → `schema.prisma:L14734`
- `FiscalEmisor` → `schema.prisma:L15985`
- `FiscalLossCarryforward` → `schema.prisma:L16556`
- `FixedAsset` → `schema.prisma:L16574`
- `FixedAssetDepreciation` → `schema.prisma:L16603`
- `FloorElement` → `schema.prisma:L3180`
- `FulfillmentArea` → `schema.prisma:L15045`
- `GeofenceRule` → `schema.prisma:L10212`
- `GoogleCalendarChannel` → `schema.prisma:L13924`
- `GoogleCalendarConnection` → `schema.prisma:L13876`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13977`
- `GoogleOAuthSession` → `schema.prisma:L13999`
- `HolidayCalendar` → `schema.prisma:L6816`
- `IdempotencyRequest` → `schema.prisma:L12066`
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
- `InventoryTransfer` → `schema.prisma:L14561`
- `Invitation` → `schema.prisma:L1477`
- `Invoice` → `schema.prisma:L4690`
- `InvoiceItem` → `schema.prisma:L4716`
- `ItemCategory` → `schema.prisma:L11779`
- `JournalEntry` → `schema.prisma:L16343`
- `JournalLine` → `schema.prisma:L16371`
- `KdsOrder` → `schema.prisma:L14827`
- `KdsOrderItem` → `schema.prisma:L14868`
- `KioskCheckInAttempt` → `schema.prisma:L17292`
- `KioskCheckInChallenge` → `schema.prisma:L17246`
- `KioskOutreachOutbox` → `schema.prisma:L17313`
- `LaunchCampaign` → `schema.prisma:L17651`
- `LaunchCampaignRedemption` → `schema.prisma:L17757`
- `LearnedPatterns` → `schema.prisma:L9697`
- `LedgerAccount` → `schema.prisma:L16235`
- `LiveDemoSession` → `schema.prisma:L822`
- `LowStockAlert` → `schema.prisma:L2766`
- `LoyaltyConfig` → `schema.prisma:L7399`
- `LoyaltyTransaction` → `schema.prisma:L7442`
- `MarketingCampaign` → `schema.prisma:L12962`
- `McpAuthCode` → `schema.prisma:L15868`
- `McpOAuthClient` → `schema.prisma:L15852`
- `McpRefreshToken` → `schema.prisma:L15886`
- `McpToolCall` → `schema.prisma:L15907`
- `MeasurementUnit` → `schema.prisma:L14667`
- `Menu` → `schema.prisma:L1695`
- `MenuCategory` → `schema.prisma:L1632`
- `MenuCategoryAssignment` → `schema.prisma:L1730`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15782`
- `MerchantAccount` → `schema.prisma:L5373`
- `MerchantFiscalConfig` → `schema.prisma:L16033`
- `MerchantRevenueShare` → `schema.prisma:L6396`
- `MerchantRoutingRule` → `schema.prisma:L5495`
- `MilestoneAchievement` → `schema.prisma:L12386`
- `Modifier` → `schema.prisma:L4059`
- `ModifierGroup` → `schema.prisma:L4023`
- `Module` → `schema.prisma:L10688`
- `MoneyAnomaly` → `schema.prisma:L6299`
- `MonthlyVenueProfit` → `schema.prisma:L6842`
- `Notification` → `schema.prisma:L8499`
- `NotificationPreference` → `schema.prisma:L8546`
- `NotificationTemplate` → `schema.prisma:L8573`
- `OAuthState` → `schema.prisma:L1528`
- `OnboardingProgress` → `schema.prisma:L1546`
- `Order` → `schema.prisma:L3629`
- `OrderAction` → `schema.prisma:L4126`
- `OrderCustomer` → `schema.prisma:L3854`
- `OrderDiscount` → `schema.prisma:L8360`
- `OrderFulfillment` → `schema.prisma:L15100`
- `OrderFulfillmentLine` → `schema.prisma:L15131`
- `OrderItem` → `schema.prisma:L3890`
- `OrderItemModifier` → `schema.prisma:L4108`
- `OrderPromotion` → `schema.prisma:L17209`
- `OrderServiceCharge` → `schema.prisma:L8444`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12763`
- `OrganizationEntitlement` → `schema.prisma:L10971`
- `OrganizationGoal` → `schema.prisma:L12721`
- `OrganizationModule` → `schema.prisma:L10748`
- `OrganizationPaymentConfig` → `schema.prisma:L5947`
- `OrganizationPayoutConfig` → `schema.prisma:L12796`
- `OrganizationPricingStructure` → `schema.prisma:L5979`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12744`
- `OtpChallenge` → `schema.prisma:L7349`
- `OvertimeApproval` → `schema.prisma:L3407`
- `PartnerAPIKey` → `schema.prisma:L5777`
- `Payment` → `schema.prisma:L4159`
- `PaymentAllocation` → `schema.prisma:L4432`
- `PaymentEffect` → `schema.prisma:L17583`
- `PaymentLink` → `schema.prisma:L14338`
- `PaymentLinkAttribution` → `schema.prisma:L14446`
- `PaymentLinkItem` → `schema.prisma:L14401`
- `PaymentLinkItemModifier` → `schema.prisma:L14428`
- `PaymentProvider` → `schema.prisma:L5332`
- `PayrollLine` → `schema.prisma:L16717`
- `PayrollRun` → `schema.prisma:L16686`
- `PerformanceGoal` → `schema.prisma:L12698`
- `PermissionOverride` → `schema.prisma:L1401`
- `PermissionSet` → `schema.prisma:L1424`
- `PlatformAnnouncement` → `schema.prisma:L17373`
- `PlatformAnnouncementClick` → `schema.prisma:L17438`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17475`
- `PlatformCfdi` → `schema.prisma:L17002`
- `PlatformEmisor` → `schema.prisma:L16942`
- `PlatformSettings` → `schema.prisma:L5754`
- `PosCommand` → `schema.prisma:L8627`
- `PosConnectionStatus` → `schema.prisma:L948`
- `PosSyncIntent` → `schema.prisma:L17080`
- `PricingPolicy` → `schema.prisma:L2670`
- `Printer` → `schema.prisma:L14910`
- `PrintGateway` → `schema.prisma:L14967`
- `PrintJob` → `schema.prisma:L15681`
- `PrintStation` → `schema.prisma:L14985`
- `PrivacyNoticeVersion` → `schema.prisma:L7097`
- `ProcessedStripeEvent` → `schema.prisma:L6285`
- `ProcessorReliabilityMetric` → `schema.prisma:L6770`
- `Product` → `schema.prisma:L1748`
- `ProductModifierGroup` → `schema.prisma:L4096`
- `ProductOption` → `schema.prisma:L14644`
- `ProductOptionValue` → `schema.prisma:L14655`
- `ProductStaff` → `schema.prisma:L13573`
- `PromoterBankAccount` → `schema.prisma:L16837`
- `PromoterCommissionEntry` → `schema.prisma:L16856`
- `PromoterLocationPing` → `schema.prisma:L3595`
- `Promotion` → `schema.prisma:L17131`
- `PromotionGroup` → `schema.prisma:L17170`
- `PromotionOption` → `schema.prisma:L17186`
- `ProviderCostStructure` → `schema.prisma:L6321`
- `ProviderEventLog` → `schema.prisma:L6056`
- `PurchaseOrder` → `schema.prisma:L2395`
- `PurchaseOrderInvoice` → `schema.prisma:L2540`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2597`
- `PurchaseOrderItem` → `schema.prisma:L2453`
- `RateCorrectionBatch` → `schema.prisma:L6546`
- `RateCorrectionEntry` → `schema.prisma:L6588`
- `RawMaterial` → `schema.prisma:L2152`
- `RawMaterialMovement` → `schema.prisma:L2723`
- `RawMaterialPresentation` → `schema.prisma:L2227`
- `ReceiptLayout` → `schema.prisma:L17617`
- `Recipe` → `schema.prisma:L2247`
- `RecipeLine` → `schema.prisma:L2271`
- `Referral` → `schema.prisma:L7815`
- `ReferralProgramConfig` → `schema.prisma:L7780`
- `ReferralRewardGrant` → `schema.prisma:L7906`
- `ReferralTierReward` → `schema.prisma:L7878`
- `ReferralTierUnlock` → `schema.prisma:L7951`
- `RefreshGrant` → `schema.prisma:L17562`
- `Reservation` → `schema.prisma:L13341`
- `ReservationGoogleEventMapping` → `schema.prisma:L14111`
- `ReservationModifier` → `schema.prisma:L13521`
- `ReservationReminderSent` → `schema.prisma:L13504`
- `ReservationSettings` → `schema.prisma:L13735`
- `ReservationWaitlistEntry` → `schema.prisma:L13703`
- `Review` → `schema.prisma:L4734`
- `SalesRetention` → `schema.prisma:L16537`
- `SaleVerification` → `schema.prisma:L4486`
- `ScaleProfile` → `schema.prisma:L15422`
- `ScheduledCommand` → `schema.prisma:L10172`
- `SerializedItem` → `schema.prisma:L11822`
- `SerializedItemCustodyEvent` → `schema.prisma:L11989`
- `ServiceCharge` → `schema.prisma:L8415`
- `Session` → `schema.prisma:L17541`
- `SettlementConfiguration` → `schema.prisma:L6621`
- `SettlementConfirmation` → `schema.prisma:L6734`
- `SettlementIncident` → `schema.prisma:L6685`
- `SettlementSimulation` → `schema.prisma:L6656`
- `Shift` → `schema.prisma:L3218`
- `SimRegistrationRequest` → `schema.prisma:L12027`
- `SimRegistrationRequestItem` → `schema.prisma:L12049`
- `SlotHold` → `schema.prisma:L13604`
- `Staff` → `schema.prisma:L968`
- `StaffDocument` → `schema.prisma:L3466`
- `StaffOnboardingState` → `schema.prisma:L15752`
- `StaffOrganization` → `schema.prisma:L1300`
- `StaffPasskey` → `schema.prisma:L1327`
- `StaffSchedule` → `schema.prisma:L13544`
- `StaffScheduleException` → `schema.prisma:L13556`
- `StaffVenue` → `schema.prisma:L1224`
- `StaffWorkSchedule` → `schema.prisma:L3343`
- `StaffWorkScheduleException` → `schema.prisma:L3441`
- `StampCard` → `schema.prisma:L7663`
- `StampEvent` → `schema.prisma:L7702`
- `StampReward` → `schema.prisma:L7740`
- `StockAlertConfig` → `schema.prisma:L12680`
- `StockBatch` → `schema.prisma:L2881`
- `StockCount` → `schema.prisma:L2798`
- `StockCountItem` → `schema.prisma:L2826`
- `StripeWebhookEvent` → `schema.prisma:L6268`
- `Supplier` → `schema.prisma:L2306`
- `SupplierItemCode` → `schema.prisma:L2638`
- `SupplierPricing` → `schema.prisma:L2361`
- `Table` → `schema.prisma:L3130`
- `Terminal` → `schema.prisma:L4785`
- `TerminalHealth` → `schema.prisma:L5036`
- `TerminalLog` → `schema.prisma:L5010`
- `TerminalOrder` → `schema.prisma:L5235`
- `TerminalOrderItem` → `schema.prisma:L5310`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5188`
- `TerminalPaymentRequest` → `schema.prisma:L5107`
- `TimeEntry` → `schema.prisma:L3508`
- `TimeEntryBreak` → `schema.prisma:L3577`
- `TokenPurchase` → `schema.prisma:L9846`
- `TokenUsageRecord` → `schema.prisma:L9818`
- `TpvCommandHistory` → `schema.prisma:L10078`
- `TpvCommandQueue` → `schema.prisma:L10018`
- `TpvFeedback` → `schema.prisma:L9731`
- `TpvMessage` → `schema.prisma:L13037`
- `TpvMessageDelivery` → `schema.prisma:L13089`
- `TpvMessageResponse` → `schema.prisma:L13112`
- `TrainingModule` → `schema.prisma:L13167`
- `TrainingProgress` → `schema.prisma:L13244`
- `TrainingQuizQuestion` → `schema.prisma:L13226`
- `TrainingStep` → `schema.prisma:L13206`
- `TransactionCost` → `schema.prisma:L6484`
- `UnitConversion` → `schema.prisma:L2701`
- `UpsellAcceptance` → `schema.prisma:L8236`
- `UpsellAiRun` → `schema.prisma:L8256`
- `UpsellImpression` → `schema.prisma:L8196`
- `UpsellRule` → `schema.prisma:L8116`
- `user_sessions` → `schema.prisma:L5812`
- `Venue` → `schema.prisma:L163`
- `VenueAreaTicketSettings` → `schema.prisma:L15159`
- `VenueChatMessage` → `schema.prisma:L798`
- `VenueChatSession` → `schema.prisma:L753`
- `VenueCommission` → `schema.prisma:L14805`
- `VenueCreditAssessment` → `schema.prisma:L10560`
- `VenueCryptoConfig` → `schema.prisma:L12904`
- `VenueFeature` → `schema.prisma:L4600`
- `VenueModule` → `schema.prisma:L10720`
- `VenuePaymentConfig` → `schema.prisma:L5913`
- `VenuePaymentLinkSettings` → `schema.prisma:L14144`
- `VenuePricingStructure` → `schema.prisma:L6424`
- `VenueRoleConfig` → `schema.prisma:L1453`
- `VenueRolePermission` → `schema.prisma:L1357`
- `VenueScaleSettings` → `schema.prisma:L15410`
- `VenueSettings` → `schema.prisma:L838`
- `VenueTenderType` → `schema.prisma:L4345`
- `VenueTenderTypeRevision` → `schema.prisma:L4410`
- `VenueTransaction` → `schema.prisma:L4537`
- `VenueWhatsappActivation` → `schema.prisma:L689`
- `WalletCardDesign` → `schema.prisma:L7581`
- `WalletPass` → `schema.prisma:L7482`
- `WalletPassRegistration` → `schema.prisma:L7548`
- `WebhookEvent` → `schema.prisma:L4643`
- `WebhookSubscription` → `schema.prisma:L6029`
- `WhatsappContactWindow` → `schema.prisma:L707`
- `WhatsappInboundEvent` → `schema.prisma:L727`
- `WorkShiftAssignment` → `schema.prisma:L3383`
- `WorkShiftTemplate` → `schema.prisma:L3360`
- `Zone` → `schema.prisma:L146`
