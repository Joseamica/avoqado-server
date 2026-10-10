# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **400 models / 371 enums / ~18,800 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `CapabilityGrant`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `HybridBillingOperation`, `HybridCampaign`, `HybridContract`, `HybridContractSelection`, `HybridCreditAllocation`, `HybridOfferPublication`, `HybridPaymentPeriod`, `HybridPromotionGroup`, `HybridPurchase`, `HybridRedemption`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                               |
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
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `AggregatorBooking`, `AggregatorCapacityRule`, `AggregatorConnection`, `AggregatorInboundEvent`, `AggregatorOutbox`, `AggregatorProductLink`, `AggregatorSessionLink`, `AggregatorVisit`, `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                 |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalAttemptResolution`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerExternalIdentity`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L17443`
- `AccountMapping` → `schema.prisma:L17338`
- `ActivityLog` → `schema.prisma:L7516`
- `Aggregator` → `schema.prisma:L15605`
- `AggregatorBooking` → `schema.prisma:L14913`
- `AggregatorCapacityRule` → `schema.prisma:L14894`
- `AggregatorConnection` → `schema.prisma:L14819`
- `AggregatorInboundEvent` → `schema.prisma:L14982`
- `AggregatorOutbox` → `schema.prisma:L15002`
- `AggregatorProductLink` → `schema.prisma:L14851`
- `AggregatorSessionLink` → `schema.prisma:L14870`
- `AggregatorVisit` → `schema.prisma:L14939`
- `AngelPayUserAccount` → `schema.prisma:L6061`
- `AppUpdate` → `schema.prisma:L13487`
- `Area` → `schema.prisma:L3248`
- `AreaTicket` → `schema.prisma:L16141`
- `AreaTicketCheckoutSession` → `schema.prisma:L16263`
- `AreaTicketExternalIncident` → `schema.prisma:L16510`
- `AreaTicketExternalSettlement` → `schema.prisma:L16475`
- `AreaTicketFulfillment` → `schema.prisma:L16339`
- `AreaTicketInventoryReservation` → `schema.prisma:L16234`
- `AreaTicketLine` → `schema.prisma:L16202`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16295`
- `AreaTicketPrintAttempt` → `schema.prisma:L16318`
- `BankStatement` → `schema.prisma:L17212`
- `BankStatementLine` → `schema.prisma:L17233`
- `BillingObligationConflict` → `schema.prisma:L5091`
- `BillingTaxProfile` → `schema.prisma:L18035`
- `BirthdayAutomation` → `schema.prisma:L7840`
- `BulkCommandOperation` → `schema.prisma:L10767`
- `CalendarSyncOutbox` → `schema.prisma:L14702`
- `CampaignDelivery` → `schema.prisma:L13645`
- `CapabilityGrant` → `schema.prisma:L4831`
- `CashCloseout` → `schema.prisma:L11152`
- `CashDeposit` → `schema.prisma:L13289`
- `CashDrawerEvent` → `schema.prisma:L15442`
- `CashDrawerSession` → `schema.prisma:L15403`
- `CashOutCommissionRate` → `schema.prisma:L17852`
- `CashOutScheduleDay` → `schema.prisma:L17875`
- `CashOutWithdrawal` → `schema.prisma:L17937`
- `CatalogBindingBatch` → `schema.prisma:L12183`
- `CatalogBindingLine` → `schema.prisma:L12219`
- `CatalogBrand` → `schema.prisma:L11636`
- `CatalogClientObservation` → `schema.prisma:L11949`
- `CatalogClientReadinessOverride` → `schema.prisma:L11968`
- `CatalogFamily` → `schema.prisma:L11686`
- `CatalogIdempotencyRecord` → `schema.prisma:L12082`
- `CatalogIdentifier` → `schema.prisma:L11817`
- `CatalogImportBatch` → `schema.prisma:L12125`
- `CatalogImportLine` → `schema.prisma:L12162`
- `CatalogItem` → `schema.prisma:L11719`
- `CatalogItemBusinessType` → `schema.prisma:L11779`
- `CatalogItemPrice` → `schema.prisma:L11867`
- `CatalogManufacturer` → `schema.prisma:L11660`
- `CatalogProductTypeMapping` → `schema.prisma:L11796`
- `CatalogPublicationBatch` → `schema.prisma:L12247`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12341`
- `CatalogPublicationLine` → `schema.prisma:L12288`
- `CatalogPublicationOutbox` → `schema.prisma:L12384`
- `CatalogValidationProfile` → `schema.prisma:L11838`
- `CatalogVenueBinding` → `schema.prisma:L11996`
- `CatalogVenueClientRequirement` → `schema.prisma:L11923`
- `CatalogVenueEventSequence` → `schema.prisma:L12367`
- `CatalogVenueOverride` → `schema.prisma:L12038`
- `CatalogVenueRollout` → `schema.prisma:L11898`
- `Cfdi` → `schema.prisma:L17036`
- `CfdiGlobalOrden` → `schema.prisma:L17165`
- `ChatbotTokenBudget` → `schema.prisma:L10413`
- `ChatConversation` → `schema.prisma:L10268`
- `ChatFeedback` → `schema.prisma:L10354`
- `ChatLearningEvent` → `schema.prisma:L10311`
- `ChatMessage` → `schema.prisma:L10291`
- `ChatTrainingData` → `schema.prisma:L10225`
- `CheckoutSession` → `schema.prisma:L6341`
- `ClassSession` → `schema.prisma:L14303`
- `CommissionCalculation` → `schema.prisma:L13065`
- `CommissionClawback` → `schema.prisma:L13241`
- `CommissionConfig` → `schema.prisma:L12831`
- `CommissionMilestone` → `schema.prisma:L12981`
- `CommissionOverride` → `schema.prisma:L12908`
- `CommissionPayout` → `schema.prisma:L13192`
- `CommissionSummary` → `schema.prisma:L13131`
- `CommissionTier` → `schema.prisma:L12945`
- `ConsentEvent` → `schema.prisma:L7702`
- `Consumer` → `schema.prisma:L7932`
- `ConsumerAuthAccount` → `schema.prisma:L7957`
- `CouponCode` → `schema.prisma:L8904`
- `CouponRedemption` → `schema.prisma:L8935`
- `CreditAssessmentHistory` → `schema.prisma:L11261`
- `CreditItemBalance` → `schema.prisma:L15193`
- `CreditOffer` → `schema.prisma:L11280`
- `CreditPack` → `schema.prisma:L15102`
- `CreditPackItem` → `schema.prisma:L15131`
- `CreditPackPurchase` → `schema.prisma:L15148`
- `CreditTransaction` → `schema.prisma:L15215`
- `Customer` → `schema.prisma:L7557`
- `CustomerApprovalDelivery` → `schema.prisma:L9927`
- `CustomerApprovalOutbox` → `schema.prisma:L9902`
- `CustomerCampaign` → `schema.prisma:L7790`
- `CustomerCampaignDelivery` → `schema.prisma:L7872`
- `CustomerCaptureToken` → `schema.prisma:L7738`
- `CustomerDiscount` → `schema.prisma:L8955`
- `CustomerExternalIdentity` → `schema.prisma:L14969`
- `CustomerGroup` → `schema.prisma:L7996`
- `CustomerOrderMetric` → `schema.prisma:L4047`
- `CustomerTaxProfile` → `schema.prisma:L17184`
- `DeliveryActivationRequest` → `schema.prisma:L6800`
- `DeliveryChannelLink` → `schema.prisma:L6639`
- `DeliveryConnectIntent` → `schema.prisma:L6751`
- `DeliveryLineAction` → `schema.prisma:L6712`
- `DeliveryOrderEvent` → `schema.prisma:L6824`
- `DeliveryStoreRevocation` → `schema.prisma:L6788`
- `DeviceToken` → `schema.prisma:L9229`
- `DigitalReceipt` → `schema.prisma:L4644`
- `Discount` → `schema.prisma:L8594`
- `EcommerceMerchant` → `schema.prisma:L6153`
- `EmailQuotaLedger` → `schema.prisma:L7919`
- `EmailSuppression` → `schema.prisma:L7907`
- `EmailTemplate` → `schema.prisma:L13584`
- `Employee` → `schema.prisma:L17700`
- `Estimate` → `schema.prisma:L15512`
- `EstimateItem` → `schema.prisma:L15540`
- `Expense` → `schema.prisma:L17487`
- `ExternalBusyBlock` → `schema.prisma:L14595`
- `Feature` → `schema.prisma:L4773`
- `FeeSchedule` → `schema.prisma:L5153`
- `FeeTier` → `schema.prisma:L5164`
- `FinancialAccount` → `schema.prisma:L15702`
- `FinancialConnection` → `schema.prisma:L15671`
- `FinancialProvider` → `schema.prisma:L15657`
- `FiscalEmisor` → `schema.prisma:L16947`
- `FiscalLossCarryforward` → `schema.prisma:L17610`
- `FixedAsset` → `schema.prisma:L17628`
- `FixedAssetDepreciation` → `schema.prisma:L17657`
- `FloorElement` → `schema.prisma:L3324`
- `FulfillmentArea` → `schema.prisma:L16006`
- `GeofenceRule` → `schema.prisma:L10852`
- `GoogleCalendarChannel` → `schema.prisma:L14572`
- `GoogleCalendarConnection` → `schema.prisma:L14524`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14625`
- `GoogleOAuthSession` → `schema.prisma:L14647`
- `HolidayCalendar` → `schema.prisma:L7440`
- `HybridBillingOperation` → `schema.prisma:L5015`
- `HybridCampaign` → `schema.prisma:L4856`
- `HybridContract` → `schema.prisma:L4972`
- `HybridContractSelection` → `schema.prisma:L5004`
- `HybridCreditAllocation` → `schema.prisma:L5071`
- `HybridOfferPublication` → `schema.prisma:L4919`
- `HybridPaymentPeriod` → `schema.prisma:L5050`
- `HybridPromotionGroup` → `schema.prisma:L4900`
- `HybridPurchase` → `schema.prisma:L4939`
- `HybridRedemption` → `schema.prisma:L5033`
- `IdempotencyRequest` → `schema.prisma:L12706`
- `InterVenueTransfer` → `schema.prisma:L3076`
- `InterVenueTransferAllocation` → `schema.prisma:L3159`
- `InterVenueTransferItem` → `schema.prisma:L3128`
- `InterVenueTransferReceipt` → `schema.prisma:L3186`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3202`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3230`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3214`
- `Inventory` → `schema.prisma:L2020`
- `InventoryMovement` → `schema.prisma:L2120`
- `InventoryPosting` → `schema.prisma:L2215`
- `InventoryPostingLine` → `schema.prisma:L2255`
- `InventoryTransfer` → `schema.prisma:L15484`
- `InventoryWasteReport` → `schema.prisma:L2075`
- `Invitation` → `schema.prisma:L1514`
- `Invoice` → `schema.prisma:L5176`
- `InvoiceItem` → `schema.prisma:L5202`
- `ItemCategory` → `schema.prisma:L12419`
- `JournalEntry` → `schema.prisma:L17396`
- `JournalLine` → `schema.prisma:L17425`
- `KdsOrder` → `schema.prisma:L15750`
- `KdsOrderItem` → `schema.prisma:L15813`
- `KioskCheckInAttempt` → `schema.prisma:L18358`
- `KioskCheckInChallenge` → `schema.prisma:L18312`
- `KioskOutreachOutbox` → `schema.prisma:L18379`
- `LaunchCampaign` → `schema.prisma:L18717`
- `LaunchCampaignRedemption` → `schema.prisma:L18834`
- `LearnedPatterns` → `schema.prisma:L10335`
- `LedgerAccount` → `schema.prisma:L17288`
- `LiveDemoSession` → `schema.prisma:L840`
- `LowStockAlert` → `schema.prisma:L2910`
- `LoyaltyConfig` → `schema.prisma:L8026`
- `LoyaltyTransaction` → `schema.prisma:L8069`
- `MarketingCampaign` → `schema.prisma:L13602`
- `McpAuthCode` → `schema.prisma:L16829`
- `McpOAuthClient` → `schema.prisma:L16813`
- `McpRefreshToken` → `schema.prisma:L16847`
- `McpToolCall` → `schema.prisma:L16869`
- `MeasurementUnit` → `schema.prisma:L15590`
- `Menu` → `schema.prisma:L1732`
- `MenuCategory` → `schema.prisma:L1669`
- `MenuCategoryAssignment` → `schema.prisma:L1767`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16743`
- `MerchantAccount` → `schema.prisma:L5891`
- `MerchantFiscalConfig` → `schema.prisma:L17007`
- `MerchantRevenueShare` → `schema.prisma:L7020`
- `MerchantRoutingRule` → `schema.prisma:L6013`
- `MilestoneAchievement` → `schema.prisma:L13026`
- `Modifier` → `schema.prisma:L4246`
- `ModifierGroup` → `schema.prisma:L4210`
- `Module` → `schema.prisma:L11328`
- `MoneyAnomaly` → `schema.prisma:L6923`
- `MonthlyVenueProfit` → `schema.prisma:L7466`
- `Notification` → `schema.prisma:L9131`
- `NotificationPreference` → `schema.prisma:L9178`
- `NotificationTemplate` → `schema.prisma:L9205`
- `OAuthState` → `schema.prisma:L1565`
- `OnboardingProgress` → `schema.prisma:L1583`
- `Order` → `schema.prisma:L3773`
- `OrderAction` → `schema.prisma:L4317`
- `OrderCustomer` → `schema.prisma:L4026`
- `OrderDiscount` → `schema.prisma:L8987`
- `OrderFulfillment` → `schema.prisma:L16061`
- `OrderFulfillmentLine` → `schema.prisma:L16092`
- `OrderItem` → `schema.prisma:L4062`
- `OrderItemModifier` → `schema.prisma:L4299`
- `OrderItemSelloIva` → `schema.prisma:L17145`
- `OrderPromotion` → `schema.prisma:L18275`
- `OrderServiceCharge` → `schema.prisma:L9076`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13403`
- `OrganizationEntitlement` → `schema.prisma:L11611`
- `OrganizationGoal` → `schema.prisma:L13361`
- `OrganizationModule` → `schema.prisma:L11388`
- `OrganizationPaymentConfig` → `schema.prisma:L6465`
- `OrganizationPayoutConfig` → `schema.prisma:L13436`
- `OrganizationPricingStructure` → `schema.prisma:L6497`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13384`
- `OtpChallenge` → `schema.prisma:L7976`
- `OvertimeApproval` → `schema.prisma:L3551`
- `PartnerAPIKey` → `schema.prisma:L6295`
- `Payment` → `schema.prisma:L4350`
- `PaymentAllocation` → `schema.prisma:L4623`
- `PaymentEffect` → `schema.prisma:L18649`
- `PaymentLink` → `schema.prisma:L15261`
- `PaymentLinkAttribution` → `schema.prisma:L15369`
- `PaymentLinkItem` → `schema.prisma:L15324`
- `PaymentLinkItemModifier` → `schema.prisma:L15351`
- `PaymentProvider` → `schema.prisma:L5850`
- `PayrollLine` → `schema.prisma:L17771`
- `PayrollRun` → `schema.prisma:L17740`
- `PerformanceGoal` → `schema.prisma:L13338`
- `PermissionOverride` → `schema.prisma:L1438`
- `PermissionSet` → `schema.prisma:L1461`
- `PlatformAnnouncement` → `schema.prisma:L18439`
- `PlatformAnnouncementClick` → `schema.prisma:L18504`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18541`
- `PlatformCfdi` → `schema.prisma:L18068`
- `PlatformEmisor` → `schema.prisma:L18008`
- `PlatformSettings` → `schema.prisma:L6272`
- `PosCommand` → `schema.prisma:L9259`
- `PosConnectionStatus` → `schema.prisma:L984`
- `PosSyncIntent` → `schema.prisma:L18146`
- `PricingPolicy` → `schema.prisma:L2806`
- `Printer` → `schema.prisma:L15862`
- `PrintGateway` → `schema.prisma:L15919`
- `PrintJob` → `schema.prisma:L16642`
- `PrintStation` → `schema.prisma:L15937`
- `PrivacyNoticeVersion` → `schema.prisma:L7724`
- `ProcessedStripeEvent` → `schema.prisma:L6909`
- `ProcessorReliabilityMetric` → `schema.prisma:L7394`
- `Product` → `schema.prisma:L1785`
- `ProductModifierGroup` → `schema.prisma:L4287`
- `ProductOption` → `schema.prisma:L15567`
- `ProductOptionValue` → `schema.prisma:L15578`
- `ProductStaff` → `schema.prisma:L14218`
- `PromoterBankAccount` → `schema.prisma:L17891`
- `PromoterCommissionEntry` → `schema.prisma:L17910`
- `PromoterLocationPing` → `schema.prisma:L3739`
- `Promotion` → `schema.prisma:L18197`
- `PromotionGroup` → `schema.prisma:L18236`
- `PromotionOption` → `schema.prisma:L18252`
- `ProviderCostStructure` → `schema.prisma:L6945`
- `ProviderEventLog` → `schema.prisma:L6574`
- `PurchaseOrder` → `schema.prisma:L2531`
- `PurchaseOrderInvoice` → `schema.prisma:L2676`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2733`
- `PurchaseOrderItem` → `schema.prisma:L2589`
- `RateCorrectionBatch` → `schema.prisma:L7170`
- `RateCorrectionEntry` → `schema.prisma:L7212`
- `RawMaterial` → `schema.prisma:L2287`
- `RawMaterialMovement` → `schema.prisma:L2859`
- `RawMaterialPresentation` → `schema.prisma:L2363`
- `ReceiptLayout` → `schema.prisma:L18683`
- `Recipe` → `schema.prisma:L2383`
- `RecipeLine` → `schema.prisma:L2407`
- `Referral` → `schema.prisma:L8442`
- `ReferralProgramConfig` → `schema.prisma:L8407`
- `ReferralRewardGrant` → `schema.prisma:L8533`
- `ReferralTierReward` → `schema.prisma:L8505`
- `ReferralTierUnlock` → `schema.prisma:L8578`
- `RefreshGrant` → `schema.prisma:L18628`
- `Reservation` → `schema.prisma:L13981`
- `ReservationGoogleEventMapping` → `schema.prisma:L15034`
- `ReservationModifier` → `schema.prisma:L14166`
- `ReservationReminderSent` → `schema.prisma:L14149`
- `ReservationSettings` → `schema.prisma:L14383`
- `ReservationWaitlistEntry` → `schema.prisma:L14351`
- `Review` → `schema.prisma:L5220`
- `SalesRetention` → `schema.prisma:L17591`
- `SaleVerification` → `schema.prisma:L4677`
- `ScaleProfile` → `schema.prisma:L16383`
- `ScheduledCommand` → `schema.prisma:L10812`
- `SerializedItem` → `schema.prisma:L12462`
- `SerializedItemCustodyEvent` → `schema.prisma:L12629`
- `ServiceCharge` → `schema.prisma:L9047`
- `Session` → `schema.prisma:L18607`
- `SettlementConfiguration` → `schema.prisma:L7245`
- `SettlementConfirmation` → `schema.prisma:L7358`
- `SettlementIncident` → `schema.prisma:L7309`
- `SettlementSimulation` → `schema.prisma:L7280`
- `Shift` → `schema.prisma:L3362`
- `SimRegistrationRequest` → `schema.prisma:L12667`
- `SimRegistrationRequestItem` → `schema.prisma:L12689`
- `SlotHold` → `schema.prisma:L14249`
- `Staff` → `schema.prisma:L1004`
- `StaffDocument` → `schema.prisma:L3610`
- `StaffOnboardingState` → `schema.prisma:L16713`
- `StaffOrganization` → `schema.prisma:L1337`
- `StaffPasskey` → `schema.prisma:L1364`
- `StaffSchedule` → `schema.prisma:L14189`
- `StaffScheduleException` → `schema.prisma:L14201`
- `StaffVenue` → `schema.prisma:L1261`
- `StaffWorkSchedule` → `schema.prisma:L3487`
- `StaffWorkScheduleException` → `schema.prisma:L3585`
- `StampCard` → `schema.prisma:L8290`
- `StampEvent` → `schema.prisma:L8329`
- `StampReward` → `schema.prisma:L8367`
- `StockAlertConfig` → `schema.prisma:L13320`
- `StockBatch` → `schema.prisma:L3025`
- `StockCount` → `schema.prisma:L2942`
- `StockCountItem` → `schema.prisma:L2970`
- `StripeWebhookEvent` → `schema.prisma:L6892`
- `Supplier` → `schema.prisma:L2442`
- `SupplierItemCode` → `schema.prisma:L2774`
- `SupplierPricing` → `schema.prisma:L2497`
- `Table` → `schema.prisma:L3274`
- `Terminal` → `schema.prisma:L5271`
- `TerminalAttemptResolution` → `schema.prisma:L5709`
- `TerminalHealth` → `schema.prisma:L5529`
- `TerminalLog` → `schema.prisma:L5503`
- `TerminalOrder` → `schema.prisma:L5753`
- `TerminalOrderItem` → `schema.prisma:L5828`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5681`
- `TerminalPaymentRequest` → `schema.prisma:L5600`
- `TimeEntry` → `schema.prisma:L3652`
- `TimeEntryBreak` → `schema.prisma:L3721`
- `TokenPurchase` → `schema.prisma:L10484`
- `TokenUsageRecord` → `schema.prisma:L10456`
- `TpvCommandHistory` → `schema.prisma:L10718`
- `TpvCommandQueue` → `schema.prisma:L10656`
- `TpvFeedback` → `schema.prisma:L10369`
- `TpvMessage` → `schema.prisma:L13677`
- `TpvMessageDelivery` → `schema.prisma:L13729`
- `TpvMessageResponse` → `schema.prisma:L13752`
- `TrainingModule` → `schema.prisma:L13807`
- `TrainingProgress` → `schema.prisma:L13884`
- `TrainingQuizQuestion` → `schema.prisma:L13866`
- `TrainingStep` → `schema.prisma:L13846`
- `TransactionCost` → `schema.prisma:L7108`
- `UnitConversion` → `schema.prisma:L2837`
- `UpsellAcceptance` → `schema.prisma:L8863`
- `UpsellAiRun` → `schema.prisma:L8883`
- `UpsellImpression` → `schema.prisma:L8823`
- `UpsellRule` → `schema.prisma:L8743`
- `user_sessions` → `schema.prisma:L6330`
- `Venue` → `schema.prisma:L167`
- `VenueAreaTicketSettings` → `schema.prisma:L16120`
- `VenueChatMessage` → `schema.prisma:L816`
- `VenueChatSession` → `schema.prisma:L771`
- `VenueCommission` → `schema.prisma:L15728`
- `VenueCreditAssessment` → `schema.prisma:L11200`
- `VenueCryptoConfig` → `schema.prisma:L13544`
- `VenueFeature` → `schema.prisma:L4791`
- `VenueIvaPorProducto` → `schema.prisma:L967`
- `VenueModule` → `schema.prisma:L11360`
- `VenuePaymentConfig` → `schema.prisma:L6431`
- `VenuePaymentLinkSettings` → `schema.prisma:L15067`
- `VenuePosSinAparato` → `schema.prisma:L978`
- `VenuePricingStructure` → `schema.prisma:L7048`
- `VenueRoleConfig` → `schema.prisma:L1490`
- `VenueRolePermission` → `schema.prisma:L1394`
- `VenueScaleSettings` → `schema.prisma:L16371`
- `VenueSettings` → `schema.prisma:L856`
- `VenueTenderType` → `schema.prisma:L4536`
- `VenueTenderTypeRevision` → `schema.prisma:L4601`
- `VenueTransaction` → `schema.prisma:L4728`
- `VenueWhatsappActivation` → `schema.prisma:L707`
- `WalletCardDesign` → `schema.prisma:L8208`
- `WalletPass` → `schema.prisma:L8109`
- `WalletPassRegistration` → `schema.prisma:L8175`
- `WebhookEvent` → `schema.prisma:L5129`
- `WebhookSubscription` → `schema.prisma:L6547`
- `WhatsappContactWindow` → `schema.prisma:L725`
- `WhatsappInboundEvent` → `schema.prisma:L745`
- `WorkShiftAssignment` → `schema.prisma:L3527`
- `WorkShiftTemplate` → `schema.prisma:L3504`
- `Zone` → `schema.prisma:L150`
