import { Router } from 'express'
import { validateRequest } from '../../middlewares/validation'
import { checkPermission } from '../../middlewares/checkPermission.middleware'

// Controllers
import * as referralsController from '../../controllers/dashboard/referrals/referrals.controller'

// Schemas
import {
  ActivateReferralProgramSchema,
  UpdateReferralConfigSchema,
  DeactivateReferralProgramSchema,
  ValidateReferralCodeSchema,
  CaptureReferralSchema,
  ForceOverrideReferralSchema,
  ManualVoidReferralSchema,
  ListReferralsQuerySchema,
} from '../../schemas/dashboard/referrals.schemas'

const router = Router({ mergeParams: true })

// ===========================================
// CONFIG ROUTES
// ===========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/referrals/config:
 *   get:
 *     tags: [Referrals]
 *     summary: Get referral program config for a venue
 *     security: [{ bearerAuth: [] }]
 */
router.get('/config', checkPermission('referral:read'), referralsController.getConfig)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/referrals/activate:
 *   post:
 *     tags: [Referrals]
 *     summary: Activate referral program for a venue
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/activate',
  checkPermission('referral:configure'),
  validateRequest(ActivateReferralProgramSchema),
  referralsController.activate,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/referrals/config:
 *   patch:
 *     tags: [Referrals]
 *     summary: Update referral program config (partial)
 *     security: [{ bearerAuth: [] }]
 */
router.patch(
  '/config',
  checkPermission('referral:configure'),
  validateRequest(UpdateReferralConfigSchema),
  referralsController.updateConfig,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/referrals/deactivate:
 *   post:
 *     tags: [Referrals]
 *     summary: Deactivate referral program for a venue
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/deactivate',
  checkPermission('referral:configure'),
  validateRequest(DeactivateReferralProgramSchema),
  referralsController.deactivate,
)

// ===========================================
// CAPTURE ROUTES
// ===========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/referrals/validate:
 *   post:
 *     tags: [Referrals]
 *     summary: Validate a referral code (no side effects)
 *     security: [{ bearerAuth: [] }]
 */
router.post('/validate', checkPermission('referral:read'), validateRequest(ValidateReferralCodeSchema), referralsController.validate)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/referrals/capture:
 *   post:
 *     tags: [Referrals]
 *     summary: Capture a referral (create PENDING Referral)
 *     security: [{ bearerAuth: [] }]
 */
router.post('/capture', checkPermission('referral:read'), validateRequest(CaptureReferralSchema), referralsController.captureCode)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/referrals/force-override:
 *   post:
 *     tags: [Referrals]
 *     summary: Manager override to capture referral for an EXISTING customer
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/force-override',
  checkPermission('referral:override-existing-customer'),
  validateRequest(ForceOverrideReferralSchema),
  referralsController.forceOverride,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/referrals/{referralId}/manual-void:
 *   post:
 *     tags: [Referrals]
 *     summary: Manually void a referral
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/:referralId/manual-void',
  checkPermission('referral:void-manual'),
  validateRequest(ManualVoidReferralSchema),
  referralsController.manualVoid,
)

// ===========================================
// READ ROUTES
// ===========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/referrals:
 *   get:
 *     tags: [Referrals]
 *     summary: List referrals (paginated, filterable)
 *     security: [{ bearerAuth: [] }]
 */
router.get('/', checkPermission('referral:read'), validateRequest(ListReferralsQuerySchema), referralsController.listReferralsHandler)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/referrals/summary:
 *   get:
 *     tags: [Referrals]
 *     summary: Get referral program summary (this-month KPIs)
 *     security: [{ bearerAuth: [] }]
 */
router.get('/summary', checkPermission('referral:read'), referralsController.getSummary)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/referrals/hall-of-fame:
 *   get:
 *     tags: [Referrals]
 *     summary: Get top referrers (hall of fame)
 *     security: [{ bearerAuth: [] }]
 */
router.get('/hall-of-fame', checkPermission('referral:read'), referralsController.getHallOfFameHandler)

// ===========================================
// WHATSAPP SHARE LINK (Phase 4)
// ===========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/referrals/customers/{customerId}/share-link:
 *   get:
 *     tags: [Referrals]
 *     summary: Get a wa.me deep link a customer can tap to share their referral code via WhatsApp
 *     security: [{ bearerAuth: [] }]
 */
router.get('/customers/:customerId/share-link', checkPermission('referral:read'), referralsController.getShareLink)

export default router
