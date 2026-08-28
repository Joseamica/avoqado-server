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

- `AccountingPeriodLock` → `schema.prisma:L15816`
- `AccountMapping` → `schema.prisma:L15712`
- `ActivityLog` → `schema.prisma:L6609`
- `Aggregator` → `schema.prisma:L14113`
- `AngelPayUserAccount` → `schema.prisma:L5272`
- `AppUpdate` → `schema.prisma:L12293`
- `Area` → `schema.prisma:L3013`
- `AreaTicket` → `schema.prisma:L14607`
- `AreaTicketCheckoutSession` → `schema.prisma:L14729`
- `AreaTicketExternalIncident` → `schema.prisma:L14976`
- `AreaTicketExternalSettlement` → `schema.prisma:L14941`
- `AreaTicketFulfillment` → `schema.prisma:L14805`
- `AreaTicketInventoryReservation` → `schema.prisma:L14700`
- `AreaTicketLine` → `schema.prisma:L14668`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14761`
- `AreaTicketPrintAttempt` → `schema.prisma:L14784`
- `BankStatement` → `schema.prisma:L15586`
- `BankStatementLine` → `schema.prisma:L15607`
- `BillingTaxProfile` → `schema.prisma:L16396`
- `BulkCommandOperation` → `schema.prisma:L9576`
- `CalendarSyncOutbox` → `schema.prisma:L13500`
- `CampaignDelivery` → `schema.prisma:L12451`
- `CashCloseout` → `schema.prisma:L9961`
- `CashDeposit` → `schema.prisma:L12095`
- `CashDrawerEvent` → `schema.prisma:L13950`
- `CashDrawerSession` → `schema.prisma:L13926`
- `CashOutCommissionRate` → `schema.prisma:L16225`
- `CashOutScheduleDay` → `schema.prisma:L16248`
- `CashOutWithdrawal` → `schema.prisma:L16310`
- `CatalogBindingBatch` → `schema.prisma:L10992`
- `CatalogBindingLine` → `schema.prisma:L11028`
- `CatalogBrand` → `schema.prisma:L10445`
- `CatalogClientObservation` → `schema.prisma:L10758`
- `CatalogClientReadinessOverride` → `schema.prisma:L10777`
- `CatalogFamily` → `schema.prisma:L10495`
- `CatalogIdempotencyRecord` → `schema.prisma:L10891`
- `CatalogIdentifier` → `schema.prisma:L10626`
- `CatalogImportBatch` → `schema.prisma:L10934`
- `CatalogImportLine` → `schema.prisma:L10971`
- `CatalogItem` → `schema.prisma:L10528`
- `CatalogItemBusinessType` → `schema.prisma:L10588`
- `CatalogItemPrice` → `schema.prisma:L10676`
- `CatalogManufacturer` → `schema.prisma:L10469`
- `CatalogProductTypeMapping` → `schema.prisma:L10605`
- `CatalogPublicationBatch` → `schema.prisma:L11056`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11150`
- `CatalogPublicationLine` → `schema.prisma:L11097`
- `CatalogPublicationOutbox` → `schema.prisma:L11193`
- `CatalogValidationProfile` → `schema.prisma:L10647`
- `CatalogVenueBinding` → `schema.prisma:L10805`
- `CatalogVenueClientRequirement` → `schema.prisma:L10732`
- `CatalogVenueEventSequence` → `schema.prisma:L11176`
- `CatalogVenueOverride` → `schema.prisma:L10847`
- `CatalogVenueRollout` → `schema.prisma:L10707`
- `Cfdi` → `schema.prisma:L15489`
- `ChatbotTokenBudget` → `schema.prisma:L9224`
- `ChatConversation` → `schema.prisma:L9079`
- `ChatFeedback` → `schema.prisma:L9165`
- `ChatLearningEvent` → `schema.prisma:L9122`
- `ChatMessage` → `schema.prisma:L9102`
- `ChatTrainingData` → `schema.prisma:L9036`
- `CheckoutSession` → `schema.prisma:L5552`
- `ClassSession` → `schema.prisma:L13104`
- `CommissionCalculation` → `schema.prisma:L11871`
- `CommissionClawback` → `schema.prisma:L12047`
- `CommissionConfig` → `schema.prisma:L11637`
- `CommissionMilestone` → `schema.prisma:L11787`
- `CommissionOverride` → `schema.prisma:L11714`
- `CommissionPayout` → `schema.prisma:L11998`
- `CommissionSummary` → `schema.prisma:L11937`
- `CommissionTier` → `schema.prisma:L11751`
- `Consumer` → `schema.prisma:L6771`
- `ConsumerAuthAccount` → `schema.prisma:L6796`
- `CouponCode` → `schema.prisma:L7734`
- `CouponRedemption` → `schema.prisma:L7765`
- `CreditAssessmentHistory` → `schema.prisma:L10070`
- `CreditItemBalance` → `schema.prisma:L13716`
- `CreditOffer` → `schema.prisma:L10089`
- `CreditPack` → `schema.prisma:L13625`
- `CreditPackItem` → `schema.prisma:L13654`
- `CreditPackPurchase` → `schema.prisma:L13671`
- `CreditTransaction` → `schema.prisma:L13738`
- `Customer` → `schema.prisma:L6650`
- `CustomerApprovalDelivery` → `schema.prisma:L8741`
- `CustomerApprovalOutbox` → `schema.prisma:L8716`
- `CustomerDiscount` → `schema.prisma:L7785`
- `CustomerGroup` → `schema.prisma:L6835`
- `CustomerTaxProfile` → `schema.prisma:L15558`
- `DeliveryActivationRequest` → `schema.prisma:L5893`
- `DeliveryChannelLink` → `schema.prisma:L5838`
- `DeliveryOrderEvent` → `schema.prisma:L5917`
- `DeviceToken` → `schema.prisma:L8054`
- `DigitalReceipt` → `schema.prisma:L4267`
- `Discount` → `schema.prisma:L7424`
- `EcommerceMerchant` → `schema.prisma:L5364`
- `EmailTemplate` → `schema.prisma:L12390`
- `Employee` → `schema.prisma:L16073`
- `Estimate` → `schema.prisma:L14020`
- `EstimateItem` → `schema.prisma:L14048`
- `Expense` → `schema.prisma:L15860`
- `ExternalBusyBlock` → `schema.prisma:L13393`
- `Feature` → `schema.prisma:L4396`
- `FeeSchedule` → `schema.prisma:L4474`
- `FeeTier` → `schema.prisma:L4485`
- `FinancialAccount` → `schema.prisma:L14210`
- `FinancialConnection` → `schema.prisma:L14179`
- `FinancialProvider` → `schema.prisma:L14165`
- `FiscalEmisor` → `schema.prisma:L15412`
- `FiscalLossCarryforward` → `schema.prisma:L15983`
- `FixedAsset` → `schema.prisma:L16001`
- `FixedAssetDepreciation` → `schema.prisma:L16030`
- `FloorElement` → `schema.prisma:L3089`
- `FulfillmentArea` → `schema.prisma:L14472`
- `GeofenceRule` → `schema.prisma:L9661`
- `GoogleCalendarChannel` → `schema.prisma:L13370`
- `GoogleCalendarConnection` → `schema.prisma:L13322`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13423`
- `GoogleOAuthSession` → `schema.prisma:L13445`
- `HolidayCalendar` → `schema.prisma:L6533`
- `IdempotencyRequest` → `schema.prisma:L11512`
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
- `InventoryTransfer` → `schema.prisma:L13992`
- `Invitation` → `schema.prisma:L1425`
- `Invoice` → `schema.prisma:L4497`
- `InvoiceItem` → `schema.prisma:L4523`
- `ItemCategory` → `schema.prisma:L11228`
- `JournalEntry` → `schema.prisma:L15770`
- `JournalLine` → `schema.prisma:L15798`
- `KdsOrder` → `schema.prisma:L14258`
- `KdsOrderItem` → `schema.prisma:L14299`
- `KioskCheckInAttempt` → `schema.prisma:L16719`
- `KioskCheckInChallenge` → `schema.prisma:L16673`
- `KioskOutreachOutbox` → `schema.prisma:L16740`
- `LearnedPatterns` → `schema.prisma:L9146`
- `LedgerAccount` → `schema.prisma:L15662`
- `LiveDemoSession` → `schema.prisma:L784`
- `LowStockAlert` → `schema.prisma:L2682`
- `LoyaltyConfig` → `schema.prisma:L6865`
- `LoyaltyTransaction` → `schema.prisma:L6908`
- `MarketingCampaign` → `schema.prisma:L12408`
- `McpAuthCode` → `schema.prisma:L15295`
- `McpOAuthClient` → `schema.prisma:L15279`
- `McpRefreshToken` → `schema.prisma:L15313`
- `McpToolCall` → `schema.prisma:L15334`
- `MeasurementUnit` → `schema.prisma:L14098`
- `Menu` → `schema.prisma:L1611`
- `MenuCategory` → `schema.prisma:L1548`
- `MenuCategoryAssignment` → `schema.prisma:L1646`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15209`
- `MerchantAccount` → `schema.prisma:L5102`
- `MerchantFiscalConfig` → `schema.prisma:L15460`
- `MerchantRevenueShare` → `schema.prisma:L6113`
- `MerchantRoutingRule` → `schema.prisma:L5224`
- `MilestoneAchievement` → `schema.prisma:L11832`
- `Modifier` → `schema.prisma:L3882`
- `ModifierGroup` → `schema.prisma:L3846`
- `Module` → `schema.prisma:L10137`
- `MoneyAnomaly` → `schema.prisma:L6016`
- `MonthlyVenueProfit` → `schema.prisma:L6559`
- `Notification` → `schema.prisma:L7956`
- `NotificationPreference` → `schema.prisma:L8003`
- `NotificationTemplate` → `schema.prisma:L8030`
- `OAuthState` → `schema.prisma:L1476`
- `OnboardingProgress` → `schema.prisma:L1494`
- `Order` → `schema.prisma:L3484`
- `OrderAction` → `schema.prisma:L3947`
- `OrderCustomer` → `schema.prisma:L3697`
- `OrderDiscount` → `schema.prisma:L7817`
- `OrderFulfillment` → `schema.prisma:L14527`
- `OrderFulfillmentLine` → `schema.prisma:L14558`
- `OrderItem` → `schema.prisma:L3713`
- `OrderItemModifier` → `schema.prisma:L3931`
- `OrderPromotion` → `schema.prisma:L16636`
- `OrderServiceCharge` → `schema.prisma:L7901`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12209`
- `OrganizationEntitlement` → `schema.prisma:L10420`
- `OrganizationGoal` → `schema.prisma:L12167`
- `OrganizationModule` → `schema.prisma:L10197`
- `OrganizationPaymentConfig` → `schema.prisma:L5676`
- `OrganizationPayoutConfig` → `schema.prisma:L12242`
- `OrganizationPricingStructure` → `schema.prisma:L5708`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12190`
- `OtpChallenge` → `schema.prisma:L6815`
- `PartnerAPIKey` → `schema.prisma:L5506`
- `Payment` → `schema.prisma:L3980`
- `PaymentAllocation` → `schema.prisma:L4246`
- `PaymentLink` → `schema.prisma:L13784`
- `PaymentLinkAttribution` → `schema.prisma:L13892`
- `PaymentLinkItem` → `schema.prisma:L13847`
- `PaymentLinkItemModifier` → `schema.prisma:L13874`
- `PaymentProvider` → `schema.prisma:L5061`
- `PayrollLine` → `schema.prisma:L16144`
- `PayrollRun` → `schema.prisma:L16113`
- `PerformanceGoal` → `schema.prisma:L12144`
- `PermissionOverride` → `schema.prisma:L1353`
- `PermissionSet` → `schema.prisma:L1376`
- `PlatformAnnouncement` → `schema.prisma:L16800`
- `PlatformAnnouncementClick` → `schema.prisma:L16865`
- `PlatformAnnouncementDelivery` → `schema.prisma:L16902`
- `PlatformCfdi` → `schema.prisma:L16429`
- `PlatformEmisor` → `schema.prisma:L16369`
- `PlatformSettings` → `schema.prisma:L5483`
- `PosCommand` → `schema.prisma:L8084`
- `PosConnectionStatus` → `schema.prisma:L904`
- `PosSyncIntent` → `schema.prisma:L16507`
- `PricingPolicy` → `schema.prisma:L2586`
- `Printer` → `schema.prisma:L14341`
- `PrintGateway` → `schema.prisma:L14394`
- `PrintJob` → `schema.prisma:L15108`
- `PrintStation` → `schema.prisma:L14412`
- `ProcessedStripeEvent` → `schema.prisma:L6002`
- `ProcessorReliabilityMetric` → `schema.prisma:L6487`
- `Product` → `schema.prisma:L1664`
- `ProductModifierGroup` → `schema.prisma:L3919`
- `ProductOption` → `schema.prisma:L14075`
- `ProductOptionValue` → `schema.prisma:L14086`
- `ProductStaff` → `schema.prisma:L13019`
- `PromoterBankAccount` → `schema.prisma:L16264`
- `PromoterCommissionEntry` → `schema.prisma:L16283`
- `PromoterLocationPing` → `schema.prisma:L3450`
- `Promotion` → `schema.prisma:L16558`
- `PromotionGroup` → `schema.prisma:L16597`
- `PromotionOption` → `schema.prisma:L16613`
- `ProviderCostStructure` → `schema.prisma:L6038`
- `ProviderEventLog` → `schema.prisma:L5785`
- `PurchaseOrder` → `schema.prisma:L2311`
- `PurchaseOrderInvoice` → `schema.prisma:L2456`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2513`
- `PurchaseOrderItem` → `schema.prisma:L2369`
- `RateCorrectionBatch` → `schema.prisma:L6263`
- `RateCorrectionEntry` → `schema.prisma:L6305`
- `RawMaterial` → `schema.prisma:L2068`
- `RawMaterialMovement` → `schema.prisma:L2639`
- `RawMaterialPresentation` → `schema.prisma:L2143`
- `Recipe` → `schema.prisma:L2163`
- `RecipeLine` → `schema.prisma:L2187`
- `Referral` → `schema.prisma:L7272`
- `ReferralProgramConfig` → `schema.prisma:L7237`
- `ReferralRewardGrant` → `schema.prisma:L7363`
- `ReferralTierReward` → `schema.prisma:L7335`
- `ReferralTierUnlock` → `schema.prisma:L7408`
- `RefreshGrant` → `schema.prisma:L16985`
- `Reservation` → `schema.prisma:L12787`
- `ReservationGoogleEventMapping` → `schema.prisma:L13557`
- `ReservationModifier` → `schema.prisma:L12967`
- `ReservationReminderSent` → `schema.prisma:L12950`
- `ReservationSettings` → `schema.prisma:L13181`
- `ReservationWaitlistEntry` → `schema.prisma:L13149`
- `Review` → `schema.prisma:L4541`
- `SalesRetention` → `schema.prisma:L15964`
- `SaleVerification` → `schema.prisma:L4300`
- `ScaleProfile` → `schema.prisma:L14849`
- `ScheduledCommand` → `schema.prisma:L9621`
- `SerializedItem` → `schema.prisma:L11271`
- `SerializedItemCustodyEvent` → `schema.prisma:L11435`
- `ServiceCharge` → `schema.prisma:L7872`
- `Session` → `schema.prisma:L16964`
- `SettlementConfiguration` → `schema.prisma:L6338`
- `SettlementConfirmation` → `schema.prisma:L6451`
- `SettlementIncident` → `schema.prisma:L6402`
- `SettlementSimulation` → `schema.prisma:L6373`
- `Shift` → `schema.prisma:L3127`
- `SimRegistrationRequest` → `schema.prisma:L11473`
- `SimRegistrationRequestItem` → `schema.prisma:L11495`
- `SlotHold` → `schema.prisma:L13050`
- `Staff` → `schema.prisma:L924`
- `StaffDocument` → `schema.prisma:L3321`
- `StaffOnboardingState` → `schema.prisma:L15179`
- `StaffOrganization` → `schema.prisma:L1252`
- `StaffPasskey` → `schema.prisma:L1279`
- `StaffSchedule` → `schema.prisma:L12990`
- `StaffScheduleException` → `schema.prisma:L13002`
- `StaffVenue` → `schema.prisma:L1177`
- `StaffWorkSchedule` → `schema.prisma:L3234`
- `StaffWorkScheduleException` → `schema.prisma:L3296`
- `StampCard` → `schema.prisma:L7120`
- `StampEvent` → `schema.prisma:L7159`
- `StampReward` → `schema.prisma:L7197`
- `StockAlertConfig` → `schema.prisma:L12126`
- `StockBatch` → `schema.prisma:L2790`
- `StockCount` → `schema.prisma:L2714`
- `StockCountItem` → `schema.prisma:L2738`
- `StripeWebhookEvent` → `schema.prisma:L5985`
- `Supplier` → `schema.prisma:L2222`
- `SupplierItemCode` → `schema.prisma:L2554`
- `SupplierPricing` → `schema.prisma:L2277`
- `Table` → `schema.prisma:L3039`
- `Terminal` → `schema.prisma:L4592`
- `TerminalHealth` → `schema.prisma:L4831`
- `TerminalLog` → `schema.prisma:L4805`
- `TerminalOrder` → `schema.prisma:L4964`
- `TerminalOrderItem` → `schema.prisma:L5039`
- `TerminalPaymentRequest` → `schema.prisma:L4902`
- `TimeEntry` → `schema.prisma:L3363`
- `TimeEntryBreak` → `schema.prisma:L3432`
- `TokenPurchase` → `schema.prisma:L9295`
- `TokenUsageRecord` → `schema.prisma:L9267`
- `TpvCommandHistory` → `schema.prisma:L9527`
- `TpvCommandQueue` → `schema.prisma:L9467`
- `TpvFeedback` → `schema.prisma:L9180`
- `TpvMessage` → `schema.prisma:L12483`
- `TpvMessageDelivery` → `schema.prisma:L12535`
- `TpvMessageResponse` → `schema.prisma:L12558`
- `TrainingModule` → `schema.prisma:L12613`
- `TrainingProgress` → `schema.prisma:L12690`
- `TrainingQuizQuestion` → `schema.prisma:L12672`
- `TrainingStep` → `schema.prisma:L12652`
- `TransactionCost` → `schema.prisma:L6201`
- `UnitConversion` → `schema.prisma:L2617`
- `UpsellAcceptance` → `schema.prisma:L7693`
- `UpsellAiRun` → `schema.prisma:L7713`
- `UpsellImpression` → `schema.prisma:L7653`
- `UpsellRule` → `schema.prisma:L7573`
- `user_sessions` → `schema.prisma:L5541`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14586`
- `VenueChatMessage` → `schema.prisma:L760`
- `VenueChatSession` → `schema.prisma:L715`
- `VenueCommission` → `schema.prisma:L14236`
- `VenueCreditAssessment` → `schema.prisma:L10009`
- `VenueCryptoConfig` → `schema.prisma:L12350`
- `VenueFeature` → `schema.prisma:L4414`
- `VenueModule` → `schema.prisma:L10169`
- `VenuePaymentConfig` → `schema.prisma:L5642`
- `VenuePaymentLinkSettings` → `schema.prisma:L13590`
- `VenuePricingStructure` → `schema.prisma:L6141`
- `VenueRoleConfig` → `schema.prisma:L1405`
- `VenueRolePermission` → `schema.prisma:L1309`
- `VenueScaleSettings` → `schema.prisma:L14837`
- `VenueSettings` → `schema.prisma:L800`
- `VenueTenderType` → `schema.prisma:L4159`
- `VenueTenderTypeRevision` → `schema.prisma:L4224`
- `VenueTransaction` → `schema.prisma:L4351`
- `VenueWhatsappActivation` → `schema.prisma:L651`
- `WalletCardDesign` → `schema.prisma:L7039`
- `WalletPass` → `schema.prisma:L6948`
- `WalletPassRegistration` → `schema.prisma:L7006`
- `WebhookEvent` → `schema.prisma:L4450`
- `WebhookSubscription` → `schema.prisma:L5758`
- `WhatsappContactWindow` → `schema.prisma:L669`
- `WhatsappInboundEvent` → `schema.prisma:L689`
- `WorkShiftAssignment` → `schema.prisma:L3274`
- `WorkShiftTemplate` → `schema.prisma:L3251`
- `Zone` → `schema.prisma:L142`
