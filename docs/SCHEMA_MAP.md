# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **412 models / 378 enums / ~19,200 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L17516`
- `AccountMapping` → `schema.prisma:L17411`
- `ActivityLog` → `schema.prisma:L7571`
- `Aggregator` → `schema.prisma:L15682`
- `AggregatorBooking` → `schema.prisma:L14990`
- `AggregatorCapacityRule` → `schema.prisma:L14971`
- `AggregatorConnection` → `schema.prisma:L14896`
- `AggregatorInboundEvent` → `schema.prisma:L15059`
- `AggregatorOutbox` → `schema.prisma:L15079`
- `AggregatorProductLink` → `schema.prisma:L14928`
- `AggregatorSessionLink` → `schema.prisma:L14947`
- `AggregatorVisit` → `schema.prisma:L15016`
- `AngelPayUserAccount` → `schema.prisma:L6116`
- `AppUpdate` → `schema.prisma:L13557`
- `Area` → `schema.prisma:L3281`
- `AreaTicket` → `schema.prisma:L16218`
- `AreaTicketCheckoutSession` → `schema.prisma:L16340`
- `AreaTicketExternalIncident` → `schema.prisma:L16587`
- `AreaTicketExternalSettlement` → `schema.prisma:L16552`
- `AreaTicketFulfillment` → `schema.prisma:L16416`
- `AreaTicketInventoryReservation` → `schema.prisma:L16311`
- `AreaTicketLine` → `schema.prisma:L16279`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16372`
- `AreaTicketPrintAttempt` → `schema.prisma:L16395`
- `BankStatement` → `schema.prisma:L17285`
- `BankStatementLine` → `schema.prisma:L17306`
- `BillingObligationConflict` → `schema.prisma:L5146`
- `BillingTaxProfile` → `schema.prisma:L18108`
- `BirthdayAutomation` → `schema.prisma:L7895`
- `BulkCommandOperation` → `schema.prisma:L10829`
- `CalendarSyncOutbox` → `schema.prisma:L14779`
- `CampaignDelivery` → `schema.prisma:L13715`
- `CapabilityGrant` → `schema.prisma:L4886`
- `CashCloseout` → `schema.prisma:L11214`
- `CashDeposit` → `schema.prisma:L13359`
- `CashDrawerEvent` → `schema.prisma:L15519`
- `CashDrawerSession` → `schema.prisma:L15480`
- `CashOutCommissionRate` → `schema.prisma:L17925`
- `CashOutScheduleDay` → `schema.prisma:L17948`
- `CashOutWithdrawal` → `schema.prisma:L18010`
- `CatalogBindingBatch` → `schema.prisma:L12245`
- `CatalogBindingLine` → `schema.prisma:L12281`
- `CatalogBrand` → `schema.prisma:L11698`
- `CatalogClientObservation` → `schema.prisma:L12011`
- `CatalogClientReadinessOverride` → `schema.prisma:L12030`
- `CatalogFamily` → `schema.prisma:L11748`
- `CatalogIdempotencyRecord` → `schema.prisma:L12144`
- `CatalogIdentifier` → `schema.prisma:L11879`
- `CatalogImportBatch` → `schema.prisma:L12187`
- `CatalogImportLine` → `schema.prisma:L12224`
- `CatalogItem` → `schema.prisma:L11781`
- `CatalogItemBusinessType` → `schema.prisma:L11841`
- `CatalogItemPrice` → `schema.prisma:L11929`
- `CatalogManufacturer` → `schema.prisma:L11722`
- `CatalogProductTypeMapping` → `schema.prisma:L11858`
- `CatalogPublicationBatch` → `schema.prisma:L12309`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12403`
- `CatalogPublicationLine` → `schema.prisma:L12350`
- `CatalogPublicationOutbox` → `schema.prisma:L12446`
- `CatalogValidationProfile` → `schema.prisma:L11900`
- `CatalogVenueBinding` → `schema.prisma:L12058`
- `CatalogVenueClientRequirement` → `schema.prisma:L11985`
- `CatalogVenueEventSequence` → `schema.prisma:L12429`
- `CatalogVenueOverride` → `schema.prisma:L12100`
- `CatalogVenueRollout` → `schema.prisma:L11960`
- `Cfdi` → `schema.prisma:L17113`
- `CfdiGlobalOrden` → `schema.prisma:L17238`
- `ChatbotTokenBudget` → `schema.prisma:L10475`
- `ChatConversation` → `schema.prisma:L10330`
- `ChatFeedback` → `schema.prisma:L10416`
- `ChatLearningEvent` → `schema.prisma:L10373`
- `ChatMessage` → `schema.prisma:L10353`
- `ChatTrainingData` → `schema.prisma:L10287`
- `CheckoutSession` → `schema.prisma:L6396`
- `ClassSession` → `schema.prisma:L14373`
- `ClassSessionPayState` → `schema.prisma:L19068`
- `CommissionCalculation` → `schema.prisma:L13134`
- `CommissionClawback` → `schema.prisma:L13311`
- `CommissionConfig` → `schema.prisma:L12893`
- `CommissionMilestone` → `schema.prisma:L13050`
- `CommissionOverride` → `schema.prisma:L12977`
- `CommissionPayout` → `schema.prisma:L13262`
- `CommissionSummary` → `schema.prisma:L13201`
- `CommissionTier` → `schema.prisma:L13014`
- `ConsentEvent` → `schema.prisma:L7757`
- `Consumer` → `schema.prisma:L7987`
- `ConsumerAuthAccount` → `schema.prisma:L8012`
- `CouponCode` → `schema.prisma:L8959`
- `CouponRedemption` → `schema.prisma:L8990`
- `CreditAssessmentHistory` → `schema.prisma:L11323`
- `CreditItemBalance` → `schema.prisma:L15270`
- `CreditOffer` → `schema.prisma:L11342`
- `CreditPack` → `schema.prisma:L15179`
- `CreditPackItem` → `schema.prisma:L15208`
- `CreditPackPurchase` → `schema.prisma:L15225`
- `CreditTransaction` → `schema.prisma:L15292`
- `Customer` → `schema.prisma:L7612`
- `CustomerApprovalDelivery` → `schema.prisma:L9989`
- `CustomerApprovalOutbox` → `schema.prisma:L9964`
- `CustomerCampaign` → `schema.prisma:L7845`
- `CustomerCampaignDelivery` → `schema.prisma:L7927`
- `CustomerCaptureToken` → `schema.prisma:L7793`
- `CustomerDiscount` → `schema.prisma:L9010`
- `CustomerExternalIdentity` → `schema.prisma:L15046`
- `CustomerGroup` → `schema.prisma:L8051`
- `CustomerOrderMetric` → `schema.prisma:L4102`
- `CustomerTaxProfile` → `schema.prisma:L17257`
- `DeliveryActivationRequest` → `schema.prisma:L6855`
- `DeliveryChannelLink` → `schema.prisma:L6694`
- `DeliveryConnectIntent` → `schema.prisma:L6806`
- `DeliveryLineAction` → `schema.prisma:L6767`
- `DeliveryOrderEvent` → `schema.prisma:L6879`
- `DeliveryStoreRevocation` → `schema.prisma:L6843`
- `DeviceToken` → `schema.prisma:L9284`
- `DigitalReceipt` → `schema.prisma:L4699`
- `Discount` → `schema.prisma:L8649`
- `EcommerceMerchant` → `schema.prisma:L6208`
- `EmailQuotaLedger` → `schema.prisma:L7974`
- `EmailSuppression` → `schema.prisma:L7962`
- `EmailTemplate` → `schema.prisma:L13654`
- `Employee` → `schema.prisma:L17773`
- `Estimate` → `schema.prisma:L15589`
- `EstimateItem` → `schema.prisma:L15617`
- `Expense` → `schema.prisma:L17560`
- `ExternalBusyBlock` → `schema.prisma:L14672`
- `Feature` → `schema.prisma:L4828`
- `FeeSchedule` → `schema.prisma:L5208`
- `FeeTier` → `schema.prisma:L5219`
- `FinancialAccount` → `schema.prisma:L15779`
- `FinancialConnection` → `schema.prisma:L15748`
- `FinancialProvider` → `schema.prisma:L15734`
- `FiscalEmisor` → `schema.prisma:L17024`
- `FiscalLossCarryforward` → `schema.prisma:L17683`
- `FixedAsset` → `schema.prisma:L17701`
- `FixedAssetDepreciation` → `schema.prisma:L17730`
- `FloorElement` → `schema.prisma:L3362`
- `FloorPlanPublication` → `schema.prisma:L3402`
- `FulfillmentArea` → `schema.prisma:L16083`
- `GeofenceRule` → `schema.prisma:L10914`
- `GoogleCalendarChannel` → `schema.prisma:L14649`
- `GoogleCalendarConnection` → `schema.prisma:L14601`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14702`
- `GoogleOAuthSession` → `schema.prisma:L14724`
- `HolidayCalendar` → `schema.prisma:L7495`
- `HybridBillingOperation` → `schema.prisma:L5070`
- `HybridCampaign` → `schema.prisma:L4911`
- `HybridContract` → `schema.prisma:L5027`
- `HybridContractSelection` → `schema.prisma:L5059`
- `HybridCreditAllocation` → `schema.prisma:L5126`
- `HybridOfferPublication` → `schema.prisma:L4974`
- `HybridPaymentPeriod` → `schema.prisma:L5105`
- `HybridPromotionGroup` → `schema.prisma:L4955`
- `HybridPurchase` → `schema.prisma:L4994`
- `HybridRedemption` → `schema.prisma:L5088`
- `IdempotencyRequest` → `schema.prisma:L12768`
- `InterVenueTransfer` → `schema.prisma:L3109`
- `InterVenueTransferAllocation` → `schema.prisma:L3192`
- `InterVenueTransferItem` → `schema.prisma:L3161`
- `InterVenueTransferReceipt` → `schema.prisma:L3219`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3235`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3263`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3247`
- `Inventory` → `schema.prisma:L2035`
- `InventoryMovement` → `schema.prisma:L2135`
- `InventoryPosting` → `schema.prisma:L2230`
- `InventoryPostingLine` → `schema.prisma:L2270`
- `InventoryTransfer` → `schema.prisma:L15561`
- `InventoryWasteReport` → `schema.prisma:L2090`
- `Invitation` → `schema.prisma:L1529`
- `Invoice` → `schema.prisma:L5231`
- `InvoiceItem` → `schema.prisma:L5257`
- `ItemCategory` → `schema.prisma:L12481`
- `JournalEntry` → `schema.prisma:L17469`
- `JournalLine` → `schema.prisma:L17498`
- `KdsOrder` → `schema.prisma:L15827`
- `KdsOrderItem` → `schema.prisma:L15890`
- `KioskCheckInAttempt` → `schema.prisma:L18431`
- `KioskCheckInChallenge` → `schema.prisma:L18385`
- `KioskOutreachOutbox` → `schema.prisma:L18452`
- `LaunchCampaign` → `schema.prisma:L18790`
- `LaunchCampaignRedemption` → `schema.prisma:L18907`
- `LearnedPatterns` → `schema.prisma:L10397`
- `LedgerAccount` → `schema.prisma:L17361`
- `LiveDemoSession` → `schema.prisma:L854`
- `LowStockAlert` → `schema.prisma:L2943`
- `LoyaltyConfig` → `schema.prisma:L8081`
- `LoyaltyTransaction` → `schema.prisma:L8124`
- `MarketingCampaign` → `schema.prisma:L13672`
- `McpAuthCode` → `schema.prisma:L16906`
- `McpOAuthClient` → `schema.prisma:L16890`
- `McpRefreshToken` → `schema.prisma:L16924`
- `McpToolCall` → `schema.prisma:L16946`
- `MeasurementUnit` → `schema.prisma:L15667`
- `Menu` → `schema.prisma:L1747`
- `MenuCategory` → `schema.prisma:L1684`
- `MenuCategoryAssignment` → `schema.prisma:L1782`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16820`
- `MerchantAccount` → `schema.prisma:L5946`
- `MerchantFiscalConfig` → `schema.prisma:L17084`
- `MerchantRevenueShare` → `schema.prisma:L7075`
- `MerchantRoutingRule` → `schema.prisma:L6068`
- `MilestoneAchievement` → `schema.prisma:L13095`
- `Modifier` → `schema.prisma:L4301`
- `ModifierGroup` → `schema.prisma:L4265`
- `Module` → `schema.prisma:L11390`
- `MoneyAnomaly` → `schema.prisma:L6978`
- `MonthlyVenueProfit` → `schema.prisma:L7521`
- `Notification` → `schema.prisma:L9186`
- `NotificationPreference` → `schema.prisma:L9233`
- `NotificationTemplate` → `schema.prisma:L9260`
- `OAuthState` → `schema.prisma:L1580`
- `OnboardingProgress` → `schema.prisma:L1598`
- `Order` → `schema.prisma:L3828`
- `OrderAction` → `schema.prisma:L4372`
- `OrderCustomer` → `schema.prisma:L4081`
- `OrderDiscount` → `schema.prisma:L9042`
- `OrderFulfillment` → `schema.prisma:L16138`
- `OrderFulfillmentLine` → `schema.prisma:L16169`
- `OrderItem` → `schema.prisma:L4117`
- `OrderItemModifier` → `schema.prisma:L4354`
- `OrderItemSelloIva` → `schema.prisma:L17218`
- `OrderPromotion` → `schema.prisma:L18348`
- `OrderServiceCharge` → `schema.prisma:L9131`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13473`
- `OrganizationEntitlement` → `schema.prisma:L11673`
- `OrganizationGoal` → `schema.prisma:L13431`
- `OrganizationModule` → `schema.prisma:L11450`
- `OrganizationPaymentConfig` → `schema.prisma:L6520`
- `OrganizationPayoutConfig` → `schema.prisma:L13506`
- `OrganizationPricingStructure` → `schema.prisma:L6552`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13454`
- `OtpChallenge` → `schema.prisma:L8031`
- `OvertimeApproval` → `schema.prisma:L3606`
- `PartnerAPIKey` → `schema.prisma:L6350`
- `Payment` → `schema.prisma:L4405`
- `PaymentAllocation` → `schema.prisma:L4678`
- `PaymentEffect` → `schema.prisma:L18722`
- `PaymentLink` → `schema.prisma:L15338`
- `PaymentLinkAttribution` → `schema.prisma:L15446`
- `PaymentLinkItem` → `schema.prisma:L15401`
- `PaymentLinkItemModifier` → `schema.prisma:L15428`
- `PaymentProvider` → `schema.prisma:L5905`
- `PayrollLine` → `schema.prisma:L17844`
- `PayrollRun` → `schema.prisma:L17813`
- `PerformanceGoal` → `schema.prisma:L13408`
- `PermissionOverride` → `schema.prisma:L1453`
- `PermissionSet` → `schema.prisma:L1476`
- `PlatformAnnouncement` → `schema.prisma:L18512`
- `PlatformAnnouncementClick` → `schema.prisma:L18577`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18614`
- `PlatformCfdi` → `schema.prisma:L18141`
- `PlatformEmisor` → `schema.prisma:L18081`
- `PlatformSettings` → `schema.prisma:L6327`
- `PosCommand` → `schema.prisma:L9314`
- `PosConnectionStatus` → `schema.prisma:L998`
- `PosSyncIntent` → `schema.prisma:L18219`
- `PricingPolicy` → `schema.prisma:L2839`
- `Printer` → `schema.prisma:L15939`
- `PrintGateway` → `schema.prisma:L15996`
- `PrintJob` → `schema.prisma:L16719`
- `PrintStation` → `schema.prisma:L16014`
- `PrivacyNoticeVersion` → `schema.prisma:L7779`
- `ProcessedStripeEvent` → `schema.prisma:L6964`
- `ProcessorReliabilityMetric` → `schema.prisma:L7449`
- `Product` → `schema.prisma:L1800`
- `ProductModifierGroup` → `schema.prisma:L4342`
- `ProductOption` → `schema.prisma:L15644`
- `ProductOptionValue` → `schema.prisma:L15655`
- `ProductStaff` → `schema.prisma:L14288`
- `PromoterBankAccount` → `schema.prisma:L17964`
- `PromoterCommissionEntry` → `schema.prisma:L17983`
- `PromoterLocationPing` → `schema.prisma:L3794`
- `Promotion` → `schema.prisma:L18270`
- `PromotionGroup` → `schema.prisma:L18309`
- `PromotionOption` → `schema.prisma:L18325`
- `ProviderCostStructure` → `schema.prisma:L7000`
- `ProviderEventLog` → `schema.prisma:L6629`
- `PurchaseOrder` → `schema.prisma:L2546`
- `PurchaseOrderInvoice` → `schema.prisma:L2691`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2758`
- `PurchaseOrderItem` → `schema.prisma:L2604`
- `RateCorrectionBatch` → `schema.prisma:L7225`
- `RateCorrectionEntry` → `schema.prisma:L7267`
- `RawMaterial` → `schema.prisma:L2302`
- `RawMaterialMovement` → `schema.prisma:L2892`
- `RawMaterialPresentation` → `schema.prisma:L2378`
- `ReceiptLayout` → `schema.prisma:L18756`
- `Recipe` → `schema.prisma:L2398`
- `RecipeLine` → `schema.prisma:L2422`
- `Referral` → `schema.prisma:L8497`
- `ReferralProgramConfig` → `schema.prisma:L8462`
- `ReferralRewardGrant` → `schema.prisma:L8588`
- `ReferralTierReward` → `schema.prisma:L8560`
- `ReferralTierUnlock` → `schema.prisma:L8633`
- `RefreshGrant` → `schema.prisma:L18701`
- `Reservation` → `schema.prisma:L14051`
- `ReservationGoogleEventMapping` → `schema.prisma:L15111`
- `ReservationModifier` → `schema.prisma:L14236`
- `ReservationReminderSent` → `schema.prisma:L14219`
- `ReservationSettings` → `schema.prisma:L14460`
- `ReservationWaitlistEntry` → `schema.prisma:L14428`
- `Review` → `schema.prisma:L5275`
- `SalesRetention` → `schema.prisma:L17664`
- `SaleVerification` → `schema.prisma:L4732`
- `ScaleProfile` → `schema.prisma:L16460`
- `ScheduledCommand` → `schema.prisma:L10874`
- `SerializedItem` → `schema.prisma:L12524`
- `SerializedItemCustodyEvent` → `schema.prisma:L12691`
- `ServiceCharge` → `schema.prisma:L9102`
- `ServiceEarning` → `schema.prisma:L19130`
- `ServicePayPeriod` → `schema.prisma:L19106`
- `ServicePayTable` → `schema.prisma:L19014`
- `ServicePayTableCell` → `schema.prisma:L19056`
- `ServicePayTableVersion` → `schema.prisma:L19031`
- `Session` → `schema.prisma:L18680`
- `SettlementConfiguration` → `schema.prisma:L7300`
- `SettlementConfirmation` → `schema.prisma:L7413`
- `SettlementIncident` → `schema.prisma:L7364`
- `SettlementSimulation` → `schema.prisma:L7335`
- `Shift` → `schema.prisma:L3417`
- `SimRegistrationRequest` → `schema.prisma:L12729`
- `SimRegistrationRequestItem` → `schema.prisma:L12751`
- `SlotHold` → `schema.prisma:L14319`
- `Staff` → `schema.prisma:L1018`
- `StaffDocument` → `schema.prisma:L3665`
- `StaffOnboardingState` → `schema.prisma:L16790`
- `StaffOrganization` → `schema.prisma:L1352`
- `StaffPasskey` → `schema.prisma:L1379`
- `StaffPayLevel` → `schema.prisma:L18978`
- `StaffPayLevelAssignment` → `schema.prisma:L18996`
- `StaffPayStatement` → `schema.prisma:L19162`
- `StaffPayTipWindow` → `schema.prisma:L19178`
- `StaffPayVenueWindow` → `schema.prisma:L19195`
- `StaffSchedule` → `schema.prisma:L14259`
- `StaffScheduleException` → `schema.prisma:L14271`
- `StaffVenue` → `schema.prisma:L1276`
- `StaffWorkSchedule` → `schema.prisma:L3542`
- `StaffWorkScheduleException` → `schema.prisma:L3640`
- `StampCard` → `schema.prisma:L8345`
- `StampEvent` → `schema.prisma:L8384`
- `StampReward` → `schema.prisma:L8422`
- `StockAlertConfig` → `schema.prisma:L13390`
- `StockBatch` → `schema.prisma:L3058`
- `StockCount` → `schema.prisma:L2975`
- `StockCountItem` → `schema.prisma:L3003`
- `StripeWebhookEvent` → `schema.prisma:L6947`
- `Supplier` → `schema.prisma:L2457`
- `SupplierItemCode` → `schema.prisma:L2802`
- `SupplierPricing` → `schema.prisma:L2512`
- `Table` → `schema.prisma:L3312`
- `Terminal` → `schema.prisma:L5326`
- `TerminalAttemptResolution` → `schema.prisma:L5764`
- `TerminalHealth` → `schema.prisma:L5584`
- `TerminalLog` → `schema.prisma:L5558`
- `TerminalOrder` → `schema.prisma:L5808`
- `TerminalOrderItem` → `schema.prisma:L5883`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5736`
- `TerminalPaymentRequest` → `schema.prisma:L5655`
- `TimeEntry` → `schema.prisma:L3707`
- `TimeEntryBreak` → `schema.prisma:L3776`
- `TokenPurchase` → `schema.prisma:L10546`
- `TokenUsageRecord` → `schema.prisma:L10518`
- `TpvCommandHistory` → `schema.prisma:L10780`
- `TpvCommandQueue` → `schema.prisma:L10718`
- `TpvFeedback` → `schema.prisma:L10431`
- `TpvMessage` → `schema.prisma:L13747`
- `TpvMessageDelivery` → `schema.prisma:L13799`
- `TpvMessageResponse` → `schema.prisma:L13822`
- `TrainingModule` → `schema.prisma:L13877`
- `TrainingProgress` → `schema.prisma:L13954`
- `TrainingQuizQuestion` → `schema.prisma:L13936`
- `TrainingStep` → `schema.prisma:L13916`
- `TransactionCost` → `schema.prisma:L7163`
- `UnitConversion` → `schema.prisma:L2870`
- `UpsellAcceptance` → `schema.prisma:L8918`
- `UpsellAiRun` → `schema.prisma:L8938`
- `UpsellImpression` → `schema.prisma:L8878`
- `UpsellRule` → `schema.prisma:L8798`
- `user_sessions` → `schema.prisma:L6385`
- `Venue` → `schema.prisma:L178`
- `VenueAreaTicketSettings` → `schema.prisma:L16197`
- `VenueChatMessage` → `schema.prisma:L830`
- `VenueChatSession` → `schema.prisma:L785`
- `VenueCommission` → `schema.prisma:L15805`
- `VenueCreditAssessment` → `schema.prisma:L11262`
- `VenueCryptoConfig` → `schema.prisma:L13614`
- `VenueFeature` → `schema.prisma:L4846`
- `VenueIvaPorProducto` → `schema.prisma:L981`
- `VenueModule` → `schema.prisma:L11422`
- `VenuePaymentConfig` → `schema.prisma:L6486`
- `VenuePaymentLinkSettings` → `schema.prisma:L15144`
- `VenuePosSinAparato` → `schema.prisma:L992`
- `VenuePricingStructure` → `schema.prisma:L7103`
- `VenueRoleConfig` → `schema.prisma:L1505`
- `VenueRolePermission` → `schema.prisma:L1409`
- `VenueScaleSettings` → `schema.prisma:L16448`
- `VenueSettings` → `schema.prisma:L870`
- `VenueTenderType` → `schema.prisma:L4591`
- `VenueTenderTypeRevision` → `schema.prisma:L4656`
- `VenueTransaction` → `schema.prisma:L4783`
- `VenueWhatsappActivation` → `schema.prisma:L721`
- `WalletCardDesign` → `schema.prisma:L8263`
- `WalletPass` → `schema.prisma:L8164`
- `WalletPassRegistration` → `schema.prisma:L8230`
- `WebhookEvent` → `schema.prisma:L5184`
- `WebhookSubscription` → `schema.prisma:L6602`
- `WhatsappContactWindow` → `schema.prisma:L739`
- `WhatsappInboundEvent` → `schema.prisma:L759`
- `WorkShiftAssignment` → `schema.prisma:L3582`
- `WorkShiftTemplate` → `schema.prisma:L3559`
- `Zone` → `schema.prisma:L161`
