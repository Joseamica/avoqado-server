# Schema Domain Map — avoqado-server

`prisma/schema.prisma` is **389 models / 360 enums / ~18,500 lines**. Nobody reads it top to bottom. This file is the **index**: 22 domains,
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
| 1   | **Multi-Tenant Core**                   | The org/venue tree + physical floor layout. The root every other table hangs off.                              | `Area`, `FloorElement`, `Organization`, `OrganizationAttendanceConfig`, `Table`, `Venue`, `VenueIvaPorProducto`, `VenueSettings`, `Zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
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

- `AccountingPeriodLock` → `schema.prisma:L17087`
- `AccountMapping` → `schema.prisma:L16982`
- `ActivityLog` → `schema.prisma:L7461`
- `Aggregator` → `schema.prisma:L15259`
- `AngelPayUserAccount` → `schema.prisma:L6006`
- `AppUpdate` → `schema.prisma:L13424`
- `Area` → `schema.prisma:L3229`
- `AreaTicket` → `schema.prisma:L15795`
- `AreaTicketCheckoutSession` → `schema.prisma:L15917`
- `AreaTicketExternalIncident` → `schema.prisma:L16164`
- `AreaTicketExternalSettlement` → `schema.prisma:L16129`
- `AreaTicketFulfillment` → `schema.prisma:L15993`
- `AreaTicketInventoryReservation` → `schema.prisma:L15888`
- `AreaTicketLine` → `schema.prisma:L15856`
- `AreaTicketPaymentAttempt` → `schema.prisma:L15949`
- `AreaTicketPrintAttempt` → `schema.prisma:L15972`
- `BankStatement` → `schema.prisma:L16856`
- `BankStatementLine` → `schema.prisma:L16877`
- `BillingObligationConflict` → `schema.prisma:L5036`
- `BillingTaxProfile` → `schema.prisma:L17679`
- `BirthdayAutomation` → `schema.prisma:L7782`
- `BulkCommandOperation` → `schema.prisma:L10704`
- `CalendarSyncOutbox` → `schema.prisma:L14631`
- `CampaignDelivery` → `schema.prisma:L13582`
- `CapabilityGrant` → `schema.prisma:L4812`
- `CashCloseout` → `schema.prisma:L11089`
- `CashDeposit` → `schema.prisma:L13226`
- `CashDrawerEvent` → `schema.prisma:L15096`
- `CashDrawerSession` → `schema.prisma:L15057`
- `CashOutCommissionRate` → `schema.prisma:L17496`
- `CashOutScheduleDay` → `schema.prisma:L17519`
- `CashOutWithdrawal` → `schema.prisma:L17581`
- `CatalogBindingBatch` → `schema.prisma:L12120`
- `CatalogBindingLine` → `schema.prisma:L12156`
- `CatalogBrand` → `schema.prisma:L11573`
- `CatalogClientObservation` → `schema.prisma:L11886`
- `CatalogClientReadinessOverride` → `schema.prisma:L11905`
- `CatalogFamily` → `schema.prisma:L11623`
- `CatalogIdempotencyRecord` → `schema.prisma:L12019`
- `CatalogIdentifier` → `schema.prisma:L11754`
- `CatalogImportBatch` → `schema.prisma:L12062`
- `CatalogImportLine` → `schema.prisma:L12099`
- `CatalogItem` → `schema.prisma:L11656`
- `CatalogItemBusinessType` → `schema.prisma:L11716`
- `CatalogItemPrice` → `schema.prisma:L11804`
- `CatalogManufacturer` → `schema.prisma:L11597`
- `CatalogProductTypeMapping` → `schema.prisma:L11733`
- `CatalogPublicationBatch` → `schema.prisma:L12184`
- `CatalogPublicationFieldDecision` → `schema.prisma:L12278`
- `CatalogPublicationLine` → `schema.prisma:L12225`
- `CatalogPublicationOutbox` → `schema.prisma:L12321`
- `CatalogValidationProfile` → `schema.prisma:L11775`
- `CatalogVenueBinding` → `schema.prisma:L11933`
- `CatalogVenueClientRequirement` → `schema.prisma:L11860`
- `CatalogVenueEventSequence` → `schema.prisma:L12304`
- `CatalogVenueOverride` → `schema.prisma:L11975`
- `CatalogVenueRollout` → `schema.prisma:L11835`
- `Cfdi` → `schema.prisma:L16684`
- `CfdiGlobalOrden` → `schema.prisma:L16809`
- `ChatbotTokenBudget` → `schema.prisma:L10350`
- `ChatConversation` → `schema.prisma:L10205`
- `ChatFeedback` → `schema.prisma:L10291`
- `ChatLearningEvent` → `schema.prisma:L10248`
- `ChatMessage` → `schema.prisma:L10228`
- `ChatTrainingData` → `schema.prisma:L10162`
- `CheckoutSession` → `schema.prisma:L6286`
- `ClassSession` → `schema.prisma:L14235`
- `CommissionCalculation` → `schema.prisma:L13002`
- `CommissionClawback` → `schema.prisma:L13178`
- `CommissionConfig` → `schema.prisma:L12768`
- `CommissionMilestone` → `schema.prisma:L12918`
- `CommissionOverride` → `schema.prisma:L12845`
- `CommissionPayout` → `schema.prisma:L13129`
- `CommissionSummary` → `schema.prisma:L13068`
- `CommissionTier` → `schema.prisma:L12882`
- `ConsentEvent` → `schema.prisma:L7644`
- `Consumer` → `schema.prisma:L7874`
- `ConsumerAuthAccount` → `schema.prisma:L7899`
- `CouponCode` → `schema.prisma:L8846`
- `CouponRedemption` → `schema.prisma:L8877`
- `CreditAssessmentHistory` → `schema.prisma:L11198`
- `CreditItemBalance` → `schema.prisma:L14847`
- `CreditOffer` → `schema.prisma:L11217`
- `CreditPack` → `schema.prisma:L14756`
- `CreditPackItem` → `schema.prisma:L14785`
- `CreditPackPurchase` → `schema.prisma:L14802`
- `CreditTransaction` → `schema.prisma:L14869`
- `Customer` → `schema.prisma:L7502`
- `CustomerApprovalDelivery` → `schema.prisma:L9864`
- `CustomerApprovalOutbox` → `schema.prisma:L9839`
- `CustomerCampaign` → `schema.prisma:L7732`
- `CustomerCampaignDelivery` → `schema.prisma:L7814`
- `CustomerCaptureToken` → `schema.prisma:L7680`
- `CustomerDiscount` → `schema.prisma:L8897`
- `CustomerGroup` → `schema.prisma:L7938`
- `CustomerOrderMetric` → `schema.prisma:L4028`
- `CustomerTaxProfile` → `schema.prisma:L16828`
- `DeliveryActivationRequest` → `schema.prisma:L6745`
- `DeliveryChannelLink` → `schema.prisma:L6584`
- `DeliveryConnectIntent` → `schema.prisma:L6696`
- `DeliveryLineAction` → `schema.prisma:L6657`
- `DeliveryOrderEvent` → `schema.prisma:L6769`
- `DeliveryStoreRevocation` → `schema.prisma:L6733`
- `DeviceToken` → `schema.prisma:L9166`
- `DigitalReceipt` → `schema.prisma:L4625`
- `Discount` → `schema.prisma:L8536`
- `EcommerceMerchant` → `schema.prisma:L6098`
- `EmailQuotaLedger` → `schema.prisma:L7861`
- `EmailSuppression` → `schema.prisma:L7849`
- `EmailTemplate` → `schema.prisma:L13521`
- `Employee` → `schema.prisma:L17344`
- `Estimate` → `schema.prisma:L15166`
- `EstimateItem` → `schema.prisma:L15194`
- `Expense` → `schema.prisma:L17131`
- `ExternalBusyBlock` → `schema.prisma:L14524`
- `Feature` → `schema.prisma:L4754`
- `FeeSchedule` → `schema.prisma:L5098`
- `FeeTier` → `schema.prisma:L5109`
- `FinancialAccount` → `schema.prisma:L15356`
- `FinancialConnection` → `schema.prisma:L15325`
- `FinancialProvider` → `schema.prisma:L15311`
- `FiscalEmisor` → `schema.prisma:L16600`
- `FiscalLossCarryforward` → `schema.prisma:L17254`
- `FixedAsset` → `schema.prisma:L17272`
- `FixedAssetDepreciation` → `schema.prisma:L17301`
- `FloorElement` → `schema.prisma:L3305`
- `FulfillmentArea` → `schema.prisma:L15660`
- `GeofenceRule` → `schema.prisma:L10789`
- `GoogleCalendarChannel` → `schema.prisma:L14501`
- `GoogleCalendarConnection` → `schema.prisma:L14453`
- `GoogleCalendarWebhookInbox` → `schema.prisma:L14554`
- `GoogleOAuthSession` → `schema.prisma:L14576`
- `HolidayCalendar` → `schema.prisma:L7385`
- `HybridBillingOperation` → `schema.prisma:L4960`
- `HybridCampaign` → `schema.prisma:L4837`
- `HybridContract` → `schema.prisma:L4917`
- `HybridContractSelection` → `schema.prisma:L4949`
- `HybridCreditAllocation` → `schema.prisma:L5016`
- `HybridOfferPublication` → `schema.prisma:L4864`
- `HybridPaymentPeriod` → `schema.prisma:L4995`
- `HybridPurchase` → `schema.prisma:L4884`
- `HybridRedemption` → `schema.prisma:L4978`
- `IdempotencyRequest` → `schema.prisma:L12643`
- `InterVenueTransfer` → `schema.prisma:L3057`
- `InterVenueTransferAllocation` → `schema.prisma:L3140`
- `InterVenueTransferItem` → `schema.prisma:L3109`
- `InterVenueTransferReceipt` → `schema.prisma:L3167`
- `InterVenueTransferReceiptLine` → `schema.prisma:L3183`
- `InterVenueTransferVarianceLine` → `schema.prisma:L3211`
- `InterVenueTransferVarianceResolution` → `schema.prisma:L3195`
- `Inventory` → `schema.prisma:L2001`
- `InventoryMovement` → `schema.prisma:L2101`
- `InventoryPosting` → `schema.prisma:L2196`
- `InventoryPostingLine` → `schema.prisma:L2236`
- `InventoryTransfer` → `schema.prisma:L15138`
- `InventoryWasteReport` → `schema.prisma:L2056`
- `Invitation` → `schema.prisma:L1498`
- `Invoice` → `schema.prisma:L5121`
- `InvoiceItem` → `schema.prisma:L5147`
- `ItemCategory` → `schema.prisma:L12356`
- `JournalEntry` → `schema.prisma:L17040`
- `JournalLine` → `schema.prisma:L17069`
- `KdsOrder` → `schema.prisma:L15404`
- `KdsOrderItem` → `schema.prisma:L15467`
- `KioskCheckInAttempt` → `schema.prisma:L18002`
- `KioskCheckInChallenge` → `schema.prisma:L17956`
- `KioskOutreachOutbox` → `schema.prisma:L18023`
- `LaunchCampaign` → `schema.prisma:L18361`
- `LaunchCampaignRedemption` → `schema.prisma:L18478`
- `LearnedPatterns` → `schema.prisma:L10272`
- `LedgerAccount` → `schema.prisma:L16932`
- `LiveDemoSession` → `schema.prisma:L834`
- `LowStockAlert` → `schema.prisma:L2891`
- `LoyaltyConfig` → `schema.prisma:L7968`
- `LoyaltyTransaction` → `schema.prisma:L8011`
- `MarketingCampaign` → `schema.prisma:L13539`
- `McpAuthCode` → `schema.prisma:L16483`
- `McpOAuthClient` → `schema.prisma:L16467`
- `McpRefreshToken` → `schema.prisma:L16501`
- `McpToolCall` → `schema.prisma:L16522`
- `MeasurementUnit` → `schema.prisma:L15244`
- `Menu` → `schema.prisma:L1716`
- `MenuCategory` → `schema.prisma:L1653`
- `MenuCategoryAssignment` → `schema.prisma:L1751`
- `MercadoPagoWebhookEvent` → `schema.prisma:L16397`
- `MerchantAccount` → `schema.prisma:L5836`
- `MerchantFiscalConfig` → `schema.prisma:L16655`
- `MerchantRevenueShare` → `schema.prisma:L6965`
- `MerchantRoutingRule` → `schema.prisma:L5958`
- `MilestoneAchievement` → `schema.prisma:L12963`
- `Modifier` → `schema.prisma:L4227`
- `ModifierGroup` → `schema.prisma:L4191`
- `Module` → `schema.prisma:L11265`
- `MoneyAnomaly` → `schema.prisma:L6868`
- `MonthlyVenueProfit` → `schema.prisma:L7411`
- `Notification` → `schema.prisma:L9068`
- `NotificationPreference` → `schema.prisma:L9115`
- `NotificationTemplate` → `schema.prisma:L9142`
- `OAuthState` → `schema.prisma:L1549`
- `OnboardingProgress` → `schema.prisma:L1567`
- `Order` → `schema.prisma:L3754`
- `OrderAction` → `schema.prisma:L4298`
- `OrderCustomer` → `schema.prisma:L4007`
- `OrderDiscount` → `schema.prisma:L8929`
- `OrderFulfillment` → `schema.prisma:L15715`
- `OrderFulfillmentLine` → `schema.prisma:L15746`
- `OrderItem` → `schema.prisma:L4043`
- `OrderItemModifier` → `schema.prisma:L4280`
- `OrderItemSelloIva` → `schema.prisma:L16789`
- `OrderPromotion` → `schema.prisma:L17919`
- `OrderServiceCharge` → `schema.prisma:L9013`
- `Organization` → `schema.prisma:L18`
- `OrganizationAttendanceConfig` → `schema.prisma:L13340`
- `OrganizationEntitlement` → `schema.prisma:L11548`
- `OrganizationGoal` → `schema.prisma:L13298`
- `OrganizationModule` → `schema.prisma:L11325`
- `OrganizationPaymentConfig` → `schema.prisma:L6410`
- `OrganizationPayoutConfig` → `schema.prisma:L13373`
- `OrganizationPricingStructure` → `schema.prisma:L6442`
- `OrganizationSalesGoalConfig` → `schema.prisma:L13321`
- `OtpChallenge` → `schema.prisma:L7918`
- `OvertimeApproval` → `schema.prisma:L3532`
- `PartnerAPIKey` → `schema.prisma:L6240`
- `Payment` → `schema.prisma:L4331`
- `PaymentAllocation` → `schema.prisma:L4604`
- `PaymentEffect` → `schema.prisma:L18293`
- `PaymentLink` → `schema.prisma:L14915`
- `PaymentLinkAttribution` → `schema.prisma:L15023`
- `PaymentLinkItem` → `schema.prisma:L14978`
- `PaymentLinkItemModifier` → `schema.prisma:L15005`
- `PaymentProvider` → `schema.prisma:L5795`
- `PayrollLine` → `schema.prisma:L17415`
- `PayrollRun` → `schema.prisma:L17384`
- `PerformanceGoal` → `schema.prisma:L13275`
- `PermissionOverride` → `schema.prisma:L1422`
- `PermissionSet` → `schema.prisma:L1445`
- `PlatformAnnouncement` → `schema.prisma:L18083`
- `PlatformAnnouncementClick` → `schema.prisma:L18148`
- `PlatformAnnouncementDelivery` → `schema.prisma:L18185`
- `PlatformCfdi` → `schema.prisma:L17712`
- `PlatformEmisor` → `schema.prisma:L17652`
- `PlatformSettings` → `schema.prisma:L6217`
- `PosCommand` → `schema.prisma:L9196`
- `PosConnectionStatus` → `schema.prisma:L968`
- `PosSyncIntent` → `schema.prisma:L17790`
- `PricingPolicy` → `schema.prisma:L2787`
- `Printer` → `schema.prisma:L15516`
- `PrintGateway` → `schema.prisma:L15573`
- `PrintJob` → `schema.prisma:L16296`
- `PrintStation` → `schema.prisma:L15591`
- `PrivacyNoticeVersion` → `schema.prisma:L7666`
- `ProcessedStripeEvent` → `schema.prisma:L6854`
- `ProcessorReliabilityMetric` → `schema.prisma:L7339`
- `Product` → `schema.prisma:L1769`
- `ProductModifierGroup` → `schema.prisma:L4268`
- `ProductOption` → `schema.prisma:L15221`
- `ProductOptionValue` → `schema.prisma:L15232`
- `ProductStaff` → `schema.prisma:L14150`
- `PromoterBankAccount` → `schema.prisma:L17535`
- `PromoterCommissionEntry` → `schema.prisma:L17554`
- `PromoterLocationPing` → `schema.prisma:L3720`
- `Promotion` → `schema.prisma:L17841`
- `PromotionGroup` → `schema.prisma:L17880`
- `PromotionOption` → `schema.prisma:L17896`
- `ProviderCostStructure` → `schema.prisma:L6890`
- `ProviderEventLog` → `schema.prisma:L6519`
- `PurchaseOrder` → `schema.prisma:L2512`
- `PurchaseOrderInvoice` → `schema.prisma:L2657`
- `PurchaseOrderInvoiceLine` → `schema.prisma:L2714`
- `PurchaseOrderItem` → `schema.prisma:L2570`
- `RateCorrectionBatch` → `schema.prisma:L7115`
- `RateCorrectionEntry` → `schema.prisma:L7157`
- `RawMaterial` → `schema.prisma:L2268`
- `RawMaterialMovement` → `schema.prisma:L2840`
- `RawMaterialPresentation` → `schema.prisma:L2344`
- `ReceiptLayout` → `schema.prisma:L18327`
- `Recipe` → `schema.prisma:L2364`
- `RecipeLine` → `schema.prisma:L2388`
- `Referral` → `schema.prisma:L8384`
- `ReferralProgramConfig` → `schema.prisma:L8349`
- `ReferralRewardGrant` → `schema.prisma:L8475`
- `ReferralTierReward` → `schema.prisma:L8447`
- `ReferralTierUnlock` → `schema.prisma:L8520`
- `RefreshGrant` → `schema.prisma:L18272`
- `Reservation` → `schema.prisma:L13918`
- `ReservationGoogleEventMapping` → `schema.prisma:L14688`
- `ReservationModifier` → `schema.prisma:L14098`
- `ReservationReminderSent` → `schema.prisma:L14081`
- `ReservationSettings` → `schema.prisma:L14312`
- `ReservationWaitlistEntry` → `schema.prisma:L14280`
- `Review` → `schema.prisma:L5165`
- `SalesRetention` → `schema.prisma:L17235`
- `SaleVerification` → `schema.prisma:L4658`
- `ScaleProfile` → `schema.prisma:L16037`
- `ScheduledCommand` → `schema.prisma:L10749`
- `SerializedItem` → `schema.prisma:L12399`
- `SerializedItemCustodyEvent` → `schema.prisma:L12566`
- `ServiceCharge` → `schema.prisma:L8984`
- `Session` → `schema.prisma:L18251`
- `SettlementConfiguration` → `schema.prisma:L7190`
- `SettlementConfirmation` → `schema.prisma:L7303`
- `SettlementIncident` → `schema.prisma:L7254`
- `SettlementSimulation` → `schema.prisma:L7225`
- `Shift` → `schema.prisma:L3343`
- `SimRegistrationRequest` → `schema.prisma:L12604`
- `SimRegistrationRequestItem` → `schema.prisma:L12626`
- `SlotHold` → `schema.prisma:L14181`
- `Staff` → `schema.prisma:L988`
- `StaffDocument` → `schema.prisma:L3591`
- `StaffOnboardingState` → `schema.prisma:L16367`
- `StaffOrganization` → `schema.prisma:L1321`
- `StaffPasskey` → `schema.prisma:L1348`
- `StaffSchedule` → `schema.prisma:L14121`
- `StaffScheduleException` → `schema.prisma:L14133`
- `StaffVenue` → `schema.prisma:L1245`
- `StaffWorkSchedule` → `schema.prisma:L3468`
- `StaffWorkScheduleException` → `schema.prisma:L3566`
- `StampCard` → `schema.prisma:L8232`
- `StampEvent` → `schema.prisma:L8271`
- `StampReward` → `schema.prisma:L8309`
- `StockAlertConfig` → `schema.prisma:L13257`
- `StockBatch` → `schema.prisma:L3006`
- `StockCount` → `schema.prisma:L2923`
- `StockCountItem` → `schema.prisma:L2951`
- `StripeWebhookEvent` → `schema.prisma:L6837`
- `Supplier` → `schema.prisma:L2423`
- `SupplierItemCode` → `schema.prisma:L2755`
- `SupplierPricing` → `schema.prisma:L2478`
- `Table` → `schema.prisma:L3255`
- `Terminal` → `schema.prisma:L5216`
- `TerminalAttemptResolution` → `schema.prisma:L5654`
- `TerminalHealth` → `schema.prisma:L5474`
- `TerminalLog` → `schema.prisma:L5448`
- `TerminalOrder` → `schema.prisma:L5698`
- `TerminalOrderItem` → `schema.prisma:L5773`
- `TerminalPaymentAttemptLink` → `schema.prisma:L5626`
- `TerminalPaymentRequest` → `schema.prisma:L5545`
- `TimeEntry` → `schema.prisma:L3633`
- `TimeEntryBreak` → `schema.prisma:L3702`
- `TokenPurchase` → `schema.prisma:L10421`
- `TokenUsageRecord` → `schema.prisma:L10393`
- `TpvCommandHistory` → `schema.prisma:L10655`
- `TpvCommandQueue` → `schema.prisma:L10593`
- `TpvFeedback` → `schema.prisma:L10306`
- `TpvMessage` → `schema.prisma:L13614`
- `TpvMessageDelivery` → `schema.prisma:L13666`
- `TpvMessageResponse` → `schema.prisma:L13689`
- `TrainingModule` → `schema.prisma:L13744`
- `TrainingProgress` → `schema.prisma:L13821`
- `TrainingQuizQuestion` → `schema.prisma:L13803`
- `TrainingStep` → `schema.prisma:L13783`
- `TransactionCost` → `schema.prisma:L7053`
- `UnitConversion` → `schema.prisma:L2818`
- `UpsellAcceptance` → `schema.prisma:L8805`
- `UpsellAiRun` → `schema.prisma:L8825`
- `UpsellImpression` → `schema.prisma:L8765`
- `UpsellRule` → `schema.prisma:L8685`
- `user_sessions` → `schema.prisma:L6275`
- `Venue` → `schema.prisma:L167`
- `VenueAreaTicketSettings` → `schema.prisma:L15774`
- `VenueChatMessage` → `schema.prisma:L810`
- `VenueChatSession` → `schema.prisma:L765`
- `VenueCommission` → `schema.prisma:L15382`
- `VenueCreditAssessment` → `schema.prisma:L11137`
- `VenueCryptoConfig` → `schema.prisma:L13481`
- `VenueFeature` → `schema.prisma:L4772`
- `VenueIvaPorProducto` → `schema.prisma:L961`
- `VenueModule` → `schema.prisma:L11297`
- `VenuePaymentConfig` → `schema.prisma:L6376`
- `VenuePaymentLinkSettings` → `schema.prisma:L14721`
- `VenuePricingStructure` → `schema.prisma:L6993`
- `VenueRoleConfig` → `schema.prisma:L1474`
- `VenueRolePermission` → `schema.prisma:L1378`
- `VenueScaleSettings` → `schema.prisma:L16025`
- `VenueSettings` → `schema.prisma:L850`
- `VenueTenderType` → `schema.prisma:L4517`
- `VenueTenderTypeRevision` → `schema.prisma:L4582`
- `VenueTransaction` → `schema.prisma:L4709`
- `VenueWhatsappActivation` → `schema.prisma:L701`
- `WalletCardDesign` → `schema.prisma:L8150`
- `WalletPass` → `schema.prisma:L8051`
- `WalletPassRegistration` → `schema.prisma:L8117`
- `WebhookEvent` → `schema.prisma:L5074`
- `WebhookSubscription` → `schema.prisma:L6492`
- `WhatsappContactWindow` → `schema.prisma:L719`
- `WhatsappInboundEvent` → `schema.prisma:L739`
- `WorkShiftAssignment` → `schema.prisma:L3508`
- `WorkShiftTemplate` → `schema.prisma:L3485`
- `Zone` → `schema.prisma:L150`
