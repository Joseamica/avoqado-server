# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **376 models / 358 enums / ~18,100 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2   | **Modules, Features & Billing**         | What a venue pays for / is gated on, and how Avoqado invoices it.                                              | `BillingObligationConflict`, `ChatbotTokenBudget`, `Estimate`, `EstimateItem`, `Feature`, `Invoice`, `InvoiceItem`, `LaunchCampaign`, `LaunchCampaignRedemption`, `Module`, `OrganizationEntitlement`, `OrganizationModule`, `TokenPurchase`, `TokenUsageRecord`, `VenueFeature`, `VenueModule`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
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
| 13  | **Facturación (CFDI)**                  | Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles. | `AccountingPeriodLock`, `AccountMapping`, `BillingTaxProfile`, `Cfdi`, `CustomerTaxProfile`, `Employee`, `Expense`, `FiscalEmisor`, `FiscalLossCarryforward`, `FixedAsset`, `FixedAssetDepreciation`, `JournalEntry`, `JournalLine`, `LedgerAccount`, `MerchantFiscalConfig`, `PayrollLine`, `PayrollRun`, `PlatformCfdi`, `PlatformEmisor`, `SalesRetention`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 14  | **Pricing, Costs & Venue Lending**      | MCC pricing structures, monthly profit, and SOFOM-style venue credit assessment.                               | `CreditAssessmentHistory`, `CreditOffer`, `MonthlyVenueProfit`, `OrganizationPricingStructure`, `PricingPolicy`, `VenueCreditAssessment`, `VenuePricingStructure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 15  | **Discounts, Loyalty & Credit Packs**   | Discounts/coupons, loyalty points, and prepaid credit-pack bundles.                                            | `CouponCode`, `CouponRedemption`, `CreditItemBalance`, `CreditPack`, `CreditPackItem`, `CreditPackPurchase`, `CreditTransaction`, `CustomerDiscount`, `CustomerOrderMetric`, `Discount`, `LoyaltyConfig`, `LoyaltyTransaction`, `Promotion`, `PromotionGroup`, `PromotionOption`, `Referral`, `ReferralProgramConfig`, `ReferralRewardGrant`, `ReferralTierReward`, `ReferralTierUnlock`, `StampCard`, `StampEvent`, `StampReward`, `UpsellAcceptance`, `UpsellAiRun`, `UpsellImpression`, `UpsellRule`, `WalletCardDesign`, `WalletPass`, `WalletPassRegistration`                                                                                                                                                                                                                                                                                                |
| 16  | **Commissions & Sales Goals**           | Sales-rep commission tiers, payouts, clawbacks, org goals (CommandCenter).                                     | `CashOutCommissionRate`, `CashOutScheduleDay`, `CashOutWithdrawal`, `CommissionCalculation`, `CommissionClawback`, `CommissionConfig`, `CommissionMilestone`, `CommissionOverride`, `CommissionPayout`, `CommissionSummary`, `CommissionTier`, `MilestoneAchievement`, `OrganizationGoal`, `OrganizationSalesGoalConfig`, `PerformanceGoal`, `PromoterBankAccount`, `PromoterCommissionEntry`, `VenueCommission`                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 17  | **Reservations & Booking**              | Appointments/classes, waitlist, slot holds, Google Calendar sync.                                              | `CalendarSyncOutbox`, `ClassSession`, `ExternalBusyBlock`, `GoogleCalendarChannel`, `GoogleCalendarConnection`, `GoogleCalendarWebhookInbox`, `GoogleOAuthSession`, `HolidayCalendar`, `KioskCheckInAttempt`, `KioskCheckInChallenge`, `KioskOutreachOutbox`, `ProductStaff`, `Reservation`, `ReservationGoogleEventMapping`, `ReservationModifier`, `ReservationReminderSent`, `ReservationSettings`, `ReservationWaitlistEntry`, `SlotHold`, `StaffSchedule`, `StaffScheduleException`                                                                                                                                                                                                                                                                                                                                                                           |
| 18  | **Terminals / TPV Fleet**               | PAX terminal fleet: health, logs, app updates, remote commands, messaging.                                     | `AppUpdate`, `BulkCommandOperation`, `GeofenceRule`, `PosCommand`, `PosConnectionStatus`, `ScaleProfile`, `ScheduledCommand`, `Terminal`, `TerminalAttemptResolution`, `TerminalHealth`, `TerminalLog`, `TerminalOrder`, `TerminalOrderItem`, `TerminalPaymentAttemptLink`, `TerminalPaymentRequest`, `TpvCommandHistory`, `TpvCommandQueue`, `TpvFeedback`, `TpvMessage`, `TpvMessageDelivery`, `TpvMessageResponse`, `VenueCryptoConfig`, `VenueScaleSettings`                                                                                                                                                                                                                                                                                                                                                                                                   |
| 19  | **Notifications, WhatsApp & Marketing** | Outbound notifications, WhatsApp venue-chat relay, mass-email campaigns.                                       | `CampaignDelivery`, `EmailTemplate`, `MarketingCampaign`, `Notification`, `NotificationPreference`, `NotificationTemplate`, `PlatformAnnouncement`, `PlatformAnnouncementClick`, `PlatformAnnouncementDelivery`, `VenueChatMessage`, `VenueChatSession`, `VenueWhatsappActivation`, `WhatsappContactWindow`, `WhatsappInboundEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 20  | **AI Chatbot (Text-to-SQL)**            | The in-dashboard AI assistant: conversations, training data, learned patterns.                                 | `ChatConversation`, `ChatFeedback`, `ChatLearningEvent`, `ChatMessage`, `ChatTrainingData`, `LearnedPatterns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 21  | **Customers, Consumers & Reviews**      | End-customer identity (venue customers + cross-venue Consumers) and reviews.                                   | `BirthdayAutomation`, `ConsentEvent`, `Consumer`, `ConsumerAuthAccount`, `Customer`, `CustomerApprovalDelivery`, `CustomerApprovalOutbox`, `CustomerCampaign`, `CustomerCampaignDelivery`, `CustomerCaptureToken`, `CustomerGroup`, `EmailQuotaLedger`, `EmailSuppression`, `OtpChallenge`, `PrivacyNoticeVersion`, `Review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 22  | **System: Audit, Webhooks & Platform**  | Cross-cutting plumbing: audit log, webhook subscriptions, partner API keys, global settings.                   | `ActivityLog`, `PartnerAPIKey`, `PlatformSettings`, `WebhookEvent`, `WebhookSubscription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

> Line numbers are section starts and drift as the schema grows — treat them as "jump near here", then search for the exact `model Name {`.
> When the map goes stale, regenerate it: `npm run schema:map` (CI runs it automatically on `prisma/schema.prisma` changes).

## Model index

<!-- AUTO-GENERATED by scripts/generate-schema-map.ts — do not edit by hand. -->

Every model A–Z with its location in `prisma/schema.prisma`.

- `AccountingPeriodLock` → `schema.prisma:L16739`
- `AccountMapping` → `schema.prisma:L16635`
- `ActivityLog` → `schema.prisma:L7187`
- `Aggregator` → `schema.prisma:L14977`
- `AngelPayUserAccount` → `schema.prisma:L5732`
- `AppUpdate` → `schema.prisma:L13142`
- `Area` → `schema.prisma:L3202`
- `AreaTicket` → `schema.prisma:L15513`
- `AreaTicketCheckoutSession` → `schema.prisma:L15635`
- `AreaTicketExternalIncident` → `schema.prisma:L15882`
- `AreaTicketExternalSettlement` → `schema.prisma:L15847`
- `AreaTicketFulfillment` → `schema.prisma:L15711`
- `AreaTicketInventoryReservation` → `schema.prisma:L15606`
- `AreaTicketLine` → `schema.prisma:L15574`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15667`
- `AreaTicketPrintAttempt` → `schema.prisma:L15690`
- `BankStatement` → `schema.prisma:L16509`
- `BankStatementLine` → `schema.prisma:L16530`
- `BillingObligationConflict` → `schema.prisma:L4769`
- `BillingTaxProfile` → `schema.prisma:L17319`
- `BirthdayAutomation` → `schema.prisma:L7508`
- `BulkCommandOperation` → `schema.prisma:L10422`
- `CalendarSyncOutbox` → `schema.prisma:L14349`
- `CampaignDelivery` → `schema.prisma:L13300`
- `CashCloseout` → `schema.prisma:L10807`
- `CashDeposit` → `schema.prisma:L12944`
- `CashDrawerEvent` → `schema.prisma:L14814`
- `CashDrawerSession` → `schema.prisma:L14775`
- `CashOutCommissionRate` → `schema.prisma:L17148`
- `CashOutScheduleDay` → `schema.prisma:L17171`
- `CashOutWithdrawal` → `schema.prisma:L17233`
- `CatalogBindingBatch` → `schema.prisma:L11838`
- `CatalogBindingLine` → `schema.prisma:L11874`
- `CatalogBrand` → `schema.prisma:L11291`
- `CatalogClientObservation` → `schema.prisma:L11604`
- `CatalogClientReadinessOverride` → `schema.prisma:L11623`
- `CatalogFamily` → `schema.prisma:L11341`
- `CatalogIdempotencyRecord` → `schema.prisma:L11737`
- `CatalogIdentifier` → `schema.prisma:L11472`
- `CatalogImportBatch` → `schema.prisma:L11780`
- `CatalogImportLine` → `schema.prisma:L11817`
- `CatalogItem` → `schema.prisma:L11374`
- `CatalogItemBusinessType` → `schema.prisma:L11434`
- `CatalogItemPrice` → `schema.prisma:L11522`
- `CatalogManufacturer` → `schema.prisma:L11315`
- `CatalogProductTypeMapping` → `schema.prisma:L11451`
- `CatalogPublicationBatch` → `schema.prisma:L11902`
- `CatalogPublicationFieldDecision` → `schema.prisma:L11996`
- `CatalogPublicationLine` → `schema.prisma:L11943`
- `CatalogPublicationOutbox` → `schema.prisma:L12039`
- `CatalogValidationProfile` → `schema.prisma:L11493`
- `CatalogVenueBinding` → `schema.prisma:L11651`
- `CatalogVenueClientRequirement` → `schema.prisma:L11578`
- `CatalogVenueEventSequence` → `schema.prisma:L12022`
- `CatalogVenueOverride` → `schema.prisma:L11693`
- `CatalogVenueRollout` → `schema.prisma:L11553`
- `Cfdi` → `schema.prisma:L16402`
- `ChatbotTokenBudget` → `schema.prisma:L10070`
- `ChatConversation` → `schema.prisma:L9925`
- `ChatFeedback` → `schema.prisma:L10011`
- `ChatLearningEvent` → `schema.prisma:L9968`
- `ChatMessage` → `schema.prisma:L9948`
- `ChatTrainingData` → `schema.prisma:L9882`
- `CheckoutSession` → `schema.prisma:L6012`
- `ClassSession` → `schema.prisma:L13953`
- `CommissionCalculation` → `schema.prisma:L12720`
- `CommissionClawback` → `schema.prisma:L12896`
- `CommissionConfig` → `schema.prisma:L12486`
- `CommissionMilestone` → `schema.prisma:L12636`
- `CommissionOverride` → `schema.prisma:L12563`
- `CommissionPayout` → `schema.prisma:L12847`
- `CommissionSummary` → `schema.prisma:L12786`
- `CommissionTier` → `schema.prisma:L12600`
- `ConsentEvent` → `schema.prisma:L7370`
- `Consumer` → `schema.prisma:L7600`
- `ConsumerAuthAccount` → `schema.prisma:L7625`
- `CouponCode` → `schema.prisma:L8572`
- `CouponRedemption` → `schema.prisma:L8603`
- `CreditAssessmentHistory` → `schema.prisma:L10916`
- `CreditItemBalance` → `schema.prisma:L14565`
- `CreditOffer` → `schema.prisma:L10935`
- `CreditPack` → `schema.prisma:L14474`
- `CreditPackItem` → `schema.prisma:L14503`
- `CreditPackPurchase` → `schema.prisma:L14520`
- `CreditTransaction` → `schema.prisma:L14587`
- `Customer` → `schema.prisma:L7228`
- `CustomerApprovalDelivery` → `schema.prisma:L9584`
- `CustomerApprovalOutbox` → `schema.prisma:L9559`
- `CustomerCampaign` → `schema.prisma:L7458`
- `CustomerCampaignDelivery` → `schema.prisma:L7540`
- `CustomerCaptureToken` → `schema.prisma:L7406`
- `CustomerDiscount` → `schema.prisma:L8623`
- `CustomerGroup` → `schema.prisma:L7664`
- `CustomerOrderMetric` → `schema.prisma:L3995`
- `CustomerTaxProfile` → `schema.prisma:L16481`
- `DeliveryActivationRequest` → `schema.prisma:L6471`
- `DeliveryChannelLink` → `schema.prisma:L6310`
- `DeliveryConnectIntent` → `schema.prisma:L6422`
- `DeliveryLineAction` → `schema.prisma:L6383`
- `DeliveryOrderEvent` → `schema.prisma:L6495`
- `DeliveryStoreRevocation` → `schema.prisma:L6459`
- `DeviceToken` → `schema.prisma:L8892`
- `DigitalReceipt` → `schema.prisma:L4578`
- `Discount` → `schema.prisma:L8262`
- `EcommerceMerchant` → `schema.prisma:L5824`
- `EmailQuotaLedger` → `schema.prisma:L7587`
- `EmailSuppression` → `schema.prisma:L7575`
- `EmailTemplate` → `schema.prisma:L13239`
- `Employee` → `schema.prisma:L16996`
- `Estimate` → `schema.prisma:L14884`
- `EstimateItem` → `schema.prisma:L14912`
- `Expense` → `schema.prisma:L16783`
- `ExternalBusyBlock` → `schema.prisma:L14242`
- `Feature` → `schema.prisma:L4707`
- `FeeSchedule` → `schema.prisma:L4831`
- `FeeTier` → `schema.prisma:L4842`
- `FinancialAccount` → `schema.prisma:L15074`
- `FinancialConnection` → `schema.prisma:L15043`
- `FinancialProvider` → `schema.prisma:L15029`
- `FiscalEmisor` → `schema.prisma:L16318`
- `FiscalLossCarryforward` → `schema.prisma:L16906`
- `FixedAsset` → `schema.prisma:L16924`
- `FixedAssetDepreciation` → `schema.prisma:L16953`
- `FloorElement` → `schema.prisma:L3278`
- `FulfillmentArea` → `schema.prisma:L15378`
- `GeofenceRule` → `schema.prisma:L10507`
- `GoogleCalendarChannel` → `schema.prisma:L14219`
- `GoogleCalendarConnection` → `schema.prisma:L14171`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14272`
- `GoogleOAuthSession` → `schema.prisma:L14294`
- `HolidayCalendar` → `schema.prisma:L7111`
- `IdempotencyRequest` → `schema.prisma:L12361`
- `InterVenueTransfer` → `schema.prisma:L3030`
- `InterVenueTransferAllocation` → `schema.prisma:L3113`
- `InterVenueTransferItem` → `schema.prisma:L3082`
- `InterVenueTransferReceipt` → `schema.prisma:L3140`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3156`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3184`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3168`
- `Inventory` → `schema.prisma:L1974`
- `InventoryMovement` → `schema.prisma:L2074`
- `InventoryPosting` → `schema.prisma:L2169`
- `InventoryPostingLine` → `schema.prisma:L2209`
- `InventoryTransfer` → `schema.prisma:L14856`
- `InventoryWasteReport` → `schema.prisma:L2029`
- `Invitation` → `schema.prisma:L1479`
- `Invoice` → `schema.prisma:L4854`
- `InvoiceItem` → `schema.prisma:L4880`
- `ItemCategory` → `schema.prisma:L12074`
- `JournalEntry` → `schema.prisma:L16693`
- `JournalLine` → `schema.prisma:L16721`
- `KdsOrder` → `schema.prisma:L15122`
- `KdsOrderItem` → `schema.prisma:L15185`
- `KioskCheckInAttempt` → `schema.prisma:L17642`
- `KioskCheckInChallenge` → `schema.prisma:L17596`
- `KioskOutreachOutbox` → `schema.prisma:L17663`
- `LaunchCampaign` → `schema.prisma:L18001`
- `LaunchCampaignRedemption` → `schema.prisma:L18118`
- `LearnedPatterns` → `schema.prisma:L9992`
- `LedgerAccount` → `schema.prisma:L16585`
- `LiveDemoSession` → `schema.prisma:L823`
- `LowStockAlert` → `schema.prisma:L2864`
- `LoyaltyConfig` → `schema.prisma:L7694`
- `LoyaltyTransaction` → `schema.prisma:L7737`
- `MarketingCampaign` → `schema.prisma:L13257`
- `McpAuthCode` → `schema.prisma:L16201`
- `McpOAuthClient` → `schema.prisma:L16185`
- `McpRefreshToken` → `schema.prisma:L16219`
- `McpToolCall` → `schema.prisma:L16240`
- `MeasurementUnit` → `schema.prisma:L14962`
- `Menu` → `schema.prisma:L1697`
- `MenuCategory` → `schema.prisma:L1634`
- `MenuCategoryAssignment` → `schema.prisma:L1732`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16115`
- `MerchantAccount` → `schema.prisma:L5562`
- `MerchantFiscalConfig` → `schema.prisma:L16373`
- `MerchantRevenueShare` → `schema.prisma:L6691`
- `MerchantRoutingRule` → `schema.prisma:L5684`
- `MilestoneAchievement` → `schema.prisma:L12681`
- `Modifier` → `schema.prisma:L4184`
- `ModifierGroup` → `schema.prisma:L4148`
- `Module` → `schema.prisma:L10983`
- `MoneyAnomaly` → `schema.prisma:L6594`
- `MonthlyVenueProfit` → `schema.prisma:L7137`
- `Notification` → `schema.prisma:L8794`
- `NotificationPreference` → `schema.prisma:L8841`
- `NotificationTemplate` → `schema.prisma:L8868`
- `OAuthState` → `schema.prisma:L1530`
- `OnboardingProgress` → `schema.prisma:L1548`
- `Order` → `schema.prisma:L3727`
- `OrderAction` → `schema.prisma:L4251`
- `OrderCustomer` → `schema.prisma:L3974`
- `OrderDiscount` → `schema.prisma:L8655`
- `OrderFulfillment` → `schema.prisma:L15433`
- `OrderFulfillmentLine` → `schema.prisma:L15464`
- `OrderItem` → `schema.prisma:L4010`
- `OrderItemModifier` → `schema.prisma:L4233`
- `OrderPromotion` → `schema.prisma:L17559`
- `OrderServiceCharge` → `schema.prisma:L8739`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13058`
- `OrganizationEntitlement` → `schema.prisma:L11266`
- `OrganizationGoal` → `schema.prisma:L13016`
- `OrganizationModule` → `schema.prisma:L11043`
- `OrganizationPaymentConfig` → `schema.prisma:L6136`
- `OrganizationPayoutConfig` → `schema.prisma:L13091`
- `OrganizationPricingStructure` → `schema.prisma:L6168`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13039`
- `OtpChallenge` → `schema.prisma:L7644`
- `OvertimeApproval` → `schema.prisma:L3505`
- `PartnerAPIKey` → `schema.prisma:L5966`
- `Payment` → `schema.prisma:L4284`
- `PaymentAllocation` → `schema.prisma:L4557`
- `PaymentEffect` → `schema.prisma:L17933`
- `PaymentLink` → `schema.prisma:L14633`
- `PaymentLinkAttribution` → `schema.prisma:L14741`
- `PaymentLinkItem` → `schema.prisma:L14696`
- `PaymentLinkItemModifier` → `schema.prisma:L14723`
- `PaymentProvider` → `schema.prisma:L5521`
- `PayrollLine` → `schema.prisma:L17067`
- `PayrollRun` → `schema.prisma:L17036`
- `PerformanceGoal` → `schema.prisma:L12993`
- `PermissionOverride` → `schema.prisma:L1403`
- `PermissionSet` → `schema.prisma:L1426`
- `PlatformAnnouncement` → `schema.prisma:L17723`
- `PlatformAnnouncementClick` → `schema.prisma:L17788`
- `PlatformAnnouncementDelivery` → `schema.prisma:L17825`
- `PlatformCfdi` → `schema.prisma:L17352`
- `PlatformEmisor` → `schema.prisma:L17292`
- `PlatformSettings` → `schema.prisma:L5943`
- `PosCommand` → `schema.prisma:L8922`
- `PosConnectionStatus` → `schema.prisma:L949`
- `PosSyncIntent` → `schema.prisma:L17430`
- `PricingPolicy` → `schema.prisma:L2760`
- `Printer` → `schema.prisma:L15234`
- `PrintGateway` → `schema.prisma:L15291`
- `PrintJob` → `schema.prisma:L16014`
- `PrintStation` → `schema.prisma:L15309`
- `PrivacyNoticeVersion` → `schema.prisma:L7392`
- `ProcessedStripeEvent` → `schema.prisma:L6580`
- `ProcessorReliabilityMetric` → `schema.prisma:L7065`
- `Product` → `schema.prisma:L1750`
- `ProductModifierGroup` → `schema.prisma:L4221`
- `ProductOption` → `schema.prisma:L14939`
- `ProductOptionValue` → `schema.prisma:L14950`
- `ProductStaff` → `schema.prisma:L13868`
- `PromoterBankAccount` → `schema.prisma:L17187`
- `PromoterCommissionEntry` → `schema.prisma:L17206`
- `PromoterLocationPing` → `schema.prisma:L3693`
- `Promotion` → `schema.prisma:L17481`
- `PromotionGroup` → `schema.prisma:L17520`
- `PromotionOption` → `schema.prisma:L17536`
- `ProviderCostStructure` → `schema.prisma:L6616`
- `ProviderEventLog` → `schema.prisma:L6245`
- `PurchaseOrder` → `schema.prisma:L2485`
- `PurchaseOrderInvoice` → `schema.prisma:L2630`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2687`
- `PurchaseOrderItem` → `schema.prisma:L2543`
- `RateCorrectionBatch` → `schema.prisma:L6841`
- `RateCorrectionEntry` → `schema.prisma:L6883`
- `RawMaterial` → `schema.prisma:L2241`
- `RawMaterialMovement` → `schema.prisma:L2813`
- `RawMaterialPresentation` → `schema.prisma:L2317`
- `ReceiptLayout` → `schema.prisma:L17967`
- `Recipe` → `schema.prisma:L2337`
- `RecipeLine` → `schema.prisma:L2361`
- `Referral` → `schema.prisma:L8110`
- `ReferralProgramConfig` → `schema.prisma:L8075`
- `ReferralRewardGrant` → `schema.prisma:L8201`
- `ReferralTierReward` → `schema.prisma:L8173`
- `ReferralTierUnlock` → `schema.prisma:L8246`
- `RefreshGrant` → `schema.prisma:L17912`
- `Reservation` → `schema.prisma:L13636`
- `ReservationGoogleEventMapping` → `schema.prisma:L14406`
- `ReservationModifier` → `schema.prisma:L13816`
- `ReservationReminderSent` → `schema.prisma:L13799`
- `ReservationSettings` → `schema.prisma:L14030`
- `ReservationWaitlistEntry` → `schema.prisma:L13998`
- `Review` → `schema.prisma:L4898`
- `SalesRetention` → `schema.prisma:L16887`
- `SaleVerification` → `schema.prisma:L4611`
- `ScaleProfile` → `schema.prisma:L15755`
- `ScheduledCommand` → `schema.prisma:L10467`
- `SerializedItem` → `schema.prisma:L12117`
- `SerializedItemCustodyEvent` → `schema.prisma:L12284`
- `ServiceCharge` → `schema.prisma:L8710`
- `Session` → `schema.prisma:L17891`
- `SettlementConfiguration` → `schema.prisma:L6916`
- `SettlementConfirmation` → `schema.prisma:L7029`
- `SettlementIncident` → `schema.prisma:L6980`
- `SettlementSimulation` → `schema.prisma:L6951`
- `Shift` → `schema.prisma:L3316`
- `SimRegistrationRequest` → `schema.prisma:L12322`
- `SimRegistrationRequestItem` → `schema.prisma:L12344`
- `SlotHold` → `schema.prisma:L13899`
- `Staff` → `schema.prisma:L969`
- `StaffDocument` → `schema.prisma:L3564`
- `StaffOnboardingState` → `schema.prisma:L16085`
- `StaffOrganization` → `schema.prisma:L1302`
- `StaffPasskey` → `schema.prisma:L1329`
- `StaffSchedule` → `schema.prisma:L13839`
- `StaffScheduleException` → `schema.prisma:L13851`
- `StaffVenue` → `schema.prisma:L1226`
- `StaffWorkSchedule` → `schema.prisma:L3441`
- `StaffWorkScheduleException` → `schema.prisma:L3539`
- `StampCard` → `schema.prisma:L7958`
- `StampEvent` → `schema.prisma:L7997`
- `StampReward` → `schema.prisma:L8035`
- `StockAlertConfig` → `schema.prisma:L12975`
- `StockBatch` → `schema.prisma:L2979`
- `StockCount` → `schema.prisma:L2896`
- `StockCountItem` → `schema.prisma:L2924`
- `StripeWebhookEvent` → `schema.prisma:L6563`
- `Supplier` → `schema.prisma:L2396`
- `SupplierItemCode` → `schema.prisma:L2728`
- `SupplierPricing` → `schema.prisma:L2451`
- `Table` → `schema.prisma:L3228`
- `Terminal` → `schema.prisma:L4949`
- `TerminalAttemptResolution` → `schema.prisma:L5380`
- `TerminalHealth` → `schema.prisma:L5200`
- `TerminalLog` → `schema.prisma:L5174`
- `TerminalOrder` → `schema.prisma:L5424`
- `TerminalOrderItem` → `schema.prisma:L5499`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5352`
- `TerminalPaymentRequest` → `schema.prisma:L5271`
- `TimeEntry` → `schema.prisma:L3606`
- `TimeEntryBreak` → `schema.prisma:L3675`
- `TokenPurchase` → `schema.prisma:L10141`
- `TokenUsageRecord` → `schema.prisma:L10113`
- `TpvCommandHistory` → `schema.prisma:L10373`
- `TpvCommandQueue` → `schema.prisma:L10313`
- `TpvFeedback` → `schema.prisma:L10026`
- `TpvMessage` → `schema.prisma:L13332`
- `TpvMessageDelivery` → `schema.prisma:L13384`
- `TpvMessageResponse` → `schema.prisma:L13407`
- `TrainingModule` → `schema.prisma:L13462`
- `TrainingProgress` → `schema.prisma:L13539`
- `TrainingQuizQuestion` → `schema.prisma:L13521`
- `TrainingStep` → `schema.prisma:L13501`
- `TransactionCost` → `schema.prisma:L6779`
- `UnitConversion` → `schema.prisma:L2791`
- `UpsellAcceptance` → `schema.prisma:L8531`
- `UpsellAiRun` → `schema.prisma:L8551`
- `UpsellImpression` → `schema.prisma:L8491`
- `UpsellRule` → `schema.prisma:L8411`
- `user_sessions` → `schema.prisma:L6001`
- `Venue` → `schema.prisma:L163`
- `VenueAreaTicketSettings` → `schema.prisma:L15492`
- `VenueChatMessage` → `schema.prisma:L799`
- `VenueChatSession` → `schema.prisma:L754`
- `VenueCommission` → `schema.prisma:L15100`
- `VenueCreditAssessment` → `schema.prisma:L10855`
- `VenueCryptoConfig` → `schema.prisma:L13199`
- `VenueFeature` → `schema.prisma:L4725`
- `VenueModule` → `schema.prisma:L11015`
- `VenuePaymentConfig` → `schema.prisma:L6102`
- `VenuePaymentLinkSettings` → `schema.prisma:L14439`
- `VenuePricingStructure` → `schema.prisma:L6719`
- `VenueRoleConfig` → `schema.prisma:L1455`
- `VenueRolePermission` → `schema.prisma:L1359`
- `VenueScaleSettings` → `schema.prisma:L15743`
- `VenueSettings` → `schema.prisma:L839`
- `VenueTenderType` → `schema.prisma:L4470`
- `VenueTenderTypeRevision` → `schema.prisma:L4535`
- `VenueTransaction` → `schema.prisma:L4662`
- `VenueWhatsappActivation` → `schema.prisma:L690`
- `WalletCardDesign` → `schema.prisma:L7876`
- `WalletPass` → `schema.prisma:L7777`
- `WalletPassRegistration` → `schema.prisma:L7843`
- `WebhookEvent` → `schema.prisma:L4807`
- `WebhookSubscription` → `schema.prisma:L6218`
- `WhatsappContactWindow` → `schema.prisma:L708`
- `WhatsappInboundEvent` → `schema.prisma:L728`
- `WorkShiftAssignment` → `schema.prisma:L3481`
- `WorkShiftTemplate` → `schema.prisma:L3458`
- `Zone` → `schema.prisma:L146`
