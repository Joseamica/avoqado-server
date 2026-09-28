# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **379 models / 360 enums / ~18,200 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueIvaPorProducto`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
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

- `AccountingPeriodLock` → `schema.prisma:L16824`
- `AccountMapping` → `schema.prisma:L16719`
- `ActivityLog` → `schema.prisma:L7218`
- `Aggregator` → `schema.prisma:L15014`
- `AngelPayUserAccount` → `schema.prisma:L5763`
- `AppUpdate` → `schema.prisma:L13179`
- `Area` → `schema.prisma:L3222`
- `AreaTicket` → `schema.prisma:L15532`
- `AreaTicketCheckoutSession` → `schema.prisma:L15654`
- `AreaTicketExternalIncident` → `schema.prisma:L15901`
- `AreaTicketExternalSettlement` → `schema.prisma:L15866`
- `AreaTicketFulfillment` → `schema.prisma:L15730`
- `AreaTicketInventoryReservation` → `schema.prisma:L15625`
- `AreaTicketLine` → `schema.prisma:L15593`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15686`
- `AreaTicketPrintAttempt` → `schema.prisma:L15709`
- `BankStatement` → `schema.prisma:L16593`
- `BankStatementLine` → `schema.prisma:L16614`
- `BillingObligationConflict` → `schema.prisma:L4800`
- `BillingTaxProfile` → `schema.prisma:L17416`
- `BirthdayAutomation` → `schema.prisma:L7539`
- `BulkCommandOperation` → `schema.prisma:L10459`
- `CalendarSyncOutbox` → `schema.prisma:L14386`
- `CampaignDelivery` → `schema.prisma:L13337`
- `CashCloseout` → `schema.prisma:L10844`
- `CashDeposit` → `schema.prisma:L12981`
- `CashDrawerEvent` → `schema.prisma:L14851`
- `CashDrawerSession` → `schema.prisma:L14812`
- `CashOutCommissionRate` → `schema.prisma:L17233`
- `CashOutScheduleDay` → `schema.prisma:L17256`
- `CashOutWithdrawal` → `schema.prisma:L17318`
- `CatalogBindingBatch` → `schema.prisma:L11875`
- `CatalogBindingLine` → `schema.prisma:L11911`
- `CatalogBrand` → `schema.prisma:L11328`
- `CatalogClientObservation` → `schema.prisma:L11641`
- `CatalogClientReadinessOverride` → `schema.prisma:L11660`
- `CatalogFamily` → `schema.prisma:L11378`
- `CatalogIdempotencyRecord` → `schema.prisma:L11774`
- `CatalogIdentifier` → `schema.prisma:L11509`
- `CatalogImportBatch` → `schema.prisma:L11817`
- `CatalogImportLine` → `schema.prisma:L11854`
- `CatalogItem` → `schema.prisma:L11411`
- `CatalogItemBusinessType` → `schema.prisma:L11471`
- `CatalogItemPrice` → `schema.prisma:L11559`
- `CatalogManufacturer` → `schema.prisma:L11352`
- `CatalogProductTypeMapping` → `schema.prisma:L11488`
- `CatalogPublicationBatch` → `schema.prisma:L11939`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12033`
- `CatalogPublicationLine` → `schema.prisma:L11980`
- `CatalogPublicationOutbox` → `schema.prisma:L12076`
- `CatalogValidationProfile` → `schema.prisma:L11530`
- `CatalogVenueBinding` → `schema.prisma:L11688`
- `CatalogVenueClientRequirement` → `schema.prisma:L11615`
- `CatalogVenueEventSequence` → `schema.prisma:L12059`
- `CatalogVenueOverride` → `schema.prisma:L11730`
- `CatalogVenueRollout` → `schema.prisma:L11590`
- `Cfdi` → `schema.prisma:L16421`
- `CfdiGlobalOrden` → `schema.prisma:L16546`
- `ChatbotTokenBudget` → `schema.prisma:L10107`
- `ChatConversation` → `schema.prisma:L9962`
- `ChatFeedback` → `schema.prisma:L10048`
- `ChatLearningEvent` → `schema.prisma:L10005`
- `ChatMessage` → `schema.prisma:L9985`
- `ChatTrainingData` → `schema.prisma:L9919`
- `CheckoutSession` → `schema.prisma:L6043`
- `ClassSession` → `schema.prisma:L13990`
- `CommissionCalculation` → `schema.prisma:L12757`
- `CommissionClawback` → `schema.prisma:L12933`
- `CommissionConfig` → `schema.prisma:L12523`
- `CommissionMilestone` → `schema.prisma:L12673`
- `CommissionOverride` → `schema.prisma:L12600`
- `CommissionPayout` → `schema.prisma:L12884`
- `CommissionSummary` → `schema.prisma:L12823`
- `CommissionTier` → `schema.prisma:L12637`
- `ConsentEvent` → `schema.prisma:L7401`
- `Consumer` → `schema.prisma:L7631`
- `ConsumerAuthAccount` → `schema.prisma:L7656`
- `CouponCode` → `schema.prisma:L8603`
- `CouponRedemption` → `schema.prisma:L8634`
- `CreditAssessmentHistory` → `schema.prisma:L10953`
- `CreditItemBalance` → `schema.prisma:L14602`
- `CreditOffer` → `schema.prisma:L10972`
- `CreditPack` → `schema.prisma:L14511`
- `CreditPackItem` → `schema.prisma:L14540`
- `CreditPackPurchase` → `schema.prisma:L14557`
- `CreditTransaction` → `schema.prisma:L14624`
- `Customer` → `schema.prisma:L7259`
- `CustomerApprovalDelivery` → `schema.prisma:L9621`
- `CustomerApprovalOutbox` → `schema.prisma:L9596`
- `CustomerCampaign` → `schema.prisma:L7489`
- `CustomerCampaignDelivery` → `schema.prisma:L7571`
- `CustomerCaptureToken` → `schema.prisma:L7437`
- `CustomerDiscount` → `schema.prisma:L8654`
- `CustomerGroup` → `schema.prisma:L7695`
- `CustomerOrderMetric` → `schema.prisma:L4016`
- `CustomerTaxProfile` → `schema.prisma:L16565`
- `DeliveryActivationRequest` → `schema.prisma:L6502`
- `DeliveryChannelLink` → `schema.prisma:L6341`
- `DeliveryConnectIntent` → `schema.prisma:L6453`
- `DeliveryLineAction` → `schema.prisma:L6414`
- `DeliveryOrderEvent` → `schema.prisma:L6526`
- `DeliveryStoreRevocation` → `schema.prisma:L6490`
- `DeviceToken` → `schema.prisma:L8923`
- `DigitalReceipt` → `schema.prisma:L4609`
- `Discount` → `schema.prisma:L8293`
- `EcommerceMerchant` → `schema.prisma:L5855`
- `EmailQuotaLedger` → `schema.prisma:L7618`
- `EmailSuppression` → `schema.prisma:L7606`
- `EmailTemplate` → `schema.prisma:L13276`
- `Employee` → `schema.prisma:L17081`
- `Estimate` → `schema.prisma:L14921`
- `EstimateItem` → `schema.prisma:L14949`
- `Expense` → `schema.prisma:L16868`
- `ExternalBusyBlock` → `schema.prisma:L14279`
- `Feature` → `schema.prisma:L4738`
- `FeeSchedule` → `schema.prisma:L4862`
- `FeeTier` → `schema.prisma:L4873`
- `FinancialAccount` → `schema.prisma:L15111`
- `FinancialConnection` → `schema.prisma:L15080`
- `FinancialProvider` → `schema.prisma:L15066`
- `FiscalEmisor` → `schema.prisma:L16337`
- `FiscalLossCarryforward` → `schema.prisma:L16991`
- `FixedAsset` → `schema.prisma:L17009`
- `FixedAssetDepreciation` → `schema.prisma:L17038`
- `FloorElement` → `schema.prisma:L3298`
- `FulfillmentArea` → `schema.prisma:L15397`
- `GeofenceRule` → `schema.prisma:L10544`
- `GoogleCalendarChannel` → `schema.prisma:L14256`
- `GoogleCalendarConnection` → `schema.prisma:L14208`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14309`
- `GoogleOAuthSession` → `schema.prisma:L14331`
- `HolidayCalendar` → `schema.prisma:L7142`
- `IdempotencyRequest` → `schema.prisma:L12398`
- `InterVenueTransfer` → `schema.prisma:L3050`
- `InterVenueTransferAllocation` → `schema.prisma:L3133`
- `InterVenueTransferItem` → `schema.prisma:L3102`
- `InterVenueTransferReceipt` → `schema.prisma:L3160`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3176`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3204`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3188`
- `Inventory` → `schema.prisma:L1994`
- `InventoryMovement` → `schema.prisma:L2094`
- `InventoryPosting` → `schema.prisma:L2189`
- `InventoryPostingLine` → `schema.prisma:L2229`
- `InventoryTransfer` → `schema.prisma:L14893`
- `InventoryWasteReport` → `schema.prisma:L2049`
- `Invitation` → `schema.prisma:L1494`
- `Invoice` → `schema.prisma:L4885`
- `InvoiceItem` → `schema.prisma:L4911`
- `ItemCategory` → `schema.prisma:L12111`
- `JournalEntry` → `schema.prisma:L16777`
- `JournalLine` → `schema.prisma:L16806`
- `KdsOrder` → `schema.prisma:L15159`
- `KdsOrderItem` → `schema.prisma:L15208`
- `KioskCheckInAttempt` → `schema.prisma:L17739`
- `KioskCheckInChallenge` → `schema.prisma:L17693`
- `KioskOutreachOutbox` → `schema.prisma:L17760`
- `LaunchCampaign` → `schema.prisma:L18098`
- `LaunchCampaignRedemption` → `schema.prisma:L18215`
- `LearnedPatterns` → `schema.prisma:L10029`
- `LedgerAccount` → `schema.prisma:L16669`
- `LiveDemoSession` → `schema.prisma:L830`
- `LowStockAlert` → `schema.prisma:L2884`
- `LoyaltyConfig` → `schema.prisma:L7725`
- `LoyaltyTransaction` → `schema.prisma:L7768`
- `MarketingCampaign` → `schema.prisma:L13294`
- `McpAuthCode` → `schema.prisma:L16220`
- `McpOAuthClient` → `schema.prisma:L16204`
- `McpRefreshToken` → `schema.prisma:L16238`
- `McpToolCall` → `schema.prisma:L16259`
- `MeasurementUnit` → `schema.prisma:L14999`
- `Menu` → `schema.prisma:L1712`
- `MenuCategory` → `schema.prisma:L1649`
- `MenuCategoryAssignment` → `schema.prisma:L1747`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16134`
- `MerchantAccount` → `schema.prisma:L5593`
- `MerchantFiscalConfig` → `schema.prisma:L16392`
- `MerchantRevenueShare` → `schema.prisma:L6722`
- `MerchantRoutingRule` → `schema.prisma:L5715`
- `MilestoneAchievement` → `schema.prisma:L12718`
- `Modifier` → `schema.prisma:L4215`
- `ModifierGroup` → `schema.prisma:L4179`
- `Module` → `schema.prisma:L11020`
- `MoneyAnomaly` → `schema.prisma:L6625`
- `MonthlyVenueProfit` → `schema.prisma:L7168`
- `Notification` → `schema.prisma:L8825`
- `NotificationPreference` → `schema.prisma:L8872`
- `NotificationTemplate` → `schema.prisma:L8899`
- `OAuthState` → `schema.prisma:L1545`
- `OnboardingProgress` → `schema.prisma:L1563`
- `Order` → `schema.prisma:L3747`
- `OrderAction` → `schema.prisma:L4282`
- `OrderCustomer` → `schema.prisma:L3995`
- `OrderDiscount` → `schema.prisma:L8686`
- `OrderFulfillment` → `schema.prisma:L15452`
- `OrderFulfillmentLine` → `schema.prisma:L15483`
- `OrderItem` → `schema.prisma:L4031`
- `OrderItemModifier` → `schema.prisma:L4264`
- `OrderItemSelloIva` → `schema.prisma:L16526`
- `OrderPromotion` → `schema.prisma:L17656`
- `OrderServiceCharge` → `schema.prisma:L8770`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13095`
- `OrganizationEntitlement` → `schema.prisma:L11303`
- `OrganizationGoal` → `schema.prisma:L13053`
- `OrganizationModule` → `schema.prisma:L11080`
- `OrganizationPaymentConfig` → `schema.prisma:L6167`
- `OrganizationPayoutConfig` → `schema.prisma:L13128`
- `OrganizationPricingStructure` → `schema.prisma:L6199`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13076`
- `OtpChallenge` → `schema.prisma:L7675`
- `OvertimeApproval` → `schema.prisma:L3525`
- `PartnerAPIKey` → `schema.prisma:L5997`
- `Payment` → `schema.prisma:L4315`
- `PaymentAllocation` → `schema.prisma:L4588`
- `PaymentEffect` → `schema.prisma:L18030`
- `PaymentLink` → `schema.prisma:L14670`
- `PaymentLinkAttribution` → `schema.prisma:L14778`
- `PaymentLinkItem` → `schema.prisma:L14733`
- `PaymentLinkItemModifier` → `schema.prisma:L14760`
- `PaymentProvider` → `schema.prisma:L5552`
- `PayrollLine` → `schema.prisma:L17152`
- `PayrollRun` → `schema.prisma:L17121`
- `PerformanceGoal` → `schema.prisma:L13030`
- `PermissionOverride` → `schema.prisma:L1418`
- `PermissionSet` → `schema.prisma:L1441`
- `PlatformAnnouncement` → `schema.prisma:L17820`
- `PlatformAnnouncementClick` → `schema.prisma:L17885`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17922`
- `PlatformCfdi` → `schema.prisma:L17449`
- `PlatformEmisor` → `schema.prisma:L17389`
- `PlatformSettings` → `schema.prisma:L5974`
- `PosCommand` → `schema.prisma:L8953`
- `PosConnectionStatus` → `schema.prisma:L964`
- `PosSyncIntent` → `schema.prisma:L17527`
- `PricingPolicy` → `schema.prisma:L2780`
- `Printer` → `schema.prisma:L15257`
- `PrintGateway` → `schema.prisma:L15314`
- `PrintJob` → `schema.prisma:L16033`
- `PrintStation` → `schema.prisma:L15332`
- `PrivacyNoticeVersion` → `schema.prisma:L7423`
- `ProcessedStripeEvent` → `schema.prisma:L6611`
- `ProcessorReliabilityMetric` → `schema.prisma:L7096`
- `Product` → `schema.prisma:L1765`
- `ProductModifierGroup` → `schema.prisma:L4252`
- `ProductOption` → `schema.prisma:L14976`
- `ProductOptionValue` → `schema.prisma:L14987`
- `ProductStaff` → `schema.prisma:L13905`
- `PromoterBankAccount` → `schema.prisma:L17272`
- `PromoterCommissionEntry` → `schema.prisma:L17291`
- `PromoterLocationPing` → `schema.prisma:L3713`
- `Promotion` → `schema.prisma:L17578`
- `PromotionGroup` → `schema.prisma:L17617`
- `PromotionOption` → `schema.prisma:L17633`
- `ProviderCostStructure` → `schema.prisma:L6647`
- `ProviderEventLog` → `schema.prisma:L6276`
- `PurchaseOrder` → `schema.prisma:L2505`
- `PurchaseOrderInvoice` → `schema.prisma:L2650`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2707`
- `PurchaseOrderItem` → `schema.prisma:L2563`
- `RateCorrectionBatch` → `schema.prisma:L6872`
- `RateCorrectionEntry` → `schema.prisma:L6914`
- `RawMaterial` → `schema.prisma:L2261`
- `RawMaterialMovement` → `schema.prisma:L2833`
- `RawMaterialPresentation` → `schema.prisma:L2337`
- `ReceiptLayout` → `schema.prisma:L18064`
- `Recipe` → `schema.prisma:L2357`
- `RecipeLine` → `schema.prisma:L2381`
- `Referral` → `schema.prisma:L8141`
- `ReferralProgramConfig` → `schema.prisma:L8106`
- `ReferralRewardGrant` → `schema.prisma:L8232`
- `ReferralTierReward` → `schema.prisma:L8204`
- `ReferralTierUnlock` → `schema.prisma:L8277`
- `RefreshGrant` → `schema.prisma:L18009`
- `Reservation` → `schema.prisma:L13673`
- `ReservationGoogleEventMapping` → `schema.prisma:L14443`
- `ReservationModifier` → `schema.prisma:L13853`
- `ReservationReminderSent` → `schema.prisma:L13836`
- `ReservationSettings` → `schema.prisma:L14067`
- `ReservationWaitlistEntry` → `schema.prisma:L14035`
- `Review` → `schema.prisma:L4929`
- `SalesRetention` → `schema.prisma:L16972`
- `SaleVerification` → `schema.prisma:L4642`
- `ScaleProfile` → `schema.prisma:L15774`
- `ScheduledCommand` → `schema.prisma:L10504`
- `SerializedItem` → `schema.prisma:L12154`
- `SerializedItemCustodyEvent` → `schema.prisma:L12321`
- `ServiceCharge` → `schema.prisma:L8741`
- `Session` → `schema.prisma:L17988`
- `SettlementConfiguration` → `schema.prisma:L6947`
- `SettlementConfirmation` → `schema.prisma:L7060`
- `SettlementIncident` → `schema.prisma:L7011`
- `SettlementSimulation` → `schema.prisma:L6982`
- `Shift` → `schema.prisma:L3336`
- `SimRegistrationRequest` → `schema.prisma:L12359`
- `SimRegistrationRequestItem` → `schema.prisma:L12381`
- `SlotHold` → `schema.prisma:L13936`
- `Staff` → `schema.prisma:L984`
- `StaffDocument` → `schema.prisma:L3584`
- `StaffOnboardingState` → `schema.prisma:L16104`
- `StaffOrganization` → `schema.prisma:L1317`
- `StaffPasskey` → `schema.prisma:L1344`
- `StaffSchedule` → `schema.prisma:L13876`
- `StaffScheduleException` → `schema.prisma:L13888`
- `StaffVenue` → `schema.prisma:L1241`
- `StaffWorkSchedule` → `schema.prisma:L3461`
- `StaffWorkScheduleException` → `schema.prisma:L3559`
- `StampCard` → `schema.prisma:L7989`
- `StampEvent` → `schema.prisma:L8028`
- `StampReward` → `schema.prisma:L8066`
- `StockAlertConfig` → `schema.prisma:L13012`
- `StockBatch` → `schema.prisma:L2999`
- `StockCount` → `schema.prisma:L2916`
- `StockCountItem` → `schema.prisma:L2944`
- `StripeWebhookEvent` → `schema.prisma:L6594`
- `Supplier` → `schema.prisma:L2416`
- `SupplierItemCode` → `schema.prisma:L2748`
- `SupplierPricing` → `schema.prisma:L2471`
- `Table` → `schema.prisma:L3248`
- `Terminal` → `schema.prisma:L4980`
- `TerminalAttemptResolution` → `schema.prisma:L5411`
- `TerminalHealth` → `schema.prisma:L5231`
- `TerminalLog` → `schema.prisma:L5205`
- `TerminalOrder` → `schema.prisma:L5455`
- `TerminalOrderItem` → `schema.prisma:L5530`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5383`
- `TerminalPaymentRequest` → `schema.prisma:L5302`
- `TimeEntry` → `schema.prisma:L3626`
- `TimeEntryBreak` → `schema.prisma:L3695`
- `TokenPurchase` → `schema.prisma:L10178`
- `TokenUsageRecord` → `schema.prisma:L10150`
- `TpvCommandHistory` → `schema.prisma:L10410`
- `TpvCommandQueue` → `schema.prisma:L10350`
- `TpvFeedback` → `schema.prisma:L10063`
- `TpvMessage` → `schema.prisma:L13369`
- `TpvMessageDelivery` → `schema.prisma:L13421`
- `TpvMessageResponse` → `schema.prisma:L13444`
- `TrainingModule` → `schema.prisma:L13499`
- `TrainingProgress` → `schema.prisma:L13576`
- `TrainingQuizQuestion` → `schema.prisma:L13558`
- `TrainingStep` → `schema.prisma:L13538`
- `TransactionCost` → `schema.prisma:L6810`
- `UnitConversion` → `schema.prisma:L2811`
- `UpsellAcceptance` → `schema.prisma:L8562`
- `UpsellAiRun` → `schema.prisma:L8582`
- `UpsellImpression` → `schema.prisma:L8522`
- `UpsellRule` → `schema.prisma:L8442`
- `user_sessions` → `schema.prisma:L6032`
- `Venue` → `schema.prisma:L167`
- `VenueAreaTicketSettings` → `schema.prisma:L15511`
- `VenueChatMessage` → `schema.prisma:L806`
- `VenueChatSession` → `schema.prisma:L761`
- `VenueCommission` → `schema.prisma:L15137`
- `VenueCreditAssessment` → `schema.prisma:L10892`
- `VenueCryptoConfig` → `schema.prisma:L13236`
- `VenueFeature` → `schema.prisma:L4756`
- `VenueIvaPorProducto` → `schema.prisma:L957`
- `VenueModule` → `schema.prisma:L11052`
- `VenuePaymentConfig` → `schema.prisma:L6133`
- `VenuePaymentLinkSettings` → `schema.prisma:L14476`
- `VenuePricingStructure` → `schema.prisma:L6750`
- `VenueRoleConfig` → `schema.prisma:L1470`
- `VenueRolePermission` → `schema.prisma:L1374`
- `VenueScaleSettings` → `schema.prisma:L15762`
- `VenueSettings` → `schema.prisma:L846`
- `VenueTenderType` → `schema.prisma:L4501`
- `VenueTenderTypeRevision` → `schema.prisma:L4566`
- `VenueTransaction` → `schema.prisma:L4693`
- `VenueWhatsappActivation` → `schema.prisma:L697`
- `WalletCardDesign` → `schema.prisma:L7907`
- `WalletPass` → `schema.prisma:L7808`
- `WalletPassRegistration` → `schema.prisma:L7874`
- `WebhookEvent` → `schema.prisma:L4838`
- `WebhookSubscription` → `schema.prisma:L6249`
- `WhatsappContactWindow` → `schema.prisma:L715`
- `WhatsappInboundEvent` → `schema.prisma:L735`
- `WorkShiftAssignment` → `schema.prisma:L3501`
- `WorkShiftTemplate` → `schema.prisma:L3478`
- `Zone` → `schema.prisma:L150`
