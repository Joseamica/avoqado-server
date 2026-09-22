# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **371 models / 356 enums / ~17,900 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                         |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                             |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `InventoryWasteReport`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                               |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                            |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                      |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                                         |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                                 |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                      |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L16485`
- `AccountMapping` → `schema.prisma:L16381`
- `ActivityLog` → `schema.prisma:L6988`
- `Aggregator` → `schema.prisma:L14778`
- `AngelPayUserAccount` → `schema.prisma:L5639`
- `AppUpdate` → `schema.prisma:L12943`
- `Area` → `schema.prisma:L3200`
- `AreaTicket` → `schema.prisma:L15276`
- `AreaTicketCheckoutSession` → `schema.prisma:L15398`
- `AreaTicketExternalIncident` → `schema.prisma:L15645`
- `AreaTicketExternalSettlement` → `schema.prisma:L15610`
- `AreaTicketFulfillment` → `schema.prisma:L15474`
- `AreaTicketInventoryReservation` → `schema.prisma:L15369`
- `AreaTicketLine` → `schema.prisma:L15337`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15430`
- `AreaTicketPrintAttempt` → `schema.prisma:L15453`
- `BankStatement` → `schema.prisma:L16255`
- `BankStatementLine` → `schema.prisma:L16276`
- `BillingTaxProfile` → `schema.prisma:L17065`
- `BirthdayAutomation` → `schema.prisma:L7309`
- `BulkCommandOperation` → `schema.prisma:L10223`
- `CalendarSyncOutbox` → `schema.prisma:L14150`
- `CampaignDelivery` → `schema.prisma:L13101`
- `CashCloseout` → `schema.prisma:L10608`
- `CashDeposit` → `schema.prisma:L12745`
- `CashDrawerEvent` → `schema.prisma:L14615`
- `CashDrawerSession` → `schema.prisma:L14576`
- `CashOutCommissionRate` → `schema.prisma:L16894`
- `CashOutScheduleDay` → `schema.prisma:L16917`
- `CashOutWithdrawal` → `schema.prisma:L16979`
- `CatalogBindingBatch` → `schema.prisma:L11639`
- `CatalogBindingLine` → `schema.prisma:L11675`
- `CatalogBrand` → `schema.prisma:L11092`
- `CatalogClientObservation` → `schema.prisma:L11405`
- `CatalogClientReadinessOverride` → `schema.prisma:L11424`
- `CatalogFamily` → `schema.prisma:L11142`
- `CatalogIdempotencyRecord` → `schema.prisma:L11538`
- `CatalogIdentifier` → `schema.prisma:L11273`
- `CatalogImportBatch` → `schema.prisma:L11581`
- `CatalogImportLine` → `schema.prisma:L11618`
- `CatalogItem` → `schema.prisma:L11175`
- `CatalogItemBusinessType` → `schema.prisma:L11235`
- `CatalogItemPrice` → `schema.prisma:L11323`
- `CatalogManufacturer` → `schema.prisma:L11116`
- `CatalogProductTypeMapping` → `schema.prisma:L11252`
- `CatalogPublicationBatch` → `schema.prisma:L11703`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11797`
- `CatalogPublicationLine` → `schema.prisma:L11744`
- `CatalogPublicationOutbox` → `schema.prisma:L11840`
- `CatalogValidationProfile` → `schema.prisma:L11294`
- `CatalogVenueBinding` → `schema.prisma:L11452`
- `CatalogVenueClientRequirement` → `schema.prisma:L11379`
- `CatalogVenueEventSequence` → `schema.prisma:L11823`
- `CatalogVenueOverride` → `schema.prisma:L11494`
- `CatalogVenueRollout` → `schema.prisma:L11354`
- `Cfdi` → `schema.prisma:L16158`
- `ChatbotTokenBudget` → `schema.prisma:L9871`
- `ChatConversation` → `schema.prisma:L9726`
- `ChatFeedback` → `schema.prisma:L9812`
- `ChatLearningEvent` → `schema.prisma:L9769`
- `ChatMessage` → `schema.prisma:L9749`
- `ChatTrainingData` → `schema.prisma:L9683`
- `CheckoutSession` → `schema.prisma:L5919`
- `ClassSession` → `schema.prisma:L13754`
- `CommissionCalculation` → `schema.prisma:L12521`
- `CommissionClawback` → `schema.prisma:L12697`
- `CommissionConfig` → `schema.prisma:L12287`
- `CommissionMilestone` → `schema.prisma:L12437`
- `CommissionOverride` → `schema.prisma:L12364`
- `CommissionPayout` → `schema.prisma:L12648`
- `CommissionSummary` → `schema.prisma:L12587`
- `CommissionTier` → `schema.prisma:L12401`
- `ConsentEvent` → `schema.prisma:L7171`
- `Consumer` → `schema.prisma:L7401`
- `ConsumerAuthAccount` → `schema.prisma:L7426`
- `CouponCode` → `schema.prisma:L8373`
- `CouponRedemption` → `schema.prisma:L8404`
- `CreditAssessmentHistory` → `schema.prisma:L10717`
- `CreditItemBalance` → `schema.prisma:L14366`
- `CreditOffer` → `schema.prisma:L10736`
- `CreditPack` → `schema.prisma:L14275`
- `CreditPackItem` → `schema.prisma:L14304`
- `CreditPackPurchase` → `schema.prisma:L14321`
- `CreditTransaction` → `schema.prisma:L14388`
- `Customer` → `schema.prisma:L7029`
- `CustomerApprovalDelivery` → `schema.prisma:L9385`
- `CustomerApprovalOutbox` → `schema.prisma:L9360`
- `CustomerCampaign` → `schema.prisma:L7259`
- `CustomerCampaignDelivery` → `schema.prisma:L7341`
- `CustomerCaptureToken` → `schema.prisma:L7207`
- `CustomerDiscount` → `schema.prisma:L8424`
- `CustomerGroup` → `schema.prisma:L7465`
- `CustomerOrderMetric` → `schema.prisma:L3971`
- `CustomerTaxProfile` → `schema.prisma:L16227`
- `DeliveryActivationRequest` → `schema.prisma:L6272`
- `DeliveryChannelLink` → `schema.prisma:L6217`
- `DeliveryOrderEvent` → `schema.prisma:L6296`
- `DeviceToken` → `schema.prisma:L8693`
- `DigitalReceipt` → `schema.prisma:L4549`
- `Discount` → `schema.prisma:L8063`
- `EcommerceMerchant` → `schema.prisma:L5731`
- `EmailQuotaLedger` → `schema.prisma:L7388`
- `EmailSuppression` → `schema.prisma:L7376`
- `EmailTemplate` → `schema.prisma:L13040`
- `Employee` → `schema.prisma:L16742`
- `Estimate` → `schema.prisma:L14685`
- `EstimateItem` → `schema.prisma:L14713`
- `Expense` → `schema.prisma:L16529`
- `ExternalBusyBlock` → `schema.prisma:L14043`
- `Feature` → `schema.prisma:L4678`
- `FeeSchedule` → `schema.prisma:L4763`
- `FeeTier` → `schema.prisma:L4774`
- `FinancialAccount` → `schema.prisma:L14875`
- `FinancialConnection` → `schema.prisma:L14844`
- `FinancialProvider` → `schema.prisma:L14830`
- `FiscalEmisor` → `schema.prisma:L16081`
- `FiscalLossCarryforward` → `schema.prisma:L16652`
- `FixedAsset` → `schema.prisma:L16670`
- `FixedAssetDepreciation` → `schema.prisma:L16699`
- `FloorElement` → `schema.prisma:L3276`
- `FulfillmentArea` → `schema.prisma:L15141`
- `GeofenceRule` → `schema.prisma:L10308`
- `GoogleCalendarChannel` → `schema.prisma:L14020`
- `GoogleCalendarConnection` → `schema.prisma:L13972`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14073`
- `GoogleOAuthSession` → `schema.prisma:L14095`
- `HolidayCalendar` → `schema.prisma:L6912`
- `IdempotencyRequest` → `schema.prisma:L12162`
- `InterVenueTransfer` → `schema.prisma:L3028`
- `InterVenueTransferAllocation` → `schema.prisma:L3111`
- `InterVenueTransferItem` → `schema.prisma:L3080`
- `InterVenueTransferReceipt` → `schema.prisma:L3138`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3154`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3182`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3166`
- `Inventory` → `schema.prisma:L1974`
- `InventoryMovement` → `schema.prisma:L2072`
- `InventoryPosting` → `schema.prisma:L2167`
- `InventoryPostingLine` → `schema.prisma:L2207`
- `InventoryTransfer` → `schema.prisma:L14657`
- `InventoryWasteReport` → `schema.prisma:L2029`
- `Invitation` → `schema.prisma:L1479`
- `Invoice` → `schema.prisma:L4786`
- `InvoiceItem` → `schema.prisma:L4812`
- `ItemCategory` → `schema.prisma:L11875`
- `JournalEntry` → `schema.prisma:L16439`
- `JournalLine` → `schema.prisma:L16467`
- `KdsOrder` → `schema.prisma:L14923`
- `KdsOrderItem` → `schema.prisma:L14964`
- `KioskCheckInAttempt` → `schema.prisma:L17388`
- `KioskCheckInChallenge` → `schema.prisma:L17342`
- `KioskOutreachOutbox` → `schema.prisma:L17409`
- `LaunchCampaign` → `schema.prisma:L17747`
- `LaunchCampaignRedemption` → `schema.prisma:L17853`
- `LearnedPatterns` → `schema.prisma:L9793`
- `LedgerAccount` → `schema.prisma:L16331`
- `LiveDemoSession` → `schema.prisma:L823`
- `LowStockAlert` → `schema.prisma:L2862`
- `LoyaltyConfig` → `schema.prisma:L7495`
- `LoyaltyTransaction` → `schema.prisma:L7538`
- `MarketingCampaign` → `schema.prisma:L13058`
- `McpAuthCode` → `schema.prisma:L15964`
- `McpOAuthClient` → `schema.prisma:L15948`
- `McpRefreshToken` → `schema.prisma:L15982`
- `McpToolCall` → `schema.prisma:L16003`
- `MeasurementUnit` → `schema.prisma:L14763`
- `Menu` → `schema.prisma:L1697`
- `MenuCategory` → `schema.prisma:L1634`
- `MenuCategoryAssignment` → `schema.prisma:L1732`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15878`
- `MerchantAccount` → `schema.prisma:L5469`
- `MerchantFiscalConfig` → `schema.prisma:L16129`
- `MerchantRevenueShare` → `schema.prisma:L6492`
- `MerchantRoutingRule` → `schema.prisma:L5591`
- `MilestoneAchievement` → `schema.prisma:L12482`
- `Modifier` → `schema.prisma:L4155`
- `ModifierGroup` → `schema.prisma:L4119`
- `Module` → `schema.prisma:L10784`
- `MoneyAnomaly` → `schema.prisma:L6395`
- `MonthlyVenueProfit` → `schema.prisma:L6938`
- `Notification` → `schema.prisma:L8595`
- `NotificationPreference` → `schema.prisma:L8642`
- `NotificationTemplate` → `schema.prisma:L8669`
- `OAuthState` → `schema.prisma:L1530`
- `OnboardingProgress` → `schema.prisma:L1548`
- `Order` → `schema.prisma:L3725`
- `OrderAction` → `schema.prisma:L4222`
- `OrderCustomer` → `schema.prisma:L3950`
- `OrderDiscount` → `schema.prisma:L8456`
- `OrderFulfillment` → `schema.prisma:L15196`
- `OrderFulfillmentLine` → `schema.prisma:L15227`
- `OrderItem` → `schema.prisma:L3986`
- `OrderItemModifier` → `schema.prisma:L4204`
- `OrderPromotion` → `schema.prisma:L17305`
- `OrderServiceCharge` → `schema.prisma:L8540`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12859`
- `OrganizationEntitlement` → `schema.prisma:L11067`
- `OrganizationGoal` → `schema.prisma:L12817`
- `OrganizationModule` → `schema.prisma:L10844`
- `OrganizationPaymentConfig` → `schema.prisma:L6043`
- `OrganizationPayoutConfig` → `schema.prisma:L12892`
- `OrganizationPricingStructure` → `schema.prisma:L6075`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12840`
- `OtpChallenge` → `schema.prisma:L7445`
- `OvertimeApproval` → `schema.prisma:L3503`
- `PartnerAPIKey` → `schema.prisma:L5873`
- `Payment` → `schema.prisma:L4255`
- `PaymentAllocation` → `schema.prisma:L4528`
- `PaymentEffect` → `schema.prisma:L17679`
- `PaymentLink` → `schema.prisma:L14434`
- `PaymentLinkAttribution` → `schema.prisma:L14542`
- `PaymentLinkItem` → `schema.prisma:L14497`
- `PaymentLinkItemModifier` → `schema.prisma:L14524`
- `PaymentProvider` → `schema.prisma:L5428`
- `PayrollLine` → `schema.prisma:L16813`
- `PayrollRun` → `schema.prisma:L16782`
- `PerformanceGoal` → `schema.prisma:L12794`
- `PermissionOverride` → `schema.prisma:L1403`
- `PermissionSet` → `schema.prisma:L1426`
- `PlatformAnnouncement` → `schema.prisma:L17469`
- `PlatformAnnouncementClick` → `schema.prisma:L17534`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17571`
- `PlatformCfdi` → `schema.prisma:L17098`
- `PlatformEmisor` → `schema.prisma:L17038`
- `PlatformSettings` → `schema.prisma:L5850`
- `PosCommand` → `schema.prisma:L8723`
- `PosConnectionStatus` → `schema.prisma:L949`
- `PosSyncIntent` → `schema.prisma:L17176`
- `PricingPolicy` → `schema.prisma:L2758`
- `Printer` → `schema.prisma:L15006`
- `PrintGateway` → `schema.prisma:L15063`
- `PrintJob` → `schema.prisma:L15777`
- `PrintStation` → `schema.prisma:L15081`
- `PrivacyNoticeVersion` → `schema.prisma:L7193`
- `ProcessedStripeEvent` → `schema.prisma:L6381`
- `ProcessorReliabilityMetric` → `schema.prisma:L6866`
- `Product` → `schema.prisma:L1750`
- `ProductModifierGroup` → `schema.prisma:L4192`
- `ProductOption` → `schema.prisma:L14740`
- `ProductOptionValue` → `schema.prisma:L14751`
- `ProductStaff` → `schema.prisma:L13669`
- `PromoterBankAccount` → `schema.prisma:L16933`
- `PromoterCommissionEntry` → `schema.prisma:L16952`
- `PromoterLocationPing` → `schema.prisma:L3691`
- `Promotion` → `schema.prisma:L17227`
- `PromotionGroup` → `schema.prisma:L17266`
- `PromotionOption` → `schema.prisma:L17282`
- `ProviderCostStructure` → `schema.prisma:L6417`
- `ProviderEventLog` → `schema.prisma:L6152`
- `PurchaseOrder` → `schema.prisma:L2483`
- `PurchaseOrderInvoice` → `schema.prisma:L2628`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2685`
- `PurchaseOrderItem` → `schema.prisma:L2541`
- `RateCorrectionBatch` → `schema.prisma:L6642`
- `RateCorrectionEntry` → `schema.prisma:L6684`
- `RawMaterial` → `schema.prisma:L2239`
- `RawMaterialMovement` → `schema.prisma:L2811`
- `RawMaterialPresentation` → `schema.prisma:L2315`
- `ReceiptLayout` → `schema.prisma:L17713`
- `Recipe` → `schema.prisma:L2335`
- `RecipeLine` → `schema.prisma:L2359`
- `Referral` → `schema.prisma:L7911`
- `ReferralProgramConfig` → `schema.prisma:L7876`
- `ReferralRewardGrant` → `schema.prisma:L8002`
- `ReferralTierReward` → `schema.prisma:L7974`
- `ReferralTierUnlock` → `schema.prisma:L8047`
- `RefreshGrant` → `schema.prisma:L17658`
- `Reservation` → `schema.prisma:L13437`
- `ReservationGoogleEventMapping` → `schema.prisma:L14207`
- `ReservationModifier` → `schema.prisma:L13617`
- `ReservationReminderSent` → `schema.prisma:L13600`
- `ReservationSettings` → `schema.prisma:L13831`
- `ReservationWaitlistEntry` → `schema.prisma:L13799`
- `Review` → `schema.prisma:L4830`
- `SalesRetention` → `schema.prisma:L16633`
- `SaleVerification` → `schema.prisma:L4582`
- `ScaleProfile` → `schema.prisma:L15518`
- `ScheduledCommand` → `schema.prisma:L10268`
- `SerializedItem` → `schema.prisma:L11918`
- `SerializedItemCustodyEvent` → `schema.prisma:L12085`
- `ServiceCharge` → `schema.prisma:L8511`
- `Session` → `schema.prisma:L17637`
- `SettlementConfiguration` → `schema.prisma:L6717`
- `SettlementConfirmation` → `schema.prisma:L6830`
- `SettlementIncident` → `schema.prisma:L6781`
- `SettlementSimulation` → `schema.prisma:L6752`
- `Shift` → `schema.prisma:L3314`
- `SimRegistrationRequest` → `schema.prisma:L12123`
- `SimRegistrationRequestItem` → `schema.prisma:L12145`
- `SlotHold` → `schema.prisma:L13700`
- `Staff` → `schema.prisma:L969`
- `StaffDocument` → `schema.prisma:L3562`
- `StaffOnboardingState` → `schema.prisma:L15848`
- `StaffOrganization` → `schema.prisma:L1302`
- `StaffPasskey` → `schema.prisma:L1329`
- `StaffSchedule` → `schema.prisma:L13640`
- `StaffScheduleException` → `schema.prisma:L13652`
- `StaffVenue` → `schema.prisma:L1226`
- `StaffWorkSchedule` → `schema.prisma:L3439`
- `StaffWorkScheduleException` → `schema.prisma:L3537`
- `StampCard` → `schema.prisma:L7759`
- `StampEvent` → `schema.prisma:L7798`
- `StampReward` → `schema.prisma:L7836`
- `StockAlertConfig` → `schema.prisma:L12776`
- `StockBatch` → `schema.prisma:L2977`
- `StockCount` → `schema.prisma:L2894`
- `StockCountItem` → `schema.prisma:L2922`
- `StripeWebhookEvent` → `schema.prisma:L6364`
- `Supplier` → `schema.prisma:L2394`
- `SupplierItemCode` → `schema.prisma:L2726`
- `SupplierPricing` → `schema.prisma:L2449`
- `Table` → `schema.prisma:L3226`
- `Terminal` → `schema.prisma:L4881`
- `TerminalHealth` → `schema.prisma:L5132`
- `TerminalLog` → `schema.prisma:L5106`
- `TerminalOrder` → `schema.prisma:L5331`
- `TerminalOrderItem` → `schema.prisma:L5406`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5284`
- `TerminalPaymentRequest` → `schema.prisma:L5203`
- `TimeEntry` → `schema.prisma:L3604`
- `TimeEntryBreak` → `schema.prisma:L3673`
- `TokenPurchase` → `schema.prisma:L9942`
- `TokenUsageRecord` → `schema.prisma:L9914`
- `TpvCommandHistory` → `schema.prisma:L10174`
- `TpvCommandQueue` → `schema.prisma:L10114`
- `TpvFeedback` → `schema.prisma:L9827`
- `TpvMessage` → `schema.prisma:L13133`
- `TpvMessageDelivery` → `schema.prisma:L13185`
- `TpvMessageResponse` → `schema.prisma:L13208`
- `TrainingModule` → `schema.prisma:L13263`
- `TrainingProgress` → `schema.prisma:L13340`
- `TrainingQuizQuestion` → `schema.prisma:L13322`
- `TrainingStep` → `schema.prisma:L13302`
- `TransactionCost` → `schema.prisma:L6580`
- `UnitConversion` → `schema.prisma:L2789`
- `UpsellAcceptance` → `schema.prisma:L8332`
- `UpsellAiRun` → `schema.prisma:L8352`
- `UpsellImpression` → `schema.prisma:L8292`
- `UpsellRule` → `schema.prisma:L8212`
- `user_sessions` → `schema.prisma:L5908`
- `Venue` → `schema.prisma:L163`
- `VenueAreaTicketSettings` → `schema.prisma:L15255`
- `VenueChatMessage` → `schema.prisma:L799`
- `VenueChatSession` → `schema.prisma:L754`
- `VenueCommission` → `schema.prisma:L14901`
- `VenueCreditAssessment` → `schema.prisma:L10656`
- `VenueCryptoConfig` → `schema.prisma:L13000`
- `VenueFeature` → `schema.prisma:L4696`
- `VenueModule` → `schema.prisma:L10816`
- `VenuePaymentConfig` → `schema.prisma:L6009`
- `VenuePaymentLinkSettings` → `schema.prisma:L14240`
- `VenuePricingStructure` → `schema.prisma:L6520`
- `VenueRoleConfig` → `schema.prisma:L1455`
- `VenueRolePermission` → `schema.prisma:L1359`
- `VenueScaleSettings` → `schema.prisma:L15506`
- `VenueSettings` → `schema.prisma:L839`
- `VenueTenderType` → `schema.prisma:L4441`
- `VenueTenderTypeRevision` → `schema.prisma:L4506`
- `VenueTransaction` → `schema.prisma:L4633`
- `VenueWhatsappActivation` → `schema.prisma:L690`
- `WalletCardDesign` → `schema.prisma:L7677`
- `WalletPass` → `schema.prisma:L7578`
- `WalletPassRegistration` → `schema.prisma:L7644`
- `WebhookEvent` → `schema.prisma:L4739`
- `WebhookSubscription` → `schema.prisma:L6125`
- `WhatsappContactWindow` → `schema.prisma:L708`
- `WhatsappInboundEvent` → `schema.prisma:L728`
- `WorkShiftAssignment` → `schema.prisma:L3479`
- `WorkShiftTemplate` → `schema.prisma:L3456`
- `Zone` → `schema.prisma:L146`
