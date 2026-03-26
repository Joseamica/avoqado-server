import { Request, Response, NextFunction } from 'express'
import * as venueCommissionService from '../../services/superadmin/venueCommission.service'
import logger from '../../config/logger'

const VALID_REFERRED_BY = ['EXTERNAL', 'AGGREGATOR']

/**
 * GET /api/v1/superadmin/venue-commissions
 * Query: ?aggregatorId=xxx&active=true
 */
export async function getVenueCommissions(req: Request, res: Response, next: NextFunction) {
  try {
    const { aggregatorId, active } = req.query
    const filters: { aggregatorId?: string; active?: boolean } = {}
    if (aggregatorId) filters.aggregatorId = aggregatorId as string
    if (active !== undefined) filters.active = active === 'true'

    const commissions = await venueCommissionService.getVenueCommissions(filters)

    res.json({ success: true, data: commissions, meta: { count: commissions.length } })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/venue-commissions/:id
 */
export async function getVenueCommissionById(req: Request, res: Response, next: NextFunction) {
  try {
    const commission = await venueCommissionService.getVenueCommissionById(req.params.id)
    if (!commission) {
      return res.status(404).json({ success: false, error: 'Comision de venue no encontrada' })
    }
    res.json({ success: true, data: commission })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/superadmin/venue-commissions
 */
export async function createVenueCommission(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, aggregatorId, rate, referredBy, active } = req.body

    if (!venueId || !aggregatorId || rate === undefined || !referredBy) {
      return res.status(400).json({
        success: false,
        error: 'Campos requeridos: venueId, aggregatorId, rate, referredBy',
      })
    }

    if (!VALID_REFERRED_BY.includes(referredBy)) {
      return res.status(400).json({
        success: false,
        error: 'referredBy debe ser "EXTERNAL" o "AGGREGATOR"',
      })
    }

    const commission = await venueCommissionService.createVenueCommission({
      venueId,
      aggregatorId,
      rate,
      referredBy,
      active,
    })

    logger.info('VenueCommission created', {
      commissionId: commission.id,
      venueId,
      aggregatorId,
      rate,
      referredBy,
    })

    res.status(201).json({ success: true, data: commission })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({
        success: false,
        error: 'Este venue ya tiene una comision configurada',
      })
    }
    next(error)
  }
}

/**
 * PUT /api/v1/superadmin/venue-commissions/:id
 */
export async function updateVenueCommission(req: Request, res: Response, next: NextFunction) {
  try {
    const { rate, referredBy, active } = req.body

    if (referredBy && !VALID_REFERRED_BY.includes(referredBy)) {
      return res.status(400).json({
        success: false,
        error: 'referredBy debe ser "EXTERNAL" o "AGGREGATOR"',
      })
    }

    const commission = await venueCommissionService.updateVenueCommission(req.params.id, {
      rate,
      referredBy,
      active,
    })

    logger.info('VenueCommission updated', { commissionId: commission.id })

    res.json({ success: true, data: commission })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/superadmin/venue-commissions/:id
 */
export async function deleteVenueCommission(req: Request, res: Response, next: NextFunction) {
  try {
    await venueCommissionService.deleteVenueCommission(req.params.id)
    logger.info('VenueCommission deleted', { commissionId: req.params.id })

    res.json({ success: true, message: 'Comision eliminada' })
  } catch (error) {
    next(error)
  }
}
