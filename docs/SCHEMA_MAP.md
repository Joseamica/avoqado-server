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

- `AccountingPeriodLock` → `schema.prisma:L16342`
- `AccountMapping` → `schema.prisma:L16238`
- `ActivityLog` → `schema.prisma:L6845`
- `Aggregator` → `schema.prisma:L14635`
- `AngelPayUserAccount` → `schema.prisma:L5496`
- `AppUpdate` → `schema.prisma:L12800`
- `Area` → `schema.prisma:L3064`
- `AreaTicket` → `schema.prisma:L15133`
- `AreaTicketCheckoutSession` → `schema.prisma:L15255`
- `AreaTicketExternalIncident` → `schema.prisma:L15502`
- `AreaTicketExternalSettlement` → `schema.prisma:L15467`
- `AreaTicketFulfillment` → `schema.prisma:L15331`
- `AreaTicketInventoryReservation` → `schema.prisma:L15226`
- `AreaTicketLine` → `schema.prisma:L15194`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15287`
- `AreaTicketPrintAttempt` → `schema.prisma:L15310`
- `BankStatement` → `schema.prisma:L16112`
- `BankStatementLine` → `schema.prisma:L16133`
- `BillingTaxProfile` → `schema.prisma:L16922`
- `BirthdayAutomation` → `schema.prisma:L7166`
- `BulkCommandOperation` → `schema.prisma:L10080`
- `CalendarSyncOutbox` → `schema.prisma:L14007`
- `CampaignDelivery` → `schema.prisma:L12958`
- `CashCloseout` → `schema.prisma:L10465`
- `CashDeposit` → `schema.prisma:L12602`
- `CashDrawerEvent` → `schema.prisma:L14472`
- `CashDrawerSession` → `schema.prisma:L14433`
- `CashOutCommissionRate` → `schema.prisma:L16751`
- `CashOutScheduleDay` → `schema.prisma:L16774`
- `CashOutWithdrawal` → `schema.prisma:L16836`
- `CatalogBindingBatch` → `schema.prisma:L11496`
- `CatalogBindingLine` → `schema.prisma:L11532`
- `CatalogBrand` → `schema.prisma:L10949`
- `CatalogClientObservation` → `schema.prisma:L11262`
- `CatalogClientReadinessOverride` → `schema.prisma:L11281`
- `CatalogFamily` → `schema.prisma:L10999`
- `CatalogIdempotencyRecord` → `schema.prisma:L11395`
- `CatalogIdentifier` → `schema.prisma:L11130`
- `CatalogImportBatch` → `schema.prisma:L11438`
- `CatalogImportLine` → `schema.prisma:L11475`
- `CatalogItem` → `schema.prisma:L11032`
- `CatalogItemBusinessType` → `schema.prisma:L11092`
- `CatalogItemPrice` → `schema.prisma:L11180`
- `CatalogManufacturer` → `schema.prisma:L10973`
- `CatalogProductTypeMapping` → `schema.prisma:L11109`
- `CatalogPublicationBatch` → `schema.prisma:L11560`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11654`
- `CatalogPublicationLine` → `schema.prisma:L11601`
- `CatalogPublicationOutbox` → `schema.prisma:L11697`
- `CatalogValidationProfile` → `schema.prisma:L11151`
- `CatalogVenueBinding` → `schema.prisma:L11309`
- `CatalogVenueClientRequirement` → `schema.prisma:L11236`
- `CatalogVenueEventSequence` → `schema.prisma:L11680`
- `CatalogVenueOverride` → `schema.prisma:L11351`
- `CatalogVenueRollout` → `schema.prisma:L11211`
- `Cfdi` → `schema.prisma:L16015`
- `ChatbotTokenBudget` → `schema.prisma:L9728`
- `ChatConversation` → `schema.prisma:L9583`
- `ChatFeedback` → `schema.prisma:L9669`
- `ChatLearningEvent` → `schema.prisma:L9626`
- `ChatMessage` → `schema.prisma:L9606`
- `ChatTrainingData` → `schema.prisma:L9540`
- `CheckoutSession` → `schema.prisma:L5776`
- `ClassSession` → `schema.prisma:L13611`
- `CommissionCalculation` → `schema.prisma:L12378`
- `CommissionClawback` → `schema.prisma:L12554`
- `CommissionConfig` → `schema.prisma:L12144`
- `CommissionMilestone` → `schema.prisma:L12294`
- `CommissionOverride` → `schema.prisma:L12221`
- `CommissionPayout` → `schema.prisma:L12505`
- `CommissionSummary` → `schema.prisma:L12444`
- `CommissionTier` → `schema.prisma:L12258`
- `ConsentEvent` → `schema.prisma:L7028`
- `Consumer` → `schema.prisma:L7258`
- `ConsumerAuthAccount` → `schema.prisma:L7283`
- `CouponCode` → `schema.prisma:L8230`
- `CouponRedemption` → `schema.prisma:L8261`
- `CreditAssessmentHistory` → `schema.prisma:L10574`
- `CreditItemBalance` → `schema.prisma:L14223`
- `CreditOffer` → `schema.prisma:L10593`
- `CreditPack` → `schema.prisma:L14132`
- `CreditPackItem` → `schema.prisma:L14161`
- `CreditPackPurchase` → `schema.prisma:L14178`
- `CreditTransaction` → `schema.prisma:L14245`
- `Customer` → `schema.prisma:L6886`
- `CustomerApprovalDelivery` → `schema.prisma:L9242`
- `CustomerApprovalOutbox` → `schema.prisma:L9217`
- `CustomerCampaign` → `schema.prisma:L7116`
- `CustomerCampaignDelivery` → `schema.prisma:L7198`
- `CustomerCaptureToken` → `schema.prisma:L7064`
- `CustomerDiscount` → `schema.prisma:L8281`
- `CustomerGroup` → `schema.prisma:L7322`
- `CustomerOrderMetric` → `schema.prisma:L3835`
- `CustomerTaxProfile` → `schema.prisma:L16084`
- `DeliveryActivationRequest` → `schema.prisma:L6129`
- `DeliveryChannelLink` → `schema.prisma:L6074`
- `DeliveryOrderEvent` → `schema.prisma:L6153`
- `DeviceToken` → `schema.prisma:L8550`
- `DigitalReceipt` → `schema.prisma:L4413`
- `Discount` → `schema.prisma:L7920`
- `EcommerceMerchant` → `schema.prisma:L5588`
- `EmailQuotaLedger` → `schema.prisma:L7245`
- `EmailSuppression` → `schema.prisma:L7233`
- `EmailTemplate` → `schema.prisma:L12897`
- `Employee` → `schema.prisma:L16599`
- `Estimate` → `schema.prisma:L14542`
- `EstimateItem` → `schema.prisma:L14570`
- `Expense` → `schema.prisma:L16386`
- `ExternalBusyBlock` → `schema.prisma:L13900`
- `Feature` → `schema.prisma:L4542`
- `FeeSchedule` → `schema.prisma:L4620`
- `FeeTier` → `schema.prisma:L4631`
- `FinancialAccount` → `schema.prisma:L14732`
- `FinancialConnection` → `schema.prisma:L14701`
- `FinancialProvider` → `schema.prisma:L14687`
- `FiscalEmisor` → `schema.prisma:L15938`
- `FiscalLossCarryforward` → `schema.prisma:L16509`
- `FixedAsset` → `schema.prisma:L16527`
- `FixedAssetDepreciation` → `schema.prisma:L16556`
- `FloorElement` → `schema.prisma:L3140`
- `FulfillmentArea` → `schema.prisma:L14998`
- `GeofenceRule` → `schema.prisma:L10165`
- `GoogleCalendarChannel` → `schema.prisma:L13877`
- `GoogleCalendarConnection` → `schema.prisma:L13829`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13930`
- `GoogleOAuthSession` → `schema.prisma:L13952`
- `HolidayCalendar` → `schema.prisma:L6769`
- `IdempotencyRequest` → `schema.prisma:L12019`
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
- `InventoryTransfer` → `schema.prisma:L14514`
- `Invitation` → `schema.prisma:L1469`
- `Invoice` → `schema.prisma:L4643`
- `InvoiceItem` → `schema.prisma:L4669`
- `ItemCategory` → `schema.prisma:L11732`
- `JournalEntry` → `schema.prisma:L16296`
- `JournalLine` → `schema.prisma:L16324`
- `KdsOrder` → `schema.prisma:L14780`
- `KdsOrderItem` → `schema.prisma:L14821`
- `KioskCheckInAttempt` → `schema.prisma:L17245`
- `KioskCheckInChallenge` → `schema.prisma:L17199`
- `KioskOutreachOutbox` → `schema.prisma:L17266`
- `LearnedPatterns` → `schema.prisma:L9650`
- `LedgerAccount` → `schema.prisma:L16188`
- `LiveDemoSession` → `schema.prisma:L814`
- `LowStockAlert` → `schema.prisma:L2726`
- `LoyaltyConfig` → `schema.prisma:L7352`
- `LoyaltyTransaction` → `schema.prisma:L7395`
- `MarketingCampaign` → `schema.prisma:L12915`
- `McpAuthCode` → `schema.prisma:L15821`
- `McpOAuthClient` → `schema.prisma:L15805`
- `McpRefreshToken` → `schema.prisma:L15839`
- `McpToolCall` → `schema.prisma:L15860`
- `MeasurementUnit` → `schema.prisma:L14620`
- `Menu` → `schema.prisma:L1655`
- `MenuCategory` → `schema.prisma:L1592`
- `MenuCategoryAssignment` → `schema.prisma:L1690`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15735`
- `MerchantAccount` → `schema.prisma:L5326`
- `MerchantFiscalConfig` → `schema.prisma:L15986`
- `MerchantRevenueShare` → `schema.prisma:L6349`
- `MerchantRoutingRule` → `schema.prisma:L5448`
- `MilestoneAchievement` → `schema.prisma:L12339`
- `Modifier` → `schema.prisma:L4019`
- `ModifierGroup` → `schema.prisma:L3983`
- `Module` → `schema.prisma:L10641`
- `MoneyAnomaly` → `schema.prisma:L6252`
- `MonthlyVenueProfit` → `schema.prisma:L6795`
- `Notification` → `schema.prisma:L8452`
- `NotificationPreference` → `schema.prisma:L8499`
- `NotificationTemplate` → `schema.prisma:L8526`
- `OAuthState` → `schema.prisma:L1520`
- `OnboardingProgress` → `schema.prisma:L1538`
- `Order` → `schema.prisma:L3589`
- `OrderAction` → `schema.prisma:L4086`
- `OrderCustomer` → `schema.prisma:L3814`
- `OrderDiscount` → `schema.prisma:L8313`
- `OrderFulfillment` → `schema.prisma:L15053`
- `OrderFulfillmentLine` → `schema.prisma:L15084`
- `OrderItem` → `schema.prisma:L3850`
- `OrderItemModifier` → `schema.prisma:L4068`
- `OrderPromotion` → `schema.prisma:L17162`
- `OrderServiceCharge` → `schema.prisma:L8397`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12716`
- `OrganizationEntitlement` → `schema.prisma:L10924`
- `OrganizationGoal` → `schema.prisma:L12674`
- `OrganizationModule` → `schema.prisma:L10701`
- `OrganizationPaymentConfig` → `schema.prisma:L5900`
- `OrganizationPayoutConfig` → `schema.prisma:L12749`
- `OrganizationPricingStructure` → `schema.prisma:L5932`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12697`
- `OtpChallenge` → `schema.prisma:L7302`
- `OvertimeApproval` → `schema.prisma:L3367`
- `PartnerAPIKey` → `schema.prisma:L5730`
- `Payment` → `schema.prisma:L4119`
- `PaymentAllocation` → `schema.prisma:L4392`
- `PaymentEffect` → `schema.prisma:L17536`
- `PaymentLink` → `schema.prisma:L14291`
- `PaymentLinkAttribution` → `schema.prisma:L14399`
- `PaymentLinkItem` → `schema.prisma:L14354`
- `PaymentLinkItemModifier` → `schema.prisma:L14381`
- `PaymentProvider` → `schema.prisma:L5285`
- `PayrollLine` → `schema.prisma:L16670`
- `PayrollRun` → `schema.prisma:L16639`
- `PerformanceGoal` → `schema.prisma:L12651`
- `PermissionOverride` → `schema.prisma:L1393`
- `PermissionSet` → `schema.prisma:L1416`
- `PlatformAnnouncement` → `schema.prisma:L17326`
- `PlatformAnnouncementClick` → `schema.prisma:L17391`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17428`
- `PlatformCfdi` → `schema.prisma:L16955`
- `PlatformEmisor` → `schema.prisma:L16895`
- `PlatformSettings` → `schema.prisma:L5707`
- `PosCommand` → `schema.prisma:L8580`
- `PosConnectionStatus` → `schema.prisma:L940`
- `PosSyncIntent` → `schema.prisma:L17033`
- `PricingPolicy` → `schema.prisma:L2630`
- `Printer` → `schema.prisma:L14863`
- `PrintGateway` → `schema.prisma:L14920`
- `PrintJob` → `schema.prisma:L15634`
- `PrintStation` → `schema.prisma:L14938`
- `PrivacyNoticeVersion` → `schema.prisma:L7050`
- `ProcessedStripeEvent` → `schema.prisma:L6238`
- `ProcessorReliabilityMetric` → `schema.prisma:L6723`
- `Product` → `schema.prisma:L1708`
- `ProductModifierGroup` → `schema.prisma:L4056`
- `ProductOption` → `schema.prisma:L14597`
- `ProductOptionValue` → `schema.prisma:L14608`
- `ProductStaff` → `schema.prisma:L13526`
- `PromoterBankAccount` → `schema.prisma:L16790`
- `PromoterCommissionEntry` → `schema.prisma:L16809`
- `PromoterLocationPing` → `schema.prisma:L3555`
- `Promotion` → `schema.prisma:L17084`
- `PromotionGroup` → `schema.prisma:L17123`
- `PromotionOption` → `schema.prisma:L17139`
- `ProviderCostStructure` → `schema.prisma:L6274`
- `ProviderEventLog` → `schema.prisma:L6009`
- `PurchaseOrder` → `schema.prisma:L2355`
- `PurchaseOrderInvoice` → `schema.prisma:L2500`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2557`
- `PurchaseOrderItem` → `schema.prisma:L2413`
- `RateCorrectionBatch` → `schema.prisma:L6499`
- `RateCorrectionEntry` → `schema.prisma:L6541`
- `RawMaterial` → `schema.prisma:L2112`
- `RawMaterialMovement` → `schema.prisma:L2683`
- `RawMaterialPresentation` → `schema.prisma:L2187`
- `ReceiptLayout` → `schema.prisma:L17570`
- `Recipe` → `schema.prisma:L2207`
- `RecipeLine` → `schema.prisma:L2231`
- `Referral` → `schema.prisma:L7768`
- `ReferralProgramConfig` → `schema.prisma:L7733`
- `ReferralRewardGrant` → `schema.prisma:L7859`
- `ReferralTierReward` → `schema.prisma:L7831`
- `ReferralTierUnlock` → `schema.prisma:L7904`
- `RefreshGrant` → `schema.prisma:L17515`
- `Reservation` → `schema.prisma:L13294`
- `ReservationGoogleEventMapping` → `schema.prisma:L14064`
- `ReservationModifier` → `schema.prisma:L13474`
- `ReservationReminderSent` → `schema.prisma:L13457`
- `ReservationSettings` → `schema.prisma:L13688`
- `ReservationWaitlistEntry` → `schema.prisma:L13656`
- `Review` → `schema.prisma:L4687`
- `SalesRetention` → `schema.prisma:L16490`
- `SaleVerification` → `schema.prisma:L4446`
- `ScaleProfile` → `schema.prisma:L15375`
- `ScheduledCommand` → `schema.prisma:L10125`
- `SerializedItem` → `schema.prisma:L11775`
- `SerializedItemCustodyEvent` → `schema.prisma:L11942`
- `ServiceCharge` → `schema.prisma:L8368`
- `Session` → `schema.prisma:L17494`
- `SettlementConfiguration` → `schema.prisma:L6574`
- `SettlementConfirmation` → `schema.prisma:L6687`
- `SettlementIncident` → `schema.prisma:L6638`
- `SettlementSimulation` → `schema.prisma:L6609`
- `Shift` → `schema.prisma:L3178`
- `SimRegistrationRequest` → `schema.prisma:L11980`
- `SimRegistrationRequestItem` → `schema.prisma:L12002`
- `SlotHold` → `schema.prisma:L13557`
- `Staff` → `schema.prisma:L960`
- `StaffDocument` → `schema.prisma:L3426`
- `StaffOnboardingState` → `schema.prisma:L15705`
- `StaffOrganization` → `schema.prisma:L1292`
- `StaffPasskey` → `schema.prisma:L1319`
- `StaffSchedule` → `schema.prisma:L13497`
- `StaffScheduleException` → `schema.prisma:L13509`
- `StaffVenue` → `schema.prisma:L1216`
- `StaffWorkSchedule` → `schema.prisma:L3303`
- `StaffWorkScheduleException` → `schema.prisma:L3401`
- `StampCard` → `schema.prisma:L7616`
- `StampEvent` → `schema.prisma:L7655`
- `StampReward` → `schema.prisma:L7693`
- `StockAlertConfig` → `schema.prisma:L12633`
- `StockBatch` → `schema.prisma:L2841`
- `StockCount` → `schema.prisma:L2758`
- `StockCountItem` → `schema.prisma:L2786`
- `StripeWebhookEvent` → `schema.prisma:L6221`
- `Supplier` → `schema.prisma:L2266`
- `SupplierItemCode` → `schema.prisma:L2598`
- `SupplierPricing` → `schema.prisma:L2321`
- `Table` → `schema.prisma:L3090`
- `Terminal` → `schema.prisma:L4738`
- `TerminalHealth` → `schema.prisma:L4989`
- `TerminalLog` → `schema.prisma:L4963`
- `TerminalOrder` → `schema.prisma:L5188`
- `TerminalOrderItem` → `schema.prisma:L5263`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5141`
- `TerminalPaymentRequest` → `schema.prisma:L5060`
- `TimeEntry` → `schema.prisma:L3468`
- `TimeEntryBreak` → `schema.prisma:L3537`
- `TokenPurchase` → `schema.prisma:L9799`
- `TokenUsageRecord` → `schema.prisma:L9771`
- `TpvCommandHistory` → `schema.prisma:L10031`
- `TpvCommandQueue` → `schema.prisma:L9971`
- `TpvFeedback` → `schema.prisma:L9684`
- `TpvMessage` → `schema.prisma:L12990`
- `TpvMessageDelivery` → `schema.prisma:L13042`
- `TpvMessageResponse` → `schema.prisma:L13065`
- `TrainingModule` → `schema.prisma:L13120`
- `TrainingProgress` → `schema.prisma:L13197`
- `TrainingQuizQuestion` → `schema.prisma:L13179`
- `TrainingStep` → `schema.prisma:L13159`
- `TransactionCost` → `schema.prisma:L6437`
- `UnitConversion` → `schema.prisma:L2661`
- `UpsellAcceptance` → `schema.prisma:L8189`
- `UpsellAiRun` → `schema.prisma:L8209`
- `UpsellImpression` → `schema.prisma:L8149`
- `UpsellRule` → `schema.prisma:L8069`
- `user_sessions` → `schema.prisma:L5765`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L15112`
- `VenueChatMessage` → `schema.prisma:L790`
- `VenueChatSession` → `schema.prisma:L745`
- `VenueCommission` → `schema.prisma:L14758`
- `VenueCreditAssessment` → `schema.prisma:L10513`
- `VenueCryptoConfig` → `schema.prisma:L12857`
- `VenueFeature` → `schema.prisma:L4560`
- `VenueModule` → `schema.prisma:L10673`
- `VenuePaymentConfig` → `schema.prisma:L5866`
- `VenuePaymentLinkSettings` → `schema.prisma:L14097`
- `VenuePricingStructure` → `schema.prisma:L6377`
- `VenueRoleConfig` → `schema.prisma:L1445`
- `VenueRolePermission` → `schema.prisma:L1349`
- `VenueScaleSettings` → `schema.prisma:L15363`
- `VenueSettings` → `schema.prisma:L830`
- `VenueTenderType` → `schema.prisma:L4305`
- `VenueTenderTypeRevision` → `schema.prisma:L4370`
- `VenueTransaction` → `schema.prisma:L4497`
- `VenueWhatsappActivation` → `schema.prisma:L681`
- `WalletCardDesign` → `schema.prisma:L7534`
- `WalletPass` → `schema.prisma:L7435`
- `WalletPassRegistration` → `schema.prisma:L7501`
- `WebhookEvent` → `schema.prisma:L4596`
- `WebhookSubscription` → `schema.prisma:L5982`
- `WhatsappContactWindow` → `schema.prisma:L699`
- `WhatsappInboundEvent` → `schema.prisma:L719`
- `WorkShiftAssignment` → `schema.prisma:L3343`
- `WorkShiftTemplate` → `schema.prisma:L3320`
- `Zone` → `schema.prisma:L142`
