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
import providerCostStructureRoutes from './superadmin/providerCostStructure.routes'
import venuePricingRoutes from './superadmin/venuePricing.routes'
import webhookRoutes from './superadmin/webhook.routes'
import terminalRoutes from './superadmin/terminal.routes'
import creditAssessmentRoutes from './superadmin/creditAssessment.routes'
import moduleRoutes from './superadmin/module.routes'
import onboardingRoutes from './superadmin/onboarding.routes'
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
router.use('/payment-analytics', paymentAnalyticsRoutes)
router.use('/cost-structures', providerCostStructureRoutes)
router.use('/venue-pricing', venuePricingRoutes)
router.use('/webhooks', webhookRoutes)
router.use('/credit', creditAssessmentRoutes)
router.use('/modules', moduleRoutes)
router.use('/onboarding', onboardingRoutes)
// app-updates route is mounted in app.ts with 100MB body limit (not here)

export default router
