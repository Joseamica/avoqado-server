import { Request, Response } from 'express'
import * as saleVerificationDashboardService from '../../services/dashboard/sale-verification.dashboard.service'
import logger from '../../config/logger'
import { SaleVerificationStatus, SaleVerificationRejectionReason } from '@prisma/client'

// ============================================================
// Sale Verification Dashboard Controller
// ============================================================
// Handles HTTP requests for Sale Verification data in dashboard

/**
 * GET /dashboard/venues/:venueId/sale-verifications
 * List sale verifications with staff and payment details
 */
export async function listSaleVerifications(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params
    const { pageSize = '20', pageNumber = '1', status, staffId, fromDate, toDate, search } = req.query

    logger.info(`[SALE VERIFICATION DASHBOARD CONTROLLER] GET /dashboard/venues/${venueId}/sale-verifications`)

    const result = await saleVerificationDashboardService.listSaleVerificationsWithDetails(venueId, {
      pageSize: parseInt(pageSize as string, 10),
      pageNumber: parseInt(pageNumber as string, 10),
      status: status as SaleVerificationStatus | undefined,
      staffId: staffId as string | undefined,
      fromDate: fromDate ? new Date(fromDate as string) : undefined,
      toDate: toDate ? new Date(toDate as string) : undefined,
      search: search as string | undefined,
    })

    res.status(200).json({
      success: true,
      data: result.data,
      pagination: result.pagination,
    })
  } catch (error: any) {
    logger.error(`[SALE VERIFICATION DASHBOARD CONTROLLER] Error listing verifications: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * GET /dashboard/venues/:venueId/sale-verifications/summary
 * Get summary statistics for sale verifications
 */
export async function getSaleVerificationsSummary(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params
    const { fromDate, toDate } = req.query

    logger.info(`[SALE VERIFICATION DASHBOARD CONTROLLER] GET /dashboard/venues/${venueId}/sale-verifications/summary`)

    const summary = await saleVerificationDashboardService.getSaleVerificationsSummary(
      venueId,
      fromDate ? new Date(fromDate as string) : undefined,
      toDate ? new Date(toDate as string) : undefined,
    )

    res.status(200).json({
      success: true,
      data: summary,
    })
  } catch (error: any) {
    logger.error(`[SALE VERIFICATION DASHBOARD CONTROLLER] Error getting summary: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * GET /dashboard/venues/:venueId/sale-verifications/daily
 * Get daily sales data for charts
 */
export async function getDailySalesData(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params
    const { fromDate, toDate } = req.query

    logger.info(`[SALE VERIFICATION DASHBOARD CONTROLLER] GET /dashboard/venues/${venueId}/sale-verifications/daily`)

    // Default to last 7 days if no dates provided
    const end = toDate ? new Date(toDate as string) : new Date()
    const start = fromDate ? new Date(fromDate as string) : new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000)

    const data = await saleVerificationDashboardService.getDailySalesData(venueId, start, end)

    res.status(200).json({
      success: true,
      data,
    })
  } catch (error: any) {
    logger.error(`[SALE VERIFICATION DASHBOARD CONTROLLER] Error getting daily data: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * GET /dashboard/venues/:venueId/sale-verifications/staff
 * Get staff list for filters
 */
export async function getStaffWithVerifications(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params

    logger.info(`[SALE VERIFICATION DASHBOARD CONTROLLER] GET /dashboard/venues/${venueId}/sale-verifications/staff`)

    const staff = await saleVerificationDashboardService.getStaffWithVerifications(venueId)

    res.status(200).json({
      success: true,
      data: staff,
    })
  } catch (error: any) {
    logger.error(`[SALE VERIFICATION DASHBOARD CONTROLLER] Error getting staff: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * PATCH /dashboard/venues/:venueId/sale-verifications/:id/review
 *
 * Back-office documentation review (PlayTelecom / Walmart).
 * Approves or rejects the photo documentation for a sale verification.
 *
 * Body:
 *   - decision: 'APPROVE' | 'REJECT' (required)
 *   - rejectionReasons?: SaleVerificationRejectionReason[] (required-ish for REJECT)
 *   - reviewNotes?: string (optional free-text feedback for promoter)
 */
export async function reviewSaleVerification(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, id } = req.params
    const { decision, rejectionReasons, reviewNotes } = req.body as {
      decision?: string
      rejectionReasons?: SaleVerificationRejectionReason[]
      reviewNotes?: string
    }

    const reviewedById = req.authContext?.userId
    if (!reviewedById) {
      res.status(401).json({ success: false, message: 'No reviewer staff context' })
      return
    }

    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      res.status(400).json({ success: false, message: "decision must be 'APPROVE' or 'REJECT'" })
      return
    }

    // Validate rejection reasons enum values (defensive — Prisma will also throw on bad enum)
    const validReasons: SaleVerificationRejectionReason[] = ['REVIEW_PORTABILIDAD', 'REVIEW_DUPLICATE_VINCULACION', 'OTHER']
    if (Array.isArray(rejectionReasons)) {
      const invalid = rejectionReasons.filter(r => !validReasons.includes(r))
      if (invalid.length > 0) {
        res.status(400).json({ success: false, message: `Invalid rejectionReasons: ${invalid.join(', ')}` })
        return
      }
    }

    logger.info(`[SALE VERIFICATION DASHBOARD CONTROLLER] PATCH ${id}/review by ${reviewedById} decision=${decision}`)

    const updated = await saleVerificationDashboardService.reviewSaleVerification(venueId, {
      saleVerificationId: id,
      reviewedById,
      decision,
      rejectionReasons,
      reviewNotes,
    })

    res.status(200).json({
      success: true,
      data: updated,
    })
  } catch (error: any) {
    logger.error(`[SALE VERIFICATION DASHBOARD CONTROLLER] Error reviewing verification: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}
