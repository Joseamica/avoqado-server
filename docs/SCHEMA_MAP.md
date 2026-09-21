# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **371 models / 356 enums / ~17,800 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                         |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                             |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `InventoryWasteReport`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                               |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                            |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                      |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                                         |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                                 |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                      |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L16474`
- `AccountMapping` → `schema.prisma:L16370`
- `ActivityLog` → `schema.prisma:L6977`
- `Aggregator` → `schema.prisma:L14767`
- `AngelPayUserAccount` → `schema.prisma:L5628`
- `AppUpdate` → `schema.prisma:L12932`
- `Area` → `schema.prisma:L3189`
- `AreaTicket` → `schema.prisma:L15265`
- `AreaTicketCheckoutSession` → `schema.prisma:L15387`
- `AreaTicketExternalIncident` → `schema.prisma:L15634`
- `AreaTicketExternalSettlement` → `schema.prisma:L15599`
- `AreaTicketFulfillment` → `schema.prisma:L15463`
- `AreaTicketInventoryReservation` → `schema.prisma:L15358`
- `AreaTicketLine` → `schema.prisma:L15326`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15419`
- `AreaTicketPrintAttempt` → `schema.prisma:L15442`
- `BankStatement` → `schema.prisma:L16244`
- `BankStatementLine` → `schema.prisma:L16265`
- `BillingTaxProfile` → `schema.prisma:L17054`
- `BirthdayAutomation` → `schema.prisma:L7298`
- `BulkCommandOperation` → `schema.prisma:L10212`
- `CalendarSyncOutbox` → `schema.prisma:L14139`
- `CampaignDelivery` → `schema.prisma:L13090`
- `CashCloseout` → `schema.prisma:L10597`
- `CashDeposit` → `schema.prisma:L12734`
- `CashDrawerEvent` → `schema.prisma:L14604`
- `CashDrawerSession` → `schema.prisma:L14565`
- `CashOutCommissionRate` → `schema.prisma:L16883`
- `CashOutScheduleDay` → `schema.prisma:L16906`
- `CashOutWithdrawal` → `schema.prisma:L16968`
- `CatalogBindingBatch` → `schema.prisma:L11628`
- `CatalogBindingLine` → `schema.prisma:L11664`
- `CatalogBrand` → `schema.prisma:L11081`
- `CatalogClientObservation` → `schema.prisma:L11394`
- `CatalogClientReadinessOverride` → `schema.prisma:L11413`
- `CatalogFamily` → `schema.prisma:L11131`
- `CatalogIdempotencyRecord` → `schema.prisma:L11527`
- `CatalogIdentifier` → `schema.prisma:L11262`
- `CatalogImportBatch` → `schema.prisma:L11570`
- `CatalogImportLine` → `schema.prisma:L11607`
- `CatalogItem` → `schema.prisma:L11164`
- `CatalogItemBusinessType` → `schema.prisma:L11224`
- `CatalogItemPrice` → `schema.prisma:L11312`
- `CatalogManufacturer` → `schema.prisma:L11105`
- `CatalogProductTypeMapping` → `schema.prisma:L11241`
- `CatalogPublicationBatch` → `schema.prisma:L11692`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11786`
- `CatalogPublicationLine` → `schema.prisma:L11733`
- `CatalogPublicationOutbox` → `schema.prisma:L11829`
- `CatalogValidationProfile` → `schema.prisma:L11283`
- `CatalogVenueBinding` → `schema.prisma:L11441`
- `CatalogVenueClientRequirement` → `schema.prisma:L11368`
- `CatalogVenueEventSequence` → `schema.prisma:L11812`
- `CatalogVenueOverride` → `schema.prisma:L11483`
- `CatalogVenueRollout` → `schema.prisma:L11343`
- `Cfdi` → `schema.prisma:L16147`
- `ChatbotTokenBudget` → `schema.prisma:L9860`
- `ChatConversation` → `schema.prisma:L9715`
- `ChatFeedback` → `schema.prisma:L9801`
- `ChatLearningEvent` → `schema.prisma:L9758`
- `ChatMessage` → `schema.prisma:L9738`
- `ChatTrainingData` → `schema.prisma:L9672`
- `CheckoutSession` → `schema.prisma:L5908`
- `ClassSession` → `schema.prisma:L13743`
- `CommissionCalculation` → `schema.prisma:L12510`
- `CommissionClawback` → `schema.prisma:L12686`
- `CommissionConfig` → `schema.prisma:L12276`
- `CommissionMilestone` → `schema.prisma:L12426`
- `CommissionOverride` → `schema.prisma:L12353`
- `CommissionPayout` → `schema.prisma:L12637`
- `CommissionSummary` → `schema.prisma:L12576`
- `CommissionTier` → `schema.prisma:L12390`
- `ConsentEvent` → `schema.prisma:L7160`
- `Consumer` → `schema.prisma:L7390`
- `ConsumerAuthAccount` → `schema.prisma:L7415`
- `CouponCode` → `schema.prisma:L8362`
- `CouponRedemption` → `schema.prisma:L8393`
- `CreditAssessmentHistory` → `schema.prisma:L10706`
- `CreditItemBalance` → `schema.prisma:L14355`
- `CreditOffer` → `schema.prisma:L10725`
- `CreditPack` → `schema.prisma:L14264`
- `CreditPackItem` → `schema.prisma:L14293`
- `CreditPackPurchase` → `schema.prisma:L14310`
- `CreditTransaction` → `schema.prisma:L14377`
- `Customer` → `schema.prisma:L7018`
- `CustomerApprovalDelivery` → `schema.prisma:L9374`
- `CustomerApprovalOutbox` → `schema.prisma:L9349`
- `CustomerCampaign` → `schema.prisma:L7248`
- `CustomerCampaignDelivery` → `schema.prisma:L7330`
- `CustomerCaptureToken` → `schema.prisma:L7196`
- `CustomerDiscount` → `schema.prisma:L8413`
- `CustomerGroup` → `schema.prisma:L7454`
- `CustomerOrderMetric` → `schema.prisma:L3960`
- `CustomerTaxProfile` → `schema.prisma:L16216`
- `DeliveryActivationRequest` → `schema.prisma:L6261`
- `DeliveryChannelLink` → `schema.prisma:L6206`
- `DeliveryOrderEvent` → `schema.prisma:L6285`
- `DeviceToken` → `schema.prisma:L8682`
- `DigitalReceipt` → `schema.prisma:L4538`
- `Discount` → `schema.prisma:L8052`
- `EcommerceMerchant` → `schema.prisma:L5720`
- `EmailQuotaLedger` → `schema.prisma:L7377`
- `EmailSuppression` → `schema.prisma:L7365`
- `EmailTemplate` → `schema.prisma:L13029`
- `Employee` → `schema.prisma:L16731`
- `Estimate` → `schema.prisma:L14674`
- `EstimateItem` → `schema.prisma:L14702`
- `Expense` → `schema.prisma:L16518`
- `ExternalBusyBlock` → `schema.prisma:L14032`
- `Feature` → `schema.prisma:L4667`
- `FeeSchedule` → `schema.prisma:L4752`
- `FeeTier` → `schema.prisma:L4763`
- `FinancialAccount` → `schema.prisma:L14864`
- `FinancialConnection` → `schema.prisma:L14833`
- `FinancialProvider` → `schema.prisma:L14819`
- `FiscalEmisor` → `schema.prisma:L16070`
- `FiscalLossCarryforward` → `schema.prisma:L16641`
- `FixedAsset` → `schema.prisma:L16659`
- `FixedAssetDepreciation` → `schema.prisma:L16688`
- `FloorElement` → `schema.prisma:L3265`
- `FulfillmentArea` → `schema.prisma:L15130`
- `GeofenceRule` → `schema.prisma:L10297`
- `GoogleCalendarChannel` → `schema.prisma:L14009`
- `GoogleCalendarConnection` → `schema.prisma:L13961`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14062`
- `GoogleOAuthSession` → `schema.prisma:L14084`
- `HolidayCalendar` → `schema.prisma:L6901`
- `IdempotencyRequest` → `schema.prisma:L12151`
- `InterVenueTransfer` → `schema.prisma:L3017`
- `InterVenueTransferAllocation` → `schema.prisma:L3100`
- `InterVenueTransferItem` → `schema.prisma:L3069`
- `InterVenueTransferReceipt` → `schema.prisma:L3127`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3143`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3171`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3155`
- `Inventory` → `schema.prisma:L1974`
- `InventoryMovement` → `schema.prisma:L2071`
- `InventoryPosting` → `schema.prisma:L2159`
- `InventoryPostingLine` → `schema.prisma:L2199`
- `InventoryTransfer` → `schema.prisma:L14646`
- `InventoryWasteReport` → `schema.prisma:L2029`
- `Invitation` → `schema.prisma:L1479`
- `Invoice` → `schema.prisma:L4775`
- `InvoiceItem` → `schema.prisma:L4801`
- `ItemCategory` → `schema.prisma:L11864`
- `JournalEntry` → `schema.prisma:L16428`
- `JournalLine` → `schema.prisma:L16456`
- `KdsOrder` → `schema.prisma:L14912`
- `KdsOrderItem` → `schema.prisma:L14953`
- `KioskCheckInAttempt` → `schema.prisma:L17377`
- `KioskCheckInChallenge` → `schema.prisma:L17331`
- `KioskOutreachOutbox` → `schema.prisma:L17398`
- `LaunchCampaign` → `schema.prisma:L17736`
- `LaunchCampaignRedemption` → `schema.prisma:L17842`
- `LearnedPatterns` → `schema.prisma:L9782`
- `LedgerAccount` → `schema.prisma:L16320`
- `LiveDemoSession` → `schema.prisma:L823`
- `LowStockAlert` → `schema.prisma:L2851`
- `LoyaltyConfig` → `schema.prisma:L7484`
- `LoyaltyTransaction` → `schema.prisma:L7527`
- `MarketingCampaign` → `schema.prisma:L13047`
- `McpAuthCode` → `schema.prisma:L15953`
- `McpOAuthClient` → `schema.prisma:L15937`
- `McpRefreshToken` → `schema.prisma:L15971`
- `McpToolCall` → `schema.prisma:L15992`
- `MeasurementUnit` → `schema.prisma:L14752`
- `Menu` → `schema.prisma:L1697`
- `MenuCategory` → `schema.prisma:L1634`
- `MenuCategoryAssignment` → `schema.prisma:L1732`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15867`
- `MerchantAccount` → `schema.prisma:L5458`
- `MerchantFiscalConfig` → `schema.prisma:L16118`
- `MerchantRevenueShare` → `schema.prisma:L6481`
- `MerchantRoutingRule` → `schema.prisma:L5580`
- `MilestoneAchievement` → `schema.prisma:L12471`
- `Modifier` → `schema.prisma:L4144`
- `ModifierGroup` → `schema.prisma:L4108`
- `Module` → `schema.prisma:L10773`
- `MoneyAnomaly` → `schema.prisma:L6384`
- `MonthlyVenueProfit` → `schema.prisma:L6927`
- `Notification` → `schema.prisma:L8584`
- `NotificationPreference` → `schema.prisma:L8631`
- `NotificationTemplate` → `schema.prisma:L8658`
- `OAuthState` → `schema.prisma:L1530`
- `OnboardingProgress` → `schema.prisma:L1548`
- `Order` → `schema.prisma:L3714`
- `OrderAction` → `schema.prisma:L4211`
- `OrderCustomer` → `schema.prisma:L3939`
- `OrderDiscount` → `schema.prisma:L8445`
- `OrderFulfillment` → `schema.prisma:L15185`
- `OrderFulfillmentLine` → `schema.prisma:L15216`
- `OrderItem` → `schema.prisma:L3975`
- `OrderItemModifier` → `schema.prisma:L4193`
- `OrderPromotion` → `schema.prisma:L17294`
- `OrderServiceCharge` → `schema.prisma:L8529`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12848`
- `OrganizationEntitlement` → `schema.prisma:L11056`
- `OrganizationGoal` → `schema.prisma:L12806`
- `OrganizationModule` → `schema.prisma:L10833`
- `OrganizationPaymentConfig` → `schema.prisma:L6032`
- `OrganizationPayoutConfig` → `schema.prisma:L12881`
- `OrganizationPricingStructure` → `schema.prisma:L6064`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12829`
- `OtpChallenge` → `schema.prisma:L7434`
- `OvertimeApproval` → `schema.prisma:L3492`
- `PartnerAPIKey` → `schema.prisma:L5862`
- `Payment` → `schema.prisma:L4244`
- `PaymentAllocation` → `schema.prisma:L4517`
- `PaymentEffect` → `schema.prisma:L17668`
- `PaymentLink` → `schema.prisma:L14423`
- `PaymentLinkAttribution` → `schema.prisma:L14531`
- `PaymentLinkItem` → `schema.prisma:L14486`
- `PaymentLinkItemModifier` → `schema.prisma:L14513`
- `PaymentProvider` → `schema.prisma:L5417`
- `PayrollLine` → `schema.prisma:L16802`
- `PayrollRun` → `schema.prisma:L16771`
- `PerformanceGoal` → `schema.prisma:L12783`
- `PermissionOverride` → `schema.prisma:L1403`
- `PermissionSet` → `schema.prisma:L1426`
- `PlatformAnnouncement` → `schema.prisma:L17458`
- `PlatformAnnouncementClick` → `schema.prisma:L17523`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17560`
- `PlatformCfdi` → `schema.prisma:L17087`
- `PlatformEmisor` → `schema.prisma:L17027`
- `PlatformSettings` → `schema.prisma:L5839`
- `PosCommand` → `schema.prisma:L8712`
- `PosConnectionStatus` → `schema.prisma:L949`
- `PosSyncIntent` → `schema.prisma:L17165`
- `PricingPolicy` → `schema.prisma:L2750`
- `Printer` → `schema.prisma:L14995`
- `PrintGateway` → `schema.prisma:L15052`
- `PrintJob` → `schema.prisma:L15766`
- `PrintStation` → `schema.prisma:L15070`
- `PrivacyNoticeVersion` → `schema.prisma:L7182`
- `ProcessedStripeEvent` → `schema.prisma:L6370`
- `ProcessorReliabilityMetric` → `schema.prisma:L6855`
- `Product` → `schema.prisma:L1750`
- `ProductModifierGroup` → `schema.prisma:L4181`
- `ProductOption` → `schema.prisma:L14729`
- `ProductOptionValue` → `schema.prisma:L14740`
- `ProductStaff` → `schema.prisma:L13658`
- `PromoterBankAccount` → `schema.prisma:L16922`
- `PromoterCommissionEntry` → `schema.prisma:L16941`
- `PromoterLocationPing` → `schema.prisma:L3680`
- `Promotion` → `schema.prisma:L17216`
- `PromotionGroup` → `schema.prisma:L17255`
- `PromotionOption` → `schema.prisma:L17271`
- `ProviderCostStructure` → `schema.prisma:L6406`
- `ProviderEventLog` → `schema.prisma:L6141`
- `PurchaseOrder` → `schema.prisma:L2475`
- `PurchaseOrderInvoice` → `schema.prisma:L2620`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2677`
- `PurchaseOrderItem` → `schema.prisma:L2533`
- `RateCorrectionBatch` → `schema.prisma:L6631`
- `RateCorrectionEntry` → `schema.prisma:L6673`
- `RawMaterial` → `schema.prisma:L2231`
- `RawMaterialMovement` → `schema.prisma:L2803`
- `RawMaterialPresentation` → `schema.prisma:L2307`
- `ReceiptLayout` → `schema.prisma:L17702`
- `Recipe` → `schema.prisma:L2327`
- `RecipeLine` → `schema.prisma:L2351`
- `Referral` → `schema.prisma:L7900`
- `ReferralProgramConfig` → `schema.prisma:L7865`
- `ReferralRewardGrant` → `schema.prisma:L7991`
- `ReferralTierReward` → `schema.prisma:L7963`
- `ReferralTierUnlock` → `schema.prisma:L8036`
- `RefreshGrant` → `schema.prisma:L17647`
- `Reservation` → `schema.prisma:L13426`
- `ReservationGoogleEventMapping` → `schema.prisma:L14196`
- `ReservationModifier` → `schema.prisma:L13606`
- `ReservationReminderSent` → `schema.prisma:L13589`
- `ReservationSettings` → `schema.prisma:L13820`
- `ReservationWaitlistEntry` → `schema.prisma:L13788`
- `Review` → `schema.prisma:L4819`
- `SalesRetention` → `schema.prisma:L16622`
- `SaleVerification` → `schema.prisma:L4571`
- `ScaleProfile` → `schema.prisma:L15507`
- `ScheduledCommand` → `schema.prisma:L10257`
- `SerializedItem` → `schema.prisma:L11907`
- `SerializedItemCustodyEvent` → `schema.prisma:L12074`
- `ServiceCharge` → `schema.prisma:L8500`
- `Session` → `schema.prisma:L17626`
- `SettlementConfiguration` → `schema.prisma:L6706`
- `SettlementConfirmation` → `schema.prisma:L6819`
- `SettlementIncident` → `schema.prisma:L6770`
- `SettlementSimulation` → `schema.prisma:L6741`
- `Shift` → `schema.prisma:L3303`
- `SimRegistrationRequest` → `schema.prisma:L12112`
- `SimRegistrationRequestItem` → `schema.prisma:L12134`
- `SlotHold` → `schema.prisma:L13689`
- `Staff` → `schema.prisma:L969`
- `StaffDocument` → `schema.prisma:L3551`
- `StaffOnboardingState` → `schema.prisma:L15837`
- `StaffOrganization` → `schema.prisma:L1302`
- `StaffPasskey` → `schema.prisma:L1329`
- `StaffSchedule` → `schema.prisma:L13629`
- `StaffScheduleException` → `schema.prisma:L13641`
- `StaffVenue` → `schema.prisma:L1226`
- `StaffWorkSchedule` → `schema.prisma:L3428`
- `StaffWorkScheduleException` → `schema.prisma:L3526`
- `StampCard` → `schema.prisma:L7748`
- `StampEvent` → `schema.prisma:L7787`
- `StampReward` → `schema.prisma:L7825`
- `StockAlertConfig` → `schema.prisma:L12765`
- `StockBatch` → `schema.prisma:L2966`
- `StockCount` → `schema.prisma:L2883`
- `StockCountItem` → `schema.prisma:L2911`
- `StripeWebhookEvent` → `schema.prisma:L6353`
- `Supplier` → `schema.prisma:L2386`
- `SupplierItemCode` → `schema.prisma:L2718`
- `SupplierPricing` → `schema.prisma:L2441`
- `Table` → `schema.prisma:L3215`
- `Terminal` → `schema.prisma:L4870`
- `TerminalHealth` → `schema.prisma:L5121`
- `TerminalLog` → `schema.prisma:L5095`
- `TerminalOrder` → `schema.prisma:L5320`
- `TerminalOrderItem` → `schema.prisma:L5395`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5273`
- `TerminalPaymentRequest` → `schema.prisma:L5192`
- `TimeEntry` → `schema.prisma:L3593`
- `TimeEntryBreak` → `schema.prisma:L3662`
- `TokenPurchase` → `schema.prisma:L9931`
- `TokenUsageRecord` → `schema.prisma:L9903`
- `TpvCommandHistory` → `schema.prisma:L10163`
- `TpvCommandQueue` → `schema.prisma:L10103`
- `TpvFeedback` → `schema.prisma:L9816`
- `TpvMessage` → `schema.prisma:L13122`
- `TpvMessageDelivery` → `schema.prisma:L13174`
- `TpvMessageResponse` → `schema.prisma:L13197`
- `TrainingModule` → `schema.prisma:L13252`
- `TrainingProgress` → `schema.prisma:L13329`
- `TrainingQuizQuestion` → `schema.prisma:L13311`
- `TrainingStep` → `schema.prisma:L13291`
- `TransactionCost` → `schema.prisma:L6569`
- `UnitConversion` → `schema.prisma:L2781`
- `UpsellAcceptance` → `schema.prisma:L8321`
- `UpsellAiRun` → `schema.prisma:L8341`
- `UpsellImpression` → `schema.prisma:L8281`
- `UpsellRule` → `schema.prisma:L8201`
- `user_sessions` → `schema.prisma:L5897`
- `Venue` → `schema.prisma:L163`
- `VenueAreaTicketSettings` → `schema.prisma:L15244`
- `VenueChatMessage` → `schema.prisma:L799`
- `VenueChatSession` → `schema.prisma:L754`
- `VenueCommission` → `schema.prisma:L14890`
- `VenueCreditAssessment` → `schema.prisma:L10645`
- `VenueCryptoConfig` → `schema.prisma:L12989`
- `VenueFeature` → `schema.prisma:L4685`
- `VenueModule` → `schema.prisma:L10805`
- `VenuePaymentConfig` → `schema.prisma:L5998`
- `VenuePaymentLinkSettings` → `schema.prisma:L14229`
- `VenuePricingStructure` → `schema.prisma:L6509`
- `VenueRoleConfig` → `schema.prisma:L1455`
- `VenueRolePermission` → `schema.prisma:L1359`
- `VenueScaleSettings` → `schema.prisma:L15495`
- `VenueSettings` → `schema.prisma:L839`
- `VenueTenderType` → `schema.prisma:L4430`
- `VenueTenderTypeRevision` → `schema.prisma:L4495`
- `VenueTransaction` → `schema.prisma:L4622`
- `VenueWhatsappActivation` → `schema.prisma:L690`
- `WalletCardDesign` → `schema.prisma:L7666`
- `WalletPass` → `schema.prisma:L7567`
- `WalletPassRegistration` → `schema.prisma:L7633`
- `WebhookEvent` → `schema.prisma:L4728`
- `WebhookSubscription` → `schema.prisma:L6114`
- `WhatsappContactWindow` → `schema.prisma:L708`
- `WhatsappInboundEvent` → `schema.prisma:L728`
- `WorkShiftAssignment` → `schema.prisma:L3468`
- `WorkShiftTemplate` → `schema.prisma:L3445`
- `Zone` → `schema.prisma:L146`
