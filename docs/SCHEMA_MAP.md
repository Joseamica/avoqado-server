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

- `AccountingPeriodLock` → `schema.prisma:L14258`
- `AccountMapping` → `schema.prisma:L14154`
- `ActivityLog` → `schema.prisma:L5829`
- `Aggregator` → `schema.prisma:L12779`
- `AngelPayUserAccount` → `schema.prisma:L4538`
- `AppUpdate` → `schema.prisma:L11008`
- `Area` → `schema.prisma:L2593`
- `AreaTicket` → `schema.prisma:L13198`
- `AreaTicketCheckoutSession` → `schema.prisma:L13310`
- `AreaTicketFulfillment` → `schema.prisma:L13386`
- `AreaTicketInventoryReservation` → `schema.prisma:L13285`
- `AreaTicketLine` → `schema.prisma:L13253`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13342`
- `AreaTicketPrintAttempt` → `schema.prisma:L13365`
- `BankStatement` → `schema.prisma:L14028`
- `BankStatementLine` → `schema.prisma:L14049`
- `BillingTaxProfile` → `schema.prisma:L14838`
- `BulkCommandOperation` → `schema.prisma:L8322`
- `CalendarSyncOutbox` → `schema.prisma:L12182`
- `CampaignDelivery` → `schema.prisma:L11166`
- `CashCloseout` → `schema.prisma:L8687`
- `CashDeposit` → `schema.prisma:L10810`
- `CashDrawerEvent` → `schema.prisma:L12625`
- `CashDrawerSession` → `schema.prisma:L12601`
- `CashOutCommissionRate` → `schema.prisma:L14667`
- `CashOutScheduleDay` → `schema.prisma:L14690`
- `CashOutWithdrawal` → `schema.prisma:L14752`
- `CatalogBindingBatch` → `schema.prisma:L9718`
- `CatalogBindingLine` → `schema.prisma:L9754`
- `CatalogBrand` → `schema.prisma:L9171`
- `CatalogClientObservation` → `schema.prisma:L9484`
- `CatalogClientReadinessOverride` → `schema.prisma:L9503`
- `CatalogFamily` → `schema.prisma:L9221`
- `CatalogIdempotencyRecord` → `schema.prisma:L9617`
- `CatalogIdentifier` → `schema.prisma:L9352`
- `CatalogImportBatch` → `schema.prisma:L9660`
- `CatalogImportLine` → `schema.prisma:L9697`
- `CatalogItem` → `schema.prisma:L9254`
- `CatalogItemBusinessType` → `schema.prisma:L9314`
- `CatalogItemPrice` → `schema.prisma:L9402`
- `CatalogManufacturer` → `schema.prisma:L9195`
- `CatalogProductTypeMapping` → `schema.prisma:L9331`
- `CatalogPublicationBatch` → `schema.prisma:L9782`
- `CatalogPublicationFieldDecision` → `schema.prisma:L9876`
- `CatalogPublicationLine` → `schema.prisma:L9823`
- `CatalogPublicationOutbox` → `schema.prisma:L9919`
- `CatalogValidationProfile` → `schema.prisma:L9373`
- `CatalogVenueBinding` → `schema.prisma:L9531`
- `CatalogVenueClientRequirement` → `schema.prisma:L9458`
- `CatalogVenueEventSequence` → `schema.prisma:L9902`
- `CatalogVenueOverride` → `schema.prisma:L9573`
- `CatalogVenueRollout` → `schema.prisma:L9433`
- `Cfdi` → `schema.prisma:L13931`
- `ChatbotTokenBudget` → `schema.prisma:L7970`
- `ChatConversation` → `schema.prisma:L7825`
- `ChatFeedback` → `schema.prisma:L7911`
- `ChatLearningEvent` → `schema.prisma:L7868`
- `ChatMessage` → `schema.prisma:L7848`
- `ChatTrainingData` → `schema.prisma:L7782`
- `CheckoutSession` → `schema.prisma:L4818`
- `ClassSession` → `schema.prisma:L11800`
- `CommissionCalculation` → `schema.prisma:L10589`
- `CommissionClawback` → `schema.prisma:L10762`
- `CommissionConfig` → `schema.prisma:L10362`
- `CommissionMilestone` → `schema.prisma:L10505`
- `CommissionOverride` → `schema.prisma:L10432`
- `CommissionPayout` → `schema.prisma:L10713`
- `CommissionSummary` → `schema.prisma:L10652`
- `CommissionTier` → `schema.prisma:L10469`
- `Consumer` → `schema.prisma:L5965`
- `ConsumerAuthAccount` → `schema.prisma:L5990`
- `CouponCode` → `schema.prisma:L6593`
- `CouponRedemption` → `schema.prisma:L6624`
- `CreditAssessmentHistory` → `schema.prisma:L8796`
- `CreditItemBalance` → `schema.prisma:L12391`
- `CreditOffer` → `schema.prisma:L8815`
- `CreditPack` → `schema.prisma:L12307`
- `CreditPackItem` → `schema.prisma:L12336`
- `CreditPackPurchase` → `schema.prisma:L12353`
- `CreditTransaction` → `schema.prisma:L12413`
- `Customer` → `schema.prisma:L5870`
- `CustomerDiscount` → `schema.prisma:L6644`
- `CustomerGroup` → `schema.prisma:L6024`
- `CustomerTaxProfile` → `schema.prisma:L14000`
- `DeliveryActivationRequest` → `schema.prisma:L5140`
- `DeliveryChannelLink` → `schema.prisma:L5104`
- `DeliveryOrderEvent` → `schema.prisma:L5164`
- `DeviceToken` → `schema.prisma:L6913`
- `DigitalReceipt` → `schema.prisma:L3540`
- `Discount` → `schema.prisma:L6296`
- `EcommerceMerchant` → `schema.prisma:L4630`
- `EmailTemplate` → `schema.prisma:L11105`
- `Employee` → `schema.prisma:L14515`
- `Estimate` → `schema.prisma:L12686`
- `EstimateItem` → `schema.prisma:L12714`
- `Expense` → `schema.prisma:L14302`
- `ExternalBusyBlock` → `schema.prisma:L12075`
- `Feature` → `schema.prisma:L3669`
- `FeeSchedule` → `schema.prisma:L3747`
- `FeeTier` → `schema.prisma:L3758`
- `FinancialAccount` → `schema.prisma:L12876`
- `FinancialConnection` → `schema.prisma:L12845`
- `FinancialProvider` → `schema.prisma:L12831`
- `FiscalEmisor` → `schema.prisma:L13854`
- `FiscalLossCarryforward` → `schema.prisma:L14425`
- `FixedAsset` → `schema.prisma:L14443`
- `FixedAssetDepreciation` → `schema.prisma:L14472`
- `FloorElement` → `schema.prisma:L2669`
- `FulfillmentArea` → `schema.prisma:L13071`
- `GeofenceRule` → `schema.prisma:L8407`
- `GoogleCalendarChannel` → `schema.prisma:L12052`
- `GoogleCalendarConnection` → `schema.prisma:L12004`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12105`
- `GoogleOAuthSession` → `schema.prisma:L12127`
- `HolidayCalendar` → `schema.prisma:L5753`
- `IdempotencyRequest` → `schema.prisma:L10237`
- `InterVenueTransfer` → `schema.prisma:L2421`
- `InterVenueTransferAllocation` → `schema.prisma:L2504`
- `InterVenueTransferItem` → `schema.prisma:L2473`
- `InterVenueTransferReceipt` → `schema.prisma:L2531`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2547`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2575`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2559`
- `Inventory` → `schema.prisma:L1744`
- `InventoryMovement` → `schema.prisma:L1771`
- `InventoryTransfer` → `schema.prisma:L12658`
- `Invitation` → `schema.prisma:L1295`
- `Invoice` → `schema.prisma:L3770`
- `InvoiceItem` → `schema.prisma:L3796`
- `ItemCategory` → `schema.prisma:L9954`
- `JournalEntry` → `schema.prisma:L14212`
- `JournalLine` → `schema.prisma:L14240`
- `KdsOrder` → `schema.prisma:L12924`
- `KdsOrderItem` → `schema.prisma:L12941`
- `LearnedPatterns` → `schema.prisma:L7892`
- `LedgerAccount` → `schema.prisma:L14104`
- `LiveDemoSession` → `schema.prisma:L753`
- `LowStockAlert` → `schema.prisma:L2275`
- `LoyaltyConfig` → `schema.prisma:L6054`
- `LoyaltyTransaction` → `schema.prisma:L6077`
- `MarketingCampaign` → `schema.prisma:L11123`
- `McpAuthCode` → `schema.prisma:L13737`
- `McpOAuthClient` → `schema.prisma:L13721`
- `McpRefreshToken` → `schema.prisma:L13755`
- `McpToolCall` → `schema.prisma:L13776`
- `MeasurementUnit` → `schema.prisma:L12764`
- `Menu` → `schema.prisma:L1481`
- `MenuCategory` → `schema.prisma:L1418`
- `MenuCategoryAssignment` → `schema.prisma:L1516`
- `MercadoPagoWebhookEvent` → `schema.prisma:L13651`
- `MerchantAccount` → `schema.prisma:L4368`
- `MerchantFiscalConfig` → `schema.prisma:L13902`
- `MerchantRevenueShare` → `schema.prisma:L5333`
- `MerchantRoutingRule` → `schema.prisma:L4490`
- `MilestoneAchievement` → `schema.prisma:L10550`
- `Modifier` → `schema.prisma:L3269`
- `ModifierGroup` → `schema.prisma:L3233`
- `Module` → `schema.prisma:L8863`
- `MoneyAnomaly` → `schema.prisma:L5236`
- `MonthlyVenueProfit` → `schema.prisma:L5779`
- `Notification` → `schema.prisma:L6815`
- `NotificationPreference` → `schema.prisma:L6862`
- `NotificationTemplate` → `schema.prisma:L6889`
- `OAuthState` → `schema.prisma:L1346`
- `OnboardingProgress` → `schema.prisma:L1364`
- `Order` → `schema.prisma:L2893`
- `OrderAction` → `schema.prisma:L3334`
- `OrderCustomer` → `schema.prisma:L3090`
- `OrderDiscount` → `schema.prisma:L6676`
- `OrderFulfillment` → `schema.prisma:L13118`
- `OrderFulfillmentLine` → `schema.prisma:L13149`
- `OrderItem` → `schema.prisma:L3106`
- `OrderItemModifier` → `schema.prisma:L3318`
- `OrderServiceCharge` → `schema.prisma:L6760`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L10924`
- `OrganizationEntitlement` → `schema.prisma:L9146`
- `OrganizationGoal` → `schema.prisma:L10882`
- `OrganizationModule` → `schema.prisma:L8923`
- `OrganizationPaymentConfig` → `schema.prisma:L4942`
- `OrganizationPayoutConfig` → `schema.prisma:L10957`
- `OrganizationPricingStructure` → `schema.prisma:L4974`
- `OrganizationSalesGoalConfig` → `schema.prisma:L10905`
- `OtpChallenge` → `schema.prisma:L6009`
- `PartnerAPIKey` → `schema.prisma:L4772`
- `Payment` → `schema.prisma:L3367`
- `PaymentAllocation` → `schema.prisma:L3519`
- `PaymentLink` → `schema.prisma:L12459`
- `PaymentLinkAttribution` → `schema.prisma:L12567`
- `PaymentLinkItem` → `schema.prisma:L12522`
- `PaymentLinkItemModifier` → `schema.prisma:L12549`
- `PaymentProvider` → `schema.prisma:L4327`
- `PayrollLine` → `schema.prisma:L14586`
- `PayrollRun` → `schema.prisma:L14555`
- `PerformanceGoal` → `schema.prisma:L10859`
- `PermissionSet` → `schema.prisma:L1246`
- `PlatformCfdi` → `schema.prisma:L14871`
- `PlatformEmisor` → `schema.prisma:L14811`
- `PlatformSettings` → `schema.prisma:L4749`
- `PosCommand` → `schema.prisma:L6943`
- `PosConnectionStatus` → `schema.prisma:L846`
- `PosSyncIntent` → `schema.prisma:L14949`
- `PricingPolicy` → `schema.prisma:L2186`
- `Printer` → `schema.prisma:L12970`
- `PrintGateway` → `schema.prisma:L13007`
- `PrintJob` → `schema.prisma:L13550`
- `PrintStation` → `schema.prisma:L13025`
- `ProcessedStripeEvent` → `schema.prisma:L5222`
- `ProcessorReliabilityMetric` → `schema.prisma:L5707`
- `Product` → `schema.prisma:L1534`
- `ProductModifierGroup` → `schema.prisma:L3306`
- `ProductOption` → `schema.prisma:L12741`
- `ProductOptionValue` → `schema.prisma:L12752`
- `ProductStaff` → `schema.prisma:L11715`
- `PromoterBankAccount` → `schema.prisma:L14706`
- `PromoterCommissionEntry` → `schema.prisma:L14725`
- `PromoterLocationPing` → `schema.prisma:L2859`
- `ProviderCostStructure` → `schema.prisma:L5258`
- `ProviderEventLog` → `schema.prisma:L5051`
- `PurchaseOrder` → `schema.prisma:L2054`
- `PurchaseOrderItem` → `schema.prisma:L2111`
- `RateCorrectionBatch` → `schema.prisma:L5483`
- `RateCorrectionEntry` → `schema.prisma:L5525`
- `RawMaterial` → `schema.prisma:L1815`
- `RawMaterialMovement` → `schema.prisma:L2239`
- `RawMaterialPresentation` → `schema.prisma:L1888`
- `Recipe` → `schema.prisma:L1908`
- `RecipeLine` → `schema.prisma:L1932`
- `Referral` → `schema.prisma:L6144`
- `ReferralProgramConfig` → `schema.prisma:L6109`
- `ReferralRewardGrant` → `schema.prisma:L6235`
- `ReferralTierReward` → `schema.prisma:L6207`
- `ReferralTierUnlock` → `schema.prisma:L6280`
- `Reservation` → `schema.prisma:L11502`
- `ReservationGoogleEventMapping` → `schema.prisma:L12239`
- `ReservationModifier` → `schema.prisma:L11663`
- `ReservationReminderSent` → `schema.prisma:L11646`
- `ReservationSettings` → `schema.prisma:L11877`
- `ReservationWaitlistEntry` → `schema.prisma:L11845`
- `Review` → `schema.prisma:L3814`
- `SalesRetention` → `schema.prisma:L14406`
- `SaleVerification` → `schema.prisma:L3573`
- `ScaleProfile` → `schema.prisma:L13421`
- `ScheduledCommand` → `schema.prisma:L8367`
- `SerializedItem` → `schema.prisma:L9997`
- `SerializedItemCustodyEvent` → `schema.prisma:L10160`
- `ServiceCharge` → `schema.prisma:L6731`
- `SettlementConfiguration` → `schema.prisma:L5558`
- `SettlementConfirmation` → `schema.prisma:L5671`
- `SettlementIncident` → `schema.prisma:L5622`
- `SettlementSimulation` → `schema.prisma:L5593`
- `Shift` → `schema.prisma:L2707`
- `SimRegistrationRequest` → `schema.prisma:L10198`
- `SimRegistrationRequestItem` → `schema.prisma:L10220`
- `SlotHold` → `schema.prisma:L11746`
- `Staff` → `schema.prisma:L866`
- `StaffOnboardingState` → `schema.prisma:L13621`
- `StaffOrganization` → `schema.prisma:L1160`
- `StaffPasskey` → `schema.prisma:L1187`
- `StaffSchedule` → `schema.prisma:L11686`
- `StaffScheduleException` → `schema.prisma:L11698`
- `StaffVenue` → `schema.prisma:L1090`
- `StockAlertConfig` → `schema.prisma:L10841`
- `StockBatch` → `schema.prisma:L2370`
- `StockCount` → `schema.prisma:L2307`
- `StockCountItem` → `schema.prisma:L2328`
- `StripeWebhookEvent` → `schema.prisma:L5205`
- `Supplier` → `schema.prisma:L1967`
- `SupplierPricing` → `schema.prisma:L2020`
- `Table` → `schema.prisma:L2619`
- `Terminal` → `schema.prisma:L3865`
- `TerminalHealth` → `schema.prisma:L4103`
- `TerminalLog` → `schema.prisma:L4077`
- `TerminalOrder` → `schema.prisma:L4230`
- `TerminalOrderItem` → `schema.prisma:L4305`
- `TerminalPaymentRequest` → `schema.prisma:L4174`
- `TimeEntry` → `schema.prisma:L2772`
- `TimeEntryBreak` → `schema.prisma:L2841`
- `TokenPurchase` → `schema.prisma:L8041`
- `TokenUsageRecord` → `schema.prisma:L8013`
- `TpvCommandHistory` → `schema.prisma:L8273`
- `TpvCommandQueue` → `schema.prisma:L8213`
- `TpvFeedback` → `schema.prisma:L7926`
- `TpvMessage` → `schema.prisma:L11198`
- `TpvMessageDelivery` → `schema.prisma:L11250`
- `TpvMessageResponse` → `schema.prisma:L11273`
- `TrainingModule` → `schema.prisma:L11328`
- `TrainingProgress` → `schema.prisma:L11405`
- `TrainingQuizQuestion` → `schema.prisma:L11387`
- `TrainingStep` → `schema.prisma:L11367`
- `TransactionCost` → `schema.prisma:L5421`
- `UnitConversion` → `schema.prisma:L2217`
- `UpsellAcceptance` → `schema.prisma:L6552`
- `UpsellAiRun` → `schema.prisma:L6572`
- `UpsellImpression` → `schema.prisma:L6512`
- `UpsellRule` → `schema.prisma:L6442`
- `user_sessions` → `schema.prisma:L4807`
- `Venue` → `schema.prisma:L147`
- `VenueAreaTicketSettings` → `schema.prisma:L13177`
- `VenueChatMessage` → `schema.prisma:L729`
- `VenueChatSession` → `schema.prisma:L684`
- `VenueCommission` → `schema.prisma:L12902`
- `VenueCreditAssessment` → `schema.prisma:L8735`
- `VenueCryptoConfig` → `schema.prisma:L11065`
- `VenueFeature` → `schema.prisma:L3687`
- `VenueModule` → `schema.prisma:L8895`
- `VenuePaymentConfig` → `schema.prisma:L4908`
- `VenuePaymentLinkSettings` → `schema.prisma:L12272`
- `VenuePricingStructure` → `schema.prisma:L5361`
- `VenueRoleConfig` → `schema.prisma:L1275`
- `VenueRolePermission` → `schema.prisma:L1217`
- `VenueScaleSettings` → `schema.prisma:L13409`
- `VenueSettings` → `schema.prisma:L769`
- `VenueTransaction` → `schema.prisma:L3624`
- `VenueWhatsappActivation` → `schema.prisma:L620`
- `WebhookEvent` → `schema.prisma:L3723`
- `WebhookSubscription` → `schema.prisma:L5024`
- `WhatsappContactWindow` → `schema.prisma:L638`
- `WhatsappInboundEvent` → `schema.prisma:L658`
- `Zone` → `schema.prisma:L130`
