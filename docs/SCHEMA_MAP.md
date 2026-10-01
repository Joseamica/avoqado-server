# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **390 models / 361 enums / ~18,500 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L17110`
- `AccountMapping` → `schema.prisma:L17005`
- `ActivityLog` → `schema.prisma:L7486`
- `Aggregator` → `schema.prisma:L15282`
- `AngelPayUserAccount` → `schema.prisma:L6031`
- `AppUpdate` → `schema.prisma:L13447`
- `Area` → `schema.prisma:L3229`
- `AreaTicket` → `schema.prisma:L15818`
- `AreaTicketCheckoutSession` → `schema.prisma:L15940`
- `AreaTicketExternalIncident` → `schema.prisma:L16187`
- `AreaTicketExternalSettlement` → `schema.prisma:L16152`
- `AreaTicketFulfillment` → `schema.prisma:L16016`
- `AreaTicketInventoryReservation` → `schema.prisma:L15911`
- `AreaTicketLine` → `schema.prisma:L15879`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15972`
- `AreaTicketPrintAttempt` → `schema.prisma:L15995`
- `BankStatement` → `schema.prisma:L16879`
- `BankStatementLine` → `schema.prisma:L16900`
- `BillingObligationConflict` → `schema.prisma:L5068`
- `BillingTaxProfile` → `schema.prisma:L17702`
- `BirthdayAutomation` → `schema.prisma:L7807`
- `BulkCommandOperation` → `schema.prisma:L10727`
- `CalendarSyncOutbox` → `schema.prisma:L14654`
- `CampaignDelivery` → `schema.prisma:L13605`
- `CapabilityGrant` → `schema.prisma:L4808`
- `CashCloseout` → `schema.prisma:L11112`
- `CashDeposit` → `schema.prisma:L13249`
- `CashDrawerEvent` → `schema.prisma:L15119`
- `CashDrawerSession` → `schema.prisma:L15080`
- `CashOutCommissionRate` → `schema.prisma:L17519`
- `CashOutScheduleDay` → `schema.prisma:L17542`
- `CashOutWithdrawal` → `schema.prisma:L17604`
- `CatalogBindingBatch` → `schema.prisma:L12143`
- `CatalogBindingLine` → `schema.prisma:L12179`
- `CatalogBrand` → `schema.prisma:L11596`
- `CatalogClientObservation` → `schema.prisma:L11909`
- `CatalogClientReadinessOverride` → `schema.prisma:L11928`
- `CatalogFamily` → `schema.prisma:L11646`
- `CatalogIdempotencyRecord` → `schema.prisma:L12042`
- `CatalogIdentifier` → `schema.prisma:L11777`
- `CatalogImportBatch` → `schema.prisma:L12085`
- `CatalogImportLine` → `schema.prisma:L12122`
- `CatalogItem` → `schema.prisma:L11679`
- `CatalogItemBusinessType` → `schema.prisma:L11739`
- `CatalogItemPrice` → `schema.prisma:L11827`
- `CatalogManufacturer` → `schema.prisma:L11620`
- `CatalogProductTypeMapping` → `schema.prisma:L11756`
- `CatalogPublicationBatch` → `schema.prisma:L12207`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12301`
- `CatalogPublicationLine` → `schema.prisma:L12248`
- `CatalogPublicationOutbox` → `schema.prisma:L12344`
- `CatalogValidationProfile` → `schema.prisma:L11798`
- `CatalogVenueBinding` → `schema.prisma:L11956`
- `CatalogVenueClientRequirement` → `schema.prisma:L11883`
- `CatalogVenueEventSequence` → `schema.prisma:L12327`
- `CatalogVenueOverride` → `schema.prisma:L11998`
- `CatalogVenueRollout` → `schema.prisma:L11858`
- `Cfdi` → `schema.prisma:L16707`
- `CfdiGlobalOrden` → `schema.prisma:L16832`
- `ChatbotTokenBudget` → `schema.prisma:L10375`
- `ChatConversation` → `schema.prisma:L10230`
- `ChatFeedback` → `schema.prisma:L10316`
- `ChatLearningEvent` → `schema.prisma:L10273`
- `ChatMessage` → `schema.prisma:L10253`
- `ChatTrainingData` → `schema.prisma:L10187`
- `CheckoutSession` → `schema.prisma:L6311`
- `ClassSession` → `schema.prisma:L14258`
- `CommissionCalculation` → `schema.prisma:L13025`
- `CommissionClawback` → `schema.prisma:L13201`
- `CommissionConfig` → `schema.prisma:L12791`
- `CommissionMilestone` → `schema.prisma:L12941`
- `CommissionOverride` → `schema.prisma:L12868`
- `CommissionPayout` → `schema.prisma:L13152`
- `CommissionSummary` → `schema.prisma:L13091`
- `CommissionTier` → `schema.prisma:L12905`
- `ConsentEvent` → `schema.prisma:L7669`
- `Consumer` → `schema.prisma:L7899`
- `ConsumerAuthAccount` → `schema.prisma:L7924`
- `CouponCode` → `schema.prisma:L8871`
- `CouponRedemption` → `schema.prisma:L8902`
- `CreditAssessmentHistory` → `schema.prisma:L11221`
- `CreditItemBalance` → `schema.prisma:L14870`
- `CreditOffer` → `schema.prisma:L11240`
- `CreditPack` → `schema.prisma:L14779`
- `CreditPackItem` → `schema.prisma:L14808`
- `CreditPackPurchase` → `schema.prisma:L14825`
- `CreditTransaction` → `schema.prisma:L14892`
- `Customer` → `schema.prisma:L7527`
- `CustomerApprovalDelivery` → `schema.prisma:L9889`
- `CustomerApprovalOutbox` → `schema.prisma:L9864`
- `CustomerCampaign` → `schema.prisma:L7757`
- `CustomerCampaignDelivery` → `schema.prisma:L7839`
- `CustomerCaptureToken` → `schema.prisma:L7705`
- `CustomerDiscount` → `schema.prisma:L8922`
- `CustomerGroup` → `schema.prisma:L7963`
- `CustomerOrderMetric` → `schema.prisma:L4028`
- `CustomerTaxProfile` → `schema.prisma:L16851`
- `DeliveryActivationRequest` → `schema.prisma:L6770`
- `DeliveryChannelLink` → `schema.prisma:L6609`
- `DeliveryConnectIntent` → `schema.prisma:L6721`
- `DeliveryLineAction` → `schema.prisma:L6682`
- `DeliveryOrderEvent` → `schema.prisma:L6794`
- `DeliveryStoreRevocation` → `schema.prisma:L6758`
- `DeviceToken` → `schema.prisma:L9191`
- `DigitalReceipt` → `schema.prisma:L4621`
- `Discount` → `schema.prisma:L8561`
- `EcommerceMerchant` → `schema.prisma:L6123`
- `EmailQuotaLedger` → `schema.prisma:L7886`
- `EmailSuppression` → `schema.prisma:L7874`
- `EmailTemplate` → `schema.prisma:L13544`
- `Employee` → `schema.prisma:L17367`
- `Estimate` → `schema.prisma:L15189`
- `EstimateItem` → `schema.prisma:L15217`
- `Expense` → `schema.prisma:L17154`
- `ExternalBusyBlock` → `schema.prisma:L14547`
- `Feature` → `schema.prisma:L4750`
- `FeeSchedule` → `schema.prisma:L5130`
- `FeeTier` → `schema.prisma:L5141`
- `FinancialAccount` → `schema.prisma:L15379`
- `FinancialConnection` → `schema.prisma:L15348`
- `FinancialProvider` → `schema.prisma:L15334`
- `FiscalEmisor` → `schema.prisma:L16623`
- `FiscalLossCarryforward` → `schema.prisma:L17277`
- `FixedAsset` → `schema.prisma:L17295`
- `FixedAssetDepreciation` → `schema.prisma:L17324`
- `FloorElement` → `schema.prisma:L3305`
- `FulfillmentArea` → `schema.prisma:L15683`
- `GeofenceRule` → `schema.prisma:L10812`
- `GoogleCalendarChannel` → `schema.prisma:L14524`
- `GoogleCalendarConnection` → `schema.prisma:L14476`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14577`
- `GoogleOAuthSession` → `schema.prisma:L14599`
- `HolidayCalendar` → `schema.prisma:L7410`
- `HybridBillingOperation` → `schema.prisma:L4992`
- `HybridCampaign` → `schema.prisma:L4833`
- `HybridContract` → `schema.prisma:L4949`
- `HybridContractSelection` → `schema.prisma:L4981`
- `HybridCreditAllocation` → `schema.prisma:L5048`
- `HybridOfferPublication` → `schema.prisma:L4896`
- `HybridPaymentPeriod` → `schema.prisma:L5027`
- `HybridPromotionGroup` → `schema.prisma:L4877`
- `HybridPurchase` → `schema.prisma:L4916`
- `HybridRedemption` → `schema.prisma:L5010`
- `IdempotencyRequest` → `schema.prisma:L12666`
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
- `InventoryTransfer` → `schema.prisma:L15161`
- `InventoryWasteReport` → `schema.prisma:L2056`
- `Invitation` → `schema.prisma:L1498`
- `Invoice` → `schema.prisma:L5153`
- `InvoiceItem` → `schema.prisma:L5179`
- `ItemCategory` → `schema.prisma:L12379`
- `JournalEntry` → `schema.prisma:L17063`
- `JournalLine` → `schema.prisma:L17092`
- `KdsOrder` → `schema.prisma:L15427`
- `KdsOrderItem` → `schema.prisma:L15490`
- `KioskCheckInAttempt` → `schema.prisma:L18025`
- `KioskCheckInChallenge` → `schema.prisma:L17979`
- `KioskOutreachOutbox` → `schema.prisma:L18046`
- `LaunchCampaign` → `schema.prisma:L18384`
- `LaunchCampaignRedemption` → `schema.prisma:L18501`
- `LearnedPatterns` → `schema.prisma:L10297`
- `LedgerAccount` → `schema.prisma:L16955`
- `LiveDemoSession` → `schema.prisma:L834`
- `LowStockAlert` → `schema.prisma:L2891`
- `LoyaltyConfig` → `schema.prisma:L7993`
- `LoyaltyTransaction` → `schema.prisma:L8036`
- `MarketingCampaign` → `schema.prisma:L13562`
- `McpAuthCode` → `schema.prisma:L16506`
- `McpOAuthClient` → `schema.prisma:L16490`
- `McpRefreshToken` → `schema.prisma:L16524`
- `McpToolCall` → `schema.prisma:L16545`
- `MeasurementUnit` → `schema.prisma:L15267`
- `Menu` → `schema.prisma:L1716`
- `MenuCategory` → `schema.prisma:L1653`
- `MenuCategoryAssignment` → `schema.prisma:L1751`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16420`
- `MerchantAccount` → `schema.prisma:L5861`
- `MerchantFiscalConfig` → `schema.prisma:L16678`
- `MerchantRevenueShare` → `schema.prisma:L6990`
- `MerchantRoutingRule` → `schema.prisma:L5983`
- `MilestoneAchievement` → `schema.prisma:L12986`
- `Modifier` → `schema.prisma:L4227`
- `ModifierGroup` → `schema.prisma:L4191`
- `Module` → `schema.prisma:L11288`
- `MoneyAnomaly` → `schema.prisma:L6893`
- `MonthlyVenueProfit` → `schema.prisma:L7436`
- `Notification` → `schema.prisma:L9093`
- `NotificationPreference` → `schema.prisma:L9140`
- `NotificationTemplate` → `schema.prisma:L9167`
- `OAuthState` → `schema.prisma:L1549`
- `OnboardingProgress` → `schema.prisma:L1567`
- `Order` → `schema.prisma:L3754`
- `OrderAction` → `schema.prisma:L4294`
- `OrderCustomer` → `schema.prisma:L4007`
- `OrderDiscount` → `schema.prisma:L8954`
- `OrderFulfillment` → `schema.prisma:L15738`
- `OrderFulfillmentLine` → `schema.prisma:L15769`
- `OrderItem` → `schema.prisma:L4043`
- `OrderItemModifier` → `schema.prisma:L4276`
- `OrderItemSelloIva` → `schema.prisma:L16812`
- `OrderPromotion` → `schema.prisma:L17942`
- `OrderServiceCharge` → `schema.prisma:L9038`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13363`
- `OrganizationEntitlement` → `schema.prisma:L11571`
- `OrganizationGoal` → `schema.prisma:L13321`
- `OrganizationModule` → `schema.prisma:L11348`
- `OrganizationPaymentConfig` → `schema.prisma:L6435`
- `OrganizationPayoutConfig` → `schema.prisma:L13396`
- `OrganizationPricingStructure` → `schema.prisma:L6467`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13344`
- `OtpChallenge` → `schema.prisma:L7943`
- `OvertimeApproval` → `schema.prisma:L3532`
- `PartnerAPIKey` → `schema.prisma:L6265`
- `Payment` → `schema.prisma:L4327`
- `PaymentAllocation` → `schema.prisma:L4600`
- `PaymentEffect` → `schema.prisma:L18316`
- `PaymentLink` → `schema.prisma:L14938`
- `PaymentLinkAttribution` → `schema.prisma:L15046`
- `PaymentLinkItem` → `schema.prisma:L15001`
- `PaymentLinkItemModifier` → `schema.prisma:L15028`
- `PaymentProvider` → `schema.prisma:L5820`
- `PayrollLine` → `schema.prisma:L17438`
- `PayrollRun` → `schema.prisma:L17407`
- `PerformanceGoal` → `schema.prisma:L13298`
- `PermissionOverride` → `schema.prisma:L1422`
- `PermissionSet` → `schema.prisma:L1445`
- `PlatformAnnouncement` → `schema.prisma:L18106`
- `PlatformAnnouncementClick` → `schema.prisma:L18171`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18208`
- `PlatformCfdi` → `schema.prisma:L17735`
- `PlatformEmisor` → `schema.prisma:L17675`
- `PlatformSettings` → `schema.prisma:L6242`
- `PosCommand` → `schema.prisma:L9221`
- `PosConnectionStatus` → `schema.prisma:L968`
- `PosSyncIntent` → `schema.prisma:L17813`
- `PricingPolicy` → `schema.prisma:L2787`
- `Printer` → `schema.prisma:L15539`
- `PrintGateway` → `schema.prisma:L15596`
- `PrintJob` → `schema.prisma:L16319`
- `PrintStation` → `schema.prisma:L15614`
- `PrivacyNoticeVersion` → `schema.prisma:L7691`
- `ProcessedStripeEvent` → `schema.prisma:L6879`
- `ProcessorReliabilityMetric` → `schema.prisma:L7364`
- `Product` → `schema.prisma:L1769`
- `ProductModifierGroup` → `schema.prisma:L4264`
- `ProductOption` → `schema.prisma:L15244`
- `ProductOptionValue` → `schema.prisma:L15255`
- `ProductStaff` → `schema.prisma:L14173`
- `PromoterBankAccount` → `schema.prisma:L17558`
- `PromoterCommissionEntry` → `schema.prisma:L17577`
- `PromoterLocationPing` → `schema.prisma:L3720`
- `Promotion` → `schema.prisma:L17864`
- `PromotionGroup` → `schema.prisma:L17903`
- `PromotionOption` → `schema.prisma:L17919`
- `ProviderCostStructure` → `schema.prisma:L6915`
- `ProviderEventLog` → `schema.prisma:L6544`
- `PurchaseOrder` → `schema.prisma:L2512`
- `PurchaseOrderInvoice` → `schema.prisma:L2657`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2714`
- `PurchaseOrderItem` → `schema.prisma:L2570`
- `RateCorrectionBatch` → `schema.prisma:L7140`
- `RateCorrectionEntry` → `schema.prisma:L7182`
- `RawMaterial` → `schema.prisma:L2268`
- `RawMaterialMovement` → `schema.prisma:L2840`
- `RawMaterialPresentation` → `schema.prisma:L2344`
- `ReceiptLayout` → `schema.prisma:L18350`
- `Recipe` → `schema.prisma:L2364`
- `RecipeLine` → `schema.prisma:L2388`
- `Referral` → `schema.prisma:L8409`
- `ReferralProgramConfig` → `schema.prisma:L8374`
- `ReferralRewardGrant` → `schema.prisma:L8500`
- `ReferralTierReward` → `schema.prisma:L8472`
- `ReferralTierUnlock` → `schema.prisma:L8545`
- `RefreshGrant` → `schema.prisma:L18295`
- `Reservation` → `schema.prisma:L13941`
- `ReservationGoogleEventMapping` → `schema.prisma:L14711`
- `ReservationModifier` → `schema.prisma:L14121`
- `ReservationReminderSent` → `schema.prisma:L14104`
- `ReservationSettings` → `schema.prisma:L14335`
- `ReservationWaitlistEntry` → `schema.prisma:L14303`
- `Review` → `schema.prisma:L5197`
- `SalesRetention` → `schema.prisma:L17258`
- `SaleVerification` → `schema.prisma:L4654`
- `ScaleProfile` → `schema.prisma:L16060`
- `ScheduledCommand` → `schema.prisma:L10772`
- `SerializedItem` → `schema.prisma:L12422`
- `SerializedItemCustodyEvent` → `schema.prisma:L12589`
- `ServiceCharge` → `schema.prisma:L9009`
- `Session` → `schema.prisma:L18274`
- `SettlementConfiguration` → `schema.prisma:L7215`
- `SettlementConfirmation` → `schema.prisma:L7328`
- `SettlementIncident` → `schema.prisma:L7279`
- `SettlementSimulation` → `schema.prisma:L7250`
- `Shift` → `schema.prisma:L3343`
- `SimRegistrationRequest` → `schema.prisma:L12627`
- `SimRegistrationRequestItem` → `schema.prisma:L12649`
- `SlotHold` → `schema.prisma:L14204`
- `Staff` → `schema.prisma:L988`
- `StaffDocument` → `schema.prisma:L3591`
- `StaffOnboardingState` → `schema.prisma:L16390`
- `StaffOrganization` → `schema.prisma:L1321`
- `StaffPasskey` → `schema.prisma:L1348`
- `StaffSchedule` → `schema.prisma:L14144`
- `StaffScheduleException` → `schema.prisma:L14156`
- `StaffVenue` → `schema.prisma:L1245`
- `StaffWorkSchedule` → `schema.prisma:L3468`
- `StaffWorkScheduleException` → `schema.prisma:L3566`
- `StampCard` → `schema.prisma:L8257`
- `StampEvent` → `schema.prisma:L8296`
- `StampReward` → `schema.prisma:L8334`
- `StockAlertConfig` → `schema.prisma:L13280`
- `StockBatch` → `schema.prisma:L3006`
- `StockCount` → `schema.prisma:L2923`
- `StockCountItem` → `schema.prisma:L2951`
- `StripeWebhookEvent` → `schema.prisma:L6862`
- `Supplier` → `schema.prisma:L2423`
- `SupplierItemCode` → `schema.prisma:L2755`
- `SupplierPricing` → `schema.prisma:L2478`
- `Table` → `schema.prisma:L3255`
- `Terminal` → `schema.prisma:L5248`
- `TerminalAttemptResolution` → `schema.prisma:L5679`
- `TerminalHealth` → `schema.prisma:L5499`
- `TerminalLog` → `schema.prisma:L5473`
- `TerminalOrder` → `schema.prisma:L5723`
- `TerminalOrderItem` → `schema.prisma:L5798`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5651`
- `TerminalPaymentRequest` → `schema.prisma:L5570`
- `TimeEntry` → `schema.prisma:L3633`
- `TimeEntryBreak` → `schema.prisma:L3702`
- `TokenPurchase` → `schema.prisma:L10446`
- `TokenUsageRecord` → `schema.prisma:L10418`
- `TpvCommandHistory` → `schema.prisma:L10678`
- `TpvCommandQueue` → `schema.prisma:L10618`
- `TpvFeedback` → `schema.prisma:L10331`
- `TpvMessage` → `schema.prisma:L13637`
- `TpvMessageDelivery` → `schema.prisma:L13689`
- `TpvMessageResponse` → `schema.prisma:L13712`
- `TrainingModule` → `schema.prisma:L13767`
- `TrainingProgress` → `schema.prisma:L13844`
- `TrainingQuizQuestion` → `schema.prisma:L13826`
- `TrainingStep` → `schema.prisma:L13806`
- `TransactionCost` → `schema.prisma:L7078`
- `UnitConversion` → `schema.prisma:L2818`
- `UpsellAcceptance` → `schema.prisma:L8830`
- `UpsellAiRun` → `schema.prisma:L8850`
- `UpsellImpression` → `schema.prisma:L8790`
- `UpsellRule` → `schema.prisma:L8710`
- `user_sessions` → `schema.prisma:L6300`
- `Venue` → `schema.prisma:L167`
- `VenueAreaTicketSettings` → `schema.prisma:L15797`
- `VenueChatMessage` → `schema.prisma:L810`
- `VenueChatSession` → `schema.prisma:L765`
- `VenueCommission` → `schema.prisma:L15405`
- `VenueCreditAssessment` → `schema.prisma:L11160`
- `VenueCryptoConfig` → `schema.prisma:L13504`
- `VenueFeature` → `schema.prisma:L4768`
- `VenueIvaPorProducto` → `schema.prisma:L961`
- `VenueModule` → `schema.prisma:L11320`
- `VenuePaymentConfig` → `schema.prisma:L6401`
- `VenuePaymentLinkSettings` → `schema.prisma:L14744`
- `VenuePricingStructure` → `schema.prisma:L7018`
- `VenueRoleConfig` → `schema.prisma:L1474`
- `VenueRolePermission` → `schema.prisma:L1378`
- `VenueScaleSettings` → `schema.prisma:L16048`
- `VenueSettings` → `schema.prisma:L850`
- `VenueTenderType` → `schema.prisma:L4513`
- `VenueTenderTypeRevision` → `schema.prisma:L4578`
- `VenueTransaction` → `schema.prisma:L4705`
- `VenueWhatsappActivation` → `schema.prisma:L701`
- `WalletCardDesign` → `schema.prisma:L8175`
- `WalletPass` → `schema.prisma:L8076`
- `WalletPassRegistration` → `schema.prisma:L8142`
- `WebhookEvent` → `schema.prisma:L5106`
- `WebhookSubscription` → `schema.prisma:L6517`
- `WhatsappContactWindow` → `schema.prisma:L719`
- `WhatsappInboundEvent` → `schema.prisma:L739`
- `WorkShiftAssignment` → `schema.prisma:L3508`
- `WorkShiftTemplate` → `schema.prisma:L3485`
- `Zone` → `schema.prisma:L150`
