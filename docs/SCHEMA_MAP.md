# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **363 models / 345 enums / ~17,200 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                            |
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

- `AccountingPeriodLock` → `schema.prisma:L16085`
- `AccountMapping` → `schema.prisma:L15981`
- `ActivityLog` → `schema.prisma:L6673`
- `Aggregator` → `schema.prisma:L14382`
- `AngelPayUserAccount` → `schema.prisma:L5336`
- `AppUpdate` → `schema.prisma:L12562`
- `Area` → `schema.prisma:L3029`
- `AreaTicket` → `schema.prisma:L14876`
- `AreaTicketCheckoutSession` → `schema.prisma:L14998`
- `AreaTicketExternalIncident` → `schema.prisma:L15245`
- `AreaTicketExternalSettlement` → `schema.prisma:L15210`
- `AreaTicketFulfillment` → `schema.prisma:L15074`
- `AreaTicketInventoryReservation` → `schema.prisma:L14969`
- `AreaTicketLine` → `schema.prisma:L14937`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15030`
- `AreaTicketPrintAttempt` → `schema.prisma:L15053`
- `BankStatement` → `schema.prisma:L15855`
- `BankStatementLine` → `schema.prisma:L15876`
- `BillingTaxProfile` → `schema.prisma:L16665`
- `BulkCommandOperation` → `schema.prisma:L9845`
- `CalendarSyncOutbox` → `schema.prisma:L13769`
- `CampaignDelivery` → `schema.prisma:L12720`
- `CashCloseout` → `schema.prisma:L10230`
- `CashDeposit` → `schema.prisma:L12364`
- `CashDrawerEvent` → `schema.prisma:L14219`
- `CashDrawerSession` → `schema.prisma:L14195`
- `CashOutCommissionRate` → `schema.prisma:L16494`
- `CashOutScheduleDay` → `schema.prisma:L16517`
- `CashOutWithdrawal` → `schema.prisma:L16579`
- `CatalogBindingBatch` → `schema.prisma:L11261`
- `CatalogBindingLine` → `schema.prisma:L11297`
- `CatalogBrand` → `schema.prisma:L10714`
- `CatalogClientObservation` → `schema.prisma:L11027`
- `CatalogClientReadinessOverride` → `schema.prisma:L11046`
- `CatalogFamily` → `schema.prisma:L10764`
- `CatalogIdempotencyRecord` → `schema.prisma:L11160`
- `CatalogIdentifier` → `schema.prisma:L10895`
- `CatalogImportBatch` → `schema.prisma:L11203`
- `CatalogImportLine` → `schema.prisma:L11240`
- `CatalogItem` → `schema.prisma:L10797`
- `CatalogItemBusinessType` → `schema.prisma:L10857`
- `CatalogItemPrice` → `schema.prisma:L10945`
- `CatalogManufacturer` → `schema.prisma:L10738`
- `CatalogProductTypeMapping` → `schema.prisma:L10874`
- `CatalogPublicationBatch` → `schema.prisma:L11325`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11419`
- `CatalogPublicationLine` → `schema.prisma:L11366`
- `CatalogPublicationOutbox` → `schema.prisma:L11462`
- `CatalogValidationProfile` → `schema.prisma:L10916`
- `CatalogVenueBinding` → `schema.prisma:L11074`
- `CatalogVenueClientRequirement` → `schema.prisma:L11001`
- `CatalogVenueEventSequence` → `schema.prisma:L11445`
- `CatalogVenueOverride` → `schema.prisma:L11116`
- `CatalogVenueRollout` → `schema.prisma:L10976`
- `Cfdi` → `schema.prisma:L15758`
- `ChatbotTokenBudget` → `schema.prisma:L9493`
- `ChatConversation` → `schema.prisma:L9348`
- `ChatFeedback` → `schema.prisma:L9434`
- `ChatLearningEvent` → `schema.prisma:L9391`
- `ChatMessage` → `schema.prisma:L9371`
- `ChatTrainingData` → `schema.prisma:L9305`
- `CheckoutSession` → `schema.prisma:L5616`
- `ClassSession` → `schema.prisma:L13373`
- `CommissionCalculation` → `schema.prisma:L12140`
- `CommissionClawback` → `schema.prisma:L12316`
- `CommissionConfig` → `schema.prisma:L11906`
- `CommissionMilestone` → `schema.prisma:L12056`
- `CommissionOverride` → `schema.prisma:L11983`
- `CommissionPayout` → `schema.prisma:L12267`
- `CommissionSummary` → `schema.prisma:L12206`
- `CommissionTier` → `schema.prisma:L12020`
- `ConsentEvent` → `schema.prisma:L6855`
- `Consumer` → `schema.prisma:L7036`
- `ConsumerAuthAccount` → `schema.prisma:L7061`
- `CouponCode` → `schema.prisma:L8000`
- `CouponRedemption` → `schema.prisma:L8031`
- `CreditAssessmentHistory` → `schema.prisma:L10339`
- `CreditItemBalance` → `schema.prisma:L13985`
- `CreditOffer` → `schema.prisma:L10358`
- `CreditPack` → `schema.prisma:L13894`
- `CreditPackItem` → `schema.prisma:L13923`
- `CreditPackPurchase` → `schema.prisma:L13940`
- `CreditTransaction` → `schema.prisma:L14007`
- `Customer` → `schema.prisma:L6714`
- `CustomerApprovalDelivery` → `schema.prisma:L9007`
- `CustomerApprovalOutbox` → `schema.prisma:L8982`
- `CustomerCampaign` → `schema.prisma:L6939`
- `CustomerCampaignDelivery` → `schema.prisma:L6977`
- `CustomerCaptureToken` → `schema.prisma:L6891`
- `CustomerDiscount` → `schema.prisma:L8051`
- `CustomerGroup` → `schema.prisma:L7100`
- `CustomerTaxProfile` → `schema.prisma:L15827`
- `DeliveryActivationRequest` → `schema.prisma:L5957`
- `DeliveryChannelLink` → `schema.prisma:L5902`
- `DeliveryOrderEvent` → `schema.prisma:L5981`
- `DeviceToken` → `schema.prisma:L8320`
- `DigitalReceipt` → `schema.prisma:L4319`
- `Discount` → `schema.prisma:L7690`
- `EcommerceMerchant` → `schema.prisma:L5428`
- `EmailQuotaLedger` → `schema.prisma:L7023`
- `EmailSuppression` → `schema.prisma:L7011`
- `EmailTemplate` → `schema.prisma:L12659`
- `Employee` → `schema.prisma:L16342`
- `Estimate` → `schema.prisma:L14289`
- `EstimateItem` → `schema.prisma:L14317`
- `Expense` → `schema.prisma:L16129`
- `ExternalBusyBlock` → `schema.prisma:L13662`
- `Feature` → `schema.prisma:L4448`
- `FeeSchedule` → `schema.prisma:L4526`
- `FeeTier` → `schema.prisma:L4537`
- `FinancialAccount` → `schema.prisma:L14479`
- `FinancialConnection` → `schema.prisma:L14448`
- `FinancialProvider` → `schema.prisma:L14434`
- `FiscalEmisor` → `schema.prisma:L15681`
- `FiscalLossCarryforward` → `schema.prisma:L16252`
- `FixedAsset` → `schema.prisma:L16270`
- `FixedAssetDepreciation` → `schema.prisma:L16299`
- `FloorElement` → `schema.prisma:L3105`
- `FulfillmentArea` → `schema.prisma:L14741`
- `GeofenceRule` → `schema.prisma:L9930`
- `GoogleCalendarChannel` → `schema.prisma:L13639`
- `GoogleCalendarConnection` → `schema.prisma:L13591`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13692`
- `GoogleOAuthSession` → `schema.prisma:L13714`
- `HolidayCalendar` → `schema.prisma:L6597`
- `IdempotencyRequest` → `schema.prisma:L11781`
- `InterVenueTransfer` → `schema.prisma:L2857`
- `InterVenueTransferAllocation` → `schema.prisma:L2940`
- `InterVenueTransferItem` → `schema.prisma:L2909`
- `InterVenueTransferReceipt` → `schema.prisma:L2967`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2983`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3011`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2995`
- `Inventory` → `schema.prisma:L1903`
- `InventoryMovement` → `schema.prisma:L1930`
- `InventoryPosting` → `schema.prisma:L2012`
- `InventoryPostingLine` → `schema.prisma:L2052`
- `InventoryTransfer` → `schema.prisma:L14261`
- `Invitation` → `schema.prisma:L1441`
- `Invoice` → `schema.prisma:L4549`
- `InvoiceItem` → `schema.prisma:L4575`
- `ItemCategory` → `schema.prisma:L11497`
- `JournalEntry` → `schema.prisma:L16039`
- `JournalLine` → `schema.prisma:L16067`
- `KdsOrder` → `schema.prisma:L14527`
- `KdsOrderItem` → `schema.prisma:L14568`
- `KioskCheckInAttempt` → `schema.prisma:L16988`
- `KioskCheckInChallenge` → `schema.prisma:L16942`
- `KioskOutreachOutbox` → `schema.prisma:L17009`
- `LearnedPatterns` → `schema.prisma:L9415`
- `LedgerAccount` → `schema.prisma:L15931`
- `LiveDemoSession` → `schema.prisma:L792`
- `LowStockAlert` → `schema.prisma:L2698`
- `LoyaltyConfig` → `schema.prisma:L7130`
- `LoyaltyTransaction` → `schema.prisma:L7173`
- `MarketingCampaign` → `schema.prisma:L12677`
- `McpAuthCode` → `schema.prisma:L15564`
- `McpOAuthClient` → `schema.prisma:L15548`
- `McpRefreshToken` → `schema.prisma:L15582`
- `McpToolCall` → `schema.prisma:L15603`
- `MeasurementUnit` → `schema.prisma:L14367`
- `Menu` → `schema.prisma:L1627`
- `MenuCategory` → `schema.prisma:L1564`
- `MenuCategoryAssignment` → `schema.prisma:L1662`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15478`
- `MerchantAccount` → `schema.prisma:L5166`
- `MerchantFiscalConfig` → `schema.prisma:L15729`
- `MerchantRevenueShare` → `schema.prisma:L6177`
- `MerchantRoutingRule` → `schema.prisma:L5288`
- `MilestoneAchievement` → `schema.prisma:L12101`
- `Modifier` → `schema.prisma:L3934`
- `ModifierGroup` → `schema.prisma:L3898`
- `Module` → `schema.prisma:L10406`
- `MoneyAnomaly` → `schema.prisma:L6080`
- `MonthlyVenueProfit` → `schema.prisma:L6623`
- `Notification` → `schema.prisma:L8222`
- `NotificationPreference` → `schema.prisma:L8269`
- `NotificationTemplate` → `schema.prisma:L8296`
- `OAuthState` → `schema.prisma:L1492`
- `OnboardingProgress` → `schema.prisma:L1510`
- `Order` → `schema.prisma:L3536`
- `OrderAction` → `schema.prisma:L3999`
- `OrderCustomer` → `schema.prisma:L3749`
- `OrderDiscount` → `schema.prisma:L8083`
- `OrderFulfillment` → `schema.prisma:L14796`
- `OrderFulfillmentLine` → `schema.prisma:L14827`
- `OrderItem` → `schema.prisma:L3765`
- `OrderItemModifier` → `schema.prisma:L3983`
- `OrderPromotion` → `schema.prisma:L16905`
- `OrderServiceCharge` → `schema.prisma:L8167`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12478`
- `OrganizationEntitlement` → `schema.prisma:L10689`
- `OrganizationGoal` → `schema.prisma:L12436`
- `OrganizationModule` → `schema.prisma:L10466`
- `OrganizationPaymentConfig` → `schema.prisma:L5740`
- `OrganizationPayoutConfig` → `schema.prisma:L12511`
- `OrganizationPricingStructure` → `schema.prisma:L5772`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12459`
- `OtpChallenge` → `schema.prisma:L7080`
- `OvertimeApproval` → `schema.prisma:L3314`
- `PartnerAPIKey` → `schema.prisma:L5570`
- `Payment` → `schema.prisma:L4032`
- `PaymentAllocation` → `schema.prisma:L4298`
- `PaymentLink` → `schema.prisma:L14053`
- `PaymentLinkAttribution` → `schema.prisma:L14161`
- `PaymentLinkItem` → `schema.prisma:L14116`
- `PaymentLinkItemModifier` → `schema.prisma:L14143`
- `PaymentProvider` → `schema.prisma:L5125`
- `PayrollLine` → `schema.prisma:L16413`
- `PayrollRun` → `schema.prisma:L16382`
- `PerformanceGoal` → `schema.prisma:L12413`
- `PermissionOverride` → `schema.prisma:L1369`
- `PermissionSet` → `schema.prisma:L1392`
- `PlatformAnnouncement` → `schema.prisma:L17069`
- `PlatformAnnouncementClick` → `schema.prisma:L17134`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17171`
- `PlatformCfdi` → `schema.prisma:L16698`
- `PlatformEmisor` → `schema.prisma:L16638`
- `PlatformSettings` → `schema.prisma:L5547`
- `PosCommand` → `schema.prisma:L8350`
- `PosConnectionStatus` → `schema.prisma:L918`
- `PosSyncIntent` → `schema.prisma:L16776`
- `PricingPolicy` → `schema.prisma:L2602`
- `Printer` → `schema.prisma:L14610`
- `PrintGateway` → `schema.prisma:L14663`
- `PrintJob` → `schema.prisma:L15377`
- `PrintStation` → `schema.prisma:L14681`
- `PrivacyNoticeVersion` → `schema.prisma:L6877`
- `ProcessedStripeEvent` → `schema.prisma:L6066`
- `ProcessorReliabilityMetric` → `schema.prisma:L6551`
- `Product` → `schema.prisma:L1680`
- `ProductModifierGroup` → `schema.prisma:L3971`
- `ProductOption` → `schema.prisma:L14344`
- `ProductOptionValue` → `schema.prisma:L14355`
- `ProductStaff` → `schema.prisma:L13288`
- `PromoterBankAccount` → `schema.prisma:L16533`
- `PromoterCommissionEntry` → `schema.prisma:L16552`
- `PromoterLocationPing` → `schema.prisma:L3502`
- `Promotion` → `schema.prisma:L16827`
- `PromotionGroup` → `schema.prisma:L16866`
- `PromotionOption` → `schema.prisma:L16882`
- `ProviderCostStructure` → `schema.prisma:L6102`
- `ProviderEventLog` → `schema.prisma:L5849`
- `PurchaseOrder` → `schema.prisma:L2327`
- `PurchaseOrderInvoice` → `schema.prisma:L2472`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2529`
- `PurchaseOrderItem` → `schema.prisma:L2385`
- `RateCorrectionBatch` → `schema.prisma:L6327`
- `RateCorrectionEntry` → `schema.prisma:L6369`
- `RawMaterial` → `schema.prisma:L2084`
- `RawMaterialMovement` → `schema.prisma:L2655`
- `RawMaterialPresentation` → `schema.prisma:L2159`
- `Recipe` → `schema.prisma:L2179`
- `RecipeLine` → `schema.prisma:L2203`
- `Referral` → `schema.prisma:L7538`
- `ReferralProgramConfig` → `schema.prisma:L7503`
- `ReferralRewardGrant` → `schema.prisma:L7629`
- `ReferralTierReward` → `schema.prisma:L7601`
- `ReferralTierUnlock` → `schema.prisma:L7674`
- `RefreshGrant` → `schema.prisma:L17258`
- `Reservation` → `schema.prisma:L13056`
- `ReservationGoogleEventMapping` → `schema.prisma:L13826`
- `ReservationModifier` → `schema.prisma:L13236`
- `ReservationReminderSent` → `schema.prisma:L13219`
- `ReservationSettings` → `schema.prisma:L13450`
- `ReservationWaitlistEntry` → `schema.prisma:L13418`
- `Review` → `schema.prisma:L4593`
- `SalesRetention` → `schema.prisma:L16233`
- `SaleVerification` → `schema.prisma:L4352`
- `ScaleProfile` → `schema.prisma:L15118`
- `ScheduledCommand` → `schema.prisma:L9890`
- `SerializedItem` → `schema.prisma:L11540`
- `SerializedItemCustodyEvent` → `schema.prisma:L11704`
- `ServiceCharge` → `schema.prisma:L8138`
- `Session` → `schema.prisma:L17237`
- `SettlementConfiguration` → `schema.prisma:L6402`
- `SettlementConfirmation` → `schema.prisma:L6515`
- `SettlementIncident` → `schema.prisma:L6466`
- `SettlementSimulation` → `schema.prisma:L6437`
- `Shift` → `schema.prisma:L3143`
- `SimRegistrationRequest` → `schema.prisma:L11742`
- `SimRegistrationRequestItem` → `schema.prisma:L11764`
- `SlotHold` → `schema.prisma:L13319`
- `Staff` → `schema.prisma:L938`
- `StaffDocument` → `schema.prisma:L3373`
- `StaffOnboardingState` → `schema.prisma:L15448`
- `StaffOrganization` → `schema.prisma:L1268`
- `StaffPasskey` → `schema.prisma:L1295`
- `StaffSchedule` → `schema.prisma:L13259`
- `StaffScheduleException` → `schema.prisma:L13271`
- `StaffVenue` → `schema.prisma:L1192`
- `StaffWorkSchedule` → `schema.prisma:L3250`
- `StaffWorkScheduleException` → `schema.prisma:L3348`
- `StampCard` → `schema.prisma:L7386`
- `StampEvent` → `schema.prisma:L7425`
- `StampReward` → `schema.prisma:L7463`
- `StockAlertConfig` → `schema.prisma:L12395`
- `StockBatch` → `schema.prisma:L2806`
- `StockCount` → `schema.prisma:L2730`
- `StockCountItem` → `schema.prisma:L2754`
- `StripeWebhookEvent` → `schema.prisma:L6049`
- `Supplier` → `schema.prisma:L2238`
- `SupplierItemCode` → `schema.prisma:L2570`
- `SupplierPricing` → `schema.prisma:L2293`
- `Table` → `schema.prisma:L3055`
- `Terminal` → `schema.prisma:L4644`
- `TerminalHealth` → `schema.prisma:L4895`
- `TerminalLog` → `schema.prisma:L4869`
- `TerminalOrder` → `schema.prisma:L5028`
- `TerminalOrderItem` → `schema.prisma:L5103`
- `TerminalPaymentRequest` → `schema.prisma:L4966`
- `TimeEntry` → `schema.prisma:L3415`
- `TimeEntryBreak` → `schema.prisma:L3484`
- `TokenPurchase` → `schema.prisma:L9564`
- `TokenUsageRecord` → `schema.prisma:L9536`
- `TpvCommandHistory` → `schema.prisma:L9796`
- `TpvCommandQueue` → `schema.prisma:L9736`
- `TpvFeedback` → `schema.prisma:L9449`
- `TpvMessage` → `schema.prisma:L12752`
- `TpvMessageDelivery` → `schema.prisma:L12804`
- `TpvMessageResponse` → `schema.prisma:L12827`
- `TrainingModule` → `schema.prisma:L12882`
- `TrainingProgress` → `schema.prisma:L12959`
- `TrainingQuizQuestion` → `schema.prisma:L12941`
- `TrainingStep` → `schema.prisma:L12921`
- `TransactionCost` → `schema.prisma:L6265`
- `UnitConversion` → `schema.prisma:L2633`
- `UpsellAcceptance` → `schema.prisma:L7959`
- `UpsellAiRun` → `schema.prisma:L7979`
- `UpsellImpression` → `schema.prisma:L7919`
- `UpsellRule` → `schema.prisma:L7839`
- `user_sessions` → `schema.prisma:L5605`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14855`
- `VenueChatMessage` → `schema.prisma:L768`
- `VenueChatSession` → `schema.prisma:L723`
- `VenueCommission` → `schema.prisma:L14505`
- `VenueCreditAssessment` → `schema.prisma:L10278`
- `VenueCryptoConfig` → `schema.prisma:L12619`
- `VenueFeature` → `schema.prisma:L4466`
- `VenueModule` → `schema.prisma:L10438`
- `VenuePaymentConfig` → `schema.prisma:L5706`
- `VenuePaymentLinkSettings` → `schema.prisma:L13859`
- `VenuePricingStructure` → `schema.prisma:L6205`
- `VenueRoleConfig` → `schema.prisma:L1421`
- `VenueRolePermission` → `schema.prisma:L1325`
- `VenueScaleSettings` → `schema.prisma:L15106`
- `VenueSettings` → `schema.prisma:L808`
- `VenueTenderType` → `schema.prisma:L4211`
- `VenueTenderTypeRevision` → `schema.prisma:L4276`
- `VenueTransaction` → `schema.prisma:L4403`
- `VenueWhatsappActivation` → `schema.prisma:L659`
- `WalletCardDesign` → `schema.prisma:L7304`
- `WalletPass` → `schema.prisma:L7213`
- `WalletPassRegistration` → `schema.prisma:L7271`
- `WebhookEvent` → `schema.prisma:L4502`
- `WebhookSubscription` → `schema.prisma:L5822`
- `WhatsappContactWindow` → `schema.prisma:L677`
- `WhatsappInboundEvent` → `schema.prisma:L697`
- `WorkShiftAssignment` → `schema.prisma:L3290`
- `WorkShiftTemplate` → `schema.prisma:L3267`
- `Zone` → `schema.prisma:L142`
