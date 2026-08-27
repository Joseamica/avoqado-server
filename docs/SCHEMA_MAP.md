# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **348 models / 336 enums / ~16,700 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L15749`
- `AccountMapping` → `schema.prisma:L15645`
- `ActivityLog` → `schema.prisma:L6542`
- `Aggregator` → `schema.prisma:L14046`
- `AngelPayUserAccount` → `schema.prisma:L5205`
- `AppUpdate` → `schema.prisma:L12226`
- `Area` → `schema.prisma:L2993`
- `AreaTicket` → `schema.prisma:L14540`
- `AreaTicketCheckoutSession` → `schema.prisma:L14662`
- `AreaTicketExternalIncident` → `schema.prisma:L14909`
- `AreaTicketExternalSettlement` → `schema.prisma:L14874`
- `AreaTicketFulfillment` → `schema.prisma:L14738`
- `AreaTicketInventoryReservation` → `schema.prisma:L14633`
- `AreaTicketLine` → `schema.prisma:L14601`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14694`
- `AreaTicketPrintAttempt` → `schema.prisma:L14717`
- `BankStatement` → `schema.prisma:L15519`
- `BankStatementLine` → `schema.prisma:L15540`
- `BillingTaxProfile` → `schema.prisma:L16329`
- `BulkCommandOperation` → `schema.prisma:L9509`
- `CalendarSyncOutbox` → `schema.prisma:L13433`
- `CampaignDelivery` → `schema.prisma:L12384`
- `CashCloseout` → `schema.prisma:L9894`
- `CashDeposit` → `schema.prisma:L12028`
- `CashDrawerEvent` → `schema.prisma:L13883`
- `CashDrawerSession` → `schema.prisma:L13859`
- `CashOutCommissionRate` → `schema.prisma:L16158`
- `CashOutScheduleDay` → `schema.prisma:L16181`
- `CashOutWithdrawal` → `schema.prisma:L16243`
- `CatalogBindingBatch` → `schema.prisma:L10925`
- `CatalogBindingLine` → `schema.prisma:L10961`
- `CatalogBrand` → `schema.prisma:L10378`
- `CatalogClientObservation` → `schema.prisma:L10691`
- `CatalogClientReadinessOverride` → `schema.prisma:L10710`
- `CatalogFamily` → `schema.prisma:L10428`
- `CatalogIdempotencyRecord` → `schema.prisma:L10824`
- `CatalogIdentifier` → `schema.prisma:L10559`
- `CatalogImportBatch` → `schema.prisma:L10867`
- `CatalogImportLine` → `schema.prisma:L10904`
- `CatalogItem` → `schema.prisma:L10461`
- `CatalogItemBusinessType` → `schema.prisma:L10521`
- `CatalogItemPrice` → `schema.prisma:L10609`
- `CatalogManufacturer` → `schema.prisma:L10402`
- `CatalogProductTypeMapping` → `schema.prisma:L10538`
- `CatalogPublicationBatch` → `schema.prisma:L10989`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11083`
- `CatalogPublicationLine` → `schema.prisma:L11030`
- `CatalogPublicationOutbox` → `schema.prisma:L11126`
- `CatalogValidationProfile` → `schema.prisma:L10580`
- `CatalogVenueBinding` → `schema.prisma:L10738`
- `CatalogVenueClientRequirement` → `schema.prisma:L10665`
- `CatalogVenueEventSequence` → `schema.prisma:L11109`
- `CatalogVenueOverride` → `schema.prisma:L10780`
- `CatalogVenueRollout` → `schema.prisma:L10640`
- `Cfdi` → `schema.prisma:L15422`
- `ChatbotTokenBudget` → `schema.prisma:L9157`
- `ChatConversation` → `schema.prisma:L9012`
- `ChatFeedback` → `schema.prisma:L9098`
- `ChatLearningEvent` → `schema.prisma:L9055`
- `ChatMessage` → `schema.prisma:L9035`
- `ChatTrainingData` → `schema.prisma:L8969`
- `CheckoutSession` → `schema.prisma:L5485`
- `ClassSession` → `schema.prisma:L13037`
- `CommissionCalculation` → `schema.prisma:L11804`
- `CommissionClawback` → `schema.prisma:L11980`
- `CommissionConfig` → `schema.prisma:L11570`
- `CommissionMilestone` → `schema.prisma:L11720`
- `CommissionOverride` → `schema.prisma:L11647`
- `CommissionPayout` → `schema.prisma:L11931`
- `CommissionSummary` → `schema.prisma:L11870`
- `CommissionTier` → `schema.prisma:L11684`
- `Consumer` → `schema.prisma:L6704`
- `ConsumerAuthAccount` → `schema.prisma:L6729`
- `CouponCode` → `schema.prisma:L7667`
- `CouponRedemption` → `schema.prisma:L7698`
- `CreditAssessmentHistory` → `schema.prisma:L10003`
- `CreditItemBalance` → `schema.prisma:L13649`
- `CreditOffer` → `schema.prisma:L10022`
- `CreditPack` → `schema.prisma:L13558`
- `CreditPackItem` → `schema.prisma:L13587`
- `CreditPackPurchase` → `schema.prisma:L13604`
- `CreditTransaction` → `schema.prisma:L13671`
- `Customer` → `schema.prisma:L6583`
- `CustomerApprovalDelivery` → `schema.prisma:L8674`
- `CustomerApprovalOutbox` → `schema.prisma:L8649`
- `CustomerDiscount` → `schema.prisma:L7718`
- `CustomerGroup` → `schema.prisma:L6768`
- `CustomerTaxProfile` → `schema.prisma:L15491`
- `DeliveryActivationRequest` → `schema.prisma:L5826`
- `DeliveryChannelLink` → `schema.prisma:L5771`
- `DeliveryOrderEvent` → `schema.prisma:L5850`
- `DeviceToken` → `schema.prisma:L7987`
- `DigitalReceipt` → `schema.prisma:L4200`
- `Discount` → `schema.prisma:L7357`
- `EcommerceMerchant` → `schema.prisma:L5297`
- `EmailTemplate` → `schema.prisma:L12323`
- `Employee` → `schema.prisma:L16006`
- `Estimate` → `schema.prisma:L13953`
- `EstimateItem` → `schema.prisma:L13981`
- `Expense` → `schema.prisma:L15793`
- `ExternalBusyBlock` → `schema.prisma:L13326`
- `Feature` → `schema.prisma:L4329`
- `FeeSchedule` → `schema.prisma:L4407`
- `FeeTier` → `schema.prisma:L4418`
- `FinancialAccount` → `schema.prisma:L14143`
- `FinancialConnection` → `schema.prisma:L14112`
- `FinancialProvider` → `schema.prisma:L14098`
- `FiscalEmisor` → `schema.prisma:L15345`
- `FiscalLossCarryforward` → `schema.prisma:L15916`
- `FixedAsset` → `schema.prisma:L15934`
- `FixedAssetDepreciation` → `schema.prisma:L15963`
- `FloorElement` → `schema.prisma:L3069`
- `FulfillmentArea` → `schema.prisma:L14405`
- `GeofenceRule` → `schema.prisma:L9594`
- `GoogleCalendarChannel` → `schema.prisma:L13303`
- `GoogleCalendarConnection` → `schema.prisma:L13255`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13356`
- `GoogleOAuthSession` → `schema.prisma:L13378`
- `HolidayCalendar` → `schema.prisma:L6466`
- `IdempotencyRequest` → `schema.prisma:L11445`
- `InterVenueTransfer` → `schema.prisma:L2821`
- `InterVenueTransferAllocation` → `schema.prisma:L2904`
- `InterVenueTransferItem` → `schema.prisma:L2873`
- `InterVenueTransferReceipt` → `schema.prisma:L2931`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2947`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2975`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2959`
- `Inventory` → `schema.prisma:L1867`
- `InventoryMovement` → `schema.prisma:L1894`
- `InventoryPosting` → `schema.prisma:L1976`
- `InventoryPostingLine` → `schema.prisma:L2016`
- `InventoryTransfer` → `schema.prisma:L13925`
- `Invitation` → `schema.prisma:L1405`
- `Invoice` → `schema.prisma:L4430`
- `InvoiceItem` → `schema.prisma:L4456`
- `ItemCategory` → `schema.prisma:L11161`
- `JournalEntry` → `schema.prisma:L15703`
- `JournalLine` → `schema.prisma:L15731`
- `KdsOrder` → `schema.prisma:L14191`
- `KdsOrderItem` → `schema.prisma:L14232`
- `KioskCheckInAttempt` → `schema.prisma:L16652`
- `KioskCheckInChallenge` → `schema.prisma:L16606`
- `KioskOutreachOutbox` → `schema.prisma:L16673`
- `LearnedPatterns` → `schema.prisma:L9079`
- `LedgerAccount` → `schema.prisma:L15595`
- `LiveDemoSession` → `schema.prisma:L784`
- `LowStockAlert` → `schema.prisma:L2662`
- `LoyaltyConfig` → `schema.prisma:L6798`
- `LoyaltyTransaction` → `schema.prisma:L6841`
- `MarketingCampaign` → `schema.prisma:L12341`
- `McpAuthCode` → `schema.prisma:L15228`
- `McpOAuthClient` → `schema.prisma:L15212`
- `McpRefreshToken` → `schema.prisma:L15246`
- `McpToolCall` → `schema.prisma:L15267`
- `MeasurementUnit` → `schema.prisma:L14031`
- `Menu` → `schema.prisma:L1591`
- `MenuCategory` → `schema.prisma:L1528`
- `MenuCategoryAssignment` → `schema.prisma:L1626`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15142`
- `MerchantAccount` → `schema.prisma:L5035`
- `MerchantFiscalConfig` → `schema.prisma:L15393`
- `MerchantRevenueShare` → `schema.prisma:L6046`
- `MerchantRoutingRule` → `schema.prisma:L5157`
- `MilestoneAchievement` → `schema.prisma:L11765`
- `Modifier` → `schema.prisma:L3815`
- `ModifierGroup` → `schema.prisma:L3779`
- `Module` → `schema.prisma:L10070`
- `MoneyAnomaly` → `schema.prisma:L5949`
- `MonthlyVenueProfit` → `schema.prisma:L6492`
- `Notification` → `schema.prisma:L7889`
- `NotificationPreference` → `schema.prisma:L7936`
- `NotificationTemplate` → `schema.prisma:L7963`
- `OAuthState` → `schema.prisma:L1456`
- `OnboardingProgress` → `schema.prisma:L1474`
- `Order` → `schema.prisma:L3417`
- `OrderAction` → `schema.prisma:L3880`
- `OrderCustomer` → `schema.prisma:L3630`
- `OrderDiscount` → `schema.prisma:L7750`
- `OrderFulfillment` → `schema.prisma:L14460`
- `OrderFulfillmentLine` → `schema.prisma:L14491`
- `OrderItem` → `schema.prisma:L3646`
- `OrderItemModifier` → `schema.prisma:L3864`
- `OrderPromotion` → `schema.prisma:L16569`
- `OrderServiceCharge` → `schema.prisma:L7834`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12142`
- `OrganizationEntitlement` → `schema.prisma:L10353`
- `OrganizationGoal` → `schema.prisma:L12100`
- `OrganizationModule` → `schema.prisma:L10130`
- `OrganizationPaymentConfig` → `schema.prisma:L5609`
- `OrganizationPayoutConfig` → `schema.prisma:L12175`
- `OrganizationPricingStructure` → `schema.prisma:L5641`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12123`
- `OtpChallenge` → `schema.prisma:L6748`
- `PartnerAPIKey` → `schema.prisma:L5439`
- `Payment` → `schema.prisma:L3913`
- `PaymentAllocation` → `schema.prisma:L4179`
- `PaymentLink` → `schema.prisma:L13717`
- `PaymentLinkAttribution` → `schema.prisma:L13825`
- `PaymentLinkItem` → `schema.prisma:L13780`
- `PaymentLinkItemModifier` → `schema.prisma:L13807`
- `PaymentProvider` → `schema.prisma:L4994`
- `PayrollLine` → `schema.prisma:L16077`
- `PayrollRun` → `schema.prisma:L16046`
- `PerformanceGoal` → `schema.prisma:L12077`
- `PermissionOverride` → `schema.prisma:L1333`
- `PermissionSet` → `schema.prisma:L1356`
- `PlatformCfdi` → `schema.prisma:L16362`
- `PlatformEmisor` → `schema.prisma:L16302`
- `PlatformSettings` → `schema.prisma:L5416`
- `PosCommand` → `schema.prisma:L8017`
- `PosConnectionStatus` → `schema.prisma:L899`
- `PosSyncIntent` → `schema.prisma:L16440`
- `PricingPolicy` → `schema.prisma:L2566`
- `Printer` → `schema.prisma:L14274`
- `PrintGateway` → `schema.prisma:L14327`
- `PrintJob` → `schema.prisma:L15041`
- `PrintStation` → `schema.prisma:L14345`
- `ProcessedStripeEvent` → `schema.prisma:L5935`
- `ProcessorReliabilityMetric` → `schema.prisma:L6420`
- `Product` → `schema.prisma:L1644`
- `ProductModifierGroup` → `schema.prisma:L3852`
- `ProductOption` → `schema.prisma:L14008`
- `ProductOptionValue` → `schema.prisma:L14019`
- `ProductStaff` → `schema.prisma:L12952`
- `PromoterBankAccount` → `schema.prisma:L16197`
- `PromoterCommissionEntry` → `schema.prisma:L16216`
- `PromoterLocationPing` → `schema.prisma:L3383`
- `Promotion` → `schema.prisma:L16491`
- `PromotionGroup` → `schema.prisma:L16530`
- `PromotionOption` → `schema.prisma:L16546`
- `ProviderCostStructure` → `schema.prisma:L5971`
- `ProviderEventLog` → `schema.prisma:L5718`
- `PurchaseOrder` → `schema.prisma:L2291`
- `PurchaseOrderInvoice` → `schema.prisma:L2436`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2493`
- `PurchaseOrderItem` → `schema.prisma:L2349`
- `RateCorrectionBatch` → `schema.prisma:L6196`
- `RateCorrectionEntry` → `schema.prisma:L6238`
- `RawMaterial` → `schema.prisma:L2048`
- `RawMaterialMovement` → `schema.prisma:L2619`
- `RawMaterialPresentation` → `schema.prisma:L2123`
- `Recipe` → `schema.prisma:L2143`
- `RecipeLine` → `schema.prisma:L2167`
- `Referral` → `schema.prisma:L7205`
- `ReferralProgramConfig` → `schema.prisma:L7170`
- `ReferralRewardGrant` → `schema.prisma:L7296`
- `ReferralTierReward` → `schema.prisma:L7268`
- `ReferralTierUnlock` → `schema.prisma:L7341`
- `Reservation` → `schema.prisma:L12720`
- `ReservationGoogleEventMapping` → `schema.prisma:L13490`
- `ReservationModifier` → `schema.prisma:L12900`
- `ReservationReminderSent` → `schema.prisma:L12883`
- `ReservationSettings` → `schema.prisma:L13114`
- `ReservationWaitlistEntry` → `schema.prisma:L13082`
- `Review` → `schema.prisma:L4474`
- `SalesRetention` → `schema.prisma:L15897`
- `SaleVerification` → `schema.prisma:L4233`
- `ScaleProfile` → `schema.prisma:L14782`
- `ScheduledCommand` → `schema.prisma:L9554`
- `SerializedItem` → `schema.prisma:L11204`
- `SerializedItemCustodyEvent` → `schema.prisma:L11368`
- `ServiceCharge` → `schema.prisma:L7805`
- `SettlementConfiguration` → `schema.prisma:L6271`
- `SettlementConfirmation` → `schema.prisma:L6384`
- `SettlementIncident` → `schema.prisma:L6335`
- `SettlementSimulation` → `schema.prisma:L6306`
- `Shift` → `schema.prisma:L3107`
- `SimRegistrationRequest` → `schema.prisma:L11406`
- `SimRegistrationRequestItem` → `schema.prisma:L11428`
- `SlotHold` → `schema.prisma:L12983`
- `Staff` → `schema.prisma:L919`
- `StaffDocument` → `schema.prisma:L3254`
- `StaffOnboardingState` → `schema.prisma:L15112`
- `StaffOrganization` → `schema.prisma:L1232`
- `StaffPasskey` → `schema.prisma:L1259`
- `StaffSchedule` → `schema.prisma:L12923`
- `StaffScheduleException` → `schema.prisma:L12935`
- `StaffVenue` → `schema.prisma:L1158`
- `StaffWorkSchedule` → `schema.prisma:L3214`
- `StaffWorkScheduleException` → `schema.prisma:L3229`
- `StampCard` → `schema.prisma:L7053`
- `StampEvent` → `schema.prisma:L7092`
- `StampReward` → `schema.prisma:L7130`
- `StockAlertConfig` → `schema.prisma:L12059`
- `StockBatch` → `schema.prisma:L2770`
- `StockCount` → `schema.prisma:L2694`
- `StockCountItem` → `schema.prisma:L2718`
- `StripeWebhookEvent` → `schema.prisma:L5918`
- `Supplier` → `schema.prisma:L2202`
- `SupplierItemCode` → `schema.prisma:L2534`
- `SupplierPricing` → `schema.prisma:L2257`
- `Table` → `schema.prisma:L3019`
- `Terminal` → `schema.prisma:L4525`
- `TerminalHealth` → `schema.prisma:L4764`
- `TerminalLog` → `schema.prisma:L4738`
- `TerminalOrder` → `schema.prisma:L4897`
- `TerminalOrderItem` → `schema.prisma:L4972`
- `TerminalPaymentRequest` → `schema.prisma:L4835`
- `TimeEntry` → `schema.prisma:L3296`
- `TimeEntryBreak` → `schema.prisma:L3365`
- `TokenPurchase` → `schema.prisma:L9228`
- `TokenUsageRecord` → `schema.prisma:L9200`
- `TpvCommandHistory` → `schema.prisma:L9460`
- `TpvCommandQueue` → `schema.prisma:L9400`
- `TpvFeedback` → `schema.prisma:L9113`
- `TpvMessage` → `schema.prisma:L12416`
- `TpvMessageDelivery` → `schema.prisma:L12468`
- `TpvMessageResponse` → `schema.prisma:L12491`
- `TrainingModule` → `schema.prisma:L12546`
- `TrainingProgress` → `schema.prisma:L12623`
- `TrainingQuizQuestion` → `schema.prisma:L12605`
- `TrainingStep` → `schema.prisma:L12585`
- `TransactionCost` → `schema.prisma:L6134`
- `UnitConversion` → `schema.prisma:L2597`
- `UpsellAcceptance` → `schema.prisma:L7626`
- `UpsellAiRun` → `schema.prisma:L7646`
- `UpsellImpression` → `schema.prisma:L7586`
- `UpsellRule` → `schema.prisma:L7506`
- `user_sessions` → `schema.prisma:L5474`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14519`
- `VenueChatMessage` → `schema.prisma:L760`
- `VenueChatSession` → `schema.prisma:L715`
- `VenueCommission` → `schema.prisma:L14169`
- `VenueCreditAssessment` → `schema.prisma:L9942`
- `VenueCryptoConfig` → `schema.prisma:L12283`
- `VenueFeature` → `schema.prisma:L4347`
- `VenueModule` → `schema.prisma:L10102`
- `VenuePaymentConfig` → `schema.prisma:L5575`
- `VenuePaymentLinkSettings` → `schema.prisma:L13523`
- `VenuePricingStructure` → `schema.prisma:L6074`
- `VenueRoleConfig` → `schema.prisma:L1385`
- `VenueRolePermission` → `schema.prisma:L1289`
- `VenueScaleSettings` → `schema.prisma:L14770`
- `VenueSettings` → `schema.prisma:L800`
- `VenueTenderType` → `schema.prisma:L4092`
- `VenueTenderTypeRevision` → `schema.prisma:L4157`
- `VenueTransaction` → `schema.prisma:L4284`
- `VenueWhatsappActivation` → `schema.prisma:L651`
- `WalletCardDesign` → `schema.prisma:L6972`
- `WalletPass` → `schema.prisma:L6881`
- `WalletPassRegistration` → `schema.prisma:L6939`
- `WebhookEvent` → `schema.prisma:L4383`
- `WebhookSubscription` → `schema.prisma:L5691`
- `WhatsappContactWindow` → `schema.prisma:L669`
- `WhatsappInboundEvent` → `schema.prisma:L689`
- `Zone` → `schema.prisma:L142`
