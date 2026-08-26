# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **339 models / 331 enums / ~16,200 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                          |
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

- `AccountingPeriodLock` → `schema.prisma:L15272`
- `AccountMapping` → `schema.prisma:L15168`
- `ActivityLog` → `schema.prisma:L6349`
- `Aggregator` → `schema.prisma:L13569`
- `AngelPayUserAccount` → `schema.prisma:L5012`
- `AppUpdate` → `schema.prisma:L11749`
- `Area` → `schema.prisma:L2918`
- `AreaTicket` → `schema.prisma:L14063`
- `AreaTicketCheckoutSession` → `schema.prisma:L14185`
- `AreaTicketExternalIncident` → `schema.prisma:L14432`
- `AreaTicketExternalSettlement` → `schema.prisma:L14397`
- `AreaTicketFulfillment` → `schema.prisma:L14261`
- `AreaTicketInventoryReservation` → `schema.prisma:L14156`
- `AreaTicketLine` → `schema.prisma:L14124`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14217`
- `AreaTicketPrintAttempt` → `schema.prisma:L14240`
- `BankStatement` → `schema.prisma:L15042`
- `BankStatementLine` → `schema.prisma:L15063`
- `BillingTaxProfile` → `schema.prisma:L15852`
- `BulkCommandOperation` → `schema.prisma:L9047`
- `CalendarSyncOutbox` → `schema.prisma:L12956`
- `CampaignDelivery` → `schema.prisma:L11907`
- `CashCloseout` → `schema.prisma:L9427`
- `CashDeposit` → `schema.prisma:L11551`
- `CashDrawerEvent` → `schema.prisma:L13406`
- `CashDrawerSession` → `schema.prisma:L13382`
- `CashOutCommissionRate` → `schema.prisma:L15681`
- `CashOutScheduleDay` → `schema.prisma:L15704`
- `CashOutWithdrawal` → `schema.prisma:L15766`
- `CatalogBindingBatch` → `schema.prisma:L10458`
- `CatalogBindingLine` → `schema.prisma:L10494`
- `CatalogBrand` → `schema.prisma:L9911`
- `CatalogClientObservation` → `schema.prisma:L10224`
- `CatalogClientReadinessOverride` → `schema.prisma:L10243`
- `CatalogFamily` → `schema.prisma:L9961`
- `CatalogIdempotencyRecord` → `schema.prisma:L10357`
- `CatalogIdentifier` → `schema.prisma:L10092`
- `CatalogImportBatch` → `schema.prisma:L10400`
- `CatalogImportLine` → `schema.prisma:L10437`
- `CatalogItem` → `schema.prisma:L9994`
- `CatalogItemBusinessType` → `schema.prisma:L10054`
- `CatalogItemPrice` → `schema.prisma:L10142`
- `CatalogManufacturer` → `schema.prisma:L9935`
- `CatalogProductTypeMapping` → `schema.prisma:L10071`
- `CatalogPublicationBatch` → `schema.prisma:L10522`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10616`
- `CatalogPublicationLine` → `schema.prisma:L10563`
- `CatalogPublicationOutbox` → `schema.prisma:L10659`
- `CatalogValidationProfile` → `schema.prisma:L10113`
- `CatalogVenueBinding` → `schema.prisma:L10271`
- `CatalogVenueClientRequirement` → `schema.prisma:L10198`
- `CatalogVenueEventSequence` → `schema.prisma:L10642`
- `CatalogVenueOverride` → `schema.prisma:L10313`
- `CatalogVenueRollout` → `schema.prisma:L10173`
- `Cfdi` → `schema.prisma:L14945`
- `ChatbotTokenBudget` → `schema.prisma:L8695`
- `ChatConversation` → `schema.prisma:L8550`
- `ChatFeedback` → `schema.prisma:L8636`
- `ChatLearningEvent` → `schema.prisma:L8593`
- `ChatMessage` → `schema.prisma:L8573`
- `ChatTrainingData` → `schema.prisma:L8507`
- `CheckoutSession` → `schema.prisma:L5292`
- `ClassSession` → `schema.prisma:L12560`
- `CommissionCalculation` → `schema.prisma:L11330`
- `CommissionClawback` → `schema.prisma:L11503`
- `CommissionConfig` → `schema.prisma:L11103`
- `CommissionMilestone` → `schema.prisma:L11246`
- `CommissionOverride` → `schema.prisma:L11173`
- `CommissionPayout` → `schema.prisma:L11454`
- `CommissionSummary` → `schema.prisma:L11393`
- `CommissionTier` → `schema.prisma:L11210`
- `Consumer` → `schema.prisma:L6509`
- `ConsumerAuthAccount` → `schema.prisma:L6534`
- `CouponCode` → `schema.prisma:L7205`
- `CouponRedemption` → `schema.prisma:L7236`
- `CreditAssessmentHistory` → `schema.prisma:L9536`
- `CreditItemBalance` → `schema.prisma:L13172`
- `CreditOffer` → `schema.prisma:L9555`
- `CreditPack` → `schema.prisma:L13081`
- `CreditPackItem` → `schema.prisma:L13110`
- `CreditPackPurchase` → `schema.prisma:L13127`
- `CreditTransaction` → `schema.prisma:L13194`
- `Customer` → `schema.prisma:L6390`
- `CustomerApprovalDelivery` → `schema.prisma:L8212`
- `CustomerApprovalOutbox` → `schema.prisma:L8187`
- `CustomerDiscount` → `schema.prisma:L7256`
- `CustomerGroup` → `schema.prisma:L6573`
- `CustomerTaxProfile` → `schema.prisma:L15014`
- `DeliveryActivationRequest` → `schema.prisma:L5633`
- `DeliveryChannelLink` → `schema.prisma:L5578`
- `DeliveryOrderEvent` → `schema.prisma:L5657`
- `DeviceToken` → `schema.prisma:L7525`
- `DigitalReceipt` → `schema.prisma:L4007`
- `Discount` → `schema.prisma:L6895`
- `EcommerceMerchant` → `schema.prisma:L5104`
- `EmailTemplate` → `schema.prisma:L11846`
- `Employee` → `schema.prisma:L15529`
- `Estimate` → `schema.prisma:L13476`
- `EstimateItem` → `schema.prisma:L13504`
- `Expense` → `schema.prisma:L15316`
- `ExternalBusyBlock` → `schema.prisma:L12849`
- `Feature` → `schema.prisma:L4136`
- `FeeSchedule` → `schema.prisma:L4214`
- `FeeTier` → `schema.prisma:L4225`
- `FinancialAccount` → `schema.prisma:L13666`
- `FinancialConnection` → `schema.prisma:L13635`
- `FinancialProvider` → `schema.prisma:L13621`
- `FiscalEmisor` → `schema.prisma:L14868`
- `FiscalLossCarryforward` → `schema.prisma:L15439`
- `FixedAsset` → `schema.prisma:L15457`
- `FixedAssetDepreciation` → `schema.prisma:L15486`
- `FloorElement` → `schema.prisma:L2994`
- `FulfillmentArea` → `schema.prisma:L13928`
- `GeofenceRule` → `schema.prisma:L9132`
- `GoogleCalendarChannel` → `schema.prisma:L12826`
- `GoogleCalendarConnection` → `schema.prisma:L12778`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12879`
- `GoogleOAuthSession` → `schema.prisma:L12901`
- `HolidayCalendar` → `schema.prisma:L6273`
- `IdempotencyRequest` → `schema.prisma:L10978`
- `InterVenueTransfer` → `schema.prisma:L2746`
- `InterVenueTransferAllocation` → `schema.prisma:L2829`
- `InterVenueTransferItem` → `schema.prisma:L2798`
- `InterVenueTransferReceipt` → `schema.prisma:L2856`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2872`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2900`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2884`
- `Inventory` → `schema.prisma:L1840`
- `InventoryMovement` → `schema.prisma:L1867`
- `InventoryPosting` → `schema.prisma:L1949`
- `InventoryPostingLine` → `schema.prisma:L1989`
- `InventoryTransfer` → `schema.prisma:L13448`
- `Invitation` → `schema.prisma:L1380`
- `Invoice` → `schema.prisma:L4237`
- `InvoiceItem` → `schema.prisma:L4263`
- `ItemCategory` → `schema.prisma:L10694`
- `JournalEntry` → `schema.prisma:L15226`
- `JournalLine` → `schema.prisma:L15254`
- `KdsOrder` → `schema.prisma:L13714`
- `KdsOrderItem` → `schema.prisma:L13755`
- `KioskCheckInAttempt` → `schema.prisma:L16175`
- `KioskCheckInChallenge` → `schema.prisma:L16129`
- `KioskOutreachOutbox` → `schema.prisma:L16196`
- `LearnedPatterns` → `schema.prisma:L8617`
- `LedgerAccount` → `schema.prisma:L15118`
- `LiveDemoSession` → `schema.prisma:L778`
- `LowStockAlert` → `schema.prisma:L2587`
- `LoyaltyConfig` → `schema.prisma:L6603`
- `LoyaltyTransaction` → `schema.prisma:L6626`
- `MarketingCampaign` → `schema.prisma:L11864`
- `McpAuthCode` → `schema.prisma:L14751`
- `McpOAuthClient` → `schema.prisma:L14735`
- `McpRefreshToken` → `schema.prisma:L14769`
- `McpToolCall` → `schema.prisma:L14790`
- `MeasurementUnit` → `schema.prisma:L13554`
- `Menu` → `schema.prisma:L1566`
- `MenuCategory` → `schema.prisma:L1503`
- `MenuCategoryAssignment` → `schema.prisma:L1601`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14665`
- `MerchantAccount` → `schema.prisma:L4842`
- `MerchantFiscalConfig` → `schema.prisma:L14916`
- `MerchantRevenueShare` → `schema.prisma:L5853`
- `MerchantRoutingRule` → `schema.prisma:L4964`
- `MilestoneAchievement` → `schema.prisma:L11291`
- `Modifier` → `schema.prisma:L3622`
- `ModifierGroup` → `schema.prisma:L3586`
- `Module` → `schema.prisma:L9603`
- `MoneyAnomaly` → `schema.prisma:L5756`
- `MonthlyVenueProfit` → `schema.prisma:L6299`
- `Notification` → `schema.prisma:L7427`
- `NotificationPreference` → `schema.prisma:L7474`
- `NotificationTemplate` → `schema.prisma:L7501`
- `OAuthState` → `schema.prisma:L1431`
- `OnboardingProgress` → `schema.prisma:L1449`
- `Order` → `schema.prisma:L3225`
- `OrderAction` → `schema.prisma:L3687`
- `OrderCustomer` → `schema.prisma:L3437`
- `OrderDiscount` → `schema.prisma:L7288`
- `OrderFulfillment` → `schema.prisma:L13983`
- `OrderFulfillmentLine` → `schema.prisma:L14014`
- `OrderItem` → `schema.prisma:L3453`
- `OrderItemModifier` → `schema.prisma:L3671`
- `OrderPromotion` → `schema.prisma:L16092`
- `OrderServiceCharge` → `schema.prisma:L7372`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11665`
- `OrganizationEntitlement` → `schema.prisma:L9886`
- `OrganizationGoal` → `schema.prisma:L11623`
- `OrganizationModule` → `schema.prisma:L9663`
- `OrganizationPaymentConfig` → `schema.prisma:L5416`
- `OrganizationPayoutConfig` → `schema.prisma:L11698`
- `OrganizationPricingStructure` → `schema.prisma:L5448`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11646`
- `OtpChallenge` → `schema.prisma:L6553`
- `PartnerAPIKey` → `schema.prisma:L5246`
- `Payment` → `schema.prisma:L3720`
- `PaymentAllocation` → `schema.prisma:L3986`
- `PaymentLink` → `schema.prisma:L13240`
- `PaymentLinkAttribution` → `schema.prisma:L13348`
- `PaymentLinkItem` → `schema.prisma:L13303`
- `PaymentLinkItemModifier` → `schema.prisma:L13330`
- `PaymentProvider` → `schema.prisma:L4801`
- `PayrollLine` → `schema.prisma:L15600`
- `PayrollRun` → `schema.prisma:L15569`
- `PerformanceGoal` → `schema.prisma:L11600`
- `PermissionOverride` → `schema.prisma:L1308`
- `PermissionSet` → `schema.prisma:L1331`
- `PlatformCfdi` → `schema.prisma:L15885`
- `PlatformEmisor` → `schema.prisma:L15825`
- `PlatformSettings` → `schema.prisma:L5223`
- `PosCommand` → `schema.prisma:L7555`
- `PosConnectionStatus` → `schema.prisma:L884`
- `PosSyncIntent` → `schema.prisma:L15963`
- `PricingPolicy` → `schema.prisma:L2491`
- `Printer` → `schema.prisma:L13797`
- `PrintGateway` → `schema.prisma:L13850`
- `PrintJob` → `schema.prisma:L14564`
- `PrintStation` → `schema.prisma:L13868`
- `ProcessedStripeEvent` → `schema.prisma:L5742`
- `ProcessorReliabilityMetric` → `schema.prisma:L6227`
- `Product` → `schema.prisma:L1619`
- `ProductModifierGroup` → `schema.prisma:L3659`
- `ProductOption` → `schema.prisma:L13531`
- `ProductOptionValue` → `schema.prisma:L13542`
- `ProductStaff` → `schema.prisma:L12475`
- `PromoterBankAccount` → `schema.prisma:L15720`
- `PromoterCommissionEntry` → `schema.prisma:L15739`
- `PromoterLocationPing` → `schema.prisma:L3191`
- `Promotion` → `schema.prisma:L16014`
- `PromotionGroup` → `schema.prisma:L16053`
- `PromotionOption` → `schema.prisma:L16069`
- `ProviderCostStructure` → `schema.prisma:L5778`
- `ProviderEventLog` → `schema.prisma:L5525`
- `PurchaseOrder` → `schema.prisma:L2261`
- `PurchaseOrderInvoice` → `schema.prisma:L2406`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2461`
- `PurchaseOrderItem` → `schema.prisma:L2319`
- `RateCorrectionBatch` → `schema.prisma:L6003`
- `RateCorrectionEntry` → `schema.prisma:L6045`
- `RawMaterial` → `schema.prisma:L2021`
- `RawMaterialMovement` → `schema.prisma:L2544`
- `RawMaterialPresentation` → `schema.prisma:L2094`
- `Recipe` → `schema.prisma:L2114`
- `RecipeLine` → `schema.prisma:L2138`
- `Referral` → `schema.prisma:L6743`
- `ReferralProgramConfig` → `schema.prisma:L6708`
- `ReferralRewardGrant` → `schema.prisma:L6834`
- `ReferralTierReward` → `schema.prisma:L6806`
- `ReferralTierUnlock` → `schema.prisma:L6879`
- `Reservation` → `schema.prisma:L12243`
- `ReservationGoogleEventMapping` → `schema.prisma:L13013`
- `ReservationModifier` → `schema.prisma:L12423`
- `ReservationReminderSent` → `schema.prisma:L12406`
- `ReservationSettings` → `schema.prisma:L12637`
- `ReservationWaitlistEntry` → `schema.prisma:L12605`
- `Review` → `schema.prisma:L4281`
- `SalesRetention` → `schema.prisma:L15420`
- `SaleVerification` → `schema.prisma:L4040`
- `ScaleProfile` → `schema.prisma:L14305`
- `ScheduledCommand` → `schema.prisma:L9092`
- `SerializedItem` → `schema.prisma:L10737`
- `SerializedItemCustodyEvent` → `schema.prisma:L10901`
- `ServiceCharge` → `schema.prisma:L7343`
- `SettlementConfiguration` → `schema.prisma:L6078`
- `SettlementConfirmation` → `schema.prisma:L6191`
- `SettlementIncident` → `schema.prisma:L6142`
- `SettlementSimulation` → `schema.prisma:L6113`
- `Shift` → `schema.prisma:L3032`
- `SimRegistrationRequest` → `schema.prisma:L10939`
- `SimRegistrationRequestItem` → `schema.prisma:L10961`
- `SlotHold` → `schema.prisma:L12506`
- `Staff` → `schema.prisma:L904`
- `StaffOnboardingState` → `schema.prisma:L14635`
- `StaffOrganization` → `schema.prisma:L1207`
- `StaffPasskey` → `schema.prisma:L1234`
- `StaffSchedule` → `schema.prisma:L12446`
- `StaffScheduleException` → `schema.prisma:L12458`
- `StaffVenue` → `schema.prisma:L1137`
- `StockAlertConfig` → `schema.prisma:L11582`
- `StockBatch` → `schema.prisma:L2695`
- `StockCount` → `schema.prisma:L2619`
- `StockCountItem` → `schema.prisma:L2643`
- `StripeWebhookEvent` → `schema.prisma:L5725`
- `Supplier` → `schema.prisma:L2173`
- `SupplierPricing` → `schema.prisma:L2227`
- `Table` → `schema.prisma:L2944`
- `Terminal` → `schema.prisma:L4332`
- `TerminalHealth` → `schema.prisma:L4571`
- `TerminalLog` → `schema.prisma:L4545`
- `TerminalOrder` → `schema.prisma:L4704`
- `TerminalOrderItem` → `schema.prisma:L4779`
- `TerminalPaymentRequest` → `schema.prisma:L4642`
- `TimeEntry` → `schema.prisma:L3104`
- `TimeEntryBreak` → `schema.prisma:L3173`
- `TokenPurchase` → `schema.prisma:L8766`
- `TokenUsageRecord` → `schema.prisma:L8738`
- `TpvCommandHistory` → `schema.prisma:L8998`
- `TpvCommandQueue` → `schema.prisma:L8938`
- `TpvFeedback` → `schema.prisma:L8651`
- `TpvMessage` → `schema.prisma:L11939`
- `TpvMessageDelivery` → `schema.prisma:L11991`
- `TpvMessageResponse` → `schema.prisma:L12014`
- `TrainingModule` → `schema.prisma:L12069`
- `TrainingProgress` → `schema.prisma:L12146`
- `TrainingQuizQuestion` → `schema.prisma:L12128`
- `TrainingStep` → `schema.prisma:L12108`
- `TransactionCost` → `schema.prisma:L5941`
- `UnitConversion` → `schema.prisma:L2522`
- `UpsellAcceptance` → `schema.prisma:L7164`
- `UpsellAiRun` → `schema.prisma:L7184`
- `UpsellImpression` → `schema.prisma:L7124`
- `UpsellRule` → `schema.prisma:L7044`
- `user_sessions` → `schema.prisma:L5281`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14042`
- `VenueChatMessage` → `schema.prisma:L754`
- `VenueChatSession` → `schema.prisma:L709`
- `VenueCommission` → `schema.prisma:L13692`
- `VenueCreditAssessment` → `schema.prisma:L9475`
- `VenueCryptoConfig` → `schema.prisma:L11806`
- `VenueFeature` → `schema.prisma:L4154`
- `VenueModule` → `schema.prisma:L9635`
- `VenuePaymentConfig` → `schema.prisma:L5382`
- `VenuePaymentLinkSettings` → `schema.prisma:L13046`
- `VenuePricingStructure` → `schema.prisma:L5881`
- `VenueRoleConfig` → `schema.prisma:L1360`
- `VenueRolePermission` → `schema.prisma:L1264`
- `VenueScaleSettings` → `schema.prisma:L14293`
- `VenueSettings` → `schema.prisma:L794`
- `VenueTenderType` → `schema.prisma:L3899`
- `VenueTenderTypeRevision` → `schema.prisma:L3964`
- `VenueTransaction` → `schema.prisma:L4091`
- `VenueWhatsappActivation` → `schema.prisma:L645`
- `WalletPass` → `schema.prisma:L6666`
- `WebhookEvent` → `schema.prisma:L4190`
- `WebhookSubscription` → `schema.prisma:L5498`
- `WhatsappContactWindow` → `schema.prisma:L663`
- `WhatsappInboundEvent` → `schema.prisma:L683`
- `Zone` → `schema.prisma:L142`
