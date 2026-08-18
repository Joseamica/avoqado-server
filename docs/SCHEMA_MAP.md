# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **331 models / 322 enums / ~15,600 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L14828`
- `AccountMapping` → `schema.prisma:L14724`
- `ActivityLog` → `schema.prisma:L6187`
- `Aggregator` → `schema.prisma:L13176`
- `AngelPayUserAccount` → `schema.prisma:L4878`
- `AppUpdate` → `schema.prisma:L11396`
- `Area` → `schema.prisma:L2797`
- `AreaTicket` → `schema.prisma:L13619`
- `AreaTicketCheckoutSession` → `schema.prisma:L13741`
- `AreaTicketExternalIncident` → `schema.prisma:L13988`
- `AreaTicketExternalSettlement` → `schema.prisma:L13953`
- `AreaTicketFulfillment` → `schema.prisma:L13817`
- `AreaTicketInventoryReservation` → `schema.prisma:L13712`
- `AreaTicketLine` → `schema.prisma:L13680`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13773`
- `AreaTicketPrintAttempt` → `schema.prisma:L13796`
- `BankStatement` → `schema.prisma:L14598`
- `BankStatementLine` → `schema.prisma:L14619`
- `BillingTaxProfile` → `schema.prisma:L15408`
- `BulkCommandOperation` → `schema.prisma:L8710`
- `CalendarSyncOutbox` → `schema.prisma:L12570`
- `CampaignDelivery` → `schema.prisma:L11554`
- `CashCloseout` → `schema.prisma:L9075`
- `CashDeposit` → `schema.prisma:L11198`
- `CashDrawerEvent` → `schema.prisma:L13013`
- `CashDrawerSession` → `schema.prisma:L12989`
- `CashOutCommissionRate` → `schema.prisma:L15237`
- `CashOutScheduleDay` → `schema.prisma:L15260`
- `CashOutWithdrawal` → `schema.prisma:L15322`
- `CatalogBindingBatch` → `schema.prisma:L10106`
- `CatalogBindingLine` → `schema.prisma:L10142`
- `CatalogBrand` → `schema.prisma:L9559`
- `CatalogClientObservation` → `schema.prisma:L9872`
- `CatalogClientReadinessOverride` → `schema.prisma:L9891`
- `CatalogFamily` → `schema.prisma:L9609`
- `CatalogIdempotencyRecord` → `schema.prisma:L10005`
- `CatalogIdentifier` → `schema.prisma:L9740`
- `CatalogImportBatch` → `schema.prisma:L10048`
- `CatalogImportLine` → `schema.prisma:L10085`
- `CatalogItem` → `schema.prisma:L9642`
- `CatalogItemBusinessType` → `schema.prisma:L9702`
- `CatalogItemPrice` → `schema.prisma:L9790`
- `CatalogManufacturer` → `schema.prisma:L9583`
- `CatalogProductTypeMapping` → `schema.prisma:L9719`
- `CatalogPublicationBatch` → `schema.prisma:L10170`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10264`
- `CatalogPublicationLine` → `schema.prisma:L10211`
- `CatalogPublicationOutbox` → `schema.prisma:L10307`
- `CatalogValidationProfile` → `schema.prisma:L9761`
- `CatalogVenueBinding` → `schema.prisma:L9919`
- `CatalogVenueClientRequirement` → `schema.prisma:L9846`
- `CatalogVenueEventSequence` → `schema.prisma:L10290`
- `CatalogVenueOverride` → `schema.prisma:L9961`
- `CatalogVenueRollout` → `schema.prisma:L9821`
- `Cfdi` → `schema.prisma:L14501`
- `ChatbotTokenBudget` → `schema.prisma:L8358`
- `ChatConversation` → `schema.prisma:L8213`
- `ChatFeedback` → `schema.prisma:L8299`
- `ChatLearningEvent` → `schema.prisma:L8256`
- `ChatMessage` → `schema.prisma:L8236`
- `ChatTrainingData` → `schema.prisma:L8170`
- `CheckoutSession` → `schema.prisma:L5158`
- `ClassSession` → `schema.prisma:L12188`
- `CommissionCalculation` → `schema.prisma:L10977`
- `CommissionClawback` → `schema.prisma:L11150`
- `CommissionConfig` → `schema.prisma:L10750`
- `CommissionMilestone` → `schema.prisma:L10893`
- `CommissionOverride` → `schema.prisma:L10820`
- `CommissionPayout` → `schema.prisma:L11101`
- `CommissionSummary` → `schema.prisma:L11040`
- `CommissionTier` → `schema.prisma:L10857`
- `Consumer` → `schema.prisma:L6323`
- `ConsumerAuthAccount` → `schema.prisma:L6348`
- `CouponCode` → `schema.prisma:L6964`
- `CouponRedemption` → `schema.prisma:L6995`
- `CreditAssessmentHistory` → `schema.prisma:L9184`
- `CreditItemBalance` → `schema.prisma:L12779`
- `CreditOffer` → `schema.prisma:L9203`
- `CreditPack` → `schema.prisma:L12695`
- `CreditPackItem` → `schema.prisma:L12724`
- `CreditPackPurchase` → `schema.prisma:L12741`
- `CreditTransaction` → `schema.prisma:L12801`
- `Customer` → `schema.prisma:L6228`
- `CustomerDiscount` → `schema.prisma:L7015`
- `CustomerGroup` → `schema.prisma:L6382`
- `CustomerTaxProfile` → `schema.prisma:L14570`
- `DeliveryActivationRequest` → `schema.prisma:L5480`
- `DeliveryChannelLink` → `schema.prisma:L5444`
- `DeliveryOrderEvent` → `schema.prisma:L5504`
- `DeviceToken` → `schema.prisma:L7284`
- `DigitalReceipt` → `schema.prisma:L3873`
- `Discount` → `schema.prisma:L6654`
- `EcommerceMerchant` → `schema.prisma:L4970`
- `EmailTemplate` → `schema.prisma:L11493`
- `Employee` → `schema.prisma:L15085`
- `Estimate` → `schema.prisma:L13083`
- `EstimateItem` → `schema.prisma:L13111`
- `Expense` → `schema.prisma:L14872`
- `ExternalBusyBlock` → `schema.prisma:L12463`
- `Feature` → `schema.prisma:L4002`
- `FeeSchedule` → `schema.prisma:L4080`
- `FeeTier` → `schema.prisma:L4091`
- `FinancialAccount` → `schema.prisma:L13273`
- `FinancialConnection` → `schema.prisma:L13242`
- `FinancialProvider` → `schema.prisma:L13228`
- `FiscalEmisor` → `schema.prisma:L14424`
- `FiscalLossCarryforward` → `schema.prisma:L14995`
- `FixedAsset` → `schema.prisma:L15013`
- `FixedAssetDepreciation` → `schema.prisma:L15042`
- `FloorElement` → `schema.prisma:L2873`
- `FulfillmentArea` → `schema.prisma:L13484`
- `GeofenceRule` → `schema.prisma:L8795`
- `GoogleCalendarChannel` → `schema.prisma:L12440`
- `GoogleCalendarConnection` → `schema.prisma:L12392`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12493`
- `GoogleOAuthSession` → `schema.prisma:L12515`
- `HolidayCalendar` → `schema.prisma:L6111`
- `IdempotencyRequest` → `schema.prisma:L10625`
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
- `InventoryTransfer` → `schema.prisma:L13055`
- `Invitation` → `schema.prisma:L1366`
- `Invoice` → `schema.prisma:L4103`
- `InvoiceItem` → `schema.prisma:L4129`
- `ItemCategory` → `schema.prisma:L10342`
- `JournalEntry` → `schema.prisma:L14782`
- `JournalLine` → `schema.prisma:L14810`
- `KdsOrder` → `schema.prisma:L13321`
- `KdsOrderItem` → `schema.prisma:L13338`
- `LearnedPatterns` → `schema.prisma:L8280`
- `LedgerAccount` → `schema.prisma:L14674`
- `LiveDemoSession` → `schema.prisma:L771`
- `LowStockAlert` → `schema.prisma:L2466`
- `LoyaltyConfig` → `schema.prisma:L6412`
- `LoyaltyTransaction` → `schema.prisma:L6435`
- `MarketingCampaign` → `schema.prisma:L11511`
- `McpAuthCode` → `schema.prisma:L14307`
- `McpOAuthClient` → `schema.prisma:L14291`
- `McpRefreshToken` → `schema.prisma:L14325`
- `McpToolCall` → `schema.prisma:L14346`
- `MeasurementUnit` → `schema.prisma:L13161`
- `Menu` → `schema.prisma:L1552`
- `MenuCategory` → `schema.prisma:L1489`
- `MenuCategoryAssignment` → `schema.prisma:L1587`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14221`
- `MerchantAccount` → `schema.prisma:L4708`
- `MerchantFiscalConfig` → `schema.prisma:L14472`
- `MerchantRevenueShare` → `schema.prisma:L5691`
- `MerchantRoutingRule` → `schema.prisma:L4830`
- `MilestoneAchievement` → `schema.prisma:L10938`
- `Modifier` → `schema.prisma:L3489`
- `ModifierGroup` → `schema.prisma:L3453`
- `Module` → `schema.prisma:L9251`
- `MoneyAnomaly` → `schema.prisma:L5594`
- `MonthlyVenueProfit` → `schema.prisma:L6137`
- `Notification` → `schema.prisma:L7186`
- `NotificationPreference` → `schema.prisma:L7233`
- `NotificationTemplate` → `schema.prisma:L7260`
- `OAuthState` → `schema.prisma:L1417`
- `OnboardingProgress` → `schema.prisma:L1435`
- `Order` → `schema.prisma:L3104`
- `OrderAction` → `schema.prisma:L3554`
- `OrderCustomer` → `schema.prisma:L3304`
- `OrderDiscount` → `schema.prisma:L7047`
- `OrderFulfillment` → `schema.prisma:L13539`
- `OrderFulfillmentLine` → `schema.prisma:L13570`
- `OrderItem` → `schema.prisma:L3320`
- `OrderItemModifier` → `schema.prisma:L3538`
- `OrderPromotion` → `schema.prisma:L15648`
- `OrderServiceCharge` → `schema.prisma:L7131`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11312`
- `OrganizationEntitlement` → `schema.prisma:L9534`
- `OrganizationGoal` → `schema.prisma:L11270`
- `OrganizationModule` → `schema.prisma:L9311`
- `OrganizationPaymentConfig` → `schema.prisma:L5282`
- `OrganizationPayoutConfig` → `schema.prisma:L11345`
- `OrganizationPricingStructure` → `schema.prisma:L5314`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11293`
- `OtpChallenge` → `schema.prisma:L6367`
- `PartnerAPIKey` → `schema.prisma:L5112`
- `Payment` → `schema.prisma:L3587`
- `PaymentAllocation` → `schema.prisma:L3852`
- `PaymentLink` → `schema.prisma:L12847`
- `PaymentLinkAttribution` → `schema.prisma:L12955`
- `PaymentLinkItem` → `schema.prisma:L12910`
- `PaymentLinkItemModifier` → `schema.prisma:L12937`
- `PaymentProvider` → `schema.prisma:L4667`
- `PayrollLine` → `schema.prisma:L15156`
- `PayrollRun` → `schema.prisma:L15125`
- `PerformanceGoal` → `schema.prisma:L11247`
- `PermissionOverride` → `schema.prisma:L1294`
- `PermissionSet` → `schema.prisma:L1317`
- `PlatformCfdi` → `schema.prisma:L15441`
- `PlatformEmisor` → `schema.prisma:L15381`
- `PlatformSettings` → `schema.prisma:L5089`
- `PosCommand` → `schema.prisma:L7314`
- `PosConnectionStatus` → `schema.prisma:L877`
- `PosSyncIntent` → `schema.prisma:L15519`
- `PricingPolicy` → `schema.prisma:L2370`
- `Printer` → `schema.prisma:L13367`
- `PrintGateway` → `schema.prisma:L13420`
- `PrintJob` → `schema.prisma:L14120`
- `PrintStation` → `schema.prisma:L13438`
- `ProcessedStripeEvent` → `schema.prisma:L5580`
- `ProcessorReliabilityMetric` → `schema.prisma:L6065`
- `Product` → `schema.prisma:L1605`
- `ProductModifierGroup` → `schema.prisma:L3526`
- `ProductOption` → `schema.prisma:L13138`
- `ProductOptionValue` → `schema.prisma:L13149`
- `ProductStaff` → `schema.prisma:L12103`
- `PromoterBankAccount` → `schema.prisma:L15276`
- `PromoterCommissionEntry` → `schema.prisma:L15295`
- `PromoterLocationPing` → `schema.prisma:L3070`
- `Promotion` → `schema.prisma:L15570`
- `PromotionGroup` → `schema.prisma:L15609`
- `PromotionOption` → `schema.prisma:L15625`
- `ProviderCostStructure` → `schema.prisma:L5616`
- `ProviderEventLog` → `schema.prisma:L5391`
- `PurchaseOrder` → `schema.prisma:L2238`
- `PurchaseOrderItem` → `schema.prisma:L2295`
- `RateCorrectionBatch` → `schema.prisma:L5841`
- `RateCorrectionEntry` → `schema.prisma:L5883`
- `RawMaterial` → `schema.prisma:L1999`
- `RawMaterialMovement` → `schema.prisma:L2423`
- `RawMaterialPresentation` → `schema.prisma:L2072`
- `Recipe` → `schema.prisma:L2092`
- `RecipeLine` → `schema.prisma:L2116`
- `Referral` → `schema.prisma:L6502`
- `ReferralProgramConfig` → `schema.prisma:L6467`
- `ReferralRewardGrant` → `schema.prisma:L6593`
- `ReferralTierReward` → `schema.prisma:L6565`
- `ReferralTierUnlock` → `schema.prisma:L6638`
- `Reservation` → `schema.prisma:L11890`
- `ReservationGoogleEventMapping` → `schema.prisma:L12627`
- `ReservationModifier` → `schema.prisma:L12051`
- `ReservationReminderSent` → `schema.prisma:L12034`
- `ReservationSettings` → `schema.prisma:L12265`
- `ReservationWaitlistEntry` → `schema.prisma:L12233`
- `Review` → `schema.prisma:L4147`
- `SalesRetention` → `schema.prisma:L14976`
- `SaleVerification` → `schema.prisma:L3906`
- `ScaleProfile` → `schema.prisma:L13861`
- `ScheduledCommand` → `schema.prisma:L8755`
- `SerializedItem` → `schema.prisma:L10385`
- `SerializedItemCustodyEvent` → `schema.prisma:L10548`
- `ServiceCharge` → `schema.prisma:L7102`
- `SettlementConfiguration` → `schema.prisma:L5916`
- `SettlementConfirmation` → `schema.prisma:L6029`
- `SettlementIncident` → `schema.prisma:L5980`
- `SettlementSimulation` → `schema.prisma:L5951`
- `Shift` → `schema.prisma:L2911`
- `SimRegistrationRequest` → `schema.prisma:L10586`
- `SimRegistrationRequestItem` → `schema.prisma:L10608`
- `SlotHold` → `schema.prisma:L12134`
- `Staff` → `schema.prisma:L897`
- `StaffOnboardingState` → `schema.prisma:L14191`
- `StaffOrganization` → `schema.prisma:L1193`
- `StaffPasskey` → `schema.prisma:L1220`
- `StaffSchedule` → `schema.prisma:L12074`
- `StaffScheduleException` → `schema.prisma:L12086`
- `StaffVenue` → `schema.prisma:L1123`
- `StockAlertConfig` → `schema.prisma:L11229`
- `StockBatch` → `schema.prisma:L2574`
- `StockCount` → `schema.prisma:L2498`
- `StockCountItem` → `schema.prisma:L2522`
- `StripeWebhookEvent` → `schema.prisma:L5563`
- `Supplier` → `schema.prisma:L2151`
- `SupplierPricing` → `schema.prisma:L2204`
- `Table` → `schema.prisma:L2823`
- `Terminal` → `schema.prisma:L4198`
- `TerminalHealth` → `schema.prisma:L4437`
- `TerminalLog` → `schema.prisma:L4411`
- `TerminalOrder` → `schema.prisma:L4570`
- `TerminalOrderItem` → `schema.prisma:L4645`
- `TerminalPaymentRequest` → `schema.prisma:L4508`
- `TimeEntry` → `schema.prisma:L2983`
- `TimeEntryBreak` → `schema.prisma:L3052`
- `TokenPurchase` → `schema.prisma:L8429`
- `TokenUsageRecord` → `schema.prisma:L8401`
- `TpvCommandHistory` → `schema.prisma:L8661`
- `TpvCommandQueue` → `schema.prisma:L8601`
- `TpvFeedback` → `schema.prisma:L8314`
- `TpvMessage` → `schema.prisma:L11586`
- `TpvMessageDelivery` → `schema.prisma:L11638`
- `TpvMessageResponse` → `schema.prisma:L11661`
- `TrainingModule` → `schema.prisma:L11716`
- `TrainingProgress` → `schema.prisma:L11793`
- `TrainingQuizQuestion` → `schema.prisma:L11775`
- `TrainingStep` → `schema.prisma:L11755`
- `TransactionCost` → `schema.prisma:L5779`
- `UnitConversion` → `schema.prisma:L2401`
- `UpsellAcceptance` → `schema.prisma:L6923`
- `UpsellAiRun` → `schema.prisma:L6943`
- `UpsellImpression` → `schema.prisma:L6883`
- `UpsellRule` → `schema.prisma:L6803`
- `user_sessions` → `schema.prisma:L5147`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L13598`
- `VenueChatMessage` → `schema.prisma:L747`
- `VenueChatSession` → `schema.prisma:L702`
- `VenueCommission` → `schema.prisma:L13299`
- `VenueCreditAssessment` → `schema.prisma:L9123`
- `VenueCryptoConfig` → `schema.prisma:L11453`
- `VenueFeature` → `schema.prisma:L4020`
- `VenueModule` → `schema.prisma:L9283`
- `VenuePaymentConfig` → `schema.prisma:L5248`
- `VenuePaymentLinkSettings` → `schema.prisma:L12660`
- `VenuePricingStructure` → `schema.prisma:L5719`
- `VenueRoleConfig` → `schema.prisma:L1346`
- `VenueRolePermission` → `schema.prisma:L1250`
- `VenueScaleSettings` → `schema.prisma:L13849`
- `VenueSettings` → `schema.prisma:L787`
- `VenueTenderType` → `schema.prisma:L3765`
- `VenueTenderTypeRevision` → `schema.prisma:L3830`
- `VenueTransaction` → `schema.prisma:L3957`
- `VenueWhatsappActivation` → `schema.prisma:L638`
- `WebhookEvent` → `schema.prisma:L4056`
- `WebhookSubscription` → `schema.prisma:L5364`
- `WhatsappContactWindow` → `schema.prisma:L656`
- `WhatsappInboundEvent` → `schema.prisma:L676`
- `Zone` → `schema.prisma:L142`
