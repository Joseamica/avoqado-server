import { Router } from 'express'
import * as superadminController from '../../controllers/dashboard/superadmin.controller'

import { validateRequest } from '../../middlewares/validation'

import { z } from 'zod'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'

const router = Router()

// All superadmin routes require authentication
router.use(authenticateTokenMiddleware)

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
router.get('/venues/:venueId', superadminController.getVenueDetails)
router.post('/venues/:venueId/approve', superadminController.approveVenue)
router.post('/venues/:venueId/suspend', validateRequest(suspendVenueSchema), superadminController.suspendVenue)

// Feature management routes
router.get('/features', superadminController.getAllFeatures)
router.post('/features', validateRequest(createFeatureSchema), superadminController.createFeature)
router.post('/venues/:venueId/features/:featureCode/enable', superadminController.enableFeatureForVenue)
router.delete('/venues/:venueId/features/:featureCode/disable', superadminController.disableFeatureForVenue)

export default router
