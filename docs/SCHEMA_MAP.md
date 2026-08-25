# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **336 models / 329 enums / ~16,000 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L15102`
- `AccountMapping` → `schema.prisma:L14998`
- `ActivityLog` → `schema.prisma:L6245`
- `Aggregator` → `schema.prisma:L13399`
- `AngelPayUserAccount` → `schema.prisma:L4908`
- `AppUpdate` → `schema.prisma:L11579`
- `Area` → `schema.prisma:L2814`
- `AreaTicket` → `schema.prisma:L13893`
- `AreaTicketCheckoutSession` → `schema.prisma:L14015`
- `AreaTicketExternalIncident` → `schema.prisma:L14262`
- `AreaTicketExternalSettlement` → `schema.prisma:L14227`
- `AreaTicketFulfillment` → `schema.prisma:L14091`
- `AreaTicketInventoryReservation` → `schema.prisma:L13986`
- `AreaTicketLine` → `schema.prisma:L13954`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14047`
- `AreaTicketPrintAttempt` → `schema.prisma:L14070`
- `BankStatement` → `schema.prisma:L14872`
- `BankStatementLine` → `schema.prisma:L14893`
- `BillingTaxProfile` → `schema.prisma:L15682`
- `BulkCommandOperation` → `schema.prisma:L8892`
- `CalendarSyncOutbox` → `schema.prisma:L12786`
- `CampaignDelivery` → `schema.prisma:L11737`
- `CashCloseout` → `schema.prisma:L9257`
- `CashDeposit` → `schema.prisma:L11381`
- `CashDrawerEvent` → `schema.prisma:L13236`
- `CashDrawerSession` → `schema.prisma:L13212`
- `CashOutCommissionRate` → `schema.prisma:L15511`
- `CashOutScheduleDay` → `schema.prisma:L15534`
- `CashOutWithdrawal` → `schema.prisma:L15596`
- `CatalogBindingBatch` → `schema.prisma:L10288`
- `CatalogBindingLine` → `schema.prisma:L10324`
- `CatalogBrand` → `schema.prisma:L9741`
- `CatalogClientObservation` → `schema.prisma:L10054`
- `CatalogClientReadinessOverride` → `schema.prisma:L10073`
- `CatalogFamily` → `schema.prisma:L9791`
- `CatalogIdempotencyRecord` → `schema.prisma:L10187`
- `CatalogIdentifier` → `schema.prisma:L9922`
- `CatalogImportBatch` → `schema.prisma:L10230`
- `CatalogImportLine` → `schema.prisma:L10267`
- `CatalogItem` → `schema.prisma:L9824`
- `CatalogItemBusinessType` → `schema.prisma:L9884`
- `CatalogItemPrice` → `schema.prisma:L9972`
- `CatalogManufacturer` → `schema.prisma:L9765`
- `CatalogProductTypeMapping` → `schema.prisma:L9901`
- `CatalogPublicationBatch` → `schema.prisma:L10352`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10446`
- `CatalogPublicationLine` → `schema.prisma:L10393`
- `CatalogPublicationOutbox` → `schema.prisma:L10489`
- `CatalogValidationProfile` → `schema.prisma:L9943`
- `CatalogVenueBinding` → `schema.prisma:L10101`
- `CatalogVenueClientRequirement` → `schema.prisma:L10028`
- `CatalogVenueEventSequence` → `schema.prisma:L10472`
- `CatalogVenueOverride` → `schema.prisma:L10143`
- `CatalogVenueRollout` → `schema.prisma:L10003`
- `Cfdi` → `schema.prisma:L14775`
- `ChatbotTokenBudget` → `schema.prisma:L8540`
- `ChatConversation` → `schema.prisma:L8395`
- `ChatFeedback` → `schema.prisma:L8481`
- `ChatLearningEvent` → `schema.prisma:L8438`
- `ChatMessage` → `schema.prisma:L8418`
- `ChatTrainingData` → `schema.prisma:L8352`
- `CheckoutSession` → `schema.prisma:L5188`
- `ClassSession` → `schema.prisma:L12390`
- `CommissionCalculation` → `schema.prisma:L11160`
- `CommissionClawback` → `schema.prisma:L11333`
- `CommissionConfig` → `schema.prisma:L10933`
- `CommissionMilestone` → `schema.prisma:L11076`
- `CommissionOverride` → `schema.prisma:L11003`
- `CommissionPayout` → `schema.prisma:L11284`
- `CommissionSummary` → `schema.prisma:L11223`
- `CommissionTier` → `schema.prisma:L11040`
- `Consumer` → `schema.prisma:L6404`
- `ConsumerAuthAccount` → `schema.prisma:L6429`
- `CouponCode` → `schema.prisma:L7050`
- `CouponRedemption` → `schema.prisma:L7081`
- `CreditAssessmentHistory` → `schema.prisma:L9366`
- `CreditItemBalance` → `schema.prisma:L13002`
- `CreditOffer` → `schema.prisma:L9385`
- `CreditPack` → `schema.prisma:L12911`
- `CreditPackItem` → `schema.prisma:L12940`
- `CreditPackPurchase` → `schema.prisma:L12957`
- `CreditTransaction` → `schema.prisma:L13024`
- `Customer` → `schema.prisma:L6286`
- `CustomerApprovalDelivery` → `schema.prisma:L8057`
- `CustomerApprovalOutbox` → `schema.prisma:L8032`
- `CustomerDiscount` → `schema.prisma:L7101`
- `CustomerGroup` → `schema.prisma:L6468`
- `CustomerTaxProfile` → `schema.prisma:L14844`
- `DeliveryActivationRequest` → `schema.prisma:L5529`
- `DeliveryChannelLink` → `schema.prisma:L5474`
- `DeliveryOrderEvent` → `schema.prisma:L5553`
- `DeviceToken` → `schema.prisma:L7370`
- `DigitalReceipt` → `schema.prisma:L3903`
- `Discount` → `schema.prisma:L6740`
- `EcommerceMerchant` → `schema.prisma:L5000`
- `EmailTemplate` → `schema.prisma:L11676`
- `Employee` → `schema.prisma:L15359`
- `Estimate` → `schema.prisma:L13306`
- `EstimateItem` → `schema.prisma:L13334`
- `Expense` → `schema.prisma:L15146`
- `ExternalBusyBlock` → `schema.prisma:L12679`
- `Feature` → `schema.prisma:L4032`
- `FeeSchedule` → `schema.prisma:L4110`
- `FeeTier` → `schema.prisma:L4121`
- `FinancialAccount` → `schema.prisma:L13496`
- `FinancialConnection` → `schema.prisma:L13465`
- `FinancialProvider` → `schema.prisma:L13451`
- `FiscalEmisor` → `schema.prisma:L14698`
- `FiscalLossCarryforward` → `schema.prisma:L15269`
- `FixedAsset` → `schema.prisma:L15287`
- `FixedAssetDepreciation` → `schema.prisma:L15316`
- `FloorElement` → `schema.prisma:L2890`
- `FulfillmentArea` → `schema.prisma:L13758`
- `GeofenceRule` → `schema.prisma:L8977`
- `GoogleCalendarChannel` → `schema.prisma:L12656`
- `GoogleCalendarConnection` → `schema.prisma:L12608`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12709`
- `GoogleOAuthSession` → `schema.prisma:L12731`
- `HolidayCalendar` → `schema.prisma:L6169`
- `IdempotencyRequest` → `schema.prisma:L10808`
- `InterVenueTransfer` → `schema.prisma:L2642`
- `InterVenueTransferAllocation` → `schema.prisma:L2725`
- `InterVenueTransferItem` → `schema.prisma:L2694`
- `InterVenueTransferReceipt` → `schema.prisma:L2752`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2768`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2796`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2780`
- `Inventory` → `schema.prisma:L1835`
- `InventoryMovement` → `schema.prisma:L1862`
- `InventoryPosting` → `schema.prisma:L1944`
- `InventoryPostingLine` → `schema.prisma:L1984`
- `InventoryTransfer` → `schema.prisma:L13278`
- `Invitation` → `schema.prisma:L1375`
- `Invoice` → `schema.prisma:L4133`
- `InvoiceItem` → `schema.prisma:L4159`
- `ItemCategory` → `schema.prisma:L10524`
- `JournalEntry` → `schema.prisma:L15056`
- `JournalLine` → `schema.prisma:L15084`
- `KdsOrder` → `schema.prisma:L13544`
- `KdsOrderItem` → `schema.prisma:L13585`
- `KioskCheckInAttempt` → `schema.prisma:L16005`
- `KioskCheckInChallenge` → `schema.prisma:L15959`
- `KioskOutreachOutbox` → `schema.prisma:L16026`
- `LearnedPatterns` → `schema.prisma:L8462`
- `LedgerAccount` → `schema.prisma:L14948`
- `LiveDemoSession` → `schema.prisma:L776`
- `LowStockAlert` → `schema.prisma:L2483`
- `LoyaltyConfig` → `schema.prisma:L6498`
- `LoyaltyTransaction` → `schema.prisma:L6521`
- `MarketingCampaign` → `schema.prisma:L11694`
- `McpAuthCode` → `schema.prisma:L14581`
- `McpOAuthClient` → `schema.prisma:L14565`
- `McpRefreshToken` → `schema.prisma:L14599`
- `McpToolCall` → `schema.prisma:L14620`
- `MeasurementUnit` → `schema.prisma:L13384`
- `Menu` → `schema.prisma:L1561`
- `MenuCategory` → `schema.prisma:L1498`
- `MenuCategoryAssignment` → `schema.prisma:L1596`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14495`
- `MerchantAccount` → `schema.prisma:L4738`
- `MerchantFiscalConfig` → `schema.prisma:L14746`
- `MerchantRevenueShare` → `schema.prisma:L5749`
- `MerchantRoutingRule` → `schema.prisma:L4860`
- `MilestoneAchievement` → `schema.prisma:L11121`
- `Modifier` → `schema.prisma:L3518`
- `ModifierGroup` → `schema.prisma:L3482`
- `Module` → `schema.prisma:L9433`
- `MoneyAnomaly` → `schema.prisma:L5652`
- `MonthlyVenueProfit` → `schema.prisma:L6195`
- `Notification` → `schema.prisma:L7272`
- `NotificationPreference` → `schema.prisma:L7319`
- `NotificationTemplate` → `schema.prisma:L7346`
- `OAuthState` → `schema.prisma:L1426`
- `OnboardingProgress` → `schema.prisma:L1444`
- `Order` → `schema.prisma:L3121`
- `OrderAction` → `schema.prisma:L3583`
- `OrderCustomer` → `schema.prisma:L3333`
- `OrderDiscount` → `schema.prisma:L7133`
- `OrderFulfillment` → `schema.prisma:L13813`
- `OrderFulfillmentLine` → `schema.prisma:L13844`
- `OrderItem` → `schema.prisma:L3349`
- `OrderItemModifier` → `schema.prisma:L3567`
- `OrderPromotion` → `schema.prisma:L15922`
- `OrderServiceCharge` → `schema.prisma:L7217`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11495`
- `OrganizationEntitlement` → `schema.prisma:L9716`
- `OrganizationGoal` → `schema.prisma:L11453`
- `OrganizationModule` → `schema.prisma:L9493`
- `OrganizationPaymentConfig` → `schema.prisma:L5312`
- `OrganizationPayoutConfig` → `schema.prisma:L11528`
- `OrganizationPricingStructure` → `schema.prisma:L5344`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11476`
- `OtpChallenge` → `schema.prisma:L6448`
- `PartnerAPIKey` → `schema.prisma:L5142`
- `Payment` → `schema.prisma:L3616`
- `PaymentAllocation` → `schema.prisma:L3882`
- `PaymentLink` → `schema.prisma:L13070`
- `PaymentLinkAttribution` → `schema.prisma:L13178`
- `PaymentLinkItem` → `schema.prisma:L13133`
- `PaymentLinkItemModifier` → `schema.prisma:L13160`
- `PaymentProvider` → `schema.prisma:L4697`
- `PayrollLine` → `schema.prisma:L15430`
- `PayrollRun` → `schema.prisma:L15399`
- `PerformanceGoal` → `schema.prisma:L11430`
- `PermissionOverride` → `schema.prisma:L1303`
- `PermissionSet` → `schema.prisma:L1326`
- `PlatformCfdi` → `schema.prisma:L15715`
- `PlatformEmisor` → `schema.prisma:L15655`
- `PlatformSettings` → `schema.prisma:L5119`
- `PosCommand` → `schema.prisma:L7400`
- `PosConnectionStatus` → `schema.prisma:L882`
- `PosSyncIntent` → `schema.prisma:L15793`
- `PricingPolicy` → `schema.prisma:L2387`
- `Printer` → `schema.prisma:L13627`
- `PrintGateway` → `schema.prisma:L13680`
- `PrintJob` → `schema.prisma:L14394`
- `PrintStation` → `schema.prisma:L13698`
- `ProcessedStripeEvent` → `schema.prisma:L5638`
- `ProcessorReliabilityMetric` → `schema.prisma:L6123`
- `Product` → `schema.prisma:L1614`
- `ProductModifierGroup` → `schema.prisma:L3555`
- `ProductOption` → `schema.prisma:L13361`
- `ProductOptionValue` → `schema.prisma:L13372`
- `ProductStaff` → `schema.prisma:L12305`
- `PromoterBankAccount` → `schema.prisma:L15550`
- `PromoterCommissionEntry` → `schema.prisma:L15569`
- `PromoterLocationPing` → `schema.prisma:L3087`
- `Promotion` → `schema.prisma:L15844`
- `PromotionGroup` → `schema.prisma:L15883`
- `PromotionOption` → `schema.prisma:L15899`
- `ProviderCostStructure` → `schema.prisma:L5674`
- `ProviderEventLog` → `schema.prisma:L5421`
- `PurchaseOrder` → `schema.prisma:L2255`
- `PurchaseOrderItem` → `schema.prisma:L2312`
- `RateCorrectionBatch` → `schema.prisma:L5899`
- `RateCorrectionEntry` → `schema.prisma:L5941`
- `RawMaterial` → `schema.prisma:L2016`
- `RawMaterialMovement` → `schema.prisma:L2440`
- `RawMaterialPresentation` → `schema.prisma:L2089`
- `Recipe` → `schema.prisma:L2109`
- `RecipeLine` → `schema.prisma:L2133`
- `Referral` → `schema.prisma:L6588`
- `ReferralProgramConfig` → `schema.prisma:L6553`
- `ReferralRewardGrant` → `schema.prisma:L6679`
- `ReferralTierReward` → `schema.prisma:L6651`
- `ReferralTierUnlock` → `schema.prisma:L6724`
- `Reservation` → `schema.prisma:L12073`
- `ReservationGoogleEventMapping` → `schema.prisma:L12843`
- `ReservationModifier` → `schema.prisma:L12253`
- `ReservationReminderSent` → `schema.prisma:L12236`
- `ReservationSettings` → `schema.prisma:L12467`
- `ReservationWaitlistEntry` → `schema.prisma:L12435`
- `Review` → `schema.prisma:L4177`
- `SalesRetention` → `schema.prisma:L15250`
- `SaleVerification` → `schema.prisma:L3936`
- `ScaleProfile` → `schema.prisma:L14135`
- `ScheduledCommand` → `schema.prisma:L8937`
- `SerializedItem` → `schema.prisma:L10567`
- `SerializedItemCustodyEvent` → `schema.prisma:L10731`
- `ServiceCharge` → `schema.prisma:L7188`
- `SettlementConfiguration` → `schema.prisma:L5974`
- `SettlementConfirmation` → `schema.prisma:L6087`
- `SettlementIncident` → `schema.prisma:L6038`
- `SettlementSimulation` → `schema.prisma:L6009`
- `Shift` → `schema.prisma:L2928`
- `SimRegistrationRequest` → `schema.prisma:L10769`
- `SimRegistrationRequestItem` → `schema.prisma:L10791`
- `SlotHold` → `schema.prisma:L12336`
- `Staff` → `schema.prisma:L902`
- `StaffOnboardingState` → `schema.prisma:L14465`
- `StaffOrganization` → `schema.prisma:L1202`
- `StaffPasskey` → `schema.prisma:L1229`
- `StaffSchedule` → `schema.prisma:L12276`
- `StaffScheduleException` → `schema.prisma:L12288`
- `StaffVenue` → `schema.prisma:L1132`
- `StockAlertConfig` → `schema.prisma:L11412`
- `StockBatch` → `schema.prisma:L2591`
- `StockCount` → `schema.prisma:L2515`
- `StockCountItem` → `schema.prisma:L2539`
- `StripeWebhookEvent` → `schema.prisma:L5621`
- `Supplier` → `schema.prisma:L2168`
- `SupplierPricing` → `schema.prisma:L2221`
- `Table` → `schema.prisma:L2840`
- `Terminal` → `schema.prisma:L4228`
- `TerminalHealth` → `schema.prisma:L4467`
- `TerminalLog` → `schema.prisma:L4441`
- `TerminalOrder` → `schema.prisma:L4600`
- `TerminalOrderItem` → `schema.prisma:L4675`
- `TerminalPaymentRequest` → `schema.prisma:L4538`
- `TimeEntry` → `schema.prisma:L3000`
- `TimeEntryBreak` → `schema.prisma:L3069`
- `TokenPurchase` → `schema.prisma:L8611`
- `TokenUsageRecord` → `schema.prisma:L8583`
- `TpvCommandHistory` → `schema.prisma:L8843`
- `TpvCommandQueue` → `schema.prisma:L8783`
- `TpvFeedback` → `schema.prisma:L8496`
- `TpvMessage` → `schema.prisma:L11769`
- `TpvMessageDelivery` → `schema.prisma:L11821`
- `TpvMessageResponse` → `schema.prisma:L11844`
- `TrainingModule` → `schema.prisma:L11899`
- `TrainingProgress` → `schema.prisma:L11976`
- `TrainingQuizQuestion` → `schema.prisma:L11958`
- `TrainingStep` → `schema.prisma:L11938`
- `TransactionCost` → `schema.prisma:L5837`
- `UnitConversion` → `schema.prisma:L2418`
- `UpsellAcceptance` → `schema.prisma:L7009`
- `UpsellAiRun` → `schema.prisma:L7029`
- `UpsellImpression` → `schema.prisma:L6969`
- `UpsellRule` → `schema.prisma:L6889`
- `user_sessions` → `schema.prisma:L5177`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L13872`
- `VenueChatMessage` → `schema.prisma:L752`
- `VenueChatSession` → `schema.prisma:L707`
- `VenueCommission` → `schema.prisma:L13522`
- `VenueCreditAssessment` → `schema.prisma:L9305`
- `VenueCryptoConfig` → `schema.prisma:L11636`
- `VenueFeature` → `schema.prisma:L4050`
- `VenueModule` → `schema.prisma:L9465`
- `VenuePaymentConfig` → `schema.prisma:L5278`
- `VenuePaymentLinkSettings` → `schema.prisma:L12876`
- `VenuePricingStructure` → `schema.prisma:L5777`
- `VenueRoleConfig` → `schema.prisma:L1355`
- `VenueRolePermission` → `schema.prisma:L1259`
- `VenueScaleSettings` → `schema.prisma:L14123`
- `VenueSettings` → `schema.prisma:L792`
- `VenueTenderType` → `schema.prisma:L3795`
- `VenueTenderTypeRevision` → `schema.prisma:L3860`
- `VenueTransaction` → `schema.prisma:L3987`
- `VenueWhatsappActivation` → `schema.prisma:L643`
- `WebhookEvent` → `schema.prisma:L4086`
- `WebhookSubscription` → `schema.prisma:L5394`
- `WhatsappContactWindow` → `schema.prisma:L661`
- `WhatsappInboundEvent` → `schema.prisma:L681`
- `Zone` → `schema.prisma:L142`
