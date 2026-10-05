# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **399 models / 370 enums / ~18,800 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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

- `AccountingPeriodLock` → `schema.prisma:L17393`
- `AccountMapping` → `schema.prisma:L17288`
- `ActivityLog` → `schema.prisma:L7480`
- `Aggregator` → `schema.prisma:L15564`
- `AggregatorBooking` → `schema.prisma:L14872`
- `AggregatorCapacityRule` → `schema.prisma:L14853`
- `AggregatorConnection` → `schema.prisma:L14778`
- `AggregatorInboundEvent` → `schema.prisma:L14941`
- `AggregatorOutbox` → `schema.prisma:L14961`
- `AggregatorProductLink` → `schema.prisma:L14810`
- `AggregatorSessionLink` → `schema.prisma:L14829`
- `AggregatorVisit` → `schema.prisma:L14898`
- `AngelPayUserAccount` → `schema.prisma:L6025`
- `AppUpdate` → `schema.prisma:L13446`
- `Area` → `schema.prisma:L3248`
- `AreaTicket` → `schema.prisma:L16100`
- `AreaTicketCheckoutSession` → `schema.prisma:L16222`
- `AreaTicketExternalIncident` → `schema.prisma:L16469`
- `AreaTicketExternalSettlement` → `schema.prisma:L16434`
- `AreaTicketFulfillment` → `schema.prisma:L16298`
- `AreaTicketInventoryReservation` → `schema.prisma:L16193`
- `AreaTicketLine` → `schema.prisma:L16161`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16254`
- `AreaTicketPrintAttempt` → `schema.prisma:L16277`
- `BankStatement` → `schema.prisma:L17162`
- `BankStatementLine` → `schema.prisma:L17183`
- `BillingObligationConflict` → `schema.prisma:L5055`
- `BillingTaxProfile` → `schema.prisma:L17985`
- `BirthdayAutomation` → `schema.prisma:L7804`
- `BulkCommandOperation` → `schema.prisma:L10726`
- `CalendarSyncOutbox` → `schema.prisma:L14661`
- `CampaignDelivery` → `schema.prisma:L13604`
- `CapabilityGrant` → `schema.prisma:L4831`
- `CashCloseout` → `schema.prisma:L11111`
- `CashDeposit` → `schema.prisma:L13248`
- `CashDrawerEvent` → `schema.prisma:L15401`
- `CashDrawerSession` → `schema.prisma:L15362`
- `CashOutCommissionRate` → `schema.prisma:L17802`
- `CashOutScheduleDay` → `schema.prisma:L17825`
- `CashOutWithdrawal` → `schema.prisma:L17887`
- `CatalogBindingBatch` → `schema.prisma:L12142`
- `CatalogBindingLine` → `schema.prisma:L12178`
- `CatalogBrand` → `schema.prisma:L11595`
- `CatalogClientObservation` → `schema.prisma:L11908`
- `CatalogClientReadinessOverride` → `schema.prisma:L11927`
- `CatalogFamily` → `schema.prisma:L11645`
- `CatalogIdempotencyRecord` → `schema.prisma:L12041`
- `CatalogIdentifier` → `schema.prisma:L11776`
- `CatalogImportBatch` → `schema.prisma:L12084`
- `CatalogImportLine` → `schema.prisma:L12121`
- `CatalogItem` → `schema.prisma:L11678`
- `CatalogItemBusinessType` → `schema.prisma:L11738`
- `CatalogItemPrice` → `schema.prisma:L11826`
- `CatalogManufacturer` → `schema.prisma:L11619`
- `CatalogProductTypeMapping` → `schema.prisma:L11755`
- `CatalogPublicationBatch` → `schema.prisma:L12206`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12300`
- `CatalogPublicationLine` → `schema.prisma:L12247`
- `CatalogPublicationOutbox` → `schema.prisma:L12343`
- `CatalogValidationProfile` → `schema.prisma:L11797`
- `CatalogVenueBinding` → `schema.prisma:L11955`
- `CatalogVenueClientRequirement` → `schema.prisma:L11882`
- `CatalogVenueEventSequence` → `schema.prisma:L12326`
- `CatalogVenueOverride` → `schema.prisma:L11997`
- `CatalogVenueRollout` → `schema.prisma:L11857`
- `Cfdi` → `schema.prisma:L16990`
- `CfdiGlobalOrden` → `schema.prisma:L17115`
- `ChatbotTokenBudget` → `schema.prisma:L10372`
- `ChatConversation` → `schema.prisma:L10227`
- `ChatFeedback` → `schema.prisma:L10313`
- `ChatLearningEvent` → `schema.prisma:L10270`
- `ChatMessage` → `schema.prisma:L10250`
- `ChatTrainingData` → `schema.prisma:L10184`
- `CheckoutSession` → `schema.prisma:L6305`
- `ClassSession` → `schema.prisma:L14262`
- `CommissionCalculation` → `schema.prisma:L13024`
- `CommissionClawback` → `schema.prisma:L13200`
- `CommissionConfig` → `schema.prisma:L12790`
- `CommissionMilestone` → `schema.prisma:L12940`
- `CommissionOverride` → `schema.prisma:L12867`
- `CommissionPayout` → `schema.prisma:L13151`
- `CommissionSummary` → `schema.prisma:L13090`
- `CommissionTier` → `schema.prisma:L12904`
- `ConsentEvent` → `schema.prisma:L7666`
- `Consumer` → `schema.prisma:L7896`
- `ConsumerAuthAccount` → `schema.prisma:L7921`
- `CouponCode` → `schema.prisma:L8868`
- `CouponRedemption` → `schema.prisma:L8899`
- `CreditAssessmentHistory` → `schema.prisma:L11220`
- `CreditItemBalance` → `schema.prisma:L15152`
- `CreditOffer` → `schema.prisma:L11239`
- `CreditPack` → `schema.prisma:L15061`
- `CreditPackItem` → `schema.prisma:L15090`
- `CreditPackPurchase` → `schema.prisma:L15107`
- `CreditTransaction` → `schema.prisma:L15174`
- `Customer` → `schema.prisma:L7521`
- `CustomerApprovalDelivery` → `schema.prisma:L9886`
- `CustomerApprovalOutbox` → `schema.prisma:L9861`
- `CustomerCampaign` → `schema.prisma:L7754`
- `CustomerCampaignDelivery` → `schema.prisma:L7836`
- `CustomerCaptureToken` → `schema.prisma:L7702`
- `CustomerDiscount` → `schema.prisma:L8919`
- `CustomerExternalIdentity` → `schema.prisma:L14928`
- `CustomerGroup` → `schema.prisma:L7960`
- `CustomerOrderMetric` → `schema.prisma:L4047`
- `CustomerTaxProfile` → `schema.prisma:L17134`
- `DeliveryActivationRequest` → `schema.prisma:L6764`
- `DeliveryChannelLink` → `schema.prisma:L6603`
- `DeliveryConnectIntent` → `schema.prisma:L6715`
- `DeliveryLineAction` → `schema.prisma:L6676`
- `DeliveryOrderEvent` → `schema.prisma:L6788`
- `DeliveryStoreRevocation` → `schema.prisma:L6752`
- `DeviceToken` → `schema.prisma:L9188`
- `DigitalReceipt` → `schema.prisma:L4644`
- `Discount` → `schema.prisma:L8558`
- `EcommerceMerchant` → `schema.prisma:L6117`
- `EmailQuotaLedger` → `schema.prisma:L7883`
- `EmailSuppression` → `schema.prisma:L7871`
- `EmailTemplate` → `schema.prisma:L13543`
- `Employee` → `schema.prisma:L17650`
- `Estimate` → `schema.prisma:L15471`
- `EstimateItem` → `schema.prisma:L15499`
- `Expense` → `schema.prisma:L17437`
- `ExternalBusyBlock` → `schema.prisma:L14554`
- `Feature` → `schema.prisma:L4773`
- `FeeSchedule` → `schema.prisma:L5117`
- `FeeTier` → `schema.prisma:L5128`
- `FinancialAccount` → `schema.prisma:L15661`
- `FinancialConnection` → `schema.prisma:L15630`
- `FinancialProvider` → `schema.prisma:L15616`
- `FiscalEmisor` → `schema.prisma:L16906`
- `FiscalLossCarryforward` → `schema.prisma:L17560`
- `FixedAsset` → `schema.prisma:L17578`
- `FixedAssetDepreciation` → `schema.prisma:L17607`
- `FloorElement` → `schema.prisma:L3324`
- `FulfillmentArea` → `schema.prisma:L15965`
- `GeofenceRule` → `schema.prisma:L10811`
- `GoogleCalendarChannel` → `schema.prisma:L14531`
- `GoogleCalendarConnection` → `schema.prisma:L14483`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14584`
- `GoogleOAuthSession` → `schema.prisma:L14606`
- `HolidayCalendar` → `schema.prisma:L7404`
- `HybridBillingOperation` → `schema.prisma:L4979`
- `HybridCampaign` → `schema.prisma:L4856`
- `HybridContract` → `schema.prisma:L4936`
- `HybridContractSelection` → `schema.prisma:L4968`
- `HybridCreditAllocation` → `schema.prisma:L5035`
- `HybridOfferPublication` → `schema.prisma:L4883`
- `HybridPaymentPeriod` → `schema.prisma:L5014`
- `HybridPurchase` → `schema.prisma:L4903`
- `HybridRedemption` → `schema.prisma:L4997`
- `IdempotencyRequest` → `schema.prisma:L12665`
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
- `InventoryTransfer` → `schema.prisma:L15443`
- `InventoryWasteReport` → `schema.prisma:L2075`
- `Invitation` → `schema.prisma:L1514`
- `Invoice` → `schema.prisma:L5140`
- `InvoiceItem` → `schema.prisma:L5166`
- `ItemCategory` → `schema.prisma:L12378`
- `JournalEntry` → `schema.prisma:L17346`
- `JournalLine` → `schema.prisma:L17375`
- `KdsOrder` → `schema.prisma:L15709`
- `KdsOrderItem` → `schema.prisma:L15772`
- `KioskCheckInAttempt` → `schema.prisma:L18308`
- `KioskCheckInChallenge` → `schema.prisma:L18262`
- `KioskOutreachOutbox` → `schema.prisma:L18329`
- `LaunchCampaign` → `schema.prisma:L18667`
- `LaunchCampaignRedemption` → `schema.prisma:L18784`
- `LearnedPatterns` → `schema.prisma:L10294`
- `LedgerAccount` → `schema.prisma:L17238`
- `LiveDemoSession` → `schema.prisma:L840`
- `LowStockAlert` → `schema.prisma:L2910`
- `LoyaltyConfig` → `schema.prisma:L7990`
- `LoyaltyTransaction` → `schema.prisma:L8033`
- `MarketingCampaign` → `schema.prisma:L13561`
- `McpAuthCode` → `schema.prisma:L16788`
- `McpOAuthClient` → `schema.prisma:L16772`
- `McpRefreshToken` → `schema.prisma:L16806`
- `McpToolCall` → `schema.prisma:L16828`
- `MeasurementUnit` → `schema.prisma:L15549`
- `Menu` → `schema.prisma:L1732`
- `MenuCategory` → `schema.prisma:L1669`
- `MenuCategoryAssignment` → `schema.prisma:L1767`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16702`
- `MerchantAccount` → `schema.prisma:L5855`
- `MerchantFiscalConfig` → `schema.prisma:L16961`
- `MerchantRevenueShare` → `schema.prisma:L6984`
- `MerchantRoutingRule` → `schema.prisma:L5977`
- `MilestoneAchievement` → `schema.prisma:L12985`
- `Modifier` → `schema.prisma:L4246`
- `ModifierGroup` → `schema.prisma:L4210`
- `Module` → `schema.prisma:L11287`
- `MoneyAnomaly` → `schema.prisma:L6887`
- `MonthlyVenueProfit` → `schema.prisma:L7430`
- `Notification` → `schema.prisma:L9090`
- `NotificationPreference` → `schema.prisma:L9137`
- `NotificationTemplate` → `schema.prisma:L9164`
- `OAuthState` → `schema.prisma:L1565`
- `OnboardingProgress` → `schema.prisma:L1583`
- `Order` → `schema.prisma:L3773`
- `OrderAction` → `schema.prisma:L4317`
- `OrderCustomer` → `schema.prisma:L4026`
- `OrderDiscount` → `schema.prisma:L8951`
- `OrderFulfillment` → `schema.prisma:L16020`
- `OrderFulfillmentLine` → `schema.prisma:L16051`
- `OrderItem` → `schema.prisma:L4062`
- `OrderItemModifier` → `schema.prisma:L4299`
- `OrderItemSelloIva` → `schema.prisma:L17095`
- `OrderPromotion` → `schema.prisma:L18225`
- `OrderServiceCharge` → `schema.prisma:L9035`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13362`
- `OrganizationEntitlement` → `schema.prisma:L11570`
- `OrganizationGoal` → `schema.prisma:L13320`
- `OrganizationModule` → `schema.prisma:L11347`
- `OrganizationPaymentConfig` → `schema.prisma:L6429`
- `OrganizationPayoutConfig` → `schema.prisma:L13395`
- `OrganizationPricingStructure` → `schema.prisma:L6461`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13343`
- `OtpChallenge` → `schema.prisma:L7940`
- `OvertimeApproval` → `schema.prisma:L3551`
- `PartnerAPIKey` → `schema.prisma:L6259`
- `Payment` → `schema.prisma:L4350`
- `PaymentAllocation` → `schema.prisma:L4623`
- `PaymentEffect` → `schema.prisma:L18599`
- `PaymentLink` → `schema.prisma:L15220`
- `PaymentLinkAttribution` → `schema.prisma:L15328`
- `PaymentLinkItem` → `schema.prisma:L15283`
- `PaymentLinkItemModifier` → `schema.prisma:L15310`
- `PaymentProvider` → `schema.prisma:L5814`
- `PayrollLine` → `schema.prisma:L17721`
- `PayrollRun` → `schema.prisma:L17690`
- `PerformanceGoal` → `schema.prisma:L13297`
- `PermissionOverride` → `schema.prisma:L1438`
- `PermissionSet` → `schema.prisma:L1461`
- `PlatformAnnouncement` → `schema.prisma:L18389`
- `PlatformAnnouncementClick` → `schema.prisma:L18454`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18491`
- `PlatformCfdi` → `schema.prisma:L18018`
- `PlatformEmisor` → `schema.prisma:L17958`
- `PlatformSettings` → `schema.prisma:L6236`
- `PosCommand` → `schema.prisma:L9218`
- `PosConnectionStatus` → `schema.prisma:L984`
- `PosSyncIntent` → `schema.prisma:L18096`
- `PricingPolicy` → `schema.prisma:L2806`
- `Printer` → `schema.prisma:L15821`
- `PrintGateway` → `schema.prisma:L15878`
- `PrintJob` → `schema.prisma:L16601`
- `PrintStation` → `schema.prisma:L15896`
- `PrivacyNoticeVersion` → `schema.prisma:L7688`
- `ProcessedStripeEvent` → `schema.prisma:L6873`
- `ProcessorReliabilityMetric` → `schema.prisma:L7358`
- `Product` → `schema.prisma:L1785`
- `ProductModifierGroup` → `schema.prisma:L4287`
- `ProductOption` → `schema.prisma:L15526`
- `ProductOptionValue` → `schema.prisma:L15537`
- `ProductStaff` → `schema.prisma:L14177`
- `PromoterBankAccount` → `schema.prisma:L17841`
- `PromoterCommissionEntry` → `schema.prisma:L17860`
- `PromoterLocationPing` → `schema.prisma:L3739`
- `Promotion` → `schema.prisma:L18147`
- `PromotionGroup` → `schema.prisma:L18186`
- `PromotionOption` → `schema.prisma:L18202`
- `ProviderCostStructure` → `schema.prisma:L6909`
- `ProviderEventLog` → `schema.prisma:L6538`
- `PurchaseOrder` → `schema.prisma:L2531`
- `PurchaseOrderInvoice` → `schema.prisma:L2676`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2733`
- `PurchaseOrderItem` → `schema.prisma:L2589`
- `RateCorrectionBatch` → `schema.prisma:L7134`
- `RateCorrectionEntry` → `schema.prisma:L7176`
- `RawMaterial` → `schema.prisma:L2287`
- `RawMaterialMovement` → `schema.prisma:L2859`
- `RawMaterialPresentation` → `schema.prisma:L2363`
- `ReceiptLayout` → `schema.prisma:L18633`
- `Recipe` → `schema.prisma:L2383`
- `RecipeLine` → `schema.prisma:L2407`
- `Referral` → `schema.prisma:L8406`
- `ReferralProgramConfig` → `schema.prisma:L8371`
- `ReferralRewardGrant` → `schema.prisma:L8497`
- `ReferralTierReward` → `schema.prisma:L8469`
- `ReferralTierUnlock` → `schema.prisma:L8542`
- `RefreshGrant` → `schema.prisma:L18578`
- `Reservation` → `schema.prisma:L13940`
- `ReservationGoogleEventMapping` → `schema.prisma:L14993`
- `ReservationModifier` → `schema.prisma:L14125`
- `ReservationReminderSent` → `schema.prisma:L14108`
- `ReservationSettings` → `schema.prisma:L14342`
- `ReservationWaitlistEntry` → `schema.prisma:L14310`
- `Review` → `schema.prisma:L5184`
- `SalesRetention` → `schema.prisma:L17541`
- `SaleVerification` → `schema.prisma:L4677`
- `ScaleProfile` → `schema.prisma:L16342`
- `ScheduledCommand` → `schema.prisma:L10771`
- `SerializedItem` → `schema.prisma:L12421`
- `SerializedItemCustodyEvent` → `schema.prisma:L12588`
- `ServiceCharge` → `schema.prisma:L9006`
- `Session` → `schema.prisma:L18557`
- `SettlementConfiguration` → `schema.prisma:L7209`
- `SettlementConfirmation` → `schema.prisma:L7322`
- `SettlementIncident` → `schema.prisma:L7273`
- `SettlementSimulation` → `schema.prisma:L7244`
- `Shift` → `schema.prisma:L3362`
- `SimRegistrationRequest` → `schema.prisma:L12626`
- `SimRegistrationRequestItem` → `schema.prisma:L12648`
- `SlotHold` → `schema.prisma:L14208`
- `Staff` → `schema.prisma:L1004`
- `StaffDocument` → `schema.prisma:L3610`
- `StaffOnboardingState` → `schema.prisma:L16672`
- `StaffOrganization` → `schema.prisma:L1337`
- `StaffPasskey` → `schema.prisma:L1364`
- `StaffSchedule` → `schema.prisma:L14148`
- `StaffScheduleException` → `schema.prisma:L14160`
- `StaffVenue` → `schema.prisma:L1261`
- `StaffWorkSchedule` → `schema.prisma:L3487`
- `StaffWorkScheduleException` → `schema.prisma:L3585`
- `StampCard` → `schema.prisma:L8254`
- `StampEvent` → `schema.prisma:L8293`
- `StampReward` → `schema.prisma:L8331`
- `StockAlertConfig` → `schema.prisma:L13279`
- `StockBatch` → `schema.prisma:L3025`
- `StockCount` → `schema.prisma:L2942`
- `StockCountItem` → `schema.prisma:L2970`
- `StripeWebhookEvent` → `schema.prisma:L6856`
- `Supplier` → `schema.prisma:L2442`
- `SupplierItemCode` → `schema.prisma:L2774`
- `SupplierPricing` → `schema.prisma:L2497`
- `Table` → `schema.prisma:L3274`
- `Terminal` → `schema.prisma:L5235`
- `TerminalAttemptResolution` → `schema.prisma:L5673`
- `TerminalHealth` → `schema.prisma:L5493`
- `TerminalLog` → `schema.prisma:L5467`
- `TerminalOrder` → `schema.prisma:L5717`
- `TerminalOrderItem` → `schema.prisma:L5792`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5645`
- `TerminalPaymentRequest` → `schema.prisma:L5564`
- `TimeEntry` → `schema.prisma:L3652`
- `TimeEntryBreak` → `schema.prisma:L3721`
- `TokenPurchase` → `schema.prisma:L10443`
- `TokenUsageRecord` → `schema.prisma:L10415`
- `TpvCommandHistory` → `schema.prisma:L10677`
- `TpvCommandQueue` → `schema.prisma:L10615`
- `TpvFeedback` → `schema.prisma:L10328`
- `TpvMessage` → `schema.prisma:L13636`
- `TpvMessageDelivery` → `schema.prisma:L13688`
- `TpvMessageResponse` → `schema.prisma:L13711`
- `TrainingModule` → `schema.prisma:L13766`
- `TrainingProgress` → `schema.prisma:L13843`
- `TrainingQuizQuestion` → `schema.prisma:L13825`
- `TrainingStep` → `schema.prisma:L13805`
- `TransactionCost` → `schema.prisma:L7072`
- `UnitConversion` → `schema.prisma:L2837`
- `UpsellAcceptance` → `schema.prisma:L8827`
- `UpsellAiRun` → `schema.prisma:L8847`
- `UpsellImpression` → `schema.prisma:L8787`
- `UpsellRule` → `schema.prisma:L8707`
- `user_sessions` → `schema.prisma:L6294`
- `Venue` → `schema.prisma:L167`
- `VenueAreaTicketSettings` → `schema.prisma:L16079`
- `VenueChatMessage` → `schema.prisma:L816`
- `VenueChatSession` → `schema.prisma:L771`
- `VenueCommission` → `schema.prisma:L15687`
- `VenueCreditAssessment` → `schema.prisma:L11159`
- `VenueCryptoConfig` → `schema.prisma:L13503`
- `VenueFeature` → `schema.prisma:L4791`
- `VenueIvaPorProducto` → `schema.prisma:L967`
- `VenueModule` → `schema.prisma:L11319`
- `VenuePaymentConfig` → `schema.prisma:L6395`
- `VenuePaymentLinkSettings` → `schema.prisma:L15026`
- `VenuePosSinAparato` → `schema.prisma:L978`
- `VenuePricingStructure` → `schema.prisma:L7012`
- `VenueRoleConfig` → `schema.prisma:L1490`
- `VenueRolePermission` → `schema.prisma:L1394`
- `VenueScaleSettings` → `schema.prisma:L16330`
- `VenueSettings` → `schema.prisma:L856`
- `VenueTenderType` → `schema.prisma:L4536`
- `VenueTenderTypeRevision` → `schema.prisma:L4601`
- `VenueTransaction` → `schema.prisma:L4728`
- `VenueWhatsappActivation` → `schema.prisma:L707`
- `WalletCardDesign` → `schema.prisma:L8172`
- `WalletPass` → `schema.prisma:L8073`
- `WalletPassRegistration` → `schema.prisma:L8139`
- `WebhookEvent` → `schema.prisma:L5093`
- `WebhookSubscription` → `schema.prisma:L6511`
- `WhatsappContactWindow` → `schema.prisma:L725`
- `WhatsappInboundEvent` → `schema.prisma:L745`
- `WorkShiftAssignment` → `schema.prisma:L3527`
- `WorkShiftTemplate` → `schema.prisma:L3504`
- `Zone` → `schema.prisma:L150`
