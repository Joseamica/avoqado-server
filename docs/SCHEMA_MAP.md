# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **427 models / 402 enums / ~19,900 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
what each is for, and where it lives. Find your domain → jump to the `schema.prisma:LINE` → for field-level detail read
`docs/DATABASE_SCHEMA.md`.

**How to use this:** "I need to touch X" → scan the _What it is_ column → open the domain at its line. Every model is listed once, in its
primary domain.

**Universal rules** (also in `.claude/rules/critical-warnings.md`):

- Every row of every table is scoped by `venueId` or `orgId`. Multi-tenant: `Organization → Venue → data`.
- Money is `Decimal`, never float. Money writes go in `prisma.$transaction()`.
- Two parallel gating systems: **Module** (free/internal) vs **Feature** (paid, Stripe). See `.claude/rules/feature-gating.md`.

## The 22 domains

| #   | Domain                                  | What it is                                                                                                     | Models (`schema.prisma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `FloorPlanPublication`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueIvaPorProducto`, `VenuePosSinAparato`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `CapabilityGrant`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `HybridBillingOperation`, `HybridCampaign`, `HybridContract`, `HybridContractSelection`, `HybridCreditAllocation`, `HybridOfferPublication`, `HybridPaymentPeriod`, `HybridPromotionGroup`, `HybridPurchase`, `HybridRedemption`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                        |
| 3   | **Staff, Auth, Permissions & Time**     | Who works where, how they log in, what they may do, and hours worked.                                          | `DeviceToken`, `Invitation`, `McpAuthCode`, `McpOAuthClient`, `McpRefreshToken`, `McpToolCall`, `OAuthState`, `OvertimeApproval`, `PermissionOverride`, `PermissionSet`, `PromoterLocationPing`, `RefreshGrant`, `Session`, `Staff`, `StaffAssignment`, `StaffDocument`, `StaffOrganization`, `StaffPasskey`, `StaffPosition`, `StaffVenue`, `StaffWorkSchedule`, `StaffWorkScheduleException`, `TimeEntry`, `TimeEntryBreak`, `user_sessions`, `VenueRoleConfig`, `VenueRolePermission`, `WorkShiftAssignment`, `WorkShiftTemplate`                                                                                                                                                                                                                                                                                                                                                                        |
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 6   | **Master Catalog & Publication**        | Organization-owned catalog identity, validation, rollout, bindings, batch recovery, and publication outbox.    | `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogBrand`, `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogFamily`, `CatalogIdempotencyRecord`, `CatalogIdentifier`, `CatalogImportBatch`, `CatalogImportLine`, `CatalogItem`, `CatalogItemBusinessType`, `CatalogItemPrice`, `CatalogManufacturer`, `CatalogProductTypeMapping`, `CatalogPublicationBatch`, `CatalogPublicationFieldDecision`, `CatalogPublicationLine`, `CatalogPublicationOutbox`, `CatalogValidationProfile`, `CatalogVenueBinding`, `CatalogVenueClientRequirement`, `CatalogVenueEventSequence`, `CatalogVenueOverride`, `CatalogVenueRollout`                                                                                                                                                                                                                                                                |
| 7   | **Inventory & Stock**                   | Stock on hand, raw materials, recipes, suppliers, purchase orders, FIFO batches.                               | `InterVenueTransfer`, `InterVenueTransferAllocation`, `InterVenueTransferItem`, `InterVenueTransferReceipt`, `InterVenueTransferReceiptLine`, `InterVenueTransferVarianceLine`, `InterVenueTransferVarianceResolution`, `Inventory`, `InventoryMovement`, `InventoryPosting`, `InventoryPostingLine`, `InventoryTransfer`, `InventoryWasteReport`, `LowStockAlert`, `PurchaseOrder`, `PurchaseOrderInvoice`, `PurchaseOrderInvoiceLine`, `PurchaseOrderItem`, `RawMaterial`, `RawMaterialMovement`, `RawMaterialPresentation`, `Recipe`, `RecipeLine`, `ShopifyConnectIntent`, `ShopifyImportIssue`, `ShopifyInboundEvent`, `ShopifyLocationLink`, `ShopifyReviewItem`, `ShopifyStockOutbox`, `ShopifyStore`, `ShopifyVariantLink`, `StockAlertConfig`, `StockBatch`, `StockCount`, `StockCountItem`, `Supplier`, `SupplierItemCode`, `SupplierPricing`                                                     |
| 8   | **Serialized Inventory**                | Unique-barcode items (SIM cards etc.) with chain-of-custody + post-payment verification.                       | `SaleVerification`, `SerializedItem`, `SerializedItemCustodyEvent`, `SimRegistrationRequest`, `SimRegistrationRequestItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 9   | **Orders, KDS & Cash**                  | The order lifecycle, kitchen display, shifts, and cash drawer / corte de caja.                                 | `AreaTicket`, `AreaTicketCheckoutSession`, `AreaTicketExternalIncident`, `AreaTicketExternalSettlement`, `AreaTicketFulfillment`, `AreaTicketInventoryReservation`, `AreaTicketLine`, `AreaTicketPaymentAttempt`, `AreaTicketPrintAttempt`, `CashCloseout`, `CashDeposit`, `CashDrawerEvent`, `CashDrawerSession`, `DeliveryActivationRequest`, `DeliveryChannelLink`, `DeliveryConnectIntent`, `DeliveryLineAction`, `DeliveryOrderEvent`, `DeliveryStoreRevocation`, `FulfillmentArea`, `KdsOrder`, `KdsOrderItem`, `MoneyAnomaly`, `OnlineOrder`, `OnlineOrderingSettings`, `Order`, `OrderAction`, `OrderCustomer`, `OrderDiscount`, `OrderFulfillment`, `OrderFulfillmentLine`, `OrderItem`, `OrderItemModifier`, `OrderPromotion`, `OrderServiceCharge`, `PosSyncIntent`, `Printer`, `PrintGateway`, `PrintJob`, `PrintStation`, `ReceiptLayout`, `ServiceCharge`, `Shift`, `VenueAreaTicketSettings` |
| 10  | **Payments & Fees**                     | The payment record itself + allocations, receipts, fee schedules.                                              | `BankStatement`, `BankStatementLine`, `DigitalReceipt`, `FeeSchedule`, `FeeTier`, `IdempotencyRequest`, `MerchantRoutingRule`, `Payment`, `PaymentAllocation`, `PaymentEffect`, `TransactionCost`, `VenueTenderType`, `VenueTenderTypeRevision`, `VenueTransaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 11  | **Payment Providers & Settlement**      | Blumon / Stripe / MercadoPago / AngelPay merchant accounts, webhooks, settlement.                              | `Aggregator`, `AngelPayUserAccount`, `CheckoutSession`, `EcommerceMerchant`, `FinancialAccount`, `FinancialConnection`, `FinancialProvider`, `MercadoPagoWebhookEvent`, `MerchantAccount`, `MerchantRevenueShare`, `OrganizationPaymentConfig`, `OrganizationPayoutConfig`, `PaymentProvider`, `ProcessedStripeEvent`, `ProcessorReliabilityMetric`, `ProviderCostStructure`, `ProviderEventLog`, `RateCorrectionBatch`, `RateCorrectionEntry`, `SettlementConfiguration`, `SettlementConfirmation`, `SettlementIncident`, `SettlementSimulation`, `StripeWebhookEvent`, `VenuePaymentConfig`                                                                                                                                                                                                                                                                                                               |
| 12  | **Payment Links**                       | Pay-by-link: links, line items, attribution.                                                                   | `PaymentLink`, `PaymentLinkAttribution`, `PaymentLinkItem`, `PaymentLinkItemModifier`, `VenuePaymentLinkSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CfdiGlobalOrden`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `OrderItemSelloIva`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `GiftCard`, `GiftCardActivity`, `GiftCardSettings`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                                                                                     |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `ClassSessionPayState`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `ServiceEarning`, `ServicePayPeriod`, `ServicePayTable`, `ServicePayTableCell`, `ServicePayTableVersion`, `StaffPayLevel`, `StaffPayLevelAssignment`, `StaffPayStatement`, `StaffPayTipWindow`, `StaffPayVenueWindow`, `VenueCommission`                                                                                                                                                                                                                                             |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `AggregatorBooking`, `AggregatorCapacityRule`, `AggregatorConnection`, `AggregatorInboundEvent`, `AggregatorOutbox`, `AggregatorProductLink`, `AggregatorSessionLink`, `AggregatorVisit`, `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                          |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalAttemptResolution`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerExternalIdentity`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L17818`
- `AccountMapping` → `schema.prisma:L17713`
- `ActivityLog` → `schema.prisma:L7684`
- `Aggregator` → `schema.prisma:L15964`
- `AggregatorBooking` → `schema.prisma:L15272`
- `AggregatorCapacityRule` → `schema.prisma:L15253`
- `AggregatorConnection` → `schema.prisma:L15178`
- `AggregatorInboundEvent` → `schema.prisma:L15341`
- `AggregatorOutbox` → `schema.prisma:L15361`
- `AggregatorProductLink` → `schema.prisma:L15210`
- `AggregatorSessionLink` → `schema.prisma:L15229`
- `AggregatorVisit` → `schema.prisma:L15298`
- `AngelPayUserAccount` → `schema.prisma:L6229`
- `AppUpdate` → `schema.prisma:L13839`
- `Area` → `schema.prisma:L3313`
- `AreaTicket` → `schema.prisma:L16513`
- `AreaTicketCheckoutSession` → `schema.prisma:L16635`
- `AreaTicketExternalIncident` → `schema.prisma:L16882`
- `AreaTicketExternalSettlement` → `schema.prisma:L16847`
- `AreaTicketFulfillment` → `schema.prisma:L16711`
- `AreaTicketInventoryReservation` → `schema.prisma:L16606`
- `AreaTicketLine` → `schema.prisma:L16574`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16667`
- `AreaTicketPrintAttempt` → `schema.prisma:L16690`
- `BankStatement` → `schema.prisma:L17587`
- `BankStatementLine` → `schema.prisma:L17608`
- `BillingObligationConflict` → `schema.prisma:L5259`
- `BillingTaxProfile` → `schema.prisma:L18410`
- `BirthdayAutomation` → `schema.prisma:L8009`
- `BulkCommandOperation` → `schema.prisma:L11111`
- `CalendarSyncOutbox` → `schema.prisma:L15061`
- `CampaignDelivery` → `schema.prisma:L13997`
- `CapabilityGrant` → `schema.prisma:L4999`
- `CashCloseout` → `schema.prisma:L11496`
- `CashDeposit` → `schema.prisma:L13641`
- `CashDrawerEvent` → `schema.prisma:L15801`
- `CashDrawerSession` → `schema.prisma:L15762`
- `CashOutCommissionRate` → `schema.prisma:L18227`
- `CashOutScheduleDay` → `schema.prisma:L18250`
- `CashOutWithdrawal` → `schema.prisma:L18312`
- `CatalogBindingBatch` → `schema.prisma:L12527`
- `CatalogBindingLine` → `schema.prisma:L12563`
- `CatalogBrand` → `schema.prisma:L11980`
- `CatalogClientObservation` → `schema.prisma:L12293`
- `CatalogClientReadinessOverride` → `schema.prisma:L12312`
- `CatalogFamily` → `schema.prisma:L12030`
- `CatalogIdempotencyRecord` → `schema.prisma:L12426`
- `CatalogIdentifier` → `schema.prisma:L12161`
- `CatalogImportBatch` → `schema.prisma:L12469`
- `CatalogImportLine` → `schema.prisma:L12506`
- `CatalogItem` → `schema.prisma:L12063`
- `CatalogItemBusinessType` → `schema.prisma:L12123`
- `CatalogItemPrice` → `schema.prisma:L12211`
- `CatalogManufacturer` → `schema.prisma:L12004`
- `CatalogProductTypeMapping` → `schema.prisma:L12140`
- `CatalogPublicationBatch` → `schema.prisma:L12591`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12685`
- `CatalogPublicationLine` → `schema.prisma:L12632`
- `CatalogPublicationOutbox` → `schema.prisma:L12728`
- `CatalogValidationProfile` → `schema.prisma:L12182`
- `CatalogVenueBinding` → `schema.prisma:L12340`
- `CatalogVenueClientRequirement` → `schema.prisma:L12267`
- `CatalogVenueEventSequence` → `schema.prisma:L12711`
- `CatalogVenueOverride` → `schema.prisma:L12382`
- `CatalogVenueRollout` → `schema.prisma:L12242`
- `Cfdi` → `schema.prisma:L17409`
- `CfdiGlobalOrden` → `schema.prisma:L17540`
- `ChatbotTokenBudget` → `schema.prisma:L10757`
- `ChatConversation` → `schema.prisma:L10612`
- `ChatFeedback` → `schema.prisma:L10698`
- `ChatLearningEvent` → `schema.prisma:L10655`
- `ChatMessage` → `schema.prisma:L10635`
- `ChatTrainingData` → `schema.prisma:L10569`
- `CheckoutSession` → `schema.prisma:L6509`
- `ClassSession` → `schema.prisma:L14655`
- `ClassSessionPayState` → `schema.prisma:L19370`
- `CommissionCalculation` → `schema.prisma:L13416`
- `CommissionClawback` → `schema.prisma:L13593`
- `CommissionConfig` → `schema.prisma:L13175`
- `CommissionMilestone` → `schema.prisma:L13332`
- `CommissionOverride` → `schema.prisma:L13259`
- `CommissionPayout` → `schema.prisma:L13544`
- `CommissionSummary` → `schema.prisma:L13483`
- `CommissionTier` → `schema.prisma:L13296`
- `ConsentEvent` → `schema.prisma:L7871`
- `Consumer` → `schema.prisma:L8101`
- `ConsumerAuthAccount` → `schema.prisma:L8126`
- `CouponCode` → `schema.prisma:L9240`
- `CouponRedemption` → `schema.prisma:L9271`
- `CreditAssessmentHistory` → `schema.prisma:L11605`
- `CreditItemBalance` → `schema.prisma:L15552`
- `CreditOffer` → `schema.prisma:L11624`
- `CreditPack` → `schema.prisma:L15461`
- `CreditPackItem` → `schema.prisma:L15490`
- `CreditPackPurchase` → `schema.prisma:L15507`
- `CreditTransaction` → `schema.prisma:L15574`
- `Customer` → `schema.prisma:L7725`
- `CustomerApprovalDelivery` → `schema.prisma:L10270`
- `CustomerApprovalOutbox` → `schema.prisma:L10245`
- `CustomerCampaign` → `schema.prisma:L7959`
- `CustomerCampaignDelivery` → `schema.prisma:L8041`
- `CustomerCaptureToken` → `schema.prisma:L7907`
- `CustomerDiscount` → `schema.prisma:L9291`
- `CustomerExternalIdentity` → `schema.prisma:L15328`
- `CustomerGroup` → `schema.prisma:L8165`
- `CustomerOrderMetric` → `schema.prisma:L4202`
- `CustomerTaxProfile` → `schema.prisma:L17559`
- `DeliveryActivationRequest` → `schema.prisma:L6968`
- `DeliveryChannelLink` → `schema.prisma:L6807`
- `DeliveryConnectIntent` → `schema.prisma:L6919`
- `DeliveryLineAction` → `schema.prisma:L6880`
- `DeliveryOrderEvent` → `schema.prisma:L6992`
- `DeliveryStoreRevocation` → `schema.prisma:L6956`
- `DeviceToken` → `schema.prisma:L9565`
- `DigitalReceipt` → `schema.prisma:L4812`
- `Discount` → `schema.prisma:L8930`
- `EcommerceMerchant` → `schema.prisma:L6321`
- `EmailQuotaLedger` → `schema.prisma:L8088`
- `EmailSuppression` → `schema.prisma:L8076`
- `EmailTemplate` → `schema.prisma:L13936`
- `Employee` → `schema.prisma:L18075`
- `Estimate` → `schema.prisma:L15871`
- `EstimateItem` → `schema.prisma:L15899`
- `Expense` → `schema.prisma:L17862`
- `ExternalBusyBlock` → `schema.prisma:L14954`
- `Feature` → `schema.prisma:L4941`
- `FeeSchedule` → `schema.prisma:L5321`
- `FeeTier` → `schema.prisma:L5332`
- `FinancialAccount` → `schema.prisma:L16061`
- `FinancialConnection` → `schema.prisma:L16030`
- `FinancialProvider` → `schema.prisma:L16016`
- `FiscalEmisor` → `schema.prisma:L17320`
- `FiscalLossCarryforward` → `schema.prisma:L17985`
- `FixedAsset` → `schema.prisma:L18003`
- `FixedAssetDepreciation` → `schema.prisma:L18032`
- `FloorElement` → `schema.prisma:L3398`
- `FloorPlanPublication` → `schema.prisma:L3438`
- `FulfillmentArea` → `schema.prisma:L16378`
- `GeofenceRule` → `schema.prisma:L11196`
- `GiftCard` → `schema.prisma:L8396`
- `GiftCardActivity` → `schema.prisma:L8448`
- `GiftCardSettings` → `schema.prisma:L8481`
- `GoogleCalendarChannel` → `schema.prisma:L14931`
- `GoogleCalendarConnection` → `schema.prisma:L14883`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14984`
- `GoogleOAuthSession` → `schema.prisma:L15006`
- `HolidayCalendar` → `schema.prisma:L7608`
- `HybridBillingOperation` → `schema.prisma:L5183`
- `HybridCampaign` → `schema.prisma:L5024`
- `HybridContract` → `schema.prisma:L5140`
- `HybridContractSelection` → `schema.prisma:L5172`
- `HybridCreditAllocation` → `schema.prisma:L5239`
- `HybridOfferPublication` → `schema.prisma:L5087`
- `HybridPaymentPeriod` → `schema.prisma:L5218`
- `HybridPromotionGroup` → `schema.prisma:L5068`
- `HybridPurchase` → `schema.prisma:L5107`
- `HybridRedemption` → `schema.prisma:L5201`
- `IdempotencyRequest` → `schema.prisma:L13050`
- `InterVenueTransfer` → `schema.prisma:L3141`
- `InterVenueTransferAllocation` → `schema.prisma:L3224`
- `InterVenueTransferItem` → `schema.prisma:L3193`
- `InterVenueTransferReceipt` → `schema.prisma:L3251`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3267`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3295`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3279`
- `Inventory` → `schema.prisma:L2063`
- `InventoryMovement` → `schema.prisma:L2163`
- `InventoryPosting` → `schema.prisma:L2258`
- `InventoryPostingLine` → `schema.prisma:L2298`
- `InventoryTransfer` → `schema.prisma:L15843`
- `InventoryWasteReport` → `schema.prisma:L2118`
- `Invitation` → `schema.prisma:L1553`
- `Invoice` → `schema.prisma:L5344`
- `InvoiceItem` → `schema.prisma:L5370`
- `ItemCategory` → `schema.prisma:L12763`
- `JournalEntry` → `schema.prisma:L17771`
- `JournalLine` → `schema.prisma:L17800`
- `KdsOrder` → `schema.prisma:L16109`
- `KdsOrderItem` → `schema.prisma:L16176`
- `KioskCheckInAttempt` → `schema.prisma:L18733`
- `KioskCheckInChallenge` → `schema.prisma:L18687`
- `KioskOutreachOutbox` → `schema.prisma:L18754`
- `LaunchCampaign` → `schema.prisma:L19092`
- `LaunchCampaignRedemption` → `schema.prisma:L19209`
- `LearnedPatterns` → `schema.prisma:L10679`
- `LedgerAccount` → `schema.prisma:L17663`
- `LiveDemoSession` → `schema.prisma:L871`
- `LowStockAlert` → `schema.prisma:L2971`
- `LoyaltyConfig` → `schema.prisma:L8195`
- `LoyaltyTransaction` → `schema.prisma:L8238`
- `MarketingCampaign` → `schema.prisma:L13954`
- `McpAuthCode` → `schema.prisma:L17201`
- `McpOAuthClient` → `schema.prisma:L17185`
- `McpRefreshToken` → `schema.prisma:L17219`
- `McpToolCall` → `schema.prisma:L17241`
- `MeasurementUnit` → `schema.prisma:L15949`
- `Menu` → `schema.prisma:L1771`
- `MenuCategory` → `schema.prisma:L1708`
- `MenuCategoryAssignment` → `schema.prisma:L1806`
- `MercadoPagoWebhookEvent` → `schema.prisma:L17115`
- `MerchantAccount` → `schema.prisma:L6059`
- `MerchantFiscalConfig` → `schema.prisma:L17380`
- `MerchantRevenueShare` → `schema.prisma:L7188`
- `MerchantRoutingRule` → `schema.prisma:L6181`
- `MilestoneAchievement` → `schema.prisma:L13377`
- `Modifier` → `schema.prisma:L4409`
- `ModifierGroup` → `schema.prisma:L4373`
- `Module` → `schema.prisma:L11672`
- `MoneyAnomaly` → `schema.prisma:L7091`
- `MonthlyVenueProfit` → `schema.prisma:L7634`
- `Notification` → `schema.prisma:L9467`
- `NotificationPreference` → `schema.prisma:L9514`
- `NotificationTemplate` → `schema.prisma:L9541`
- `OAuthState` → `schema.prisma:L1604`
- `OnboardingProgress` → `schema.prisma:L1622`
- `OnlineOrder` → `schema.prisma:L19912`
- `OnlineOrderingSettings` → `schema.prisma:L19888`
- `Order` → `schema.prisma:L3927`
- `OrderAction` → `schema.prisma:L4480`
- `OrderCustomer` → `schema.prisma:L4181`
- `OrderDiscount` → `schema.prisma:L9323`
- `OrderFulfillment` → `schema.prisma:L16433`
- `OrderFulfillmentLine` → `schema.prisma:L16464`
- `OrderItem` → `schema.prisma:L4217`
- `OrderItemModifier` → `schema.prisma:L4462`
- `OrderItemSelloIva` → `schema.prisma:L17520`
- `OrderPromotion` → `schema.prisma:L18650`
- `OrderServiceCharge` → `schema.prisma:L9412`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13755`
- `OrganizationEntitlement` → `schema.prisma:L11955`
- `OrganizationGoal` → `schema.prisma:L13713`
- `OrganizationModule` → `schema.prisma:L11732`
- `OrganizationPaymentConfig` → `schema.prisma:L6633`
- `OrganizationPayoutConfig` → `schema.prisma:L13788`
- `OrganizationPricingStructure` → `schema.prisma:L6665`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13736`
- `OtpChallenge` → `schema.prisma:L8145`
- `OvertimeApproval` → `schema.prisma:L3642`
- `PartnerAPIKey` → `schema.prisma:L6463`
- `Payment` → `schema.prisma:L4513`
- `PaymentAllocation` → `schema.prisma:L4791`
- `PaymentEffect` → `schema.prisma:L19024`
- `PaymentLink` → `schema.prisma:L15620`
- `PaymentLinkAttribution` → `schema.prisma:L15728`
- `PaymentLinkItem` → `schema.prisma:L15683`
- `PaymentLinkItemModifier` → `schema.prisma:L15710`
- `PaymentProvider` → `schema.prisma:L6018`
- `PayrollLine` → `schema.prisma:L18146`
- `PayrollRun` → `schema.prisma:L18115`
- `PerformanceGoal` → `schema.prisma:L13690`
- `PermissionOverride` → `schema.prisma:L1477`
- `PermissionSet` → `schema.prisma:L1500`
- `PlatformAnnouncement` → `schema.prisma:L18814`
- `PlatformAnnouncementClick` → `schema.prisma:L18879`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18916`
- `PlatformCfdi` → `schema.prisma:L18443`
- `PlatformEmisor` → `schema.prisma:L18383`
- `PlatformSettings` → `schema.prisma:L6440`
- `PosCommand` → `schema.prisma:L9595`
- `PosConnectionStatus` → `schema.prisma:L1019`
- `PosSyncIntent` → `schema.prisma:L18521`
- `PricingPolicy` → `schema.prisma:L2867`
- `Printer` → `schema.prisma:L16234`
- `PrintGateway` → `schema.prisma:L16291`
- `PrintJob` → `schema.prisma:L17014`
- `PrintStation` → `schema.prisma:L16309`
- `PrivacyNoticeVersion` → `schema.prisma:L7893`
- `ProcessedStripeEvent` → `schema.prisma:L7077`
- `ProcessorReliabilityMetric` → `schema.prisma:L7562`
- `Product` → `schema.prisma:L1824`
- `ProductModifierGroup` → `schema.prisma:L4450`
- `ProductOption` → `schema.prisma:L15926`
- `ProductOptionValue` → `schema.prisma:L15937`
- `ProductStaff` → `schema.prisma:L14570`
- `PromoterBankAccount` → `schema.prisma:L18266`
- `PromoterCommissionEntry` → `schema.prisma:L18285`
- `PromoterLocationPing` → `schema.prisma:L3893`
- `Promotion` → `schema.prisma:L18572`
- `PromotionGroup` → `schema.prisma:L18611`
- `PromotionOption` → `schema.prisma:L18627`
- `ProviderCostStructure` → `schema.prisma:L7113`
- `ProviderEventLog` → `schema.prisma:L6742`
- `PurchaseOrder` → `schema.prisma:L2574`
- `PurchaseOrderInvoice` → `schema.prisma:L2719`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2786`
- `PurchaseOrderItem` → `schema.prisma:L2632`
- `RateCorrectionBatch` → `schema.prisma:L7338`
- `RateCorrectionEntry` → `schema.prisma:L7380`
- `RawMaterial` → `schema.prisma:L2330`
- `RawMaterialMovement` → `schema.prisma:L2920`
- `RawMaterialPresentation` → `schema.prisma:L2406`
- `ReceiptLayout` → `schema.prisma:L19058`
- `Recipe` → `schema.prisma:L2426`
- `RecipeLine` → `schema.prisma:L2450`
- `Referral` → `schema.prisma:L8778`
- `ReferralProgramConfig` → `schema.prisma:L8743`
- `ReferralRewardGrant` → `schema.prisma:L8869`
- `ReferralTierReward` → `schema.prisma:L8841`
- `ReferralTierUnlock` → `schema.prisma:L8914`
- `RefreshGrant` → `schema.prisma:L19003`
- `Reservation` → `schema.prisma:L14333`
- `ReservationGoogleEventMapping` → `schema.prisma:L15393`
- `ReservationModifier` → `schema.prisma:L14518`
- `ReservationReminderSent` → `schema.prisma:L14501`
- `ReservationSettings` → `schema.prisma:L14742`
- `ReservationWaitlistEntry` → `schema.prisma:L14710`
- `Review` → `schema.prisma:L5388`
- `SalesRetention` → `schema.prisma:L17966`
- `SaleVerification` → `schema.prisma:L4845`
- `ScaleProfile` → `schema.prisma:L16755`
- `ScheduledCommand` → `schema.prisma:L11156`
- `SerializedItem` → `schema.prisma:L12806`
- `SerializedItemCustodyEvent` → `schema.prisma:L12973`
- `ServiceCharge` → `schema.prisma:L9383`
- `ServiceEarning` → `schema.prisma:L19432`
- `ServicePayPeriod` → `schema.prisma:L19408`
- `ServicePayTable` → `schema.prisma:L19316`
- `ServicePayTableCell` → `schema.prisma:L19358`
- `ServicePayTableVersion` → `schema.prisma:L19333`
- `Session` → `schema.prisma:L18982`
- `SettlementConfiguration` → `schema.prisma:L7413`
- `SettlementConfirmation` → `schema.prisma:L7526`
- `SettlementIncident` → `schema.prisma:L7477`
- `SettlementSimulation` → `schema.prisma:L7448`
- `Shift` → `schema.prisma:L3453`
- `ShopifyConnectIntent` → `schema.prisma:L19753`
- `ShopifyImportIssue` → `schema.prisma:L19807`
- `ShopifyInboundEvent` → `schema.prisma:L19729`
- `ShopifyLocationLink` → `schema.prisma:L19603`
- `ShopifyReviewItem` → `schema.prisma:L19775`
- `ShopifyStockOutbox` → `schema.prisma:L19699`
- `ShopifyStore` → `schema.prisma:L19574`
- `ShopifyVariantLink` → `schema.prisma:L19651`
- `SimRegistrationRequest` → `schema.prisma:L13011`
- `SimRegistrationRequestItem` → `schema.prisma:L13033`
- `SlotHold` → `schema.prisma:L14601`
- `Staff` → `schema.prisma:L1039`
- `StaffAssignment` → `schema.prisma:L3740`
- `StaffDocument` → `schema.prisma:L3764`
- `StaffOnboardingState` → `schema.prisma:L17085`
- `StaffOrganization` → `schema.prisma:L1376`
- `StaffPasskey` → `schema.prisma:L1403`
- `StaffPayLevel` → `schema.prisma:L19280`
- `StaffPayLevelAssignment` → `schema.prisma:L19298`
- `StaffPayStatement` → `schema.prisma:L19464`
- `StaffPayTipWindow` → `schema.prisma:L19826`
- `StaffPayVenueWindow` → `schema.prisma:L19843`
- `StaffPosition` → `schema.prisma:L3719`
- `StaffSchedule` → `schema.prisma:L14541`
- `StaffScheduleException` → `schema.prisma:L14553`
- `StaffVenue` → `schema.prisma:L1300`
- `StaffWorkSchedule` → `schema.prisma:L3578`
- `StaffWorkScheduleException` → `schema.prisma:L3676`
- `StampCard` → `schema.prisma:L8626`
- `StampEvent` → `schema.prisma:L8665`
- `StampReward` → `schema.prisma:L8703`
- `StockAlertConfig` → `schema.prisma:L13672`
- `StockBatch` → `schema.prisma:L3090`
- `StockCount` → `schema.prisma:L3003`
- `StockCountItem` → `schema.prisma:L3031`
- `StripeWebhookEvent` → `schema.prisma:L7060`
- `Supplier` → `schema.prisma:L2485`
- `SupplierItemCode` → `schema.prisma:L2830`
- `SupplierPricing` → `schema.prisma:L2540`
- `Table` → `schema.prisma:L3344`
- `Terminal` → `schema.prisma:L5439`
- `TerminalAttemptResolution` → `schema.prisma:L5877`
- `TerminalHealth` → `schema.prisma:L5697`
- `TerminalLog` → `schema.prisma:L5671`
- `TerminalOrder` → `schema.prisma:L5921`
- `TerminalOrderItem` → `schema.prisma:L5996`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5849`
- `TerminalPaymentRequest` → `schema.prisma:L5768`
- `TimeEntry` → `schema.prisma:L3806`
- `TimeEntryBreak` → `schema.prisma:L3875`
- `TokenPurchase` → `schema.prisma:L10828`
- `TokenUsageRecord` → `schema.prisma:L10800`
- `TpvCommandHistory` → `schema.prisma:L11062`
- `TpvCommandQueue` → `schema.prisma:L11000`
- `TpvFeedback` → `schema.prisma:L10713`
- `TpvMessage` → `schema.prisma:L14029`
- `TpvMessageDelivery` → `schema.prisma:L14081`
- `TpvMessageResponse` → `schema.prisma:L14104`
- `TrainingModule` → `schema.prisma:L14159`
- `TrainingProgress` → `schema.prisma:L14236`
- `TrainingQuizQuestion` → `schema.prisma:L14218`
- `TrainingStep` → `schema.prisma:L14198`
- `TransactionCost` → `schema.prisma:L7276`
- `UnitConversion` → `schema.prisma:L2898`
- `UpsellAcceptance` → `schema.prisma:L9199`
- `UpsellAiRun` → `schema.prisma:L9219`
- `UpsellImpression` → `schema.prisma:L9159`
- `UpsellRule` → `schema.prisma:L9079`
- `user_sessions` → `schema.prisma:L6498`
- `Venue` → `schema.prisma:L185`
- `VenueAreaTicketSettings` → `schema.prisma:L16492`
- `VenueChatMessage` → `schema.prisma:L847`
- `VenueChatSession` → `schema.prisma:L802`
- `VenueCommission` → `schema.prisma:L16087`
- `VenueCreditAssessment` → `schema.prisma:L11544`
- `VenueCryptoConfig` → `schema.prisma:L13896`
- `VenueFeature` → `schema.prisma:L4959`
- `VenueIvaPorProducto` → `schema.prisma:L1002`
- `VenueModule` → `schema.prisma:L11704`
- `VenuePaymentConfig` → `schema.prisma:L6599`
- `VenuePaymentLinkSettings` → `schema.prisma:L15426`
- `VenuePosSinAparato` → `schema.prisma:L1013`
- `VenuePricingStructure` → `schema.prisma:L7216`
- `VenueRoleConfig` → `schema.prisma:L1529`
- `VenueRolePermission` → `schema.prisma:L1433`
- `VenueScaleSettings` → `schema.prisma:L16743`
- `VenueSettings` → `schema.prisma:L887`
- `VenueTenderType` → `schema.prisma:L4699`
- `VenueTenderTypeRevision` → `schema.prisma:L4769`
- `VenueTransaction` → `schema.prisma:L4896`
- `VenueWhatsappActivation` → `schema.prisma:L738`
- `WalletCardDesign` → `schema.prisma:L8544`
- `WalletPass` → `schema.prisma:L8278`
- `WalletPassRegistration` → `schema.prisma:L8511`
- `WebhookEvent` → `schema.prisma:L5297`
- `WebhookSubscription` → `schema.prisma:L6715`
- `WhatsappContactWindow` → `schema.prisma:L756`
- `WhatsappInboundEvent` → `schema.prisma:L776`
- `WorkShiftAssignment` → `schema.prisma:L3618`
- `WorkShiftTemplate` → `schema.prisma:L3595`
- `Zone` → `schema.prisma:L168`
