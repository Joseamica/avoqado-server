# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **399 models / 366 enums / ~18,700 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `ClassSessionPayState`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `ServiceEarning`, `ServicePayPeriod`, `ServicePayTable`, `ServicePayTableCell`, `ServicePayTableVersion`, `StaffPayLevel`, `StaffPayLevelAssignment`, `StaffPayStatement`, `VenueCommission`                                                                                                                                                                                                                                                |
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

- `AccountingPeriodLock` → `schema.prisma:L17110`
- `AccountMapping` → `schema.prisma:L17005`
- `ActivityLog` → `schema.prisma:L7482`
- `Aggregator` → `schema.prisma:L15281`
- `AngelPayUserAccount` → `schema.prisma:L6027`
- `AppUpdate` → `schema.prisma:L13445`
- `Area` → `schema.prisma:L3250`
- `AreaTicket` → `schema.prisma:L15817`
- `AreaTicketCheckoutSession` → `schema.prisma:L15939`
- `AreaTicketExternalIncident` → `schema.prisma:L16186`
- `AreaTicketExternalSettlement` → `schema.prisma:L16151`
- `AreaTicketFulfillment` → `schema.prisma:L16015`
- `AreaTicketInventoryReservation` → `schema.prisma:L15910`
- `AreaTicketLine` → `schema.prisma:L15878`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15971`
- `AreaTicketPrintAttempt` → `schema.prisma:L15994`
- `BankStatement` → `schema.prisma:L16879`
- `BankStatementLine` → `schema.prisma:L16900`
- `BillingObligationConflict` → `schema.prisma:L5057`
- `BillingTaxProfile` → `schema.prisma:L17702`
- `BirthdayAutomation` → `schema.prisma:L7803`
- `BulkCommandOperation` → `schema.prisma:L10725`
- `CalendarSyncOutbox` → `schema.prisma:L14653`
- `CampaignDelivery` → `schema.prisma:L13603`
- `CapabilityGrant` → `schema.prisma:L4833`
- `CashCloseout` → `schema.prisma:L11110`
- `CashDeposit` → `schema.prisma:L13247`
- `CashDrawerEvent` → `schema.prisma:L15118`
- `CashDrawerSession` → `schema.prisma:L15079`
- `CashOutCommissionRate` → `schema.prisma:L17519`
- `CashOutScheduleDay` → `schema.prisma:L17542`
- `CashOutWithdrawal` → `schema.prisma:L17604`
- `CatalogBindingBatch` → `schema.prisma:L12141`
- `CatalogBindingLine` → `schema.prisma:L12177`
- `CatalogBrand` → `schema.prisma:L11594`
- `CatalogClientObservation` → `schema.prisma:L11907`
- `CatalogClientReadinessOverride` → `schema.prisma:L11926`
- `CatalogFamily` → `schema.prisma:L11644`
- `CatalogIdempotencyRecord` → `schema.prisma:L12040`
- `CatalogIdentifier` → `schema.prisma:L11775`
- `CatalogImportBatch` → `schema.prisma:L12083`
- `CatalogImportLine` → `schema.prisma:L12120`
- `CatalogItem` → `schema.prisma:L11677`
- `CatalogItemBusinessType` → `schema.prisma:L11737`
- `CatalogItemPrice` → `schema.prisma:L11825`
- `CatalogManufacturer` → `schema.prisma:L11618`
- `CatalogProductTypeMapping` → `schema.prisma:L11754`
- `CatalogPublicationBatch` → `schema.prisma:L12205`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12299`
- `CatalogPublicationLine` → `schema.prisma:L12246`
- `CatalogPublicationOutbox` → `schema.prisma:L12342`
- `CatalogValidationProfile` → `schema.prisma:L11796`
- `CatalogVenueBinding` → `schema.prisma:L11954`
- `CatalogVenueClientRequirement` → `schema.prisma:L11881`
- `CatalogVenueEventSequence` → `schema.prisma:L12325`
- `CatalogVenueOverride` → `schema.prisma:L11996`
- `CatalogVenueRollout` → `schema.prisma:L11856`
- `Cfdi` → `schema.prisma:L16707`
- `CfdiGlobalOrden` → `schema.prisma:L16832`
- `ChatbotTokenBudget` → `schema.prisma:L10371`
- `ChatConversation` → `schema.prisma:L10226`
- `ChatFeedback` → `schema.prisma:L10312`
- `ChatLearningEvent` → `schema.prisma:L10269`
- `ChatMessage` → `schema.prisma:L10249`
- `ChatTrainingData` → `schema.prisma:L10183`
- `CheckoutSession` → `schema.prisma:L6307`
- `ClassSession` → `schema.prisma:L14256`
- `ClassSessionPayState` → `schema.prisma:L18657`
- `CommissionCalculation` → `schema.prisma:L13023`
- `CommissionClawback` → `schema.prisma:L13199`
- `CommissionConfig` → `schema.prisma:L12789`
- `CommissionMilestone` → `schema.prisma:L12939`
- `CommissionOverride` → `schema.prisma:L12866`
- `CommissionPayout` → `schema.prisma:L13150`
- `CommissionSummary` → `schema.prisma:L13089`
- `CommissionTier` → `schema.prisma:L12903`
- `ConsentEvent` → `schema.prisma:L7665`
- `Consumer` → `schema.prisma:L7895`
- `ConsumerAuthAccount` → `schema.prisma:L7920`
- `CouponCode` → `schema.prisma:L8867`
- `CouponRedemption` → `schema.prisma:L8898`
- `CreditAssessmentHistory` → `schema.prisma:L11219`
- `CreditItemBalance` → `schema.prisma:L14869`
- `CreditOffer` → `schema.prisma:L11238`
- `CreditPack` → `schema.prisma:L14778`
- `CreditPackItem` → `schema.prisma:L14807`
- `CreditPackPurchase` → `schema.prisma:L14824`
- `CreditTransaction` → `schema.prisma:L14891`
- `Customer` → `schema.prisma:L7523`
- `CustomerApprovalDelivery` → `schema.prisma:L9885`
- `CustomerApprovalOutbox` → `schema.prisma:L9860`
- `CustomerCampaign` → `schema.prisma:L7753`
- `CustomerCampaignDelivery` → `schema.prisma:L7835`
- `CustomerCaptureToken` → `schema.prisma:L7701`
- `CustomerDiscount` → `schema.prisma:L8918`
- `CustomerGroup` → `schema.prisma:L7959`
- `CustomerOrderMetric` → `schema.prisma:L4049`
- `CustomerTaxProfile` → `schema.prisma:L16851`
- `DeliveryActivationRequest` → `schema.prisma:L6766`
- `DeliveryChannelLink` → `schema.prisma:L6605`
- `DeliveryConnectIntent` → `schema.prisma:L6717`
- `DeliveryLineAction` → `schema.prisma:L6678`
- `DeliveryOrderEvent` → `schema.prisma:L6790`
- `DeliveryStoreRevocation` → `schema.prisma:L6754`
- `DeviceToken` → `schema.prisma:L9187`
- `DigitalReceipt` → `schema.prisma:L4646`
- `Discount` → `schema.prisma:L8557`
- `EcommerceMerchant` → `schema.prisma:L6119`
- `EmailQuotaLedger` → `schema.prisma:L7882`
- `EmailSuppression` → `schema.prisma:L7870`
- `EmailTemplate` → `schema.prisma:L13542`
- `Employee` → `schema.prisma:L17367`
- `Estimate` → `schema.prisma:L15188`
- `EstimateItem` → `schema.prisma:L15216`
- `Expense` → `schema.prisma:L17154`
- `ExternalBusyBlock` → `schema.prisma:L14546`
- `Feature` → `schema.prisma:L4775`
- `FeeSchedule` → `schema.prisma:L5119`
- `FeeTier` → `schema.prisma:L5130`
- `FinancialAccount` → `schema.prisma:L15378`
- `FinancialConnection` → `schema.prisma:L15347`
- `FinancialProvider` → `schema.prisma:L15333`
- `FiscalEmisor` → `schema.prisma:L16623`
- `FiscalLossCarryforward` → `schema.prisma:L17277`
- `FixedAsset` → `schema.prisma:L17295`
- `FixedAssetDepreciation` → `schema.prisma:L17324`
- `FloorElement` → `schema.prisma:L3326`
- `FulfillmentArea` → `schema.prisma:L15682`
- `GeofenceRule` → `schema.prisma:L10810`
- `GoogleCalendarChannel` → `schema.prisma:L14523`
- `GoogleCalendarConnection` → `schema.prisma:L14475`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14576`
- `GoogleOAuthSession` → `schema.prisma:L14598`
- `HolidayCalendar` → `schema.prisma:L7406`
- `HybridBillingOperation` → `schema.prisma:L4981`
- `HybridCampaign` → `schema.prisma:L4858`
- `HybridContract` → `schema.prisma:L4938`
- `HybridContractSelection` → `schema.prisma:L4970`
- `HybridCreditAllocation` → `schema.prisma:L5037`
- `HybridOfferPublication` → `schema.prisma:L4885`
- `HybridPaymentPeriod` → `schema.prisma:L5016`
- `HybridPurchase` → `schema.prisma:L4905`
- `HybridRedemption` → `schema.prisma:L4999`
- `IdempotencyRequest` → `schema.prisma:L12664`
- `InterVenueTransfer` → `schema.prisma:L3078`
- `InterVenueTransferAllocation` → `schema.prisma:L3161`
- `InterVenueTransferItem` → `schema.prisma:L3130`
- `InterVenueTransferReceipt` → `schema.prisma:L3188`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3204`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3232`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3216`
- `Inventory` → `schema.prisma:L2022`
- `InventoryMovement` → `schema.prisma:L2122`
- `InventoryPosting` → `schema.prisma:L2217`
- `InventoryPostingLine` → `schema.prisma:L2257`
- `InventoryTransfer` → `schema.prisma:L15160`
- `InventoryWasteReport` → `schema.prisma:L2077`
- `Invitation` → `schema.prisma:L1519`
- `Invoice` → `schema.prisma:L5142`
- `InvoiceItem` → `schema.prisma:L5168`
- `ItemCategory` → `schema.prisma:L12377`
- `JournalEntry` → `schema.prisma:L17063`
- `JournalLine` → `schema.prisma:L17092`
- `KdsOrder` → `schema.prisma:L15426`
- `KdsOrderItem` → `schema.prisma:L15489`
- `KioskCheckInAttempt` → `schema.prisma:L18025`
- `KioskCheckInChallenge` → `schema.prisma:L17979`
- `KioskOutreachOutbox` → `schema.prisma:L18046`
- `LaunchCampaign` → `schema.prisma:L18384`
- `LaunchCampaignRedemption` → `schema.prisma:L18501`
- `LearnedPatterns` → `schema.prisma:L10293`
- `LedgerAccount` → `schema.prisma:L16955`
- `LiveDemoSession` → `schema.prisma:L844`
- `LowStockAlert` → `schema.prisma:L2912`
- `LoyaltyConfig` → `schema.prisma:L7989`
- `LoyaltyTransaction` → `schema.prisma:L8032`
- `MarketingCampaign` → `schema.prisma:L13560`
- `McpAuthCode` → `schema.prisma:L16505`
- `McpOAuthClient` → `schema.prisma:L16489`
- `McpRefreshToken` → `schema.prisma:L16523`
- `McpToolCall` → `schema.prisma:L16545`
- `MeasurementUnit` → `schema.prisma:L15266`
- `Menu` → `schema.prisma:L1737`
- `MenuCategory` → `schema.prisma:L1674`
- `MenuCategoryAssignment` → `schema.prisma:L1772`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16419`
- `MerchantAccount` → `schema.prisma:L5857`
- `MerchantFiscalConfig` → `schema.prisma:L16678`
- `MerchantRevenueShare` → `schema.prisma:L6986`
- `MerchantRoutingRule` → `schema.prisma:L5979`
- `MilestoneAchievement` → `schema.prisma:L12984`
- `Modifier` → `schema.prisma:L4248`
- `ModifierGroup` → `schema.prisma:L4212`
- `Module` → `schema.prisma:L11286`
- `MoneyAnomaly` → `schema.prisma:L6889`
- `MonthlyVenueProfit` → `schema.prisma:L7432`
- `Notification` → `schema.prisma:L9089`
- `NotificationPreference` → `schema.prisma:L9136`
- `NotificationTemplate` → `schema.prisma:L9163`
- `OAuthState` → `schema.prisma:L1570`
- `OnboardingProgress` → `schema.prisma:L1588`
- `Order` → `schema.prisma:L3775`
- `OrderAction` → `schema.prisma:L4319`
- `OrderCustomer` → `schema.prisma:L4028`
- `OrderDiscount` → `schema.prisma:L8950`
- `OrderFulfillment` → `schema.prisma:L15737`
- `OrderFulfillmentLine` → `schema.prisma:L15768`
- `OrderItem` → `schema.prisma:L4064`
- `OrderItemModifier` → `schema.prisma:L4301`
- `OrderItemSelloIva` → `schema.prisma:L16812`
- `OrderPromotion` → `schema.prisma:L17942`
- `OrderServiceCharge` → `schema.prisma:L9034`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13361`
- `OrganizationEntitlement` → `schema.prisma:L11569`
- `OrganizationGoal` → `schema.prisma:L13319`
- `OrganizationModule` → `schema.prisma:L11346`
- `OrganizationPaymentConfig` → `schema.prisma:L6431`
- `OrganizationPayoutConfig` → `schema.prisma:L13394`
- `OrganizationPricingStructure` → `schema.prisma:L6463`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13342`
- `OtpChallenge` → `schema.prisma:L7939`
- `OvertimeApproval` → `schema.prisma:L3553`
- `PartnerAPIKey` → `schema.prisma:L6261`
- `Payment` → `schema.prisma:L4352`
- `PaymentAllocation` → `schema.prisma:L4625`
- `PaymentEffect` → `schema.prisma:L18316`
- `PaymentLink` → `schema.prisma:L14937`
- `PaymentLinkAttribution` → `schema.prisma:L15045`
- `PaymentLinkItem` → `schema.prisma:L15000`
- `PaymentLinkItemModifier` → `schema.prisma:L15027`
- `PaymentProvider` → `schema.prisma:L5816`
- `PayrollLine` → `schema.prisma:L17438`
- `PayrollRun` → `schema.prisma:L17407`
- `PerformanceGoal` → `schema.prisma:L13296`
- `PermissionOverride` → `schema.prisma:L1443`
- `PermissionSet` → `schema.prisma:L1466`
- `PlatformAnnouncement` → `schema.prisma:L18106`
- `PlatformAnnouncementClick` → `schema.prisma:L18171`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18208`
- `PlatformCfdi` → `schema.prisma:L17735`
- `PlatformEmisor` → `schema.prisma:L17675`
- `PlatformSettings` → `schema.prisma:L6238`
- `PosCommand` → `schema.prisma:L9217`
- `PosConnectionStatus` → `schema.prisma:L988`
- `PosSyncIntent` → `schema.prisma:L17813`
- `PricingPolicy` → `schema.prisma:L2808`
- `Printer` → `schema.prisma:L15538`
- `PrintGateway` → `schema.prisma:L15595`
- `PrintJob` → `schema.prisma:L16318`
- `PrintStation` → `schema.prisma:L15613`
- `PrivacyNoticeVersion` → `schema.prisma:L7687`
- `ProcessedStripeEvent` → `schema.prisma:L6875`
- `ProcessorReliabilityMetric` → `schema.prisma:L7360`
- `Product` → `schema.prisma:L1790`
- `ProductModifierGroup` → `schema.prisma:L4289`
- `ProductOption` → `schema.prisma:L15243`
- `ProductOptionValue` → `schema.prisma:L15254`
- `ProductStaff` → `schema.prisma:L14171`
- `PromoterBankAccount` → `schema.prisma:L17558`
- `PromoterCommissionEntry` → `schema.prisma:L17577`
- `PromoterLocationPing` → `schema.prisma:L3741`
- `Promotion` → `schema.prisma:L17864`
- `PromotionGroup` → `schema.prisma:L17903`
- `PromotionOption` → `schema.prisma:L17919`
- `ProviderCostStructure` → `schema.prisma:L6911`
- `ProviderEventLog` → `schema.prisma:L6540`
- `PurchaseOrder` → `schema.prisma:L2533`
- `PurchaseOrderInvoice` → `schema.prisma:L2678`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2735`
- `PurchaseOrderItem` → `schema.prisma:L2591`
- `RateCorrectionBatch` → `schema.prisma:L7136`
- `RateCorrectionEntry` → `schema.prisma:L7178`
- `RawMaterial` → `schema.prisma:L2289`
- `RawMaterialMovement` → `schema.prisma:L2861`
- `RawMaterialPresentation` → `schema.prisma:L2365`
- `ReceiptLayout` → `schema.prisma:L18350`
- `Recipe` → `schema.prisma:L2385`
- `RecipeLine` → `schema.prisma:L2409`
- `Referral` → `schema.prisma:L8405`
- `ReferralProgramConfig` → `schema.prisma:L8370`
- `ReferralRewardGrant` → `schema.prisma:L8496`
- `ReferralTierReward` → `schema.prisma:L8468`
- `ReferralTierUnlock` → `schema.prisma:L8541`
- `RefreshGrant` → `schema.prisma:L18295`
- `Reservation` → `schema.prisma:L13939`
- `ReservationGoogleEventMapping` → `schema.prisma:L14710`
- `ReservationModifier` → `schema.prisma:L14119`
- `ReservationReminderSent` → `schema.prisma:L14102`
- `ReservationSettings` → `schema.prisma:L14334`
- `ReservationWaitlistEntry` → `schema.prisma:L14302`
- `Review` → `schema.prisma:L5186`
- `SalesRetention` → `schema.prisma:L17258`
- `SaleVerification` → `schema.prisma:L4679`
- `ScaleProfile` → `schema.prisma:L16059`
- `ScheduledCommand` → `schema.prisma:L10770`
- `SerializedItem` → `schema.prisma:L12420`
- `SerializedItemCustodyEvent` → `schema.prisma:L12587`
- `ServiceCharge` → `schema.prisma:L9005`
- `ServiceEarning` → `schema.prisma:L18717`
- `ServicePayPeriod` → `schema.prisma:L18693`
- `ServicePayTable` → `schema.prisma:L18608`
- `ServicePayTableCell` → `schema.prisma:L18645`
- `ServicePayTableVersion` → `schema.prisma:L18625`
- `Session` → `schema.prisma:L18274`
- `SettlementConfiguration` → `schema.prisma:L7211`
- `SettlementConfirmation` → `schema.prisma:L7324`
- `SettlementIncident` → `schema.prisma:L7275`
- `SettlementSimulation` → `schema.prisma:L7246`
- `Shift` → `schema.prisma:L3364`
- `SimRegistrationRequest` → `schema.prisma:L12625`
- `SimRegistrationRequestItem` → `schema.prisma:L12647`
- `SlotHold` → `schema.prisma:L14202`
- `Staff` → `schema.prisma:L1008`
- `StaffDocument` → `schema.prisma:L3612`
- `StaffOnboardingState` → `schema.prisma:L16389`
- `StaffOrganization` → `schema.prisma:L1342`
- `StaffPasskey` → `schema.prisma:L1369`
- `StaffPayLevel` → `schema.prisma:L18572`
- `StaffPayLevelAssignment` → `schema.prisma:L18590`
- `StaffPayStatement` → `schema.prisma:L18747`
- `StaffSchedule` → `schema.prisma:L14142`
- `StaffScheduleException` → `schema.prisma:L14154`
- `StaffVenue` → `schema.prisma:L1266`
- `StaffWorkSchedule` → `schema.prisma:L3489`
- `StaffWorkScheduleException` → `schema.prisma:L3587`
- `StampCard` → `schema.prisma:L8253`
- `StampEvent` → `schema.prisma:L8292`
- `StampReward` → `schema.prisma:L8330`
- `StockAlertConfig` → `schema.prisma:L13278`
- `StockBatch` → `schema.prisma:L3027`
- `StockCount` → `schema.prisma:L2944`
- `StockCountItem` → `schema.prisma:L2972`
- `StripeWebhookEvent` → `schema.prisma:L6858`
- `Supplier` → `schema.prisma:L2444`
- `SupplierItemCode` → `schema.prisma:L2776`
- `SupplierPricing` → `schema.prisma:L2499`
- `Table` → `schema.prisma:L3276`
- `Terminal` → `schema.prisma:L5237`
- `TerminalAttemptResolution` → `schema.prisma:L5675`
- `TerminalHealth` → `schema.prisma:L5495`
- `TerminalLog` → `schema.prisma:L5469`
- `TerminalOrder` → `schema.prisma:L5719`
- `TerminalOrderItem` → `schema.prisma:L5794`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5647`
- `TerminalPaymentRequest` → `schema.prisma:L5566`
- `TimeEntry` → `schema.prisma:L3654`
- `TimeEntryBreak` → `schema.prisma:L3723`
- `TokenPurchase` → `schema.prisma:L10442`
- `TokenUsageRecord` → `schema.prisma:L10414`
- `TpvCommandHistory` → `schema.prisma:L10676`
- `TpvCommandQueue` → `schema.prisma:L10614`
- `TpvFeedback` → `schema.prisma:L10327`
- `TpvMessage` → `schema.prisma:L13635`
- `TpvMessageDelivery` → `schema.prisma:L13687`
- `TpvMessageResponse` → `schema.prisma:L13710`
- `TrainingModule` → `schema.prisma:L13765`
- `TrainingProgress` → `schema.prisma:L13842`
- `TrainingQuizQuestion` → `schema.prisma:L13824`
- `TrainingStep` → `schema.prisma:L13804`
- `TransactionCost` → `schema.prisma:L7074`
- `UnitConversion` → `schema.prisma:L2839`
- `UpsellAcceptance` → `schema.prisma:L8826`
- `UpsellAiRun` → `schema.prisma:L8846`
- `UpsellImpression` → `schema.prisma:L8786`
- `UpsellRule` → `schema.prisma:L8706`
- `user_sessions` → `schema.prisma:L6296`
- `Venue` → `schema.prisma:L173`
- `VenueAreaTicketSettings` → `schema.prisma:L15796`
- `VenueChatMessage` → `schema.prisma:L820`
- `VenueChatSession` → `schema.prisma:L775`
- `VenueCommission` → `schema.prisma:L15404`
- `VenueCreditAssessment` → `schema.prisma:L11158`
- `VenueCryptoConfig` → `schema.prisma:L13502`
- `VenueFeature` → `schema.prisma:L4793`
- `VenueIvaPorProducto` → `schema.prisma:L971`
- `VenueModule` → `schema.prisma:L11318`
- `VenuePaymentConfig` → `schema.prisma:L6397`
- `VenuePaymentLinkSettings` → `schema.prisma:L14743`
- `VenuePosSinAparato` → `schema.prisma:L982`
- `VenuePricingStructure` → `schema.prisma:L7014`
- `VenueRoleConfig` → `schema.prisma:L1495`
- `VenueRolePermission` → `schema.prisma:L1399`
- `VenueScaleSettings` → `schema.prisma:L16047`
- `VenueSettings` → `schema.prisma:L860`
- `VenueTenderType` → `schema.prisma:L4538`
- `VenueTenderTypeRevision` → `schema.prisma:L4603`
- `VenueTransaction` → `schema.prisma:L4730`
- `VenueWhatsappActivation` → `schema.prisma:L711`
- `WalletCardDesign` → `schema.prisma:L8171`
- `WalletPass` → `schema.prisma:L8072`
- `WalletPassRegistration` → `schema.prisma:L8138`
- `WebhookEvent` → `schema.prisma:L5095`
- `WebhookSubscription` → `schema.prisma:L6513`
- `WhatsappContactWindow` → `schema.prisma:L729`
- `WhatsappInboundEvent` → `schema.prisma:L749`
- `WorkShiftAssignment` → `schema.prisma:L3529`
- `WorkShiftTemplate` → `schema.prisma:L3506`
- `Zone` → `schema.prisma:L156`
