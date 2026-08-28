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

- `AccountingPeriodLock` → `schema.prisma:L15819`
- `AccountMapping` → `schema.prisma:L15715`
- `ActivityLog` → `schema.prisma:L6611`
- `Aggregator` → `schema.prisma:L14116`
- `AngelPayUserAccount` → `schema.prisma:L5274`
- `AppUpdate` → `schema.prisma:L12296`
- `Area` → `schema.prisma:L3013`
- `AreaTicket` → `schema.prisma:L14610`
- `AreaTicketCheckoutSession` → `schema.prisma:L14732`
- `AreaTicketExternalIncident` → `schema.prisma:L14979`
- `AreaTicketExternalSettlement` → `schema.prisma:L14944`
- `AreaTicketFulfillment` → `schema.prisma:L14808`
- `AreaTicketInventoryReservation` → `schema.prisma:L14703`
- `AreaTicketLine` → `schema.prisma:L14671`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14764`
- `AreaTicketPrintAttempt` → `schema.prisma:L14787`
- `BankStatement` → `schema.prisma:L15589`
- `BankStatementLine` → `schema.prisma:L15610`
- `BillingTaxProfile` → `schema.prisma:L16399`
- `BulkCommandOperation` → `schema.prisma:L9579`
- `CalendarSyncOutbox` → `schema.prisma:L13503`
- `CampaignDelivery` → `schema.prisma:L12454`
- `CashCloseout` → `schema.prisma:L9964`
- `CashDeposit` → `schema.prisma:L12098`
- `CashDrawerEvent` → `schema.prisma:L13953`
- `CashDrawerSession` → `schema.prisma:L13929`
- `CashOutCommissionRate` → `schema.prisma:L16228`
- `CashOutScheduleDay` → `schema.prisma:L16251`
- `CashOutWithdrawal` → `schema.prisma:L16313`
- `CatalogBindingBatch` → `schema.prisma:L10995`
- `CatalogBindingLine` → `schema.prisma:L11031`
- `CatalogBrand` → `schema.prisma:L10448`
- `CatalogClientObservation` → `schema.prisma:L10761`
- `CatalogClientReadinessOverride` → `schema.prisma:L10780`
- `CatalogFamily` → `schema.prisma:L10498`
- `CatalogIdempotencyRecord` → `schema.prisma:L10894`
- `CatalogIdentifier` → `schema.prisma:L10629`
- `CatalogImportBatch` → `schema.prisma:L10937`
- `CatalogImportLine` → `schema.prisma:L10974`
- `CatalogItem` → `schema.prisma:L10531`
- `CatalogItemBusinessType` → `schema.prisma:L10591`
- `CatalogItemPrice` → `schema.prisma:L10679`
- `CatalogManufacturer` → `schema.prisma:L10472`
- `CatalogProductTypeMapping` → `schema.prisma:L10608`
- `CatalogPublicationBatch` → `schema.prisma:L11059`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11153`
- `CatalogPublicationLine` → `schema.prisma:L11100`
- `CatalogPublicationOutbox` → `schema.prisma:L11196`
- `CatalogValidationProfile` → `schema.prisma:L10650`
- `CatalogVenueBinding` → `schema.prisma:L10808`
- `CatalogVenueClientRequirement` → `schema.prisma:L10735`
- `CatalogVenueEventSequence` → `schema.prisma:L11179`
- `CatalogVenueOverride` → `schema.prisma:L10850`
- `CatalogVenueRollout` → `schema.prisma:L10710`
- `Cfdi` → `schema.prisma:L15492`
- `ChatbotTokenBudget` → `schema.prisma:L9227`
- `ChatConversation` → `schema.prisma:L9082`
- `ChatFeedback` → `schema.prisma:L9168`
- `ChatLearningEvent` → `schema.prisma:L9125`
- `ChatMessage` → `schema.prisma:L9105`
- `ChatTrainingData` → `schema.prisma:L9039`
- `CheckoutSession` → `schema.prisma:L5554`
- `ClassSession` → `schema.prisma:L13107`
- `CommissionCalculation` → `schema.prisma:L11874`
- `CommissionClawback` → `schema.prisma:L12050`
- `CommissionConfig` → `schema.prisma:L11640`
- `CommissionMilestone` → `schema.prisma:L11790`
- `CommissionOverride` → `schema.prisma:L11717`
- `CommissionPayout` → `schema.prisma:L12001`
- `CommissionSummary` → `schema.prisma:L11940`
- `CommissionTier` → `schema.prisma:L11754`
- `Consumer` → `schema.prisma:L6773`
- `ConsumerAuthAccount` → `schema.prisma:L6798`
- `CouponCode` → `schema.prisma:L7737`
- `CouponRedemption` → `schema.prisma:L7768`
- `CreditAssessmentHistory` → `schema.prisma:L10073`
- `CreditItemBalance` → `schema.prisma:L13719`
- `CreditOffer` → `schema.prisma:L10092`
- `CreditPack` → `schema.prisma:L13628`
- `CreditPackItem` → `schema.prisma:L13657`
- `CreditPackPurchase` → `schema.prisma:L13674`
- `CreditTransaction` → `schema.prisma:L13741`
- `Customer` → `schema.prisma:L6652`
- `CustomerApprovalDelivery` → `schema.prisma:L8744`
- `CustomerApprovalOutbox` → `schema.prisma:L8719`
- `CustomerDiscount` → `schema.prisma:L7788`
- `CustomerGroup` → `schema.prisma:L6837`
- `CustomerTaxProfile` → `schema.prisma:L15561`
- `DeliveryActivationRequest` → `schema.prisma:L5895`
- `DeliveryChannelLink` → `schema.prisma:L5840`
- `DeliveryOrderEvent` → `schema.prisma:L5919`
- `DeviceToken` → `schema.prisma:L8057`
- `DigitalReceipt` → `schema.prisma:L4269`
- `Discount` → `schema.prisma:L7427`
- `EcommerceMerchant` → `schema.prisma:L5366`
- `EmailTemplate` → `schema.prisma:L12393`
- `Employee` → `schema.prisma:L16076`
- `Estimate` → `schema.prisma:L14023`
- `EstimateItem` → `schema.prisma:L14051`
- `Expense` → `schema.prisma:L15863`
- `ExternalBusyBlock` → `schema.prisma:L13396`
- `Feature` → `schema.prisma:L4398`
- `FeeSchedule` → `schema.prisma:L4476`
- `FeeTier` → `schema.prisma:L4487`
- `FinancialAccount` → `schema.prisma:L14213`
- `FinancialConnection` → `schema.prisma:L14182`
- `FinancialProvider` → `schema.prisma:L14168`
- `FiscalEmisor` → `schema.prisma:L15415`
- `FiscalLossCarryforward` → `schema.prisma:L15986`
- `FixedAsset` → `schema.prisma:L16004`
- `FixedAssetDepreciation` → `schema.prisma:L16033`
- `FloorElement` → `schema.prisma:L3089`
- `FulfillmentArea` → `schema.prisma:L14475`
- `GeofenceRule` → `schema.prisma:L9664`
- `GoogleCalendarChannel` → `schema.prisma:L13373`
- `GoogleCalendarConnection` → `schema.prisma:L13325`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13426`
- `GoogleOAuthSession` → `schema.prisma:L13448`
- `HolidayCalendar` → `schema.prisma:L6535`
- `IdempotencyRequest` → `schema.prisma:L11515`
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
- `InventoryTransfer` → `schema.prisma:L13995`
- `Invitation` → `schema.prisma:L1425`
- `Invoice` → `schema.prisma:L4499`
- `InvoiceItem` → `schema.prisma:L4525`
- `ItemCategory` → `schema.prisma:L11231`
- `JournalEntry` → `schema.prisma:L15773`
- `JournalLine` → `schema.prisma:L15801`
- `KdsOrder` → `schema.prisma:L14261`
- `KdsOrderItem` → `schema.prisma:L14302`
- `KioskCheckInAttempt` → `schema.prisma:L16722`
- `KioskCheckInChallenge` → `schema.prisma:L16676`
- `KioskOutreachOutbox` → `schema.prisma:L16743`
- `LearnedPatterns` → `schema.prisma:L9149`
- `LedgerAccount` → `schema.prisma:L15665`
- `LiveDemoSession` → `schema.prisma:L784`
- `LowStockAlert` → `schema.prisma:L2682`
- `LoyaltyConfig` → `schema.prisma:L6867`
- `LoyaltyTransaction` → `schema.prisma:L6910`
- `MarketingCampaign` → `schema.prisma:L12411`
- `McpAuthCode` → `schema.prisma:L15298`
- `McpOAuthClient` → `schema.prisma:L15282`
- `McpRefreshToken` → `schema.prisma:L15316`
- `McpToolCall` → `schema.prisma:L15337`
- `MeasurementUnit` → `schema.prisma:L14101`
- `Menu` → `schema.prisma:L1611`
- `MenuCategory` → `schema.prisma:L1548`
- `MenuCategoryAssignment` → `schema.prisma:L1646`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15212`
- `MerchantAccount` → `schema.prisma:L5104`
- `MerchantFiscalConfig` → `schema.prisma:L15463`
- `MerchantRevenueShare` → `schema.prisma:L6115`
- `MerchantRoutingRule` → `schema.prisma:L5226`
- `MilestoneAchievement` → `schema.prisma:L11835`
- `Modifier` → `schema.prisma:L3884`
- `ModifierGroup` → `schema.prisma:L3848`
- `Module` → `schema.prisma:L10140`
- `MoneyAnomaly` → `schema.prisma:L6018`
- `MonthlyVenueProfit` → `schema.prisma:L6561`
- `Notification` → `schema.prisma:L7959`
- `NotificationPreference` → `schema.prisma:L8006`
- `NotificationTemplate` → `schema.prisma:L8033`
- `OAuthState` → `schema.prisma:L1476`
- `OnboardingProgress` → `schema.prisma:L1494`
- `Order` → `schema.prisma:L3486`
- `OrderAction` → `schema.prisma:L3949`
- `OrderCustomer` → `schema.prisma:L3699`
- `OrderDiscount` → `schema.prisma:L7820`
- `OrderFulfillment` → `schema.prisma:L14530`
- `OrderFulfillmentLine` → `schema.prisma:L14561`
- `OrderItem` → `schema.prisma:L3715`
- `OrderItemModifier` → `schema.prisma:L3933`
- `OrderPromotion` → `schema.prisma:L16639`
- `OrderServiceCharge` → `schema.prisma:L7904`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12212`
- `OrganizationEntitlement` → `schema.prisma:L10423`
- `OrganizationGoal` → `schema.prisma:L12170`
- `OrganizationModule` → `schema.prisma:L10200`
- `OrganizationPaymentConfig` → `schema.prisma:L5678`
- `OrganizationPayoutConfig` → `schema.prisma:L12245`
- `OrganizationPricingStructure` → `schema.prisma:L5710`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12193`
- `OtpChallenge` → `schema.prisma:L6817`
- `PartnerAPIKey` → `schema.prisma:L5508`
- `Payment` → `schema.prisma:L3982`
- `PaymentAllocation` → `schema.prisma:L4248`
- `PaymentLink` → `schema.prisma:L13787`
- `PaymentLinkAttribution` → `schema.prisma:L13895`
- `PaymentLinkItem` → `schema.prisma:L13850`
- `PaymentLinkItemModifier` → `schema.prisma:L13877`
- `PaymentProvider` → `schema.prisma:L5063`
- `PayrollLine` → `schema.prisma:L16147`
- `PayrollRun` → `schema.prisma:L16116`
- `PerformanceGoal` → `schema.prisma:L12147`
- `PermissionOverride` → `schema.prisma:L1353`
- `PermissionSet` → `schema.prisma:L1376`
- `PlatformAnnouncement` → `schema.prisma:L16803`
- `PlatformAnnouncementClick` → `schema.prisma:L16868`
- `PlatformAnnouncementDelivery` → `schema.prisma:L16905`
- `PlatformCfdi` → `schema.prisma:L16432`
- `PlatformEmisor` → `schema.prisma:L16372`
- `PlatformSettings` → `schema.prisma:L5485`
- `PosCommand` → `schema.prisma:L8087`
- `PosConnectionStatus` → `schema.prisma:L904`
- `PosSyncIntent` → `schema.prisma:L16510`
- `PricingPolicy` → `schema.prisma:L2586`
- `Printer` → `schema.prisma:L14344`
- `PrintGateway` → `schema.prisma:L14397`
- `PrintJob` → `schema.prisma:L15111`
- `PrintStation` → `schema.prisma:L14415`
- `ProcessedStripeEvent` → `schema.prisma:L6004`
- `ProcessorReliabilityMetric` → `schema.prisma:L6489`
- `Product` → `schema.prisma:L1664`
- `ProductModifierGroup` → `schema.prisma:L3921`
- `ProductOption` → `schema.prisma:L14078`
- `ProductOptionValue` → `schema.prisma:L14089`
- `ProductStaff` → `schema.prisma:L13022`
- `PromoterBankAccount` → `schema.prisma:L16267`
- `PromoterCommissionEntry` → `schema.prisma:L16286`
- `PromoterLocationPing` → `schema.prisma:L3452`
- `Promotion` → `schema.prisma:L16561`
- `PromotionGroup` → `schema.prisma:L16600`
- `PromotionOption` → `schema.prisma:L16616`
- `ProviderCostStructure` → `schema.prisma:L6040`
- `ProviderEventLog` → `schema.prisma:L5787`
- `PurchaseOrder` → `schema.prisma:L2311`
- `PurchaseOrderInvoice` → `schema.prisma:L2456`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2513`
- `PurchaseOrderItem` → `schema.prisma:L2369`
- `RateCorrectionBatch` → `schema.prisma:L6265`
- `RateCorrectionEntry` → `schema.prisma:L6307`
- `RawMaterial` → `schema.prisma:L2068`
- `RawMaterialMovement` → `schema.prisma:L2639`
- `RawMaterialPresentation` → `schema.prisma:L2143`
- `Recipe` → `schema.prisma:L2163`
- `RecipeLine` → `schema.prisma:L2187`
- `Referral` → `schema.prisma:L7275`
- `ReferralProgramConfig` → `schema.prisma:L7240`
- `ReferralRewardGrant` → `schema.prisma:L7366`
- `ReferralTierReward` → `schema.prisma:L7338`
- `ReferralTierUnlock` → `schema.prisma:L7411`
- `RefreshGrant` → `schema.prisma:L16992`
- `Reservation` → `schema.prisma:L12790`
- `ReservationGoogleEventMapping` → `schema.prisma:L13560`
- `ReservationModifier` → `schema.prisma:L12970`
- `ReservationReminderSent` → `schema.prisma:L12953`
- `ReservationSettings` → `schema.prisma:L13184`
- `ReservationWaitlistEntry` → `schema.prisma:L13152`
- `Review` → `schema.prisma:L4543`
- `SalesRetention` → `schema.prisma:L15967`
- `SaleVerification` → `schema.prisma:L4302`
- `ScaleProfile` → `schema.prisma:L14852`
- `ScheduledCommand` → `schema.prisma:L9624`
- `SerializedItem` → `schema.prisma:L11274`
- `SerializedItemCustodyEvent` → `schema.prisma:L11438`
- `ServiceCharge` → `schema.prisma:L7875`
- `Session` → `schema.prisma:L16971`
- `SettlementConfiguration` → `schema.prisma:L6340`
- `SettlementConfirmation` → `schema.prisma:L6453`
- `SettlementIncident` → `schema.prisma:L6404`
- `SettlementSimulation` → `schema.prisma:L6375`
- `Shift` → `schema.prisma:L3127`
- `SimRegistrationRequest` → `schema.prisma:L11476`
- `SimRegistrationRequestItem` → `schema.prisma:L11498`
- `SlotHold` → `schema.prisma:L13053`
- `Staff` → `schema.prisma:L924`
- `StaffDocument` → `schema.prisma:L3323`
- `StaffOnboardingState` → `schema.prisma:L15182`
- `StaffOrganization` → `schema.prisma:L1252`
- `StaffPasskey` → `schema.prisma:L1279`
- `StaffSchedule` → `schema.prisma:L12993`
- `StaffScheduleException` → `schema.prisma:L13005`
- `StaffVenue` → `schema.prisma:L1177`
- `StaffWorkSchedule` → `schema.prisma:L3234`
- `StaffWorkScheduleException` → `schema.prisma:L3298`
- `StampCard` → `schema.prisma:L7123`
- `StampEvent` → `schema.prisma:L7162`
- `StampReward` → `schema.prisma:L7200`
- `StockAlertConfig` → `schema.prisma:L12129`
- `StockBatch` → `schema.prisma:L2790`
- `StockCount` → `schema.prisma:L2714`
- `StockCountItem` → `schema.prisma:L2738`
- `StripeWebhookEvent` → `schema.prisma:L5987`
- `Supplier` → `schema.prisma:L2222`
- `SupplierItemCode` → `schema.prisma:L2554`
- `SupplierPricing` → `schema.prisma:L2277`
- `Table` → `schema.prisma:L3039`
- `Terminal` → `schema.prisma:L4594`
- `TerminalHealth` → `schema.prisma:L4833`
- `TerminalLog` → `schema.prisma:L4807`
- `TerminalOrder` → `schema.prisma:L4966`
- `TerminalOrderItem` → `schema.prisma:L5041`
- `TerminalPaymentRequest` → `schema.prisma:L4904`
- `TimeEntry` → `schema.prisma:L3365`
- `TimeEntryBreak` → `schema.prisma:L3434`
- `TokenPurchase` → `schema.prisma:L9298`
- `TokenUsageRecord` → `schema.prisma:L9270`
- `TpvCommandHistory` → `schema.prisma:L9530`
- `TpvCommandQueue` → `schema.prisma:L9470`
- `TpvFeedback` → `schema.prisma:L9183`
- `TpvMessage` → `schema.prisma:L12486`
- `TpvMessageDelivery` → `schema.prisma:L12538`
- `TpvMessageResponse` → `schema.prisma:L12561`
- `TrainingModule` → `schema.prisma:L12616`
- `TrainingProgress` → `schema.prisma:L12693`
- `TrainingQuizQuestion` → `schema.prisma:L12675`
- `TrainingStep` → `schema.prisma:L12655`
- `TransactionCost` → `schema.prisma:L6203`
- `UnitConversion` → `schema.prisma:L2617`
- `UpsellAcceptance` → `schema.prisma:L7696`
- `UpsellAiRun` → `schema.prisma:L7716`
- `UpsellImpression` → `schema.prisma:L7656`
- `UpsellRule` → `schema.prisma:L7576`
- `user_sessions` → `schema.prisma:L5543`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14589`
- `VenueChatMessage` → `schema.prisma:L760`
- `VenueChatSession` → `schema.prisma:L715`
- `VenueCommission` → `schema.prisma:L14239`
- `VenueCreditAssessment` → `schema.prisma:L10012`
- `VenueCryptoConfig` → `schema.prisma:L12353`
- `VenueFeature` → `schema.prisma:L4416`
- `VenueModule` → `schema.prisma:L10172`
- `VenuePaymentConfig` → `schema.prisma:L5644`
- `VenuePaymentLinkSettings` → `schema.prisma:L13593`
- `VenuePricingStructure` → `schema.prisma:L6143`
- `VenueRoleConfig` → `schema.prisma:L1405`
- `VenueRolePermission` → `schema.prisma:L1309`
- `VenueScaleSettings` → `schema.prisma:L14840`
- `VenueSettings` → `schema.prisma:L800`
- `VenueTenderType` → `schema.prisma:L4161`
- `VenueTenderTypeRevision` → `schema.prisma:L4226`
- `VenueTransaction` → `schema.prisma:L4353`
- `VenueWhatsappActivation` → `schema.prisma:L651`
- `WalletCardDesign` → `schema.prisma:L7041`
- `WalletPass` → `schema.prisma:L6950`
- `WalletPassRegistration` → `schema.prisma:L7008`
- `WebhookEvent` → `schema.prisma:L4452`
- `WebhookSubscription` → `schema.prisma:L5760`
- `WhatsappContactWindow` → `schema.prisma:L669`
- `WhatsappInboundEvent` → `schema.prisma:L689`
- `WorkShiftAssignment` → `schema.prisma:L3274`
- `WorkShiftTemplate` → `schema.prisma:L3251`
- `Zone` → `schema.prisma:L142`
