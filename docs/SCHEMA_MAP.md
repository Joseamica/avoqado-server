# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **417 models / 389 enums / ~19,400 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `InventoryWasteReport`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `ShopifyConnectIntent`, `ShopifyImportIssue`, `ShopifyInboundEvent`, `ShopifyLocationLink`, `ShopifyReviewItem`, `ShopifyStockOutbox`, `ShopifyStore`, `ShopifyVariantLink`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`            |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryConnectIntent`, `DeliveryLineAction`, `DeliveryOrderEvent`, `DeliveryStoreRevocation`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                                                                                                      |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CfdiGlobalOrden`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `OrderItemSelloIva`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                                                                                                |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `ClassSessionPayState`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `ServiceEarning`, `ServicePayPeriod`, `ServicePayTable`, `ServicePayTableCell`, `ServicePayTableVersion`, `StaffPayLevel`, `StaffPayLevelAssignment`, `StaffPayStatement`, `VenueCommission`                                                                                                                                                                                                                                                |
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

- `AccountingPeriodLock` → `schema.prisma:L17475`
- `AccountMapping` → `schema.prisma:L17370`
- `ActivityLog` → `schema.prisma:L7555`
- `Aggregator` → `schema.prisma:L15646`
- `AggregatorBooking` → `schema.prisma:L14954`
- `AggregatorCapacityRule` → `schema.prisma:L14935`
- `AggregatorConnection` → `schema.prisma:L14860`
- `AggregatorInboundEvent` → `schema.prisma:L15023`
- `AggregatorOutbox` → `schema.prisma:L15043`
- `AggregatorProductLink` → `schema.prisma:L14892`
- `AggregatorSessionLink` → `schema.prisma:L14911`
- `AggregatorVisit` → `schema.prisma:L14980`
- `AngelPayUserAccount` → `schema.prisma:L6100`
- `AppUpdate` → `schema.prisma:L13527`
- `Area` → `schema.prisma:L3287`
- `AreaTicket` → `schema.prisma:L16182`
- `AreaTicketCheckoutSession` → `schema.prisma:L16304`
- `AreaTicketExternalIncident` → `schema.prisma:L16551`
- `AreaTicketExternalSettlement` → `schema.prisma:L16516`
- `AreaTicketFulfillment` → `schema.prisma:L16380`
- `AreaTicketInventoryReservation` → `schema.prisma:L16275`
- `AreaTicketLine` → `schema.prisma:L16243`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16336`
- `AreaTicketPrintAttempt` → `schema.prisma:L16359`
- `BankStatement` → `schema.prisma:L17244`
- `BankStatementLine` → `schema.prisma:L17265`
- `BillingObligationConflict` → `schema.prisma:L5130`
- `BillingTaxProfile` → `schema.prisma:L18067`
- `BirthdayAutomation` → `schema.prisma:L7879`
- `BulkCommandOperation` → `schema.prisma:L10807`
- `CalendarSyncOutbox` → `schema.prisma:L14743`
- `CampaignDelivery` → `schema.prisma:L13685`
- `CapabilityGrant` → `schema.prisma:L4870`
- `CashCloseout` → `schema.prisma:L11192`
- `CashDeposit` → `schema.prisma:L13329`
- `CashDrawerEvent` → `schema.prisma:L15483`
- `CashDrawerSession` → `schema.prisma:L15444`
- `CashOutCommissionRate` → `schema.prisma:L17884`
- `CashOutScheduleDay` → `schema.prisma:L17907`
- `CashOutWithdrawal` → `schema.prisma:L17969`
- `CatalogBindingBatch` → `schema.prisma:L12223`
- `CatalogBindingLine` → `schema.prisma:L12259`
- `CatalogBrand` → `schema.prisma:L11676`
- `CatalogClientObservation` → `schema.prisma:L11989`
- `CatalogClientReadinessOverride` → `schema.prisma:L12008`
- `CatalogFamily` → `schema.prisma:L11726`
- `CatalogIdempotencyRecord` → `schema.prisma:L12122`
- `CatalogIdentifier` → `schema.prisma:L11857`
- `CatalogImportBatch` → `schema.prisma:L12165`
- `CatalogImportLine` → `schema.prisma:L12202`
- `CatalogItem` → `schema.prisma:L11759`
- `CatalogItemBusinessType` → `schema.prisma:L11819`
- `CatalogItemPrice` → `schema.prisma:L11907`
- `CatalogManufacturer` → `schema.prisma:L11700`
- `CatalogProductTypeMapping` → `schema.prisma:L11836`
- `CatalogPublicationBatch` → `schema.prisma:L12287`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12381`
- `CatalogPublicationLine` → `schema.prisma:L12328`
- `CatalogPublicationOutbox` → `schema.prisma:L12424`
- `CatalogValidationProfile` → `schema.prisma:L11878`
- `CatalogVenueBinding` → `schema.prisma:L12036`
- `CatalogVenueClientRequirement` → `schema.prisma:L11963`
- `CatalogVenueEventSequence` → `schema.prisma:L12407`
- `CatalogVenueOverride` → `schema.prisma:L12078`
- `CatalogVenueRollout` → `schema.prisma:L11938`
- `Cfdi` → `schema.prisma:L17072`
- `CfdiGlobalOrden` → `schema.prisma:L17197`
- `ChatbotTokenBudget` → `schema.prisma:L10453`
- `ChatConversation` → `schema.prisma:L10308`
- `ChatFeedback` → `schema.prisma:L10394`
- `ChatLearningEvent` → `schema.prisma:L10351`
- `ChatMessage` → `schema.prisma:L10331`
- `ChatTrainingData` → `schema.prisma:L10265`
- `CheckoutSession` → `schema.prisma:L6380`
- `ClassSession` → `schema.prisma:L14343`
- `ClassSessionPayState` → `schema.prisma:L19022`
- `CommissionCalculation` → `schema.prisma:L13105`
- `CommissionClawback` → `schema.prisma:L13281`
- `CommissionConfig` → `schema.prisma:L12871`
- `CommissionMilestone` → `schema.prisma:L13021`
- `CommissionOverride` → `schema.prisma:L12948`
- `CommissionPayout` → `schema.prisma:L13232`
- `CommissionSummary` → `schema.prisma:L13171`
- `CommissionTier` → `schema.prisma:L12985`
- `ConsentEvent` → `schema.prisma:L7741`
- `Consumer` → `schema.prisma:L7971`
- `ConsumerAuthAccount` → `schema.prisma:L7996`
- `CouponCode` → `schema.prisma:L8943`
- `CouponRedemption` → `schema.prisma:L8974`
- `CreditAssessmentHistory` → `schema.prisma:L11301`
- `CreditItemBalance` → `schema.prisma:L15234`
- `CreditOffer` → `schema.prisma:L11320`
- `CreditPack` → `schema.prisma:L15143`
- `CreditPackItem` → `schema.prisma:L15172`
- `CreditPackPurchase` → `schema.prisma:L15189`
- `CreditTransaction` → `schema.prisma:L15256`
- `Customer` → `schema.prisma:L7596`
- `CustomerApprovalDelivery` → `schema.prisma:L9966`
- `CustomerApprovalOutbox` → `schema.prisma:L9941`
- `CustomerCampaign` → `schema.prisma:L7829`
- `CustomerCampaignDelivery` → `schema.prisma:L7911`
- `CustomerCaptureToken` → `schema.prisma:L7777`
- `CustomerDiscount` → `schema.prisma:L8994`
- `CustomerExternalIdentity` → `schema.prisma:L15010`
- `CustomerGroup` → `schema.prisma:L8035`
- `CustomerOrderMetric` → `schema.prisma:L4086`
- `CustomerTaxProfile` → `schema.prisma:L17216`
- `DeliveryActivationRequest` → `schema.prisma:L6839`
- `DeliveryChannelLink` → `schema.prisma:L6678`
- `DeliveryConnectIntent` → `schema.prisma:L6790`
- `DeliveryLineAction` → `schema.prisma:L6751`
- `DeliveryOrderEvent` → `schema.prisma:L6863`
- `DeliveryStoreRevocation` → `schema.prisma:L6827`
- `DeviceToken` → `schema.prisma:L9268`
- `DigitalReceipt` → `schema.prisma:L4683`
- `Discount` → `schema.prisma:L8633`
- `EcommerceMerchant` → `schema.prisma:L6192`
- `EmailQuotaLedger` → `schema.prisma:L7958`
- `EmailSuppression` → `schema.prisma:L7946`
- `EmailTemplate` → `schema.prisma:L13624`
- `Employee` → `schema.prisma:L17732`
- `Estimate` → `schema.prisma:L15553`
- `EstimateItem` → `schema.prisma:L15581`
- `Expense` → `schema.prisma:L17519`
- `ExternalBusyBlock` → `schema.prisma:L14636`
- `Feature` → `schema.prisma:L4812`
- `FeeSchedule` → `schema.prisma:L5192`
- `FeeTier` → `schema.prisma:L5203`
- `FinancialAccount` → `schema.prisma:L15743`
- `FinancialConnection` → `schema.prisma:L15712`
- `FinancialProvider` → `schema.prisma:L15698`
- `FiscalEmisor` → `schema.prisma:L16988`
- `FiscalLossCarryforward` → `schema.prisma:L17642`
- `FixedAsset` → `schema.prisma:L17660`
- `FixedAssetDepreciation` → `schema.prisma:L17689`
- `FloorElement` → `schema.prisma:L3363`
- `FulfillmentArea` → `schema.prisma:L16047`
- `GeofenceRule` → `schema.prisma:L10892`
- `GoogleCalendarChannel` → `schema.prisma:L14613`
- `GoogleCalendarConnection` → `schema.prisma:L14565`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14666`
- `GoogleOAuthSession` → `schema.prisma:L14688`
- `HolidayCalendar` → `schema.prisma:L7479`
- `HybridBillingOperation` → `schema.prisma:L5054`
- `HybridCampaign` → `schema.prisma:L4895`
- `HybridContract` → `schema.prisma:L5011`
- `HybridContractSelection` → `schema.prisma:L5043`
- `HybridCreditAllocation` → `schema.prisma:L5110`
- `HybridOfferPublication` → `schema.prisma:L4958`
- `HybridPaymentPeriod` → `schema.prisma:L5089`
- `HybridPromotionGroup` → `schema.prisma:L4939`
- `HybridPurchase` → `schema.prisma:L4978`
- `HybridRedemption` → `schema.prisma:L5072`
- `IdempotencyRequest` → `schema.prisma:L12746`
- `InterVenueTransfer` → `schema.prisma:L3115`
- `InterVenueTransferAllocation` → `schema.prisma:L3198`
- `InterVenueTransferItem` → `schema.prisma:L3167`
- `InterVenueTransferReceipt` → `schema.prisma:L3225`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3241`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3269`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3253`
- `Inventory` → `schema.prisma:L2037`
- `InventoryMovement` → `schema.prisma:L2137`
- `InventoryPosting` → `schema.prisma:L2232`
- `InventoryPostingLine` → `schema.prisma:L2272`
- `InventoryTransfer` → `schema.prisma:L15525`
- `InventoryWasteReport` → `schema.prisma:L2092`
- `Invitation` → `schema.prisma:L1529`
- `Invoice` → `schema.prisma:L5215`
- `InvoiceItem` → `schema.prisma:L5241`
- `ItemCategory` → `schema.prisma:L12459`
- `JournalEntry` → `schema.prisma:L17428`
- `JournalLine` → `schema.prisma:L17457`
- `KdsOrder` → `schema.prisma:L15791`
- `KdsOrderItem` → `schema.prisma:L15854`
- `KioskCheckInAttempt` → `schema.prisma:L18390`
- `KioskCheckInChallenge` → `schema.prisma:L18344`
- `KioskOutreachOutbox` → `schema.prisma:L18411`
- `LaunchCampaign` → `schema.prisma:L18749`
- `LaunchCampaignRedemption` → `schema.prisma:L18866`
- `LearnedPatterns` → `schema.prisma:L10375`
- `LedgerAccount` → `schema.prisma:L17320`
- `LiveDemoSession` → `schema.prisma:L854`
- `LowStockAlert` → `schema.prisma:L2945`
- `LoyaltyConfig` → `schema.prisma:L8065`
- `LoyaltyTransaction` → `schema.prisma:L8108`
- `MarketingCampaign` → `schema.prisma:L13642`
- `McpAuthCode` → `schema.prisma:L16870`
- `McpOAuthClient` → `schema.prisma:L16854`
- `McpRefreshToken` → `schema.prisma:L16888`
- `McpToolCall` → `schema.prisma:L16910`
- `MeasurementUnit` → `schema.prisma:L15631`
- `Menu` → `schema.prisma:L1747`
- `MenuCategory` → `schema.prisma:L1684`
- `MenuCategoryAssignment` → `schema.prisma:L1782`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16784`
- `MerchantAccount` → `schema.prisma:L5930`
- `MerchantFiscalConfig` → `schema.prisma:L17043`
- `MerchantRevenueShare` → `schema.prisma:L7059`
- `MerchantRoutingRule` → `schema.prisma:L6052`
- `MilestoneAchievement` → `schema.prisma:L13066`
- `Modifier` → `schema.prisma:L4285`
- `ModifierGroup` → `schema.prisma:L4249`
- `Module` → `schema.prisma:L11368`
- `MoneyAnomaly` → `schema.prisma:L6962`
- `MonthlyVenueProfit` → `schema.prisma:L7505`
- `Notification` → `schema.prisma:L9170`
- `NotificationPreference` → `schema.prisma:L9217`
- `NotificationTemplate` → `schema.prisma:L9244`
- `OAuthState` → `schema.prisma:L1580`
- `OnboardingProgress` → `schema.prisma:L1598`
- `Order` → `schema.prisma:L3812`
- `OrderAction` → `schema.prisma:L4356`
- `OrderCustomer` → `schema.prisma:L4065`
- `OrderDiscount` → `schema.prisma:L9026`
- `OrderFulfillment` → `schema.prisma:L16102`
- `OrderFulfillmentLine` → `schema.prisma:L16133`
- `OrderItem` → `schema.prisma:L4101`
- `OrderItemModifier` → `schema.prisma:L4338`
- `OrderItemSelloIva` → `schema.prisma:L17177`
- `OrderPromotion` → `schema.prisma:L18307`
- `OrderServiceCharge` → `schema.prisma:L9115`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13443`
- `OrganizationEntitlement` → `schema.prisma:L11651`
- `OrganizationGoal` → `schema.prisma:L13401`
- `OrganizationModule` → `schema.prisma:L11428`
- `OrganizationPaymentConfig` → `schema.prisma:L6504`
- `OrganizationPayoutConfig` → `schema.prisma:L13476`
- `OrganizationPricingStructure` → `schema.prisma:L6536`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13424`
- `OtpChallenge` → `schema.prisma:L8015`
- `OvertimeApproval` → `schema.prisma:L3590`
- `PartnerAPIKey` → `schema.prisma:L6334`
- `Payment` → `schema.prisma:L4389`
- `PaymentAllocation` → `schema.prisma:L4662`
- `PaymentEffect` → `schema.prisma:L18681`
- `PaymentLink` → `schema.prisma:L15302`
- `PaymentLinkAttribution` → `schema.prisma:L15410`
- `PaymentLinkItem` → `schema.prisma:L15365`
- `PaymentLinkItemModifier` → `schema.prisma:L15392`
- `PaymentProvider` → `schema.prisma:L5889`
- `PayrollLine` → `schema.prisma:L17803`
- `PayrollRun` → `schema.prisma:L17772`
- `PerformanceGoal` → `schema.prisma:L13378`
- `PermissionOverride` → `schema.prisma:L1453`
- `PermissionSet` → `schema.prisma:L1476`
- `PlatformAnnouncement` → `schema.prisma:L18471`
- `PlatformAnnouncementClick` → `schema.prisma:L18536`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18573`
- `PlatformCfdi` → `schema.prisma:L18100`
- `PlatformEmisor` → `schema.prisma:L18040`
- `PlatformSettings` → `schema.prisma:L6311`
- `PosCommand` → `schema.prisma:L9298`
- `PosConnectionStatus` → `schema.prisma:L998`
- `PosSyncIntent` → `schema.prisma:L18178`
- `PricingPolicy` → `schema.prisma:L2841`
- `Printer` → `schema.prisma:L15903`
- `PrintGateway` → `schema.prisma:L15960`
- `PrintJob` → `schema.prisma:L16683`
- `PrintStation` → `schema.prisma:L15978`
- `PrivacyNoticeVersion` → `schema.prisma:L7763`
- `ProcessedStripeEvent` → `schema.prisma:L6948`
- `ProcessorReliabilityMetric` → `schema.prisma:L7433`
- `Product` → `schema.prisma:L1800`
- `ProductModifierGroup` → `schema.prisma:L4326`
- `ProductOption` → `schema.prisma:L15608`
- `ProductOptionValue` → `schema.prisma:L15619`
- `ProductStaff` → `schema.prisma:L14258`
- `PromoterBankAccount` → `schema.prisma:L17923`
- `PromoterCommissionEntry` → `schema.prisma:L17942`
- `PromoterLocationPing` → `schema.prisma:L3778`
- `Promotion` → `schema.prisma:L18229`
- `PromotionGroup` → `schema.prisma:L18268`
- `PromotionOption` → `schema.prisma:L18284`
- `ProviderCostStructure` → `schema.prisma:L6984`
- `ProviderEventLog` → `schema.prisma:L6613`
- `PurchaseOrder` → `schema.prisma:L2548`
- `PurchaseOrderInvoice` → `schema.prisma:L2693`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2760`
- `PurchaseOrderItem` → `schema.prisma:L2606`
- `RateCorrectionBatch` → `schema.prisma:L7209`
- `RateCorrectionEntry` → `schema.prisma:L7251`
- `RawMaterial` → `schema.prisma:L2304`
- `RawMaterialMovement` → `schema.prisma:L2894`
- `RawMaterialPresentation` → `schema.prisma:L2380`
- `ReceiptLayout` → `schema.prisma:L18715`
- `Recipe` → `schema.prisma:L2400`
- `RecipeLine` → `schema.prisma:L2424`
- `Referral` → `schema.prisma:L8481`
- `ReferralProgramConfig` → `schema.prisma:L8446`
- `ReferralRewardGrant` → `schema.prisma:L8572`
- `ReferralTierReward` → `schema.prisma:L8544`
- `ReferralTierUnlock` → `schema.prisma:L8617`
- `RefreshGrant` → `schema.prisma:L18660`
- `Reservation` → `schema.prisma:L14021`
- `ReservationGoogleEventMapping` → `schema.prisma:L15075`
- `ReservationModifier` → `schema.prisma:L14206`
- `ReservationReminderSent` → `schema.prisma:L14189`
- `ReservationSettings` → `schema.prisma:L14424`
- `ReservationWaitlistEntry` → `schema.prisma:L14392`
- `Review` → `schema.prisma:L5259`
- `SalesRetention` → `schema.prisma:L17623`
- `SaleVerification` → `schema.prisma:L4716`
- `ScaleProfile` → `schema.prisma:L16424`
- `ScheduledCommand` → `schema.prisma:L10852`
- `SerializedItem` → `schema.prisma:L12502`
- `SerializedItemCustodyEvent` → `schema.prisma:L12669`
- `ServiceCharge` → `schema.prisma:L9086`
- `ServiceEarning` → `schema.prisma:L19082`
- `ServicePayPeriod` → `schema.prisma:L19058`
- `ServicePayTable` → `schema.prisma:L18973`
- `ServicePayTableCell` → `schema.prisma:L19010`
- `ServicePayTableVersion` → `schema.prisma:L18990`
- `Session` → `schema.prisma:L18639`
- `SettlementConfiguration` → `schema.prisma:L7284`
- `SettlementConfirmation` → `schema.prisma:L7397`
- `SettlementIncident` → `schema.prisma:L7348`
- `SettlementSimulation` → `schema.prisma:L7319`
- `Shift` → `schema.prisma:L3401`
- `ShopifyConnectIntent` → `schema.prisma:L19382`
- `ShopifyImportIssue` → `schema.prisma:L19427`
- `ShopifyInboundEvent` → `schema.prisma:L19359`
- `ShopifyLocationLink` → `schema.prisma:L19242`
- `ShopifyReviewItem` → `schema.prisma:L19400`
- `ShopifyStockOutbox` → `schema.prisma:L19329`
- `ShopifyStore` → `schema.prisma:L19220`
- `ShopifyVariantLink` → `schema.prisma:L19290`
- `SimRegistrationRequest` → `schema.prisma:L12707`
- `SimRegistrationRequestItem` → `schema.prisma:L12729`
- `SlotHold` → `schema.prisma:L14289`
- `Staff` → `schema.prisma:L1018`
- `StaffDocument` → `schema.prisma:L3649`
- `StaffOnboardingState` → `schema.prisma:L16754`
- `StaffOrganization` → `schema.prisma:L1352`
- `StaffPasskey` → `schema.prisma:L1379`
- `StaffPayLevel` → `schema.prisma:L18937`
- `StaffPayLevelAssignment` → `schema.prisma:L18955`
- `StaffPayStatement` → `schema.prisma:L19112`
- `StaffSchedule` → `schema.prisma:L14229`
- `StaffScheduleException` → `schema.prisma:L14241`
- `StaffVenue` → `schema.prisma:L1276`
- `StaffWorkSchedule` → `schema.prisma:L3526`
- `StaffWorkScheduleException` → `schema.prisma:L3624`
- `StampCard` → `schema.prisma:L8329`
- `StampEvent` → `schema.prisma:L8368`
- `StampReward` → `schema.prisma:L8406`
- `StockAlertConfig` → `schema.prisma:L13360`
- `StockBatch` → `schema.prisma:L3064`
- `StockCount` → `schema.prisma:L2977`
- `StockCountItem` → `schema.prisma:L3005`
- `StripeWebhookEvent` → `schema.prisma:L6931`
- `Supplier` → `schema.prisma:L2459`
- `SupplierItemCode` → `schema.prisma:L2804`
- `SupplierPricing` → `schema.prisma:L2514`
- `Table` → `schema.prisma:L3313`
- `Terminal` → `schema.prisma:L5310`
- `TerminalAttemptResolution` → `schema.prisma:L5748`
- `TerminalHealth` → `schema.prisma:L5568`
- `TerminalLog` → `schema.prisma:L5542`
- `TerminalOrder` → `schema.prisma:L5792`
- `TerminalOrderItem` → `schema.prisma:L5867`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5720`
- `TerminalPaymentRequest` → `schema.prisma:L5639`
- `TimeEntry` → `schema.prisma:L3691`
- `TimeEntryBreak` → `schema.prisma:L3760`
- `TokenPurchase` → `schema.prisma:L10524`
- `TokenUsageRecord` → `schema.prisma:L10496`
- `TpvCommandHistory` → `schema.prisma:L10758`
- `TpvCommandQueue` → `schema.prisma:L10696`
- `TpvFeedback` → `schema.prisma:L10409`
- `TpvMessage` → `schema.prisma:L13717`
- `TpvMessageDelivery` → `schema.prisma:L13769`
- `TpvMessageResponse` → `schema.prisma:L13792`
- `TrainingModule` → `schema.prisma:L13847`
- `TrainingProgress` → `schema.prisma:L13924`
- `TrainingQuizQuestion` → `schema.prisma:L13906`
- `TrainingStep` → `schema.prisma:L13886`
- `TransactionCost` → `schema.prisma:L7147`
- `UnitConversion` → `schema.prisma:L2872`
- `UpsellAcceptance` → `schema.prisma:L8902`
- `UpsellAiRun` → `schema.prisma:L8922`
- `UpsellImpression` → `schema.prisma:L8862`
- `UpsellRule` → `schema.prisma:L8782`
- `user_sessions` → `schema.prisma:L6369`
- `Venue` → `schema.prisma:L176`
- `VenueAreaTicketSettings` → `schema.prisma:L16161`
- `VenueChatMessage` → `schema.prisma:L830`
- `VenueChatSession` → `schema.prisma:L785`
- `VenueCommission` → `schema.prisma:L15769`
- `VenueCreditAssessment` → `schema.prisma:L11240`
- `VenueCryptoConfig` → `schema.prisma:L13584`
- `VenueFeature` → `schema.prisma:L4830`
- `VenueIvaPorProducto` → `schema.prisma:L981`
- `VenueModule` → `schema.prisma:L11400`
- `VenuePaymentConfig` → `schema.prisma:L6470`
- `VenuePaymentLinkSettings` → `schema.prisma:L15108`
- `VenuePosSinAparato` → `schema.prisma:L992`
- `VenuePricingStructure` → `schema.prisma:L7087`
- `VenueRoleConfig` → `schema.prisma:L1505`
- `VenueRolePermission` → `schema.prisma:L1409`
- `VenueScaleSettings` → `schema.prisma:L16412`
- `VenueSettings` → `schema.prisma:L870`
- `VenueTenderType` → `schema.prisma:L4575`
- `VenueTenderTypeRevision` → `schema.prisma:L4640`
- `VenueTransaction` → `schema.prisma:L4767`
- `VenueWhatsappActivation` → `schema.prisma:L721`
- `WalletCardDesign` → `schema.prisma:L8247`
- `WalletPass` → `schema.prisma:L8148`
- `WalletPassRegistration` → `schema.prisma:L8214`
- `WebhookEvent` → `schema.prisma:L5168`
- `WebhookSubscription` → `schema.prisma:L6586`
- `WhatsappContactWindow` → `schema.prisma:L739`
- `WhatsappInboundEvent` → `schema.prisma:L759`
- `WorkShiftAssignment` → `schema.prisma:L3566`
- `WorkShiftTemplate` → `schema.prisma:L3543`
- `Zone` → `schema.prisma:L159`
