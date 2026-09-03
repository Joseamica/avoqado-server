# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **357 models / 339 enums / ~17,100 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L15957`
- `AccountMapping` → `schema.prisma:L15853`
- `ActivityLog` → `schema.prisma:L6723`
- `Aggregator` → `schema.prisma:L14250`
- `AngelPayUserAccount` → `schema.prisma:L5386`
- `AppUpdate` → `schema.prisma:L12415`
- `Area` → `schema.prisma:L3028`
- `AreaTicket` → `schema.prisma:L14748`
- `AreaTicketCheckoutSession` → `schema.prisma:L14870`
- `AreaTicketExternalIncident` → `schema.prisma:L15117`
- `AreaTicketExternalSettlement` → `schema.prisma:L15082`
- `AreaTicketFulfillment` → `schema.prisma:L14946`
- `AreaTicketInventoryReservation` → `schema.prisma:L14841`
- `AreaTicketLine` → `schema.prisma:L14809`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14902`
- `AreaTicketPrintAttempt` → `schema.prisma:L14925`
- `BankStatement` → `schema.prisma:L15727`
- `BankStatementLine` → `schema.prisma:L15748`
- `BillingTaxProfile` → `schema.prisma:L16537`
- `BulkCommandOperation` → `schema.prisma:L9695`
- `CalendarSyncOutbox` → `schema.prisma:L13622`
- `CampaignDelivery` → `schema.prisma:L12573`
- `CashCloseout` → `schema.prisma:L10080`
- `CashDeposit` → `schema.prisma:L12217`
- `CashDrawerEvent` → `schema.prisma:L14087`
- `CashDrawerSession` → `schema.prisma:L14048`
- `CashOutCommissionRate` → `schema.prisma:L16366`
- `CashOutScheduleDay` → `schema.prisma:L16389`
- `CashOutWithdrawal` → `schema.prisma:L16451`
- `CatalogBindingBatch` → `schema.prisma:L11111`
- `CatalogBindingLine` → `schema.prisma:L11147`
- `CatalogBrand` → `schema.prisma:L10564`
- `CatalogClientObservation` → `schema.prisma:L10877`
- `CatalogClientReadinessOverride` → `schema.prisma:L10896`
- `CatalogFamily` → `schema.prisma:L10614`
- `CatalogIdempotencyRecord` → `schema.prisma:L11010`
- `CatalogIdentifier` → `schema.prisma:L10745`
- `CatalogImportBatch` → `schema.prisma:L11053`
- `CatalogImportLine` → `schema.prisma:L11090`
- `CatalogItem` → `schema.prisma:L10647`
- `CatalogItemBusinessType` → `schema.prisma:L10707`
- `CatalogItemPrice` → `schema.prisma:L10795`
- `CatalogManufacturer` → `schema.prisma:L10588`
- `CatalogProductTypeMapping` → `schema.prisma:L10724`
- `CatalogPublicationBatch` → `schema.prisma:L11175`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11269`
- `CatalogPublicationLine` → `schema.prisma:L11216`
- `CatalogPublicationOutbox` → `schema.prisma:L11312`
- `CatalogValidationProfile` → `schema.prisma:L10766`
- `CatalogVenueBinding` → `schema.prisma:L10924`
- `CatalogVenueClientRequirement` → `schema.prisma:L10851`
- `CatalogVenueEventSequence` → `schema.prisma:L11295`
- `CatalogVenueOverride` → `schema.prisma:L10966`
- `CatalogVenueRollout` → `schema.prisma:L10826`
- `Cfdi` → `schema.prisma:L15630`
- `ChatbotTokenBudget` → `schema.prisma:L9343`
- `ChatConversation` → `schema.prisma:L9198`
- `ChatFeedback` → `schema.prisma:L9284`
- `ChatLearningEvent` → `schema.prisma:L9241`
- `ChatMessage` → `schema.prisma:L9221`
- `ChatTrainingData` → `schema.prisma:L9155`
- `CheckoutSession` → `schema.prisma:L5666`
- `ClassSession` → `schema.prisma:L13226`
- `CommissionCalculation` → `schema.prisma:L11993`
- `CommissionClawback` → `schema.prisma:L12169`
- `CommissionConfig` → `schema.prisma:L11759`
- `CommissionMilestone` → `schema.prisma:L11909`
- `CommissionOverride` → `schema.prisma:L11836`
- `CommissionPayout` → `schema.prisma:L12120`
- `CommissionSummary` → `schema.prisma:L12059`
- `CommissionTier` → `schema.prisma:L11873`
- `Consumer` → `schema.prisma:L6886`
- `ConsumerAuthAccount` → `schema.prisma:L6911`
- `CouponCode` → `schema.prisma:L7850`
- `CouponRedemption` → `schema.prisma:L7881`
- `CreditAssessmentHistory` → `schema.prisma:L10189`
- `CreditItemBalance` → `schema.prisma:L13838`
- `CreditOffer` → `schema.prisma:L10208`
- `CreditPack` → `schema.prisma:L13747`
- `CreditPackItem` → `schema.prisma:L13776`
- `CreditPackPurchase` → `schema.prisma:L13793`
- `CreditTransaction` → `schema.prisma:L13860`
- `Customer` → `schema.prisma:L6764`
- `CustomerApprovalDelivery` → `schema.prisma:L8857`
- `CustomerApprovalOutbox` → `schema.prisma:L8832`
- `CustomerDiscount` → `schema.prisma:L7901`
- `CustomerGroup` → `schema.prisma:L6950`
- `CustomerOrderMetric` → `schema.prisma:L3798`
- `CustomerTaxProfile` → `schema.prisma:L15699`
- `DeliveryActivationRequest` → `schema.prisma:L6007`
- `DeliveryChannelLink` → `schema.prisma:L5952`
- `DeliveryOrderEvent` → `schema.prisma:L6031`
- `DeviceToken` → `schema.prisma:L8170`
- `DigitalReceipt` → `schema.prisma:L4369`
- `Discount` → `schema.prisma:L7540`
- `EcommerceMerchant` → `schema.prisma:L5478`
- `EmailTemplate` → `schema.prisma:L12512`
- `Employee` → `schema.prisma:L16214`
- `Estimate` → `schema.prisma:L14157`
- `EstimateItem` → `schema.prisma:L14185`
- `Expense` → `schema.prisma:L16001`
- `ExternalBusyBlock` → `schema.prisma:L13515`
- `Feature` → `schema.prisma:L4498`
- `FeeSchedule` → `schema.prisma:L4576`
- `FeeTier` → `schema.prisma:L4587`
- `FinancialAccount` → `schema.prisma:L14347`
- `FinancialConnection` → `schema.prisma:L14316`
- `FinancialProvider` → `schema.prisma:L14302`
- `FiscalEmisor` → `schema.prisma:L15553`
- `FiscalLossCarryforward` → `schema.prisma:L16124`
- `FixedAsset` → `schema.prisma:L16142`
- `FixedAssetDepreciation` → `schema.prisma:L16171`
- `FloorElement` → `schema.prisma:L3104`
- `FulfillmentArea` → `schema.prisma:L14613`
- `GeofenceRule` → `schema.prisma:L9780`
- `GoogleCalendarChannel` → `schema.prisma:L13492`
- `GoogleCalendarConnection` → `schema.prisma:L13444`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13545`
- `GoogleOAuthSession` → `schema.prisma:L13567`
- `HolidayCalendar` → `schema.prisma:L6647`
- `IdempotencyRequest` → `schema.prisma:L11634`
- `InterVenueTransfer` → `schema.prisma:L2856`
- `InterVenueTransferAllocation` → `schema.prisma:L2939`
- `InterVenueTransferItem` → `schema.prisma:L2908`
- `InterVenueTransferReceipt` → `schema.prisma:L2966`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2982`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3010`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2994`
- `Inventory` → `schema.prisma:L1902`
- `InventoryMovement` → `schema.prisma:L1929`
- `InventoryPosting` → `schema.prisma:L2011`
- `InventoryPostingLine` → `schema.prisma:L2051`
- `InventoryTransfer` → `schema.prisma:L14129`
- `Invitation` → `schema.prisma:L1440`
- `Invoice` → `schema.prisma:L4599`
- `InvoiceItem` → `schema.prisma:L4625`
- `ItemCategory` → `schema.prisma:L11347`
- `JournalEntry` → `schema.prisma:L15911`
- `JournalLine` → `schema.prisma:L15939`
- `KdsOrder` → `schema.prisma:L14395`
- `KdsOrderItem` → `schema.prisma:L14436`
- `KioskCheckInAttempt` → `schema.prisma:L16860`
- `KioskCheckInChallenge` → `schema.prisma:L16814`
- `KioskOutreachOutbox` → `schema.prisma:L16881`
- `LearnedPatterns` → `schema.prisma:L9265`
- `LedgerAccount` → `schema.prisma:L15803`
- `LiveDemoSession` → `schema.prisma:L785`
- `LowStockAlert` → `schema.prisma:L2697`
- `LoyaltyConfig` → `schema.prisma:L6980`
- `LoyaltyTransaction` → `schema.prisma:L7023`
- `MarketingCampaign` → `schema.prisma:L12530`
- `McpAuthCode` → `schema.prisma:L15436`
- `McpOAuthClient` → `schema.prisma:L15420`
- `McpRefreshToken` → `schema.prisma:L15454`
- `McpToolCall` → `schema.prisma:L15475`
- `MeasurementUnit` → `schema.prisma:L14235`
- `Menu` → `schema.prisma:L1626`
- `MenuCategory` → `schema.prisma:L1563`
- `MenuCategoryAssignment` → `schema.prisma:L1661`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15350`
- `MerchantAccount` → `schema.prisma:L5216`
- `MerchantFiscalConfig` → `schema.prisma:L15601`
- `MerchantRevenueShare` → `schema.prisma:L6227`
- `MerchantRoutingRule` → `schema.prisma:L5338`
- `MilestoneAchievement` → `schema.prisma:L11954`
- `Modifier` → `schema.prisma:L3982`
- `ModifierGroup` → `schema.prisma:L3946`
- `Module` → `schema.prisma:L10256`
- `MoneyAnomaly` → `schema.prisma:L6130`
- `MonthlyVenueProfit` → `schema.prisma:L6673`
- `Notification` → `schema.prisma:L8072`
- `NotificationPreference` → `schema.prisma:L8119`
- `NotificationTemplate` → `schema.prisma:L8146`
- `OAuthState` → `schema.prisma:L1491`
- `OnboardingProgress` → `schema.prisma:L1509`
- `Order` → `schema.prisma:L3553`
- `OrderAction` → `schema.prisma:L4049`
- `OrderCustomer` → `schema.prisma:L3777`
- `OrderDiscount` → `schema.prisma:L7933`
- `OrderFulfillment` → `schema.prisma:L14668`
- `OrderFulfillmentLine` → `schema.prisma:L14699`
- `OrderItem` → `schema.prisma:L3813`
- `OrderItemModifier` → `schema.prisma:L4031`
- `OrderPromotion` → `schema.prisma:L16777`
- `OrderServiceCharge` → `schema.prisma:L8017`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12331`
- `OrganizationEntitlement` → `schema.prisma:L10539`
- `OrganizationGoal` → `schema.prisma:L12289`
- `OrganizationModule` → `schema.prisma:L10316`
- `OrganizationPaymentConfig` → `schema.prisma:L5790`
- `OrganizationPayoutConfig` → `schema.prisma:L12364`
- `OrganizationPricingStructure` → `schema.prisma:L5822`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12312`
- `OtpChallenge` → `schema.prisma:L6930`
- `OvertimeApproval` → `schema.prisma:L3331`
- `PartnerAPIKey` → `schema.prisma:L5620`
- `Payment` → `schema.prisma:L4082`
- `PaymentAllocation` → `schema.prisma:L4348`
- `PaymentLink` → `schema.prisma:L13906`
- `PaymentLinkAttribution` → `schema.prisma:L14014`
- `PaymentLinkItem` → `schema.prisma:L13969`
- `PaymentLinkItemModifier` → `schema.prisma:L13996`
- `PaymentProvider` → `schema.prisma:L5175`
- `PayrollLine` → `schema.prisma:L16285`
- `PayrollRun` → `schema.prisma:L16254`
- `PerformanceGoal` → `schema.prisma:L12266`
- `PermissionOverride` → `schema.prisma:L1364`
- `PermissionSet` → `schema.prisma:L1387`
- `PlatformAnnouncement` → `schema.prisma:L16941`
- `PlatformAnnouncementClick` → `schema.prisma:L17006`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17043`
- `PlatformCfdi` → `schema.prisma:L16570`
- `PlatformEmisor` → `schema.prisma:L16510`
- `PlatformSettings` → `schema.prisma:L5597`
- `PosCommand` → `schema.prisma:L8200`
- `PosConnectionStatus` → `schema.prisma:L911`
- `PosSyncIntent` → `schema.prisma:L16648`
- `PricingPolicy` → `schema.prisma:L2601`
- `Printer` → `schema.prisma:L14478`
- `PrintGateway` → `schema.prisma:L14535`
- `PrintJob` → `schema.prisma:L15249`
- `PrintStation` → `schema.prisma:L14553`
- `ProcessedStripeEvent` → `schema.prisma:L6116`
- `ProcessorReliabilityMetric` → `schema.prisma:L6601`
- `Product` → `schema.prisma:L1679`
- `ProductModifierGroup` → `schema.prisma:L4019`
- `ProductOption` → `schema.prisma:L14212`
- `ProductOptionValue` → `schema.prisma:L14223`
- `ProductStaff` → `schema.prisma:L13141`
- `PromoterBankAccount` → `schema.prisma:L16405`
- `PromoterCommissionEntry` → `schema.prisma:L16424`
- `PromoterLocationPing` → `schema.prisma:L3519`
- `Promotion` → `schema.prisma:L16699`
- `PromotionGroup` → `schema.prisma:L16738`
- `PromotionOption` → `schema.prisma:L16754`
- `ProviderCostStructure` → `schema.prisma:L6152`
- `ProviderEventLog` → `schema.prisma:L5899`
- `PurchaseOrder` → `schema.prisma:L2326`
- `PurchaseOrderInvoice` → `schema.prisma:L2471`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2528`
- `PurchaseOrderItem` → `schema.prisma:L2384`
- `RateCorrectionBatch` → `schema.prisma:L6377`
- `RateCorrectionEntry` → `schema.prisma:L6419`
- `RawMaterial` → `schema.prisma:L2083`
- `RawMaterialMovement` → `schema.prisma:L2654`
- `RawMaterialPresentation` → `schema.prisma:L2158`
- `Recipe` → `schema.prisma:L2178`
- `RecipeLine` → `schema.prisma:L2202`
- `Referral` → `schema.prisma:L7388`
- `ReferralProgramConfig` → `schema.prisma:L7353`
- `ReferralRewardGrant` → `schema.prisma:L7479`
- `ReferralTierReward` → `schema.prisma:L7451`
- `ReferralTierUnlock` → `schema.prisma:L7524`
- `RefreshGrant` → `schema.prisma:L17130`
- `Reservation` → `schema.prisma:L12909`
- `ReservationGoogleEventMapping` → `schema.prisma:L13679`
- `ReservationModifier` → `schema.prisma:L13089`
- `ReservationReminderSent` → `schema.prisma:L13072`
- `ReservationSettings` → `schema.prisma:L13303`
- `ReservationWaitlistEntry` → `schema.prisma:L13271`
- `Review` → `schema.prisma:L4643`
- `SalesRetention` → `schema.prisma:L16105`
- `SaleVerification` → `schema.prisma:L4402`
- `ScaleProfile` → `schema.prisma:L14990`
- `ScheduledCommand` → `schema.prisma:L9740`
- `SerializedItem` → `schema.prisma:L11390`
- `SerializedItemCustodyEvent` → `schema.prisma:L11557`
- `ServiceCharge` → `schema.prisma:L7988`
- `Session` → `schema.prisma:L17109`
- `SettlementConfiguration` → `schema.prisma:L6452`
- `SettlementConfirmation` → `schema.prisma:L6565`
- `SettlementIncident` → `schema.prisma:L6516`
- `SettlementSimulation` → `schema.prisma:L6487`
- `Shift` → `schema.prisma:L3142`
- `SimRegistrationRequest` → `schema.prisma:L11595`
- `SimRegistrationRequestItem` → `schema.prisma:L11617`
- `SlotHold` → `schema.prisma:L13172`
- `Staff` → `schema.prisma:L931`
- `StaffDocument` → `schema.prisma:L3390`
- `StaffOnboardingState` → `schema.prisma:L15320`
- `StaffOrganization` → `schema.prisma:L1263`
- `StaffPasskey` → `schema.prisma:L1290`
- `StaffSchedule` → `schema.prisma:L13112`
- `StaffScheduleException` → `schema.prisma:L13124`
- `StaffVenue` → `schema.prisma:L1187`
- `StaffWorkSchedule` → `schema.prisma:L3267`
- `StaffWorkScheduleException` → `schema.prisma:L3365`
- `StampCard` → `schema.prisma:L7236`
- `StampEvent` → `schema.prisma:L7275`
- `StampReward` → `schema.prisma:L7313`
- `StockAlertConfig` → `schema.prisma:L12248`
- `StockBatch` → `schema.prisma:L2805`
- `StockCount` → `schema.prisma:L2729`
- `StockCountItem` → `schema.prisma:L2753`
- `StripeWebhookEvent` → `schema.prisma:L6099`
- `Supplier` → `schema.prisma:L2237`
- `SupplierItemCode` → `schema.prisma:L2569`
- `SupplierPricing` → `schema.prisma:L2292`
- `Table` → `schema.prisma:L3054`
- `Terminal` → `schema.prisma:L4694`
- `TerminalHealth` → `schema.prisma:L4945`
- `TerminalLog` → `schema.prisma:L4919`
- `TerminalOrder` → `schema.prisma:L5078`
- `TerminalOrderItem` → `schema.prisma:L5153`
- `TerminalPaymentRequest` → `schema.prisma:L5016`
- `TimeEntry` → `schema.prisma:L3432`
- `TimeEntryBreak` → `schema.prisma:L3501`
- `TokenPurchase` → `schema.prisma:L9414`
- `TokenUsageRecord` → `schema.prisma:L9386`
- `TpvCommandHistory` → `schema.prisma:L9646`
- `TpvCommandQueue` → `schema.prisma:L9586`
- `TpvFeedback` → `schema.prisma:L9299`
- `TpvMessage` → `schema.prisma:L12605`
- `TpvMessageDelivery` → `schema.prisma:L12657`
- `TpvMessageResponse` → `schema.prisma:L12680`
- `TrainingModule` → `schema.prisma:L12735`
- `TrainingProgress` → `schema.prisma:L12812`
- `TrainingQuizQuestion` → `schema.prisma:L12794`
- `TrainingStep` → `schema.prisma:L12774`
- `TransactionCost` → `schema.prisma:L6315`
- `UnitConversion` → `schema.prisma:L2632`
- `UpsellAcceptance` → `schema.prisma:L7809`
- `UpsellAiRun` → `schema.prisma:L7829`
- `UpsellImpression` → `schema.prisma:L7769`
- `UpsellRule` → `schema.prisma:L7689`
- `user_sessions` → `schema.prisma:L5655`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14727`
- `VenueChatMessage` → `schema.prisma:L761`
- `VenueChatSession` → `schema.prisma:L716`
- `VenueCommission` → `schema.prisma:L14373`
- `VenueCreditAssessment` → `schema.prisma:L10128`
- `VenueCryptoConfig` → `schema.prisma:L12472`
- `VenueFeature` → `schema.prisma:L4516`
- `VenueModule` → `schema.prisma:L10288`
- `VenuePaymentConfig` → `schema.prisma:L5756`
- `VenuePaymentLinkSettings` → `schema.prisma:L13712`
- `VenuePricingStructure` → `schema.prisma:L6255`
- `VenueRoleConfig` → `schema.prisma:L1416`
- `VenueRolePermission` → `schema.prisma:L1320`
- `VenueScaleSettings` → `schema.prisma:L14978`
- `VenueSettings` → `schema.prisma:L801`
- `VenueTenderType` → `schema.prisma:L4261`
- `VenueTenderTypeRevision` → `schema.prisma:L4326`
- `VenueTransaction` → `schema.prisma:L4453`
- `VenueWhatsappActivation` → `schema.prisma:L652`
- `WalletCardDesign` → `schema.prisma:L7154`
- `WalletPass` → `schema.prisma:L7063`
- `WalletPassRegistration` → `schema.prisma:L7121`
- `WebhookEvent` → `schema.prisma:L4552`
- `WebhookSubscription` → `schema.prisma:L5872`
- `WhatsappContactWindow` → `schema.prisma:L670`
- `WhatsappInboundEvent` → `schema.prisma:L690`
- `WorkShiftAssignment` → `schema.prisma:L3307`
- `WorkShiftTemplate` → `schema.prisma:L3284`
- `Zone` → `schema.prisma:L142`
