import { NotificationType, NotificationChannel, NotificationPriority, AlertType, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import AppError from '../../errors/AppError'
import logger from '../../config/logger'

/**
 * Template variables interface
 */
interface TemplateVariables {
  [key: string]: string | number | boolean
}

/**
 * Notification payload interface
 */
interface NotificationPayload {
  recipientId: string
  venueId?: string
  type: NotificationType
  title: string
  message: string
  actionUrl?: string
  actionLabel?: string
  entityType?: string
  entityId?: string
  metadata?: any
  priority?: NotificationPriority
  channels?: NotificationChannel[]
}

/**
 * Get notification preferences for a staff member
 */
export async function getNotificationPreferences(staffId: string, venueId: string, type: NotificationType) {
  const preference = await prisma.notificationPreference.findUnique({
    where: {
      staffId_venueId_type: {
        staffId,
        venueId,
        type,
      },
    },
  })

  // Default preferences if none exist
  if (!preference) {
    return {
      enabled: true,
      channels: [NotificationChannel.IN_APP],
      priority: NotificationPriority.NORMAL,
      quietStart: null,
      quietEnd: null,
    }
  }

  return preference
}

/**
 * Check if notification should be sent based on quiet hours
 */
function isWithinQuietHours(quietStart?: string | null, quietEnd?: string | null): boolean {
  if (!quietStart || !quietEnd) return false

  const now = new Date()
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

  // Handle quiet hours that span midnight
  if (quietStart > quietEnd) {
    return currentTime >= quietStart || currentTime < quietEnd
  }

  return currentTime >= quietStart && currentTime < quietEnd
}

/**
 * Get notification template
 */
async function getNotificationTemplate(type: NotificationType, language: string = 'es') {
  const template = await prisma.notificationTemplate.findUnique({
    where: {
      type_language: {
        type,
        language,
      },
    },
  })

  // Fallback to English if Spanish not found
  if (!template && language !== 'en') {
    return getNotificationTemplate(type, 'en')
  }

  return template
}

/**
 * Replace template variables in text
 */
function replaceTemplateVariables(text: string, variables: TemplateVariables): string {
  let result = text
  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, 'g')
    result = result.replace(regex, String(value))
  })
  return result
}

/**
 * Send notification through multiple channels
 */
export async function sendNotification(payload: NotificationPayload): Promise<any> {
  try {
    // Get user preferences
    const preferences = await getNotificationPreferences(payload.recipientId, payload.venueId || '', payload.type)

    // Check if notifications are enabled for this type
    if (!preferences.enabled) {
      logger.info(`Notifications disabled for ${payload.recipientId} - type ${payload.type}`)
      return null
    }

    // Check quiet hours
    if (isWithinQuietHours(preferences.quietStart, preferences.quietEnd)) {
      logger.info(`Within quiet hours for ${payload.recipientId} - notification queued`)
      // In production, you'd queue this for later delivery
      // For now, we'll just skip it
      return null
    }

    // Determine channels to use (user preferences override payload)
    const channels = preferences.channels.length > 0 ? preferences.channels : payload.channels || [NotificationChannel.IN_APP]

    // Create notification record
    const notification = await prisma.notification.create({
      data: {
        recipientId: payload.recipientId,
        venueId: payload.venueId,
        type: payload.type,
        title: payload.title,
        message: payload.message,
        actionUrl: payload.actionUrl,
        actionLabel: payload.actionLabel,
        entityType: payload.entityType,
        entityId: payload.entityId,
        metadata: payload.metadata,
        priority: payload.priority || preferences.priority || NotificationPriority.NORMAL,
        channels,
        sentAt: new Date(),
      },
      include: {
        recipient: {
          select: {
            id: true,
            email: true,
            phone: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    })

    // Send through each channel
    const results = {
      inApp: false,
      email: false,
      sms: false,
      push: false,
    }

    for (const channel of channels) {
      try {
        switch (channel) {
          case NotificationChannel.IN_APP:
            // In-app notifications are already stored in database
            results.inApp = true
            logger.info(`In-app notification created: ${notification.id}`)
            break

          case NotificationChannel.EMAIL:
            // TODO: Integrate with email service (SendGrid, AWS SES, etc.)
            results.email = await sendEmailNotification(notification)
            break

          case NotificationChannel.SMS:
            // TODO: Integrate with SMS service (Twilio, etc.)
            results.sms = await sendSMSNotification(notification)
            break

          case NotificationChannel.PUSH:
            // TODO: Integrate with push notification service (FCM, APNs, etc.)
            results.push = await sendPushNotification(notification)
            break

          default:
            logger.warn(`Unsupported notification channel: ${channel}`)
        }
      } catch (error) {
        logger.error(`Failed to send notification via ${channel}:`, error)
        // Update notification with error
        await prisma.notification.update({
          where: { id: notification.id },
          data: {
            failedAt: new Date(),
            errorMsg: error instanceof Error ? error.message : 'Unknown error',
          },
        })
      }
    }

    return { notification, results }
  } catch (error) {
    logger.error('Failed to send notification:', error)
    throw new AppError('Failed to send notification', 500)
  }
}

/**
 * Send email notification (placeholder)
 */
async function sendEmailNotification(notification: any): Promise<boolean> {
  // TODO: Implement email sending logic
  // Integration options:
  // - SendGrid
  // - AWS SES
  // - Mailgun
  // - Postmark

  logger.info(`Email notification would be sent to: ${notification.recipient.email}`)
  logger.info(`Subject: ${notification.title}`)
  logger.info(`Body: ${notification.message}`)

  // For now, just log and return true
  return true
}

/**
 * Send SMS notification (placeholder)
 */
async function sendSMSNotification(notification: any): Promise<boolean> {
  // TODO: Implement SMS sending logic
  // Integration options:
  // - Twilio
  // - AWS SNS
  // - MessageBird

  logger.info(`SMS notification would be sent to: ${notification.recipient.phone}`)
  logger.info(`Message: ${notification.message}`)

  // For now, just log and return true
  return true
}

/**
 * Send push notification (placeholder)
 */
async function sendPushNotification(notification: any): Promise<boolean> {
  // TODO: Implement push notification logic
  // Integration options:
  // - Firebase Cloud Messaging (FCM)
  // - Apple Push Notification Service (APNs)
  // - OneSignal

  logger.info(`Push notification would be sent to: ${notification.recipientId}`)
  logger.info(`Title: ${notification.title}`)
  logger.info(`Body: ${notification.message}`)

  // For now, just log and return true
  return true
}

/**
 * Send notification using template
 */
export async function sendNotificationFromTemplate(
  recipientId: string,
  venueId: string,
  type: NotificationType,
  variables: TemplateVariables,
  options?: {
    actionUrl?: string
    actionLabel?: string
    entityType?: string
    entityId?: string
    metadata?: any
    priority?: NotificationPriority
    channels?: NotificationChannel[]
  },
): Promise<any> {
  // Get template
  const template = await getNotificationTemplate(type)

  if (!template) {
    throw new AppError(`Notification template not found for type: ${type}`, 404)
  }

  // Replace variables in template
  const title = replaceTemplateVariables(template.title, variables)
  const message = replaceTemplateVariables(template.message, variables)
  const actionLabel = template.actionLabel ? replaceTemplateVariables(template.actionLabel, variables) : options?.actionLabel

  // Send notification
  return sendNotification({
    recipientId,
    venueId,
    type,
    title,
    message,
    actionLabel,
    ...options,
  })
}

/**
 * Send low stock alert notification
 */
export async function sendLowStockAlertNotification(
  venueId: string,
  rawMaterialId: string,
  alertType: AlertType,
  currentStock: number,
  unit: string,
  threshold: number,
): Promise<void> {
  try {
    const rawMaterial = await prisma.rawMaterial.findUnique({
      where: { id: rawMaterialId },
      select: {
        id: true,
        name: true,
        sku: true,
        category: true,
      },
    })

    if (!rawMaterial) {
      logger.warn(`Raw material not found: ${rawMaterialId}`)
      return
    }

    // Get managers and admins for this venue
    const staffToNotify = await prisma.staffVenue.findMany({
      where: {
        venueId,
        active: true,
        role: {
          in: ['MANAGER', 'ADMIN', 'OWNER'],
        },
      },
      select: {
        staffId: true,
      },
    })

    // Determine notification type and message
    const notificationType = NotificationType.LOW_INVENTORY
    const isOutOfStock = alertType === 'OUT_OF_STOCK'

    const title = isOutOfStock ? `⚠️ Out of Stock Alert` : `📉 Low Stock Alert`

    const message = isOutOfStock
      ? `${rawMaterial.name} (${rawMaterial.sku}) is out of stock. Please reorder immediately.`
      : `${rawMaterial.name} (${rawMaterial.sku}) is running low. Current stock: ${currentStock} ${unit} (Threshold: ${threshold} ${unit})`

    // Get venue slug for proper URL construction
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { slug: true },
    })

    if (!venue) {
      logger.warn(`Venue not found: ${venueId}`)
      return
    }

    // Send notification to each relevant staff member
    for (const staff of staffToNotify) {
      await sendNotification({
        recipientId: staff.staffId,
        venueId,
        type: notificationType,
        title,
        message,
        actionUrl: `/inventory/raw-materials?highlight=${rawMaterialId}`,
        actionLabel: 'Gestionar Inventario',
        entityType: 'RawMaterial',
        entityId: rawMaterialId,
        metadata: {
          rawMaterialName: rawMaterial.name,
          sku: rawMaterial.sku,
          category: rawMaterial.category,
          currentStock,
          unit,
          threshold,
          alertType,
        },
        priority: isOutOfStock ? NotificationPriority.URGENT : NotificationPriority.HIGH,
        channels: isOutOfStock
          ? [NotificationChannel.IN_APP, NotificationChannel.EMAIL] // Out of stock - use email too
          : [NotificationChannel.IN_APP], // Low stock - just in-app
      })
    }

    logger.info(`Low stock alert notifications sent for ${rawMaterial.name}`)
  } catch (error) {
    logger.error('Failed to send low stock alert notifications:', error)
    // Don't throw - notification failure shouldn't break the alert creation
  }
}

/**
 * Get unread notifications for a user
 */
export async function getUnreadNotifications(recipientId: string, venueId?: string) {
  const where: Prisma.NotificationWhereInput = {
    recipientId,
    isRead: false,
    ...(venueId && { venueId }),
  }

  return prisma.notification.findMany({
    where,
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    take: 50,
  })
}

/**
 * Mark notification as read
 */
export async function markNotificationAsRead(notificationId: string, recipientId: string) {
  const notification = await prisma.notification.findFirst({
    where: {
      id: notificationId,
      recipientId,
    },
  })

  if (!notification) {
    throw new AppError('Notification not found', 404)
  }

  return prisma.notification.update({
    where: { id: notificationId },
    data: {
      isRead: true,
      readAt: new Date(),
    },
  })
}

/**
 * Mark all notifications as read for a user
 */
export async function markAllNotificationsAsRead(recipientId: string, venueId?: string) {
  const where: Prisma.NotificationWhereInput = {
    recipientId,
    isRead: false,
    ...(venueId && { venueId }),
  }

  return prisma.notification.updateMany({
    where,
    data: {
      isRead: true,
      readAt: new Date(),
    },
  })
}

/**
 * Get notification count
 */
export async function getUnreadNotificationCount(recipientId: string, venueId?: string): Promise<number> {
  const where: Prisma.NotificationWhereInput = {
    recipientId,
    isRead: false,
    ...(venueId && { venueId }),
  }

  return prisma.notification.count({ where })
}

/**
 * Delete notification
 */
export async function deleteNotification(notificationId: string, recipientId: string) {
  const notification = await prisma.notification.findFirst({
    where: {
      id: notificationId,
      recipientId,
    },
  })

  if (!notification) {
    throw new AppError('Notification not found', 404)
  }

  return prisma.notification.delete({
    where: { id: notificationId },
  })
}

/**
 * Create or update notification preference
 */
export async function updateNotificationPreference(
  staffId: string,
  venueId: string,
  type: NotificationType,
  data: {
    enabled?: boolean
    channels?: NotificationChannel[]
    priority?: NotificationPriority
    quietStart?: string
    quietEnd?: string
  },
) {
  return prisma.notificationPreference.upsert({
    where: {
      staffId_venueId_type: {
        staffId,
        venueId,
        type,
      },
    },
    create: {
      staffId,
      venueId,
      type,
      ...data,
    },
    update: data,
  })
}
