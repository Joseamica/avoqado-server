/**
 * Venue KYC Routes (Dashboard)
 *
 * Routes for venue owners to manage their own KYC submissions
 * (resubmit documents after rejection)
 */

import express from 'express'
import multer from 'multer'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { asyncHandler } from '../../utils/asyncHandler'
import * as venueKycController from '../../controllers/dashboard/venueKyc.controller'

const router = express.Router()

// Configure multer for KYC document uploads (memory storage, max 10MB per file)
const kycDocumentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max per file
    files: 7, // Maximum 7 files (all KYC documents)
  },
  fileFilter: (req, file, cb) => {
    // Accept PDF, JPG, JPEG, PNG files
    const allowedMimeTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png']
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error(`Invalid file type. Only PDF, JPG, and PNG files are allowed. Got: ${file.mimetype}`))
    }
  },
})

// All venue KYC routes require authentication
router.use(authenticateTokenMiddleware)

/**
 * @route   POST /api/v1/dashboard/venues/:venueId/kyc/resubmit
 * @desc    Resubmit KYC documents after rejection
 * @access  Venue OWNER only
 */
router.post(
  '/venues/:venueId/kyc/resubmit',
  kycDocumentUpload.fields([
    { name: 'taxDocumentUrl', maxCount: 1 },
    { name: 'ineUrl', maxCount: 1 },
    { name: 'rfcDocumentUrl', maxCount: 1 },
    { name: 'comprobanteDomicilioUrl', maxCount: 1 },
    { name: 'caratulaBancariaUrl', maxCount: 1 },
    { name: 'actaDocumentUrl', maxCount: 1 },
    { name: 'poderLegalUrl', maxCount: 1 },
  ]),
  asyncHandler(venueKycController.resubmitKycDocuments),
)

export default router
