# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **419 models / 389 enums / ~19,500 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueIvaPorProducto`, `VenuePosSinAparato`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `CapabilityGrant`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `HybridBillingOperation`, `HybridCampaign`, `HybridContract`, `HybridContractSelection`, `HybridCreditAllocation`, `HybridOfferPublication`, `HybridPaymentPeriod`, `HybridPromotionGroup`, `HybridPurchase`, `HybridRedemption`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                               |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                                                                                                       |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `InventoryWasteReport`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `ShopifyConnectIntent`, `ShopifyImportIssue`, `ShopifyInboundEvent`, `ShopifyLocationLink`, `ShopifyReviewItem`, `ShopifyStockOutbox`, `ShopifyStore`, `ShopifyVariantLink`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`            |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryConnectIntent`, `DeliveryLineAction`, `DeliveryOrderEvent`, `DeliveryStoreRevocation`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                                                                                                      |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CfdiGlobalOrden`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `OrderItemSelloIva`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                                                                                                |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `ClassSessionPayState`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `ServiceEarning`, `ServicePayPeriod`, `ServicePayTable`, `ServicePayTableCell`, `ServicePayTableVersion`, `StaffPayLevel`, `StaffPayLevelAssignment`, `StaffPayStatement`, `StaffPayTipWindow`, `StaffPayVenueWindow`, `VenueCommission`                                                                                                                                                                                                    |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `AggregatorBooking`, `AggregatorCapacityRule`, `AggregatorConnection`, `AggregatorInboundEvent`, `AggregatorOutbox`, `AggregatorProductLink`, `AggregatorSessionLink`, `AggregatorVisit`, `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                 |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalAttemptResolution`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerExternalIdentity`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L17499`
- `AccountMapping` → `schema.prisma:L17394`
- `ActivityLog` → `schema.prisma:L7560`
- `Aggregator` → `schema.prisma:L15665`
- `AggregatorBooking` → `schema.prisma:L14973`
- `AggregatorCapacityRule` → `schema.prisma:L14954`
- `AggregatorConnection` → `schema.prisma:L14879`
- `AggregatorInboundEvent` → `schema.prisma:L15042`
- `AggregatorOutbox` → `schema.prisma:L15062`
- `AggregatorProductLink` → `schema.prisma:L14911`
- `AggregatorSessionLink` → `schema.prisma:L14930`
- `AggregatorVisit` → `schema.prisma:L14999`
- `AngelPayUserAccount` → `schema.prisma:L6105`
- `AppUpdate` → `schema.prisma:L13540`
- `Area` → `schema.prisma:L3292`
- `AreaTicket` → `schema.prisma:L16201`
- `AreaTicketCheckoutSession` → `schema.prisma:L16323`
- `AreaTicketExternalIncident` → `schema.prisma:L16570`
- `AreaTicketExternalSettlement` → `schema.prisma:L16535`
- `AreaTicketFulfillment` → `schema.prisma:L16399`
- `AreaTicketInventoryReservation` → `schema.prisma:L16294`
- `AreaTicketLine` → `schema.prisma:L16262`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16355`
- `AreaTicketPrintAttempt` → `schema.prisma:L16378`
- `BankStatement` → `schema.prisma:L17268`
- `BankStatementLine` → `schema.prisma:L17289`
- `BillingObligationConflict` → `schema.prisma:L5135`
- `BillingTaxProfile` → `schema.prisma:L18091`
- `BirthdayAutomation` → `schema.prisma:L7884`
- `BulkCommandOperation` → `schema.prisma:L10812`
- `CalendarSyncOutbox` → `schema.prisma:L14762`
- `CampaignDelivery` → `schema.prisma:L13698`
- `CapabilityGrant` → `schema.prisma:L4875`
- `CashCloseout` → `schema.prisma:L11197`
- `CashDeposit` → `schema.prisma:L13342`
- `CashDrawerEvent` → `schema.prisma:L15502`
- `CashDrawerSession` → `schema.prisma:L15463`
- `CashOutCommissionRate` → `schema.prisma:L17908`
- `CashOutScheduleDay` → `schema.prisma:L17931`
- `CashOutWithdrawal` → `schema.prisma:L17993`
- `CatalogBindingBatch` → `schema.prisma:L12228`
- `CatalogBindingLine` → `schema.prisma:L12264`
- `CatalogBrand` → `schema.prisma:L11681`
- `CatalogClientObservation` → `schema.prisma:L11994`
- `CatalogClientReadinessOverride` → `schema.prisma:L12013`
- `CatalogFamily` → `schema.prisma:L11731`
- `CatalogIdempotencyRecord` → `schema.prisma:L12127`
- `CatalogIdentifier` → `schema.prisma:L11862`
- `CatalogImportBatch` → `schema.prisma:L12170`
- `CatalogImportLine` → `schema.prisma:L12207`
- `CatalogItem` → `schema.prisma:L11764`
- `CatalogItemBusinessType` → `schema.prisma:L11824`
- `CatalogItemPrice` → `schema.prisma:L11912`
- `CatalogManufacturer` → `schema.prisma:L11705`
- `CatalogProductTypeMapping` → `schema.prisma:L11841`
- `CatalogPublicationBatch` → `schema.prisma:L12292`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12386`
- `CatalogPublicationLine` → `schema.prisma:L12333`
- `CatalogPublicationOutbox` → `schema.prisma:L12429`
- `CatalogValidationProfile` → `schema.prisma:L11883`
- `CatalogVenueBinding` → `schema.prisma:L12041`
- `CatalogVenueClientRequirement` → `schema.prisma:L11968`
- `CatalogVenueEventSequence` → `schema.prisma:L12412`
- `CatalogVenueOverride` → `schema.prisma:L12083`
- `CatalogVenueRollout` → `schema.prisma:L11943`
- `Cfdi` → `schema.prisma:L17096`
- `CfdiGlobalOrden` → `schema.prisma:L17221`
- `ChatbotTokenBudget` → `schema.prisma:L10458`
- `ChatConversation` → `schema.prisma:L10313`
- `ChatFeedback` → `schema.prisma:L10399`
- `ChatLearningEvent` → `schema.prisma:L10356`
- `ChatMessage` → `schema.prisma:L10336`
- `ChatTrainingData` → `schema.prisma:L10270`
- `CheckoutSession` → `schema.prisma:L6385`
- `ClassSession` → `schema.prisma:L14356`
- `ClassSessionPayState` → `schema.prisma:L19051`
- `CommissionCalculation` → `schema.prisma:L13117`
- `CommissionClawback` → `schema.prisma:L13294`
- `CommissionConfig` → `schema.prisma:L12876`
- `CommissionMilestone` → `schema.prisma:L13033`
- `CommissionOverride` → `schema.prisma:L12960`
- `CommissionPayout` → `schema.prisma:L13245`
- `CommissionSummary` → `schema.prisma:L13184`
- `CommissionTier` → `schema.prisma:L12997`
- `ConsentEvent` → `schema.prisma:L7746`
- `Consumer` → `schema.prisma:L7976`
- `ConsumerAuthAccount` → `schema.prisma:L8001`
- `CouponCode` → `schema.prisma:L8948`
- `CouponRedemption` → `schema.prisma:L8979`
- `CreditAssessmentHistory` → `schema.prisma:L11306`
- `CreditItemBalance` → `schema.prisma:L15253`
- `CreditOffer` → `schema.prisma:L11325`
- `CreditPack` → `schema.prisma:L15162`
- `CreditPackItem` → `schema.prisma:L15191`
- `CreditPackPurchase` → `schema.prisma:L15208`
- `CreditTransaction` → `schema.prisma:L15275`
- `Customer` → `schema.prisma:L7601`
- `CustomerApprovalDelivery` → `schema.prisma:L9971`
- `CustomerApprovalOutbox` → `schema.prisma:L9946`
- `CustomerCampaign` → `schema.prisma:L7834`
- `CustomerCampaignDelivery` → `schema.prisma:L7916`
- `CustomerCaptureToken` → `schema.prisma:L7782`
- `CustomerDiscount` → `schema.prisma:L8999`
- `CustomerExternalIdentity` → `schema.prisma:L15029`
- `CustomerGroup` → `schema.prisma:L8040`
- `CustomerOrderMetric` → `schema.prisma:L4091`
- `CustomerTaxProfile` → `schema.prisma:L17240`
- `DeliveryActivationRequest` → `schema.prisma:L6844`
- `DeliveryChannelLink` → `schema.prisma:L6683`
- `DeliveryConnectIntent` → `schema.prisma:L6795`
- `DeliveryLineAction` → `schema.prisma:L6756`
- `DeliveryOrderEvent` → `schema.prisma:L6868`
- `DeliveryStoreRevocation` → `schema.prisma:L6832`
- `DeviceToken` → `schema.prisma:L9273`
- `DigitalReceipt` → `schema.prisma:L4688`
- `Discount` → `schema.prisma:L8638`
- `EcommerceMerchant` → `schema.prisma:L6197`
- `EmailQuotaLedger` → `schema.prisma:L7963`
- `EmailSuppression` → `schema.prisma:L7951`
- `EmailTemplate` → `schema.prisma:L13637`
- `Employee` → `schema.prisma:L17756`
- `Estimate` → `schema.prisma:L15572`
- `EstimateItem` → `schema.prisma:L15600`
- `Expense` → `schema.prisma:L17543`
- `ExternalBusyBlock` → `schema.prisma:L14655`
- `Feature` → `schema.prisma:L4817`
- `FeeSchedule` → `schema.prisma:L5197`
- `FeeTier` → `schema.prisma:L5208`
- `FinancialAccount` → `schema.prisma:L15762`
- `FinancialConnection` → `schema.prisma:L15731`
- `FinancialProvider` → `schema.prisma:L15717`
- `FiscalEmisor` → `schema.prisma:L17007`
- `FiscalLossCarryforward` → `schema.prisma:L17666`
- `FixedAsset` → `schema.prisma:L17684`
- `FixedAssetDepreciation` → `schema.prisma:L17713`
- `FloorElement` → `schema.prisma:L3368`
- `FulfillmentArea` → `schema.prisma:L16066`
- `GeofenceRule` → `schema.prisma:L10897`
- `GoogleCalendarChannel` → `schema.prisma:L14632`
- `GoogleCalendarConnection` → `schema.prisma:L14584`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14685`
- `GoogleOAuthSession` → `schema.prisma:L14707`
- `HolidayCalendar` → `schema.prisma:L7484`
- `HybridBillingOperation` → `schema.prisma:L5059`
- `HybridCampaign` → `schema.prisma:L4900`
- `HybridContract` → `schema.prisma:L5016`
- `HybridContractSelection` → `schema.prisma:L5048`
- `HybridCreditAllocation` → `schema.prisma:L5115`
- `HybridOfferPublication` → `schema.prisma:L4963`
- `HybridPaymentPeriod` → `schema.prisma:L5094`
- `HybridPromotionGroup` → `schema.prisma:L4944`
- `HybridPurchase` → `schema.prisma:L4983`
- `HybridRedemption` → `schema.prisma:L5077`
- `IdempotencyRequest` → `schema.prisma:L12751`
- `InterVenueTransfer` → `schema.prisma:L3120`
- `InterVenueTransferAllocation` → `schema.prisma:L3203`
- `InterVenueTransferItem` → `schema.prisma:L3172`
- `InterVenueTransferReceipt` → `schema.prisma:L3230`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3246`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3274`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3258`
- `Inventory` → `schema.prisma:L2042`
- `InventoryMovement` → `schema.prisma:L2142`
- `InventoryPosting` → `schema.prisma:L2237`
- `InventoryPostingLine` → `schema.prisma:L2277`
- `InventoryTransfer` → `schema.prisma:L15544`
- `InventoryWasteReport` → `schema.prisma:L2097`
- `Invitation` → `schema.prisma:L1534`
- `Invoice` → `schema.prisma:L5220`
- `InvoiceItem` → `schema.prisma:L5246`
- `ItemCategory` → `schema.prisma:L12464`
- `JournalEntry` → `schema.prisma:L17452`
- `JournalLine` → `schema.prisma:L17481`
- `KdsOrder` → `schema.prisma:L15810`
- `KdsOrderItem` → `schema.prisma:L15873`
- `KioskCheckInAttempt` → `schema.prisma:L18414`
- `KioskCheckInChallenge` → `schema.prisma:L18368`
- `KioskOutreachOutbox` → `schema.prisma:L18435`
- `LaunchCampaign` → `schema.prisma:L18773`
- `LaunchCampaignRedemption` → `schema.prisma:L18890`
- `LearnedPatterns` → `schema.prisma:L10380`
- `LedgerAccount` → `schema.prisma:L17344`
- `LiveDemoSession` → `schema.prisma:L859`
- `LowStockAlert` → `schema.prisma:L2950`
- `LoyaltyConfig` → `schema.prisma:L8070`
- `LoyaltyTransaction` → `schema.prisma:L8113`
- `MarketingCampaign` → `schema.prisma:L13655`
- `McpAuthCode` → `schema.prisma:L16889`
- `McpOAuthClient` → `schema.prisma:L16873`
- `McpRefreshToken` → `schema.prisma:L16907`
- `McpToolCall` → `schema.prisma:L16929`
- `MeasurementUnit` → `schema.prisma:L15650`
- `Menu` → `schema.prisma:L1752`
- `MenuCategory` → `schema.prisma:L1689`
- `MenuCategoryAssignment` → `schema.prisma:L1787`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16803`
- `MerchantAccount` → `schema.prisma:L5935`
- `MerchantFiscalConfig` → `schema.prisma:L17067`
- `MerchantRevenueShare` → `schema.prisma:L7064`
- `MerchantRoutingRule` → `schema.prisma:L6057`
- `MilestoneAchievement` → `schema.prisma:L13078`
- `Modifier` → `schema.prisma:L4290`
- `ModifierGroup` → `schema.prisma:L4254`
- `Module` → `schema.prisma:L11373`
- `MoneyAnomaly` → `schema.prisma:L6967`
- `MonthlyVenueProfit` → `schema.prisma:L7510`
- `Notification` → `schema.prisma:L9175`
- `NotificationPreference` → `schema.prisma:L9222`
- `NotificationTemplate` → `schema.prisma:L9249`
- `OAuthState` → `schema.prisma:L1585`
- `OnboardingProgress` → `schema.prisma:L1603`
- `Order` → `schema.prisma:L3817`
- `OrderAction` → `schema.prisma:L4361`
- `OrderCustomer` → `schema.prisma:L4070`
- `OrderDiscount` → `schema.prisma:L9031`
- `OrderFulfillment` → `schema.prisma:L16121`
- `OrderFulfillmentLine` → `schema.prisma:L16152`
- `OrderItem` → `schema.prisma:L4106`
- `OrderItemModifier` → `schema.prisma:L4343`
- `OrderItemSelloIva` → `schema.prisma:L17201`
- `OrderPromotion` → `schema.prisma:L18331`
- `OrderServiceCharge` → `schema.prisma:L9120`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13456`
- `OrganizationEntitlement` → `schema.prisma:L11656`
- `OrganizationGoal` → `schema.prisma:L13414`
- `OrganizationModule` → `schema.prisma:L11433`
- `OrganizationPaymentConfig` → `schema.prisma:L6509`
- `OrganizationPayoutConfig` → `schema.prisma:L13489`
- `OrganizationPricingStructure` → `schema.prisma:L6541`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13437`
- `OtpChallenge` → `schema.prisma:L8020`
- `OvertimeApproval` → `schema.prisma:L3595`
- `PartnerAPIKey` → `schema.prisma:L6339`
- `Payment` → `schema.prisma:L4394`
- `PaymentAllocation` → `schema.prisma:L4667`
- `PaymentEffect` → `schema.prisma:L18705`
- `PaymentLink` → `schema.prisma:L15321`
- `PaymentLinkAttribution` → `schema.prisma:L15429`
- `PaymentLinkItem` → `schema.prisma:L15384`
- `PaymentLinkItemModifier` → `schema.prisma:L15411`
- `PaymentProvider` → `schema.prisma:L5894`
- `PayrollLine` → `schema.prisma:L17827`
- `PayrollRun` → `schema.prisma:L17796`
- `PerformanceGoal` → `schema.prisma:L13391`
- `PermissionOverride` → `schema.prisma:L1458`
- `PermissionSet` → `schema.prisma:L1481`
- `PlatformAnnouncement` → `schema.prisma:L18495`
- `PlatformAnnouncementClick` → `schema.prisma:L18560`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18597`
- `PlatformCfdi` → `schema.prisma:L18124`
- `PlatformEmisor` → `schema.prisma:L18064`
- `PlatformSettings` → `schema.prisma:L6316`
- `PosCommand` → `schema.prisma:L9303`
- `PosConnectionStatus` → `schema.prisma:L1003`
- `PosSyncIntent` → `schema.prisma:L18202`
- `PricingPolicy` → `schema.prisma:L2846`
- `Printer` → `schema.prisma:L15922`
- `PrintGateway` → `schema.prisma:L15979`
- `PrintJob` → `schema.prisma:L16702`
- `PrintStation` → `schema.prisma:L15997`
- `PrivacyNoticeVersion` → `schema.prisma:L7768`
- `ProcessedStripeEvent` → `schema.prisma:L6953`
- `ProcessorReliabilityMetric` → `schema.prisma:L7438`
- `Product` → `schema.prisma:L1805`
- `ProductModifierGroup` → `schema.prisma:L4331`
- `ProductOption` → `schema.prisma:L15627`
- `ProductOptionValue` → `schema.prisma:L15638`
- `ProductStaff` → `schema.prisma:L14271`
- `PromoterBankAccount` → `schema.prisma:L17947`
- `PromoterCommissionEntry` → `schema.prisma:L17966`
- `PromoterLocationPing` → `schema.prisma:L3783`
- `Promotion` → `schema.prisma:L18253`
- `PromotionGroup` → `schema.prisma:L18292`
- `PromotionOption` → `schema.prisma:L18308`
- `ProviderCostStructure` → `schema.prisma:L6989`
- `ProviderEventLog` → `schema.prisma:L6618`
- `PurchaseOrder` → `schema.prisma:L2553`
- `PurchaseOrderInvoice` → `schema.prisma:L2698`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2765`
- `PurchaseOrderItem` → `schema.prisma:L2611`
- `RateCorrectionBatch` → `schema.prisma:L7214`
- `RateCorrectionEntry` → `schema.prisma:L7256`
- `RawMaterial` → `schema.prisma:L2309`
- `RawMaterialMovement` → `schema.prisma:L2899`
- `RawMaterialPresentation` → `schema.prisma:L2385`
- `ReceiptLayout` → `schema.prisma:L18739`
- `Recipe` → `schema.prisma:L2405`
- `RecipeLine` → `schema.prisma:L2429`
- `Referral` → `schema.prisma:L8486`
- `ReferralProgramConfig` → `schema.prisma:L8451`
- `ReferralRewardGrant` → `schema.prisma:L8577`
- `ReferralTierReward` → `schema.prisma:L8549`
- `ReferralTierUnlock` → `schema.prisma:L8622`
- `RefreshGrant` → `schema.prisma:L18684`
- `Reservation` → `schema.prisma:L14034`
- `ReservationGoogleEventMapping` → `schema.prisma:L15094`
- `ReservationModifier` → `schema.prisma:L14219`
- `ReservationReminderSent` → `schema.prisma:L14202`
- `ReservationSettings` → `schema.prisma:L14443`
- `ReservationWaitlistEntry` → `schema.prisma:L14411`
- `Review` → `schema.prisma:L5264`
- `SalesRetention` → `schema.prisma:L17647`
- `SaleVerification` → `schema.prisma:L4721`
- `ScaleProfile` → `schema.prisma:L16443`
- `ScheduledCommand` → `schema.prisma:L10857`
- `SerializedItem` → `schema.prisma:L12507`
- `SerializedItemCustodyEvent` → `schema.prisma:L12674`
- `ServiceCharge` → `schema.prisma:L9091`
- `ServiceEarning` → `schema.prisma:L19113`
- `ServicePayPeriod` → `schema.prisma:L19089`
- `ServicePayTable` → `schema.prisma:L18997`
- `ServicePayTableCell` → `schema.prisma:L19039`
- `ServicePayTableVersion` → `schema.prisma:L19014`
- `Session` → `schema.prisma:L18663`
- `SettlementConfiguration` → `schema.prisma:L7289`
- `SettlementConfirmation` → `schema.prisma:L7402`
- `SettlementIncident` → `schema.prisma:L7353`
- `SettlementSimulation` → `schema.prisma:L7324`
- `Shift` → `schema.prisma:L3406`
- `ShopifyConnectIntent` → `schema.prisma:L19415`
- `ShopifyImportIssue` → `schema.prisma:L19460`
- `ShopifyInboundEvent` → `schema.prisma:L19392`
- `ShopifyLocationLink` → `schema.prisma:L19275`
- `ShopifyReviewItem` → `schema.prisma:L19433`
- `ShopifyStockOutbox` → `schema.prisma:L19362`
- `ShopifyStore` → `schema.prisma:L19253`
- `ShopifyVariantLink` → `schema.prisma:L19323`
- `SimRegistrationRequest` → `schema.prisma:L12712`
- `SimRegistrationRequestItem` → `schema.prisma:L12734`
- `SlotHold` → `schema.prisma:L14302`
- `Staff` → `schema.prisma:L1023`
- `StaffDocument` → `schema.prisma:L3654`
- `StaffOnboardingState` → `schema.prisma:L16773`
- `StaffOrganization` → `schema.prisma:L1357`
- `StaffPasskey` → `schema.prisma:L1384`
- `StaffPayLevel` → `schema.prisma:L18961`
- `StaffPayLevelAssignment` → `schema.prisma:L18979`
- `StaffPayStatement` → `schema.prisma:L19145`
- `StaffPayTipWindow` → `schema.prisma:L19479`
- `StaffPayVenueWindow` → `schema.prisma:L19496`
- `StaffSchedule` → `schema.prisma:L14242`
- `StaffScheduleException` → `schema.prisma:L14254`
- `StaffVenue` → `schema.prisma:L1281`
- `StaffWorkSchedule` → `schema.prisma:L3531`
- `StaffWorkScheduleException` → `schema.prisma:L3629`
- `StampCard` → `schema.prisma:L8334`
- `StampEvent` → `schema.prisma:L8373`
- `StampReward` → `schema.prisma:L8411`
- `StockAlertConfig` → `schema.prisma:L13373`
- `StockBatch` → `schema.prisma:L3069`
- `StockCount` → `schema.prisma:L2982`
- `StockCountItem` → `schema.prisma:L3010`
- `StripeWebhookEvent` → `schema.prisma:L6936`
- `Supplier` → `schema.prisma:L2464`
- `SupplierItemCode` → `schema.prisma:L2809`
- `SupplierPricing` → `schema.prisma:L2519`
- `Table` → `schema.prisma:L3318`
- `Terminal` → `schema.prisma:L5315`
- `TerminalAttemptResolution` → `schema.prisma:L5753`
- `TerminalHealth` → `schema.prisma:L5573`
- `TerminalLog` → `schema.prisma:L5547`
- `TerminalOrder` → `schema.prisma:L5797`
- `TerminalOrderItem` → `schema.prisma:L5872`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5725`
- `TerminalPaymentRequest` → `schema.prisma:L5644`
- `TimeEntry` → `schema.prisma:L3696`
- `TimeEntryBreak` → `schema.prisma:L3765`
- `TokenPurchase` → `schema.prisma:L10529`
- `TokenUsageRecord` → `schema.prisma:L10501`
- `TpvCommandHistory` → `schema.prisma:L10763`
- `TpvCommandQueue` → `schema.prisma:L10701`
- `TpvFeedback` → `schema.prisma:L10414`
- `TpvMessage` → `schema.prisma:L13730`
- `TpvMessageDelivery` → `schema.prisma:L13782`
- `TpvMessageResponse` → `schema.prisma:L13805`
- `TrainingModule` → `schema.prisma:L13860`
- `TrainingProgress` → `schema.prisma:L13937`
- `TrainingQuizQuestion` → `schema.prisma:L13919`
- `TrainingStep` → `schema.prisma:L13899`
- `TransactionCost` → `schema.prisma:L7152`
- `UnitConversion` → `schema.prisma:L2877`
- `UpsellAcceptance` → `schema.prisma:L8907`
- `UpsellAiRun` → `schema.prisma:L8927`
- `UpsellImpression` → `schema.prisma:L8867`
- `UpsellRule` → `schema.prisma:L8787`
- `user_sessions` → `schema.prisma:L6374`
- `Venue` → `schema.prisma:L181`
- `VenueAreaTicketSettings` → `schema.prisma:L16180`
- `VenueChatMessage` → `schema.prisma:L835`
- `VenueChatSession` → `schema.prisma:L790`
- `VenueCommission` → `schema.prisma:L15788`
- `VenueCreditAssessment` → `schema.prisma:L11245`
- `VenueCryptoConfig` → `schema.prisma:L13597`
- `VenueFeature` → `schema.prisma:L4835`
- `VenueIvaPorProducto` → `schema.prisma:L986`
- `VenueModule` → `schema.prisma:L11405`
- `VenuePaymentConfig` → `schema.prisma:L6475`
- `VenuePaymentLinkSettings` → `schema.prisma:L15127`
- `VenuePosSinAparato` → `schema.prisma:L997`
- `VenuePricingStructure` → `schema.prisma:L7092`
- `VenueRoleConfig` → `schema.prisma:L1510`
- `VenueRolePermission` → `schema.prisma:L1414`
- `VenueScaleSettings` → `schema.prisma:L16431`
- `VenueSettings` → `schema.prisma:L875`
- `VenueTenderType` → `schema.prisma:L4580`
- `VenueTenderTypeRevision` → `schema.prisma:L4645`
- `VenueTransaction` → `schema.prisma:L4772`
- `VenueWhatsappActivation` → `schema.prisma:L726`
- `WalletCardDesign` → `schema.prisma:L8252`
- `WalletPass` → `schema.prisma:L8153`
- `WalletPassRegistration` → `schema.prisma:L8219`
- `WebhookEvent` → `schema.prisma:L5173`
- `WebhookSubscription` → `schema.prisma:L6591`
- `WhatsappContactWindow` → `schema.prisma:L744`
- `WhatsappInboundEvent` → `schema.prisma:L764`
- `WorkShiftAssignment` → `schema.prisma:L3571`
- `WorkShiftTemplate` → `schema.prisma:L3548`
- `Zone` → `schema.prisma:L164`
