# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **371 models / 356 enums / ~17,800 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L16477`
- `AccountMapping` → `schema.prisma:L16373`
- `ActivityLog` → `schema.prisma:L6980`
- `Aggregator` → `schema.prisma:L14770`
- `AngelPayUserAccount` → `schema.prisma:L5631`
- `AppUpdate` → `schema.prisma:L12935`
- `Area` → `schema.prisma:L3192`
- `AreaTicket` → `schema.prisma:L15268`
- `AreaTicketCheckoutSession` → `schema.prisma:L15390`
- `AreaTicketExternalIncident` → `schema.prisma:L15637`
- `AreaTicketExternalSettlement` → `schema.prisma:L15602`
- `AreaTicketFulfillment` → `schema.prisma:L15466`
- `AreaTicketInventoryReservation` → `schema.prisma:L15361`
- `AreaTicketLine` → `schema.prisma:L15329`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15422`
- `AreaTicketPrintAttempt` → `schema.prisma:L15445`
- `BankStatement` → `schema.prisma:L16247`
- `BankStatementLine` → `schema.prisma:L16268`
- `BillingTaxProfile` → `schema.prisma:L17057`
- `BirthdayAutomation` → `schema.prisma:L7301`
- `BulkCommandOperation` → `schema.prisma:L10215`
- `CalendarSyncOutbox` → `schema.prisma:L14142`
- `CampaignDelivery` → `schema.prisma:L13093`
- `CashCloseout` → `schema.prisma:L10600`
- `CashDeposit` → `schema.prisma:L12737`
- `CashDrawerEvent` → `schema.prisma:L14607`
- `CashDrawerSession` → `schema.prisma:L14568`
- `CashOutCommissionRate` → `schema.prisma:L16886`
- `CashOutScheduleDay` → `schema.prisma:L16909`
- `CashOutWithdrawal` → `schema.prisma:L16971`
- `CatalogBindingBatch` → `schema.prisma:L11631`
- `CatalogBindingLine` → `schema.prisma:L11667`
- `CatalogBrand` → `schema.prisma:L11084`
- `CatalogClientObservation` → `schema.prisma:L11397`
- `CatalogClientReadinessOverride` → `schema.prisma:L11416`
- `CatalogFamily` → `schema.prisma:L11134`
- `CatalogIdempotencyRecord` → `schema.prisma:L11530`
- `CatalogIdentifier` → `schema.prisma:L11265`
- `CatalogImportBatch` → `schema.prisma:L11573`
- `CatalogImportLine` → `schema.prisma:L11610`
- `CatalogItem` → `schema.prisma:L11167`
- `CatalogItemBusinessType` → `schema.prisma:L11227`
- `CatalogItemPrice` → `schema.prisma:L11315`
- `CatalogManufacturer` → `schema.prisma:L11108`
- `CatalogProductTypeMapping` → `schema.prisma:L11244`
- `CatalogPublicationBatch` → `schema.prisma:L11695`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11789`
- `CatalogPublicationLine` → `schema.prisma:L11736`
- `CatalogPublicationOutbox` → `schema.prisma:L11832`
- `CatalogValidationProfile` → `schema.prisma:L11286`
- `CatalogVenueBinding` → `schema.prisma:L11444`
- `CatalogVenueClientRequirement` → `schema.prisma:L11371`
- `CatalogVenueEventSequence` → `schema.prisma:L11815`
- `CatalogVenueOverride` → `schema.prisma:L11486`
- `CatalogVenueRollout` → `schema.prisma:L11346`
- `Cfdi` → `schema.prisma:L16150`
- `ChatbotTokenBudget` → `schema.prisma:L9863`
- `ChatConversation` → `schema.prisma:L9718`
- `ChatFeedback` → `schema.prisma:L9804`
- `ChatLearningEvent` → `schema.prisma:L9761`
- `ChatMessage` → `schema.prisma:L9741`
- `ChatTrainingData` → `schema.prisma:L9675`
- `CheckoutSession` → `schema.prisma:L5911`
- `ClassSession` → `schema.prisma:L13746`
- `CommissionCalculation` → `schema.prisma:L12513`
- `CommissionClawback` → `schema.prisma:L12689`
- `CommissionConfig` → `schema.prisma:L12279`
- `CommissionMilestone` → `schema.prisma:L12429`
- `CommissionOverride` → `schema.prisma:L12356`
- `CommissionPayout` → `schema.prisma:L12640`
- `CommissionSummary` → `schema.prisma:L12579`
- `CommissionTier` → `schema.prisma:L12393`
- `ConsentEvent` → `schema.prisma:L7163`
- `Consumer` → `schema.prisma:L7393`
- `ConsumerAuthAccount` → `schema.prisma:L7418`
- `CouponCode` → `schema.prisma:L8365`
- `CouponRedemption` → `schema.prisma:L8396`
- `CreditAssessmentHistory` → `schema.prisma:L10709`
- `CreditItemBalance` → `schema.prisma:L14358`
- `CreditOffer` → `schema.prisma:L10728`
- `CreditPack` → `schema.prisma:L14267`
- `CreditPackItem` → `schema.prisma:L14296`
- `CreditPackPurchase` → `schema.prisma:L14313`
- `CreditTransaction` → `schema.prisma:L14380`
- `Customer` → `schema.prisma:L7021`
- `CustomerApprovalDelivery` → `schema.prisma:L9377`
- `CustomerApprovalOutbox` → `schema.prisma:L9352`
- `CustomerCampaign` → `schema.prisma:L7251`
- `CustomerCampaignDelivery` → `schema.prisma:L7333`
- `CustomerCaptureToken` → `schema.prisma:L7199`
- `CustomerDiscount` → `schema.prisma:L8416`
- `CustomerGroup` → `schema.prisma:L7457`
- `CustomerOrderMetric` → `schema.prisma:L3963`
- `CustomerTaxProfile` → `schema.prisma:L16219`
- `DeliveryActivationRequest` → `schema.prisma:L6264`
- `DeliveryChannelLink` → `schema.prisma:L6209`
- `DeliveryOrderEvent` → `schema.prisma:L6288`
- `DeviceToken` → `schema.prisma:L8685`
- `DigitalReceipt` → `schema.prisma:L4541`
- `Discount` → `schema.prisma:L8055`
- `EcommerceMerchant` → `schema.prisma:L5723`
- `EmailQuotaLedger` → `schema.prisma:L7380`
- `EmailSuppression` → `schema.prisma:L7368`
- `EmailTemplate` → `schema.prisma:L13032`
- `Employee` → `schema.prisma:L16734`
- `Estimate` → `schema.prisma:L14677`
- `EstimateItem` → `schema.prisma:L14705`
- `Expense` → `schema.prisma:L16521`
- `ExternalBusyBlock` → `schema.prisma:L14035`
- `Feature` → `schema.prisma:L4670`
- `FeeSchedule` → `schema.prisma:L4755`
- `FeeTier` → `schema.prisma:L4766`
- `FinancialAccount` → `schema.prisma:L14867`
- `FinancialConnection` → `schema.prisma:L14836`
- `FinancialProvider` → `schema.prisma:L14822`
- `FiscalEmisor` → `schema.prisma:L16073`
- `FiscalLossCarryforward` → `schema.prisma:L16644`
- `FixedAsset` → `schema.prisma:L16662`
- `FixedAssetDepreciation` → `schema.prisma:L16691`
- `FloorElement` → `schema.prisma:L3268`
- `FulfillmentArea` → `schema.prisma:L15133`
- `GeofenceRule` → `schema.prisma:L10300`
- `GoogleCalendarChannel` → `schema.prisma:L14012`
- `GoogleCalendarConnection` → `schema.prisma:L13964`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14065`
- `GoogleOAuthSession` → `schema.prisma:L14087`
- `HolidayCalendar` → `schema.prisma:L6904`
- `IdempotencyRequest` → `schema.prisma:L12154`
- `InterVenueTransfer` → `schema.prisma:L3020`
- `InterVenueTransferAllocation` → `schema.prisma:L3103`
- `InterVenueTransferItem` → `schema.prisma:L3072`
- `InterVenueTransferReceipt` → `schema.prisma:L3130`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3146`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3174`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3158`
- `Inventory` → `schema.prisma:L1974`
- `InventoryMovement` → `schema.prisma:L2072`
- `InventoryPosting` → `schema.prisma:L2162`
- `InventoryPostingLine` → `schema.prisma:L2202`
- `InventoryTransfer` → `schema.prisma:L14649`
- `InventoryWasteReport` → `schema.prisma:L2029`
- `Invitation` → `schema.prisma:L1479`
- `Invoice` → `schema.prisma:L4778`
- `InvoiceItem` → `schema.prisma:L4804`
- `ItemCategory` → `schema.prisma:L11867`
- `JournalEntry` → `schema.prisma:L16431`
- `JournalLine` → `schema.prisma:L16459`
- `KdsOrder` → `schema.prisma:L14915`
- `KdsOrderItem` → `schema.prisma:L14956`
- `KioskCheckInAttempt` → `schema.prisma:L17380`
- `KioskCheckInChallenge` → `schema.prisma:L17334`
- `KioskOutreachOutbox` → `schema.prisma:L17401`
- `LaunchCampaign` → `schema.prisma:L17739`
- `LaunchCampaignRedemption` → `schema.prisma:L17845`
- `LearnedPatterns` → `schema.prisma:L9785`
- `LedgerAccount` → `schema.prisma:L16323`
- `LiveDemoSession` → `schema.prisma:L823`
- `LowStockAlert` → `schema.prisma:L2854`
- `LoyaltyConfig` → `schema.prisma:L7487`
- `LoyaltyTransaction` → `schema.prisma:L7530`
- `MarketingCampaign` → `schema.prisma:L13050`
- `McpAuthCode` → `schema.prisma:L15956`
- `McpOAuthClient` → `schema.prisma:L15940`
- `McpRefreshToken` → `schema.prisma:L15974`
- `McpToolCall` → `schema.prisma:L15995`
- `MeasurementUnit` → `schema.prisma:L14755`
- `Menu` → `schema.prisma:L1697`
- `MenuCategory` → `schema.prisma:L1634`
- `MenuCategoryAssignment` → `schema.prisma:L1732`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15870`
- `MerchantAccount` → `schema.prisma:L5461`
- `MerchantFiscalConfig` → `schema.prisma:L16121`
- `MerchantRevenueShare` → `schema.prisma:L6484`
- `MerchantRoutingRule` → `schema.prisma:L5583`
- `MilestoneAchievement` → `schema.prisma:L12474`
- `Modifier` → `schema.prisma:L4147`
- `ModifierGroup` → `schema.prisma:L4111`
- `Module` → `schema.prisma:L10776`
- `MoneyAnomaly` → `schema.prisma:L6387`
- `MonthlyVenueProfit` → `schema.prisma:L6930`
- `Notification` → `schema.prisma:L8587`
- `NotificationPreference` → `schema.prisma:L8634`
- `NotificationTemplate` → `schema.prisma:L8661`
- `OAuthState` → `schema.prisma:L1530`
- `OnboardingProgress` → `schema.prisma:L1548`
- `Order` → `schema.prisma:L3717`
- `OrderAction` → `schema.prisma:L4214`
- `OrderCustomer` → `schema.prisma:L3942`
- `OrderDiscount` → `schema.prisma:L8448`
- `OrderFulfillment` → `schema.prisma:L15188`
- `OrderFulfillmentLine` → `schema.prisma:L15219`
- `OrderItem` → `schema.prisma:L3978`
- `OrderItemModifier` → `schema.prisma:L4196`
- `OrderPromotion` → `schema.prisma:L17297`
- `OrderServiceCharge` → `schema.prisma:L8532`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12851`
- `OrganizationEntitlement` → `schema.prisma:L11059`
- `OrganizationGoal` → `schema.prisma:L12809`
- `OrganizationModule` → `schema.prisma:L10836`
- `OrganizationPaymentConfig` → `schema.prisma:L6035`
- `OrganizationPayoutConfig` → `schema.prisma:L12884`
- `OrganizationPricingStructure` → `schema.prisma:L6067`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12832`
- `OtpChallenge` → `schema.prisma:L7437`
- `OvertimeApproval` → `schema.prisma:L3495`
- `PartnerAPIKey` → `schema.prisma:L5865`
- `Payment` → `schema.prisma:L4247`
- `PaymentAllocation` → `schema.prisma:L4520`
- `PaymentEffect` → `schema.prisma:L17671`
- `PaymentLink` → `schema.prisma:L14426`
- `PaymentLinkAttribution` → `schema.prisma:L14534`
- `PaymentLinkItem` → `schema.prisma:L14489`
- `PaymentLinkItemModifier` → `schema.prisma:L14516`
- `PaymentProvider` → `schema.prisma:L5420`
- `PayrollLine` → `schema.prisma:L16805`
- `PayrollRun` → `schema.prisma:L16774`
- `PerformanceGoal` → `schema.prisma:L12786`
- `PermissionOverride` → `schema.prisma:L1403`
- `PermissionSet` → `schema.prisma:L1426`
- `PlatformAnnouncement` → `schema.prisma:L17461`
- `PlatformAnnouncementClick` → `schema.prisma:L17526`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17563`
- `PlatformCfdi` → `schema.prisma:L17090`
- `PlatformEmisor` → `schema.prisma:L17030`
- `PlatformSettings` → `schema.prisma:L5842`
- `PosCommand` → `schema.prisma:L8715`
- `PosConnectionStatus` → `schema.prisma:L949`
- `PosSyncIntent` → `schema.prisma:L17168`
- `PricingPolicy` → `schema.prisma:L2753`
- `Printer` → `schema.prisma:L14998`
- `PrintGateway` → `schema.prisma:L15055`
- `PrintJob` → `schema.prisma:L15769`
- `PrintStation` → `schema.prisma:L15073`
- `PrivacyNoticeVersion` → `schema.prisma:L7185`
- `ProcessedStripeEvent` → `schema.prisma:L6373`
- `ProcessorReliabilityMetric` → `schema.prisma:L6858`
- `Product` → `schema.prisma:L1750`
- `ProductModifierGroup` → `schema.prisma:L4184`
- `ProductOption` → `schema.prisma:L14732`
- `ProductOptionValue` → `schema.prisma:L14743`
- `ProductStaff` → `schema.prisma:L13661`
- `PromoterBankAccount` → `schema.prisma:L16925`
- `PromoterCommissionEntry` → `schema.prisma:L16944`
- `PromoterLocationPing` → `schema.prisma:L3683`
- `Promotion` → `schema.prisma:L17219`
- `PromotionGroup` → `schema.prisma:L17258`
- `PromotionOption` → `schema.prisma:L17274`
- `ProviderCostStructure` → `schema.prisma:L6409`
- `ProviderEventLog` → `schema.prisma:L6144`
- `PurchaseOrder` → `schema.prisma:L2478`
- `PurchaseOrderInvoice` → `schema.prisma:L2623`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2680`
- `PurchaseOrderItem` → `schema.prisma:L2536`
- `RateCorrectionBatch` → `schema.prisma:L6634`
- `RateCorrectionEntry` → `schema.prisma:L6676`
- `RawMaterial` → `schema.prisma:L2234`
- `RawMaterialMovement` → `schema.prisma:L2806`
- `RawMaterialPresentation` → `schema.prisma:L2310`
- `ReceiptLayout` → `schema.prisma:L17705`
- `Recipe` → `schema.prisma:L2330`
- `RecipeLine` → `schema.prisma:L2354`
- `Referral` → `schema.prisma:L7903`
- `ReferralProgramConfig` → `schema.prisma:L7868`
- `ReferralRewardGrant` → `schema.prisma:L7994`
- `ReferralTierReward` → `schema.prisma:L7966`
- `ReferralTierUnlock` → `schema.prisma:L8039`
- `RefreshGrant` → `schema.prisma:L17650`
- `Reservation` → `schema.prisma:L13429`
- `ReservationGoogleEventMapping` → `schema.prisma:L14199`
- `ReservationModifier` → `schema.prisma:L13609`
- `ReservationReminderSent` → `schema.prisma:L13592`
- `ReservationSettings` → `schema.prisma:L13823`
- `ReservationWaitlistEntry` → `schema.prisma:L13791`
- `Review` → `schema.prisma:L4822`
- `SalesRetention` → `schema.prisma:L16625`
- `SaleVerification` → `schema.prisma:L4574`
- `ScaleProfile` → `schema.prisma:L15510`
- `ScheduledCommand` → `schema.prisma:L10260`
- `SerializedItem` → `schema.prisma:L11910`
- `SerializedItemCustodyEvent` → `schema.prisma:L12077`
- `ServiceCharge` → `schema.prisma:L8503`
- `Session` → `schema.prisma:L17629`
- `SettlementConfiguration` → `schema.prisma:L6709`
- `SettlementConfirmation` → `schema.prisma:L6822`
- `SettlementIncident` → `schema.prisma:L6773`
- `SettlementSimulation` → `schema.prisma:L6744`
- `Shift` → `schema.prisma:L3306`
- `SimRegistrationRequest` → `schema.prisma:L12115`
- `SimRegistrationRequestItem` → `schema.prisma:L12137`
- `SlotHold` → `schema.prisma:L13692`
- `Staff` → `schema.prisma:L969`
- `StaffDocument` → `schema.prisma:L3554`
- `StaffOnboardingState` → `schema.prisma:L15840`
- `StaffOrganization` → `schema.prisma:L1302`
- `StaffPasskey` → `schema.prisma:L1329`
- `StaffSchedule` → `schema.prisma:L13632`
- `StaffScheduleException` → `schema.prisma:L13644`
- `StaffVenue` → `schema.prisma:L1226`
- `StaffWorkSchedule` → `schema.prisma:L3431`
- `StaffWorkScheduleException` → `schema.prisma:L3529`
- `StampCard` → `schema.prisma:L7751`
- `StampEvent` → `schema.prisma:L7790`
- `StampReward` → `schema.prisma:L7828`
- `StockAlertConfig` → `schema.prisma:L12768`
- `StockBatch` → `schema.prisma:L2969`
- `StockCount` → `schema.prisma:L2886`
- `StockCountItem` → `schema.prisma:L2914`
- `StripeWebhookEvent` → `schema.prisma:L6356`
- `Supplier` → `schema.prisma:L2389`
- `SupplierItemCode` → `schema.prisma:L2721`
- `SupplierPricing` → `schema.prisma:L2444`
- `Table` → `schema.prisma:L3218`
- `Terminal` → `schema.prisma:L4873`
- `TerminalHealth` → `schema.prisma:L5124`
- `TerminalLog` → `schema.prisma:L5098`
- `TerminalOrder` → `schema.prisma:L5323`
- `TerminalOrderItem` → `schema.prisma:L5398`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5276`
- `TerminalPaymentRequest` → `schema.prisma:L5195`
- `TimeEntry` → `schema.prisma:L3596`
- `TimeEntryBreak` → `schema.prisma:L3665`
- `TokenPurchase` → `schema.prisma:L9934`
- `TokenUsageRecord` → `schema.prisma:L9906`
- `TpvCommandHistory` → `schema.prisma:L10166`
- `TpvCommandQueue` → `schema.prisma:L10106`
- `TpvFeedback` → `schema.prisma:L9819`
- `TpvMessage` → `schema.prisma:L13125`
- `TpvMessageDelivery` → `schema.prisma:L13177`
- `TpvMessageResponse` → `schema.prisma:L13200`
- `TrainingModule` → `schema.prisma:L13255`
- `TrainingProgress` → `schema.prisma:L13332`
- `TrainingQuizQuestion` → `schema.prisma:L13314`
- `TrainingStep` → `schema.prisma:L13294`
- `TransactionCost` → `schema.prisma:L6572`
- `UnitConversion` → `schema.prisma:L2784`
- `UpsellAcceptance` → `schema.prisma:L8324`
- `UpsellAiRun` → `schema.prisma:L8344`
- `UpsellImpression` → `schema.prisma:L8284`
- `UpsellRule` → `schema.prisma:L8204`
- `user_sessions` → `schema.prisma:L5900`
- `Venue` → `schema.prisma:L163`
- `VenueAreaTicketSettings` → `schema.prisma:L15247`
- `VenueChatMessage` → `schema.prisma:L799`
- `VenueChatSession` → `schema.prisma:L754`
- `VenueCommission` → `schema.prisma:L14893`
- `VenueCreditAssessment` → `schema.prisma:L10648`
- `VenueCryptoConfig` → `schema.prisma:L12992`
- `VenueFeature` → `schema.prisma:L4688`
- `VenueModule` → `schema.prisma:L10808`
- `VenuePaymentConfig` → `schema.prisma:L6001`
- `VenuePaymentLinkSettings` → `schema.prisma:L14232`
- `VenuePricingStructure` → `schema.prisma:L6512`
- `VenueRoleConfig` → `schema.prisma:L1455`
- `VenueRolePermission` → `schema.prisma:L1359`
- `VenueScaleSettings` → `schema.prisma:L15498`
- `VenueSettings` → `schema.prisma:L839`
- `VenueTenderType` → `schema.prisma:L4433`
- `VenueTenderTypeRevision` → `schema.prisma:L4498`
- `VenueTransaction` → `schema.prisma:L4625`
- `VenueWhatsappActivation` → `schema.prisma:L690`
- `WalletCardDesign` → `schema.prisma:L7669`
- `WalletPass` → `schema.prisma:L7570`
- `WalletPassRegistration` → `schema.prisma:L7636`
- `WebhookEvent` → `schema.prisma:L4731`
- `WebhookSubscription` → `schema.prisma:L6117`
- `WhatsappContactWindow` → `schema.prisma:L708`
- `WhatsappInboundEvent` → `schema.prisma:L728`
- `WorkShiftAssignment` → `schema.prisma:L3471`
- `WorkShiftTemplate` → `schema.prisma:L3448`
- `Zone` → `schema.prisma:L146`
