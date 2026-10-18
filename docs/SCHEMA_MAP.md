# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **427 models / 395 enums / ~19,800 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `FloorPlanPublication`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueIvaPorProducto`, `VenuePosSinAparato`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `CapabilityGrant`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `HybridBillingOperation`, `HybridCampaign`, `HybridContract`, `HybridContractSelection`, `HybridCreditAllocation`, `HybridOfferPublication`, `HybridPaymentPeriod`, `HybridPromotionGroup`, `HybridPurchase`, `HybridRedemption`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                        |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffAssignment`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffPosition`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                                                                                                        |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `DocumentRequest`, `DocumentRequestDelivery`, `DocumentRequestFile`, `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                                                                                                                                                |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `InventoryWasteReport`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `ShopifyConnectIntent`, `ShopifyImportIssue`, `ShopifyInboundEvent`, `ShopifyLocationLink`, `ShopifyReviewItem`, `ShopifyStockOutbox`, `ShopifyStore`, `ShopifyVariantLink`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                     |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryConnectIntent`, `DeliveryLineAction`, `DeliveryOrderEvent`, `DeliveryStoreRevocation`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `OnlineOrder`, `OnlineOrderingSettings`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                                                                                                                                               |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CfdiGlobalOrden`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `OrderItemSelloIva`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                                                                                                                                         |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `ClassSessionPayState`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `ServiceEarning`, `ServicePayPeriod`, `ServicePayTable`, `ServicePayTableCell`, `ServicePayTableVersion`, `StaffPayLevel`, `StaffPayLevelAssignment`, `StaffPayStatement`, `StaffPayTipWindow`, `StaffPayVenueWindow`, `VenueCommission`                                                                                                                                                                                                                                             |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `AggregatorBooking`, `AggregatorCapacityRule`, `AggregatorConnection`, `AggregatorInboundEvent`, `AggregatorOutbox`, `AggregatorProductLink`, `AggregatorSessionLink`, `AggregatorVisit`, `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                          |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalAttemptResolution`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerExternalIdentity`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L17640`
- `AccountMapping` → `schema.prisma:L17535`
- `ActivityLog` → `schema.prisma:L7674`
- `Aggregator` → `schema.prisma:L15786`
- `AggregatorBooking` → `schema.prisma:L15094`
- `AggregatorCapacityRule` → `schema.prisma:L15075`
- `AggregatorConnection` → `schema.prisma:L15000`
- `AggregatorInboundEvent` → `schema.prisma:L15163`
- `AggregatorOutbox` → `schema.prisma:L15183`
- `AggregatorProductLink` → `schema.prisma:L15032`
- `AggregatorSessionLink` → `schema.prisma:L15051`
- `AggregatorVisit` → `schema.prisma:L15120`
- `AngelPayUserAccount` → `schema.prisma:L6215`
- `AppUpdate` → `schema.prisma:L13661`
- `Area` → `schema.prisma:L3310`
- `AreaTicket` → `schema.prisma:L16335`
- `AreaTicketCheckoutSession` → `schema.prisma:L16457`
- `AreaTicketExternalIncident` → `schema.prisma:L16704`
- `AreaTicketExternalSettlement` → `schema.prisma:L16669`
- `AreaTicketFulfillment` → `schema.prisma:L16533`
- `AreaTicketInventoryReservation` → `schema.prisma:L16428`
- `AreaTicketLine` → `schema.prisma:L16396`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16489`
- `AreaTicketPrintAttempt` → `schema.prisma:L16512`
- `BankStatement` → `schema.prisma:L17409`
- `BankStatementLine` → `schema.prisma:L17430`
- `BillingObligationConflict` → `schema.prisma:L5245`
- `BillingTaxProfile` → `schema.prisma:L18232`
- `BirthdayAutomation` → `schema.prisma:L7998`
- `BulkCommandOperation` → `schema.prisma:L10933`
- `CalendarSyncOutbox` → `schema.prisma:L14883`
- `CampaignDelivery` → `schema.prisma:L13819`
- `CapabilityGrant` → `schema.prisma:L4985`
- `CashCloseout` → `schema.prisma:L11318`
- `CashDeposit` → `schema.prisma:L13463`
- `CashDrawerEvent` → `schema.prisma:L15623`
- `CashDrawerSession` → `schema.prisma:L15584`
- `CashOutCommissionRate` → `schema.prisma:L18049`
- `CashOutScheduleDay` → `schema.prisma:L18072`
- `CashOutWithdrawal` → `schema.prisma:L18134`
- `CatalogBindingBatch` → `schema.prisma:L12349`
- `CatalogBindingLine` → `schema.prisma:L12385`
- `CatalogBrand` → `schema.prisma:L11802`
- `CatalogClientObservation` → `schema.prisma:L12115`
- `CatalogClientReadinessOverride` → `schema.prisma:L12134`
- `CatalogFamily` → `schema.prisma:L11852`
- `CatalogIdempotencyRecord` → `schema.prisma:L12248`
- `CatalogIdentifier` → `schema.prisma:L11983`
- `CatalogImportBatch` → `schema.prisma:L12291`
- `CatalogImportLine` → `schema.prisma:L12328`
- `CatalogItem` → `schema.prisma:L11885`
- `CatalogItemBusinessType` → `schema.prisma:L11945`
- `CatalogItemPrice` → `schema.prisma:L12033`
- `CatalogManufacturer` → `schema.prisma:L11826`
- `CatalogProductTypeMapping` → `schema.prisma:L11962`
- `CatalogPublicationBatch` → `schema.prisma:L12413`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12507`
- `CatalogPublicationLine` → `schema.prisma:L12454`
- `CatalogPublicationOutbox` → `schema.prisma:L12550`
- `CatalogValidationProfile` → `schema.prisma:L12004`
- `CatalogVenueBinding` → `schema.prisma:L12162`
- `CatalogVenueClientRequirement` → `schema.prisma:L12089`
- `CatalogVenueEventSequence` → `schema.prisma:L12533`
- `CatalogVenueOverride` → `schema.prisma:L12204`
- `CatalogVenueRollout` → `schema.prisma:L12064`
- `Cfdi` → `schema.prisma:L17231`
- `CfdiGlobalOrden` → `schema.prisma:L17362`
- `ChatbotTokenBudget` → `schema.prisma:L10579`
- `ChatConversation` → `schema.prisma:L10434`
- `ChatFeedback` → `schema.prisma:L10520`
- `ChatLearningEvent` → `schema.prisma:L10477`
- `ChatMessage` → `schema.prisma:L10457`
- `ChatTrainingData` → `schema.prisma:L10391`
- `CheckoutSession` → `schema.prisma:L6495`
- `ClassSession` → `schema.prisma:L14477`
- `ClassSessionPayState` → `schema.prisma:L19192`
- `CommissionCalculation` → `schema.prisma:L13238`
- `CommissionClawback` → `schema.prisma:L13415`
- `CommissionConfig` → `schema.prisma:L12997`
- `CommissionMilestone` → `schema.prisma:L13154`
- `CommissionOverride` → `schema.prisma:L13081`
- `CommissionPayout` → `schema.prisma:L13366`
- `CommissionSummary` → `schema.prisma:L13305`
- `CommissionTier` → `schema.prisma:L13118`
- `ConsentEvent` → `schema.prisma:L7860`
- `Consumer` → `schema.prisma:L8090`
- `ConsumerAuthAccount` → `schema.prisma:L8115`
- `CouponCode` → `schema.prisma:L9062`
- `CouponRedemption` → `schema.prisma:L9093`
- `CreditAssessmentHistory` → `schema.prisma:L11427`
- `CreditItemBalance` → `schema.prisma:L15374`
- `CreditOffer` → `schema.prisma:L11446`
- `CreditPack` → `schema.prisma:L15283`
- `CreditPackItem` → `schema.prisma:L15312`
- `CreditPackPurchase` → `schema.prisma:L15329`
- `CreditTransaction` → `schema.prisma:L15396`
- `Customer` → `schema.prisma:L7715`
- `CustomerApprovalDelivery` → `schema.prisma:L10092`
- `CustomerApprovalOutbox` → `schema.prisma:L10067`
- `CustomerCampaign` → `schema.prisma:L7948`
- `CustomerCampaignDelivery` → `schema.prisma:L8030`
- `CustomerCaptureToken` → `schema.prisma:L7896`
- `CustomerDiscount` → `schema.prisma:L9113`
- `CustomerExternalIdentity` → `schema.prisma:L15150`
- `CustomerGroup` → `schema.prisma:L8154`
- `CustomerOrderMetric` → `schema.prisma:L4199`
- `CustomerTaxProfile` → `schema.prisma:L17381`
- `DeliveryActivationRequest` → `schema.prisma:L6954`
- `DeliveryChannelLink` → `schema.prisma:L6793`
- `DeliveryConnectIntent` → `schema.prisma:L6905`
- `DeliveryLineAction` → `schema.prisma:L6866`
- `DeliveryOrderEvent` → `schema.prisma:L6978`
- `DeliveryStoreRevocation` → `schema.prisma:L6942`
- `DeviceToken` → `schema.prisma:L9387`
- `DigitalReceipt` → `schema.prisma:L4798`
- `Discount` → `schema.prisma:L8752`
- `DocumentRequest` → `schema.prisma:L19783`
- `DocumentRequestDelivery` → `schema.prisma:L19840`
- `DocumentRequestFile` → `schema.prisma:L19819`
- `EcommerceMerchant` → `schema.prisma:L6307`
- `EmailQuotaLedger` → `schema.prisma:L8077`
- `EmailSuppression` → `schema.prisma:L8065`
- `EmailTemplate` → `schema.prisma:L13758`
- `Employee` → `schema.prisma:L17897`
- `Estimate` → `schema.prisma:L15693`
- `EstimateItem` → `schema.prisma:L15721`
- `Expense` → `schema.prisma:L17684`
- `ExternalBusyBlock` → `schema.prisma:L14776`
- `Feature` → `schema.prisma:L4927`
- `FeeSchedule` → `schema.prisma:L5307`
- `FeeTier` → `schema.prisma:L5318`
- `FinancialAccount` → `schema.prisma:L15883`
- `FinancialConnection` → `schema.prisma:L15852`
- `FinancialProvider` → `schema.prisma:L15838`
- `FiscalEmisor` → `schema.prisma:L17142`
- `FiscalLossCarryforward` → `schema.prisma:L17807`
- `FixedAsset` → `schema.prisma:L17825`
- `FixedAssetDepreciation` → `schema.prisma:L17854`
- `FloorElement` → `schema.prisma:L3395`
- `FloorPlanPublication` → `schema.prisma:L3435`
- `FulfillmentArea` → `schema.prisma:L16200`
- `GeofenceRule` → `schema.prisma:L11018`
- `GoogleCalendarChannel` → `schema.prisma:L14753`
- `GoogleCalendarConnection` → `schema.prisma:L14705`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14806`
- `GoogleOAuthSession` → `schema.prisma:L14828`
- `HolidayCalendar` → `schema.prisma:L7598`
- `HybridBillingOperation` → `schema.prisma:L5169`
- `HybridCampaign` → `schema.prisma:L5010`
- `HybridContract` → `schema.prisma:L5126`
- `HybridContractSelection` → `schema.prisma:L5158`
- `HybridCreditAllocation` → `schema.prisma:L5225`
- `HybridOfferPublication` → `schema.prisma:L5073`
- `HybridPaymentPeriod` → `schema.prisma:L5204`
- `HybridPromotionGroup` → `schema.prisma:L5054`
- `HybridPurchase` → `schema.prisma:L5093`
- `HybridRedemption` → `schema.prisma:L5187`
- `IdempotencyRequest` → `schema.prisma:L12872`
- `InterVenueTransfer` → `schema.prisma:L3138`
- `InterVenueTransferAllocation` → `schema.prisma:L3221`
- `InterVenueTransferItem` → `schema.prisma:L3190`
- `InterVenueTransferReceipt` → `schema.prisma:L3248`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3264`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3292`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3276`
- `Inventory` → `schema.prisma:L2060`
- `InventoryMovement` → `schema.prisma:L2160`
- `InventoryPosting` → `schema.prisma:L2255`
- `InventoryPostingLine` → `schema.prisma:L2295`
- `InventoryTransfer` → `schema.prisma:L15665`
- `InventoryWasteReport` → `schema.prisma:L2115`
- `Invitation` → `schema.prisma:L1550`
- `Invoice` → `schema.prisma:L5330`
- `InvoiceItem` → `schema.prisma:L5356`
- `ItemCategory` → `schema.prisma:L12585`
- `JournalEntry` → `schema.prisma:L17593`
- `JournalLine` → `schema.prisma:L17622`
- `KdsOrder` → `schema.prisma:L15931`
- `KdsOrderItem` → `schema.prisma:L15998`
- `KioskCheckInAttempt` → `schema.prisma:L18555`
- `KioskCheckInChallenge` → `schema.prisma:L18509`
- `KioskOutreachOutbox` → `schema.prisma:L18576`
- `LaunchCampaign` → `schema.prisma:L18914`
- `LaunchCampaignRedemption` → `schema.prisma:L19031`
- `LearnedPatterns` → `schema.prisma:L10501`
- `LedgerAccount` → `schema.prisma:L17485`
- `LiveDemoSession` → `schema.prisma:L868`
- `LowStockAlert` → `schema.prisma:L2968`
- `LoyaltyConfig` → `schema.prisma:L8184`
- `LoyaltyTransaction` → `schema.prisma:L8227`
- `MarketingCampaign` → `schema.prisma:L13776`
- `McpAuthCode` → `schema.prisma:L17023`
- `McpOAuthClient` → `schema.prisma:L17007`
- `McpRefreshToken` → `schema.prisma:L17041`
- `McpToolCall` → `schema.prisma:L17063`
- `MeasurementUnit` → `schema.prisma:L15771`
- `Menu` → `schema.prisma:L1768`
- `MenuCategory` → `schema.prisma:L1705`
- `MenuCategoryAssignment` → `schema.prisma:L1803`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16937`
- `MerchantAccount` → `schema.prisma:L6045`
- `MerchantFiscalConfig` → `schema.prisma:L17202`
- `MerchantRevenueShare` → `schema.prisma:L7174`
- `MerchantRoutingRule` → `schema.prisma:L6167`
- `MilestoneAchievement` → `schema.prisma:L13199`
- `Modifier` → `schema.prisma:L4400`
- `ModifierGroup` → `schema.prisma:L4364`
- `Module` → `schema.prisma:L11494`
- `MoneyAnomaly` → `schema.prisma:L7077`
- `MonthlyVenueProfit` → `schema.prisma:L7624`
- `Notification` → `schema.prisma:L9289`
- `NotificationPreference` → `schema.prisma:L9336`
- `NotificationTemplate` → `schema.prisma:L9363`
- `OAuthState` → `schema.prisma:L1601`
- `OnboardingProgress` → `schema.prisma:L1619`
- `OnlineOrder` → `schema.prisma:L19734`
- `OnlineOrderingSettings` → `schema.prisma:L19710`
- `Order` → `schema.prisma:L3924`
- `OrderAction` → `schema.prisma:L4471`
- `OrderCustomer` → `schema.prisma:L4178`
- `OrderDiscount` → `schema.prisma:L9145`
- `OrderFulfillment` → `schema.prisma:L16255`
- `OrderFulfillmentLine` → `schema.prisma:L16286`
- `OrderItem` → `schema.prisma:L4214`
- `OrderItemModifier` → `schema.prisma:L4453`
- `OrderItemSelloIva` → `schema.prisma:L17342`
- `OrderPromotion` → `schema.prisma:L18472`
- `OrderServiceCharge` → `schema.prisma:L9234`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13577`
- `OrganizationEntitlement` → `schema.prisma:L11777`
- `OrganizationGoal` → `schema.prisma:L13535`
- `OrganizationModule` → `schema.prisma:L11554`
- `OrganizationPaymentConfig` → `schema.prisma:L6619`
- `OrganizationPayoutConfig` → `schema.prisma:L13610`
- `OrganizationPricingStructure` → `schema.prisma:L6651`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13558`
- `OtpChallenge` → `schema.prisma:L8134`
- `OvertimeApproval` → `schema.prisma:L3639`
- `PartnerAPIKey` → `schema.prisma:L6449`
- `Payment` → `schema.prisma:L4504`
- `PaymentAllocation` → `schema.prisma:L4777`
- `PaymentEffect` → `schema.prisma:L18846`
- `PaymentLink` → `schema.prisma:L15442`
- `PaymentLinkAttribution` → `schema.prisma:L15550`
- `PaymentLinkItem` → `schema.prisma:L15505`
- `PaymentLinkItemModifier` → `schema.prisma:L15532`
- `PaymentProvider` → `schema.prisma:L6004`
- `PayrollLine` → `schema.prisma:L17968`
- `PayrollRun` → `schema.prisma:L17937`
- `PerformanceGoal` → `schema.prisma:L13512`
- `PermissionOverride` → `schema.prisma:L1474`
- `PermissionSet` → `schema.prisma:L1497`
- `PlatformAnnouncement` → `schema.prisma:L18636`
- `PlatformAnnouncementClick` → `schema.prisma:L18701`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18738`
- `PlatformCfdi` → `schema.prisma:L18265`
- `PlatformEmisor` → `schema.prisma:L18205`
- `PlatformSettings` → `schema.prisma:L6426`
- `PosCommand` → `schema.prisma:L9417`
- `PosConnectionStatus` → `schema.prisma:L1016`
- `PosSyncIntent` → `schema.prisma:L18343`
- `PricingPolicy` → `schema.prisma:L2864`
- `Printer` → `schema.prisma:L16056`
- `PrintGateway` → `schema.prisma:L16113`
- `PrintJob` → `schema.prisma:L16836`
- `PrintStation` → `schema.prisma:L16131`
- `PrivacyNoticeVersion` → `schema.prisma:L7882`
- `ProcessedStripeEvent` → `schema.prisma:L7063`
- `ProcessorReliabilityMetric` → `schema.prisma:L7552`
- `Product` → `schema.prisma:L1821`
- `ProductModifierGroup` → `schema.prisma:L4441`
- `ProductOption` → `schema.prisma:L15748`
- `ProductOptionValue` → `schema.prisma:L15759`
- `ProductStaff` → `schema.prisma:L14392`
- `PromoterBankAccount` → `schema.prisma:L18088`
- `PromoterCommissionEntry` → `schema.prisma:L18107`
- `PromoterLocationPing` → `schema.prisma:L3890`
- `Promotion` → `schema.prisma:L18394`
- `PromotionGroup` → `schema.prisma:L18433`
- `PromotionOption` → `schema.prisma:L18449`
- `ProviderCostStructure` → `schema.prisma:L7099`
- `ProviderEventLog` → `schema.prisma:L6728`
- `PurchaseOrder` → `schema.prisma:L2571`
- `PurchaseOrderInvoice` → `schema.prisma:L2716`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2783`
- `PurchaseOrderItem` → `schema.prisma:L2629`
- `RateCorrectionBatch` → `schema.prisma:L7328`
- `RateCorrectionEntry` → `schema.prisma:L7370`
- `RawMaterial` → `schema.prisma:L2327`
- `RawMaterialMovement` → `schema.prisma:L2917`
- `RawMaterialPresentation` → `schema.prisma:L2403`
- `ReceiptLayout` → `schema.prisma:L18880`
- `Recipe` → `schema.prisma:L2423`
- `RecipeLine` → `schema.prisma:L2447`
- `Referral` → `schema.prisma:L8600`
- `ReferralProgramConfig` → `schema.prisma:L8565`
- `ReferralRewardGrant` → `schema.prisma:L8691`
- `ReferralTierReward` → `schema.prisma:L8663`
- `ReferralTierUnlock` → `schema.prisma:L8736`
- `RefreshGrant` → `schema.prisma:L18825`
- `Reservation` → `schema.prisma:L14155`
- `ReservationGoogleEventMapping` → `schema.prisma:L15215`
- `ReservationModifier` → `schema.prisma:L14340`
- `ReservationReminderSent` → `schema.prisma:L14323`
- `ReservationSettings` → `schema.prisma:L14564`
- `ReservationWaitlistEntry` → `schema.prisma:L14532`
- `Review` → `schema.prisma:L5374`
- `SalesRetention` → `schema.prisma:L17788`
- `SaleVerification` → `schema.prisma:L4831`
- `ScaleProfile` → `schema.prisma:L16577`
- `ScheduledCommand` → `schema.prisma:L10978`
- `SerializedItem` → `schema.prisma:L12628`
- `SerializedItemCustodyEvent` → `schema.prisma:L12795`
- `ServiceCharge` → `schema.prisma:L9205`
- `ServiceEarning` → `schema.prisma:L19254`
- `ServicePayPeriod` → `schema.prisma:L19230`
- `ServicePayTable` → `schema.prisma:L19138`
- `ServicePayTableCell` → `schema.prisma:L19180`
- `ServicePayTableVersion` → `schema.prisma:L19155`
- `Session` → `schema.prisma:L18804`
- `SettlementConfiguration` → `schema.prisma:L7403`
- `SettlementConfirmation` → `schema.prisma:L7516`
- `SettlementIncident` → `schema.prisma:L7467`
- `SettlementSimulation` → `schema.prisma:L7438`
- `Shift` → `schema.prisma:L3450`
- `ShopifyConnectIntent` → `schema.prisma:L19575`
- `ShopifyImportIssue` → `schema.prisma:L19629`
- `ShopifyInboundEvent` → `schema.prisma:L19551`
- `ShopifyLocationLink` → `schema.prisma:L19425`
- `ShopifyReviewItem` → `schema.prisma:L19597`
- `ShopifyStockOutbox` → `schema.prisma:L19521`
- `ShopifyStore` → `schema.prisma:L19396`
- `ShopifyVariantLink` → `schema.prisma:L19473`
- `SimRegistrationRequest` → `schema.prisma:L12833`
- `SimRegistrationRequestItem` → `schema.prisma:L12855`
- `SlotHold` → `schema.prisma:L14423`
- `Staff` → `schema.prisma:L1036`
- `StaffAssignment` → `schema.prisma:L3737`
- `StaffDocument` → `schema.prisma:L3761`
- `StaffOnboardingState` → `schema.prisma:L16907`
- `StaffOrganization` → `schema.prisma:L1373`
- `StaffPasskey` → `schema.prisma:L1400`
- `StaffPayLevel` → `schema.prisma:L19102`
- `StaffPayLevelAssignment` → `schema.prisma:L19120`
- `StaffPayStatement` → `schema.prisma:L19286`
- `StaffPayTipWindow` → `schema.prisma:L19648`
- `StaffPayVenueWindow` → `schema.prisma:L19665`
- `StaffPosition` → `schema.prisma:L3716`
- `StaffSchedule` → `schema.prisma:L14363`
- `StaffScheduleException` → `schema.prisma:L14375`
- `StaffVenue` → `schema.prisma:L1297`
- `StaffWorkSchedule` → `schema.prisma:L3575`
- `StaffWorkScheduleException` → `schema.prisma:L3673`
- `StampCard` → `schema.prisma:L8448`
- `StampEvent` → `schema.prisma:L8487`
- `StampReward` → `schema.prisma:L8525`
- `StockAlertConfig` → `schema.prisma:L13494`
- `StockBatch` → `schema.prisma:L3087`
- `StockCount` → `schema.prisma:L3000`
- `StockCountItem` → `schema.prisma:L3028`
- `StripeWebhookEvent` → `schema.prisma:L7046`
- `Supplier` → `schema.prisma:L2482`
- `SupplierItemCode` → `schema.prisma:L2827`
- `SupplierPricing` → `schema.prisma:L2537`
- `Table` → `schema.prisma:L3341`
- `Terminal` → `schema.prisma:L5425`
- `TerminalAttemptResolution` → `schema.prisma:L5863`
- `TerminalHealth` → `schema.prisma:L5683`
- `TerminalLog` → `schema.prisma:L5657`
- `TerminalOrder` → `schema.prisma:L5907`
- `TerminalOrderItem` → `schema.prisma:L5982`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5835`
- `TerminalPaymentRequest` → `schema.prisma:L5754`
- `TimeEntry` → `schema.prisma:L3803`
- `TimeEntryBreak` → `schema.prisma:L3872`
- `TokenPurchase` → `schema.prisma:L10650`
- `TokenUsageRecord` → `schema.prisma:L10622`
- `TpvCommandHistory` → `schema.prisma:L10884`
- `TpvCommandQueue` → `schema.prisma:L10822`
- `TpvFeedback` → `schema.prisma:L10535`
- `TpvMessage` → `schema.prisma:L13851`
- `TpvMessageDelivery` → `schema.prisma:L13903`
- `TpvMessageResponse` → `schema.prisma:L13926`
- `TrainingModule` → `schema.prisma:L13981`
- `TrainingProgress` → `schema.prisma:L14058`
- `TrainingQuizQuestion` → `schema.prisma:L14040`
- `TrainingStep` → `schema.prisma:L14020`
- `TransactionCost` → `schema.prisma:L7266`
- `UnitConversion` → `schema.prisma:L2895`
- `UpsellAcceptance` → `schema.prisma:L9021`
- `UpsellAiRun` → `schema.prisma:L9041`
- `UpsellImpression` → `schema.prisma:L8981`
- `UpsellRule` → `schema.prisma:L8901`
- `user_sessions` → `schema.prisma:L6484`
- `Venue` → `schema.prisma:L185`
- `VenueAreaTicketSettings` → `schema.prisma:L16314`
- `VenueChatMessage` → `schema.prisma:L844`
- `VenueChatSession` → `schema.prisma:L799`
- `VenueCommission` → `schema.prisma:L15909`
- `VenueCreditAssessment` → `schema.prisma:L11366`
- `VenueCryptoConfig` → `schema.prisma:L13718`
- `VenueFeature` → `schema.prisma:L4945`
- `VenueIvaPorProducto` → `schema.prisma:L999`
- `VenueModule` → `schema.prisma:L11526`
- `VenuePaymentConfig` → `schema.prisma:L6585`
- `VenuePaymentLinkSettings` → `schema.prisma:L15248`
- `VenuePosSinAparato` → `schema.prisma:L1010`
- `VenuePricingStructure` → `schema.prisma:L7206`
- `VenueRoleConfig` → `schema.prisma:L1526`
- `VenueRolePermission` → `schema.prisma:L1430`
- `VenueScaleSettings` → `schema.prisma:L16565`
- `VenueSettings` → `schema.prisma:L884`
- `VenueTenderType` → `schema.prisma:L4690`
- `VenueTenderTypeRevision` → `schema.prisma:L4755`
- `VenueTransaction` → `schema.prisma:L4882`
- `VenueWhatsappActivation` → `schema.prisma:L735`
- `WalletCardDesign` → `schema.prisma:L8366`
- `WalletPass` → `schema.prisma:L8267`
- `WalletPassRegistration` → `schema.prisma:L8333`
- `WebhookEvent` → `schema.prisma:L5283`
- `WebhookSubscription` → `schema.prisma:L6701`
- `WhatsappContactWindow` → `schema.prisma:L753`
- `WhatsappInboundEvent` → `schema.prisma:L773`
- `WorkShiftAssignment` → `schema.prisma:L3615`
- `WorkShiftTemplate` → `schema.prisma:L3592`
- `Zone` → `schema.prisma:L168`
