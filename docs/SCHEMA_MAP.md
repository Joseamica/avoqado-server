# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **359 models / 341 enums / ~17,100 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                        |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                            |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                                      |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                           |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                           |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                            |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                        |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCaptureToken`, `CustomerGroup`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L15947`
- `AccountMapping` → `schema.prisma:L15843`
- `ActivityLog` → `schema.prisma:L6669`
- `Aggregator` → `schema.prisma:L14244`
- `AngelPayUserAccount` → `schema.prisma:L5332`
- `AppUpdate` → `schema.prisma:L12424`
- `Area` → `schema.prisma:L3025`
- `AreaTicket` → `schema.prisma:L14738`
- `AreaTicketCheckoutSession` → `schema.prisma:L14860`
- `AreaTicketExternalIncident` → `schema.prisma:L15107`
- `AreaTicketExternalSettlement` → `schema.prisma:L15072`
- `AreaTicketFulfillment` → `schema.prisma:L14936`
- `AreaTicketInventoryReservation` → `schema.prisma:L14831`
- `AreaTicketLine` → `schema.prisma:L14799`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14892`
- `AreaTicketPrintAttempt` → `schema.prisma:L14915`
- `BankStatement` → `schema.prisma:L15717`
- `BankStatementLine` → `schema.prisma:L15738`
- `BillingTaxProfile` → `schema.prisma:L16527`
- `BulkCommandOperation` → `schema.prisma:L9707`
- `CalendarSyncOutbox` → `schema.prisma:L13631`
- `CampaignDelivery` → `schema.prisma:L12582`
- `CashCloseout` → `schema.prisma:L10092`
- `CashDeposit` → `schema.prisma:L12226`
- `CashDrawerEvent` → `schema.prisma:L14081`
- `CashDrawerSession` → `schema.prisma:L14057`
- `CashOutCommissionRate` → `schema.prisma:L16356`
- `CashOutScheduleDay` → `schema.prisma:L16379`
- `CashOutWithdrawal` → `schema.prisma:L16441`
- `CatalogBindingBatch` → `schema.prisma:L11123`
- `CatalogBindingLine` → `schema.prisma:L11159`
- `CatalogBrand` → `schema.prisma:L10576`
- `CatalogClientObservation` → `schema.prisma:L10889`
- `CatalogClientReadinessOverride` → `schema.prisma:L10908`
- `CatalogFamily` → `schema.prisma:L10626`
- `CatalogIdempotencyRecord` → `schema.prisma:L11022`
- `CatalogIdentifier` → `schema.prisma:L10757`
- `CatalogImportBatch` → `schema.prisma:L11065`
- `CatalogImportLine` → `schema.prisma:L11102`
- `CatalogItem` → `schema.prisma:L10659`
- `CatalogItemBusinessType` → `schema.prisma:L10719`
- `CatalogItemPrice` → `schema.prisma:L10807`
- `CatalogManufacturer` → `schema.prisma:L10600`
- `CatalogProductTypeMapping` → `schema.prisma:L10736`
- `CatalogPublicationBatch` → `schema.prisma:L11187`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11281`
- `CatalogPublicationLine` → `schema.prisma:L11228`
- `CatalogPublicationOutbox` → `schema.prisma:L11324`
- `CatalogValidationProfile` → `schema.prisma:L10778`
- `CatalogVenueBinding` → `schema.prisma:L10936`
- `CatalogVenueClientRequirement` → `schema.prisma:L10863`
- `CatalogVenueEventSequence` → `schema.prisma:L11307`
- `CatalogVenueOverride` → `schema.prisma:L10978`
- `CatalogVenueRollout` → `schema.prisma:L10838`
- `Cfdi` → `schema.prisma:L15620`
- `ChatbotTokenBudget` → `schema.prisma:L9355`
- `ChatConversation` → `schema.prisma:L9210`
- `ChatFeedback` → `schema.prisma:L9296`
- `ChatLearningEvent` → `schema.prisma:L9253`
- `ChatMessage` → `schema.prisma:L9233`
- `ChatTrainingData` → `schema.prisma:L9167`
- `CheckoutSession` → `schema.prisma:L5612`
- `ClassSession` → `schema.prisma:L13235`
- `CommissionCalculation` → `schema.prisma:L12002`
- `CommissionClawback` → `schema.prisma:L12178`
- `CommissionConfig` → `schema.prisma:L11768`
- `CommissionMilestone` → `schema.prisma:L11918`
- `CommissionOverride` → `schema.prisma:L11845`
- `CommissionPayout` → `schema.prisma:L12129`
- `CommissionSummary` → `schema.prisma:L12068`
- `CommissionTier` → `schema.prisma:L11882`
- `ConsentEvent` → `schema.prisma:L6848`
- `Consumer` → `schema.prisma:L6898`
- `ConsumerAuthAccount` → `schema.prisma:L6923`
- `CouponCode` → `schema.prisma:L7862`
- `CouponRedemption` → `schema.prisma:L7893`
- `CreditAssessmentHistory` → `schema.prisma:L10201`
- `CreditItemBalance` → `schema.prisma:L13847`
- `CreditOffer` → `schema.prisma:L10220`
- `CreditPack` → `schema.prisma:L13756`
- `CreditPackItem` → `schema.prisma:L13785`
- `CreditPackPurchase` → `schema.prisma:L13802`
- `CreditTransaction` → `schema.prisma:L13869`
- `Customer` → `schema.prisma:L6710`
- `CustomerApprovalDelivery` → `schema.prisma:L8869`
- `CustomerApprovalOutbox` → `schema.prisma:L8844`
- `CustomerCaptureToken` → `schema.prisma:L6884`
- `CustomerDiscount` → `schema.prisma:L7913`
- `CustomerGroup` → `schema.prisma:L6962`
- `CustomerTaxProfile` → `schema.prisma:L15689`
- `DeliveryActivationRequest` → `schema.prisma:L5953`
- `DeliveryChannelLink` → `schema.prisma:L5898`
- `DeliveryOrderEvent` → `schema.prisma:L5977`
- `DeviceToken` → `schema.prisma:L8182`
- `DigitalReceipt` → `schema.prisma:L4315`
- `Discount` → `schema.prisma:L7552`
- `EcommerceMerchant` → `schema.prisma:L5424`
- `EmailTemplate` → `schema.prisma:L12521`
- `Employee` → `schema.prisma:L16204`
- `Estimate` → `schema.prisma:L14151`
- `EstimateItem` → `schema.prisma:L14179`
- `Expense` → `schema.prisma:L15991`
- `ExternalBusyBlock` → `schema.prisma:L13524`
- `Feature` → `schema.prisma:L4444`
- `FeeSchedule` → `schema.prisma:L4522`
- `FeeTier` → `schema.prisma:L4533`
- `FinancialAccount` → `schema.prisma:L14341`
- `FinancialConnection` → `schema.prisma:L14310`
- `FinancialProvider` → `schema.prisma:L14296`
- `FiscalEmisor` → `schema.prisma:L15543`
- `FiscalLossCarryforward` → `schema.prisma:L16114`
- `FixedAsset` → `schema.prisma:L16132`
- `FixedAssetDepreciation` → `schema.prisma:L16161`
- `FloorElement` → `schema.prisma:L3101`
- `FulfillmentArea` → `schema.prisma:L14603`
- `GeofenceRule` → `schema.prisma:L9792`
- `GoogleCalendarChannel` → `schema.prisma:L13501`
- `GoogleCalendarConnection` → `schema.prisma:L13453`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13554`
- `GoogleOAuthSession` → `schema.prisma:L13576`
- `HolidayCalendar` → `schema.prisma:L6593`
- `IdempotencyRequest` → `schema.prisma:L11643`
- `InterVenueTransfer` → `schema.prisma:L2853`
- `InterVenueTransferAllocation` → `schema.prisma:L2936`
- `InterVenueTransferItem` → `schema.prisma:L2905`
- `InterVenueTransferReceipt` → `schema.prisma:L2963`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2979`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3007`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2991`
- `Inventory` → `schema.prisma:L1899`
- `InventoryMovement` → `schema.prisma:L1926`
- `InventoryPosting` → `schema.prisma:L2008`
- `InventoryPostingLine` → `schema.prisma:L2048`
- `InventoryTransfer` → `schema.prisma:L14123`
- `Invitation` → `schema.prisma:L1437`
- `Invoice` → `schema.prisma:L4545`
- `InvoiceItem` → `schema.prisma:L4571`
- `ItemCategory` → `schema.prisma:L11359`
- `JournalEntry` → `schema.prisma:L15901`
- `JournalLine` → `schema.prisma:L15929`
- `KdsOrder` → `schema.prisma:L14389`
- `KdsOrderItem` → `schema.prisma:L14430`
- `KioskCheckInAttempt` → `schema.prisma:L16850`
- `KioskCheckInChallenge` → `schema.prisma:L16804`
- `KioskOutreachOutbox` → `schema.prisma:L16871`
- `LearnedPatterns` → `schema.prisma:L9277`
- `LedgerAccount` → `schema.prisma:L15793`
- `LiveDemoSession` → `schema.prisma:L788`
- `LowStockAlert` → `schema.prisma:L2694`
- `LoyaltyConfig` → `schema.prisma:L6992`
- `LoyaltyTransaction` → `schema.prisma:L7035`
- `MarketingCampaign` → `schema.prisma:L12539`
- `McpAuthCode` → `schema.prisma:L15426`
- `McpOAuthClient` → `schema.prisma:L15410`
- `McpRefreshToken` → `schema.prisma:L15444`
- `McpToolCall` → `schema.prisma:L15465`
- `MeasurementUnit` → `schema.prisma:L14229`
- `Menu` → `schema.prisma:L1623`
- `MenuCategory` → `schema.prisma:L1560`
- `MenuCategoryAssignment` → `schema.prisma:L1658`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15340`
- `MerchantAccount` → `schema.prisma:L5162`
- `MerchantFiscalConfig` → `schema.prisma:L15591`
- `MerchantRevenueShare` → `schema.prisma:L6173`
- `MerchantRoutingRule` → `schema.prisma:L5284`
- `MilestoneAchievement` → `schema.prisma:L11963`
- `Modifier` → `schema.prisma:L3930`
- `ModifierGroup` → `schema.prisma:L3894`
- `Module` → `schema.prisma:L10268`
- `MoneyAnomaly` → `schema.prisma:L6076`
- `MonthlyVenueProfit` → `schema.prisma:L6619`
- `Notification` → `schema.prisma:L8084`
- `NotificationPreference` → `schema.prisma:L8131`
- `NotificationTemplate` → `schema.prisma:L8158`
- `OAuthState` → `schema.prisma:L1488`
- `OnboardingProgress` → `schema.prisma:L1506`
- `Order` → `schema.prisma:L3532`
- `OrderAction` → `schema.prisma:L3995`
- `OrderCustomer` → `schema.prisma:L3745`
- `OrderDiscount` → `schema.prisma:L7945`
- `OrderFulfillment` → `schema.prisma:L14658`
- `OrderFulfillmentLine` → `schema.prisma:L14689`
- `OrderItem` → `schema.prisma:L3761`
- `OrderItemModifier` → `schema.prisma:L3979`
- `OrderPromotion` → `schema.prisma:L16767`
- `OrderServiceCharge` → `schema.prisma:L8029`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12340`
- `OrganizationEntitlement` → `schema.prisma:L10551`
- `OrganizationGoal` → `schema.prisma:L12298`
- `OrganizationModule` → `schema.prisma:L10328`
- `OrganizationPaymentConfig` → `schema.prisma:L5736`
- `OrganizationPayoutConfig` → `schema.prisma:L12373`
- `OrganizationPricingStructure` → `schema.prisma:L5768`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12321`
- `OtpChallenge` → `schema.prisma:L6942`
- `OvertimeApproval` → `schema.prisma:L3310`
- `PartnerAPIKey` → `schema.prisma:L5566`
- `Payment` → `schema.prisma:L4028`
- `PaymentAllocation` → `schema.prisma:L4294`
- `PaymentLink` → `schema.prisma:L13915`
- `PaymentLinkAttribution` → `schema.prisma:L14023`
- `PaymentLinkItem` → `schema.prisma:L13978`
- `PaymentLinkItemModifier` → `schema.prisma:L14005`
- `PaymentProvider` → `schema.prisma:L5121`
- `PayrollLine` → `schema.prisma:L16275`
- `PayrollRun` → `schema.prisma:L16244`
- `PerformanceGoal` → `schema.prisma:L12275`
- `PermissionOverride` → `schema.prisma:L1365`
- `PermissionSet` → `schema.prisma:L1388`
- `PlatformAnnouncement` → `schema.prisma:L16931`
- `PlatformAnnouncementClick` → `schema.prisma:L16996`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17033`
- `PlatformCfdi` → `schema.prisma:L16560`
- `PlatformEmisor` → `schema.prisma:L16500`
- `PlatformSettings` → `schema.prisma:L5543`
- `PosCommand` → `schema.prisma:L8212`
- `PosConnectionStatus` → `schema.prisma:L914`
- `PosSyncIntent` → `schema.prisma:L16638`
- `PricingPolicy` → `schema.prisma:L2598`
- `Printer` → `schema.prisma:L14472`
- `PrintGateway` → `schema.prisma:L14525`
- `PrintJob` → `schema.prisma:L15239`
- `PrintStation` → `schema.prisma:L14543`
- `PrivacyNoticeVersion` → `schema.prisma:L6870`
- `ProcessedStripeEvent` → `schema.prisma:L6062`
- `ProcessorReliabilityMetric` → `schema.prisma:L6547`
- `Product` → `schema.prisma:L1676`
- `ProductModifierGroup` → `schema.prisma:L3967`
- `ProductOption` → `schema.prisma:L14206`
- `ProductOptionValue` → `schema.prisma:L14217`
- `ProductStaff` → `schema.prisma:L13150`
- `PromoterBankAccount` → `schema.prisma:L16395`
- `PromoterCommissionEntry` → `schema.prisma:L16414`
- `PromoterLocationPing` → `schema.prisma:L3498`
- `Promotion` → `schema.prisma:L16689`
- `PromotionGroup` → `schema.prisma:L16728`
- `PromotionOption` → `schema.prisma:L16744`
- `ProviderCostStructure` → `schema.prisma:L6098`
- `ProviderEventLog` → `schema.prisma:L5845`
- `PurchaseOrder` → `schema.prisma:L2323`
- `PurchaseOrderInvoice` → `schema.prisma:L2468`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2525`
- `PurchaseOrderItem` → `schema.prisma:L2381`
- `RateCorrectionBatch` → `schema.prisma:L6323`
- `RateCorrectionEntry` → `schema.prisma:L6365`
- `RawMaterial` → `schema.prisma:L2080`
- `RawMaterialMovement` → `schema.prisma:L2651`
- `RawMaterialPresentation` → `schema.prisma:L2155`
- `Recipe` → `schema.prisma:L2175`
- `RecipeLine` → `schema.prisma:L2199`
- `Referral` → `schema.prisma:L7400`
- `ReferralProgramConfig` → `schema.prisma:L7365`
- `ReferralRewardGrant` → `schema.prisma:L7491`
- `ReferralTierReward` → `schema.prisma:L7463`
- `ReferralTierUnlock` → `schema.prisma:L7536`
- `RefreshGrant` → `schema.prisma:L17120`
- `Reservation` → `schema.prisma:L12918`
- `ReservationGoogleEventMapping` → `schema.prisma:L13688`
- `ReservationModifier` → `schema.prisma:L13098`
- `ReservationReminderSent` → `schema.prisma:L13081`
- `ReservationSettings` → `schema.prisma:L13312`
- `ReservationWaitlistEntry` → `schema.prisma:L13280`
- `Review` → `schema.prisma:L4589`
- `SalesRetention` → `schema.prisma:L16095`
- `SaleVerification` → `schema.prisma:L4348`
- `ScaleProfile` → `schema.prisma:L14980`
- `ScheduledCommand` → `schema.prisma:L9752`
- `SerializedItem` → `schema.prisma:L11402`
- `SerializedItemCustodyEvent` → `schema.prisma:L11566`
- `ServiceCharge` → `schema.prisma:L8000`
- `Session` → `schema.prisma:L17099`
- `SettlementConfiguration` → `schema.prisma:L6398`
- `SettlementConfirmation` → `schema.prisma:L6511`
- `SettlementIncident` → `schema.prisma:L6462`
- `SettlementSimulation` → `schema.prisma:L6433`
- `Shift` → `schema.prisma:L3139`
- `SimRegistrationRequest` → `schema.prisma:L11604`
- `SimRegistrationRequestItem` → `schema.prisma:L11626`
- `SlotHold` → `schema.prisma:L13181`
- `Staff` → `schema.prisma:L934`
- `StaffDocument` → `schema.prisma:L3369`
- `StaffOnboardingState` → `schema.prisma:L15310`
- `StaffOrganization` → `schema.prisma:L1264`
- `StaffPasskey` → `schema.prisma:L1291`
- `StaffSchedule` → `schema.prisma:L13121`
- `StaffScheduleException` → `schema.prisma:L13133`
- `StaffVenue` → `schema.prisma:L1188`
- `StaffWorkSchedule` → `schema.prisma:L3246`
- `StaffWorkScheduleException` → `schema.prisma:L3344`
- `StampCard` → `schema.prisma:L7248`
- `StampEvent` → `schema.prisma:L7287`
- `StampReward` → `schema.prisma:L7325`
- `StockAlertConfig` → `schema.prisma:L12257`
- `StockBatch` → `schema.prisma:L2802`
- `StockCount` → `schema.prisma:L2726`
- `StockCountItem` → `schema.prisma:L2750`
- `StripeWebhookEvent` → `schema.prisma:L6045`
- `Supplier` → `schema.prisma:L2234`
- `SupplierItemCode` → `schema.prisma:L2566`
- `SupplierPricing` → `schema.prisma:L2289`
- `Table` → `schema.prisma:L3051`
- `Terminal` → `schema.prisma:L4640`
- `TerminalHealth` → `schema.prisma:L4891`
- `TerminalLog` → `schema.prisma:L4865`
- `TerminalOrder` → `schema.prisma:L5024`
- `TerminalOrderItem` → `schema.prisma:L5099`
- `TerminalPaymentRequest` → `schema.prisma:L4962`
- `TimeEntry` → `schema.prisma:L3411`
- `TimeEntryBreak` → `schema.prisma:L3480`
- `TokenPurchase` → `schema.prisma:L9426`
- `TokenUsageRecord` → `schema.prisma:L9398`
- `TpvCommandHistory` → `schema.prisma:L9658`
- `TpvCommandQueue` → `schema.prisma:L9598`
- `TpvFeedback` → `schema.prisma:L9311`
- `TpvMessage` → `schema.prisma:L12614`
- `TpvMessageDelivery` → `schema.prisma:L12666`
- `TpvMessageResponse` → `schema.prisma:L12689`
- `TrainingModule` → `schema.prisma:L12744`
- `TrainingProgress` → `schema.prisma:L12821`
- `TrainingQuizQuestion` → `schema.prisma:L12803`
- `TrainingStep` → `schema.prisma:L12783`
- `TransactionCost` → `schema.prisma:L6261`
- `UnitConversion` → `schema.prisma:L2629`
- `UpsellAcceptance` → `schema.prisma:L7821`
- `UpsellAiRun` → `schema.prisma:L7841`
- `UpsellImpression` → `schema.prisma:L7781`
- `UpsellRule` → `schema.prisma:L7701`
- `user_sessions` → `schema.prisma:L5601`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14717`
- `VenueChatMessage` → `schema.prisma:L764`
- `VenueChatSession` → `schema.prisma:L719`
- `VenueCommission` → `schema.prisma:L14367`
- `VenueCreditAssessment` → `schema.prisma:L10140`
- `VenueCryptoConfig` → `schema.prisma:L12481`
- `VenueFeature` → `schema.prisma:L4462`
- `VenueModule` → `schema.prisma:L10300`
- `VenuePaymentConfig` → `schema.prisma:L5702`
- `VenuePaymentLinkSettings` → `schema.prisma:L13721`
- `VenuePricingStructure` → `schema.prisma:L6201`
- `VenueRoleConfig` → `schema.prisma:L1417`
- `VenueRolePermission` → `schema.prisma:L1321`
- `VenueScaleSettings` → `schema.prisma:L14968`
- `VenueSettings` → `schema.prisma:L804`
- `VenueTenderType` → `schema.prisma:L4207`
- `VenueTenderTypeRevision` → `schema.prisma:L4272`
- `VenueTransaction` → `schema.prisma:L4399`
- `VenueWhatsappActivation` → `schema.prisma:L655`
- `WalletCardDesign` → `schema.prisma:L7166`
- `WalletPass` → `schema.prisma:L7075`
- `WalletPassRegistration` → `schema.prisma:L7133`
- `WebhookEvent` → `schema.prisma:L4498`
- `WebhookSubscription` → `schema.prisma:L5818`
- `WhatsappContactWindow` → `schema.prisma:L673`
- `WhatsappInboundEvent` → `schema.prisma:L693`
- `WorkShiftAssignment` → `schema.prisma:L3286`
- `WorkShiftTemplate` → `schema.prisma:L3263`
- `Zone` → `schema.prisma:L142`
