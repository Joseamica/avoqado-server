import { NextFunction, Request, Response } from 'express'
import * as cashCloseoutService from '../../services/dashboard/cashCloseout.dashboard.service'
import logger from '../../config/logger'
import { DepositMethod } from '@prisma/client'

/**
 * Cash Closeout Controller
 *
 * Handlers for cash closeout (cortes de caja) endpoints
 */

/**
 * GET /dashboard/venues/:venueId/cash-closeouts/expected
 * Get expected cash amount since last closeout
 */
export async function getExpectedCash(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const result = await cashCloseoutService.getExpectedCashAmount(venueId)

    res.status(200).json({
      success: true,
      data: result,
    })
  } catch (error) {
    logger.error('Error fetching expected cash amount', { error })
    next(error)
  }
}

/**
 * POST /dashboard/venues/:venueId/cash-closeouts
 * Create a new cash closeout
 */
export async function createCloseout(
  req: Request<
    { venueId: string },
    {},
    {
      actualAmount: number
      depositMethod: DepositMethod
      bankReference?: string
      notes?: string
    }
  >,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId

    if (!staffId) {
      res.status(401).json({ success: false, message: 'User not authenticated' })
      return
    }

    const closeout = await cashCloseoutService.createCashCloseout(venueId, req.body, staffId)

    res.status(201).json({
      success: true,
      data: closeout,
      message: 'Cash closeout recorded successfully',
    })
  } catch (error) {
    logger.error('Error creating cash closeout', { error })
    next(error)
  }
}

/**
 * GET /dashboard/venues/:venueId/cash-closeouts
 * Get closeout history with pagination
 */
export async function getHistory(
  req: Request<{ venueId: string }, {}, {}, { page?: string; pageSize?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const page = parseInt(req.query.page || '1', 10)
    const pageSize = parseInt(req.query.pageSize || '10', 10)

    const result = await cashCloseoutService.getCloseoutHistory(venueId, page, pageSize)

    res.status(200).json({
      success: true,
      ...result,
    })
  } catch (error) {
    logger.error('Error fetching closeout history', { error })
    next(error)
  }
}

/**
 * GET /dashboard/venues/:venueId/cash-closeouts/:closeoutId
 * Get a single closeout by ID
 */
export async function getCloseoutById(
  req: Request<{ venueId: string; closeoutId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, closeoutId } = req.params
    const closeout = await cashCloseoutService.getCloseoutById(venueId, closeoutId)

    if (!closeout) {
      res.status(404).json({ success: false, message: 'Closeout not found' })
      return
    }

    res.status(200).json({
      success: true,
      data: closeout,
    })
  } catch (error) {
    logger.error('Error fetching closeout', { error })
    next(error)
  }
}
