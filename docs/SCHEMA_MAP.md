# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **427 models / 393 enums / ~19,700 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductGroup`, `ProductGroupModifierGroup`, `ProductGroupOption`, `ProductGroupOptionValue`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `ProductVariantValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
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

- `AccountingPeriodLock` → `schema.prisma:L17736`
- `AccountMapping` → `schema.prisma:L17631`
- `ActivityLog` → `schema.prisma:L7681`
- `Aggregator` → `schema.prisma:L15884`
- `AggregatorBooking` → `schema.prisma:L15101`
- `AggregatorCapacityRule` → `schema.prisma:L15082`
- `AggregatorConnection` → `schema.prisma:L15007`
- `AggregatorInboundEvent` → `schema.prisma:L15170`
- `AggregatorOutbox` → `schema.prisma:L15190`
- `AggregatorProductLink` → `schema.prisma:L15039`
- `AggregatorSessionLink` → `schema.prisma:L15058`
- `AggregatorVisit` → `schema.prisma:L15127`
- `AngelPayUserAccount` → `schema.prisma:L6226`
- `AppUpdate` → `schema.prisma:L13668`
- `Area` → `schema.prisma:L3321`
- `AreaTicket` → `schema.prisma:L16434`
- `AreaTicketCheckoutSession` → `schema.prisma:L16556`
- `AreaTicketExternalIncident` → `schema.prisma:L16803`
- `AreaTicketExternalSettlement` → `schema.prisma:L16768`
- `AreaTicketFulfillment` → `schema.prisma:L16632`
- `AreaTicketInventoryReservation` → `schema.prisma:L16527`
- `AreaTicketLine` → `schema.prisma:L16495`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16588`
- `AreaTicketPrintAttempt` → `schema.prisma:L16611`
- `BankStatement` → `schema.prisma:L17505`
- `BankStatementLine` → `schema.prisma:L17526`
- `BillingObligationConflict` → `schema.prisma:L5256`
- `BillingTaxProfile` → `schema.prisma:L18328`
- `BirthdayAutomation` → `schema.prisma:L8005`
- `BulkCommandOperation` → `schema.prisma:L10940`
- `CalendarSyncOutbox` → `schema.prisma:L14890`
- `CampaignDelivery` → `schema.prisma:L13826`
- `CapabilityGrant` → `schema.prisma:L4996`
- `CashCloseout` → `schema.prisma:L11325`
- `CashDeposit` → `schema.prisma:L13470`
- `CashDrawerEvent` → `schema.prisma:L15630`
- `CashDrawerSession` → `schema.prisma:L15591`
- `CashOutCommissionRate` → `schema.prisma:L18145`
- `CashOutScheduleDay` → `schema.prisma:L18168`
- `CashOutWithdrawal` → `schema.prisma:L18230`
- `CatalogBindingBatch` → `schema.prisma:L12356`
- `CatalogBindingLine` → `schema.prisma:L12392`
- `CatalogBrand` → `schema.prisma:L11809`
- `CatalogClientObservation` → `schema.prisma:L12122`
- `CatalogClientReadinessOverride` → `schema.prisma:L12141`
- `CatalogFamily` → `schema.prisma:L11859`
- `CatalogIdempotencyRecord` → `schema.prisma:L12255`
- `CatalogIdentifier` → `schema.prisma:L11990`
- `CatalogImportBatch` → `schema.prisma:L12298`
- `CatalogImportLine` → `schema.prisma:L12335`
- `CatalogItem` → `schema.prisma:L11892`
- `CatalogItemBusinessType` → `schema.prisma:L11952`
- `CatalogItemPrice` → `schema.prisma:L12040`
- `CatalogManufacturer` → `schema.prisma:L11833`
- `CatalogProductTypeMapping` → `schema.prisma:L11969`
- `CatalogPublicationBatch` → `schema.prisma:L12420`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12514`
- `CatalogPublicationLine` → `schema.prisma:L12461`
- `CatalogPublicationOutbox` → `schema.prisma:L12557`
- `CatalogValidationProfile` → `schema.prisma:L12011`
- `CatalogVenueBinding` → `schema.prisma:L12169`
- `CatalogVenueClientRequirement` → `schema.prisma:L12096`
- `CatalogVenueEventSequence` → `schema.prisma:L12540`
- `CatalogVenueOverride` → `schema.prisma:L12211`
- `CatalogVenueRollout` → `schema.prisma:L12071`
- `Cfdi` → `schema.prisma:L17329`
- `CfdiGlobalOrden` → `schema.prisma:L17458`
- `ChatbotTokenBudget` → `schema.prisma:L10586`
- `ChatConversation` → `schema.prisma:L10441`
- `ChatFeedback` → `schema.prisma:L10527`
- `ChatLearningEvent` → `schema.prisma:L10484`
- `ChatMessage` → `schema.prisma:L10464`
- `ChatTrainingData` → `schema.prisma:L10398`
- `CheckoutSession` → `schema.prisma:L6506`
- `ClassSession` → `schema.prisma:L14484`
- `ClassSessionPayState` → `schema.prisma:L19288`
- `CommissionCalculation` → `schema.prisma:L13245`
- `CommissionClawback` → `schema.prisma:L13422`
- `CommissionConfig` → `schema.prisma:L13004`
- `CommissionMilestone` → `schema.prisma:L13161`
- `CommissionOverride` → `schema.prisma:L13088`
- `CommissionPayout` → `schema.prisma:L13373`
- `CommissionSummary` → `schema.prisma:L13312`
- `CommissionTier` → `schema.prisma:L13125`
- `ConsentEvent` → `schema.prisma:L7867`
- `Consumer` → `schema.prisma:L8097`
- `ConsumerAuthAccount` → `schema.prisma:L8122`
- `CouponCode` → `schema.prisma:L9069`
- `CouponRedemption` → `schema.prisma:L9100`
- `CreditAssessmentHistory` → `schema.prisma:L11434`
- `CreditItemBalance` → `schema.prisma:L15381`
- `CreditOffer` → `schema.prisma:L11453`
- `CreditPack` → `schema.prisma:L15290`
- `CreditPackItem` → `schema.prisma:L15319`
- `CreditPackPurchase` → `schema.prisma:L15336`
- `CreditTransaction` → `schema.prisma:L15403`
- `Customer` → `schema.prisma:L7722`
- `CustomerApprovalDelivery` → `schema.prisma:L10099`
- `CustomerApprovalOutbox` → `schema.prisma:L10074`
- `CustomerCampaign` → `schema.prisma:L7955`
- `CustomerCampaignDelivery` → `schema.prisma:L8037`
- `CustomerCaptureToken` → `schema.prisma:L7903`
- `CustomerDiscount` → `schema.prisma:L9120`
- `CustomerExternalIdentity` → `schema.prisma:L15157`
- `CustomerGroup` → `schema.prisma:L8161`
- `CustomerOrderMetric` → `schema.prisma:L4209`
- `CustomerTaxProfile` → `schema.prisma:L17477`
- `DeliveryActivationRequest` → `schema.prisma:L6965`
- `DeliveryChannelLink` → `schema.prisma:L6804`
- `DeliveryConnectIntent` → `schema.prisma:L6916`
- `DeliveryLineAction` → `schema.prisma:L6877`
- `DeliveryOrderEvent` → `schema.prisma:L6989`
- `DeliveryStoreRevocation` → `schema.prisma:L6953`
- `DeviceToken` → `schema.prisma:L9394`
- `DigitalReceipt` → `schema.prisma:L4809`
- `Discount` → `schema.prisma:L8759`
- `EcommerceMerchant` → `schema.prisma:L6318`
- `EmailQuotaLedger` → `schema.prisma:L8084`
- `EmailSuppression` → `schema.prisma:L8072`
- `EmailTemplate` → `schema.prisma:L13765`
- `Employee` → `schema.prisma:L17993`
- `Estimate` → `schema.prisma:L15700`
- `EstimateItem` → `schema.prisma:L15728`
- `Expense` → `schema.prisma:L17780`
- `ExternalBusyBlock` → `schema.prisma:L14783`
- `Feature` → `schema.prisma:L4938`
- `FeeSchedule` → `schema.prisma:L5318`
- `FeeTier` → `schema.prisma:L5329`
- `FinancialAccount` → `schema.prisma:L15981`
- `FinancialConnection` → `schema.prisma:L15950`
- `FinancialProvider` → `schema.prisma:L15936`
- `FiscalEmisor` → `schema.prisma:L17240`
- `FiscalLossCarryforward` → `schema.prisma:L17903`
- `FixedAsset` → `schema.prisma:L17921`
- `FixedAssetDepreciation` → `schema.prisma:L17950`
- `FloorElement` → `schema.prisma:L3406`
- `FloorPlanPublication` → `schema.prisma:L3446`
- `FulfillmentArea` → `schema.prisma:L16299`
- `GeofenceRule` → `schema.prisma:L11025`
- `GoogleCalendarChannel` → `schema.prisma:L14760`
- `GoogleCalendarConnection` → `schema.prisma:L14712`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14813`
- `GoogleOAuthSession` → `schema.prisma:L14835`
- `HolidayCalendar` → `schema.prisma:L7605`
- `HybridBillingOperation` → `schema.prisma:L5180`
- `HybridCampaign` → `schema.prisma:L5021`
- `HybridContract` → `schema.prisma:L5137`
- `HybridContractSelection` → `schema.prisma:L5169`
- `HybridCreditAllocation` → `schema.prisma:L5236`
- `HybridOfferPublication` → `schema.prisma:L5084`
- `HybridPaymentPeriod` → `schema.prisma:L5215`
- `HybridPromotionGroup` → `schema.prisma:L5065`
- `HybridPurchase` → `schema.prisma:L5104`
- `HybridRedemption` → `schema.prisma:L5198`
- `IdempotencyRequest` → `schema.prisma:L12879`
- `InterVenueTransfer` → `schema.prisma:L3149`
- `InterVenueTransferAllocation` → `schema.prisma:L3232`
- `InterVenueTransferItem` → `schema.prisma:L3201`
- `InterVenueTransferReceipt` → `schema.prisma:L3259`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3275`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3303`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3287`
- `Inventory` → `schema.prisma:L2071`
- `InventoryMovement` → `schema.prisma:L2171`
- `InventoryPosting` → `schema.prisma:L2266`
- `InventoryPostingLine` → `schema.prisma:L2306`
- `InventoryTransfer` → `schema.prisma:L15672`
- `InventoryWasteReport` → `schema.prisma:L2126`
- `Invitation` → `schema.prisma:L1549`
- `Invoice` → `schema.prisma:L5341`
- `InvoiceItem` → `schema.prisma:L5367`
- `ItemCategory` → `schema.prisma:L12592`
- `JournalEntry` → `schema.prisma:L17689`
- `JournalLine` → `schema.prisma:L17718`
- `KdsOrder` → `schema.prisma:L16029`
- `KdsOrderItem` → `schema.prisma:L16096`
- `KioskCheckInAttempt` → `schema.prisma:L18651`
- `KioskCheckInChallenge` → `schema.prisma:L18605`
- `KioskOutreachOutbox` → `schema.prisma:L18672`
- `LaunchCampaign` → `schema.prisma:L19010`
- `LaunchCampaignRedemption` → `schema.prisma:L19127`
- `LearnedPatterns` → `schema.prisma:L10508`
- `LedgerAccount` → `schema.prisma:L17581`
- `LiveDemoSession` → `schema.prisma:L867`
- `LowStockAlert` → `schema.prisma:L2979`
- `LoyaltyConfig` → `schema.prisma:L8191`
- `LoyaltyTransaction` → `schema.prisma:L8234`
- `MarketingCampaign` → `schema.prisma:L13783`
- `McpAuthCode` → `schema.prisma:L17122`
- `McpOAuthClient` → `schema.prisma:L17106`
- `McpRefreshToken` → `schema.prisma:L17140`
- `McpToolCall` → `schema.prisma:L17162`
- `MeasurementUnit` → `schema.prisma:L15869`
- `Menu` → `schema.prisma:L1768`
- `MenuCategory` → `schema.prisma:L1704`
- `MenuCategoryAssignment` → `schema.prisma:L1803`
- `MercadoPagoWebhookEvent` → `schema.prisma:L17036`
- `MerchantAccount` → `schema.prisma:L6056`
- `MerchantFiscalConfig` → `schema.prisma:L17300`
- `MerchantRevenueShare` → `schema.prisma:L7185`
- `MerchantRoutingRule` → `schema.prisma:L6178`
- `MilestoneAchievement` → `schema.prisma:L13206`
- `Modifier` → `schema.prisma:L4411`
- `ModifierGroup` → `schema.prisma:L4374`
- `Module` → `schema.prisma:L11501`
- `MoneyAnomaly` → `schema.prisma:L7088`
- `MonthlyVenueProfit` → `schema.prisma:L7631`
- `Notification` → `schema.prisma:L9296`
- `NotificationPreference` → `schema.prisma:L9343`
- `NotificationTemplate` → `schema.prisma:L9370`
- `OAuthState` → `schema.prisma:L1600`
- `OnboardingProgress` → `schema.prisma:L1618`
- `Order` → `schema.prisma:L3935`
- `OrderAction` → `schema.prisma:L4482`
- `OrderCustomer` → `schema.prisma:L4188`
- `OrderDiscount` → `schema.prisma:L9152`
- `OrderFulfillment` → `schema.prisma:L16354`
- `OrderFulfillmentLine` → `schema.prisma:L16385`
- `OrderItem` → `schema.prisma:L4224`
- `OrderItemModifier` → `schema.prisma:L4464`
- `OrderItemSelloIva` → `schema.prisma:L17438`
- `OrderPromotion` → `schema.prisma:L18568`
- `OrderServiceCharge` → `schema.prisma:L9241`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13584`
- `OrganizationEntitlement` → `schema.prisma:L11784`
- `OrganizationGoal` → `schema.prisma:L13542`
- `OrganizationModule` → `schema.prisma:L11561`
- `OrganizationPaymentConfig` → `schema.prisma:L6630`
- `OrganizationPayoutConfig` → `schema.prisma:L13617`
- `OrganizationPricingStructure` → `schema.prisma:L6662`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13565`
- `OtpChallenge` → `schema.prisma:L8141`
- `OvertimeApproval` → `schema.prisma:L3650`
- `PartnerAPIKey` → `schema.prisma:L6460`
- `Payment` → `schema.prisma:L4515`
- `PaymentAllocation` → `schema.prisma:L4788`
- `PaymentEffect` → `schema.prisma:L18942`
- `PaymentLink` → `schema.prisma:L15449`
- `PaymentLinkAttribution` → `schema.prisma:L15557`
- `PaymentLinkItem` → `schema.prisma:L15512`
- `PaymentLinkItemModifier` → `schema.prisma:L15539`
- `PaymentProvider` → `schema.prisma:L6015`
- `PayrollLine` → `schema.prisma:L18064`
- `PayrollRun` → `schema.prisma:L18033`
- `PerformanceGoal` → `schema.prisma:L13519`
- `PermissionOverride` → `schema.prisma:L1473`
- `PermissionSet` → `schema.prisma:L1496`
- `PlatformAnnouncement` → `schema.prisma:L18732`
- `PlatformAnnouncementClick` → `schema.prisma:L18797`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18834`
- `PlatformCfdi` → `schema.prisma:L18361`
- `PlatformEmisor` → `schema.prisma:L18301`
- `PlatformSettings` → `schema.prisma:L6437`
- `PosCommand` → `schema.prisma:L9424`
- `PosConnectionStatus` → `schema.prisma:L1015`
- `PosSyncIntent` → `schema.prisma:L18439`
- `PricingPolicy` → `schema.prisma:L2875`
- `Printer` → `schema.prisma:L16154`
- `PrintGateway` → `schema.prisma:L16211`
- `PrintJob` → `schema.prisma:L16935`
- `PrintStation` → `schema.prisma:L16229`
- `PrivacyNoticeVersion` → `schema.prisma:L7889`
- `ProcessedStripeEvent` → `schema.prisma:L7074`
- `ProcessorReliabilityMetric` → `schema.prisma:L7559`
- `Product` → `schema.prisma:L1821`
- `ProductGroup` → `schema.prisma:L15780`
- `ProductGroupModifierGroup` → `schema.prisma:L15839`
- `ProductGroupOption` → `schema.prisma:L15812`
- `ProductGroupOptionValue` → `schema.prisma:L15826`
- `ProductModifierGroup` → `schema.prisma:L4452`
- `ProductOption` → `schema.prisma:L15755`
- `ProductOptionValue` → `schema.prisma:L15766`
- `ProductStaff` → `schema.prisma:L14399`
- `ProductVariantValue` → `schema.prisma:L15852`
- `PromoterBankAccount` → `schema.prisma:L18184`
- `PromoterCommissionEntry` → `schema.prisma:L18203`
- `PromoterLocationPing` → `schema.prisma:L3901`
- `Promotion` → `schema.prisma:L18490`
- `PromotionGroup` → `schema.prisma:L18529`
- `PromotionOption` → `schema.prisma:L18545`
- `ProviderCostStructure` → `schema.prisma:L7110`
- `ProviderEventLog` → `schema.prisma:L6739`
- `PurchaseOrder` → `schema.prisma:L2582`
- `PurchaseOrderInvoice` → `schema.prisma:L2727`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2794`
- `PurchaseOrderItem` → `schema.prisma:L2640`
- `RateCorrectionBatch` → `schema.prisma:L7335`
- `RateCorrectionEntry` → `schema.prisma:L7377`
- `RawMaterial` → `schema.prisma:L2338`
- `RawMaterialMovement` → `schema.prisma:L2928`
- `RawMaterialPresentation` → `schema.prisma:L2414`
- `ReceiptLayout` → `schema.prisma:L18976`
- `Recipe` → `schema.prisma:L2434`
- `RecipeLine` → `schema.prisma:L2458`
- `Referral` → `schema.prisma:L8607`
- `ReferralProgramConfig` → `schema.prisma:L8572`
- `ReferralRewardGrant` → `schema.prisma:L8698`
- `ReferralTierReward` → `schema.prisma:L8670`
- `ReferralTierUnlock` → `schema.prisma:L8743`
- `RefreshGrant` → `schema.prisma:L18921`
- `Reservation` → `schema.prisma:L14162`
- `ReservationGoogleEventMapping` → `schema.prisma:L15222`
- `ReservationModifier` → `schema.prisma:L14347`
- `ReservationReminderSent` → `schema.prisma:L14330`
- `ReservationSettings` → `schema.prisma:L14571`
- `ReservationWaitlistEntry` → `schema.prisma:L14539`
- `Review` → `schema.prisma:L5385`
- `SalesRetention` → `schema.prisma:L17884`
- `SaleVerification` → `schema.prisma:L4842`
- `ScaleProfile` → `schema.prisma:L16676`
- `ScheduledCommand` → `schema.prisma:L10985`
- `SerializedItem` → `schema.prisma:L12635`
- `SerializedItemCustodyEvent` → `schema.prisma:L12802`
- `ServiceCharge` → `schema.prisma:L9212`
- `ServiceEarning` → `schema.prisma:L19350`
- `ServicePayPeriod` → `schema.prisma:L19326`
- `ServicePayTable` → `schema.prisma:L19234`
- `ServicePayTableCell` → `schema.prisma:L19276`
- `ServicePayTableVersion` → `schema.prisma:L19251`
- `Session` → `schema.prisma:L18900`
- `SettlementConfiguration` → `schema.prisma:L7410`
- `SettlementConfirmation` → `schema.prisma:L7523`
- `SettlementIncident` → `schema.prisma:L7474`
- `SettlementSimulation` → `schema.prisma:L7445`
- `Shift` → `schema.prisma:L3461`
- `ShopifyConnectIntent` → `schema.prisma:L19672`
- `ShopifyImportIssue` → `schema.prisma:L19726`
- `ShopifyInboundEvent` → `schema.prisma:L19648`
- `ShopifyLocationLink` → `schema.prisma:L19522`
- `ShopifyReviewItem` → `schema.prisma:L19694`
- `ShopifyStockOutbox` → `schema.prisma:L19618`
- `ShopifyStore` → `schema.prisma:L19493`
- `ShopifyVariantLink` → `schema.prisma:L19570`
- `SimRegistrationRequest` → `schema.prisma:L12840`
- `SimRegistrationRequestItem` → `schema.prisma:L12862`
- `SlotHold` → `schema.prisma:L14430`
- `Staff` → `schema.prisma:L1035`
- `StaffAssignment` → `schema.prisma:L3748`
- `StaffDocument` → `schema.prisma:L3772`
- `StaffOnboardingState` → `schema.prisma:L17006`
- `StaffOrganization` → `schema.prisma:L1372`
- `StaffPasskey` → `schema.prisma:L1399`
- `StaffPayLevel` → `schema.prisma:L19198`
- `StaffPayLevelAssignment` → `schema.prisma:L19216`
- `StaffPayStatement` → `schema.prisma:L19382`
- `StaffPayTipWindow` → `schema.prisma:L19745`
- `StaffPayVenueWindow` → `schema.prisma:L19762`
- `StaffPosition` → `schema.prisma:L3727`
- `StaffSchedule` → `schema.prisma:L14370`
- `StaffScheduleException` → `schema.prisma:L14382`
- `StaffVenue` → `schema.prisma:L1296`
- `StaffWorkSchedule` → `schema.prisma:L3586`
- `StaffWorkScheduleException` → `schema.prisma:L3684`
- `StampCard` → `schema.prisma:L8455`
- `StampEvent` → `schema.prisma:L8494`
- `StampReward` → `schema.prisma:L8532`
- `StockAlertConfig` → `schema.prisma:L13501`
- `StockBatch` → `schema.prisma:L3098`
- `StockCount` → `schema.prisma:L3011`
- `StockCountItem` → `schema.prisma:L3039`
- `StripeWebhookEvent` → `schema.prisma:L7057`
- `Supplier` → `schema.prisma:L2493`
- `SupplierItemCode` → `schema.prisma:L2838`
- `SupplierPricing` → `schema.prisma:L2548`
- `Table` → `schema.prisma:L3352`
- `Terminal` → `schema.prisma:L5436`
- `TerminalAttemptResolution` → `schema.prisma:L5874`
- `TerminalHealth` → `schema.prisma:L5694`
- `TerminalLog` → `schema.prisma:L5668`
- `TerminalOrder` → `schema.prisma:L5918`
- `TerminalOrderItem` → `schema.prisma:L5993`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5846`
- `TerminalPaymentRequest` → `schema.prisma:L5765`
- `TimeEntry` → `schema.prisma:L3814`
- `TimeEntryBreak` → `schema.prisma:L3883`
- `TokenPurchase` → `schema.prisma:L10657`
- `TokenUsageRecord` → `schema.prisma:L10629`
- `TpvCommandHistory` → `schema.prisma:L10891`
- `TpvCommandQueue` → `schema.prisma:L10829`
- `TpvFeedback` → `schema.prisma:L10542`
- `TpvMessage` → `schema.prisma:L13858`
- `TpvMessageDelivery` → `schema.prisma:L13910`
- `TpvMessageResponse` → `schema.prisma:L13933`
- `TrainingModule` → `schema.prisma:L13988`
- `TrainingProgress` → `schema.prisma:L14065`
- `TrainingQuizQuestion` → `schema.prisma:L14047`
- `TrainingStep` → `schema.prisma:L14027`
- `TransactionCost` → `schema.prisma:L7273`
- `UnitConversion` → `schema.prisma:L2906`
- `UpsellAcceptance` → `schema.prisma:L9028`
- `UpsellAiRun` → `schema.prisma:L9048`
- `UpsellImpression` → `schema.prisma:L8988`
- `UpsellRule` → `schema.prisma:L8908`
- `user_sessions` → `schema.prisma:L6495`
- `Venue` → `schema.prisma:L185`
- `VenueAreaTicketSettings` → `schema.prisma:L16413`
- `VenueChatMessage` → `schema.prisma:L843`
- `VenueChatSession` → `schema.prisma:L798`
- `VenueCommission` → `schema.prisma:L16007`
- `VenueCreditAssessment` → `schema.prisma:L11373`
- `VenueCryptoConfig` → `schema.prisma:L13725`
- `VenueFeature` → `schema.prisma:L4956`
- `VenueIvaPorProducto` → `schema.prisma:L998`
- `VenueModule` → `schema.prisma:L11533`
- `VenuePaymentConfig` → `schema.prisma:L6596`
- `VenuePaymentLinkSettings` → `schema.prisma:L15255`
- `VenuePosSinAparato` → `schema.prisma:L1009`
- `VenuePricingStructure` → `schema.prisma:L7213`
- `VenueRoleConfig` → `schema.prisma:L1525`
- `VenueRolePermission` → `schema.prisma:L1429`
- `VenueScaleSettings` → `schema.prisma:L16664`
- `VenueSettings` → `schema.prisma:L883`
- `VenueTenderType` → `schema.prisma:L4701`
- `VenueTenderTypeRevision` → `schema.prisma:L4766`
- `VenueTransaction` → `schema.prisma:L4893`
- `VenueWhatsappActivation` → `schema.prisma:L734`
- `WalletCardDesign` → `schema.prisma:L8373`
- `WalletPass` → `schema.prisma:L8274`
- `WalletPassRegistration` → `schema.prisma:L8340`
- `WebhookEvent` → `schema.prisma:L5294`
- `WebhookSubscription` → `schema.prisma:L6712`
- `WhatsappContactWindow` → `schema.prisma:L752`
- `WhatsappInboundEvent` → `schema.prisma:L772`
- `WorkShiftAssignment` → `schema.prisma:L3626`
- `WorkShiftTemplate` → `schema.prisma:L3603`
- `Zone` → `schema.prisma:L168`
