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

- `AccountingPeriodLock` → `schema.prisma:L16251`
- `AccountMapping` → `schema.prisma:L16147`
- `ActivityLog` → `schema.prisma:L6754`
- `Aggregator` → `schema.prisma:L14544`
- `AngelPayUserAccount` → `schema.prisma:L5417`
- `AppUpdate` → `schema.prisma:L12709`
- `Area` → `schema.prisma:L3045`
- `AreaTicket` → `schema.prisma:L15042`
- `AreaTicketCheckoutSession` → `schema.prisma:L15164`
- `AreaTicketExternalIncident` → `schema.prisma:L15411`
- `AreaTicketExternalSettlement` → `schema.prisma:L15376`
- `AreaTicketFulfillment` → `schema.prisma:L15240`
- `AreaTicketInventoryReservation` → `schema.prisma:L15135`
- `AreaTicketLine` → `schema.prisma:L15103`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15196`
- `AreaTicketPrintAttempt` → `schema.prisma:L15219`
- `BankStatement` → `schema.prisma:L16021`
- `BankStatementLine` → `schema.prisma:L16042`
- `BillingTaxProfile` → `schema.prisma:L16831`
- `BirthdayAutomation` → `schema.prisma:L7075`
- `BulkCommandOperation` → `schema.prisma:L9989`
- `CalendarSyncOutbox` → `schema.prisma:L13916`
- `CampaignDelivery` → `schema.prisma:L12867`
- `CashCloseout` → `schema.prisma:L10374`
- `CashDeposit` → `schema.prisma:L12511`
- `CashDrawerEvent` → `schema.prisma:L14381`
- `CashDrawerSession` → `schema.prisma:L14342`
- `CashOutCommissionRate` → `schema.prisma:L16660`
- `CashOutScheduleDay` → `schema.prisma:L16683`
- `CashOutWithdrawal` → `schema.prisma:L16745`
- `CatalogBindingBatch` → `schema.prisma:L11405`
- `CatalogBindingLine` → `schema.prisma:L11441`
- `CatalogBrand` → `schema.prisma:L10858`
- `CatalogClientObservation` → `schema.prisma:L11171`
- `CatalogClientReadinessOverride` → `schema.prisma:L11190`
- `CatalogFamily` → `schema.prisma:L10908`
- `CatalogIdempotencyRecord` → `schema.prisma:L11304`
- `CatalogIdentifier` → `schema.prisma:L11039`
- `CatalogImportBatch` → `schema.prisma:L11347`
- `CatalogImportLine` → `schema.prisma:L11384`
- `CatalogItem` → `schema.prisma:L10941`
- `CatalogItemBusinessType` → `schema.prisma:L11001`
- `CatalogItemPrice` → `schema.prisma:L11089`
- `CatalogManufacturer` → `schema.prisma:L10882`
- `CatalogProductTypeMapping` → `schema.prisma:L11018`
- `CatalogPublicationBatch` → `schema.prisma:L11469`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11563`
- `CatalogPublicationLine` → `schema.prisma:L11510`
- `CatalogPublicationOutbox` → `schema.prisma:L11606`
- `CatalogValidationProfile` → `schema.prisma:L11060`
- `CatalogVenueBinding` → `schema.prisma:L11218`
- `CatalogVenueClientRequirement` → `schema.prisma:L11145`
- `CatalogVenueEventSequence` → `schema.prisma:L11589`
- `CatalogVenueOverride` → `schema.prisma:L11260`
- `CatalogVenueRollout` → `schema.prisma:L11120`
- `Cfdi` → `schema.prisma:L15924`
- `ChatbotTokenBudget` → `schema.prisma:L9637`
- `ChatConversation` → `schema.prisma:L9492`
- `ChatFeedback` → `schema.prisma:L9578`
- `ChatLearningEvent` → `schema.prisma:L9535`
- `ChatMessage` → `schema.prisma:L9515`
- `ChatTrainingData` → `schema.prisma:L9449`
- `CheckoutSession` → `schema.prisma:L5697`
- `ClassSession` → `schema.prisma:L13520`
- `CommissionCalculation` → `schema.prisma:L12287`
- `CommissionClawback` → `schema.prisma:L12463`
- `CommissionConfig` → `schema.prisma:L12053`
- `CommissionMilestone` → `schema.prisma:L12203`
- `CommissionOverride` → `schema.prisma:L12130`
- `CommissionPayout` → `schema.prisma:L12414`
- `CommissionSummary` → `schema.prisma:L12353`
- `CommissionTier` → `schema.prisma:L12167`
- `ConsentEvent` → `schema.prisma:L6937`
- `Consumer` → `schema.prisma:L7167`
- `ConsumerAuthAccount` → `schema.prisma:L7192`
- `CouponCode` → `schema.prisma:L8139`
- `CouponRedemption` → `schema.prisma:L8170`
- `CreditAssessmentHistory` → `schema.prisma:L10483`
- `CreditItemBalance` → `schema.prisma:L14132`
- `CreditOffer` → `schema.prisma:L10502`
- `CreditPack` → `schema.prisma:L14041`
- `CreditPackItem` → `schema.prisma:L14070`
- `CreditPackPurchase` → `schema.prisma:L14087`
- `CreditTransaction` → `schema.prisma:L14154`
- `Customer` → `schema.prisma:L6795`
- `CustomerApprovalDelivery` → `schema.prisma:L9151`
- `CustomerApprovalOutbox` → `schema.prisma:L9126`
- `CustomerCampaign` → `schema.prisma:L7025`
- `CustomerCampaignDelivery` → `schema.prisma:L7107`
- `CustomerCaptureToken` → `schema.prisma:L6973`
- `CustomerDiscount` → `schema.prisma:L8190`
- `CustomerGroup` → `schema.prisma:L7231`
- `CustomerOrderMetric` → `schema.prisma:L3815`
- `CustomerTaxProfile` → `schema.prisma:L15993`
- `DeliveryActivationRequest` → `schema.prisma:L6038`
- `DeliveryChannelLink` → `schema.prisma:L5983`
- `DeliveryOrderEvent` → `schema.prisma:L6062`
- `DeviceToken` → `schema.prisma:L8459`
- `DigitalReceipt` → `schema.prisma:L4386`
- `Discount` → `schema.prisma:L7829`
- `EcommerceMerchant` → `schema.prisma:L5509`
- `EmailQuotaLedger` → `schema.prisma:L7154`
- `EmailSuppression` → `schema.prisma:L7142`
- `EmailTemplate` → `schema.prisma:L12806`
- `Employee` → `schema.prisma:L16508`
- `Estimate` → `schema.prisma:L14451`
- `EstimateItem` → `schema.prisma:L14479`
- `Expense` → `schema.prisma:L16295`
- `ExternalBusyBlock` → `schema.prisma:L13809`
- `Feature` → `schema.prisma:L4515`
- `FeeSchedule` → `schema.prisma:L4593`
- `FeeTier` → `schema.prisma:L4604`
- `FinancialAccount` → `schema.prisma:L14641`
- `FinancialConnection` → `schema.prisma:L14610`
- `FinancialProvider` → `schema.prisma:L14596`
- `FiscalEmisor` → `schema.prisma:L15847`
- `FiscalLossCarryforward` → `schema.prisma:L16418`
- `FixedAsset` → `schema.prisma:L16436`
- `FixedAssetDepreciation` → `schema.prisma:L16465`
- `FloorElement` → `schema.prisma:L3121`
- `FulfillmentArea` → `schema.prisma:L14907`
- `GeofenceRule` → `schema.prisma:L10074`
- `GoogleCalendarChannel` → `schema.prisma:L13786`
- `GoogleCalendarConnection` → `schema.prisma:L13738`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13839`
- `GoogleOAuthSession` → `schema.prisma:L13861`
- `HolidayCalendar` → `schema.prisma:L6678`
- `IdempotencyRequest` → `schema.prisma:L11928`
- `InterVenueTransfer` → `schema.prisma:L2873`
- `InterVenueTransferAllocation` → `schema.prisma:L2956`
- `InterVenueTransferItem` → `schema.prisma:L2925`
- `InterVenueTransferReceipt` → `schema.prisma:L2983`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2999`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3027`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3011`
- `Inventory` → `schema.prisma:L1912`
- `InventoryMovement` → `schema.prisma:L1939`
- `InventoryPosting` → `schema.prisma:L2021`
- `InventoryPostingLine` → `schema.prisma:L2061`
- `InventoryTransfer` → `schema.prisma:L14423`
- `Invitation` → `schema.prisma:L1450`
- `Invoice` → `schema.prisma:L4616`
- `InvoiceItem` → `schema.prisma:L4642`
- `ItemCategory` → `schema.prisma:L11641`
- `JournalEntry` → `schema.prisma:L16205`
- `JournalLine` → `schema.prisma:L16233`
- `KdsOrder` → `schema.prisma:L14689`
- `KdsOrderItem` → `schema.prisma:L14730`
- `KioskCheckInAttempt` → `schema.prisma:L17154`
- `KioskCheckInChallenge` → `schema.prisma:L17108`
- `KioskOutreachOutbox` → `schema.prisma:L17175`
- `LearnedPatterns` → `schema.prisma:L9559`
- `LedgerAccount` → `schema.prisma:L16097`
- `LiveDemoSession` → `schema.prisma:L795`
- `LowStockAlert` → `schema.prisma:L2707`
- `LoyaltyConfig` → `schema.prisma:L7261`
- `LoyaltyTransaction` → `schema.prisma:L7304`
- `MarketingCampaign` → `schema.prisma:L12824`
- `McpAuthCode` → `schema.prisma:L15730`
- `McpOAuthClient` → `schema.prisma:L15714`
- `McpRefreshToken` → `schema.prisma:L15748`
- `McpToolCall` → `schema.prisma:L15769`
- `MeasurementUnit` → `schema.prisma:L14529`
- `Menu` → `schema.prisma:L1636`
- `MenuCategory` → `schema.prisma:L1573`
- `MenuCategoryAssignment` → `schema.prisma:L1671`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15644`
- `MerchantAccount` → `schema.prisma:L5247`
- `MerchantFiscalConfig` → `schema.prisma:L15895`
- `MerchantRevenueShare` → `schema.prisma:L6258`
- `MerchantRoutingRule` → `schema.prisma:L5369`
- `MilestoneAchievement` → `schema.prisma:L12248`
- `Modifier` → `schema.prisma:L3999`
- `ModifierGroup` → `schema.prisma:L3963`
- `Module` → `schema.prisma:L10550`
- `MoneyAnomaly` → `schema.prisma:L6161`
- `MonthlyVenueProfit` → `schema.prisma:L6704`
- `Notification` → `schema.prisma:L8361`
- `NotificationPreference` → `schema.prisma:L8408`
- `NotificationTemplate` → `schema.prisma:L8435`
- `OAuthState` → `schema.prisma:L1501`
- `OnboardingProgress` → `schema.prisma:L1519`
- `Order` → `schema.prisma:L3570`
- `OrderAction` → `schema.prisma:L4066`
- `OrderCustomer` → `schema.prisma:L3794`
- `OrderDiscount` → `schema.prisma:L8222`
- `OrderFulfillment` → `schema.prisma:L14962`
- `OrderFulfillmentLine` → `schema.prisma:L14993`
- `OrderItem` → `schema.prisma:L3830`
- `OrderItemModifier` → `schema.prisma:L4048`
- `OrderPromotion` → `schema.prisma:L17071`
- `OrderServiceCharge` → `schema.prisma:L8306`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12625`
- `OrganizationEntitlement` → `schema.prisma:L10833`
- `OrganizationGoal` → `schema.prisma:L12583`
- `OrganizationModule` → `schema.prisma:L10610`
- `OrganizationPaymentConfig` → `schema.prisma:L5821`
- `OrganizationPayoutConfig` → `schema.prisma:L12658`
- `OrganizationPricingStructure` → `schema.prisma:L5853`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12606`
- `OtpChallenge` → `schema.prisma:L7211`
- `OvertimeApproval` → `schema.prisma:L3348`
- `PartnerAPIKey` → `schema.prisma:L5651`
- `Payment` → `schema.prisma:L4099`
- `PaymentAllocation` → `schema.prisma:L4365`
- `PaymentLink` → `schema.prisma:L14200`
- `PaymentLinkAttribution` → `schema.prisma:L14308`
- `PaymentLinkItem` → `schema.prisma:L14263`
- `PaymentLinkItemModifier` → `schema.prisma:L14290`
- `PaymentProvider` → `schema.prisma:L5206`
- `PayrollLine` → `schema.prisma:L16579`
- `PayrollRun` → `schema.prisma:L16548`
- `PerformanceGoal` → `schema.prisma:L12560`
- `PermissionOverride` → `schema.prisma:L1374`
- `PermissionSet` → `schema.prisma:L1397`
- `PlatformAnnouncement` → `schema.prisma:L17235`
- `PlatformAnnouncementClick` → `schema.prisma:L17300`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17337`
- `PlatformCfdi` → `schema.prisma:L16864`
- `PlatformEmisor` → `schema.prisma:L16804`
- `PlatformSettings` → `schema.prisma:L5628`
- `PosCommand` → `schema.prisma:L8489`
- `PosConnectionStatus` → `schema.prisma:L921`
- `PosSyncIntent` → `schema.prisma:L16942`
- `PricingPolicy` → `schema.prisma:L2611`
- `Printer` → `schema.prisma:L14772`
- `PrintGateway` → `schema.prisma:L14829`
- `PrintJob` → `schema.prisma:L15543`
- `PrintStation` → `schema.prisma:L14847`
- `PrivacyNoticeVersion` → `schema.prisma:L6959`
- `ProcessedStripeEvent` → `schema.prisma:L6147`
- `ProcessorReliabilityMetric` → `schema.prisma:L6632`
- `Product` → `schema.prisma:L1689`
- `ProductModifierGroup` → `schema.prisma:L4036`
- `ProductOption` → `schema.prisma:L14506`
- `ProductOptionValue` → `schema.prisma:L14517`
- `ProductStaff` → `schema.prisma:L13435`
- `PromoterBankAccount` → `schema.prisma:L16699`
- `PromoterCommissionEntry` → `schema.prisma:L16718`
- `PromoterLocationPing` → `schema.prisma:L3536`
- `Promotion` → `schema.prisma:L16993`
- `PromotionGroup` → `schema.prisma:L17032`
- `PromotionOption` → `schema.prisma:L17048`
- `ProviderCostStructure` → `schema.prisma:L6183`
- `ProviderEventLog` → `schema.prisma:L5930`
- `PurchaseOrder` → `schema.prisma:L2336`
- `PurchaseOrderInvoice` → `schema.prisma:L2481`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2538`
- `PurchaseOrderItem` → `schema.prisma:L2394`
- `RateCorrectionBatch` → `schema.prisma:L6408`
- `RateCorrectionEntry` → `schema.prisma:L6450`
- `RawMaterial` → `schema.prisma:L2093`
- `RawMaterialMovement` → `schema.prisma:L2664`
- `RawMaterialPresentation` → `schema.prisma:L2168`
- `Recipe` → `schema.prisma:L2188`
- `RecipeLine` → `schema.prisma:L2212`
- `Referral` → `schema.prisma:L7677`
- `ReferralProgramConfig` → `schema.prisma:L7642`
- `ReferralRewardGrant` → `schema.prisma:L7768`
- `ReferralTierReward` → `schema.prisma:L7740`
- `ReferralTierUnlock` → `schema.prisma:L7813`
- `RefreshGrant` → `schema.prisma:L17424`
- `Reservation` → `schema.prisma:L13203`
- `ReservationGoogleEventMapping` → `schema.prisma:L13973`
- `ReservationModifier` → `schema.prisma:L13383`
- `ReservationReminderSent` → `schema.prisma:L13366`
- `ReservationSettings` → `schema.prisma:L13597`
- `ReservationWaitlistEntry` → `schema.prisma:L13565`
- `Review` → `schema.prisma:L4660`
- `SalesRetention` → `schema.prisma:L16399`
- `SaleVerification` → `schema.prisma:L4419`
- `ScaleProfile` → `schema.prisma:L15284`
- `ScheduledCommand` → `schema.prisma:L10034`
- `SerializedItem` → `schema.prisma:L11684`
- `SerializedItemCustodyEvent` → `schema.prisma:L11851`
- `ServiceCharge` → `schema.prisma:L8277`
- `Session` → `schema.prisma:L17403`
- `SettlementConfiguration` → `schema.prisma:L6483`
- `SettlementConfirmation` → `schema.prisma:L6596`
- `SettlementIncident` → `schema.prisma:L6547`
- `SettlementSimulation` → `schema.prisma:L6518`
- `Shift` → `schema.prisma:L3159`
- `SimRegistrationRequest` → `schema.prisma:L11889`
- `SimRegistrationRequestItem` → `schema.prisma:L11911`
- `SlotHold` → `schema.prisma:L13466`
- `Staff` → `schema.prisma:L941`
- `StaffDocument` → `schema.prisma:L3407`
- `StaffOnboardingState` → `schema.prisma:L15614`
- `StaffOrganization` → `schema.prisma:L1273`
- `StaffPasskey` → `schema.prisma:L1300`
- `StaffSchedule` → `schema.prisma:L13406`
- `StaffScheduleException` → `schema.prisma:L13418`
- `StaffVenue` → `schema.prisma:L1197`
- `StaffWorkSchedule` → `schema.prisma:L3284`
- `StaffWorkScheduleException` → `schema.prisma:L3382`
- `StampCard` → `schema.prisma:L7525`
- `StampEvent` → `schema.prisma:L7564`
- `StampReward` → `schema.prisma:L7602`
- `StockAlertConfig` → `schema.prisma:L12542`
- `StockBatch` → `schema.prisma:L2822`
- `StockCount` → `schema.prisma:L2739`
- `StockCountItem` → `schema.prisma:L2767`
- `StripeWebhookEvent` → `schema.prisma:L6130`
- `Supplier` → `schema.prisma:L2247`
- `SupplierItemCode` → `schema.prisma:L2579`
- `SupplierPricing` → `schema.prisma:L2302`
- `Table` → `schema.prisma:L3071`
- `Terminal` → `schema.prisma:L4711`
- `TerminalHealth` → `schema.prisma:L4962`
- `TerminalLog` → `schema.prisma:L4936`
- `TerminalOrder` → `schema.prisma:L5109`
- `TerminalOrderItem` → `schema.prisma:L5184`
- `TerminalPaymentRequest` → `schema.prisma:L5033`
- `TimeEntry` → `schema.prisma:L3449`
- `TimeEntryBreak` → `schema.prisma:L3518`
- `TokenPurchase` → `schema.prisma:L9708`
- `TokenUsageRecord` → `schema.prisma:L9680`
- `TpvCommandHistory` → `schema.prisma:L9940`
- `TpvCommandQueue` → `schema.prisma:L9880`
- `TpvFeedback` → `schema.prisma:L9593`
- `TpvMessage` → `schema.prisma:L12899`
- `TpvMessageDelivery` → `schema.prisma:L12951`
- `TpvMessageResponse` → `schema.prisma:L12974`
- `TrainingModule` → `schema.prisma:L13029`
- `TrainingProgress` → `schema.prisma:L13106`
- `TrainingQuizQuestion` → `schema.prisma:L13088`
- `TrainingStep` → `schema.prisma:L13068`
- `TransactionCost` → `schema.prisma:L6346`
- `UnitConversion` → `schema.prisma:L2642`
- `UpsellAcceptance` → `schema.prisma:L8098`
- `UpsellAiRun` → `schema.prisma:L8118`
- `UpsellImpression` → `schema.prisma:L8058`
- `UpsellRule` → `schema.prisma:L7978`
- `user_sessions` → `schema.prisma:L5686`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L15021`
- `VenueChatMessage` → `schema.prisma:L771`
- `VenueChatSession` → `schema.prisma:L726`
- `VenueCommission` → `schema.prisma:L14667`
- `VenueCreditAssessment` → `schema.prisma:L10422`
- `VenueCryptoConfig` → `schema.prisma:L12766`
- `VenueFeature` → `schema.prisma:L4533`
- `VenueModule` → `schema.prisma:L10582`
- `VenuePaymentConfig` → `schema.prisma:L5787`
- `VenuePaymentLinkSettings` → `schema.prisma:L14006`
- `VenuePricingStructure` → `schema.prisma:L6286`
- `VenueRoleConfig` → `schema.prisma:L1426`
- `VenueRolePermission` → `schema.prisma:L1330`
- `VenueScaleSettings` → `schema.prisma:L15272`
- `VenueSettings` → `schema.prisma:L811`
- `VenueTenderType` → `schema.prisma:L4278`
- `VenueTenderTypeRevision` → `schema.prisma:L4343`
- `VenueTransaction` → `schema.prisma:L4470`
- `VenueWhatsappActivation` → `schema.prisma:L662`
- `WalletCardDesign` → `schema.prisma:L7443`
- `WalletPass` → `schema.prisma:L7344`
- `WalletPassRegistration` → `schema.prisma:L7410`
- `WebhookEvent` → `schema.prisma:L4569`
- `WebhookSubscription` → `schema.prisma:L5903`
- `WhatsappContactWindow` → `schema.prisma:L680`
- `WhatsappInboundEvent` → `schema.prisma:L700`
- `WorkShiftAssignment` → `schema.prisma:L3324`
- `WorkShiftTemplate` → `schema.prisma:L3301`
- `Zone` → `schema.prisma:L142`
