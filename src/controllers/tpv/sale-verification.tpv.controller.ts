import { Request, Response } from 'express'
import * as saleVerificationService from '../../services/tpv/sale-verification.service'
import logger from '../../config/logger'
import { SaleVerificationStatus } from '@prisma/client'

// ============================================================
// Sale Verification Controller
// ============================================================
// Handles HTTP requests for Step 4 verification in retail/telecom venues

/**
 * POST /tpv/venues/:venueId/verificaciones
 * Create a sale verification record
 */
export async function createSaleVerification(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params
    const { paymentId, staffId, photos, scannedProducts, deviceId, notes, status } = req.body

    logger.info(`[SALE VERIFICATION CONTROLLER] POST /tpv/venues/${venueId}/verificaciones - PaymentId: ${paymentId}`)

    const verification = await saleVerificationService.createSaleVerification(venueId, {
      paymentId,
      staffId,
      photos,
      scannedProducts,
      deviceId,
      notes,
      status,
    })

    res.status(201).json({
      success: true,
      data: verification,
      message: 'Sale verification created successfully',
    })
  } catch (error: any) {
    logger.error(`[SALE VERIFICATION CONTROLLER] Error creating verification: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * GET /tpv/venues/:venueId/verificaciones
 * List sale verifications with pagination
 */
export async function listSaleVerifications(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params
    const { pageSize = '20', pageNumber = '1', status, staffId, fromDate, toDate } = req.query

    logger.info(
      `[SALE VERIFICATION CONTROLLER] GET /tpv/venues/${venueId}/verificaciones - Page ${pageNumber}, Size ${pageSize}`,
    )

    const result = await saleVerificationService.listSaleVerifications(venueId, {
      pageSize: parseInt(pageSize as string, 10),
      pageNumber: parseInt(pageNumber as string, 10),
      status: status as SaleVerificationStatus | undefined,
      staffId: staffId as string | undefined,
      fromDate: fromDate ? new Date(fromDate as string) : undefined,
      toDate: toDate ? new Date(toDate as string) : undefined,
    })

    res.status(200).json({
      success: true,
      data: result.data,
      pagination: result.pagination,
    })
  } catch (error: any) {
    logger.error(`[SALE VERIFICATION CONTROLLER] Error listing verifications: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * GET /tpv/venues/:venueId/verificaciones/:verificationId
 * Get a single sale verification
 */
export async function getSaleVerification(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, verificationId } = req.params

    logger.info(`[SALE VERIFICATION CONTROLLER] GET /tpv/venues/${venueId}/verificaciones/${verificationId}`)

    const verification = await saleVerificationService.getSaleVerification(venueId, verificationId)

    res.status(200).json({
      success: true,
      data: verification,
    })
  } catch (error: any) {
    logger.error(`[SALE VERIFICATION CONTROLLER] Error getting verification: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * GET /tpv/venues/:venueId/payments/:paymentId/verificacion
 * Get verification by payment ID
 */
export async function getVerificationByPaymentId(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, paymentId } = req.params

    logger.info(`[SALE VERIFICATION CONTROLLER] GET /tpv/venues/${venueId}/payments/${paymentId}/verificacion`)

    const verification = await saleVerificationService.getVerificationByPaymentId(venueId, paymentId)

    if (!verification) {
      res.status(404).json({
        success: false,
        message: `No verification found for payment ${paymentId}`,
      })
      return
    }

    res.status(200).json({
      success: true,
      data: verification,
    })
  } catch (error: any) {
    logger.error(`[SALE VERIFICATION CONTROLLER] Error getting verification by payment: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}

/**
 * PATCH /tpv/venues/:venueId/verificaciones/:verificationId/status
 * Update verification status
 */
export async function updateVerificationStatus(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, verificationId } = req.params
    const { status, inventoryDeducted } = req.body

    logger.info(
      `[SALE VERIFICATION CONTROLLER] PATCH /tpv/venues/${venueId}/verificaciones/${verificationId}/status -> ${status}`,
    )

    const verification = await saleVerificationService.updateVerificationStatus(
      venueId,
      verificationId,
      status as SaleVerificationStatus,
      inventoryDeducted,
    )

    res.status(200).json({
      success: true,
      data: verification,
      message: 'Verification status updated successfully',
    })
  } catch (error: any) {
    logger.error(`[SALE VERIFICATION CONTROLLER] Error updating verification status: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Internal server error',
    })
  }
}
