# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **290 models / 271 enums / ~13,500 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 21 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `Module`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `PermissionSet`, `PromoterLocationPing`, `Staff`, `StaffOrganization`, `StaffPasskey`, `StaffVenue`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryTransfer`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierPricing`                                                                                                                                                          |
| 7   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 8   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryOrderEvent`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 9   | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `TransactionCost`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 10  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                           |
| 11  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 12  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                           |
| 13  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 14  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`                                                                                                                                                                                                                                                                                                                                                                         |
| 15  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                        |
| 16  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                       |
| 17  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                   |
| 18  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 19  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 20  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerGroup`, `OtpChallenge`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 21  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L12836`
- `AccountMapping` → `schema.prisma:L12732`
- `ActivityLog` → `schema.prisma:L5632`
- `Aggregator` → `schema.prisma:L11363`
- `AngelPayUserAccount` → `schema.prisma:L4341`
- `AppUpdate` → `schema.prisma:L9592`
- `Area` → `schema.prisma:L2406`
- `AreaTicket` → `schema.prisma:L11782`
- `AreaTicketCheckoutSession` → `schema.prisma:L11890`
- `AreaTicketFulfillment` → `schema.prisma:L11966`
- `AreaTicketInventoryReservation` → `schema.prisma:L11865`
- `AreaTicketLine` → `schema.prisma:L11833`
- `AreaTicketPaymentAttempt` → `schema.prisma:L11922`
- `AreaTicketPrintAttempt` → `schema.prisma:L11945`
- `BankStatement` → `schema.prisma:L12606`
- `BankStatementLine` → `schema.prisma:L12627`
- `BillingTaxProfile` → `schema.prisma:L13416`
- `BulkCommandOperation` → `schema.prisma:L7913`
- `CalendarSyncOutbox` → `schema.prisma:L10766`
- `CampaignDelivery` → `schema.prisma:L9750`
- `CashCloseout` → `schema.prisma:L8278`
- `CashDeposit` → `schema.prisma:L9394`
- `CashDrawerEvent` → `schema.prisma:L11209`
- `CashDrawerSession` → `schema.prisma:L11185`
- `CashOutCommissionRate` → `schema.prisma:L13245`
- `CashOutScheduleDay` → `schema.prisma:L13268`
- `CashOutWithdrawal` → `schema.prisma:L13330`
- `Cfdi` → `schema.prisma:L12509`
- `ChatbotTokenBudget` → `schema.prisma:L7561`
- `ChatConversation` → `schema.prisma:L7416`
- `ChatFeedback` → `schema.prisma:L7502`
- `ChatLearningEvent` → `schema.prisma:L7459`
- `ChatMessage` → `schema.prisma:L7439`
- `ChatTrainingData` → `schema.prisma:L7373`
- `CheckoutSession` → `schema.prisma:L4621`
- `ClassSession` → `schema.prisma:L10384`
- `CommissionCalculation` → `schema.prisma:L9173`
- `CommissionClawback` → `schema.prisma:L9346`
- `CommissionConfig` → `schema.prisma:L8946`
- `CommissionMilestone` → `schema.prisma:L9089`
- `CommissionOverride` → `schema.prisma:L9016`
- `CommissionPayout` → `schema.prisma:L9297`
- `CommissionSummary` → `schema.prisma:L9236`
- `CommissionTier` → `schema.prisma:L9053`
- `Consumer` → `schema.prisma:L5753`
- `ConsumerAuthAccount` → `schema.prisma:L5778`
- `CouponCode` → `schema.prisma:L6184`
- `CouponRedemption` → `schema.prisma:L6215`
- `CreditAssessmentHistory` → `schema.prisma:L8387`
- `CreditItemBalance` → `schema.prisma:L10975`
- `CreditOffer` → `schema.prisma:L8406`
- `CreditPack` → `schema.prisma:L10891`
- `CreditPackItem` → `schema.prisma:L10920`
- `CreditPackPurchase` → `schema.prisma:L10937`
- `CreditTransaction` → `schema.prisma:L10997`
- `Customer` → `schema.prisma:L5658`
- `CustomerDiscount` → `schema.prisma:L6235`
- `CustomerGroup` → `schema.prisma:L5812`
- `CustomerTaxProfile` → `schema.prisma:L12578`
- `DeliveryActivationRequest` → `schema.prisma:L4943`
- `DeliveryChannelLink` → `schema.prisma:L4907`
- `DeliveryOrderEvent` → `schema.prisma:L4967`
- `DeviceToken` → `schema.prisma:L6504`
- `DigitalReceipt` → `schema.prisma:L3349`
- `Discount` → `schema.prisma:L6084`
- `EcommerceMerchant` → `schema.prisma:L4433`
- `EmailTemplate` → `schema.prisma:L9689`
- `Employee` → `schema.prisma:L13093`
- `Estimate` → `schema.prisma:L11270`
- `EstimateItem` → `schema.prisma:L11298`
- `Expense` → `schema.prisma:L12880`
- `ExternalBusyBlock` → `schema.prisma:L10659`
- `Feature` → `schema.prisma:L3478`
- `FeeSchedule` → `schema.prisma:L3556`
- `FeeTier` → `schema.prisma:L3567`
- `FinancialAccount` → `schema.prisma:L11460`
- `FinancialConnection` → `schema.prisma:L11429`
- `FinancialProvider` → `schema.prisma:L11415`
- `FiscalEmisor` → `schema.prisma:L12432`
- `FiscalLossCarryforward` → `schema.prisma:L13003`
- `FixedAsset` → `schema.prisma:L13021`
- `FixedAssetDepreciation` → `schema.prisma:L13050`
- `FloorElement` → `schema.prisma:L2482`
- `FulfillmentArea` → `schema.prisma:L11655`
- `GeofenceRule` → `schema.prisma:L7998`
- `GoogleCalendarChannel` → `schema.prisma:L10636`
- `GoogleCalendarConnection` → `schema.prisma:L10588`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L10689`
- `GoogleOAuthSession` → `schema.prisma:L10711`
- `HolidayCalendar` → `schema.prisma:L5556`
- `IdempotencyRequest` → `schema.prisma:L8821`
- `InterVenueTransfer` → `schema.prisma:L2234`
- `InterVenueTransferAllocation` → `schema.prisma:L2317`
- `InterVenueTransferItem` → `schema.prisma:L2286`
- `InterVenueTransferReceipt` → `schema.prisma:L2344`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2360`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2388`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2372`
- `Inventory` → `schema.prisma:L1607`
- `InventoryMovement` → `schema.prisma:L1634`
- `InventoryTransfer` → `schema.prisma:L11242`
- `Invitation` → `schema.prisma:L1191`
- `Invoice` → `schema.prisma:L3579`
- `InvoiceItem` → `schema.prisma:L3605`
- `ItemCategory` → `schema.prisma:L8538`
- `JournalEntry` → `schema.prisma:L12790`
- `JournalLine` → `schema.prisma:L12818`
- `KdsOrder` → `schema.prisma:L11508`
- `KdsOrderItem` → `schema.prisma:L11525`
- `LearnedPatterns` → `schema.prisma:L7483`
- `LedgerAccount` → `schema.prisma:L12682`
- `LiveDemoSession` → `schema.prisma:L688`
- `LowStockAlert` → `schema.prisma:L2088`
- `LoyaltyConfig` → `schema.prisma:L5842`
- `LoyaltyTransaction` → `schema.prisma:L5865`
- `MarketingCampaign` → `schema.prisma:L9707`
- `McpAuthCode` → `schema.prisma:L12315`
- `McpOAuthClient` → `schema.prisma:L12299`
- `McpRefreshToken` → `schema.prisma:L12333`
- `McpToolCall` → `schema.prisma:L12354`
- `MeasurementUnit` → `schema.prisma:L11348`
- `Menu` → `schema.prisma:L1377`
- `MenuCategory` → `schema.prisma:L1314`
- `MenuCategoryAssignment` → `schema.prisma:L1412`
- `MercadoPagoWebhookEvent` → `schema.prisma:L12229`
- `MerchantAccount` → `schema.prisma:L4171`
- `MerchantFiscalConfig` → `schema.prisma:L12480`
- `MerchantRevenueShare` → `schema.prisma:L5136`
- `MerchantRoutingRule` → `schema.prisma:L4293`
- `MilestoneAchievement` → `schema.prisma:L9134`
- `Modifier` → `schema.prisma:L3078`
- `ModifierGroup` → `schema.prisma:L3042`
- `Module` → `schema.prisma:L8454`
- `MoneyAnomaly` → `schema.prisma:L5039`
- `MonthlyVenueProfit` → `schema.prisma:L5582`
- `Notification` → `schema.prisma:L6406`
- `NotificationPreference` → `schema.prisma:L6453`
- `NotificationTemplate` → `schema.prisma:L6480`
- `OAuthState` → `schema.prisma:L1242`
- `OnboardingProgress` → `schema.prisma:L1260`
- `Order` → `schema.prisma:L2706`
- `OrderAction` → `schema.prisma:L3143`
- `OrderCustomer` → `schema.prisma:L2899`
- `OrderDiscount` → `schema.prisma:L6267`
- `OrderFulfillment` → `schema.prisma:L11702`
- `OrderFulfillmentLine` → `schema.prisma:L11733`
- `OrderItem` → `schema.prisma:L2915`
- `OrderItemModifier` → `schema.prisma:L3127`
- `OrderServiceCharge` → `schema.prisma:L6351`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L9508`
- `OrganizationGoal` → `schema.prisma:L9466`
- `OrganizationModule` → `schema.prisma:L8510`
- `OrganizationPaymentConfig` → `schema.prisma:L4745`
- `OrganizationPayoutConfig` → `schema.prisma:L9541`
- `OrganizationPricingStructure` → `schema.prisma:L4777`
- `OrganizationSalesGoalConfig` → `schema.prisma:L9489`
- `OtpChallenge` → `schema.prisma:L5797`
- `PartnerAPIKey` → `schema.prisma:L4575`
- `Payment` → `schema.prisma:L3176`
- `PaymentAllocation` → `schema.prisma:L3328`
- `PaymentLink` → `schema.prisma:L11043`
- `PaymentLinkAttribution` → `schema.prisma:L11151`
- `PaymentLinkItem` → `schema.prisma:L11106`
- `PaymentLinkItemModifier` → `schema.prisma:L11133`
- `PaymentProvider` → `schema.prisma:L4130`
- `PayrollLine` → `schema.prisma:L13164`
- `PayrollRun` → `schema.prisma:L13133`
- `PerformanceGoal` → `schema.prisma:L9443`
- `PermissionSet` → `schema.prisma:L1142`
- `PlatformCfdi` → `schema.prisma:L13445`
- `PlatformEmisor` → `schema.prisma:L13389`
- `PlatformSettings` → `schema.prisma:L4552`
- `PosCommand` → `schema.prisma:L6534`
- `PosConnectionStatus` → `schema.prisma:L780`
- `PosSyncIntent` (idempotencia + fence monotónico por venue/dispositivo/secuencia) → `schema.prisma:L13523`
- `PricingPolicy` → `schema.prisma:L1999`
- `Printer` → `schema.prisma:L11554`
- `PrintGateway` → `schema.prisma:L11591`
- `PrintJob` → `schema.prisma:L12128`
- `PrintStation` → `schema.prisma:L11609`
- `ProcessedStripeEvent` → `schema.prisma:L5025`
- `ProcessorReliabilityMetric` → `schema.prisma:L5510`
- `Product` → `schema.prisma:L1430`
- `ProductModifierGroup` → `schema.prisma:L3115`
- `ProductOption` → `schema.prisma:L11325`
- `ProductOptionValue` → `schema.prisma:L11336`
- `ProductStaff` → `schema.prisma:L10299`
- `PromoterBankAccount` → `schema.prisma:L13284`
- `PromoterCommissionEntry` → `schema.prisma:L13303`
- `PromoterLocationPing` → `schema.prisma:L2672`
- `ProviderCostStructure` → `schema.prisma:L5061`
- `ProviderEventLog` → `schema.prisma:L4854`
- `PurchaseOrder` → `schema.prisma:L1906`
- `PurchaseOrderItem` → `schema.prisma:L1963`
- `RateCorrectionBatch` → `schema.prisma:L5286`
- `RateCorrectionEntry` → `schema.prisma:L5328`
- `RawMaterial` → `schema.prisma:L1667`
- `RawMaterialMovement` → `schema.prisma:L2052`
- `RawMaterialPresentation` → `schema.prisma:L1740`
- `Recipe` → `schema.prisma:L1760`
- `RecipeLine` → `schema.prisma:L1784`
- `Referral` → `schema.prisma:L5932`
- `ReferralProgramConfig` → `schema.prisma:L5897`
- `ReferralRewardGrant` → `schema.prisma:L6023`
- `ReferralTierReward` → `schema.prisma:L5995`
- `ReferralTierUnlock` → `schema.prisma:L6068`
- `Reservation` → `schema.prisma:L10086`
- `ReservationGoogleEventMapping` → `schema.prisma:L10823`
- `ReservationModifier` → `schema.prisma:L10247`
- `ReservationReminderSent` → `schema.prisma:L10230`
- `ReservationSettings` → `schema.prisma:L10461`
- `ReservationWaitlistEntry` → `schema.prisma:L10429`
- `Review` → `schema.prisma:L3623`
- `SalesRetention` → `schema.prisma:L12984`
- `SaleVerification` → `schema.prisma:L3382`
- `ScaleProfile` → `schema.prisma:L11999`
- `ScheduledCommand` → `schema.prisma:L7958`
- `SerializedItem` → `schema.prisma:L8581`
- `SerializedItemCustodyEvent` → `schema.prisma:L8744`
- `ServiceCharge` → `schema.prisma:L6322`
- `SettlementConfiguration` → `schema.prisma:L5361`
- `SettlementConfirmation` → `schema.prisma:L5474`
- `SettlementIncident` → `schema.prisma:L5425`
- `SettlementSimulation` → `schema.prisma:L5396`
- `Shift` → `schema.prisma:L2520`
- `SimRegistrationRequest` → `schema.prisma:L8782`
- `SimRegistrationRequestItem` → `schema.prisma:L8804`
- `SlotHold` → `schema.prisma:L10330`
- `Staff` → `schema.prisma:L800`
- `StaffOnboardingState` → `schema.prisma:L12199`
- `StaffOrganization` → `schema.prisma:L1056`
- `StaffPasskey` → `schema.prisma:L1083`
- `StaffSchedule` → `schema.prisma:L10270`
- `StaffScheduleException` → `schema.prisma:L10282`
- `StaffVenue` → `schema.prisma:L986`
- `StockAlertConfig` → `schema.prisma:L9425`
- `StockBatch` → `schema.prisma:L2183`
- `StockCount` → `schema.prisma:L2120`
- `StockCountItem` → `schema.prisma:L2141`
- `StripeWebhookEvent` → `schema.prisma:L5008`
- `Supplier` → `schema.prisma:L1819`
- `SupplierPricing` → `schema.prisma:L1872`
- `Table` → `schema.prisma:L2432`
- `Terminal` → `schema.prisma:L3674`
- `TerminalHealth` → `schema.prisma:L3906`
- `TerminalLog` → `schema.prisma:L3880`
- `TerminalOrder` → `schema.prisma:L4033`
- `TerminalOrderItem` → `schema.prisma:L4108`
- `TerminalPaymentRequest` → `schema.prisma:L3977`
- `TimeEntry` → `schema.prisma:L2585`
- `TimeEntryBreak` → `schema.prisma:L2654`
- `TokenPurchase` → `schema.prisma:L7632`
- `TokenUsageRecord` → `schema.prisma:L7604`
- `TpvCommandHistory` → `schema.prisma:L7864`
- `TpvCommandQueue` → `schema.prisma:L7804`
- `TpvFeedback` → `schema.prisma:L7517`
- `TpvMessage` → `schema.prisma:L9782`
- `TpvMessageDelivery` → `schema.prisma:L9834`
- `TpvMessageResponse` → `schema.prisma:L9857`
- `TrainingModule` → `schema.prisma:L9912`
- `TrainingProgress` → `schema.prisma:L9989`
- `TrainingQuizQuestion` → `schema.prisma:L9971`
- `TrainingStep` → `schema.prisma:L9951`
- `TransactionCost` → `schema.prisma:L5224`
- `UnitConversion` → `schema.prisma:L2030`
- `user_sessions` → `schema.prisma:L4610`
- `Venue` → `schema.prisma:L116`
- `VenueAreaTicketSettings` → `schema.prisma:L11761`
- `VenueChatMessage` → `schema.prisma:L664`
- `VenueChatSession` → `schema.prisma:L619`
- `VenueCommission` → `schema.prisma:L11486`
- `VenueCreditAssessment` → `schema.prisma:L8326`
- `VenueCryptoConfig` → `schema.prisma:L9649`
- `VenueFeature` → `schema.prisma:L3496`
- `VenueModule` → `schema.prisma:L8482`
- `VenuePaymentConfig` → `schema.prisma:L4711`
- `VenuePaymentLinkSettings` → `schema.prisma:L10856`
- `VenuePricingStructure` → `schema.prisma:L5164`
- `VenueRoleConfig` → `schema.prisma:L1171`
- `VenueRolePermission` → `schema.prisma:L1113`
- `VenueScaleSettings` → `schema.prisma:L11989`
- `VenueSettings` → `schema.prisma:L704`
- `VenueTransaction` → `schema.prisma:L3433`
- `VenueWhatsappActivation` → `schema.prisma:L555`
- `WebhookEvent` → `schema.prisma:L3532`
- `WebhookSubscription` → `schema.prisma:L4827`
- `WhatsappContactWindow` → `schema.prisma:L573`
- `WhatsappInboundEvent` → `schema.prisma:L593`
- `Zone` → `schema.prisma:L99`
