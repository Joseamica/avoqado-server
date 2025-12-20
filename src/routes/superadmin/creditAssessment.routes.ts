/**
 * Credit Assessment Routes (Superadmin)
 *
 * Routes for SOFOM credit evaluation and offer management.
 * Part of the dual-view architecture separating internal credit assessment
 * from client-facing available balance.
 *
 * All routes require SUPERADMIN authentication (applied at parent router level)
 */

import { Router } from 'express'
import * as creditAssessmentController from '@/controllers/superadmin/creditAssessment.controller'
import { asyncHandler } from '@/utils/asyncHandler'
import { validateRequest } from '@/middlewares/validation'
import * as creditAssessmentSchema from '@/schemas/superadmin/creditAssessment.schema'

const router = Router()

// =============================================================================
// ASSESSMENT ROUTES
// =============================================================================

/**
 * @route   GET /api/superadmin/credit/assessments
 * @desc    List all credit assessments with filtering and pagination
 * @access  SUPERADMIN only
 */
router.get(
  '/assessments',
  validateRequest(creditAssessmentSchema.ListAssessmentsSchema),
  asyncHandler(creditAssessmentController.listAssessments),
)

/**
 * @route   GET /api/superadmin/credit/summary
 * @desc    Get summary statistics for dashboard header
 * @access  SUPERADMIN only
 */
router.get('/summary', asyncHandler(creditAssessmentController.getAssessmentSummary))

/**
 * @route   GET /api/superadmin/credit/venues/:venueId
 * @desc    Get credit assessment for a specific venue (calculates fresh if needed)
 * @access  SUPERADMIN only
 */
router.get(
  '/venues/:venueId',
  validateRequest(creditAssessmentSchema.VenueIdSchema),
  asyncHandler(creditAssessmentController.getVenueAssessment),
)

/**
 * @route   POST /api/superadmin/credit/venues/:venueId/refresh
 * @desc    Force refresh credit assessment for a specific venue
 * @access  SUPERADMIN only
 */
router.post(
  '/venues/:venueId/refresh',
  validateRequest(creditAssessmentSchema.VenueIdSchema),
  asyncHandler(creditAssessmentController.refreshVenueAssessment),
)

/**
 * @route   POST /api/superadmin/credit/refresh-all
 * @desc    Refresh assessments for all active venues (admin job)
 * @access  SUPERADMIN only
 */
router.post('/refresh-all', asyncHandler(creditAssessmentController.refreshAllAssessments))

// =============================================================================
// CREDIT OFFER ROUTES
// =============================================================================

/**
 * @route   POST /api/superadmin/credit/venues/:venueId/offers
 * @desc    Create a new credit offer for a venue
 * @access  SUPERADMIN only
 */
router.post(
  '/venues/:venueId/offers',
  validateRequest(creditAssessmentSchema.CreateOfferSchema),
  asyncHandler(creditAssessmentController.createOffer),
)

/**
 * @route   GET /api/superadmin/credit/venues/:venueId/offers
 * @desc    Get credit offer history for a venue
 * @access  SUPERADMIN only
 */
router.get(
  '/venues/:venueId/offers',
  validateRequest(creditAssessmentSchema.VenueIdSchema),
  asyncHandler(creditAssessmentController.getVenueOffers),
)

/**
 * @route   PATCH /api/superadmin/credit/offers/:offerId/accept
 * @desc    Accept a credit offer
 * @access  SUPERADMIN only
 */
router.patch(
  '/offers/:offerId/accept',
  validateRequest(creditAssessmentSchema.OfferIdSchema),
  asyncHandler(creditAssessmentController.acceptOffer),
)

/**
 * @route   PATCH /api/superadmin/credit/offers/:offerId/reject
 * @desc    Reject a credit offer
 * @access  SUPERADMIN only
 */
router.patch(
  '/offers/:offerId/reject',
  validateRequest(creditAssessmentSchema.RejectOfferSchema),
  asyncHandler(creditAssessmentController.rejectOffer),
)

/**
 * @route   PATCH /api/superadmin/credit/offers/:offerId/withdraw
 * @desc    Withdraw a credit offer (superadmin action)
 * @access  SUPERADMIN only
 */
router.patch(
  '/offers/:offerId/withdraw',
  validateRequest(creditAssessmentSchema.OfferIdSchema),
  asyncHandler(creditAssessmentController.withdrawOffer),
)

export default router
