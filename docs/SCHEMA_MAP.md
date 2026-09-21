# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **370 models / 352 enums / ~17,700 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                         |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                             |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                                                       |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                            |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                      |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                                         |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                                 |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                      |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L16375`
- `AccountMapping` → `schema.prisma:L16271`
- `ActivityLog` → `schema.prisma:L6878`
- `Aggregator` → `schema.prisma:L14668`
- `AngelPayUserAccount` → `schema.prisma:L5529`
- `AppUpdate` → `schema.prisma:L12833`
- `Area` → `schema.prisma:L3104`
- `AreaTicket` → `schema.prisma:L15166`
- `AreaTicketCheckoutSession` → `schema.prisma:L15288`
- `AreaTicketExternalIncident` → `schema.prisma:L15535`
- `AreaTicketExternalSettlement` → `schema.prisma:L15500`
- `AreaTicketFulfillment` → `schema.prisma:L15364`
- `AreaTicketInventoryReservation` → `schema.prisma:L15259`
- `AreaTicketLine` → `schema.prisma:L15227`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15320`
- `AreaTicketPrintAttempt` → `schema.prisma:L15343`
- `BankStatement` → `schema.prisma:L16145`
- `BankStatementLine` → `schema.prisma:L16166`
- `BillingTaxProfile` → `schema.prisma:L16955`
- `BirthdayAutomation` → `schema.prisma:L7199`
- `BulkCommandOperation` → `schema.prisma:L10113`
- `CalendarSyncOutbox` → `schema.prisma:L14040`
- `CampaignDelivery` → `schema.prisma:L12991`
- `CashCloseout` → `schema.prisma:L10498`
- `CashDeposit` → `schema.prisma:L12635`
- `CashDrawerEvent` → `schema.prisma:L14505`
- `CashDrawerSession` → `schema.prisma:L14466`
- `CashOutCommissionRate` → `schema.prisma:L16784`
- `CashOutScheduleDay` → `schema.prisma:L16807`
- `CashOutWithdrawal` → `schema.prisma:L16869`
- `CatalogBindingBatch` → `schema.prisma:L11529`
- `CatalogBindingLine` → `schema.prisma:L11565`
- `CatalogBrand` → `schema.prisma:L10982`
- `CatalogClientObservation` → `schema.prisma:L11295`
- `CatalogClientReadinessOverride` → `schema.prisma:L11314`
- `CatalogFamily` → `schema.prisma:L11032`
- `CatalogIdempotencyRecord` → `schema.prisma:L11428`
- `CatalogIdentifier` → `schema.prisma:L11163`
- `CatalogImportBatch` → `schema.prisma:L11471`
- `CatalogImportLine` → `schema.prisma:L11508`
- `CatalogItem` → `schema.prisma:L11065`
- `CatalogItemBusinessType` → `schema.prisma:L11125`
- `CatalogItemPrice` → `schema.prisma:L11213`
- `CatalogManufacturer` → `schema.prisma:L11006`
- `CatalogProductTypeMapping` → `schema.prisma:L11142`
- `CatalogPublicationBatch` → `schema.prisma:L11593`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11687`
- `CatalogPublicationLine` → `schema.prisma:L11634`
- `CatalogPublicationOutbox` → `schema.prisma:L11730`
- `CatalogValidationProfile` → `schema.prisma:L11184`
- `CatalogVenueBinding` → `schema.prisma:L11342`
- `CatalogVenueClientRequirement` → `schema.prisma:L11269`
- `CatalogVenueEventSequence` → `schema.prisma:L11713`
- `CatalogVenueOverride` → `schema.prisma:L11384`
- `CatalogVenueRollout` → `schema.prisma:L11244`
- `Cfdi` → `schema.prisma:L16048`
- `ChatbotTokenBudget` → `schema.prisma:L9761`
- `ChatConversation` → `schema.prisma:L9616`
- `ChatFeedback` → `schema.prisma:L9702`
- `ChatLearningEvent` → `schema.prisma:L9659`
- `ChatMessage` → `schema.prisma:L9639`
- `ChatTrainingData` → `schema.prisma:L9573`
- `CheckoutSession` → `schema.prisma:L5809`
- `ClassSession` → `schema.prisma:L13644`
- `CommissionCalculation` → `schema.prisma:L12411`
- `CommissionClawback` → `schema.prisma:L12587`
- `CommissionConfig` → `schema.prisma:L12177`
- `CommissionMilestone` → `schema.prisma:L12327`
- `CommissionOverride` → `schema.prisma:L12254`
- `CommissionPayout` → `schema.prisma:L12538`
- `CommissionSummary` → `schema.prisma:L12477`
- `CommissionTier` → `schema.prisma:L12291`
- `ConsentEvent` → `schema.prisma:L7061`
- `Consumer` → `schema.prisma:L7291`
- `ConsumerAuthAccount` → `schema.prisma:L7316`
- `CouponCode` → `schema.prisma:L8263`
- `CouponRedemption` → `schema.prisma:L8294`
- `CreditAssessmentHistory` → `schema.prisma:L10607`
- `CreditItemBalance` → `schema.prisma:L14256`
- `CreditOffer` → `schema.prisma:L10626`
- `CreditPack` → `schema.prisma:L14165`
- `CreditPackItem` → `schema.prisma:L14194`
- `CreditPackPurchase` → `schema.prisma:L14211`
- `CreditTransaction` → `schema.prisma:L14278`
- `Customer` → `schema.prisma:L6919`
- `CustomerApprovalDelivery` → `schema.prisma:L9275`
- `CustomerApprovalOutbox` → `schema.prisma:L9250`
- `CustomerCampaign` → `schema.prisma:L7149`
- `CustomerCampaignDelivery` → `schema.prisma:L7231`
- `CustomerCaptureToken` → `schema.prisma:L7097`
- `CustomerDiscount` → `schema.prisma:L8314`
- `CustomerGroup` → `schema.prisma:L7355`
- `CustomerOrderMetric` → `schema.prisma:L3875`
- `CustomerTaxProfile` → `schema.prisma:L16117`
- `DeliveryActivationRequest` → `schema.prisma:L6162`
- `DeliveryChannelLink` → `schema.prisma:L6107`
- `DeliveryOrderEvent` → `schema.prisma:L6186`
- `DeviceToken` → `schema.prisma:L8583`
- `DigitalReceipt` → `schema.prisma:L4453`
- `Discount` → `schema.prisma:L7953`
- `EcommerceMerchant` → `schema.prisma:L5621`
- `EmailQuotaLedger` → `schema.prisma:L7278`
- `EmailSuppression` → `schema.prisma:L7266`
- `EmailTemplate` → `schema.prisma:L12930`
- `Employee` → `schema.prisma:L16632`
- `Estimate` → `schema.prisma:L14575`
- `EstimateItem` → `schema.prisma:L14603`
- `Expense` → `schema.prisma:L16419`
- `ExternalBusyBlock` → `schema.prisma:L13933`
- `Feature` → `schema.prisma:L4582`
- `FeeSchedule` → `schema.prisma:L4667`
- `FeeTier` → `schema.prisma:L4678`
- `FinancialAccount` → `schema.prisma:L14765`
- `FinancialConnection` → `schema.prisma:L14734`
- `FinancialProvider` → `schema.prisma:L14720`
- `FiscalEmisor` → `schema.prisma:L15971`
- `FiscalLossCarryforward` → `schema.prisma:L16542`
- `FixedAsset` → `schema.prisma:L16560`
- `FixedAssetDepreciation` → `schema.prisma:L16589`
- `FloorElement` → `schema.prisma:L3180`
- `FulfillmentArea` → `schema.prisma:L15031`
- `GeofenceRule` → `schema.prisma:L10198`
- `GoogleCalendarChannel` → `schema.prisma:L13910`
- `GoogleCalendarConnection` → `schema.prisma:L13862`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13963`
- `GoogleOAuthSession` → `schema.prisma:L13985`
- `HolidayCalendar` → `schema.prisma:L6802`
- `IdempotencyRequest` → `schema.prisma:L12052`
- `InterVenueTransfer` → `schema.prisma:L2932`
- `InterVenueTransferAllocation` → `schema.prisma:L3015`
- `InterVenueTransferItem` → `schema.prisma:L2984`
- `InterVenueTransferReceipt` → `schema.prisma:L3042`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3058`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3086`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3070`
- `Inventory` → `schema.prisma:L1971`
- `InventoryMovement` → `schema.prisma:L1998`
- `InventoryPosting` → `schema.prisma:L2080`
- `InventoryPostingLine` → `schema.prisma:L2120`
- `InventoryTransfer` → `schema.prisma:L14547`
- `Invitation` → `schema.prisma:L1477`
- `Invoice` → `schema.prisma:L4690`
- `InvoiceItem` → `schema.prisma:L4716`
- `ItemCategory` → `schema.prisma:L11765`
- `JournalEntry` → `schema.prisma:L16329`
- `JournalLine` → `schema.prisma:L16357`
- `KdsOrder` → `schema.prisma:L14813`
- `KdsOrderItem` → `schema.prisma:L14854`
- `KioskCheckInAttempt` → `schema.prisma:L17278`
- `KioskCheckInChallenge` → `schema.prisma:L17232`
- `KioskOutreachOutbox` → `schema.prisma:L17299`
- `LaunchCampaign` → `schema.prisma:L17637`
- `LaunchCampaignRedemption` → `schema.prisma:L17743`
- `LearnedPatterns` → `schema.prisma:L9683`
- `LedgerAccount` → `schema.prisma:L16221`
- `LiveDemoSession` → `schema.prisma:L822`
- `LowStockAlert` → `schema.prisma:L2766`
- `LoyaltyConfig` → `schema.prisma:L7385`
- `LoyaltyTransaction` → `schema.prisma:L7428`
- `MarketingCampaign` → `schema.prisma:L12948`
- `McpAuthCode` → `schema.prisma:L15854`
- `McpOAuthClient` → `schema.prisma:L15838`
- `McpRefreshToken` → `schema.prisma:L15872`
- `McpToolCall` → `schema.prisma:L15893`
- `MeasurementUnit` → `schema.prisma:L14653`
- `Menu` → `schema.prisma:L1695`
- `MenuCategory` → `schema.prisma:L1632`
- `MenuCategoryAssignment` → `schema.prisma:L1730`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15768`
- `MerchantAccount` → `schema.prisma:L5359`
- `MerchantFiscalConfig` → `schema.prisma:L16019`
- `MerchantRevenueShare` → `schema.prisma:L6382`
- `MerchantRoutingRule` → `schema.prisma:L5481`
- `MilestoneAchievement` → `schema.prisma:L12372`
- `Modifier` → `schema.prisma:L4059`
- `ModifierGroup` → `schema.prisma:L4023`
- `Module` → `schema.prisma:L10674`
- `MoneyAnomaly` → `schema.prisma:L6285`
- `MonthlyVenueProfit` → `schema.prisma:L6828`
- `Notification` → `schema.prisma:L8485`
- `NotificationPreference` → `schema.prisma:L8532`
- `NotificationTemplate` → `schema.prisma:L8559`
- `OAuthState` → `schema.prisma:L1528`
- `OnboardingProgress` → `schema.prisma:L1546`
- `Order` → `schema.prisma:L3629`
- `OrderAction` → `schema.prisma:L4126`
- `OrderCustomer` → `schema.prisma:L3854`
- `OrderDiscount` → `schema.prisma:L8346`
- `OrderFulfillment` → `schema.prisma:L15086`
- `OrderFulfillmentLine` → `schema.prisma:L15117`
- `OrderItem` → `schema.prisma:L3890`
- `OrderItemModifier` → `schema.prisma:L4108`
- `OrderPromotion` → `schema.prisma:L17195`
- `OrderServiceCharge` → `schema.prisma:L8430`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12749`
- `OrganizationEntitlement` → `schema.prisma:L10957`
- `OrganizationGoal` → `schema.prisma:L12707`
- `OrganizationModule` → `schema.prisma:L10734`
- `OrganizationPaymentConfig` → `schema.prisma:L5933`
- `OrganizationPayoutConfig` → `schema.prisma:L12782`
- `OrganizationPricingStructure` → `schema.prisma:L5965`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12730`
- `OtpChallenge` → `schema.prisma:L7335`
- `OvertimeApproval` → `schema.prisma:L3407`
- `PartnerAPIKey` → `schema.prisma:L5763`
- `Payment` → `schema.prisma:L4159`
- `PaymentAllocation` → `schema.prisma:L4432`
- `PaymentEffect` → `schema.prisma:L17569`
- `PaymentLink` → `schema.prisma:L14324`
- `PaymentLinkAttribution` → `schema.prisma:L14432`
- `PaymentLinkItem` → `schema.prisma:L14387`
- `PaymentLinkItemModifier` → `schema.prisma:L14414`
- `PaymentProvider` → `schema.prisma:L5318`
- `PayrollLine` → `schema.prisma:L16703`
- `PayrollRun` → `schema.prisma:L16672`
- `PerformanceGoal` → `schema.prisma:L12684`
- `PermissionOverride` → `schema.prisma:L1401`
- `PermissionSet` → `schema.prisma:L1424`
- `PlatformAnnouncement` → `schema.prisma:L17359`
- `PlatformAnnouncementClick` → `schema.prisma:L17424`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17461`
- `PlatformCfdi` → `schema.prisma:L16988`
- `PlatformEmisor` → `schema.prisma:L16928`
- `PlatformSettings` → `schema.prisma:L5740`
- `PosCommand` → `schema.prisma:L8613`
- `PosConnectionStatus` → `schema.prisma:L948`
- `PosSyncIntent` → `schema.prisma:L17066`
- `PricingPolicy` → `schema.prisma:L2670`
- `Printer` → `schema.prisma:L14896`
- `PrintGateway` → `schema.prisma:L14953`
- `PrintJob` → `schema.prisma:L15667`
- `PrintStation` → `schema.prisma:L14971`
- `PrivacyNoticeVersion` → `schema.prisma:L7083`
- `ProcessedStripeEvent` → `schema.prisma:L6271`
- `ProcessorReliabilityMetric` → `schema.prisma:L6756`
- `Product` → `schema.prisma:L1748`
- `ProductModifierGroup` → `schema.prisma:L4096`
- `ProductOption` → `schema.prisma:L14630`
- `ProductOptionValue` → `schema.prisma:L14641`
- `ProductStaff` → `schema.prisma:L13559`
- `PromoterBankAccount` → `schema.prisma:L16823`
- `PromoterCommissionEntry` → `schema.prisma:L16842`
- `PromoterLocationPing` → `schema.prisma:L3595`
- `Promotion` → `schema.prisma:L17117`
- `PromotionGroup` → `schema.prisma:L17156`
- `PromotionOption` → `schema.prisma:L17172`
- `ProviderCostStructure` → `schema.prisma:L6307`
- `ProviderEventLog` → `schema.prisma:L6042`
- `PurchaseOrder` → `schema.prisma:L2395`
- `PurchaseOrderInvoice` → `schema.prisma:L2540`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2597`
- `PurchaseOrderItem` → `schema.prisma:L2453`
- `RateCorrectionBatch` → `schema.prisma:L6532`
- `RateCorrectionEntry` → `schema.prisma:L6574`
- `RawMaterial` → `schema.prisma:L2152`
- `RawMaterialMovement` → `schema.prisma:L2723`
- `RawMaterialPresentation` → `schema.prisma:L2227`
- `ReceiptLayout` → `schema.prisma:L17603`
- `Recipe` → `schema.prisma:L2247`
- `RecipeLine` → `schema.prisma:L2271`
- `Referral` → `schema.prisma:L7801`
- `ReferralProgramConfig` → `schema.prisma:L7766`
- `ReferralRewardGrant` → `schema.prisma:L7892`
- `ReferralTierReward` → `schema.prisma:L7864`
- `ReferralTierUnlock` → `schema.prisma:L7937`
- `RefreshGrant` → `schema.prisma:L17548`
- `Reservation` → `schema.prisma:L13327`
- `ReservationGoogleEventMapping` → `schema.prisma:L14097`
- `ReservationModifier` → `schema.prisma:L13507`
- `ReservationReminderSent` → `schema.prisma:L13490`
- `ReservationSettings` → `schema.prisma:L13721`
- `ReservationWaitlistEntry` → `schema.prisma:L13689`
- `Review` → `schema.prisma:L4734`
- `SalesRetention` → `schema.prisma:L16523`
- `SaleVerification` → `schema.prisma:L4486`
- `ScaleProfile` → `schema.prisma:L15408`
- `ScheduledCommand` → `schema.prisma:L10158`
- `SerializedItem` → `schema.prisma:L11808`
- `SerializedItemCustodyEvent` → `schema.prisma:L11975`
- `ServiceCharge` → `schema.prisma:L8401`
- `Session` → `schema.prisma:L17527`
- `SettlementConfiguration` → `schema.prisma:L6607`
- `SettlementConfirmation` → `schema.prisma:L6720`
- `SettlementIncident` → `schema.prisma:L6671`
- `SettlementSimulation` → `schema.prisma:L6642`
- `Shift` → `schema.prisma:L3218`
- `SimRegistrationRequest` → `schema.prisma:L12013`
- `SimRegistrationRequestItem` → `schema.prisma:L12035`
- `SlotHold` → `schema.prisma:L13590`
- `Staff` → `schema.prisma:L968`
- `StaffDocument` → `schema.prisma:L3466`
- `StaffOnboardingState` → `schema.prisma:L15738`
- `StaffOrganization` → `schema.prisma:L1300`
- `StaffPasskey` → `schema.prisma:L1327`
- `StaffSchedule` → `schema.prisma:L13530`
- `StaffScheduleException` → `schema.prisma:L13542`
- `StaffVenue` → `schema.prisma:L1224`
- `StaffWorkSchedule` → `schema.prisma:L3343`
- `StaffWorkScheduleException` → `schema.prisma:L3441`
- `StampCard` → `schema.prisma:L7649`
- `StampEvent` → `schema.prisma:L7688`
- `StampReward` → `schema.prisma:L7726`
- `StockAlertConfig` → `schema.prisma:L12666`
- `StockBatch` → `schema.prisma:L2881`
- `StockCount` → `schema.prisma:L2798`
- `StockCountItem` → `schema.prisma:L2826`
- `StripeWebhookEvent` → `schema.prisma:L6254`
- `Supplier` → `schema.prisma:L2306`
- `SupplierItemCode` → `schema.prisma:L2638`
- `SupplierPricing` → `schema.prisma:L2361`
- `Table` → `schema.prisma:L3130`
- `Terminal` → `schema.prisma:L4785`
- `TerminalHealth` → `schema.prisma:L5036`
- `TerminalLog` → `schema.prisma:L5010`
- `TerminalOrder` → `schema.prisma:L5221`
- `TerminalOrderItem` → `schema.prisma:L5296`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5174`
- `TerminalPaymentRequest` → `schema.prisma:L5107`
- `TimeEntry` → `schema.prisma:L3508`
- `TimeEntryBreak` → `schema.prisma:L3577`
- `TokenPurchase` → `schema.prisma:L9832`
- `TokenUsageRecord` → `schema.prisma:L9804`
- `TpvCommandHistory` → `schema.prisma:L10064`
- `TpvCommandQueue` → `schema.prisma:L10004`
- `TpvFeedback` → `schema.prisma:L9717`
- `TpvMessage` → `schema.prisma:L13023`
- `TpvMessageDelivery` → `schema.prisma:L13075`
- `TpvMessageResponse` → `schema.prisma:L13098`
- `TrainingModule` → `schema.prisma:L13153`
- `TrainingProgress` → `schema.prisma:L13230`
- `TrainingQuizQuestion` → `schema.prisma:L13212`
- `TrainingStep` → `schema.prisma:L13192`
- `TransactionCost` → `schema.prisma:L6470`
- `UnitConversion` → `schema.prisma:L2701`
- `UpsellAcceptance` → `schema.prisma:L8222`
- `UpsellAiRun` → `schema.prisma:L8242`
- `UpsellImpression` → `schema.prisma:L8182`
- `UpsellRule` → `schema.prisma:L8102`
- `user_sessions` → `schema.prisma:L5798`
- `Venue` → `schema.prisma:L163`
- `VenueAreaTicketSettings` → `schema.prisma:L15145`
- `VenueChatMessage` → `schema.prisma:L798`
- `VenueChatSession` → `schema.prisma:L753`
- `VenueCommission` → `schema.prisma:L14791`
- `VenueCreditAssessment` → `schema.prisma:L10546`
- `VenueCryptoConfig` → `schema.prisma:L12890`
- `VenueFeature` → `schema.prisma:L4600`
- `VenueModule` → `schema.prisma:L10706`
- `VenuePaymentConfig` → `schema.prisma:L5899`
- `VenuePaymentLinkSettings` → `schema.prisma:L14130`
- `VenuePricingStructure` → `schema.prisma:L6410`
- `VenueRoleConfig` → `schema.prisma:L1453`
- `VenueRolePermission` → `schema.prisma:L1357`
- `VenueScaleSettings` → `schema.prisma:L15396`
- `VenueSettings` → `schema.prisma:L838`
- `VenueTenderType` → `schema.prisma:L4345`
- `VenueTenderTypeRevision` → `schema.prisma:L4410`
- `VenueTransaction` → `schema.prisma:L4537`
- `VenueWhatsappActivation` → `schema.prisma:L689`
- `WalletCardDesign` → `schema.prisma:L7567`
- `WalletPass` → `schema.prisma:L7468`
- `WalletPassRegistration` → `schema.prisma:L7534`
- `WebhookEvent` → `schema.prisma:L4643`
- `WebhookSubscription` → `schema.prisma:L6015`
- `WhatsappContactWindow` → `schema.prisma:L707`
- `WhatsappInboundEvent` → `schema.prisma:L727`
- `WorkShiftAssignment` → `schema.prisma:L3383`
- `WorkShiftTemplate` → `schema.prisma:L3360`
- `Zone` → `schema.prisma:L146`
