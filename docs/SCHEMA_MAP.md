# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **386 models / 358 enums / ~18,300 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `CapabilityGrant`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `HybridBillingOperation`, `HybridCampaign`, `HybridContract`, `HybridContractSelection`, `HybridCreditAllocation`, `HybridOfferPublication`, `HybridPaymentPeriod`, `HybridPurchase`, `HybridRedemption`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                       |
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

- `AccountingPeriodLock` → `schema.prisma:L16940`
- `AccountMapping` → `schema.prisma:L16836`
- `ActivityLog` → `schema.prisma:L7406`
- `Aggregator` → `schema.prisma:L15196`
- `AngelPayUserAccount` → `schema.prisma:L5951`
- `AppUpdate` → `schema.prisma:L13361`
- `Area` → `schema.prisma:L3206`
- `AreaTicket` → `schema.prisma:L15714`
- `AreaTicketCheckoutSession` → `schema.prisma:L15836`
- `AreaTicketExternalIncident` → `schema.prisma:L16083`
- `AreaTicketExternalSettlement` → `schema.prisma:L16048`
- `AreaTicketFulfillment` → `schema.prisma:L15912`
- `AreaTicketInventoryReservation` → `schema.prisma:L15807`
- `AreaTicketLine` → `schema.prisma:L15775`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15868`
- `AreaTicketPrintAttempt` → `schema.prisma:L15891`
- `BankStatement` → `schema.prisma:L16710`
- `BankStatementLine` → `schema.prisma:L16731`
- `BillingObligationConflict` → `schema.prisma:L4988`
- `BillingTaxProfile` → `schema.prisma:L17520`
- `BirthdayAutomation` → `schema.prisma:L7727`
- `BulkCommandOperation` → `schema.prisma:L10641`
- `CalendarSyncOutbox` → `schema.prisma:L14568`
- `CampaignDelivery` → `schema.prisma:L13519`
- `CapabilityGrant` → `schema.prisma:L4764`
- `CashCloseout` → `schema.prisma:L11026`
- `CashDeposit` → `schema.prisma:L13163`
- `CashDrawerEvent` → `schema.prisma:L15033`
- `CashDrawerSession` → `schema.prisma:L14994`
- `CashOutCommissionRate` → `schema.prisma:L17349`
- `CashOutScheduleDay` → `schema.prisma:L17372`
- `CashOutWithdrawal` → `schema.prisma:L17434`
- `CatalogBindingBatch` → `schema.prisma:L12057`
- `CatalogBindingLine` → `schema.prisma:L12093`
- `CatalogBrand` → `schema.prisma:L11510`
- `CatalogClientObservation` → `schema.prisma:L11823`
- `CatalogClientReadinessOverride` → `schema.prisma:L11842`
- `CatalogFamily` → `schema.prisma:L11560`
- `CatalogIdempotencyRecord` → `schema.prisma:L11956`
- `CatalogIdentifier` → `schema.prisma:L11691`
- `CatalogImportBatch` → `schema.prisma:L11999`
- `CatalogImportLine` → `schema.prisma:L12036`
- `CatalogItem` → `schema.prisma:L11593`
- `CatalogItemBusinessType` → `schema.prisma:L11653`
- `CatalogItemPrice` → `schema.prisma:L11741`
- `CatalogManufacturer` → `schema.prisma:L11534`
- `CatalogProductTypeMapping` → `schema.prisma:L11670`
- `CatalogPublicationBatch` → `schema.prisma:L12121`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12215`
- `CatalogPublicationLine` → `schema.prisma:L12162`
- `CatalogPublicationOutbox` → `schema.prisma:L12258`
- `CatalogValidationProfile` → `schema.prisma:L11712`
- `CatalogVenueBinding` → `schema.prisma:L11870`
- `CatalogVenueClientRequirement` → `schema.prisma:L11797`
- `CatalogVenueEventSequence` → `schema.prisma:L12241`
- `CatalogVenueOverride` → `schema.prisma:L11912`
- `CatalogVenueRollout` → `schema.prisma:L11772`
- `Cfdi` → `schema.prisma:L16603`
- `ChatbotTokenBudget` → `schema.prisma:L10289`
- `ChatConversation` → `schema.prisma:L10144`
- `ChatFeedback` → `schema.prisma:L10230`
- `ChatLearningEvent` → `schema.prisma:L10187`
- `ChatMessage` → `schema.prisma:L10167`
- `ChatTrainingData` → `schema.prisma:L10101`
- `CheckoutSession` → `schema.prisma:L6231`
- `ClassSession` → `schema.prisma:L14172`
- `CommissionCalculation` → `schema.prisma:L12939`
- `CommissionClawback` → `schema.prisma:L13115`
- `CommissionConfig` → `schema.prisma:L12705`
- `CommissionMilestone` → `schema.prisma:L12855`
- `CommissionOverride` → `schema.prisma:L12782`
- `CommissionPayout` → `schema.prisma:L13066`
- `CommissionSummary` → `schema.prisma:L13005`
- `CommissionTier` → `schema.prisma:L12819`
- `ConsentEvent` → `schema.prisma:L7589`
- `Consumer` → `schema.prisma:L7819`
- `ConsumerAuthAccount` → `schema.prisma:L7844`
- `CouponCode` → `schema.prisma:L8791`
- `CouponRedemption` → `schema.prisma:L8822`
- `CreditAssessmentHistory` → `schema.prisma:L11135`
- `CreditItemBalance` → `schema.prisma:L14784`
- `CreditOffer` → `schema.prisma:L11154`
- `CreditPack` → `schema.prisma:L14693`
- `CreditPackItem` → `schema.prisma:L14722`
- `CreditPackPurchase` → `schema.prisma:L14739`
- `CreditTransaction` → `schema.prisma:L14806`
- `Customer` → `schema.prisma:L7447`
- `CustomerApprovalDelivery` → `schema.prisma:L9803`
- `CustomerApprovalOutbox` → `schema.prisma:L9778`
- `CustomerCampaign` → `schema.prisma:L7677`
- `CustomerCampaignDelivery` → `schema.prisma:L7759`
- `CustomerCaptureToken` → `schema.prisma:L7625`
- `CustomerDiscount` → `schema.prisma:L8842`
- `CustomerGroup` → `schema.prisma:L7883`
- `CustomerOrderMetric` → `schema.prisma:L3994`
- `CustomerTaxProfile` → `schema.prisma:L16682`
- `DeliveryActivationRequest` → `schema.prisma:L6690`
- `DeliveryChannelLink` → `schema.prisma:L6529`
- `DeliveryConnectIntent` → `schema.prisma:L6641`
- `DeliveryLineAction` → `schema.prisma:L6602`
- `DeliveryOrderEvent` → `schema.prisma:L6714`
- `DeliveryStoreRevocation` → `schema.prisma:L6678`
- `DeviceToken` → `schema.prisma:L9111`
- `DigitalReceipt` → `schema.prisma:L4577`
- `Discount` → `schema.prisma:L8481`
- `EcommerceMerchant` → `schema.prisma:L6043`
- `EmailQuotaLedger` → `schema.prisma:L7806`
- `EmailSuppression` → `schema.prisma:L7794`
- `EmailTemplate` → `schema.prisma:L13458`
- `Employee` → `schema.prisma:L17197`
- `Estimate` → `schema.prisma:L15103`
- `EstimateItem` → `schema.prisma:L15131`
- `Expense` → `schema.prisma:L16984`
- `ExternalBusyBlock` → `schema.prisma:L14461`
- `Feature` → `schema.prisma:L4706`
- `FeeSchedule` → `schema.prisma:L5050`
- `FeeTier` → `schema.prisma:L5061`
- `FinancialAccount` → `schema.prisma:L15293`
- `FinancialConnection` → `schema.prisma:L15262`
- `FinancialProvider` → `schema.prisma:L15248`
- `FiscalEmisor` → `schema.prisma:L16519`
- `FiscalLossCarryforward` → `schema.prisma:L17107`
- `FixedAsset` → `schema.prisma:L17125`
- `FixedAssetDepreciation` → `schema.prisma:L17154`
- `FloorElement` → `schema.prisma:L3282`
- `FulfillmentArea` → `schema.prisma:L15579`
- `GeofenceRule` → `schema.prisma:L10726`
- `GoogleCalendarChannel` → `schema.prisma:L14438`
- `GoogleCalendarConnection` → `schema.prisma:L14390`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14491`
- `GoogleOAuthSession` → `schema.prisma:L14513`
- `HolidayCalendar` → `schema.prisma:L7330`
- `HybridBillingOperation` → `schema.prisma:L4912`
- `HybridCampaign` → `schema.prisma:L4789`
- `HybridContract` → `schema.prisma:L4869`
- `HybridContractSelection` → `schema.prisma:L4901`
- `HybridCreditAllocation` → `schema.prisma:L4968`
- `HybridOfferPublication` → `schema.prisma:L4816`
- `HybridPaymentPeriod` → `schema.prisma:L4947`
- `HybridPurchase` → `schema.prisma:L4836`
- `HybridRedemption` → `schema.prisma:L4930`
- `IdempotencyRequest` → `schema.prisma:L12580`
- `InterVenueTransfer` → `schema.prisma:L3034`
- `InterVenueTransferAllocation` → `schema.prisma:L3117`
- `InterVenueTransferItem` → `schema.prisma:L3086`
- `InterVenueTransferReceipt` → `schema.prisma:L3144`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3160`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3188`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3172`
- `Inventory` → `schema.prisma:L1978`
- `InventoryMovement` → `schema.prisma:L2078`
- `InventoryPosting` → `schema.prisma:L2173`
- `InventoryPostingLine` → `schema.prisma:L2213`
- `InventoryTransfer` → `schema.prisma:L15075`
- `InventoryWasteReport` → `schema.prisma:L2033`
- `Invitation` → `schema.prisma:L1483`
- `Invoice` → `schema.prisma:L5073`
- `InvoiceItem` → `schema.prisma:L5099`
- `ItemCategory` → `schema.prisma:L12293`
- `JournalEntry` → `schema.prisma:L16894`
- `JournalLine` → `schema.prisma:L16922`
- `KdsOrder` → `schema.prisma:L15341`
- `KdsOrderItem` → `schema.prisma:L15390`
- `KioskCheckInAttempt` → `schema.prisma:L17843`
- `KioskCheckInChallenge` → `schema.prisma:L17797`
- `KioskOutreachOutbox` → `schema.prisma:L17864`
- `LaunchCampaign` → `schema.prisma:L18202`
- `LaunchCampaignRedemption` → `schema.prisma:L18319`
- `LearnedPatterns` → `schema.prisma:L10211`
- `LedgerAccount` → `schema.prisma:L16786`
- `LiveDemoSession` → `schema.prisma:L827`
- `LowStockAlert` → `schema.prisma:L2868`
- `LoyaltyConfig` → `schema.prisma:L7913`
- `LoyaltyTransaction` → `schema.prisma:L7956`
- `MarketingCampaign` → `schema.prisma:L13476`
- `McpAuthCode` → `schema.prisma:L16402`
- `McpOAuthClient` → `schema.prisma:L16386`
- `McpRefreshToken` → `schema.prisma:L16420`
- `McpToolCall` → `schema.prisma:L16441`
- `MeasurementUnit` → `schema.prisma:L15181`
- `Menu` → `schema.prisma:L1701`
- `MenuCategory` → `schema.prisma:L1638`
- `MenuCategoryAssignment` → `schema.prisma:L1736`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16316`
- `MerchantAccount` → `schema.prisma:L5781`
- `MerchantFiscalConfig` → `schema.prisma:L16574`
- `MerchantRevenueShare` → `schema.prisma:L6910`
- `MerchantRoutingRule` → `schema.prisma:L5903`
- `MilestoneAchievement` → `schema.prisma:L12900`
- `Modifier` → `schema.prisma:L4183`
- `ModifierGroup` → `schema.prisma:L4147`
- `Module` → `schema.prisma:L11202`
- `MoneyAnomaly` → `schema.prisma:L6813`
- `MonthlyVenueProfit` → `schema.prisma:L7356`
- `Notification` → `schema.prisma:L9013`
- `NotificationPreference` → `schema.prisma:L9060`
- `NotificationTemplate` → `schema.prisma:L9087`
- `OAuthState` → `schema.prisma:L1534`
- `OnboardingProgress` → `schema.prisma:L1552`
- `Order` → `schema.prisma:L3731`
- `OrderAction` → `schema.prisma:L4250`
- `OrderCustomer` → `schema.prisma:L3973`
- `OrderDiscount` → `schema.prisma:L8874`
- `OrderFulfillment` → `schema.prisma:L15634`
- `OrderFulfillmentLine` → `schema.prisma:L15665`
- `OrderItem` → `schema.prisma:L4009`
- `OrderItemModifier` → `schema.prisma:L4232`
- `OrderPromotion` → `schema.prisma:L17760`
- `OrderServiceCharge` → `schema.prisma:L8958`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13277`
- `OrganizationEntitlement` → `schema.prisma:L11485`
- `OrganizationGoal` → `schema.prisma:L13235`
- `OrganizationModule` → `schema.prisma:L11262`
- `OrganizationPaymentConfig` → `schema.prisma:L6355`
- `OrganizationPayoutConfig` → `schema.prisma:L13310`
- `OrganizationPricingStructure` → `schema.prisma:L6387`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13258`
- `OtpChallenge` → `schema.prisma:L7863`
- `OvertimeApproval` → `schema.prisma:L3509`
- `PartnerAPIKey` → `schema.prisma:L6185`
- `Payment` → `schema.prisma:L4283`
- `PaymentAllocation` → `schema.prisma:L4556`
- `PaymentEffect` → `schema.prisma:L18134`
- `PaymentLink` → `schema.prisma:L14852`
- `PaymentLinkAttribution` → `schema.prisma:L14960`
- `PaymentLinkItem` → `schema.prisma:L14915`
- `PaymentLinkItemModifier` → `schema.prisma:L14942`
- `PaymentProvider` → `schema.prisma:L5740`
- `PayrollLine` → `schema.prisma:L17268`
- `PayrollRun` → `schema.prisma:L17237`
- `PerformanceGoal` → `schema.prisma:L13212`
- `PermissionOverride` → `schema.prisma:L1407`
- `PermissionSet` → `schema.prisma:L1430`
- `PlatformAnnouncement` → `schema.prisma:L17924`
- `PlatformAnnouncementClick` → `schema.prisma:L17989`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18026`
- `PlatformCfdi` → `schema.prisma:L17553`
- `PlatformEmisor` → `schema.prisma:L17493`
- `PlatformSettings` → `schema.prisma:L6162`
- `PosCommand` → `schema.prisma:L9141`
- `PosConnectionStatus` → `schema.prisma:L953`
- `PosSyncIntent` → `schema.prisma:L17631`
- `PricingPolicy` → `schema.prisma:L2764`
- `Printer` → `schema.prisma:L15439`
- `PrintGateway` → `schema.prisma:L15496`
- `PrintJob` → `schema.prisma:L16215`
- `PrintStation` → `schema.prisma:L15514`
- `PrivacyNoticeVersion` → `schema.prisma:L7611`
- `ProcessedStripeEvent` → `schema.prisma:L6799`
- `ProcessorReliabilityMetric` → `schema.prisma:L7284`
- `Product` → `schema.prisma:L1754`
- `ProductModifierGroup` → `schema.prisma:L4220`
- `ProductOption` → `schema.prisma:L15158`
- `ProductOptionValue` → `schema.prisma:L15169`
- `ProductStaff` → `schema.prisma:L14087`
- `PromoterBankAccount` → `schema.prisma:L17388`
- `PromoterCommissionEntry` → `schema.prisma:L17407`
- `PromoterLocationPing` → `schema.prisma:L3697`
- `Promotion` → `schema.prisma:L17682`
- `PromotionGroup` → `schema.prisma:L17721`
- `PromotionOption` → `schema.prisma:L17737`
- `ProviderCostStructure` → `schema.prisma:L6835`
- `ProviderEventLog` → `schema.prisma:L6464`
- `PurchaseOrder` → `schema.prisma:L2489`
- `PurchaseOrderInvoice` → `schema.prisma:L2634`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2691`
- `PurchaseOrderItem` → `schema.prisma:L2547`
- `RateCorrectionBatch` → `schema.prisma:L7060`
- `RateCorrectionEntry` → `schema.prisma:L7102`
- `RawMaterial` → `schema.prisma:L2245`
- `RawMaterialMovement` → `schema.prisma:L2817`
- `RawMaterialPresentation` → `schema.prisma:L2321`
- `ReceiptLayout` → `schema.prisma:L18168`
- `Recipe` → `schema.prisma:L2341`
- `RecipeLine` → `schema.prisma:L2365`
- `Referral` → `schema.prisma:L8329`
- `ReferralProgramConfig` → `schema.prisma:L8294`
- `ReferralRewardGrant` → `schema.prisma:L8420`
- `ReferralTierReward` → `schema.prisma:L8392`
- `ReferralTierUnlock` → `schema.prisma:L8465`
- `RefreshGrant` → `schema.prisma:L18113`
- `Reservation` → `schema.prisma:L13855`
- `ReservationGoogleEventMapping` → `schema.prisma:L14625`
- `ReservationModifier` → `schema.prisma:L14035`
- `ReservationReminderSent` → `schema.prisma:L14018`
- `ReservationSettings` → `schema.prisma:L14249`
- `ReservationWaitlistEntry` → `schema.prisma:L14217`
- `Review` → `schema.prisma:L5117`
- `SalesRetention` → `schema.prisma:L17088`
- `SaleVerification` → `schema.prisma:L4610`
- `ScaleProfile` → `schema.prisma:L15956`
- `ScheduledCommand` → `schema.prisma:L10686`
- `SerializedItem` → `schema.prisma:L12336`
- `SerializedItemCustodyEvent` → `schema.prisma:L12503`
- `ServiceCharge` → `schema.prisma:L8929`
- `Session` → `schema.prisma:L18092`
- `SettlementConfiguration` → `schema.prisma:L7135`
- `SettlementConfirmation` → `schema.prisma:L7248`
- `SettlementIncident` → `schema.prisma:L7199`
- `SettlementSimulation` → `schema.prisma:L7170`
- `Shift` → `schema.prisma:L3320`
- `SimRegistrationRequest` → `schema.prisma:L12541`
- `SimRegistrationRequestItem` → `schema.prisma:L12563`
- `SlotHold` → `schema.prisma:L14118`
- `Staff` → `schema.prisma:L973`
- `StaffDocument` → `schema.prisma:L3568`
- `StaffOnboardingState` → `schema.prisma:L16286`
- `StaffOrganization` → `schema.prisma:L1306`
- `StaffPasskey` → `schema.prisma:L1333`
- `StaffSchedule` → `schema.prisma:L14058`
- `StaffScheduleException` → `schema.prisma:L14070`
- `StaffVenue` → `schema.prisma:L1230`
- `StaffWorkSchedule` → `schema.prisma:L3445`
- `StaffWorkScheduleException` → `schema.prisma:L3543`
- `StampCard` → `schema.prisma:L8177`
- `StampEvent` → `schema.prisma:L8216`
- `StampReward` → `schema.prisma:L8254`
- `StockAlertConfig` → `schema.prisma:L13194`
- `StockBatch` → `schema.prisma:L2983`
- `StockCount` → `schema.prisma:L2900`
- `StockCountItem` → `schema.prisma:L2928`
- `StripeWebhookEvent` → `schema.prisma:L6782`
- `Supplier` → `schema.prisma:L2400`
- `SupplierItemCode` → `schema.prisma:L2732`
- `SupplierPricing` → `schema.prisma:L2455`
- `Table` → `schema.prisma:L3232`
- `Terminal` → `schema.prisma:L5168`
- `TerminalAttemptResolution` → `schema.prisma:L5599`
- `TerminalHealth` → `schema.prisma:L5419`
- `TerminalLog` → `schema.prisma:L5393`
- `TerminalOrder` → `schema.prisma:L5643`
- `TerminalOrderItem` → `schema.prisma:L5718`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5571`
- `TerminalPaymentRequest` → `schema.prisma:L5490`
- `TimeEntry` → `schema.prisma:L3610`
- `TimeEntryBreak` → `schema.prisma:L3679`
- `TokenPurchase` → `schema.prisma:L10360`
- `TokenUsageRecord` → `schema.prisma:L10332`
- `TpvCommandHistory` → `schema.prisma:L10592`
- `TpvCommandQueue` → `schema.prisma:L10532`
- `TpvFeedback` → `schema.prisma:L10245`
- `TpvMessage` → `schema.prisma:L13551`
- `TpvMessageDelivery` → `schema.prisma:L13603`
- `TpvMessageResponse` → `schema.prisma:L13626`
- `TrainingModule` → `schema.prisma:L13681`
- `TrainingProgress` → `schema.prisma:L13758`
- `TrainingQuizQuestion` → `schema.prisma:L13740`
- `TrainingStep` → `schema.prisma:L13720`
- `TransactionCost` → `schema.prisma:L6998`
- `UnitConversion` → `schema.prisma:L2795`
- `UpsellAcceptance` → `schema.prisma:L8750`
- `UpsellAiRun` → `schema.prisma:L8770`
- `UpsellImpression` → `schema.prisma:L8710`
- `UpsellRule` → `schema.prisma:L8630`
- `user_sessions` → `schema.prisma:L6220`
- `Venue` → `schema.prisma:L163`
- `VenueAreaTicketSettings` → `schema.prisma:L15693`
- `VenueChatMessage` → `schema.prisma:L803`
- `VenueChatSession` → `schema.prisma:L758`
- `VenueCommission` → `schema.prisma:L15319`
- `VenueCreditAssessment` → `schema.prisma:L11074`
- `VenueCryptoConfig` → `schema.prisma:L13418`
- `VenueFeature` → `schema.prisma:L4724`
- `VenueModule` → `schema.prisma:L11234`
- `VenuePaymentConfig` → `schema.prisma:L6321`
- `VenuePaymentLinkSettings` → `schema.prisma:L14658`
- `VenuePricingStructure` → `schema.prisma:L6938`
- `VenueRoleConfig` → `schema.prisma:L1459`
- `VenueRolePermission` → `schema.prisma:L1363`
- `VenueScaleSettings` → `schema.prisma:L15944`
- `VenueSettings` → `schema.prisma:L843`
- `VenueTenderType` → `schema.prisma:L4469`
- `VenueTenderTypeRevision` → `schema.prisma:L4534`
- `VenueTransaction` → `schema.prisma:L4661`
- `VenueWhatsappActivation` → `schema.prisma:L694`
- `WalletCardDesign` → `schema.prisma:L8095`
- `WalletPass` → `schema.prisma:L7996`
- `WalletPassRegistration` → `schema.prisma:L8062`
- `WebhookEvent` → `schema.prisma:L5026`
- `WebhookSubscription` → `schema.prisma:L6437`
- `WhatsappContactWindow` → `schema.prisma:L712`
- `WhatsappInboundEvent` → `schema.prisma:L732`
- `WorkShiftAssignment` → `schema.prisma:L3485`
- `WorkShiftTemplate` → `schema.prisma:L3462`
- `Zone` → `schema.prisma:L146`
