# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **331 models / 323 enums / ~15,800 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L14962`
- `AccountMapping` → `schema.prisma:L14858`
- `ActivityLog` → `schema.prisma:L6231`
- `Aggregator` → `schema.prisma:L13259`
- `AngelPayUserAccount` → `schema.prisma:L4894`
- `AppUpdate` → `schema.prisma:L11474`
- `Area` → `schema.prisma:L2801`
- `AreaTicket` → `schema.prisma:L13753`
- `AreaTicketCheckoutSession` → `schema.prisma:L13875`
- `AreaTicketExternalIncident` → `schema.prisma:L14122`
- `AreaTicketExternalSettlement` → `schema.prisma:L14087`
- `AreaTicketFulfillment` → `schema.prisma:L13951`
- `AreaTicketInventoryReservation` → `schema.prisma:L13846`
- `AreaTicketLine` → `schema.prisma:L13814`
- `AreaTicketPaymentAttempt` → `schema.prisma:L13907`
- `AreaTicketPrintAttempt` → `schema.prisma:L13930`
- `BankStatement` → `schema.prisma:L14732`
- `BankStatementLine` → `schema.prisma:L14753`
- `BillingTaxProfile` → `schema.prisma:L15542`
- `BulkCommandOperation` → `schema.prisma:L8787`
- `CalendarSyncOutbox` → `schema.prisma:L12653`
- `CampaignDelivery` → `schema.prisma:L11632`
- `CashCloseout` → `schema.prisma:L9152`
- `CashDeposit` → `schema.prisma:L11276`
- `CashDrawerEvent` → `schema.prisma:L13096`
- `CashDrawerSession` → `schema.prisma:L13072`
- `CashOutCommissionRate` → `schema.prisma:L15371`
- `CashOutScheduleDay` → `schema.prisma:L15394`
- `CashOutWithdrawal` → `schema.prisma:L15456`
- `CatalogBindingBatch` → `schema.prisma:L10183`
- `CatalogBindingLine` → `schema.prisma:L10219`
- `CatalogBrand` → `schema.prisma:L9636`
- `CatalogClientObservation` → `schema.prisma:L9949`
- `CatalogClientReadinessOverride` → `schema.prisma:L9968`
- `CatalogFamily` → `schema.prisma:L9686`
- `CatalogIdempotencyRecord` → `schema.prisma:L10082`
- `CatalogIdentifier` → `schema.prisma:L9817`
- `CatalogImportBatch` → `schema.prisma:L10125`
- `CatalogImportLine` → `schema.prisma:L10162`
- `CatalogItem` → `schema.prisma:L9719`
- `CatalogItemBusinessType` → `schema.prisma:L9779`
- `CatalogItemPrice` → `schema.prisma:L9867`
- `CatalogManufacturer` → `schema.prisma:L9660`
- `CatalogProductTypeMapping` → `schema.prisma:L9796`
- `CatalogPublicationBatch` → `schema.prisma:L10247`
- `CatalogPublicationFieldDecision` → `schema.prisma:L10341`
- `CatalogPublicationLine` → `schema.prisma:L10288`
- `CatalogPublicationOutbox` → `schema.prisma:L10384`
- `CatalogValidationProfile` → `schema.prisma:L9838`
- `CatalogVenueBinding` → `schema.prisma:L9996`
- `CatalogVenueClientRequirement` → `schema.prisma:L9923`
- `CatalogVenueEventSequence` → `schema.prisma:L10367`
- `CatalogVenueOverride` → `schema.prisma:L10038`
- `CatalogVenueRollout` → `schema.prisma:L9898`
- `Cfdi` → `schema.prisma:L14635`
- `ChatbotTokenBudget` → `schema.prisma:L8435`
- `ChatConversation` → `schema.prisma:L8290`
- `ChatFeedback` → `schema.prisma:L8376`
- `ChatLearningEvent` → `schema.prisma:L8333`
- `ChatMessage` → `schema.prisma:L8313`
- `ChatTrainingData` → `schema.prisma:L8247`
- `CheckoutSession` → `schema.prisma:L5174`
- `ClassSession` → `schema.prisma:L12266`
- `CommissionCalculation` → `schema.prisma:L11055`
- `CommissionClawback` → `schema.prisma:L11228`
- `CommissionConfig` → `schema.prisma:L10828`
- `CommissionMilestone` → `schema.prisma:L10971`
- `CommissionOverride` → `schema.prisma:L10898`
- `CommissionPayout` → `schema.prisma:L11179`
- `CommissionSummary` → `schema.prisma:L11118`
- `CommissionTier` → `schema.prisma:L10935`
- `Consumer` → `schema.prisma:L6386`
- `ConsumerAuthAccount` → `schema.prisma:L6411`
- `CouponCode` → `schema.prisma:L7032`
- `CouponRedemption` → `schema.prisma:L7063`
- `CreditAssessmentHistory` → `schema.prisma:L9261`
- `CreditItemBalance` → `schema.prisma:L12862`
- `CreditOffer` → `schema.prisma:L9280`
- `CreditPack` → `schema.prisma:L12778`
- `CreditPackItem` → `schema.prisma:L12807`
- `CreditPackPurchase` → `schema.prisma:L12824`
- `CreditTransaction` → `schema.prisma:L12884`
- `Customer` → `schema.prisma:L6272`
- `CustomerDiscount` → `schema.prisma:L7083`
- `CustomerGroup` → `schema.prisma:L6450`
- `CustomerTaxProfile` → `schema.prisma:L14704`
- `DeliveryActivationRequest` → `schema.prisma:L5515`
- `DeliveryChannelLink` → `schema.prisma:L5460`
- `DeliveryOrderEvent` → `schema.prisma:L5539`
- `DeviceToken` → `schema.prisma:L7352`
- `DigitalReceipt` → `schema.prisma:L3889`
- `Discount` → `schema.prisma:L6722`
- `EcommerceMerchant` → `schema.prisma:L4986`
- `EmailTemplate` → `schema.prisma:L11571`
- `Employee` → `schema.prisma:L15219`
- `Estimate` → `schema.prisma:L13166`
- `EstimateItem` → `schema.prisma:L13194`
- `Expense` → `schema.prisma:L15006`
- `ExternalBusyBlock` → `schema.prisma:L12546`
- `Feature` → `schema.prisma:L4018`
- `FeeSchedule` → `schema.prisma:L4096`
- `FeeTier` → `schema.prisma:L4107`
- `FinancialAccount` → `schema.prisma:L13356`
- `FinancialConnection` → `schema.prisma:L13325`
- `FinancialProvider` → `schema.prisma:L13311`
- `FiscalEmisor` → `schema.prisma:L14558`
- `FiscalLossCarryforward` → `schema.prisma:L15129`
- `FixedAsset` → `schema.prisma:L15147`
- `FixedAssetDepreciation` → `schema.prisma:L15176`
- `FloorElement` → `schema.prisma:L2877`
- `FulfillmentArea` → `schema.prisma:L13618`
- `GeofenceRule` → `schema.prisma:L8872`
- `GoogleCalendarChannel` → `schema.prisma:L12523`
- `GoogleCalendarConnection` → `schema.prisma:L12475`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L12576`
- `GoogleOAuthSession` → `schema.prisma:L12598`
- `HolidayCalendar` → `schema.prisma:L6155`
- `IdempotencyRequest` → `schema.prisma:L10703`
- `InterVenueTransfer` → `schema.prisma:L2629`
- `InterVenueTransferAllocation` → `schema.prisma:L2712`
- `InterVenueTransferItem` → `schema.prisma:L2681`
- `InterVenueTransferReceipt` → `schema.prisma:L2739`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2755`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2783`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2767`
- `Inventory` → `schema.prisma:L1822`
- `InventoryMovement` → `schema.prisma:L1849`
- `InventoryPosting` → `schema.prisma:L1931`
- `InventoryPostingLine` → `schema.prisma:L1971`
- `InventoryTransfer` → `schema.prisma:L13138`
- `Invitation` → `schema.prisma:L1370`
- `Invoice` → `schema.prisma:L4119`
- `InvoiceItem` → `schema.prisma:L4145`
- `ItemCategory` → `schema.prisma:L10419`
- `JournalEntry` → `schema.prisma:L14916`
- `JournalLine` → `schema.prisma:L14944`
- `KdsOrder` → `schema.prisma:L13404`
- `KdsOrderItem` → `schema.prisma:L13445`
- `LearnedPatterns` → `schema.prisma:L8357`
- `LedgerAccount` → `schema.prisma:L14808`
- `LiveDemoSession` → `schema.prisma:L771`
- `LowStockAlert` → `schema.prisma:L2470`
- `LoyaltyConfig` → `schema.prisma:L6480`
- `LoyaltyTransaction` → `schema.prisma:L6503`
- `MarketingCampaign` → `schema.prisma:L11589`
- `McpAuthCode` → `schema.prisma:L14441`
- `McpOAuthClient` → `schema.prisma:L14425`
- `McpRefreshToken` → `schema.prisma:L14459`
- `McpToolCall` → `schema.prisma:L14480`
- `MeasurementUnit` → `schema.prisma:L13244`
- `Menu` → `schema.prisma:L1556`
- `MenuCategory` → `schema.prisma:L1493`
- `MenuCategoryAssignment` → `schema.prisma:L1591`
- `MercadoPagoWebhookEvent` → `schema.prisma:L14355`
- `MerchantAccount` → `schema.prisma:L4724`
- `MerchantFiscalConfig` → `schema.prisma:L14606`
- `MerchantRevenueShare` → `schema.prisma:L5735`
- `MerchantRoutingRule` → `schema.prisma:L4846`
- `MilestoneAchievement` → `schema.prisma:L11016`
- `Modifier` → `schema.prisma:L3505`
- `ModifierGroup` → `schema.prisma:L3469`
- `Module` → `schema.prisma:L9328`
- `MoneyAnomaly` → `schema.prisma:L5638`
- `MonthlyVenueProfit` → `schema.prisma:L6181`
- `Notification` → `schema.prisma:L7254`
- `NotificationPreference` → `schema.prisma:L7301`
- `NotificationTemplate` → `schema.prisma:L7328`
- `OAuthState` → `schema.prisma:L1421`
- `OnboardingProgress` → `schema.prisma:L1439`
- `Order` → `schema.prisma:L3108`
- `OrderAction` → `schema.prisma:L3570`
- `OrderCustomer` → `schema.prisma:L3320`
- `OrderDiscount` → `schema.prisma:L7115`
- `OrderFulfillment` → `schema.prisma:L13673`
- `OrderFulfillmentLine` → `schema.prisma:L13704`
- `OrderItem` → `schema.prisma:L3336`
- `OrderItemModifier` → `schema.prisma:L3554`
- `OrderPromotion` → `schema.prisma:L15782`
- `OrderServiceCharge` → `schema.prisma:L7199`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L11390`
- `OrganizationEntitlement` → `schema.prisma:L9611`
- `OrganizationGoal` → `schema.prisma:L11348`
- `OrganizationModule` → `schema.prisma:L9388`
- `OrganizationPaymentConfig` → `schema.prisma:L5298`
- `OrganizationPayoutConfig` → `schema.prisma:L11423`
- `OrganizationPricingStructure` → `schema.prisma:L5330`
- `OrganizationSalesGoalConfig` → `schema.prisma:L11371`
- `OtpChallenge` → `schema.prisma:L6430`
- `PartnerAPIKey` → `schema.prisma:L5128`
- `Payment` → `schema.prisma:L3603`
- `PaymentAllocation` → `schema.prisma:L3868`
- `PaymentLink` → `schema.prisma:L12930`
- `PaymentLinkAttribution` → `schema.prisma:L13038`
- `PaymentLinkItem` → `schema.prisma:L12993`
- `PaymentLinkItemModifier` → `schema.prisma:L13020`
- `PaymentProvider` → `schema.prisma:L4683`
- `PayrollLine` → `schema.prisma:L15290`
- `PayrollRun` → `schema.prisma:L15259`
- `PerformanceGoal` → `schema.prisma:L11325`
- `PermissionOverride` → `schema.prisma:L1298`
- `PermissionSet` → `schema.prisma:L1321`
- `PlatformCfdi` → `schema.prisma:L15575`
- `PlatformEmisor` → `schema.prisma:L15515`
- `PlatformSettings` → `schema.prisma:L5105`
- `PosCommand` → `schema.prisma:L7382`
- `PosConnectionStatus` → `schema.prisma:L877`
- `PosSyncIntent` → `schema.prisma:L15653`
- `PricingPolicy` → `schema.prisma:L2374`
- `Printer` → `schema.prisma:L13487`
- `PrintGateway` → `schema.prisma:L13540`
- `PrintJob` → `schema.prisma:L14254`
- `PrintStation` → `schema.prisma:L13558`
- `ProcessedStripeEvent` → `schema.prisma:L5624`
- `ProcessorReliabilityMetric` → `schema.prisma:L6109`
- `Product` → `schema.prisma:L1609`
- `ProductModifierGroup` → `schema.prisma:L3542`
- `ProductOption` → `schema.prisma:L13221`
- `ProductOptionValue` → `schema.prisma:L13232`
- `ProductStaff` → `schema.prisma:L12181`
- `PromoterBankAccount` → `schema.prisma:L15410`
- `PromoterCommissionEntry` → `schema.prisma:L15429`
- `PromoterLocationPing` → `schema.prisma:L3074`
- `Promotion` → `schema.prisma:L15704`
- `PromotionGroup` → `schema.prisma:L15743`
- `PromotionOption` → `schema.prisma:L15759`
- `ProviderCostStructure` → `schema.prisma:L5660`
- `ProviderEventLog` → `schema.prisma:L5407`
- `PurchaseOrder` → `schema.prisma:L2242`
- `PurchaseOrderItem` → `schema.prisma:L2299`
- `RateCorrectionBatch` → `schema.prisma:L5885`
- `RateCorrectionEntry` → `schema.prisma:L5927`
- `RawMaterial` → `schema.prisma:L2003`
- `RawMaterialMovement` → `schema.prisma:L2427`
- `RawMaterialPresentation` → `schema.prisma:L2076`
- `Recipe` → `schema.prisma:L2096`
- `RecipeLine` → `schema.prisma:L2120`
- `Referral` → `schema.prisma:L6570`
- `ReferralProgramConfig` → `schema.prisma:L6535`
- `ReferralRewardGrant` → `schema.prisma:L6661`
- `ReferralTierReward` → `schema.prisma:L6633`
- `ReferralTierUnlock` → `schema.prisma:L6706`
- `Reservation` → `schema.prisma:L11968`
- `ReservationGoogleEventMapping` → `schema.prisma:L12710`
- `ReservationModifier` → `schema.prisma:L12129`
- `ReservationReminderSent` → `schema.prisma:L12112`
- `ReservationSettings` → `schema.prisma:L12343`
- `ReservationWaitlistEntry` → `schema.prisma:L12311`
- `Review` → `schema.prisma:L4163`
- `SalesRetention` → `schema.prisma:L15110`
- `SaleVerification` → `schema.prisma:L3922`
- `ScaleProfile` → `schema.prisma:L13995`
- `ScheduledCommand` → `schema.prisma:L8832`
- `SerializedItem` → `schema.prisma:L10462`
- `SerializedItemCustodyEvent` → `schema.prisma:L10626`
- `ServiceCharge` → `schema.prisma:L7170`
- `SettlementConfiguration` → `schema.prisma:L5960`
- `SettlementConfirmation` → `schema.prisma:L6073`
- `SettlementIncident` → `schema.prisma:L6024`
- `SettlementSimulation` → `schema.prisma:L5995`
- `Shift` → `schema.prisma:L2915`
- `SimRegistrationRequest` → `schema.prisma:L10664`
- `SimRegistrationRequestItem` → `schema.prisma:L10686`
- `SlotHold` → `schema.prisma:L12212`
- `Staff` → `schema.prisma:L897`
- `StaffOnboardingState` → `schema.prisma:L14325`
- `StaffOrganization` → `schema.prisma:L1197`
- `StaffPasskey` → `schema.prisma:L1224`
- `StaffSchedule` → `schema.prisma:L12152`
- `StaffScheduleException` → `schema.prisma:L12164`
- `StaffVenue` → `schema.prisma:L1127`
- `StockAlertConfig` → `schema.prisma:L11307`
- `StockBatch` → `schema.prisma:L2578`
- `StockCount` → `schema.prisma:L2502`
- `StockCountItem` → `schema.prisma:L2526`
- `StripeWebhookEvent` → `schema.prisma:L5607`
- `Supplier` → `schema.prisma:L2155`
- `SupplierPricing` → `schema.prisma:L2208`
- `Table` → `schema.prisma:L2827`
- `Terminal` → `schema.prisma:L4214`
- `TerminalHealth` → `schema.prisma:L4453`
- `TerminalLog` → `schema.prisma:L4427`
- `TerminalOrder` → `schema.prisma:L4586`
- `TerminalOrderItem` → `schema.prisma:L4661`
- `TerminalPaymentRequest` → `schema.prisma:L4524`
- `TimeEntry` → `schema.prisma:L2987`
- `TimeEntryBreak` → `schema.prisma:L3056`
- `TokenPurchase` → `schema.prisma:L8506`
- `TokenUsageRecord` → `schema.prisma:L8478`
- `TpvCommandHistory` → `schema.prisma:L8738`
- `TpvCommandQueue` → `schema.prisma:L8678`
- `TpvFeedback` → `schema.prisma:L8391`
- `TpvMessage` → `schema.prisma:L11664`
- `TpvMessageDelivery` → `schema.prisma:L11716`
- `TpvMessageResponse` → `schema.prisma:L11739`
- `TrainingModule` → `schema.prisma:L11794`
- `TrainingProgress` → `schema.prisma:L11871`
- `TrainingQuizQuestion` → `schema.prisma:L11853`
- `TrainingStep` → `schema.prisma:L11833`
- `TransactionCost` → `schema.prisma:L5823`
- `UnitConversion` → `schema.prisma:L2405`
- `UpsellAcceptance` → `schema.prisma:L6991`
- `UpsellAiRun` → `schema.prisma:L7011`
- `UpsellImpression` → `schema.prisma:L6951`
- `UpsellRule` → `schema.prisma:L6871`
- `user_sessions` → `schema.prisma:L5163`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L13732`
- `VenueChatMessage` → `schema.prisma:L747`
- `VenueChatSession` → `schema.prisma:L702`
- `VenueCommission` → `schema.prisma:L13382`
- `VenueCreditAssessment` → `schema.prisma:L9200`
- `VenueCryptoConfig` → `schema.prisma:L11531`
- `VenueFeature` → `schema.prisma:L4036`
- `VenueModule` → `schema.prisma:L9360`
- `VenuePaymentConfig` → `schema.prisma:L5264`
- `VenuePaymentLinkSettings` → `schema.prisma:L12743`
- `VenuePricingStructure` → `schema.prisma:L5763`
- `VenueRoleConfig` → `schema.prisma:L1350`
- `VenueRolePermission` → `schema.prisma:L1254`
- `VenueScaleSettings` → `schema.prisma:L13983`
- `VenueSettings` → `schema.prisma:L787`
- `VenueTenderType` → `schema.prisma:L3781`
- `VenueTenderTypeRevision` → `schema.prisma:L3846`
- `VenueTransaction` → `schema.prisma:L3973`
- `VenueWhatsappActivation` → `schema.prisma:L638`
- `WebhookEvent` → `schema.prisma:L4072`
- `WebhookSubscription` → `schema.prisma:L5380`
- `WhatsappContactWindow` → `schema.prisma:L656`
- `WhatsappInboundEvent` → `schema.prisma:L676`
- `Zone` → `schema.prisma:L142`
