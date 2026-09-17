# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **368 models / 346 enums / ~17,500 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
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

- `AccountingPeriodLock` → `schema.prisma:L16323`
- `AccountMapping` → `schema.prisma:L16219`
- `ActivityLog` → `schema.prisma:L6826`
- `Aggregator` → `schema.prisma:L14616`
- `AngelPayUserAccount` → `schema.prisma:L5477`
- `AppUpdate` → `schema.prisma:L12781`
- `Area` → `schema.prisma:L3064`
- `AreaTicket` → `schema.prisma:L15114`
- `AreaTicketCheckoutSession` → `schema.prisma:L15236`
- `AreaTicketExternalIncident` → `schema.prisma:L15483`
- `AreaTicketExternalSettlement` → `schema.prisma:L15448`
- `AreaTicketFulfillment` → `schema.prisma:L15312`
- `AreaTicketInventoryReservation` → `schema.prisma:L15207`
- `AreaTicketLine` → `schema.prisma:L15175`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15268`
- `AreaTicketPrintAttempt` → `schema.prisma:L15291`
- `BankStatement` → `schema.prisma:L16093`
- `BankStatementLine` → `schema.prisma:L16114`
- `BillingTaxProfile` → `schema.prisma:L16903`
- `BirthdayAutomation` → `schema.prisma:L7147`
- `BulkCommandOperation` → `schema.prisma:L10061`
- `CalendarSyncOutbox` → `schema.prisma:L13988`
- `CampaignDelivery` → `schema.prisma:L12939`
- `CashCloseout` → `schema.prisma:L10446`
- `CashDeposit` → `schema.prisma:L12583`
- `CashDrawerEvent` → `schema.prisma:L14453`
- `CashDrawerSession` → `schema.prisma:L14414`
- `CashOutCommissionRate` → `schema.prisma:L16732`
- `CashOutScheduleDay` → `schema.prisma:L16755`
- `CashOutWithdrawal` → `schema.prisma:L16817`
- `CatalogBindingBatch` → `schema.prisma:L11477`
- `CatalogBindingLine` → `schema.prisma:L11513`
- `CatalogBrand` → `schema.prisma:L10930`
- `CatalogClientObservation` → `schema.prisma:L11243`
- `CatalogClientReadinessOverride` → `schema.prisma:L11262`
- `CatalogFamily` → `schema.prisma:L10980`
- `CatalogIdempotencyRecord` → `schema.prisma:L11376`
- `CatalogIdentifier` → `schema.prisma:L11111`
- `CatalogImportBatch` → `schema.prisma:L11419`
- `CatalogImportLine` → `schema.prisma:L11456`
- `CatalogItem` → `schema.prisma:L11013`
- `CatalogItemBusinessType` → `schema.prisma:L11073`
- `CatalogItemPrice` → `schema.prisma:L11161`
- `CatalogManufacturer` → `schema.prisma:L10954`
- `CatalogProductTypeMapping` → `schema.prisma:L11090`
- `CatalogPublicationBatch` → `schema.prisma:L11541`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11635`
- `CatalogPublicationLine` → `schema.prisma:L11582`
- `CatalogPublicationOutbox` → `schema.prisma:L11678`
- `CatalogValidationProfile` → `schema.prisma:L11132`
- `CatalogVenueBinding` → `schema.prisma:L11290`
- `CatalogVenueClientRequirement` → `schema.prisma:L11217`
- `CatalogVenueEventSequence` → `schema.prisma:L11661`
- `CatalogVenueOverride` → `schema.prisma:L11332`
- `CatalogVenueRollout` → `schema.prisma:L11192`
- `Cfdi` → `schema.prisma:L15996`
- `ChatbotTokenBudget` → `schema.prisma:L9709`
- `ChatConversation` → `schema.prisma:L9564`
- `ChatFeedback` → `schema.prisma:L9650`
- `ChatLearningEvent` → `schema.prisma:L9607`
- `ChatMessage` → `schema.prisma:L9587`
- `ChatTrainingData` → `schema.prisma:L9521`
- `CheckoutSession` → `schema.prisma:L5757`
- `ClassSession` → `schema.prisma:L13592`
- `CommissionCalculation` → `schema.prisma:L12359`
- `CommissionClawback` → `schema.prisma:L12535`
- `CommissionConfig` → `schema.prisma:L12125`
- `CommissionMilestone` → `schema.prisma:L12275`
- `CommissionOverride` → `schema.prisma:L12202`
- `CommissionPayout` → `schema.prisma:L12486`
- `CommissionSummary` → `schema.prisma:L12425`
- `CommissionTier` → `schema.prisma:L12239`
- `ConsentEvent` → `schema.prisma:L7009`
- `Consumer` → `schema.prisma:L7239`
- `ConsumerAuthAccount` → `schema.prisma:L7264`
- `CouponCode` → `schema.prisma:L8211`
- `CouponRedemption` → `schema.prisma:L8242`
- `CreditAssessmentHistory` → `schema.prisma:L10555`
- `CreditItemBalance` → `schema.prisma:L14204`
- `CreditOffer` → `schema.prisma:L10574`
- `CreditPack` → `schema.prisma:L14113`
- `CreditPackItem` → `schema.prisma:L14142`
- `CreditPackPurchase` → `schema.prisma:L14159`
- `CreditTransaction` → `schema.prisma:L14226`
- `Customer` → `schema.prisma:L6867`
- `CustomerApprovalDelivery` → `schema.prisma:L9223`
- `CustomerApprovalOutbox` → `schema.prisma:L9198`
- `CustomerCampaign` → `schema.prisma:L7097`
- `CustomerCampaignDelivery` → `schema.prisma:L7179`
- `CustomerCaptureToken` → `schema.prisma:L7045`
- `CustomerDiscount` → `schema.prisma:L8262`
- `CustomerGroup` → `schema.prisma:L7303`
- `CustomerOrderMetric` → `schema.prisma:L3835`
- `CustomerTaxProfile` → `schema.prisma:L16065`
- `DeliveryActivationRequest` → `schema.prisma:L6110`
- `DeliveryChannelLink` → `schema.prisma:L6055`
- `DeliveryOrderEvent` → `schema.prisma:L6134`
- `DeviceToken` → `schema.prisma:L8531`
- `DigitalReceipt` → `schema.prisma:L4413`
- `Discount` → `schema.prisma:L7901`
- `EcommerceMerchant` → `schema.prisma:L5569`
- `EmailQuotaLedger` → `schema.prisma:L7226`
- `EmailSuppression` → `schema.prisma:L7214`
- `EmailTemplate` → `schema.prisma:L12878`
- `Employee` → `schema.prisma:L16580`
- `Estimate` → `schema.prisma:L14523`
- `EstimateItem` → `schema.prisma:L14551`
- `Expense` → `schema.prisma:L16367`
- `ExternalBusyBlock` → `schema.prisma:L13881`
- `Feature` → `schema.prisma:L4542`
- `FeeSchedule` → `schema.prisma:L4620`
- `FeeTier` → `schema.prisma:L4631`
- `FinancialAccount` → `schema.prisma:L14713`
- `FinancialConnection` → `schema.prisma:L14682`
- `FinancialProvider` → `schema.prisma:L14668`
- `FiscalEmisor` → `schema.prisma:L15919`
- `FiscalLossCarryforward` → `schema.prisma:L16490`
- `FixedAsset` → `schema.prisma:L16508`
- `FixedAssetDepreciation` → `schema.prisma:L16537`
- `FloorElement` → `schema.prisma:L3140`
- `FulfillmentArea` → `schema.prisma:L14979`
- `GeofenceRule` → `schema.prisma:L10146`
- `GoogleCalendarChannel` → `schema.prisma:L13858`
- `GoogleCalendarConnection` → `schema.prisma:L13810`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13911`
- `GoogleOAuthSession` → `schema.prisma:L13933`
- `HolidayCalendar` → `schema.prisma:L6750`
- `IdempotencyRequest` → `schema.prisma:L12000`
- `InterVenueTransfer` → `schema.prisma:L2892`
- `InterVenueTransferAllocation` → `schema.prisma:L2975`
- `InterVenueTransferItem` → `schema.prisma:L2944`
- `InterVenueTransferReceipt` → `schema.prisma:L3002`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3018`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3046`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3030`
- `Inventory` → `schema.prisma:L1931`
- `InventoryMovement` → `schema.prisma:L1958`
- `InventoryPosting` → `schema.prisma:L2040`
- `InventoryPostingLine` → `schema.prisma:L2080`
- `InventoryTransfer` → `schema.prisma:L14495`
- `Invitation` → `schema.prisma:L1469`
- `Invoice` → `schema.prisma:L4643`
- `InvoiceItem` → `schema.prisma:L4669`
- `ItemCategory` → `schema.prisma:L11713`
- `JournalEntry` → `schema.prisma:L16277`
- `JournalLine` → `schema.prisma:L16305`
- `KdsOrder` → `schema.prisma:L14761`
- `KdsOrderItem` → `schema.prisma:L14802`
- `KioskCheckInAttempt` → `schema.prisma:L17226`
- `KioskCheckInChallenge` → `schema.prisma:L17180`
- `KioskOutreachOutbox` → `schema.prisma:L17247`
- `LearnedPatterns` → `schema.prisma:L9631`
- `LedgerAccount` → `schema.prisma:L16169`
- `LiveDemoSession` → `schema.prisma:L814`
- `LowStockAlert` → `schema.prisma:L2726`
- `LoyaltyConfig` → `schema.prisma:L7333`
- `LoyaltyTransaction` → `schema.prisma:L7376`
- `MarketingCampaign` → `schema.prisma:L12896`
- `McpAuthCode` → `schema.prisma:L15802`
- `McpOAuthClient` → `schema.prisma:L15786`
- `McpRefreshToken` → `schema.prisma:L15820`
- `McpToolCall` → `schema.prisma:L15841`
- `MeasurementUnit` → `schema.prisma:L14601`
- `Menu` → `schema.prisma:L1655`
- `MenuCategory` → `schema.prisma:L1592`
- `MenuCategoryAssignment` → `schema.prisma:L1690`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15716`
- `MerchantAccount` → `schema.prisma:L5307`
- `MerchantFiscalConfig` → `schema.prisma:L15967`
- `MerchantRevenueShare` → `schema.prisma:L6330`
- `MerchantRoutingRule` → `schema.prisma:L5429`
- `MilestoneAchievement` → `schema.prisma:L12320`
- `Modifier` → `schema.prisma:L4019`
- `ModifierGroup` → `schema.prisma:L3983`
- `Module` → `schema.prisma:L10622`
- `MoneyAnomaly` → `schema.prisma:L6233`
- `MonthlyVenueProfit` → `schema.prisma:L6776`
- `Notification` → `schema.prisma:L8433`
- `NotificationPreference` → `schema.prisma:L8480`
- `NotificationTemplate` → `schema.prisma:L8507`
- `OAuthState` → `schema.prisma:L1520`
- `OnboardingProgress` → `schema.prisma:L1538`
- `Order` → `schema.prisma:L3589`
- `OrderAction` → `schema.prisma:L4086`
- `OrderCustomer` → `schema.prisma:L3814`
- `OrderDiscount` → `schema.prisma:L8294`
- `OrderFulfillment` → `schema.prisma:L15034`
- `OrderFulfillmentLine` → `schema.prisma:L15065`
- `OrderItem` → `schema.prisma:L3850`
- `OrderItemModifier` → `schema.prisma:L4068`
- `OrderPromotion` → `schema.prisma:L17143`
- `OrderServiceCharge` → `schema.prisma:L8378`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12697`
- `OrganizationEntitlement` → `schema.prisma:L10905`
- `OrganizationGoal` → `schema.prisma:L12655`
- `OrganizationModule` → `schema.prisma:L10682`
- `OrganizationPaymentConfig` → `schema.prisma:L5881`
- `OrganizationPayoutConfig` → `schema.prisma:L12730`
- `OrganizationPricingStructure` → `schema.prisma:L5913`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12678`
- `OtpChallenge` → `schema.prisma:L7283`
- `OvertimeApproval` → `schema.prisma:L3367`
- `PartnerAPIKey` → `schema.prisma:L5711`
- `Payment` → `schema.prisma:L4119`
- `PaymentAllocation` → `schema.prisma:L4392`
- `PaymentEffect` → `schema.prisma:L17517`
- `PaymentLink` → `schema.prisma:L14272`
- `PaymentLinkAttribution` → `schema.prisma:L14380`
- `PaymentLinkItem` → `schema.prisma:L14335`
- `PaymentLinkItemModifier` → `schema.prisma:L14362`
- `PaymentProvider` → `schema.prisma:L5266`
- `PayrollLine` → `schema.prisma:L16651`
- `PayrollRun` → `schema.prisma:L16620`
- `PerformanceGoal` → `schema.prisma:L12632`
- `PermissionOverride` → `schema.prisma:L1393`
- `PermissionSet` → `schema.prisma:L1416`
- `PlatformAnnouncement` → `schema.prisma:L17307`
- `PlatformAnnouncementClick` → `schema.prisma:L17372`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17409`
- `PlatformCfdi` → `schema.prisma:L16936`
- `PlatformEmisor` → `schema.prisma:L16876`
- `PlatformSettings` → `schema.prisma:L5688`
- `PosCommand` → `schema.prisma:L8561`
- `PosConnectionStatus` → `schema.prisma:L940`
- `PosSyncIntent` → `schema.prisma:L17014`
- `PricingPolicy` → `schema.prisma:L2630`
- `Printer` → `schema.prisma:L14844`
- `PrintGateway` → `schema.prisma:L14901`
- `PrintJob` → `schema.prisma:L15615`
- `PrintStation` → `schema.prisma:L14919`
- `PrivacyNoticeVersion` → `schema.prisma:L7031`
- `ProcessedStripeEvent` → `schema.prisma:L6219`
- `ProcessorReliabilityMetric` → `schema.prisma:L6704`
- `Product` → `schema.prisma:L1708`
- `ProductModifierGroup` → `schema.prisma:L4056`
- `ProductOption` → `schema.prisma:L14578`
- `ProductOptionValue` → `schema.prisma:L14589`
- `ProductStaff` → `schema.prisma:L13507`
- `PromoterBankAccount` → `schema.prisma:L16771`
- `PromoterCommissionEntry` → `schema.prisma:L16790`
- `PromoterLocationPing` → `schema.prisma:L3555`
- `Promotion` → `schema.prisma:L17065`
- `PromotionGroup` → `schema.prisma:L17104`
- `PromotionOption` → `schema.prisma:L17120`
- `ProviderCostStructure` → `schema.prisma:L6255`
- `ProviderEventLog` → `schema.prisma:L5990`
- `PurchaseOrder` → `schema.prisma:L2355`
- `PurchaseOrderInvoice` → `schema.prisma:L2500`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2557`
- `PurchaseOrderItem` → `schema.prisma:L2413`
- `RateCorrectionBatch` → `schema.prisma:L6480`
- `RateCorrectionEntry` → `schema.prisma:L6522`
- `RawMaterial` → `schema.prisma:L2112`
- `RawMaterialMovement` → `schema.prisma:L2683`
- `RawMaterialPresentation` → `schema.prisma:L2187`
- `ReceiptLayout` → `schema.prisma:L17551`
- `Recipe` → `schema.prisma:L2207`
- `RecipeLine` → `schema.prisma:L2231`
- `Referral` → `schema.prisma:L7749`
- `ReferralProgramConfig` → `schema.prisma:L7714`
- `ReferralRewardGrant` → `schema.prisma:L7840`
- `ReferralTierReward` → `schema.prisma:L7812`
- `ReferralTierUnlock` → `schema.prisma:L7885`
- `RefreshGrant` → `schema.prisma:L17496`
- `Reservation` → `schema.prisma:L13275`
- `ReservationGoogleEventMapping` → `schema.prisma:L14045`
- `ReservationModifier` → `schema.prisma:L13455`
- `ReservationReminderSent` → `schema.prisma:L13438`
- `ReservationSettings` → `schema.prisma:L13669`
- `ReservationWaitlistEntry` → `schema.prisma:L13637`
- `Review` → `schema.prisma:L4687`
- `SalesRetention` → `schema.prisma:L16471`
- `SaleVerification` → `schema.prisma:L4446`
- `ScaleProfile` → `schema.prisma:L15356`
- `ScheduledCommand` → `schema.prisma:L10106`
- `SerializedItem` → `schema.prisma:L11756`
- `SerializedItemCustodyEvent` → `schema.prisma:L11923`
- `ServiceCharge` → `schema.prisma:L8349`
- `Session` → `schema.prisma:L17475`
- `SettlementConfiguration` → `schema.prisma:L6555`
- `SettlementConfirmation` → `schema.prisma:L6668`
- `SettlementIncident` → `schema.prisma:L6619`
- `SettlementSimulation` → `schema.prisma:L6590`
- `Shift` → `schema.prisma:L3178`
- `SimRegistrationRequest` → `schema.prisma:L11961`
- `SimRegistrationRequestItem` → `schema.prisma:L11983`
- `SlotHold` → `schema.prisma:L13538`
- `Staff` → `schema.prisma:L960`
- `StaffDocument` → `schema.prisma:L3426`
- `StaffOnboardingState` → `schema.prisma:L15686`
- `StaffOrganization` → `schema.prisma:L1292`
- `StaffPasskey` → `schema.prisma:L1319`
- `StaffSchedule` → `schema.prisma:L13478`
- `StaffScheduleException` → `schema.prisma:L13490`
- `StaffVenue` → `schema.prisma:L1216`
- `StaffWorkSchedule` → `schema.prisma:L3303`
- `StaffWorkScheduleException` → `schema.prisma:L3401`
- `StampCard` → `schema.prisma:L7597`
- `StampEvent` → `schema.prisma:L7636`
- `StampReward` → `schema.prisma:L7674`
- `StockAlertConfig` → `schema.prisma:L12614`
- `StockBatch` → `schema.prisma:L2841`
- `StockCount` → `schema.prisma:L2758`
- `StockCountItem` → `schema.prisma:L2786`
- `StripeWebhookEvent` → `schema.prisma:L6202`
- `Supplier` → `schema.prisma:L2266`
- `SupplierItemCode` → `schema.prisma:L2598`
- `SupplierPricing` → `schema.prisma:L2321`
- `Table` → `schema.prisma:L3090`
- `Terminal` → `schema.prisma:L4738`
- `TerminalHealth` → `schema.prisma:L4989`
- `TerminalLog` → `schema.prisma:L4963`
- `TerminalOrder` → `schema.prisma:L5169`
- `TerminalOrderItem` → `schema.prisma:L5244`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5122`
- `TerminalPaymentRequest` → `schema.prisma:L5060`
- `TimeEntry` → `schema.prisma:L3468`
- `TimeEntryBreak` → `schema.prisma:L3537`
- `TokenPurchase` → `schema.prisma:L9780`
- `TokenUsageRecord` → `schema.prisma:L9752`
- `TpvCommandHistory` → `schema.prisma:L10012`
- `TpvCommandQueue` → `schema.prisma:L9952`
- `TpvFeedback` → `schema.prisma:L9665`
- `TpvMessage` → `schema.prisma:L12971`
- `TpvMessageDelivery` → `schema.prisma:L13023`
- `TpvMessageResponse` → `schema.prisma:L13046`
- `TrainingModule` → `schema.prisma:L13101`
- `TrainingProgress` → `schema.prisma:L13178`
- `TrainingQuizQuestion` → `schema.prisma:L13160`
- `TrainingStep` → `schema.prisma:L13140`
- `TransactionCost` → `schema.prisma:L6418`
- `UnitConversion` → `schema.prisma:L2661`
- `UpsellAcceptance` → `schema.prisma:L8170`
- `UpsellAiRun` → `schema.prisma:L8190`
- `UpsellImpression` → `schema.prisma:L8130`
- `UpsellRule` → `schema.prisma:L8050`
- `user_sessions` → `schema.prisma:L5746`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L15093`
- `VenueChatMessage` → `schema.prisma:L790`
- `VenueChatSession` → `schema.prisma:L745`
- `VenueCommission` → `schema.prisma:L14739`
- `VenueCreditAssessment` → `schema.prisma:L10494`
- `VenueCryptoConfig` → `schema.prisma:L12838`
- `VenueFeature` → `schema.prisma:L4560`
- `VenueModule` → `schema.prisma:L10654`
- `VenuePaymentConfig` → `schema.prisma:L5847`
- `VenuePaymentLinkSettings` → `schema.prisma:L14078`
- `VenuePricingStructure` → `schema.prisma:L6358`
- `VenueRoleConfig` → `schema.prisma:L1445`
- `VenueRolePermission` → `schema.prisma:L1349`
- `VenueScaleSettings` → `schema.prisma:L15344`
- `VenueSettings` → `schema.prisma:L830`
- `VenueTenderType` → `schema.prisma:L4305`
- `VenueTenderTypeRevision` → `schema.prisma:L4370`
- `VenueTransaction` → `schema.prisma:L4497`
- `VenueWhatsappActivation` → `schema.prisma:L681`
- `WalletCardDesign` → `schema.prisma:L7515`
- `WalletPass` → `schema.prisma:L7416`
- `WalletPassRegistration` → `schema.prisma:L7482`
- `WebhookEvent` → `schema.prisma:L4596`
- `WebhookSubscription` → `schema.prisma:L5963`
- `WhatsappContactWindow` → `schema.prisma:L699`
- `WhatsappInboundEvent` → `schema.prisma:L719`
- `WorkShiftAssignment` → `schema.prisma:L3343`
- `WorkShiftTemplate` → `schema.prisma:L3320`
- `Zone` → `schema.prisma:L142`
