import { NextFunction, Request, Response } from 'express'
import { BadRequestError, NotFoundError } from '../../errors/AppError'

import * as paymentTpvService from '../../services/tpv/payment.tpv.service'
import * as receiptDashboardService from '../../services/dashboard/receipt.dashboard.service'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'

export async function getPayments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId // 1. Extract from req (Controller)

    const venueId: string = req.params.venueId // 3. Extract from req (Controller, already validated)

    // 4. Extract query parameters with defaults
    const pageSize = Number(req.query.pageSize || '10')
    const pageNumber = Number(req.query.pageNumber || '1')

    // 5. Validate pagination parameters
    if (isNaN(pageSize) || isNaN(pageNumber) || pageSize <= 0 || pageNumber <= 0) {
      throw new BadRequestError('Invalid pagination parameters. pageSize and pageNumber must be positive numbers')
    }

    // 6. Extract filter parameters from body
    const filters = {
      fromDate: req.body?.fromDate,
      toDate: req.body?.toDate,
      staffId: req.body?.staffId,
    }

    // 7. Call service with clean data (Controller delegates)
    const result = await paymentTpvService.getPayments(venueId, pageSize, pageNumber, filters, orgId)

    // 8. Send HTTP response (Controller)
    res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
    })
  } catch (error) {
    next(error) // 9. HTTP error handling (Controller)
  }
}

/**
 * Record a payment for a specific table
 * @param req Request with payment data
 * @param res Response
 * @param next Next function for error handling
 */
export async function recordPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    const userId = req.authContext?.userId
    const venueId: string = req.params.venueId
    const orderId: string = req.params.orderId

    // Extract payment data from request body (already validated by schema)
    const paymentData = req.body

    // Call service to record the payment
    const result = await paymentTpvService.recordOrderPayment(venueId, orderId, paymentData, userId, orgId)

    // Send success response
    res.status(201).json({
      success: true,
      data: result,
      message: 'Payment recorded successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Record a fast payment (without specific table)
 * @param req Request with payment data
 * @param res Response
 * @param next Next function for error handling
 */
export async function recordFastPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    const userId = req.authContext?.userId
    const venueId: string = req.params.venueId

    // Extract payment data from request body (already validated by schema)
    const paymentData = req.body

    // Call service to record the fast payment
    const result = await paymentTpvService.recordFastPayment(venueId, paymentData, userId, orgId)

    // Send success response
    res.status(201).json({
      success: true,
      data: result,
      message: 'Fast payment recorded successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get available merchant accounts for a venue
 * @param req Request with venueId parameter
 * @param res Response
 * @param next Next function for error handling
 */
export async function getMerchantAccounts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    const venueId: string = req.params.venueId

    // Call service to get merchant accounts
    const result = await paymentTpvService.getVenueMerchantAccounts(venueId, orgId)

    // Send success response
    res.status(200).json({
      success: true,
      data: result,
      message: 'Merchant accounts retrieved successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get payment routing configuration for dynamic payment processing
 * @param req Request with venueId parameter and routing data in body
 * @param res Response
 * @param next Next function for error handling
 */
export async function getMentaRoute(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    const venueId: string = req.params.venueId

    // Extract routing parameters from request body (already validated by schema)
    const routingData = req.body

    // Call service to get payment routing configuration
    const result = await paymentTpvService.getPaymentRouting(venueId, routingData, orgId)

    // Send success response
    res.status(200).json({
      success: true,
      data: result,
      message: 'Payment routing retrieved successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Send a payment receipt by email
 * @param req Request with venueId, paymentId and recipientEmail
 * @param res Response
 * @param next Next function for error handling
 */
export async function sendPaymentReceipt(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const venueId: string = req.params.venueId
    const paymentId: string = req.params.paymentId
    const { recipientEmail } = req.body

    // Verify that the payment exists and belongs to the venue
    const payment = await prisma.payment.findFirst({
      where: {
        id: paymentId,
        venueId: venueId,
      },
    })

    if (!payment) {
      throw new NotFoundError('Payment not found or does not belong to this venue')
    }

    // Generate (or update) the receipt with the recipient email
    const receipt = await receiptDashboardService.generateAndStoreReceipt(paymentId, recipientEmail)

    // Send the email asynchronously (don't block response)
    receiptDashboardService.sendReceiptByEmail(receipt.id).catch(error => {
      logger.error(`Failed to send receipt email for payment ${paymentId}:`, error)
    })

    logger.info(`Receipt email queued for payment ${paymentId} to ${recipientEmail}`)

    // Send success response
    res.status(200).json({
      success: true,
      receiptId: receipt.id,
      message: 'Recibo enviado exitosamente',
    })
  } catch (error) {
    next(error)
  }
}
