# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **365 models / 346 enums / ~17,400 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L16235`
- `AccountMapping` → `schema.prisma:L16131`
- `ActivityLog` → `schema.prisma:L6742`
- `Aggregator` → `schema.prisma:L14528`
- `AngelPayUserAccount` → `schema.prisma:L5405`
- `AppUpdate` → `schema.prisma:L12693`
- `Area` → `schema.prisma:L3038`
- `AreaTicket` → `schema.prisma:L15026`
- `AreaTicketCheckoutSession` → `schema.prisma:L15148`
- `AreaTicketExternalIncident` → `schema.prisma:L15395`
- `AreaTicketExternalSettlement` → `schema.prisma:L15360`
- `AreaTicketFulfillment` → `schema.prisma:L15224`
- `AreaTicketInventoryReservation` → `schema.prisma:L15119`
- `AreaTicketLine` → `schema.prisma:L15087`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15180`
- `AreaTicketPrintAttempt` → `schema.prisma:L15203`
- `BankStatement` → `schema.prisma:L16005`
- `BankStatementLine` → `schema.prisma:L16026`
- `BillingTaxProfile` → `schema.prisma:L16815`
- `BirthdayAutomation` → `schema.prisma:L7059`
- `BulkCommandOperation` → `schema.prisma:L9973`
- `CalendarSyncOutbox` → `schema.prisma:L13900`
- `CampaignDelivery` → `schema.prisma:L12851`
- `CashCloseout` → `schema.prisma:L10358`
- `CashDeposit` → `schema.prisma:L12495`
- `CashDrawerEvent` → `schema.prisma:L14365`
- `CashDrawerSession` → `schema.prisma:L14326`
- `CashOutCommissionRate` → `schema.prisma:L16644`
- `CashOutScheduleDay` → `schema.prisma:L16667`
- `CashOutWithdrawal` → `schema.prisma:L16729`
- `CatalogBindingBatch` → `schema.prisma:L11389`
- `CatalogBindingLine` → `schema.prisma:L11425`
- `CatalogBrand` → `schema.prisma:L10842`
- `CatalogClientObservation` → `schema.prisma:L11155`
- `CatalogClientReadinessOverride` → `schema.prisma:L11174`
- `CatalogFamily` → `schema.prisma:L10892`
- `CatalogIdempotencyRecord` → `schema.prisma:L11288`
- `CatalogIdentifier` → `schema.prisma:L11023`
- `CatalogImportBatch` → `schema.prisma:L11331`
- `CatalogImportLine` → `schema.prisma:L11368`
- `CatalogItem` → `schema.prisma:L10925`
- `CatalogItemBusinessType` → `schema.prisma:L10985`
- `CatalogItemPrice` → `schema.prisma:L11073`
- `CatalogManufacturer` → `schema.prisma:L10866`
- `CatalogProductTypeMapping` → `schema.prisma:L11002`
- `CatalogPublicationBatch` → `schema.prisma:L11453`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11547`
- `CatalogPublicationLine` → `schema.prisma:L11494`
- `CatalogPublicationOutbox` → `schema.prisma:L11590`
- `CatalogValidationProfile` → `schema.prisma:L11044`
- `CatalogVenueBinding` → `schema.prisma:L11202`
- `CatalogVenueClientRequirement` → `schema.prisma:L11129`
- `CatalogVenueEventSequence` → `schema.prisma:L11573`
- `CatalogVenueOverride` → `schema.prisma:L11244`
- `CatalogVenueRollout` → `schema.prisma:L11104`
- `Cfdi` → `schema.prisma:L15908`
- `ChatbotTokenBudget` → `schema.prisma:L9621`
- `ChatConversation` → `schema.prisma:L9476`
- `ChatFeedback` → `schema.prisma:L9562`
- `ChatLearningEvent` → `schema.prisma:L9519`
- `ChatMessage` → `schema.prisma:L9499`
- `ChatTrainingData` → `schema.prisma:L9433`
- `CheckoutSession` → `schema.prisma:L5685`
- `ClassSession` → `schema.prisma:L13504`
- `CommissionCalculation` → `schema.prisma:L12271`
- `CommissionClawback` → `schema.prisma:L12447`
- `CommissionConfig` → `schema.prisma:L12037`
- `CommissionMilestone` → `schema.prisma:L12187`
- `CommissionOverride` → `schema.prisma:L12114`
- `CommissionPayout` → `schema.prisma:L12398`
- `CommissionSummary` → `schema.prisma:L12337`
- `CommissionTier` → `schema.prisma:L12151`
- `ConsentEvent` → `schema.prisma:L6925`
- `Consumer` → `schema.prisma:L7151`
- `ConsumerAuthAccount` → `schema.prisma:L7176`
- `CouponCode` → `schema.prisma:L8123`
- `CouponRedemption` → `schema.prisma:L8154`
- `CreditAssessmentHistory` → `schema.prisma:L10467`
- `CreditItemBalance` → `schema.prisma:L14116`
- `CreditOffer` → `schema.prisma:L10486`
- `CreditPack` → `schema.prisma:L14025`
- `CreditPackItem` → `schema.prisma:L14054`
- `CreditPackPurchase` → `schema.prisma:L14071`
- `CreditTransaction` → `schema.prisma:L14138`
- `Customer` → `schema.prisma:L6783`
- `CustomerApprovalDelivery` → `schema.prisma:L9135`
- `CustomerApprovalOutbox` → `schema.prisma:L9110`
- `CustomerCampaign` → `schema.prisma:L7009`
- `CustomerCampaignDelivery` → `schema.prisma:L7091`
- `CustomerCaptureToken` → `schema.prisma:L6961`
- `CustomerDiscount` → `schema.prisma:L8174`
- `CustomerGroup` → `schema.prisma:L7215`
- `CustomerOrderMetric` → `schema.prisma:L3808`
- `CustomerTaxProfile` → `schema.prisma:L15977`
- `DeliveryActivationRequest` → `schema.prisma:L6026`
- `DeliveryChannelLink` → `schema.prisma:L5971`
- `DeliveryOrderEvent` → `schema.prisma:L6050`
- `DeviceToken` → `schema.prisma:L8443`
- `DigitalReceipt` → `schema.prisma:L4379`
- `Discount` → `schema.prisma:L7813`
- `EcommerceMerchant` → `schema.prisma:L5497`
- `EmailQuotaLedger` → `schema.prisma:L7138`
- `EmailSuppression` → `schema.prisma:L7126`
- `EmailTemplate` → `schema.prisma:L12790`
- `Employee` → `schema.prisma:L16492`
- `Estimate` → `schema.prisma:L14435`
- `EstimateItem` → `schema.prisma:L14463`
- `Expense` → `schema.prisma:L16279`
- `ExternalBusyBlock` → `schema.prisma:L13793`
- `Feature` → `schema.prisma:L4508`
- `FeeSchedule` → `schema.prisma:L4586`
- `FeeTier` → `schema.prisma:L4597`
- `FinancialAccount` → `schema.prisma:L14625`
- `FinancialConnection` → `schema.prisma:L14594`
- `FinancialProvider` → `schema.prisma:L14580`
- `FiscalEmisor` → `schema.prisma:L15831`
- `FiscalLossCarryforward` → `schema.prisma:L16402`
- `FixedAsset` → `schema.prisma:L16420`
- `FixedAssetDepreciation` → `schema.prisma:L16449`
- `FloorElement` → `schema.prisma:L3114`
- `FulfillmentArea` → `schema.prisma:L14891`
- `GeofenceRule` → `schema.prisma:L10058`
- `GoogleCalendarChannel` → `schema.prisma:L13770`
- `GoogleCalendarConnection` → `schema.prisma:L13722`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13823`
- `GoogleOAuthSession` → `schema.prisma:L13845`
- `HolidayCalendar` → `schema.prisma:L6666`
- `IdempotencyRequest` → `schema.prisma:L11912`
- `InterVenueTransfer` → `schema.prisma:L2866`
- `InterVenueTransferAllocation` → `schema.prisma:L2949`
- `InterVenueTransferItem` → `schema.prisma:L2918`
- `InterVenueTransferReceipt` → `schema.prisma:L2976`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2992`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3020`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3004`
- `Inventory` → `schema.prisma:L1912`
- `InventoryMovement` → `schema.prisma:L1939`
- `InventoryPosting` → `schema.prisma:L2021`
- `InventoryPostingLine` → `schema.prisma:L2061`
- `InventoryTransfer` → `schema.prisma:L14407`
- `Invitation` → `schema.prisma:L1450`
- `Invoice` → `schema.prisma:L4609`
- `InvoiceItem` → `schema.prisma:L4635`
- `ItemCategory` → `schema.prisma:L11625`
- `JournalEntry` → `schema.prisma:L16189`
- `JournalLine` → `schema.prisma:L16217`
- `KdsOrder` → `schema.prisma:L14673`
- `KdsOrderItem` → `schema.prisma:L14714`
- `KioskCheckInAttempt` → `schema.prisma:L17138`
- `KioskCheckInChallenge` → `schema.prisma:L17092`
- `KioskOutreachOutbox` → `schema.prisma:L17159`
- `LearnedPatterns` → `schema.prisma:L9543`
- `LedgerAccount` → `schema.prisma:L16081`
- `LiveDemoSession` → `schema.prisma:L795`
- `LowStockAlert` → `schema.prisma:L2707`
- `LoyaltyConfig` → `schema.prisma:L7245`
- `LoyaltyTransaction` → `schema.prisma:L7288`
- `MarketingCampaign` → `schema.prisma:L12808`
- `McpAuthCode` → `schema.prisma:L15714`
- `McpOAuthClient` → `schema.prisma:L15698`
- `McpRefreshToken` → `schema.prisma:L15732`
- `McpToolCall` → `schema.prisma:L15753`
- `MeasurementUnit` → `schema.prisma:L14513`
- `Menu` → `schema.prisma:L1636`
- `MenuCategory` → `schema.prisma:L1573`
- `MenuCategoryAssignment` → `schema.prisma:L1671`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15628`
- `MerchantAccount` → `schema.prisma:L5235`
- `MerchantFiscalConfig` → `schema.prisma:L15879`
- `MerchantRevenueShare` → `schema.prisma:L6246`
- `MerchantRoutingRule` → `schema.prisma:L5357`
- `MilestoneAchievement` → `schema.prisma:L12232`
- `Modifier` → `schema.prisma:L3992`
- `ModifierGroup` → `schema.prisma:L3956`
- `Module` → `schema.prisma:L10534`
- `MoneyAnomaly` → `schema.prisma:L6149`
- `MonthlyVenueProfit` → `schema.prisma:L6692`
- `Notification` → `schema.prisma:L8345`
- `NotificationPreference` → `schema.prisma:L8392`
- `NotificationTemplate` → `schema.prisma:L8419`
- `OAuthState` → `schema.prisma:L1501`
- `OnboardingProgress` → `schema.prisma:L1519`
- `Order` → `schema.prisma:L3563`
- `OrderAction` → `schema.prisma:L4059`
- `OrderCustomer` → `schema.prisma:L3787`
- `OrderDiscount` → `schema.prisma:L8206`
- `OrderFulfillment` → `schema.prisma:L14946`
- `OrderFulfillmentLine` → `schema.prisma:L14977`
- `OrderItem` → `schema.prisma:L3823`
- `OrderItemModifier` → `schema.prisma:L4041`
- `OrderPromotion` → `schema.prisma:L17055`
- `OrderServiceCharge` → `schema.prisma:L8290`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12609`
- `OrganizationEntitlement` → `schema.prisma:L10817`
- `OrganizationGoal` → `schema.prisma:L12567`
- `OrganizationModule` → `schema.prisma:L10594`
- `OrganizationPaymentConfig` → `schema.prisma:L5809`
- `OrganizationPayoutConfig` → `schema.prisma:L12642`
- `OrganizationPricingStructure` → `schema.prisma:L5841`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12590`
- `OtpChallenge` → `schema.prisma:L7195`
- `OvertimeApproval` → `schema.prisma:L3341`
- `PartnerAPIKey` → `schema.prisma:L5639`
- `Payment` → `schema.prisma:L4092`
- `PaymentAllocation` → `schema.prisma:L4358`
- `PaymentLink` → `schema.prisma:L14184`
- `PaymentLinkAttribution` → `schema.prisma:L14292`
- `PaymentLinkItem` → `schema.prisma:L14247`
- `PaymentLinkItemModifier` → `schema.prisma:L14274`
- `PaymentProvider` → `schema.prisma:L5194`
- `PayrollLine` → `schema.prisma:L16563`
- `PayrollRun` → `schema.prisma:L16532`
- `PerformanceGoal` → `schema.prisma:L12544`
- `PermissionOverride` → `schema.prisma:L1374`
- `PermissionSet` → `schema.prisma:L1397`
- `PlatformAnnouncement` → `schema.prisma:L17219`
- `PlatformAnnouncementClick` → `schema.prisma:L17284`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17321`
- `PlatformCfdi` → `schema.prisma:L16848`
- `PlatformEmisor` → `schema.prisma:L16788`
- `PlatformSettings` → `schema.prisma:L5616`
- `PosCommand` → `schema.prisma:L8473`
- `PosConnectionStatus` → `schema.prisma:L921`
- `PosSyncIntent` → `schema.prisma:L16926`
- `PricingPolicy` → `schema.prisma:L2611`
- `Printer` → `schema.prisma:L14756`
- `PrintGateway` → `schema.prisma:L14813`
- `PrintJob` → `schema.prisma:L15527`
- `PrintStation` → `schema.prisma:L14831`
- `PrivacyNoticeVersion` → `schema.prisma:L6947`
- `ProcessedStripeEvent` → `schema.prisma:L6135`
- `ProcessorReliabilityMetric` → `schema.prisma:L6620`
- `Product` → `schema.prisma:L1689`
- `ProductModifierGroup` → `schema.prisma:L4029`
- `ProductOption` → `schema.prisma:L14490`
- `ProductOptionValue` → `schema.prisma:L14501`
- `ProductStaff` → `schema.prisma:L13419`
- `PromoterBankAccount` → `schema.prisma:L16683`
- `PromoterCommissionEntry` → `schema.prisma:L16702`
- `PromoterLocationPing` → `schema.prisma:L3529`
- `Promotion` → `schema.prisma:L16977`
- `PromotionGroup` → `schema.prisma:L17016`
- `PromotionOption` → `schema.prisma:L17032`
- `ProviderCostStructure` → `schema.prisma:L6171`
- `ProviderEventLog` → `schema.prisma:L5918`
- `PurchaseOrder` → `schema.prisma:L2336`
- `PurchaseOrderInvoice` → `schema.prisma:L2481`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2538`
- `PurchaseOrderItem` → `schema.prisma:L2394`
- `RateCorrectionBatch` → `schema.prisma:L6396`
- `RateCorrectionEntry` → `schema.prisma:L6438`
- `RawMaterial` → `schema.prisma:L2093`
- `RawMaterialMovement` → `schema.prisma:L2664`
- `RawMaterialPresentation` → `schema.prisma:L2168`
- `Recipe` → `schema.prisma:L2188`
- `RecipeLine` → `schema.prisma:L2212`
- `Referral` → `schema.prisma:L7661`
- `ReferralProgramConfig` → `schema.prisma:L7626`
- `ReferralRewardGrant` → `schema.prisma:L7752`
- `ReferralTierReward` → `schema.prisma:L7724`
- `ReferralTierUnlock` → `schema.prisma:L7797`
- `RefreshGrant` → `schema.prisma:L17408`
- `Reservation` → `schema.prisma:L13187`
- `ReservationGoogleEventMapping` → `schema.prisma:L13957`
- `ReservationModifier` → `schema.prisma:L13367`
- `ReservationReminderSent` → `schema.prisma:L13350`
- `ReservationSettings` → `schema.prisma:L13581`
- `ReservationWaitlistEntry` → `schema.prisma:L13549`
- `Review` → `schema.prisma:L4653`
- `SalesRetention` → `schema.prisma:L16383`
- `SaleVerification` → `schema.prisma:L4412`
- `ScaleProfile` → `schema.prisma:L15268`
- `ScheduledCommand` → `schema.prisma:L10018`
- `SerializedItem` → `schema.prisma:L11668`
- `SerializedItemCustodyEvent` → `schema.prisma:L11835`
- `ServiceCharge` → `schema.prisma:L8261`
- `Session` → `schema.prisma:L17387`
- `SettlementConfiguration` → `schema.prisma:L6471`
- `SettlementConfirmation` → `schema.prisma:L6584`
- `SettlementIncident` → `schema.prisma:L6535`
- `SettlementSimulation` → `schema.prisma:L6506`
- `Shift` → `schema.prisma:L3152`
- `SimRegistrationRequest` → `schema.prisma:L11873`
- `SimRegistrationRequestItem` → `schema.prisma:L11895`
- `SlotHold` → `schema.prisma:L13450`
- `Staff` → `schema.prisma:L941`
- `StaffDocument` → `schema.prisma:L3400`
- `StaffOnboardingState` → `schema.prisma:L15598`
- `StaffOrganization` → `schema.prisma:L1273`
- `StaffPasskey` → `schema.prisma:L1300`
- `StaffSchedule` → `schema.prisma:L13390`
- `StaffScheduleException` → `schema.prisma:L13402`
- `StaffVenue` → `schema.prisma:L1197`
- `StaffWorkSchedule` → `schema.prisma:L3277`
- `StaffWorkScheduleException` → `schema.prisma:L3375`
- `StampCard` → `schema.prisma:L7509`
- `StampEvent` → `schema.prisma:L7548`
- `StampReward` → `schema.prisma:L7586`
- `StockAlertConfig` → `schema.prisma:L12526`
- `StockBatch` → `schema.prisma:L2815`
- `StockCount` → `schema.prisma:L2739`
- `StockCountItem` → `schema.prisma:L2763`
- `StripeWebhookEvent` → `schema.prisma:L6118`
- `Supplier` → `schema.prisma:L2247`
- `SupplierItemCode` → `schema.prisma:L2579`
- `SupplierPricing` → `schema.prisma:L2302`
- `Table` → `schema.prisma:L3064`
- `Terminal` → `schema.prisma:L4704`
- `TerminalHealth` → `schema.prisma:L4955`
- `TerminalLog` → `schema.prisma:L4929`
- `TerminalOrder` → `schema.prisma:L5097`
- `TerminalOrderItem` → `schema.prisma:L5172`
- `TerminalPaymentRequest` → `schema.prisma:L5026`
- `TimeEntry` → `schema.prisma:L3442`
- `TimeEntryBreak` → `schema.prisma:L3511`
- `TokenPurchase` → `schema.prisma:L9692`
- `TokenUsageRecord` → `schema.prisma:L9664`
- `TpvCommandHistory` → `schema.prisma:L9924`
- `TpvCommandQueue` → `schema.prisma:L9864`
- `TpvFeedback` → `schema.prisma:L9577`
- `TpvMessage` → `schema.prisma:L12883`
- `TpvMessageDelivery` → `schema.prisma:L12935`
- `TpvMessageResponse` → `schema.prisma:L12958`
- `TrainingModule` → `schema.prisma:L13013`
- `TrainingProgress` → `schema.prisma:L13090`
- `TrainingQuizQuestion` → `schema.prisma:L13072`
- `TrainingStep` → `schema.prisma:L13052`
- `TransactionCost` → `schema.prisma:L6334`
- `UnitConversion` → `schema.prisma:L2642`
- `UpsellAcceptance` → `schema.prisma:L8082`
- `UpsellAiRun` → `schema.prisma:L8102`
- `UpsellImpression` → `schema.prisma:L8042`
- `UpsellRule` → `schema.prisma:L7962`
- `user_sessions` → `schema.prisma:L5674`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L15005`
- `VenueChatMessage` → `schema.prisma:L771`
- `VenueChatSession` → `schema.prisma:L726`
- `VenueCommission` → `schema.prisma:L14651`
- `VenueCreditAssessment` → `schema.prisma:L10406`
- `VenueCryptoConfig` → `schema.prisma:L12750`
- `VenueFeature` → `schema.prisma:L4526`
- `VenueModule` → `schema.prisma:L10566`
- `VenuePaymentConfig` → `schema.prisma:L5775`
- `VenuePaymentLinkSettings` → `schema.prisma:L13990`
- `VenuePricingStructure` → `schema.prisma:L6274`
- `VenueRoleConfig` → `schema.prisma:L1426`
- `VenueRolePermission` → `schema.prisma:L1330`
- `VenueScaleSettings` → `schema.prisma:L15256`
- `VenueSettings` → `schema.prisma:L811`
- `VenueTenderType` → `schema.prisma:L4271`
- `VenueTenderTypeRevision` → `schema.prisma:L4336`
- `VenueTransaction` → `schema.prisma:L4463`
- `VenueWhatsappActivation` → `schema.prisma:L662`
- `WalletCardDesign` → `schema.prisma:L7427`
- `WalletPass` → `schema.prisma:L7328`
- `WalletPassRegistration` → `schema.prisma:L7394`
- `WebhookEvent` → `schema.prisma:L4562`
- `WebhookSubscription` → `schema.prisma:L5891`
- `WhatsappContactWindow` → `schema.prisma:L680`
- `WhatsappInboundEvent` → `schema.prisma:L700`
- `WorkShiftAssignment` → `schema.prisma:L3317`
- `WorkShiftTemplate` → `schema.prisma:L3294`
- `Zone` → `schema.prisma:L142`
