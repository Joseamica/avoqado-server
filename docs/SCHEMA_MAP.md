# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **424 models / 395 enums / ~19,700 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
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

- `AccountingPeriodLock` → `schema.prisma:L17636`
- `AccountMapping` → `schema.prisma:L17531`
- `ActivityLog` → `schema.prisma:L7670`
- `Aggregator` → `schema.prisma:L15782`
- `AggregatorBooking` → `schema.prisma:L15090`
- `AggregatorCapacityRule` → `schema.prisma:L15071`
- `AggregatorConnection` → `schema.prisma:L14996`
- `AggregatorInboundEvent` → `schema.prisma:L15159`
- `AggregatorOutbox` → `schema.prisma:L15179`
- `AggregatorProductLink` → `schema.prisma:L15028`
- `AggregatorSessionLink` → `schema.prisma:L15047`
- `AggregatorVisit` → `schema.prisma:L15116`
- `AngelPayUserAccount` → `schema.prisma:L6215`
- `AppUpdate` → `schema.prisma:L13657`
- `Area` → `schema.prisma:L3310`
- `AreaTicket` → `schema.prisma:L16331`
- `AreaTicketCheckoutSession` → `schema.prisma:L16453`
- `AreaTicketExternalIncident` → `schema.prisma:L16700`
- `AreaTicketExternalSettlement` → `schema.prisma:L16665`
- `AreaTicketFulfillment` → `schema.prisma:L16529`
- `AreaTicketInventoryReservation` → `schema.prisma:L16424`
- `AreaTicketLine` → `schema.prisma:L16392`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16485`
- `AreaTicketPrintAttempt` → `schema.prisma:L16508`
- `BankStatement` → `schema.prisma:L17405`
- `BankStatementLine` → `schema.prisma:L17426`
- `BillingObligationConflict` → `schema.prisma:L5245`
- `BillingTaxProfile` → `schema.prisma:L18228`
- `BirthdayAutomation` → `schema.prisma:L7994`
- `BulkCommandOperation` → `schema.prisma:L10929`
- `CalendarSyncOutbox` → `schema.prisma:L14879`
- `CampaignDelivery` → `schema.prisma:L13815`
- `CapabilityGrant` → `schema.prisma:L4985`
- `CashCloseout` → `schema.prisma:L11314`
- `CashDeposit` → `schema.prisma:L13459`
- `CashDrawerEvent` → `schema.prisma:L15619`
- `CashDrawerSession` → `schema.prisma:L15580`
- `CashOutCommissionRate` → `schema.prisma:L18045`
- `CashOutScheduleDay` → `schema.prisma:L18068`
- `CashOutWithdrawal` → `schema.prisma:L18130`
- `CatalogBindingBatch` → `schema.prisma:L12345`
- `CatalogBindingLine` → `schema.prisma:L12381`
- `CatalogBrand` → `schema.prisma:L11798`
- `CatalogClientObservation` → `schema.prisma:L12111`
- `CatalogClientReadinessOverride` → `schema.prisma:L12130`
- `CatalogFamily` → `schema.prisma:L11848`
- `CatalogIdempotencyRecord` → `schema.prisma:L12244`
- `CatalogIdentifier` → `schema.prisma:L11979`
- `CatalogImportBatch` → `schema.prisma:L12287`
- `CatalogImportLine` → `schema.prisma:L12324`
- `CatalogItem` → `schema.prisma:L11881`
- `CatalogItemBusinessType` → `schema.prisma:L11941`
- `CatalogItemPrice` → `schema.prisma:L12029`
- `CatalogManufacturer` → `schema.prisma:L11822`
- `CatalogProductTypeMapping` → `schema.prisma:L11958`
- `CatalogPublicationBatch` → `schema.prisma:L12409`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12503`
- `CatalogPublicationLine` → `schema.prisma:L12450`
- `CatalogPublicationOutbox` → `schema.prisma:L12546`
- `CatalogValidationProfile` → `schema.prisma:L12000`
- `CatalogVenueBinding` → `schema.prisma:L12158`
- `CatalogVenueClientRequirement` → `schema.prisma:L12085`
- `CatalogVenueEventSequence` → `schema.prisma:L12529`
- `CatalogVenueOverride` → `schema.prisma:L12200`
- `CatalogVenueRollout` → `schema.prisma:L12060`
- `Cfdi` → `schema.prisma:L17227`
- `CfdiGlobalOrden` → `schema.prisma:L17358`
- `ChatbotTokenBudget` → `schema.prisma:L10575`
- `ChatConversation` → `schema.prisma:L10430`
- `ChatFeedback` → `schema.prisma:L10516`
- `ChatLearningEvent` → `schema.prisma:L10473`
- `ChatMessage` → `schema.prisma:L10453`
- `ChatTrainingData` → `schema.prisma:L10387`
- `CheckoutSession` → `schema.prisma:L6495`
- `ClassSession` → `schema.prisma:L14473`
- `ClassSessionPayState` → `schema.prisma:L19188`
- `CommissionCalculation` → `schema.prisma:L13234`
- `CommissionClawback` → `schema.prisma:L13411`
- `CommissionConfig` → `schema.prisma:L12993`
- `CommissionMilestone` → `schema.prisma:L13150`
- `CommissionOverride` → `schema.prisma:L13077`
- `CommissionPayout` → `schema.prisma:L13362`
- `CommissionSummary` → `schema.prisma:L13301`
- `CommissionTier` → `schema.prisma:L13114`
- `ConsentEvent` → `schema.prisma:L7856`
- `Consumer` → `schema.prisma:L8086`
- `ConsumerAuthAccount` → `schema.prisma:L8111`
- `CouponCode` → `schema.prisma:L9058`
- `CouponRedemption` → `schema.prisma:L9089`
- `CreditAssessmentHistory` → `schema.prisma:L11423`
- `CreditItemBalance` → `schema.prisma:L15370`
- `CreditOffer` → `schema.prisma:L11442`
- `CreditPack` → `schema.prisma:L15279`
- `CreditPackItem` → `schema.prisma:L15308`
- `CreditPackPurchase` → `schema.prisma:L15325`
- `CreditTransaction` → `schema.prisma:L15392`
- `Customer` → `schema.prisma:L7711`
- `CustomerApprovalDelivery` → `schema.prisma:L10088`
- `CustomerApprovalOutbox` → `schema.prisma:L10063`
- `CustomerCampaign` → `schema.prisma:L7944`
- `CustomerCampaignDelivery` → `schema.prisma:L8026`
- `CustomerCaptureToken` → `schema.prisma:L7892`
- `CustomerDiscount` → `schema.prisma:L9109`
- `CustomerExternalIdentity` → `schema.prisma:L15146`
- `CustomerGroup` → `schema.prisma:L8150`
- `CustomerOrderMetric` → `schema.prisma:L4199`
- `CustomerTaxProfile` → `schema.prisma:L17377`
- `DeliveryActivationRequest` → `schema.prisma:L6954`
- `DeliveryChannelLink` → `schema.prisma:L6793`
- `DeliveryConnectIntent` → `schema.prisma:L6905`
- `DeliveryLineAction` → `schema.prisma:L6866`
- `DeliveryOrderEvent` → `schema.prisma:L6978`
- `DeliveryStoreRevocation` → `schema.prisma:L6942`
- `DeviceToken` → `schema.prisma:L9383`
- `DigitalReceipt` → `schema.prisma:L4798`
- `Discount` → `schema.prisma:L8748`
- `EcommerceMerchant` → `schema.prisma:L6307`
- `EmailQuotaLedger` → `schema.prisma:L8073`
- `EmailSuppression` → `schema.prisma:L8061`
- `EmailTemplate` → `schema.prisma:L13754`
- `Employee` → `schema.prisma:L17893`
- `Estimate` → `schema.prisma:L15689`
- `EstimateItem` → `schema.prisma:L15717`
- `Expense` → `schema.prisma:L17680`
- `ExternalBusyBlock` → `schema.prisma:L14772`
- `Feature` → `schema.prisma:L4927`
- `FeeSchedule` → `schema.prisma:L5307`
- `FeeTier` → `schema.prisma:L5318`
- `FinancialAccount` → `schema.prisma:L15879`
- `FinancialConnection` → `schema.prisma:L15848`
- `FinancialProvider` → `schema.prisma:L15834`
- `FiscalEmisor` → `schema.prisma:L17138`
- `FiscalLossCarryforward` → `schema.prisma:L17803`
- `FixedAsset` → `schema.prisma:L17821`
- `FixedAssetDepreciation` → `schema.prisma:L17850`
- `FloorElement` → `schema.prisma:L3395`
- `FloorPlanPublication` → `schema.prisma:L3435`
- `FulfillmentArea` → `schema.prisma:L16196`
- `GeofenceRule` → `schema.prisma:L11014`
- `GoogleCalendarChannel` → `schema.prisma:L14749`
- `GoogleCalendarConnection` → `schema.prisma:L14701`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14802`
- `GoogleOAuthSession` → `schema.prisma:L14824`
- `HolidayCalendar` → `schema.prisma:L7594`
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
- `IdempotencyRequest` → `schema.prisma:L12868`
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
- `InventoryTransfer` → `schema.prisma:L15661`
- `InventoryWasteReport` → `schema.prisma:L2115`
- `Invitation` → `schema.prisma:L1550`
- `Invoice` → `schema.prisma:L5330`
- `InvoiceItem` → `schema.prisma:L5356`
- `ItemCategory` → `schema.prisma:L12581`
- `JournalEntry` → `schema.prisma:L17589`
- `JournalLine` → `schema.prisma:L17618`
- `KdsOrder` → `schema.prisma:L15927`
- `KdsOrderItem` → `schema.prisma:L15994`
- `KioskCheckInAttempt` → `schema.prisma:L18551`
- `KioskCheckInChallenge` → `schema.prisma:L18505`
- `KioskOutreachOutbox` → `schema.prisma:L18572`
- `LaunchCampaign` → `schema.prisma:L18910`
- `LaunchCampaignRedemption` → `schema.prisma:L19027`
- `LearnedPatterns` → `schema.prisma:L10497`
- `LedgerAccount` → `schema.prisma:L17481`
- `LiveDemoSession` → `schema.prisma:L868`
- `LowStockAlert` → `schema.prisma:L2968`
- `LoyaltyConfig` → `schema.prisma:L8180`
- `LoyaltyTransaction` → `schema.prisma:L8223`
- `MarketingCampaign` → `schema.prisma:L13772`
- `McpAuthCode` → `schema.prisma:L17019`
- `McpOAuthClient` → `schema.prisma:L17003`
- `McpRefreshToken` → `schema.prisma:L17037`
- `McpToolCall` → `schema.prisma:L17059`
- `MeasurementUnit` → `schema.prisma:L15767`
- `Menu` → `schema.prisma:L1768`
- `MenuCategory` → `schema.prisma:L1705`
- `MenuCategoryAssignment` → `schema.prisma:L1803`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16933`
- `MerchantAccount` → `schema.prisma:L6045`
- `MerchantFiscalConfig` → `schema.prisma:L17198`
- `MerchantRevenueShare` → `schema.prisma:L7174`
- `MerchantRoutingRule` → `schema.prisma:L6167`
- `MilestoneAchievement` → `schema.prisma:L13195`
- `Modifier` → `schema.prisma:L4400`
- `ModifierGroup` → `schema.prisma:L4364`
- `Module` → `schema.prisma:L11490`
- `MoneyAnomaly` → `schema.prisma:L7077`
- `MonthlyVenueProfit` → `schema.prisma:L7620`
- `Notification` → `schema.prisma:L9285`
- `NotificationPreference` → `schema.prisma:L9332`
- `NotificationTemplate` → `schema.prisma:L9359`
- `OAuthState` → `schema.prisma:L1601`
- `OnboardingProgress` → `schema.prisma:L1619`
- `OnlineOrder` → `schema.prisma:L19730`
- `OnlineOrderingSettings` → `schema.prisma:L19706`
- `Order` → `schema.prisma:L3924`
- `OrderAction` → `schema.prisma:L4471`
- `OrderCustomer` → `schema.prisma:L4178`
- `OrderDiscount` → `schema.prisma:L9141`
- `OrderFulfillment` → `schema.prisma:L16251`
- `OrderFulfillmentLine` → `schema.prisma:L16282`
- `OrderItem` → `schema.prisma:L4214`
- `OrderItemModifier` → `schema.prisma:L4453`
- `OrderItemSelloIva` → `schema.prisma:L17338`
- `OrderPromotion` → `schema.prisma:L18468`
- `OrderServiceCharge` → `schema.prisma:L9230`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13573`
- `OrganizationEntitlement` → `schema.prisma:L11773`
- `OrganizationGoal` → `schema.prisma:L13531`
- `OrganizationModule` → `schema.prisma:L11550`
- `OrganizationPaymentConfig` → `schema.prisma:L6619`
- `OrganizationPayoutConfig` → `schema.prisma:L13606`
- `OrganizationPricingStructure` → `schema.prisma:L6651`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13554`
- `OtpChallenge` → `schema.prisma:L8130`
- `OvertimeApproval` → `schema.prisma:L3639`
- `PartnerAPIKey` → `schema.prisma:L6449`
- `Payment` → `schema.prisma:L4504`
- `PaymentAllocation` → `schema.prisma:L4777`
- `PaymentEffect` → `schema.prisma:L18842`
- `PaymentLink` → `schema.prisma:L15438`
- `PaymentLinkAttribution` → `schema.prisma:L15546`
- `PaymentLinkItem` → `schema.prisma:L15501`
- `PaymentLinkItemModifier` → `schema.prisma:L15528`
- `PaymentProvider` → `schema.prisma:L6004`
- `PayrollLine` → `schema.prisma:L17964`
- `PayrollRun` → `schema.prisma:L17933`
- `PerformanceGoal` → `schema.prisma:L13508`
- `PermissionOverride` → `schema.prisma:L1474`
- `PermissionSet` → `schema.prisma:L1497`
- `PlatformAnnouncement` → `schema.prisma:L18632`
- `PlatformAnnouncementClick` → `schema.prisma:L18697`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18734`
- `PlatformCfdi` → `schema.prisma:L18261`
- `PlatformEmisor` → `schema.prisma:L18201`
- `PlatformSettings` → `schema.prisma:L6426`
- `PosCommand` → `schema.prisma:L9413`
- `PosConnectionStatus` → `schema.prisma:L1016`
- `PosSyncIntent` → `schema.prisma:L18339`
- `PricingPolicy` → `schema.prisma:L2864`
- `Printer` → `schema.prisma:L16052`
- `PrintGateway` → `schema.prisma:L16109`
- `PrintJob` → `schema.prisma:L16832`
- `PrintStation` → `schema.prisma:L16127`
- `PrivacyNoticeVersion` → `schema.prisma:L7878`
- `ProcessedStripeEvent` → `schema.prisma:L7063`
- `ProcessorReliabilityMetric` → `schema.prisma:L7548`
- `Product` → `schema.prisma:L1821`
- `ProductModifierGroup` → `schema.prisma:L4441`
- `ProductOption` → `schema.prisma:L15744`
- `ProductOptionValue` → `schema.prisma:L15755`
- `ProductStaff` → `schema.prisma:L14388`
- `PromoterBankAccount` → `schema.prisma:L18084`
- `PromoterCommissionEntry` → `schema.prisma:L18103`
- `PromoterLocationPing` → `schema.prisma:L3890`
- `Promotion` → `schema.prisma:L18390`
- `PromotionGroup` → `schema.prisma:L18429`
- `PromotionOption` → `schema.prisma:L18445`
- `ProviderCostStructure` → `schema.prisma:L7099`
- `ProviderEventLog` → `schema.prisma:L6728`
- `PurchaseOrder` → `schema.prisma:L2571`
- `PurchaseOrderInvoice` → `schema.prisma:L2716`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2783`
- `PurchaseOrderItem` → `schema.prisma:L2629`
- `RateCorrectionBatch` → `schema.prisma:L7324`
- `RateCorrectionEntry` → `schema.prisma:L7366`
- `RawMaterial` → `schema.prisma:L2327`
- `RawMaterialMovement` → `schema.prisma:L2917`
- `RawMaterialPresentation` → `schema.prisma:L2403`
- `ReceiptLayout` → `schema.prisma:L18876`
- `Recipe` → `schema.prisma:L2423`
- `RecipeLine` → `schema.prisma:L2447`
- `Referral` → `schema.prisma:L8596`
- `ReferralProgramConfig` → `schema.prisma:L8561`
- `ReferralRewardGrant` → `schema.prisma:L8687`
- `ReferralTierReward` → `schema.prisma:L8659`
- `ReferralTierUnlock` → `schema.prisma:L8732`
- `RefreshGrant` → `schema.prisma:L18821`
- `Reservation` → `schema.prisma:L14151`
- `ReservationGoogleEventMapping` → `schema.prisma:L15211`
- `ReservationModifier` → `schema.prisma:L14336`
- `ReservationReminderSent` → `schema.prisma:L14319`
- `ReservationSettings` → `schema.prisma:L14560`
- `ReservationWaitlistEntry` → `schema.prisma:L14528`
- `Review` → `schema.prisma:L5374`
- `SalesRetention` → `schema.prisma:L17784`
- `SaleVerification` → `schema.prisma:L4831`
- `ScaleProfile` → `schema.prisma:L16573`
- `ScheduledCommand` → `schema.prisma:L10974`
- `SerializedItem` → `schema.prisma:L12624`
- `SerializedItemCustodyEvent` → `schema.prisma:L12791`
- `ServiceCharge` → `schema.prisma:L9201`
- `ServiceEarning` → `schema.prisma:L19250`
- `ServicePayPeriod` → `schema.prisma:L19226`
- `ServicePayTable` → `schema.prisma:L19134`
- `ServicePayTableCell` → `schema.prisma:L19176`
- `ServicePayTableVersion` → `schema.prisma:L19151`
- `Session` → `schema.prisma:L18800`
- `SettlementConfiguration` → `schema.prisma:L7399`
- `SettlementConfirmation` → `schema.prisma:L7512`
- `SettlementIncident` → `schema.prisma:L7463`
- `SettlementSimulation` → `schema.prisma:L7434`
- `Shift` → `schema.prisma:L3450`
- `ShopifyConnectIntent` → `schema.prisma:L19571`
- `ShopifyImportIssue` → `schema.prisma:L19625`
- `ShopifyInboundEvent` → `schema.prisma:L19547`
- `ShopifyLocationLink` → `schema.prisma:L19421`
- `ShopifyReviewItem` → `schema.prisma:L19593`
- `ShopifyStockOutbox` → `schema.prisma:L19517`
- `ShopifyStore` → `schema.prisma:L19392`
- `ShopifyVariantLink` → `schema.prisma:L19469`
- `SimRegistrationRequest` → `schema.prisma:L12829`
- `SimRegistrationRequestItem` → `schema.prisma:L12851`
- `SlotHold` → `schema.prisma:L14419`
- `Staff` → `schema.prisma:L1036`
- `StaffAssignment` → `schema.prisma:L3737`
- `StaffDocument` → `schema.prisma:L3761`
- `StaffOnboardingState` → `schema.prisma:L16903`
- `StaffOrganization` → `schema.prisma:L1373`
- `StaffPasskey` → `schema.prisma:L1400`
- `StaffPayLevel` → `schema.prisma:L19098`
- `StaffPayLevelAssignment` → `schema.prisma:L19116`
- `StaffPayStatement` → `schema.prisma:L19282`
- `StaffPayTipWindow` → `schema.prisma:L19644`
- `StaffPayVenueWindow` → `schema.prisma:L19661`
- `StaffPosition` → `schema.prisma:L3716`
- `StaffSchedule` → `schema.prisma:L14359`
- `StaffScheduleException` → `schema.prisma:L14371`
- `StaffVenue` → `schema.prisma:L1297`
- `StaffWorkSchedule` → `schema.prisma:L3575`
- `StaffWorkScheduleException` → `schema.prisma:L3673`
- `StampCard` → `schema.prisma:L8444`
- `StampEvent` → `schema.prisma:L8483`
- `StampReward` → `schema.prisma:L8521`
- `StockAlertConfig` → `schema.prisma:L13490`
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
- `TokenPurchase` → `schema.prisma:L10646`
- `TokenUsageRecord` → `schema.prisma:L10618`
- `TpvCommandHistory` → `schema.prisma:L10880`
- `TpvCommandQueue` → `schema.prisma:L10818`
- `TpvFeedback` → `schema.prisma:L10531`
- `TpvMessage` → `schema.prisma:L13847`
- `TpvMessageDelivery` → `schema.prisma:L13899`
- `TpvMessageResponse` → `schema.prisma:L13922`
- `TrainingModule` → `schema.prisma:L13977`
- `TrainingProgress` → `schema.prisma:L14054`
- `TrainingQuizQuestion` → `schema.prisma:L14036`
- `TrainingStep` → `schema.prisma:L14016`
- `TransactionCost` → `schema.prisma:L7262`
- `UnitConversion` → `schema.prisma:L2895`
- `UpsellAcceptance` → `schema.prisma:L9017`
- `UpsellAiRun` → `schema.prisma:L9037`
- `UpsellImpression` → `schema.prisma:L8977`
- `UpsellRule` → `schema.prisma:L8897`
- `user_sessions` → `schema.prisma:L6484`
- `Venue` → `schema.prisma:L185`
- `VenueAreaTicketSettings` → `schema.prisma:L16310`
- `VenueChatMessage` → `schema.prisma:L844`
- `VenueChatSession` → `schema.prisma:L799`
- `VenueCommission` → `schema.prisma:L15905`
- `VenueCreditAssessment` → `schema.prisma:L11362`
- `VenueCryptoConfig` → `schema.prisma:L13714`
- `VenueFeature` → `schema.prisma:L4945`
- `VenueIvaPorProducto` → `schema.prisma:L999`
- `VenueModule` → `schema.prisma:L11522`
- `VenuePaymentConfig` → `schema.prisma:L6585`
- `VenuePaymentLinkSettings` → `schema.prisma:L15244`
- `VenuePosSinAparato` → `schema.prisma:L1010`
- `VenuePricingStructure` → `schema.prisma:L7202`
- `VenueRoleConfig` → `schema.prisma:L1526`
- `VenueRolePermission` → `schema.prisma:L1430`
- `VenueScaleSettings` → `schema.prisma:L16561`
- `VenueSettings` → `schema.prisma:L884`
- `VenueTenderType` → `schema.prisma:L4690`
- `VenueTenderTypeRevision` → `schema.prisma:L4755`
- `VenueTransaction` → `schema.prisma:L4882`
- `VenueWhatsappActivation` → `schema.prisma:L735`
- `WalletCardDesign` → `schema.prisma:L8362`
- `WalletPass` → `schema.prisma:L8263`
- `WalletPassRegistration` → `schema.prisma:L8329`
- `WebhookEvent` → `schema.prisma:L5283`
- `WebhookSubscription` → `schema.prisma:L6701`
- `WhatsappContactWindow` → `schema.prisma:L753`
- `WhatsappInboundEvent` → `schema.prisma:L773`
- `WorkShiftAssignment` → `schema.prisma:L3615`
- `WorkShiftTemplate` → `schema.prisma:L3592`
- `Zone` → `schema.prisma:L168`
