# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **364 models / 345 enums / ~17,300 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L16182`
- `AccountMapping` → `schema.prisma:L16078`
- `ActivityLog` → `schema.prisma:L6739`
- `Aggregator` → `schema.prisma:L14475`
- `AngelPayUserAccount` → `schema.prisma:L5402`
- `AppUpdate` → `schema.prisma:L12640`
- `Area` → `schema.prisma:L3035`
- `AreaTicket` → `schema.prisma:L14973`
- `AreaTicketCheckoutSession` → `schema.prisma:L15095`
- `AreaTicketExternalIncident` → `schema.prisma:L15342`
- `AreaTicketExternalSettlement` → `schema.prisma:L15307`
- `AreaTicketFulfillment` → `schema.prisma:L15171`
- `AreaTicketInventoryReservation` → `schema.prisma:L15066`
- `AreaTicketLine` → `schema.prisma:L15034`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15127`
- `AreaTicketPrintAttempt` → `schema.prisma:L15150`
- `BankStatement` → `schema.prisma:L15952`
- `BankStatementLine` → `schema.prisma:L15973`
- `BillingTaxProfile` → `schema.prisma:L16762`
- `BulkCommandOperation` → `schema.prisma:L9920`
- `CalendarSyncOutbox` → `schema.prisma:L13847`
- `CampaignDelivery` → `schema.prisma:L12798`
- `CashCloseout` → `schema.prisma:L10305`
- `CashDeposit` → `schema.prisma:L12442`
- `CashDrawerEvent` → `schema.prisma:L14312`
- `CashDrawerSession` → `schema.prisma:L14273`
- `CashOutCommissionRate` → `schema.prisma:L16591`
- `CashOutScheduleDay` → `schema.prisma:L16614`
- `CashOutWithdrawal` → `schema.prisma:L16676`
- `CatalogBindingBatch` → `schema.prisma:L11336`
- `CatalogBindingLine` → `schema.prisma:L11372`
- `CatalogBrand` → `schema.prisma:L10789`
- `CatalogClientObservation` → `schema.prisma:L11102`
- `CatalogClientReadinessOverride` → `schema.prisma:L11121`
- `CatalogFamily` → `schema.prisma:L10839`
- `CatalogIdempotencyRecord` → `schema.prisma:L11235`
- `CatalogIdentifier` → `schema.prisma:L10970`
- `CatalogImportBatch` → `schema.prisma:L11278`
- `CatalogImportLine` → `schema.prisma:L11315`
- `CatalogItem` → `schema.prisma:L10872`
- `CatalogItemBusinessType` → `schema.prisma:L10932`
- `CatalogItemPrice` → `schema.prisma:L11020`
- `CatalogManufacturer` → `schema.prisma:L10813`
- `CatalogProductTypeMapping` → `schema.prisma:L10949`
- `CatalogPublicationBatch` → `schema.prisma:L11400`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11494`
- `CatalogPublicationLine` → `schema.prisma:L11441`
- `CatalogPublicationOutbox` → `schema.prisma:L11537`
- `CatalogValidationProfile` → `schema.prisma:L10991`
- `CatalogVenueBinding` → `schema.prisma:L11149`
- `CatalogVenueClientRequirement` → `schema.prisma:L11076`
- `CatalogVenueEventSequence` → `schema.prisma:L11520`
- `CatalogVenueOverride` → `schema.prisma:L11191`
- `CatalogVenueRollout` → `schema.prisma:L11051`
- `Cfdi` → `schema.prisma:L15855`
- `ChatbotTokenBudget` → `schema.prisma:L9568`
- `ChatConversation` → `schema.prisma:L9423`
- `ChatFeedback` → `schema.prisma:L9509`
- `ChatLearningEvent` → `schema.prisma:L9466`
- `ChatMessage` → `schema.prisma:L9446`
- `ChatTrainingData` → `schema.prisma:L9380`
- `CheckoutSession` → `schema.prisma:L5682`
- `ClassSession` → `schema.prisma:L13451`
- `CommissionCalculation` → `schema.prisma:L12218`
- `CommissionClawback` → `schema.prisma:L12394`
- `CommissionConfig` → `schema.prisma:L11984`
- `CommissionMilestone` → `schema.prisma:L12134`
- `CommissionOverride` → `schema.prisma:L12061`
- `CommissionPayout` → `schema.prisma:L12345`
- `CommissionSummary` → `schema.prisma:L12284`
- `CommissionTier` → `schema.prisma:L12098`
- `ConsentEvent` → `schema.prisma:L6922`
- `Consumer` → `schema.prisma:L7103`
- `ConsumerAuthAccount` → `schema.prisma:L7128`
- `CouponCode` → `schema.prisma:L8075`
- `CouponRedemption` → `schema.prisma:L8106`
- `CreditAssessmentHistory` → `schema.prisma:L10414`
- `CreditItemBalance` → `schema.prisma:L14063`
- `CreditOffer` → `schema.prisma:L10433`
- `CreditPack` → `schema.prisma:L13972`
- `CreditPackItem` → `schema.prisma:L14001`
- `CreditPackPurchase` → `schema.prisma:L14018`
- `CreditTransaction` → `schema.prisma:L14085`
- `Customer` → `schema.prisma:L6780`
- `CustomerApprovalDelivery` → `schema.prisma:L9082`
- `CustomerApprovalOutbox` → `schema.prisma:L9057`
- `CustomerCampaign` → `schema.prisma:L7006`
- `CustomerCampaignDelivery` → `schema.prisma:L7044`
- `CustomerCaptureToken` → `schema.prisma:L6958`
- `CustomerDiscount` → `schema.prisma:L8126`
- `CustomerGroup` → `schema.prisma:L7167`
- `CustomerOrderMetric` → `schema.prisma:L3805`
- `CustomerTaxProfile` → `schema.prisma:L15924`
- `DeliveryActivationRequest` → `schema.prisma:L6023`
- `DeliveryChannelLink` → `schema.prisma:L5968`
- `DeliveryOrderEvent` → `schema.prisma:L6047`
- `DeviceToken` → `schema.prisma:L8395`
- `DigitalReceipt` → `schema.prisma:L4376`
- `Discount` → `schema.prisma:L7765`
- `EcommerceMerchant` → `schema.prisma:L5494`
- `EmailQuotaLedger` → `schema.prisma:L7090`
- `EmailSuppression` → `schema.prisma:L7078`
- `EmailTemplate` → `schema.prisma:L12737`
- `Employee` → `schema.prisma:L16439`
- `Estimate` → `schema.prisma:L14382`
- `EstimateItem` → `schema.prisma:L14410`
- `Expense` → `schema.prisma:L16226`
- `ExternalBusyBlock` → `schema.prisma:L13740`
- `Feature` → `schema.prisma:L4505`
- `FeeSchedule` → `schema.prisma:L4583`
- `FeeTier` → `schema.prisma:L4594`
- `FinancialAccount` → `schema.prisma:L14572`
- `FinancialConnection` → `schema.prisma:L14541`
- `FinancialProvider` → `schema.prisma:L14527`
- `FiscalEmisor` → `schema.prisma:L15778`
- `FiscalLossCarryforward` → `schema.prisma:L16349`
- `FixedAsset` → `schema.prisma:L16367`
- `FixedAssetDepreciation` → `schema.prisma:L16396`
- `FloorElement` → `schema.prisma:L3111`
- `FulfillmentArea` → `schema.prisma:L14838`
- `GeofenceRule` → `schema.prisma:L10005`
- `GoogleCalendarChannel` → `schema.prisma:L13717`
- `GoogleCalendarConnection` → `schema.prisma:L13669`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13770`
- `GoogleOAuthSession` → `schema.prisma:L13792`
- `HolidayCalendar` → `schema.prisma:L6663`
- `IdempotencyRequest` → `schema.prisma:L11859`
- `InterVenueTransfer` → `schema.prisma:L2863`
- `InterVenueTransferAllocation` → `schema.prisma:L2946`
- `InterVenueTransferItem` → `schema.prisma:L2915`
- `InterVenueTransferReceipt` → `schema.prisma:L2973`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2989`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3017`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3001`
- `Inventory` → `schema.prisma:L1909`
- `InventoryMovement` → `schema.prisma:L1936`
- `InventoryPosting` → `schema.prisma:L2018`
- `InventoryPostingLine` → `schema.prisma:L2058`
- `InventoryTransfer` → `schema.prisma:L14354`
- `Invitation` → `schema.prisma:L1447`
- `Invoice` → `schema.prisma:L4606`
- `InvoiceItem` → `schema.prisma:L4632`
- `ItemCategory` → `schema.prisma:L11572`
- `JournalEntry` → `schema.prisma:L16136`
- `JournalLine` → `schema.prisma:L16164`
- `KdsOrder` → `schema.prisma:L14620`
- `KdsOrderItem` → `schema.prisma:L14661`
- `KioskCheckInAttempt` → `schema.prisma:L17085`
- `KioskCheckInChallenge` → `schema.prisma:L17039`
- `KioskOutreachOutbox` → `schema.prisma:L17106`
- `LearnedPatterns` → `schema.prisma:L9490`
- `LedgerAccount` → `schema.prisma:L16028`
- `LiveDemoSession` → `schema.prisma:L792`
- `LowStockAlert` → `schema.prisma:L2704`
- `LoyaltyConfig` → `schema.prisma:L7197`
- `LoyaltyTransaction` → `schema.prisma:L7240`
- `MarketingCampaign` → `schema.prisma:L12755`
- `McpAuthCode` → `schema.prisma:L15661`
- `McpOAuthClient` → `schema.prisma:L15645`
- `McpRefreshToken` → `schema.prisma:L15679`
- `McpToolCall` → `schema.prisma:L15700`
- `MeasurementUnit` → `schema.prisma:L14460`
- `Menu` → `schema.prisma:L1633`
- `MenuCategory` → `schema.prisma:L1570`
- `MenuCategoryAssignment` → `schema.prisma:L1668`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15575`
- `MerchantAccount` → `schema.prisma:L5232`
- `MerchantFiscalConfig` → `schema.prisma:L15826`
- `MerchantRevenueShare` → `schema.prisma:L6243`
- `MerchantRoutingRule` → `schema.prisma:L5354`
- `MilestoneAchievement` → `schema.prisma:L12179`
- `Modifier` → `schema.prisma:L3989`
- `ModifierGroup` → `schema.prisma:L3953`
- `Module` → `schema.prisma:L10481`
- `MoneyAnomaly` → `schema.prisma:L6146`
- `MonthlyVenueProfit` → `schema.prisma:L6689`
- `Notification` → `schema.prisma:L8297`
- `NotificationPreference` → `schema.prisma:L8344`
- `NotificationTemplate` → `schema.prisma:L8371`
- `OAuthState` → `schema.prisma:L1498`
- `OnboardingProgress` → `schema.prisma:L1516`
- `Order` → `schema.prisma:L3560`
- `OrderAction` → `schema.prisma:L4056`
- `OrderCustomer` → `schema.prisma:L3784`
- `OrderDiscount` → `schema.prisma:L8158`
- `OrderFulfillment` → `schema.prisma:L14893`
- `OrderFulfillmentLine` → `schema.prisma:L14924`
- `OrderItem` → `schema.prisma:L3820`
- `OrderItemModifier` → `schema.prisma:L4038`
- `OrderPromotion` → `schema.prisma:L17002`
- `OrderServiceCharge` → `schema.prisma:L8242`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12556`
- `OrganizationEntitlement` → `schema.prisma:L10764`
- `OrganizationGoal` → `schema.prisma:L12514`
- `OrganizationModule` → `schema.prisma:L10541`
- `OrganizationPaymentConfig` → `schema.prisma:L5806`
- `OrganizationPayoutConfig` → `schema.prisma:L12589`
- `OrganizationPricingStructure` → `schema.prisma:L5838`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12537`
- `OtpChallenge` → `schema.prisma:L7147`
- `OvertimeApproval` → `schema.prisma:L3338`
- `PartnerAPIKey` → `schema.prisma:L5636`
- `Payment` → `schema.prisma:L4089`
- `PaymentAllocation` → `schema.prisma:L4355`
- `PaymentLink` → `schema.prisma:L14131`
- `PaymentLinkAttribution` → `schema.prisma:L14239`
- `PaymentLinkItem` → `schema.prisma:L14194`
- `PaymentLinkItemModifier` → `schema.prisma:L14221`
- `PaymentProvider` → `schema.prisma:L5191`
- `PayrollLine` → `schema.prisma:L16510`
- `PayrollRun` → `schema.prisma:L16479`
- `PerformanceGoal` → `schema.prisma:L12491`
- `PermissionOverride` → `schema.prisma:L1371`
- `PermissionSet` → `schema.prisma:L1394`
- `PlatformAnnouncement` → `schema.prisma:L17166`
- `PlatformAnnouncementClick` → `schema.prisma:L17231`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17268`
- `PlatformCfdi` → `schema.prisma:L16795`
- `PlatformEmisor` → `schema.prisma:L16735`
- `PlatformSettings` → `schema.prisma:L5613`
- `PosCommand` → `schema.prisma:L8425`
- `PosConnectionStatus` → `schema.prisma:L918`
- `PosSyncIntent` → `schema.prisma:L16873`
- `PricingPolicy` → `schema.prisma:L2608`
- `Printer` → `schema.prisma:L14703`
- `PrintGateway` → `schema.prisma:L14760`
- `PrintJob` → `schema.prisma:L15474`
- `PrintStation` → `schema.prisma:L14778`
- `PrivacyNoticeVersion` → `schema.prisma:L6944`
- `ProcessedStripeEvent` → `schema.prisma:L6132`
- `ProcessorReliabilityMetric` → `schema.prisma:L6617`
- `Product` → `schema.prisma:L1686`
- `ProductModifierGroup` → `schema.prisma:L4026`
- `ProductOption` → `schema.prisma:L14437`
- `ProductOptionValue` → `schema.prisma:L14448`
- `ProductStaff` → `schema.prisma:L13366`
- `PromoterBankAccount` → `schema.prisma:L16630`
- `PromoterCommissionEntry` → `schema.prisma:L16649`
- `PromoterLocationPing` → `schema.prisma:L3526`
- `Promotion` → `schema.prisma:L16924`
- `PromotionGroup` → `schema.prisma:L16963`
- `PromotionOption` → `schema.prisma:L16979`
- `ProviderCostStructure` → `schema.prisma:L6168`
- `ProviderEventLog` → `schema.prisma:L5915`
- `PurchaseOrder` → `schema.prisma:L2333`
- `PurchaseOrderInvoice` → `schema.prisma:L2478`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2535`
- `PurchaseOrderItem` → `schema.prisma:L2391`
- `RateCorrectionBatch` → `schema.prisma:L6393`
- `RateCorrectionEntry` → `schema.prisma:L6435`
- `RawMaterial` → `schema.prisma:L2090`
- `RawMaterialMovement` → `schema.prisma:L2661`
- `RawMaterialPresentation` → `schema.prisma:L2165`
- `Recipe` → `schema.prisma:L2185`
- `RecipeLine` → `schema.prisma:L2209`
- `Referral` → `schema.prisma:L7613`
- `ReferralProgramConfig` → `schema.prisma:L7578`
- `ReferralRewardGrant` → `schema.prisma:L7704`
- `ReferralTierReward` → `schema.prisma:L7676`
- `ReferralTierUnlock` → `schema.prisma:L7749`
- `RefreshGrant` → `schema.prisma:L17355`
- `Reservation` → `schema.prisma:L13134`
- `ReservationGoogleEventMapping` → `schema.prisma:L13904`
- `ReservationModifier` → `schema.prisma:L13314`
- `ReservationReminderSent` → `schema.prisma:L13297`
- `ReservationSettings` → `schema.prisma:L13528`
- `ReservationWaitlistEntry` → `schema.prisma:L13496`
- `Review` → `schema.prisma:L4650`
- `SalesRetention` → `schema.prisma:L16330`
- `SaleVerification` → `schema.prisma:L4409`
- `ScaleProfile` → `schema.prisma:L15215`
- `ScheduledCommand` → `schema.prisma:L9965`
- `SerializedItem` → `schema.prisma:L11615`
- `SerializedItemCustodyEvent` → `schema.prisma:L11782`
- `ServiceCharge` → `schema.prisma:L8213`
- `Session` → `schema.prisma:L17334`
- `SettlementConfiguration` → `schema.prisma:L6468`
- `SettlementConfirmation` → `schema.prisma:L6581`
- `SettlementIncident` → `schema.prisma:L6532`
- `SettlementSimulation` → `schema.prisma:L6503`
- `Shift` → `schema.prisma:L3149`
- `SimRegistrationRequest` → `schema.prisma:L11820`
- `SimRegistrationRequestItem` → `schema.prisma:L11842`
- `SlotHold` → `schema.prisma:L13397`
- `Staff` → `schema.prisma:L938`
- `StaffDocument` → `schema.prisma:L3397`
- `StaffOnboardingState` → `schema.prisma:L15545`
- `StaffOrganization` → `schema.prisma:L1270`
- `StaffPasskey` → `schema.prisma:L1297`
- `StaffSchedule` → `schema.prisma:L13337`
- `StaffScheduleException` → `schema.prisma:L13349`
- `StaffVenue` → `schema.prisma:L1194`
- `StaffWorkSchedule` → `schema.prisma:L3274`
- `StaffWorkScheduleException` → `schema.prisma:L3372`
- `StampCard` → `schema.prisma:L7461`
- `StampEvent` → `schema.prisma:L7500`
- `StampReward` → `schema.prisma:L7538`
- `StockAlertConfig` → `schema.prisma:L12473`
- `StockBatch` → `schema.prisma:L2812`
- `StockCount` → `schema.prisma:L2736`
- `StockCountItem` → `schema.prisma:L2760`
- `StripeWebhookEvent` → `schema.prisma:L6115`
- `Supplier` → `schema.prisma:L2244`
- `SupplierItemCode` → `schema.prisma:L2576`
- `SupplierPricing` → `schema.prisma:L2299`
- `Table` → `schema.prisma:L3061`
- `Terminal` → `schema.prisma:L4701`
- `TerminalHealth` → `schema.prisma:L4952`
- `TerminalLog` → `schema.prisma:L4926`
- `TerminalOrder` → `schema.prisma:L5094`
- `TerminalOrderItem` → `schema.prisma:L5169`
- `TerminalPaymentRequest` → `schema.prisma:L5023`
- `TimeEntry` → `schema.prisma:L3439`
- `TimeEntryBreak` → `schema.prisma:L3508`
- `TokenPurchase` → `schema.prisma:L9639`
- `TokenUsageRecord` → `schema.prisma:L9611`
- `TpvCommandHistory` → `schema.prisma:L9871`
- `TpvCommandQueue` → `schema.prisma:L9811`
- `TpvFeedback` → `schema.prisma:L9524`
- `TpvMessage` → `schema.prisma:L12830`
- `TpvMessageDelivery` → `schema.prisma:L12882`
- `TpvMessageResponse` → `schema.prisma:L12905`
- `TrainingModule` → `schema.prisma:L12960`
- `TrainingProgress` → `schema.prisma:L13037`
- `TrainingQuizQuestion` → `schema.prisma:L13019`
- `TrainingStep` → `schema.prisma:L12999`
- `TransactionCost` → `schema.prisma:L6331`
- `UnitConversion` → `schema.prisma:L2639`
- `UpsellAcceptance` → `schema.prisma:L8034`
- `UpsellAiRun` → `schema.prisma:L8054`
- `UpsellImpression` → `schema.prisma:L7994`
- `UpsellRule` → `schema.prisma:L7914`
- `user_sessions` → `schema.prisma:L5671`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14952`
- `VenueChatMessage` → `schema.prisma:L768`
- `VenueChatSession` → `schema.prisma:L723`
- `VenueCommission` → `schema.prisma:L14598`
- `VenueCreditAssessment` → `schema.prisma:L10353`
- `VenueCryptoConfig` → `schema.prisma:L12697`
- `VenueFeature` → `schema.prisma:L4523`
- `VenueModule` → `schema.prisma:L10513`
- `VenuePaymentConfig` → `schema.prisma:L5772`
- `VenuePaymentLinkSettings` → `schema.prisma:L13937`
- `VenuePricingStructure` → `schema.prisma:L6271`
- `VenueRoleConfig` → `schema.prisma:L1423`
- `VenueRolePermission` → `schema.prisma:L1327`
- `VenueScaleSettings` → `schema.prisma:L15203`
- `VenueSettings` → `schema.prisma:L808`
- `VenueTenderType` → `schema.prisma:L4268`
- `VenueTenderTypeRevision` → `schema.prisma:L4333`
- `VenueTransaction` → `schema.prisma:L4460`
- `VenueWhatsappActivation` → `schema.prisma:L659`
- `WalletCardDesign` → `schema.prisma:L7379`
- `WalletPass` → `schema.prisma:L7280`
- `WalletPassRegistration` → `schema.prisma:L7346`
- `WebhookEvent` → `schema.prisma:L4559`
- `WebhookSubscription` → `schema.prisma:L5888`
- `WhatsappContactWindow` → `schema.prisma:L677`
- `WhatsappInboundEvent` → `schema.prisma:L697`
- `WorkShiftAssignment` → `schema.prisma:L3314`
- `WorkShiftTemplate` → `schema.prisma:L3291`
- `Zone` → `schema.prisma:L142`
