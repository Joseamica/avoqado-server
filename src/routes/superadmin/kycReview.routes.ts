/**
 * KYC Review Routes (Superadmin)
 *
 * Routes for Superadmin KYC document review and approval workflow
 */

import { Router } from 'express'
import * as kycReviewController from '@/controllers/superadmin/kycReview.controller'
import { asyncHandler } from '@/utils/asyncHandler'
import { validateRequest } from '@/middlewares/validation'
import * as kycReviewSchema from '@/schemas/superadmin/kycReview.schema'

const router = Router()

/**
 * @route   GET /api/superadmin/kyc/pending
 * @desc    List all venues pending KYC review
 * @access  SUPERADMIN only
 */
router.get('/pending', asyncHandler(kycReviewController.listPendingKyc))

/**
 * @route   GET /api/superadmin/kyc/:venueId
 * @desc    Get KYC details for a specific venue
 * @access  SUPERADMIN only
 */
router.get('/:venueId', validateRequest(kycReviewSchema.GetKycDetailsSchema), asyncHandler(kycReviewController.getKycDetails))

/**
 * @route   POST /api/superadmin/kyc/:venueId/approve
 * @desc    Approve KYC for a venue (simple approval without processor assignment)
 * @access  SUPERADMIN only
 */
router.post('/:venueId/approve', asyncHandler(kycReviewController.approveKyc))

/**
 * @route   POST /api/superadmin/kyc/:venueId/assign-processor
 * @desc    Assign payment processor and approve KYC
 * @access  SUPERADMIN only
 */
router.post(
  '/:venueId/assign-processor',
  validateRequest(kycReviewSchema.AssignProcessorSchema),
  asyncHandler(kycReviewController.assignProcessorAndApprove),
)

/**
 * @route   POST /api/superadmin/kyc/:venueId/reject
 * @desc    Reject KYC for a venue
 * @access  SUPERADMIN only
 */
router.post('/:venueId/reject', validateRequest(kycReviewSchema.RejectKycSchema), asyncHandler(kycReviewController.rejectKyc))

/**
 * @route   POST /api/superadmin/kyc/:venueId/mark-in-review
 * @desc    Mark KYC as IN_REVIEW
 * @access  SUPERADMIN only
 */
router.post(
  '/:venueId/mark-in-review',
  validateRequest(kycReviewSchema.MarkKycInReviewSchema),
  asyncHandler(kycReviewController.markInReview),
)

export default router
