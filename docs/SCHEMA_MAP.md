# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **331 models / 322 enums / ~15,700 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L14864`
- `AccountMapping` → `schema.prisma:L14760`
- `ActivityLog` → `schema.prisma:L6223`
- `Aggregator` → `schema.prisma:L13212`
- `AngelPayUserAccount` → `schema.prisma:L4886`
- `AppUpdate` → `schema.prisma:L11432`
- `Area` → `schema.prisma:L2797`
- `AreaTicket` → `schema.prisma:L13655`
- `AreaTicketCheckoutSession` → `schema.prisma:L13777`
- `AreaTicketExternalIncident` → `schema.prisma:L14024`
- `AreaTicketExternalSettlement` → `schema.prisma:L13989`
- `AreaTicketFulfillment` → `schema.prisma:L13853`
- `AreaTicketInventoryReservation` → `schema.prisma:L13748`
- `AreaTicketLine` → `schema.prisma:L13716`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13809`
- `AreaTicketPrintAttempt` → `schema.prisma:L13832`
- `BankStatement` → `schema.prisma:L14634`
- `BankStatementLine` → `schema.prisma:L14655`
- `BillingTaxProfile` → `schema.prisma:L15444`
- `BulkCommandOperation` → `schema.prisma:L8746`
- `CalendarSyncOutbox` → `schema.prisma:L12606`
- `CampaignDelivery` → `schema.prisma:L11590`
- `CashCloseout` → `schema.prisma:L9111`
- `CashDeposit` → `schema.prisma:L11234`
- `CashDrawerEvent` → `schema.prisma:L13049`
- `CashDrawerSession` → `schema.prisma:L13025`
- `CashOutCommissionRate` → `schema.prisma:L15273`
- `CashOutScheduleDay` → `schema.prisma:L15296`
- `CashOutWithdrawal` → `schema.prisma:L15358`
- `CatalogBindingBatch` → `schema.prisma:L10142`
- `CatalogBindingLine` → `schema.prisma:L10178`
- `CatalogBrand` → `schema.prisma:L9595`
- `CatalogClientObservation` → `schema.prisma:L9908`
- `CatalogClientReadinessOverride` → `schema.prisma:L9927`
- `CatalogFamily` → `schema.prisma:L9645`
- `CatalogIdempotencyRecord` → `schema.prisma:L10041`
- `CatalogIdentifier` → `schema.prisma:L9776`
- `CatalogImportBatch` → `schema.prisma:L10084`
- `CatalogImportLine` → `schema.prisma:L10121`
- `CatalogItem` → `schema.prisma:L9678`
- `CatalogItemBusinessType` → `schema.prisma:L9738`
- `CatalogItemPrice` → `schema.prisma:L9826`
- `CatalogManufacturer` → `schema.prisma:L9619`
- `CatalogProductTypeMapping` → `schema.prisma:L9755`
- `CatalogPublicationBatch` → `schema.prisma:L10206`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10300`
- `CatalogPublicationLine` → `schema.prisma:L10247`
- `CatalogPublicationOutbox` → `schema.prisma:L10343`
- `CatalogValidationProfile` → `schema.prisma:L9797`
- `CatalogVenueBinding` → `schema.prisma:L9955`
- `CatalogVenueClientRequirement` → `schema.prisma:L9882`
- `CatalogVenueEventSequence` → `schema.prisma:L10326`
- `CatalogVenueOverride` → `schema.prisma:L9997`
- `CatalogVenueRollout` → `schema.prisma:L9857`
- `Cfdi` → `schema.prisma:L14537`
- `ChatbotTokenBudget` → `schema.prisma:L8394`
- `ChatConversation` → `schema.prisma:L8249`
- `ChatFeedback` → `schema.prisma:L8335`
- `ChatLearningEvent` → `schema.prisma:L8292`
- `ChatMessage` → `schema.prisma:L8272`
- `ChatTrainingData` → `schema.prisma:L8206`
- `CheckoutSession` → `schema.prisma:L5166`
- `ClassSession` → `schema.prisma:L12224`
- `CommissionCalculation` → `schema.prisma:L11013`
- `CommissionClawback` → `schema.prisma:L11186`
- `CommissionConfig` → `schema.prisma:L10786`
- `CommissionMilestone` → `schema.prisma:L10929`
- `CommissionOverride` → `schema.prisma:L10856`
- `CommissionPayout` → `schema.prisma:L11137`
- `CommissionSummary` → `schema.prisma:L11076`
- `CommissionTier` → `schema.prisma:L10893`
- `Consumer` → `schema.prisma:L6359`
- `ConsumerAuthAccount` → `schema.prisma:L6384`
- `CouponCode` → `schema.prisma:L7000`
- `CouponRedemption` → `schema.prisma:L7031`
- `CreditAssessmentHistory` → `schema.prisma:L9220`
- `CreditItemBalance` → `schema.prisma:L12815`
- `CreditOffer` → `schema.prisma:L9239`
- `CreditPack` → `schema.prisma:L12731`
- `CreditPackItem` → `schema.prisma:L12760`
- `CreditPackPurchase` → `schema.prisma:L12777`
- `CreditTransaction` → `schema.prisma:L12837`
- `Customer` → `schema.prisma:L6264`
- `CustomerDiscount` → `schema.prisma:L7051`
- `CustomerGroup` → `schema.prisma:L6418`
- `CustomerTaxProfile` → `schema.prisma:L14606`
- `DeliveryActivationRequest` → `schema.prisma:L5507`
- `DeliveryChannelLink` → `schema.prisma:L5452`
- `DeliveryOrderEvent` → `schema.prisma:L5531`
- `DeviceToken` → `schema.prisma:L7320`
- `DigitalReceipt` → `schema.prisma:L3881`
- `Discount` → `schema.prisma:L6690`
- `EcommerceMerchant` → `schema.prisma:L4978`
- `EmailTemplate` → `schema.prisma:L11529`
- `Employee` → `schema.prisma:L15121`
- `Estimate` → `schema.prisma:L13119`
- `EstimateItem` → `schema.prisma:L13147`
- `Expense` → `schema.prisma:L14908`
- `ExternalBusyBlock` → `schema.prisma:L12499`
- `Feature` → `schema.prisma:L4010`
- `FeeSchedule` → `schema.prisma:L4088`
- `FeeTier` → `schema.prisma:L4099`
- `FinancialAccount` → `schema.prisma:L13309`
- `FinancialConnection` → `schema.prisma:L13278`
- `FinancialProvider` → `schema.prisma:L13264`
- `FiscalEmisor` → `schema.prisma:L14460`
- `FiscalLossCarryforward` → `schema.prisma:L15031`
- `FixedAsset` → `schema.prisma:L15049`
- `FixedAssetDepreciation` → `schema.prisma:L15078`
- `FloorElement` → `schema.prisma:L2873`
- `FulfillmentArea` → `schema.prisma:L13520`
- `GeofenceRule` → `schema.prisma:L8831`
- `GoogleCalendarChannel` → `schema.prisma:L12476`
- `GoogleCalendarConnection` → `schema.prisma:L12428`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12529`
- `GoogleOAuthSession` → `schema.prisma:L12551`
- `HolidayCalendar` → `schema.prisma:L6147`
- `IdempotencyRequest` → `schema.prisma:L10661`
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
- `InventoryTransfer` → `schema.prisma:L13091`
- `Invitation` → `schema.prisma:L1366`
- `Invoice` → `schema.prisma:L4111`
- `InvoiceItem` → `schema.prisma:L4137`
- `ItemCategory` → `schema.prisma:L10378`
- `JournalEntry` → `schema.prisma:L14818`
- `JournalLine` → `schema.prisma:L14846`
- `KdsOrder` → `schema.prisma:L13357`
- `KdsOrderItem` → `schema.prisma:L13374`
- `LearnedPatterns` → `schema.prisma:L8316`
- `LedgerAccount` → `schema.prisma:L14710`
- `LiveDemoSession` → `schema.prisma:L771`
- `LowStockAlert` → `schema.prisma:L2466`
- `LoyaltyConfig` → `schema.prisma:L6448`
- `LoyaltyTransaction` → `schema.prisma:L6471`
- `MarketingCampaign` → `schema.prisma:L11547`
- `McpAuthCode` → `schema.prisma:L14343`
- `McpOAuthClient` → `schema.prisma:L14327`
- `McpRefreshToken` → `schema.prisma:L14361`
- `McpToolCall` → `schema.prisma:L14382`
- `MeasurementUnit` → `schema.prisma:L13197`
- `Menu` → `schema.prisma:L1552`
- `MenuCategory` → `schema.prisma:L1489`
- `MenuCategoryAssignment` → `schema.prisma:L1587`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14257`
- `MerchantAccount` → `schema.prisma:L4716`
- `MerchantFiscalConfig` → `schema.prisma:L14508`
- `MerchantRevenueShare` → `schema.prisma:L5727`
- `MerchantRoutingRule` → `schema.prisma:L4838`
- `MilestoneAchievement` → `schema.prisma:L10974`
- `Modifier` → `schema.prisma:L3497`
- `ModifierGroup` → `schema.prisma:L3461`
- `Module` → `schema.prisma:L9287`
- `MoneyAnomaly` → `schema.prisma:L5630`
- `MonthlyVenueProfit` → `schema.prisma:L6173`
- `Notification` → `schema.prisma:L7222`
- `NotificationPreference` → `schema.prisma:L7269`
- `NotificationTemplate` → `schema.prisma:L7296`
- `OAuthState` → `schema.prisma:L1417`
- `OnboardingProgress` → `schema.prisma:L1435`
- `Order` → `schema.prisma:L3104`
- `OrderAction` → `schema.prisma:L3562`
- `OrderCustomer` → `schema.prisma:L3312`
- `OrderDiscount` → `schema.prisma:L7083`
- `OrderFulfillment` → `schema.prisma:L13575`
- `OrderFulfillmentLine` → `schema.prisma:L13606`
- `OrderItem` → `schema.prisma:L3328`
- `OrderItemModifier` → `schema.prisma:L3546`
- `OrderPromotion` → `schema.prisma:L15684`
- `OrderServiceCharge` → `schema.prisma:L7167`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11348`
- `OrganizationEntitlement` → `schema.prisma:L9570`
- `OrganizationGoal` → `schema.prisma:L11306`
- `OrganizationModule` → `schema.prisma:L9347`
- `OrganizationPaymentConfig` → `schema.prisma:L5290`
- `OrganizationPayoutConfig` → `schema.prisma:L11381`
- `OrganizationPricingStructure` → `schema.prisma:L5322`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11329`
- `OtpChallenge` → `schema.prisma:L6403`
- `PartnerAPIKey` → `schema.prisma:L5120`
- `Payment` → `schema.prisma:L3595`
- `PaymentAllocation` → `schema.prisma:L3860`
- `PaymentLink` → `schema.prisma:L12883`
- `PaymentLinkAttribution` → `schema.prisma:L12991`
- `PaymentLinkItem` → `schema.prisma:L12946`
- `PaymentLinkItemModifier` → `schema.prisma:L12973`
- `PaymentProvider` → `schema.prisma:L4675`
- `PayrollLine` → `schema.prisma:L15192`
- `PayrollRun` → `schema.prisma:L15161`
- `PerformanceGoal` → `schema.prisma:L11283`
- `PermissionOverride` → `schema.prisma:L1294`
- `PermissionSet` → `schema.prisma:L1317`
- `PlatformCfdi` → `schema.prisma:L15477`
- `PlatformEmisor` → `schema.prisma:L15417`
- `PlatformSettings` → `schema.prisma:L5097`
- `PosCommand` → `schema.prisma:L7350`
- `PosConnectionStatus` → `schema.prisma:L877`
- `PosSyncIntent` → `schema.prisma:L15555`
- `PricingPolicy` → `schema.prisma:L2370`
- `Printer` → `schema.prisma:L13403`
- `PrintGateway` → `schema.prisma:L13456`
- `PrintJob` → `schema.prisma:L14156`
- `PrintStation` → `schema.prisma:L13474`
- `ProcessedStripeEvent` → `schema.prisma:L5616`
- `ProcessorReliabilityMetric` → `schema.prisma:L6101`
- `Product` → `schema.prisma:L1605`
- `ProductModifierGroup` → `schema.prisma:L3534`
- `ProductOption` → `schema.prisma:L13174`
- `ProductOptionValue` → `schema.prisma:L13185`
- `ProductStaff` → `schema.prisma:L12139`
- `PromoterBankAccount` → `schema.prisma:L15312`
- `PromoterCommissionEntry` → `schema.prisma:L15331`
- `PromoterLocationPing` → `schema.prisma:L3070`
- `Promotion` → `schema.prisma:L15606`
- `PromotionGroup` → `schema.prisma:L15645`
- `PromotionOption` → `schema.prisma:L15661`
- `ProviderCostStructure` → `schema.prisma:L5652`
- `ProviderEventLog` → `schema.prisma:L5399`
- `PurchaseOrder` → `schema.prisma:L2238`
- `PurchaseOrderItem` → `schema.prisma:L2295`
- `RateCorrectionBatch` → `schema.prisma:L5877`
- `RateCorrectionEntry` → `schema.prisma:L5919`
- `RawMaterial` → `schema.prisma:L1999`
- `RawMaterialMovement` → `schema.prisma:L2423`
- `RawMaterialPresentation` → `schema.prisma:L2072`
- `Recipe` → `schema.prisma:L2092`
- `RecipeLine` → `schema.prisma:L2116`
- `Referral` → `schema.prisma:L6538`
- `ReferralProgramConfig` → `schema.prisma:L6503`
- `ReferralRewardGrant` → `schema.prisma:L6629`
- `ReferralTierReward` → `schema.prisma:L6601`
- `ReferralTierUnlock` → `schema.prisma:L6674`
- `Reservation` → `schema.prisma:L11926`
- `ReservationGoogleEventMapping` → `schema.prisma:L12663`
- `ReservationModifier` → `schema.prisma:L12087`
- `ReservationReminderSent` → `schema.prisma:L12070`
- `ReservationSettings` → `schema.prisma:L12301`
- `ReservationWaitlistEntry` → `schema.prisma:L12269`
- `Review` → `schema.prisma:L4155`
- `SalesRetention` → `schema.prisma:L15012`
- `SaleVerification` → `schema.prisma:L3914`
- `ScaleProfile` → `schema.prisma:L13897`
- `ScheduledCommand` → `schema.prisma:L8791`
- `SerializedItem` → `schema.prisma:L10421`
- `SerializedItemCustodyEvent` → `schema.prisma:L10584`
- `ServiceCharge` → `schema.prisma:L7138`
- `SettlementConfiguration` → `schema.prisma:L5952`
- `SettlementConfirmation` → `schema.prisma:L6065`
- `SettlementIncident` → `schema.prisma:L6016`
- `SettlementSimulation` → `schema.prisma:L5987`
- `Shift` → `schema.prisma:L2911`
- `SimRegistrationRequest` → `schema.prisma:L10622`
- `SimRegistrationRequestItem` → `schema.prisma:L10644`
- `SlotHold` → `schema.prisma:L12170`
- `Staff` → `schema.prisma:L897`
- `StaffOnboardingState` → `schema.prisma:L14227`
- `StaffOrganization` → `schema.prisma:L1193`
- `StaffPasskey` → `schema.prisma:L1220`
- `StaffSchedule` → `schema.prisma:L12110`
- `StaffScheduleException` → `schema.prisma:L12122`
- `StaffVenue` → `schema.prisma:L1123`
- `StockAlertConfig` → `schema.prisma:L11265`
- `StockBatch` → `schema.prisma:L2574`
- `StockCount` → `schema.prisma:L2498`
- `StockCountItem` → `schema.prisma:L2522`
- `StripeWebhookEvent` → `schema.prisma:L5599`
- `Supplier` → `schema.prisma:L2151`
- `SupplierPricing` → `schema.prisma:L2204`
- `Table` → `schema.prisma:L2823`
- `Terminal` → `schema.prisma:L4206`
- `TerminalHealth` → `schema.prisma:L4445`
- `TerminalLog` → `schema.prisma:L4419`
- `TerminalOrder` → `schema.prisma:L4578`
- `TerminalOrderItem` → `schema.prisma:L4653`
- `TerminalPaymentRequest` → `schema.prisma:L4516`
- `TimeEntry` → `schema.prisma:L2983`
- `TimeEntryBreak` → `schema.prisma:L3052`
- `TokenPurchase` → `schema.prisma:L8465`
- `TokenUsageRecord` → `schema.prisma:L8437`
- `TpvCommandHistory` → `schema.prisma:L8697`
- `TpvCommandQueue` → `schema.prisma:L8637`
- `TpvFeedback` → `schema.prisma:L8350`
- `TpvMessage` → `schema.prisma:L11622`
- `TpvMessageDelivery` → `schema.prisma:L11674`
- `TpvMessageResponse` → `schema.prisma:L11697`
- `TrainingModule` → `schema.prisma:L11752`
- `TrainingProgress` → `schema.prisma:L11829`
- `TrainingQuizQuestion` → `schema.prisma:L11811`
- `TrainingStep` → `schema.prisma:L11791`
- `TransactionCost` → `schema.prisma:L5815`
- `UnitConversion` → `schema.prisma:L2401`
- `UpsellAcceptance` → `schema.prisma:L6959`
- `UpsellAiRun` → `schema.prisma:L6979`
- `UpsellImpression` → `schema.prisma:L6919`
- `UpsellRule` → `schema.prisma:L6839`
- `user_sessions` → `schema.prisma:L5155`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L13634`
- `VenueChatMessage` → `schema.prisma:L747`
- `VenueChatSession` → `schema.prisma:L702`
- `VenueCommission` → `schema.prisma:L13335`
- `VenueCreditAssessment` → `schema.prisma:L9159`
- `VenueCryptoConfig` → `schema.prisma:L11489`
- `VenueFeature` → `schema.prisma:L4028`
- `VenueModule` → `schema.prisma:L9319`
- `VenuePaymentConfig` → `schema.prisma:L5256`
- `VenuePaymentLinkSettings` → `schema.prisma:L12696`
- `VenuePricingStructure` → `schema.prisma:L5755`
- `VenueRoleConfig` → `schema.prisma:L1346`
- `VenueRolePermission` → `schema.prisma:L1250`
- `VenueScaleSettings` → `schema.prisma:L13885`
- `VenueSettings` → `schema.prisma:L787`
- `VenueTenderType` → `schema.prisma:L3773`
- `VenueTenderTypeRevision` → `schema.prisma:L3838`
- `VenueTransaction` → `schema.prisma:L3965`
- `VenueWhatsappActivation` → `schema.prisma:L638`
- `WebhookEvent` → `schema.prisma:L4064`
- `WebhookSubscription` → `schema.prisma:L5372`
- `WhatsappContactWindow` → `schema.prisma:L656`
- `WhatsappInboundEvent` → `schema.prisma:L676`
- `Zone` → `schema.prisma:L142`
