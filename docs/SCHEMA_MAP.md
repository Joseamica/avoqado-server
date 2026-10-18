# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **426 models / 392 enums / ~19,700 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `DocumentRequest`, `DocumentRequestDelivery`, `DocumentRequestFile`, `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `ProductPriceHistory`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
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

- `AccountingPeriodLock` → `schema.prisma:L17659`
- `AccountMapping` → `schema.prisma:L17554`
- `ActivityLog` → `schema.prisma:L7693`
- `Aggregator` → `schema.prisma:L15805`
- `AggregatorBooking` → `schema.prisma:L15113`
- `AggregatorCapacityRule` → `schema.prisma:L15094`
- `AggregatorConnection` → `schema.prisma:L15019`
- `AggregatorInboundEvent` → `schema.prisma:L15182`
- `AggregatorOutbox` → `schema.prisma:L15202`
- `AggregatorProductLink` → `schema.prisma:L15051`
- `AggregatorSessionLink` → `schema.prisma:L15070`
- `AggregatorVisit` → `schema.prisma:L15139`
- `AngelPayUserAccount` → `schema.prisma:L6234`
- `AppUpdate` → `schema.prisma:L13680`
- `Area` → `schema.prisma:L3330`
- `AreaTicket` → `schema.prisma:L16354`
- `AreaTicketCheckoutSession` → `schema.prisma:L16476`
- `AreaTicketExternalIncident` → `schema.prisma:L16723`
- `AreaTicketExternalSettlement` → `schema.prisma:L16688`
- `AreaTicketFulfillment` → `schema.prisma:L16552`
- `AreaTicketInventoryReservation` → `schema.prisma:L16447`
- `AreaTicketLine` → `schema.prisma:L16415`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16508`
- `AreaTicketPrintAttempt` → `schema.prisma:L16531`
- `BankStatement` → `schema.prisma:L17428`
- `BankStatementLine` → `schema.prisma:L17449`
- `BillingObligationConflict` → `schema.prisma:L5264`
- `BillingTaxProfile` → `schema.prisma:L18251`
- `BirthdayAutomation` → `schema.prisma:L8017`
- `BulkCommandOperation` → `schema.prisma:L10952`
- `CalendarSyncOutbox` → `schema.prisma:L14902`
- `CampaignDelivery` → `schema.prisma:L13838`
- `CapabilityGrant` → `schema.prisma:L5004`
- `CashCloseout` → `schema.prisma:L11337`
- `CashDeposit` → `schema.prisma:L13482`
- `CashDrawerEvent` → `schema.prisma:L15642`
- `CashDrawerSession` → `schema.prisma:L15603`
- `CashOutCommissionRate` → `schema.prisma:L18068`
- `CashOutScheduleDay` → `schema.prisma:L18091`
- `CashOutWithdrawal` → `schema.prisma:L18153`
- `CatalogBindingBatch` → `schema.prisma:L12368`
- `CatalogBindingLine` → `schema.prisma:L12404`
- `CatalogBrand` → `schema.prisma:L11821`
- `CatalogClientObservation` → `schema.prisma:L12134`
- `CatalogClientReadinessOverride` → `schema.prisma:L12153`
- `CatalogFamily` → `schema.prisma:L11871`
- `CatalogIdempotencyRecord` → `schema.prisma:L12267`
- `CatalogIdentifier` → `schema.prisma:L12002`
- `CatalogImportBatch` → `schema.prisma:L12310`
- `CatalogImportLine` → `schema.prisma:L12347`
- `CatalogItem` → `schema.prisma:L11904`
- `CatalogItemBusinessType` → `schema.prisma:L11964`
- `CatalogItemPrice` → `schema.prisma:L12052`
- `CatalogManufacturer` → `schema.prisma:L11845`
- `CatalogProductTypeMapping` → `schema.prisma:L11981`
- `CatalogPublicationBatch` → `schema.prisma:L12432`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12526`
- `CatalogPublicationLine` → `schema.prisma:L12473`
- `CatalogPublicationOutbox` → `schema.prisma:L12569`
- `CatalogValidationProfile` → `schema.prisma:L12023`
- `CatalogVenueBinding` → `schema.prisma:L12181`
- `CatalogVenueClientRequirement` → `schema.prisma:L12108`
- `CatalogVenueEventSequence` → `schema.prisma:L12552`
- `CatalogVenueOverride` → `schema.prisma:L12223`
- `CatalogVenueRollout` → `schema.prisma:L12083`
- `Cfdi` → `schema.prisma:L17250`
- `CfdiGlobalOrden` → `schema.prisma:L17381`
- `ChatbotTokenBudget` → `schema.prisma:L10598`
- `ChatConversation` → `schema.prisma:L10453`
- `ChatFeedback` → `schema.prisma:L10539`
- `ChatLearningEvent` → `schema.prisma:L10496`
- `ChatMessage` → `schema.prisma:L10476`
- `ChatTrainingData` → `schema.prisma:L10410`
- `CheckoutSession` → `schema.prisma:L6514`
- `ClassSession` → `schema.prisma:L14496`
- `ClassSessionPayState` → `schema.prisma:L19211`
- `CommissionCalculation` → `schema.prisma:L13257`
- `CommissionClawback` → `schema.prisma:L13434`
- `CommissionConfig` → `schema.prisma:L13016`
- `CommissionMilestone` → `schema.prisma:L13173`
- `CommissionOverride` → `schema.prisma:L13100`
- `CommissionPayout` → `schema.prisma:L13385`
- `CommissionSummary` → `schema.prisma:L13324`
- `CommissionTier` → `schema.prisma:L13137`
- `ConsentEvent` → `schema.prisma:L7879`
- `Consumer` → `schema.prisma:L8109`
- `ConsumerAuthAccount` → `schema.prisma:L8134`
- `CouponCode` → `schema.prisma:L9081`
- `CouponRedemption` → `schema.prisma:L9112`
- `CreditAssessmentHistory` → `schema.prisma:L11446`
- `CreditItemBalance` → `schema.prisma:L15393`
- `CreditOffer` → `schema.prisma:L11465`
- `CreditPack` → `schema.prisma:L15302`
- `CreditPackItem` → `schema.prisma:L15331`
- `CreditPackPurchase` → `schema.prisma:L15348`
- `CreditTransaction` → `schema.prisma:L15415`
- `Customer` → `schema.prisma:L7734`
- `CustomerApprovalDelivery` → `schema.prisma:L10111`
- `CustomerApprovalOutbox` → `schema.prisma:L10086`
- `CustomerCampaign` → `schema.prisma:L7967`
- `CustomerCampaignDelivery` → `schema.prisma:L8049`
- `CustomerCaptureToken` → `schema.prisma:L7915`
- `CustomerDiscount` → `schema.prisma:L9132`
- `CustomerExternalIdentity` → `schema.prisma:L15169`
- `CustomerGroup` → `schema.prisma:L8173`
- `CustomerOrderMetric` → `schema.prisma:L4218`
- `CustomerTaxProfile` → `schema.prisma:L17400`
- `DeliveryActivationRequest` → `schema.prisma:L6973`
- `DeliveryChannelLink` → `schema.prisma:L6812`
- `DeliveryConnectIntent` → `schema.prisma:L6924`
- `DeliveryLineAction` → `schema.prisma:L6885`
- `DeliveryOrderEvent` → `schema.prisma:L6997`
- `DeliveryStoreRevocation` → `schema.prisma:L6961`
- `DeviceToken` → `schema.prisma:L9406`
- `DigitalReceipt` → `schema.prisma:L4817`
- `Discount` → `schema.prisma:L8771`
- `DocumentRequest` → `schema.prisma:L19702`
- `DocumentRequestDelivery` → `schema.prisma:L19759`
- `DocumentRequestFile` → `schema.prisma:L19738`
- `EcommerceMerchant` → `schema.prisma:L6326`
- `EmailQuotaLedger` → `schema.prisma:L8096`
- `EmailSuppression` → `schema.prisma:L8084`
- `EmailTemplate` → `schema.prisma:L13777`
- `Employee` → `schema.prisma:L17916`
- `Estimate` → `schema.prisma:L15712`
- `EstimateItem` → `schema.prisma:L15740`
- `Expense` → `schema.prisma:L17703`
- `ExternalBusyBlock` → `schema.prisma:L14795`
- `Feature` → `schema.prisma:L4946`
- `FeeSchedule` → `schema.prisma:L5326`
- `FeeTier` → `schema.prisma:L5337`
- `FinancialAccount` → `schema.prisma:L15902`
- `FinancialConnection` → `schema.prisma:L15871`
- `FinancialProvider` → `schema.prisma:L15857`
- `FiscalEmisor` → `schema.prisma:L17161`
- `FiscalLossCarryforward` → `schema.prisma:L17826`
- `FixedAsset` → `schema.prisma:L17844`
- `FixedAssetDepreciation` → `schema.prisma:L17873`
- `FloorElement` → `schema.prisma:L3415`
- `FloorPlanPublication` → `schema.prisma:L3455`
- `FulfillmentArea` → `schema.prisma:L16219`
- `GeofenceRule` → `schema.prisma:L11037`
- `GoogleCalendarChannel` → `schema.prisma:L14772`
- `GoogleCalendarConnection` → `schema.prisma:L14724`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14825`
- `GoogleOAuthSession` → `schema.prisma:L14847`
- `HolidayCalendar` → `schema.prisma:L7617`
- `HybridBillingOperation` → `schema.prisma:L5188`
- `HybridCampaign` → `schema.prisma:L5029`
- `HybridContract` → `schema.prisma:L5145`
- `HybridContractSelection` → `schema.prisma:L5177`
- `HybridCreditAllocation` → `schema.prisma:L5244`
- `HybridOfferPublication` → `schema.prisma:L5092`
- `HybridPaymentPeriod` → `schema.prisma:L5223`
- `HybridPromotionGroup` → `schema.prisma:L5073`
- `HybridPurchase` → `schema.prisma:L5112`
- `HybridRedemption` → `schema.prisma:L5206`
- `IdempotencyRequest` → `schema.prisma:L12891`
- `InterVenueTransfer` → `schema.prisma:L3158`
- `InterVenueTransferAllocation` → `schema.prisma:L3241`
- `InterVenueTransferItem` → `schema.prisma:L3210`
- `InterVenueTransferReceipt` → `schema.prisma:L3268`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3284`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3312`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3296`
- `Inventory` → `schema.prisma:L2080`
- `InventoryMovement` → `schema.prisma:L2180`
- `InventoryPosting` → `schema.prisma:L2275`
- `InventoryPostingLine` → `schema.prisma:L2315`
- `InventoryTransfer` → `schema.prisma:L15684`
- `InventoryWasteReport` → `schema.prisma:L2135`
- `Invitation` → `schema.prisma:L1548`
- `Invoice` → `schema.prisma:L5349`
- `InvoiceItem` → `schema.prisma:L5375`
- `ItemCategory` → `schema.prisma:L12604`
- `JournalEntry` → `schema.prisma:L17612`
- `JournalLine` → `schema.prisma:L17641`
- `KdsOrder` → `schema.prisma:L15950`
- `KdsOrderItem` → `schema.prisma:L16017`
- `KioskCheckInAttempt` → `schema.prisma:L18574`
- `KioskCheckInChallenge` → `schema.prisma:L18528`
- `KioskOutreachOutbox` → `schema.prisma:L18595`
- `LaunchCampaign` → `schema.prisma:L18933`
- `LaunchCampaignRedemption` → `schema.prisma:L19050`
- `LearnedPatterns` → `schema.prisma:L10520`
- `LedgerAccount` → `schema.prisma:L17504`
- `LiveDemoSession` → `schema.prisma:L866`
- `LowStockAlert` → `schema.prisma:L2988`
- `LoyaltyConfig` → `schema.prisma:L8203`
- `LoyaltyTransaction` → `schema.prisma:L8246`
- `MarketingCampaign` → `schema.prisma:L13795`
- `McpAuthCode` → `schema.prisma:L17042`
- `McpOAuthClient` → `schema.prisma:L17026`
- `McpRefreshToken` → `schema.prisma:L17060`
- `McpToolCall` → `schema.prisma:L17082`
- `MeasurementUnit` → `schema.prisma:L15790`
- `Menu` → `schema.prisma:L1766`
- `MenuCategory` → `schema.prisma:L1703`
- `MenuCategoryAssignment` → `schema.prisma:L1801`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16956`
- `MerchantAccount` → `schema.prisma:L6064`
- `MerchantFiscalConfig` → `schema.prisma:L17221`
- `MerchantRevenueShare` → `schema.prisma:L7193`
- `MerchantRoutingRule` → `schema.prisma:L6186`
- `MilestoneAchievement` → `schema.prisma:L13218`
- `Modifier` → `schema.prisma:L4419`
- `ModifierGroup` → `schema.prisma:L4383`
- `Module` → `schema.prisma:L11513`
- `MoneyAnomaly` → `schema.prisma:L7096`
- `MonthlyVenueProfit` → `schema.prisma:L7643`
- `Notification` → `schema.prisma:L9308`
- `NotificationPreference` → `schema.prisma:L9355`
- `NotificationTemplate` → `schema.prisma:L9382`
- `OAuthState` → `schema.prisma:L1599`
- `OnboardingProgress` → `schema.prisma:L1617`
- `Order` → `schema.prisma:L3944`
- `OrderAction` → `schema.prisma:L4490`
- `OrderCustomer` → `schema.prisma:L4197`
- `OrderDiscount` → `schema.prisma:L9164`
- `OrderFulfillment` → `schema.prisma:L16274`
- `OrderFulfillmentLine` → `schema.prisma:L16305`
- `OrderItem` → `schema.prisma:L4233`
- `OrderItemModifier` → `schema.prisma:L4472`
- `OrderItemSelloIva` → `schema.prisma:L17361`
- `OrderPromotion` → `schema.prisma:L18491`
- `OrderServiceCharge` → `schema.prisma:L9253`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13596`
- `OrganizationEntitlement` → `schema.prisma:L11796`
- `OrganizationGoal` → `schema.prisma:L13554`
- `OrganizationModule` → `schema.prisma:L11573`
- `OrganizationPaymentConfig` → `schema.prisma:L6638`
- `OrganizationPayoutConfig` → `schema.prisma:L13629`
- `OrganizationPricingStructure` → `schema.prisma:L6670`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13577`
- `OtpChallenge` → `schema.prisma:L8153`
- `OvertimeApproval` → `schema.prisma:L3659`
- `PartnerAPIKey` → `schema.prisma:L6468`
- `Payment` → `schema.prisma:L4523`
- `PaymentAllocation` → `schema.prisma:L4796`
- `PaymentEffect` → `schema.prisma:L18865`
- `PaymentLink` → `schema.prisma:L15461`
- `PaymentLinkAttribution` → `schema.prisma:L15569`
- `PaymentLinkItem` → `schema.prisma:L15524`
- `PaymentLinkItemModifier` → `schema.prisma:L15551`
- `PaymentProvider` → `schema.prisma:L6023`
- `PayrollLine` → `schema.prisma:L17987`
- `PayrollRun` → `schema.prisma:L17956`
- `PerformanceGoal` → `schema.prisma:L13531`
- `PermissionOverride` → `schema.prisma:L1472`
- `PermissionSet` → `schema.prisma:L1495`
- `PlatformAnnouncement` → `schema.prisma:L18655`
- `PlatformAnnouncementClick` → `schema.prisma:L18720`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18757`
- `PlatformCfdi` → `schema.prisma:L18284`
- `PlatformEmisor` → `schema.prisma:L18224`
- `PlatformSettings` → `schema.prisma:L6445`
- `PosCommand` → `schema.prisma:L9436`
- `PosConnectionStatus` → `schema.prisma:L1014`
- `PosSyncIntent` → `schema.prisma:L18362`
- `PricingPolicy` → `schema.prisma:L2884`
- `Printer` → `schema.prisma:L16075`
- `PrintGateway` → `schema.prisma:L16132`
- `PrintJob` → `schema.prisma:L16855`
- `PrintStation` → `schema.prisma:L16150`
- `PrivacyNoticeVersion` → `schema.prisma:L7901`
- `ProcessedStripeEvent` → `schema.prisma:L7082`
- `ProcessorReliabilityMetric` → `schema.prisma:L7571`
- `Product` → `schema.prisma:L1819`
- `ProductModifierGroup` → `schema.prisma:L4460`
- `ProductOption` → `schema.prisma:L15767`
- `ProductOptionValue` → `schema.prisma:L15778`
- `ProductPriceHistory` → `schema.prisma:L2064`
- `ProductStaff` → `schema.prisma:L14411`
- `PromoterBankAccount` → `schema.prisma:L18107`
- `PromoterCommissionEntry` → `schema.prisma:L18126`
- `PromoterLocationPing` → `schema.prisma:L3910`
- `Promotion` → `schema.prisma:L18413`
- `PromotionGroup` → `schema.prisma:L18452`
- `PromotionOption` → `schema.prisma:L18468`
- `ProviderCostStructure` → `schema.prisma:L7118`
- `ProviderEventLog` → `schema.prisma:L6747`
- `PurchaseOrder` → `schema.prisma:L2591`
- `PurchaseOrderInvoice` → `schema.prisma:L2736`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2803`
- `PurchaseOrderItem` → `schema.prisma:L2649`
- `RateCorrectionBatch` → `schema.prisma:L7347`
- `RateCorrectionEntry` → `schema.prisma:L7389`
- `RawMaterial` → `schema.prisma:L2347`
- `RawMaterialMovement` → `schema.prisma:L2937`
- `RawMaterialPresentation` → `schema.prisma:L2423`
- `ReceiptLayout` → `schema.prisma:L18899`
- `Recipe` → `schema.prisma:L2443`
- `RecipeLine` → `schema.prisma:L2467`
- `Referral` → `schema.prisma:L8619`
- `ReferralProgramConfig` → `schema.prisma:L8584`
- `ReferralRewardGrant` → `schema.prisma:L8710`
- `ReferralTierReward` → `schema.prisma:L8682`
- `ReferralTierUnlock` → `schema.prisma:L8755`
- `RefreshGrant` → `schema.prisma:L18844`
- `Reservation` → `schema.prisma:L14174`
- `ReservationGoogleEventMapping` → `schema.prisma:L15234`
- `ReservationModifier` → `schema.prisma:L14359`
- `ReservationReminderSent` → `schema.prisma:L14342`
- `ReservationSettings` → `schema.prisma:L14583`
- `ReservationWaitlistEntry` → `schema.prisma:L14551`
- `Review` → `schema.prisma:L5393`
- `SalesRetention` → `schema.prisma:L17807`
- `SaleVerification` → `schema.prisma:L4850`
- `ScaleProfile` → `schema.prisma:L16596`
- `ScheduledCommand` → `schema.prisma:L10997`
- `SerializedItem` → `schema.prisma:L12647`
- `SerializedItemCustodyEvent` → `schema.prisma:L12814`
- `ServiceCharge` → `schema.prisma:L9224`
- `ServiceEarning` → `schema.prisma:L19273`
- `ServicePayPeriod` → `schema.prisma:L19249`
- `ServicePayTable` → `schema.prisma:L19157`
- `ServicePayTableCell` → `schema.prisma:L19199`
- `ServicePayTableVersion` → `schema.prisma:L19174`
- `Session` → `schema.prisma:L18823`
- `SettlementConfiguration` → `schema.prisma:L7422`
- `SettlementConfirmation` → `schema.prisma:L7535`
- `SettlementIncident` → `schema.prisma:L7486`
- `SettlementSimulation` → `schema.prisma:L7457`
- `Shift` → `schema.prisma:L3470`
- `ShopifyConnectIntent` → `schema.prisma:L19594`
- `ShopifyImportIssue` → `schema.prisma:L19648`
- `ShopifyInboundEvent` → `schema.prisma:L19570`
- `ShopifyLocationLink` → `schema.prisma:L19444`
- `ShopifyReviewItem` → `schema.prisma:L19616`
- `ShopifyStockOutbox` → `schema.prisma:L19540`
- `ShopifyStore` → `schema.prisma:L19415`
- `ShopifyVariantLink` → `schema.prisma:L19492`
- `SimRegistrationRequest` → `schema.prisma:L12852`
- `SimRegistrationRequestItem` → `schema.prisma:L12874`
- `SlotHold` → `schema.prisma:L14442`
- `Staff` → `schema.prisma:L1034`
- `StaffAssignment` → `schema.prisma:L3757`
- `StaffDocument` → `schema.prisma:L3781`
- `StaffOnboardingState` → `schema.prisma:L16926`
- `StaffOrganization` → `schema.prisma:L1371`
- `StaffPasskey` → `schema.prisma:L1398`
- `StaffPayLevel` → `schema.prisma:L19121`
- `StaffPayLevelAssignment` → `schema.prisma:L19139`
- `StaffPayStatement` → `schema.prisma:L19305`
- `StaffPayTipWindow` → `schema.prisma:L19667`
- `StaffPayVenueWindow` → `schema.prisma:L19684`
- `StaffPosition` → `schema.prisma:L3736`
- `StaffSchedule` → `schema.prisma:L14382`
- `StaffScheduleException` → `schema.prisma:L14394`
- `StaffVenue` → `schema.prisma:L1295`
- `StaffWorkSchedule` → `schema.prisma:L3595`
- `StaffWorkScheduleException` → `schema.prisma:L3693`
- `StampCard` → `schema.prisma:L8467`
- `StampEvent` → `schema.prisma:L8506`
- `StampReward` → `schema.prisma:L8544`
- `StockAlertConfig` → `schema.prisma:L13513`
- `StockBatch` → `schema.prisma:L3107`
- `StockCount` → `schema.prisma:L3020`
- `StockCountItem` → `schema.prisma:L3048`
- `StripeWebhookEvent` → `schema.prisma:L7065`
- `Supplier` → `schema.prisma:L2502`
- `SupplierItemCode` → `schema.prisma:L2847`
- `SupplierPricing` → `schema.prisma:L2557`
- `Table` → `schema.prisma:L3361`
- `Terminal` → `schema.prisma:L5444`
- `TerminalAttemptResolution` → `schema.prisma:L5882`
- `TerminalHealth` → `schema.prisma:L5702`
- `TerminalLog` → `schema.prisma:L5676`
- `TerminalOrder` → `schema.prisma:L5926`
- `TerminalOrderItem` → `schema.prisma:L6001`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5854`
- `TerminalPaymentRequest` → `schema.prisma:L5773`
- `TimeEntry` → `schema.prisma:L3823`
- `TimeEntryBreak` → `schema.prisma:L3892`
- `TokenPurchase` → `schema.prisma:L10669`
- `TokenUsageRecord` → `schema.prisma:L10641`
- `TpvCommandHistory` → `schema.prisma:L10903`
- `TpvCommandQueue` → `schema.prisma:L10841`
- `TpvFeedback` → `schema.prisma:L10554`
- `TpvMessage` → `schema.prisma:L13870`
- `TpvMessageDelivery` → `schema.prisma:L13922`
- `TpvMessageResponse` → `schema.prisma:L13945`
- `TrainingModule` → `schema.prisma:L14000`
- `TrainingProgress` → `schema.prisma:L14077`
- `TrainingQuizQuestion` → `schema.prisma:L14059`
- `TrainingStep` → `schema.prisma:L14039`
- `TransactionCost` → `schema.prisma:L7285`
- `UnitConversion` → `schema.prisma:L2915`
- `UpsellAcceptance` → `schema.prisma:L9040`
- `UpsellAiRun` → `schema.prisma:L9060`
- `UpsellImpression` → `schema.prisma:L9000`
- `UpsellRule` → `schema.prisma:L8920`
- `user_sessions` → `schema.prisma:L6503`
- `Venue` → `schema.prisma:L185`
- `VenueAreaTicketSettings` → `schema.prisma:L16333`
- `VenueChatMessage` → `schema.prisma:L842`
- `VenueChatSession` → `schema.prisma:L797`
- `VenueCommission` → `schema.prisma:L15928`
- `VenueCreditAssessment` → `schema.prisma:L11385`
- `VenueCryptoConfig` → `schema.prisma:L13737`
- `VenueFeature` → `schema.prisma:L4964`
- `VenueIvaPorProducto` → `schema.prisma:L997`
- `VenueModule` → `schema.prisma:L11545`
- `VenuePaymentConfig` → `schema.prisma:L6604`
- `VenuePaymentLinkSettings` → `schema.prisma:L15267`
- `VenuePosSinAparato` → `schema.prisma:L1008`
- `VenuePricingStructure` → `schema.prisma:L7225`
- `VenueRoleConfig` → `schema.prisma:L1524`
- `VenueRolePermission` → `schema.prisma:L1428`
- `VenueScaleSettings` → `schema.prisma:L16584`
- `VenueSettings` → `schema.prisma:L882`
- `VenueTenderType` → `schema.prisma:L4709`
- `VenueTenderTypeRevision` → `schema.prisma:L4774`
- `VenueTransaction` → `schema.prisma:L4901`
- `VenueWhatsappActivation` → `schema.prisma:L733`
- `WalletCardDesign` → `schema.prisma:L8385`
- `WalletPass` → `schema.prisma:L8286`
- `WalletPassRegistration` → `schema.prisma:L8352`
- `WebhookEvent` → `schema.prisma:L5302`
- `WebhookSubscription` → `schema.prisma:L6720`
- `WhatsappContactWindow` → `schema.prisma:L751`
- `WhatsappInboundEvent` → `schema.prisma:L771`
- `WorkShiftAssignment` → `schema.prisma:L3635`
- `WorkShiftTemplate` → `schema.prisma:L3612`
- `Zone` → `schema.prisma:L168`
