// controllers/dashboard/testing.dashboard.controller.ts

import { Request, Response, NextFunction } from 'express'
import * as testingService from '../../services/dashboard/testing.dashboard.service'
import logger from '../../config/logger'
import { CreateTestPaymentInput } from '../../schemas/dashboard/testing.schema'

/**
 * Create a test payment
 *
 * POST /api/v1/dashboard/testing/payment/fast
 *
 * Body:
 * - venueId: string (CUID)
 * - amount: number (in cents)
 * - tipAmount: number (in cents)
 * - method: PaymentMethod enum
 *
 * Returns:
 * - Created payment with receipt information
 */
export async function createTestPayment(req: Request<{}, {}, CreateTestPaymentInput>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, amount, tipAmount, method } = req.body
    const staffId = req.authContext!.userId // Get authenticated user ID from JWT middleware

    logger.info('Creating test payment via API', {
      venueId,
      amount,
      tipAmount,
      method,
      staffId,
    })

    const payment = await testingService.createTestPayment({
      venueId,
      amount,
      tipAmount,
      method,
      staffId,
    })

    res.status(201).json({
      success: true,
      message: 'Test payment created successfully',
      data: {
        payment,
        receiptUrl: payment.digitalReceipt?.receiptUrl,
      },
    })
  } catch (error) {
    logger.error('Error creating test payment', { error })
    next(error)
  }
}

/**
 * Get recent test payments
 *
 * GET /api/v1/dashboard/testing/payments?venueId=xxx&limit=10
 *
 * Query params:
 * - venueId: string (optional, CUID)
 * - limit: number (optional, default 10, max 100)
 *
 * Returns:
 * - Array of test payments
 */
export async function getTestPayments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, limit } = req.query as any

    logger.info('Fetching test payments via API', {
      venueId,
      limit,
    })

    const payments = await testingService.getTestPayments(venueId, limit)

    res.status(200).json({
      success: true,
      data: payments,
      meta: {
        count: payments.length,
        limit,
        venueId: venueId || 'all',
      },
    })
  } catch (error) {
    logger.error('Error fetching test payments', { error })
    next(error)
  }
}

/**
 * Delete a test payment
 *
 * DELETE /api/v1/dashboard/testing/payment/:paymentId
 *
 * Params:
 * - paymentId: string (CUID)
 *
 * Returns:
 * - Success message
 */
export async function deleteTestPayment(req: Request<{ paymentId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { paymentId } = req.params
    const staffId = req.authContext!.userId

    logger.info('Deleting test payment via API', {
      paymentId,
      staffId,
    })

    await testingService.deleteTestPayment(paymentId, staffId)

    res.status(200).json({
      success: true,
      message: 'Test payment deleted successfully',
    })
  } catch (error) {
    logger.error('Error deleting test payment', { error })
    next(error)
  }
}
