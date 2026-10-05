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

- `AccountingPeriodLock` → `schema.prisma:L17105`
- `AccountMapping` → `schema.prisma:L17000`
- `ActivityLog` → `schema.prisma:L7473`
- `Aggregator` → `schema.prisma:L15276`
- `AngelPayUserAccount` → `schema.prisma:L6018`
- `AppUpdate` → `schema.prisma:L13441`
- `Area` → `schema.prisma:L3241`
- `AreaTicket` → `schema.prisma:L15812`
- `AreaTicketCheckoutSession` → `schema.prisma:L15934`
- `AreaTicketExternalIncident` → `schema.prisma:L16181`
- `AreaTicketExternalSettlement` → `schema.prisma:L16146`
- `AreaTicketFulfillment` → `schema.prisma:L16010`
- `AreaTicketInventoryReservation` → `schema.prisma:L15905`
- `AreaTicketLine` → `schema.prisma:L15873`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15966`
- `AreaTicketPrintAttempt` → `schema.prisma:L15989`
- `BankStatement` → `schema.prisma:L16874`
- `BankStatementLine` → `schema.prisma:L16895`
- `BillingObligationConflict` → `schema.prisma:L5048`
- `BillingTaxProfile` → `schema.prisma:L17697`
- `BirthdayAutomation` → `schema.prisma:L7794`
- `BulkCommandOperation` → `schema.prisma:L10721`
- `CalendarSyncOutbox` → `schema.prisma:L14648`
- `CampaignDelivery` → `schema.prisma:L13599`
- `CapabilityGrant` → `schema.prisma:L4824`
- `CashCloseout` → `schema.prisma:L11106`
- `CashDeposit` → `schema.prisma:L13243`
- `CashDrawerEvent` → `schema.prisma:L15113`
- `CashDrawerSession` → `schema.prisma:L15074`
- `CashOutCommissionRate` → `schema.prisma:L17514`
- `CashOutScheduleDay` → `schema.prisma:L17537`
- `CashOutWithdrawal` → `schema.prisma:L17599`
- `CatalogBindingBatch` → `schema.prisma:L12137`
- `CatalogBindingLine` → `schema.prisma:L12173`
- `CatalogBrand` → `schema.prisma:L11590`
- `CatalogClientObservation` → `schema.prisma:L11903`
- `CatalogClientReadinessOverride` → `schema.prisma:L11922`
- `CatalogFamily` → `schema.prisma:L11640`
- `CatalogIdempotencyRecord` → `schema.prisma:L12036`
- `CatalogIdentifier` → `schema.prisma:L11771`
- `CatalogImportBatch` → `schema.prisma:L12079`
- `CatalogImportLine` → `schema.prisma:L12116`
- `CatalogItem` → `schema.prisma:L11673`
- `CatalogItemBusinessType` → `schema.prisma:L11733`
- `CatalogItemPrice` → `schema.prisma:L11821`
- `CatalogManufacturer` → `schema.prisma:L11614`
- `CatalogProductTypeMapping` → `schema.prisma:L11750`
- `CatalogPublicationBatch` → `schema.prisma:L12201`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12295`
- `CatalogPublicationLine` → `schema.prisma:L12242`
- `CatalogPublicationOutbox` → `schema.prisma:L12338`
- `CatalogValidationProfile` → `schema.prisma:L11792`
- `CatalogVenueBinding` → `schema.prisma:L11950`
- `CatalogVenueClientRequirement` → `schema.prisma:L11877`
- `CatalogVenueEventSequence` → `schema.prisma:L12321`
- `CatalogVenueOverride` → `schema.prisma:L11992`
- `CatalogVenueRollout` → `schema.prisma:L11852`
- `Cfdi` → `schema.prisma:L16702`
- `CfdiGlobalOrden` → `schema.prisma:L16827`
- `ChatbotTokenBudget` → `schema.prisma:L10367`
- `ChatConversation` → `schema.prisma:L10222`
- `ChatFeedback` → `schema.prisma:L10308`
- `ChatLearningEvent` → `schema.prisma:L10265`
- `ChatMessage` → `schema.prisma:L10245`
- `ChatTrainingData` → `schema.prisma:L10179`
- `CheckoutSession` → `schema.prisma:L6298`
- `ClassSession` → `schema.prisma:L14252`
- `CommissionCalculation` → `schema.prisma:L13019`
- `CommissionClawback` → `schema.prisma:L13195`
- `CommissionConfig` → `schema.prisma:L12785`
- `CommissionMilestone` → `schema.prisma:L12935`
- `CommissionOverride` → `schema.prisma:L12862`
- `CommissionPayout` → `schema.prisma:L13146`
- `CommissionSummary` → `schema.prisma:L13085`
- `CommissionTier` → `schema.prisma:L12899`
- `ConsentEvent` → `schema.prisma:L7656`
- `Consumer` → `schema.prisma:L7886`
- `ConsumerAuthAccount` → `schema.prisma:L7911`
- `CouponCode` → `schema.prisma:L8858`
- `CouponRedemption` → `schema.prisma:L8889`
- `CreditAssessmentHistory` → `schema.prisma:L11215`
- `CreditItemBalance` → `schema.prisma:L14864`
- `CreditOffer` → `schema.prisma:L11234`
- `CreditPack` → `schema.prisma:L14773`
- `CreditPackItem` → `schema.prisma:L14802`
- `CreditPackPurchase` → `schema.prisma:L14819`
- `CreditTransaction` → `schema.prisma:L14886`
- `Customer` → `schema.prisma:L7514`
- `CustomerApprovalDelivery` → `schema.prisma:L9881`
- `CustomerApprovalOutbox` → `schema.prisma:L9856`
- `CustomerCampaign` → `schema.prisma:L7744`
- `CustomerCampaignDelivery` → `schema.prisma:L7826`
- `CustomerCaptureToken` → `schema.prisma:L7692`
- `CustomerDiscount` → `schema.prisma:L8909`
- `CustomerGroup` → `schema.prisma:L7950`
- `CustomerOrderMetric` → `schema.prisma:L4040`
- `CustomerTaxProfile` → `schema.prisma:L16846`
- `DeliveryActivationRequest` → `schema.prisma:L6757`
- `DeliveryChannelLink` → `schema.prisma:L6596`
- `DeliveryConnectIntent` → `schema.prisma:L6708`
- `DeliveryLineAction` → `schema.prisma:L6669`
- `DeliveryOrderEvent` → `schema.prisma:L6781`
- `DeliveryStoreRevocation` → `schema.prisma:L6745`
- `DeviceToken` → `schema.prisma:L9183`
- `DigitalReceipt` → `schema.prisma:L4637`
- `Discount` → `schema.prisma:L8548`
- `EcommerceMerchant` → `schema.prisma:L6110`
- `EmailQuotaLedger` → `schema.prisma:L7873`
- `EmailSuppression` → `schema.prisma:L7861`
- `EmailTemplate` → `schema.prisma:L13538`
- `Employee` → `schema.prisma:L17362`
- `Estimate` → `schema.prisma:L15183`
- `EstimateItem` → `schema.prisma:L15211`
- `Expense` → `schema.prisma:L17149`
- `ExternalBusyBlock` → `schema.prisma:L14541`
- `Feature` → `schema.prisma:L4766`
- `FeeSchedule` → `schema.prisma:L5110`
- `FeeTier` → `schema.prisma:L5121`
- `FinancialAccount` → `schema.prisma:L15373`
- `FinancialConnection` → `schema.prisma:L15342`
- `FinancialProvider` → `schema.prisma:L15328`
- `FiscalEmisor` → `schema.prisma:L16618`
- `FiscalLossCarryforward` → `schema.prisma:L17272`
- `FixedAsset` → `schema.prisma:L17290`
- `FixedAssetDepreciation` → `schema.prisma:L17319`
- `FloorElement` → `schema.prisma:L3317`
- `FulfillmentArea` → `schema.prisma:L15677`
- `GeofenceRule` → `schema.prisma:L10806`
- `GoogleCalendarChannel` → `schema.prisma:L14518`
- `GoogleCalendarConnection` → `schema.prisma:L14470`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14571`
- `GoogleOAuthSession` → `schema.prisma:L14593`
- `HolidayCalendar` → `schema.prisma:L7397`
- `HybridBillingOperation` → `schema.prisma:L4972`
- `HybridCampaign` → `schema.prisma:L4849`
- `HybridContract` → `schema.prisma:L4929`
- `HybridContractSelection` → `schema.prisma:L4961`
- `HybridCreditAllocation` → `schema.prisma:L5028`
- `HybridOfferPublication` → `schema.prisma:L4876`
- `HybridPaymentPeriod` → `schema.prisma:L5007`
- `HybridPurchase` → `schema.prisma:L4896`
- `HybridRedemption` → `schema.prisma:L4990`
- `IdempotencyRequest` → `schema.prisma:L12660`
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
- `InventoryTransfer` → `schema.prisma:L15155`
- `InventoryWasteReport` → `schema.prisma:L2068`
- `Invitation` → `schema.prisma:L1510`
- `Invoice` → `schema.prisma:L5133`
- `InvoiceItem` → `schema.prisma:L5159`
- `ItemCategory` → `schema.prisma:L12373`
- `JournalEntry` → `schema.prisma:L17058`
- `JournalLine` → `schema.prisma:L17087`
- `KdsOrder` → `schema.prisma:L15421`
- `KdsOrderItem` → `schema.prisma:L15484`
- `KioskCheckInAttempt` → `schema.prisma:L18020`
- `KioskCheckInChallenge` → `schema.prisma:L17974`
- `KioskOutreachOutbox` → `schema.prisma:L18041`
- `LaunchCampaign` → `schema.prisma:L18379`
- `LaunchCampaignRedemption` → `schema.prisma:L18496`
- `LearnedPatterns` → `schema.prisma:L10289`
- `LedgerAccount` → `schema.prisma:L16950`
- `LiveDemoSession` → `schema.prisma:L836`
- `LowStockAlert` → `schema.prisma:L2903`
- `LoyaltyConfig` → `schema.prisma:L7980`
- `LoyaltyTransaction` → `schema.prisma:L8023`
- `MarketingCampaign` → `schema.prisma:L13556`
- `McpAuthCode` → `schema.prisma:L16500`
- `McpOAuthClient` → `schema.prisma:L16484`
- `McpRefreshToken` → `schema.prisma:L16518`
- `McpToolCall` → `schema.prisma:L16540`
- `MeasurementUnit` → `schema.prisma:L15261`
- `Menu` → `schema.prisma:L1728`
- `MenuCategory` → `schema.prisma:L1665`
- `MenuCategoryAssignment` → `schema.prisma:L1763`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16414`
- `MerchantAccount` → `schema.prisma:L5848`
- `MerchantFiscalConfig` → `schema.prisma:L16673`
- `MerchantRevenueShare` → `schema.prisma:L6977`
- `MerchantRoutingRule` → `schema.prisma:L5970`
- `MilestoneAchievement` → `schema.prisma:L12980`
- `Modifier` → `schema.prisma:L4239`
- `ModifierGroup` → `schema.prisma:L4203`
- `Module` → `schema.prisma:L11282`
- `MoneyAnomaly` → `schema.prisma:L6880`
- `MonthlyVenueProfit` → `schema.prisma:L7423`
- `Notification` → `schema.prisma:L9085`
- `NotificationPreference` → `schema.prisma:L9132`
- `NotificationTemplate` → `schema.prisma:L9159`
- `OAuthState` → `schema.prisma:L1561`
- `OnboardingProgress` → `schema.prisma:L1579`
- `Order` → `schema.prisma:L3766`
- `OrderAction` → `schema.prisma:L4310`
- `OrderCustomer` → `schema.prisma:L4019`
- `OrderDiscount` → `schema.prisma:L8941`
- `OrderFulfillment` → `schema.prisma:L15732`
- `OrderFulfillmentLine` → `schema.prisma:L15763`
- `OrderItem` → `schema.prisma:L4055`
- `OrderItemModifier` → `schema.prisma:L4292`
- `OrderItemSelloIva` → `schema.prisma:L16807`
- `OrderPromotion` → `schema.prisma:L17937`
- `OrderServiceCharge` → `schema.prisma:L9030`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13357`
- `OrganizationEntitlement` → `schema.prisma:L11565`
- `OrganizationGoal` → `schema.prisma:L13315`
- `OrganizationModule` → `schema.prisma:L11342`
- `OrganizationPaymentConfig` → `schema.prisma:L6422`
- `OrganizationPayoutConfig` → `schema.prisma:L13390`
- `OrganizationPricingStructure` → `schema.prisma:L6454`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13338`
- `OtpChallenge` → `schema.prisma:L7930`
- `OvertimeApproval` → `schema.prisma:L3544`
- `PartnerAPIKey` → `schema.prisma:L6252`
- `Payment` → `schema.prisma:L4343`
- `PaymentAllocation` → `schema.prisma:L4616`
- `PaymentEffect` → `schema.prisma:L18311`
- `PaymentLink` → `schema.prisma:L14932`
- `PaymentLinkAttribution` → `schema.prisma:L15040`
- `PaymentLinkItem` → `schema.prisma:L14995`
- `PaymentLinkItemModifier` → `schema.prisma:L15022`
- `PaymentProvider` → `schema.prisma:L5807`
- `PayrollLine` → `schema.prisma:L17433`
- `PayrollRun` → `schema.prisma:L17402`
- `PerformanceGoal` → `schema.prisma:L13292`
- `PermissionOverride` → `schema.prisma:L1434`
- `PermissionSet` → `schema.prisma:L1457`
- `PlatformAnnouncement` → `schema.prisma:L18101`
- `PlatformAnnouncementClick` → `schema.prisma:L18166`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18203`
- `PlatformCfdi` → `schema.prisma:L17730`
- `PlatformEmisor` → `schema.prisma:L17670`
- `PlatformSettings` → `schema.prisma:L6229`
- `PosCommand` → `schema.prisma:L9213`
- `PosConnectionStatus` → `schema.prisma:L980`
- `PosSyncIntent` → `schema.prisma:L17808`
- `PricingPolicy` → `schema.prisma:L2799`
- `Printer` → `schema.prisma:L15533`
- `PrintGateway` → `schema.prisma:L15590`
- `PrintJob` → `schema.prisma:L16313`
- `PrintStation` → `schema.prisma:L15608`
- `PrivacyNoticeVersion` → `schema.prisma:L7678`
- `ProcessedStripeEvent` → `schema.prisma:L6866`
- `ProcessorReliabilityMetric` → `schema.prisma:L7351`
- `Product` → `schema.prisma:L1781`
- `ProductModifierGroup` → `schema.prisma:L4280`
- `ProductOption` → `schema.prisma:L15238`
- `ProductOptionValue` → `schema.prisma:L15249`
- `ProductStaff` → `schema.prisma:L14167`
- `PromoterBankAccount` → `schema.prisma:L17553`
- `PromoterCommissionEntry` → `schema.prisma:L17572`
- `PromoterLocationPing` → `schema.prisma:L3732`
- `Promotion` → `schema.prisma:L17859`
- `PromotionGroup` → `schema.prisma:L17898`
- `PromotionOption` → `schema.prisma:L17914`
- `ProviderCostStructure` → `schema.prisma:L6902`
- `ProviderEventLog` → `schema.prisma:L6531`
- `PurchaseOrder` → `schema.prisma:L2524`
- `PurchaseOrderInvoice` → `schema.prisma:L2669`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2726`
- `PurchaseOrderItem` → `schema.prisma:L2582`
- `RateCorrectionBatch` → `schema.prisma:L7127`
- `RateCorrectionEntry` → `schema.prisma:L7169`
- `RawMaterial` → `schema.prisma:L2280`
- `RawMaterialMovement` → `schema.prisma:L2852`
- `RawMaterialPresentation` → `schema.prisma:L2356`
- `ReceiptLayout` → `schema.prisma:L18345`
- `Recipe` → `schema.prisma:L2376`
- `RecipeLine` → `schema.prisma:L2400`
- `Referral` → `schema.prisma:L8396`
- `ReferralProgramConfig` → `schema.prisma:L8361`
- `ReferralRewardGrant` → `schema.prisma:L8487`
- `ReferralTierReward` → `schema.prisma:L8459`
- `ReferralTierUnlock` → `schema.prisma:L8532`
- `RefreshGrant` → `schema.prisma:L18290`
- `Reservation` → `schema.prisma:L13935`
- `ReservationGoogleEventMapping` → `schema.prisma:L14705`
- `ReservationModifier` → `schema.prisma:L14115`
- `ReservationReminderSent` → `schema.prisma:L14098`
- `ReservationSettings` → `schema.prisma:L14329`
- `ReservationWaitlistEntry` → `schema.prisma:L14297`
- `Review` → `schema.prisma:L5177`
- `SalesRetention` → `schema.prisma:L17253`
- `SaleVerification` → `schema.prisma:L4670`
- `ScaleProfile` → `schema.prisma:L16054`
- `ScheduledCommand` → `schema.prisma:L10766`
- `SerializedItem` → `schema.prisma:L12416`
- `SerializedItemCustodyEvent` → `schema.prisma:L12583`
- `ServiceCharge` → `schema.prisma:L9001`
- `Session` → `schema.prisma:L18269`
- `SettlementConfiguration` → `schema.prisma:L7202`
- `SettlementConfirmation` → `schema.prisma:L7315`
- `SettlementIncident` → `schema.prisma:L7266`
- `SettlementSimulation` → `schema.prisma:L7237`
- `Shift` → `schema.prisma:L3355`
- `SimRegistrationRequest` → `schema.prisma:L12621`
- `SimRegistrationRequestItem` → `schema.prisma:L12643`
- `SlotHold` → `schema.prisma:L14198`
- `Staff` → `schema.prisma:L1000`
- `StaffDocument` → `schema.prisma:L3603`
- `StaffOnboardingState` → `schema.prisma:L16384`
- `StaffOrganization` → `schema.prisma:L1333`
- `StaffPasskey` → `schema.prisma:L1360`
- `StaffSchedule` → `schema.prisma:L14138`
- `StaffScheduleException` → `schema.prisma:L14150`
- `StaffVenue` → `schema.prisma:L1257`
- `StaffWorkSchedule` → `schema.prisma:L3480`
- `StaffWorkScheduleException` → `schema.prisma:L3578`
- `StampCard` → `schema.prisma:L8244`
- `StampEvent` → `schema.prisma:L8283`
- `StampReward` → `schema.prisma:L8321`
- `StockAlertConfig` → `schema.prisma:L13274`
- `StockBatch` → `schema.prisma:L3018`
- `StockCount` → `schema.prisma:L2935`
- `StockCountItem` → `schema.prisma:L2963`
- `StripeWebhookEvent` → `schema.prisma:L6849`
- `Supplier` → `schema.prisma:L2435`
- `SupplierItemCode` → `schema.prisma:L2767`
- `SupplierPricing` → `schema.prisma:L2490`
- `Table` → `schema.prisma:L3267`
- `Terminal` → `schema.prisma:L5228`
- `TerminalAttemptResolution` → `schema.prisma:L5666`
- `TerminalHealth` → `schema.prisma:L5486`
- `TerminalLog` → `schema.prisma:L5460`
- `TerminalOrder` → `schema.prisma:L5710`
- `TerminalOrderItem` → `schema.prisma:L5785`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5638`
- `TerminalPaymentRequest` → `schema.prisma:L5557`
- `TimeEntry` → `schema.prisma:L3645`
- `TimeEntryBreak` → `schema.prisma:L3714`
- `TokenPurchase` → `schema.prisma:L10438`
- `TokenUsageRecord` → `schema.prisma:L10410`
- `TpvCommandHistory` → `schema.prisma:L10672`
- `TpvCommandQueue` → `schema.prisma:L10610`
- `TpvFeedback` → `schema.prisma:L10323`
- `TpvMessage` → `schema.prisma:L13631`
- `TpvMessageDelivery` → `schema.prisma:L13683`
- `TpvMessageResponse` → `schema.prisma:L13706`
- `TrainingModule` → `schema.prisma:L13761`
- `TrainingProgress` → `schema.prisma:L13838`
- `TrainingQuizQuestion` → `schema.prisma:L13820`
- `TrainingStep` → `schema.prisma:L13800`
- `TransactionCost` → `schema.prisma:L7065`
- `UnitConversion` → `schema.prisma:L2830`
- `UpsellAcceptance` → `schema.prisma:L8817`
- `UpsellAiRun` → `schema.prisma:L8837`
- `UpsellImpression` → `schema.prisma:L8777`
- `UpsellRule` → `schema.prisma:L8697`
- `user_sessions` → `schema.prisma:L6287`
- `Venue` → `schema.prisma:L167`
- `VenueAreaTicketSettings` → `schema.prisma:L15791`
- `VenueChatMessage` → `schema.prisma:L812`
- `VenueChatSession` → `schema.prisma:L767`
- `VenueCommission` → `schema.prisma:L15399`
- `VenueCreditAssessment` → `schema.prisma:L11154`
- `VenueCryptoConfig` → `schema.prisma:L13498`
- `VenueFeature` → `schema.prisma:L4784`
- `VenueIvaPorProducto` → `schema.prisma:L963`
- `VenueModule` → `schema.prisma:L11314`
- `VenuePaymentConfig` → `schema.prisma:L6388`
- `VenuePaymentLinkSettings` → `schema.prisma:L14738`
- `VenuePosSinAparato` → `schema.prisma:L974`
- `VenuePricingStructure` → `schema.prisma:L7005`
- `VenueRoleConfig` → `schema.prisma:L1486`
- `VenueRolePermission` → `schema.prisma:L1390`
- `VenueScaleSettings` → `schema.prisma:L16042`
- `VenueSettings` → `schema.prisma:L852`
- `VenueTenderType` → `schema.prisma:L4529`
- `VenueTenderTypeRevision` → `schema.prisma:L4594`
- `VenueTransaction` → `schema.prisma:L4721`
- `VenueWhatsappActivation` → `schema.prisma:L703`
- `WalletCardDesign` → `schema.prisma:L8162`
- `WalletPass` → `schema.prisma:L8063`
- `WalletPassRegistration` → `schema.prisma:L8129`
- `WebhookEvent` → `schema.prisma:L5086`
- `WebhookSubscription` → `schema.prisma:L6504`
- `WhatsappContactWindow` → `schema.prisma:L721`
- `WhatsappInboundEvent` → `schema.prisma:L741`
- `WorkShiftAssignment` → `schema.prisma:L3520`
- `WorkShiftTemplate` → `schema.prisma:L3497`
- `Zone` → `schema.prisma:L150`
