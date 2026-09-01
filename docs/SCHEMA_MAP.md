# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **356 models / 339 enums / ~17,000 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                        |
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

- `AccountingPeriodLock` → `schema.prisma:L15890`
- `AccountMapping` → `schema.prisma:L15786`
- `ActivityLog` → `schema.prisma:L6672`
- `Aggregator` → `schema.prisma:L14183`
- `AngelPayUserAccount` → `schema.prisma:L5335`
- `AppUpdate` → `schema.prisma:L12363`
- `Area` → `schema.prisma:L3026`
- `AreaTicket` → `schema.prisma:L14681`
- `AreaTicketCheckoutSession` → `schema.prisma:L14803`
- `AreaTicketExternalIncident` → `schema.prisma:L15050`
- `AreaTicketExternalSettlement` → `schema.prisma:L15015`
- `AreaTicketFulfillment` → `schema.prisma:L14879`
- `AreaTicketInventoryReservation` → `schema.prisma:L14774`
- `AreaTicketLine` → `schema.prisma:L14742`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14835`
- `AreaTicketPrintAttempt` → `schema.prisma:L14858`
- `BankStatement` → `schema.prisma:L15660`
- `BankStatementLine` → `schema.prisma:L15681`
- `BillingTaxProfile` → `schema.prisma:L16470`
- `BulkCommandOperation` → `schema.prisma:L9643`
- `CalendarSyncOutbox` → `schema.prisma:L13570`
- `CampaignDelivery` → `schema.prisma:L12521`
- `CashCloseout` → `schema.prisma:L10028`
- `CashDeposit` → `schema.prisma:L12165`
- `CashDrawerEvent` → `schema.prisma:L14020`
- `CashDrawerSession` → `schema.prisma:L13996`
- `CashOutCommissionRate` → `schema.prisma:L16299`
- `CashOutScheduleDay` → `schema.prisma:L16322`
- `CashOutWithdrawal` → `schema.prisma:L16384`
- `CatalogBindingBatch` → `schema.prisma:L11059`
- `CatalogBindingLine` → `schema.prisma:L11095`
- `CatalogBrand` → `schema.prisma:L10512`
- `CatalogClientObservation` → `schema.prisma:L10825`
- `CatalogClientReadinessOverride` → `schema.prisma:L10844`
- `CatalogFamily` → `schema.prisma:L10562`
- `CatalogIdempotencyRecord` → `schema.prisma:L10958`
- `CatalogIdentifier` → `schema.prisma:L10693`
- `CatalogImportBatch` → `schema.prisma:L11001`
- `CatalogImportLine` → `schema.prisma:L11038`
- `CatalogItem` → `schema.prisma:L10595`
- `CatalogItemBusinessType` → `schema.prisma:L10655`
- `CatalogItemPrice` → `schema.prisma:L10743`
- `CatalogManufacturer` → `schema.prisma:L10536`
- `CatalogProductTypeMapping` → `schema.prisma:L10672`
- `CatalogPublicationBatch` → `schema.prisma:L11123`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11217`
- `CatalogPublicationLine` → `schema.prisma:L11164`
- `CatalogPublicationOutbox` → `schema.prisma:L11260`
- `CatalogValidationProfile` → `schema.prisma:L10714`
- `CatalogVenueBinding` → `schema.prisma:L10872`
- `CatalogVenueClientRequirement` → `schema.prisma:L10799`
- `CatalogVenueEventSequence` → `schema.prisma:L11243`
- `CatalogVenueOverride` → `schema.prisma:L10914`
- `CatalogVenueRollout` → `schema.prisma:L10774`
- `Cfdi` → `schema.prisma:L15563`
- `ChatbotTokenBudget` → `schema.prisma:L9291`
- `ChatConversation` → `schema.prisma:L9146`
- `ChatFeedback` → `schema.prisma:L9232`
- `ChatLearningEvent` → `schema.prisma:L9189`
- `ChatMessage` → `schema.prisma:L9169`
- `ChatTrainingData` → `schema.prisma:L9103`
- `CheckoutSession` → `schema.prisma:L5615`
- `ClassSession` → `schema.prisma:L13174`
- `CommissionCalculation` → `schema.prisma:L11941`
- `CommissionClawback` → `schema.prisma:L12117`
- `CommissionConfig` → `schema.prisma:L11707`
- `CommissionMilestone` → `schema.prisma:L11857`
- `CommissionOverride` → `schema.prisma:L11784`
- `CommissionPayout` → `schema.prisma:L12068`
- `CommissionSummary` → `schema.prisma:L12007`
- `CommissionTier` → `schema.prisma:L11821`
- `Consumer` → `schema.prisma:L6834`
- `ConsumerAuthAccount` → `schema.prisma:L6859`
- `CouponCode` → `schema.prisma:L7798`
- `CouponRedemption` → `schema.prisma:L7829`
- `CreditAssessmentHistory` → `schema.prisma:L10137`
- `CreditItemBalance` → `schema.prisma:L13786`
- `CreditOffer` → `schema.prisma:L10156`
- `CreditPack` → `schema.prisma:L13695`
- `CreditPackItem` → `schema.prisma:L13724`
- `CreditPackPurchase` → `schema.prisma:L13741`
- `CreditTransaction` → `schema.prisma:L13808`
- `Customer` → `schema.prisma:L6713`
- `CustomerApprovalDelivery` → `schema.prisma:L8805`
- `CustomerApprovalOutbox` → `schema.prisma:L8780`
- `CustomerDiscount` → `schema.prisma:L7849`
- `CustomerGroup` → `schema.prisma:L6898`
- `CustomerTaxProfile` → `schema.prisma:L15632`
- `DeliveryActivationRequest` → `schema.prisma:L5956`
- `DeliveryChannelLink` → `schema.prisma:L5901`
- `DeliveryOrderEvent` → `schema.prisma:L5980`
- `DeviceToken` → `schema.prisma:L8118`
- `DigitalReceipt` → `schema.prisma:L4318`
- `Discount` → `schema.prisma:L7488`
- `EcommerceMerchant` → `schema.prisma:L5427`
- `EmailTemplate` → `schema.prisma:L12460`
- `Employee` → `schema.prisma:L16147`
- `Estimate` → `schema.prisma:L14090`
- `EstimateItem` → `schema.prisma:L14118`
- `Expense` → `schema.prisma:L15934`
- `ExternalBusyBlock` → `schema.prisma:L13463`
- `Feature` → `schema.prisma:L4447`
- `FeeSchedule` → `schema.prisma:L4525`
- `FeeTier` → `schema.prisma:L4536`
- `FinancialAccount` → `schema.prisma:L14280`
- `FinancialConnection` → `schema.prisma:L14249`
- `FinancialProvider` → `schema.prisma:L14235`
- `FiscalEmisor` → `schema.prisma:L15486`
- `FiscalLossCarryforward` → `schema.prisma:L16057`
- `FixedAsset` → `schema.prisma:L16075`
- `FixedAssetDepreciation` → `schema.prisma:L16104`
- `FloorElement` → `schema.prisma:L3102`
- `FulfillmentArea` → `schema.prisma:L14546`
- `GeofenceRule` → `schema.prisma:L9728`
- `GoogleCalendarChannel` → `schema.prisma:L13440`
- `GoogleCalendarConnection` → `schema.prisma:L13392`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13493`
- `GoogleOAuthSession` → `schema.prisma:L13515`
- `HolidayCalendar` → `schema.prisma:L6596`
- `IdempotencyRequest` → `schema.prisma:L11582`
- `InterVenueTransfer` → `schema.prisma:L2854`
- `InterVenueTransferAllocation` → `schema.prisma:L2937`
- `InterVenueTransferItem` → `schema.prisma:L2906`
- `InterVenueTransferReceipt` → `schema.prisma:L2964`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2980`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3008`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2992`
- `Inventory` → `schema.prisma:L1900`
- `InventoryMovement` → `schema.prisma:L1927`
- `InventoryPosting` → `schema.prisma:L2009`
- `InventoryPostingLine` → `schema.prisma:L2049`
- `InventoryTransfer` → `schema.prisma:L14062`
- `Invitation` → `schema.prisma:L1438`
- `Invoice` → `schema.prisma:L4548`
- `InvoiceItem` → `schema.prisma:L4574`
- `ItemCategory` → `schema.prisma:L11295`
- `JournalEntry` → `schema.prisma:L15844`
- `JournalLine` → `schema.prisma:L15872`
- `KdsOrder` → `schema.prisma:L14328`
- `KdsOrderItem` → `schema.prisma:L14369`
- `KioskCheckInAttempt` → `schema.prisma:L16793`
- `KioskCheckInChallenge` → `schema.prisma:L16747`
- `KioskOutreachOutbox` → `schema.prisma:L16814`
- `LearnedPatterns` → `schema.prisma:L9213`
- `LedgerAccount` → `schema.prisma:L15736`
- `LiveDemoSession` → `schema.prisma:L785`
- `LowStockAlert` → `schema.prisma:L2695`
- `LoyaltyConfig` → `schema.prisma:L6928`
- `LoyaltyTransaction` → `schema.prisma:L6971`
- `MarketingCampaign` → `schema.prisma:L12478`
- `McpAuthCode` → `schema.prisma:L15369`
- `McpOAuthClient` → `schema.prisma:L15353`
- `McpRefreshToken` → `schema.prisma:L15387`
- `McpToolCall` → `schema.prisma:L15408`
- `MeasurementUnit` → `schema.prisma:L14168`
- `Menu` → `schema.prisma:L1624`
- `MenuCategory` → `schema.prisma:L1561`
- `MenuCategoryAssignment` → `schema.prisma:L1659`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15283`
- `MerchantAccount` → `schema.prisma:L5165`
- `MerchantFiscalConfig` → `schema.prisma:L15534`
- `MerchantRevenueShare` → `schema.prisma:L6176`
- `MerchantRoutingRule` → `schema.prisma:L5287`
- `MilestoneAchievement` → `schema.prisma:L11902`
- `Modifier` → `schema.prisma:L3931`
- `ModifierGroup` → `schema.prisma:L3895`
- `Module` → `schema.prisma:L10204`
- `MoneyAnomaly` → `schema.prisma:L6079`
- `MonthlyVenueProfit` → `schema.prisma:L6622`
- `Notification` → `schema.prisma:L8020`
- `NotificationPreference` → `schema.prisma:L8067`
- `NotificationTemplate` → `schema.prisma:L8094`
- `OAuthState` → `schema.prisma:L1489`
- `OnboardingProgress` → `schema.prisma:L1507`
- `Order` → `schema.prisma:L3533`
- `OrderAction` → `schema.prisma:L3998`
- `OrderCustomer` → `schema.prisma:L3746`
- `OrderDiscount` → `schema.prisma:L7881`
- `OrderFulfillment` → `schema.prisma:L14601`
- `OrderFulfillmentLine` → `schema.prisma:L14632`
- `OrderItem` → `schema.prisma:L3762`
- `OrderItemModifier` → `schema.prisma:L3980`
- `OrderPromotion` → `schema.prisma:L16710`
- `OrderServiceCharge` → `schema.prisma:L7965`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12279`
- `OrganizationEntitlement` → `schema.prisma:L10487`
- `OrganizationGoal` → `schema.prisma:L12237`
- `OrganizationModule` → `schema.prisma:L10264`
- `OrganizationPaymentConfig` → `schema.prisma:L5739`
- `OrganizationPayoutConfig` → `schema.prisma:L12312`
- `OrganizationPricingStructure` → `schema.prisma:L5771`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12260`
- `OtpChallenge` → `schema.prisma:L6878`
- `OvertimeApproval` → `schema.prisma:L3311`
- `PartnerAPIKey` → `schema.prisma:L5569`
- `Payment` → `schema.prisma:L4031`
- `PaymentAllocation` → `schema.prisma:L4297`
- `PaymentLink` → `schema.prisma:L13854`
- `PaymentLinkAttribution` → `schema.prisma:L13962`
- `PaymentLinkItem` → `schema.prisma:L13917`
- `PaymentLinkItemModifier` → `schema.prisma:L13944`
- `PaymentProvider` → `schema.prisma:L5124`
- `PayrollLine` → `schema.prisma:L16218`
- `PayrollRun` → `schema.prisma:L16187`
- `PerformanceGoal` → `schema.prisma:L12214`
- `PermissionOverride` → `schema.prisma:L1362`
- `PermissionSet` → `schema.prisma:L1385`
- `PlatformAnnouncement` → `schema.prisma:L16874`
- `PlatformAnnouncementClick` → `schema.prisma:L16939`
- `PlatformAnnouncementDelivery` → `schema.prisma:L16976`
- `PlatformCfdi` → `schema.prisma:L16503`
- `PlatformEmisor` → `schema.prisma:L16443`
- `PlatformSettings` → `schema.prisma:L5546`
- `PosCommand` → `schema.prisma:L8148`
- `PosConnectionStatus` → `schema.prisma:L911`
- `PosSyncIntent` → `schema.prisma:L16581`
- `PricingPolicy` → `schema.prisma:L2599`
- `Printer` → `schema.prisma:L14411`
- `PrintGateway` → `schema.prisma:L14468`
- `PrintJob` → `schema.prisma:L15182`
- `PrintStation` → `schema.prisma:L14486`
- `ProcessedStripeEvent` → `schema.prisma:L6065`
- `ProcessorReliabilityMetric` → `schema.prisma:L6550`
- `Product` → `schema.prisma:L1677`
- `ProductModifierGroup` → `schema.prisma:L3968`
- `ProductOption` → `schema.prisma:L14145`
- `ProductOptionValue` → `schema.prisma:L14156`
- `ProductStaff` → `schema.prisma:L13089`
- `PromoterBankAccount` → `schema.prisma:L16338`
- `PromoterCommissionEntry` → `schema.prisma:L16357`
- `PromoterLocationPing` → `schema.prisma:L3499`
- `Promotion` → `schema.prisma:L16632`
- `PromotionGroup` → `schema.prisma:L16671`
- `PromotionOption` → `schema.prisma:L16687`
- `ProviderCostStructure` → `schema.prisma:L6101`
- `ProviderEventLog` → `schema.prisma:L5848`
- `PurchaseOrder` → `schema.prisma:L2324`
- `PurchaseOrderInvoice` → `schema.prisma:L2469`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2526`
- `PurchaseOrderItem` → `schema.prisma:L2382`
- `RateCorrectionBatch` → `schema.prisma:L6326`
- `RateCorrectionEntry` → `schema.prisma:L6368`
- `RawMaterial` → `schema.prisma:L2081`
- `RawMaterialMovement` → `schema.prisma:L2652`
- `RawMaterialPresentation` → `schema.prisma:L2156`
- `Recipe` → `schema.prisma:L2176`
- `RecipeLine` → `schema.prisma:L2200`
- `Referral` → `schema.prisma:L7336`
- `ReferralProgramConfig` → `schema.prisma:L7301`
- `ReferralRewardGrant` → `schema.prisma:L7427`
- `ReferralTierReward` → `schema.prisma:L7399`
- `ReferralTierUnlock` → `schema.prisma:L7472`
- `RefreshGrant` → `schema.prisma:L17063`
- `Reservation` → `schema.prisma:L12857`
- `ReservationGoogleEventMapping` → `schema.prisma:L13627`
- `ReservationModifier` → `schema.prisma:L13037`
- `ReservationReminderSent` → `schema.prisma:L13020`
- `ReservationSettings` → `schema.prisma:L13251`
- `ReservationWaitlistEntry` → `schema.prisma:L13219`
- `Review` → `schema.prisma:L4592`
- `SalesRetention` → `schema.prisma:L16038`
- `SaleVerification` → `schema.prisma:L4351`
- `ScaleProfile` → `schema.prisma:L14923`
- `ScheduledCommand` → `schema.prisma:L9688`
- `SerializedItem` → `schema.prisma:L11338`
- `SerializedItemCustodyEvent` → `schema.prisma:L11505`
- `ServiceCharge` → `schema.prisma:L7936`
- `Session` → `schema.prisma:L17042`
- `SettlementConfiguration` → `schema.prisma:L6401`
- `SettlementConfirmation` → `schema.prisma:L6514`
- `SettlementIncident` → `schema.prisma:L6465`
- `SettlementSimulation` → `schema.prisma:L6436`
- `Shift` → `schema.prisma:L3140`
- `SimRegistrationRequest` → `schema.prisma:L11543`
- `SimRegistrationRequestItem` → `schema.prisma:L11565`
- `SlotHold` → `schema.prisma:L13120`
- `Staff` → `schema.prisma:L931`
- `StaffDocument` → `schema.prisma:L3370`
- `StaffOnboardingState` → `schema.prisma:L15253`
- `StaffOrganization` → `schema.prisma:L1261`
- `StaffPasskey` → `schema.prisma:L1288`
- `StaffSchedule` → `schema.prisma:L13060`
- `StaffScheduleException` → `schema.prisma:L13072`
- `StaffVenue` → `schema.prisma:L1185`
- `StaffWorkSchedule` → `schema.prisma:L3247`
- `StaffWorkScheduleException` → `schema.prisma:L3345`
- `StampCard` → `schema.prisma:L7184`
- `StampEvent` → `schema.prisma:L7223`
- `StampReward` → `schema.prisma:L7261`
- `StockAlertConfig` → `schema.prisma:L12196`
- `StockBatch` → `schema.prisma:L2803`
- `StockCount` → `schema.prisma:L2727`
- `StockCountItem` → `schema.prisma:L2751`
- `StripeWebhookEvent` → `schema.prisma:L6048`
- `Supplier` → `schema.prisma:L2235`
- `SupplierItemCode` → `schema.prisma:L2567`
- `SupplierPricing` → `schema.prisma:L2290`
- `Table` → `schema.prisma:L3052`
- `Terminal` → `schema.prisma:L4643`
- `TerminalHealth` → `schema.prisma:L4894`
- `TerminalLog` → `schema.prisma:L4868`
- `TerminalOrder` → `schema.prisma:L5027`
- `TerminalOrderItem` → `schema.prisma:L5102`
- `TerminalPaymentRequest` → `schema.prisma:L4965`
- `TimeEntry` → `schema.prisma:L3412`
- `TimeEntryBreak` → `schema.prisma:L3481`
- `TokenPurchase` → `schema.prisma:L9362`
- `TokenUsageRecord` → `schema.prisma:L9334`
- `TpvCommandHistory` → `schema.prisma:L9594`
- `TpvCommandQueue` → `schema.prisma:L9534`
- `TpvFeedback` → `schema.prisma:L9247`
- `TpvMessage` → `schema.prisma:L12553`
- `TpvMessageDelivery` → `schema.prisma:L12605`
- `TpvMessageResponse` → `schema.prisma:L12628`
- `TrainingModule` → `schema.prisma:L12683`
- `TrainingProgress` → `schema.prisma:L12760`
- `TrainingQuizQuestion` → `schema.prisma:L12742`
- `TrainingStep` → `schema.prisma:L12722`
- `TransactionCost` → `schema.prisma:L6264`
- `UnitConversion` → `schema.prisma:L2630`
- `UpsellAcceptance` → `schema.prisma:L7757`
- `UpsellAiRun` → `schema.prisma:L7777`
- `UpsellImpression` → `schema.prisma:L7717`
- `UpsellRule` → `schema.prisma:L7637`
- `user_sessions` → `schema.prisma:L5604`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14660`
- `VenueChatMessage` → `schema.prisma:L761`
- `VenueChatSession` → `schema.prisma:L716`
- `VenueCommission` → `schema.prisma:L14306`
- `VenueCreditAssessment` → `schema.prisma:L10076`
- `VenueCryptoConfig` → `schema.prisma:L12420`
- `VenueFeature` → `schema.prisma:L4465`
- `VenueModule` → `schema.prisma:L10236`
- `VenuePaymentConfig` → `schema.prisma:L5705`
- `VenuePaymentLinkSettings` → `schema.prisma:L13660`
- `VenuePricingStructure` → `schema.prisma:L6204`
- `VenueRoleConfig` → `schema.prisma:L1414`
- `VenueRolePermission` → `schema.prisma:L1318`
- `VenueScaleSettings` → `schema.prisma:L14911`
- `VenueSettings` → `schema.prisma:L801`
- `VenueTenderType` → `schema.prisma:L4210`
- `VenueTenderTypeRevision` → `schema.prisma:L4275`
- `VenueTransaction` → `schema.prisma:L4402`
- `VenueWhatsappActivation` → `schema.prisma:L652`
- `WalletCardDesign` → `schema.prisma:L7102`
- `WalletPass` → `schema.prisma:L7011`
- `WalletPassRegistration` → `schema.prisma:L7069`
- `WebhookEvent` → `schema.prisma:L4501`
- `WebhookSubscription` → `schema.prisma:L5821`
- `WhatsappContactWindow` → `schema.prisma:L670`
- `WhatsappInboundEvent` → `schema.prisma:L690`
- `WorkShiftAssignment` → `schema.prisma:L3287`
- `WorkShiftTemplate` → `schema.prisma:L3264`
- `Zone` → `schema.prisma:L142`
