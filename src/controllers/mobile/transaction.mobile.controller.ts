/**
 * Mobile Transaction Controller
 *
 * Transaction listing and detail endpoints for mobile apps (iOS, Android).
 */

import { NextFunction, Request, Response } from 'express'
import * as transactionService from '../../services/mobile/transaction.mobile.service'

/**
 * List transactions (paginated)
 * @route GET /api/v1/mobile/venues/:venueId/transactions
 */
export const listTransactions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const page = parseInt(req.query.page as string) || 1
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 50)

    const filters: transactionService.MobileTransactionFilters = {}

    if (req.query.search) filters.search = req.query.search as string
    if (req.query.method) filters.method = req.query.method as any
    if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom as string
    if (req.query.dateTo) filters.dateTo = req.query.dateTo as string

    const result = await transactionService.getTransactions(venueId, page, pageSize, filters)

    return res.json({
      success: true,
      ...result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get transaction detail
 * @route GET /api/v1/mobile/venues/:venueId/transactions/:paymentId
 */
export const getTransaction = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, paymentId } = req.params

    const transaction = await transactionService.getTransactionDetail(venueId, paymentId)

    return res.json({
      success: true,
      transaction,
    })
  } catch (error) {
    next(error)
  }
}
