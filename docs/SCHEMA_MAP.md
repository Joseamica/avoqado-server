# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **360 models / 341 enums / ~17,100 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                     |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                        |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCaptureToken`, `CustomerGroup`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L15992`
- `AccountMapping` → `schema.prisma:L15888`
- `ActivityLog` → `schema.prisma:L6706`
- `Aggregator` → `schema.prisma:L14285`
- `AngelPayUserAccount` → `schema.prisma:L5369`
- `AppUpdate` → `schema.prisma:L12465`
- `Area` → `schema.prisma:L3029`
- `AreaTicket` → `schema.prisma:L14783`
- `AreaTicketCheckoutSession` → `schema.prisma:L14905`
- `AreaTicketExternalIncident` → `schema.prisma:L15152`
- `AreaTicketExternalSettlement` → `schema.prisma:L15117`
- `AreaTicketFulfillment` → `schema.prisma:L14981`
- `AreaTicketInventoryReservation` → `schema.prisma:L14876`
- `AreaTicketLine` → `schema.prisma:L14844`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14937`
- `AreaTicketPrintAttempt` → `schema.prisma:L14960`
- `BankStatement` → `schema.prisma:L15762`
- `BankStatementLine` → `schema.prisma:L15783`
- `BillingTaxProfile` → `schema.prisma:L16572`
- `BulkCommandOperation` → `schema.prisma:L9745`
- `CalendarSyncOutbox` → `schema.prisma:L13672`
- `CampaignDelivery` → `schema.prisma:L12623`
- `CashCloseout` → `schema.prisma:L10130`
- `CashDeposit` → `schema.prisma:L12267`
- `CashDrawerEvent` → `schema.prisma:L14122`
- `CashDrawerSession` → `schema.prisma:L14098`
- `CashOutCommissionRate` → `schema.prisma:L16401`
- `CashOutScheduleDay` → `schema.prisma:L16424`
- `CashOutWithdrawal` → `schema.prisma:L16486`
- `CatalogBindingBatch` → `schema.prisma:L11161`
- `CatalogBindingLine` → `schema.prisma:L11197`
- `CatalogBrand` → `schema.prisma:L10614`
- `CatalogClientObservation` → `schema.prisma:L10927`
- `CatalogClientReadinessOverride` → `schema.prisma:L10946`
- `CatalogFamily` → `schema.prisma:L10664`
- `CatalogIdempotencyRecord` → `schema.prisma:L11060`
- `CatalogIdentifier` → `schema.prisma:L10795`
- `CatalogImportBatch` → `schema.prisma:L11103`
- `CatalogImportLine` → `schema.prisma:L11140`
- `CatalogItem` → `schema.prisma:L10697`
- `CatalogItemBusinessType` → `schema.prisma:L10757`
- `CatalogItemPrice` → `schema.prisma:L10845`
- `CatalogManufacturer` → `schema.prisma:L10638`
- `CatalogProductTypeMapping` → `schema.prisma:L10774`
- `CatalogPublicationBatch` → `schema.prisma:L11225`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11319`
- `CatalogPublicationLine` → `schema.prisma:L11266`
- `CatalogPublicationOutbox` → `schema.prisma:L11362`
- `CatalogValidationProfile` → `schema.prisma:L10816`
- `CatalogVenueBinding` → `schema.prisma:L10974`
- `CatalogVenueClientRequirement` → `schema.prisma:L10901`
- `CatalogVenueEventSequence` → `schema.prisma:L11345`
- `CatalogVenueOverride` → `schema.prisma:L11016`
- `CatalogVenueRollout` → `schema.prisma:L10876`
- `Cfdi` → `schema.prisma:L15665`
- `ChatbotTokenBudget` → `schema.prisma:L9393`
- `ChatConversation` → `schema.prisma:L9248`
- `ChatFeedback` → `schema.prisma:L9334`
- `ChatLearningEvent` → `schema.prisma:L9291`
- `ChatMessage` → `schema.prisma:L9271`
- `ChatTrainingData` → `schema.prisma:L9205`
- `CheckoutSession` → `schema.prisma:L5649`
- `ClassSession` → `schema.prisma:L13276`
- `CommissionCalculation` → `schema.prisma:L12043`
- `CommissionClawback` → `schema.prisma:L12219`
- `CommissionConfig` → `schema.prisma:L11809`
- `CommissionMilestone` → `schema.prisma:L11959`
- `CommissionOverride` → `schema.prisma:L11886`
- `CommissionPayout` → `schema.prisma:L12170`
- `CommissionSummary` → `schema.prisma:L12109`
- `CommissionTier` → `schema.prisma:L11923`
- `ConsentEvent` → `schema.prisma:L6886`
- `Consumer` → `schema.prisma:L6936`
- `ConsumerAuthAccount` → `schema.prisma:L6961`
- `CouponCode` → `schema.prisma:L7900`
- `CouponRedemption` → `schema.prisma:L7931`
- `CreditAssessmentHistory` → `schema.prisma:L10239`
- `CreditItemBalance` → `schema.prisma:L13888`
- `CreditOffer` → `schema.prisma:L10258`
- `CreditPack` → `schema.prisma:L13797`
- `CreditPackItem` → `schema.prisma:L13826`
- `CreditPackPurchase` → `schema.prisma:L13843`
- `CreditTransaction` → `schema.prisma:L13910`
- `Customer` → `schema.prisma:L6747`
- `CustomerApprovalDelivery` → `schema.prisma:L8907`
- `CustomerApprovalOutbox` → `schema.prisma:L8882`
- `CustomerCaptureToken` → `schema.prisma:L6922`
- `CustomerDiscount` → `schema.prisma:L7951`
- `CustomerGroup` → `schema.prisma:L7000`
- `CustomerOrderMetric` → `schema.prisma:L3781`
- `CustomerTaxProfile` → `schema.prisma:L15734`
- `DeliveryActivationRequest` → `schema.prisma:L5990`
- `DeliveryChannelLink` → `schema.prisma:L5935`
- `DeliveryOrderEvent` → `schema.prisma:L6014`
- `DeviceToken` → `schema.prisma:L8220`
- `DigitalReceipt` → `schema.prisma:L4352`
- `Discount` → `schema.prisma:L7590`
- `EcommerceMerchant` → `schema.prisma:L5461`
- `EmailTemplate` → `schema.prisma:L12562`
- `Employee` → `schema.prisma:L16249`
- `Estimate` → `schema.prisma:L14192`
- `EstimateItem` → `schema.prisma:L14220`
- `Expense` → `schema.prisma:L16036`
- `ExternalBusyBlock` → `schema.prisma:L13565`
- `Feature` → `schema.prisma:L4481`
- `FeeSchedule` → `schema.prisma:L4559`
- `FeeTier` → `schema.prisma:L4570`
- `FinancialAccount` → `schema.prisma:L14382`
- `FinancialConnection` → `schema.prisma:L14351`
- `FinancialProvider` → `schema.prisma:L14337`
- `FiscalEmisor` → `schema.prisma:L15588`
- `FiscalLossCarryforward` → `schema.prisma:L16159`
- `FixedAsset` → `schema.prisma:L16177`
- `FixedAssetDepreciation` → `schema.prisma:L16206`
- `FloorElement` → `schema.prisma:L3105`
- `FulfillmentArea` → `schema.prisma:L14648`
- `GeofenceRule` → `schema.prisma:L9830`
- `GoogleCalendarChannel` → `schema.prisma:L13542`
- `GoogleCalendarConnection` → `schema.prisma:L13494`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13595`
- `GoogleOAuthSession` → `schema.prisma:L13617`
- `HolidayCalendar` → `schema.prisma:L6630`
- `IdempotencyRequest` → `schema.prisma:L11684`
- `InterVenueTransfer` → `schema.prisma:L2857`
- `InterVenueTransferAllocation` → `schema.prisma:L2940`
- `InterVenueTransferItem` → `schema.prisma:L2909`
- `InterVenueTransferReceipt` → `schema.prisma:L2967`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2983`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3011`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2995`
- `Inventory` → `schema.prisma:L1903`
- `InventoryMovement` → `schema.prisma:L1930`
- `InventoryPosting` → `schema.prisma:L2012`
- `InventoryPostingLine` → `schema.prisma:L2052`
- `InventoryTransfer` → `schema.prisma:L14164`
- `Invitation` → `schema.prisma:L1441`
- `Invoice` → `schema.prisma:L4582`
- `InvoiceItem` → `schema.prisma:L4608`
- `ItemCategory` → `schema.prisma:L11397`
- `JournalEntry` → `schema.prisma:L15946`
- `JournalLine` → `schema.prisma:L15974`
- `KdsOrder` → `schema.prisma:L14430`
- `KdsOrderItem` → `schema.prisma:L14471`
- `KioskCheckInAttempt` → `schema.prisma:L16895`
- `KioskCheckInChallenge` → `schema.prisma:L16849`
- `KioskOutreachOutbox` → `schema.prisma:L16916`
- `LearnedPatterns` → `schema.prisma:L9315`
- `LedgerAccount` → `schema.prisma:L15838`
- `LiveDemoSession` → `schema.prisma:L788`
- `LowStockAlert` → `schema.prisma:L2698`
- `LoyaltyConfig` → `schema.prisma:L7030`
- `LoyaltyTransaction` → `schema.prisma:L7073`
- `MarketingCampaign` → `schema.prisma:L12580`
- `McpAuthCode` → `schema.prisma:L15471`
- `McpOAuthClient` → `schema.prisma:L15455`
- `McpRefreshToken` → `schema.prisma:L15489`
- `McpToolCall` → `schema.prisma:L15510`
- `MeasurementUnit` → `schema.prisma:L14270`
- `Menu` → `schema.prisma:L1627`
- `MenuCategory` → `schema.prisma:L1564`
- `MenuCategoryAssignment` → `schema.prisma:L1662`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15385`
- `MerchantAccount` → `schema.prisma:L5199`
- `MerchantFiscalConfig` → `schema.prisma:L15636`
- `MerchantRevenueShare` → `schema.prisma:L6210`
- `MerchantRoutingRule` → `schema.prisma:L5321`
- `MilestoneAchievement` → `schema.prisma:L12004`
- `Modifier` → `schema.prisma:L3965`
- `ModifierGroup` → `schema.prisma:L3929`
- `Module` → `schema.prisma:L10306`
- `MoneyAnomaly` → `schema.prisma:L6113`
- `MonthlyVenueProfit` → `schema.prisma:L6656`
- `Notification` → `schema.prisma:L8122`
- `NotificationPreference` → `schema.prisma:L8169`
- `NotificationTemplate` → `schema.prisma:L8196`
- `OAuthState` → `schema.prisma:L1492`
- `OnboardingProgress` → `schema.prisma:L1510`
- `Order` → `schema.prisma:L3536`
- `OrderAction` → `schema.prisma:L4032`
- `OrderCustomer` → `schema.prisma:L3760`
- `OrderDiscount` → `schema.prisma:L7983`
- `OrderFulfillment` → `schema.prisma:L14703`
- `OrderFulfillmentLine` → `schema.prisma:L14734`
- `OrderItem` → `schema.prisma:L3796`
- `OrderItemModifier` → `schema.prisma:L4014`
- `OrderPromotion` → `schema.prisma:L16812`
- `OrderServiceCharge` → `schema.prisma:L8067`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12381`
- `OrganizationEntitlement` → `schema.prisma:L10589`
- `OrganizationGoal` → `schema.prisma:L12339`
- `OrganizationModule` → `schema.prisma:L10366`
- `OrganizationPaymentConfig` → `schema.prisma:L5773`
- `OrganizationPayoutConfig` → `schema.prisma:L12414`
- `OrganizationPricingStructure` → `schema.prisma:L5805`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12362`
- `OtpChallenge` → `schema.prisma:L6980`
- `OvertimeApproval` → `schema.prisma:L3314`
- `PartnerAPIKey` → `schema.prisma:L5603`
- `Payment` → `schema.prisma:L4065`
- `PaymentAllocation` → `schema.prisma:L4331`
- `PaymentLink` → `schema.prisma:L13956`
- `PaymentLinkAttribution` → `schema.prisma:L14064`
- `PaymentLinkItem` → `schema.prisma:L14019`
- `PaymentLinkItemModifier` → `schema.prisma:L14046`
- `PaymentProvider` → `schema.prisma:L5158`
- `PayrollLine` → `schema.prisma:L16320`
- `PayrollRun` → `schema.prisma:L16289`
- `PerformanceGoal` → `schema.prisma:L12316`
- `PermissionOverride` → `schema.prisma:L1365`
- `PermissionSet` → `schema.prisma:L1388`
- `PlatformAnnouncement` → `schema.prisma:L16976`
- `PlatformAnnouncementClick` → `schema.prisma:L17041`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17078`
- `PlatformCfdi` → `schema.prisma:L16605`
- `PlatformEmisor` → `schema.prisma:L16545`
- `PlatformSettings` → `schema.prisma:L5580`
- `PosCommand` → `schema.prisma:L8250`
- `PosConnectionStatus` → `schema.prisma:L914`
- `PosSyncIntent` → `schema.prisma:L16683`
- `PricingPolicy` → `schema.prisma:L2602`
- `Printer` → `schema.prisma:L14513`
- `PrintGateway` → `schema.prisma:L14570`
- `PrintJob` → `schema.prisma:L15284`
- `PrintStation` → `schema.prisma:L14588`
- `PrivacyNoticeVersion` → `schema.prisma:L6908`
- `ProcessedStripeEvent` → `schema.prisma:L6099`
- `ProcessorReliabilityMetric` → `schema.prisma:L6584`
- `Product` → `schema.prisma:L1680`
- `ProductModifierGroup` → `schema.prisma:L4002`
- `ProductOption` → `schema.prisma:L14247`
- `ProductOptionValue` → `schema.prisma:L14258`
- `ProductStaff` → `schema.prisma:L13191`
- `PromoterBankAccount` → `schema.prisma:L16440`
- `PromoterCommissionEntry` → `schema.prisma:L16459`
- `PromoterLocationPing` → `schema.prisma:L3502`
- `Promotion` → `schema.prisma:L16734`
- `PromotionGroup` → `schema.prisma:L16773`
- `PromotionOption` → `schema.prisma:L16789`
- `ProviderCostStructure` → `schema.prisma:L6135`
- `ProviderEventLog` → `schema.prisma:L5882`
- `PurchaseOrder` → `schema.prisma:L2327`
- `PurchaseOrderInvoice` → `schema.prisma:L2472`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2529`
- `PurchaseOrderItem` → `schema.prisma:L2385`
- `RateCorrectionBatch` → `schema.prisma:L6360`
- `RateCorrectionEntry` → `schema.prisma:L6402`
- `RawMaterial` → `schema.prisma:L2084`
- `RawMaterialMovement` → `schema.prisma:L2655`
- `RawMaterialPresentation` → `schema.prisma:L2159`
- `Recipe` → `schema.prisma:L2179`
- `RecipeLine` → `schema.prisma:L2203`
- `Referral` → `schema.prisma:L7438`
- `ReferralProgramConfig` → `schema.prisma:L7403`
- `ReferralRewardGrant` → `schema.prisma:L7529`
- `ReferralTierReward` → `schema.prisma:L7501`
- `ReferralTierUnlock` → `schema.prisma:L7574`
- `RefreshGrant` → `schema.prisma:L17165`
- `Reservation` → `schema.prisma:L12959`
- `ReservationGoogleEventMapping` → `schema.prisma:L13729`
- `ReservationModifier` → `schema.prisma:L13139`
- `ReservationReminderSent` → `schema.prisma:L13122`
- `ReservationSettings` → `schema.prisma:L13353`
- `ReservationWaitlistEntry` → `schema.prisma:L13321`
- `Review` → `schema.prisma:L4626`
- `SalesRetention` → `schema.prisma:L16140`
- `SaleVerification` → `schema.prisma:L4385`
- `ScaleProfile` → `schema.prisma:L15025`
- `ScheduledCommand` → `schema.prisma:L9790`
- `SerializedItem` → `schema.prisma:L11440`
- `SerializedItemCustodyEvent` → `schema.prisma:L11607`
- `ServiceCharge` → `schema.prisma:L8038`
- `Session` → `schema.prisma:L17144`
- `SettlementConfiguration` → `schema.prisma:L6435`
- `SettlementConfirmation` → `schema.prisma:L6548`
- `SettlementIncident` → `schema.prisma:L6499`
- `SettlementSimulation` → `schema.prisma:L6470`
- `Shift` → `schema.prisma:L3143`
- `SimRegistrationRequest` → `schema.prisma:L11645`
- `SimRegistrationRequestItem` → `schema.prisma:L11667`
- `SlotHold` → `schema.prisma:L13222`
- `Staff` → `schema.prisma:L934`
- `StaffDocument` → `schema.prisma:L3373`
- `StaffOnboardingState` → `schema.prisma:L15355`
- `StaffOrganization` → `schema.prisma:L1264`
- `StaffPasskey` → `schema.prisma:L1291`
- `StaffSchedule` → `schema.prisma:L13162`
- `StaffScheduleException` → `schema.prisma:L13174`
- `StaffVenue` → `schema.prisma:L1188`
- `StaffWorkSchedule` → `schema.prisma:L3250`
- `StaffWorkScheduleException` → `schema.prisma:L3348`
- `StampCard` → `schema.prisma:L7286`
- `StampEvent` → `schema.prisma:L7325`
- `StampReward` → `schema.prisma:L7363`
- `StockAlertConfig` → `schema.prisma:L12298`
- `StockBatch` → `schema.prisma:L2806`
- `StockCount` → `schema.prisma:L2730`
- `StockCountItem` → `schema.prisma:L2754`
- `StripeWebhookEvent` → `schema.prisma:L6082`
- `Supplier` → `schema.prisma:L2238`
- `SupplierItemCode` → `schema.prisma:L2570`
- `SupplierPricing` → `schema.prisma:L2293`
- `Table` → `schema.prisma:L3055`
- `Terminal` → `schema.prisma:L4677`
- `TerminalHealth` → `schema.prisma:L4928`
- `TerminalLog` → `schema.prisma:L4902`
- `TerminalOrder` → `schema.prisma:L5061`
- `TerminalOrderItem` → `schema.prisma:L5136`
- `TerminalPaymentRequest` → `schema.prisma:L4999`
- `TimeEntry` → `schema.prisma:L3415`
- `TimeEntryBreak` → `schema.prisma:L3484`
- `TokenPurchase` → `schema.prisma:L9464`
- `TokenUsageRecord` → `schema.prisma:L9436`
- `TpvCommandHistory` → `schema.prisma:L9696`
- `TpvCommandQueue` → `schema.prisma:L9636`
- `TpvFeedback` → `schema.prisma:L9349`
- `TpvMessage` → `schema.prisma:L12655`
- `TpvMessageDelivery` → `schema.prisma:L12707`
- `TpvMessageResponse` → `schema.prisma:L12730`
- `TrainingModule` → `schema.prisma:L12785`
- `TrainingProgress` → `schema.prisma:L12862`
- `TrainingQuizQuestion` → `schema.prisma:L12844`
- `TrainingStep` → `schema.prisma:L12824`
- `TransactionCost` → `schema.prisma:L6298`
- `UnitConversion` → `schema.prisma:L2633`
- `UpsellAcceptance` → `schema.prisma:L7859`
- `UpsellAiRun` → `schema.prisma:L7879`
- `UpsellImpression` → `schema.prisma:L7819`
- `UpsellRule` → `schema.prisma:L7739`
- `user_sessions` → `schema.prisma:L5638`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14762`
- `VenueChatMessage` → `schema.prisma:L764`
- `VenueChatSession` → `schema.prisma:L719`
- `VenueCommission` → `schema.prisma:L14408`
- `VenueCreditAssessment` → `schema.prisma:L10178`
- `VenueCryptoConfig` → `schema.prisma:L12522`
- `VenueFeature` → `schema.prisma:L4499`
- `VenueModule` → `schema.prisma:L10338`
- `VenuePaymentConfig` → `schema.prisma:L5739`
- `VenuePaymentLinkSettings` → `schema.prisma:L13762`
- `VenuePricingStructure` → `schema.prisma:L6238`
- `VenueRoleConfig` → `schema.prisma:L1417`
- `VenueRolePermission` → `schema.prisma:L1321`
- `VenueScaleSettings` → `schema.prisma:L15013`
- `VenueSettings` → `schema.prisma:L804`
- `VenueTenderType` → `schema.prisma:L4244`
- `VenueTenderTypeRevision` → `schema.prisma:L4309`
- `VenueTransaction` → `schema.prisma:L4436`
- `VenueWhatsappActivation` → `schema.prisma:L655`
- `WalletCardDesign` → `schema.prisma:L7204`
- `WalletPass` → `schema.prisma:L7113`
- `WalletPassRegistration` → `schema.prisma:L7171`
- `WebhookEvent` → `schema.prisma:L4535`
- `WebhookSubscription` → `schema.prisma:L5855`
- `WhatsappContactWindow` → `schema.prisma:L673`
- `WhatsappInboundEvent` → `schema.prisma:L693`
- `WorkShiftAssignment` → `schema.prisma:L3290`
- `WorkShiftTemplate` → `schema.prisma:L3267`
- `Zone` → `schema.prisma:L142`
