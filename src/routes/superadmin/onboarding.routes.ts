import { Router } from 'express'
import * as onboardingController from '../../controllers/superadmin/onboarding.controller'

const router = Router()

/**
 * Superadmin Onboarding Routes
 * Base path: /api/v1/superadmin/onboarding
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 */

// GET /organizations — List orgs with venue count + payment config status
router.get('/organizations', onboardingController.getOrganizationsForSelector)

// GET /org-payment-status/:orgId — Check if org has payment config
router.get('/org-payment-status/:orgId', onboardingController.getOrgPaymentStatus)

// GET /merchant-accounts — List active merchant accounts for org config selector
router.get('/merchant-accounts', onboardingController.getMerchantAccountsForSelector)

// POST /venue — Create a fully-configured venue in one shot
router.post('/venue', onboardingController.createVenueWizard)

export default router
