# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **356 models / 339 enums / ~17,000 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L15859`
- `AccountMapping` → `schema.prisma:L15755`
- `ActivityLog` → `schema.prisma:L6648`
- `Aggregator` → `schema.prisma:L14156`
- `AngelPayUserAccount` → `schema.prisma:L5311`
- `AppUpdate` → `schema.prisma:L12336`
- `Area` → `schema.prisma:L3022`
- `AreaTicket` → `schema.prisma:L14650`
- `AreaTicketCheckoutSession` → `schema.prisma:L14772`
- `AreaTicketExternalIncident` → `schema.prisma:L15019`
- `AreaTicketExternalSettlement` → `schema.prisma:L14984`
- `AreaTicketFulfillment` → `schema.prisma:L14848`
- `AreaTicketInventoryReservation` → `schema.prisma:L14743`
- `AreaTicketLine` → `schema.prisma:L14711`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14804`
- `AreaTicketPrintAttempt` → `schema.prisma:L14827`
- `BankStatement` → `schema.prisma:L15629`
- `BankStatementLine` → `schema.prisma:L15650`
- `BillingTaxProfile` → `schema.prisma:L16439`
- `BulkCommandOperation` → `schema.prisma:L9619`
- `CalendarSyncOutbox` → `schema.prisma:L13543`
- `CampaignDelivery` → `schema.prisma:L12494`
- `CashCloseout` → `schema.prisma:L10004`
- `CashDeposit` → `schema.prisma:L12138`
- `CashDrawerEvent` → `schema.prisma:L13993`
- `CashDrawerSession` → `schema.prisma:L13969`
- `CashOutCommissionRate` → `schema.prisma:L16268`
- `CashOutScheduleDay` → `schema.prisma:L16291`
- `CashOutWithdrawal` → `schema.prisma:L16353`
- `CatalogBindingBatch` → `schema.prisma:L11035`
- `CatalogBindingLine` → `schema.prisma:L11071`
- `CatalogBrand` → `schema.prisma:L10488`
- `CatalogClientObservation` → `schema.prisma:L10801`
- `CatalogClientReadinessOverride` → `schema.prisma:L10820`
- `CatalogFamily` → `schema.prisma:L10538`
- `CatalogIdempotencyRecord` → `schema.prisma:L10934`
- `CatalogIdentifier` → `schema.prisma:L10669`
- `CatalogImportBatch` → `schema.prisma:L10977`
- `CatalogImportLine` → `schema.prisma:L11014`
- `CatalogItem` → `schema.prisma:L10571`
- `CatalogItemBusinessType` → `schema.prisma:L10631`
- `CatalogItemPrice` → `schema.prisma:L10719`
- `CatalogManufacturer` → `schema.prisma:L10512`
- `CatalogProductTypeMapping` → `schema.prisma:L10648`
- `CatalogPublicationBatch` → `schema.prisma:L11099`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11193`
- `CatalogPublicationLine` → `schema.prisma:L11140`
- `CatalogPublicationOutbox` → `schema.prisma:L11236`
- `CatalogValidationProfile` → `schema.prisma:L10690`
- `CatalogVenueBinding` → `schema.prisma:L10848`
- `CatalogVenueClientRequirement` → `schema.prisma:L10775`
- `CatalogVenueEventSequence` → `schema.prisma:L11219`
- `CatalogVenueOverride` → `schema.prisma:L10890`
- `CatalogVenueRollout` → `schema.prisma:L10750`
- `Cfdi` → `schema.prisma:L15532`
- `ChatbotTokenBudget` → `schema.prisma:L9267`
- `ChatConversation` → `schema.prisma:L9122`
- `ChatFeedback` → `schema.prisma:L9208`
- `ChatLearningEvent` → `schema.prisma:L9165`
- `ChatMessage` → `schema.prisma:L9145`
- `ChatTrainingData` → `schema.prisma:L9079`
- `CheckoutSession` → `schema.prisma:L5591`
- `ClassSession` → `schema.prisma:L13147`
- `CommissionCalculation` → `schema.prisma:L11914`
- `CommissionClawback` → `schema.prisma:L12090`
- `CommissionConfig` → `schema.prisma:L11680`
- `CommissionMilestone` → `schema.prisma:L11830`
- `CommissionOverride` → `schema.prisma:L11757`
- `CommissionPayout` → `schema.prisma:L12041`
- `CommissionSummary` → `schema.prisma:L11980`
- `CommissionTier` → `schema.prisma:L11794`
- `Consumer` → `schema.prisma:L6810`
- `ConsumerAuthAccount` → `schema.prisma:L6835`
- `CouponCode` → `schema.prisma:L7774`
- `CouponRedemption` → `schema.prisma:L7805`
- `CreditAssessmentHistory` → `schema.prisma:L10113`
- `CreditItemBalance` → `schema.prisma:L13759`
- `CreditOffer` → `schema.prisma:L10132`
- `CreditPack` → `schema.prisma:L13668`
- `CreditPackItem` → `schema.prisma:L13697`
- `CreditPackPurchase` → `schema.prisma:L13714`
- `CreditTransaction` → `schema.prisma:L13781`
- `Customer` → `schema.prisma:L6689`
- `CustomerApprovalDelivery` → `schema.prisma:L8781`
- `CustomerApprovalOutbox` → `schema.prisma:L8756`
- `CustomerDiscount` → `schema.prisma:L7825`
- `CustomerGroup` → `schema.prisma:L6874`
- `CustomerTaxProfile` → `schema.prisma:L15601`
- `DeliveryActivationRequest` → `schema.prisma:L5932`
- `DeliveryChannelLink` → `schema.prisma:L5877`
- `DeliveryOrderEvent` → `schema.prisma:L5956`
- `DeviceToken` → `schema.prisma:L8094`
- `DigitalReceipt` → `schema.prisma:L4306`
- `Discount` → `schema.prisma:L7464`
- `EcommerceMerchant` → `schema.prisma:L5403`
- `EmailTemplate` → `schema.prisma:L12433`
- `Employee` → `schema.prisma:L16116`
- `Estimate` → `schema.prisma:L14063`
- `EstimateItem` → `schema.prisma:L14091`
- `Expense` → `schema.prisma:L15903`
- `ExternalBusyBlock` → `schema.prisma:L13436`
- `Feature` → `schema.prisma:L4435`
- `FeeSchedule` → `schema.prisma:L4513`
- `FeeTier` → `schema.prisma:L4524`
- `FinancialAccount` → `schema.prisma:L14253`
- `FinancialConnection` → `schema.prisma:L14222`
- `FinancialProvider` → `schema.prisma:L14208`
- `FiscalEmisor` → `schema.prisma:L15455`
- `FiscalLossCarryforward` → `schema.prisma:L16026`
- `FixedAsset` → `schema.prisma:L16044`
- `FixedAssetDepreciation` → `schema.prisma:L16073`
- `FloorElement` → `schema.prisma:L3098`
- `FulfillmentArea` → `schema.prisma:L14515`
- `GeofenceRule` → `schema.prisma:L9704`
- `GoogleCalendarChannel` → `schema.prisma:L13413`
- `GoogleCalendarConnection` → `schema.prisma:L13365`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13466`
- `GoogleOAuthSession` → `schema.prisma:L13488`
- `HolidayCalendar` → `schema.prisma:L6572`
- `IdempotencyRequest` → `schema.prisma:L11555`
- `InterVenueTransfer` → `schema.prisma:L2850`
- `InterVenueTransferAllocation` → `schema.prisma:L2933`
- `InterVenueTransferItem` → `schema.prisma:L2902`
- `InterVenueTransferReceipt` → `schema.prisma:L2960`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2976`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3004`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2988`
- `Inventory` → `schema.prisma:L1896`
- `InventoryMovement` → `schema.prisma:L1923`
- `InventoryPosting` → `schema.prisma:L2005`
- `InventoryPostingLine` → `schema.prisma:L2045`
- `InventoryTransfer` → `schema.prisma:L14035`
- `Invitation` → `schema.prisma:L1434`
- `Invoice` → `schema.prisma:L4536`
- `InvoiceItem` → `schema.prisma:L4562`
- `ItemCategory` → `schema.prisma:L11271`
- `JournalEntry` → `schema.prisma:L15813`
- `JournalLine` → `schema.prisma:L15841`
- `KdsOrder` → `schema.prisma:L14301`
- `KdsOrderItem` → `schema.prisma:L14342`
- `KioskCheckInAttempt` → `schema.prisma:L16762`
- `KioskCheckInChallenge` → `schema.prisma:L16716`
- `KioskOutreachOutbox` → `schema.prisma:L16783`
- `LearnedPatterns` → `schema.prisma:L9189`
- `LedgerAccount` → `schema.prisma:L15705`
- `LiveDemoSession` → `schema.prisma:L785`
- `LowStockAlert` → `schema.prisma:L2691`
- `LoyaltyConfig` → `schema.prisma:L6904`
- `LoyaltyTransaction` → `schema.prisma:L6947`
- `MarketingCampaign` → `schema.prisma:L12451`
- `McpAuthCode` → `schema.prisma:L15338`
- `McpOAuthClient` → `schema.prisma:L15322`
- `McpRefreshToken` → `schema.prisma:L15356`
- `McpToolCall` → `schema.prisma:L15377`
- `MeasurementUnit` → `schema.prisma:L14141`
- `Menu` → `schema.prisma:L1620`
- `MenuCategory` → `schema.prisma:L1557`
- `MenuCategoryAssignment` → `schema.prisma:L1655`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15252`
- `MerchantAccount` → `schema.prisma:L5141`
- `MerchantFiscalConfig` → `schema.prisma:L15503`
- `MerchantRevenueShare` → `schema.prisma:L6152`
- `MerchantRoutingRule` → `schema.prisma:L5263`
- `MilestoneAchievement` → `schema.prisma:L11875`
- `Modifier` → `schema.prisma:L3921`
- `ModifierGroup` → `schema.prisma:L3885`
- `Module` → `schema.prisma:L10180`
- `MoneyAnomaly` → `schema.prisma:L6055`
- `MonthlyVenueProfit` → `schema.prisma:L6598`
- `Notification` → `schema.prisma:L7996`
- `NotificationPreference` → `schema.prisma:L8043`
- `NotificationTemplate` → `schema.prisma:L8070`
- `OAuthState` → `schema.prisma:L1485`
- `OnboardingProgress` → `schema.prisma:L1503`
- `Order` → `schema.prisma:L3523`
- `OrderAction` → `schema.prisma:L3986`
- `OrderCustomer` → `schema.prisma:L3736`
- `OrderDiscount` → `schema.prisma:L7857`
- `OrderFulfillment` → `schema.prisma:L14570`
- `OrderFulfillmentLine` → `schema.prisma:L14601`
- `OrderItem` → `schema.prisma:L3752`
- `OrderItemModifier` → `schema.prisma:L3970`
- `OrderPromotion` → `schema.prisma:L16679`
- `OrderServiceCharge` → `schema.prisma:L7941`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12252`
- `OrganizationEntitlement` → `schema.prisma:L10463`
- `OrganizationGoal` → `schema.prisma:L12210`
- `OrganizationModule` → `schema.prisma:L10240`
- `OrganizationPaymentConfig` → `schema.prisma:L5715`
- `OrganizationPayoutConfig` → `schema.prisma:L12285`
- `OrganizationPricingStructure` → `schema.prisma:L5747`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12233`
- `OtpChallenge` → `schema.prisma:L6854`
- `OvertimeApproval` → `schema.prisma:L3307`
- `PartnerAPIKey` → `schema.prisma:L5545`
- `Payment` → `schema.prisma:L4019`
- `PaymentAllocation` → `schema.prisma:L4285`
- `PaymentLink` → `schema.prisma:L13827`
- `PaymentLinkAttribution` → `schema.prisma:L13935`
- `PaymentLinkItem` → `schema.prisma:L13890`
- `PaymentLinkItemModifier` → `schema.prisma:L13917`
- `PaymentProvider` → `schema.prisma:L5100`
- `PayrollLine` → `schema.prisma:L16187`
- `PayrollRun` → `schema.prisma:L16156`
- `PerformanceGoal` → `schema.prisma:L12187`
- `PermissionOverride` → `schema.prisma:L1362`
- `PermissionSet` → `schema.prisma:L1385`
- `PlatformAnnouncement` → `schema.prisma:L16843`
- `PlatformAnnouncementClick` → `schema.prisma:L16908`
- `PlatformAnnouncementDelivery` → `schema.prisma:L16945`
- `PlatformCfdi` → `schema.prisma:L16472`
- `PlatformEmisor` → `schema.prisma:L16412`
- `PlatformSettings` → `schema.prisma:L5522`
- `PosCommand` → `schema.prisma:L8124`
- `PosConnectionStatus` → `schema.prisma:L911`
- `PosSyncIntent` → `schema.prisma:L16550`
- `PricingPolicy` → `schema.prisma:L2595`
- `Printer` → `schema.prisma:L14384`
- `PrintGateway` → `schema.prisma:L14437`
- `PrintJob` → `schema.prisma:L15151`
- `PrintStation` → `schema.prisma:L14455`
- `ProcessedStripeEvent` → `schema.prisma:L6041`
- `ProcessorReliabilityMetric` → `schema.prisma:L6526`
- `Product` → `schema.prisma:L1673`
- `ProductModifierGroup` → `schema.prisma:L3958`
- `ProductOption` → `schema.prisma:L14118`
- `ProductOptionValue` → `schema.prisma:L14129`
- `ProductStaff` → `schema.prisma:L13062`
- `PromoterBankAccount` → `schema.prisma:L16307`
- `PromoterCommissionEntry` → `schema.prisma:L16326`
- `PromoterLocationPing` → `schema.prisma:L3489`
- `Promotion` → `schema.prisma:L16601`
- `PromotionGroup` → `schema.prisma:L16640`
- `PromotionOption` → `schema.prisma:L16656`
- `ProviderCostStructure` → `schema.prisma:L6077`
- `ProviderEventLog` → `schema.prisma:L5824`
- `PurchaseOrder` → `schema.prisma:L2320`
- `PurchaseOrderInvoice` → `schema.prisma:L2465`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2522`
- `PurchaseOrderItem` → `schema.prisma:L2378`
- `RateCorrectionBatch` → `schema.prisma:L6302`
- `RateCorrectionEntry` → `schema.prisma:L6344`
- `RawMaterial` → `schema.prisma:L2077`
- `RawMaterialMovement` → `schema.prisma:L2648`
- `RawMaterialPresentation` → `schema.prisma:L2152`
- `Recipe` → `schema.prisma:L2172`
- `RecipeLine` → `schema.prisma:L2196`
- `Referral` → `schema.prisma:L7312`
- `ReferralProgramConfig` → `schema.prisma:L7277`
- `ReferralRewardGrant` → `schema.prisma:L7403`
- `ReferralTierReward` → `schema.prisma:L7375`
- `ReferralTierUnlock` → `schema.prisma:L7448`
- `RefreshGrant` → `schema.prisma:L17032`
- `Reservation` → `schema.prisma:L12830`
- `ReservationGoogleEventMapping` → `schema.prisma:L13600`
- `ReservationModifier` → `schema.prisma:L13010`
- `ReservationReminderSent` → `schema.prisma:L12993`
- `ReservationSettings` → `schema.prisma:L13224`
- `ReservationWaitlistEntry` → `schema.prisma:L13192`
- `Review` → `schema.prisma:L4580`
- `SalesRetention` → `schema.prisma:L16007`
- `SaleVerification` → `schema.prisma:L4339`
- `ScaleProfile` → `schema.prisma:L14892`
- `ScheduledCommand` → `schema.prisma:L9664`
- `SerializedItem` → `schema.prisma:L11314`
- `SerializedItemCustodyEvent` → `schema.prisma:L11478`
- `ServiceCharge` → `schema.prisma:L7912`
- `Session` → `schema.prisma:L17011`
- `SettlementConfiguration` → `schema.prisma:L6377`
- `SettlementConfirmation` → `schema.prisma:L6490`
- `SettlementIncident` → `schema.prisma:L6441`
- `SettlementSimulation` → `schema.prisma:L6412`
- `Shift` → `schema.prisma:L3136`
- `SimRegistrationRequest` → `schema.prisma:L11516`
- `SimRegistrationRequestItem` → `schema.prisma:L11538`
- `SlotHold` → `schema.prisma:L13093`
- `Staff` → `schema.prisma:L931`
- `StaffDocument` → `schema.prisma:L3360`
- `StaffOnboardingState` → `schema.prisma:L15222`
- `StaffOrganization` → `schema.prisma:L1261`
- `StaffPasskey` → `schema.prisma:L1288`
- `StaffSchedule` → `schema.prisma:L13033`
- `StaffScheduleException` → `schema.prisma:L13045`
- `StaffVenue` → `schema.prisma:L1185`
- `StaffWorkSchedule` → `schema.prisma:L3243`
- `StaffWorkScheduleException` → `schema.prisma:L3335`
- `StampCard` → `schema.prisma:L7160`
- `StampEvent` → `schema.prisma:L7199`
- `StampReward` → `schema.prisma:L7237`
- `StockAlertConfig` → `schema.prisma:L12169`
- `StockBatch` → `schema.prisma:L2799`
- `StockCount` → `schema.prisma:L2723`
- `StockCountItem` → `schema.prisma:L2747`
- `StripeWebhookEvent` → `schema.prisma:L6024`
- `Supplier` → `schema.prisma:L2231`
- `SupplierItemCode` → `schema.prisma:L2563`
- `SupplierPricing` → `schema.prisma:L2286`
- `Table` → `schema.prisma:L3048`
- `Terminal` → `schema.prisma:L4631`
- `TerminalHealth` → `schema.prisma:L4870`
- `TerminalLog` → `schema.prisma:L4844`
- `TerminalOrder` → `schema.prisma:L5003`
- `TerminalOrderItem` → `schema.prisma:L5078`
- `TerminalPaymentRequest` → `schema.prisma:L4941`
- `TimeEntry` → `schema.prisma:L3402`
- `TimeEntryBreak` → `schema.prisma:L3471`
- `TokenPurchase` → `schema.prisma:L9338`
- `TokenUsageRecord` → `schema.prisma:L9310`
- `TpvCommandHistory` → `schema.prisma:L9570`
- `TpvCommandQueue` → `schema.prisma:L9510`
- `TpvFeedback` → `schema.prisma:L9223`
- `TpvMessage` → `schema.prisma:L12526`
- `TpvMessageDelivery` → `schema.prisma:L12578`
- `TpvMessageResponse` → `schema.prisma:L12601`
- `TrainingModule` → `schema.prisma:L12656`
- `TrainingProgress` → `schema.prisma:L12733`
- `TrainingQuizQuestion` → `schema.prisma:L12715`
- `TrainingStep` → `schema.prisma:L12695`
- `TransactionCost` → `schema.prisma:L6240`
- `UnitConversion` → `schema.prisma:L2626`
- `UpsellAcceptance` → `schema.prisma:L7733`
- `UpsellAiRun` → `schema.prisma:L7753`
- `UpsellImpression` → `schema.prisma:L7693`
- `UpsellRule` → `schema.prisma:L7613`
- `user_sessions` → `schema.prisma:L5580`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14629`
- `VenueChatMessage` → `schema.prisma:L761`
- `VenueChatSession` → `schema.prisma:L716`
- `VenueCommission` → `schema.prisma:L14279`
- `VenueCreditAssessment` → `schema.prisma:L10052`
- `VenueCryptoConfig` → `schema.prisma:L12393`
- `VenueFeature` → `schema.prisma:L4453`
- `VenueModule` → `schema.prisma:L10212`
- `VenuePaymentConfig` → `schema.prisma:L5681`
- `VenuePaymentLinkSettings` → `schema.prisma:L13633`
- `VenuePricingStructure` → `schema.prisma:L6180`
- `VenueRoleConfig` → `schema.prisma:L1414`
- `VenueRolePermission` → `schema.prisma:L1318`
- `VenueScaleSettings` → `schema.prisma:L14880`
- `VenueSettings` → `schema.prisma:L801`
- `VenueTenderType` → `schema.prisma:L4198`
- `VenueTenderTypeRevision` → `schema.prisma:L4263`
- `VenueTransaction` → `schema.prisma:L4390`
- `VenueWhatsappActivation` → `schema.prisma:L652`
- `WalletCardDesign` → `schema.prisma:L7078`
- `WalletPass` → `schema.prisma:L6987`
- `WalletPassRegistration` → `schema.prisma:L7045`
- `WebhookEvent` → `schema.prisma:L4489`
- `WebhookSubscription` → `schema.prisma:L5797`
- `WhatsappContactWindow` → `schema.prisma:L670`
- `WhatsappInboundEvent` → `schema.prisma:L690`
- `WorkShiftAssignment` → `schema.prisma:L3283`
- `WorkShiftTemplate` → `schema.prisma:L3260`
- `Zone` → `schema.prisma:L142`
