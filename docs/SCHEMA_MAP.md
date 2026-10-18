# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **425 models / 395 enums / ~19,800 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `FloorPlanPublication`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueIvaPorProducto`, `VenuePosSinAparato`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `CapabilityGrant`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `HybridBillingOperation`, `HybridCampaign`, `HybridContract`, `HybridContractSelection`, `HybridCreditAllocation`, `HybridOfferPublication`, `HybridPaymentPeriod`, `HybridPromotionGroup`, `HybridPurchase`, `HybridRedemption`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                        |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffAssignment`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffPosition`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                                                                                                        |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `ProductPriceHistory`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                                                                                                                                                |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `InventoryWasteReport`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `ShopifyConnectIntent`, `ShopifyImportIssue`, `ShopifyInboundEvent`, `ShopifyLocationLink`, `ShopifyReviewItem`, `ShopifyStockOutbox`, `ShopifyStore`, `ShopifyVariantLink`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                     |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryConnectIntent`, `DeliveryLineAction`, `DeliveryOrderEvent`, `DeliveryStoreRevocation`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `OnlineOrder`, `OnlineOrderingSettings`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                                                                                                                                               |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CfdiGlobalOrden`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `OrderItemSelloIva`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                                                                                                                                         |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `ClassSessionPayState`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `ServiceEarning`, `ServicePayPeriod`, `ServicePayTable`, `ServicePayTableCell`, `ServicePayTableVersion`, `StaffPayLevel`, `StaffPayLevelAssignment`, `StaffPayStatement`, `StaffPayTipWindow`, `StaffPayVenueWindow`, `VenueCommission`                                                                                                                                                                                                                                             |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `AggregatorBooking`, `AggregatorCapacityRule`, `AggregatorConnection`, `AggregatorInboundEvent`, `AggregatorOutbox`, `AggregatorProductLink`, `AggregatorSessionLink`, `AggregatorVisit`, `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                          |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalAttemptResolution`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerExternalIdentity`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L17660`
- `AccountMapping` → `schema.prisma:L17555`
- `ActivityLog` → `schema.prisma:L7694`
- `Aggregator` → `schema.prisma:L15806`
- `AggregatorBooking` → `schema.prisma:L15114`
- `AggregatorCapacityRule` → `schema.prisma:L15095`
- `AggregatorConnection` → `schema.prisma:L15020`
- `AggregatorInboundEvent` → `schema.prisma:L15183`
- `AggregatorOutbox` → `schema.prisma:L15203`
- `AggregatorProductLink` → `schema.prisma:L15052`
- `AggregatorSessionLink` → `schema.prisma:L15071`
- `AggregatorVisit` → `schema.prisma:L15140`
- `AngelPayUserAccount` → `schema.prisma:L6239`
- `AppUpdate` → `schema.prisma:L13681`
- `Area` → `schema.prisma:L3334`
- `AreaTicket` → `schema.prisma:L16355`
- `AreaTicketCheckoutSession` → `schema.prisma:L16477`
- `AreaTicketExternalIncident` → `schema.prisma:L16724`
- `AreaTicketExternalSettlement` → `schema.prisma:L16689`
- `AreaTicketFulfillment` → `schema.prisma:L16553`
- `AreaTicketInventoryReservation` → `schema.prisma:L16448`
- `AreaTicketLine` → `schema.prisma:L16416`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16509`
- `AreaTicketPrintAttempt` → `schema.prisma:L16532`
- `BankStatement` → `schema.prisma:L17429`
- `BankStatementLine` → `schema.prisma:L17450`
- `BillingObligationConflict` → `schema.prisma:L5269`
- `BillingTaxProfile` → `schema.prisma:L18252`
- `BirthdayAutomation` → `schema.prisma:L8018`
- `BulkCommandOperation` → `schema.prisma:L10953`
- `CalendarSyncOutbox` → `schema.prisma:L14903`
- `CampaignDelivery` → `schema.prisma:L13839`
- `CapabilityGrant` → `schema.prisma:L5009`
- `CashCloseout` → `schema.prisma:L11338`
- `CashDeposit` → `schema.prisma:L13483`
- `CashDrawerEvent` → `schema.prisma:L15643`
- `CashDrawerSession` → `schema.prisma:L15604`
- `CashOutCommissionRate` → `schema.prisma:L18069`
- `CashOutScheduleDay` → `schema.prisma:L18092`
- `CashOutWithdrawal` → `schema.prisma:L18154`
- `CatalogBindingBatch` → `schema.prisma:L12369`
- `CatalogBindingLine` → `schema.prisma:L12405`
- `CatalogBrand` → `schema.prisma:L11822`
- `CatalogClientObservation` → `schema.prisma:L12135`
- `CatalogClientReadinessOverride` → `schema.prisma:L12154`
- `CatalogFamily` → `schema.prisma:L11872`
- `CatalogIdempotencyRecord` → `schema.prisma:L12268`
- `CatalogIdentifier` → `schema.prisma:L12003`
- `CatalogImportBatch` → `schema.prisma:L12311`
- `CatalogImportLine` → `schema.prisma:L12348`
- `CatalogItem` → `schema.prisma:L11905`
- `CatalogItemBusinessType` → `schema.prisma:L11965`
- `CatalogItemPrice` → `schema.prisma:L12053`
- `CatalogManufacturer` → `schema.prisma:L11846`
- `CatalogProductTypeMapping` → `schema.prisma:L11982`
- `CatalogPublicationBatch` → `schema.prisma:L12433`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12527`
- `CatalogPublicationLine` → `schema.prisma:L12474`
- `CatalogPublicationOutbox` → `schema.prisma:L12570`
- `CatalogValidationProfile` → `schema.prisma:L12024`
- `CatalogVenueBinding` → `schema.prisma:L12182`
- `CatalogVenueClientRequirement` → `schema.prisma:L12109`
- `CatalogVenueEventSequence` → `schema.prisma:L12553`
- `CatalogVenueOverride` → `schema.prisma:L12224`
- `CatalogVenueRollout` → `schema.prisma:L12084`
- `Cfdi` → `schema.prisma:L17251`
- `CfdiGlobalOrden` → `schema.prisma:L17382`
- `ChatbotTokenBudget` → `schema.prisma:L10599`
- `ChatConversation` → `schema.prisma:L10454`
- `ChatFeedback` → `schema.prisma:L10540`
- `ChatLearningEvent` → `schema.prisma:L10497`
- `ChatMessage` → `schema.prisma:L10477`
- `ChatTrainingData` → `schema.prisma:L10411`
- `CheckoutSession` → `schema.prisma:L6519`
- `ClassSession` → `schema.prisma:L14497`
- `ClassSessionPayState` → `schema.prisma:L19212`
- `CommissionCalculation` → `schema.prisma:L13258`
- `CommissionClawback` → `schema.prisma:L13435`
- `CommissionConfig` → `schema.prisma:L13017`
- `CommissionMilestone` → `schema.prisma:L13174`
- `CommissionOverride` → `schema.prisma:L13101`
- `CommissionPayout` → `schema.prisma:L13386`
- `CommissionSummary` → `schema.prisma:L13325`
- `CommissionTier` → `schema.prisma:L13138`
- `ConsentEvent` → `schema.prisma:L7880`
- `Consumer` → `schema.prisma:L8110`
- `ConsumerAuthAccount` → `schema.prisma:L8135`
- `CouponCode` → `schema.prisma:L9082`
- `CouponRedemption` → `schema.prisma:L9113`
- `CreditAssessmentHistory` → `schema.prisma:L11447`
- `CreditItemBalance` → `schema.prisma:L15394`
- `CreditOffer` → `schema.prisma:L11466`
- `CreditPack` → `schema.prisma:L15303`
- `CreditPackItem` → `schema.prisma:L15332`
- `CreditPackPurchase` → `schema.prisma:L15349`
- `CreditTransaction` → `schema.prisma:L15416`
- `Customer` → `schema.prisma:L7735`
- `CustomerApprovalDelivery` → `schema.prisma:L10112`
- `CustomerApprovalOutbox` → `schema.prisma:L10087`
- `CustomerCampaign` → `schema.prisma:L7968`
- `CustomerCampaignDelivery` → `schema.prisma:L8050`
- `CustomerCaptureToken` → `schema.prisma:L7916`
- `CustomerDiscount` → `schema.prisma:L9133`
- `CustomerExternalIdentity` → `schema.prisma:L15170`
- `CustomerGroup` → `schema.prisma:L8174`
- `CustomerOrderMetric` → `schema.prisma:L4223`
- `CustomerTaxProfile` → `schema.prisma:L17401`
- `DeliveryActivationRequest` → `schema.prisma:L6978`
- `DeliveryChannelLink` → `schema.prisma:L6817`
- `DeliveryConnectIntent` → `schema.prisma:L6929`
- `DeliveryLineAction` → `schema.prisma:L6890`
- `DeliveryOrderEvent` → `schema.prisma:L7002`
- `DeliveryStoreRevocation` → `schema.prisma:L6966`
- `DeviceToken` → `schema.prisma:L9407`
- `DigitalReceipt` → `schema.prisma:L4822`
- `Discount` → `schema.prisma:L8772`
- `EcommerceMerchant` → `schema.prisma:L6331`
- `EmailQuotaLedger` → `schema.prisma:L8097`
- `EmailSuppression` → `schema.prisma:L8085`
- `EmailTemplate` → `schema.prisma:L13778`
- `Employee` → `schema.prisma:L17917`
- `Estimate` → `schema.prisma:L15713`
- `EstimateItem` → `schema.prisma:L15741`
- `Expense` → `schema.prisma:L17704`
- `ExternalBusyBlock` → `schema.prisma:L14796`
- `Feature` → `schema.prisma:L4951`
- `FeeSchedule` → `schema.prisma:L5331`
- `FeeTier` → `schema.prisma:L5342`
- `FinancialAccount` → `schema.prisma:L15903`
- `FinancialConnection` → `schema.prisma:L15872`
- `FinancialProvider` → `schema.prisma:L15858`
- `FiscalEmisor` → `schema.prisma:L17162`
- `FiscalLossCarryforward` → `schema.prisma:L17827`
- `FixedAsset` → `schema.prisma:L17845`
- `FixedAssetDepreciation` → `schema.prisma:L17874`
- `FloorElement` → `schema.prisma:L3419`
- `FloorPlanPublication` → `schema.prisma:L3459`
- `FulfillmentArea` → `schema.prisma:L16220`
- `GeofenceRule` → `schema.prisma:L11038`
- `GoogleCalendarChannel` → `schema.prisma:L14773`
- `GoogleCalendarConnection` → `schema.prisma:L14725`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14826`
- `GoogleOAuthSession` → `schema.prisma:L14848`
- `HolidayCalendar` → `schema.prisma:L7618`
- `HybridBillingOperation` → `schema.prisma:L5193`
- `HybridCampaign` → `schema.prisma:L5034`
- `HybridContract` → `schema.prisma:L5150`
- `HybridContractSelection` → `schema.prisma:L5182`
- `HybridCreditAllocation` → `schema.prisma:L5249`
- `HybridOfferPublication` → `schema.prisma:L5097`
- `HybridPaymentPeriod` → `schema.prisma:L5228`
- `HybridPromotionGroup` → `schema.prisma:L5078`
- `HybridPurchase` → `schema.prisma:L5117`
- `HybridRedemption` → `schema.prisma:L5211`
- `IdempotencyRequest` → `schema.prisma:L12892`
- `InterVenueTransfer` → `schema.prisma:L3162`
- `InterVenueTransferAllocation` → `schema.prisma:L3245`
- `InterVenueTransferItem` → `schema.prisma:L3214`
- `InterVenueTransferReceipt` → `schema.prisma:L3272`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3288`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3316`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3300`
- `Inventory` → `schema.prisma:L2084`
- `InventoryMovement` → `schema.prisma:L2184`
- `InventoryPosting` → `schema.prisma:L2279`
- `InventoryPostingLine` → `schema.prisma:L2319`
- `InventoryTransfer` → `schema.prisma:L15685`
- `InventoryWasteReport` → `schema.prisma:L2139`
- `Invitation` → `schema.prisma:L1550`
- `Invoice` → `schema.prisma:L5354`
- `InvoiceItem` → `schema.prisma:L5380`
- `ItemCategory` → `schema.prisma:L12605`
- `JournalEntry` → `schema.prisma:L17613`
- `JournalLine` → `schema.prisma:L17642`
- `KdsOrder` → `schema.prisma:L15951`
- `KdsOrderItem` → `schema.prisma:L16018`
- `KioskCheckInAttempt` → `schema.prisma:L18575`
- `KioskCheckInChallenge` → `schema.prisma:L18529`
- `KioskOutreachOutbox` → `schema.prisma:L18596`
- `LaunchCampaign` → `schema.prisma:L18934`
- `LaunchCampaignRedemption` → `schema.prisma:L19051`
- `LearnedPatterns` → `schema.prisma:L10521`
- `LedgerAccount` → `schema.prisma:L17505`
- `LiveDemoSession` → `schema.prisma:L868`
- `LowStockAlert` → `schema.prisma:L2992`
- `LoyaltyConfig` → `schema.prisma:L8204`
- `LoyaltyTransaction` → `schema.prisma:L8247`
- `MarketingCampaign` → `schema.prisma:L13796`
- `McpAuthCode` → `schema.prisma:L17043`
- `McpOAuthClient` → `schema.prisma:L17027`
- `McpRefreshToken` → `schema.prisma:L17061`
- `McpToolCall` → `schema.prisma:L17083`
- `MeasurementUnit` → `schema.prisma:L15791`
- `Menu` → `schema.prisma:L1768`
- `MenuCategory` → `schema.prisma:L1705`
- `MenuCategoryAssignment` → `schema.prisma:L1803`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16957`
- `MerchantAccount` → `schema.prisma:L6069`
- `MerchantFiscalConfig` → `schema.prisma:L17222`
- `MerchantRevenueShare` → `schema.prisma:L7198`
- `MerchantRoutingRule` → `schema.prisma:L6191`
- `MilestoneAchievement` → `schema.prisma:L13219`
- `Modifier` → `schema.prisma:L4424`
- `ModifierGroup` → `schema.prisma:L4388`
- `Module` → `schema.prisma:L11514`
- `MoneyAnomaly` → `schema.prisma:L7101`
- `MonthlyVenueProfit` → `schema.prisma:L7644`
- `Notification` → `schema.prisma:L9309`
- `NotificationPreference` → `schema.prisma:L9356`
- `NotificationTemplate` → `schema.prisma:L9383`
- `OAuthState` → `schema.prisma:L1601`
- `OnboardingProgress` → `schema.prisma:L1619`
- `OnlineOrder` → `schema.prisma:L19754`
- `OnlineOrderingSettings` → `schema.prisma:L19730`
- `Order` → `schema.prisma:L3948`
- `OrderAction` → `schema.prisma:L4495`
- `OrderCustomer` → `schema.prisma:L4202`
- `OrderDiscount` → `schema.prisma:L9165`
- `OrderFulfillment` → `schema.prisma:L16275`
- `OrderFulfillmentLine` → `schema.prisma:L16306`
- `OrderItem` → `schema.prisma:L4238`
- `OrderItemModifier` → `schema.prisma:L4477`
- `OrderItemSelloIva` → `schema.prisma:L17362`
- `OrderPromotion` → `schema.prisma:L18492`
- `OrderServiceCharge` → `schema.prisma:L9254`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13597`
- `OrganizationEntitlement` → `schema.prisma:L11797`
- `OrganizationGoal` → `schema.prisma:L13555`
- `OrganizationModule` → `schema.prisma:L11574`
- `OrganizationPaymentConfig` → `schema.prisma:L6643`
- `OrganizationPayoutConfig` → `schema.prisma:L13630`
- `OrganizationPricingStructure` → `schema.prisma:L6675`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13578`
- `OtpChallenge` → `schema.prisma:L8154`
- `OvertimeApproval` → `schema.prisma:L3663`
- `PartnerAPIKey` → `schema.prisma:L6473`
- `Payment` → `schema.prisma:L4528`
- `PaymentAllocation` → `schema.prisma:L4801`
- `PaymentEffect` → `schema.prisma:L18866`
- `PaymentLink` → `schema.prisma:L15462`
- `PaymentLinkAttribution` → `schema.prisma:L15570`
- `PaymentLinkItem` → `schema.prisma:L15525`
- `PaymentLinkItemModifier` → `schema.prisma:L15552`
- `PaymentProvider` → `schema.prisma:L6028`
- `PayrollLine` → `schema.prisma:L17988`
- `PayrollRun` → `schema.prisma:L17957`
- `PerformanceGoal` → `schema.prisma:L13532`
- `PermissionOverride` → `schema.prisma:L1474`
- `PermissionSet` → `schema.prisma:L1497`
- `PlatformAnnouncement` → `schema.prisma:L18656`
- `PlatformAnnouncementClick` → `schema.prisma:L18721`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18758`
- `PlatformCfdi` → `schema.prisma:L18285`
- `PlatformEmisor` → `schema.prisma:L18225`
- `PlatformSettings` → `schema.prisma:L6450`
- `PosCommand` → `schema.prisma:L9437`
- `PosConnectionStatus` → `schema.prisma:L1016`
- `PosSyncIntent` → `schema.prisma:L18363`
- `PricingPolicy` → `schema.prisma:L2888`
- `Printer` → `schema.prisma:L16076`
- `PrintGateway` → `schema.prisma:L16133`
- `PrintJob` → `schema.prisma:L16856`
- `PrintStation` → `schema.prisma:L16151`
- `PrivacyNoticeVersion` → `schema.prisma:L7902`
- `ProcessedStripeEvent` → `schema.prisma:L7087`
- `ProcessorReliabilityMetric` → `schema.prisma:L7572`
- `Product` → `schema.prisma:L1821`
- `ProductModifierGroup` → `schema.prisma:L4465`
- `ProductOption` → `schema.prisma:L15768`
- `ProductOptionValue` → `schema.prisma:L15779`
- `ProductPriceHistory` → `schema.prisma:L2068`
- `ProductStaff` → `schema.prisma:L14412`
- `PromoterBankAccount` → `schema.prisma:L18108`
- `PromoterCommissionEntry` → `schema.prisma:L18127`
- `PromoterLocationPing` → `schema.prisma:L3914`
- `Promotion` → `schema.prisma:L18414`
- `PromotionGroup` → `schema.prisma:L18453`
- `PromotionOption` → `schema.prisma:L18469`
- `ProviderCostStructure` → `schema.prisma:L7123`
- `ProviderEventLog` → `schema.prisma:L6752`
- `PurchaseOrder` → `schema.prisma:L2595`
- `PurchaseOrderInvoice` → `schema.prisma:L2740`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2807`
- `PurchaseOrderItem` → `schema.prisma:L2653`
- `RateCorrectionBatch` → `schema.prisma:L7348`
- `RateCorrectionEntry` → `schema.prisma:L7390`
- `RawMaterial` → `schema.prisma:L2351`
- `RawMaterialMovement` → `schema.prisma:L2941`
- `RawMaterialPresentation` → `schema.prisma:L2427`
- `ReceiptLayout` → `schema.prisma:L18900`
- `Recipe` → `schema.prisma:L2447`
- `RecipeLine` → `schema.prisma:L2471`
- `Referral` → `schema.prisma:L8620`
- `ReferralProgramConfig` → `schema.prisma:L8585`
- `ReferralRewardGrant` → `schema.prisma:L8711`
- `ReferralTierReward` → `schema.prisma:L8683`
- `ReferralTierUnlock` → `schema.prisma:L8756`
- `RefreshGrant` → `schema.prisma:L18845`
- `Reservation` → `schema.prisma:L14175`
- `ReservationGoogleEventMapping` → `schema.prisma:L15235`
- `ReservationModifier` → `schema.prisma:L14360`
- `ReservationReminderSent` → `schema.prisma:L14343`
- `ReservationSettings` → `schema.prisma:L14584`
- `ReservationWaitlistEntry` → `schema.prisma:L14552`
- `Review` → `schema.prisma:L5398`
- `SalesRetention` → `schema.prisma:L17808`
- `SaleVerification` → `schema.prisma:L4855`
- `ScaleProfile` → `schema.prisma:L16597`
- `ScheduledCommand` → `schema.prisma:L10998`
- `SerializedItem` → `schema.prisma:L12648`
- `SerializedItemCustodyEvent` → `schema.prisma:L12815`
- `ServiceCharge` → `schema.prisma:L9225`
- `ServiceEarning` → `schema.prisma:L19274`
- `ServicePayPeriod` → `schema.prisma:L19250`
- `ServicePayTable` → `schema.prisma:L19158`
- `ServicePayTableCell` → `schema.prisma:L19200`
- `ServicePayTableVersion` → `schema.prisma:L19175`
- `Session` → `schema.prisma:L18824`
- `SettlementConfiguration` → `schema.prisma:L7423`
- `SettlementConfirmation` → `schema.prisma:L7536`
- `SettlementIncident` → `schema.prisma:L7487`
- `SettlementSimulation` → `schema.prisma:L7458`
- `Shift` → `schema.prisma:L3474`
- `ShopifyConnectIntent` → `schema.prisma:L19595`
- `ShopifyImportIssue` → `schema.prisma:L19649`
- `ShopifyInboundEvent` → `schema.prisma:L19571`
- `ShopifyLocationLink` → `schema.prisma:L19445`
- `ShopifyReviewItem` → `schema.prisma:L19617`
- `ShopifyStockOutbox` → `schema.prisma:L19541`
- `ShopifyStore` → `schema.prisma:L19416`
- `ShopifyVariantLink` → `schema.prisma:L19493`
- `SimRegistrationRequest` → `schema.prisma:L12853`
- `SimRegistrationRequestItem` → `schema.prisma:L12875`
- `SlotHold` → `schema.prisma:L14443`
- `Staff` → `schema.prisma:L1036`
- `StaffAssignment` → `schema.prisma:L3761`
- `StaffDocument` → `schema.prisma:L3785`
- `StaffOnboardingState` → `schema.prisma:L16927`
- `StaffOrganization` → `schema.prisma:L1373`
- `StaffPasskey` → `schema.prisma:L1400`
- `StaffPayLevel` → `schema.prisma:L19122`
- `StaffPayLevelAssignment` → `schema.prisma:L19140`
- `StaffPayStatement` → `schema.prisma:L19306`
- `StaffPayTipWindow` → `schema.prisma:L19668`
- `StaffPayVenueWindow` → `schema.prisma:L19685`
- `StaffPosition` → `schema.prisma:L3740`
- `StaffSchedule` → `schema.prisma:L14383`
- `StaffScheduleException` → `schema.prisma:L14395`
- `StaffVenue` → `schema.prisma:L1297`
- `StaffWorkSchedule` → `schema.prisma:L3599`
- `StaffWorkScheduleException` → `schema.prisma:L3697`
- `StampCard` → `schema.prisma:L8468`
- `StampEvent` → `schema.prisma:L8507`
- `StampReward` → `schema.prisma:L8545`
- `StockAlertConfig` → `schema.prisma:L13514`
- `StockBatch` → `schema.prisma:L3111`
- `StockCount` → `schema.prisma:L3024`
- `StockCountItem` → `schema.prisma:L3052`
- `StripeWebhookEvent` → `schema.prisma:L7070`
- `Supplier` → `schema.prisma:L2506`
- `SupplierItemCode` → `schema.prisma:L2851`
- `SupplierPricing` → `schema.prisma:L2561`
- `Table` → `schema.prisma:L3365`
- `Terminal` → `schema.prisma:L5449`
- `TerminalAttemptResolution` → `schema.prisma:L5887`
- `TerminalHealth` → `schema.prisma:L5707`
- `TerminalLog` → `schema.prisma:L5681`
- `TerminalOrder` → `schema.prisma:L5931`
- `TerminalOrderItem` → `schema.prisma:L6006`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5859`
- `TerminalPaymentRequest` → `schema.prisma:L5778`
- `TimeEntry` → `schema.prisma:L3827`
- `TimeEntryBreak` → `schema.prisma:L3896`
- `TokenPurchase` → `schema.prisma:L10670`
- `TokenUsageRecord` → `schema.prisma:L10642`
- `TpvCommandHistory` → `schema.prisma:L10904`
- `TpvCommandQueue` → `schema.prisma:L10842`
- `TpvFeedback` → `schema.prisma:L10555`
- `TpvMessage` → `schema.prisma:L13871`
- `TpvMessageDelivery` → `schema.prisma:L13923`
- `TpvMessageResponse` → `schema.prisma:L13946`
- `TrainingModule` → `schema.prisma:L14001`
- `TrainingProgress` → `schema.prisma:L14078`
- `TrainingQuizQuestion` → `schema.prisma:L14060`
- `TrainingStep` → `schema.prisma:L14040`
- `TransactionCost` → `schema.prisma:L7286`
- `UnitConversion` → `schema.prisma:L2919`
- `UpsellAcceptance` → `schema.prisma:L9041`
- `UpsellAiRun` → `schema.prisma:L9061`
- `UpsellImpression` → `schema.prisma:L9001`
- `UpsellRule` → `schema.prisma:L8921`
- `user_sessions` → `schema.prisma:L6508`
- `Venue` → `schema.prisma:L185`
- `VenueAreaTicketSettings` → `schema.prisma:L16334`
- `VenueChatMessage` → `schema.prisma:L844`
- `VenueChatSession` → `schema.prisma:L799`
- `VenueCommission` → `schema.prisma:L15929`
- `VenueCreditAssessment` → `schema.prisma:L11386`
- `VenueCryptoConfig` → `schema.prisma:L13738`
- `VenueFeature` → `schema.prisma:L4969`
- `VenueIvaPorProducto` → `schema.prisma:L999`
- `VenueModule` → `schema.prisma:L11546`
- `VenuePaymentConfig` → `schema.prisma:L6609`
- `VenuePaymentLinkSettings` → `schema.prisma:L15268`
- `VenuePosSinAparato` → `schema.prisma:L1010`
- `VenuePricingStructure` → `schema.prisma:L7226`
- `VenueRoleConfig` → `schema.prisma:L1526`
- `VenueRolePermission` → `schema.prisma:L1430`
- `VenueScaleSettings` → `schema.prisma:L16585`
- `VenueSettings` → `schema.prisma:L884`
- `VenueTenderType` → `schema.prisma:L4714`
- `VenueTenderTypeRevision` → `schema.prisma:L4779`
- `VenueTransaction` → `schema.prisma:L4906`
- `VenueWhatsappActivation` → `schema.prisma:L735`
- `WalletCardDesign` → `schema.prisma:L8386`
- `WalletPass` → `schema.prisma:L8287`
- `WalletPassRegistration` → `schema.prisma:L8353`
- `WebhookEvent` → `schema.prisma:L5307`
- `WebhookSubscription` → `schema.prisma:L6725`
- `WhatsappContactWindow` → `schema.prisma:L753`
- `WhatsappInboundEvent` → `schema.prisma:L773`
- `WorkShiftAssignment` → `schema.prisma:L3639`
- `WorkShiftTemplate` → `schema.prisma:L3616`
- `Zone` → `schema.prisma:L168`
