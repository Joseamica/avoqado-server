# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **422 models / 392 enums / ~19,600 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `FloorPlanPublication`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueIvaPorProducto`, `VenuePosSinAparato`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `CapabilityGrant`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `HybridBillingOperation`, `HybridCampaign`, `HybridContract`, `HybridContractSelection`, `HybridCreditAllocation`, `HybridOfferPublication`, `HybridPaymentPeriod`, `HybridPromotionGroup`, `HybridPurchase`, `HybridRedemption`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                               |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffAssignment`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffPosition`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                                                               |
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

- `AccountingPeriodLock` → `schema.prisma:L17624`
- `AccountMapping` → `schema.prisma:L17519`
- `ActivityLog` → `schema.prisma:L7661`
- `Aggregator` → `schema.prisma:L15773`
- `AggregatorBooking` → `schema.prisma:L15081`
- `AggregatorCapacityRule` → `schema.prisma:L15062`
- `AggregatorConnection` → `schema.prisma:L14987`
- `AggregatorInboundEvent` → `schema.prisma:L15150`
- `AggregatorOutbox` → `schema.prisma:L15170`
- `AggregatorProductLink` → `schema.prisma:L15019`
- `AggregatorSessionLink` → `schema.prisma:L15038`
- `AggregatorVisit` → `schema.prisma:L15107`
- `AngelPayUserAccount` → `schema.prisma:L6206`
- `AppUpdate` → `schema.prisma:L13648`
- `Area` → `schema.prisma:L3306`
- `AreaTicket` → `schema.prisma:L16322`
- `AreaTicketCheckoutSession` → `schema.prisma:L16444`
- `AreaTicketExternalIncident` → `schema.prisma:L16691`
- `AreaTicketExternalSettlement` → `schema.prisma:L16656`
- `AreaTicketFulfillment` → `schema.prisma:L16520`
- `AreaTicketInventoryReservation` → `schema.prisma:L16415`
- `AreaTicketLine` → `schema.prisma:L16383`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16476`
- `AreaTicketPrintAttempt` → `schema.prisma:L16499`
- `BankStatement` → `schema.prisma:L17393`
- `BankStatementLine` → `schema.prisma:L17414`
- `BillingObligationConflict` → `schema.prisma:L5236`
- `BillingTaxProfile` → `schema.prisma:L18216`
- `BirthdayAutomation` → `schema.prisma:L7985`
- `BulkCommandOperation` → `schema.prisma:L10920`
- `CalendarSyncOutbox` → `schema.prisma:L14870`
- `CampaignDelivery` → `schema.prisma:L13806`
- `CapabilityGrant` → `schema.prisma:L4976`
- `CashCloseout` → `schema.prisma:L11305`
- `CashDeposit` → `schema.prisma:L13450`
- `CashDrawerEvent` → `schema.prisma:L15610`
- `CashDrawerSession` → `schema.prisma:L15571`
- `CashOutCommissionRate` → `schema.prisma:L18033`
- `CashOutScheduleDay` → `schema.prisma:L18056`
- `CashOutWithdrawal` → `schema.prisma:L18118`
- `CatalogBindingBatch` → `schema.prisma:L12336`
- `CatalogBindingLine` → `schema.prisma:L12372`
- `CatalogBrand` → `schema.prisma:L11789`
- `CatalogClientObservation` → `schema.prisma:L12102`
- `CatalogClientReadinessOverride` → `schema.prisma:L12121`
- `CatalogFamily` → `schema.prisma:L11839`
- `CatalogIdempotencyRecord` → `schema.prisma:L12235`
- `CatalogIdentifier` → `schema.prisma:L11970`
- `CatalogImportBatch` → `schema.prisma:L12278`
- `CatalogImportLine` → `schema.prisma:L12315`
- `CatalogItem` → `schema.prisma:L11872`
- `CatalogItemBusinessType` → `schema.prisma:L11932`
- `CatalogItemPrice` → `schema.prisma:L12020`
- `CatalogManufacturer` → `schema.prisma:L11813`
- `CatalogProductTypeMapping` → `schema.prisma:L11949`
- `CatalogPublicationBatch` → `schema.prisma:L12400`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12494`
- `CatalogPublicationLine` → `schema.prisma:L12441`
- `CatalogPublicationOutbox` → `schema.prisma:L12537`
- `CatalogValidationProfile` → `schema.prisma:L11991`
- `CatalogVenueBinding` → `schema.prisma:L12149`
- `CatalogVenueClientRequirement` → `schema.prisma:L12076`
- `CatalogVenueEventSequence` → `schema.prisma:L12520`
- `CatalogVenueOverride` → `schema.prisma:L12191`
- `CatalogVenueRollout` → `schema.prisma:L12051`
- `Cfdi` → `schema.prisma:L17217`
- `CfdiGlobalOrden` → `schema.prisma:L17346`
- `ChatbotTokenBudget` → `schema.prisma:L10566`
- `ChatConversation` → `schema.prisma:L10421`
- `ChatFeedback` → `schema.prisma:L10507`
- `ChatLearningEvent` → `schema.prisma:L10464`
- `ChatMessage` → `schema.prisma:L10444`
- `ChatTrainingData` → `schema.prisma:L10378`
- `CheckoutSession` → `schema.prisma:L6486`
- `ClassSession` → `schema.prisma:L14464`
- `ClassSessionPayState` → `schema.prisma:L19176`
- `CommissionCalculation` → `schema.prisma:L13225`
- `CommissionClawback` → `schema.prisma:L13402`
- `CommissionConfig` → `schema.prisma:L12984`
- `CommissionMilestone` → `schema.prisma:L13141`
- `CommissionOverride` → `schema.prisma:L13068`
- `CommissionPayout` → `schema.prisma:L13353`
- `CommissionSummary` → `schema.prisma:L13292`
- `CommissionTier` → `schema.prisma:L13105`
- `ConsentEvent` → `schema.prisma:L7847`
- `Consumer` → `schema.prisma:L8077`
- `ConsumerAuthAccount` → `schema.prisma:L8102`
- `CouponCode` → `schema.prisma:L9049`
- `CouponRedemption` → `schema.prisma:L9080`
- `CreditAssessmentHistory` → `schema.prisma:L11414`
- `CreditItemBalance` → `schema.prisma:L15361`
- `CreditOffer` → `schema.prisma:L11433`
- `CreditPack` → `schema.prisma:L15270`
- `CreditPackItem` → `schema.prisma:L15299`
- `CreditPackPurchase` → `schema.prisma:L15316`
- `CreditTransaction` → `schema.prisma:L15383`
- `Customer` → `schema.prisma:L7702`
- `CustomerApprovalDelivery` → `schema.prisma:L10079`
- `CustomerApprovalOutbox` → `schema.prisma:L10054`
- `CustomerCampaign` → `schema.prisma:L7935`
- `CustomerCampaignDelivery` → `schema.prisma:L8017`
- `CustomerCaptureToken` → `schema.prisma:L7883`
- `CustomerDiscount` → `schema.prisma:L9100`
- `CustomerExternalIdentity` → `schema.prisma:L15137`
- `CustomerGroup` → `schema.prisma:L8141`
- `CustomerOrderMetric` → `schema.prisma:L4190`
- `CustomerTaxProfile` → `schema.prisma:L17365`
- `DeliveryActivationRequest` → `schema.prisma:L6945`
- `DeliveryChannelLink` → `schema.prisma:L6784`
- `DeliveryConnectIntent` → `schema.prisma:L6896`
- `DeliveryLineAction` → `schema.prisma:L6857`
- `DeliveryOrderEvent` → `schema.prisma:L6969`
- `DeliveryStoreRevocation` → `schema.prisma:L6933`
- `DeviceToken` → `schema.prisma:L9374`
- `DigitalReceipt` → `schema.prisma:L4789`
- `Discount` → `schema.prisma:L8739`
- `EcommerceMerchant` → `schema.prisma:L6298`
- `EmailQuotaLedger` → `schema.prisma:L8064`
- `EmailSuppression` → `schema.prisma:L8052`
- `EmailTemplate` → `schema.prisma:L13745`
- `Employee` → `schema.prisma:L17881`
- `Estimate` → `schema.prisma:L15680`
- `EstimateItem` → `schema.prisma:L15708`
- `Expense` → `schema.prisma:L17668`
- `ExternalBusyBlock` → `schema.prisma:L14763`
- `Feature` → `schema.prisma:L4918`
- `FeeSchedule` → `schema.prisma:L5298`
- `FeeTier` → `schema.prisma:L5309`
- `FinancialAccount` → `schema.prisma:L15870`
- `FinancialConnection` → `schema.prisma:L15839`
- `FinancialProvider` → `schema.prisma:L15825`
- `FiscalEmisor` → `schema.prisma:L17128`
- `FiscalLossCarryforward` → `schema.prisma:L17791`
- `FixedAsset` → `schema.prisma:L17809`
- `FixedAssetDepreciation` → `schema.prisma:L17838`
- `FloorElement` → `schema.prisma:L3387`
- `FloorPlanPublication` → `schema.prisma:L3427`
- `FulfillmentArea` → `schema.prisma:L16187`
- `GeofenceRule` → `schema.prisma:L11005`
- `GoogleCalendarChannel` → `schema.prisma:L14740`
- `GoogleCalendarConnection` → `schema.prisma:L14692`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14793`
- `GoogleOAuthSession` → `schema.prisma:L14815`
- `HolidayCalendar` → `schema.prisma:L7585`
- `HybridBillingOperation` → `schema.prisma:L5160`
- `HybridCampaign` → `schema.prisma:L5001`
- `HybridContract` → `schema.prisma:L5117`
- `HybridContractSelection` → `schema.prisma:L5149`
- `HybridCreditAllocation` → `schema.prisma:L5216`
- `HybridOfferPublication` → `schema.prisma:L5064`
- `HybridPaymentPeriod` → `schema.prisma:L5195`
- `HybridPromotionGroup` → `schema.prisma:L5045`
- `HybridPurchase` → `schema.prisma:L5084`
- `HybridRedemption` → `schema.prisma:L5178`
- `IdempotencyRequest` → `schema.prisma:L12859`
- `InterVenueTransfer` → `schema.prisma:L3134`
- `InterVenueTransferAllocation` → `schema.prisma:L3217`
- `InterVenueTransferItem` → `schema.prisma:L3186`
- `InterVenueTransferReceipt` → `schema.prisma:L3244`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3260`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3288`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3272`
- `Inventory` → `schema.prisma:L2056`
- `InventoryMovement` → `schema.prisma:L2156`
- `InventoryPosting` → `schema.prisma:L2251`
- `InventoryPostingLine` → `schema.prisma:L2291`
- `InventoryTransfer` → `schema.prisma:L15652`
- `InventoryWasteReport` → `schema.prisma:L2111`
- `Invitation` → `schema.prisma:L1548`
- `Invoice` → `schema.prisma:L5321`
- `InvoiceItem` → `schema.prisma:L5347`
- `ItemCategory` → `schema.prisma:L12572`
- `JournalEntry` → `schema.prisma:L17577`
- `JournalLine` → `schema.prisma:L17606`
- `KdsOrder` → `schema.prisma:L15918`
- `KdsOrderItem` → `schema.prisma:L15985`
- `KioskCheckInAttempt` → `schema.prisma:L18539`
- `KioskCheckInChallenge` → `schema.prisma:L18493`
- `KioskOutreachOutbox` → `schema.prisma:L18560`
- `LaunchCampaign` → `schema.prisma:L18898`
- `LaunchCampaignRedemption` → `schema.prisma:L19015`
- `LearnedPatterns` → `schema.prisma:L10488`
- `LedgerAccount` → `schema.prisma:L17469`
- `LiveDemoSession` → `schema.prisma:L866`
- `LowStockAlert` → `schema.prisma:L2964`
- `LoyaltyConfig` → `schema.prisma:L8171`
- `LoyaltyTransaction` → `schema.prisma:L8214`
- `MarketingCampaign` → `schema.prisma:L13763`
- `McpAuthCode` → `schema.prisma:L17010`
- `McpOAuthClient` → `schema.prisma:L16994`
- `McpRefreshToken` → `schema.prisma:L17028`
- `McpToolCall` → `schema.prisma:L17050`
- `MeasurementUnit` → `schema.prisma:L15758`
- `Menu` → `schema.prisma:L1766`
- `MenuCategory` → `schema.prisma:L1703`
- `MenuCategoryAssignment` → `schema.prisma:L1801`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16924`
- `MerchantAccount` → `schema.prisma:L6036`
- `MerchantFiscalConfig` → `schema.prisma:L17188`
- `MerchantRevenueShare` → `schema.prisma:L7165`
- `MerchantRoutingRule` → `schema.prisma:L6158`
- `MilestoneAchievement` → `schema.prisma:L13186`
- `Modifier` → `schema.prisma:L4391`
- `ModifierGroup` → `schema.prisma:L4355`
- `Module` → `schema.prisma:L11481`
- `MoneyAnomaly` → `schema.prisma:L7068`
- `MonthlyVenueProfit` → `schema.prisma:L7611`
- `Notification` → `schema.prisma:L9276`
- `NotificationPreference` → `schema.prisma:L9323`
- `NotificationTemplate` → `schema.prisma:L9350`
- `OAuthState` → `schema.prisma:L1599`
- `OnboardingProgress` → `schema.prisma:L1617`
- `Order` → `schema.prisma:L3916`
- `OrderAction` → `schema.prisma:L4462`
- `OrderCustomer` → `schema.prisma:L4169`
- `OrderDiscount` → `schema.prisma:L9132`
- `OrderFulfillment` → `schema.prisma:L16242`
- `OrderFulfillmentLine` → `schema.prisma:L16273`
- `OrderItem` → `schema.prisma:L4205`
- `OrderItemModifier` → `schema.prisma:L4444`
- `OrderItemSelloIva` → `schema.prisma:L17326`
- `OrderPromotion` → `schema.prisma:L18456`
- `OrderServiceCharge` → `schema.prisma:L9221`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13564`
- `OrganizationEntitlement` → `schema.prisma:L11764`
- `OrganizationGoal` → `schema.prisma:L13522`
- `OrganizationModule` → `schema.prisma:L11541`
- `OrganizationPaymentConfig` → `schema.prisma:L6610`
- `OrganizationPayoutConfig` → `schema.prisma:L13597`
- `OrganizationPricingStructure` → `schema.prisma:L6642`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13545`
- `OtpChallenge` → `schema.prisma:L8121`
- `OvertimeApproval` → `schema.prisma:L3631`
- `PartnerAPIKey` → `schema.prisma:L6440`
- `Payment` → `schema.prisma:L4495`
- `PaymentAllocation` → `schema.prisma:L4768`
- `PaymentEffect` → `schema.prisma:L18830`
- `PaymentLink` → `schema.prisma:L15429`
- `PaymentLinkAttribution` → `schema.prisma:L15537`
- `PaymentLinkItem` → `schema.prisma:L15492`
- `PaymentLinkItemModifier` → `schema.prisma:L15519`
- `PaymentProvider` → `schema.prisma:L5995`
- `PayrollLine` → `schema.prisma:L17952`
- `PayrollRun` → `schema.prisma:L17921`
- `PerformanceGoal` → `schema.prisma:L13499`
- `PermissionOverride` → `schema.prisma:L1472`
- `PermissionSet` → `schema.prisma:L1495`
- `PlatformAnnouncement` → `schema.prisma:L18620`
- `PlatformAnnouncementClick` → `schema.prisma:L18685`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18722`
- `PlatformCfdi` → `schema.prisma:L18249`
- `PlatformEmisor` → `schema.prisma:L18189`
- `PlatformSettings` → `schema.prisma:L6417`
- `PosCommand` → `schema.prisma:L9404`
- `PosConnectionStatus` → `schema.prisma:L1014`
- `PosSyncIntent` → `schema.prisma:L18327`
- `PricingPolicy` → `schema.prisma:L2860`
- `Printer` → `schema.prisma:L16043`
- `PrintGateway` → `schema.prisma:L16100`
- `PrintJob` → `schema.prisma:L16823`
- `PrintStation` → `schema.prisma:L16118`
- `PrivacyNoticeVersion` → `schema.prisma:L7869`
- `ProcessedStripeEvent` → `schema.prisma:L7054`
- `ProcessorReliabilityMetric` → `schema.prisma:L7539`
- `Product` → `schema.prisma:L1819`
- `ProductModifierGroup` → `schema.prisma:L4432`
- `ProductOption` → `schema.prisma:L15735`
- `ProductOptionValue` → `schema.prisma:L15746`
- `ProductStaff` → `schema.prisma:L14379`
- `PromoterBankAccount` → `schema.prisma:L18072`
- `PromoterCommissionEntry` → `schema.prisma:L18091`
- `PromoterLocationPing` → `schema.prisma:L3882`
- `Promotion` → `schema.prisma:L18378`
- `PromotionGroup` → `schema.prisma:L18417`
- `PromotionOption` → `schema.prisma:L18433`
- `ProviderCostStructure` → `schema.prisma:L7090`
- `ProviderEventLog` → `schema.prisma:L6719`
- `PurchaseOrder` → `schema.prisma:L2567`
- `PurchaseOrderInvoice` → `schema.prisma:L2712`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2779`
- `PurchaseOrderItem` → `schema.prisma:L2625`
- `RateCorrectionBatch` → `schema.prisma:L7315`
- `RateCorrectionEntry` → `schema.prisma:L7357`
- `RawMaterial` → `schema.prisma:L2323`
- `RawMaterialMovement` → `schema.prisma:L2913`
- `RawMaterialPresentation` → `schema.prisma:L2399`
- `ReceiptLayout` → `schema.prisma:L18864`
- `Recipe` → `schema.prisma:L2419`
- `RecipeLine` → `schema.prisma:L2443`
- `Referral` → `schema.prisma:L8587`
- `ReferralProgramConfig` → `schema.prisma:L8552`
- `ReferralRewardGrant` → `schema.prisma:L8678`
- `ReferralTierReward` → `schema.prisma:L8650`
- `ReferralTierUnlock` → `schema.prisma:L8723`
- `RefreshGrant` → `schema.prisma:L18809`
- `Reservation` → `schema.prisma:L14142`
- `ReservationGoogleEventMapping` → `schema.prisma:L15202`
- `ReservationModifier` → `schema.prisma:L14327`
- `ReservationReminderSent` → `schema.prisma:L14310`
- `ReservationSettings` → `schema.prisma:L14551`
- `ReservationWaitlistEntry` → `schema.prisma:L14519`
- `Review` → `schema.prisma:L5365`
- `SalesRetention` → `schema.prisma:L17772`
- `SaleVerification` → `schema.prisma:L4822`
- `ScaleProfile` → `schema.prisma:L16564`
- `ScheduledCommand` → `schema.prisma:L10965`
- `SerializedItem` → `schema.prisma:L12615`
- `SerializedItemCustodyEvent` → `schema.prisma:L12782`
- `ServiceCharge` → `schema.prisma:L9192`
- `ServiceEarning` → `schema.prisma:L19238`
- `ServicePayPeriod` → `schema.prisma:L19214`
- `ServicePayTable` → `schema.prisma:L19122`
- `ServicePayTableCell` → `schema.prisma:L19164`
- `ServicePayTableVersion` → `schema.prisma:L19139`
- `Session` → `schema.prisma:L18788`
- `SettlementConfiguration` → `schema.prisma:L7390`
- `SettlementConfirmation` → `schema.prisma:L7503`
- `SettlementIncident` → `schema.prisma:L7454`
- `SettlementSimulation` → `schema.prisma:L7425`
- `Shift` → `schema.prisma:L3442`
- `ShopifyConnectIntent` → `schema.prisma:L19549`
- `ShopifyImportIssue` → `schema.prisma:L19599`
- `ShopifyInboundEvent` → `schema.prisma:L19526`
- `ShopifyLocationLink` → `schema.prisma:L19400`
- `ShopifyReviewItem` → `schema.prisma:L19567`
- `ShopifyStockOutbox` → `schema.prisma:L19496`
- `ShopifyStore` → `schema.prisma:L19378`
- `ShopifyVariantLink` → `schema.prisma:L19448`
- `SimRegistrationRequest` → `schema.prisma:L12820`
- `SimRegistrationRequestItem` → `schema.prisma:L12842`
- `SlotHold` → `schema.prisma:L14410`
- `Staff` → `schema.prisma:L1034`
- `StaffAssignment` → `schema.prisma:L3729`
- `StaffDocument` → `schema.prisma:L3753`
- `StaffOnboardingState` → `schema.prisma:L16894`
- `StaffOrganization` → `schema.prisma:L1371`
- `StaffPasskey` → `schema.prisma:L1398`
- `StaffPayLevel` → `schema.prisma:L19086`
- `StaffPayLevelAssignment` → `schema.prisma:L19104`
- `StaffPayStatement` → `schema.prisma:L19270`
- `StaffPayTipWindow` → `schema.prisma:L19618`
- `StaffPayVenueWindow` → `schema.prisma:L19635`
- `StaffPosition` → `schema.prisma:L3708`
- `StaffSchedule` → `schema.prisma:L14350`
- `StaffScheduleException` → `schema.prisma:L14362`
- `StaffVenue` → `schema.prisma:L1295`
- `StaffWorkSchedule` → `schema.prisma:L3567`
- `StaffWorkScheduleException` → `schema.prisma:L3665`
- `StampCard` → `schema.prisma:L8435`
- `StampEvent` → `schema.prisma:L8474`
- `StampReward` → `schema.prisma:L8512`
- `StockAlertConfig` → `schema.prisma:L13481`
- `StockBatch` → `schema.prisma:L3083`
- `StockCount` → `schema.prisma:L2996`
- `StockCountItem` → `schema.prisma:L3024`
- `StripeWebhookEvent` → `schema.prisma:L7037`
- `Supplier` → `schema.prisma:L2478`
- `SupplierItemCode` → `schema.prisma:L2823`
- `SupplierPricing` → `schema.prisma:L2533`
- `Table` → `schema.prisma:L3337`
- `Terminal` → `schema.prisma:L5416`
- `TerminalAttemptResolution` → `schema.prisma:L5854`
- `TerminalHealth` → `schema.prisma:L5674`
- `TerminalLog` → `schema.prisma:L5648`
- `TerminalOrder` → `schema.prisma:L5898`
- `TerminalOrderItem` → `schema.prisma:L5973`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5826`
- `TerminalPaymentRequest` → `schema.prisma:L5745`
- `TimeEntry` → `schema.prisma:L3795`
- `TimeEntryBreak` → `schema.prisma:L3864`
- `TokenPurchase` → `schema.prisma:L10637`
- `TokenUsageRecord` → `schema.prisma:L10609`
- `TpvCommandHistory` → `schema.prisma:L10871`
- `TpvCommandQueue` → `schema.prisma:L10809`
- `TpvFeedback` → `schema.prisma:L10522`
- `TpvMessage` → `schema.prisma:L13838`
- `TpvMessageDelivery` → `schema.prisma:L13890`
- `TpvMessageResponse` → `schema.prisma:L13913`
- `TrainingModule` → `schema.prisma:L13968`
- `TrainingProgress` → `schema.prisma:L14045`
- `TrainingQuizQuestion` → `schema.prisma:L14027`
- `TrainingStep` → `schema.prisma:L14007`
- `TransactionCost` → `schema.prisma:L7253`
- `UnitConversion` → `schema.prisma:L2891`
- `UpsellAcceptance` → `schema.prisma:L9008`
- `UpsellAiRun` → `schema.prisma:L9028`
- `UpsellImpression` → `schema.prisma:L8968`
- `UpsellRule` → `schema.prisma:L8888`
- `user_sessions` → `schema.prisma:L6475`
- `Venue` → `schema.prisma:L185`
- `VenueAreaTicketSettings` → `schema.prisma:L16301`
- `VenueChatMessage` → `schema.prisma:L842`
- `VenueChatSession` → `schema.prisma:L797`
- `VenueCommission` → `schema.prisma:L15896`
- `VenueCreditAssessment` → `schema.prisma:L11353`
- `VenueCryptoConfig` → `schema.prisma:L13705`
- `VenueFeature` → `schema.prisma:L4936`
- `VenueIvaPorProducto` → `schema.prisma:L997`
- `VenueModule` → `schema.prisma:L11513`
- `VenuePaymentConfig` → `schema.prisma:L6576`
- `VenuePaymentLinkSettings` → `schema.prisma:L15235`
- `VenuePosSinAparato` → `schema.prisma:L1008`
- `VenuePricingStructure` → `schema.prisma:L7193`
- `VenueRoleConfig` → `schema.prisma:L1524`
- `VenueRolePermission` → `schema.prisma:L1428`
- `VenueScaleSettings` → `schema.prisma:L16552`
- `VenueSettings` → `schema.prisma:L882`
- `VenueTenderType` → `schema.prisma:L4681`
- `VenueTenderTypeRevision` → `schema.prisma:L4746`
- `VenueTransaction` → `schema.prisma:L4873`
- `VenueWhatsappActivation` → `schema.prisma:L733`
- `WalletCardDesign` → `schema.prisma:L8353`
- `WalletPass` → `schema.prisma:L8254`
- `WalletPassRegistration` → `schema.prisma:L8320`
- `WebhookEvent` → `schema.prisma:L5274`
- `WebhookSubscription` → `schema.prisma:L6692`
- `WhatsappContactWindow` → `schema.prisma:L751`
- `WhatsappInboundEvent` → `schema.prisma:L771`
- `WorkShiftAssignment` → `schema.prisma:L3607`
- `WorkShiftTemplate` → `schema.prisma:L3584`
- `Zone` → `schema.prisma:L168`
