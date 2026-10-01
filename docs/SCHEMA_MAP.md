# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **390 models / 360 enums / ~18,500 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L17086`
- `AccountMapping` → `schema.prisma:L16981`
- `ActivityLog` → `schema.prisma:L7462`
- `Aggregator` → `schema.prisma:L15258`
- `AngelPayUserAccount` → `schema.prisma:L6007`
- `AppUpdate` → `schema.prisma:L13423`
- `Area` → `schema.prisma:L3241`
- `AreaTicket` → `schema.prisma:L15794`
- `AreaTicketCheckoutSession` → `schema.prisma:L15916`
- `AreaTicketExternalIncident` → `schema.prisma:L16163`
- `AreaTicketExternalSettlement` → `schema.prisma:L16128`
- `AreaTicketFulfillment` → `schema.prisma:L15992`
- `AreaTicketInventoryReservation` → `schema.prisma:L15887`
- `AreaTicketLine` → `schema.prisma:L15855`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15948`
- `AreaTicketPrintAttempt` → `schema.prisma:L15971`
- `BankStatement` → `schema.prisma:L16855`
- `BankStatementLine` → `schema.prisma:L16876`
- `BillingObligationConflict` → `schema.prisma:L5044`
- `BillingTaxProfile` → `schema.prisma:L17678`
- `BirthdayAutomation` → `schema.prisma:L7783`
- `BulkCommandOperation` → `schema.prisma:L10703`
- `CalendarSyncOutbox` → `schema.prisma:L14630`
- `CampaignDelivery` → `schema.prisma:L13581`
- `CapabilityGrant` → `schema.prisma:L4820`
- `CashCloseout` → `schema.prisma:L11088`
- `CashDeposit` → `schema.prisma:L13225`
- `CashDrawerEvent` → `schema.prisma:L15095`
- `CashDrawerSession` → `schema.prisma:L15056`
- `CashOutCommissionRate` → `schema.prisma:L17495`
- `CashOutScheduleDay` → `schema.prisma:L17518`
- `CashOutWithdrawal` → `schema.prisma:L17580`
- `CatalogBindingBatch` → `schema.prisma:L12119`
- `CatalogBindingLine` → `schema.prisma:L12155`
- `CatalogBrand` → `schema.prisma:L11572`
- `CatalogClientObservation` → `schema.prisma:L11885`
- `CatalogClientReadinessOverride` → `schema.prisma:L11904`
- `CatalogFamily` → `schema.prisma:L11622`
- `CatalogIdempotencyRecord` → `schema.prisma:L12018`
- `CatalogIdentifier` → `schema.prisma:L11753`
- `CatalogImportBatch` → `schema.prisma:L12061`
- `CatalogImportLine` → `schema.prisma:L12098`
- `CatalogItem` → `schema.prisma:L11655`
- `CatalogItemBusinessType` → `schema.prisma:L11715`
- `CatalogItemPrice` → `schema.prisma:L11803`
- `CatalogManufacturer` → `schema.prisma:L11596`
- `CatalogProductTypeMapping` → `schema.prisma:L11732`
- `CatalogPublicationBatch` → `schema.prisma:L12183`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12277`
- `CatalogPublicationLine` → `schema.prisma:L12224`
- `CatalogPublicationOutbox` → `schema.prisma:L12320`
- `CatalogValidationProfile` → `schema.prisma:L11774`
- `CatalogVenueBinding` → `schema.prisma:L11932`
- `CatalogVenueClientRequirement` → `schema.prisma:L11859`
- `CatalogVenueEventSequence` → `schema.prisma:L12303`
- `CatalogVenueOverride` → `schema.prisma:L11974`
- `CatalogVenueRollout` → `schema.prisma:L11834`
- `Cfdi` → `schema.prisma:L16683`
- `CfdiGlobalOrden` → `schema.prisma:L16808`
- `ChatbotTokenBudget` → `schema.prisma:L10351`
- `ChatConversation` → `schema.prisma:L10206`
- `ChatFeedback` → `schema.prisma:L10292`
- `ChatLearningEvent` → `schema.prisma:L10249`
- `ChatMessage` → `schema.prisma:L10229`
- `ChatTrainingData` → `schema.prisma:L10163`
- `CheckoutSession` → `schema.prisma:L6287`
- `ClassSession` → `schema.prisma:L14234`
- `CommissionCalculation` → `schema.prisma:L13001`
- `CommissionClawback` → `schema.prisma:L13177`
- `CommissionConfig` → `schema.prisma:L12767`
- `CommissionMilestone` → `schema.prisma:L12917`
- `CommissionOverride` → `schema.prisma:L12844`
- `CommissionPayout` → `schema.prisma:L13128`
- `CommissionSummary` → `schema.prisma:L13067`
- `CommissionTier` → `schema.prisma:L12881`
- `ConsentEvent` → `schema.prisma:L7645`
- `Consumer` → `schema.prisma:L7875`
- `ConsumerAuthAccount` → `schema.prisma:L7900`
- `CouponCode` → `schema.prisma:L8847`
- `CouponRedemption` → `schema.prisma:L8878`
- `CreditAssessmentHistory` → `schema.prisma:L11197`
- `CreditItemBalance` → `schema.prisma:L14846`
- `CreditOffer` → `schema.prisma:L11216`
- `CreditPack` → `schema.prisma:L14755`
- `CreditPackItem` → `schema.prisma:L14784`
- `CreditPackPurchase` → `schema.prisma:L14801`
- `CreditTransaction` → `schema.prisma:L14868`
- `Customer` → `schema.prisma:L7503`
- `CustomerApprovalDelivery` → `schema.prisma:L9865`
- `CustomerApprovalOutbox` → `schema.prisma:L9840`
- `CustomerCampaign` → `schema.prisma:L7733`
- `CustomerCampaignDelivery` → `schema.prisma:L7815`
- `CustomerCaptureToken` → `schema.prisma:L7681`
- `CustomerDiscount` → `schema.prisma:L8898`
- `CustomerGroup` → `schema.prisma:L7939`
- `CustomerOrderMetric` → `schema.prisma:L4040`
- `CustomerTaxProfile` → `schema.prisma:L16827`
- `DeliveryActivationRequest` → `schema.prisma:L6746`
- `DeliveryChannelLink` → `schema.prisma:L6585`
- `DeliveryConnectIntent` → `schema.prisma:L6697`
- `DeliveryLineAction` → `schema.prisma:L6658`
- `DeliveryOrderEvent` → `schema.prisma:L6770`
- `DeliveryStoreRevocation` → `schema.prisma:L6734`
- `DeviceToken` → `schema.prisma:L9167`
- `DigitalReceipt` → `schema.prisma:L4633`
- `Discount` → `schema.prisma:L8537`
- `EcommerceMerchant` → `schema.prisma:L6099`
- `EmailQuotaLedger` → `schema.prisma:L7862`
- `EmailSuppression` → `schema.prisma:L7850`
- `EmailTemplate` → `schema.prisma:L13520`
- `Employee` → `schema.prisma:L17343`
- `Estimate` → `schema.prisma:L15165`
- `EstimateItem` → `schema.prisma:L15193`
- `Expense` → `schema.prisma:L17130`
- `ExternalBusyBlock` → `schema.prisma:L14523`
- `Feature` → `schema.prisma:L4762`
- `FeeSchedule` → `schema.prisma:L5106`
- `FeeTier` → `schema.prisma:L5117`
- `FinancialAccount` → `schema.prisma:L15355`
- `FinancialConnection` → `schema.prisma:L15324`
- `FinancialProvider` → `schema.prisma:L15310`
- `FiscalEmisor` → `schema.prisma:L16599`
- `FiscalLossCarryforward` → `schema.prisma:L17253`
- `FixedAsset` → `schema.prisma:L17271`
- `FixedAssetDepreciation` → `schema.prisma:L17300`
- `FloorElement` → `schema.prisma:L3317`
- `FulfillmentArea` → `schema.prisma:L15659`
- `GeofenceRule` → `schema.prisma:L10788`
- `GoogleCalendarChannel` → `schema.prisma:L14500`
- `GoogleCalendarConnection` → `schema.prisma:L14452`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14553`
- `GoogleOAuthSession` → `schema.prisma:L14575`
- `HolidayCalendar` → `schema.prisma:L7386`
- `HybridBillingOperation` → `schema.prisma:L4968`
- `HybridCampaign` → `schema.prisma:L4845`
- `HybridContract` → `schema.prisma:L4925`
- `HybridContractSelection` → `schema.prisma:L4957`
- `HybridCreditAllocation` → `schema.prisma:L5024`
- `HybridOfferPublication` → `schema.prisma:L4872`
- `HybridPaymentPeriod` → `schema.prisma:L5003`
- `HybridPurchase` → `schema.prisma:L4892`
- `HybridRedemption` → `schema.prisma:L4986`
- `IdempotencyRequest` → `schema.prisma:L12642`
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
- `InventoryTransfer` → `schema.prisma:L15137`
- `InventoryWasteReport` → `schema.prisma:L2068`
- `Invitation` → `schema.prisma:L1510`
- `Invoice` → `schema.prisma:L5129`
- `InvoiceItem` → `schema.prisma:L5155`
- `ItemCategory` → `schema.prisma:L12355`
- `JournalEntry` → `schema.prisma:L17039`
- `JournalLine` → `schema.prisma:L17068`
- `KdsOrder` → `schema.prisma:L15403`
- `KdsOrderItem` → `schema.prisma:L15466`
- `KioskCheckInAttempt` → `schema.prisma:L18001`
- `KioskCheckInChallenge` → `schema.prisma:L17955`
- `KioskOutreachOutbox` → `schema.prisma:L18022`
- `LaunchCampaign` → `schema.prisma:L18360`
- `LaunchCampaignRedemption` → `schema.prisma:L18477`
- `LearnedPatterns` → `schema.prisma:L10273`
- `LedgerAccount` → `schema.prisma:L16931`
- `LiveDemoSession` → `schema.prisma:L836`
- `LowStockAlert` → `schema.prisma:L2903`
- `LoyaltyConfig` → `schema.prisma:L7969`
- `LoyaltyTransaction` → `schema.prisma:L8012`
- `MarketingCampaign` → `schema.prisma:L13538`
- `McpAuthCode` → `schema.prisma:L16482`
- `McpOAuthClient` → `schema.prisma:L16466`
- `McpRefreshToken` → `schema.prisma:L16500`
- `McpToolCall` → `schema.prisma:L16521`
- `MeasurementUnit` → `schema.prisma:L15243`
- `Menu` → `schema.prisma:L1728`
- `MenuCategory` → `schema.prisma:L1665`
- `MenuCategoryAssignment` → `schema.prisma:L1763`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16396`
- `MerchantAccount` → `schema.prisma:L5837`
- `MerchantFiscalConfig` → `schema.prisma:L16654`
- `MerchantRevenueShare` → `schema.prisma:L6966`
- `MerchantRoutingRule` → `schema.prisma:L5959`
- `MilestoneAchievement` → `schema.prisma:L12962`
- `Modifier` → `schema.prisma:L4239`
- `ModifierGroup` → `schema.prisma:L4203`
- `Module` → `schema.prisma:L11264`
- `MoneyAnomaly` → `schema.prisma:L6869`
- `MonthlyVenueProfit` → `schema.prisma:L7412`
- `Notification` → `schema.prisma:L9069`
- `NotificationPreference` → `schema.prisma:L9116`
- `NotificationTemplate` → `schema.prisma:L9143`
- `OAuthState` → `schema.prisma:L1561`
- `OnboardingProgress` → `schema.prisma:L1579`
- `Order` → `schema.prisma:L3766`
- `OrderAction` → `schema.prisma:L4306`
- `OrderCustomer` → `schema.prisma:L4019`
- `OrderDiscount` → `schema.prisma:L8930`
- `OrderFulfillment` → `schema.prisma:L15714`
- `OrderFulfillmentLine` → `schema.prisma:L15745`
- `OrderItem` → `schema.prisma:L4055`
- `OrderItemModifier` → `schema.prisma:L4288`
- `OrderItemSelloIva` → `schema.prisma:L16788`
- `OrderPromotion` → `schema.prisma:L17918`
- `OrderServiceCharge` → `schema.prisma:L9014`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13339`
- `OrganizationEntitlement` → `schema.prisma:L11547`
- `OrganizationGoal` → `schema.prisma:L13297`
- `OrganizationModule` → `schema.prisma:L11324`
- `OrganizationPaymentConfig` → `schema.prisma:L6411`
- `OrganizationPayoutConfig` → `schema.prisma:L13372`
- `OrganizationPricingStructure` → `schema.prisma:L6443`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13320`
- `OtpChallenge` → `schema.prisma:L7919`
- `OvertimeApproval` → `schema.prisma:L3544`
- `PartnerAPIKey` → `schema.prisma:L6241`
- `Payment` → `schema.prisma:L4339`
- `PaymentAllocation` → `schema.prisma:L4612`
- `PaymentEffect` → `schema.prisma:L18292`
- `PaymentLink` → `schema.prisma:L14914`
- `PaymentLinkAttribution` → `schema.prisma:L15022`
- `PaymentLinkItem` → `schema.prisma:L14977`
- `PaymentLinkItemModifier` → `schema.prisma:L15004`
- `PaymentProvider` → `schema.prisma:L5796`
- `PayrollLine` → `schema.prisma:L17414`
- `PayrollRun` → `schema.prisma:L17383`
- `PerformanceGoal` → `schema.prisma:L13274`
- `PermissionOverride` → `schema.prisma:L1434`
- `PermissionSet` → `schema.prisma:L1457`
- `PlatformAnnouncement` → `schema.prisma:L18082`
- `PlatformAnnouncementClick` → `schema.prisma:L18147`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18184`
- `PlatformCfdi` → `schema.prisma:L17711`
- `PlatformEmisor` → `schema.prisma:L17651`
- `PlatformSettings` → `schema.prisma:L6218`
- `PosCommand` → `schema.prisma:L9197`
- `PosConnectionStatus` → `schema.prisma:L980`
- `PosSyncIntent` → `schema.prisma:L17789`
- `PricingPolicy` → `schema.prisma:L2799`
- `Printer` → `schema.prisma:L15515`
- `PrintGateway` → `schema.prisma:L15572`
- `PrintJob` → `schema.prisma:L16295`
- `PrintStation` → `schema.prisma:L15590`
- `PrivacyNoticeVersion` → `schema.prisma:L7667`
- `ProcessedStripeEvent` → `schema.prisma:L6855`
- `ProcessorReliabilityMetric` → `schema.prisma:L7340`
- `Product` → `schema.prisma:L1781`
- `ProductModifierGroup` → `schema.prisma:L4276`
- `ProductOption` → `schema.prisma:L15220`
- `ProductOptionValue` → `schema.prisma:L15231`
- `ProductStaff` → `schema.prisma:L14149`
- `PromoterBankAccount` → `schema.prisma:L17534`
- `PromoterCommissionEntry` → `schema.prisma:L17553`
- `PromoterLocationPing` → `schema.prisma:L3732`
- `Promotion` → `schema.prisma:L17840`
- `PromotionGroup` → `schema.prisma:L17879`
- `PromotionOption` → `schema.prisma:L17895`
- `ProviderCostStructure` → `schema.prisma:L6891`
- `ProviderEventLog` → `schema.prisma:L6520`
- `PurchaseOrder` → `schema.prisma:L2524`
- `PurchaseOrderInvoice` → `schema.prisma:L2669`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2726`
- `PurchaseOrderItem` → `schema.prisma:L2582`
- `RateCorrectionBatch` → `schema.prisma:L7116`
- `RateCorrectionEntry` → `schema.prisma:L7158`
- `RawMaterial` → `schema.prisma:L2280`
- `RawMaterialMovement` → `schema.prisma:L2852`
- `RawMaterialPresentation` → `schema.prisma:L2356`
- `ReceiptLayout` → `schema.prisma:L18326`
- `Recipe` → `schema.prisma:L2376`
- `RecipeLine` → `schema.prisma:L2400`
- `Referral` → `schema.prisma:L8385`
- `ReferralProgramConfig` → `schema.prisma:L8350`
- `ReferralRewardGrant` → `schema.prisma:L8476`
- `ReferralTierReward` → `schema.prisma:L8448`
- `ReferralTierUnlock` → `schema.prisma:L8521`
- `RefreshGrant` → `schema.prisma:L18271`
- `Reservation` → `schema.prisma:L13917`
- `ReservationGoogleEventMapping` → `schema.prisma:L14687`
- `ReservationModifier` → `schema.prisma:L14097`
- `ReservationReminderSent` → `schema.prisma:L14080`
- `ReservationSettings` → `schema.prisma:L14311`
- `ReservationWaitlistEntry` → `schema.prisma:L14279`
- `Review` → `schema.prisma:L5173`
- `SalesRetention` → `schema.prisma:L17234`
- `SaleVerification` → `schema.prisma:L4666`
- `ScaleProfile` → `schema.prisma:L16036`
- `ScheduledCommand` → `schema.prisma:L10748`
- `SerializedItem` → `schema.prisma:L12398`
- `SerializedItemCustodyEvent` → `schema.prisma:L12565`
- `ServiceCharge` → `schema.prisma:L8985`
- `Session` → `schema.prisma:L18250`
- `SettlementConfiguration` → `schema.prisma:L7191`
- `SettlementConfirmation` → `schema.prisma:L7304`
- `SettlementIncident` → `schema.prisma:L7255`
- `SettlementSimulation` → `schema.prisma:L7226`
- `Shift` → `schema.prisma:L3355`
- `SimRegistrationRequest` → `schema.prisma:L12603`
- `SimRegistrationRequestItem` → `schema.prisma:L12625`
- `SlotHold` → `schema.prisma:L14180`
- `Staff` → `schema.prisma:L1000`
- `StaffDocument` → `schema.prisma:L3603`
- `StaffOnboardingState` → `schema.prisma:L16366`
- `StaffOrganization` → `schema.prisma:L1333`
- `StaffPasskey` → `schema.prisma:L1360`
- `StaffSchedule` → `schema.prisma:L14120`
- `StaffScheduleException` → `schema.prisma:L14132`
- `StaffVenue` → `schema.prisma:L1257`
- `StaffWorkSchedule` → `schema.prisma:L3480`
- `StaffWorkScheduleException` → `schema.prisma:L3578`
- `StampCard` → `schema.prisma:L8233`
- `StampEvent` → `schema.prisma:L8272`
- `StampReward` → `schema.prisma:L8310`
- `StockAlertConfig` → `schema.prisma:L13256`
- `StockBatch` → `schema.prisma:L3018`
- `StockCount` → `schema.prisma:L2935`
- `StockCountItem` → `schema.prisma:L2963`
- `StripeWebhookEvent` → `schema.prisma:L6838`
- `Supplier` → `schema.prisma:L2435`
- `SupplierItemCode` → `schema.prisma:L2767`
- `SupplierPricing` → `schema.prisma:L2490`
- `Table` → `schema.prisma:L3267`
- `Terminal` → `schema.prisma:L5224`
- `TerminalAttemptResolution` → `schema.prisma:L5655`
- `TerminalHealth` → `schema.prisma:L5475`
- `TerminalLog` → `schema.prisma:L5449`
- `TerminalOrder` → `schema.prisma:L5699`
- `TerminalOrderItem` → `schema.prisma:L5774`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5627`
- `TerminalPaymentRequest` → `schema.prisma:L5546`
- `TimeEntry` → `schema.prisma:L3645`
- `TimeEntryBreak` → `schema.prisma:L3714`
- `TokenPurchase` → `schema.prisma:L10422`
- `TokenUsageRecord` → `schema.prisma:L10394`
- `TpvCommandHistory` → `schema.prisma:L10654`
- `TpvCommandQueue` → `schema.prisma:L10594`
- `TpvFeedback` → `schema.prisma:L10307`
- `TpvMessage` → `schema.prisma:L13613`
- `TpvMessageDelivery` → `schema.prisma:L13665`
- `TpvMessageResponse` → `schema.prisma:L13688`
- `TrainingModule` → `schema.prisma:L13743`
- `TrainingProgress` → `schema.prisma:L13820`
- `TrainingQuizQuestion` → `schema.prisma:L13802`
- `TrainingStep` → `schema.prisma:L13782`
- `TransactionCost` → `schema.prisma:L7054`
- `UnitConversion` → `schema.prisma:L2830`
- `UpsellAcceptance` → `schema.prisma:L8806`
- `UpsellAiRun` → `schema.prisma:L8826`
- `UpsellImpression` → `schema.prisma:L8766`
- `UpsellRule` → `schema.prisma:L8686`
- `user_sessions` → `schema.prisma:L6276`
- `Venue` → `schema.prisma:L167`
- `VenueAreaTicketSettings` → `schema.prisma:L15773`
- `VenueChatMessage` → `schema.prisma:L812`
- `VenueChatSession` → `schema.prisma:L767`
- `VenueCommission` → `schema.prisma:L15381`
- `VenueCreditAssessment` → `schema.prisma:L11136`
- `VenueCryptoConfig` → `schema.prisma:L13480`
- `VenueFeature` → `schema.prisma:L4780`
- `VenueIvaPorProducto` → `schema.prisma:L963`
- `VenueModule` → `schema.prisma:L11296`
- `VenuePaymentConfig` → `schema.prisma:L6377`
- `VenuePaymentLinkSettings` → `schema.prisma:L14720`
- `VenuePosSinAparato` → `schema.prisma:L974`
- `VenuePricingStructure` → `schema.prisma:L6994`
- `VenueRoleConfig` → `schema.prisma:L1486`
- `VenueRolePermission` → `schema.prisma:L1390`
- `VenueScaleSettings` → `schema.prisma:L16024`
- `VenueSettings` → `schema.prisma:L852`
- `VenueTenderType` → `schema.prisma:L4525`
- `VenueTenderTypeRevision` → `schema.prisma:L4590`
- `VenueTransaction` → `schema.prisma:L4717`
- `VenueWhatsappActivation` → `schema.prisma:L703`
- `WalletCardDesign` → `schema.prisma:L8151`
- `WalletPass` → `schema.prisma:L8052`
- `WalletPassRegistration` → `schema.prisma:L8118`
- `WebhookEvent` → `schema.prisma:L5082`
- `WebhookSubscription` → `schema.prisma:L6493`
- `WhatsappContactWindow` → `schema.prisma:L721`
- `WhatsappInboundEvent` → `schema.prisma:L741`
- `WorkShiftAssignment` → `schema.prisma:L3520`
- `WorkShiftTemplate` → `schema.prisma:L3497`
- `Zone` → `schema.prisma:L150`
