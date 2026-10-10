# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **420 models / 390 enums / ~19,500 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `FloorPlanPublication`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueIvaPorProducto`, `VenuePosSinAparato`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `CapabilityGrant`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `HybridBillingOperation`, `HybridCampaign`, `HybridContract`, `HybridContractSelection`, `HybridCreditAllocation`, `HybridOfferPublication`, `HybridPaymentPeriod`, `HybridPromotionGroup`, `HybridPurchase`, `HybridRedemption`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                               |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                                                                                                       |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `InventoryWasteReport`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `ShopifyConnectIntent`, `ShopifyImportIssue`, `ShopifyInboundEvent`, `ShopifyLocationLink`, `ShopifyReviewItem`, `ShopifyStockOutbox`, `ShopifyStore`, `ShopifyVariantLink`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`            |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryConnectIntent`, `DeliveryLineAction`, `DeliveryOrderEvent`, `DeliveryStoreRevocation`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                                                                                                      |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CfdiGlobalOrden`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `OrderItemSelloIva`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                                                                                                |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `ClassSessionPayState`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `ServiceEarning`, `ServicePayPeriod`, `ServicePayTable`, `ServicePayTableCell`, `ServicePayTableVersion`, `StaffPayLevel`, `StaffPayLevelAssignment`, `StaffPayStatement`, `StaffPayTipWindow`, `StaffPayVenueWindow`, `VenueCommission`                                                                                                                                                                                                    |
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

- `AccountingPeriodLock` → `schema.prisma:L17552`
- `AccountMapping` → `schema.prisma:L17447`
- `ActivityLog` → `schema.prisma:L7593`
- `Aggregator` → `schema.prisma:L15705`
- `AggregatorBooking` → `schema.prisma:L15013`
- `AggregatorCapacityRule` → `schema.prisma:L14994`
- `AggregatorConnection` → `schema.prisma:L14919`
- `AggregatorInboundEvent` → `schema.prisma:L15082`
- `AggregatorOutbox` → `schema.prisma:L15102`
- `AggregatorProductLink` → `schema.prisma:L14951`
- `AggregatorSessionLink` → `schema.prisma:L14970`
- `AggregatorVisit` → `schema.prisma:L15039`
- `AngelPayUserAccount` → `schema.prisma:L6138`
- `AppUpdate` → `schema.prisma:L13580`
- `Area` → `schema.prisma:L3301`
- `AreaTicket` → `schema.prisma:L16254`
- `AreaTicketCheckoutSession` → `schema.prisma:L16376`
- `AreaTicketExternalIncident` → `schema.prisma:L16623`
- `AreaTicketExternalSettlement` → `schema.prisma:L16588`
- `AreaTicketFulfillment` → `schema.prisma:L16452`
- `AreaTicketInventoryReservation` → `schema.prisma:L16347`
- `AreaTicketLine` → `schema.prisma:L16315`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16408`
- `AreaTicketPrintAttempt` → `schema.prisma:L16431`
- `BankStatement` → `schema.prisma:L17321`
- `BankStatementLine` → `schema.prisma:L17342`
- `BillingObligationConflict` → `schema.prisma:L5168`
- `BillingTaxProfile` → `schema.prisma:L18144`
- `BirthdayAutomation` → `schema.prisma:L7917`
- `BulkCommandOperation` → `schema.prisma:L10852`
- `CalendarSyncOutbox` → `schema.prisma:L14802`
- `CampaignDelivery` → `schema.prisma:L13738`
- `CapabilityGrant` → `schema.prisma:L4908`
- `CashCloseout` → `schema.prisma:L11237`
- `CashDeposit` → `schema.prisma:L13382`
- `CashDrawerEvent` → `schema.prisma:L15542`
- `CashDrawerSession` → `schema.prisma:L15503`
- `CashOutCommissionRate` → `schema.prisma:L17961`
- `CashOutScheduleDay` → `schema.prisma:L17984`
- `CashOutWithdrawal` → `schema.prisma:L18046`
- `CatalogBindingBatch` → `schema.prisma:L12268`
- `CatalogBindingLine` → `schema.prisma:L12304`
- `CatalogBrand` → `schema.prisma:L11721`
- `CatalogClientObservation` → `schema.prisma:L12034`
- `CatalogClientReadinessOverride` → `schema.prisma:L12053`
- `CatalogFamily` → `schema.prisma:L11771`
- `CatalogIdempotencyRecord` → `schema.prisma:L12167`
- `CatalogIdentifier` → `schema.prisma:L11902`
- `CatalogImportBatch` → `schema.prisma:L12210`
- `CatalogImportLine` → `schema.prisma:L12247`
- `CatalogItem` → `schema.prisma:L11804`
- `CatalogItemBusinessType` → `schema.prisma:L11864`
- `CatalogItemPrice` → `schema.prisma:L11952`
- `CatalogManufacturer` → `schema.prisma:L11745`
- `CatalogProductTypeMapping` → `schema.prisma:L11881`
- `CatalogPublicationBatch` → `schema.prisma:L12332`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12426`
- `CatalogPublicationLine` → `schema.prisma:L12373`
- `CatalogPublicationOutbox` → `schema.prisma:L12469`
- `CatalogValidationProfile` → `schema.prisma:L11923`
- `CatalogVenueBinding` → `schema.prisma:L12081`
- `CatalogVenueClientRequirement` → `schema.prisma:L12008`
- `CatalogVenueEventSequence` → `schema.prisma:L12452`
- `CatalogVenueOverride` → `schema.prisma:L12123`
- `CatalogVenueRollout` → `schema.prisma:L11983`
- `Cfdi` → `schema.prisma:L17149`
- `CfdiGlobalOrden` → `schema.prisma:L17274`
- `ChatbotTokenBudget` → `schema.prisma:L10498`
- `ChatConversation` → `schema.prisma:L10353`
- `ChatFeedback` → `schema.prisma:L10439`
- `ChatLearningEvent` → `schema.prisma:L10396`
- `ChatMessage` → `schema.prisma:L10376`
- `ChatTrainingData` → `schema.prisma:L10310`
- `CheckoutSession` → `schema.prisma:L6418`
- `ClassSession` → `schema.prisma:L14396`
- `ClassSessionPayState` → `schema.prisma:L19104`
- `CommissionCalculation` → `schema.prisma:L13157`
- `CommissionClawback` → `schema.prisma:L13334`
- `CommissionConfig` → `schema.prisma:L12916`
- `CommissionMilestone` → `schema.prisma:L13073`
- `CommissionOverride` → `schema.prisma:L13000`
- `CommissionPayout` → `schema.prisma:L13285`
- `CommissionSummary` → `schema.prisma:L13224`
- `CommissionTier` → `schema.prisma:L13037`
- `ConsentEvent` → `schema.prisma:L7779`
- `Consumer` → `schema.prisma:L8009`
- `ConsumerAuthAccount` → `schema.prisma:L8034`
- `CouponCode` → `schema.prisma:L8981`
- `CouponRedemption` → `schema.prisma:L9012`
- `CreditAssessmentHistory` → `schema.prisma:L11346`
- `CreditItemBalance` → `schema.prisma:L15293`
- `CreditOffer` → `schema.prisma:L11365`
- `CreditPack` → `schema.prisma:L15202`
- `CreditPackItem` → `schema.prisma:L15231`
- `CreditPackPurchase` → `schema.prisma:L15248`
- `CreditTransaction` → `schema.prisma:L15315`
- `Customer` → `schema.prisma:L7634`
- `CustomerApprovalDelivery` → `schema.prisma:L10011`
- `CustomerApprovalOutbox` → `schema.prisma:L9986`
- `CustomerCampaign` → `schema.prisma:L7867`
- `CustomerCampaignDelivery` → `schema.prisma:L7949`
- `CustomerCaptureToken` → `schema.prisma:L7815`
- `CustomerDiscount` → `schema.prisma:L9032`
- `CustomerExternalIdentity` → `schema.prisma:L15069`
- `CustomerGroup` → `schema.prisma:L8073`
- `CustomerOrderMetric` → `schema.prisma:L4122`
- `CustomerTaxProfile` → `schema.prisma:L17293`
- `DeliveryActivationRequest` → `schema.prisma:L6877`
- `DeliveryChannelLink` → `schema.prisma:L6716`
- `DeliveryConnectIntent` → `schema.prisma:L6828`
- `DeliveryLineAction` → `schema.prisma:L6789`
- `DeliveryOrderEvent` → `schema.prisma:L6901`
- `DeliveryStoreRevocation` → `schema.prisma:L6865`
- `DeviceToken` → `schema.prisma:L9306`
- `DigitalReceipt` → `schema.prisma:L4721`
- `Discount` → `schema.prisma:L8671`
- `EcommerceMerchant` → `schema.prisma:L6230`
- `EmailQuotaLedger` → `schema.prisma:L7996`
- `EmailSuppression` → `schema.prisma:L7984`
- `EmailTemplate` → `schema.prisma:L13677`
- `Employee` → `schema.prisma:L17809`
- `Estimate` → `schema.prisma:L15612`
- `EstimateItem` → `schema.prisma:L15640`
- `Expense` → `schema.prisma:L17596`
- `ExternalBusyBlock` → `schema.prisma:L14695`
- `Feature` → `schema.prisma:L4850`
- `FeeSchedule` → `schema.prisma:L5230`
- `FeeTier` → `schema.prisma:L5241`
- `FinancialAccount` → `schema.prisma:L15802`
- `FinancialConnection` → `schema.prisma:L15771`
- `FinancialProvider` → `schema.prisma:L15757`
- `FiscalEmisor` → `schema.prisma:L17060`
- `FiscalLossCarryforward` → `schema.prisma:L17719`
- `FixedAsset` → `schema.prisma:L17737`
- `FixedAssetDepreciation` → `schema.prisma:L17766`
- `FloorElement` → `schema.prisma:L3382`
- `FloorPlanPublication` → `schema.prisma:L3422`
- `FulfillmentArea` → `schema.prisma:L16119`
- `GeofenceRule` → `schema.prisma:L10937`
- `GoogleCalendarChannel` → `schema.prisma:L14672`
- `GoogleCalendarConnection` → `schema.prisma:L14624`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14725`
- `GoogleOAuthSession` → `schema.prisma:L14747`
- `HolidayCalendar` → `schema.prisma:L7517`
- `HybridBillingOperation` → `schema.prisma:L5092`
- `HybridCampaign` → `schema.prisma:L4933`
- `HybridContract` → `schema.prisma:L5049`
- `HybridContractSelection` → `schema.prisma:L5081`
- `HybridCreditAllocation` → `schema.prisma:L5148`
- `HybridOfferPublication` → `schema.prisma:L4996`
- `HybridPaymentPeriod` → `schema.prisma:L5127`
- `HybridPromotionGroup` → `schema.prisma:L4977`
- `HybridPurchase` → `schema.prisma:L5016`
- `HybridRedemption` → `schema.prisma:L5110`
- `IdempotencyRequest` → `schema.prisma:L12791`
- `InterVenueTransfer` → `schema.prisma:L3129`
- `InterVenueTransferAllocation` → `schema.prisma:L3212`
- `InterVenueTransferItem` → `schema.prisma:L3181`
- `InterVenueTransferReceipt` → `schema.prisma:L3239`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3255`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3283`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3267`
- `Inventory` → `schema.prisma:L2051`
- `InventoryMovement` → `schema.prisma:L2151`
- `InventoryPosting` → `schema.prisma:L2246`
- `InventoryPostingLine` → `schema.prisma:L2286`
- `InventoryTransfer` → `schema.prisma:L15584`
- `InventoryWasteReport` → `schema.prisma:L2106`
- `Invitation` → `schema.prisma:L1543`
- `Invoice` → `schema.prisma:L5253`
- `InvoiceItem` → `schema.prisma:L5279`
- `ItemCategory` → `schema.prisma:L12504`
- `JournalEntry` → `schema.prisma:L17505`
- `JournalLine` → `schema.prisma:L17534`
- `KdsOrder` → `schema.prisma:L15850`
- `KdsOrderItem` → `schema.prisma:L15917`
- `KioskCheckInAttempt` → `schema.prisma:L18467`
- `KioskCheckInChallenge` → `schema.prisma:L18421`
- `KioskOutreachOutbox` → `schema.prisma:L18488`
- `LaunchCampaign` → `schema.prisma:L18826`
- `LaunchCampaignRedemption` → `schema.prisma:L18943`
- `LearnedPatterns` → `schema.prisma:L10420`
- `LedgerAccount` → `schema.prisma:L17397`
- `LiveDemoSession` → `schema.prisma:L864`
- `LowStockAlert` → `schema.prisma:L2959`
- `LoyaltyConfig` → `schema.prisma:L8103`
- `LoyaltyTransaction` → `schema.prisma:L8146`
- `MarketingCampaign` → `schema.prisma:L13695`
- `McpAuthCode` → `schema.prisma:L16942`
- `McpOAuthClient` → `schema.prisma:L16926`
- `McpRefreshToken` → `schema.prisma:L16960`
- `McpToolCall` → `schema.prisma:L16982`
- `MeasurementUnit` → `schema.prisma:L15690`
- `Menu` → `schema.prisma:L1761`
- `MenuCategory` → `schema.prisma:L1698`
- `MenuCategoryAssignment` → `schema.prisma:L1796`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16856`
- `MerchantAccount` → `schema.prisma:L5968`
- `MerchantFiscalConfig` → `schema.prisma:L17120`
- `MerchantRevenueShare` → `schema.prisma:L7097`
- `MerchantRoutingRule` → `schema.prisma:L6090`
- `MilestoneAchievement` → `schema.prisma:L13118`
- `Modifier` → `schema.prisma:L4323`
- `ModifierGroup` → `schema.prisma:L4287`
- `Module` → `schema.prisma:L11413`
- `MoneyAnomaly` → `schema.prisma:L7000`
- `MonthlyVenueProfit` → `schema.prisma:L7543`
- `Notification` → `schema.prisma:L9208`
- `NotificationPreference` → `schema.prisma:L9255`
- `NotificationTemplate` → `schema.prisma:L9282`
- `OAuthState` → `schema.prisma:L1594`
- `OnboardingProgress` → `schema.prisma:L1612`
- `Order` → `schema.prisma:L3848`
- `OrderAction` → `schema.prisma:L4394`
- `OrderCustomer` → `schema.prisma:L4101`
- `OrderDiscount` → `schema.prisma:L9064`
- `OrderFulfillment` → `schema.prisma:L16174`
- `OrderFulfillmentLine` → `schema.prisma:L16205`
- `OrderItem` → `schema.prisma:L4137`
- `OrderItemModifier` → `schema.prisma:L4376`
- `OrderItemSelloIva` → `schema.prisma:L17254`
- `OrderPromotion` → `schema.prisma:L18384`
- `OrderServiceCharge` → `schema.prisma:L9153`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13496`
- `OrganizationEntitlement` → `schema.prisma:L11696`
- `OrganizationGoal` → `schema.prisma:L13454`
- `OrganizationModule` → `schema.prisma:L11473`
- `OrganizationPaymentConfig` → `schema.prisma:L6542`
- `OrganizationPayoutConfig` → `schema.prisma:L13529`
- `OrganizationPricingStructure` → `schema.prisma:L6574`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13477`
- `OtpChallenge` → `schema.prisma:L8053`
- `OvertimeApproval` → `schema.prisma:L3626`
- `PartnerAPIKey` → `schema.prisma:L6372`
- `Payment` → `schema.prisma:L4427`
- `PaymentAllocation` → `schema.prisma:L4700`
- `PaymentEffect` → `schema.prisma:L18758`
- `PaymentLink` → `schema.prisma:L15361`
- `PaymentLinkAttribution` → `schema.prisma:L15469`
- `PaymentLinkItem` → `schema.prisma:L15424`
- `PaymentLinkItemModifier` → `schema.prisma:L15451`
- `PaymentProvider` → `schema.prisma:L5927`
- `PayrollLine` → `schema.prisma:L17880`
- `PayrollRun` → `schema.prisma:L17849`
- `PerformanceGoal` → `schema.prisma:L13431`
- `PermissionOverride` → `schema.prisma:L1467`
- `PermissionSet` → `schema.prisma:L1490`
- `PlatformAnnouncement` → `schema.prisma:L18548`
- `PlatformAnnouncementClick` → `schema.prisma:L18613`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18650`
- `PlatformCfdi` → `schema.prisma:L18177`
- `PlatformEmisor` → `schema.prisma:L18117`
- `PlatformSettings` → `schema.prisma:L6349`
- `PosCommand` → `schema.prisma:L9336`
- `PosConnectionStatus` → `schema.prisma:L1012`
- `PosSyncIntent` → `schema.prisma:L18255`
- `PricingPolicy` → `schema.prisma:L2855`
- `Printer` → `schema.prisma:L15975`
- `PrintGateway` → `schema.prisma:L16032`
- `PrintJob` → `schema.prisma:L16755`
- `PrintStation` → `schema.prisma:L16050`
- `PrivacyNoticeVersion` → `schema.prisma:L7801`
- `ProcessedStripeEvent` → `schema.prisma:L6986`
- `ProcessorReliabilityMetric` → `schema.prisma:L7471`
- `Product` → `schema.prisma:L1814`
- `ProductModifierGroup` → `schema.prisma:L4364`
- `ProductOption` → `schema.prisma:L15667`
- `ProductOptionValue` → `schema.prisma:L15678`
- `ProductStaff` → `schema.prisma:L14311`
- `PromoterBankAccount` → `schema.prisma:L18000`
- `PromoterCommissionEntry` → `schema.prisma:L18019`
- `PromoterLocationPing` → `schema.prisma:L3814`
- `Promotion` → `schema.prisma:L18306`
- `PromotionGroup` → `schema.prisma:L18345`
- `PromotionOption` → `schema.prisma:L18361`
- `ProviderCostStructure` → `schema.prisma:L7022`
- `ProviderEventLog` → `schema.prisma:L6651`
- `PurchaseOrder` → `schema.prisma:L2562`
- `PurchaseOrderInvoice` → `schema.prisma:L2707`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2774`
- `PurchaseOrderItem` → `schema.prisma:L2620`
- `RateCorrectionBatch` → `schema.prisma:L7247`
- `RateCorrectionEntry` → `schema.prisma:L7289`
- `RawMaterial` → `schema.prisma:L2318`
- `RawMaterialMovement` → `schema.prisma:L2908`
- `RawMaterialPresentation` → `schema.prisma:L2394`
- `ReceiptLayout` → `schema.prisma:L18792`
- `Recipe` → `schema.prisma:L2414`
- `RecipeLine` → `schema.prisma:L2438`
- `Referral` → `schema.prisma:L8519`
- `ReferralProgramConfig` → `schema.prisma:L8484`
- `ReferralRewardGrant` → `schema.prisma:L8610`
- `ReferralTierReward` → `schema.prisma:L8582`
- `ReferralTierUnlock` → `schema.prisma:L8655`
- `RefreshGrant` → `schema.prisma:L18737`
- `Reservation` → `schema.prisma:L14074`
- `ReservationGoogleEventMapping` → `schema.prisma:L15134`
- `ReservationModifier` → `schema.prisma:L14259`
- `ReservationReminderSent` → `schema.prisma:L14242`
- `ReservationSettings` → `schema.prisma:L14483`
- `ReservationWaitlistEntry` → `schema.prisma:L14451`
- `Review` → `schema.prisma:L5297`
- `SalesRetention` → `schema.prisma:L17700`
- `SaleVerification` → `schema.prisma:L4754`
- `ScaleProfile` → `schema.prisma:L16496`
- `ScheduledCommand` → `schema.prisma:L10897`
- `SerializedItem` → `schema.prisma:L12547`
- `SerializedItemCustodyEvent` → `schema.prisma:L12714`
- `ServiceCharge` → `schema.prisma:L9124`
- `ServiceEarning` → `schema.prisma:L19166`
- `ServicePayPeriod` → `schema.prisma:L19142`
- `ServicePayTable` → `schema.prisma:L19050`
- `ServicePayTableCell` → `schema.prisma:L19092`
- `ServicePayTableVersion` → `schema.prisma:L19067`
- `Session` → `schema.prisma:L18716`
- `SettlementConfiguration` → `schema.prisma:L7322`
- `SettlementConfirmation` → `schema.prisma:L7435`
- `SettlementIncident` → `schema.prisma:L7386`
- `SettlementSimulation` → `schema.prisma:L7357`
- `Shift` → `schema.prisma:L3437`
- `ShopifyConnectIntent` → `schema.prisma:L19468`
- `ShopifyImportIssue` → `schema.prisma:L19515`
- `ShopifyInboundEvent` → `schema.prisma:L19445`
- `ShopifyLocationLink` → `schema.prisma:L19328`
- `ShopifyReviewItem` → `schema.prisma:L19486`
- `ShopifyStockOutbox` → `schema.prisma:L19415`
- `ShopifyStore` → `schema.prisma:L19306`
- `ShopifyVariantLink` → `schema.prisma:L19376`
- `SimRegistrationRequest` → `schema.prisma:L12752`
- `SimRegistrationRequestItem` → `schema.prisma:L12774`
- `SlotHold` → `schema.prisma:L14342`
- `Staff` → `schema.prisma:L1032`
- `StaffDocument` → `schema.prisma:L3685`
- `StaffOnboardingState` → `schema.prisma:L16826`
- `StaffOrganization` → `schema.prisma:L1366`
- `StaffPasskey` → `schema.prisma:L1393`
- `StaffPayLevel` → `schema.prisma:L19014`
- `StaffPayLevelAssignment` → `schema.prisma:L19032`
- `StaffPayStatement` → `schema.prisma:L19198`
- `StaffPayTipWindow` → `schema.prisma:L19534`
- `StaffPayVenueWindow` → `schema.prisma:L19551`
- `StaffSchedule` → `schema.prisma:L14282`
- `StaffScheduleException` → `schema.prisma:L14294`
- `StaffVenue` → `schema.prisma:L1290`
- `StaffWorkSchedule` → `schema.prisma:L3562`
- `StaffWorkScheduleException` → `schema.prisma:L3660`
- `StampCard` → `schema.prisma:L8367`
- `StampEvent` → `schema.prisma:L8406`
- `StampReward` → `schema.prisma:L8444`
- `StockAlertConfig` → `schema.prisma:L13413`
- `StockBatch` → `schema.prisma:L3078`
- `StockCount` → `schema.prisma:L2991`
- `StockCountItem` → `schema.prisma:L3019`
- `StripeWebhookEvent` → `schema.prisma:L6969`
- `Supplier` → `schema.prisma:L2473`
- `SupplierItemCode` → `schema.prisma:L2818`
- `SupplierPricing` → `schema.prisma:L2528`
- `Table` → `schema.prisma:L3332`
- `Terminal` → `schema.prisma:L5348`
- `TerminalAttemptResolution` → `schema.prisma:L5786`
- `TerminalHealth` → `schema.prisma:L5606`
- `TerminalLog` → `schema.prisma:L5580`
- `TerminalOrder` → `schema.prisma:L5830`
- `TerminalOrderItem` → `schema.prisma:L5905`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5758`
- `TerminalPaymentRequest` → `schema.prisma:L5677`
- `TimeEntry` → `schema.prisma:L3727`
- `TimeEntryBreak` → `schema.prisma:L3796`
- `TokenPurchase` → `schema.prisma:L10569`
- `TokenUsageRecord` → `schema.prisma:L10541`
- `TpvCommandHistory` → `schema.prisma:L10803`
- `TpvCommandQueue` → `schema.prisma:L10741`
- `TpvFeedback` → `schema.prisma:L10454`
- `TpvMessage` → `schema.prisma:L13770`
- `TpvMessageDelivery` → `schema.prisma:L13822`
- `TpvMessageResponse` → `schema.prisma:L13845`
- `TrainingModule` → `schema.prisma:L13900`
- `TrainingProgress` → `schema.prisma:L13977`
- `TrainingQuizQuestion` → `schema.prisma:L13959`
- `TrainingStep` → `schema.prisma:L13939`
- `TransactionCost` → `schema.prisma:L7185`
- `UnitConversion` → `schema.prisma:L2886`
- `UpsellAcceptance` → `schema.prisma:L8940`
- `UpsellAiRun` → `schema.prisma:L8960`
- `UpsellImpression` → `schema.prisma:L8900`
- `UpsellRule` → `schema.prisma:L8820`
- `user_sessions` → `schema.prisma:L6407`
- `Venue` → `schema.prisma:L185`
- `VenueAreaTicketSettings` → `schema.prisma:L16233`
- `VenueChatMessage` → `schema.prisma:L840`
- `VenueChatSession` → `schema.prisma:L795`
- `VenueCommission` → `schema.prisma:L15828`
- `VenueCreditAssessment` → `schema.prisma:L11285`
- `VenueCryptoConfig` → `schema.prisma:L13637`
- `VenueFeature` → `schema.prisma:L4868`
- `VenueIvaPorProducto` → `schema.prisma:L995`
- `VenueModule` → `schema.prisma:L11445`
- `VenuePaymentConfig` → `schema.prisma:L6508`
- `VenuePaymentLinkSettings` → `schema.prisma:L15167`
- `VenuePosSinAparato` → `schema.prisma:L1006`
- `VenuePricingStructure` → `schema.prisma:L7125`
- `VenueRoleConfig` → `schema.prisma:L1519`
- `VenueRolePermission` → `schema.prisma:L1423`
- `VenueScaleSettings` → `schema.prisma:L16484`
- `VenueSettings` → `schema.prisma:L880`
- `VenueTenderType` → `schema.prisma:L4613`
- `VenueTenderTypeRevision` → `schema.prisma:L4678`
- `VenueTransaction` → `schema.prisma:L4805`
- `VenueWhatsappActivation` → `schema.prisma:L731`
- `WalletCardDesign` → `schema.prisma:L8285`
- `WalletPass` → `schema.prisma:L8186`
- `WalletPassRegistration` → `schema.prisma:L8252`
- `WebhookEvent` → `schema.prisma:L5206`
- `WebhookSubscription` → `schema.prisma:L6624`
- `WhatsappContactWindow` → `schema.prisma:L749`
- `WhatsappInboundEvent` → `schema.prisma:L769`
- `WorkShiftAssignment` → `schema.prisma:L3602`
- `WorkShiftTemplate` → `schema.prisma:L3579`
- `Zone` → `schema.prisma:L168`
