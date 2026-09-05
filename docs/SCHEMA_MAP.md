# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **365 models / 346 enums / ~17,400 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                        |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                            |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                                      |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                           |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                           |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                     |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                        |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L16244`
- `AccountMapping` → `schema.prisma:L16140`
- `ActivityLog` → `schema.prisma:L6747`
- `Aggregator` → `schema.prisma:L14537`
- `AngelPayUserAccount` → `schema.prisma:L5410`
- `AppUpdate` → `schema.prisma:L12702`
- `Area` → `schema.prisma:L3038`
- `AreaTicket` → `schema.prisma:L15035`
- `AreaTicketCheckoutSession` → `schema.prisma:L15157`
- `AreaTicketExternalIncident` → `schema.prisma:L15404`
- `AreaTicketExternalSettlement` → `schema.prisma:L15369`
- `AreaTicketFulfillment` → `schema.prisma:L15233`
- `AreaTicketInventoryReservation` → `schema.prisma:L15128`
- `AreaTicketLine` → `schema.prisma:L15096`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15189`
- `AreaTicketPrintAttempt` → `schema.prisma:L15212`
- `BankStatement` → `schema.prisma:L16014`
- `BankStatementLine` → `schema.prisma:L16035`
- `BillingTaxProfile` → `schema.prisma:L16824`
- `BirthdayAutomation` → `schema.prisma:L7068`
- `BulkCommandOperation` → `schema.prisma:L9982`
- `CalendarSyncOutbox` → `schema.prisma:L13909`
- `CampaignDelivery` → `schema.prisma:L12860`
- `CashCloseout` → `schema.prisma:L10367`
- `CashDeposit` → `schema.prisma:L12504`
- `CashDrawerEvent` → `schema.prisma:L14374`
- `CashDrawerSession` → `schema.prisma:L14335`
- `CashOutCommissionRate` → `schema.prisma:L16653`
- `CashOutScheduleDay` → `schema.prisma:L16676`
- `CashOutWithdrawal` → `schema.prisma:L16738`
- `CatalogBindingBatch` → `schema.prisma:L11398`
- `CatalogBindingLine` → `schema.prisma:L11434`
- `CatalogBrand` → `schema.prisma:L10851`
- `CatalogClientObservation` → `schema.prisma:L11164`
- `CatalogClientReadinessOverride` → `schema.prisma:L11183`
- `CatalogFamily` → `schema.prisma:L10901`
- `CatalogIdempotencyRecord` → `schema.prisma:L11297`
- `CatalogIdentifier` → `schema.prisma:L11032`
- `CatalogImportBatch` → `schema.prisma:L11340`
- `CatalogImportLine` → `schema.prisma:L11377`
- `CatalogItem` → `schema.prisma:L10934`
- `CatalogItemBusinessType` → `schema.prisma:L10994`
- `CatalogItemPrice` → `schema.prisma:L11082`
- `CatalogManufacturer` → `schema.prisma:L10875`
- `CatalogProductTypeMapping` → `schema.prisma:L11011`
- `CatalogPublicationBatch` → `schema.prisma:L11462`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11556`
- `CatalogPublicationLine` → `schema.prisma:L11503`
- `CatalogPublicationOutbox` → `schema.prisma:L11599`
- `CatalogValidationProfile` → `schema.prisma:L11053`
- `CatalogVenueBinding` → `schema.prisma:L11211`
- `CatalogVenueClientRequirement` → `schema.prisma:L11138`
- `CatalogVenueEventSequence` → `schema.prisma:L11582`
- `CatalogVenueOverride` → `schema.prisma:L11253`
- `CatalogVenueRollout` → `schema.prisma:L11113`
- `Cfdi` → `schema.prisma:L15917`
- `ChatbotTokenBudget` → `schema.prisma:L9630`
- `ChatConversation` → `schema.prisma:L9485`
- `ChatFeedback` → `schema.prisma:L9571`
- `ChatLearningEvent` → `schema.prisma:L9528`
- `ChatMessage` → `schema.prisma:L9508`
- `ChatTrainingData` → `schema.prisma:L9442`
- `CheckoutSession` → `schema.prisma:L5690`
- `ClassSession` → `schema.prisma:L13513`
- `CommissionCalculation` → `schema.prisma:L12280`
- `CommissionClawback` → `schema.prisma:L12456`
- `CommissionConfig` → `schema.prisma:L12046`
- `CommissionMilestone` → `schema.prisma:L12196`
- `CommissionOverride` → `schema.prisma:L12123`
- `CommissionPayout` → `schema.prisma:L12407`
- `CommissionSummary` → `schema.prisma:L12346`
- `CommissionTier` → `schema.prisma:L12160`
- `ConsentEvent` → `schema.prisma:L6930`
- `Consumer` → `schema.prisma:L7160`
- `ConsumerAuthAccount` → `schema.prisma:L7185`
- `CouponCode` → `schema.prisma:L8132`
- `CouponRedemption` → `schema.prisma:L8163`
- `CreditAssessmentHistory` → `schema.prisma:L10476`
- `CreditItemBalance` → `schema.prisma:L14125`
- `CreditOffer` → `schema.prisma:L10495`
- `CreditPack` → `schema.prisma:L14034`
- `CreditPackItem` → `schema.prisma:L14063`
- `CreditPackPurchase` → `schema.prisma:L14080`
- `CreditTransaction` → `schema.prisma:L14147`
- `Customer` → `schema.prisma:L6788`
- `CustomerApprovalDelivery` → `schema.prisma:L9144`
- `CustomerApprovalOutbox` → `schema.prisma:L9119`
- `CustomerCampaign` → `schema.prisma:L7018`
- `CustomerCampaignDelivery` → `schema.prisma:L7100`
- `CustomerCaptureToken` → `schema.prisma:L6966`
- `CustomerDiscount` → `schema.prisma:L8183`
- `CustomerGroup` → `schema.prisma:L7224`
- `CustomerOrderMetric` → `schema.prisma:L3808`
- `CustomerTaxProfile` → `schema.prisma:L15986`
- `DeliveryActivationRequest` → `schema.prisma:L6031`
- `DeliveryChannelLink` → `schema.prisma:L5976`
- `DeliveryOrderEvent` → `schema.prisma:L6055`
- `DeviceToken` → `schema.prisma:L8452`
- `DigitalReceipt` → `schema.prisma:L4379`
- `Discount` → `schema.prisma:L7822`
- `EcommerceMerchant` → `schema.prisma:L5502`
- `EmailQuotaLedger` → `schema.prisma:L7147`
- `EmailSuppression` → `schema.prisma:L7135`
- `EmailTemplate` → `schema.prisma:L12799`
- `Employee` → `schema.prisma:L16501`
- `Estimate` → `schema.prisma:L14444`
- `EstimateItem` → `schema.prisma:L14472`
- `Expense` → `schema.prisma:L16288`
- `ExternalBusyBlock` → `schema.prisma:L13802`
- `Feature` → `schema.prisma:L4508`
- `FeeSchedule` → `schema.prisma:L4586`
- `FeeTier` → `schema.prisma:L4597`
- `FinancialAccount` → `schema.prisma:L14634`
- `FinancialConnection` → `schema.prisma:L14603`
- `FinancialProvider` → `schema.prisma:L14589`
- `FiscalEmisor` → `schema.prisma:L15840`
- `FiscalLossCarryforward` → `schema.prisma:L16411`
- `FixedAsset` → `schema.prisma:L16429`
- `FixedAssetDepreciation` → `schema.prisma:L16458`
- `FloorElement` → `schema.prisma:L3114`
- `FulfillmentArea` → `schema.prisma:L14900`
- `GeofenceRule` → `schema.prisma:L10067`
- `GoogleCalendarChannel` → `schema.prisma:L13779`
- `GoogleCalendarConnection` → `schema.prisma:L13731`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13832`
- `GoogleOAuthSession` → `schema.prisma:L13854`
- `HolidayCalendar` → `schema.prisma:L6671`
- `IdempotencyRequest` → `schema.prisma:L11921`
- `InterVenueTransfer` → `schema.prisma:L2866`
- `InterVenueTransferAllocation` → `schema.prisma:L2949`
- `InterVenueTransferItem` → `schema.prisma:L2918`
- `InterVenueTransferReceipt` → `schema.prisma:L2976`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2992`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3020`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3004`
- `Inventory` → `schema.prisma:L1912`
- `InventoryMovement` → `schema.prisma:L1939`
- `InventoryPosting` → `schema.prisma:L2021`
- `InventoryPostingLine` → `schema.prisma:L2061`
- `InventoryTransfer` → `schema.prisma:L14416`
- `Invitation` → `schema.prisma:L1450`
- `Invoice` → `schema.prisma:L4609`
- `InvoiceItem` → `schema.prisma:L4635`
- `ItemCategory` → `schema.prisma:L11634`
- `JournalEntry` → `schema.prisma:L16198`
- `JournalLine` → `schema.prisma:L16226`
- `KdsOrder` → `schema.prisma:L14682`
- `KdsOrderItem` → `schema.prisma:L14723`
- `KioskCheckInAttempt` → `schema.prisma:L17147`
- `KioskCheckInChallenge` → `schema.prisma:L17101`
- `KioskOutreachOutbox` → `schema.prisma:L17168`
- `LearnedPatterns` → `schema.prisma:L9552`
- `LedgerAccount` → `schema.prisma:L16090`
- `LiveDemoSession` → `schema.prisma:L795`
- `LowStockAlert` → `schema.prisma:L2707`
- `LoyaltyConfig` → `schema.prisma:L7254`
- `LoyaltyTransaction` → `schema.prisma:L7297`
- `MarketingCampaign` → `schema.prisma:L12817`
- `McpAuthCode` → `schema.prisma:L15723`
- `McpOAuthClient` → `schema.prisma:L15707`
- `McpRefreshToken` → `schema.prisma:L15741`
- `McpToolCall` → `schema.prisma:L15762`
- `MeasurementUnit` → `schema.prisma:L14522`
- `Menu` → `schema.prisma:L1636`
- `MenuCategory` → `schema.prisma:L1573`
- `MenuCategoryAssignment` → `schema.prisma:L1671`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15637`
- `MerchantAccount` → `schema.prisma:L5240`
- `MerchantFiscalConfig` → `schema.prisma:L15888`
- `MerchantRevenueShare` → `schema.prisma:L6251`
- `MerchantRoutingRule` → `schema.prisma:L5362`
- `MilestoneAchievement` → `schema.prisma:L12241`
- `Modifier` → `schema.prisma:L3992`
- `ModifierGroup` → `schema.prisma:L3956`
- `Module` → `schema.prisma:L10543`
- `MoneyAnomaly` → `schema.prisma:L6154`
- `MonthlyVenueProfit` → `schema.prisma:L6697`
- `Notification` → `schema.prisma:L8354`
- `NotificationPreference` → `schema.prisma:L8401`
- `NotificationTemplate` → `schema.prisma:L8428`
- `OAuthState` → `schema.prisma:L1501`
- `OnboardingProgress` → `schema.prisma:L1519`
- `Order` → `schema.prisma:L3563`
- `OrderAction` → `schema.prisma:L4059`
- `OrderCustomer` → `schema.prisma:L3787`
- `OrderDiscount` → `schema.prisma:L8215`
- `OrderFulfillment` → `schema.prisma:L14955`
- `OrderFulfillmentLine` → `schema.prisma:L14986`
- `OrderItem` → `schema.prisma:L3823`
- `OrderItemModifier` → `schema.prisma:L4041`
- `OrderPromotion` → `schema.prisma:L17064`
- `OrderServiceCharge` → `schema.prisma:L8299`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12618`
- `OrganizationEntitlement` → `schema.prisma:L10826`
- `OrganizationGoal` → `schema.prisma:L12576`
- `OrganizationModule` → `schema.prisma:L10603`
- `OrganizationPaymentConfig` → `schema.prisma:L5814`
- `OrganizationPayoutConfig` → `schema.prisma:L12651`
- `OrganizationPricingStructure` → `schema.prisma:L5846`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12599`
- `OtpChallenge` → `schema.prisma:L7204`
- `OvertimeApproval` → `schema.prisma:L3341`
- `PartnerAPIKey` → `schema.prisma:L5644`
- `Payment` → `schema.prisma:L4092`
- `PaymentAllocation` → `schema.prisma:L4358`
- `PaymentLink` → `schema.prisma:L14193`
- `PaymentLinkAttribution` → `schema.prisma:L14301`
- `PaymentLinkItem` → `schema.prisma:L14256`
- `PaymentLinkItemModifier` → `schema.prisma:L14283`
- `PaymentProvider` → `schema.prisma:L5199`
- `PayrollLine` → `schema.prisma:L16572`
- `PayrollRun` → `schema.prisma:L16541`
- `PerformanceGoal` → `schema.prisma:L12553`
- `PermissionOverride` → `schema.prisma:L1374`
- `PermissionSet` → `schema.prisma:L1397`
- `PlatformAnnouncement` → `schema.prisma:L17228`
- `PlatformAnnouncementClick` → `schema.prisma:L17293`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17330`
- `PlatformCfdi` → `schema.prisma:L16857`
- `PlatformEmisor` → `schema.prisma:L16797`
- `PlatformSettings` → `schema.prisma:L5621`
- `PosCommand` → `schema.prisma:L8482`
- `PosConnectionStatus` → `schema.prisma:L921`
- `PosSyncIntent` → `schema.prisma:L16935`
- `PricingPolicy` → `schema.prisma:L2611`
- `Printer` → `schema.prisma:L14765`
- `PrintGateway` → `schema.prisma:L14822`
- `PrintJob` → `schema.prisma:L15536`
- `PrintStation` → `schema.prisma:L14840`
- `PrivacyNoticeVersion` → `schema.prisma:L6952`
- `ProcessedStripeEvent` → `schema.prisma:L6140`
- `ProcessorReliabilityMetric` → `schema.prisma:L6625`
- `Product` → `schema.prisma:L1689`
- `ProductModifierGroup` → `schema.prisma:L4029`
- `ProductOption` → `schema.prisma:L14499`
- `ProductOptionValue` → `schema.prisma:L14510`
- `ProductStaff` → `schema.prisma:L13428`
- `PromoterBankAccount` → `schema.prisma:L16692`
- `PromoterCommissionEntry` → `schema.prisma:L16711`
- `PromoterLocationPing` → `schema.prisma:L3529`
- `Promotion` → `schema.prisma:L16986`
- `PromotionGroup` → `schema.prisma:L17025`
- `PromotionOption` → `schema.prisma:L17041`
- `ProviderCostStructure` → `schema.prisma:L6176`
- `ProviderEventLog` → `schema.prisma:L5923`
- `PurchaseOrder` → `schema.prisma:L2336`
- `PurchaseOrderInvoice` → `schema.prisma:L2481`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2538`
- `PurchaseOrderItem` → `schema.prisma:L2394`
- `RateCorrectionBatch` → `schema.prisma:L6401`
- `RateCorrectionEntry` → `schema.prisma:L6443`
- `RawMaterial` → `schema.prisma:L2093`
- `RawMaterialMovement` → `schema.prisma:L2664`
- `RawMaterialPresentation` → `schema.prisma:L2168`
- `Recipe` → `schema.prisma:L2188`
- `RecipeLine` → `schema.prisma:L2212`
- `Referral` → `schema.prisma:L7670`
- `ReferralProgramConfig` → `schema.prisma:L7635`
- `ReferralRewardGrant` → `schema.prisma:L7761`
- `ReferralTierReward` → `schema.prisma:L7733`
- `ReferralTierUnlock` → `schema.prisma:L7806`
- `RefreshGrant` → `schema.prisma:L17417`
- `Reservation` → `schema.prisma:L13196`
- `ReservationGoogleEventMapping` → `schema.prisma:L13966`
- `ReservationModifier` → `schema.prisma:L13376`
- `ReservationReminderSent` → `schema.prisma:L13359`
- `ReservationSettings` → `schema.prisma:L13590`
- `ReservationWaitlistEntry` → `schema.prisma:L13558`
- `Review` → `schema.prisma:L4653`
- `SalesRetention` → `schema.prisma:L16392`
- `SaleVerification` → `schema.prisma:L4412`
- `ScaleProfile` → `schema.prisma:L15277`
- `ScheduledCommand` → `schema.prisma:L10027`
- `SerializedItem` → `schema.prisma:L11677`
- `SerializedItemCustodyEvent` → `schema.prisma:L11844`
- `ServiceCharge` → `schema.prisma:L8270`
- `Session` → `schema.prisma:L17396`
- `SettlementConfiguration` → `schema.prisma:L6476`
- `SettlementConfirmation` → `schema.prisma:L6589`
- `SettlementIncident` → `schema.prisma:L6540`
- `SettlementSimulation` → `schema.prisma:L6511`
- `Shift` → `schema.prisma:L3152`
- `SimRegistrationRequest` → `schema.prisma:L11882`
- `SimRegistrationRequestItem` → `schema.prisma:L11904`
- `SlotHold` → `schema.prisma:L13459`
- `Staff` → `schema.prisma:L941`
- `StaffDocument` → `schema.prisma:L3400`
- `StaffOnboardingState` → `schema.prisma:L15607`
- `StaffOrganization` → `schema.prisma:L1273`
- `StaffPasskey` → `schema.prisma:L1300`
- `StaffSchedule` → `schema.prisma:L13399`
- `StaffScheduleException` → `schema.prisma:L13411`
- `StaffVenue` → `schema.prisma:L1197`
- `StaffWorkSchedule` → `schema.prisma:L3277`
- `StaffWorkScheduleException` → `schema.prisma:L3375`
- `StampCard` → `schema.prisma:L7518`
- `StampEvent` → `schema.prisma:L7557`
- `StampReward` → `schema.prisma:L7595`
- `StockAlertConfig` → `schema.prisma:L12535`
- `StockBatch` → `schema.prisma:L2815`
- `StockCount` → `schema.prisma:L2739`
- `StockCountItem` → `schema.prisma:L2763`
- `StripeWebhookEvent` → `schema.prisma:L6123`
- `Supplier` → `schema.prisma:L2247`
- `SupplierItemCode` → `schema.prisma:L2579`
- `SupplierPricing` → `schema.prisma:L2302`
- `Table` → `schema.prisma:L3064`
- `Terminal` → `schema.prisma:L4704`
- `TerminalHealth` → `schema.prisma:L4955`
- `TerminalLog` → `schema.prisma:L4929`
- `TerminalOrder` → `schema.prisma:L5102`
- `TerminalOrderItem` → `schema.prisma:L5177`
- `TerminalPaymentRequest` → `schema.prisma:L5026`
- `TimeEntry` → `schema.prisma:L3442`
- `TimeEntryBreak` → `schema.prisma:L3511`
- `TokenPurchase` → `schema.prisma:L9701`
- `TokenUsageRecord` → `schema.prisma:L9673`
- `TpvCommandHistory` → `schema.prisma:L9933`
- `TpvCommandQueue` → `schema.prisma:L9873`
- `TpvFeedback` → `schema.prisma:L9586`
- `TpvMessage` → `schema.prisma:L12892`
- `TpvMessageDelivery` → `schema.prisma:L12944`
- `TpvMessageResponse` → `schema.prisma:L12967`
- `TrainingModule` → `schema.prisma:L13022`
- `TrainingProgress` → `schema.prisma:L13099`
- `TrainingQuizQuestion` → `schema.prisma:L13081`
- `TrainingStep` → `schema.prisma:L13061`
- `TransactionCost` → `schema.prisma:L6339`
- `UnitConversion` → `schema.prisma:L2642`
- `UpsellAcceptance` → `schema.prisma:L8091`
- `UpsellAiRun` → `schema.prisma:L8111`
- `UpsellImpression` → `schema.prisma:L8051`
- `UpsellRule` → `schema.prisma:L7971`
- `user_sessions` → `schema.prisma:L5679`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L15014`
- `VenueChatMessage` → `schema.prisma:L771`
- `VenueChatSession` → `schema.prisma:L726`
- `VenueCommission` → `schema.prisma:L14660`
- `VenueCreditAssessment` → `schema.prisma:L10415`
- `VenueCryptoConfig` → `schema.prisma:L12759`
- `VenueFeature` → `schema.prisma:L4526`
- `VenueModule` → `schema.prisma:L10575`
- `VenuePaymentConfig` → `schema.prisma:L5780`
- `VenuePaymentLinkSettings` → `schema.prisma:L13999`
- `VenuePricingStructure` → `schema.prisma:L6279`
- `VenueRoleConfig` → `schema.prisma:L1426`
- `VenueRolePermission` → `schema.prisma:L1330`
- `VenueScaleSettings` → `schema.prisma:L15265`
- `VenueSettings` → `schema.prisma:L811`
- `VenueTenderType` → `schema.prisma:L4271`
- `VenueTenderTypeRevision` → `schema.prisma:L4336`
- `VenueTransaction` → `schema.prisma:L4463`
- `VenueWhatsappActivation` → `schema.prisma:L662`
- `WalletCardDesign` → `schema.prisma:L7436`
- `WalletPass` → `schema.prisma:L7337`
- `WalletPassRegistration` → `schema.prisma:L7403`
- `WebhookEvent` → `schema.prisma:L4562`
- `WebhookSubscription` → `schema.prisma:L5896`
- `WhatsappContactWindow` → `schema.prisma:L680`
- `WhatsappInboundEvent` → `schema.prisma:L700`
- `WorkShiftAssignment` → `schema.prisma:L3317`
- `WorkShiftTemplate` → `schema.prisma:L3294`
- `Zone` → `schema.prisma:L142`
