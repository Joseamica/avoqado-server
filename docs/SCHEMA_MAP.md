# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **322 models / 312 enums / ~15,100 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                                                                                                        |
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

- `AccountingPeriodLock` → `schema.prisma:L14436`
- `AccountMapping` → `schema.prisma:L14332`
- `ActivityLog` → `schema.prisma:L5834`
- `Aggregator` → `schema.prisma:L12784`
- `AngelPayUserAccount` → `schema.prisma:L4543`
- `AppUpdate` → `schema.prisma:L11013`
- `Area` → `schema.prisma:L2597`
- `AreaTicket` → `schema.prisma:L13227`
- `AreaTicketCheckoutSession` → `schema.prisma:L13349`
- `AreaTicketExternalIncident` → `schema.prisma:L13596`
- `AreaTicketExternalSettlement` → `schema.prisma:L13561`
- `AreaTicketFulfillment` → `schema.prisma:L13425`
- `AreaTicketInventoryReservation` → `schema.prisma:L13320`
- `AreaTicketLine` → `schema.prisma:L13288`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13381`
- `AreaTicketPrintAttempt` → `schema.prisma:L13404`
- `BankStatement` → `schema.prisma:L14206`
- `BankStatementLine` → `schema.prisma:L14227`
- `BillingTaxProfile` → `schema.prisma:L15016`
- `BulkCommandOperation` → `schema.prisma:L8327`
- `CalendarSyncOutbox` → `schema.prisma:L12187`
- `CampaignDelivery` → `schema.prisma:L11171`
- `CashCloseout` → `schema.prisma:L8692`
- `CashDeposit` → `schema.prisma:L10815`
- `CashDrawerEvent` → `schema.prisma:L12630`
- `CashDrawerSession` → `schema.prisma:L12606`
- `CashOutCommissionRate` → `schema.prisma:L14845`
- `CashOutScheduleDay` → `schema.prisma:L14868`
- `CashOutWithdrawal` → `schema.prisma:L14930`
- `CatalogBindingBatch` → `schema.prisma:L9723`
- `CatalogBindingLine` → `schema.prisma:L9759`
- `CatalogBrand` → `schema.prisma:L9176`
- `CatalogClientObservation` → `schema.prisma:L9489`
- `CatalogClientReadinessOverride` → `schema.prisma:L9508`
- `CatalogFamily` → `schema.prisma:L9226`
- `CatalogIdempotencyRecord` → `schema.prisma:L9622`
- `CatalogIdentifier` → `schema.prisma:L9357`
- `CatalogImportBatch` → `schema.prisma:L9665`
- `CatalogImportLine` → `schema.prisma:L9702`
- `CatalogItem` → `schema.prisma:L9259`
- `CatalogItemBusinessType` → `schema.prisma:L9319`
- `CatalogItemPrice` → `schema.prisma:L9407`
- `CatalogManufacturer` → `schema.prisma:L9200`
- `CatalogProductTypeMapping` → `schema.prisma:L9336`
- `CatalogPublicationBatch` → `schema.prisma:L9787`
- `CatalogPublicationFieldDecision` → `schema.prisma:L9881`
- `CatalogPublicationLine` → `schema.prisma:L9828`
- `CatalogPublicationOutbox` → `schema.prisma:L9924`
- `CatalogValidationProfile` → `schema.prisma:L9378`
- `CatalogVenueBinding` → `schema.prisma:L9536`
- `CatalogVenueClientRequirement` → `schema.prisma:L9463`
- `CatalogVenueEventSequence` → `schema.prisma:L9907`
- `CatalogVenueOverride` → `schema.prisma:L9578`
- `CatalogVenueRollout` → `schema.prisma:L9438`
- `Cfdi` → `schema.prisma:L14109`
- `ChatbotTokenBudget` → `schema.prisma:L7975`
- `ChatConversation` → `schema.prisma:L7830`
- `ChatFeedback` → `schema.prisma:L7916`
- `ChatLearningEvent` → `schema.prisma:L7873`
- `ChatMessage` → `schema.prisma:L7853`
- `ChatTrainingData` → `schema.prisma:L7787`
- `CheckoutSession` → `schema.prisma:L4823`
- `ClassSession` → `schema.prisma:L11805`
- `CommissionCalculation` → `schema.prisma:L10594`
- `CommissionClawback` → `schema.prisma:L10767`
- `CommissionConfig` → `schema.prisma:L10367`
- `CommissionMilestone` → `schema.prisma:L10510`
- `CommissionOverride` → `schema.prisma:L10437`
- `CommissionPayout` → `schema.prisma:L10718`
- `CommissionSummary` → `schema.prisma:L10657`
- `CommissionTier` → `schema.prisma:L10474`
- `Consumer` → `schema.prisma:L5970`
- `ConsumerAuthAccount` → `schema.prisma:L5995`
- `CouponCode` → `schema.prisma:L6598`
- `CouponRedemption` → `schema.prisma:L6629`
- `CreditAssessmentHistory` → `schema.prisma:L8801`
- `CreditItemBalance` → `schema.prisma:L12396`
- `CreditOffer` → `schema.prisma:L8820`
- `CreditPack` → `schema.prisma:L12312`
- `CreditPackItem` → `schema.prisma:L12341`
- `CreditPackPurchase` → `schema.prisma:L12358`
- `CreditTransaction` → `schema.prisma:L12418`
- `Customer` → `schema.prisma:L5875`
- `CustomerDiscount` → `schema.prisma:L6649`
- `CustomerGroup` → `schema.prisma:L6029`
- `CustomerTaxProfile` → `schema.prisma:L14178`
- `DeliveryActivationRequest` → `schema.prisma:L5145`
- `DeliveryChannelLink` → `schema.prisma:L5109`
- `DeliveryOrderEvent` → `schema.prisma:L5169`
- `DeviceToken` → `schema.prisma:L6918`
- `DigitalReceipt` → `schema.prisma:L3544`
- `Discount` → `schema.prisma:L6301`
- `EcommerceMerchant` → `schema.prisma:L4635`
- `EmailTemplate` → `schema.prisma:L11110`
- `Employee` → `schema.prisma:L14693`
- `Estimate` → `schema.prisma:L12691`
- `EstimateItem` → `schema.prisma:L12719`
- `Expense` → `schema.prisma:L14480`
- `ExternalBusyBlock` → `schema.prisma:L12080`
- `Feature` → `schema.prisma:L3673`
- `FeeSchedule` → `schema.prisma:L3751`
- `FeeTier` → `schema.prisma:L3762`
- `FinancialAccount` → `schema.prisma:L12881`
- `FinancialConnection` → `schema.prisma:L12850`
- `FinancialProvider` → `schema.prisma:L12836`
- `FiscalEmisor` → `schema.prisma:L14032`
- `FiscalLossCarryforward` → `schema.prisma:L14603`
- `FixedAsset` → `schema.prisma:L14621`
- `FixedAssetDepreciation` → `schema.prisma:L14650`
- `FloorElement` → `schema.prisma:L2673`
- `FulfillmentArea` → `schema.prisma:L13092`
- `GeofenceRule` → `schema.prisma:L8412`
- `GoogleCalendarChannel` → `schema.prisma:L12057`
- `GoogleCalendarConnection` → `schema.prisma:L12009`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12110`
- `GoogleOAuthSession` → `schema.prisma:L12132`
- `HolidayCalendar` → `schema.prisma:L5758`
- `IdempotencyRequest` → `schema.prisma:L10242`
- `InterVenueTransfer` → `schema.prisma:L2425`
- `InterVenueTransferAllocation` → `schema.prisma:L2508`
- `InterVenueTransferItem` → `schema.prisma:L2477`
- `InterVenueTransferReceipt` → `schema.prisma:L2535`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2551`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2579`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2563`
- `Inventory` → `schema.prisma:L1748`
- `InventoryMovement` → `schema.prisma:L1775`
- `InventoryTransfer` → `schema.prisma:L12663`
- `Invitation` → `schema.prisma:L1299`
- `Invoice` → `schema.prisma:L3774`
- `InvoiceItem` → `schema.prisma:L3800`
- `ItemCategory` → `schema.prisma:L9959`
- `JournalEntry` → `schema.prisma:L14390`
- `JournalLine` → `schema.prisma:L14418`
- `KdsOrder` → `schema.prisma:L12929`
- `KdsOrderItem` → `schema.prisma:L12946`
- `LearnedPatterns` → `schema.prisma:L7897`
- `LedgerAccount` → `schema.prisma:L14282`
- `LiveDemoSession` → `schema.prisma:L755`
- `LowStockAlert` → `schema.prisma:L2279`
- `LoyaltyConfig` → `schema.prisma:L6059`
- `LoyaltyTransaction` → `schema.prisma:L6082`
- `MarketingCampaign` → `schema.prisma:L11128`
- `McpAuthCode` → `schema.prisma:L13915`
- `McpOAuthClient` → `schema.prisma:L13899`
- `McpRefreshToken` → `schema.prisma:L13933`
- `McpToolCall` → `schema.prisma:L13954`
- `MeasurementUnit` → `schema.prisma:L12769`
- `Menu` → `schema.prisma:L1485`
- `MenuCategory` → `schema.prisma:L1422`
- `MenuCategoryAssignment` → `schema.prisma:L1520`
- `MercadoPagoWebhookEvent` → `schema.prisma:L13829`
- `MerchantAccount` → `schema.prisma:L4373`
- `MerchantFiscalConfig` → `schema.prisma:L14080`
- `MerchantRevenueShare` → `schema.prisma:L5338`
- `MerchantRoutingRule` → `schema.prisma:L4495`
- `MilestoneAchievement` → `schema.prisma:L10555`
- `Modifier` → `schema.prisma:L3273`
- `ModifierGroup` → `schema.prisma:L3237`
- `Module` → `schema.prisma:L8868`
- `MoneyAnomaly` → `schema.prisma:L5241`
- `MonthlyVenueProfit` → `schema.prisma:L5784`
- `Notification` → `schema.prisma:L6820`
- `NotificationPreference` → `schema.prisma:L6867`
- `NotificationTemplate` → `schema.prisma:L6894`
- `OAuthState` → `schema.prisma:L1350`
- `OnboardingProgress` → `schema.prisma:L1368`
- `Order` → `schema.prisma:L2897`
- `OrderAction` → `schema.prisma:L3338`
- `OrderCustomer` → `schema.prisma:L3094`
- `OrderDiscount` → `schema.prisma:L6681`
- `OrderFulfillment` → `schema.prisma:L13147`
- `OrderFulfillmentLine` → `schema.prisma:L13178`
- `OrderItem` → `schema.prisma:L3110`
- `OrderItemModifier` → `schema.prisma:L3322`
- `OrderServiceCharge` → `schema.prisma:L6765`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L10929`
- `OrganizationEntitlement` → `schema.prisma:L9151`
- `OrganizationGoal` → `schema.prisma:L10887`
- `OrganizationModule` → `schema.prisma:L8928`
- `OrganizationPaymentConfig` → `schema.prisma:L4947`
- `OrganizationPayoutConfig` → `schema.prisma:L10962`
- `OrganizationPricingStructure` → `schema.prisma:L4979`
- `OrganizationSalesGoalConfig` → `schema.prisma:L10910`
- `OtpChallenge` → `schema.prisma:L6014`
- `PartnerAPIKey` → `schema.prisma:L4777`
- `Payment` → `schema.prisma:L3371`
- `PaymentAllocation` → `schema.prisma:L3523`
- `PaymentLink` → `schema.prisma:L12464`
- `PaymentLinkAttribution` → `schema.prisma:L12572`
- `PaymentLinkItem` → `schema.prisma:L12527`
- `PaymentLinkItemModifier` → `schema.prisma:L12554`
- `PaymentProvider` → `schema.prisma:L4332`
- `PayrollLine` → `schema.prisma:L14764`
- `PayrollRun` → `schema.prisma:L14733`
- `PerformanceGoal` → `schema.prisma:L10864`
- `PermissionSet` → `schema.prisma:L1250`
- `PlatformCfdi` → `schema.prisma:L15049`
- `PlatformEmisor` → `schema.prisma:L14989`
- `PlatformSettings` → `schema.prisma:L4754`
- `PosCommand` → `schema.prisma:L6948`
- `PosConnectionStatus` → `schema.prisma:L848`
- `PosSyncIntent` → `schema.prisma:L15127`
- `PricingPolicy` → `schema.prisma:L2190`
- `Printer` → `schema.prisma:L12975`
- `PrintGateway` → `schema.prisma:L13028`
- `PrintJob` → `schema.prisma:L13728`
- `PrintStation` → `schema.prisma:L13046`
- `ProcessedStripeEvent` → `schema.prisma:L5227`
- `ProcessorReliabilityMetric` → `schema.prisma:L5712`
- `Product` → `schema.prisma:L1538`
- `ProductModifierGroup` → `schema.prisma:L3310`
- `ProductOption` → `schema.prisma:L12746`
- `ProductOptionValue` → `schema.prisma:L12757`
- `ProductStaff` → `schema.prisma:L11720`
- `PromoterBankAccount` → `schema.prisma:L14884`
- `PromoterCommissionEntry` → `schema.prisma:L14903`
- `PromoterLocationPing` → `schema.prisma:L2863`
- `ProviderCostStructure` → `schema.prisma:L5263`
- `ProviderEventLog` → `schema.prisma:L5056`
- `PurchaseOrder` → `schema.prisma:L2058`
- `PurchaseOrderItem` → `schema.prisma:L2115`
- `RateCorrectionBatch` → `schema.prisma:L5488`
- `RateCorrectionEntry` → `schema.prisma:L5530`
- `RawMaterial` → `schema.prisma:L1819`
- `RawMaterialMovement` → `schema.prisma:L2243`
- `RawMaterialPresentation` → `schema.prisma:L1892`
- `Recipe` → `schema.prisma:L1912`
- `RecipeLine` → `schema.prisma:L1936`
- `Referral` → `schema.prisma:L6149`
- `ReferralProgramConfig` → `schema.prisma:L6114`
- `ReferralRewardGrant` → `schema.prisma:L6240`
- `ReferralTierReward` → `schema.prisma:L6212`
- `ReferralTierUnlock` → `schema.prisma:L6285`
- `Reservation` → `schema.prisma:L11507`
- `ReservationGoogleEventMapping` → `schema.prisma:L12244`
- `ReservationModifier` → `schema.prisma:L11668`
- `ReservationReminderSent` → `schema.prisma:L11651`
- `ReservationSettings` → `schema.prisma:L11882`
- `ReservationWaitlistEntry` → `schema.prisma:L11850`
- `Review` → `schema.prisma:L3818`
- `SalesRetention` → `schema.prisma:L14584`
- `SaleVerification` → `schema.prisma:L3577`
- `ScaleProfile` → `schema.prisma:L13469`
- `ScheduledCommand` → `schema.prisma:L8372`
- `SerializedItem` → `schema.prisma:L10002`
- `SerializedItemCustodyEvent` → `schema.prisma:L10165`
- `ServiceCharge` → `schema.prisma:L6736`
- `SettlementConfiguration` → `schema.prisma:L5563`
- `SettlementConfirmation` → `schema.prisma:L5676`
- `SettlementIncident` → `schema.prisma:L5627`
- `SettlementSimulation` → `schema.prisma:L5598`
- `Shift` → `schema.prisma:L2711`
- `SimRegistrationRequest` → `schema.prisma:L10203`
- `SimRegistrationRequestItem` → `schema.prisma:L10225`
- `SlotHold` → `schema.prisma:L11751`
- `Staff` → `schema.prisma:L868`
- `StaffOnboardingState` → `schema.prisma:L13799`
- `StaffOrganization` → `schema.prisma:L1164`
- `StaffPasskey` → `schema.prisma:L1191`
- `StaffSchedule` → `schema.prisma:L11691`
- `StaffScheduleException` → `schema.prisma:L11703`
- `StaffVenue` → `schema.prisma:L1094`
- `StockAlertConfig` → `schema.prisma:L10846`
- `StockBatch` → `schema.prisma:L2374`
- `StockCount` → `schema.prisma:L2311`
- `StockCountItem` → `schema.prisma:L2332`
- `StripeWebhookEvent` → `schema.prisma:L5210`
- `Supplier` → `schema.prisma:L1971`
- `SupplierPricing` → `schema.prisma:L2024`
- `Table` → `schema.prisma:L2623`
- `Terminal` → `schema.prisma:L3869`
- `TerminalHealth` → `schema.prisma:L4108`
- `TerminalLog` → `schema.prisma:L4082`
- `TerminalOrder` → `schema.prisma:L4235`
- `TerminalOrderItem` → `schema.prisma:L4310`
- `TerminalPaymentRequest` → `schema.prisma:L4179`
- `TimeEntry` → `schema.prisma:L2776`
- `TimeEntryBreak` → `schema.prisma:L2845`
- `TokenPurchase` → `schema.prisma:L8046`
- `TokenUsageRecord` → `schema.prisma:L8018`
- `TpvCommandHistory` → `schema.prisma:L8278`
- `TpvCommandQueue` → `schema.prisma:L8218`
- `TpvFeedback` → `schema.prisma:L7931`
- `TpvMessage` → `schema.prisma:L11203`
- `TpvMessageDelivery` → `schema.prisma:L11255`
- `TpvMessageResponse` → `schema.prisma:L11278`
- `TrainingModule` → `schema.prisma:L11333`
- `TrainingProgress` → `schema.prisma:L11410`
- `TrainingQuizQuestion` → `schema.prisma:L11392`
- `TrainingStep` → `schema.prisma:L11372`
- `TransactionCost` → `schema.prisma:L5426`
- `UnitConversion` → `schema.prisma:L2221`
- `UpsellAcceptance` → `schema.prisma:L6557`
- `UpsellAiRun` → `schema.prisma:L6577`
- `UpsellImpression` → `schema.prisma:L6517`
- `UpsellRule` → `schema.prisma:L6447`
- `user_sessions` → `schema.prisma:L4812`
- `Venue` → `schema.prisma:L147`
- `VenueAreaTicketSettings` → `schema.prisma:L13206`
- `VenueChatMessage` → `schema.prisma:L731`
- `VenueChatSession` → `schema.prisma:L686`
- `VenueCommission` → `schema.prisma:L12907`
- `VenueCreditAssessment` → `schema.prisma:L8740`
- `VenueCryptoConfig` → `schema.prisma:L11070`
- `VenueFeature` → `schema.prisma:L3691`
- `VenueModule` → `schema.prisma:L8900`
- `VenuePaymentConfig` → `schema.prisma:L4913`
- `VenuePaymentLinkSettings` → `schema.prisma:L12277`
- `VenuePricingStructure` → `schema.prisma:L5366`
- `VenueRoleConfig` → `schema.prisma:L1279`
- `VenueRolePermission` → `schema.prisma:L1221`
- `VenueScaleSettings` → `schema.prisma:L13457`
- `VenueSettings` → `schema.prisma:L771`
- `VenueTransaction` → `schema.prisma:L3628`
- `VenueWhatsappActivation` → `schema.prisma:L622`
- `WebhookEvent` → `schema.prisma:L3727`
- `WebhookSubscription` → `schema.prisma:L5029`
- `WhatsappContactWindow` → `schema.prisma:L640`
- `WhatsappInboundEvent` → `schema.prisma:L660`
- `Zone` → `schema.prisma:L130`
