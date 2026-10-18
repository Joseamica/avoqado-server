# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **428 models / 395 enums / ~19,800 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `ProductPriceHistory`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
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

- `AccountingPeriodLock` → `schema.prisma:L17664`
- `AccountMapping` → `schema.prisma:L17559`
- `ActivityLog` → `schema.prisma:L7698`
- `Aggregator` → `schema.prisma:L15810`
- `AggregatorBooking` → `schema.prisma:L15118`
- `AggregatorCapacityRule` → `schema.prisma:L15099`
- `AggregatorConnection` → `schema.prisma:L15024`
- `AggregatorInboundEvent` → `schema.prisma:L15187`
- `AggregatorOutbox` → `schema.prisma:L15207`
- `AggregatorProductLink` → `schema.prisma:L15056`
- `AggregatorSessionLink` → `schema.prisma:L15075`
- `AggregatorVisit` → `schema.prisma:L15144`
- `AngelPayUserAccount` → `schema.prisma:L6239`
- `AppUpdate` → `schema.prisma:L13685`
- `Area` → `schema.prisma:L3334`
- `AreaTicket` → `schema.prisma:L16359`
- `AreaTicketCheckoutSession` → `schema.prisma:L16481`
- `AreaTicketExternalIncident` → `schema.prisma:L16728`
- `AreaTicketExternalSettlement` → `schema.prisma:L16693`
- `AreaTicketFulfillment` → `schema.prisma:L16557`
- `AreaTicketInventoryReservation` → `schema.prisma:L16452`
- `AreaTicketLine` → `schema.prisma:L16420`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16513`
- `AreaTicketPrintAttempt` → `schema.prisma:L16536`
- `BankStatement` → `schema.prisma:L17433`
- `BankStatementLine` → `schema.prisma:L17454`
- `BillingObligationConflict` → `schema.prisma:L5269`
- `BillingTaxProfile` → `schema.prisma:L18256`
- `BirthdayAutomation` → `schema.prisma:L8022`
- `BulkCommandOperation` → `schema.prisma:L10957`
- `CalendarSyncOutbox` → `schema.prisma:L14907`
- `CampaignDelivery` → `schema.prisma:L13843`
- `CapabilityGrant` → `schema.prisma:L5009`
- `CashCloseout` → `schema.prisma:L11342`
- `CashDeposit` → `schema.prisma:L13487`
- `CashDrawerEvent` → `schema.prisma:L15647`
- `CashDrawerSession` → `schema.prisma:L15608`
- `CashOutCommissionRate` → `schema.prisma:L18073`
- `CashOutScheduleDay` → `schema.prisma:L18096`
- `CashOutWithdrawal` → `schema.prisma:L18158`
- `CatalogBindingBatch` → `schema.prisma:L12373`
- `CatalogBindingLine` → `schema.prisma:L12409`
- `CatalogBrand` → `schema.prisma:L11826`
- `CatalogClientObservation` → `schema.prisma:L12139`
- `CatalogClientReadinessOverride` → `schema.prisma:L12158`
- `CatalogFamily` → `schema.prisma:L11876`
- `CatalogIdempotencyRecord` → `schema.prisma:L12272`
- `CatalogIdentifier` → `schema.prisma:L12007`
- `CatalogImportBatch` → `schema.prisma:L12315`
- `CatalogImportLine` → `schema.prisma:L12352`
- `CatalogItem` → `schema.prisma:L11909`
- `CatalogItemBusinessType` → `schema.prisma:L11969`
- `CatalogItemPrice` → `schema.prisma:L12057`
- `CatalogManufacturer` → `schema.prisma:L11850`
- `CatalogProductTypeMapping` → `schema.prisma:L11986`
- `CatalogPublicationBatch` → `schema.prisma:L12437`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12531`
- `CatalogPublicationLine` → `schema.prisma:L12478`
- `CatalogPublicationOutbox` → `schema.prisma:L12574`
- `CatalogValidationProfile` → `schema.prisma:L12028`
- `CatalogVenueBinding` → `schema.prisma:L12186`
- `CatalogVenueClientRequirement` → `schema.prisma:L12113`
- `CatalogVenueEventSequence` → `schema.prisma:L12557`
- `CatalogVenueOverride` → `schema.prisma:L12228`
- `CatalogVenueRollout` → `schema.prisma:L12088`
- `Cfdi` → `schema.prisma:L17255`
- `CfdiGlobalOrden` → `schema.prisma:L17386`
- `ChatbotTokenBudget` → `schema.prisma:L10603`
- `ChatConversation` → `schema.prisma:L10458`
- `ChatFeedback` → `schema.prisma:L10544`
- `ChatLearningEvent` → `schema.prisma:L10501`
- `ChatMessage` → `schema.prisma:L10481`
- `ChatTrainingData` → `schema.prisma:L10415`
- `CheckoutSession` → `schema.prisma:L6519`
- `ClassSession` → `schema.prisma:L14501`
- `ClassSessionPayState` → `schema.prisma:L19216`
- `CommissionCalculation` → `schema.prisma:L13262`
- `CommissionClawback` → `schema.prisma:L13439`
- `CommissionConfig` → `schema.prisma:L13021`
- `CommissionMilestone` → `schema.prisma:L13178`
- `CommissionOverride` → `schema.prisma:L13105`
- `CommissionPayout` → `schema.prisma:L13390`
- `CommissionSummary` → `schema.prisma:L13329`
- `CommissionTier` → `schema.prisma:L13142`
- `ConsentEvent` → `schema.prisma:L7884`
- `Consumer` → `schema.prisma:L8114`
- `ConsumerAuthAccount` → `schema.prisma:L8139`
- `CouponCode` → `schema.prisma:L9086`
- `CouponRedemption` → `schema.prisma:L9117`
- `CreditAssessmentHistory` → `schema.prisma:L11451`
- `CreditItemBalance` → `schema.prisma:L15398`
- `CreditOffer` → `schema.prisma:L11470`
- `CreditPack` → `schema.prisma:L15307`
- `CreditPackItem` → `schema.prisma:L15336`
- `CreditPackPurchase` → `schema.prisma:L15353`
- `CreditTransaction` → `schema.prisma:L15420`
- `Customer` → `schema.prisma:L7739`
- `CustomerApprovalDelivery` → `schema.prisma:L10116`
- `CustomerApprovalOutbox` → `schema.prisma:L10091`
- `CustomerCampaign` → `schema.prisma:L7972`
- `CustomerCampaignDelivery` → `schema.prisma:L8054`
- `CustomerCaptureToken` → `schema.prisma:L7920`
- `CustomerDiscount` → `schema.prisma:L9137`
- `CustomerExternalIdentity` → `schema.prisma:L15174`
- `CustomerGroup` → `schema.prisma:L8178`
- `CustomerOrderMetric` → `schema.prisma:L4223`
- `CustomerTaxProfile` → `schema.prisma:L17405`
- `DeliveryActivationRequest` → `schema.prisma:L6978`
- `DeliveryChannelLink` → `schema.prisma:L6817`
- `DeliveryConnectIntent` → `schema.prisma:L6929`
- `DeliveryLineAction` → `schema.prisma:L6890`
- `DeliveryOrderEvent` → `schema.prisma:L7002`
- `DeliveryStoreRevocation` → `schema.prisma:L6966`
- `DeviceToken` → `schema.prisma:L9411`
- `DigitalReceipt` → `schema.prisma:L4822`
- `Discount` → `schema.prisma:L8776`
- `DocumentRequest` → `schema.prisma:L19807`
- `DocumentRequestDelivery` → `schema.prisma:L19864`
- `DocumentRequestFile` → `schema.prisma:L19843`
- `EcommerceMerchant` → `schema.prisma:L6331`
- `EmailQuotaLedger` → `schema.prisma:L8101`
- `EmailSuppression` → `schema.prisma:L8089`
- `EmailTemplate` → `schema.prisma:L13782`
- `Employee` → `schema.prisma:L17921`
- `Estimate` → `schema.prisma:L15717`
- `EstimateItem` → `schema.prisma:L15745`
- `Expense` → `schema.prisma:L17708`
- `ExternalBusyBlock` → `schema.prisma:L14800`
- `Feature` → `schema.prisma:L4951`
- `FeeSchedule` → `schema.prisma:L5331`
- `FeeTier` → `schema.prisma:L5342`
- `FinancialAccount` → `schema.prisma:L15907`
- `FinancialConnection` → `schema.prisma:L15876`
- `FinancialProvider` → `schema.prisma:L15862`
- `FiscalEmisor` → `schema.prisma:L17166`
- `FiscalLossCarryforward` → `schema.prisma:L17831`
- `FixedAsset` → `schema.prisma:L17849`
- `FixedAssetDepreciation` → `schema.prisma:L17878`
- `FloorElement` → `schema.prisma:L3419`
- `FloorPlanPublication` → `schema.prisma:L3459`
- `FulfillmentArea` → `schema.prisma:L16224`
- `GeofenceRule` → `schema.prisma:L11042`
- `GoogleCalendarChannel` → `schema.prisma:L14777`
- `GoogleCalendarConnection` → `schema.prisma:L14729`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14830`
- `GoogleOAuthSession` → `schema.prisma:L14852`
- `HolidayCalendar` → `schema.prisma:L7622`
- `HybridBillingOperation` → `schema.prisma:L5193`
- `HybridCampaign` → `schema.prisma:L5034`
- `HybridContract` → `schema.prisma:L5150`
- `HybridContractSelection` → `schema.prisma:L5182`
- `HybridCreditAllocation` → `schema.prisma:L5249`
- `HybridOfferPublication` → `schema.prisma:L5097`
- `HybridPaymentPeriod` → `schema.prisma:L5228`
- `HybridPromotionGroup` → `schema.prisma:L5078`
- `HybridPurchase` → `schema.prisma:L5117`
- `HybridRedemption` → `schema.prisma:L5211`
- `IdempotencyRequest` → `schema.prisma:L12896`
- `InterVenueTransfer` → `schema.prisma:L3162`
- `InterVenueTransferAllocation` → `schema.prisma:L3245`
- `InterVenueTransferItem` → `schema.prisma:L3214`
- `InterVenueTransferReceipt` → `schema.prisma:L3272`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3288`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3316`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3300`
- `Inventory` → `schema.prisma:L2084`
- `InventoryMovement` → `schema.prisma:L2184`
- `InventoryPosting` → `schema.prisma:L2279`
- `InventoryPostingLine` → `schema.prisma:L2319`
- `InventoryTransfer` → `schema.prisma:L15689`
- `InventoryWasteReport` → `schema.prisma:L2139`
- `Invitation` → `schema.prisma:L1550`
- `Invoice` → `schema.prisma:L5354`
- `InvoiceItem` → `schema.prisma:L5380`
- `ItemCategory` → `schema.prisma:L12609`
- `JournalEntry` → `schema.prisma:L17617`
- `JournalLine` → `schema.prisma:L17646`
- `KdsOrder` → `schema.prisma:L15955`
- `KdsOrderItem` → `schema.prisma:L16022`
- `KioskCheckInAttempt` → `schema.prisma:L18579`
- `KioskCheckInChallenge` → `schema.prisma:L18533`
- `KioskOutreachOutbox` → `schema.prisma:L18600`
- `LaunchCampaign` → `schema.prisma:L18938`
- `LaunchCampaignRedemption` → `schema.prisma:L19055`
- `LearnedPatterns` → `schema.prisma:L10525`
- `LedgerAccount` → `schema.prisma:L17509`
- `LiveDemoSession` → `schema.prisma:L868`
- `LowStockAlert` → `schema.prisma:L2992`
- `LoyaltyConfig` → `schema.prisma:L8208`
- `LoyaltyTransaction` → `schema.prisma:L8251`
- `MarketingCampaign` → `schema.prisma:L13800`
- `McpAuthCode` → `schema.prisma:L17047`
- `McpOAuthClient` → `schema.prisma:L17031`
- `McpRefreshToken` → `schema.prisma:L17065`
- `McpToolCall` → `schema.prisma:L17087`
- `MeasurementUnit` → `schema.prisma:L15795`
- `Menu` → `schema.prisma:L1768`
- `MenuCategory` → `schema.prisma:L1705`
- `MenuCategoryAssignment` → `schema.prisma:L1803`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16961`
- `MerchantAccount` → `schema.prisma:L6069`
- `MerchantFiscalConfig` → `schema.prisma:L17226`
- `MerchantRevenueShare` → `schema.prisma:L7198`
- `MerchantRoutingRule` → `schema.prisma:L6191`
- `MilestoneAchievement` → `schema.prisma:L13223`
- `Modifier` → `schema.prisma:L4424`
- `ModifierGroup` → `schema.prisma:L4388`
- `Module` → `schema.prisma:L11518`
- `MoneyAnomaly` → `schema.prisma:L7101`
- `MonthlyVenueProfit` → `schema.prisma:L7648`
- `Notification` → `schema.prisma:L9313`
- `NotificationPreference` → `schema.prisma:L9360`
- `NotificationTemplate` → `schema.prisma:L9387`
- `OAuthState` → `schema.prisma:L1601`
- `OnboardingProgress` → `schema.prisma:L1619`
- `OnlineOrder` → `schema.prisma:L19758`
- `OnlineOrderingSettings` → `schema.prisma:L19734`
- `Order` → `schema.prisma:L3948`
- `OrderAction` → `schema.prisma:L4495`
- `OrderCustomer` → `schema.prisma:L4202`
- `OrderDiscount` → `schema.prisma:L9169`
- `OrderFulfillment` → `schema.prisma:L16279`
- `OrderFulfillmentLine` → `schema.prisma:L16310`
- `OrderItem` → `schema.prisma:L4238`
- `OrderItemModifier` → `schema.prisma:L4477`
- `OrderItemSelloIva` → `schema.prisma:L17366`
- `OrderPromotion` → `schema.prisma:L18496`
- `OrderServiceCharge` → `schema.prisma:L9258`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13601`
- `OrganizationEntitlement` → `schema.prisma:L11801`
- `OrganizationGoal` → `schema.prisma:L13559`
- `OrganizationModule` → `schema.prisma:L11578`
- `OrganizationPaymentConfig` → `schema.prisma:L6643`
- `OrganizationPayoutConfig` → `schema.prisma:L13634`
- `OrganizationPricingStructure` → `schema.prisma:L6675`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13582`
- `OtpChallenge` → `schema.prisma:L8158`
- `OvertimeApproval` → `schema.prisma:L3663`
- `PartnerAPIKey` → `schema.prisma:L6473`
- `Payment` → `schema.prisma:L4528`
- `PaymentAllocation` → `schema.prisma:L4801`
- `PaymentEffect` → `schema.prisma:L18870`
- `PaymentLink` → `schema.prisma:L15466`
- `PaymentLinkAttribution` → `schema.prisma:L15574`
- `PaymentLinkItem` → `schema.prisma:L15529`
- `PaymentLinkItemModifier` → `schema.prisma:L15556`
- `PaymentProvider` → `schema.prisma:L6028`
- `PayrollLine` → `schema.prisma:L17992`
- `PayrollRun` → `schema.prisma:L17961`
- `PerformanceGoal` → `schema.prisma:L13536`
- `PermissionOverride` → `schema.prisma:L1474`
- `PermissionSet` → `schema.prisma:L1497`
- `PlatformAnnouncement` → `schema.prisma:L18660`
- `PlatformAnnouncementClick` → `schema.prisma:L18725`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18762`
- `PlatformCfdi` → `schema.prisma:L18289`
- `PlatformEmisor` → `schema.prisma:L18229`
- `PlatformSettings` → `schema.prisma:L6450`
- `PosCommand` → `schema.prisma:L9441`
- `PosConnectionStatus` → `schema.prisma:L1016`
- `PosSyncIntent` → `schema.prisma:L18367`
- `PricingPolicy` → `schema.prisma:L2888`
- `Printer` → `schema.prisma:L16080`
- `PrintGateway` → `schema.prisma:L16137`
- `PrintJob` → `schema.prisma:L16860`
- `PrintStation` → `schema.prisma:L16155`
- `PrivacyNoticeVersion` → `schema.prisma:L7906`
- `ProcessedStripeEvent` → `schema.prisma:L7087`
- `ProcessorReliabilityMetric` → `schema.prisma:L7576`
- `Product` → `schema.prisma:L1821`
- `ProductModifierGroup` → `schema.prisma:L4465`
- `ProductOption` → `schema.prisma:L15772`
- `ProductOptionValue` → `schema.prisma:L15783`
- `ProductPriceHistory` → `schema.prisma:L2068`
- `ProductStaff` → `schema.prisma:L14416`
- `PromoterBankAccount` → `schema.prisma:L18112`
- `PromoterCommissionEntry` → `schema.prisma:L18131`
- `PromoterLocationPing` → `schema.prisma:L3914`
- `Promotion` → `schema.prisma:L18418`
- `PromotionGroup` → `schema.prisma:L18457`
- `PromotionOption` → `schema.prisma:L18473`
- `ProviderCostStructure` → `schema.prisma:L7123`
- `ProviderEventLog` → `schema.prisma:L6752`
- `PurchaseOrder` → `schema.prisma:L2595`
- `PurchaseOrderInvoice` → `schema.prisma:L2740`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2807`
- `PurchaseOrderItem` → `schema.prisma:L2653`
- `RateCorrectionBatch` → `schema.prisma:L7352`
- `RateCorrectionEntry` → `schema.prisma:L7394`
- `RawMaterial` → `schema.prisma:L2351`
- `RawMaterialMovement` → `schema.prisma:L2941`
- `RawMaterialPresentation` → `schema.prisma:L2427`
- `ReceiptLayout` → `schema.prisma:L18904`
- `Recipe` → `schema.prisma:L2447`
- `RecipeLine` → `schema.prisma:L2471`
- `Referral` → `schema.prisma:L8624`
- `ReferralProgramConfig` → `schema.prisma:L8589`
- `ReferralRewardGrant` → `schema.prisma:L8715`
- `ReferralTierReward` → `schema.prisma:L8687`
- `ReferralTierUnlock` → `schema.prisma:L8760`
- `RefreshGrant` → `schema.prisma:L18849`
- `Reservation` → `schema.prisma:L14179`
- `ReservationGoogleEventMapping` → `schema.prisma:L15239`
- `ReservationModifier` → `schema.prisma:L14364`
- `ReservationReminderSent` → `schema.prisma:L14347`
- `ReservationSettings` → `schema.prisma:L14588`
- `ReservationWaitlistEntry` → `schema.prisma:L14556`
- `Review` → `schema.prisma:L5398`
- `SalesRetention` → `schema.prisma:L17812`
- `SaleVerification` → `schema.prisma:L4855`
- `ScaleProfile` → `schema.prisma:L16601`
- `ScheduledCommand` → `schema.prisma:L11002`
- `SerializedItem` → `schema.prisma:L12652`
- `SerializedItemCustodyEvent` → `schema.prisma:L12819`
- `ServiceCharge` → `schema.prisma:L9229`
- `ServiceEarning` → `schema.prisma:L19278`
- `ServicePayPeriod` → `schema.prisma:L19254`
- `ServicePayTable` → `schema.prisma:L19162`
- `ServicePayTableCell` → `schema.prisma:L19204`
- `ServicePayTableVersion` → `schema.prisma:L19179`
- `Session` → `schema.prisma:L18828`
- `SettlementConfiguration` → `schema.prisma:L7427`
- `SettlementConfirmation` → `schema.prisma:L7540`
- `SettlementIncident` → `schema.prisma:L7491`
- `SettlementSimulation` → `schema.prisma:L7462`
- `Shift` → `schema.prisma:L3474`
- `ShopifyConnectIntent` → `schema.prisma:L19599`
- `ShopifyImportIssue` → `schema.prisma:L19653`
- `ShopifyInboundEvent` → `schema.prisma:L19575`
- `ShopifyLocationLink` → `schema.prisma:L19449`
- `ShopifyReviewItem` → `schema.prisma:L19621`
- `ShopifyStockOutbox` → `schema.prisma:L19545`
- `ShopifyStore` → `schema.prisma:L19420`
- `ShopifyVariantLink` → `schema.prisma:L19497`
- `SimRegistrationRequest` → `schema.prisma:L12857`
- `SimRegistrationRequestItem` → `schema.prisma:L12879`
- `SlotHold` → `schema.prisma:L14447`
- `Staff` → `schema.prisma:L1036`
- `StaffAssignment` → `schema.prisma:L3761`
- `StaffDocument` → `schema.prisma:L3785`
- `StaffOnboardingState` → `schema.prisma:L16931`
- `StaffOrganization` → `schema.prisma:L1373`
- `StaffPasskey` → `schema.prisma:L1400`
- `StaffPayLevel` → `schema.prisma:L19126`
- `StaffPayLevelAssignment` → `schema.prisma:L19144`
- `StaffPayStatement` → `schema.prisma:L19310`
- `StaffPayTipWindow` → `schema.prisma:L19672`
- `StaffPayVenueWindow` → `schema.prisma:L19689`
- `StaffPosition` → `schema.prisma:L3740`
- `StaffSchedule` → `schema.prisma:L14387`
- `StaffScheduleException` → `schema.prisma:L14399`
- `StaffVenue` → `schema.prisma:L1297`
- `StaffWorkSchedule` → `schema.prisma:L3599`
- `StaffWorkScheduleException` → `schema.prisma:L3697`
- `StampCard` → `schema.prisma:L8472`
- `StampEvent` → `schema.prisma:L8511`
- `StampReward` → `schema.prisma:L8549`
- `StockAlertConfig` → `schema.prisma:L13518`
- `StockBatch` → `schema.prisma:L3111`
- `StockCount` → `schema.prisma:L3024`
- `StockCountItem` → `schema.prisma:L3052`
- `StripeWebhookEvent` → `schema.prisma:L7070`
- `Supplier` → `schema.prisma:L2506`
- `SupplierItemCode` → `schema.prisma:L2851`
- `SupplierPricing` → `schema.prisma:L2561`
- `Table` → `schema.prisma:L3365`
- `Terminal` → `schema.prisma:L5449`
- `TerminalAttemptResolution` → `schema.prisma:L5887`
- `TerminalHealth` → `schema.prisma:L5707`
- `TerminalLog` → `schema.prisma:L5681`
- `TerminalOrder` → `schema.prisma:L5931`
- `TerminalOrderItem` → `schema.prisma:L6006`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5859`
- `TerminalPaymentRequest` → `schema.prisma:L5778`
- `TimeEntry` → `schema.prisma:L3827`
- `TimeEntryBreak` → `schema.prisma:L3896`
- `TokenPurchase` → `schema.prisma:L10674`
- `TokenUsageRecord` → `schema.prisma:L10646`
- `TpvCommandHistory` → `schema.prisma:L10908`
- `TpvCommandQueue` → `schema.prisma:L10846`
- `TpvFeedback` → `schema.prisma:L10559`
- `TpvMessage` → `schema.prisma:L13875`
- `TpvMessageDelivery` → `schema.prisma:L13927`
- `TpvMessageResponse` → `schema.prisma:L13950`
- `TrainingModule` → `schema.prisma:L14005`
- `TrainingProgress` → `schema.prisma:L14082`
- `TrainingQuizQuestion` → `schema.prisma:L14064`
- `TrainingStep` → `schema.prisma:L14044`
- `TransactionCost` → `schema.prisma:L7290`
- `UnitConversion` → `schema.prisma:L2919`
- `UpsellAcceptance` → `schema.prisma:L9045`
- `UpsellAiRun` → `schema.prisma:L9065`
- `UpsellImpression` → `schema.prisma:L9005`
- `UpsellRule` → `schema.prisma:L8925`
- `user_sessions` → `schema.prisma:L6508`
- `Venue` → `schema.prisma:L185`
- `VenueAreaTicketSettings` → `schema.prisma:L16338`
- `VenueChatMessage` → `schema.prisma:L844`
- `VenueChatSession` → `schema.prisma:L799`
- `VenueCommission` → `schema.prisma:L15933`
- `VenueCreditAssessment` → `schema.prisma:L11390`
- `VenueCryptoConfig` → `schema.prisma:L13742`
- `VenueFeature` → `schema.prisma:L4969`
- `VenueIvaPorProducto` → `schema.prisma:L999`
- `VenueModule` → `schema.prisma:L11550`
- `VenuePaymentConfig` → `schema.prisma:L6609`
- `VenuePaymentLinkSettings` → `schema.prisma:L15272`
- `VenuePosSinAparato` → `schema.prisma:L1010`
- `VenuePricingStructure` → `schema.prisma:L7230`
- `VenueRoleConfig` → `schema.prisma:L1526`
- `VenueRolePermission` → `schema.prisma:L1430`
- `VenueScaleSettings` → `schema.prisma:L16589`
- `VenueSettings` → `schema.prisma:L884`
- `VenueTenderType` → `schema.prisma:L4714`
- `VenueTenderTypeRevision` → `schema.prisma:L4779`
- `VenueTransaction` → `schema.prisma:L4906`
- `VenueWhatsappActivation` → `schema.prisma:L735`
- `WalletCardDesign` → `schema.prisma:L8390`
- `WalletPass` → `schema.prisma:L8291`
- `WalletPassRegistration` → `schema.prisma:L8357`
- `WebhookEvent` → `schema.prisma:L5307`
- `WebhookSubscription` → `schema.prisma:L6725`
- `WhatsappContactWindow` → `schema.prisma:L753`
- `WhatsappInboundEvent` → `schema.prisma:L773`
- `WorkShiftAssignment` → `schema.prisma:L3639`
- `WorkShiftTemplate` → `schema.prisma:L3616`
- `Zone` → `schema.prisma:L168`
