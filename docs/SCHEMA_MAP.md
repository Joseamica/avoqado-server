# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **377 models / 360 enums / ~18,100 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
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
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
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

- `AccountingPeriodLock` → `schema.prisma:L16740`
- `AccountMapping` → `schema.prisma:L16636`
- `ActivityLog` → `schema.prisma:L7205`
- `Aggregator` → `schema.prisma:L15001`
- `AngelPayUserAccount` → `schema.prisma:L5750`
- `AppUpdate` → `schema.prisma:L13166`
- `Area` → `schema.prisma:L3222`
- `AreaTicket` → `schema.prisma:L15514`
- `AreaTicketCheckoutSession` → `schema.prisma:L15636`
- `AreaTicketExternalIncident` → `schema.prisma:L15883`
- `AreaTicketExternalSettlement` → `schema.prisma:L15848`
- `AreaTicketFulfillment` → `schema.prisma:L15712`
- `AreaTicketInventoryReservation` → `schema.prisma:L15607`
- `AreaTicketLine` → `schema.prisma:L15575`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15668`
- `AreaTicketPrintAttempt` → `schema.prisma:L15691`
- `BankStatement` → `schema.prisma:L16510`
- `BankStatementLine` → `schema.prisma:L16531`
- `BillingObligationConflict` → `schema.prisma:L4787`
- `BillingTaxProfile` → `schema.prisma:L17332`
- `BirthdayAutomation` → `schema.prisma:L7526`
- `BulkCommandOperation` → `schema.prisma:L10446`
- `CalendarSyncOutbox` → `schema.prisma:L14373`
- `CampaignDelivery` → `schema.prisma:L13324`
- `CashCloseout` → `schema.prisma:L10831`
- `CashDeposit` → `schema.prisma:L12968`
- `CashDrawerEvent` → `schema.prisma:L14838`
- `CashDrawerSession` → `schema.prisma:L14799`
- `CashOutCommissionRate` → `schema.prisma:L17149`
- `CashOutScheduleDay` → `schema.prisma:L17172`
- `CashOutWithdrawal` → `schema.prisma:L17234`
- `CatalogBindingBatch` → `schema.prisma:L11862`
- `CatalogBindingLine` → `schema.prisma:L11898`
- `CatalogBrand` → `schema.prisma:L11315`
- `CatalogClientObservation` → `schema.prisma:L11628`
- `CatalogClientReadinessOverride` → `schema.prisma:L11647`
- `CatalogFamily` → `schema.prisma:L11365`
- `CatalogIdempotencyRecord` → `schema.prisma:L11761`
- `CatalogIdentifier` → `schema.prisma:L11496`
- `CatalogImportBatch` → `schema.prisma:L11804`
- `CatalogImportLine` → `schema.prisma:L11841`
- `CatalogItem` → `schema.prisma:L11398`
- `CatalogItemBusinessType` → `schema.prisma:L11458`
- `CatalogItemPrice` → `schema.prisma:L11546`
- `CatalogManufacturer` → `schema.prisma:L11339`
- `CatalogProductTypeMapping` → `schema.prisma:L11475`
- `CatalogPublicationBatch` → `schema.prisma:L11926`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12020`
- `CatalogPublicationLine` → `schema.prisma:L11967`
- `CatalogPublicationOutbox` → `schema.prisma:L12063`
- `CatalogValidationProfile` → `schema.prisma:L11517`
- `CatalogVenueBinding` → `schema.prisma:L11675`
- `CatalogVenueClientRequirement` → `schema.prisma:L11602`
- `CatalogVenueEventSequence` → `schema.prisma:L12046`
- `CatalogVenueOverride` → `schema.prisma:L11717`
- `CatalogVenueRollout` → `schema.prisma:L11577`
- `Cfdi` → `schema.prisma:L16403`
- `ChatbotTokenBudget` → `schema.prisma:L10094`
- `ChatConversation` → `schema.prisma:L9949`
- `ChatFeedback` → `schema.prisma:L10035`
- `ChatLearningEvent` → `schema.prisma:L9992`
- `ChatMessage` → `schema.prisma:L9972`
- `ChatTrainingData` → `schema.prisma:L9906`
- `CheckoutSession` → `schema.prisma:L6030`
- `ClassSession` → `schema.prisma:L13977`
- `CommissionCalculation` → `schema.prisma:L12744`
- `CommissionClawback` → `schema.prisma:L12920`
- `CommissionConfig` → `schema.prisma:L12510`
- `CommissionMilestone` → `schema.prisma:L12660`
- `CommissionOverride` → `schema.prisma:L12587`
- `CommissionPayout` → `schema.prisma:L12871`
- `CommissionSummary` → `schema.prisma:L12810`
- `CommissionTier` → `schema.prisma:L12624`
- `ConsentEvent` → `schema.prisma:L7388`
- `Consumer` → `schema.prisma:L7618`
- `ConsumerAuthAccount` → `schema.prisma:L7643`
- `CouponCode` → `schema.prisma:L8590`
- `CouponRedemption` → `schema.prisma:L8621`
- `CreditAssessmentHistory` → `schema.prisma:L10940`
- `CreditItemBalance` → `schema.prisma:L14589`
- `CreditOffer` → `schema.prisma:L10959`
- `CreditPack` → `schema.prisma:L14498`
- `CreditPackItem` → `schema.prisma:L14527`
- `CreditPackPurchase` → `schema.prisma:L14544`
- `CreditTransaction` → `schema.prisma:L14611`
- `Customer` → `schema.prisma:L7246`
- `CustomerApprovalDelivery` → `schema.prisma:L9608`
- `CustomerApprovalOutbox` → `schema.prisma:L9583`
- `CustomerCampaign` → `schema.prisma:L7476`
- `CustomerCampaignDelivery` → `schema.prisma:L7558`
- `CustomerCaptureToken` → `schema.prisma:L7424`
- `CustomerDiscount` → `schema.prisma:L8641`
- `CustomerGroup` → `schema.prisma:L7682`
- `CustomerOrderMetric` → `schema.prisma:L4013`
- `CustomerTaxProfile` → `schema.prisma:L16482`
- `DeliveryActivationRequest` → `schema.prisma:L6489`
- `DeliveryChannelLink` → `schema.prisma:L6328`
- `DeliveryConnectIntent` → `schema.prisma:L6440`
- `DeliveryLineAction` → `schema.prisma:L6401`
- `DeliveryOrderEvent` → `schema.prisma:L6513`
- `DeliveryStoreRevocation` → `schema.prisma:L6477`
- `DeviceToken` → `schema.prisma:L8910`
- `DigitalReceipt` → `schema.prisma:L4596`
- `Discount` → `schema.prisma:L8280`
- `EcommerceMerchant` → `schema.prisma:L5842`
- `EmailQuotaLedger` → `schema.prisma:L7605`
- `EmailSuppression` → `schema.prisma:L7593`
- `EmailTemplate` → `schema.prisma:L13263`
- `Employee` → `schema.prisma:L16997`
- `Estimate` → `schema.prisma:L14908`
- `EstimateItem` → `schema.prisma:L14936`
- `Expense` → `schema.prisma:L16784`
- `ExternalBusyBlock` → `schema.prisma:L14266`
- `Feature` → `schema.prisma:L4725`
- `FeeSchedule` → `schema.prisma:L4849`
- `FeeTier` → `schema.prisma:L4860`
- `FinancialAccount` → `schema.prisma:L15098`
- `FinancialConnection` → `schema.prisma:L15067`
- `FinancialProvider` → `schema.prisma:L15053`
- `FiscalEmisor` → `schema.prisma:L16319`
- `FiscalLossCarryforward` → `schema.prisma:L16907`
- `FixedAsset` → `schema.prisma:L16925`
- `FixedAssetDepreciation` → `schema.prisma:L16954`
- `FloorElement` → `schema.prisma:L3298`
- `FulfillmentArea` → `schema.prisma:L15379`
- `GeofenceRule` → `schema.prisma:L10531`
- `GoogleCalendarChannel` → `schema.prisma:L14243`
- `GoogleCalendarConnection` → `schema.prisma:L14195`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14296`
- `GoogleOAuthSession` → `schema.prisma:L14318`
- `HolidayCalendar` → `schema.prisma:L7129`
- `IdempotencyRequest` → `schema.prisma:L12385`
- `InterVenueTransfer` → `schema.prisma:L3050`
- `InterVenueTransferAllocation` → `schema.prisma:L3133`
- `InterVenueTransferItem` → `schema.prisma:L3102`
- `InterVenueTransferReceipt` → `schema.prisma:L3160`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3176`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3204`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3188`
- `Inventory` → `schema.prisma:L1994`
- `InventoryMovement` → `schema.prisma:L2094`
- `InventoryPosting` → `schema.prisma:L2189`
- `InventoryPostingLine` → `schema.prisma:L2229`
- `InventoryTransfer` → `schema.prisma:L14880`
- `InventoryWasteReport` → `schema.prisma:L2049`
- `Invitation` → `schema.prisma:L1494`
- `Invoice` → `schema.prisma:L4872`
- `InvoiceItem` → `schema.prisma:L4898`
- `ItemCategory` → `schema.prisma:L12098`
- `JournalEntry` → `schema.prisma:L16694`
- `JournalLine` → `schema.prisma:L16722`
- `KdsOrder` → `schema.prisma:L15146`
- `KdsOrderItem` → `schema.prisma:L15195`
- `KioskCheckInAttempt` → `schema.prisma:L17655`
- `KioskCheckInChallenge` → `schema.prisma:L17609`
- `KioskOutreachOutbox` → `schema.prisma:L17676`
- `LaunchCampaign` → `schema.prisma:L18014`
- `LaunchCampaignRedemption` → `schema.prisma:L18131`
- `LearnedPatterns` → `schema.prisma:L10016`
- `LedgerAccount` → `schema.prisma:L16586`
- `LiveDemoSession` → `schema.prisma:L830`
- `LowStockAlert` → `schema.prisma:L2884`
- `LoyaltyConfig` → `schema.prisma:L7712`
- `LoyaltyTransaction` → `schema.prisma:L7755`
- `MarketingCampaign` → `schema.prisma:L13281`
- `McpAuthCode` → `schema.prisma:L16202`
- `McpOAuthClient` → `schema.prisma:L16186`
- `McpRefreshToken` → `schema.prisma:L16220`
- `McpToolCall` → `schema.prisma:L16241`
- `MeasurementUnit` → `schema.prisma:L14986`
- `Menu` → `schema.prisma:L1712`
- `MenuCategory` → `schema.prisma:L1649`
- `MenuCategoryAssignment` → `schema.prisma:L1747`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16116`
- `MerchantAccount` → `schema.prisma:L5580`
- `MerchantFiscalConfig` → `schema.prisma:L16374`
- `MerchantRevenueShare` → `schema.prisma:L6709`
- `MerchantRoutingRule` → `schema.prisma:L5702`
- `MilestoneAchievement` → `schema.prisma:L12705`
- `Modifier` → `schema.prisma:L4202`
- `ModifierGroup` → `schema.prisma:L4166`
- `Module` → `schema.prisma:L11007`
- `MoneyAnomaly` → `schema.prisma:L6612`
- `MonthlyVenueProfit` → `schema.prisma:L7155`
- `Notification` → `schema.prisma:L8812`
- `NotificationPreference` → `schema.prisma:L8859`
- `NotificationTemplate` → `schema.prisma:L8886`
- `OAuthState` → `schema.prisma:L1545`
- `OnboardingProgress` → `schema.prisma:L1563`
- `Order` → `schema.prisma:L3747`
- `OrderAction` → `schema.prisma:L4269`
- `OrderCustomer` → `schema.prisma:L3992`
- `OrderDiscount` → `schema.prisma:L8673`
- `OrderFulfillment` → `schema.prisma:L15434`
- `OrderFulfillmentLine` → `schema.prisma:L15465`
- `OrderItem` → `schema.prisma:L4028`
- `OrderItemModifier` → `schema.prisma:L4251`
- `OrderPromotion` → `schema.prisma:L17572`
- `OrderServiceCharge` → `schema.prisma:L8757`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13082`
- `OrganizationEntitlement` → `schema.prisma:L11290`
- `OrganizationGoal` → `schema.prisma:L13040`
- `OrganizationModule` → `schema.prisma:L11067`
- `OrganizationPaymentConfig` → `schema.prisma:L6154`
- `OrganizationPayoutConfig` → `schema.prisma:L13115`
- `OrganizationPricingStructure` → `schema.prisma:L6186`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13063`
- `OtpChallenge` → `schema.prisma:L7662`
- `OvertimeApproval` → `schema.prisma:L3525`
- `PartnerAPIKey` → `schema.prisma:L5984`
- `Payment` → `schema.prisma:L4302`
- `PaymentAllocation` → `schema.prisma:L4575`
- `PaymentEffect` → `schema.prisma:L17946`
- `PaymentLink` → `schema.prisma:L14657`
- `PaymentLinkAttribution` → `schema.prisma:L14765`
- `PaymentLinkItem` → `schema.prisma:L14720`
- `PaymentLinkItemModifier` → `schema.prisma:L14747`
- `PaymentProvider` → `schema.prisma:L5539`
- `PayrollLine` → `schema.prisma:L17068`
- `PayrollRun` → `schema.prisma:L17037`
- `PerformanceGoal` → `schema.prisma:L13017`
- `PermissionOverride` → `schema.prisma:L1418`
- `PermissionSet` → `schema.prisma:L1441`
- `PlatformAnnouncement` → `schema.prisma:L17736`
- `PlatformAnnouncementClick` → `schema.prisma:L17801`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17838`
- `PlatformCfdi` → `schema.prisma:L17365`
- `PlatformEmisor` → `schema.prisma:L17305`
- `PlatformSettings` → `schema.prisma:L5961`
- `PosCommand` → `schema.prisma:L8940`
- `PosConnectionStatus` → `schema.prisma:L964`
- `PosSyncIntent` → `schema.prisma:L17443`
- `PricingPolicy` → `schema.prisma:L2780`
- `Printer` → `schema.prisma:L15244`
- `PrintGateway` → `schema.prisma:L15301`
- `PrintJob` → `schema.prisma:L16015`
- `PrintStation` → `schema.prisma:L15319`
- `PrivacyNoticeVersion` → `schema.prisma:L7410`
- `ProcessedStripeEvent` → `schema.prisma:L6598`
- `ProcessorReliabilityMetric` → `schema.prisma:L7083`
- `Product` → `schema.prisma:L1765`
- `ProductModifierGroup` → `schema.prisma:L4239`
- `ProductOption` → `schema.prisma:L14963`
- `ProductOptionValue` → `schema.prisma:L14974`
- `ProductStaff` → `schema.prisma:L13892`
- `PromoterBankAccount` → `schema.prisma:L17188`
- `PromoterCommissionEntry` → `schema.prisma:L17207`
- `PromoterLocationPing` → `schema.prisma:L3713`
- `Promotion` → `schema.prisma:L17494`
- `PromotionGroup` → `schema.prisma:L17533`
- `PromotionOption` → `schema.prisma:L17549`
- `ProviderCostStructure` → `schema.prisma:L6634`
- `ProviderEventLog` → `schema.prisma:L6263`
- `PurchaseOrder` → `schema.prisma:L2505`
- `PurchaseOrderInvoice` → `schema.prisma:L2650`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2707`
- `PurchaseOrderItem` → `schema.prisma:L2563`
- `RateCorrectionBatch` → `schema.prisma:L6859`
- `RateCorrectionEntry` → `schema.prisma:L6901`
- `RawMaterial` → `schema.prisma:L2261`
- `RawMaterialMovement` → `schema.prisma:L2833`
- `RawMaterialPresentation` → `schema.prisma:L2337`
- `ReceiptLayout` → `schema.prisma:L17980`
- `Recipe` → `schema.prisma:L2357`
- `RecipeLine` → `schema.prisma:L2381`
- `Referral` → `schema.prisma:L8128`
- `ReferralProgramConfig` → `schema.prisma:L8093`
- `ReferralRewardGrant` → `schema.prisma:L8219`
- `ReferralTierReward` → `schema.prisma:L8191`
- `ReferralTierUnlock` → `schema.prisma:L8264`
- `RefreshGrant` → `schema.prisma:L17925`
- `Reservation` → `schema.prisma:L13660`
- `ReservationGoogleEventMapping` → `schema.prisma:L14430`
- `ReservationModifier` → `schema.prisma:L13840`
- `ReservationReminderSent` → `schema.prisma:L13823`
- `ReservationSettings` → `schema.prisma:L14054`
- `ReservationWaitlistEntry` → `schema.prisma:L14022`
- `Review` → `schema.prisma:L4916`
- `SalesRetention` → `schema.prisma:L16888`
- `SaleVerification` → `schema.prisma:L4629`
- `ScaleProfile` → `schema.prisma:L15756`
- `ScheduledCommand` → `schema.prisma:L10491`
- `SerializedItem` → `schema.prisma:L12141`
- `SerializedItemCustodyEvent` → `schema.prisma:L12308`
- `ServiceCharge` → `schema.prisma:L8728`
- `Session` → `schema.prisma:L17904`
- `SettlementConfiguration` → `schema.prisma:L6934`
- `SettlementConfirmation` → `schema.prisma:L7047`
- `SettlementIncident` → `schema.prisma:L6998`
- `SettlementSimulation` → `schema.prisma:L6969`
- `Shift` → `schema.prisma:L3336`
- `SimRegistrationRequest` → `schema.prisma:L12346`
- `SimRegistrationRequestItem` → `schema.prisma:L12368`
- `SlotHold` → `schema.prisma:L13923`
- `Staff` → `schema.prisma:L984`
- `StaffDocument` → `schema.prisma:L3584`
- `StaffOnboardingState` → `schema.prisma:L16086`
- `StaffOrganization` → `schema.prisma:L1317`
- `StaffPasskey` → `schema.prisma:L1344`
- `StaffSchedule` → `schema.prisma:L13863`
- `StaffScheduleException` → `schema.prisma:L13875`
- `StaffVenue` → `schema.prisma:L1241`
- `StaffWorkSchedule` → `schema.prisma:L3461`
- `StaffWorkScheduleException` → `schema.prisma:L3559`
- `StampCard` → `schema.prisma:L7976`
- `StampEvent` → `schema.prisma:L8015`
- `StampReward` → `schema.prisma:L8053`
- `StockAlertConfig` → `schema.prisma:L12999`
- `StockBatch` → `schema.prisma:L2999`
- `StockCount` → `schema.prisma:L2916`
- `StockCountItem` → `schema.prisma:L2944`
- `StripeWebhookEvent` → `schema.prisma:L6581`
- `Supplier` → `schema.prisma:L2416`
- `SupplierItemCode` → `schema.prisma:L2748`
- `SupplierPricing` → `schema.prisma:L2471`
- `Table` → `schema.prisma:L3248`
- `Terminal` → `schema.prisma:L4967`
- `TerminalAttemptResolution` → `schema.prisma:L5398`
- `TerminalHealth` → `schema.prisma:L5218`
- `TerminalLog` → `schema.prisma:L5192`
- `TerminalOrder` → `schema.prisma:L5442`
- `TerminalOrderItem` → `schema.prisma:L5517`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5370`
- `TerminalPaymentRequest` → `schema.prisma:L5289`
- `TimeEntry` → `schema.prisma:L3626`
- `TimeEntryBreak` → `schema.prisma:L3695`
- `TokenPurchase` → `schema.prisma:L10165`
- `TokenUsageRecord` → `schema.prisma:L10137`
- `TpvCommandHistory` → `schema.prisma:L10397`
- `TpvCommandQueue` → `schema.prisma:L10337`
- `TpvFeedback` → `schema.prisma:L10050`
- `TpvMessage` → `schema.prisma:L13356`
- `TpvMessageDelivery` → `schema.prisma:L13408`
- `TpvMessageResponse` → `schema.prisma:L13431`
- `TrainingModule` → `schema.prisma:L13486`
- `TrainingProgress` → `schema.prisma:L13563`
- `TrainingQuizQuestion` → `schema.prisma:L13545`
- `TrainingStep` → `schema.prisma:L13525`
- `TransactionCost` → `schema.prisma:L6797`
- `UnitConversion` → `schema.prisma:L2811`
- `UpsellAcceptance` → `schema.prisma:L8549`
- `UpsellAiRun` → `schema.prisma:L8569`
- `UpsellImpression` → `schema.prisma:L8509`
- `UpsellRule` → `schema.prisma:L8429`
- `user_sessions` → `schema.prisma:L6019`
- `Venue` → `schema.prisma:L167`
- `VenueAreaTicketSettings` → `schema.prisma:L15493`
- `VenueChatMessage` → `schema.prisma:L806`
- `VenueChatSession` → `schema.prisma:L761`
- `VenueCommission` → `schema.prisma:L15124`
- `VenueCreditAssessment` → `schema.prisma:L10879`
- `VenueCryptoConfig` → `schema.prisma:L13223`
- `VenueFeature` → `schema.prisma:L4743`
- `VenueIvaPorProducto` → `schema.prisma:L957`
- `VenueModule` → `schema.prisma:L11039`
- `VenuePaymentConfig` → `schema.prisma:L6120`
- `VenuePaymentLinkSettings` → `schema.prisma:L14463`
- `VenuePricingStructure` → `schema.prisma:L6737`
- `VenueRoleConfig` → `schema.prisma:L1470`
- `VenueRolePermission` → `schema.prisma:L1374`
- `VenueScaleSettings` → `schema.prisma:L15744`
- `VenueSettings` → `schema.prisma:L846`
- `VenueTenderType` → `schema.prisma:L4488`
- `VenueTenderTypeRevision` → `schema.prisma:L4553`
- `VenueTransaction` → `schema.prisma:L4680`
- `VenueWhatsappActivation` → `schema.prisma:L697`
- `WalletCardDesign` → `schema.prisma:L7894`
- `WalletPass` → `schema.prisma:L7795`
- `WalletPassRegistration` → `schema.prisma:L7861`
- `WebhookEvent` → `schema.prisma:L4825`
- `WebhookSubscription` → `schema.prisma:L6236`
- `WhatsappContactWindow` → `schema.prisma:L715`
- `WhatsappInboundEvent` → `schema.prisma:L735`
- `WorkShiftAssignment` → `schema.prisma:L3501`
- `WorkShiftTemplate` → `schema.prisma:L3478`
- `Zone` → `schema.prisma:L150`
