# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **340 models / 332 enums / ~16,300 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                            |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                          |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                           |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                           |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletPass`                                                                                                                                                                                                                                                                                                                    |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                        |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L15340`
- `AccountMapping` → `schema.prisma:L15236`
- `ActivityLog` → `schema.prisma:L6417`
- `Aggregator` → `schema.prisma:L13637`
- `AngelPayUserAccount` → `schema.prisma:L5080`
- `AppUpdate` → `schema.prisma:L11817`
- `Area` → `schema.prisma:L2924`
- `AreaTicket` → `schema.prisma:L14131`
- `AreaTicketCheckoutSession` → `schema.prisma:L14253`
- `AreaTicketExternalIncident` → `schema.prisma:L14500`
- `AreaTicketExternalSettlement` → `schema.prisma:L14465`
- `AreaTicketFulfillment` → `schema.prisma:L14329`
- `AreaTicketInventoryReservation` → `schema.prisma:L14224`
- `AreaTicketLine` → `schema.prisma:L14192`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14285`
- `AreaTicketPrintAttempt` → `schema.prisma:L14308`
- `BankStatement` → `schema.prisma:L15110`
- `BankStatementLine` → `schema.prisma:L15131`
- `BillingTaxProfile` → `schema.prisma:L15920`
- `BulkCommandOperation` → `schema.prisma:L9115`
- `CalendarSyncOutbox` → `schema.prisma:L13024`
- `CampaignDelivery` → `schema.prisma:L11975`
- `CashCloseout` → `schema.prisma:L9495`
- `CashDeposit` → `schema.prisma:L11619`
- `CashDrawerEvent` → `schema.prisma:L13474`
- `CashDrawerSession` → `schema.prisma:L13450`
- `CashOutCommissionRate` → `schema.prisma:L15749`
- `CashOutScheduleDay` → `schema.prisma:L15772`
- `CashOutWithdrawal` → `schema.prisma:L15834`
- `CatalogBindingBatch` → `schema.prisma:L10526`
- `CatalogBindingLine` → `schema.prisma:L10562`
- `CatalogBrand` → `schema.prisma:L9979`
- `CatalogClientObservation` → `schema.prisma:L10292`
- `CatalogClientReadinessOverride` → `schema.prisma:L10311`
- `CatalogFamily` → `schema.prisma:L10029`
- `CatalogIdempotencyRecord` → `schema.prisma:L10425`
- `CatalogIdentifier` → `schema.prisma:L10160`
- `CatalogImportBatch` → `schema.prisma:L10468`
- `CatalogImportLine` → `schema.prisma:L10505`
- `CatalogItem` → `schema.prisma:L10062`
- `CatalogItemBusinessType` → `schema.prisma:L10122`
- `CatalogItemPrice` → `schema.prisma:L10210`
- `CatalogManufacturer` → `schema.prisma:L10003`
- `CatalogProductTypeMapping` → `schema.prisma:L10139`
- `CatalogPublicationBatch` → `schema.prisma:L10590`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10684`
- `CatalogPublicationLine` → `schema.prisma:L10631`
- `CatalogPublicationOutbox` → `schema.prisma:L10727`
- `CatalogValidationProfile` → `schema.prisma:L10181`
- `CatalogVenueBinding` → `schema.prisma:L10339`
- `CatalogVenueClientRequirement` → `schema.prisma:L10266`
- `CatalogVenueEventSequence` → `schema.prisma:L10710`
- `CatalogVenueOverride` → `schema.prisma:L10381`
- `CatalogVenueRollout` → `schema.prisma:L10241`
- `Cfdi` → `schema.prisma:L15013`
- `ChatbotTokenBudget` → `schema.prisma:L8763`
- `ChatConversation` → `schema.prisma:L8618`
- `ChatFeedback` → `schema.prisma:L8704`
- `ChatLearningEvent` → `schema.prisma:L8661`
- `ChatMessage` → `schema.prisma:L8641`
- `ChatTrainingData` → `schema.prisma:L8575`
- `CheckoutSession` → `schema.prisma:L5360`
- `ClassSession` → `schema.prisma:L12628`
- `CommissionCalculation` → `schema.prisma:L11398`
- `CommissionClawback` → `schema.prisma:L11571`
- `CommissionConfig` → `schema.prisma:L11171`
- `CommissionMilestone` → `schema.prisma:L11314`
- `CommissionOverride` → `schema.prisma:L11241`
- `CommissionPayout` → `schema.prisma:L11522`
- `CommissionSummary` → `schema.prisma:L11461`
- `CommissionTier` → `schema.prisma:L11278`
- `Consumer` → `schema.prisma:L6577`
- `ConsumerAuthAccount` → `schema.prisma:L6602`
- `CouponCode` → `schema.prisma:L7273`
- `CouponRedemption` → `schema.prisma:L7304`
- `CreditAssessmentHistory` → `schema.prisma:L9604`
- `CreditItemBalance` → `schema.prisma:L13240`
- `CreditOffer` → `schema.prisma:L9623`
- `CreditPack` → `schema.prisma:L13149`
- `CreditPackItem` → `schema.prisma:L13178`
- `CreditPackPurchase` → `schema.prisma:L13195`
- `CreditTransaction` → `schema.prisma:L13262`
- `Customer` → `schema.prisma:L6458`
- `CustomerApprovalDelivery` → `schema.prisma:L8280`
- `CustomerApprovalOutbox` → `schema.prisma:L8255`
- `CustomerDiscount` → `schema.prisma:L7324`
- `CustomerGroup` → `schema.prisma:L6641`
- `CustomerTaxProfile` → `schema.prisma:L15082`
- `DeliveryActivationRequest` → `schema.prisma:L5701`
- `DeliveryChannelLink` → `schema.prisma:L5646`
- `DeliveryOrderEvent` → `schema.prisma:L5725`
- `DeviceToken` → `schema.prisma:L7593`
- `DigitalReceipt` → `schema.prisma:L4075`
- `Discount` → `schema.prisma:L6963`
- `EcommerceMerchant` → `schema.prisma:L5172`
- `EmailTemplate` → `schema.prisma:L11914`
- `Employee` → `schema.prisma:L15597`
- `Estimate` → `schema.prisma:L13544`
- `EstimateItem` → `schema.prisma:L13572`
- `Expense` → `schema.prisma:L15384`
- `ExternalBusyBlock` → `schema.prisma:L12917`
- `Feature` → `schema.prisma:L4204`
- `FeeSchedule` → `schema.prisma:L4282`
- `FeeTier` → `schema.prisma:L4293`
- `FinancialAccount` → `schema.prisma:L13734`
- `FinancialConnection` → `schema.prisma:L13703`
- `FinancialProvider` → `schema.prisma:L13689`
- `FiscalEmisor` → `schema.prisma:L14936`
- `FiscalLossCarryforward` → `schema.prisma:L15507`
- `FixedAsset` → `schema.prisma:L15525`
- `FixedAssetDepreciation` → `schema.prisma:L15554`
- `FloorElement` → `schema.prisma:L3000`
- `FulfillmentArea` → `schema.prisma:L13996`
- `GeofenceRule` → `schema.prisma:L9200`
- `GoogleCalendarChannel` → `schema.prisma:L12894`
- `GoogleCalendarConnection` → `schema.prisma:L12846`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12947`
- `GoogleOAuthSession` → `schema.prisma:L12969`
- `HolidayCalendar` → `schema.prisma:L6341`
- `IdempotencyRequest` → `schema.prisma:L11046`
- `InterVenueTransfer` → `schema.prisma:L2752`
- `InterVenueTransferAllocation` → `schema.prisma:L2835`
- `InterVenueTransferItem` → `schema.prisma:L2804`
- `InterVenueTransferReceipt` → `schema.prisma:L2862`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2878`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2906`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2890`
- `Inventory` → `schema.prisma:L1846`
- `InventoryMovement` → `schema.prisma:L1873`
- `InventoryPosting` → `schema.prisma:L1955`
- `InventoryPostingLine` → `schema.prisma:L1995`
- `InventoryTransfer` → `schema.prisma:L13516`
- `Invitation` → `schema.prisma:L1386`
- `Invoice` → `schema.prisma:L4305`
- `InvoiceItem` → `schema.prisma:L4331`
- `ItemCategory` → `schema.prisma:L10762`
- `JournalEntry` → `schema.prisma:L15294`
- `JournalLine` → `schema.prisma:L15322`
- `KdsOrder` → `schema.prisma:L13782`
- `KdsOrderItem` → `schema.prisma:L13823`
- `KioskCheckInAttempt` → `schema.prisma:L16243`
- `KioskCheckInChallenge` → `schema.prisma:L16197`
- `KioskOutreachOutbox` → `schema.prisma:L16264`
- `LearnedPatterns` → `schema.prisma:L8685`
- `LedgerAccount` → `schema.prisma:L15186`
- `LiveDemoSession` → `schema.prisma:L779`
- `LowStockAlert` → `schema.prisma:L2593`
- `LoyaltyConfig` → `schema.prisma:L6671`
- `LoyaltyTransaction` → `schema.prisma:L6694`
- `MarketingCampaign` → `schema.prisma:L11932`
- `McpAuthCode` → `schema.prisma:L14819`
- `McpOAuthClient` → `schema.prisma:L14803`
- `McpRefreshToken` → `schema.prisma:L14837`
- `McpToolCall` → `schema.prisma:L14858`
- `MeasurementUnit` → `schema.prisma:L13622`
- `Menu` → `schema.prisma:L1572`
- `MenuCategory` → `schema.prisma:L1509`
- `MenuCategoryAssignment` → `schema.prisma:L1607`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14733`
- `MerchantAccount` → `schema.prisma:L4910`
- `MerchantFiscalConfig` → `schema.prisma:L14984`
- `MerchantRevenueShare` → `schema.prisma:L5921`
- `MerchantRoutingRule` → `schema.prisma:L5032`
- `MilestoneAchievement` → `schema.prisma:L11359`
- `Modifier` → `schema.prisma:L3690`
- `ModifierGroup` → `schema.prisma:L3654`
- `Module` → `schema.prisma:L9671`
- `MoneyAnomaly` → `schema.prisma:L5824`
- `MonthlyVenueProfit` → `schema.prisma:L6367`
- `Notification` → `schema.prisma:L7495`
- `NotificationPreference` → `schema.prisma:L7542`
- `NotificationTemplate` → `schema.prisma:L7569`
- `OAuthState` → `schema.prisma:L1437`
- `OnboardingProgress` → `schema.prisma:L1455`
- `Order` → `schema.prisma:L3293`
- `OrderAction` → `schema.prisma:L3755`
- `OrderCustomer` → `schema.prisma:L3505`
- `OrderDiscount` → `schema.prisma:L7356`
- `OrderFulfillment` → `schema.prisma:L14051`
- `OrderFulfillmentLine` → `schema.prisma:L14082`
- `OrderItem` → `schema.prisma:L3521`
- `OrderItemModifier` → `schema.prisma:L3739`
- `OrderPromotion` → `schema.prisma:L16160`
- `OrderServiceCharge` → `schema.prisma:L7440`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11733`
- `OrganizationEntitlement` → `schema.prisma:L9954`
- `OrganizationGoal` → `schema.prisma:L11691`
- `OrganizationModule` → `schema.prisma:L9731`
- `OrganizationPaymentConfig` → `schema.prisma:L5484`
- `OrganizationPayoutConfig` → `schema.prisma:L11766`
- `OrganizationPricingStructure` → `schema.prisma:L5516`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11714`
- `OtpChallenge` → `schema.prisma:L6621`
- `PartnerAPIKey` → `schema.prisma:L5314`
- `Payment` → `schema.prisma:L3788`
- `PaymentAllocation` → `schema.prisma:L4054`
- `PaymentLink` → `schema.prisma:L13308`
- `PaymentLinkAttribution` → `schema.prisma:L13416`
- `PaymentLinkItem` → `schema.prisma:L13371`
- `PaymentLinkItemModifier` → `schema.prisma:L13398`
- `PaymentProvider` → `schema.prisma:L4869`
- `PayrollLine` → `schema.prisma:L15668`
- `PayrollRun` → `schema.prisma:L15637`
- `PerformanceGoal` → `schema.prisma:L11668`
- `PermissionOverride` → `schema.prisma:L1314`
- `PermissionSet` → `schema.prisma:L1337`
- `PlatformCfdi` → `schema.prisma:L15953`
- `PlatformEmisor` → `schema.prisma:L15893`
- `PlatformSettings` → `schema.prisma:L5291`
- `PosCommand` → `schema.prisma:L7623`
- `PosConnectionStatus` → `schema.prisma:L885`
- `PosSyncIntent` → `schema.prisma:L16031`
- `PricingPolicy` → `schema.prisma:L2497`
- `Printer` → `schema.prisma:L13865`
- `PrintGateway` → `schema.prisma:L13918`
- `PrintJob` → `schema.prisma:L14632`
- `PrintStation` → `schema.prisma:L13936`
- `ProcessedStripeEvent` → `schema.prisma:L5810`
- `ProcessorReliabilityMetric` → `schema.prisma:L6295`
- `Product` → `schema.prisma:L1625`
- `ProductModifierGroup` → `schema.prisma:L3727`
- `ProductOption` → `schema.prisma:L13599`
- `ProductOptionValue` → `schema.prisma:L13610`
- `ProductStaff` → `schema.prisma:L12543`
- `PromoterBankAccount` → `schema.prisma:L15788`
- `PromoterCommissionEntry` → `schema.prisma:L15807`
- `PromoterLocationPing` → `schema.prisma:L3259`
- `Promotion` → `schema.prisma:L16082`
- `PromotionGroup` → `schema.prisma:L16121`
- `PromotionOption` → `schema.prisma:L16137`
- `ProviderCostStructure` → `schema.prisma:L5846`
- `ProviderEventLog` → `schema.prisma:L5593`
- `PurchaseOrder` → `schema.prisma:L2267`
- `PurchaseOrderInvoice` → `schema.prisma:L2412`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2467`
- `PurchaseOrderItem` → `schema.prisma:L2325`
- `RateCorrectionBatch` → `schema.prisma:L6071`
- `RateCorrectionEntry` → `schema.prisma:L6113`
- `RawMaterial` → `schema.prisma:L2027`
- `RawMaterialMovement` → `schema.prisma:L2550`
- `RawMaterialPresentation` → `schema.prisma:L2100`
- `Recipe` → `schema.prisma:L2120`
- `RecipeLine` → `schema.prisma:L2144`
- `Referral` → `schema.prisma:L6811`
- `ReferralProgramConfig` → `schema.prisma:L6776`
- `ReferralRewardGrant` → `schema.prisma:L6902`
- `ReferralTierReward` → `schema.prisma:L6874`
- `ReferralTierUnlock` → `schema.prisma:L6947`
- `Reservation` → `schema.prisma:L12311`
- `ReservationGoogleEventMapping` → `schema.prisma:L13081`
- `ReservationModifier` → `schema.prisma:L12491`
- `ReservationReminderSent` → `schema.prisma:L12474`
- `ReservationSettings` → `schema.prisma:L12705`
- `ReservationWaitlistEntry` → `schema.prisma:L12673`
- `Review` → `schema.prisma:L4349`
- `SalesRetention` → `schema.prisma:L15488`
- `SaleVerification` → `schema.prisma:L4108`
- `ScaleProfile` → `schema.prisma:L14373`
- `ScheduledCommand` → `schema.prisma:L9160`
- `SerializedItem` → `schema.prisma:L10805`
- `SerializedItemCustodyEvent` → `schema.prisma:L10969`
- `ServiceCharge` → `schema.prisma:L7411`
- `SettlementConfiguration` → `schema.prisma:L6146`
- `SettlementConfirmation` → `schema.prisma:L6259`
- `SettlementIncident` → `schema.prisma:L6210`
- `SettlementSimulation` → `schema.prisma:L6181`
- `Shift` → `schema.prisma:L3038`
- `SimRegistrationRequest` → `schema.prisma:L11007`
- `SimRegistrationRequestItem` → `schema.prisma:L11029`
- `SlotHold` → `schema.prisma:L12574`
- `Staff` → `schema.prisma:L905`
- `StaffDocument` → `schema.prisma:L3136`
- `StaffOnboardingState` → `schema.prisma:L14703`
- `StaffOrganization` → `schema.prisma:L1213`
- `StaffPasskey` → `schema.prisma:L1240`
- `StaffSchedule` → `schema.prisma:L12514`
- `StaffScheduleException` → `schema.prisma:L12526`
- `StaffVenue` → `schema.prisma:L1143`
- `StockAlertConfig` → `schema.prisma:L11650`
- `StockBatch` → `schema.prisma:L2701`
- `StockCount` → `schema.prisma:L2625`
- `StockCountItem` → `schema.prisma:L2649`
- `StripeWebhookEvent` → `schema.prisma:L5793`
- `Supplier` → `schema.prisma:L2179`
- `SupplierPricing` → `schema.prisma:L2233`
- `Table` → `schema.prisma:L2950`
- `Terminal` → `schema.prisma:L4400`
- `TerminalHealth` → `schema.prisma:L4639`
- `TerminalLog` → `schema.prisma:L4613`
- `TerminalOrder` → `schema.prisma:L4772`
- `TerminalOrderItem` → `schema.prisma:L4847`
- `TerminalPaymentRequest` → `schema.prisma:L4710`
- `TimeEntry` → `schema.prisma:L3172`
- `TimeEntryBreak` → `schema.prisma:L3241`
- `TokenPurchase` → `schema.prisma:L8834`
- `TokenUsageRecord` → `schema.prisma:L8806`
- `TpvCommandHistory` → `schema.prisma:L9066`
- `TpvCommandQueue` → `schema.prisma:L9006`
- `TpvFeedback` → `schema.prisma:L8719`
- `TpvMessage` → `schema.prisma:L12007`
- `TpvMessageDelivery` → `schema.prisma:L12059`
- `TpvMessageResponse` → `schema.prisma:L12082`
- `TrainingModule` → `schema.prisma:L12137`
- `TrainingProgress` → `schema.prisma:L12214`
- `TrainingQuizQuestion` → `schema.prisma:L12196`
- `TrainingStep` → `schema.prisma:L12176`
- `TransactionCost` → `schema.prisma:L6009`
- `UnitConversion` → `schema.prisma:L2528`
- `UpsellAcceptance` → `schema.prisma:L7232`
- `UpsellAiRun` → `schema.prisma:L7252`
- `UpsellImpression` → `schema.prisma:L7192`
- `UpsellRule` → `schema.prisma:L7112`
- `user_sessions` → `schema.prisma:L5349`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14110`
- `VenueChatMessage` → `schema.prisma:L755`
- `VenueChatSession` → `schema.prisma:L710`
- `VenueCommission` → `schema.prisma:L13760`
- `VenueCreditAssessment` → `schema.prisma:L9543`
- `VenueCryptoConfig` → `schema.prisma:L11874`
- `VenueFeature` → `schema.prisma:L4222`
- `VenueModule` → `schema.prisma:L9703`
- `VenuePaymentConfig` → `schema.prisma:L5450`
- `VenuePaymentLinkSettings` → `schema.prisma:L13114`
- `VenuePricingStructure` → `schema.prisma:L5949`
- `VenueRoleConfig` → `schema.prisma:L1366`
- `VenueRolePermission` → `schema.prisma:L1270`
- `VenueScaleSettings` → `schema.prisma:L14361`
- `VenueSettings` → `schema.prisma:L795`
- `VenueTenderType` → `schema.prisma:L3967`
- `VenueTenderTypeRevision` → `schema.prisma:L4032`
- `VenueTransaction` → `schema.prisma:L4159`
- `VenueWhatsappActivation` → `schema.prisma:L646`
- `WalletPass` → `schema.prisma:L6734`
- `WebhookEvent` → `schema.prisma:L4258`
- `WebhookSubscription` → `schema.prisma:L5566`
- `WhatsappContactWindow` → `schema.prisma:L664`
- `WhatsappInboundEvent` → `schema.prisma:L684`
- `Zone` → `schema.prisma:L142`
