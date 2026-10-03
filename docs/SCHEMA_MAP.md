# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **396 models / 363 enums / ~18,600 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CfdiGlobalOrden`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `OrderItemSelloIva`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                                                                                                |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `ClassSessionPayState`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `ServicePayTable`, `ServicePayTableCell`, `ServicePayTableVersion`, `StaffPayLevel`, `StaffPayLevelAssignment`, `VenueCommission`                                                                                                                                                                                                                                                                                                           |
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

- `AccountingPeriodLock` → `schema.prisma:L17109`
- `AccountMapping` → `schema.prisma:L17004`
- `ActivityLog` → `schema.prisma:L7481`
- `Aggregator` → `schema.prisma:L15280`
- `AngelPayUserAccount` → `schema.prisma:L6026`
- `AppUpdate` → `schema.prisma:L13444`
- `Area` → `schema.prisma:L3249`
- `AreaTicket` → `schema.prisma:L15816`
- `AreaTicketCheckoutSession` → `schema.prisma:L15938`
- `AreaTicketExternalIncident` → `schema.prisma:L16185`
- `AreaTicketExternalSettlement` → `schema.prisma:L16150`
- `AreaTicketFulfillment` → `schema.prisma:L16014`
- `AreaTicketInventoryReservation` → `schema.prisma:L15909`
- `AreaTicketLine` → `schema.prisma:L15877`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15970`
- `AreaTicketPrintAttempt` → `schema.prisma:L15993`
- `BankStatement` → `schema.prisma:L16878`
- `BankStatementLine` → `schema.prisma:L16899`
- `BillingObligationConflict` → `schema.prisma:L5056`
- `BillingTaxProfile` → `schema.prisma:L17701`
- `BirthdayAutomation` → `schema.prisma:L7802`
- `BulkCommandOperation` → `schema.prisma:L10724`
- `CalendarSyncOutbox` → `schema.prisma:L14652`
- `CampaignDelivery` → `schema.prisma:L13602`
- `CapabilityGrant` → `schema.prisma:L4832`
- `CashCloseout` → `schema.prisma:L11109`
- `CashDeposit` → `schema.prisma:L13246`
- `CashDrawerEvent` → `schema.prisma:L15117`
- `CashDrawerSession` → `schema.prisma:L15078`
- `CashOutCommissionRate` → `schema.prisma:L17518`
- `CashOutScheduleDay` → `schema.prisma:L17541`
- `CashOutWithdrawal` → `schema.prisma:L17603`
- `CatalogBindingBatch` → `schema.prisma:L12140`
- `CatalogBindingLine` → `schema.prisma:L12176`
- `CatalogBrand` → `schema.prisma:L11593`
- `CatalogClientObservation` → `schema.prisma:L11906`
- `CatalogClientReadinessOverride` → `schema.prisma:L11925`
- `CatalogFamily` → `schema.prisma:L11643`
- `CatalogIdempotencyRecord` → `schema.prisma:L12039`
- `CatalogIdentifier` → `schema.prisma:L11774`
- `CatalogImportBatch` → `schema.prisma:L12082`
- `CatalogImportLine` → `schema.prisma:L12119`
- `CatalogItem` → `schema.prisma:L11676`
- `CatalogItemBusinessType` → `schema.prisma:L11736`
- `CatalogItemPrice` → `schema.prisma:L11824`
- `CatalogManufacturer` → `schema.prisma:L11617`
- `CatalogProductTypeMapping` → `schema.prisma:L11753`
- `CatalogPublicationBatch` → `schema.prisma:L12204`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12298`
- `CatalogPublicationLine` → `schema.prisma:L12245`
- `CatalogPublicationOutbox` → `schema.prisma:L12341`
- `CatalogValidationProfile` → `schema.prisma:L11795`
- `CatalogVenueBinding` → `schema.prisma:L11953`
- `CatalogVenueClientRequirement` → `schema.prisma:L11880`
- `CatalogVenueEventSequence` → `schema.prisma:L12324`
- `CatalogVenueOverride` → `schema.prisma:L11995`
- `CatalogVenueRollout` → `schema.prisma:L11855`
- `Cfdi` → `schema.prisma:L16706`
- `CfdiGlobalOrden` → `schema.prisma:L16831`
- `ChatbotTokenBudget` → `schema.prisma:L10370`
- `ChatConversation` → `schema.prisma:L10225`
- `ChatFeedback` → `schema.prisma:L10311`
- `ChatLearningEvent` → `schema.prisma:L10268`
- `ChatMessage` → `schema.prisma:L10248`
- `ChatTrainingData` → `schema.prisma:L10182`
- `CheckoutSession` → `schema.prisma:L6306`
- `ClassSession` → `schema.prisma:L14255`
- `ClassSessionPayState` → `schema.prisma:L18655`
- `CommissionCalculation` → `schema.prisma:L13022`
- `CommissionClawback` → `schema.prisma:L13198`
- `CommissionConfig` → `schema.prisma:L12788`
- `CommissionMilestone` → `schema.prisma:L12938`
- `CommissionOverride` → `schema.prisma:L12865`
- `CommissionPayout` → `schema.prisma:L13149`
- `CommissionSummary` → `schema.prisma:L13088`
- `CommissionTier` → `schema.prisma:L12902`
- `ConsentEvent` → `schema.prisma:L7664`
- `Consumer` → `schema.prisma:L7894`
- `ConsumerAuthAccount` → `schema.prisma:L7919`
- `CouponCode` → `schema.prisma:L8866`
- `CouponRedemption` → `schema.prisma:L8897`
- `CreditAssessmentHistory` → `schema.prisma:L11218`
- `CreditItemBalance` → `schema.prisma:L14868`
- `CreditOffer` → `schema.prisma:L11237`
- `CreditPack` → `schema.prisma:L14777`
- `CreditPackItem` → `schema.prisma:L14806`
- `CreditPackPurchase` → `schema.prisma:L14823`
- `CreditTransaction` → `schema.prisma:L14890`
- `Customer` → `schema.prisma:L7522`
- `CustomerApprovalDelivery` → `schema.prisma:L9884`
- `CustomerApprovalOutbox` → `schema.prisma:L9859`
- `CustomerCampaign` → `schema.prisma:L7752`
- `CustomerCampaignDelivery` → `schema.prisma:L7834`
- `CustomerCaptureToken` → `schema.prisma:L7700`
- `CustomerDiscount` → `schema.prisma:L8917`
- `CustomerGroup` → `schema.prisma:L7958`
- `CustomerOrderMetric` → `schema.prisma:L4048`
- `CustomerTaxProfile` → `schema.prisma:L16850`
- `DeliveryActivationRequest` → `schema.prisma:L6765`
- `DeliveryChannelLink` → `schema.prisma:L6604`
- `DeliveryConnectIntent` → `schema.prisma:L6716`
- `DeliveryLineAction` → `schema.prisma:L6677`
- `DeliveryOrderEvent` → `schema.prisma:L6789`
- `DeliveryStoreRevocation` → `schema.prisma:L6753`
- `DeviceToken` → `schema.prisma:L9186`
- `DigitalReceipt` → `schema.prisma:L4645`
- `Discount` → `schema.prisma:L8556`
- `EcommerceMerchant` → `schema.prisma:L6118`
- `EmailQuotaLedger` → `schema.prisma:L7881`
- `EmailSuppression` → `schema.prisma:L7869`
- `EmailTemplate` → `schema.prisma:L13541`
- `Employee` → `schema.prisma:L17366`
- `Estimate` → `schema.prisma:L15187`
- `EstimateItem` → `schema.prisma:L15215`
- `Expense` → `schema.prisma:L17153`
- `ExternalBusyBlock` → `schema.prisma:L14545`
- `Feature` → `schema.prisma:L4774`
- `FeeSchedule` → `schema.prisma:L5118`
- `FeeTier` → `schema.prisma:L5129`
- `FinancialAccount` → `schema.prisma:L15377`
- `FinancialConnection` → `schema.prisma:L15346`
- `FinancialProvider` → `schema.prisma:L15332`
- `FiscalEmisor` → `schema.prisma:L16622`
- `FiscalLossCarryforward` → `schema.prisma:L17276`
- `FixedAsset` → `schema.prisma:L17294`
- `FixedAssetDepreciation` → `schema.prisma:L17323`
- `FloorElement` → `schema.prisma:L3325`
- `FulfillmentArea` → `schema.prisma:L15681`
- `GeofenceRule` → `schema.prisma:L10809`
- `GoogleCalendarChannel` → `schema.prisma:L14522`
- `GoogleCalendarConnection` → `schema.prisma:L14474`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14575`
- `GoogleOAuthSession` → `schema.prisma:L14597`
- `HolidayCalendar` → `schema.prisma:L7405`
- `HybridBillingOperation` → `schema.prisma:L4980`
- `HybridCampaign` → `schema.prisma:L4857`
- `HybridContract` → `schema.prisma:L4937`
- `HybridContractSelection` → `schema.prisma:L4969`
- `HybridCreditAllocation` → `schema.prisma:L5036`
- `HybridOfferPublication` → `schema.prisma:L4884`
- `HybridPaymentPeriod` → `schema.prisma:L5015`
- `HybridPurchase` → `schema.prisma:L4904`
- `HybridRedemption` → `schema.prisma:L4998`
- `IdempotencyRequest` → `schema.prisma:L12663`
- `InterVenueTransfer` → `schema.prisma:L3077`
- `InterVenueTransferAllocation` → `schema.prisma:L3160`
- `InterVenueTransferItem` → `schema.prisma:L3129`
- `InterVenueTransferReceipt` → `schema.prisma:L3187`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3203`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3231`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3215`
- `Inventory` → `schema.prisma:L2021`
- `InventoryMovement` → `schema.prisma:L2121`
- `InventoryPosting` → `schema.prisma:L2216`
- `InventoryPostingLine` → `schema.prisma:L2256`
- `InventoryTransfer` → `schema.prisma:L15159`
- `InventoryWasteReport` → `schema.prisma:L2076`
- `Invitation` → `schema.prisma:L1518`
- `Invoice` → `schema.prisma:L5141`
- `InvoiceItem` → `schema.prisma:L5167`
- `ItemCategory` → `schema.prisma:L12376`
- `JournalEntry` → `schema.prisma:L17062`
- `JournalLine` → `schema.prisma:L17091`
- `KdsOrder` → `schema.prisma:L15425`
- `KdsOrderItem` → `schema.prisma:L15488`
- `KioskCheckInAttempt` → `schema.prisma:L18024`
- `KioskCheckInChallenge` → `schema.prisma:L17978`
- `KioskOutreachOutbox` → `schema.prisma:L18045`
- `LaunchCampaign` → `schema.prisma:L18383`
- `LaunchCampaignRedemption` → `schema.prisma:L18500`
- `LearnedPatterns` → `schema.prisma:L10292`
- `LedgerAccount` → `schema.prisma:L16954`
- `LiveDemoSession` → `schema.prisma:L843`
- `LowStockAlert` → `schema.prisma:L2911`
- `LoyaltyConfig` → `schema.prisma:L7988`
- `LoyaltyTransaction` → `schema.prisma:L8031`
- `MarketingCampaign` → `schema.prisma:L13559`
- `McpAuthCode` → `schema.prisma:L16504`
- `McpOAuthClient` → `schema.prisma:L16488`
- `McpRefreshToken` → `schema.prisma:L16522`
- `McpToolCall` → `schema.prisma:L16544`
- `MeasurementUnit` → `schema.prisma:L15265`
- `Menu` → `schema.prisma:L1736`
- `MenuCategory` → `schema.prisma:L1673`
- `MenuCategoryAssignment` → `schema.prisma:L1771`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16418`
- `MerchantAccount` → `schema.prisma:L5856`
- `MerchantFiscalConfig` → `schema.prisma:L16677`
- `MerchantRevenueShare` → `schema.prisma:L6985`
- `MerchantRoutingRule` → `schema.prisma:L5978`
- `MilestoneAchievement` → `schema.prisma:L12983`
- `Modifier` → `schema.prisma:L4247`
- `ModifierGroup` → `schema.prisma:L4211`
- `Module` → `schema.prisma:L11285`
- `MoneyAnomaly` → `schema.prisma:L6888`
- `MonthlyVenueProfit` → `schema.prisma:L7431`
- `Notification` → `schema.prisma:L9088`
- `NotificationPreference` → `schema.prisma:L9135`
- `NotificationTemplate` → `schema.prisma:L9162`
- `OAuthState` → `schema.prisma:L1569`
- `OnboardingProgress` → `schema.prisma:L1587`
- `Order` → `schema.prisma:L3774`
- `OrderAction` → `schema.prisma:L4318`
- `OrderCustomer` → `schema.prisma:L4027`
- `OrderDiscount` → `schema.prisma:L8949`
- `OrderFulfillment` → `schema.prisma:L15736`
- `OrderFulfillmentLine` → `schema.prisma:L15767`
- `OrderItem` → `schema.prisma:L4063`
- `OrderItemModifier` → `schema.prisma:L4300`
- `OrderItemSelloIva` → `schema.prisma:L16811`
- `OrderPromotion` → `schema.prisma:L17941`
- `OrderServiceCharge` → `schema.prisma:L9033`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13360`
- `OrganizationEntitlement` → `schema.prisma:L11568`
- `OrganizationGoal` → `schema.prisma:L13318`
- `OrganizationModule` → `schema.prisma:L11345`
- `OrganizationPaymentConfig` → `schema.prisma:L6430`
- `OrganizationPayoutConfig` → `schema.prisma:L13393`
- `OrganizationPricingStructure` → `schema.prisma:L6462`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13341`
- `OtpChallenge` → `schema.prisma:L7938`
- `OvertimeApproval` → `schema.prisma:L3552`
- `PartnerAPIKey` → `schema.prisma:L6260`
- `Payment` → `schema.prisma:L4351`
- `PaymentAllocation` → `schema.prisma:L4624`
- `PaymentEffect` → `schema.prisma:L18315`
- `PaymentLink` → `schema.prisma:L14936`
- `PaymentLinkAttribution` → `schema.prisma:L15044`
- `PaymentLinkItem` → `schema.prisma:L14999`
- `PaymentLinkItemModifier` → `schema.prisma:L15026`
- `PaymentProvider` → `schema.prisma:L5815`
- `PayrollLine` → `schema.prisma:L17437`
- `PayrollRun` → `schema.prisma:L17406`
- `PerformanceGoal` → `schema.prisma:L13295`
- `PermissionOverride` → `schema.prisma:L1442`
- `PermissionSet` → `schema.prisma:L1465`
- `PlatformAnnouncement` → `schema.prisma:L18105`
- `PlatformAnnouncementClick` → `schema.prisma:L18170`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18207`
- `PlatformCfdi` → `schema.prisma:L17734`
- `PlatformEmisor` → `schema.prisma:L17674`
- `PlatformSettings` → `schema.prisma:L6237`
- `PosCommand` → `schema.prisma:L9216`
- `PosConnectionStatus` → `schema.prisma:L987`
- `PosSyncIntent` → `schema.prisma:L17812`
- `PricingPolicy` → `schema.prisma:L2807`
- `Printer` → `schema.prisma:L15537`
- `PrintGateway` → `schema.prisma:L15594`
- `PrintJob` → `schema.prisma:L16317`
- `PrintStation` → `schema.prisma:L15612`
- `PrivacyNoticeVersion` → `schema.prisma:L7686`
- `ProcessedStripeEvent` → `schema.prisma:L6874`
- `ProcessorReliabilityMetric` → `schema.prisma:L7359`
- `Product` → `schema.prisma:L1789`
- `ProductModifierGroup` → `schema.prisma:L4288`
- `ProductOption` → `schema.prisma:L15242`
- `ProductOptionValue` → `schema.prisma:L15253`
- `ProductStaff` → `schema.prisma:L14170`
- `PromoterBankAccount` → `schema.prisma:L17557`
- `PromoterCommissionEntry` → `schema.prisma:L17576`
- `PromoterLocationPing` → `schema.prisma:L3740`
- `Promotion` → `schema.prisma:L17863`
- `PromotionGroup` → `schema.prisma:L17902`
- `PromotionOption` → `schema.prisma:L17918`
- `ProviderCostStructure` → `schema.prisma:L6910`
- `ProviderEventLog` → `schema.prisma:L6539`
- `PurchaseOrder` → `schema.prisma:L2532`
- `PurchaseOrderInvoice` → `schema.prisma:L2677`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2734`
- `PurchaseOrderItem` → `schema.prisma:L2590`
- `RateCorrectionBatch` → `schema.prisma:L7135`
- `RateCorrectionEntry` → `schema.prisma:L7177`
- `RawMaterial` → `schema.prisma:L2288`
- `RawMaterialMovement` → `schema.prisma:L2860`
- `RawMaterialPresentation` → `schema.prisma:L2364`
- `ReceiptLayout` → `schema.prisma:L18349`
- `Recipe` → `schema.prisma:L2384`
- `RecipeLine` → `schema.prisma:L2408`
- `Referral` → `schema.prisma:L8404`
- `ReferralProgramConfig` → `schema.prisma:L8369`
- `ReferralRewardGrant` → `schema.prisma:L8495`
- `ReferralTierReward` → `schema.prisma:L8467`
- `ReferralTierUnlock` → `schema.prisma:L8540`
- `RefreshGrant` → `schema.prisma:L18294`
- `Reservation` → `schema.prisma:L13938`
- `ReservationGoogleEventMapping` → `schema.prisma:L14709`
- `ReservationModifier` → `schema.prisma:L14118`
- `ReservationReminderSent` → `schema.prisma:L14101`
- `ReservationSettings` → `schema.prisma:L14333`
- `ReservationWaitlistEntry` → `schema.prisma:L14301`
- `Review` → `schema.prisma:L5185`
- `SalesRetention` → `schema.prisma:L17257`
- `SaleVerification` → `schema.prisma:L4678`
- `ScaleProfile` → `schema.prisma:L16058`
- `ScheduledCommand` → `schema.prisma:L10769`
- `SerializedItem` → `schema.prisma:L12419`
- `SerializedItemCustodyEvent` → `schema.prisma:L12586`
- `ServiceCharge` → `schema.prisma:L9004`
- `ServicePayTable` → `schema.prisma:L18607`
- `ServicePayTableCell` → `schema.prisma:L18643`
- `ServicePayTableVersion` → `schema.prisma:L18624`
- `Session` → `schema.prisma:L18273`
- `SettlementConfiguration` → `schema.prisma:L7210`
- `SettlementConfirmation` → `schema.prisma:L7323`
- `SettlementIncident` → `schema.prisma:L7274`
- `SettlementSimulation` → `schema.prisma:L7245`
- `Shift` → `schema.prisma:L3363`
- `SimRegistrationRequest` → `schema.prisma:L12624`
- `SimRegistrationRequestItem` → `schema.prisma:L12646`
- `SlotHold` → `schema.prisma:L14201`
- `Staff` → `schema.prisma:L1007`
- `StaffDocument` → `schema.prisma:L3611`
- `StaffOnboardingState` → `schema.prisma:L16388`
- `StaffOrganization` → `schema.prisma:L1341`
- `StaffPasskey` → `schema.prisma:L1368`
- `StaffPayLevel` → `schema.prisma:L18571`
- `StaffPayLevelAssignment` → `schema.prisma:L18589`
- `StaffSchedule` → `schema.prisma:L14141`
- `StaffScheduleException` → `schema.prisma:L14153`
- `StaffVenue` → `schema.prisma:L1265`
- `StaffWorkSchedule` → `schema.prisma:L3488`
- `StaffWorkScheduleException` → `schema.prisma:L3586`
- `StampCard` → `schema.prisma:L8252`
- `StampEvent` → `schema.prisma:L8291`
- `StampReward` → `schema.prisma:L8329`
- `StockAlertConfig` → `schema.prisma:L13277`
- `StockBatch` → `schema.prisma:L3026`
- `StockCount` → `schema.prisma:L2943`
- `StockCountItem` → `schema.prisma:L2971`
- `StripeWebhookEvent` → `schema.prisma:L6857`
- `Supplier` → `schema.prisma:L2443`
- `SupplierItemCode` → `schema.prisma:L2775`
- `SupplierPricing` → `schema.prisma:L2498`
- `Table` → `schema.prisma:L3275`
- `Terminal` → `schema.prisma:L5236`
- `TerminalAttemptResolution` → `schema.prisma:L5674`
- `TerminalHealth` → `schema.prisma:L5494`
- `TerminalLog` → `schema.prisma:L5468`
- `TerminalOrder` → `schema.prisma:L5718`
- `TerminalOrderItem` → `schema.prisma:L5793`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5646`
- `TerminalPaymentRequest` → `schema.prisma:L5565`
- `TimeEntry` → `schema.prisma:L3653`
- `TimeEntryBreak` → `schema.prisma:L3722`
- `TokenPurchase` → `schema.prisma:L10441`
- `TokenUsageRecord` → `schema.prisma:L10413`
- `TpvCommandHistory` → `schema.prisma:L10675`
- `TpvCommandQueue` → `schema.prisma:L10613`
- `TpvFeedback` → `schema.prisma:L10326`
- `TpvMessage` → `schema.prisma:L13634`
- `TpvMessageDelivery` → `schema.prisma:L13686`
- `TpvMessageResponse` → `schema.prisma:L13709`
- `TrainingModule` → `schema.prisma:L13764`
- `TrainingProgress` → `schema.prisma:L13841`
- `TrainingQuizQuestion` → `schema.prisma:L13823`
- `TrainingStep` → `schema.prisma:L13803`
- `TransactionCost` → `schema.prisma:L7073`
- `UnitConversion` → `schema.prisma:L2838`
- `UpsellAcceptance` → `schema.prisma:L8825`
- `UpsellAiRun` → `schema.prisma:L8845`
- `UpsellImpression` → `schema.prisma:L8785`
- `UpsellRule` → `schema.prisma:L8705`
- `user_sessions` → `schema.prisma:L6295`
- `Venue` → `schema.prisma:L172`
- `VenueAreaTicketSettings` → `schema.prisma:L15795`
- `VenueChatMessage` → `schema.prisma:L819`
- `VenueChatSession` → `schema.prisma:L774`
- `VenueCommission` → `schema.prisma:L15403`
- `VenueCreditAssessment` → `schema.prisma:L11157`
- `VenueCryptoConfig` → `schema.prisma:L13501`
- `VenueFeature` → `schema.prisma:L4792`
- `VenueIvaPorProducto` → `schema.prisma:L970`
- `VenueModule` → `schema.prisma:L11317`
- `VenuePaymentConfig` → `schema.prisma:L6396`
- `VenuePaymentLinkSettings` → `schema.prisma:L14742`
- `VenuePosSinAparato` → `schema.prisma:L981`
- `VenuePricingStructure` → `schema.prisma:L7013`
- `VenueRoleConfig` → `schema.prisma:L1494`
- `VenueRolePermission` → `schema.prisma:L1398`
- `VenueScaleSettings` → `schema.prisma:L16046`
- `VenueSettings` → `schema.prisma:L859`
- `VenueTenderType` → `schema.prisma:L4537`
- `VenueTenderTypeRevision` → `schema.prisma:L4602`
- `VenueTransaction` → `schema.prisma:L4729`
- `VenueWhatsappActivation` → `schema.prisma:L710`
- `WalletCardDesign` → `schema.prisma:L8170`
- `WalletPass` → `schema.prisma:L8071`
- `WalletPassRegistration` → `schema.prisma:L8137`
- `WebhookEvent` → `schema.prisma:L5094`
- `WebhookSubscription` → `schema.prisma:L6512`
- `WhatsappContactWindow` → `schema.prisma:L728`
- `WhatsappInboundEvent` → `schema.prisma:L748`
- `WorkShiftAssignment` → `schema.prisma:L3528`
- `WorkShiftTemplate` → `schema.prisma:L3505`
- `Zone` → `schema.prisma:L155`
