# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **409 models / 377 enums / ~19,000 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `ClassSessionPayState`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `ServiceEarning`, `ServicePayPeriod`, `ServicePayTable`, `ServicePayTableCell`, `ServicePayTableVersion`, `StaffPayLevel`, `StaffPayLevelAssignment`, `StaffPayStatement`, `VenueCommission`                                                                                                                                                                                                                                                |
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

- `AccountingPeriodLock` → `schema.prisma:L17444`
- `AccountMapping` → `schema.prisma:L17339`
- `ActivityLog` → `schema.prisma:L7525`
- `Aggregator` → `schema.prisma:L15615`
- `AggregatorBooking` → `schema.prisma:L14923`
- `AggregatorCapacityRule` → `schema.prisma:L14904`
- `AggregatorConnection` → `schema.prisma:L14829`
- `AggregatorInboundEvent` → `schema.prisma:L14992`
- `AggregatorOutbox` → `schema.prisma:L15012`
- `AggregatorProductLink` → `schema.prisma:L14861`
- `AggregatorSessionLink` → `schema.prisma:L14880`
- `AggregatorVisit` → `schema.prisma:L14949`
- `AngelPayUserAccount` → `schema.prisma:L6070`
- `AppUpdate` → `schema.prisma:L13496`
- `Area` → `schema.prisma:L3257`
- `AreaTicket` → `schema.prisma:L16151`
- `AreaTicketCheckoutSession` → `schema.prisma:L16273`
- `AreaTicketExternalIncident` → `schema.prisma:L16520`
- `AreaTicketExternalSettlement` → `schema.prisma:L16485`
- `AreaTicketFulfillment` → `schema.prisma:L16349`
- `AreaTicketInventoryReservation` → `schema.prisma:L16244`
- `AreaTicketLine` → `schema.prisma:L16212`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16305`
- `AreaTicketPrintAttempt` → `schema.prisma:L16328`
- `BankStatement` → `schema.prisma:L17213`
- `BankStatementLine` → `schema.prisma:L17234`
- `BillingObligationConflict` → `schema.prisma:L5100`
- `BillingTaxProfile` → `schema.prisma:L18036`
- `BirthdayAutomation` → `schema.prisma:L7849`
- `BulkCommandOperation` → `schema.prisma:L10776`
- `CalendarSyncOutbox` → `schema.prisma:L14712`
- `CampaignDelivery` → `schema.prisma:L13654`
- `CapabilityGrant` → `schema.prisma:L4840`
- `CashCloseout` → `schema.prisma:L11161`
- `CashDeposit` → `schema.prisma:L13298`
- `CashDrawerEvent` → `schema.prisma:L15452`
- `CashDrawerSession` → `schema.prisma:L15413`
- `CashOutCommissionRate` → `schema.prisma:L17853`
- `CashOutScheduleDay` → `schema.prisma:L17876`
- `CashOutWithdrawal` → `schema.prisma:L17938`
- `CatalogBindingBatch` → `schema.prisma:L12192`
- `CatalogBindingLine` → `schema.prisma:L12228`
- `CatalogBrand` → `schema.prisma:L11645`
- `CatalogClientObservation` → `schema.prisma:L11958`
- `CatalogClientReadinessOverride` → `schema.prisma:L11977`
- `CatalogFamily` → `schema.prisma:L11695`
- `CatalogIdempotencyRecord` → `schema.prisma:L12091`
- `CatalogIdentifier` → `schema.prisma:L11826`
- `CatalogImportBatch` → `schema.prisma:L12134`
- `CatalogImportLine` → `schema.prisma:L12171`
- `CatalogItem` → `schema.prisma:L11728`
- `CatalogItemBusinessType` → `schema.prisma:L11788`
- `CatalogItemPrice` → `schema.prisma:L11876`
- `CatalogManufacturer` → `schema.prisma:L11669`
- `CatalogProductTypeMapping` → `schema.prisma:L11805`
- `CatalogPublicationBatch` → `schema.prisma:L12256`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12350`
- `CatalogPublicationLine` → `schema.prisma:L12297`
- `CatalogPublicationOutbox` → `schema.prisma:L12393`
- `CatalogValidationProfile` → `schema.prisma:L11847`
- `CatalogVenueBinding` → `schema.prisma:L12005`
- `CatalogVenueClientRequirement` → `schema.prisma:L11932`
- `CatalogVenueEventSequence` → `schema.prisma:L12376`
- `CatalogVenueOverride` → `schema.prisma:L12047`
- `CatalogVenueRollout` → `schema.prisma:L11907`
- `Cfdi` → `schema.prisma:L17041`
- `CfdiGlobalOrden` → `schema.prisma:L17166`
- `ChatbotTokenBudget` → `schema.prisma:L10422`
- `ChatConversation` → `schema.prisma:L10277`
- `ChatFeedback` → `schema.prisma:L10363`
- `ChatLearningEvent` → `schema.prisma:L10320`
- `ChatMessage` → `schema.prisma:L10300`
- `ChatTrainingData` → `schema.prisma:L10234`
- `CheckoutSession` → `schema.prisma:L6350`
- `ClassSession` → `schema.prisma:L14312`
- `ClassSessionPayState` → `schema.prisma:L18991`
- `CommissionCalculation` → `schema.prisma:L13074`
- `CommissionClawback` → `schema.prisma:L13250`
- `CommissionConfig` → `schema.prisma:L12840`
- `CommissionMilestone` → `schema.prisma:L12990`
- `CommissionOverride` → `schema.prisma:L12917`
- `CommissionPayout` → `schema.prisma:L13201`
- `CommissionSummary` → `schema.prisma:L13140`
- `CommissionTier` → `schema.prisma:L12954`
- `ConsentEvent` → `schema.prisma:L7711`
- `Consumer` → `schema.prisma:L7941`
- `ConsumerAuthAccount` → `schema.prisma:L7966`
- `CouponCode` → `schema.prisma:L8913`
- `CouponRedemption` → `schema.prisma:L8944`
- `CreditAssessmentHistory` → `schema.prisma:L11270`
- `CreditItemBalance` → `schema.prisma:L15203`
- `CreditOffer` → `schema.prisma:L11289`
- `CreditPack` → `schema.prisma:L15112`
- `CreditPackItem` → `schema.prisma:L15141`
- `CreditPackPurchase` → `schema.prisma:L15158`
- `CreditTransaction` → `schema.prisma:L15225`
- `Customer` → `schema.prisma:L7566`
- `CustomerApprovalDelivery` → `schema.prisma:L9936`
- `CustomerApprovalOutbox` → `schema.prisma:L9911`
- `CustomerCampaign` → `schema.prisma:L7799`
- `CustomerCampaignDelivery` → `schema.prisma:L7881`
- `CustomerCaptureToken` → `schema.prisma:L7747`
- `CustomerDiscount` → `schema.prisma:L8964`
- `CustomerExternalIdentity` → `schema.prisma:L14979`
- `CustomerGroup` → `schema.prisma:L8005`
- `CustomerOrderMetric` → `schema.prisma:L4056`
- `CustomerTaxProfile` → `schema.prisma:L17185`
- `DeliveryActivationRequest` → `schema.prisma:L6809`
- `DeliveryChannelLink` → `schema.prisma:L6648`
- `DeliveryConnectIntent` → `schema.prisma:L6760`
- `DeliveryLineAction` → `schema.prisma:L6721`
- `DeliveryOrderEvent` → `schema.prisma:L6833`
- `DeliveryStoreRevocation` → `schema.prisma:L6797`
- `DeviceToken` → `schema.prisma:L9238`
- `DigitalReceipt` → `schema.prisma:L4653`
- `Discount` → `schema.prisma:L8603`
- `EcommerceMerchant` → `schema.prisma:L6162`
- `EmailQuotaLedger` → `schema.prisma:L7928`
- `EmailSuppression` → `schema.prisma:L7916`
- `EmailTemplate` → `schema.prisma:L13593`
- `Employee` → `schema.prisma:L17701`
- `Estimate` → `schema.prisma:L15522`
- `EstimateItem` → `schema.prisma:L15550`
- `Expense` → `schema.prisma:L17488`
- `ExternalBusyBlock` → `schema.prisma:L14605`
- `Feature` → `schema.prisma:L4782`
- `FeeSchedule` → `schema.prisma:L5162`
- `FeeTier` → `schema.prisma:L5173`
- `FinancialAccount` → `schema.prisma:L15712`
- `FinancialConnection` → `schema.prisma:L15681`
- `FinancialProvider` → `schema.prisma:L15667`
- `FiscalEmisor` → `schema.prisma:L16957`
- `FiscalLossCarryforward` → `schema.prisma:L17611`
- `FixedAsset` → `schema.prisma:L17629`
- `FixedAssetDepreciation` → `schema.prisma:L17658`
- `FloorElement` → `schema.prisma:L3333`
- `FulfillmentArea` → `schema.prisma:L16016`
- `GeofenceRule` → `schema.prisma:L10861`
- `GoogleCalendarChannel` → `schema.prisma:L14582`
- `GoogleCalendarConnection` → `schema.prisma:L14534`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14635`
- `GoogleOAuthSession` → `schema.prisma:L14657`
- `HolidayCalendar` → `schema.prisma:L7449`
- `HybridBillingOperation` → `schema.prisma:L5024`
- `HybridCampaign` → `schema.prisma:L4865`
- `HybridContract` → `schema.prisma:L4981`
- `HybridContractSelection` → `schema.prisma:L5013`
- `HybridCreditAllocation` → `schema.prisma:L5080`
- `HybridOfferPublication` → `schema.prisma:L4928`
- `HybridPaymentPeriod` → `schema.prisma:L5059`
- `HybridPromotionGroup` → `schema.prisma:L4909`
- `HybridPurchase` → `schema.prisma:L4948`
- `HybridRedemption` → `schema.prisma:L5042`
- `IdempotencyRequest` → `schema.prisma:L12715`
- `InterVenueTransfer` → `schema.prisma:L3085`
- `InterVenueTransferAllocation` → `schema.prisma:L3168`
- `InterVenueTransferItem` → `schema.prisma:L3137`
- `InterVenueTransferReceipt` → `schema.prisma:L3195`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3211`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3239`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3223`
- `Inventory` → `schema.prisma:L2029`
- `InventoryMovement` → `schema.prisma:L2129`
- `InventoryPosting` → `schema.prisma:L2224`
- `InventoryPostingLine` → `schema.prisma:L2264`
- `InventoryTransfer` → `schema.prisma:L15494`
- `InventoryWasteReport` → `schema.prisma:L2084`
- `Invitation` → `schema.prisma:L1523`
- `Invoice` → `schema.prisma:L5185`
- `InvoiceItem` → `schema.prisma:L5211`
- `ItemCategory` → `schema.prisma:L12428`
- `JournalEntry` → `schema.prisma:L17397`
- `JournalLine` → `schema.prisma:L17426`
- `KdsOrder` → `schema.prisma:L15760`
- `KdsOrderItem` → `schema.prisma:L15823`
- `KioskCheckInAttempt` → `schema.prisma:L18359`
- `KioskCheckInChallenge` → `schema.prisma:L18313`
- `KioskOutreachOutbox` → `schema.prisma:L18380`
- `LaunchCampaign` → `schema.prisma:L18718`
- `LaunchCampaignRedemption` → `schema.prisma:L18835`
- `LearnedPatterns` → `schema.prisma:L10344`
- `LedgerAccount` → `schema.prisma:L17289`
- `LiveDemoSession` → `schema.prisma:L848`
- `LowStockAlert` → `schema.prisma:L2919`
- `LoyaltyConfig` → `schema.prisma:L8035`
- `LoyaltyTransaction` → `schema.prisma:L8078`
- `MarketingCampaign` → `schema.prisma:L13611`
- `McpAuthCode` → `schema.prisma:L16839`
- `McpOAuthClient` → `schema.prisma:L16823`
- `McpRefreshToken` → `schema.prisma:L16857`
- `McpToolCall` → `schema.prisma:L16879`
- `MeasurementUnit` → `schema.prisma:L15600`
- `Menu` → `schema.prisma:L1741`
- `MenuCategory` → `schema.prisma:L1678`
- `MenuCategoryAssignment` → `schema.prisma:L1776`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16753`
- `MerchantAccount` → `schema.prisma:L5900`
- `MerchantFiscalConfig` → `schema.prisma:L17012`
- `MerchantRevenueShare` → `schema.prisma:L7029`
- `MerchantRoutingRule` → `schema.prisma:L6022`
- `MilestoneAchievement` → `schema.prisma:L13035`
- `Modifier` → `schema.prisma:L4255`
- `ModifierGroup` → `schema.prisma:L4219`
- `Module` → `schema.prisma:L11337`
- `MoneyAnomaly` → `schema.prisma:L6932`
- `MonthlyVenueProfit` → `schema.prisma:L7475`
- `Notification` → `schema.prisma:L9140`
- `NotificationPreference` → `schema.prisma:L9187`
- `NotificationTemplate` → `schema.prisma:L9214`
- `OAuthState` → `schema.prisma:L1574`
- `OnboardingProgress` → `schema.prisma:L1592`
- `Order` → `schema.prisma:L3782`
- `OrderAction` → `schema.prisma:L4326`
- `OrderCustomer` → `schema.prisma:L4035`
- `OrderDiscount` → `schema.prisma:L8996`
- `OrderFulfillment` → `schema.prisma:L16071`
- `OrderFulfillmentLine` → `schema.prisma:L16102`
- `OrderItem` → `schema.prisma:L4071`
- `OrderItemModifier` → `schema.prisma:L4308`
- `OrderItemSelloIva` → `schema.prisma:L17146`
- `OrderPromotion` → `schema.prisma:L18276`
- `OrderServiceCharge` → `schema.prisma:L9085`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13412`
- `OrganizationEntitlement` → `schema.prisma:L11620`
- `OrganizationGoal` → `schema.prisma:L13370`
- `OrganizationModule` → `schema.prisma:L11397`
- `OrganizationPaymentConfig` → `schema.prisma:L6474`
- `OrganizationPayoutConfig` → `schema.prisma:L13445`
- `OrganizationPricingStructure` → `schema.prisma:L6506`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13393`
- `OtpChallenge` → `schema.prisma:L7985`
- `OvertimeApproval` → `schema.prisma:L3560`
- `PartnerAPIKey` → `schema.prisma:L6304`
- `Payment` → `schema.prisma:L4359`
- `PaymentAllocation` → `schema.prisma:L4632`
- `PaymentEffect` → `schema.prisma:L18650`
- `PaymentLink` → `schema.prisma:L15271`
- `PaymentLinkAttribution` → `schema.prisma:L15379`
- `PaymentLinkItem` → `schema.prisma:L15334`
- `PaymentLinkItemModifier` → `schema.prisma:L15361`
- `PaymentProvider` → `schema.prisma:L5859`
- `PayrollLine` → `schema.prisma:L17772`
- `PayrollRun` → `schema.prisma:L17741`
- `PerformanceGoal` → `schema.prisma:L13347`
- `PermissionOverride` → `schema.prisma:L1447`
- `PermissionSet` → `schema.prisma:L1470`
- `PlatformAnnouncement` → `schema.prisma:L18440`
- `PlatformAnnouncementClick` → `schema.prisma:L18505`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18542`
- `PlatformCfdi` → `schema.prisma:L18069`
- `PlatformEmisor` → `schema.prisma:L18009`
- `PlatformSettings` → `schema.prisma:L6281`
- `PosCommand` → `schema.prisma:L9268`
- `PosConnectionStatus` → `schema.prisma:L992`
- `PosSyncIntent` → `schema.prisma:L18147`
- `PricingPolicy` → `schema.prisma:L2815`
- `Printer` → `schema.prisma:L15872`
- `PrintGateway` → `schema.prisma:L15929`
- `PrintJob` → `schema.prisma:L16652`
- `PrintStation` → `schema.prisma:L15947`
- `PrivacyNoticeVersion` → `schema.prisma:L7733`
- `ProcessedStripeEvent` → `schema.prisma:L6918`
- `ProcessorReliabilityMetric` → `schema.prisma:L7403`
- `Product` → `schema.prisma:L1794`
- `ProductModifierGroup` → `schema.prisma:L4296`
- `ProductOption` → `schema.prisma:L15577`
- `ProductOptionValue` → `schema.prisma:L15588`
- `ProductStaff` → `schema.prisma:L14227`
- `PromoterBankAccount` → `schema.prisma:L17892`
- `PromoterCommissionEntry` → `schema.prisma:L17911`
- `PromoterLocationPing` → `schema.prisma:L3748`
- `Promotion` → `schema.prisma:L18198`
- `PromotionGroup` → `schema.prisma:L18237`
- `PromotionOption` → `schema.prisma:L18253`
- `ProviderCostStructure` → `schema.prisma:L6954`
- `ProviderEventLog` → `schema.prisma:L6583`
- `PurchaseOrder` → `schema.prisma:L2540`
- `PurchaseOrderInvoice` → `schema.prisma:L2685`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2742`
- `PurchaseOrderItem` → `schema.prisma:L2598`
- `RateCorrectionBatch` → `schema.prisma:L7179`
- `RateCorrectionEntry` → `schema.prisma:L7221`
- `RawMaterial` → `schema.prisma:L2296`
- `RawMaterialMovement` → `schema.prisma:L2868`
- `RawMaterialPresentation` → `schema.prisma:L2372`
- `ReceiptLayout` → `schema.prisma:L18684`
- `Recipe` → `schema.prisma:L2392`
- `RecipeLine` → `schema.prisma:L2416`
- `Referral` → `schema.prisma:L8451`
- `ReferralProgramConfig` → `schema.prisma:L8416`
- `ReferralRewardGrant` → `schema.prisma:L8542`
- `ReferralTierReward` → `schema.prisma:L8514`
- `ReferralTierUnlock` → `schema.prisma:L8587`
- `RefreshGrant` → `schema.prisma:L18629`
- `Reservation` → `schema.prisma:L13990`
- `ReservationGoogleEventMapping` → `schema.prisma:L15044`
- `ReservationModifier` → `schema.prisma:L14175`
- `ReservationReminderSent` → `schema.prisma:L14158`
- `ReservationSettings` → `schema.prisma:L14393`
- `ReservationWaitlistEntry` → `schema.prisma:L14361`
- `Review` → `schema.prisma:L5229`
- `SalesRetention` → `schema.prisma:L17592`
- `SaleVerification` → `schema.prisma:L4686`
- `ScaleProfile` → `schema.prisma:L16393`
- `ScheduledCommand` → `schema.prisma:L10821`
- `SerializedItem` → `schema.prisma:L12471`
- `SerializedItemCustodyEvent` → `schema.prisma:L12638`
- `ServiceCharge` → `schema.prisma:L9056`
- `ServiceEarning` → `schema.prisma:L19051`
- `ServicePayPeriod` → `schema.prisma:L19027`
- `ServicePayTable` → `schema.prisma:L18942`
- `ServicePayTableCell` → `schema.prisma:L18979`
- `ServicePayTableVersion` → `schema.prisma:L18959`
- `Session` → `schema.prisma:L18608`
- `SettlementConfiguration` → `schema.prisma:L7254`
- `SettlementConfirmation` → `schema.prisma:L7367`
- `SettlementIncident` → `schema.prisma:L7318`
- `SettlementSimulation` → `schema.prisma:L7289`
- `Shift` → `schema.prisma:L3371`
- `SimRegistrationRequest` → `schema.prisma:L12676`
- `SimRegistrationRequestItem` → `schema.prisma:L12698`
- `SlotHold` → `schema.prisma:L14258`
- `Staff` → `schema.prisma:L1012`
- `StaffDocument` → `schema.prisma:L3619`
- `StaffOnboardingState` → `schema.prisma:L16723`
- `StaffOrganization` → `schema.prisma:L1346`
- `StaffPasskey` → `schema.prisma:L1373`
- `StaffPayLevel` → `schema.prisma:L18906`
- `StaffPayLevelAssignment` → `schema.prisma:L18924`
- `StaffPayStatement` → `schema.prisma:L19081`
- `StaffSchedule` → `schema.prisma:L14198`
- `StaffScheduleException` → `schema.prisma:L14210`
- `StaffVenue` → `schema.prisma:L1270`
- `StaffWorkSchedule` → `schema.prisma:L3496`
- `StaffWorkScheduleException` → `schema.prisma:L3594`
- `StampCard` → `schema.prisma:L8299`
- `StampEvent` → `schema.prisma:L8338`
- `StampReward` → `schema.prisma:L8376`
- `StockAlertConfig` → `schema.prisma:L13329`
- `StockBatch` → `schema.prisma:L3034`
- `StockCount` → `schema.prisma:L2951`
- `StockCountItem` → `schema.prisma:L2979`
- `StripeWebhookEvent` → `schema.prisma:L6901`
- `Supplier` → `schema.prisma:L2451`
- `SupplierItemCode` → `schema.prisma:L2783`
- `SupplierPricing` → `schema.prisma:L2506`
- `Table` → `schema.prisma:L3283`
- `Terminal` → `schema.prisma:L5280`
- `TerminalAttemptResolution` → `schema.prisma:L5718`
- `TerminalHealth` → `schema.prisma:L5538`
- `TerminalLog` → `schema.prisma:L5512`
- `TerminalOrder` → `schema.prisma:L5762`
- `TerminalOrderItem` → `schema.prisma:L5837`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5690`
- `TerminalPaymentRequest` → `schema.prisma:L5609`
- `TimeEntry` → `schema.prisma:L3661`
- `TimeEntryBreak` → `schema.prisma:L3730`
- `TokenPurchase` → `schema.prisma:L10493`
- `TokenUsageRecord` → `schema.prisma:L10465`
- `TpvCommandHistory` → `schema.prisma:L10727`
- `TpvCommandQueue` → `schema.prisma:L10665`
- `TpvFeedback` → `schema.prisma:L10378`
- `TpvMessage` → `schema.prisma:L13686`
- `TpvMessageDelivery` → `schema.prisma:L13738`
- `TpvMessageResponse` → `schema.prisma:L13761`
- `TrainingModule` → `schema.prisma:L13816`
- `TrainingProgress` → `schema.prisma:L13893`
- `TrainingQuizQuestion` → `schema.prisma:L13875`
- `TrainingStep` → `schema.prisma:L13855`
- `TransactionCost` → `schema.prisma:L7117`
- `UnitConversion` → `schema.prisma:L2846`
- `UpsellAcceptance` → `schema.prisma:L8872`
- `UpsellAiRun` → `schema.prisma:L8892`
- `UpsellImpression` → `schema.prisma:L8832`
- `UpsellRule` → `schema.prisma:L8752`
- `user_sessions` → `schema.prisma:L6339`
- `Venue` → `schema.prisma:L173`
- `VenueAreaTicketSettings` → `schema.prisma:L16130`
- `VenueChatMessage` → `schema.prisma:L824`
- `VenueChatSession` → `schema.prisma:L779`
- `VenueCommission` → `schema.prisma:L15738`
- `VenueCreditAssessment` → `schema.prisma:L11209`
- `VenueCryptoConfig` → `schema.prisma:L13553`
- `VenueFeature` → `schema.prisma:L4800`
- `VenueIvaPorProducto` → `schema.prisma:L975`
- `VenueModule` → `schema.prisma:L11369`
- `VenuePaymentConfig` → `schema.prisma:L6440`
- `VenuePaymentLinkSettings` → `schema.prisma:L15077`
- `VenuePosSinAparato` → `schema.prisma:L986`
- `VenuePricingStructure` → `schema.prisma:L7057`
- `VenueRoleConfig` → `schema.prisma:L1499`
- `VenueRolePermission` → `schema.prisma:L1403`
- `VenueScaleSettings` → `schema.prisma:L16381`
- `VenueSettings` → `schema.prisma:L864`
- `VenueTenderType` → `schema.prisma:L4545`
- `VenueTenderTypeRevision` → `schema.prisma:L4610`
- `VenueTransaction` → `schema.prisma:L4737`
- `VenueWhatsappActivation` → `schema.prisma:L715`
- `WalletCardDesign` → `schema.prisma:L8217`
- `WalletPass` → `schema.prisma:L8118`
- `WalletPassRegistration` → `schema.prisma:L8184`
- `WebhookEvent` → `schema.prisma:L5138`
- `WebhookSubscription` → `schema.prisma:L6556`
- `WhatsappContactWindow` → `schema.prisma:L733`
- `WhatsappInboundEvent` → `schema.prisma:L753`
- `WorkShiftAssignment` → `schema.prisma:L3536`
- `WorkShiftTemplate` → `schema.prisma:L3513`
- `Zone` → `schema.prisma:L156`
