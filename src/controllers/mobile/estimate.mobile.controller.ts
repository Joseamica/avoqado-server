/**
 * Mobile Estimate Controller
 *
 * Handles estimate (presupuesto) management for POS mobile apps.
 */

import { NextFunction, Request, Response } from 'express'
import * as estimateService from '../../services/mobile/estimate.mobile.service'

/**
 * List estimates
 * @route GET /api/v1/mobile/venues/:venueId/estimates
 */
export const listEstimates = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const page = parseInt(req.query.page as string) || 1
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 50)

    const filters: estimateService.ListEstimateFilters = {}
    if (req.query.status) filters.status = req.query.status as string
    if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom as string
    if (req.query.dateTo) filters.dateTo = req.query.dateTo as string
    if (req.query.search) filters.search = req.query.search as string

    const result = await estimateService.listEstimates(venueId, page, pageSize, filters)

    return res.json({ success: true, ...result })
  } catch (error) {
    next(error)
  }
}

/**
 * Create estimate
 * @route POST /api/v1/mobile/venues/:venueId/estimates
 */
export const createEstimate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId || ''
    const { items, notes, validUntil, customerId, customerName, customerEmail, customerPhone, staffName } = req.body

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Se requiere al menos un producto (items)' })
    }

    if (!staffName) {
      return res.status(400).json({ success: false, message: 'staffName es requerido' })
    }

    const result = await estimateService.createEstimate({
      venueId,
      staffId,
      staffName,
      customerId,
      customerName,
      customerEmail,
      customerPhone,
      items,
      notes,
      validUntil,
    })

    return res.status(201).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * Get estimate detail
 * @route GET /api/v1/mobile/venues/:venueId/estimates/:estimateId
 */
export const getEstimate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, estimateId } = req.params

    const result = await estimateService.getEstimate(estimateId, venueId)

    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * Update estimate status
 * @route PUT /api/v1/mobile/venues/:venueId/estimates/:estimateId/status
 */
export const updateStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, estimateId } = req.params
    const staffId = req.authContext?.userId || ''
    const { status } = req.body

    if (!status) {
      return res.status(400).json({ success: false, message: 'status es requerido' })
    }

    const result = await estimateService.updateStatus(estimateId, venueId, status, staffId)

    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * Convert estimate to order
 * @route POST /api/v1/mobile/venues/:venueId/estimates/:estimateId/convert
 */
export const convertToOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, estimateId } = req.params
    const staffId = req.authContext?.userId || ''

    const result = await estimateService.convertToOrder(estimateId, venueId, staffId)

    return res.status(201).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}
