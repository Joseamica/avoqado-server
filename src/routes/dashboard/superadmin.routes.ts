import { Router } from 'express'
import * as superadminController from '../../controllers/dashboard/superadmin.controller'
import * as costManagementController from '../../controllers/dashboard/cost-management.controller'

import { validateRequest } from '../../middlewares/validation'

import { z } from 'zod'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { authorizeRole } from '@/middlewares/authorizeRole.middleware'
import { StaffRole } from '@/security'

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
// And must be SUPERADMIN
router.use(authorizeRole([StaffRole.SUPERADMIN]))

// Schema for venue suspension
const suspendVenueSchema = z.object({
  body: z.object({
    reason: z.string().min(10, 'Suspension reason must be at least 10 characters'),
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

// Dashboard overview
router.get('/dashboard', superadminController.getDashboardData)

// Venue management routes
router.get('/venues', superadminController.getAllVenues)
router.get('/venues/list', superadminController.getVenuesListSimple) // Must be before :venueId route
router.get('/venues/:venueId', superadminController.getVenueDetails)
router.post('/venues/:venueId/approve', superadminController.approveVenue)
router.post('/venues/:venueId/suspend', validateRequest(suspendVenueSchema), superadminController.suspendVenue)

// Feature management routes
router.get('/features', superadminController.getAllFeatures)
router.post('/features', validateRequest(createFeatureSchema), superadminController.createFeature)
router.post('/venues/:venueId/features/:featureCode/enable', superadminController.enableFeatureForVenue)
router.delete('/venues/:venueId/features/:featureCode/disable', superadminController.disableFeatureForVenue)

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
router.get('/merchant-accounts', validateRequest(merchantAccountsQuerySchema), superadminController.getMerchantAccountsList)

export default router
