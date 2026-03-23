/**
 * Mobile Cash Drawer Controller
 *
 * Handles cash drawer session management for POS mobile apps.
 */

import { NextFunction, Request, Response } from 'express'
import * as cashDrawerService from '../../services/mobile/cash-drawer.mobile.service'

/**
 * Get current open cash drawer session
 * @route GET /api/v1/mobile/venues/:venueId/cash-drawer/current
 */
export const getCurrent = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const session = await cashDrawerService.getCurrentSession(venueId)

    return res.json({
      success: true,
      data: session,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Open a new cash drawer session
 * @route POST /api/v1/mobile/venues/:venueId/cash-drawer/open
 */
export const openSession = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId || ''
    const { startingAmount, deviceName, staffName } = req.body

    if (startingAmount === undefined || startingAmount === null) {
      return res.status(400).json({ success: false, message: 'startingAmount es requerido' })
    }

    const session = await cashDrawerService.openSession({
      venueId,
      staffId,
      staffName: staffName || 'Staff',
      startingAmount: Number(startingAmount),
      deviceName,
    })

    return res.status(201).json({ success: true, data: session })
  } catch (error) {
    next(error)
  }
}

/**
 * Add pay-in event
 * @route POST /api/v1/mobile/venues/:venueId/cash-drawer/pay-in
 */
export const payIn = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId || ''
    const { amount, note, staffName } = req.body

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'amount es requerido y debe ser mayor a 0' })
    }

    const event = await cashDrawerService.payIn({
      venueId,
      staffId,
      staffName: staffName || 'Staff',
      amount: Number(amount),
      note,
    })

    return res.status(201).json({ success: true, data: event })
  } catch (error) {
    next(error)
  }
}

/**
 * Add pay-out event
 * @route POST /api/v1/mobile/venues/:venueId/cash-drawer/pay-out
 */
export const payOut = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId || ''
    const { amount, note, staffName } = req.body

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'amount es requerido y debe ser mayor a 0' })
    }

    const event = await cashDrawerService.payOut({
      venueId,
      staffId,
      staffName: staffName || 'Staff',
      amount: Number(amount),
      note,
    })

    return res.status(201).json({ success: true, data: event })
  } catch (error) {
    next(error)
  }
}

/**
 * Close cash drawer session
 * @route POST /api/v1/mobile/venues/:venueId/cash-drawer/close
 */
export const closeSession = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId || ''
    const { actualAmount, note, staffName } = req.body

    if (actualAmount === undefined || actualAmount === null) {
      return res.status(400).json({ success: false, message: 'actualAmount es requerido' })
    }

    const session = await cashDrawerService.closeSession({
      venueId,
      staffId,
      staffName: staffName || 'Staff',
      actualAmount: Number(actualAmount),
      note,
    })

    return res.json({ success: true, data: session })
  } catch (error) {
    next(error)
  }
}

/**
 * Get cash drawer history (closed sessions)
 * @route GET /api/v1/mobile/venues/:venueId/cash-drawer/history
 */
export const getHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const page = parseInt(req.query.page as string) || 1
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 50)

    const result = await cashDrawerService.getHistory(venueId, page, pageSize)

    return res.json({ success: true, ...result })
  } catch (error) {
    next(error)
  }
}

/**
 * Bulk sync events from mobile (offline-first)
 * @route POST /api/v1/mobile/venues/:venueId/cash-drawer/sync
 */
export const syncEvents = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { events } = req.body

    if (!events || !Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ success: false, message: 'events array es requerido' })
    }

    const result = await cashDrawerService.syncEvents(venueId, events)

    return res.json({ success: true, ...result })
  } catch (error) {
    next(error)
  }
}
