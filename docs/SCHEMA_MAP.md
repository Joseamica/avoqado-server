# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **356 models / 339 enums / ~17,000 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                            |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                        |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L15877`
- `AccountMapping` → `schema.prisma:L15773`
- `ActivityLog` → `schema.prisma:L6666`
- `Aggregator` → `schema.prisma:L14174`
- `AngelPayUserAccount` → `schema.prisma:L5329`
- `AppUpdate` → `schema.prisma:L12354`
- `Area` → `schema.prisma:L3022`
- `AreaTicket` → `schema.prisma:L14668`
- `AreaTicketCheckoutSession` → `schema.prisma:L14790`
- `AreaTicketExternalIncident` → `schema.prisma:L15037`
- `AreaTicketExternalSettlement` → `schema.prisma:L15002`
- `AreaTicketFulfillment` → `schema.prisma:L14866`
- `AreaTicketInventoryReservation` → `schema.prisma:L14761`
- `AreaTicketLine` → `schema.prisma:L14729`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14822`
- `AreaTicketPrintAttempt` → `schema.prisma:L14845`
- `BankStatement` → `schema.prisma:L15647`
- `BankStatementLine` → `schema.prisma:L15668`
- `BillingTaxProfile` → `schema.prisma:L16457`
- `BulkCommandOperation` → `schema.prisma:L9637`
- `CalendarSyncOutbox` → `schema.prisma:L13561`
- `CampaignDelivery` → `schema.prisma:L12512`
- `CashCloseout` → `schema.prisma:L10022`
- `CashDeposit` → `schema.prisma:L12156`
- `CashDrawerEvent` → `schema.prisma:L14011`
- `CashDrawerSession` → `schema.prisma:L13987`
- `CashOutCommissionRate` → `schema.prisma:L16286`
- `CashOutScheduleDay` → `schema.prisma:L16309`
- `CashOutWithdrawal` → `schema.prisma:L16371`
- `CatalogBindingBatch` → `schema.prisma:L11053`
- `CatalogBindingLine` → `schema.prisma:L11089`
- `CatalogBrand` → `schema.prisma:L10506`
- `CatalogClientObservation` → `schema.prisma:L10819`
- `CatalogClientReadinessOverride` → `schema.prisma:L10838`
- `CatalogFamily` → `schema.prisma:L10556`
- `CatalogIdempotencyRecord` → `schema.prisma:L10952`
- `CatalogIdentifier` → `schema.prisma:L10687`
- `CatalogImportBatch` → `schema.prisma:L10995`
- `CatalogImportLine` → `schema.prisma:L11032`
- `CatalogItem` → `schema.prisma:L10589`
- `CatalogItemBusinessType` → `schema.prisma:L10649`
- `CatalogItemPrice` → `schema.prisma:L10737`
- `CatalogManufacturer` → `schema.prisma:L10530`
- `CatalogProductTypeMapping` → `schema.prisma:L10666`
- `CatalogPublicationBatch` → `schema.prisma:L11117`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11211`
- `CatalogPublicationLine` → `schema.prisma:L11158`
- `CatalogPublicationOutbox` → `schema.prisma:L11254`
- `CatalogValidationProfile` → `schema.prisma:L10708`
- `CatalogVenueBinding` → `schema.prisma:L10866`
- `CatalogVenueClientRequirement` → `schema.prisma:L10793`
- `CatalogVenueEventSequence` → `schema.prisma:L11237`
- `CatalogVenueOverride` → `schema.prisma:L10908`
- `CatalogVenueRollout` → `schema.prisma:L10768`
- `Cfdi` → `schema.prisma:L15550`
- `ChatbotTokenBudget` → `schema.prisma:L9285`
- `ChatConversation` → `schema.prisma:L9140`
- `ChatFeedback` → `schema.prisma:L9226`
- `ChatLearningEvent` → `schema.prisma:L9183`
- `ChatMessage` → `schema.prisma:L9163`
- `ChatTrainingData` → `schema.prisma:L9097`
- `CheckoutSession` → `schema.prisma:L5609`
- `ClassSession` → `schema.prisma:L13165`
- `CommissionCalculation` → `schema.prisma:L11932`
- `CommissionClawback` → `schema.prisma:L12108`
- `CommissionConfig` → `schema.prisma:L11698`
- `CommissionMilestone` → `schema.prisma:L11848`
- `CommissionOverride` → `schema.prisma:L11775`
- `CommissionPayout` → `schema.prisma:L12059`
- `CommissionSummary` → `schema.prisma:L11998`
- `CommissionTier` → `schema.prisma:L11812`
- `Consumer` → `schema.prisma:L6828`
- `ConsumerAuthAccount` → `schema.prisma:L6853`
- `CouponCode` → `schema.prisma:L7792`
- `CouponRedemption` → `schema.prisma:L7823`
- `CreditAssessmentHistory` → `schema.prisma:L10131`
- `CreditItemBalance` → `schema.prisma:L13777`
- `CreditOffer` → `schema.prisma:L10150`
- `CreditPack` → `schema.prisma:L13686`
- `CreditPackItem` → `schema.prisma:L13715`
- `CreditPackPurchase` → `schema.prisma:L13732`
- `CreditTransaction` → `schema.prisma:L13799`
- `Customer` → `schema.prisma:L6707`
- `CustomerApprovalDelivery` → `schema.prisma:L8799`
- `CustomerApprovalOutbox` → `schema.prisma:L8774`
- `CustomerDiscount` → `schema.prisma:L7843`
- `CustomerGroup` → `schema.prisma:L6892`
- `CustomerTaxProfile` → `schema.prisma:L15619`
- `DeliveryActivationRequest` → `schema.prisma:L5950`
- `DeliveryChannelLink` → `schema.prisma:L5895`
- `DeliveryOrderEvent` → `schema.prisma:L5974`
- `DeviceToken` → `schema.prisma:L8112`
- `DigitalReceipt` → `schema.prisma:L4312`
- `Discount` → `schema.prisma:L7482`
- `EcommerceMerchant` → `schema.prisma:L5421`
- `EmailTemplate` → `schema.prisma:L12451`
- `Employee` → `schema.prisma:L16134`
- `Estimate` → `schema.prisma:L14081`
- `EstimateItem` → `schema.prisma:L14109`
- `Expense` → `schema.prisma:L15921`
- `ExternalBusyBlock` → `schema.prisma:L13454`
- `Feature` → `schema.prisma:L4441`
- `FeeSchedule` → `schema.prisma:L4519`
- `FeeTier` → `schema.prisma:L4530`
- `FinancialAccount` → `schema.prisma:L14271`
- `FinancialConnection` → `schema.prisma:L14240`
- `FinancialProvider` → `schema.prisma:L14226`
- `FiscalEmisor` → `schema.prisma:L15473`
- `FiscalLossCarryforward` → `schema.prisma:L16044`
- `FixedAsset` → `schema.prisma:L16062`
- `FixedAssetDepreciation` → `schema.prisma:L16091`
- `FloorElement` → `schema.prisma:L3098`
- `FulfillmentArea` → `schema.prisma:L14533`
- `GeofenceRule` → `schema.prisma:L9722`
- `GoogleCalendarChannel` → `schema.prisma:L13431`
- `GoogleCalendarConnection` → `schema.prisma:L13383`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13484`
- `GoogleOAuthSession` → `schema.prisma:L13506`
- `HolidayCalendar` → `schema.prisma:L6590`
- `IdempotencyRequest` → `schema.prisma:L11573`
- `InterVenueTransfer` → `schema.prisma:L2850`
- `InterVenueTransferAllocation` → `schema.prisma:L2933`
- `InterVenueTransferItem` → `schema.prisma:L2902`
- `InterVenueTransferReceipt` → `schema.prisma:L2960`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2976`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3004`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2988`
- `Inventory` → `schema.prisma:L1896`
- `InventoryMovement` → `schema.prisma:L1923`
- `InventoryPosting` → `schema.prisma:L2005`
- `InventoryPostingLine` → `schema.prisma:L2045`
- `InventoryTransfer` → `schema.prisma:L14053`
- `Invitation` → `schema.prisma:L1434`
- `Invoice` → `schema.prisma:L4542`
- `InvoiceItem` → `schema.prisma:L4568`
- `ItemCategory` → `schema.prisma:L11289`
- `JournalEntry` → `schema.prisma:L15831`
- `JournalLine` → `schema.prisma:L15859`
- `KdsOrder` → `schema.prisma:L14319`
- `KdsOrderItem` → `schema.prisma:L14360`
- `KioskCheckInAttempt` → `schema.prisma:L16780`
- `KioskCheckInChallenge` → `schema.prisma:L16734`
- `KioskOutreachOutbox` → `schema.prisma:L16801`
- `LearnedPatterns` → `schema.prisma:L9207`
- `LedgerAccount` → `schema.prisma:L15723`
- `LiveDemoSession` → `schema.prisma:L785`
- `LowStockAlert` → `schema.prisma:L2691`
- `LoyaltyConfig` → `schema.prisma:L6922`
- `LoyaltyTransaction` → `schema.prisma:L6965`
- `MarketingCampaign` → `schema.prisma:L12469`
- `McpAuthCode` → `schema.prisma:L15356`
- `McpOAuthClient` → `schema.prisma:L15340`
- `McpRefreshToken` → `schema.prisma:L15374`
- `McpToolCall` → `schema.prisma:L15395`
- `MeasurementUnit` → `schema.prisma:L14159`
- `Menu` → `schema.prisma:L1620`
- `MenuCategory` → `schema.prisma:L1557`
- `MenuCategoryAssignment` → `schema.prisma:L1655`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15270`
- `MerchantAccount` → `schema.prisma:L5159`
- `MerchantFiscalConfig` → `schema.prisma:L15521`
- `MerchantRevenueShare` → `schema.prisma:L6170`
- `MerchantRoutingRule` → `schema.prisma:L5281`
- `MilestoneAchievement` → `schema.prisma:L11893`
- `Modifier` → `schema.prisma:L3927`
- `ModifierGroup` → `schema.prisma:L3891`
- `Module` → `schema.prisma:L10198`
- `MoneyAnomaly` → `schema.prisma:L6073`
- `MonthlyVenueProfit` → `schema.prisma:L6616`
- `Notification` → `schema.prisma:L8014`
- `NotificationPreference` → `schema.prisma:L8061`
- `NotificationTemplate` → `schema.prisma:L8088`
- `OAuthState` → `schema.prisma:L1485`
- `OnboardingProgress` → `schema.prisma:L1503`
- `Order` → `schema.prisma:L3529`
- `OrderAction` → `schema.prisma:L3992`
- `OrderCustomer` → `schema.prisma:L3742`
- `OrderDiscount` → `schema.prisma:L7875`
- `OrderFulfillment` → `schema.prisma:L14588`
- `OrderFulfillmentLine` → `schema.prisma:L14619`
- `OrderItem` → `schema.prisma:L3758`
- `OrderItemModifier` → `schema.prisma:L3976`
- `OrderPromotion` → `schema.prisma:L16697`
- `OrderServiceCharge` → `schema.prisma:L7959`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12270`
- `OrganizationEntitlement` → `schema.prisma:L10481`
- `OrganizationGoal` → `schema.prisma:L12228`
- `OrganizationModule` → `schema.prisma:L10258`
- `OrganizationPaymentConfig` → `schema.prisma:L5733`
- `OrganizationPayoutConfig` → `schema.prisma:L12303`
- `OrganizationPricingStructure` → `schema.prisma:L5765`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12251`
- `OtpChallenge` → `schema.prisma:L6872`
- `OvertimeApproval` → `schema.prisma:L3307`
- `PartnerAPIKey` → `schema.prisma:L5563`
- `Payment` → `schema.prisma:L4025`
- `PaymentAllocation` → `schema.prisma:L4291`
- `PaymentLink` → `schema.prisma:L13845`
- `PaymentLinkAttribution` → `schema.prisma:L13953`
- `PaymentLinkItem` → `schema.prisma:L13908`
- `PaymentLinkItemModifier` → `schema.prisma:L13935`
- `PaymentProvider` → `schema.prisma:L5118`
- `PayrollLine` → `schema.prisma:L16205`
- `PayrollRun` → `schema.prisma:L16174`
- `PerformanceGoal` → `schema.prisma:L12205`
- `PermissionOverride` → `schema.prisma:L1362`
- `PermissionSet` → `schema.prisma:L1385`
- `PlatformAnnouncement` → `schema.prisma:L16861`
- `PlatformAnnouncementClick` → `schema.prisma:L16926`
- `PlatformAnnouncementDelivery` → `schema.prisma:L16963`
- `PlatformCfdi` → `schema.prisma:L16490`
- `PlatformEmisor` → `schema.prisma:L16430`
- `PlatformSettings` → `schema.prisma:L5540`
- `PosCommand` → `schema.prisma:L8142`
- `PosConnectionStatus` → `schema.prisma:L911`
- `PosSyncIntent` → `schema.prisma:L16568`
- `PricingPolicy` → `schema.prisma:L2595`
- `Printer` → `schema.prisma:L14402`
- `PrintGateway` → `schema.prisma:L14455`
- `PrintJob` → `schema.prisma:L15169`
- `PrintStation` → `schema.prisma:L14473`
- `ProcessedStripeEvent` → `schema.prisma:L6059`
- `ProcessorReliabilityMetric` → `schema.prisma:L6544`
- `Product` → `schema.prisma:L1673`
- `ProductModifierGroup` → `schema.prisma:L3964`
- `ProductOption` → `schema.prisma:L14136`
- `ProductOptionValue` → `schema.prisma:L14147`
- `ProductStaff` → `schema.prisma:L13080`
- `PromoterBankAccount` → `schema.prisma:L16325`
- `PromoterCommissionEntry` → `schema.prisma:L16344`
- `PromoterLocationPing` → `schema.prisma:L3495`
- `Promotion` → `schema.prisma:L16619`
- `PromotionGroup` → `schema.prisma:L16658`
- `PromotionOption` → `schema.prisma:L16674`
- `ProviderCostStructure` → `schema.prisma:L6095`
- `ProviderEventLog` → `schema.prisma:L5842`
- `PurchaseOrder` → `schema.prisma:L2320`
- `PurchaseOrderInvoice` → `schema.prisma:L2465`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2522`
- `PurchaseOrderItem` → `schema.prisma:L2378`
- `RateCorrectionBatch` → `schema.prisma:L6320`
- `RateCorrectionEntry` → `schema.prisma:L6362`
- `RawMaterial` → `schema.prisma:L2077`
- `RawMaterialMovement` → `schema.prisma:L2648`
- `RawMaterialPresentation` → `schema.prisma:L2152`
- `Recipe` → `schema.prisma:L2172`
- `RecipeLine` → `schema.prisma:L2196`
- `Referral` → `schema.prisma:L7330`
- `ReferralProgramConfig` → `schema.prisma:L7295`
- `ReferralRewardGrant` → `schema.prisma:L7421`
- `ReferralTierReward` → `schema.prisma:L7393`
- `ReferralTierUnlock` → `schema.prisma:L7466`
- `RefreshGrant` → `schema.prisma:L17050`
- `Reservation` → `schema.prisma:L12848`
- `ReservationGoogleEventMapping` → `schema.prisma:L13618`
- `ReservationModifier` → `schema.prisma:L13028`
- `ReservationReminderSent` → `schema.prisma:L13011`
- `ReservationSettings` → `schema.prisma:L13242`
- `ReservationWaitlistEntry` → `schema.prisma:L13210`
- `Review` → `schema.prisma:L4586`
- `SalesRetention` → `schema.prisma:L16025`
- `SaleVerification` → `schema.prisma:L4345`
- `ScaleProfile` → `schema.prisma:L14910`
- `ScheduledCommand` → `schema.prisma:L9682`
- `SerializedItem` → `schema.prisma:L11332`
- `SerializedItemCustodyEvent` → `schema.prisma:L11496`
- `ServiceCharge` → `schema.prisma:L7930`
- `Session` → `schema.prisma:L17029`
- `SettlementConfiguration` → `schema.prisma:L6395`
- `SettlementConfirmation` → `schema.prisma:L6508`
- `SettlementIncident` → `schema.prisma:L6459`
- `SettlementSimulation` → `schema.prisma:L6430`
- `Shift` → `schema.prisma:L3136`
- `SimRegistrationRequest` → `schema.prisma:L11534`
- `SimRegistrationRequestItem` → `schema.prisma:L11556`
- `SlotHold` → `schema.prisma:L13111`
- `Staff` → `schema.prisma:L931`
- `StaffDocument` → `schema.prisma:L3366`
- `StaffOnboardingState` → `schema.prisma:L15240`
- `StaffOrganization` → `schema.prisma:L1261`
- `StaffPasskey` → `schema.prisma:L1288`
- `StaffSchedule` → `schema.prisma:L13051`
- `StaffScheduleException` → `schema.prisma:L13063`
- `StaffVenue` → `schema.prisma:L1185`
- `StaffWorkSchedule` → `schema.prisma:L3243`
- `StaffWorkScheduleException` → `schema.prisma:L3341`
- `StampCard` → `schema.prisma:L7178`
- `StampEvent` → `schema.prisma:L7217`
- `StampReward` → `schema.prisma:L7255`
- `StockAlertConfig` → `schema.prisma:L12187`
- `StockBatch` → `schema.prisma:L2799`
- `StockCount` → `schema.prisma:L2723`
- `StockCountItem` → `schema.prisma:L2747`
- `StripeWebhookEvent` → `schema.prisma:L6042`
- `Supplier` → `schema.prisma:L2231`
- `SupplierItemCode` → `schema.prisma:L2563`
- `SupplierPricing` → `schema.prisma:L2286`
- `Table` → `schema.prisma:L3048`
- `Terminal` → `schema.prisma:L4637`
- `TerminalHealth` → `schema.prisma:L4888`
- `TerminalLog` → `schema.prisma:L4862`
- `TerminalOrder` → `schema.prisma:L5021`
- `TerminalOrderItem` → `schema.prisma:L5096`
- `TerminalPaymentRequest` → `schema.prisma:L4959`
- `TimeEntry` → `schema.prisma:L3408`
- `TimeEntryBreak` → `schema.prisma:L3477`
- `TokenPurchase` → `schema.prisma:L9356`
- `TokenUsageRecord` → `schema.prisma:L9328`
- `TpvCommandHistory` → `schema.prisma:L9588`
- `TpvCommandQueue` → `schema.prisma:L9528`
- `TpvFeedback` → `schema.prisma:L9241`
- `TpvMessage` → `schema.prisma:L12544`
- `TpvMessageDelivery` → `schema.prisma:L12596`
- `TpvMessageResponse` → `schema.prisma:L12619`
- `TrainingModule` → `schema.prisma:L12674`
- `TrainingProgress` → `schema.prisma:L12751`
- `TrainingQuizQuestion` → `schema.prisma:L12733`
- `TrainingStep` → `schema.prisma:L12713`
- `TransactionCost` → `schema.prisma:L6258`
- `UnitConversion` → `schema.prisma:L2626`
- `UpsellAcceptance` → `schema.prisma:L7751`
- `UpsellAiRun` → `schema.prisma:L7771`
- `UpsellImpression` → `schema.prisma:L7711`
- `UpsellRule` → `schema.prisma:L7631`
- `user_sessions` → `schema.prisma:L5598`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14647`
- `VenueChatMessage` → `schema.prisma:L761`
- `VenueChatSession` → `schema.prisma:L716`
- `VenueCommission` → `schema.prisma:L14297`
- `VenueCreditAssessment` → `schema.prisma:L10070`
- `VenueCryptoConfig` → `schema.prisma:L12411`
- `VenueFeature` → `schema.prisma:L4459`
- `VenueModule` → `schema.prisma:L10230`
- `VenuePaymentConfig` → `schema.prisma:L5699`
- `VenuePaymentLinkSettings` → `schema.prisma:L13651`
- `VenuePricingStructure` → `schema.prisma:L6198`
- `VenueRoleConfig` → `schema.prisma:L1414`
- `VenueRolePermission` → `schema.prisma:L1318`
- `VenueScaleSettings` → `schema.prisma:L14898`
- `VenueSettings` → `schema.prisma:L801`
- `VenueTenderType` → `schema.prisma:L4204`
- `VenueTenderTypeRevision` → `schema.prisma:L4269`
- `VenueTransaction` → `schema.prisma:L4396`
- `VenueWhatsappActivation` → `schema.prisma:L652`
- `WalletCardDesign` → `schema.prisma:L7096`
- `WalletPass` → `schema.prisma:L7005`
- `WalletPassRegistration` → `schema.prisma:L7063`
- `WebhookEvent` → `schema.prisma:L4495`
- `WebhookSubscription` → `schema.prisma:L5815`
- `WhatsappContactWindow` → `schema.prisma:L670`
- `WhatsappInboundEvent` → `schema.prisma:L690`
- `WorkShiftAssignment` → `schema.prisma:L3283`
- `WorkShiftTemplate` → `schema.prisma:L3260`
- `Zone` → `schema.prisma:L142`
