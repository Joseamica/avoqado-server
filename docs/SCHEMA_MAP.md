# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **320 models / 304 enums / ~14,900 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `PermissionSet`, `PromoterLocationPing`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                            |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                                          |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                           |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                           |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`                                                                                                                                                                                                                                                                                                    |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                        |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                       |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L14252`
- `AccountMapping` → `schema.prisma:L14148`
- `ActivityLog` → `schema.prisma:L5823`
- `Aggregator` → `schema.prisma:L12773`
- `AngelPayUserAccount` → `schema.prisma:L4532`
- `AppUpdate` → `schema.prisma:L11002`
- `Area` → `schema.prisma:L2593`
- `AreaTicket` → `schema.prisma:L13192`
- `AreaTicketCheckoutSession` → `schema.prisma:L13304`
- `AreaTicketFulfillment` → `schema.prisma:L13380`
- `AreaTicketInventoryReservation` → `schema.prisma:L13279`
- `AreaTicketLine` → `schema.prisma:L13247`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13336`
- `AreaTicketPrintAttempt` → `schema.prisma:L13359`
- `BankStatement` → `schema.prisma:L14022`
- `BankStatementLine` → `schema.prisma:L14043`
- `BillingTaxProfile` → `schema.prisma:L14832`
- `BulkCommandOperation` → `schema.prisma:L8316`
- `CalendarSyncOutbox` → `schema.prisma:L12176`
- `CampaignDelivery` → `schema.prisma:L11160`
- `CashCloseout` → `schema.prisma:L8681`
- `CashDeposit` → `schema.prisma:L10804`
- `CashDrawerEvent` → `schema.prisma:L12619`
- `CashDrawerSession` → `schema.prisma:L12595`
- `CashOutCommissionRate` → `schema.prisma:L14661`
- `CashOutScheduleDay` → `schema.prisma:L14684`
- `CashOutWithdrawal` → `schema.prisma:L14746`
- `CatalogBindingBatch` → `schema.prisma:L9712`
- `CatalogBindingLine` → `schema.prisma:L9748`
- `CatalogBrand` → `schema.prisma:L9165`
- `CatalogClientObservation` → `schema.prisma:L9478`
- `CatalogClientReadinessOverride` → `schema.prisma:L9497`
- `CatalogFamily` → `schema.prisma:L9215`
- `CatalogIdempotencyRecord` → `schema.prisma:L9611`
- `CatalogIdentifier` → `schema.prisma:L9346`
- `CatalogImportBatch` → `schema.prisma:L9654`
- `CatalogImportLine` → `schema.prisma:L9691`
- `CatalogItem` → `schema.prisma:L9248`
- `CatalogItemBusinessType` → `schema.prisma:L9308`
- `CatalogItemPrice` → `schema.prisma:L9396`
- `CatalogManufacturer` → `schema.prisma:L9189`
- `CatalogProductTypeMapping` → `schema.prisma:L9325`
- `CatalogPublicationBatch` → `schema.prisma:L9776`
- `CatalogPublicationFieldDecision` → `schema.prisma:L9870`
- `CatalogPublicationLine` → `schema.prisma:L9817`
- `CatalogPublicationOutbox` → `schema.prisma:L9913`
- `CatalogValidationProfile` → `schema.prisma:L9367`
- `CatalogVenueBinding` → `schema.prisma:L9525`
- `CatalogVenueClientRequirement` → `schema.prisma:L9452`
- `CatalogVenueEventSequence` → `schema.prisma:L9896`
- `CatalogVenueOverride` → `schema.prisma:L9567`
- `CatalogVenueRollout` → `schema.prisma:L9427`
- `Cfdi` → `schema.prisma:L13925`
- `ChatbotTokenBudget` → `schema.prisma:L7964`
- `ChatConversation` → `schema.prisma:L7819`
- `ChatFeedback` → `schema.prisma:L7905`
- `ChatLearningEvent` → `schema.prisma:L7862`
- `ChatMessage` → `schema.prisma:L7842`
- `ChatTrainingData` → `schema.prisma:L7776`
- `CheckoutSession` → `schema.prisma:L4812`
- `ClassSession` → `schema.prisma:L11794`
- `CommissionCalculation` → `schema.prisma:L10583`
- `CommissionClawback` → `schema.prisma:L10756`
- `CommissionConfig` → `schema.prisma:L10356`
- `CommissionMilestone` → `schema.prisma:L10499`
- `CommissionOverride` → `schema.prisma:L10426`
- `CommissionPayout` → `schema.prisma:L10707`
- `CommissionSummary` → `schema.prisma:L10646`
- `CommissionTier` → `schema.prisma:L10463`
- `Consumer` → `schema.prisma:L5959`
- `ConsumerAuthAccount` → `schema.prisma:L5984`
- `CouponCode` → `schema.prisma:L6587`
- `CouponRedemption` → `schema.prisma:L6618`
- `CreditAssessmentHistory` → `schema.prisma:L8790`
- `CreditItemBalance` → `schema.prisma:L12385`
- `CreditOffer` → `schema.prisma:L8809`
- `CreditPack` → `schema.prisma:L12301`
- `CreditPackItem` → `schema.prisma:L12330`
- `CreditPackPurchase` → `schema.prisma:L12347`
- `CreditTransaction` → `schema.prisma:L12407`
- `Customer` → `schema.prisma:L5864`
- `CustomerDiscount` → `schema.prisma:L6638`
- `CustomerGroup` → `schema.prisma:L6018`
- `CustomerTaxProfile` → `schema.prisma:L13994`
- `DeliveryActivationRequest` → `schema.prisma:L5134`
- `DeliveryChannelLink` → `schema.prisma:L5098`
- `DeliveryOrderEvent` → `schema.prisma:L5158`
- `DeviceToken` → `schema.prisma:L6907`
- `DigitalReceipt` → `schema.prisma:L3540`
- `Discount` → `schema.prisma:L6290`
- `EcommerceMerchant` → `schema.prisma:L4624`
- `EmailTemplate` → `schema.prisma:L11099`
- `Employee` → `schema.prisma:L14509`
- `Estimate` → `schema.prisma:L12680`
- `EstimateItem` → `schema.prisma:L12708`
- `Expense` → `schema.prisma:L14296`
- `ExternalBusyBlock` → `schema.prisma:L12069`
- `Feature` → `schema.prisma:L3669`
- `FeeSchedule` → `schema.prisma:L3747`
- `FeeTier` → `schema.prisma:L3758`
- `FinancialAccount` → `schema.prisma:L12870`
- `FinancialConnection` → `schema.prisma:L12839`
- `FinancialProvider` → `schema.prisma:L12825`
- `FiscalEmisor` → `schema.prisma:L13848`
- `FiscalLossCarryforward` → `schema.prisma:L14419`
- `FixedAsset` → `schema.prisma:L14437`
- `FixedAssetDepreciation` → `schema.prisma:L14466`
- `FloorElement` → `schema.prisma:L2669`
- `FulfillmentArea` → `schema.prisma:L13065`
- `GeofenceRule` → `schema.prisma:L8401`
- `GoogleCalendarChannel` → `schema.prisma:L12046`
- `GoogleCalendarConnection` → `schema.prisma:L11998`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12099`
- `GoogleOAuthSession` → `schema.prisma:L12121`
- `HolidayCalendar` → `schema.prisma:L5747`
- `IdempotencyRequest` → `schema.prisma:L10231`
- `InterVenueTransfer` → `schema.prisma:L2421`
- `InterVenueTransferAllocation` → `schema.prisma:L2504`
- `InterVenueTransferItem` → `schema.prisma:L2473`
- `InterVenueTransferReceipt` → `schema.prisma:L2531`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2547`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2575`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2559`
- `Inventory` → `schema.prisma:L1744`
- `InventoryMovement` → `schema.prisma:L1771`
- `InventoryTransfer` → `schema.prisma:L12652`
- `Invitation` → `schema.prisma:L1295`
- `Invoice` → `schema.prisma:L3770`
- `InvoiceItem` → `schema.prisma:L3796`
- `ItemCategory` → `schema.prisma:L9948`
- `JournalEntry` → `schema.prisma:L14206`
- `JournalLine` → `schema.prisma:L14234`
- `KdsOrder` → `schema.prisma:L12918`
- `KdsOrderItem` → `schema.prisma:L12935`
- `LearnedPatterns` → `schema.prisma:L7886`
- `LedgerAccount` → `schema.prisma:L14098`
- `LiveDemoSession` → `schema.prisma:L753`
- `LowStockAlert` → `schema.prisma:L2275`
- `LoyaltyConfig` → `schema.prisma:L6048`
- `LoyaltyTransaction` → `schema.prisma:L6071`
- `MarketingCampaign` → `schema.prisma:L11117`
- `McpAuthCode` → `schema.prisma:L13731`
- `McpOAuthClient` → `schema.prisma:L13715`
- `McpRefreshToken` → `schema.prisma:L13749`
- `McpToolCall` → `schema.prisma:L13770`
- `MeasurementUnit` → `schema.prisma:L12758`
- `Menu` → `schema.prisma:L1481`
- `MenuCategory` → `schema.prisma:L1418`
- `MenuCategoryAssignment` → `schema.prisma:L1516`
- `MercadoPagoWebhookEvent` → `schema.prisma:L13645`
- `MerchantAccount` → `schema.prisma:L4362`
- `MerchantFiscalConfig` → `schema.prisma:L13896`
- `MerchantRevenueShare` → `schema.prisma:L5327`
- `MerchantRoutingRule` → `schema.prisma:L4484`
- `MilestoneAchievement` → `schema.prisma:L10544`
- `Modifier` → `schema.prisma:L3269`
- `ModifierGroup` → `schema.prisma:L3233`
- `Module` → `schema.prisma:L8857`
- `MoneyAnomaly` → `schema.prisma:L5230`
- `MonthlyVenueProfit` → `schema.prisma:L5773`
- `Notification` → `schema.prisma:L6809`
- `NotificationPreference` → `schema.prisma:L6856`
- `NotificationTemplate` → `schema.prisma:L6883`
- `OAuthState` → `schema.prisma:L1346`
- `OnboardingProgress` → `schema.prisma:L1364`
- `Order` → `schema.prisma:L2893`
- `OrderAction` → `schema.prisma:L3334`
- `OrderCustomer` → `schema.prisma:L3090`
- `OrderDiscount` → `schema.prisma:L6670`
- `OrderFulfillment` → `schema.prisma:L13112`
- `OrderFulfillmentLine` → `schema.prisma:L13143`
- `OrderItem` → `schema.prisma:L3106`
- `OrderItemModifier` → `schema.prisma:L3318`
- `OrderServiceCharge` → `schema.prisma:L6754`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L10918`
- `OrganizationEntitlement` → `schema.prisma:L9140`
- `OrganizationGoal` → `schema.prisma:L10876`
- `OrganizationModule` → `schema.prisma:L8917`
- `OrganizationPaymentConfig` → `schema.prisma:L4936`
- `OrganizationPayoutConfig` → `schema.prisma:L10951`
- `OrganizationPricingStructure` → `schema.prisma:L4968`
- `OrganizationSalesGoalConfig` → `schema.prisma:L10899`
- `OtpChallenge` → `schema.prisma:L6003`
- `PartnerAPIKey` → `schema.prisma:L4766`
- `Payment` → `schema.prisma:L3367`
- `PaymentAllocation` → `schema.prisma:L3519`
- `PaymentLink` → `schema.prisma:L12453`
- `PaymentLinkAttribution` → `schema.prisma:L12561`
- `PaymentLinkItem` → `schema.prisma:L12516`
- `PaymentLinkItemModifier` → `schema.prisma:L12543`
- `PaymentProvider` → `schema.prisma:L4321`
- `PayrollLine` → `schema.prisma:L14580`
- `PayrollRun` → `schema.prisma:L14549`
- `PerformanceGoal` → `schema.prisma:L10853`
- `PermissionSet` → `schema.prisma:L1246`
- `PlatformCfdi` → `schema.prisma:L14865`
- `PlatformEmisor` → `schema.prisma:L14805`
- `PlatformSettings` → `schema.prisma:L4743`
- `PosCommand` → `schema.prisma:L6937`
- `PosConnectionStatus` → `schema.prisma:L846`
- `PosSyncIntent` → `schema.prisma:L14943`
- `PricingPolicy` → `schema.prisma:L2186`
- `Printer` → `schema.prisma:L12964`
- `PrintGateway` → `schema.prisma:L13001`
- `PrintJob` → `schema.prisma:L13544`
- `PrintStation` → `schema.prisma:L13019`
- `ProcessedStripeEvent` → `schema.prisma:L5216`
- `ProcessorReliabilityMetric` → `schema.prisma:L5701`
- `Product` → `schema.prisma:L1534`
- `ProductModifierGroup` → `schema.prisma:L3306`
- `ProductOption` → `schema.prisma:L12735`
- `ProductOptionValue` → `schema.prisma:L12746`
- `ProductStaff` → `schema.prisma:L11709`
- `PromoterBankAccount` → `schema.prisma:L14700`
- `PromoterCommissionEntry` → `schema.prisma:L14719`
- `PromoterLocationPing` → `schema.prisma:L2859`
- `ProviderCostStructure` → `schema.prisma:L5252`
- `ProviderEventLog` → `schema.prisma:L5045`
- `PurchaseOrder` → `schema.prisma:L2054`
- `PurchaseOrderItem` → `schema.prisma:L2111`
- `RateCorrectionBatch` → `schema.prisma:L5477`
- `RateCorrectionEntry` → `schema.prisma:L5519`
- `RawMaterial` → `schema.prisma:L1815`
- `RawMaterialMovement` → `schema.prisma:L2239`
- `RawMaterialPresentation` → `schema.prisma:L1888`
- `Recipe` → `schema.prisma:L1908`
- `RecipeLine` → `schema.prisma:L1932`
- `Referral` → `schema.prisma:L6138`
- `ReferralProgramConfig` → `schema.prisma:L6103`
- `ReferralRewardGrant` → `schema.prisma:L6229`
- `ReferralTierReward` → `schema.prisma:L6201`
- `ReferralTierUnlock` → `schema.prisma:L6274`
- `Reservation` → `schema.prisma:L11496`
- `ReservationGoogleEventMapping` → `schema.prisma:L12233`
- `ReservationModifier` → `schema.prisma:L11657`
- `ReservationReminderSent` → `schema.prisma:L11640`
- `ReservationSettings` → `schema.prisma:L11871`
- `ReservationWaitlistEntry` → `schema.prisma:L11839`
- `Review` → `schema.prisma:L3814`
- `SalesRetention` → `schema.prisma:L14400`
- `SaleVerification` → `schema.prisma:L3573`
- `ScaleProfile` → `schema.prisma:L13415`
- `ScheduledCommand` → `schema.prisma:L8361`
- `SerializedItem` → `schema.prisma:L9991`
- `SerializedItemCustodyEvent` → `schema.prisma:L10154`
- `ServiceCharge` → `schema.prisma:L6725`
- `SettlementConfiguration` → `schema.prisma:L5552`
- `SettlementConfirmation` → `schema.prisma:L5665`
- `SettlementIncident` → `schema.prisma:L5616`
- `SettlementSimulation` → `schema.prisma:L5587`
- `Shift` → `schema.prisma:L2707`
- `SimRegistrationRequest` → `schema.prisma:L10192`
- `SimRegistrationRequestItem` → `schema.prisma:L10214`
- `SlotHold` → `schema.prisma:L11740`
- `Staff` → `schema.prisma:L866`
- `StaffOnboardingState` → `schema.prisma:L13615`
- `StaffOrganization` → `schema.prisma:L1160`
- `StaffPasskey` → `schema.prisma:L1187`
- `StaffSchedule` → `schema.prisma:L11680`
- `StaffScheduleException` → `schema.prisma:L11692`
- `StaffVenue` → `schema.prisma:L1090`
- `StockAlertConfig` → `schema.prisma:L10835`
- `StockBatch` → `schema.prisma:L2370`
- `StockCount` → `schema.prisma:L2307`
- `StockCountItem` → `schema.prisma:L2328`
- `StripeWebhookEvent` → `schema.prisma:L5199`
- `Supplier` → `schema.prisma:L1967`
- `SupplierPricing` → `schema.prisma:L2020`
- `Table` → `schema.prisma:L2619`
- `Terminal` → `schema.prisma:L3865`
- `TerminalHealth` → `schema.prisma:L4097`
- `TerminalLog` → `schema.prisma:L4071`
- `TerminalOrder` → `schema.prisma:L4224`
- `TerminalOrderItem` → `schema.prisma:L4299`
- `TerminalPaymentRequest` → `schema.prisma:L4168`
- `TimeEntry` → `schema.prisma:L2772`
- `TimeEntryBreak` → `schema.prisma:L2841`
- `TokenPurchase` → `schema.prisma:L8035`
- `TokenUsageRecord` → `schema.prisma:L8007`
- `TpvCommandHistory` → `schema.prisma:L8267`
- `TpvCommandQueue` → `schema.prisma:L8207`
- `TpvFeedback` → `schema.prisma:L7920`
- `TpvMessage` → `schema.prisma:L11192`
- `TpvMessageDelivery` → `schema.prisma:L11244`
- `TpvMessageResponse` → `schema.prisma:L11267`
- `TrainingModule` → `schema.prisma:L11322`
- `TrainingProgress` → `schema.prisma:L11399`
- `TrainingQuizQuestion` → `schema.prisma:L11381`
- `TrainingStep` → `schema.prisma:L11361`
- `TransactionCost` → `schema.prisma:L5415`
- `UnitConversion` → `schema.prisma:L2217`
- `UpsellAcceptance` → `schema.prisma:L6546`
- `UpsellAiRun` → `schema.prisma:L6566`
- `UpsellImpression` → `schema.prisma:L6506`
- `UpsellRule` → `schema.prisma:L6436`
- `user_sessions` → `schema.prisma:L4801`
- `Venue` → `schema.prisma:L147`
- `VenueAreaTicketSettings` → `schema.prisma:L13171`
- `VenueChatMessage` → `schema.prisma:L729`
- `VenueChatSession` → `schema.prisma:L684`
- `VenueCommission` → `schema.prisma:L12896`
- `VenueCreditAssessment` → `schema.prisma:L8729`
- `VenueCryptoConfig` → `schema.prisma:L11059`
- `VenueFeature` → `schema.prisma:L3687`
- `VenueModule` → `schema.prisma:L8889`
- `VenuePaymentConfig` → `schema.prisma:L4902`
- `VenuePaymentLinkSettings` → `schema.prisma:L12266`
- `VenuePricingStructure` → `schema.prisma:L5355`
- `VenueRoleConfig` → `schema.prisma:L1275`
- `VenueRolePermission` → `schema.prisma:L1217`
- `VenueScaleSettings` → `schema.prisma:L13403`
- `VenueSettings` → `schema.prisma:L769`
- `VenueTransaction` → `schema.prisma:L3624`
- `VenueWhatsappActivation` → `schema.prisma:L620`
- `WebhookEvent` → `schema.prisma:L3723`
- `WebhookSubscription` → `schema.prisma:L5018`
- `WhatsappContactWindow` → `schema.prisma:L638`
- `WhatsappInboundEvent` → `schema.prisma:L658`
- `Zone` → `schema.prisma:L130`
