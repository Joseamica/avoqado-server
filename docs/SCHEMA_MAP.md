# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **353 models / 339 enums / ~16,900 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                                                        |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                            |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                                      |
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
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L15763`
- `AccountMapping` → `schema.prisma:L15659`
- `ActivityLog` → `schema.prisma:L6556`
- `Aggregator` → `schema.prisma:L14060`
- `AngelPayUserAccount` → `schema.prisma:L5219`
- `AppUpdate` → `schema.prisma:L12240`
- `Area` → `schema.prisma:L3007`
- `AreaTicket` → `schema.prisma:L14554`
- `AreaTicketCheckoutSession` → `schema.prisma:L14676`
- `AreaTicketExternalIncident` → `schema.prisma:L14923`
- `AreaTicketExternalSettlement` → `schema.prisma:L14888`
- `AreaTicketFulfillment` → `schema.prisma:L14752`
- `AreaTicketInventoryReservation` → `schema.prisma:L14647`
- `AreaTicketLine` → `schema.prisma:L14615`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14708`
- `AreaTicketPrintAttempt` → `schema.prisma:L14731`
- `BankStatement` → `schema.prisma:L15533`
- `BankStatementLine` → `schema.prisma:L15554`
- `BillingTaxProfile` → `schema.prisma:L16343`
- `BulkCommandOperation` → `schema.prisma:L9523`
- `CalendarSyncOutbox` → `schema.prisma:L13447`
- `CampaignDelivery` → `schema.prisma:L12398`
- `CashCloseout` → `schema.prisma:L9908`
- `CashDeposit` → `schema.prisma:L12042`
- `CashDrawerEvent` → `schema.prisma:L13897`
- `CashDrawerSession` → `schema.prisma:L13873`
- `CashOutCommissionRate` → `schema.prisma:L16172`
- `CashOutScheduleDay` → `schema.prisma:L16195`
- `CashOutWithdrawal` → `schema.prisma:L16257`
- `CatalogBindingBatch` → `schema.prisma:L10939`
- `CatalogBindingLine` → `schema.prisma:L10975`
- `CatalogBrand` → `schema.prisma:L10392`
- `CatalogClientObservation` → `schema.prisma:L10705`
- `CatalogClientReadinessOverride` → `schema.prisma:L10724`
- `CatalogFamily` → `schema.prisma:L10442`
- `CatalogIdempotencyRecord` → `schema.prisma:L10838`
- `CatalogIdentifier` → `schema.prisma:L10573`
- `CatalogImportBatch` → `schema.prisma:L10881`
- `CatalogImportLine` → `schema.prisma:L10918`
- `CatalogItem` → `schema.prisma:L10475`
- `CatalogItemBusinessType` → `schema.prisma:L10535`
- `CatalogItemPrice` → `schema.prisma:L10623`
- `CatalogManufacturer` → `schema.prisma:L10416`
- `CatalogProductTypeMapping` → `schema.prisma:L10552`
- `CatalogPublicationBatch` → `schema.prisma:L11003`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11097`
- `CatalogPublicationLine` → `schema.prisma:L11044`
- `CatalogPublicationOutbox` → `schema.prisma:L11140`
- `CatalogValidationProfile` → `schema.prisma:L10594`
- `CatalogVenueBinding` → `schema.prisma:L10752`
- `CatalogVenueClientRequirement` → `schema.prisma:L10679`
- `CatalogVenueEventSequence` → `schema.prisma:L11123`
- `CatalogVenueOverride` → `schema.prisma:L10794`
- `CatalogVenueRollout` → `schema.prisma:L10654`
- `Cfdi` → `schema.prisma:L15436`
- `ChatbotTokenBudget` → `schema.prisma:L9171`
- `ChatConversation` → `schema.prisma:L9026`
- `ChatFeedback` → `schema.prisma:L9112`
- `ChatLearningEvent` → `schema.prisma:L9069`
- `ChatMessage` → `schema.prisma:L9049`
- `ChatTrainingData` → `schema.prisma:L8983`
- `CheckoutSession` → `schema.prisma:L5499`
- `ClassSession` → `schema.prisma:L13051`
- `CommissionCalculation` → `schema.prisma:L11818`
- `CommissionClawback` → `schema.prisma:L11994`
- `CommissionConfig` → `schema.prisma:L11584`
- `CommissionMilestone` → `schema.prisma:L11734`
- `CommissionOverride` → `schema.prisma:L11661`
- `CommissionPayout` → `schema.prisma:L11945`
- `CommissionSummary` → `schema.prisma:L11884`
- `CommissionTier` → `schema.prisma:L11698`
- `Consumer` → `schema.prisma:L6718`
- `ConsumerAuthAccount` → `schema.prisma:L6743`
- `CouponCode` → `schema.prisma:L7681`
- `CouponRedemption` → `schema.prisma:L7712`
- `CreditAssessmentHistory` → `schema.prisma:L10017`
- `CreditItemBalance` → `schema.prisma:L13663`
- `CreditOffer` → `schema.prisma:L10036`
- `CreditPack` → `schema.prisma:L13572`
- `CreditPackItem` → `schema.prisma:L13601`
- `CreditPackPurchase` → `schema.prisma:L13618`
- `CreditTransaction` → `schema.prisma:L13685`
- `Customer` → `schema.prisma:L6597`
- `CustomerApprovalDelivery` → `schema.prisma:L8688`
- `CustomerApprovalOutbox` → `schema.prisma:L8663`
- `CustomerDiscount` → `schema.prisma:L7732`
- `CustomerGroup` → `schema.prisma:L6782`
- `CustomerTaxProfile` → `schema.prisma:L15505`
- `DeliveryActivationRequest` → `schema.prisma:L5840`
- `DeliveryChannelLink` → `schema.prisma:L5785`
- `DeliveryOrderEvent` → `schema.prisma:L5864`
- `DeviceToken` → `schema.prisma:L8001`
- `DigitalReceipt` → `schema.prisma:L4214`
- `Discount` → `schema.prisma:L7371`
- `EcommerceMerchant` → `schema.prisma:L5311`
- `EmailTemplate` → `schema.prisma:L12337`
- `Employee` → `schema.prisma:L16020`
- `Estimate` → `schema.prisma:L13967`
- `EstimateItem` → `schema.prisma:L13995`
- `Expense` → `schema.prisma:L15807`
- `ExternalBusyBlock` → `schema.prisma:L13340`
- `Feature` → `schema.prisma:L4343`
- `FeeSchedule` → `schema.prisma:L4421`
- `FeeTier` → `schema.prisma:L4432`
- `FinancialAccount` → `schema.prisma:L14157`
- `FinancialConnection` → `schema.prisma:L14126`
- `FinancialProvider` → `schema.prisma:L14112`
- `FiscalEmisor` → `schema.prisma:L15359`
- `FiscalLossCarryforward` → `schema.prisma:L15930`
- `FixedAsset` → `schema.prisma:L15948`
- `FixedAssetDepreciation` → `schema.prisma:L15977`
- `FloorElement` → `schema.prisma:L3083`
- `FulfillmentArea` → `schema.prisma:L14419`
- `GeofenceRule` → `schema.prisma:L9608`
- `GoogleCalendarChannel` → `schema.prisma:L13317`
- `GoogleCalendarConnection` → `schema.prisma:L13269`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13370`
- `GoogleOAuthSession` → `schema.prisma:L13392`
- `HolidayCalendar` → `schema.prisma:L6480`
- `IdempotencyRequest` → `schema.prisma:L11459`
- `InterVenueTransfer` → `schema.prisma:L2835`
- `InterVenueTransferAllocation` → `schema.prisma:L2918`
- `InterVenueTransferItem` → `schema.prisma:L2887`
- `InterVenueTransferReceipt` → `schema.prisma:L2945`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2961`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2989`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2973`
- `Inventory` → `schema.prisma:L1881`
- `InventoryMovement` → `schema.prisma:L1908`
- `InventoryPosting` → `schema.prisma:L1990`
- `InventoryPostingLine` → `schema.prisma:L2030`
- `InventoryTransfer` → `schema.prisma:L13939`
- `Invitation` → `schema.prisma:L1419`
- `Invoice` → `schema.prisma:L4444`
- `InvoiceItem` → `schema.prisma:L4470`
- `ItemCategory` → `schema.prisma:L11175`
- `JournalEntry` → `schema.prisma:L15717`
- `JournalLine` → `schema.prisma:L15745`
- `KdsOrder` → `schema.prisma:L14205`
- `KdsOrderItem` → `schema.prisma:L14246`
- `KioskCheckInAttempt` → `schema.prisma:L16666`
- `KioskCheckInChallenge` → `schema.prisma:L16620`
- `KioskOutreachOutbox` → `schema.prisma:L16687`
- `LearnedPatterns` → `schema.prisma:L9093`
- `LedgerAccount` → `schema.prisma:L15609`
- `LiveDemoSession` → `schema.prisma:L784`
- `LowStockAlert` → `schema.prisma:L2676`
- `LoyaltyConfig` → `schema.prisma:L6812`
- `LoyaltyTransaction` → `schema.prisma:L6855`
- `MarketingCampaign` → `schema.prisma:L12355`
- `McpAuthCode` → `schema.prisma:L15242`
- `McpOAuthClient` → `schema.prisma:L15226`
- `McpRefreshToken` → `schema.prisma:L15260`
- `McpToolCall` → `schema.prisma:L15281`
- `MeasurementUnit` → `schema.prisma:L14045`
- `Menu` → `schema.prisma:L1605`
- `MenuCategory` → `schema.prisma:L1542`
- `MenuCategoryAssignment` → `schema.prisma:L1640`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15156`
- `MerchantAccount` → `schema.prisma:L5049`
- `MerchantFiscalConfig` → `schema.prisma:L15407`
- `MerchantRevenueShare` → `schema.prisma:L6060`
- `MerchantRoutingRule` → `schema.prisma:L5171`
- `MilestoneAchievement` → `schema.prisma:L11779`
- `Modifier` → `schema.prisma:L3829`
- `ModifierGroup` → `schema.prisma:L3793`
- `Module` → `schema.prisma:L10084`
- `MoneyAnomaly` → `schema.prisma:L5963`
- `MonthlyVenueProfit` → `schema.prisma:L6506`
- `Notification` → `schema.prisma:L7903`
- `NotificationPreference` → `schema.prisma:L7950`
- `NotificationTemplate` → `schema.prisma:L7977`
- `OAuthState` → `schema.prisma:L1470`
- `OnboardingProgress` → `schema.prisma:L1488`
- `Order` → `schema.prisma:L3431`
- `OrderAction` → `schema.prisma:L3894`
- `OrderCustomer` → `schema.prisma:L3644`
- `OrderDiscount` → `schema.prisma:L7764`
- `OrderFulfillment` → `schema.prisma:L14474`
- `OrderFulfillmentLine` → `schema.prisma:L14505`
- `OrderItem` → `schema.prisma:L3660`
- `OrderItemModifier` → `schema.prisma:L3878`
- `OrderPromotion` → `schema.prisma:L16583`
- `OrderServiceCharge` → `schema.prisma:L7848`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12156`
- `OrganizationEntitlement` → `schema.prisma:L10367`
- `OrganizationGoal` → `schema.prisma:L12114`
- `OrganizationModule` → `schema.prisma:L10144`
- `OrganizationPaymentConfig` → `schema.prisma:L5623`
- `OrganizationPayoutConfig` → `schema.prisma:L12189`
- `OrganizationPricingStructure` → `schema.prisma:L5655`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12137`
- `OtpChallenge` → `schema.prisma:L6762`
- `PartnerAPIKey` → `schema.prisma:L5453`
- `Payment` → `schema.prisma:L3927`
- `PaymentAllocation` → `schema.prisma:L4193`
- `PaymentLink` → `schema.prisma:L13731`
- `PaymentLinkAttribution` → `schema.prisma:L13839`
- `PaymentLinkItem` → `schema.prisma:L13794`
- `PaymentLinkItemModifier` → `schema.prisma:L13821`
- `PaymentProvider` → `schema.prisma:L5008`
- `PayrollLine` → `schema.prisma:L16091`
- `PayrollRun` → `schema.prisma:L16060`
- `PerformanceGoal` → `schema.prisma:L12091`
- `PermissionOverride` → `schema.prisma:L1347`
- `PermissionSet` → `schema.prisma:L1370`
- `PlatformAnnouncement` → `schema.prisma:L16747`
- `PlatformAnnouncementClick` → `schema.prisma:L16812`
- `PlatformAnnouncementDelivery` → `schema.prisma:L16849`
- `PlatformCfdi` → `schema.prisma:L16376`
- `PlatformEmisor` → `schema.prisma:L16316`
- `PlatformSettings` → `schema.prisma:L5430`
- `PosCommand` → `schema.prisma:L8031`
- `PosConnectionStatus` → `schema.prisma:L899`
- `PosSyncIntent` → `schema.prisma:L16454`
- `PricingPolicy` → `schema.prisma:L2580`
- `Printer` → `schema.prisma:L14288`
- `PrintGateway` → `schema.prisma:L14341`
- `PrintJob` → `schema.prisma:L15055`
- `PrintStation` → `schema.prisma:L14359`
- `ProcessedStripeEvent` → `schema.prisma:L5949`
- `ProcessorReliabilityMetric` → `schema.prisma:L6434`
- `Product` → `schema.prisma:L1658`
- `ProductModifierGroup` → `schema.prisma:L3866`
- `ProductOption` → `schema.prisma:L14022`
- `ProductOptionValue` → `schema.prisma:L14033`
- `ProductStaff` → `schema.prisma:L12966`
- `PromoterBankAccount` → `schema.prisma:L16211`
- `PromoterCommissionEntry` → `schema.prisma:L16230`
- `PromoterLocationPing` → `schema.prisma:L3397`
- `Promotion` → `schema.prisma:L16505`
- `PromotionGroup` → `schema.prisma:L16544`
- `PromotionOption` → `schema.prisma:L16560`
- `ProviderCostStructure` → `schema.prisma:L5985`
- `ProviderEventLog` → `schema.prisma:L5732`
- `PurchaseOrder` → `schema.prisma:L2305`
- `PurchaseOrderInvoice` → `schema.prisma:L2450`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2507`
- `PurchaseOrderItem` → `schema.prisma:L2363`
- `RateCorrectionBatch` → `schema.prisma:L6210`
- `RateCorrectionEntry` → `schema.prisma:L6252`
- `RawMaterial` → `schema.prisma:L2062`
- `RawMaterialMovement` → `schema.prisma:L2633`
- `RawMaterialPresentation` → `schema.prisma:L2137`
- `Recipe` → `schema.prisma:L2157`
- `RecipeLine` → `schema.prisma:L2181`
- `Referral` → `schema.prisma:L7219`
- `ReferralProgramConfig` → `schema.prisma:L7184`
- `ReferralRewardGrant` → `schema.prisma:L7310`
- `ReferralTierReward` → `schema.prisma:L7282`
- `ReferralTierUnlock` → `schema.prisma:L7355`
- `RefreshGrant` → `schema.prisma:L16932`
- `Reservation` → `schema.prisma:L12734`
- `ReservationGoogleEventMapping` → `schema.prisma:L13504`
- `ReservationModifier` → `schema.prisma:L12914`
- `ReservationReminderSent` → `schema.prisma:L12897`
- `ReservationSettings` → `schema.prisma:L13128`
- `ReservationWaitlistEntry` → `schema.prisma:L13096`
- `Review` → `schema.prisma:L4488`
- `SalesRetention` → `schema.prisma:L15911`
- `SaleVerification` → `schema.prisma:L4247`
- `ScaleProfile` → `schema.prisma:L14796`
- `ScheduledCommand` → `schema.prisma:L9568`
- `SerializedItem` → `schema.prisma:L11218`
- `SerializedItemCustodyEvent` → `schema.prisma:L11382`
- `ServiceCharge` → `schema.prisma:L7819`
- `Session` → `schema.prisma:L16911`
- `SettlementConfiguration` → `schema.prisma:L6285`
- `SettlementConfirmation` → `schema.prisma:L6398`
- `SettlementIncident` → `schema.prisma:L6349`
- `SettlementSimulation` → `schema.prisma:L6320`
- `Shift` → `schema.prisma:L3121`
- `SimRegistrationRequest` → `schema.prisma:L11420`
- `SimRegistrationRequestItem` → `schema.prisma:L11442`
- `SlotHold` → `schema.prisma:L12997`
- `Staff` → `schema.prisma:L919`
- `StaffDocument` → `schema.prisma:L3268`
- `StaffOnboardingState` → `schema.prisma:L15126`
- `StaffOrganization` → `schema.prisma:L1246`
- `StaffPasskey` → `schema.prisma:L1273`
- `StaffSchedule` → `schema.prisma:L12937`
- `StaffScheduleException` → `schema.prisma:L12949`
- `StaffVenue` → `schema.prisma:L1172`
- `StaffWorkSchedule` → `schema.prisma:L3228`
- `StaffWorkScheduleException` → `schema.prisma:L3243`
- `StampCard` → `schema.prisma:L7067`
- `StampEvent` → `schema.prisma:L7106`
- `StampReward` → `schema.prisma:L7144`
- `StockAlertConfig` → `schema.prisma:L12073`
- `StockBatch` → `schema.prisma:L2784`
- `StockCount` → `schema.prisma:L2708`
- `StockCountItem` → `schema.prisma:L2732`
- `StripeWebhookEvent` → `schema.prisma:L5932`
- `Supplier` → `schema.prisma:L2216`
- `SupplierItemCode` → `schema.prisma:L2548`
- `SupplierPricing` → `schema.prisma:L2271`
- `Table` → `schema.prisma:L3033`
- `Terminal` → `schema.prisma:L4539`
- `TerminalHealth` → `schema.prisma:L4778`
- `TerminalLog` → `schema.prisma:L4752`
- `TerminalOrder` → `schema.prisma:L4911`
- `TerminalOrderItem` → `schema.prisma:L4986`
- `TerminalPaymentRequest` → `schema.prisma:L4849`
- `TimeEntry` → `schema.prisma:L3310`
- `TimeEntryBreak` → `schema.prisma:L3379`
- `TokenPurchase` → `schema.prisma:L9242`
- `TokenUsageRecord` → `schema.prisma:L9214`
- `TpvCommandHistory` → `schema.prisma:L9474`
- `TpvCommandQueue` → `schema.prisma:L9414`
- `TpvFeedback` → `schema.prisma:L9127`
- `TpvMessage` → `schema.prisma:L12430`
- `TpvMessageDelivery` → `schema.prisma:L12482`
- `TpvMessageResponse` → `schema.prisma:L12505`
- `TrainingModule` → `schema.prisma:L12560`
- `TrainingProgress` → `schema.prisma:L12637`
- `TrainingQuizQuestion` → `schema.prisma:L12619`
- `TrainingStep` → `schema.prisma:L12599`
- `TransactionCost` → `schema.prisma:L6148`
- `UnitConversion` → `schema.prisma:L2611`
- `UpsellAcceptance` → `schema.prisma:L7640`
- `UpsellAiRun` → `schema.prisma:L7660`
- `UpsellImpression` → `schema.prisma:L7600`
- `UpsellRule` → `schema.prisma:L7520`
- `user_sessions` → `schema.prisma:L5488`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14533`
- `VenueChatMessage` → `schema.prisma:L760`
- `VenueChatSession` → `schema.prisma:L715`
- `VenueCommission` → `schema.prisma:L14183`
- `VenueCreditAssessment` → `schema.prisma:L9956`
- `VenueCryptoConfig` → `schema.prisma:L12297`
- `VenueFeature` → `schema.prisma:L4361`
- `VenueModule` → `schema.prisma:L10116`
- `VenuePaymentConfig` → `schema.prisma:L5589`
- `VenuePaymentLinkSettings` → `schema.prisma:L13537`
- `VenuePricingStructure` → `schema.prisma:L6088`
- `VenueRoleConfig` → `schema.prisma:L1399`
- `VenueRolePermission` → `schema.prisma:L1303`
- `VenueScaleSettings` → `schema.prisma:L14784`
- `VenueSettings` → `schema.prisma:L800`
- `VenueTenderType` → `schema.prisma:L4106`
- `VenueTenderTypeRevision` → `schema.prisma:L4171`
- `VenueTransaction` → `schema.prisma:L4298`
- `VenueWhatsappActivation` → `schema.prisma:L651`
- `WalletCardDesign` → `schema.prisma:L6986`
- `WalletPass` → `schema.prisma:L6895`
- `WalletPassRegistration` → `schema.prisma:L6953`
- `WebhookEvent` → `schema.prisma:L4397`
- `WebhookSubscription` → `schema.prisma:L5705`
- `WhatsappContactWindow` → `schema.prisma:L669`
- `WhatsappInboundEvent` → `schema.prisma:L689`
- `Zone` → `schema.prisma:L142`
