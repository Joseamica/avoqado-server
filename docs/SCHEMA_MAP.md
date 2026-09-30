# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **389 models / 360 enums / ~18,500 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueIvaPorProducto`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
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

- `AccountingPeriodLock` → `schema.prisma:L17074`
- `AccountMapping` → `schema.prisma:L16969`
- `ActivityLog` → `schema.prisma:L7450`
- `Aggregator` → `schema.prisma:L15246`
- `AngelPayUserAccount` → `schema.prisma:L5995`
- `AppUpdate` → `schema.prisma:L13411`
- `Area` → `schema.prisma:L3229`
- `AreaTicket` → `schema.prisma:L15782`
- `AreaTicketCheckoutSession` → `schema.prisma:L15904`
- `AreaTicketExternalIncident` → `schema.prisma:L16151`
- `AreaTicketExternalSettlement` → `schema.prisma:L16116`
- `AreaTicketFulfillment` → `schema.prisma:L15980`
- `AreaTicketInventoryReservation` → `schema.prisma:L15875`
- `AreaTicketLine` → `schema.prisma:L15843`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15936`
- `AreaTicketPrintAttempt` → `schema.prisma:L15959`
- `BankStatement` → `schema.prisma:L16843`
- `BankStatementLine` → `schema.prisma:L16864`
- `BillingObligationConflict` → `schema.prisma:L5032`
- `BillingTaxProfile` → `schema.prisma:L17666`
- `BirthdayAutomation` → `schema.prisma:L7771`
- `BulkCommandOperation` → `schema.prisma:L10691`
- `CalendarSyncOutbox` → `schema.prisma:L14618`
- `CampaignDelivery` → `schema.prisma:L13569`
- `CapabilityGrant` → `schema.prisma:L4808`
- `CashCloseout` → `schema.prisma:L11076`
- `CashDeposit` → `schema.prisma:L13213`
- `CashDrawerEvent` → `schema.prisma:L15083`
- `CashDrawerSession` → `schema.prisma:L15044`
- `CashOutCommissionRate` → `schema.prisma:L17483`
- `CashOutScheduleDay` → `schema.prisma:L17506`
- `CashOutWithdrawal` → `schema.prisma:L17568`
- `CatalogBindingBatch` → `schema.prisma:L12107`
- `CatalogBindingLine` → `schema.prisma:L12143`
- `CatalogBrand` → `schema.prisma:L11560`
- `CatalogClientObservation` → `schema.prisma:L11873`
- `CatalogClientReadinessOverride` → `schema.prisma:L11892`
- `CatalogFamily` → `schema.prisma:L11610`
- `CatalogIdempotencyRecord` → `schema.prisma:L12006`
- `CatalogIdentifier` → `schema.prisma:L11741`
- `CatalogImportBatch` → `schema.prisma:L12049`
- `CatalogImportLine` → `schema.prisma:L12086`
- `CatalogItem` → `schema.prisma:L11643`
- `CatalogItemBusinessType` → `schema.prisma:L11703`
- `CatalogItemPrice` → `schema.prisma:L11791`
- `CatalogManufacturer` → `schema.prisma:L11584`
- `CatalogProductTypeMapping` → `schema.prisma:L11720`
- `CatalogPublicationBatch` → `schema.prisma:L12171`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12265`
- `CatalogPublicationLine` → `schema.prisma:L12212`
- `CatalogPublicationOutbox` → `schema.prisma:L12308`
- `CatalogValidationProfile` → `schema.prisma:L11762`
- `CatalogVenueBinding` → `schema.prisma:L11920`
- `CatalogVenueClientRequirement` → `schema.prisma:L11847`
- `CatalogVenueEventSequence` → `schema.prisma:L12291`
- `CatalogVenueOverride` → `schema.prisma:L11962`
- `CatalogVenueRollout` → `schema.prisma:L11822`
- `Cfdi` → `schema.prisma:L16671`
- `CfdiGlobalOrden` → `schema.prisma:L16796`
- `ChatbotTokenBudget` → `schema.prisma:L10339`
- `ChatConversation` → `schema.prisma:L10194`
- `ChatFeedback` → `schema.prisma:L10280`
- `ChatLearningEvent` → `schema.prisma:L10237`
- `ChatMessage` → `schema.prisma:L10217`
- `ChatTrainingData` → `schema.prisma:L10151`
- `CheckoutSession` → `schema.prisma:L6275`
- `ClassSession` → `schema.prisma:L14222`
- `CommissionCalculation` → `schema.prisma:L12989`
- `CommissionClawback` → `schema.prisma:L13165`
- `CommissionConfig` → `schema.prisma:L12755`
- `CommissionMilestone` → `schema.prisma:L12905`
- `CommissionOverride` → `schema.prisma:L12832`
- `CommissionPayout` → `schema.prisma:L13116`
- `CommissionSummary` → `schema.prisma:L13055`
- `CommissionTier` → `schema.prisma:L12869`
- `ConsentEvent` → `schema.prisma:L7633`
- `Consumer` → `schema.prisma:L7863`
- `ConsumerAuthAccount` → `schema.prisma:L7888`
- `CouponCode` → `schema.prisma:L8835`
- `CouponRedemption` → `schema.prisma:L8866`
- `CreditAssessmentHistory` → `schema.prisma:L11185`
- `CreditItemBalance` → `schema.prisma:L14834`
- `CreditOffer` → `schema.prisma:L11204`
- `CreditPack` → `schema.prisma:L14743`
- `CreditPackItem` → `schema.prisma:L14772`
- `CreditPackPurchase` → `schema.prisma:L14789`
- `CreditTransaction` → `schema.prisma:L14856`
- `Customer` → `schema.prisma:L7491`
- `CustomerApprovalDelivery` → `schema.prisma:L9853`
- `CustomerApprovalOutbox` → `schema.prisma:L9828`
- `CustomerCampaign` → `schema.prisma:L7721`
- `CustomerCampaignDelivery` → `schema.prisma:L7803`
- `CustomerCaptureToken` → `schema.prisma:L7669`
- `CustomerDiscount` → `schema.prisma:L8886`
- `CustomerGroup` → `schema.prisma:L7927`
- `CustomerOrderMetric` → `schema.prisma:L4028`
- `CustomerTaxProfile` → `schema.prisma:L16815`
- `DeliveryActivationRequest` → `schema.prisma:L6734`
- `DeliveryChannelLink` → `schema.prisma:L6573`
- `DeliveryConnectIntent` → `schema.prisma:L6685`
- `DeliveryLineAction` → `schema.prisma:L6646`
- `DeliveryOrderEvent` → `schema.prisma:L6758`
- `DeliveryStoreRevocation` → `schema.prisma:L6722`
- `DeviceToken` → `schema.prisma:L9155`
- `DigitalReceipt` → `schema.prisma:L4621`
- `Discount` → `schema.prisma:L8525`
- `EcommerceMerchant` → `schema.prisma:L6087`
- `EmailQuotaLedger` → `schema.prisma:L7850`
- `EmailSuppression` → `schema.prisma:L7838`
- `EmailTemplate` → `schema.prisma:L13508`
- `Employee` → `schema.prisma:L17331`
- `Estimate` → `schema.prisma:L15153`
- `EstimateItem` → `schema.prisma:L15181`
- `Expense` → `schema.prisma:L17118`
- `ExternalBusyBlock` → `schema.prisma:L14511`
- `Feature` → `schema.prisma:L4750`
- `FeeSchedule` → `schema.prisma:L5094`
- `FeeTier` → `schema.prisma:L5105`
- `FinancialAccount` → `schema.prisma:L15343`
- `FinancialConnection` → `schema.prisma:L15312`
- `FinancialProvider` → `schema.prisma:L15298`
- `FiscalEmisor` → `schema.prisma:L16587`
- `FiscalLossCarryforward` → `schema.prisma:L17241`
- `FixedAsset` → `schema.prisma:L17259`
- `FixedAssetDepreciation` → `schema.prisma:L17288`
- `FloorElement` → `schema.prisma:L3305`
- `FulfillmentArea` → `schema.prisma:L15647`
- `GeofenceRule` → `schema.prisma:L10776`
- `GoogleCalendarChannel` → `schema.prisma:L14488`
- `GoogleCalendarConnection` → `schema.prisma:L14440`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14541`
- `GoogleOAuthSession` → `schema.prisma:L14563`
- `HolidayCalendar` → `schema.prisma:L7374`
- `HybridBillingOperation` → `schema.prisma:L4956`
- `HybridCampaign` → `schema.prisma:L4833`
- `HybridContract` → `schema.prisma:L4913`
- `HybridContractSelection` → `schema.prisma:L4945`
- `HybridCreditAllocation` → `schema.prisma:L5012`
- `HybridOfferPublication` → `schema.prisma:L4860`
- `HybridPaymentPeriod` → `schema.prisma:L4991`
- `HybridPurchase` → `schema.prisma:L4880`
- `HybridRedemption` → `schema.prisma:L4974`
- `IdempotencyRequest` → `schema.prisma:L12630`
- `InterVenueTransfer` → `schema.prisma:L3057`
- `InterVenueTransferAllocation` → `schema.prisma:L3140`
- `InterVenueTransferItem` → `schema.prisma:L3109`
- `InterVenueTransferReceipt` → `schema.prisma:L3167`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3183`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3211`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3195`
- `Inventory` → `schema.prisma:L2001`
- `InventoryMovement` → `schema.prisma:L2101`
- `InventoryPosting` → `schema.prisma:L2196`
- `InventoryPostingLine` → `schema.prisma:L2236`
- `InventoryTransfer` → `schema.prisma:L15125`
- `InventoryWasteReport` → `schema.prisma:L2056`
- `Invitation` → `schema.prisma:L1498`
- `Invoice` → `schema.prisma:L5117`
- `InvoiceItem` → `schema.prisma:L5143`
- `ItemCategory` → `schema.prisma:L12343`
- `JournalEntry` → `schema.prisma:L17027`
- `JournalLine` → `schema.prisma:L17056`
- `KdsOrder` → `schema.prisma:L15391`
- `KdsOrderItem` → `schema.prisma:L15454`
- `KioskCheckInAttempt` → `schema.prisma:L17989`
- `KioskCheckInChallenge` → `schema.prisma:L17943`
- `KioskOutreachOutbox` → `schema.prisma:L18010`
- `LaunchCampaign` → `schema.prisma:L18348`
- `LaunchCampaignRedemption` → `schema.prisma:L18465`
- `LearnedPatterns` → `schema.prisma:L10261`
- `LedgerAccount` → `schema.prisma:L16919`
- `LiveDemoSession` → `schema.prisma:L834`
- `LowStockAlert` → `schema.prisma:L2891`
- `LoyaltyConfig` → `schema.prisma:L7957`
- `LoyaltyTransaction` → `schema.prisma:L8000`
- `MarketingCampaign` → `schema.prisma:L13526`
- `McpAuthCode` → `schema.prisma:L16470`
- `McpOAuthClient` → `schema.prisma:L16454`
- `McpRefreshToken` → `schema.prisma:L16488`
- `McpToolCall` → `schema.prisma:L16509`
- `MeasurementUnit` → `schema.prisma:L15231`
- `Menu` → `schema.prisma:L1716`
- `MenuCategory` → `schema.prisma:L1653`
- `MenuCategoryAssignment` → `schema.prisma:L1751`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16384`
- `MerchantAccount` → `schema.prisma:L5825`
- `MerchantFiscalConfig` → `schema.prisma:L16642`
- `MerchantRevenueShare` → `schema.prisma:L6954`
- `MerchantRoutingRule` → `schema.prisma:L5947`
- `MilestoneAchievement` → `schema.prisma:L12950`
- `Modifier` → `schema.prisma:L4227`
- `ModifierGroup` → `schema.prisma:L4191`
- `Module` → `schema.prisma:L11252`
- `MoneyAnomaly` → `schema.prisma:L6857`
- `MonthlyVenueProfit` → `schema.prisma:L7400`
- `Notification` → `schema.prisma:L9057`
- `NotificationPreference` → `schema.prisma:L9104`
- `NotificationTemplate` → `schema.prisma:L9131`
- `OAuthState` → `schema.prisma:L1549`
- `OnboardingProgress` → `schema.prisma:L1567`
- `Order` → `schema.prisma:L3754`
- `OrderAction` → `schema.prisma:L4294`
- `OrderCustomer` → `schema.prisma:L4007`
- `OrderDiscount` → `schema.prisma:L8918`
- `OrderFulfillment` → `schema.prisma:L15702`
- `OrderFulfillmentLine` → `schema.prisma:L15733`
- `OrderItem` → `schema.prisma:L4043`
- `OrderItemModifier` → `schema.prisma:L4276`
- `OrderItemSelloIva` → `schema.prisma:L16776`
- `OrderPromotion` → `schema.prisma:L17906`
- `OrderServiceCharge` → `schema.prisma:L9002`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13327`
- `OrganizationEntitlement` → `schema.prisma:L11535`
- `OrganizationGoal` → `schema.prisma:L13285`
- `OrganizationModule` → `schema.prisma:L11312`
- `OrganizationPaymentConfig` → `schema.prisma:L6399`
- `OrganizationPayoutConfig` → `schema.prisma:L13360`
- `OrganizationPricingStructure` → `schema.prisma:L6431`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13308`
- `OtpChallenge` → `schema.prisma:L7907`
- `OvertimeApproval` → `schema.prisma:L3532`
- `PartnerAPIKey` → `schema.prisma:L6229`
- `Payment` → `schema.prisma:L4327`
- `PaymentAllocation` → `schema.prisma:L4600`
- `PaymentEffect` → `schema.prisma:L18280`
- `PaymentLink` → `schema.prisma:L14902`
- `PaymentLinkAttribution` → `schema.prisma:L15010`
- `PaymentLinkItem` → `schema.prisma:L14965`
- `PaymentLinkItemModifier` → `schema.prisma:L14992`
- `PaymentProvider` → `schema.prisma:L5784`
- `PayrollLine` → `schema.prisma:L17402`
- `PayrollRun` → `schema.prisma:L17371`
- `PerformanceGoal` → `schema.prisma:L13262`
- `PermissionOverride` → `schema.prisma:L1422`
- `PermissionSet` → `schema.prisma:L1445`
- `PlatformAnnouncement` → `schema.prisma:L18070`
- `PlatformAnnouncementClick` → `schema.prisma:L18135`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18172`
- `PlatformCfdi` → `schema.prisma:L17699`
- `PlatformEmisor` → `schema.prisma:L17639`
- `PlatformSettings` → `schema.prisma:L6206`
- `PosCommand` → `schema.prisma:L9185`
- `PosConnectionStatus` → `schema.prisma:L968`
- `PosSyncIntent` → `schema.prisma:L17777`
- `PricingPolicy` → `schema.prisma:L2787`
- `Printer` → `schema.prisma:L15503`
- `PrintGateway` → `schema.prisma:L15560`
- `PrintJob` → `schema.prisma:L16283`
- `PrintStation` → `schema.prisma:L15578`
- `PrivacyNoticeVersion` → `schema.prisma:L7655`
- `ProcessedStripeEvent` → `schema.prisma:L6843`
- `ProcessorReliabilityMetric` → `schema.prisma:L7328`
- `Product` → `schema.prisma:L1769`
- `ProductModifierGroup` → `schema.prisma:L4264`
- `ProductOption` → `schema.prisma:L15208`
- `ProductOptionValue` → `schema.prisma:L15219`
- `ProductStaff` → `schema.prisma:L14137`
- `PromoterBankAccount` → `schema.prisma:L17522`
- `PromoterCommissionEntry` → `schema.prisma:L17541`
- `PromoterLocationPing` → `schema.prisma:L3720`
- `Promotion` → `schema.prisma:L17828`
- `PromotionGroup` → `schema.prisma:L17867`
- `PromotionOption` → `schema.prisma:L17883`
- `ProviderCostStructure` → `schema.prisma:L6879`
- `ProviderEventLog` → `schema.prisma:L6508`
- `PurchaseOrder` → `schema.prisma:L2512`
- `PurchaseOrderInvoice` → `schema.prisma:L2657`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2714`
- `PurchaseOrderItem` → `schema.prisma:L2570`
- `RateCorrectionBatch` → `schema.prisma:L7104`
- `RateCorrectionEntry` → `schema.prisma:L7146`
- `RawMaterial` → `schema.prisma:L2268`
- `RawMaterialMovement` → `schema.prisma:L2840`
- `RawMaterialPresentation` → `schema.prisma:L2344`
- `ReceiptLayout` → `schema.prisma:L18314`
- `Recipe` → `schema.prisma:L2364`
- `RecipeLine` → `schema.prisma:L2388`
- `Referral` → `schema.prisma:L8373`
- `ReferralProgramConfig` → `schema.prisma:L8338`
- `ReferralRewardGrant` → `schema.prisma:L8464`
- `ReferralTierReward` → `schema.prisma:L8436`
- `ReferralTierUnlock` → `schema.prisma:L8509`
- `RefreshGrant` → `schema.prisma:L18259`
- `Reservation` → `schema.prisma:L13905`
- `ReservationGoogleEventMapping` → `schema.prisma:L14675`
- `ReservationModifier` → `schema.prisma:L14085`
- `ReservationReminderSent` → `schema.prisma:L14068`
- `ReservationSettings` → `schema.prisma:L14299`
- `ReservationWaitlistEntry` → `schema.prisma:L14267`
- `Review` → `schema.prisma:L5161`
- `SalesRetention` → `schema.prisma:L17222`
- `SaleVerification` → `schema.prisma:L4654`
- `ScaleProfile` → `schema.prisma:L16024`
- `ScheduledCommand` → `schema.prisma:L10736`
- `SerializedItem` → `schema.prisma:L12386`
- `SerializedItemCustodyEvent` → `schema.prisma:L12553`
- `ServiceCharge` → `schema.prisma:L8973`
- `Session` → `schema.prisma:L18238`
- `SettlementConfiguration` → `schema.prisma:L7179`
- `SettlementConfirmation` → `schema.prisma:L7292`
- `SettlementIncident` → `schema.prisma:L7243`
- `SettlementSimulation` → `schema.prisma:L7214`
- `Shift` → `schema.prisma:L3343`
- `SimRegistrationRequest` → `schema.prisma:L12591`
- `SimRegistrationRequestItem` → `schema.prisma:L12613`
- `SlotHold` → `schema.prisma:L14168`
- `Staff` → `schema.prisma:L988`
- `StaffDocument` → `schema.prisma:L3591`
- `StaffOnboardingState` → `schema.prisma:L16354`
- `StaffOrganization` → `schema.prisma:L1321`
- `StaffPasskey` → `schema.prisma:L1348`
- `StaffSchedule` → `schema.prisma:L14108`
- `StaffScheduleException` → `schema.prisma:L14120`
- `StaffVenue` → `schema.prisma:L1245`
- `StaffWorkSchedule` → `schema.prisma:L3468`
- `StaffWorkScheduleException` → `schema.prisma:L3566`
- `StampCard` → `schema.prisma:L8221`
- `StampEvent` → `schema.prisma:L8260`
- `StampReward` → `schema.prisma:L8298`
- `StockAlertConfig` → `schema.prisma:L13244`
- `StockBatch` → `schema.prisma:L3006`
- `StockCount` → `schema.prisma:L2923`
- `StockCountItem` → `schema.prisma:L2951`
- `StripeWebhookEvent` → `schema.prisma:L6826`
- `Supplier` → `schema.prisma:L2423`
- `SupplierItemCode` → `schema.prisma:L2755`
- `SupplierPricing` → `schema.prisma:L2478`
- `Table` → `schema.prisma:L3255`
- `Terminal` → `schema.prisma:L5212`
- `TerminalAttemptResolution` → `schema.prisma:L5643`
- `TerminalHealth` → `schema.prisma:L5463`
- `TerminalLog` → `schema.prisma:L5437`
- `TerminalOrder` → `schema.prisma:L5687`
- `TerminalOrderItem` → `schema.prisma:L5762`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5615`
- `TerminalPaymentRequest` → `schema.prisma:L5534`
- `TimeEntry` → `schema.prisma:L3633`
- `TimeEntryBreak` → `schema.prisma:L3702`
- `TokenPurchase` → `schema.prisma:L10410`
- `TokenUsageRecord` → `schema.prisma:L10382`
- `TpvCommandHistory` → `schema.prisma:L10642`
- `TpvCommandQueue` → `schema.prisma:L10582`
- `TpvFeedback` → `schema.prisma:L10295`
- `TpvMessage` → `schema.prisma:L13601`
- `TpvMessageDelivery` → `schema.prisma:L13653`
- `TpvMessageResponse` → `schema.prisma:L13676`
- `TrainingModule` → `schema.prisma:L13731`
- `TrainingProgress` → `schema.prisma:L13808`
- `TrainingQuizQuestion` → `schema.prisma:L13790`
- `TrainingStep` → `schema.prisma:L13770`
- `TransactionCost` → `schema.prisma:L7042`
- `UnitConversion` → `schema.prisma:L2818`
- `UpsellAcceptance` → `schema.prisma:L8794`
- `UpsellAiRun` → `schema.prisma:L8814`
- `UpsellImpression` → `schema.prisma:L8754`
- `UpsellRule` → `schema.prisma:L8674`
- `user_sessions` → `schema.prisma:L6264`
- `Venue` → `schema.prisma:L167`
- `VenueAreaTicketSettings` → `schema.prisma:L15761`
- `VenueChatMessage` → `schema.prisma:L810`
- `VenueChatSession` → `schema.prisma:L765`
- `VenueCommission` → `schema.prisma:L15369`
- `VenueCreditAssessment` → `schema.prisma:L11124`
- `VenueCryptoConfig` → `schema.prisma:L13468`
- `VenueFeature` → `schema.prisma:L4768`
- `VenueIvaPorProducto` → `schema.prisma:L961`
- `VenueModule` → `schema.prisma:L11284`
- `VenuePaymentConfig` → `schema.prisma:L6365`
- `VenuePaymentLinkSettings` → `schema.prisma:L14708`
- `VenuePricingStructure` → `schema.prisma:L6982`
- `VenueRoleConfig` → `schema.prisma:L1474`
- `VenueRolePermission` → `schema.prisma:L1378`
- `VenueScaleSettings` → `schema.prisma:L16012`
- `VenueSettings` → `schema.prisma:L850`
- `VenueTenderType` → `schema.prisma:L4513`
- `VenueTenderTypeRevision` → `schema.prisma:L4578`
- `VenueTransaction` → `schema.prisma:L4705`
- `VenueWhatsappActivation` → `schema.prisma:L701`
- `WalletCardDesign` → `schema.prisma:L8139`
- `WalletPass` → `schema.prisma:L8040`
- `WalletPassRegistration` → `schema.prisma:L8106`
- `WebhookEvent` → `schema.prisma:L5070`
- `WebhookSubscription` → `schema.prisma:L6481`
- `WhatsappContactWindow` → `schema.prisma:L719`
- `WhatsappInboundEvent` → `schema.prisma:L739`
- `WorkShiftAssignment` → `schema.prisma:L3508`
- `WorkShiftTemplate` → `schema.prisma:L3485`
- `Zone` → `schema.prisma:L150`
