import { Router, Request, Response, NextFunction } from 'express'
import { requirePartnerKey } from '@/middlewares/partner-auth.middleware'
import { partnerService } from '@/services/partner/partner.service'
import { BadRequestError } from '@/errors/AppError'

const router = Router()

/**
 * GET /api/v1/partner/sales
 *
 * Query params:
 *   from (required) - ISO date string, start of range
 *   to   (required) - ISO date string, end of range
 *   venue_id        - Filter by specific venue
 *   status          - exitosa | cancelada | fallida
 *   page            - Page number (default: 1)
 *   limit           - Items per page (default: 50, max: 100)
 */
router.get('/sales', requirePartnerKey, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to, venue_id, status, page: pageStr, limit: limitStr } = req.query

    // Validate required params
    if (!from || !to) {
      throw new BadRequestError('Query params "from" and "to" are required (ISO date format)')
    }

    const fromDate = new Date(from as string)
    const toDate = new Date(to as string)

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new BadRequestError('Invalid date format. Use ISO 8601 (e.g., 2026-03-01)')
    }

    if (fromDate > toDate) {
      throw new BadRequestError('"from" must be before "to"')
    }

    // Max range: 90 days
    const diffDays = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24)
    if (diffDays > 90) {
      throw new BadRequestError('Date range cannot exceed 90 days')
    }

    // Validate status if provided
    const validStatuses = ['exitosa', 'cancelada', 'fallida']
    if (status && !validStatuses.includes(status as string)) {
      throw new BadRequestError(`Invalid status. Valid values: ${validStatuses.join(', ')}`)
    }

    const page = Math.max(1, parseInt(pageStr as string) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(limitStr as string) || 50))

    const result = await partnerService.getSales({
      organizationId: req.partnerContext!.organizationId,
      from: fromDate,
      to: toDate,
      venueId: venue_id as string | undefined,
      status: status as string | undefined,
      page,
      limit,
    })

    res.json(result)
  } catch (error) {
    next(error)
  }
})

export default router
