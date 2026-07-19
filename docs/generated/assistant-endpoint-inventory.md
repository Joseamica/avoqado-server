# Assistant Endpoint Inventory

Generated: 2026-07-18T23:30:54.926Z

## Summary

- Total endpoints: 1716
- Assistant tools registered: 80
- Coverage: missing 688, blocked 519, partial 504, covered 5
- Classifications: read 540, adminOnly 446, action 371, mutation 144, dangerousMutation 142, public 73
- Scopes: venue 873, superadmin 402, unknown 194, organization 137, public 110

## Top Missing Domains

- dashboard: 152
- tpv: 46
- accounting: 44
- stores-analysis: 30
- onboarding: 21
- tpv-commands: 19
- mobile: 19
- coupons: 15
- ecommerce-merchants: 13
- print-stations: 13
- modifier-groups: 12
- discounts: 11
- referrals: 11
- sdk: 11
- google-calendar: 10
- tables: 10
- promoters: 8
- class-sessions: 8
- customer-groups: 8
- fiscal: 8

## High-Risk Or Admin-Only Endpoints

- POST `/api/v1/consumer/venues/:venueSlug/reservations/:cancelSecret/payment` — dangerousMutation; permissions: none; controller: reservationController.createDepositCheckout
- DELETE `/api/v1/dashboard/assistant/conversations/:conversationId` — dangerousMutation; permissions: none; controller: assistantController.deleteConversation
- POST `/api/v1/dashboard/auth/request-reset` — dangerousMutation; permissions: none; controller: authDashboardController.requestPasswordReset
- POST `/api/v1/dashboard/auth/reset-password` — dangerousMutation; permissions: none; controller: authDashboardController.resetPassword
- POST `/api/v1/dashboard/commissions/venues/:venueId/calculations/:calculationId/clawback` — dangerousMutation; permissions: commissions:update; controller: controller.createClawback
- POST `/api/v1/dashboard/commissions/venues/:venueId/calculations/:calculationId/void` — dangerousMutation; permissions: commissions:update; controller: controller.voidCalculation
- DELETE `/api/v1/dashboard/commissions/venues/:venueId/clawbacks/:clawbackId` — dangerousMutation; permissions: commissions:update; controller: controller.voidClawback
- DELETE `/api/v1/dashboard/commissions/venues/:venueId/configs/:configId` — dangerousMutation; permissions: commissions:delete; controller: controller.deleteConfig
- POST `/api/v1/dashboard/commissions/venues/:venueId/configs/:configId/bulk-exclude` — dangerousMutation; permissions: commissions:update; controller: controller.bulkExcludeStaff
- DELETE `/api/v1/dashboard/commissions/venues/:venueId/goals/:goalId` — dangerousMutation; permissions: commissions:delete; controller: controller.deleteSalesGoal
- DELETE `/api/v1/dashboard/commissions/venues/:venueId/milestones/:milestoneId` — dangerousMutation; permissions: commissions:delete; controller: controller.deleteMilestone
- GET `/api/v1/dashboard/commissions/venues/:venueId/org-configs` — adminOnly; permissions: commissions:org-manage; controller: (inline handler)
- POST `/api/v1/dashboard/commissions/venues/:venueId/org-configs` — adminOnly; permissions: commissions:org-manage; controller: (inline handler)
- DELETE `/api/v1/dashboard/commissions/venues/:venueId/org-configs/:configId` — adminOnly; permissions: commissions:org-manage; controller: (inline handler)
- PUT `/api/v1/dashboard/commissions/venues/:venueId/org-configs/:configId` — adminOnly; permissions: commissions:org-manage; controller: (inline handler)
- DELETE `/api/v1/dashboard/commissions/venues/:venueId/org-payout-config` — adminOnly; permissions: commissions:org-manage; controller: (inline handler)
- GET `/api/v1/dashboard/commissions/venues/:venueId/org-payout-config` — adminOnly; permissions: commissions:org-manage; controller: (inline handler)
- PUT `/api/v1/dashboard/commissions/venues/:venueId/org-payout-config` — adminOnly; permissions: commissions:org-manage; controller: (inline handler)
- DELETE `/api/v1/dashboard/commissions/venues/:venueId/overrides/:overrideId` — dangerousMutation; permissions: commissions:delete; controller: controller.deleteOverride
- POST `/api/v1/dashboard/commissions/venues/:venueId/payouts` — dangerousMutation; permissions: commissions:payout; controller: controller.createPayout
- POST `/api/v1/dashboard/commissions/venues/:venueId/payouts/:payoutId/approve` — dangerousMutation; permissions: commissions:payout; controller: controller.approvePayout
- POST `/api/v1/dashboard/commissions/venues/:venueId/payouts/:payoutId/cancel` — dangerousMutation; permissions: commissions:payout; controller: controller.cancelPayout
- POST `/api/v1/dashboard/commissions/venues/:venueId/payouts/:payoutId/complete` — dangerousMutation; permissions: commissions:payout; controller: controller.completePayout
- POST `/api/v1/dashboard/commissions/venues/:venueId/payouts/:payoutId/fail` — dangerousMutation; permissions: commissions:payout; controller: controller.failPayout
- POST `/api/v1/dashboard/commissions/venues/:venueId/payouts/:payoutId/process` — dangerousMutation; permissions: commissions:payout; controller: controller.startPayoutProcessing
- POST `/api/v1/dashboard/commissions/venues/:venueId/run-job` — dangerousMutation; permissions: commissions:payout; controller: controller.runAggregationJob
- POST `/api/v1/dashboard/commissions/venues/:venueId/summaries/:summaryId/approve` — dangerousMutation; permissions: commissions:approve; controller: controller.approveSummary
- POST `/api/v1/dashboard/commissions/venues/:venueId/summaries/bulk-approve` — dangerousMutation; permissions: commissions:approve; controller: controller.bulkApproveSummaries
- DELETE `/api/v1/dashboard/commissions/venues/:venueId/tiers/:tierId` — dangerousMutation; permissions: commissions:delete; controller: controller.deleteTier
- POST `/api/v1/dashboard/impersonation/extend` — dangerousMutation; permissions: none; controller: impersonationController.extendHandler
- POST `/api/v1/dashboard/impersonation/start` — dangerousMutation; permissions: none; controller: impersonationController.startHandler
- POST `/api/v1/dashboard/impersonation/stop` — dangerousMutation; permissions: none; controller: impersonationController.stopHandler
- DELETE `/api/v1/dashboard/notifications/:id` — dangerousMutation; permissions: none; controller: notificationController.deleteNotification
- POST `/api/v1/dashboard/notifications/bulk` — dangerousMutation; permissions: notifications:send; controller: notificationController.sendBulkNotification
- PUT `/api/v1/dashboard/notifications/preferences/bulk` — dangerousMutation; permissions: none; controller: notificationController.updatePreferencesBulk
- DELETE `/api/v1/dashboard/organizations/:orgId/org-attendance-config` — dangerousMutation; permissions: none; controller: (inline handler)
- DELETE `/api/v1/dashboard/organizations/:orgId/org-categories/:categoryId` — dangerousMutation; permissions: none; controller: (inline handler)
- DELETE `/api/v1/dashboard/organizations/:orgId/org-goals/:goalId` — dangerousMutation; permissions: none; controller: (inline handler)
- POST `/api/v1/dashboard/organizations/:orgId/pending-stock-approvals/approve` — dangerousMutation; permissions: sim-custody:approve-registration; controller: approveStockItems
- POST `/api/v1/dashboard/organizations/:orgId/sim-registration-requests/:id/approve` — dangerousMutation; permissions: sim-custody:approve-registration; controller: approveRequest
- POST `/api/v1/dashboard/organizations/:orgId/team/:staffId/reset-password` — dangerousMutation; permissions: none; controller: (inline handler)
- DELETE `/api/v1/dashboard/organizations/:orgId/terminals/:terminalId` — dangerousMutation; permissions: none; controller: (inline handler)
- POST `/api/v1/dashboard/organizations/:orgId/terminals/:terminalId/migrate-cancel` — dangerousMutation; permissions: none; controller: (inline handler)
- POST `/api/v1/dashboard/organizations/:orgId/terminals/bulk-command` — dangerousMutation; permissions: none; controller: (inline handler)
- DELETE `/api/v1/dashboard/organizations/:orgId/zones/:zoneId` — dangerousMutation; permissions: none; controller: (inline handler)
- GET `/api/v1/dashboard/superadmin/aggregators` — adminOnly; permissions: none; controller: aggregatorController.getAggregators
- POST `/api/v1/dashboard/superadmin/aggregators` — adminOnly; permissions: none; controller: aggregatorController.createAggregator
- DELETE `/api/v1/dashboard/superadmin/aggregators/:id` — adminOnly; permissions: none; controller: aggregatorController.deleteAggregator
- GET `/api/v1/dashboard/superadmin/aggregators/:id` — adminOnly; permissions: none; controller: aggregatorController.getAggregatorById
- PUT `/api/v1/dashboard/superadmin/aggregators/:id` — adminOnly; permissions: none; controller: aggregatorController.updateAggregator
- POST `/api/v1/dashboard/superadmin/aggregators/:id/generate-token` — adminOnly; permissions: none; controller: aggregatorController.generateReportToken
- DELETE `/api/v1/dashboard/superadmin/aggregators/:id/revoke-token` — adminOnly; permissions: none; controller: aggregatorController.revokeReportToken
- PATCH `/api/v1/dashboard/superadmin/aggregators/:id/toggle` — adminOnly; permissions: none; controller: aggregatorController.toggleAggregator
- GET `/api/v1/dashboard/superadmin/balance-providers` — adminOnly; permissions: none; controller: balanceProviderController.getBalanceProviders
- GET `/api/v1/dashboard/superadmin/cost-structures/analysis` — adminOnly; permissions: none; controller: costManagementController.getCostStructureAnalysis
- GET `/api/v1/dashboard/superadmin/cost-structures/provider` — adminOnly; permissions: none; controller: costManagementController.getProviderCostStructures
- POST `/api/v1/dashboard/superadmin/cost-structures/provider` — adminOnly; permissions: none; controller: costManagementController.upsertProviderCostStructure
- GET `/api/v1/dashboard/superadmin/dashboard` — adminOnly; permissions: none; controller: superadminController.getDashboardData
- GET `/api/v1/dashboard/superadmin/ecommerce-merchants` — adminOnly; permissions: none; controller: ecommerceMerchantsSuperadminController.listAllEcommerceMerchants
- DELETE `/api/v1/dashboard/superadmin/ecommerce-merchants/:id` — adminOnly; permissions: none; controller: ecommerceMerchantsSuperadminController.deleteEcommerceMerchant
- GET `/api/v1/dashboard/superadmin/ecommerce-merchants/:id/fee-history` — adminOnly; permissions: none; controller: ecommerceMerchantsSuperadminController.getMerchantFeeHistory
- GET `/api/v1/dashboard/superadmin/features` — adminOnly; permissions: none; controller: superadminController.getAllFeatures
- POST `/api/v1/dashboard/superadmin/features` — adminOnly; permissions: none; controller: superadminController.createFeature
- GET `/api/v1/dashboard/superadmin/kyc/:venueId` — adminOnly; permissions: none; controller: asyncHandler(kycReviewController.getKycDetails)
- POST `/api/v1/dashboard/superadmin/kyc/:venueId/approve` — adminOnly; permissions: none; controller: asyncHandler(kycReviewController.approveKyc)
- POST `/api/v1/dashboard/superadmin/kyc/:venueId/assign-processor` — adminOnly; permissions: none; controller: asyncHandler(kycReviewController.assignProcessorAndApprove)
- POST `/api/v1/dashboard/superadmin/kyc/:venueId/mark-in-review` — adminOnly; permissions: none; controller: asyncHandler(kycReviewController.markInReview)
- POST `/api/v1/dashboard/superadmin/kyc/:venueId/reject` — adminOnly; permissions: none; controller: asyncHandler(kycReviewController.rejectKyc)
- GET `/api/v1/dashboard/superadmin/kyc/pending` — adminOnly; permissions: none; controller: asyncHandler(kycReviewController.listPendingKyc)
- GET `/api/v1/dashboard/superadmin/marketing/campaigns` — adminOnly; permissions: none; controller: marketingController.listCampaigns
- POST `/api/v1/dashboard/superadmin/marketing/campaigns` — adminOnly; permissions: none; controller: marketingController.createCampaign
- DELETE `/api/v1/dashboard/superadmin/marketing/campaigns/:id` — adminOnly; permissions: none; controller: marketingController.deleteCampaign
- GET `/api/v1/dashboard/superadmin/marketing/campaigns/:id` — adminOnly; permissions: none; controller: marketingController.getCampaign
- PATCH `/api/v1/dashboard/superadmin/marketing/campaigns/:id` — adminOnly; permissions: none; controller: marketingController.updateCampaign
- POST `/api/v1/dashboard/superadmin/marketing/campaigns/:id/cancel` — adminOnly; permissions: none; controller: marketingController.cancelCampaign
- GET `/api/v1/dashboard/superadmin/marketing/campaigns/:id/deliveries` — adminOnly; permissions: none; controller: marketingController.getCampaignDeliveries
- POST `/api/v1/dashboard/superadmin/marketing/campaigns/:id/send` — adminOnly; permissions: none; controller: marketingController.sendCampaign
- DELETE `/api/v1/dashboard/superadmin/marketing/campaigns/bulk` — adminOnly; permissions: none; controller: marketingController.bulkDeleteCampaigns
- POST `/api/v1/dashboard/superadmin/marketing/recipients/preview` — adminOnly; permissions: none; controller: marketingController.previewRecipients
- GET `/api/v1/dashboard/superadmin/marketing/templates` — adminOnly; permissions: none; controller: marketingController.listTemplates
- POST `/api/v1/dashboard/superadmin/marketing/templates` — adminOnly; permissions: none; controller: marketingController.createTemplate
- DELETE `/api/v1/dashboard/superadmin/marketing/templates/:id` — adminOnly; permissions: none; controller: marketingController.deleteTemplate
- GET `/api/v1/dashboard/superadmin/marketing/templates/:id` — adminOnly; permissions: none; controller: marketingController.getTemplate
- PATCH `/api/v1/dashboard/superadmin/marketing/templates/:id` — adminOnly; permissions: none; controller: marketingController.updateTemplate
- GET `/api/v1/dashboard/superadmin/master-totp/setup` — adminOnly; permissions: none; controller: superadminController.getMasterTotpSetup
- GET `/api/v1/dashboard/superadmin/merchant-accounts` — adminOnly; permissions: none; controller: merchantAccountController.getMerchantAccounts
- POST `/api/v1/dashboard/superadmin/merchant-accounts` — adminOnly; permissions: none; controller: merchantAccountController.createMerchantAccount
- DELETE `/api/v1/dashboard/superadmin/merchant-accounts/:id` — adminOnly; permissions: none; controller: merchantAccountController.deleteMerchantAccount
- GET `/api/v1/dashboard/superadmin/merchant-accounts/:id` — adminOnly; permissions: none; controller: merchantAccountController.getMerchantAccount
- PUT `/api/v1/dashboard/superadmin/merchant-accounts/:id` — adminOnly; permissions: none; controller: merchantAccountController.updateMerchantAccount
- GET `/api/v1/dashboard/superadmin/merchant-accounts/:id/assignable-terminals` — adminOnly; permissions: none; controller: merchantAccountController.getAssignableTerminals
- GET `/api/v1/dashboard/superadmin/merchant-accounts/:id/balance` — adminOnly; permissions: none; controller: merchantAccountController.getBalance
- POST `/api/v1/dashboard/superadmin/merchant-accounts/:id/batch-assign-terminals` — adminOnly; permissions: none; controller: merchantAccountController.batchAssignTerminals
- GET `/api/v1/dashboard/superadmin/merchant-accounts/:id/blockers` — adminOnly; permissions: none; controller: merchantAccountController.getMerchantAccountBlockers
- POST `/api/v1/dashboard/superadmin/merchant-accounts/:id/blumon/refetch` — adminOnly; permissions: none; controller: merchantAccountController.refetchBlumonMerchantCredentials
- GET `/api/v1/dashboard/superadmin/merchant-accounts/:id/credentials` — adminOnly; permissions: none; controller: merchantAccountController.getMerchantAccountCredentials
- GET `/api/v1/dashboard/superadmin/merchant-accounts/:id/terminals` — adminOnly; permissions: none; controller: merchantAccountController.getTerminalsByMerchantAccount
- DELETE `/api/v1/dashboard/superadmin/merchant-accounts/:id/terminals/:terminalId` — adminOnly; permissions: none; controller: merchantAccountController.removeMerchantFromTerminal
- PUT `/api/v1/dashboard/superadmin/merchant-accounts/:id/terminals/:terminalId` — adminOnly; permissions: none; controller: merchantAccountController.setTerminalServesMerchant
- PATCH `/api/v1/dashboard/superadmin/merchant-accounts/:id/toggle` — adminOnly; permissions: none; controller: merchantAccountController.toggleMerchantAccountStatus
- POST `/api/v1/dashboard/superadmin/merchant-accounts/blumon/auto-fetch` — adminOnly; permissions: none; controller: merchantAccountController.autoFetchBlumonCredentials
- POST `/api/v1/dashboard/superadmin/merchant-accounts/blumon/batch-auto-fetch` — adminOnly; permissions: none; controller: merchantAccountController.batchAutoFetchBlumonCredentials
- POST `/api/v1/dashboard/superadmin/merchant-accounts/blumon/full-setup` — adminOnly; permissions: none; controller: merchantAccountController.fullSetupBlumonMerchant
- POST `/api/v1/dashboard/superadmin/merchant-accounts/blumon/register` — adminOnly; permissions: none; controller: merchantAccountController.registerBlumonMerchant
- POST `/api/v1/dashboard/superadmin/merchant-accounts/full-setup-angelpay` — adminOnly; permissions: none; controller: merchantAccountController.fullSetupAngelPayMerchant
- GET `/api/v1/dashboard/superadmin/merchant-accounts/list` — adminOnly; permissions: none; controller: superadminController.getMerchantAccountsList
- GET `/api/v1/dashboard/superadmin/merchant-accounts/mcc-lookup` — adminOnly; permissions: none; controller: merchantAccountController.getMccRateSuggestion
- GET `/api/v1/dashboard/superadmin/merchant-accounts/payment-setup/summary` — adminOnly; permissions: none; controller: merchantAccountController.getPaymentSetupSummary
- POST `/api/v1/dashboard/superadmin/merchant-accounts/with-cost-structure` — adminOnly; permissions: none; controller: merchantAccountController.createMerchantAccountWithCostStructure
- GET `/api/v1/dashboard/superadmin/merchant-revenue-shares` — adminOnly; permissions: none; controller: controller.getMerchantRevenueShares
- POST `/api/v1/dashboard/superadmin/merchant-revenue-shares` — adminOnly; permissions: none; controller: controller.createMerchantRevenueShare
- DELETE `/api/v1/dashboard/superadmin/merchant-revenue-shares/:id` — adminOnly; permissions: none; controller: controller.deleteMerchantRevenueShare
- GET `/api/v1/dashboard/superadmin/merchant-revenue-shares/:id` — adminOnly; permissions: none; controller: controller.getMerchantRevenueShareById
- PUT `/api/v1/dashboard/superadmin/merchant-revenue-shares/:id` — adminOnly; permissions: none; controller: controller.updateMerchantRevenueShare
- GET `/api/v1/dashboard/superadmin/merchant-revenue-shares/by-merchant` — adminOnly; permissions: none; controller: controller.getMerchantRevenueShareByMerchant
- GET `/api/v1/dashboard/superadmin/merchant-revenue-shares/report` — adminOnly; permissions: none; controller: controller.getRevenueShareReport
- GET `/api/v1/dashboard/superadmin/modules` — adminOnly; permissions: none; controller: moduleController.getAllModules
- POST `/api/v1/dashboard/superadmin/modules` — adminOnly; permissions: none; controller: moduleController.createModule
- GET `/api/v1/dashboard/superadmin/modules/:moduleCode/venues` — adminOnly; permissions: none; controller: moduleController.getVenuesForModule
- DELETE `/api/v1/dashboard/superadmin/modules/:moduleId` — adminOnly; permissions: none; controller: moduleController.deleteModule

## Endpoint Inventory

| Method | Path | Class | Scope | Coverage | Permissions | Schema | Controller |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/analytics/overview` | read | unknown | partial | analytics:read | analyticsOverviewQuerySchema | getAnalyticsOverview |
| POST | `/api/v1/consumer/auth/oauth` | action | unknown | missing | - | consumerOAuthSchema | authController.oauthLogin |
| GET | `/api/v1/consumer/credits` | read | unknown | partial | - | - | creditController.mine |
| POST | `/api/v1/consumer/credits/checkout/finalize` | action | unknown | partial | - | consumerFinalizeCreditCheckoutSchema | creditController.finalizeCheckout |
| GET | `/api/v1/consumer/me` | read | unknown | missing | - | - | authController.me |
| GET | `/api/v1/consumer/reservations` | read | unknown | partial | - | - | reservationController.mine |
| POST | `/api/v1/consumer/reservations/deposit/finalize` | action | unknown | partial | - | consumerFinalizeReservationDepositCheckoutSchema | reservationController.finalizeDepositCheckout |
| GET | `/api/v1/consumer/venues` | read | unknown | missing | - | searchConsumerVenuesSchema | venueController.search |
| GET | `/api/v1/consumer/venues/:venueSlug` | read | unknown | missing | - | consumerVenueParamsSchema | venueController.detail |
| POST | `/api/v1/consumer/venues/:venueSlug/credit-packs/:packId/checkout` | action | unknown | partial | - | consumerCreateCreditCheckoutSchema | creditController.createCheckout |
| POST | `/api/v1/consumer/venues/:venueSlug/reservations` | action | unknown | partial | - | consumerCreateReservationSchema | reservationController.create |
| POST | `/api/v1/consumer/venues/:venueSlug/reservations/:cancelSecret/payment` | dangerousMutation | unknown | partial | - | consumerReservationDepositCheckoutSchema | reservationController.createDepositCheckout |
| PATCH | `/api/v1/dashboard/:venueId/account` | mutation | unknown | missing | - | updateAccountSchema | authDashboardController.updateAccountController |
| POST | `/api/v1/dashboard/assistant/actions/confirm` | action | unknown | missing | - | assistantActionConfirmSchema | textToSqlAssistantController.confirmAssistantAction |
| POST | `/api/v1/dashboard/assistant/actions/preview` | action | unknown | missing | - | assistantActionPreviewSchema | textToSqlAssistantController.previewAssistantAction |
| GET | `/api/v1/dashboard/assistant/conversations` | read | unknown | missing | - | assistantConversationListSchema | assistantController.listConversations |
| POST | `/api/v1/dashboard/assistant/conversations` | action | unknown | missing | - | assistantCreateConversationSchema | assistantController.createConversation |
| DELETE | `/api/v1/dashboard/assistant/conversations/:conversationId` | dangerousMutation | unknown | missing | - | assistantConversationParamsSchema | assistantController.deleteConversation |
| GET | `/api/v1/dashboard/assistant/conversations/:conversationId` | read | unknown | missing | - | assistantConversationParamsSchema | assistantController.getConversation |
| POST | `/api/v1/dashboard/assistant/feedback` | action | unknown | missing | - | feedbackSubmissionSchema | assistantController.submitFeedback |
| POST | `/api/v1/dashboard/assistant/generate-title` | action | unknown | missing | - | - | assistantController.generateConversationTitle |
| POST | `/api/v1/dashboard/assistant/query` | action | unknown | missing | - | assistantQuerySchema | assistantController.processAssistantQuery |
| GET | `/api/v1/dashboard/assistant/suggestions` | read | unknown | missing | - | - | assistantController.getAssistantSuggestions |
| POST | `/api/v1/dashboard/assistant/text-to-sql` | action | unknown | missing | - | assistantQuerySchema | textToSqlAssistantController.processTextToSqlQuery |
| POST | `/api/v1/dashboard/auth/google/callback` | action | unknown | missing | - | - | googleOAuthController.googleOAuthCallback |
| GET | `/api/v1/dashboard/auth/google/check-invitation` | read | unknown | missing | - | - | googleOAuthController.checkInvitation |
| POST | `/api/v1/dashboard/auth/google/one-tap` | action | unknown | missing | - | - | googleOAuthController.googleOneTapLogin |
| GET | `/api/v1/dashboard/auth/google/url` | read | unknown | missing | - | - | googleOAuthController.getGoogleAuthUrl |
| POST | `/api/v1/dashboard/auth/login` | action | unknown | missing | - | loginSchema | // Validate login request body authDashboardController.dashboardLoginController |
| POST | `/api/v1/dashboard/auth/logout` | action | unknown | missing | - | - | // Logout can be called even if token is expired/invalid to clear cookies authDashboardController.dashboardLogoutController |
| POST | `/api/v1/dashboard/auth/request-reset` | dangerousMutation | unknown | missing | - | requestPasswordResetSchema | authDashboardController.requestPasswordReset |
| POST | `/api/v1/dashboard/auth/reset-password` | dangerousMutation | unknown | missing | - | resetPasswordSchema | authDashboardController.resetPassword |
| GET | `/api/v1/dashboard/auth/status` | read | unknown | missing | - | - | // Controller handles token presence internally for flexibility authDashboardController.getAuthStatus |
| POST | `/api/v1/dashboard/auth/switch-venue` | action | unknown | missing | - | switchVenueSchema | // Validate the request body (changed from validateRequestMiddleware) authDashboardController.switchVenueController |
| GET | `/api/v1/dashboard/auth/validate-reset-token/:token` | read | unknown | missing | - | - | authDashboardController.validateResetToken |
| GET | `/api/v1/dashboard/cash-out/venues/:venueId/active-days` | read | venue | missing | cash-out:read | listActiveDaysSchema | ctrl.getActiveDays |
| PUT | `/api/v1/dashboard/cash-out/venues/:venueId/active-days` | mutation | venue | missing | cash-out:manage | setActiveDaysSchema | ctrl.putActiveDays |
| GET | `/api/v1/dashboard/cash-out/venues/:venueId/commission-rates` | read | venue | missing | cash-out:read | - | ctrl.getCommissionRates |
| PUT | `/api/v1/dashboard/cash-out/venues/:venueId/commission-rates` | mutation | venue | missing | cash-out:manage | replaceCommissionRatesSchema | ctrl.putCommissionRates |
| GET | `/api/v1/dashboard/cash-out/venues/:venueId/promoters/:staffId/saldo` | read | venue | missing | cash-out:read | - | ctrl.getSaldo |
| POST | `/api/v1/dashboard/cash-out/venues/:venueId/promoters/:staffId/withdraw` | action | venue | missing | cash-out:manage | - | ctrl.postWithdraw |
| POST | `/api/v1/dashboard/cash-out/venues/:venueId/report` | action | venue | missing | cash-out:report | generateReportSchema | ctrl.postReport |
| GET | `/api/v1/dashboard/cash-out/venues/:venueId/withdrawals` | read | venue | missing | cash-out:read | listWithdrawalsSchema | ctrl.getWithdrawals |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/aggregate` | action | venue | partial | commissions:update | - | controller.triggerAggregation |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/calculations/:calculationId/clawback` | dangerousMutation | venue | partial | commissions:update | - | controller.createClawback |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/calculations/:calculationId/void` | dangerousMutation | venue | partial | commissions:update | - | controller.voidCalculation |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/calculations/manual` | action | venue | partial | commissions:create | - | controller.createManualCommission |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/clawbacks` | read | venue | partial | commissions:read | - | controller.getClawbacks |
| DELETE | `/api/v1/dashboard/commissions/venues/:venueId/clawbacks/:clawbackId` | dangerousMutation | venue | partial | commissions:update | - | controller.voidClawback |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/clawbacks/:clawbackId` | read | venue | partial | commissions:read | - | controller.getClawbackById |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/clawbacks/stats` | read | venue | partial | commissions:read | - | controller.getClawbackStats |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/configs` | read | venue | partial | commissions:read | - | controller.getConfigs |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/configs` | action | venue | partial | commissions:create | - | controller.createConfig |
| DELETE | `/api/v1/dashboard/commissions/venues/:venueId/configs/:configId` | dangerousMutation | venue | partial | commissions:delete | - | controller.deleteConfig |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/configs/:configId` | read | venue | partial | commissions:read | - | controller.getConfigById |
| PUT | `/api/v1/dashboard/commissions/venues/:venueId/configs/:configId` | mutation | venue | partial | commissions:update | - | controller.updateConfig |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/configs/:configId/bulk-exclude` | dangerousMutation | venue | partial | commissions:update | - | controller.bulkExcludeStaff |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/configs/:configId/copy` | action | venue | partial | commissions:create | - | controller.copyConfig |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/configs/:configId/milestones` | read | venue | partial | commissions:read | - | controller.getMilestones |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/configs/:configId/milestones` | action | venue | partial | commissions:create | - | controller.createMilestone |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/configs/:configId/overrides` | read | venue | partial | commissions:read | - | controller.getOverrides |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/configs/:configId/overrides` | action | venue | partial | commissions:create | - | controller.createOverride |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/configs/:configId/tiers` | read | venue | partial | commissions:read | - | controller.getTiers |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/configs/:configId/tiers` | action | venue | partial | commissions:create | - | controller.createTier |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/configs/:configId/tiers/batch` | action | venue | partial | commissions:create | - | controller.createTiersBatch |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/effective-configs` | read | venue | partial | commissions:read | - | (inline handler) |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/effective-payout-config` | read | venue | partial | commissions:read | - | (inline handler) |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/goals` | read | venue | partial | commissions:read | - | controller.getSalesGoals |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/goals` | action | venue | partial | commissions:create | - | controller.createSalesGoal |
| DELETE | `/api/v1/dashboard/commissions/venues/:venueId/goals/:goalId` | dangerousMutation | venue | partial | commissions:delete | - | controller.deleteSalesGoal |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/goals/:goalId` | read | venue | partial | commissions:read | - | controller.getSalesGoalById |
| PATCH | `/api/v1/dashboard/commissions/venues/:venueId/goals/:goalId` | mutation | venue | partial | commissions:update | - | controller.updateSalesGoal |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/job-status` | read | venue | partial | commissions:payout | - | controller.getJobStatus |
| DELETE | `/api/v1/dashboard/commissions/venues/:venueId/milestones/:milestoneId` | dangerousMutation | venue | partial | commissions:delete | - | controller.deleteMilestone |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/milestones/:milestoneId` | read | venue | partial | commissions:read | - | controller.getMilestoneById |
| PUT | `/api/v1/dashboard/commissions/venues/:venueId/milestones/:milestoneId` | mutation | venue | partial | commissions:update | - | controller.updateMilestone |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/my-commission-stats` | read | venue | partial | commissions:view_own | - | controller.getMyCommissionStats |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/my-commissions` | read | venue | partial | commissions:view_own | - | controller.getMyCommissions |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/org-configs` | adminOnly | venue | blocked | commissions:org-manage | - | (inline handler) |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/org-configs` | adminOnly | venue | blocked | commissions:org-manage | - | (inline handler) |
| DELETE | `/api/v1/dashboard/commissions/venues/:venueId/org-configs/:configId` | adminOnly | venue | blocked | commissions:org-manage | - | (inline handler) |
| PUT | `/api/v1/dashboard/commissions/venues/:venueId/org-configs/:configId` | adminOnly | venue | blocked | commissions:org-manage | - | (inline handler) |
| DELETE | `/api/v1/dashboard/commissions/venues/:venueId/org-payout-config` | adminOnly | venue | blocked | commissions:org-manage | - | (inline handler) |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/org-payout-config` | adminOnly | venue | blocked | commissions:org-manage | - | (inline handler) |
| PUT | `/api/v1/dashboard/commissions/venues/:venueId/org-payout-config` | adminOnly | venue | blocked | commissions:org-manage | - | (inline handler) |
| DELETE | `/api/v1/dashboard/commissions/venues/:venueId/overrides/:overrideId` | dangerousMutation | venue | partial | commissions:delete | - | controller.deleteOverride |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/overrides/:overrideId` | read | venue | partial | commissions:read | - | controller.getOverrideById |
| PUT | `/api/v1/dashboard/commissions/venues/:venueId/overrides/:overrideId` | mutation | venue | partial | commissions:update | - | controller.updateOverride |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/payments/:paymentId/commission` | read | venue | partial | commissions:read | - | controller.getCommissionByPayment |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/payments/commissions/batch` | action | venue | partial | commissions:read | - | controller.getCommissionsByPaymentsBatch |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/payouts` | read | venue | partial | commissions:payout | - | controller.getPayouts |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/payouts` | dangerousMutation | venue | partial | commissions:payout | - | controller.createPayout |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/payouts/:payoutId` | read | venue | partial | commissions:payout | - | controller.getPayoutById |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/payouts/:payoutId/approve` | dangerousMutation | venue | partial | commissions:payout | - | controller.approvePayout |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/payouts/:payoutId/cancel` | dangerousMutation | venue | partial | commissions:payout | - | controller.cancelPayout |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/payouts/:payoutId/complete` | dangerousMutation | venue | partial | commissions:payout | - | controller.completePayout |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/payouts/:payoutId/fail` | dangerousMutation | venue | partial | commissions:payout | - | controller.failPayout |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/payouts/:payoutId/process` | dangerousMutation | venue | partial | commissions:payout | - | controller.startPayoutProcessing |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/payouts/stats` | read | venue | partial | commissions:payout | - | controller.getPayoutStats |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/run-job` | dangerousMutation | venue | partial | commissions:payout | - | controller.runAggregationJob |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/staff/:staffId/achievements` | read | venue | partial | commissions:read | - | controller.getStaffAchievements |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/staff/:staffId/commission-stats` | read | venue | partial | commissions:read | - | controller.getStaffCommissionStats |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/staff/:staffId/commissions` | read | venue | partial | commissions:read | - | controller.getStaffCommissions |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/staff/:staffId/milestone-progress` | read | venue | partial | commissions:read | - | controller.getStaffMilestoneProgress |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/staff/:staffId/overrides` | read | venue | partial | commissions:read | - | controller.getStaffOverrides |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/staff/:staffId/payouts` | read | venue | partial | commissions:payout | - | controller.getStaffPayouts |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/staff/:staffId/pending-clawbacks` | read | venue | partial | commissions:read | - | controller.getPendingClawbacksForStaff |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/staff/:staffId/tier-progress` | read | venue | partial | commissions:read | - | controller.getStaffTierProgress |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/stats` | read | venue | partial | commissions:read | - | controller.getVenueStats |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/summaries` | read | venue | partial | commissions:read | - | controller.getSummaries |
| GET | `/api/v1/dashboard/commissions/venues/:venueId/summaries/:summaryId` | read | venue | partial | commissions:read | - | controller.getSummaryById |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/summaries/:summaryId/approve` | dangerousMutation | venue | partial | commissions:approve | - | controller.approveSummary |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/summaries/:summaryId/deduction` | action | venue | partial | commissions:update | - | controller.applyDeduction |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/summaries/:summaryId/dispute` | action | venue | partial | commissions:view_own | - | controller.disputeSummary |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/summaries/:summaryId/recalculate` | action | venue | partial | commissions:update | - | controller.recalculateSummary |
| POST | `/api/v1/dashboard/commissions/venues/:venueId/summaries/bulk-approve` | dangerousMutation | venue | partial | commissions:approve | - | controller.bulkApproveSummaries |
| DELETE | `/api/v1/dashboard/commissions/venues/:venueId/tiers/:tierId` | dangerousMutation | venue | partial | commissions:delete | - | controller.deleteTier |
| PUT | `/api/v1/dashboard/commissions/venues/:venueId/tiers/:tierId` | mutation | venue | partial | commissions:update | - | controller.updateTier |
| GET | `/api/v1/dashboard/features` | read | unknown | missing | features:read | - | featureController.getAvailableFeatures |
| GET | `/api/v1/dashboard/impersonation/eligible-targets` | read | unknown | missing | - | - | impersonationController.eligibleTargetsHandler |
| POST | `/api/v1/dashboard/impersonation/extend` | dangerousMutation | unknown | missing | - | - | impersonationController.extendHandler |
| POST | `/api/v1/dashboard/impersonation/start` | dangerousMutation | unknown | missing | - | - | impersonationController.startHandler |
| GET | `/api/v1/dashboard/impersonation/status` | read | unknown | missing | - | - | impersonationController.statusHandler |
| POST | `/api/v1/dashboard/impersonation/stop` | dangerousMutation | unknown | missing | - | - | impersonationController.stopHandler |
| GET | `/api/v1/dashboard/integrations/google/callback` | read | unknown | missing | - | - | googleIntegrationController.handleGoogleCallback |
| GET | `/api/v1/dashboard/notifications` | read | unknown | missing | - | - | notificationController.getUserNotifications |
| POST | `/api/v1/dashboard/notifications` | action | unknown | missing | notifications:send | - | notificationController.createNotification |
| DELETE | `/api/v1/dashboard/notifications/:id` | dangerousMutation | unknown | missing | - | - | notificationController.deleteNotification |
| PATCH | `/api/v1/dashboard/notifications/:id/read` | mutation | unknown | missing | - | - | notificationController.markAsRead |
| POST | `/api/v1/dashboard/notifications/bulk` | dangerousMutation | unknown | missing | notifications:send | - | notificationController.sendBulkNotification |
| PATCH | `/api/v1/dashboard/notifications/mark-all-read` | mutation | unknown | missing | - | - | notificationController.markAllAsRead |
| GET | `/api/v1/dashboard/notifications/preferences` | read | unknown | missing | - | - | notificationController.getPreferences |
| PUT | `/api/v1/dashboard/notifications/preferences` | mutation | unknown | missing | - | - | notificationController.updatePreferences |
| PUT | `/api/v1/dashboard/notifications/preferences/bulk` | dangerousMutation | unknown | missing | - | - | notificationController.updatePreferencesBulk |
| GET | `/api/v1/dashboard/notifications/types` | read | unknown | missing | - | - | notificationController.getNotificationTypes |
| GET | `/api/v1/dashboard/notifications/unread-count` | read | unknown | missing | - | - | notificationController.getUnreadCount |
| POST | `/api/v1/dashboard/notifications/venue/:venueId` | action | unknown | missing | notifications:send | - | notificationController.sendVenueNotification |
| GET | `/api/v1/dashboard/organizations/:orgId/activity-feed` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/activity-log` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/activity-log/actions` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/anomalies` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/cash-out/active-days` | read | organization | missing | - | listActiveDaysSchema | ctrl.getOrgActiveDays |
| PUT | `/api/v1/dashboard/organizations/:orgId/cash-out/active-days` | mutation | organization | missing | - | setActiveDaysSchema | ctrl.putOrgActiveDays |
| GET | `/api/v1/dashboard/organizations/:orgId/cash-out/commission-rates` | read | organization | missing | - | - | ctrl.getOrgCommissionRates |
| PUT | `/api/v1/dashboard/organizations/:orgId/cash-out/commission-rates` | mutation | organization | missing | - | replaceCommissionRatesSchema | ctrl.putOrgCommissionRates |
| POST | `/api/v1/dashboard/organizations/:orgId/cash-out/report` | action | organization | missing | - | generateReportSchema | ctrl.postOrgReport |
| GET | `/api/v1/dashboard/organizations/:orgId/cash-out/withdrawals` | read | organization | missing | - | listWithdrawalsSchema | ctrl.getOrgWithdrawals |
| GET | `/api/v1/dashboard/organizations/:orgId/charts/revenue-vs-target` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/charts/volume-vs-target` | read | organization | missing | - | - | (inline handler) |
| PUT | `/api/v1/dashboard/organizations/:orgId/goals` | mutation | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/insights/top-promoter` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/insights/worst-attendance` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/managers` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/managers/:managerId` | read | organization | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/organizations/:orgId/manual-sales` | action | organization | partial | manual-sales:create | z.object | manualSaleController.apply |
| POST | `/api/v1/dashboard/organizations/:orgId/manual-sales/preview` | action | organization | partial | manual-sales:create | z.object | manualSaleController.preview |
| GET | `/api/v1/dashboard/organizations/:orgId/merchant-accounts` | read | organization | missing | - | GetOrgMerchantAccountsSchema | (inline handler) |
| POST | `/api/v1/dashboard/organizations/:orgId/messages/broadcast` | action | organization | missing | - | - | (inline handler) |
| DELETE | `/api/v1/dashboard/organizations/:orgId/org-attendance-config` | dangerousMutation | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/org-attendance-config` | read | organization | missing | - | - | (inline handler) |
| PUT | `/api/v1/dashboard/organizations/:orgId/org-attendance-config` | mutation | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/org-categories` | read | organization | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/organizations/:orgId/org-categories` | action | organization | missing | - | - | (inline handler) |
| DELETE | `/api/v1/dashboard/organizations/:orgId/org-categories/:categoryId` | dangerousMutation | organization | missing | - | - | (inline handler) |
| PUT | `/api/v1/dashboard/organizations/:orgId/org-categories/:categoryId` | mutation | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/org-goals` | read | organization | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/organizations/:orgId/org-goals` | action | organization | missing | - | - | (inline handler) |
| DELETE | `/api/v1/dashboard/organizations/:orgId/org-goals/:goalId` | dangerousMutation | organization | missing | - | - | (inline handler) |
| PATCH | `/api/v1/dashboard/organizations/:orgId/org-goals/:goalId` | mutation | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/org-tpv-defaults` | read | organization | missing | - | - | (inline handler) |
| PUT | `/api/v1/dashboard/organizations/:orgId/org-tpv-defaults` | mutation | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/org-tpv-defaults/stats` | read | organization | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/pending-stock-approvals` | read | organization | partial | sim-custody:approve-registration | - | listStockApprovals |
| POST | `/api/v1/dashboard/organizations/:orgId/pending-stock-approvals/approve` | dangerousMutation | organization | partial | sim-custody:approve-registration | - | approveStockItems |
| GET | `/api/v1/dashboard/organizations/:orgId/pending-stock-approvals/count` | read | organization | partial | sim-custody:approve-registration | - | countStockApprovals |
| GET | `/api/v1/dashboard/organizations/:orgId/promoter-location-settings` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/promoters` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/reports/closing-report` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/reports/closing-report/export` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/sale-verifications` | read | organization | missing | sale-verifications:review | - | ctrl.listOrgSaleVerifications |
| PATCH | `/api/v1/dashboard/organizations/:orgId/sale-verifications/:id` | mutation | organization | missing | sale-verifications:edit | - | ctrl.editOrgSaleVerification |
| POST | `/api/v1/dashboard/organizations/:orgId/sale-verifications/:id/reopen` | action | organization | missing | sale-verifications:reopen | - | ctrl.reopenOrgSaleVerification |
| PATCH | `/api/v1/dashboard/organizations/:orgId/sale-verifications/:id/review` | mutation | organization | missing | sale-verifications:review | - | ctrl.reviewOrgSaleVerification |
| GET | `/api/v1/dashboard/organizations/:orgId/sale-verifications/by-city` | read | organization | missing | sale-verifications:review | - | ctrl.getSalesByCity |
| GET | `/api/v1/dashboard/organizations/:orgId/sale-verifications/by-month` | read | organization | missing | sale-verifications:review | - | ctrl.getSalesByMonth |
| GET | `/api/v1/dashboard/organizations/:orgId/sale-verifications/by-promoter` | read | organization | missing | sale-verifications:review | - | ctrl.getSalesByPromoter |
| GET | `/api/v1/dashboard/organizations/:orgId/sale-verifications/by-promoter-daily` | read | organization | missing | sale-verifications:review | - | ctrl.getSalesByPromoterDaily |
| GET | `/api/v1/dashboard/organizations/:orgId/sale-verifications/by-sale-type-weekly` | read | organization | missing | sale-verifications:review | - | ctrl.getSalesBySaleTypeWeekly |
| GET | `/api/v1/dashboard/organizations/:orgId/sale-verifications/by-sim-type` | read | organization | missing | sale-verifications:review | - | ctrl.getSalesBySimType |
| GET | `/api/v1/dashboard/organizations/:orgId/sale-verifications/by-sim-type-weekly` | read | organization | missing | sale-verifications:review | - | ctrl.getSalesBySimTypeWeekly |
| GET | `/api/v1/dashboard/organizations/:orgId/sale-verifications/by-store` | read | organization | missing | sale-verifications:review | - | ctrl.getSalesByStore |
| GET | `/api/v1/dashboard/organizations/:orgId/sale-verifications/by-supervisor` | read | organization | missing | sale-verifications:review | - | ctrl.getSalesBySupervisor |
| GET | `/api/v1/dashboard/organizations/:orgId/sale-verifications/by-week` | read | organization | missing | sale-verifications:review | - | ctrl.getSalesByWeek |
| GET | `/api/v1/dashboard/organizations/:orgId/sale-verifications/summary` | read | organization | partial | sale-verifications:review | - | ctrl.getOrgSalesSummary |
| POST | `/api/v1/dashboard/organizations/:orgId/sim-custody/assign-to-promoter` | action | organization | missing | sim-custody:assign-to-promoter | - | assignToPromoter |
| POST | `/api/v1/dashboard/organizations/:orgId/sim-custody/assign-to-promoter-direct` | action | organization | missing | sim-custody:assign-to-promoter-direct | - | assignToPromoterDirect |
| POST | `/api/v1/dashboard/organizations/:orgId/sim-custody/assign-to-supervisor` | action | organization | missing | sim-custody:assign-to-supervisor | - | assignToSupervisor |
| POST | `/api/v1/dashboard/organizations/:orgId/sim-custody/change-category` | action | organization | missing | serialized-inventory:change-category | - | changeCategory |
| POST | `/api/v1/dashboard/organizations/:orgId/sim-custody/collect-from-promoter` | action | organization | missing | sim-custody:collect-from-promoter | - | collectFromPromoter |
| POST | `/api/v1/dashboard/organizations/:orgId/sim-custody/collect-from-supervisor` | action | organization | missing | sim-custody:collect-from-supervisor | - | collectFromSupervisor |
| GET | `/api/v1/dashboard/organizations/:orgId/sim-custody/events` | read | organization | missing | - | - | listEvents |
| POST | `/api/v1/dashboard/organizations/:orgId/sim-custody/reassign-promoter` | action | organization | missing | sim-custody:reassign | - | reassignPromoter |
| GET | `/api/v1/dashboard/organizations/:orgId/sim-registration-requests` | read | organization | missing | sim-custody:approve-registration | - | listRequests |
| POST | `/api/v1/dashboard/organizations/:orgId/sim-registration-requests/:id/approve` | dangerousMutation | organization | missing | sim-custody:approve-registration | - | approveRequest |
| POST | `/api/v1/dashboard/organizations/:orgId/sim-registration-requests/:id/reject` | action | organization | missing | sim-custody:approve-registration | - | rejectRequest |
| GET | `/api/v1/dashboard/organizations/:orgId/sim-registration-requests/count` | read | organization | missing | sim-custody:approve-registration | - | countRequests |
| GET | `/api/v1/dashboard/organizations/:orgId/staff/:staffId/attendance-calendar` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/staff/:staffId/sales-mix` | read | organization | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/staff/:staffId/sales-trend` | read | organization | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/staff/attendance` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/staff/online` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/stock-control/export.xlsx` | read | organization | partial | - | - | exportOrgStockExcel |
| GET | `/api/v1/dashboard/organizations/:orgId/stock-control/overview` | read | organization | partial | - | - | getOrgStockOverview |
| GET | `/api/v1/dashboard/organizations/:orgId/stock-summary` | read | organization | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/store-performance` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/team` | read | organization | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/team/:staffId/activity` | read | organization | partial | - | - | (inline handler) |
| PATCH | `/api/v1/dashboard/organizations/:orgId/team/:staffId/employee-code` | mutation | organization | partial | - | - | (inline handler) |
| PATCH | `/api/v1/dashboard/organizations/:orgId/team/:staffId/pin` | mutation | organization | partial | - | - | (inline handler) |
| POST | `/api/v1/dashboard/organizations/:orgId/team/:staffId/reset-password` | dangerousMutation | organization | partial | - | - | (inline handler) |
| PATCH | `/api/v1/dashboard/organizations/:orgId/team/:staffId/role` | mutation | organization | partial | - | - | (inline handler) |
| PATCH | `/api/v1/dashboard/organizations/:orgId/team/:staffId/status` | mutation | organization | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/terminals` | read | organization | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/organizations/:orgId/terminals` | action | organization | missing | - | CreateOrgTerminalSchema | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/terminals-locations` | read | organization | missing | - | - | (inline handler) |
| DELETE | `/api/v1/dashboard/organizations/:orgId/terminals/:terminalId` | dangerousMutation | organization | missing | - | DeleteOrgTerminalSchema | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/terminals/:terminalId` | read | organization | missing | - | GetOrgTerminalSchema | (inline handler) |
| PATCH | `/api/v1/dashboard/organizations/:orgId/terminals/:terminalId` | mutation | organization | missing | - | UpdateOrgTerminalSchema | (inline handler) |
| POST | `/api/v1/dashboard/organizations/:orgId/terminals/:terminalId/command` | action | organization | missing | - | SendOrgCommandSchema | (inline handler) |
| POST | `/api/v1/dashboard/organizations/:orgId/terminals/:terminalId/generate-activation-code` | action | organization | missing | - | GenerateActivationCodeSchema | (inline handler) |
| PUT | `/api/v1/dashboard/organizations/:orgId/terminals/:terminalId/merchants` | mutation | organization | missing | - | AssignMerchantsSchema | (inline handler) |
| POST | `/api/v1/dashboard/organizations/:orgId/terminals/:terminalId/migrate-cancel` | dangerousMutation | organization | missing | - | orgMigrateCancelSchema | (inline handler) |
| POST | `/api/v1/dashboard/organizations/:orgId/terminals/:terminalId/migrate-execute` | action | organization | missing | - | orgMigrateExecuteSchema | (inline handler) |
| POST | `/api/v1/dashboard/organizations/:orgId/terminals/:terminalId/migrate-preflight` | action | organization | missing | - | orgMigratePreflightSchema | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/terminals/:terminalId/migrate-status` | read | organization | missing | - | orgMigrateStatusSchema | (inline handler) |
| POST | `/api/v1/dashboard/organizations/:orgId/terminals/:terminalId/remote-activate` | action | organization | missing | - | RemoteActivateSchema | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/terminals/app-versions` | read | organization | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/organizations/:orgId/terminals/bulk-command` | dangerousMutation | organization | missing | - | BulkCommandSchema | (inline handler) |
| PATCH | `/api/v1/dashboard/organizations/:orgId/time-entries/:timeEntryId/validate` | mutation | organization | missing | - | - | (inline handler) |
| PUT | `/api/v1/dashboard/organizations/:orgId/venues/:venueId/promoter-location-settings` | mutation | organization | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/organizations/:orgId/venues/:venueId/staff-access` | action | organization | missing | - | grantVenueAccessSchema | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/venues/:venueId/staff-access/candidates` | read | organization | missing | - | listCandidatesSchema | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/vision-global` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/zones` | read | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/organizations/:orgId/zones` | read | organization | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/organizations/:orgId/zones` | action | organization | missing | - | - | (inline handler) |
| DELETE | `/api/v1/dashboard/organizations/:orgId/zones/:zoneId` | dangerousMutation | organization | missing | - | - | (inline handler) |
| PUT | `/api/v1/dashboard/organizations/:orgId/zones/:zoneId` | mutation | organization | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/product-types` | read | unknown | partial | - | - | productController.getAllProductTypesHandler |
| GET | `/api/v1/dashboard/reports/pay-later-aging` | read | unknown | missing | tpv-reports:pay-later-aging | - | payLaterAgingReport |
| GET | `/api/v1/dashboard/reports/refunds` | read | unknown | missing | reports:read | - | refundsReport |
| GET | `/api/v1/dashboard/reports/sales-by-item` | read | unknown | partial | reports:read | - | salesByItemReport |
| GET | `/api/v1/dashboard/reports/sales-summary` | read | unknown | partial | reports:read | - | salesSummaryReport |
| GET | `/api/v1/dashboard/reports/sales-summary/export` | read | unknown | partial | reports:read | - | salesSummaryExport |
| GET | `/api/v1/dashboard/reports/venues/:venueId/pay-later-aging` | read | venue | missing | tpv-reports:pay-later-aging | - | payLaterAgingReport |
| GET | `/api/v1/dashboard/reports/venues/:venueId/sales-summary/export` | read | venue | partial | reports:read | - | salesSummaryExport |
| POST | `/api/v1/dashboard/reviews/:reviewId/generate-response` | action | unknown | covered | reviews:respond | - | reviewController.generateReviewResponse |
| POST | `/api/v1/dashboard/reviews/:reviewId/response-feedback` | action | unknown | covered | reviews:respond | - | reviewController.submitResponseFeedback |
| POST | `/api/v1/dashboard/reviews/:reviewId/submit-response` | action | unknown | covered | reviews:respond | - | reviewController.submitReviewResponse |
| GET | `/api/v1/dashboard/role-permissions/hierarchy` | read | unknown | partial | settings:manage | - | rolePermissionController.getRoleHierarchyInfo |
| GET | `/api/v1/dashboard/superadmin/aggregators` | adminOnly | superadmin | blocked | - | - | aggregatorController.getAggregators |
| POST | `/api/v1/dashboard/superadmin/aggregators` | adminOnly | superadmin | blocked | - | - | aggregatorController.createAggregator |
| DELETE | `/api/v1/dashboard/superadmin/aggregators/:id` | adminOnly | superadmin | blocked | - | - | aggregatorController.deleteAggregator |
| GET | `/api/v1/dashboard/superadmin/aggregators/:id` | adminOnly | superadmin | blocked | - | - | aggregatorController.getAggregatorById |
| PUT | `/api/v1/dashboard/superadmin/aggregators/:id` | adminOnly | superadmin | blocked | - | - | aggregatorController.updateAggregator |
| POST | `/api/v1/dashboard/superadmin/aggregators/:id/generate-token` | adminOnly | superadmin | blocked | - | - | aggregatorController.generateReportToken |
| DELETE | `/api/v1/dashboard/superadmin/aggregators/:id/revoke-token` | adminOnly | superadmin | blocked | - | - | aggregatorController.revokeReportToken |
| PATCH | `/api/v1/dashboard/superadmin/aggregators/:id/toggle` | adminOnly | superadmin | blocked | - | - | aggregatorController.toggleAggregator |
| GET | `/api/v1/dashboard/superadmin/balance-providers` | adminOnly | superadmin | blocked | - | - | balanceProviderController.getBalanceProviders |
| GET | `/api/v1/dashboard/superadmin/cost-structures/analysis` | adminOnly | superadmin | blocked | - | - | costManagementController.getCostStructureAnalysis |
| GET | `/api/v1/dashboard/superadmin/cost-structures/provider` | adminOnly | superadmin | blocked | - | providerCostStructuresQuerySchema | costManagementController.getProviderCostStructures |
| POST | `/api/v1/dashboard/superadmin/cost-structures/provider` | adminOnly | superadmin | blocked | - | providerCostStructureSchema | costManagementController.upsertProviderCostStructure |
| GET | `/api/v1/dashboard/superadmin/dashboard` | adminOnly | superadmin | blocked | - | - | superadminController.getDashboardData |
| GET | `/api/v1/dashboard/superadmin/ecommerce-merchants` | adminOnly | superadmin | blocked | - | - | ecommerceMerchantsSuperadminController.listAllEcommerceMerchants |
| DELETE | `/api/v1/dashboard/superadmin/ecommerce-merchants/:id` | adminOnly | superadmin | blocked | - | - | ecommerceMerchantsSuperadminController.deleteEcommerceMerchant |
| GET | `/api/v1/dashboard/superadmin/ecommerce-merchants/:id/fee-history` | adminOnly | superadmin | blocked | - | - | ecommerceMerchantsSuperadminController.getMerchantFeeHistory |
| GET | `/api/v1/dashboard/superadmin/features` | adminOnly | superadmin | blocked | - | - | superadminController.getAllFeatures |
| POST | `/api/v1/dashboard/superadmin/features` | adminOnly | superadmin | blocked | - | createFeatureSchema | superadminController.createFeature |
| GET | `/api/v1/dashboard/superadmin/kyc/:venueId` | adminOnly | superadmin | blocked | - | kycReviewSchema.GetKycDetailsSchema | asyncHandler(kycReviewController.getKycDetails) |
| POST | `/api/v1/dashboard/superadmin/kyc/:venueId/approve` | adminOnly | superadmin | blocked | - | - | asyncHandler(kycReviewController.approveKyc) |
| POST | `/api/v1/dashboard/superadmin/kyc/:venueId/assign-processor` | adminOnly | superadmin | blocked | - | kycReviewSchema.AssignProcessorSchema | asyncHandler(kycReviewController.assignProcessorAndApprove) |
| POST | `/api/v1/dashboard/superadmin/kyc/:venueId/mark-in-review` | adminOnly | superadmin | blocked | - | kycReviewSchema.MarkKycInReviewSchema | asyncHandler(kycReviewController.markInReview) |
| POST | `/api/v1/dashboard/superadmin/kyc/:venueId/reject` | adminOnly | superadmin | blocked | - | kycReviewSchema.RejectKycSchema | asyncHandler(kycReviewController.rejectKyc) |
| GET | `/api/v1/dashboard/superadmin/kyc/pending` | adminOnly | superadmin | blocked | - | - | asyncHandler(kycReviewController.listPendingKyc) |
| GET | `/api/v1/dashboard/superadmin/marketing/campaigns` | adminOnly | superadmin | blocked | - | - | marketingController.listCampaigns |
| POST | `/api/v1/dashboard/superadmin/marketing/campaigns` | adminOnly | superadmin | blocked | - | - | marketingController.createCampaign |
| DELETE | `/api/v1/dashboard/superadmin/marketing/campaigns/:id` | adminOnly | superadmin | blocked | - | - | marketingController.deleteCampaign |
| GET | `/api/v1/dashboard/superadmin/marketing/campaigns/:id` | adminOnly | superadmin | blocked | - | - | marketingController.getCampaign |
| PATCH | `/api/v1/dashboard/superadmin/marketing/campaigns/:id` | adminOnly | superadmin | blocked | - | - | marketingController.updateCampaign |
| POST | `/api/v1/dashboard/superadmin/marketing/campaigns/:id/cancel` | adminOnly | superadmin | blocked | - | - | marketingController.cancelCampaign |
| GET | `/api/v1/dashboard/superadmin/marketing/campaigns/:id/deliveries` | adminOnly | superadmin | blocked | - | - | marketingController.getCampaignDeliveries |
| POST | `/api/v1/dashboard/superadmin/marketing/campaigns/:id/send` | adminOnly | superadmin | blocked | - | - | marketingController.sendCampaign |
| DELETE | `/api/v1/dashboard/superadmin/marketing/campaigns/bulk` | adminOnly | superadmin | blocked | - | - | marketingController.bulkDeleteCampaigns |
| POST | `/api/v1/dashboard/superadmin/marketing/recipients/preview` | adminOnly | superadmin | blocked | - | - | marketingController.previewRecipients |
| GET | `/api/v1/dashboard/superadmin/marketing/templates` | adminOnly | superadmin | blocked | - | - | marketingController.listTemplates |
| POST | `/api/v1/dashboard/superadmin/marketing/templates` | adminOnly | superadmin | blocked | - | - | marketingController.createTemplate |
| DELETE | `/api/v1/dashboard/superadmin/marketing/templates/:id` | adminOnly | superadmin | blocked | - | - | marketingController.deleteTemplate |
| GET | `/api/v1/dashboard/superadmin/marketing/templates/:id` | adminOnly | superadmin | blocked | - | - | marketingController.getTemplate |
| PATCH | `/api/v1/dashboard/superadmin/marketing/templates/:id` | adminOnly | superadmin | blocked | - | - | marketingController.updateTemplate |
| GET | `/api/v1/dashboard/superadmin/master-totp/setup` | adminOnly | superadmin | blocked | - | - | superadminController.getMasterTotpSetup |
| GET | `/api/v1/dashboard/superadmin/merchant-accounts` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getMerchantAccounts |
| POST | `/api/v1/dashboard/superadmin/merchant-accounts` | adminOnly | superadmin | blocked | - | - | merchantAccountController.createMerchantAccount |
| DELETE | `/api/v1/dashboard/superadmin/merchant-accounts/:id` | adminOnly | superadmin | blocked | - | - | merchantAccountController.deleteMerchantAccount |
| GET | `/api/v1/dashboard/superadmin/merchant-accounts/:id` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getMerchantAccount |
| PUT | `/api/v1/dashboard/superadmin/merchant-accounts/:id` | adminOnly | superadmin | blocked | - | - | merchantAccountController.updateMerchantAccount |
| GET | `/api/v1/dashboard/superadmin/merchant-accounts/:id/assignable-terminals` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getAssignableTerminals |
| GET | `/api/v1/dashboard/superadmin/merchant-accounts/:id/balance` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getBalance |
| POST | `/api/v1/dashboard/superadmin/merchant-accounts/:id/batch-assign-terminals` | adminOnly | superadmin | blocked | - | - | merchantAccountController.batchAssignTerminals |
| GET | `/api/v1/dashboard/superadmin/merchant-accounts/:id/blockers` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getMerchantAccountBlockers |
| POST | `/api/v1/dashboard/superadmin/merchant-accounts/:id/blumon/refetch` | adminOnly | superadmin | blocked | - | - | merchantAccountController.refetchBlumonMerchantCredentials |
| GET | `/api/v1/dashboard/superadmin/merchant-accounts/:id/credentials` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getMerchantAccountCredentials |
| GET | `/api/v1/dashboard/superadmin/merchant-accounts/:id/terminals` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getTerminalsByMerchantAccount |
| DELETE | `/api/v1/dashboard/superadmin/merchant-accounts/:id/terminals/:terminalId` | adminOnly | superadmin | blocked | - | - | merchantAccountController.removeMerchantFromTerminal |
| PUT | `/api/v1/dashboard/superadmin/merchant-accounts/:id/terminals/:terminalId` | adminOnly | superadmin | blocked | - | - | merchantAccountController.setTerminalServesMerchant |
| PATCH | `/api/v1/dashboard/superadmin/merchant-accounts/:id/toggle` | adminOnly | superadmin | blocked | - | - | merchantAccountController.toggleMerchantAccountStatus |
| POST | `/api/v1/dashboard/superadmin/merchant-accounts/blumon/auto-fetch` | adminOnly | superadmin | blocked | - | - | merchantAccountController.autoFetchBlumonCredentials |
| POST | `/api/v1/dashboard/superadmin/merchant-accounts/blumon/batch-auto-fetch` | adminOnly | superadmin | blocked | - | - | merchantAccountController.batchAutoFetchBlumonCredentials |
| POST | `/api/v1/dashboard/superadmin/merchant-accounts/blumon/full-setup` | adminOnly | superadmin | blocked | - | - | merchantAccountController.fullSetupBlumonMerchant |
| POST | `/api/v1/dashboard/superadmin/merchant-accounts/blumon/register` | adminOnly | superadmin | blocked | - | - | merchantAccountController.registerBlumonMerchant |
| POST | `/api/v1/dashboard/superadmin/merchant-accounts/full-setup-angelpay` | adminOnly | superadmin | blocked | - | - | merchantAccountController.fullSetupAngelPayMerchant |
| GET | `/api/v1/dashboard/superadmin/merchant-accounts/list` | adminOnly | superadmin | blocked | - | merchantAccountsQuerySchema | superadminController.getMerchantAccountsList |
| GET | `/api/v1/dashboard/superadmin/merchant-accounts/mcc-lookup` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getMccRateSuggestion |
| GET | `/api/v1/dashboard/superadmin/merchant-accounts/payment-setup/summary` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getPaymentSetupSummary |
| POST | `/api/v1/dashboard/superadmin/merchant-accounts/with-cost-structure` | adminOnly | superadmin | blocked | - | - | merchantAccountController.createMerchantAccountWithCostStructure |
| GET | `/api/v1/dashboard/superadmin/merchant-revenue-shares` | adminOnly | superadmin | blocked | - | - | controller.getMerchantRevenueShares |
| POST | `/api/v1/dashboard/superadmin/merchant-revenue-shares` | adminOnly | superadmin | blocked | - | - | controller.createMerchantRevenueShare |
| DELETE | `/api/v1/dashboard/superadmin/merchant-revenue-shares/:id` | adminOnly | superadmin | blocked | - | - | controller.deleteMerchantRevenueShare |
| GET | `/api/v1/dashboard/superadmin/merchant-revenue-shares/:id` | adminOnly | superadmin | blocked | - | - | controller.getMerchantRevenueShareById |
| PUT | `/api/v1/dashboard/superadmin/merchant-revenue-shares/:id` | adminOnly | superadmin | blocked | - | - | controller.updateMerchantRevenueShare |
| GET | `/api/v1/dashboard/superadmin/merchant-revenue-shares/by-merchant` | adminOnly | superadmin | blocked | - | - | controller.getMerchantRevenueShareByMerchant |
| GET | `/api/v1/dashboard/superadmin/merchant-revenue-shares/report` | adminOnly | superadmin | blocked | - | - | controller.getRevenueShareReport |
| GET | `/api/v1/dashboard/superadmin/modules` | adminOnly | superadmin | blocked | - | - | moduleController.getAllModules |
| POST | `/api/v1/dashboard/superadmin/modules` | adminOnly | superadmin | blocked | - | createModuleSchema | moduleController.createModule |
| GET | `/api/v1/dashboard/superadmin/modules/:moduleCode/venues` | adminOnly | superadmin | blocked | - | moduleCodeSchema | moduleController.getVenuesForModule |
| DELETE | `/api/v1/dashboard/superadmin/modules/:moduleId` | adminOnly | superadmin | blocked | - | moduleIdSchema | moduleController.deleteModule |
| PATCH | `/api/v1/dashboard/superadmin/modules/:moduleId` | adminOnly | superadmin | blocked | - | updateModuleSchema | moduleController.updateModule |
| PATCH | `/api/v1/dashboard/superadmin/modules/config` | adminOnly | superadmin | blocked | - | updateConfigSchema | moduleController.updateModuleConfig |
| POST | `/api/v1/dashboard/superadmin/modules/disable` | adminOnly | superadmin | blocked | - | disableModuleSchema | moduleController.disableModuleForVenue |
| POST | `/api/v1/dashboard/superadmin/modules/enable` | adminOnly | superadmin | blocked | - | enableModuleSchema | moduleController.enableModuleForVenue |
| DELETE | `/api/v1/dashboard/superadmin/modules/venue-override` | adminOnly | superadmin | blocked | - | deleteVenueOverrideSchema | moduleController.deleteVenueModuleOverride |
| GET | `/api/v1/dashboard/superadmin/modules/venues/:venueId` | adminOnly | superadmin | blocked | - | venueIdSchema | moduleController.getModulesForVenue |
| GET | `/api/v1/dashboard/superadmin/organizations` | adminOnly | superadmin | blocked | - | - | organizationController.getAllOrganizations |
| POST | `/api/v1/dashboard/superadmin/organizations` | adminOnly | superadmin | blocked | - | createOrganizationSchema | organizationController.createOrganization |
| DELETE | `/api/v1/dashboard/superadmin/organizations/:organizationId` | adminOnly | superadmin | blocked | - | organizationIdSchema | organizationController.deleteOrganization |
| GET | `/api/v1/dashboard/superadmin/organizations/:organizationId` | adminOnly | superadmin | blocked | - | organizationIdSchema | organizationController.getOrganizationById |
| PATCH | `/api/v1/dashboard/superadmin/organizations/:organizationId` | adminOnly | superadmin | blocked | - | updateOrganizationSchema | organizationController.updateOrganization |
| GET | `/api/v1/dashboard/superadmin/organizations/:organizationId/modules` | adminOnly | superadmin | blocked | - | organizationIdSchema | organizationController.getModulesForOrganization |
| PATCH | `/api/v1/dashboard/superadmin/organizations/:organizationId/modules/config` | adminOnly | superadmin | blocked | - | updateModuleConfigSchema | organizationController.updateOrganizationModuleConfig |
| POST | `/api/v1/dashboard/superadmin/organizations/:organizationId/modules/disable` | adminOnly | superadmin | blocked | - | disableModuleSchema | organizationController.disableModuleForOrganization |
| POST | `/api/v1/dashboard/superadmin/organizations/:organizationId/modules/enable` | adminOnly | superadmin | blocked | - | enableModuleSchema | organizationController.enableModuleForOrganization |
| DELETE | `/api/v1/dashboard/superadmin/organizations/:organizationId/payment-config` | adminOnly | superadmin | blocked | - | organizationIdSchema | orgPaymentController.deletePaymentConfig |
| GET | `/api/v1/dashboard/superadmin/organizations/:organizationId/payment-config` | adminOnly | superadmin | blocked | - | organizationIdSchema | orgPaymentController.getPaymentConfig |
| PUT | `/api/v1/dashboard/superadmin/organizations/:organizationId/payment-config` | adminOnly | superadmin | blocked | - | setPaymentConfigSchema | orgPaymentController.setPaymentConfig |
| PUT | `/api/v1/dashboard/superadmin/organizations/:organizationId/payment-config/pricing` | adminOnly | superadmin | blocked | - | setPricingSchema | orgPaymentController.setPricing |
| DELETE | `/api/v1/dashboard/superadmin/organizations/:organizationId/payment-config/pricing/:pricingId` | adminOnly | superadmin | blocked | - | deletePricingSchema | orgPaymentController.deletePricing |
| GET | `/api/v1/dashboard/superadmin/organizations/:organizationId/payment-config/venues` | adminOnly | superadmin | blocked | - | organizationIdSchema | orgPaymentController.getVenueInheritance |
| GET | `/api/v1/dashboard/superadmin/organizations/list` | adminOnly | superadmin | blocked | - | - | organizationController.getOrganizationsListSimple |
| GET | `/api/v1/dashboard/superadmin/payment-analytics/export` | adminOnly | superadmin | blocked | - | - | paymentAnalyticsController.exportProfitData |
| GET | `/api/v1/dashboard/superadmin/payment-analytics/profit-metrics` | adminOnly | superadmin | blocked | - | - | paymentAnalyticsController.getProfitMetrics |
| GET | `/api/v1/dashboard/superadmin/payment-analytics/provider-comparison` | adminOnly | superadmin | blocked | - | - | paymentAnalyticsController.getProviderComparison |
| GET | `/api/v1/dashboard/superadmin/payment-analytics/time-series` | adminOnly | superadmin | blocked | - | - | paymentAnalyticsController.getProfitTimeSeries |
| GET | `/api/v1/dashboard/superadmin/payment-analytics/venue/:venueId` | adminOnly | superadmin | blocked | - | - | paymentAnalyticsController.getVenueProfitMetrics |
| GET | `/api/v1/dashboard/superadmin/payment-providers` | adminOnly | superadmin | blocked | - | - | paymentProviderController.getPaymentProviders |
| POST | `/api/v1/dashboard/superadmin/payment-providers` | adminOnly | superadmin | blocked | - | - | paymentProviderController.createPaymentProvider |
| DELETE | `/api/v1/dashboard/superadmin/payment-providers/:id` | adminOnly | superadmin | blocked | - | - | paymentProviderController.deletePaymentProvider |
| GET | `/api/v1/dashboard/superadmin/payment-providers/:id` | adminOnly | superadmin | blocked | - | - | paymentProviderController.getPaymentProvider |
| PUT | `/api/v1/dashboard/superadmin/payment-providers/:id` | adminOnly | superadmin | blocked | - | - | paymentProviderController.updatePaymentProvider |
| GET | `/api/v1/dashboard/superadmin/payment-providers/:id/blockers` | adminOnly | superadmin | blocked | - | - | paymentProviderController.getPaymentProviderBlockers |
| PATCH | `/api/v1/dashboard/superadmin/payment-providers/:id/toggle` | adminOnly | superadmin | blocked | - | - | paymentProviderController.togglePaymentProviderStatus |
| GET | `/api/v1/dashboard/superadmin/payment-providers/code/:code` | adminOnly | superadmin | blocked | - | - | paymentProviderController.getPaymentProviderByCode |
| GET | `/api/v1/dashboard/superadmin/payment-readiness` | adminOnly | superadmin | blocked | - | - | venuePaymentReadinessController.getMultipleVenuesPaymentReadiness |
| GET | `/api/v1/dashboard/superadmin/platform-settings` | adminOnly | superadmin | blocked | - | - | platformSettingsController.getPlatformSettings |
| PATCH | `/api/v1/dashboard/superadmin/platform-settings` | adminOnly | superadmin | blocked | - | - | platformSettingsController.updatePlatformSettings |
| GET | `/api/v1/dashboard/superadmin/pricing-structures/venue` | adminOnly | superadmin | blocked | - | venuePricingStructuresQuerySchema | costManagementController.getVenuePricingStructures |
| POST | `/api/v1/dashboard/superadmin/pricing-structures/venue` | adminOnly | superadmin | blocked | - | venuePricingStructureSchema | costManagementController.upsertVenuePricingStructure |
| GET | `/api/v1/dashboard/superadmin/profit/export` | adminOnly | superadmin | blocked | - | exportProfitDataQuerySchema | costManagementController.exportProfitData |
| GET | `/api/v1/dashboard/superadmin/profit/metrics` | adminOnly | superadmin | blocked | - | profitMetricsQuerySchema | costManagementController.getProfitMetrics |
| GET | `/api/v1/dashboard/superadmin/profit/monthly` | adminOnly | superadmin | blocked | - | monthlyProfitsQuerySchema | costManagementController.getMonthlyProfits |
| PATCH | `/api/v1/dashboard/superadmin/profit/monthly/:monthlyProfitId/status` | adminOnly | superadmin | blocked | - | updateMonthlyProfitStatusSchema | costManagementController.updateMonthlyProfitStatus |
| POST | `/api/v1/dashboard/superadmin/profit/recalculate` | adminOnly | superadmin | blocked | - | recalculateProfitsSchema | costManagementController.recalculateProfits |
| GET | `/api/v1/dashboard/superadmin/provider-cost-structures` | adminOnly | superadmin | blocked | - | - | providerCostStructureController.getProviderCostStructures |
| POST | `/api/v1/dashboard/superadmin/provider-cost-structures` | adminOnly | superadmin | blocked | - | - | providerCostStructureController.createProviderCostStructure |
| DELETE | `/api/v1/dashboard/superadmin/provider-cost-structures/:id` | adminOnly | superadmin | blocked | - | - | providerCostStructureController.deleteProviderCostStructure |
| GET | `/api/v1/dashboard/superadmin/provider-cost-structures/:id` | adminOnly | superadmin | blocked | - | - | providerCostStructureController.getProviderCostStructure |
| PUT | `/api/v1/dashboard/superadmin/provider-cost-structures/:id` | adminOnly | superadmin | blocked | - | - | providerCostStructureController.updateProviderCostStructure |
| PATCH | `/api/v1/dashboard/superadmin/provider-cost-structures/:id/deactivate` | adminOnly | superadmin | blocked | - | - | providerCostStructureController.deactivateCostStructure |
| GET | `/api/v1/dashboard/superadmin/provider-cost-structures/active/:merchantAccountId` | adminOnly | superadmin | blocked | - | - | providerCostStructureController.getActiveCostStructure |
| POST | `/api/v1/dashboard/superadmin/provider-cost-structures/flat-rate` | adminOnly | superadmin | blocked | - | - | providerCostStructureController.createFlatRateCostStructure |
| GET | `/api/v1/dashboard/superadmin/providers` | adminOnly | superadmin | blocked | - | - | superadminController.getProvidersList |
| POST | `/api/v1/dashboard/superadmin/push-notifications/send-test` | adminOnly | superadmin | blocked | - | - | pushNotificationsController.sendTestNotification |
| GET | `/api/v1/dashboard/superadmin/push-notifications/staff-devices` | adminOnly | superadmin | blocked | - | - | pushNotificationsController.getStaffWithDevices |
| GET | `/api/v1/dashboard/superadmin/push-notifications/stats` | adminOnly | superadmin | blocked | - | - | pushNotificationsController.getPushStats |
| GET | `/api/v1/dashboard/superadmin/revenue/breakdown` | adminOnly | superadmin | blocked | - | - | superadminController.getRevenueBreakdown |
| GET | `/api/v1/dashboard/superadmin/revenue/metrics` | adminOnly | superadmin | blocked | - | - | superadminController.getRevenueMetrics |
| GET | `/api/v1/dashboard/superadmin/server-metrics` | adminOnly | superadmin | blocked | - | - | serverMetricsController.getServerMetrics |
| GET | `/api/v1/dashboard/superadmin/settlement-configurations` | adminOnly | public | blocked | - | - | settlementConfigController.getSettlementConfigurations |
| POST | `/api/v1/dashboard/superadmin/settlement-configurations` | adminOnly | public | blocked | - | - | settlementConfigController.createSettlementConfiguration |
| DELETE | `/api/v1/dashboard/superadmin/settlement-configurations/:id` | adminOnly | public | blocked | - | - | settlementConfigController.deleteSettlementConfiguration |
| GET | `/api/v1/dashboard/superadmin/settlement-configurations/:id` | adminOnly | public | blocked | - | - | settlementConfigController.getSettlementConfiguration |
| PUT | `/api/v1/dashboard/superadmin/settlement-configurations/:id` | adminOnly | public | blocked | - | - | settlementConfigController.updateSettlementConfiguration |
| GET | `/api/v1/dashboard/superadmin/settlement-configurations/active/:merchantAccountId/:cardType` | adminOnly | public | blocked | - | - | settlementConfigController.getActiveConfiguration |
| POST | `/api/v1/dashboard/superadmin/settlement-configurations/bulk` | adminOnly | public | blocked | - | - | settlementConfigController.bulkCreateSettlementConfigurations |
| GET | `/api/v1/dashboard/superadmin/settlement-incidents` | adminOnly | public | blocked | system:manage | incidentListQuerySchema | settlementIncidentController.getAllIncidents |
| POST | `/api/v1/dashboard/superadmin/settlement-incidents/:incidentId/escalate` | adminOnly | public | blocked | system:manage | escalateIncidentSchema | settlementIncidentController.escalateIncident |
| GET | `/api/v1/dashboard/superadmin/settlement-incidents/stats` | adminOnly | public | blocked | system:manage | - | settlementIncidentController.getGlobalIncidentStats |
| GET | `/api/v1/dashboard/superadmin/staff` | adminOnly | superadmin | blocked | - | listStaffQuerySchema | staffController.listStaff |
| POST | `/api/v1/dashboard/superadmin/staff` | adminOnly | superadmin | blocked | - | createStaffSchema | staffController.createStaff |
| DELETE | `/api/v1/dashboard/superadmin/staff/:staffId` | adminOnly | superadmin | blocked | - | staffIdParamSchema | staffController.deleteStaff |
| GET | `/api/v1/dashboard/superadmin/staff/:staffId` | adminOnly | superadmin | blocked | - | staffIdParamSchema | staffController.getStaffById |
| PATCH | `/api/v1/dashboard/superadmin/staff/:staffId` | adminOnly | superadmin | blocked | - | updateStaffSchema | staffController.updateStaff |
| POST | `/api/v1/dashboard/superadmin/staff/:staffId/organizations` | adminOnly | superadmin | blocked | - | assignOrgSchema | staffController.assignToOrganization |
| DELETE | `/api/v1/dashboard/superadmin/staff/:staffId/organizations/:organizationId` | adminOnly | superadmin | blocked | - | removeOrgSchema | staffController.removeFromOrganization |
| POST | `/api/v1/dashboard/superadmin/staff/:staffId/reset-password` | adminOnly | superadmin | blocked | - | resetPasswordSchema | staffController.resetPassword |
| POST | `/api/v1/dashboard/superadmin/staff/:staffId/venues` | adminOnly | superadmin | blocked | - | assignVenueSchema | staffController.assignToVenue |
| DELETE | `/api/v1/dashboard/superadmin/staff/:staffId/venues/:venueId` | adminOnly | superadmin | blocked | - | staffVenueParamSchema | staffController.removeFromVenue |
| PATCH | `/api/v1/dashboard/superadmin/staff/:staffId/venues/:venueId` | adminOnly | superadmin | blocked | - | updateVenueAssignmentSchema | staffController.updateVenueAssignment |
| GET | `/api/v1/dashboard/superadmin/terminals` | adminOnly | superadmin | blocked | - | terminalQuerySchema | terminalController.getAllTerminals |
| POST | `/api/v1/dashboard/superadmin/terminals` | adminOnly | superadmin | blocked | - | createTerminalSchema | terminalController.createTerminal |
| DELETE | `/api/v1/dashboard/superadmin/terminals/:terminalId` | adminOnly | superadmin | blocked | - | terminalIdSchema | terminalController.deleteTerminal |
| GET | `/api/v1/dashboard/superadmin/terminals/:terminalId` | adminOnly | superadmin | blocked | - | terminalIdSchema | terminalController.getTerminalById |
| PATCH | `/api/v1/dashboard/superadmin/terminals/:terminalId` | adminOnly | superadmin | blocked | - | updateTerminalSchema | terminalController.updateTerminal |
| POST | `/api/v1/dashboard/superadmin/terminals/:terminalId/generate-activation-code` | adminOnly | superadmin | blocked | - | terminalIdSchema | terminalController.generateActivationCode |
| POST | `/api/v1/dashboard/superadmin/terminals/:terminalId/migrate-cancel` | adminOnly | superadmin | blocked | - | migrateCancelSchema | migrationController.cancel |
| POST | `/api/v1/dashboard/superadmin/terminals/:terminalId/migrate-execute` | adminOnly | superadmin | blocked | - | migrateExecuteSchema | migrationController.execute |
| POST | `/api/v1/dashboard/superadmin/terminals/:terminalId/migrate-preflight` | adminOnly | superadmin | blocked | - | migratePreflightSchema | migrationController.preflight |
| GET | `/api/v1/dashboard/superadmin/terminals/:terminalId/migrate-status` | adminOnly | superadmin | blocked | - | migrateStatusSchema | migrationController.status |
| POST | `/api/v1/dashboard/superadmin/terminals/:terminalId/remote-activate` | adminOnly | superadmin | blocked | - | terminalIdSchema | terminalController.sendRemoteActivation |
| GET | `/api/v1/dashboard/superadmin/trainings` | adminOnly | superadmin | blocked | - | listTrainingsQuerySchema | trainingController.listTrainings |
| POST | `/api/v1/dashboard/superadmin/trainings` | adminOnly | superadmin | blocked | - | createTrainingSchema | trainingController.createTraining |
| DELETE | `/api/v1/dashboard/superadmin/trainings/:trainingId` | adminOnly | superadmin | blocked | - | trainingIdParamSchema | trainingController.deleteTraining |
| GET | `/api/v1/dashboard/superadmin/trainings/:trainingId` | adminOnly | superadmin | blocked | - | trainingIdParamSchema | trainingController.getTraining |
| PATCH | `/api/v1/dashboard/superadmin/trainings/:trainingId` | adminOnly | superadmin | blocked | - | updateTrainingSchema | trainingController.updateTraining |
| GET | `/api/v1/dashboard/superadmin/trainings/:trainingId/progress` | adminOnly | superadmin | blocked | - | trainingIdParamSchema | trainingController.getProgress |
| POST | `/api/v1/dashboard/superadmin/trainings/:trainingId/quiz` | adminOnly | superadmin | blocked | - | createQuizQuestionSchema | trainingController.addQuizQuestion |
| DELETE | `/api/v1/dashboard/superadmin/trainings/:trainingId/quiz/:questionId` | adminOnly | superadmin | blocked | - | trainingQuestionIdParamSchema | trainingController.deleteQuizQuestion |
| PATCH | `/api/v1/dashboard/superadmin/trainings/:trainingId/quiz/:questionId` | adminOnly | superadmin | blocked | - | updateQuizQuestionSchema | trainingController.updateQuizQuestion |
| POST | `/api/v1/dashboard/superadmin/trainings/:trainingId/steps` | adminOnly | superadmin | blocked | - | createStepSchema | trainingController.addStep |
| DELETE | `/api/v1/dashboard/superadmin/trainings/:trainingId/steps/:stepId` | adminOnly | superadmin | blocked | - | trainingStepIdParamSchema | trainingController.deleteStep |
| PATCH | `/api/v1/dashboard/superadmin/trainings/:trainingId/steps/:stepId` | adminOnly | superadmin | blocked | - | updateStepSchema | trainingController.updateStep |
| POST | `/api/v1/dashboard/superadmin/trainings/upload` | adminOnly | superadmin | blocked | - | - | trainingController.uploadMedia |
| GET | `/api/v1/dashboard/superadmin/transaction-costs` | adminOnly | superadmin | blocked | - | transactionCostsQuerySchema | costManagementController.getTransactionCosts |
| GET | `/api/v1/dashboard/superadmin/venue-commissions` | adminOnly | superadmin | blocked | - | - | venueCommissionController.getVenueCommissions |
| POST | `/api/v1/dashboard/superadmin/venue-commissions` | adminOnly | superadmin | blocked | - | - | venueCommissionController.createVenueCommission |
| DELETE | `/api/v1/dashboard/superadmin/venue-commissions/:id` | adminOnly | superadmin | blocked | - | - | venueCommissionController.deleteVenueCommission |
| GET | `/api/v1/dashboard/superadmin/venue-commissions/:id` | adminOnly | superadmin | blocked | - | - | venueCommissionController.getVenueCommissionById |
| PUT | `/api/v1/dashboard/superadmin/venue-commissions/:id` | adminOnly | superadmin | blocked | - | - | venueCommissionController.updateVenueCommission |
| POST | `/api/v1/dashboard/superadmin/venue-pricing/config` | adminOnly | superadmin | blocked | - | - | venuePricingController.createVenuePaymentConfig |
| DELETE | `/api/v1/dashboard/superadmin/venue-pricing/config/:venueId` | adminOnly | superadmin | blocked | - | - | venuePricingController.deleteVenuePaymentConfig |
| GET | `/api/v1/dashboard/superadmin/venue-pricing/config/:venueId` | adminOnly | superadmin | blocked | - | - | venuePricingController.getVenuePaymentConfig |
| PUT | `/api/v1/dashboard/superadmin/venue-pricing/config/:venueId` | adminOnly | superadmin | blocked | - | - | venuePricingController.updateVenuePaymentConfig |
| GET | `/api/v1/dashboard/superadmin/venue-pricing/configs-by-merchant/:merchantAccountId` | adminOnly | superadmin | blocked | - | - | venuePricingController.getVenueConfigsByMerchantAccount |
| GET | `/api/v1/dashboard/superadmin/venue-pricing/structures` | adminOnly | superadmin | blocked | - | - | venuePricingController.getVenuePricingStructures |
| POST | `/api/v1/dashboard/superadmin/venue-pricing/structures` | adminOnly | superadmin | blocked | - | - | venuePricingController.createVenuePricingStructure |
| DELETE | `/api/v1/dashboard/superadmin/venue-pricing/structures/:id` | adminOnly | superadmin | blocked | - | - | venuePricingController.deleteVenuePricingStructure |
| GET | `/api/v1/dashboard/superadmin/venue-pricing/structures/:id` | adminOnly | superadmin | blocked | - | - | venuePricingController.getVenuePricingStructure |
| PUT | `/api/v1/dashboard/superadmin/venue-pricing/structures/:id` | adminOnly | superadmin | blocked | - | - | venuePricingController.updateVenuePricingStructure |
| PATCH | `/api/v1/dashboard/superadmin/venue-pricing/structures/:id/deactivate` | adminOnly | superadmin | blocked | - | - | venuePricingController.deactivatePricingStructure |
| GET | `/api/v1/dashboard/superadmin/venue-pricing/structures/active/:venueId/:accountType` | adminOnly | superadmin | blocked | - | - | venuePricingController.getActivePricingStructure |
| POST | `/api/v1/dashboard/superadmin/venue-pricing/structures/flat-rate` | adminOnly | superadmin | blocked | - | - | venuePricingController.createFlatRatePricingStructure |
| GET | `/api/v1/dashboard/superadmin/venues` | adminOnly | superadmin | blocked | - | - | superadminController.getAllVenues |
| POST | `/api/v1/dashboard/superadmin/venues` | adminOnly | superadmin | blocked | - | createVenueSchema | venuesSuperadminController.createVenue |
| GET | `/api/v1/dashboard/superadmin/venues/:venueId` | adminOnly | superadmin | blocked | - | - | superadminController.getVenueDetails |
| POST | `/api/v1/dashboard/superadmin/venues/:venueId/approve` | adminOnly | superadmin | blocked | - | - | superadminController.approveVenue |
| DELETE | `/api/v1/dashboard/superadmin/venues/:venueId/features/:featureCode/disable` | adminOnly | superadmin | blocked | - | - | superadminController.disableFeatureForVenue |
| POST | `/api/v1/dashboard/superadmin/venues/:venueId/features/:featureCode/enable` | adminOnly | superadmin | blocked | - | - | superadminController.enableFeatureForVenue |
| POST | `/api/v1/dashboard/superadmin/venues/:venueId/features/:featureCode/grant-trial` | adminOnly | superadmin | blocked | - | grantTrialSchema | superadminController.grantTrialForVenue |
| POST | `/api/v1/dashboard/superadmin/venues/:venueId/plan/comp` | adminOnly | superadmin | blocked | - | assignCompPlanSchema | superadminController.assignVenueCompPlan |
| POST | `/api/v1/dashboard/superadmin/venues/:venueId/plan/grandfathered` | adminOnly | superadmin | blocked | - | setPlanGrandfatheredSchema | superadminController.setVenuePlanGrandfathered |
| POST | `/api/v1/dashboard/superadmin/venues/:venueId/plan/trial` | adminOnly | superadmin | blocked | - | extendPlanTrialSchema | superadminController.extendVenuePlanTrial |
| PATCH | `/api/v1/dashboard/superadmin/venues/:venueId/status` | adminOnly | superadmin | blocked | - | changeVenueStatusSchema | superadminController.changeVenueStatus |
| POST | `/api/v1/dashboard/superadmin/venues/:venueId/suspend` | adminOnly | superadmin | blocked | - | suspendVenueSchema | superadminController.suspendVenue |
| PATCH | `/api/v1/dashboard/superadmin/venues/:venueId/transfer` | adminOnly | superadmin | blocked | - | transferVenueSchema | venuesSuperadminController.transferVenue |
| POST | `/api/v1/dashboard/superadmin/venues/bulk` | adminOnly | superadmin | blocked | - | bulkCreateVenuesSchema | venuesSuperadminController.bulkCreateVenues |
| GET | `/api/v1/dashboard/superadmin/venues/list` | adminOnly | superadmin | blocked | - | - | superadminController.getVenuesListSimple |
| GET | `/api/v1/dashboard/superadmin/webhooks` | adminOnly | public | blocked | - | - | webhookController.listWebhookEvents |
| GET | `/api/v1/dashboard/superadmin/webhooks/:eventId` | adminOnly | public | blocked | - | - | webhookController.getWebhookEventDetails |
| POST | `/api/v1/dashboard/superadmin/webhooks/:eventId/retry` | adminOnly | public | blocked | - | - | webhookController.retryWebhookEvent |
| GET | `/api/v1/dashboard/superadmin/webhooks/event-types` | adminOnly | public | blocked | - | - | webhookController.getEventTypes |
| GET | `/api/v1/dashboard/superadmin/webhooks/metrics` | adminOnly | public | blocked | - | - | webhookController.getWebhookMetrics |
| DELETE | `/api/v1/dashboard/testing/payment/:paymentId` | dangerousMutation | unknown | missing | system:test | - | testingController.deleteTestPayment |
| POST | `/api/v1/dashboard/testing/payment/fast` | action | unknown | missing | system:test | createTestPaymentSchema | testingController.createTestPayment |
| GET | `/api/v1/dashboard/testing/payments` | read | unknown | partial | system:test | getTestPaymentsSchema | testingController.getTestPayments |
| GET | `/api/v1/dashboard/tokens/analytics` | read | unknown | partial | - | - | tokenBudgetController.getAnalytics |
| PUT | `/api/v1/dashboard/tokens/auto-recharge` | mutation | unknown | missing | - | - | tokenBudgetController.updateAutoRecharge |
| GET | `/api/v1/dashboard/tokens/history` | read | unknown | missing | - | - | tokenBudgetController.getHistory |
| POST | `/api/v1/dashboard/tokens/purchase` | action | unknown | missing | - | - | tokenBudgetController.purchase |
| GET | `/api/v1/dashboard/tokens/status` | read | unknown | missing | - | - | tokenBudgetController.getStatus |
| POST | `/api/v1/dashboard/tpv-commands/:commandId/ack` | action | unknown | missing | - | terminalAckSchema | tpvCommandController.handleCommandAck |
| POST | `/api/v1/dashboard/tpv-commands/:commandId/result` | action | unknown | missing | - | terminalResultSchema | tpvCommandController.handleCommandResult |
| POST | `/api/v1/dashboard/tpv/:terminalId/command` | action | unknown | missing | tpv:command | - | tpvController.sendTpvCommand |
| GET | `/api/v1/dashboard/tpv/:tpvId/merchants` | read | unknown | missing | tpv-settings:read | - | tpvController.getTerminalMerchants |
| POST | `/api/v1/dashboard/tpv/:tpvId/reset-to-defaults` | dangerousMutation | unknown | missing | tpv-settings:update | - | tpvController.resetTpvToDefaults |
| GET | `/api/v1/dashboard/tpv/:tpvId/settings` | read | unknown | missing | tpv-settings:read | - | tpvController.getTpvSettings |
| PUT | `/api/v1/dashboard/tpv/:tpvId/settings` | mutation | unknown | missing | tpv-settings:update | - | tpvController.updateTpvSettings |
| GET | `/api/v1/dashboard/venues` | read | unknown | missing | venues:read | listVenuesQuerySchema | // Type assertion for controller |
| POST | `/api/v1/dashboard/venues` | action | unknown | missing | venues:manage | createVenueSchema | // Llamas al método del controlador |
| DELETE | `/api/v1/dashboard/venues/:venueId` | dangerousMutation | venue | missing | venues:manage | - | venueController.deleteVenue |
| GET | `/api/v1/dashboard/venues/:venueId` | read | venue | missing | venues:read | - | venueController.getVenueById |
| PUT | `/api/v1/dashboard/venues/:venueId` | mutation | venue | missing | venues:manage | - | venueController.updateVenue |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/account-ledger` | read | venue | missing | accounting:read | accountLedgerSchema | getAccountLedgerController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/account-mapping` | read | venue | missing | accounting:read | venueParamSchema | mappingController.getAccountMapping |
| PATCH | `/api/v1/dashboard/venues/:venueId/accounting/account-mapping/:movementType` | mutation | venue | missing | accounting:manage | setMappingSchema | mappingController.setAccountMapping |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/account-mapping/seed` | action | venue | missing | accounting:manage | venueParamSchema | mappingController.seedAccountMapping |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/accounts-payable` | read | venue | missing | accounting:read | accountsPayableSchema | getAccountsPayableController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/asset-types` | read | venue | missing | accounting:read | - | listAssetTypesController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/banks` | read | venue | missing | accounting:read | periodSchema | accountingController.getBankAndCashSummary |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/business-summary` | read | venue | partial | accounting:read | periodSchema | accountingController.getBusinessSummary |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/chart-of-accounts` | read | venue | missing | accounting:read | venueParamSchema | chartController.getChartOfAccounts |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/chart-of-accounts` | action | venue | missing | accounting:manage | createAccountSchema | chartController.createLedgerAccount |
| PATCH | `/api/v1/dashboard/venues/:venueId/accounting/chart-of-accounts/:accountId` | mutation | venue | missing | accounting:manage | updateAccountSchema | chartController.updateLedgerAccount |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/chart-of-accounts/seed` | action | venue | missing | accounting:manage | venueParamSchema | chartController.seedChartOfAccounts |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/diot` | read | venue | missing | accounting:read | trialBalanceSchema | getDiotController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/electronic/balanza` | read | venue | missing | accounting:read | balanzaXmlSchema | getBalanzaXmlController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/electronic/catalogo` | read | venue | missing | accounting:read | trialBalanceSchema | getCatalogoXmlController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/electronic/polizas` | read | venue | missing | accounting:read | polizasXmlSchema | getPolizasXmlController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/expenses` | read | venue | missing | accounting:read | listExpensesSchema | listExpensesController |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/expenses` | action | venue | missing | accounting:manage | createExpenseSchema | createExpenseController |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/expenses/:expenseId/pay` | action | venue | missing | accounting:manage | markPaidSchema | markExpensePaidController |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/expenses/generate-policies` | action | venue | missing | accounting:manage | trialBalanceSchema | generateExpensePoliciesController |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/expenses/import-xml` | action | venue | missing | accounting:manage | importXmlSchema | importExpenseXmlController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/fiscal-loss` | read | venue | missing | accounting:read | fiscalLossGetSchema | getFiscalLossController |
| PUT | `/api/v1/dashboard/venues/:venueId/accounting/fiscal-loss` | mutation | venue | missing | accounting:manage | fiscalLossSetSchema | setFiscalLossController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/fixed-assets` | read | venue | missing | accounting:read | fixedAssetListSchema | listFixedAssetsController |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/fixed-assets` | action | venue | missing | accounting:manage | fixedAssetRegisterSchema | registerFixedAssetController |
| PATCH | `/api/v1/dashboard/venues/:venueId/accounting/fixed-assets/:assetId` | mutation | venue | missing | accounting:manage | fixedAssetUpdateSchema | updateFixedAssetController |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/fixed-assets/:assetId/dispose` | action | venue | missing | accounting:manage | fixedAssetDisposeSchema | disposeFixedAssetController |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/fixed-assets/depreciate` | action | venue | missing | accounting:manage | fixedAssetDepreciateSchema | generateDepreciationController |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/generate-policies` | action | venue | missing | accounting:manage | trialBalanceSchema | generatePoliciesController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/income-statement` | read | venue | missing | accounting:read | periodSchema | accountingController.getIncomeStatement |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/isr` | read | venue | missing | accounting:read | isrSchema | getIsrProvisionalController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/journal` | read | venue | missing | accounting:read | venueParamSchema | journalController.getJournal |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/journal` | action | venue | missing | accounting:manage | createEntrySchema | journalController.createJournalEntry |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/payroll/:payrollRunId/stamp` | action | venue | missing | accounting:manage | stampPayrollSchema | stampPayrollController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/payroll/employees` | read | venue | missing | accounting:read | venueParamSchema | listEmployeesController |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/payroll/employees` | action | venue | missing | accounting:manage | createEmployeeSchema | createEmployeeController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/payroll/preview` | read | venue | missing | accounting:read | payrollPreviewSchema | payrollPreviewController |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/payroll/run` | action | venue | missing | accounting:manage | runPayrollSchema | runPayrollController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/period-locks` | read | venue | missing | accounting:read | venueParamSchema | periodLockController.getPeriodLocks |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/period-locks/close` | action | venue | missing | accounting:manage | periodLockSchema | periodLockController.closePeriodController |
| POST | `/api/v1/dashboard/venues/:venueId/accounting/period-locks/reopen` | action | venue | missing | accounting:manage | periodLockSchema | periodLockController.reopenPeriodController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/readiness` | read | venue | missing | accounting:read | venueParamSchema | getFiscalReadinessController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/reports` | read | venue | missing | accounting:read | trialBalanceSchema | getAccountingReportsController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/sales-retention` | read | venue | partial | accounting:read | salesRetentionGetSchema | getSalesRetentionController |
| PUT | `/api/v1/dashboard/venues/:venueId/accounting/sales-retention` | mutation | venue | partial | accounting:manage | salesRetentionSetSchema | setSalesRetentionController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/trial-balance` | read | venue | missing | accounting:read | trialBalanceSchema | getTrialBalanceController |
| GET | `/api/v1/dashboard/venues/:venueId/accounting/vat-flow` | read | venue | missing | accounting:read | trialBalanceSchema | getIvaCashflowController |
| GET | `/api/v1/dashboard/venues/:venueId/activity-log` | read | venue | missing | activity:read | activityLogQuerySchema | activityLogController.getActivityLog |
| GET | `/api/v1/dashboard/venues/:venueId/activity-log/actions` | read | venue | missing | activity:read | - | activityLogController.getActivityLogActions |
| GET | `/api/v1/dashboard/venues/:venueId/activity-log/entities` | read | venue | missing | activity:read | - | activityLogController.getActivityLogEntities |
| GET | `/api/v1/dashboard/venues/:venueId/analytics` | read | venue | partial | - | - | getAnalyticsData |
| GET | `/api/v1/dashboard/venues/:venueId/available-balance` | read | venue | partial | settlements:read | dateRangeQuerySchema | availableBalanceController.getAvailableBalance |
| GET | `/api/v1/dashboard/venues/:venueId/available-balance/by-card-type` | read | venue | partial | settlements:read | dateRangeQuerySchema | availableBalanceController.getBalanceByCardType |
| GET | `/api/v1/dashboard/venues/:venueId/available-balance/projection` | read | venue | partial | settlements:read | balanceProjectionQuerySchema | availableBalanceController.getBalanceProjection |
| GET | `/api/v1/dashboard/venues/:venueId/available-balance/settlement-calendar` | read | public | partial | settlements:read | dateRangeQuerySchema | availableBalanceController.getSettlementCalendar |
| GET | `/api/v1/dashboard/venues/:venueId/available-balance/settlement-week` | read | public | partial | settlements:read | - | availableBalanceController.getSettlementWeek |
| POST | `/api/v1/dashboard/venues/:venueId/available-balance/simulate` | action | venue | partial | settlements:read | simulateTransactionSchema | availableBalanceController.simulateTransaction |
| GET | `/api/v1/dashboard/venues/:venueId/available-balance/timeline` | read | venue | partial | settlements:read | timelineQuerySchema | availableBalanceController.getSettlementTimeline |
| GET | `/api/v1/dashboard/venues/:venueId/bank-reconciliation/statements` | read | venue | missing | accounting:read | - | bankReconciliationController.listBankStatements |
| POST | `/api/v1/dashboard/venues/:venueId/bank-reconciliation/statements` | action | venue | missing | accounting:reconcile | - | bankReconciliationController.uploadBankStatement |
| GET | `/api/v1/dashboard/venues/:venueId/bank-reconciliation/statements/:statementId` | read | venue | missing | accounting:read | - | bankReconciliationController.getBankStatement |
| POST | `/api/v1/dashboard/venues/:venueId/bank-reconciliation/statements/:statementId/confirm` | action | venue | missing | accounting:reconcile | - | bankReconciliationController.confirmBankMatches |
| GET | `/api/v1/dashboard/venues/:venueId/basic-metrics` | read | venue | missing | - | - | getBasicMetrics |
| GET | `/api/v1/dashboard/venues/:venueId/basic-metrics` | read | venue | missing | analytics:read | z.object | generalStatsController.getBasicMetrics |
| POST | `/api/v1/dashboard/venues/:venueId/billing-portal` | action | venue | missing | billing:subscriptions:manage | createBillingPortalSessionSchema | venueController.createBillingPortalSession |
| GET | `/api/v1/dashboard/venues/:venueId/cash-closeouts` | read | venue | missing | settlements:read | closeoutHistoryQuerySchema | cashCloseoutController.getHistory |
| POST | `/api/v1/dashboard/venues/:venueId/cash-closeouts` | action | venue | missing | settlements:write | createCloseoutSchema | cashCloseoutController.createCloseout |
| GET | `/api/v1/dashboard/venues/:venueId/cash-closeouts/:closeoutId` | read | venue | missing | settlements:read | - | cashCloseoutController.getCloseoutById |
| GET | `/api/v1/dashboard/venues/:venueId/cash-closeouts/expected` | read | venue | missing | settlements:read | - | cashCloseoutController.getExpectedCash |
| GET | `/api/v1/dashboard/venues/:venueId/cfdi` | read | venue | missing | cfdi:view | listCfdisSchema | listCfdisController |
| GET | `/api/v1/dashboard/venues/:venueId/cfdi/:cfdiId` | read | venue | missing | cfdi:view | - | getCfdiStatusController |
| POST | `/api/v1/dashboard/venues/:venueId/cfdi/:cfdiId/cancel` | dangerousMutation | venue | missing | cfdi:configure | cancelCfdiSchema | // destructive → OWNER/ADMIN only cancelCfdiController |
| GET | `/api/v1/dashboard/venues/:venueId/charts/:chartType` | read | venue | missing | analytics:read | z.object | generalStatsController.getChartData |
| POST | `/api/v1/dashboard/venues/:venueId/chat/activation` | action | venue | missing | venues:manage | - | venueChatDashController.postActivation |
| POST | `/api/v1/dashboard/venues/:venueId/chat/deactivate` | action | venue | missing | venues:manage | - | venueChatDashController.deactivate |
| GET | `/api/v1/dashboard/venues/:venueId/chat/status` | read | venue | missing | venues:read | - | venueChatDashController.getChatStatus |
| GET | `/api/v1/dashboard/venues/:venueId/class-sessions` | read | venue | missing | reservations:read | z.object | controller.getClassSessions |
| POST | `/api/v1/dashboard/venues/:venueId/class-sessions` | action | venue | missing | reservations:create | z.object | controller.createClassSession |
| GET | `/api/v1/dashboard/venues/:venueId/class-sessions/:sessionId` | read | venue | missing | reservations:read | z.object | controller.getClassSession |
| PATCH | `/api/v1/dashboard/venues/:venueId/class-sessions/:sessionId` | mutation | venue | missing | reservations:update | z.object | controller.updateClassSession |
| POST | `/api/v1/dashboard/venues/:venueId/class-sessions/:sessionId/attendees` | action | venue | missing | reservations:create | z.object | controller.addAttendee |
| DELETE | `/api/v1/dashboard/venues/:venueId/class-sessions/:sessionId/attendees/:reservationId` | dangerousMutation | venue | missing | reservations:cancel | z.object | controller.removeAttendee |
| POST | `/api/v1/dashboard/venues/:venueId/class-sessions/:sessionId/cancel` | dangerousMutation | venue | missing | reservations:cancel | z.object | controller.cancelClassSession |
| POST | `/api/v1/dashboard/venues/:venueId/class-sessions/bulk` | dangerousMutation | venue | missing | reservations:create | z.object | controller.createClassSessionsBulk |
| POST | `/api/v1/dashboard/venues/:venueId/close` | action | venue | missing | venues:manage | - | venueController.closeVenue |
| GET | `/api/v1/dashboard/venues/:venueId/command-center/activity` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/command-center/category-breakdown` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/command-center/insights` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/command-center/stock-vs-sales` | read | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/command-center/summary` | read | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/command-center/top-sellers` | read | venue | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/venues/:venueId/convert-from-demo` | action | venue | missing | venues:manage | convertDemoVenueSchema | venueController.convertDemoVenue |
| GET | `/api/v1/dashboard/venues/:venueId/coupons` | read | venue | missing | coupons:read | z.object | couponController.getCouponCodes |
| POST | `/api/v1/dashboard/venues/:venueId/coupons` | action | venue | missing | coupons:create | z.object | couponController.createCouponCode |
| DELETE | `/api/v1/dashboard/venues/:venueId/coupons/:couponId` | dangerousMutation | venue | missing | coupons:delete | z.object | couponController.deleteCouponCode |
| GET | `/api/v1/dashboard/venues/:venueId/coupons/:couponId` | read | venue | missing | coupons:read | z.object | couponController.getCouponCodeById |
| PUT | `/api/v1/dashboard/venues/:venueId/coupons/:couponId` | mutation | venue | missing | coupons:update | z.object | couponController.updateCouponCode |
| POST | `/api/v1/dashboard/venues/:venueId/coupons/:couponId/redeem` | action | venue | missing | coupons:redeem | z.object | couponController.recordRedemption |
| POST | `/api/v1/dashboard/venues/:venueId/coupons/bulk-generate` | dangerousMutation | venue | missing | coupons:create | z.object | couponController.bulkGenerateCoupons |
| GET | `/api/v1/dashboard/venues/:venueId/coupons/redemptions` | read | venue | missing | coupons:read | z.object | couponController.getCouponRedemptions |
| GET | `/api/v1/dashboard/venues/:venueId/coupons/stats` | read | venue | partial | coupons:read | z.object | couponController.getCouponStats |
| POST | `/api/v1/dashboard/venues/:venueId/coupons/validate` | action | venue | missing | coupons:read | z.object | couponController.validateCouponCode |
| GET | `/api/v1/dashboard/venues/:venueId/credit-offer` | read | venue | missing | settlements:read | - | creditOfferController.getPendingOffer |
| POST | `/api/v1/dashboard/venues/:venueId/credit-offer/:offerId/decline` | action | venue | missing | settlements:write | - | creditOfferController.declineOffer |
| POST | `/api/v1/dashboard/venues/:venueId/credit-offer/:offerId/interest` | action | venue | missing | settlements:write | - | creditOfferController.expressInterest |
| GET | `/api/v1/dashboard/venues/:venueId/credit-packs` | read | venue | partial | creditPacks:read | - | controller.getCreditPacks |
| POST | `/api/v1/dashboard/venues/:venueId/credit-packs` | action | venue | partial | creditPacks:create | createCreditPackSchema | controller.createCreditPack |
| DELETE | `/api/v1/dashboard/venues/:venueId/credit-packs/:packId` | dangerousMutation | venue | partial | creditPacks:delete | packIdParamsSchema | controller.deactivateCreditPack |
| GET | `/api/v1/dashboard/venues/:venueId/credit-packs/:packId` | read | venue | partial | creditPacks:read | packIdParamsSchema | controller.getCreditPackById |
| PATCH | `/api/v1/dashboard/venues/:venueId/credit-packs/:packId` | mutation | venue | partial | creditPacks:update | updateCreditPackSchema | controller.updateCreditPack |
| POST | `/api/v1/dashboard/venues/:venueId/credit-packs/balances/:balanceId/adjust` | action | venue | partial | creditPacks:update | adjustBodySchema | controller.adjustBalance |
| POST | `/api/v1/dashboard/venues/:venueId/credit-packs/balances/:balanceId/redeem` | action | venue | partial | creditPacks:update | redeemBodySchema | controller.redeemItem |
| GET | `/api/v1/dashboard/venues/:venueId/credit-packs/purchases` | read | venue | partial | creditPacks:read | purchasesQuerySchema | controller.getPurchases |
| GET | `/api/v1/dashboard/venues/:venueId/credit-packs/purchases/:customerId` | read | venue | partial | creditPacks:read | customerIdParamsSchema | controller.getCustomerPurchases |
| POST | `/api/v1/dashboard/venues/:venueId/credit-packs/purchases/:purchaseId/refund` | dangerousMutation | venue | partial | creditPacks:delete | refundBodySchema | controller.refundPurchase |
| GET | `/api/v1/dashboard/venues/:venueId/credit-packs/transactions` | read | venue | partial | creditPacks:read | transactionsQuerySchema | controller.getTransactions |
| GET | `/api/v1/dashboard/venues/:venueId/crypto/config` | read | venue | missing | venue-crypto:manage | - | cryptoConfigController.getConfig as any |
| PUT | `/api/v1/dashboard/venues/:venueId/crypto/disable` | mutation | venue | missing | venue-crypto:manage | - | cryptoConfigController.disableCryptoHandler as any |
| POST | `/api/v1/dashboard/venues/:venueId/crypto/enable` | action | venue | missing | venue-crypto:manage | - | cryptoConfigController.enableCrypto as any |
| PUT | `/api/v1/dashboard/venues/:venueId/crypto/setup` | mutation | venue | missing | venue-crypto:manage | - | cryptoConfigController.setupCrypto as any |
| GET | `/api/v1/dashboard/venues/:venueId/customer-groups` | read | venue | missing | customer-groups:read | z.object | customerGroupController.getCustomerGroups |
| POST | `/api/v1/dashboard/venues/:venueId/customer-groups` | action | venue | missing | customer-groups:create | CreateCustomerGroupSchema | customerGroupController.createCustomerGroup |
| DELETE | `/api/v1/dashboard/venues/:venueId/customer-groups/:groupId` | dangerousMutation | venue | missing | customer-groups:delete | CustomerGroupParamsSchema | customerGroupController.deleteCustomerGroup |
| GET | `/api/v1/dashboard/venues/:venueId/customer-groups/:groupId` | read | venue | missing | customer-groups:read | CustomerGroupParamsSchema | customerGroupController.getCustomerGroupById |
| PUT | `/api/v1/dashboard/venues/:venueId/customer-groups/:groupId` | mutation | venue | missing | customer-groups:update | UpdateCustomerGroupSchema | customerGroupController.updateCustomerGroup |
| POST | `/api/v1/dashboard/venues/:venueId/customer-groups/:groupId/assign` | action | venue | missing | customer-groups:update | AssignCustomersSchema | customerGroupController.assignCustomersToGroup |
| POST | `/api/v1/dashboard/venues/:venueId/customer-groups/:groupId/remove` | action | venue | missing | customer-groups:update | RemoveCustomersSchema | customerGroupController.removeCustomersFromGroup |
| GET | `/api/v1/dashboard/venues/:venueId/customer-groups/stats` | read | venue | partial | customer-groups:read | z.object | customerGroupController.getCustomerGroupStats |
| GET | `/api/v1/dashboard/venues/:venueId/customers` | read | venue | partial | customers:read | z.object | customerController.getCustomers |
| POST | `/api/v1/dashboard/venues/:venueId/customers` | action | venue | partial | customers:create | CreateCustomerSchema | customerController.createCustomer |
| DELETE | `/api/v1/dashboard/venues/:venueId/customers/:customerId` | dangerousMutation | venue | partial | customers:delete | CustomerParamsSchema | customerController.deleteCustomer |
| GET | `/api/v1/dashboard/venues/:venueId/customers/:customerId` | read | venue | partial | customers:read | CustomerParamsSchema | customerController.getCustomerById |
| PUT | `/api/v1/dashboard/venues/:venueId/customers/:customerId` | mutation | venue | partial | customers:update | UpdateCustomerSchema | customerController.updateCustomer |
| GET | `/api/v1/dashboard/venues/:venueId/customers/:customerId/discounts` | read | venue | partial | discounts:read | z.object | discountController.getCustomerDiscounts |
| POST | `/api/v1/dashboard/venues/:venueId/customers/:customerId/loyalty/adjust` | action | venue | partial | loyalty:adjust | AdjustPointsSchema | loyaltyController.adjustPoints |
| GET | `/api/v1/dashboard/venues/:venueId/customers/:customerId/loyalty/balance` | read | venue | partial | loyalty:read | LoyaltyParamsSchema | loyaltyController.getPointsBalance |
| POST | `/api/v1/dashboard/venues/:venueId/customers/:customerId/loyalty/redeem` | action | venue | partial | loyalty:redeem | RedeemPointsSchema | loyaltyController.redeemPoints |
| GET | `/api/v1/dashboard/venues/:venueId/customers/:customerId/loyalty/transactions` | read | venue | partial | loyalty:read | z.object | loyaltyController.getLoyaltyTransactions |
| POST | `/api/v1/dashboard/venues/:venueId/customers/:customerId/settle-balance` | action | venue | partial | customers:settle-balance | CustomerParamsSchema | customerController.settleCustomerBalance |
| GET | `/api/v1/dashboard/venues/:venueId/customers/stats` | read | venue | partial | customers:read | CustomerVenueIdParamsSchema | customerController.getCustomerStats |
| GET | `/api/v1/dashboard/venues/:venueId/discounts` | read | venue | missing | discounts:read | z.object | discountController.getDiscounts |
| POST | `/api/v1/dashboard/venues/:venueId/discounts` | action | venue | missing | discounts:create | z.object | discountController.createDiscount |
| DELETE | `/api/v1/dashboard/venues/:venueId/discounts/:discountId` | dangerousMutation | venue | missing | discounts:delete | z.object | discountController.deleteDiscount |
| GET | `/api/v1/dashboard/venues/:venueId/discounts/:discountId` | read | venue | missing | discounts:read | z.object | discountController.getDiscountById |
| PUT | `/api/v1/dashboard/venues/:venueId/discounts/:discountId` | mutation | venue | missing | discounts:update | z.object | discountController.updateDiscount |
| POST | `/api/v1/dashboard/venues/:venueId/discounts/:discountId/clone` | action | venue | missing | discounts:create | z.object | discountController.cloneDiscount |
| POST | `/api/v1/dashboard/venues/:venueId/discounts/:discountId/customers` | action | venue | partial | discounts:update | z.object | discountController.assignDiscountToCustomer |
| DELETE | `/api/v1/dashboard/venues/:venueId/discounts/:discountId/customers/:customerId` | dangerousMutation | venue | partial | discounts:update | z.object | discountController.removeDiscountFromCustomer |
| GET | `/api/v1/dashboard/venues/:venueId/discounts/automatic` | read | venue | missing | discounts:read | z.object | discountController.getActiveAutomaticDiscounts |
| GET | `/api/v1/dashboard/venues/:venueId/discounts/stats` | read | venue | partial | discounts:read | z.object | discountController.getDiscountStats |
| GET | `/api/v1/dashboard/venues/:venueId/ecommerce-merchants` | read | venue | missing | venues:manage | listVenueEcommerceMerchantsSchema | ecommerceMerchantController.listEcommerceMerchants |
| POST | `/api/v1/dashboard/venues/:venueId/ecommerce-merchants` | action | venue | missing | venues:manage | createEcommerceMerchantWithVenueSchema | ecommerceMerchantController.createEcommerceMerchant |
| DELETE | `/api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id` | dangerousMutation | venue | missing | venues:manage | getEcommerceMerchantSchema | ecommerceMerchantController.deleteEcommerceMerchant |
| GET | `/api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id` | read | venue | missing | venues:manage | getEcommerceMerchantSchema | ecommerceMerchantController.getEcommerceMerchant |
| PUT | `/api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id` | mutation | venue | missing | venues:manage | updateEcommerceMerchantWithVenueSchema | ecommerceMerchantController.updateEcommerceMerchant |
| GET | `/api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id/keys` | read | venue | missing | venues:manage | getEcommerceMerchantSchema | ecommerceMerchantController.getAPIKeys |
| GET | `/api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id/onboarding-status` | read | venue | missing | venues:manage | getStripeOnboardingStatusSchema | stripeConnectController.getOnboardingStatus |
| PATCH | `/api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id/platform-fee` | mutation | venue | missing | venues:manage, system:manage | - | ecommerceMerchantController.updatePlatformFee |
| POST | `/api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id/regenerate-keys` | action | venue | missing | venues:manage | regenerateKeysWithVenueSchema | ecommerceMerchantController.regenerateAPIKeys |
| POST | `/api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id/stripe-onboard` | action | venue | missing | venues:manage | createStripeOnboardingLinkSchema | stripeConnectController.createOnboardingLink |
| PATCH | `/api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id/toggle` | mutation | venue | missing | venues:manage | toggleEcommerceMerchantWithVenueSchema | ecommerceMerchantController.toggleEcommerceMerchantStatus |
| GET | `/api/v1/dashboard/venues/:venueId/ecommerce-merchants/available-providers` | read | venue | missing | venues:manage | - | ecommerceMerchantController.listAvailableProviders |
| GET | `/api/v1/dashboard/venues/:venueId/features` | read | venue | missing | billing:subscriptions:read | - | venueFeatureController.getVenueFeatures |
| GET | `/api/v1/dashboard/venues/:venueId/features` | read | venue | missing | features:read | - | featureController.getVenueFeatures |
| POST | `/api/v1/dashboard/venues/:venueId/features` | action | venue | missing | billing:subscriptions:manage | addVenueFeaturesSchema | venueFeatureController.addVenueFeatures |
| POST | `/api/v1/dashboard/venues/:venueId/features` | action | venue | missing | features:write | - | featureController.saveVenueFeatures |
| DELETE | `/api/v1/dashboard/venues/:venueId/features/:featureId` | dangerousMutation | venue | missing | billing:subscriptions:manage | - | venueFeatureController.removeVenueFeature |
| POST | `/api/v1/dashboard/venues/:venueId/features/:featureId/proration-preview` | action | venue | missing | features:read | - | venueFeatureController.previewSubscriptionChange |
| PUT | `/api/v1/dashboard/venues/:venueId/features/:featureId/subscription` | mutation | venue | missing | features:write | - | venueFeatureController.updateSubscription |
| GET | `/api/v1/dashboard/venues/:venueId/fiscal/config` | read | venue | missing | cfdi:view | - | getFiscalConfigController |
| POST | `/api/v1/dashboard/venues/:venueId/fiscal/emisores` | action | venue | missing | cfdi:configure | upsertEmisorSchema | upsertEmisorController |
| PUT | `/api/v1/dashboard/venues/:venueId/fiscal/emisores/:emisorId` | mutation | venue | missing | cfdi:configure | upsertEmisorSchema | upsertEmisorController |
| POST | `/api/v1/dashboard/venues/:venueId/fiscal/emisores/:emisorId/csd` | action | venue | missing | cfdi:configure | uploadCsdSchema | uploadEmisorCsdController |
| POST | `/api/v1/dashboard/venues/:venueId/fiscal/emisores/:emisorId/global` | action | venue | missing | cfdi:configure | - | triggerGlobalCfdiController |
| POST | `/api/v1/dashboard/venues/:venueId/fiscal/emisores/:emisorId/provision` | action | venue | missing | cfdi:configure | - | provisionEmisorController |
| PUT | `/api/v1/dashboard/venues/:venueId/fiscal/merchant-config` | mutation | venue | missing | cfdi:configure | upsertMerchantConfigSchema | upsertMerchantFiscalConfigController |
| GET | `/api/v1/dashboard/venues/:venueId/fiscal/sat-catalog` | read | venue | missing | cfdi:view | satCatalogSchema | searchSatCatalogController |
| GET | `/api/v1/dashboard/venues/:venueId/general-stats` | read | venue | partial | analytics:read | z.object | generalStatsController.getGeneralStats |
| GET | `/api/v1/dashboard/venues/:venueId/google-calendar/busy-blocks` | read | venue | missing | calendar:view_status | - | listBusyBlocks |
| POST | `/api/v1/dashboard/venues/:venueId/google-calendar/outbox/:rowId/retry` | action | venue | missing | calendar:manage_venue | - | retryDeadLetterOutbox |
| GET | `/api/v1/dashboard/venues/:venueId/google-calendar/outbox/dead-letter` | read | venue | missing | calendar:view_status | - | listDeadLetterOutbox |
| DELETE | `/api/v1/dashboard/venues/:venueId/integrations/google/disconnect` | dangerousMutation | venue | missing | venues:manage | - | googleIntegrationController.disconnectGoogleIntegration |
| POST | `/api/v1/dashboard/venues/:venueId/integrations/google/init-oauth` | action | venue | missing | venues:manage | - | googleIntegrationController.initGoogleOAuth |
| GET | `/api/v1/dashboard/venues/:venueId/integrations/google/status` | read | venue | missing | venues:read | - | googleIntegrationController.getGoogleIntegrationStatus |
| POST | `/api/v1/dashboard/venues/:venueId/integrations/google/sync` | action | venue | missing | venues:manage | - | googleIntegrationController.syncGoogleReviews |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/alerts` | read | venue | partial | inventory:read | GetAlertsQuerySchema | alertController.getAlerts |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/alerts` | action | venue | partial | inventory:create | - | alertController.createManualAlert |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/alerts/:alertId/acknowledge` | action | venue | partial | inventory:update | AcknowledgeAlertSchema | alertController.acknowledgeAlert |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/alerts/:alertId/dismiss` | action | venue | partial | inventory:update | - | alertController.dismissAlert |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/alerts/:alertId/resolve` | action | venue | partial | inventory:update | ResolveAlertSchema | alertController.resolveAlert |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/alerts/by-category` | read | venue | partial | inventory:read | - | alertController.getAlertsByCategory |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/alerts/count` | read | venue | partial | inventory:read | - | alertController.getActiveAlertsCount |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/alerts/stats` | read | venue | partial | inventory:read | - | alertController.getAlertStats |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/auto-reorder` | read | venue | partial | inventory:read | - | autoReorderController.getSettings |
| PUT | `/api/v1/dashboard/venues/:venueId/inventory/auto-reorder` | mutation | venue | partial | inventory:update | autoReorderController.updateAutoReorderSchema | autoReorderController.updateSettings |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/auto-reorder/run-now` | action | venue | partial | inventory:update | - | autoReorderController.runNow |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/market-benchmark/bulk` | dangerousMutation | venue | partial | inventory:read | - | pricingController.getBulkMarketBenchmark |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/movements` | read | venue | partial | inventory:read | GetGlobalMovementsQuerySchema | productInventoryController.getGlobalMovementsHandler |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/pricing-analysis` | read | venue | partial | inventory:read | - | pricingController.getPricingAnalysis |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/product-labels` | action | venue | partial | inventory:read | GenerateProductLabelsSchema | productLabelController.generateProductLabels |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/adjust-stock` | action | venue | partial | inventory:update | AdjustProductInventoryStockSchema | productInventoryController.adjustInventoryStockHandler |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/apply-suggested-price` | action | venue | partial | inventory:update | - | pricingController.applySuggestedPrice |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/calculate-price` | read | venue | partial | inventory:read | CalculatePriceSchema | pricingController.calculatePrice |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/inventory-method` | read | venue | partial | inventory:read | - | productWizardController.getProductInventoryMethod |
| PUT | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/inventory-method` | mutation | venue | partial | inventory:update | SetProductInventoryMethodSchema | productWizardController.setProductInventoryMethod |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/inventory-status` | read | venue | partial | inventory:read | - | productWizardController.getProductInventoryStatus |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/market-benchmark` | read | venue | partial | inventory:read | - | pricingController.getMarketBenchmarkForProduct |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/movements` | read | venue | partial | inventory:read | ProductIdParamsSchema | productInventoryController.getInventoryMovementsHandler |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/pricing-policy` | read | venue | partial | inventory:read | ProductIdParamsSchema | pricingController.getPricingPolicy |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/pricing-policy` | action | venue | partial | inventory:create | CreatePricingPolicySchema | pricingController.createPricingPolicy |
| PUT | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/pricing-policy` | mutation | venue | partial | inventory:update | UpdatePricingPolicySchema | pricingController.updatePricingPolicy |
| DELETE | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/recipe` | dangerousMutation | venue | partial | inventory:delete | ProductIdParamsSchema | recipeController.deleteRecipe |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/recipe` | read | venue | partial | inventory:read | ProductIdParamsSchema | recipeController.getRecipe |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/recipe` | action | venue | partial | inventory:create | CreateRecipeSchema | recipeController.createRecipe |
| PUT | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/recipe` | mutation | venue | partial | inventory:update | UpdateRecipeSchema | recipeController.updateRecipe |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/recipe/inventory-config` | read | venue | partial | inventory:read | ProductIdParamsSchema | recipeController.getRecipeWithInventoryConfig |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/recipe/lines` | action | venue | partial | inventory:create | AddRecipeLineSchema | recipeController.addRecipeLine |
| DELETE | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/recipe/lines/:recipeLineId` | dangerousMutation | venue | partial | inventory:delete | - | recipeController.removeRecipeLine |
| PATCH | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/recipe/lines/:recipeLineId` | mutation | venue | partial | inventory:update | UpdateRecipeLineSchema | recipeController.updateRecipeLine |
| PUT | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/recipe/lines/:recipeLineId/variable` | mutation | venue | partial | inventory:update | ConfigureVariableIngredientSchema | recipeController.configureVariableIngredient |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/switch-inventory-method` | action | venue | partial | inventory:update | SetProductInventoryMethodSchema | // Requires inventoryMethod in body (QUANTITY or RECIPE) productWizardController.switchInventoryMethod |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/wizard/progress` | read | venue | partial | inventory:read | GetWizardProgressSchema | productWizardController.getWizardProgress |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/wizard/step2` | action | venue | partial | inventory:update | ProductWizardStep2Schema | productWizardController.configureInventoryStep2 |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/wizard/step3-recipe` | action | venue | partial | inventory:update | ProductWizardStep3RecipeSchema | productWizardController.setupRecipeStep3 |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/products/:productId/wizard/step3-simple` | action | venue | partial | inventory:update | ProductWizardStep3SimpleStockSchema | productWizardController.setupSimpleStockStep3 |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/profitability` | read | venue | partial | inventory:read | - | pricingController.getProfitability |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/purchase-orders` | read | venue | partial | inventory:read | GetPurchaseOrdersQuerySchema | purchaseOrderController.getPurchaseOrders |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/purchase-orders` | action | venue | partial | inventory:create | CreatePurchaseOrderSchema | purchaseOrderController.createPurchaseOrder |
| DELETE | `/api/v1/dashboard/venues/:venueId/inventory/purchase-orders/:purchaseOrderId` | dangerousMutation | venue | partial | inventory:delete | PurchaseOrderIdParamsSchema | purchaseOrderController.deletePurchaseOrder |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/purchase-orders/:purchaseOrderId` | read | venue | partial | inventory:read | PurchaseOrderIdParamsSchema | purchaseOrderController.getPurchaseOrder |
| PUT | `/api/v1/dashboard/venues/:venueId/inventory/purchase-orders/:purchaseOrderId` | mutation | venue | partial | inventory:update | UpdatePurchaseOrderSchema | purchaseOrderController.updatePurchaseOrder |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/purchase-orders/:purchaseOrderId/approve` | dangerousMutation | venue | partial | inventory:update | - | purchaseOrderController.approvePurchaseOrder |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/purchase-orders/:purchaseOrderId/cancel` | dangerousMutation | venue | partial | inventory:update | - | purchaseOrderController.cancelPurchaseOrder |
| PUT | `/api/v1/dashboard/venues/:venueId/inventory/purchase-orders/:purchaseOrderId/fees` | mutation | venue | partial | inventory:update | UpdatePurchaseOrderFeesSchema | purchaseOrderController.updatePurchaseOrderFees |
| PUT | `/api/v1/dashboard/venues/:venueId/inventory/purchase-orders/:purchaseOrderId/items/:itemId/status` | mutation | venue | partial | inventory:update | UpdatePurchaseOrderItemStatusSchema | purchaseOrderController.updatePurchaseOrderItemStatus |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/purchase-orders/:purchaseOrderId/labels` | action | venue | partial | inventory:read | GenerateLabelsSchema | purchaseOrderController.generateLabels |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/purchase-orders/:purchaseOrderId/pdf` | read | venue | partial | inventory:read | - | purchaseOrderController.generatePDF |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/purchase-orders/:purchaseOrderId/recalculate-status` | action | venue | partial | inventory:update | - | purchaseOrderController.recalculateStatus |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/purchase-orders/:purchaseOrderId/receive` | action | venue | partial | inventory:update | ReceivePurchaseOrderSchema | purchaseOrderController.receivePurchaseOrder |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/purchase-orders/:purchaseOrderId/receive-all` | action | venue | partial | inventory:update | ReceiveAllItemsSchema | purchaseOrderController.receiveAllItems |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/purchase-orders/:purchaseOrderId/receive-none` | action | venue | partial | inventory:update | ReceiveNoItemsSchema | purchaseOrderController.receiveNoItems |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/purchase-orders/stats` | read | venue | partial | inventory:read | - | purchaseOrderController.getPurchaseOrderStats |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/raw-materials` | read | venue | partial | inventory:read | GetRawMaterialsQuerySchema | rawMaterialController.getRawMaterials |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/raw-materials` | action | venue | partial | inventory:create | CreateRawMaterialSchema | rawMaterialController.createRawMaterial |
| DELETE | `/api/v1/dashboard/venues/:venueId/inventory/raw-materials/:rawMaterialId` | dangerousMutation | venue | partial | inventory:delete | RawMaterialIdParamsSchema | rawMaterialController.deleteRawMaterial |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/raw-materials/:rawMaterialId` | read | venue | partial | inventory:read | RawMaterialIdParamsSchema | rawMaterialController.getRawMaterial |
| PUT | `/api/v1/dashboard/venues/:venueId/inventory/raw-materials/:rawMaterialId` | mutation | venue | partial | inventory:update | UpdateRawMaterialSchema | rawMaterialController.updateRawMaterial |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/raw-materials/:rawMaterialId/adjust-stock` | action | venue | partial | inventory:update | AdjustStockSchema | rawMaterialController.adjustStock |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/raw-materials/:rawMaterialId/alerts` | read | venue | partial | inventory:read | - | alertController.getAlertHistory |
| PUT | `/api/v1/dashboard/venues/:venueId/inventory/raw-materials/:rawMaterialId/deactivate` | mutation | venue | partial | inventory:update | RawMaterialIdParamsSchema | rawMaterialController.deactivateRawMaterial |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/raw-materials/:rawMaterialId/movements` | read | venue | partial | inventory:read | RawMaterialIdParamsSchema | rawMaterialController.getStockMovements |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/raw-materials/:rawMaterialId/preview-cost-change` | read | venue | partial | inventory:read | PreviewCostChangeSchema | productWizardController.previewCostChange |
| PUT | `/api/v1/dashboard/venues/:venueId/inventory/raw-materials/:rawMaterialId/reactivate` | mutation | venue | partial | inventory:update | RawMaterialIdParamsSchema | rawMaterialController.reactivateRawMaterial |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/raw-materials/:rawMaterialId/recipes` | read | venue | partial | inventory:read | RawMaterialIdParamsSchema | rawMaterialController.getRawMaterialRecipes |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/raw-materials/:rawMaterialId/supplier-pricing` | read | venue | partial | inventory:read | - | supplierController.getSupplierPricingHistory |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/raw-materials/:rawMaterialId/supplier-recommendations` | read | venue | partial | inventory:read | GetSupplierRecommendationsSchema | supplierController.getSupplierRecommendations |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/raw-materials/:rawMaterialId/trigger-cost-recalculation` | action | venue | partial | inventory:update | TriggerCostRecalculationSchema | productWizardController.triggerCostRecalculation |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/recalculate-all-recipes` | action | venue | partial | inventory:update | VenueIdParamsSchema | productWizardController.recalculateAllRecipes |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/recalculate-stale-recipes` | action | venue | partial | inventory:update | VenueIdParamsSchema | productWizardController.recalculateStaleRecipes |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/recipe-cost-variances` | read | venue | partial | inventory:read | GetRecipeCostVariancesSchema | productWizardController.getRecipeCostVariances |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/reports/cost-variance` | read | venue | partial | inventory:read | - | reportController.getCostVarianceReport |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/reports/ingredient-usage` | read | venue | partial | inventory:read | GetIngredientUsageReportSchema | reportController.getIngredientUsageReport |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/reports/pmix` | read | venue | partial | inventory:read | GetPMIXReportSchema | reportController.getPMIXReport |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/reports/profitability` | read | venue | partial | inventory:read | GetProfitabilityReportSchema | reportController.getProfitabilityReport |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/reports/valuation` | read | venue | partial | inventory:read | - | reportController.getInventoryValuation |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/should-use-inventory` | read | venue | partial | inventory:read | VenueIdParamsSchema | productWizardController.shouldUseInventory |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/stale-recipes` | read | venue | partial | inventory:read | VenueIdParamsSchema | productWizardController.getStaleRecipes |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/stock-counts` | read | venue | partial | inventory:read | - | stockCountController.listStockCounts |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/stock-counts/:countId` | read | venue | partial | inventory:read | - | stockCountController.getStockCount |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/suppliers` | read | venue | partial | inventory:read | - | supplierController.getSuppliers |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/suppliers` | action | venue | partial | inventory:create | CreateSupplierSchema | supplierController.createSupplier |
| DELETE | `/api/v1/dashboard/venues/:venueId/inventory/suppliers/:supplierId` | dangerousMutation | venue | partial | inventory:delete | SupplierIdParamsSchema | supplierController.deleteSupplier |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/suppliers/:supplierId` | read | venue | partial | inventory:read | SupplierIdParamsSchema | supplierController.getSupplier |
| PUT | `/api/v1/dashboard/venues/:venueId/inventory/suppliers/:supplierId` | mutation | venue | partial | inventory:update | UpdateSupplierSchema | supplierController.updateSupplier |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/suppliers/:supplierId/performance` | read | venue | partial | inventory:read | - | supplierController.getSupplierPerformance |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/suppliers/:supplierId/pricing` | action | venue | partial | inventory:create | CreateSupplierPricingSchema | supplierController.createSupplierPricing |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/transfers` | read | venue | partial | inventory:read | - | inventoryTransferController.listTransfers |
| GET | `/api/v1/dashboard/venues/:venueId/inventory/transfers/:transferId` | read | venue | partial | inventory:read | - | inventoryTransferController.getTransfer |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/wizard/complete` | dangerousMutation | venue | partial | inventory:update | CreateProductWithInventorySchema | productWizardController.createProductWithInventory |
| POST | `/api/v1/dashboard/venues/:venueId/inventory/wizard/step1` | action | venue | partial | inventory:create | ProductWizardStep1Schema | productWizardController.createProductStep1 |
| GET | `/api/v1/dashboard/venues/:venueId/invoices` | read | venue | missing | billing:history:read | - | venueFeatureController.getVenueInvoices |
| GET | `/api/v1/dashboard/venues/:venueId/invoices/:invoiceId/download` | read | venue | missing | billing:history:read | - | venueFeatureController.downloadInvoice |
| POST | `/api/v1/dashboard/venues/:venueId/invoices/:invoiceId/retry` | action | venue | missing | billing:history:read | - | venueFeatureController.retryInvoicePayment |
| GET | `/api/v1/dashboard/venues/:venueId/item-categories` | read | venue | missing | inventory:read | - | itemCategoryController.getItemCategories |
| POST | `/api/v1/dashboard/venues/:venueId/item-categories` | action | venue | missing | inventory:update | - | itemCategoryController.createItemCategory |
| DELETE | `/api/v1/dashboard/venues/:venueId/item-categories/:categoryId` | dangerousMutation | venue | missing | inventory:delete | - | itemCategoryController.deleteItemCategory |
| GET | `/api/v1/dashboard/venues/:venueId/item-categories/:categoryId` | read | venue | missing | inventory:read | - | itemCategoryController.getItemCategoryById |
| PUT | `/api/v1/dashboard/venues/:venueId/item-categories/:categoryId` | mutation | venue | missing | inventory:update | - | itemCategoryController.updateItemCategory |
| GET | `/api/v1/dashboard/venues/:venueId/item-categories/:categoryId/items` | read | venue | missing | inventory:read | - | itemCategoryController.getCategoryItems |
| POST | `/api/v1/dashboard/venues/:venueId/item-categories/:categoryId/items/bulk` | dangerousMutation | venue | missing | inventory:update | - | itemCategoryController.bulkUploadItems |
| PUT | `/api/v1/dashboard/venues/:venueId/kyc/document/:documentKey` | mutation | venue | missing | - | - | venueKycController.uploadSingleKycDocument |
| POST | `/api/v1/dashboard/venues/:venueId/kyc/resubmit` | action | venue | missing | - | - | venueKycController.resubmitKycDocuments |
| POST | `/api/v1/dashboard/venues/:venueId/kyc/submit` | action | venue | missing | - | - | venueKycController.submitKycForReview |
| POST | `/api/v1/dashboard/venues/:venueId/loyalty/calculate-discount` | action | venue | missing | loyalty:read | CalculateDiscountSchema | loyaltyController.calculateDiscount |
| POST | `/api/v1/dashboard/venues/:venueId/loyalty/calculate-points` | action | venue | missing | loyalty:read | CalculatePointsSchema | loyaltyController.calculatePoints |
| GET | `/api/v1/dashboard/venues/:venueId/loyalty/config` | read | venue | missing | loyalty:read | LoyaltyVenueParamsSchema | loyaltyController.getLoyaltyConfig |
| PUT | `/api/v1/dashboard/venues/:venueId/loyalty/config` | mutation | venue | missing | loyalty:update | UpdateLoyaltyConfigSchema | loyaltyController.updateLoyaltyConfig |
| POST | `/api/v1/dashboard/venues/:venueId/loyalty/expire-old-points` | action | venue | missing | loyalty:expire | LoyaltyVenueParamsSchema | loyaltyController.expireOldPoints |
| POST | `/api/v1/dashboard/venues/:venueId/menu/import` | action | venue | partial | menu:import | ImportMenuSchema | menuController.importMenuHandler |
| GET | `/api/v1/dashboard/venues/:venueId/menucategories` | read | venue | partial | menu:read | VenueIdParamsSchema | // Validate venueId from params menuController.listMenuCategoriesHandler |
| GET | `/api/v1/dashboard/venues/:venueId/menucategories` | read | venue | partial | menu:read | VenueIdParamsSchema | // Validate venueId from params menuController.listMenuCategoriesHandler |
| POST | `/api/v1/dashboard/venues/:venueId/menucategories` | action | venue | partial | menu:create | CreateMenuCategorySchema | menuController.createMenuCategoryHandler |
| POST | `/api/v1/dashboard/venues/:venueId/menucategories` | action | venue | partial | menu:create | CreateMenuCategorySchema | menuController.createMenuCategoryHandler |
| DELETE | `/api/v1/dashboard/venues/:venueId/menucategories/:categoryId` | dangerousMutation | venue | partial | menu:delete | GetMenuCategoryParamsSchema | menuController.deleteMenuCategoryHandler |
| DELETE | `/api/v1/dashboard/venues/:venueId/menucategories/:categoryId` | dangerousMutation | venue | partial | menu:delete | GetMenuCategoryParamsSchema | menuController.deleteMenuCategoryHandler |
| GET | `/api/v1/dashboard/venues/:venueId/menucategories/:categoryId` | read | venue | partial | menu:read | GetMenuCategoryParamsSchema | menuController.getMenuCategoryHandler |
| GET | `/api/v1/dashboard/venues/:venueId/menucategories/:categoryId` | read | venue | partial | menu:read | GetMenuCategoryParamsSchema | menuController.getMenuCategoryHandler |
| PATCH | `/api/v1/dashboard/venues/:venueId/menucategories/:categoryId` | mutation | venue | partial | menu:update | UpdateMenuCategorySchema | menuController.updateMenuCategoryHandler |
| PATCH | `/api/v1/dashboard/venues/:venueId/menucategories/:categoryId` | mutation | venue | partial | menu:update | UpdateMenuCategorySchema | menuController.updateMenuCategoryHandler |
| POST | `/api/v1/dashboard/venues/:venueId/menucategories/reorder` | action | venue | partial | menu:update | ReorderMenuCategoriesSchema | menuController.reorderMenuCategoriesHandler |
| POST | `/api/v1/dashboard/venues/:venueId/menucategories/reorder` | action | venue | partial | menu:update | ReorderMenuCategoriesSchema | menuController.reorderMenuCategoriesHandler |
| GET | `/api/v1/dashboard/venues/:venueId/menus` | read | venue | partial | - | - | getMenusHandler |
| GET | `/api/v1/dashboard/venues/:venueId/menus` | read | venue | partial | menu:read | - | menuController.getMenusHandler |
| GET | `/api/v1/dashboard/venues/:venueId/menus` | read | venue | partial | menu:read | MenuQuerySchema | menuController.getMenusHandler |
| POST | `/api/v1/dashboard/venues/:venueId/menus` | action | venue | partial | menu:create | CreateMenuSchema | menuController.createMenuHandler |
| DELETE | `/api/v1/dashboard/venues/:venueId/menus/:menuId` | dangerousMutation | venue | partial | menu:delete | GetMenuParamsSchema | menuController.deleteMenuHandler |
| GET | `/api/v1/dashboard/venues/:venueId/menus/:menuId` | read | venue | partial | menu:read | GetMenuParamsSchema | menuController.getMenuHandler |
| PATCH | `/api/v1/dashboard/venues/:venueId/menus/:menuId` | mutation | venue | partial | menu:update | UpdateMenuSchema | menuController.updateMenuHandler |
| POST | `/api/v1/dashboard/venues/:venueId/menus/:menuId/categories` | action | venue | partial | menu:update | AssignCategoryToMenuSchema | menuController.assignCategoryToMenuHandler |
| DELETE | `/api/v1/dashboard/venues/:venueId/menus/:menuId/categories/:categoryId` | dangerousMutation | venue | partial | menu:update | GetMenuParamsSchema | menuController.removeCategoryFromMenuHandler |
| POST | `/api/v1/dashboard/venues/:venueId/menus/:menuId/clone` | action | venue | partial | menu:create | CloneMenuSchema | menuController.cloneMenuHandler |
| POST | `/api/v1/dashboard/venues/:venueId/menus/reorder` | action | venue | partial | menu:update | ReorderMenusSchema | menuController.reorderMenusHandler |
| GET | `/api/v1/dashboard/venues/:venueId/merchant-routing-rules` | read | venue | missing | payments:routing-read | - | merchantRoutingDashboardController.listRules |
| PUT | `/api/v1/dashboard/venues/:venueId/merchant-routing-rules` | mutation | venue | missing | payments:routing-manage | upsertMerchantRoutingRuleSchema | merchantRoutingDashboardController.upsertRule |
| DELETE | `/api/v1/dashboard/venues/:venueId/merchant-routing-rules/:merchantAccountId` | dangerousMutation | venue | missing | payments:routing-manage | deleteMerchantRoutingRuleSchema | merchantRoutingDashboardController.deleteRule |
| POST | `/api/v1/dashboard/venues/:venueId/merchant-routing-rules/preview` | action | venue | missing | payments:routing-read | merchantEligibilityRequestSchema | merchantRoutingDashboardController.previewEligibility |
| GET | `/api/v1/dashboard/venues/:venueId/messages` | read | venue | missing | tpv-messages:read | - | tpvMessageController.getMessages |
| POST | `/api/v1/dashboard/venues/:venueId/messages` | action | venue | missing | tpv-messages:send | - | tpvMessageController.createMessage |
| DELETE | `/api/v1/dashboard/venues/:venueId/messages/:messageId` | dangerousMutation | venue | missing | tpv-messages:send | - | tpvMessageController.cancelMessage |
| GET | `/api/v1/dashboard/venues/:venueId/messages/:messageId` | read | venue | missing | tpv-messages:read | - | tpvMessageController.getMessage |
| GET | `/api/v1/dashboard/venues/:venueId/messages/:messageId/responses` | read | venue | missing | tpv-messages:read | - | tpvMessageController.getMessageResponses |
| GET | `/api/v1/dashboard/venues/:venueId/metrics/:metricType` | read | venue | missing | analytics:read | z.object | generalStatsController.getExtendedMetrics |
| GET | `/api/v1/dashboard/venues/:venueId/modifier-groups` | read | venue | missing | menu:read | ModifierGroupQuerySchema | menuController.listModifierGroupsHandler |
| POST | `/api/v1/dashboard/venues/:venueId/modifier-groups` | action | venue | missing | menu:create | CreateModifierGroupSchema | menuController.createModifierGroupHandler |
| DELETE | `/api/v1/dashboard/venues/:venueId/modifier-groups/:modifierGroupId` | dangerousMutation | venue | missing | menu:delete | GetModifierGroupParamsSchema | menuController.deleteModifierGroupHandler |
| GET | `/api/v1/dashboard/venues/:venueId/modifier-groups/:modifierGroupId` | read | venue | missing | menu:read | GetModifierGroupParamsSchema | menuController.getModifierGroupHandler |
| PATCH | `/api/v1/dashboard/venues/:venueId/modifier-groups/:modifierGroupId` | mutation | venue | missing | menu:update | UpdateModifierGroupSchema | menuController.updateModifierGroupHandler |
| PUT | `/api/v1/dashboard/venues/:venueId/modifier-groups/:modifierGroupId` | mutation | venue | missing | menu:update | UpdateModifierGroupSchema | menuController.updateModifierGroupHandler |
| GET | `/api/v1/dashboard/venues/:venueId/modifier-groups/:modifierGroupId/modifiers` | read | venue | missing | menu:read | GetModifierGroupParamsSchema | menuController.listModifiersHandler |
| POST | `/api/v1/dashboard/venues/:venueId/modifier-groups/:modifierGroupId/modifiers` | action | venue | missing | menu:create | CreateModifierSchema | menuController.createModifierHandler |
| DELETE | `/api/v1/dashboard/venues/:venueId/modifier-groups/:modifierGroupId/modifiers/:modifierId` | dangerousMutation | venue | missing | menu:delete | GetModifierParamsSchema | menuController.deleteModifierHandler |
| GET | `/api/v1/dashboard/venues/:venueId/modifier-groups/:modifierGroupId/modifiers/:modifierId` | read | venue | missing | menu:read | GetModifierParamsSchema | menuController.getModifierHandler |
| PATCH | `/api/v1/dashboard/venues/:venueId/modifier-groups/:modifierGroupId/modifiers/:modifierId` | mutation | venue | missing | menu:update | UpdateModifierSchema | menuController.updateModifierHandler |
| PUT | `/api/v1/dashboard/venues/:venueId/modifier-groups/:modifierGroupId/modifiers/:modifierId` | mutation | venue | missing | menu:update | UpdateModifierSchema | menuController.updateModifierHandler |
| GET | `/api/v1/dashboard/venues/:venueId/modifiers/inventory/list` | read | venue | partial | inventory:read | GetModifiersWithInventorySchema | modifierInventoryAnalyticsController.getModifiersWithInventoryHandler |
| GET | `/api/v1/dashboard/venues/:venueId/modifiers/inventory/low-stock` | read | venue | partial | inventory:read | GetModifiersLowStockSchema | modifierInventoryAnalyticsController.getModifiersLowStockHandler |
| GET | `/api/v1/dashboard/venues/:venueId/modifiers/inventory/summary` | read | venue | partial | inventory:read | GetModifierInventorySummarySchema | modifierInventoryAnalyticsController.getModifierInventorySummaryHandler |
| GET | `/api/v1/dashboard/venues/:venueId/modifiers/inventory/usage` | read | venue | partial | inventory:read | GetModifierUsageStatsSchema | modifierInventoryAnalyticsController.getModifierUsageStatsHandler |
| GET | `/api/v1/dashboard/venues/:venueId/onboarding-state` | read | venue | missing | - | - | (inline handler) |
| DELETE | `/api/v1/dashboard/venues/:venueId/onboarding-state/:key` | dangerousMutation | venue | missing | - | - | (inline handler) |
| PUT | `/api/v1/dashboard/venues/:venueId/onboarding-state/:key` | mutation | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/orders` | read | venue | partial | orders:read | - | // Apunta al nuevo controlador |
| DELETE | `/api/v1/dashboard/venues/:venueId/orders/:orderId` | dangerousMutation | venue | partial | orders:delete | - | orderController.deleteOrder |
| GET | `/api/v1/dashboard/venues/:venueId/orders/:orderId` | read | venue | partial | orders:read | - | // Apunta al nuevo controlador |
| PUT | `/api/v1/dashboard/venues/:venueId/orders/:orderId` | mutation | venue | partial | orders:update | - | // Apunta al nuevo controlador |
| POST | `/api/v1/dashboard/venues/:venueId/orders/:orderId/cfdi` | action | venue | partial | cfdi:issue | issueCfdiSchema | issueCfdiForOrderController |
| POST | `/api/v1/dashboard/venues/:venueId/orders/:orderId/settle` | action | venue | partial | orders:update | SettleOrderSchema | orderController.settleOrder |
| GET | `/api/v1/dashboard/venues/:venueId/orders/export` | read | venue | partial | orders:read | - | orderController.exportOrdersData |
| GET | `/api/v1/dashboard/venues/:venueId/org-item-categories` | read | venue | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/venues/:venueId/org-item-categories` | action | venue | missing | - | - | (inline handler) |
| DELETE | `/api/v1/dashboard/venues/:venueId/org-item-categories/:categoryId` | dangerousMutation | venue | missing | - | - | (inline handler) |
| PUT | `/api/v1/dashboard/venues/:venueId/org-item-categories/:categoryId` | mutation | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/payment-config` | adminOnly | venue | blocked | system:config | - | venuePaymentConfigController.getVenuePaymentConfig |
| POST | `/api/v1/dashboard/venues/:venueId/payment-config` | adminOnly | venue | blocked | system:config | - | venuePaymentConfigController.createVenuePaymentConfig |
| DELETE | `/api/v1/dashboard/venues/:venueId/payment-config/:configId` | adminOnly | venue | blocked | system:config | - | venuePaymentConfigController.deleteVenuePaymentConfig |
| PUT | `/api/v1/dashboard/venues/:venueId/payment-config/:configId` | adminOnly | venue | blocked | system:config | - | venuePaymentConfigController.updateVenuePaymentConfig |
| GET | `/api/v1/dashboard/venues/:venueId/payment-config/cost-structures` | adminOnly | venue | blocked | system:config | - | venuePaymentConfigController.getVenueCostStructures |
| GET | `/api/v1/dashboard/venues/:venueId/payment-config/merchant-accounts` | read | venue | missing | settlements:read | - | venuePaymentConfigController.getVenueMerchantAccounts |
| GET | `/api/v1/dashboard/venues/:venueId/payment-config/pricing-structures` | adminOnly | venue | blocked | system:config | - | venuePaymentConfigController.getVenuePricingStructures |
| GET | `/api/v1/dashboard/venues/:venueId/payment-config/readiness` | adminOnly | venue | blocked | system:config | - | venuePaymentReadinessController.getVenuePaymentReadiness |
| GET | `/api/v1/dashboard/venues/:venueId/payment-config/settlement-info` | read | public | partial | settlements:read | - | venuePaymentConfigController.getVenueSettlementInfo |
| GET | `/api/v1/dashboard/venues/:venueId/payment-links` | read | venue | partial | payment-link:read | listPaymentLinksSchema | paymentLinkController.listPaymentLinks |
| POST | `/api/v1/dashboard/venues/:venueId/payment-links` | action | venue | partial | payment-link:read, payment-link:create | createPaymentLinkSchema | paymentLinkController.createPaymentLink |
| DELETE | `/api/v1/dashboard/venues/:venueId/payment-links/:linkId` | dangerousMutation | venue | partial | payment-link:read, payment-link:update | getPaymentLinkSchema | paymentLinkController.archivePaymentLink |
| GET | `/api/v1/dashboard/venues/:venueId/payment-links/:linkId` | read | venue | partial | payment-link:read | getPaymentLinkSchema | paymentLinkController.getPaymentLink |
| PUT | `/api/v1/dashboard/venues/:venueId/payment-links/:linkId` | mutation | venue | partial | payment-link:read, payment-link:update | updatePaymentLinkSchema | paymentLinkController.updatePaymentLink |
| POST | `/api/v1/dashboard/venues/:venueId/payment-links/:linkId/share-whatsapp` | action | venue | partial | payment-link:read | sharePaymentLinkWhatsappSchema | paymentLinkController.shareViaWhatsapp |
| GET | `/api/v1/dashboard/venues/:venueId/payment-links/branding/config` | read | venue | partial | payment-link:read | - | paymentLinkController.getPaymentLinkBranding |
| PUT | `/api/v1/dashboard/venues/:venueId/payment-links/branding/config` | mutation | venue | partial | payment-link:read, payment-link:update | updatePaymentLinkBrandingSchema | paymentLinkController.updatePaymentLinkBranding |
| GET | `/api/v1/dashboard/venues/:venueId/payment-links/settings` | read | venue | partial | payment-link:read | - | paymentLinkController.getPaymentLinkSettingsHandler |
| PATCH | `/api/v1/dashboard/venues/:venueId/payment-links/settings` | mutation | venue | partial | payment-link:read, payment-link:update | updatePaymentLinkSettingsSchema | paymentLinkController.updatePaymentLinkSettingsHandler |
| PUT | `/api/v1/dashboard/venues/:venueId/payment-method` | mutation | venue | partial | venues:manage | updatePaymentMethodSchema | venueController.updateVenuePaymentMethod |
| GET | `/api/v1/dashboard/venues/:venueId/payment-methods` | read | venue | partial | billing:payment-methods:read | - | venueController.listVenuePaymentMethods |
| DELETE | `/api/v1/dashboard/venues/:venueId/payment-methods/:paymentMethodId` | dangerousMutation | venue | partial | billing:payment-methods:manage | - | venueController.detachVenuePaymentMethod |
| PUT | `/api/v1/dashboard/venues/:venueId/payment-methods/set-default` | mutation | venue | partial | billing:payment-methods:manage | - | venueController.setVenueDefaultPaymentMethod |
| GET | `/api/v1/dashboard/venues/:venueId/payments` | read | venue | partial | payments:read | - | paymentController.getPaymentsData |
| DELETE | `/api/v1/dashboard/venues/:venueId/payments/:paymentId` | dangerousMutation | venue | partial | payments:delete | - | // SUPERADMIN only paymentController.deletePayment |
| GET | `/api/v1/dashboard/venues/:venueId/payments/:paymentId` | read | venue | partial | payments:read | - | // Allows WAITER+ to view payment details (read-only) paymentController.getPayment |
| PUT | `/api/v1/dashboard/venues/:venueId/payments/:paymentId` | mutation | venue | partial | payments:update | - | // SUPERADMIN only paymentController.updatePayment |
| GET | `/api/v1/dashboard/venues/:venueId/payments/:paymentId/receipts` | read | venue | partial | payments:read | - | // Allows WAITER+ to view payment receipts (read-only) paymentController.getPaymentReceipts |
| POST | `/api/v1/dashboard/venues/:venueId/payments/:paymentId/refund` | dangerousMutation | venue | partial | payments:refund | - | refundController.issueRefund |
| GET | `/api/v1/dashboard/venues/:venueId/payments/:paymentId/refunds` | read | venue | partial | payments:read | - | refundController.listRefunds |
| POST | `/api/v1/dashboard/venues/:venueId/payments/:paymentId/send-receipt` | action | venue | partial | payments:refund | - | // Requires MANAGER+ to send receipts (administrative action) paymentController.sendPaymentReceipt |
| GET | `/api/v1/dashboard/venues/:venueId/payments/export` | read | venue | partial | payments:read | - | paymentController.exportPaymentsData |
| GET | `/api/v1/dashboard/venues/:venueId/payments/external-sources` | read | venue | partial | payment:create-manual | getExternalSourcesSchema | manualPaymentController.getExternalSources |
| POST | `/api/v1/dashboard/venues/:venueId/payments/manual` | action | venue | partial | payment:create-manual | createManualPaymentSchema | manualPaymentController.createManualPayment |
| GET | `/api/v1/dashboard/venues/:venueId/payments/waiters` | read | venue | partial | payment:create-manual | - | manualPaymentController.getEligibleWaiters |
| GET | `/api/v1/dashboard/venues/:venueId/permission-sets` | read | venue | partial | settings:manage | - | permissionSetController.getAll |
| POST | `/api/v1/dashboard/venues/:venueId/permission-sets` | action | venue | partial | settings:manage | CreatePermissionSetSchema | permissionSetController.create |
| DELETE | `/api/v1/dashboard/venues/:venueId/permission-sets/:id` | dangerousMutation | venue | partial | settings:manage | - | permissionSetController.remove |
| GET | `/api/v1/dashboard/venues/:venueId/permission-sets/:id` | read | venue | partial | settings:manage | - | permissionSetController.getById |
| PUT | `/api/v1/dashboard/venues/:venueId/permission-sets/:id` | mutation | venue | partial | settings:manage | UpdatePermissionSetSchema | permissionSetController.update |
| POST | `/api/v1/dashboard/venues/:venueId/permission-sets/:id/duplicate` | action | venue | partial | settings:manage | DuplicatePermissionSetSchema | permissionSetController.duplicate |
| GET | `/api/v1/dashboard/venues/:venueId/plan` | read | venue | missing | billing:subscriptions:read | planParamsSchema | venueController.getVenuePlan |
| GET | `/api/v1/dashboard/venues/:venueId/plan-tier` | read | venue | missing | home:read | planParamsSchema | venueController.getVenuePlanTier |
| POST | `/api/v1/dashboard/venues/:venueId/plan/cancel` | dangerousMutation | venue | missing | billing:subscriptions:manage | planParamsSchema | venueController.cancelVenuePlan |
| POST | `/api/v1/dashboard/venues/:venueId/plan/checkout` | action | venue | missing | billing:subscriptions:manage | createPlanCheckoutSessionSchema | venueController.createVenuePlanCheckoutSession |
| POST | `/api/v1/dashboard/venues/:venueId/plan/downgrade` | action | venue | missing | billing:subscriptions:manage | downgradeToFreeSchema | venueController.downgradeVenueToFree |
| GET | `/api/v1/dashboard/venues/:venueId/plan/downgrade-preview` | read | venue | missing | billing:subscriptions:read | planParamsSchema | venueController.getVenueDowngradePreview |
| POST | `/api/v1/dashboard/venues/:venueId/plan/reactivate` | action | venue | missing | billing:subscriptions:manage | planParamsSchema | venueController.reactivateVenuePlan |
| POST | `/api/v1/dashboard/venues/:venueId/plan/retention-offer` | action | venue | missing | billing:subscriptions:manage | applyRetentionOfferSchema | venueController.applyVenueRetentionOffer |
| GET | `/api/v1/dashboard/venues/:venueId/plan/seat-status` | read | venue | missing | teams:read | planParamsSchema | venueController.getVenueSeatStatus |
| GET | `/api/v1/dashboard/venues/:venueId/print-stations` | read | venue | missing | printers:read | venueParamSchema | controller.listStations |
| POST | `/api/v1/dashboard/venues/:venueId/print-stations` | action | venue | missing | printers:manage | createStationSchema | controller.createStation |
| DELETE | `/api/v1/dashboard/venues/:venueId/print-stations/:stationId` | dangerousMutation | venue | missing | printers:manage | stationParamSchema | controller.deleteStation |
| PUT | `/api/v1/dashboard/venues/:venueId/print-stations/:stationId` | mutation | venue | missing | printers:manage | updateStationSchema | controller.updateStation |
| GET | `/api/v1/dashboard/venues/:venueId/print-stations/gateway` | read | venue | missing | printers:read | venueParamSchema | controller.getGateway |
| PUT | `/api/v1/dashboard/venues/:venueId/print-stations/gateway` | mutation | venue | missing | printers:manage | upsertGatewaySchema | controller.upsertGateway |
| GET | `/api/v1/dashboard/venues/:venueId/print-stations/printers` | read | venue | missing | printers:read | venueParamSchema | controller.listPrinters |
| POST | `/api/v1/dashboard/venues/:venueId/print-stations/printers` | action | venue | missing | printers:manage | createPrinterSchema | controller.createPrinter |
| DELETE | `/api/v1/dashboard/venues/:venueId/print-stations/printers/:printerId` | dangerousMutation | venue | missing | printers:manage | printerParamSchema | controller.deletePrinter |
| PUT | `/api/v1/dashboard/venues/:venueId/print-stations/printers/:printerId` | mutation | venue | missing | printers:manage | updatePrinterSchema | controller.updatePrinter |
| GET | `/api/v1/dashboard/venues/:venueId/print-stations/routing` | read | venue | missing | printers:read | venueParamSchema | controller.getRouting |
| PUT | `/api/v1/dashboard/venues/:venueId/print-stations/routing` | mutation | venue | missing | printers:manage | assignRoutingSchema | controller.assignRouting |
| POST | `/api/v1/dashboard/venues/:venueId/print-stations/routing/preview` | action | venue | missing | printers:read | previewRoutingSchema | controller.previewRouting |
| GET | `/api/v1/dashboard/venues/:venueId/product-types` | read | venue | partial | menu:read | VenueIdParamsSchema | productController.getProductTypesHandler |
| GET | `/api/v1/dashboard/venues/:venueId/products` | read | venue | partial | - | - | getProductsData |
| GET | `/api/v1/dashboard/venues/:venueId/products` | read | venue | partial | menu:read | VenueIdParamsSchema | productController.getProductsHandler |
| POST | `/api/v1/dashboard/venues/:venueId/products` | action | venue | partial | menu:create | CreateProductSchema | productController.createProductHandler |
| DELETE | `/api/v1/dashboard/venues/:venueId/products/:productId` | dangerousMutation | venue | partial | menu:delete | GetProductParamsSchema | productController.deleteProductHandler |
| GET | `/api/v1/dashboard/venues/:venueId/products/:productId` | read | venue | partial | menu:read | GetProductParamsSchema | productController.getProductHandler |
| PUT | `/api/v1/dashboard/venues/:venueId/products/:productId` | mutation | venue | partial | menu:update | UpdateProductSchema | productController.updateProductHandler |
| PATCH | `/api/v1/dashboard/venues/:venueId/products/:productId/image` | mutation | venue | partial | menu:update | GetProductParamsSchema | productController.deleteProductImageHandler |
| POST | `/api/v1/dashboard/venues/:venueId/products/:productId/modifier-groups` | action | venue | partial | menu:update | AssignModifierGroupToProductSchema | menuController.assignModifierGroupToProductHandler |
| DELETE | `/api/v1/dashboard/venues/:venueId/products/:productId/modifier-groups/:modifierGroupId` | dangerousMutation | venue | partial | menu:update | RemoveModifierGroupFromProductParamsSchema | menuController.removeModifierGroupFromProductHandler |
| PUT | `/api/v1/dashboard/venues/:venueId/products/reorder` | mutation | venue | partial | menu:update | ReorderProductsSchema | menuController.reorderProductsHandler |
| GET | `/api/v1/dashboard/venues/:venueId/promoters` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/promoters/:promoterId` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/promoters/:promoterId/deposits` | read | venue | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/venues/:venueId/promoters/:promoterId/deposits/:depositId/approve` | dangerousMutation | venue | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/venues/:venueId/promoters/:promoterId/deposits/:depositId/reject` | action | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/promoters/:promoterId/track` | read | venue | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/venues/:venueId/reactivate` | action | venue | missing | venues:manage | - | venueController.reactivateVenue |
| GET | `/api/v1/dashboard/venues/:venueId/receipts/:receiptId` | read | venue | missing | payments:read | - | paymentController.getReceiptById |
| GET | `/api/v1/dashboard/venues/:venueId/referrals` | read | venue | missing | referral:read | ListReferralsQuerySchema | referralsController.listReferralsHandler |
| POST | `/api/v1/dashboard/venues/:venueId/referrals/:referralId/manual-void` | dangerousMutation | venue | missing | referral:void-manual | ManualVoidReferralSchema | referralsController.manualVoid |
| POST | `/api/v1/dashboard/venues/:venueId/referrals/activate` | action | venue | missing | referral:configure | ActivateReferralProgramSchema | referralsController.activate |
| POST | `/api/v1/dashboard/venues/:venueId/referrals/capture` | action | venue | missing | referral:read | CaptureReferralSchema | referralsController.captureCode |
| GET | `/api/v1/dashboard/venues/:venueId/referrals/config` | read | venue | missing | referral:read | - | referralsController.getConfig |
| PATCH | `/api/v1/dashboard/venues/:venueId/referrals/config` | mutation | venue | missing | referral:configure | UpdateReferralConfigSchema | referralsController.updateConfig |
| POST | `/api/v1/dashboard/venues/:venueId/referrals/customers/:customerId/generate-code` | action | venue | partial | referral:read | - | referralsController.generateCustomerCodeHandler |
| GET | `/api/v1/dashboard/venues/:venueId/referrals/customers/:customerId/referrals` | read | venue | partial | referral:read | - | referralsController.getCustomerReferralsHandler |
| GET | `/api/v1/dashboard/venues/:venueId/referrals/customers/:customerId/share-link` | read | venue | partial | referral:read | - | referralsController.getShareLink |
| POST | `/api/v1/dashboard/venues/:venueId/referrals/deactivate` | action | venue | missing | referral:configure | DeactivateReferralProgramSchema | referralsController.deactivate |
| POST | `/api/v1/dashboard/venues/:venueId/referrals/force-override` | action | venue | missing | referral:override-existing-customer | ForceOverrideReferralSchema | referralsController.forceOverride |
| POST | `/api/v1/dashboard/venues/:venueId/referrals/grants/:grantId/fulfill` | action | venue | missing | referral:fulfill-courtesy | FulfillGrantSchema | referralsController.fulfillGrantHandler |
| GET | `/api/v1/dashboard/venues/:venueId/referrals/hall-of-fame` | read | venue | missing | referral:read | - | referralsController.getHallOfFameHandler |
| GET | `/api/v1/dashboard/venues/:venueId/referrals/summary` | read | venue | partial | referral:read | - | referralsController.getSummary |
| POST | `/api/v1/dashboard/venues/:venueId/referrals/validate` | action | venue | missing | referral:read | ValidateReferralCodeSchema | referralsController.validate |
| GET | `/api/v1/dashboard/venues/:venueId/reservations` | read | venue | partial | reservations:read | z.object | controller.getReservations |
| POST | `/api/v1/dashboard/venues/:venueId/reservations` | action | venue | partial | reservations:create | z.object | controller.createReservation |
| DELETE | `/api/v1/dashboard/venues/:venueId/reservations/:id` | dangerousMutation | venue | partial | reservations:cancel | - | controller.deleteReservation |
| GET | `/api/v1/dashboard/venues/:venueId/reservations/:id` | read | venue | partial | reservations:read | - | controller.getReservation |
| PUT | `/api/v1/dashboard/venues/:venueId/reservations/:id` | mutation | venue | partial | reservations:update | z.object | controller.updateReservation |
| POST | `/api/v1/dashboard/venues/:venueId/reservations/:id/check-in` | action | venue | partial | reservations:update | - | controller.checkInReservation |
| POST | `/api/v1/dashboard/venues/:venueId/reservations/:id/complete` | dangerousMutation | venue | partial | reservations:update | - | controller.completeReservation |
| POST | `/api/v1/dashboard/venues/:venueId/reservations/:id/confirm` | action | venue | partial | reservations:update | - | controller.confirmReservation |
| POST | `/api/v1/dashboard/venues/:venueId/reservations/:id/no-show` | action | venue | partial | reservations:update | - | controller.markNoShow |
| POST | `/api/v1/dashboard/venues/:venueId/reservations/:id/reschedule` | action | venue | partial | reservations:update | z.object | controller.rescheduleReservation |
| GET | `/api/v1/dashboard/venues/:venueId/reservations/availability` | read | venue | partial | reservations:read | z.object | controller.getAvailability |
| GET | `/api/v1/dashboard/venues/:venueId/reservations/branding/config` | read | venue | partial | reservations:read | - | controller.getReservationBranding |
| PUT | `/api/v1/dashboard/venues/:venueId/reservations/branding/config` | mutation | venue | partial | reservations:update | updateReservationBrandingSchema | controller.updateReservationBranding |
| GET | `/api/v1/dashboard/venues/:venueId/reservations/calendar` | read | venue | partial | reservations:read | z.object | controller.getCalendar |
| GET | `/api/v1/dashboard/venues/:venueId/reservations/settings` | read | venue | partial | reservations:read | - | controller.getSettings |
| PUT | `/api/v1/dashboard/venues/:venueId/reservations/settings` | mutation | venue | partial | reservations:update | z.object | controller.updateSettings |
| GET | `/api/v1/dashboard/venues/:venueId/reservations/stats` | read | venue | partial | reservations:read | z.object | controller.getStats |
| GET | `/api/v1/dashboard/venues/:venueId/reservations/waitlist` | read | venue | partial | reservations:read | z.object | (inline handler) |
| POST | `/api/v1/dashboard/venues/:venueId/reservations/waitlist` | action | venue | partial | reservations:create | z.object | (inline handler) |
| DELETE | `/api/v1/dashboard/venues/:venueId/reservations/waitlist/:entryId` | dangerousMutation | venue | partial | reservations:cancel | z.object | (inline handler) |
| POST | `/api/v1/dashboard/venues/:venueId/reservations/waitlist/:entryId/promote` | action | venue | partial | reservations:update | z.object | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/reviews` | read | venue | covered | reviews:read | - | reviewController.getReviewsData |
| DELETE | `/api/v1/dashboard/venues/:venueId/reviews/:reviewId` | dangerousMutation | venue | covered | reviews:delete | - | // SUPERADMIN only reviewController.deleteReview |
| DELETE | `/api/v1/dashboard/venues/:venueId/role-config` | dangerousMutation | venue | partial | role-config:update | RoleConfigParamsSchema | venueRoleConfigController.resetRoleConfigs |
| GET | `/api/v1/dashboard/venues/:venueId/role-config` | read | venue | partial | role-config:read | RoleConfigParamsSchema | venueRoleConfigController.getRoleConfigs |
| PUT | `/api/v1/dashboard/venues/:venueId/role-config` | mutation | venue | partial | role-config:update | z.object | venueRoleConfigController.updateRoleConfigs |
| GET | `/api/v1/dashboard/venues/:venueId/role-permissions` | read | venue | partial | settings:manage | - | rolePermissionController.getAllRolePermissions |
| DELETE | `/api/v1/dashboard/venues/:venueId/role-permissions/:role` | dangerousMutation | venue | partial | settings:manage | - | rolePermissionController.deleteRolePermissions |
| GET | `/api/v1/dashboard/venues/:venueId/role-permissions/:role` | read | venue | partial | settings:manage | - | rolePermissionController.getRolePermissions |
| PUT | `/api/v1/dashboard/venues/:venueId/role-permissions/:role` | mutation | venue | partial | settings:manage | - | rolePermissionController.updateRolePermissions |
| GET | `/api/v1/dashboard/venues/:venueId/sale-verifications` | read | venue | missing | payments:read | - | saleVerificationController.listSaleVerifications |
| PATCH | `/api/v1/dashboard/venues/:venueId/sale-verifications/:id/review` | mutation | venue | missing | sale-verifications:review | - | saleVerificationController.reviewSaleVerification |
| GET | `/api/v1/dashboard/venues/:venueId/sale-verifications/daily` | read | venue | missing | payments:read | - | saleVerificationController.getDailySalesData |
| GET | `/api/v1/dashboard/venues/:venueId/sale-verifications/staff` | read | venue | missing | payments:read | - | saleVerificationController.getStaffWithVerifications |
| GET | `/api/v1/dashboard/venues/:venueId/sale-verifications/summary` | read | venue | partial | payments:read | - | saleVerificationController.getSaleVerificationsSummary |
| PUT | `/api/v1/dashboard/venues/:venueId/serialized-inventory/categories/reorder` | mutation | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/serialized-inventory/items` | read | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/serialized-inventory/recent-sales` | read | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/serialized-inventory/summary` | read | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/settings` | read | venue | missing | venues:read | - | venueSettingsController.getVenueSettings |
| PUT | `/api/v1/dashboard/venues/:venueId/settings` | mutation | venue | missing | venues:update | UpdateVenueSettingsSchema | venueSettingsController.updateVenueSettings |
| GET | `/api/v1/dashboard/venues/:venueId/settings/tpv` | read | venue | missing | venues:read | - | venueSettingsController.getTpvSettings |
| PUT | `/api/v1/dashboard/venues/:venueId/settings/tpv` | mutation | venue | missing | venues:update | UpdateTpvSettingsSchema | venueSettingsController.updateTpvSettings |
| GET | `/api/v1/dashboard/venues/:venueId/settlement-incidents` | read | public | partial | settlements:read | incidentListQuerySchema | settlementIncidentController.getVenueIncidents |
| POST | `/api/v1/dashboard/venues/:venueId/settlement-incidents/:incidentId/confirm` | action | public | partial | settlements:write | confirmIncidentSchema | settlementIncidentController.confirmIncident |
| POST | `/api/v1/dashboard/venues/:venueId/settlement-incidents/bulk-confirm` | dangerousMutation | public | partial | settlements:write | bulkConfirmIncidentSchema | settlementIncidentController.bulkConfirmIncidents |
| GET | `/api/v1/dashboard/venues/:venueId/settlement-incidents/stats` | read | public | partial | settlements:read | - | settlementIncidentController.getVenueIncidentStats |
| POST | `/api/v1/dashboard/venues/:venueId/setup-intent` | action | venue | missing | venues:manage | - | venueController.createVenueSetupIntent |
| GET | `/api/v1/dashboard/venues/:venueId/shifts` | read | venue | partial | shifts:read | - | shiftController.getShifts |
| DELETE | `/api/v1/dashboard/venues/:venueId/shifts/:shiftId` | dangerousMutation | venue | partial | shifts:delete | - | shiftController.deleteShift |
| GET | `/api/v1/dashboard/venues/:venueId/shifts/:shiftId` | read | venue | partial | shifts:read | - | shiftController.getShift |
| PUT | `/api/v1/dashboard/venues/:venueId/shifts/:shiftId` | mutation | venue | partial | shifts:update | - | // SUPERADMIN only shiftController.updateShift |
| GET | `/api/v1/dashboard/venues/:venueId/shifts/summary` | read | venue | partial | shifts:read | - | shiftController.getShiftsSummary |
| GET | `/api/v1/dashboard/venues/:venueId/status-history` | read | venue | missing | venues:read | - | venueController.getVenueStatusHistory |
| GET | `/api/v1/dashboard/venues/:venueId/stock/alerts` | read | venue | partial | - | - | (inline handler) |
| POST | `/api/v1/dashboard/venues/:venueId/stock/alerts/configure` | action | venue | partial | - | - | (inline handler) |
| POST | `/api/v1/dashboard/venues/:venueId/stock/bulk-upload` | dangerousMutation | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stock/categories` | read | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stock/chart` | read | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stock/item-categories` | read | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stock/metrics` | read | venue | partial | - | - | (inline handler) |
| POST | `/api/v1/dashboard/venues/:venueId/stock/org-bulk-upload` | dangerousMutation | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stock/responsibles` | read | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/activity-feed` | read | venue | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/venues/:venueId/stores-analysis/admin/reset-password/:userId` | dangerousMutation | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/anomalies` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/attendance-heatmap` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/charts/revenue-vs-target` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/charts/volume-vs-target` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/closing-report` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/closing-report/download` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/insights/top-promoter` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/insights/worst-attendance` | read | venue | missing | - | - | (inline handler) |
| DELETE | `/api/v1/dashboard/venues/:venueId/stores-analysis/org-attendance-config` | dangerousMutation | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/org-attendance-config` | read | venue | missing | - | - | (inline handler) |
| PUT | `/api/v1/dashboard/venues/:venueId/stores-analysis/org-attendance-config` | mutation | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/org-goals` | read | venue | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/venues/:venueId/stores-analysis/org-goals` | action | venue | missing | - | - | (inline handler) |
| DELETE | `/api/v1/dashboard/venues/:venueId/stores-analysis/org-goals/:goalId` | dangerousMutation | venue | missing | - | - | (inline handler) |
| PATCH | `/api/v1/dashboard/venues/:venueId/stores-analysis/org-goals/:goalId` | mutation | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/org-tpv-defaults` | read | venue | missing | - | - | (inline handler) |
| PUT | `/api/v1/dashboard/venues/:venueId/stores-analysis/org-tpv-defaults` | mutation | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/org-tpv-defaults/stats` | read | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/overview` | read | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/sales-heatmap` | read | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/staff-attendance` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/staff/online` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/stock-summary` | read | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/store-performance` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/store/:storeId/goals` | read | venue | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/venues/:venueId/stores-analysis/store/:storeId/goals` | action | venue | missing | - | - | (inline handler) |
| DELETE | `/api/v1/dashboard/venues/:venueId/stores-analysis/store/:storeId/goals/:goalId` | dangerousMutation | venue | missing | - | - | (inline handler) |
| PATCH | `/api/v1/dashboard/venues/:venueId/stores-analysis/store/:storeId/goals/:goalId` | mutation | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/store/:storeId/sales-trend` | read | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/store/:storeId/summary` | read | venue | partial | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/team/:staffId/activity` | read | venue | partial | - | - | (inline handler) |
| PATCH | `/api/v1/dashboard/venues/:venueId/stores-analysis/team/:staffId/venues` | mutation | venue | partial | - | - | (inline handler) |
| POST | `/api/v1/dashboard/venues/:venueId/stores-analysis/time-entry/:timeEntryId/reset-validation` | dangerousMutation | venue | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/venues/:venueId/stores-analysis/time-entry/:timeEntryId/validate` | action | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/venues` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/stores-analysis/zones` | read | venue | missing | - | - | (inline handler) |
| GET | `/api/v1/dashboard/venues/:venueId/supervisor/terminals-locations` | read | venue | missing | - | - | (inline handler) |
| POST | `/api/v1/dashboard/venues/:venueId/suspend` | action | venue | missing | venues:manage | - | venueController.suspendVenue |
| GET | `/api/v1/dashboard/venues/:venueId/team` | read | venue | partial | teams:read | z.object | teamController.getTeamMembers |
| POST | `/api/v1/dashboard/venues/:venueId/team` | action | venue | partial | teams:invite | InviteTeamMemberSchema | teamController.inviteTeamMember |
| DELETE | `/api/v1/dashboard/venues/:venueId/team/:teamMemberId` | dangerousMutation | venue | partial | teams:delete | TeamMemberParamsSchema | teamController.removeTeamMember |
| GET | `/api/v1/dashboard/venues/:venueId/team/:teamMemberId` | read | venue | partial | teams:read | TeamMemberParamsSchema | teamController.getTeamMember |
| PATCH | `/api/v1/dashboard/venues/:venueId/team/:teamMemberId` | mutation | venue | partial | teams:update | UpdateTeamMemberSchema | teamController.updateTeamMember |
| DELETE | `/api/v1/dashboard/venues/:venueId/team/:teamMemberId/hard-delete` | adminOnly | venue | blocked | - | TeamMemberParamsSchema | teamController.hardDeleteTeamMember |
| PUT | `/api/v1/dashboard/venues/:venueId/team/:teamMemberId/permission-set` | mutation | venue | partial | settings:manage | - | teamController.assignPermissionSet |
| GET | `/api/v1/dashboard/venues/:venueId/team/invitations` | read | venue | partial | teams:read | TeamVenueIdParamsSchema | teamController.getPendingInvitations |
| DELETE | `/api/v1/dashboard/venues/:venueId/team/invitations/:invitationId` | dangerousMutation | venue | partial | teams:delete | InvitationParamsSchema | teamController.cancelInvitation |
| POST | `/api/v1/dashboard/venues/:venueId/team/invitations/:invitationId/resend` | action | venue | partial | teams:invite | InvitationParamsSchema | teamController.resendInvitation |
| GET | `/api/v1/dashboard/venues/:venueId/tpv-commands` | read | venue | missing | tpv-commands:read | commandsQuerySchema | tpvCommandController.getCommands as any |
| POST | `/api/v1/dashboard/venues/:venueId/tpv-commands` | action | venue | missing | tpv-commands:write | sendCommandSchema | tpvCommandController.sendCommand |
| GET | `/api/v1/dashboard/venues/:venueId/tpv-commands/:commandId` | read | venue | missing | tpv-commands:read | - | tpvCommandController.getCommandStatus |
| POST | `/api/v1/dashboard/venues/:venueId/tpv-commands/:commandId/cancel` | dangerousMutation | venue | missing | tpv-commands:write | - | tpvCommandController.cancelCommand |
| POST | `/api/v1/dashboard/venues/:venueId/tpv-commands/:commandId/retry` | action | venue | missing | tpv-commands:write | - | tpvCommandController.retryCommand |
| POST | `/api/v1/dashboard/venues/:venueId/tpv-commands/bulk` | dangerousMutation | venue | missing | tpv-commands:bulk | bulkCommandSchema | tpvCommandController.sendBulkCommand |
| GET | `/api/v1/dashboard/venues/:venueId/tpv-commands/bulk-operations` | read | venue | missing | tpv-commands:read | bulkOperationsQuerySchema | tpvCommandController.getBulkOperations as any |
| GET | `/api/v1/dashboard/venues/:venueId/tpv-commands/bulk-operations/:operationId` | read | venue | missing | tpv-commands:read | - | tpvCommandController.getBulkOperationStatus |
| GET | `/api/v1/dashboard/venues/:venueId/tpv-commands/geofence` | read | venue | missing | tpv-commands:read | geofenceRulesQuerySchema | tpvCommandController.getGeofenceRules as any |
| POST | `/api/v1/dashboard/venues/:venueId/tpv-commands/geofence` | action | venue | missing | tpv-commands:geofence | createGeofenceRuleSchema | tpvCommandController.createGeofenceRule |
| DELETE | `/api/v1/dashboard/venues/:venueId/tpv-commands/geofence/:ruleId` | dangerousMutation | venue | missing | tpv-commands:geofence | - | tpvCommandController.deleteGeofenceRule |
| GET | `/api/v1/dashboard/venues/:venueId/tpv-commands/geofence/:ruleId` | read | venue | missing | tpv-commands:read | - | tpvCommandController.getGeofenceRule |
| PUT | `/api/v1/dashboard/venues/:venueId/tpv-commands/geofence/:ruleId` | mutation | venue | missing | tpv-commands:geofence | updateGeofenceRuleSchema | tpvCommandController.updateGeofenceRule |
| GET | `/api/v1/dashboard/venues/:venueId/tpv-commands/history` | read | venue | missing | tpv-commands:read | commandHistoryQuerySchema | tpvCommandController.getCommandHistory as any |
| GET | `/api/v1/dashboard/venues/:venueId/tpv-commands/scheduled` | read | venue | missing | tpv-commands:read | scheduledCommandsQuerySchema | tpvCommandController.getScheduledCommands as any |
| POST | `/api/v1/dashboard/venues/:venueId/tpv-commands/scheduled` | action | venue | missing | tpv-commands:schedule | createScheduledCommandSchema | tpvCommandController.createScheduledCommand |
| DELETE | `/api/v1/dashboard/venues/:venueId/tpv-commands/scheduled/:scheduleId` | dangerousMutation | venue | missing | tpv-commands:schedule | - | tpvCommandController.deleteScheduledCommand |
| GET | `/api/v1/dashboard/venues/:venueId/tpv-commands/scheduled/:scheduleId` | read | venue | missing | tpv-commands:read | - | tpvCommandController.getScheduledCommand |
| PUT | `/api/v1/dashboard/venues/:venueId/tpv-commands/scheduled/:scheduleId` | mutation | venue | missing | tpv-commands:schedule | updateScheduledCommandSchema | tpvCommandController.updateScheduledCommand |
| GET | `/api/v1/dashboard/venues/:venueId/tpv-orders` | read | venue | partial | - | - | terminalOrderController.listOrdersHandler |
| POST | `/api/v1/dashboard/venues/:venueId/tpv-orders` | action | venue | partial | - | createTerminalOrderSchema | terminalOrderController.createOrderHandler |
| GET | `/api/v1/dashboard/venues/:venueId/tpv-orders/:id` | read | venue | partial | - | - | terminalOrderController.getOrderHandler |
| POST | `/api/v1/dashboard/venues/:venueId/tpv-orders/:id/upload-proof` | action | venue | partial | - | - | terminalOrderController.uploadProofHandler |
| POST | `/api/v1/dashboard/venues/:venueId/tpv/:terminalId/activation-code` | action | venue | missing | tpv:update | generateActivationCodeSchema | tpvController.generateActivationCode |
| DELETE | `/api/v1/dashboard/venues/:venueId/tpv/:tpvId` | dangerousMutation | venue | missing | tpv:delete | - | tpvController.deleteTpv |
| GET | `/api/v1/dashboard/venues/:venueId/tpv/:tpvId` | read | venue | missing | tpv:read | - | tpvController.getTpvById |
| PUT | `/api/v1/dashboard/venues/:venueId/tpv/:tpvId` | mutation | venue | missing | tpv:update | - | tpvController.updateTpv |
| POST | `/api/v1/dashboard/venues/:venueId/tpv/:tpvId/command` | action | venue | missing | tpv:command | - | tpvController.sendTpvCommand |
| PATCH | `/api/v1/dashboard/venues/:venueId/tpv/:tpvId/deactivate` | adminOnly | venue | blocked | - | - | tpvController.deactivateTpv |
| GET | `/api/v1/dashboard/venues/:venueId/tpv/:tpvId/health` | read | public | missing | tpv:read | - | tpvController.getTerminalHealth |
| GET | `/api/v1/dashboard/venues/:venueId/tpvs` | read | venue | missing | tpv:read | - | tpvController.getTerminals |
| POST | `/api/v1/dashboard/venues/:venueId/tpvs` | action | venue | missing | tpv:create | - | tpvController.createTpv |
| PATCH | `/api/v1/dashboard/venues/:venueId/tpvs/:tpvId/activate` | mutation | venue | missing | tpv:update | - | tpvController.activateTerminal |
| GET | `/api/v1/dashboard/venues/:venueId/tpvs/health` | read | public | missing | tpv:read | - | tpvController.getVenueTerminalHealth |
| POST | `/api/v1/dashboard/venues/:venueId/upload-document` | action | venue | missing | venues:manage | - | venueController.uploadVenueDocument |
| POST | `/api/v1/dashboard/venues/enhanced` | action | unknown | missing | venues:manage | enhancedCreateVenueSchema | venueController.createEnhancedVenue |
| GET | `/api/v1/dashboard/venues/slug/:slug` | read | unknown | missing | venues:read | - | venueController.getVenueBySlug |
| GET | `/api/v1/delivery-channels/venues/:venueId/channels` | read | venue | missing | delivery-channels:read | - | ctrl.listChannels |
| POST | `/api/v1/delivery-channels/venues/:venueId/channels` | action | venue | missing | delivery-channels:manage | createChannelSchema | ctrl.createChannel |
| PATCH | `/api/v1/delivery-channels/venues/:venueId/channels/:linkId` | mutation | venue | missing | delivery-channels:manage | updateChannelSchema | ctrl.updateChannel |
| POST | `/api/v1/delivery-channels/venues/:venueId/channels/:linkId/pause` | action | venue | missing | delivery-channels:manage | pauseChannelSchema | ctrl.pauseChannel |
| GET | `/api/v1/demo/generate` | read | unknown | missing | - | - | (inline handler) |
| GET | `/api/v1/google-calendar/connections` | read | unknown | missing | - | - | listConnections |
| POST | `/api/v1/google-calendar/connections` | action | unknown | missing | - | - | postConnection |
| DELETE | `/api/v1/google-calendar/connections/:id` | dangerousMutation | unknown | missing | - | - | disconnectConnection |
| GET | `/api/v1/google-calendar/connections/:id` | read | unknown | missing | - | - | getConnectionDetail |
| GET | `/api/v1/google-calendar/oauth/calendars` | read | unknown | missing | - | - | listCalendars |
| GET | `/api/v1/google-calendar/oauth/callback` | read | unknown | missing | - | - | oauthCallback |
| GET | `/api/v1/google-calendar/oauth/init` | read | unknown | missing | - | - | oauthInit |
| GET | `/api/v1/integrations/mercadopago/oauth/callback` | read | unknown | missing | - | - | callback |
| GET | `/api/v1/integrations/mercadopago/oauth/connect` | read | unknown | missing | - | - | initiate |
| DELETE | `/api/v1/integrations/mercadopago/venues/:venueId/ecommerce-merchants/:merchantId/oauth` | dangerousMutation | venue | missing | - | - | disconnect |
| GET | `/api/v1/invitations/:token` | read | unknown | missing | - | InvitationTokenParamsSchema | invitationController.getInvitationByToken |
| POST | `/api/v1/invitations/:token/accept` | action | unknown | missing | - | AcceptInvitationSchema | invitationController.acceptInvitation |
| GET | `/api/v1/live-demo/auto-login` | read | unknown | missing | - | - | liveDemoController.autoLoginController |
| POST | `/api/v1/live-demo/extend` | action | unknown | missing | - | - | liveDemoController.extendSessionController |
| POST | `/api/v1/live-demo/sim/fast-payment` | action | unknown | missing | - | simFastPaymentBodySchema | liveDemoController.simFastPaymentController |
| POST | `/api/v1/live-demo/sim/payment-link` | action | unknown | missing | - | - | liveDemoController.simPaymentLinkController |
| POST | `/api/v1/live-demo/sim/reservation` | action | unknown | missing | - | - | liveDemoController.simReservationController |
| GET | `/api/v1/live-demo/status` | read | unknown | missing | - | - | liveDemoController.getStatusController |
| GET | `/api/v1/me/access` | read | unknown | missing | - | - | (inline handler) |
| GET | `/api/v1/me/venues` | read | unknown | missing | - | - | (inline handler) |
| DELETE | `/api/v1/mobile/account` | dangerousMutation | unknown | missing | - | - | authMobileController.deleteAccount |
| POST | `/api/v1/mobile/auth/login` | action | unknown | missing | - | - | authMobileController.login |
| POST | `/api/v1/mobile/auth/passkey/challenge` | action | unknown | missing | - | - | authMobileController.passkeyChallenge |
| POST | `/api/v1/mobile/auth/passkey/register/challenge` | action | unknown | missing | - | - | authMobileController.passkeyRegisterChallenge |
| POST | `/api/v1/mobile/auth/passkey/register/verify` | action | unknown | missing | - | - | authMobileController.passkeyRegisterVerify |
| POST | `/api/v1/mobile/auth/passkey/verify` | action | unknown | missing | - | - | authMobileController.passkeyVerify |
| GET | `/api/v1/mobile/auth/passkeys` | read | unknown | missing | - | - | authMobileController.listPasskeys |
| DELETE | `/api/v1/mobile/auth/passkeys/:passkeyId` | dangerousMutation | unknown | missing | - | - | authMobileController.deletePasskey |
| POST | `/api/v1/mobile/auth/refresh` | action | unknown | missing | - | - | authMobileController.refresh |
| POST | `/api/v1/mobile/auth/request-reset` | dangerousMutation | unknown | missing | - | - | authMobileController.requestReset |
| GET | `/api/v1/mobile/devices` | read | unknown | missing | - | - | pushMobileController.getMyDevices |
| POST | `/api/v1/mobile/devices/register` | action | unknown | missing | - | - | pushMobileController.registerDevice |
| POST | `/api/v1/mobile/devices/unregister` | action | unknown | missing | - | - | pushMobileController.unregisterDevice |
| GET | `/api/v1/mobile/notifications` | read | unknown | missing | - | - | notificationMobileController.getUserNotifications |
| DELETE | `/api/v1/mobile/notifications/:notificationId` | dangerousMutation | unknown | missing | - | - | notificationMobileController.deleteNotification |
| PATCH | `/api/v1/mobile/notifications/:notificationId/read` | mutation | unknown | missing | - | - | notificationMobileController.markAsRead |
| PATCH | `/api/v1/mobile/notifications/mark-all-read` | mutation | unknown | missing | - | - | notificationMobileController.markAllAsRead |
| GET | `/api/v1/mobile/notifications/unread-count` | read | unknown | missing | - | - | notificationMobileController.getUnreadCount |
| POST | `/api/v1/mobile/push/test` | action | unknown | missing | - | - | pushMobileController.sendTestPush |
| POST | `/api/v1/mobile/venues/:venueId/cash-drawer/close` | action | venue | missing | payments:create | - | cashDrawerMobileController.closeSession |
| GET | `/api/v1/mobile/venues/:venueId/cash-drawer/current` | read | venue | missing | payments:read | - | cashDrawerMobileController.getCurrent |
| GET | `/api/v1/mobile/venues/:venueId/cash-drawer/history` | read | venue | missing | payments:read | - | cashDrawerMobileController.getHistory |
| POST | `/api/v1/mobile/venues/:venueId/cash-drawer/open` | action | venue | missing | payments:create | - | cashDrawerMobileController.openSession |
| POST | `/api/v1/mobile/venues/:venueId/cash-drawer/pay-in` | action | venue | missing | payments:create | - | cashDrawerMobileController.payIn |
| POST | `/api/v1/mobile/venues/:venueId/cash-drawer/pay-out` | action | venue | missing | payments:create | - | cashDrawerMobileController.payOut |
| POST | `/api/v1/mobile/venues/:venueId/cash-drawer/sync` | action | venue | missing | payments:create | - | cashDrawerMobileController.syncEvents |
| GET | `/api/v1/mobile/venues/:venueId/cash-drawer/tender-breakdown` | read | venue | missing | payments:read | - | cashDrawerMobileController.getTenderBreakdown |
| GET | `/api/v1/mobile/venues/:venueId/categories` | read | venue | missing | menu:read | - | categoryMobileController.listCategories |
| POST | `/api/v1/mobile/venues/:venueId/categories` | action | venue | missing | menu:create | - | categoryMobileController.createCategory |
| DELETE | `/api/v1/mobile/venues/:venueId/categories/:categoryId` | dangerousMutation | venue | missing | menu:delete | - | categoryMobileController.deleteCategory |
| PATCH | `/api/v1/mobile/venues/:venueId/categories/:categoryId` | mutation | venue | missing | menu:update | - | categoryMobileController.updateCategory |
| GET | `/api/v1/mobile/venues/:venueId/coupons` | read | venue | missing | - | - | couponMobileController.listCoupons |
| POST | `/api/v1/mobile/venues/:venueId/coupons` | action | venue | missing | - | - | couponMobileController.createCoupon |
| DELETE | `/api/v1/mobile/venues/:venueId/coupons/:couponId` | dangerousMutation | venue | missing | - | - | couponMobileController.deleteCoupon |
| PUT | `/api/v1/mobile/venues/:venueId/coupons/:couponId` | mutation | venue | missing | - | - | couponMobileController.updateCoupon |
| POST | `/api/v1/mobile/venues/:venueId/coupons/validate` | action | venue | missing | - | - | couponMobileController.validateCoupon |
| POST | `/api/v1/mobile/venues/:venueId/credit-balances/:balanceId/redeem` | action | venue | missing | creditPacks:update | - | creditPackMobileController.redeemCredit |
| GET | `/api/v1/mobile/venues/:venueId/credit-packs` | read | venue | partial | creditPacks:read | - | creditPackMobileController.listPacks |
| POST | `/api/v1/mobile/venues/:venueId/credit-packs/:packId/sell` | action | venue | partial | creditPacks:create | - | creditPackMobileController.sellPack |
| GET | `/api/v1/mobile/venues/:venueId/customer-groups` | read | venue | missing | customers:read | - | customerGroupController.getCustomerGroups |
| GET | `/api/v1/mobile/venues/:venueId/customers` | read | venue | partial | customers:read | - | customerController.getCustomers |
| POST | `/api/v1/mobile/venues/:venueId/customers` | action | venue | partial | customers:create | - | customerController.createCustomer |
| GET | `/api/v1/mobile/venues/:venueId/customers/:customerId/credit-balance` | read | venue | partial | creditPacks:read | - | creditPackMobileController.getBalance |
| GET | `/api/v1/mobile/venues/:venueId/discounts` | read | venue | missing | - | - | discountMobileController.listDiscounts |
| POST | `/api/v1/mobile/venues/:venueId/discounts` | action | venue | missing | - | - | discountMobileController.createDiscount |
| DELETE | `/api/v1/mobile/venues/:venueId/discounts/:discountId` | dangerousMutation | venue | missing | - | - | discountMobileController.deleteDiscount |
| PUT | `/api/v1/mobile/venues/:venueId/discounts/:discountId` | mutation | venue | missing | - | - | discountMobileController.updateDiscount |
| GET | `/api/v1/mobile/venues/:venueId/end-of-day` | read | venue | missing | payments:read | - | cashDrawerMobileController.getEndOfDay |
| GET | `/api/v1/mobile/venues/:venueId/estimates` | read | venue | missing | orders:read | - | estimateMobileController.listEstimates |
| POST | `/api/v1/mobile/venues/:venueId/estimates` | action | venue | missing | orders:create | - | estimateMobileController.createEstimate |
| GET | `/api/v1/mobile/venues/:venueId/estimates/:estimateId` | read | venue | missing | orders:read | - | estimateMobileController.getEstimate |
| POST | `/api/v1/mobile/venues/:venueId/estimates/:estimateId/convert` | action | venue | missing | orders:create | - | estimateMobileController.convertToOrder |
| PUT | `/api/v1/mobile/venues/:venueId/estimates/:estimateId/status` | mutation | venue | missing | orders:create | - | estimateMobileController.updateStatus |
| POST | `/api/v1/mobile/venues/:venueId/fast` | action | venue | missing | payments:create | recordFastPaymentParamsSchema, recordPaymentBodySchema | paymentMobileController.recordFastPayment |
| GET | `/api/v1/mobile/venues/:venueId/inventory/raw-materials` | read | venue | partial | inventory:read | - | inventoryMobileController.getRawMaterials |
| GET | `/api/v1/mobile/venues/:venueId/inventory/stock-counts` | read | venue | partial | inventory:read | - | inventoryMobileController.getStockCounts |
| POST | `/api/v1/mobile/venues/:venueId/inventory/stock-counts` | action | venue | partial | inventory:create | - | inventoryMobileController.createStockCount |
| PUT | `/api/v1/mobile/venues/:venueId/inventory/stock-counts/:countId` | mutation | venue | partial | inventory:update | - | inventoryMobileController.updateStockCount |
| POST | `/api/v1/mobile/venues/:venueId/inventory/stock-counts/:countId/confirm` | action | venue | partial | inventory:adjust | - | inventoryMobileController.confirmStockCount |
| GET | `/api/v1/mobile/venues/:venueId/inventory/stock-overview` | read | venue | partial | inventory:read | - | inventoryMobileController.getStockOverview |
| GET | `/api/v1/mobile/venues/:venueId/kds/orders` | read | venue | partial | - | - | kdsMobileController.listKdsOrders |
| POST | `/api/v1/mobile/venues/:venueId/kds/orders` | action | venue | partial | - | - | kdsMobileController.createKdsOrder |
| POST | `/api/v1/mobile/venues/:venueId/kds/orders/:id/bump` | action | venue | partial | - | - | kdsMobileController.bumpKdsOrder |
| PUT | `/api/v1/mobile/venues/:venueId/kds/orders/:id/status` | mutation | venue | partial | - | - | kdsMobileController.updateKdsOrderStatus |
| GET | `/api/v1/mobile/venues/:venueId/measurement-units` | read | venue | missing | menu:read | - | measurementUnitMobileController.listMeasurementUnits |
| POST | `/api/v1/mobile/venues/:venueId/measurement-units` | action | venue | missing | menu:create | - | measurementUnitMobileController.createMeasurementUnit |
| DELETE | `/api/v1/mobile/venues/:venueId/measurement-units/:id` | dangerousMutation | venue | missing | menu:create | - | measurementUnitMobileController.deleteMeasurementUnit |
| GET | `/api/v1/mobile/venues/:venueId/orders` | read | venue | partial | orders:read | - | orderMobileController.listOrders |
| POST | `/api/v1/mobile/venues/:venueId/orders` | action | venue | partial | orders:create | - | orderMobileController.createOrder |
| DELETE | `/api/v1/mobile/venues/:venueId/orders/:orderId` | dangerousMutation | venue | partial | orders:cancel | - | orderMobileController.cancelOrder |
| GET | `/api/v1/mobile/venues/:venueId/orders/:orderId` | read | venue | partial | orders:read | - | orderMobileController.getOrder |
| POST | `/api/v1/mobile/venues/:venueId/orders/:orderId/assign` | action | venue | partial | orders:update | - | tableMobileController.assignOrder |
| POST | `/api/v1/mobile/venues/:venueId/orders/:orderId/comp` | action | venue | partial | orders:update | - | orderMobileController.compWholeOrder |
| POST | `/api/v1/mobile/venues/:venueId/orders/:orderId/details` | action | venue | partial | orders:update | - | orderMobileController.updateOrderDetails |
| POST | `/api/v1/mobile/venues/:venueId/orders/:orderId/discounts` | action | venue | partial | orders:update | - | orderMobileController.applyOrderDiscount |
| DELETE | `/api/v1/mobile/venues/:venueId/orders/:orderId/discounts/:orderDiscountId` | dangerousMutation | venue | partial | orders:update | - | orderMobileController.removeOrderDiscount |
| POST | `/api/v1/mobile/venues/:venueId/orders/:orderId/items` | action | venue | partial | orders:create | - | orderMobileController.addItemsToOrder |
| POST | `/api/v1/mobile/venues/:venueId/orders/:orderId/items/:itemId/comp` | action | venue | partial | orders:update | - | orderMobileController.compOrderItem |
| POST | `/api/v1/mobile/venues/:venueId/orders/:orderId/move` | action | venue | partial | orders:update | - | tableMobileController.moveOrder |
| POST | `/api/v1/mobile/venues/:venueId/orders/:orderId/pay` | action | venue | partial | payments:create | - | orderMobileController.payCash |
| POST | `/api/v1/mobile/venues/:venueId/orders/:orderId/split` | action | venue | partial | orders:update | - | orderMobileController.splitOrder |
| POST | `/api/v1/mobile/venues/:venueId/payments/:paymentId/customer` | action | venue | partial | payments:create | - | paymentMobileController.attachCustomerToPayment |
| POST | `/api/v1/mobile/venues/:venueId/payments/:paymentId/refund` | dangerousMutation | venue | partial | payments:refund | - | refundMobileController.issueAssociatedRefund |
| POST | `/api/v1/mobile/venues/:venueId/payments/customer` | action | venue | partial | payments:create | - | paymentMobileController.attachCustomerToLatestPayment |
| GET | `/api/v1/mobile/venues/:venueId/print-config` | read | venue | missing | orders:read | printConfigParamSchema | printMobileController.getPrintConfig |
| POST | `/api/v1/mobile/venues/:venueId/print-gateway/heartbeat` | action | venue | missing | orders:read | gatewayHeartbeatSchema | printMobileController.gatewayHeartbeat |
| POST | `/api/v1/mobile/venues/:venueId/print-jobs/sync` | action | venue | missing | orders:update | syncPrintJobsSchema | printMobileController.syncPrintJobs |
| GET | `/api/v1/mobile/venues/:venueId/product-options` | read | venue | partial | menu:read | - | productOptionMobileController.listProductOptions |
| POST | `/api/v1/mobile/venues/:venueId/product-options` | action | venue | partial | menu:create | - | productOptionMobileController.createProductOption |
| DELETE | `/api/v1/mobile/venues/:venueId/product-options/:optionId` | dangerousMutation | venue | partial | menu:create | - | productOptionMobileController.deleteProductOption |
| PUT | `/api/v1/mobile/venues/:venueId/product-options/:optionId` | mutation | venue | partial | menu:create | - | productOptionMobileController.updateProductOption |
| GET | `/api/v1/mobile/venues/:venueId/products` | read | venue | partial | menu:read | - | productMobileController.listProducts |
| POST | `/api/v1/mobile/venues/:venueId/products` | action | venue | partial | menu:create | - | productMobileController.createProduct |
| DELETE | `/api/v1/mobile/venues/:venueId/products/:productId` | dangerousMutation | venue | partial | menu:delete | - | productMobileController.deleteProduct |
| PUT | `/api/v1/mobile/venues/:venueId/products/:productId` | mutation | venue | partial | menu:update | - | productMobileController.updateProduct |
| GET | `/api/v1/mobile/venues/:venueId/purchase-orders` | read | venue | partial | inventory:read | - | purchaseOrderMobileController.listPurchaseOrders |
| POST | `/api/v1/mobile/venues/:venueId/purchase-orders` | action | venue | partial | inventory:create | - | purchaseOrderMobileController.createPurchaseOrder |
| GET | `/api/v1/mobile/venues/:venueId/purchase-orders/:poId` | read | venue | partial | inventory:read | - | purchaseOrderMobileController.getPurchaseOrder |
| POST | `/api/v1/mobile/venues/:venueId/purchase-orders/:poId/receive` | action | venue | partial | inventory:create | - | purchaseOrderMobileController.receiveStock |
| PUT | `/api/v1/mobile/venues/:venueId/purchase-orders/:poId/status` | mutation | venue | partial | inventory:create | - | purchaseOrderMobileController.updateStatus |
| POST | `/api/v1/mobile/venues/:venueId/receipts/send-email` | action | venue | missing | payments:read | - | receiptMobileController.sendReceiptEmail |
| POST | `/api/v1/mobile/venues/:venueId/receipts/send-whatsapp` | action | venue | missing | payments:read | - | receiptMobileController.sendReceiptWhatsapp |
| POST | `/api/v1/mobile/venues/:venueId/refunds` | dangerousMutation | venue | missing | payments:create | - | refundMobileController.createRefund |
| GET | `/api/v1/mobile/venues/:venueId/reports/sales-by-item` | read | venue | partial | reports:read | - | reportsMobileController.salesByItem |
| GET | `/api/v1/mobile/venues/:venueId/reports/sales-summary` | read | venue | partial | reports:read | - | reportsMobileController.salesSummary |
| GET | `/api/v1/mobile/venues/:venueId/settings` | read | venue | missing | - | - | tpvSettingsMobileController.getVenueTpvSettings |
| GET | `/api/v1/mobile/venues/:venueId/staff` | read | venue | missing | teams:read | - | staffMobileController.getActiveStaff |
| GET | `/api/v1/mobile/venues/:venueId/suppliers` | read | venue | partial | - | - | supplierMobileController.listSuppliers |
| GET | `/api/v1/mobile/venues/:venueId/tables` | read | venue | missing | tables:read | - | tableMobileController.getTables |
| POST | `/api/v1/mobile/venues/:venueId/tables/:tableId/clear` | action | venue | missing | orders:create | - | tableMobileController.clearTable |
| POST | `/api/v1/mobile/venues/:venueId/tables/:tableId/open` | action | venue | missing | orders:create | - | tableMobileController.openTable |
| POST | `/api/v1/mobile/venues/:venueId/terminal-payment` | action | venue | missing | payments:create | - | terminalPaymentMobileController.sendTerminalPayment |
| GET | `/api/v1/mobile/venues/:venueId/terminal-payment/:requestId` | read | venue | missing | payments:read | - | terminalPaymentMobileController.getTerminalPaymentStatus |
| POST | `/api/v1/mobile/venues/:venueId/terminal-payment/cancel` | dangerousMutation | venue | missing | payments:create | - | terminalPaymentMobileController.cancelTerminalPayment |
| POST | `/api/v1/mobile/venues/:venueId/terminals/:terminalId/print-receipt` | action | venue | missing | payments:create | - | terminalPaymentMobileController.printReceiptOnTerminal |
| GET | `/api/v1/mobile/venues/:venueId/terminals/online` | read | venue | missing | tpv:read | - | terminalPaymentMobileController.getOnlineTerminals |
| POST | `/api/v1/mobile/venues/:venueId/time-clock/break/end` | action | venue | missing | - | - | timeEntryMobileController.endBreak |
| POST | `/api/v1/mobile/venues/:venueId/time-clock/break/start` | action | venue | missing | - | - | timeEntryMobileController.startBreak |
| POST | `/api/v1/mobile/venues/:venueId/time-clock/clock-in` | action | venue | missing | - | - | timeEntryMobileController.clockIn |
| POST | `/api/v1/mobile/venues/:venueId/time-clock/clock-out` | action | venue | missing | - | - | timeEntryMobileController.clockOut |
| POST | `/api/v1/mobile/venues/:venueId/time-clock/identify` | action | venue | missing | - | - | timeEntryMobileController.identifyByPin |
| GET | `/api/v1/mobile/venues/:venueId/transactions` | read | venue | missing | payments:read | - | transactionMobileController.listTransactions |
| GET | `/api/v1/mobile/venues/:venueId/transactions/:paymentId` | read | venue | missing | payments:read | - | transactionMobileController.getTransaction |
| GET | `/api/v1/mobile/venues/:venueId/transfers` | read | venue | missing | inventory:read | - | transferMobileController.listTransfers |
| POST | `/api/v1/mobile/venues/:venueId/transfers` | action | venue | missing | inventory:create | - | transferMobileController.createTransfer |
| GET | `/api/v1/mobile/venues/:venueId/transfers/:id` | read | venue | missing | inventory:read | - | transferMobileController.getTransfer |
| PUT | `/api/v1/mobile/venues/:venueId/transfers/:id/status` | mutation | venue | missing | inventory:create | - | transferMobileController.updateStatus |
| GET | `/api/v1/onboarding/email-status` | read | unknown | missing | - | - | onboardingController.getEmailStatus |
| GET | `/api/v1/onboarding/menu-template` | read | unknown | partial | - | GetMenuTemplateSchema | onboardingController.getMenuTemplate |
| POST | `/api/v1/onboarding/organizations/:organizationId/complete` | dangerousMutation | organization | missing | - | CompleteOnboardingSchema | onboardingController.completeOnboarding |
| PUT | `/api/v1/onboarding/organizations/:organizationId/kyc/document/:documentKey` | mutation | organization | missing | - | - | onboardingController.uploadKycDocument |
| GET | `/api/v1/onboarding/organizations/:organizationId/progress` | read | organization | missing | - | GetOnboardingProgressSchema | onboardingController.getOnboardingProgress |
| POST | `/api/v1/onboarding/organizations/:organizationId/start` | action | organization | missing | - | StartOnboardingSchema | onboardingController.startOnboarding |
| PUT | `/api/v1/onboarding/organizations/:organizationId/step/1` | mutation | organization | missing | - | UpdateStep1Schema | onboardingController.updateStep1 |
| PUT | `/api/v1/onboarding/organizations/:organizationId/step/2` | mutation | organization | missing | - | UpdateStep2Schema | onboardingController.updateStep2 |
| PUT | `/api/v1/onboarding/organizations/:organizationId/step/3` | mutation | organization | missing | - | UpdateStep3Schema | onboardingController.updateStep3 |
| PUT | `/api/v1/onboarding/organizations/:organizationId/step/4` | mutation | organization | missing | - | UpdateStep4Schema | onboardingController.updateStep4 |
| PUT | `/api/v1/onboarding/organizations/:organizationId/step/5` | mutation | organization | missing | - | UpdateStep5Schema | onboardingController.updateStep5 |
| PUT | `/api/v1/onboarding/organizations/:organizationId/step/6` | mutation | organization | missing | - | UpdateStep6Schema | onboardingController.updateStep6 |
| PUT | `/api/v1/onboarding/organizations/:organizationId/step/7` | mutation | organization | missing | - | UpdateStep7Schema | onboardingController.updateStep7 |
| PUT | `/api/v1/onboarding/organizations/:organizationId/step/8` | mutation | organization | missing | - | UpdateStep8Schema | onboardingController.updateStep8 |
| POST | `/api/v1/onboarding/organizations/:organizationId/upload-menu-csv` | action | organization | partial | - | - | onboardingController.uploadMenuCSV |
| POST | `/api/v1/onboarding/organizations/:organizationId/v2/accept-terms` | action | organization | missing | - | V2AcceptTermsSchema | onboardingController.acceptV2Terms |
| POST | `/api/v1/onboarding/organizations/:organizationId/v2/complete` | dangerousMutation | organization | missing | - | V2CompleteSchema | onboardingController.completeV2Onboarding |
| PUT | `/api/v1/onboarding/organizations/:organizationId/v2/step/:stepNumber` | mutation | organization | missing | - | V2StepParamsSchema | onboardingController.saveV2Step |
| POST | `/api/v1/onboarding/resend-verification` | action | unknown | missing | - | - | onboardingController.resendVerification |
| POST | `/api/v1/onboarding/setup-intent` | action | unknown | missing | - | - | onboardingController.createSetupIntent |
| POST | `/api/v1/onboarding/signup` | action | unknown | missing | - | SignupSchema | onboardingController.signup |
| GET | `/api/v1/onboarding/status` | read | unknown | missing | - | - | onboardingController.getOnboardingStatus |
| POST | `/api/v1/onboarding/venues/:venueId/plan-setup-intent` | action | venue | missing | - | - | onboardingController.planSetupIntent |
| POST | `/api/v1/onboarding/venues/:venueId/test-payment-link` | action | venue | missing | - | - | onboardingController.testPaymentLink |
| POST | `/api/v1/onboarding/verify-email` | action | unknown | missing | - | - | onboardingController.verifyEmail |
| GET | `/api/v1/organizations/:orgId` | read | organization | missing | - | - | organizationController.getOrganization |
| PUT | `/api/v1/organizations/:orgId` | mutation | organization | missing | - | - | organizationController.updateOrganization |
| GET | `/api/v1/organizations/:orgId/analytics/enhanced-overview` | read | organization | partial | - | - | organizationController.getEnhancedOverview |
| GET | `/api/v1/organizations/:orgId/analytics/revenue-trends` | read | organization | partial | - | - | organizationController.getRevenueTrends |
| GET | `/api/v1/organizations/:orgId/analytics/top-items` | read | organization | partial | - | - | organizationController.getTopItems |
| GET | `/api/v1/organizations/:orgId/analytics/venue-benchmarks` | read | organization | partial | - | - | organizationController.getVenueBenchmarks |
| GET | `/api/v1/organizations/:orgId/overview` | read | organization | partial | - | - | organizationController.getOrganizationOverview |
| GET | `/api/v1/organizations/:orgId/stats` | read | organization | partial | - | - | organizationController.getOrganizationStats |
| GET | `/api/v1/organizations/:orgId/team` | read | organization | partial | - | - | organizationController.getOrganizationTeam |
| GET | `/api/v1/organizations/:orgId/venues` | read | organization | missing | - | - | organizationController.getOrganizationVenues |
| GET | `/api/v1/partner/sales` | read | unknown | partial | - | - | (inline handler) |
| POST | `/api/v1/pos-sync/test/pos-order` | action | unknown | missing | - | - | handlePosOrderTest |
| POST | `/api/v1/public/contact` | public | public | blocked | - | - | submitContact |
| POST | `/api/v1/public/labs/submit` | public | public | blocked | - | - | submitLabsBrief |
| GET | `/api/v1/public/payment-links/:shortCode` | public | public | blocked | - | publicShortCodeSchema | paymentLinkPublicController.resolvePaymentLink |
| POST | `/api/v1/public/payment-links/:shortCode/charge` | public | public | blocked | - | publicChargeSchema | paymentLinkPublicController.completeCharge |
| POST | `/api/v1/public/payment-links/:shortCode/checkout` | public | public | blocked | - | plCheckoutSchema | paymentLinkPublicController.createCheckout |
| POST | `/api/v1/public/payment-links/:shortCode/mp-pay` | public | public | blocked | - | - | paymentLinkPublicController.executeMercadoPagoPayment |
| POST | `/api/v1/public/payment-links/:shortCode/mp-payment-intent` | public | public | blocked | - | - | paymentLinkPublicController.createMercadoPagoPaymentIntent |
| POST | `/api/v1/public/payment-links/:shortCode/payment-intent` | public | public | blocked | - | publicStripePaymentIntentSchema | paymentLinkPublicController.createStripePaymentIntent |
| POST | `/api/v1/public/payment-links/:shortCode/send-receipt-email` | public | public | blocked | - | publicSendReceiptEmailSchema | paymentLinkPublicController.sendReceiptEmail |
| POST | `/api/v1/public/payment-links/:shortCode/send-receipt-whatsapp` | public | public | blocked | - | publicSendReceiptWhatsappSchema | paymentLinkPublicController.sendReceiptWhatsapp |
| GET | `/api/v1/public/payment-links/:shortCode/session/:sessionId` | public | public | blocked | - | publicSessionSchema | paymentLinkPublicController.getSessionStatus |
| POST | `/api/v1/public/payment-links/:shortCode/stripe-checkout` | public | public | blocked | - | publicStripeCheckoutSchema | paymentLinkPublicController.createStripeCheckout |
| GET | `/api/v1/public/receipt/:accessKey` | public | public | blocked | - | - | getPublicReceipt |
| GET | `/api/v1/public/receipt/:accessKey/cfdi` | public | public | blocked | - | - | getAutofacturaStatusController |
| POST | `/api/v1/public/receipt/:accessKey/cfdi` | public | public | blocked | - | autofacturaSchema | autofacturaController |
| GET | `/api/v1/public/receipt/:accessKey/cfdi/download` | public | public | blocked | - | - | downloadCfdiZipController |
| POST | `/api/v1/public/receipt/:accessKey/cfdi/whatsapp` | public | public | blocked | - | - | sendCfdiWhatsAppController |
| GET | `/api/v1/public/receipt/:accessKey/review` | public | public | blocked | - | - | getReviewForReceipt |
| POST | `/api/v1/public/receipt/:accessKey/review` | public | public | blocked | - | - | submitReviewFromReceipt |
| GET | `/api/v1/public/receipt/:accessKey/review/status` | public | public | blocked | - | - | checkReviewStatus |
| GET | `/api/v1/public/tpv-orders/:id/approve` | public | public | blocked | - | - | tpvOrderPublicController.approveOrderHandler |
| GET | `/api/v1/public/tpv-orders/:id/approve/check` | public | public | blocked | - | - | tpvOrderPublicController.approveCheckHandler |
| POST | `/api/v1/public/tpv-orders/:id/assign-serials` | public | public | blocked | - | assignSerialsPublicSchema | tpvOrderPublicController.assignSerialsPublicHandler |
| GET | `/api/v1/public/tpv-orders/:id/assign-serials/check` | public | public | blocked | - | - | tpvOrderPublicController.assignSerialsCheckHandler |
| POST | `/api/v1/public/tpv-orders/:id/reject` | public | public | blocked | - | rejectSpeiSchema | tpvOrderPublicController.rejectOrderHandler |
| GET | `/api/v1/public/unsubscribe` | public | public | blocked | - | - | getUnsubscribePage |
| POST | `/api/v1/public/unsubscribe` | public | public | blocked | - | - | postUnsubscribe |
| POST | `/api/v1/public/venue-chat/sessions` | public | public | blocked | - | z.object | venueChatController.postSession |
| GET | `/api/v1/public/venue-chat/sessions/:id` | public | public | blocked | - | z.object | venueChatController.getSession |
| GET | `/api/v1/public/venue-chat/sessions/:id/messages` | public | public | blocked | - | z.object | venueChatController.getMessages |
| POST | `/api/v1/public/venue-chat/sessions/:id/messages` | public | public | blocked | - | z.object | venueChatController.postMessage |
| POST | `/api/v1/public/venue-chat/sessions/:id/resume` | public | public | blocked | - | z.object | venueChatController.postResume |
| POST | `/api/v1/public/venues/:venueSlug/auth/otp/request` | public | public | blocked | - | z.object | otpAuthController.requestOtp |
| POST | `/api/v1/public/venues/:venueSlug/auth/otp/verify` | public | public | blocked | - | z.object | otpAuthController.verifyOtp |
| GET | `/api/v1/public/venues/:venueSlug/availability` | public | public | blocked | - | z.object | reservationPublicController.getAvailability |
| GET | `/api/v1/public/venues/:venueSlug/checkout-info` | public | public | blocked | - | venueCheckoutInfoSchema | venueCheckoutController.getCheckoutInfo |
| POST | `/api/v1/public/venues/:venueSlug/checkout/mp-pay` | public | public | blocked | - | venueMpPaySchema | venueCheckoutController.executeMercadoPagoPayment |
| POST | `/api/v1/public/venues/:venueSlug/checkout/mp-payment-intent` | public | public | blocked | - | venueMpIntentSchema | venueCheckoutController.createMercadoPagoPaymentIntent |
| POST | `/api/v1/public/venues/:venueSlug/checkout/payment-intent` | public | public | blocked | - | venueStripeIntentSchema | venueCheckoutController.createStripePaymentIntent |
| GET | `/api/v1/public/venues/:venueSlug/checkout/session/:sessionId` | public | public | blocked | - | venueCheckoutSessionSchema | venueCheckoutController.getSessionStatus |
| GET | `/api/v1/public/venues/:venueSlug/credit-packs` | public | public | blocked | - | publicPacksParamsSchema | creditPackPublicController.getAvailablePacks |
| POST | `/api/v1/public/venues/:venueSlug/credit-packs/:packId/checkout` | public | public | blocked | - | publicCheckoutSchema | creditPackPublicController.createCheckout |
| GET | `/api/v1/public/venues/:venueSlug/credit-packs/balance` | public | public | blocked | - | publicBalanceQuerySchema | creditPackPublicController.getCustomerBalance |
| POST | `/api/v1/public/venues/:venueSlug/customer/login` | public | public | blocked | - | customerLoginSchema | customerPortalController.login |
| GET | `/api/v1/public/venues/:venueSlug/customer/portal` | public | public | blocked | - | - | customerPortalController.getPortal |
| PATCH | `/api/v1/public/venues/:venueSlug/customer/profile` | public | public | blocked | - | customerUpdateProfileSchema | customerPortalController.updateProfile |
| POST | `/api/v1/public/venues/:venueSlug/customer/register` | public | public | blocked | - | customerRegisterSchema | customerPortalController.register |
| GET | `/api/v1/public/venues/:venueSlug/info` | public | public | blocked | - | z.object | reservationPublicController.getVenueInfo |
| POST | `/api/v1/public/venues/:venueSlug/reservations` | public | public | blocked | - | z.object | reservationPublicController.createReservation |
| GET | `/api/v1/public/venues/:venueSlug/reservations/:cancelSecret` | public | public | blocked | - | z.object | reservationPublicController.getReservation |
| POST | `/api/v1/public/venues/:venueSlug/reservations/:cancelSecret/cancel` | public | public | blocked | - | z.object | reservationPublicController.cancelReservation |
| POST | `/api/v1/public/venues/:venueSlug/reservations/:cancelSecret/reschedule` | public | public | blocked | - | z.object | reservationPublicController.rescheduleReservation |
| GET | `/api/v1/public/venues/:venueSlug/reservations/:cancelSecret/reschedule/availability` | public | public | blocked | - | z.object | reservationPublicController.getRescheduleAvailability |
| POST | `/api/v1/public/venues/:venueSlug/reservations/:cancelSecret/reschedule/hold` | public | public | blocked | - | z.object | reservationPublicController.createRescheduleHold |
| POST | `/api/v1/public/venues/:venueSlug/reservations/hold` | public | public | blocked | - | z.object | reservationPublicController.createHold |
| DELETE | `/api/v1/public/venues/:venueSlug/reservations/hold/:holdId` | public | public | blocked | - | z.object | reservationPublicController.cancelHold |
| POST | `/api/v1/sdk/charge` | action | unknown | missing | - | - | chargeWithToken |
| GET | `/api/v1/sdk/checkout/sessions` | read | unknown | missing | - | - | checkoutController.listCheckoutSessions |
| POST | `/api/v1/sdk/checkout/sessions` | action | unknown | missing | - | - | checkoutController.createCheckoutSession |
| GET | `/api/v1/sdk/checkout/sessions/:sessionId` | read | unknown | missing | - | - | checkoutController.getCheckoutSession |
| POST | `/api/v1/sdk/checkout/sessions/:sessionId/cancel` | dangerousMutation | unknown | missing | - | - | checkoutController.cancelCheckoutSession |
| GET | `/api/v1/sdk/checkout/stats` | read | unknown | partial | - | - | checkoutController.getCheckoutStats |
| GET | `/api/v1/sdk/dashboard/sessions` | read | unknown | missing | - | - | listSessions |
| GET | `/api/v1/sdk/dashboard/sessions/:sessionId` | read | unknown | missing | - | - | getSessionDetails |
| POST | `/api/v1/sdk/dashboard/sessions/:sessionId/expire` | action | unknown | missing | - | - | expireSession |
| POST | `/api/v1/sdk/dashboard/sessions/:sessionId/reset` | dangerousMutation | unknown | missing | - | - | resetSession |
| DELETE | `/api/v1/sdk/dashboard/sessions/cleanup` | dangerousMutation | unknown | missing | - | - | cleanupSessions |
| GET | `/api/v1/sdk/dashboard/stats` | read | unknown | partial | - | - | getDashboardStats |
| POST | `/api/v1/sdk/tokenize` | action | unknown | missing | - | - | tokenizeCard |
| GET | `/api/v1/superadmin/activity-log` | adminOnly | superadmin | blocked | - | - | (inline handler) |
| GET | `/api/v1/superadmin/activity-log/actions` | adminOnly | superadmin | blocked | - | - | (inline handler) |
| GET | `/api/v1/superadmin/activity-log/entities` | adminOnly | superadmin | blocked | - | - | (inline handler) |
| GET | `/api/v1/superadmin/aggregators` | adminOnly | superadmin | blocked | - | - | aggregatorController.getAggregators |
| POST | `/api/v1/superadmin/aggregators` | adminOnly | superadmin | blocked | - | - | aggregatorController.createAggregator |
| DELETE | `/api/v1/superadmin/aggregators/:id` | adminOnly | superadmin | blocked | - | - | aggregatorController.deleteAggregator |
| GET | `/api/v1/superadmin/aggregators/:id` | adminOnly | superadmin | blocked | - | - | aggregatorController.getAggregatorById |
| PUT | `/api/v1/superadmin/aggregators/:id` | adminOnly | superadmin | blocked | - | - | aggregatorController.updateAggregator |
| POST | `/api/v1/superadmin/aggregators/:id/generate-token` | adminOnly | superadmin | blocked | - | - | aggregatorController.generateReportToken |
| DELETE | `/api/v1/superadmin/aggregators/:id/revoke-token` | adminOnly | superadmin | blocked | - | - | aggregatorController.revokeReportToken |
| PATCH | `/api/v1/superadmin/aggregators/:id/toggle` | adminOnly | superadmin | blocked | - | - | aggregatorController.toggleAggregator |
| DELETE | `/api/v1/superadmin/angelpay-accounts/:id` | adminOnly | superadmin | blocked | - | - | angelpayController.deleteAngelPayUserAccountController |
| PATCH | `/api/v1/superadmin/angelpay-accounts/:id/credentials` | adminOnly | superadmin | blocked | - | - | angelpayController.updateAngelPayUserAccountCredentialsController |
| PATCH | `/api/v1/superadmin/angelpay-accounts/:id/pin` | adminOnly | superadmin | blocked | - | - | angelpayController.setAngelPayUserAccountPinController |
| PATCH | `/api/v1/superadmin/angelpay-accounts/:id/status` | adminOnly | superadmin | blocked | - | - | angelpayController.updateAngelPayUserAccountStatusController |
| GET | `/api/v1/superadmin/app-updates` | adminOnly | superadmin | blocked | - | listUpdatesSchema | appUpdateController.listAppUpdates |
| POST | `/api/v1/superadmin/app-updates` | adminOnly | superadmin | blocked | - | createUpdateSchema | appUpdateController.createAppUpdate |
| DELETE | `/api/v1/superadmin/app-updates/:id` | adminOnly | superadmin | blocked | - | updateIdSchema | appUpdateController.deleteAppUpdate |
| GET | `/api/v1/superadmin/app-updates/:id` | adminOnly | superadmin | blocked | - | updateIdSchema | appUpdateController.getAppUpdateById |
| PATCH | `/api/v1/superadmin/app-updates/:id` | adminOnly | superadmin | blocked | - | updateAppUpdateSchema | appUpdateController.updateAppUpdate |
| GET | `/api/v1/superadmin/app-updates/latest/:environment` | adminOnly | superadmin | blocked | - | environmentSchema | appUpdateController.getLatestAppUpdate |
| POST | `/api/v1/superadmin/app-updates/preview` | adminOnly | superadmin | blocked | - | - | appUpdateController.previewApkMetadata |
| GET | `/api/v1/superadmin/balance-providers` | adminOnly | superadmin | blocked | - | - | balanceProviderController.getBalanceProviders |
| GET | `/api/v1/superadmin/billing/customers` | adminOnly | superadmin | blocked | platform-billing:view | - | controller.searchCustomers |
| GET | `/api/v1/superadmin/billing/customers/:type/:id/tax-profile` | adminOnly | superadmin | blocked | platform-billing:view | - | controller.getTaxProfileForCustomer |
| GET | `/api/v1/superadmin/billing/emisor` | adminOnly | superadmin | blocked | platform-billing:view | - | controller.getEmisor |
| PUT | `/api/v1/superadmin/billing/emisor` | adminOnly | superadmin | blocked | platform-billing:configure | upsertEmisorSchema | controller.upsertEmisor |
| POST | `/api/v1/superadmin/billing/emisor/csd` | adminOnly | superadmin | blocked | platform-billing:configure | uploadCsdSchema | controller.uploadCsd |
| POST | `/api/v1/superadmin/billing/emisor/provision` | adminOnly | superadmin | blocked | platform-billing:configure | provisionEmisorSchema | controller.provisionEmisor |
| GET | `/api/v1/superadmin/billing/invoices` | adminOnly | superadmin | blocked | platform-billing:view | listInvoicesSchema | controller.listInvoices |
| POST | `/api/v1/superadmin/billing/invoices` | adminOnly | superadmin | blocked | platform-billing:issue | issueInvoiceSchema | controller.issueInvoice |
| DELETE | `/api/v1/superadmin/billing/invoices/:id` | adminOnly | superadmin | blocked | platform-billing:delete | - | controller.discardInvoice |
| GET | `/api/v1/superadmin/billing/invoices/:id` | adminOnly | superadmin | blocked | platform-billing:view | - | controller.getInvoice |
| POST | `/api/v1/superadmin/billing/invoices/:id/cancel` | adminOnly | superadmin | blocked | platform-billing:issue | cancelInvoiceSchema | controller.cancelInvoice |
| POST | `/api/v1/superadmin/billing/invoices/:id/email` | adminOnly | superadmin | blocked | platform-billing:issue | sendEmailSchema | controller.sendInvoiceEmail |
| POST | `/api/v1/superadmin/billing/invoices/:id/payments` | adminOnly | superadmin | blocked | platform-billing:issue | registerPaymentSchema | controller.registerPayment |
| GET | `/api/v1/superadmin/billing/invoices/:id/pdf` | adminOnly | superadmin | blocked | platform-billing:view | - | controller.downloadPdf |
| GET | `/api/v1/superadmin/billing/invoices/:id/xml` | adminOnly | superadmin | blocked | platform-billing:view | - | controller.downloadXml |
| PUT | `/api/v1/superadmin/billing/tax-profiles` | adminOnly | superadmin | blocked | platform-billing:configure | upsertTaxProfileSchema | controller.upsertTaxProfile |
| GET | `/api/v1/superadmin/billing/tax-profiles/:id` | adminOnly | superadmin | blocked | platform-billing:view | - | controller.getTaxProfile |
| POST | `/api/v1/superadmin/billing/tax-profiles/:id/constancia` | adminOnly | superadmin | blocked | platform-billing:configure | uploadConstanciaSchema | controller.attachConstanciaController |
| GET | `/api/v1/superadmin/cost-structures` | adminOnly | superadmin | blocked | - | - | providerCostStructureController.getProviderCostStructures |
| POST | `/api/v1/superadmin/cost-structures` | adminOnly | superadmin | blocked | - | - | providerCostStructureController.createProviderCostStructure |
| DELETE | `/api/v1/superadmin/cost-structures/:id` | adminOnly | superadmin | blocked | - | - | providerCostStructureController.deleteProviderCostStructure |
| GET | `/api/v1/superadmin/cost-structures/:id` | adminOnly | superadmin | blocked | - | - | providerCostStructureController.getProviderCostStructure |
| PUT | `/api/v1/superadmin/cost-structures/:id` | adminOnly | superadmin | blocked | - | - | providerCostStructureController.updateProviderCostStructure |
| PATCH | `/api/v1/superadmin/cost-structures/:id/deactivate` | adminOnly | superadmin | blocked | - | - | providerCostStructureController.deactivateCostStructure |
| GET | `/api/v1/superadmin/cost-structures/active/:merchantAccountId` | adminOnly | superadmin | blocked | - | - | providerCostStructureController.getActiveCostStructure |
| POST | `/api/v1/superadmin/cost-structures/flat-rate` | adminOnly | superadmin | blocked | - | - | providerCostStructureController.createFlatRateCostStructure |
| GET | `/api/v1/superadmin/credit/assessments` | adminOnly | superadmin | blocked | - | creditAssessmentSchema.ListAssessmentsSchema | asyncHandler(creditAssessmentController.listAssessments) |
| PATCH | `/api/v1/superadmin/credit/offers/:offerId/accept` | adminOnly | superadmin | blocked | - | creditAssessmentSchema.OfferIdSchema | asyncHandler(creditAssessmentController.acceptOffer) |
| PATCH | `/api/v1/superadmin/credit/offers/:offerId/reject` | adminOnly | superadmin | blocked | - | creditAssessmentSchema.RejectOfferSchema | asyncHandler(creditAssessmentController.rejectOffer) |
| PATCH | `/api/v1/superadmin/credit/offers/:offerId/withdraw` | adminOnly | superadmin | blocked | - | creditAssessmentSchema.OfferIdSchema | asyncHandler(creditAssessmentController.withdrawOffer) |
| POST | `/api/v1/superadmin/credit/refresh-all` | adminOnly | superadmin | blocked | - | - | asyncHandler(creditAssessmentController.refreshAllAssessments) |
| GET | `/api/v1/superadmin/credit/summary` | adminOnly | superadmin | blocked | - | - | asyncHandler(creditAssessmentController.getAssessmentSummary) |
| GET | `/api/v1/superadmin/credit/venues/:venueId` | adminOnly | superadmin | blocked | - | creditAssessmentSchema.VenueIdSchema | asyncHandler(creditAssessmentController.getVenueAssessment) |
| GET | `/api/v1/superadmin/credit/venues/:venueId/offers` | adminOnly | superadmin | blocked | - | creditAssessmentSchema.VenueIdSchema | asyncHandler(creditAssessmentController.getVenueOffers) |
| POST | `/api/v1/superadmin/credit/venues/:venueId/offers` | adminOnly | superadmin | blocked | - | creditAssessmentSchema.CreateOfferSchema | asyncHandler(creditAssessmentController.createOffer) |
| POST | `/api/v1/superadmin/credit/venues/:venueId/refresh` | adminOnly | superadmin | blocked | - | creditAssessmentSchema.VenueIdSchema | asyncHandler(creditAssessmentController.refreshVenueAssessment) |
| GET | `/api/v1/superadmin/dashboard/summary` | adminOnly | superadmin | blocked | - | - | (inline handler) |
| GET | `/api/v1/superadmin/earnings/summary` | adminOnly | superadmin | blocked | - | - | earningsController.getEarningsSummary |
| GET | `/api/v1/superadmin/earnings/time-series` | adminOnly | superadmin | blocked | - | - | earningsController.getEarningsTimeSeries |
| GET | `/api/v1/superadmin/holidays` | adminOnly | superadmin | blocked | - | - | holidaysController.getHolidays |
| GET | `/api/v1/superadmin/kyc/:venueId` | adminOnly | superadmin | blocked | - | kycReviewSchema.GetKycDetailsSchema | asyncHandler(kycReviewController.getKycDetails) |
| POST | `/api/v1/superadmin/kyc/:venueId/approve` | adminOnly | superadmin | blocked | - | - | asyncHandler(kycReviewController.approveKyc) |
| POST | `/api/v1/superadmin/kyc/:venueId/assign-processor` | adminOnly | superadmin | blocked | - | kycReviewSchema.AssignProcessorSchema | asyncHandler(kycReviewController.assignProcessorAndApprove) |
| POST | `/api/v1/superadmin/kyc/:venueId/mark-in-review` | adminOnly | superadmin | blocked | - | kycReviewSchema.MarkKycInReviewSchema | asyncHandler(kycReviewController.markInReview) |
| POST | `/api/v1/superadmin/kyc/:venueId/reject` | adminOnly | superadmin | blocked | - | kycReviewSchema.RejectKycSchema | asyncHandler(kycReviewController.rejectKyc) |
| GET | `/api/v1/superadmin/kyc/pending` | adminOnly | superadmin | blocked | - | - | asyncHandler(kycReviewController.listPendingKyc) |
| GET | `/api/v1/superadmin/merchant-accounts` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getMerchantAccounts |
| POST | `/api/v1/superadmin/merchant-accounts` | adminOnly | superadmin | blocked | - | - | merchantAccountController.createMerchantAccount |
| DELETE | `/api/v1/superadmin/merchant-accounts/:id` | adminOnly | superadmin | blocked | - | - | merchantAccountController.deleteMerchantAccount |
| GET | `/api/v1/superadmin/merchant-accounts/:id` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getMerchantAccount |
| PUT | `/api/v1/superadmin/merchant-accounts/:id` | adminOnly | superadmin | blocked | - | - | merchantAccountController.updateMerchantAccount |
| GET | `/api/v1/superadmin/merchant-accounts/:id/assignable-terminals` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getAssignableTerminals |
| GET | `/api/v1/superadmin/merchant-accounts/:id/balance` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getBalance |
| POST | `/api/v1/superadmin/merchant-accounts/:id/batch-assign-terminals` | adminOnly | superadmin | blocked | - | - | merchantAccountController.batchAssignTerminals |
| GET | `/api/v1/superadmin/merchant-accounts/:id/blockers` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getMerchantAccountBlockers |
| POST | `/api/v1/superadmin/merchant-accounts/:id/blumon/refetch` | adminOnly | superadmin | blocked | - | - | merchantAccountController.refetchBlumonMerchantCredentials |
| GET | `/api/v1/superadmin/merchant-accounts/:id/credentials` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getMerchantAccountCredentials |
| GET | `/api/v1/superadmin/merchant-accounts/:id/terminals` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getTerminalsByMerchantAccount |
| DELETE | `/api/v1/superadmin/merchant-accounts/:id/terminals/:terminalId` | adminOnly | superadmin | blocked | - | - | merchantAccountController.removeMerchantFromTerminal |
| PUT | `/api/v1/superadmin/merchant-accounts/:id/terminals/:terminalId` | adminOnly | superadmin | blocked | - | - | merchantAccountController.setTerminalServesMerchant |
| PATCH | `/api/v1/superadmin/merchant-accounts/:id/toggle` | adminOnly | superadmin | blocked | - | - | merchantAccountController.toggleMerchantAccountStatus |
| POST | `/api/v1/superadmin/merchant-accounts/blumon/auto-fetch` | adminOnly | superadmin | blocked | - | - | merchantAccountController.autoFetchBlumonCredentials |
| POST | `/api/v1/superadmin/merchant-accounts/blumon/batch-auto-fetch` | adminOnly | superadmin | blocked | - | - | merchantAccountController.batchAutoFetchBlumonCredentials |
| POST | `/api/v1/superadmin/merchant-accounts/blumon/full-setup` | adminOnly | superadmin | blocked | - | - | merchantAccountController.fullSetupBlumonMerchant |
| POST | `/api/v1/superadmin/merchant-accounts/blumon/register` | adminOnly | superadmin | blocked | - | - | merchantAccountController.registerBlumonMerchant |
| POST | `/api/v1/superadmin/merchant-accounts/full-setup-angelpay` | adminOnly | superadmin | blocked | - | - | merchantAccountController.fullSetupAngelPayMerchant |
| GET | `/api/v1/superadmin/merchant-accounts/mcc-lookup` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getMccRateSuggestion |
| GET | `/api/v1/superadmin/merchant-accounts/payment-setup/summary` | adminOnly | superadmin | blocked | - | - | merchantAccountController.getPaymentSetupSummary |
| POST | `/api/v1/superadmin/merchant-accounts/with-cost-structure` | adminOnly | superadmin | blocked | - | - | merchantAccountController.createMerchantAccountWithCostStructure |
| GET | `/api/v1/superadmin/merchant-revenue-shares` | adminOnly | superadmin | blocked | - | - | controller.getMerchantRevenueShares |
| POST | `/api/v1/superadmin/merchant-revenue-shares` | adminOnly | superadmin | blocked | - | - | controller.createMerchantRevenueShare |
| DELETE | `/api/v1/superadmin/merchant-revenue-shares/:id` | adminOnly | superadmin | blocked | - | - | controller.deleteMerchantRevenueShare |
| GET | `/api/v1/superadmin/merchant-revenue-shares/:id` | adminOnly | superadmin | blocked | - | - | controller.getMerchantRevenueShareById |
| PUT | `/api/v1/superadmin/merchant-revenue-shares/:id` | adminOnly | superadmin | blocked | - | - | controller.updateMerchantRevenueShare |
| GET | `/api/v1/superadmin/merchant-revenue-shares/by-merchant` | adminOnly | superadmin | blocked | - | - | controller.getMerchantRevenueShareByMerchant |
| GET | `/api/v1/superadmin/merchant-revenue-shares/report` | adminOnly | superadmin | blocked | - | - | controller.getRevenueShareReport |
| GET | `/api/v1/superadmin/modules` | adminOnly | superadmin | blocked | - | - | moduleController.getAllModules |
| POST | `/api/v1/superadmin/modules` | adminOnly | superadmin | blocked | - | createModuleSchema | moduleController.createModule |
| GET | `/api/v1/superadmin/modules/:moduleCode/venues` | adminOnly | superadmin | blocked | - | moduleCodeSchema | moduleController.getVenuesForModule |
| DELETE | `/api/v1/superadmin/modules/:moduleId` | adminOnly | superadmin | blocked | - | moduleIdSchema | moduleController.deleteModule |
| PATCH | `/api/v1/superadmin/modules/:moduleId` | adminOnly | superadmin | blocked | - | updateModuleSchema | moduleController.updateModule |
| PATCH | `/api/v1/superadmin/modules/config` | adminOnly | superadmin | blocked | - | updateConfigSchema | moduleController.updateModuleConfig |
| POST | `/api/v1/superadmin/modules/disable` | adminOnly | superadmin | blocked | - | disableModuleSchema | moduleController.disableModuleForVenue |
| POST | `/api/v1/superadmin/modules/enable` | adminOnly | superadmin | blocked | - | enableModuleSchema | moduleController.enableModuleForVenue |
| DELETE | `/api/v1/superadmin/modules/venue-override` | adminOnly | superadmin | blocked | - | deleteVenueOverrideSchema | moduleController.deleteVenueModuleOverride |
| GET | `/api/v1/superadmin/modules/venues/:venueId` | adminOnly | superadmin | blocked | - | venueIdSchema | moduleController.getModulesForVenue |
| GET | `/api/v1/superadmin/onboarding/merchant-accounts` | adminOnly | superadmin | blocked | - | - | onboardingController.getMerchantAccountsForSelector |
| GET | `/api/v1/superadmin/onboarding/org-payment-status/:orgId` | adminOnly | superadmin | blocked | - | - | onboardingController.getOrgPaymentStatus |
| GET | `/api/v1/superadmin/onboarding/organizations` | adminOnly | superadmin | blocked | - | - | onboardingController.getOrganizationsForSelector |
| POST | `/api/v1/superadmin/onboarding/venue` | adminOnly | superadmin | blocked | - | - | onboardingController.createVenueWizard |
| GET | `/api/v1/superadmin/partner-keys` | adminOnly | superadmin | blocked | - | - | (inline handler) |
| POST | `/api/v1/superadmin/partner-keys` | adminOnly | superadmin | blocked | - | - | (inline handler) |
| DELETE | `/api/v1/superadmin/partner-keys/:id` | adminOnly | superadmin | blocked | - | - | (inline handler) |
| GET | `/api/v1/superadmin/payment-analytics/export` | adminOnly | superadmin | blocked | - | - | paymentAnalyticsController.exportProfitData |
| GET | `/api/v1/superadmin/payment-analytics/profit-metrics` | adminOnly | superadmin | blocked | - | - | paymentAnalyticsController.getProfitMetrics |
| GET | `/api/v1/superadmin/payment-analytics/provider-comparison` | adminOnly | superadmin | blocked | - | - | paymentAnalyticsController.getProviderComparison |
| GET | `/api/v1/superadmin/payment-analytics/time-series` | adminOnly | superadmin | blocked | - | - | paymentAnalyticsController.getProfitTimeSeries |
| GET | `/api/v1/superadmin/payment-analytics/venue/:venueId` | adminOnly | superadmin | blocked | - | - | paymentAnalyticsController.getVenueProfitMetrics |
| GET | `/api/v1/superadmin/payment-providers` | adminOnly | superadmin | blocked | - | - | paymentProviderController.getPaymentProviders |
| POST | `/api/v1/superadmin/payment-providers` | adminOnly | superadmin | blocked | - | - | paymentProviderController.createPaymentProvider |
| DELETE | `/api/v1/superadmin/payment-providers/:id` | adminOnly | superadmin | blocked | - | - | paymentProviderController.deletePaymentProvider |
| GET | `/api/v1/superadmin/payment-providers/:id` | adminOnly | superadmin | blocked | - | - | paymentProviderController.getPaymentProvider |
| PUT | `/api/v1/superadmin/payment-providers/:id` | adminOnly | superadmin | blocked | - | - | paymentProviderController.updatePaymentProvider |
| GET | `/api/v1/superadmin/payment-providers/:id/blockers` | adminOnly | superadmin | blocked | - | - | paymentProviderController.getPaymentProviderBlockers |
| PATCH | `/api/v1/superadmin/payment-providers/:id/toggle` | adminOnly | superadmin | blocked | - | - | paymentProviderController.togglePaymentProviderStatus |
| GET | `/api/v1/superadmin/payment-providers/code/:code` | adminOnly | superadmin | blocked | - | - | paymentProviderController.getPaymentProviderByCode |
| GET | `/api/v1/superadmin/rate-corrections` | adminOnly | superadmin | blocked | - | - | ctrl.list |
| POST | `/api/v1/superadmin/rate-corrections/:batchId/reverse` | adminOnly | superadmin | blocked | - | - | ctrl.reverse |
| POST | `/api/v1/superadmin/rate-corrections/venues/:venueId/apply` | adminOnly | superadmin | blocked | - | - | ctrl.apply |
| POST | `/api/v1/superadmin/rate-corrections/venues/:venueId/preview` | adminOnly | superadmin | blocked | - | - | ctrl.preview |
| GET | `/api/v1/superadmin/reports/weekly-new-customers/preview` | adminOnly | superadmin | blocked | - | - | (inline handler) |
| GET | `/api/v1/superadmin/settlement-calendar` | adminOnly | public | blocked | - | - | settlementCalendarController.getSettlementCalendar |
| GET | `/api/v1/superadmin/settlement-configurations` | adminOnly | public | blocked | - | - | settlementConfigController.getSettlementConfigurations |
| POST | `/api/v1/superadmin/settlement-configurations` | adminOnly | public | blocked | - | - | settlementConfigController.createSettlementConfiguration |
| DELETE | `/api/v1/superadmin/settlement-configurations/:id` | adminOnly | public | blocked | - | - | settlementConfigController.deleteSettlementConfiguration |
| GET | `/api/v1/superadmin/settlement-configurations/:id` | adminOnly | public | blocked | - | - | settlementConfigController.getSettlementConfiguration |
| PUT | `/api/v1/superadmin/settlement-configurations/:id` | adminOnly | public | blocked | - | - | settlementConfigController.updateSettlementConfiguration |
| GET | `/api/v1/superadmin/settlement-configurations/active/:merchantAccountId/:cardType` | adminOnly | public | blocked | - | - | settlementConfigController.getActiveConfiguration |
| POST | `/api/v1/superadmin/settlement-configurations/bulk` | adminOnly | public | blocked | - | - | settlementConfigController.bulkCreateSettlementConfigurations |
| POST | `/api/v1/superadmin/stripe-connect/venues/:venueId/offboard-payments` | adminOnly | superadmin | blocked | - | z.object | controller.offboardVenue |
| GET | `/api/v1/superadmin/subscriptions/overview` | adminOnly | superadmin | blocked | - | - | controller.overview |
| GET | `/api/v1/superadmin/subscriptions/venues` | adminOnly | superadmin | blocked | - | listSubscriptionsSchema | controller.venues |
| POST | `/api/v1/superadmin/subscriptions/venues/:venueId/activate` | adminOnly | superadmin | blocked | - | - | controller.activate |
| POST | `/api/v1/superadmin/subscriptions/venues/:venueId/adjust-end-date` | adminOnly | superadmin | blocked | - | adjustEndDateSchema | controller.adjustEndDate |
| POST | `/api/v1/superadmin/subscriptions/venues/:venueId/deactivate` | adminOnly | superadmin | blocked | - | - | controller.deactivate |
| POST | `/api/v1/superadmin/subscriptions/venues/:venueId/grant-trial` | adminOnly | superadmin | blocked | - | grantTrialSchema | controller.grantTrial |
| GET | `/api/v1/superadmin/system-logs` | adminOnly | superadmin | blocked | - | - | (inline handler) |
| GET | `/api/v1/superadmin/terminals` | adminOnly | superadmin | blocked | - | terminalQuerySchema | terminalController.getAllTerminals |
| POST | `/api/v1/superadmin/terminals` | adminOnly | superadmin | blocked | - | createTerminalSchema | terminalController.createTerminal |
| DELETE | `/api/v1/superadmin/terminals/:terminalId` | adminOnly | superadmin | blocked | - | terminalIdSchema | terminalController.deleteTerminal |
| GET | `/api/v1/superadmin/terminals/:terminalId` | adminOnly | superadmin | blocked | - | terminalIdSchema | terminalController.getTerminalById |
| PATCH | `/api/v1/superadmin/terminals/:terminalId` | adminOnly | superadmin | blocked | - | updateTerminalSchema | terminalController.updateTerminal |
| POST | `/api/v1/superadmin/terminals/:terminalId/generate-activation-code` | adminOnly | superadmin | blocked | - | terminalIdSchema | terminalController.generateActivationCode |
| POST | `/api/v1/superadmin/terminals/:terminalId/migrate-cancel` | adminOnly | superadmin | blocked | - | migrateCancelSchema | migrationController.cancel |
| POST | `/api/v1/superadmin/terminals/:terminalId/migrate-execute` | adminOnly | superadmin | blocked | - | migrateExecuteSchema | migrationController.execute |
| POST | `/api/v1/superadmin/terminals/:terminalId/migrate-preflight` | adminOnly | superadmin | blocked | - | migratePreflightSchema | migrationController.preflight |
| GET | `/api/v1/superadmin/terminals/:terminalId/migrate-status` | adminOnly | superadmin | blocked | - | migrateStatusSchema | migrationController.status |
| POST | `/api/v1/superadmin/terminals/:terminalId/remote-activate` | adminOnly | superadmin | blocked | - | terminalIdSchema | terminalController.sendRemoteActivation |
| GET | `/api/v1/superadmin/tpv-orders` | adminOnly | superadmin | blocked | - | - | terminalOrderSuperadminController.listAllOrdersHandler |
| GET | `/api/v1/superadmin/tpv-orders/:id` | adminOnly | superadmin | blocked | - | - | terminalOrderSuperadminController.getOrderHandler |
| POST | `/api/v1/superadmin/tpv-orders/:id/assign-serials` | adminOnly | superadmin | blocked | - | assignSerialsSchema | terminalOrderSuperadminController.assignSerialsHandler |
| POST | `/api/v1/superadmin/tpv-orders/:id/mark-delivered` | adminOnly | superadmin | blocked | - | - | terminalOrderSuperadminController.markDeliveredHandler |
| POST | `/api/v1/superadmin/tpv-orders/:id/mark-shipped` | adminOnly | superadmin | blocked | - | markShippedSchema | terminalOrderSuperadminController.markShippedHandler |
| GET | `/api/v1/superadmin/trainings` | adminOnly | superadmin | blocked | - | listTrainingsQuerySchema | trainingController.listTrainings |
| POST | `/api/v1/superadmin/trainings` | adminOnly | superadmin | blocked | - | createTrainingSchema | trainingController.createTraining |
| DELETE | `/api/v1/superadmin/trainings/:trainingId` | adminOnly | superadmin | blocked | - | trainingIdParamSchema | trainingController.deleteTraining |
| GET | `/api/v1/superadmin/trainings/:trainingId` | adminOnly | superadmin | blocked | - | trainingIdParamSchema | trainingController.getTraining |
| PATCH | `/api/v1/superadmin/trainings/:trainingId` | adminOnly | superadmin | blocked | - | updateTrainingSchema | trainingController.updateTraining |
| GET | `/api/v1/superadmin/trainings/:trainingId/progress` | adminOnly | superadmin | blocked | - | trainingIdParamSchema | trainingController.getProgress |
| POST | `/api/v1/superadmin/trainings/:trainingId/quiz` | adminOnly | superadmin | blocked | - | createQuizQuestionSchema | trainingController.addQuizQuestion |
| DELETE | `/api/v1/superadmin/trainings/:trainingId/quiz/:questionId` | adminOnly | superadmin | blocked | - | trainingQuestionIdParamSchema | trainingController.deleteQuizQuestion |
| PATCH | `/api/v1/superadmin/trainings/:trainingId/quiz/:questionId` | adminOnly | superadmin | blocked | - | updateQuizQuestionSchema | trainingController.updateQuizQuestion |
| POST | `/api/v1/superadmin/trainings/:trainingId/steps` | adminOnly | superadmin | blocked | - | createStepSchema | trainingController.addStep |
| DELETE | `/api/v1/superadmin/trainings/:trainingId/steps/:stepId` | adminOnly | superadmin | blocked | - | trainingStepIdParamSchema | trainingController.deleteStep |
| PATCH | `/api/v1/superadmin/trainings/:trainingId/steps/:stepId` | adminOnly | superadmin | blocked | - | updateStepSchema | trainingController.updateStep |
| POST | `/api/v1/superadmin/trainings/upload` | adminOnly | superadmin | blocked | - | - | trainingController.uploadMedia |
| GET | `/api/v1/superadmin/venue-commissions` | adminOnly | superadmin | blocked | - | - | venueCommissionController.getVenueCommissions |
| POST | `/api/v1/superadmin/venue-commissions` | adminOnly | superadmin | blocked | - | - | venueCommissionController.createVenueCommission |
| DELETE | `/api/v1/superadmin/venue-commissions/:id` | adminOnly | superadmin | blocked | - | - | venueCommissionController.deleteVenueCommission |
| GET | `/api/v1/superadmin/venue-commissions/:id` | adminOnly | superadmin | blocked | - | - | venueCommissionController.getVenueCommissionById |
| PUT | `/api/v1/superadmin/venue-commissions/:id` | adminOnly | superadmin | blocked | - | - | venueCommissionController.updateVenueCommission |
| POST | `/api/v1/superadmin/venue-pricing/config` | adminOnly | superadmin | blocked | - | - | venuePricingController.createVenuePaymentConfig |
| DELETE | `/api/v1/superadmin/venue-pricing/config/:venueId` | adminOnly | superadmin | blocked | - | - | venuePricingController.deleteVenuePaymentConfig |
| GET | `/api/v1/superadmin/venue-pricing/config/:venueId` | adminOnly | superadmin | blocked | - | - | venuePricingController.getVenuePaymentConfig |
| PUT | `/api/v1/superadmin/venue-pricing/config/:venueId` | adminOnly | superadmin | blocked | - | - | venuePricingController.updateVenuePaymentConfig |
| GET | `/api/v1/superadmin/venue-pricing/configs-by-merchant/:merchantAccountId` | adminOnly | superadmin | blocked | - | - | venuePricingController.getVenueConfigsByMerchantAccount |
| GET | `/api/v1/superadmin/venue-pricing/structures` | adminOnly | superadmin | blocked | - | - | venuePricingController.getVenuePricingStructures |
| POST | `/api/v1/superadmin/venue-pricing/structures` | adminOnly | superadmin | blocked | - | - | venuePricingController.createVenuePricingStructure |
| DELETE | `/api/v1/superadmin/venue-pricing/structures/:id` | adminOnly | superadmin | blocked | - | - | venuePricingController.deleteVenuePricingStructure |
| GET | `/api/v1/superadmin/venue-pricing/structures/:id` | adminOnly | superadmin | blocked | - | - | venuePricingController.getVenuePricingStructure |
| PUT | `/api/v1/superadmin/venue-pricing/structures/:id` | adminOnly | superadmin | blocked | - | - | venuePricingController.updateVenuePricingStructure |
| PATCH | `/api/v1/superadmin/venue-pricing/structures/:id/deactivate` | adminOnly | superadmin | blocked | - | - | venuePricingController.deactivatePricingStructure |
| GET | `/api/v1/superadmin/venue-pricing/structures/active/:venueId/:accountType` | adminOnly | superadmin | blocked | - | - | venuePricingController.getActivePricingStructure |
| POST | `/api/v1/superadmin/venue-pricing/structures/flat-rate` | adminOnly | superadmin | blocked | - | - | venuePricingController.createFlatRatePricingStructure |
| GET | `/api/v1/superadmin/venues/:venueId/angelpay-account` | adminOnly | superadmin | blocked | - | - | angelpayController.getAngelPayUserAccountForVenue |
| POST | `/api/v1/superadmin/venues/:venueId/angelpay-account` | adminOnly | superadmin | blocked | - | - | angelpayController.createAngelPayUserAccountForVenue |
| GET | `/api/v1/superadmin/venues/:venueId/angelpay-accounts` | adminOnly | superadmin | blocked | - | - | angelpayController.listAngelPayUserAccountsForVenue |
| POST | `/api/v1/superadmin/venues/:venueId/angelpay-fetch-merchants` | adminOnly | superadmin | blocked | - | - | angelpayController.dispatchFetchAngelPayMerchantsForVenue |
| POST | `/api/v1/superadmin/venues/:venueId/angelpay-merchants/:merchantAccountId/approve` | adminOnly | superadmin | blocked | - | - | angelpayController.approveAngelPayDiscoveredMerchantController |
| POST | `/api/v1/superadmin/venues/:venueId/angelpay-reserve-slot` | adminOnly | superadmin | blocked | - | - | angelpayController.reserveAngelPaySlotController |
| POST | `/api/v1/superadmin/venues/:venueId/staff-access` | adminOnly | superadmin | blocked | - | grantVenueAccessSchema | controller.grant |
| GET | `/api/v1/superadmin/venues/:venueId/staff-access/candidates` | adminOnly | superadmin | blocked | - | listCandidatesSchema | controller.candidates |
| GET | `/api/v1/superadmin/webhooks` | adminOnly | public | blocked | - | - | webhookController.listWebhookEvents |
| GET | `/api/v1/superadmin/webhooks/:eventId` | adminOnly | public | blocked | - | - | webhookController.getWebhookEventDetails |
| POST | `/api/v1/superadmin/webhooks/:eventId/retry` | adminOnly | public | blocked | - | - | webhookController.retryWebhookEvent |
| GET | `/api/v1/superadmin/webhooks/event-types` | adminOnly | public | blocked | - | - | webhookController.getEventTypes |
| GET | `/api/v1/superadmin/webhooks/metrics` | adminOnly | public | blocked | - | - | webhookController.getWebhookMetrics |
| POST | `/api/v1/tpv/activate` | action | unknown | missing | - | activateTerminalSchema | activationController.activateTerminal |
| POST | `/api/v1/tpv/angelpay/report-discovered-merchants` | action | unknown | missing | - | - | angelpayValidationController.reportDiscoveredMerchants |
| POST | `/api/v1/tpv/angelpay/report-merchant-switch` | action | unknown | missing | - | - | angelpayValidationController.reportAngelPayMerchantSwitch |
| POST | `/api/v1/tpv/angelpay/report-validation` | action | unknown | missing | - | - | angelpayValidationController.reportAngelPayValidation |
| POST | `/api/v1/tpv/auth/logout` | action | unknown | missing | - | logoutSchema | authController.staffLogout |
| GET | `/api/v1/tpv/auth/permissions` | read | unknown | partial | - | - | (inline handler) |
| POST | `/api/v1/tpv/auth/refresh` | action | unknown | missing | - | refreshTokenSchema | authController.refreshAccessToken |
| GET | `/api/v1/tpv/cash-out/my-saldo` | read | unknown | missing | cash-out:view_own | - | (inline handler) |
| POST | `/api/v1/tpv/cash-out/withdraw` | action | unknown | missing | cash-out:withdraw | - | (inline handler) |
| GET | `/api/v1/tpv/check-update` | read | unknown | missing | - | - | appUpdateController.checkForUpdate |
| POST | `/api/v1/tpv/command-ack` | action | unknown | missing | - | - | heartbeatController.acknowledgeCommand |
| POST | `/api/v1/tpv/geolocation/cell-towers` | action | unknown | missing | - | - | (inline handler) |
| POST | `/api/v1/tpv/geolocation/promoter-ping` | action | unknown | missing | - | recordPromoterPingSchema | (inline handler) |
| GET | `/api/v1/tpv/get-version` | read | unknown | missing | - | - | appUpdateController.getSpecificVersion |
| POST | `/api/v1/tpv/heartbeat` | action | unknown | missing | - | - | heartbeatController.processHeartbeat |
| POST | `/api/v1/tpv/messages/:messageId/acknowledge` | action | unknown | missing | - | - | tpvMessageController.acknowledgeMessage |
| POST | `/api/v1/tpv/messages/:messageId/dismiss` | action | unknown | missing | - | - | tpvMessageController.dismissMessage |
| POST | `/api/v1/tpv/messages/:messageId/respond` | action | unknown | missing | - | - | tpvMessageController.respondToMessage |
| GET | `/api/v1/tpv/messages/history` | read | unknown | missing | - | - | tpvMessageController.getMessageHistory |
| GET | `/api/v1/tpv/messages/pending` | read | unknown | missing | - | - | tpvMessageController.getPendingMessages |
| GET | `/api/v1/tpv/modules` | read | unknown | missing | - | - | (inline handler) |
| POST | `/api/v1/tpv/orders/:orderId/serialized-item` | action | unknown | partial | orders:update | - | (inline handler) |
| POST | `/api/v1/tpv/report-install-attempt` | action | unknown | missing | - | - | appUpdateController.reportInstallAttempt |
| POST | `/api/v1/tpv/report-update-installed` | action | unknown | missing | - | - | appUpdateController.reportUpdateInstalled |
| GET | `/api/v1/tpv/sales-goal` | read | unknown | partial | - | - | (inline handler) |
| GET | `/api/v1/tpv/sales-goals` | read | unknown | partial | - | - | (inline handler) |
| GET | `/api/v1/tpv/serial-number/:serialNumber` | read | unknown | missing | - | serialNumberParamSchema | venueController.getVenueIdFromSerialNumber |
| GET | `/api/v1/tpv/serialized-inventory/categories` | read | unknown | partial | - | - | (inline handler) |
| POST | `/api/v1/tpv/serialized-inventory/categories` | action | unknown | partial | - | - | (inline handler) |
| GET | `/api/v1/tpv/serialized-inventory/my-sales` | read | unknown | partial | serialized-inventory:sell | - | (inline handler) |
| POST | `/api/v1/tpv/serialized-inventory/register-batch` | action | unknown | partial | serialized-inventory:create | - | (inline handler) |
| POST | `/api/v1/tpv/serialized-inventory/scan` | action | unknown | partial | - | - | (inline handler) |
| POST | `/api/v1/tpv/serialized-inventory/sell` | action | unknown | partial | serialized-inventory:sell | - | (inline handler) |
| POST | `/api/v1/tpv/sim-custody/accept` | action | unknown | missing | tpv-sim-custody:accept | - | acceptSims |
| GET | `/api/v1/tpv/sim-custody/my-sims` | read | unknown | missing | - | - | listMySims |
| POST | `/api/v1/tpv/sim-custody/reject` | action | unknown | missing | tpv-sim-custody:reject | - | rejectSim |
| GET | `/api/v1/tpv/staff/:staffId/time-summary` | read | unknown | partial | - | - | timeEntryController.getStaffTimeSummary |
| GET | `/api/v1/tpv/status-sync/:serialNumber` | read | unknown | missing | - | serialNumberParamSchema | heartbeatController.getTerminalStatus |
| POST | `/api/v1/tpv/superadmin/modules/toggle` | adminOnly | superadmin | blocked | - | - | (inline handler) |
| GET | `/api/v1/tpv/terminals/:serialNumber/activation-status` | read | unknown | missing | - | - | activationController.checkActivationStatus |
| GET | `/api/v1/tpv/terminals/:serialNumber/config` | read | unknown | missing | - | serialNumberParamSchema | terminalController.getTerminalConfig |
| PUT | `/api/v1/tpv/terminals/:serialNumber/settings` | mutation | unknown | missing | - | - | terminalController.updateTpvSettings |
| POST | `/api/v1/tpv/time-entries/:timeEntryId/break/end` | action | unknown | missing | - | - | timeEntryController.endBreak |
| POST | `/api/v1/tpv/time-entries/:timeEntryId/break/start` | action | unknown | missing | - | - | timeEntryController.startBreak |
| GET | `/api/v1/tpv/trainings` | read | unknown | missing | - | - | trainingController.getTrainings |
| GET | `/api/v1/tpv/trainings/:trainingId` | read | unknown | missing | - | trainingIdParamSchema | trainingController.getTrainingDetail |
| POST | `/api/v1/tpv/trainings/:trainingId/progress` | action | unknown | missing | - | updateProgressSchema | trainingController.updateProgress |
| GET | `/api/v1/tpv/trainings/progress` | read | unknown | missing | - | getStaffProgressQuerySchema | trainingController.getStaffProgress |
| GET | `/api/v1/tpv/venues/:venueId` | read | venue | missing | home:read | venueIdParamSchema | venueController.getVenueById |
| POST | `/api/v1/tpv/venues/:venueId/auth` | action | venue | missing | - | pinLoginSchema | authController.staffSignIn |
| POST | `/api/v1/tpv/venues/:venueId/auth/logout` | action | venue | missing | - | logoutSchema | authController.staffLogout |
| POST | `/api/v1/tpv/venues/:venueId/auth/master` | action | venue | missing | - | - | authController.masterSignIn |
| POST | `/api/v1/tpv/venues/:venueId/auth/refresh` | action | venue | missing | - | refreshTokenSchema | authController.refreshAccessToken |
| POST | `/api/v1/tpv/venues/:venueId/coupons/validate` | action | venue | missing | orders:read | validateCouponSchema | discountController.validateCoupon |
| POST | `/api/v1/tpv/venues/:venueId/crypto/cancel` | dangerousMutation | venue | missing | payments:create | cancelCryptoPaymentSchema | cryptoController.cancelCryptoPaymentHandler |
| POST | `/api/v1/tpv/venues/:venueId/crypto/initiate` | action | venue | missing | payments:create | initiateCryptoPaymentSchema | cryptoController.initiateCryptoPaymentHandler |
| GET | `/api/v1/tpv/venues/:venueId/crypto/status/:requestId` | read | venue | missing | - | getCryptoPaymentStatusSchema | cryptoController.getCryptoPaymentStatusHandler |
| POST | `/api/v1/tpv/venues/:venueId/customers` | action | venue | partial | customers:create | - | customerController.quickCreateCustomer |
| GET | `/api/v1/tpv/venues/:venueId/customers/:customerId` | read | venue | partial | customers:read | - | customerController.getCustomer |
| GET | `/api/v1/tpv/venues/:venueId/customers/recent` | read | venue | partial | customers:read | - | customerController.getRecentCustomers |
| GET | `/api/v1/tpv/venues/:venueId/customers/search` | read | venue | partial | customers:read | - | customerController.searchCustomers |
| POST | `/api/v1/tpv/venues/:venueId/fast` | action | venue | missing | payments:create | recordFastPaymentParamsSchema, recordPaymentBodySchema | paymentController.recordFastPayment |
| GET | `/api/v1/tpv/venues/:venueId/floor-elements` | read | venue | missing | - | - | floorElementController.getFloorElements |
| POST | `/api/v1/tpv/venues/:venueId/floor-elements` | action | venue | missing | - | - | floorElementController.createFloorElement |
| DELETE | `/api/v1/tpv/venues/:venueId/floor-elements/:elementId` | dangerousMutation | venue | missing | - | - | floorElementController.deleteFloorElement |
| PUT | `/api/v1/tpv/venues/:venueId/floor-elements/:elementId` | mutation | venue | missing | - | - | floorElementController.updateFloorElement |
| POST | `/api/v1/tpv/venues/:venueId/menta/route` | action | venue | missing | payments:create | paymentRouteSchema | paymentController.getMentaRoute |
| GET | `/api/v1/tpv/venues/:venueId/merchant-accounts` | read | venue | missing | payments:read | venueIdParamSchema | paymentController.getMerchantAccounts |
| POST | `/api/v1/tpv/venues/:venueId/merchant-eligibility` | action | venue | missing | payments:read | merchantEligibilityRequestSchema | merchantRoutingController.getMerchantEligibility |
| GET | `/api/v1/tpv/venues/:venueId/orders` | read | venue | partial | orders:read | venueIdParamSchema | orderController.getOrders |
| POST | `/api/v1/tpv/venues/:venueId/orders` | action | venue | partial | orders:create | - | orderController.createOrder |
| GET | `/api/v1/tpv/venues/:venueId/orders/:orderId` | read | venue | partial | orders:read | orderParamsSchema | orderController.getOrder |
| POST | `/api/v1/tpv/venues/:venueId/orders/:orderId` | action | venue | partial | payments:create | recordPaymentBodySchema, recordPaymentParamsSchema | paymentController.recordPayment |
| POST | `/api/v1/tpv/venues/:venueId/orders/:orderId/comp` | action | venue | partial | orders:comp | compItemsSchema | orderController.compItems |
| GET | `/api/v1/tpv/venues/:venueId/orders/:orderId/customers` | read | venue | partial | orders:read | - | orderController.getOrderCustomers |
| POST | `/api/v1/tpv/venues/:venueId/orders/:orderId/customers` | action | venue | partial | orders:update | addOrderCustomerSchema | orderController.addCustomerToOrder |
| DELETE | `/api/v1/tpv/venues/:venueId/orders/:orderId/customers/:customerId` | dangerousMutation | venue | partial | orders:update | removeOrderCustomerSchema | orderController.removeCustomerFromOrder |
| POST | `/api/v1/tpv/venues/:venueId/orders/:orderId/customers/create` | action | venue | partial | orders:update | createAndAddCustomerSchema | orderController.createAndAddCustomerToOrder |
| POST | `/api/v1/tpv/venues/:venueId/orders/:orderId/discount` | action | venue | partial | discounts:apply | applyDiscountSchema | orderController.applyDiscount |
| GET | `/api/v1/tpv/venues/:venueId/orders/:orderId/discounts` | read | venue | partial | orders:read | getOrderDiscountsSchema | discountController.getOrderDiscounts |
| DELETE | `/api/v1/tpv/venues/:venueId/orders/:orderId/discounts/:discountId` | dangerousMutation | venue | partial | discounts:apply | removeOrderDiscountSchema | discountController.removeDiscount |
| POST | `/api/v1/tpv/venues/:venueId/orders/:orderId/discounts/apply` | action | venue | partial | discounts:apply | applyPredefinedDiscountSchema | discountController.applyPredefinedDiscount |
| POST | `/api/v1/tpv/venues/:venueId/orders/:orderId/discounts/auto` | action | venue | partial | discounts:apply | applyAutomaticDiscountsSchema | discountController.applyAutomaticDiscounts |
| GET | `/api/v1/tpv/venues/:venueId/orders/:orderId/discounts/available` | read | venue | partial | orders:read | getAvailableDiscountsSchema | discountController.getAvailableDiscounts |
| POST | `/api/v1/tpv/venues/:venueId/orders/:orderId/discounts/coupon` | action | venue | partial | discounts:apply | applyCouponCodeSchema | discountController.applyCouponCode |
| POST | `/api/v1/tpv/venues/:venueId/orders/:orderId/discounts/manual` | action | venue | partial | discounts:apply | applyManualDiscountSchema | discountController.applyManualDiscount |
| PATCH | `/api/v1/tpv/venues/:venueId/orders/:orderId/guest` | mutation | venue | partial | orders:update | updateGuestInfoSchema | orderController.updateGuestInfo |
| PATCH | `/api/v1/tpv/venues/:venueId/orders/:orderId/items` | mutation | venue | partial | - | addOrderItemsSchema | orderController.addItemsToOrder |
| DELETE | `/api/v1/tpv/venues/:venueId/orders/:orderId/items/:itemId` | dangerousMutation | venue | partial | orders:update | removeOrderItemSchema | orderController.removeOrderItem |
| POST | `/api/v1/tpv/venues/:venueId/orders/:orderId/void` | dangerousMutation | venue | partial | orders:void | voidItemsSchema | orderController.voidItems |
| GET | `/api/v1/tpv/venues/:venueId/orders/pay-later` | read | venue | partial | orders:read | venueIdParamSchema | orderController.getPayLaterOrders |
| POST | `/api/v1/tpv/venues/:venueId/orders/with-items` | action | venue | partial | orders:create | createOrderWithItemsSchema | orderController.createOrderWithItems |
| POST | `/api/v1/tpv/venues/:venueId/payments` | action | venue | partial | payments:read | paymentsQuerySchema | paymentController.getPayments |
| POST | `/api/v1/tpv/venues/:venueId/payments/:paymentId/send-receipt` | action | venue | partial | - | sendReceiptBodySchema, sendReceiptParamsSchema | paymentController.sendPaymentReceipt |
| POST | `/api/v1/tpv/venues/:venueId/payments/:paymentId/send-whatsapp` | action | venue | partial | - | sendReceiptParamsSchema, sendWhatsAppReceiptBodySchema | paymentController.sendPaymentReceiptWhatsApp |
| GET | `/api/v1/tpv/venues/:venueId/payments/:paymentId/verificacion` | read | venue | partial | payments:read | - | saleVerificationController.getVerificationByPaymentId |
| GET | `/api/v1/tpv/venues/:venueId/products/barcode/:barcode` | read | venue | partial | menu:read | - | (inline handler) |
| POST | `/api/v1/tpv/venues/:venueId/products/quick-add` | action | venue | partial | menu:create | - | (inline handler) |
| POST | `/api/v1/tpv/venues/:venueId/refunds` | dangerousMutation | venue | missing | payments:refund | recordFastPaymentParamsSchema | // Reuse for venueId param validation refundController.recordRefund |
| GET | `/api/v1/tpv/venues/:venueId/reports/historical` | read | venue | missing | tpv-reports:read | - | reportsController.getHistoricalReports |
| GET | `/api/v1/tpv/venues/:venueId/shift` | read | venue | partial | shifts:read | shiftQuerySchema | shiftController.getCurrentShift |
| GET | `/api/v1/tpv/venues/:venueId/shifts` | read | venue | partial | shifts:read | shiftsQuerySchema | shiftController.getShifts |
| GET | `/api/v1/tpv/venues/:venueId/shifts-summary` | read | venue | partial | shifts:read | shiftsSummaryQuerySchema | shiftController.getShiftsSummary |
| POST | `/api/v1/tpv/venues/:venueId/shifts/:shiftId/close` | action | venue | partial | shifts:close | - | shiftController.closeShift |
| POST | `/api/v1/tpv/venues/:venueId/shifts/open` | action | venue | partial | shifts:create | - | shiftController.openShift |
| GET | `/api/v1/tpv/venues/:venueId/staff/:staffId/time-entries` | read | venue | missing | - | - | // No permission check - staff can always see their OWN entries timeEntryController.getMyTimeEntries |
| GET | `/api/v1/tpv/venues/:venueId/tables` | read | venue | missing | - | tableParamsSchema | tableController.getTables |
| POST | `/api/v1/tpv/venues/:venueId/tables` | action | venue | missing | - | - | tableController.createTable |
| DELETE | `/api/v1/tpv/venues/:venueId/tables/:tableId` | dangerousMutation | venue | missing | - | - | tableController.deleteTable |
| PUT | `/api/v1/tpv/venues/:venueId/tables/:tableId` | mutation | venue | missing | - | - | tableController.updateTable |
| POST | `/api/v1/tpv/venues/:venueId/tables/:tableId/clear` | action | venue | missing | - | clearTableSchema | tableController.clearTable |
| PUT | `/api/v1/tpv/venues/:venueId/tables/:tableId/position` | mutation | venue | missing | - | - | tableController.updateTablePosition |
| POST | `/api/v1/tpv/venues/:venueId/tables/assign` | action | venue | missing | - | assignTableSchema | tableController.assignTable |
| GET | `/api/v1/tpv/venues/:venueId/time-entries` | read | venue | missing | tpv-time-entries:read | - | timeEntryController.getTimeEntries |
| GET | `/api/v1/tpv/venues/:venueId/time-entries/active` | read | venue | missing | tpv-time-entries:read | - | timeEntryController.getCurrentlyClockedInStaff |
| POST | `/api/v1/tpv/venues/:venueId/time-entries/clock-in` | action | venue | missing | - | - | timeEntryController.clockIn |
| POST | `/api/v1/tpv/venues/:venueId/time-entries/clock-out` | action | venue | missing | - | - | timeEntryController.clockOut |
| GET | `/api/v1/tpv/venues/:venueId/verificaciones` | read | venue | missing | payments:read | listSaleVerificationsSchema | saleVerificationController.listSaleVerifications |
| POST | `/api/v1/tpv/venues/:venueId/verificaciones` | action | venue | missing | payments:create | createSaleVerificationSchema | saleVerificationController.createSaleVerification |
| GET | `/api/v1/tpv/venues/:venueId/verificaciones/:verificationId` | read | venue | missing | payments:read | getSaleVerificationSchema | saleVerificationController.getSaleVerification |
| GET | `/api/v1/tpv/verification/:verificationId` | read | unknown | missing | payments:read | - | saleVerificationController.getVerificationDetail |
| GET | `/api/v1/tpv/verification/pending` | read | unknown | missing | payments:read | - | saleVerificationController.getPendingVerifications |
| POST | `/api/v1/tpv/verification/proof-of-sale` | action | unknown | missing | payments:create | createProofOfSaleSchema | saleVerificationController.createProofOfSale |
| GET | `/api/v1/venues/:venueId/public-menu/venues/:venueId/menu` | public | public | blocked | - | - | (inline handler) |
| POST | `/api/v1/webhooks/angelpay/:merchantAccountId` | public | public | blocked | - | - | handleAngelPayWebhook |
| GET | `/api/v1/webhooks/angelpay/health` | public | public | blocked | - | - | angelpayWebhookHealthCheck |
| POST | `/api/v1/webhooks/b4bit` | public | public | blocked | - | - | handleB4BitWebhook |
| GET | `/api/v1/webhooks/b4bit/health` | public | public | blocked | - | - | b4bitWebhookHealthCheck |
| POST | `/api/v1/webhooks/blumon/tpv` | public | public | blocked | - | - | handleBlumonTPVWebhook |
| GET | `/api/v1/webhooks/blumon/tpv/health` | public | public | blocked | - | - | blumonWebhookHealthCheck |
| POST | `/api/v1/webhooks/delivery/deliverect/:channelLinkId/orders` | public | public | blocked | - | - | handleDeliverectOrderWebhook |
| GET | `/api/v1/webhooks/delivery/deliverect/health` | public | public | blocked | - | - | deliverectWebhookHealthCheck |
| POST | `/api/v1/webhooks/resend` | public | public | blocked | - | - | handleResendWebhook |
| GET | `/api/v1/webhooks/resend/health` | public | public | blocked | - | - | resendWebhookHealthCheck |
| POST | `/api/v1/webhooks/stripe` | public | public | blocked | - | - | handleStripeWebhook |
| POST | `/api/v1/webhooks/stripe/connect` | public | public | blocked | - | - | handleStripeConnectWebhook |
| POST | `/api/v1/webhooks/stripe/platform` | public | public | blocked | - | - | handleStripeWebhook |
| GET | `/api/v1/webhooks/whatsapp` | public | public | blocked | - | - | handleWhatsappVerify |
| POST | `/api/v1/webhooks/whatsapp` | public | public | blocked | - | - | handleWhatsappInbound |
| GET | `/reports/settlement/:token` | public | public | blocked | - | - | (inline handler) |
