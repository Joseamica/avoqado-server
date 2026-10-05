# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **391 models / 361 enums / ~18,500 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `InventoryWasteReport`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                                                                                                         |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryConnectIntent`, `DeliveryLineAction`, `DeliveryOrderEvent`, `DeliveryStoreRevocation`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                                                                                                      |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CfdiGlobalOrden`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `OrderItemSelloIva`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
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

- `AccountingPeriodLock` → `schema.prisma:L17136`
- `AccountMapping` → `schema.prisma:L17031`
- `ActivityLog` → `schema.prisma:L7509`
- `Aggregator` → `schema.prisma:L15307`
- `AngelPayUserAccount` → `schema.prisma:L6054`
- `AppUpdate` → `schema.prisma:L13472`
- `Area` → `schema.prisma:L3241`
- `AreaTicket` → `schema.prisma:L15843`
- `AreaTicketCheckoutSession` → `schema.prisma:L15965`
- `AreaTicketExternalIncident` → `schema.prisma:L16212`
- `AreaTicketExternalSettlement` → `schema.prisma:L16177`
- `AreaTicketFulfillment` → `schema.prisma:L16041`
- `AreaTicketInventoryReservation` → `schema.prisma:L15936`
- `AreaTicketLine` → `schema.prisma:L15904`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15997`
- `AreaTicketPrintAttempt` → `schema.prisma:L16020`
- `BankStatement` → `schema.prisma:L16905`
- `BankStatementLine` → `schema.prisma:L16926`
- `BillingObligationConflict` → `schema.prisma:L5084`
- `BillingTaxProfile` → `schema.prisma:L17728`
- `BirthdayAutomation` → `schema.prisma:L7830`
- `BulkCommandOperation` → `schema.prisma:L10752`
- `CalendarSyncOutbox` → `schema.prisma:L14679`
- `CampaignDelivery` → `schema.prisma:L13630`
- `CapabilityGrant` → `schema.prisma:L4824`
- `CashCloseout` → `schema.prisma:L11137`
- `CashDeposit` → `schema.prisma:L13274`
- `CashDrawerEvent` → `schema.prisma:L15144`
- `CashDrawerSession` → `schema.prisma:L15105`
- `CashOutCommissionRate` → `schema.prisma:L17545`
- `CashOutScheduleDay` → `schema.prisma:L17568`
- `CashOutWithdrawal` → `schema.prisma:L17630`
- `CatalogBindingBatch` → `schema.prisma:L12168`
- `CatalogBindingLine` → `schema.prisma:L12204`
- `CatalogBrand` → `schema.prisma:L11621`
- `CatalogClientObservation` → `schema.prisma:L11934`
- `CatalogClientReadinessOverride` → `schema.prisma:L11953`
- `CatalogFamily` → `schema.prisma:L11671`
- `CatalogIdempotencyRecord` → `schema.prisma:L12067`
- `CatalogIdentifier` → `schema.prisma:L11802`
- `CatalogImportBatch` → `schema.prisma:L12110`
- `CatalogImportLine` → `schema.prisma:L12147`
- `CatalogItem` → `schema.prisma:L11704`
- `CatalogItemBusinessType` → `schema.prisma:L11764`
- `CatalogItemPrice` → `schema.prisma:L11852`
- `CatalogManufacturer` → `schema.prisma:L11645`
- `CatalogProductTypeMapping` → `schema.prisma:L11781`
- `CatalogPublicationBatch` → `schema.prisma:L12232`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12326`
- `CatalogPublicationLine` → `schema.prisma:L12273`
- `CatalogPublicationOutbox` → `schema.prisma:L12369`
- `CatalogValidationProfile` → `schema.prisma:L11823`
- `CatalogVenueBinding` → `schema.prisma:L11981`
- `CatalogVenueClientRequirement` → `schema.prisma:L11908`
- `CatalogVenueEventSequence` → `schema.prisma:L12352`
- `CatalogVenueOverride` → `schema.prisma:L12023`
- `CatalogVenueRollout` → `schema.prisma:L11883`
- `Cfdi` → `schema.prisma:L16733`
- `CfdiGlobalOrden` → `schema.prisma:L16858`
- `ChatbotTokenBudget` → `schema.prisma:L10398`
- `ChatConversation` → `schema.prisma:L10253`
- `ChatFeedback` → `schema.prisma:L10339`
- `ChatLearningEvent` → `schema.prisma:L10296`
- `ChatMessage` → `schema.prisma:L10276`
- `ChatTrainingData` → `schema.prisma:L10210`
- `CheckoutSession` → `schema.prisma:L6334`
- `ClassSession` → `schema.prisma:L14283`
- `CommissionCalculation` → `schema.prisma:L13050`
- `CommissionClawback` → `schema.prisma:L13226`
- `CommissionConfig` → `schema.prisma:L12816`
- `CommissionMilestone` → `schema.prisma:L12966`
- `CommissionOverride` → `schema.prisma:L12893`
- `CommissionPayout` → `schema.prisma:L13177`
- `CommissionSummary` → `schema.prisma:L13116`
- `CommissionTier` → `schema.prisma:L12930`
- `ConsentEvent` → `schema.prisma:L7692`
- `Consumer` → `schema.prisma:L7922`
- `ConsumerAuthAccount` → `schema.prisma:L7947`
- `CouponCode` → `schema.prisma:L8894`
- `CouponRedemption` → `schema.prisma:L8925`
- `CreditAssessmentHistory` → `schema.prisma:L11246`
- `CreditItemBalance` → `schema.prisma:L14895`
- `CreditOffer` → `schema.prisma:L11265`
- `CreditPack` → `schema.prisma:L14804`
- `CreditPackItem` → `schema.prisma:L14833`
- `CreditPackPurchase` → `schema.prisma:L14850`
- `CreditTransaction` → `schema.prisma:L14917`
- `Customer` → `schema.prisma:L7550`
- `CustomerApprovalDelivery` → `schema.prisma:L9912`
- `CustomerApprovalOutbox` → `schema.prisma:L9887`
- `CustomerCampaign` → `schema.prisma:L7780`
- `CustomerCampaignDelivery` → `schema.prisma:L7862`
- `CustomerCaptureToken` → `schema.prisma:L7728`
- `CustomerDiscount` → `schema.prisma:L8945`
- `CustomerGroup` → `schema.prisma:L7986`
- `CustomerOrderMetric` → `schema.prisma:L4040`
- `CustomerTaxProfile` → `schema.prisma:L16877`
- `DeliveryActivationRequest` → `schema.prisma:L6793`
- `DeliveryChannelLink` → `schema.prisma:L6632`
- `DeliveryConnectIntent` → `schema.prisma:L6744`
- `DeliveryLineAction` → `schema.prisma:L6705`
- `DeliveryOrderEvent` → `schema.prisma:L6817`
- `DeliveryStoreRevocation` → `schema.prisma:L6781`
- `DeviceToken` → `schema.prisma:L9214`
- `DigitalReceipt` → `schema.prisma:L4637`
- `Discount` → `schema.prisma:L8584`
- `EcommerceMerchant` → `schema.prisma:L6146`
- `EmailQuotaLedger` → `schema.prisma:L7909`
- `EmailSuppression` → `schema.prisma:L7897`
- `EmailTemplate` → `schema.prisma:L13569`
- `Employee` → `schema.prisma:L17393`
- `Estimate` → `schema.prisma:L15214`
- `EstimateItem` → `schema.prisma:L15242`
- `Expense` → `schema.prisma:L17180`
- `ExternalBusyBlock` → `schema.prisma:L14572`
- `Feature` → `schema.prisma:L4766`
- `FeeSchedule` → `schema.prisma:L5146`
- `FeeTier` → `schema.prisma:L5157`
- `FinancialAccount` → `schema.prisma:L15404`
- `FinancialConnection` → `schema.prisma:L15373`
- `FinancialProvider` → `schema.prisma:L15359`
- `FiscalEmisor` → `schema.prisma:L16649`
- `FiscalLossCarryforward` → `schema.prisma:L17303`
- `FixedAsset` → `schema.prisma:L17321`
- `FixedAssetDepreciation` → `schema.prisma:L17350`
- `FloorElement` → `schema.prisma:L3317`
- `FulfillmentArea` → `schema.prisma:L15708`
- `GeofenceRule` → `schema.prisma:L10837`
- `GoogleCalendarChannel` → `schema.prisma:L14549`
- `GoogleCalendarConnection` → `schema.prisma:L14501`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14602`
- `GoogleOAuthSession` → `schema.prisma:L14624`
- `HolidayCalendar` → `schema.prisma:L7433`
- `HybridBillingOperation` → `schema.prisma:L5008`
- `HybridCampaign` → `schema.prisma:L4849`
- `HybridContract` → `schema.prisma:L4965`
- `HybridContractSelection` → `schema.prisma:L4997`
- `HybridCreditAllocation` → `schema.prisma:L5064`
- `HybridOfferPublication` → `schema.prisma:L4912`
- `HybridPaymentPeriod` → `schema.prisma:L5043`
- `HybridPromotionGroup` → `schema.prisma:L4893`
- `HybridPurchase` → `schema.prisma:L4932`
- `HybridRedemption` → `schema.prisma:L5026`
- `IdempotencyRequest` → `schema.prisma:L12691`
- `InterVenueTransfer` → `schema.prisma:L3069`
- `InterVenueTransferAllocation` → `schema.prisma:L3152`
- `InterVenueTransferItem` → `schema.prisma:L3121`
- `InterVenueTransferReceipt` → `schema.prisma:L3179`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3195`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3223`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3207`
- `Inventory` → `schema.prisma:L2013`
- `InventoryMovement` → `schema.prisma:L2113`
- `InventoryPosting` → `schema.prisma:L2208`
- `InventoryPostingLine` → `schema.prisma:L2248`
- `InventoryTransfer` → `schema.prisma:L15186`
- `InventoryWasteReport` → `schema.prisma:L2068`
- `Invitation` → `schema.prisma:L1510`
- `Invoice` → `schema.prisma:L5169`
- `InvoiceItem` → `schema.prisma:L5195`
- `ItemCategory` → `schema.prisma:L12404`
- `JournalEntry` → `schema.prisma:L17089`
- `JournalLine` → `schema.prisma:L17118`
- `KdsOrder` → `schema.prisma:L15452`
- `KdsOrderItem` → `schema.prisma:L15515`
- `KioskCheckInAttempt` → `schema.prisma:L18051`
- `KioskCheckInChallenge` → `schema.prisma:L18005`
- `KioskOutreachOutbox` → `schema.prisma:L18072`
- `LaunchCampaign` → `schema.prisma:L18410`
- `LaunchCampaignRedemption` → `schema.prisma:L18527`
- `LearnedPatterns` → `schema.prisma:L10320`
- `LedgerAccount` → `schema.prisma:L16981`
- `LiveDemoSession` → `schema.prisma:L836`
- `LowStockAlert` → `schema.prisma:L2903`
- `LoyaltyConfig` → `schema.prisma:L8016`
- `LoyaltyTransaction` → `schema.prisma:L8059`
- `MarketingCampaign` → `schema.prisma:L13587`
- `McpAuthCode` → `schema.prisma:L16531`
- `McpOAuthClient` → `schema.prisma:L16515`
- `McpRefreshToken` → `schema.prisma:L16549`
- `McpToolCall` → `schema.prisma:L16571`
- `MeasurementUnit` → `schema.prisma:L15292`
- `Menu` → `schema.prisma:L1728`
- `MenuCategory` → `schema.prisma:L1665`
- `MenuCategoryAssignment` → `schema.prisma:L1763`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16445`
- `MerchantAccount` → `schema.prisma:L5884`
- `MerchantFiscalConfig` → `schema.prisma:L16704`
- `MerchantRevenueShare` → `schema.prisma:L7013`
- `MerchantRoutingRule` → `schema.prisma:L6006`
- `MilestoneAchievement` → `schema.prisma:L13011`
- `Modifier` → `schema.prisma:L4239`
- `ModifierGroup` → `schema.prisma:L4203`
- `Module` → `schema.prisma:L11313`
- `MoneyAnomaly` → `schema.prisma:L6916`
- `MonthlyVenueProfit` → `schema.prisma:L7459`
- `Notification` → `schema.prisma:L9116`
- `NotificationPreference` → `schema.prisma:L9163`
- `NotificationTemplate` → `schema.prisma:L9190`
- `OAuthState` → `schema.prisma:L1561`
- `OnboardingProgress` → `schema.prisma:L1579`
- `Order` → `schema.prisma:L3766`
- `OrderAction` → `schema.prisma:L4310`
- `OrderCustomer` → `schema.prisma:L4019`
- `OrderDiscount` → `schema.prisma:L8977`
- `OrderFulfillment` → `schema.prisma:L15763`
- `OrderFulfillmentLine` → `schema.prisma:L15794`
- `OrderItem` → `schema.prisma:L4055`
- `OrderItemModifier` → `schema.prisma:L4292`
- `OrderItemSelloIva` → `schema.prisma:L16838`
- `OrderPromotion` → `schema.prisma:L17968`
- `OrderServiceCharge` → `schema.prisma:L9061`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13388`
- `OrganizationEntitlement` → `schema.prisma:L11596`
- `OrganizationGoal` → `schema.prisma:L13346`
- `OrganizationModule` → `schema.prisma:L11373`
- `OrganizationPaymentConfig` → `schema.prisma:L6458`
- `OrganizationPayoutConfig` → `schema.prisma:L13421`
- `OrganizationPricingStructure` → `schema.prisma:L6490`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13369`
- `OtpChallenge` → `schema.prisma:L7966`
- `OvertimeApproval` → `schema.prisma:L3544`
- `PartnerAPIKey` → `schema.prisma:L6288`
- `Payment` → `schema.prisma:L4343`
- `PaymentAllocation` → `schema.prisma:L4616`
- `PaymentEffect` → `schema.prisma:L18342`
- `PaymentLink` → `schema.prisma:L14963`
- `PaymentLinkAttribution` → `schema.prisma:L15071`
- `PaymentLinkItem` → `schema.prisma:L15026`
- `PaymentLinkItemModifier` → `schema.prisma:L15053`
- `PaymentProvider` → `schema.prisma:L5843`
- `PayrollLine` → `schema.prisma:L17464`
- `PayrollRun` → `schema.prisma:L17433`
- `PerformanceGoal` → `schema.prisma:L13323`
- `PermissionOverride` → `schema.prisma:L1434`
- `PermissionSet` → `schema.prisma:L1457`
- `PlatformAnnouncement` → `schema.prisma:L18132`
- `PlatformAnnouncementClick` → `schema.prisma:L18197`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18234`
- `PlatformCfdi` → `schema.prisma:L17761`
- `PlatformEmisor` → `schema.prisma:L17701`
- `PlatformSettings` → `schema.prisma:L6265`
- `PosCommand` → `schema.prisma:L9244`
- `PosConnectionStatus` → `schema.prisma:L980`
- `PosSyncIntent` → `schema.prisma:L17839`
- `PricingPolicy` → `schema.prisma:L2799`
- `Printer` → `schema.prisma:L15564`
- `PrintGateway` → `schema.prisma:L15621`
- `PrintJob` → `schema.prisma:L16344`
- `PrintStation` → `schema.prisma:L15639`
- `PrivacyNoticeVersion` → `schema.prisma:L7714`
- `ProcessedStripeEvent` → `schema.prisma:L6902`
- `ProcessorReliabilityMetric` → `schema.prisma:L7387`
- `Product` → `schema.prisma:L1781`
- `ProductModifierGroup` → `schema.prisma:L4280`
- `ProductOption` → `schema.prisma:L15269`
- `ProductOptionValue` → `schema.prisma:L15280`
- `ProductStaff` → `schema.prisma:L14198`
- `PromoterBankAccount` → `schema.prisma:L17584`
- `PromoterCommissionEntry` → `schema.prisma:L17603`
- `PromoterLocationPing` → `schema.prisma:L3732`
- `Promotion` → `schema.prisma:L17890`
- `PromotionGroup` → `schema.prisma:L17929`
- `PromotionOption` → `schema.prisma:L17945`
- `ProviderCostStructure` → `schema.prisma:L6938`
- `ProviderEventLog` → `schema.prisma:L6567`
- `PurchaseOrder` → `schema.prisma:L2524`
- `PurchaseOrderInvoice` → `schema.prisma:L2669`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2726`
- `PurchaseOrderItem` → `schema.prisma:L2582`
- `RateCorrectionBatch` → `schema.prisma:L7163`
- `RateCorrectionEntry` → `schema.prisma:L7205`
- `RawMaterial` → `schema.prisma:L2280`
- `RawMaterialMovement` → `schema.prisma:L2852`
- `RawMaterialPresentation` → `schema.prisma:L2356`
- `ReceiptLayout` → `schema.prisma:L18376`
- `Recipe` → `schema.prisma:L2376`
- `RecipeLine` → `schema.prisma:L2400`
- `Referral` → `schema.prisma:L8432`
- `ReferralProgramConfig` → `schema.prisma:L8397`
- `ReferralRewardGrant` → `schema.prisma:L8523`
- `ReferralTierReward` → `schema.prisma:L8495`
- `ReferralTierUnlock` → `schema.prisma:L8568`
- `RefreshGrant` → `schema.prisma:L18321`
- `Reservation` → `schema.prisma:L13966`
- `ReservationGoogleEventMapping` → `schema.prisma:L14736`
- `ReservationModifier` → `schema.prisma:L14146`
- `ReservationReminderSent` → `schema.prisma:L14129`
- `ReservationSettings` → `schema.prisma:L14360`
- `ReservationWaitlistEntry` → `schema.prisma:L14328`
- `Review` → `schema.prisma:L5213`
- `SalesRetention` → `schema.prisma:L17284`
- `SaleVerification` → `schema.prisma:L4670`
- `ScaleProfile` → `schema.prisma:L16085`
- `ScheduledCommand` → `schema.prisma:L10797`
- `SerializedItem` → `schema.prisma:L12447`
- `SerializedItemCustodyEvent` → `schema.prisma:L12614`
- `ServiceCharge` → `schema.prisma:L9032`
- `Session` → `schema.prisma:L18300`
- `SettlementConfiguration` → `schema.prisma:L7238`
- `SettlementConfirmation` → `schema.prisma:L7351`
- `SettlementIncident` → `schema.prisma:L7302`
- `SettlementSimulation` → `schema.prisma:L7273`
- `Shift` → `schema.prisma:L3355`
- `SimRegistrationRequest` → `schema.prisma:L12652`
- `SimRegistrationRequestItem` → `schema.prisma:L12674`
- `SlotHold` → `schema.prisma:L14229`
- `Staff` → `schema.prisma:L1000`
- `StaffDocument` → `schema.prisma:L3603`
- `StaffOnboardingState` → `schema.prisma:L16415`
- `StaffOrganization` → `schema.prisma:L1333`
- `StaffPasskey` → `schema.prisma:L1360`
- `StaffSchedule` → `schema.prisma:L14169`
- `StaffScheduleException` → `schema.prisma:L14181`
- `StaffVenue` → `schema.prisma:L1257`
- `StaffWorkSchedule` → `schema.prisma:L3480`
- `StaffWorkScheduleException` → `schema.prisma:L3578`
- `StampCard` → `schema.prisma:L8280`
- `StampEvent` → `schema.prisma:L8319`
- `StampReward` → `schema.prisma:L8357`
- `StockAlertConfig` → `schema.prisma:L13305`
- `StockBatch` → `schema.prisma:L3018`
- `StockCount` → `schema.prisma:L2935`
- `StockCountItem` → `schema.prisma:L2963`
- `StripeWebhookEvent` → `schema.prisma:L6885`
- `Supplier` → `schema.prisma:L2435`
- `SupplierItemCode` → `schema.prisma:L2767`
- `SupplierPricing` → `schema.prisma:L2490`
- `Table` → `schema.prisma:L3267`
- `Terminal` → `schema.prisma:L5264`
- `TerminalAttemptResolution` → `schema.prisma:L5702`
- `TerminalHealth` → `schema.prisma:L5522`
- `TerminalLog` → `schema.prisma:L5496`
- `TerminalOrder` → `schema.prisma:L5746`
- `TerminalOrderItem` → `schema.prisma:L5821`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5674`
- `TerminalPaymentRequest` → `schema.prisma:L5593`
- `TimeEntry` → `schema.prisma:L3645`
- `TimeEntryBreak` → `schema.prisma:L3714`
- `TokenPurchase` → `schema.prisma:L10469`
- `TokenUsageRecord` → `schema.prisma:L10441`
- `TpvCommandHistory` → `schema.prisma:L10703`
- `TpvCommandQueue` → `schema.prisma:L10641`
- `TpvFeedback` → `schema.prisma:L10354`
- `TpvMessage` → `schema.prisma:L13662`
- `TpvMessageDelivery` → `schema.prisma:L13714`
- `TpvMessageResponse` → `schema.prisma:L13737`
- `TrainingModule` → `schema.prisma:L13792`
- `TrainingProgress` → `schema.prisma:L13869`
- `TrainingQuizQuestion` → `schema.prisma:L13851`
- `TrainingStep` → `schema.prisma:L13831`
- `TransactionCost` → `schema.prisma:L7101`
- `UnitConversion` → `schema.prisma:L2830`
- `UpsellAcceptance` → `schema.prisma:L8853`
- `UpsellAiRun` → `schema.prisma:L8873`
- `UpsellImpression` → `schema.prisma:L8813`
- `UpsellRule` → `schema.prisma:L8733`
- `user_sessions` → `schema.prisma:L6323`
- `Venue` → `schema.prisma:L167`
- `VenueAreaTicketSettings` → `schema.prisma:L15822`
- `VenueChatMessage` → `schema.prisma:L812`
- `VenueChatSession` → `schema.prisma:L767`
- `VenueCommission` → `schema.prisma:L15430`
- `VenueCreditAssessment` → `schema.prisma:L11185`
- `VenueCryptoConfig` → `schema.prisma:L13529`
- `VenueFeature` → `schema.prisma:L4784`
- `VenueIvaPorProducto` → `schema.prisma:L963`
- `VenueModule` → `schema.prisma:L11345`
- `VenuePaymentConfig` → `schema.prisma:L6424`
- `VenuePaymentLinkSettings` → `schema.prisma:L14769`
- `VenuePosSinAparato` → `schema.prisma:L974`
- `VenuePricingStructure` → `schema.prisma:L7041`
- `VenueRoleConfig` → `schema.prisma:L1486`
- `VenueRolePermission` → `schema.prisma:L1390`
- `VenueScaleSettings` → `schema.prisma:L16073`
- `VenueSettings` → `schema.prisma:L852`
- `VenueTenderType` → `schema.prisma:L4529`
- `VenueTenderTypeRevision` → `schema.prisma:L4594`
- `VenueTransaction` → `schema.prisma:L4721`
- `VenueWhatsappActivation` → `schema.prisma:L703`
- `WalletCardDesign` → `schema.prisma:L8198`
- `WalletPass` → `schema.prisma:L8099`
- `WalletPassRegistration` → `schema.prisma:L8165`
- `WebhookEvent` → `schema.prisma:L5122`
- `WebhookSubscription` → `schema.prisma:L6540`
- `WhatsappContactWindow` → `schema.prisma:L721`
- `WhatsappInboundEvent` → `schema.prisma:L741`
- `WorkShiftAssignment` → `schema.prisma:L3520`
- `WorkShiftTemplate` → `schema.prisma:L3497`
- `Zone` → `schema.prisma:L150`
