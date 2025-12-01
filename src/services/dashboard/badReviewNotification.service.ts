/**
 * Bad Review Notification Service
 *
 * Sends notifications to configured venue staff when customers leave
 * reviews with ratings below the threshold (default: < 4 stars).
 *
 * Channels: In-App (Socket.IO) + Email
 * Recipients: Configurable per venue via VenueSettings.badReviewAlertRoles
 */

import { NotificationChannel, NotificationPriority, NotificationType, StaffRole } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { sendVenueNotification } from './notification.dashboard.service'
import * as resendService from '../resend.service'

/**
 * Context data for bad review notification
 */
export interface BadReviewContext {
  reviewId: string
  venueId: string
  venueName: string
  venueSlug: string
  rating: number
  comment?: string | null
  customerName?: string | null
  customerEmail?: string | null
  tableNumber?: string | null // Table number (String in Prisma schema)
  orderNumber?: string | null
  orderId?: string | null
  waiterName?: string | null
  waiterId?: string | null
  foodRating?: number | null
  serviceRating?: number | null
  ambienceRating?: number | null
}

/**
 * Check if a bad review notification should be sent for this venue/rating
 */
export async function shouldNotifyBadReview(
  venueId: string,
  rating: number,
): Promise<{
  shouldNotify: boolean
  threshold: number
  alertRoles: string[]
}> {
  const settings = await prisma.venueSettings.findUnique({
    where: { venueId },
  })

  // Default settings if not found
  const notifyEnabled = settings?.notifyBadReviews ?? true
  const threshold = settings?.badReviewThreshold ?? 3
  const alertRoles = settings?.badReviewAlertRoles ?? ['OWNER', 'ADMIN', 'MANAGER']

  // Notify if enabled AND rating is LESS THAN threshold (e.g., 1, 2, 3 for threshold=4)
  const shouldNotify = notifyEnabled && rating < threshold + 1 // threshold=3 means notify for <=3

  logger.debug('Bad review notification check', {
    venueId,
    rating,
    threshold,
    notifyEnabled,
    shouldNotify,
    alertRoles,
  })

  return {
    shouldNotify,
    threshold,
    alertRoles,
  }
}

/**
 * Get full context for a review notification from Payment → Order → Table chain
 */
export async function getReviewContext(paymentId: string, venueId: string, reviewId: string): Promise<BadReviewContext | null> {
  try {
    // Get payment with order and table info
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        venue: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        order: {
          include: {
            table: {
              select: {
                id: true,
                number: true,
              },
            },
            servedBy: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        processedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    })

    if (!payment) {
      logger.warn('Payment not found for bad review context', { paymentId })
      return null
    }

    // Build waiter name from either order.servedBy or payment.processedBy
    const waiter = payment.order.servedBy || payment.processedBy
    const waiterName = waiter ? `${waiter.firstName} ${waiter.lastName}`.trim() : null

    return {
      reviewId,
      venueId,
      venueName: payment.venue.name,
      venueSlug: payment.venue.slug,
      rating: 0, // Will be filled by caller
      comment: null, // Will be filled by caller
      customerName: null, // Will be filled by caller
      customerEmail: null, // Will be filled by caller
      tableNumber: payment.order.table?.number || null,
      orderNumber: payment.order.orderNumber || null,
      orderId: payment.order.id || null,
      waiterName,
      waiterId: waiter?.id || null,
    }
  } catch (error) {
    logger.error('Failed to get review context', { paymentId, error })
    return null
  }
}

/**
 * Build notification message with review details
 */
function buildNotificationMessage(context: BadReviewContext): { title: string; message: string } {
  const stars = '★'.repeat(context.rating) + '☆'.repeat(5 - context.rating)

  const title = `⚠️ Calificación baja: ${stars}`

  const messageParts: string[] = []

  // Rating line
  messageParts.push(`Rating: ${context.rating}/5 estrellas`)

  // Table info
  if (context.tableNumber) {
    messageParts.push(`Mesa: ${context.tableNumber}`)
  }

  // Order info
  if (context.orderNumber) {
    messageParts.push(`Orden: #${context.orderNumber}`)
  }

  // Customer info
  if (context.customerName) {
    messageParts.push(`Cliente: ${context.customerName}`)
  }

  // Waiter info
  if (context.waiterName) {
    messageParts.push(`Atendido por: ${context.waiterName}`)
  }

  // Sub-ratings if available
  if (context.foodRating || context.serviceRating || context.ambienceRating) {
    const subRatings: string[] = []
    if (context.foodRating) subRatings.push(`Comida: ${context.foodRating}/5`)
    if (context.serviceRating) subRatings.push(`Servicio: ${context.serviceRating}/5`)
    if (context.ambienceRating) subRatings.push(`Ambiente: ${context.ambienceRating}/5`)
    messageParts.push(subRatings.join(' | '))
  }

  // Comment
  if (context.comment) {
    messageParts.push(`\nComentario: "${context.comment}"`)
  }

  return {
    title,
    message: messageParts.join('\n'),
  }
}

/**
 * Send bad review notifications to all configured staff members
 */
export async function sendBadReviewNotifications(context: BadReviewContext): Promise<void> {
  try {
    // Get venue settings for alert roles
    const { alertRoles } = await shouldNotifyBadReview(context.venueId, context.rating)

    const { title, message } = buildNotificationMessage(context)

    logger.info('Sending bad review notifications', {
      reviewId: context.reviewId,
      venueId: context.venueId,
      rating: context.rating,
      alertRoles,
    })

    // Send in-app notifications to all staff with configured roles
    const notifications = await sendVenueNotification(
      context.venueId,
      {
        type: NotificationType.BAD_REVIEW,
        title,
        message,
        actionUrl: `/reviews?highlight=${context.reviewId}`,
        actionLabel: 'Ver Review',
        entityType: 'Review',
        entityId: context.reviewId,
        metadata: {
          rating: context.rating,
          tableNumber: context.tableNumber,
          orderNumber: context.orderNumber,
          orderId: context.orderId,
          customerName: context.customerName,
          waiterName: context.waiterName,
          waiterId: context.waiterId,
          comment: context.comment,
          foodRating: context.foodRating,
          serviceRating: context.serviceRating,
          ambienceRating: context.ambienceRating,
        },
        priority: NotificationPriority.HIGH,
        channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
      },
      alertRoles, // Role filter
    )

    logger.info(`Bad review notifications sent to ${notifications.length} staff members`, {
      reviewId: context.reviewId,
      venueId: context.venueId,
    })

    // Send dedicated email notifications
    await sendBadReviewEmails(context, alertRoles)
  } catch (error) {
    logger.error('Failed to send bad review notifications', {
      reviewId: context.reviewId,
      error,
    })
    // Don't throw - notification failure shouldn't break the review submission
  }
}

/**
 * Send email notifications to staff with configured roles
 */
async function sendBadReviewEmails(context: BadReviewContext, alertRoles: string[]): Promise<void> {
  try {
    // Get staff emails for configured roles
    const staffToNotify = await prisma.staffVenue.findMany({
      where: {
        venueId: context.venueId,
        active: true,
        role: {
          in: alertRoles as StaffRole[],
        },
      },
      include: {
        staff: {
          select: {
            email: true,
            firstName: true,
          },
        },
      },
    })

    if (staffToNotify.length === 0) {
      logger.warn('No staff found for bad review email notification', {
        venueId: context.venueId,
        alertRoles,
      })
      return
    }

    const emails = staffToNotify.map(sv => sv.staff.email)
    const dashboardUrl = process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'
    const actionUrl = `${dashboardUrl}/venues/${context.venueSlug}/reviews?highlight=${context.reviewId}`

    // Send email to each staff member
    await sendBadReviewNotificationEmail({
      venueName: context.venueName,
      venueSlug: context.venueSlug,
      reviewId: context.reviewId,
      rating: context.rating,
      tableNumber: context.tableNumber,
      orderNumber: context.orderNumber,
      customerName: context.customerName,
      waiterName: context.waiterName,
      comment: context.comment,
      foodRating: context.foodRating,
      serviceRating: context.serviceRating,
      ambienceRating: context.ambienceRating,
      actionUrl,
      recipients: emails,
    })

    logger.info(`Bad review emails sent to ${emails.length} recipients`, {
      reviewId: context.reviewId,
    })
  } catch (error) {
    logger.error('Failed to send bad review emails', { error })
  }
}

interface BadReviewEmailData {
  venueName: string
  venueSlug: string
  reviewId: string
  rating: number
  tableNumber?: string | null
  orderNumber?: string | null
  customerName?: string | null
  waiterName?: string | null
  comment?: string | null
  foodRating?: number | null
  serviceRating?: number | null
  ambienceRating?: number | null
  actionUrl: string
  recipients: string[]
}

/**
 * Send bad review notification email with custom template
 */
async function sendBadReviewNotificationEmail(data: BadReviewEmailData): Promise<boolean> {
  // Use resendService directly for sending
  const { Resend } = await import('resend')
  const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

  if (!resend) {
    logger.warn('Resend not configured - skipping bad review email')
    return false
  }

  try {
    const FROM_EMAIL = process.env.EMAIL_FROM || 'Avoqado <noreply@avoqado.io>'

    // Build star rating visual
    const filledStars = '★'.repeat(data.rating)
    const emptyStars = '☆'.repeat(5 - data.rating)
    const starsHtml = `<span style="color: #f59e0b; font-size: 24px;">${filledStars}</span><span style="color: #d1d5db; font-size: 24px;">${emptyStars}</span>`

    // Build info rows
    const infoRows: string[] = []

    if (data.tableNumber) {
      infoRows.push(
        `<tr><td style="padding: 8px 0; color: #666;">🪑 Mesa:</td><td style="padding: 8px 0; font-weight: 600;">${data.tableNumber}</td></tr>`,
      )
    }

    if (data.orderNumber) {
      infoRows.push(
        `<tr><td style="padding: 8px 0; color: #666;">📋 Orden:</td><td style="padding: 8px 0; font-weight: 600;">#${data.orderNumber}</td></tr>`,
      )
    }

    if (data.customerName) {
      infoRows.push(
        `<tr><td style="padding: 8px 0; color: #666;">👤 Cliente:</td><td style="padding: 8px 0; font-weight: 600;">${data.customerName}</td></tr>`,
      )
    }

    if (data.waiterName) {
      infoRows.push(
        `<tr><td style="padding: 8px 0; color: #666;">🙋 Atendido por:</td><td style="padding: 8px 0; font-weight: 600;">${data.waiterName}</td></tr>`,
      )
    }

    // Build sub-ratings section
    let subRatingsHtml = ''
    if (data.foodRating || data.serviceRating || data.ambienceRating) {
      const subItems: string[] = []
      if (data.foodRating) {
        subItems.push(`<span style="margin-right: 15px;">🍽️ Comida: <strong>${data.foodRating}/5</strong></span>`)
      }
      if (data.serviceRating) {
        subItems.push(`<span style="margin-right: 15px;">🙋 Servicio: <strong>${data.serviceRating}/5</strong></span>`)
      }
      if (data.ambienceRating) {
        subItems.push(`<span>✨ Ambiente: <strong>${data.ambienceRating}/5</strong></span>`)
      }
      subRatingsHtml = `
        <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 0; font-size: 14px; color: #92400e;">${subItems.join('')}</p>
        </div>
      `
    }

    // Build comment section
    let commentHtml = ''
    if (data.comment) {
      commentHtml = `
        <div style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 20px; margin: 20px 0; border-radius: 0 8px 8px 0;">
          <p style="font-size: 14px; margin: 0 0 10px 0; color: #666; font-weight: 600;">💬 Comentario del cliente:</p>
          <p style="font-size: 16px; margin: 0; color: #333; font-style: italic;">"${data.comment}"</p>
        </div>
      `
    }

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Calificación baja en ${data.venueName}</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background: white; border-radius: 15px; box-shadow: 0 8px 25px rgba(0,0,0,0.1); overflow: hidden;">
            <!-- Header with warning style -->
            <div style="background: linear-gradient(135deg, #dc2626 0%, #ef4444 100%); padding: 40px 30px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: bold;">⚠️ Calificación Baja Recibida</h1>
              <p style="color: #fee2e2; margin: 10px 0 0 0; font-size: 16px;">${data.venueName}</p>
            </div>

            <!-- Content -->
            <div style="padding: 40px 30px;">
              <!-- Rating display -->
              <div style="text-align: center; margin-bottom: 30px;">
                <p style="font-size: 48px; margin: 0;">${starsHtml}</p>
                <p style="font-size: 24px; font-weight: bold; margin: 10px 0 0 0; color: #dc2626;">${data.rating} de 5 estrellas</p>
              </div>

              <!-- Info table -->
              <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                ${infoRows.join('')}
              </table>

              ${subRatingsHtml}
              ${commentHtml}

              <!-- CTA Button -->
              <div style="text-align: center; margin: 40px 0;">
                <a href="${data.actionUrl}"
                   style="background: linear-gradient(135deg, #dc2626 0%, #ef4444 100%);
                          color: white;
                          padding: 16px 40px;
                          text-decoration: none;
                          border-radius: 30px;
                          font-weight: bold;
                          font-size: 16px;
                          display: inline-block;
                          box-shadow: 0 4px 15px rgba(220, 38, 38, 0.4);">
                  👀 Ver Review y Responder
                </a>
              </div>

              <!-- Tip box -->
              <div style="background: #f0f9ff; border-left: 4px solid #0ea5e9; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
                <p style="font-size: 13px; margin: 0; color: #0369a1;">
                  💡 <strong>Tip:</strong> Responder rápidamente a reviews negativas puede convertir clientes insatisfechos en promotores de tu negocio.
                </p>
              </div>

              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">

              <!-- Footer -->
              <p style="font-size: 12px; color: #999; text-align: center; margin: 0;">
                Notificación automática de Avoqado • Review ID: ${data.reviewId}
              </p>
            </div>
          </div>
        </body>
      </html>
    `

    const text = `
⚠️ CALIFICACIÓN BAJA RECIBIDA - ${data.venueName}

Rating: ${data.rating}/5 estrellas

${data.tableNumber ? `Mesa: ${data.tableNumber}` : ''}
${data.orderNumber ? `Orden: #${data.orderNumber}` : ''}
${data.customerName ? `Cliente: ${data.customerName}` : ''}
${data.waiterName ? `Atendido por: ${data.waiterName}` : ''}

${data.foodRating ? `Comida: ${data.foodRating}/5` : ''} ${data.serviceRating ? `Servicio: ${data.serviceRating}/5` : ''} ${data.ambienceRating ? `Ambiente: ${data.ambienceRating}/5` : ''}

${data.comment ? `Comentario: "${data.comment}"` : ''}

Ver review y responder: ${data.actionUrl}

---
Notificación automática de Avoqado
Review ID: ${data.reviewId}
    `

    logger.info(`📧 Sending bad review email to ${data.recipients.length} recipients`)

    // Send to all recipients
    const results = await Promise.allSettled(
      data.recipients.map(email =>
        resend.emails.send({
          from: FROM_EMAIL,
          to: email,
          subject: `⚠️ Calificación baja (${data.rating}/5) en ${data.venueName}`,
          html,
          text,
        }),
      ),
    )

    const successCount = results.filter(r => r.status === 'fulfilled').length
    logger.info(`✅ Bad review emails sent: ${successCount}/${data.recipients.length}`)

    return successCount > 0
  } catch (error) {
    logger.error('Error sending bad review email:', error)
    return false
  }
}
