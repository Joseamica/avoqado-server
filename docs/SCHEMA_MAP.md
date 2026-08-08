# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **294 models / 276 enums / ~13,800 lines**. Nobody reads it top to bottom. This file is the **index**: 21 domains,
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
| 14  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`                                                                                                                                                                                                                                                                                                    |
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

- `AccountingPeriodLock` → `schema.prisma:L13132`
- `AccountMapping` → `schema.prisma:L13028`
- `ActivityLog` → `schema.prisma:L5725`
- `Aggregator` → `schema.prisma:L11653`
- `AngelPayUserAccount` → `schema.prisma:L4434`
- `AppUpdate` → `schema.prisma:L9882`
- `Area` → `schema.prisma:L2495`
- `AreaTicket` → `schema.prisma:L12072`
- `AreaTicketCheckoutSession` → `schema.prisma:L12184`
- `AreaTicketFulfillment` → `schema.prisma:L12260`
- `AreaTicketInventoryReservation` → `schema.prisma:L12159`
- `AreaTicketLine` → `schema.prisma:L12127`
- `AreaTicketPaymentAttempt` → `schema.prisma:L12216`
- `AreaTicketPrintAttempt` → `schema.prisma:L12239`
- `BankStatement` → `schema.prisma:L12902`
- `BankStatementLine` → `schema.prisma:L12923`
- `BillingTaxProfile` → `schema.prisma:L13712`
- `BulkCommandOperation` → `schema.prisma:L8203`
- `CalendarSyncOutbox` → `schema.prisma:L11056`
- `CampaignDelivery` → `schema.prisma:L10040`
- `CashCloseout` → `schema.prisma:L8568`
- `CashDeposit` → `schema.prisma:L9684`
- `CashDrawerEvent` → `schema.prisma:L11499`
- `CashDrawerSession` → `schema.prisma:L11475`
- `CashOutCommissionRate` → `schema.prisma:L13541`
- `CashOutScheduleDay` → `schema.prisma:L13564`
- `CashOutWithdrawal` → `schema.prisma:L13626`
- `Cfdi` → `schema.prisma:L12805`
- `ChatbotTokenBudget` → `schema.prisma:L7851`
- `ChatConversation` → `schema.prisma:L7706`
- `ChatFeedback` → `schema.prisma:L7792`
- `ChatLearningEvent` → `schema.prisma:L7749`
- `ChatMessage` → `schema.prisma:L7729`
- `ChatTrainingData` → `schema.prisma:L7663`
- `CheckoutSession` → `schema.prisma:L4714`
- `ClassSession` → `schema.prisma:L10674`
- `CommissionCalculation` → `schema.prisma:L9463`
- `CommissionClawback` → `schema.prisma:L9636`
- `CommissionConfig` → `schema.prisma:L9236`
- `CommissionMilestone` → `schema.prisma:L9379`
- `CommissionOverride` → `schema.prisma:L9306`
- `CommissionPayout` → `schema.prisma:L9587`
- `CommissionSummary` → `schema.prisma:L9526`
- `CommissionTier` → `schema.prisma:L9343`
- `Consumer` → `schema.prisma:L5846`
- `ConsumerAuthAccount` → `schema.prisma:L5871`
- `CouponCode` → `schema.prisma:L6474`
- `CouponRedemption` → `schema.prisma:L6505`
- `CreditAssessmentHistory` → `schema.prisma:L8677`
- `CreditItemBalance` → `schema.prisma:L11265`
- `CreditOffer` → `schema.prisma:L8696`
- `CreditPack` → `schema.prisma:L11181`
- `CreditPackItem` → `schema.prisma:L11210`
- `CreditPackPurchase` → `schema.prisma:L11227`
- `CreditTransaction` → `schema.prisma:L11287`
- `Customer` → `schema.prisma:L5751`
- `CustomerDiscount` → `schema.prisma:L6525`
- `CustomerGroup` → `schema.prisma:L5905`
- `CustomerTaxProfile` → `schema.prisma:L12874`
- `DeliveryActivationRequest` → `schema.prisma:L5036`
- `DeliveryChannelLink` → `schema.prisma:L5000`
- `DeliveryOrderEvent` → `schema.prisma:L5060`
- `DeviceToken` → `schema.prisma:L6794`
- `DigitalReceipt` → `schema.prisma:L3442`
- `Discount` → `schema.prisma:L6177`
- `EcommerceMerchant` → `schema.prisma:L4526`
- `EmailTemplate` → `schema.prisma:L9979`
- `Employee` → `schema.prisma:L13389`
- `Estimate` → `schema.prisma:L11560`
- `EstimateItem` → `schema.prisma:L11588`
- `Expense` → `schema.prisma:L13176`
- `ExternalBusyBlock` → `schema.prisma:L10949`
- `Feature` → `schema.prisma:L3571`
- `FeeSchedule` → `schema.prisma:L3649`
- `FeeTier` → `schema.prisma:L3660`
- `FinancialAccount` → `schema.prisma:L11750`
- `FinancialConnection` → `schema.prisma:L11719`
- `FinancialProvider` → `schema.prisma:L11705`
- `FiscalEmisor` → `schema.prisma:L12728`
- `FiscalLossCarryforward` → `schema.prisma:L13299`
- `FixedAsset` → `schema.prisma:L13317`
- `FixedAssetDepreciation` → `schema.prisma:L13346`
- `FloorElement` → `schema.prisma:L2571`
- `FulfillmentArea` → `schema.prisma:L11945`
- `GeofenceRule` → `schema.prisma:L8288`
- `GoogleCalendarChannel` → `schema.prisma:L10926`
- `GoogleCalendarConnection` → `schema.prisma:L10878`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L10979`
- `GoogleOAuthSession` → `schema.prisma:L11001`
- `HolidayCalendar` → `schema.prisma:L5649`
- `IdempotencyRequest` → `schema.prisma:L9111`
- `InterVenueTransfer` → `schema.prisma:L2323`
- `InterVenueTransferAllocation` → `schema.prisma:L2406`
- `InterVenueTransferItem` → `schema.prisma:L2375`
- `InterVenueTransferReceipt` → `schema.prisma:L2433`
- `InterVenueTransferReceiptLine` → `schema.prisma:L2449`
- `InterVenueTransferVarianceLine` → `schema.prisma:L2477`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L2461`
- `Inventory` → `schema.prisma:L1646`
- `InventoryMovement` → `schema.prisma:L1673`
- `InventoryTransfer` → `schema.prisma:L11532`
- `Invitation` → `schema.prisma:L1210`
- `Invoice` → `schema.prisma:L3672`
- `InvoiceItem` → `schema.prisma:L3698`
- `ItemCategory` → `schema.prisma:L8828`
- `JournalEntry` → `schema.prisma:L13086`
- `JournalLine` → `schema.prisma:L13114`
- `KdsOrder` → `schema.prisma:L11798`
- `KdsOrderItem` → `schema.prisma:L11815`
- `LearnedPatterns` → `schema.prisma:L7773`
- `LedgerAccount` → `schema.prisma:L12978`
- `LiveDemoSession` → `schema.prisma:L703`
- `LowStockAlert` → `schema.prisma:L2177`
- `LoyaltyConfig` → `schema.prisma:L5935`
- `LoyaltyTransaction` → `schema.prisma:L5958`
- `MarketingCampaign` → `schema.prisma:L9997`
- `McpAuthCode` → `schema.prisma:L12611`
- `McpOAuthClient` → `schema.prisma:L12595`
- `McpRefreshToken` → `schema.prisma:L12629`
- `McpToolCall` → `schema.prisma:L12650`
- `MeasurementUnit` → `schema.prisma:L11638`
- `Menu` → `schema.prisma:L1396`
- `MenuCategory` → `schema.prisma:L1333`
- `MenuCategoryAssignment` → `schema.prisma:L1431`
- `MercadoPagoWebhookEvent` → `schema.prisma:L12525`
- `MerchantAccount` → `schema.prisma:L4264`
- `MerchantFiscalConfig` → `schema.prisma:L12776`
- `MerchantRevenueShare` → `schema.prisma:L5229`
- `MerchantRoutingRule` → `schema.prisma:L4386`
- `MilestoneAchievement` → `schema.prisma:L9424`
- `Modifier` → `schema.prisma:L3171`
- `ModifierGroup` → `schema.prisma:L3135`
- `Module` → `schema.prisma:L8744`
- `MoneyAnomaly` → `schema.prisma:L5132`
- `MonthlyVenueProfit` → `schema.prisma:L5675`
- `Notification` → `schema.prisma:L6696`
- `NotificationPreference` → `schema.prisma:L6743`
- `NotificationTemplate` → `schema.prisma:L6770`
- `OAuthState` → `schema.prisma:L1261`
- `OnboardingProgress` → `schema.prisma:L1279`
- `Order` → `schema.prisma:L2795`
- `OrderAction` → `schema.prisma:L3236`
- `OrderCustomer` → `schema.prisma:L2992`
- `OrderDiscount` → `schema.prisma:L6557`
- `OrderFulfillment` → `schema.prisma:L11992`
- `OrderFulfillmentLine` → `schema.prisma:L12023`
- `OrderItem` → `schema.prisma:L3008`
- `OrderItemModifier` → `schema.prisma:L3220`
- `OrderServiceCharge` → `schema.prisma:L6641`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L9798`
- `OrganizationGoal` → `schema.prisma:L9756`
- `OrganizationModule` → `schema.prisma:L8800`
- `OrganizationPaymentConfig` → `schema.prisma:L4838`
- `OrganizationPayoutConfig` → `schema.prisma:L9831`
- `OrganizationPricingStructure` → `schema.prisma:L4870`
- `OrganizationSalesGoalConfig` → `schema.prisma:L9779`
- `OtpChallenge` → `schema.prisma:L5890`
- `PartnerAPIKey` → `schema.prisma:L4668`
- `Payment` → `schema.prisma:L3269`
- `PaymentAllocation` → `schema.prisma:L3421`
- `PaymentLink` → `schema.prisma:L11333`
- `PaymentLinkAttribution` → `schema.prisma:L11441`
- `PaymentLinkItem` → `schema.prisma:L11396`
- `PaymentLinkItemModifier` → `schema.prisma:L11423`
- `PaymentProvider` → `schema.prisma:L4223`
- `PayrollLine` → `schema.prisma:L13460`
- `PayrollRun` → `schema.prisma:L13429`
- `PerformanceGoal` → `schema.prisma:L9733`
- `PermissionSet` → `schema.prisma:L1161`
- `PlatformCfdi` → `schema.prisma:L13745`
- `PlatformEmisor` → `schema.prisma:L13685`
- `PlatformSettings` → `schema.prisma:L4645`
- `PosCommand` → `schema.prisma:L6824`
- `PosConnectionStatus` → `schema.prisma:L795`
- `PosSyncIntent` → `schema.prisma:L13823`
- `PricingPolicy` → `schema.prisma:L2088`
- `Printer` → `schema.prisma:L11844`
- `PrintGateway` → `schema.prisma:L11881`
- `PrintJob` → `schema.prisma:L12424`
- `PrintStation` → `schema.prisma:L11899`
- `ProcessedStripeEvent` → `schema.prisma:L5118`
- `ProcessorReliabilityMetric` → `schema.prisma:L5603`
- `Product` → `schema.prisma:L1449`
- `ProductModifierGroup` → `schema.prisma:L3208`
- `ProductOption` → `schema.prisma:L11615`
- `ProductOptionValue` → `schema.prisma:L11626`
- `ProductStaff` → `schema.prisma:L10589`
- `PromoterBankAccount` → `schema.prisma:L13580`
- `PromoterCommissionEntry` → `schema.prisma:L13599`
- `PromoterLocationPing` → `schema.prisma:L2761`
- `ProviderCostStructure` → `schema.prisma:L5154`
- `ProviderEventLog` → `schema.prisma:L4947`
- `PurchaseOrder` → `schema.prisma:L1956`
- `PurchaseOrderItem` → `schema.prisma:L2013`
- `RateCorrectionBatch` → `schema.prisma:L5379`
- `RateCorrectionEntry` → `schema.prisma:L5421`
- `RawMaterial` → `schema.prisma:L1717`
- `RawMaterialMovement` → `schema.prisma:L2141`
- `RawMaterialPresentation` → `schema.prisma:L1790`
- `Recipe` → `schema.prisma:L1810`
- `RecipeLine` → `schema.prisma:L1834`
- `Referral` → `schema.prisma:L6025`
- `ReferralProgramConfig` → `schema.prisma:L5990`
- `ReferralRewardGrant` → `schema.prisma:L6116`
- `ReferralTierReward` → `schema.prisma:L6088`
- `ReferralTierUnlock` → `schema.prisma:L6161`
- `Reservation` → `schema.prisma:L10376`
- `ReservationGoogleEventMapping` → `schema.prisma:L11113`
- `ReservationModifier` → `schema.prisma:L10537`
- `ReservationReminderSent` → `schema.prisma:L10520`
- `ReservationSettings` → `schema.prisma:L10751`
- `ReservationWaitlistEntry` → `schema.prisma:L10719`
- `Review` → `schema.prisma:L3716`
- `SalesRetention` → `schema.prisma:L13280`
- `SaleVerification` → `schema.prisma:L3475`
- `ScaleProfile` → `schema.prisma:L12295`
- `ScheduledCommand` → `schema.prisma:L8248`
- `SerializedItem` → `schema.prisma:L8871`
- `SerializedItemCustodyEvent` → `schema.prisma:L9034`
- `ServiceCharge` → `schema.prisma:L6612`
- `SettlementConfiguration` → `schema.prisma:L5454`
- `SettlementConfirmation` → `schema.prisma:L5567`
- `SettlementIncident` → `schema.prisma:L5518`
- `SettlementSimulation` → `schema.prisma:L5489`
- `Shift` → `schema.prisma:L2609`
- `SimRegistrationRequest` → `schema.prisma:L9072`
- `SimRegistrationRequestItem` → `schema.prisma:L9094`
- `SlotHold` → `schema.prisma:L10620`
- `Staff` → `schema.prisma:L815`
- `StaffOnboardingState` → `schema.prisma:L12495`
- `StaffOrganization` → `schema.prisma:L1075`
- `StaffPasskey` → `schema.prisma:L1102`
- `StaffSchedule` → `schema.prisma:L10560`
- `StaffScheduleException` → `schema.prisma:L10572`
- `StaffVenue` → `schema.prisma:L1004`
- `StockAlertConfig` → `schema.prisma:L9715`
- `StockBatch` → `schema.prisma:L2272`
- `StockCount` → `schema.prisma:L2209`
- `StockCountItem` → `schema.prisma:L2230`
- `StripeWebhookEvent` → `schema.prisma:L5101`
- `Supplier` → `schema.prisma:L1869`
- `SupplierPricing` → `schema.prisma:L1922`
- `Table` → `schema.prisma:L2521`
- `Terminal` → `schema.prisma:L3767`
- `TerminalHealth` → `schema.prisma:L3999`
- `TerminalLog` → `schema.prisma:L3973`
- `TerminalOrder` → `schema.prisma:L4126`
- `TerminalOrderItem` → `schema.prisma:L4201`
- `TerminalPaymentRequest` → `schema.prisma:L4070`
- `TimeEntry` → `schema.prisma:L2674`
- `TimeEntryBreak` → `schema.prisma:L2743`
- `TokenPurchase` → `schema.prisma:L7922`
- `TokenUsageRecord` → `schema.prisma:L7894`
- `TpvCommandHistory` → `schema.prisma:L8154`
- `TpvCommandQueue` → `schema.prisma:L8094`
- `TpvFeedback` → `schema.prisma:L7807`
- `TpvMessage` → `schema.prisma:L10072`
- `TpvMessageDelivery` → `schema.prisma:L10124`
- `TpvMessageResponse` → `schema.prisma:L10147`
- `TrainingModule` → `schema.prisma:L10202`
- `TrainingProgress` → `schema.prisma:L10279`
- `TrainingQuizQuestion` → `schema.prisma:L10261`
- `TrainingStep` → `schema.prisma:L10241`
- `TransactionCost` → `schema.prisma:L5317`
- `UnitConversion` → `schema.prisma:L2119`
- `UpsellAcceptance` → `schema.prisma:L6433`
- `UpsellAiRun` → `schema.prisma:L6453`
- `UpsellImpression` → `schema.prisma:L6393`
- `UpsellRule` → `schema.prisma:L6323`
- `user_sessions` → `schema.prisma:L4703`
- `Venue` → `schema.prisma:L116`
- `VenueAreaTicketSettings` → `schema.prisma:L12051`
- `VenueChatMessage` → `schema.prisma:L679`
- `VenueChatSession` → `schema.prisma:L634`
- `VenueCommission` → `schema.prisma:L11776`
- `VenueCreditAssessment` → `schema.prisma:L8616`
- `VenueCryptoConfig` → `schema.prisma:L9939`
- `VenueFeature` → `schema.prisma:L3589`
- `VenueModule` → `schema.prisma:L8772`
- `VenuePaymentConfig` → `schema.prisma:L4804`
- `VenuePaymentLinkSettings` → `schema.prisma:L11146`
- `VenuePricingStructure` → `schema.prisma:L5257`
- `VenueRoleConfig` → `schema.prisma:L1190`
- `VenueRolePermission` → `schema.prisma:L1132`
- `VenueScaleSettings` → `schema.prisma:L12283`
- `VenueSettings` → `schema.prisma:L719`
- `VenueTransaction` → `schema.prisma:L3526`
- `VenueWhatsappActivation` → `schema.prisma:L570`
- `WebhookEvent` → `schema.prisma:L3625`
- `WebhookSubscription` → `schema.prisma:L4920`
- `WhatsappContactWindow` → `schema.prisma:L588`
- `WhatsappInboundEvent` → `schema.prisma:L608`
- `Zone` → `schema.prisma:L99`
