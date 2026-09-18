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

- `AccountingPeriodLock` → `schema.prisma:L16335`
- `AccountMapping` → `schema.prisma:L16231`
- `ActivityLog` → `schema.prisma:L6838`
- `Aggregator` → `schema.prisma:L14628`
- `AngelPayUserAccount` → `schema.prisma:L5489`
- `AppUpdate` → `schema.prisma:L12793`
- `Area` → `schema.prisma:L3064`
- `AreaTicket` → `schema.prisma:L15126`
- `AreaTicketCheckoutSession` → `schema.prisma:L15248`
- `AreaTicketExternalIncident` → `schema.prisma:L15495`
- `AreaTicketExternalSettlement` → `schema.prisma:L15460`
- `AreaTicketFulfillment` → `schema.prisma:L15324`
- `AreaTicketInventoryReservation` → `schema.prisma:L15219`
- `AreaTicketLine` → `schema.prisma:L15187`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15280`
- `AreaTicketPrintAttempt` → `schema.prisma:L15303`
- `BankStatement` → `schema.prisma:L16105`
- `BankStatementLine` → `schema.prisma:L16126`
- `BillingTaxProfile` → `schema.prisma:L16915`
- `BirthdayAutomation` → `schema.prisma:L7159`
- `BulkCommandOperation` → `schema.prisma:L10073`
- `CalendarSyncOutbox` → `schema.prisma:L14000`
- `CampaignDelivery` → `schema.prisma:L12951`
- `CashCloseout` → `schema.prisma:L10458`
- `CashDeposit` → `schema.prisma:L12595`
- `CashDrawerEvent` → `schema.prisma:L14465`
- `CashDrawerSession` → `schema.prisma:L14426`
- `CashOutCommissionRate` → `schema.prisma:L16744`
- `CashOutScheduleDay` → `schema.prisma:L16767`
- `CashOutWithdrawal` → `schema.prisma:L16829`
- `CatalogBindingBatch` → `schema.prisma:L11489`
- `CatalogBindingLine` → `schema.prisma:L11525`
- `CatalogBrand` → `schema.prisma:L10942`
- `CatalogClientObservation` → `schema.prisma:L11255`
- `CatalogClientReadinessOverride` → `schema.prisma:L11274`
- `CatalogFamily` → `schema.prisma:L10992`
- `CatalogIdempotencyRecord` → `schema.prisma:L11388`
- `CatalogIdentifier` → `schema.prisma:L11123`
- `CatalogImportBatch` → `schema.prisma:L11431`
- `CatalogImportLine` → `schema.prisma:L11468`
- `CatalogItem` → `schema.prisma:L11025`
- `CatalogItemBusinessType` → `schema.prisma:L11085`
- `CatalogItemPrice` → `schema.prisma:L11173`
- `CatalogManufacturer` → `schema.prisma:L10966`
- `CatalogProductTypeMapping` → `schema.prisma:L11102`
- `CatalogPublicationBatch` → `schema.prisma:L11553`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11647`
- `CatalogPublicationLine` → `schema.prisma:L11594`
- `CatalogPublicationOutbox` → `schema.prisma:L11690`
- `CatalogValidationProfile` → `schema.prisma:L11144`
- `CatalogVenueBinding` → `schema.prisma:L11302`
- `CatalogVenueClientRequirement` → `schema.prisma:L11229`
- `CatalogVenueEventSequence` → `schema.prisma:L11673`
- `CatalogVenueOverride` → `schema.prisma:L11344`
- `CatalogVenueRollout` → `schema.prisma:L11204`
- `Cfdi` → `schema.prisma:L16008`
- `ChatbotTokenBudget` → `schema.prisma:L9721`
- `ChatConversation` → `schema.prisma:L9576`
- `ChatFeedback` → `schema.prisma:L9662`
- `ChatLearningEvent` → `schema.prisma:L9619`
- `ChatMessage` → `schema.prisma:L9599`
- `ChatTrainingData` → `schema.prisma:L9533`
- `CheckoutSession` → `schema.prisma:L5769`
- `ClassSession` → `schema.prisma:L13604`
- `CommissionCalculation` → `schema.prisma:L12371`
- `CommissionClawback` → `schema.prisma:L12547`
- `CommissionConfig` → `schema.prisma:L12137`
- `CommissionMilestone` → `schema.prisma:L12287`
- `CommissionOverride` → `schema.prisma:L12214`
- `CommissionPayout` → `schema.prisma:L12498`
- `CommissionSummary` → `schema.prisma:L12437`
- `CommissionTier` → `schema.prisma:L12251`
- `ConsentEvent` → `schema.prisma:L7021`
- `Consumer` → `schema.prisma:L7251`
- `ConsumerAuthAccount` → `schema.prisma:L7276`
- `CouponCode` → `schema.prisma:L8223`
- `CouponRedemption` → `schema.prisma:L8254`
- `CreditAssessmentHistory` → `schema.prisma:L10567`
- `CreditItemBalance` → `schema.prisma:L14216`
- `CreditOffer` → `schema.prisma:L10586`
- `CreditPack` → `schema.prisma:L14125`
- `CreditPackItem` → `schema.prisma:L14154`
- `CreditPackPurchase` → `schema.prisma:L14171`
- `CreditTransaction` → `schema.prisma:L14238`
- `Customer` → `schema.prisma:L6879`
- `CustomerApprovalDelivery` → `schema.prisma:L9235`
- `CustomerApprovalOutbox` → `schema.prisma:L9210`
- `CustomerCampaign` → `schema.prisma:L7109`
- `CustomerCampaignDelivery` → `schema.prisma:L7191`
- `CustomerCaptureToken` → `schema.prisma:L7057`
- `CustomerDiscount` → `schema.prisma:L8274`
- `CustomerGroup` → `schema.prisma:L7315`
- `CustomerOrderMetric` → `schema.prisma:L3835`
- `CustomerTaxProfile` → `schema.prisma:L16077`
- `DeliveryActivationRequest` → `schema.prisma:L6122`
- `DeliveryChannelLink` → `schema.prisma:L6067`
- `DeliveryOrderEvent` → `schema.prisma:L6146`
- `DeviceToken` → `schema.prisma:L8543`
- `DigitalReceipt` → `schema.prisma:L4413`
- `Discount` → `schema.prisma:L7913`
- `EcommerceMerchant` → `schema.prisma:L5581`
- `EmailQuotaLedger` → `schema.prisma:L7238`
- `EmailSuppression` → `schema.prisma:L7226`
- `EmailTemplate` → `schema.prisma:L12890`
- `Employee` → `schema.prisma:L16592`
- `Estimate` → `schema.prisma:L14535`
- `EstimateItem` → `schema.prisma:L14563`
- `Expense` → `schema.prisma:L16379`
- `ExternalBusyBlock` → `schema.prisma:L13893`
- `Feature` → `schema.prisma:L4542`
- `FeeSchedule` → `schema.prisma:L4620`
- `FeeTier` → `schema.prisma:L4631`
- `FinancialAccount` → `schema.prisma:L14725`
- `FinancialConnection` → `schema.prisma:L14694`
- `FinancialProvider` → `schema.prisma:L14680`
- `FiscalEmisor` → `schema.prisma:L15931`
- `FiscalLossCarryforward` → `schema.prisma:L16502`
- `FixedAsset` → `schema.prisma:L16520`
- `FixedAssetDepreciation` → `schema.prisma:L16549`
- `FloorElement` → `schema.prisma:L3140`
- `FulfillmentArea` → `schema.prisma:L14991`
- `GeofenceRule` → `schema.prisma:L10158`
- `GoogleCalendarChannel` → `schema.prisma:L13870`
- `GoogleCalendarConnection` → `schema.prisma:L13822`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13923`
- `GoogleOAuthSession` → `schema.prisma:L13945`
- `HolidayCalendar` → `schema.prisma:L6762`
- `IdempotencyRequest` → `schema.prisma:L12012`
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
- `InventoryTransfer` → `schema.prisma:L14507`
- `Invitation` → `schema.prisma:L1469`
- `Invoice` → `schema.prisma:L4643`
- `InvoiceItem` → `schema.prisma:L4669`
- `ItemCategory` → `schema.prisma:L11725`
- `JournalEntry` → `schema.prisma:L16289`
- `JournalLine` → `schema.prisma:L16317`
- `KdsOrder` → `schema.prisma:L14773`
- `KdsOrderItem` → `schema.prisma:L14814`
- `KioskCheckInAttempt` → `schema.prisma:L17238`
- `KioskCheckInChallenge` → `schema.prisma:L17192`
- `KioskOutreachOutbox` → `schema.prisma:L17259`
- `LearnedPatterns` → `schema.prisma:L9643`
- `LedgerAccount` → `schema.prisma:L16181`
- `LiveDemoSession` → `schema.prisma:L814`
- `LowStockAlert` → `schema.prisma:L2726`
- `LoyaltyConfig` → `schema.prisma:L7345`
- `LoyaltyTransaction` → `schema.prisma:L7388`
- `MarketingCampaign` → `schema.prisma:L12908`
- `McpAuthCode` → `schema.prisma:L15814`
- `McpOAuthClient` → `schema.prisma:L15798`
- `McpRefreshToken` → `schema.prisma:L15832`
- `McpToolCall` → `schema.prisma:L15853`
- `MeasurementUnit` → `schema.prisma:L14613`
- `Menu` → `schema.prisma:L1655`
- `MenuCategory` → `schema.prisma:L1592`
- `MenuCategoryAssignment` → `schema.prisma:L1690`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15728`
- `MerchantAccount` → `schema.prisma:L5319`
- `MerchantFiscalConfig` → `schema.prisma:L15979`
- `MerchantRevenueShare` → `schema.prisma:L6342`
- `MerchantRoutingRule` → `schema.prisma:L5441`
- `MilestoneAchievement` → `schema.prisma:L12332`
- `Modifier` → `schema.prisma:L4019`
- `ModifierGroup` → `schema.prisma:L3983`
- `Module` → `schema.prisma:L10634`
- `MoneyAnomaly` → `schema.prisma:L6245`
- `MonthlyVenueProfit` → `schema.prisma:L6788`
- `Notification` → `schema.prisma:L8445`
- `NotificationPreference` → `schema.prisma:L8492`
- `NotificationTemplate` → `schema.prisma:L8519`
- `OAuthState` → `schema.prisma:L1520`
- `OnboardingProgress` → `schema.prisma:L1538`
- `Order` → `schema.prisma:L3589`
- `OrderAction` → `schema.prisma:L4086`
- `OrderCustomer` → `schema.prisma:L3814`
- `OrderDiscount` → `schema.prisma:L8306`
- `OrderFulfillment` → `schema.prisma:L15046`
- `OrderFulfillmentLine` → `schema.prisma:L15077`
- `OrderItem` → `schema.prisma:L3850`
- `OrderItemModifier` → `schema.prisma:L4068`
- `OrderPromotion` → `schema.prisma:L17155`
- `OrderServiceCharge` → `schema.prisma:L8390`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12709`
- `OrganizationEntitlement` → `schema.prisma:L10917`
- `OrganizationGoal` → `schema.prisma:L12667`
- `OrganizationModule` → `schema.prisma:L10694`
- `OrganizationPaymentConfig` → `schema.prisma:L5893`
- `OrganizationPayoutConfig` → `schema.prisma:L12742`
- `OrganizationPricingStructure` → `schema.prisma:L5925`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12690`
- `OtpChallenge` → `schema.prisma:L7295`
- `OvertimeApproval` → `schema.prisma:L3367`
- `PartnerAPIKey` → `schema.prisma:L5723`
- `Payment` → `schema.prisma:L4119`
- `PaymentAllocation` → `schema.prisma:L4392`
- `PaymentEffect` → `schema.prisma:L17529`
- `PaymentLink` → `schema.prisma:L14284`
- `PaymentLinkAttribution` → `schema.prisma:L14392`
- `PaymentLinkItem` → `schema.prisma:L14347`
- `PaymentLinkItemModifier` → `schema.prisma:L14374`
- `PaymentProvider` → `schema.prisma:L5278`
- `PayrollLine` → `schema.prisma:L16663`
- `PayrollRun` → `schema.prisma:L16632`
- `PerformanceGoal` → `schema.prisma:L12644`
- `PermissionOverride` → `schema.prisma:L1393`
- `PermissionSet` → `schema.prisma:L1416`
- `PlatformAnnouncement` → `schema.prisma:L17319`
- `PlatformAnnouncementClick` → `schema.prisma:L17384`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17421`
- `PlatformCfdi` → `schema.prisma:L16948`
- `PlatformEmisor` → `schema.prisma:L16888`
- `PlatformSettings` → `schema.prisma:L5700`
- `PosCommand` → `schema.prisma:L8573`
- `PosConnectionStatus` → `schema.prisma:L940`
- `PosSyncIntent` → `schema.prisma:L17026`
- `PricingPolicy` → `schema.prisma:L2630`
- `Printer` → `schema.prisma:L14856`
- `PrintGateway` → `schema.prisma:L14913`
- `PrintJob` → `schema.prisma:L15627`
- `PrintStation` → `schema.prisma:L14931`
- `PrivacyNoticeVersion` → `schema.prisma:L7043`
- `ProcessedStripeEvent` → `schema.prisma:L6231`
- `ProcessorReliabilityMetric` → `schema.prisma:L6716`
- `Product` → `schema.prisma:L1708`
- `ProductModifierGroup` → `schema.prisma:L4056`
- `ProductOption` → `schema.prisma:L14590`
- `ProductOptionValue` → `schema.prisma:L14601`
- `ProductStaff` → `schema.prisma:L13519`
- `PromoterBankAccount` → `schema.prisma:L16783`
- `PromoterCommissionEntry` → `schema.prisma:L16802`
- `PromoterLocationPing` → `schema.prisma:L3555`
- `Promotion` → `schema.prisma:L17077`
- `PromotionGroup` → `schema.prisma:L17116`
- `PromotionOption` → `schema.prisma:L17132`
- `ProviderCostStructure` → `schema.prisma:L6267`
- `ProviderEventLog` → `schema.prisma:L6002`
- `PurchaseOrder` → `schema.prisma:L2355`
- `PurchaseOrderInvoice` → `schema.prisma:L2500`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2557`
- `PurchaseOrderItem` → `schema.prisma:L2413`
- `RateCorrectionBatch` → `schema.prisma:L6492`
- `RateCorrectionEntry` → `schema.prisma:L6534`
- `RawMaterial` → `schema.prisma:L2112`
- `RawMaterialMovement` → `schema.prisma:L2683`
- `RawMaterialPresentation` → `schema.prisma:L2187`
- `ReceiptLayout` → `schema.prisma:L17563`
- `Recipe` → `schema.prisma:L2207`
- `RecipeLine` → `schema.prisma:L2231`
- `Referral` → `schema.prisma:L7761`
- `ReferralProgramConfig` → `schema.prisma:L7726`
- `ReferralRewardGrant` → `schema.prisma:L7852`
- `ReferralTierReward` → `schema.prisma:L7824`
- `ReferralTierUnlock` → `schema.prisma:L7897`
- `RefreshGrant` → `schema.prisma:L17508`
- `Reservation` → `schema.prisma:L13287`
- `ReservationGoogleEventMapping` → `schema.prisma:L14057`
- `ReservationModifier` → `schema.prisma:L13467`
- `ReservationReminderSent` → `schema.prisma:L13450`
- `ReservationSettings` → `schema.prisma:L13681`
- `ReservationWaitlistEntry` → `schema.prisma:L13649`
- `Review` → `schema.prisma:L4687`
- `SalesRetention` → `schema.prisma:L16483`
- `SaleVerification` → `schema.prisma:L4446`
- `ScaleProfile` → `schema.prisma:L15368`
- `ScheduledCommand` → `schema.prisma:L10118`
- `SerializedItem` → `schema.prisma:L11768`
- `SerializedItemCustodyEvent` → `schema.prisma:L11935`
- `ServiceCharge` → `schema.prisma:L8361`
- `Session` → `schema.prisma:L17487`
- `SettlementConfiguration` → `schema.prisma:L6567`
- `SettlementConfirmation` → `schema.prisma:L6680`
- `SettlementIncident` → `schema.prisma:L6631`
- `SettlementSimulation` → `schema.prisma:L6602`
- `Shift` → `schema.prisma:L3178`
- `SimRegistrationRequest` → `schema.prisma:L11973`
- `SimRegistrationRequestItem` → `schema.prisma:L11995`
- `SlotHold` → `schema.prisma:L13550`
- `Staff` → `schema.prisma:L960`
- `StaffDocument` → `schema.prisma:L3426`
- `StaffOnboardingState` → `schema.prisma:L15698`
- `StaffOrganization` → `schema.prisma:L1292`
- `StaffPasskey` → `schema.prisma:L1319`
- `StaffSchedule` → `schema.prisma:L13490`
- `StaffScheduleException` → `schema.prisma:L13502`
- `StaffVenue` → `schema.prisma:L1216`
- `StaffWorkSchedule` → `schema.prisma:L3303`
- `StaffWorkScheduleException` → `schema.prisma:L3401`
- `StampCard` → `schema.prisma:L7609`
- `StampEvent` → `schema.prisma:L7648`
- `StampReward` → `schema.prisma:L7686`
- `StockAlertConfig` → `schema.prisma:L12626`
- `StockBatch` → `schema.prisma:L2841`
- `StockCount` → `schema.prisma:L2758`
- `StockCountItem` → `schema.prisma:L2786`
- `StripeWebhookEvent` → `schema.prisma:L6214`
- `Supplier` → `schema.prisma:L2266`
- `SupplierItemCode` → `schema.prisma:L2598`
- `SupplierPricing` → `schema.prisma:L2321`
- `Table` → `schema.prisma:L3090`
- `Terminal` → `schema.prisma:L4738`
- `TerminalHealth` → `schema.prisma:L4989`
- `TerminalLog` → `schema.prisma:L4963`
- `TerminalOrder` → `schema.prisma:L5181`
- `TerminalOrderItem` → `schema.prisma:L5256`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5134`
- `TerminalPaymentRequest` → `schema.prisma:L5060`
- `TimeEntry` → `schema.prisma:L3468`
- `TimeEntryBreak` → `schema.prisma:L3537`
- `TokenPurchase` → `schema.prisma:L9792`
- `TokenUsageRecord` → `schema.prisma:L9764`
- `TpvCommandHistory` → `schema.prisma:L10024`
- `TpvCommandQueue` → `schema.prisma:L9964`
- `TpvFeedback` → `schema.prisma:L9677`
- `TpvMessage` → `schema.prisma:L12983`
- `TpvMessageDelivery` → `schema.prisma:L13035`
- `TpvMessageResponse` → `schema.prisma:L13058`
- `TrainingModule` → `schema.prisma:L13113`
- `TrainingProgress` → `schema.prisma:L13190`
- `TrainingQuizQuestion` → `schema.prisma:L13172`
- `TrainingStep` → `schema.prisma:L13152`
- `TransactionCost` → `schema.prisma:L6430`
- `UnitConversion` → `schema.prisma:L2661`
- `UpsellAcceptance` → `schema.prisma:L8182`
- `UpsellAiRun` → `schema.prisma:L8202`
- `UpsellImpression` → `schema.prisma:L8142`
- `UpsellRule` → `schema.prisma:L8062`
- `user_sessions` → `schema.prisma:L5758`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L15105`
- `VenueChatMessage` → `schema.prisma:L790`
- `VenueChatSession` → `schema.prisma:L745`
- `VenueCommission` → `schema.prisma:L14751`
- `VenueCreditAssessment` → `schema.prisma:L10506`
- `VenueCryptoConfig` → `schema.prisma:L12850`
- `VenueFeature` → `schema.prisma:L4560`
- `VenueModule` → `schema.prisma:L10666`
- `VenuePaymentConfig` → `schema.prisma:L5859`
- `VenuePaymentLinkSettings` → `schema.prisma:L14090`
- `VenuePricingStructure` → `schema.prisma:L6370`
- `VenueRoleConfig` → `schema.prisma:L1445`
- `VenueRolePermission` → `schema.prisma:L1349`
- `VenueScaleSettings` → `schema.prisma:L15356`
- `VenueSettings` → `schema.prisma:L830`
- `VenueTenderType` → `schema.prisma:L4305`
- `VenueTenderTypeRevision` → `schema.prisma:L4370`
- `VenueTransaction` → `schema.prisma:L4497`
- `VenueWhatsappActivation` → `schema.prisma:L681`
- `WalletCardDesign` → `schema.prisma:L7527`
- `WalletPass` → `schema.prisma:L7428`
- `WalletPassRegistration` → `schema.prisma:L7494`
- `WebhookEvent` → `schema.prisma:L4596`
- `WebhookSubscription` → `schema.prisma:L5975`
- `WhatsappContactWindow` → `schema.prisma:L699`
- `WhatsappInboundEvent` → `schema.prisma:L719`
- `WorkShiftAssignment` → `schema.prisma:L3343`
- `WorkShiftTemplate` → `schema.prisma:L3320`
- `Zone` → `schema.prisma:L142`
