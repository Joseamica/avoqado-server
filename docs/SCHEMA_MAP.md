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

- `AccountingPeriodLock` → `schema.prisma:L16126`
- `AccountMapping` → `schema.prisma:L16022`
- `ActivityLog` → `schema.prisma:L6710`
- `Aggregator` → `schema.prisma:L14419`
- `AngelPayUserAccount` → `schema.prisma:L5373`
- `AppUpdate` → `schema.prisma:L12599`
- `Area` → `schema.prisma:L3033`
- `AreaTicket` → `schema.prisma:L14917`
- `AreaTicketCheckoutSession` → `schema.prisma:L15039`
- `AreaTicketExternalIncident` → `schema.prisma:L15286`
- `AreaTicketExternalSettlement` → `schema.prisma:L15251`
- `AreaTicketFulfillment` → `schema.prisma:L15115`
- `AreaTicketInventoryReservation` → `schema.prisma:L15010`
- `AreaTicketLine` → `schema.prisma:L14978`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15071`
- `AreaTicketPrintAttempt` → `schema.prisma:L15094`
- `BankStatement` → `schema.prisma:L15896`
- `BankStatementLine` → `schema.prisma:L15917`
- `BillingTaxProfile` → `schema.prisma:L16706`
- `BulkCommandOperation` → `schema.prisma:L9879`
- `CalendarSyncOutbox` → `schema.prisma:L13806`
- `CampaignDelivery` → `schema.prisma:L12757`
- `CashCloseout` → `schema.prisma:L10264`
- `CashDeposit` → `schema.prisma:L12401`
- `CashDrawerEvent` → `schema.prisma:L14256`
- `CashDrawerSession` → `schema.prisma:L14232`
- `CashOutCommissionRate` → `schema.prisma:L16535`
- `CashOutScheduleDay` → `schema.prisma:L16558`
- `CashOutWithdrawal` → `schema.prisma:L16620`
- `CatalogBindingBatch` → `schema.prisma:L11295`
- `CatalogBindingLine` → `schema.prisma:L11331`
- `CatalogBrand` → `schema.prisma:L10748`
- `CatalogClientObservation` → `schema.prisma:L11061`
- `CatalogClientReadinessOverride` → `schema.prisma:L11080`
- `CatalogFamily` → `schema.prisma:L10798`
- `CatalogIdempotencyRecord` → `schema.prisma:L11194`
- `CatalogIdentifier` → `schema.prisma:L10929`
- `CatalogImportBatch` → `schema.prisma:L11237`
- `CatalogImportLine` → `schema.prisma:L11274`
- `CatalogItem` → `schema.prisma:L10831`
- `CatalogItemBusinessType` → `schema.prisma:L10891`
- `CatalogItemPrice` → `schema.prisma:L10979`
- `CatalogManufacturer` → `schema.prisma:L10772`
- `CatalogProductTypeMapping` → `schema.prisma:L10908`
- `CatalogPublicationBatch` → `schema.prisma:L11359`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11453`
- `CatalogPublicationLine` → `schema.prisma:L11400`
- `CatalogPublicationOutbox` → `schema.prisma:L11496`
- `CatalogValidationProfile` → `schema.prisma:L10950`
- `CatalogVenueBinding` → `schema.prisma:L11108`
- `CatalogVenueClientRequirement` → `schema.prisma:L11035`
- `CatalogVenueEventSequence` → `schema.prisma:L11479`
- `CatalogVenueOverride` → `schema.prisma:L11150`
- `CatalogVenueRollout` → `schema.prisma:L11010`
- `Cfdi` → `schema.prisma:L15799`
- `ChatbotTokenBudget` → `schema.prisma:L9527`
- `ChatConversation` → `schema.prisma:L9382`
- `ChatFeedback` → `schema.prisma:L9468`
- `ChatLearningEvent` → `schema.prisma:L9425`
- `ChatMessage` → `schema.prisma:L9405`
- `ChatTrainingData` → `schema.prisma:L9339`
- `CheckoutSession` → `schema.prisma:L5653`
- `ClassSession` → `schema.prisma:L13410`
- `CommissionCalculation` → `schema.prisma:L12177`
- `CommissionClawback` → `schema.prisma:L12353`
- `CommissionConfig` → `schema.prisma:L11943`
- `CommissionMilestone` → `schema.prisma:L12093`
- `CommissionOverride` → `schema.prisma:L12020`
- `CommissionPayout` → `schema.prisma:L12304`
- `CommissionSummary` → `schema.prisma:L12243`
- `CommissionTier` → `schema.prisma:L12057`
- `ConsentEvent` → `schema.prisma:L6893`
- `Consumer` → `schema.prisma:L7070`
- `ConsumerAuthAccount` → `schema.prisma:L7095`
- `CouponCode` → `schema.prisma:L8034`
- `CouponRedemption` → `schema.prisma:L8065`
- `CreditAssessmentHistory` → `schema.prisma:L10373`
- `CreditItemBalance` → `schema.prisma:L14022`
- `CreditOffer` → `schema.prisma:L10392`
- `CreditPack` → `schema.prisma:L13931`
- `CreditPackItem` → `schema.prisma:L13960`
- `CreditPackPurchase` → `schema.prisma:L13977`
- `CreditTransaction` → `schema.prisma:L14044`
- `Customer` → `schema.prisma:L6751`
- `CustomerApprovalDelivery` → `schema.prisma:L9041`
- `CustomerApprovalOutbox` → `schema.prisma:L9016`
- `CustomerCampaign` → `schema.prisma:L6977`
- `CustomerCampaignDelivery` → `schema.prisma:L7011`
- `CustomerCaptureToken` → `schema.prisma:L6929`
- `CustomerDiscount` → `schema.prisma:L8085`
- `CustomerGroup` → `schema.prisma:L7134`
- `CustomerOrderMetric` → `schema.prisma:L3785`
- `CustomerTaxProfile` → `schema.prisma:L15868`
- `DeliveryActivationRequest` → `schema.prisma:L5994`
- `DeliveryChannelLink` → `schema.prisma:L5939`
- `DeliveryOrderEvent` → `schema.prisma:L6018`
- `DeviceToken` → `schema.prisma:L8354`
- `DigitalReceipt` → `schema.prisma:L4356`
- `Discount` → `schema.prisma:L7724`
- `EcommerceMerchant` → `schema.prisma:L5465`
- `EmailQuotaLedger` → `schema.prisma:L7057`
- `EmailSuppression` → `schema.prisma:L7045`
- `EmailTemplate` → `schema.prisma:L12696`
- `Employee` → `schema.prisma:L16383`
- `Estimate` → `schema.prisma:L14326`
- `EstimateItem` → `schema.prisma:L14354`
- `Expense` → `schema.prisma:L16170`
- `ExternalBusyBlock` → `schema.prisma:L13699`
- `Feature` → `schema.prisma:L4485`
- `FeeSchedule` → `schema.prisma:L4563`
- `FeeTier` → `schema.prisma:L4574`
- `FinancialAccount` → `schema.prisma:L14516`
- `FinancialConnection` → `schema.prisma:L14485`
- `FinancialProvider` → `schema.prisma:L14471`
- `FiscalEmisor` → `schema.prisma:L15722`
- `FiscalLossCarryforward` → `schema.prisma:L16293`
- `FixedAsset` → `schema.prisma:L16311`
- `FixedAssetDepreciation` → `schema.prisma:L16340`
- `FloorElement` → `schema.prisma:L3109`
- `FulfillmentArea` → `schema.prisma:L14782`
- `GeofenceRule` → `schema.prisma:L9964`
- `GoogleCalendarChannel` → `schema.prisma:L13676`
- `GoogleCalendarConnection` → `schema.prisma:L13628`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13729`
- `GoogleOAuthSession` → `schema.prisma:L13751`
- `HolidayCalendar` → `schema.prisma:L6634`
- `IdempotencyRequest` → `schema.prisma:L11818`
- `InterVenueTransfer` → `schema.prisma:L2861`
- `InterVenueTransferAllocation` → `schema.prisma:L2944`
- `InterVenueTransferItem` → `schema.prisma:L2913`
- `InterVenueTransferReceipt` → `schema.prisma:L2971`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2987`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3015`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2999`
- `Inventory` → `schema.prisma:L1907`
- `InventoryMovement` → `schema.prisma:L1934`
- `InventoryPosting` → `schema.prisma:L2016`
- `InventoryPostingLine` → `schema.prisma:L2056`
- `InventoryTransfer` → `schema.prisma:L14298`
- `Invitation` → `schema.prisma:L1445`
- `Invoice` → `schema.prisma:L4586`
- `InvoiceItem` → `schema.prisma:L4612`
- `ItemCategory` → `schema.prisma:L11531`
- `JournalEntry` → `schema.prisma:L16080`
- `JournalLine` → `schema.prisma:L16108`
- `KdsOrder` → `schema.prisma:L14564`
- `KdsOrderItem` → `schema.prisma:L14605`
- `KioskCheckInAttempt` → `schema.prisma:L17029`
- `KioskCheckInChallenge` → `schema.prisma:L16983`
- `KioskOutreachOutbox` → `schema.prisma:L17050`
- `LearnedPatterns` → `schema.prisma:L9449`
- `LedgerAccount` → `schema.prisma:L15972`
- `LiveDemoSession` → `schema.prisma:L792`
- `LowStockAlert` → `schema.prisma:L2702`
- `LoyaltyConfig` → `schema.prisma:L7164`
- `LoyaltyTransaction` → `schema.prisma:L7207`
- `MarketingCampaign` → `schema.prisma:L12714`
- `McpAuthCode` → `schema.prisma:L15605`
- `McpOAuthClient` → `schema.prisma:L15589`
- `McpRefreshToken` → `schema.prisma:L15623`
- `McpToolCall` → `schema.prisma:L15644`
- `MeasurementUnit` → `schema.prisma:L14404`
- `Menu` → `schema.prisma:L1631`
- `MenuCategory` → `schema.prisma:L1568`
- `MenuCategoryAssignment` → `schema.prisma:L1666`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15519`
- `MerchantAccount` → `schema.prisma:L5203`
- `MerchantFiscalConfig` → `schema.prisma:L15770`
- `MerchantRevenueShare` → `schema.prisma:L6214`
- `MerchantRoutingRule` → `schema.prisma:L5325`
- `MilestoneAchievement` → `schema.prisma:L12138`
- `Modifier` → `schema.prisma:L3969`
- `ModifierGroup` → `schema.prisma:L3933`
- `Module` → `schema.prisma:L10440`
- `MoneyAnomaly` → `schema.prisma:L6117`
- `MonthlyVenueProfit` → `schema.prisma:L6660`
- `Notification` → `schema.prisma:L8256`
- `NotificationPreference` → `schema.prisma:L8303`
- `NotificationTemplate` → `schema.prisma:L8330`
- `OAuthState` → `schema.prisma:L1496`
- `OnboardingProgress` → `schema.prisma:L1514`
- `Order` → `schema.prisma:L3540`
- `OrderAction` → `schema.prisma:L4036`
- `OrderCustomer` → `schema.prisma:L3764`
- `OrderDiscount` → `schema.prisma:L8117`
- `OrderFulfillment` → `schema.prisma:L14837`
- `OrderFulfillmentLine` → `schema.prisma:L14868`
- `OrderItem` → `schema.prisma:L3800`
- `OrderItemModifier` → `schema.prisma:L4018`
- `OrderPromotion` → `schema.prisma:L16946`
- `OrderServiceCharge` → `schema.prisma:L8201`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12515`
- `OrganizationEntitlement` → `schema.prisma:L10723`
- `OrganizationGoal` → `schema.prisma:L12473`
- `OrganizationModule` → `schema.prisma:L10500`
- `OrganizationPaymentConfig` → `schema.prisma:L5777`
- `OrganizationPayoutConfig` → `schema.prisma:L12548`
- `OrganizationPricingStructure` → `schema.prisma:L5809`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12496`
- `OtpChallenge` → `schema.prisma:L7114`
- `OvertimeApproval` → `schema.prisma:L3318`
- `PartnerAPIKey` → `schema.prisma:L5607`
- `Payment` → `schema.prisma:L4069`
- `PaymentAllocation` → `schema.prisma:L4335`
- `PaymentLink` → `schema.prisma:L14090`
- `PaymentLinkAttribution` → `schema.prisma:L14198`
- `PaymentLinkItem` → `schema.prisma:L14153`
- `PaymentLinkItemModifier` → `schema.prisma:L14180`
- `PaymentProvider` → `schema.prisma:L5162`
- `PayrollLine` → `schema.prisma:L16454`
- `PayrollRun` → `schema.prisma:L16423`
- `PerformanceGoal` → `schema.prisma:L12450`
- `PermissionOverride` → `schema.prisma:L1369`
- `PermissionSet` → `schema.prisma:L1392`
- `PlatformAnnouncement` → `schema.prisma:L17110`
- `PlatformAnnouncementClick` → `schema.prisma:L17175`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17212`
- `PlatformCfdi` → `schema.prisma:L16739`
- `PlatformEmisor` → `schema.prisma:L16679`
- `PlatformSettings` → `schema.prisma:L5584`
- `PosCommand` → `schema.prisma:L8384`
- `PosConnectionStatus` → `schema.prisma:L918`
- `PosSyncIntent` → `schema.prisma:L16817`
- `PricingPolicy` → `schema.prisma:L2606`
- `Printer` → `schema.prisma:L14647`
- `PrintGateway` → `schema.prisma:L14704`
- `PrintJob` → `schema.prisma:L15418`
- `PrintStation` → `schema.prisma:L14722`
- `PrivacyNoticeVersion` → `schema.prisma:L6915`
- `ProcessedStripeEvent` → `schema.prisma:L6103`
- `ProcessorReliabilityMetric` → `schema.prisma:L6588`
- `Product` → `schema.prisma:L1684`
- `ProductModifierGroup` → `schema.prisma:L4006`
- `ProductOption` → `schema.prisma:L14381`
- `ProductOptionValue` → `schema.prisma:L14392`
- `ProductStaff` → `schema.prisma:L13325`
- `PromoterBankAccount` → `schema.prisma:L16574`
- `PromoterCommissionEntry` → `schema.prisma:L16593`
- `PromoterLocationPing` → `schema.prisma:L3506`
- `Promotion` → `schema.prisma:L16868`
- `PromotionGroup` → `schema.prisma:L16907`
- `PromotionOption` → `schema.prisma:L16923`
- `ProviderCostStructure` → `schema.prisma:L6139`
- `ProviderEventLog` → `schema.prisma:L5886`
- `PurchaseOrder` → `schema.prisma:L2331`
- `PurchaseOrderInvoice` → `schema.prisma:L2476`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2533`
- `PurchaseOrderItem` → `schema.prisma:L2389`
- `RateCorrectionBatch` → `schema.prisma:L6364`
- `RateCorrectionEntry` → `schema.prisma:L6406`
- `RawMaterial` → `schema.prisma:L2088`
- `RawMaterialMovement` → `schema.prisma:L2659`
- `RawMaterialPresentation` → `schema.prisma:L2163`
- `Recipe` → `schema.prisma:L2183`
- `RecipeLine` → `schema.prisma:L2207`
- `Referral` → `schema.prisma:L7572`
- `ReferralProgramConfig` → `schema.prisma:L7537`
- `ReferralRewardGrant` → `schema.prisma:L7663`
- `ReferralTierReward` → `schema.prisma:L7635`
- `ReferralTierUnlock` → `schema.prisma:L7708`
- `RefreshGrant` → `schema.prisma:L17299`
- `Reservation` → `schema.prisma:L13093`
- `ReservationGoogleEventMapping` → `schema.prisma:L13863`
- `ReservationModifier` → `schema.prisma:L13273`
- `ReservationReminderSent` → `schema.prisma:L13256`
- `ReservationSettings` → `schema.prisma:L13487`
- `ReservationWaitlistEntry` → `schema.prisma:L13455`
- `Review` → `schema.prisma:L4630`
- `SalesRetention` → `schema.prisma:L16274`
- `SaleVerification` → `schema.prisma:L4389`
- `ScaleProfile` → `schema.prisma:L15159`
- `ScheduledCommand` → `schema.prisma:L9924`
- `SerializedItem` → `schema.prisma:L11574`
- `SerializedItemCustodyEvent` → `schema.prisma:L11741`
- `ServiceCharge` → `schema.prisma:L8172`
- `Session` → `schema.prisma:L17278`
- `SettlementConfiguration` → `schema.prisma:L6439`
- `SettlementConfirmation` → `schema.prisma:L6552`
- `SettlementIncident` → `schema.prisma:L6503`
- `SettlementSimulation` → `schema.prisma:L6474`
- `Shift` → `schema.prisma:L3147`
- `SimRegistrationRequest` → `schema.prisma:L11779`
- `SimRegistrationRequestItem` → `schema.prisma:L11801`
- `SlotHold` → `schema.prisma:L13356`
- `Staff` → `schema.prisma:L938`
- `StaffDocument` → `schema.prisma:L3377`
- `StaffOnboardingState` → `schema.prisma:L15489`
- `StaffOrganization` → `schema.prisma:L1268`
- `StaffPasskey` → `schema.prisma:L1295`
- `StaffSchedule` → `schema.prisma:L13296`
- `StaffScheduleException` → `schema.prisma:L13308`
- `StaffVenue` → `schema.prisma:L1192`
- `StaffWorkSchedule` → `schema.prisma:L3254`
- `StaffWorkScheduleException` → `schema.prisma:L3352`
- `StampCard` → `schema.prisma:L7420`
- `StampEvent` → `schema.prisma:L7459`
- `StampReward` → `schema.prisma:L7497`
- `StockAlertConfig` → `schema.prisma:L12432`
- `StockBatch` → `schema.prisma:L2810`
- `StockCount` → `schema.prisma:L2734`
- `StockCountItem` → `schema.prisma:L2758`
- `StripeWebhookEvent` → `schema.prisma:L6086`
- `Supplier` → `schema.prisma:L2242`
- `SupplierItemCode` → `schema.prisma:L2574`
- `SupplierPricing` → `schema.prisma:L2297`
- `Table` → `schema.prisma:L3059`
- `Terminal` → `schema.prisma:L4681`
- `TerminalHealth` → `schema.prisma:L4932`
- `TerminalLog` → `schema.prisma:L4906`
- `TerminalOrder` → `schema.prisma:L5065`
- `TerminalOrderItem` → `schema.prisma:L5140`
- `TerminalPaymentRequest` → `schema.prisma:L5003`
- `TimeEntry` → `schema.prisma:L3419`
- `TimeEntryBreak` → `schema.prisma:L3488`
- `TokenPurchase` → `schema.prisma:L9598`
- `TokenUsageRecord` → `schema.prisma:L9570`
- `TpvCommandHistory` → `schema.prisma:L9830`
- `TpvCommandQueue` → `schema.prisma:L9770`
- `TpvFeedback` → `schema.prisma:L9483`
- `TpvMessage` → `schema.prisma:L12789`
- `TpvMessageDelivery` → `schema.prisma:L12841`
- `TpvMessageResponse` → `schema.prisma:L12864`
- `TrainingModule` → `schema.prisma:L12919`
- `TrainingProgress` → `schema.prisma:L12996`
- `TrainingQuizQuestion` → `schema.prisma:L12978`
- `TrainingStep` → `schema.prisma:L12958`
- `TransactionCost` → `schema.prisma:L6302`
- `UnitConversion` → `schema.prisma:L2637`
- `UpsellAcceptance` → `schema.prisma:L7993`
- `UpsellAiRun` → `schema.prisma:L8013`
- `UpsellImpression` → `schema.prisma:L7953`
- `UpsellRule` → `schema.prisma:L7873`
- `user_sessions` → `schema.prisma:L5642`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14896`
- `VenueChatMessage` → `schema.prisma:L768`
- `VenueChatSession` → `schema.prisma:L723`
- `VenueCommission` → `schema.prisma:L14542`
- `VenueCreditAssessment` → `schema.prisma:L10312`
- `VenueCryptoConfig` → `schema.prisma:L12656`
- `VenueFeature` → `schema.prisma:L4503`
- `VenueModule` → `schema.prisma:L10472`
- `VenuePaymentConfig` → `schema.prisma:L5743`
- `VenuePaymentLinkSettings` → `schema.prisma:L13896`
- `VenuePricingStructure` → `schema.prisma:L6242`
- `VenueRoleConfig` → `schema.prisma:L1421`
- `VenueRolePermission` → `schema.prisma:L1325`
- `VenueScaleSettings` → `schema.prisma:L15147`
- `VenueSettings` → `schema.prisma:L808`
- `VenueTenderType` → `schema.prisma:L4248`
- `VenueTenderTypeRevision` → `schema.prisma:L4313`
- `VenueTransaction` → `schema.prisma:L4440`
- `VenueWhatsappActivation` → `schema.prisma:L659`
- `WalletCardDesign` → `schema.prisma:L7338`
- `WalletPass` → `schema.prisma:L7247`
- `WalletPassRegistration` → `schema.prisma:L7305`
- `WebhookEvent` → `schema.prisma:L4539`
- `WebhookSubscription` → `schema.prisma:L5859`
- `WhatsappContactWindow` → `schema.prisma:L677`
- `WhatsappInboundEvent` → `schema.prisma:L697`
- `WorkShiftAssignment` → `schema.prisma:L3294`
- `WorkShiftTemplate` → `schema.prisma:L3271`
- `Zone` → `schema.prisma:L142`
