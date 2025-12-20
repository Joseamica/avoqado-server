/**
 * Credit Assessment Controller (Superadmin)
 *
 * Handles HTTP requests for SOFOM credit assessment and offer management.
 * Part of the dual-view system separating superadmin credit evaluation
 * from client-facing available balance.
 */

import { Request, Response } from 'express'
import * as creditAssessmentService from '@/services/superadmin/creditAssessment.service'
import logger from '@/config/logger'
import { CreditEligibility, CreditGrade } from '@prisma/client'

/**
 * GET /api/superadmin/credit/assessments
 * List all credit assessments with filtering and pagination
 */
export async function listAssessments(req: Request, res: Response) {
  try {
    const { page = '1', pageSize = '20', eligibility, grade, minScore, maxScore, sortBy = 'creditScore', sortOrder = 'desc' } = req.query

    // Parse filters
    const eligibilityFilter = eligibility ? ((eligibility as string).split(',') as CreditEligibility[]) : undefined

    const gradeFilter = grade ? ((grade as string).split(',') as CreditGrade[]) : undefined

    const result = await creditAssessmentService.getAllAssessments({
      page: parseInt(page as string),
      pageSize: parseInt(pageSize as string),
      eligibility: eligibilityFilter,
      grade: gradeFilter,
      minScore: minScore ? parseInt(minScore as string) : undefined,
      maxScore: maxScore ? parseInt(maxScore as string) : undefined,
      sortBy: sortBy as 'creditScore' | 'annualVolume' | 'calculatedAt',
      sortOrder: sortOrder as 'asc' | 'desc',
    })

    res.status(200).json({
      success: true,
      ...result,
    })
  } catch (error: any) {
    logger.error('Error listing credit assessments:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to list credit assessments',
    })
  }
}

/**
 * GET /api/superadmin/credit/summary
 * Get summary statistics for dashboard header
 */
export async function getAssessmentSummary(req: Request, res: Response) {
  try {
    const summary = await creditAssessmentService.getAssessmentSummary()

    res.status(200).json({
      success: true,
      data: summary,
    })
  } catch (error: any) {
    logger.error('Error getting assessment summary:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to get assessment summary',
    })
  }
}

/**
 * GET /api/superadmin/credit/venues/:venueId
 * Calculate and get credit assessment for a specific venue
 */
export async function getVenueAssessment(req: Request, res: Response) {
  try {
    const { venueId } = req.params

    const assessment = await creditAssessmentService.calculateVenueAssessment(venueId)

    res.status(200).json({
      success: true,
      data: assessment,
    })
  } catch (error: any) {
    logger.error(`Error getting credit assessment for venue ${req.params.venueId}:`, error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to get credit assessment',
    })
  }
}

/**
 * POST /api/superadmin/credit/venues/:venueId/refresh
 * Force refresh credit assessment for a specific venue
 */
export async function refreshVenueAssessment(req: Request, res: Response) {
  try {
    const { venueId } = req.params

    const assessment = await creditAssessmentService.calculateVenueAssessment(venueId)

    res.status(200).json({
      success: true,
      message: 'Credit assessment refreshed successfully',
      data: assessment,
    })
  } catch (error: any) {
    logger.error(`Error refreshing credit assessment for venue ${req.params.venueId}:`, error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to refresh credit assessment',
    })
  }
}

/**
 * POST /api/superadmin/credit/refresh-all
 * Refresh credit assessments for all active venues (admin job)
 */
export async function refreshAllAssessments(req: Request, res: Response) {
  try {
    const result = await creditAssessmentService.refreshAllAssessments()

    res.status(200).json({
      success: true,
      message: 'Bulk credit assessment refresh completed',
      data: result,
    })
  } catch (error: any) {
    logger.error('Error refreshing all credit assessments:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to refresh all credit assessments',
    })
  }
}

/**
 * POST /api/superadmin/credit/venues/:venueId/offers
 * Create a credit offer for a venue
 */
export async function createOffer(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    const createdById = authContext.userId

    const { offerAmount, factorRate, repaymentPercent, expiresInDays, notes } = req.body

    const offer = await creditAssessmentService.createCreditOffer(
      venueId,
      {
        offerAmount,
        factorRate,
        repaymentPercent,
        expiresInDays,
        notes,
      },
      createdById,
    )

    res.status(201).json({
      success: true,
      message: 'Credit offer created successfully',
      data: offer,
    })
  } catch (error: any) {
    logger.error(`Error creating credit offer for venue ${req.params.venueId}:`, error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to create credit offer',
    })
  }
}

/**
 * GET /api/superadmin/credit/venues/:venueId/offers
 * Get credit offer history for a venue
 */
export async function getVenueOffers(req: Request, res: Response) {
  try {
    const { venueId } = req.params

    const offers = await creditAssessmentService.getVenueOfferHistory(venueId)

    res.status(200).json({
      success: true,
      data: offers,
      count: offers.length,
    })
  } catch (error: any) {
    logger.error(`Error getting credit offers for venue ${req.params.venueId}:`, error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to get credit offers',
    })
  }
}

/**
 * PATCH /api/superadmin/credit/offers/:offerId/accept
 * Accept a credit offer (typically called by venue owner via separate flow)
 */
export async function acceptOffer(req: Request, res: Response) {
  try {
    const { offerId } = req.params
    const authContext = (req as any).authContext
    const staffId = authContext.userId

    const offer = await creditAssessmentService.updateOfferStatus(offerId, 'accept', { staffId })

    res.status(200).json({
      success: true,
      message: 'Credit offer accepted',
      data: offer,
    })
  } catch (error: any) {
    logger.error(`Error accepting credit offer ${req.params.offerId}:`, error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to accept credit offer',
    })
  }
}

/**
 * PATCH /api/superadmin/credit/offers/:offerId/reject
 * Reject a credit offer
 */
export async function rejectOffer(req: Request, res: Response) {
  try {
    const { offerId } = req.params
    const { rejectionReason } = req.body

    const offer = await creditAssessmentService.updateOfferStatus(offerId, 'reject', { rejectionReason })

    res.status(200).json({
      success: true,
      message: 'Credit offer rejected',
      data: offer,
    })
  } catch (error: any) {
    logger.error(`Error rejecting credit offer ${req.params.offerId}:`, error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to reject credit offer',
    })
  }
}

/**
 * PATCH /api/superadmin/credit/offers/:offerId/withdraw
 * Withdraw a credit offer (superadmin action)
 */
export async function withdrawOffer(req: Request, res: Response) {
  try {
    const { offerId } = req.params

    const offer = await creditAssessmentService.updateOfferStatus(offerId, 'withdraw')

    res.status(200).json({
      success: true,
      message: 'Credit offer withdrawn',
      data: offer,
    })
  } catch (error: any) {
    logger.error(`Error withdrawing credit offer ${req.params.offerId}:`, error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to withdraw credit offer',
    })
  }
}
