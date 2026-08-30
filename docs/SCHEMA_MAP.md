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

- `AccountingPeriodLock` → `schema.prisma:L15865`
- `AccountMapping` → `schema.prisma:L15761`
- `ActivityLog` → `schema.prisma:L6654`
- `Aggregator` → `schema.prisma:L14162`
- `AngelPayUserAccount` → `schema.prisma:L5317`
- `AppUpdate` → `schema.prisma:L12342`
- `Area` → `schema.prisma:L3022`
- `AreaTicket` → `schema.prisma:L14656`
- `AreaTicketCheckoutSession` → `schema.prisma:L14778`
- `AreaTicketExternalIncident` → `schema.prisma:L15025`
- `AreaTicketExternalSettlement` → `schema.prisma:L14990`
- `AreaTicketFulfillment` → `schema.prisma:L14854`
- `AreaTicketInventoryReservation` → `schema.prisma:L14749`
- `AreaTicketLine` → `schema.prisma:L14717`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14810`
- `AreaTicketPrintAttempt` → `schema.prisma:L14833`
- `BankStatement` → `schema.prisma:L15635`
- `BankStatementLine` → `schema.prisma:L15656`
- `BillingTaxProfile` → `schema.prisma:L16445`
- `BulkCommandOperation` → `schema.prisma:L9625`
- `CalendarSyncOutbox` → `schema.prisma:L13549`
- `CampaignDelivery` → `schema.prisma:L12500`
- `CashCloseout` → `schema.prisma:L10010`
- `CashDeposit` → `schema.prisma:L12144`
- `CashDrawerEvent` → `schema.prisma:L13999`
- `CashDrawerSession` → `schema.prisma:L13975`
- `CashOutCommissionRate` → `schema.prisma:L16274`
- `CashOutScheduleDay` → `schema.prisma:L16297`
- `CashOutWithdrawal` → `schema.prisma:L16359`
- `CatalogBindingBatch` → `schema.prisma:L11041`
- `CatalogBindingLine` → `schema.prisma:L11077`
- `CatalogBrand` → `schema.prisma:L10494`
- `CatalogClientObservation` → `schema.prisma:L10807`
- `CatalogClientReadinessOverride` → `schema.prisma:L10826`
- `CatalogFamily` → `schema.prisma:L10544`
- `CatalogIdempotencyRecord` → `schema.prisma:L10940`
- `CatalogIdentifier` → `schema.prisma:L10675`
- `CatalogImportBatch` → `schema.prisma:L10983`
- `CatalogImportLine` → `schema.prisma:L11020`
- `CatalogItem` → `schema.prisma:L10577`
- `CatalogItemBusinessType` → `schema.prisma:L10637`
- `CatalogItemPrice` → `schema.prisma:L10725`
- `CatalogManufacturer` → `schema.prisma:L10518`
- `CatalogProductTypeMapping` → `schema.prisma:L10654`
- `CatalogPublicationBatch` → `schema.prisma:L11105`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11199`
- `CatalogPublicationLine` → `schema.prisma:L11146`
- `CatalogPublicationOutbox` → `schema.prisma:L11242`
- `CatalogValidationProfile` → `schema.prisma:L10696`
- `CatalogVenueBinding` → `schema.prisma:L10854`
- `CatalogVenueClientRequirement` → `schema.prisma:L10781`
- `CatalogVenueEventSequence` → `schema.prisma:L11225`
- `CatalogVenueOverride` → `schema.prisma:L10896`
- `CatalogVenueRollout` → `schema.prisma:L10756`
- `Cfdi` → `schema.prisma:L15538`
- `ChatbotTokenBudget` → `schema.prisma:L9273`
- `ChatConversation` → `schema.prisma:L9128`
- `ChatFeedback` → `schema.prisma:L9214`
- `ChatLearningEvent` → `schema.prisma:L9171`
- `ChatMessage` → `schema.prisma:L9151`
- `ChatTrainingData` → `schema.prisma:L9085`
- `CheckoutSession` → `schema.prisma:L5597`
- `ClassSession` → `schema.prisma:L13153`
- `CommissionCalculation` → `schema.prisma:L11920`
- `CommissionClawback` → `schema.prisma:L12096`
- `CommissionConfig` → `schema.prisma:L11686`
- `CommissionMilestone` → `schema.prisma:L11836`
- `CommissionOverride` → `schema.prisma:L11763`
- `CommissionPayout` → `schema.prisma:L12047`
- `CommissionSummary` → `schema.prisma:L11986`
- `CommissionTier` → `schema.prisma:L11800`
- `Consumer` → `schema.prisma:L6816`
- `ConsumerAuthAccount` → `schema.prisma:L6841`
- `CouponCode` → `schema.prisma:L7780`
- `CouponRedemption` → `schema.prisma:L7811`
- `CreditAssessmentHistory` → `schema.prisma:L10119`
- `CreditItemBalance` → `schema.prisma:L13765`
- `CreditOffer` → `schema.prisma:L10138`
- `CreditPack` → `schema.prisma:L13674`
- `CreditPackItem` → `schema.prisma:L13703`
- `CreditPackPurchase` → `schema.prisma:L13720`
- `CreditTransaction` → `schema.prisma:L13787`
- `Customer` → `schema.prisma:L6695`
- `CustomerApprovalDelivery` → `schema.prisma:L8787`
- `CustomerApprovalOutbox` → `schema.prisma:L8762`
- `CustomerDiscount` → `schema.prisma:L7831`
- `CustomerGroup` → `schema.prisma:L6880`
- `CustomerTaxProfile` → `schema.prisma:L15607`
- `DeliveryActivationRequest` → `schema.prisma:L5938`
- `DeliveryChannelLink` → `schema.prisma:L5883`
- `DeliveryOrderEvent` → `schema.prisma:L5962`
- `DeviceToken` → `schema.prisma:L8100`
- `DigitalReceipt` → `schema.prisma:L4312`
- `Discount` → `schema.prisma:L7470`
- `EcommerceMerchant` → `schema.prisma:L5409`
- `EmailTemplate` → `schema.prisma:L12439`
- `Employee` → `schema.prisma:L16122`
- `Estimate` → `schema.prisma:L14069`
- `EstimateItem` → `schema.prisma:L14097`
- `Expense` → `schema.prisma:L15909`
- `ExternalBusyBlock` → `schema.prisma:L13442`
- `Feature` → `schema.prisma:L4441`
- `FeeSchedule` → `schema.prisma:L4519`
- `FeeTier` → `schema.prisma:L4530`
- `FinancialAccount` → `schema.prisma:L14259`
- `FinancialConnection` → `schema.prisma:L14228`
- `FinancialProvider` → `schema.prisma:L14214`
- `FiscalEmisor` → `schema.prisma:L15461`
- `FiscalLossCarryforward` → `schema.prisma:L16032`
- `FixedAsset` → `schema.prisma:L16050`
- `FixedAssetDepreciation` → `schema.prisma:L16079`
- `FloorElement` → `schema.prisma:L3098`
- `FulfillmentArea` → `schema.prisma:L14521`
- `GeofenceRule` → `schema.prisma:L9710`
- `GoogleCalendarChannel` → `schema.prisma:L13419`
- `GoogleCalendarConnection` → `schema.prisma:L13371`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13472`
- `GoogleOAuthSession` → `schema.prisma:L13494`
- `HolidayCalendar` → `schema.prisma:L6578`
- `IdempotencyRequest` → `schema.prisma:L11561`
- `InterVenueTransfer` → `schema.prisma:L2850`
- `InterVenueTransferAllocation` → `schema.prisma:L2933`
- `InterVenueTransferItem` → `schema.prisma:L2902`
- `InterVenueTransferReceipt` → `schema.prisma:L2960`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2976`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3004`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2988`
- `Inventory` → `schema.prisma:L1896`
- `InventoryMovement` → `schema.prisma:L1923`
- `InventoryPosting` → `schema.prisma:L2005`
- `InventoryPostingLine` → `schema.prisma:L2045`
- `InventoryTransfer` → `schema.prisma:L14041`
- `Invitation` → `schema.prisma:L1434`
- `Invoice` → `schema.prisma:L4542`
- `InvoiceItem` → `schema.prisma:L4568`
- `ItemCategory` → `schema.prisma:L11277`
- `JournalEntry` → `schema.prisma:L15819`
- `JournalLine` → `schema.prisma:L15847`
- `KdsOrder` → `schema.prisma:L14307`
- `KdsOrderItem` → `schema.prisma:L14348`
- `KioskCheckInAttempt` → `schema.prisma:L16768`
- `KioskCheckInChallenge` → `schema.prisma:L16722`
- `KioskOutreachOutbox` → `schema.prisma:L16789`
- `LearnedPatterns` → `schema.prisma:L9195`
- `LedgerAccount` → `schema.prisma:L15711`
- `LiveDemoSession` → `schema.prisma:L785`
- `LowStockAlert` → `schema.prisma:L2691`
- `LoyaltyConfig` → `schema.prisma:L6910`
- `LoyaltyTransaction` → `schema.prisma:L6953`
- `MarketingCampaign` → `schema.prisma:L12457`
- `McpAuthCode` → `schema.prisma:L15344`
- `McpOAuthClient` → `schema.prisma:L15328`
- `McpRefreshToken` → `schema.prisma:L15362`
- `McpToolCall` → `schema.prisma:L15383`
- `MeasurementUnit` → `schema.prisma:L14147`
- `Menu` → `schema.prisma:L1620`
- `MenuCategory` → `schema.prisma:L1557`
- `MenuCategoryAssignment` → `schema.prisma:L1655`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15258`
- `MerchantAccount` → `schema.prisma:L5147`
- `MerchantFiscalConfig` → `schema.prisma:L15509`
- `MerchantRevenueShare` → `schema.prisma:L6158`
- `MerchantRoutingRule` → `schema.prisma:L5269`
- `MilestoneAchievement` → `schema.prisma:L11881`
- `Modifier` → `schema.prisma:L3927`
- `ModifierGroup` → `schema.prisma:L3891`
- `Module` → `schema.prisma:L10186`
- `MoneyAnomaly` → `schema.prisma:L6061`
- `MonthlyVenueProfit` → `schema.prisma:L6604`
- `Notification` → `schema.prisma:L8002`
- `NotificationPreference` → `schema.prisma:L8049`
- `NotificationTemplate` → `schema.prisma:L8076`
- `OAuthState` → `schema.prisma:L1485`
- `OnboardingProgress` → `schema.prisma:L1503`
- `Order` → `schema.prisma:L3529`
- `OrderAction` → `schema.prisma:L3992`
- `OrderCustomer` → `schema.prisma:L3742`
- `OrderDiscount` → `schema.prisma:L7863`
- `OrderFulfillment` → `schema.prisma:L14576`
- `OrderFulfillmentLine` → `schema.prisma:L14607`
- `OrderItem` → `schema.prisma:L3758`
- `OrderItemModifier` → `schema.prisma:L3976`
- `OrderPromotion` → `schema.prisma:L16685`
- `OrderServiceCharge` → `schema.prisma:L7947`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12258`
- `OrganizationEntitlement` → `schema.prisma:L10469`
- `OrganizationGoal` → `schema.prisma:L12216`
- `OrganizationModule` → `schema.prisma:L10246`
- `OrganizationPaymentConfig` → `schema.prisma:L5721`
- `OrganizationPayoutConfig` → `schema.prisma:L12291`
- `OrganizationPricingStructure` → `schema.prisma:L5753`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12239`
- `OtpChallenge` → `schema.prisma:L6860`
- `OvertimeApproval` → `schema.prisma:L3307`
- `PartnerAPIKey` → `schema.prisma:L5551`
- `Payment` → `schema.prisma:L4025`
- `PaymentAllocation` → `schema.prisma:L4291`
- `PaymentLink` → `schema.prisma:L13833`
- `PaymentLinkAttribution` → `schema.prisma:L13941`
- `PaymentLinkItem` → `schema.prisma:L13896`
- `PaymentLinkItemModifier` → `schema.prisma:L13923`
- `PaymentProvider` → `schema.prisma:L5106`
- `PayrollLine` → `schema.prisma:L16193`
- `PayrollRun` → `schema.prisma:L16162`
- `PerformanceGoal` → `schema.prisma:L12193`
- `PermissionOverride` → `schema.prisma:L1362`
- `PermissionSet` → `schema.prisma:L1385`
- `PlatformAnnouncement` → `schema.prisma:L16849`
- `PlatformAnnouncementClick` → `schema.prisma:L16914`
- `PlatformAnnouncementDelivery` → `schema.prisma:L16951`
- `PlatformCfdi` → `schema.prisma:L16478`
- `PlatformEmisor` → `schema.prisma:L16418`
- `PlatformSettings` → `schema.prisma:L5528`
- `PosCommand` → `schema.prisma:L8130`
- `PosConnectionStatus` → `schema.prisma:L911`
- `PosSyncIntent` → `schema.prisma:L16556`
- `PricingPolicy` → `schema.prisma:L2595`
- `Printer` → `schema.prisma:L14390`
- `PrintGateway` → `schema.prisma:L14443`
- `PrintJob` → `schema.prisma:L15157`
- `PrintStation` → `schema.prisma:L14461`
- `ProcessedStripeEvent` → `schema.prisma:L6047`
- `ProcessorReliabilityMetric` → `schema.prisma:L6532`
- `Product` → `schema.prisma:L1673`
- `ProductModifierGroup` → `schema.prisma:L3964`
- `ProductOption` → `schema.prisma:L14124`
- `ProductOptionValue` → `schema.prisma:L14135`
- `ProductStaff` → `schema.prisma:L13068`
- `PromoterBankAccount` → `schema.prisma:L16313`
- `PromoterCommissionEntry` → `schema.prisma:L16332`
- `PromoterLocationPing` → `schema.prisma:L3495`
- `Promotion` → `schema.prisma:L16607`
- `PromotionGroup` → `schema.prisma:L16646`
- `PromotionOption` → `schema.prisma:L16662`
- `ProviderCostStructure` → `schema.prisma:L6083`
- `ProviderEventLog` → `schema.prisma:L5830`
- `PurchaseOrder` → `schema.prisma:L2320`
- `PurchaseOrderInvoice` → `schema.prisma:L2465`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2522`
- `PurchaseOrderItem` → `schema.prisma:L2378`
- `RateCorrectionBatch` → `schema.prisma:L6308`
- `RateCorrectionEntry` → `schema.prisma:L6350`
- `RawMaterial` → `schema.prisma:L2077`
- `RawMaterialMovement` → `schema.prisma:L2648`
- `RawMaterialPresentation` → `schema.prisma:L2152`
- `Recipe` → `schema.prisma:L2172`
- `RecipeLine` → `schema.prisma:L2196`
- `Referral` → `schema.prisma:L7318`
- `ReferralProgramConfig` → `schema.prisma:L7283`
- `ReferralRewardGrant` → `schema.prisma:L7409`
- `ReferralTierReward` → `schema.prisma:L7381`
- `ReferralTierUnlock` → `schema.prisma:L7454`
- `RefreshGrant` → `schema.prisma:L17038`
- `Reservation` → `schema.prisma:L12836`
- `ReservationGoogleEventMapping` → `schema.prisma:L13606`
- `ReservationModifier` → `schema.prisma:L13016`
- `ReservationReminderSent` → `schema.prisma:L12999`
- `ReservationSettings` → `schema.prisma:L13230`
- `ReservationWaitlistEntry` → `schema.prisma:L13198`
- `Review` → `schema.prisma:L4586`
- `SalesRetention` → `schema.prisma:L16013`
- `SaleVerification` → `schema.prisma:L4345`
- `ScaleProfile` → `schema.prisma:L14898`
- `ScheduledCommand` → `schema.prisma:L9670`
- `SerializedItem` → `schema.prisma:L11320`
- `SerializedItemCustodyEvent` → `schema.prisma:L11484`
- `ServiceCharge` → `schema.prisma:L7918`
- `Session` → `schema.prisma:L17017`
- `SettlementConfiguration` → `schema.prisma:L6383`
- `SettlementConfirmation` → `schema.prisma:L6496`
- `SettlementIncident` → `schema.prisma:L6447`
- `SettlementSimulation` → `schema.prisma:L6418`
- `Shift` → `schema.prisma:L3136`
- `SimRegistrationRequest` → `schema.prisma:L11522`
- `SimRegistrationRequestItem` → `schema.prisma:L11544`
- `SlotHold` → `schema.prisma:L13099`
- `Staff` → `schema.prisma:L931`
- `StaffDocument` → `schema.prisma:L3366`
- `StaffOnboardingState` → `schema.prisma:L15228`
- `StaffOrganization` → `schema.prisma:L1261`
- `StaffPasskey` → `schema.prisma:L1288`
- `StaffSchedule` → `schema.prisma:L13039`
- `StaffScheduleException` → `schema.prisma:L13051`
- `StaffVenue` → `schema.prisma:L1185`
- `StaffWorkSchedule` → `schema.prisma:L3243`
- `StaffWorkScheduleException` → `schema.prisma:L3341`
- `StampCard` → `schema.prisma:L7166`
- `StampEvent` → `schema.prisma:L7205`
- `StampReward` → `schema.prisma:L7243`
- `StockAlertConfig` → `schema.prisma:L12175`
- `StockBatch` → `schema.prisma:L2799`
- `StockCount` → `schema.prisma:L2723`
- `StockCountItem` → `schema.prisma:L2747`
- `StripeWebhookEvent` → `schema.prisma:L6030`
- `Supplier` → `schema.prisma:L2231`
- `SupplierItemCode` → `schema.prisma:L2563`
- `SupplierPricing` → `schema.prisma:L2286`
- `Table` → `schema.prisma:L3048`
- `Terminal` → `schema.prisma:L4637`
- `TerminalHealth` → `schema.prisma:L4876`
- `TerminalLog` → `schema.prisma:L4850`
- `TerminalOrder` → `schema.prisma:L5009`
- `TerminalOrderItem` → `schema.prisma:L5084`
- `TerminalPaymentRequest` → `schema.prisma:L4947`
- `TimeEntry` → `schema.prisma:L3408`
- `TimeEntryBreak` → `schema.prisma:L3477`
- `TokenPurchase` → `schema.prisma:L9344`
- `TokenUsageRecord` → `schema.prisma:L9316`
- `TpvCommandHistory` → `schema.prisma:L9576`
- `TpvCommandQueue` → `schema.prisma:L9516`
- `TpvFeedback` → `schema.prisma:L9229`
- `TpvMessage` → `schema.prisma:L12532`
- `TpvMessageDelivery` → `schema.prisma:L12584`
- `TpvMessageResponse` → `schema.prisma:L12607`
- `TrainingModule` → `schema.prisma:L12662`
- `TrainingProgress` → `schema.prisma:L12739`
- `TrainingQuizQuestion` → `schema.prisma:L12721`
- `TrainingStep` → `schema.prisma:L12701`
- `TransactionCost` → `schema.prisma:L6246`
- `UnitConversion` → `schema.prisma:L2626`
- `UpsellAcceptance` → `schema.prisma:L7739`
- `UpsellAiRun` → `schema.prisma:L7759`
- `UpsellImpression` → `schema.prisma:L7699`
- `UpsellRule` → `schema.prisma:L7619`
- `user_sessions` → `schema.prisma:L5586`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14635`
- `VenueChatMessage` → `schema.prisma:L761`
- `VenueChatSession` → `schema.prisma:L716`
- `VenueCommission` → `schema.prisma:L14285`
- `VenueCreditAssessment` → `schema.prisma:L10058`
- `VenueCryptoConfig` → `schema.prisma:L12399`
- `VenueFeature` → `schema.prisma:L4459`
- `VenueModule` → `schema.prisma:L10218`
- `VenuePaymentConfig` → `schema.prisma:L5687`
- `VenuePaymentLinkSettings` → `schema.prisma:L13639`
- `VenuePricingStructure` → `schema.prisma:L6186`
- `VenueRoleConfig` → `schema.prisma:L1414`
- `VenueRolePermission` → `schema.prisma:L1318`
- `VenueScaleSettings` → `schema.prisma:L14886`
- `VenueSettings` → `schema.prisma:L801`
- `VenueTenderType` → `schema.prisma:L4204`
- `VenueTenderTypeRevision` → `schema.prisma:L4269`
- `VenueTransaction` → `schema.prisma:L4396`
- `VenueWhatsappActivation` → `schema.prisma:L652`
- `WalletCardDesign` → `schema.prisma:L7084`
- `WalletPass` → `schema.prisma:L6993`
- `WalletPassRegistration` → `schema.prisma:L7051`
- `WebhookEvent` → `schema.prisma:L4495`
- `WebhookSubscription` → `schema.prisma:L5803`
- `WhatsappContactWindow` → `schema.prisma:L670`
- `WhatsappInboundEvent` → `schema.prisma:L690`
- `WorkShiftAssignment` → `schema.prisma:L3283`
- `WorkShiftTemplate` → `schema.prisma:L3260`
- `Zone` → `schema.prisma:L142`
