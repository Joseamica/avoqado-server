/**
 * KYC Review Service (Superadmin)
 *
 * Handles KYC document review and processor assignment workflow.
 * Superadmin reviews venue documents, assigns payment processor, sets rates,
 * and creates MerchantAccount upon approval.
 */

import { Prisma, NotificationType, NotificationPriority, NotificationChannel } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import * as notificationService from '@/services/dashboard/notification.service'
import { sendKycDocumentsToBlumon } from '@/services/resend.service'
import { generateBlumonExcel } from '@/services/superadmin/blumonExcelGenerator.service'

/**
 * Get all venues pending KYC review
 *
 * @returns List of venues with PENDING_REVIEW or IN_REVIEW status
 */
export async function getPendingKycVenues() {
  const venues = await prisma.venue.findMany({
    where: {
      kycStatus: {
        in: ['PENDING_REVIEW', 'IN_REVIEW'],
      },
    },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: {
      createdAt: 'asc', // Oldest first (FIFO)
    },
  })

  return venues
}

/**
 * Get KYC details for a specific venue
 *
 * @param venueId - Venue ID to get KYC details for
 * @returns Venue with KYC documents and payment info from onboarding
 */
export async function getVenueKycDetails(venueId: string) {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  })

  if (!venue) {
    throw new NotFoundError(`Venue ${venueId} not found`)
  }

  // Get venue owner (Staff user with OWNER role)
  const ownerAssignment = await prisma.staffVenue.findFirst({
    where: {
      venueId,
      role: 'OWNER',
      active: true,
    },
    include: {
      staff: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
        },
      },
    },
  })

  // Get onboarding progress to retrieve CLABE from step8_paymentInfo
  const onboarding = await prisma.onboardingProgress.findUnique({
    where: { organizationId: venue.organizationId },
  })

  // Extract payment info from onboarding (temporary storage)
  const paymentInfo = onboarding?.step8_paymentInfo as any

  return {
    venue,
    owner: {
      firstName: ownerAssignment?.staff.firstName || '',
      lastName: ownerAssignment?.staff.lastName || '',
      email: ownerAssignment?.staff.email || '',
      phone: ownerAssignment?.staff.phone || null,
    },
    bankInfo: {
      clabe: paymentInfo?.clabe,
      bankName: paymentInfo?.bankName,
      accountHolder: paymentInfo?.accountHolder,
    },
    documents: {
      ineUrl: venue.idDocumentUrl, // INE/IFE
      rfcDocumentUrl: venue.rfcDocumentUrl,
      comprobanteDomicilioUrl: venue.comprobanteDomicilioUrl,
      caratulaBancariaUrl: venue.caratulaBancariaUrl,
      actaConstitutivaUrl: venue.actaDocumentUrl, // Acta Constitutiva
      poderLegalUrl: venue.poderLegalUrl,
    },
  }
}

/**
 * Send KYC documents to Blumon after approval
 *
 * This is a fire-and-forget operation - failure does not block the approval.
 * Collects all venue, owner, and document info and sends to configured Blumon emails.
 * Also generates Blumon Excel from KYC documents using Claude Vision.
 *
 * @param venueId - Venue ID that was approved
 * @param approvedById - Staff ID who approved the KYC
 */
async function sendKycToBlumonAfterApproval(venueId: string, approvedById: string): Promise<void> {
  try {
    // Get complete venue data with all relationships
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    })

    if (!venue) {
      logger.warn(`Cannot send KYC to Blumon: Venue ${venueId} not found`)
      return
    }

    // Get venue owner (Staff user with OWNER role)
    const ownerAssignment = await prisma.staffVenue.findFirst({
      where: {
        venueId,
        role: 'OWNER',
        active: true,
      },
      include: {
        staff: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
      },
    })

    // Get onboarding progress to retrieve CLABE from step8_paymentInfo
    const onboarding = await prisma.onboardingProgress.findUnique({
      where: { organizationId: venue.organizationId },
    })

    // Extract payment info from onboarding (temporary storage)
    const paymentInfo = onboarding?.step8_paymentInfo as any

    // Get approver name
    const approver = await prisma.staff.findUnique({
      where: { id: approvedById },
      select: { firstName: true, lastName: true, email: true },
    })

    const approverName = approver ? `${approver.firstName || ''} ${approver.lastName || ''}`.trim() || approver.email : approvedById

    // Generate Blumon Excel from KYC documents (Claude Vision extraction)
    let blumonExcelUrl: string | null = null
    try {
      logger.info(`📊 Generating Blumon Excel for venue ${venueId}...`)
      const excelResult = await generateBlumonExcel(
        {
          rfcDocumentUrl: venue.rfcDocumentUrl,
          idDocumentUrl: venue.idDocumentUrl,
        },
        {
          name: venue.name,
          slug: venue.slug,
          phone: ownerAssignment?.staff.phone || null,
          email: ownerAssignment?.staff.email || null,
          website: venue.website || null,
        },
      )

      if (excelResult.success && excelResult.excelUrl) {
        blumonExcelUrl = excelResult.excelUrl
        logger.info(`✅ Blumon Excel generated: ${blumonExcelUrl}`)
      } else {
        logger.warn(`⚠️ Could not generate Blumon Excel for venue ${venueId}`)
      }
    } catch (excelError) {
      logger.error(`Error generating Blumon Excel for venue ${venueId}:`, excelError)
      // Continue with email even if Excel generation fails
    }

    // Send to Blumon
    const success = await sendKycDocumentsToBlumon({
      venueName: venue.name,
      venueId: venue.id,
      venueSlug: venue.slug,
      entityType: venue.entityType as 'PERSONA_FISICA' | 'PERSONA_MORAL' | null,
      rfc: venue.rfc,
      clabe: paymentInfo?.clabe || null,
      bankName: paymentInfo?.bankName || null,
      accountHolder: paymentInfo?.accountHolder || null,
      ownerName: ownerAssignment
        ? `${ownerAssignment.staff.firstName || ''} ${ownerAssignment.staff.lastName || ''}`.trim() || 'No name'
        : 'No owner assigned',
      ownerEmail: ownerAssignment?.staff.email || 'No email',
      ownerPhone: ownerAssignment?.staff.phone || null,
      documents: {
        ineUrl: venue.idDocumentUrl,
        rfcDocumentUrl: venue.rfcDocumentUrl,
        comprobanteDomicilioUrl: venue.comprobanteDomicilioUrl,
        caratulaBancariaUrl: venue.caratulaBancariaUrl,
        actaConstitutivaUrl: venue.actaDocumentUrl,
        poderLegalUrl: venue.poderLegalUrl,
      },
      approvedBy: approverName,
      approvalDate: new Date(),
      blumonExcelUrl, // Include the generated Excel URL
    })

    if (success) {
      logger.info(`📧 KYC documents sent to Blumon for venue ${venueId}`)
    } else {
      logger.warn(`⚠️ KYC documents NOT sent to Blumon for venue ${venueId} (check BLUMON_KYC_EMAILS config)`)
    }
  } catch (error) {
    // Log error but don't throw - this should not block KYC approval
    logger.error(`Failed to send KYC documents to Blumon for venue ${venueId}:`, error)
  }
}

/**
 * Simple KYC approval without processor assignment
 *
 * This is a simplified approval that just marks the venue as VERIFIED
 * without setting up payment processing. Use this for testing or when
 * processor setup will be done later.
 *
 * @param venueId - Venue ID to approve
 * @param superadminId - Superadmin user ID performing the action
 * @returns Updated venue
 */
export async function approveKyc(venueId: string, superadminId: string) {
  // Validate venue exists and can be approved
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue ${venueId} not found`)
  }

  if (venue.kycStatus === 'VERIFIED') {
    throw new BadRequestError(`Venue ${venueId} KYC is already verified`)
  }

  if (venue.kycStatus === 'REJECTED') {
    throw new BadRequestError(`Venue ${venueId} KYC was rejected. Cannot approve.`)
  }

  logger.info(`✅ Approving KYC for venue ${venueId} by superadmin ${superadminId}`)

  // Note: Demo data cleanup is now done in convertDemoVenue (when user submits KYC docs)
  // We don't clean here because user might have added real data while waiting for approval

  // Update venue status to VERIFIED
  const updatedVenue = await prisma.venue.update({
    where: { id: venueId },
    data: {
      kycStatus: 'VERIFIED',
      kycCompletedAt: new Date(),
      kycVerifiedBy: superadminId,
    },
  })

  logger.info(`✅ KYC approved successfully for venue ${venueId}`)

  // Send notification to venue owner
  await notifyVenueOwnerKycApproved(venueId, venue.name)

  // Send KYC documents to Blumon (fire-and-forget, doesn't block approval)
  sendKycToBlumonAfterApproval(venueId, superadminId).catch(() => {
    // Error already logged inside the function
  })

  return updatedVenue
}

/**
 * Assign payment processor and create MerchantAccount
 *
 * This is called by Superadmin after reviewing KYC documents.
 * It:
 * 1. Creates MerchantAccount with processor + CLABE + credentials
 * 2. Creates ProviderCostStructure (processor's costs)
 * 3. Creates VenuePricingStructure (venue's rates)
 * 4. Creates VenuePaymentConfig (links venue to merchant account)
 * 5. Updates venue kycStatus to VERIFIED
 *
 * @param venueId - Venue ID to approve
 * @param superadminId - Superadmin user ID performing the action
 * @param processorData - Payment processor assignment data
 * @returns Created MerchantAccount
 */
export async function assignProcessorAndApproveKyc(
  venueId: string,
  superadminId: string,
  processorData: {
    providerId: string // Payment provider ID (Blumon, Menta, etc.)
    externalMerchantId: string // Merchant ID from processor
    displayName: string // e.g., "Cuenta Principal", "Cuenta Operativa"
    credentials: Record<string, any> // API keys, credentials (will be encrypted)
    providerConfig?: Record<string, any> // Provider-specific config

    // CLABE from onboarding (will be stored in MerchantAccount)
    clabeNumber: string
    bankName: string
    accountHolder: string

    // Cost structure (what the processor charges Avoqado)
    providerCosts: {
      debitRate: number // e.g., 0.025 (2.5%)
      creditRate: number // e.g., 0.029 (2.9%)
      amexRate: number // e.g., 0.035 (3.5%)
      internationalRate: number // e.g., 0.04 (4%)
      fixedCostPerTransaction: number // e.g., 3.00 MXN
    }

    // Pricing structure (what the venue pays)
    venuePricing: {
      debitRate: number // e.g., 0.03 (3%)
      creditRate: number // e.g., 0.035 (3.5%)
      amexRate: number // e.g., 0.04 (4%)
      internationalRate: number // e.g., 0.045 (4.5%)
      fixedFeePerTransaction: number // e.g., 4.00 MXN
    }
  },
) {
  // Validate venue exists and is pending review
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue ${venueId} not found`)
  }

  if (venue.kycStatus === 'VERIFIED') {
    throw new BadRequestError(`Venue ${venueId} KYC is already verified`)
  }

  if (venue.kycStatus === 'REJECTED') {
    throw new BadRequestError(`Venue ${venueId} KYC was rejected. Cannot approve.`)
  }

  logger.info(`🔍 Assigning processor to venue ${venueId}:`, {
    providerId: processorData.providerId,
    merchantId: processorData.externalMerchantId,
    superadminId,
  })

  // Note: Demo data cleanup is now done in convertDemoVenue (when user submits KYC docs)
  // We don't clean here because user might have added real data while waiting for approval

  // Use transaction to ensure atomicity
  const result = await prisma.$transaction(async tx => {
    // 1. Create MerchantAccount with CLABE
    const merchantAccount = await tx.merchantAccount.create({
      data: {
        providerId: processorData.providerId,
        externalMerchantId: processorData.externalMerchantId,
        displayName: processorData.displayName,
        active: true,
        displayOrder: 0, // Primary account

        // CLABE information
        clabeNumber: processorData.clabeNumber,
        bankName: processorData.bankName,
        accountHolder: processorData.accountHolder,

        // Encrypted credentials (TODO: Implement proper encryption)
        credentialsEncrypted: processorData.credentials as Prisma.InputJsonValue,

        // Provider-specific config
        providerConfig: (processorData.providerConfig || {}) as Prisma.InputJsonValue,
      },
    })

    logger.info(`✅ Created MerchantAccount ${merchantAccount.id} for venue ${venueId}`)

    // 2. Create ProviderCostStructure (what processor charges Avoqado)
    await tx.providerCostStructure.create({
      data: {
        providerId: processorData.providerId,
        merchantAccountId: merchantAccount.id,
        debitRate: processorData.providerCosts.debitRate,
        creditRate: processorData.providerCosts.creditRate,
        amexRate: processorData.providerCosts.amexRate,
        internationalRate: processorData.providerCosts.internationalRate,
        fixedCostPerTransaction: processorData.providerCosts.fixedCostPerTransaction,
        effectiveFrom: new Date(),
      },
    })

    logger.info(`✅ Created ProviderCostStructure for MerchantAccount ${merchantAccount.id}`)

    // 3. Create VenuePricingStructure (what venue pays)
    await tx.venuePricingStructure.create({
      data: {
        venueId,
        accountType: 'PRIMARY', // This is the primary account
        debitRate: processorData.venuePricing.debitRate,
        creditRate: processorData.venuePricing.creditRate,
        amexRate: processorData.venuePricing.amexRate,
        internationalRate: processorData.venuePricing.internationalRate,
        fixedFeePerTransaction: processorData.venuePricing.fixedFeePerTransaction,
        effectiveFrom: new Date(),
      },
    })

    logger.info(`✅ Created VenuePricingStructure for venue ${venueId}`)

    // 4. Create VenuePaymentConfig (links venue to merchant account)
    await tx.venuePaymentConfig.create({
      data: {
        venueId,
        primaryAccountId: merchantAccount.id,
      },
    })

    logger.info(`✅ Created VenuePaymentConfig for venue ${venueId}`)

    // 5. Update venue KYC status to VERIFIED
    await tx.venue.update({
      where: { id: venueId },
      data: {
        kycStatus: 'VERIFIED',
        kycCompletedAt: new Date(),
        kycVerifiedBy: superadminId,
      },
    })

    logger.info(`✅ Updated venue ${venueId} kycStatus to VERIFIED`)

    return merchantAccount
  })

  // Notify venue owner about KYC approval
  await notifyVenueOwnerKycApproved(venueId, venue.name)

  // Send KYC documents to Blumon (fire-and-forget, doesn't block approval)
  sendKycToBlumonAfterApproval(venueId, superadminId).catch(() => {
    // Error already logged inside the function
  })

  return result
}

/**
 * Reject KYC for a venue
 *
 * @param venueId - Venue ID to reject
 * @param superadminId - Superadmin user ID performing the action
 * @param rejectionReason - Reason for rejection
 * @param rejectedDocuments - Optional array of specific document keys that were rejected (e.g., ["ineUrl", "rfcDocumentUrl"])
 * @returns Updated venue
 */
export async function rejectKyc(venueId: string, superadminId: string, rejectionReason: string, rejectedDocuments?: string[]) {
  // Validate venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue ${venueId} not found`)
  }

  if (venue.kycStatus === 'VERIFIED') {
    throw new BadRequestError(`Venue ${venueId} KYC is already verified. Cannot reject.`)
  }

  logger.info(`❌ Rejecting KYC for venue ${venueId}:`, {
    superadminId,
    reason: rejectionReason,
    rejectedDocuments: rejectedDocuments || 'all documents',
  })

  // Update venue status to REJECTED
  const updatedVenue = await prisma.venue.update({
    where: { id: venueId },
    data: {
      kycStatus: 'REJECTED',
      kycRejectionReason: rejectionReason,
      kycRejectedDocuments: rejectedDocuments || [], // Empty array means all documents rejected
      kycVerifiedBy: superadminId,
    },
  })

  logger.info(`✅ Venue ${venueId} KYC rejected${rejectedDocuments ? ` (specific documents: ${rejectedDocuments.join(', ')})` : ''}`)

  // Notify venue owner about KYC rejection
  await notifyVenueOwnerKycRejected(venueId, venue.name, rejectionReason)

  return updatedVenue
}

/**
 * Update KYC status to IN_REVIEW
 *
 * This is called when Superadmin starts reviewing a venue's KYC.
 *
 * @param venueId - Venue ID
 * @param superadminId - Superadmin user ID
 * @returns Updated venue
 */
export async function markKycInReview(venueId: string, superadminId: string) {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue ${venueId} not found`)
  }

  if (venue.kycStatus !== 'PENDING_REVIEW') {
    throw new BadRequestError(`Venue ${venueId} is not pending review`)
  }

  const updatedVenue = await prisma.venue.update({
    where: { id: venueId },
    data: {
      kycStatus: 'IN_REVIEW',
      kycVerifiedBy: superadminId,
    },
  })

  logger.info(`🔍 Venue ${venueId} KYC marked as IN_REVIEW by ${superadminId}`)

  // Notify venue owner that KYC is under review
  await notifyVenueOwnerKycInReview(venueId, venue.name)

  return updatedVenue
}

/**
 * Notification Functions
 */

/**
 * Notify all superadmins when a new venue submits KYC
 *
 * @param venueId - Venue ID
 * @param venueName - Venue name
 */
export async function notifySuperadminsNewKycSubmission(venueId: string, venueName: string): Promise<void> {
  try {
    // Get all superadmin users (from StaffVenue where role is SUPERADMIN)
    const superadminAssignments = await prisma.staffVenue.findMany({
      where: {
        role: 'SUPERADMIN',
        active: true,
      },
      select: {
        staffId: true,
      },
      distinct: ['staffId'], // Avoid duplicate notifications if superadmin is in multiple venues
    })

    // Extract unique staff IDs
    const superadminIds = [...new Set(superadminAssignments.map(sa => sa.staffId))]

    if (superadminIds.length === 0) {
      logger.warn('No superadmins found to notify for new KYC submission')
      return
    }

    logger.info(`📤 Notifying ${superadminIds.length} superadmins about new KYC submission from ${venueName}`)

    // Send notification to each superadmin
    for (const superadminId of superadminIds) {
      await notificationService.sendNotification({
        recipientId: superadminId,
        type: NotificationType.NEW_KYC_SUBMISSION,
        title: '🆕 New KYC Submission',
        message: `${venueName} has submitted KYC documents for review.`,
        actionUrl: `/superadmin/kyc/${venueId}`,
        actionLabel: 'Review KYC',
        entityType: 'Venue',
        entityId: venueId,
        metadata: {
          venueName,
          venueId,
        },
        priority: NotificationPriority.HIGH,
        channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
      })
    }

    logger.info(`✅ Notified ${superadminIds.length} superadmins about KYC submission`)
  } catch (error) {
    logger.error('Failed to notify superadmins about new KYC submission:', error)
    // Don't throw - notification failure shouldn't break the main flow
  }
}

/**
 * Notify venue owner that their KYC was approved
 *
 * @param venueId - Venue ID
 * @param venueName - Venue name
 */
export async function notifyVenueOwnerKycApproved(venueId: string, venueName: string): Promise<void> {
  try {
    // Get venue slug for correct route
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { slug: true },
    })

    if (!venue) {
      logger.warn(`Venue ${venueId} not found for KYC approval notification`)
      return
    }

    // Get venue owner
    const ownerAssignment = await prisma.staffVenue.findFirst({
      where: {
        venueId,
        role: 'OWNER',
        active: true,
      },
      select: {
        staffId: true,
      },
    })

    if (!ownerAssignment) {
      logger.warn(`No owner found for venue ${venueId} to notify KYC approval`)
      return
    }

    await notificationService.sendNotification({
      recipientId: ownerAssignment.staffId,
      venueId,
      type: NotificationType.KYC_APPROVED,
      title: '✅ KYC Approved',
      message: `Your KYC documents for ${venueName} have been approved! You can now start accepting payments.`,
      actionUrl: `/venues/${venue.slug}/home`,
      actionLabel: 'Go to Dashboard',
      entityType: 'Venue',
      entityId: venueId,
      metadata: {
        venueName,
        venueId,
      },
      priority: NotificationPriority.HIGH,
      channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
    })

    logger.info(`✅ Notified venue owner about KYC approval for ${venueName}`)
  } catch (error) {
    logger.error('Failed to notify venue owner about KYC approval:', error)
  }
}

/**
 * Notify venue owner that their KYC was rejected
 *
 * @param venueId - Venue ID
 * @param venueName - Venue name
 * @param rejectionReason - Reason for rejection
 */
export async function notifyVenueOwnerKycRejected(venueId: string, venueName: string, rejectionReason: string): Promise<void> {
  try {
    // Get venue slug for correct route
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { slug: true },
    })

    if (!venue) {
      logger.warn(`Venue ${venueId} not found for KYC rejection notification`)
      return
    }

    // Get venue owner
    const ownerAssignment = await prisma.staffVenue.findFirst({
      where: {
        venueId,
        role: 'OWNER',
        active: true,
      },
      select: {
        staffId: true,
      },
    })

    if (!ownerAssignment) {
      logger.warn(`No owner found for venue ${venueId} to notify KYC rejection`)
      return
    }

    await notificationService.sendNotification({
      recipientId: ownerAssignment.staffId,
      venueId,
      type: NotificationType.KYC_REJECTED,
      title: '❌ KYC Rejected',
      message: `Your KYC documents for ${venueName} have been rejected. Reason: ${rejectionReason}. Please resubmit your documents.`,
      actionUrl: `/venues/${venue.slug}/edit/documents`,
      actionLabel: 'View Documents',
      entityType: 'Venue',
      entityId: venueId,
      metadata: {
        venueName,
        venueId,
        rejectionReason,
      },
      priority: NotificationPriority.URGENT,
      channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
    })

    logger.info(`✅ Notified venue owner about KYC rejection for ${venueName}`)
  } catch (error) {
    logger.error('Failed to notify venue owner about KYC rejection:', error)
  }
}

/**
 * Notify venue owner that their KYC is under review
 *
 * @param venueId - Venue ID
 * @param venueName - Venue name
 */
export async function notifyVenueOwnerKycInReview(venueId: string, venueName: string): Promise<void> {
  try {
    // Get venue owner
    const ownerAssignment = await prisma.staffVenue.findFirst({
      where: {
        venueId,
        role: 'OWNER',
        active: true,
      },
      select: {
        staffId: true,
      },
    })

    if (!ownerAssignment) {
      logger.warn(`No owner found for venue ${venueId} to notify KYC in review`)
      return
    }

    await notificationService.sendNotification({
      recipientId: ownerAssignment.staffId,
      venueId,
      type: NotificationType.KYC_IN_REVIEW,
      title: '🔍 KYC Under Review',
      message: `Your KYC documents for ${venueName} are currently being reviewed by our team.`,
      actionUrl: `/dashboard/${venueId}`,
      actionLabel: 'View Status',
      entityType: 'Venue',
      entityId: venueId,
      metadata: {
        venueName,
        venueId,
      },
      priority: NotificationPriority.NORMAL,
      channels: [NotificationChannel.IN_APP],
    })

    logger.info(`✅ Notified venue owner that KYC is in review for ${venueName}`)
  } catch (error) {
    logger.error('Failed to notify venue owner about KYC in review:', error)
  }
}
