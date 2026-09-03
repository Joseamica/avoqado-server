# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **357 models / 339 enums / ~17,100 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                     |
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

- `AccountingPeriodLock` → `schema.prisma:L15944`
- `AccountMapping` → `schema.prisma:L15840`
- `ActivityLog` → `schema.prisma:L6710`
- `Aggregator` → `schema.prisma:L14237`
- `AngelPayUserAccount` → `schema.prisma:L5373`
- `AppUpdate` → `schema.prisma:L12402`
- `Area` → `schema.prisma:L3026`
- `AreaTicket` → `schema.prisma:L14735`
- `AreaTicketCheckoutSession` → `schema.prisma:L14857`
- `AreaTicketExternalIncident` → `schema.prisma:L15104`
- `AreaTicketExternalSettlement` → `schema.prisma:L15069`
- `AreaTicketFulfillment` → `schema.prisma:L14933`
- `AreaTicketInventoryReservation` → `schema.prisma:L14828`
- `AreaTicketLine` → `schema.prisma:L14796`
- `AreaTicketPaymentAttempt` → `schema.prisma:L14889`
- `AreaTicketPrintAttempt` → `schema.prisma:L14912`
- `BankStatement` → `schema.prisma:L15714`
- `BankStatementLine` → `schema.prisma:L15735`
- `BillingTaxProfile` → `schema.prisma:L16524`
- `BulkCommandOperation` → `schema.prisma:L9682`
- `CalendarSyncOutbox` → `schema.prisma:L13609`
- `CampaignDelivery` → `schema.prisma:L12560`
- `CashCloseout` → `schema.prisma:L10067`
- `CashDeposit` → `schema.prisma:L12204`
- `CashDrawerEvent` → `schema.prisma:L14074`
- `CashDrawerSession` → `schema.prisma:L14035`
- `CashOutCommissionRate` → `schema.prisma:L16353`
- `CashOutScheduleDay` → `schema.prisma:L16376`
- `CashOutWithdrawal` → `schema.prisma:L16438`
- `CatalogBindingBatch` → `schema.prisma:L11098`
- `CatalogBindingLine` → `schema.prisma:L11134`
- `CatalogBrand` → `schema.prisma:L10551`
- `CatalogClientObservation` → `schema.prisma:L10864`
- `CatalogClientReadinessOverride` → `schema.prisma:L10883`
- `CatalogFamily` → `schema.prisma:L10601`
- `CatalogIdempotencyRecord` → `schema.prisma:L10997`
- `CatalogIdentifier` → `schema.prisma:L10732`
- `CatalogImportBatch` → `schema.prisma:L11040`
- `CatalogImportLine` → `schema.prisma:L11077`
- `CatalogItem` → `schema.prisma:L10634`
- `CatalogItemBusinessType` → `schema.prisma:L10694`
- `CatalogItemPrice` → `schema.prisma:L10782`
- `CatalogManufacturer` → `schema.prisma:L10575`
- `CatalogProductTypeMapping` → `schema.prisma:L10711`
- `CatalogPublicationBatch` → `schema.prisma:L11162`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11256`
- `CatalogPublicationLine` → `schema.prisma:L11203`
- `CatalogPublicationOutbox` → `schema.prisma:L11299`
- `CatalogValidationProfile` → `schema.prisma:L10753`
- `CatalogVenueBinding` → `schema.prisma:L10911`
- `CatalogVenueClientRequirement` → `schema.prisma:L10838`
- `CatalogVenueEventSequence` → `schema.prisma:L11282`
- `CatalogVenueOverride` → `schema.prisma:L10953`
- `CatalogVenueRollout` → `schema.prisma:L10813`
- `Cfdi` → `schema.prisma:L15617`
- `ChatbotTokenBudget` → `schema.prisma:L9330`
- `ChatConversation` → `schema.prisma:L9185`
- `ChatFeedback` → `schema.prisma:L9271`
- `ChatLearningEvent` → `schema.prisma:L9228`
- `ChatMessage` → `schema.prisma:L9208`
- `ChatTrainingData` → `schema.prisma:L9142`
- `CheckoutSession` → `schema.prisma:L5653`
- `ClassSession` → `schema.prisma:L13213`
- `CommissionCalculation` → `schema.prisma:L11980`
- `CommissionClawback` → `schema.prisma:L12156`
- `CommissionConfig` → `schema.prisma:L11746`
- `CommissionMilestone` → `schema.prisma:L11896`
- `CommissionOverride` → `schema.prisma:L11823`
- `CommissionPayout` → `schema.prisma:L12107`
- `CommissionSummary` → `schema.prisma:L12046`
- `CommissionTier` → `schema.prisma:L11860`
- `Consumer` → `schema.prisma:L6873`
- `ConsumerAuthAccount` → `schema.prisma:L6898`
- `CouponCode` → `schema.prisma:L7837`
- `CouponRedemption` → `schema.prisma:L7868`
- `CreditAssessmentHistory` → `schema.prisma:L10176`
- `CreditItemBalance` → `schema.prisma:L13825`
- `CreditOffer` → `schema.prisma:L10195`
- `CreditPack` → `schema.prisma:L13734`
- `CreditPackItem` → `schema.prisma:L13763`
- `CreditPackPurchase` → `schema.prisma:L13780`
- `CreditTransaction` → `schema.prisma:L13847`
- `Customer` → `schema.prisma:L6751`
- `CustomerApprovalDelivery` → `schema.prisma:L8844`
- `CustomerApprovalOutbox` → `schema.prisma:L8819`
- `CustomerDiscount` → `schema.prisma:L7888`
- `CustomerGroup` → `schema.prisma:L6937`
- `CustomerOrderMetric` → `schema.prisma:L3785`
- `CustomerTaxProfile` → `schema.prisma:L15686`
- `DeliveryActivationRequest` → `schema.prisma:L5994`
- `DeliveryChannelLink` → `schema.prisma:L5939`
- `DeliveryOrderEvent` → `schema.prisma:L6018`
- `DeviceToken` → `schema.prisma:L8157`
- `DigitalReceipt` → `schema.prisma:L4356`
- `Discount` → `schema.prisma:L7527`
- `EcommerceMerchant` → `schema.prisma:L5465`
- `EmailTemplate` → `schema.prisma:L12499`
- `Employee` → `schema.prisma:L16201`
- `Estimate` → `schema.prisma:L14144`
- `EstimateItem` → `schema.prisma:L14172`
- `Expense` → `schema.prisma:L15988`
- `ExternalBusyBlock` → `schema.prisma:L13502`
- `Feature` → `schema.prisma:L4485`
- `FeeSchedule` → `schema.prisma:L4563`
- `FeeTier` → `schema.prisma:L4574`
- `FinancialAccount` → `schema.prisma:L14334`
- `FinancialConnection` → `schema.prisma:L14303`
- `FinancialProvider` → `schema.prisma:L14289`
- `FiscalEmisor` → `schema.prisma:L15540`
- `FiscalLossCarryforward` → `schema.prisma:L16111`
- `FixedAsset` → `schema.prisma:L16129`
- `FixedAssetDepreciation` → `schema.prisma:L16158`
- `FloorElement` → `schema.prisma:L3102`
- `FulfillmentArea` → `schema.prisma:L14600`
- `GeofenceRule` → `schema.prisma:L9767`
- `GoogleCalendarChannel` → `schema.prisma:L13479`
- `GoogleCalendarConnection` → `schema.prisma:L13431`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L13532`
- `GoogleOAuthSession` → `schema.prisma:L13554`
- `HolidayCalendar` → `schema.prisma:L6634`
- `IdempotencyRequest` → `schema.prisma:L11621`
- `InterVenueTransfer` → `schema.prisma:L2854`
- `InterVenueTransferAllocation` → `schema.prisma:L2937`
- `InterVenueTransferItem` → `schema.prisma:L2906`
- `InterVenueTransferReceipt` → `schema.prisma:L2964`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2980`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3008`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2992`
- `Inventory` → `schema.prisma:L1900`
- `InventoryMovement` → `schema.prisma:L1927`
- `InventoryPosting` → `schema.prisma:L2009`
- `InventoryPostingLine` → `schema.prisma:L2049`
- `InventoryTransfer` → `schema.prisma:L14116`
- `Invitation` → `schema.prisma:L1438`
- `Invoice` → `schema.prisma:L4586`
- `InvoiceItem` → `schema.prisma:L4612`
- `ItemCategory` → `schema.prisma:L11334`
- `JournalEntry` → `schema.prisma:L15898`
- `JournalLine` → `schema.prisma:L15926`
- `KdsOrder` → `schema.prisma:L14382`
- `KdsOrderItem` → `schema.prisma:L14423`
- `KioskCheckInAttempt` → `schema.prisma:L16847`
- `KioskCheckInChallenge` → `schema.prisma:L16801`
- `KioskOutreachOutbox` → `schema.prisma:L16868`
- `LearnedPatterns` → `schema.prisma:L9252`
- `LedgerAccount` → `schema.prisma:L15790`
- `LiveDemoSession` → `schema.prisma:L785`
- `LowStockAlert` → `schema.prisma:L2695`
- `LoyaltyConfig` → `schema.prisma:L6967`
- `LoyaltyTransaction` → `schema.prisma:L7010`
- `MarketingCampaign` → `schema.prisma:L12517`
- `McpAuthCode` → `schema.prisma:L15423`
- `McpOAuthClient` → `schema.prisma:L15407`
- `McpRefreshToken` → `schema.prisma:L15441`
- `McpToolCall` → `schema.prisma:L15462`
- `MeasurementUnit` → `schema.prisma:L14222`
- `Menu` → `schema.prisma:L1624`
- `MenuCategory` → `schema.prisma:L1561`
- `MenuCategoryAssignment` → `schema.prisma:L1659`
- `MercadoPagoWebhookEvent` → `schema.prisma:L15337`
- `MerchantAccount` → `schema.prisma:L5203`
- `MerchantFiscalConfig` → `schema.prisma:L15588`
- `MerchantRevenueShare` → `schema.prisma:L6214`
- `MerchantRoutingRule` → `schema.prisma:L5325`
- `MilestoneAchievement` → `schema.prisma:L11941`
- `Modifier` → `schema.prisma:L3969`
- `ModifierGroup` → `schema.prisma:L3933`
- `Module` → `schema.prisma:L10243`
- `MoneyAnomaly` → `schema.prisma:L6117`
- `MonthlyVenueProfit` → `schema.prisma:L6660`
- `Notification` → `schema.prisma:L8059`
- `NotificationPreference` → `schema.prisma:L8106`
- `NotificationTemplate` → `schema.prisma:L8133`
- `OAuthState` → `schema.prisma:L1489`
- `OnboardingProgress` → `schema.prisma:L1507`
- `Order` → `schema.prisma:L3540`
- `OrderAction` → `schema.prisma:L4036`
- `OrderCustomer` → `schema.prisma:L3764`
- `OrderDiscount` → `schema.prisma:L7920`
- `OrderFulfillment` → `schema.prisma:L14655`
- `OrderFulfillmentLine` → `schema.prisma:L14686`
- `OrderItem` → `schema.prisma:L3800`
- `OrderItemModifier` → `schema.prisma:L4018`
- `OrderPromotion` → `schema.prisma:L16764`
- `OrderServiceCharge` → `schema.prisma:L8004`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L12318`
- `OrganizationEntitlement` → `schema.prisma:L10526`
- `OrganizationGoal` → `schema.prisma:L12276`
- `OrganizationModule` → `schema.prisma:L10303`
- `OrganizationPaymentConfig` → `schema.prisma:L5777`
- `OrganizationPayoutConfig` → `schema.prisma:L12351`
- `OrganizationPricingStructure` → `schema.prisma:L5809`
- `OrganizationSalesGoalConfig` → `schema.prisma:L12299`
- `OtpChallenge` → `schema.prisma:L6917`
- `OvertimeApproval` → `schema.prisma:L3318`
- `PartnerAPIKey` → `schema.prisma:L5607`
- `Payment` → `schema.prisma:L4069`
- `PaymentAllocation` → `schema.prisma:L4335`
- `PaymentLink` → `schema.prisma:L13893`
- `PaymentLinkAttribution` → `schema.prisma:L14001`
- `PaymentLinkItem` → `schema.prisma:L13956`
- `PaymentLinkItemModifier` → `schema.prisma:L13983`
- `PaymentProvider` → `schema.prisma:L5162`
- `PayrollLine` → `schema.prisma:L16272`
- `PayrollRun` → `schema.prisma:L16241`
- `PerformanceGoal` → `schema.prisma:L12253`
- `PermissionOverride` → `schema.prisma:L1362`
- `PermissionSet` → `schema.prisma:L1385`
- `PlatformAnnouncement` → `schema.prisma:L16928`
- `PlatformAnnouncementClick` → `schema.prisma:L16993`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17030`
- `PlatformCfdi` → `schema.prisma:L16557`
- `PlatformEmisor` → `schema.prisma:L16497`
- `PlatformSettings` → `schema.prisma:L5584`
- `PosCommand` → `schema.prisma:L8187`
- `PosConnectionStatus` → `schema.prisma:L911`
- `PosSyncIntent` → `schema.prisma:L16635`
- `PricingPolicy` → `schema.prisma:L2599`
- `Printer` → `schema.prisma:L14465`
- `PrintGateway` → `schema.prisma:L14522`
- `PrintJob` → `schema.prisma:L15236`
- `PrintStation` → `schema.prisma:L14540`
- `ProcessedStripeEvent` → `schema.prisma:L6103`
- `ProcessorReliabilityMetric` → `schema.prisma:L6588`
- `Product` → `schema.prisma:L1677`
- `ProductModifierGroup` → `schema.prisma:L4006`
- `ProductOption` → `schema.prisma:L14199`
- `ProductOptionValue` → `schema.prisma:L14210`
- `ProductStaff` → `schema.prisma:L13128`
- `PromoterBankAccount` → `schema.prisma:L16392`
- `PromoterCommissionEntry` → `schema.prisma:L16411`
- `PromoterLocationPing` → `schema.prisma:L3506`
- `Promotion` → `schema.prisma:L16686`
- `PromotionGroup` → `schema.prisma:L16725`
- `PromotionOption` → `schema.prisma:L16741`
- `ProviderCostStructure` → `schema.prisma:L6139`
- `ProviderEventLog` → `schema.prisma:L5886`
- `PurchaseOrder` → `schema.prisma:L2324`
- `PurchaseOrderInvoice` → `schema.prisma:L2469`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2526`
- `PurchaseOrderItem` → `schema.prisma:L2382`
- `RateCorrectionBatch` → `schema.prisma:L6364`
- `RateCorrectionEntry` → `schema.prisma:L6406`
- `RawMaterial` → `schema.prisma:L2081`
- `RawMaterialMovement` → `schema.prisma:L2652`
- `RawMaterialPresentation` → `schema.prisma:L2156`
- `Recipe` → `schema.prisma:L2176`
- `RecipeLine` → `schema.prisma:L2200`
- `Referral` → `schema.prisma:L7375`
- `ReferralProgramConfig` → `schema.prisma:L7340`
- `ReferralRewardGrant` → `schema.prisma:L7466`
- `ReferralTierReward` → `schema.prisma:L7438`
- `ReferralTierUnlock` → `schema.prisma:L7511`
- `RefreshGrant` → `schema.prisma:L17117`
- `Reservation` → `schema.prisma:L12896`
- `ReservationGoogleEventMapping` → `schema.prisma:L13666`
- `ReservationModifier` → `schema.prisma:L13076`
- `ReservationReminderSent` → `schema.prisma:L13059`
- `ReservationSettings` → `schema.prisma:L13290`
- `ReservationWaitlistEntry` → `schema.prisma:L13258`
- `Review` → `schema.prisma:L4630`
- `SalesRetention` → `schema.prisma:L16092`
- `SaleVerification` → `schema.prisma:L4389`
- `ScaleProfile` → `schema.prisma:L14977`
- `ScheduledCommand` → `schema.prisma:L9727`
- `SerializedItem` → `schema.prisma:L11377`
- `SerializedItemCustodyEvent` → `schema.prisma:L11544`
- `ServiceCharge` → `schema.prisma:L7975`
- `Session` → `schema.prisma:L17096`
- `SettlementConfiguration` → `schema.prisma:L6439`
- `SettlementConfirmation` → `schema.prisma:L6552`
- `SettlementIncident` → `schema.prisma:L6503`
- `SettlementSimulation` → `schema.prisma:L6474`
- `Shift` → `schema.prisma:L3140`
- `SimRegistrationRequest` → `schema.prisma:L11582`
- `SimRegistrationRequestItem` → `schema.prisma:L11604`
- `SlotHold` → `schema.prisma:L13159`
- `Staff` → `schema.prisma:L931`
- `StaffDocument` → `schema.prisma:L3377`
- `StaffOnboardingState` → `schema.prisma:L15307`
- `StaffOrganization` → `schema.prisma:L1261`
- `StaffPasskey` → `schema.prisma:L1288`
- `StaffSchedule` → `schema.prisma:L13099`
- `StaffScheduleException` → `schema.prisma:L13111`
- `StaffVenue` → `schema.prisma:L1185`
- `StaffWorkSchedule` → `schema.prisma:L3254`
- `StaffWorkScheduleException` → `schema.prisma:L3352`
- `StampCard` → `schema.prisma:L7223`
- `StampEvent` → `schema.prisma:L7262`
- `StampReward` → `schema.prisma:L7300`
- `StockAlertConfig` → `schema.prisma:L12235`
- `StockBatch` → `schema.prisma:L2803`
- `StockCount` → `schema.prisma:L2727`
- `StockCountItem` → `schema.prisma:L2751`
- `StripeWebhookEvent` → `schema.prisma:L6086`
- `Supplier` → `schema.prisma:L2235`
- `SupplierItemCode` → `schema.prisma:L2567`
- `SupplierPricing` → `schema.prisma:L2290`
- `Table` → `schema.prisma:L3052`
- `Terminal` → `schema.prisma:L4681`
- `TerminalHealth` → `schema.prisma:L4932`
- `TerminalLog` → `schema.prisma:L4906`
- `TerminalOrder` → `schema.prisma:L5065`
- `TerminalOrderItem` → `schema.prisma:L5140`
- `TerminalPaymentRequest` → `schema.prisma:L5003`
- `TimeEntry` → `schema.prisma:L3419`
- `TimeEntryBreak` → `schema.prisma:L3488`
- `TokenPurchase` → `schema.prisma:L9401`
- `TokenUsageRecord` → `schema.prisma:L9373`
- `TpvCommandHistory` → `schema.prisma:L9633`
- `TpvCommandQueue` → `schema.prisma:L9573`
- `TpvFeedback` → `schema.prisma:L9286`
- `TpvMessage` → `schema.prisma:L12592`
- `TpvMessageDelivery` → `schema.prisma:L12644`
- `TpvMessageResponse` → `schema.prisma:L12667`
- `TrainingModule` → `schema.prisma:L12722`
- `TrainingProgress` → `schema.prisma:L12799`
- `TrainingQuizQuestion` → `schema.prisma:L12781`
- `TrainingStep` → `schema.prisma:L12761`
- `TransactionCost` → `schema.prisma:L6302`
- `UnitConversion` → `schema.prisma:L2630`
- `UpsellAcceptance` → `schema.prisma:L7796`
- `UpsellAiRun` → `schema.prisma:L7816`
- `UpsellImpression` → `schema.prisma:L7756`
- `UpsellRule` → `schema.prisma:L7676`
- `user_sessions` → `schema.prisma:L5642`
- `Venue` → `schema.prisma:L159`
- `VenueAreaTicketSettings` → `schema.prisma:L14714`
- `VenueChatMessage` → `schema.prisma:L761`
- `VenueChatSession` → `schema.prisma:L716`
- `VenueCommission` → `schema.prisma:L14360`
- `VenueCreditAssessment` → `schema.prisma:L10115`
- `VenueCryptoConfig` → `schema.prisma:L12459`
- `VenueFeature` → `schema.prisma:L4503`
- `VenueModule` → `schema.prisma:L10275`
- `VenuePaymentConfig` → `schema.prisma:L5743`
- `VenuePaymentLinkSettings` → `schema.prisma:L13699`
- `VenuePricingStructure` → `schema.prisma:L6242`
- `VenueRoleConfig` → `schema.prisma:L1414`
- `VenueRolePermission` → `schema.prisma:L1318`
- `VenueScaleSettings` → `schema.prisma:L14965`
- `VenueSettings` → `schema.prisma:L801`
- `VenueTenderType` → `schema.prisma:L4248`
- `VenueTenderTypeRevision` → `schema.prisma:L4313`
- `VenueTransaction` → `schema.prisma:L4440`
- `VenueWhatsappActivation` → `schema.prisma:L652`
- `WalletCardDesign` → `schema.prisma:L7141`
- `WalletPass` → `schema.prisma:L7050`
- `WalletPassRegistration` → `schema.prisma:L7108`
- `WebhookEvent` → `schema.prisma:L4539`
- `WebhookSubscription` → `schema.prisma:L5859`
- `WhatsappContactWindow` → `schema.prisma:L670`
- `WhatsappInboundEvent` → `schema.prisma:L690`
- `WorkShiftAssignment` → `schema.prisma:L3294`
- `WorkShiftTemplate` → `schema.prisma:L3271`
- `Zone` → `schema.prisma:L142`
