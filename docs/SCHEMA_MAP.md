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

- `AccountingPeriodLock` → `schema.prisma:L16827`
- `AccountMapping` → `schema.prisma:L16722`
- `ActivityLog` → `schema.prisma:L7221`
- `Aggregator` → `schema.prisma:L15017`
- `AngelPayUserAccount` → `schema.prisma:L5766`
- `AppUpdate` → `schema.prisma:L13182`
- `Area` → `schema.prisma:L3225`
- `AreaTicket` → `schema.prisma:L15535`
- `AreaTicketCheckoutSession` → `schema.prisma:L15657`
- `AreaTicketExternalIncident` → `schema.prisma:L15904`
- `AreaTicketExternalSettlement` → `schema.prisma:L15869`
- `AreaTicketFulfillment` → `schema.prisma:L15733`
- `AreaTicketInventoryReservation` → `schema.prisma:L15628`
- `AreaTicketLine` → `schema.prisma:L15596`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15689`
- `AreaTicketPrintAttempt` → `schema.prisma:L15712`
- `BankStatement` → `schema.prisma:L16596`
- `BankStatementLine` → `schema.prisma:L16617`
- `BillingObligationConflict` → `schema.prisma:L4803`
- `BillingTaxProfile` → `schema.prisma:L17419`
- `BirthdayAutomation` → `schema.prisma:L7542`
- `BulkCommandOperation` → `schema.prisma:L10462`
- `CalendarSyncOutbox` → `schema.prisma:L14389`
- `CampaignDelivery` → `schema.prisma:L13340`
- `CashCloseout` → `schema.prisma:L10847`
- `CashDeposit` → `schema.prisma:L12984`
- `CashDrawerEvent` → `schema.prisma:L14854`
- `CashDrawerSession` → `schema.prisma:L14815`
- `CashOutCommissionRate` → `schema.prisma:L17236`
- `CashOutScheduleDay` → `schema.prisma:L17259`
- `CashOutWithdrawal` → `schema.prisma:L17321`
- `CatalogBindingBatch` → `schema.prisma:L11878`
- `CatalogBindingLine` → `schema.prisma:L11914`
- `CatalogBrand` → `schema.prisma:L11331`
- `CatalogClientObservation` → `schema.prisma:L11644`
- `CatalogClientReadinessOverride` → `schema.prisma:L11663`
- `CatalogFamily` → `schema.prisma:L11381`
- `CatalogIdempotencyRecord` → `schema.prisma:L11777`
- `CatalogIdentifier` → `schema.prisma:L11512`
- `CatalogImportBatch` → `schema.prisma:L11820`
- `CatalogImportLine` → `schema.prisma:L11857`
- `CatalogItem` → `schema.prisma:L11414`
- `CatalogItemBusinessType` → `schema.prisma:L11474`
- `CatalogItemPrice` → `schema.prisma:L11562`
- `CatalogManufacturer` → `schema.prisma:L11355`
- `CatalogProductTypeMapping` → `schema.prisma:L11491`
- `CatalogPublicationBatch` → `schema.prisma:L11942`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12036`
- `CatalogPublicationLine` → `schema.prisma:L11983`
- `CatalogPublicationOutbox` → `schema.prisma:L12079`
- `CatalogValidationProfile` → `schema.prisma:L11533`
- `CatalogVenueBinding` → `schema.prisma:L11691`
- `CatalogVenueClientRequirement` → `schema.prisma:L11618`
- `CatalogVenueEventSequence` → `schema.prisma:L12062`
- `CatalogVenueOverride` → `schema.prisma:L11733`
- `CatalogVenueRollout` → `schema.prisma:L11593`
- `Cfdi` → `schema.prisma:L16424`
- `CfdiGlobalOrden` → `schema.prisma:L16549`
- `ChatbotTokenBudget` → `schema.prisma:L10110`
- `ChatConversation` → `schema.prisma:L9965`
- `ChatFeedback` → `schema.prisma:L10051`
- `ChatLearningEvent` → `schema.prisma:L10008`
- `ChatMessage` → `schema.prisma:L9988`
- `ChatTrainingData` → `schema.prisma:L9922`
- `CheckoutSession` → `schema.prisma:L6046`
- `ClassSession` → `schema.prisma:L13993`
- `CommissionCalculation` → `schema.prisma:L12760`
- `CommissionClawback` → `schema.prisma:L12936`
- `CommissionConfig` → `schema.prisma:L12526`
- `CommissionMilestone` → `schema.prisma:L12676`
- `CommissionOverride` → `schema.prisma:L12603`
- `CommissionPayout` → `schema.prisma:L12887`
- `CommissionSummary` → `schema.prisma:L12826`
- `CommissionTier` → `schema.prisma:L12640`
- `ConsentEvent` → `schema.prisma:L7404`
- `Consumer` → `schema.prisma:L7634`
- `ConsumerAuthAccount` → `schema.prisma:L7659`
- `CouponCode` → `schema.prisma:L8606`
- `CouponRedemption` → `schema.prisma:L8637`
- `CreditAssessmentHistory` → `schema.prisma:L10956`
- `CreditItemBalance` → `schema.prisma:L14605`
- `CreditOffer` → `schema.prisma:L10975`
- `CreditPack` → `schema.prisma:L14514`
- `CreditPackItem` → `schema.prisma:L14543`
- `CreditPackPurchase` → `schema.prisma:L14560`
- `CreditTransaction` → `schema.prisma:L14627`
- `Customer` → `schema.prisma:L7262`
- `CustomerApprovalDelivery` → `schema.prisma:L9624`
- `CustomerApprovalOutbox` → `schema.prisma:L9599`
- `CustomerCampaign` → `schema.prisma:L7492`
- `CustomerCampaignDelivery` → `schema.prisma:L7574`
- `CustomerCaptureToken` → `schema.prisma:L7440`
- `CustomerDiscount` → `schema.prisma:L8657`
- `CustomerGroup` → `schema.prisma:L7698`
- `CustomerOrderMetric` → `schema.prisma:L4019`
- `CustomerTaxProfile` → `schema.prisma:L16568`
- `DeliveryActivationRequest` → `schema.prisma:L6505`
- `DeliveryChannelLink` → `schema.prisma:L6344`
- `DeliveryConnectIntent` → `schema.prisma:L6456`
- `DeliveryLineAction` → `schema.prisma:L6417`
- `DeliveryOrderEvent` → `schema.prisma:L6529`
- `DeliveryStoreRevocation` → `schema.prisma:L6493`
- `DeviceToken` → `schema.prisma:L8926`
- `DigitalReceipt` → `schema.prisma:L4612`
- `Discount` → `schema.prisma:L8296`
- `EcommerceMerchant` → `schema.prisma:L5858`
- `EmailQuotaLedger` → `schema.prisma:L7621`
- `EmailSuppression` → `schema.prisma:L7609`
- `EmailTemplate` → `schema.prisma:L13279`
- `Employee` → `schema.prisma:L17084`
- `Estimate` → `schema.prisma:L14924`
- `EstimateItem` → `schema.prisma:L14952`
- `Expense` → `schema.prisma:L16871`
- `ExternalBusyBlock` → `schema.prisma:L14282`
- `Feature` → `schema.prisma:L4741`
- `FeeSchedule` → `schema.prisma:L4865`
- `FeeTier` → `schema.prisma:L4876`
- `FinancialAccount` → `schema.prisma:L15114`
- `FinancialConnection` → `schema.prisma:L15083`
- `FinancialProvider` → `schema.prisma:L15069`
- `FiscalEmisor` → `schema.prisma:L16340`
- `FiscalLossCarryforward` → `schema.prisma:L16994`
- `FixedAsset` → `schema.prisma:L17012`
- `FixedAssetDepreciation` → `schema.prisma:L17041`
- `FloorElement` → `schema.prisma:L3301`
- `FulfillmentArea` → `schema.prisma:L15400`
- `GeofenceRule` → `schema.prisma:L10547`
- `GoogleCalendarChannel` → `schema.prisma:L14259`
- `GoogleCalendarConnection` → `schema.prisma:L14211`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14312`
- `GoogleOAuthSession` → `schema.prisma:L14334`
- `HolidayCalendar` → `schema.prisma:L7145`
- `IdempotencyRequest` → `schema.prisma:L12401`
- `InterVenueTransfer` → `schema.prisma:L3053`
- `InterVenueTransferAllocation` → `schema.prisma:L3136`
- `InterVenueTransferItem` → `schema.prisma:L3105`
- `InterVenueTransferReceipt` → `schema.prisma:L3163`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3179`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3207`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3191`
- `Inventory` → `schema.prisma:L1997`
- `InventoryMovement` → `schema.prisma:L2097`
- `InventoryPosting` → `schema.prisma:L2192`
- `InventoryPostingLine` → `schema.prisma:L2232`
- `InventoryTransfer` → `schema.prisma:L14896`
- `InventoryWasteReport` → `schema.prisma:L2052`
- `Invitation` → `schema.prisma:L1494`
- `Invoice` → `schema.prisma:L4888`
- `InvoiceItem` → `schema.prisma:L4914`
- `ItemCategory` → `schema.prisma:L12114`
- `JournalEntry` → `schema.prisma:L16780`
- `JournalLine` → `schema.prisma:L16809`
- `KdsOrder` → `schema.prisma:L15162`
- `KdsOrderItem` → `schema.prisma:L15211`
- `KioskCheckInAttempt` → `schema.prisma:L17742`
- `KioskCheckInChallenge` → `schema.prisma:L17696`
- `KioskOutreachOutbox` → `schema.prisma:L17763`
- `LaunchCampaign` → `schema.prisma:L18101`
- `LaunchCampaignRedemption` → `schema.prisma:L18218`
- `LearnedPatterns` → `schema.prisma:L10032`
- `LedgerAccount` → `schema.prisma:L16672`
- `LiveDemoSession` → `schema.prisma:L830`
- `LowStockAlert` → `schema.prisma:L2887`
- `LoyaltyConfig` → `schema.prisma:L7728`
- `LoyaltyTransaction` → `schema.prisma:L7771`
- `MarketingCampaign` → `schema.prisma:L13297`
- `McpAuthCode` → `schema.prisma:L16223`
- `McpOAuthClient` → `schema.prisma:L16207`
- `McpRefreshToken` → `schema.prisma:L16241`
- `McpToolCall` → `schema.prisma:L16262`
- `MeasurementUnit` → `schema.prisma:L15002`
- `Menu` → `schema.prisma:L1712`
- `MenuCategory` → `schema.prisma:L1649`
- `MenuCategoryAssignment` → `schema.prisma:L1747`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16137`
- `MerchantAccount` → `schema.prisma:L5596`
- `MerchantFiscalConfig` → `schema.prisma:L16395`
- `MerchantRevenueShare` → `schema.prisma:L6725`
- `MerchantRoutingRule` → `schema.prisma:L5718`
- `MilestoneAchievement` → `schema.prisma:L12721`
- `Modifier` → `schema.prisma:L4218`
- `ModifierGroup` → `schema.prisma:L4182`
- `Module` → `schema.prisma:L11023`
- `MoneyAnomaly` → `schema.prisma:L6628`
- `MonthlyVenueProfit` → `schema.prisma:L7171`
- `Notification` → `schema.prisma:L8828`
- `NotificationPreference` → `schema.prisma:L8875`
- `NotificationTemplate` → `schema.prisma:L8902`
- `OAuthState` → `schema.prisma:L1545`
- `OnboardingProgress` → `schema.prisma:L1563`
- `Order` → `schema.prisma:L3750`
- `OrderAction` → `schema.prisma:L4285`
- `OrderCustomer` → `schema.prisma:L3998`
- `OrderDiscount` → `schema.prisma:L8689`
- `OrderFulfillment` → `schema.prisma:L15455`
- `OrderFulfillmentLine` → `schema.prisma:L15486`
- `OrderItem` → `schema.prisma:L4034`
- `OrderItemModifier` → `schema.prisma:L4267`
- `OrderItemSelloIva` → `schema.prisma:L16529`
- `OrderPromotion` → `schema.prisma:L17659`
- `OrderServiceCharge` → `schema.prisma:L8773`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13098`
- `OrganizationEntitlement` → `schema.prisma:L11306`
- `OrganizationGoal` → `schema.prisma:L13056`
- `OrganizationModule` → `schema.prisma:L11083`
- `OrganizationPaymentConfig` → `schema.prisma:L6170`
- `OrganizationPayoutConfig` → `schema.prisma:L13131`
- `OrganizationPricingStructure` → `schema.prisma:L6202`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13079`
- `OtpChallenge` → `schema.prisma:L7678`
- `OvertimeApproval` → `schema.prisma:L3528`
- `PartnerAPIKey` → `schema.prisma:L6000`
- `Payment` → `schema.prisma:L4318`
- `PaymentAllocation` → `schema.prisma:L4591`
- `PaymentEffect` → `schema.prisma:L18033`
- `PaymentLink` → `schema.prisma:L14673`
- `PaymentLinkAttribution` → `schema.prisma:L14781`
- `PaymentLinkItem` → `schema.prisma:L14736`
- `PaymentLinkItemModifier` → `schema.prisma:L14763`
- `PaymentProvider` → `schema.prisma:L5555`
- `PayrollLine` → `schema.prisma:L17155`
- `PayrollRun` → `schema.prisma:L17124`
- `PerformanceGoal` → `schema.prisma:L13033`
- `PermissionOverride` → `schema.prisma:L1418`
- `PermissionSet` → `schema.prisma:L1441`
- `PlatformAnnouncement` → `schema.prisma:L17823`
- `PlatformAnnouncementClick` → `schema.prisma:L17888`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17925`
- `PlatformCfdi` → `schema.prisma:L17452`
- `PlatformEmisor` → `schema.prisma:L17392`
- `PlatformSettings` → `schema.prisma:L5977`
- `PosCommand` → `schema.prisma:L8956`
- `PosConnectionStatus` → `schema.prisma:L964`
- `PosSyncIntent` → `schema.prisma:L17530`
- `PricingPolicy` → `schema.prisma:L2783`
- `Printer` → `schema.prisma:L15260`
- `PrintGateway` → `schema.prisma:L15317`
- `PrintJob` → `schema.prisma:L16036`
- `PrintStation` → `schema.prisma:L15335`
- `PrivacyNoticeVersion` → `schema.prisma:L7426`
- `ProcessedStripeEvent` → `schema.prisma:L6614`
- `ProcessorReliabilityMetric` → `schema.prisma:L7099`
- `Product` → `schema.prisma:L1765`
- `ProductModifierGroup` → `schema.prisma:L4255`
- `ProductOption` → `schema.prisma:L14979`
- `ProductOptionValue` → `schema.prisma:L14990`
- `ProductStaff` → `schema.prisma:L13908`
- `PromoterBankAccount` → `schema.prisma:L17275`
- `PromoterCommissionEntry` → `schema.prisma:L17294`
- `PromoterLocationPing` → `schema.prisma:L3716`
- `Promotion` → `schema.prisma:L17581`
- `PromotionGroup` → `schema.prisma:L17620`
- `PromotionOption` → `schema.prisma:L17636`
- `ProviderCostStructure` → `schema.prisma:L6650`
- `ProviderEventLog` → `schema.prisma:L6279`
- `PurchaseOrder` → `schema.prisma:L2508`
- `PurchaseOrderInvoice` → `schema.prisma:L2653`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2710`
- `PurchaseOrderItem` → `schema.prisma:L2566`
- `RateCorrectionBatch` → `schema.prisma:L6875`
- `RateCorrectionEntry` → `schema.prisma:L6917`
- `RawMaterial` → `schema.prisma:L2264`
- `RawMaterialMovement` → `schema.prisma:L2836`
- `RawMaterialPresentation` → `schema.prisma:L2340`
- `ReceiptLayout` → `schema.prisma:L18067`
- `Recipe` → `schema.prisma:L2360`
- `RecipeLine` → `schema.prisma:L2384`
- `Referral` → `schema.prisma:L8144`
- `ReferralProgramConfig` → `schema.prisma:L8109`
- `ReferralRewardGrant` → `schema.prisma:L8235`
- `ReferralTierReward` → `schema.prisma:L8207`
- `ReferralTierUnlock` → `schema.prisma:L8280`
- `RefreshGrant` → `schema.prisma:L18012`
- `Reservation` → `schema.prisma:L13676`
- `ReservationGoogleEventMapping` → `schema.prisma:L14446`
- `ReservationModifier` → `schema.prisma:L13856`
- `ReservationReminderSent` → `schema.prisma:L13839`
- `ReservationSettings` → `schema.prisma:L14070`
- `ReservationWaitlistEntry` → `schema.prisma:L14038`
- `Review` → `schema.prisma:L4932`
- `SalesRetention` → `schema.prisma:L16975`
- `SaleVerification` → `schema.prisma:L4645`
- `ScaleProfile` → `schema.prisma:L15777`
- `ScheduledCommand` → `schema.prisma:L10507`
- `SerializedItem` → `schema.prisma:L12157`
- `SerializedItemCustodyEvent` → `schema.prisma:L12324`
- `ServiceCharge` → `schema.prisma:L8744`
- `Session` → `schema.prisma:L17991`
- `SettlementConfiguration` → `schema.prisma:L6950`
- `SettlementConfirmation` → `schema.prisma:L7063`
- `SettlementIncident` → `schema.prisma:L7014`
- `SettlementSimulation` → `schema.prisma:L6985`
- `Shift` → `schema.prisma:L3339`
- `SimRegistrationRequest` → `schema.prisma:L12362`
- `SimRegistrationRequestItem` → `schema.prisma:L12384`
- `SlotHold` → `schema.prisma:L13939`
- `Staff` → `schema.prisma:L984`
- `StaffDocument` → `schema.prisma:L3587`
- `StaffOnboardingState` → `schema.prisma:L16107`
- `StaffOrganization` → `schema.prisma:L1317`
- `StaffPasskey` → `schema.prisma:L1344`
- `StaffSchedule` → `schema.prisma:L13879`
- `StaffScheduleException` → `schema.prisma:L13891`
- `StaffVenue` → `schema.prisma:L1241`
- `StaffWorkSchedule` → `schema.prisma:L3464`
- `StaffWorkScheduleException` → `schema.prisma:L3562`
- `StampCard` → `schema.prisma:L7992`
- `StampEvent` → `schema.prisma:L8031`
- `StampReward` → `schema.prisma:L8069`
- `StockAlertConfig` → `schema.prisma:L13015`
- `StockBatch` → `schema.prisma:L3002`
- `StockCount` → `schema.prisma:L2919`
- `StockCountItem` → `schema.prisma:L2947`
- `StripeWebhookEvent` → `schema.prisma:L6597`
- `Supplier` → `schema.prisma:L2419`
- `SupplierItemCode` → `schema.prisma:L2751`
- `SupplierPricing` → `schema.prisma:L2474`
- `Table` → `schema.prisma:L3251`
- `Terminal` → `schema.prisma:L4983`
- `TerminalAttemptResolution` → `schema.prisma:L5414`
- `TerminalHealth` → `schema.prisma:L5234`
- `TerminalLog` → `schema.prisma:L5208`
- `TerminalOrder` → `schema.prisma:L5458`
- `TerminalOrderItem` → `schema.prisma:L5533`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5386`
- `TerminalPaymentRequest` → `schema.prisma:L5305`
- `TimeEntry` → `schema.prisma:L3629`
- `TimeEntryBreak` → `schema.prisma:L3698`
- `TokenPurchase` → `schema.prisma:L10181`
- `TokenUsageRecord` → `schema.prisma:L10153`
- `TpvCommandHistory` → `schema.prisma:L10413`
- `TpvCommandQueue` → `schema.prisma:L10353`
- `TpvFeedback` → `schema.prisma:L10066`
- `TpvMessage` → `schema.prisma:L13372`
- `TpvMessageDelivery` → `schema.prisma:L13424`
- `TpvMessageResponse` → `schema.prisma:L13447`
- `TrainingModule` → `schema.prisma:L13502`
- `TrainingProgress` → `schema.prisma:L13579`
- `TrainingQuizQuestion` → `schema.prisma:L13561`
- `TrainingStep` → `schema.prisma:L13541`
- `TransactionCost` → `schema.prisma:L6813`
- `UnitConversion` → `schema.prisma:L2814`
- `UpsellAcceptance` → `schema.prisma:L8565`
- `UpsellAiRun` → `schema.prisma:L8585`
- `UpsellImpression` → `schema.prisma:L8525`
- `UpsellRule` → `schema.prisma:L8445`
- `user_sessions` → `schema.prisma:L6035`
- `Venue` → `schema.prisma:L167`
- `VenueAreaTicketSettings` → `schema.prisma:L15514`
- `VenueChatMessage` → `schema.prisma:L806`
- `VenueChatSession` → `schema.prisma:L761`
- `VenueCommission` → `schema.prisma:L15140`
- `VenueCreditAssessment` → `schema.prisma:L10895`
- `VenueCryptoConfig` → `schema.prisma:L13239`
- `VenueFeature` → `schema.prisma:L4759`
- `VenueIvaPorProducto` → `schema.prisma:L957`
- `VenueModule` → `schema.prisma:L11055`
- `VenuePaymentConfig` → `schema.prisma:L6136`
- `VenuePaymentLinkSettings` → `schema.prisma:L14479`
- `VenuePricingStructure` → `schema.prisma:L6753`
- `VenueRoleConfig` → `schema.prisma:L1470`
- `VenueRolePermission` → `schema.prisma:L1374`
- `VenueScaleSettings` → `schema.prisma:L15765`
- `VenueSettings` → `schema.prisma:L846`
- `VenueTenderType` → `schema.prisma:L4504`
- `VenueTenderTypeRevision` → `schema.prisma:L4569`
- `VenueTransaction` → `schema.prisma:L4696`
- `VenueWhatsappActivation` → `schema.prisma:L697`
- `WalletCardDesign` → `schema.prisma:L7910`
- `WalletPass` → `schema.prisma:L7811`
- `WalletPassRegistration` → `schema.prisma:L7877`
- `WebhookEvent` → `schema.prisma:L4841`
- `WebhookSubscription` → `schema.prisma:L6252`
- `WhatsappContactWindow` → `schema.prisma:L715`
- `WhatsappInboundEvent` → `schema.prisma:L735`
- `WorkShiftAssignment` → `schema.prisma:L3504`
- `WorkShiftTemplate` → `schema.prisma:L3481`
- `Zone` → `schema.prisma:L150`
