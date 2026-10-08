# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **411 models / 377 enums / ~19,100 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueIvaPorProducto`, `VenuePosSinAparato`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `CapabilityGrant`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `HybridBillingOperation`, `HybridCampaign`, `HybridContract`, `HybridContractSelection`, `HybridCreditAllocation`, `HybridOfferPublication`, `HybridPaymentPeriod`, `HybridPromotionGroup`, `HybridPurchase`, `HybridRedemption`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                               |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                                                                                                       |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `InventoryWasteReport`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                                                                                                         |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryConnectIntent`, `DeliveryLineAction`, `DeliveryOrderEvent`, `DeliveryStoreRevocation`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                                                                                                      |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CfdiGlobalOrden`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `OrderItemSelloIva`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                                                                                                |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `ClassSessionPayState`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `ServiceEarning`, `ServicePayPeriod`, `ServicePayTable`, `ServicePayTableCell`, `ServicePayTableVersion`, `StaffPayLevel`, `StaffPayLevelAssignment`, `StaffPayStatement`, `StaffPayTipWindow`, `StaffPayVenueWindow`, `VenueCommission`                                                                                                                                                                                                    |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `AggregatorBooking`, `AggregatorCapacityRule`, `AggregatorConnection`, `AggregatorInboundEvent`, `AggregatorOutbox`, `AggregatorProductLink`, `AggregatorSessionLink`, `AggregatorVisit`, `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                 |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalAttemptResolution`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerExternalIdentity`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L17481`
- `AccountMapping` → `schema.prisma:L17376`
- `ActivityLog` → `schema.prisma:L7548`
- `Aggregator` → `schema.prisma:L15652`
- `AggregatorBooking` → `schema.prisma:L14960`
- `AggregatorCapacityRule` → `schema.prisma:L14941`
- `AggregatorConnection` → `schema.prisma:L14866`
- `AggregatorInboundEvent` → `schema.prisma:L15029`
- `AggregatorOutbox` → `schema.prisma:L15049`
- `AggregatorProductLink` → `schema.prisma:L14898`
- `AggregatorSessionLink` → `schema.prisma:L14917`
- `AggregatorVisit` → `schema.prisma:L14986`
- `AngelPayUserAccount` → `schema.prisma:L6093`
- `AppUpdate` → `schema.prisma:L13527`
- `Area` → `schema.prisma:L3280`
- `AreaTicket` → `schema.prisma:L16188`
- `AreaTicketCheckoutSession` → `schema.prisma:L16310`
- `AreaTicketExternalIncident` → `schema.prisma:L16557`
- `AreaTicketExternalSettlement` → `schema.prisma:L16522`
- `AreaTicketFulfillment` → `schema.prisma:L16386`
- `AreaTicketInventoryReservation` → `schema.prisma:L16281`
- `AreaTicketLine` → `schema.prisma:L16249`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16342`
- `AreaTicketPrintAttempt` → `schema.prisma:L16365`
- `BankStatement` → `schema.prisma:L17250`
- `BankStatementLine` → `schema.prisma:L17271`
- `BillingObligationConflict` → `schema.prisma:L5123`
- `BillingTaxProfile` → `schema.prisma:L18073`
- `BirthdayAutomation` → `schema.prisma:L7872`
- `BulkCommandOperation` → `schema.prisma:L10799`
- `CalendarSyncOutbox` → `schema.prisma:L14749`
- `CampaignDelivery` → `schema.prisma:L13685`
- `CapabilityGrant` → `schema.prisma:L4863`
- `CashCloseout` → `schema.prisma:L11184`
- `CashDeposit` → `schema.prisma:L13329`
- `CashDrawerEvent` → `schema.prisma:L15489`
- `CashDrawerSession` → `schema.prisma:L15450`
- `CashOutCommissionRate` → `schema.prisma:L17890`
- `CashOutScheduleDay` → `schema.prisma:L17913`
- `CashOutWithdrawal` → `schema.prisma:L17975`
- `CatalogBindingBatch` → `schema.prisma:L12215`
- `CatalogBindingLine` → `schema.prisma:L12251`
- `CatalogBrand` → `schema.prisma:L11668`
- `CatalogClientObservation` → `schema.prisma:L11981`
- `CatalogClientReadinessOverride` → `schema.prisma:L12000`
- `CatalogFamily` → `schema.prisma:L11718`
- `CatalogIdempotencyRecord` → `schema.prisma:L12114`
- `CatalogIdentifier` → `schema.prisma:L11849`
- `CatalogImportBatch` → `schema.prisma:L12157`
- `CatalogImportLine` → `schema.prisma:L12194`
- `CatalogItem` → `schema.prisma:L11751`
- `CatalogItemBusinessType` → `schema.prisma:L11811`
- `CatalogItemPrice` → `schema.prisma:L11899`
- `CatalogManufacturer` → `schema.prisma:L11692`
- `CatalogProductTypeMapping` → `schema.prisma:L11828`
- `CatalogPublicationBatch` → `schema.prisma:L12279`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12373`
- `CatalogPublicationLine` → `schema.prisma:L12320`
- `CatalogPublicationOutbox` → `schema.prisma:L12416`
- `CatalogValidationProfile` → `schema.prisma:L11870`
- `CatalogVenueBinding` → `schema.prisma:L12028`
- `CatalogVenueClientRequirement` → `schema.prisma:L11955`
- `CatalogVenueEventSequence` → `schema.prisma:L12399`
- `CatalogVenueOverride` → `schema.prisma:L12070`
- `CatalogVenueRollout` → `schema.prisma:L11930`
- `Cfdi` → `schema.prisma:L17078`
- `CfdiGlobalOrden` → `schema.prisma:L17203`
- `ChatbotTokenBudget` → `schema.prisma:L10445`
- `ChatConversation` → `schema.prisma:L10300`
- `ChatFeedback` → `schema.prisma:L10386`
- `ChatLearningEvent` → `schema.prisma:L10343`
- `ChatMessage` → `schema.prisma:L10323`
- `ChatTrainingData` → `schema.prisma:L10257`
- `CheckoutSession` → `schema.prisma:L6373`
- `ClassSession` → `schema.prisma:L14343`
- `ClassSessionPayState` → `schema.prisma:L19033`
- `CommissionCalculation` → `schema.prisma:L13104`
- `CommissionClawback` → `schema.prisma:L13281`
- `CommissionConfig` → `schema.prisma:L12863`
- `CommissionMilestone` → `schema.prisma:L13020`
- `CommissionOverride` → `schema.prisma:L12947`
- `CommissionPayout` → `schema.prisma:L13232`
- `CommissionSummary` → `schema.prisma:L13171`
- `CommissionTier` → `schema.prisma:L12984`
- `ConsentEvent` → `schema.prisma:L7734`
- `Consumer` → `schema.prisma:L7964`
- `ConsumerAuthAccount` → `schema.prisma:L7989`
- `CouponCode` → `schema.prisma:L8936`
- `CouponRedemption` → `schema.prisma:L8967`
- `CreditAssessmentHistory` → `schema.prisma:L11293`
- `CreditItemBalance` → `schema.prisma:L15240`
- `CreditOffer` → `schema.prisma:L11312`
- `CreditPack` → `schema.prisma:L15149`
- `CreditPackItem` → `schema.prisma:L15178`
- `CreditPackPurchase` → `schema.prisma:L15195`
- `CreditTransaction` → `schema.prisma:L15262`
- `Customer` → `schema.prisma:L7589`
- `CustomerApprovalDelivery` → `schema.prisma:L9959`
- `CustomerApprovalOutbox` → `schema.prisma:L9934`
- `CustomerCampaign` → `schema.prisma:L7822`
- `CustomerCampaignDelivery` → `schema.prisma:L7904`
- `CustomerCaptureToken` → `schema.prisma:L7770`
- `CustomerDiscount` → `schema.prisma:L8987`
- `CustomerExternalIdentity` → `schema.prisma:L15016`
- `CustomerGroup` → `schema.prisma:L8028`
- `CustomerOrderMetric` → `schema.prisma:L4079`
- `CustomerTaxProfile` → `schema.prisma:L17222`
- `DeliveryActivationRequest` → `schema.prisma:L6832`
- `DeliveryChannelLink` → `schema.prisma:L6671`
- `DeliveryConnectIntent` → `schema.prisma:L6783`
- `DeliveryLineAction` → `schema.prisma:L6744`
- `DeliveryOrderEvent` → `schema.prisma:L6856`
- `DeliveryStoreRevocation` → `schema.prisma:L6820`
- `DeviceToken` → `schema.prisma:L9261`
- `DigitalReceipt` → `schema.prisma:L4676`
- `Discount` → `schema.prisma:L8626`
- `EcommerceMerchant` → `schema.prisma:L6185`
- `EmailQuotaLedger` → `schema.prisma:L7951`
- `EmailSuppression` → `schema.prisma:L7939`
- `EmailTemplate` → `schema.prisma:L13624`
- `Employee` → `schema.prisma:L17738`
- `Estimate` → `schema.prisma:L15559`
- `EstimateItem` → `schema.prisma:L15587`
- `Expense` → `schema.prisma:L17525`
- `ExternalBusyBlock` → `schema.prisma:L14642`
- `Feature` → `schema.prisma:L4805`
- `FeeSchedule` → `schema.prisma:L5185`
- `FeeTier` → `schema.prisma:L5196`
- `FinancialAccount` → `schema.prisma:L15749`
- `FinancialConnection` → `schema.prisma:L15718`
- `FinancialProvider` → `schema.prisma:L15704`
- `FiscalEmisor` → `schema.prisma:L16994`
- `FiscalLossCarryforward` → `schema.prisma:L17648`
- `FixedAsset` → `schema.prisma:L17666`
- `FixedAssetDepreciation` → `schema.prisma:L17695`
- `FloorElement` → `schema.prisma:L3356`
- `FulfillmentArea` → `schema.prisma:L16053`
- `GeofenceRule` → `schema.prisma:L10884`
- `GoogleCalendarChannel` → `schema.prisma:L14619`
- `GoogleCalendarConnection` → `schema.prisma:L14571`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14672`
- `GoogleOAuthSession` → `schema.prisma:L14694`
- `HolidayCalendar` → `schema.prisma:L7472`
- `HybridBillingOperation` → `schema.prisma:L5047`
- `HybridCampaign` → `schema.prisma:L4888`
- `HybridContract` → `schema.prisma:L5004`
- `HybridContractSelection` → `schema.prisma:L5036`
- `HybridCreditAllocation` → `schema.prisma:L5103`
- `HybridOfferPublication` → `schema.prisma:L4951`
- `HybridPaymentPeriod` → `schema.prisma:L5082`
- `HybridPromotionGroup` → `schema.prisma:L4932`
- `HybridPurchase` → `schema.prisma:L4971`
- `HybridRedemption` → `schema.prisma:L5065`
- `IdempotencyRequest` → `schema.prisma:L12738`
- `InterVenueTransfer` → `schema.prisma:L3108`
- `InterVenueTransferAllocation` → `schema.prisma:L3191`
- `InterVenueTransferItem` → `schema.prisma:L3160`
- `InterVenueTransferReceipt` → `schema.prisma:L3218`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3234`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3262`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3246`
- `Inventory` → `schema.prisma:L2034`
- `InventoryMovement` → `schema.prisma:L2134`
- `InventoryPosting` → `schema.prisma:L2229`
- `InventoryPostingLine` → `schema.prisma:L2269`
- `InventoryTransfer` → `schema.prisma:L15531`
- `InventoryWasteReport` → `schema.prisma:L2089`
- `Invitation` → `schema.prisma:L1528`
- `Invoice` → `schema.prisma:L5208`
- `InvoiceItem` → `schema.prisma:L5234`
- `ItemCategory` → `schema.prisma:L12451`
- `JournalEntry` → `schema.prisma:L17434`
- `JournalLine` → `schema.prisma:L17463`
- `KdsOrder` → `schema.prisma:L15797`
- `KdsOrderItem` → `schema.prisma:L15860`
- `KioskCheckInAttempt` → `schema.prisma:L18396`
- `KioskCheckInChallenge` → `schema.prisma:L18350`
- `KioskOutreachOutbox` → `schema.prisma:L18417`
- `LaunchCampaign` → `schema.prisma:L18755`
- `LaunchCampaignRedemption` → `schema.prisma:L18872`
- `LearnedPatterns` → `schema.prisma:L10367`
- `LedgerAccount` → `schema.prisma:L17326`
- `LiveDemoSession` → `schema.prisma:L853`
- `LowStockAlert` → `schema.prisma:L2942`
- `LoyaltyConfig` → `schema.prisma:L8058`
- `LoyaltyTransaction` → `schema.prisma:L8101`
- `MarketingCampaign` → `schema.prisma:L13642`
- `McpAuthCode` → `schema.prisma:L16876`
- `McpOAuthClient` → `schema.prisma:L16860`
- `McpRefreshToken` → `schema.prisma:L16894`
- `McpToolCall` → `schema.prisma:L16916`
- `MeasurementUnit` → `schema.prisma:L15637`
- `Menu` → `schema.prisma:L1746`
- `MenuCategory` → `schema.prisma:L1683`
- `MenuCategoryAssignment` → `schema.prisma:L1781`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16790`
- `MerchantAccount` → `schema.prisma:L5923`
- `MerchantFiscalConfig` → `schema.prisma:L17049`
- `MerchantRevenueShare` → `schema.prisma:L7052`
- `MerchantRoutingRule` → `schema.prisma:L6045`
- `MilestoneAchievement` → `schema.prisma:L13065`
- `Modifier` → `schema.prisma:L4278`
- `ModifierGroup` → `schema.prisma:L4242`
- `Module` → `schema.prisma:L11360`
- `MoneyAnomaly` → `schema.prisma:L6955`
- `MonthlyVenueProfit` → `schema.prisma:L7498`
- `Notification` → `schema.prisma:L9163`
- `NotificationPreference` → `schema.prisma:L9210`
- `NotificationTemplate` → `schema.prisma:L9237`
- `OAuthState` → `schema.prisma:L1579`
- `OnboardingProgress` → `schema.prisma:L1597`
- `Order` → `schema.prisma:L3805`
- `OrderAction` → `schema.prisma:L4349`
- `OrderCustomer` → `schema.prisma:L4058`
- `OrderDiscount` → `schema.prisma:L9019`
- `OrderFulfillment` → `schema.prisma:L16108`
- `OrderFulfillmentLine` → `schema.prisma:L16139`
- `OrderItem` → `schema.prisma:L4094`
- `OrderItemModifier` → `schema.prisma:L4331`
- `OrderItemSelloIva` → `schema.prisma:L17183`
- `OrderPromotion` → `schema.prisma:L18313`
- `OrderServiceCharge` → `schema.prisma:L9108`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13443`
- `OrganizationEntitlement` → `schema.prisma:L11643`
- `OrganizationGoal` → `schema.prisma:L13401`
- `OrganizationModule` → `schema.prisma:L11420`
- `OrganizationPaymentConfig` → `schema.prisma:L6497`
- `OrganizationPayoutConfig` → `schema.prisma:L13476`
- `OrganizationPricingStructure` → `schema.prisma:L6529`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13424`
- `OtpChallenge` → `schema.prisma:L8008`
- `OvertimeApproval` → `schema.prisma:L3583`
- `PartnerAPIKey` → `schema.prisma:L6327`
- `Payment` → `schema.prisma:L4382`
- `PaymentAllocation` → `schema.prisma:L4655`
- `PaymentEffect` → `schema.prisma:L18687`
- `PaymentLink` → `schema.prisma:L15308`
- `PaymentLinkAttribution` → `schema.prisma:L15416`
- `PaymentLinkItem` → `schema.prisma:L15371`
- `PaymentLinkItemModifier` → `schema.prisma:L15398`
- `PaymentProvider` → `schema.prisma:L5882`
- `PayrollLine` → `schema.prisma:L17809`
- `PayrollRun` → `schema.prisma:L17778`
- `PerformanceGoal` → `schema.prisma:L13378`
- `PermissionOverride` → `schema.prisma:L1452`
- `PermissionSet` → `schema.prisma:L1475`
- `PlatformAnnouncement` → `schema.prisma:L18477`
- `PlatformAnnouncementClick` → `schema.prisma:L18542`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18579`
- `PlatformCfdi` → `schema.prisma:L18106`
- `PlatformEmisor` → `schema.prisma:L18046`
- `PlatformSettings` → `schema.prisma:L6304`
- `PosCommand` → `schema.prisma:L9291`
- `PosConnectionStatus` → `schema.prisma:L997`
- `PosSyncIntent` → `schema.prisma:L18184`
- `PricingPolicy` → `schema.prisma:L2838`
- `Printer` → `schema.prisma:L15909`
- `PrintGateway` → `schema.prisma:L15966`
- `PrintJob` → `schema.prisma:L16689`
- `PrintStation` → `schema.prisma:L15984`
- `PrivacyNoticeVersion` → `schema.prisma:L7756`
- `ProcessedStripeEvent` → `schema.prisma:L6941`
- `ProcessorReliabilityMetric` → `schema.prisma:L7426`
- `Product` → `schema.prisma:L1799`
- `ProductModifierGroup` → `schema.prisma:L4319`
- `ProductOption` → `schema.prisma:L15614`
- `ProductOptionValue` → `schema.prisma:L15625`
- `ProductStaff` → `schema.prisma:L14258`
- `PromoterBankAccount` → `schema.prisma:L17929`
- `PromoterCommissionEntry` → `schema.prisma:L17948`
- `PromoterLocationPing` → `schema.prisma:L3771`
- `Promotion` → `schema.prisma:L18235`
- `PromotionGroup` → `schema.prisma:L18274`
- `PromotionOption` → `schema.prisma:L18290`
- `ProviderCostStructure` → `schema.prisma:L6977`
- `ProviderEventLog` → `schema.prisma:L6606`
- `PurchaseOrder` → `schema.prisma:L2545`
- `PurchaseOrderInvoice` → `schema.prisma:L2690`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2757`
- `PurchaseOrderItem` → `schema.prisma:L2603`
- `RateCorrectionBatch` → `schema.prisma:L7202`
- `RateCorrectionEntry` → `schema.prisma:L7244`
- `RawMaterial` → `schema.prisma:L2301`
- `RawMaterialMovement` → `schema.prisma:L2891`
- `RawMaterialPresentation` → `schema.prisma:L2377`
- `ReceiptLayout` → `schema.prisma:L18721`
- `Recipe` → `schema.prisma:L2397`
- `RecipeLine` → `schema.prisma:L2421`
- `Referral` → `schema.prisma:L8474`
- `ReferralProgramConfig` → `schema.prisma:L8439`
- `ReferralRewardGrant` → `schema.prisma:L8565`
- `ReferralTierReward` → `schema.prisma:L8537`
- `ReferralTierUnlock` → `schema.prisma:L8610`
- `RefreshGrant` → `schema.prisma:L18666`
- `Reservation` → `schema.prisma:L14021`
- `ReservationGoogleEventMapping` → `schema.prisma:L15081`
- `ReservationModifier` → `schema.prisma:L14206`
- `ReservationReminderSent` → `schema.prisma:L14189`
- `ReservationSettings` → `schema.prisma:L14430`
- `ReservationWaitlistEntry` → `schema.prisma:L14398`
- `Review` → `schema.prisma:L5252`
- `SalesRetention` → `schema.prisma:L17629`
- `SaleVerification` → `schema.prisma:L4709`
- `ScaleProfile` → `schema.prisma:L16430`
- `ScheduledCommand` → `schema.prisma:L10844`
- `SerializedItem` → `schema.prisma:L12494`
- `SerializedItemCustodyEvent` → `schema.prisma:L12661`
- `ServiceCharge` → `schema.prisma:L9079`
- `ServiceEarning` → `schema.prisma:L19095`
- `ServicePayPeriod` → `schema.prisma:L19071`
- `ServicePayTable` → `schema.prisma:L18979`
- `ServicePayTableCell` → `schema.prisma:L19021`
- `ServicePayTableVersion` → `schema.prisma:L18996`
- `Session` → `schema.prisma:L18645`
- `SettlementConfiguration` → `schema.prisma:L7277`
- `SettlementConfirmation` → `schema.prisma:L7390`
- `SettlementIncident` → `schema.prisma:L7341`
- `SettlementSimulation` → `schema.prisma:L7312`
- `Shift` → `schema.prisma:L3394`
- `SimRegistrationRequest` → `schema.prisma:L12699`
- `SimRegistrationRequestItem` → `schema.prisma:L12721`
- `SlotHold` → `schema.prisma:L14289`
- `Staff` → `schema.prisma:L1017`
- `StaffDocument` → `schema.prisma:L3642`
- `StaffOnboardingState` → `schema.prisma:L16760`
- `StaffOrganization` → `schema.prisma:L1351`
- `StaffPasskey` → `schema.prisma:L1378`
- `StaffPayLevel` → `schema.prisma:L18943`
- `StaffPayLevelAssignment` → `schema.prisma:L18961`
- `StaffPayStatement` → `schema.prisma:L19127`
- `StaffPayTipWindow` → `schema.prisma:L19143`
- `StaffPayVenueWindow` → `schema.prisma:L19160`
- `StaffSchedule` → `schema.prisma:L14229`
- `StaffScheduleException` → `schema.prisma:L14241`
- `StaffVenue` → `schema.prisma:L1275`
- `StaffWorkSchedule` → `schema.prisma:L3519`
- `StaffWorkScheduleException` → `schema.prisma:L3617`
- `StampCard` → `schema.prisma:L8322`
- `StampEvent` → `schema.prisma:L8361`
- `StampReward` → `schema.prisma:L8399`
- `StockAlertConfig` → `schema.prisma:L13360`
- `StockBatch` → `schema.prisma:L3057`
- `StockCount` → `schema.prisma:L2974`
- `StockCountItem` → `schema.prisma:L3002`
- `StripeWebhookEvent` → `schema.prisma:L6924`
- `Supplier` → `schema.prisma:L2456`
- `SupplierItemCode` → `schema.prisma:L2801`
- `SupplierPricing` → `schema.prisma:L2511`
- `Table` → `schema.prisma:L3306`
- `Terminal` → `schema.prisma:L5303`
- `TerminalAttemptResolution` → `schema.prisma:L5741`
- `TerminalHealth` → `schema.prisma:L5561`
- `TerminalLog` → `schema.prisma:L5535`
- `TerminalOrder` → `schema.prisma:L5785`
- `TerminalOrderItem` → `schema.prisma:L5860`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5713`
- `TerminalPaymentRequest` → `schema.prisma:L5632`
- `TimeEntry` → `schema.prisma:L3684`
- `TimeEntryBreak` → `schema.prisma:L3753`
- `TokenPurchase` → `schema.prisma:L10516`
- `TokenUsageRecord` → `schema.prisma:L10488`
- `TpvCommandHistory` → `schema.prisma:L10750`
- `TpvCommandQueue` → `schema.prisma:L10688`
- `TpvFeedback` → `schema.prisma:L10401`
- `TpvMessage` → `schema.prisma:L13717`
- `TpvMessageDelivery` → `schema.prisma:L13769`
- `TpvMessageResponse` → `schema.prisma:L13792`
- `TrainingModule` → `schema.prisma:L13847`
- `TrainingProgress` → `schema.prisma:L13924`
- `TrainingQuizQuestion` → `schema.prisma:L13906`
- `TrainingStep` → `schema.prisma:L13886`
- `TransactionCost` → `schema.prisma:L7140`
- `UnitConversion` → `schema.prisma:L2869`
- `UpsellAcceptance` → `schema.prisma:L8895`
- `UpsellAiRun` → `schema.prisma:L8915`
- `UpsellImpression` → `schema.prisma:L8855`
- `UpsellRule` → `schema.prisma:L8775`
- `user_sessions` → `schema.prisma:L6362`
- `Venue` → `schema.prisma:L178`
- `VenueAreaTicketSettings` → `schema.prisma:L16167`
- `VenueChatMessage` → `schema.prisma:L829`
- `VenueChatSession` → `schema.prisma:L784`
- `VenueCommission` → `schema.prisma:L15775`
- `VenueCreditAssessment` → `schema.prisma:L11232`
- `VenueCryptoConfig` → `schema.prisma:L13584`
- `VenueFeature` → `schema.prisma:L4823`
- `VenueIvaPorProducto` → `schema.prisma:L980`
- `VenueModule` → `schema.prisma:L11392`
- `VenuePaymentConfig` → `schema.prisma:L6463`
- `VenuePaymentLinkSettings` → `schema.prisma:L15114`
- `VenuePosSinAparato` → `schema.prisma:L991`
- `VenuePricingStructure` → `schema.prisma:L7080`
- `VenueRoleConfig` → `schema.prisma:L1504`
- `VenueRolePermission` → `schema.prisma:L1408`
- `VenueScaleSettings` → `schema.prisma:L16418`
- `VenueSettings` → `schema.prisma:L869`
- `VenueTenderType` → `schema.prisma:L4568`
- `VenueTenderTypeRevision` → `schema.prisma:L4633`
- `VenueTransaction` → `schema.prisma:L4760`
- `VenueWhatsappActivation` → `schema.prisma:L720`
- `WalletCardDesign` → `schema.prisma:L8240`
- `WalletPass` → `schema.prisma:L8141`
- `WalletPassRegistration` → `schema.prisma:L8207`
- `WebhookEvent` → `schema.prisma:L5161`
- `WebhookSubscription` → `schema.prisma:L6579`
- `WhatsappContactWindow` → `schema.prisma:L738`
- `WhatsappInboundEvent` → `schema.prisma:L758`
- `WorkShiftAssignment` → `schema.prisma:L3559`
- `WorkShiftTemplate` → `schema.prisma:L3536`
- `Zone` → `schema.prisma:L161`
