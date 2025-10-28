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

const router = express.Router({ mergeParams: true })

// All superadmin routes require authentication and SUPERADMIN role
router.use(authenticateTokenMiddleware)
router.use(authorizeRole([StaffRole.SUPERADMIN]))

// Mount superadmin sub-routes
router.use('/kyc', kycReviewRoutes)
router.use('/payment-providers', paymentProviderRoutes)
router.use('/merchant-accounts', merchantAccountRoutes)
router.use('/payment-analytics', paymentAnalyticsRoutes)
router.use('/cost-structures', providerCostStructureRoutes)
router.use('/venue-pricing', venuePricingRoutes)
router.use('/webhooks', webhookRoutes)

export default router
