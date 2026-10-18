# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **429 models / 392 enums / ~19,800 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `FloorPlanPublication`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueIvaPorProducto`, `VenuePosSinAparato`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `CapabilityGrant`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `HybridBillingOperation`, `HybridCampaign`, `HybridContract`, `HybridContractSelection`, `HybridCreditAllocation`, `HybridOfferPublication`, `HybridPaymentPeriod`, `HybridPromotionGroup`, `HybridPurchase`, `HybridRedemption`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                               |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffAssignment`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffPosition`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                                                               |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `DocumentRequest`, `DocumentRequestDelivery`, `DocumentRequestFile`, `DocumentRequestSubmission`, `DocumentRequestSubmissionFile`, `DocumentRequestVenueLink`, `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `ProductPriceHistory`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                                                                                                       |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `InventoryWasteReport`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `ShopifyConnectIntent`, `ShopifyImportIssue`, `ShopifyInboundEvent`, `ShopifyLocationLink`, `ShopifyReviewItem`, `ShopifyStockOutbox`, `ShopifyStore`, `ShopifyVariantLink`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`            |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryConnectIntent`, `DeliveryLineAction`, `DeliveryOrderEvent`, `DeliveryStoreRevocation`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                                                                                                      |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CfdiGlobalOrden`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `OrderItemSelloIva`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                                                                                                |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `ClassSessionPayState`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `ServiceEarning`, `ServicePayPeriod`, `ServicePayTable`, `ServicePayTableCell`, `ServicePayTableVersion`, `StaffPayLevel`, `StaffPayLevelAssignment`, `StaffPayStatement`, `StaffPayTipWindow`, `StaffPayVenueWindow`, `VenueCommission`                                                                                                                                                                                                    |
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

- `AccountingPeriodLock` → `schema.prisma:L17663`
- `AccountMapping` → `schema.prisma:L17558`
- `ActivityLog` → `schema.prisma:L7697`
- `Aggregator` → `schema.prisma:L15809`
- `AggregatorBooking` → `schema.prisma:L15117`
- `AggregatorCapacityRule` → `schema.prisma:L15098`
- `AggregatorConnection` → `schema.prisma:L15023`
- `AggregatorInboundEvent` → `schema.prisma:L15186`
- `AggregatorOutbox` → `schema.prisma:L15206`
- `AggregatorProductLink` → `schema.prisma:L15055`
- `AggregatorSessionLink` → `schema.prisma:L15074`
- `AggregatorVisit` → `schema.prisma:L15143`
- `AngelPayUserAccount` → `schema.prisma:L6238`
- `AppUpdate` → `schema.prisma:L13684`
- `Area` → `schema.prisma:L3334`
- `AreaTicket` → `schema.prisma:L16358`
- `AreaTicketCheckoutSession` → `schema.prisma:L16480`
- `AreaTicketExternalIncident` → `schema.prisma:L16727`
- `AreaTicketExternalSettlement` → `schema.prisma:L16692`
- `AreaTicketFulfillment` → `schema.prisma:L16556`
- `AreaTicketInventoryReservation` → `schema.prisma:L16451`
- `AreaTicketLine` → `schema.prisma:L16419`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16512`
- `AreaTicketPrintAttempt` → `schema.prisma:L16535`
- `BankStatement` → `schema.prisma:L17432`
- `BankStatementLine` → `schema.prisma:L17453`
- `BillingObligationConflict` → `schema.prisma:L5268`
- `BillingTaxProfile` → `schema.prisma:L18255`
- `BirthdayAutomation` → `schema.prisma:L8021`
- `BulkCommandOperation` → `schema.prisma:L10956`
- `CalendarSyncOutbox` → `schema.prisma:L14906`
- `CampaignDelivery` → `schema.prisma:L13842`
- `CapabilityGrant` → `schema.prisma:L5008`
- `CashCloseout` → `schema.prisma:L11341`
- `CashDeposit` → `schema.prisma:L13486`
- `CashDrawerEvent` → `schema.prisma:L15646`
- `CashDrawerSession` → `schema.prisma:L15607`
- `CashOutCommissionRate` → `schema.prisma:L18072`
- `CashOutScheduleDay` → `schema.prisma:L18095`
- `CashOutWithdrawal` → `schema.prisma:L18157`
- `CatalogBindingBatch` → `schema.prisma:L12372`
- `CatalogBindingLine` → `schema.prisma:L12408`
- `CatalogBrand` → `schema.prisma:L11825`
- `CatalogClientObservation` → `schema.prisma:L12138`
- `CatalogClientReadinessOverride` → `schema.prisma:L12157`
- `CatalogFamily` → `schema.prisma:L11875`
- `CatalogIdempotencyRecord` → `schema.prisma:L12271`
- `CatalogIdentifier` → `schema.prisma:L12006`
- `CatalogImportBatch` → `schema.prisma:L12314`
- `CatalogImportLine` → `schema.prisma:L12351`
- `CatalogItem` → `schema.prisma:L11908`
- `CatalogItemBusinessType` → `schema.prisma:L11968`
- `CatalogItemPrice` → `schema.prisma:L12056`
- `CatalogManufacturer` → `schema.prisma:L11849`
- `CatalogProductTypeMapping` → `schema.prisma:L11985`
- `CatalogPublicationBatch` → `schema.prisma:L12436`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12530`
- `CatalogPublicationLine` → `schema.prisma:L12477`
- `CatalogPublicationOutbox` → `schema.prisma:L12573`
- `CatalogValidationProfile` → `schema.prisma:L12027`
- `CatalogVenueBinding` → `schema.prisma:L12185`
- `CatalogVenueClientRequirement` → `schema.prisma:L12112`
- `CatalogVenueEventSequence` → `schema.prisma:L12556`
- `CatalogVenueOverride` → `schema.prisma:L12227`
- `CatalogVenueRollout` → `schema.prisma:L12087`
- `Cfdi` → `schema.prisma:L17254`
- `CfdiGlobalOrden` → `schema.prisma:L17385`
- `ChatbotTokenBudget` → `schema.prisma:L10602`
- `ChatConversation` → `schema.prisma:L10457`
- `ChatFeedback` → `schema.prisma:L10543`
- `ChatLearningEvent` → `schema.prisma:L10500`
- `ChatMessage` → `schema.prisma:L10480`
- `ChatTrainingData` → `schema.prisma:L10414`
- `CheckoutSession` → `schema.prisma:L6518`
- `ClassSession` → `schema.prisma:L14500`
- `ClassSessionPayState` → `schema.prisma:L19215`
- `CommissionCalculation` → `schema.prisma:L13261`
- `CommissionClawback` → `schema.prisma:L13438`
- `CommissionConfig` → `schema.prisma:L13020`
- `CommissionMilestone` → `schema.prisma:L13177`
- `CommissionOverride` → `schema.prisma:L13104`
- `CommissionPayout` → `schema.prisma:L13389`
- `CommissionSummary` → `schema.prisma:L13328`
- `CommissionTier` → `schema.prisma:L13141`
- `ConsentEvent` → `schema.prisma:L7883`
- `Consumer` → `schema.prisma:L8113`
- `ConsumerAuthAccount` → `schema.prisma:L8138`
- `CouponCode` → `schema.prisma:L9085`
- `CouponRedemption` → `schema.prisma:L9116`
- `CreditAssessmentHistory` → `schema.prisma:L11450`
- `CreditItemBalance` → `schema.prisma:L15397`
- `CreditOffer` → `schema.prisma:L11469`
- `CreditPack` → `schema.prisma:L15306`
- `CreditPackItem` → `schema.prisma:L15335`
- `CreditPackPurchase` → `schema.prisma:L15352`
- `CreditTransaction` → `schema.prisma:L15419`
- `Customer` → `schema.prisma:L7738`
- `CustomerApprovalDelivery` → `schema.prisma:L10115`
- `CustomerApprovalOutbox` → `schema.prisma:L10090`
- `CustomerCampaign` → `schema.prisma:L7971`
- `CustomerCampaignDelivery` → `schema.prisma:L8053`
- `CustomerCaptureToken` → `schema.prisma:L7919`
- `CustomerDiscount` → `schema.prisma:L9136`
- `CustomerExternalIdentity` → `schema.prisma:L15173`
- `CustomerGroup` → `schema.prisma:L8177`
- `CustomerOrderMetric` → `schema.prisma:L4222`
- `CustomerTaxProfile` → `schema.prisma:L17404`
- `DeliveryActivationRequest` → `schema.prisma:L6977`
- `DeliveryChannelLink` → `schema.prisma:L6816`
- `DeliveryConnectIntent` → `schema.prisma:L6928`
- `DeliveryLineAction` → `schema.prisma:L6889`
- `DeliveryOrderEvent` → `schema.prisma:L7001`
- `DeliveryStoreRevocation` → `schema.prisma:L6965`
- `DeviceToken` → `schema.prisma:L9410`
- `DigitalReceipt` → `schema.prisma:L4821`
- `Discount` → `schema.prisma:L8775`
- `DocumentRequest` → `schema.prisma:L19706`
- `DocumentRequestDelivery` → `schema.prisma:L19770`
- `DocumentRequestFile` → `schema.prisma:L19748`
- `DocumentRequestSubmission` → `schema.prisma:L19790`
- `DocumentRequestSubmissionFile` → `schema.prisma:L19803`
- `DocumentRequestVenueLink` → `schema.prisma:L19812`
- `EcommerceMerchant` → `schema.prisma:L6330`
- `EmailQuotaLedger` → `schema.prisma:L8100`
- `EmailSuppression` → `schema.prisma:L8088`
- `EmailTemplate` → `schema.prisma:L13781`
- `Employee` → `schema.prisma:L17920`
- `Estimate` → `schema.prisma:L15716`
- `EstimateItem` → `schema.prisma:L15744`
- `Expense` → `schema.prisma:L17707`
- `ExternalBusyBlock` → `schema.prisma:L14799`
- `Feature` → `schema.prisma:L4950`
- `FeeSchedule` → `schema.prisma:L5330`
- `FeeTier` → `schema.prisma:L5341`
- `FinancialAccount` → `schema.prisma:L15906`
- `FinancialConnection` → `schema.prisma:L15875`
- `FinancialProvider` → `schema.prisma:L15861`
- `FiscalEmisor` → `schema.prisma:L17165`
- `FiscalLossCarryforward` → `schema.prisma:L17830`
- `FixedAsset` → `schema.prisma:L17848`
- `FixedAssetDepreciation` → `schema.prisma:L17877`
- `FloorElement` → `schema.prisma:L3419`
- `FloorPlanPublication` → `schema.prisma:L3459`
- `FulfillmentArea` → `schema.prisma:L16223`
- `GeofenceRule` → `schema.prisma:L11041`
- `GoogleCalendarChannel` → `schema.prisma:L14776`
- `GoogleCalendarConnection` → `schema.prisma:L14728`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14829`
- `GoogleOAuthSession` → `schema.prisma:L14851`
- `HolidayCalendar` → `schema.prisma:L7621`
- `HybridBillingOperation` → `schema.prisma:L5192`
- `HybridCampaign` → `schema.prisma:L5033`
- `HybridContract` → `schema.prisma:L5149`
- `HybridContractSelection` → `schema.prisma:L5181`
- `HybridCreditAllocation` → `schema.prisma:L5248`
- `HybridOfferPublication` → `schema.prisma:L5096`
- `HybridPaymentPeriod` → `schema.prisma:L5227`
- `HybridPromotionGroup` → `schema.prisma:L5077`
- `HybridPurchase` → `schema.prisma:L5116`
- `HybridRedemption` → `schema.prisma:L5210`
- `IdempotencyRequest` → `schema.prisma:L12895`
- `InterVenueTransfer` → `schema.prisma:L3162`
- `InterVenueTransferAllocation` → `schema.prisma:L3245`
- `InterVenueTransferItem` → `schema.prisma:L3214`
- `InterVenueTransferReceipt` → `schema.prisma:L3272`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3288`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3316`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3300`
- `Inventory` → `schema.prisma:L2084`
- `InventoryMovement` → `schema.prisma:L2184`
- `InventoryPosting` → `schema.prisma:L2279`
- `InventoryPostingLine` → `schema.prisma:L2319`
- `InventoryTransfer` → `schema.prisma:L15688`
- `InventoryWasteReport` → `schema.prisma:L2139`
- `Invitation` → `schema.prisma:L1552`
- `Invoice` → `schema.prisma:L5353`
- `InvoiceItem` → `schema.prisma:L5379`
- `ItemCategory` → `schema.prisma:L12608`
- `JournalEntry` → `schema.prisma:L17616`
- `JournalLine` → `schema.prisma:L17645`
- `KdsOrder` → `schema.prisma:L15954`
- `KdsOrderItem` → `schema.prisma:L16021`
- `KioskCheckInAttempt` → `schema.prisma:L18578`
- `KioskCheckInChallenge` → `schema.prisma:L18532`
- `KioskOutreachOutbox` → `schema.prisma:L18599`
- `LaunchCampaign` → `schema.prisma:L18937`
- `LaunchCampaignRedemption` → `schema.prisma:L19054`
- `LearnedPatterns` → `schema.prisma:L10524`
- `LedgerAccount` → `schema.prisma:L17508`
- `LiveDemoSession` → `schema.prisma:L869`
- `LowStockAlert` → `schema.prisma:L2992`
- `LoyaltyConfig` → `schema.prisma:L8207`
- `LoyaltyTransaction` → `schema.prisma:L8250`
- `MarketingCampaign` → `schema.prisma:L13799`
- `McpAuthCode` → `schema.prisma:L17046`
- `McpOAuthClient` → `schema.prisma:L17030`
- `McpRefreshToken` → `schema.prisma:L17064`
- `McpToolCall` → `schema.prisma:L17086`
- `MeasurementUnit` → `schema.prisma:L15794`
- `Menu` → `schema.prisma:L1770`
- `MenuCategory` → `schema.prisma:L1707`
- `MenuCategoryAssignment` → `schema.prisma:L1805`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16960`
- `MerchantAccount` → `schema.prisma:L6068`
- `MerchantFiscalConfig` → `schema.prisma:L17225`
- `MerchantRevenueShare` → `schema.prisma:L7197`
- `MerchantRoutingRule` → `schema.prisma:L6190`
- `MilestoneAchievement` → `schema.prisma:L13222`
- `Modifier` → `schema.prisma:L4423`
- `ModifierGroup` → `schema.prisma:L4387`
- `Module` → `schema.prisma:L11517`
- `MoneyAnomaly` → `schema.prisma:L7100`
- `MonthlyVenueProfit` → `schema.prisma:L7647`
- `Notification` → `schema.prisma:L9312`
- `NotificationPreference` → `schema.prisma:L9359`
- `NotificationTemplate` → `schema.prisma:L9386`
- `OAuthState` → `schema.prisma:L1603`
- `OnboardingProgress` → `schema.prisma:L1621`
- `Order` → `schema.prisma:L3948`
- `OrderAction` → `schema.prisma:L4494`
- `OrderCustomer` → `schema.prisma:L4201`
- `OrderDiscount` → `schema.prisma:L9168`
- `OrderFulfillment` → `schema.prisma:L16278`
- `OrderFulfillmentLine` → `schema.prisma:L16309`
- `OrderItem` → `schema.prisma:L4237`
- `OrderItemModifier` → `schema.prisma:L4476`
- `OrderItemSelloIva` → `schema.prisma:L17365`
- `OrderPromotion` → `schema.prisma:L18495`
- `OrderServiceCharge` → `schema.prisma:L9257`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13600`
- `OrganizationEntitlement` → `schema.prisma:L11800`
- `OrganizationGoal` → `schema.prisma:L13558`
- `OrganizationModule` → `schema.prisma:L11577`
- `OrganizationPaymentConfig` → `schema.prisma:L6642`
- `OrganizationPayoutConfig` → `schema.prisma:L13633`
- `OrganizationPricingStructure` → `schema.prisma:L6674`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13581`
- `OtpChallenge` → `schema.prisma:L8157`
- `OvertimeApproval` → `schema.prisma:L3663`
- `PartnerAPIKey` → `schema.prisma:L6472`
- `Payment` → `schema.prisma:L4527`
- `PaymentAllocation` → `schema.prisma:L4800`
- `PaymentEffect` → `schema.prisma:L18869`
- `PaymentLink` → `schema.prisma:L15465`
- `PaymentLinkAttribution` → `schema.prisma:L15573`
- `PaymentLinkItem` → `schema.prisma:L15528`
- `PaymentLinkItemModifier` → `schema.prisma:L15555`
- `PaymentProvider` → `schema.prisma:L6027`
- `PayrollLine` → `schema.prisma:L17991`
- `PayrollRun` → `schema.prisma:L17960`
- `PerformanceGoal` → `schema.prisma:L13535`
- `PermissionOverride` → `schema.prisma:L1476`
- `PermissionSet` → `schema.prisma:L1499`
- `PlatformAnnouncement` → `schema.prisma:L18659`
- `PlatformAnnouncementClick` → `schema.prisma:L18724`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18761`
- `PlatformCfdi` → `schema.prisma:L18288`
- `PlatformEmisor` → `schema.prisma:L18228`
- `PlatformSettings` → `schema.prisma:L6449`
- `PosCommand` → `schema.prisma:L9440`
- `PosConnectionStatus` → `schema.prisma:L1017`
- `PosSyncIntent` → `schema.prisma:L18366`
- `PricingPolicy` → `schema.prisma:L2888`
- `Printer` → `schema.prisma:L16079`
- `PrintGateway` → `schema.prisma:L16136`
- `PrintJob` → `schema.prisma:L16859`
- `PrintStation` → `schema.prisma:L16154`
- `PrivacyNoticeVersion` → `schema.prisma:L7905`
- `ProcessedStripeEvent` → `schema.prisma:L7086`
- `ProcessorReliabilityMetric` → `schema.prisma:L7575`
- `Product` → `schema.prisma:L1823`
- `ProductModifierGroup` → `schema.prisma:L4464`
- `ProductOption` → `schema.prisma:L15771`
- `ProductOptionValue` → `schema.prisma:L15782`
- `ProductPriceHistory` → `schema.prisma:L2068`
- `ProductStaff` → `schema.prisma:L14415`
- `PromoterBankAccount` → `schema.prisma:L18111`
- `PromoterCommissionEntry` → `schema.prisma:L18130`
- `PromoterLocationPing` → `schema.prisma:L3914`
- `Promotion` → `schema.prisma:L18417`
- `PromotionGroup` → `schema.prisma:L18456`
- `PromotionOption` → `schema.prisma:L18472`
- `ProviderCostStructure` → `schema.prisma:L7122`
- `ProviderEventLog` → `schema.prisma:L6751`
- `PurchaseOrder` → `schema.prisma:L2595`
- `PurchaseOrderInvoice` → `schema.prisma:L2740`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2807`
- `PurchaseOrderItem` → `schema.prisma:L2653`
- `RateCorrectionBatch` → `schema.prisma:L7351`
- `RateCorrectionEntry` → `schema.prisma:L7393`
- `RawMaterial` → `schema.prisma:L2351`
- `RawMaterialMovement` → `schema.prisma:L2941`
- `RawMaterialPresentation` → `schema.prisma:L2427`
- `ReceiptLayout` → `schema.prisma:L18903`
- `Recipe` → `schema.prisma:L2447`
- `RecipeLine` → `schema.prisma:L2471`
- `Referral` → `schema.prisma:L8623`
- `ReferralProgramConfig` → `schema.prisma:L8588`
- `ReferralRewardGrant` → `schema.prisma:L8714`
- `ReferralTierReward` → `schema.prisma:L8686`
- `ReferralTierUnlock` → `schema.prisma:L8759`
- `RefreshGrant` → `schema.prisma:L18848`
- `Reservation` → `schema.prisma:L14178`
- `ReservationGoogleEventMapping` → `schema.prisma:L15238`
- `ReservationModifier` → `schema.prisma:L14363`
- `ReservationReminderSent` → `schema.prisma:L14346`
- `ReservationSettings` → `schema.prisma:L14587`
- `ReservationWaitlistEntry` → `schema.prisma:L14555`
- `Review` → `schema.prisma:L5397`
- `SalesRetention` → `schema.prisma:L17811`
- `SaleVerification` → `schema.prisma:L4854`
- `ScaleProfile` → `schema.prisma:L16600`
- `ScheduledCommand` → `schema.prisma:L11001`
- `SerializedItem` → `schema.prisma:L12651`
- `SerializedItemCustodyEvent` → `schema.prisma:L12818`
- `ServiceCharge` → `schema.prisma:L9228`
- `ServiceEarning` → `schema.prisma:L19277`
- `ServicePayPeriod` → `schema.prisma:L19253`
- `ServicePayTable` → `schema.prisma:L19161`
- `ServicePayTableCell` → `schema.prisma:L19203`
- `ServicePayTableVersion` → `schema.prisma:L19178`
- `Session` → `schema.prisma:L18827`
- `SettlementConfiguration` → `schema.prisma:L7426`
- `SettlementConfirmation` → `schema.prisma:L7539`
- `SettlementIncident` → `schema.prisma:L7490`
- `SettlementSimulation` → `schema.prisma:L7461`
- `Shift` → `schema.prisma:L3474`
- `ShopifyConnectIntent` → `schema.prisma:L19598`
- `ShopifyImportIssue` → `schema.prisma:L19652`
- `ShopifyInboundEvent` → `schema.prisma:L19574`
- `ShopifyLocationLink` → `schema.prisma:L19448`
- `ShopifyReviewItem` → `schema.prisma:L19620`
- `ShopifyStockOutbox` → `schema.prisma:L19544`
- `ShopifyStore` → `schema.prisma:L19419`
- `ShopifyVariantLink` → `schema.prisma:L19496`
- `SimRegistrationRequest` → `schema.prisma:L12856`
- `SimRegistrationRequestItem` → `schema.prisma:L12878`
- `SlotHold` → `schema.prisma:L14446`
- `Staff` → `schema.prisma:L1037`
- `StaffAssignment` → `schema.prisma:L3761`
- `StaffDocument` → `schema.prisma:L3785`
- `StaffOnboardingState` → `schema.prisma:L16930`
- `StaffOrganization` → `schema.prisma:L1375`
- `StaffPasskey` → `schema.prisma:L1402`
- `StaffPayLevel` → `schema.prisma:L19125`
- `StaffPayLevelAssignment` → `schema.prisma:L19143`
- `StaffPayStatement` → `schema.prisma:L19309`
- `StaffPayTipWindow` → `schema.prisma:L19671`
- `StaffPayVenueWindow` → `schema.prisma:L19688`
- `StaffPosition` → `schema.prisma:L3740`
- `StaffSchedule` → `schema.prisma:L14386`
- `StaffScheduleException` → `schema.prisma:L14398`
- `StaffVenue` → `schema.prisma:L1299`
- `StaffWorkSchedule` → `schema.prisma:L3599`
- `StaffWorkScheduleException` → `schema.prisma:L3697`
- `StampCard` → `schema.prisma:L8471`
- `StampEvent` → `schema.prisma:L8510`
- `StampReward` → `schema.prisma:L8548`
- `StockAlertConfig` → `schema.prisma:L13517`
- `StockBatch` → `schema.prisma:L3111`
- `StockCount` → `schema.prisma:L3024`
- `StockCountItem` → `schema.prisma:L3052`
- `StripeWebhookEvent` → `schema.prisma:L7069`
- `Supplier` → `schema.prisma:L2506`
- `SupplierItemCode` → `schema.prisma:L2851`
- `SupplierPricing` → `schema.prisma:L2561`
- `Table` → `schema.prisma:L3365`
- `Terminal` → `schema.prisma:L5448`
- `TerminalAttemptResolution` → `schema.prisma:L5886`
- `TerminalHealth` → `schema.prisma:L5706`
- `TerminalLog` → `schema.prisma:L5680`
- `TerminalOrder` → `schema.prisma:L5930`
- `TerminalOrderItem` → `schema.prisma:L6005`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5858`
- `TerminalPaymentRequest` → `schema.prisma:L5777`
- `TimeEntry` → `schema.prisma:L3827`
- `TimeEntryBreak` → `schema.prisma:L3896`
- `TokenPurchase` → `schema.prisma:L10673`
- `TokenUsageRecord` → `schema.prisma:L10645`
- `TpvCommandHistory` → `schema.prisma:L10907`
- `TpvCommandQueue` → `schema.prisma:L10845`
- `TpvFeedback` → `schema.prisma:L10558`
- `TpvMessage` → `schema.prisma:L13874`
- `TpvMessageDelivery` → `schema.prisma:L13926`
- `TpvMessageResponse` → `schema.prisma:L13949`
- `TrainingModule` → `schema.prisma:L14004`
- `TrainingProgress` → `schema.prisma:L14081`
- `TrainingQuizQuestion` → `schema.prisma:L14063`
- `TrainingStep` → `schema.prisma:L14043`
- `TransactionCost` → `schema.prisma:L7289`
- `UnitConversion` → `schema.prisma:L2919`
- `UpsellAcceptance` → `schema.prisma:L9044`
- `UpsellAiRun` → `schema.prisma:L9064`
- `UpsellImpression` → `schema.prisma:L9004`
- `UpsellRule` → `schema.prisma:L8924`
- `user_sessions` → `schema.prisma:L6507`
- `Venue` → `schema.prisma:L186`
- `VenueAreaTicketSettings` → `schema.prisma:L16337`
- `VenueChatMessage` → `schema.prisma:L845`
- `VenueChatSession` → `schema.prisma:L800`
- `VenueCommission` → `schema.prisma:L15932`
- `VenueCreditAssessment` → `schema.prisma:L11389`
- `VenueCryptoConfig` → `schema.prisma:L13741`
- `VenueFeature` → `schema.prisma:L4968`
- `VenueIvaPorProducto` → `schema.prisma:L1000`
- `VenueModule` → `schema.prisma:L11549`
- `VenuePaymentConfig` → `schema.prisma:L6608`
- `VenuePaymentLinkSettings` → `schema.prisma:L15271`
- `VenuePosSinAparato` → `schema.prisma:L1011`
- `VenuePricingStructure` → `schema.prisma:L7229`
- `VenueRoleConfig` → `schema.prisma:L1528`
- `VenueRolePermission` → `schema.prisma:L1432`
- `VenueScaleSettings` → `schema.prisma:L16588`
- `VenueSettings` → `schema.prisma:L885`
- `VenueTenderType` → `schema.prisma:L4713`
- `VenueTenderTypeRevision` → `schema.prisma:L4778`
- `VenueTransaction` → `schema.prisma:L4905`
- `VenueWhatsappActivation` → `schema.prisma:L736`
- `WalletCardDesign` → `schema.prisma:L8389`
- `WalletPass` → `schema.prisma:L8290`
- `WalletPassRegistration` → `schema.prisma:L8356`
- `WebhookEvent` → `schema.prisma:L5306`
- `WebhookSubscription` → `schema.prisma:L6724`
- `WhatsappContactWindow` → `schema.prisma:L754`
- `WhatsappInboundEvent` → `schema.prisma:L774`
- `WorkShiftAssignment` → `schema.prisma:L3639`
- `WorkShiftTemplate` → `schema.prisma:L3616`
- `Zone` → `schema.prisma:L169`
