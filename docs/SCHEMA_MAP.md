# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **367 models / 346 enums / ~17,500 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                                    |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L16280`
- `AccountMapping` → `schema.prisma:L16176`
- `ActivityLog` → `schema.prisma:L6783`
- `Aggregator` → `schema.prisma:L14573`
- `AngelPayUserAccount` → `schema.prisma:L5446`
- `AppUpdate` → `schema.prisma:L12738`
- `Area` → `schema.prisma:L3064`
- `AreaTicket` → `schema.prisma:L15071`
- `AreaTicketCheckoutSession` → `schema.prisma:L15193`
- `AreaTicketExternalIncident` → `schema.prisma:L15440`
- `AreaTicketExternalSettlement` → `schema.prisma:L15405`
- `AreaTicketFulfillment` → `schema.prisma:L15269`
- `AreaTicketInventoryReservation` → `schema.prisma:L15164`
- `AreaTicketLine` → `schema.prisma:L15132`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15225`
- `AreaTicketPrintAttempt` → `schema.prisma:L15248`
- `BankStatement` → `schema.prisma:L16050`
- `BankStatementLine` → `schema.prisma:L16071`
- `BillingTaxProfile` → `schema.prisma:L16860`
- `BirthdayAutomation` → `schema.prisma:L7104`
- `BulkCommandOperation` → `schema.prisma:L10018`
- `CalendarSyncOutbox` → `schema.prisma:L13945`
- `CampaignDelivery` → `schema.prisma:L12896`
- `CashCloseout` → `schema.prisma:L10403`
- `CashDeposit` → `schema.prisma:L12540`
- `CashDrawerEvent` → `schema.prisma:L14410`
- `CashDrawerSession` → `schema.prisma:L14371`
- `CashOutCommissionRate` → `schema.prisma:L16689`
- `CashOutScheduleDay` → `schema.prisma:L16712`
- `CashOutWithdrawal` → `schema.prisma:L16774`
- `CatalogBindingBatch` → `schema.prisma:L11434`
- `CatalogBindingLine` → `schema.prisma:L11470`
- `CatalogBrand` → `schema.prisma:L10887`
- `CatalogClientObservation` → `schema.prisma:L11200`
- `CatalogClientReadinessOverride` → `schema.prisma:L11219`
- `CatalogFamily` → `schema.prisma:L10937`
- `CatalogIdempotencyRecord` → `schema.prisma:L11333`
- `CatalogIdentifier` → `schema.prisma:L11068`
- `CatalogImportBatch` → `schema.prisma:L11376`
- `CatalogImportLine` → `schema.prisma:L11413`
- `CatalogItem` → `schema.prisma:L10970`
- `CatalogItemBusinessType` → `schema.prisma:L11030`
- `CatalogItemPrice` → `schema.prisma:L11118`
- `CatalogManufacturer` → `schema.prisma:L10911`
- `CatalogProductTypeMapping` → `schema.prisma:L11047`
- `CatalogPublicationBatch` → `schema.prisma:L11498`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11592`
- `CatalogPublicationLine` → `schema.prisma:L11539`
- `CatalogPublicationOutbox` → `schema.prisma:L11635`
- `CatalogValidationProfile` → `schema.prisma:L11089`
- `CatalogVenueBinding` → `schema.prisma:L11247`
- `CatalogVenueClientRequirement` → `schema.prisma:L11174`
- `CatalogVenueEventSequence` → `schema.prisma:L11618`
- `CatalogVenueOverride` → `schema.prisma:L11289`
- `CatalogVenueRollout` → `schema.prisma:L11149`
- `Cfdi` → `schema.prisma:L15953`
- `ChatbotTokenBudget` → `schema.prisma:L9666`
- `ChatConversation` → `schema.prisma:L9521`
- `ChatFeedback` → `schema.prisma:L9607`
- `ChatLearningEvent` → `schema.prisma:L9564`
- `ChatMessage` → `schema.prisma:L9544`
- `ChatTrainingData` → `schema.prisma:L9478`
- `CheckoutSession` → `schema.prisma:L5726`
- `ClassSession` → `schema.prisma:L13549`
- `CommissionCalculation` → `schema.prisma:L12316`
- `CommissionClawback` → `schema.prisma:L12492`
- `CommissionConfig` → `schema.prisma:L12082`
- `CommissionMilestone` → `schema.prisma:L12232`
- `CommissionOverride` → `schema.prisma:L12159`
- `CommissionPayout` → `schema.prisma:L12443`
- `CommissionSummary` → `schema.prisma:L12382`
- `CommissionTier` → `schema.prisma:L12196`
- `ConsentEvent` → `schema.prisma:L6966`
- `Consumer` → `schema.prisma:L7196`
- `ConsumerAuthAccount` → `schema.prisma:L7221`
- `CouponCode` → `schema.prisma:L8168`
- `CouponRedemption` → `schema.prisma:L8199`
- `CreditAssessmentHistory` → `schema.prisma:L10512`
- `CreditItemBalance` → `schema.prisma:L14161`
- `CreditOffer` → `schema.prisma:L10531`
- `CreditPack` → `schema.prisma:L14070`
- `CreditPackItem` → `schema.prisma:L14099`
- `CreditPackPurchase` → `schema.prisma:L14116`
- `CreditTransaction` → `schema.prisma:L14183`
- `Customer` → `schema.prisma:L6824`
- `CustomerApprovalDelivery` → `schema.prisma:L9180`
- `CustomerApprovalOutbox` → `schema.prisma:L9155`
- `CustomerCampaign` → `schema.prisma:L7054`
- `CustomerCampaignDelivery` → `schema.prisma:L7136`
- `CustomerCaptureToken` → `schema.prisma:L7002`
- `CustomerDiscount` → `schema.prisma:L8219`
- `CustomerGroup` → `schema.prisma:L7260`
- `CustomerOrderMetric` → `schema.prisma:L3835`
- `CustomerTaxProfile` → `schema.prisma:L16022`
- `DeliveryActivationRequest` → `schema.prisma:L6067`
- `DeliveryChannelLink` → `schema.prisma:L6012`
- `DeliveryOrderEvent` → `schema.prisma:L6091`
- `DeviceToken` → `schema.prisma:L8488`
- `DigitalReceipt` → `schema.prisma:L4407`
- `Discount` → `schema.prisma:L7858`
- `EcommerceMerchant` → `schema.prisma:L5538`
- `EmailQuotaLedger` → `schema.prisma:L7183`
- `EmailSuppression` → `schema.prisma:L7171`
- `EmailTemplate` → `schema.prisma:L12835`
- `Employee` → `schema.prisma:L16537`
- `Estimate` → `schema.prisma:L14480`
- `EstimateItem` → `schema.prisma:L14508`
- `Expense` → `schema.prisma:L16324`
- `ExternalBusyBlock` → `schema.prisma:L13838`
- `Feature` → `schema.prisma:L4536`
- `FeeSchedule` → `schema.prisma:L4614`
- `FeeTier` → `schema.prisma:L4625`
- `FinancialAccount` → `schema.prisma:L14670`
- `FinancialConnection` → `schema.prisma:L14639`
- `FinancialProvider` → `schema.prisma:L14625`
- `FiscalEmisor` → `schema.prisma:L15876`
- `FiscalLossCarryforward` → `schema.prisma:L16447`
- `FixedAsset` → `schema.prisma:L16465`
- `FixedAssetDepreciation` → `schema.prisma:L16494`
- `FloorElement` → `schema.prisma:L3140`
- `FulfillmentArea` → `schema.prisma:L14936`
- `GeofenceRule` → `schema.prisma:L10103`
- `GoogleCalendarChannel` → `schema.prisma:L13815`
- `GoogleCalendarConnection` → `schema.prisma:L13767`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13868`
- `GoogleOAuthSession` → `schema.prisma:L13890`
- `HolidayCalendar` → `schema.prisma:L6707`
- `IdempotencyRequest` → `schema.prisma:L11957`
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
- `InventoryTransfer` → `schema.prisma:L14452`
- `Invitation` → `schema.prisma:L1469`
- `Invoice` → `schema.prisma:L4637`
- `InvoiceItem` → `schema.prisma:L4663`
- `ItemCategory` → `schema.prisma:L11670`
- `JournalEntry` → `schema.prisma:L16234`
- `JournalLine` → `schema.prisma:L16262`
- `KdsOrder` → `schema.prisma:L14718`
- `KdsOrderItem` → `schema.prisma:L14759`
- `KioskCheckInAttempt` → `schema.prisma:L17183`
- `KioskCheckInChallenge` → `schema.prisma:L17137`
- `KioskOutreachOutbox` → `schema.prisma:L17204`
- `LearnedPatterns` → `schema.prisma:L9588`
- `LedgerAccount` → `schema.prisma:L16126`
- `LiveDemoSession` → `schema.prisma:L814`
- `LowStockAlert` → `schema.prisma:L2726`
- `LoyaltyConfig` → `schema.prisma:L7290`
- `LoyaltyTransaction` → `schema.prisma:L7333`
- `MarketingCampaign` → `schema.prisma:L12853`
- `McpAuthCode` → `schema.prisma:L15759`
- `McpOAuthClient` → `schema.prisma:L15743`
- `McpRefreshToken` → `schema.prisma:L15777`
- `McpToolCall` → `schema.prisma:L15798`
- `MeasurementUnit` → `schema.prisma:L14558`
- `Menu` → `schema.prisma:L1655`
- `MenuCategory` → `schema.prisma:L1592`
- `MenuCategoryAssignment` → `schema.prisma:L1690`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15673`
- `MerchantAccount` → `schema.prisma:L5276`
- `MerchantFiscalConfig` → `schema.prisma:L15924`
- `MerchantRevenueShare` → `schema.prisma:L6287`
- `MerchantRoutingRule` → `schema.prisma:L5398`
- `MilestoneAchievement` → `schema.prisma:L12277`
- `Modifier` → `schema.prisma:L4019`
- `ModifierGroup` → `schema.prisma:L3983`
- `Module` → `schema.prisma:L10579`
- `MoneyAnomaly` → `schema.prisma:L6190`
- `MonthlyVenueProfit` → `schema.prisma:L6733`
- `Notification` → `schema.prisma:L8390`
- `NotificationPreference` → `schema.prisma:L8437`
- `NotificationTemplate` → `schema.prisma:L8464`
- `OAuthState` → `schema.prisma:L1520`
- `OnboardingProgress` → `schema.prisma:L1538`
- `Order` → `schema.prisma:L3589`
- `OrderAction` → `schema.prisma:L4086`
- `OrderCustomer` → `schema.prisma:L3814`
- `OrderDiscount` → `schema.prisma:L8251`
- `OrderFulfillment` → `schema.prisma:L14991`
- `OrderFulfillmentLine` → `schema.prisma:L15022`
- `OrderItem` → `schema.prisma:L3850`
- `OrderItemModifier` → `schema.prisma:L4068`
- `OrderPromotion` → `schema.prisma:L17100`
- `OrderServiceCharge` → `schema.prisma:L8335`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12654`
- `OrganizationEntitlement` → `schema.prisma:L10862`
- `OrganizationGoal` → `schema.prisma:L12612`
- `OrganizationModule` → `schema.prisma:L10639`
- `OrganizationPaymentConfig` → `schema.prisma:L5850`
- `OrganizationPayoutConfig` → `schema.prisma:L12687`
- `OrganizationPricingStructure` → `schema.prisma:L5882`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12635`
- `OtpChallenge` → `schema.prisma:L7240`
- `OvertimeApproval` → `schema.prisma:L3367`
- `PartnerAPIKey` → `schema.prisma:L5680`
- `Payment` → `schema.prisma:L4119`
- `PaymentAllocation` → `schema.prisma:L4386`
- `PaymentEffect` → `schema.prisma:L17474`
- `PaymentLink` → `schema.prisma:L14229`
- `PaymentLinkAttribution` → `schema.prisma:L14337`
- `PaymentLinkItem` → `schema.prisma:L14292`
- `PaymentLinkItemModifier` → `schema.prisma:L14319`
- `PaymentProvider` → `schema.prisma:L5235`
- `PayrollLine` → `schema.prisma:L16608`
- `PayrollRun` → `schema.prisma:L16577`
- `PerformanceGoal` → `schema.prisma:L12589`
- `PermissionOverride` → `schema.prisma:L1393`
- `PermissionSet` → `schema.prisma:L1416`
- `PlatformAnnouncement` → `schema.prisma:L17264`
- `PlatformAnnouncementClick` → `schema.prisma:L17329`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17366`
- `PlatformCfdi` → `schema.prisma:L16893`
- `PlatformEmisor` → `schema.prisma:L16833`
- `PlatformSettings` → `schema.prisma:L5657`
- `PosCommand` → `schema.prisma:L8518`
- `PosConnectionStatus` → `schema.prisma:L940`
- `PosSyncIntent` → `schema.prisma:L16971`
- `PricingPolicy` → `schema.prisma:L2630`
- `Printer` → `schema.prisma:L14801`
- `PrintGateway` → `schema.prisma:L14858`
- `PrintJob` → `schema.prisma:L15572`
- `PrintStation` → `schema.prisma:L14876`
- `PrivacyNoticeVersion` → `schema.prisma:L6988`
- `ProcessedStripeEvent` → `schema.prisma:L6176`
- `ProcessorReliabilityMetric` → `schema.prisma:L6661`
- `Product` → `schema.prisma:L1708`
- `ProductModifierGroup` → `schema.prisma:L4056`
- `ProductOption` → `schema.prisma:L14535`
- `ProductOptionValue` → `schema.prisma:L14546`
- `ProductStaff` → `schema.prisma:L13464`
- `PromoterBankAccount` → `schema.prisma:L16728`
- `PromoterCommissionEntry` → `schema.prisma:L16747`
- `PromoterLocationPing` → `schema.prisma:L3555`
- `Promotion` → `schema.prisma:L17022`
- `PromotionGroup` → `schema.prisma:L17061`
- `PromotionOption` → `schema.prisma:L17077`
- `ProviderCostStructure` → `schema.prisma:L6212`
- `ProviderEventLog` → `schema.prisma:L5959`
- `PurchaseOrder` → `schema.prisma:L2355`
- `PurchaseOrderInvoice` → `schema.prisma:L2500`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2557`
- `PurchaseOrderItem` → `schema.prisma:L2413`
- `RateCorrectionBatch` → `schema.prisma:L6437`
- `RateCorrectionEntry` → `schema.prisma:L6479`
- `RawMaterial` → `schema.prisma:L2112`
- `RawMaterialMovement` → `schema.prisma:L2683`
- `RawMaterialPresentation` → `schema.prisma:L2187`
- `ReceiptLayout` → `schema.prisma:L17508`
- `Recipe` → `schema.prisma:L2207`
- `RecipeLine` → `schema.prisma:L2231`
- `Referral` → `schema.prisma:L7706`
- `ReferralProgramConfig` → `schema.prisma:L7671`
- `ReferralRewardGrant` → `schema.prisma:L7797`
- `ReferralTierReward` → `schema.prisma:L7769`
- `ReferralTierUnlock` → `schema.prisma:L7842`
- `RefreshGrant` → `schema.prisma:L17453`
- `Reservation` → `schema.prisma:L13232`
- `ReservationGoogleEventMapping` → `schema.prisma:L14002`
- `ReservationModifier` → `schema.prisma:L13412`
- `ReservationReminderSent` → `schema.prisma:L13395`
- `ReservationSettings` → `schema.prisma:L13626`
- `ReservationWaitlistEntry` → `schema.prisma:L13594`
- `Review` → `schema.prisma:L4681`
- `SalesRetention` → `schema.prisma:L16428`
- `SaleVerification` → `schema.prisma:L4440`
- `ScaleProfile` → `schema.prisma:L15313`
- `ScheduledCommand` → `schema.prisma:L10063`
- `SerializedItem` → `schema.prisma:L11713`
- `SerializedItemCustodyEvent` → `schema.prisma:L11880`
- `ServiceCharge` → `schema.prisma:L8306`
- `Session` → `schema.prisma:L17432`
- `SettlementConfiguration` → `schema.prisma:L6512`
- `SettlementConfirmation` → `schema.prisma:L6625`
- `SettlementIncident` → `schema.prisma:L6576`
- `SettlementSimulation` → `schema.prisma:L6547`
- `Shift` → `schema.prisma:L3178`
- `SimRegistrationRequest` → `schema.prisma:L11918`
- `SimRegistrationRequestItem` → `schema.prisma:L11940`
- `SlotHold` → `schema.prisma:L13495`
- `Staff` → `schema.prisma:L960`
- `StaffDocument` → `schema.prisma:L3426`
- `StaffOnboardingState` → `schema.prisma:L15643`
- `StaffOrganization` → `schema.prisma:L1292`
- `StaffPasskey` → `schema.prisma:L1319`
- `StaffSchedule` → `schema.prisma:L13435`
- `StaffScheduleException` → `schema.prisma:L13447`
- `StaffVenue` → `schema.prisma:L1216`
- `StaffWorkSchedule` → `schema.prisma:L3303`
- `StaffWorkScheduleException` → `schema.prisma:L3401`
- `StampCard` → `schema.prisma:L7554`
- `StampEvent` → `schema.prisma:L7593`
- `StampReward` → `schema.prisma:L7631`
- `StockAlertConfig` → `schema.prisma:L12571`
- `StockBatch` → `schema.prisma:L2841`
- `StockCount` → `schema.prisma:L2758`
- `StockCountItem` → `schema.prisma:L2786`
- `StripeWebhookEvent` → `schema.prisma:L6159`
- `Supplier` → `schema.prisma:L2266`
- `SupplierItemCode` → `schema.prisma:L2598`
- `SupplierPricing` → `schema.prisma:L2321`
- `Table` → `schema.prisma:L3090`
- `Terminal` → `schema.prisma:L4732`
- `TerminalHealth` → `schema.prisma:L4983`
- `TerminalLog` → `schema.prisma:L4957`
- `TerminalOrder` → `schema.prisma:L5138`
- `TerminalOrderItem` → `schema.prisma:L5213`
- `TerminalPaymentRequest` → `schema.prisma:L5054`
- `TimeEntry` → `schema.prisma:L3468`
- `TimeEntryBreak` → `schema.prisma:L3537`
- `TokenPurchase` → `schema.prisma:L9737`
- `TokenUsageRecord` → `schema.prisma:L9709`
- `TpvCommandHistory` → `schema.prisma:L9969`
- `TpvCommandQueue` → `schema.prisma:L9909`
- `TpvFeedback` → `schema.prisma:L9622`
- `TpvMessage` → `schema.prisma:L12928`
- `TpvMessageDelivery` → `schema.prisma:L12980`
- `TpvMessageResponse` → `schema.prisma:L13003`
- `TrainingModule` → `schema.prisma:L13058`
- `TrainingProgress` → `schema.prisma:L13135`
- `TrainingQuizQuestion` → `schema.prisma:L13117`
- `TrainingStep` → `schema.prisma:L13097`
- `TransactionCost` → `schema.prisma:L6375`
- `UnitConversion` → `schema.prisma:L2661`
- `UpsellAcceptance` → `schema.prisma:L8127`
- `UpsellAiRun` → `schema.prisma:L8147`
- `UpsellImpression` → `schema.prisma:L8087`
- `UpsellRule` → `schema.prisma:L8007`
- `user_sessions` → `schema.prisma:L5715`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L15050`
- `VenueChatMessage` → `schema.prisma:L790`
- `VenueChatSession` → `schema.prisma:L745`
- `VenueCommission` → `schema.prisma:L14696`
- `VenueCreditAssessment` → `schema.prisma:L10451`
- `VenueCryptoConfig` → `schema.prisma:L12795`
- `VenueFeature` → `schema.prisma:L4554`
- `VenueModule` → `schema.prisma:L10611`
- `VenuePaymentConfig` → `schema.prisma:L5816`
- `VenuePaymentLinkSettings` → `schema.prisma:L14035`
- `VenuePricingStructure` → `schema.prisma:L6315`
- `VenueRoleConfig` → `schema.prisma:L1445`
- `VenueRolePermission` → `schema.prisma:L1349`
- `VenueScaleSettings` → `schema.prisma:L15301`
- `VenueSettings` → `schema.prisma:L830`
- `VenueTenderType` → `schema.prisma:L4299`
- `VenueTenderTypeRevision` → `schema.prisma:L4364`
- `VenueTransaction` → `schema.prisma:L4491`
- `VenueWhatsappActivation` → `schema.prisma:L681`
- `WalletCardDesign` → `schema.prisma:L7472`
- `WalletPass` → `schema.prisma:L7373`
- `WalletPassRegistration` → `schema.prisma:L7439`
- `WebhookEvent` → `schema.prisma:L4590`
- `WebhookSubscription` → `schema.prisma:L5932`
- `WhatsappContactWindow` → `schema.prisma:L699`
- `WhatsappInboundEvent` → `schema.prisma:L719`
- `WorkShiftAssignment` → `schema.prisma:L3343`
- `WorkShiftTemplate` → `schema.prisma:L3320`
- `Zone` → `schema.prisma:L142`
