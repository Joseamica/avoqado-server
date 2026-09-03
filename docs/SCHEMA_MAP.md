# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **365 models / 346 enums / ~17,300 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L16178`
- `AccountMapping` → `schema.prisma:L16074`
- `ActivityLog` → `schema.prisma:L6713`
- `Aggregator` → `schema.prisma:L14471`
- `AngelPayUserAccount` → `schema.prisma:L5376`
- `AppUpdate` → `schema.prisma:L12651`
- `Area` → `schema.prisma:L3036`
- `AreaTicket` → `schema.prisma:L14969`
- `AreaTicketCheckoutSession` → `schema.prisma:L15091`
- `AreaTicketExternalIncident` → `schema.prisma:L15338`
- `AreaTicketExternalSettlement` → `schema.prisma:L15303`
- `AreaTicketFulfillment` → `schema.prisma:L15167`
- `AreaTicketInventoryReservation` → `schema.prisma:L15062`
- `AreaTicketLine` → `schema.prisma:L15030`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15123`
- `AreaTicketPrintAttempt` → `schema.prisma:L15146`
- `BankStatement` → `schema.prisma:L15948`
- `BankStatementLine` → `schema.prisma:L15969`
- `BillingTaxProfile` → `schema.prisma:L16758`
- `BirthdayAutomation` → `schema.prisma:L7030`
- `BulkCommandOperation` → `schema.prisma:L9931`
- `CalendarSyncOutbox` → `schema.prisma:L13858`
- `CampaignDelivery` → `schema.prisma:L12809`
- `CashCloseout` → `schema.prisma:L10316`
- `CashDeposit` → `schema.prisma:L12453`
- `CashDrawerEvent` → `schema.prisma:L14308`
- `CashDrawerSession` → `schema.prisma:L14284`
- `CashOutCommissionRate` → `schema.prisma:L16587`
- `CashOutScheduleDay` → `schema.prisma:L16610`
- `CashOutWithdrawal` → `schema.prisma:L16672`
- `CatalogBindingBatch` → `schema.prisma:L11347`
- `CatalogBindingLine` → `schema.prisma:L11383`
- `CatalogBrand` → `schema.prisma:L10800`
- `CatalogClientObservation` → `schema.prisma:L11113`
- `CatalogClientReadinessOverride` → `schema.prisma:L11132`
- `CatalogFamily` → `schema.prisma:L10850`
- `CatalogIdempotencyRecord` → `schema.prisma:L11246`
- `CatalogIdentifier` → `schema.prisma:L10981`
- `CatalogImportBatch` → `schema.prisma:L11289`
- `CatalogImportLine` → `schema.prisma:L11326`
- `CatalogItem` → `schema.prisma:L10883`
- `CatalogItemBusinessType` → `schema.prisma:L10943`
- `CatalogItemPrice` → `schema.prisma:L11031`
- `CatalogManufacturer` → `schema.prisma:L10824`
- `CatalogProductTypeMapping` → `schema.prisma:L10960`
- `CatalogPublicationBatch` → `schema.prisma:L11411`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11505`
- `CatalogPublicationLine` → `schema.prisma:L11452`
- `CatalogPublicationOutbox` → `schema.prisma:L11548`
- `CatalogValidationProfile` → `schema.prisma:L11002`
- `CatalogVenueBinding` → `schema.prisma:L11160`
- `CatalogVenueClientRequirement` → `schema.prisma:L11087`
- `CatalogVenueEventSequence` → `schema.prisma:L11531`
- `CatalogVenueOverride` → `schema.prisma:L11202`
- `CatalogVenueRollout` → `schema.prisma:L11062`
- `Cfdi` → `schema.prisma:L15851`
- `ChatbotTokenBudget` → `schema.prisma:L9579`
- `ChatConversation` → `schema.prisma:L9434`
- `ChatFeedback` → `schema.prisma:L9520`
- `ChatLearningEvent` → `schema.prisma:L9477`
- `ChatMessage` → `schema.prisma:L9457`
- `ChatTrainingData` → `schema.prisma:L9391`
- `CheckoutSession` → `schema.prisma:L5656`
- `ClassSession` → `schema.prisma:L13462`
- `CommissionCalculation` → `schema.prisma:L12229`
- `CommissionClawback` → `schema.prisma:L12405`
- `CommissionConfig` → `schema.prisma:L11995`
- `CommissionMilestone` → `schema.prisma:L12145`
- `CommissionOverride` → `schema.prisma:L12072`
- `CommissionPayout` → `schema.prisma:L12356`
- `CommissionSummary` → `schema.prisma:L12295`
- `CommissionTier` → `schema.prisma:L12109`
- `ConsentEvent` → `schema.prisma:L6896`
- `Consumer` → `schema.prisma:L7122`
- `ConsumerAuthAccount` → `schema.prisma:L7147`
- `CouponCode` → `schema.prisma:L8086`
- `CouponRedemption` → `schema.prisma:L8117`
- `CreditAssessmentHistory` → `schema.prisma:L10425`
- `CreditItemBalance` → `schema.prisma:L14074`
- `CreditOffer` → `schema.prisma:L10444`
- `CreditPack` → `schema.prisma:L13983`
- `CreditPackItem` → `schema.prisma:L14012`
- `CreditPackPurchase` → `schema.prisma:L14029`
- `CreditTransaction` → `schema.prisma:L14096`
- `Customer` → `schema.prisma:L6754`
- `CustomerApprovalDelivery` → `schema.prisma:L9093`
- `CustomerApprovalOutbox` → `schema.prisma:L9068`
- `CustomerCampaign` → `schema.prisma:L6980`
- `CustomerCampaignDelivery` → `schema.prisma:L7062`
- `CustomerCaptureToken` → `schema.prisma:L6932`
- `CustomerDiscount` → `schema.prisma:L8137`
- `CustomerGroup` → `schema.prisma:L7186`
- `CustomerOrderMetric` → `schema.prisma:L3788`
- `CustomerTaxProfile` → `schema.prisma:L15920`
- `DeliveryActivationRequest` → `schema.prisma:L5997`
- `DeliveryChannelLink` → `schema.prisma:L5942`
- `DeliveryOrderEvent` → `schema.prisma:L6021`
- `DeviceToken` → `schema.prisma:L8406`
- `DigitalReceipt` → `schema.prisma:L4359`
- `Discount` → `schema.prisma:L7776`
- `EcommerceMerchant` → `schema.prisma:L5468`
- `EmailQuotaLedger` → `schema.prisma:L7109`
- `EmailSuppression` → `schema.prisma:L7097`
- `EmailTemplate` → `schema.prisma:L12748`
- `Employee` → `schema.prisma:L16435`
- `Estimate` → `schema.prisma:L14378`
- `EstimateItem` → `schema.prisma:L14406`
- `Expense` → `schema.prisma:L16222`
- `ExternalBusyBlock` → `schema.prisma:L13751`
- `Feature` → `schema.prisma:L4488`
- `FeeSchedule` → `schema.prisma:L4566`
- `FeeTier` → `schema.prisma:L4577`
- `FinancialAccount` → `schema.prisma:L14568`
- `FinancialConnection` → `schema.prisma:L14537`
- `FinancialProvider` → `schema.prisma:L14523`
- `FiscalEmisor` → `schema.prisma:L15774`
- `FiscalLossCarryforward` → `schema.prisma:L16345`
- `FixedAsset` → `schema.prisma:L16363`
- `FixedAssetDepreciation` → `schema.prisma:L16392`
- `FloorElement` → `schema.prisma:L3112`
- `FulfillmentArea` → `schema.prisma:L14834`
- `GeofenceRule` → `schema.prisma:L10016`
- `GoogleCalendarChannel` → `schema.prisma:L13728`
- `GoogleCalendarConnection` → `schema.prisma:L13680`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13781`
- `GoogleOAuthSession` → `schema.prisma:L13803`
- `HolidayCalendar` → `schema.prisma:L6637`
- `IdempotencyRequest` → `schema.prisma:L11870`
- `InterVenueTransfer` → `schema.prisma:L2864`
- `InterVenueTransferAllocation` → `schema.prisma:L2947`
- `InterVenueTransferItem` → `schema.prisma:L2916`
- `InterVenueTransferReceipt` → `schema.prisma:L2974`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2990`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3018`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3002`
- `Inventory` → `schema.prisma:L1910`
- `InventoryMovement` → `schema.prisma:L1937`
- `InventoryPosting` → `schema.prisma:L2019`
- `InventoryPostingLine` → `schema.prisma:L2059`
- `InventoryTransfer` → `schema.prisma:L14350`
- `Invitation` → `schema.prisma:L1448`
- `Invoice` → `schema.prisma:L4589`
- `InvoiceItem` → `schema.prisma:L4615`
- `ItemCategory` → `schema.prisma:L11583`
- `JournalEntry` → `schema.prisma:L16132`
- `JournalLine` → `schema.prisma:L16160`
- `KdsOrder` → `schema.prisma:L14616`
- `KdsOrderItem` → `schema.prisma:L14657`
- `KioskCheckInAttempt` → `schema.prisma:L17081`
- `KioskCheckInChallenge` → `schema.prisma:L17035`
- `KioskOutreachOutbox` → `schema.prisma:L17102`
- `LearnedPatterns` → `schema.prisma:L9501`
- `LedgerAccount` → `schema.prisma:L16024`
- `LiveDemoSession` → `schema.prisma:L795`
- `LowStockAlert` → `schema.prisma:L2705`
- `LoyaltyConfig` → `schema.prisma:L7216`
- `LoyaltyTransaction` → `schema.prisma:L7259`
- `MarketingCampaign` → `schema.prisma:L12766`
- `McpAuthCode` → `schema.prisma:L15657`
- `McpOAuthClient` → `schema.prisma:L15641`
- `McpRefreshToken` → `schema.prisma:L15675`
- `McpToolCall` → `schema.prisma:L15696`
- `MeasurementUnit` → `schema.prisma:L14456`
- `Menu` → `schema.prisma:L1634`
- `MenuCategory` → `schema.prisma:L1571`
- `MenuCategoryAssignment` → `schema.prisma:L1669`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15571`
- `MerchantAccount` → `schema.prisma:L5206`
- `MerchantFiscalConfig` → `schema.prisma:L15822`
- `MerchantRevenueShare` → `schema.prisma:L6217`
- `MerchantRoutingRule` → `schema.prisma:L5328`
- `MilestoneAchievement` → `schema.prisma:L12190`
- `Modifier` → `schema.prisma:L3972`
- `ModifierGroup` → `schema.prisma:L3936`
- `Module` → `schema.prisma:L10492`
- `MoneyAnomaly` → `schema.prisma:L6120`
- `MonthlyVenueProfit` → `schema.prisma:L6663`
- `Notification` → `schema.prisma:L8308`
- `NotificationPreference` → `schema.prisma:L8355`
- `NotificationTemplate` → `schema.prisma:L8382`
- `OAuthState` → `schema.prisma:L1499`
- `OnboardingProgress` → `schema.prisma:L1517`
- `Order` → `schema.prisma:L3543`
- `OrderAction` → `schema.prisma:L4039`
- `OrderCustomer` → `schema.prisma:L3767`
- `OrderDiscount` → `schema.prisma:L8169`
- `OrderFulfillment` → `schema.prisma:L14889`
- `OrderFulfillmentLine` → `schema.prisma:L14920`
- `OrderItem` → `schema.prisma:L3803`
- `OrderItemModifier` → `schema.prisma:L4021`
- `OrderPromotion` → `schema.prisma:L16998`
- `OrderServiceCharge` → `schema.prisma:L8253`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12567`
- `OrganizationEntitlement` → `schema.prisma:L10775`
- `OrganizationGoal` → `schema.prisma:L12525`
- `OrganizationModule` → `schema.prisma:L10552`
- `OrganizationPaymentConfig` → `schema.prisma:L5780`
- `OrganizationPayoutConfig` → `schema.prisma:L12600`
- `OrganizationPricingStructure` → `schema.prisma:L5812`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12548`
- `OtpChallenge` → `schema.prisma:L7166`
- `OvertimeApproval` → `schema.prisma:L3321`
- `PartnerAPIKey` → `schema.prisma:L5610`
- `Payment` → `schema.prisma:L4072`
- `PaymentAllocation` → `schema.prisma:L4338`
- `PaymentLink` → `schema.prisma:L14142`
- `PaymentLinkAttribution` → `schema.prisma:L14250`
- `PaymentLinkItem` → `schema.prisma:L14205`
- `PaymentLinkItemModifier` → `schema.prisma:L14232`
- `PaymentProvider` → `schema.prisma:L5165`
- `PayrollLine` → `schema.prisma:L16506`
- `PayrollRun` → `schema.prisma:L16475`
- `PerformanceGoal` → `schema.prisma:L12502`
- `PermissionOverride` → `schema.prisma:L1372`
- `PermissionSet` → `schema.prisma:L1395`
- `PlatformAnnouncement` → `schema.prisma:L17162`
- `PlatformAnnouncementClick` → `schema.prisma:L17227`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17264`
- `PlatformCfdi` → `schema.prisma:L16791`
- `PlatformEmisor` → `schema.prisma:L16731`
- `PlatformSettings` → `schema.prisma:L5587`
- `PosCommand` → `schema.prisma:L8436`
- `PosConnectionStatus` → `schema.prisma:L921`
- `PosSyncIntent` → `schema.prisma:L16869`
- `PricingPolicy` → `schema.prisma:L2609`
- `Printer` → `schema.prisma:L14699`
- `PrintGateway` → `schema.prisma:L14756`
- `PrintJob` → `schema.prisma:L15470`
- `PrintStation` → `schema.prisma:L14774`
- `PrivacyNoticeVersion` → `schema.prisma:L6918`
- `ProcessedStripeEvent` → `schema.prisma:L6106`
- `ProcessorReliabilityMetric` → `schema.prisma:L6591`
- `Product` → `schema.prisma:L1687`
- `ProductModifierGroup` → `schema.prisma:L4009`
- `ProductOption` → `schema.prisma:L14433`
- `ProductOptionValue` → `schema.prisma:L14444`
- `ProductStaff` → `schema.prisma:L13377`
- `PromoterBankAccount` → `schema.prisma:L16626`
- `PromoterCommissionEntry` → `schema.prisma:L16645`
- `PromoterLocationPing` → `schema.prisma:L3509`
- `Promotion` → `schema.prisma:L16920`
- `PromotionGroup` → `schema.prisma:L16959`
- `PromotionOption` → `schema.prisma:L16975`
- `ProviderCostStructure` → `schema.prisma:L6142`
- `ProviderEventLog` → `schema.prisma:L5889`
- `PurchaseOrder` → `schema.prisma:L2334`
- `PurchaseOrderInvoice` → `schema.prisma:L2479`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2536`
- `PurchaseOrderItem` → `schema.prisma:L2392`
- `RateCorrectionBatch` → `schema.prisma:L6367`
- `RateCorrectionEntry` → `schema.prisma:L6409`
- `RawMaterial` → `schema.prisma:L2091`
- `RawMaterialMovement` → `schema.prisma:L2662`
- `RawMaterialPresentation` → `schema.prisma:L2166`
- `Recipe` → `schema.prisma:L2186`
- `RecipeLine` → `schema.prisma:L2210`
- `Referral` → `schema.prisma:L7624`
- `ReferralProgramConfig` → `schema.prisma:L7589`
- `ReferralRewardGrant` → `schema.prisma:L7715`
- `ReferralTierReward` → `schema.prisma:L7687`
- `ReferralTierUnlock` → `schema.prisma:L7760`
- `RefreshGrant` → `schema.prisma:L17351`
- `Reservation` → `schema.prisma:L13145`
- `ReservationGoogleEventMapping` → `schema.prisma:L13915`
- `ReservationModifier` → `schema.prisma:L13325`
- `ReservationReminderSent` → `schema.prisma:L13308`
- `ReservationSettings` → `schema.prisma:L13539`
- `ReservationWaitlistEntry` → `schema.prisma:L13507`
- `Review` → `schema.prisma:L4633`
- `SalesRetention` → `schema.prisma:L16326`
- `SaleVerification` → `schema.prisma:L4392`
- `ScaleProfile` → `schema.prisma:L15211`
- `ScheduledCommand` → `schema.prisma:L9976`
- `SerializedItem` → `schema.prisma:L11626`
- `SerializedItemCustodyEvent` → `schema.prisma:L11793`
- `ServiceCharge` → `schema.prisma:L8224`
- `Session` → `schema.prisma:L17330`
- `SettlementConfiguration` → `schema.prisma:L6442`
- `SettlementConfirmation` → `schema.prisma:L6555`
- `SettlementIncident` → `schema.prisma:L6506`
- `SettlementSimulation` → `schema.prisma:L6477`
- `Shift` → `schema.prisma:L3150`
- `SimRegistrationRequest` → `schema.prisma:L11831`
- `SimRegistrationRequestItem` → `schema.prisma:L11853`
- `SlotHold` → `schema.prisma:L13408`
- `Staff` → `schema.prisma:L941`
- `StaffDocument` → `schema.prisma:L3380`
- `StaffOnboardingState` → `schema.prisma:L15541`
- `StaffOrganization` → `schema.prisma:L1271`
- `StaffPasskey` → `schema.prisma:L1298`
- `StaffSchedule` → `schema.prisma:L13348`
- `StaffScheduleException` → `schema.prisma:L13360`
- `StaffVenue` → `schema.prisma:L1195`
- `StaffWorkSchedule` → `schema.prisma:L3257`
- `StaffWorkScheduleException` → `schema.prisma:L3355`
- `StampCard` → `schema.prisma:L7472`
- `StampEvent` → `schema.prisma:L7511`
- `StampReward` → `schema.prisma:L7549`
- `StockAlertConfig` → `schema.prisma:L12484`
- `StockBatch` → `schema.prisma:L2813`
- `StockCount` → `schema.prisma:L2737`
- `StockCountItem` → `schema.prisma:L2761`
- `StripeWebhookEvent` → `schema.prisma:L6089`
- `Supplier` → `schema.prisma:L2245`
- `SupplierItemCode` → `schema.prisma:L2577`
- `SupplierPricing` → `schema.prisma:L2300`
- `Table` → `schema.prisma:L3062`
- `Terminal` → `schema.prisma:L4684`
- `TerminalHealth` → `schema.prisma:L4935`
- `TerminalLog` → `schema.prisma:L4909`
- `TerminalOrder` → `schema.prisma:L5068`
- `TerminalOrderItem` → `schema.prisma:L5143`
- `TerminalPaymentRequest` → `schema.prisma:L5006`
- `TimeEntry` → `schema.prisma:L3422`
- `TimeEntryBreak` → `schema.prisma:L3491`
- `TokenPurchase` → `schema.prisma:L9650`
- `TokenUsageRecord` → `schema.prisma:L9622`
- `TpvCommandHistory` → `schema.prisma:L9882`
- `TpvCommandQueue` → `schema.prisma:L9822`
- `TpvFeedback` → `schema.prisma:L9535`
- `TpvMessage` → `schema.prisma:L12841`
- `TpvMessageDelivery` → `schema.prisma:L12893`
- `TpvMessageResponse` → `schema.prisma:L12916`
- `TrainingModule` → `schema.prisma:L12971`
- `TrainingProgress` → `schema.prisma:L13048`
- `TrainingQuizQuestion` → `schema.prisma:L13030`
- `TrainingStep` → `schema.prisma:L13010`
- `TransactionCost` → `schema.prisma:L6305`
- `UnitConversion` → `schema.prisma:L2640`
- `UpsellAcceptance` → `schema.prisma:L8045`
- `UpsellAiRun` → `schema.prisma:L8065`
- `UpsellImpression` → `schema.prisma:L8005`
- `UpsellRule` → `schema.prisma:L7925`
- `user_sessions` → `schema.prisma:L5645`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14948`
- `VenueChatMessage` → `schema.prisma:L771`
- `VenueChatSession` → `schema.prisma:L726`
- `VenueCommission` → `schema.prisma:L14594`
- `VenueCreditAssessment` → `schema.prisma:L10364`
- `VenueCryptoConfig` → `schema.prisma:L12708`
- `VenueFeature` → `schema.prisma:L4506`
- `VenueModule` → `schema.prisma:L10524`
- `VenuePaymentConfig` → `schema.prisma:L5746`
- `VenuePaymentLinkSettings` → `schema.prisma:L13948`
- `VenuePricingStructure` → `schema.prisma:L6245`
- `VenueRoleConfig` → `schema.prisma:L1424`
- `VenueRolePermission` → `schema.prisma:L1328`
- `VenueScaleSettings` → `schema.prisma:L15199`
- `VenueSettings` → `schema.prisma:L811`
- `VenueTenderType` → `schema.prisma:L4251`
- `VenueTenderTypeRevision` → `schema.prisma:L4316`
- `VenueTransaction` → `schema.prisma:L4443`
- `VenueWhatsappActivation` → `schema.prisma:L662`
- `WalletCardDesign` → `schema.prisma:L7390`
- `WalletPass` → `schema.prisma:L7299`
- `WalletPassRegistration` → `schema.prisma:L7357`
- `WebhookEvent` → `schema.prisma:L4542`
- `WebhookSubscription` → `schema.prisma:L5862`
- `WhatsappContactWindow` → `schema.prisma:L680`
- `WhatsappInboundEvent` → `schema.prisma:L700`
- `WorkShiftAssignment` → `schema.prisma:L3297`
- `WorkShiftTemplate` → `schema.prisma:L3274`
- `Zone` → `schema.prisma:L142`
