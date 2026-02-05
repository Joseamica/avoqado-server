/**
 * Marketing Campaigns Service (Superadmin)
 *
 * Handles mass email campaigns to venues and staff.
 * Features:
 * - Email templates for reusable content
 * - Campaign targeting (all venues, specific venues, staff by role)
 * - Queue-based sending (50 emails every 5 minutes to avoid Resend rate limits)
 * - Open/click tracking via Resend webhooks
 */

import { Resend } from 'resend'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { CampaignStatus, DeliveryStatus, StaffRole } from '@prisma/client'

// Initialize Resend
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const FROM_EMAIL = process.env.EMAIL_FROM || 'Avoqado <noreply@avoqado.io>'

// Rate limiting configuration
export const BATCH_SIZE = 50 // Emails per batch
export const BATCH_DELAY_MS = 500 // Delay between emails (2/second safe limit)

// ==========================================
// TEMPLATE OPERATIONS
// ==========================================

export interface CreateTemplateInput {
  name: string
  subject: string
  bodyHtml: string
  bodyText: string
  createdBy: string
}

export interface UpdateTemplateInput {
  name?: string
  subject?: string
  bodyHtml?: string
  bodyText?: string
}

export async function createTemplate(input: CreateTemplateInput) {
  return prisma.emailTemplate.create({
    data: {
      name: input.name,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      bodyText: input.bodyText,
      createdBy: input.createdBy,
    },
    include: {
      creator: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
  })
}

export async function updateTemplate(id: string, input: UpdateTemplateInput) {
  return prisma.emailTemplate.update({
    where: { id },
    data: input,
    include: {
      creator: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
  })
}

export async function deleteTemplate(id: string) {
  // Check if template is used by any campaigns
  const campaignsUsingTemplate = await prisma.marketingCampaign.count({
    where: { templateId: id },
  })

  if (campaignsUsingTemplate > 0) {
    // Don't delete, just remove the association
    await prisma.marketingCampaign.updateMany({
      where: { templateId: id },
      data: { templateId: null },
    })
  }

  return prisma.emailTemplate.delete({
    where: { id },
  })
}

export async function getTemplate(id: string) {
  return prisma.emailTemplate.findUnique({
    where: { id },
    include: {
      creator: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
  })
}

export async function listTemplates(params: { search?: string; limit?: number; offset?: number }) {
  const { search, limit = 50, offset = 0 } = params

  const where = search
    ? {
        OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { subject: { contains: search, mode: 'insensitive' as const } }],
      }
    : {}

  const [templates, total] = await Promise.all([
    prisma.emailTemplate.findMany({
      where,
      include: {
        creator: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        _count: {
          select: { campaigns: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.emailTemplate.count({ where }),
  ])

  return { templates, total }
}

// ==========================================
// CAMPAIGN OPERATIONS
// ==========================================

export interface CreateCampaignInput {
  name: string
  subject: string
  bodyHtml: string
  bodyText: string
  templateId?: string
  targetAllVenues: boolean
  targetVenueIds: string[]
  includeStaff: boolean
  targetStaffRoles: string[]
  createdBy: string
}

export interface UpdateCampaignInput {
  name?: string
  subject?: string
  bodyHtml?: string
  bodyText?: string
  targetAllVenues?: boolean
  targetVenueIds?: string[]
  includeStaff?: boolean
  targetStaffRoles?: string[]
}

export async function createCampaign(input: CreateCampaignInput) {
  return prisma.marketingCampaign.create({
    data: {
      name: input.name,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      bodyText: input.bodyText,
      templateId: input.templateId,
      targetAllVenues: input.targetAllVenues,
      targetVenueIds: input.targetVenueIds,
      includeStaff: input.includeStaff,
      targetStaffRoles: input.targetStaffRoles,
      createdBy: input.createdBy,
      status: 'DRAFT',
    },
    include: {
      creator: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      template: {
        select: { id: true, name: true },
      },
    },
  })
}

export async function updateCampaign(id: string, input: UpdateCampaignInput) {
  // Only allow updates to DRAFT campaigns
  const campaign = await prisma.marketingCampaign.findUnique({
    where: { id },
    select: { status: true },
  })

  if (!campaign) {
    throw new Error('Campaign not found')
  }

  if (campaign.status !== 'DRAFT') {
    throw new Error('Cannot update campaign that is not in DRAFT status')
  }

  return prisma.marketingCampaign.update({
    where: { id },
    data: input,
    include: {
      creator: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      template: {
        select: { id: true, name: true },
      },
    },
  })
}

export async function deleteCampaign(id: string) {
  const campaign = await prisma.marketingCampaign.findUnique({
    where: { id },
    select: { status: true },
  })

  if (!campaign) {
    throw new Error('Campaign not found')
  }

  // Allow deletion of any campaign (including completed ones)
  // CampaignDelivery will be deleted via cascade

  return prisma.marketingCampaign.delete({
    where: { id },
  })
}

export async function bulkDeleteCampaigns(filters: {
  status?: CampaignStatus[]
  createdAfter?: Date
  createdBefore?: Date
  ids?: string[]
}) {
  const where: any = {}

  if (filters.ids && filters.ids.length > 0) {
    where.id = { in: filters.ids }
  }

  if (filters.status && filters.status.length > 0) {
    where.status = { in: filters.status }
  }

  if (filters.createdAfter || filters.createdBefore) {
    where.createdAt = {}
    if (filters.createdAfter) {
      where.createdAt.gte = filters.createdAfter
    }
    if (filters.createdBefore) {
      where.createdAt.lte = filters.createdBefore
    }
  }

  // Get count before deleting
  const count = await prisma.marketingCampaign.count({ where })

  // Delete campaigns (deliveries cascade)
  await prisma.marketingCampaign.deleteMany({ where })

  return { deletedCount: count }
}

export async function getCampaign(id: string) {
  return prisma.marketingCampaign.findUnique({
    where: { id },
    include: {
      creator: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      template: {
        select: { id: true, name: true },
      },
    },
  })
}

export async function listCampaigns(params: { search?: string; status?: CampaignStatus[]; limit?: number; offset?: number }) {
  const { search, status, limit = 50, offset = 0 } = params

  const where: any = {}

  if (search) {
    where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { subject: { contains: search, mode: 'insensitive' } }]
  }

  if (status && status.length > 0) {
    where.status = { in: status }
  }

  const [campaigns, total] = await Promise.all([
    prisma.marketingCampaign.findMany({
      where,
      include: {
        creator: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        template: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.marketingCampaign.count({ where }),
  ])

  return { campaigns, total }
}

export async function getCampaignDeliveries(
  campaignId: string,
  params: { status?: DeliveryStatus[]; search?: string; limit?: number; offset?: number },
) {
  const { status, search, limit = 100, offset = 0 } = params

  const where: any = { campaignId }

  if (status && status.length > 0) {
    where.status = { in: status }
  }

  if (search) {
    where.OR = [
      { recipientEmail: { contains: search, mode: 'insensitive' } },
      { recipientName: { contains: search, mode: 'insensitive' } },
      { venueName: { contains: search, mode: 'insensitive' } },
    ]
  }

  const [deliveries, total] = await Promise.all([
    prisma.campaignDelivery.findMany({
      where,
      orderBy: { sentAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.campaignDelivery.count({ where }),
  ])

  return { deliveries, total }
}

// ==========================================
// RECIPIENT PREVIEW
// ==========================================

export interface RecipientPreviewParams {
  targetAllVenues: boolean
  targetVenueIds: string[]
  includeStaff: boolean
  targetStaffRoles: string[]
}

export async function previewRecipients(params: RecipientPreviewParams) {
  const { targetAllVenues, targetVenueIds, includeStaff, targetStaffRoles } = params

  // Get venue emails
  const venueWhere = targetAllVenues ? { email: { not: null } } : { id: { in: targetVenueIds }, email: { not: null } }

  const venues = await prisma.venue.findMany({
    where: venueWhere,
    select: {
      id: true,
      name: true,
      email: true,
    },
  })

  const venueRecipients = venues.filter(v => v.email).map(v => ({ email: v.email!, name: v.name, venueId: v.id, isStaff: false }))

  // Get staff emails if requested
  const staffRecipients: Array<{ email: string; name: string; venueId: string | null; isStaff: boolean }> = []

  if (includeStaff && targetStaffRoles.length > 0) {
    const staffWhere: any = {
      active: true,
      emailVerified: true,
      venues: {
        some: {
          role: { in: targetStaffRoles as StaffRole[] },
          active: true,
          ...(targetAllVenues ? {} : { venueId: { in: targetVenueIds } }),
        },
      },
    }

    const staff = await prisma.staff.findMany({
      where: staffWhere,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        venues: {
          select: {
            venueId: true,
            role: true,
          },
          where: {
            active: true,
            role: { in: targetStaffRoles as StaffRole[] },
            ...(targetAllVenues ? {} : { venueId: { in: targetVenueIds } }),
          },
        },
      },
    })

    // Deduplicate staff (they may have multiple venue associations)
    const seenEmails = new Set<string>()
    for (const s of staff) {
      if (!seenEmails.has(s.email)) {
        seenEmails.add(s.email)
        staffRecipients.push({
          email: s.email,
          name: `${s.firstName} ${s.lastName}`,
          venueId: s.venues[0]?.venueId || null,
          isStaff: true,
        })
      }
    }
  }

  // Deduplicate between venue and staff emails
  const allEmails = new Set<string>()
  const finalRecipients: Array<{ email: string; name: string; venueId: string | null; isStaff: boolean }> = []

  for (const r of venueRecipients) {
    if (!allEmails.has(r.email)) {
      allEmails.add(r.email)
      finalRecipients.push(r)
    }
  }

  for (const r of staffRecipients) {
    if (!allEmails.has(r.email)) {
      allEmails.add(r.email)
      finalRecipients.push(r)
    }
  }

  return {
    total: finalRecipients.length,
    venueCount: venueRecipients.length,
    staffCount: staffRecipients.length,
    recipients: finalRecipients,
  }
}

// ==========================================
// CAMPAIGN SENDING
// ==========================================

export async function startCampaign(campaignId: string) {
  const campaign = await prisma.marketingCampaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      status: true,
      targetAllVenues: true,
      targetVenueIds: true,
      includeStaff: true,
      targetStaffRoles: true,
    },
  })

  if (!campaign) {
    throw new Error('Campaign not found')
  }

  if (campaign.status !== 'DRAFT') {
    throw new Error('Campaign is not in DRAFT status')
  }

  // Get recipients
  const { recipients, total } = await previewRecipients({
    targetAllVenues: campaign.targetAllVenues,
    targetVenueIds: campaign.targetVenueIds,
    includeStaff: campaign.includeStaff,
    targetStaffRoles: campaign.targetStaffRoles,
  })

  if (total === 0) {
    throw new Error('No recipients found for this campaign')
  }

  // Create delivery records
  const deliveryData = recipients.map(r => ({
    campaignId: campaign.id,
    recipientEmail: r.email,
    recipientName: r.name,
    venueId: r.venueId,
    venueName: r.name, // Will be updated if it's a venue
    isStaff: r.isStaff,
    status: 'PENDING' as DeliveryStatus,
  }))

  // Get venue names for venue recipients
  const venueIds = deliveryData.filter(d => d.venueId && !d.isStaff).map(d => d.venueId!)
  const venues = await prisma.venue.findMany({
    where: { id: { in: venueIds } },
    select: { id: true, name: true },
  })
  const venueMap = new Map(venues.map(v => [v.id, v.name]))

  for (const d of deliveryData) {
    if (d.venueId && !d.isStaff && venueMap.has(d.venueId)) {
      d.venueName = venueMap.get(d.venueId)!
    }
  }

  // Create deliveries in batches
  await prisma.campaignDelivery.createMany({
    data: deliveryData,
  })

  // Update campaign status
  await prisma.marketingCampaign.update({
    where: { id: campaignId },
    data: {
      status: 'SENDING',
      startedAt: new Date(),
      totalRecipients: total,
    },
  })

  logger.info(`📧 [Marketing] Campaign ${campaignId} started with ${total} recipients`)

  return { campaignId, totalRecipients: total }
}

export async function cancelCampaign(campaignId: string) {
  const campaign = await prisma.marketingCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  })

  if (!campaign) {
    throw new Error('Campaign not found')
  }

  if (campaign.status !== 'SENDING') {
    throw new Error('Campaign is not currently sending')
  }

  // Mark pending deliveries as failed
  await prisma.campaignDelivery.updateMany({
    where: { campaignId, status: 'PENDING' },
    data: { status: 'FAILED', error: 'Campaign cancelled' },
  })

  // Update campaign status
  await prisma.marketingCampaign.update({
    where: { id: campaignId },
    data: {
      status: 'CANCELLED',
      completedAt: new Date(),
    },
  })

  logger.info(`📧 [Marketing] Campaign ${campaignId} cancelled`)

  return { success: true }
}

// ==========================================
// QUEUE PROCESSING (Called by cron job)
// ==========================================

export async function processPendingDeliveries() {
  if (!resend) {
    logger.warn('📧 [Marketing] Resend not configured - skipping queue processing')
    return { processed: 0, success: 0, failed: 0 }
  }

  // Find campaigns that are currently sending
  const sendingCampaigns = await prisma.marketingCampaign.findMany({
    where: { status: 'SENDING' },
    select: {
      id: true,
      subject: true,
      bodyHtml: true,
      bodyText: true,
    },
  })

  if (sendingCampaigns.length === 0) {
    return { processed: 0, success: 0, failed: 0 }
  }

  let totalProcessed = 0
  let totalSuccess = 0
  let totalFailed = 0

  for (const campaign of sendingCampaigns) {
    // Get pending deliveries for this campaign (batch size)
    const pendingDeliveries = await prisma.campaignDelivery.findMany({
      where: { campaignId: campaign.id, status: 'PENDING' },
      take: BATCH_SIZE,
    })

    if (pendingDeliveries.length === 0) {
      // No more pending deliveries - mark campaign as completed
      await completeCampaign(campaign.id)
      continue
    }

    logger.info(`📧 [Marketing] Processing ${pendingDeliveries.length} deliveries for campaign ${campaign.id}`)

    for (const delivery of pendingDeliveries) {
      try {
        // Send email
        const result = await resend.emails.send({
          from: FROM_EMAIL,
          to: delivery.recipientEmail,
          subject: campaign.subject,
          html: campaign.bodyHtml,
          text: campaign.bodyText,
        })

        if (result.error) {
          throw new Error(result.error.message)
        }

        // Update delivery record
        await prisma.campaignDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'SENT',
            sentAt: new Date(),
            resendId: result.data?.id,
          },
        })

        // Update campaign sent count
        await prisma.marketingCampaign.update({
          where: { id: campaign.id },
          data: { sentCount: { increment: 1 } },
        })

        totalSuccess++
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        logger.error(`📧 [Marketing] Failed to send to ${delivery.recipientEmail}:`, errorMessage)

        // Update delivery record with error
        await prisma.campaignDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'FAILED',
            error: errorMessage,
          },
        })

        // Update campaign failed count
        await prisma.marketingCampaign.update({
          where: { id: campaign.id },
          data: { failedCount: { increment: 1 } },
        })

        totalFailed++
      }

      totalProcessed++

      // Rate limit delay
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS))
    }

    // After processing this batch, check if campaign is now complete
    const remainingPending = await prisma.campaignDelivery.count({
      where: { campaignId: campaign.id, status: 'PENDING' },
    })

    if (remainingPending === 0) {
      // All deliveries processed - mark campaign as complete immediately
      await completeCampaign(campaign.id)
    }
  }

  logger.info(`📧 [Marketing] Queue processing complete: ${totalProcessed} processed, ${totalSuccess} success, ${totalFailed} failed`)

  return { processed: totalProcessed, success: totalSuccess, failed: totalFailed }
}

async function completeCampaign(campaignId: string) {
  const campaign = await prisma.marketingCampaign.findUnique({
    where: { id: campaignId },
    select: {
      sentCount: true,
      failedCount: true,
      totalRecipients: true,
    },
  })

  if (!campaign) return

  // Determine final status
  const allFailed = campaign.failedCount === campaign.totalRecipients
  const status: CampaignStatus = allFailed ? 'FAILED' : 'COMPLETED'

  await prisma.marketingCampaign.update({
    where: { id: campaignId },
    data: {
      status,
      completedAt: new Date(),
    },
  })

  logger.info(`📧 [Marketing] Campaign ${campaignId} completed with status ${status}`)
}

// ==========================================
// WEBHOOK HANDLING (Open/Click tracking)
// ==========================================

export type ResendEventType = 'email.sent' | 'email.delivered' | 'email.opened' | 'email.clicked' | 'email.bounced' | 'email.complained'

export interface ResendWebhookPayload {
  type: ResendEventType
  data: {
    email_id: string
    to: string[]
    from: string
    subject?: string
    created_at: string
    // For clicked events
    click?: {
      link: string
      timestamp: string
    }
  }
}

export async function handleResendWebhook(payload: ResendWebhookPayload) {
  const { type, data } = payload
  const resendId = data.email_id

  // Find the delivery by resendId
  const delivery = await prisma.campaignDelivery.findFirst({
    where: { resendId },
    select: { id: true, campaignId: true, openedAt: true, clickedAt: true, clickedLinks: true },
  })

  if (!delivery) {
    // Not a marketing campaign email - ignore
    return { handled: false, reason: 'Not a marketing campaign delivery' }
  }

  switch (type) {
    case 'email.opened':
      if (!delivery.openedAt) {
        // First open
        await prisma.$transaction([
          prisma.campaignDelivery.update({
            where: { id: delivery.id },
            data: { openedAt: new Date() },
          }),
          prisma.marketingCampaign.update({
            where: { id: delivery.campaignId },
            data: { openedCount: { increment: 1 } },
          }),
        ])
        logger.info(`📧 [Marketing] Email opened: ${resendId}`)
      }
      break

    case 'email.clicked':
      const link = data.click?.link
      if (link) {
        const isFirstClick = !delivery.clickedAt
        const newClickedLinks = delivery.clickedLinks.includes(link) ? delivery.clickedLinks : [...delivery.clickedLinks, link]

        await prisma.$transaction([
          prisma.campaignDelivery.update({
            where: { id: delivery.id },
            data: {
              clickedAt: delivery.clickedAt || new Date(),
              clickedLinks: newClickedLinks,
            },
          }),
          ...(isFirstClick
            ? [
                prisma.marketingCampaign.update({
                  where: { id: delivery.campaignId },
                  data: { clickedCount: { increment: 1 } },
                }),
              ]
            : []),
        ])
        logger.info(`📧 [Marketing] Email clicked: ${resendId}, link: ${link}`)
      }
      break

    case 'email.bounced':
      await prisma.campaignDelivery.update({
        where: { id: delivery.id },
        data: { status: 'BOUNCED' },
      })
      logger.info(`📧 [Marketing] Email bounced: ${resendId}`)
      break

    default:
      // Other events (sent, delivered, complained) - no action needed
      break
  }

  return { handled: true }
}
