# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **337 models / 330 enums / ~16,100 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L15154`
- `AccountMapping` → `schema.prisma:L15050`
- `ActivityLog` → `schema.prisma:L6246`
- `Aggregator` → `schema.prisma:L13451`
- `AngelPayUserAccount` → `schema.prisma:L4909`
- `AppUpdate` → `schema.prisma:L11631`
- `Area` → `schema.prisma:L2815`
- `AreaTicket` → `schema.prisma:L13945`
- `AreaTicketCheckoutSession` → `schema.prisma:L14067`
- `AreaTicketExternalIncident` → `schema.prisma:L14314`
- `AreaTicketExternalSettlement` → `schema.prisma:L14279`
- `AreaTicketFulfillment` → `schema.prisma:L14143`
- `AreaTicketInventoryReservation` → `schema.prisma:L14038`
- `AreaTicketLine` → `schema.prisma:L14006`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14099`
- `AreaTicketPrintAttempt` → `schema.prisma:L14122`
- `BankStatement` → `schema.prisma:L14924`
- `BankStatementLine` → `schema.prisma:L14945`
- `BillingTaxProfile` → `schema.prisma:L15734`
- `BulkCommandOperation` → `schema.prisma:L8944`
- `CalendarSyncOutbox` → `schema.prisma:L12838`
- `CampaignDelivery` → `schema.prisma:L11789`
- `CashCloseout` → `schema.prisma:L9309`
- `CashDeposit` → `schema.prisma:L11433`
- `CashDrawerEvent` → `schema.prisma:L13288`
- `CashDrawerSession` → `schema.prisma:L13264`
- `CashOutCommissionRate` → `schema.prisma:L15563`
- `CashOutScheduleDay` → `schema.prisma:L15586`
- `CashOutWithdrawal` → `schema.prisma:L15648`
- `CatalogBindingBatch` → `schema.prisma:L10340`
- `CatalogBindingLine` → `schema.prisma:L10376`
- `CatalogBrand` → `schema.prisma:L9793`
- `CatalogClientObservation` → `schema.prisma:L10106`
- `CatalogClientReadinessOverride` → `schema.prisma:L10125`
- `CatalogFamily` → `schema.prisma:L9843`
- `CatalogIdempotencyRecord` → `schema.prisma:L10239`
- `CatalogIdentifier` → `schema.prisma:L9974`
- `CatalogImportBatch` → `schema.prisma:L10282`
- `CatalogImportLine` → `schema.prisma:L10319`
- `CatalogItem` → `schema.prisma:L9876`
- `CatalogItemBusinessType` → `schema.prisma:L9936`
- `CatalogItemPrice` → `schema.prisma:L10024`
- `CatalogManufacturer` → `schema.prisma:L9817`
- `CatalogProductTypeMapping` → `schema.prisma:L9953`
- `CatalogPublicationBatch` → `schema.prisma:L10404`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10498`
- `CatalogPublicationLine` → `schema.prisma:L10445`
- `CatalogPublicationOutbox` → `schema.prisma:L10541`
- `CatalogValidationProfile` → `schema.prisma:L9995`
- `CatalogVenueBinding` → `schema.prisma:L10153`
- `CatalogVenueClientRequirement` → `schema.prisma:L10080`
- `CatalogVenueEventSequence` → `schema.prisma:L10524`
- `CatalogVenueOverride` → `schema.prisma:L10195`
- `CatalogVenueRollout` → `schema.prisma:L10055`
- `Cfdi` → `schema.prisma:L14827`
- `ChatbotTokenBudget` → `schema.prisma:L8592`
- `ChatConversation` → `schema.prisma:L8447`
- `ChatFeedback` → `schema.prisma:L8533`
- `ChatLearningEvent` → `schema.prisma:L8490`
- `ChatMessage` → `schema.prisma:L8470`
- `ChatTrainingData` → `schema.prisma:L8404`
- `CheckoutSession` → `schema.prisma:L5189`
- `ClassSession` → `schema.prisma:L12442`
- `CommissionCalculation` → `schema.prisma:L11212`
- `CommissionClawback` → `schema.prisma:L11385`
- `CommissionConfig` → `schema.prisma:L10985`
- `CommissionMilestone` → `schema.prisma:L11128`
- `CommissionOverride` → `schema.prisma:L11055`
- `CommissionPayout` → `schema.prisma:L11336`
- `CommissionSummary` → `schema.prisma:L11275`
- `CommissionTier` → `schema.prisma:L11092`
- `Consumer` → `schema.prisma:L6406`
- `ConsumerAuthAccount` → `schema.prisma:L6431`
- `CouponCode` → `schema.prisma:L7102`
- `CouponRedemption` → `schema.prisma:L7133`
- `CreditAssessmentHistory` → `schema.prisma:L9418`
- `CreditItemBalance` → `schema.prisma:L13054`
- `CreditOffer` → `schema.prisma:L9437`
- `CreditPack` → `schema.prisma:L12963`
- `CreditPackItem` → `schema.prisma:L12992`
- `CreditPackPurchase` → `schema.prisma:L13009`
- `CreditTransaction` → `schema.prisma:L13076`
- `Customer` → `schema.prisma:L6287`
- `CustomerApprovalDelivery` → `schema.prisma:L8109`
- `CustomerApprovalOutbox` → `schema.prisma:L8084`
- `CustomerDiscount` → `schema.prisma:L7153`
- `CustomerGroup` → `schema.prisma:L6470`
- `CustomerTaxProfile` → `schema.prisma:L14896`
- `DeliveryActivationRequest` → `schema.prisma:L5530`
- `DeliveryChannelLink` → `schema.prisma:L5475`
- `DeliveryOrderEvent` → `schema.prisma:L5554`
- `DeviceToken` → `schema.prisma:L7422`
- `DigitalReceipt` → `schema.prisma:L3904`
- `Discount` → `schema.prisma:L6792`
- `EcommerceMerchant` → `schema.prisma:L5001`
- `EmailTemplate` → `schema.prisma:L11728`
- `Employee` → `schema.prisma:L15411`
- `Estimate` → `schema.prisma:L13358`
- `EstimateItem` → `schema.prisma:L13386`
- `Expense` → `schema.prisma:L15198`
- `ExternalBusyBlock` → `schema.prisma:L12731`
- `Feature` → `schema.prisma:L4033`
- `FeeSchedule` → `schema.prisma:L4111`
- `FeeTier` → `schema.prisma:L4122`
- `FinancialAccount` → `schema.prisma:L13548`
- `FinancialConnection` → `schema.prisma:L13517`
- `FinancialProvider` → `schema.prisma:L13503`
- `FiscalEmisor` → `schema.prisma:L14750`
- `FiscalLossCarryforward` → `schema.prisma:L15321`
- `FixedAsset` → `schema.prisma:L15339`
- `FixedAssetDepreciation` → `schema.prisma:L15368`
- `FloorElement` → `schema.prisma:L2891`
- `FulfillmentArea` → `schema.prisma:L13810`
- `GeofenceRule` → `schema.prisma:L9029`
- `GoogleCalendarChannel` → `schema.prisma:L12708`
- `GoogleCalendarConnection` → `schema.prisma:L12660`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12761`
- `GoogleOAuthSession` → `schema.prisma:L12783`
- `HolidayCalendar` → `schema.prisma:L6170`
- `IdempotencyRequest` → `schema.prisma:L10860`
- `InterVenueTransfer` → `schema.prisma:L2643`
- `InterVenueTransferAllocation` → `schema.prisma:L2726`
- `InterVenueTransferItem` → `schema.prisma:L2695`
- `InterVenueTransferReceipt` → `schema.prisma:L2753`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2769`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2797`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2781`
- `Inventory` → `schema.prisma:L1836`
- `InventoryMovement` → `schema.prisma:L1863`
- `InventoryPosting` → `schema.prisma:L1945`
- `InventoryPostingLine` → `schema.prisma:L1985`
- `InventoryTransfer` → `schema.prisma:L13330`
- `Invitation` → `schema.prisma:L1376`
- `Invoice` → `schema.prisma:L4134`
- `InvoiceItem` → `schema.prisma:L4160`
- `ItemCategory` → `schema.prisma:L10576`
- `JournalEntry` → `schema.prisma:L15108`
- `JournalLine` → `schema.prisma:L15136`
- `KdsOrder` → `schema.prisma:L13596`
- `KdsOrderItem` → `schema.prisma:L13637`
- `KioskCheckInAttempt` → `schema.prisma:L16057`
- `KioskCheckInChallenge` → `schema.prisma:L16011`
- `KioskOutreachOutbox` → `schema.prisma:L16078`
- `LearnedPatterns` → `schema.prisma:L8514`
- `LedgerAccount` → `schema.prisma:L15000`
- `LiveDemoSession` → `schema.prisma:L777`
- `LowStockAlert` → `schema.prisma:L2484`
- `LoyaltyConfig` → `schema.prisma:L6500`
- `LoyaltyTransaction` → `schema.prisma:L6523`
- `MarketingCampaign` → `schema.prisma:L11746`
- `McpAuthCode` → `schema.prisma:L14633`
- `McpOAuthClient` → `schema.prisma:L14617`
- `McpRefreshToken` → `schema.prisma:L14651`
- `McpToolCall` → `schema.prisma:L14672`
- `MeasurementUnit` → `schema.prisma:L13436`
- `Menu` → `schema.prisma:L1562`
- `MenuCategory` → `schema.prisma:L1499`
- `MenuCategoryAssignment` → `schema.prisma:L1597`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14547`
- `MerchantAccount` → `schema.prisma:L4739`
- `MerchantFiscalConfig` → `schema.prisma:L14798`
- `MerchantRevenueShare` → `schema.prisma:L5750`
- `MerchantRoutingRule` → `schema.prisma:L4861`
- `MilestoneAchievement` → `schema.prisma:L11173`
- `Modifier` → `schema.prisma:L3519`
- `ModifierGroup` → `schema.prisma:L3483`
- `Module` → `schema.prisma:L9485`
- `MoneyAnomaly` → `schema.prisma:L5653`
- `MonthlyVenueProfit` → `schema.prisma:L6196`
- `Notification` → `schema.prisma:L7324`
- `NotificationPreference` → `schema.prisma:L7371`
- `NotificationTemplate` → `schema.prisma:L7398`
- `OAuthState` → `schema.prisma:L1427`
- `OnboardingProgress` → `schema.prisma:L1445`
- `Order` → `schema.prisma:L3122`
- `OrderAction` → `schema.prisma:L3584`
- `OrderCustomer` → `schema.prisma:L3334`
- `OrderDiscount` → `schema.prisma:L7185`
- `OrderFulfillment` → `schema.prisma:L13865`
- `OrderFulfillmentLine` → `schema.prisma:L13896`
- `OrderItem` → `schema.prisma:L3350`
- `OrderItemModifier` → `schema.prisma:L3568`
- `OrderPromotion` → `schema.prisma:L15974`
- `OrderServiceCharge` → `schema.prisma:L7269`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11547`
- `OrganizationEntitlement` → `schema.prisma:L9768`
- `OrganizationGoal` → `schema.prisma:L11505`
- `OrganizationModule` → `schema.prisma:L9545`
- `OrganizationPaymentConfig` → `schema.prisma:L5313`
- `OrganizationPayoutConfig` → `schema.prisma:L11580`
- `OrganizationPricingStructure` → `schema.prisma:L5345`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11528`
- `OtpChallenge` → `schema.prisma:L6450`
- `PartnerAPIKey` → `schema.prisma:L5143`
- `Payment` → `schema.prisma:L3617`
- `PaymentAllocation` → `schema.prisma:L3883`
- `PaymentLink` → `schema.prisma:L13122`
- `PaymentLinkAttribution` → `schema.prisma:L13230`
- `PaymentLinkItem` → `schema.prisma:L13185`
- `PaymentLinkItemModifier` → `schema.prisma:L13212`
- `PaymentProvider` → `schema.prisma:L4698`
- `PayrollLine` → `schema.prisma:L15482`
- `PayrollRun` → `schema.prisma:L15451`
- `PerformanceGoal` → `schema.prisma:L11482`
- `PermissionOverride` → `schema.prisma:L1304`
- `PermissionSet` → `schema.prisma:L1327`
- `PlatformCfdi` → `schema.prisma:L15767`
- `PlatformEmisor` → `schema.prisma:L15707`
- `PlatformSettings` → `schema.prisma:L5120`
- `PosCommand` → `schema.prisma:L7452`
- `PosConnectionStatus` → `schema.prisma:L883`
- `PosSyncIntent` → `schema.prisma:L15845`
- `PricingPolicy` → `schema.prisma:L2388`
- `Printer` → `schema.prisma:L13679`
- `PrintGateway` → `schema.prisma:L13732`
- `PrintJob` → `schema.prisma:L14446`
- `PrintStation` → `schema.prisma:L13750`
- `ProcessedStripeEvent` → `schema.prisma:L5639`
- `ProcessorReliabilityMetric` → `schema.prisma:L6124`
- `Product` → `schema.prisma:L1615`
- `ProductModifierGroup` → `schema.prisma:L3556`
- `ProductOption` → `schema.prisma:L13413`
- `ProductOptionValue` → `schema.prisma:L13424`
- `ProductStaff` → `schema.prisma:L12357`
- `PromoterBankAccount` → `schema.prisma:L15602`
- `PromoterCommissionEntry` → `schema.prisma:L15621`
- `PromoterLocationPing` → `schema.prisma:L3088`
- `Promotion` → `schema.prisma:L15896`
- `PromotionGroup` → `schema.prisma:L15935`
- `PromotionOption` → `schema.prisma:L15951`
- `ProviderCostStructure` → `schema.prisma:L5675`
- `ProviderEventLog` → `schema.prisma:L5422`
- `PurchaseOrder` → `schema.prisma:L2256`
- `PurchaseOrderItem` → `schema.prisma:L2313`
- `RateCorrectionBatch` → `schema.prisma:L5900`
- `RateCorrectionEntry` → `schema.prisma:L5942`
- `RawMaterial` → `schema.prisma:L2017`
- `RawMaterialMovement` → `schema.prisma:L2441`
- `RawMaterialPresentation` → `schema.prisma:L2090`
- `Recipe` → `schema.prisma:L2110`
- `RecipeLine` → `schema.prisma:L2134`
- `Referral` → `schema.prisma:L6640`
- `ReferralProgramConfig` → `schema.prisma:L6605`
- `ReferralRewardGrant` → `schema.prisma:L6731`
- `ReferralTierReward` → `schema.prisma:L6703`
- `ReferralTierUnlock` → `schema.prisma:L6776`
- `Reservation` → `schema.prisma:L12125`
- `ReservationGoogleEventMapping` → `schema.prisma:L12895`
- `ReservationModifier` → `schema.prisma:L12305`
- `ReservationReminderSent` → `schema.prisma:L12288`
- `ReservationSettings` → `schema.prisma:L12519`
- `ReservationWaitlistEntry` → `schema.prisma:L12487`
- `Review` → `schema.prisma:L4178`
- `SalesRetention` → `schema.prisma:L15302`
- `SaleVerification` → `schema.prisma:L3937`
- `ScaleProfile` → `schema.prisma:L14187`
- `ScheduledCommand` → `schema.prisma:L8989`
- `SerializedItem` → `schema.prisma:L10619`
- `SerializedItemCustodyEvent` → `schema.prisma:L10783`
- `ServiceCharge` → `schema.prisma:L7240`
- `SettlementConfiguration` → `schema.prisma:L5975`
- `SettlementConfirmation` → `schema.prisma:L6088`
- `SettlementIncident` → `schema.prisma:L6039`
- `SettlementSimulation` → `schema.prisma:L6010`
- `Shift` → `schema.prisma:L2929`
- `SimRegistrationRequest` → `schema.prisma:L10821`
- `SimRegistrationRequestItem` → `schema.prisma:L10843`
- `SlotHold` → `schema.prisma:L12388`
- `Staff` → `schema.prisma:L903`
- `StaffOnboardingState` → `schema.prisma:L14517`
- `StaffOrganization` → `schema.prisma:L1203`
- `StaffPasskey` → `schema.prisma:L1230`
- `StaffSchedule` → `schema.prisma:L12328`
- `StaffScheduleException` → `schema.prisma:L12340`
- `StaffVenue` → `schema.prisma:L1133`
- `StockAlertConfig` → `schema.prisma:L11464`
- `StockBatch` → `schema.prisma:L2592`
- `StockCount` → `schema.prisma:L2516`
- `StockCountItem` → `schema.prisma:L2540`
- `StripeWebhookEvent` → `schema.prisma:L5622`
- `Supplier` → `schema.prisma:L2169`
- `SupplierPricing` → `schema.prisma:L2222`
- `Table` → `schema.prisma:L2841`
- `Terminal` → `schema.prisma:L4229`
- `TerminalHealth` → `schema.prisma:L4468`
- `TerminalLog` → `schema.prisma:L4442`
- `TerminalOrder` → `schema.prisma:L4601`
- `TerminalOrderItem` → `schema.prisma:L4676`
- `TerminalPaymentRequest` → `schema.prisma:L4539`
- `TimeEntry` → `schema.prisma:L3001`
- `TimeEntryBreak` → `schema.prisma:L3070`
- `TokenPurchase` → `schema.prisma:L8663`
- `TokenUsageRecord` → `schema.prisma:L8635`
- `TpvCommandHistory` → `schema.prisma:L8895`
- `TpvCommandQueue` → `schema.prisma:L8835`
- `TpvFeedback` → `schema.prisma:L8548`
- `TpvMessage` → `schema.prisma:L11821`
- `TpvMessageDelivery` → `schema.prisma:L11873`
- `TpvMessageResponse` → `schema.prisma:L11896`
- `TrainingModule` → `schema.prisma:L11951`
- `TrainingProgress` → `schema.prisma:L12028`
- `TrainingQuizQuestion` → `schema.prisma:L12010`
- `TrainingStep` → `schema.prisma:L11990`
- `TransactionCost` → `schema.prisma:L5838`
- `UnitConversion` → `schema.prisma:L2419`
- `UpsellAcceptance` → `schema.prisma:L7061`
- `UpsellAiRun` → `schema.prisma:L7081`
- `UpsellImpression` → `schema.prisma:L7021`
- `UpsellRule` → `schema.prisma:L6941`
- `user_sessions` → `schema.prisma:L5178`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L13924`
- `VenueChatMessage` → `schema.prisma:L753`
- `VenueChatSession` → `schema.prisma:L708`
- `VenueCommission` → `schema.prisma:L13574`
- `VenueCreditAssessment` → `schema.prisma:L9357`
- `VenueCryptoConfig` → `schema.prisma:L11688`
- `VenueFeature` → `schema.prisma:L4051`
- `VenueModule` → `schema.prisma:L9517`
- `VenuePaymentConfig` → `schema.prisma:L5279`
- `VenuePaymentLinkSettings` → `schema.prisma:L12928`
- `VenuePricingStructure` → `schema.prisma:L5778`
- `VenueRoleConfig` → `schema.prisma:L1356`
- `VenueRolePermission` → `schema.prisma:L1260`
- `VenueScaleSettings` → `schema.prisma:L14175`
- `VenueSettings` → `schema.prisma:L793`
- `VenueTenderType` → `schema.prisma:L3796`
- `VenueTenderTypeRevision` → `schema.prisma:L3861`
- `VenueTransaction` → `schema.prisma:L3988`
- `VenueWhatsappActivation` → `schema.prisma:L644`
- `WalletPass` → `schema.prisma:L6563`
- `WebhookEvent` → `schema.prisma:L4087`
- `WebhookSubscription` → `schema.prisma:L5395`
- `WhatsappContactWindow` → `schema.prisma:L662`
- `WhatsappInboundEvent` → `schema.prisma:L682`
- `Zone` → `schema.prisma:L142`
