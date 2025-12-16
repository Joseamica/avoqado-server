import { NextFunction, Request, Response } from 'express'
import * as refundTpvService from '../../services/tpv/refund.tpv.service'

/**
 * Record a refund for an existing payment
 *
 * **Endpoint:** POST /tpv/venues/:venueId/refunds
 *
 * **Request Body:**
 * ```json
 * {
 *   "venueId": "clxxx...",
 *   "originalPaymentId": "clyyy...",
 *   "originalOrderId": "clzzz...",
 *   "amount": 5000,
 *   "reason": "CUSTOMER_REQUEST",
 *   "staffId": "claaa...",
 *   "shiftId": "clbbb...",
 *   "merchantAccountId": "clccc...",
 *   "blumonSerialNumber": "2841548417",
 *   "authorizationNumber": "502511",
 *   "referenceNumber": "000000188231",
 *   "maskedPan": "411111******1111",
 *   "cardBrand": "VISA",
 *   "entryMode": "CHIP",
 *   "isPartialRefund": false,
 *   "currency": "MXN"
 * }
 * ```
 *
 * **Response:**
 * ```json
 * {
 *   "success": true,
 *   "data": {
 *     "id": "clxxx...",
 *     "originalPaymentId": "clyyy...",
 *     "amount": 50.00,
 *     "status": "COMPLETED",
 *     "digitalReceipt": { ... }
 *   },
 *   "message": "Refund recorded successfully"
 * }
 * ```
 */
export async function recordRefund(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    const userId = req.authContext?.userId
    const venueId: string = req.params.venueId

    // Extract refund data from request body
    const refundData = {
      venueId,
      originalPaymentId: req.body.originalPaymentId,
      originalOrderId: req.body.originalOrderId,
      amount: req.body.amount, // In cents
      reason: req.body.reason,
      staffId: req.body.staffId,
      shiftId: req.body.shiftId,
      merchantAccountId: req.body.merchantAccountId,
      blumonSerialNumber: req.body.blumonSerialNumber,
      authorizationNumber: req.body.authorizationNumber,
      referenceNumber: req.body.referenceNumber,
      maskedPan: req.body.maskedPan,
      cardBrand: req.body.cardBrand,
      entryMode: req.body.entryMode,
      isPartialRefund: req.body.isPartialRefund || false,
      currency: req.body.currency || 'MXN',
    }

    // Call service to record the refund
    const result = await refundTpvService.recordRefund(venueId, refundData, userId, orgId)

    // Send success response
    res.status(201).json({
      success: true,
      data: result,
      message: 'Refund recorded successfully',
    })
  } catch (error) {
    next(error)
  }
}
