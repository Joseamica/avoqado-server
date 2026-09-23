# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **371 models / 356 enums / ~17,900 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                         |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                             |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `InventoryWasteReport`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                               |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                            |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                      |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                                         |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                                 |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                      |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L16487`
- `AccountMapping` → `schema.prisma:L16383`
- `ActivityLog` → `schema.prisma:L6990`
- `Aggregator` → `schema.prisma:L14780`
- `AngelPayUserAccount` → `schema.prisma:L5641`
- `AppUpdate` → `schema.prisma:L12945`
- `Area` → `schema.prisma:L3202`
- `AreaTicket` → `schema.prisma:L15278`
- `AreaTicketCheckoutSession` → `schema.prisma:L15400`
- `AreaTicketExternalIncident` → `schema.prisma:L15647`
- `AreaTicketExternalSettlement` → `schema.prisma:L15612`
- `AreaTicketFulfillment` → `schema.prisma:L15476`
- `AreaTicketInventoryReservation` → `schema.prisma:L15371`
- `AreaTicketLine` → `schema.prisma:L15339`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15432`
- `AreaTicketPrintAttempt` → `schema.prisma:L15455`
- `BankStatement` → `schema.prisma:L16257`
- `BankStatementLine` → `schema.prisma:L16278`
- `BillingTaxProfile` → `schema.prisma:L17067`
- `BirthdayAutomation` → `schema.prisma:L7311`
- `BulkCommandOperation` → `schema.prisma:L10225`
- `CalendarSyncOutbox` → `schema.prisma:L14152`
- `CampaignDelivery` → `schema.prisma:L13103`
- `CashCloseout` → `schema.prisma:L10610`
- `CashDeposit` → `schema.prisma:L12747`
- `CashDrawerEvent` → `schema.prisma:L14617`
- `CashDrawerSession` → `schema.prisma:L14578`
- `CashOutCommissionRate` → `schema.prisma:L16896`
- `CashOutScheduleDay` → `schema.prisma:L16919`
- `CashOutWithdrawal` → `schema.prisma:L16981`
- `CatalogBindingBatch` → `schema.prisma:L11641`
- `CatalogBindingLine` → `schema.prisma:L11677`
- `CatalogBrand` → `schema.prisma:L11094`
- `CatalogClientObservation` → `schema.prisma:L11407`
- `CatalogClientReadinessOverride` → `schema.prisma:L11426`
- `CatalogFamily` → `schema.prisma:L11144`
- `CatalogIdempotencyRecord` → `schema.prisma:L11540`
- `CatalogIdentifier` → `schema.prisma:L11275`
- `CatalogImportBatch` → `schema.prisma:L11583`
- `CatalogImportLine` → `schema.prisma:L11620`
- `CatalogItem` → `schema.prisma:L11177`
- `CatalogItemBusinessType` → `schema.prisma:L11237`
- `CatalogItemPrice` → `schema.prisma:L11325`
- `CatalogManufacturer` → `schema.prisma:L11118`
- `CatalogProductTypeMapping` → `schema.prisma:L11254`
- `CatalogPublicationBatch` → `schema.prisma:L11705`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11799`
- `CatalogPublicationLine` → `schema.prisma:L11746`
- `CatalogPublicationOutbox` → `schema.prisma:L11842`
- `CatalogValidationProfile` → `schema.prisma:L11296`
- `CatalogVenueBinding` → `schema.prisma:L11454`
- `CatalogVenueClientRequirement` → `schema.prisma:L11381`
- `CatalogVenueEventSequence` → `schema.prisma:L11825`
- `CatalogVenueOverride` → `schema.prisma:L11496`
- `CatalogVenueRollout` → `schema.prisma:L11356`
- `Cfdi` → `schema.prisma:L16160`
- `ChatbotTokenBudget` → `schema.prisma:L9873`
- `ChatConversation` → `schema.prisma:L9728`
- `ChatFeedback` → `schema.prisma:L9814`
- `ChatLearningEvent` → `schema.prisma:L9771`
- `ChatMessage` → `schema.prisma:L9751`
- `ChatTrainingData` → `schema.prisma:L9685`
- `CheckoutSession` → `schema.prisma:L5921`
- `ClassSession` → `schema.prisma:L13756`
- `CommissionCalculation` → `schema.prisma:L12523`
- `CommissionClawback` → `schema.prisma:L12699`
- `CommissionConfig` → `schema.prisma:L12289`
- `CommissionMilestone` → `schema.prisma:L12439`
- `CommissionOverride` → `schema.prisma:L12366`
- `CommissionPayout` → `schema.prisma:L12650`
- `CommissionSummary` → `schema.prisma:L12589`
- `CommissionTier` → `schema.prisma:L12403`
- `ConsentEvent` → `schema.prisma:L7173`
- `Consumer` → `schema.prisma:L7403`
- `ConsumerAuthAccount` → `schema.prisma:L7428`
- `CouponCode` → `schema.prisma:L8375`
- `CouponRedemption` → `schema.prisma:L8406`
- `CreditAssessmentHistory` → `schema.prisma:L10719`
- `CreditItemBalance` → `schema.prisma:L14368`
- `CreditOffer` → `schema.prisma:L10738`
- `CreditPack` → `schema.prisma:L14277`
- `CreditPackItem` → `schema.prisma:L14306`
- `CreditPackPurchase` → `schema.prisma:L14323`
- `CreditTransaction` → `schema.prisma:L14390`
- `Customer` → `schema.prisma:L7031`
- `CustomerApprovalDelivery` → `schema.prisma:L9387`
- `CustomerApprovalOutbox` → `schema.prisma:L9362`
- `CustomerCampaign` → `schema.prisma:L7261`
- `CustomerCampaignDelivery` → `schema.prisma:L7343`
- `CustomerCaptureToken` → `schema.prisma:L7209`
- `CustomerDiscount` → `schema.prisma:L8426`
- `CustomerGroup` → `schema.prisma:L7467`
- `CustomerOrderMetric` → `schema.prisma:L3973`
- `CustomerTaxProfile` → `schema.prisma:L16229`
- `DeliveryActivationRequest` → `schema.prisma:L6274`
- `DeliveryChannelLink` → `schema.prisma:L6219`
- `DeliveryOrderEvent` → `schema.prisma:L6298`
- `DeviceToken` → `schema.prisma:L8695`
- `DigitalReceipt` → `schema.prisma:L4551`
- `Discount` → `schema.prisma:L8065`
- `EcommerceMerchant` → `schema.prisma:L5733`
- `EmailQuotaLedger` → `schema.prisma:L7390`
- `EmailSuppression` → `schema.prisma:L7378`
- `EmailTemplate` → `schema.prisma:L13042`
- `Employee` → `schema.prisma:L16744`
- `Estimate` → `schema.prisma:L14687`
- `EstimateItem` → `schema.prisma:L14715`
- `Expense` → `schema.prisma:L16531`
- `ExternalBusyBlock` → `schema.prisma:L14045`
- `Feature` → `schema.prisma:L4680`
- `FeeSchedule` → `schema.prisma:L4765`
- `FeeTier` → `schema.prisma:L4776`
- `FinancialAccount` → `schema.prisma:L14877`
- `FinancialConnection` → `schema.prisma:L14846`
- `FinancialProvider` → `schema.prisma:L14832`
- `FiscalEmisor` → `schema.prisma:L16083`
- `FiscalLossCarryforward` → `schema.prisma:L16654`
- `FixedAsset` → `schema.prisma:L16672`
- `FixedAssetDepreciation` → `schema.prisma:L16701`
- `FloorElement` → `schema.prisma:L3278`
- `FulfillmentArea` → `schema.prisma:L15143`
- `GeofenceRule` → `schema.prisma:L10310`
- `GoogleCalendarChannel` → `schema.prisma:L14022`
- `GoogleCalendarConnection` → `schema.prisma:L13974`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14075`
- `GoogleOAuthSession` → `schema.prisma:L14097`
- `HolidayCalendar` → `schema.prisma:L6914`
- `IdempotencyRequest` → `schema.prisma:L12164`
- `InterVenueTransfer` → `schema.prisma:L3030`
- `InterVenueTransferAllocation` → `schema.prisma:L3113`
- `InterVenueTransferItem` → `schema.prisma:L3082`
- `InterVenueTransferReceipt` → `schema.prisma:L3140`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3156`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3184`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3168`
- `Inventory` → `schema.prisma:L1974`
- `InventoryMovement` → `schema.prisma:L2074`
- `InventoryPosting` → `schema.prisma:L2169`
- `InventoryPostingLine` → `schema.prisma:L2209`
- `InventoryTransfer` → `schema.prisma:L14659`
- `InventoryWasteReport` → `schema.prisma:L2029`
- `Invitation` → `schema.prisma:L1479`
- `Invoice` → `schema.prisma:L4788`
- `InvoiceItem` → `schema.prisma:L4814`
- `ItemCategory` → `schema.prisma:L11877`
- `JournalEntry` → `schema.prisma:L16441`
- `JournalLine` → `schema.prisma:L16469`
- `KdsOrder` → `schema.prisma:L14925`
- `KdsOrderItem` → `schema.prisma:L14966`
- `KioskCheckInAttempt` → `schema.prisma:L17390`
- `KioskCheckInChallenge` → `schema.prisma:L17344`
- `KioskOutreachOutbox` → `schema.prisma:L17411`
- `LaunchCampaign` → `schema.prisma:L17749`
- `LaunchCampaignRedemption` → `schema.prisma:L17855`
- `LearnedPatterns` → `schema.prisma:L9795`
- `LedgerAccount` → `schema.prisma:L16333`
- `LiveDemoSession` → `schema.prisma:L823`
- `LowStockAlert` → `schema.prisma:L2864`
- `LoyaltyConfig` → `schema.prisma:L7497`
- `LoyaltyTransaction` → `schema.prisma:L7540`
- `MarketingCampaign` → `schema.prisma:L13060`
- `McpAuthCode` → `schema.prisma:L15966`
- `McpOAuthClient` → `schema.prisma:L15950`
- `McpRefreshToken` → `schema.prisma:L15984`
- `McpToolCall` → `schema.prisma:L16005`
- `MeasurementUnit` → `schema.prisma:L14765`
- `Menu` → `schema.prisma:L1697`
- `MenuCategory` → `schema.prisma:L1634`
- `MenuCategoryAssignment` → `schema.prisma:L1732`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15880`
- `MerchantAccount` → `schema.prisma:L5471`
- `MerchantFiscalConfig` → `schema.prisma:L16131`
- `MerchantRevenueShare` → `schema.prisma:L6494`
- `MerchantRoutingRule` → `schema.prisma:L5593`
- `MilestoneAchievement` → `schema.prisma:L12484`
- `Modifier` → `schema.prisma:L4157`
- `ModifierGroup` → `schema.prisma:L4121`
- `Module` → `schema.prisma:L10786`
- `MoneyAnomaly` → `schema.prisma:L6397`
- `MonthlyVenueProfit` → `schema.prisma:L6940`
- `Notification` → `schema.prisma:L8597`
- `NotificationPreference` → `schema.prisma:L8644`
- `NotificationTemplate` → `schema.prisma:L8671`
- `OAuthState` → `schema.prisma:L1530`
- `OnboardingProgress` → `schema.prisma:L1548`
- `Order` → `schema.prisma:L3727`
- `OrderAction` → `schema.prisma:L4224`
- `OrderCustomer` → `schema.prisma:L3952`
- `OrderDiscount` → `schema.prisma:L8458`
- `OrderFulfillment` → `schema.prisma:L15198`
- `OrderFulfillmentLine` → `schema.prisma:L15229`
- `OrderItem` → `schema.prisma:L3988`
- `OrderItemModifier` → `schema.prisma:L4206`
- `OrderPromotion` → `schema.prisma:L17307`
- `OrderServiceCharge` → `schema.prisma:L8542`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12861`
- `OrganizationEntitlement` → `schema.prisma:L11069`
- `OrganizationGoal` → `schema.prisma:L12819`
- `OrganizationModule` → `schema.prisma:L10846`
- `OrganizationPaymentConfig` → `schema.prisma:L6045`
- `OrganizationPayoutConfig` → `schema.prisma:L12894`
- `OrganizationPricingStructure` → `schema.prisma:L6077`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12842`
- `OtpChallenge` → `schema.prisma:L7447`
- `OvertimeApproval` → `schema.prisma:L3505`
- `PartnerAPIKey` → `schema.prisma:L5875`
- `Payment` → `schema.prisma:L4257`
- `PaymentAllocation` → `schema.prisma:L4530`
- `PaymentEffect` → `schema.prisma:L17681`
- `PaymentLink` → `schema.prisma:L14436`
- `PaymentLinkAttribution` → `schema.prisma:L14544`
- `PaymentLinkItem` → `schema.prisma:L14499`
- `PaymentLinkItemModifier` → `schema.prisma:L14526`
- `PaymentProvider` → `schema.prisma:L5430`
- `PayrollLine` → `schema.prisma:L16815`
- `PayrollRun` → `schema.prisma:L16784`
- `PerformanceGoal` → `schema.prisma:L12796`
- `PermissionOverride` → `schema.prisma:L1403`
- `PermissionSet` → `schema.prisma:L1426`
- `PlatformAnnouncement` → `schema.prisma:L17471`
- `PlatformAnnouncementClick` → `schema.prisma:L17536`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17573`
- `PlatformCfdi` → `schema.prisma:L17100`
- `PlatformEmisor` → `schema.prisma:L17040`
- `PlatformSettings` → `schema.prisma:L5852`
- `PosCommand` → `schema.prisma:L8725`
- `PosConnectionStatus` → `schema.prisma:L949`
- `PosSyncIntent` → `schema.prisma:L17178`
- `PricingPolicy` → `schema.prisma:L2760`
- `Printer` → `schema.prisma:L15008`
- `PrintGateway` → `schema.prisma:L15065`
- `PrintJob` → `schema.prisma:L15779`
- `PrintStation` → `schema.prisma:L15083`
- `PrivacyNoticeVersion` → `schema.prisma:L7195`
- `ProcessedStripeEvent` → `schema.prisma:L6383`
- `ProcessorReliabilityMetric` → `schema.prisma:L6868`
- `Product` → `schema.prisma:L1750`
- `ProductModifierGroup` → `schema.prisma:L4194`
- `ProductOption` → `schema.prisma:L14742`
- `ProductOptionValue` → `schema.prisma:L14753`
- `ProductStaff` → `schema.prisma:L13671`
- `PromoterBankAccount` → `schema.prisma:L16935`
- `PromoterCommissionEntry` → `schema.prisma:L16954`
- `PromoterLocationPing` → `schema.prisma:L3693`
- `Promotion` → `schema.prisma:L17229`
- `PromotionGroup` → `schema.prisma:L17268`
- `PromotionOption` → `schema.prisma:L17284`
- `ProviderCostStructure` → `schema.prisma:L6419`
- `ProviderEventLog` → `schema.prisma:L6154`
- `PurchaseOrder` → `schema.prisma:L2485`
- `PurchaseOrderInvoice` → `schema.prisma:L2630`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2687`
- `PurchaseOrderItem` → `schema.prisma:L2543`
- `RateCorrectionBatch` → `schema.prisma:L6644`
- `RateCorrectionEntry` → `schema.prisma:L6686`
- `RawMaterial` → `schema.prisma:L2241`
- `RawMaterialMovement` → `schema.prisma:L2813`
- `RawMaterialPresentation` → `schema.prisma:L2317`
- `ReceiptLayout` → `schema.prisma:L17715`
- `Recipe` → `schema.prisma:L2337`
- `RecipeLine` → `schema.prisma:L2361`
- `Referral` → `schema.prisma:L7913`
- `ReferralProgramConfig` → `schema.prisma:L7878`
- `ReferralRewardGrant` → `schema.prisma:L8004`
- `ReferralTierReward` → `schema.prisma:L7976`
- `ReferralTierUnlock` → `schema.prisma:L8049`
- `RefreshGrant` → `schema.prisma:L17660`
- `Reservation` → `schema.prisma:L13439`
- `ReservationGoogleEventMapping` → `schema.prisma:L14209`
- `ReservationModifier` → `schema.prisma:L13619`
- `ReservationReminderSent` → `schema.prisma:L13602`
- `ReservationSettings` → `schema.prisma:L13833`
- `ReservationWaitlistEntry` → `schema.prisma:L13801`
- `Review` → `schema.prisma:L4832`
- `SalesRetention` → `schema.prisma:L16635`
- `SaleVerification` → `schema.prisma:L4584`
- `ScaleProfile` → `schema.prisma:L15520`
- `ScheduledCommand` → `schema.prisma:L10270`
- `SerializedItem` → `schema.prisma:L11920`
- `SerializedItemCustodyEvent` → `schema.prisma:L12087`
- `ServiceCharge` → `schema.prisma:L8513`
- `Session` → `schema.prisma:L17639`
- `SettlementConfiguration` → `schema.prisma:L6719`
- `SettlementConfirmation` → `schema.prisma:L6832`
- `SettlementIncident` → `schema.prisma:L6783`
- `SettlementSimulation` → `schema.prisma:L6754`
- `Shift` → `schema.prisma:L3316`
- `SimRegistrationRequest` → `schema.prisma:L12125`
- `SimRegistrationRequestItem` → `schema.prisma:L12147`
- `SlotHold` → `schema.prisma:L13702`
- `Staff` → `schema.prisma:L969`
- `StaffDocument` → `schema.prisma:L3564`
- `StaffOnboardingState` → `schema.prisma:L15850`
- `StaffOrganization` → `schema.prisma:L1302`
- `StaffPasskey` → `schema.prisma:L1329`
- `StaffSchedule` → `schema.prisma:L13642`
- `StaffScheduleException` → `schema.prisma:L13654`
- `StaffVenue` → `schema.prisma:L1226`
- `StaffWorkSchedule` → `schema.prisma:L3441`
- `StaffWorkScheduleException` → `schema.prisma:L3539`
- `StampCard` → `schema.prisma:L7761`
- `StampEvent` → `schema.prisma:L7800`
- `StampReward` → `schema.prisma:L7838`
- `StockAlertConfig` → `schema.prisma:L12778`
- `StockBatch` → `schema.prisma:L2979`
- `StockCount` → `schema.prisma:L2896`
- `StockCountItem` → `schema.prisma:L2924`
- `StripeWebhookEvent` → `schema.prisma:L6366`
- `Supplier` → `schema.prisma:L2396`
- `SupplierItemCode` → `schema.prisma:L2728`
- `SupplierPricing` → `schema.prisma:L2451`
- `Table` → `schema.prisma:L3228`
- `Terminal` → `schema.prisma:L4883`
- `TerminalHealth` → `schema.prisma:L5134`
- `TerminalLog` → `schema.prisma:L5108`
- `TerminalOrder` → `schema.prisma:L5333`
- `TerminalOrderItem` → `schema.prisma:L5408`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5286`
- `TerminalPaymentRequest` → `schema.prisma:L5205`
- `TimeEntry` → `schema.prisma:L3606`
- `TimeEntryBreak` → `schema.prisma:L3675`
- `TokenPurchase` → `schema.prisma:L9944`
- `TokenUsageRecord` → `schema.prisma:L9916`
- `TpvCommandHistory` → `schema.prisma:L10176`
- `TpvCommandQueue` → `schema.prisma:L10116`
- `TpvFeedback` → `schema.prisma:L9829`
- `TpvMessage` → `schema.prisma:L13135`
- `TpvMessageDelivery` → `schema.prisma:L13187`
- `TpvMessageResponse` → `schema.prisma:L13210`
- `TrainingModule` → `schema.prisma:L13265`
- `TrainingProgress` → `schema.prisma:L13342`
- `TrainingQuizQuestion` → `schema.prisma:L13324`
- `TrainingStep` → `schema.prisma:L13304`
- `TransactionCost` → `schema.prisma:L6582`
- `UnitConversion` → `schema.prisma:L2791`
- `UpsellAcceptance` → `schema.prisma:L8334`
- `UpsellAiRun` → `schema.prisma:L8354`
- `UpsellImpression` → `schema.prisma:L8294`
- `UpsellRule` → `schema.prisma:L8214`
- `user_sessions` → `schema.prisma:L5910`
- `Venue` → `schema.prisma:L163`
- `VenueAreaTicketSettings` → `schema.prisma:L15257`
- `VenueChatMessage` → `schema.prisma:L799`
- `VenueChatSession` → `schema.prisma:L754`
- `VenueCommission` → `schema.prisma:L14903`
- `VenueCreditAssessment` → `schema.prisma:L10658`
- `VenueCryptoConfig` → `schema.prisma:L13002`
- `VenueFeature` → `schema.prisma:L4698`
- `VenueModule` → `schema.prisma:L10818`
- `VenuePaymentConfig` → `schema.prisma:L6011`
- `VenuePaymentLinkSettings` → `schema.prisma:L14242`
- `VenuePricingStructure` → `schema.prisma:L6522`
- `VenueRoleConfig` → `schema.prisma:L1455`
- `VenueRolePermission` → `schema.prisma:L1359`
- `VenueScaleSettings` → `schema.prisma:L15508`
- `VenueSettings` → `schema.prisma:L839`
- `VenueTenderType` → `schema.prisma:L4443`
- `VenueTenderTypeRevision` → `schema.prisma:L4508`
- `VenueTransaction` → `schema.prisma:L4635`
- `VenueWhatsappActivation` → `schema.prisma:L690`
- `WalletCardDesign` → `schema.prisma:L7679`
- `WalletPass` → `schema.prisma:L7580`
- `WalletPassRegistration` → `schema.prisma:L7646`
- `WebhookEvent` → `schema.prisma:L4741`
- `WebhookSubscription` → `schema.prisma:L6127`
- `WhatsappContactWindow` → `schema.prisma:L708`
- `WhatsappInboundEvent` → `schema.prisma:L728`
- `WorkShiftAssignment` → `schema.prisma:L3481`
- `WorkShiftTemplate` → `schema.prisma:L3458`
- `Zone` → `schema.prisma:L146`
