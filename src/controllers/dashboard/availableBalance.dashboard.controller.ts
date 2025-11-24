import { NextFunction, Request, Response } from 'express'
import * as availableBalanceService from '../../services/dashboard/availableBalance.dashboard.service'
import logger from '../../config/logger'
import { AuthenticationError } from '../../errors/AppError'

/**
 * Available Balance Dashboard Controller
 *
 * Handlers for available balance API endpoints
 */

/**
 * GET /dashboard/venues/:venueId/available-balance
 * Get available balance summary for a venue
 */
export async function getAvailableBalance(
  req: Request<{ venueId: string }, {}, {}, { from?: string; to?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { from, to } = req.query

    // Parse optional date range
    let dateRange: { from: Date; to: Date } | undefined
    if (from && to) {
      dateRange = {
        from: new Date(from),
        to: new Date(to),
      }
    }

    const balance = await availableBalanceService.getAvailableBalance(venueId, dateRange)

    res.status(200).json({ success: true, data: balance })
  } catch (error) {
    logger.error('Error fetching available balance', { error })
    next(error)
  }
}

/**
 * GET /dashboard/venues/:venueId/available-balance/by-card-type
 * Get balance breakdown by card type
 */
export async function getBalanceByCardType(
  req: Request<{ venueId: string }, {}, {}, { from?: string; to?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { from, to } = req.query

    // Parse optional date range
    let dateRange: { from: Date; to: Date } | undefined
    if (from && to) {
      dateRange = {
        from: new Date(from),
        to: new Date(to),
      }
    }

    const breakdown = await availableBalanceService.getBalanceByCardType(venueId, dateRange)

    res.status(200).json({ success: true, data: breakdown })
  } catch (error) {
    logger.error('Error fetching balance by card type', { error })
    next(error)
  }
}

/**
 * GET /dashboard/venues/:venueId/available-balance/timeline
 * Get settlement timeline
 */
export async function getSettlementTimeline(
  req: Request<{ venueId: string }, {}, {}, { from?: string; to?: string; includePast?: boolean; includeFuture?: boolean }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { from, to, includePast, includeFuture } = req.query

    // Calculate default date range if not provided
    let dateRange: { from: Date; to: Date }

    if (from && to) {
      // Use provided date range
      dateRange = {
        from: new Date(from),
        to: new Date(to),
      }
    } else {
      // Calculate default range based on flags
      const now = new Date()
      const pastDays = includePast ? 30 : 0
      const futureDays = includeFuture ? 30 : 0

      dateRange = {
        from: new Date(now.getTime() - pastDays * 24 * 60 * 60 * 1000),
        to: new Date(now.getTime() + futureDays * 24 * 60 * 60 * 1000),
      }
    }

    const timeline = await availableBalanceService.getSettlementTimeline(venueId, dateRange)

    res.status(200).json({ success: true, data: timeline })
  } catch (error) {
    logger.error('Error fetching settlement timeline', { error })
    next(error)
  }
}

/**
 * POST /dashboard/venues/:venueId/available-balance/simulate
 * Simulate a transaction to see estimated settlement
 */
export async function simulateTransaction(
  req: Request<
    { venueId: string },
    {},
    {
      amount: number
      cardType: string
      transactionDate: string
      transactionTime?: string
    }
  >,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const userId = req.authContext?.userId

    if (!userId) {
      throw new AuthenticationError('User not authenticated')
    }

    const { amount, cardType, transactionDate, transactionTime } = req.body

    const simulation = await availableBalanceService.simulateTransaction(venueId, userId, {
      amount,
      cardType: cardType as any, // Type validated by schema
      transactionDate: new Date(transactionDate),
      transactionTime,
    })

    res.status(200).json({ success: true, data: simulation })
  } catch (error) {
    logger.error('Error simulating transaction', { error })
    next(error)
  }
}

/**
 * GET /dashboard/venues/:venueId/available-balance/settlement-calendar
 * Get settlement calendar - shows exactly how much money will be deposited each day
 */
export async function getSettlementCalendar(
  req: Request<{ venueId: string }, {}, {}, { from?: string; to?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const { from, to } = req.query

    // Calculate default date range: next 30 days
    let dateRange: { from: Date; to: Date }

    if (from && to) {
      dateRange = {
        from: new Date(from),
        to: new Date(to),
      }
    } else {
      const now = new Date()
      dateRange = {
        from: now,
        to: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), // Next 30 days
      }
    }

    const calendar = await availableBalanceService.getSettlementCalendar(venueId, dateRange)

    res.status(200).json({ success: true, data: calendar })
  } catch (error) {
    logger.error('Error fetching settlement calendar', { error })
    next(error)
  }
}

/**
 * GET /dashboard/venues/:venueId/available-balance/projection
 * Project future balance based on historical patterns
 */
export async function getBalanceProjection(
  req: Request<{ venueId: string }, {}, {}, { days?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const projectionDays = req.query.days ? parseInt(req.query.days) : 7

    const projection = await availableBalanceService.projectHistoricalBalance(venueId, projectionDays)

    res.status(200).json({ success: true, data: projection })
  } catch (error) {
    logger.error('Error projecting balance', { error })
    next(error)
  }
}
