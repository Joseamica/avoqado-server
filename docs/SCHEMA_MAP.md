# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **351 models / 338 enums / ~16,800 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                                                                                   |
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

- `AccountingPeriodLock` → `schema.prisma:L15760`
- `AccountMapping` → `schema.prisma:L15656`
- `ActivityLog` → `schema.prisma:L6553`
- `Aggregator` → `schema.prisma:L14057`
- `AngelPayUserAccount` → `schema.prisma:L5216`
- `AppUpdate` → `schema.prisma:L12237`
- `Area` → `schema.prisma:L3004`
- `AreaTicket` → `schema.prisma:L14551`
- `AreaTicketCheckoutSession` → `schema.prisma:L14673`
- `AreaTicketExternalIncident` → `schema.prisma:L14920`
- `AreaTicketExternalSettlement` → `schema.prisma:L14885`
- `AreaTicketFulfillment` → `schema.prisma:L14749`
- `AreaTicketInventoryReservation` → `schema.prisma:L14644`
- `AreaTicketLine` → `schema.prisma:L14612`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14705`
- `AreaTicketPrintAttempt` → `schema.prisma:L14728`
- `BankStatement` → `schema.prisma:L15530`
- `BankStatementLine` → `schema.prisma:L15551`
- `BillingTaxProfile` → `schema.prisma:L16340`
- `BulkCommandOperation` → `schema.prisma:L9520`
- `CalendarSyncOutbox` → `schema.prisma:L13444`
- `CampaignDelivery` → `schema.prisma:L12395`
- `CashCloseout` → `schema.prisma:L9905`
- `CashDeposit` → `schema.prisma:L12039`
- `CashDrawerEvent` → `schema.prisma:L13894`
- `CashDrawerSession` → `schema.prisma:L13870`
- `CashOutCommissionRate` → `schema.prisma:L16169`
- `CashOutScheduleDay` → `schema.prisma:L16192`
- `CashOutWithdrawal` → `schema.prisma:L16254`
- `CatalogBindingBatch` → `schema.prisma:L10936`
- `CatalogBindingLine` → `schema.prisma:L10972`
- `CatalogBrand` → `schema.prisma:L10389`
- `CatalogClientObservation` → `schema.prisma:L10702`
- `CatalogClientReadinessOverride` → `schema.prisma:L10721`
- `CatalogFamily` → `schema.prisma:L10439`
- `CatalogIdempotencyRecord` → `schema.prisma:L10835`
- `CatalogIdentifier` → `schema.prisma:L10570`
- `CatalogImportBatch` → `schema.prisma:L10878`
- `CatalogImportLine` → `schema.prisma:L10915`
- `CatalogItem` → `schema.prisma:L10472`
- `CatalogItemBusinessType` → `schema.prisma:L10532`
- `CatalogItemPrice` → `schema.prisma:L10620`
- `CatalogManufacturer` → `schema.prisma:L10413`
- `CatalogProductTypeMapping` → `schema.prisma:L10549`
- `CatalogPublicationBatch` → `schema.prisma:L11000`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11094`
- `CatalogPublicationLine` → `schema.prisma:L11041`
- `CatalogPublicationOutbox` → `schema.prisma:L11137`
- `CatalogValidationProfile` → `schema.prisma:L10591`
- `CatalogVenueBinding` → `schema.prisma:L10749`
- `CatalogVenueClientRequirement` → `schema.prisma:L10676`
- `CatalogVenueEventSequence` → `schema.prisma:L11120`
- `CatalogVenueOverride` → `schema.prisma:L10791`
- `CatalogVenueRollout` → `schema.prisma:L10651`
- `Cfdi` → `schema.prisma:L15433`
- `ChatbotTokenBudget` → `schema.prisma:L9168`
- `ChatConversation` → `schema.prisma:L9023`
- `ChatFeedback` → `schema.prisma:L9109`
- `ChatLearningEvent` → `schema.prisma:L9066`
- `ChatMessage` → `schema.prisma:L9046`
- `ChatTrainingData` → `schema.prisma:L8980`
- `CheckoutSession` → `schema.prisma:L5496`
- `ClassSession` → `schema.prisma:L13048`
- `CommissionCalculation` → `schema.prisma:L11815`
- `CommissionClawback` → `schema.prisma:L11991`
- `CommissionConfig` → `schema.prisma:L11581`
- `CommissionMilestone` → `schema.prisma:L11731`
- `CommissionOverride` → `schema.prisma:L11658`
- `CommissionPayout` → `schema.prisma:L11942`
- `CommissionSummary` → `schema.prisma:L11881`
- `CommissionTier` → `schema.prisma:L11695`
- `Consumer` → `schema.prisma:L6715`
- `ConsumerAuthAccount` → `schema.prisma:L6740`
- `CouponCode` → `schema.prisma:L7678`
- `CouponRedemption` → `schema.prisma:L7709`
- `CreditAssessmentHistory` → `schema.prisma:L10014`
- `CreditItemBalance` → `schema.prisma:L13660`
- `CreditOffer` → `schema.prisma:L10033`
- `CreditPack` → `schema.prisma:L13569`
- `CreditPackItem` → `schema.prisma:L13598`
- `CreditPackPurchase` → `schema.prisma:L13615`
- `CreditTransaction` → `schema.prisma:L13682`
- `Customer` → `schema.prisma:L6594`
- `CustomerApprovalDelivery` → `schema.prisma:L8685`
- `CustomerApprovalOutbox` → `schema.prisma:L8660`
- `CustomerDiscount` → `schema.prisma:L7729`
- `CustomerGroup` → `schema.prisma:L6779`
- `CustomerTaxProfile` → `schema.prisma:L15502`
- `DeliveryActivationRequest` → `schema.prisma:L5837`
- `DeliveryChannelLink` → `schema.prisma:L5782`
- `DeliveryOrderEvent` → `schema.prisma:L5861`
- `DeviceToken` → `schema.prisma:L7998`
- `DigitalReceipt` → `schema.prisma:L4211`
- `Discount` → `schema.prisma:L7368`
- `EcommerceMerchant` → `schema.prisma:L5308`
- `EmailTemplate` → `schema.prisma:L12334`
- `Employee` → `schema.prisma:L16017`
- `Estimate` → `schema.prisma:L13964`
- `EstimateItem` → `schema.prisma:L13992`
- `Expense` → `schema.prisma:L15804`
- `ExternalBusyBlock` → `schema.prisma:L13337`
- `Feature` → `schema.prisma:L4340`
- `FeeSchedule` → `schema.prisma:L4418`
- `FeeTier` → `schema.prisma:L4429`
- `FinancialAccount` → `schema.prisma:L14154`
- `FinancialConnection` → `schema.prisma:L14123`
- `FinancialProvider` → `schema.prisma:L14109`
- `FiscalEmisor` → `schema.prisma:L15356`
- `FiscalLossCarryforward` → `schema.prisma:L15927`
- `FixedAsset` → `schema.prisma:L15945`
- `FixedAssetDepreciation` → `schema.prisma:L15974`
- `FloorElement` → `schema.prisma:L3080`
- `FulfillmentArea` → `schema.prisma:L14416`
- `GeofenceRule` → `schema.prisma:L9605`
- `GoogleCalendarChannel` → `schema.prisma:L13314`
- `GoogleCalendarConnection` → `schema.prisma:L13266`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13367`
- `GoogleOAuthSession` → `schema.prisma:L13389`
- `HolidayCalendar` → `schema.prisma:L6477`
- `IdempotencyRequest` → `schema.prisma:L11456`
- `InterVenueTransfer` → `schema.prisma:L2832`
- `InterVenueTransferAllocation` → `schema.prisma:L2915`
- `InterVenueTransferItem` → `schema.prisma:L2884`
- `InterVenueTransferReceipt` → `schema.prisma:L2942`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2958`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2986`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2970`
- `Inventory` → `schema.prisma:L1878`
- `InventoryMovement` → `schema.prisma:L1905`
- `InventoryPosting` → `schema.prisma:L1987`
- `InventoryPostingLine` → `schema.prisma:L2027`
- `InventoryTransfer` → `schema.prisma:L13936`
- `Invitation` → `schema.prisma:L1416`
- `Invoice` → `schema.prisma:L4441`
- `InvoiceItem` → `schema.prisma:L4467`
- `ItemCategory` → `schema.prisma:L11172`
- `JournalEntry` → `schema.prisma:L15714`
- `JournalLine` → `schema.prisma:L15742`
- `KdsOrder` → `schema.prisma:L14202`
- `KdsOrderItem` → `schema.prisma:L14243`
- `KioskCheckInAttempt` → `schema.prisma:L16663`
- `KioskCheckInChallenge` → `schema.prisma:L16617`
- `KioskOutreachOutbox` → `schema.prisma:L16684`
- `LearnedPatterns` → `schema.prisma:L9090`
- `LedgerAccount` → `schema.prisma:L15606`
- `LiveDemoSession` → `schema.prisma:L784`
- `LowStockAlert` → `schema.prisma:L2673`
- `LoyaltyConfig` → `schema.prisma:L6809`
- `LoyaltyTransaction` → `schema.prisma:L6852`
- `MarketingCampaign` → `schema.prisma:L12352`
- `McpAuthCode` → `schema.prisma:L15239`
- `McpOAuthClient` → `schema.prisma:L15223`
- `McpRefreshToken` → `schema.prisma:L15257`
- `McpToolCall` → `schema.prisma:L15278`
- `MeasurementUnit` → `schema.prisma:L14042`
- `Menu` → `schema.prisma:L1602`
- `MenuCategory` → `schema.prisma:L1539`
- `MenuCategoryAssignment` → `schema.prisma:L1637`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15153`
- `MerchantAccount` → `schema.prisma:L5046`
- `MerchantFiscalConfig` → `schema.prisma:L15404`
- `MerchantRevenueShare` → `schema.prisma:L6057`
- `MerchantRoutingRule` → `schema.prisma:L5168`
- `MilestoneAchievement` → `schema.prisma:L11776`
- `Modifier` → `schema.prisma:L3826`
- `ModifierGroup` → `schema.prisma:L3790`
- `Module` → `schema.prisma:L10081`
- `MoneyAnomaly` → `schema.prisma:L5960`
- `MonthlyVenueProfit` → `schema.prisma:L6503`
- `Notification` → `schema.prisma:L7900`
- `NotificationPreference` → `schema.prisma:L7947`
- `NotificationTemplate` → `schema.prisma:L7974`
- `OAuthState` → `schema.prisma:L1467`
- `OnboardingProgress` → `schema.prisma:L1485`
- `Order` → `schema.prisma:L3428`
- `OrderAction` → `schema.prisma:L3891`
- `OrderCustomer` → `schema.prisma:L3641`
- `OrderDiscount` → `schema.prisma:L7761`
- `OrderFulfillment` → `schema.prisma:L14471`
- `OrderFulfillmentLine` → `schema.prisma:L14502`
- `OrderItem` → `schema.prisma:L3657`
- `OrderItemModifier` → `schema.prisma:L3875`
- `OrderPromotion` → `schema.prisma:L16580`
- `OrderServiceCharge` → `schema.prisma:L7845`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12153`
- `OrganizationEntitlement` → `schema.prisma:L10364`
- `OrganizationGoal` → `schema.prisma:L12111`
- `OrganizationModule` → `schema.prisma:L10141`
- `OrganizationPaymentConfig` → `schema.prisma:L5620`
- `OrganizationPayoutConfig` → `schema.prisma:L12186`
- `OrganizationPricingStructure` → `schema.prisma:L5652`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12134`
- `OtpChallenge` → `schema.prisma:L6759`
- `PartnerAPIKey` → `schema.prisma:L5450`
- `Payment` → `schema.prisma:L3924`
- `PaymentAllocation` → `schema.prisma:L4190`
- `PaymentLink` → `schema.prisma:L13728`
- `PaymentLinkAttribution` → `schema.prisma:L13836`
- `PaymentLinkItem` → `schema.prisma:L13791`
- `PaymentLinkItemModifier` → `schema.prisma:L13818`
- `PaymentProvider` → `schema.prisma:L5005`
- `PayrollLine` → `schema.prisma:L16088`
- `PayrollRun` → `schema.prisma:L16057`
- `PerformanceGoal` → `schema.prisma:L12088`
- `PermissionOverride` → `schema.prisma:L1344`
- `PermissionSet` → `schema.prisma:L1367`
- `PlatformAnnouncement` → `schema.prisma:L16744`
- `PlatformAnnouncementClick` → `schema.prisma:L16809`
- `PlatformAnnouncementDelivery` → `schema.prisma:L16846`
- `PlatformCfdi` → `schema.prisma:L16373`
- `PlatformEmisor` → `schema.prisma:L16313`
- `PlatformSettings` → `schema.prisma:L5427`
- `PosCommand` → `schema.prisma:L8028`
- `PosConnectionStatus` → `schema.prisma:L899`
- `PosSyncIntent` → `schema.prisma:L16451`
- `PricingPolicy` → `schema.prisma:L2577`
- `Printer` → `schema.prisma:L14285`
- `PrintGateway` → `schema.prisma:L14338`
- `PrintJob` → `schema.prisma:L15052`
- `PrintStation` → `schema.prisma:L14356`
- `ProcessedStripeEvent` → `schema.prisma:L5946`
- `ProcessorReliabilityMetric` → `schema.prisma:L6431`
- `Product` → `schema.prisma:L1655`
- `ProductModifierGroup` → `schema.prisma:L3863`
- `ProductOption` → `schema.prisma:L14019`
- `ProductOptionValue` → `schema.prisma:L14030`
- `ProductStaff` → `schema.prisma:L12963`
- `PromoterBankAccount` → `schema.prisma:L16208`
- `PromoterCommissionEntry` → `schema.prisma:L16227`
- `PromoterLocationPing` → `schema.prisma:L3394`
- `Promotion` → `schema.prisma:L16502`
- `PromotionGroup` → `schema.prisma:L16541`
- `PromotionOption` → `schema.prisma:L16557`
- `ProviderCostStructure` → `schema.prisma:L5982`
- `ProviderEventLog` → `schema.prisma:L5729`
- `PurchaseOrder` → `schema.prisma:L2302`
- `PurchaseOrderInvoice` → `schema.prisma:L2447`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2504`
- `PurchaseOrderItem` → `schema.prisma:L2360`
- `RateCorrectionBatch` → `schema.prisma:L6207`
- `RateCorrectionEntry` → `schema.prisma:L6249`
- `RawMaterial` → `schema.prisma:L2059`
- `RawMaterialMovement` → `schema.prisma:L2630`
- `RawMaterialPresentation` → `schema.prisma:L2134`
- `Recipe` → `schema.prisma:L2154`
- `RecipeLine` → `schema.prisma:L2178`
- `Referral` → `schema.prisma:L7216`
- `ReferralProgramConfig` → `schema.prisma:L7181`
- `ReferralRewardGrant` → `schema.prisma:L7307`
- `ReferralTierReward` → `schema.prisma:L7279`
- `ReferralTierUnlock` → `schema.prisma:L7352`
- `Reservation` → `schema.prisma:L12731`
- `ReservationGoogleEventMapping` → `schema.prisma:L13501`
- `ReservationModifier` → `schema.prisma:L12911`
- `ReservationReminderSent` → `schema.prisma:L12894`
- `ReservationSettings` → `schema.prisma:L13125`
- `ReservationWaitlistEntry` → `schema.prisma:L13093`
- `Review` → `schema.prisma:L4485`
- `SalesRetention` → `schema.prisma:L15908`
- `SaleVerification` → `schema.prisma:L4244`
- `ScaleProfile` → `schema.prisma:L14793`
- `ScheduledCommand` → `schema.prisma:L9565`
- `SerializedItem` → `schema.prisma:L11215`
- `SerializedItemCustodyEvent` → `schema.prisma:L11379`
- `ServiceCharge` → `schema.prisma:L7816`
- `SettlementConfiguration` → `schema.prisma:L6282`
- `SettlementConfirmation` → `schema.prisma:L6395`
- `SettlementIncident` → `schema.prisma:L6346`
- `SettlementSimulation` → `schema.prisma:L6317`
- `Shift` → `schema.prisma:L3118`
- `SimRegistrationRequest` → `schema.prisma:L11417`
- `SimRegistrationRequestItem` → `schema.prisma:L11439`
- `SlotHold` → `schema.prisma:L12994`
- `Staff` → `schema.prisma:L919`
- `StaffDocument` → `schema.prisma:L3265`
- `StaffOnboardingState` → `schema.prisma:L15123`
- `StaffOrganization` → `schema.prisma:L1243`
- `StaffPasskey` → `schema.prisma:L1270`
- `StaffSchedule` → `schema.prisma:L12934`
- `StaffScheduleException` → `schema.prisma:L12946`
- `StaffVenue` → `schema.prisma:L1169`
- `StaffWorkSchedule` → `schema.prisma:L3225`
- `StaffWorkScheduleException` → `schema.prisma:L3240`
- `StampCard` → `schema.prisma:L7064`
- `StampEvent` → `schema.prisma:L7103`
- `StampReward` → `schema.prisma:L7141`
- `StockAlertConfig` → `schema.prisma:L12070`
- `StockBatch` → `schema.prisma:L2781`
- `StockCount` → `schema.prisma:L2705`
- `StockCountItem` → `schema.prisma:L2729`
- `StripeWebhookEvent` → `schema.prisma:L5929`
- `Supplier` → `schema.prisma:L2213`
- `SupplierItemCode` → `schema.prisma:L2545`
- `SupplierPricing` → `schema.prisma:L2268`
- `Table` → `schema.prisma:L3030`
- `Terminal` → `schema.prisma:L4536`
- `TerminalHealth` → `schema.prisma:L4775`
- `TerminalLog` → `schema.prisma:L4749`
- `TerminalOrder` → `schema.prisma:L4908`
- `TerminalOrderItem` → `schema.prisma:L4983`
- `TerminalPaymentRequest` → `schema.prisma:L4846`
- `TimeEntry` → `schema.prisma:L3307`
- `TimeEntryBreak` → `schema.prisma:L3376`
- `TokenPurchase` → `schema.prisma:L9239`
- `TokenUsageRecord` → `schema.prisma:L9211`
- `TpvCommandHistory` → `schema.prisma:L9471`
- `TpvCommandQueue` → `schema.prisma:L9411`
- `TpvFeedback` → `schema.prisma:L9124`
- `TpvMessage` → `schema.prisma:L12427`
- `TpvMessageDelivery` → `schema.prisma:L12479`
- `TpvMessageResponse` → `schema.prisma:L12502`
- `TrainingModule` → `schema.prisma:L12557`
- `TrainingProgress` → `schema.prisma:L12634`
- `TrainingQuizQuestion` → `schema.prisma:L12616`
- `TrainingStep` → `schema.prisma:L12596`
- `TransactionCost` → `schema.prisma:L6145`
- `UnitConversion` → `schema.prisma:L2608`
- `UpsellAcceptance` → `schema.prisma:L7637`
- `UpsellAiRun` → `schema.prisma:L7657`
- `UpsellImpression` → `schema.prisma:L7597`
- `UpsellRule` → `schema.prisma:L7517`
- `user_sessions` → `schema.prisma:L5485`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14530`
- `VenueChatMessage` → `schema.prisma:L760`
- `VenueChatSession` → `schema.prisma:L715`
- `VenueCommission` → `schema.prisma:L14180`
- `VenueCreditAssessment` → `schema.prisma:L9953`
- `VenueCryptoConfig` → `schema.prisma:L12294`
- `VenueFeature` → `schema.prisma:L4358`
- `VenueModule` → `schema.prisma:L10113`
- `VenuePaymentConfig` → `schema.prisma:L5586`
- `VenuePaymentLinkSettings` → `schema.prisma:L13534`
- `VenuePricingStructure` → `schema.prisma:L6085`
- `VenueRoleConfig` → `schema.prisma:L1396`
- `VenueRolePermission` → `schema.prisma:L1300`
- `VenueScaleSettings` → `schema.prisma:L14781`
- `VenueSettings` → `schema.prisma:L800`
- `VenueTenderType` → `schema.prisma:L4103`
- `VenueTenderTypeRevision` → `schema.prisma:L4168`
- `VenueTransaction` → `schema.prisma:L4295`
- `VenueWhatsappActivation` → `schema.prisma:L651`
- `WalletCardDesign` → `schema.prisma:L6983`
- `WalletPass` → `schema.prisma:L6892`
- `WalletPassRegistration` → `schema.prisma:L6950`
- `WebhookEvent` → `schema.prisma:L4394`
- `WebhookSubscription` → `schema.prisma:L5702`
- `WhatsappContactWindow` → `schema.prisma:L669`
- `WhatsappInboundEvent` → `schema.prisma:L689`
- `Zone` → `schema.prisma:L142`
