/**
 * Venue KYC Service (Dashboard)
 *
 * Handles venue owner KYC operations (resubmitting documents after rejection)
 */

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { uploadFileToStorage, buildStoragePath } from '@/services/storage.service'

import { notifySuperadminsNewKycSubmission } from '@/services/superadmin/kycReview.service'
import { sendKycDocumentUploadedNotification } from '@/services/resend.service'
import { BadRequestError, ForbiddenError } from '@/errors/AppError'
import { logAction } from './activity-log.service'

interface UploadedFile {
  buffer: Buffer
  originalname: string
  mimetype: string
}

// Document key to Prisma field mapping
const DOCUMENT_KEY_TO_PRISMA: Record<string, string> = {
  ineUrl: 'idDocumentUrl',
  taxDocumentUrl: 'taxDocumentUrl',
  actaDocumentUrl: 'actaDocumentUrl',
  rfcDocumentUrl: 'rfcDocumentUrl',
  comprobanteDomicilioUrl: 'comprobanteDomicilioUrl',
  caratulaBancariaUrl: 'caratulaBancariaUrl',
  poderLegalUrl: 'poderLegalUrl',
}

// Document key to human label — what a person reads in the notification email.
const DOCUMENT_KEY_TO_LABEL: Record<string, string> = {
  ineUrl: 'INE',
  taxDocumentUrl: 'Constancia de Situación Fiscal',
  actaDocumentUrl: 'Acta Constitutiva',
  rfcDocumentUrl: 'RFC',
  comprobanteDomicilioUrl: 'Comprobante de Domicilio',
  caratulaBancariaUrl: 'Carátula Bancaria',
  poderLegalUrl: 'Poder Legal',
}

// Document key to clean file name mapping
const DOCUMENT_KEY_TO_NAME: Record<string, string> = {
  ineUrl: 'INE',
  taxDocumentUrl: 'Constancia_Situacion_Fiscal',
  actaDocumentUrl: 'Acta_Constitutiva',
  rfcDocumentUrl: 'RFC',
  comprobanteDomicilioUrl: 'Comprobante_Domicilio',
  caratulaBancariaUrl: 'Caratula_Bancaria',
  poderLegalUrl: 'Poder_Legal',
}

/**
 * Upload a single KYC document (auto-save)
 *
 * This saves the document immediately without changing KYC status.
 * KYC status changes to PENDING_REVIEW only when user explicitly submits.
 *
 * @param venueId - Venue ID
 * @param userId - User ID
 * @param documentKey - The document field key (e.g., 'ineUrl', 'rfcDocumentUrl')
 * @param file - Uploaded file from multer
 * @param userRole - User's system role (SUPERADMIN bypasses venue staff check)
 */
export async function uploadSingleKycDocument(venueId: string, userId: string, documentKey: string, file: UploadedFile, userRole?: string) {
  try {
    // Validate document key
    const prismaField = DOCUMENT_KEY_TO_PRISMA[documentKey]
    if (!prismaField) {
      throw new BadRequestError(`Invalid document key: ${documentKey}`)
    }

    // SUPERADMIN can upload for any venue
    const isSuperadmin = userRole === 'SUPERADMIN'

    // Get venue with staff assignments (only needed for non-superadmin)
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      include: {
        staff: isSuperadmin
          ? undefined
          : {
              where: {
                staffId: userId,
                role: { in: ['OWNER', 'ADMIN'] },
                active: true,
              },
            },
      },
    })

    if (!venue) {
      throw new BadRequestError('Venue not found')
    }

    // Verify user has permission (superadmin or venue owner/admin)
    if (!isSuperadmin && (!venue.staff || venue.staff.length === 0)) {
      throw new ForbiddenError('Only superadmins, venue owners, or admins can upload KYC documents')
    }

    // Uploading a document is allowed in EVERY KYC status, on purpose.
    //
    // The KYC is often approved by hand before the venue has finished sending its papers —
    // so the venue ends up VERIFIED with documents still missing. Blocking the upload there
    // (what this code used to do) left the business with no way in at all: it could not
    // upload, and it had nothing to resubmit. Two real attempts failed that way on
    // 2026-08-12.
    //
    // This is safe because an upload does NOT touch `kycStatus` — a manual approval stays
    // approved. Every upload writes an ActivityLog row and mails the document to the
    // onboarding inbox, so a late change is visible rather than silent.

    // For REJECTED status, check if this specific document was rejected
    if (venue.kycStatus === 'REJECTED') {
      const rejectedDocs = venue.kycRejectedDocuments || []
      // If there's a specific rejection list and this doc wasn't rejected, block it
      if (rejectedDocs.length > 0 && !rejectedDocs.includes(documentKey)) {
        throw new BadRequestError(`Cannot modify approved document: ${documentKey}. Only rejected documents can be re-uploaded.`)
      }
    }

    logger.info(`📄 Uploading single KYC document for venue: ${venue.name} (${venueId}) - ${documentKey}`)

    // Determine file extension
    const extension = file.originalname.split('.').pop()?.toLowerCase() || 'pdf'
    const cleanName = DOCUMENT_KEY_TO_NAME[documentKey] || documentKey

    // Upload to Firebase Storage (path: {env}/venues/{slug}/kyc/{documentName}.{ext})
    const filePath = buildStoragePath(`venues/${venue.slug}/kyc/${cleanName}.${extension}`)
    const downloadUrl = await uploadFileToStorage(file.buffer, filePath, file.mimetype)

    // Update venue with new document URL
    const updateData: Record<string, string> = {
      [prismaField]: downloadUrl,
    }

    const updatedVenue = await prisma.venue.update({
      where: { id: venueId },
      data: updateData,
    })

    logAction({
      staffId: userId,
      venueId,
      action: 'KYC_DOCUMENT_UPLOADED',
      entity: 'Venue',
      entityId: venueId,
      data: { documentKey },
    })

    logger.info(`  ✅ Uploaded ${cleanName}: ${downloadUrl}`)

    // Mail the document to the onboarding inbox, attached. Fire-and-forget and AFTER the
    // save: the document is already stored, so a mail failure must never turn a successful
    // upload into an error for the venue.
    void sendKycDocumentUploadedNotification({
      venueName: venue.name,
      venueId,
      venueSlug: venue.slug,
      documentKey,
      documentLabel: DOCUMENT_KEY_TO_LABEL[documentKey] || cleanName,
      kycStatus: venue.kycStatus,
      fileName: `${venue.slug}-${cleanName}.${extension}`,
      fileBuffer: file.buffer,
      mimeType: file.mimetype,
      downloadUrl,
    }).catch(error => logger.error('KYC document notification failed', { venueId, documentKey, error }))

    return {
      documentKey,
      url: downloadUrl,
      venue: updatedVenue,
    }
  } catch (error) {
    logger.error(`Failed to upload KYC document ${documentKey} for venue ${venueId}:`, error)
    throw error
  }
}

/**
 * Submit KYC for review
 *
 * Changes status from NOT_SUBMITTED/REJECTED to PENDING_REVIEW
 * Validates all required documents are present.
 *
 * @param venueId - Venue ID
 * @param userId - User ID (must be venue owner)
 */
export async function submitKycForReview(venueId: string, userId: string, userRole?: string) {
  try {
    // SUPERADMIN can submit for any venue
    const isSuperadmin = userRole === 'SUPERADMIN'

    // Get venue with staff assignments (only needed for non-superadmin)
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      include: {
        staff: isSuperadmin
          ? undefined
          : {
              where: {
                staffId: userId,
                role: { in: ['OWNER', 'ADMIN'] },
                active: true,
              },
            },
      },
    })

    if (!venue) {
      throw new BadRequestError('Venue not found')
    }

    // Verify user has permission (superadmin or venue owner/admin)
    if (!isSuperadmin && (!venue.staff || venue.staff.length === 0)) {
      throw new ForbiddenError('Only superadmins, venue owners, or admins can submit KYC')
    }

    // Verify venue KYC is in a status that allows submission
    if (venue.kycStatus !== 'REJECTED' && venue.kycStatus !== 'NOT_SUBMITTED') {
      throw new BadRequestError(`Cannot submit KYC. Current status: ${venue.kycStatus}`)
    }

    // Determine required documents based on entityType
    const commonDocs = ['idDocumentUrl', 'rfcDocumentUrl', 'comprobanteDomicilioUrl', 'caratulaBancariaUrl']
    const requiredDocs = venue.entityType === 'PERSONA_MORAL' ? ['actaDocumentUrl', 'poderLegalUrl', ...commonDocs] : commonDocs

    // Check which required documents are missing
    const missingDocs = requiredDocs.filter(field => {
      const value = venue[field as keyof typeof venue]
      return !value
    })

    if (missingDocs.length > 0) {
      throw new BadRequestError(`Missing required documents: ${missingDocs.join(', ')}`)
    }

    // For REJECTED status with specific rejected docs, verify all were re-uploaded
    if (venue.kycStatus === 'REJECTED' && venue.kycRejectedDocuments && venue.kycRejectedDocuments.length > 0) {
      // All rejected docs should now have URLs (checked above in requiredDocs)
      logger.info(`✅ All rejected documents have been re-uploaded`)
    }

    logger.info(`📋 Submitting KYC for review: ${venue.name} (${venueId})`)

    // Update venue status
    const updatedVenue = await prisma.venue.update({
      where: { id: venueId },
      data: {
        kycStatus: 'PENDING_REVIEW',
        kycRejectionReason: null,
        kycRejectedDocuments: [],
        kycVerifiedBy: null,
      },
    })

    logAction({
      staffId: userId,
      venueId,
      action: 'KYC_SUBMITTED',
      entity: 'Venue',
      entityId: venueId,
    })

    logger.info(`✅ KYC submitted for venue: ${venue.name}`)
    logger.info(`   Status changed: ${venue.kycStatus} → PENDING_REVIEW`)

    // Notify superadmins about the submission
    await notifySuperadminsNewKycSubmission(venueId, venue.name)

    return updatedVenue
  } catch (error) {
    logger.error(`Failed to submit KYC for venue ${venueId}:`, error)
    throw error
  }
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

    // Verify venue KYC is in a status that allows document submission
    // NOT_SUBMITTED: First time submission
    // REJECTED: Resubmission after rejection
    if (venue.kycStatus !== 'REJECTED' && venue.kycStatus !== 'NOT_SUBMITTED') {
      throw new BadRequestError(`Cannot submit documents. Current KYC status: ${venue.kycStatus}`)
    }

    const isFirstSubmission = venue.kycStatus === 'NOT_SUBMITTED'

    logger.info(`🔄 ${isFirstSubmission ? 'Submitting' : 'Resubmitting'} KYC documents for venue: ${venue.name} (${venueId})`)

    // Get list of rejected documents (only relevant for resubmission)
    const rejectedDocs = venue.kycRejectedDocuments || []
    const uploadedDocKeys = Object.keys(files)

    // For resubmission (REJECTED status), validate:
    // 1. Only rejected documents are being uploaded
    // 2. All rejected documents are being resubmitted
    // For first submission (NOT_SUBMITTED), allow any documents
    if (!isFirstSubmission && rejectedDocs.length > 0) {
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

      // Upload to Firebase Storage (path: {env}/venues/{slug}/kyc/{documentName}.{ext})
      const filePath = buildStoragePath(`venues/${venue.slug}/kyc/${cleanName}.${extension}`)
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

    logAction({
      staffId: userId,
      venueId,
      action: 'KYC_RESUBMITTED',
      entity: 'Venue',
      entityId: venueId,
    })

    logger.info(`✅ KYC documents ${isFirstSubmission ? 'submitted' : 'resubmitted'} for venue: ${venue.name}`)
    logger.info(`   Status changed: ${venue.kycStatus} → PENDING_REVIEW`)

    // Notify superadmins about the resubmission
    await notifySuperadminsNewKycSubmission(venueId, venue.name)

    return updatedVenue
  } catch (error) {
    logger.error(`Failed to resubmit KYC documents for venue ${venueId}:`, error)
    throw error
  }
}
