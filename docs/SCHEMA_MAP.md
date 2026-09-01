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

- `AccountingPeriodLock` → `schema.prisma:L15888`
- `AccountMapping` → `schema.prisma:L15784`
- `ActivityLog` → `schema.prisma:L6670`
- `Aggregator` → `schema.prisma:L14181`
- `AngelPayUserAccount` → `schema.prisma:L5333`
- `AppUpdate` → `schema.prisma:L12361`
- `Area` → `schema.prisma:L3026`
- `AreaTicket` → `schema.prisma:L14679`
- `AreaTicketCheckoutSession` → `schema.prisma:L14801`
- `AreaTicketExternalIncident` → `schema.prisma:L15048`
- `AreaTicketExternalSettlement` → `schema.prisma:L15013`
- `AreaTicketFulfillment` → `schema.prisma:L14877`
- `AreaTicketInventoryReservation` → `schema.prisma:L14772`
- `AreaTicketLine` → `schema.prisma:L14740`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14833`
- `AreaTicketPrintAttempt` → `schema.prisma:L14856`
- `BankStatement` → `schema.prisma:L15658`
- `BankStatementLine` → `schema.prisma:L15679`
- `BillingTaxProfile` → `schema.prisma:L16468`
- `BulkCommandOperation` → `schema.prisma:L9641`
- `CalendarSyncOutbox` → `schema.prisma:L13568`
- `CampaignDelivery` → `schema.prisma:L12519`
- `CashCloseout` → `schema.prisma:L10026`
- `CashDeposit` → `schema.prisma:L12163`
- `CashDrawerEvent` → `schema.prisma:L14018`
- `CashDrawerSession` → `schema.prisma:L13994`
- `CashOutCommissionRate` → `schema.prisma:L16297`
- `CashOutScheduleDay` → `schema.prisma:L16320`
- `CashOutWithdrawal` → `schema.prisma:L16382`
- `CatalogBindingBatch` → `schema.prisma:L11057`
- `CatalogBindingLine` → `schema.prisma:L11093`
- `CatalogBrand` → `schema.prisma:L10510`
- `CatalogClientObservation` → `schema.prisma:L10823`
- `CatalogClientReadinessOverride` → `schema.prisma:L10842`
- `CatalogFamily` → `schema.prisma:L10560`
- `CatalogIdempotencyRecord` → `schema.prisma:L10956`
- `CatalogIdentifier` → `schema.prisma:L10691`
- `CatalogImportBatch` → `schema.prisma:L10999`
- `CatalogImportLine` → `schema.prisma:L11036`
- `CatalogItem` → `schema.prisma:L10593`
- `CatalogItemBusinessType` → `schema.prisma:L10653`
- `CatalogItemPrice` → `schema.prisma:L10741`
- `CatalogManufacturer` → `schema.prisma:L10534`
- `CatalogProductTypeMapping` → `schema.prisma:L10670`
- `CatalogPublicationBatch` → `schema.prisma:L11121`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11215`
- `CatalogPublicationLine` → `schema.prisma:L11162`
- `CatalogPublicationOutbox` → `schema.prisma:L11258`
- `CatalogValidationProfile` → `schema.prisma:L10712`
- `CatalogVenueBinding` → `schema.prisma:L10870`
- `CatalogVenueClientRequirement` → `schema.prisma:L10797`
- `CatalogVenueEventSequence` → `schema.prisma:L11241`
- `CatalogVenueOverride` → `schema.prisma:L10912`
- `CatalogVenueRollout` → `schema.prisma:L10772`
- `Cfdi` → `schema.prisma:L15561`
- `ChatbotTokenBudget` → `schema.prisma:L9289`
- `ChatConversation` → `schema.prisma:L9144`
- `ChatFeedback` → `schema.prisma:L9230`
- `ChatLearningEvent` → `schema.prisma:L9187`
- `ChatMessage` → `schema.prisma:L9167`
- `ChatTrainingData` → `schema.prisma:L9101`
- `CheckoutSession` → `schema.prisma:L5613`
- `ClassSession` → `schema.prisma:L13172`
- `CommissionCalculation` → `schema.prisma:L11939`
- `CommissionClawback` → `schema.prisma:L12115`
- `CommissionConfig` → `schema.prisma:L11705`
- `CommissionMilestone` → `schema.prisma:L11855`
- `CommissionOverride` → `schema.prisma:L11782`
- `CommissionPayout` → `schema.prisma:L12066`
- `CommissionSummary` → `schema.prisma:L12005`
- `CommissionTier` → `schema.prisma:L11819`
- `Consumer` → `schema.prisma:L6832`
- `ConsumerAuthAccount` → `schema.prisma:L6857`
- `CouponCode` → `schema.prisma:L7796`
- `CouponRedemption` → `schema.prisma:L7827`
- `CreditAssessmentHistory` → `schema.prisma:L10135`
- `CreditItemBalance` → `schema.prisma:L13784`
- `CreditOffer` → `schema.prisma:L10154`
- `CreditPack` → `schema.prisma:L13693`
- `CreditPackItem` → `schema.prisma:L13722`
- `CreditPackPurchase` → `schema.prisma:L13739`
- `CreditTransaction` → `schema.prisma:L13806`
- `Customer` → `schema.prisma:L6711`
- `CustomerApprovalDelivery` → `schema.prisma:L8803`
- `CustomerApprovalOutbox` → `schema.prisma:L8778`
- `CustomerDiscount` → `schema.prisma:L7847`
- `CustomerGroup` → `schema.prisma:L6896`
- `CustomerTaxProfile` → `schema.prisma:L15630`
- `DeliveryActivationRequest` → `schema.prisma:L5954`
- `DeliveryChannelLink` → `schema.prisma:L5899`
- `DeliveryOrderEvent` → `schema.prisma:L5978`
- `DeviceToken` → `schema.prisma:L8116`
- `DigitalReceipt` → `schema.prisma:L4316`
- `Discount` → `schema.prisma:L7486`
- `EcommerceMerchant` → `schema.prisma:L5425`
- `EmailTemplate` → `schema.prisma:L12458`
- `Employee` → `schema.prisma:L16145`
- `Estimate` → `schema.prisma:L14088`
- `EstimateItem` → `schema.prisma:L14116`
- `Expense` → `schema.prisma:L15932`
- `ExternalBusyBlock` → `schema.prisma:L13461`
- `Feature` → `schema.prisma:L4445`
- `FeeSchedule` → `schema.prisma:L4523`
- `FeeTier` → `schema.prisma:L4534`
- `FinancialAccount` → `schema.prisma:L14278`
- `FinancialConnection` → `schema.prisma:L14247`
- `FinancialProvider` → `schema.prisma:L14233`
- `FiscalEmisor` → `schema.prisma:L15484`
- `FiscalLossCarryforward` → `schema.prisma:L16055`
- `FixedAsset` → `schema.prisma:L16073`
- `FixedAssetDepreciation` → `schema.prisma:L16102`
- `FloorElement` → `schema.prisma:L3102`
- `FulfillmentArea` → `schema.prisma:L14544`
- `GeofenceRule` → `schema.prisma:L9726`
- `GoogleCalendarChannel` → `schema.prisma:L13438`
- `GoogleCalendarConnection` → `schema.prisma:L13390`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13491`
- `GoogleOAuthSession` → `schema.prisma:L13513`
- `HolidayCalendar` → `schema.prisma:L6594`
- `IdempotencyRequest` → `schema.prisma:L11580`
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
- `InventoryTransfer` → `schema.prisma:L14060`
- `Invitation` → `schema.prisma:L1438`
- `Invoice` → `schema.prisma:L4546`
- `InvoiceItem` → `schema.prisma:L4572`
- `ItemCategory` → `schema.prisma:L11293`
- `JournalEntry` → `schema.prisma:L15842`
- `JournalLine` → `schema.prisma:L15870`
- `KdsOrder` → `schema.prisma:L14326`
- `KdsOrderItem` → `schema.prisma:L14367`
- `KioskCheckInAttempt` → `schema.prisma:L16791`
- `KioskCheckInChallenge` → `schema.prisma:L16745`
- `KioskOutreachOutbox` → `schema.prisma:L16812`
- `LearnedPatterns` → `schema.prisma:L9211`
- `LedgerAccount` → `schema.prisma:L15734`
- `LiveDemoSession` → `schema.prisma:L785`
- `LowStockAlert` → `schema.prisma:L2695`
- `LoyaltyConfig` → `schema.prisma:L6926`
- `LoyaltyTransaction` → `schema.prisma:L6969`
- `MarketingCampaign` → `schema.prisma:L12476`
- `McpAuthCode` → `schema.prisma:L15367`
- `McpOAuthClient` → `schema.prisma:L15351`
- `McpRefreshToken` → `schema.prisma:L15385`
- `McpToolCall` → `schema.prisma:L15406`
- `MeasurementUnit` → `schema.prisma:L14166`
- `Menu` → `schema.prisma:L1624`
- `MenuCategory` → `schema.prisma:L1561`
- `MenuCategoryAssignment` → `schema.prisma:L1659`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15281`
- `MerchantAccount` → `schema.prisma:L5163`
- `MerchantFiscalConfig` → `schema.prisma:L15532`
- `MerchantRevenueShare` → `schema.prisma:L6174`
- `MerchantRoutingRule` → `schema.prisma:L5285`
- `MilestoneAchievement` → `schema.prisma:L11900`
- `Modifier` → `schema.prisma:L3931`
- `ModifierGroup` → `schema.prisma:L3895`
- `Module` → `schema.prisma:L10202`
- `MoneyAnomaly` → `schema.prisma:L6077`
- `MonthlyVenueProfit` → `schema.prisma:L6620`
- `Notification` → `schema.prisma:L8018`
- `NotificationPreference` → `schema.prisma:L8065`
- `NotificationTemplate` → `schema.prisma:L8092`
- `OAuthState` → `schema.prisma:L1489`
- `OnboardingProgress` → `schema.prisma:L1507`
- `Order` → `schema.prisma:L3533`
- `OrderAction` → `schema.prisma:L3996`
- `OrderCustomer` → `schema.prisma:L3746`
- `OrderDiscount` → `schema.prisma:L7879`
- `OrderFulfillment` → `schema.prisma:L14599`
- `OrderFulfillmentLine` → `schema.prisma:L14630`
- `OrderItem` → `schema.prisma:L3762`
- `OrderItemModifier` → `schema.prisma:L3980`
- `OrderPromotion` → `schema.prisma:L16708`
- `OrderServiceCharge` → `schema.prisma:L7963`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12277`
- `OrganizationEntitlement` → `schema.prisma:L10485`
- `OrganizationGoal` → `schema.prisma:L12235`
- `OrganizationModule` → `schema.prisma:L10262`
- `OrganizationPaymentConfig` → `schema.prisma:L5737`
- `OrganizationPayoutConfig` → `schema.prisma:L12310`
- `OrganizationPricingStructure` → `schema.prisma:L5769`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12258`
- `OtpChallenge` → `schema.prisma:L6876`
- `OvertimeApproval` → `schema.prisma:L3311`
- `PartnerAPIKey` → `schema.prisma:L5567`
- `Payment` → `schema.prisma:L4029`
- `PaymentAllocation` → `schema.prisma:L4295`
- `PaymentLink` → `schema.prisma:L13852`
- `PaymentLinkAttribution` → `schema.prisma:L13960`
- `PaymentLinkItem` → `schema.prisma:L13915`
- `PaymentLinkItemModifier` → `schema.prisma:L13942`
- `PaymentProvider` → `schema.prisma:L5122`
- `PayrollLine` → `schema.prisma:L16216`
- `PayrollRun` → `schema.prisma:L16185`
- `PerformanceGoal` → `schema.prisma:L12212`
- `PermissionOverride` → `schema.prisma:L1362`
- `PermissionSet` → `schema.prisma:L1385`
- `PlatformAnnouncement` → `schema.prisma:L16872`
- `PlatformAnnouncementClick` → `schema.prisma:L16937`
- `PlatformAnnouncementDelivery` → `schema.prisma:L16974`
- `PlatformCfdi` → `schema.prisma:L16501`
- `PlatformEmisor` → `schema.prisma:L16441`
- `PlatformSettings` → `schema.prisma:L5544`
- `PosCommand` → `schema.prisma:L8146`
- `PosConnectionStatus` → `schema.prisma:L911`
- `PosSyncIntent` → `schema.prisma:L16579`
- `PricingPolicy` → `schema.prisma:L2599`
- `Printer` → `schema.prisma:L14409`
- `PrintGateway` → `schema.prisma:L14466`
- `PrintJob` → `schema.prisma:L15180`
- `PrintStation` → `schema.prisma:L14484`
- `ProcessedStripeEvent` → `schema.prisma:L6063`
- `ProcessorReliabilityMetric` → `schema.prisma:L6548`
- `Product` → `schema.prisma:L1677`
- `ProductModifierGroup` → `schema.prisma:L3968`
- `ProductOption` → `schema.prisma:L14143`
- `ProductOptionValue` → `schema.prisma:L14154`
- `ProductStaff` → `schema.prisma:L13087`
- `PromoterBankAccount` → `schema.prisma:L16336`
- `PromoterCommissionEntry` → `schema.prisma:L16355`
- `PromoterLocationPing` → `schema.prisma:L3499`
- `Promotion` → `schema.prisma:L16630`
- `PromotionGroup` → `schema.prisma:L16669`
- `PromotionOption` → `schema.prisma:L16685`
- `ProviderCostStructure` → `schema.prisma:L6099`
- `ProviderEventLog` → `schema.prisma:L5846`
- `PurchaseOrder` → `schema.prisma:L2324`
- `PurchaseOrderInvoice` → `schema.prisma:L2469`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2526`
- `PurchaseOrderItem` → `schema.prisma:L2382`
- `RateCorrectionBatch` → `schema.prisma:L6324`
- `RateCorrectionEntry` → `schema.prisma:L6366`
- `RawMaterial` → `schema.prisma:L2081`
- `RawMaterialMovement` → `schema.prisma:L2652`
- `RawMaterialPresentation` → `schema.prisma:L2156`
- `Recipe` → `schema.prisma:L2176`
- `RecipeLine` → `schema.prisma:L2200`
- `Referral` → `schema.prisma:L7334`
- `ReferralProgramConfig` → `schema.prisma:L7299`
- `ReferralRewardGrant` → `schema.prisma:L7425`
- `ReferralTierReward` → `schema.prisma:L7397`
- `ReferralTierUnlock` → `schema.prisma:L7470`
- `RefreshGrant` → `schema.prisma:L17061`
- `Reservation` → `schema.prisma:L12855`
- `ReservationGoogleEventMapping` → `schema.prisma:L13625`
- `ReservationModifier` → `schema.prisma:L13035`
- `ReservationReminderSent` → `schema.prisma:L13018`
- `ReservationSettings` → `schema.prisma:L13249`
- `ReservationWaitlistEntry` → `schema.prisma:L13217`
- `Review` → `schema.prisma:L4590`
- `SalesRetention` → `schema.prisma:L16036`
- `SaleVerification` → `schema.prisma:L4349`
- `ScaleProfile` → `schema.prisma:L14921`
- `ScheduledCommand` → `schema.prisma:L9686`
- `SerializedItem` → `schema.prisma:L11336`
- `SerializedItemCustodyEvent` → `schema.prisma:L11503`
- `ServiceCharge` → `schema.prisma:L7934`
- `Session` → `schema.prisma:L17040`
- `SettlementConfiguration` → `schema.prisma:L6399`
- `SettlementConfirmation` → `schema.prisma:L6512`
- `SettlementIncident` → `schema.prisma:L6463`
- `SettlementSimulation` → `schema.prisma:L6434`
- `Shift` → `schema.prisma:L3140`
- `SimRegistrationRequest` → `schema.prisma:L11541`
- `SimRegistrationRequestItem` → `schema.prisma:L11563`
- `SlotHold` → `schema.prisma:L13118`
- `Staff` → `schema.prisma:L931`
- `StaffDocument` → `schema.prisma:L3370`
- `StaffOnboardingState` → `schema.prisma:L15251`
- `StaffOrganization` → `schema.prisma:L1261`
- `StaffPasskey` → `schema.prisma:L1288`
- `StaffSchedule` → `schema.prisma:L13058`
- `StaffScheduleException` → `schema.prisma:L13070`
- `StaffVenue` → `schema.prisma:L1185`
- `StaffWorkSchedule` → `schema.prisma:L3247`
- `StaffWorkScheduleException` → `schema.prisma:L3345`
- `StampCard` → `schema.prisma:L7182`
- `StampEvent` → `schema.prisma:L7221`
- `StampReward` → `schema.prisma:L7259`
- `StockAlertConfig` → `schema.prisma:L12194`
- `StockBatch` → `schema.prisma:L2803`
- `StockCount` → `schema.prisma:L2727`
- `StockCountItem` → `schema.prisma:L2751`
- `StripeWebhookEvent` → `schema.prisma:L6046`
- `Supplier` → `schema.prisma:L2235`
- `SupplierItemCode` → `schema.prisma:L2567`
- `SupplierPricing` → `schema.prisma:L2290`
- `Table` → `schema.prisma:L3052`
- `Terminal` → `schema.prisma:L4641`
- `TerminalHealth` → `schema.prisma:L4892`
- `TerminalLog` → `schema.prisma:L4866`
- `TerminalOrder` → `schema.prisma:L5025`
- `TerminalOrderItem` → `schema.prisma:L5100`
- `TerminalPaymentRequest` → `schema.prisma:L4963`
- `TimeEntry` → `schema.prisma:L3412`
- `TimeEntryBreak` → `schema.prisma:L3481`
- `TokenPurchase` → `schema.prisma:L9360`
- `TokenUsageRecord` → `schema.prisma:L9332`
- `TpvCommandHistory` → `schema.prisma:L9592`
- `TpvCommandQueue` → `schema.prisma:L9532`
- `TpvFeedback` → `schema.prisma:L9245`
- `TpvMessage` → `schema.prisma:L12551`
- `TpvMessageDelivery` → `schema.prisma:L12603`
- `TpvMessageResponse` → `schema.prisma:L12626`
- `TrainingModule` → `schema.prisma:L12681`
- `TrainingProgress` → `schema.prisma:L12758`
- `TrainingQuizQuestion` → `schema.prisma:L12740`
- `TrainingStep` → `schema.prisma:L12720`
- `TransactionCost` → `schema.prisma:L6262`
- `UnitConversion` → `schema.prisma:L2630`
- `UpsellAcceptance` → `schema.prisma:L7755`
- `UpsellAiRun` → `schema.prisma:L7775`
- `UpsellImpression` → `schema.prisma:L7715`
- `UpsellRule` → `schema.prisma:L7635`
- `user_sessions` → `schema.prisma:L5602`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14658`
- `VenueChatMessage` → `schema.prisma:L761`
- `VenueChatSession` → `schema.prisma:L716`
- `VenueCommission` → `schema.prisma:L14304`
- `VenueCreditAssessment` → `schema.prisma:L10074`
- `VenueCryptoConfig` → `schema.prisma:L12418`
- `VenueFeature` → `schema.prisma:L4463`
- `VenueModule` → `schema.prisma:L10234`
- `VenuePaymentConfig` → `schema.prisma:L5703`
- `VenuePaymentLinkSettings` → `schema.prisma:L13658`
- `VenuePricingStructure` → `schema.prisma:L6202`
- `VenueRoleConfig` → `schema.prisma:L1414`
- `VenueRolePermission` → `schema.prisma:L1318`
- `VenueScaleSettings` → `schema.prisma:L14909`
- `VenueSettings` → `schema.prisma:L801`
- `VenueTenderType` → `schema.prisma:L4208`
- `VenueTenderTypeRevision` → `schema.prisma:L4273`
- `VenueTransaction` → `schema.prisma:L4400`
- `VenueWhatsappActivation` → `schema.prisma:L652`
- `WalletCardDesign` → `schema.prisma:L7100`
- `WalletPass` → `schema.prisma:L7009`
- `WalletPassRegistration` → `schema.prisma:L7067`
- `WebhookEvent` → `schema.prisma:L4499`
- `WebhookSubscription` → `schema.prisma:L5819`
- `WhatsappContactWindow` → `schema.prisma:L670`
- `WhatsappInboundEvent` → `schema.prisma:L690`
- `WorkShiftAssignment` → `schema.prisma:L3287`
- `WorkShiftTemplate` → `schema.prisma:L3264`
- `Zone` → `schema.prisma:L142`
