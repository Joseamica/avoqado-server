# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **333 models / 326 enums / ~15,900 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L15081`
- `AccountMapping` → `schema.prisma:L14977`
- `ActivityLog` → `schema.prisma:L6241`
- `Aggregator` → `schema.prisma:L13378`
- `AngelPayUserAccount` → `schema.prisma:L4904`
- `AppUpdate` → `schema.prisma:L11574`
- `Area` → `schema.prisma:L2811`
- `AreaTicket` → `schema.prisma:L13872`
- `AreaTicketCheckoutSession` → `schema.prisma:L13994`
- `AreaTicketExternalIncident` → `schema.prisma:L14241`
- `AreaTicketExternalSettlement` → `schema.prisma:L14206`
- `AreaTicketFulfillment` → `schema.prisma:L14070`
- `AreaTicketInventoryReservation` → `schema.prisma:L13965`
- `AreaTicketLine` → `schema.prisma:L13933`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14026`
- `AreaTicketPrintAttempt` → `schema.prisma:L14049`
- `BankStatement` → `schema.prisma:L14851`
- `BankStatementLine` → `schema.prisma:L14872`
- `BillingTaxProfile` → `schema.prisma:L15661`
- `BulkCommandOperation` → `schema.prisma:L8887`
- `CalendarSyncOutbox` → `schema.prisma:L12772`
- `CampaignDelivery` → `schema.prisma:L11732`
- `CashCloseout` → `schema.prisma:L9252`
- `CashDeposit` → `schema.prisma:L11376`
- `CashDrawerEvent` → `schema.prisma:L13215`
- `CashDrawerSession` → `schema.prisma:L13191`
- `CashOutCommissionRate` → `schema.prisma:L15490`
- `CashOutScheduleDay` → `schema.prisma:L15513`
- `CashOutWithdrawal` → `schema.prisma:L15575`
- `CatalogBindingBatch` → `schema.prisma:L10283`
- `CatalogBindingLine` → `schema.prisma:L10319`
- `CatalogBrand` → `schema.prisma:L9736`
- `CatalogClientObservation` → `schema.prisma:L10049`
- `CatalogClientReadinessOverride` → `schema.prisma:L10068`
- `CatalogFamily` → `schema.prisma:L9786`
- `CatalogIdempotencyRecord` → `schema.prisma:L10182`
- `CatalogIdentifier` → `schema.prisma:L9917`
- `CatalogImportBatch` → `schema.prisma:L10225`
- `CatalogImportLine` → `schema.prisma:L10262`
- `CatalogItem` → `schema.prisma:L9819`
- `CatalogItemBusinessType` → `schema.prisma:L9879`
- `CatalogItemPrice` → `schema.prisma:L9967`
- `CatalogManufacturer` → `schema.prisma:L9760`
- `CatalogProductTypeMapping` → `schema.prisma:L9896`
- `CatalogPublicationBatch` → `schema.prisma:L10347`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10441`
- `CatalogPublicationLine` → `schema.prisma:L10388`
- `CatalogPublicationOutbox` → `schema.prisma:L10484`
- `CatalogValidationProfile` → `schema.prisma:L9938`
- `CatalogVenueBinding` → `schema.prisma:L10096`
- `CatalogVenueClientRequirement` → `schema.prisma:L10023`
- `CatalogVenueEventSequence` → `schema.prisma:L10467`
- `CatalogVenueOverride` → `schema.prisma:L10138`
- `CatalogVenueRollout` → `schema.prisma:L9998`
- `Cfdi` → `schema.prisma:L14754`
- `ChatbotTokenBudget` → `schema.prisma:L8535`
- `ChatConversation` → `schema.prisma:L8390`
- `ChatFeedback` → `schema.prisma:L8476`
- `ChatLearningEvent` → `schema.prisma:L8433`
- `ChatMessage` → `schema.prisma:L8413`
- `ChatTrainingData` → `schema.prisma:L8347`
- `CheckoutSession` → `schema.prisma:L5184`
- `ClassSession` → `schema.prisma:L12385`
- `CommissionCalculation` → `schema.prisma:L11155`
- `CommissionClawback` → `schema.prisma:L11328`
- `CommissionConfig` → `schema.prisma:L10928`
- `CommissionMilestone` → `schema.prisma:L11071`
- `CommissionOverride` → `schema.prisma:L10998`
- `CommissionPayout` → `schema.prisma:L11279`
- `CommissionSummary` → `schema.prisma:L11218`
- `CommissionTier` → `schema.prisma:L11035`
- `Consumer` → `schema.prisma:L6399`
- `ConsumerAuthAccount` → `schema.prisma:L6424`
- `CouponCode` → `schema.prisma:L7045`
- `CouponRedemption` → `schema.prisma:L7076`
- `CreditAssessmentHistory` → `schema.prisma:L9361`
- `CreditItemBalance` → `schema.prisma:L12981`
- `CreditOffer` → `schema.prisma:L9380`
- `CreditPack` → `schema.prisma:L12897`
- `CreditPackItem` → `schema.prisma:L12926`
- `CreditPackPurchase` → `schema.prisma:L12943`
- `CreditTransaction` → `schema.prisma:L13003`
- `Customer` → `schema.prisma:L6282`
- `CustomerApprovalDelivery` → `schema.prisma:L8052`
- `CustomerApprovalOutbox` → `schema.prisma:L8027`
- `CustomerDiscount` → `schema.prisma:L7096`
- `CustomerGroup` → `schema.prisma:L6463`
- `CustomerTaxProfile` → `schema.prisma:L14823`
- `DeliveryActivationRequest` → `schema.prisma:L5525`
- `DeliveryChannelLink` → `schema.prisma:L5470`
- `DeliveryOrderEvent` → `schema.prisma:L5549`
- `DeviceToken` → `schema.prisma:L7365`
- `DigitalReceipt` → `schema.prisma:L3899`
- `Discount` → `schema.prisma:L6735`
- `EcommerceMerchant` → `schema.prisma:L4996`
- `EmailTemplate` → `schema.prisma:L11671`
- `Employee` → `schema.prisma:L15338`
- `Estimate` → `schema.prisma:L13285`
- `EstimateItem` → `schema.prisma:L13313`
- `Expense` → `schema.prisma:L15125`
- `ExternalBusyBlock` → `schema.prisma:L12665`
- `Feature` → `schema.prisma:L4028`
- `FeeSchedule` → `schema.prisma:L4106`
- `FeeTier` → `schema.prisma:L4117`
- `FinancialAccount` → `schema.prisma:L13475`
- `FinancialConnection` → `schema.prisma:L13444`
- `FinancialProvider` → `schema.prisma:L13430`
- `FiscalEmisor` → `schema.prisma:L14677`
- `FiscalLossCarryforward` → `schema.prisma:L15248`
- `FixedAsset` → `schema.prisma:L15266`
- `FixedAssetDepreciation` → `schema.prisma:L15295`
- `FloorElement` → `schema.prisma:L2887`
- `FulfillmentArea` → `schema.prisma:L13737`
- `GeofenceRule` → `schema.prisma:L8972`
- `GoogleCalendarChannel` → `schema.prisma:L12642`
- `GoogleCalendarConnection` → `schema.prisma:L12594`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12695`
- `GoogleOAuthSession` → `schema.prisma:L12717`
- `HolidayCalendar` → `schema.prisma:L6165`
- `IdempotencyRequest` → `schema.prisma:L10803`
- `InterVenueTransfer` → `schema.prisma:L2639`
- `InterVenueTransferAllocation` → `schema.prisma:L2722`
- `InterVenueTransferItem` → `schema.prisma:L2691`
- `InterVenueTransferReceipt` → `schema.prisma:L2749`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2765`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2793`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2777`
- `Inventory` → `schema.prisma:L1832`
- `InventoryMovement` → `schema.prisma:L1859`
- `InventoryPosting` → `schema.prisma:L1941`
- `InventoryPostingLine` → `schema.prisma:L1981`
- `InventoryTransfer` → `schema.prisma:L13257`
- `Invitation` → `schema.prisma:L1372`
- `Invoice` → `schema.prisma:L4129`
- `InvoiceItem` → `schema.prisma:L4155`
- `ItemCategory` → `schema.prisma:L10519`
- `JournalEntry` → `schema.prisma:L15035`
- `JournalLine` → `schema.prisma:L15063`
- `KdsOrder` → `schema.prisma:L13523`
- `KdsOrderItem` → `schema.prisma:L13564`
- `LearnedPatterns` → `schema.prisma:L8457`
- `LedgerAccount` → `schema.prisma:L14927`
- `LiveDemoSession` → `schema.prisma:L773`
- `LowStockAlert` → `schema.prisma:L2480`
- `LoyaltyConfig` → `schema.prisma:L6493`
- `LoyaltyTransaction` → `schema.prisma:L6516`
- `MarketingCampaign` → `schema.prisma:L11689`
- `McpAuthCode` → `schema.prisma:L14560`
- `McpOAuthClient` → `schema.prisma:L14544`
- `McpRefreshToken` → `schema.prisma:L14578`
- `McpToolCall` → `schema.prisma:L14599`
- `MeasurementUnit` → `schema.prisma:L13363`
- `Menu` → `schema.prisma:L1558`
- `MenuCategory` → `schema.prisma:L1495`
- `MenuCategoryAssignment` → `schema.prisma:L1593`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14474`
- `MerchantAccount` → `schema.prisma:L4734`
- `MerchantFiscalConfig` → `schema.prisma:L14725`
- `MerchantRevenueShare` → `schema.prisma:L5745`
- `MerchantRoutingRule` → `schema.prisma:L4856`
- `MilestoneAchievement` → `schema.prisma:L11116`
- `Modifier` → `schema.prisma:L3515`
- `ModifierGroup` → `schema.prisma:L3479`
- `Module` → `schema.prisma:L9428`
- `MoneyAnomaly` → `schema.prisma:L5648`
- `MonthlyVenueProfit` → `schema.prisma:L6191`
- `Notification` → `schema.prisma:L7267`
- `NotificationPreference` → `schema.prisma:L7314`
- `NotificationTemplate` → `schema.prisma:L7341`
- `OAuthState` → `schema.prisma:L1423`
- `OnboardingProgress` → `schema.prisma:L1441`
- `Order` → `schema.prisma:L3118`
- `OrderAction` → `schema.prisma:L3580`
- `OrderCustomer` → `schema.prisma:L3330`
- `OrderDiscount` → `schema.prisma:L7128`
- `OrderFulfillment` → `schema.prisma:L13792`
- `OrderFulfillmentLine` → `schema.prisma:L13823`
- `OrderItem` → `schema.prisma:L3346`
- `OrderItemModifier` → `schema.prisma:L3564`
- `OrderPromotion` → `schema.prisma:L15901`
- `OrderServiceCharge` → `schema.prisma:L7212`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11490`
- `OrganizationEntitlement` → `schema.prisma:L9711`
- `OrganizationGoal` → `schema.prisma:L11448`
- `OrganizationModule` → `schema.prisma:L9488`
- `OrganizationPaymentConfig` → `schema.prisma:L5308`
- `OrganizationPayoutConfig` → `schema.prisma:L11523`
- `OrganizationPricingStructure` → `schema.prisma:L5340`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11471`
- `OtpChallenge` → `schema.prisma:L6443`
- `PartnerAPIKey` → `schema.prisma:L5138`
- `Payment` → `schema.prisma:L3613`
- `PaymentAllocation` → `schema.prisma:L3878`
- `PaymentLink` → `schema.prisma:L13049`
- `PaymentLinkAttribution` → `schema.prisma:L13157`
- `PaymentLinkItem` → `schema.prisma:L13112`
- `PaymentLinkItemModifier` → `schema.prisma:L13139`
- `PaymentProvider` → `schema.prisma:L4693`
- `PayrollLine` → `schema.prisma:L15409`
- `PayrollRun` → `schema.prisma:L15378`
- `PerformanceGoal` → `schema.prisma:L11425`
- `PermissionOverride` → `schema.prisma:L1300`
- `PermissionSet` → `schema.prisma:L1323`
- `PlatformCfdi` → `schema.prisma:L15694`
- `PlatformEmisor` → `schema.prisma:L15634`
- `PlatformSettings` → `schema.prisma:L5115`
- `PosCommand` → `schema.prisma:L7395`
- `PosConnectionStatus` → `schema.prisma:L879`
- `PosSyncIntent` → `schema.prisma:L15772`
- `PricingPolicy` → `schema.prisma:L2384`
- `Printer` → `schema.prisma:L13606`
- `PrintGateway` → `schema.prisma:L13659`
- `PrintJob` → `schema.prisma:L14373`
- `PrintStation` → `schema.prisma:L13677`
- `ProcessedStripeEvent` → `schema.prisma:L5634`
- `ProcessorReliabilityMetric` → `schema.prisma:L6119`
- `Product` → `schema.prisma:L1611`
- `ProductModifierGroup` → `schema.prisma:L3552`
- `ProductOption` → `schema.prisma:L13340`
- `ProductOptionValue` → `schema.prisma:L13351`
- `ProductStaff` → `schema.prisma:L12300`
- `PromoterBankAccount` → `schema.prisma:L15529`
- `PromoterCommissionEntry` → `schema.prisma:L15548`
- `PromoterLocationPing` → `schema.prisma:L3084`
- `Promotion` → `schema.prisma:L15823`
- `PromotionGroup` → `schema.prisma:L15862`
- `PromotionOption` → `schema.prisma:L15878`
- `ProviderCostStructure` → `schema.prisma:L5670`
- `ProviderEventLog` → `schema.prisma:L5417`
- `PurchaseOrder` → `schema.prisma:L2252`
- `PurchaseOrderItem` → `schema.prisma:L2309`
- `RateCorrectionBatch` → `schema.prisma:L5895`
- `RateCorrectionEntry` → `schema.prisma:L5937`
- `RawMaterial` → `schema.prisma:L2013`
- `RawMaterialMovement` → `schema.prisma:L2437`
- `RawMaterialPresentation` → `schema.prisma:L2086`
- `Recipe` → `schema.prisma:L2106`
- `RecipeLine` → `schema.prisma:L2130`
- `Referral` → `schema.prisma:L6583`
- `ReferralProgramConfig` → `schema.prisma:L6548`
- `ReferralRewardGrant` → `schema.prisma:L6674`
- `ReferralTierReward` → `schema.prisma:L6646`
- `ReferralTierUnlock` → `schema.prisma:L6719`
- `Reservation` → `schema.prisma:L12068`
- `ReservationGoogleEventMapping` → `schema.prisma:L12829`
- `ReservationModifier` → `schema.prisma:L12248`
- `ReservationReminderSent` → `schema.prisma:L12231`
- `ReservationSettings` → `schema.prisma:L12462`
- `ReservationWaitlistEntry` → `schema.prisma:L12430`
- `Review` → `schema.prisma:L4173`
- `SalesRetention` → `schema.prisma:L15229`
- `SaleVerification` → `schema.prisma:L3932`
- `ScaleProfile` → `schema.prisma:L14114`
- `ScheduledCommand` → `schema.prisma:L8932`
- `SerializedItem` → `schema.prisma:L10562`
- `SerializedItemCustodyEvent` → `schema.prisma:L10726`
- `ServiceCharge` → `schema.prisma:L7183`
- `SettlementConfiguration` → `schema.prisma:L5970`
- `SettlementConfirmation` → `schema.prisma:L6083`
- `SettlementIncident` → `schema.prisma:L6034`
- `SettlementSimulation` → `schema.prisma:L6005`
- `Shift` → `schema.prisma:L2925`
- `SimRegistrationRequest` → `schema.prisma:L10764`
- `SimRegistrationRequestItem` → `schema.prisma:L10786`
- `SlotHold` → `schema.prisma:L12331`
- `Staff` → `schema.prisma:L899`
- `StaffOnboardingState` → `schema.prisma:L14444`
- `StaffOrganization` → `schema.prisma:L1199`
- `StaffPasskey` → `schema.prisma:L1226`
- `StaffSchedule` → `schema.prisma:L12271`
- `StaffScheduleException` → `schema.prisma:L12283`
- `StaffVenue` → `schema.prisma:L1129`
- `StockAlertConfig` → `schema.prisma:L11407`
- `StockBatch` → `schema.prisma:L2588`
- `StockCount` → `schema.prisma:L2512`
- `StockCountItem` → `schema.prisma:L2536`
- `StripeWebhookEvent` → `schema.prisma:L5617`
- `Supplier` → `schema.prisma:L2165`
- `SupplierPricing` → `schema.prisma:L2218`
- `Table` → `schema.prisma:L2837`
- `Terminal` → `schema.prisma:L4224`
- `TerminalHealth` → `schema.prisma:L4463`
- `TerminalLog` → `schema.prisma:L4437`
- `TerminalOrder` → `schema.prisma:L4596`
- `TerminalOrderItem` → `schema.prisma:L4671`
- `TerminalPaymentRequest` → `schema.prisma:L4534`
- `TimeEntry` → `schema.prisma:L2997`
- `TimeEntryBreak` → `schema.prisma:L3066`
- `TokenPurchase` → `schema.prisma:L8606`
- `TokenUsageRecord` → `schema.prisma:L8578`
- `TpvCommandHistory` → `schema.prisma:L8838`
- `TpvCommandQueue` → `schema.prisma:L8778`
- `TpvFeedback` → `schema.prisma:L8491`
- `TpvMessage` → `schema.prisma:L11764`
- `TpvMessageDelivery` → `schema.prisma:L11816`
- `TpvMessageResponse` → `schema.prisma:L11839`
- `TrainingModule` → `schema.prisma:L11894`
- `TrainingProgress` → `schema.prisma:L11971`
- `TrainingQuizQuestion` → `schema.prisma:L11953`
- `TrainingStep` → `schema.prisma:L11933`
- `TransactionCost` → `schema.prisma:L5833`
- `UnitConversion` → `schema.prisma:L2415`
- `UpsellAcceptance` → `schema.prisma:L7004`
- `UpsellAiRun` → `schema.prisma:L7024`
- `UpsellImpression` → `schema.prisma:L6964`
- `UpsellRule` → `schema.prisma:L6884`
- `user_sessions` → `schema.prisma:L5173`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L13851`
- `VenueChatMessage` → `schema.prisma:L749`
- `VenueChatSession` → `schema.prisma:L704`
- `VenueCommission` → `schema.prisma:L13501`
- `VenueCreditAssessment` → `schema.prisma:L9300`
- `VenueCryptoConfig` → `schema.prisma:L11631`
- `VenueFeature` → `schema.prisma:L4046`
- `VenueModule` → `schema.prisma:L9460`
- `VenuePaymentConfig` → `schema.prisma:L5274`
- `VenuePaymentLinkSettings` → `schema.prisma:L12862`
- `VenuePricingStructure` → `schema.prisma:L5773`
- `VenueRoleConfig` → `schema.prisma:L1352`
- `VenueRolePermission` → `schema.prisma:L1256`
- `VenueScaleSettings` → `schema.prisma:L14102`
- `VenueSettings` → `schema.prisma:L789`
- `VenueTenderType` → `schema.prisma:L3791`
- `VenueTenderTypeRevision` → `schema.prisma:L3856`
- `VenueTransaction` → `schema.prisma:L3983`
- `VenueWhatsappActivation` → `schema.prisma:L640`
- `WebhookEvent` → `schema.prisma:L4082`
- `WebhookSubscription` → `schema.prisma:L5390`
- `WhatsappContactWindow` → `schema.prisma:L658`
- `WhatsappInboundEvent` → `schema.prisma:L678`
- `Zone` → `schema.prisma:L142`
