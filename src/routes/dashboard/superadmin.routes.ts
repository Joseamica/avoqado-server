import { Router } from 'express'
import * as superadminController from '../../controllers/dashboard/superadmin.controller'
import * as costManagementController from '../../controllers/dashboard/cost-management.controller'
import * as venuePaymentReadinessController from '../../controllers/dashboard/venuePaymentReadiness.controller'
import * as venuesSuperadminController from '../../controllers/dashboard/venues.superadmin.controller'
import * as serverMetricsController from '../../controllers/dashboard/serverMetrics.controller'

import { validateRequest } from '../../middlewares/validation'

import { z } from 'zod'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { checkPermission } from '@/middlewares/checkPermission.middleware'

// Import payment provider routes
import paymentProviderRoutes from '../superadmin/paymentProvider.routes'
import merchantAccountRoutes from '../superadmin/merchantAccount.routes'
import providerCostStructureRoutes from '../superadmin/providerCostStructure.routes'
import venuePricingRoutes from '../superadmin/venuePricing.routes'
import paymentAnalyticsRoutes from '../superadmin/paymentAnalytics.routes'
import webhookRoutes from '../superadmin/webhook.routes'
import kycReviewRoutes from '../superadmin/kycReview.routes'
import settlementConfigRoutes from '../superadmin/settlementConfiguration.routes'
import terminalRoutes from '../superadmin/terminal.routes'
import moduleRoutes from '../superadmin/module.routes'
import organizationRoutes from '../superadmin/organization.routes'
import pushNotificationsRoutes from '../superadmin/pushNotifications.routes'
import marketingRoutes from '../superadmin/marketing.routes'
import staffRoutes from '../superadmin/staff.routes'
import trainingRoutes from '../superadmin/training.routes'

// Import cost management validation schemas
import {
  profitMetricsQuerySchema,
  monthlyProfitsQuerySchema,
  transactionCostsQuerySchema,
  recalculateProfitsSchema,
  providerCostStructureSchema,
  venuePricingStructureSchema,
  updateMonthlyProfitStatusSchema,
  exportProfitDataQuerySchema,
  providerCostStructuresQuerySchema,
  venuePricingStructuresQuerySchema,
  merchantAccountsQuerySchema,
} from '../../schemas/dashboard/cost-management.schema'

const router = Router()

// All superadmin routes require authentication
router.use(authenticateTokenMiddleware)
// And must have system:manage permission (SUPERADMIN only)
router.use(checkPermission('system:manage'))

// Schema for venue status change
const changeVenueStatusSchema = z.object({
  body: z.object({
    status: z.enum(['LIVE_DEMO', 'TRIAL', 'ONBOARDING', 'PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'ADMIN_SUSPENDED', 'CLOSED']),
    reason: z.string().optional(),
  }),
})

// Schema for venue suspension
const suspendVenueSchema = z.object({
  body: z.object({
    reason: z.string().min(10, 'Suspension reason must be at least 10 characters'),
  }),
})

// Schema for granting DB-only trial
const grantTrialSchema = z.object({
  body: z.object({
    trialDays: z.number().int().min(1, 'Trial must be at least 1 day').max(365, 'Trial cannot exceed 365 days'),
  }),
})

// Schema for feature creation
const createFeatureSchema = z.object({
  body: z.object({
    name: z.string().min(3, 'Feature name must be at least 3 characters'),
    code: z
      .string()
      .min(3, 'Feature code must be at least 3 characters')
      .regex(/^[a-z_]+$/, 'Feature code must contain only lowercase letters and underscores'),
    description: z.string().min(10, 'Description must be at least 10 characters'),
    category: z.enum(['AI', 'ANALYTICS', 'CORE', 'INTEGRATIONS', 'PREMIUM']),
    pricingModel: z.enum(['FREE', 'FIXED', 'USAGE_BASED', 'TIERED']),
    basePrice: z.number().optional(),
    usagePrice: z.number().optional(),
    usageUnit: z.string().optional(),
    isCore: z.boolean().optional(),
  }),
})

// Schema for venue creation (superadmin)
const createVenueSchema = z.object({
  body: z.object({
    organizationId: z.string().cuid('Invalid organization ID'),
    name: z.string().min(1, 'Venue name is required'),
    type: z
      .enum([
        'RESTAURANT',
        'BAR',
        'CAFE',
        'BAKERY',
        'FOOD_TRUCK',
        'FAST_FOOD',
        'CATERING',
        'CLOUD_KITCHEN',
        'RETAIL_STORE',
        'JEWELRY',
        'CLOTHING',
        'ELECTRONICS',
        'CONVENIENCE_STORE',
        'SUPERMARKET',
        'PHARMACY',
        'PET_STORE',
        'BOOKSTORE',
        'HARDWARE_STORE',
        'BEAUTY_SUPPLY',
        'SALON',
        'SPA',
        'GYM',
        'YOGA_STUDIO',
        'CONSULTING',
        'COWORKING',
        'HOTEL',
        'HOSTEL',
        'RESORT',
        'NIGHTCLUB',
        'CINEMA',
        'ARCADE',
        'THEME_PARK',
        'CLINIC',
        'DENTAL',
        'VETERINARY',
        'OPTICAL',
        'TELECOM',
        'AUTO_SHOP',
        'LAUNDRY',
        'OTHER',
      ])
      .optional(),
    timezone: z.string().optional(),
    currency: z.string().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
  }),
})

// Schema for venue transfer
const transferVenueSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID'),
  }),
  body: z.object({
    targetOrganizationId: z.string().cuid('Invalid target organization ID'),
  }),
})

// Dashboard overview
router.get('/dashboard', superadminController.getDashboardData)

// Venue management routes
router.get('/venues', superadminController.getAllVenues)
router.get('/venues/list', superadminController.getVenuesListSimple) // Must be before :venueId route
router.get('/venues/:venueId', superadminController.getVenueDetails)
router.post('/venues/:venueId/approve', superadminController.approveVenue)
router.post('/venues/:venueId/suspend', validateRequest(suspendVenueSchema), superadminController.suspendVenue)
router.patch('/venues/:venueId/status', validateRequest(changeVenueStatusSchema), superadminController.changeVenueStatus)
router.post('/venues', validateRequest(createVenueSchema), venuesSuperadminController.createVenue)
router.patch('/venues/:venueId/transfer', validateRequest(transferVenueSchema), venuesSuperadminController.transferVenue)

// Feature management routes
router.get('/features', superadminController.getAllFeatures)
router.post('/features', validateRequest(createFeatureSchema), superadminController.createFeature)
router.post('/venues/:venueId/features/:featureCode/enable', superadminController.enableFeatureForVenue)
router.delete('/venues/:venueId/features/:featureCode/disable', superadminController.disableFeatureForVenue)
router.post(
  '/venues/:venueId/features/:featureCode/grant-trial',
  validateRequest(grantTrialSchema),
  superadminController.grantTrialForVenue,
)

// Revenue tracking routes
router.get('/revenue/metrics', superadminController.getRevenueMetrics)
router.get('/revenue/breakdown', superadminController.getRevenueBreakdown)

// Cost Management & Profit Analytics routes
router.get('/profit/metrics', validateRequest(profitMetricsQuerySchema), costManagementController.getProfitMetrics)
router.get('/profit/monthly', validateRequest(monthlyProfitsQuerySchema), costManagementController.getMonthlyProfits)
router.post('/profit/recalculate', validateRequest(recalculateProfitsSchema), costManagementController.recalculateProfits)
router.get('/cost-structures/analysis', costManagementController.getCostStructureAnalysis)
router.get('/transaction-costs', validateRequest(transactionCostsQuerySchema), costManagementController.getTransactionCosts)

// Provider Cost Structure Management
router.get(
  '/cost-structures/provider',
  validateRequest(providerCostStructuresQuerySchema),
  costManagementController.getProviderCostStructures,
)
router.post('/cost-structures/provider', validateRequest(providerCostStructureSchema), costManagementController.upsertProviderCostStructure)

// Venue Pricing Structure Management
router.get(
  '/pricing-structures/venue',
  validateRequest(venuePricingStructuresQuerySchema),
  costManagementController.getVenuePricingStructures,
)
router.post('/pricing-structures/venue', validateRequest(venuePricingStructureSchema), costManagementController.upsertVenuePricingStructure)

// Monthly Profit Management
router.patch(
  '/profit/monthly/:monthlyProfitId/status',
  validateRequest(updateMonthlyProfitStatusSchema),
  costManagementController.updateMonthlyProfitStatus,
)

// Data Export
router.get('/profit/export', validateRequest(exportProfitDataQuerySchema), costManagementController.exportProfitData)

// Support endpoints for dropdowns and selection
router.get('/providers', superadminController.getProvidersList)
router.get('/merchant-accounts/list', validateRequest(merchantAccountsQuerySchema), superadminController.getMerchantAccountsList)

// Payment Provider Management
router.use('/payment-providers', paymentProviderRoutes)

// Merchant Account Management (Full CRUD)
router.use('/merchant-accounts', merchantAccountRoutes)

// Provider Cost Structure Management
router.use('/provider-cost-structures', providerCostStructureRoutes)

// Venue Pricing Management (Payment Config + Pricing Structures)
router.use('/venue-pricing', venuePricingRoutes)

// Payment Analytics (Revenue & Profit Reporting)
router.use('/payment-analytics', paymentAnalyticsRoutes)

// Webhook Monitoring & Debugging
router.use('/webhooks', webhookRoutes)

// KYC Review & Approval Workflow
router.use('/kyc', kycReviewRoutes)

// Settlement Configuration Management
router.use('/settlement-configurations', settlementConfigRoutes)

// Terminal Management (Create, Update, Assign Merchants)
router.use('/terminals', terminalRoutes)

// Module Management (Enable/Disable modules for venues)
router.use('/modules', moduleRoutes)

// Organization Management (CRUD + Module Assignment)
router.use('/organizations', organizationRoutes)

// Push Notifications Testing & Management
router.use('/push-notifications', pushNotificationsRoutes)

// Marketing Campaigns (Mass Email)
router.use('/marketing', marketingRoutes)

// Staff Management (CRUD + Org/Venue Assignment)
router.use('/staff', staffRoutes)

// Training / LMS Management
router.use('/trainings', trainingRoutes)

// Payment Readiness Check (for superadmin dashboard)
router.get('/payment-readiness', venuePaymentReadinessController.getMultipleVenuesPaymentReadiness)

// Server Metrics (health monitoring)
router.get('/server-metrics', serverMetricsController.getServerMetrics)

// Master TOTP Setup (QR code for Google Authenticator)
router.get('/master-totp/setup', superadminController.getMasterTotpSetup)

// Note: App Updates routes are mounted early in app.ts at /api/v1/superadmin/app-updates
// with 100MB body limit for APK uploads

export default router
