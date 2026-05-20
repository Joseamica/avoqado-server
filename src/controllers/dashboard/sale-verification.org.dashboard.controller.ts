import { Request, Response } from 'express'
import { SaleVerificationStatus, SaleVerificationRejectionReason, PaymentMethod } from '@prisma/client'
import * as svc from '../../services/dashboard/sale-verification.org.dashboard.service'
import logger from '../../config/logger'

// ============================================================
// Org-Scoped Sale Verification Dashboard Controller
// ============================================================
// HTTP layer for the PlayTelecom "Ventas" view. All endpoints expect
// :orgId as a route param and rely on the route-level checkOrgAccess
// middleware to enforce tenant isolation.
// ============================================================

function parseBool(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'boolean') return raw
  if (typeof raw !== 'string') return undefined
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  return undefined
}

export async function listOrgSaleVerifications(req: Request, res: Response): Promise<void> {
  try {
    const { orgId } = req.params
    const {
      pageSize = '20',
      pageNumber = '1',
      status,
      staffId,
      venueId,
      categoryId,
      isPortabilidad,
      paymentMethod,
      fromDate,
      toDate,
      search,
    } = req.query

    logger.info(`[ORG SALE VERIFICATION] GET /dashboard/organizations/${orgId}/sale-verifications`)

    const range = svc.parseRange(fromDate as string | undefined, toDate as string | undefined)

    const result = await svc.listOrgSaleVerifications(orgId, {
      pageSize: Math.min(parseInt(pageSize as string, 10) || 20, 200),
      pageNumber: parseInt(pageNumber as string, 10) || 1,
      status: status as SaleVerificationStatus | undefined,
      staffId: staffId as string | undefined,
      venueId: venueId as string | undefined,
      categoryId: categoryId as string | undefined,
      isPortabilidad: parseBool(isPortabilidad),
      paymentMethod: paymentMethod as PaymentMethod | undefined,
      fromDate: range.fromDate,
      toDate: range.toDate,
      search: search as string | undefined,
    })

    res.status(200).json({ success: true, data: result.data, pagination: result.pagination })
  } catch (error: any) {
    logger.error(`[ORG SALE VERIFICATION] list error: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Internal server error' })
  }
}

export async function getOrgSalesSummary(req: Request, res: Response): Promise<void> {
  try {
    const { orgId } = req.params
    const { fromDate, toDate } = req.query
    const range = svc.parseRange(fromDate as string | undefined, toDate as string | undefined)
    const data = await svc.getOrgSalesSummary(orgId, range)
    res.status(200).json({ success: true, data })
  } catch (error: any) {
    logger.error(`[ORG SALE VERIFICATION] summary error: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Internal server error' })
  }
}

export async function getSalesByMonth(req: Request, res: Response): Promise<void> {
  try {
    const { orgId } = req.params
    const { fromDate, toDate } = req.query
    const range = svc.parseRange(fromDate as string | undefined, toDate as string | undefined)
    const data = await svc.getSalesByMonth(orgId, range)
    res.status(200).json({ success: true, data })
  } catch (error: any) {
    logger.error(`[ORG SALE VERIFICATION] by-month error: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Internal server error' })
  }
}

export async function getSalesBySimType(req: Request, res: Response): Promise<void> {
  try {
    const { orgId } = req.params
    const { fromDate, toDate } = req.query
    const range = svc.parseRange(fromDate as string | undefined, toDate as string | undefined)
    const data = await svc.getSalesBySimType(orgId, range)
    res.status(200).json({ success: true, data })
  } catch (error: any) {
    logger.error(`[ORG SALE VERIFICATION] by-sim-type error: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Internal server error' })
  }
}

export async function getSalesByWeek(req: Request, res: Response): Promise<void> {
  try {
    const { orgId } = req.params
    const { fromDate, toDate } = req.query
    const range = svc.parseRange(fromDate as string | undefined, toDate as string | undefined)
    const data = await svc.getSalesByWeek(orgId, range)
    res.status(200).json({ success: true, data })
  } catch (error: any) {
    logger.error(`[ORG SALE VERIFICATION] by-week error: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Internal server error' })
  }
}

export async function getSalesByCity(req: Request, res: Response): Promise<void> {
  try {
    const { orgId } = req.params
    const { fromDate, toDate } = req.query
    const range = svc.parseRange(fromDate as string | undefined, toDate as string | undefined)
    const data = await svc.getSalesByCity(orgId, range)
    res.status(200).json({ success: true, data })
  } catch (error: any) {
    logger.error(`[ORG SALE VERIFICATION] by-city error: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Internal server error' })
  }
}

export async function getSalesBySupervisor(req: Request, res: Response): Promise<void> {
  try {
    const { orgId } = req.params
    const { fromDate, toDate } = req.query
    const range = svc.parseRange(fromDate as string | undefined, toDate as string | undefined)
    const data = await svc.getSalesBySupervisor(orgId, range)
    res.status(200).json({ success: true, data })
  } catch (error: any) {
    logger.error(`[ORG SALE VERIFICATION] by-supervisor error: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Internal server error' })
  }
}

export async function getSalesByStore(req: Request, res: Response): Promise<void> {
  try {
    const { orgId } = req.params
    const { fromDate, toDate } = req.query
    const range = svc.parseRange(fromDate as string | undefined, toDate as string | undefined)
    const data = await svc.getSalesByStore(orgId, range)
    res.status(200).json({ success: true, data })
  } catch (error: any) {
    logger.error(`[ORG SALE VERIFICATION] by-store error: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Internal server error' })
  }
}

/**
 * PATCH /dashboard/organizations/:orgId/sale-verifications/:id/review
 *
 * Org-scoped wrapper around the venue-scoped review endpoint.
 * Verifies the verification belongs to a venue inside :orgId then delegates.
 */
export async function reviewOrgSaleVerification(req: Request, res: Response): Promise<void> {
  try {
    const { orgId, id } = req.params
    const { decision, rejectionReasons, reviewNotes } = req.body as {
      decision?: string
      rejectionReasons?: SaleVerificationRejectionReason[]
      reviewNotes?: string
    }

    const reviewedById = (req as any).authContext?.userId
    if (!reviewedById) {
      res.status(401).json({ success: false, message: 'No reviewer staff context' })
      return
    }

    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      res.status(400).json({ success: false, message: "decision must be 'APPROVE' or 'REJECT'" })
      return
    }

    const validReasons: SaleVerificationRejectionReason[] = [
      'REVIEW_PORTABILIDAD',
      'REVIEW_DUPLICATE_VINCULACION',
      'REVIEW_ILLEGIBLE_IMAGES',
      'REVIEW_MISSING_LINKING_IMAGE',
      'OTHER',
    ]
    if (Array.isArray(rejectionReasons)) {
      const invalid = rejectionReasons.filter(r => !validReasons.includes(r))
      if (invalid.length > 0) {
        res.status(400).json({ success: false, message: `Invalid rejectionReasons: ${invalid.join(', ')}` })
        return
      }
    }

    logger.info(`[ORG SALE VERIFICATION] PATCH ${id}/review org=${orgId} by=${reviewedById} decision=${decision}`)

    const updated = await svc.reviewOrgSaleVerification(orgId, {
      saleVerificationId: id,
      reviewedById,
      decision,
      rejectionReasons,
      reviewNotes,
    })

    res.status(200).json({ success: true, data: updated })
  } catch (error: any) {
    logger.error(`[ORG SALE VERIFICATION] review error: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Internal server error' })
  }
}
