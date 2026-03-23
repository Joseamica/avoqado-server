/**
 * Mobile Inventory Transfer Controller
 *
 * Handles inventory transfer management for POS mobile apps.
 */

import { NextFunction, Request, Response } from 'express'
import * as transferService from '../../services/mobile/transfer.mobile.service'

/**
 * List transfers
 * @route GET /api/v1/mobile/venues/:venueId/transfers
 */
export const listTransfers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const page = parseInt(req.query.page as string) || 1
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 50)

    const result = await transferService.listTransfers(venueId, page, pageSize)

    return res.json({ success: true, ...result })
  } catch (error) {
    next(error)
  }
}

/**
 * Get transfer detail
 * @route GET /api/v1/mobile/venues/:venueId/transfers/:id
 */
export const getTransfer = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, id } = req.params

    const result = await transferService.getTransfer(id, venueId)

    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * Create transfer
 * @route POST /api/v1/mobile/venues/:venueId/transfers
 */
export const createTransfer = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId || ''
    const { fromLocationName, toLocationName, items, notes, staffName } = req.body

    if (!fromLocationName || !toLocationName) {
      return res.status(400).json({ success: false, message: 'fromLocationName y toLocationName son requeridos' })
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Se requiere al menos un producto (items)' })
    }

    const result = await transferService.createTransfer({
      venueId,
      staffId,
      staffName: staffName || 'Staff',
      fromLocationName,
      toLocationName,
      items,
      notes,
    })

    return res.status(201).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * Update transfer status
 * @route PUT /api/v1/mobile/venues/:venueId/transfers/:id/status
 */
export const updateStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, id } = req.params
    const staffId = req.authContext?.userId || ''
    const { status } = req.body

    if (!status) {
      return res.status(400).json({ success: false, message: 'status es requerido' })
    }

    const result = await transferService.updateStatus(id, venueId, status, staffId)

    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}
