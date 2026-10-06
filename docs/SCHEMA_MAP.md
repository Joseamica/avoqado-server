# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **410 models / 377 enums / ~19,100 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueIvaPorProducto`, `VenuePosSinAparato`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `CapabilityGrant`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `HybridBillingOperation`, `HybridCampaign`, `HybridContract`, `HybridContractSelection`, `HybridCreditAllocation`, `HybridOfferPublication`, `HybridPaymentPeriod`, `HybridPromotionGroup`, `HybridPurchase`, `HybridRedemption`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                               |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                                                                                                       |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `InventoryWasteReport`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                                                                                                         |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryConnectIntent`, `DeliveryLineAction`, `DeliveryOrderEvent`, `DeliveryStoreRevocation`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                                                                                                      |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CfdiGlobalOrden`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `OrderItemSelloIva`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                                                                                                |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `ClassSessionPayState`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `ServiceEarning`, `ServicePayPeriod`, `ServicePayTable`, `ServicePayTableCell`, `ServicePayTableVersion`, `StaffPayLevel`, `StaffPayLevelAssignment`, `StaffPayStatement`, `StaffPayTipWindow`, `VenueCommission`                                                                                                                                                                                                                           |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `AggregatorBooking`, `AggregatorCapacityRule`, `AggregatorConnection`, `AggregatorInboundEvent`, `AggregatorOutbox`, `AggregatorProductLink`, `AggregatorSessionLink`, `AggregatorVisit`, `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                 |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalAttemptResolution`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerExternalIdentity`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L17449`
- `AccountMapping` → `schema.prisma:L17344`
- `ActivityLog` → `schema.prisma:L7529`
- `Aggregator` → `schema.prisma:L15620`
- `AggregatorBooking` → `schema.prisma:L14928`
- `AggregatorCapacityRule` → `schema.prisma:L14909`
- `AggregatorConnection` → `schema.prisma:L14834`
- `AggregatorInboundEvent` → `schema.prisma:L14997`
- `AggregatorOutbox` → `schema.prisma:L15017`
- `AggregatorProductLink` → `schema.prisma:L14866`
- `AggregatorSessionLink` → `schema.prisma:L14885`
- `AggregatorVisit` → `schema.prisma:L14954`
- `AngelPayUserAccount` → `schema.prisma:L6074`
- `AppUpdate` → `schema.prisma:L13501`
- `Area` → `schema.prisma:L3261`
- `AreaTicket` → `schema.prisma:L16156`
- `AreaTicketCheckoutSession` → `schema.prisma:L16278`
- `AreaTicketExternalIncident` → `schema.prisma:L16525`
- `AreaTicketExternalSettlement` → `schema.prisma:L16490`
- `AreaTicketFulfillment` → `schema.prisma:L16354`
- `AreaTicketInventoryReservation` → `schema.prisma:L16249`
- `AreaTicketLine` → `schema.prisma:L16217`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16310`
- `AreaTicketPrintAttempt` → `schema.prisma:L16333`
- `BankStatement` → `schema.prisma:L17218`
- `BankStatementLine` → `schema.prisma:L17239`
- `BillingObligationConflict` → `schema.prisma:L5104`
- `BillingTaxProfile` → `schema.prisma:L18041`
- `BirthdayAutomation` → `schema.prisma:L7853`
- `BulkCommandOperation` → `schema.prisma:L10780`
- `CalendarSyncOutbox` → `schema.prisma:L14717`
- `CampaignDelivery` → `schema.prisma:L13659`
- `CapabilityGrant` → `schema.prisma:L4844`
- `CashCloseout` → `schema.prisma:L11165`
- `CashDeposit` → `schema.prisma:L13303`
- `CashDrawerEvent` → `schema.prisma:L15457`
- `CashDrawerSession` → `schema.prisma:L15418`
- `CashOutCommissionRate` → `schema.prisma:L17858`
- `CashOutScheduleDay` → `schema.prisma:L17881`
- `CashOutWithdrawal` → `schema.prisma:L17943`
- `CatalogBindingBatch` → `schema.prisma:L12196`
- `CatalogBindingLine` → `schema.prisma:L12232`
- `CatalogBrand` → `schema.prisma:L11649`
- `CatalogClientObservation` → `schema.prisma:L11962`
- `CatalogClientReadinessOverride` → `schema.prisma:L11981`
- `CatalogFamily` → `schema.prisma:L11699`
- `CatalogIdempotencyRecord` → `schema.prisma:L12095`
- `CatalogIdentifier` → `schema.prisma:L11830`
- `CatalogImportBatch` → `schema.prisma:L12138`
- `CatalogImportLine` → `schema.prisma:L12175`
- `CatalogItem` → `schema.prisma:L11732`
- `CatalogItemBusinessType` → `schema.prisma:L11792`
- `CatalogItemPrice` → `schema.prisma:L11880`
- `CatalogManufacturer` → `schema.prisma:L11673`
- `CatalogProductTypeMapping` → `schema.prisma:L11809`
- `CatalogPublicationBatch` → `schema.prisma:L12260`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12354`
- `CatalogPublicationLine` → `schema.prisma:L12301`
- `CatalogPublicationOutbox` → `schema.prisma:L12397`
- `CatalogValidationProfile` → `schema.prisma:L11851`
- `CatalogVenueBinding` → `schema.prisma:L12009`
- `CatalogVenueClientRequirement` → `schema.prisma:L11936`
- `CatalogVenueEventSequence` → `schema.prisma:L12380`
- `CatalogVenueOverride` → `schema.prisma:L12051`
- `CatalogVenueRollout` → `schema.prisma:L11911`
- `Cfdi` → `schema.prisma:L17046`
- `CfdiGlobalOrden` → `schema.prisma:L17171`
- `ChatbotTokenBudget` → `schema.prisma:L10426`
- `ChatConversation` → `schema.prisma:L10281`
- `ChatFeedback` → `schema.prisma:L10367`
- `ChatLearningEvent` → `schema.prisma:L10324`
- `ChatMessage` → `schema.prisma:L10304`
- `ChatTrainingData` → `schema.prisma:L10238`
- `CheckoutSession` → `schema.prisma:L6354`
- `ClassSession` → `schema.prisma:L14317`
- `ClassSessionPayState` → `schema.prisma:L18996`
- `CommissionCalculation` → `schema.prisma:L13078`
- `CommissionClawback` → `schema.prisma:L13255`
- `CommissionConfig` → `schema.prisma:L12844`
- `CommissionMilestone` → `schema.prisma:L12994`
- `CommissionOverride` → `schema.prisma:L12921`
- `CommissionPayout` → `schema.prisma:L13206`
- `CommissionSummary` → `schema.prisma:L13145`
- `CommissionTier` → `schema.prisma:L12958`
- `ConsentEvent` → `schema.prisma:L7715`
- `Consumer` → `schema.prisma:L7945`
- `ConsumerAuthAccount` → `schema.prisma:L7970`
- `CouponCode` → `schema.prisma:L8917`
- `CouponRedemption` → `schema.prisma:L8948`
- `CreditAssessmentHistory` → `schema.prisma:L11274`
- `CreditItemBalance` → `schema.prisma:L15208`
- `CreditOffer` → `schema.prisma:L11293`
- `CreditPack` → `schema.prisma:L15117`
- `CreditPackItem` → `schema.prisma:L15146`
- `CreditPackPurchase` → `schema.prisma:L15163`
- `CreditTransaction` → `schema.prisma:L15230`
- `Customer` → `schema.prisma:L7570`
- `CustomerApprovalDelivery` → `schema.prisma:L9940`
- `CustomerApprovalOutbox` → `schema.prisma:L9915`
- `CustomerCampaign` → `schema.prisma:L7803`
- `CustomerCampaignDelivery` → `schema.prisma:L7885`
- `CustomerCaptureToken` → `schema.prisma:L7751`
- `CustomerDiscount` → `schema.prisma:L8968`
- `CustomerExternalIdentity` → `schema.prisma:L14984`
- `CustomerGroup` → `schema.prisma:L8009`
- `CustomerOrderMetric` → `schema.prisma:L4060`
- `CustomerTaxProfile` → `schema.prisma:L17190`
- `DeliveryActivationRequest` → `schema.prisma:L6813`
- `DeliveryChannelLink` → `schema.prisma:L6652`
- `DeliveryConnectIntent` → `schema.prisma:L6764`
- `DeliveryLineAction` → `schema.prisma:L6725`
- `DeliveryOrderEvent` → `schema.prisma:L6837`
- `DeliveryStoreRevocation` → `schema.prisma:L6801`
- `DeviceToken` → `schema.prisma:L9242`
- `DigitalReceipt` → `schema.prisma:L4657`
- `Discount` → `schema.prisma:L8607`
- `EcommerceMerchant` → `schema.prisma:L6166`
- `EmailQuotaLedger` → `schema.prisma:L7932`
- `EmailSuppression` → `schema.prisma:L7920`
- `EmailTemplate` → `schema.prisma:L13598`
- `Employee` → `schema.prisma:L17706`
- `Estimate` → `schema.prisma:L15527`
- `EstimateItem` → `schema.prisma:L15555`
- `Expense` → `schema.prisma:L17493`
- `ExternalBusyBlock` → `schema.prisma:L14610`
- `Feature` → `schema.prisma:L4786`
- `FeeSchedule` → `schema.prisma:L5166`
- `FeeTier` → `schema.prisma:L5177`
- `FinancialAccount` → `schema.prisma:L15717`
- `FinancialConnection` → `schema.prisma:L15686`
- `FinancialProvider` → `schema.prisma:L15672`
- `FiscalEmisor` → `schema.prisma:L16962`
- `FiscalLossCarryforward` → `schema.prisma:L17616`
- `FixedAsset` → `schema.prisma:L17634`
- `FixedAssetDepreciation` → `schema.prisma:L17663`
- `FloorElement` → `schema.prisma:L3337`
- `FulfillmentArea` → `schema.prisma:L16021`
- `GeofenceRule` → `schema.prisma:L10865`
- `GoogleCalendarChannel` → `schema.prisma:L14587`
- `GoogleCalendarConnection` → `schema.prisma:L14539`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14640`
- `GoogleOAuthSession` → `schema.prisma:L14662`
- `HolidayCalendar` → `schema.prisma:L7453`
- `HybridBillingOperation` → `schema.prisma:L5028`
- `HybridCampaign` → `schema.prisma:L4869`
- `HybridContract` → `schema.prisma:L4985`
- `HybridContractSelection` → `schema.prisma:L5017`
- `HybridCreditAllocation` → `schema.prisma:L5084`
- `HybridOfferPublication` → `schema.prisma:L4932`
- `HybridPaymentPeriod` → `schema.prisma:L5063`
- `HybridPromotionGroup` → `schema.prisma:L4913`
- `HybridPurchase` → `schema.prisma:L4952`
- `HybridRedemption` → `schema.prisma:L5046`
- `IdempotencyRequest` → `schema.prisma:L12719`
- `InterVenueTransfer` → `schema.prisma:L3089`
- `InterVenueTransferAllocation` → `schema.prisma:L3172`
- `InterVenueTransferItem` → `schema.prisma:L3141`
- `InterVenueTransferReceipt` → `schema.prisma:L3199`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3215`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3243`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3227`
- `Inventory` → `schema.prisma:L2033`
- `InventoryMovement` → `schema.prisma:L2133`
- `InventoryPosting` → `schema.prisma:L2228`
- `InventoryPostingLine` → `schema.prisma:L2268`
- `InventoryTransfer` → `schema.prisma:L15499`
- `InventoryWasteReport` → `schema.prisma:L2088`
- `Invitation` → `schema.prisma:L1527`
- `Invoice` → `schema.prisma:L5189`
- `InvoiceItem` → `schema.prisma:L5215`
- `ItemCategory` → `schema.prisma:L12432`
- `JournalEntry` → `schema.prisma:L17402`
- `JournalLine` → `schema.prisma:L17431`
- `KdsOrder` → `schema.prisma:L15765`
- `KdsOrderItem` → `schema.prisma:L15828`
- `KioskCheckInAttempt` → `schema.prisma:L18364`
- `KioskCheckInChallenge` → `schema.prisma:L18318`
- `KioskOutreachOutbox` → `schema.prisma:L18385`
- `LaunchCampaign` → `schema.prisma:L18723`
- `LaunchCampaignRedemption` → `schema.prisma:L18840`
- `LearnedPatterns` → `schema.prisma:L10348`
- `LedgerAccount` → `schema.prisma:L17294`
- `LiveDemoSession` → `schema.prisma:L852`
- `LowStockAlert` → `schema.prisma:L2923`
- `LoyaltyConfig` → `schema.prisma:L8039`
- `LoyaltyTransaction` → `schema.prisma:L8082`
- `MarketingCampaign` → `schema.prisma:L13616`
- `McpAuthCode` → `schema.prisma:L16844`
- `McpOAuthClient` → `schema.prisma:L16828`
- `McpRefreshToken` → `schema.prisma:L16862`
- `McpToolCall` → `schema.prisma:L16884`
- `MeasurementUnit` → `schema.prisma:L15605`
- `Menu` → `schema.prisma:L1745`
- `MenuCategory` → `schema.prisma:L1682`
- `MenuCategoryAssignment` → `schema.prisma:L1780`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16758`
- `MerchantAccount` → `schema.prisma:L5904`
- `MerchantFiscalConfig` → `schema.prisma:L17017`
- `MerchantRevenueShare` → `schema.prisma:L7033`
- `MerchantRoutingRule` → `schema.prisma:L6026`
- `MilestoneAchievement` → `schema.prisma:L13039`
- `Modifier` → `schema.prisma:L4259`
- `ModifierGroup` → `schema.prisma:L4223`
- `Module` → `schema.prisma:L11341`
- `MoneyAnomaly` → `schema.prisma:L6936`
- `MonthlyVenueProfit` → `schema.prisma:L7479`
- `Notification` → `schema.prisma:L9144`
- `NotificationPreference` → `schema.prisma:L9191`
- `NotificationTemplate` → `schema.prisma:L9218`
- `OAuthState` → `schema.prisma:L1578`
- `OnboardingProgress` → `schema.prisma:L1596`
- `Order` → `schema.prisma:L3786`
- `OrderAction` → `schema.prisma:L4330`
- `OrderCustomer` → `schema.prisma:L4039`
- `OrderDiscount` → `schema.prisma:L9000`
- `OrderFulfillment` → `schema.prisma:L16076`
- `OrderFulfillmentLine` → `schema.prisma:L16107`
- `OrderItem` → `schema.prisma:L4075`
- `OrderItemModifier` → `schema.prisma:L4312`
- `OrderItemSelloIva` → `schema.prisma:L17151`
- `OrderPromotion` → `schema.prisma:L18281`
- `OrderServiceCharge` → `schema.prisma:L9089`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13417`
- `OrganizationEntitlement` → `schema.prisma:L11624`
- `OrganizationGoal` → `schema.prisma:L13375`
- `OrganizationModule` → `schema.prisma:L11401`
- `OrganizationPaymentConfig` → `schema.prisma:L6478`
- `OrganizationPayoutConfig` → `schema.prisma:L13450`
- `OrganizationPricingStructure` → `schema.prisma:L6510`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13398`
- `OtpChallenge` → `schema.prisma:L7989`
- `OvertimeApproval` → `schema.prisma:L3564`
- `PartnerAPIKey` → `schema.prisma:L6308`
- `Payment` → `schema.prisma:L4363`
- `PaymentAllocation` → `schema.prisma:L4636`
- `PaymentEffect` → `schema.prisma:L18655`
- `PaymentLink` → `schema.prisma:L15276`
- `PaymentLinkAttribution` → `schema.prisma:L15384`
- `PaymentLinkItem` → `schema.prisma:L15339`
- `PaymentLinkItemModifier` → `schema.prisma:L15366`
- `PaymentProvider` → `schema.prisma:L5863`
- `PayrollLine` → `schema.prisma:L17777`
- `PayrollRun` → `schema.prisma:L17746`
- `PerformanceGoal` → `schema.prisma:L13352`
- `PermissionOverride` → `schema.prisma:L1451`
- `PermissionSet` → `schema.prisma:L1474`
- `PlatformAnnouncement` → `schema.prisma:L18445`
- `PlatformAnnouncementClick` → `schema.prisma:L18510`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18547`
- `PlatformCfdi` → `schema.prisma:L18074`
- `PlatformEmisor` → `schema.prisma:L18014`
- `PlatformSettings` → `schema.prisma:L6285`
- `PosCommand` → `schema.prisma:L9272`
- `PosConnectionStatus` → `schema.prisma:L996`
- `PosSyncIntent` → `schema.prisma:L18152`
- `PricingPolicy` → `schema.prisma:L2819`
- `Printer` → `schema.prisma:L15877`
- `PrintGateway` → `schema.prisma:L15934`
- `PrintJob` → `schema.prisma:L16657`
- `PrintStation` → `schema.prisma:L15952`
- `PrivacyNoticeVersion` → `schema.prisma:L7737`
- `ProcessedStripeEvent` → `schema.prisma:L6922`
- `ProcessorReliabilityMetric` → `schema.prisma:L7407`
- `Product` → `schema.prisma:L1798`
- `ProductModifierGroup` → `schema.prisma:L4300`
- `ProductOption` → `schema.prisma:L15582`
- `ProductOptionValue` → `schema.prisma:L15593`
- `ProductStaff` → `schema.prisma:L14232`
- `PromoterBankAccount` → `schema.prisma:L17897`
- `PromoterCommissionEntry` → `schema.prisma:L17916`
- `PromoterLocationPing` → `schema.prisma:L3752`
- `Promotion` → `schema.prisma:L18203`
- `PromotionGroup` → `schema.prisma:L18242`
- `PromotionOption` → `schema.prisma:L18258`
- `ProviderCostStructure` → `schema.prisma:L6958`
- `ProviderEventLog` → `schema.prisma:L6587`
- `PurchaseOrder` → `schema.prisma:L2544`
- `PurchaseOrderInvoice` → `schema.prisma:L2689`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2746`
- `PurchaseOrderItem` → `schema.prisma:L2602`
- `RateCorrectionBatch` → `schema.prisma:L7183`
- `RateCorrectionEntry` → `schema.prisma:L7225`
- `RawMaterial` → `schema.prisma:L2300`
- `RawMaterialMovement` → `schema.prisma:L2872`
- `RawMaterialPresentation` → `schema.prisma:L2376`
- `ReceiptLayout` → `schema.prisma:L18689`
- `Recipe` → `schema.prisma:L2396`
- `RecipeLine` → `schema.prisma:L2420`
- `Referral` → `schema.prisma:L8455`
- `ReferralProgramConfig` → `schema.prisma:L8420`
- `ReferralRewardGrant` → `schema.prisma:L8546`
- `ReferralTierReward` → `schema.prisma:L8518`
- `ReferralTierUnlock` → `schema.prisma:L8591`
- `RefreshGrant` → `schema.prisma:L18634`
- `Reservation` → `schema.prisma:L13995`
- `ReservationGoogleEventMapping` → `schema.prisma:L15049`
- `ReservationModifier` → `schema.prisma:L14180`
- `ReservationReminderSent` → `schema.prisma:L14163`
- `ReservationSettings` → `schema.prisma:L14398`
- `ReservationWaitlistEntry` → `schema.prisma:L14366`
- `Review` → `schema.prisma:L5233`
- `SalesRetention` → `schema.prisma:L17597`
- `SaleVerification` → `schema.prisma:L4690`
- `ScaleProfile` → `schema.prisma:L16398`
- `ScheduledCommand` → `schema.prisma:L10825`
- `SerializedItem` → `schema.prisma:L12475`
- `SerializedItemCustodyEvent` → `schema.prisma:L12642`
- `ServiceCharge` → `schema.prisma:L9060`
- `ServiceEarning` → `schema.prisma:L19058`
- `ServicePayPeriod` → `schema.prisma:L19034`
- `ServicePayTable` → `schema.prisma:L18947`
- `ServicePayTableCell` → `schema.prisma:L18984`
- `ServicePayTableVersion` → `schema.prisma:L18964`
- `Session` → `schema.prisma:L18613`
- `SettlementConfiguration` → `schema.prisma:L7258`
- `SettlementConfirmation` → `schema.prisma:L7371`
- `SettlementIncident` → `schema.prisma:L7322`
- `SettlementSimulation` → `schema.prisma:L7293`
- `Shift` → `schema.prisma:L3375`
- `SimRegistrationRequest` → `schema.prisma:L12680`
- `SimRegistrationRequestItem` → `schema.prisma:L12702`
- `SlotHold` → `schema.prisma:L14263`
- `Staff` → `schema.prisma:L1016`
- `StaffDocument` → `schema.prisma:L3623`
- `StaffOnboardingState` → `schema.prisma:L16728`
- `StaffOrganization` → `schema.prisma:L1350`
- `StaffPasskey` → `schema.prisma:L1377`
- `StaffPayLevel` → `schema.prisma:L18911`
- `StaffPayLevelAssignment` → `schema.prisma:L18929`
- `StaffPayStatement` → `schema.prisma:L19088`
- `StaffPayTipWindow` → `schema.prisma:L19104`
- `StaffSchedule` → `schema.prisma:L14203`
- `StaffScheduleException` → `schema.prisma:L14215`
- `StaffVenue` → `schema.prisma:L1274`
- `StaffWorkSchedule` → `schema.prisma:L3500`
- `StaffWorkScheduleException` → `schema.prisma:L3598`
- `StampCard` → `schema.prisma:L8303`
- `StampEvent` → `schema.prisma:L8342`
- `StampReward` → `schema.prisma:L8380`
- `StockAlertConfig` → `schema.prisma:L13334`
- `StockBatch` → `schema.prisma:L3038`
- `StockCount` → `schema.prisma:L2955`
- `StockCountItem` → `schema.prisma:L2983`
- `StripeWebhookEvent` → `schema.prisma:L6905`
- `Supplier` → `schema.prisma:L2455`
- `SupplierItemCode` → `schema.prisma:L2787`
- `SupplierPricing` → `schema.prisma:L2510`
- `Table` → `schema.prisma:L3287`
- `Terminal` → `schema.prisma:L5284`
- `TerminalAttemptResolution` → `schema.prisma:L5722`
- `TerminalHealth` → `schema.prisma:L5542`
- `TerminalLog` → `schema.prisma:L5516`
- `TerminalOrder` → `schema.prisma:L5766`
- `TerminalOrderItem` → `schema.prisma:L5841`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5694`
- `TerminalPaymentRequest` → `schema.prisma:L5613`
- `TimeEntry` → `schema.prisma:L3665`
- `TimeEntryBreak` → `schema.prisma:L3734`
- `TokenPurchase` → `schema.prisma:L10497`
- `TokenUsageRecord` → `schema.prisma:L10469`
- `TpvCommandHistory` → `schema.prisma:L10731`
- `TpvCommandQueue` → `schema.prisma:L10669`
- `TpvFeedback` → `schema.prisma:L10382`
- `TpvMessage` → `schema.prisma:L13691`
- `TpvMessageDelivery` → `schema.prisma:L13743`
- `TpvMessageResponse` → `schema.prisma:L13766`
- `TrainingModule` → `schema.prisma:L13821`
- `TrainingProgress` → `schema.prisma:L13898`
- `TrainingQuizQuestion` → `schema.prisma:L13880`
- `TrainingStep` → `schema.prisma:L13860`
- `TransactionCost` → `schema.prisma:L7121`
- `UnitConversion` → `schema.prisma:L2850`
- `UpsellAcceptance` → `schema.prisma:L8876`
- `UpsellAiRun` → `schema.prisma:L8896`
- `UpsellImpression` → `schema.prisma:L8836`
- `UpsellRule` → `schema.prisma:L8756`
- `user_sessions` → `schema.prisma:L6343`
- `Venue` → `schema.prisma:L177`
- `VenueAreaTicketSettings` → `schema.prisma:L16135`
- `VenueChatMessage` → `schema.prisma:L828`
- `VenueChatSession` → `schema.prisma:L783`
- `VenueCommission` → `schema.prisma:L15743`
- `VenueCreditAssessment` → `schema.prisma:L11213`
- `VenueCryptoConfig` → `schema.prisma:L13558`
- `VenueFeature` → `schema.prisma:L4804`
- `VenueIvaPorProducto` → `schema.prisma:L979`
- `VenueModule` → `schema.prisma:L11373`
- `VenuePaymentConfig` → `schema.prisma:L6444`
- `VenuePaymentLinkSettings` → `schema.prisma:L15082`
- `VenuePosSinAparato` → `schema.prisma:L990`
- `VenuePricingStructure` → `schema.prisma:L7061`
- `VenueRoleConfig` → `schema.prisma:L1503`
- `VenueRolePermission` → `schema.prisma:L1407`
- `VenueScaleSettings` → `schema.prisma:L16386`
- `VenueSettings` → `schema.prisma:L868`
- `VenueTenderType` → `schema.prisma:L4549`
- `VenueTenderTypeRevision` → `schema.prisma:L4614`
- `VenueTransaction` → `schema.prisma:L4741`
- `VenueWhatsappActivation` → `schema.prisma:L719`
- `WalletCardDesign` → `schema.prisma:L8221`
- `WalletPass` → `schema.prisma:L8122`
- `WalletPassRegistration` → `schema.prisma:L8188`
- `WebhookEvent` → `schema.prisma:L5142`
- `WebhookSubscription` → `schema.prisma:L6560`
- `WhatsappContactWindow` → `schema.prisma:L737`
- `WhatsappInboundEvent` → `schema.prisma:L757`
- `WorkShiftAssignment` → `schema.prisma:L3540`
- `WorkShiftTemplate` → `schema.prisma:L3517`
- `Zone` → `schema.prisma:L160`
