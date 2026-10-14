# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **424 models / 394 enums / ~19,700 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 4   | **Onboarding & Training**               | New-venue/new-staff onboarding state + the LMS.                                                                | `LiveDemoSession`, `OnboardingProgress`, `StaffOnboardingState`, `TrainingModule`, `TrainingProgress`, `TrainingQuizQuestion`, `TrainingStep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5   | **Menu, Products & Modifiers**          | The catalog: what a venue sells and its variants/add-ons.                                                      | `ItemCategory`, `MeasurementUnit`, `Menu`, `MenuCategory`, `MenuCategoryAssignment`, `Modifier`, `ModifierGroup`, `Product`, `ProductModifierGroup`, `ProductOption`, `ProductOptionValue`, `UnitConversion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
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
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `CustomerDisplayAsset`, `CustomerDisplayDesign`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalAttemptResolution`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                  |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerExternalIdentity`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L17693`
- `AccountMapping` → `schema.prisma:L17588`
- `ActivityLog` → `schema.prisma:L7720`
- `Aggregator` → `schema.prisma:L15842`
- `AggregatorBooking` → `schema.prisma:L15150`
- `AggregatorCapacityRule` → `schema.prisma:L15131`
- `AggregatorConnection` → `schema.prisma:L15056`
- `AggregatorInboundEvent` → `schema.prisma:L15219`
- `AggregatorOutbox` → `schema.prisma:L15239`
- `AggregatorProductLink` → `schema.prisma:L15088`
- `AggregatorSessionLink` → `schema.prisma:L15107`
- `AggregatorVisit` → `schema.prisma:L15176`
- `AngelPayUserAccount` → `schema.prisma:L6265`
- `AppUpdate` → `schema.prisma:L13717`
- `Area` → `schema.prisma:L3309`
- `AreaTicket` → `schema.prisma:L16391`
- `AreaTicketCheckoutSession` → `schema.prisma:L16513`
- `AreaTicketExternalIncident` → `schema.prisma:L16760`
- `AreaTicketExternalSettlement` → `schema.prisma:L16725`
- `AreaTicketFulfillment` → `schema.prisma:L16589`
- `AreaTicketInventoryReservation` → `schema.prisma:L16484`
- `AreaTicketLine` → `schema.prisma:L16452`
- `AreaTicketPaymentAttempt` → `schema.prisma:L16545`
- `AreaTicketPrintAttempt` → `schema.prisma:L16568`
- `BankStatement` → `schema.prisma:L17462`
- `BankStatementLine` → `schema.prisma:L17483`
- `BillingObligationConflict` → `schema.prisma:L5243`
- `BillingTaxProfile` → `schema.prisma:L18285`
- `BirthdayAutomation` → `schema.prisma:L8044`
- `BulkCommandOperation` → `schema.prisma:L10989`
- `CalendarSyncOutbox` → `schema.prisma:L14939`
- `CampaignDelivery` → `schema.prisma:L13875`
- `CapabilityGrant` → `schema.prisma:L4983`
- `CashCloseout` → `schema.prisma:L11374`
- `CashDeposit` → `schema.prisma:L13519`
- `CashDrawerEvent` → `schema.prisma:L15679`
- `CashDrawerSession` → `schema.prisma:L15640`
- `CashOutCommissionRate` → `schema.prisma:L18102`
- `CashOutScheduleDay` → `schema.prisma:L18125`
- `CashOutWithdrawal` → `schema.prisma:L18187`
- `CatalogBindingBatch` → `schema.prisma:L12405`
- `CatalogBindingLine` → `schema.prisma:L12441`
- `CatalogBrand` → `schema.prisma:L11858`
- `CatalogClientObservation` → `schema.prisma:L12171`
- `CatalogClientReadinessOverride` → `schema.prisma:L12190`
- `CatalogFamily` → `schema.prisma:L11908`
- `CatalogIdempotencyRecord` → `schema.prisma:L12304`
- `CatalogIdentifier` → `schema.prisma:L12039`
- `CatalogImportBatch` → `schema.prisma:L12347`
- `CatalogImportLine` → `schema.prisma:L12384`
- `CatalogItem` → `schema.prisma:L11941`
- `CatalogItemBusinessType` → `schema.prisma:L12001`
- `CatalogItemPrice` → `schema.prisma:L12089`
- `CatalogManufacturer` → `schema.prisma:L11882`
- `CatalogProductTypeMapping` → `schema.prisma:L12018`
- `CatalogPublicationBatch` → `schema.prisma:L12469`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12563`
- `CatalogPublicationLine` → `schema.prisma:L12510`
- `CatalogPublicationOutbox` → `schema.prisma:L12606`
- `CatalogValidationProfile` → `schema.prisma:L12060`
- `CatalogVenueBinding` → `schema.prisma:L12218`
- `CatalogVenueClientRequirement` → `schema.prisma:L12145`
- `CatalogVenueEventSequence` → `schema.prisma:L12589`
- `CatalogVenueOverride` → `schema.prisma:L12260`
- `CatalogVenueRollout` → `schema.prisma:L12120`
- `Cfdi` → `schema.prisma:L17286`
- `CfdiGlobalOrden` → `schema.prisma:L17415`
- `ChatbotTokenBudget` → `schema.prisma:L10635`
- `ChatConversation` → `schema.prisma:L10490`
- `ChatFeedback` → `schema.prisma:L10576`
- `ChatLearningEvent` → `schema.prisma:L10533`
- `ChatMessage` → `schema.prisma:L10513`
- `ChatTrainingData` → `schema.prisma:L10447`
- `CheckoutSession` → `schema.prisma:L6545`
- `ClassSession` → `schema.prisma:L14533`
- `ClassSessionPayState` → `schema.prisma:L19245`
- `CommissionCalculation` → `schema.prisma:L13294`
- `CommissionClawback` → `schema.prisma:L13471`
- `CommissionConfig` → `schema.prisma:L13053`
- `CommissionMilestone` → `schema.prisma:L13210`
- `CommissionOverride` → `schema.prisma:L13137`
- `CommissionPayout` → `schema.prisma:L13422`
- `CommissionSummary` → `schema.prisma:L13361`
- `CommissionTier` → `schema.prisma:L13174`
- `ConsentEvent` → `schema.prisma:L7906`
- `Consumer` → `schema.prisma:L8136`
- `ConsumerAuthAccount` → `schema.prisma:L8161`
- `CouponCode` → `schema.prisma:L9108`
- `CouponRedemption` → `schema.prisma:L9139`
- `CreditAssessmentHistory` → `schema.prisma:L11483`
- `CreditItemBalance` → `schema.prisma:L15430`
- `CreditOffer` → `schema.prisma:L11502`
- `CreditPack` → `schema.prisma:L15339`
- `CreditPackItem` → `schema.prisma:L15368`
- `CreditPackPurchase` → `schema.prisma:L15385`
- `CreditTransaction` → `schema.prisma:L15452`
- `Customer` → `schema.prisma:L7761`
- `CustomerApprovalDelivery` → `schema.prisma:L10148`
- `CustomerApprovalOutbox` → `schema.prisma:L10123`
- `CustomerCampaign` → `schema.prisma:L7994`
- `CustomerCampaignDelivery` → `schema.prisma:L8076`
- `CustomerCaptureToken` → `schema.prisma:L7942`
- `CustomerDiscount` → `schema.prisma:L9159`
- `CustomerDisplayAsset` → `schema.prisma:L5681`
- `CustomerDisplayDesign` → `schema.prisma:L5660`
- `CustomerExternalIdentity` → `schema.prisma:L15206`
- `CustomerGroup` → `schema.prisma:L8200`
- `CustomerOrderMetric` → `schema.prisma:L4197`
- `CustomerTaxProfile` → `schema.prisma:L17434`
- `DeliveryActivationRequest` → `schema.prisma:L7004`
- `DeliveryChannelLink` → `schema.prisma:L6843`
- `DeliveryConnectIntent` → `schema.prisma:L6955`
- `DeliveryLineAction` → `schema.prisma:L6916`
- `DeliveryOrderEvent` → `schema.prisma:L7028`
- `DeliveryStoreRevocation` → `schema.prisma:L6992`
- `DeviceToken` → `schema.prisma:L9433`
- `DigitalReceipt` → `schema.prisma:L4796`
- `Discount` → `schema.prisma:L8798`
- `EcommerceMerchant` → `schema.prisma:L6357`
- `EmailQuotaLedger` → `schema.prisma:L8123`
- `EmailSuppression` → `schema.prisma:L8111`
- `EmailTemplate` → `schema.prisma:L13814`
- `Employee` → `schema.prisma:L17950`
- `Estimate` → `schema.prisma:L15749`
- `EstimateItem` → `schema.prisma:L15777`
- `Expense` → `schema.prisma:L17737`
- `ExternalBusyBlock` → `schema.prisma:L14832`
- `Feature` → `schema.prisma:L4925`
- `FeeSchedule` → `schema.prisma:L5305`
- `FeeTier` → `schema.prisma:L5316`
- `FinancialAccount` → `schema.prisma:L15939`
- `FinancialConnection` → `schema.prisma:L15908`
- `FinancialProvider` → `schema.prisma:L15894`
- `FiscalEmisor` → `schema.prisma:L17197`
- `FiscalLossCarryforward` → `schema.prisma:L17860`
- `FixedAsset` → `schema.prisma:L17878`
- `FixedAssetDepreciation` → `schema.prisma:L17907`
- `FloorElement` → `schema.prisma:L3394`
- `FloorPlanPublication` → `schema.prisma:L3434`
- `FulfillmentArea` → `schema.prisma:L16256`
- `GeofenceRule` → `schema.prisma:L11074`
- `GoogleCalendarChannel` → `schema.prisma:L14809`
- `GoogleCalendarConnection` → `schema.prisma:L14761`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14862`
- `GoogleOAuthSession` → `schema.prisma:L14884`
- `HolidayCalendar` → `schema.prisma:L7644`
- `HybridBillingOperation` → `schema.prisma:L5167`
- `HybridCampaign` → `schema.prisma:L5008`
- `HybridContract` → `schema.prisma:L5124`
- `HybridContractSelection` → `schema.prisma:L5156`
- `HybridCreditAllocation` → `schema.prisma:L5223`
- `HybridOfferPublication` → `schema.prisma:L5071`
- `HybridPaymentPeriod` → `schema.prisma:L5202`
- `HybridPromotionGroup` → `schema.prisma:L5052`
- `HybridPurchase` → `schema.prisma:L5091`
- `HybridRedemption` → `schema.prisma:L5185`
- `IdempotencyRequest` → `schema.prisma:L12928`
- `InterVenueTransfer` → `schema.prisma:L3137`
- `InterVenueTransferAllocation` → `schema.prisma:L3220`
- `InterVenueTransferItem` → `schema.prisma:L3189`
- `InterVenueTransferReceipt` → `schema.prisma:L3247`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3263`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3291`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3275`
- `Inventory` → `schema.prisma:L2059`
- `InventoryMovement` → `schema.prisma:L2159`
- `InventoryPosting` → `schema.prisma:L2254`
- `InventoryPostingLine` → `schema.prisma:L2294`
- `InventoryTransfer` → `schema.prisma:L15721`
- `InventoryWasteReport` → `schema.prisma:L2114`
- `Invitation` → `schema.prisma:L1551`
- `Invoice` → `schema.prisma:L5328`
- `InvoiceItem` → `schema.prisma:L5354`
- `ItemCategory` → `schema.prisma:L12641`
- `JournalEntry` → `schema.prisma:L17646`
- `JournalLine` → `schema.prisma:L17675`
- `KdsOrder` → `schema.prisma:L15987`
- `KdsOrderItem` → `schema.prisma:L16054`
- `KioskCheckInAttempt` → `schema.prisma:L18608`
- `KioskCheckInChallenge` → `schema.prisma:L18562`
- `KioskOutreachOutbox` → `schema.prisma:L18629`
- `LaunchCampaign` → `schema.prisma:L18967`
- `LaunchCampaignRedemption` → `schema.prisma:L19084`
- `LearnedPatterns` → `schema.prisma:L10557`
- `LedgerAccount` → `schema.prisma:L17538`
- `LiveDemoSession` → `schema.prisma:L869`
- `LowStockAlert` → `schema.prisma:L2967`
- `LoyaltyConfig` → `schema.prisma:L8230`
- `LoyaltyTransaction` → `schema.prisma:L8273`
- `MarketingCampaign` → `schema.prisma:L13832`
- `McpAuthCode` → `schema.prisma:L17079`
- `McpOAuthClient` → `schema.prisma:L17063`
- `McpRefreshToken` → `schema.prisma:L17097`
- `McpToolCall` → `schema.prisma:L17119`
- `MeasurementUnit` → `schema.prisma:L15827`
- `Menu` → `schema.prisma:L1769`
- `MenuCategory` → `schema.prisma:L1706`
- `MenuCategoryAssignment` → `schema.prisma:L1804`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16993`
- `MerchantAccount` → `schema.prisma:L6095`
- `MerchantFiscalConfig` → `schema.prisma:L17257`
- `MerchantRevenueShare` → `schema.prisma:L7224`
- `MerchantRoutingRule` → `schema.prisma:L6217`
- `MilestoneAchievement` → `schema.prisma:L13255`
- `Modifier` → `schema.prisma:L4398`
- `ModifierGroup` → `schema.prisma:L4362`
- `Module` → `schema.prisma:L11550`
- `MoneyAnomaly` → `schema.prisma:L7127`
- `MonthlyVenueProfit` → `schema.prisma:L7670`
- `Notification` → `schema.prisma:L9335`
- `NotificationPreference` → `schema.prisma:L9382`
- `NotificationTemplate` → `schema.prisma:L9409`
- `OAuthState` → `schema.prisma:L1602`
- `OnboardingProgress` → `schema.prisma:L1620`
- `Order` → `schema.prisma:L3923`
- `OrderAction` → `schema.prisma:L4469`
- `OrderCustomer` → `schema.prisma:L4176`
- `OrderDiscount` → `schema.prisma:L9191`
- `OrderFulfillment` → `schema.prisma:L16311`
- `OrderFulfillmentLine` → `schema.prisma:L16342`
- `OrderItem` → `schema.prisma:L4212`
- `OrderItemModifier` → `schema.prisma:L4451`
- `OrderItemSelloIva` → `schema.prisma:L17395`
- `OrderPromotion` → `schema.prisma:L18525`
- `OrderServiceCharge` → `schema.prisma:L9280`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13633`
- `OrganizationEntitlement` → `schema.prisma:L11833`
- `OrganizationGoal` → `schema.prisma:L13591`
- `OrganizationModule` → `schema.prisma:L11610`
- `OrganizationPaymentConfig` → `schema.prisma:L6669`
- `OrganizationPayoutConfig` → `schema.prisma:L13666`
- `OrganizationPricingStructure` → `schema.prisma:L6701`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13614`
- `OtpChallenge` → `schema.prisma:L8180`
- `OvertimeApproval` → `schema.prisma:L3638`
- `PartnerAPIKey` → `schema.prisma:L6499`
- `Payment` → `schema.prisma:L4502`
- `PaymentAllocation` → `schema.prisma:L4775`
- `PaymentEffect` → `schema.prisma:L18899`
- `PaymentLink` → `schema.prisma:L15498`
- `PaymentLinkAttribution` → `schema.prisma:L15606`
- `PaymentLinkItem` → `schema.prisma:L15561`
- `PaymentLinkItemModifier` → `schema.prisma:L15588`
- `PaymentProvider` → `schema.prisma:L6054`
- `PayrollLine` → `schema.prisma:L18021`
- `PayrollRun` → `schema.prisma:L17990`
- `PerformanceGoal` → `schema.prisma:L13568`
- `PermissionOverride` → `schema.prisma:L1475`
- `PermissionSet` → `schema.prisma:L1498`
- `PlatformAnnouncement` → `schema.prisma:L18689`
- `PlatformAnnouncementClick` → `schema.prisma:L18754`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18791`
- `PlatformCfdi` → `schema.prisma:L18318`
- `PlatformEmisor` → `schema.prisma:L18258`
- `PlatformSettings` → `schema.prisma:L6476`
- `PosCommand` → `schema.prisma:L9463`
- `PosConnectionStatus` → `schema.prisma:L1017`
- `PosSyncIntent` → `schema.prisma:L18396`
- `PricingPolicy` → `schema.prisma:L2863`
- `Printer` → `schema.prisma:L16112`
- `PrintGateway` → `schema.prisma:L16169`
- `PrintJob` → `schema.prisma:L16892`
- `PrintStation` → `schema.prisma:L16187`
- `PrivacyNoticeVersion` → `schema.prisma:L7928`
- `ProcessedStripeEvent` → `schema.prisma:L7113`
- `ProcessorReliabilityMetric` → `schema.prisma:L7598`
- `Product` → `schema.prisma:L1822`
- `ProductModifierGroup` → `schema.prisma:L4439`
- `ProductOption` → `schema.prisma:L15804`
- `ProductOptionValue` → `schema.prisma:L15815`
- `ProductStaff` → `schema.prisma:L14448`
- `PromoterBankAccount` → `schema.prisma:L18141`
- `PromoterCommissionEntry` → `schema.prisma:L18160`
- `PromoterLocationPing` → `schema.prisma:L3889`
- `Promotion` → `schema.prisma:L18447`
- `PromotionGroup` → `schema.prisma:L18486`
- `PromotionOption` → `schema.prisma:L18502`
- `ProviderCostStructure` → `schema.prisma:L7149`
- `ProviderEventLog` → `schema.prisma:L6778`
- `PurchaseOrder` → `schema.prisma:L2570`
- `PurchaseOrderInvoice` → `schema.prisma:L2715`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2782`
- `PurchaseOrderItem` → `schema.prisma:L2628`
- `RateCorrectionBatch` → `schema.prisma:L7374`
- `RateCorrectionEntry` → `schema.prisma:L7416`
- `RawMaterial` → `schema.prisma:L2326`
- `RawMaterialMovement` → `schema.prisma:L2916`
- `RawMaterialPresentation` → `schema.prisma:L2402`
- `ReceiptLayout` → `schema.prisma:L18933`
- `Recipe` → `schema.prisma:L2422`
- `RecipeLine` → `schema.prisma:L2446`
- `Referral` → `schema.prisma:L8646`
- `ReferralProgramConfig` → `schema.prisma:L8611`
- `ReferralRewardGrant` → `schema.prisma:L8737`
- `ReferralTierReward` → `schema.prisma:L8709`
- `ReferralTierUnlock` → `schema.prisma:L8782`
- `RefreshGrant` → `schema.prisma:L18878`
- `Reservation` → `schema.prisma:L14211`
- `ReservationGoogleEventMapping` → `schema.prisma:L15271`
- `ReservationModifier` → `schema.prisma:L14396`
- `ReservationReminderSent` → `schema.prisma:L14379`
- `ReservationSettings` → `schema.prisma:L14620`
- `ReservationWaitlistEntry` → `schema.prisma:L14588`
- `Review` → `schema.prisma:L5372`
- `SalesRetention` → `schema.prisma:L17841`
- `SaleVerification` → `schema.prisma:L4829`
- `ScaleProfile` → `schema.prisma:L16633`
- `ScheduledCommand` → `schema.prisma:L11034`
- `SerializedItem` → `schema.prisma:L12684`
- `SerializedItemCustodyEvent` → `schema.prisma:L12851`
- `ServiceCharge` → `schema.prisma:L9251`
- `ServiceEarning` → `schema.prisma:L19307`
- `ServicePayPeriod` → `schema.prisma:L19283`
- `ServicePayTable` → `schema.prisma:L19191`
- `ServicePayTableCell` → `schema.prisma:L19233`
- `ServicePayTableVersion` → `schema.prisma:L19208`
- `Session` → `schema.prisma:L18857`
- `SettlementConfiguration` → `schema.prisma:L7449`
- `SettlementConfirmation` → `schema.prisma:L7562`
- `SettlementIncident` → `schema.prisma:L7513`
- `SettlementSimulation` → `schema.prisma:L7484`
- `Shift` → `schema.prisma:L3449`
- `ShopifyConnectIntent` → `schema.prisma:L19628`
- `ShopifyImportIssue` → `schema.prisma:L19682`
- `ShopifyInboundEvent` → `schema.prisma:L19604`
- `ShopifyLocationLink` → `schema.prisma:L19478`
- `ShopifyReviewItem` → `schema.prisma:L19650`
- `ShopifyStockOutbox` → `schema.prisma:L19574`
- `ShopifyStore` → `schema.prisma:L19449`
- `ShopifyVariantLink` → `schema.prisma:L19526`
- `SimRegistrationRequest` → `schema.prisma:L12889`
- `SimRegistrationRequestItem` → `schema.prisma:L12911`
- `SlotHold` → `schema.prisma:L14479`
- `Staff` → `schema.prisma:L1037`
- `StaffAssignment` → `schema.prisma:L3736`
- `StaffDocument` → `schema.prisma:L3760`
- `StaffOnboardingState` → `schema.prisma:L16963`
- `StaffOrganization` → `schema.prisma:L1374`
- `StaffPasskey` → `schema.prisma:L1401`
- `StaffPayLevel` → `schema.prisma:L19155`
- `StaffPayLevelAssignment` → `schema.prisma:L19173`
- `StaffPayStatement` → `schema.prisma:L19339`
- `StaffPayTipWindow` → `schema.prisma:L19701`
- `StaffPayVenueWindow` → `schema.prisma:L19718`
- `StaffPosition` → `schema.prisma:L3715`
- `StaffSchedule` → `schema.prisma:L14419`
- `StaffScheduleException` → `schema.prisma:L14431`
- `StaffVenue` → `schema.prisma:L1298`
- `StaffWorkSchedule` → `schema.prisma:L3574`
- `StaffWorkScheduleException` → `schema.prisma:L3672`
- `StampCard` → `schema.prisma:L8494`
- `StampEvent` → `schema.prisma:L8533`
- `StampReward` → `schema.prisma:L8571`
- `StockAlertConfig` → `schema.prisma:L13550`
- `StockBatch` → `schema.prisma:L3086`
- `StockCount` → `schema.prisma:L2999`
- `StockCountItem` → `schema.prisma:L3027`
- `StripeWebhookEvent` → `schema.prisma:L7096`
- `Supplier` → `schema.prisma:L2481`
- `SupplierItemCode` → `schema.prisma:L2826`
- `SupplierPricing` → `schema.prisma:L2536`
- `Table` → `schema.prisma:L3340`
- `Terminal` → `schema.prisma:L5423`
- `TerminalAttemptResolution` → `schema.prisma:L5913`
- `TerminalHealth` → `schema.prisma:L5733`
- `TerminalLog` → `schema.prisma:L5707`
- `TerminalOrder` → `schema.prisma:L5957`
- `TerminalOrderItem` → `schema.prisma:L6032`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5885`
- `TerminalPaymentRequest` → `schema.prisma:L5804`
- `TimeEntry` → `schema.prisma:L3802`
- `TimeEntryBreak` → `schema.prisma:L3871`
- `TokenPurchase` → `schema.prisma:L10706`
- `TokenUsageRecord` → `schema.prisma:L10678`
- `TpvCommandHistory` → `schema.prisma:L10940`
- `TpvCommandQueue` → `schema.prisma:L10878`
- `TpvFeedback` → `schema.prisma:L10591`
- `TpvMessage` → `schema.prisma:L13907`
- `TpvMessageDelivery` → `schema.prisma:L13959`
- `TpvMessageResponse` → `schema.prisma:L13982`
- `TrainingModule` → `schema.prisma:L14037`
- `TrainingProgress` → `schema.prisma:L14114`
- `TrainingQuizQuestion` → `schema.prisma:L14096`
- `TrainingStep` → `schema.prisma:L14076`
- `TransactionCost` → `schema.prisma:L7312`
- `UnitConversion` → `schema.prisma:L2894`
- `UpsellAcceptance` → `schema.prisma:L9067`
- `UpsellAiRun` → `schema.prisma:L9087`
- `UpsellImpression` → `schema.prisma:L9027`
- `UpsellRule` → `schema.prisma:L8947`
- `user_sessions` → `schema.prisma:L6534`
- `Venue` → `schema.prisma:L185`
- `VenueAreaTicketSettings` → `schema.prisma:L16370`
- `VenueChatMessage` → `schema.prisma:L845`
- `VenueChatSession` → `schema.prisma:L800`
- `VenueCommission` → `schema.prisma:L15965`
- `VenueCreditAssessment` → `schema.prisma:L11422`
- `VenueCryptoConfig` → `schema.prisma:L13774`
- `VenueFeature` → `schema.prisma:L4943`
- `VenueIvaPorProducto` → `schema.prisma:L1000`
- `VenueModule` → `schema.prisma:L11582`
- `VenuePaymentConfig` → `schema.prisma:L6635`
- `VenuePaymentLinkSettings` → `schema.prisma:L15304`
- `VenuePosSinAparato` → `schema.prisma:L1011`
- `VenuePricingStructure` → `schema.prisma:L7252`
- `VenueRoleConfig` → `schema.prisma:L1527`
- `VenueRolePermission` → `schema.prisma:L1431`
- `VenueScaleSettings` → `schema.prisma:L16621`
- `VenueSettings` → `schema.prisma:L885`
- `VenueTenderType` → `schema.prisma:L4688`
- `VenueTenderTypeRevision` → `schema.prisma:L4753`
- `VenueTransaction` → `schema.prisma:L4880`
- `VenueWhatsappActivation` → `schema.prisma:L736`
- `WalletCardDesign` → `schema.prisma:L8412`
- `WalletPass` → `schema.prisma:L8313`
- `WalletPassRegistration` → `schema.prisma:L8379`
- `WebhookEvent` → `schema.prisma:L5281`
- `WebhookSubscription` → `schema.prisma:L6751`
- `WhatsappContactWindow` → `schema.prisma:L754`
- `WhatsappInboundEvent` → `schema.prisma:L774`
- `WorkShiftAssignment` → `schema.prisma:L3614`
- `WorkShiftTemplate` → `schema.prisma:L3591`
- `Zone` → `schema.prisma:L168`
