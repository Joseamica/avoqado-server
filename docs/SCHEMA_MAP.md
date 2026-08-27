# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **347 models / 336 enums / ~16,600 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                            |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                          |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                           |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                           |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                            |
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

- `AccountingPeriodLock` → `schema.prisma:L15678`
- `AccountMapping` → `schema.prisma:L15574`
- `ActivityLog` → `schema.prisma:L6486`
- `Aggregator` → `schema.prisma:L13975`
- `AngelPayUserAccount` → `schema.prisma:L5149`
- `AppUpdate` → `schema.prisma:L12155`
- `Area` → `schema.prisma:L2941`
- `AreaTicket` → `schema.prisma:L14469`
- `AreaTicketCheckoutSession` → `schema.prisma:L14591`
- `AreaTicketExternalIncident` → `schema.prisma:L14838`
- `AreaTicketExternalSettlement` → `schema.prisma:L14803`
- `AreaTicketFulfillment` → `schema.prisma:L14667`
- `AreaTicketInventoryReservation` → `schema.prisma:L14562`
- `AreaTicketLine` → `schema.prisma:L14530`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14623`
- `AreaTicketPrintAttempt` → `schema.prisma:L14646`
- `BankStatement` → `schema.prisma:L15448`
- `BankStatementLine` → `schema.prisma:L15469`
- `BillingTaxProfile` → `schema.prisma:L16258`
- `BulkCommandOperation` → `schema.prisma:L9453`
- `CalendarSyncOutbox` → `schema.prisma:L13362`
- `CampaignDelivery` → `schema.prisma:L12313`
- `CashCloseout` → `schema.prisma:L9833`
- `CashDeposit` → `schema.prisma:L11957`
- `CashDrawerEvent` → `schema.prisma:L13812`
- `CashDrawerSession` → `schema.prisma:L13788`
- `CashOutCommissionRate` → `schema.prisma:L16087`
- `CashOutScheduleDay` → `schema.prisma:L16110`
- `CashOutWithdrawal` → `schema.prisma:L16172`
- `CatalogBindingBatch` → `schema.prisma:L10864`
- `CatalogBindingLine` → `schema.prisma:L10900`
- `CatalogBrand` → `schema.prisma:L10317`
- `CatalogClientObservation` → `schema.prisma:L10630`
- `CatalogClientReadinessOverride` → `schema.prisma:L10649`
- `CatalogFamily` → `schema.prisma:L10367`
- `CatalogIdempotencyRecord` → `schema.prisma:L10763`
- `CatalogIdentifier` → `schema.prisma:L10498`
- `CatalogImportBatch` → `schema.prisma:L10806`
- `CatalogImportLine` → `schema.prisma:L10843`
- `CatalogItem` → `schema.prisma:L10400`
- `CatalogItemBusinessType` → `schema.prisma:L10460`
- `CatalogItemPrice` → `schema.prisma:L10548`
- `CatalogManufacturer` → `schema.prisma:L10341`
- `CatalogProductTypeMapping` → `schema.prisma:L10477`
- `CatalogPublicationBatch` → `schema.prisma:L10928`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11022`
- `CatalogPublicationLine` → `schema.prisma:L10969`
- `CatalogPublicationOutbox` → `schema.prisma:L11065`
- `CatalogValidationProfile` → `schema.prisma:L10519`
- `CatalogVenueBinding` → `schema.prisma:L10677`
- `CatalogVenueClientRequirement` → `schema.prisma:L10604`
- `CatalogVenueEventSequence` → `schema.prisma:L11048`
- `CatalogVenueOverride` → `schema.prisma:L10719`
- `CatalogVenueRollout` → `schema.prisma:L10579`
- `Cfdi` → `schema.prisma:L15351`
- `ChatbotTokenBudget` → `schema.prisma:L9101`
- `ChatConversation` → `schema.prisma:L8956`
- `ChatFeedback` → `schema.prisma:L9042`
- `ChatLearningEvent` → `schema.prisma:L8999`
- `ChatMessage` → `schema.prisma:L8979`
- `ChatTrainingData` → `schema.prisma:L8913`
- `CheckoutSession` → `schema.prisma:L5429`
- `ClassSession` → `schema.prisma:L12966`
- `CommissionCalculation` → `schema.prisma:L11736`
- `CommissionClawback` → `schema.prisma:L11909`
- `CommissionConfig` → `schema.prisma:L11509`
- `CommissionMilestone` → `schema.prisma:L11652`
- `CommissionOverride` → `schema.prisma:L11579`
- `CommissionPayout` → `schema.prisma:L11860`
- `CommissionSummary` → `schema.prisma:L11799`
- `CommissionTier` → `schema.prisma:L11616`
- `Consumer` → `schema.prisma:L6648`
- `ConsumerAuthAccount` → `schema.prisma:L6673`
- `CouponCode` → `schema.prisma:L7611`
- `CouponRedemption` → `schema.prisma:L7642`
- `CreditAssessmentHistory` → `schema.prisma:L9942`
- `CreditItemBalance` → `schema.prisma:L13578`
- `CreditOffer` → `schema.prisma:L9961`
- `CreditPack` → `schema.prisma:L13487`
- `CreditPackItem` → `schema.prisma:L13516`
- `CreditPackPurchase` → `schema.prisma:L13533`
- `CreditTransaction` → `schema.prisma:L13600`
- `Customer` → `schema.prisma:L6527`
- `CustomerApprovalDelivery` → `schema.prisma:L8618`
- `CustomerApprovalOutbox` → `schema.prisma:L8593`
- `CustomerDiscount` → `schema.prisma:L7662`
- `CustomerGroup` → `schema.prisma:L6712`
- `CustomerTaxProfile` → `schema.prisma:L15420`
- `DeliveryActivationRequest` → `schema.prisma:L5770`
- `DeliveryChannelLink` → `schema.prisma:L5715`
- `DeliveryOrderEvent` → `schema.prisma:L5794`
- `DeviceToken` → `schema.prisma:L7931`
- `DigitalReceipt` → `schema.prisma:L4144`
- `Discount` → `schema.prisma:L7301`
- `EcommerceMerchant` → `schema.prisma:L5241`
- `EmailTemplate` → `schema.prisma:L12252`
- `Employee` → `schema.prisma:L15935`
- `Estimate` → `schema.prisma:L13882`
- `EstimateItem` → `schema.prisma:L13910`
- `Expense` → `schema.prisma:L15722`
- `ExternalBusyBlock` → `schema.prisma:L13255`
- `Feature` → `schema.prisma:L4273`
- `FeeSchedule` → `schema.prisma:L4351`
- `FeeTier` → `schema.prisma:L4362`
- `FinancialAccount` → `schema.prisma:L14072`
- `FinancialConnection` → `schema.prisma:L14041`
- `FinancialProvider` → `schema.prisma:L14027`
- `FiscalEmisor` → `schema.prisma:L15274`
- `FiscalLossCarryforward` → `schema.prisma:L15845`
- `FixedAsset` → `schema.prisma:L15863`
- `FixedAssetDepreciation` → `schema.prisma:L15892`
- `FloorElement` → `schema.prisma:L3017`
- `FulfillmentArea` → `schema.prisma:L14334`
- `GeofenceRule` → `schema.prisma:L9538`
- `GoogleCalendarChannel` → `schema.prisma:L13232`
- `GoogleCalendarConnection` → `schema.prisma:L13184`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13285`
- `GoogleOAuthSession` → `schema.prisma:L13307`
- `HolidayCalendar` → `schema.prisma:L6410`
- `IdempotencyRequest` → `schema.prisma:L11384`
- `InterVenueTransfer` → `schema.prisma:L2769`
- `InterVenueTransferAllocation` → `schema.prisma:L2852`
- `InterVenueTransferItem` → `schema.prisma:L2821`
- `InterVenueTransferReceipt` → `schema.prisma:L2879`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2895`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2923`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2907`
- `Inventory` → `schema.prisma:L1863`
- `InventoryMovement` → `schema.prisma:L1890`
- `InventoryPosting` → `schema.prisma:L1972`
- `InventoryPostingLine` → `schema.prisma:L2012`
- `InventoryTransfer` → `schema.prisma:L13854`
- `Invitation` → `schema.prisma:L1403`
- `Invoice` → `schema.prisma:L4374`
- `InvoiceItem` → `schema.prisma:L4400`
- `ItemCategory` → `schema.prisma:L11100`
- `JournalEntry` → `schema.prisma:L15632`
- `JournalLine` → `schema.prisma:L15660`
- `KdsOrder` → `schema.prisma:L14120`
- `KdsOrderItem` → `schema.prisma:L14161`
- `KioskCheckInAttempt` → `schema.prisma:L16581`
- `KioskCheckInChallenge` → `schema.prisma:L16535`
- `KioskOutreachOutbox` → `schema.prisma:L16602`
- `LearnedPatterns` → `schema.prisma:L9023`
- `LedgerAccount` → `schema.prisma:L15524`
- `LiveDemoSession` → `schema.prisma:L783`
- `LowStockAlert` → `schema.prisma:L2610`
- `LoyaltyConfig` → `schema.prisma:L6742`
- `LoyaltyTransaction` → `schema.prisma:L6785`
- `MarketingCampaign` → `schema.prisma:L12270`
- `McpAuthCode` → `schema.prisma:L15157`
- `McpOAuthClient` → `schema.prisma:L15141`
- `McpRefreshToken` → `schema.prisma:L15175`
- `McpToolCall` → `schema.prisma:L15196`
- `MeasurementUnit` → `schema.prisma:L13960`
- `Menu` → `schema.prisma:L1589`
- `MenuCategory` → `schema.prisma:L1526`
- `MenuCategoryAssignment` → `schema.prisma:L1624`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15071`
- `MerchantAccount` → `schema.prisma:L4979`
- `MerchantFiscalConfig` → `schema.prisma:L15322`
- `MerchantRevenueShare` → `schema.prisma:L5990`
- `MerchantRoutingRule` → `schema.prisma:L5101`
- `MilestoneAchievement` → `schema.prisma:L11697`
- `Modifier` → `schema.prisma:L3759`
- `ModifierGroup` → `schema.prisma:L3723`
- `Module` → `schema.prisma:L10009`
- `MoneyAnomaly` → `schema.prisma:L5893`
- `MonthlyVenueProfit` → `schema.prisma:L6436`
- `Notification` → `schema.prisma:L7833`
- `NotificationPreference` → `schema.prisma:L7880`
- `NotificationTemplate` → `schema.prisma:L7907`
- `OAuthState` → `schema.prisma:L1454`
- `OnboardingProgress` → `schema.prisma:L1472`
- `Order` → `schema.prisma:L3361`
- `OrderAction` → `schema.prisma:L3824`
- `OrderCustomer` → `schema.prisma:L3574`
- `OrderDiscount` → `schema.prisma:L7694`
- `OrderFulfillment` → `schema.prisma:L14389`
- `OrderFulfillmentLine` → `schema.prisma:L14420`
- `OrderItem` → `schema.prisma:L3590`
- `OrderItemModifier` → `schema.prisma:L3808`
- `OrderPromotion` → `schema.prisma:L16498`
- `OrderServiceCharge` → `schema.prisma:L7778`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12071`
- `OrganizationEntitlement` → `schema.prisma:L10292`
- `OrganizationGoal` → `schema.prisma:L12029`
- `OrganizationModule` → `schema.prisma:L10069`
- `OrganizationPaymentConfig` → `schema.prisma:L5553`
- `OrganizationPayoutConfig` → `schema.prisma:L12104`
- `OrganizationPricingStructure` → `schema.prisma:L5585`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12052`
- `OtpChallenge` → `schema.prisma:L6692`
- `PartnerAPIKey` → `schema.prisma:L5383`
- `Payment` → `schema.prisma:L3857`
- `PaymentAllocation` → `schema.prisma:L4123`
- `PaymentLink` → `schema.prisma:L13646`
- `PaymentLinkAttribution` → `schema.prisma:L13754`
- `PaymentLinkItem` → `schema.prisma:L13709`
- `PaymentLinkItemModifier` → `schema.prisma:L13736`
- `PaymentProvider` → `schema.prisma:L4938`
- `PayrollLine` → `schema.prisma:L16006`
- `PayrollRun` → `schema.prisma:L15975`
- `PerformanceGoal` → `schema.prisma:L12006`
- `PermissionOverride` → `schema.prisma:L1331`
- `PermissionSet` → `schema.prisma:L1354`
- `PlatformCfdi` → `schema.prisma:L16291`
- `PlatformEmisor` → `schema.prisma:L16231`
- `PlatformSettings` → `schema.prisma:L5360`
- `PosCommand` → `schema.prisma:L7961`
- `PosConnectionStatus` → `schema.prisma:L898`
- `PosSyncIntent` → `schema.prisma:L16369`
- `PricingPolicy` → `schema.prisma:L2514`
- `Printer` → `schema.prisma:L14203`
- `PrintGateway` → `schema.prisma:L14256`
- `PrintJob` → `schema.prisma:L14970`
- `PrintStation` → `schema.prisma:L14274`
- `ProcessedStripeEvent` → `schema.prisma:L5879`
- `ProcessorReliabilityMetric` → `schema.prisma:L6364`
- `Product` → `schema.prisma:L1642`
- `ProductModifierGroup` → `schema.prisma:L3796`
- `ProductOption` → `schema.prisma:L13937`
- `ProductOptionValue` → `schema.prisma:L13948`
- `ProductStaff` → `schema.prisma:L12881`
- `PromoterBankAccount` → `schema.prisma:L16126`
- `PromoterCommissionEntry` → `schema.prisma:L16145`
- `PromoterLocationPing` → `schema.prisma:L3327`
- `Promotion` → `schema.prisma:L16420`
- `PromotionGroup` → `schema.prisma:L16459`
- `PromotionOption` → `schema.prisma:L16475`
- `ProviderCostStructure` → `schema.prisma:L5915`
- `ProviderEventLog` → `schema.prisma:L5662`
- `PurchaseOrder` → `schema.prisma:L2284`
- `PurchaseOrderInvoice` → `schema.prisma:L2429`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2484`
- `PurchaseOrderItem` → `schema.prisma:L2342`
- `RateCorrectionBatch` → `schema.prisma:L6140`
- `RateCorrectionEntry` → `schema.prisma:L6182`
- `RawMaterial` → `schema.prisma:L2044`
- `RawMaterialMovement` → `schema.prisma:L2567`
- `RawMaterialPresentation` → `schema.prisma:L2117`
- `Recipe` → `schema.prisma:L2137`
- `RecipeLine` → `schema.prisma:L2161`
- `Referral` → `schema.prisma:L7149`
- `ReferralProgramConfig` → `schema.prisma:L7114`
- `ReferralRewardGrant` → `schema.prisma:L7240`
- `ReferralTierReward` → `schema.prisma:L7212`
- `ReferralTierUnlock` → `schema.prisma:L7285`
- `Reservation` → `schema.prisma:L12649`
- `ReservationGoogleEventMapping` → `schema.prisma:L13419`
- `ReservationModifier` → `schema.prisma:L12829`
- `ReservationReminderSent` → `schema.prisma:L12812`
- `ReservationSettings` → `schema.prisma:L13043`
- `ReservationWaitlistEntry` → `schema.prisma:L13011`
- `Review` → `schema.prisma:L4418`
- `SalesRetention` → `schema.prisma:L15826`
- `SaleVerification` → `schema.prisma:L4177`
- `ScaleProfile` → `schema.prisma:L14711`
- `ScheduledCommand` → `schema.prisma:L9498`
- `SerializedItem` → `schema.prisma:L11143`
- `SerializedItemCustodyEvent` → `schema.prisma:L11307`
- `ServiceCharge` → `schema.prisma:L7749`
- `SettlementConfiguration` → `schema.prisma:L6215`
- `SettlementConfirmation` → `schema.prisma:L6328`
- `SettlementIncident` → `schema.prisma:L6279`
- `SettlementSimulation` → `schema.prisma:L6250`
- `Shift` → `schema.prisma:L3055`
- `SimRegistrationRequest` → `schema.prisma:L11345`
- `SimRegistrationRequestItem` → `schema.prisma:L11367`
- `SlotHold` → `schema.prisma:L12912`
- `Staff` → `schema.prisma:L918`
- `StaffDocument` → `schema.prisma:L3198`
- `StaffOnboardingState` → `schema.prisma:L15041`
- `StaffOrganization` → `schema.prisma:L1230`
- `StaffPasskey` → `schema.prisma:L1257`
- `StaffSchedule` → `schema.prisma:L12852`
- `StaffScheduleException` → `schema.prisma:L12864`
- `StaffVenue` → `schema.prisma:L1156`
- `StaffWorkSchedule` → `schema.prisma:L3162`
- `StaffWorkScheduleException` → `schema.prisma:L3177`
- `StampCard` → `schema.prisma:L6997`
- `StampEvent` → `schema.prisma:L7036`
- `StampReward` → `schema.prisma:L7074`
- `StockAlertConfig` → `schema.prisma:L11988`
- `StockBatch` → `schema.prisma:L2718`
- `StockCount` → `schema.prisma:L2642`
- `StockCountItem` → `schema.prisma:L2666`
- `StripeWebhookEvent` → `schema.prisma:L5862`
- `Supplier` → `schema.prisma:L2196`
- `SupplierPricing` → `schema.prisma:L2250`
- `Table` → `schema.prisma:L2967`
- `Terminal` → `schema.prisma:L4469`
- `TerminalHealth` → `schema.prisma:L4708`
- `TerminalLog` → `schema.prisma:L4682`
- `TerminalOrder` → `schema.prisma:L4841`
- `TerminalOrderItem` → `schema.prisma:L4916`
- `TerminalPaymentRequest` → `schema.prisma:L4779`
- `TimeEntry` → `schema.prisma:L3240`
- `TimeEntryBreak` → `schema.prisma:L3309`
- `TokenPurchase` → `schema.prisma:L9172`
- `TokenUsageRecord` → `schema.prisma:L9144`
- `TpvCommandHistory` → `schema.prisma:L9404`
- `TpvCommandQueue` → `schema.prisma:L9344`
- `TpvFeedback` → `schema.prisma:L9057`
- `TpvMessage` → `schema.prisma:L12345`
- `TpvMessageDelivery` → `schema.prisma:L12397`
- `TpvMessageResponse` → `schema.prisma:L12420`
- `TrainingModule` → `schema.prisma:L12475`
- `TrainingProgress` → `schema.prisma:L12552`
- `TrainingQuizQuestion` → `schema.prisma:L12534`
- `TrainingStep` → `schema.prisma:L12514`
- `TransactionCost` → `schema.prisma:L6078`
- `UnitConversion` → `schema.prisma:L2545`
- `UpsellAcceptance` → `schema.prisma:L7570`
- `UpsellAiRun` → `schema.prisma:L7590`
- `UpsellImpression` → `schema.prisma:L7530`
- `UpsellRule` → `schema.prisma:L7450`
- `user_sessions` → `schema.prisma:L5418`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14448`
- `VenueChatMessage` → `schema.prisma:L759`
- `VenueChatSession` → `schema.prisma:L714`
- `VenueCommission` → `schema.prisma:L14098`
- `VenueCreditAssessment` → `schema.prisma:L9881`
- `VenueCryptoConfig` → `schema.prisma:L12212`
- `VenueFeature` → `schema.prisma:L4291`
- `VenueModule` → `schema.prisma:L10041`
- `VenuePaymentConfig` → `schema.prisma:L5519`
- `VenuePaymentLinkSettings` → `schema.prisma:L13452`
- `VenuePricingStructure` → `schema.prisma:L6018`
- `VenueRoleConfig` → `schema.prisma:L1383`
- `VenueRolePermission` → `schema.prisma:L1287`
- `VenueScaleSettings` → `schema.prisma:L14699`
- `VenueSettings` → `schema.prisma:L799`
- `VenueTenderType` → `schema.prisma:L4036`
- `VenueTenderTypeRevision` → `schema.prisma:L4101`
- `VenueTransaction` → `schema.prisma:L4228`
- `VenueWhatsappActivation` → `schema.prisma:L650`
- `WalletCardDesign` → `schema.prisma:L6916`
- `WalletPass` → `schema.prisma:L6825`
- `WalletPassRegistration` → `schema.prisma:L6883`
- `WebhookEvent` → `schema.prisma:L4327`
- `WebhookSubscription` → `schema.prisma:L5635`
- `WhatsappContactWindow` → `schema.prisma:L668`
- `WhatsappInboundEvent` → `schema.prisma:L688`
- `Zone` → `schema.prisma:L142`
