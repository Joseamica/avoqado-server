// src/routes/superadmin.routes.ts
import express from 'express'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware'
import { authorizeRole } from '../middlewares/authorizeRole.middleware'
import { StaffRole } from '@prisma/client'

// Import superadmin sub-routes
import kycReviewRoutes from './superadmin/kycReview.routes'
import paymentProviderRoutes from './superadmin/paymentProvider.routes'
import merchantAccountRoutes from './superadmin/merchantAccount.routes'
import paymentAnalyticsRoutes from './superadmin/paymentAnalytics.routes'
import earningsRoutes from './superadmin/earnings.routes'
import providerCostStructureRoutes from './superadmin/providerCostStructure.routes'
import venuePricingRoutes from './superadmin/venuePricing.routes'
import webhookRoutes from './superadmin/webhook.routes'
import terminalRoutes from './superadmin/terminal.routes'
import venueAccessRoutes from './superadmin/venue-access.routes'
import creditAssessmentRoutes from './superadmin/creditAssessment.routes'
import moduleRoutes from './superadmin/module.routes'
import onboardingRoutes from './superadmin/onboarding.routes'
import trainingRoutes from './superadmin/training.routes'
import activityLogRoutes from './superadmin/activityLog.routes'
import dashboardRoutes from './superadmin/dashboard.routes'
import systemLogsRoutes from './superadmin/systemLogs.routes'
import partnerKeyRoutes from './superadmin/partnerKey.routes'
import aggregatorRoutes from './superadmin/aggregator.routes'
import holidaysRoutes from './superadmin/holidays.routes'
import venueCommissionRoutes from './superadmin/venueCommission.routes'
import settlementConfigRoutes from './superadmin/settlementConfiguration.routes'
import merchantRevenueShareRoutes from './superadmin/merchantRevenueShare.routes'
import stripeConnectOffboardingRoutes from './superadmin/stripeConnectOffboarding.routes'
import angelpayUserAccountRoutes from './superadmin/angelpayUserAccount.routes'
import rateCorrectionRoutes from './superadmin/rateCorrection.routes'
import terminalOrderSuperadminRoutes from './superadmin/terminalOrder.routes'
// NOTE: appUpdateRoutes are mounted EARLY in app.ts with 100MB body limit for APK uploads
// Do NOT mount here to avoid duplicate route registration

const router = express.Router({ mergeParams: true })

// All superadmin routes require authentication and SUPERADMIN role
router.use(authenticateTokenMiddleware)
router.use(authorizeRole([StaffRole.SUPERADMIN]))

// Mount superadmin sub-routes
router.use('/kyc', kycReviewRoutes)
router.use('/payment-providers', paymentProviderRoutes)
router.use('/merchant-accounts', merchantAccountRoutes)
router.use('/terminals', terminalRoutes)
router.use('/venues', venueAccessRoutes)
router.use('/tpv-orders', terminalOrderSuperadminRoutes)
router.use('/payment-analytics', paymentAnalyticsRoutes)
router.use('/earnings', earningsRoutes)
router.use('/cost-structures', providerCostStructureRoutes)
router.use('/venue-pricing', venuePricingRoutes)
router.use('/rate-corrections', rateCorrectionRoutes)
router.use('/webhooks', webhookRoutes)
router.use('/credit', creditAssessmentRoutes)
router.use('/modules', moduleRoutes)
router.use('/onboarding', onboardingRoutes)
router.use('/trainings', trainingRoutes)
router.use('/activity-log', activityLogRoutes)
router.use('/dashboard', dashboardRoutes)
router.use('/system-logs', systemLogsRoutes)
router.use('/partner-keys', partnerKeyRoutes)
router.use('/aggregators', aggregatorRoutes)
router.use('/holidays', holidaysRoutes)
router.use('/venue-commissions', venueCommissionRoutes)
// Aditivo (2026-05): mismos controllers que ya viven en /api/v1/dashboard/superadmin/*,
// expuestos también aquí para que el frontend superadmin use un solo namespace.
router.use('/settlement-configurations', settlementConfigRoutes)
router.use('/merchant-revenue-shares', merchantRevenueShareRoutes)
router.use('/stripe-connect', stripeConnectOffboardingRoutes)
// AngelPay user accounts — mounted at root because endpoints span
// /venues/:venueId/angelpay-account AND /angelpay-accounts/:id/...
router.use('/', angelpayUserAccountRoutes)
// app-updates route is mounted in app.ts with 100MB body limit (not here)

export default router
