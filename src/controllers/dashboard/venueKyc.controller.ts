/**
 * Venue KYC Controller (Dashboard)
 *
 * Handles venue owner KYC operations (resubmitting documents after rejection)
 */

import { Request, Response } from 'express'
import logger from '@/config/logger'
import * as venueKycService from '@/services/dashboard/venueKyc.service'

/**
 * Resubmit KYC documents after rejection
 */
export async function resubmitKycDocuments(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    const userId = authContext.userId

    // Multer will attach files to req.files or req.body
    const files = req.files as any

    if (!files || Object.keys(files).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No documents provided',
      })
    }

    await venueKycService.resubmitKycDocuments(venueId, userId, files)

    res.status(200).json({
      success: true,
      message: 'KYC documents resubmitted successfully',
    })
  } catch (error: any) {
    logger.error(`Error resubmitting KYC for venue ${req.params.venueId}:`, error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to resubmit KYC documents',
    })
  }
}
