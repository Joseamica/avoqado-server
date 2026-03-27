import { Request, Response, NextFunction } from 'express'
import * as aggregatorService from '../../services/superadmin/aggregator.service'
import logger from '../../config/logger'

/**
 * GET /api/v1/superadmin/aggregators
 */
export async function getAggregators(req: Request, res: Response, next: NextFunction) {
  try {
    const { active } = req.query
    const filters: { active?: boolean } = {}
    if (active !== undefined) filters.active = active === 'true'

    const aggregators = await aggregatorService.getAggregators(filters)

    res.json({ success: true, data: aggregators, meta: { count: aggregators.length } })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/aggregators/:id
 */
export async function getAggregatorById(req: Request, res: Response, next: NextFunction) {
  try {
    const aggregator = await aggregatorService.getAggregatorById(req.params.id)
    if (!aggregator) {
      return res.status(404).json({ success: false, error: 'Aggregator no encontrado' })
    }
    res.json({ success: true, data: aggregator })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/superadmin/aggregators
 */
export async function createAggregator(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, venueId, baseFees, ivaRate, active } = req.body
    if (!name || !baseFees) {
      return res.status(400).json({ success: false, error: 'Campos requeridos: name, baseFees' })
    }

    const aggregator = await aggregatorService.createAggregator({ name, venueId, baseFees, ivaRate, active })
    logger.info('Aggregator created', { aggregatorId: aggregator.id, name: aggregator.name })

    res.status(201).json({ success: true, data: aggregator })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/superadmin/aggregators/:id
 */
export async function updateAggregator(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, venueId, baseFees, ivaRate, active } = req.body
    const aggregator = await aggregatorService.updateAggregator(req.params.id, { name, venueId, baseFees, ivaRate, active })
    logger.info('Aggregator updated', { aggregatorId: aggregator.id })

    res.json({ success: true, data: aggregator })
  } catch (error) {
    next(error)
  }
}

/**
 * PATCH /api/v1/superadmin/aggregators/:id/toggle
 */
export async function toggleAggregator(req: Request, res: Response, next: NextFunction) {
  try {
    const aggregator = await aggregatorService.toggleAggregator(req.params.id)
    logger.info('Aggregator toggled', { aggregatorId: aggregator.id, active: aggregator.active })

    res.json({ success: true, data: aggregator })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/superadmin/aggregators/:id/generate-token
 */
export async function generateReportToken(req: Request, res: Response, next: NextFunction) {
  try {
    const token = await require('../../services/settlement-report.service').generateReportToken(req.params.id)
    logger.info('Report token generated', { aggregatorId: req.params.id })
    res.json({ success: true, data: { token } })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/superadmin/aggregators/:id/revoke-token
 */
export async function revokeReportToken(req: Request, res: Response, next: NextFunction) {
  try {
    await require('../../services/settlement-report.service').revokeReportToken(req.params.id)
    logger.info('Report token revoked', { aggregatorId: req.params.id })
    res.json({ success: true, message: 'Token revocado' })
  } catch (error) {
    next(error)
  }
}
