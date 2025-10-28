/**
 * Venue KYC Service (Dashboard)
 *
 * Handles venue owner KYC operations (resubmitting documents after rejection)
 */

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { uploadFileToStorage } from '@/services/storage.service'

import { notifySuperadminsNewKycSubmission } from '@/services/superadmin/kycReview.service'
import { BadRequestError, ForbiddenError } from '@/errors/AppError'

interface UploadedFile {
  buffer: Buffer
  originalname: string
  mimetype: string
}

/**
 * Resubmit KYC documents after rejection
 *
 * @param venueId - Venue ID
 * @param userId - User ID (must be venue owner)
 * @param files - Uploaded files from multer
 */
export async function resubmitKycDocuments(venueId: string, userId: string, files: Record<string, UploadedFile[]>) {
  try {
    // Get venue with staff assignments
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      include: {
        staff: {
          where: {
            staffId: userId,
            role: 'OWNER',
            active: true,
          },
        },
      },
    })

    if (!venue) {
      throw new BadRequestError('Venue not found')
    }

    // Verify user is venue owner
    if (venue.staff.length === 0) {
      throw new ForbiddenError('Only venue owners can resubmit KYC documents')
    }

    // Verify venue KYC is in REJECTED status
    if (venue.kycStatus !== 'REJECTED') {
      throw new BadRequestError(`Cannot resubmit documents. Current KYC status: ${venue.kycStatus}`)
    }

    logger.info(`🔄 Resubmitting KYC documents for venue: ${venue.name} (${venueId})`)

    // Get list of rejected documents
    const rejectedDocs = venue.kycRejectedDocuments || []
    const uploadedDocKeys = Object.keys(files)

    // If specific documents were rejected, validate:
    // 1. Only rejected documents are being uploaded
    // 2. All rejected documents are being resubmitted
    if (rejectedDocs.length > 0) {
      // Check for documents that weren't rejected but are being uploaded
      const invalidDocs = uploadedDocKeys.filter(docKey => !rejectedDocs.includes(docKey))
      if (invalidDocs.length > 0) {
        throw new BadRequestError(
          `Cannot modify approved documents: ${invalidDocs.join(', ')}. Only these documents were rejected: ${rejectedDocs.join(', ')}`,
        )
      }

      // Check if all rejected documents are being resubmitted
      const missingDocs = rejectedDocs.filter(docKey => !uploadedDocKeys.includes(docKey))
      if (missingDocs.length > 0) {
        throw new BadRequestError(`Missing rejected documents: ${missingDocs.join(', ')}. You must resubmit all rejected documents.`)
      }

      logger.info(`✅ Validation passed: All rejected documents (${rejectedDocs.join(', ')}) are being resubmitted`)
    }

    // Upload files to Firebase Storage and collect URLs
    const documentUpdates: Record<string, string | null> = {}

    for (const [fieldName, fileArray] of Object.entries(files)) {
      if (!fileArray || fileArray.length === 0) continue

      const file = fileArray[0] // Take first file (maxCount: 1 in route)

      // Determine file extension
      const extension = file.originalname.split('.').pop()?.toLowerCase() || 'pdf'

      // Generate clean filename (e.g., 'INE.pdf', 'RFC.pdf')
      let cleanName: string
      switch (fieldName) {
        case 'taxDocumentUrl':
          cleanName = 'Constancia_Situacion_Fiscal'
          break
        case 'ineUrl':
          cleanName = 'INE'
          break
        case 'rfcDocumentUrl':
          cleanName = 'RFC'
          break
        case 'comprobanteDomicilioUrl':
          cleanName = 'Comprobante_Domicilio'
          break
        case 'caratulaBancariaUrl':
          cleanName = 'Caratula_Bancaria'
          break
        case 'actaDocumentUrl':
          cleanName = 'Acta_Constitutiva'
          break
        case 'poderLegalUrl':
          cleanName = 'Poder_Legal'
          break
        default:
          cleanName = fieldName
      }

      // Upload to Firebase Storage
      const filePath = `venues/${venue.slug}/kyc/${cleanName}.${extension}`
      const downloadUrl = await uploadFileToStorage(file.buffer, filePath, file.mimetype)

      // Map field name to Prisma field
      let prismaField: string
      switch (fieldName) {
        case 'ineUrl':
          prismaField = 'idDocumentUrl'
          break
        case 'taxDocumentUrl':
          prismaField = 'taxDocumentUrl'
          break
        case 'actaDocumentUrl':
          prismaField = 'actaDocumentUrl'
          break
        default:
          prismaField = fieldName
      }

      documentUpdates[prismaField] = downloadUrl
      logger.info(`  ✅ Uploaded ${cleanName}: ${downloadUrl}`)
    }

    // Update venue with new document URLs and reset KYC status
    const updatedVenue = await prisma.venue.update({
      where: { id: venueId },
      data: {
        ...documentUpdates,
        kycStatus: 'PENDING_REVIEW',
        kycRejectionReason: null, // Clear rejection reason
        kycRejectedDocuments: [], // Clear rejected documents list
        kycVerifiedBy: null, // Clear previous verifier
      },
    })

    logger.info(`✅ KYC documents resubmitted for venue: ${venue.name}`)
    logger.info(`   Status changed: REJECTED → PENDING_REVIEW`)

    // Notify superadmins about the resubmission
    await notifySuperadminsNewKycSubmission(venueId, venue.name)

    return updatedVenue
  } catch (error) {
    logger.error(`Failed to resubmit KYC documents for venue ${venueId}:`, error)
    throw error
  }
}
