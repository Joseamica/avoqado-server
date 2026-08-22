# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **331 models / 322 enums / ~15,700 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L14921`
- `AccountMapping` → `schema.prisma:L14817`
- `ActivityLog` → `schema.prisma:L6223`
- `Aggregator` → `schema.prisma:L13218`
- `AngelPayUserAccount` → `schema.prisma:L4886`
- `AppUpdate` → `schema.prisma:L11438`
- `Area` → `schema.prisma:L2797`
- `AreaTicket` → `schema.prisma:L13712`
- `AreaTicketCheckoutSession` → `schema.prisma:L13834`
- `AreaTicketExternalIncident` → `schema.prisma:L14081`
- `AreaTicketExternalSettlement` → `schema.prisma:L14046`
- `AreaTicketFulfillment` → `schema.prisma:L13910`
- `AreaTicketInventoryReservation` → `schema.prisma:L13805`
- `AreaTicketLine` → `schema.prisma:L13773`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13866`
- `AreaTicketPrintAttempt` → `schema.prisma:L13889`
- `BankStatement` → `schema.prisma:L14691`
- `BankStatementLine` → `schema.prisma:L14712`
- `BillingTaxProfile` → `schema.prisma:L15501`
- `BulkCommandOperation` → `schema.prisma:L8751`
- `CalendarSyncOutbox` → `schema.prisma:L12612`
- `CampaignDelivery` → `schema.prisma:L11596`
- `CashCloseout` → `schema.prisma:L9116`
- `CashDeposit` → `schema.prisma:L11240`
- `CashDrawerEvent` → `schema.prisma:L13055`
- `CashDrawerSession` → `schema.prisma:L13031`
- `CashOutCommissionRate` → `schema.prisma:L15330`
- `CashOutScheduleDay` → `schema.prisma:L15353`
- `CashOutWithdrawal` → `schema.prisma:L15415`
- `CatalogBindingBatch` → `schema.prisma:L10147`
- `CatalogBindingLine` → `schema.prisma:L10183`
- `CatalogBrand` → `schema.prisma:L9600`
- `CatalogClientObservation` → `schema.prisma:L9913`
- `CatalogClientReadinessOverride` → `schema.prisma:L9932`
- `CatalogFamily` → `schema.prisma:L9650`
- `CatalogIdempotencyRecord` → `schema.prisma:L10046`
- `CatalogIdentifier` → `schema.prisma:L9781`
- `CatalogImportBatch` → `schema.prisma:L10089`
- `CatalogImportLine` → `schema.prisma:L10126`
- `CatalogItem` → `schema.prisma:L9683`
- `CatalogItemBusinessType` → `schema.prisma:L9743`
- `CatalogItemPrice` → `schema.prisma:L9831`
- `CatalogManufacturer` → `schema.prisma:L9624`
- `CatalogProductTypeMapping` → `schema.prisma:L9760`
- `CatalogPublicationBatch` → `schema.prisma:L10211`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10305`
- `CatalogPublicationLine` → `schema.prisma:L10252`
- `CatalogPublicationOutbox` → `schema.prisma:L10348`
- `CatalogValidationProfile` → `schema.prisma:L9802`
- `CatalogVenueBinding` → `schema.prisma:L9960`
- `CatalogVenueClientRequirement` → `schema.prisma:L9887`
- `CatalogVenueEventSequence` → `schema.prisma:L10331`
- `CatalogVenueOverride` → `schema.prisma:L10002`
- `CatalogVenueRollout` → `schema.prisma:L9862`
- `Cfdi` → `schema.prisma:L14594`
- `ChatbotTokenBudget` → `schema.prisma:L8399`
- `ChatConversation` → `schema.prisma:L8254`
- `ChatFeedback` → `schema.prisma:L8340`
- `ChatLearningEvent` → `schema.prisma:L8297`
- `ChatMessage` → `schema.prisma:L8277`
- `ChatTrainingData` → `schema.prisma:L8211`
- `CheckoutSession` → `schema.prisma:L5166`
- `ClassSession` → `schema.prisma:L12230`
- `CommissionCalculation` → `schema.prisma:L11019`
- `CommissionClawback` → `schema.prisma:L11192`
- `CommissionConfig` → `schema.prisma:L10792`
- `CommissionMilestone` → `schema.prisma:L10935`
- `CommissionOverride` → `schema.prisma:L10862`
- `CommissionPayout` → `schema.prisma:L11143`
- `CommissionSummary` → `schema.prisma:L11082`
- `CommissionTier` → `schema.prisma:L10899`
- `Consumer` → `schema.prisma:L6359`
- `ConsumerAuthAccount` → `schema.prisma:L6384`
- `CouponCode` → `schema.prisma:L7005`
- `CouponRedemption` → `schema.prisma:L7036`
- `CreditAssessmentHistory` → `schema.prisma:L9225`
- `CreditItemBalance` → `schema.prisma:L12821`
- `CreditOffer` → `schema.prisma:L9244`
- `CreditPack` → `schema.prisma:L12737`
- `CreditPackItem` → `schema.prisma:L12766`
- `CreditPackPurchase` → `schema.prisma:L12783`
- `CreditTransaction` → `schema.prisma:L12843`
- `Customer` → `schema.prisma:L6264`
- `CustomerDiscount` → `schema.prisma:L7056`
- `CustomerGroup` → `schema.prisma:L6423`
- `CustomerTaxProfile` → `schema.prisma:L14663`
- `DeliveryActivationRequest` → `schema.prisma:L5507`
- `DeliveryChannelLink` → `schema.prisma:L5452`
- `DeliveryOrderEvent` → `schema.prisma:L5531`
- `DeviceToken` → `schema.prisma:L7325`
- `DigitalReceipt` → `schema.prisma:L3881`
- `Discount` → `schema.prisma:L6695`
- `EcommerceMerchant` → `schema.prisma:L4978`
- `EmailTemplate` → `schema.prisma:L11535`
- `Employee` → `schema.prisma:L15178`
- `Estimate` → `schema.prisma:L13125`
- `EstimateItem` → `schema.prisma:L13153`
- `Expense` → `schema.prisma:L14965`
- `ExternalBusyBlock` → `schema.prisma:L12505`
- `Feature` → `schema.prisma:L4010`
- `FeeSchedule` → `schema.prisma:L4088`
- `FeeTier` → `schema.prisma:L4099`
- `FinancialAccount` → `schema.prisma:L13315`
- `FinancialConnection` → `schema.prisma:L13284`
- `FinancialProvider` → `schema.prisma:L13270`
- `FiscalEmisor` → `schema.prisma:L14517`
- `FiscalLossCarryforward` → `schema.prisma:L15088`
- `FixedAsset` → `schema.prisma:L15106`
- `FixedAssetDepreciation` → `schema.prisma:L15135`
- `FloorElement` → `schema.prisma:L2873`
- `FulfillmentArea` → `schema.prisma:L13577`
- `GeofenceRule` → `schema.prisma:L8836`
- `GoogleCalendarChannel` → `schema.prisma:L12482`
- `GoogleCalendarConnection` → `schema.prisma:L12434`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12535`
- `GoogleOAuthSession` → `schema.prisma:L12557`
- `HolidayCalendar` → `schema.prisma:L6147`
- `IdempotencyRequest` → `schema.prisma:L10667`
- `InterVenueTransfer` → `schema.prisma:L2625`
- `InterVenueTransferAllocation` → `schema.prisma:L2708`
- `InterVenueTransferItem` → `schema.prisma:L2677`
- `InterVenueTransferReceipt` → `schema.prisma:L2735`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2751`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2779`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2763`
- `Inventory` → `schema.prisma:L1818`
- `InventoryMovement` → `schema.prisma:L1845`
- `InventoryPosting` → `schema.prisma:L1927`
- `InventoryPostingLine` → `schema.prisma:L1967`
- `InventoryTransfer` → `schema.prisma:L13097`
- `Invitation` → `schema.prisma:L1366`
- `Invoice` → `schema.prisma:L4111`
- `InvoiceItem` → `schema.prisma:L4137`
- `ItemCategory` → `schema.prisma:L10383`
- `JournalEntry` → `schema.prisma:L14875`
- `JournalLine` → `schema.prisma:L14903`
- `KdsOrder` → `schema.prisma:L13363`
- `KdsOrderItem` → `schema.prisma:L13404`
- `LearnedPatterns` → `schema.prisma:L8321`
- `LedgerAccount` → `schema.prisma:L14767`
- `LiveDemoSession` → `schema.prisma:L771`
- `LowStockAlert` → `schema.prisma:L2466`
- `LoyaltyConfig` → `schema.prisma:L6453`
- `LoyaltyTransaction` → `schema.prisma:L6476`
- `MarketingCampaign` → `schema.prisma:L11553`
- `McpAuthCode` → `schema.prisma:L14400`
- `McpOAuthClient` → `schema.prisma:L14384`
- `McpRefreshToken` → `schema.prisma:L14418`
- `McpToolCall` → `schema.prisma:L14439`
- `MeasurementUnit` → `schema.prisma:L13203`
- `Menu` → `schema.prisma:L1552`
- `MenuCategory` → `schema.prisma:L1489`
- `MenuCategoryAssignment` → `schema.prisma:L1587`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14314`
- `MerchantAccount` → `schema.prisma:L4716`
- `MerchantFiscalConfig` → `schema.prisma:L14565`
- `MerchantRevenueShare` → `schema.prisma:L5727`
- `MerchantRoutingRule` → `schema.prisma:L4838`
- `MilestoneAchievement` → `schema.prisma:L10980`
- `Modifier` → `schema.prisma:L3497`
- `ModifierGroup` → `schema.prisma:L3461`
- `Module` → `schema.prisma:L9292`
- `MoneyAnomaly` → `schema.prisma:L5630`
- `MonthlyVenueProfit` → `schema.prisma:L6173`
- `Notification` → `schema.prisma:L7227`
- `NotificationPreference` → `schema.prisma:L7274`
- `NotificationTemplate` → `schema.prisma:L7301`
- `OAuthState` → `schema.prisma:L1417`
- `OnboardingProgress` → `schema.prisma:L1435`
- `Order` → `schema.prisma:L3104`
- `OrderAction` → `schema.prisma:L3562`
- `OrderCustomer` → `schema.prisma:L3312`
- `OrderDiscount` → `schema.prisma:L7088`
- `OrderFulfillment` → `schema.prisma:L13632`
- `OrderFulfillmentLine` → `schema.prisma:L13663`
- `OrderItem` → `schema.prisma:L3328`
- `OrderItemModifier` → `schema.prisma:L3546`
- `OrderPromotion` → `schema.prisma:L15741`
- `OrderServiceCharge` → `schema.prisma:L7172`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11354`
- `OrganizationEntitlement` → `schema.prisma:L9575`
- `OrganizationGoal` → `schema.prisma:L11312`
- `OrganizationModule` → `schema.prisma:L9352`
- `OrganizationPaymentConfig` → `schema.prisma:L5290`
- `OrganizationPayoutConfig` → `schema.prisma:L11387`
- `OrganizationPricingStructure` → `schema.prisma:L5322`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11335`
- `OtpChallenge` → `schema.prisma:L6403`
- `PartnerAPIKey` → `schema.prisma:L5120`
- `Payment` → `schema.prisma:L3595`
- `PaymentAllocation` → `schema.prisma:L3860`
- `PaymentLink` → `schema.prisma:L12889`
- `PaymentLinkAttribution` → `schema.prisma:L12997`
- `PaymentLinkItem` → `schema.prisma:L12952`
- `PaymentLinkItemModifier` → `schema.prisma:L12979`
- `PaymentProvider` → `schema.prisma:L4675`
- `PayrollLine` → `schema.prisma:L15249`
- `PayrollRun` → `schema.prisma:L15218`
- `PerformanceGoal` → `schema.prisma:L11289`
- `PermissionOverride` → `schema.prisma:L1294`
- `PermissionSet` → `schema.prisma:L1317`
- `PlatformCfdi` → `schema.prisma:L15534`
- `PlatformEmisor` → `schema.prisma:L15474`
- `PlatformSettings` → `schema.prisma:L5097`
- `PosCommand` → `schema.prisma:L7355`
- `PosConnectionStatus` → `schema.prisma:L877`
- `PosSyncIntent` → `schema.prisma:L15612`
- `PricingPolicy` → `schema.prisma:L2370`
- `Printer` → `schema.prisma:L13446`
- `PrintGateway` → `schema.prisma:L13499`
- `PrintJob` → `schema.prisma:L14213`
- `PrintStation` → `schema.prisma:L13517`
- `ProcessedStripeEvent` → `schema.prisma:L5616`
- `ProcessorReliabilityMetric` → `schema.prisma:L6101`
- `Product` → `schema.prisma:L1605`
- `ProductModifierGroup` → `schema.prisma:L3534`
- `ProductOption` → `schema.prisma:L13180`
- `ProductOptionValue` → `schema.prisma:L13191`
- `ProductStaff` → `schema.prisma:L12145`
- `PromoterBankAccount` → `schema.prisma:L15369`
- `PromoterCommissionEntry` → `schema.prisma:L15388`
- `PromoterLocationPing` → `schema.prisma:L3070`
- `Promotion` → `schema.prisma:L15663`
- `PromotionGroup` → `schema.prisma:L15702`
- `PromotionOption` → `schema.prisma:L15718`
- `ProviderCostStructure` → `schema.prisma:L5652`
- `ProviderEventLog` → `schema.prisma:L5399`
- `PurchaseOrder` → `schema.prisma:L2238`
- `PurchaseOrderItem` → `schema.prisma:L2295`
- `RateCorrectionBatch` → `schema.prisma:L5877`
- `RateCorrectionEntry` → `schema.prisma:L5919`
- `RawMaterial` → `schema.prisma:L1999`
- `RawMaterialMovement` → `schema.prisma:L2423`
- `RawMaterialPresentation` → `schema.prisma:L2072`
- `Recipe` → `schema.prisma:L2092`
- `RecipeLine` → `schema.prisma:L2116`
- `Referral` → `schema.prisma:L6543`
- `ReferralProgramConfig` → `schema.prisma:L6508`
- `ReferralRewardGrant` → `schema.prisma:L6634`
- `ReferralTierReward` → `schema.prisma:L6606`
- `ReferralTierUnlock` → `schema.prisma:L6679`
- `Reservation` → `schema.prisma:L11932`
- `ReservationGoogleEventMapping` → `schema.prisma:L12669`
- `ReservationModifier` → `schema.prisma:L12093`
- `ReservationReminderSent` → `schema.prisma:L12076`
- `ReservationSettings` → `schema.prisma:L12307`
- `ReservationWaitlistEntry` → `schema.prisma:L12275`
- `Review` → `schema.prisma:L4155`
- `SalesRetention` → `schema.prisma:L15069`
- `SaleVerification` → `schema.prisma:L3914`
- `ScaleProfile` → `schema.prisma:L13954`
- `ScheduledCommand` → `schema.prisma:L8796`
- `SerializedItem` → `schema.prisma:L10426`
- `SerializedItemCustodyEvent` → `schema.prisma:L10590`
- `ServiceCharge` → `schema.prisma:L7143`
- `SettlementConfiguration` → `schema.prisma:L5952`
- `SettlementConfirmation` → `schema.prisma:L6065`
- `SettlementIncident` → `schema.prisma:L6016`
- `SettlementSimulation` → `schema.prisma:L5987`
- `Shift` → `schema.prisma:L2911`
- `SimRegistrationRequest` → `schema.prisma:L10628`
- `SimRegistrationRequestItem` → `schema.prisma:L10650`
- `SlotHold` → `schema.prisma:L12176`
- `Staff` → `schema.prisma:L897`
- `StaffOnboardingState` → `schema.prisma:L14284`
- `StaffOrganization` → `schema.prisma:L1193`
- `StaffPasskey` → `schema.prisma:L1220`
- `StaffSchedule` → `schema.prisma:L12116`
- `StaffScheduleException` → `schema.prisma:L12128`
- `StaffVenue` → `schema.prisma:L1123`
- `StockAlertConfig` → `schema.prisma:L11271`
- `StockBatch` → `schema.prisma:L2574`
- `StockCount` → `schema.prisma:L2498`
- `StockCountItem` → `schema.prisma:L2522`
- `StripeWebhookEvent` → `schema.prisma:L5599`
- `Supplier` → `schema.prisma:L2151`
- `SupplierPricing` → `schema.prisma:L2204`
- `Table` → `schema.prisma:L2823`
- `Terminal` → `schema.prisma:L4206`
- `TerminalHealth` → `schema.prisma:L4445`
- `TerminalLog` → `schema.prisma:L4419`
- `TerminalOrder` → `schema.prisma:L4578`
- `TerminalOrderItem` → `schema.prisma:L4653`
- `TerminalPaymentRequest` → `schema.prisma:L4516`
- `TimeEntry` → `schema.prisma:L2983`
- `TimeEntryBreak` → `schema.prisma:L3052`
- `TokenPurchase` → `schema.prisma:L8470`
- `TokenUsageRecord` → `schema.prisma:L8442`
- `TpvCommandHistory` → `schema.prisma:L8702`
- `TpvCommandQueue` → `schema.prisma:L8642`
- `TpvFeedback` → `schema.prisma:L8355`
- `TpvMessage` → `schema.prisma:L11628`
- `TpvMessageDelivery` → `schema.prisma:L11680`
- `TpvMessageResponse` → `schema.prisma:L11703`
- `TrainingModule` → `schema.prisma:L11758`
- `TrainingProgress` → `schema.prisma:L11835`
- `TrainingQuizQuestion` → `schema.prisma:L11817`
- `TrainingStep` → `schema.prisma:L11797`
- `TransactionCost` → `schema.prisma:L5815`
- `UnitConversion` → `schema.prisma:L2401`
- `UpsellAcceptance` → `schema.prisma:L6964`
- `UpsellAiRun` → `schema.prisma:L6984`
- `UpsellImpression` → `schema.prisma:L6924`
- `UpsellRule` → `schema.prisma:L6844`
- `user_sessions` → `schema.prisma:L5155`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L13691`
- `VenueChatMessage` → `schema.prisma:L747`
- `VenueChatSession` → `schema.prisma:L702`
- `VenueCommission` → `schema.prisma:L13341`
- `VenueCreditAssessment` → `schema.prisma:L9164`
- `VenueCryptoConfig` → `schema.prisma:L11495`
- `VenueFeature` → `schema.prisma:L4028`
- `VenueModule` → `schema.prisma:L9324`
- `VenuePaymentConfig` → `schema.prisma:L5256`
- `VenuePaymentLinkSettings` → `schema.prisma:L12702`
- `VenuePricingStructure` → `schema.prisma:L5755`
- `VenueRoleConfig` → `schema.prisma:L1346`
- `VenueRolePermission` → `schema.prisma:L1250`
- `VenueScaleSettings` → `schema.prisma:L13942`
- `VenueSettings` → `schema.prisma:L787`
- `VenueTenderType` → `schema.prisma:L3773`
- `VenueTenderTypeRevision` → `schema.prisma:L3838`
- `VenueTransaction` → `schema.prisma:L3965`
- `VenueWhatsappActivation` → `schema.prisma:L638`
- `WebhookEvent` → `schema.prisma:L4064`
- `WebhookSubscription` → `schema.prisma:L5372`
- `WhatsappContactWindow` → `schema.prisma:L656`
- `WhatsappInboundEvent` → `schema.prisma:L676`
- `Zone` → `schema.prisma:L142`
