import { Request, Response, NextFunction } from 'express'
import { grantVenueAccessBatch, listVenueAccessCandidates } from '@/services/dashboard/venue-access.service'

/**
 * List the staff candidates for granting access to a venue.
 *
 * @route GET /api/v1/superadmin/venues/:venueId/staff-access/candidates?sourceVenueId=
 */
export const candidates = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { sourceVenueId } = req.query as { sourceVenueId?: string }
    const data = await listVenueAccessCandidates(venueId, sourceVenueId)
    return res.status(200).json({ data, message: 'Candidates listed' })
  } catch (error) {
    next(error)
  }
}

/**
 * Grant venue access to a batch of staff (atomic). `authContext` exposes only
 * { userId, orgId, venueId, role }.
 *
 * @route POST /api/v1/superadmin/venues/:venueId/staff-access
 */
export const grant = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { grants } = req.body
    const authContext = (req as any).authContext
    const data = await grantVenueAccessBatch(venueId, grants, {
      staffId: authContext?.userId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })
    return res.status(200).json({ data, message: 'Access granted' })
  } catch (error) {
    next(error)
  }
}
