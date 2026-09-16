# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **368 models / 346 enums / ~17,500 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                         |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                             |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                                                       |
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

- `AccountingPeriodLock` → `schema.prisma:L16319`
- `AccountMapping` → `schema.prisma:L16215`
- `ActivityLog` → `schema.prisma:L6822`
- `Aggregator` → `schema.prisma:L14612`
- `AngelPayUserAccount` → `schema.prisma:L5473`
- `AppUpdate` → `schema.prisma:L12777`
- `Area` → `schema.prisma:L3064`
- `AreaTicket` → `schema.prisma:L15110`
- `AreaTicketCheckoutSession` → `schema.prisma:L15232`
- `AreaTicketExternalIncident` → `schema.prisma:L15479`
- `AreaTicketExternalSettlement` → `schema.prisma:L15444`
- `AreaTicketFulfillment` → `schema.prisma:L15308`
- `AreaTicketInventoryReservation` → `schema.prisma:L15203`
- `AreaTicketLine` → `schema.prisma:L15171`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15264`
- `AreaTicketPrintAttempt` → `schema.prisma:L15287`
- `BankStatement` → `schema.prisma:L16089`
- `BankStatementLine` → `schema.prisma:L16110`
- `BillingTaxProfile` → `schema.prisma:L16899`
- `BirthdayAutomation` → `schema.prisma:L7143`
- `BulkCommandOperation` → `schema.prisma:L10057`
- `CalendarSyncOutbox` → `schema.prisma:L13984`
- `CampaignDelivery` → `schema.prisma:L12935`
- `CashCloseout` → `schema.prisma:L10442`
- `CashDeposit` → `schema.prisma:L12579`
- `CashDrawerEvent` → `schema.prisma:L14449`
- `CashDrawerSession` → `schema.prisma:L14410`
- `CashOutCommissionRate` → `schema.prisma:L16728`
- `CashOutScheduleDay` → `schema.prisma:L16751`
- `CashOutWithdrawal` → `schema.prisma:L16813`
- `CatalogBindingBatch` → `schema.prisma:L11473`
- `CatalogBindingLine` → `schema.prisma:L11509`
- `CatalogBrand` → `schema.prisma:L10926`
- `CatalogClientObservation` → `schema.prisma:L11239`
- `CatalogClientReadinessOverride` → `schema.prisma:L11258`
- `CatalogFamily` → `schema.prisma:L10976`
- `CatalogIdempotencyRecord` → `schema.prisma:L11372`
- `CatalogIdentifier` → `schema.prisma:L11107`
- `CatalogImportBatch` → `schema.prisma:L11415`
- `CatalogImportLine` → `schema.prisma:L11452`
- `CatalogItem` → `schema.prisma:L11009`
- `CatalogItemBusinessType` → `schema.prisma:L11069`
- `CatalogItemPrice` → `schema.prisma:L11157`
- `CatalogManufacturer` → `schema.prisma:L10950`
- `CatalogProductTypeMapping` → `schema.prisma:L11086`
- `CatalogPublicationBatch` → `schema.prisma:L11537`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11631`
- `CatalogPublicationLine` → `schema.prisma:L11578`
- `CatalogPublicationOutbox` → `schema.prisma:L11674`
- `CatalogValidationProfile` → `schema.prisma:L11128`
- `CatalogVenueBinding` → `schema.prisma:L11286`
- `CatalogVenueClientRequirement` → `schema.prisma:L11213`
- `CatalogVenueEventSequence` → `schema.prisma:L11657`
- `CatalogVenueOverride` → `schema.prisma:L11328`
- `CatalogVenueRollout` → `schema.prisma:L11188`
- `Cfdi` → `schema.prisma:L15992`
- `ChatbotTokenBudget` → `schema.prisma:L9705`
- `ChatConversation` → `schema.prisma:L9560`
- `ChatFeedback` → `schema.prisma:L9646`
- `ChatLearningEvent` → `schema.prisma:L9603`
- `ChatMessage` → `schema.prisma:L9583`
- `ChatTrainingData` → `schema.prisma:L9517`
- `CheckoutSession` → `schema.prisma:L5753`
- `ClassSession` → `schema.prisma:L13588`
- `CommissionCalculation` → `schema.prisma:L12355`
- `CommissionClawback` → `schema.prisma:L12531`
- `CommissionConfig` → `schema.prisma:L12121`
- `CommissionMilestone` → `schema.prisma:L12271`
- `CommissionOverride` → `schema.prisma:L12198`
- `CommissionPayout` → `schema.prisma:L12482`
- `CommissionSummary` → `schema.prisma:L12421`
- `CommissionTier` → `schema.prisma:L12235`
- `ConsentEvent` → `schema.prisma:L7005`
- `Consumer` → `schema.prisma:L7235`
- `ConsumerAuthAccount` → `schema.prisma:L7260`
- `CouponCode` → `schema.prisma:L8207`
- `CouponRedemption` → `schema.prisma:L8238`
- `CreditAssessmentHistory` → `schema.prisma:L10551`
- `CreditItemBalance` → `schema.prisma:L14200`
- `CreditOffer` → `schema.prisma:L10570`
- `CreditPack` → `schema.prisma:L14109`
- `CreditPackItem` → `schema.prisma:L14138`
- `CreditPackPurchase` → `schema.prisma:L14155`
- `CreditTransaction` → `schema.prisma:L14222`
- `Customer` → `schema.prisma:L6863`
- `CustomerApprovalDelivery` → `schema.prisma:L9219`
- `CustomerApprovalOutbox` → `schema.prisma:L9194`
- `CustomerCampaign` → `schema.prisma:L7093`
- `CustomerCampaignDelivery` → `schema.prisma:L7175`
- `CustomerCaptureToken` → `schema.prisma:L7041`
- `CustomerDiscount` → `schema.prisma:L8258`
- `CustomerGroup` → `schema.prisma:L7299`
- `CustomerOrderMetric` → `schema.prisma:L3835`
- `CustomerTaxProfile` → `schema.prisma:L16061`
- `DeliveryActivationRequest` → `schema.prisma:L6106`
- `DeliveryChannelLink` → `schema.prisma:L6051`
- `DeliveryOrderEvent` → `schema.prisma:L6130`
- `DeviceToken` → `schema.prisma:L8527`
- `DigitalReceipt` → `schema.prisma:L4413`
- `Discount` → `schema.prisma:L7897`
- `EcommerceMerchant` → `schema.prisma:L5565`
- `EmailQuotaLedger` → `schema.prisma:L7222`
- `EmailSuppression` → `schema.prisma:L7210`
- `EmailTemplate` → `schema.prisma:L12874`
- `Employee` → `schema.prisma:L16576`
- `Estimate` → `schema.prisma:L14519`
- `EstimateItem` → `schema.prisma:L14547`
- `Expense` → `schema.prisma:L16363`
- `ExternalBusyBlock` → `schema.prisma:L13877`
- `Feature` → `schema.prisma:L4542`
- `FeeSchedule` → `schema.prisma:L4620`
- `FeeTier` → `schema.prisma:L4631`
- `FinancialAccount` → `schema.prisma:L14709`
- `FinancialConnection` → `schema.prisma:L14678`
- `FinancialProvider` → `schema.prisma:L14664`
- `FiscalEmisor` → `schema.prisma:L15915`
- `FiscalLossCarryforward` → `schema.prisma:L16486`
- `FixedAsset` → `schema.prisma:L16504`
- `FixedAssetDepreciation` → `schema.prisma:L16533`
- `FloorElement` → `schema.prisma:L3140`
- `FulfillmentArea` → `schema.prisma:L14975`
- `GeofenceRule` → `schema.prisma:L10142`
- `GoogleCalendarChannel` → `schema.prisma:L13854`
- `GoogleCalendarConnection` → `schema.prisma:L13806`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13907`
- `GoogleOAuthSession` → `schema.prisma:L13929`
- `HolidayCalendar` → `schema.prisma:L6746`
- `IdempotencyRequest` → `schema.prisma:L11996`
- `InterVenueTransfer` → `schema.prisma:L2892`
- `InterVenueTransferAllocation` → `schema.prisma:L2975`
- `InterVenueTransferItem` → `schema.prisma:L2944`
- `InterVenueTransferReceipt` → `schema.prisma:L3002`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3018`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3046`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3030`
- `Inventory` → `schema.prisma:L1931`
- `InventoryMovement` → `schema.prisma:L1958`
- `InventoryPosting` → `schema.prisma:L2040`
- `InventoryPostingLine` → `schema.prisma:L2080`
- `InventoryTransfer` → `schema.prisma:L14491`
- `Invitation` → `schema.prisma:L1469`
- `Invoice` → `schema.prisma:L4643`
- `InvoiceItem` → `schema.prisma:L4669`
- `ItemCategory` → `schema.prisma:L11709`
- `JournalEntry` → `schema.prisma:L16273`
- `JournalLine` → `schema.prisma:L16301`
- `KdsOrder` → `schema.prisma:L14757`
- `KdsOrderItem` → `schema.prisma:L14798`
- `KioskCheckInAttempt` → `schema.prisma:L17222`
- `KioskCheckInChallenge` → `schema.prisma:L17176`
- `KioskOutreachOutbox` → `schema.prisma:L17243`
- `LearnedPatterns` → `schema.prisma:L9627`
- `LedgerAccount` → `schema.prisma:L16165`
- `LiveDemoSession` → `schema.prisma:L814`
- `LowStockAlert` → `schema.prisma:L2726`
- `LoyaltyConfig` → `schema.prisma:L7329`
- `LoyaltyTransaction` → `schema.prisma:L7372`
- `MarketingCampaign` → `schema.prisma:L12892`
- `McpAuthCode` → `schema.prisma:L15798`
- `McpOAuthClient` → `schema.prisma:L15782`
- `McpRefreshToken` → `schema.prisma:L15816`
- `McpToolCall` → `schema.prisma:L15837`
- `MeasurementUnit` → `schema.prisma:L14597`
- `Menu` → `schema.prisma:L1655`
- `MenuCategory` → `schema.prisma:L1592`
- `MenuCategoryAssignment` → `schema.prisma:L1690`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15712`
- `MerchantAccount` → `schema.prisma:L5303`
- `MerchantFiscalConfig` → `schema.prisma:L15963`
- `MerchantRevenueShare` → `schema.prisma:L6326`
- `MerchantRoutingRule` → `schema.prisma:L5425`
- `MilestoneAchievement` → `schema.prisma:L12316`
- `Modifier` → `schema.prisma:L4019`
- `ModifierGroup` → `schema.prisma:L3983`
- `Module` → `schema.prisma:L10618`
- `MoneyAnomaly` → `schema.prisma:L6229`
- `MonthlyVenueProfit` → `schema.prisma:L6772`
- `Notification` → `schema.prisma:L8429`
- `NotificationPreference` → `schema.prisma:L8476`
- `NotificationTemplate` → `schema.prisma:L8503`
- `OAuthState` → `schema.prisma:L1520`
- `OnboardingProgress` → `schema.prisma:L1538`
- `Order` → `schema.prisma:L3589`
- `OrderAction` → `schema.prisma:L4086`
- `OrderCustomer` → `schema.prisma:L3814`
- `OrderDiscount` → `schema.prisma:L8290`
- `OrderFulfillment` → `schema.prisma:L15030`
- `OrderFulfillmentLine` → `schema.prisma:L15061`
- `OrderItem` → `schema.prisma:L3850`
- `OrderItemModifier` → `schema.prisma:L4068`
- `OrderPromotion` → `schema.prisma:L17139`
- `OrderServiceCharge` → `schema.prisma:L8374`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12693`
- `OrganizationEntitlement` → `schema.prisma:L10901`
- `OrganizationGoal` → `schema.prisma:L12651`
- `OrganizationModule` → `schema.prisma:L10678`
- `OrganizationPaymentConfig` → `schema.prisma:L5877`
- `OrganizationPayoutConfig` → `schema.prisma:L12726`
- `OrganizationPricingStructure` → `schema.prisma:L5909`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12674`
- `OtpChallenge` → `schema.prisma:L7279`
- `OvertimeApproval` → `schema.prisma:L3367`
- `PartnerAPIKey` → `schema.prisma:L5707`
- `Payment` → `schema.prisma:L4119`
- `PaymentAllocation` → `schema.prisma:L4392`
- `PaymentEffect` → `schema.prisma:L17513`
- `PaymentLink` → `schema.prisma:L14268`
- `PaymentLinkAttribution` → `schema.prisma:L14376`
- `PaymentLinkItem` → `schema.prisma:L14331`
- `PaymentLinkItemModifier` → `schema.prisma:L14358`
- `PaymentProvider` → `schema.prisma:L5262`
- `PayrollLine` → `schema.prisma:L16647`
- `PayrollRun` → `schema.prisma:L16616`
- `PerformanceGoal` → `schema.prisma:L12628`
- `PermissionOverride` → `schema.prisma:L1393`
- `PermissionSet` → `schema.prisma:L1416`
- `PlatformAnnouncement` → `schema.prisma:L17303`
- `PlatformAnnouncementClick` → `schema.prisma:L17368`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17405`
- `PlatformCfdi` → `schema.prisma:L16932`
- `PlatformEmisor` → `schema.prisma:L16872`
- `PlatformSettings` → `schema.prisma:L5684`
- `PosCommand` → `schema.prisma:L8557`
- `PosConnectionStatus` → `schema.prisma:L940`
- `PosSyncIntent` → `schema.prisma:L17010`
- `PricingPolicy` → `schema.prisma:L2630`
- `Printer` → `schema.prisma:L14840`
- `PrintGateway` → `schema.prisma:L14897`
- `PrintJob` → `schema.prisma:L15611`
- `PrintStation` → `schema.prisma:L14915`
- `PrivacyNoticeVersion` → `schema.prisma:L7027`
- `ProcessedStripeEvent` → `schema.prisma:L6215`
- `ProcessorReliabilityMetric` → `schema.prisma:L6700`
- `Product` → `schema.prisma:L1708`
- `ProductModifierGroup` → `schema.prisma:L4056`
- `ProductOption` → `schema.prisma:L14574`
- `ProductOptionValue` → `schema.prisma:L14585`
- `ProductStaff` → `schema.prisma:L13503`
- `PromoterBankAccount` → `schema.prisma:L16767`
- `PromoterCommissionEntry` → `schema.prisma:L16786`
- `PromoterLocationPing` → `schema.prisma:L3555`
- `Promotion` → `schema.prisma:L17061`
- `PromotionGroup` → `schema.prisma:L17100`
- `PromotionOption` → `schema.prisma:L17116`
- `ProviderCostStructure` → `schema.prisma:L6251`
- `ProviderEventLog` → `schema.prisma:L5986`
- `PurchaseOrder` → `schema.prisma:L2355`
- `PurchaseOrderInvoice` → `schema.prisma:L2500`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2557`
- `PurchaseOrderItem` → `schema.prisma:L2413`
- `RateCorrectionBatch` → `schema.prisma:L6476`
- `RateCorrectionEntry` → `schema.prisma:L6518`
- `RawMaterial` → `schema.prisma:L2112`
- `RawMaterialMovement` → `schema.prisma:L2683`
- `RawMaterialPresentation` → `schema.prisma:L2187`
- `ReceiptLayout` → `schema.prisma:L17547`
- `Recipe` → `schema.prisma:L2207`
- `RecipeLine` → `schema.prisma:L2231`
- `Referral` → `schema.prisma:L7745`
- `ReferralProgramConfig` → `schema.prisma:L7710`
- `ReferralRewardGrant` → `schema.prisma:L7836`
- `ReferralTierReward` → `schema.prisma:L7808`
- `ReferralTierUnlock` → `schema.prisma:L7881`
- `RefreshGrant` → `schema.prisma:L17492`
- `Reservation` → `schema.prisma:L13271`
- `ReservationGoogleEventMapping` → `schema.prisma:L14041`
- `ReservationModifier` → `schema.prisma:L13451`
- `ReservationReminderSent` → `schema.prisma:L13434`
- `ReservationSettings` → `schema.prisma:L13665`
- `ReservationWaitlistEntry` → `schema.prisma:L13633`
- `Review` → `schema.prisma:L4687`
- `SalesRetention` → `schema.prisma:L16467`
- `SaleVerification` → `schema.prisma:L4446`
- `ScaleProfile` → `schema.prisma:L15352`
- `ScheduledCommand` → `schema.prisma:L10102`
- `SerializedItem` → `schema.prisma:L11752`
- `SerializedItemCustodyEvent` → `schema.prisma:L11919`
- `ServiceCharge` → `schema.prisma:L8345`
- `Session` → `schema.prisma:L17471`
- `SettlementConfiguration` → `schema.prisma:L6551`
- `SettlementConfirmation` → `schema.prisma:L6664`
- `SettlementIncident` → `schema.prisma:L6615`
- `SettlementSimulation` → `schema.prisma:L6586`
- `Shift` → `schema.prisma:L3178`
- `SimRegistrationRequest` → `schema.prisma:L11957`
- `SimRegistrationRequestItem` → `schema.prisma:L11979`
- `SlotHold` → `schema.prisma:L13534`
- `Staff` → `schema.prisma:L960`
- `StaffDocument` → `schema.prisma:L3426`
- `StaffOnboardingState` → `schema.prisma:L15682`
- `StaffOrganization` → `schema.prisma:L1292`
- `StaffPasskey` → `schema.prisma:L1319`
- `StaffSchedule` → `schema.prisma:L13474`
- `StaffScheduleException` → `schema.prisma:L13486`
- `StaffVenue` → `schema.prisma:L1216`
- `StaffWorkSchedule` → `schema.prisma:L3303`
- `StaffWorkScheduleException` → `schema.prisma:L3401`
- `StampCard` → `schema.prisma:L7593`
- `StampEvent` → `schema.prisma:L7632`
- `StampReward` → `schema.prisma:L7670`
- `StockAlertConfig` → `schema.prisma:L12610`
- `StockBatch` → `schema.prisma:L2841`
- `StockCount` → `schema.prisma:L2758`
- `StockCountItem` → `schema.prisma:L2786`
- `StripeWebhookEvent` → `schema.prisma:L6198`
- `Supplier` → `schema.prisma:L2266`
- `SupplierItemCode` → `schema.prisma:L2598`
- `SupplierPricing` → `schema.prisma:L2321`
- `Table` → `schema.prisma:L3090`
- `Terminal` → `schema.prisma:L4738`
- `TerminalHealth` → `schema.prisma:L4989`
- `TerminalLog` → `schema.prisma:L4963`
- `TerminalOrder` → `schema.prisma:L5165`
- `TerminalOrderItem` → `schema.prisma:L5240`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5122`
- `TerminalPaymentRequest` → `schema.prisma:L5060`
- `TimeEntry` → `schema.prisma:L3468`
- `TimeEntryBreak` → `schema.prisma:L3537`
- `TokenPurchase` → `schema.prisma:L9776`
- `TokenUsageRecord` → `schema.prisma:L9748`
- `TpvCommandHistory` → `schema.prisma:L10008`
- `TpvCommandQueue` → `schema.prisma:L9948`
- `TpvFeedback` → `schema.prisma:L9661`
- `TpvMessage` → `schema.prisma:L12967`
- `TpvMessageDelivery` → `schema.prisma:L13019`
- `TpvMessageResponse` → `schema.prisma:L13042`
- `TrainingModule` → `schema.prisma:L13097`
- `TrainingProgress` → `schema.prisma:L13174`
- `TrainingQuizQuestion` → `schema.prisma:L13156`
- `TrainingStep` → `schema.prisma:L13136`
- `TransactionCost` → `schema.prisma:L6414`
- `UnitConversion` → `schema.prisma:L2661`
- `UpsellAcceptance` → `schema.prisma:L8166`
- `UpsellAiRun` → `schema.prisma:L8186`
- `UpsellImpression` → `schema.prisma:L8126`
- `UpsellRule` → `schema.prisma:L8046`
- `user_sessions` → `schema.prisma:L5742`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L15089`
- `VenueChatMessage` → `schema.prisma:L790`
- `VenueChatSession` → `schema.prisma:L745`
- `VenueCommission` → `schema.prisma:L14735`
- `VenueCreditAssessment` → `schema.prisma:L10490`
- `VenueCryptoConfig` → `schema.prisma:L12834`
- `VenueFeature` → `schema.prisma:L4560`
- `VenueModule` → `schema.prisma:L10650`
- `VenuePaymentConfig` → `schema.prisma:L5843`
- `VenuePaymentLinkSettings` → `schema.prisma:L14074`
- `VenuePricingStructure` → `schema.prisma:L6354`
- `VenueRoleConfig` → `schema.prisma:L1445`
- `VenueRolePermission` → `schema.prisma:L1349`
- `VenueScaleSettings` → `schema.prisma:L15340`
- `VenueSettings` → `schema.prisma:L830`
- `VenueTenderType` → `schema.prisma:L4305`
- `VenueTenderTypeRevision` → `schema.prisma:L4370`
- `VenueTransaction` → `schema.prisma:L4497`
- `VenueWhatsappActivation` → `schema.prisma:L681`
- `WalletCardDesign` → `schema.prisma:L7511`
- `WalletPass` → `schema.prisma:L7412`
- `WalletPassRegistration` → `schema.prisma:L7478`
- `WebhookEvent` → `schema.prisma:L4596`
- `WebhookSubscription` → `schema.prisma:L5959`
- `WhatsappContactWindow` → `schema.prisma:L699`
- `WhatsappInboundEvent` → `schema.prisma:L719`
- `WorkShiftAssignment` → `schema.prisma:L3343`
- `WorkShiftTemplate` → `schema.prisma:L3320`
- `Zone` → `schema.prisma:L142`
