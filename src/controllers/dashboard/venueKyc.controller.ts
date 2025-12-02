/**
 * Venue KYC Controller (Dashboard)
 *
 * Handles venue owner KYC operations (resubmitting documents after rejection)
 */

import { Request, Response } from 'express'
import logger from '@/config/logger'
import * as venueKycService from '@/services/dashboard/venueKyc.service'

/**
 * Upload a single KYC document (auto-save)
 */
export async function uploadSingleKycDocument(req: Request, res: Response) {
  try {
    const { venueId, documentKey } = req.params
    const authContext = (req as any).authContext
    const userId = authContext.userId
    const userRole = authContext.role // SUPERADMIN, OWNER, ADMIN, etc.

    // Multer will attach file to req.file (single file upload)
    const file = req.file as any

    if (!file) {
      return res.status(400).json({
        success: false,
        message: 'No document provided',
      })
    }

    const result = await venueKycService.uploadSingleKycDocument(venueId, userId, documentKey, file, userRole)

    res.status(200).json({
      success: true,
      message: 'Document uploaded successfully',
      data: {
        documentKey: result.documentKey,
        url: result.url,
      },
    })
  } catch (error: any) {
    logger.error(`Error uploading KYC document for venue ${req.params.venueId}:`, error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to upload document',
    })
  }
}

/**
 * Submit KYC for review
 */
export async function submitKycForReview(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    const userId = authContext.userId
    const userRole = authContext.role // SUPERADMIN, OWNER, ADMIN, etc.

    await venueKycService.submitKycForReview(venueId, userId, userRole)

    res.status(200).json({
      success: true,
      message: 'KYC submitted for review',
    })
  } catch (error: any) {
    logger.error(`Error submitting KYC for venue ${req.params.venueId}:`, error)
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to submit KYC',
    })
  }
}

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
