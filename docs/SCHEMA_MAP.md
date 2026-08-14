# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **328 models / 320 enums / ~15,400 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `PermissionSet`, `PromoterLocationPing`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                            |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                                                                              |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
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

- `AccountingPeriodLock` → `schema.prisma:L14602`
- `AccountMapping` → `schema.prisma:L14498`
- `ActivityLog` → `schema.prisma:L5987`
- `Aggregator` → `schema.prisma:L12950`
- `AngelPayUserAccount` → `schema.prisma:L4696`
- `AppUpdate` → `schema.prisma:L11170`
- `Area` → `schema.prisma:L2734`
- `AreaTicket` → `schema.prisma:L13393`
- `AreaTicketCheckoutSession` → `schema.prisma:L13515`
- `AreaTicketExternalIncident` → `schema.prisma:L13762`
- `AreaTicketExternalSettlement` → `schema.prisma:L13727`
- `AreaTicketFulfillment` → `schema.prisma:L13591`
- `AreaTicketInventoryReservation` → `schema.prisma:L13486`
- `AreaTicketLine` → `schema.prisma:L13454`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13547`
- `AreaTicketPrintAttempt` → `schema.prisma:L13570`
- `BankStatement` → `schema.prisma:L14372`
- `BankStatementLine` → `schema.prisma:L14393`
- `BillingTaxProfile` → `schema.prisma:L15182`
- `BulkCommandOperation` → `schema.prisma:L8484`
- `CalendarSyncOutbox` → `schema.prisma:L12344`
- `CampaignDelivery` → `schema.prisma:L11328`
- `CashCloseout` → `schema.prisma:L8849`
- `CashDeposit` → `schema.prisma:L10972`
- `CashDrawerEvent` → `schema.prisma:L12787`
- `CashDrawerSession` → `schema.prisma:L12763`
- `CashOutCommissionRate` → `schema.prisma:L15011`
- `CashOutScheduleDay` → `schema.prisma:L15034`
- `CashOutWithdrawal` → `schema.prisma:L15096`
- `CatalogBindingBatch` → `schema.prisma:L9880`
- `CatalogBindingLine` → `schema.prisma:L9916`
- `CatalogBrand` → `schema.prisma:L9333`
- `CatalogClientObservation` → `schema.prisma:L9646`
- `CatalogClientReadinessOverride` → `schema.prisma:L9665`
- `CatalogFamily` → `schema.prisma:L9383`
- `CatalogIdempotencyRecord` → `schema.prisma:L9779`
- `CatalogIdentifier` → `schema.prisma:L9514`
- `CatalogImportBatch` → `schema.prisma:L9822`
- `CatalogImportLine` → `schema.prisma:L9859`
- `CatalogItem` → `schema.prisma:L9416`
- `CatalogItemBusinessType` → `schema.prisma:L9476`
- `CatalogItemPrice` → `schema.prisma:L9564`
- `CatalogManufacturer` → `schema.prisma:L9357`
- `CatalogProductTypeMapping` → `schema.prisma:L9493`
- `CatalogPublicationBatch` → `schema.prisma:L9944`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10038`
- `CatalogPublicationLine` → `schema.prisma:L9985`
- `CatalogPublicationOutbox` → `schema.prisma:L10081`
- `CatalogValidationProfile` → `schema.prisma:L9535`
- `CatalogVenueBinding` → `schema.prisma:L9693`
- `CatalogVenueClientRequirement` → `schema.prisma:L9620`
- `CatalogVenueEventSequence` → `schema.prisma:L10064`
- `CatalogVenueOverride` → `schema.prisma:L9735`
- `CatalogVenueRollout` → `schema.prisma:L9595`
- `Cfdi` → `schema.prisma:L14275`
- `ChatbotTokenBudget` → `schema.prisma:L8132`
- `ChatConversation` → `schema.prisma:L7987`
- `ChatFeedback` → `schema.prisma:L8073`
- `ChatLearningEvent` → `schema.prisma:L8030`
- `ChatMessage` → `schema.prisma:L8010`
- `ChatTrainingData` → `schema.prisma:L7944`
- `CheckoutSession` → `schema.prisma:L4976`
- `ClassSession` → `schema.prisma:L11962`
- `CommissionCalculation` → `schema.prisma:L10751`
- `CommissionClawback` → `schema.prisma:L10924`
- `CommissionConfig` → `schema.prisma:L10524`
- `CommissionMilestone` → `schema.prisma:L10667`
- `CommissionOverride` → `schema.prisma:L10594`
- `CommissionPayout` → `schema.prisma:L10875`
- `CommissionSummary` → `schema.prisma:L10814`
- `CommissionTier` → `schema.prisma:L10631`
- `Consumer` → `schema.prisma:L6123`
- `ConsumerAuthAccount` → `schema.prisma:L6148`
- `CouponCode` → `schema.prisma:L6754`
- `CouponRedemption` → `schema.prisma:L6785`
- `CreditAssessmentHistory` → `schema.prisma:L8958`
- `CreditItemBalance` → `schema.prisma:L12553`
- `CreditOffer` → `schema.prisma:L8977`
- `CreditPack` → `schema.prisma:L12469`
- `CreditPackItem` → `schema.prisma:L12498`
- `CreditPackPurchase` → `schema.prisma:L12515`
- `CreditTransaction` → `schema.prisma:L12575`
- `Customer` → `schema.prisma:L6028`
- `CustomerDiscount` → `schema.prisma:L6805`
- `CustomerGroup` → `schema.prisma:L6182`
- `CustomerTaxProfile` → `schema.prisma:L14344`
- `DeliveryActivationRequest` → `schema.prisma:L5298`
- `DeliveryChannelLink` → `schema.prisma:L5262`
- `DeliveryOrderEvent` → `schema.prisma:L5322`
- `DeviceToken` → `schema.prisma:L7074`
- `DigitalReceipt` → `schema.prisma:L3697`
- `Discount` → `schema.prisma:L6454`
- `EcommerceMerchant` → `schema.prisma:L4788`
- `EmailTemplate` → `schema.prisma:L11267`
- `Employee` → `schema.prisma:L14859`
- `Estimate` → `schema.prisma:L12857`
- `EstimateItem` → `schema.prisma:L12885`
- `Expense` → `schema.prisma:L14646`
- `ExternalBusyBlock` → `schema.prisma:L12237`
- `Feature` → `schema.prisma:L3826`
- `FeeSchedule` → `schema.prisma:L3904`
- `FeeTier` → `schema.prisma:L3915`
- `FinancialAccount` → `schema.prisma:L13047`
- `FinancialConnection` → `schema.prisma:L13016`
- `FinancialProvider` → `schema.prisma:L13002`
- `FiscalEmisor` → `schema.prisma:L14198`
- `FiscalLossCarryforward` → `schema.prisma:L14769`
- `FixedAsset` → `schema.prisma:L14787`
- `FixedAssetDepreciation` → `schema.prisma:L14816`
- `FloorElement` → `schema.prisma:L2810`
- `FulfillmentArea` → `schema.prisma:L13258`
- `GeofenceRule` → `schema.prisma:L8569`
- `GoogleCalendarChannel` → `schema.prisma:L12214`
- `GoogleCalendarConnection` → `schema.prisma:L12166`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12267`
- `GoogleOAuthSession` → `schema.prisma:L12289`
- `HolidayCalendar` → `schema.prisma:L5911`
- `IdempotencyRequest` → `schema.prisma:L10399`
- `InterVenueTransfer` → `schema.prisma:L2562`
- `InterVenueTransferAllocation` → `schema.prisma:L2645`
- `InterVenueTransferItem` → `schema.prisma:L2614`
- `InterVenueTransferReceipt` → `schema.prisma:L2672`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2688`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2716`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2700`
- `Inventory` → `schema.prisma:L1761`
- `InventoryMovement` → `schema.prisma:L1788`
- `InventoryPosting` → `schema.prisma:L1870`
- `InventoryPostingLine` → `schema.prisma:L1904`
- `InventoryTransfer` → `schema.prisma:L12829`
- `Invitation` → `schema.prisma:L1309`
- `Invoice` → `schema.prisma:L3927`
- `InvoiceItem` → `schema.prisma:L3953`
- `ItemCategory` → `schema.prisma:L10116`
- `JournalEntry` → `schema.prisma:L14556`
- `JournalLine` → `schema.prisma:L14584`
- `KdsOrder` → `schema.prisma:L13095`
- `KdsOrderItem` → `schema.prisma:L13112`
- `LearnedPatterns` → `schema.prisma:L8054`
- `LedgerAccount` → `schema.prisma:L14448`
- `LiveDemoSession` → `schema.prisma:L758`
- `LowStockAlert` → `schema.prisma:L2403`
- `LoyaltyConfig` → `schema.prisma:L6212`
- `LoyaltyTransaction` → `schema.prisma:L6235`
- `MarketingCampaign` → `schema.prisma:L11285`
- `McpAuthCode` → `schema.prisma:L14081`
- `McpOAuthClient` → `schema.prisma:L14065`
- `McpRefreshToken` → `schema.prisma:L14099`
- `McpToolCall` → `schema.prisma:L14120`
- `MeasurementUnit` → `schema.prisma:L12935`
- `Menu` → `schema.prisma:L1495`
- `MenuCategory` → `schema.prisma:L1432`
- `MenuCategoryAssignment` → `schema.prisma:L1530`
- `MercadoPagoWebhookEvent` → `schema.prisma:L13995`
- `MerchantAccount` → `schema.prisma:L4526`
- `MerchantFiscalConfig` → `schema.prisma:L14246`
- `MerchantRevenueShare` → `schema.prisma:L5491`
- `MerchantRoutingRule` → `schema.prisma:L4648`
- `MilestoneAchievement` → `schema.prisma:L10712`
- `Modifier` → `schema.prisma:L3426`
- `ModifierGroup` → `schema.prisma:L3390`
- `Module` → `schema.prisma:L9025`
- `MoneyAnomaly` → `schema.prisma:L5394`
- `MonthlyVenueProfit` → `schema.prisma:L5937`
- `Notification` → `schema.prisma:L6976`
- `NotificationPreference` → `schema.prisma:L7023`
- `NotificationTemplate` → `schema.prisma:L7050`
- `OAuthState` → `schema.prisma:L1360`
- `OnboardingProgress` → `schema.prisma:L1378`
- `Order` → `schema.prisma:L3041`
- `OrderAction` → `schema.prisma:L3491`
- `OrderCustomer` → `schema.prisma:L3241`
- `OrderDiscount` → `schema.prisma:L6837`
- `OrderFulfillment` → `schema.prisma:L13313`
- `OrderFulfillmentLine` → `schema.prisma:L13344`
- `OrderItem` → `schema.prisma:L3257`
- `OrderItemModifier` → `schema.prisma:L3475`
- `OrderPromotion` → `schema.prisma:L15422`
- `OrderServiceCharge` → `schema.prisma:L6921`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11086`
- `OrganizationEntitlement` → `schema.prisma:L9308`
- `OrganizationGoal` → `schema.prisma:L11044`
- `OrganizationModule` → `schema.prisma:L9085`
- `OrganizationPaymentConfig` → `schema.prisma:L5100`
- `OrganizationPayoutConfig` → `schema.prisma:L11119`
- `OrganizationPricingStructure` → `schema.prisma:L5132`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11067`
- `OtpChallenge` → `schema.prisma:L6167`
- `PartnerAPIKey` → `schema.prisma:L4930`
- `Payment` → `schema.prisma:L3524`
- `PaymentAllocation` → `schema.prisma:L3676`
- `PaymentLink` → `schema.prisma:L12621`
- `PaymentLinkAttribution` → `schema.prisma:L12729`
- `PaymentLinkItem` → `schema.prisma:L12684`
- `PaymentLinkItemModifier` → `schema.prisma:L12711`
- `PaymentProvider` → `schema.prisma:L4485`
- `PayrollLine` → `schema.prisma:L14930`
- `PayrollRun` → `schema.prisma:L14899`
- `PerformanceGoal` → `schema.prisma:L11021`
- `PermissionSet` → `schema.prisma:L1260`
- `PlatformCfdi` → `schema.prisma:L15215`
- `PlatformEmisor` → `schema.prisma:L15155`
- `PlatformSettings` → `schema.prisma:L4907`
- `PosCommand` → `schema.prisma:L7104`
- `PosConnectionStatus` → `schema.prisma:L858`
- `PosSyncIntent` → `schema.prisma:L15293`
- `PricingPolicy` → `schema.prisma:L2307`
- `Printer` → `schema.prisma:L13141`
- `PrintGateway` → `schema.prisma:L13194`
- `PrintJob` → `schema.prisma:L13894`
- `PrintStation` → `schema.prisma:L13212`
- `ProcessedStripeEvent` → `schema.prisma:L5380`
- `ProcessorReliabilityMetric` → `schema.prisma:L5865`
- `Product` → `schema.prisma:L1548`
- `ProductModifierGroup` → `schema.prisma:L3463`
- `ProductOption` → `schema.prisma:L12912`
- `ProductOptionValue` → `schema.prisma:L12923`
- `ProductStaff` → `schema.prisma:L11877`
- `PromoterBankAccount` → `schema.prisma:L15050`
- `PromoterCommissionEntry` → `schema.prisma:L15069`
- `PromoterLocationPing` → `schema.prisma:L3007`
- `Promotion` → `schema.prisma:L15344`
- `PromotionGroup` → `schema.prisma:L15383`
- `PromotionOption` → `schema.prisma:L15399`
- `ProviderCostStructure` → `schema.prisma:L5416`
- `ProviderEventLog` → `schema.prisma:L5209`
- `PurchaseOrder` → `schema.prisma:L2175`
- `PurchaseOrderItem` → `schema.prisma:L2232`
- `RateCorrectionBatch` → `schema.prisma:L5641`
- `RateCorrectionEntry` → `schema.prisma:L5683`
- `RawMaterial` → `schema.prisma:L1936`
- `RawMaterialMovement` → `schema.prisma:L2360`
- `RawMaterialPresentation` → `schema.prisma:L2009`
- `Recipe` → `schema.prisma:L2029`
- `RecipeLine` → `schema.prisma:L2053`
- `Referral` → `schema.prisma:L6302`
- `ReferralProgramConfig` → `schema.prisma:L6267`
- `ReferralRewardGrant` → `schema.prisma:L6393`
- `ReferralTierReward` → `schema.prisma:L6365`
- `ReferralTierUnlock` → `schema.prisma:L6438`
- `Reservation` → `schema.prisma:L11664`
- `ReservationGoogleEventMapping` → `schema.prisma:L12401`
- `ReservationModifier` → `schema.prisma:L11825`
- `ReservationReminderSent` → `schema.prisma:L11808`
- `ReservationSettings` → `schema.prisma:L12039`
- `ReservationWaitlistEntry` → `schema.prisma:L12007`
- `Review` → `schema.prisma:L3971`
- `SalesRetention` → `schema.prisma:L14750`
- `SaleVerification` → `schema.prisma:L3730`
- `ScaleProfile` → `schema.prisma:L13635`
- `ScheduledCommand` → `schema.prisma:L8529`
- `SerializedItem` → `schema.prisma:L10159`
- `SerializedItemCustodyEvent` → `schema.prisma:L10322`
- `ServiceCharge` → `schema.prisma:L6892`
- `SettlementConfiguration` → `schema.prisma:L5716`
- `SettlementConfirmation` → `schema.prisma:L5829`
- `SettlementIncident` → `schema.prisma:L5780`
- `SettlementSimulation` → `schema.prisma:L5751`
- `Shift` → `schema.prisma:L2848`
- `SimRegistrationRequest` → `schema.prisma:L10360`
- `SimRegistrationRequestItem` → `schema.prisma:L10382`
- `SlotHold` → `schema.prisma:L11908`
- `Staff` → `schema.prisma:L878`
- `StaffOnboardingState` → `schema.prisma:L13965`
- `StaffOrganization` → `schema.prisma:L1174`
- `StaffPasskey` → `schema.prisma:L1201`
- `StaffSchedule` → `schema.prisma:L11848`
- `StaffScheduleException` → `schema.prisma:L11860`
- `StaffVenue` → `schema.prisma:L1104`
- `StockAlertConfig` → `schema.prisma:L11003`
- `StockBatch` → `schema.prisma:L2511`
- `StockCount` → `schema.prisma:L2435`
- `StockCountItem` → `schema.prisma:L2459`
- `StripeWebhookEvent` → `schema.prisma:L5363`
- `Supplier` → `schema.prisma:L2088`
- `SupplierPricing` → `schema.prisma:L2141`
- `Table` → `schema.prisma:L2760`
- `Terminal` → `schema.prisma:L4022`
- `TerminalHealth` → `schema.prisma:L4261`
- `TerminalLog` → `schema.prisma:L4235`
- `TerminalOrder` → `schema.prisma:L4388`
- `TerminalOrderItem` → `schema.prisma:L4463`
- `TerminalPaymentRequest` → `schema.prisma:L4332`
- `TimeEntry` → `schema.prisma:L2920`
- `TimeEntryBreak` → `schema.prisma:L2989`
- `TokenPurchase` → `schema.prisma:L8203`
- `TokenUsageRecord` → `schema.prisma:L8175`
- `TpvCommandHistory` → `schema.prisma:L8435`
- `TpvCommandQueue` → `schema.prisma:L8375`
- `TpvFeedback` → `schema.prisma:L8088`
- `TpvMessage` → `schema.prisma:L11360`
- `TpvMessageDelivery` → `schema.prisma:L11412`
- `TpvMessageResponse` → `schema.prisma:L11435`
- `TrainingModule` → `schema.prisma:L11490`
- `TrainingProgress` → `schema.prisma:L11567`
- `TrainingQuizQuestion` → `schema.prisma:L11549`
- `TrainingStep` → `schema.prisma:L11529`
- `TransactionCost` → `schema.prisma:L5579`
- `UnitConversion` → `schema.prisma:L2338`
- `UpsellAcceptance` → `schema.prisma:L6713`
- `UpsellAiRun` → `schema.prisma:L6733`
- `UpsellImpression` → `schema.prisma:L6673`
- `UpsellRule` → `schema.prisma:L6603`
- `user_sessions` → `schema.prisma:L4965`
- `Venue` → `schema.prisma:L147`
- `VenueAreaTicketSettings` → `schema.prisma:L13372`
- `VenueChatMessage` → `schema.prisma:L734`
- `VenueChatSession` → `schema.prisma:L689`
- `VenueCommission` → `schema.prisma:L13073`
- `VenueCreditAssessment` → `schema.prisma:L8897`
- `VenueCryptoConfig` → `schema.prisma:L11227`
- `VenueFeature` → `schema.prisma:L3844`
- `VenueModule` → `schema.prisma:L9057`
- `VenuePaymentConfig` → `schema.prisma:L5066`
- `VenuePaymentLinkSettings` → `schema.prisma:L12434`
- `VenuePricingStructure` → `schema.prisma:L5519`
- `VenueRoleConfig` → `schema.prisma:L1289`
- `VenueRolePermission` → `schema.prisma:L1231`
- `VenueScaleSettings` → `schema.prisma:L13623`
- `VenueSettings` → `schema.prisma:L774`
- `VenueTransaction` → `schema.prisma:L3781`
- `VenueWhatsappActivation` → `schema.prisma:L625`
- `WebhookEvent` → `schema.prisma:L3880`
- `WebhookSubscription` → `schema.prisma:L5182`
- `WhatsappContactWindow` → `schema.prisma:L643`
- `WhatsappInboundEvent` → `schema.prisma:L663`
- `Zone` → `schema.prisma:L130`
