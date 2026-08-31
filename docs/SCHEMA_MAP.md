# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **355 models / 339 enums / ~17,000 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                            |
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

- `AccountingPeriodLock` → `schema.prisma:L15831`
- `AccountMapping` → `schema.prisma:L15727`
- `ActivityLog` → `schema.prisma:L6623`
- `Aggregator` → `schema.prisma:L14128`
- `AngelPayUserAccount` → `schema.prisma:L5286`
- `AppUpdate` → `schema.prisma:L12308`
- `Area` → `schema.prisma:L3013`
- `AreaTicket` → `schema.prisma:L14622`
- `AreaTicketCheckoutSession` → `schema.prisma:L14744`
- `AreaTicketExternalIncident` → `schema.prisma:L14991`
- `AreaTicketExternalSettlement` → `schema.prisma:L14956`
- `AreaTicketFulfillment` → `schema.prisma:L14820`
- `AreaTicketInventoryReservation` → `schema.prisma:L14715`
- `AreaTicketLine` → `schema.prisma:L14683`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14776`
- `AreaTicketPrintAttempt` → `schema.prisma:L14799`
- `BankStatement` → `schema.prisma:L15601`
- `BankStatementLine` → `schema.prisma:L15622`
- `BillingTaxProfile` → `schema.prisma:L16411`
- `BulkCommandOperation` → `schema.prisma:L9591`
- `CalendarSyncOutbox` → `schema.prisma:L13515`
- `CampaignDelivery` → `schema.prisma:L12466`
- `CashCloseout` → `schema.prisma:L9976`
- `CashDeposit` → `schema.prisma:L12110`
- `CashDrawerEvent` → `schema.prisma:L13965`
- `CashDrawerSession` → `schema.prisma:L13941`
- `CashOutCommissionRate` → `schema.prisma:L16240`
- `CashOutScheduleDay` → `schema.prisma:L16263`
- `CashOutWithdrawal` → `schema.prisma:L16325`
- `CatalogBindingBatch` → `schema.prisma:L11007`
- `CatalogBindingLine` → `schema.prisma:L11043`
- `CatalogBrand` → `schema.prisma:L10460`
- `CatalogClientObservation` → `schema.prisma:L10773`
- `CatalogClientReadinessOverride` → `schema.prisma:L10792`
- `CatalogFamily` → `schema.prisma:L10510`
- `CatalogIdempotencyRecord` → `schema.prisma:L10906`
- `CatalogIdentifier` → `schema.prisma:L10641`
- `CatalogImportBatch` → `schema.prisma:L10949`
- `CatalogImportLine` → `schema.prisma:L10986`
- `CatalogItem` → `schema.prisma:L10543`
- `CatalogItemBusinessType` → `schema.prisma:L10603`
- `CatalogItemPrice` → `schema.prisma:L10691`
- `CatalogManufacturer` → `schema.prisma:L10484`
- `CatalogProductTypeMapping` → `schema.prisma:L10620`
- `CatalogPublicationBatch` → `schema.prisma:L11071`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11165`
- `CatalogPublicationLine` → `schema.prisma:L11112`
- `CatalogPublicationOutbox` → `schema.prisma:L11208`
- `CatalogValidationProfile` → `schema.prisma:L10662`
- `CatalogVenueBinding` → `schema.prisma:L10820`
- `CatalogVenueClientRequirement` → `schema.prisma:L10747`
- `CatalogVenueEventSequence` → `schema.prisma:L11191`
- `CatalogVenueOverride` → `schema.prisma:L10862`
- `CatalogVenueRollout` → `schema.prisma:L10722`
- `Cfdi` → `schema.prisma:L15504`
- `ChatbotTokenBudget` → `schema.prisma:L9239`
- `ChatConversation` → `schema.prisma:L9094`
- `ChatFeedback` → `schema.prisma:L9180`
- `ChatLearningEvent` → `schema.prisma:L9137`
- `ChatMessage` → `schema.prisma:L9117`
- `ChatTrainingData` → `schema.prisma:L9051`
- `CheckoutSession` → `schema.prisma:L5566`
- `ClassSession` → `schema.prisma:L13119`
- `CommissionCalculation` → `schema.prisma:L11886`
- `CommissionClawback` → `schema.prisma:L12062`
- `CommissionConfig` → `schema.prisma:L11652`
- `CommissionMilestone` → `schema.prisma:L11802`
- `CommissionOverride` → `schema.prisma:L11729`
- `CommissionPayout` → `schema.prisma:L12013`
- `CommissionSummary` → `schema.prisma:L11952`
- `CommissionTier` → `schema.prisma:L11766`
- `Consumer` → `schema.prisma:L6785`
- `ConsumerAuthAccount` → `schema.prisma:L6810`
- `CouponCode` → `schema.prisma:L7749`
- `CouponRedemption` → `schema.prisma:L7780`
- `CreditAssessmentHistory` → `schema.prisma:L10085`
- `CreditItemBalance` → `schema.prisma:L13731`
- `CreditOffer` → `schema.prisma:L10104`
- `CreditPack` → `schema.prisma:L13640`
- `CreditPackItem` → `schema.prisma:L13669`
- `CreditPackPurchase` → `schema.prisma:L13686`
- `CreditTransaction` → `schema.prisma:L13753`
- `Customer` → `schema.prisma:L6664`
- `CustomerApprovalDelivery` → `schema.prisma:L8756`
- `CustomerApprovalOutbox` → `schema.prisma:L8731`
- `CustomerDiscount` → `schema.prisma:L7800`
- `CustomerGroup` → `schema.prisma:L6849`
- `CustomerTaxProfile` → `schema.prisma:L15573`
- `DeliveryActivationRequest` → `schema.prisma:L5907`
- `DeliveryChannelLink` → `schema.prisma:L5852`
- `DeliveryOrderEvent` → `schema.prisma:L5931`
- `DeviceToken` → `schema.prisma:L8069`
- `DigitalReceipt` → `schema.prisma:L4269`
- `Discount` → `schema.prisma:L7439`
- `EcommerceMerchant` → `schema.prisma:L5378`
- `EmailTemplate` → `schema.prisma:L12405`
- `Employee` → `schema.prisma:L16088`
- `Estimate` → `schema.prisma:L14035`
- `EstimateItem` → `schema.prisma:L14063`
- `Expense` → `schema.prisma:L15875`
- `ExternalBusyBlock` → `schema.prisma:L13408`
- `Feature` → `schema.prisma:L4398`
- `FeeSchedule` → `schema.prisma:L4476`
- `FeeTier` → `schema.prisma:L4487`
- `FinancialAccount` → `schema.prisma:L14225`
- `FinancialConnection` → `schema.prisma:L14194`
- `FinancialProvider` → `schema.prisma:L14180`
- `FiscalEmisor` → `schema.prisma:L15427`
- `FiscalLossCarryforward` → `schema.prisma:L15998`
- `FixedAsset` → `schema.prisma:L16016`
- `FixedAssetDepreciation` → `schema.prisma:L16045`
- `FloorElement` → `schema.prisma:L3089`
- `FulfillmentArea` → `schema.prisma:L14487`
- `GeofenceRule` → `schema.prisma:L9676`
- `GoogleCalendarChannel` → `schema.prisma:L13385`
- `GoogleCalendarConnection` → `schema.prisma:L13337`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13438`
- `GoogleOAuthSession` → `schema.prisma:L13460`
- `HolidayCalendar` → `schema.prisma:L6547`
- `IdempotencyRequest` → `schema.prisma:L11527`
- `InterVenueTransfer` → `schema.prisma:L2841`
- `InterVenueTransferAllocation` → `schema.prisma:L2924`
- `InterVenueTransferItem` → `schema.prisma:L2893`
- `InterVenueTransferReceipt` → `schema.prisma:L2951`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2967`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2995`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2979`
- `Inventory` → `schema.prisma:L1887`
- `InventoryMovement` → `schema.prisma:L1914`
- `InventoryPosting` → `schema.prisma:L1996`
- `InventoryPostingLine` → `schema.prisma:L2036`
- `InventoryTransfer` → `schema.prisma:L14007`
- `Invitation` → `schema.prisma:L1425`
- `Invoice` → `schema.prisma:L4499`
- `InvoiceItem` → `schema.prisma:L4525`
- `ItemCategory` → `schema.prisma:L11243`
- `JournalEntry` → `schema.prisma:L15785`
- `JournalLine` → `schema.prisma:L15813`
- `KdsOrder` → `schema.prisma:L14273`
- `KdsOrderItem` → `schema.prisma:L14314`
- `KioskCheckInAttempt` → `schema.prisma:L16734`
- `KioskCheckInChallenge` → `schema.prisma:L16688`
- `KioskOutreachOutbox` → `schema.prisma:L16755`
- `LearnedPatterns` → `schema.prisma:L9161`
- `LedgerAccount` → `schema.prisma:L15677`
- `LiveDemoSession` → `schema.prisma:L784`
- `LowStockAlert` → `schema.prisma:L2682`
- `LoyaltyConfig` → `schema.prisma:L6879`
- `LoyaltyTransaction` → `schema.prisma:L6922`
- `MarketingCampaign` → `schema.prisma:L12423`
- `McpAuthCode` → `schema.prisma:L15310`
- `McpOAuthClient` → `schema.prisma:L15294`
- `McpRefreshToken` → `schema.prisma:L15328`
- `McpToolCall` → `schema.prisma:L15349`
- `MeasurementUnit` → `schema.prisma:L14113`
- `Menu` → `schema.prisma:L1611`
- `MenuCategory` → `schema.prisma:L1548`
- `MenuCategoryAssignment` → `schema.prisma:L1646`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15224`
- `MerchantAccount` → `schema.prisma:L5116`
- `MerchantFiscalConfig` → `schema.prisma:L15475`
- `MerchantRevenueShare` → `schema.prisma:L6127`
- `MerchantRoutingRule` → `schema.prisma:L5238`
- `MilestoneAchievement` → `schema.prisma:L11847`
- `Modifier` → `schema.prisma:L3884`
- `ModifierGroup` → `schema.prisma:L3848`
- `Module` → `schema.prisma:L10152`
- `MoneyAnomaly` → `schema.prisma:L6030`
- `MonthlyVenueProfit` → `schema.prisma:L6573`
- `Notification` → `schema.prisma:L7971`
- `NotificationPreference` → `schema.prisma:L8018`
- `NotificationTemplate` → `schema.prisma:L8045`
- `OAuthState` → `schema.prisma:L1476`
- `OnboardingProgress` → `schema.prisma:L1494`
- `Order` → `schema.prisma:L3486`
- `OrderAction` → `schema.prisma:L3949`
- `OrderCustomer` → `schema.prisma:L3699`
- `OrderDiscount` → `schema.prisma:L7832`
- `OrderFulfillment` → `schema.prisma:L14542`
- `OrderFulfillmentLine` → `schema.prisma:L14573`
- `OrderItem` → `schema.prisma:L3715`
- `OrderItemModifier` → `schema.prisma:L3933`
- `OrderPromotion` → `schema.prisma:L16651`
- `OrderServiceCharge` → `schema.prisma:L7916`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12224`
- `OrganizationEntitlement` → `schema.prisma:L10435`
- `OrganizationGoal` → `schema.prisma:L12182`
- `OrganizationModule` → `schema.prisma:L10212`
- `OrganizationPaymentConfig` → `schema.prisma:L5690`
- `OrganizationPayoutConfig` → `schema.prisma:L12257`
- `OrganizationPricingStructure` → `schema.prisma:L5722`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12205`
- `OtpChallenge` → `schema.prisma:L6829`
- `PartnerAPIKey` → `schema.prisma:L5520`
- `Payment` → `schema.prisma:L3982`
- `PaymentAllocation` → `schema.prisma:L4248`
- `PaymentLink` → `schema.prisma:L13799`
- `PaymentLinkAttribution` → `schema.prisma:L13907`
- `PaymentLinkItem` → `schema.prisma:L13862`
- `PaymentLinkItemModifier` → `schema.prisma:L13889`
- `PaymentProvider` → `schema.prisma:L5075`
- `PayrollLine` → `schema.prisma:L16159`
- `PayrollRun` → `schema.prisma:L16128`
- `PerformanceGoal` → `schema.prisma:L12159`
- `PermissionOverride` → `schema.prisma:L1353`
- `PermissionSet` → `schema.prisma:L1376`
- `PlatformAnnouncement` → `schema.prisma:L16815`
- `PlatformAnnouncementClick` → `schema.prisma:L16880`
- `PlatformAnnouncementDelivery` → `schema.prisma:L16917`
- `PlatformCfdi` → `schema.prisma:L16444`
- `PlatformEmisor` → `schema.prisma:L16384`
- `PlatformSettings` → `schema.prisma:L5497`
- `PosCommand` → `schema.prisma:L8099`
- `PosConnectionStatus` → `schema.prisma:L904`
- `PosSyncIntent` → `schema.prisma:L16522`
- `PricingPolicy` → `schema.prisma:L2586`
- `Printer` → `schema.prisma:L14356`
- `PrintGateway` → `schema.prisma:L14409`
- `PrintJob` → `schema.prisma:L15123`
- `PrintStation` → `schema.prisma:L14427`
- `ProcessedStripeEvent` → `schema.prisma:L6016`
- `ProcessorReliabilityMetric` → `schema.prisma:L6501`
- `Product` → `schema.prisma:L1664`
- `ProductModifierGroup` → `schema.prisma:L3921`
- `ProductOption` → `schema.prisma:L14090`
- `ProductOptionValue` → `schema.prisma:L14101`
- `ProductStaff` → `schema.prisma:L13034`
- `PromoterBankAccount` → `schema.prisma:L16279`
- `PromoterCommissionEntry` → `schema.prisma:L16298`
- `PromoterLocationPing` → `schema.prisma:L3452`
- `Promotion` → `schema.prisma:L16573`
- `PromotionGroup` → `schema.prisma:L16612`
- `PromotionOption` → `schema.prisma:L16628`
- `ProviderCostStructure` → `schema.prisma:L6052`
- `ProviderEventLog` → `schema.prisma:L5799`
- `PurchaseOrder` → `schema.prisma:L2311`
- `PurchaseOrderInvoice` → `schema.prisma:L2456`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2513`
- `PurchaseOrderItem` → `schema.prisma:L2369`
- `RateCorrectionBatch` → `schema.prisma:L6277`
- `RateCorrectionEntry` → `schema.prisma:L6319`
- `RawMaterial` → `schema.prisma:L2068`
- `RawMaterialMovement` → `schema.prisma:L2639`
- `RawMaterialPresentation` → `schema.prisma:L2143`
- `Recipe` → `schema.prisma:L2163`
- `RecipeLine` → `schema.prisma:L2187`
- `Referral` → `schema.prisma:L7287`
- `ReferralProgramConfig` → `schema.prisma:L7252`
- `ReferralRewardGrant` → `schema.prisma:L7378`
- `ReferralTierReward` → `schema.prisma:L7350`
- `ReferralTierUnlock` → `schema.prisma:L7423`
- `RefreshGrant` → `schema.prisma:L17004`
- `Reservation` → `schema.prisma:L12802`
- `ReservationGoogleEventMapping` → `schema.prisma:L13572`
- `ReservationModifier` → `schema.prisma:L12982`
- `ReservationReminderSent` → `schema.prisma:L12965`
- `ReservationSettings` → `schema.prisma:L13196`
- `ReservationWaitlistEntry` → `schema.prisma:L13164`
- `Review` → `schema.prisma:L4543`
- `SalesRetention` → `schema.prisma:L15979`
- `SaleVerification` → `schema.prisma:L4302`
- `ScaleProfile` → `schema.prisma:L14864`
- `ScheduledCommand` → `schema.prisma:L9636`
- `SerializedItem` → `schema.prisma:L11286`
- `SerializedItemCustodyEvent` → `schema.prisma:L11450`
- `ServiceCharge` → `schema.prisma:L7887`
- `Session` → `schema.prisma:L16983`
- `SettlementConfiguration` → `schema.prisma:L6352`
- `SettlementConfirmation` → `schema.prisma:L6465`
- `SettlementIncident` → `schema.prisma:L6416`
- `SettlementSimulation` → `schema.prisma:L6387`
- `Shift` → `schema.prisma:L3127`
- `SimRegistrationRequest` → `schema.prisma:L11488`
- `SimRegistrationRequestItem` → `schema.prisma:L11510`
- `SlotHold` → `schema.prisma:L13065`
- `Staff` → `schema.prisma:L924`
- `StaffDocument` → `schema.prisma:L3323`
- `StaffOnboardingState` → `schema.prisma:L15194`
- `StaffOrganization` → `schema.prisma:L1252`
- `StaffPasskey` → `schema.prisma:L1279`
- `StaffSchedule` → `schema.prisma:L13005`
- `StaffScheduleException` → `schema.prisma:L13017`
- `StaffVenue` → `schema.prisma:L1177`
- `StaffWorkSchedule` → `schema.prisma:L3234`
- `StaffWorkScheduleException` → `schema.prisma:L3298`
- `StampCard` → `schema.prisma:L7135`
- `StampEvent` → `schema.prisma:L7174`
- `StampReward` → `schema.prisma:L7212`
- `StockAlertConfig` → `schema.prisma:L12141`
- `StockBatch` → `schema.prisma:L2790`
- `StockCount` → `schema.prisma:L2714`
- `StockCountItem` → `schema.prisma:L2738`
- `StripeWebhookEvent` → `schema.prisma:L5999`
- `Supplier` → `schema.prisma:L2222`
- `SupplierItemCode` → `schema.prisma:L2554`
- `SupplierPricing` → `schema.prisma:L2277`
- `Table` → `schema.prisma:L3039`
- `Terminal` → `schema.prisma:L4594`
- `TerminalHealth` → `schema.prisma:L4845`
- `TerminalLog` → `schema.prisma:L4819`
- `TerminalOrder` → `schema.prisma:L4978`
- `TerminalOrderItem` → `schema.prisma:L5053`
- `TerminalPaymentRequest` → `schema.prisma:L4916`
- `TimeEntry` → `schema.prisma:L3365`
- `TimeEntryBreak` → `schema.prisma:L3434`
- `TokenPurchase` → `schema.prisma:L9310`
- `TokenUsageRecord` → `schema.prisma:L9282`
- `TpvCommandHistory` → `schema.prisma:L9542`
- `TpvCommandQueue` → `schema.prisma:L9482`
- `TpvFeedback` → `schema.prisma:L9195`
- `TpvMessage` → `schema.prisma:L12498`
- `TpvMessageDelivery` → `schema.prisma:L12550`
- `TpvMessageResponse` → `schema.prisma:L12573`
- `TrainingModule` → `schema.prisma:L12628`
- `TrainingProgress` → `schema.prisma:L12705`
- `TrainingQuizQuestion` → `schema.prisma:L12687`
- `TrainingStep` → `schema.prisma:L12667`
- `TransactionCost` → `schema.prisma:L6215`
- `UnitConversion` → `schema.prisma:L2617`
- `UpsellAcceptance` → `schema.prisma:L7708`
- `UpsellAiRun` → `schema.prisma:L7728`
- `UpsellImpression` → `schema.prisma:L7668`
- `UpsellRule` → `schema.prisma:L7588`
- `user_sessions` → `schema.prisma:L5555`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14601`
- `VenueChatMessage` → `schema.prisma:L760`
- `VenueChatSession` → `schema.prisma:L715`
- `VenueCommission` → `schema.prisma:L14251`
- `VenueCreditAssessment` → `schema.prisma:L10024`
- `VenueCryptoConfig` → `schema.prisma:L12365`
- `VenueFeature` → `schema.prisma:L4416`
- `VenueModule` → `schema.prisma:L10184`
- `VenuePaymentConfig` → `schema.prisma:L5656`
- `VenuePaymentLinkSettings` → `schema.prisma:L13605`
- `VenuePricingStructure` → `schema.prisma:L6155`
- `VenueRoleConfig` → `schema.prisma:L1405`
- `VenueRolePermission` → `schema.prisma:L1309`
- `VenueScaleSettings` → `schema.prisma:L14852`
- `VenueSettings` → `schema.prisma:L800`
- `VenueTenderType` → `schema.prisma:L4161`
- `VenueTenderTypeRevision` → `schema.prisma:L4226`
- `VenueTransaction` → `schema.prisma:L4353`
- `VenueWhatsappActivation` → `schema.prisma:L651`
- `WalletCardDesign` → `schema.prisma:L7053`
- `WalletPass` → `schema.prisma:L6962`
- `WalletPassRegistration` → `schema.prisma:L7020`
- `WebhookEvent` → `schema.prisma:L4452`
- `WebhookSubscription` → `schema.prisma:L5772`
- `WhatsappContactWindow` → `schema.prisma:L669`
- `WhatsappInboundEvent` → `schema.prisma:L689`
- `WorkShiftAssignment` → `schema.prisma:L3274`
- `WorkShiftTemplate` → `schema.prisma:L3251`
- `Zone` → `schema.prisma:L142`
