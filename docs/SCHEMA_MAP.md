# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **331 models / 322 enums / ~15,600 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                            |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                                                                              |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                           |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                           |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`                                                                                                                                                                                                                                                                                                                                  |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                        |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                                                                                       |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L14802`
- `AccountMapping` → `schema.prisma:L14698`
- `ActivityLog` → `schema.prisma:L6161`
- `Aggregator` → `schema.prisma:L13150`
- `AngelPayUserAccount` → `schema.prisma:L4852`
- `AppUpdate` → `schema.prisma:L11370`
- `Area` → `schema.prisma:L2771`
- `AreaTicket` → `schema.prisma:L13593`
- `AreaTicketCheckoutSession` → `schema.prisma:L13715`
- `AreaTicketExternalIncident` → `schema.prisma:L13962`
- `AreaTicketExternalSettlement` → `schema.prisma:L13927`
- `AreaTicketFulfillment` → `schema.prisma:L13791`
- `AreaTicketInventoryReservation` → `schema.prisma:L13686`
- `AreaTicketLine` → `schema.prisma:L13654`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13747`
- `AreaTicketPrintAttempt` → `schema.prisma:L13770`
- `BankStatement` → `schema.prisma:L14572`
- `BankStatementLine` → `schema.prisma:L14593`
- `BillingTaxProfile` → `schema.prisma:L15382`
- `BulkCommandOperation` → `schema.prisma:L8684`
- `CalendarSyncOutbox` → `schema.prisma:L12544`
- `CampaignDelivery` → `schema.prisma:L11528`
- `CashCloseout` → `schema.prisma:L9049`
- `CashDeposit` → `schema.prisma:L11172`
- `CashDrawerEvent` → `schema.prisma:L12987`
- `CashDrawerSession` → `schema.prisma:L12963`
- `CashOutCommissionRate` → `schema.prisma:L15211`
- `CashOutScheduleDay` → `schema.prisma:L15234`
- `CashOutWithdrawal` → `schema.prisma:L15296`
- `CatalogBindingBatch` → `schema.prisma:L10080`
- `CatalogBindingLine` → `schema.prisma:L10116`
- `CatalogBrand` → `schema.prisma:L9533`
- `CatalogClientObservation` → `schema.prisma:L9846`
- `CatalogClientReadinessOverride` → `schema.prisma:L9865`
- `CatalogFamily` → `schema.prisma:L9583`
- `CatalogIdempotencyRecord` → `schema.prisma:L9979`
- `CatalogIdentifier` → `schema.prisma:L9714`
- `CatalogImportBatch` → `schema.prisma:L10022`
- `CatalogImportLine` → `schema.prisma:L10059`
- `CatalogItem` → `schema.prisma:L9616`
- `CatalogItemBusinessType` → `schema.prisma:L9676`
- `CatalogItemPrice` → `schema.prisma:L9764`
- `CatalogManufacturer` → `schema.prisma:L9557`
- `CatalogProductTypeMapping` → `schema.prisma:L9693`
- `CatalogPublicationBatch` → `schema.prisma:L10144`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10238`
- `CatalogPublicationLine` → `schema.prisma:L10185`
- `CatalogPublicationOutbox` → `schema.prisma:L10281`
- `CatalogValidationProfile` → `schema.prisma:L9735`
- `CatalogVenueBinding` → `schema.prisma:L9893`
- `CatalogVenueClientRequirement` → `schema.prisma:L9820`
- `CatalogVenueEventSequence` → `schema.prisma:L10264`
- `CatalogVenueOverride` → `schema.prisma:L9935`
- `CatalogVenueRollout` → `schema.prisma:L9795`
- `Cfdi` → `schema.prisma:L14475`
- `ChatbotTokenBudget` → `schema.prisma:L8332`
- `ChatConversation` → `schema.prisma:L8187`
- `ChatFeedback` → `schema.prisma:L8273`
- `ChatLearningEvent` → `schema.prisma:L8230`
- `ChatMessage` → `schema.prisma:L8210`
- `ChatTrainingData` → `schema.prisma:L8144`
- `CheckoutSession` → `schema.prisma:L5132`
- `ClassSession` → `schema.prisma:L12162`
- `CommissionCalculation` → `schema.prisma:L10951`
- `CommissionClawback` → `schema.prisma:L11124`
- `CommissionConfig` → `schema.prisma:L10724`
- `CommissionMilestone` → `schema.prisma:L10867`
- `CommissionOverride` → `schema.prisma:L10794`
- `CommissionPayout` → `schema.prisma:L11075`
- `CommissionSummary` → `schema.prisma:L11014`
- `CommissionTier` → `schema.prisma:L10831`
- `Consumer` → `schema.prisma:L6297`
- `ConsumerAuthAccount` → `schema.prisma:L6322`
- `CouponCode` → `schema.prisma:L6938`
- `CouponRedemption` → `schema.prisma:L6969`
- `CreditAssessmentHistory` → `schema.prisma:L9158`
- `CreditItemBalance` → `schema.prisma:L12753`
- `CreditOffer` → `schema.prisma:L9177`
- `CreditPack` → `schema.prisma:L12669`
- `CreditPackItem` → `schema.prisma:L12698`
- `CreditPackPurchase` → `schema.prisma:L12715`
- `CreditTransaction` → `schema.prisma:L12775`
- `Customer` → `schema.prisma:L6202`
- `CustomerDiscount` → `schema.prisma:L6989`
- `CustomerGroup` → `schema.prisma:L6356`
- `CustomerTaxProfile` → `schema.prisma:L14544`
- `DeliveryActivationRequest` → `schema.prisma:L5454`
- `DeliveryChannelLink` → `schema.prisma:L5418`
- `DeliveryOrderEvent` → `schema.prisma:L5478`
- `DeviceToken` → `schema.prisma:L7258`
- `DigitalReceipt` → `schema.prisma:L3847`
- `Discount` → `schema.prisma:L6628`
- `EcommerceMerchant` → `schema.prisma:L4944`
- `EmailTemplate` → `schema.prisma:L11467`
- `Employee` → `schema.prisma:L15059`
- `Estimate` → `schema.prisma:L13057`
- `EstimateItem` → `schema.prisma:L13085`
- `Expense` → `schema.prisma:L14846`
- `ExternalBusyBlock` → `schema.prisma:L12437`
- `Feature` → `schema.prisma:L3976`
- `FeeSchedule` → `schema.prisma:L4054`
- `FeeTier` → `schema.prisma:L4065`
- `FinancialAccount` → `schema.prisma:L13247`
- `FinancialConnection` → `schema.prisma:L13216`
- `FinancialProvider` → `schema.prisma:L13202`
- `FiscalEmisor` → `schema.prisma:L14398`
- `FiscalLossCarryforward` → `schema.prisma:L14969`
- `FixedAsset` → `schema.prisma:L14987`
- `FixedAssetDepreciation` → `schema.prisma:L15016`
- `FloorElement` → `schema.prisma:L2847`
- `FulfillmentArea` → `schema.prisma:L13458`
- `GeofenceRule` → `schema.prisma:L8769`
- `GoogleCalendarChannel` → `schema.prisma:L12414`
- `GoogleCalendarConnection` → `schema.prisma:L12366`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12467`
- `GoogleOAuthSession` → `schema.prisma:L12489`
- `HolidayCalendar` → `schema.prisma:L6085`
- `IdempotencyRequest` → `schema.prisma:L10599`
- `InterVenueTransfer` → `schema.prisma:L2599`
- `InterVenueTransferAllocation` → `schema.prisma:L2682`
- `InterVenueTransferItem` → `schema.prisma:L2651`
- `InterVenueTransferReceipt` → `schema.prisma:L2709`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2725`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2753`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2737`
- `Inventory` → `schema.prisma:L1792`
- `InventoryMovement` → `schema.prisma:L1819`
- `InventoryPosting` → `schema.prisma:L1901`
- `InventoryPostingLine` → `schema.prisma:L1941`
- `InventoryTransfer` → `schema.prisma:L13029`
- `Invitation` → `schema.prisma:L1340`
- `Invoice` → `schema.prisma:L4077`
- `InvoiceItem` → `schema.prisma:L4103`
- `ItemCategory` → `schema.prisma:L10316`
- `JournalEntry` → `schema.prisma:L14756`
- `JournalLine` → `schema.prisma:L14784`
- `KdsOrder` → `schema.prisma:L13295`
- `KdsOrderItem` → `schema.prisma:L13312`
- `LearnedPatterns` → `schema.prisma:L8254`
- `LedgerAccount` → `schema.prisma:L14648`
- `LiveDemoSession` → `schema.prisma:L759`
- `LowStockAlert` → `schema.prisma:L2440`
- `LoyaltyConfig` → `schema.prisma:L6386`
- `LoyaltyTransaction` → `schema.prisma:L6409`
- `MarketingCampaign` → `schema.prisma:L11485`
- `McpAuthCode` → `schema.prisma:L14281`
- `McpOAuthClient` → `schema.prisma:L14265`
- `McpRefreshToken` → `schema.prisma:L14299`
- `McpToolCall` → `schema.prisma:L14320`
- `MeasurementUnit` → `schema.prisma:L13135`
- `Menu` → `schema.prisma:L1526`
- `MenuCategory` → `schema.prisma:L1463`
- `MenuCategoryAssignment` → `schema.prisma:L1561`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14195`
- `MerchantAccount` → `schema.prisma:L4682`
- `MerchantFiscalConfig` → `schema.prisma:L14446`
- `MerchantRevenueShare` → `schema.prisma:L5665`
- `MerchantRoutingRule` → `schema.prisma:L4804`
- `MilestoneAchievement` → `schema.prisma:L10912`
- `Modifier` → `schema.prisma:L3463`
- `ModifierGroup` → `schema.prisma:L3427`
- `Module` → `schema.prisma:L9225`
- `MoneyAnomaly` → `schema.prisma:L5568`
- `MonthlyVenueProfit` → `schema.prisma:L6111`
- `Notification` → `schema.prisma:L7160`
- `NotificationPreference` → `schema.prisma:L7207`
- `NotificationTemplate` → `schema.prisma:L7234`
- `OAuthState` → `schema.prisma:L1391`
- `OnboardingProgress` → `schema.prisma:L1409`
- `Order` → `schema.prisma:L3078`
- `OrderAction` → `schema.prisma:L3528`
- `OrderCustomer` → `schema.prisma:L3278`
- `OrderDiscount` → `schema.prisma:L7021`
- `OrderFulfillment` → `schema.prisma:L13513`
- `OrderFulfillmentLine` → `schema.prisma:L13544`
- `OrderItem` → `schema.prisma:L3294`
- `OrderItemModifier` → `schema.prisma:L3512`
- `OrderPromotion` → `schema.prisma:L15622`
- `OrderServiceCharge` → `schema.prisma:L7105`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11286`
- `OrganizationEntitlement` → `schema.prisma:L9508`
- `OrganizationGoal` → `schema.prisma:L11244`
- `OrganizationModule` → `schema.prisma:L9285`
- `OrganizationPaymentConfig` → `schema.prisma:L5256`
- `OrganizationPayoutConfig` → `schema.prisma:L11319`
- `OrganizationPricingStructure` → `schema.prisma:L5288`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11267`
- `OtpChallenge` → `schema.prisma:L6341`
- `PartnerAPIKey` → `schema.prisma:L5086`
- `Payment` → `schema.prisma:L3561`
- `PaymentAllocation` → `schema.prisma:L3826`
- `PaymentLink` → `schema.prisma:L12821`
- `PaymentLinkAttribution` → `schema.prisma:L12929`
- `PaymentLinkItem` → `schema.prisma:L12884`
- `PaymentLinkItemModifier` → `schema.prisma:L12911`
- `PaymentProvider` → `schema.prisma:L4641`
- `PayrollLine` → `schema.prisma:L15130`
- `PayrollRun` → `schema.prisma:L15099`
- `PerformanceGoal` → `schema.prisma:L11221`
- `PermissionOverride` → `schema.prisma:L1268`
- `PermissionSet` → `schema.prisma:L1291`
- `PlatformCfdi` → `schema.prisma:L15415`
- `PlatformEmisor` → `schema.prisma:L15355`
- `PlatformSettings` → `schema.prisma:L5063`
- `PosCommand` → `schema.prisma:L7288`
- `PosConnectionStatus` → `schema.prisma:L865`
- `PosSyncIntent` → `schema.prisma:L15493`
- `PricingPolicy` → `schema.prisma:L2344`
- `Printer` → `schema.prisma:L13341`
- `PrintGateway` → `schema.prisma:L13394`
- `PrintJob` → `schema.prisma:L14094`
- `PrintStation` → `schema.prisma:L13412`
- `ProcessedStripeEvent` → `schema.prisma:L5554`
- `ProcessorReliabilityMetric` → `schema.prisma:L6039`
- `Product` → `schema.prisma:L1579`
- `ProductModifierGroup` → `schema.prisma:L3500`
- `ProductOption` → `schema.prisma:L13112`
- `ProductOptionValue` → `schema.prisma:L13123`
- `ProductStaff` → `schema.prisma:L12077`
- `PromoterBankAccount` → `schema.prisma:L15250`
- `PromoterCommissionEntry` → `schema.prisma:L15269`
- `PromoterLocationPing` → `schema.prisma:L3044`
- `Promotion` → `schema.prisma:L15544`
- `PromotionGroup` → `schema.prisma:L15583`
- `PromotionOption` → `schema.prisma:L15599`
- `ProviderCostStructure` → `schema.prisma:L5590`
- `ProviderEventLog` → `schema.prisma:L5365`
- `PurchaseOrder` → `schema.prisma:L2212`
- `PurchaseOrderItem` → `schema.prisma:L2269`
- `RateCorrectionBatch` → `schema.prisma:L5815`
- `RateCorrectionEntry` → `schema.prisma:L5857`
- `RawMaterial` → `schema.prisma:L1973`
- `RawMaterialMovement` → `schema.prisma:L2397`
- `RawMaterialPresentation` → `schema.prisma:L2046`
- `Recipe` → `schema.prisma:L2066`
- `RecipeLine` → `schema.prisma:L2090`
- `Referral` → `schema.prisma:L6476`
- `ReferralProgramConfig` → `schema.prisma:L6441`
- `ReferralRewardGrant` → `schema.prisma:L6567`
- `ReferralTierReward` → `schema.prisma:L6539`
- `ReferralTierUnlock` → `schema.prisma:L6612`
- `Reservation` → `schema.prisma:L11864`
- `ReservationGoogleEventMapping` → `schema.prisma:L12601`
- `ReservationModifier` → `schema.prisma:L12025`
- `ReservationReminderSent` → `schema.prisma:L12008`
- `ReservationSettings` → `schema.prisma:L12239`
- `ReservationWaitlistEntry` → `schema.prisma:L12207`
- `Review` → `schema.prisma:L4121`
- `SalesRetention` → `schema.prisma:L14950`
- `SaleVerification` → `schema.prisma:L3880`
- `ScaleProfile` → `schema.prisma:L13835`
- `ScheduledCommand` → `schema.prisma:L8729`
- `SerializedItem` → `schema.prisma:L10359`
- `SerializedItemCustodyEvent` → `schema.prisma:L10522`
- `ServiceCharge` → `schema.prisma:L7076`
- `SettlementConfiguration` → `schema.prisma:L5890`
- `SettlementConfirmation` → `schema.prisma:L6003`
- `SettlementIncident` → `schema.prisma:L5954`
- `SettlementSimulation` → `schema.prisma:L5925`
- `Shift` → `schema.prisma:L2885`
- `SimRegistrationRequest` → `schema.prisma:L10560`
- `SimRegistrationRequestItem` → `schema.prisma:L10582`
- `SlotHold` → `schema.prisma:L12108`
- `Staff` → `schema.prisma:L885`
- `StaffOnboardingState` → `schema.prisma:L14165`
- `StaffOrganization` → `schema.prisma:L1181`
- `StaffPasskey` → `schema.prisma:L1208`
- `StaffSchedule` → `schema.prisma:L12048`
- `StaffScheduleException` → `schema.prisma:L12060`
- `StaffVenue` → `schema.prisma:L1111`
- `StockAlertConfig` → `schema.prisma:L11203`
- `StockBatch` → `schema.prisma:L2548`
- `StockCount` → `schema.prisma:L2472`
- `StockCountItem` → `schema.prisma:L2496`
- `StripeWebhookEvent` → `schema.prisma:L5537`
- `Supplier` → `schema.prisma:L2125`
- `SupplierPricing` → `schema.prisma:L2178`
- `Table` → `schema.prisma:L2797`
- `Terminal` → `schema.prisma:L4172`
- `TerminalHealth` → `schema.prisma:L4411`
- `TerminalLog` → `schema.prisma:L4385`
- `TerminalOrder` → `schema.prisma:L4544`
- `TerminalOrderItem` → `schema.prisma:L4619`
- `TerminalPaymentRequest` → `schema.prisma:L4482`
- `TimeEntry` → `schema.prisma:L2957`
- `TimeEntryBreak` → `schema.prisma:L3026`
- `TokenPurchase` → `schema.prisma:L8403`
- `TokenUsageRecord` → `schema.prisma:L8375`
- `TpvCommandHistory` → `schema.prisma:L8635`
- `TpvCommandQueue` → `schema.prisma:L8575`
- `TpvFeedback` → `schema.prisma:L8288`
- `TpvMessage` → `schema.prisma:L11560`
- `TpvMessageDelivery` → `schema.prisma:L11612`
- `TpvMessageResponse` → `schema.prisma:L11635`
- `TrainingModule` → `schema.prisma:L11690`
- `TrainingProgress` → `schema.prisma:L11767`
- `TrainingQuizQuestion` → `schema.prisma:L11749`
- `TrainingStep` → `schema.prisma:L11729`
- `TransactionCost` → `schema.prisma:L5753`
- `UnitConversion` → `schema.prisma:L2375`
- `UpsellAcceptance` → `schema.prisma:L6897`
- `UpsellAiRun` → `schema.prisma:L6917`
- `UpsellImpression` → `schema.prisma:L6857`
- `UpsellRule` → `schema.prisma:L6777`
- `user_sessions` → `schema.prisma:L5121`
- `Venue` → `schema.prisma:L147`
- `VenueAreaTicketSettings` → `schema.prisma:L13572`
- `VenueChatMessage` → `schema.prisma:L735`
- `VenueChatSession` → `schema.prisma:L690`
- `VenueCommission` → `schema.prisma:L13273`
- `VenueCreditAssessment` → `schema.prisma:L9097`
- `VenueCryptoConfig` → `schema.prisma:L11427`
- `VenueFeature` → `schema.prisma:L3994`
- `VenueModule` → `schema.prisma:L9257`
- `VenuePaymentConfig` → `schema.prisma:L5222`
- `VenuePaymentLinkSettings` → `schema.prisma:L12634`
- `VenuePricingStructure` → `schema.prisma:L5693`
- `VenueRoleConfig` → `schema.prisma:L1320`
- `VenueRolePermission` → `schema.prisma:L1238`
- `VenueScaleSettings` → `schema.prisma:L13823`
- `VenueSettings` → `schema.prisma:L775`
- `VenueTenderType` → `schema.prisma:L3739`
- `VenueTenderTypeRevision` → `schema.prisma:L3804`
- `VenueTransaction` → `schema.prisma:L3931`
- `VenueWhatsappActivation` → `schema.prisma:L626`
- `WebhookEvent` → `schema.prisma:L4030`
- `WebhookSubscription` → `schema.prisma:L5338`
- `WhatsappContactWindow` → `schema.prisma:L644`
- `WhatsappInboundEvent` → `schema.prisma:L664`
- `Zone` → `schema.prisma:L130`
