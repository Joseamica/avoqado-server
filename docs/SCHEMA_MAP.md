# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **324 models / 316 enums / ~15,200 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `PermissionSet`, `PromoterLocationPing`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                          |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                                                            |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                         |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                         |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`                                                                                                                                                                                                                                                                                                                                                                  |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                      |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                                                                     |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                 |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L14556`
- `AccountMapping` → `schema.prisma:L14452`
- `ActivityLog` → `schema.prisma:L5944`
- `Aggregator` → `schema.prisma:L12904`
- `AngelPayUserAccount` → `schema.prisma:L4653`
- `AppUpdate` → `schema.prisma:L11124`
- `Area` → `schema.prisma:L2700`
- `AreaTicket` → `schema.prisma:L13347`
- `AreaTicketCheckoutSession` → `schema.prisma:L13469`
- `AreaTicketExternalIncident` → `schema.prisma:L13716`
- `AreaTicketExternalSettlement` → `schema.prisma:L13681`
- `AreaTicketFulfillment` → `schema.prisma:L13545`
- `AreaTicketInventoryReservation` → `schema.prisma:L13440`
- `AreaTicketLine` → `schema.prisma:L13408`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13501`
- `AreaTicketPrintAttempt` → `schema.prisma:L13524`
- `BankStatement` → `schema.prisma:L14326`
- `BankStatementLine` → `schema.prisma:L14347`
- `BillingTaxProfile` → `schema.prisma:L15136`
- `BulkCommandOperation` → `schema.prisma:L8438`
- `CalendarSyncOutbox` → `schema.prisma:L12298`
- `CampaignDelivery` → `schema.prisma:L11282`
- `CashCloseout` → `schema.prisma:L8803`
- `CashDeposit` → `schema.prisma:L10926`
- `CashDrawerEvent` → `schema.prisma:L12741`
- `CashDrawerSession` → `schema.prisma:L12717`
- `CashOutCommissionRate` → `schema.prisma:L14965`
- `CashOutScheduleDay` → `schema.prisma:L14988`
- `CashOutWithdrawal` → `schema.prisma:L15050`
- `CatalogBindingBatch` → `schema.prisma:L9834`
- `CatalogBindingLine` → `schema.prisma:L9870`
- `CatalogBrand` → `schema.prisma:L9287`
- `CatalogClientObservation` → `schema.prisma:L9600`
- `CatalogClientReadinessOverride` → `schema.prisma:L9619`
- `CatalogFamily` → `schema.prisma:L9337`
- `CatalogIdempotencyRecord` → `schema.prisma:L9733`
- `CatalogIdentifier` → `schema.prisma:L9468`
- `CatalogImportBatch` → `schema.prisma:L9776`
- `CatalogImportLine` → `schema.prisma:L9813`
- `CatalogItem` → `schema.prisma:L9370`
- `CatalogItemBusinessType` → `schema.prisma:L9430`
- `CatalogItemPrice` → `schema.prisma:L9518`
- `CatalogManufacturer` → `schema.prisma:L9311`
- `CatalogProductTypeMapping` → `schema.prisma:L9447`
- `CatalogPublicationBatch` → `schema.prisma:L9898`
- `CatalogPublicationFieldDecision` → `schema.prisma:L9992`
- `CatalogPublicationLine` → `schema.prisma:L9939`
- `CatalogPublicationOutbox` → `schema.prisma:L10035`
- `CatalogValidationProfile` → `schema.prisma:L9489`
- `CatalogVenueBinding` → `schema.prisma:L9647`
- `CatalogVenueClientRequirement` → `schema.prisma:L9574`
- `CatalogVenueEventSequence` → `schema.prisma:L10018`
- `CatalogVenueOverride` → `schema.prisma:L9689`
- `CatalogVenueRollout` → `schema.prisma:L9549`
- `Cfdi` → `schema.prisma:L14229`
- `ChatbotTokenBudget` → `schema.prisma:L8086`
- `ChatConversation` → `schema.prisma:L7941`
- `ChatFeedback` → `schema.prisma:L8027`
- `ChatLearningEvent` → `schema.prisma:L7984`
- `ChatMessage` → `schema.prisma:L7964`
- `ChatTrainingData` → `schema.prisma:L7898`
- `CheckoutSession` → `schema.prisma:L4933`
- `ClassSession` → `schema.prisma:L11916`
- `CommissionCalculation` → `schema.prisma:L10705`
- `CommissionClawback` → `schema.prisma:L10878`
- `CommissionConfig` → `schema.prisma:L10478`
- `CommissionMilestone` → `schema.prisma:L10621`
- `CommissionOverride` → `schema.prisma:L10548`
- `CommissionPayout` → `schema.prisma:L10829`
- `CommissionSummary` → `schema.prisma:L10768`
- `CommissionTier` → `schema.prisma:L10585`
- `Consumer` → `schema.prisma:L6080`
- `ConsumerAuthAccount` → `schema.prisma:L6105`
- `CouponCode` → `schema.prisma:L6708`
- `CouponRedemption` → `schema.prisma:L6739`
- `CreditAssessmentHistory` → `schema.prisma:L8912`
- `CreditItemBalance` → `schema.prisma:L12507`
- `CreditOffer` → `schema.prisma:L8931`
- `CreditPack` → `schema.prisma:L12423`
- `CreditPackItem` → `schema.prisma:L12452`
- `CreditPackPurchase` → `schema.prisma:L12469`
- `CreditTransaction` → `schema.prisma:L12529`
- `Customer` → `schema.prisma:L5985`
- `CustomerDiscount` → `schema.prisma:L6759`
- `CustomerGroup` → `schema.prisma:L6139`
- `CustomerTaxProfile` → `schema.prisma:L14298`
- `DeliveryActivationRequest` → `schema.prisma:L5255`
- `DeliveryChannelLink` → `schema.prisma:L5219`
- `DeliveryOrderEvent` → `schema.prisma:L5279`
- `DeviceToken` → `schema.prisma:L7028`
- `DigitalReceipt` → `schema.prisma:L3654`
- `Discount` → `schema.prisma:L6411`
- `EcommerceMerchant` → `schema.prisma:L4745`
- `EmailTemplate` → `schema.prisma:L11221`
- `Employee` → `schema.prisma:L14813`
- `Estimate` → `schema.prisma:L12811`
- `EstimateItem` → `schema.prisma:L12839`
- `Expense` → `schema.prisma:L14600`
- `ExternalBusyBlock` → `schema.prisma:L12191`
- `Feature` → `schema.prisma:L3783`
- `FeeSchedule` → `schema.prisma:L3861`
- `FeeTier` → `schema.prisma:L3872`
- `FinancialAccount` → `schema.prisma:L13001`
- `FinancialConnection` → `schema.prisma:L12970`
- `FinancialProvider` → `schema.prisma:L12956`
- `FiscalEmisor` → `schema.prisma:L14152`
- `FiscalLossCarryforward` → `schema.prisma:L14723`
- `FixedAsset` → `schema.prisma:L14741`
- `FixedAssetDepreciation` → `schema.prisma:L14770`
- `FloorElement` → `schema.prisma:L2776`
- `FulfillmentArea` → `schema.prisma:L13212`
- `GeofenceRule` → `schema.prisma:L8523`
- `GoogleCalendarChannel` → `schema.prisma:L12168`
- `GoogleCalendarConnection` → `schema.prisma:L12120`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12221`
- `GoogleOAuthSession` → `schema.prisma:L12243`
- `HolidayCalendar` → `schema.prisma:L5868`
- `IdempotencyRequest` → `schema.prisma:L10353`
- `InterVenueTransfer` → `schema.prisma:L2528`
- `InterVenueTransferAllocation` → `schema.prisma:L2611`
- `InterVenueTransferItem` → `schema.prisma:L2580`
- `InterVenueTransferReceipt` → `schema.prisma:L2638`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2654`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2682`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2666`
- `Inventory` → `schema.prisma:L1748`
- `InventoryMovement` → `schema.prisma:L1775`
- `InventoryPosting` → `schema.prisma:L1857`
- `InventoryPostingLine` → `schema.prisma:L1891`
- `InventoryTransfer` → `schema.prisma:L12783`
- `Invitation` → `schema.prisma:L1299`
- `Invoice` → `schema.prisma:L3884`
- `InvoiceItem` → `schema.prisma:L3910`
- `ItemCategory` → `schema.prisma:L10070`
- `JournalEntry` → `schema.prisma:L14510`
- `JournalLine` → `schema.prisma:L14538`
- `KdsOrder` → `schema.prisma:L13049`
- `KdsOrderItem` → `schema.prisma:L13066`
- `LearnedPatterns` → `schema.prisma:L8008`
- `LedgerAccount` → `schema.prisma:L14402`
- `LiveDemoSession` → `schema.prisma:L755`
- `LowStockAlert` → `schema.prisma:L2382`
- `LoyaltyConfig` → `schema.prisma:L6169`
- `LoyaltyTransaction` → `schema.prisma:L6192`
- `MarketingCampaign` → `schema.prisma:L11239`
- `McpAuthCode` → `schema.prisma:L14035`
- `McpOAuthClient` → `schema.prisma:L14019`
- `McpRefreshToken` → `schema.prisma:L14053`
- `McpToolCall` → `schema.prisma:L14074`
- `MeasurementUnit` → `schema.prisma:L12889`
- `Menu` → `schema.prisma:L1485`
- `MenuCategory` → `schema.prisma:L1422`
- `MenuCategoryAssignment` → `schema.prisma:L1520`
- `MercadoPagoWebhookEvent` → `schema.prisma:L13949`
- `MerchantAccount` → `schema.prisma:L4483`
- `MerchantFiscalConfig` → `schema.prisma:L14200`
- `MerchantRevenueShare` → `schema.prisma:L5448`
- `MerchantRoutingRule` → `schema.prisma:L4605`
- `MilestoneAchievement` → `schema.prisma:L10666`
- `Modifier` → `schema.prisma:L3383`
- `ModifierGroup` → `schema.prisma:L3347`
- `Module` → `schema.prisma:L8979`
- `MoneyAnomaly` → `schema.prisma:L5351`
- `MonthlyVenueProfit` → `schema.prisma:L5894`
- `Notification` → `schema.prisma:L6930`
- `NotificationPreference` → `schema.prisma:L6977`
- `NotificationTemplate` → `schema.prisma:L7004`
- `OAuthState` → `schema.prisma:L1350`
- `OnboardingProgress` → `schema.prisma:L1368`
- `Order` → `schema.prisma:L3007`
- `OrderAction` → `schema.prisma:L3448`
- `OrderCustomer` → `schema.prisma:L3204`
- `OrderDiscount` → `schema.prisma:L6791`
- `OrderFulfillment` → `schema.prisma:L13267`
- `OrderFulfillmentLine` → `schema.prisma:L13298`
- `OrderItem` → `schema.prisma:L3220`
- `OrderItemModifier` → `schema.prisma:L3432`
- `OrderServiceCharge` → `schema.prisma:L6875`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11040`
- `OrganizationEntitlement` → `schema.prisma:L9262`
- `OrganizationGoal` → `schema.prisma:L10998`
- `OrganizationModule` → `schema.prisma:L9039`
- `OrganizationPaymentConfig` → `schema.prisma:L5057`
- `OrganizationPayoutConfig` → `schema.prisma:L11073`
- `OrganizationPricingStructure` → `schema.prisma:L5089`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11021`
- `OtpChallenge` → `schema.prisma:L6124`
- `PartnerAPIKey` → `schema.prisma:L4887`
- `Payment` → `schema.prisma:L3481`
- `PaymentAllocation` → `schema.prisma:L3633`
- `PaymentLink` → `schema.prisma:L12575`
- `PaymentLinkAttribution` → `schema.prisma:L12683`
- `PaymentLinkItem` → `schema.prisma:L12638`
- `PaymentLinkItemModifier` → `schema.prisma:L12665`
- `PaymentProvider` → `schema.prisma:L4442`
- `PayrollLine` → `schema.prisma:L14884`
- `PayrollRun` → `schema.prisma:L14853`
- `PerformanceGoal` → `schema.prisma:L10975`
- `PermissionSet` → `schema.prisma:L1250`
- `PlatformCfdi` → `schema.prisma:L15169`
- `PlatformEmisor` → `schema.prisma:L15109`
- `PlatformSettings` → `schema.prisma:L4864`
- `PosCommand` → `schema.prisma:L7058`
- `PosConnectionStatus` → `schema.prisma:L848`
- `PosSyncIntent` → `schema.prisma:L15247`
- `PricingPolicy` → `schema.prisma:L2293`
- `Printer` → `schema.prisma:L13095`
- `PrintGateway` → `schema.prisma:L13148`
- `PrintJob` → `schema.prisma:L13848`
- `PrintStation` → `schema.prisma:L13166`
- `ProcessedStripeEvent` → `schema.prisma:L5337`
- `ProcessorReliabilityMetric` → `schema.prisma:L5822`
- `Product` → `schema.prisma:L1538`
- `ProductModifierGroup` → `schema.prisma:L3420`
- `ProductOption` → `schema.prisma:L12866`
- `ProductOptionValue` → `schema.prisma:L12877`
- `ProductStaff` → `schema.prisma:L11831`
- `PromoterBankAccount` → `schema.prisma:L15004`
- `PromoterCommissionEntry` → `schema.prisma:L15023`
- `PromoterLocationPing` → `schema.prisma:L2973`
- `ProviderCostStructure` → `schema.prisma:L5373`
- `ProviderEventLog` → `schema.prisma:L5166`
- `PurchaseOrder` → `schema.prisma:L2161`
- `PurchaseOrderItem` → `schema.prisma:L2218`
- `RateCorrectionBatch` → `schema.prisma:L5598`
- `RateCorrectionEntry` → `schema.prisma:L5640`
- `RawMaterial` → `schema.prisma:L1922`
- `RawMaterialMovement` → `schema.prisma:L2346`
- `RawMaterialPresentation` → `schema.prisma:L1995`
- `Recipe` → `schema.prisma:L2015`
- `RecipeLine` → `schema.prisma:L2039`
- `Referral` → `schema.prisma:L6259`
- `ReferralProgramConfig` → `schema.prisma:L6224`
- `ReferralRewardGrant` → `schema.prisma:L6350`
- `ReferralTierReward` → `schema.prisma:L6322`
- `ReferralTierUnlock` → `schema.prisma:L6395`
- `Reservation` → `schema.prisma:L11618`
- `ReservationGoogleEventMapping` → `schema.prisma:L12355`
- `ReservationModifier` → `schema.prisma:L11779`
- `ReservationReminderSent` → `schema.prisma:L11762`
- `ReservationSettings` → `schema.prisma:L11993`
- `ReservationWaitlistEntry` → `schema.prisma:L11961`
- `Review` → `schema.prisma:L3928`
- `SalesRetention` → `schema.prisma:L14704`
- `SaleVerification` → `schema.prisma:L3687`
- `ScaleProfile` → `schema.prisma:L13589`
- `ScheduledCommand` → `schema.prisma:L8483`
- `SerializedItem` → `schema.prisma:L10113`
- `SerializedItemCustodyEvent` → `schema.prisma:L10276`
- `ServiceCharge` → `schema.prisma:L6846`
- `SettlementConfiguration` → `schema.prisma:L5673`
- `SettlementConfirmation` → `schema.prisma:L5786`
- `SettlementIncident` → `schema.prisma:L5737`
- `SettlementSimulation` → `schema.prisma:L5708`
- `Shift` → `schema.prisma:L2814`
- `SimRegistrationRequest` → `schema.prisma:L10314`
- `SimRegistrationRequestItem` → `schema.prisma:L10336`
- `SlotHold` → `schema.prisma:L11862`
- `Staff` → `schema.prisma:L868`
- `StaffOnboardingState` → `schema.prisma:L13919`
- `StaffOrganization` → `schema.prisma:L1164`
- `StaffPasskey` → `schema.prisma:L1191`
- `StaffSchedule` → `schema.prisma:L11802`
- `StaffScheduleException` → `schema.prisma:L11814`
- `StaffVenue` → `schema.prisma:L1094`
- `StockAlertConfig` → `schema.prisma:L10957`
- `StockBatch` → `schema.prisma:L2477`
- `StockCount` → `schema.prisma:L2414`
- `StockCountItem` → `schema.prisma:L2435`
- `StripeWebhookEvent` → `schema.prisma:L5320`
- `Supplier` → `schema.prisma:L2074`
- `SupplierPricing` → `schema.prisma:L2127`
- `Table` → `schema.prisma:L2726`
- `Terminal` → `schema.prisma:L3979`
- `TerminalHealth` → `schema.prisma:L4218`
- `TerminalLog` → `schema.prisma:L4192`
- `TerminalOrder` → `schema.prisma:L4345`
- `TerminalOrderItem` → `schema.prisma:L4420`
- `TerminalPaymentRequest` → `schema.prisma:L4289`
- `TimeEntry` → `schema.prisma:L2886`
- `TimeEntryBreak` → `schema.prisma:L2955`
- `TokenPurchase` → `schema.prisma:L8157`
- `TokenUsageRecord` → `schema.prisma:L8129`
- `TpvCommandHistory` → `schema.prisma:L8389`
- `TpvCommandQueue` → `schema.prisma:L8329`
- `TpvFeedback` → `schema.prisma:L8042`
- `TpvMessage` → `schema.prisma:L11314`
- `TpvMessageDelivery` → `schema.prisma:L11366`
- `TpvMessageResponse` → `schema.prisma:L11389`
- `TrainingModule` → `schema.prisma:L11444`
- `TrainingProgress` → `schema.prisma:L11521`
- `TrainingQuizQuestion` → `schema.prisma:L11503`
- `TrainingStep` → `schema.prisma:L11483`
- `TransactionCost` → `schema.prisma:L5536`
- `UnitConversion` → `schema.prisma:L2324`
- `UpsellAcceptance` → `schema.prisma:L6667`
- `UpsellAiRun` → `schema.prisma:L6687`
- `UpsellImpression` → `schema.prisma:L6627`
- `UpsellRule` → `schema.prisma:L6557`
- `user_sessions` → `schema.prisma:L4922`
- `Venue` → `schema.prisma:L147`
- `VenueAreaTicketSettings` → `schema.prisma:L13326`
- `VenueChatMessage` → `schema.prisma:L731`
- `VenueChatSession` → `schema.prisma:L686`
- `VenueCommission` → `schema.prisma:L13027`
- `VenueCreditAssessment` → `schema.prisma:L8851`
- `VenueCryptoConfig` → `schema.prisma:L11181`
- `VenueFeature` → `schema.prisma:L3801`
- `VenueModule` → `schema.prisma:L9011`
- `VenuePaymentConfig` → `schema.prisma:L5023`
- `VenuePaymentLinkSettings` → `schema.prisma:L12388`
- `VenuePricingStructure` → `schema.prisma:L5476`
- `VenueRoleConfig` → `schema.prisma:L1279`
- `VenueRolePermission` → `schema.prisma:L1221`
- `VenueScaleSettings` → `schema.prisma:L13577`
- `VenueSettings` → `schema.prisma:L771`
- `VenueTransaction` → `schema.prisma:L3738`
- `VenueWhatsappActivation` → `schema.prisma:L622`
- `WebhookEvent` → `schema.prisma:L3837`
- `WebhookSubscription` → `schema.prisma:L5139`
- `WhatsappContactWindow` → `schema.prisma:L640`
- `WhatsappInboundEvent` → `schema.prisma:L660`
- `Zone` → `schema.prisma:L130`
