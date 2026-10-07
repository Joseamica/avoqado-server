# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **411 models / 377 enums / ~19,100 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L17456`
- `AccountMapping` → `schema.prisma:L17351`
- `ActivityLog` → `schema.prisma:L7530`
- `Aggregator` → `schema.prisma:L15627`
- `AggregatorBooking` → `schema.prisma:L14935`
- `AggregatorCapacityRule` → `schema.prisma:L14916`
- `AggregatorConnection` → `schema.prisma:L14841`
- `AggregatorInboundEvent` → `schema.prisma:L15004`
- `AggregatorOutbox` → `schema.prisma:L15024`
- `AggregatorProductLink` → `schema.prisma:L14873`
- `AggregatorSessionLink` → `schema.prisma:L14892`
- `AggregatorVisit` → `schema.prisma:L14961`
- `AngelPayUserAccount` → `schema.prisma:L6075`
- `AppUpdate` → `schema.prisma:L13502`
- `Area` → `schema.prisma:L3262`
- `AreaTicket` → `schema.prisma:L16163`
- `AreaTicketCheckoutSession` → `schema.prisma:L16285`
- `AreaTicketExternalIncident` → `schema.prisma:L16532`
- `AreaTicketExternalSettlement` → `schema.prisma:L16497`
- `AreaTicketFulfillment` → `schema.prisma:L16361`
- `AreaTicketInventoryReservation` → `schema.prisma:L16256`
- `AreaTicketLine` → `schema.prisma:L16224`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16317`
- `AreaTicketPrintAttempt` → `schema.prisma:L16340`
- `BankStatement` → `schema.prisma:L17225`
- `BankStatementLine` → `schema.prisma:L17246`
- `BillingObligationConflict` → `schema.prisma:L5105`
- `BillingTaxProfile` → `schema.prisma:L18048`
- `BirthdayAutomation` → `schema.prisma:L7854`
- `BulkCommandOperation` → `schema.prisma:L10781`
- `CalendarSyncOutbox` → `schema.prisma:L14724`
- `CampaignDelivery` → `schema.prisma:L13660`
- `CapabilityGrant` → `schema.prisma:L4845`
- `CashCloseout` → `schema.prisma:L11166`
- `CashDeposit` → `schema.prisma:L13304`
- `CashDrawerEvent` → `schema.prisma:L15464`
- `CashDrawerSession` → `schema.prisma:L15425`
- `CashOutCommissionRate` → `schema.prisma:L17865`
- `CashOutScheduleDay` → `schema.prisma:L17888`
- `CashOutWithdrawal` → `schema.prisma:L17950`
- `CatalogBindingBatch` → `schema.prisma:L12197`
- `CatalogBindingLine` → `schema.prisma:L12233`
- `CatalogBrand` → `schema.prisma:L11650`
- `CatalogClientObservation` → `schema.prisma:L11963`
- `CatalogClientReadinessOverride` → `schema.prisma:L11982`
- `CatalogFamily` → `schema.prisma:L11700`
- `CatalogIdempotencyRecord` → `schema.prisma:L12096`
- `CatalogIdentifier` → `schema.prisma:L11831`
- `CatalogImportBatch` → `schema.prisma:L12139`
- `CatalogImportLine` → `schema.prisma:L12176`
- `CatalogItem` → `schema.prisma:L11733`
- `CatalogItemBusinessType` → `schema.prisma:L11793`
- `CatalogItemPrice` → `schema.prisma:L11881`
- `CatalogManufacturer` → `schema.prisma:L11674`
- `CatalogProductTypeMapping` → `schema.prisma:L11810`
- `CatalogPublicationBatch` → `schema.prisma:L12261`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12355`
- `CatalogPublicationLine` → `schema.prisma:L12302`
- `CatalogPublicationOutbox` → `schema.prisma:L12398`
- `CatalogValidationProfile` → `schema.prisma:L11852`
- `CatalogVenueBinding` → `schema.prisma:L12010`
- `CatalogVenueClientRequirement` → `schema.prisma:L11937`
- `CatalogVenueEventSequence` → `schema.prisma:L12381`
- `CatalogVenueOverride` → `schema.prisma:L12052`
- `CatalogVenueRollout` → `schema.prisma:L11912`
- `Cfdi` → `schema.prisma:L17053`
- `CfdiGlobalOrden` → `schema.prisma:L17178`
- `ChatbotTokenBudget` → `schema.prisma:L10427`
- `ChatConversation` → `schema.prisma:L10282`
- `ChatFeedback` → `schema.prisma:L10368`
- `ChatLearningEvent` → `schema.prisma:L10325`
- `ChatMessage` → `schema.prisma:L10305`
- `ChatTrainingData` → `schema.prisma:L10239`
- `CheckoutSession` → `schema.prisma:L6355`
- `ClassSession` → `schema.prisma:L14318`
- `ClassSessionPayState` → `schema.prisma:L19008`
- `CommissionCalculation` → `schema.prisma:L13079`
- `CommissionClawback` → `schema.prisma:L13256`
- `CommissionConfig` → `schema.prisma:L12845`
- `CommissionMilestone` → `schema.prisma:L12995`
- `CommissionOverride` → `schema.prisma:L12922`
- `CommissionPayout` → `schema.prisma:L13207`
- `CommissionSummary` → `schema.prisma:L13146`
- `CommissionTier` → `schema.prisma:L12959`
- `ConsentEvent` → `schema.prisma:L7716`
- `Consumer` → `schema.prisma:L7946`
- `ConsumerAuthAccount` → `schema.prisma:L7971`
- `CouponCode` → `schema.prisma:L8918`
- `CouponRedemption` → `schema.prisma:L8949`
- `CreditAssessmentHistory` → `schema.prisma:L11275`
- `CreditItemBalance` → `schema.prisma:L15215`
- `CreditOffer` → `schema.prisma:L11294`
- `CreditPack` → `schema.prisma:L15124`
- `CreditPackItem` → `schema.prisma:L15153`
- `CreditPackPurchase` → `schema.prisma:L15170`
- `CreditTransaction` → `schema.prisma:L15237`
- `Customer` → `schema.prisma:L7571`
- `CustomerApprovalDelivery` → `schema.prisma:L9941`
- `CustomerApprovalOutbox` → `schema.prisma:L9916`
- `CustomerCampaign` → `schema.prisma:L7804`
- `CustomerCampaignDelivery` → `schema.prisma:L7886`
- `CustomerCaptureToken` → `schema.prisma:L7752`
- `CustomerDiscount` → `schema.prisma:L8969`
- `CustomerExternalIdentity` → `schema.prisma:L14991`
- `CustomerGroup` → `schema.prisma:L8010`
- `CustomerOrderMetric` → `schema.prisma:L4061`
- `CustomerTaxProfile` → `schema.prisma:L17197`
- `DeliveryActivationRequest` → `schema.prisma:L6814`
- `DeliveryChannelLink` → `schema.prisma:L6653`
- `DeliveryConnectIntent` → `schema.prisma:L6765`
- `DeliveryLineAction` → `schema.prisma:L6726`
- `DeliveryOrderEvent` → `schema.prisma:L6838`
- `DeliveryStoreRevocation` → `schema.prisma:L6802`
- `DeviceToken` → `schema.prisma:L9243`
- `DigitalReceipt` → `schema.prisma:L4658`
- `Discount` → `schema.prisma:L8608`
- `EcommerceMerchant` → `schema.prisma:L6167`
- `EmailQuotaLedger` → `schema.prisma:L7933`
- `EmailSuppression` → `schema.prisma:L7921`
- `EmailTemplate` → `schema.prisma:L13599`
- `Employee` → `schema.prisma:L17713`
- `Estimate` → `schema.prisma:L15534`
- `EstimateItem` → `schema.prisma:L15562`
- `Expense` → `schema.prisma:L17500`
- `ExternalBusyBlock` → `schema.prisma:L14617`
- `Feature` → `schema.prisma:L4787`
- `FeeSchedule` → `schema.prisma:L5167`
- `FeeTier` → `schema.prisma:L5178`
- `FinancialAccount` → `schema.prisma:L15724`
- `FinancialConnection` → `schema.prisma:L15693`
- `FinancialProvider` → `schema.prisma:L15679`
- `FiscalEmisor` → `schema.prisma:L16969`
- `FiscalLossCarryforward` → `schema.prisma:L17623`
- `FixedAsset` → `schema.prisma:L17641`
- `FixedAssetDepreciation` → `schema.prisma:L17670`
- `FloorElement` → `schema.prisma:L3338`
- `FulfillmentArea` → `schema.prisma:L16028`
- `GeofenceRule` → `schema.prisma:L10866`
- `GoogleCalendarChannel` → `schema.prisma:L14594`
- `GoogleCalendarConnection` → `schema.prisma:L14546`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14647`
- `GoogleOAuthSession` → `schema.prisma:L14669`
- `HolidayCalendar` → `schema.prisma:L7454`
- `HybridBillingOperation` → `schema.prisma:L5029`
- `HybridCampaign` → `schema.prisma:L4870`
- `HybridContract` → `schema.prisma:L4986`
- `HybridContractSelection` → `schema.prisma:L5018`
- `HybridCreditAllocation` → `schema.prisma:L5085`
- `HybridOfferPublication` → `schema.prisma:L4933`
- `HybridPaymentPeriod` → `schema.prisma:L5064`
- `HybridPromotionGroup` → `schema.prisma:L4914`
- `HybridPurchase` → `schema.prisma:L4953`
- `HybridRedemption` → `schema.prisma:L5047`
- `IdempotencyRequest` → `schema.prisma:L12720`
- `InterVenueTransfer` → `schema.prisma:L3090`
- `InterVenueTransferAllocation` → `schema.prisma:L3173`
- `InterVenueTransferItem` → `schema.prisma:L3142`
- `InterVenueTransferReceipt` → `schema.prisma:L3200`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3216`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3244`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3228`
- `Inventory` → `schema.prisma:L2034`
- `InventoryMovement` → `schema.prisma:L2134`
- `InventoryPosting` → `schema.prisma:L2229`
- `InventoryPostingLine` → `schema.prisma:L2269`
- `InventoryTransfer` → `schema.prisma:L15506`
- `InventoryWasteReport` → `schema.prisma:L2089`
- `Invitation` → `schema.prisma:L1528`
- `Invoice` → `schema.prisma:L5190`
- `InvoiceItem` → `schema.prisma:L5216`
- `ItemCategory` → `schema.prisma:L12433`
- `JournalEntry` → `schema.prisma:L17409`
- `JournalLine` → `schema.prisma:L17438`
- `KdsOrder` → `schema.prisma:L15772`
- `KdsOrderItem` → `schema.prisma:L15835`
- `KioskCheckInAttempt` → `schema.prisma:L18371`
- `KioskCheckInChallenge` → `schema.prisma:L18325`
- `KioskOutreachOutbox` → `schema.prisma:L18392`
- `LaunchCampaign` → `schema.prisma:L18730`
- `LaunchCampaignRedemption` → `schema.prisma:L18847`
- `LearnedPatterns` → `schema.prisma:L10349`
- `LedgerAccount` → `schema.prisma:L17301`
- `LiveDemoSession` → `schema.prisma:L853`
- `LowStockAlert` → `schema.prisma:L2924`
- `LoyaltyConfig` → `schema.prisma:L8040`
- `LoyaltyTransaction` → `schema.prisma:L8083`
- `MarketingCampaign` → `schema.prisma:L13617`
- `McpAuthCode` → `schema.prisma:L16851`
- `McpOAuthClient` → `schema.prisma:L16835`
- `McpRefreshToken` → `schema.prisma:L16869`
- `McpToolCall` → `schema.prisma:L16891`
- `MeasurementUnit` → `schema.prisma:L15612`
- `Menu` → `schema.prisma:L1746`
- `MenuCategory` → `schema.prisma:L1683`
- `MenuCategoryAssignment` → `schema.prisma:L1781`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16765`
- `MerchantAccount` → `schema.prisma:L5905`
- `MerchantFiscalConfig` → `schema.prisma:L17024`
- `MerchantRevenueShare` → `schema.prisma:L7034`
- `MerchantRoutingRule` → `schema.prisma:L6027`
- `MilestoneAchievement` → `schema.prisma:L13040`
- `Modifier` → `schema.prisma:L4260`
- `ModifierGroup` → `schema.prisma:L4224`
- `Module` → `schema.prisma:L11342`
- `MoneyAnomaly` → `schema.prisma:L6937`
- `MonthlyVenueProfit` → `schema.prisma:L7480`
- `Notification` → `schema.prisma:L9145`
- `NotificationPreference` → `schema.prisma:L9192`
- `NotificationTemplate` → `schema.prisma:L9219`
- `OAuthState` → `schema.prisma:L1579`
- `OnboardingProgress` → `schema.prisma:L1597`
- `Order` → `schema.prisma:L3787`
- `OrderAction` → `schema.prisma:L4331`
- `OrderCustomer` → `schema.prisma:L4040`
- `OrderDiscount` → `schema.prisma:L9001`
- `OrderFulfillment` → `schema.prisma:L16083`
- `OrderFulfillmentLine` → `schema.prisma:L16114`
- `OrderItem` → `schema.prisma:L4076`
- `OrderItemModifier` → `schema.prisma:L4313`
- `OrderItemSelloIva` → `schema.prisma:L17158`
- `OrderPromotion` → `schema.prisma:L18288`
- `OrderServiceCharge` → `schema.prisma:L9090`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13418`
- `OrganizationEntitlement` → `schema.prisma:L11625`
- `OrganizationGoal` → `schema.prisma:L13376`
- `OrganizationModule` → `schema.prisma:L11402`
- `OrganizationPaymentConfig` → `schema.prisma:L6479`
- `OrganizationPayoutConfig` → `schema.prisma:L13451`
- `OrganizationPricingStructure` → `schema.prisma:L6511`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13399`
- `OtpChallenge` → `schema.prisma:L7990`
- `OvertimeApproval` → `schema.prisma:L3565`
- `PartnerAPIKey` → `schema.prisma:L6309`
- `Payment` → `schema.prisma:L4364`
- `PaymentAllocation` → `schema.prisma:L4637`
- `PaymentEffect` → `schema.prisma:L18662`
- `PaymentLink` → `schema.prisma:L15283`
- `PaymentLinkAttribution` → `schema.prisma:L15391`
- `PaymentLinkItem` → `schema.prisma:L15346`
- `PaymentLinkItemModifier` → `schema.prisma:L15373`
- `PaymentProvider` → `schema.prisma:L5864`
- `PayrollLine` → `schema.prisma:L17784`
- `PayrollRun` → `schema.prisma:L17753`
- `PerformanceGoal` → `schema.prisma:L13353`
- `PermissionOverride` → `schema.prisma:L1452`
- `PermissionSet` → `schema.prisma:L1475`
- `PlatformAnnouncement` → `schema.prisma:L18452`
- `PlatformAnnouncementClick` → `schema.prisma:L18517`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18554`
- `PlatformCfdi` → `schema.prisma:L18081`
- `PlatformEmisor` → `schema.prisma:L18021`
- `PlatformSettings` → `schema.prisma:L6286`
- `PosCommand` → `schema.prisma:L9273`
- `PosConnectionStatus` → `schema.prisma:L997`
- `PosSyncIntent` → `schema.prisma:L18159`
- `PricingPolicy` → `schema.prisma:L2820`
- `Printer` → `schema.prisma:L15884`
- `PrintGateway` → `schema.prisma:L15941`
- `PrintJob` → `schema.prisma:L16664`
- `PrintStation` → `schema.prisma:L15959`
- `PrivacyNoticeVersion` → `schema.prisma:L7738`
- `ProcessedStripeEvent` → `schema.prisma:L6923`
- `ProcessorReliabilityMetric` → `schema.prisma:L7408`
- `Product` → `schema.prisma:L1799`
- `ProductModifierGroup` → `schema.prisma:L4301`
- `ProductOption` → `schema.prisma:L15589`
- `ProductOptionValue` → `schema.prisma:L15600`
- `ProductStaff` → `schema.prisma:L14233`
- `PromoterBankAccount` → `schema.prisma:L17904`
- `PromoterCommissionEntry` → `schema.prisma:L17923`
- `PromoterLocationPing` → `schema.prisma:L3753`
- `Promotion` → `schema.prisma:L18210`
- `PromotionGroup` → `schema.prisma:L18249`
- `PromotionOption` → `schema.prisma:L18265`
- `ProviderCostStructure` → `schema.prisma:L6959`
- `ProviderEventLog` → `schema.prisma:L6588`
- `PurchaseOrder` → `schema.prisma:L2545`
- `PurchaseOrderInvoice` → `schema.prisma:L2690`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2747`
- `PurchaseOrderItem` → `schema.prisma:L2603`
- `RateCorrectionBatch` → `schema.prisma:L7184`
- `RateCorrectionEntry` → `schema.prisma:L7226`
- `RawMaterial` → `schema.prisma:L2301`
- `RawMaterialMovement` → `schema.prisma:L2873`
- `RawMaterialPresentation` → `schema.prisma:L2377`
- `ReceiptLayout` → `schema.prisma:L18696`
- `Recipe` → `schema.prisma:L2397`
- `RecipeLine` → `schema.prisma:L2421`
- `Referral` → `schema.prisma:L8456`
- `ReferralProgramConfig` → `schema.prisma:L8421`
- `ReferralRewardGrant` → `schema.prisma:L8547`
- `ReferralTierReward` → `schema.prisma:L8519`
- `ReferralTierUnlock` → `schema.prisma:L8592`
- `RefreshGrant` → `schema.prisma:L18641`
- `Reservation` → `schema.prisma:L13996`
- `ReservationGoogleEventMapping` → `schema.prisma:L15056`
- `ReservationModifier` → `schema.prisma:L14181`
- `ReservationReminderSent` → `schema.prisma:L14164`
- `ReservationSettings` → `schema.prisma:L14405`
- `ReservationWaitlistEntry` → `schema.prisma:L14373`
- `Review` → `schema.prisma:L5234`
- `SalesRetention` → `schema.prisma:L17604`
- `SaleVerification` → `schema.prisma:L4691`
- `ScaleProfile` → `schema.prisma:L16405`
- `ScheduledCommand` → `schema.prisma:L10826`
- `SerializedItem` → `schema.prisma:L12476`
- `SerializedItemCustodyEvent` → `schema.prisma:L12643`
- `ServiceCharge` → `schema.prisma:L9061`
- `ServiceEarning` → `schema.prisma:L19070`
- `ServicePayPeriod` → `schema.prisma:L19046`
- `ServicePayTable` → `schema.prisma:L18954`
- `ServicePayTableCell` → `schema.prisma:L18996`
- `ServicePayTableVersion` → `schema.prisma:L18971`
- `Session` → `schema.prisma:L18620`
- `SettlementConfiguration` → `schema.prisma:L7259`
- `SettlementConfirmation` → `schema.prisma:L7372`
- `SettlementIncident` → `schema.prisma:L7323`
- `SettlementSimulation` → `schema.prisma:L7294`
- `Shift` → `schema.prisma:L3376`
- `SimRegistrationRequest` → `schema.prisma:L12681`
- `SimRegistrationRequestItem` → `schema.prisma:L12703`
- `SlotHold` → `schema.prisma:L14264`
- `Staff` → `schema.prisma:L1017`
- `StaffDocument` → `schema.prisma:L3624`
- `StaffOnboardingState` → `schema.prisma:L16735`
- `StaffOrganization` → `schema.prisma:L1351`
- `StaffPasskey` → `schema.prisma:L1378`
- `StaffPayLevel` → `schema.prisma:L18918`
- `StaffPayLevelAssignment` → `schema.prisma:L18936`
- `StaffPayStatement` → `schema.prisma:L19102`
- `StaffPayTipWindow` → `schema.prisma:L19118`
- `StaffPayVenueWindow` → `schema.prisma:L19135`
- `StaffSchedule` → `schema.prisma:L14204`
- `StaffScheduleException` → `schema.prisma:L14216`
- `StaffVenue` → `schema.prisma:L1275`
- `StaffWorkSchedule` → `schema.prisma:L3501`
- `StaffWorkScheduleException` → `schema.prisma:L3599`
- `StampCard` → `schema.prisma:L8304`
- `StampEvent` → `schema.prisma:L8343`
- `StampReward` → `schema.prisma:L8381`
- `StockAlertConfig` → `schema.prisma:L13335`
- `StockBatch` → `schema.prisma:L3039`
- `StockCount` → `schema.prisma:L2956`
- `StockCountItem` → `schema.prisma:L2984`
- `StripeWebhookEvent` → `schema.prisma:L6906`
- `Supplier` → `schema.prisma:L2456`
- `SupplierItemCode` → `schema.prisma:L2788`
- `SupplierPricing` → `schema.prisma:L2511`
- `Table` → `schema.prisma:L3288`
- `Terminal` → `schema.prisma:L5285`
- `TerminalAttemptResolution` → `schema.prisma:L5723`
- `TerminalHealth` → `schema.prisma:L5543`
- `TerminalLog` → `schema.prisma:L5517`
- `TerminalOrder` → `schema.prisma:L5767`
- `TerminalOrderItem` → `schema.prisma:L5842`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5695`
- `TerminalPaymentRequest` → `schema.prisma:L5614`
- `TimeEntry` → `schema.prisma:L3666`
- `TimeEntryBreak` → `schema.prisma:L3735`
- `TokenPurchase` → `schema.prisma:L10498`
- `TokenUsageRecord` → `schema.prisma:L10470`
- `TpvCommandHistory` → `schema.prisma:L10732`
- `TpvCommandQueue` → `schema.prisma:L10670`
- `TpvFeedback` → `schema.prisma:L10383`
- `TpvMessage` → `schema.prisma:L13692`
- `TpvMessageDelivery` → `schema.prisma:L13744`
- `TpvMessageResponse` → `schema.prisma:L13767`
- `TrainingModule` → `schema.prisma:L13822`
- `TrainingProgress` → `schema.prisma:L13899`
- `TrainingQuizQuestion` → `schema.prisma:L13881`
- `TrainingStep` → `schema.prisma:L13861`
- `TransactionCost` → `schema.prisma:L7122`
- `UnitConversion` → `schema.prisma:L2851`
- `UpsellAcceptance` → `schema.prisma:L8877`
- `UpsellAiRun` → `schema.prisma:L8897`
- `UpsellImpression` → `schema.prisma:L8837`
- `UpsellRule` → `schema.prisma:L8757`
- `user_sessions` → `schema.prisma:L6344`
- `Venue` → `schema.prisma:L178`
- `VenueAreaTicketSettings` → `schema.prisma:L16142`
- `VenueChatMessage` → `schema.prisma:L829`
- `VenueChatSession` → `schema.prisma:L784`
- `VenueCommission` → `schema.prisma:L15750`
- `VenueCreditAssessment` → `schema.prisma:L11214`
- `VenueCryptoConfig` → `schema.prisma:L13559`
- `VenueFeature` → `schema.prisma:L4805`
- `VenueIvaPorProducto` → `schema.prisma:L980`
- `VenueModule` → `schema.prisma:L11374`
- `VenuePaymentConfig` → `schema.prisma:L6445`
- `VenuePaymentLinkSettings` → `schema.prisma:L15089`
- `VenuePosSinAparato` → `schema.prisma:L991`
- `VenuePricingStructure` → `schema.prisma:L7062`
- `VenueRoleConfig` → `schema.prisma:L1504`
- `VenueRolePermission` → `schema.prisma:L1408`
- `VenueScaleSettings` → `schema.prisma:L16393`
- `VenueSettings` → `schema.prisma:L869`
- `VenueTenderType` → `schema.prisma:L4550`
- `VenueTenderTypeRevision` → `schema.prisma:L4615`
- `VenueTransaction` → `schema.prisma:L4742`
- `VenueWhatsappActivation` → `schema.prisma:L720`
- `WalletCardDesign` → `schema.prisma:L8222`
- `WalletPass` → `schema.prisma:L8123`
- `WalletPassRegistration` → `schema.prisma:L8189`
- `WebhookEvent` → `schema.prisma:L5143`
- `WebhookSubscription` → `schema.prisma:L6561`
- `WhatsappContactWindow` → `schema.prisma:L738`
- `WhatsappInboundEvent` → `schema.prisma:L758`
- `WorkShiftAssignment` → `schema.prisma:L3541`
- `WorkShiftTemplate` → `schema.prisma:L3518`
- `Zone` → `schema.prisma:L161`
