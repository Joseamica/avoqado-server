# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **370 models / 352 enums / ~17,700 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L16364`
- `AccountMapping` → `schema.prisma:L16260`
- `ActivityLog` → `schema.prisma:L6867`
- `Aggregator` → `schema.prisma:L14657`
- `AngelPayUserAccount` → `schema.prisma:L5518`
- `AppUpdate` → `schema.prisma:L12822`
- `Area` → `schema.prisma:L3105`
- `AreaTicket` → `schema.prisma:L15155`
- `AreaTicketCheckoutSession` → `schema.prisma:L15277`
- `AreaTicketExternalIncident` → `schema.prisma:L15524`
- `AreaTicketExternalSettlement` → `schema.prisma:L15489`
- `AreaTicketFulfillment` → `schema.prisma:L15353`
- `AreaTicketInventoryReservation` → `schema.prisma:L15248`
- `AreaTicketLine` → `schema.prisma:L15216`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15309`
- `AreaTicketPrintAttempt` → `schema.prisma:L15332`
- `BankStatement` → `schema.prisma:L16134`
- `BankStatementLine` → `schema.prisma:L16155`
- `BillingTaxProfile` → `schema.prisma:L16944`
- `BirthdayAutomation` → `schema.prisma:L7188`
- `BulkCommandOperation` → `schema.prisma:L10102`
- `CalendarSyncOutbox` → `schema.prisma:L14029`
- `CampaignDelivery` → `schema.prisma:L12980`
- `CashCloseout` → `schema.prisma:L10487`
- `CashDeposit` → `schema.prisma:L12624`
- `CashDrawerEvent` → `schema.prisma:L14494`
- `CashDrawerSession` → `schema.prisma:L14455`
- `CashOutCommissionRate` → `schema.prisma:L16773`
- `CashOutScheduleDay` → `schema.prisma:L16796`
- `CashOutWithdrawal` → `schema.prisma:L16858`
- `CatalogBindingBatch` → `schema.prisma:L11518`
- `CatalogBindingLine` → `schema.prisma:L11554`
- `CatalogBrand` → `schema.prisma:L10971`
- `CatalogClientObservation` → `schema.prisma:L11284`
- `CatalogClientReadinessOverride` → `schema.prisma:L11303`
- `CatalogFamily` → `schema.prisma:L11021`
- `CatalogIdempotencyRecord` → `schema.prisma:L11417`
- `CatalogIdentifier` → `schema.prisma:L11152`
- `CatalogImportBatch` → `schema.prisma:L11460`
- `CatalogImportLine` → `schema.prisma:L11497`
- `CatalogItem` → `schema.prisma:L11054`
- `CatalogItemBusinessType` → `schema.prisma:L11114`
- `CatalogItemPrice` → `schema.prisma:L11202`
- `CatalogManufacturer` → `schema.prisma:L10995`
- `CatalogProductTypeMapping` → `schema.prisma:L11131`
- `CatalogPublicationBatch` → `schema.prisma:L11582`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11676`
- `CatalogPublicationLine` → `schema.prisma:L11623`
- `CatalogPublicationOutbox` → `schema.prisma:L11719`
- `CatalogValidationProfile` → `schema.prisma:L11173`
- `CatalogVenueBinding` → `schema.prisma:L11331`
- `CatalogVenueClientRequirement` → `schema.prisma:L11258`
- `CatalogVenueEventSequence` → `schema.prisma:L11702`
- `CatalogVenueOverride` → `schema.prisma:L11373`
- `CatalogVenueRollout` → `schema.prisma:L11233`
- `Cfdi` → `schema.prisma:L16037`
- `ChatbotTokenBudget` → `schema.prisma:L9750`
- `ChatConversation` → `schema.prisma:L9605`
- `ChatFeedback` → `schema.prisma:L9691`
- `ChatLearningEvent` → `schema.prisma:L9648`
- `ChatMessage` → `schema.prisma:L9628`
- `ChatTrainingData` → `schema.prisma:L9562`
- `CheckoutSession` → `schema.prisma:L5798`
- `ClassSession` → `schema.prisma:L13633`
- `CommissionCalculation` → `schema.prisma:L12400`
- `CommissionClawback` → `schema.prisma:L12576`
- `CommissionConfig` → `schema.prisma:L12166`
- `CommissionMilestone` → `schema.prisma:L12316`
- `CommissionOverride` → `schema.prisma:L12243`
- `CommissionPayout` → `schema.prisma:L12527`
- `CommissionSummary` → `schema.prisma:L12466`
- `CommissionTier` → `schema.prisma:L12280`
- `ConsentEvent` → `schema.prisma:L7050`
- `Consumer` → `schema.prisma:L7280`
- `ConsumerAuthAccount` → `schema.prisma:L7305`
- `CouponCode` → `schema.prisma:L8252`
- `CouponRedemption` → `schema.prisma:L8283`
- `CreditAssessmentHistory` → `schema.prisma:L10596`
- `CreditItemBalance` → `schema.prisma:L14245`
- `CreditOffer` → `schema.prisma:L10615`
- `CreditPack` → `schema.prisma:L14154`
- `CreditPackItem` → `schema.prisma:L14183`
- `CreditPackPurchase` → `schema.prisma:L14200`
- `CreditTransaction` → `schema.prisma:L14267`
- `Customer` → `schema.prisma:L6908`
- `CustomerApprovalDelivery` → `schema.prisma:L9264`
- `CustomerApprovalOutbox` → `schema.prisma:L9239`
- `CustomerCampaign` → `schema.prisma:L7138`
- `CustomerCampaignDelivery` → `schema.prisma:L7220`
- `CustomerCaptureToken` → `schema.prisma:L7086`
- `CustomerDiscount` → `schema.prisma:L8303`
- `CustomerGroup` → `schema.prisma:L7344`
- `CustomerOrderMetric` → `schema.prisma:L3876`
- `CustomerTaxProfile` → `schema.prisma:L16106`
- `DeliveryActivationRequest` → `schema.prisma:L6151`
- `DeliveryChannelLink` → `schema.prisma:L6096`
- `DeliveryOrderEvent` → `schema.prisma:L6175`
- `DeviceToken` → `schema.prisma:L8572`
- `DigitalReceipt` → `schema.prisma:L4454`
- `Discount` → `schema.prisma:L7942`
- `EcommerceMerchant` → `schema.prisma:L5610`
- `EmailQuotaLedger` → `schema.prisma:L7267`
- `EmailSuppression` → `schema.prisma:L7255`
- `EmailTemplate` → `schema.prisma:L12919`
- `Employee` → `schema.prisma:L16621`
- `Estimate` → `schema.prisma:L14564`
- `EstimateItem` → `schema.prisma:L14592`
- `Expense` → `schema.prisma:L16408`
- `ExternalBusyBlock` → `schema.prisma:L13922`
- `Feature` → `schema.prisma:L4583`
- `FeeSchedule` → `schema.prisma:L4661`
- `FeeTier` → `schema.prisma:L4672`
- `FinancialAccount` → `schema.prisma:L14754`
- `FinancialConnection` → `schema.prisma:L14723`
- `FinancialProvider` → `schema.prisma:L14709`
- `FiscalEmisor` → `schema.prisma:L15960`
- `FiscalLossCarryforward` → `schema.prisma:L16531`
- `FixedAsset` → `schema.prisma:L16549`
- `FixedAssetDepreciation` → `schema.prisma:L16578`
- `FloorElement` → `schema.prisma:L3181`
- `FulfillmentArea` → `schema.prisma:L15020`
- `GeofenceRule` → `schema.prisma:L10187`
- `GoogleCalendarChannel` → `schema.prisma:L13899`
- `GoogleCalendarConnection` → `schema.prisma:L13851`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13952`
- `GoogleOAuthSession` → `schema.prisma:L13974`
- `HolidayCalendar` → `schema.prisma:L6791`
- `IdempotencyRequest` → `schema.prisma:L12041`
- `InterVenueTransfer` → `schema.prisma:L2933`
- `InterVenueTransferAllocation` → `schema.prisma:L3016`
- `InterVenueTransferItem` → `schema.prisma:L2985`
- `InterVenueTransferReceipt` → `schema.prisma:L3043`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3059`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3087`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3071`
- `Inventory` → `schema.prisma:L1972`
- `InventoryMovement` → `schema.prisma:L1999`
- `InventoryPosting` → `schema.prisma:L2081`
- `InventoryPostingLine` → `schema.prisma:L2121`
- `InventoryTransfer` → `schema.prisma:L14536`
- `Invitation` → `schema.prisma:L1476`
- `Invoice` → `schema.prisma:L4684`
- `InvoiceItem` → `schema.prisma:L4710`
- `ItemCategory` → `schema.prisma:L11754`
- `JournalEntry` → `schema.prisma:L16318`
- `JournalLine` → `schema.prisma:L16346`
- `KdsOrder` → `schema.prisma:L14802`
- `KdsOrderItem` → `schema.prisma:L14843`
- `KioskCheckInAttempt` → `schema.prisma:L17267`
- `KioskCheckInChallenge` → `schema.prisma:L17221`
- `KioskOutreachOutbox` → `schema.prisma:L17288`
- `LaunchCampaign` → `schema.prisma:L17625`
- `LaunchCampaignRedemption` → `schema.prisma:L17743`
- `LearnedPatterns` → `schema.prisma:L9672`
- `LedgerAccount` → `schema.prisma:L16210`
- `LiveDemoSession` → `schema.prisma:L821`
- `LowStockAlert` → `schema.prisma:L2767`
- `LoyaltyConfig` → `schema.prisma:L7374`
- `LoyaltyTransaction` → `schema.prisma:L7417`
- `MarketingCampaign` → `schema.prisma:L12937`
- `McpAuthCode` → `schema.prisma:L15843`
- `McpOAuthClient` → `schema.prisma:L15827`
- `McpRefreshToken` → `schema.prisma:L15861`
- `McpToolCall` → `schema.prisma:L15882`
- `MeasurementUnit` → `schema.prisma:L14642`
- `Menu` → `schema.prisma:L1696`
- `MenuCategory` → `schema.prisma:L1633`
- `MenuCategoryAssignment` → `schema.prisma:L1731`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15757`
- `MerchantAccount` → `schema.prisma:L5348`
- `MerchantFiscalConfig` → `schema.prisma:L16008`
- `MerchantRevenueShare` → `schema.prisma:L6371`
- `MerchantRoutingRule` → `schema.prisma:L5470`
- `MilestoneAchievement` → `schema.prisma:L12361`
- `Modifier` → `schema.prisma:L4060`
- `ModifierGroup` → `schema.prisma:L4024`
- `Module` → `schema.prisma:L10663`
- `MoneyAnomaly` → `schema.prisma:L6274`
- `MonthlyVenueProfit` → `schema.prisma:L6817`
- `Notification` → `schema.prisma:L8474`
- `NotificationPreference` → `schema.prisma:L8521`
- `NotificationTemplate` → `schema.prisma:L8548`
- `OAuthState` → `schema.prisma:L1527`
- `OnboardingProgress` → `schema.prisma:L1545`
- `Order` → `schema.prisma:L3630`
- `OrderAction` → `schema.prisma:L4127`
- `OrderCustomer` → `schema.prisma:L3855`
- `OrderDiscount` → `schema.prisma:L8335`
- `OrderFulfillment` → `schema.prisma:L15075`
- `OrderFulfillmentLine` → `schema.prisma:L15106`
- `OrderItem` → `schema.prisma:L3891`
- `OrderItemModifier` → `schema.prisma:L4109`
- `OrderPromotion` → `schema.prisma:L17184`
- `OrderServiceCharge` → `schema.prisma:L8419`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12738`
- `OrganizationEntitlement` → `schema.prisma:L10946`
- `OrganizationGoal` → `schema.prisma:L12696`
- `OrganizationModule` → `schema.prisma:L10723`
- `OrganizationPaymentConfig` → `schema.prisma:L5922`
- `OrganizationPayoutConfig` → `schema.prisma:L12771`
- `OrganizationPricingStructure` → `schema.prisma:L5954`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12719`
- `OtpChallenge` → `schema.prisma:L7324`
- `OvertimeApproval` → `schema.prisma:L3408`
- `PartnerAPIKey` → `schema.prisma:L5752`
- `Payment` → `schema.prisma:L4160`
- `PaymentAllocation` → `schema.prisma:L4433`
- `PaymentEffect` → `schema.prisma:L17558`
- `PaymentLink` → `schema.prisma:L14313`
- `PaymentLinkAttribution` → `schema.prisma:L14421`
- `PaymentLinkItem` → `schema.prisma:L14376`
- `PaymentLinkItemModifier` → `schema.prisma:L14403`
- `PaymentProvider` → `schema.prisma:L5307`
- `PayrollLine` → `schema.prisma:L16692`
- `PayrollRun` → `schema.prisma:L16661`
- `PerformanceGoal` → `schema.prisma:L12673`
- `PermissionOverride` → `schema.prisma:L1400`
- `PermissionSet` → `schema.prisma:L1423`
- `PlatformAnnouncement` → `schema.prisma:L17348`
- `PlatformAnnouncementClick` → `schema.prisma:L17413`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17450`
- `PlatformCfdi` → `schema.prisma:L16977`
- `PlatformEmisor` → `schema.prisma:L16917`
- `PlatformSettings` → `schema.prisma:L5729`
- `PosCommand` → `schema.prisma:L8602`
- `PosConnectionStatus` → `schema.prisma:L947`
- `PosSyncIntent` → `schema.prisma:L17055`
- `PricingPolicy` → `schema.prisma:L2671`
- `Printer` → `schema.prisma:L14885`
- `PrintGateway` → `schema.prisma:L14942`
- `PrintJob` → `schema.prisma:L15656`
- `PrintStation` → `schema.prisma:L14960`
- `PrivacyNoticeVersion` → `schema.prisma:L7072`
- `ProcessedStripeEvent` → `schema.prisma:L6260`
- `ProcessorReliabilityMetric` → `schema.prisma:L6745`
- `Product` → `schema.prisma:L1749`
- `ProductModifierGroup` → `schema.prisma:L4097`
- `ProductOption` → `schema.prisma:L14619`
- `ProductOptionValue` → `schema.prisma:L14630`
- `ProductStaff` → `schema.prisma:L13548`
- `PromoterBankAccount` → `schema.prisma:L16812`
- `PromoterCommissionEntry` → `schema.prisma:L16831`
- `PromoterLocationPing` → `schema.prisma:L3596`
- `Promotion` → `schema.prisma:L17106`
- `PromotionGroup` → `schema.prisma:L17145`
- `PromotionOption` → `schema.prisma:L17161`
- `ProviderCostStructure` → `schema.prisma:L6296`
- `ProviderEventLog` → `schema.prisma:L6031`
- `PurchaseOrder` → `schema.prisma:L2396`
- `PurchaseOrderInvoice` → `schema.prisma:L2541`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2598`
- `PurchaseOrderItem` → `schema.prisma:L2454`
- `RateCorrectionBatch` → `schema.prisma:L6521`
- `RateCorrectionEntry` → `schema.prisma:L6563`
- `RawMaterial` → `schema.prisma:L2153`
- `RawMaterialMovement` → `schema.prisma:L2724`
- `RawMaterialPresentation` → `schema.prisma:L2228`
- `ReceiptLayout` → `schema.prisma:L17592`
- `Recipe` → `schema.prisma:L2248`
- `RecipeLine` → `schema.prisma:L2272`
- `Referral` → `schema.prisma:L7790`
- `ReferralProgramConfig` → `schema.prisma:L7755`
- `ReferralRewardGrant` → `schema.prisma:L7881`
- `ReferralTierReward` → `schema.prisma:L7853`
- `ReferralTierUnlock` → `schema.prisma:L7926`
- `RefreshGrant` → `schema.prisma:L17537`
- `Reservation` → `schema.prisma:L13316`
- `ReservationGoogleEventMapping` → `schema.prisma:L14086`
- `ReservationModifier` → `schema.prisma:L13496`
- `ReservationReminderSent` → `schema.prisma:L13479`
- `ReservationSettings` → `schema.prisma:L13710`
- `ReservationWaitlistEntry` → `schema.prisma:L13678`
- `Review` → `schema.prisma:L4728`
- `SalesRetention` → `schema.prisma:L16512`
- `SaleVerification` → `schema.prisma:L4487`
- `ScaleProfile` → `schema.prisma:L15397`
- `ScheduledCommand` → `schema.prisma:L10147`
- `SerializedItem` → `schema.prisma:L11797`
- `SerializedItemCustodyEvent` → `schema.prisma:L11964`
- `ServiceCharge` → `schema.prisma:L8390`
- `Session` → `schema.prisma:L17516`
- `SettlementConfiguration` → `schema.prisma:L6596`
- `SettlementConfirmation` → `schema.prisma:L6709`
- `SettlementIncident` → `schema.prisma:L6660`
- `SettlementSimulation` → `schema.prisma:L6631`
- `Shift` → `schema.prisma:L3219`
- `SimRegistrationRequest` → `schema.prisma:L12002`
- `SimRegistrationRequestItem` → `schema.prisma:L12024`
- `SlotHold` → `schema.prisma:L13579`
- `Staff` → `schema.prisma:L967`
- `StaffDocument` → `schema.prisma:L3467`
- `StaffOnboardingState` → `schema.prisma:L15727`
- `StaffOrganization` → `schema.prisma:L1299`
- `StaffPasskey` → `schema.prisma:L1326`
- `StaffSchedule` → `schema.prisma:L13519`
- `StaffScheduleException` → `schema.prisma:L13531`
- `StaffVenue` → `schema.prisma:L1223`
- `StaffWorkSchedule` → `schema.prisma:L3344`
- `StaffWorkScheduleException` → `schema.prisma:L3442`
- `StampCard` → `schema.prisma:L7638`
- `StampEvent` → `schema.prisma:L7677`
- `StampReward` → `schema.prisma:L7715`
- `StockAlertConfig` → `schema.prisma:L12655`
- `StockBatch` → `schema.prisma:L2882`
- `StockCount` → `schema.prisma:L2799`
- `StockCountItem` → `schema.prisma:L2827`
- `StripeWebhookEvent` → `schema.prisma:L6243`
- `Supplier` → `schema.prisma:L2307`
- `SupplierItemCode` → `schema.prisma:L2639`
- `SupplierPricing` → `schema.prisma:L2362`
- `Table` → `schema.prisma:L3131`
- `Terminal` → `schema.prisma:L4779`
- `TerminalHealth` → `schema.prisma:L5030`
- `TerminalLog` → `schema.prisma:L5004`
- `TerminalOrder` → `schema.prisma:L5210`
- `TerminalOrderItem` → `schema.prisma:L5285`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5163`
- `TerminalPaymentRequest` → `schema.prisma:L5101`
- `TimeEntry` → `schema.prisma:L3509`
- `TimeEntryBreak` → `schema.prisma:L3578`
- `TokenPurchase` → `schema.prisma:L9821`
- `TokenUsageRecord` → `schema.prisma:L9793`
- `TpvCommandHistory` → `schema.prisma:L10053`
- `TpvCommandQueue` → `schema.prisma:L9993`
- `TpvFeedback` → `schema.prisma:L9706`
- `TpvMessage` → `schema.prisma:L13012`
- `TpvMessageDelivery` → `schema.prisma:L13064`
- `TpvMessageResponse` → `schema.prisma:L13087`
- `TrainingModule` → `schema.prisma:L13142`
- `TrainingProgress` → `schema.prisma:L13219`
- `TrainingQuizQuestion` → `schema.prisma:L13201`
- `TrainingStep` → `schema.prisma:L13181`
- `TransactionCost` → `schema.prisma:L6459`
- `UnitConversion` → `schema.prisma:L2702`
- `UpsellAcceptance` → `schema.prisma:L8211`
- `UpsellAiRun` → `schema.prisma:L8231`
- `UpsellImpression` → `schema.prisma:L8171`
- `UpsellRule` → `schema.prisma:L8091`
- `user_sessions` → `schema.prisma:L5787`
- `Venue` → `schema.prisma:L162`
- `VenueAreaTicketSettings` → `schema.prisma:L15134`
- `VenueChatMessage` → `schema.prisma:L797`
- `VenueChatSession` → `schema.prisma:L752`
- `VenueCommission` → `schema.prisma:L14780`
- `VenueCreditAssessment` → `schema.prisma:L10535`
- `VenueCryptoConfig` → `schema.prisma:L12879`
- `VenueFeature` → `schema.prisma:L4601`
- `VenueModule` → `schema.prisma:L10695`
- `VenuePaymentConfig` → `schema.prisma:L5888`
- `VenuePaymentLinkSettings` → `schema.prisma:L14119`
- `VenuePricingStructure` → `schema.prisma:L6399`
- `VenueRoleConfig` → `schema.prisma:L1452`
- `VenueRolePermission` → `schema.prisma:L1356`
- `VenueScaleSettings` → `schema.prisma:L15385`
- `VenueSettings` → `schema.prisma:L837`
- `VenueTenderType` → `schema.prisma:L4346`
- `VenueTenderTypeRevision` → `schema.prisma:L4411`
- `VenueTransaction` → `schema.prisma:L4538`
- `VenueWhatsappActivation` → `schema.prisma:L688`
- `WalletCardDesign` → `schema.prisma:L7556`
- `WalletPass` → `schema.prisma:L7457`
- `WalletPassRegistration` → `schema.prisma:L7523`
- `WebhookEvent` → `schema.prisma:L4637`
- `WebhookSubscription` → `schema.prisma:L6004`
- `WhatsappContactWindow` → `schema.prisma:L706`
- `WhatsappInboundEvent` → `schema.prisma:L726`
- `WorkShiftAssignment` → `schema.prisma:L3384`
- `WorkShiftTemplate` → `schema.prisma:L3361`
- `Zone` → `schema.prisma:L145`
