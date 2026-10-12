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

- `AccountingPeriodLock` → `schema.prisma:L17628`
- `AccountMapping` → `schema.prisma:L17523`
- `ActivityLog` → `schema.prisma:L7665`
- `Aggregator` → `schema.prisma:L15777`
- `AggregatorBooking` → `schema.prisma:L15085`
- `AggregatorCapacityRule` → `schema.prisma:L15066`
- `AggregatorConnection` → `schema.prisma:L14991`
- `AggregatorInboundEvent` → `schema.prisma:L15154`
- `AggregatorOutbox` → `schema.prisma:L15174`
- `AggregatorProductLink` → `schema.prisma:L15023`
- `AggregatorSessionLink` → `schema.prisma:L15042`
- `AggregatorVisit` → `schema.prisma:L15111`
- `AngelPayUserAccount` → `schema.prisma:L6210`
- `AppUpdate` → `schema.prisma:L13652`
- `Area` → `schema.prisma:L3306`
- `AreaTicket` → `schema.prisma:L16326`
- `AreaTicketCheckoutSession` → `schema.prisma:L16448`
- `AreaTicketExternalIncident` → `schema.prisma:L16695`
- `AreaTicketExternalSettlement` → `schema.prisma:L16660`
- `AreaTicketFulfillment` → `schema.prisma:L16524`
- `AreaTicketInventoryReservation` → `schema.prisma:L16419`
- `AreaTicketLine` → `schema.prisma:L16387`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16480`
- `AreaTicketPrintAttempt` → `schema.prisma:L16503`
- `BankStatement` → `schema.prisma:L17397`
- `BankStatementLine` → `schema.prisma:L17418`
- `BillingObligationConflict` → `schema.prisma:L5240`
- `BillingTaxProfile` → `schema.prisma:L18220`
- `BirthdayAutomation` → `schema.prisma:L7989`
- `BulkCommandOperation` → `schema.prisma:L10924`
- `CalendarSyncOutbox` → `schema.prisma:L14874`
- `CampaignDelivery` → `schema.prisma:L13810`
- `CapabilityGrant` → `schema.prisma:L4980`
- `CashCloseout` → `schema.prisma:L11309`
- `CashDeposit` → `schema.prisma:L13454`
- `CashDrawerEvent` → `schema.prisma:L15614`
- `CashDrawerSession` → `schema.prisma:L15575`
- `CashOutCommissionRate` → `schema.prisma:L18037`
- `CashOutScheduleDay` → `schema.prisma:L18060`
- `CashOutWithdrawal` → `schema.prisma:L18122`
- `CatalogBindingBatch` → `schema.prisma:L12340`
- `CatalogBindingLine` → `schema.prisma:L12376`
- `CatalogBrand` → `schema.prisma:L11793`
- `CatalogClientObservation` → `schema.prisma:L12106`
- `CatalogClientReadinessOverride` → `schema.prisma:L12125`
- `CatalogFamily` → `schema.prisma:L11843`
- `CatalogIdempotencyRecord` → `schema.prisma:L12239`
- `CatalogIdentifier` → `schema.prisma:L11974`
- `CatalogImportBatch` → `schema.prisma:L12282`
- `CatalogImportLine` → `schema.prisma:L12319`
- `CatalogItem` → `schema.prisma:L11876`
- `CatalogItemBusinessType` → `schema.prisma:L11936`
- `CatalogItemPrice` → `schema.prisma:L12024`
- `CatalogManufacturer` → `schema.prisma:L11817`
- `CatalogProductTypeMapping` → `schema.prisma:L11953`
- `CatalogPublicationBatch` → `schema.prisma:L12404`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12498`
- `CatalogPublicationLine` → `schema.prisma:L12445`
- `CatalogPublicationOutbox` → `schema.prisma:L12541`
- `CatalogValidationProfile` → `schema.prisma:L11995`
- `CatalogVenueBinding` → `schema.prisma:L12153`
- `CatalogVenueClientRequirement` → `schema.prisma:L12080`
- `CatalogVenueEventSequence` → `schema.prisma:L12524`
- `CatalogVenueOverride` → `schema.prisma:L12195`
- `CatalogVenueRollout` → `schema.prisma:L12055`
- `Cfdi` → `schema.prisma:L17221`
- `CfdiGlobalOrden` → `schema.prisma:L17350`
- `ChatbotTokenBudget` → `schema.prisma:L10570`
- `ChatConversation` → `schema.prisma:L10425`
- `ChatFeedback` → `schema.prisma:L10511`
- `ChatLearningEvent` → `schema.prisma:L10468`
- `ChatMessage` → `schema.prisma:L10448`
- `ChatTrainingData` → `schema.prisma:L10382`
- `CheckoutSession` → `schema.prisma:L6490`
- `ClassSession` → `schema.prisma:L14468`
- `ClassSessionPayState` → `schema.prisma:L19180`
- `CommissionCalculation` → `schema.prisma:L13229`
- `CommissionClawback` → `schema.prisma:L13406`
- `CommissionConfig` → `schema.prisma:L12988`
- `CommissionMilestone` → `schema.prisma:L13145`
- `CommissionOverride` → `schema.prisma:L13072`
- `CommissionPayout` → `schema.prisma:L13357`
- `CommissionSummary` → `schema.prisma:L13296`
- `CommissionTier` → `schema.prisma:L13109`
- `ConsentEvent` → `schema.prisma:L7851`
- `Consumer` → `schema.prisma:L8081`
- `ConsumerAuthAccount` → `schema.prisma:L8106`
- `CouponCode` → `schema.prisma:L9053`
- `CouponRedemption` → `schema.prisma:L9084`
- `CreditAssessmentHistory` → `schema.prisma:L11418`
- `CreditItemBalance` → `schema.prisma:L15365`
- `CreditOffer` → `schema.prisma:L11437`
- `CreditPack` → `schema.prisma:L15274`
- `CreditPackItem` → `schema.prisma:L15303`
- `CreditPackPurchase` → `schema.prisma:L15320`
- `CreditTransaction` → `schema.prisma:L15387`
- `Customer` → `schema.prisma:L7706`
- `CustomerApprovalDelivery` → `schema.prisma:L10083`
- `CustomerApprovalOutbox` → `schema.prisma:L10058`
- `CustomerCampaign` → `schema.prisma:L7939`
- `CustomerCampaignDelivery` → `schema.prisma:L8021`
- `CustomerCaptureToken` → `schema.prisma:L7887`
- `CustomerDiscount` → `schema.prisma:L9104`
- `CustomerExternalIdentity` → `schema.prisma:L15141`
- `CustomerGroup` → `schema.prisma:L8145`
- `CustomerOrderMetric` → `schema.prisma:L4194`
- `CustomerTaxProfile` → `schema.prisma:L17369`
- `DeliveryActivationRequest` → `schema.prisma:L6949`
- `DeliveryChannelLink` → `schema.prisma:L6788`
- `DeliveryConnectIntent` → `schema.prisma:L6900`
- `DeliveryLineAction` → `schema.prisma:L6861`
- `DeliveryOrderEvent` → `schema.prisma:L6973`
- `DeliveryStoreRevocation` → `schema.prisma:L6937`
- `DeviceToken` → `schema.prisma:L9378`
- `DigitalReceipt` → `schema.prisma:L4793`
- `Discount` → `schema.prisma:L8743`
- `EcommerceMerchant` → `schema.prisma:L6302`
- `EmailQuotaLedger` → `schema.prisma:L8068`
- `EmailSuppression` → `schema.prisma:L8056`
- `EmailTemplate` → `schema.prisma:L13749`
- `Employee` → `schema.prisma:L17885`
- `Estimate` → `schema.prisma:L15684`
- `EstimateItem` → `schema.prisma:L15712`
- `Expense` → `schema.prisma:L17672`
- `ExternalBusyBlock` → `schema.prisma:L14767`
- `Feature` → `schema.prisma:L4922`
- `FeeSchedule` → `schema.prisma:L5302`
- `FeeTier` → `schema.prisma:L5313`
- `FinancialAccount` → `schema.prisma:L15874`
- `FinancialConnection` → `schema.prisma:L15843`
- `FinancialProvider` → `schema.prisma:L15829`
- `FiscalEmisor` → `schema.prisma:L17132`
- `FiscalLossCarryforward` → `schema.prisma:L17795`
- `FixedAsset` → `schema.prisma:L17813`
- `FixedAssetDepreciation` → `schema.prisma:L17842`
- `FloorElement` → `schema.prisma:L3391`
- `FloorPlanPublication` → `schema.prisma:L3431`
- `FulfillmentArea` → `schema.prisma:L16191`
- `GeofenceRule` → `schema.prisma:L11009`
- `GoogleCalendarChannel` → `schema.prisma:L14744`
- `GoogleCalendarConnection` → `schema.prisma:L14696`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14797`
- `GoogleOAuthSession` → `schema.prisma:L14819`
- `HolidayCalendar` → `schema.prisma:L7589`
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
- `IdempotencyRequest` → `schema.prisma:L12863`
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
- `InventoryTransfer` → `schema.prisma:L15656`
- `InventoryWasteReport` → `schema.prisma:L2111`
- `Invitation` → `schema.prisma:L1548`
- `Invoice` → `schema.prisma:L5325`
- `InvoiceItem` → `schema.prisma:L5351`
- `ItemCategory` → `schema.prisma:L12576`
- `JournalEntry` → `schema.prisma:L17581`
- `JournalLine` → `schema.prisma:L17610`
- `KdsOrder` → `schema.prisma:L15922`
- `KdsOrderItem` → `schema.prisma:L15989`
- `KioskCheckInAttempt` → `schema.prisma:L18543`
- `KioskCheckInChallenge` → `schema.prisma:L18497`
- `KioskOutreachOutbox` → `schema.prisma:L18564`
- `LaunchCampaign` → `schema.prisma:L18902`
- `LaunchCampaignRedemption` → `schema.prisma:L19019`
- `LearnedPatterns` → `schema.prisma:L10492`
- `LedgerAccount` → `schema.prisma:L17473`
- `LiveDemoSession` → `schema.prisma:L866`
- `LowStockAlert` → `schema.prisma:L2964`
- `LoyaltyConfig` → `schema.prisma:L8175`
- `LoyaltyTransaction` → `schema.prisma:L8218`
- `MarketingCampaign` → `schema.prisma:L13767`
- `McpAuthCode` → `schema.prisma:L17014`
- `McpOAuthClient` → `schema.prisma:L16998`
- `McpRefreshToken` → `schema.prisma:L17032`
- `McpToolCall` → `schema.prisma:L17054`
- `MeasurementUnit` → `schema.prisma:L15762`
- `Menu` → `schema.prisma:L1766`
- `MenuCategory` → `schema.prisma:L1703`
- `MenuCategoryAssignment` → `schema.prisma:L1801`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16928`
- `MerchantAccount` → `schema.prisma:L6040`
- `MerchantFiscalConfig` → `schema.prisma:L17192`
- `MerchantRevenueShare` → `schema.prisma:L7169`
- `MerchantRoutingRule` → `schema.prisma:L6162`
- `MilestoneAchievement` → `schema.prisma:L13190`
- `Modifier` → `schema.prisma:L4395`
- `ModifierGroup` → `schema.prisma:L4359`
- `Module` → `schema.prisma:L11485`
- `MoneyAnomaly` → `schema.prisma:L7072`
- `MonthlyVenueProfit` → `schema.prisma:L7615`
- `Notification` → `schema.prisma:L9280`
- `NotificationPreference` → `schema.prisma:L9327`
- `NotificationTemplate` → `schema.prisma:L9354`
- `OAuthState` → `schema.prisma:L1599`
- `OnboardingProgress` → `schema.prisma:L1617`
- `Order` → `schema.prisma:L3920`
- `OrderAction` → `schema.prisma:L4466`
- `OrderCustomer` → `schema.prisma:L4173`
- `OrderDiscount` → `schema.prisma:L9136`
- `OrderFulfillment` → `schema.prisma:L16246`
- `OrderFulfillmentLine` → `schema.prisma:L16277`
- `OrderItem` → `schema.prisma:L4209`
- `OrderItemModifier` → `schema.prisma:L4448`
- `OrderItemSelloIva` → `schema.prisma:L17330`
- `OrderPromotion` → `schema.prisma:L18460`
- `OrderServiceCharge` → `schema.prisma:L9225`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13568`
- `OrganizationEntitlement` → `schema.prisma:L11768`
- `OrganizationGoal` → `schema.prisma:L13526`
- `OrganizationModule` → `schema.prisma:L11545`
- `OrganizationPaymentConfig` → `schema.prisma:L6614`
- `OrganizationPayoutConfig` → `schema.prisma:L13601`
- `OrganizationPricingStructure` → `schema.prisma:L6646`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13549`
- `OtpChallenge` → `schema.prisma:L8125`
- `OvertimeApproval` → `schema.prisma:L3635`
- `PartnerAPIKey` → `schema.prisma:L6444`
- `Payment` → `schema.prisma:L4499`
- `PaymentAllocation` → `schema.prisma:L4772`
- `PaymentEffect` → `schema.prisma:L18834`
- `PaymentLink` → `schema.prisma:L15433`
- `PaymentLinkAttribution` → `schema.prisma:L15541`
- `PaymentLinkItem` → `schema.prisma:L15496`
- `PaymentLinkItemModifier` → `schema.prisma:L15523`
- `PaymentProvider` → `schema.prisma:L5999`
- `PayrollLine` → `schema.prisma:L17956`
- `PayrollRun` → `schema.prisma:L17925`
- `PerformanceGoal` → `schema.prisma:L13503`
- `PermissionOverride` → `schema.prisma:L1472`
- `PermissionSet` → `schema.prisma:L1495`
- `PlatformAnnouncement` → `schema.prisma:L18624`
- `PlatformAnnouncementClick` → `schema.prisma:L18689`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18726`
- `PlatformCfdi` → `schema.prisma:L18253`
- `PlatformEmisor` → `schema.prisma:L18193`
- `PlatformSettings` → `schema.prisma:L6421`
- `PosCommand` → `schema.prisma:L9408`
- `PosConnectionStatus` → `schema.prisma:L1014`
- `PosSyncIntent` → `schema.prisma:L18331`
- `PricingPolicy` → `schema.prisma:L2860`
- `Printer` → `schema.prisma:L16047`
- `PrintGateway` → `schema.prisma:L16104`
- `PrintJob` → `schema.prisma:L16827`
- `PrintStation` → `schema.prisma:L16122`
- `PrivacyNoticeVersion` → `schema.prisma:L7873`
- `ProcessedStripeEvent` → `schema.prisma:L7058`
- `ProcessorReliabilityMetric` → `schema.prisma:L7543`
- `Product` → `schema.prisma:L1819`
- `ProductModifierGroup` → `schema.prisma:L4436`
- `ProductOption` → `schema.prisma:L15739`
- `ProductOptionValue` → `schema.prisma:L15750`
- `ProductStaff` → `schema.prisma:L14383`
- `PromoterBankAccount` → `schema.prisma:L18076`
- `PromoterCommissionEntry` → `schema.prisma:L18095`
- `PromoterLocationPing` → `schema.prisma:L3886`
- `Promotion` → `schema.prisma:L18382`
- `PromotionGroup` → `schema.prisma:L18421`
- `PromotionOption` → `schema.prisma:L18437`
- `ProviderCostStructure` → `schema.prisma:L7094`
- `ProviderEventLog` → `schema.prisma:L6723`
- `PurchaseOrder` → `schema.prisma:L2567`
- `PurchaseOrderInvoice` → `schema.prisma:L2712`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2779`
- `PurchaseOrderItem` → `schema.prisma:L2625`
- `RateCorrectionBatch` → `schema.prisma:L7319`
- `RateCorrectionEntry` → `schema.prisma:L7361`
- `RawMaterial` → `schema.prisma:L2323`
- `RawMaterialMovement` → `schema.prisma:L2913`
- `RawMaterialPresentation` → `schema.prisma:L2399`
- `ReceiptLayout` → `schema.prisma:L18868`
- `Recipe` → `schema.prisma:L2419`
- `RecipeLine` → `schema.prisma:L2443`
- `Referral` → `schema.prisma:L8591`
- `ReferralProgramConfig` → `schema.prisma:L8556`
- `ReferralRewardGrant` → `schema.prisma:L8682`
- `ReferralTierReward` → `schema.prisma:L8654`
- `ReferralTierUnlock` → `schema.prisma:L8727`
- `RefreshGrant` → `schema.prisma:L18813`
- `Reservation` → `schema.prisma:L14146`
- `ReservationGoogleEventMapping` → `schema.prisma:L15206`
- `ReservationModifier` → `schema.prisma:L14331`
- `ReservationReminderSent` → `schema.prisma:L14314`
- `ReservationSettings` → `schema.prisma:L14555`
- `ReservationWaitlistEntry` → `schema.prisma:L14523`
- `Review` → `schema.prisma:L5369`
- `SalesRetention` → `schema.prisma:L17776`
- `SaleVerification` → `schema.prisma:L4826`
- `ScaleProfile` → `schema.prisma:L16568`
- `ScheduledCommand` → `schema.prisma:L10969`
- `SerializedItem` → `schema.prisma:L12619`
- `SerializedItemCustodyEvent` → `schema.prisma:L12786`
- `ServiceCharge` → `schema.prisma:L9196`
- `ServiceEarning` → `schema.prisma:L19242`
- `ServicePayPeriod` → `schema.prisma:L19218`
- `ServicePayTable` → `schema.prisma:L19126`
- `ServicePayTableCell` → `schema.prisma:L19168`
- `ServicePayTableVersion` → `schema.prisma:L19143`
- `Session` → `schema.prisma:L18792`
- `SettlementConfiguration` → `schema.prisma:L7394`
- `SettlementConfirmation` → `schema.prisma:L7507`
- `SettlementIncident` → `schema.prisma:L7458`
- `SettlementSimulation` → `schema.prisma:L7429`
- `Shift` → `schema.prisma:L3446`
- `ShopifyConnectIntent` → `schema.prisma:L19563`
- `ShopifyImportIssue` → `schema.prisma:L19617`
- `ShopifyInboundEvent` → `schema.prisma:L19539`
- `ShopifyLocationLink` → `schema.prisma:L19413`
- `ShopifyReviewItem` → `schema.prisma:L19585`
- `ShopifyStockOutbox` → `schema.prisma:L19509`
- `ShopifyStore` → `schema.prisma:L19384`
- `ShopifyVariantLink` → `schema.prisma:L19461`
- `SimRegistrationRequest` → `schema.prisma:L12824`
- `SimRegistrationRequestItem` → `schema.prisma:L12846`
- `SlotHold` → `schema.prisma:L14414`
- `Staff` → `schema.prisma:L1034`
- `StaffAssignment` → `schema.prisma:L3733`
- `StaffDocument` → `schema.prisma:L3757`
- `StaffOnboardingState` → `schema.prisma:L16898`
- `StaffOrganization` → `schema.prisma:L1371`
- `StaffPasskey` → `schema.prisma:L1398`
- `StaffPayLevel` → `schema.prisma:L19090`
- `StaffPayLevelAssignment` → `schema.prisma:L19108`
- `StaffPayStatement` → `schema.prisma:L19274`
- `StaffPayTipWindow` → `schema.prisma:L19636`
- `StaffPayVenueWindow` → `schema.prisma:L19653`
- `StaffPosition` → `schema.prisma:L3712`
- `StaffSchedule` → `schema.prisma:L14354`
- `StaffScheduleException` → `schema.prisma:L14366`
- `StaffVenue` → `schema.prisma:L1295`
- `StaffWorkSchedule` → `schema.prisma:L3571`
- `StaffWorkScheduleException` → `schema.prisma:L3669`
- `StampCard` → `schema.prisma:L8439`
- `StampEvent` → `schema.prisma:L8478`
- `StampReward` → `schema.prisma:L8516`
- `StockAlertConfig` → `schema.prisma:L13485`
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
- `TokenPurchase` → `schema.prisma:L10641`
- `TokenUsageRecord` → `schema.prisma:L10613`
- `TpvCommandHistory` → `schema.prisma:L10875`
- `TpvCommandQueue` → `schema.prisma:L10813`
- `TpvFeedback` → `schema.prisma:L10526`
- `TpvMessage` → `schema.prisma:L13842`
- `TpvMessageDelivery` → `schema.prisma:L13894`
- `TpvMessageResponse` → `schema.prisma:L13917`
- `TrainingModule` → `schema.prisma:L13972`
- `TrainingProgress` → `schema.prisma:L14049`
- `TrainingQuizQuestion` → `schema.prisma:L14031`
- `TrainingStep` → `schema.prisma:L14011`
- `TransactionCost` → `schema.prisma:L7257`
- `UnitConversion` → `schema.prisma:L2891`
- `UpsellAcceptance` → `schema.prisma:L9012`
- `UpsellAiRun` → `schema.prisma:L9032`
- `UpsellImpression` → `schema.prisma:L8972`
- `UpsellRule` → `schema.prisma:L8892`
- `user_sessions` → `schema.prisma:L6479`
- `Venue` → `schema.prisma:L185`
- `VenueAreaTicketSettings` → `schema.prisma:L16305`
- `VenueChatMessage` → `schema.prisma:L842`
- `VenueChatSession` → `schema.prisma:L797`
- `VenueCommission` → `schema.prisma:L15900`
- `VenueCreditAssessment` → `schema.prisma:L11357`
- `VenueCryptoConfig` → `schema.prisma:L13709`
- `VenueFeature` → `schema.prisma:L4940`
- `VenueIvaPorProducto` → `schema.prisma:L997`
- `VenueModule` → `schema.prisma:L11517`
- `VenuePaymentConfig` → `schema.prisma:L6580`
- `VenuePaymentLinkSettings` → `schema.prisma:L15239`
- `VenuePosSinAparato` → `schema.prisma:L1008`
- `VenuePricingStructure` → `schema.prisma:L7197`
- `VenueRoleConfig` → `schema.prisma:L1524`
- `VenueRolePermission` → `schema.prisma:L1428`
- `VenueScaleSettings` → `schema.prisma:L16556`
- `VenueSettings` → `schema.prisma:L882`
- `VenueTenderType` → `schema.prisma:L4685`
- `VenueTenderTypeRevision` → `schema.prisma:L4750`
- `VenueTransaction` → `schema.prisma:L4877`
- `VenueWhatsappActivation` → `schema.prisma:L733`
- `WalletCardDesign` → `schema.prisma:L8357`
- `WalletPass` → `schema.prisma:L8258`
- `WalletPassRegistration` → `schema.prisma:L8324`
- `WebhookEvent` → `schema.prisma:L5278`
- `WebhookSubscription` → `schema.prisma:L6696`
- `WhatsappContactWindow` → `schema.prisma:L751`
- `WhatsappInboundEvent` → `schema.prisma:L771`
- `WorkShiftAssignment` → `schema.prisma:L3611`
- `WorkShiftTemplate` → `schema.prisma:L3588`
- `Zone` → `schema.prisma:L168`
