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

- `AccountingPeriodLock` → `schema.prisma:L17078`
- `AccountMapping` → `schema.prisma:L16973`
- `ActivityLog` → `schema.prisma:L7454`
- `Aggregator` → `schema.prisma:L15250`
- `AngelPayUserAccount` → `schema.prisma:L5999`
- `AppUpdate` → `schema.prisma:L13415`
- `Area` → `schema.prisma:L3229`
- `AreaTicket` → `schema.prisma:L15786`
- `AreaTicketCheckoutSession` → `schema.prisma:L15908`
- `AreaTicketExternalIncident` → `schema.prisma:L16155`
- `AreaTicketExternalSettlement` → `schema.prisma:L16120`
- `AreaTicketFulfillment` → `schema.prisma:L15984`
- `AreaTicketInventoryReservation` → `schema.prisma:L15879`
- `AreaTicketLine` → `schema.prisma:L15847`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15940`
- `AreaTicketPrintAttempt` → `schema.prisma:L15963`
- `BankStatement` → `schema.prisma:L16847`
- `BankStatementLine` → `schema.prisma:L16868`
- `BillingObligationConflict` → `schema.prisma:L5036`
- `BillingTaxProfile` → `schema.prisma:L17670`
- `BirthdayAutomation` → `schema.prisma:L7775`
- `BulkCommandOperation` → `schema.prisma:L10695`
- `CalendarSyncOutbox` → `schema.prisma:L14622`
- `CampaignDelivery` → `schema.prisma:L13573`
- `CapabilityGrant` → `schema.prisma:L4812`
- `CashCloseout` → `schema.prisma:L11080`
- `CashDeposit` → `schema.prisma:L13217`
- `CashDrawerEvent` → `schema.prisma:L15087`
- `CashDrawerSession` → `schema.prisma:L15048`
- `CashOutCommissionRate` → `schema.prisma:L17487`
- `CashOutScheduleDay` → `schema.prisma:L17510`
- `CashOutWithdrawal` → `schema.prisma:L17572`
- `CatalogBindingBatch` → `schema.prisma:L12111`
- `CatalogBindingLine` → `schema.prisma:L12147`
- `CatalogBrand` → `schema.prisma:L11564`
- `CatalogClientObservation` → `schema.prisma:L11877`
- `CatalogClientReadinessOverride` → `schema.prisma:L11896`
- `CatalogFamily` → `schema.prisma:L11614`
- `CatalogIdempotencyRecord` → `schema.prisma:L12010`
- `CatalogIdentifier` → `schema.prisma:L11745`
- `CatalogImportBatch` → `schema.prisma:L12053`
- `CatalogImportLine` → `schema.prisma:L12090`
- `CatalogItem` → `schema.prisma:L11647`
- `CatalogItemBusinessType` → `schema.prisma:L11707`
- `CatalogItemPrice` → `schema.prisma:L11795`
- `CatalogManufacturer` → `schema.prisma:L11588`
- `CatalogProductTypeMapping` → `schema.prisma:L11724`
- `CatalogPublicationBatch` → `schema.prisma:L12175`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12269`
- `CatalogPublicationLine` → `schema.prisma:L12216`
- `CatalogPublicationOutbox` → `schema.prisma:L12312`
- `CatalogValidationProfile` → `schema.prisma:L11766`
- `CatalogVenueBinding` → `schema.prisma:L11924`
- `CatalogVenueClientRequirement` → `schema.prisma:L11851`
- `CatalogVenueEventSequence` → `schema.prisma:L12295`
- `CatalogVenueOverride` → `schema.prisma:L11966`
- `CatalogVenueRollout` → `schema.prisma:L11826`
- `Cfdi` → `schema.prisma:L16675`
- `CfdiGlobalOrden` → `schema.prisma:L16800`
- `ChatbotTokenBudget` → `schema.prisma:L10343`
- `ChatConversation` → `schema.prisma:L10198`
- `ChatFeedback` → `schema.prisma:L10284`
- `ChatLearningEvent` → `schema.prisma:L10241`
- `ChatMessage` → `schema.prisma:L10221`
- `ChatTrainingData` → `schema.prisma:L10155`
- `CheckoutSession` → `schema.prisma:L6279`
- `ClassSession` → `schema.prisma:L14226`
- `CommissionCalculation` → `schema.prisma:L12993`
- `CommissionClawback` → `schema.prisma:L13169`
- `CommissionConfig` → `schema.prisma:L12759`
- `CommissionMilestone` → `schema.prisma:L12909`
- `CommissionOverride` → `schema.prisma:L12836`
- `CommissionPayout` → `schema.prisma:L13120`
- `CommissionSummary` → `schema.prisma:L13059`
- `CommissionTier` → `schema.prisma:L12873`
- `ConsentEvent` → `schema.prisma:L7637`
- `Consumer` → `schema.prisma:L7867`
- `ConsumerAuthAccount` → `schema.prisma:L7892`
- `CouponCode` → `schema.prisma:L8839`
- `CouponRedemption` → `schema.prisma:L8870`
- `CreditAssessmentHistory` → `schema.prisma:L11189`
- `CreditItemBalance` → `schema.prisma:L14838`
- `CreditOffer` → `schema.prisma:L11208`
- `CreditPack` → `schema.prisma:L14747`
- `CreditPackItem` → `schema.prisma:L14776`
- `CreditPackPurchase` → `schema.prisma:L14793`
- `CreditTransaction` → `schema.prisma:L14860`
- `Customer` → `schema.prisma:L7495`
- `CustomerApprovalDelivery` → `schema.prisma:L9857`
- `CustomerApprovalOutbox` → `schema.prisma:L9832`
- `CustomerCampaign` → `schema.prisma:L7725`
- `CustomerCampaignDelivery` → `schema.prisma:L7807`
- `CustomerCaptureToken` → `schema.prisma:L7673`
- `CustomerDiscount` → `schema.prisma:L8890`
- `CustomerGroup` → `schema.prisma:L7931`
- `CustomerOrderMetric` → `schema.prisma:L4028`
- `CustomerTaxProfile` → `schema.prisma:L16819`
- `DeliveryActivationRequest` → `schema.prisma:L6738`
- `DeliveryChannelLink` → `schema.prisma:L6577`
- `DeliveryConnectIntent` → `schema.prisma:L6689`
- `DeliveryLineAction` → `schema.prisma:L6650`
- `DeliveryOrderEvent` → `schema.prisma:L6762`
- `DeliveryStoreRevocation` → `schema.prisma:L6726`
- `DeviceToken` → `schema.prisma:L9159`
- `DigitalReceipt` → `schema.prisma:L4625`
- `Discount` → `schema.prisma:L8529`
- `EcommerceMerchant` → `schema.prisma:L6091`
- `EmailQuotaLedger` → `schema.prisma:L7854`
- `EmailSuppression` → `schema.prisma:L7842`
- `EmailTemplate` → `schema.prisma:L13512`
- `Employee` → `schema.prisma:L17335`
- `Estimate` → `schema.prisma:L15157`
- `EstimateItem` → `schema.prisma:L15185`
- `Expense` → `schema.prisma:L17122`
- `ExternalBusyBlock` → `schema.prisma:L14515`
- `Feature` → `schema.prisma:L4754`
- `FeeSchedule` → `schema.prisma:L5098`
- `FeeTier` → `schema.prisma:L5109`
- `FinancialAccount` → `schema.prisma:L15347`
- `FinancialConnection` → `schema.prisma:L15316`
- `FinancialProvider` → `schema.prisma:L15302`
- `FiscalEmisor` → `schema.prisma:L16591`
- `FiscalLossCarryforward` → `schema.prisma:L17245`
- `FixedAsset` → `schema.prisma:L17263`
- `FixedAssetDepreciation` → `schema.prisma:L17292`
- `FloorElement` → `schema.prisma:L3305`
- `FulfillmentArea` → `schema.prisma:L15651`
- `GeofenceRule` → `schema.prisma:L10780`
- `GoogleCalendarChannel` → `schema.prisma:L14492`
- `GoogleCalendarConnection` → `schema.prisma:L14444`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14545`
- `GoogleOAuthSession` → `schema.prisma:L14567`
- `HolidayCalendar` → `schema.prisma:L7378`
- `HybridBillingOperation` → `schema.prisma:L4960`
- `HybridCampaign` → `schema.prisma:L4837`
- `HybridContract` → `schema.prisma:L4917`
- `HybridContractSelection` → `schema.prisma:L4949`
- `HybridCreditAllocation` → `schema.prisma:L5016`
- `HybridOfferPublication` → `schema.prisma:L4864`
- `HybridPaymentPeriod` → `schema.prisma:L4995`
- `HybridPurchase` → `schema.prisma:L4884`
- `HybridRedemption` → `schema.prisma:L4978`
- `IdempotencyRequest` → `schema.prisma:L12634`
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
- `InventoryTransfer` → `schema.prisma:L15129`
- `InventoryWasteReport` → `schema.prisma:L2056`
- `Invitation` → `schema.prisma:L1498`
- `Invoice` → `schema.prisma:L5121`
- `InvoiceItem` → `schema.prisma:L5147`
- `ItemCategory` → `schema.prisma:L12347`
- `JournalEntry` → `schema.prisma:L17031`
- `JournalLine` → `schema.prisma:L17060`
- `KdsOrder` → `schema.prisma:L15395`
- `KdsOrderItem` → `schema.prisma:L15458`
- `KioskCheckInAttempt` → `schema.prisma:L17993`
- `KioskCheckInChallenge` → `schema.prisma:L17947`
- `KioskOutreachOutbox` → `schema.prisma:L18014`
- `LaunchCampaign` → `schema.prisma:L18352`
- `LaunchCampaignRedemption` → `schema.prisma:L18469`
- `LearnedPatterns` → `schema.prisma:L10265`
- `LedgerAccount` → `schema.prisma:L16923`
- `LiveDemoSession` → `schema.prisma:L834`
- `LowStockAlert` → `schema.prisma:L2891`
- `LoyaltyConfig` → `schema.prisma:L7961`
- `LoyaltyTransaction` → `schema.prisma:L8004`
- `MarketingCampaign` → `schema.prisma:L13530`
- `McpAuthCode` → `schema.prisma:L16474`
- `McpOAuthClient` → `schema.prisma:L16458`
- `McpRefreshToken` → `schema.prisma:L16492`
- `McpToolCall` → `schema.prisma:L16513`
- `MeasurementUnit` → `schema.prisma:L15235`
- `Menu` → `schema.prisma:L1716`
- `MenuCategory` → `schema.prisma:L1653`
- `MenuCategoryAssignment` → `schema.prisma:L1751`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16388`
- `MerchantAccount` → `schema.prisma:L5829`
- `MerchantFiscalConfig` → `schema.prisma:L16646`
- `MerchantRevenueShare` → `schema.prisma:L6958`
- `MerchantRoutingRule` → `schema.prisma:L5951`
- `MilestoneAchievement` → `schema.prisma:L12954`
- `Modifier` → `schema.prisma:L4227`
- `ModifierGroup` → `schema.prisma:L4191`
- `Module` → `schema.prisma:L11256`
- `MoneyAnomaly` → `schema.prisma:L6861`
- `MonthlyVenueProfit` → `schema.prisma:L7404`
- `Notification` → `schema.prisma:L9061`
- `NotificationPreference` → `schema.prisma:L9108`
- `NotificationTemplate` → `schema.prisma:L9135`
- `OAuthState` → `schema.prisma:L1549`
- `OnboardingProgress` → `schema.prisma:L1567`
- `Order` → `schema.prisma:L3754`
- `OrderAction` → `schema.prisma:L4298`
- `OrderCustomer` → `schema.prisma:L4007`
- `OrderDiscount` → `schema.prisma:L8922`
- `OrderFulfillment` → `schema.prisma:L15706`
- `OrderFulfillmentLine` → `schema.prisma:L15737`
- `OrderItem` → `schema.prisma:L4043`
- `OrderItemModifier` → `schema.prisma:L4280`
- `OrderItemSelloIva` → `schema.prisma:L16780`
- `OrderPromotion` → `schema.prisma:L17910`
- `OrderServiceCharge` → `schema.prisma:L9006`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13331`
- `OrganizationEntitlement` → `schema.prisma:L11539`
- `OrganizationGoal` → `schema.prisma:L13289`
- `OrganizationModule` → `schema.prisma:L11316`
- `OrganizationPaymentConfig` → `schema.prisma:L6403`
- `OrganizationPayoutConfig` → `schema.prisma:L13364`
- `OrganizationPricingStructure` → `schema.prisma:L6435`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13312`
- `OtpChallenge` → `schema.prisma:L7911`
- `OvertimeApproval` → `schema.prisma:L3532`
- `PartnerAPIKey` → `schema.prisma:L6233`
- `Payment` → `schema.prisma:L4331`
- `PaymentAllocation` → `schema.prisma:L4604`
- `PaymentEffect` → `schema.prisma:L18284`
- `PaymentLink` → `schema.prisma:L14906`
- `PaymentLinkAttribution` → `schema.prisma:L15014`
- `PaymentLinkItem` → `schema.prisma:L14969`
- `PaymentLinkItemModifier` → `schema.prisma:L14996`
- `PaymentProvider` → `schema.prisma:L5788`
- `PayrollLine` → `schema.prisma:L17406`
- `PayrollRun` → `schema.prisma:L17375`
- `PerformanceGoal` → `schema.prisma:L13266`
- `PermissionOverride` → `schema.prisma:L1422`
- `PermissionSet` → `schema.prisma:L1445`
- `PlatformAnnouncement` → `schema.prisma:L18074`
- `PlatformAnnouncementClick` → `schema.prisma:L18139`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18176`
- `PlatformCfdi` → `schema.prisma:L17703`
- `PlatformEmisor` → `schema.prisma:L17643`
- `PlatformSettings` → `schema.prisma:L6210`
- `PosCommand` → `schema.prisma:L9189`
- `PosConnectionStatus` → `schema.prisma:L968`
- `PosSyncIntent` → `schema.prisma:L17781`
- `PricingPolicy` → `schema.prisma:L2787`
- `Printer` → `schema.prisma:L15507`
- `PrintGateway` → `schema.prisma:L15564`
- `PrintJob` → `schema.prisma:L16287`
- `PrintStation` → `schema.prisma:L15582`
- `PrivacyNoticeVersion` → `schema.prisma:L7659`
- `ProcessedStripeEvent` → `schema.prisma:L6847`
- `ProcessorReliabilityMetric` → `schema.prisma:L7332`
- `Product` → `schema.prisma:L1769`
- `ProductModifierGroup` → `schema.prisma:L4268`
- `ProductOption` → `schema.prisma:L15212`
- `ProductOptionValue` → `schema.prisma:L15223`
- `ProductStaff` → `schema.prisma:L14141`
- `PromoterBankAccount` → `schema.prisma:L17526`
- `PromoterCommissionEntry` → `schema.prisma:L17545`
- `PromoterLocationPing` → `schema.prisma:L3720`
- `Promotion` → `schema.prisma:L17832`
- `PromotionGroup` → `schema.prisma:L17871`
- `PromotionOption` → `schema.prisma:L17887`
- `ProviderCostStructure` → `schema.prisma:L6883`
- `ProviderEventLog` → `schema.prisma:L6512`
- `PurchaseOrder` → `schema.prisma:L2512`
- `PurchaseOrderInvoice` → `schema.prisma:L2657`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2714`
- `PurchaseOrderItem` → `schema.prisma:L2570`
- `RateCorrectionBatch` → `schema.prisma:L7108`
- `RateCorrectionEntry` → `schema.prisma:L7150`
- `RawMaterial` → `schema.prisma:L2268`
- `RawMaterialMovement` → `schema.prisma:L2840`
- `RawMaterialPresentation` → `schema.prisma:L2344`
- `ReceiptLayout` → `schema.prisma:L18318`
- `Recipe` → `schema.prisma:L2364`
- `RecipeLine` → `schema.prisma:L2388`
- `Referral` → `schema.prisma:L8377`
- `ReferralProgramConfig` → `schema.prisma:L8342`
- `ReferralRewardGrant` → `schema.prisma:L8468`
- `ReferralTierReward` → `schema.prisma:L8440`
- `ReferralTierUnlock` → `schema.prisma:L8513`
- `RefreshGrant` → `schema.prisma:L18263`
- `Reservation` → `schema.prisma:L13909`
- `ReservationGoogleEventMapping` → `schema.prisma:L14679`
- `ReservationModifier` → `schema.prisma:L14089`
- `ReservationReminderSent` → `schema.prisma:L14072`
- `ReservationSettings` → `schema.prisma:L14303`
- `ReservationWaitlistEntry` → `schema.prisma:L14271`
- `Review` → `schema.prisma:L5165`
- `SalesRetention` → `schema.prisma:L17226`
- `SaleVerification` → `schema.prisma:L4658`
- `ScaleProfile` → `schema.prisma:L16028`
- `ScheduledCommand` → `schema.prisma:L10740`
- `SerializedItem` → `schema.prisma:L12390`
- `SerializedItemCustodyEvent` → `schema.prisma:L12557`
- `ServiceCharge` → `schema.prisma:L8977`
- `Session` → `schema.prisma:L18242`
- `SettlementConfiguration` → `schema.prisma:L7183`
- `SettlementConfirmation` → `schema.prisma:L7296`
- `SettlementIncident` → `schema.prisma:L7247`
- `SettlementSimulation` → `schema.prisma:L7218`
- `Shift` → `schema.prisma:L3343`
- `SimRegistrationRequest` → `schema.prisma:L12595`
- `SimRegistrationRequestItem` → `schema.prisma:L12617`
- `SlotHold` → `schema.prisma:L14172`
- `Staff` → `schema.prisma:L988`
- `StaffDocument` → `schema.prisma:L3591`
- `StaffOnboardingState` → `schema.prisma:L16358`
- `StaffOrganization` → `schema.prisma:L1321`
- `StaffPasskey` → `schema.prisma:L1348`
- `StaffSchedule` → `schema.prisma:L14112`
- `StaffScheduleException` → `schema.prisma:L14124`
- `StaffVenue` → `schema.prisma:L1245`
- `StaffWorkSchedule` → `schema.prisma:L3468`
- `StaffWorkScheduleException` → `schema.prisma:L3566`
- `StampCard` → `schema.prisma:L8225`
- `StampEvent` → `schema.prisma:L8264`
- `StampReward` → `schema.prisma:L8302`
- `StockAlertConfig` → `schema.prisma:L13248`
- `StockBatch` → `schema.prisma:L3006`
- `StockCount` → `schema.prisma:L2923`
- `StockCountItem` → `schema.prisma:L2951`
- `StripeWebhookEvent` → `schema.prisma:L6830`
- `Supplier` → `schema.prisma:L2423`
- `SupplierItemCode` → `schema.prisma:L2755`
- `SupplierPricing` → `schema.prisma:L2478`
- `Table` → `schema.prisma:L3255`
- `Terminal` → `schema.prisma:L5216`
- `TerminalAttemptResolution` → `schema.prisma:L5647`
- `TerminalHealth` → `schema.prisma:L5467`
- `TerminalLog` → `schema.prisma:L5441`
- `TerminalOrder` → `schema.prisma:L5691`
- `TerminalOrderItem` → `schema.prisma:L5766`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5619`
- `TerminalPaymentRequest` → `schema.prisma:L5538`
- `TimeEntry` → `schema.prisma:L3633`
- `TimeEntryBreak` → `schema.prisma:L3702`
- `TokenPurchase` → `schema.prisma:L10414`
- `TokenUsageRecord` → `schema.prisma:L10386`
- `TpvCommandHistory` → `schema.prisma:L10646`
- `TpvCommandQueue` → `schema.prisma:L10586`
- `TpvFeedback` → `schema.prisma:L10299`
- `TpvMessage` → `schema.prisma:L13605`
- `TpvMessageDelivery` → `schema.prisma:L13657`
- `TpvMessageResponse` → `schema.prisma:L13680`
- `TrainingModule` → `schema.prisma:L13735`
- `TrainingProgress` → `schema.prisma:L13812`
- `TrainingQuizQuestion` → `schema.prisma:L13794`
- `TrainingStep` → `schema.prisma:L13774`
- `TransactionCost` → `schema.prisma:L7046`
- `UnitConversion` → `schema.prisma:L2818`
- `UpsellAcceptance` → `schema.prisma:L8798`
- `UpsellAiRun` → `schema.prisma:L8818`
- `UpsellImpression` → `schema.prisma:L8758`
- `UpsellRule` → `schema.prisma:L8678`
- `user_sessions` → `schema.prisma:L6268`
- `Venue` → `schema.prisma:L167`
- `VenueAreaTicketSettings` → `schema.prisma:L15765`
- `VenueChatMessage` → `schema.prisma:L810`
- `VenueChatSession` → `schema.prisma:L765`
- `VenueCommission` → `schema.prisma:L15373`
- `VenueCreditAssessment` → `schema.prisma:L11128`
- `VenueCryptoConfig` → `schema.prisma:L13472`
- `VenueFeature` → `schema.prisma:L4772`
- `VenueIvaPorProducto` → `schema.prisma:L961`
- `VenueModule` → `schema.prisma:L11288`
- `VenuePaymentConfig` → `schema.prisma:L6369`
- `VenuePaymentLinkSettings` → `schema.prisma:L14712`
- `VenuePricingStructure` → `schema.prisma:L6986`
- `VenueRoleConfig` → `schema.prisma:L1474`
- `VenueRolePermission` → `schema.prisma:L1378`
- `VenueScaleSettings` → `schema.prisma:L16016`
- `VenueSettings` → `schema.prisma:L850`
- `VenueTenderType` → `schema.prisma:L4517`
- `VenueTenderTypeRevision` → `schema.prisma:L4582`
- `VenueTransaction` → `schema.prisma:L4709`
- `VenueWhatsappActivation` → `schema.prisma:L701`
- `WalletCardDesign` → `schema.prisma:L8143`
- `WalletPass` → `schema.prisma:L8044`
- `WalletPassRegistration` → `schema.prisma:L8110`
- `WebhookEvent` → `schema.prisma:L5074`
- `WebhookSubscription` → `schema.prisma:L6485`
- `WhatsappContactWindow` → `schema.prisma:L719`
- `WhatsappInboundEvent` → `schema.prisma:L739`
- `WorkShiftAssignment` → `schema.prisma:L3508`
- `WorkShiftTemplate` → `schema.prisma:L3485`
- `Zone` → `schema.prisma:L150`
