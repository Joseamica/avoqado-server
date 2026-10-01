# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **390 models / 360 enums / ~18,500 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `CapabilityGrant`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `HybridBillingOperation`, `HybridCampaign`, `HybridContract`, `HybridContractSelection`, `HybridCreditAllocation`, `HybridOfferPublication`, `HybridPaymentPeriod`, `HybridPurchase`, `HybridRedemption`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                       |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                                                                                                       |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `InventoryWasteReport`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                                                                                                                                                         |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryConnectIntent`, `DeliveryLineAction`, `DeliveryOrderEvent`, `DeliveryStoreRevocation`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                                                                                                      |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CfdiGlobalOrden`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `OrderItemSelloIva`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                                                                                                |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                                                                                                           |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalAttemptResolution`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L17090`
- `AccountMapping` → `schema.prisma:L16985`
- `ActivityLog` → `schema.prisma:L7466`
- `Aggregator` → `schema.prisma:L15262`
- `AngelPayUserAccount` → `schema.prisma:L6011`
- `AppUpdate` → `schema.prisma:L13427`
- `Area` → `schema.prisma:L3241`
- `AreaTicket` → `schema.prisma:L15798`
- `AreaTicketCheckoutSession` → `schema.prisma:L15920`
- `AreaTicketExternalIncident` → `schema.prisma:L16167`
- `AreaTicketExternalSettlement` → `schema.prisma:L16132`
- `AreaTicketFulfillment` → `schema.prisma:L15996`
- `AreaTicketInventoryReservation` → `schema.prisma:L15891`
- `AreaTicketLine` → `schema.prisma:L15859`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15952`
- `AreaTicketPrintAttempt` → `schema.prisma:L15975`
- `BankStatement` → `schema.prisma:L16859`
- `BankStatementLine` → `schema.prisma:L16880`
- `BillingObligationConflict` → `schema.prisma:L5048`
- `BillingTaxProfile` → `schema.prisma:L17682`
- `BirthdayAutomation` → `schema.prisma:L7787`
- `BulkCommandOperation` → `schema.prisma:L10707`
- `CalendarSyncOutbox` → `schema.prisma:L14634`
- `CampaignDelivery` → `schema.prisma:L13585`
- `CapabilityGrant` → `schema.prisma:L4824`
- `CashCloseout` → `schema.prisma:L11092`
- `CashDeposit` → `schema.prisma:L13229`
- `CashDrawerEvent` → `schema.prisma:L15099`
- `CashDrawerSession` → `schema.prisma:L15060`
- `CashOutCommissionRate` → `schema.prisma:L17499`
- `CashOutScheduleDay` → `schema.prisma:L17522`
- `CashOutWithdrawal` → `schema.prisma:L17584`
- `CatalogBindingBatch` → `schema.prisma:L12123`
- `CatalogBindingLine` → `schema.prisma:L12159`
- `CatalogBrand` → `schema.prisma:L11576`
- `CatalogClientObservation` → `schema.prisma:L11889`
- `CatalogClientReadinessOverride` → `schema.prisma:L11908`
- `CatalogFamily` → `schema.prisma:L11626`
- `CatalogIdempotencyRecord` → `schema.prisma:L12022`
- `CatalogIdentifier` → `schema.prisma:L11757`
- `CatalogImportBatch` → `schema.prisma:L12065`
- `CatalogImportLine` → `schema.prisma:L12102`
- `CatalogItem` → `schema.prisma:L11659`
- `CatalogItemBusinessType` → `schema.prisma:L11719`
- `CatalogItemPrice` → `schema.prisma:L11807`
- `CatalogManufacturer` → `schema.prisma:L11600`
- `CatalogProductTypeMapping` → `schema.prisma:L11736`
- `CatalogPublicationBatch` → `schema.prisma:L12187`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12281`
- `CatalogPublicationLine` → `schema.prisma:L12228`
- `CatalogPublicationOutbox` → `schema.prisma:L12324`
- `CatalogValidationProfile` → `schema.prisma:L11778`
- `CatalogVenueBinding` → `schema.prisma:L11936`
- `CatalogVenueClientRequirement` → `schema.prisma:L11863`
- `CatalogVenueEventSequence` → `schema.prisma:L12307`
- `CatalogVenueOverride` → `schema.prisma:L11978`
- `CatalogVenueRollout` → `schema.prisma:L11838`
- `Cfdi` → `schema.prisma:L16687`
- `CfdiGlobalOrden` → `schema.prisma:L16812`
- `ChatbotTokenBudget` → `schema.prisma:L10355`
- `ChatConversation` → `schema.prisma:L10210`
- `ChatFeedback` → `schema.prisma:L10296`
- `ChatLearningEvent` → `schema.prisma:L10253`
- `ChatMessage` → `schema.prisma:L10233`
- `ChatTrainingData` → `schema.prisma:L10167`
- `CheckoutSession` → `schema.prisma:L6291`
- `ClassSession` → `schema.prisma:L14238`
- `CommissionCalculation` → `schema.prisma:L13005`
- `CommissionClawback` → `schema.prisma:L13181`
- `CommissionConfig` → `schema.prisma:L12771`
- `CommissionMilestone` → `schema.prisma:L12921`
- `CommissionOverride` → `schema.prisma:L12848`
- `CommissionPayout` → `schema.prisma:L13132`
- `CommissionSummary` → `schema.prisma:L13071`
- `CommissionTier` → `schema.prisma:L12885`
- `ConsentEvent` → `schema.prisma:L7649`
- `Consumer` → `schema.prisma:L7879`
- `ConsumerAuthAccount` → `schema.prisma:L7904`
- `CouponCode` → `schema.prisma:L8851`
- `CouponRedemption` → `schema.prisma:L8882`
- `CreditAssessmentHistory` → `schema.prisma:L11201`
- `CreditItemBalance` → `schema.prisma:L14850`
- `CreditOffer` → `schema.prisma:L11220`
- `CreditPack` → `schema.prisma:L14759`
- `CreditPackItem` → `schema.prisma:L14788`
- `CreditPackPurchase` → `schema.prisma:L14805`
- `CreditTransaction` → `schema.prisma:L14872`
- `Customer` → `schema.prisma:L7507`
- `CustomerApprovalDelivery` → `schema.prisma:L9869`
- `CustomerApprovalOutbox` → `schema.prisma:L9844`
- `CustomerCampaign` → `schema.prisma:L7737`
- `CustomerCampaignDelivery` → `schema.prisma:L7819`
- `CustomerCaptureToken` → `schema.prisma:L7685`
- `CustomerDiscount` → `schema.prisma:L8902`
- `CustomerGroup` → `schema.prisma:L7943`
- `CustomerOrderMetric` → `schema.prisma:L4040`
- `CustomerTaxProfile` → `schema.prisma:L16831`
- `DeliveryActivationRequest` → `schema.prisma:L6750`
- `DeliveryChannelLink` → `schema.prisma:L6589`
- `DeliveryConnectIntent` → `schema.prisma:L6701`
- `DeliveryLineAction` → `schema.prisma:L6662`
- `DeliveryOrderEvent` → `schema.prisma:L6774`
- `DeliveryStoreRevocation` → `schema.prisma:L6738`
- `DeviceToken` → `schema.prisma:L9171`
- `DigitalReceipt` → `schema.prisma:L4637`
- `Discount` → `schema.prisma:L8541`
- `EcommerceMerchant` → `schema.prisma:L6103`
- `EmailQuotaLedger` → `schema.prisma:L7866`
- `EmailSuppression` → `schema.prisma:L7854`
- `EmailTemplate` → `schema.prisma:L13524`
- `Employee` → `schema.prisma:L17347`
- `Estimate` → `schema.prisma:L15169`
- `EstimateItem` → `schema.prisma:L15197`
- `Expense` → `schema.prisma:L17134`
- `ExternalBusyBlock` → `schema.prisma:L14527`
- `Feature` → `schema.prisma:L4766`
- `FeeSchedule` → `schema.prisma:L5110`
- `FeeTier` → `schema.prisma:L5121`
- `FinancialAccount` → `schema.prisma:L15359`
- `FinancialConnection` → `schema.prisma:L15328`
- `FinancialProvider` → `schema.prisma:L15314`
- `FiscalEmisor` → `schema.prisma:L16603`
- `FiscalLossCarryforward` → `schema.prisma:L17257`
- `FixedAsset` → `schema.prisma:L17275`
- `FixedAssetDepreciation` → `schema.prisma:L17304`
- `FloorElement` → `schema.prisma:L3317`
- `FulfillmentArea` → `schema.prisma:L15663`
- `GeofenceRule` → `schema.prisma:L10792`
- `GoogleCalendarChannel` → `schema.prisma:L14504`
- `GoogleCalendarConnection` → `schema.prisma:L14456`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14557`
- `GoogleOAuthSession` → `schema.prisma:L14579`
- `HolidayCalendar` → `schema.prisma:L7390`
- `HybridBillingOperation` → `schema.prisma:L4972`
- `HybridCampaign` → `schema.prisma:L4849`
- `HybridContract` → `schema.prisma:L4929`
- `HybridContractSelection` → `schema.prisma:L4961`
- `HybridCreditAllocation` → `schema.prisma:L5028`
- `HybridOfferPublication` → `schema.prisma:L4876`
- `HybridPaymentPeriod` → `schema.prisma:L5007`
- `HybridPurchase` → `schema.prisma:L4896`
- `HybridRedemption` → `schema.prisma:L4990`
- `IdempotencyRequest` → `schema.prisma:L12646`
- `InterVenueTransfer` → `schema.prisma:L3069`
- `InterVenueTransferAllocation` → `schema.prisma:L3152`
- `InterVenueTransferItem` → `schema.prisma:L3121`
- `InterVenueTransferReceipt` → `schema.prisma:L3179`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3195`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3223`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3207`
- `Inventory` → `schema.prisma:L2013`
- `InventoryMovement` → `schema.prisma:L2113`
- `InventoryPosting` → `schema.prisma:L2208`
- `InventoryPostingLine` → `schema.prisma:L2248`
- `InventoryTransfer` → `schema.prisma:L15141`
- `InventoryWasteReport` → `schema.prisma:L2068`
- `Invitation` → `schema.prisma:L1510`
- `Invoice` → `schema.prisma:L5133`
- `InvoiceItem` → `schema.prisma:L5159`
- `ItemCategory` → `schema.prisma:L12359`
- `JournalEntry` → `schema.prisma:L17043`
- `JournalLine` → `schema.prisma:L17072`
- `KdsOrder` → `schema.prisma:L15407`
- `KdsOrderItem` → `schema.prisma:L15470`
- `KioskCheckInAttempt` → `schema.prisma:L18005`
- `KioskCheckInChallenge` → `schema.prisma:L17959`
- `KioskOutreachOutbox` → `schema.prisma:L18026`
- `LaunchCampaign` → `schema.prisma:L18364`
- `LaunchCampaignRedemption` → `schema.prisma:L18481`
- `LearnedPatterns` → `schema.prisma:L10277`
- `LedgerAccount` → `schema.prisma:L16935`
- `LiveDemoSession` → `schema.prisma:L836`
- `LowStockAlert` → `schema.prisma:L2903`
- `LoyaltyConfig` → `schema.prisma:L7973`
- `LoyaltyTransaction` → `schema.prisma:L8016`
- `MarketingCampaign` → `schema.prisma:L13542`
- `McpAuthCode` → `schema.prisma:L16486`
- `McpOAuthClient` → `schema.prisma:L16470`
- `McpRefreshToken` → `schema.prisma:L16504`
- `McpToolCall` → `schema.prisma:L16525`
- `MeasurementUnit` → `schema.prisma:L15247`
- `Menu` → `schema.prisma:L1728`
- `MenuCategory` → `schema.prisma:L1665`
- `MenuCategoryAssignment` → `schema.prisma:L1763`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16400`
- `MerchantAccount` → `schema.prisma:L5841`
- `MerchantFiscalConfig` → `schema.prisma:L16658`
- `MerchantRevenueShare` → `schema.prisma:L6970`
- `MerchantRoutingRule` → `schema.prisma:L5963`
- `MilestoneAchievement` → `schema.prisma:L12966`
- `Modifier` → `schema.prisma:L4239`
- `ModifierGroup` → `schema.prisma:L4203`
- `Module` → `schema.prisma:L11268`
- `MoneyAnomaly` → `schema.prisma:L6873`
- `MonthlyVenueProfit` → `schema.prisma:L7416`
- `Notification` → `schema.prisma:L9073`
- `NotificationPreference` → `schema.prisma:L9120`
- `NotificationTemplate` → `schema.prisma:L9147`
- `OAuthState` → `schema.prisma:L1561`
- `OnboardingProgress` → `schema.prisma:L1579`
- `Order` → `schema.prisma:L3766`
- `OrderAction` → `schema.prisma:L4310`
- `OrderCustomer` → `schema.prisma:L4019`
- `OrderDiscount` → `schema.prisma:L8934`
- `OrderFulfillment` → `schema.prisma:L15718`
- `OrderFulfillmentLine` → `schema.prisma:L15749`
- `OrderItem` → `schema.prisma:L4055`
- `OrderItemModifier` → `schema.prisma:L4292`
- `OrderItemSelloIva` → `schema.prisma:L16792`
- `OrderPromotion` → `schema.prisma:L17922`
- `OrderServiceCharge` → `schema.prisma:L9018`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13343`
- `OrganizationEntitlement` → `schema.prisma:L11551`
- `OrganizationGoal` → `schema.prisma:L13301`
- `OrganizationModule` → `schema.prisma:L11328`
- `OrganizationPaymentConfig` → `schema.prisma:L6415`
- `OrganizationPayoutConfig` → `schema.prisma:L13376`
- `OrganizationPricingStructure` → `schema.prisma:L6447`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13324`
- `OtpChallenge` → `schema.prisma:L7923`
- `OvertimeApproval` → `schema.prisma:L3544`
- `PartnerAPIKey` → `schema.prisma:L6245`
- `Payment` → `schema.prisma:L4343`
- `PaymentAllocation` → `schema.prisma:L4616`
- `PaymentEffect` → `schema.prisma:L18296`
- `PaymentLink` → `schema.prisma:L14918`
- `PaymentLinkAttribution` → `schema.prisma:L15026`
- `PaymentLinkItem` → `schema.prisma:L14981`
- `PaymentLinkItemModifier` → `schema.prisma:L15008`
- `PaymentProvider` → `schema.prisma:L5800`
- `PayrollLine` → `schema.prisma:L17418`
- `PayrollRun` → `schema.prisma:L17387`
- `PerformanceGoal` → `schema.prisma:L13278`
- `PermissionOverride` → `schema.prisma:L1434`
- `PermissionSet` → `schema.prisma:L1457`
- `PlatformAnnouncement` → `schema.prisma:L18086`
- `PlatformAnnouncementClick` → `schema.prisma:L18151`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18188`
- `PlatformCfdi` → `schema.prisma:L17715`
- `PlatformEmisor` → `schema.prisma:L17655`
- `PlatformSettings` → `schema.prisma:L6222`
- `PosCommand` → `schema.prisma:L9201`
- `PosConnectionStatus` → `schema.prisma:L980`
- `PosSyncIntent` → `schema.prisma:L17793`
- `PricingPolicy` → `schema.prisma:L2799`
- `Printer` → `schema.prisma:L15519`
- `PrintGateway` → `schema.prisma:L15576`
- `PrintJob` → `schema.prisma:L16299`
- `PrintStation` → `schema.prisma:L15594`
- `PrivacyNoticeVersion` → `schema.prisma:L7671`
- `ProcessedStripeEvent` → `schema.prisma:L6859`
- `ProcessorReliabilityMetric` → `schema.prisma:L7344`
- `Product` → `schema.prisma:L1781`
- `ProductModifierGroup` → `schema.prisma:L4280`
- `ProductOption` → `schema.prisma:L15224`
- `ProductOptionValue` → `schema.prisma:L15235`
- `ProductStaff` → `schema.prisma:L14153`
- `PromoterBankAccount` → `schema.prisma:L17538`
- `PromoterCommissionEntry` → `schema.prisma:L17557`
- `PromoterLocationPing` → `schema.prisma:L3732`
- `Promotion` → `schema.prisma:L17844`
- `PromotionGroup` → `schema.prisma:L17883`
- `PromotionOption` → `schema.prisma:L17899`
- `ProviderCostStructure` → `schema.prisma:L6895`
- `ProviderEventLog` → `schema.prisma:L6524`
- `PurchaseOrder` → `schema.prisma:L2524`
- `PurchaseOrderInvoice` → `schema.prisma:L2669`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2726`
- `PurchaseOrderItem` → `schema.prisma:L2582`
- `RateCorrectionBatch` → `schema.prisma:L7120`
- `RateCorrectionEntry` → `schema.prisma:L7162`
- `RawMaterial` → `schema.prisma:L2280`
- `RawMaterialMovement` → `schema.prisma:L2852`
- `RawMaterialPresentation` → `schema.prisma:L2356`
- `ReceiptLayout` → `schema.prisma:L18330`
- `Recipe` → `schema.prisma:L2376`
- `RecipeLine` → `schema.prisma:L2400`
- `Referral` → `schema.prisma:L8389`
- `ReferralProgramConfig` → `schema.prisma:L8354`
- `ReferralRewardGrant` → `schema.prisma:L8480`
- `ReferralTierReward` → `schema.prisma:L8452`
- `ReferralTierUnlock` → `schema.prisma:L8525`
- `RefreshGrant` → `schema.prisma:L18275`
- `Reservation` → `schema.prisma:L13921`
- `ReservationGoogleEventMapping` → `schema.prisma:L14691`
- `ReservationModifier` → `schema.prisma:L14101`
- `ReservationReminderSent` → `schema.prisma:L14084`
- `ReservationSettings` → `schema.prisma:L14315`
- `ReservationWaitlistEntry` → `schema.prisma:L14283`
- `Review` → `schema.prisma:L5177`
- `SalesRetention` → `schema.prisma:L17238`
- `SaleVerification` → `schema.prisma:L4670`
- `ScaleProfile` → `schema.prisma:L16040`
- `ScheduledCommand` → `schema.prisma:L10752`
- `SerializedItem` → `schema.prisma:L12402`
- `SerializedItemCustodyEvent` → `schema.prisma:L12569`
- `ServiceCharge` → `schema.prisma:L8989`
- `Session` → `schema.prisma:L18254`
- `SettlementConfiguration` → `schema.prisma:L7195`
- `SettlementConfirmation` → `schema.prisma:L7308`
- `SettlementIncident` → `schema.prisma:L7259`
- `SettlementSimulation` → `schema.prisma:L7230`
- `Shift` → `schema.prisma:L3355`
- `SimRegistrationRequest` → `schema.prisma:L12607`
- `SimRegistrationRequestItem` → `schema.prisma:L12629`
- `SlotHold` → `schema.prisma:L14184`
- `Staff` → `schema.prisma:L1000`
- `StaffDocument` → `schema.prisma:L3603`
- `StaffOnboardingState` → `schema.prisma:L16370`
- `StaffOrganization` → `schema.prisma:L1333`
- `StaffPasskey` → `schema.prisma:L1360`
- `StaffSchedule` → `schema.prisma:L14124`
- `StaffScheduleException` → `schema.prisma:L14136`
- `StaffVenue` → `schema.prisma:L1257`
- `StaffWorkSchedule` → `schema.prisma:L3480`
- `StaffWorkScheduleException` → `schema.prisma:L3578`
- `StampCard` → `schema.prisma:L8237`
- `StampEvent` → `schema.prisma:L8276`
- `StampReward` → `schema.prisma:L8314`
- `StockAlertConfig` → `schema.prisma:L13260`
- `StockBatch` → `schema.prisma:L3018`
- `StockCount` → `schema.prisma:L2935`
- `StockCountItem` → `schema.prisma:L2963`
- `StripeWebhookEvent` → `schema.prisma:L6842`
- `Supplier` → `schema.prisma:L2435`
- `SupplierItemCode` → `schema.prisma:L2767`
- `SupplierPricing` → `schema.prisma:L2490`
- `Table` → `schema.prisma:L3267`
- `Terminal` → `schema.prisma:L5228`
- `TerminalAttemptResolution` → `schema.prisma:L5659`
- `TerminalHealth` → `schema.prisma:L5479`
- `TerminalLog` → `schema.prisma:L5453`
- `TerminalOrder` → `schema.prisma:L5703`
- `TerminalOrderItem` → `schema.prisma:L5778`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5631`
- `TerminalPaymentRequest` → `schema.prisma:L5550`
- `TimeEntry` → `schema.prisma:L3645`
- `TimeEntryBreak` → `schema.prisma:L3714`
- `TokenPurchase` → `schema.prisma:L10426`
- `TokenUsageRecord` → `schema.prisma:L10398`
- `TpvCommandHistory` → `schema.prisma:L10658`
- `TpvCommandQueue` → `schema.prisma:L10598`
- `TpvFeedback` → `schema.prisma:L10311`
- `TpvMessage` → `schema.prisma:L13617`
- `TpvMessageDelivery` → `schema.prisma:L13669`
- `TpvMessageResponse` → `schema.prisma:L13692`
- `TrainingModule` → `schema.prisma:L13747`
- `TrainingProgress` → `schema.prisma:L13824`
- `TrainingQuizQuestion` → `schema.prisma:L13806`
- `TrainingStep` → `schema.prisma:L13786`
- `TransactionCost` → `schema.prisma:L7058`
- `UnitConversion` → `schema.prisma:L2830`
- `UpsellAcceptance` → `schema.prisma:L8810`
- `UpsellAiRun` → `schema.prisma:L8830`
- `UpsellImpression` → `schema.prisma:L8770`
- `UpsellRule` → `schema.prisma:L8690`
- `user_sessions` → `schema.prisma:L6280`
- `Venue` → `schema.prisma:L167`
- `VenueAreaTicketSettings` → `schema.prisma:L15777`
- `VenueChatMessage` → `schema.prisma:L812`
- `VenueChatSession` → `schema.prisma:L767`
- `VenueCommission` → `schema.prisma:L15385`
- `VenueCreditAssessment` → `schema.prisma:L11140`
- `VenueCryptoConfig` → `schema.prisma:L13484`
- `VenueFeature` → `schema.prisma:L4784`
- `VenueIvaPorProducto` → `schema.prisma:L963`
- `VenueModule` → `schema.prisma:L11300`
- `VenuePaymentConfig` → `schema.prisma:L6381`
- `VenuePaymentLinkSettings` → `schema.prisma:L14724`
- `VenuePosSinAparato` → `schema.prisma:L974`
- `VenuePricingStructure` → `schema.prisma:L6998`
- `VenueRoleConfig` → `schema.prisma:L1486`
- `VenueRolePermission` → `schema.prisma:L1390`
- `VenueScaleSettings` → `schema.prisma:L16028`
- `VenueSettings` → `schema.prisma:L852`
- `VenueTenderType` → `schema.prisma:L4529`
- `VenueTenderTypeRevision` → `schema.prisma:L4594`
- `VenueTransaction` → `schema.prisma:L4721`
- `VenueWhatsappActivation` → `schema.prisma:L703`
- `WalletCardDesign` → `schema.prisma:L8155`
- `WalletPass` → `schema.prisma:L8056`
- `WalletPassRegistration` → `schema.prisma:L8122`
- `WebhookEvent` → `schema.prisma:L5086`
- `WebhookSubscription` → `schema.prisma:L6497`
- `WhatsappContactWindow` → `schema.prisma:L721`
- `WhatsappInboundEvent` → `schema.prisma:L741`
- `WorkShiftAssignment` → `schema.prisma:L3520`
- `WorkShiftTemplate` → `schema.prisma:L3497`
- `Zone` → `schema.prisma:L150`
