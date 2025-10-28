/**
 * KYC Review Controller (Superadmin)
 *
 * Handles HTTP requests for KYC document review and approval workflow.
 * Thin controller that orchestrates service calls.
 */

import { Request, Response } from 'express'
import * as kycReviewService from '@/services/superadmin/kycReview.service'
import logger from '@/config/logger'

/**
 * GET /api/superadmin/kyc/pending
 * List all venues pending KYC review
 */
export async function listPendingKyc(req: Request, res: Response) {
  try {
    const venues = await kycReviewService.getPendingKycVenues()

    res.status(200).json({
      success: true,
      data: venues,
      count: venues.length,
    })
  } catch (error: any) {
    logger.error('Error listing pending KYC venues:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to list pending KYC venues',
    })
  }
}

/**
 * GET /api/superadmin/kyc/:venueId
 * Get KYC details for a specific venue
 */
export async function getKycDetails(req: Request, res: Response) {
  try {
    const { venueId } = req.params

    const kycDetails = await kycReviewService.getVenueKycDetails(venueId)

    res.status(200).json({
      success: true,
      data: kycDetails,
    })
  } catch (error: any) {
    logger.error(`Error getting KYC details for venue ${req.params.venueId}:`, error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to get KYC details',
    })
  }
}

/**
 * POST /api/superadmin/kyc/:venueId/approve
 * Simple KYC approval without processor assignment
 */
export async function approveKyc(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    const superadminId = authContext.userId

    const updatedVenue = await kycReviewService.approveKyc(venueId, superadminId)

    res.status(200).json({
      success: true,
      message: 'KYC approved successfully',
      data: updatedVenue,
    })
  } catch (error: any) {
    logger.error(`Error approving KYC for venue ${req.params.venueId}:`, error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to approve KYC',
    })
  }
}

/**
 * POST /api/superadmin/kyc/:venueId/assign-processor
 * Assign payment processor and approve KYC
 */
export async function assignProcessorAndApprove(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    const superadminId = authContext.userId

    const processorData = req.body

    const merchantAccount = await kycReviewService.assignProcessorAndApproveKyc(venueId, superadminId, processorData)

    res.status(200).json({
      success: true,
      message: 'KYC approved and processor assigned successfully',
      data: merchantAccount,
    })
  } catch (error: any) {
    logger.error(`Error assigning processor to venue ${req.params.venueId}:`, error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to assign processor',
    })
  }
}

/**
 * POST /api/superadmin/kyc/:venueId/reject
 * Reject KYC for a venue
 *
 * Body:
 * - rejectionReason: string (required) - Reason for rejection
 * - rejectedDocuments: string[] (optional) - Specific document keys rejected (e.g., ["ineUrl", "rfcDocumentUrl"])
 *   If not provided, all documents are considered rejected
 */
export async function rejectKyc(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { rejectionReason, rejectedDocuments } = req.body
    const authContext = (req as any).authContext
    const superadminId = authContext.userId

    const updatedVenue = await kycReviewService.rejectKyc(venueId, superadminId, rejectionReason, rejectedDocuments)

    res.status(200).json({
      success: true,
      message: 'KYC rejected successfully',
      data: updatedVenue,
    })
  } catch (error: any) {
    logger.error(`Error rejecting KYC for venue ${req.params.venueId}:`, error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to reject KYC',
    })
  }
}

/**
 * POST /api/superadmin/kyc/:venueId/mark-in-review
 * Mark KYC as IN_REVIEW
 */
export async function markInReview(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    const superadminId = authContext.userId

    const updatedVenue = await kycReviewService.markKycInReview(venueId, superadminId)

    res.status(200).json({
      success: true,
      message: 'KYC marked as in review',
      data: updatedVenue,
    })
  } catch (error: any) {
    logger.error(`Error marking KYC in review for venue ${req.params.venueId}:`, error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to mark KYC in review',
    })
  }
}
