/**
 * Mobile Supplier Controller
 *
 * Read-only listing of suppliers for mobile apps.
 * Response: { success: true, data: [...] }
 */

import { NextFunction, Request, Response } from 'express'
import prisma from '../../utils/prismaClient'

/**
 * GET /mobile/venues/:venueId/suppliers?active=true
 * List suppliers for a venue, optionally filtered by active status.
 */
export const listSuppliers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const activeOnly = req.query.active === 'true'

    const where: any = { venueId, deletedAt: null }
    if (activeOnly) {
      where.active = true
    }

    const suppliers = await prisma.supplier.findMany({
      where,
      orderBy: { name: 'asc' },
    })

    return res.json({ success: true, data: suppliers })
  } catch (error) {
    next(error)
  }
}
