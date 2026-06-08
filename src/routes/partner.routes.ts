import { Router, Request, Response, NextFunction } from 'express'
import { requirePartnerKey } from '@/middlewares/partner-auth.middleware'
import { partnerService, resolvePartnerBoundary } from '@/services/partner/partner.service'
import { BadRequestError } from '@/errors/AppError'

const router = Router()

/**
 * GET /api/v1/partner/sales
 *
 * Query params:
 *   from (required) - ISO date, start of range. Date-only ("2026-03-01") is
 *                     read as Mexico-local 00:00. No lower bound — any history.
 *   to   (required) - ISO date, end of range. Date-only ("2026-03-31") is read
 *                     as Mexico-local 23:59:59.999 (full day, inclusive).
 *   venue_slug      - Filter by venue slug (e.g., "dona-simona")
 *   status          - exitosa | cancelada | fallida
 *   page            - Page number (default: 1)
 *   limit           - Items per page (default: 50, max: 100)
 */
router.get('/sales', requirePartnerKey, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to, venue_slug, status, page: pageStr, limit: limitStr } = req.query

    // Validate required params
    if (!from || !to) {
      throw new BadRequestError('Query params "from" and "to" are required (ISO date format)')
    }

    const fromDate = resolvePartnerBoundary(from as string, 'start')
    const toDate = resolvePartnerBoundary(to as string, 'end')

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new BadRequestError('Invalid date format. Use ISO 8601 (e.g., 2026-03-01)')
    }

    if (fromDate > toDate) {
      throw new BadRequestError('"from" must be before "to"')
    }

    // No artificial range cap: BAIT pulls full historical periods for its ETL.

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
      venueSlug: venue_slug as string | undefined,
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
