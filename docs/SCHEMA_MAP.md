# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **422 models / 392 enums / ~19,600 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffAssignment`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffPosition`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                                                               |
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

- `AccountingPeriodLock` → `schema.prisma:L17635`
- `AccountMapping` → `schema.prisma:L17530`
- `ActivityLog` → `schema.prisma:L7669`
- `Aggregator` → `schema.prisma:L15781`
- `AggregatorBooking` → `schema.prisma:L15089`
- `AggregatorCapacityRule` → `schema.prisma:L15070`
- `AggregatorConnection` → `schema.prisma:L14995`
- `AggregatorInboundEvent` → `schema.prisma:L15158`
- `AggregatorOutbox` → `schema.prisma:L15178`
- `AggregatorProductLink` → `schema.prisma:L15027`
- `AggregatorSessionLink` → `schema.prisma:L15046`
- `AggregatorVisit` → `schema.prisma:L15115`
- `AngelPayUserAccount` → `schema.prisma:L6210`
- `AppUpdate` → `schema.prisma:L13656`
- `Area` → `schema.prisma:L3306`
- `AreaTicket` → `schema.prisma:L16330`
- `AreaTicketCheckoutSession` → `schema.prisma:L16452`
- `AreaTicketExternalIncident` → `schema.prisma:L16699`
- `AreaTicketExternalSettlement` → `schema.prisma:L16664`
- `AreaTicketFulfillment` → `schema.prisma:L16528`
- `AreaTicketInventoryReservation` → `schema.prisma:L16423`
- `AreaTicketLine` → `schema.prisma:L16391`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16484`
- `AreaTicketPrintAttempt` → `schema.prisma:L16507`
- `BankStatement` → `schema.prisma:L17404`
- `BankStatementLine` → `schema.prisma:L17425`
- `BillingObligationConflict` → `schema.prisma:L5240`
- `BillingTaxProfile` → `schema.prisma:L18227`
- `BirthdayAutomation` → `schema.prisma:L7993`
- `BulkCommandOperation` → `schema.prisma:L10928`
- `CalendarSyncOutbox` → `schema.prisma:L14878`
- `CampaignDelivery` → `schema.prisma:L13814`
- `CapabilityGrant` → `schema.prisma:L4980`
- `CashCloseout` → `schema.prisma:L11313`
- `CashDeposit` → `schema.prisma:L13458`
- `CashDrawerEvent` → `schema.prisma:L15618`
- `CashDrawerSession` → `schema.prisma:L15579`
- `CashOutCommissionRate` → `schema.prisma:L18044`
- `CashOutScheduleDay` → `schema.prisma:L18067`
- `CashOutWithdrawal` → `schema.prisma:L18129`
- `CatalogBindingBatch` → `schema.prisma:L12344`
- `CatalogBindingLine` → `schema.prisma:L12380`
- `CatalogBrand` → `schema.prisma:L11797`
- `CatalogClientObservation` → `schema.prisma:L12110`
- `CatalogClientReadinessOverride` → `schema.prisma:L12129`
- `CatalogFamily` → `schema.prisma:L11847`
- `CatalogIdempotencyRecord` → `schema.prisma:L12243`
- `CatalogIdentifier` → `schema.prisma:L11978`
- `CatalogImportBatch` → `schema.prisma:L12286`
- `CatalogImportLine` → `schema.prisma:L12323`
- `CatalogItem` → `schema.prisma:L11880`
- `CatalogItemBusinessType` → `schema.prisma:L11940`
- `CatalogItemPrice` → `schema.prisma:L12028`
- `CatalogManufacturer` → `schema.prisma:L11821`
- `CatalogProductTypeMapping` → `schema.prisma:L11957`
- `CatalogPublicationBatch` → `schema.prisma:L12408`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12502`
- `CatalogPublicationLine` → `schema.prisma:L12449`
- `CatalogPublicationOutbox` → `schema.prisma:L12545`
- `CatalogValidationProfile` → `schema.prisma:L11999`
- `CatalogVenueBinding` → `schema.prisma:L12157`
- `CatalogVenueClientRequirement` → `schema.prisma:L12084`
- `CatalogVenueEventSequence` → `schema.prisma:L12528`
- `CatalogVenueOverride` → `schema.prisma:L12199`
- `CatalogVenueRollout` → `schema.prisma:L12059`
- `Cfdi` → `schema.prisma:L17226`
- `CfdiGlobalOrden` → `schema.prisma:L17357`
- `ChatbotTokenBudget` → `schema.prisma:L10574`
- `ChatConversation` → `schema.prisma:L10429`
- `ChatFeedback` → `schema.prisma:L10515`
- `ChatLearningEvent` → `schema.prisma:L10472`
- `ChatMessage` → `schema.prisma:L10452`
- `ChatTrainingData` → `schema.prisma:L10386`
- `CheckoutSession` → `schema.prisma:L6490`
- `ClassSession` → `schema.prisma:L14472`
- `ClassSessionPayState` → `schema.prisma:L19187`
- `CommissionCalculation` → `schema.prisma:L13233`
- `CommissionClawback` → `schema.prisma:L13410`
- `CommissionConfig` → `schema.prisma:L12992`
- `CommissionMilestone` → `schema.prisma:L13149`
- `CommissionOverride` → `schema.prisma:L13076`
- `CommissionPayout` → `schema.prisma:L13361`
- `CommissionSummary` → `schema.prisma:L13300`
- `CommissionTier` → `schema.prisma:L13113`
- `ConsentEvent` → `schema.prisma:L7855`
- `Consumer` → `schema.prisma:L8085`
- `ConsumerAuthAccount` → `schema.prisma:L8110`
- `CouponCode` → `schema.prisma:L9057`
- `CouponRedemption` → `schema.prisma:L9088`
- `CreditAssessmentHistory` → `schema.prisma:L11422`
- `CreditItemBalance` → `schema.prisma:L15369`
- `CreditOffer` → `schema.prisma:L11441`
- `CreditPack` → `schema.prisma:L15278`
- `CreditPackItem` → `schema.prisma:L15307`
- `CreditPackPurchase` → `schema.prisma:L15324`
- `CreditTransaction` → `schema.prisma:L15391`
- `Customer` → `schema.prisma:L7710`
- `CustomerApprovalDelivery` → `schema.prisma:L10087`
- `CustomerApprovalOutbox` → `schema.prisma:L10062`
- `CustomerCampaign` → `schema.prisma:L7943`
- `CustomerCampaignDelivery` → `schema.prisma:L8025`
- `CustomerCaptureToken` → `schema.prisma:L7891`
- `CustomerDiscount` → `schema.prisma:L9108`
- `CustomerExternalIdentity` → `schema.prisma:L15145`
- `CustomerGroup` → `schema.prisma:L8149`
- `CustomerOrderMetric` → `schema.prisma:L4194`
- `CustomerTaxProfile` → `schema.prisma:L17376`
- `DeliveryActivationRequest` → `schema.prisma:L6949`
- `DeliveryChannelLink` → `schema.prisma:L6788`
- `DeliveryConnectIntent` → `schema.prisma:L6900`
- `DeliveryLineAction` → `schema.prisma:L6861`
- `DeliveryOrderEvent` → `schema.prisma:L6973`
- `DeliveryStoreRevocation` → `schema.prisma:L6937`
- `DeviceToken` → `schema.prisma:L9382`
- `DigitalReceipt` → `schema.prisma:L4793`
- `Discount` → `schema.prisma:L8747`
- `EcommerceMerchant` → `schema.prisma:L6302`
- `EmailQuotaLedger` → `schema.prisma:L8072`
- `EmailSuppression` → `schema.prisma:L8060`
- `EmailTemplate` → `schema.prisma:L13753`
- `Employee` → `schema.prisma:L17892`
- `Estimate` → `schema.prisma:L15688`
- `EstimateItem` → `schema.prisma:L15716`
- `Expense` → `schema.prisma:L17679`
- `ExternalBusyBlock` → `schema.prisma:L14771`
- `Feature` → `schema.prisma:L4922`
- `FeeSchedule` → `schema.prisma:L5302`
- `FeeTier` → `schema.prisma:L5313`
- `FinancialAccount` → `schema.prisma:L15878`
- `FinancialConnection` → `schema.prisma:L15847`
- `FinancialProvider` → `schema.prisma:L15833`
- `FiscalEmisor` → `schema.prisma:L17137`
- `FiscalLossCarryforward` → `schema.prisma:L17802`
- `FixedAsset` → `schema.prisma:L17820`
- `FixedAssetDepreciation` → `schema.prisma:L17849`
- `FloorElement` → `schema.prisma:L3391`
- `FloorPlanPublication` → `schema.prisma:L3431`
- `FulfillmentArea` → `schema.prisma:L16195`
- `GeofenceRule` → `schema.prisma:L11013`
- `GoogleCalendarChannel` → `schema.prisma:L14748`
- `GoogleCalendarConnection` → `schema.prisma:L14700`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14801`
- `GoogleOAuthSession` → `schema.prisma:L14823`
- `HolidayCalendar` → `schema.prisma:L7593`
- `HybridBillingOperation` → `schema.prisma:L5164`
- `HybridCampaign` → `schema.prisma:L5005`
- `HybridContract` → `schema.prisma:L5121`
- `HybridContractSelection` → `schema.prisma:L5153`
- `HybridCreditAllocation` → `schema.prisma:L5220`
- `HybridOfferPublication` → `schema.prisma:L5068`
- `HybridPaymentPeriod` → `schema.prisma:L5199`
- `HybridPromotionGroup` → `schema.prisma:L5049`
- `HybridPurchase` → `schema.prisma:L5088`
- `HybridRedemption` → `schema.prisma:L5182`
- `IdempotencyRequest` → `schema.prisma:L12867`
- `InterVenueTransfer` → `schema.prisma:L3134`
- `InterVenueTransferAllocation` → `schema.prisma:L3217`
- `InterVenueTransferItem` → `schema.prisma:L3186`
- `InterVenueTransferReceipt` → `schema.prisma:L3244`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3260`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3288`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3272`
- `Inventory` → `schema.prisma:L2056`
- `InventoryMovement` → `schema.prisma:L2156`
- `InventoryPosting` → `schema.prisma:L2251`
- `InventoryPostingLine` → `schema.prisma:L2291`
- `InventoryTransfer` → `schema.prisma:L15660`
- `InventoryWasteReport` → `schema.prisma:L2111`
- `Invitation` → `schema.prisma:L1548`
- `Invoice` → `schema.prisma:L5325`
- `InvoiceItem` → `schema.prisma:L5351`
- `ItemCategory` → `schema.prisma:L12580`
- `JournalEntry` → `schema.prisma:L17588`
- `JournalLine` → `schema.prisma:L17617`
- `KdsOrder` → `schema.prisma:L15926`
- `KdsOrderItem` → `schema.prisma:L15993`
- `KioskCheckInAttempt` → `schema.prisma:L18550`
- `KioskCheckInChallenge` → `schema.prisma:L18504`
- `KioskOutreachOutbox` → `schema.prisma:L18571`
- `LaunchCampaign` → `schema.prisma:L18909`
- `LaunchCampaignRedemption` → `schema.prisma:L19026`
- `LearnedPatterns` → `schema.prisma:L10496`
- `LedgerAccount` → `schema.prisma:L17480`
- `LiveDemoSession` → `schema.prisma:L866`
- `LowStockAlert` → `schema.prisma:L2964`
- `LoyaltyConfig` → `schema.prisma:L8179`
- `LoyaltyTransaction` → `schema.prisma:L8222`
- `MarketingCampaign` → `schema.prisma:L13771`
- `McpAuthCode` → `schema.prisma:L17018`
- `McpOAuthClient` → `schema.prisma:L17002`
- `McpRefreshToken` → `schema.prisma:L17036`
- `McpToolCall` → `schema.prisma:L17058`
- `MeasurementUnit` → `schema.prisma:L15766`
- `Menu` → `schema.prisma:L1766`
- `MenuCategory` → `schema.prisma:L1703`
- `MenuCategoryAssignment` → `schema.prisma:L1801`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16932`
- `MerchantAccount` → `schema.prisma:L6040`
- `MerchantFiscalConfig` → `schema.prisma:L17197`
- `MerchantRevenueShare` → `schema.prisma:L7169`
- `MerchantRoutingRule` → `schema.prisma:L6162`
- `MilestoneAchievement` → `schema.prisma:L13194`
- `Modifier` → `schema.prisma:L4395`
- `ModifierGroup` → `schema.prisma:L4359`
- `Module` → `schema.prisma:L11489`
- `MoneyAnomaly` → `schema.prisma:L7072`
- `MonthlyVenueProfit` → `schema.prisma:L7619`
- `Notification` → `schema.prisma:L9284`
- `NotificationPreference` → `schema.prisma:L9331`
- `NotificationTemplate` → `schema.prisma:L9358`
- `OAuthState` → `schema.prisma:L1599`
- `OnboardingProgress` → `schema.prisma:L1617`
- `Order` → `schema.prisma:L3920`
- `OrderAction` → `schema.prisma:L4466`
- `OrderCustomer` → `schema.prisma:L4173`
- `OrderDiscount` → `schema.prisma:L9140`
- `OrderFulfillment` → `schema.prisma:L16250`
- `OrderFulfillmentLine` → `schema.prisma:L16281`
- `OrderItem` → `schema.prisma:L4209`
- `OrderItemModifier` → `schema.prisma:L4448`
- `OrderItemSelloIva` → `schema.prisma:L17337`
- `OrderPromotion` → `schema.prisma:L18467`
- `OrderServiceCharge` → `schema.prisma:L9229`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13572`
- `OrganizationEntitlement` → `schema.prisma:L11772`
- `OrganizationGoal` → `schema.prisma:L13530`
- `OrganizationModule` → `schema.prisma:L11549`
- `OrganizationPaymentConfig` → `schema.prisma:L6614`
- `OrganizationPayoutConfig` → `schema.prisma:L13605`
- `OrganizationPricingStructure` → `schema.prisma:L6646`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13553`
- `OtpChallenge` → `schema.prisma:L8129`
- `OvertimeApproval` → `schema.prisma:L3635`
- `PartnerAPIKey` → `schema.prisma:L6444`
- `Payment` → `schema.prisma:L4499`
- `PaymentAllocation` → `schema.prisma:L4772`
- `PaymentEffect` → `schema.prisma:L18841`
- `PaymentLink` → `schema.prisma:L15437`
- `PaymentLinkAttribution` → `schema.prisma:L15545`
- `PaymentLinkItem` → `schema.prisma:L15500`
- `PaymentLinkItemModifier` → `schema.prisma:L15527`
- `PaymentProvider` → `schema.prisma:L5999`
- `PayrollLine` → `schema.prisma:L17963`
- `PayrollRun` → `schema.prisma:L17932`
- `PerformanceGoal` → `schema.prisma:L13507`
- `PermissionOverride` → `schema.prisma:L1472`
- `PermissionSet` → `schema.prisma:L1495`
- `PlatformAnnouncement` → `schema.prisma:L18631`
- `PlatformAnnouncementClick` → `schema.prisma:L18696`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18733`
- `PlatformCfdi` → `schema.prisma:L18260`
- `PlatformEmisor` → `schema.prisma:L18200`
- `PlatformSettings` → `schema.prisma:L6421`
- `PosCommand` → `schema.prisma:L9412`
- `PosConnectionStatus` → `schema.prisma:L1014`
- `PosSyncIntent` → `schema.prisma:L18338`
- `PricingPolicy` → `schema.prisma:L2860`
- `Printer` → `schema.prisma:L16051`
- `PrintGateway` → `schema.prisma:L16108`
- `PrintJob` → `schema.prisma:L16831`
- `PrintStation` → `schema.prisma:L16126`
- `PrivacyNoticeVersion` → `schema.prisma:L7877`
- `ProcessedStripeEvent` → `schema.prisma:L7058`
- `ProcessorReliabilityMetric` → `schema.prisma:L7547`
- `Product` → `schema.prisma:L1819`
- `ProductModifierGroup` → `schema.prisma:L4436`
- `ProductOption` → `schema.prisma:L15743`
- `ProductOptionValue` → `schema.prisma:L15754`
- `ProductStaff` → `schema.prisma:L14387`
- `PromoterBankAccount` → `schema.prisma:L18083`
- `PromoterCommissionEntry` → `schema.prisma:L18102`
- `PromoterLocationPing` → `schema.prisma:L3886`
- `Promotion` → `schema.prisma:L18389`
- `PromotionGroup` → `schema.prisma:L18428`
- `PromotionOption` → `schema.prisma:L18444`
- `ProviderCostStructure` → `schema.prisma:L7094`
- `ProviderEventLog` → `schema.prisma:L6723`
- `PurchaseOrder` → `schema.prisma:L2567`
- `PurchaseOrderInvoice` → `schema.prisma:L2712`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2779`
- `PurchaseOrderItem` → `schema.prisma:L2625`
- `RateCorrectionBatch` → `schema.prisma:L7323`
- `RateCorrectionEntry` → `schema.prisma:L7365`
- `RawMaterial` → `schema.prisma:L2323`
- `RawMaterialMovement` → `schema.prisma:L2913`
- `RawMaterialPresentation` → `schema.prisma:L2399`
- `ReceiptLayout` → `schema.prisma:L18875`
- `Recipe` → `schema.prisma:L2419`
- `RecipeLine` → `schema.prisma:L2443`
- `Referral` → `schema.prisma:L8595`
- `ReferralProgramConfig` → `schema.prisma:L8560`
- `ReferralRewardGrant` → `schema.prisma:L8686`
- `ReferralTierReward` → `schema.prisma:L8658`
- `ReferralTierUnlock` → `schema.prisma:L8731`
- `RefreshGrant` → `schema.prisma:L18820`
- `Reservation` → `schema.prisma:L14150`
- `ReservationGoogleEventMapping` → `schema.prisma:L15210`
- `ReservationModifier` → `schema.prisma:L14335`
- `ReservationReminderSent` → `schema.prisma:L14318`
- `ReservationSettings` → `schema.prisma:L14559`
- `ReservationWaitlistEntry` → `schema.prisma:L14527`
- `Review` → `schema.prisma:L5369`
- `SalesRetention` → `schema.prisma:L17783`
- `SaleVerification` → `schema.prisma:L4826`
- `ScaleProfile` → `schema.prisma:L16572`
- `ScheduledCommand` → `schema.prisma:L10973`
- `SerializedItem` → `schema.prisma:L12623`
- `SerializedItemCustodyEvent` → `schema.prisma:L12790`
- `ServiceCharge` → `schema.prisma:L9200`
- `ServiceEarning` → `schema.prisma:L19249`
- `ServicePayPeriod` → `schema.prisma:L19225`
- `ServicePayTable` → `schema.prisma:L19133`
- `ServicePayTableCell` → `schema.prisma:L19175`
- `ServicePayTableVersion` → `schema.prisma:L19150`
- `Session` → `schema.prisma:L18799`
- `SettlementConfiguration` → `schema.prisma:L7398`
- `SettlementConfirmation` → `schema.prisma:L7511`
- `SettlementIncident` → `schema.prisma:L7462`
- `SettlementSimulation` → `schema.prisma:L7433`
- `Shift` → `schema.prisma:L3446`
- `ShopifyConnectIntent` → `schema.prisma:L19570`
- `ShopifyImportIssue` → `schema.prisma:L19624`
- `ShopifyInboundEvent` → `schema.prisma:L19546`
- `ShopifyLocationLink` → `schema.prisma:L19420`
- `ShopifyReviewItem` → `schema.prisma:L19592`
- `ShopifyStockOutbox` → `schema.prisma:L19516`
- `ShopifyStore` → `schema.prisma:L19391`
- `ShopifyVariantLink` → `schema.prisma:L19468`
- `SimRegistrationRequest` → `schema.prisma:L12828`
- `SimRegistrationRequestItem` → `schema.prisma:L12850`
- `SlotHold` → `schema.prisma:L14418`
- `Staff` → `schema.prisma:L1034`
- `StaffAssignment` → `schema.prisma:L3733`
- `StaffDocument` → `schema.prisma:L3757`
- `StaffOnboardingState` → `schema.prisma:L16902`
- `StaffOrganization` → `schema.prisma:L1371`
- `StaffPasskey` → `schema.prisma:L1398`
- `StaffPayLevel` → `schema.prisma:L19097`
- `StaffPayLevelAssignment` → `schema.prisma:L19115`
- `StaffPayStatement` → `schema.prisma:L19281`
- `StaffPayTipWindow` → `schema.prisma:L19643`
- `StaffPayVenueWindow` → `schema.prisma:L19660`
- `StaffPosition` → `schema.prisma:L3712`
- `StaffSchedule` → `schema.prisma:L14358`
- `StaffScheduleException` → `schema.prisma:L14370`
- `StaffVenue` → `schema.prisma:L1295`
- `StaffWorkSchedule` → `schema.prisma:L3571`
- `StaffWorkScheduleException` → `schema.prisma:L3669`
- `StampCard` → `schema.prisma:L8443`
- `StampEvent` → `schema.prisma:L8482`
- `StampReward` → `schema.prisma:L8520`
- `StockAlertConfig` → `schema.prisma:L13489`
- `StockBatch` → `schema.prisma:L3083`
- `StockCount` → `schema.prisma:L2996`
- `StockCountItem` → `schema.prisma:L3024`
- `StripeWebhookEvent` → `schema.prisma:L7041`
- `Supplier` → `schema.prisma:L2478`
- `SupplierItemCode` → `schema.prisma:L2823`
- `SupplierPricing` → `schema.prisma:L2533`
- `Table` → `schema.prisma:L3337`
- `Terminal` → `schema.prisma:L5420`
- `TerminalAttemptResolution` → `schema.prisma:L5858`
- `TerminalHealth` → `schema.prisma:L5678`
- `TerminalLog` → `schema.prisma:L5652`
- `TerminalOrder` → `schema.prisma:L5902`
- `TerminalOrderItem` → `schema.prisma:L5977`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5830`
- `TerminalPaymentRequest` → `schema.prisma:L5749`
- `TimeEntry` → `schema.prisma:L3799`
- `TimeEntryBreak` → `schema.prisma:L3868`
- `TokenPurchase` → `schema.prisma:L10645`
- `TokenUsageRecord` → `schema.prisma:L10617`
- `TpvCommandHistory` → `schema.prisma:L10879`
- `TpvCommandQueue` → `schema.prisma:L10817`
- `TpvFeedback` → `schema.prisma:L10530`
- `TpvMessage` → `schema.prisma:L13846`
- `TpvMessageDelivery` → `schema.prisma:L13898`
- `TpvMessageResponse` → `schema.prisma:L13921`
- `TrainingModule` → `schema.prisma:L13976`
- `TrainingProgress` → `schema.prisma:L14053`
- `TrainingQuizQuestion` → `schema.prisma:L14035`
- `TrainingStep` → `schema.prisma:L14015`
- `TransactionCost` → `schema.prisma:L7261`
- `UnitConversion` → `schema.prisma:L2891`
- `UpsellAcceptance` → `schema.prisma:L9016`
- `UpsellAiRun` → `schema.prisma:L9036`
- `UpsellImpression` → `schema.prisma:L8976`
- `UpsellRule` → `schema.prisma:L8896`
- `user_sessions` → `schema.prisma:L6479`
- `Venue` → `schema.prisma:L185`
- `VenueAreaTicketSettings` → `schema.prisma:L16309`
- `VenueChatMessage` → `schema.prisma:L842`
- `VenueChatSession` → `schema.prisma:L797`
- `VenueCommission` → `schema.prisma:L15904`
- `VenueCreditAssessment` → `schema.prisma:L11361`
- `VenueCryptoConfig` → `schema.prisma:L13713`
- `VenueFeature` → `schema.prisma:L4940`
- `VenueIvaPorProducto` → `schema.prisma:L997`
- `VenueModule` → `schema.prisma:L11521`
- `VenuePaymentConfig` → `schema.prisma:L6580`
- `VenuePaymentLinkSettings` → `schema.prisma:L15243`
- `VenuePosSinAparato` → `schema.prisma:L1008`
- `VenuePricingStructure` → `schema.prisma:L7201`
- `VenueRoleConfig` → `schema.prisma:L1524`
- `VenueRolePermission` → `schema.prisma:L1428`
- `VenueScaleSettings` → `schema.prisma:L16560`
- `VenueSettings` → `schema.prisma:L882`
- `VenueTenderType` → `schema.prisma:L4685`
- `VenueTenderTypeRevision` → `schema.prisma:L4750`
- `VenueTransaction` → `schema.prisma:L4877`
- `VenueWhatsappActivation` → `schema.prisma:L733`
- `WalletCardDesign` → `schema.prisma:L8361`
- `WalletPass` → `schema.prisma:L8262`
- `WalletPassRegistration` → `schema.prisma:L8328`
- `WebhookEvent` → `schema.prisma:L5278`
- `WebhookSubscription` → `schema.prisma:L6696`
- `WhatsappContactWindow` → `schema.prisma:L751`
- `WhatsappInboundEvent` → `schema.prisma:L771`
- `WorkShiftAssignment` → `schema.prisma:L3611`
- `WorkShiftTemplate` → `schema.prisma:L3588`
- `Zone` → `schema.prisma:L168`
