# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **331 models / 321 enums / ~15,500 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L14749`
- `AccountMapping` → `schema.prisma:L14645`
- `ActivityLog` → `schema.prisma:L6128`
- `Aggregator` → `schema.prisma:L13097`
- `AngelPayUserAccount` → `schema.prisma:L4837`
- `AppUpdate` → `schema.prisma:L11317`
- `Area` → `schema.prisma:L2765`
- `AreaTicket` → `schema.prisma:L13540`
- `AreaTicketCheckoutSession` → `schema.prisma:L13662`
- `AreaTicketExternalIncident` → `schema.prisma:L13909`
- `AreaTicketExternalSettlement` → `schema.prisma:L13874`
- `AreaTicketFulfillment` → `schema.prisma:L13738`
- `AreaTicketInventoryReservation` → `schema.prisma:L13633`
- `AreaTicketLine` → `schema.prisma:L13601`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13694`
- `AreaTicketPrintAttempt` → `schema.prisma:L13717`
- `BankStatement` → `schema.prisma:L14519`
- `BankStatementLine` → `schema.prisma:L14540`
- `BillingTaxProfile` → `schema.prisma:L15329`
- `BulkCommandOperation` → `schema.prisma:L8631`
- `CalendarSyncOutbox` → `schema.prisma:L12491`
- `CampaignDelivery` → `schema.prisma:L11475`
- `CashCloseout` → `schema.prisma:L8996`
- `CashDeposit` → `schema.prisma:L11119`
- `CashDrawerEvent` → `schema.prisma:L12934`
- `CashDrawerSession` → `schema.prisma:L12910`
- `CashOutCommissionRate` → `schema.prisma:L15158`
- `CashOutScheduleDay` → `schema.prisma:L15181`
- `CashOutWithdrawal` → `schema.prisma:L15243`
- `CatalogBindingBatch` → `schema.prisma:L10027`
- `CatalogBindingLine` → `schema.prisma:L10063`
- `CatalogBrand` → `schema.prisma:L9480`
- `CatalogClientObservation` → `schema.prisma:L9793`
- `CatalogClientReadinessOverride` → `schema.prisma:L9812`
- `CatalogFamily` → `schema.prisma:L9530`
- `CatalogIdempotencyRecord` → `schema.prisma:L9926`
- `CatalogIdentifier` → `schema.prisma:L9661`
- `CatalogImportBatch` → `schema.prisma:L9969`
- `CatalogImportLine` → `schema.prisma:L10006`
- `CatalogItem` → `schema.prisma:L9563`
- `CatalogItemBusinessType` → `schema.prisma:L9623`
- `CatalogItemPrice` → `schema.prisma:L9711`
- `CatalogManufacturer` → `schema.prisma:L9504`
- `CatalogProductTypeMapping` → `schema.prisma:L9640`
- `CatalogPublicationBatch` → `schema.prisma:L10091`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10185`
- `CatalogPublicationLine` → `schema.prisma:L10132`
- `CatalogPublicationOutbox` → `schema.prisma:L10228`
- `CatalogValidationProfile` → `schema.prisma:L9682`
- `CatalogVenueBinding` → `schema.prisma:L9840`
- `CatalogVenueClientRequirement` → `schema.prisma:L9767`
- `CatalogVenueEventSequence` → `schema.prisma:L10211`
- `CatalogVenueOverride` → `schema.prisma:L9882`
- `CatalogVenueRollout` → `schema.prisma:L9742`
- `Cfdi` → `schema.prisma:L14422`
- `ChatbotTokenBudget` → `schema.prisma:L8279`
- `ChatConversation` → `schema.prisma:L8134`
- `ChatFeedback` → `schema.prisma:L8220`
- `ChatLearningEvent` → `schema.prisma:L8177`
- `ChatMessage` → `schema.prisma:L8157`
- `ChatTrainingData` → `schema.prisma:L8091`
- `CheckoutSession` → `schema.prisma:L5117`
- `ClassSession` → `schema.prisma:L12109`
- `CommissionCalculation` → `schema.prisma:L10898`
- `CommissionClawback` → `schema.prisma:L11071`
- `CommissionConfig` → `schema.prisma:L10671`
- `CommissionMilestone` → `schema.prisma:L10814`
- `CommissionOverride` → `schema.prisma:L10741`
- `CommissionPayout` → `schema.prisma:L11022`
- `CommissionSummary` → `schema.prisma:L10961`
- `CommissionTier` → `schema.prisma:L10778`
- `Consumer` → `schema.prisma:L6264`
- `ConsumerAuthAccount` → `schema.prisma:L6289`
- `CouponCode` → `schema.prisma:L6895`
- `CouponRedemption` → `schema.prisma:L6926`
- `CreditAssessmentHistory` → `schema.prisma:L9105`
- `CreditItemBalance` → `schema.prisma:L12700`
- `CreditOffer` → `schema.prisma:L9124`
- `CreditPack` → `schema.prisma:L12616`
- `CreditPackItem` → `schema.prisma:L12645`
- `CreditPackPurchase` → `schema.prisma:L12662`
- `CreditTransaction` → `schema.prisma:L12722`
- `Customer` → `schema.prisma:L6169`
- `CustomerDiscount` → `schema.prisma:L6946`
- `CustomerGroup` → `schema.prisma:L6323`
- `CustomerTaxProfile` → `schema.prisma:L14491`
- `DeliveryActivationRequest` → `schema.prisma:L5439`
- `DeliveryChannelLink` → `schema.prisma:L5403`
- `DeliveryOrderEvent` → `schema.prisma:L5463`
- `DeviceToken` → `schema.prisma:L7215`
- `DigitalReceipt` → `schema.prisma:L3838`
- `Discount` → `schema.prisma:L6595`
- `EcommerceMerchant` → `schema.prisma:L4929`
- `EmailTemplate` → `schema.prisma:L11414`
- `Employee` → `schema.prisma:L15006`
- `Estimate` → `schema.prisma:L13004`
- `EstimateItem` → `schema.prisma:L13032`
- `Expense` → `schema.prisma:L14793`
- `ExternalBusyBlock` → `schema.prisma:L12384`
- `Feature` → `schema.prisma:L3967`
- `FeeSchedule` → `schema.prisma:L4045`
- `FeeTier` → `schema.prisma:L4056`
- `FinancialAccount` → `schema.prisma:L13194`
- `FinancialConnection` → `schema.prisma:L13163`
- `FinancialProvider` → `schema.prisma:L13149`
- `FiscalEmisor` → `schema.prisma:L14345`
- `FiscalLossCarryforward` → `schema.prisma:L14916`
- `FixedAsset` → `schema.prisma:L14934`
- `FixedAssetDepreciation` → `schema.prisma:L14963`
- `FloorElement` → `schema.prisma:L2841`
- `FulfillmentArea` → `schema.prisma:L13405`
- `GeofenceRule` → `schema.prisma:L8716`
- `GoogleCalendarChannel` → `schema.prisma:L12361`
- `GoogleCalendarConnection` → `schema.prisma:L12313`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12414`
- `GoogleOAuthSession` → `schema.prisma:L12436`
- `HolidayCalendar` → `schema.prisma:L6052`
- `IdempotencyRequest` → `schema.prisma:L10546`
- `InterVenueTransfer` → `schema.prisma:L2593`
- `InterVenueTransferAllocation` → `schema.prisma:L2676`
- `InterVenueTransferItem` → `schema.prisma:L2645`
- `InterVenueTransferReceipt` → `schema.prisma:L2703`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2719`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2747`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2731`
- `Inventory` → `schema.prisma:L1792`
- `InventoryMovement` → `schema.prisma:L1819`
- `InventoryPosting` → `schema.prisma:L1901`
- `InventoryPostingLine` → `schema.prisma:L1935`
- `InventoryTransfer` → `schema.prisma:L12976`
- `Invitation` → `schema.prisma:L1340`
- `Invoice` → `schema.prisma:L4068`
- `InvoiceItem` → `schema.prisma:L4094`
- `ItemCategory` → `schema.prisma:L10263`
- `JournalEntry` → `schema.prisma:L14703`
- `JournalLine` → `schema.prisma:L14731`
- `KdsOrder` → `schema.prisma:L13242`
- `KdsOrderItem` → `schema.prisma:L13259`
- `LearnedPatterns` → `schema.prisma:L8201`
- `LedgerAccount` → `schema.prisma:L14595`
- `LiveDemoSession` → `schema.prisma:L759`
- `LowStockAlert` → `schema.prisma:L2434`
- `LoyaltyConfig` → `schema.prisma:L6353`
- `LoyaltyTransaction` → `schema.prisma:L6376`
- `MarketingCampaign` → `schema.prisma:L11432`
- `McpAuthCode` → `schema.prisma:L14228`
- `McpOAuthClient` → `schema.prisma:L14212`
- `McpRefreshToken` → `schema.prisma:L14246`
- `McpToolCall` → `schema.prisma:L14267`
- `MeasurementUnit` → `schema.prisma:L13082`
- `Menu` → `schema.prisma:L1526`
- `MenuCategory` → `schema.prisma:L1463`
- `MenuCategoryAssignment` → `schema.prisma:L1561`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14142`
- `MerchantAccount` → `schema.prisma:L4667`
- `MerchantFiscalConfig` → `schema.prisma:L14393`
- `MerchantRevenueShare` → `schema.prisma:L5632`
- `MerchantRoutingRule` → `schema.prisma:L4789`
- `MilestoneAchievement` → `schema.prisma:L10859`
- `Modifier` → `schema.prisma:L3457`
- `ModifierGroup` → `schema.prisma:L3421`
- `Module` → `schema.prisma:L9172`
- `MoneyAnomaly` → `schema.prisma:L5535`
- `MonthlyVenueProfit` → `schema.prisma:L6078`
- `Notification` → `schema.prisma:L7117`
- `NotificationPreference` → `schema.prisma:L7164`
- `NotificationTemplate` → `schema.prisma:L7191`
- `OAuthState` → `schema.prisma:L1391`
- `OnboardingProgress` → `schema.prisma:L1409`
- `Order` → `schema.prisma:L3072`
- `OrderAction` → `schema.prisma:L3522`
- `OrderCustomer` → `schema.prisma:L3272`
- `OrderDiscount` → `schema.prisma:L6978`
- `OrderFulfillment` → `schema.prisma:L13460`
- `OrderFulfillmentLine` → `schema.prisma:L13491`
- `OrderItem` → `schema.prisma:L3288`
- `OrderItemModifier` → `schema.prisma:L3506`
- `OrderPromotion` → `schema.prisma:L15569`
- `OrderServiceCharge` → `schema.prisma:L7062`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11233`
- `OrganizationEntitlement` → `schema.prisma:L9455`
- `OrganizationGoal` → `schema.prisma:L11191`
- `OrganizationModule` → `schema.prisma:L9232`
- `OrganizationPaymentConfig` → `schema.prisma:L5241`
- `OrganizationPayoutConfig` → `schema.prisma:L11266`
- `OrganizationPricingStructure` → `schema.prisma:L5273`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11214`
- `OtpChallenge` → `schema.prisma:L6308`
- `PartnerAPIKey` → `schema.prisma:L5071`
- `Payment` → `schema.prisma:L3555`
- `PaymentAllocation` → `schema.prisma:L3817`
- `PaymentLink` → `schema.prisma:L12768`
- `PaymentLinkAttribution` → `schema.prisma:L12876`
- `PaymentLinkItem` → `schema.prisma:L12831`
- `PaymentLinkItemModifier` → `schema.prisma:L12858`
- `PaymentProvider` → `schema.prisma:L4626`
- `PayrollLine` → `schema.prisma:L15077`
- `PayrollRun` → `schema.prisma:L15046`
- `PerformanceGoal` → `schema.prisma:L11168`
- `PermissionOverride` → `schema.prisma:L1268`
- `PermissionSet` → `schema.prisma:L1291`
- `PlatformCfdi` → `schema.prisma:L15362`
- `PlatformEmisor` → `schema.prisma:L15302`
- `PlatformSettings` → `schema.prisma:L5048`
- `PosCommand` → `schema.prisma:L7245`
- `PosConnectionStatus` → `schema.prisma:L865`
- `PosSyncIntent` → `schema.prisma:L15440`
- `PricingPolicy` → `schema.prisma:L2338`
- `Printer` → `schema.prisma:L13288`
- `PrintGateway` → `schema.prisma:L13341`
- `PrintJob` → `schema.prisma:L14041`
- `PrintStation` → `schema.prisma:L13359`
- `ProcessedStripeEvent` → `schema.prisma:L5521`
- `ProcessorReliabilityMetric` → `schema.prisma:L6006`
- `Product` → `schema.prisma:L1579`
- `ProductModifierGroup` → `schema.prisma:L3494`
- `ProductOption` → `schema.prisma:L13059`
- `ProductOptionValue` → `schema.prisma:L13070`
- `ProductStaff` → `schema.prisma:L12024`
- `PromoterBankAccount` → `schema.prisma:L15197`
- `PromoterCommissionEntry` → `schema.prisma:L15216`
- `PromoterLocationPing` → `schema.prisma:L3038`
- `Promotion` → `schema.prisma:L15491`
- `PromotionGroup` → `schema.prisma:L15530`
- `PromotionOption` → `schema.prisma:L15546`
- `ProviderCostStructure` → `schema.prisma:L5557`
- `ProviderEventLog` → `schema.prisma:L5350`
- `PurchaseOrder` → `schema.prisma:L2206`
- `PurchaseOrderItem` → `schema.prisma:L2263`
- `RateCorrectionBatch` → `schema.prisma:L5782`
- `RateCorrectionEntry` → `schema.prisma:L5824`
- `RawMaterial` → `schema.prisma:L1967`
- `RawMaterialMovement` → `schema.prisma:L2391`
- `RawMaterialPresentation` → `schema.prisma:L2040`
- `Recipe` → `schema.prisma:L2060`
- `RecipeLine` → `schema.prisma:L2084`
- `Referral` → `schema.prisma:L6443`
- `ReferralProgramConfig` → `schema.prisma:L6408`
- `ReferralRewardGrant` → `schema.prisma:L6534`
- `ReferralTierReward` → `schema.prisma:L6506`
- `ReferralTierUnlock` → `schema.prisma:L6579`
- `Reservation` → `schema.prisma:L11811`
- `ReservationGoogleEventMapping` → `schema.prisma:L12548`
- `ReservationModifier` → `schema.prisma:L11972`
- `ReservationReminderSent` → `schema.prisma:L11955`
- `ReservationSettings` → `schema.prisma:L12186`
- `ReservationWaitlistEntry` → `schema.prisma:L12154`
- `Review` → `schema.prisma:L4112`
- `SalesRetention` → `schema.prisma:L14897`
- `SaleVerification` → `schema.prisma:L3871`
- `ScaleProfile` → `schema.prisma:L13782`
- `ScheduledCommand` → `schema.prisma:L8676`
- `SerializedItem` → `schema.prisma:L10306`
- `SerializedItemCustodyEvent` → `schema.prisma:L10469`
- `ServiceCharge` → `schema.prisma:L7033`
- `SettlementConfiguration` → `schema.prisma:L5857`
- `SettlementConfirmation` → `schema.prisma:L5970`
- `SettlementIncident` → `schema.prisma:L5921`
- `SettlementSimulation` → `schema.prisma:L5892`
- `Shift` → `schema.prisma:L2879`
- `SimRegistrationRequest` → `schema.prisma:L10507`
- `SimRegistrationRequestItem` → `schema.prisma:L10529`
- `SlotHold` → `schema.prisma:L12055`
- `Staff` → `schema.prisma:L885`
- `StaffOnboardingState` → `schema.prisma:L14112`
- `StaffOrganization` → `schema.prisma:L1181`
- `StaffPasskey` → `schema.prisma:L1208`
- `StaffSchedule` → `schema.prisma:L11995`
- `StaffScheduleException` → `schema.prisma:L12007`
- `StaffVenue` → `schema.prisma:L1111`
- `StockAlertConfig` → `schema.prisma:L11150`
- `StockBatch` → `schema.prisma:L2542`
- `StockCount` → `schema.prisma:L2466`
- `StockCountItem` → `schema.prisma:L2490`
- `StripeWebhookEvent` → `schema.prisma:L5504`
- `Supplier` → `schema.prisma:L2119`
- `SupplierPricing` → `schema.prisma:L2172`
- `Table` → `schema.prisma:L2791`
- `Terminal` → `schema.prisma:L4163`
- `TerminalHealth` → `schema.prisma:L4402`
- `TerminalLog` → `schema.prisma:L4376`
- `TerminalOrder` → `schema.prisma:L4529`
- `TerminalOrderItem` → `schema.prisma:L4604`
- `TerminalPaymentRequest` → `schema.prisma:L4473`
- `TimeEntry` → `schema.prisma:L2951`
- `TimeEntryBreak` → `schema.prisma:L3020`
- `TokenPurchase` → `schema.prisma:L8350`
- `TokenUsageRecord` → `schema.prisma:L8322`
- `TpvCommandHistory` → `schema.prisma:L8582`
- `TpvCommandQueue` → `schema.prisma:L8522`
- `TpvFeedback` → `schema.prisma:L8235`
- `TpvMessage` → `schema.prisma:L11507`
- `TpvMessageDelivery` → `schema.prisma:L11559`
- `TpvMessageResponse` → `schema.prisma:L11582`
- `TrainingModule` → `schema.prisma:L11637`
- `TrainingProgress` → `schema.prisma:L11714`
- `TrainingQuizQuestion` → `schema.prisma:L11696`
- `TrainingStep` → `schema.prisma:L11676`
- `TransactionCost` → `schema.prisma:L5720`
- `UnitConversion` → `schema.prisma:L2369`
- `UpsellAcceptance` → `schema.prisma:L6854`
- `UpsellAiRun` → `schema.prisma:L6874`
- `UpsellImpression` → `schema.prisma:L6814`
- `UpsellRule` → `schema.prisma:L6744`
- `user_sessions` → `schema.prisma:L5106`
- `Venue` → `schema.prisma:L147`
- `VenueAreaTicketSettings` → `schema.prisma:L13519`
- `VenueChatMessage` → `schema.prisma:L735`
- `VenueChatSession` → `schema.prisma:L690`
- `VenueCommission` → `schema.prisma:L13220`
- `VenueCreditAssessment` → `schema.prisma:L9044`
- `VenueCryptoConfig` → `schema.prisma:L11374`
- `VenueFeature` → `schema.prisma:L3985`
- `VenueModule` → `schema.prisma:L9204`
- `VenuePaymentConfig` → `schema.prisma:L5207`
- `VenuePaymentLinkSettings` → `schema.prisma:L12581`
- `VenuePricingStructure` → `schema.prisma:L5660`
- `VenueRoleConfig` → `schema.prisma:L1320`
- `VenueRolePermission` → `schema.prisma:L1238`
- `VenueScaleSettings` → `schema.prisma:L13770`
- `VenueSettings` → `schema.prisma:L775`
- `VenueTenderType` → `schema.prisma:L3730`
- `VenueTenderTypeRevision` → `schema.prisma:L3795`
- `VenueTransaction` → `schema.prisma:L3922`
- `VenueWhatsappActivation` → `schema.prisma:L626`
- `WebhookEvent` → `schema.prisma:L4021`
- `WebhookSubscription` → `schema.prisma:L5323`
- `WhatsappContactWindow` → `schema.prisma:L644`
- `WhatsappInboundEvent` → `schema.prisma:L664`
- `Zone` → `schema.prisma:L130`
